# SPDX-License-Identifier: MPL-2.0
"""Explicit, bounded USB–RS485 ownership for the laptop motion instrument.

Importing, enumerating, and constructing do not open a serial device. Connecting
is read-only. Motor writes require launch-time permission and HOME or ARM/START.
This software stop is not an emergency stop or a substitute for power isolation.
Calls must be serialized by the application's single transport worker.
"""

import math
import time

from .protocol import bench_cycle, bench_jog, read_motor


IO_TIMEOUT = 0.15
MAX_RUN_SECONDS = 20.0
HALF_WINDOW = 4096
PADDING = 128
CONFIG = bench_jog.CONFIG
HOME_SEEK_SECONDS = 30.0
HOME_TOTAL_SECONDS = 360.0
COUNTS_PER_MM = 32768 / 40
HOME_SEARCH_COUNTS = round(500 * COUNTS_PER_MM)
HOME_MIN_SPAN = round(20 * COUNTS_PER_MM)
HOME_INSET = round(2 * COUNTS_PER_MM)
HOME_RETOUCH_OVERTRAVEL = round(COUNTS_PER_MM)
HOME_FIRST_SEARCH = round(10 * COUNTS_PER_MM)
HOME_COUNTS_PER_SECOND = 32768 * 7 / 60
CONTACT_PWM = 1966
CONTACT_ERROR = 512
CONTACT_SECONDS = .5
CONTACT_REPEAT_TOLERANCE = 128
# Vendor-documented native mechanical home; the Apache-2.0 OSSM-RS
# predecessor uses the same 80 RPM / output word 89 / special-function 1.
# https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/motion/mod.rs
# Original Python state machine: no upstream firmware code is incorporated.


class TransportError(Exception):
    """A gate, protocol exchange, or monitored motor state failed."""


def list_ports():
    """Enumerate names without opening any device or probing a motor."""
    try:
        from serial.tools import list_ports as serial_ports
    except ImportError as error:
        raise TransportError("Install pyserial to enumerate USB serial ports") from error
    return [{"device": port.device, "description": port.description}
            for port in sorted(serial_ports.comports(), key=lambda item: item.device)]


