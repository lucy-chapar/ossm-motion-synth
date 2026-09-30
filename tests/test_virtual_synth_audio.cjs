/* SPDX-License-Identifier: MPL-2.0 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Preview, mapAudio } = require("../virtual_synth/static/audio.js");

function state() {
  return { running: true, fault: null, unconfirmed_stop: false,
    params: { shape: "sine", lower: 0.1, upper: 0.9, patches: [] },
    signal: { command: 0.5, requested: 1, effective_rate_hz: 0.25,
      effective_stroke: 0.7, effective_center: 0.5, envelope: 0.2, position_patched: false } };
}
const motion = { active: true, mode: "motion", source: "command", volume: 0.5 };
const wave = { active: true, mode: "wave", source: "command", volume: 0.5 };

class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  cancelAndHoldAtTime(time) { this.events.push(["hold", time]); }
  cancelScheduledValues(time) { this.events.push(["cancel", time]); }
  setValueAtTime(value, time) { this.value = value; this.events.push(["set", value, time]); }
  linearRampToValueAtTime(value, time) { this.events.push(["ramp", value, time]); }
  setTargetAtTime(value, time, constant) { this.events.push(["target", value, time, constant]); }
}
class Context {
  constructor() {
    this.currentTime = 2;
    this.state = "suspended";
    this.destination = {};
    this.closed = this.started = this.stopped = 0;
    this.gain = { gain: new Param(), connect: (to) => { this.gainConnection = to; },
      disconnect: () => { this.gainConnection = null; } };
    this.oscillator = { type: "sine", frequency: new Param(220),
      connect: (to) => { this.oscillatorConnection = to; },
      disconnect: () => { this.oscillatorConnection = null; },
      start: () => { this.started++; }, stop: () => { this.stopped++; } };
  }
  createGain() { return this.gain; }
  createOscillator() { return this.oscillator; }
  async resume() { this.state = "running"; }
  async close() { this.closed++; this.state = "closed"; }
}

test("motion pitch preserves position mapping and uses independent low gain", () => {
  const value = state();
  assert.deepEqual(mapAudio(value, motion), { frequency: 220, gain: 0.075, type: "sine", reason: "ready" });
  assert.equal(mapAudio(value, { ...motion, source: "requested" }).frequency, 440);
  value.signal.command = 0;
  assert.equal(mapAudio(value, motion).frequency, 110);
  value.signal.effective_stroke = 0;
  assert.equal(mapAudio(value, motion).gain, 0.075, "stationary hold remains a steady note");
});

test("wave maps the effective carrier and does not apply the envelope twice", () => {
  const value = state();
  value.params.shape = "saw";
  const mapped = mapAudio(value, wave);
  assert.equal(mapped.frequency, 250);
  assert.equal(mapped.type, "sawtooth");
  assert.ok(Math.abs(mapped.gain - 0.075 * 0.7 * 0.8) < 1e-12);
  value.signal.effective_center = 0.25;
  assert.ok(Math.abs(mapAudio(value, wave).gain - mapped.gain / 2) < 1e-12);
  value.signal.effective_rate_hz = 0.02;
  assert.equal(mapAudio(value, wave).frequency, 20);
  value.signal.effective_rate_hz = 4;
  assert.equal(mapAudio(value, wave).frequency, 4000);
});

test("position cable makes carrier unavailable while motion pitch still works", () => {
  const value = state();
  value.signal.position_patched = true;
  assert.equal(mapAudio(value, wave).reason, "position-patched");
  assert.equal(mapAudio(value, motion).reason, "ready");
  value.signal.position_patched = false;
  value.params.patches = [{ source: "envelope", target: "position", depth: 1 }];
  assert.equal(mapAudio(value, wave).gain, 0);
});

test("inactive, stopped, faulted, and malformed states cannot produce gain", () => {
  for (const changes of [{ running: false }, { running: 1 }, { fault: "Lost motor" }, { unconfirmed_stop: true }, { signal: null }]) {
    assert.equal(mapAudio({ ...state(), ...changes }, motion).gain, 0);
  }
  for (const position of [NaN, Infinity, -0.1, 1.1, "0.5", null]) {
    const value = state(); value.signal.command = position;
    assert.equal(mapAudio(value, motion).reason, "invalid-data");
  }
  for (const options of [{ ...motion, active: false }, { ...motion, source: "actual" },
    { ...motion, mode: "other" }, { ...motion, volume: NaN }, { ...motion, volume: "0.5" }, null]) {
    assert.equal(mapAudio(state(), options).gain, 0);
  }
  assert.equal(mapAudio(null, motion).gain, 0);
  assert.equal(mapAudio(state(), { ...motion, volume: 10 }).gain, 0.15);
  assert.equal(mapAudio(state(), { ...motion, volume: -1 }).gain, 0);
  for (const mutate of [v => { v.signal.effective_rate_hz = Infinity; },
    v => { v.signal.effective_stroke = 2; }, v => { v.signal.effective_center = NaN; },
    v => { v.params.upper = -1; }, v => { v.params.shape = "toString"; },
    v => { v.params.patches = null; }]) {
    const value = state(); mutate(value);
    assert.equal(mapAudio(value, wave).gain, 0);
  }
});

test("construction and update never create or resume an audio context", async () => {
  let created = 0;
  const context = new Context();
  const preview = new Preview(() => { created++; return context; });
  assert.equal(preview.enabled, false);
  assert.equal(preview.update(state(), motion).gain, 0);
  preview.silence();
  assert.equal(created, 0);
  assert.equal(await preview.enable(), true);
  assert.equal(created, 1);
  assert.equal(context.started, 1);
  assert.equal(context.gain.gain.value, 0, "enable alone is silent");
  assert.equal(context.oscillatorConnection, context.gain);
  assert.equal(context.gainConnection, context.destination);
  await preview.enable();
  assert.equal(created, 1);
  preview.disable();
});

test("fresh updates schedule a zero-gain deadline on the audio clock", async () => {
  const context = new Context(), preview = new Preview(() => context);
  await preview.enable();
  const mapped = preview.update(state(), motion);
  assert.equal(mapped.gain, 0.075);
  assert.deepEqual(context.gain.gain.events, [
    ["hold", 2], ["ramp", 0.075, 2.012], ["set", 0.075, 2.35], ["ramp", 0, 2.4],
  ]);
  assert.deepEqual(context.oscillator.frequency.events, [["cancel", 2], ["target", 220, 2, 0.015]]);
  context.currentTime = 2.1;
  preview.update(state(), motion);
  assert.deepEqual(context.gain.gain.events.slice(-4), [
    ["hold", 2.1], ["ramp", 0.075, 2.112], ["set", 0.075, 2.45], ["ramp", 0, 2.5],
  ]);
  preview.disable();
});

test("silence fades immediately without changing explicit audio preference", async () => {
  const context = new Context(), preview = new Preview(() => context);
  await preview.enable(); preview.update(state(), motion);
  preview.silence();
  assert.equal(preview.enabled, true);
  assert.deepEqual(context.gain.gain.events.slice(-2), [["hold", 2], ["ramp", 0, 2.01]]);
  assert.equal(preview.update({ ...state(), fault: "Stopped" }, motion).gain, 0);
  assert.equal(preview.enabled, true);
  preview.disable();
  assert.equal(preview.enabled, false);
  assert.equal(context.gain.gain.value, 0);
  assert.equal(context.stopped, 1);
  assert.equal(context.closed, 1);
  assert.equal(context.gainConnection, null);
});

test("a denied resume rejects and disposes the muted graph", async () => {
  const context = new Context();
  context.resume = async () => { throw new Error("Gesture required"); };
  const preview = new Preview(() => context);
  await assert.rejects(preview.enable(), /Gesture required/);
  assert.equal(preview.enabled, false);
  assert.equal(context.closed, 1);
  assert.equal(context.stopped, 1);
  assert.equal(context.gain.gain.value, 0);
});

test("disable cancels a pending enable and a late resume cannot revive sound", async () => {
  const first = new Context(), second = new Context();
  let resumeFirst;
  first.resume = () => new Promise(resolve => { resumeFirst = resolve; });
  let count = 0;
  const preview = new Preview(() => count++ === 0 ? first : second);
  const oldEnable = preview.enable();
  preview.disable();
  assert.equal(await preview.enable(), true);
  first.state = "running";
  resumeFirst();
  assert.equal(await oldEnable, false);
  assert.equal(preview.enabled, true, "new explicit enable remains independent");
  assert.equal(first.gainConnection, null);
  assert.equal(first.stopped, 1);
  assert.equal(preview.update(state(), motion).gain, 0.075);
  assert.equal(second.gainConnection, second.destination);
  preview.disable();
});

test("audio suspension or automation errors remove the audible path", async () => {
  const context = new Context(), preview = new Preview(() => context);
  await preview.enable();
  context.state = "suspended";
  assert.equal(preview.update(state(), motion).reason, "audio-unavailable");
  assert.equal(preview.enabled, false);
  assert.equal(context.gainConnection, null);
  const broken = new Context(), failed = new Preview(() => broken);
  await failed.enable();
  broken.gain.gain.linearRampToValueAtTime = () => { throw new Error("Closed context"); };
  assert.equal(failed.update(state(), motion).gain, 0);
  assert.equal(failed.enabled, false);
  assert.equal(broken.gainConnection, null);
});

test("fallback automation cancels earlier expiry when hold is unavailable", async () => {
  const context = new Context(), preview = new Preview(() => context);
  context.gain.gain.cancelAndHoldAtTime = undefined;
  await preview.enable();
  preview.update(state(), motion);
  assert.deepEqual(context.gain.gain.events.slice(0, 2), [["cancel", 2], ["set", 0, 2]]);
  preview.disable();
});
