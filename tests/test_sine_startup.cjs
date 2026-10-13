// SPDX-License-Identifier: MPL-2.0
// Local mathematical trajectories only: no browser, device, or network.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {Engine} = require("../virtual_synth/static/browser-engine.js");
const spanMm = 175.694580078125;
const wrap = phase => ((phase % 1) + 1) % 1;

function hardware(params = {}, position = .49951712302593637) {
  const engine = new Engine({shape:"sine", rate_hz:1.4985372650797282, stroke:.7, ...params});
  engine.reset({position, vmax:1080/spanMm, amax:6000/spanMm, jmax:100000/spanMm});
  return engine;
}
function boundedStep(engine, dt = .002, controls = {}) {
  const previous = engine.trajectory.pva(), trajectory = engine.trajectory;
  const signal = engine.step(dt, {running:true, tracking:true, ...controls});
  assert.ok(Math.abs(signal.velocity) <= trajectory.vmax + 1e-8, "host velocity limit remains active");
  assert.ok(Math.abs(signal.acceleration) <= trajectory.amax + 1e-8, "host acceleration limit remains active");
  assert.ok(Math.abs(signal.acceleration - previous.acceleration) <= trajectory.jmax * dt + 1e-8,
    "startup, capture and analytic joins retain finite jerk");
  assert.ok(signal.command >= trajectory.low - 1e-10 && signal.command <= trajectory.high + 1e-10);
  const stop = trajectory.braking();
  assert.ok(stop.minPosition >= trajectory.low - 1e-10 && stop.maxPosition <= trajectory.high + 1e-10,
    "complete analytic emergency stop remains inside the fixed rail corridor");
  return signal;
}
function advance(engine, duration, verify = null, controls = {}) {
  let elapsed = 0, signal;
  while (elapsed < duration - 1e-10) {
    const dt = Math.min(.002, duration - elapsed);
    signal = boundedStep(engine, dt, controls); elapsed += dt; verify?.(signal, elapsed, dt);
  }
  return signal;
}

test("stationary wide sine captures its full first reversal within waveform V/A/J", () => {
  const engine = hardware(), first = boundedStep(engine), capture = engine._startupReference;
  assert.equal(first.startup_transition, true);
  assert.ok(capture, "first stationary sine uses its explicit finite capture");
  const endpoint = capture.plan.sample(capture.plan.duration), duration = capture.plan.duration;
  const amplitude = .7 * .4, omega = 2 * Math.PI * first.planned_rate_hz;
  const limits = {velocity:amplitude * omega, acceleration:amplitude * omega ** 2, jerk:amplitude * omega ** 3};
  assert.ok(duration > .28 && duration < .31, "natural reversal alignment avoids a long catch-up delay");
  assert.ok(Math.abs(endpoint.position - .78) < 1e-10);
  assert.ok(Math.abs(endpoint.velocity) < 1e-10, "velocity is zero at the actual waveform reversal");
  assert.ok(Math.abs(endpoint.acceleration + limits.acceleration) < 1e-10,
    "the reversal carries its nonzero sine acceleration rather than resting there");
  let previous = first, maximumVelocity = Math.abs(first.velocity);
  const joined = advance(engine, duration - .002, (signal, _, dt) => {
    assert.ok(signal.command >= previous.command - 1e-10, "the entire first leg is monotonic");
    assert.ok(signal.velocity >= -1e-10, "there is no premature first reversal");
    assert.ok(Math.abs(signal.velocity) <= limits.velocity + 1e-8);
    assert.ok(Math.abs(signal.acceleration) <= limits.acceleration + 1e-8);
    assert.ok(Math.abs(signal.acceleration - previous.acceleration) <= limits.jerk * dt + 1e-8);
    assert.ok(Math.abs(signal.command - signal.planned_reference) < 1e-10,
      "startup readout describes the actual precomputed path");
    maximumVelocity = Math.max(maximumVelocity, Math.abs(signal.velocity)); previous = signal;
  });
  assert.equal(joined.startup_transition, false);
  assert.ok(Math.abs(joined.command - .78) < 1e-10, "first reversal reaches the full requested endpoint");
  assert.ok(Math.abs(joined.acceleration - endpoint.acceleration) < 1e-8);
  assert.ok(maximumVelocity * spanMm < 305, "startup avoids unnecessary catch-up speed");
  const next = boundedStep(engine);
  assert.ok(next.velocity < 0 && next.command < joined.command, "analytic sine immediately continues inward");
  advance(engine, .5 / first.planned_rate_hz - .002);
  assert.ok(Math.abs(engine.trajectory.position - .22) < 1e-10, "first complete stroke reaches the other full endpoint");
});

