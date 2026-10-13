// SPDX-License-Identifier: MPL-2.0
// Mathematical trajectories only: no browser, network, or serial device.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {Engine} = require("../virtual_synth/static/browser-engine.js");
const spanMm = 179.7 - 2 * 1638 / (32768 / 40);

function hardware(params) {
  const engine = new Engine({shape:"sine", rate_hz:1, stroke:.4,
    attack_s:.12, release_s:.24, ...params});
  engine.reset({vmax:1080/spanMm, amax:6000/spanMm, jmax:100000/spanMm});
  return engine;
}
function advance(engine, seconds, gate, verify = null) {
  const dt = .002;
  let signal;
  for (let index = 0; index < Math.round(seconds / dt); index++) {
    const previous = engine.trajectory.pva();
    signal = engine.step(dt, {running:true, tracking:true, gate});
    const next = engine.trajectory.pva(), trajectory = engine.trajectory;
    assert.ok(Math.abs(next.velocity) <= trajectory.vmax + 1e-8, "retained velocity limit");
    assert.ok(Math.abs(next.acceleration) <= trajectory.amax + 1e-8, "retained acceleration limit");
    assert.ok(Math.abs(next.acceleration - previous.acceleration) <= trajectory.jmax * dt + 1e-8,
      "finite jerk through modulation, saturation and capture");
    assert.ok(next.position >= trajectory.low - 1e-10 && next.position <= trajectory.high + 1e-10,
      "retained rail bounds");
    const stop = trajectory.braking();
    assert.ok(stop.minPosition >= trajectory.low - 1e-10 && stop.maxPosition <= trajectory.high + 1e-10,
      "complete emergency stopping trajectory still fits");
    verify?.(signal, (index + 1) * dt);
  }
  return signal;
}
function exactReference(signal) {
  assert.ok(Math.abs(signal.command - signal.planned_reference) * spanMm < 1e-7,
    "held reference has no periodic recapture position error");
  assert.ok(Math.abs(signal.velocity - signal.planned_reference_velocity) * spanMm < 1e-7,
    "held reference carries its exact velocity");
  assert.ok(Math.abs(signal.acceleration - signal.planned_reference_acceleration) * spanMm < 1e-7,
    "held reference carries its exact acceleration");
}

test("held envelope attack follows its full sine exactly after saturation", () => {
  const engine = hardware({env_to_stroke:true, rate_hz:1.5, stroke:.7});
  let minimum = Infinity, maximum = -Infinity;
  advance(engine, 4, true, (signal, elapsed) => {
    if (elapsed < 2) return;
    assert.equal(signal.envelope, 1);
    exactReference(signal);
    minimum = Math.min(minimum, signal.command); maximum = Math.max(maximum, signal.command);
  });
  assert.ok((maximum - minimum) * spanMm > .7 * .8 * spanMm * .9999,
    "exact following preserves the full requested stroke");
});

for (const target of ["rate", "stroke", "center", "position"]) {
  test(`held envelope ${target} patch follows exactly at both attack and release ends`, () => {
    const engine = hardware({patches:[{source:"envelope", target, depth:.2}]});
    for (const gate of [true, false]) {
      advance(engine, 3, gate, (signal, elapsed) => {
        if (elapsed < 1.5) return;
        assert.equal(signal.envelope, Number(gate));
        exactReference(signal);
      });
    }
  });
}

test("gate reversal resumes modulation and recaptures bounded PVA before exact held following", () => {
  const engine = hardware({env_to_stroke:true, rate_hz:1.5, stroke:.7});
  exactReference(advance(engine, 2, true));
  let changedDuringRelease = false;
  advance(engine, 2, false, (signal, elapsed) => {
    if (elapsed < .24 && signal.effective_stroke > 0 && signal.effective_stroke < .7) changedDuringRelease = true;
    if (elapsed >= 1) { exactReference(signal); assert.equal(signal.command, .5); }
  });
  assert.ok(changedDuringRelease, "gate reversal changes the stroke before the release saturates");
  let changedDuringAttack = false;
  advance(engine, 2, true, (signal, elapsed) => {
    if (elapsed < .12 && signal.effective_stroke > 0 && signal.effective_stroke < .7) changedDuringAttack = true;
    if (elapsed >= 1) exactReference(signal);
  });
  assert.ok(changedDuringAttack, "retriggering from zero resumes the envelope attack");
});

test("ongoing LFO modulation remains predictive while a connected envelope is held", () => {
  const engine = hardware({env_to_stroke:true, rate_hz:.8, stroke:.4, lfo_rate_hz:.3,
    patches:[{source:"lfo", target:"stroke", depth:.2}]});
  advance(engine, 2, true);
  assert.equal(engine.envelope, 1);
  const reference = engine._continuousReference(.002, true), offset = .3;
  const futureStroke = .4 + .2 * Math.sin(2 * Math.PI * (engine.lfo_phase + .3 * offset));
  const expected = .5 + .4 * futureStroke * Math.sin(2 * Math.PI * (engine.reference_phase + .8 * offset));
  assert.ok(Math.abs(reference.sample(offset).position - expected) < 1e-12,
    "a held envelope must not freeze the LFO geometry at the current sample");
  advance(engine, 2, true);
});
