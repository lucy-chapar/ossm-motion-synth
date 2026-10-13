// SPDX-License-Identifier: MPL-2.0
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const assets = path.join(__dirname, "../virtual_synth/static");
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8");
const script = fs.readFileSync(path.join(assets, "app.js"), "utf8");

class Element {
  constructor() {
    this.textContent = ""; this.value = ""; this.dataset = {}; this.hidden = false;
    this.children = []; this.parentElement = this; this.lastChild = { textContent: "" };
    this.style = { setProperty() {} };
    this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
  getContext() { return null; }
  getBoundingClientRect() { return { width: 500, height: 200, left: 0, top: 0 }; }
}

async function display(state, { closeProtection = () => false } = {}) {
  const nodes = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), ([, id]) => [id, new Element()]));
  const intervals = [], requests = [], windowEvents = new Map();
  const document = {
    hidden: false, activeElement: null,
    getElementById(id) { assert.ok(nodes.has(id), `Missing UI element: ${id}`); return nodes.get(id); },
    querySelectorAll: () => [], querySelector: () => new Element(),
    createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
    createElementNS: () => new Element(), addEventListener() {},
  };
  const runtime = {
    supported: true, state: () => state, autoConnect: async () => false,
    get mustStopBeforeClose() { return closeProtection(); },
    async stop() { requests.push("/api/action:stop"); return state; },
    async request(route) {
      requests.push(route);
      if (route === "/api/session") return { token: "test-session" };
      assert.equal(route, "/api/state");
      return state;
    },
  };
  const context = vm.createContext({
    document, window: { addEventListener(name, listener) { windowEvents.set(name, listener); }, devicePixelRatio: 1 },
    MotionBrowserRuntime: runtime, performance: { now: () => 100 },
    ResizeObserver: class { observe() {} }, requestAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
  });
  vm.runInContext(script, context, { filename: "app.js" });
  await new Promise(setImmediate);
  assert.equal(nodes.get("notice").textContent, "", "UI startup must succeed");
  assert.ok(requests.length >= 2);
  return { node: id => nodes.get(id), requests,
    windowEvent(name, event) { assert.ok(windowEvents.has(name)); return windowEvents.get(name)(event); },
    async refresh() { await intervals[0](); } };
}

function state({ mode = "hardware", signal = {}, params = {}, hardware = {} } = {}) {
  return {
    mode, running: true, armed: true, allow_motion: true, gate: false, history: [],
    homing: { valid: true, active: false },
    params: { rate_hz: 1.08, stroke: .62, center: .5, lower: .1, upper: .9,
      shape: "sine", patches: [], ...params },
    signal: { command: .5, requested: .5, ...signal },
    hardware: { connected: true, nominal_counts_per_mm: 819.2,
      raw_bounds: [-81920, 81920], ...hardware },
  };
}

test("calibrated hardware displays requested distance and the retimed phase rate", async () => {
  const sample = state({ signal: { requested_span_normalized: .496, planned_rate_hz: .78,
    effective_rate_hz: 1.08, rate_limited: true, center_limited_stroke: false, limited: true } });
  const ui = await display(sample);
  assert.equal(ui.node("motion-readout").textContent, "Requested travel ≈ 99.2 mm · Planned rate 0.78 Hz");
  assert.equal(ui.node("limiter-status").textContent, "RATE LIMITED");
  assert.equal(ui.node("motion-limit-reason").textContent, "Rate reduced to preserve stroke");
  assert.ok(ui.node("limiter-status").classes.has("limited"));
  sample.signal.rate_limited = false;
  sample.signal.limited = false;
  await ui.refresh();
  assert.equal(ui.node("limiter-status").textContent, "COMMAND IN RANGE");
  assert.equal(ui.node("motion-limit-reason").hidden, true);
  assert.equal(ui.node("limiter-status").classes.has("limited"), false);
});

test("transient tracking and center contraction are explained separately from rate limiting", async () => {
  const ui = await display(state({ signal: { requested_span_normalized: .07936,
    planned_rate_hz: 1.08, rate_limited: false, center_limited_stroke: true, limited: true } }));
  assert.equal(ui.node("limiter-status").textContent, "TRANSITION LIMITED");
  assert.equal(ui.node("motion-limit-reason").textContent,
    "Motion limited at transitions · Center near an end reduces stroke");
  assert.equal(ui.node("motion-readout").textContent, "Requested travel ≈ 15.9 mm · Planned rate 1.08 Hz");
});

