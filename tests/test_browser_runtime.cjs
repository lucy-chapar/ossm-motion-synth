// SPDX-License-Identifier: MPL-2.0
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntime } = require("../virtual_synth/static/browser-runtime.js");

function setup({ supported = true, factory } = {}) {
  let now = 0, choices = 0, opens = 0;
  const port = { getInfo: () => ({ usbVendorId: 1027, usbProductId: 24577 }) };
  const listeners = {};
  const serial = supported ? { addEventListener: (name,fn)=>{listeners[name]=fn;}, removeEventListener: ()=>{}, getPorts: async () => [port], requestPort: () => { choices++; return Promise.resolve(port); } } : null;
  const runtime = createRuntime({ serial, clock: () => now, autoStart: false,
    transportFactory: (selected) => { assert.equal(selected, port); opens++; return factory(); } });
  const action = (name, details = {}) => runtime.request("/api/action", { action: name, ...details });
  return { runtime, action, advance: (dt) => { now += dt; }, time: () => now, port,
    emit: (name,event)=>listeners[name]?.(event), counts: () => ({ choices, opens }), async connect() { const chosen = await runtime.choosePort(); return action("connect", { port: chosen }); } };
}
function fakeMotor({ stopConfirmed = true } = {}) {
  const hw = { connected: false, mode: 1, output_enabled: false, pending_raw: 0, pwm_raw: 0,
    owned: false, running: false, armed: false, homing: false, homed: false, fault: null,
    position_normalized: 0.5, max_velocity_raw_s: 73728, max_acceleration_raw_s2: 147456, stop_confirmed: true, raw_bounds: [-9830, 9830] };
  const calls = [];
  return { calls, hw, status: () => ({ ...hw }),
    async connect() { calls.push("connect"); hw.connected = true; return this.status(); },
    async snapshot() { calls.push("read"); return this.status(); },
    async begin_home() { calls.push("home"); hw.homing = hw.owned = true; return this.status(); },
    async poll_home() { calls.push("poll_home"); hw.homing = hw.owned = false; hw.homed = true; return this.status(); },
    async arm() { calls.push("arm"); hw.armed = true; return this.status(); },
    async start() { calls.push("start"); hw.running = hw.owned = true; hw.stop_confirmed = false; return this.status(); },
    async command(position) { calls.push(["command", position]); return this.status(); },
    async stop() { calls.push("stop"); hw.running = hw.armed = hw.homing = false; hw.stop_confirmed = stopConfirmed; hw.owned = !stopConfirmed; return this.status(); },
    async close() { calls.push("close"); hw.connected = false; return this.status(); } };
}

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
    for (let i = 0; i < 78; i++) {
      env.advance(.25); await env.action("heartbeat"); await env.runtime.tick();
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
test("reply recovery pauses time instead of faulting or generating catch-up targets", async () => {
 const motor=fakeMotor();motor.hw.homed=true;const env=setup({factory:()=>motor});
 await env.connect();await env.action('arm');await env.action('run');
 const command=motor.command.bind(motor);motor.command=async target=>{env.advance(.35);motor.hw.communication_recoveries=1;return command(target);};
 env.advance(.1);await env.runtime.tick();env.advance(.02);await env.runtime.tick();
 assert.equal(env.runtime.state().fault,null);assert.equal(env.runtime.state().running,true);await env.runtime.close();
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
  env.advance(2); await env.runtime.tick();
  assert.equal(env.runtime.state().signal.phase, phase);
  motor.hw.position_normalized = .53;
  await env.action("resume");
  assert.equal(env.runtime.state().running, true);
  assert.equal(env.runtime.state().paused, false);
  assert.equal(env.runtime.state().signal.phase, phase);
  env.advance(.06); await env.runtime.tick();
  assert.ok(env.runtime.state().signal.command > .52);
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
