// SPDX-License-Identifier: MPL-2.0
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntime } = require("../virtual_synth/static/browser-runtime.js");

function setup({ supported = true, factory, storage, diagnosticScheduler } = {}) {
  let now = 0, choices = 0, opens = 0;
  const port = { getInfo: () => ({ usbVendorId: 1027, usbProductId: 24577 }) };
  const listeners = {};
  const serial = supported ? { addEventListener: (name,fn)=>{listeners[name]=fn;}, removeEventListener: ()=>{}, getPorts: async () => [port], requestPort: () => { choices++; return Promise.resolve(port); } } : null;
  const runtime = createRuntime({ serial, storage, clock: () => now, autoStart: false, diagnosticScheduler,
    transportFactory: (selected) => { assert.equal(selected, port); opens++; return factory(); } });
  const action = (name, details = {}) => runtime.request("/api/action", { action: name, ...details });
  return { runtime, action, advance: (dt) => { now += dt; }, time: () => now, port,
    emit: (name,event)=>listeners[name]?.(event), counts: () => ({ choices, opens }), async connect() { const chosen = await runtime.choosePort(); return action("connect", { port: chosen }); } };
}
function fakeMotor({ stopConfirmed = true } = {}) {
  const hw = { connected: false, mode: 1, output_enabled: false, pending_raw: 0, pwm_raw: 0,
    owned: false, running: false, armed: false, homing: false, homed: false, fault: null,
    position_normalized: 0.5, max_velocity_raw_s: 73728, max_acceleration_raw_s2: 147456,
    max_jerk_raw_s3: 81920000, stop_confirmed: true, raw_bounds: [-9830, 9830] };
  const calls = [];
  return { calls, hw, status: () => ({ ...hw }),
    async connect() { calls.push("connect"); hw.connected = true; return this.status(); },
    async snapshot() { calls.push("read"); return this.status(); },
    async begin_home() { calls.push("home"); hw.homing = hw.owned = true; return this.status(); },
    async poll_home() { calls.push("poll_home"); hw.homing = hw.owned = false; hw.homed = true; return this.status(); },
    async arm() { calls.push("arm"); hw.armed = true; return this.status(); },
    async start() { calls.push("start"); hw.running = hw.owned = true; hw.stop_confirmed = false; return this.status(); },
    async command(position) { calls.push(["command", typeof position === "function" ? position() : position]); return this.status(); },
    async stop() { calls.push("stop"); hw.running = hw.armed = hw.homing = false; hw.stop_confirmed = stopConfirmed; hw.owned = !stopConfirmed; return this.status(); },
    async close() { calls.push("close"); hw.connected = false; return this.status(); } };
}

function diagnosticTimer() {
  let current = null, cleared = 0, unreferenced = 0;
  return {
    scheduler: {
      setInterval(callback, milliseconds) {
        assert.equal(milliseconds,20);
        current = { callback, active:true, unref() { unreferenced++; } }; return current;
      },
      clearInterval(timer) { timer.active=false; cleared++; },
    },
    fire() { if(current?.active) current.callback(); },
    captured() { return current?.callback; },
    counts() { return {cleared,unreferenced,active:Boolean(current?.active)}; },
  };
}

test("production browser factory selects direct servo motion while retaining the full host budget", async () => {
  const {MotorTransport} = require("../virtual_synth/static/web-serial-transport.js");
  const previous = globalThis.MotionWebSerialTransport;
  const motor = fakeMotor(); motor.hw.homed = true; motor.hw.raw_bounds = [1000, 146000];
  const port = {getInfo: () => ({usbVendorId: 1, usbProductId: 2})};
  let now = 0, configured;
  globalThis.MotionWebSerialTransport = {MotorTransport: class {
    constructor(selectedPort, options) {
      assert.equal(selectedPort, port);
      const profile = new MotorTransport(selectedPort, options).status();
      configured = profile;
      Object.assign(motor.hw, {max_velocity_raw_s: profile.max_velocity_raw_s,
        max_acceleration_raw_s2: profile.max_acceleration_raw_s2, max_jerk_raw_s3: profile.max_jerk_raw_s3});
      return motor;
    }
  }};
  const runtime = createRuntime({autoStart: false, clock: () => now, storage: null,
    serial: {requestPort: async () => port, getPorts: async () => [port]}});
  const action = (name, fields = {}) => runtime.request("/api/action", {action: name, ...fields});
  try {
    await action("connect", {port: await runtime.choosePort()});
    assert.equal(configured.motion_profile, "servo_direct");
    assert.equal(configured.max_acceleration_raw_s2 / 819.2, 6000);
    assert.equal(configured.max_velocity_raw_s / 819.2, 1080);
    assert.equal(configured.max_jerk_raw_s3 / 819.2, 100000);
    await action("configure", {params: {rate_hz: 1.5, stroke: .7}});
    await action("play"); now += .1; await runtime.tick();
    assert.equal(runtime.state().signal.rate_limited, false, "ordinary fast sine fits the production budget");
    assert.equal(runtime.state().signal.planned_rate_hz, 1.5);
  } finally {
    await runtime.close();
    if (previous === undefined) delete globalThis.MotionWebSerialTransport;
    else globalThis.MotionWebSerialTransport = previous;
  }
});

