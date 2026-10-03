// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const enginePath = path.join(__dirname, "../virtual_synth/static/browser-engine.js");
const {Engine, Trajectory, DEFAULT_PARAMS, MAX_VELOCITY, MAX_ACCELERATION,
  validateParams, waveform} = require(enginePath);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/browser_engine_parity.json"), "utf8"));

function near(actual, expected, context = "", tolerance = 1e-10) {
  assert.ok(Number.isFinite(actual), `${context}: nonfinite ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${context}: expected ${expected}, got ${actual}`);
}
function state(engine) {
  return JSON.parse(JSON.stringify({params: engine.params, trajectory: engine.trajectory,
    phase: engine.phase, lfo_phase: engine.lfo_phase, envelope: engine.envelope}));
}

test("reference fixture identifies the current Python source and defaults", () => {
  const source = fs.readFileSync(path.join(__dirname, "../virtual_synth/engine.py"));
  assert.equal(createHash("sha256").update(source).digest("hex"), fixture.source_sha256,
    "Python engine changed; regenerate and review the Python parity fixture");
  assert.deepEqual(DEFAULT_PARAMS, fixture.defaults);
  assert.equal(MAX_VELOCITY, 3822 / 8192);
  assert.equal(MAX_ACCELERATION, 1);
});

for (const scenario of fixture.engines) {
  test(`Python engine trajectory parity: ${scenario.name}`, () => {
    const engine = new Engine(scenario.params);
    scenario.rows.forEach(([dt, gate, running, expected], index) => {
      const event = scenario.events[index];
      if (event?.configure) engine.configure(event.configure);
      if (event?.reset) engine.reset(event.reset);
      const signal = engine.step(dt, {gate, running});
      assert.deepEqual(Object.keys(signal), fixture.signal_keys);
      fixture.signal_keys.forEach((key, column) => {
        if (typeof expected[column] === "boolean") assert.equal(signal[key], expected[column]);
        else near(signal[key], expected[column], `${scenario.name} step ${index} ${key}`);
      });
      assert.ok(engine.trajectory.position >= engine.params.lower - 1e-10);
      assert.ok(engine.trajectory.position <= engine.params.upper + 1e-10);
    });
  });
}

for (const scenario of fixture.trajectories) {
  test(`Python analytic planner parity: ${scenario.name}`, () => {
    const trajectory = new Trajectory(scenario.options);
    scenario.rows.forEach(([target, dt, position, velocity], index) => {
      near(trajectory.update(target, dt), position, `${scenario.name} step ${index} position`);
      near(trajectory.velocity, velocity, `${scenario.name} step ${index} velocity`);
    });
  });
}

test("every waveform matches Python through negative and wrapped cycles", () => {
  for (const [shape, phase, value] of fixture.waveforms) {
    near(waveform(shape, phase), value, `${shape} at ${phase}`);
  }
});

test("browser global works without require, network, DOM, or device APIs", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(enginePath, "utf8"), context);
  const result = vm.runInContext("new MotionBrowserEngine.Engine().step(.05, {gate: true})", context);
  near(result.envelope, .05 / .8);
  assert.equal(result.position_patched, false);
  assert.deepEqual(Object.keys(context.MotionBrowserEngine),
    ["Engine", "Trajectory", "DEFAULT_PARAMS", "MAX_VELOCITY", "MAX_ACCELERATION", "validateParams", "waveform"]);
});

test("parameter validation rejects coercions, nonfinite values, unknown keys and invalid cables", () => {
  const bad = [null, [], true, "params", {rate_hz: true}, {rate_hz: "1"},
    {rate_hz: NaN}, {stroke: Infinity}, {attack_s: 0}, {release_s: 10.01},
    {shape: "noise"}, {shape: []}, {env_to_stroke: 1}, {lower: .5}, {upper: .5},
    {extra: 1}, JSON.parse('{"__proto__":{}}'), {patches: {}}, {patches: [null]},
    {patches: [{source: "lfo", target: "rate", depth: true}]},
    {patches: [{source: "lfo", target: "rate", depth: 1, extra: 0}]},
    {patches: [{source: "audio", target: "rate", depth: 1}]},
    {patches: [{source: "lfo", target: "velocity", depth: 1}]},
    {patches: [{source: "lfo", target: "rate", depth: 1.01}]},
    {patches: [{source: "lfo", target: "rate", depth: 1},
      {source: "envelope", target: "rate", depth: -1}]}];
  for (const value of bad) assert.throws(() => validateParams(value));
  assert.throws(() => validateParams({}, {stroke: "bad"}));
  assert.throws(() => validateParams({}, []));
});