class MotorTransport:
    def __init__(self, port, allow_motion=False, connection_factory=None,
                 clock=time.monotonic, wait=time.sleep):
        if not isinstance(port, str) or not port.strip():
            raise ValueError("An explicit serial device is required")
        self.port = port
        self.allow_motion = allow_motion is True
        self._factory, self._clock, self._wait = connection_factory, clock, wait
        self._connection = None
        self._values = None
        self._baseline = None
        self._origin = None
        self._hold_position = None
        self._low = self._high = None
        self._enabled_at = None
        self._target = None
        self._tracking_failures = 0
        self._owned = False
        self._cleanup_attempted = False
        self._armed = self._running = self._stop_confirmed = False
        self._stop_position = None
        self._fault = None
        self._observed_at = None
        self._cleanup_errors = []
        self._homing = self._homed = False
        self._home_phase = "idle"
        self._home_progress = 0.0
        self._home_direction = "normal"
        self._home_origin = None
        self._home_started = self._home_phase_started = None
        self._home_reference = self._home_expected = None
        self._home_initial = self._home_park = None
        self._home_samples = []
        self._home_activity = False
        self._home_actions = []
        self._home_motion_timeout = None
        self._home_move_phase = None
        self._home_move_from = self._home_move_target = None
        self._home_contact_phase = None
        self._home_contact_position = None
        self._home_candidates = {}
        self._home_contacts = {}
        self._home_hold_position = None
        self._proposed_endpoints = self._proposed_bounds = None
        self._measured_endpoints = self._measured_travel = None

    def status(self):
        """Return the last observation and latched state, without doing I/O."""
        values = self._values
        position = read_motor.signed_position(values) if values is not None else None
        output = values[1] if values is not None else None
        return {
            "port": self.port, "baud": 19200, "slave": 1,
            "connected": self._connection is not None,
            "owned": self._owned,
            "motion_allowed": self.allow_motion,
            "armed": self._armed, "running": self._running,
            "stop_confirmed": self._stop_confirmed, "fault": self._fault,
            "homing": self._homing, "homed": self._homed,
            "home_phase": self._home_phase, "home_progress": self._home_progress,
            "home_direction": self._home_direction, "home_origin_raw": self._home_origin,
            "measured_endpoints_raw": (list(self._measured_endpoints)
                                       if self._measured_endpoints is not None else None),
            "measured_travel_raw": self._measured_travel,
            "nominal_counts_per_mm": COUNTS_PER_MM,
            "position_raw": position,
            "pending_raw": bench_jog.pending(values) if values is not None else None,
            "output_enabled": bool(output) if output in (0, 1) else None,
            "output_raw": output,
            "alarm": values[14] if values is not None else None,
            "mode": values[0] if values is not None else None,
            "speed_rpm": values[2] if values is not None else None,
            "acceleration_rpm_s": values[3] if values is not None else None,
            "current_raw": values[0x0F] if values is not None else None,
            "output_limit_stall_raw": values[0x18] if values is not None else None,
            "pwm_raw": values[19] if values is not None else None,
            "origin_raw": self._origin,
            "raw_bounds": [self._low, self._high] if self._origin is not None else None,
            "position_normalized": ((position - self._low) / (self._high - self._low)
                                    if position is not None and self._origin is not None else None),
            "target_raw": self._target,
            "observed_at": self._observed_at,
            "run_seconds": (max(0.0, self._clock() - self._enabled_at)
                            if self._running and self._enabled_at is not None else 0.0),
            "max_run_seconds": MAX_RUN_SECONDS,
            "cleanup_errors": list(self._cleanup_errors),
            "notice": ("Software stop/inhibit unconfirmed; use physical power isolation."
                       if self._owned and not self._stop_confirmed
                       and (self._fault or self._cleanup_errors) else
                       "Sensorless homing in progress." if self._homing else
                       "Motor running." if self._running else
                       "Motor homed." if self._homed else
                       "Software stop is not a hardware emergency stop."),
        }

    def _require_connection(self):
        if self._connection is None:
            raise TransportError("Connect an explicitly selected serial device first")

    def _require_clear_fault(self):
        self._require_connection()
        if self._fault:
            raise TransportError("Fault is latched; disconnect and inspect before reconnecting: " + self._fault)

    def _budget(self):
        if self._enabled_at is None:
            return IO_TIMEOUT
        remaining = MAX_RUN_SECONDS - (self._clock() - self._enabled_at)
        # Reserve the RTU gap and do not begin an exchange at the run boundary.
        if remaining <= IO_TIMEOUT + 0.005:
            raise TransportError("20-second hardware run limit reached")
        return IO_TIMEOUT

    def _read(self, budget=None):
        try:
            self._values = bench_jog.snapshot(self._connection, 1,
                                              self._budget() if budget is None else budget,
                                              lambda item: None)
            self._observed_at = self._clock()
            if self._stop_confirmed:
                if self._origin is None:
                    self._configuration(self._values, False, self._baseline)
                    position = read_motor.signed_position(self._values)
                else:
                    position = self._check_active(self._values, False)
                if (bench_jog.pending(self._values) != 0 or self._values[19] != 0
                        or abs(position - self._stop_position) > 4):
                    raise TransportError("Fresh readback contradicts the confirmed stationary stop")
        except (Exception, KeyboardInterrupt):
            # Confirmation describes the latest verified state, not a permanent
            # historical success. Never retain it after contradictory or lost I/O.
            self._stop_confirmed = False
            raise
        return self._values

    def _write(self, operation, budget=None):
        if operation not in ("clear", "enable", "inhibit"):
            raise TransportError("Unsupported transport operation")
        previous = self._values[1] if self._values is not None else 0
        bench_jog.write(self._connection, 1, operation, previous,
                        self._budget() if budget is None else budget, lambda item: None)

    @staticmethod
    def _configuration(values, enabled, baseline=None):
        if (values[0] != 1 or values[1] != int(enabled)
                or values[2:4] != [7, 15] or values[10] != 0
                or values[14] != 0 or values[20] != 0
                or values[21] != 1 or values[25] != 0):
            raise TransportError("Require mode 1, scalar output " + str(int(enabled))
                                 + ", speed/acceleration 7/15, gear 0, alarm 0, save 0, address 1, special 0")
        if baseline is not None and any(values[index] != baseline[index] for index in CONFIG):
            raise TransportError("Motor configuration changed after arming")

    def _check_active(self, values, enabled, hold=False):
        self._configuration(values, enabled, self._baseline)
        position = read_motor.signed_position(values)
        if not self._low - PADDING <= position <= self._high + PADDING:
            raise TransportError("Encoder position exceeded the fixed motion window")
        if hold and abs(position - self._hold_position) > 16:
            raise TransportError("Encoder drift exceeded the pre-motion hold tolerance")
        return position

    def _fault_and_cleanup(self, error):
        self._fault = self._fault or f"{type(error).__name__}: {error}"
        self._homed = False
        self._armed = self._running = False
        if self._owned and not self._cleanup_attempted:
            self._stop_impl()
        raise TransportError(self._fault) from error

    def connect(self):
        """Open fixed 19200 8N1/slave 1, then send exactly one read request."""
        if self._connection is not None:
            raise TransportError("Transport is already connected")
        if self._fault:
            raise TransportError("Create a new transport after inspecting the latched fault")
        try:
            factory = self._factory
            if factory is None:
                import serial
                factory = serial.Serial
            self._connection = factory(port=self.port, baudrate=19200, bytesize=8,
                                       parity="N", stopbits=1, timeout=IO_TIMEOUT,
                                       write_timeout=IO_TIMEOUT, exclusive=True)
            self._read(IO_TIMEOUT)
        except (Exception, KeyboardInterrupt) as error:
            connection, self._connection = self._connection, None
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            self._fault_and_cleanup(error)
        return self.status()

    def snapshot(self):
        self._require_connection()
        try:
            values = self._read()
            if self._armed or self._running:
                self._check_active(values, self._running)
        except (Exception, KeyboardInterrupt) as error:
            self._fault_and_cleanup(error)
        return self.status()

    def _home_stage(self, phase, progress):
        self._home_phase = phase
        self._home_progress = progress
        self._home_phase_started = self._clock()
        self._home_samples = []

    def _home_queue(self, actions, following, progress):
        self._home_actions = list(actions)
        self._home_following = following
        self._home_stage(self._home_actions[0][0], progress)

    def _write_home_setting(self, register, value):
        permitted = {0: {0, 1}, 2: {7, 80}, 3: {15}, 9: {0, 1}, 10: {0},
                     24: {89, self._home_reference[24]}, 25: {0, 1}}
        if register not in permitted or value not in permitted[register]:
            raise TransportError("Setting is outside the fixed native homing profile")
        body = bytes((1, 6)) + register.to_bytes(2, "big") + value.to_bytes(2, "big")
        tx = body + read_motor.crc16(body).to_bytes(2, "little")
        rx = bench_jog.exchange(self._connection, tx, IO_TIMEOUT, lambda item: None)
        if rx[:6] != tx[:6]:
            raise TransportError("Homing setting acknowledgement mismatch; no retry")
        self._home_expected[register] = value

    def _home_read(self, enabled=None, native=False):
        values = self._read(IO_TIMEOUT)
        if values[14] != 0 or values[20] != 0 or values[21] != 1 or values[10] != 0:
            raise TransportError("Native homing requires alarm 0, save 0, address 1 and gear 0")
        if native:
            # Native homing resets Modbus and the absolute coordinate. It may
            # therefore report mode 0 and packed flags during this one phase.
            if (values[0] not in (0, 1) or values[25] not in (0, 1)
                    or values[1] not in (0, 1, 2, 3, 6, 7)):
                raise TransportError("Unexpected drive state during native homing")
            indices = (4, 5, 6, 7, 8, 9, 10, 11, 20, 21)
        else:
            indices = CONFIG
            if enabled is not None and values[1] != int(enabled):
                raise TransportError("Unexpected output state during native homing")
        if any(values[index] != self._home_expected[index] for index in indices):
            raise TransportError("Unexpected configuration change during native homing")
        return values

    def _home_stationary(self, values, pending_tolerance=0, disabled=False):
        if (abs(bench_jog.pending(values)) > pending_tolerance
                or (disabled and values[19] != 0)):
            self._home_samples = []
            return False
        now = self._clock()
        if self._home_samples and now - self._home_samples[-1][0] < .075:
            return False
        self._home_samples.append((now, read_motor.signed_position(values)))
        self._home_samples = self._home_samples[-3:]
        positions = [position for _, position in self._home_samples]
        return len(positions) == 3 and max(positions) - min(positions) <= 4

    def _prepare_home(self):
        self._home_queue([
            ("clearing", "clear", 0),
            ("setting_home_speed", 2, 80),
            ("setting_home_acceleration", 3, 15),
            ("setting_home_output", 24, 89),
            ("setting_home_direction", 9, int(self._home_direction == "reverse")),
        ], "verify_preparation", .1)

    @staticmethod
    def _nonzero_target(target, low, high):
        """Absolute zero resets this drive; its nearest valid neighbor does not."""
        target = round(target)
        if target == 0:
            target = 1 if low <= 1 <= high else -1
        if not -(1 << 31) <= low <= target <= high < (1 << 31):
            raise TransportError("Absolute target is outside its bounded signed-32-bit interval")
        if target == 0:
            raise TransportError("Absolute zero cannot be sent to this drive")
        return target

    @staticmethod
    def _signed_pwm(values):
        raw = values[19]
        return raw - 65536 if raw & 32768 else raw

    def _begin_home_move(self, phase, target, position, enable=False):
        target = self._nonzero_target(target, -(1 << 31), (1 << 31) - 1)
        self._home_move_phase = phase
        self._home_move_from, self._home_move_target = position, target
        self._home_motion_timeout = (abs(target - position) / HOME_COUNTS_PER_SECOND
                                     + 7 / 15 + 5)
        progress = {"first_contact": .63, "first_retreat": .67, "first_retouch": .70,
                    "second_contact": .73, "second_retreat": .80,
                    "second_retouch": .84, "centering": .88}[phase]
        if enable:
            self._home_hold_position = position
            self._home_queue([("enabling_probe", "enable", 1)], "move_hold", progress)
        else:
            self._home_stage("commanding_" + phase, progress)

    def _contact_detected(self, values):
        position = read_motor.signed_position(values)
        error = self._home_move_target - position
        pending = bench_jog.pending(values)
        # These are host contact criteria, not calibrated force/current units.
        # Demand, remaining motion, and encoder stasis must agree on fresh reads.
        if (abs(error) < CONTACT_ERROR or abs(pending) < CONTACT_ERROR
                or error * pending <= 0 or abs(self._signed_pwm(values)) < CONTACT_PWM):
            self._home_samples = []
            return False
        now = self._clock()
        if self._home_samples and now - self._home_samples[-1][0] < .075:
            return False
        self._home_samples.append((now, position))
        while self._home_samples and max(p for _, p in self._home_samples) - min(p for _, p in self._home_samples) > 4:
            self._home_samples.pop(0)
        return (len(self._home_samples) >= 3
                and now - self._home_samples[0][0] >= CONTACT_SECONDS)

    def _capture_contact(self, phase, values):
        position = read_motor.signed_position(values)
        side = "first" if phase.startswith("first") else "second"
        if phase.endswith("retouch"):
            if abs(position - self._home_candidates[side]) > CONTACT_REPEAT_TOLERANCE:
                raise TransportError("Repeated endpoint contact did not agree within 128 counts")
            self._home_contacts[side] = round((position + self._home_candidates[side]) / 2)
        else:
            self._home_candidates[side] = position
        if side == "second":
            distance = abs(position - self._home_contacts["first"])
            if not HOME_MIN_SPAN <= distance <= HOME_SEARCH_COUNTS:
                raise TransportError("Measured rail travel must be between nominal 20 and 500 mm")
        self._home_contact_phase, self._home_contact_position = phase, position
        self._home_queue([("clearing_contact", "clear", 0),
                          ("inhibiting_contact", "inhibit", 0)],
                         "verify_contact_stop", self._home_progress)

    def _after_contact_stop(self, position):
        phase = self._home_contact_phase
        inward = 1 if self._home_direction == "reverse" else -1
        if phase in ("first_contact", "second_contact"):
            direction = inward if phase == "first_contact" else -inward
            target = self._home_contact_position + direction * HOME_INSET
            self._begin_home_move(phase.replace("contact", "retreat"), target, position, enable=True)
        elif phase == "first_retouch":
            # A contact at the maximum span still needs remaining demand.
            # One nominal mm of target overtravel supplies that demand, while
            # fresh encoder feedback independently enforces the 500 mm span.
            target = self._home_contacts["first"] + inward * (HOME_SEARCH_COUNTS + HOME_RETOUCH_OVERTRAVEL)
            self._begin_home_move("second_contact", target, position, enable=True)
        else:
            low, high = sorted(self._home_contacts.values())
            if not HOME_MIN_SPAN <= high - low <= HOME_SEARCH_COUNTS:
                raise TransportError("Measured rail travel must be between nominal 20 and 500 mm")
            self._proposed_endpoints = [low, high]
            self._proposed_bounds = [low + HOME_INSET, high - HOME_INSET]
            self._home_park = self._nonzero_target((low + high) / 2, *self._proposed_bounds)
            self._begin_home_move("centering", self._home_park, position, enable=True)

    def begin_home(self, reverse=False):
        """Start drive-native homing; subsequent polls perform bounded exchanges.

        This deliberately changes running configuration and establishes the drive
        coordinate. It never saves EEPROM, changes baud, or opens another port.
        Both mechanical contacts are measured in that coordinate before parking
        at their midpoint; normal travel is inset from the measured contacts.
        """
        self._require_clear_fault()
        if not self.allow_motion:
            raise TransportError("Hardware motion was not enabled at application launch")
        if type(reverse) is not bool:
            raise TransportError("Homing direction must be a boolean")
        if self._armed or self._running or self._owned or self._homing:
            raise TransportError("Stop and disarm before homing")
        self._stop_confirmed = False
        self._homed = False
        try:
            values = self._read(IO_TIMEOUT)
            disabled = ((values[0] == 1 and values[1] == 0)
                        or (values[0] == 0 and values[1] in (0, 2, 6)))
            if (not disabled or values[10] != 0
                    or values[14] != 0 or values[20] != 0 or values[21] != 1
                    or values[25] != 0 or not 0 <= values[24] <= 609
                    or bench_jog.pending(values) != 0 or values[19] != 0):
                raise TransportError("Home requires known disabled mode 0/1, gear 0, alarm/save/special 0, address 1, zero pending/PWM")
            self._home_reference = list(values)
            self._home_expected = list(values)
            self._home_initial = read_motor.signed_position(values)
            self._home_park = None
            self._home_direction = "reverse" if reverse else "normal"
            self._home_origin = None
            self._home_activity = False
            self._home_actions = []
            self._home_candidates, self._home_contacts = {}, {}
            self._home_motion_timeout = self._home_move_phase = None
            self._proposed_endpoints = self._proposed_bounds = None
            self._measured_endpoints = self._measured_travel = None
            self._home_started = self._clock()
            self._home_stage("preflight", 0.0)
            self._homing = self._owned = True
            self._cleanup_attempted = False
            self._cleanup_errors = []
            self._origin = self._low = self._high = self._baseline = None
            self._enabled_at = self._target = None
        except (Exception, KeyboardInterrupt) as error:
            self._fault_and_cleanup(error)
        return self.status()

    def poll_home(self):
        """Advance a homing step; STOP may run between any two polls."""
        self._require_clear_fault()
        if not self._homing:
            return self.status()
        try:
            now = self._clock()
            timeout = (HOME_SEEK_SECONDS if self._home_phase == "seeking" else
                       self._home_motion_timeout if self._home_phase == self._home_move_phase else 3.0)
            if (now - self._home_started > HOME_TOTAL_SECONDS
                    or now - self._home_phase_started > timeout):
                raise TransportError(f"Native homing timed out during {self._home_phase}; no retry")
            if self._home_actions:
                _, register, value = self._home_actions[0]
                if isinstance(register, str):
                    self._write(register, IO_TIMEOUT)
                else:
                    self._write_home_setting(register, value)
                self._home_actions.pop(0)
                following = (self._home_actions[0][0] if self._home_actions else self._home_following)
                self._home_stage(following, self._home_progress)
                return self.status()
            phase = self._home_phase
            if phase == "preflight":
                values = self._home_read()
                disabled = ((values[0] == 1 and values[1] == 0)
                            or (values[0] == 0 and values[1] in (0, 2, 6)))
                if not disabled:
                    raise TransportError("Output became enabled during homing preflight")
                if abs(read_motor.signed_position(values) - self._home_initial) > 4:
                    raise TransportError("Encoder moved during homing preflight")
                if self._home_stationary(values, disabled=True):
                    if values[0] == 0:
                        self._home_stage("selecting_modbus", .05)
                    else:
                        self._prepare_home()
            elif phase == "selecting_modbus":
                # Like bench_setup's bounded takeover, inhibit immediately even
                # if mode selection has an ambiguous acknowledgement.
                try:
                    self._write_home_setting(0, 1)
                finally:
                    self._write("inhibit", IO_TIMEOUT)
                self._home_stage("preparation_mode_settle", .05)
            elif phase == "preparation_mode_settle":
                if now - self._home_phase_started >= .8:
                    self._prepare_home()
            elif phase == "verify_preparation":
                values = self._home_read(False)
                if (bench_jog.pending(values) != 0 or values[19] != 0
                        or abs(read_motor.signed_position(values) - self._home_initial) > 4):
                    raise TransportError("Homing preparation did not remain stationary and inhibited")
                self._home_queue([("enabling_home", "enable", 1)], "enabled_hold", .2)
            elif phase == "enabled_hold":
                values = self._home_read(True)
                if abs(read_motor.signed_position(values) - self._home_initial) > 16:
                    raise TransportError("Encoder drifted before native homing trigger")
                if self._home_stationary(values):
                    self._home_queue([("triggering_home", 25, 1)], "seeking", .3)
            elif phase == "seeking":
                values = self._home_read(native=True)
                position = read_motor.signed_position(values)
                self._home_activity |= (abs(position - self._home_initial) > 16
                                        or abs(bench_jog.pending(values)) >= 15)
                self._home_progress = min(.55, .3 + .25 * (now - self._home_phase_started) / HOME_SEEK_SECONDS)
                near_origin = abs(position) <= 16
                if not self._home_activity or not near_origin:
                    self._home_samples = []
                elif self._home_stationary(values, pending_tolerance=14):
                    self._home_origin = position
                    self._home_queue([
                        ("inhibiting_after_home", "inhibit", 0),
                        ("restoring_modbus", 0, 1),
                        ("inhibiting_after_mode", "inhibit", 0),
                    ], "mode_settle", .6)
            elif phase == "mode_settle":
                # Match the upstream post-enable settling interval without
                # sleeping inside a poll or letting STOP wait behind that delay.
                if now - self._home_phase_started >= .8:
                    self._home_queue([
                        ("restoring_position_mode", 25, 0),
                        ("restoring_speed", 2, 7),
                        ("restoring_acceleration", 3, 15),
                        ("restoring_gear", 10, 0),
                        ("limiting_park_output", 24, 89),
                        ("clearing_before_park", "clear", 0),
                    ], "verify_restore", .65)
            elif phase == "verify_restore":
                values = self._home_read(False)
                if (abs(read_motor.signed_position(values)) > 32
                        or bench_jog.pending(values) != 0 or values[19] != 0):
                    raise TransportError("Home restoration did not remain stationary at the origin")
                inward = 1 if self._home_direction == "reverse" else -1
                self._begin_home_move("first_contact", -inward * HOME_FIRST_SEARCH,
                                      read_motor.signed_position(values), enable=True)
            elif phase == "move_hold":
                values = self._home_read(True)
                if abs(read_motor.signed_position(values) - self._home_hold_position) > 16:
                    raise TransportError("Encoder drifted before calibration move")
                if self._home_stationary(values):
                    self._home_stage("commanding_" + self._home_move_phase, self._home_progress)
            elif phase == "commanding_" + str(self._home_move_phase):
                # Each bounded command is transmitted once. No target-zero reset
                # and no ambiguous acknowledgement may issue a second move.
                bench_cycle.write_absolute(self._connection, 1, self._home_move_target,
                                           IO_TIMEOUT, lambda item: None)
                self._target = self._home_move_target
                self._home_stage(self._home_move_phase, self._home_progress)
            elif phase in ("first_contact", "first_retouch", "second_contact", "second_retouch",
                           "first_retreat", "second_retreat", "centering"):
                values = self._home_read(True)
                position = read_motor.signed_position(values)
                low = min(self._home_move_from, self._home_move_target) - PADDING
                high = max(self._home_move_from, self._home_move_target) + PADDING
                if not low <= position <= high:
                    raise TransportError("Encoder exceeded the bounded calibration move corridor")
                if (phase.startswith("second")
                        and abs(position - self._home_contacts["first"]) > HOME_SEARCH_COUNTS + PADDING):
                    raise TransportError("Encoder exceeded the maximum 500 mm rail search")
                if phase.endswith(("contact", "retouch")):
                    if self._contact_detected(values):
                        self._capture_contact(phase, values)
                else:
                    away = abs(position - self._home_contact_position) if phase != "centering" else 0
                    released = (phase == "centering" or
                                (away >= HOME_INSET - 16
                                 and abs(self._signed_pwm(values)) < CONTACT_PWM))
                    if abs(position - self._home_move_target) > 16 or not released:
                        self._home_samples = []
                    elif self._home_stationary(values, pending_tolerance=16):
                        if phase == "centering":
                            self._home_queue([("clearing_center", "clear", 0),
                                              ("inhibiting_center", "inhibit", 0)], "verify_stop", .94)
                        else:
                            side = "first" if phase == "first_retreat" else "second"
                            inward = 1 if self._home_direction == "reverse" else -1
                            direction = inward if side == "first" else -inward
                            target = self._home_candidates[side] - direction * HOME_RETOUCH_OVERTRAVEL
                            self._begin_home_move(side + "_retouch", target, position)
            elif phase == "verify_contact_stop":
                values = self._home_read(False)
                position = read_motor.signed_position(values)
                if abs(position - self._home_contact_position) > CONTACT_REPEAT_TOLERANCE:
                    raise TransportError("Encoder moved after contact inhibition")
                if self._home_stationary(values, disabled=True):
                    self._after_contact_stop(position)
            elif phase == "verify_stop":
                values = self._home_read(False)
                if abs(read_motor.signed_position(values) - self._home_park) > 16:
                    raise TransportError("Encoder drifted after centering")
                if self._home_stationary(values, disabled=True):
                    self._home_queue([("restoring_output", 24, self._home_reference[24])],
                                     "verify_complete", .95)
            elif phase == "verify_complete":
                values = self._home_read(False)
                position = read_motor.signed_position(values)
                if (abs(position - self._home_park) > 16
                        or bench_jog.pending(values) != 0 or values[19] != 0):
                    raise TransportError("Final homing stop was not confirmed")
                self._baseline = list(values)
                self._origin = self._home_park
                self._low, self._high = self._proposed_bounds
                self._measured_endpoints = list(self._proposed_endpoints)
                self._measured_travel = self._measured_endpoints[1] - self._measured_endpoints[0]
                self._hold_position = position
                self._stop_position = position
                self._stop_confirmed = self._homed = True
                self._homing = self._owned = False
                self._cleanup_attempted = True
                self._home_stage("complete", 1.0)
            else:
                raise TransportError("Unknown native homing phase")
        except (Exception, KeyboardInterrupt) as error:
            self._fault_and_cleanup(error)
        return self.status()

    def _stop_home(self):
        """Cancel native work with independent inhibit/mode-off attempts."""
        self._armed = self._running = self._homed = False
        if self._cleanup_attempted:
            self._homing = False
            return
        self._cleanup_attempted = True
        self._stop_confirmed = False
        errors = []
        # OSSM-RS disables the driver then Modbus; clear is also attempted once.
        # Do not let one missing ACK prevent either independent disable action.
        for operation in ("inhibit", "mode_off", "clear"):
            try:
                if operation == "mode_off":
                    self._write_home_setting(0, 0)
                else:
                    self._write(operation, IO_TIMEOUT)
            except (Exception, KeyboardInterrupt) as error:
                errors.append(f"{operation}: {type(error).__name__}: {error}")
        try:
            positions = []
            for index in range(3):
                if index:
                    self._wait(.1)
                values = self._read(IO_TIMEOUT)
                if (values[0] not in (0, 1) or values[1] not in (0, 2, 6)
                        or bench_jog.pending(values) != 0 or values[19] != 0):
                    raise TransportError("Native cancellation did not inhibit output")
                positions.append(read_motor.signed_position(values))
            if max(positions) - min(positions) > 4:
                raise TransportError("Native cancellation encoder did not settle")
            if not errors:
                # Restore only after disabled readback; mode changes may reset
                # drive settings, so immediately inhibit again and reapply limits.
                try:
                    self._write_home_setting(0, 1)
                finally:
                    self._write("inhibit", IO_TIMEOUT)
                # Output is already inhibited. Cancellation restoration is a
                # bounded cleanup; seek/park polls never block for this interval.
                self._wait(.8)
                for register, value in ((25, 0), (2, 7), (3, 15), (10, 0),
                                        (24, self._home_reference[24])):
                    self._write_home_setting(register, value)
                positions = []
                for index in range(3):
                    if index:
                        self._wait(.1)
                    values = self._home_read(False)
                    if bench_jog.pending(values) != 0 or values[19] != 0:
                        raise TransportError("Restored cancellation state is not stopped")
                    positions.append(read_motor.signed_position(values))
                if max(positions) - min(positions) > 4:
                    raise TransportError("Restored cancellation encoder did not settle")
                self._baseline = list(values)
                self._stop_position = positions[-1]
        except (Exception, KeyboardInterrupt) as error:
            errors.append(f"readback/restore: {type(error).__name__}: {error}")
        self._homing = False
        self._home_origin = None
        self._home_actions = []
        self._enabled_at = None
        self._cleanup_errors = errors
        self._stop_confirmed = not errors
        if errors:
            self._fault = self._fault or "; ".join(errors)
        else:
            self._owned = False
        self._home_stage("fault" if self._fault else "cancelled", self._home_progress)

    def arm(self):
        """Read-only gate; preserve existing settings and capture a raw window."""
        self._require_clear_fault()
        if not self.allow_motion:
            raise TransportError("Hardware motion was not enabled at application launch")
        if self._running or self._owned or self._homing:
            raise TransportError("Stop the existing run before arming")
        self._armed = False
        try:
            positions = []
            baseline = self._baseline
            for index in range(3):
                if index:
                    self._wait(0.1)
                values = self._read(IO_TIMEOUT)
                self._configuration(values, False, baseline)
                if bench_jog.pending(values) != 0 or values[19] != 0:
                    raise TransportError("Arming requires zero pending motion and zero output PWM")
                baseline = list(values) if baseline is None else baseline
                positions.append(read_motor.signed_position(values))
            if max(positions) - min(positions) > 4:
                raise TransportError("Encoder was not stable across three fresh arming reads")
            held_position = positions[-1]
            if self._origin is None:
                low, high = held_position - HALF_WINDOW, held_position + HALF_WINDOW
                if not -(1 << 31) <= low <= high < (1 << 31):
                    raise TransportError("Motion window crosses the signed 32-bit counter boundary")
                if low <= 0 <= high:
                    raise TransportError("Motion window includes absolute zero, which resets the drive coordinate")
                self._baseline, self._origin = baseline, held_position
                self._low, self._high = low, high
            elif not all(self._low <= position <= self._high for position in positions):
                raise TransportError("Rearming requires the encoder to remain inside the original fixed window")
            self._hold_position = self._target = held_position
            self._tracking_failures = 0
            self._enabled_at = None
            self._stop_confirmed = False
            self._cleanup_attempted = False
            self._armed = True
        except (Exception, KeyboardInterrupt) as error:
            self._fault_and_cleanup(error)
        return self.status()

    def _stable_hold(self, enabled):
        positions = []
        for _ in range(3):
            self._wait(0.1)
            values = self._read()
            positions.append(self._check_active(values, enabled, hold=True))
            if bench_jog.pending(values) != 0 or (not enabled and values[19] != 0):
                raise TransportError("Pending motion or output PWM present during hold verification")
        if max(positions) - min(positions) > 4:
            raise TransportError("Encoder was not stable during hold verification")

    def start(self):
        self._require_clear_fault()
        if not self.allow_motion or not self._armed or self._running:
            raise TransportError("An explicitly armed, stopped transport is required")
        try:
            # Revalidate immediately before claiming write ownership; stale ARM
            # state must not permit takeover of a changed or already active drive.
            values = self._read(IO_TIMEOUT)
            self._check_active(values, False, hold=True)
            if bench_jog.pending(values) != 0 or values[19] != 0:
                raise TransportError("Motor is no longer stationary and inhibited")
            self._owned = True
            self._write("clear")
            self._stable_hold(False)
            self._enabled_at = self._clock()  # Include the enable exchange itself.
            self._write("enable")
            self._stable_hold(True)
            self._running = True
        except (Exception, KeyboardInterrupt) as error:
            self._fault_and_cleanup(error)
        return self.status()

    def command(self, normalized):
        self._require_clear_fault()
        if not self.allow_motion or not self._armed or not self._running:
            raise TransportError("ARM and START are required before sending a target")
        try:
            if (isinstance(normalized, bool) or not isinstance(normalized, (int, float))
                    or not math.isfinite(normalized) or not 0 <= normalized <= 1):
                raise TransportError("Position must be a finite normalized value from 0 through 1")
            target = self._nonzero_target(self._low + (self._high - self._low) * normalized,
                                          self._low, self._high)
            values = self._read()
            position = self._check_active(values, True)
            self._tracking_failures = (self._tracking_failures + 1
                                       if abs(position - self._target) > 1024 else 0)
            if self._tracking_failures >= 3:
                raise TransportError("Tracking error exceeded 1024 raw counts for three fresh samples")
            bench_cycle.write_absolute(self._connection, 1, target, self._budget(), lambda item: None)
            self._target = target
        except (Exception, KeyboardInterrupt) as error:
            self._fault_and_cleanup(error)
        return self.status()

    def _stop_impl(self):
        if self._homing:
            self._stop_home()
            return
        self._armed = self._running = False
        if not self._owned or self._cleanup_attempted:
            return
        self._cleanup_attempted = True
        self._stop_confirmed = False
        errors = []
        # Independent single attempts: a missing clear ACK must never prevent
        # inhibit, and an ambiguous target is never retransmitted.
        for operation in ("clear", "inhibit"):
            try:
                self._write(operation, IO_TIMEOUT)
            except (Exception, KeyboardInterrupt) as error:
                errors.append(f"{operation}: {type(error).__name__}: {error}")
        try:
            positions = []
            for index in range(3):
                if index:
                    self._wait(0.1)
                values = self._read(IO_TIMEOUT)
                positions.append(self._check_active(values, False))
                if bench_jog.pending(values) != 0 or values[19] != 0:
                    raise TransportError("Stop readback has pending motion or nonzero output PWM")
            if max(positions) - min(positions) > 4:
                raise TransportError("Encoder did not settle after stop/inhibit")
        except (Exception, KeyboardInterrupt) as error:
            errors.append(f"readback: {type(error).__name__}: {error}")
        self._cleanup_errors = errors
        self._enabled_at = None
        self._stop_confirmed = not errors
        self._stop_position = positions[-1] if self._stop_confirmed else None
        if errors:
            self._fault = self._fault or "; ".join(errors)
        else:
            self._owned = False

    def stop(self):
        """Stop only a run this instance owns; never take over an unknown drive."""
        self._require_connection()
        self._stop_impl()
        if self._cleanup_errors:
            raise TransportError("Stop/inhibit unconfirmed: " + "; ".join(self._cleanup_errors))
        return self.status()

    def close(self):
        """Release serial ownership after at most one cleanup sequence per run."""
        self._homed = False
        if self._connection is None:
            return
        try:
            self._stop_impl()
        finally:
            connection, self._connection = self._connection, None
            self._armed = self._running = False
            try:
                connection.close()
            except Exception as error:
                self._fault = self._fault or f"close: {error}"
                raise TransportError(self._fault) from error