test("startup, state and enumeration never choose or open a device", async () => {
  const env = setup();
  assert.equal((await env.runtime.request("/api/session")).token, "browser-session");
  await env.runtime.request("/api/state"); await env.runtime.request("/api/ports");
  assert.deepEqual(env.counts(), { choices: 0, opens: 0 });
  await env.runtime.choosePort();
  assert.deepEqual(env.counts(), { choices: 1, opens: 0 });
});
test("unsupported browser keeps wave and audio state usable without hardware", async () => {
  const { runtime, action, advance } = setup({ supported: false });
  assert.equal(runtime.state().web_serial_supported, false);
  await assert.rejects(runtime.choosePort(), /Web Serial/);
  await action("arm"); await action("run"); advance(.1); await runtime.tick();
  assert.equal(runtime.state().running, true);
  assert.equal(runtime.state().hardware, null);
  assert.ok(Number.isFinite(runtime.state().signal.command));
});
test("patch validation and gate envelope preserve explicit controls", async () => {
  const { runtime, action, advance } = setup();
  await assert.rejects(action("run"), /Arm/);
  await assert.rejects(action("gate", { value: true }), /Start/);
  await action("configure", { params: { attack_s: 1, env_to_stroke: true, patches: [{ source: "lfo", target: "rate", depth: .4 }] } });
  await action("arm"); await action("run"); await action("gate", { value: true });
  advance(.1); await runtime.tick();
  assert.ok(runtime.state().signal.envelope > 0);
  await assert.rejects(action("configure", { params: { lower: .2 } }), /Stop/);
  await action("stop"); assert.equal(runtime.state().running, false);
  assert.equal(runtime.state().gate, false);
});
test("missed timing and heartbeat stop before further targets", async () => {
  for (const delay of [.3, 1.6]) {
    const { runtime, action, advance } = setup();
    await action("arm"); await action("run"); advance(delay); await runtime.tick();
    assert.equal(runtime.state().running, false); assert.ok(runtime.state().fault);
  }
});
test("connect is read-only; home completes before hardware can arm", async () => {
  const motor = fakeMotor(), env = setup({ factory: () => motor });
  await env.connect(); assert.deepEqual(motor.calls, ["connect"]);
  await assert.rejects(env.action("arm"), /Home/);
  await env.action("home_start", { control_revision: env.runtime.state().control_revision });
  assert.equal(env.runtime.state().homing.active, true);
  await assert.rejects(env.action("configure", { params: { stroke: .3 } }), /homing/);
  env.advance(.1); await env.runtime.tick();
  assert.equal(env.runtime.state().homing.valid, true);
  assert.equal(env.runtime.state().armed, false);
  await env.action("arm"); await env.action("run");
  env.advance(.1); await env.runtime.tick();
  const command = motor.calls.find((entry) => Array.isArray(entry));
  assert.ok(command);
  assert.ok(command[1] > .5);
  assert.ok(command[1] - .5 <= .5 * motor.hw.max_acceleration_raw_s2 / 19660 * .1 ** 2);
});

test("motion diagnostics preserve the recorded run settings after stopped controls change", async () => {
  const motors = [fakeMotor(), fakeMotor()];
  for (const motor of motors) {
    motor.hw.homed = true;
    motor.motionDiagnostics = () => ({ rows: [] });
  }
  const env = setup({ factory: () => motors.shift() });
  await env.connect(); await env.action("configure", { params: { rate_hz: 1.5, stroke: .7 } });
  await env.action("play"); env.advance(.01); await env.runtime.tick();
  await assert.rejects(env.runtime.request("/api/motion-diagnostics"), /Stop output/);
  await env.action("stop");
  await env.action("configure", { params: { rate_hz: 2.5, stroke: .3 } });
  const saved = await env.runtime.request("/api/motion-diagnostics");
  assert.equal(saved.parameters.rate_hz, 1.5); assert.equal(saved.parameters.stroke, .7);
  assert.equal(saved.parameters_at_export.rate_hz, 2.5); assert.equal(saved.parameters_at_export.stroke, .3);
  assert.deepEqual(saved.configuration_changes, []);
  saved.parameters.rate_hz = .02;
  assert.equal((await env.runtime.request("/api/motion-diagnostics")).parameters.rate_hz, 1.5,
    "exported settings are detached from the retained run record");
  await env.action("disconnect"); await env.connect();
  assert.equal((await env.runtime.request("/api/motion-diagnostics")).parameters, null,
    "a different connection cannot inherit another motor's run record");
  await env.runtime.close();
});

test("motion diagnostics retain a bounded timeline of accepted active configuration changes", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  motor.motionDiagnostics = () => ({ rows: [], trace_started_s: motor.hw.command_trace_started_s });
  const env = setup({ factory: () => motor }), start = motor.start.bind(motor);
  motor.start = async () => {
    await start(); motor.hw.command_trace_started_s = env.time() - .007;
    return motor.status();
  };
  env.advance(2); await env.connect(); await env.action("play");
  env.advance(.002); await env.runtime.tick();
  await assert.rejects(env.action("configure", { params: { lower: .2 } }), /Stop output/);
  const sentBefore = motor.calls.filter(Array.isArray).length;
  for (let i = 0; i < 130; i++) {
    env.advance(.001);
    await env.action("configure", { params: { rate_hz: .25 + i * .001 } });
  }
  assert.equal(motor.calls.filter(Array.isArray).length, sentBefore, "recording configuration does not generate target commands");
  await env.action("stop"); await env.action("configure", { params: { stroke: .33 } });
  const saved = await env.runtime.request("/api/motion-diagnostics");
  assert.equal(saved.parameters.rate_hz, .25); assert.equal(saved.parameters.stroke, .7);
  assert.equal(saved.parameters_at_export.stroke, .33);
  assert.equal(saved.configuration_changes_capacity, 128); assert.equal(saved.configuration_changes.length, 128);
  assert.equal(saved.configuration_changes_dropped, 2, "only accepted active changes count toward the ring");
  assert.equal(saved.configuration_changes[0].parameters.rate_hz, .252);
  assert.equal(saved.configuration_changes.at(-1).parameters.rate_hz, .379);
  assert.equal(saved.run_started_at_s, saved.motion.trace_started_s, "configuration and target traces share their exact clock origin");
  assert.ok(Math.abs(saved.configuration_changes[0].elapsed_s - .012) < 1e-9);
  assert.ok(saved.configuration_changes.every((item, i, changes) => i === 0 || item.elapsed_s >= changes[i - 1].elapsed_s));
  await env.runtime.close();
});

