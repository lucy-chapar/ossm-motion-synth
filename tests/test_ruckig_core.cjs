/* SPDX-License-Identifier: MPL-2.0 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const core = require("../virtual_synth/static/ruckig-core.js");

const root = path.resolve(__dirname, "..");
const state = (position, velocity, acceleration) => ({ position, velocity, acceleration });
const limits = { vmax: 30, amax: 20, jmax: 100 };
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const nearState = (actual, expected) => {
  for (const key of ["position", "velocity", "acceleration"]) near(actual[key], expected[key]);
};
function withinBounds(trajectory, constraints, steps = 2000) {
  let previous = trajectory.sample(0);
  for (let index = 1; index <= steps; index++) {
    const time = trajectory.duration * index / steps;
    const point = trajectory.sample(time);
    assert.ok(Math.abs(point.velocity) <= constraints.vmax + 1e-8);
    assert.ok(Math.abs(point.acceleration) <= constraints.amax + 1e-8);
    assert.ok(Math.abs(point.jerk) <= constraints.jmax + 1e-8);
    assert.ok(Math.abs(point.acceleration - previous.acceleration) <= constraints.jmax * trajectory.duration / steps + 1e-8);
    assert.ok(point.position >= trajectory.minPosition - 1e-8 && point.position <= trajectory.maxPosition + 1e-8);
    previous = point;
  }
}

test("local WASM preserves nonzero initial and terminal velocity and acceleration", () => {
  const planner = new core.Planner();
  try {
    const start = state(0, 10, 2), target = state(20, 15, -1);
    const trajectory = planner.calculate(start, target, limits);
    nearState(trajectory.sample(0), start);
    nearState(trajectory.sample(trajectory.duration), target);
    assert.ok(trajectory.sample(trajectory.duration / 2).velocity > 10);
    withinBounds(trajectory, limits);
  } finally { planner.dispose(); }
});

test("compatible same-direction waypoint keeps nonzero velocity across two C2 trajectories", () => {
  const planner = new core.Planner();
  try {
    const waypoint = state(20, 15, -1);
    const first = planner.calculate(state(0, 10, 2), waypoint, limits).snapshot();
    try {
      const second = planner.calculate(waypoint, state(40, 12, 2), limits);
      nearState(first.sample(first.duration), second.sample(0));
      const epsilon = 1e-6;
      near(first.sample(first.duration - epsilon).velocity, second.sample(epsilon).velocity, 1e-4);
      near(first.sample(first.duration - epsilon).acceleration, second.sample(epsilon).acceleration, 3e-4);
      assert.ok(first.sample(first.duration).velocity > 0);
      withinBounds(second, limits);
    } finally { first.dispose(); }
  } finally { planner.dispose(); }
});

test("minimumDuration is a lower bound without zeroing endpoint derivatives", () => {
  const planner = new core.Planner();
  try {
    const start = state(0, 10, 2), target = state(20, 15, -1);
    const minimum = planner.calculate(start, target, limits).duration;
    const trajectory = planner.calculate(start, target, { ...limits, minimumDuration: 3 });
    assert.ok(trajectory.duration >= 3 - 1e-12 && trajectory.duration > minimum);
    nearState(trajectory.sample(trajectory.duration), target);
    withinBounds(trajectory, limits);
  } finally { planner.dispose(); }
});

test("reversal extrema include initial momentum overshoot and bound every sampled position", () => {
  const planner = new core.Planner();
  try {
    const start = state(0, 12, 3), target = state(-20, -4, -2);
    const trajectory = planner.calculate(start, target, limits);
    assert.ok(trajectory.maxPosition > start.position);
    near(trajectory.sample(trajectory.maxPositionTime).position, trajectory.maxPosition);
    near(trajectory.sample(trajectory.minPositionTime).position, trajectory.minPosition);
    nearState(trajectory.sample(trajectory.duration), target);
    withinBounds(trajectory, limits);
  } finally { planner.dispose(); }
});

test("braking uses velocity control and includes nonzero acceleration plus jerk ramps", () => {
  const planner = new core.Planner();
  try {
    const current = state(0, 20, 5);
    const stop = planner.brake(current, limits);
    // Integrate the independent three-stage stop: jerk -100, acceleration -20, jerk +100.
    const t1 = (current.acceleration + limits.amax) / limits.jmax;
    const v1 = current.velocity + current.acceleration * t1 - limits.jmax * t1 * t1 / 2;
    const t3 = limits.amax / limits.jmax;
    const v2 = limits.amax * t3 / 2;
    const t2 = (v1 - v2) / limits.amax;
    const p1 = current.velocity * t1 + current.acceleration * t1 * t1 / 2 - limits.jmax * t1 ** 3 / 6;
    const p2 = v1 * t2 - limits.amax * t2 * t2 / 2;
    const p3 = v2 * t3 - limits.amax * t3 * t3 / 2 + limits.jmax * t3 ** 3 / 6;
    near(stop.duration, t1 + t2 + t3);
    near(stop.maxPosition, p1 + p2 + p3);
    assert.ok(stop.maxPosition > current.velocity ** 2 / (2 * limits.amax));
    nearState(stop.sample(stop.duration), state(p1 + p2 + p3, 0, 0));
    withinBounds(stop, limits);
    const negative = planner.brake(state(0, -20, -5), limits);
    near(negative.minPosition, -(p1 + p2 + p3));
    near(negative.duration, t1 + t2 + t3);
    withinBounds(negative, limits);
  } finally { planner.dispose(); }
});

test("braking does not overwrite the active position trajectory", () => {
  const planner = new core.Planner();
  try {
    const trajectory = planner.calculate(state(0, 10, 2), state(20, 15, -1), limits);
    const duration = trajectory.duration, middle = trajectory.sample(duration / 2);
    planner.brake(middle, limits);
    near(trajectory.duration, duration);
    nearState(trajectory.sample(duration / 2), middle);
    assert.equal(planner.calculate(state(0, 5, 0), state(5, 2, 0), limits), trajectory);
  } finally { planner.dispose(); }
});

test("braking extrema preserve nonzero origins, including stationary zero-duration states", () => {
  const planner = new core.Planner();
  try {
    for (const origin of [.5, 12, -12]) {
      const stationary = planner.brake(state(origin, 0, 0), limits);
      near(stationary.duration, 0);
      near(stationary.minPosition, origin);
      near(stationary.maxPosition, origin);
      nearState(stationary.sample(0), state(origin, 0, 0));
      const moving = planner.brake(state(origin, .01, 0), limits);
      near(moving.minPosition, origin);
      assert.ok(moving.maxPosition > origin);
      near(moving.sample(moving.duration).position, moving.maxPosition);
      withinBounds(moving, limits);
      const reverse = planner.brake(state(origin, -.01, 0), limits);
      near(reverse.maxPosition, origin);
      assert.ok(reverse.minPosition < origin);
      withinBounds(reverse, limits);
    }
  } finally { planner.dispose(); }
});

test("analytic extrema enclose diverse PVA and braking profiles without synthetic origins", () => {
  const planner = new core.Planner();
  let seed = 0x57a1;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  try {
    for (let index = 0; index < 100; index++) {
      const current = state(10 + random() * 50, (random() - .5) * 30, (random() - .5) * 10);
      const target = state(10 + random() * 50, (random() - .5) * 20, (random() - .5) * 10);
      const trajectory = planner.calculate(current, target, limits);
      nearState(trajectory.sample(trajectory.duration), target);
      withinBounds(trajectory, limits, 250);
      near(trajectory.sample(trajectory.minPositionTime).position, trajectory.minPosition);
      near(trajectory.sample(trajectory.maxPositionTime).position, trajectory.maxPosition);
      const stop = planner.brake(current, limits);
      withinBounds(stop, limits, 250);
      near(stop.sample(stop.minPositionTime).position, stop.minPosition);
      near(stop.sample(stop.maxPositionTime).position, stop.maxPosition);
    }
    // An initial acceleration above the limit requires Ruckig's pre-brake segments.
    const recovery = planner.brake(state(20, 5, 25), limits);
    for (let index = 0; index <= 1000; index++) {
      const point = recovery.sample(recovery.duration * index / 1000);
      assert.ok(point.position >= recovery.minPosition - 1e-8 && point.position <= recovery.maxPosition + 1e-8);
    }
    nearState(recovery.sample(recovery.duration), state(recovery.sample(recovery.duration).position, 0, 0));
  } finally { planner.dispose(); }
});

test("online updates pass x/v/a forward and retarget without restarting at zero", () => {
  const planner = new core.Planner({ cycleTime: .002 });
  const reference = new core.Planner();
  try {
    const current = state(0, 10, 2), target = state(20, 15, -1);
    const trajectory = reference.calculate(current, target, limits);
    planner.reset(current);
    const first = planner.update(target, limits);
    nearState(first, trajectory.sample(.002));
    assert.equal(first.newCalculation, true);
    const second = planner.update(target, limits);
    nearState(second, trajectory.sample(.004));
    assert.equal(second.newCalculation, false);
    let previous = second;
    for (let index = 0; index < 100; index++) {
      const next = planner.update(state(21 + index * .01, 15, -1), limits);
      assert.ok(next.velocity > 0);
      assert.ok(Math.abs(next.acceleration - previous.acceleration) <= limits.jmax * .002 + 1e-9);
      assert.ok(Math.abs(next.velocity - previous.velocity) <= limits.amax * .002 + 1e-9);
      previous = next;
    }
  } finally { planner.dispose(); reference.dispose(); }
});

test("independent planners and retained snapshots remain valid across recalculation", () => {
  const one = new core.Planner(), two = new core.Planner();
  let snapshot;
  try {
    const trajectory = one.calculate(state(0, 10, 2), state(20, 15, -1), limits);
    snapshot = trajectory.snapshot();
    const expected = snapshot.sample(snapshot.duration);
    one.calculate(state(0, 0, 0), state(-50, 0, 0), limits);
    const other = two.calculate(state(3, 1, 0), state(4, 1, 0), limits);
    nearState(other.sample(other.duration), state(4, 1, 0));
    nearState(snapshot.sample(snapshot.duration), expected);
    one.dispose();
    assert.throws(() => trajectory.sample(0), /disposed/);
    nearState(snapshot.sample(snapshot.duration), expected);
    snapshot.dispose();
    assert.throws(() => snapshot.sample(0), /disposed/);
  } finally { one.dispose(); two.dispose(); snapshot?.dispose(); }
});

test("invalid or omitted target derivatives and invalid limits are rejected", () => {
  const planner = new core.Planner();
  try {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => planner.calculate(state(0, bad, 0), state(1, 0, 0), limits), RangeError);
    }
    assert.throws(() => planner.calculate(state(0, 0, 0), { position: 1 }, limits), /target.velocity/);
    assert.throws(() => planner.calculate(state(0, 0, 0), state(1, 31, 0), limits), /invalid input/);
    for (const key of ["vmax", "amax", "jmax"]) {
      assert.throws(() => planner.calculate(state(0, 0, 0), state(1, 0, 0), { ...limits, [key]: 0 }), /positive/);
    }
    assert.throws(() => planner.calculate(state(0, 0, 0), state(1, 0, 0), { ...limits, minimumDuration: -1 }), /nonnegative/);
    const trajectory = planner.calculate(state(0, 0, 0), state(1, 0, 0), limits);
    assert.throws(() => trajectory.sample(-.1), /outside/);
    assert.throws(() => trajectory.sample(trajectory.duration + .1), /outside/);
    assert.throws(() => trajectory.sample(NaN), /finite/);
    planner.dispose();
    assert.throws(() => planner.calculate(state(0, 0, 0), state(1, 0, 0), limits), /disposed/);
  } finally { planner.dispose(); }
});

test("browser adapter fetches only the sibling local WASM, then supports synchronous calls", async () => {
  const requested = [];
  const sandbox = {
    WebAssembly, URL, performance, console,
    document: { currentScript: { src: "https://local.example/apps/synth/ruckig-core.js?v=abc" } },
    location: { href: "https://local.example/apps/synth/" },
    fetch: async url => { requested.push(String(url)); return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(root, "virtual_synth/static/ruckig-core.wasm")) }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "virtual_synth/static/ruckig-core.js"), "utf8"), sandbox);
  assert.throws(() => new sandbox.MotionRuckig.Planner(), /not ready/);
  await sandbox.MotionRuckig.ready;
  assert.equal(requested.length, 1);
  assert.ok(requested[0].startsWith("https://local.example/apps/synth/ruckig-core.wasm?v="));
  const planner = new sandbox.MotionRuckig.Planner();
  try {
    const trajectory = planner.calculate(state(0, 10, 2), state(20, 15, -1), limits);
    nearState(trajectory.sample(trajectory.duration), state(20, 15, -1));
    assert.equal(typeof trajectory.duration, "number");
  } finally { planner.dispose(); }
});

test("pinned source and binary hashes match provenance, and WASM has no external I/O capability", () => {
  const vendor = path.join(root, "vendor/ruckig");
  const provenance = JSON.parse(fs.readFileSync(path.join(vendor, "provenance.json"), "utf8"));
  const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(provenance.version, "0.15.3");
  assert.equal(provenance.commit, "37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db");
  assert.equal(provenance.cloud_client, false);
  for (const [file, expected] of Object.entries(provenance.upstream_files)) assert.equal(hash(path.join(vendor, file)), expected, file);
  assert.equal(hash(path.join(vendor, "bindings.cpp")), provenance.bindings_sha256);
  assert.equal(hash(path.join(root, provenance.artifact.path)), provenance.artifact.sha256);
  const module = new WebAssembly.Module(fs.readFileSync(path.join(root, provenance.artifact.path)));
  assert.deepEqual(WebAssembly.Module.imports(module).map(entry => [entry.module, entry.name, entry.kind]), [
    ["wasi_snapshot_preview1", "clock_time_get", "function"],
    ["wasi_snapshot_preview1", "fd_close", "function"],
    ["wasi_snapshot_preview1", "fd_seek", "function"],
    ["wasi_snapshot_preview1", "fd_write", "function"],
  ]);
});
