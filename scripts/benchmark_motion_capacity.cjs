// SPDX-License-Identifier: MPL-2.0
"use strict";

// Current-source, offline capacity benchmark. No serial, device, or servo model.
// The legacy engine is loaded from the reviewed source revision below. Neither
// engine simulates the drive's internal ramp, servo response, or encoder.
const {Engine} = require("../virtual_synth/static/browser-engine.js");
const {execFileSync} = require("node:child_process");
const path = require("node:path");
const baselineRevision = "dfc0b3781dafce221a8ecccac530227a559ee336";
const baselineSource = execFileSync("git", ["show", baselineRevision + ":virtual_synth/static/browser-engine.js"],
  {cwd:path.resolve(__dirname,".."),encoding:"utf8"});
const baseline = {exports:{}};
new Function("module","exports","globalThis",baselineSource)(baseline,baseline.exports,{});
const countsPerMm = 32768 / 40, travelMm = 181.57;
const homeInsetMm = 1638 / countsPerMm;
const spanMm = travelMm - 2 * homeInsetMm, windowMm = spanMm * .8;
const profiles = [
  {name:"ramped_host_1200", velocity:1080, acceleration:1200},
  {name:"streaming_host_6000", velocity:1080, acceleration:6000},
];
const patterns = [
  {shape:"sine", rate_hz:.25, stroke:.3},
  {shape:"sine", rate_hz:.5, stroke:.7},
  {shape:"sine", rate_hz:1.5, stroke:.7},
  {shape:"sine", rate_hz:2.5, stroke:.3},
  {shape:"sine", rate_hz:4, stroke:.7},
  {shape:"square", rate_hz:1.5, stroke:.7},
  {shape:"square", rate_hz:4, stroke:.7},
  {shape:"triangle", rate_hz:1.5, stroke:.7},
  {shape:"triangle", rate_hz:4, stroke:.7},
  {shape:"saw", rate_hz:1.5, stroke:.7},
  {shape:"saw", rate_hz:4, stroke:.7},
];
const grids = {uniform_50ms:[.05], irregular_20_75ms:[.020,.031,.075,.024,.049,.061,.037,.055]};
const minimumRestMoveTime = (distance, v, a) => distance <= v * v / a
  ? 2 * Math.sqrt(distance / a) : distance / v + v / a;

function capacity(profile, pattern, center = .5) {
  const centerStroke = pattern.stroke * 2 * Math.min(center, 1 - center);
  const distance = windowMm * centerStroke, amplitude = distance / 2;
  const sineRate = amplitude ? Math.min(profile.velocity / (2 * Math.PI * amplitude),
    Math.sqrt(profile.acceleration / amplitude) / (2 * Math.PI)) : null;
  const restTime = distance ? minimumRestMoveTime(distance, profile.velocity, profile.acceleration) : 0;
  const finiteRestTime = distance ? minimumRestMoveTime(distance, profile.velocity*.9, profile.acceleration*.9) : 0;
  return {
    requested_span_mm:distance, center_limited_stroke:centerStroke,
    sine_peak_velocity_mm_s:pattern.shape === "sine" ? 2 * Math.PI * pattern.rate_hz * amplitude : null,
    sine_peak_acceleration_mm_s2:pattern.shape === "sine" ? (2 * Math.PI * pattern.rate_hz) ** 2 * amplitude : null,
    max_sine_rate_hz:sineRate, minimum_rest_move_s:restTime,
    max_square_rate_hz:restTime ? 1 / (2 * restTime) : null,
    minimum_finite_reference_move_s:finiteRestTime,
    max_rounded_triangle_rate_hz:finiteRestTime ? 1 / (2 * finiteRestTime) : null,
    max_saw_with_flyback_rate_hz:finiteRestTime ? 1 / (2 * finiteRestTime) : null,
    // Exact triangle/saw/square corners have unbounded acceleration; these
    // numbers describe only their continuous segments, not feasible full waves.
    continuous_segment_velocity_mm_s:pattern.shape === "triangle" ? 2 * distance * pattern.rate_hz
      : pattern.shape === "saw" ? distance * pattern.rate_hz : null,
  };
}