test("Resume captures a new diagnostic segment from the current paused controls", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  motor.motionDiagnostics = () => ({ rows: [] });
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("play");
  env.advance(.01); await env.runtime.tick();
  await env.action("configure", { params: { rate_hz: .3 } });
  await env.action("pause"); await env.action("configure", { params: { stroke: .35 } });
  await env.action("resume"); env.advance(.01); await env.runtime.tick(); await env.action("stop");
  const saved = await env.runtime.request("/api/motion-diagnostics");
  assert.equal(saved.parameters.rate_hz, .3); assert.equal(saved.parameters.stroke, .35);
  assert.deepEqual(saved.configuration_changes, [], "the resumed transport trace cannot inherit changes from its preceding trace");
  assert.equal(saved.configuration_changes_dropped, 0);
  await env.runtime.close();
});

test("independent diagnostic timers remain responsive during late fake serial I/O without advancing motion",async()=>{
  const motor=fakeMotor();motor.hw.homed=true;motor.motionDiagnostics=()=>({rows:[]});
  const timer=diagnosticTimer(),env=setup({factory:()=>motor,diagnosticScheduler:timer.scheduler});
  let finishReply;
  motor.command=async resolve=>{
    motor.calls.push(["command",resolve()]);
    await new Promise(resolve=>{finishReply=resolve;});return motor.status();
  };
  await env.connect();await env.action("play");env.advance(.005);
  const pending=env.runtime.tick();await new Promise(setImmediate);
  assert.equal(typeof finishReply,"function");
  const before=env.runtime.state().signal;
  for(let i=0;i<4;i++){env.advance(.02);timer.fire();}
  assert.deepEqual(env.runtime.state().signal,before,"the timer must not step or extrapolate the engine");
  assert.equal(motor.calls.filter(Array.isArray).length,1,"the timer never produces a target");
  await assert.rejects(env.runtime.request("/api/motion-diagnostics"),/Stop output/);
  finishReply();await pending;await env.action("stop");
  const saved=await env.runtime.request("/api/motion-diagnostics"),rows=saved.timer_lateness.rows;
  assert.equal(saved.timer_lateness.enabled,true);assert.equal(rows.length,4);
  assert.ok(rows.every(row=>row.interval_s <= .025 + 1e-9 && row.lateness_s <= .005 + 1e-9),
    "an 80 ms serial await does not resemble an 80 ms owner scheduling stall");
  assert.ok(rows.slice(1).every(row=>Math.abs(row.interval_s-.02)<1e-9));
  assert.equal(timer.counts().active,false);assert.equal(timer.counts().unreferenced,1);
  await env.runtime.close();
});

test("diagnostic timer stores one actual late callback, bounds its ring, and resets on Run and Resume",async()=>{
  const motor=fakeMotor();motor.hw.homed=true;motor.motionDiagnostics=()=>({rows:[]});
  const timer=diagnosticTimer(),env=setup({factory:()=>motor,diagnosticScheduler:timer.scheduler});
  await env.connect();await env.action("play");
  env.advance(.1);timer.fire();await env.action("stop");
  const late=await env.runtime.request("/api/motion-diagnostics");
  assert.equal(late.timer_lateness.rows.length,1,"a held callback never invents catch-up rows");
  assert.deepEqual(late.timer_lateness.rows[0],{elapsed_run_s:.1,interval_s:.1,lateness_s:.08});
  late.timer_lateness.rows[0].interval_s=99;
  assert.equal((await env.runtime.request("/api/motion-diagnostics")).timer_lateness.rows[0].interval_s,.1,
    "export rows are detached from the numeric ring");
  env.advance(.5);timer.fire();
  assert.equal((await env.runtime.request("/api/motion-diagnostics")).timer_lateness.rows.length,1,"Stop preserves the run without idle rows");
  await env.action("play");
  for(let i=0;i<515;i++){env.advance(.02);timer.fire();}
  await env.action("pause");
  const bounded=await env.runtime.request("/api/motion-diagnostics");
  assert.equal(bounded.timer_lateness.capacity,512);assert.equal(bounded.timer_lateness.rows.length,512);
  assert.equal(bounded.timer_lateness.dropped,3);
  assert.ok(Math.abs(bounded.timer_lateness.rows[0].elapsed_run_s-.08)<1e-9);
  assert.ok(bounded.timer_lateness.rows.every(row=>Object.values(row).every(Number.isFinite)));
  await env.action("resume");env.advance(.02);timer.fire();await env.action("stop");
  const resumed=await env.runtime.request("/api/motion-diagnostics");
  assert.equal(resumed.timer_lateness.rows.length,1);assert.equal(resumed.timer_lateness.dropped,0);
  assert.ok(Math.abs(resumed.timer_lateness.rows[0].elapsed_run_s-.02)<1e-9);
  await env.action("play");const queued=timer.captured();await env.runtime.close();
  assert.equal(timer.counts().active,false,"close clears the independent timer");
  env.advance(.5);queued();
  assert.deepEqual((await env.runtime.request("/api/motion-diagnostics")).timer_lateness.rows,[],
    "an already queued callback after close does not add a row");
});

test("autoStart false disables diagnostic timer work unless an explicit test scheduler is injected",async()=>{
  const motor=fakeMotor();motor.hw.homed=true;motor.motionDiagnostics=()=>({rows:[]});
  const env=setup({factory:()=>motor});await env.connect();await env.action("play");
  env.advance(.1);await env.runtime.tick();await env.action("stop");
  const saved=await env.runtime.request("/api/motion-diagnostics");
  assert.equal(saved.timer_lateness.enabled,false);assert.deepEqual(saved.timer_lateness.rows,[]);
  await env.runtime.close();
});

