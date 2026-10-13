// SPDX-License-Identifier: MPL-2.0
// Local WASM and mathematical trajectories only; no device, browser or network.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {Engine, Trajectory, ready, motionReady} = require("../virtual_synth/static/browser-engine.js");
const spanMm = 181.57 - 2 * 1638 / (32768 / 40);
const irregular = [.020, .031, .075, .024, .049, .061, .037, .055];

function hardware(params) {
  const engine = new Engine(params);
  engine.reset({vmax: 1080 / spanMm, amax: 6000 / spanMm, jmax: 100000 / spanMm});
  return engine;
}
function checkState(trajectory, previous, dt) {
  const state = trajectory.pva();
  assert.ok(Object.values(state).every(Number.isFinite));
  assert.ok(Math.abs(state.velocity) <= trajectory.vmax + 1e-8, "velocity bound");
  assert.ok(Math.abs(state.acceleration) <= trajectory.amax + 1e-8, "acceleration bound");
  assert.ok(Math.abs(state.acceleration - previous.acceleration) <= trajectory.jmax * dt + 1e-8, "persistent acceleration and jerk bound");
  assert.ok(state.position >= trajectory.low - 1e-10 && state.position <= trajectory.high + 1e-10, "rail position bound");
  const stop = trajectory.braking();
  assert.ok(stop.minPosition >= trajectory.low - 1e-10 && stop.maxPosition <= trajectory.high + 1e-10, "complete jerk-aware stop extrema fit");
  return state;
}

test("local continuous core is ready synchronously in Node and jerk scaling survives reset", async () => {
  await ready; assert.equal(motionReady(), true);
  const engine = hardware({}); const jerk = engine.trajectory.jmax;
  engine.reset({position: .6}); assert.equal(engine.trajectory.jmax, jerk);
  assert.equal(engine.trajectory.velocity, 0); assert.equal(engine.trajectory.acceleration, 0);
  assert.throws(() => engine.reset({jmax: 0}));
});

test("compatible intermediate points carry nonzero velocity and acceleration", () => {
  const trajectory = new Trajectory({low:.1, high:.9, position:.2, vmax:1, amax:4, jmax:20});
  let time = 0, crossings = 0, prior = trajectory.pva();
  for (let i = 0; i < 750; i++) {
    const dt = .002; time += dt;
    const sample = offset => { const t = time + offset; return {position:.2 + .2 * t + .05 * t * t, velocity:.2 + .1 * t, acceleration:.1}; };
    trajectory.follow({sample}, dt, null, "compatible-waypoints", true);
    const next = checkState(trajectory, prior, dt);
    for (const waypoint of [.3, .4, .5]) if (prior.position < waypoint && next.position >= waypoint) {
      assert.ok(next.velocity > .2, "a passing waypoint is not a zero-velocity endpoint");
      assert.ok(Math.abs(next.acceleration) > .09, "passing acceleration is retained"); crossings++;
    }
    prior = next;
  }
  assert.equal(crossings, 3);
});

test("fixed sine capture removes premature reversals and follows full continuous PVA", () => {
  const engine = hardware({shape:"sine", rate_hz:1.5, stroke:.7});
  engine.trajectory.update = () => assert.fail("a moving sine sample must not use the rest-point fallback");
  let prior = engine.trajectory.pva(), sign = 0, turns = 0, minimum = Infinity, maximum = -Infinity, error2 = 0, n = 0;
  for (let i = 1; i <= 3500; i++) {
    const signal = engine.step(.002, {running:true, tracking:true});
    const next = checkState(engine.trajectory, prior, .002); prior = next;
    if (i * .002 > 3) {
      const direction = Math.sign(next.velocity);
      if (direction) { if (sign && direction !== sign) turns++; sign = direction; }
      minimum = Math.min(minimum, signal.command); maximum = Math.max(maximum, signal.command);
      error2 += ((signal.command - signal.planned_reference) * spanMm) ** 2; n++;
      assert.ok(Math.abs(signal.velocity - signal.planned_reference_velocity) * spanMm < .01);
      assert.ok(Math.abs(signal.acceleration - signal.planned_reference_acceleration) * spanMm < .01);
    }
  }
  assert.equal(turns, 12, "exactly two physical reversals per cycle, with no fallback chatter");
  assert.ok((maximum - minimum) * spanMm > .7 * .8 * spanMm * .999);
  assert.ok(Math.sqrt(error2 / n) < .01);
});