test("parameters, patches, configure results and defaults never alias caller data", () => {
  const input = {patches: [{source: "lfo", target: "stroke", depth: .4}]};
  const engine = new Engine(input);
  input.patches[0].depth = -.8;
  assert.equal(engine.params.patches[0].depth, .4);
  const result = engine.configure({stroke: .6});
  result.patches[0].depth = .9;
  result.stroke = .1;
  assert.equal(engine.params.patches[0].depth, .4);
  assert.equal(engine.params.stroke, .6);
  assert.deepEqual(new Engine().params.patches, []);
  assert.equal(DEFAULT_PARAMS.stroke, .7);
});

test("failed parameter and bounds updates preserve the complete engine state", () => {
  const engine = new Engine();
  engine.trajectory.update(.9, .25);
  const before = state(engine);
  // Position fits below .55, but its current braking point does not.
  assert.ok(engine.trajectory.position < .55);
  assert.throws(() => engine.configure({upper: .55}));
  assert.deepEqual(state(engine), before);
  assert.throws(() => engine.configure({rate_hz: false}));
  assert.deepEqual(state(engine), before);
  assert.throws(() => engine.reset({position: .4, vmax: 0}));
  assert.deepEqual(state(engine), before);
  assert.throws(() => engine.reset({position: 1}));
  assert.deepEqual(state(engine), before);
});

test("reset preserves or replaces physical scaling atomically", () => {
  const engine = new Engine();
  engine.reset({position: .4, vmax: .03, amax: .08});
  engine.step(.25, {gate: true});
  engine.reset({position: .6});
  assert.equal(engine.trajectory.position, .6);
  assert.equal(engine.trajectory.command, .6);
  assert.equal(engine.trajectory.velocity, 0);
  assert.equal(engine.trajectory.vmax, .03);
  assert.equal(engine.trajectory.amax, .08);
  assert.equal(engine.phase, 0);
  assert.equal(engine.lfo_phase, 0);
  assert.equal(engine.envelope, 0);
});

test("gate retrigger uses current envelope while disarming freezes only the planner", () => {
  const engine = new Engine();
  let signal = engine.step(.1, {gate: true});
  near(signal.envelope, .125);
  signal = engine.step(.05, {gate: false});
  near(signal.envelope, .125 - .05 / 1.2);
  const position = signal.command, phase = signal.phase;
  signal = engine.step(.02, {gate: true, running: false});
  near(signal.envelope, .125 - .05 / 1.2 + .02 / .8);
  assert.equal(signal.command, position);
  assert.equal(signal.velocity, 0);
  assert.equal(signal.limited, false);
  assert.notEqual(signal.phase, phase);
});

test("explicit position cable bypasses the implicit envelope-to-stroke switch", () => {
  const engine = new Engine({env_to_stroke: true,
    patches: [{source: "lfo", target: "position", depth: 1},
      {source: "envelope", target: "stroke", depth: -.5}]});
  const signal = engine.step(.1, {gate: false});
  assert.equal(signal.envelope, 0);
  assert.equal(signal.effective_stroke, .7);
  assert.equal(signal.position_patched, true);
  assert.equal(signal.envelope_bypassed, true);
  assert.notEqual(signal.requested, .5);
});

test("planner remains stoppable inside bounds under abrupt deterministic target changes", () => {
  const trajectory = new Trajectory({low: .1, high: .9, position: .5});
  let random = 0xC0FFEE;
  for (let index = 0; index < 3000; index++) {
    random = (Math.imul(1664525, random) + 1013904223) >>> 0;
    const target = .1 + .8 * random / 0xFFFFFFFF;
    const dt = [.001, .02, .125, .25][index % 4];
    const oldVelocity = trajectory.velocity;
    trajectory.update(target, dt);
    const stop = trajectory.position + trajectory.velocity * Math.abs(trajectory.velocity) / (2 * trajectory.amax);
    assert.ok(trajectory.position >= .1 && trajectory.position <= .9);
    assert.ok(stop >= .1 - 1e-10 && stop <= .9 + 1e-10);
    assert.ok(Math.abs(trajectory.velocity) <= trajectory.vmax + 1e-10);
    assert.ok(Math.abs(trajectory.velocity - oldVelocity) <= trajectory.amax * dt + 1e-10);
  }
});