test("first reversal starts monotonically in either direction inside or outside the desired stroke", () => {
  for (const position of [.12, .4, .5, .6, .78, .88]) {
    const engine = hardware({}, position), first = boundedStep(engine);
    const direction = position <= .5 ? 1 : -1, endpoint = direction > 0 ? .78 : .22;
    const duration = engine._startupReference?.plan.duration;
    assert.ok(duration > 0, `stationary position ${position} has an admissible first reversal`);
    let previous = first.command;
    const joined = advance(engine, duration - .002, signal => {
      assert.ok(direction * (signal.command - previous) >= -1e-10, `monotonic capture from ${position}`);
      assert.ok(direction * signal.velocity >= -1e-10);
      previous = signal.command;
    });
    assert.ok(Math.abs(joined.command - endpoint) < 1e-10);
    assert.ok(direction * joined.acceleration < 0, "endpoint acceleration points into the stroke");
    assert.ok(Math.abs(joined.requested - joined.planned_reference) < 1e-10,
      "requested and planned phase readouts align at the first reversal");
  }
});

test("aligned startup preserves exact sustained rate, full stroke and requested readout", () => {
  for (const [rate_hz, stroke] of [[.25,.7], [1.4985372650797282,.7], [2.5,.3]]) {
    const engine = hardware({rate_hz, stroke});
    let minimum = Infinity, maximum = -Infinity;
    advance(engine, 8, (signal, elapsed) => {
      assert.equal(signal.planned_rate_hz, rate_hz); assert.equal(signal.rate_limited, false);
      if (elapsed < 3) return;
      assert.equal(signal.startup_transition, false);
      assert.equal(signal.limited, false, "startup phase alignment must not show permanent tracking error");
      assert.ok(Math.abs(signal.command - signal.requested) < 1e-10);
      assert.ok(Math.abs(signal.command - signal.planned_reference) < 1e-10);
      assert.ok(Math.abs(signal.velocity - signal.planned_reference_velocity) < 1e-10);
      assert.ok(Math.abs(signal.acceleration - signal.planned_reference_acceleration) < 1e-10);
      assert.ok(Math.abs(signal.phase - signal.reference_phase) < 1e-10);
      minimum = Math.min(minimum, signal.command); maximum = Math.max(maximum, signal.command);
    });
    assert.ok(maximum - minimum > stroke * .8 * .9998, "steady samples keep the full stroke within their finite phase resolution");
    const requestedPhase = engine.phase, plannedPhase = engine.reference_phase;
    boundedStep(engine, .137);
    assert.ok(Math.abs(engine.phase - wrap(requestedPhase + rate_hz * .137)) < 1e-10);
    assert.ok(Math.abs(engine.reference_phase - wrap(plannedPhase + rate_hz * .137)) < 1e-10);
  }
});

test("direct, ongoing LFO, evolving envelope and nonstationary starts retain ordinary moving-state capture", () => {
  for (const [params, controls] of [
    [{patches:[{source:"lfo", target:"position", depth:.4}]}, {}],
    [{patches:[{source:"lfo", target:"stroke", depth:.2}]}, {}],
    [{env_to_stroke:true}, {gate:true}],
    [{patches:[{source:"envelope", target:"rate", depth:.2}]}, {gate:true}],
  ]) {
    const engine = hardware(params);
    advance(engine, .2, signal => assert.equal(signal.startup_transition, false), controls);
  }
  const engine = hardware();
  engine.trajectory.velocity = .1; engine.trajectory.acceleration = .2;
  assert.equal(boundedStep(engine).startup_transition, false);
  assert.equal(engine._startupReference, null);
});

test("pause and resume preserve aligned phase and recapture from stationary feedback", () => {
  for (const pauseAfter of [.05, 3]) {
    const engine = hardware(); advance(engine, pauseAfter);
    const phase = engine.phase, referencePhase = engine.reference_phase, position = engine.trajectory.position;
    engine.step(0, {running:false, tracking:true}); // Confirmed hardware stop supplies stationary feedback.
    engine.trajectory.reset(position + .0001);
    assert.equal(engine._startupReference, null);
    assert.equal(engine.phase, phase); assert.equal(engine.reference_phase, referencePhase);
    const resumed = boundedStep(engine);
    assert.equal(resumed.startup_transition, false, "resume does not rerun or reanchor the first-start profile");
    assert.ok(Math.abs(resumed.phase - wrap(phase + engine.params.rate_hz * .002)) < 1e-10);
    advance(engine, 3);
    assert.ok(Math.abs(engine.trajectory.command - engine.trajectory.trackingTarget) < 1e-10);
    engine.reset({position:.5});
    assert.equal(boundedStep(engine).startup_transition, true, "a fresh hardware arm starts a new aligned profile");
  }
});