test("simulation uses percentage travel and legacy states never claim an executed rate", async () => {
  const simulated = await display(state({ mode: "simulation", signal: {
    requested_span_normalized: .56, planned_rate_hz: .25, center_limited_stroke: false } }));
  assert.equal(simulated.node("motion-readout").textContent, "Requested travel 56.0% · Planned rate 0.25 Hz");
  const legacy = await display(state({ params: { center: .08 }, hardware: {
    nominal_counts_per_mm: null, raw_bounds: null }, signal: { effective_rate_hz: 1.08 } }));
  assert.equal(legacy.node("motion-readout").textContent, "Requested travel 7.9% · Requested rate 1.08 Hz");
  assert.equal(legacy.node("motion-limit-reason").textContent, "Center near an end reduces stroke");
});

test("a Position patch names its motion source instead of the bypassed carrier rate", async () => {
  const ui = await display(state({ signal: { position_patched: true,
    requested_span_normalized: .28, planned_rate_hz: null, effective_rate_hz: 1.08 } }));
  assert.equal(ui.node("motion-readout").textContent,
    "Requested travel ≈ 56.0 mm · Position patch controls motion");
});

test("measured command cadence is distinct from motion frequency and unavailable telemetry stays unknown", async () => {
  const sample = state({hardware: {baud:115200, command_reply_rate_hz:176.73},
    signal: {planned_rate_hz:.78, requested_span_normalized:.496}});
  const ui = await display(sample);
  assert.equal(ui.node('serial-baud').textContent,'115200');
  assert.equal(ui.node('command-rate').textContent,'177/s');
  assert.equal(ui.node('command-rate-label').textContent,'Command updates');
  assert.match(ui.node('motion-readout').textContent,/Planned rate 0.78 Hz/);
  sample.running = false; await ui.refresh();
  assert.equal(ui.node('command-rate-label').textContent,'Last command updates');
  sample.hardware.command_reply_rate_hz = null; sample.hardware.baud = null;
  await ui.refresh();
  assert.equal(ui.node('command-rate').textContent,'—');
  assert.equal(ui.node('serial-baud').textContent,'—');
});

function verifiedStoppedState() {
  const sample = state({hardware:{stop_confirmed:true, output_enabled:false,
    pending_raw:0, pwm_raw:0, alarm:0, owned:false, running:false}});
  Object.assign(sample,{running:false, armed:false, stopping:false, unconfirmed_stop:false});
  return sample;
}

test("USB disconnection hides live status while keeping cleanup, reconnect and retained fault history",async()=>{
  const sample=verifiedStoppedState();
  sample.hardware.device="USB adapter";sample.hardware.command_trace_count=10;
  sample.history=[{t:0,actual:.4,command:.4},{t:.02,actual:.5,command:.5}];
  const history=JSON.stringify(sample.history),ui=await display(sample);
  assert.match(ui.node("hardware-status").textContent,/^Connected:/);
  assert.equal(ui.node("hardware-metrics").hidden,false);
  assert.equal(ui.node("run-button").disabled,false);
  assert.equal(ui.node("show-motion-diagnostics").disabled,false);
  ui.node("motion-diagnostics-json").textContent="old run";ui.node("motion-diagnostics-json").hidden=false;
  sample.hardware.connected=false;sample.fault="USB serial adapter disconnected. Reconnect to continue.";
  await ui.refresh();
  assert.match(ui.node("hardware-status").textContent,/^No USB connection\./);
  assert.match(ui.node("transport-message").textContent,/No USB connection.*Home/);
  assert.equal(ui.node("disconnect-button").disabled,false,"the remaining session can still be cleaned up");
  for(const id of ["connect-button","port-select","refresh-ports"]) assert.equal(ui.node(id).disabled,false,id);
  assert.equal(ui.node("hardware-metrics").hidden,true);
  for(const id of ["show-motion-diagnostics","save-motion-diagnostics"]) {
    assert.equal(ui.node(id).hidden,true,id);assert.equal(ui.node(id).disabled,true,id);
  }
  assert.equal(ui.node("motion-diagnostics-json").hidden,true);assert.equal(ui.node("motion-diagnostics-json").textContent,"");
  assert.equal(ui.node("home-button").disabled,true);assert.equal(ui.node("run-button").disabled,true);
  assert.equal(ui.node("stop-confirmed").textContent,"No feedback");
  assert.equal(sample.hardware.stop_confirmed,true,"rendering does not rewrite the retained historical Stop evidence");
  assert.equal(ui.node("fault-notice").hidden,false);assert.match(ui.node("fault-text").textContent,/USB serial adapter disconnected/);
  assert.equal(ui.node("scope-empty").hidden,true);assert.equal(ui.node("actual-legend").hidden,false);
  assert.equal(JSON.stringify(sample.history),history,"disconnect display preserves the recorded scope");
  sample.fault=null;await ui.refresh();
  assert.equal(ui.node("run-button").disabled,true,"stale Home validity cannot authorize Play on a lost link");
  sample.hardware.connected=true;sample.homing.valid=false;await ui.refresh();
  assert.equal(ui.node("home-button").disabled,false);assert.equal(ui.node("run-button").disabled,true,"new connection still requires Home");
  sample.homing.valid=true;await ui.refresh();
  assert.equal(ui.node("run-button").disabled,false);assert.equal(ui.node("stop-confirmed").textContent,"Confirmed");
});