test("invalid time, gate, target and reset inputs cannot partially advance the engine", () => {
  const engine = new Engine();
  engine.step(.1, {gate: true});
  const before = state(engine);
  for (const dt of [-.01, .251, Infinity, NaN, true, "0.1"]) {
    assert.throws(() => engine.step(dt));
    assert.deepEqual(state(engine), before);
  }
  for (const flags of [{gate: 1}, {running: null}, {gate: "false"}, false, [], null, {extra: true}]) {
    assert.throws(() => engine.step(.1, flags));
    assert.deepEqual(state(engine), before);
  }
  for (const reset of [false, .5, [], null, {extra: true}]) {
    assert.throws(() => engine.reset(reset));
    assert.deepEqual(state(engine), before);
  }
  for (const configuration of [false, .5, [], null, {extra: true}]) {
    assert.throws(() => new Trajectory(configuration));
  }
  for (const target of [-.1, 1.1, NaN, true]) {
    assert.throws(() => engine.trajectory.update(target, .1));
    assert.deepEqual(state(engine), before);
  }
  for (const phase of [NaN, Infinity, true, "0"]) assert.throws(() => waveform("sine", phase));
});


test("higher hardware motion budget retains a broad one-hertz sine stroke", () => {
 const {Engine}=require("../virtual_synth/static/browser-engine.js");
 const e=new Engine(); e.configure({rate_hz:1,stroke:.7});
 e.reset({position:.5,vmax:294912/143949,amax:1769472/143949});
 let low=1,high=0;
 for(let i=0;i<1000;i++) {const s=e.step(.02,{running:true});
  assert.ok(s.command>=.1 && s.command<=.9);
  if(i>250){low=Math.min(low,s.command);high=Math.max(high,s.command);}
 }
 assert.ok(high-low>.55, "planner should preserve the feasible 56% working-range stroke");
});

test("continuous hardware tracking follows a feasible sine without braking at every sample",()=>{
 const e=new Engine({rate_hz:.57,stroke:1});e.reset({position:.5,vmax:589824/143949,amax:2949120/143949});
 let sum=0,n=0,previous=0;
 for(let i=0;i<1500;i++){
  const s=e.step(.06,{running:true,tracking:true});
  assert.ok(s.command>=.1&&s.command<=.9);assert.ok(Math.abs(s.velocity)<=e.trajectory.vmax+1e-9);
  assert.ok(Math.abs(s.velocity-previous)<=e.trajectory.amax*.06+1e-8);previous=s.velocity;
  if(i>250){sum+=(s.command-s.requested)**2;n++;}
 }
 assert.ok(Math.sqrt(sum/n)<.025,`tracking RMS ${Math.sqrt(sum/n)}`);
});
test("tracking remains bounded through abrupt waveform and rate changes",()=>{
 const e=new Engine(); e.reset({position:.5,vmax:2,amax:12});let previous=0;
 for(let i=0;i<2500;i++){
  if(i%100===0)e.configure({shape:['sine','square','saw','triangle'][(i/100)%4],rate_hz:i%200?4:.02,stroke:1});
  const s=e.step(.02,{running:true,tracking:true});
  assert.ok(s.command>=.1&&s.command<=.9);assert.ok(Math.abs(s.velocity)<=2+1e-9);
  assert.ok(Math.abs(s.velocity-previous)<=12*.02+1e-8);previous=s.velocity;
 }
});

