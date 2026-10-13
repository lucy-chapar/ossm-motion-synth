// SPDX-License-Identifier: MPL-2.0
"use strict";

// Offline timing model: no browser, serial port, device, or test suite is opened.
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
const {createRuntime} = require("../virtual_synth/static/browser-runtime.js");
const {MotorTransport} = require("../virtual_synth/static/web-serial-transport.js");
const {frame} = require("../virtual_synth/static/web-serial-io.js");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const BAUD = option("--baud", 19200), ADAPTER_MS = option("--adapter-ms", 10);
const JITTER_MS = option("--jitter-ms", 0), TARGETS = option("--targets", 1000);
const NATIVE_SPIKE_MS = option("--native-spike-ms", 0), NATIVE_SPIKE_EVERY = option("--native-spike-every", 97);
const baselineIndex = process.argv.indexOf("--baseline-guards");
const baselineGuards = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
if (baselineGuards !== null) {
  assert.match(baselineGuards, /^[a-f0-9]{7,40}$/, "baseline guards must be a commit hash");
  const source = execFileSync("git", ["show", `${baselineGuards}:virtual_synth/static/web-serial-transport.js`],
    {cwd:path.resolve(__dirname,".."),encoding:"utf8"});
  const baseline = {exports:{}};
  Function("require","module","exports",source)(name => {
    assert.equal(name,"./web-serial-io.js"); return require("../virtual_synth/static/web-serial-io.js");
  },baseline,baseline.exports);
  // Only substitute the trusted, retained guard policy. Engine, runtime,
  // frames, adapter model and all actual-write assertions stay current.
  MotorTransport.prototype._read_stream_guards = baseline.exports.MotorTransport.prototype._read_stream_guards;
}
assert.ok([19200,38400,115200].includes(BAUD), "Use --baud 19200, 38400, or 115200");
assert.ok(Number.isFinite(ADAPTER_MS) && ADAPTER_MS >= 0 && ADAPTER_MS <= 100);
assert.ok(Number.isFinite(JITTER_MS) && JITTER_MS >= 0 && JITTER_MS <= 50);
assert.ok(Number.isFinite(NATIVE_SPIKE_MS) && NATIVE_SPIKE_MS >= 0 && NATIVE_SPIKE_MS <= 75);
assert.ok(Number.isInteger(NATIVE_SPIKE_EVERY) && NATIVE_SPIKE_EVERY >= 2);
assert.ok(Number.isInteger(TARGETS) && TARGETS >= 10 && TARGETS <= 100000);
const rounded = value => Math.round(value * 1e6) / 1e6;
const percentile = (sorted, fraction) => rounded(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);

class ModelDrive {
  constructor(clock) {
    this.clock = clock; this.values = Array(26).fill(0);
    this.values[0] = 1; this.values[2] = 1800; this.values[3] = 50000;
    this.values[11] = 800; this.values[21] = 1; this.position(200000);
    this.targetTimes = []; this.statusReads = this.fullReads = 0;
    this.statusGroups = [0,0,0,0]; this.maximumGuardAge = 0; this.wireBytes = 0;
    this.maximumGuardBatch = this.guardBatch = 0; this.lastFunction = null;
    this.active = this.maximumActive = this.exchanges = this.nativeCount = 0;
  }
  position(value) { this.values[22] = value & 65535; this.values[23] = value >>> 16 & 65535; }
  async open() {}
  async close() {}
  async exchange(tx, timeout, beforeWrite) {
    this.maximumActive = Math.max(this.maximumActive, ++this.active);
    try {
      // Match production healthy framing: 2 ms from the preceding reply for
      // ordinary traffic/transitions, zero additional delay for FC7b pairs.
      const gap = tx[1] === 0x7b && this.lastFunction === 0x7b ? 0 : .002;
      this.clock.elapsed += gap;
      if (tx[1] === 0x7b && ++this.nativeCount % NATIVE_SPIKE_EVERY === 0) this.clock.elapsed += NATIVE_SPIKE_MS / 1000;
      tx = beforeWrite?.() ?? tx;
      let reply;
      if (tx[1] === 3) {
        const start = tx[2] << 8 | tx[3], count = tx[4] << 8 | tx[5];
        this.guardBatch++;
        if (count === 26) this.fullReads++;
        else { this.statusReads++; this.statusGroups[[0,7,14,21].indexOf(start)]++; }
        reply = frame([1,3,count * 2,...this.values.slice(start,start + count).flatMap(value => [value >>> 8,value & 255])]);
      } else if (tx[1] === 0x7b) {
        const age = Math.max(...this.transport._status_group_at.map(at => this.clock.now() - at));
        assert.ok(age <= .25, `every actual write requires fresh guards: ${age}s`);
        this.maximumGuardAge = Math.max(this.maximumGuardAge, age);
        this.maximumGuardBatch = Math.max(this.maximumGuardBatch, this.guardBatch); this.guardBatch = 0;
        this.targetTimes.push(this.clock.now());
        const actual = this.values[22] | this.values[23] << 16;
        reply = frame([1,0x7b,actual >>> 8 & 255,actual & 255,actual >>> 24 & 255,actual >>> 16 & 255]);
        // Instant following isolates serial timing; no mechanical inference.
        this.position(tx[2] << 24 | tx[3] << 16 | tx[4] << 8 | tx[5]);
      } else if (tx[1] === 6 && tx[3] === 1) {
        this.values[1] = tx[5]; reply = frame([...tx.slice(0,4),0,this.values[1]]);
      } else if (tx[1] === 16 && tx[3] === 12) {
        this.values[12] = this.values[13] = this.values[19] = 0; reply = frame(tx.slice(0,6));
      } else throw new Error("Unexpected request in offline serial model.");
      // Deterministic bounded adapter jitter, repeated every 17 exchanges.
      const jitter = JITTER_MS * ((this.exchanges++ * 7) % 17) / 16;
      const elapsed = (ADAPTER_MS + jitter) / 1000 + (tx.length + reply.length) * 10 / BAUD;
      this.wireBytes += tx.length + reply.length;
      assert.ok(elapsed < timeout, "modeled exchange must fit the transport timeout");
      this.clock.elapsed += elapsed; this.lastFunction = tx[1];
      return reply;
    } finally { this.active--; }
  }
}