test("beforeunload uses pending-owner protection even when the last displayed state is stopped",async()=>{
  const sample=verifiedStoppedState();let protectedOwner=false;
  const ui=await display(sample,{closeProtection:()=>protectedOwner});
  const before=ui.requests.length;
  function closing() {
    return {prevented:false,returnValue:undefined,preventDefault(){this.prevented=true;}};
  }
  const idle=closing();ui.windowEvent("beforeunload",idle);
  assert.equal(idle.prevented,false);assert.equal(idle.returnValue,undefined);
  // A Play/Home request can be pending while the UI still displays this Stop.
  protectedOwner=true;
  const pending=closing();ui.windowEvent("beforeunload",pending);
  assert.equal(pending.prevented,true);assert.equal(pending.returnValue,"");
  assert.equal(ui.node("stop-confirmed").textContent,"Confirmed");
  assert.equal(ui.requests.length,before,"a close prompt does not claim or request Stop");
  protectedOwner=false;
  const stopped=closing();ui.windowEvent("beforeunload",stopped);
  assert.equal(stopped.prevented,false);assert.equal(stopped.returnValue,undefined);
  ui.windowEvent("pagehide",{});await Promise.resolve();
  assert.equal(ui.requests.at(-1),"/api/action:stop","actual pagehide keeps best-effort Stop");
});

test("verified Stop remains Confirmed after a latched following fault while motion stays locked", async () => {
  const sample = verifiedStoppedState();
  sample.fault = "RS485: Tracking error exceeded the motion budget for three fresh samples";
  sample.hardware.fault = "TransportError: Tracking error exceeded the motion budget for three fresh samples";
  const ui = await display(sample);
  assert.equal(ui.node("stop-confirmed").textContent,"Confirmed");
  assert.equal(ui.node("stop-confirmed").classes.has("unconfirmed"),false);
  assert.equal(ui.node("fault-notice").hidden,false);
  assert.match(ui.node("fault-text").textContent,/Tracking error/);
  assert.equal(ui.node("run-button").disabled,true);
  assert.equal(ui.node("home-button").disabled,true);
});

test("Stop display accepts the transport's two-count pending tolerance but rejects contradictory or unknown evidence", async () => {
  const sample = verifiedStoppedState(), ui = await display(sample);
  for (const pending of [-2,-1,0,1,2]) {
    sample.hardware.pending_raw = pending; await ui.refresh();
    assert.equal(ui.node("stop-confirmed").textContent,"Confirmed",`stationary pending ${pending}`);
  }
  for (const pending of [-3,3,.5,"0",null,undefined,NaN,Infinity]) {
    sample.hardware.pending_raw = pending; await ui.refresh();
    assert.equal(ui.node("stop-confirmed").textContent,"Unconfirmed",`invalid pending ${String(pending)}`);
  }
  sample.hardware.pending_raw = 0;
  const contradictions = [
    [sample.hardware,"stop_confirmed",false], [sample.hardware,"stop_confirmed",undefined],
    [sample.hardware,"output_enabled",true], [sample.hardware,"output_enabled",null],
    [sample.hardware,"pwm_raw",1], [sample.hardware,"alarm",1], [sample.hardware,"alarm",null],
    [sample.hardware,"owned",true], [sample.hardware,"running",true],
    [sample,"running",true], [sample,"unconfirmed_stop",true], [sample,"stopping",true],
  ];
  for (const [object,key,value] of contradictions) {
    const original = object[key]; object[key] = value; await ui.refresh();
    assert.equal(ui.node("stop-confirmed").textContent,"Unconfirmed",`${key}=${String(value)}`);
    assert.equal(ui.node("stop-confirmed").classes.has("unconfirmed"),true);
    object[key] = original;
  }
  await ui.refresh(); assert.equal(ui.node("stop-confirmed").textContent,"Confirmed");
});
