/* SPDX-License-Identifier: MPL-2.0
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/* Async browser port of transport.py. Constructing never opens a port. The UI
 * supplies a user-selected SerialPort; this module never discovers devices.
 * Direct Home measures both contacts without resetting the encoder coordinate.
 * Native compatibility follows the reference retained in transport.py.
 */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports
    ? require("./web-serial-io.js") : root.MotionWebSerialIO);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MotionWebSerialTransport = api;
})(globalThis, function (io) {
  "use strict";
  const { TransportError } = io;
  const IO_TIMEOUT = .2, MAX_RUN_SECONDS = null, HALF_WINDOW = 4096, PADDING = 128;
  const CONFIG = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 21, 24, 25];
  const HOME_IO_TIMEOUT = .5;
  const HOME_SEEK_SECONDS = 30, HOME_TOTAL_SECONDS = 360, COUNTS_PER_MM = 32768 / 40;
  const HOME_SEARCH_COUNTS = 409600, HOME_MIN_SPAN = 16384, HOME_INSET = 1638;
  const HOME_RETOUCH_OVERTRAVEL = 819;
  // Keep a drive ramp for serial target changes; the planner remains gentler.
  const RUN_SPEED_RPM = 600, RUN_ACCEL_RPM_S = 20000, PLANNED_ACCEL_RPM_S = 3600;
  const RUN_MAX_VELOCITY = 32768 * RUN_SPEED_RPM / 60 * .9;
  const RUN_MAX_ACCELERATION = 32768 * PLANNED_ACCEL_RPM_S / 60 * .9;
  const HOME_SPEED_RPM = 70, HOME_ACCEL_RPM_S = 150;
  const HOME_RECHECK_SPEED_RPM = 35, HOME_RECHECK_ACCEL_RPM_S = 75;
  const HOME_COUNTS_PER_SECOND = 32768 * HOME_SPEED_RPM / 60;
  const CONTACT_PWM = 1966, CONTACT_ERROR = 512, CONTACT_SECONDS = .5, CONTACT_REPEAT_TOLERANCE = 128;
  const CONTACT_RELEASE_TOLERANCE = 512;
  const PARK_STOP_TOLERANCE = 128, STOP_PENDING_TOLERANCE = 2;
  const STOP_CONFIRM_TOLERANCE = Math.ceil(COUNTS_PER_MM * .1); // 0.1 mm of disabled mechanical settling.
  const STOP_SETTLE_TOLERANCE = Math.ceil(COUNTS_PER_MM); // 1 mm from the confirmed stop; never a rolling reference.
  const OUTPUT_STATUSES = [0, 1, 2, 3, 6, 7, 10, 11, 14, 15];
  const clock = () => performance.now() / 1000;
  const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const spread = values => Math.max(...values) - Math.min(...values);
  const equalPrefix = (a, b, count) => a.length >= count && b.length >= count && a.slice(0, count).every((v, i) => v === b[i]);
  // Python round() chooses the even neighbor at exact halves.
  function round(value) { const low = Math.floor(value), frac = value - low; return frac === .5 ? low + (low % 2 !== 0 ? 1 : 0) : Math.round(value); }
  class CancelledOperation extends TransportError { constructor() { super("Operation cancelled by Stop."); this.name = "CancelledOperation"; } }

  class MotorTransport {
    constructor(port, { allowMotion = false, connectionFactory = null, clock: now = clock,
                        wait: sleep = wait, nativeHome = false, fastPositions = false, portLabel = "Selected USB serial adapter" } = {}) {
      if (!port) throw new TypeError("An explicitly selected SerialPort is required");
      this.port = portLabel; this._port = port; this.allow_motion = allowMotion === true;
      this._nativeHome = nativeHome === true;
      this._fastPositions = fastPositions === true; this._snapshot_at = -Infinity;
      this._factory = connectionFactory; this._clock = now; this._wait = sleep;
      for (const field of ["connection", "values", "baseline", "origin", "hold_position", "low", "high", "enabled_at", "target", "stop_position", "fault", "observed_at", "home_origin", "home_started", "home_phase_started", "home_reference", "home_expected", "home_initial", "home_park", "home_motion_timeout", "home_move_phase", "home_move_from", "home_move_target", "home_contact_phase", "home_contact_position", "home_hold_position", "proposed_endpoints", "proposed_bounds", "measured_endpoints", "measured_travel"]) this["_" + field] = null;
      for (const field of ["owned", "cleanup_attempted", "armed", "running", "stop_confirmed", "homing", "homed", "home_activity"]) this["_" + field] = false;
      this._communication_recoveries = 0; this._recovery_streak = 0;
      this._tracking_failures = 0; this._home_phase = "idle"; this._home_progress = 0; this._home_direction = "normal";
      this._cleanup_errors = []; this._home_samples = []; this._home_actions = []; this._home_candidates = {}; this._home_contacts = {};
      this._queue = Promise.resolve(); this._epoch = 0; this._activeEpoch = 0; this._inCleanup = false;
    }
    _enqueue(run, stopping) {
      if (stopping) this._epoch++;
      const epoch = this._epoch;
      const result = this._queue.then(async () => {
        if (!stopping && epoch !== this._epoch) throw new CancelledOperation();
        this._activeEpoch = epoch;
        return run();
      });
      this._queue = result.catch(() => {});
      return result;
    }
    _checkCancelled() { if (!this._inCleanup && this._activeEpoch !== this._epoch) throw new CancelledOperation(); }
    status() {
      const v = this._values, position = v ? io.signedPosition(v) : null, output = v ? v[1] : null;
      let notice = "Software stop is not a hardware emergency stop.";
      if (this._owned && !this._stop_confirmed && (this._fault || this._cleanup_errors.length)) notice = "Software stop/inhibit unconfirmed; use physical power isolation.";
      else if (this._homing) notice = "Sensorless homing in progress.";
      else if (this._running) notice = "Motor running.";
      else if (this._homed) notice = "Motor homed.";
      return {
        port: this.port, baud: 19200, slave: 1, connected: this._connection !== null, owned: this._owned,
        motion_allowed: this.allow_motion, armed: this._armed, running: this._running,
        stop_confirmed: this._stop_confirmed, fault: this._fault, homing: this._homing, homed: this._homed,
        home_phase: this._home_phase, home_progress: this._home_progress, home_direction: this._home_direction,
        home_origin_raw: this._home_origin, measured_endpoints_raw: this._measured_endpoints?.slice() ?? null,
        measured_travel_raw: this._measured_travel, nominal_counts_per_mm: COUNTS_PER_MM,
        max_velocity_raw_s: RUN_MAX_VELOCITY, max_acceleration_raw_s2: RUN_MAX_ACCELERATION,
        position_raw: position, pending_raw: v ? io.pending(v) : null, output_raw: output,
        output_enabled: v && ((v[0] === 1 && [0, 1].includes(output)) || (v[0] === 0 && [0, 2, 3, 6, 7, 10, 11, 14, 15].includes(output))) ? Boolean(output & 1) : null,
        alarm: v?.[14] ?? null, mode: v?.[0] ?? null, speed_rpm: v?.[2] ?? null,
        acceleration_rpm_s: v?.[3] ?? null, current_raw: v?.[15] ?? null,
        output_limit_stall_raw: v?.[24] ?? null, pwm_raw: v?.[19] ?? null,
        origin_raw: this._origin, raw_bounds: this._origin !== null ? [this._low, this._high] : null,
        position_normalized: position !== null && this._origin !== null ? (position - this._low) / (this._high - this._low) : null,
        communication_recoveries: this._communication_recoveries,
        target_raw: this._target, observed_at: this._observed_at,
        run_seconds: this._running && this._enabled_at !== null ? Math.max(0, this._clock() - this._enabled_at) : 0,
        max_run_seconds: MAX_RUN_SECONDS, cleanup_errors: this._cleanup_errors.slice(), notice,
      };
    }
    _require_connection() { if (!this._connection) throw new TransportError("Connect an explicitly selected serial device first"); }
    _require_clear_fault() { this._require_connection(); if (this._fault) throw new TransportError("Fault is latched; disconnect and inspect before reconnecting: " + this._fault); }
    _budget() {
      return IO_TIMEOUT;
    }
    async _exchange(tx, budget) {
      this._checkCancelled();
      const rx = await this._connection.exchange(tx, budget);
      if (!(rx instanceof Uint8Array) || rx.length < 5 || io.crc16(rx.slice(0, -2)) !== (rx.at(-2) | rx.at(-1) << 8)) throw new TransportError("Response CRC or length mismatch");
      if (rx[0] !== 1 || (rx[1] !== tx[1] && rx[1] !== (tx[1] | 128))) throw new TransportError("Response slave/function mismatch");
      if (rx[1] === (tx[1] | 128)) throw new TransportError("Drive returned Modbus exception " + rx[2]);
      if (rx.length !== (tx[1] === 3 ? 57 : 8)) throw new TransportError("Response length mismatch");
      return rx;
    }
    async _read(budget = null, speedRecheck = false) {
      try {
        let response;
        try { response = await this._exchange(io.snapshotRequest(), budget ?? this._budget()); }
        catch (error) {
          if (!error.recoverableResponse || this._inCleanup) throw error;
          this._checkCancelled();
          response = await this._exchange(io.snapshotRequest(), budget ?? this._budget());
          this._communication_recoveries++;
        }
        this._values = io.parseSnapshot(response);
        this._observed_at = this._snapshot_at = this._clock(); this._checkCancelled();
        if (this._stop_confirmed) {
          let position;
          if (this._origin === null) { this._configuration(this._values, false, this._baseline); position = io.signedPosition(this._values); }
          else position = this._check_active(this._values, false);
          const displacement = Math.abs(position - this._stop_position);
          // A speed-only contradiction can be a transient estimator sample.
          // Recheck once, read-only; output, demand, PWM and fixed drift remain strict.
          if (!speedRecheck && !this._inCleanup && this._values[0] === 1 && this._values[1] === 0 &&
              Math.abs(io.pending(this._values)) <= STOP_PENDING_TOLERANCE && this._values[19] === 0 &&
              displacement <= STOP_CONFIRM_TOLERANCE && !this._stationary_speed(this._values)) {
            await this._wait(.05);
            return await this._read(budget, true);
          }
          if (!this._inhibited_feedback(this._values) || displacement > STOP_SETTLE_TOLERANCE) {
            throw new TransportError(`Stopped feedback changed: position drift ${displacement} counts (limit ${STOP_SETTLE_TOLERANCE}), pending ${io.pending(this._values)}, actual speed ${this._signed_speed(this._values)}, PWM ${this._signed_pwm(this._values)}, output ${this._values[1]}`);
          }
        }
        return this._values;
      } catch (error) { this._stop_confirmed = false; throw error; }
    }
    async _write(operation, budget = null) {
      if (!["clear", "enable", "inhibit"].includes(operation)) throw new TransportError("Unsupported transport operation");
      const tx = io.outputRequest(operation);
      const rx = await this._exchange(tx, budget ?? this._budget());
      if (tx[1] === 16) { if (!equalPrefix(rx, tx, 6)) throw new TransportError("Clear acknowledgement address/count mismatch"); }
      else {
        if (!equalPrefix(rx, tx, 4)) throw new TransportError("Output acknowledgement address mismatch");
        const echoed = (rx[4] << 8) | rx[5];
        // Firmware can finish native Home between the preceding snapshot and
        // this acknowledgement. Readback, not a stale mode word, proves output.
        if (!(this._homing ? OUTPUT_STATUSES : [0, 1]).includes(echoed)) throw new TransportError("Output acknowledgement status/value mismatch");
      }
    }
    async _absolute(target, budget = IO_TIMEOUT) {
      const tx = io.absoluteRequest(target), rx = await this._exchange(tx, budget);
      if (!equalPrefix(rx, tx, 6)) throw new TransportError("Absolute-position acknowledgement address/count mismatch; no retry");
    }
    _configuration(v, enabled, baseline = null) {
      if (v[0] !== 1 || v[1] !== Number(enabled) || v[2] !== RUN_SPEED_RPM || v[3] !== RUN_ACCEL_RPM_S || v[10] !== 0 || v[14] !== 0 || v[20] !== 0 || v[21] !== 1 || v[25] !== 0) throw new TransportError("Require mode1, scalar output " + Number(enabled) + ", speed/acceleration600/20000, gear0, alarm0, save0, address1, special0");
      if (baseline && CONFIG.some(i => v[i] !== baseline[i])) throw new TransportError("Motor configuration changed after arming");
    }
    _check_active(v, enabled, hold = false) {
      this._configuration(v, enabled, this._baseline);
      const p = io.signedPosition(v);
      if (p < this._low - PADDING || p > this._high + PADDING) throw new TransportError("Encoder position exceeded the fixed motion window");
      if (hold && Math.abs(p - this._hold_position) > 16) throw new TransportError("Encoder drift exceeded the pre-motion hold tolerance");
      return p;
    }
    async _fault_and_cleanup(error) {
      const cancelled = error instanceof CancelledOperation;
      if (!cancelled) this._fault ||= `${error.name || "Error"}: ${error.message || error}`;
      if (!cancelled || this._homing) this._homed = false;
      this._armed = this._running = false;
      if (this._owned && !this._cleanup_attempted) await this._stop_impl();
      if (this._fault) this._homed = false;
      if (cancelled && !this._fault) throw error;
      throw new TransportError(this._fault);
    }
    async connect() {
      if (this._connection) throw new TransportError("Transport is already connected");
      if (this._fault) throw new TransportError("Create a new transport after inspecting the latched fault");
      try {
        this._connection = this._factory ? await this._factory(this._port) : new io.WebSerialConnection(this._port);
        await this._connection.open(); await this._read(IO_TIMEOUT);
      } catch (error) {
        const connection = this._connection; this._connection = null;
        try { if (connection) await connection.close(); } catch (_) { /* Retain the original failure. */ }
        await this._fault_and_cleanup(error);
      }
      return this.status();
    }
    async reset_fault() {
      this._require_connection();
      if (this._armed || this._running || this._homing || !this._stop_confirmed ||
          !/Response timeout|Communication remained unstable|Motor did not settle within 3 seconds after stop\/inhibit/.test(this._fault || "")) {
        throw new TransportError("Reconnect or Home is required for this fault");
      }
      const positions = [];
      for (let i = 0; i < 3; i++) {
        if (i) await this._wait(.1);
        const v = await this._read(.5); this._configuration(v, false, this._baseline);
        if (!this._inhibited_feedback(v)) throw new TransportError("Fault reset requires stationary inhibited feedback");
        positions.push(io.signedPosition(v));
      }
      if (spread(positions) > STOP_CONFIRM_TOLERANCE) throw new TransportError("Encoder moved during fault reset");
      this._fault = null; this._recovery_streak = 0; this._tracking_failures = 0;
      this._cleanup_attempted = false; this._cleanup_errors = [];
      this._homed = Boolean(this._measured_endpoints && this._origin !== null);
      return this.status();
    }
    async recover_stop() {
      this._require_connection();
      if (!this.allow_motion || this._armed || this._running || this._homing) throw new TransportError("Reconnect stop requires an idle transport");
      // After USB loss the motor may still be holding the last bounded target.
      // Inhibit only; never restore an old run or reuse its calibration.
      this._owned = true; this._stop_confirmed = false;
      try {
        try { await this._write("inhibit", .5); }
        catch (error) { if (!error.recoverableResponse) throw error; }
        const positions = [];
        for (let i = 0; i < 3; i++) {
          if (i) await this._wait(.1);
          const v = await this._read(.5); this._configuration(v, false);
          if (!this._inhibited_feedback(v)) throw new TransportError("Reconnect stop is not yet stationary");
          positions.push(io.signedPosition(v));
        }
        if (spread(positions) > 4) throw new TransportError("Encoder moved during reconnect stop verification");
        this._stop_position = positions.at(-1); this._stop_confirmed = true; this._owned = false;
      } catch (error) { this._fault = String(error.message || error); throw error; }
      return this.status();
    }
    async snapshot() {
      this._require_connection();
      try { const v = await this._read(); if (this._armed || this._running) this._check_active(v, this._running); }
      catch (error) { await this._fault_and_cleanup(error); }
      return this.status();
    }
    async arm() {
      this._require_clear_fault();
      if (!this.allow_motion) throw new TransportError("Hardware motion was not enabled for this session");
      if (this._running || this._owned || this._homing) throw new TransportError("Stop the existing run before arming");
      this._armed = false;
      try {
        const positions = []; let baseline = this._baseline;
        for (let i = 0; i < 3; i++) {
          if (i) await this._wait(.1);
          const v = await this._read(IO_TIMEOUT); this._configuration(v, false, baseline);
          if (!this._inhibited_feedback(v)) throw new TransportError("Arming requires stationary inhibited feedback with at most two counts of encoder noise");
          baseline ||= v.slice(); positions.push(io.signedPosition(v));
        }
        if (spread(positions) > 4) throw new TransportError("Encoder was not stable across three fresh arming reads");
        const held = positions.at(-1);
        if (this._origin === null) {
          const low = held - HALF_WINDOW, high = held + HALF_WINDOW;
          if (low < -(2 ** 31) || high >= 2 ** 31) throw new TransportError("Motion window crosses the signed32-bit counter boundary");
          if (low <= 0 && high >= 0) throw new TransportError("Motion window includes absolute zero, which resets the drive coordinate");
          this._baseline = baseline; this._origin = held; this._low = low; this._high = high;
        } else if (!positions.every(p => p >= this._low && p <= this._high)) throw new TransportError("Rearming requires the encoder inside the original fixed window");
        this._hold_position = this._target = held; this._tracking_failures = 0; this._enabled_at = null;
        this._stop_confirmed = this._cleanup_attempted = false; this._armed = true;
      } catch (error) { await this._fault_and_cleanup(error); }
      return this.status();
    }
    async _stable_hold(enabled) {
      const positions = [];
      for (let i = 0; i < 3; i++) {
        await this._wait(.1); const v = await this._read(); positions.push(this._check_active(v, enabled, true));
        if (Math.abs(io.pending(v)) > (enabled ? 16 : STOP_PENDING_TOLERANCE) || Math.abs(this._signed_speed(v)) > 1 || (!enabled && v[19] !== 0)) throw new TransportError("Pending motion, speed or output PWM exceeded hold verification limits");
      }
      if (spread(positions) > 4) throw new TransportError("Encoder was not stable during hold verification");
    }
    async start() {
      this._require_clear_fault();
      if (!this.allow_motion || !this._armed || this._running) throw new TransportError("An explicitly armed, stopped transport is required");
      try {
        const v = await this._read(IO_TIMEOUT); this._check_active(v, false, true);
        if (!this._inhibited_feedback(v)) throw new TransportError("Motor is no longer stationary and inhibited");
        this._owned = true; await this._write("clear"); await this._stable_hold(false);
        this._enabled_at = this._clock(); await this._write("enable"); await this._stable_hold(true); this._running = true;
      } catch (error) { await this._fault_and_cleanup(error); }
      return this.status();
    }
    async command(normalized) {
      this._require_clear_fault();
      if (!this.allow_motion || !this._armed || !this._running) throw new TransportError("ARM and START are required before sending a target");
      try {
        if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 0 || normalized > 1) throw new TransportError("Position must be finite and normalized0..1");
        const recoveriesBefore = this._communication_recoveries;
        const target = this._nonzero_target(this._low + (this._high - this._low) * normalized, this._low, this._high);
        const position = this._check_active(!this._fastPositions || this._clock() - this._snapshot_at >= .1 ? await this._read() : this._values, true);
        // Encoder feedback arrives with each dedicated target reply. Allow 100 ms
        // of travel, capped at ten percent of the calibrated working range.
        const trackingLimit = Math.min((this._high - this._low) * .1, 1024 + RUN_MAX_VELOCITY * .1);
        if (!this._fastPositions) this._tracking_failures = Math.abs(position - this._target) > trackingLimit ? this._tracking_failures + 1 : 0;
        if (this._tracking_failures >= 3) throw new TransportError("Tracking error exceeded the motion budget for three fresh samples");
        try {
          if (this._fastPositions) {
            const rx = await this._exchange(io.fastPositionRequest(target), this._budget());
            this._values[22] = (rx[2] << 8) | rx[3]; this._values[23] = (rx[4] << 8) | rx[5];
            this._observed_at = this._clock();
            const actual = this._check_active(this._values, true);
            this._tracking_failures = Math.abs(actual - this._target) > trackingLimit ? this._tracking_failures + 1 : 0;
            if (this._tracking_failures >= 3) throw new TransportError("Tracking error exceeded the motion budget for three fresh samples");
          } else await this._absolute(target, this._budget());
        }
        catch (error) {
          if (!error.recoverableResponse) throw error;
          // Never retransmit the uncertain target. Recover the link with fresh
          // validated feedback before accepting another, current target.
          this._check_active(await this._read(), true);
          this._communication_recoveries++;
        }
        this._target = target;
        this._recovery_streak = this._communication_recoveries > recoveriesBefore ? this._recovery_streak + 1 : 0;
        if (this._recovery_streak >= 3) throw new TransportError("Communication remained unstable for three target cycles");
      } catch (error) { await this._fault_and_cleanup(error); }
      return this.status();
    }

    _home_stage(phase, progress) {
      this._home_phase = phase; this._home_progress = progress; this._home_phase_started = this._clock(); this._home_samples = [];
    }
    _home_queue(actions, following, progress) {
      this._home_actions = actions.slice(); this._home_following = following; this._home_stage(actions[0][0], progress);
    }
    async _write_home_setting(register, value) {
      const permitted = { 0: [0, 1], 2: [RUN_SPEED_RPM, HOME_SPEED_RPM, HOME_RECHECK_SPEED_RPM, 80], 3: [15, RUN_ACCEL_RPM_S, HOME_ACCEL_RPM_S, HOME_RECHECK_ACCEL_RPM_S], 9: [0, 1], 10: [0], 24: [89, this._home_reference[24]], 25: [0, 1] };
      if (!permitted[register]?.includes(value)) throw new TransportError("Setting is outside the fixed native homing profile");
      const tx = io.configRequest(register, value), rx = await this._exchange(tx, HOME_IO_TIMEOUT);
      if (!equalPrefix(rx, tx, 6)) throw new TransportError("Homing setting acknowledgement mismatch; no retry");
      this._home_expected[register] = value;
    }
    _native_reset(v) {
      return v[0] === 0 && [10, 11, 14, 15].includes(v[1]) && v[10] === 32768 && v[25] === 1;
    }
    async _home_read(enabled = null, native = false) {
      const v = await this._read(HOME_IO_TIMEOUT);
      if (v[14] !== 0 || v[20] !== 0 || v[21] !== 1 || !(native ? [0, 32768] : [0]).includes(v[10])) throw new TransportError("Native homing requires alarm0, save0, address1 and a recognized gear state");
      let indices = CONFIG;
      if (native) {
        // Register snapshots can straddle the firmware's mode/gear restoration.
        // Accept only known transition values, then require stable completion.
        if (![0, 1].includes(v[0]) || ![0, 1].includes(v[25]) || !OUTPUT_STATUSES.includes(v[1])) throw new TransportError("Unexpected drive state during native homing");
        if (![89, this._home_reference[24]].includes(v[24]) && !(v[25] === 1 && v[24] <= 609)) throw new TransportError("Native completion restored an unexpected output limit");
        if (![80, 1500].includes(v[2]) || ![15, 50000].includes(v[3])) throw new TransportError("Unexpected native completion speed or acceleration configuration");
        indices = [4, 5, 6, 7, 8, 9, 11, 20, 21];
      } else if (enabled !== null && v[1] !== Number(enabled)) throw new TransportError("Unexpected output state during native homing");
      if (indices.some(i => v[i] !== this._home_expected[i])) throw new TransportError("Unexpected configuration change during native homing");
      return v;
    }
    _home_stationary(v, pendingTolerance = 0, disabled = false) {
      if (Math.abs(io.pending(v)) > pendingTolerance || Math.abs(this._signed_speed(v)) > 1 || (disabled && v[19] !== 0)) { this._home_samples = []; return false; }
      const now = this._clock();
      if (this._home_samples.length && now - this._home_samples.at(-1)[0] < .075) return false;
      this._home_samples.push([now, io.signedPosition(v)]); this._home_samples = this._home_samples.slice(-3);
      return this._home_samples.length === 3 && spread(this._home_samples.map(s => s[1])) <= 4;
    }
    _validate_home_start(v) {
      const known = (v[0] === 0 && [0, 2, 3, 6, 7, 10, 11, 14, 15].includes(v[1])) || (v[0] === 1 && [0, 1].includes(v[1]));
      if (!known) throw new TransportError(`Home does not recognize drive mode ${v[0]} / output status ${v[1]}`);
      for (const [register, expected, label] of [[14, 0, "alarm"], [20, 0, "save"], [21, 1, "address"], [25, 0, "special function"]]) {
        if (v[register] !== expected) throw new TransportError(`Home requires ${label} ${expected}; drive reports ${v[register]}`);
      }
      if (v[24] > 609) throw new TransportError(`Home does not recognize output/stall setting ${v[24]}`);
      if (!this._stationary_speed(v)) throw new TransportError(`Home requires a stationary motor; actual speed is ${this._signed_speed(v)}`);
      if (Math.abs(io.pending(v)) > 16) throw new TransportError(`Home requires at most 16 counts of holding error; drive reports ${io.pending(v)}`);
    }
    async _home_startup_read(afterMode = false) {
      const v = await this._read(IO_TIMEOUT);
      this._validate_home_start(v);
      // Mode selection can reset the speed, acceleration and output limit.
      // These settings are reapplied while inhibited before Home enables output.
      const indices = afterMode ? CONFIG.filter(i => ![2, 3, 24].includes(i)) : CONFIG;
      if (indices.some(i => v[i] !== this._home_expected[i])) throw new TransportError("Unexpected configuration change during Home preparation");
      if (Math.abs(io.signedPosition(v) - this._home_initial) > 4) throw new TransportError("Encoder moved during homing preflight");
      if (afterMode) {
        if (v[0] !== 1 || v[1] !== 0) throw new TransportError(`Home could not inhibit Modbus output; mode ${v[0]}, output ${v[1]}`);
        if (v[19] !== 0) throw new TransportError(`Home takeover did not settle; pending ${io.pending(v)}, PWM ${this._signed_pwm(v)}`);
        for (const i of [2, 3, 24]) this._home_expected[i] = v[i];
      } else if (v[1] !== this._home_reference[1]) throw new TransportError("Output status changed during homing preflight");
      return v;
    }
    _prepare_home() {
      if (!this._nativeHome) {
        this._home_queue([["setting_home_gear", 10, 0], ["clearing", "clear", 0],
          ["setting_probe_speed", 2, HOME_SPEED_RPM], ["setting_probe_acceleration", 3, HOME_ACCEL_RPM_S],
          ["setting_home_output", 24, 89], ["setting_home_direction", 9, 0]], "verify_preparation", .1);
        return;
      }
      this._home_queue([["setting_home_gear", 10, 0], ["clearing", "clear", 0], ["setting_home_speed", 2, 80],
        ["setting_home_acceleration", 3, 15], ["setting_home_output", 24, 89],
        ["setting_home_direction", 9, Number(this._home_direction === "reverse")]], "verify_preparation", .1);
    }
    _nonzero_target(target, low, high) {
      target = round(target); if (target === 0) target = low <= 1 && 1 <= high ? 1 : -1;
      if (!Number.isInteger(target) || low < -(2 ** 31) || target < low || target > high || high >= 2 ** 31) throw new TransportError("Absolute target is outside its bounded signed32-bit interval");
      if (target === 0) throw new TransportError("Absolute zero cannot be sent to this drive");
      return target;
    }
    _signed_speed(v) { return v[16] & 32768 ? v[16] - 65536 : v[16]; }
    // Register16 is signed tenths of an RPM. Observed inhibited readback
    // jitters by one unit; encoder samples still independently prove stasis.
    _stationary_speed(v) { return Math.abs(this._signed_speed(v)) <= 1; }
    _inhibited_feedback(v) {
      return v[0] === 1 && v[1] === 0 && Math.abs(io.pending(v)) <= STOP_PENDING_TOLERANCE && v[19] === 0 && this._stationary_speed(v);
    }
    _signed_pwm(v) { return v[19] & 32768 ? v[19] - 65536 : v[19]; }
    _home_inward() { return this._home_direction === "reverse" ? 1 : -1; }
    _begin_home_move(phase, target, position, enable = false) {
      target = this._nonzero_target(target, -(2 ** 31), 2 ** 31 - 1);
      this._home_move_phase = phase; this._home_move_from = position; this._home_move_target = target;
      const recheck = phase.endsWith("retreat") || phase.endsWith("retouch");
      const speed = recheck ? HOME_RECHECK_SPEED_RPM : HOME_SPEED_RPM;
      const acceleration = recheck ? HOME_RECHECK_ACCEL_RPM_S : HOME_ACCEL_RPM_S;
      this._home_motion_timeout = Math.abs(target - position) / (32768 * speed / 60) + speed / acceleration + 5;
      const progress = { first_contact: .63, first_retreat: .67, first_retouch: .7,
        second_contact: .73, second_retreat: .8, second_retouch: .84, centering: .88 }[phase];
      const profile = [["setting_move_speed", 2, speed], ["setting_move_acceleration", 3, acceleration]];
      if (enable) { this._home_hold_position = position; this._home_queue([...profile, ["clearing_probe_hold", "clear", 0], ["enabling_probe", "enable", 1]], "move_hold", progress); }
      else this._home_queue(profile, "commanding_" + phase, progress);
    }
    _contact_detected(v) {
      const position = io.signedPosition(v), error = this._home_move_target - position, pending = io.pending(v);
      if (Math.abs(error) < CONTACT_ERROR || Math.abs(pending) < CONTACT_ERROR || error * pending <= 0 || Math.abs(this._signed_pwm(v)) < CONTACT_PWM) { this._home_samples = []; return false; }
      const now = this._clock();
      if (this._home_samples.length && now - this._home_samples.at(-1)[0] < .075) return false;
      this._home_samples.push([now, position]);
      while (this._home_samples.length && spread(this._home_samples.map(s => s[1])) > 4) this._home_samples.shift();
      return this._home_samples.length >= 3 && now - this._home_samples[0][0] >= CONTACT_SECONDS;
    }
    _capture_contact(phase, v) {
      const position = io.signedPosition(v), side = phase.startsWith("first") ? "first" : "second";
      if (phase.endsWith("retouch")) {
        if (Math.abs(position - this._home_candidates[side]) > CONTACT_REPEAT_TOLERANCE) throw new TransportError("Repeated endpoint contact did not agree within128 counts");
        this._home_contacts[side] = round((position + this._home_candidates[side]) / 2);
      } else this._home_candidates[side] = position;
      if (side === "second") {
        const distance = Math.abs(position - this._home_contacts.first);
        if (distance < HOME_MIN_SPAN || distance > HOME_SEARCH_COUNTS) throw new TransportError("Measured rail travel must be between nominal20 and500mm");
      }
      this._home_contact_phase = phase; this._home_contact_position = position;
      this._home_queue([["clearing_contact", "clear", 0], ["inhibiting_contact", "inhibit", 0]], "verify_contact_stop", this._home_progress);
    }
    _after_contact_stop(position) {
      const phase = this._home_contact_phase, inward = this._home_inward();
      if (["first_contact", "second_contact"].includes(phase)) {
        const direction = phase === "first_contact" ? inward : -inward;
        this._begin_home_move(phase.replace("contact", "retreat"), this._home_contact_position + direction * HOME_INSET, position, true);
      } else if (phase === "first_retouch") {
        this._begin_home_move("second_contact", this._home_contacts.first + inward * (HOME_SEARCH_COUNTS + HOME_RETOUCH_OVERTRAVEL), position, true);
      } else {
        const [low, high] = Object.values(this._home_contacts).sort((a, b) => a - b);
        if (high - low < HOME_MIN_SPAN || high - low > HOME_SEARCH_COUNTS) throw new TransportError("Measured rail travel must be between nominal20 and500mm");
        this._proposed_endpoints = [low, high]; this._proposed_bounds = [low + HOME_INSET, high - HOME_INSET];
        this._home_park = this._nonzero_target((low + high) / 2, ...this._proposed_bounds);
        this._begin_home_move("centering", this._home_park, position, true);
      }
    }
    async begin_home(reverse = false) {
      this._require_clear_fault();
      if (!this.allow_motion) throw new TransportError("Hardware motion was not enabled for this session");
      if (typeof reverse !== "boolean") throw new TransportError("Homing direction must be a boolean");
      if (this._armed || this._running || this._owned || this._homing) throw new TransportError("Stop and disarm before homing");
      this._stop_confirmed = this._homed = false;
      try {
        const v = await this._read(IO_TIMEOUT);
        this._validate_home_start(v);
        this._home_reference = v.slice(); this._home_expected = v.slice(); this._home_initial = io.signedPosition(v);
        this._home_park = null; this._home_direction = reverse ? "reverse" : "normal"; this._home_origin = null;
        this._home_activity = false; this._home_actions = []; this._home_candidates = {}; this._home_contacts = {};
        this._home_motion_timeout = this._home_move_phase = null; this._proposed_endpoints = this._proposed_bounds = null;
        this._measured_endpoints = this._measured_travel = null; this._home_started = this._clock(); this._home_stage("preflight", 0);
        this._homing = this._owned = true; this._cleanup_attempted = false; this._cleanup_errors = [];
        this._origin = this._low = this._high = this._baseline = this._enabled_at = this._target = null;
      } catch (error) { await this._fault_and_cleanup(error); }
      return this.status();
    }
    async poll_home() {
      this._require_clear_fault(); if (!this._homing) return this.status();
      try {
        const now = this._clock(), phase = this._home_phase;
        const timeout = phase === "seeking" ? HOME_SEEK_SECONDS : phase === this._home_move_phase ? this._home_motion_timeout : 3;
        if (now - this._home_started > HOME_TOTAL_SECONDS || now - this._home_phase_started > timeout) throw new TransportError("Native homing timed out during " + phase + "; no retry");
        if (this._home_actions.length) {
          const [, register, value] = this._home_actions[0];
          if (typeof register === "string") await this._write(register, IO_TIMEOUT); else await this._write_home_setting(register, value);
          this._home_actions.shift(); this._home_stage(this._home_actions.length ? this._home_actions[0][0] : this._home_following, this._home_progress);
          return this.status();
        }
        if (phase === "preflight") {
          const v = await this._home_startup_read();
          // Tiny servo holding corrections are normal before explicit takeover.
          // Actual speed and three encoder samples establish stationarity here.
          if (this._home_stationary(v, 16)) {
            if (v[0] === 0) this._home_stage("selecting_modbus", .05);
            else this._home_queue([["inhibiting_before_home", "inhibit", 0]], "preparation_mode_settle", .05);
          }
        } else if (phase === "selecting_modbus") {
          try { await this._write_home_setting(0, 1); } finally { await this._write("inhibit", IO_TIMEOUT); }
          this._home_stage("preparation_mode_settle", .05);
        } else if (phase === "preparation_mode_settle") {
          if (now - this._home_phase_started >= .8) {
            const v = await this._home_startup_read(true);
            if (this._home_stationary(v, 16, true)) this._prepare_home();
          }
        } else if (phase === "verify_preparation") {
          const v = await this._home_read(false);
          if (!this._inhibited_feedback(v) || Math.abs(io.signedPosition(v) - this._home_initial) > 4) throw new TransportError("Homing preparation did not remain stationary and inhibited");
          if (this._home_stationary(v, STOP_PENDING_TOLERANCE, true)) this._home_queue([["enabling_home", "enable", 1]], "enabled_hold", .2);
        } else if (phase === "enabled_hold") {
          const v = await this._home_read(true);
          if (Math.abs(io.signedPosition(v) - this._home_initial) > 16) throw new TransportError("Encoder drifted before native homing trigger");
          if (this._home_stationary(v, 16)) {
            if (this._nativeHome) this._home_queue([["triggering_home", 25, 1]], "seeking", .3);
            else {
              const position = io.signedPosition(v); this._home_origin = position;
              this._begin_home_move("first_contact", position - this._home_inward() * HOME_SEARCH_COUNTS, position);
            }
          }
        } else if (phase === "seeking") {
          const v = await this._home_read(null, true), position = io.signedPosition(v);
          this._home_activity ||= Math.abs(position - this._home_initial) > 16 || Math.abs(io.pending(v)) >= 15;
          this._home_progress = Math.min(.55, .3 + .25 * (now - this._home_phase_started) / HOME_SEEK_SECONDS);
          if (!this._home_activity || (!this._native_reset(v) && (v[10] !== 0 || Math.abs(position) > 128)) || !this._stationary_speed(v)) this._home_samples = [];
          else if (this._home_stationary(v, 14)) {
            this._home_origin = position;
            if (v[24] !== 89) this._home_reference[24] = v[24];
            this._home_queue([["inhibiting_after_home", "inhibit", 0], ["restoring_modbus", 0, 1], ["inhibiting_after_mode", "inhibit", 0]], "mode_settle", .6);
          }
        } else if (phase === "mode_settle") {
          if (now - this._home_phase_started >= .8) this._home_queue([["restoring_position_mode", 25, 0], ["setting_probe_speed", 2, HOME_SPEED_RPM], ["setting_probe_acceleration", 3, HOME_ACCEL_RPM_S], ["restoring_gear", 10, 0], ["limiting_park_output", 24, 89], ["clearing_before_park", "clear", 0]], "verify_restore", .65);
        } else if (phase === "verify_restore") {
          const v = await this._home_read(false), position = io.signedPosition(v);
          if (Math.abs(position - this._home_origin) > 32 || !this._inhibited_feedback(v)) throw new TransportError("Home restoration did not remain stationary at the captured origin");
          // Native home establishes a coordinate, not a measured distance to
          // the rail end. Probe from that coordinate within the same 500mm cap.
          this._begin_home_move("first_contact", position - this._home_inward() * HOME_SEARCH_COUNTS, position, true);
        } else if (phase === "move_hold") {
          const v = await this._home_read(true);
          if (Math.abs(io.signedPosition(v) - this._home_hold_position) > 16) throw new TransportError("Encoder drifted before calibration move");
          if (this._home_stationary(v, 16)) this._home_stage("commanding_" + this._home_move_phase, this._home_progress);
        } else if (phase === "commanding_" + this._home_move_phase) {
          await this._absolute(this._home_move_target); this._target = this._home_move_target;
          this._home_stage(this._home_move_phase, this._home_progress);
        } else if (["first_contact", "first_retouch", "second_contact", "second_retouch", "first_retreat", "second_retreat", "centering"].includes(phase)) {
          const v = await this._home_read(true), position = io.signedPosition(v);
          const low = Math.min(this._home_move_from, this._home_move_target) - PADDING, high = Math.max(this._home_move_from, this._home_move_target) + PADDING;
          if (position < low || position > high) throw new TransportError("Encoder exceeded the bounded calibration move corridor");
          if (phase.startsWith("second") && Math.abs(position - this._home_contacts.first) > HOME_SEARCH_COUNTS + PADDING) throw new TransportError("Encoder exceeded the maximum500mm rail search");
          if (phase.endsWith("contact") || phase.endsWith("retouch")) { if (this._contact_detected(v)) this._capture_contact(phase, v); }
          else {
            const away = phase !== "centering" ? Math.abs(position - this._home_contact_position) : 0;
            const released = phase === "centering" || (away >= HOME_INSET - 16 && Math.abs(this._signed_pwm(v)) < CONTACT_PWM);
            if (Math.abs(position - this._home_move_target) > 16 || !released) this._home_samples = [];
            else if (this._home_stationary(v, 16)) {
              if (phase === "centering") this._home_queue([["clearing_center", "clear", 0], ["inhibiting_center", "inhibit", 0]], "verify_stop", .94);
              else {
                const side = phase === "first_retreat" ? "first" : "second", inward = this._home_inward();
                this._begin_home_move(side + "_retouch", this._home_candidates[side] - (side === "first" ? inward : -inward) * HOME_RETOUCH_OVERTRAVEL, position);
              }
            }
          }
        } else if (phase === "verify_contact_stop") {
          const v = await this._home_read(false), position = io.signedPosition(v);
          const inward = this._home_contact_phase.startsWith("first") ? this._home_inward() : -this._home_inward();
          const release = (position - this._home_contact_position) * inward;
          if (release < -CONTACT_REPEAT_TOLERANCE || release > CONTACT_RELEASE_TOLERANCE) throw new TransportError("Encoder moved beyond the contact release allowance after inhibition");
          if (this._home_stationary(v, STOP_PENDING_TOLERANCE, true)) this._after_contact_stop(position);
        } else if (phase === "verify_stop") {
          const v = await this._home_read(false);
          if (Math.abs(io.signedPosition(v) - this._home_park) > PARK_STOP_TOLERANCE) throw new TransportError("Encoder drifted after centering");
          if (this._home_stationary(v, STOP_PENDING_TOLERANCE, true)) this._home_queue([["restoring_run_speed", 2, RUN_SPEED_RPM], ["restoring_run_acceleration", 3, RUN_ACCEL_RPM_S], ["restoring_output", 24, this._home_reference[24]]], "verify_complete", .95);
        } else if (phase === "verify_complete") {
          const v = await this._home_read(false), position = io.signedPosition(v);
          if (Math.abs(position - this._home_park) > PARK_STOP_TOLERANCE || !this._inhibited_feedback(v)) throw new TransportError("Final homing stop was not confirmed");
          this._baseline = v.slice(); this._origin = this._home_park; [this._low, this._high] = this._proposed_bounds;
          this._measured_endpoints = this._proposed_endpoints.slice(); this._measured_travel = this._measured_endpoints[1] - this._measured_endpoints[0];
          this._hold_position = this._stop_position = position; this._stop_confirmed = this._homed = true;
          this._homing = this._owned = false; this._cleanup_attempted = true; this._home_stage("complete", 1);
        } else throw new TransportError("Unknown native homing phase");
      } catch (error) { await this._fault_and_cleanup(error); }
      return this.status();
    }
    async _stop_home() {
      this._armed = this._running = this._homed = false;
      if (this._cleanup_attempted) { this._homing = false; return; }
      this._cleanup_attempted = true; this._stop_confirmed = false;
      const errors = [];
      for (const operation of ["inhibit", "mode_off", "special_off", "inhibit"]) {
        try {
          if (operation === "mode_off") await this._write_home_setting(0, 0);
          else if (operation === "special_off") await this._write_home_setting(25, 0);
          else await this._write(operation, HOME_IO_TIMEOUT);
        }
        catch (error) { errors.push(`${operation}: ${error.message || error}`); }
      }
      try {
        await this._wait(.8);
        let positions = [], v;
        for (let i = 0; i < 3; i++) {
          if (i) await this._wait(.1); v = await this._read(IO_TIMEOUT);
          const disabled = (v[0] === 0 && [0, 2, 6, 10, 14].includes(v[1])) || (v[0] === 1 && v[1] === 0);
          if (!disabled || v[25] !== 0 || !this._stationary_speed(v) || (v[0] === 1 && v[19] !== 0)) throw new TransportError("Native cancellation did not inhibit output");
          positions.push(io.signedPosition(v));
        }
        if (spread(positions) > 4) throw new TransportError("Native cancellation encoder did not settle");
        if (!errors.length) {
          try { await this._write_home_setting(0, 1); } finally { await this._write("inhibit", IO_TIMEOUT); }
          await this._wait(.8);
          v = await this._read(IO_TIMEOUT);
          if (v[0] !== 1 || v[1] !== 0 || !this._stationary_speed(v) || Math.abs(io.signedPosition(v) - positions.at(-1)) > 4) throw new TransportError("Native cancellation Modbus takeover was not stationary and inhibited");
          await this._write_home_setting(10, 0);
          await this._write("clear", IO_TIMEOUT);
          for (const [register, value] of [[2, RUN_SPEED_RPM], [3, RUN_ACCEL_RPM_S], [24, this._home_reference[24]]]) await this._write_home_setting(register, value);
          positions = [];
          for (let i = 0; i < 3; i++) {
            if (i) await this._wait(.1); v = await this._home_read(false);
            if (!this._inhibited_feedback(v)) throw new TransportError("Restored cancellation state is not stopped");
            positions.push(io.signedPosition(v));
          }
          if (spread(positions) > 4) throw new TransportError("Restored cancellation encoder did not settle");
          this._baseline = v.slice(); this._stop_position = positions.at(-1);
        }
      } catch (error) { errors.push("readback/restore: " + (error.message || error)); }
      this._homing = false; this._home_origin = null; this._home_actions = []; this._enabled_at = null;
      this._cleanup_errors = errors; this._stop_confirmed = !errors.length;
      if (errors.length) this._fault ||= errors.join("; "); else this._owned = false;
      this._home_stage(this._fault ? "fault" : "cancelled", this._home_progress);
    }
    async _stop_impl() {
      const prior = this._inCleanup; this._inCleanup = true;
      try {
        if (this._homing) { await this._stop_home(); return; }
        this._armed = this._running = false;
        if (!this._owned || this._cleanup_attempted) return;
        this._cleanup_attempted = true; this._stop_confirmed = false;
        const errors = [], positions = [];
        for (const operation of ["clear", "inhibit"]) {
          try { await this._write(operation, IO_TIMEOUT); }
          catch (error) {
            if (error.recoverableResponse) this._communication_recoveries++;
            else errors.push(operation + ": " + (error.message || error));
          }
        }
        try {
          const deadline = this._clock() + 3;
          for (let attempt = 0; attempt < 40 && this._clock() < deadline; attempt++) {
            let v;
            try { v = await this._read(Math.min(IO_TIMEOUT, deadline - this._clock())); }
            catch (error) {
              if (!error.recoverableResponse) throw error;
              positions.length = 0; this._communication_recoveries++;
              continue; // Read-only recovery stays within the stop deadline.
            }
            const position = this._check_active(v, v[1] === 1);
            if (this._inhibited_feedback(v)) {
              positions.push(position);
              if (positions.length > 3) positions.shift();
              if (positions.length === 3 && spread(positions) <= STOP_CONFIRM_TOLERANCE) break;
            } else positions.length = 0;
            await this._wait(Math.min(.1, Math.max(0, deadline - this._clock())));
          }
          if (positions.length !== 3 || spread(positions) > STOP_CONFIRM_TOLERANCE) throw new TransportError(`Motor did not settle within 3 seconds after stop/inhibit: output ${this._values?.[1]}, pending ${this._values ? io.pending(this._values) : "unknown"}, speed ${this._values ? this._signed_speed(this._values) : "unknown"}, PWM ${this._values?.[19]}, encoder spread ${positions.length ? spread(positions) : "no stationary samples"} counts (${positions.length}/3 samples; limit ${STOP_CONFIRM_TOLERANCE} counts)`);
        } catch (error) { errors.push("readback: " + (error.message || error)); }
        this._cleanup_errors = errors; this._enabled_at = null; this._stop_confirmed = !errors.length;
        this._stop_position = this._stop_confirmed ? positions.at(-1) : null;
        if (errors.length) this._fault ||= errors.join("; "); else this._owned = false;
      } finally { this._inCleanup = prior; }
    }
    async stop() {
      this._require_connection();
      if (this._owned && this._cleanup_attempted && !this._stop_confirmed) this._cleanup_attempted = false;
      await this._stop_impl();
      if (this._cleanup_errors.length) throw new TransportError("Stop/inhibit unconfirmed: " + this._cleanup_errors.join("; "));
      return this.status();
    }
    async close() {
      this._homed = false; if (!this._connection) return;
      try { await this._stop_impl(); }
      finally {
        const connection = this._connection; this._connection = null; this._armed = this._running = false;
        try { await connection.close(); }
        catch (error) { this._fault ||= "close: " + (error.message || error); throw new TransportError(this._fault); }
      }
    }
  }
  for (const name of ["connect", "snapshot", "recover_stop", "reset_fault", "arm", "start", "command", "begin_home", "poll_home", "stop", "close"]) {
    const method = MotorTransport.prototype[name];
    if (method) MotorTransport.prototype[name] = function (...args) { return this._enqueue(() => method.apply(this, args), name === "stop" || name === "close"); };
  }
  return { MotorTransport, TransportError, CancelledOperation, IO_TIMEOUT, MAX_RUN_SECONDS,
           COUNTS_PER_MM, CONFIG: Object.freeze(CONFIG.slice()) };
});