test("every baud generates one fresh target per completed hardware tick, including Resume", async () => {
  for (const baud of [undefined, 19200, 38400, 115200]) {
    const motor = fakeMotor(); motor.hw.homed = true; motor.hw.baud = baud;
    const env = setup({factory: () => motor});
    await env.connect(); await env.action("play");
    const count = () => motor.calls.filter(Array.isArray).length;
    for (let i = 0; i < 100; i++) { env.advance(.0005); await env.runtime.tick(); }
    assert.equal(count(), 100, "no baud-dependent target timer floor");
    await env.action("pause"); env.advance(.5); await env.runtime.tick(); assert.equal(count(), 100);
    await env.action("resume"); env.advance(.0005); await env.runtime.tick(); assert.equal(count(), 101);
    await env.action("stop"); env.advance(.02); await env.runtime.tick(); assert.equal(count(), 101);
    assert.equal(env.runtime.state().fault, null); await env.runtime.close();
  }
});

test("Pause and Resume retain the retimed hardware phase rather than the faster ideal phase", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  motor.hw.raw_bounds = [1000, 148456];
  motor.hw.max_velocity_raw_s = 1080 * 819.2;
  motor.hw.max_acceleration_raw_s2 = 6000 * 819.2;
  const env = setup({factory: () => motor});
  await env.connect(); await env.action("configure", {params: {rate_hz: 4, stroke: .7}});
  await env.action("play");
  for (let i = 0; i < 17; i++) { env.advance(.01); await env.runtime.tick(); }
  const before = env.runtime.state().signal;
  assert.equal(before.rate_limited, true);
  assert.ok(Math.abs(before.reference_phase - before.phase) > .1);
  await env.action("pause"); env.advance(1); await env.runtime.tick();
  const paused = env.runtime.state().signal;
  assert.equal(paused.reference_phase, before.reference_phase);
  assert.equal(paused.planned_rate_hz, null);
  await env.action("resume");
  assert.equal(env.runtime.state().signal.reference_phase, before.reference_phase);
  env.advance(.05); await env.runtime.tick();
  const after = env.runtime.state().signal;
  assert.ok(Math.abs(after.reference_phase - ((before.reference_phase + before.planned_rate_hz * .05) % 1)) < 1e-9);
});
test("Stop fences queued and in-flight start and cannot re-enable output", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  let finishStart;
  motor.start = async function () {
    this.calls.push("start"); this.hw.running = this.hw.owned = true;
    await new Promise((resolve) => { finishStart = resolve; }); return this.status();
  };
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("arm");
  const run = env.action("run"); await new Promise(setImmediate);
  const stopped = env.action("stop");
  assert.ok(motor.calls.includes("stop"), "stop reaches transport while start is pending");
  finishStart(); await assert.rejects(run, /stopped/); await stopped;
  assert.equal(env.runtime.state().running, false);
  assert.equal(env.runtime.state().armed, false);
  assert.equal(env.runtime.state().fault, null);
  assert.equal(motor.hw.owned, false);
});
test("uncertain stop survives disconnect/reset and only fresh clean reconnect resolves it", async () => {
  let motor = fakeMotor({ stopConfirmed: false }); motor.hw.homed = true;
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("arm"); await env.action("run"); await env.action("stop");
  assert.equal(env.runtime.state().unconfirmed_stop, true);
  await env.action("disconnect");
  await assert.rejects(env.action("reset"), /unconfirmed/);
  motor = fakeMotor(); await env.connect();
  assert.equal(env.runtime.state().unconfirmed_stop, false);
});
test("reconnect clears stop uncertainty only for inhibited output with bounded integer pending jitter", async () => {
  const cases = [
    ...[-2, -1, 1, 2].map(pending_raw => ({ label: `pending ${pending_raw}`, feedback: { pending_raw }, resolves: true })),
    ...[-3, 3, null, undefined, .5, "0"].map(pending_raw => ({ label: `pending ${String(pending_raw)}`, feedback: { pending_raw }, resolves: false })),
    { label: "nonzero PWM", feedback: { pending_raw: 1, pwm_raw: 1 }, resolves: false },
    { label: "pulse mode", feedback: { pending_raw: 1, mode: 0 }, resolves: false },
    { label: "enabled output", feedback: { pending_raw: 1, output_enabled: true }, resolves: false },
  ];
  for (const { label, feedback, resolves } of cases) {
    let motor = fakeMotor({ stopConfirmed: false }); motor.hw.homed = true;
    const env = setup({ factory: () => motor });
    await env.connect(); await env.action("arm"); await env.action("run"); await env.action("stop");
    assert.equal(env.runtime.state().unconfirmed_stop, true, label);
    await env.action("disconnect");
    motor = fakeMotor(); Object.assign(motor.hw, feedback);
    await env.connect();
    const state = env.runtime.state();
    assert.equal(state.unconfirmed_stop, !resolves, label);
    assert.equal(state.fault === null, resolves, label);
    assert.deepEqual(motor.calls, ["connect"], "recovery connection must remain read-only");
    if (!resolves) await assert.rejects(env.action("reset"), /unconfirmed/, label);
  }
});
test("manual Stop after twenty seconds prevents later targets", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("arm"); await env.action("run");
  for (let i = 0; i < 101; i++) {
    env.advance(.2); await env.action("heartbeat"); await env.runtime.tick();
  }
  assert.equal(env.runtime.state().running, true);
  await env.action("stop");
  const targetCount = motor.calls.filter(Array.isArray).length;
  env.advance(.2); await env.runtime.tick();
  assert.equal(motor.calls.filter(Array.isArray).length, targetCount);
  assert.equal(env.runtime.state().running, false);
  assert.ok(motor.calls.includes("stop"));
  assert.equal(env.runtime.state().fault, null);
});

