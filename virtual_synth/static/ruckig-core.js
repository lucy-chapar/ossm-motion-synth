/* SPDX-License-Identifier: MPL-2.0 */
/* Local Ruckig Community 0.15.3 adapter; see vendor/ruckig for source and licenses. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("node:fs").readFileSync(require("node:path").join(__dirname, "ruckig-core.wasm")));
  } else {
    const script = root.document?.currentScript?.src || root.location.href;
    const api = factory();
    root.MotionRuckig = api;
    api.ready = root.fetch(new URL("ruckig-core.wasm?v=6473afda9e51", script))
      .then(response => { if (!response.ok) throw new Error(`Cannot load local Ruckig core: HTTP ${response.status}`); return response.arrayBuffer(); })
      .then(bytes => { api.init(bytes); return api; });
    api.ready.catch(() => {}); // A caller awaiting ready receives the original failure.
  }
})(globalThis, function (bytes) {
  "use strict";
  let activeRuntime = null;
  const errors = { "-1": "calculation failed", "-100": "invalid input state or limits", "-101": "trajectory duration exceeded", "-102": "position limits exceeded", "-110": "execution time calculation failed", "-111": "synchronization calculation failed" };
  const finite = (value, label) => { if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`); return value; };
  const stateValues = (state, label) => ["position", "velocity", "acceleration"].map(key => finite(state?.[key], `${label}.${key}`));
  const limitValues = limits => {
    const values = ["vmax", "amax", "jmax"].map(key => finite(limits?.[key], key));
    if (values.some(value => value <= 0)) throw new RangeError("vmax, amax and jmax must be positive");
    const minimum = finite(limits?.minimumDuration ?? 0, "minimumDuration");
    if (minimum < 0) throw new RangeError("minimumDuration must be nonnegative");
    return [...values, minimum];
  };
  const check = result => { if (result < 0) throw new RangeError(`Ruckig ${errors[result] || "error"} (${result})`); };
  const registry = typeof FinalizationRegistry === "function" ? new FinalizationRegistry(({ runtime, planner, plans }) => {
    for (const plan of plans) runtime.exports.ruckig_destroy_plan(plan);
    if (planner) runtime.exports.ruckig_destroy_planner(planner);
  }) : null;

  function instantiate(binary) {
    const wasmModule = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
    let instance;
    const wasi = {
      clock_time_get(_clock, _precision, pointer) {
        const now = globalThis.performance?.now() ?? Date.now();
        new DataView(instance.exports.memory.buffer).setBigUint64(pointer, BigInt(Math.floor(now * 1e6)), true);
        return 0;
      },
      fd_close: () => 8, fd_seek: () => 8, fd_write: () => 8, // EBADF; no host filesystem or output.
    };
    for (const entry of WebAssembly.Module.imports(wasmModule)) {
      if (entry.module !== "wasi_snapshot_preview1" || !Object.hasOwn(wasi, entry.name) || entry.kind !== "function") {
        throw new Error(`Unexpected Ruckig import: ${entry.module}.${entry.name}`);
      }
    }
    instance = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: wasi });
    instance.exports._initialize();
    return { exports: instance.exports, read: (pointer, count) => new Float64Array(instance.exports.memory.buffer, pointer, count), wasmModule };
  }

  class Trajectory {
    constructor(runtime, pointer, owner = null) {
      if (!pointer) throw new Error("Could not allocate Ruckig trajectory");
      this._runtime = runtime; this._pointer = pointer; this._owner = owner;
      if (!owner) registry?.register(this, { runtime, planner: 0, plans: [pointer] }, this);
    }
    _require() { if (!this._pointer || this._owner?._disposed) throw new Error("Ruckig trajectory disposed"); }
    _metadata() {
      this._require();
      const pointer = this._runtime.exports.ruckig_plan_metadata(this._pointer);
      if (!pointer) throw new Error("Ruckig trajectory has no valid calculation");
      return this._runtime.read(pointer, 5);
    }
    get duration() { return this._metadata()[0]; }
    get minPosition() { return this._metadata()[1]; }
    get maxPosition() { return this._metadata()[2]; }
    get minPositionTime() { return this._metadata()[3]; }
    get maxPositionTime() { return this._metadata()[4]; }
    sample(time) {
      const duration = this.duration;
      finite(time, "sample time");
      const tolerance = 1e-12 * Math.max(1, duration);
      if (time < -tolerance || time > duration + tolerance) throw new RangeError("Sample time is outside the trajectory");
      const pointer = this._runtime.exports.ruckig_sample(this._pointer, Math.max(0, Math.min(duration, time)));
      if (!pointer) throw new Error("Ruckig trajectory sample failed");
      const values = this._runtime.read(pointer, 4);
      return { position: values[0], velocity: values[1], acceleration: values[2], jerk: values[3] };
    }
    snapshot() {
      this._metadata();
      return new Trajectory(this._runtime, this._runtime.exports.ruckig_copy_plan(this._pointer));
    }
    dispose() {
      if (this._owner) throw new Error("Dispose the Planner that owns this trajectory");
      if (!this._pointer) return;
      registry?.unregister(this);
      this._runtime.exports.ruckig_destroy_plan(this._pointer); this._pointer = 0;
    }
  }

  class Planner {
    constructor({ cycleTime = 0.002 } = {}) {
      if (!activeRuntime) throw new Error("Local Ruckig core is not ready; await MotionRuckig.ready");
      finite(cycleTime, "cycleTime");
      if (cycleTime <= 0) throw new RangeError("cycleTime must be positive");
      this._runtime = activeRuntime;
      const native = this._runtime.exports;
      this._pointer = native.ruckig_create_planner(cycleTime);
      if (!this._pointer) throw new Error("Could not allocate Ruckig planner");
      this._disposed = false;
      this._position = new Trajectory(this._runtime, native.ruckig_create_plan(), this);
      this._velocity = new Trajectory(this._runtime, native.ruckig_create_plan(), this);
      registry?.register(this, { runtime: this._runtime, planner: this._pointer, plans: [this._position._pointer, this._velocity._pointer] }, this);
    }
    _require() { if (this._disposed) throw new Error("Ruckig planner disposed"); }
    _calculate(current, target, limits, velocityControl) {
      this._require();
      const input = stateValues(current, "current"), destination = stateValues(target, "target"), bounds = limitValues(limits);
      const trajectory = velocityControl ? this._velocity : this._position;
      check(this._runtime.exports.ruckig_calculate(this._pointer, trajectory._pointer, ...input, ...destination, ...bounds, velocityControl ? 1 : 0));
      return trajectory;
    }
    // Reuses the same trajectory handle on each call; snapshot() retains a copy.
    calculate(current, target, limits) { return this._calculate(current, target, limits, false); }
    calculateVelocity(current, target, limits) {
      return this._calculate(current, { position: current?.position, velocity: target?.velocity, acceleration: target?.acceleration }, limits, true);
    }
    brake(current, limits) { return this.calculateVelocity(current, { velocity: 0, acceleration: 0 }, limits); }
    reset(current) {
      this._require();
      check(this._runtime.exports.ruckig_reset(this._pointer, ...stateValues(current, "current")));
    }
    update(target, limits) {
      this._require();
      check(this._runtime.exports.ruckig_update(this._pointer, ...stateValues(target, "target"), ...limitValues(limits)));
      const values = this._runtime.read(this._runtime.exports.ruckig_state(this._pointer), 8);
      return { position: values[0], velocity: values[1], acceleration: values[2], jerk: values[3], time: values[4], duration: values[5], newCalculation: Boolean(values[6]), result: values[7] };
    }
    dispose() {
      if (this._disposed) return;
      registry?.unregister(this);
      const native = this._runtime.exports;
      native.ruckig_destroy_plan(this._position._pointer); native.ruckig_destroy_plan(this._velocity._pointer);
      native.ruckig_destroy_planner(this._pointer); this._disposed = true; this._pointer = 0;
    }
  }
  const api = { version: "0.15.3", Planner, Trajectory, init(binary) { activeRuntime = instantiate(binary); return api; }, get loaded() { return activeRuntime !== null; } };
  if (bytes) api.init(bytes);
  api.ready = Promise.resolve(api);
  return api;
});
