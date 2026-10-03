// SPDX-License-Identifier: MPL-2.0
"use strict";

// Offline waveform/planner metrics only. No serial access or mechanical model.
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");
const {Engine} = require("../virtual_synth/static/browser-engine.js");
const SPAN_MM = 179.7;
const INTERVALS = [.0215, .020, .025, .019, .0748, .020, .022, .020, .0641, .0215];
const rounded = value => Math.round(value * 1e6) / 1e6;

function measure(EngineClass) { return [[1.5, .7], [2.5, .3]].map(([rate_hz, stroke]) => {
  const engine = new EngineClass({rate_hz, stroke});
  engine.reset({position: .5, vmax: 1080 / SPAN_MM, amax: 6000 / SPAN_MM});
  let elapsed = 0, index = 0, requestedLow = 1, requestedHigh = 0, commandLow = 1, commandHigh = 0;
  let squaredError = 0, sampleCount = 0, maximumError = 0, previousVelocity = 0;
  while (elapsed < 16) {
    const dt = INTERVALS[index++ % INTERVALS.length];
    elapsed += dt;
    const signal = engine.step(dt, {running: true, tracking: true});
    assert.ok(signal.command >= .1 && signal.command <= .9);
    assert.ok(Math.abs(signal.velocity) <= engine.trajectory.vmax + 1e-9);
    assert.ok(Math.abs(signal.velocity - previousVelocity) <= engine.trajectory.amax * dt + 1e-8);
    const stopping = signal.command + signal.velocity * Math.abs(signal.velocity) / (2 * engine.trajectory.amax);
    assert.ok(stopping >= .1 - 1e-9 && stopping <= .9 + 1e-9);
    previousVelocity = signal.velocity;
    if (elapsed < 3) continue;
    requestedLow = Math.min(requestedLow, signal.requested); requestedHigh = Math.max(requestedHigh, signal.requested);
    commandLow = Math.min(commandLow, signal.command); commandHigh = Math.max(commandHigh, signal.command);
    const error = (signal.command - signal.requested) * SPAN_MM;
    squaredError += error ** 2; maximumError = Math.max(maximumError, Math.abs(error)); sampleCount++;
  }
  return {rate_hz, stroke, requested_span_mm: rounded((requestedHigh - requestedLow) * SPAN_MM),
    command_span_mm: rounded((commandHigh - commandLow) * SPAN_MM),
    tracking_rms_mm: rounded(Math.sqrt(squaredError / sampleCount)), tracking_max_error_mm: rounded(maximumError),
    bounds_velocity_acceleration_stopping_checks_passed: true};
}); }

let baseline = null;
if (process.argv.length > 2) {
  assert.equal(process.argv.length, 4, "usage: node scripts/benchmark_tracking.cjs [--baseline COMMIT]");
  assert.equal(process.argv[2], "--baseline");
  assert.match(process.argv[3], /^[a-f0-9]{7,40}$/, "baseline must be a commit hash");
  const source = execFileSync("git", ["show", `${process.argv[3]}:virtual_synth/static/browser-engine.js`],
    {cwd: path.resolve(__dirname, ".."), encoding: "utf8"});
  const context = {module: {exports: {}}};
  // The trusted repository version must share this realm's object prototypes
  // because the engine deliberately refuses foreign/coerced parameter objects.
  Function("module", "exports", source)(context.module, context.module.exports);
  baseline = {commit: process.argv[3], result: measure(context.module.exports.Engine)};
}
const result = measure(Engine);

console.log(JSON.stringify({model: {physical_test: false, normalized_span_mm: SPAN_MM,
  velocity_limit_mm_s: 1080, acceleration_limit_mm_s2: 6000, duration_s: 16, settling_excluded_s: 3,
  update_intervals_ms: INTERVALS.map(dt => rounded(dt * 1000)), servo_dynamics_modeled: false}, baseline, result}, null, 2));