test("hardware patterns continue beyond twenty seconds until explicit Stop", async () => {
 const motor=fakeMotor();motor.hw.homed=true;const env=setup({factory:()=>motor});
 await env.connect();await env.action('arm');await env.action('run');
 for(let i=0;i<900;i++){env.advance(.1);await env.action('heartbeat');await env.runtime.tick();}
 assert.equal(env.runtime.state().running,true);assert.equal(env.runtime.state().fault,null);
 assert.equal(env.runtime.state().run_remaining_s,null);assert.ok(motor.calls.filter(Array.isArray).length>500);
 await env.action('stop');assert.equal(env.runtime.state().running,false);assert.equal(env.runtime.state().hardware.stop_confirmed,true);
 await env.runtime.close();
});

test("scheduling and heartbeat failures still stop a long-running pattern", async () => {
  for (const [delay, message] of [[.3, /scheduling deadline/], [1.6, /heartbeat/]]) {
    const motor = fakeMotor(); motor.hw.homed = true;
    const env = setup({ factory: () => motor });
    await env.connect(); await env.action("arm"); await env.action("run");
    for (let i = 0; i < 390; i++) {
      env.advance(.05); await env.action("heartbeat"); await env.runtime.tick();
    }
    assert.equal(env.runtime.state().running, true);
    const commands = motor.calls.filter(Array.isArray).length;
    env.advance(delay); await env.runtime.tick();
    assert.equal(env.runtime.state().running, false);
    assert.match(env.runtime.state().fault, message);
    assert.equal(motor.calls.filter(Array.isArray).length, commands);
  }
});

test("Stop during connection preflight closes the candidate without installing it", async () => {
  const motor = fakeMotor(); let finishConnect;
  motor.connect = async function () { await new Promise(resolve => { finishConnect = resolve; }); this.hw.connected = true; return this.status(); };
  const env = setup({ factory: () => motor });
  const connection = env.connect(); await new Promise(setImmediate);
  const stop = env.action("stop"); finishConnect();
  await assert.rejects(connection, /stopped/); await stop;
  assert.equal(env.runtime.state().mode, "simulation");
  assert.equal(env.runtime.state().hardware, null);
  assert.equal(motor.hw.connected, false);
  assert.deepEqual(motor.calls, ["close"]);
});
test("pending preflight is fenced and pending stop is distinct from stopped", async () => {
  const motor = fakeMotor(); let finishHome, finishStop;
  motor.begin_home = async function () { await new Promise(resolve => { finishHome = resolve; }); return this.status(); };
  motor.stop = async function () { this.calls.push("stop"); await new Promise(resolve => { finishStop = resolve; }); return this.status(); };
  const env = setup({ factory: () => motor }); await env.connect();
  const home = env.action("home_start", { control_revision: env.runtime.state().control_revision });
  await new Promise(setImmediate);
  const stop = env.action("stop");
  assert.equal(env.runtime.state().stopping, true);
  assert.ok(motor.calls.includes("stop"));
  // Subsequent idempotent stop calls in the cancellation path can complete.
  motor.stop = async function () { return this.status(); };
  finishStop(); finishHome();
  await assert.rejects(home, /stopped/); await stop;
  assert.equal(env.runtime.state().stopping, false);
});
test("closing the runtime prevents reopening ports or restarting output", async () => {
  const env = setup(); await env.runtime.close();
  for (const name of ["arm", "run", "connect"]) await assert.rejects(env.action(name), /closed/);
  await assert.rejects(env.runtime.choosePort(), /closed/);
  assert.deepEqual(env.counts(), { choices: 0, opens: 0 });
});

test("default sine uses reported drive limits across a measured 180mm rail", async () => {
  const motor = fakeMotor(); motor.hw.homed = true; motor.hw.raw_bounds = [-71972, 71972];
  const env = setup({factory: () => motor});
  await env.connect(); await env.action("arm"); await env.action("run");
  const samples = [];
  for (let i = 0; i < 600; i++) {
    env.advance(.02); await env.action("heartbeat"); await env.runtime.tick();
    if(i > 200) samples.push(env.runtime.state().signal);
  }
  const span = Math.max(...samples.map(s => s.command)) - Math.min(...samples.map(s => s.command));
  assert.ok(span > .5, `Default pattern span was only ${span}`);
  assert.ok(samples.every(s => Math.abs(s.velocity) <= motor.hw.max_velocity_raw_s / 143944 + 1e-9));
  await env.action("stop");
});

test("USB disconnect releases old transport and reconnect never starts motion", async () => {
 const motors=[fakeMotor(),fakeMotor()],env=setup({factory:()=>motors.shift()});await env.connect();
 env.emit('disconnect',{port:env.port});await env.runtime.tick();
 assert.equal(env.runtime.state().hardware.connected,false);
 await env.connect();assert.equal(env.runtime.state().hardware.connected,true);
 assert.equal(env.runtime.state().armed,false);assert.equal(env.runtime.state().running,false);
 await env.runtime.close();
});
test("uncertain target recovery stops rather than freezing a moving trajectory or replaying points", async () => {
 const motor=fakeMotor();motor.hw.homed=true;const env=setup({factory:()=>motor});
 await env.connect();await env.action('arm');await env.action('run');
 const command=motor.command.bind(motor);motor.command=async target=>{const result=await command(target);env.advance(.35);motor.hw.communication_recoveries=1;return {...result,communication_recoveries:1};};
 env.advance(.1);await env.runtime.tick();env.advance(.02);await env.runtime.tick();
 assert.match(env.runtime.state().fault,/Serial recovery interrupted the continuous trajectory/);
 assert.equal(env.runtime.state().running,false);assert.equal(env.runtime.state().hardware.stop_confirmed,true);
 assert.equal(motor.calls.filter(c=>Array.isArray(c)&&c[0]==='command').length,1);
 await env.runtime.close();
});

