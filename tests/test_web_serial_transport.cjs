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
    this.values[0] = 1; this.values[2] = 600; this.values[3] = 20000;
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
    assert.ok(timeout > 0 && timeout <= .5);
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
      if (tx[1] === 0x7b) {
        const target = (tx[2] << 24) | (tx[3] << 16) | (tx[4] << 8) | tx[5];
        this.target = target; this.destinations.push(target); this.commands.push("absolute");
        const actual = this.values[22] | this.values[23] << 16;
        this.position(target); this.remaining(0);
        return frame([1, 0x7b, actual >>> 8 & 255, actual & 255, actual >>> 24 & 255, actual >>> 16 & 255]);
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

function make({motor = new FakeConnection(), allowed = true, nativeHome = true, fastPositions = false} = {}) {
  const clock = new Clock(), selectedPort = {}, factories = [];
  const transport = new MotorTransport(selectedPort, {
    allowMotion: allowed, nativeHome, fastPositions, portLabel: "offline-test", clock: clock.now, wait: clock.wait,
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
    [14, 1], [20, 1], [21, 2], [25, 8], [12, 3], [19, 1]]) {
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

test("transport continues after twenty seconds and still confirms explicit Stop", async () => {
 const {transport,motor,clock}=await running();await clock.wait(90);
 await transport.command(.7);assert.equal((await transport.snapshot()).running,true);
 assert.equal(motor.destinations.length,1);assert.equal(transport.status().max_run_seconds,null);
 assert.equal((await transport.stop()).stop_confirmed,true);await transport.close();
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

test("tracking budget accepts one command interval but stops persistent larger lag", async () => {
  const {transport, motor} = await running();
  transport._low = -142266; transport._high = 1715;
  transport._target = -70000; motor.position(-75000);
  motor.onCommand = (_, operation) => { if (operation === "absolute") motor.position(transport._target - 5000); };
  for (let i = 0; i < 4; i++) await transport.command(.5);
  assert.equal(transport.status().running, true);
  motor.onCommand = (_, operation) => { if (operation === "absolute") motor.position(-90000); };
  await transport.command(.5); await transport.command(.5); await transport.command(.5);
  await assert.rejects(transport.command(.5), /Tracking error/);
  assert.equal(transport.status().stop_confirmed, true);
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
        if (scenario === "pending") motor.remaining(17);
      }
    };
    await assert.rejects(transport.start());
    assert.deepEqual(motor.destinations, []);
    assert.deepEqual(motor.commands, ["clear", "enable", "clear", "inhibit"]);
    await transport.close();
  }
});

test("enabled run hold accepts persistent signed residuals within sixteen counts", async () => {
  for (const pending of [1, -1, 16, -16]) {
    const {transport, motor} = make();
    await transport.connect(); await transport.arm();
    let holdReads = 0;
    motor.onCommand = (_, operation) => {
      if (operation === "enable") { motor.remaining(pending); motor.values[19] = 29; }
    };
    motor.onRead = m => { if (m.values[1] === 1) { holdReads++; m.values[16] = holdReads % 2 ? 1 : 65535; } };
    assert.equal((await transport.start()).running, true);
    assert.ok(holdReads >= 3); assert.equal(transport.status().pending_raw, pending);
    assert.deepEqual(motor.destinations, []);
    await transport.stop(); await transport.close();
  }
});

test("enabled run hold rejects signed speed beyond jitter tolerance", async () => {
  for (const speed of [2, 65534]) {
    const {transport, motor} = make();
    await transport.connect(); await transport.arm();
    motor.onCommand = (_, operation) => { if (operation === "enable") motor.values[16] = speed; };
    await assert.rejects(transport.start());
    assert.deepEqual(motor.destinations, []); assert.equal(transport.status().running, false);
    await transport.close();
  }
});

test("disabled run hold rejects three-count demand and any nonzero PWM", async () => {
  for (const field of [12, 19]) {
    const {transport, motor} = make(); let first = true;
    await transport.connect(); await transport.arm();
    motor.onCommand = (_, operation) => {
      if (operation === "clear" && first) { first = false; motor.values[field] = field === 12 ? 3 : 1; }
    };
    await assert.rejects(transport.start());
    assert.ok(!motor.commands.includes("enable")); assert.deepEqual(motor.destinations, []);
    await transport.close();
  }
});

test("Home accepts persistent one-count holding error before native and calibration motion", async () => {
  for (const pending of [1, -1]) {
    const motor = new FakeConnection({native: true}); motor.position(8113);
    const context = await homing(false, motor), reads = {enabled_hold: 0, move_hold: 0};
    motor.onRead = m => {
      const phase = context.transport.status().home_phase;
      if (m.values[1] === 1 && Object.hasOwn(reads, phase)) {
        reads[phase]++; m.remaining(pending); m.values[19] = 29; m.values[16] = 0;
      }
    };
    assert.equal((await advance(context)).homed, true);
    assert.ok(reads.enabled_hold >= 3); assert.ok(reads.move_hold >= 3);
    assert.equal(context.transport.status().stop_confirmed, true);
    await context.transport.close();
  }
});

test("Home holds reject excessive residual, signed speed and encoder drift", async () => {
  for (const phase of ["enabled_hold", "move_hold"]) {
    for (const failure of ["pending17", "pending-17", "speed2", "speed-2", "drift"]) {
      const context = await homing(), {transport, motor} = context;
      await advance(context, phase);
      const targets = motor.destinations.slice(), held = transport.status().position_raw;
      motor.onRead = m => {
        if (m.values[1] !== 1) { m.values[16] = 0; return; }
        if (transport.status().home_phase !== phase) return;
        if (failure.startsWith("pending")) m.remaining(failure === "pending17" ? 17 : -17);
        if (failure.startsWith("speed")) m.values[16] = failure === "speed2" ? 2 : 65534;
        if (failure === "drift") m.position(held + 17);
      };
      await assert.rejects(advance(context));
      assert.equal(transport.status().homed, false); assert.equal(transport.status().stop_confirmed, true);
      assert.deepEqual(motor.destinations, targets);
      if (phase === "enabled_hold") assert.ok(!motor.settings.some(([r, v]) => r === 25 && v === 1));
      await transport.close();
    }
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
  for (const change of ["drift", "pending", "negative_pending", "pwm", "speed", "negative_speed", "read_error"]) {
    const {transport, motor} = await running();
    assert.equal((await transport.stop()).stop_confirmed, true);
    if (change === "drift") motor.position(20821);
    if (change === "pending") motor.remaining(3);
    if (change === "negative_pending") motor.remaining(-3);
    if (change === "pwm") motor.values[19] = 1;
    if (change === "speed") motor.values[16] = 2;
    if (change === "negative_speed") motor.values[16] = 65534;
    if (change === "read_error") motor.onRead = () => new Uint8Array();
    await assert.rejects(transport.snapshot());
    assert.equal(transport.status().stop_confirmed, false);
    assert.ok(transport.status().fault); await transport.close();
  }
});

test("Stop waits for transient coast feedback before confirming three stable inhibited reads", async () => {
  const motor = new FakeConnection(); motor.position(-72147);
  const context = await running({motor}), {transport, clock} = context;
  let inhibited = false, reads = 0;
  motor.onCommand = (_, operation) => { if (operation === "inhibit") inhibited = true; };
  motor.onRead = m => {
    if (!inhibited) return;
    reads++;
    if (reads === 1) { m.remaining(3); m.values[16] = 65504; m.position(-72147); }
    else if (reads === 2) { m.remaining(2); m.values[16] = 65534; m.position(-72151); }
    else { m.remaining(0); m.values[16] = 0; m.position(-72153 + reads % 2); }
    m.values[19] = 0;
  };
  const before = motor.commands.length, started = clock.now();
  const stopped = await transport.stop();
  assert.equal(stopped.stop_confirmed, true); assert.equal(stopped.fault, null);
  assert.ok(reads >= 5); assert.ok(clock.now() - started <= 3.01);
  assert.deepEqual(motor.commands.slice(before), ["clear", "inhibit"]);
  assert.ok([-72153, -72152].includes(stopped.position_raw));
  assert.equal((await transport.snapshot()).stop_confirmed, true);
  await transport.close();
});

test("Stop never confirms persistent demand, speed, enabled output or material encoder drift", async () => {
  for (const failure of ["pending", "speed", "output", "drift", "pwm"]) {
    const {transport, motor, clock} = await running();
    let inhibited = false, reads = 0;
    motor.onCommand = (_, operation) => { if (operation === "inhibit") inhibited = true; };
    motor.onRead = m => {
      if (!inhibited) return;
      reads++;
      if (failure === "pending") m.remaining(3);
      if (failure === "speed") m.values[16] = 65504;
      if (failure === "output") m.values[1] = 1;
      if (failure === "drift") m.position(20000 + 50 * reads);
      if (failure === "pwm") m.values[19] = 1;
    };
    const before = motor.commands.length, started = clock.now();
    await assert.rejects(transport.stop());
    assert.ok(clock.now() - started <= 3.01, `unbounded stop for ${failure}`);
    assert.equal(transport.status().stop_confirmed, false); assert.ok(transport.status().fault);
    assert.deepEqual(motor.commands.slice(before), ["clear", "inhibit"]);
    assert.ok(reads >= 1);
    await transport.close();
  }
});

test("Stop aborts on missing or corrupt readback without retransmitting control commands", async () => {
  for (const failure of ["missing", "crc"]) {
    const {transport, motor} = await running();
    let inhibited = false, reads = 0;
    motor.onCommand = (_, operation) => { if (operation === "inhibit") inhibited = true; };
    motor.onRead = m => {
      if (!inhibited) return;
      reads++;
      if (failure === "missing") return new Uint8Array();
      const invalid = frame([1, 3, 52, ...m.values.flatMap(value => [value >>> 8, value & 255])]);
      invalid[invalid.length - 1] ^= 1; return invalid;
    };
    const before = motor.commands.length;
    await assert.rejects(transport.stop());
    assert.equal(transport.status().stop_confirmed, false); assert.ok(transport.status().fault);
    assert.equal(reads, 1); assert.deepEqual(motor.commands.slice(before), ["clear", "inhibit"]);
    await transport.close();
  }
});

function disabledEncoderJitter(motor) {
  let base = motor.values[22] | motor.values[23] << 16, reads = 0;
  const observed = new Set(), priorCommand = motor.onCommand;
  motor.onCommand = (m, operation, ...details) => {
    const result = priorCommand?.(m, operation, ...details);
    if (operation === "inhibit" || operation === "absolute") base = m.values[22] | m.values[23] << 16;
    return result;
  };
  motor.onRead = m => {
    if (m.values[1] & 1) return;
    const pending = [1, -1, 2, -2][reads++ % 4];
    m.remaining(pending); m.position(base + reads % 2);
    m.values[19] = 0; m.values[16] = reads % 2 ? 1 : 65535;
    observed.add(pending);
  };
  return observed;
}

test("disabled encoder quantization permits Home, arm, run and confirmed stop across fresh reads", async () => {
  const motor = new FakeConnection({native: true}); motor.position(262);
  const observed = disabledEncoderJitter(motor), context = await homing(false, motor), {transport} = context;
  const homed = await advance(context);
  assert.equal(homed.homed, true); assert.equal(homed.stop_confirmed, true);
  assert.equal((await transport.snapshot()).stop_confirmed, true);
  assert.equal((await transport.arm()).armed, true);
  assert.equal((await transport.start()).running, true);
  await transport.command(.5);
  assert.equal((await transport.stop()).stop_confirmed, true);
  for (let read = 0; read < 4; read++) {
    const stopped = await transport.snapshot();
    assert.equal(stopped.stop_confirmed, true); assert.ok(Math.abs(stopped.pending_raw) <= 2);
    assert.equal(stopped.pwm_raw, 0);
  }
  assert.deepEqual([...observed].sort((a, b) => a - b), [-2, -1, 1, 2]);
  await transport.close();
});

test("Home cancellation confirms inhibition with two-count encoder quantization", async () => {
  const motor = new FakeConnection({native: true}); disabledEncoderJitter(motor);
  const context = await homing(false, motor), {transport} = context;
  await advance(context, "seeking");
  const stopped = await transport.stop();
  assert.equal(stopped.stop_confirmed, true); assert.equal(stopped.homed, false);
  assert.equal(stopped.pwm_raw, 0); assert.ok(Math.abs(stopped.pending_raw) <= 2);
  assert.equal((await transport.snapshot()).stop_confirmed, true);
  await transport.close();
});

test("arming rejects disabled demand beyond two counts, output, speed and encoder movement", async () => {
  for (const failure of ["pending3", "pending-3", "pwm", "speed", "drift"]) {
    const {motor, transport} = make(); await transport.connect();
    if (failure.startsWith("pending")) motor.remaining(failure === "pending3" ? 3 : -3);
    if (failure === "pwm") motor.values[19] = 1;
    if (failure === "speed") motor.values[16] = 2;
    if (failure === "drift") { let read = 0; motor.onRead = m => m.position(20000 + 5 * read++); }
    await assert.rejects(transport.arm());
    assert.equal(transport.status().armed, false); assert.deepEqual(motor.commands, []);
    await transport.close();
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
    assert.deepEqual(motor.destinations, [sign * 409600, sign * 1639, sign * 4096,
      sign * (3277 - 409600 - 819), sign * -158925, sign * -161382, center]);
    assert.equal(motor.settings.filter(([r, v]) => r === 25 && v === 1).length, 1);
    assert.ok(motor.settings.every(([r]) => r !== 20 && r !== 21));
    assert.deepEqual(motor.values.slice(0, 4), [1, 0, 600, 20000]);
    assert.equal(motor.values[24], 0); assert.equal(motor.values[25], 0);
    for (const [index, state] of motor.absoluteStates.entries()) {
      const recheck = [1, 2, 4, 5].includes(index);
      assert.deepEqual(state.slice(0, 4), recheck ? [1, 1, 35, 75] : [1, 1, 70, 150]);
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
          motor.position(position); motor.remaining(409600 - position);
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
  assert.deepEqual(context.motor.destinations, [409600]);
  await context.transport.stop(); await context.transport.close();
});

function contactSpringback(context, amount = 180) {
  const {motor, transport} = context, releases = [];
  let staleHold = false;
  motor.onCommand = (m, operation) => {
    if (operation === "clear" && m.values[1] === 0) staleHold = false;
    if (operation === "enable") assert.equal(staleHold, false, "clear inhibited demand before reenabling after springback");
    if (operation !== "inhibit" || transport.status().home_phase !== "inhibiting_contact") return;
    const loaded = m.values[22] | m.values[23] << 16;
    const [low] = m.contacts ?? (m.values[9] ? [-3277, 160563] : [-160563, 3277]);
    const inward = loaded === low ? 1 : -1;
    m.position(loaded + inward * amount); m.remaining(0);
    releases.push({loaded, released: loaded + inward * amount}); staleHold = true;
  };
  return releases;
}

test("180-count inward springback preserves loaded endpoints and clears before reenabling", async () => {
  for (const reverse of [false, true]) {
    const motor = new FakeConnection({native: true});
    motor.contacts = reverse ? [-110243, 53597] : [-53597, 110243];
    const context = await homing(reverse, motor), releases = contactSpringback(context);
    const result = await advance(context);
    assert.equal(releases.length, 4);
    assert.ok(releases.every(({loaded, released}) => Math.abs(loaded - released) === 180));
    assert.deepEqual(result.measured_endpoints_raw, motor.contacts);
    assert.equal(result.measured_travel_raw, 163840); assert.equal(result.position_normalized, .5);
    assert.equal(result.homed, true); assert.equal(result.stop_confirmed, true);
    await context.transport.close();
  }
});

test("contact inhibition rejects inward release beyond512 and outward movement beyond128", async () => {
  for (const reverse of [false, true]) {
    for (const side of ["first", "second"]) {
      for (const amount of [513, -129]) {
        const context = await homing(reverse), {motor, transport} = context;
        await advance(context, `${side}_contact`);
        await advance(context, "inhibiting_contact");
        const targets = motor.destinations.slice();
        const releases = contactSpringback(context, amount);
        await assert.rejects(advance(context), TransportError);
        assert.equal(releases.length, 1); assert.equal(transport.status().homed, false);
        assert.equal(transport.status().stop_confirmed, true);
        assert.deepEqual(motor.destinations, targets);
        await transport.close();
      }
    }
  }
});

test("springback allowance never widens the128-count loaded contact repeat tolerance", async () => {
  for (const reverse of [false, true]) {
    for (const side of ["first", "second"]) {
      const motor = new FakeConnection({native: true});
      motor.contacts = reverse ? [-3277, 160563] : [-160563, 3277];
      const context = await homing(reverse, motor); contactSpringback(context);
      await advance(context, `commanding_${side}_retouch`);
      const positiveEnd = side === "first" ? !reverse : reverse;
      motor.contacts[positiveEnd ? 1 : 0] += positiveEnd ? 129 : -129;
      await assert.rejects(advance(context), /Repeated endpoint contact.*128/);
      assert.equal(context.transport.status().homed, false);
      assert.equal(context.transport.status().measured_endpoints_raw, null);
      await context.transport.close();
    }
  }
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

test("center inhibition accepts53-count relaxation and retains the actual confirmed stop", async () => {
  for (const reverse of [false, true]) {
    const context = await homing(reverse), {transport, motor} = context;
    await advance(context, "inhibiting_center");
    const commanded = motor.target, settled = commanded + (reverse ? 53 : -53);
    motor.onCommand = (m, operation) => {
      if (operation === "inhibit" && transport.status().home_phase === "inhibiting_center") m.position(settled);
    };
    const result = await advance(context);
    assert.equal(result.homed, true); assert.equal(result.stop_confirmed, true);
    assert.equal(result.position_raw, settled); assert.equal(result.target_raw, commanded);
    assert.equal(result.position_normalized, (settled - result.raw_bounds[0]) / (result.raw_bounds[1] - result.raw_bounds[0]));
    assert.equal((await transport.snapshot()).stop_confirmed, true);
    const rearmed = await transport.arm();
    assert.equal(rearmed.armed, true); assert.equal(rearmed.target_raw, settled);
    await transport.stop(); await transport.close();
  }
});

test("center inhibition beyond128 counts never publishes a homed range", async () => {
  for (const reverse of [false, true]) {
    const context = await homing(reverse), {transport, motor} = context;
    await advance(context, "inhibiting_center");
    const settled = motor.target + (reverse ? 129 : -129);
    motor.onCommand = (m, operation) => {
      if (operation === "inhibit" && transport.status().home_phase === "inhibiting_center") m.position(settled);
    };
    await assert.rejects(advance(context), /drifted after centering/);
    assert.equal(transport.status().homed, false); assert.equal(transport.status().raw_bounds, null);
    assert.equal(transport.status().measured_endpoints_raw, null);
    assert.equal(transport.status().stop_confirmed, true);
    await transport.close();
  }
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
    await clock.wait(3); assert.equal((await transport.poll_home()).home_phase, "centering");
    if (finishes) {
      motor.position(motor.target); motor.remaining(0); motor.values[19] = 0;
      assert.equal((await advance(context)).homed, true);
    } else {
      const timeout = Math.abs(motor.target + 160563) / (32768 * 70 / 60) + 70 / 150 + 5;
      await clock.wait(timeout - 3 + .1); await homeFault(context);
    }
    assert.deepEqual(motor.destinations, targets); await transport.close();
  }
});

test("known position-mode startup states can home while unknown output stays rejected", async () => {
  for (const flags of [0, 2, 3, 6, 7, 10, 11, 14, 15]) {
    const motor = new FakeConnection({native: true}); motor.values[0] = 0; motor.values[1] = flags;
    const context = await homing(false, motor);
    assert.equal((await advance(context)).homed, true); await context.transport.close();
  }
  for (const [mode, flags] of [[0, 1], [0, 4], [1, 2], [1, 6]]) {
    const {transport, motor} = make({motor: new FakeConnection({native: true})});
    motor.values[0] = mode; motor.values[1] = flags;
    await transport.connect(); await assert.rejects(transport.begin_home(false));
    assert.deepEqual(motor.commands, []); assert.deepEqual(motor.settings, []); await transport.close();
  }
});

test("retained native status at startup still requires special mode cleared", async () => {
  for (const flags of [10, 11, 14, 15]) {
    const motor = new FakeConnection({native: true});
    motor.values[0] = 0; motor.values[1] = flags; motor.values[25] = 1;
    const {transport} = make({motor}); await transport.connect();
    await assert.rejects(transport.begin_home(), /special function/);
    assert.deepEqual(motor.commands, []); assert.deepEqual(motor.settings, []);
    await transport.close();
  }
});

function observedStartupMotor() {
  const motor = new FakeConnection({native: true});
  motor.values = [0, 7, 1500, 50000, 495, 3000, 10, 3000, 3900, 1, 32768, 800,
    9, 0, 0, 8, 0, 7725, 28, 64915, 0, 1, 2030, 0, 540, 0];
  // Observed firmware clears residual demand when entering Modbus. In pulse
  // mode the PWM register can retain stale holding output after inhibition.
  motor.onSetting = (m, register, value) => {
    if (register === 0 && value === 1) m.remaining(0);
  };
  motor.onCommand = (m, operation) => {
    if (m.values[0] === 0 && ["inhibit", "clear"].includes(operation)) m.values[19] = 65502;
  };
  return motor;
}

test("observed enabled pulse-mode drive is explicitly prepared before Home enables it", async () => {
  const motor = observedStartupMotor(), context = make({motor}), {transport} = context;
  assert.equal((await transport.connect()).output_enabled, true);
  assert.deepEqual(motor.settings, []); assert.deepEqual(motor.commands, []);
  await transport.begin_home(); await advance(context, "selecting_modbus");
  assert.deepEqual(motor.settings, []); assert.deepEqual(motor.commands, []);
  await advance(context, "setting_home_gear");
  assert.deepEqual(motor.settings, [[0, 1]]); assert.deepEqual(motor.commands, ["inhibit"]);
  assert.equal(motor.values[1], 0); assert.equal(motor.values[10], 32768);
  await advance(context, "enabling_home");
  assert.equal(motor.values[10], 0); assert.equal(motor.values[19], 0);
  assert.ok(!motor.commands.includes("enable"));
  assert.deepEqual(motor.values.slice(0, 4), [1, 0, 80, 15]);
  assert.equal((await advance(context)).homed, true);
  await transport.close();
});

test("Modbus startup normalizes nonzero gearing before its first demand clear", async () => {
  const motor = observedStartupMotor(), command = motor.onCommand;
  motor.values[0] = 1; motor.values[1] = 0; motor.values[19] = 0;
  motor.onCommand = (m, operation) => {
    if (operation === "clear") assert.equal(m.values[10], 0, "FC16 clear requires gear0");
    return command(m, operation);
  };
  const context = await homing(false, motor);
  await advance(context, "setting_home_gear");
  assert.deepEqual(motor.commands, ["inhibit"]); assert.equal(motor.values[12], 9);
  assert.equal(motor.values[10], 32768);
  assert.equal((await advance(context)).homed, true);
  await context.transport.close();
});

test("Home rejects moving feedback and excessive holding error before claiming output", async () => {
  for (const [register, value, message] of [[16, 2, /actual speed/], [16, 65534, /actual speed/], [12, 17, /holding error/], [14, 2, /alarm 0.*2/]]) {
    const motor = observedStartupMotor(); motor.values[register] = value;
    const {transport} = make({motor}); await transport.connect();
    await assert.rejects(transport.begin_home(), message);
    assert.deepEqual(motor.settings, []); assert.deepEqual(motor.commands, []);
    await transport.close();
  }
});

test("ineffective takeover inhibit never reaches gear configuration or Home enable", async () => {
  const motor = observedStartupMotor();
  motor.onCommand = (m, operation) => { if (operation === "inhibit") m.values[1] = 1; };
  const context = await homing(false, motor);
  await assert.rejects(advance(context), /could not inhibit/);
  assert.ok(!motor.commands.includes("enable"));
  assert.ok(!motor.settings.some(([r, v]) => r === 10 || (r === 25 && v === 1)));
  assert.equal(context.transport.status().stop_confirmed, false);
  await context.transport.close();
});

test("Stop during pulse-mode preflight normalizes stale PWM without triggering Home", async () => {
  const motor = observedStartupMotor(), context = await homing(false, motor);
  const stopped = await context.transport.stop();
  assert.equal(stopped.stop_confirmed, true); assert.equal(stopped.homing, false);
  assert.equal(stopped.output_enabled, false); assert.equal(stopped.pwm_raw, 0);
  assert.ok(!motor.settings.some(([r, v]) => r === 25 && v === 1));
  assert.ok(!motor.commands.includes("enable")); assert.deepEqual(motor.destinations, []);
  await context.transport.close();
});

test("Stop during a blocked startup read fences takeover and queued polls", async () => {
  const motor = observedStartupMotor(), context = await homing(false, motor);
  const entered = deferred(), release = deferred();
  motor.onRead = async () => { motor.onRead = null; entered.resolve(); await release.promise; };
  const polling = assert.rejects(context.transport.poll_home(), /cancel/i);
  await entered.promise;
  const queued = assert.rejects(context.transport.poll_home(), /cancel/i);
  const stopping = context.transport.stop(); release.resolve();
  await Promise.all([polling, queued, stopping]);
  assert.ok(!motor.commands.includes("enable")); assert.deepEqual(motor.destinations, []);
  assert.equal(context.transport.status().stop_confirmed, true);
  assert.equal(context.transport.status().home_phase, "cancelled");
  await context.transport.close();
});

function nativeResetMotor() {
  const motor = observedStartupMotor();
  motor.onNative = m => {
    if (m.nativeReads === 1) {
      m.values[0] = 1; m.values[1] = 1; m.values[16] = 80;
    } else {
      m.values[0] = 0; m.values[1] = 11; m.values[10] = 32768;
      m.values[16] = 0; m.values[19] = 0; m.values[24] = 540;
      m.position(m.nativeReads % 2 ? 42 : 43); m.remaining(0);
    }
  };
  return motor;
}

const MIXED_NATIVE_RETREAT = [1, 1, 80, 15, 495, 3000, 10, 3000, 3900, 0,
  32768, 800, 65123, 65535, 0, 8, 65217, 7725, 32, 64111, 0, 1, 62369, 65535, 540, 1];

test("mixed native transition snapshots keep seeking until explicit completion settles", async () => {
  const motor = nativeResetMotor(), native = motor.onNative;
  motor.onNative = m => {
    native(m);
    if (m.nativeReads === 2) m.values = MIXED_NATIVE_RETREAT.slice();
    else if (m.nativeReads >= 3 && m.nativeReads <= 5) {
      m.values = MIXED_NATIVE_RETREAT.slice();
      m.remaining(0); m.position(0); m.values[16] = 0; m.values[19] = 0;
    } else if (m.nativeReads >= 6) m.position(43);
  };
  const context = await homing(false, motor), {transport, clock} = context;
  await advance(context, "seeking");
  for (let read = 1; read <= 8; read++) {
    await clock.wait(.1); const status = await transport.poll_home();
    assert.equal(motor.nativeReads, read);
    assert.equal(status.home_phase, read < 8 ? "seeking" : "inhibiting_after_home");
  }
  assert.equal(transport.status().home_origin_raw, 43);
  assert.equal((await advance(context)).homed, true);
  await transport.close();
});

test("Home inhibit accepts a known transitioned ACK but rejects unknown flags", async () => {
  for (const acknowledged of [10, 8]) {
    const motor = nativeResetMotor();
    motor.onNative = m => { m.values = MIXED_NATIVE_RETREAT.slice(); };
    const context = await homing(false, motor), {transport, clock} = context;
    await advance(context, "seeking"); await clock.wait(.1); await transport.poll_home();
    assert.equal(transport.status().output_raw, 1);
    let firstInhibit = true;
    motor.onCommand = (m, operation) => {
      if (operation !== "inhibit" || !firstInhibit) return;
      firstInhibit = false; m.values[0] = 0; m.values[1] = 10;
      m.values[16] = 0; m.values[19] = 0;
      return frame([1, 6, 0, 1, 0, acknowledged]);
    };
    if (acknowledged === 10) {
      const stopped = await transport.stop();
      assert.equal(stopped.stop_confirmed, true); assert.equal(stopped.output_enabled, false);
      assert.equal(stopped.fault, null);
    } else {
      await assert.rejects(transport.stop()); assert.equal(transport.status().stop_confirmed, false);
      assert.ok(transport.status().fault);
    }
    assert.deepEqual(motor.destinations, []);
    await transport.close();
  }
});

test("normal motion does not accept Home-specific transitioned output ACKs", async () => {
  const {transport, motor} = await running();
  motor.onCommand = (_, operation) => operation === "inhibit" ? frame([1, 6, 0, 1, 0, 10]) : undefined;
  await assert.rejects(transport.stop());
  assert.equal(transport.status().stop_confirmed, false); assert.ok(transport.status().fault);
  await transport.close();
});

test("observed native completion restores pulse gearing and captures a near-zero origin", async () => {
  for (const flags of [10, 11, 14, 15]) {
    const motor = nativeResetMotor(), native = motor.onNative;
    motor.onNative = m => { native(m); if (m.nativeReads > 1) m.values[1] = flags; };
    const context = await homing(false, motor);
    const captured = await advance(context, "inhibiting_after_home");
    assert.ok([42, 43].includes(captured.home_origin_raw));
    assert.equal(captured.output_enabled, Boolean(flags & 1));
    assert.equal(motor.values[10], 32768);
    const result = await advance(context);
    assert.equal(result.homed, true); assert.equal(result.position_normalized, .5);
    assert.equal(result.output_enabled, false); assert.equal(motor.values[10], 0);
    await context.transport.close();
  }
});

test("first endpoint search starts at the captured position and reaches beyond ten millimeters", async () => {
  for (const reverse of [false, true]) {
    const motor = nativeResetMotor();
    motor.contacts = reverse ? [-24576, 139264] : [-139264, 24576];
    const context = await homing(reverse, motor);
    const before = await advance(context, "commanding_first_contact");
    const sign = reverse ? -1 : 1;
    await advance(context, "first_contact");
    assert.equal(motor.destinations[0], before.position_raw + sign * 409600);
    const contacted = motor.values[22] | motor.values[23] << 16;
    assert.ok(Math.abs(contacted - before.position_raw) > 8192);
    assert.deepEqual(motor.absoluteStates[0].slice(0, 4), [1, 1, 70, 150]);
    assert.equal(motor.absoluteStates[0][24], 89);
    const result = await advance(context);
    assert.equal(result.homed, true); assert.deepEqual(result.measured_endpoints_raw, motor.contacts);
    assert.equal(result.measured_travel_raw, 163840); assert.equal(result.position_normalized, .5);
    await context.transport.close();
  }
});

test("first search has a full-distance deadline and never reissues a freely reached target", async () => {
  const motor = new FakeConnection({native: true}); motor.contacts = [-1000000, 1000000];
  const context = await homing(false, motor), {transport, clock} = context;
  await advance(context, "first_contact");
  assert.deepEqual(motor.destinations, [409600]); assert.equal(transport.status().pending_raw, 0);
  await clock.wait(12); assert.equal((await transport.poll_home()).home_phase, "first_contact");
  const deadline = 409600 / (32768 * 70 / 60) + 70 / 150 + 5;
  await clock.wait(deadline - 12 + .1);
  await assert.rejects(transport.poll_home(), /timed out during first_contact/);
  assert.deepEqual(motor.destinations, [409600]); assert.equal(transport.status().homed, false);
  assert.equal(transport.status().stop_confirmed, true);
  await transport.close();
});

test("native completion rejects mismatched reset configuration and unknown flags", async () => {
  for (const [register, value] of [[10, 32767], [1, 13], [25, 0], [24, 610], [2, 81], [3, 16], [4, 496]]) {
    const motor = nativeResetMotor(), native = motor.onNative;
    motor.onNative = m => { native(m); if (m.nativeReads > 1) m.values[register] = value; };
    const context = await homing(false, motor);
    await assert.rejects(advance(context), /Native|Unexpected/);
    assert.equal(context.transport.status().homed, false);
    assert.deepEqual(motor.destinations, []);
    await context.transport.close();
  }
});

test("native reset flags and defaults may settle before three stationary completion reads", async () => {
  const motor = nativeResetMotor(), native = motor.onNative;
  motor.onNative = m => {
    native(m);
    if (m.nativeReads < 2) return;
    m.values[1] = [15, 14, 15, 11, 10][Math.min(4, m.nativeReads - 2)];
    m.values[2] = 1500; m.values[3] = 50000;
    m.values[16] = [3, 2, 1, 65535, 0][Math.min(4, m.nativeReads - 2)];
    m.position(m.nativeReads === 2 ? 0 : m.nativeReads === 3 ? -10 : -18);
  };
  const context = await homing(false, motor), {transport, clock} = context;
  await advance(context, "seeking");
  for (let read = 1; read <= 6; read++) {
    await clock.wait(.1); const status = await transport.poll_home();
    assert.equal(motor.nativeReads, read);
    assert.equal(status.home_phase, read < 6 ? "seeking" : "inhibiting_after_home");
  }
  assert.equal(transport.status().home_origin_raw, -18);
  assert.equal((await advance(context)).homed, true);
  assert.deepEqual(motor.values.slice(0, 4), [1, 0, 600, 20000]);
  await transport.close();
});

test("native completion still rejects motion and residual demand; legacy completion stays near zero", async () => {
  for (const failure of ["speed", "outside", "drift", "pending", "negative_pending"]) {
    const motor = nativeResetMotor(), native = motor.onNative;
    motor.onNative = m => {
      native(m);
      if (m.nativeReads > 1) {
        if (failure === "speed") m.values[16] = 2;
        if (failure === "outside") { m.values[1] = 3; m.values[10] = 0; m.position(129); }
        if (failure === "drift") m.position(m.nativeReads % 2 ? 43 : 50);
        if (failure === "pending") m.remaining(15);
        if (failure === "negative_pending") m.remaining(-15);
      }
    };
    const context = await homing(false, motor);
    await assert.rejects(advance(context), /timed out during seeking/);
    assert.equal(context.transport.status().homed, false);
    assert.deepEqual(motor.destinations, []);
    await context.transport.close();
  }
});

test("explicit native completion captures its actual stable coordinate without assuming zero", async () => {
  for (const origin of [266, 200000, -200000]) {
    const motor = nativeResetMotor(), native = motor.onNative;
    motor.contacts = [origin - 160563, origin + 3277];
    motor.onNative = m => { native(m); if (m.nativeReads > 1) m.position(origin + m.nativeReads % 2); };
    const context = await homing(false, motor);
    const captured = await advance(context, "inhibiting_after_home");
    assert.ok([origin, origin + 1].includes(captured.home_origin_raw));
    const restored = await advance(context, "commanding_first_contact");
    await advance(context, "first_contact");
    assert.equal(motor.destinations[0], restored.position_raw + 409600);
    const result = await advance(context);
    assert.equal(result.homed, true); assert.deepEqual(result.measured_endpoints_raw, motor.contacts);
    assert.equal(result.position_normalized, .5); assert.equal(result.stop_confirmed, true);
    await context.transport.close();
  }
});

test("native-reset cancellation clears special mode and gearing before any FC16 clear", async () => {
  const motor = nativeResetMotor(), context = await homing(false, motor);
  await advance(context, "inhibiting_after_home");
  const start = motor.transmissions.length;
  const stopped = await context.transport.stop();
  assert.equal(stopped.stop_confirmed, true); assert.equal(stopped.homed, false);
  assert.equal(stopped.output_enabled, false); assert.equal(stopped.pending_raw, 0);
  assert.equal(stopped.pwm_raw, 0); assert.equal(motor.values[25], 0);
  const writes = motor.transmissions.slice(start).filter(tx => tx[1] !== 3).map(tx => [tx[1], tx[3], tx[4] << 8 | tx[5]]);
  assert.deepEqual(writes.slice(0, 8), [[6, 1, 0], [6, 0, 0], [6, 25, 0], [6, 1, 0], [6, 0, 1], [6, 1, 0], [6, 10, 0], [16, 12, 2]]);
  assert.deepEqual(motor.destinations, []);
  assert.equal(motor.settings.filter(([r, v]) => r === 25 && v === 1).length, 1);
  await context.transport.close();
});

test("signed one-unit speed jitter is accepted only with stable encoder samples", async () => {
  for (const speed of [1, 65535]) {
    const motor = nativeResetMotor(), native = motor.onNative;
    motor.values[16] = speed;
    motor.onNative = m => { native(m); if (m.nativeReads > 1) m.values[16] = speed; };
    const context = await homing(false, motor);
    await advance(context, "inhibiting_after_home");
    const stopped = await context.transport.stop();
    assert.equal(stopped.stop_confirmed, true); assert.equal(stopped.output_enabled, false);
    assert.equal(motor.values[16], speed);
    await context.transport.close();
  }
  const motor = observedStartupMotor(); motor.values[16] = 65535;
  const context = await homing(false, motor);
  motor.onRead = m => { if (m.values[0] === 0) m.position(2040); };
  await assert.rejects(context.transport.poll_home(), /Encoder moved/);
  assert.ok(!motor.commands.includes("enable")); assert.deepEqual(motor.destinations, []);
  await context.transport.close();
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
        allowMotion: true, nativeHome: true, clock: clock.now, wait: clock.wait,
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

test("native Home restores saved output despite a temporary inhibited output setting", async () => {
 const motor = new FakeConnection({native:true});motor.values[24]=89;
 motor.onNative = m => {m.values[24]=540;};
 const context = await homing(false,motor);
 const result = await advance(context);
 assert.equal(result.homed,true);assert.equal(result.output_limit_stall_raw,540);
 assert.equal(result.speed_rpm,600);assert.equal(result.acceleration_rpm_s,20000);
});

test("direct Home measures both directions without native coordinate reset", async () => {
  for (const reverse of [false, true]) {
    const motor = new FakeConnection({native: true});
    motor.contacts = [-140563,23277];
    const context = make({motor, nativeHome:false});
    await context.transport.connect(); await context.transport.begin_home(reverse);
    const result = await advance(context);
    assert.equal(result.homed,true); assert.equal(result.stop_confirmed,true);
    assert.equal(result.measured_travel_raw,163840);
    assert.equal(result.position_normalized,.5);
    assert.ok(!motor.settings.some(([r,v])=>r===25 && v===1));
    await context.transport.close();
  }
});

function droppedReply() { return Object.assign(new TransportError("Response timeout"), {recoverableResponse:true}); }
test("one dropped status reply recovers without stopping or duplicating a target", async () => {
 const {transport,motor}=await running(); motor.onRead=()=>{motor.onRead=null;throw droppedReply();};
 await transport.command(.6); assert.equal(motor.destinations.length,1);
 assert.equal(transport.status().running,true); assert.equal(transport.status().communication_recoveries,1);
 await transport.stop(); await transport.close();
});
test("lost target acknowledgement uses fresh feedback and never retransmits target", async () => {
 const {transport,motor}=await running(); motor.onCommand=(_,op)=>{if(op==='absolute'){motor.onCommand=null;throw droppedReply();}};
 await transport.command(.6); assert.equal(motor.destinations.length,1); assert.equal(transport.status().running,true);
 await transport.stop(); await transport.close();
});
test("persistent dropped replies stop after three recovering target cycles", async () => {
 const {transport,motor}=await running(); motor.onCommand=(_,op)=>{if(op==='absolute')throw droppedReply();};
 await transport.command(.5);await transport.command(.5);
 await assert.rejects(transport.command(.5),/Communication remained unstable/);
 assert.equal(motor.destinations.length,3); assert.equal(transport.status().stop_confirmed,true);
 await transport.close();
});
test("lost inhibit acknowledgement can be confirmed by fresh stationary readbacks", async () => {
 const {transport,motor}=await running();motor.onCommand=(_,op)=>{if(op==='inhibit')throw droppedReply();};
 assert.equal((await transport.stop()).stop_confirmed,true);await transport.close();
});

test("reconnect inhibits a still-enabled drive without resuming or inheriting calibration", async () => {
 const {transport,motor}=make();motor.values[1]=1;await transport.connect();
 const result=await transport.recover_stop();assert.equal(result.stop_confirmed,true);
 assert.equal(result.output_enabled,false);assert.equal(result.homed,false);
 assert.deepEqual(motor.commands,['inhibit']);assert.deepEqual(motor.destinations,[]);await transport.close();
});

test("confirmed communication fault resets on the same connection without motion or losing rail bounds", async () => {
 const {transport,motor}=await running();transport._measured_endpoints=[15000,25000];
 motor.onCommand=(_,op)=>{if(op==='absolute')throw droppedReply();};
 await transport.command(.5);await transport.command(.5);await assert.rejects(transport.command(.5));
 motor.onCommand=null;const targets=motor.destinations.length;
 const result=await transport.reset_fault();assert.equal(result.fault,null);assert.equal(result.homed,true);
 assert.equal(result.armed,false);assert.equal(result.running,false);assert.equal(motor.destinations.length,targets);
 await transport.close();
});

test("disabled post-stop settling accepts 1mm but cannot accumulate unbounded drift", async () => {
 const {transport,motor}=await running();await transport.stop();const stopped=transport.status().position_raw;
 motor.position(stopped+200);assert.equal((await transport.snapshot()).stop_confirmed,true);
 motor.position(stopped+819);assert.equal((await transport.snapshot()).stop_confirmed,true);
 motor.position(stopped+821);await assert.rejects(transport.snapshot(),/position drift 821 counts/);
 await transport.close();
});
test("settling allowance never accepts enabled output, PWM or speed", async () => {
 for(const field of [1,19,16]) {
  const {transport,motor}=await running();await transport.stop();motor.values[field]=field===16?2:1;
  await assert.rejects(transport.snapshot());assert.equal(transport.status().stop_confirmed,false);await transport.close();
 }
});

test("stop verification survives one lost readback within its deadline",async()=>{
 const {transport,motor}=await running();motor.onRead=()=>{motor.onRead=null;throw droppedReply();};
 assert.equal((await transport.stop()).stop_confirmed,true);await transport.close();
});
test("explicit Stop can verify recovery after a failed cleanup",async()=>{
 const {transport,motor}=await running();motor.onRead=()=>new Uint8Array();
 await assert.rejects(transport.stop());assert.equal(transport.status().stop_confirmed,false);
 motor.onRead=null;const writes=motor.commands.length;
 assert.equal((await transport.stop()).stop_confirmed,true);assert.equal(motor.commands.length,writes+2);
 await transport.close();
});


test("stop allows delayed mechanical settling without resending motion", async () => {
  const { transport, motor, clock } = await running();
  const began = clock.now(); let inhibited = false;
  motor.onCommand = (_, operation) => { if (operation === "inhibit") inhibited = true; };
  motor.onRead = m => {
    if (!inhibited) return;
    m.values[19] = 0; m.remaining(0);
    m.values[16] = clock.now() - began < 2 ? 2 : 0;
  };
  const before = motor.commands.length;
  assert.equal((await transport.stop()).stop_confirmed, true);
  assert.ok(clock.now() - began >= 2);
  assert.ok(clock.now() - began <= 3.01);
  assert.deepEqual(motor.commands.slice(before), ["clear", "inhibit"]);
  await transport.close();
});


test("fast stream uses encoder replies and retains periodic full status checks", async () => {
 const {transport,motor,clock}=await running({fastPositions:true});
 const before=motor.readCount;
 await transport.command(.51); await clock.wait(.04); await transport.command(.52);
 assert.equal(motor.readCount,before);
 assert.ok(motor.transmissions.some(tx=>tx[1]===0x7b));
 await clock.wait(.1); await transport.command(.53);
 assert.equal(motor.readCount,before+1);
 motor.values[14]=1; await clock.wait(.11);
 await assert.rejects(transport.command(.54));
 assert.equal(transport.status().running,false); await transport.close();
});

test("stop accepts sub-tenth-millimetre disabled settling but rejects continuing drift",async()=>{
 const {transport,motor}=await running();let n=0;
 motor.onRead=m=>{m.position(20000+((n++%3)*35));};
 assert.equal((await transport.stop()).stop_confirmed,true);motor.onRead=null;await transport.close();
 const other=await running();n=0;
 other.motor.onRead=m=>{m.position(20000+(n++*50));};
 await assert.rejects(other.transport.stop(),/did not settle/);
 assert.equal(other.transport.status().stop_confirmed,false);other.motor.onRead=null;await other.transport.close();
});

test("a later confirmed Stop permits clearing a settling fault after fresh stationary checks",async()=>{
 const {transport,motor}=await running();let n=0;
 motor.onRead=m=>{m.position(20000+(n++*50));};
 await assert.rejects(transport.stop(),/did not settle/);
 motor.onRead=null;assert.equal((await transport.stop()).stop_confirmed,true);
 assert.match(transport.status().fault,/did not settle/);
 assert.equal((await transport.reset_fault()).fault,null);await transport.close();
});
