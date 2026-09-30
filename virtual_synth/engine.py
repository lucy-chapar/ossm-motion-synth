# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Offline virtual motion signals and an analytic bounded trajectory.

All positions describe a normalized, explicitly configured travel interval;
they are not measured motor positions. This module never imports or opens a
serial port. The planner bounds speed and acceleration, not jerk, and cannot
replace a drive's watchdog, homing, limit switches, or independent stop.

The carrier and sine LFO run continuously, including while disarmed. A linear
attack/release envelope rises/falls from its current value at full-scale slopes
1/attack_s and 1/release_s, so retriggering never resets its value. Patch amounts:

* rate: multiply base frequency by 2**(2 * depth * bipolar_source), then clamp
  to .02..4 Hz; envelope becomes 2*envelope-1 for this destination.
* stroke: add depth*source to the base stroke, then clamp to 0..1. Envelope is
  unipolar here; LFO is bipolar.
* center: add .5*depth*bipolar_source to base center, then clamp to 0..1.
* position: replace the carrier with depth*bipolar_source. This bypasses the
  implicit envelope-to-stroke switch, but explicit stroke patches still apply.

Center is relative to the selected lower/upper travel window. Stroke 1 reaches
both window limits at center .5; shifting center reduces amplitude symmetrically
to fit the nearer limit. Only one cable may occupy each destination.
"""

import copy
import math


DEFAULT_PARAMS = {
    "rate_hz": .25,
    "stroke": .7,
    "center": .5,
    "shape": "sine",
    "attack_s": .8,
    "release_s": 1.2,
    "env_to_stroke": False,
    "lfo_rate_hz": .07,
    "lower": .1,
    "upper": .9,
    "patches": [],
}

NUMERIC_RANGES = {
    "rate_hz": (.02, 4.0), "stroke": (0.0, 1.0), "center": (0.0, 1.0),
    "attack_s": (.02, 10.0), "release_s": (.02, 10.0),
    "lfo_rate_hz": (.01, 4.0), "lower": (0.0, .49), "upper": (.51, 1.0),
}
SHAPES = frozenset(("sine", "triangle", "saw", "square"))
SOURCES = frozenset(("lfo", "envelope"))
DESTINATIONS = frozenset(("rate", "stroke", "center", "position"))
MAX_VELOCITY = 3822.0 / 8192.0
MAX_ACCELERATION = 1.0
MAX_DT = .25


def _number(value, name, low, high):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not low <= value <= high or not math.isfinite(value)):
        raise ValueError(f"{name} must be a finite number in {low}..{high}")
    return float(value)


def _clamp(value, low=0.0, high=1.0):
    return min(high, max(low, value))


def validate_params(changes, current=None):
    """Return a detached full configuration, or raise without changing inputs.

    Unknown top-level or patch keys, duplicate destinations, invalid types,
    infinities and NaNs are rejected rather than silently coerced or ignored.
    ``current`` may be a partial baseline; it is validated together with changes.
    """
    params = copy.deepcopy(DEFAULT_PARAMS)
    for values in ({} if current is None else current, changes):
        if not isinstance(values, dict):
            raise ValueError("Parameters must be a JSON object")
        unknown = set(values) - set(DEFAULT_PARAMS)
        if unknown:
            raise ValueError("Unknown parameter: " + ", ".join(sorted(map(str, unknown))))
        params.update(copy.deepcopy(values))
    for name, (low, high) in NUMERIC_RANGES.items():
        params[name] = _number(params[name], name, low, high)
    if not isinstance(params["shape"], str) or params["shape"] not in SHAPES:
        raise ValueError("shape must be sine, triangle, saw, or square")
    if type(params["env_to_stroke"]) is not bool:
        raise ValueError("env_to_stroke must be a boolean")
    if params["lower"] >= params["upper"]:
        raise ValueError("lower must be less than upper")
    patches = params["patches"]
    if not isinstance(patches, list) or len(patches) > 4:
        raise ValueError("patches must be an array of at most four cables")
    occupied = set()
    for patch in patches:
        if not isinstance(patch, dict) or set(patch) != {"source", "target", "depth"}:
            raise ValueError("Each patch needs exactly source, target, and depth")
        source, target = patch["source"], patch["target"]
        if not isinstance(source, str) or source not in SOURCES:
            raise ValueError("Patch source must be lfo or envelope")
        if not isinstance(target, str) or target not in DESTINATIONS:
            raise ValueError("Patch target must be rate, stroke, center, or position")
        if target in occupied:
            raise ValueError("Only one patch may occupy each destination")
        occupied.add(target)
        patch["depth"] = _number(patch["depth"], "patch depth", -1.0, 1.0)
    return params


def waveform(shape, phase):
    """Return a bipolar carrier; phase is finite cycles, wrapping at one."""
    if not isinstance(shape, str) or shape not in SHAPES:
        raise ValueError("Unknown waveform")
    phase = _number(phase, "phase", -1e100, 1e100) % 1.0
    if shape == "sine":
        return math.sin(2 * math.pi * phase)
    if shape == "triangle":
        return 1 - 4 * abs(((phase + .25) % 1.0) - .5)
    if shape == "saw":
        return 2 * phase - 1
    return 1.0 if phase < .5 else -1.0


class Trajectory:
    """Position/velocity state following a bounded analytic trapezoid.

    When a new target is behind the velocity or within braking distance, the
    trajectory first brakes continuously, then reverses. Every valid state can
    stop inside its configured bounds. Targets may jump; command position and
    velocity do not. ``reset`` is an explicit stationary-state assignment for
    initialization or a separately stopped drive, never a motor command.
    """

    def __init__(self, low=0.0, high=1.0, position=.5,
                 vmax=MAX_VELOCITY, amax=MAX_ACCELERATION):
        self.low = _number(low, "lower trajectory bound", 0, 1)
        self.high = _number(high, "upper trajectory bound", 0, 1)
        if self.low >= self.high:
            raise ValueError("Trajectory bounds must be increasing")
        self.vmax = _number(vmax, "maximum velocity", 1e-12, 1e6)
        self.amax = _number(amax, "maximum acceleration", 1e-12, 1e6)
        self.reset(position)

    def reset(self, position=.5):
        position = _number(position, "reset position", self.low, self.high)
        self.position = position
        self.command = position
        self.velocity = 0.0

    def configure_bounds(self, low, high):
        """Accept new limits only if the current state can stop inside them."""
        low = _number(low, "lower trajectory bound", 0, 1)
        high = _number(high, "upper trajectory bound", 0, 1)
        stop = self.position + self.velocity * abs(self.velocity) / (2 * self.amax)
        if (low >= high or not low <= self.position <= high
                or not low - 1e-10 <= stop <= high + 1e-10):
            raise ValueError("Travel window must contain the current command and stopping point")
        self.low, self.high = low, high

    def _segments(self, target):
        a, x, v = self.amax, self.position, self.velocity
        segments = []
        error = target - x
        if v and (error * v <= 0 or v * v / (2 * a) > abs(error)):
            brake = -math.copysign(a, v)
            duration = abs(v) / a
            segments.append((duration, brake))
            x += v * duration + .5 * brake * duration * duration
            v = 0.0
            error = target - x
        if abs(error) < 1e-14:
            return segments
        direction = math.copysign(1.0, error)
        speed = max(0.0, direction * v)
        peak = min(self.vmax, math.sqrt(a * abs(error) + speed * speed / 2))
        accel_time = max(0.0, (peak - speed) / a)
        accel_distance = (speed + peak) * accel_time / 2
        brake_distance = peak * peak / (2 * a)
        coast_time = max(0.0, (abs(error) - accel_distance - brake_distance) / peak)
        segments.extend(((accel_time, direction * a), (coast_time, 0.0),
                         (peak / a, -direction * a)))
        return segments

    def update(self, target, dt):
        """Advance by 0..250 ms, returning normalized commanded position."""
        dt = _number(dt, "Trajectory dt", 0, MAX_DT)
        target = _number(target, "Target position", self.low, self.high)
        if dt == 0:
            return self.command
        remaining = dt
        for duration, acceleration in self._segments(target):
            duration = min(duration, remaining)
            self.position += self.velocity * duration + acceleration * duration * duration / 2
            self.velocity += acceleration * duration
            remaining -= duration
            if remaining <= 0:
                break
        else:
            self.position, self.velocity = target, 0.0
        if not self.low - 1e-10 <= self.position <= self.high + 1e-10:
            raise RuntimeError("Trajectory escaped its position bounds")
        self.position = _clamp(self.position, self.low, self.high)
        self.command = self.position
        return self.command


class Engine:
    """Patchable signal generator plus a normalized trajectory preview.

    ``running=False`` freezes commanded position and marks planner velocity zero
    as a software disarm state. It does not model a physical emergency stop; the
    caller must inhibit/stop a connected drive separately. The next run starts
    its bounded trajectory at that held position. Signal phase is never reset
    by a gate transition, a patch edit, or disarming.
    """

    def __init__(self, params=None):
        self.params = validate_params({} if params is None else params)
        self.trajectory = Trajectory(low=self.params["lower"], high=self.params["upper"])
        self.phase = 0.0
        self.lfo_phase = 0.0
        self.envelope = 0.0

    def configure(self, full_or_changes):
        params = validate_params(full_or_changes, self.params)
        self.trajectory.configure_bounds(params["lower"], params["upper"])
        self.params = params
        return copy.deepcopy(params)

    def reset(self, position=.5, vmax=None, amax=None):
        """Reset at a separately stopped position, optionally replacing limits.

        Limits use normalized travel per second (and per second squared).
        Omitting them preserves the current physical-to-normalized scaling.
        Validate the entire new stationary state before replacing any state.
        """
        trajectory = Trajectory(
            low=self.params["lower"], high=self.params["upper"], position=position,
            vmax=self.trajectory.vmax if vmax is None else vmax,
            amax=self.trajectory.amax if amax is None else amax)
        self.trajectory = trajectory
        self.phase = self.lfo_phase = self.envelope = 0.0

    def _source(self, patch, bipolar=True):
        if patch["source"] == "lfo":
            return math.sin(2 * math.pi * self.lfo_phase)
        return 2 * self.envelope - 1 if bipolar else self.envelope

    def _effective(self):
        p = self.params
        rate, stroke, center = p["rate_hz"], p["stroke"], p["center"]
        position = None
        for patch in p["patches"]:
            depth, target = patch["depth"], patch["target"]
            source = self._source(patch, bipolar=target != "stroke")
            if target == "rate":
                rate *= 2 ** (2 * depth * source)
            elif target == "stroke":
                stroke += depth * source
            elif target == "center":
                center += .5 * depth * source
            else:
                position = depth * source
        return (_clamp(rate, .02, 4), _clamp(stroke), _clamp(center), position)

    def step(self, dt, gate=False, running=True):
        dt = _number(dt, "Engine dt", 0, MAX_DT)
        if type(gate) is not bool or type(running) is not bool:
            raise ValueError("gate and running must be booleans")
        previous_rate = self._effective()[0]
        self.envelope = _clamp(self.envelope + (dt / self.params["attack_s"] if gate
                                               else -dt / self.params["release_s"]))
        self.lfo_phase = (self.lfo_phase + dt * self.params["lfo_rate_hz"]) % 1.0
        rate, stroke, center, direct_position = self._effective()
        self.phase = (self.phase + .5 * (previous_rate + rate) * dt) % 1.0
        env_bypassed = direct_position is not None and self.params["env_to_stroke"]
        if self.params["env_to_stroke"] and direct_position is None:
            stroke *= self.envelope
        low, high = self.params["lower"], self.params["upper"]
        midpoint = low + center * (high - low)
        amplitude = stroke * min(midpoint - low, high - midpoint)
        carrier = waveform(self.params["shape"], self.phase)
        wave = carrier if direct_position is None else direct_position
        requested = _clamp(midpoint + amplitude * wave, low, high)
        if running:
            command = self.trajectory.update(requested, dt)
        else:
            # State assignment only. The transport's stop/inhibit path is separate.
            self.trajectory.reset(self.trajectory.position)
            command = self.trajectory.command
        return {
            "requested": requested, "command": command,
            "velocity": self.trajectory.velocity, "envelope": self.envelope,
            "lfo": math.sin(2 * math.pi * self.lfo_phase), "phase": self.phase,
            "limited": bool(running and abs(command - requested) > 1e-7),
            "effective_rate_hz": rate, "effective_stroke": stroke,
            "effective_center": center, "carrier": carrier,
            "position_patched": direct_position is not None,
            "envelope_bypassed": bool(env_bypassed),
        }