test("guard recovery stops before generating a stale target even within the motion deadline", async () => {
 const motor=fakeMotor();motor.hw.homed=true;const env=setup({factory:()=>motor});let generated=0;
 motor.command=async resolve=>{env.advance(.01);motor.hw.communication_recoveries=1;resolve();generated++;return motor.status();};
 await env.connect();await env.action('play');env.advance(.05);await env.runtime.tick();
 assert.equal(generated,0);assert.equal(env.runtime.state().running,false);
 assert.match(env.runtime.state().fault,/Serial recovery interrupted the continuous trajectory/);
 assert.equal(env.runtime.state().hardware.stop_confirmed,true);await env.runtime.close();
});

test("hardware arming refuses a missing or invalid physical jerk limit", async () => {
 for(const limit of [undefined,0,-1,NaN,Infinity]) {
  const motor=fakeMotor();motor.hw.homed=true;motor.hw.max_jerk_raw_s3=limit;const env=setup({factory:()=>motor});
  await env.connect();await assert.rejects(env.action('play'),/motion limits are unavailable/);
  assert.equal(env.runtime.state().running,false);assert.ok(!motor.calls.includes('start'));await env.runtime.close();
 }
});

test("hardware samples after guards and starts the next cycle on completion without overlap", async () => {
  const {Engine} = require("../virtual_synth/static/browser-engine.js");
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor}), sent = [];
  let active = 0, maximumActive = 0;
  motor.command = async resolve => {
    maximumActive = Math.max(maximumActive, ++active);
    env.advance(.024);
    const position = resolve();
    sent.push({time: env.time(), position, signal: env.runtime.state().signal});
    env.advance(.021); active--;
    return motor.status();
  };
  await env.connect(); await env.action("play");
  for (let i = 0; i < 20; i++) { await env.action("heartbeat"); await env.runtime.tick(); }
  assert.equal(sent.length, 20); assert.equal(maximumActive, 1);
  const reference = new Engine(env.runtime.state().params), span = motor.hw.raw_bounds[1] - motor.hw.raw_bounds[0];
  reference.reset({position:motor.hw.position_normalized, vmax:motor.hw.max_velocity_raw_s/span,
    amax:motor.hw.max_acceleration_raw_s2/span, jmax:motor.hw.max_jerk_raw_s3/span});
  const wrap = phase => ((phase % 1) + 1) % 1;
  const origin = sent[0].signal.phase - sent[0].time * reference.params.rate_hz;
  for (let i = 0; i < sent.length; i++) {
    assert.ok(Math.abs(sent[i].time - (.024 + i * .045)) < 1e-9);
    const expected = reference.step(sent[i].time - (i ? sent[i-1].time : 0), {running:true, tracking:true});
    for (const key of ["command", "velocity", "acceleration", "planned_reference", "reference_phase"]) {
      assert.ok(Math.abs(sent[i].signal[key] - expected[key]) < 1e-9,
        `${key} samples the independently configured real planner after guard latency`);
    }
    assert.ok(Math.abs(sent[i].position - expected.command) < 1e-9);
    assert.ok(Math.abs(sent[i].signal.phase - wrap(origin + sent[i].time * reference.params.rate_hz)) < 1e-9,
      "phase includes each guard interval from its aligned startup origin");
  }
  env.advance(.004); await env.runtime.tick();
  assert.equal(sent.length, 21, "next fresh target is not held for an arbitrary deadline");
  await env.runtime.close();
});

test("a delayed guard cannot generate a catch-up target past the motion deadline", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor}); let generated = 0;
  motor.command = async resolve => { env.advance(.26); resolve(); generated++; return motor.status(); };
  await env.connect(); await env.action("play");
  env.advance(.05); await env.runtime.tick();
  assert.equal(generated, 0);
  assert.match(env.runtime.state().fault, /scheduling deadline/);
  assert.equal(env.runtime.state().running, false);
  assert.ok(motor.calls.includes("stop"));
  await env.runtime.close();
});

test("read recovery cannot bypass the pre-target motion deadline", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor}); let generated = 0;
  motor.command = async resolve => {
    env.advance(.35); motor.hw.communication_recoveries = 1;
    resolve(); generated++; return motor.status();
  };
  await env.connect(); await env.action("play");
  env.advance(.05); await env.runtime.tick();
  assert.equal(generated, 0);
  assert.match(env.runtime.state().fault, /scheduling deadline/);
  await env.runtime.close();
});

test("heartbeat is checked again after the guard read and before a target", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor}); let generated = 0;
  motor.command = async resolve => { env.advance(.1); resolve(); generated++; return motor.status(); };
  await env.connect(); await env.action("play");
  for (let i = 0; i < 14; i++) {
    env.advance(.1); await env.runtime.tick();
    if (env.runtime.state().fault) break;
  }
  assert.match(env.runtime.state().fault, /heartbeat/);
  assert.equal(env.runtime.state().running, false);
  await env.runtime.close();
});

test("Stop during a guard read fences the target resolver", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor}); let finishGuard, generated = 0;
  motor.command = async resolve => {
    await new Promise(done => { finishGuard = done; });
    resolve(); generated++; return motor.status();
  };
  await env.connect(); await env.action("play");
  env.advance(.05); const ticking = env.runtime.tick(); await new Promise(setImmediate);
  const stopped = env.runtime.stop(); finishGuard(); await ticking; await stopped;
  assert.equal(generated, 0);
  assert.equal(env.runtime.state().running, false);
  assert.equal(env.runtime.state().fault, null);
  await env.runtime.close();
});


