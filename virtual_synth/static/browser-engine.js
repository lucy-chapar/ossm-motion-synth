// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Python-compatible normalized preview plus continuous commanded PVA for the
// browser hardware path. Commanded state is not measured motor state; this
// module never opens a device. Hardware planning uses the local Ruckig core.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MotionBrowserEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_PARAMS = Object.freeze({
    rate_hz: .25, stroke: .7, center: .5, shape: "sine",
    attack_s: .8, release_s: 1.2, env_to_stroke: false,
    lfo_rate_hz: .07, lower: .1, upper: .9, patches: Object.freeze([]),
  });
  const NUMERIC_RANGES = {
    rate_hz: [.02, 4], stroke: [0, 1], center: [0, 1],
    attack_s: [.02, 10], release_s: [.02, 10],
    lfo_rate_hz: [.01, 4], lower: [0, .49], upper: [.51, 1],
  };
  const SHAPES = new Set(["sine", "triangle", "saw", "square"]);
  const SOURCES = new Set(["lfo", "envelope"]);
  const DESTINATIONS = new Set(["rate", "stroke", "center", "position"]);
  const MAX_VELOCITY = 3822 / 8192;
  const MAX_ACCELERATION = 1;
  const MAX_DT = .25;
  const REFERENCE_RESERVE = .95;
  const defaultJerk = acceleration => acceleration * (100000 / 6000);
  function ruckigAPI() {
    const api = typeof module === "object" && module.exports ? require("./ruckig-core.js") : globalThis.MotionRuckig;
    if (!api?.loaded) throw new Error("Local continuous motion core is not ready");
    return api;
  }

  function number(value, name, low, high) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
      throw new RangeError(`${name} must be a finite number in ${low}..${high}`);
    }
    return value;
  }
  function clamp(value, low = 0, high = 1) {
    return Math.min(high, Math.max(low, value));
  }
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function detached(value) {
    if (Array.isArray(value)) return value.map(detached);
    if (object(value)) {
      const result = {};
      for (const key of Object.keys(value)) {
        Object.defineProperty(result, key, {
          value: detached(value[key]), writable: true, enumerable: true, configurable: true,
        });
      }
      return result;
    }
    return value;
  }
  function wrapped(phase) {
    const result = phase % 1;
    return result === 0 ? 0 : result < 0 ? result + 1 : result;
  }
  function options(value, allowed, name) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
      throw new TypeError(`${name} must be an object containing only ${allowed.join(", ")}`);
    }
    return value;
  }

  function validateParams(changes, current = null) {
    const params = detached(DEFAULT_PARAMS);
    for (const values of [current === null ? {} : current, changes]) {
      if (!object(values)) throw new TypeError("Parameters must be a JSON object");
      const unknown = Object.keys(values).filter(key => !Object.hasOwn(DEFAULT_PARAMS, key));
      if (unknown.length) throw new RangeError("Unknown parameter: " + unknown.sort().join(", "));
      for (const key of Object.keys(values)) params[key] = detached(values[key]);
    }
    for (const [name, [low, high]] of Object.entries(NUMERIC_RANGES)) {
      params[name] = number(params[name], name, low, high);
    }
    if (typeof params.shape !== "string" || !SHAPES.has(params.shape)) {
      throw new RangeError("shape must be sine, triangle, saw, or square");
    }
    if (typeof params.env_to_stroke !== "boolean") throw new TypeError("env_to_stroke must be a boolean");
    if (params.lower >= params.upper) throw new RangeError("lower must be less than upper");
    if (!Array.isArray(params.patches) || params.patches.length > 4) {
      throw new TypeError("patches must be an array of at most four cables");
    }
    const occupied = new Set();
    for (const patch of params.patches) {
      if (!object(patch) || Object.keys(patch).sort().join(",") !== "depth,source,target") {
        throw new TypeError("Each patch needs exactly source, target, and depth");
      }
      if (typeof patch.source !== "string" || !SOURCES.has(patch.source)) {
        throw new RangeError("Patch source must be lfo or envelope");
      }
      if (typeof patch.target !== "string" || !DESTINATIONS.has(patch.target)) {
        throw new RangeError("Patch target must be rate, stroke, center, or position");
      }
      if (occupied.has(patch.target)) throw new RangeError("Only one patch may occupy each destination");
      occupied.add(patch.target);
      patch.depth = number(patch.depth, "patch depth", -1, 1);
    }
    return params;
  }

  function waveform(shape, phase) {
    if (typeof shape !== "string" || !SHAPES.has(shape)) throw new RangeError("Unknown waveform");
    phase = wrapped(number(phase, "phase", -1e100, 1e100));
    if (shape === "sine") return Math.sin(2 * Math.PI * phase);
    if (shape === "triangle") return 1 - 4 * Math.abs(wrapped(phase + .25) - .5);
    if (shape === "saw") return 2 * phase - 1;
    return phase < .5 ? 1 : -1;
  }

  class Trajectory {
    constructor(configuration = {}) {
      const {low = 0, high = 1, position = .5,
        vmax = MAX_VELOCITY, amax = MAX_ACCELERATION, jmax = null} = options(configuration,
        ["low", "high", "position", "vmax", "amax", "jmax"], "Trajectory options");
      this.low = number(low, "lower trajectory bound", 0, 1);
      this.high = number(high, "upper trajectory bound", 0, 1);
      if (this.low >= this.high) throw new RangeError("Trajectory bounds must be increasing");
      this.vmax = number(vmax, "maximum velocity", 1e-12, 1e6);
      this.amax = number(amax, "maximum acceleration", 1e-12, 1e6);
      this.jmax = number(jmax === null ? defaultJerk(amax) : jmax, "maximum jerk", 1e-12, 1e9);
      Object.defineProperties(this, {
        _planner: {value: null, writable: true}, _capture: {value: null, writable: true},
        _safetyPlanner: {value: null, writable: true},
        _generation: {value: null, writable: true}, _following: {value: false, writable: true},
        _continuous: {value: false, writable: true},
        _captureWait: {value: 0, writable: true},
      });
      this.reset(position);
    }

    reset(position = .5) {
      position = number(position, "reset position", this.low, this.high);
      this.position = this.command = position;
      this.velocity = 0;
      this.acceleration = 0;
      this.trackingTarget = position;
      this._capture?.plan.dispose(); this._capture = null;
      this._following = this._continuous = false; this._generation = null;
      this._captureWait = 0;
    }

    configure_bounds(low, high) {
      low = number(low, "lower trajectory bound", 0, 1);
      high = number(high, "upper trajectory bound", 0, 1);
      const stop = this.position + this.velocity * Math.abs(this.velocity) / (2 * this.amax);
      if (low >= high || this.position < low || this.position > high
          || (this._continuous ? !this._brakeFits(this.pva(), low, high)
            : stop < low - 1e-10 || stop > high + 1e-10)) {
        throw new RangeError("Travel window must contain the current command and stopping point");
      }
      this.low = low;
      this.high = high;
    }

    pva() { return {position: this.position, velocity: this.velocity, acceleration: this.acceleration}; }
    limits() { return {vmax: this.vmax, amax: this.amax, jmax: this.jmax}; }
    _core() { return this._planner ||= new (ruckigAPI().Planner)({cycleTime: .002}); }
    _fits(plan, low, high) { return plan.minPosition >= low - 1e-10 && plan.maxPosition <= high + 1e-10; }
    _safeBrake(state, low, high) {
      const planner = this._safetyPlanner ||= new (ruckigAPI().Planner)({cycleTime: .002});
      const brake = planner.brake(state, this.limits());
      if (this._fits(brake, low, high)) return brake;
      // The shortest velocity-control stop can overshoot a nearby position
      // boundary while removing acceleration. Search bounded position-control
      // stops too; only complete analytic extrema prove an admissible stop.
      for (const position of [state.velocity < 0 ? low : high, (low + high) / 2, state.position]) {
        try {
          const plan = planner.calculate(state, {position, velocity: 0, acceleration: 0}, this.limits());
          if (this._fits(plan, low, high)) return plan;
        } catch (_) { /* This candidate is not a feasible stopping trajectory. */ }
      }
      return null;
    }
    _brakeFits(state, low, high) { return this._safeBrake(state, low, high) !== null; }
    braking() {
      const plan = this._safeBrake(this.pva(), this.low, this.high);
      if (!plan) throw new Error("No bounded jerk-limited stopping trajectory fits the travel window");
      return plan;
    }

    follow(reference, dt, strokeBounds, generation, exact = true) {
      dt = number(dt, "Continuous dt", 0, MAX_DT);
      // Replan modulated references on a fixed time grid, independent of USB
      // callback partitioning. Split at the exact grid crossing, carrying PVA.
      if (!exact && this._capture && !this._capture.braking && this._capture.elapsed < .02 - 1e-10 && this._capture.elapsed + dt > .02 + 1e-10) {
        const first = .02 - this._capture.elapsed, remaining = dt - first;
        this.follow({sample: offset => reference.sample(offset - remaining)}, first, strokeBounds, generation, false);
        return this.follow(reference, remaining, strokeBounds, generation, false);
      }
      this._continuous = true;
      if (!dt) return this.command;
      let low = this.low, high = this.high;
      const current = this.pva();
      if (!this._brakeFits(current, low, high)) throw new Error("Current jerk-limited stopping trajectory exceeds the travel window");
      if (strokeBounds && strokeBounds[0] < strokeBounds[1]
          && this._brakeFits(current, strokeBounds[0], strokeBounds[1])
          && (!this._capture || this._fits(this._capture.plan, strokeBounds[0], strokeBounds[1]))) [low, high] = strokeBounds;
      if (generation !== this._generation || (!exact && !this._capture?.braking && this._capture?.elapsed >= .02 - 1e-10)) {
        this._capture?.plan.dispose(); this._capture = null; this._following = false;
        if (generation !== this._generation) this._captureWait = 0;
        this._generation = generation;
      }
      if (!this._following && !this._capture) {
        // Capture a future moving state. A reference sample is not a rest
        // endpoint: its nonzero velocity and acceleration pass into Ruckig.
        const horizons = [.05, .075, .1, .15, .225, .35, .5, .75, 1, 1.5, 2, 3];
        let reason = "no bounded future state", adaptive = 0, feasibleDestination = false;
        for (let index = 0; index < horizons.length && index < 24; index++) {
          const horizon = horizons[index];
          try {
            const target = reference.sample(horizon - dt);
            const plan = this._core().calculate(current, target, {...this.limits(), minimumDuration: horizon});
            if (this._fits(plan, this.low, this.high) && this._brakeFits(target, this.low, this.high)) feasibleDestination = true;
            if (plan.duration > horizon + 1e-8) {
              if (exact && plan.duration < 3 && adaptive++ < 4) horizons.splice(index + 1, 0, plan.duration + .001);
              continue;
            }
            if (!this._fits(plan, low, high) || !this._brakeFits(target, low, high)) continue;
            this._capture = {plan: plan.snapshot(), elapsed: 0}; break;
          } catch (error) { reason = error.message || String(error); }
        }
        if (!this._capture) {
          // An infeasible parameter transition may need a bounded braking
          // segment before capture. This is a retained exceptional profile,
          // never a rest-to-rest plan for each ordinary wire sample.
          const brake = this._safeBrake(current, this.low, this.high);
          if (!brake || (brake.duration <= 1e-10 && !feasibleDestination)) throw new Error("No jerk-safe continuous capture fits the travel window: " + reason);
          if (brake.duration <= 1e-10) {
            this._captureWait += dt;
            if (this._captureWait > 3) throw new Error("No continuous capture reached a feasible reference within three seconds");
          }
          this._capture = {plan: brake.snapshot(), elapsed: 0, braking: true};
          low = this.low; high = this.high;
        } else this._captureWait = 0;
      }
      let next;
      if (this._capture) {
        const capture = this._capture;
        capture.elapsed += dt;
        next = capture.plan.sample(Math.min(capture.elapsed, capture.plan.duration));
        if (capture.elapsed >= capture.plan.duration - 1e-10) {
          if (!capture.braking && capture.elapsed > capture.plan.duration + 1e-10) next = reference.sample(0);
          capture.plan.dispose(); this._capture = null; this._following = exact && !capture.braking;
        }
      } else next = reference.sample(0);
      // The requested stroke is an optional stop corridor. A periodic reversal
      // can stay inside it while a v=0/a=0 emergency trajectory needs a little
      // more space; retain the independently verified rail corridor in that
      // case instead of changing the continuous waveform's velocity.
      if ((low !== this.low || high !== this.high) && !this._brakeFits(next, low, high)) {
        low = this.low; high = this.high;
      }
      if (![next.position, next.velocity, next.acceleration].every(Number.isFinite)) throw new Error("Continuous motion produced nonfinite state");
      if (Math.abs(next.velocity) > this.vmax + 1e-8 || Math.abs(next.acceleration) > this.amax + 1e-8) throw new Error("Continuous motion exceeds its velocity or acceleration limit");
      if (Math.abs(next.acceleration - current.acceleration) > this.jmax * dt + 1e-8) throw new Error("Continuous motion acceleration changed faster than the jerk limit");
      if (next.position < low - 1e-10 || next.position > high + 1e-10) throw new Error("Continuous motion exceeds its position corridor");
      if (!this._brakeFits(next, low, high)) throw new Error("Proposed jerk-limited stopping trajectory exceeds the travel window");
      // Normalize only floating-point endpoint roundoff, after the complete
      // state and stop corridor have passed. Velocity/acceleration are retained.
      this.position = this.command = clamp(next.position, this.low, this.high);
      this.velocity = next.velocity; this.acceleration = next.acceleration;
      this.trackingTarget = reference.sample(0).position;
      return this.command;
    }

    _segments(target) {
      const a = this.amax;
      let x = this.position, v = this.velocity;
      const segments = [];
      let error = target - x;
      if (v && (error * v <= 0 || v * v / (2 * a) > Math.abs(error))) {
        const brake = v < 0 ? a : -a;
        const duration = Math.abs(v) / a;
        segments.push([duration, brake]);
        x += v * duration + .5 * brake * duration * duration;
        v = 0;
        error = target - x;
      }
      if (Math.abs(error) < 1e-14) return segments;
      const direction = error < 0 ? -1 : 1;
      const speed = Math.max(0, direction * v);
      const peak = Math.min(this.vmax, Math.sqrt(a * Math.abs(error) + speed * speed / 2));
      const accel_time = Math.max(0, (peak - speed) / a);
      const accel_distance = (speed + peak) * accel_time / 2;
      const brake_distance = peak * peak / (2 * a);
      const coast_time = Math.max(0, (Math.abs(error) - accel_distance - brake_distance) / peak);
      segments.push([accel_time, direction * a], [coast_time, 0], [peak / a, -direction * a]);
      return segments;
    }

    track(target, dt, strokeBounds = null) {
      // Legacy position-only compatibility API. Hardware Engine.step uses
      // follow() with future PVA and never enters this rest-point fallback.
      dt = number(dt, "Tracking dt", 0, MAX_DT);
      target = number(target, "Tracking target", this.low, this.high);
      if (!dt) return this.command;
      let low = this.low, high = this.high;
      if (strokeBounds !== null) {
        if (!Array.isArray(strokeBounds) || strokeBounds.length !== 2) throw new TypeError("Stroke bounds need two positions");
        const [strokeLow, strokeHigh] = strokeBounds;
        number(strokeLow, "Lower stroke bound", this.low, this.high);
        number(strokeHigh, "Upper stroke bound", this.low, this.high);
        if (strokeLow >= strokeHigh || target < strokeLow || target > strokeHigh) throw new RangeError("Stroke bounds must contain the tracking target");
        const stop = this.position + this.velocity * Math.abs(this.velocity) / (2 * this.amax);
        // An abrupt center/stroke change cannot erase an existing stopping
        // distance. Use the rail bounds during that transition, then enforce
        // the intended stroke as soon as both position and stopping point fit.
        if (this.position >= strokeLow - 1e-10 && this.position <= strokeHigh + 1e-10
            && stop >= strokeLow - 1e-10 && stop <= strokeHigh + 1e-10) {
          low = strokeLow; high = strokeHigh;
        }
      }
      const from = this.trackingTarget ?? this.position;
      const feed = Math.abs(target - from) <= this.vmax * dt * 1.5 ? (target - from) / dt : 0;
      const count = Math.ceil(dt / .002), h = dt / count;
      for (let i = 0; i < count; i++) {
        // Compare reference and planner position at the same midpoint. An
        // end-of-step reference against the start position adds a false error
        // proportional to velocity and makes a feasible waveform overshoot.
        const reference = from + (target - from) * (i + .5) / count;
        const predicted = this.position + this.velocity * h / 2;
        let wanted = clamp(feed + 6 * (reference - predicted), -this.vmax, this.vmax);
        // Brake before a rail boundary, with one integration-step margin.
        const upper = Math.max(0, Math.sqrt(2 * this.amax * Math.max(0, high - this.position)) - this.amax * h);
        const lower = Math.max(0, Math.sqrt(2 * this.amax * Math.max(0, this.position - low)) - this.amax * h);
        wanted = clamp(wanted, -lower, upper);
        const next = this.velocity + clamp(wanted - this.velocity, -this.amax * h, this.amax * h);
        const position = this.position + .5 * (this.velocity + next) * h;
        const stopping = position + next * Math.abs(next) / (2 * this.amax);
        if (position < low || position > high || stopping < low || stopping > high) {
          // The exact bounded point planner handles a discontinuity near a limit.
          const endpoint = from + (target - from) * (i + 1) / count;
          this.update(clamp(endpoint, this.low, this.high), h);
        } else { this.position = position; this.velocity = next; }
      }
      this.trackingTarget = target;
      this.command = this.position;
      return this.command;
    }

    update(target, dt) {
      dt = number(dt, "Trajectory dt", 0, MAX_DT);
      target = number(target, "Target position", this.low, this.high);
      if (dt === 0) return this.command;
      let remaining = dt, exhausted = true;
      for (const [segment_duration, acceleration] of this._segments(target)) {
        const duration = Math.min(segment_duration, remaining);
        this.position += this.velocity * duration + acceleration * duration * duration / 2;
        this.velocity += acceleration * duration;
        remaining -= duration;
        if (remaining <= 0) {
          exhausted = false;
          break;
        }
      }
      if (exhausted) {
        this.position = target;
        this.velocity = 0;
      }
      if (this.position < this.low - 1e-10 || this.position > this.high + 1e-10) {
        throw new Error("Trajectory escaped its position bounds");
      }
      this.position = clamp(this.position, this.low, this.high);
      this.command = this.position;
      return this.command;
    }
  }

  const constant = value => ({value, first: 0, second: 0});
  const scaled = (value, factor) => ({value: value.value * factor, first: value.first * factor, second: value.second * factor});
  const added = (a, b) => ({value: a.value + b.value, first: a.first + b.first, second: a.second + b.second});
  const multiplied = (a, b) => ({value: a.value * b.value,
    first: a.first * b.value + a.value * b.first,
    second: a.second * b.value + 2 * a.first * b.first + a.value * b.second});
  const clipped = (value, low = 0, high = 1) => value.value <= low ? constant(low) : value.value >= high ? constant(high) : value;
  const powered = (value, exponent, factor) => ({value: factor * value.value ** exponent,
    first: factor * exponent * value.value ** (exponent - 1) * value.first,
    second: factor * exponent * value.value ** (exponent - 1) * value.second
      + factor * exponent * (exponent - 1) * value.value ** (exponent - 2) * value.first ** 2});

  class Engine {
    constructor(params = null) {
      this.params = validateParams(params === null ? {} : params);
      this.trajectory = new Trajectory({low: this.params.lower, high: this.params.upper});
      this.phase = this.lfo_phase = this.envelope = 0;
      this.reference_phase = 0;
      this._planned_rate = null;
      this._explicit_jerk = false;
      Object.defineProperties(this, {
        _referencePlanner: {value: null, writable: true},
        _referencePlans: {value: null, writable: true},
      });
    }

    configure(full_or_changes) {
      const params = validateParams(full_or_changes, this.params);
      this.trajectory.configure_bounds(params.lower, params.upper);
      this.params = params;
      return detached(params);
    }

    reset(configuration = {}) {
      const {position = .5, vmax = null, amax = null, jmax = null} = options(configuration,
        ["position", "vmax", "amax", "jmax"], "Reset options");
      const trajectory = new Trajectory({
        low: this.params.lower, high: this.params.upper, position,
        vmax: vmax === null ? this.trajectory.vmax : vmax,
        amax: amax === null ? this.trajectory.amax : amax,
        jmax: jmax === null ? (this._explicit_jerk ? this.trajectory.jmax : null) : jmax,
      });
      this.trajectory._capture?.plan.dispose(); this.trajectory._planner?.dispose(); this.trajectory._safetyPlanner?.dispose();
      if (jmax !== null) this._explicit_jerk = true;
      this.trajectory = trajectory;
      this.phase = this.lfo_phase = this.envelope = 0;
      this.reference_phase = 0;
      this._planned_rate = null;
      this._referencePlans?.forward.dispose(); this._referencePlans?.backward?.dispose(); this._referencePlans = null;
    }

    _futureGeometry(offset, gate) {
      const p = this.params, omega = 2 * Math.PI * p.lfo_rate_hz;
      const angle = 2 * Math.PI * this.lfo_phase + omega * offset;
      const lfo = {value: Math.sin(angle), first: omega * Math.cos(angle), second: -omega * omega * Math.sin(angle)};
      const slope = gate ? 1 / p.attack_s : -1 / p.release_s;
      const envelope = clipped({value: this.envelope + slope * offset, first: slope, second: 0});
      let rate = constant(p.rate_hz), stroke = constant(p.stroke), center = constant(p.center), direct = null;
      for (const patch of p.patches) {
        const source = patch.source === "lfo" ? lfo : patch.target === "stroke" ? envelope : added(scaled(envelope, 2), constant(-1));
        if (patch.target === "rate") {
          const k = 2 * Math.LN2 * patch.depth, value = p.rate_hz * Math.exp(k * source.value);
          rate = {value, first: value * k * source.first, second: value * (k * source.second + k * k * source.first * source.first)};
        } else if (patch.target === "stroke") stroke = added(stroke, scaled(source, patch.depth));
        else if (patch.target === "center") center = added(center, scaled(source, .5 * patch.depth));
        else direct = scaled(source, patch.depth);
      }
      rate = clipped(rate, .02, 4); stroke = clipped(stroke); center = clipped(center);
      if (p.env_to_stroke && direct === null) stroke = multiplied(stroke, envelope);
      const midpoint = added(constant(p.lower), scaled(center, p.upper - p.lower));
      const room = center.value <= .5 ? added(midpoint, constant(-p.lower)) : added(constant(p.upper), scaled(midpoint, -1));
      let amplitude = multiplied(stroke, room);
      if (midpoint.value - amplitude.value === midpoint.value + amplitude.value) amplitude = constant(0);
      return {rate, midpoint, amplitude, direct};
    }

    _sineRate(geometry, limits) {
      const amplitude = geometry.amplitude;
      if (!(amplitude.value > 0)) return geometry.rate;
      const caps = [geometry.rate, powered(amplitude, -1, limits.vmax / (2 * Math.PI)),
        powered(amplitude, -.5, Math.sqrt(limits.amax) / (2 * Math.PI)),
        powered(amplitude, -1 / 3, Math.cbrt(limits.jmax) / (2 * Math.PI))];
      return caps.reduce((a, b) => a.value <= b.value ? a : b);
    }

    _continuousReference(dt, gate) {
      const p = this.params, trajectory = this.trajectory;
      const limits = {vmax: trajectory.vmax * REFERENCE_RESERVE,
        amax: trajectory.amax * REFERENCE_RESERVE, jmax: trajectory.jmax * REFERENCE_RESERVE};
      const geometry = this._futureGeometry(0, gate), amplitude = geometry.amplitude.value;
      const dynamic = p.env_to_stroke && geometry.direct === null || p.patches.some(patch => patch.depth !== 0);
      let rate = geometry.rate.value, maximumSineRate = null, plans = null;
      if (geometry.direct === null && p.shape === "sine") {
        rate = this._sineRate(geometry, limits).value;
        maximumSineRate = amplitude > 0 ? Math.min(limits.vmax / (2 * Math.PI * amplitude),
          Math.sqrt(limits.amax) / Math.sqrt(amplitude) / (2 * Math.PI), Math.cbrt(limits.jmax) / Math.cbrt(amplitude) / (2 * Math.PI)) : null;
      } else if (geometry.direct === null && amplitude > 0) {
        const key = JSON.stringify([p.shape, amplitude, rate, limits.vmax, limits.amax, limits.jmax]);
        if (this._referencePlans?.key !== key) {
          const planner = this._referencePlanner ||= new (ruckigAPI().Planner)({cycleTime: .002});
          const distance = 2 * amplitude, start = {position: 0, velocity: 0, acceleration: 0};
          const end = {position: distance, velocity: 0, acceleration: 0};
          const minimum = planner.calculate(start, end, limits).duration;
          rate = Math.min(rate, 1 / (2 * minimum));
          const half = .5 / rate;
          const forwardDuration = p.shape === "triangle" ? half : p.shape === "saw" ? 2 * half - minimum : minimum;
          const forward = planner.calculate(start, end, {...limits, minimumDuration: forwardDuration}).snapshot();
          const backward = p.shape === "saw" ? planner.calculate(start, end, limits).snapshot() : null;
          this._referencePlans?.forward.dispose(); this._referencePlans?.backward?.dispose();
          this._referencePlans = {key, forward, backward, minimum, rate};
        }
        plans = this._referencePlans; rate = plans.rate;
      }
      if (geometry.direct === null) this.reference_phase = wrapped(this.reference_phase + .5 * ((this._planned_rate ?? rate) + rate) * dt);
      this._planned_rate = geometry.direct === null ? rate : null;
      const phase = this.reference_phase;
      const sample = offset => {
        const future = dynamic ? this._futureGeometry(offset, gate) : geometry;
        const midpoint = future.midpoint, a = future.amplitude;
        if (future.direct !== null) {
          const value = added(midpoint, multiplied(a, future.direct));
          return {position: value.value, velocity: value.first, acceleration: value.second};
        }
        if (!(amplitude > 0)) return {position: midpoint.value, velocity: midpoint.first, acceleration: midpoint.second};
        if (p.shape === "sine") {
          const futureRate = dynamic ? this._sineRate(future, limits) : constant(rate);
          let advance = rate * offset;
          if (dynamic && offset > 0) {
            const count = Math.ceil(offset / .01), h = offset / count; advance = 0;
            let previous = rate;
            for (let i = 1; i <= count; i++) {
              const next = this._sineRate(this._futureGeometry(i * h, gate), limits).value;
              advance += .5 * (previous + next) * h; previous = next;
            }
          }
          const angle = 2 * Math.PI * (phase + advance), omega = 2 * Math.PI * futureRate.value;
          const omegaPrime = 2 * Math.PI * futureRate.first, sin = Math.sin(angle), cos = Math.cos(angle);
          return {position: midpoint.value + a.value * sin,
            velocity: midpoint.first + a.first * sin + a.value * omega * cos,
            acceleration: midpoint.second + a.second * sin + 2 * a.first * omega * cos
              + a.value * omegaPrime * cos - a.value * omega * omega * sin};
        }
        const cyclePhase = wrapped(phase + rate * offset + (p.shape === "triangle" ? .25 : 0));
        const elapsed = cyclePhase / rate, half = .5 / rate;
        let forward, profile, time;
        if (p.shape === "saw") {
          forward = elapsed < 1 / rate - plans.minimum;
          profile = forward ? plans.forward : plans.backward;
          time = forward ? elapsed : elapsed - (1 / rate - plans.minimum);
        } else {
          forward = elapsed < half; profile = plans.forward;
          time = forward ? elapsed : elapsed - half;
        }
        const state = profile.sample(Math.min(time, profile.duration)), direction = forward ? 1 : -1;
        const progress = forward ? state.position / (2 * amplitude) : 1 - state.position / (2 * amplitude);
        const speed = time >= profile.duration ? 0 : direction * state.velocity / (2 * amplitude);
        const acceleration = time >= profile.duration ? 0 : direction * state.acceleration / (2 * amplitude);
        return {position: midpoint.value - a.value + 2 * a.value * progress,
          velocity: midpoint.first - a.first + 2 * (a.first * progress + a.value * speed),
          acceleration: midpoint.second - a.second + 2 * (a.second * progress + 2 * a.first * speed + a.value * acceleration)};
      };
      const envelopeConnected = p.env_to_stroke || p.patches.some(patch => patch.source === "envelope" && patch.depth !== 0);
      const generation = JSON.stringify([p, envelopeConnected ? gate : null]);
      return {sample, rate, maximumSineRate, generation, exact: !dynamic};
    }

    _source(patch, bipolar = true) {
      if (patch.source === "lfo") return Math.sin(2 * Math.PI * this.lfo_phase);
      return bipolar ? 2 * this.envelope - 1 : this.envelope;
    }

    _effective() {
      const p = this.params;
      let rate = p.rate_hz, stroke = p.stroke, center = p.center, position = null;
      for (const patch of p.patches) {
        const {depth, target} = patch;
        const source = this._source(patch, target !== "stroke");
        if (target === "rate") rate *= 2 ** (2 * depth * source);
        else if (target === "stroke") stroke += depth * source;
        else if (target === "center") center += .5 * depth * source;
        else position = depth * source;
      }
      return [clamp(rate, .02, 4), clamp(stroke), clamp(center), position];
    }

    step(dt, controls = {}) {
      dt = number(dt, "Engine dt", 0, MAX_DT);
      const {gate = false, running = true, tracking = false} = options(controls, ["gate", "running", "tracking"], "Step controls");
      if (typeof gate !== "boolean" || typeof running !== "boolean" || typeof tracking !== "boolean") {
        throw new TypeError("gate and running must be booleans");
      }
      if (running && tracking && dt > .002) {
        // Serial/status reads make browser updates uneven. Advance the entire
        // waveform and its modulation at the planner's resolution, rather than
        // interpolating one long chord across a curved waveform. This sends
        // only the final current command; it creates no serial catch-up queue.
        const count = Math.ceil(dt / .002), h = dt / count;
        let signal;
        for (let i = 0; i < count; i++) signal = this._step(h, gate, running, tracking);
        return signal;
      }
      return this._step(dt, gate, running, tracking);
    }

    _step(dt, gate, running, tracking) {
      const previous_rate = this._effective()[0];
      this.envelope = clamp(this.envelope + (gate ? dt / this.params.attack_s : -dt / this.params.release_s));
      this.lfo_phase = wrapped(this.lfo_phase + dt * this.params.lfo_rate_hz);
      let [rate, stroke, center, direct_position] = this._effective();
      this.phase = wrapped(this.phase + .5 * (previous_rate + rate) * dt);
      const env_bypassed = direct_position !== null && this.params.env_to_stroke;
      if (this.params.env_to_stroke && direct_position === null) stroke *= this.envelope;
      const low = this.params.lower, high = this.params.upper;
      const midpoint = low + center * (high - low);
      let amplitude = stroke * Math.min(midpoint - low, high - midpoint);
      if (tracking && midpoint - amplitude === midpoint + amplitude) amplitude = 0;
      const carrier = waveform(this.params.shape, this.phase);
      const wave = direct_position === null ? carrier : direct_position;
      const requested = clamp(midpoint + amplitude * wave, low, high);
      if (tracking && running) {
        const reference = this._continuousReference(dt, gate);
        const strokeLow = midpoint - amplitude, strokeHigh = midpoint + amplitude;
        const command = this.trajectory.follow(reference, dt,
          reference.exact && strokeLow < strokeHigh ? [strokeLow, strokeHigh] : null, reference.generation, reference.exact);
        const planned = reference.sample(0);
        return {
          requested, command, velocity: this.trajectory.velocity, acceleration: this.trajectory.acceleration,
          envelope: this.envelope, lfo: Math.sin(2 * Math.PI * this.lfo_phase), phase: this.phase,
          limited: Math.abs(command - requested) > 1e-7,
          effective_rate_hz: rate, effective_stroke: stroke, effective_center: center, carrier,
          position_patched: direct_position !== null, envelope_bypassed: Boolean(env_bypassed),
          reference_phase: this.reference_phase, planned_reference: planned.position,
          planned_reference_velocity: planned.velocity, planned_reference_acceleration: planned.acceleration,
          planned_rate_hz: direct_position === null ? reference.rate : null,
          rate_limited: direct_position === null && reference.rate < rate - 1e-10,
          requested_span_normalized: 2 * amplitude * (direct_position === null ? 1
            : Math.abs(this.params.patches.find(patch => patch.target === "position").depth)),
          center_limited_stroke: stroke > 0 && 2 * amplitude < stroke * (high - low) - 1e-10,
          max_sine_rate_hz: direct_position === null && this.params.shape === "sine" ? reference.maximumSineRate : null,
        };
      }
      if (!tracking) this.reference_phase = this.phase;
      this._planned_rate = null;
      let command;
      if (running) command = this.trajectory.update(requested, dt);
      else {
        this.trajectory.reset(this.trajectory.position);
        command = this.trajectory.command;
      }
      const signal = {
        requested, command, velocity: this.trajectory.velocity, envelope: this.envelope,
        lfo: Math.sin(2 * Math.PI * this.lfo_phase), phase: this.phase,
        limited: Boolean(running && Math.abs(command - requested) > 1e-7),
        effective_rate_hz: rate, effective_stroke: stroke, effective_center: center, carrier,
        position_patched: direct_position !== null, envelope_bypassed: Boolean(env_bypassed),
      };
      if (tracking) Object.assign(signal, {
        acceleration: this.trajectory.acceleration,
        reference_phase: this.reference_phase,
        planned_reference: requested,
        planned_rate_hz: null,
        rate_limited: false,
        requested_span_normalized: 2 * amplitude * (direct_position === null ? 1
          : Math.abs(this.params.patches.find(patch => patch.target === "position").depth)),
        center_limited_stroke: stroke > 0 && 2 * amplitude < stroke * (high - low) - 1e-10,
        max_sine_rate_hz: null,
      });
      return signal;
    }
  }

  const motionCore = typeof module === "object" && module.exports ? require("./ruckig-core.js") : globalThis.MotionRuckig;
  return Object.freeze({Engine, Trajectory, DEFAULT_PARAMS, MAX_VELOCITY, MAX_ACCELERATION,
    validateParams, waveform, ready: motionCore?.ready || Promise.resolve(false), motionReady: () => Boolean(motionCore?.loaded)});
});