async function main() {
  const clock = {elapsed:0, now(){return this.elapsed;}, async wait(seconds){this.elapsed += seconds;}};
  const drive = new ModelDrive(clock), port = {getInfo: () => ({usbVendorId:1,usbProductId:2})};
  const transport = new MotorTransport(port,{allowMotion:true,fastPositions:true,baudRate:BAUD,motionProfile:"servo_ramped",
    connectionFactory: () => drive,clock: () => clock.now(),wait: seconds => clock.wait(seconds)});
  drive.transport = transport;
  const runtime = createRuntime({serial:{requestPort:async () => port,getPorts:async () => [port]},
    clock: () => clock.now(),autoStart:false,storage:null,transportFactory: () => transport});
  const action = (name, details={}) => runtime.request("/api/action",{action:name,...details});
  try {
    await action("connect",{port:await runtime.choosePort()});
    // Calibrated model rail only; Home and servo dynamics are not simulated.
    transport._homed = true; transport._origin = 200000; transport._low = 126000; transport._high = 274000;
    await action("play");
    const began = clock.now(), cpuBegan = performance.now(), initialStatus = drive.statusReads, initialFull = drive.fullReads;
    const initialWireBytes = drive.wireBytes;
    drive.guardBatch = 0;
    let heartbeatAt = began;
    for (let index = 0; index < TARGETS; index++) {
      if (clock.now() - heartbeatAt >= .25) { await action("heartbeat"); heartbeatAt = clock.now(); }
      await runtime.tick();
      assert.equal(drive.targetTimes.length,index + 1,"one new target per completion; no fixed scheduler delay or catch-up backlog");
      assert.equal(transport.status().fault,null);
    }
    const elapsed = clock.now() - began, cpuMs = performance.now() - cpuBegan;
    const intervals = drive.targetTimes.slice(1).map((time,index) => (time - drive.targetTimes[index]) * 1000).sort((a,b) => a - b);
    console.log(JSON.stringify({model:{physical_test:false,baud:BAUD,bits_per_byte:10,
      ordinary_or_transition_gap_ms:2,contiguous_fc7b_gap_ms:0,adapter_ms_per_exchange:ADAPTER_MS,
      bounded_adapter_jitter_ms:JITTER_MS,native_write_spike_ms:NATIVE_SPIKE_MS,native_write_spike_every:NATIVE_SPIKE_EVERY,scheduler_extra_wait_ms:0,browser_timer_jitter_modeled:false,servo_dynamics_modeled:false,
      baseline_guard_commit:baselineGuards,guard_policy:baselineGuards ? "retained baseline" : BAUD === 115200 ? "atomic100ms" : "staggered partials"},
      result:{targets:drive.targetTimes.length,targets_per_second:rounded(TARGETS / elapsed),
        total_wire_bytes:drive.wireBytes - initialWireBytes,wire_occupancy_fraction:rounded((drive.wireBytes - initialWireBytes) * 10 / BAUD / elapsed),
        streamed_status_reads:drive.statusReads - initialStatus,streamed_full_reads:drive.fullReads - initialFull,
        guard_group_reads:drive.statusGroups,maximum_guard_reads_per_target:drive.maximumGuardBatch,
        interval_min_ms:percentile(intervals,0),interval_median_ms:percentile(intervals,.5),interval_p95_ms:percentile(intervals,.95),
        interval_p99_ms:percentile(intervals,.99),interval_max_ms:percentile(intervals,1),
        maximum_guard_age_at_write_ms:rounded(drive.maximumGuardAge * 1000),maximum_inflight:drive.maximumActive,
        cpu_ms_per_target:rounded(cpuMs / TARGETS),fault:runtime.state().fault}},null,2));
  } finally { await runtime.close(); }
}
main().catch(error => {console.error(error.message);process.exitCode = 1;});