test("pause verifies stop, freezes phase, and resumes with fresh encoder position", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("arm"); await env.action("run");
  env.advance(.1); await env.runtime.tick();
  await env.action("pause");
  assert.equal(env.runtime.state().paused, true);
  assert.equal(env.runtime.state().running, false);
  const phase = env.runtime.state().signal.phase;
  const referencePhase = env.runtime.state().signal.reference_phase;
  env.advance(2); await env.runtime.tick();
  assert.equal(env.runtime.state().signal.phase, phase);
  motor.hw.position_normalized = .53;
  await env.action("resume");
  assert.equal(env.runtime.state().running, true);
  assert.equal(env.runtime.state().paused, false);
  assert.equal(env.runtime.state().signal.phase, phase);
  assert.equal(env.runtime.state().signal.reference_phase, referencePhase);
  assert.equal(env.runtime.state().signal.command, .53, "Resume starts from the fresh stationary encoder");
  assert.equal(env.runtime.state().signal.velocity, 0);
  assert.equal(env.runtime.state().signal.acceleration, 0);
  env.advance(.06); await env.runtime.tick();
  const resumed = env.runtime.state().signal, span = motor.hw.raw_bounds[1] - motor.hw.raw_bounds[0];
  assert.ok(Number.isFinite(resumed.command) && resumed.command >= .1 && resumed.command <= .9);
  assert.ok(Math.abs(resumed.command - .53) <= .5 * motor.hw.max_acceleration_raw_s2 / span * .06 ** 2 + 1e-9,
    "resumed movement is bounded from the fresh encoder without a direction assumption");
  assert.notEqual(resumed.command, .53, "the resumed planner produces useful nonzero motion");
  assert.ok(Math.abs(resumed.phase - ((phase + env.runtime.state().params.rate_hz * .06) % 1)) < 1e-9);
  await env.action("stop");
  await assert.rejects(env.action("resume"), /paused/);
});

test("pause cannot resume when stop verification fails", async () => {
  const motor = fakeMotor({ stopConfirmed: false }); motor.hw.homed = true;
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("arm"); await env.action("run");
  await assert.rejects(env.action("pause"), /unconfirmed/);
  assert.equal(env.runtime.state().paused, false);
  await assert.rejects(env.action("resume"), /paused/);
});

test("automatic connection uses only a unique previously confirmed adapter", async () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k), setItem: (k,v) => store.set(k,v) };
  const port = { getInfo: () => ({ usbVendorId: 1027, usbProductId: 24577 }) };
  let available = [port], choices = 0;
  const motor = fakeMotor();
  const runtime = createRuntime({ autoStart: false, storage,
    serial: { getPorts: async () => available, requestPort: async () => { choices++; return port; } },
    transportFactory: () => motor });
  assert.equal(await runtime.autoConnect(), false);
  const selected = await runtime.choosePort();
  await runtime.request("/api/action", { action: "connect", port: selected });
  await runtime.request("/api/action", { action: "disconnect" });
  available = [port, { getInfo: port.getInfo }];
  assert.equal(await runtime.autoConnect(), false);
  available = [port];
  assert.equal(await runtime.autoConnect(), true);
  assert.equal(choices, 1);
  assert.equal(runtime.state().armed, false);
  assert.equal(runtime.state().running, false);
  await runtime.close();
});


test("paused simulation cannot switch adapters or bypass Home through Resume", async () => {
 const motor = fakeMotor(), env = setup({factory: () => motor});
 const selected = await env.runtime.choosePort();
 await env.action("arm"); await env.action("run"); await env.action("pause");
 await assert.rejects(env.action("arm"), /paused/);
 await assert.rejects(env.action("connect", {port:selected}), /Stop/);
 await env.action("stop"); await env.action("connect", {port:selected});
 await assert.rejects(env.action("resume"), /paused/);
 assert.equal(motor.calls.includes("start"), false);
});


test("Play combines fresh arming and starting while retaining Home requirement", async () => {
 const motor=fakeMotor(), env=setup({factory:()=>motor});
 await env.connect(); await assert.rejects(env.action("play"), /Home/);
 assert.equal(motor.calls.includes("start"),false);
 motor.hw.homed=true; await env.action("play");
 assert.deepEqual(motor.calls.slice(-2),["arm","start"]);
 assert.equal(env.runtime.state().running,true);
 await env.action("pause"); await assert.rejects(env.action("play"), /stopped/);
 await env.action("resume"); await env.action("stop");
 await env.action("play"); assert.equal(env.runtime.state().running,true);
 await env.runtime.close();
});

test("remembered adapter identity survives property order and concurrent discovery", async () => {
  const port = { getInfo: () => ({usbProductId:29987, usbVendorId:6790}) };
  const motor = fakeMotor(); let opens=0;
  const runtime=createRuntime({autoStart:false,
    storage:{getItem:()=>'{"usbVendorId":6790,"usbProductId":29987}',setItem:()=>{}},
    serial:{getPorts:async()=>[port],requestPort:async()=>port},
    transportFactory:()=>{opens++;return motor;}});
  assert.deepEqual(await Promise.all([runtime.autoConnect(),runtime.autoConnect()]),[true,true]);
  assert.equal(opens,1); assert.equal(runtime.state().running,false);
  await runtime.close();
});

test("empty or cancelled Chrome chooser gives actionable guidance without a motor fault", async () => {
  const error=new Error('No port selected');error.name='NotFoundError';
  const runtime=createRuntime({autoStart:false,serial:{getPorts:async()=>[],requestPort:async()=>{throw error;}}});
  await assert.rejects(runtime.choosePort(),{name:'NotFoundError'});
  assert.match(runtime.state().connection_notice,/unplug and reconnect USB/);
  assert.equal(runtime.state().fault,null);
  await runtime.close();
});

test("reattachment waits for disconnect cleanup before reconnecting", async () => {
  const store=new Map();
  const env=setup({factory:()=>fakeMotor(),storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}});
  await env.connect();
  env.emit('disconnect',{target:env.port});
  assert.equal(await env.runtime.autoConnect(),true);
  assert.equal(env.counts().opens,2);
  assert.equal(env.runtime.state().running,false);
  assert.equal(env.runtime.state().homing.valid,false);
  await env.runtime.close();
});

