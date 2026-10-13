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

async function display(state) {
  const nodes = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), ([, id]) => [id, new Element()]));
  const intervals = [], requests = [];
  const document = {
    hidden: false, activeElement: null,
    getElementById(id) { assert.ok(nodes.has(id), `Missing UI element: ${id}`); return nodes.get(id); },
    querySelectorAll: () => [], querySelector: () => new Element(),
    createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
    createElementNS: () => new Element(), addEventListener() {},
  };
  const runtime = {
    supported: true, state: () => state, autoConnect: async () => false,
    async request(route) {
      requests.push(route);
      if (route === "/api/session") return { token: "test-session" };
      assert.equal(route, "/api/state");
      return state;
    },
  };
  const context = vm.createContext({
    document, window: { addEventListener() {}, devicePixelRatio: 1 },
    MotionBrowserRuntime: runtime, performance: { now: () => 100 },
    ResizeObserver: class { observe() {} }, requestAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
  });
  vm.runInContext(script, context, { filename: "app.js" });
  await new Promise(setImmediate);
  assert.equal(nodes.get("notice").textContent, "", "UI startup must succeed");
  assert.ok(requests.length >= 2);
  return { node: id => nodes.get(id), async refresh() { await intervals[0](); } };
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
