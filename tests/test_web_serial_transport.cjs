// SPDX-License-Identifier: MPL-2.0
// Offline Modbus frames only: no navigator, serial device, or network is used.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {MotorTransport, TransportError} = require("../virtual_synth/static/web-serial-transport.js");
const {frame, crc16} = require("../virtual_synth/static/web-serial-io.js");
const {createRuntime} = require("../virtual_synth/static/browser-runtime.js");

class Clock {
  constructor() { this.elapsed = 0; }
  now = () => this.elapsed;
  wait = async seconds => { this.elapsed += seconds; };
}

class FakeConnection {
  constructor({native = false, homeIgnored = false} = {}) {
    this.values = Array(26).fill(0);
    this.values[0] = 1; this.values[2] = 7; this.values[3] = 15;
    this.values[11] = 800; this.values[21] = 1;
    this.position(20000);
    this.native = native; this.homeIgnored = homeIgnored;
    this.nativeActive = false; this.nativeReads = 0;
    this.contacts = null; this.contactPWM = 2500;
    this.openCount = this.closeCount = this.readCount = 0;
    this.active = this.maxActive = 0;
    this.opened = false;
    this.transmissions = []; this.commands = []; this.settings = [];
    this.destinations = []; this.absoluteStates = [];
    this.onRead = this.onCommand = this.onSetting = this.onNative = null;
  }
  position(value) { this.values[22] = value & 65535; this.values[23] = value >>> 16 & 65535; }
  remaining(value) { this.values[12] = value & 65535; this.values[13] = value >>> 16 & 65535; }
  async open() { this.openCount++; this.opened = true; }
  async close() { this.closeCount++; this.opened = false; }
  async exchange(request, timeout) {
    assert.equal(this.opened, true, "exchange requires an open fake connection");
    assert.ok(timeout > 0 && timeout <= .15);
    const tx = Uint8Array.from(request);
    assert.equal(crc16(tx.slice(0, -2)), tx.at(-2) | tx.at(-1) << 8);
    assert.equal(tx[0], 1);
    this.transmissions.push(tx);
    this.maxActive = Math.max(this.maxActive, ++this.active);
    try {
      if (tx[1] === 3) {
        this.readCount++;
        if (this.nativeActive) {
          this.nativeReads++;
          if (!this.homeIgnored) {
            this.position(this.nativeReads === 1 ? 19000 : 0);
            this.remaining(this.nativeReads === 1 ? 100 : 0);
          }
          if (this.onNative) await this.onNative(this);
        }
        if (this.onRead) {
          const replacement = await this.onRead(this);
          if (replacement !== undefined) return replacement;
        }
        return frame([1, 3, 52, ...this.values.flatMap(value => [value >>> 8, value & 255])]);
      }
      const register = tx[2] << 8 | tx[3];
      let reply, operation;
      const previous = this.values[1];
      if (tx[1] === 6) {
        const value = tx[4] << 8 | tx[5];
        if (register === 1) {
          operation = value ? "enable" : "inhibit";
          this.values[1] = value ? previous | 1 : previous & ~1;
          if (!value) { this.values[19] = 0; this.nativeActive = false; }
          reply = frame([...tx.slice(0, 4), this.values[1] >>> 8, this.values[1] & 255]);
        } else {
          this.settings.push([register, value]);
          this.values[register] = value;
          if (register === 0) {
            if (value === 0) this.nativeActive = false;
            else {
              this.values[1] = 1; this.values[2] = 1500;
              this.values[3] = 50000; this.values[24] = 600;
            }
          }
          if (register === 25) {
            this.nativeActive = value === 1;
            if (this.nativeActive) this.values[0] = 0;
          }
          reply = tx;
          if (this.onSetting) {
            const replacement = await this.onSetting(this, register, value, tx);
            if (replacement !== undefined) reply = replacement;
          }
          return reply;
        }
      } else {
        assert.equal(tx[1], 16);
        assert.equal(tx[5], 2);
        if (register === 12) {
          operation = "clear";
          this.remaining(0); this.values[19] = 0;
        } else {
          assert.equal(register, 22);
          operation = "absolute";
          const target = (tx[7] << 8 | tx[8]) | (tx[9] << 8 | tx[10]) << 16;
          assert.notEqual(target, 0, "absolute zero must never reset the drive coordinate");
          this.target = target;
          this.destinations.push(target); this.absoluteStates.push(this.values.slice());
          const [low, high] = this.contacts ?? (this.values[9] ? [-3277, 160563] : [-160563, 3277]);
          const position = this.native ? Math.max(low, Math.min(high, target)) : target;
          this.position(position); this.remaining(target - position);
          this.values[19] = (target === position ? 0 : this.contactPWM * Math.sign(target - position)) & 65535;
        }
        reply = frame(tx.slice(0, 6));
      }
      this.commands.push(operation);
      if (this.onCommand) {
        const replacement = await this.onCommand(this, operation, tx, previous);
        if (replacement !== undefined) reply = replacement;
      }
      return reply;
    } finally { this.active--; }
  }
}

