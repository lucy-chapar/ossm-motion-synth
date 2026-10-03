// SPDX-License-Identifier: MPL-2.0
"use strict";

// Offline serial timing model. No browser, port, device or test suite is opened.
const assert = require("node:assert/strict");
const {createRuntime} = require("../virtual_synth/static/browser-runtime.js");
const {MotorTransport} = require("../virtual_synth/static/web-serial-transport.js");
const {frame} = require("../virtual_synth/static/web-serial-io.js");

const baudIndex = process.argv.indexOf("--baud");
const BAUD = baudIndex < 0 ? 19200 : Number(process.argv[baudIndex + 1]);
if (![19200, 38400, 115200].includes(BAUD)) throw new Error("Use --baud 19200, 38400, or 115200");
const QUIET_SECONDS = .003, ADAPTER_SECONDS = .010, PERIOD = BAUD === 115200 ? .025 : .05;
const rounded = value => Math.round(value * 1e6) / 1e6;

class ModelDrive {
  constructor(clock) {
    this.clock = clock;
    this.values = Array(26).fill(0);
    this.values[0] = 1; this.values[2] = 1800; this.values[3] = 60098;
    this.values[11] = 800; this.values[21] = 1;
    this.position(200000);
    this.targetTimes = [];
  }
  position(value) { this.values[22] = value & 65535; this.values[23] = value >>> 16 & 65535; }
  async open() {}
  async close() {}
  async exchange(tx, timeout, beforeWrite) {
    this.clock.elapsed += QUIET_SECONDS;
    beforeWrite?.();
    let reply;
    if (tx[1] === 3) {
      const start = tx[2] << 8 | tx[3], count = tx[4] << 8 | tx[5];
      reply = frame([1, 3, count * 2, ...this.values.slice(start, start + count).flatMap(value => [value >>> 8, value & 255])]);
    } else if (tx[1] === 0x7b) {
      this.targetTimes.push(this.clock.elapsed);
      const actual = this.values[22] | this.values[23] << 16;
      reply = frame([1, 0x7b, actual >>> 8 & 255, actual & 255, actual >>> 24 & 255, actual >>> 16 & 255]);
      // Instant target following is intentional: this models serial cadence,
      // without inferring mechanical performance or servo dynamics.
      this.position(tx[2] << 24 | tx[3] << 16 | tx[4] << 8 | tx[5]);
    } else if (tx[1] === 6 && tx[3] === 1) {
      this.values[1] = tx[5];
      reply = frame([...tx.slice(0, 4), 0, this.values[1]]);
    } else if (tx[1] === 16 && tx[3] === 12) {
      this.values[12] = this.values[13] = this.values[19] = 0;
      reply = frame(tx.slice(0, 6));
    } else throw new Error("Unexpected request in offline serial model.");
    const elapsed = ADAPTER_SECONDS + (tx.length + reply.length) * 10 / BAUD;
    assert.ok(elapsed < timeout, "model transaction must fit the actual transport timeout");
    this.clock.elapsed += elapsed;
    return reply;
  }
}

async function main() {
  const clock = {elapsed: 0, now() { return this.elapsed; }, async wait(seconds) { this.elapsed += seconds; }};
  const motor = new ModelDrive(clock), port = {getInfo: () => ({usbVendorId: 1, usbProductId: 2})};
  const transport = new MotorTransport(port, {allowMotion: true, fastPositions: true, baudRate: BAUD,
    connectionFactory: () => motor, clock: () => clock.now(), wait: seconds => clock.wait(seconds)});
  const runtime = createRuntime({serial: {requestPort: async () => port, getPorts: async () => [port]},
    clock: () => clock.now(), autoStart: false, storage: null, transportFactory: () => transport});
  const action = (name, details = {}) => runtime.request("/api/action", {action: name, ...details});
  try {
    await action("connect", {port: await runtime.choosePort()});
    // Seed a calibrated model rail; the benchmark does not simulate Home.
    transport._homed = true; transport._origin = 200000; transport._low = 126000; transport._high = 274000;
    await action("play");
    const began = clock.now();
    let oldestStatus = 0;
    for (let index = 0; index < 200; index++) {
      clock.elapsed = Math.max(clock.elapsed, began + (index + 1) * PERIOD);
      await action("heartbeat"); await runtime.tick();
      assert.equal(runtime.state().fault, null);
      oldestStatus = Math.max(oldestStatus, transport.status().status_check_age_s);
    }
    const intervals = motor.targetTimes.slice(1).map((time, index) => (time - motor.targetTimes[index]) * 1000).sort((a, b) => a - b);
    console.log(JSON.stringify({model: {physical_test: false, baud: BAUD, bits_per_byte: 10,
      quiet_gap_ms: QUIET_SECONDS * 1000, adapter_overhead_ms_per_exchange: ADAPTER_SECONDS * 1000,
      cycle_ms: PERIOD * 1000, browser_timer_jitter_modeled: false, servo_dynamics_modeled: false},
      result: {targets: motor.targetTimes.length, interval_min_ms: rounded(intervals[0]),
        interval_median_ms: rounded(intervals[Math.floor(intervals.length * .5)]),
        interval_p95_ms: rounded(intervals[Math.floor(intervals.length * .95)]),
        interval_max_ms: rounded(intervals.at(-1)), oldest_guard_age_ms: rounded(oldestStatus * 1000), fault: null}}, null, 2));
  } finally { await runtime.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