test("feasible fast sine strokes preserve amplitude through irregular serial intervals", () => {
  const spanMm = 179.7;
  const intervals = [.0215, .020, .025, .019, .0748, .020, .022, .020, .0641, .0215];
  for (const [rate_hz, stroke] of [[1.5, .7], [2.5, .3]]) {
    const engine = new Engine({rate_hz, stroke});
    engine.reset({position: .5, vmax: 1080 / spanMm, amax: 6000 / spanMm});
    let elapsed = 0, index = 0, previousVelocity = 0;
    let requestedLow = 1, requestedHigh = 0, commandLow = 1, commandHigh = 0;
    let squaredError = 0, sampleCount = 0;
    while (elapsed < 16) {
      const dt = intervals[index++ % intervals.length];
      elapsed += dt;
      const signal = engine.step(dt, {running: true, tracking: true});
      assert.ok(signal.command >= .1 && signal.command <= .9);
      assert.ok(Math.abs(signal.velocity) <= engine.trajectory.vmax + 1e-9);
      assert.ok(Math.abs(signal.velocity - previousVelocity) <= engine.trajectory.amax * dt + 1e-8);
      const stopping = signal.command + signal.velocity * Math.abs(signal.velocity) / (2 * engine.trajectory.amax);
      assert.ok(stopping >= .1 - 1e-9 && stopping <= .9 + 1e-9);
      previousVelocity = signal.velocity;
      if (elapsed < 3) continue; // Startup begins at rest, then settles into the waveform.
      requestedLow = Math.min(requestedLow, signal.requested);
      requestedHigh = Math.max(requestedHigh, signal.requested);
      commandLow = Math.min(commandLow, signal.command);
      commandHigh = Math.max(commandHigh, signal.command);
      squaredError += (signal.command - signal.requested) ** 2;
      sampleCount++;
    }
    const requestedSpan = requestedHigh - requestedLow, commandSpan = commandHigh - commandLow;
    const rms = Math.sqrt(squaredError / sampleCount);
    assert.ok(Math.abs(commandSpan - requestedSpan) < requestedSpan * .01,
      `${rate_hz} Hz amplitude error ${(commandSpan - requestedSpan) * spanMm} mm`);
    assert.ok(rms < .0025, `${rate_hz} Hz tracking RMS ${rms * spanMm} mm`);
  }
});

test("hardware waveform and modulation follow the same time path across long and fine updates", () => {
  const params = {rate_hz: 1.5, stroke: .7, lfo_rate_hz: .3, attack_s: .4, release_s: .6,
    env_to_stroke: true, patches: [{source: "lfo", target: "rate", depth: .2},
      {source: "lfo", target: "center", depth: .15}]};
  const coarse = new Engine(params), fine = new Engine(params);
  for (const engine of [coarse, fine]) engine.reset({position: .5, vmax: 6, amax: 33});
  const intervals = [.020, .075, .0215, .0641, .019];
  for (let index = 0; index < 100; index++) {
    const dt = intervals[index % intervals.length], gate = index < 50;
    const signal = coarse.step(dt, {gate, running: true, tracking: true});
    const count = Math.ceil(dt / .001);
    let reference;
    for (let step = 0; step < count; step++) reference = fine.step(dt / count, {gate, running: true, tracking: true});
    near(signal.phase, reference.phase, "modulated carrier phase", .00001);
    near(signal.lfo, reference.lfo, "LFO", .00001);
    near(signal.envelope, reference.envelope, "envelope", .00001);
    near(signal.requested, reference.requested, "modulated request", .0001);
    near(signal.command, reference.command, "modulated command", .003);
  }
});

test("long hardware tracking updates retain stopping bounds through discontinuities", () => {
  const engine = new Engine();
  engine.reset({position: .5, vmax: 2, amax: 12});
  const intervals = [.020, .075, .0215, .0641, .019];
  let previousVelocity = 0;
  for (let index = 0; index < 1500; index++) {
    if (index % 100 === 0) engine.configure({shape: ["sine", "square", "saw", "triangle"][(index / 100) % 4],
      rate_hz: index % 200 ? 4 : .02, stroke: 1, center: index % 200 ? .8 : .2});
    const dt = intervals[index % intervals.length];
    const signal = engine.step(dt, {running: true, tracking: true});
    assert.ok(signal.command >= .1 && signal.command <= .9);
    assert.ok(Math.abs(signal.velocity) <= 2 + 1e-9);
    assert.ok(Math.abs(signal.velocity - previousVelocity) <= 12 * dt + 1e-8);
    const stopping = signal.command + signal.velocity * Math.abs(signal.velocity) / 24;
    assert.ok(stopping >= .1 - 1e-9 && stopping <= .9 + 1e-9);
    previousVelocity = signal.velocity;
  }
});