function make({motor = new FakeConnection(), allowed = true} = {}) {
  const clock = new Clock(), selectedPort = {}, factories = [];
  const transport = new MotorTransport(selectedPort, {
    allowMotion: allowed, portLabel: "offline-test", clock: clock.now, wait: clock.wait,
    connectionFactory: port => { factories.push(port); return motor; },
  });
  return {transport, motor, clock, factories, selectedPort};
}
async function running(options) {
  const context = make(options);
  await context.transport.connect(); await context.transport.arm(); await context.transport.start();
  return context;
}
async function homing(reverse = false, motor = new FakeConnection({native: true})) {
  const context = make({motor});
  await context.transport.connect(); await context.transport.begin_home(reverse);
  return context;
}
async function advance(context, until = "complete", limit = 4000) {
  for (let index = 0; index < limit; index++) {
    if (context.transport.status().home_phase === until) return context.transport.status();
    await context.clock.wait(.1); await context.transport.poll_home();
  }
  assert.fail(`Homing did not reach ${until}`);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
async function homeFault(context) {
  await assert.rejects(advance(context), TransportError);
  const status = context.transport.status();
  assert.equal(status.homed, false); assert.equal(status.homing, false);
  assert.ok(status.fault);
  assert.ok(context.motor.settings.some(([register, value]) => register === 0 && value === 0));
  assert.equal(context.motor.values[1], 0);
  return status;
}

test("construction and read-only connection never send motor controls", async () => {
  const {transport, motor, factories, selectedPort} = make({allowed: false});
  assert.equal(factories.length, 0); assert.equal(motor.openCount, 0);
  assert.equal(transport.status().connected, false);
  assert.equal(transport.status().position_raw, null);
  const connected = await transport.connect();
  assert.deepEqual(factories, [selectedPort]); assert.equal(motor.openCount, 1);
  assert.equal(connected.position_raw, 20000);
  assert.equal(connected.baud, 19200); assert.equal(connected.slave, 1);
  await assert.rejects(transport.arm());
  await transport.stop(); await transport.close();
  assert.deepEqual(motor.commands, []); assert.deepEqual(motor.settings, []);
  assert.equal(motor.transmissions.length, 1); assert.equal(motor.closeCount, 1);
});

test("normal motion matches Python transport status and exact control-frame trace", async () => {
  // Generated offline from transport.py + tests.test_virtual_synth_transport.FakeMotor.
  // Each row is [action, argument, armed, running, stopped, observed position,
  // origin, target, normalized position]; pending=0 and fault=null in every row.
  const reference = [
    ["connect", null, false, false, false, 20000, null, null, null],
    ["arm", null, true, false, false, 20000, 20000, 20000, .5],
    ["start", null, true, true, false, 20000, 20000, 20000, .5],
    ["command", .25, true, true, false, 20000, 20000, 17952, .5],
    ["command", .5, true, true, false, 17952, 20000, 20000, .25],
    ["command", .75, true, true, false, 20000, 20000, 22048, .5],
    ["stop", null, false, false, true, 22048, 20000, 22048, .75],
  ];
  const {transport, motor} = make();
  for (const [action, argument, ...expected] of reference) {
    const state = argument === null ? await transport[action]() : await transport[action](argument);
    assert.deepEqual([state.armed, state.running, state.stop_confirmed, state.position_raw,
      state.origin_raw, state.target_raw, state.position_normalized], expected);
    assert.equal(state.pending_raw, 0); assert.equal(state.fault, null);
    assert.deepEqual(state.raw_bounds, action === "connect" ? null : [15904, 24096]);
  }
  assert.deepEqual(motor.transmissions.filter(tx => tx[1] !== 3).map(tx => Buffer.from(tx).toString("hex")), [
    "0110000c00020400000000f3fa", "01060001000119ca", "0110001600020446200000660b",
    "011000160002044e200000646b", "011000160002045620000062cb",
    "0110000c00020400000000f3fa", "010600010000d80a",
  ]);
  await transport.close();
});

test("arming gates reject changed configuration before any write", async () => {
  for (const [register, value] of [[0, 0], [1, 1], [1, 4], [2, 3], [3, 10], [10, 1],
    [14, 1], [20, 1], [21, 2], [25, 8], [12, 1], [19, 1]]) {
    const {transport, motor} = make(); motor.values[register] = value;
    await transport.connect(); await assert.rejects(transport.arm());
    assert.deepEqual(motor.commands, []); assert.deepEqual(motor.settings, []);
    assert.ok(transport.status().fault); await transport.close();
  }
});

test("legacy motion window rejects zero and signed-counter overflow", async () => {
  for (const position of [0, 4096, -4096, 2147483647 - 4095, -2147483648 + 4095]) {
    const {transport, motor} = make(); motor.position(position);
    await transport.connect(); await assert.rejects(transport.arm());
    assert.deepEqual(motor.commands, []); await transport.close();
  }
  for (const position of [4097, -4097, -2147483648 + 4096, 2147483647 - 4096]) {
    const {transport, motor} = make(); motor.position(position);
    await transport.connect(); assert.equal((await transport.arm()).armed, true);
    await transport.close();
  }
});

test("twenty-second limit rejects late commands and still independently cleans up", async () => {
  for (const action of ["command", "snapshot"]) {
    const {transport, motor, clock} = await running();
    await clock.wait(20);
    await assert.rejects(action === "command" ? transport.command(.7) : transport.snapshot());
    assert.deepEqual(motor.destinations, []);
    assert.deepEqual(motor.commands.slice(-2), ["clear", "inhibit"]);
    assert.equal(transport.status().stop_confirmed, true); await transport.close();
  }
});

test("invalid normalized values fault without sending an absolute target", async () => {
  for (const value of [-.1, 1.1, NaN, Infinity, -Infinity, true, ".5", null]) {
    const {transport, motor} = await running();
    await assert.rejects(transport.command(value));
    assert.deepEqual(motor.destinations, []);
    assert.deepEqual(motor.commands.slice(-2), ["clear", "inhibit"]);
    assert.equal(transport.status().stop_confirmed, true);
    await transport.close();
  }
});

test("active config, alarm, output and encoder bounds are checked before the next target", async () => {
  for (const scenario of ["config", "alarm", "output", "bounds"]) {
    const {transport, motor} = await running();
    if (scenario === "config") motor.values[7]++;
    if (scenario === "alarm") motor.values[14] = 1;
    if (scenario === "output") motor.values[1] = 3;
    if (scenario === "bounds") motor.position(24096 + 129);
    await assert.rejects(transport.command(.7));
    assert.deepEqual(motor.destinations, []);
    assert.equal(transport.status().stop_confirmed, false);
    assert.ok(transport.status().fault); await transport.close();
  }
});

test("three fresh tracking failures inhibit before a fourth target", async () => {
  const {transport, motor} = await running();
  motor.onCommand = (_, operation) => { if (operation === "absolute") motor.position(20000); };
  await transport.command(1); await transport.command(1); await transport.command(1);
  await assert.rejects(transport.command(1), /Tracking error/);
  assert.equal(motor.destinations.length, 3);
  assert.deepEqual(motor.commands.slice(-2), ["clear", "inhibit"]);
  await transport.close();
});

test("ignored enable or drift during hold prevents every target", async () => {
  for (const scenario of ["ignored", "drift", "pending"]) {
    const {transport, motor} = make();
    await transport.connect(); await transport.arm();
    motor.onCommand = (_, operation) => {
      if (operation === "enable") {
        if (scenario === "ignored") motor.values[1] = 0;
        if (scenario === "drift") motor.position(20017);
        if (scenario === "pending") motor.remaining(1);
      }
    };
    await assert.rejects(transport.start());
    assert.deepEqual(motor.destinations, []);
    assert.deepEqual(motor.commands, ["clear", "enable", "clear", "inhibit"]);
    await transport.close();
  }
});

test("unknown output and raw current telemetry do not imply ownership or force calibration", async () => {
  const {transport, motor} = make({allowed: false});
  motor.values[1] = 7; motor.values[15] = 4321; motor.values[24] = 43981;
  const status = await transport.connect();
  assert.equal(status.output_enabled, null); assert.equal(status.output_raw, 7);
  assert.equal(status.current_raw, 4321); assert.equal(status.output_limit_stall_raw, 43981);
  const count = motor.transmissions.length; transport.status();
  assert.equal(motor.transmissions.length, count);
  await transport.close(); assert.deepEqual(motor.commands, []);
});

test("lost absolute acknowledgement is never retried and the fault stays latched", async () => {
  for (const response of [new Uint8Array(), frame([1, 16, 0, 12, 0, 2]), frame([1, 16, 0, 22, 0, 1])]) {
    const {transport, motor} = await running();
    motor.onCommand = (_, operation) => operation === "absolute" ? response : undefined;
    await assert.rejects(transport.command(.6));
    assert.equal(motor.destinations.length, 1);
    assert.equal(transport.status().stop_confirmed, true);
    assert.ok(transport.status().fault); await assert.rejects(transport.arm());
    const writes = motor.transmissions.length;
    await transport.close(); assert.equal(motor.transmissions.length, writes);
  }
});

test("failed clear acknowledgement never suppresses the independent inhibit attempt", async () => {
  const {transport, motor} = await running();
  motor.onCommand = (_, operation) => operation === "clear" ? new Uint8Array() : undefined;
  await assert.rejects(transport.stop());
  assert.deepEqual(motor.commands.slice(-2), ["clear", "inhibit"]);
  assert.equal(motor.values[1], 0);
  assert.equal(transport.status().stop_confirmed, false);
  assert.equal(transport.status().owned, true);
  const writes = motor.transmissions.length;
  await transport.close(); assert.equal(motor.transmissions.length, writes);
});

test("fresh contradictory or missing readback invalidates a previously confirmed stop", async () => {
  for (const change of ["drift", "pending", "pwm", "read_error"]) {
    const {transport, motor} = await running();
    assert.equal((await transport.stop()).stop_confirmed, true);
    if (change === "drift") motor.position(20005);
    if (change === "pending") motor.remaining(1);
    if (change === "pwm") motor.values[19] = 1;
    if (change === "read_error") motor.onRead = () => new Uint8Array();
    await assert.rejects(transport.snapshot());
    assert.equal(transport.status().stop_confirmed, false);
    assert.ok(transport.status().fault); await transport.close();
  }
});

test("concurrent public commands serialize exchanges and retain their order", async () => {
  const {transport, motor} = await running();
  await Promise.all([transport.command(.25), transport.command(.5), transport.command(.75)]);
  assert.deepEqual(motor.destinations, [17952, 20000, 22048]);
  assert.equal(motor.maxActive, 1); await transport.stop(); await transport.close();
});

test("Stop cancels a blocked command read and queued targets before either target writes", async () => {
  const {transport, motor} = await running();
  const entered = deferred(), release = deferred();
  motor.onRead = async () => { motor.onRead = null; entered.resolve(); await release.promise; };
  const first = assert.rejects(transport.command(.25), /cancel/i);
  await entered.promise;
  const queued = assert.rejects(transport.command(.75), /cancel/i);
  const stopping = transport.stop();
  release.resolve();
  await Promise.all([first, queued, stopping]);
  assert.deepEqual(motor.destinations, []);
  assert.deepEqual(motor.commands.slice(-2), ["clear", "inhibit"]);
  assert.equal(transport.status().running, false);
  assert.equal(transport.status().stop_confirmed, true);
  assert.equal(transport.status().fault, null);
  assert.equal(motor.maxActive, 1); await transport.close();
});

test("Stop waits for an already transmitted target and cancels following targets", async () => {
  const {transport, motor} = await running();
  const entered = deferred(), release = deferred();
  motor.onCommand = async (_, operation) => {
    if (operation === "absolute") { entered.resolve(); await release.promise; }
  };
  const first = transport.command(.25);
  const observedFirst = first.then(() => "completed", () => "cancelled");
  await entered.promise;
  const queued = assert.rejects(transport.command(.75), /cancel/i);
  const stopping = transport.stop(); release.resolve();
  await Promise.all([observedFirst, queued, stopping]);
  assert.deepEqual(motor.destinations, [17952]);
  assert.equal(transport.status().stop_confirmed, true);
  assert.equal(motor.maxActive, 1); await transport.close();
});

test("both native directions measure repeatable endpoints and center in one coordinate", async () => {
  for (const reverse of [false, true]) {
    const context = await homing(reverse), {transport, motor} = context;
    const status = await advance(context), sign = reverse ? -1 : 1;
    const endpoints = reverse ? [-3277, 160563] : [-160563, 3277];
    const bounds = [endpoints[0] + 1638, endpoints[1] - 1638];
    const center = (bounds[0] + bounds[1]) / 2;
    assert.deepEqual(status.measured_endpoints_raw, endpoints);
    assert.equal(status.measured_travel_raw, 163840);
    assert.deepEqual(status.raw_bounds, bounds);
    assert.equal(status.position_normalized, .5); assert.equal(status.position_raw, center);
    assert.equal(status.homed, true); assert.equal(status.homing, false);
    assert.equal(status.stop_confirmed, true); assert.equal(status.owned, false);
    assert.deepEqual(motor.destinations, [sign * 8192, sign * 1639, sign * 4096,
      sign * (3277 - 409600 - 819), sign * -158925, sign * -161382, center]);
    assert.equal(motor.settings.filter(([r, v]) => r === 25 && v === 1).length, 1);
    assert.ok(motor.settings.every(([r]) => r !== 20 && r !== 21));
    assert.deepEqual(motor.values.slice(0, 4), [1, 0, 7, 15]);
    assert.equal(motor.values[24], 0); assert.equal(motor.values[25], 0);
    for (const state of motor.absoluteStates) {
      assert.deepEqual(state.slice(0, 4), [1, 1, 7, 15]);
      assert.equal(state[24], 89); assert.equal(state[25], 0);
    }
    await transport.close(); assert.equal(transport.status().homed, false);
  }
});

test("measured bounds freeze across stop/rearm and runtime zero maps one count away", async () => {
  const context = await homing(), {transport, motor} = context;
  const {raw_bounds: bounds} = await advance(context);
  await transport.arm(); await transport.start(); await transport.command(.75);
  await transport.stop(); await transport.arm();
  assert.deepEqual(transport.status().raw_bounds, bounds);
  await transport.start(); await transport.command(-bounds[0] / (bounds[1] - bounds[0]));
  assert.ok([-1, 1].includes(motor.destinations.at(-1)));
  assert.ok(!motor.destinations.includes(0));
  assert.equal(motor.settings.filter(([r, v]) => r === 25 && v === 1).length, 1);
  await transport.stop(); await transport.close();
});

test("zero retreat and zero range endpoint are sent as neighboring nonzero coordinates", async () => {
  const motor = new FakeConnection({native: true}); motor.contacts = [1638 - 163840, 1638];
  const context = await homing(false, motor), {transport} = context;
  const status = await advance(context);
  assert.ok([-1, 1].includes(motor.destinations[1]));
  assert.equal(status.raw_bounds[1], 0);
  await transport.arm(); await transport.start(); await transport.command(1);
  assert.equal(motor.destinations.at(-1), -1);
  assert.ok(!motor.destinations.includes(0));
  assert.equal(motor.settings.filter(([r, v]) => r === 25 && v === 1).length, 1);
  await transport.stop(); await transport.close();
});

test("Stop cancels a blocked native poll and queued poll without retouch or center writes", async () => {
  const context = await homing(), {transport, motor} = context;
  await advance(context, "first_retreat");
  const targets = motor.destinations.slice(), entered = deferred(), release = deferred();
  motor.onRead = async () => { motor.onRead = null; entered.resolve(); await release.promise; };
  const active = assert.rejects(transport.poll_home(), /cancel/i);
  await entered.promise;
  const queued = assert.rejects(transport.poll_home(), /cancel/i);
  const stopping = transport.stop(); release.resolve();
  await Promise.all([active, queued, stopping]);
  assert.deepEqual(motor.destinations, targets);
  assert.equal(transport.status().homed, false); assert.equal(transport.status().homing, false);
  assert.equal(transport.status().home_phase, "cancelled");
  assert.equal(transport.status().stop_confirmed, true); assert.equal(transport.status().fault, null);
  assert.equal(motor.maxActive, 1); await transport.close();
});

test("native initial zero pending without fresh activity never completes", async () => {
  for (const initial of [0, 20000]) {
    const motor = new FakeConnection({native: true, homeIgnored: true}); motor.position(initial);
    const context = await homing(false, motor);
    await advance(context, "seeking");
    for (let index = 0; index < 6; index++) {
      await context.clock.wait(.1); await context.transport.poll_home();
      assert.equal(context.transport.status().home_phase, "seeking");
    }
    await context.clock.wait(31); await homeFault(context);
    assert.deepEqual(motor.destinations, []); await context.transport.close();
  }
});

test("contact requires sustained stasis, pending error and signed PWM load together", async () => {
  for (const [reverse, failure] of [[false, "low_load"], [true, "low_load"], [false, "low_pending"], [false, "creep"]]) {
    const motor = new FakeConnection({native: true});
    if (failure === "low_load") motor.contactPWM = 1965;
    const context = await homing(reverse, motor);
    await advance(context, "first_contact");
    if (failure === "low_load") assert.equal(motor.values[19], (reverse ? -1965 : 1965) & 65535);
    let reads = 0;
    motor.onRead = () => {
      if (motor.values[1] === 1) {
        if (failure === "low_pending") motor.remaining(511);
        if (failure === "creep") {
          const position = 3277 + (++reads % 2 ? 8 : 0);
          motor.position(position); motor.remaining(8192 - position);
        }
      }
    };
    await homeFault(context); assert.equal(motor.destinations.length, 1);
    await context.transport.close();
  }
});

test("contact needs at least half a second of fresh qualifying observations", async () => {
  const context = await homing(); await advance(context, "first_contact");
  for (let index = 0; index < 5; index++) {
    await context.clock.wait(.1); await context.transport.poll_home();
    assert.equal(context.transport.status().home_phase, "first_contact");
  }
  await advance(context, "commanding_first_retreat");
  assert.deepEqual(context.motor.destinations, [8192]);
  await context.transport.stop(); await context.transport.close();
});

test("release requires two millimeters of movement and a fall in load", async () => {
  for (const failure of ["stationary", "still_loaded"]) {
    const context = await homing(), {motor} = context;
    await advance(context, "commanding_first_retreat");
    motor.onCommand = (_, operation) => {
      if (operation === "absolute") {
        if (failure === "stationary") { motor.position(3277); motor.remaining(motor.target - 3277); }
        motor.values[19] = 2500;
      }
    };
    await homeFault(context); assert.equal(motor.destinations.length, 2);
    await context.transport.close();
  }
});

test("nonrepeatable first or second contacts never publish a usable range", async () => {
  for (const side of ["first", "second"]) {
    const context = await homing(), {motor} = context;
    await advance(context, `commanding_${side}_retouch`);
    motor.contacts = side === "first" ? [-160563, 3406] : [-160692, 3277];
    const status = await homeFault(context);
    assert.equal(status.raw_bounds, null); assert.equal(status.measured_travel_raw, null);
    assert.equal(motor.destinations.length, side === "first" ? 3 : 6);
    await context.transport.close();
  }
});

test("alarm and ambiguous native-trigger acknowledgement abort without retry", async () => {
  for (const scenario of ["alarm", "trigger_ack"]) {
    const context = await homing(), {transport, motor} = context;
    if (scenario === "alarm") {
      await advance(context, "first_contact"); motor.values[14] = 1;
    } else {
      await advance(context, "triggering_home");
      motor.onSetting = (_, register, value) => register === 25 && value === 1 ? new Uint8Array() : undefined;
    }
    await homeFault(context);
    assert.equal(motor.settings.filter(([r, v]) => r === 25 && v === 1).length, 1);
    assert.equal(motor.destinations.length, scenario === "alarm" ? 1 : 0);
    await transport.close();
  }
});

test("native cancel still attempts mode-off when inhibit acknowledgement is lost", async () => {
  const context = await homing(), {transport, motor} = context;
  await advance(context, "seeking");
  motor.onCommand = (_, operation) => operation === "inhibit" ? new Uint8Array() : undefined;
  await assert.rejects(transport.stop());
  assert.ok(motor.settings.some(([r, v]) => r === 0 && v === 0));
  assert.equal(transport.status().stop_confirmed, false);
  assert.equal(transport.status().owned, true);
  const count = motor.transmissions.length; await transport.close();
  assert.equal(motor.transmissions.length, count);
});

test("homing publishes measurement only after centered and inhibited verification", async () => {
  const context = await homing();
  for (const phase of ["centering", "verify_stop", "verify_complete"]) {
    const status = await advance(context, phase);
    assert.equal(status.homed, false); assert.equal(status.raw_bounds, null);
    assert.equal(status.measured_endpoints_raw, null); assert.equal(status.measured_travel_raw, null);
  }
  assert.equal((await advance(context)).homed, true); await context.transport.close();
});

test("center travel uses a distance deadline and never reissues a timed-out target", async () => {
  for (const finishes of [true, false]) {
    const context = await homing(), {transport, motor, clock} = context;
    await advance(context, "commanding_centering");
    motor.onCommand = (_, operation) => {
      if (operation === "absolute") {
        motor.position(-160563); motor.remaining(motor.target + 160563); motor.values[19] = 500;
      }
    };
    await advance(context, "centering"); const targets = motor.destinations.slice();
    await clock.wait(9); assert.equal((await transport.poll_home()).home_phase, "centering");
    if (finishes) {
      motor.position(motor.target); motor.remaining(0); motor.values[19] = 0;
      assert.equal((await advance(context)).homed, true);
    } else {
      const timeout = Math.abs(motor.target + 160563) / (32768 * 7 / 60) + 7 / 15 + 5;
      await clock.wait(timeout - 9 + .1); await homeFault(context);
    }
    assert.deepEqual(motor.destinations, targets); await transport.close();
  }
});

test("known disabled mode zero can home but enabled or unknown output cannot", async () => {
  for (const flags of [0, 2, 6]) {
    const motor = new FakeConnection({native: true}); motor.values[0] = 0; motor.values[1] = flags;
    const context = await homing(false, motor);
    assert.equal((await advance(context)).homed, true); await context.transport.close();
  }
  for (const [mode, flags] of [[0, 1], [0, 3], [0, 7], [0, 4], [1, 2], [1, 6]]) {
    const {transport, motor} = make({motor: new FakeConnection({native: true})});
    motor.values[0] = mode; motor.values[1] = flags;
    await transport.connect(); await assert.rejects(transport.begin_home(false));
    assert.deepEqual(motor.commands, []); assert.deepEqual(motor.settings, []); await transport.close();
  }
});

test("rail span limit accepts exactly 500mm and rejects shorter or excessive rails", async () => {
  for (const [span, valid] of [[409600, true], [8192, false], [410419, false]]) {
    const motor = new FakeConnection({native: true}); motor.contacts = [3277 - span, 3277];
    const context = await homing(false, motor);
    if (valid) assert.equal((await advance(context)).measured_travel_raw, span);
    else assert.equal((await homeFault(context)).raw_bounds, null);
    await context.transport.close();
  }
});

test("actual browser runtime and transport complete chooser, Home, ARM/RUN and confirmed Stop", async () => {
  const clock = new Clock(), motor = new FakeConnection({native: true});
  const selectedPort = {getInfo: () => ({usbVendorId: 0x1234, usbProductId: 0x5678})};
  let chooserCalls = 0, liveTransport;
  const serial = {
    requestPort: async () => { chooserCalls++; return selectedPort; },
    getPorts: async () => [selectedPort],
    addEventListener() {}, removeEventListener() {},
  };
  const runtime = createRuntime({
    autoStart: false, clock: clock.now, serial,
    transportFactory: port => {
      assert.equal(port, selectedPort);
      liveTransport = new MotorTransport(port, {
        allowMotion: true, clock: clock.now, wait: clock.wait,
        connectionFactory: () => motor, portLabel: "offline-runtime-rail",
      });
      return liveTransport;
    },
  });
  try {
    assert.equal(motor.openCount, 0);
    const chosen = await runtime.choosePort();
    assert.equal(chooserCalls, 1); assert.equal(motor.openCount, 0);
    let state = await runtime.request("/api/action", {action: "connect", port: chosen});
    assert.equal(state.mode, "hardware"); assert.equal(state.hardware.connected, true);
    assert.equal(motor.openCount, 1); assert.deepEqual(motor.commands, []);
    assert.equal(state.armed, false); assert.equal(state.running, false);
    state = await runtime.request("/api/action", {
      action: "home_start", direction: "normal", control_revision: state.control_revision,
    });
    assert.equal(state.homing.active, true);
    const phases = new Set();
    for (let index = 0; index < 800 && runtime.state().homing.active; index++) {
      await clock.wait(.11);
      await runtime.request("/api/action", {action: "heartbeat"});
      await runtime.tick();
      state = runtime.state(); phases.add(state.homing.phase);
      assert.equal(state.fault, null, `controller fault during ${state.homing.phase}`);
      assert.equal(state.hardware.fault, null);
    }
    state = runtime.state();
    assert.equal(state.homing.active, false); assert.equal(state.homing.valid, true);
    assert.equal(state.homing.phase, "complete");
    for (const phase of ["first_contact", "first_retouch", "second_contact", "second_retouch", "centering"]) {
      assert.ok(phases.has(phase), `real transport never visited ${phase}`);
    }
    assert.equal(state.hardware.position_normalized, .5);
    assert.equal(state.hardware.position_raw, -78643);
    assert.deepEqual(state.hardware.measured_endpoints_raw, [-160563, 3277]);
    assert.equal(state.hardware.stop_confirmed, true);
    assert.equal(state.hardware.output_enabled, false);
    assert.equal(state.armed, false); assert.equal(state.running, false);
    const bounds = state.hardware.raw_bounds.slice(), homeTargets = motor.destinations.length;

    state = await runtime.request("/api/action", {action: "arm"});
    assert.equal(state.armed, true); assert.equal(state.running, false);
    assert.equal(state.hardware.output_enabled, false);
    state = await runtime.request("/api/action", {action: "run"});
    assert.equal(state.running, true); assert.equal(state.hardware.running, true);
    await runtime.request("/api/action", {action: "gate", value: true});
    for (let index = 0; index < 30; index++) {
      await clock.wait(.11);
      await runtime.request("/api/action", {action: "heartbeat"});
      await runtime.tick();
      state = runtime.state();
      assert.equal(state.fault, null); assert.equal(state.hardware.fault, null);
      assert.equal(state.running, true);
      assert.ok(Number.isFinite(state.signal.command));
      assert.ok(state.signal.command >= state.params.lower && state.signal.command <= state.params.upper);
    }
    assert.ok(motor.destinations.length > homeTargets);
    assert.ok(motor.destinations.slice(homeTargets).every(target =>
      Number.isInteger(target) && target !== 0 && target >= bounds[0] && target <= bounds[1]));
    state = await runtime.request("/api/action", {action: "stop"});
    assert.equal(state.armed, false); assert.equal(state.running, false); assert.equal(state.gate, false);
    assert.equal(state.fault, null); assert.equal(state.unconfirmed_stop, false);
    assert.equal(state.hardware.fault, null); assert.equal(state.hardware.stop_confirmed, true);
    assert.equal(state.hardware.output_enabled, false);
    assert.equal(state.hardware.pending_raw, 0); assert.equal(state.hardware.pwm_raw, 0);
    assert.deepEqual(state.hardware.raw_bounds, bounds);
    assert.equal(liveTransport.status().running, false);
    assert.equal(motor.settings.filter(([register, value]) => register === 25 && value === 1).length, 1);
    assert.equal(motor.maxActive, 1);
  } finally { await runtime.close(); }
  assert.equal(motor.closeCount, 1);
});
