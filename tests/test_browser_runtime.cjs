// SPDX-License-Identifier: MPL-2.0
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntime } = require("../virtual_synth/static/browser-runtime.js");

function setup({ supported = true, factory } = {}) {
  let now = 0, choices = 0, opens = 0;
  const port = { getInfo: () => ({ usbVendorId: 1027, usbProductId: 24577 }) };
  const serial = supported ? { getPorts: async () => [port], requestPort: () => { choices++; return Promise.resolve(port); } } : null;
  const runtime = createRuntime({ serial, clock: () => now, autoStart: false,
    transportFactory: (selected) => { assert.equal(selected, port); opens++; return factory(); } });
  const action = (name, details = {}) => runtime.request("/api/action", { action: name, ...details });
  return { runtime, action, advance: (dt) => { now += dt; }, time: () => now, port,
    counts: () => ({ choices, opens }), async connect() { const chosen = await runtime.choosePort(); return action("connect", { port: chosen }); } };
}
function fakeMotor({ stopConfirmed = true } = {}) {
  const hw = { connected: false, mode: 1, output_enabled: false, pending_raw: 0, pwm_raw: 0,
    owned: false, running: false, armed: false, homing: false, homed: false, fault: null,
    position_normalized: 0.5, stop_confirmed: true, raw_bounds: [-9830, 9830] };
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
  assert.ok(command); assert.ok(Math.abs(command[1] - .5) < .003);
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
test("hardware duration limit stops without a late command", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({ factory: () => motor });
  await env.connect(); await env.action("arm"); await env.action("run");
  for (let i = 0; i < 101; i++) {
    env.advance(.2); await env.action("heartbeat"); await env.runtime.tick();
  }
  assert.equal(env.runtime.state().running, false);
  assert.ok(motor.calls.includes("stop"));
  assert.equal(env.runtime.state().fault, null);
});

test("normal run deadline includes the enabled hold and stops before the transport budget guard", async () => {
  const motor = fakeMotor(); motor.hw.homed = true;
  const env = setup({ factory: () => motor });
  let enabledAt, stoppedAt;
  const commandsAt = [], originalStop = motor.stop;
  motor.start = async function () {
    this.calls.push("start");
    env.advance(.4); // Readback and disabled hold happen before output enables.
    enabledAt = env.time();
    this.hw.running = this.hw.owned = true; this.hw.stop_confirmed = false;
    env.advance(.45); // Three enabled hold observations precede Start's return.
    this.hw.run_seconds = env.time() - enabledAt;
    return this.status();
  };
  motor.command = async function (position) {
    const elapsed = env.time() - enabledAt;
    if (20 - elapsed <= .155) throw new Error("20-second hardware run limit reached");
    commandsAt.push(elapsed); this.calls.push(["command", position]);
    env.advance(.07); // Model the read and write time of a hardware target.
    return this.status();
  };
  motor.stop = async function () { stoppedAt = env.time() - enabledAt; return originalStop.call(this); };
  await env.connect(); await env.action("arm"); await env.action("run");
  assert.ok(Math.abs(env.runtime.state().run_remaining_s - 19.25) < 1e-9);
  for (let i = 0; i < 250 && env.runtime.state().running; i++) {
    env.advance(.1); await env.action("heartbeat"); await env.runtime.tick();
  }
  const state = env.runtime.state();
  assert.equal(state.running, false); assert.equal(state.armed, false);
  assert.equal(state.fault, null); assert.equal(state.unconfirmed_stop, false);
  assert.equal(state.run_remaining_s, null);
  assert.ok(stoppedAt >= 19.7 && stoppedAt < 20);
  assert.ok(commandsAt.length > 0 && commandsAt.every(time => time < 19.7));
  assert.equal(motor.calls.filter(call => call === "stop").length, 1);
});

test("scheduling and heartbeat failures remain faults when they cross the normal run deadline", async () => {
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