test("feasible high-rate sines preserve their rate under physical jerk limits", () => {
  for (const [rate_hz, stroke] of [[1.5,.7], [2.5,.3]]) {
    const engine = hardware({shape:"sine", rate_hz, stroke});
    let prior = engine.trajectory.pva(), signal;
    for (let i = 0; i < 2000; i++) {
      signal = engine.step(.002, {running:true, tracking:true}); prior = checkState(engine.trajectory, prior, .002);
    }
    assert.equal(signal.planned_rate_hz, rate_hz); assert.equal(signal.rate_limited, false);
  }
});

test("finite triangle saw and square joins keep acceleration continuous and full stroke", () => {
  for (const shape of ["triangle", "saw", "square"]) {
    const engine = hardware({shape, rate_hz:1.5, stroke:.7});
    engine.trajectory.update = () => assert.fail("finite hardware legs use persistent Ruckig PVA");
    let prior = engine.trajectory.pva(), previousReferenceA = null, minimum = Infinity, maximum = -Infinity;
    for (let i = 1; i <= 4000; i++) {
      const signal = engine.step(.002, {running:true, tracking:true}); prior = checkState(engine.trajectory, prior, .002);
      if (previousReferenceA !== null) assert.ok(Math.abs(signal.planned_reference_acceleration - previousReferenceA) <= engine.trajectory.jmax * .002 + 1e-8, "reference acceleration at every leg join");
      previousReferenceA = signal.planned_reference_acceleration;
      if (i * .002 > 3) { minimum = Math.min(minimum, signal.command); maximum = Math.max(maximum, signal.command); }
    }
    assert.ok((maximum - minimum) * spanMm > .7 * .8 * spanMm * .999, shape + " full stroke");
  }
});

test("irregular serial-sized steps and parameter changes retain bounded PVA", () => {
  for (const shape of ["sine", "triangle", "saw", "square"]) {
    const engine = hardware({shape, rate_hz:1, stroke:.5}); let prior = engine.trajectory.pva();
    for (let i = 0; i < 140; i++) {
      if (i === 50) engine.configure({stroke:.3, center:.65, rate_hz:1.5});
      const dt = irregular[i % irregular.length]; engine.step(dt, {running:true, tracking:true});
      prior = checkState(engine.trajectory, prior, dt);
    }
  }
});

test("a jerk-aware boundary fence rejects outward acceleration that the old braking formula accepts", () => {
  const trajectory = new Trajectory({low:.1, high:.9, position:.88, vmax:1, amax:4, jmax:10});
  trajectory.velocity = .1; trajectory.acceleration = 3; trajectory._continuous = true;
  assert.ok(trajectory.position + trajectory.velocity ** 2 / (2 * trajectory.amax) < .9);
  assert.throws(() => trajectory.configure_bounds(.1, .9), /stopping point/);
  const previous = trajectory.pva();
  assert.throws(() => trajectory.follow({sample: () => ({position:.89, velocity:0, acceleration:0})}, .002, null, "unsafe"), /stopping trajectory/);
  assert.deepEqual(trajectory.pva(), previous, "fail closed without erasing velocity or acceleration");
});

test("an unreachable future state fails closed instead of returning perpetual zero-velocity holds", () => {
  const trajectory = new Trajectory({low:.1, high:.9, position:.5, vmax:1, amax:4, jmax:20});
  const before = trajectory.pva();
  assert.throws(() => trajectory.follow({sample: () => ({position:.6, velocity:100, acceleration:0})}, .002,
    null, "unreachable-state", true), /No jerk-safe continuous capture/);
  assert.deepEqual(trajectory.pva(), before);
});
