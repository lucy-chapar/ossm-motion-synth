// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Offline port of virtual_synth/engine.py. This module has no device or network
// access. Position and velocity describe a normalized preview, not motor state.
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
        vmax = MAX_VELOCITY, amax = MAX_ACCELERATION} = options(configuration,
        ["low", "high", "position", "vmax", "amax"], "Trajectory options");
      this.low = number(low, "lower trajectory bound", 0, 1);
      this.high = number(high, "upper trajectory bound", 0, 1);
      if (this.low >= this.high) throw new RangeError("Trajectory bounds must be increasing");
      this.vmax = number(vmax, "maximum velocity", 1e-12, 1e6);
      this.amax = number(amax, "maximum acceleration", 1e-12, 1e6);
      this.reset(position);
    }

    reset(position = .5) {
      position = number(position, "reset position", this.low, this.high);
      this.position = this.command = position;
      this.velocity = 0;
      this.trackingTarget = position;
    }

    configure_bounds(low, high) {
      low = number(low, "lower trajectory bound", 0, 1);
      high = number(high, "upper trajectory bound", 0, 1);
      const stop = this.position + this.velocity * Math.abs(this.velocity) / (2 * this.amax);
      if (low >= high || this.position < low || this.position > high
          || stop < low - 1e-10 || stop > high + 1e-10) {
        throw new RangeError("Travel window must contain the current command and stopping point");
      }
      this.low = low;
      this.high = high;
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

  function restMoveTime(distance, vmax, amax) {
    return distance <= vmax * vmax / amax ? 2 * Math.sqrt(distance / amax) : distance / vmax + vmax / amax;
  }

  function restMovePosition(distance, duration, elapsed, amax) {
    // Symmetric trapezoid that uses the available duration, rather than
    // chasing a moving point with an arbitrary proportional response gain.
    const speed = 2 * distance / (duration + Math.sqrt(Math.max(0, duration * duration - 4 * distance / amax)));
    const ramp = speed / amax;
    if (elapsed < ramp) return .5 * amax * elapsed * elapsed;
    if (elapsed > duration - ramp) return distance - .5 * amax * (duration - elapsed) ** 2;
    return .5 * amax * ramp * ramp + speed * (elapsed - ramp);
  }

  class Engine {
    constructor(params = null) {
      this.params = validateParams(params === null ? {} : params);
      this.trajectory = new Trajectory({low: this.params.lower, high: this.params.upper});
      this.phase = this.lfo_phase = this.envelope = 0;
      this.reference_phase = 0;
      this._planned_rate = null;
    }

    configure(full_or_changes) {
      const params = validateParams(full_or_changes, this.params);
      this.trajectory.configure_bounds(params.lower, params.upper);
      this.params = params;
      return detached(params);
    }

    reset(configuration = {}) {
      const {position = .5, vmax = null, amax = null} = options(configuration,
        ["position", "vmax", "amax"], "Reset options");
      const trajectory = new Trajectory({
        low: this.params.lower, high: this.params.upper, position,
        vmax: vmax === null ? this.trajectory.vmax : vmax,
        amax: amax === null ? this.trajectory.amax : amax,
      });
      this.trajectory = trajectory;
      this.phase = this.lfo_phase = this.envelope = 0;
      this.reference_phase = 0;
      this._planned_rate = null;
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
      let plannedRate = rate, maximumSineRate = null, reference = requested, moveTime = 0;
      // A minimum-time continuous reference using every bit of acceleration
      // cannot be caught after starting at rest or changing parameters. Reserve
      // 10% for capture by the same tracker; its output still has one hard V/A
      // budget. Square point moves need no separate reference capture.
      const referenceVmax = this.trajectory.vmax * .9;
      const referenceAmax = this.trajectory.amax * .9;
      if (tracking && running && direct_position === null) {
        // One physical budget owns the streamed trajectory. A clock that keeps
        // outrunning that budget makes a pursuit limiter shrink the stroke.
        // Retiming a sine preserves its geometry: v_peak=2*pi*f*A and
        // a_peak=(2*pi*f)^2*A, in the same normalized units as the trajectory.
        if (amplitude > 0) {
          maximumSineRate = Math.min(this.trajectory.vmax / (2 * Math.PI * amplitude),
            Math.sqrt(this.trajectory.amax) / Math.sqrt(amplitude) / (2 * Math.PI));
          if (this.params.shape === "sine") plannedRate = Math.min(rate, maximumSineRate);
          else {
            // Each non-sine stroke needs a finite rest-to-rest transition.
            // Ideal triangle corners and saw/square jumps demand infinite
            // acceleration; their bounded references allocate real time.
            const distance = 2 * amplitude;
            const vmax = this.params.shape === "square" ? this.trajectory.vmax : referenceVmax;
            const amax = this.params.shape === "square" ? this.trajectory.amax : referenceAmax;
            moveTime = restMoveTime(distance, vmax, amax);
            plannedRate = Math.min(rate, 1 / (2 * moveTime));
          }
        }
        this.reference_phase = wrapped(this.reference_phase
          + .5 * ((this._planned_rate ?? plannedRate) + plannedRate) * dt);
        this._planned_rate = plannedRate;
        reference = clamp(midpoint + amplitude * waveform(this.params.shape, this.reference_phase), low, high);
        if (amplitude > 0 && this.params.shape === "triangle") {
          const phase = wrapped(this.reference_phase + .25), forward = phase < .5;
          const elapsed = (forward ? phase : phase - .5) / plannedRate;
          const position = restMovePosition(2 * amplitude, .5 / plannedRate, elapsed, referenceAmax);
          reference = midpoint - amplitude + (forward ? position : 2 * amplitude - position);
        } else if (amplitude > 0 && this.params.shape === "saw") {
          const elapsed = this.reference_phase / plannedRate, forwardTime = 1 / plannedRate - moveTime;
          const position = elapsed < forwardTime
            ? restMovePosition(2 * amplitude, forwardTime, elapsed, referenceAmax)
            : 2 * amplitude - restMovePosition(2 * amplitude, moveTime, elapsed - forwardTime, referenceAmax);
          reference = midpoint - amplitude + position;
        }
        reference = clamp(reference, low, high);
      } else if (!tracking) {
        this.reference_phase = this.phase;
        this._planned_rate = null;
      } else if (!running) this._planned_rate = null;
      let command;
      if (running) {
        // A square requests endpoints, rather than a continuously moving
        // reference. The exact point planner reaches them at the available
        // velocity/acceleration; a fixed pursuit gain approaches them slowly.
        const pointMove = tracking && direct_position === null && this.params.shape === "square";
        const strokeLow = clamp(midpoint - amplitude, low, high), strokeHigh = clamp(midpoint + amplitude, low, high);
        const strokeBounds = strokeLow < strokeHigh ? [strokeLow, strokeHigh] : null;
        reference = clamp(reference, strokeLow, strokeHigh);
        command = tracking && !pointMove ? this.trajectory.track(reference, dt, strokeBounds) : this.trajectory.update(reference, dt);
      }
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
        reference_phase: this.reference_phase,
        planned_reference: reference,
        planned_rate_hz: running && direct_position === null ? plannedRate : null,
        rate_limited: running && direct_position === null && plannedRate < rate - 1e-10,
        requested_span_normalized: 2 * amplitude * (direct_position === null ? 1
          : Math.abs(this.params.patches.find(patch => patch.target === "position").depth)),
        center_limited_stroke: stroke > 0 && 2 * amplitude < stroke * (high - low) - 1e-10,
        max_sine_rate_hz: direct_position === null && this.params.shape === "sine" ? maximumSineRate : null,
      });
      return signal;
    }
  }

  return Object.freeze({Engine, Trajectory, DEFAULT_PARAMS, MAX_VELOCITY, MAX_ACCELERATION,
    validateParams, waveform});
});