test("zero-duration running steps cannot consume or advance the first startup capture", () => {
  const engine = hardware(), stationary = engine.trajectory.pva();
  for (let index = 0; index < 3; index++) {
    assert.equal(boundedStep(engine, 0).startup_transition, false);
    assert.deepEqual(engine.trajectory.pva(), stationary);
    assert.equal(engine.phase, 0); assert.equal(engine.reference_phase, 0);
  }
  assert.equal(boundedStep(engine).startup_transition, true);
  assert.ok(engine.trajectory._capture, "the first positive-duration update claims the explicit Ruckig plan");
  const current = engine.trajectory.pva(), phase = engine.phase, elapsed = engine._startupReference.elapsed;
  assert.equal(boundedStep(engine, 0).startup_transition, true);
  assert.deepEqual(engine.trajectory.pva(), current);
  assert.equal(engine.phase, phase); assert.equal(engine._startupReference.elapsed, elapsed);
  advance(engine, .5);
  assert.equal(engine._startupReference, null);
});

test("parameter changes during initial capture retain bounded PVA and discard its obsolete reference", () => {
  const engine = hardware(); advance(engine, .05);
  const previous = engine.trajectory.pva();
  engine.configure({rate_hz:1.2, stroke:.3, center:.65});
  assert.deepEqual(engine.trajectory.pva(), previous, "configuration does not reset active commanded PVA");
  assert.equal(engine._startupReference, null);
  advance(engine, 3);
  assert.ok(Math.abs(engine.trajectory.command - engine.trajectory.trackingTarget) < 1e-10);
});

for (const destination of ["rate", "stroke", "center", "env_to_stroke"]) {
  test(`Gate modulation of ${destination} immediately replaces an unfinished fixed startup reference`, () => {
    const envelopeStroke = destination === "env_to_stroke";
    const params = {attack_s:.8, release_s:.8, ...(envelopeStroke ? {env_to_stroke:true}
      : {patches:[{source:"envelope", target:destination, depth:.4}]})};
    const engine = hardware(params), held = hardware(params);
    if (envelopeStroke) engine.envelope = held.envelope = 1;
    const initialGate = envelopeStroke;
    advance(engine, .04, null, {gate:initialGate}); advance(held, .04, null, {gate:initialGate});
    assert.ok(engine._startupReference && held._startupReference,
      "the held envelope begins with an unfinished fixed sine startup");
    const previous = engine.trajectory.pva(), phase = engine.phase, referencePhase = engine.reference_phase;
    const switched = boundedStep(engine, 0, {gate:!initialGate});
    assert.equal(switched.startup_transition, false, "Gate invalidates the fixed startup even at zero elapsed time");
    assert.equal(engine._startupReference, null);
    assert.deepEqual(engine.trajectory.pva(), previous, "Gate preserves the active commanded PVA");
    assert.equal(engine.phase, phase); assert.equal(engine.reference_phase, referencePhase);
    let difference = 0;
    advance(engine, .12, signal => {
      const old = boundedStep(held, .002, {gate:initialGate});
      const midpoint = .1 + signal.effective_center * .8;
      const amplitude = signal.effective_stroke * Math.min(midpoint - .1, .9 - midpoint);
      const expected = midpoint + amplitude * Math.sin(2 * Math.PI * signal.reference_phase);
      assert.equal(signal.startup_transition, false);
      assert.ok(Math.abs(signal.planned_reference - expected) < 1e-10,
        "the planned reference uses the evolving envelope geometry immediately");
      difference = Math.max(difference, Math.abs(signal.planned_reference - old.planned_reference));
    }, {gate:!initialGate});
    assert.ok(difference > .001, "Gate changes the requested path before the obsolete startup could finish");
    advance(engine, 3, null, {gate:!initialGate});
    assert.ok(Math.abs(engine.trajectory.command - engine.trajectory.trackingTarget) < 1e-10,
      "after the envelope settles, ordinary exact following resumes");
  });
}