function measure(profile, pattern, gridName, algorithm) {
  const params = {...pattern, center:.5, lower:.1, upper:.9};
  const engine = new (algorithm === "legacy_pursuit" ? baseline.exports.Engine : Engine)(params);
  engine.reset({vmax:profile.velocity/spanMm, amax:profile.acceleration/spanMm});
  const schedule = grids[gridName];
  let elapsed=0, index=0, count=0, requestedMin=Infinity, requestedMax=-Infinity;
  let commandMin=Infinity, commandMax=-Infinity, squaredError=0, plannedRate=null, peakVelocity=0;
  while (elapsed < 24) {
    const dt = Math.min(schedule[index++ % schedule.length], 24-elapsed); elapsed += dt;
    const signal=engine.step(dt,{running:true,tracking:true});
    let requested=signal.requested, command=signal.command, reference;
    if (algorithm === "legacy_pursuit") {
      reference=requested; plannedRate=pattern.rate_hz;
    } else {
      if (!Object.hasOwn(signal,"planned_rate_hz") || !Number.isFinite(signal.planned_reference)) {
        throw new Error("This benchmark requires the hardware finite-motion planned_reference API.");
      }
      plannedRate=signal.planned_rate_hz;
      reference=signal.planned_reference;
    }
    peakVelocity=Math.max(peakVelocity,Math.abs(signal.velocity)*spanMm);
    if(elapsed<=3)continue;
    requestedMin=Math.min(requestedMin,requested);requestedMax=Math.max(requestedMax,requested);
    commandMin=Math.min(commandMin,command);commandMax=Math.max(commandMax,command);
    squaredError+=((command-reference)*spanMm)**2;count++;
  }
  return {
    profile:profile.name, algorithm, cadence:gridName, shape:pattern.shape,
    requested_rate_hz:pattern.rate_hz, planned_rate_hz:plannedRate, stroke:pattern.stroke,
    requested_span_mm:(requestedMax-requestedMin)*spanMm,
    command_span_mm:(commandMax-commandMin)*spanMm,
    planned_reference_rms_mm:algorithm === "current_engine" && pattern.shape === "square" ? null : Math.sqrt(squaredError/count),
    endpoint_target_rms_mm:algorithm === "current_engine" && pattern.shape === "square" ? Math.sqrt(squaredError/count) : null,
    rms_reference_kind:algorithm === "legacy_pursuit" ? "ideal_requested_wave"
      : pattern.shape === "square" ? "endpoint_target_with_required_transit" : "finite_planned_reference",
    peak_sampled_velocity_mm_s:peakVelocity,
  };
}

const analytic = profiles.flatMap(profile => patterns.map(pattern => ({
  profile:profile.name, shape:pattern.shape, requested_rate_hz:pattern.rate_hz, stroke:pattern.stroke,
  ...capacity(profile,pattern),
})));
const results = profiles.flatMap(profile => patterns.flatMap(pattern => Object.keys(grids).flatMap(cadence =>
  ["legacy_pursuit","current_engine"].map(algorithm => measure(profile,pattern,cadence,algorithm)))));
const report = {
  assumptions:{offline:true, servo_model:false, travel_mm:travelMm, home_inset_each_mm:homeInsetMm,
    homed_span_mm:spanMm, usable_10_90_span_mm:windowMm, duration_s:24, discard_startup_s:3,
    baseline_revision:baselineRevision,
    finite_triangle_saw_reference_capture_reserve:.9,
    reserve_description:"finite reference uses 90% host velocity/acceleration; host output bounds stay at full budget",
    limits_are_host_limits:true, rms_reference:"baseline ideal requested wave; current finite planned_reference; square endpoint-target transit RMS is reported separately"},
  geometry:{center_50_stroke_70:capacity(profiles[1],{shape:"sine",rate_hz:1.5,stroke:.7}),
    center_8_stroke_62:capacity(profiles[1],{shape:"sine",rate_hz:1.08,stroke:.62},.08)},
  analytic, results,
};
if (process.argv.includes("--table")) {
  console.log("| Host profile | Algorithm | Shape | Requested Hz | Planned Hz | Request mm | Command mm | Reference RMS mm |");
  console.log("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for(const r of results.filter(r=>r.cadence==="irregular_20_75ms")) console.log(`| ${r.profile} | ${r.algorithm} | ${r.shape} | ${r.requested_rate_hz.toFixed(3)} | ${r.planned_rate_hz.toFixed(3)} | ${r.requested_span_mm.toFixed(2)} | ${r.command_span_mm.toFixed(2)} | ${r.planned_reference_rms_mm === null ? "n/a (endpoint move)" : r.planned_reference_rms_mm.toFixed(3)} |`);
} else console.log(JSON.stringify(report,null,2));