test("combined reply, scheduling and guard delays cannot bypass the 250 ms target deadline", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor}); let generated = 0;
  motor.command = async resolve => { env.advance(.1); resolve(); generated++; return motor.status(); };
  await env.connect(); await env.action("play");
  env.advance(.16); await env.runtime.tick();
  assert.equal(generated,0); assert.match(env.runtime.state().fault,/scheduling deadline/);
  assert.equal(env.runtime.state().running,false); await env.runtime.close();
});

test("automatic hardware loop exceeds 500 Hz fake completion rate and yields promptly to Stop without overlap", async () => {
  const motor = fakeMotor(); motor.hw.homed = true; motor.hw.baud = 115200;
  const port = {}, serial = {requestPort:async () => port,getPorts:async () => [port]};
  let now = 0, active = 0, maximumActive = 0, commands = 0, runtime, stopAt = null;
  let resolveStopped;
  const stopped = new Promise(resolve => {resolveStopped = resolve;});
  motor.command = async resolve => {
    maximumActive = Math.max(maximumActive,++active);
    now += .0005; resolve(); commands++; active--;
    if (commands === 160) setTimeout(() => {stopAt = commands; runtime.stop().then(resolveStopped);},0);
    return motor.status();
  };
  runtime = createRuntime({serial,clock: () => now,storage:null,transportFactory: () => motor});
  try {
    const action = (name, details={}) => runtime.request("/api/action",{action:name,...details});
    await action("connect",{port:await runtime.choosePort()});
    const automaticBegan = performance.now(); await action("play");
    let timeout;
    try { await Promise.race([stopped,new Promise((_,reject) => {timeout = setTimeout(() => reject(new Error("automatic loop did not yield to Stop")),2000);})]); }
    finally {clearTimeout(timeout);}
    assert.ok(commands >= 160 && commands <= 416,"timer Stop is serviced within bounded task batches"); assert.ok(commands / now > 500,"no automatic10ms or nested target timer ceiling");
    assert.ok(commands / ((performance.now() - automaticBegan) / 1000) > 500,"automatic scheduler permits >500 actual fake completions/s");
    assert.equal(maximumActive,1); assert.equal(commands,stopAt,"Stop fences all further target generation");
    await new Promise(resolve => setTimeout(resolve,15)); assert.equal(commands,stopAt);
    assert.equal(runtime.state().running,false); assert.equal(runtime.state().fault,null);
  } finally {await runtime.close();}
});

test("automatic yields measure synchronous planning rather than time awaiting native replies", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const filename = path.join(__dirname, "../virtual_synth/static/browser-runtime.js");
  const engineAPI = require("../virtual_synth/static/browser-engine.js");
  for (const plannerMs of [0, 2]) {
    let wallMs = 0, commands = 0, extraTasks = 0, runtime;
    class TimedEngine extends engineAPI.Engine {
      step(dt, controls) { wallMs += plannerMs; return super.step(dt, { ...controls }); }
      reset(options) { return super.reset({ ...options }); }
      configure(params) { return super.configure({ ...params }); }
    }
    class Channel {
      constructor() {
        this.port1 = { unref() {}, close() {} };
        this.port2 = { unref() {}, close() {}, postMessage: () => {
          extraTasks++; setImmediate(() => this.port1.onmessage());
        } };
      }
    }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, require: name => {
        assert.equal(name, "./browser-engine.js");
        return { ...engineAPI, Engine: TimedEngine };
      },
      performance: { now: () => wallMs }, structuredClone, queueMicrotask,
      MessageChannel: Channel, clearTimeout,
      setTimeout(fn, ms) { if (ms === 0) extraTasks++; return setTimeout(fn, ms); },
    }, { filename });
    const motor = fakeMotor(); motor.hw.homed = true;
    const port = {}, serial = { requestPort: async () => port, getPorts: async () => [port] };
    let resolveStopped;
    const stopped = new Promise(resolve => { resolveStopped = resolve; });
    motor.command = async resolveTarget => {
      resolveTarget();
      // Native receive completion is an event-loop task. Its elapsed time must
      // not be charged to the synchronous planner responsiveness budget.
      await new Promise(setImmediate); wallMs += 5;
      if (++commands === 31) queueMicrotask(() => runtime.stop().then(resolveStopped));
      return motor.status();
    };
    runtime = module.exports.createRuntime({ serial, clock: () => wallMs / 1000,
      storage: null, transportFactory: () => motor });
    let deadline;
    try {
      await runtime.request("/api/action", { action: "connect", port: await runtime.choosePort() });
      await runtime.request("/api/action", { action: "play" });
      await Promise.race([stopped, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Reply-driven loop did not stop")), 2000);
      })]);
      assert.equal(commands, 31);
      if (plannerMs === 0) assert.equal(extraTasks, 0, "native reply awaits already yield to event-loop tasks");
      else assert.ok(extraTasks >= 15, "expensive synchronous planning still forces responsive task yields");
      assert.equal(runtime.state().running, false); assert.equal(runtime.state().fault, null);
    } finally { clearTimeout(deadline); await runtime.close(); }
  }
});

test("fast hardware history stays around 50 Hz over ten seconds instead of every transaction", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({factory: () => motor});
  await env.connect(); await env.action("play");
  for (let i = 0; i < 2400; i++) {
    env.advance(.005); if (i % 40 === 0) await env.action("heartbeat"); await env.runtime.tick();
  }
  const history = env.runtime.state().history;
  assert.ok(history.length >= 490 && history.length <= 501);
  assert.ok(history.at(-1).t - history[0].t >= 9.9);
  assert.ok(history.slice(1).every((sample,index) => sample.t - history[index].t >= .0199));
  assert.equal(motor.calls.filter(Array.isArray).length,2400);
  await env.runtime.close();
});
