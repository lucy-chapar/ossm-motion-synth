# SPDX-License-Identifier: MPL-2.0
"""Offline laptop transport checks using complete, CRC-checked fake serial frames."""

import math
import types
import unittest
from unittest.mock import patch

from tests.serial_fakes import AbsoluteMotor
from tests.serial_fakes import Clock, frame
from virtual_synth.protocol import bench_jog, read_motor
from virtual_synth.transport import MotorTransport, TransportError, MAX_RUN_SECONDS, list_ports


class FakeMotor(AbsoluteMotor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.values[2:4] = [7, 15]
        self.position(20000)
        self.closed = False

    def close(self):
        self.closed = True


class NativeHomeMotor(FakeMotor):
    """Motor-side mechanical home and mode-reset behavior, entirely in memory."""
    def __init__(self, home_ignored=False, **kwargs):
        super().__init__(**kwargs)
        self.native_active = False
        self.native_reads = 0
        self.home_ignored = home_ignored
        self.settings = []
        self.setting_hook = None
        self.native_hook = None
        self.rail_contacts = None
        self.contact_pwm = 2500
        self.absolute_states = []

    def write(self, tx):
        if tx[1] == 16 and tx[3] == 22:
            # The native routine resets once near one end. Subsequent targets
            # retain that coordinate and physically stop at either rail end.
            self.writes.append(tx)
            target = int.from_bytes(tx[7:9], "big") | (int.from_bytes(tx[9:11], "big") << 16)
            if target & (1 << 31):
                target -= 1 << 32
            self.destinations.append(target)
            self.commands.append("absolute")
            self.absolute_states.append(list(self.values))
            self.target = target
            contacts = self.rail_contacts
            if contacts is None:
                contacts = (-3277, 160563) if self.values[9] else (-160563, 3277)
            position = max(contacts[0], min(contacts[1], target))
            self.position(position)
            self.remaining(target - position)
            pwm = self.contact_pwm * (1 if target > position else -1) if target != position else 0
            self.values[19] = pwm & 65535
            reply = frame(tx[:6])
            if self.on_command:
                replacement = self.on_command(self, "absolute", tx, self.values[1])
                if replacement is not None:
                    reply = replacement
            self.incoming.extend(reply)
            return len(tx)
        if ((tx[1] == 6 and tx[3] == 1 and tx[5] == 0)
                or (tx[1] == 16 and tx[3] == 12)):
            self.values[19] = 0
        if tx[1] == 3 and self.native_active:
            self.native_reads += 1
            if not self.home_ignored:
                if self.native_reads == 1:
                    self.position(19000)
                    self.remaining(100)
                else:
                    self.position(0)
                    self.remaining(0)
            if self.native_hook:
                self.native_hook(self)
        if tx[1] == 6:
            register = int.from_bytes(tx[2:4], "big")
            value = int.from_bytes(tx[4:6], "big")
            if register == 1 and value == 0:
                self.native_active = False
            if register != 1:
                self.writes.append(tx)
                self.settings.append((register, value))
                self.values[register] = value
                if register == 0:
                    if value == 0:
                        self.native_active = False
                    else:
                        # Exercise the documented mode reset: restoring mode
                        # must be followed by inhibit and explicit safe limits.
                        self.values[1], self.values[2] = 1, 1500
                        self.values[3], self.values[24] = 50000, 600
                if register == 25:
                    self.native_active = value == 1
                    if self.native_active:
                        self.values[0] = 0
                reply = tx
                if self.setting_hook:
                    replacement = self.setting_hook(self, register, value, tx)
                    if replacement is not None:
                        reply = replacement
                self.incoming.extend(reply)
                return len(tx)
        return super().write(tx)


class TransportTests(unittest.TestCase):
    def make(self, motor=None, allowed=True):
        motor, clock, opens = motor or FakeMotor(), Clock(), []

        def factory(**kwargs):
            opens.append(kwargs)
            return motor

        transport = MotorTransport("/dev/fake-offline", allow_motion=allowed,
                                   connection_factory=factory, clock=clock.now, wait=clock.wait)
        return transport, motor, clock, opens

    def running(self, motor=None):
        transport, motor, clock, opens = self.make(motor)
        transport.connect()
        transport.arm()
        transport.start()
        return transport, motor, clock, opens

    def advance_home(self, transport, clock, until="complete", limit=500):
        for _ in range(limit):
            if transport.status()["home_phase"] == until:
                return transport.status()
            clock.wait(.1)
            transport.poll_home()
        self.fail("Homing did not reach phase " + until)

    def begin_native(self, motor=None, reverse=False):
        transport, motor, clock, opens = self.make(motor or NativeHomeMotor())
        transport.connect()
        transport.begin_home(reverse=reverse)
        return transport, motor, clock, opens

    def test_native_home_restores_profile_centers_and_sets_measured_window(self):
        for reverse, target in ((False, -78643), (True, 78643)):
            with self.subTest(reverse=reverse):
                transport, motor, clock, _ = self.begin_native(reverse=reverse)
                self.assertEqual(transport.status()["notice"], "Sensorless homing in progress.")
                initial_output = motor.values[24]
                status = self.advance_home(transport, clock)
                self.assertFalse(status["homing"])
                self.assertTrue(status["homed"])
                self.assertFalse(status["armed"])
                self.assertFalse(status["running"])
                self.assertFalse(status["owned"])
                self.assertTrue(status["stop_confirmed"])
                self.assertEqual(status["notice"], "Motor homed.")
                self.assertEqual(status["home_origin_raw"], 0)
                self.assertEqual(status["home_direction"], "reverse" if reverse else "normal")
                self.assertEqual(status["home_progress"], 1)
                self.assertEqual(status["origin_raw"], target)
                self.assertEqual(status["raw_bounds"],
                                 [-1639, 158925] if reverse else [-158925, 1639])
                self.assertEqual(status["position_normalized"], .5)
                self.assertEqual(motor.destinations[-1], target)
                self.assertEqual(len(motor.destinations), 7)
                self.assertEqual(motor.settings.count((25, 1)), 1)
                self.assertEqual(motor.values[0:4], [1, 0, 7, 15])
                self.assertEqual(motor.values[10], 0)
                self.assertEqual(motor.values[24], initial_output)
                self.assertEqual(motor.values[25], 0)
                self.assertNotIn((20, 1), motor.settings)
                # The normal motion path can arm using this established window.
                self.assertTrue(transport.arm()["armed"])
                self.assertEqual(transport.status()["origin_raw"], target)
                transport.close()
                self.assertFalse(transport.status()["homed"])

    def test_native_homing_requires_permission_and_stationary_read_only_preflight(self):
        transport, motor, _, _ = self.make(NativeHomeMotor(), allowed=False)
        transport.connect()
        with self.assertRaises(TransportError):
            transport.begin_home()
        self.assertEqual(motor.commands, [])
        self.assertEqual(motor.settings, [])
        for field, value in ((0, 2), (1, 1), (10, 1), (14, 1), (20, 1),
                             (21, 2), (25, 1), (12, 1), (19, 1), (24, 610)):
            transport, motor, _, _ = self.make(NativeHomeMotor())
            motor.values[field] = value
            transport.connect()
            with self.assertRaises(TransportError):
                transport.begin_home()
            self.assertEqual(motor.commands, [])
            self.assertEqual(motor.settings, [])

    def test_native_home_accepts_known_disabled_mode_zero_after_stable_preflight(self):
        for flags in (0, 2, 6):
            with self.subTest(flags=flags):
                motor = NativeHomeMotor()
                motor.values[0:2] = [0, flags]
                transport, motor, clock, _ = self.begin_native(motor)
                self.advance_home(transport, clock, until="selecting_modbus")
                self.assertEqual(motor.settings, [])
                self.assertEqual(motor.commands, [])
                transport.poll_home()
                self.assertEqual(motor.settings, [(0, 1)])
                self.assertEqual(motor.commands, ["inhibit"])
                self.assertEqual(motor.values[1], 0)
                writes = len(motor.writes)
                clock.wait(.5)
                transport.poll_home()
                self.assertEqual(len(motor.writes), writes)
                self.assertEqual(transport.status()["home_phase"], "preparation_mode_settle")
                status = self.advance_home(transport, clock)
                self.assertTrue(status["homed"])
                self.assertEqual(motor.values[0:4], [1, 0, 7, 15])
                self.assertEqual(motor.destinations[-1], -78643)

    def test_native_home_never_takes_over_enabled_or_unknown_mode_zero(self):
        for mode, flags in ((0, 1), (0, 3), (0, 7), (0, 4), (1, 2), (1, 6)):
            with self.subTest(mode=mode, flags=flags):
                motor = NativeHomeMotor()
                motor.values[0:2] = [mode, flags]
                transport, motor, _, _ = self.make(motor)
                transport.connect()
                with self.assertRaises(TransportError):
                    transport.begin_home()
                self.assertEqual(motor.settings, [])
                self.assertEqual(motor.commands, [])
                self.assertFalse(transport.status()["owned"])

    def test_ambiguous_initial_mode_selection_still_inhibits_without_homing_trigger(self):
        motor = NativeHomeMotor()
        motor.values[0:2] = [0, 2]
        motor.setting_hook = lambda m, reg, val, tx: b"" if (reg, val) == (0, 1) else None
        transport, motor, clock, _ = self.begin_native(motor)
        self.advance_home(transport, clock, until="selecting_modbus")
        with self.assertRaises(TransportError):
            transport.poll_home()
        self.assertEqual(motor.commands[0], "inhibit")
        self.assertNotIn((25, 1), motor.settings)
        self.assertEqual(motor.destinations, [])
        self.assertFalse(transport.status()["homed"])
        self.assertTrue(transport.status()["fault"])

    def test_native_initial_zero_pending_without_activity_never_completes(self):
        for initial in (0, 20000):
            transport, motor, clock, _ = self.make(NativeHomeMotor(home_ignored=True))
            motor.position(initial)
            transport.connect()
            transport.begin_home()
            self.advance_home(transport, clock, until="seeking")
            for _ in range(6):
                clock.wait(.1)
                transport.poll_home()
                self.assertEqual(transport.status()["home_phase"], "seeking")
            clock.wait(31)
            with self.assertRaises(TransportError):
                transport.poll_home()
            self.assertFalse(transport.status()["homed"])
            self.assertFalse(transport.status()["homing"])
            self.assertTrue(transport.status()["fault"])
            self.assertEqual(motor.destinations, [])
            self.assertIn((0, 0), motor.settings)

    def test_native_pending_reappearance_resets_completion_samples(self):
        motor = NativeHomeMotor()
        motor.native_hook = lambda m: m.remaining(30) if m.native_reads == 3 else None
        transport, motor, clock, _ = self.begin_native(motor)
        self.advance_home(transport, clock, until="seeking")
        for _ in range(5):
            clock.wait(.1)
            transport.poll_home()
            self.assertEqual(transport.status()["home_phase"], "seeking")
        clock.wait(.1)
        transport.poll_home()
        self.assertEqual(transport.status()["home_phase"], "inhibiting_after_home")
        transport.stop()

    def test_native_fresh_coordinate_reset_can_prove_a_short_home_between_polls(self):
        motor = NativeHomeMotor()
        motor.native_hook = lambda m: (m.position(0), m.remaining(0))
        transport, motor, clock, _ = self.begin_native(motor)
        status = self.advance_home(transport, clock)
        self.assertTrue(status["homed"])
        self.assertEqual(motor.destinations[-1], -78643)

    def test_native_mode_restore_waits_before_reapplying_operating_profile(self):
        transport, motor, clock, _ = self.begin_native()
        self.advance_home(transport, clock, until="mode_settle")
        writes = len(motor.writes)
        clock.wait(.5)
        transport.poll_home()
        self.assertEqual(len(motor.writes), writes)
        self.assertEqual(motor.values[1], 0)
        self.assertEqual(motor.values[2], 1500)
        clock.wait(.4)
        transport.poll_home()
        self.assertEqual(transport.status()["home_phase"], "restoring_position_mode")
        self.assertEqual(len(motor.writes), writes)
        status = self.advance_home(transport, clock)
        self.assertTrue(status["homed"])
        self.assertEqual(motor.values[0:4], [1, 0, 7, 15])

    def test_stop_cancels_native_home_at_each_phase_without_later_targets(self):
        for phase in ("preflight", "seeking", "restoring_modbus", "centering"):
            with self.subTest(phase=phase):
                transport, motor, clock, _ = self.begin_native()
                self.advance_home(transport, clock, until=phase)
                before_targets = list(motor.destinations)
                status = transport.stop()
                self.assertFalse(status["homed"])
                self.assertFalse(status["homing"])
                self.assertEqual(status["home_phase"], "cancelled")
                self.assertTrue(status["stop_confirmed"])
                self.assertEqual(motor.values[0:4], [1, 0, 7, 15])
                self.assertEqual(motor.values[25], 0)
                self.assertIn((0, 0), motor.settings)
                clock.wait(.1)
                transport.poll_home()
                self.assertTrue(transport.snapshot()["stop_confirmed"])
                self.assertEqual(motor.destinations, before_targets)
                transport.close()

    def test_native_abort_inhibit_ack_loss_still_disables_mode_and_preserves_uncertainty(self):
        transport, motor, clock, _ = self.begin_native()
        self.advance_home(transport, clock, until="seeking")
        motor.on_command = lambda m, op, tx, previous: b"" if op == "inhibit" else None
        with self.assertRaises(TransportError):
            transport.stop()
        self.assertIn((0, 0), motor.settings)
        status = transport.status()
        self.assertFalse(status["homing"])
        self.assertFalse(status["homed"])
        self.assertFalse(status["stop_confirmed"])
        self.assertTrue(status["owned"])
        self.assertTrue(status["fault"])
        count = len(motor.writes)
        transport.close()
        self.assertEqual(len(motor.writes), count)

    def test_native_probe_ack_failure_never_retries_and_invalidates_reference(self):
        motor = NativeHomeMotor()
        motor.on_command = lambda m, op, tx, previous: b"" if op == "absolute" else None
        transport, motor, clock, _ = self.begin_native(motor)
        self.advance_home(transport, clock, until="commanding_first_contact")
        with self.assertRaises(TransportError):
            transport.poll_home()
        self.assertEqual(motor.destinations, [8192])
        self.assertFalse(transport.status()["homed"])
        self.assertTrue(transport.status()["fault"])
        self.assertTrue(transport.status()["stop_confirmed"])

    def test_native_probe_timeout_cleans_up_without_reissuing_target(self):
        motor = NativeHomeMotor()

        def parked_nowhere(motor, operation, tx, previous):
            if operation == "absolute":
                motor.position(0)
                motor.remaining(8192)
                motor.values[19] = 0

        motor.on_command = parked_nowhere
        transport, motor, clock, _ = self.begin_native(motor)
        self.advance_home(transport, clock, until="first_contact")
        clock.wait(400)
        with self.assertRaises(TransportError):
            transport.poll_home()
        self.assertEqual(motor.destinations, [8192])
        self.assertFalse(transport.status()["homed"])
        self.assertTrue(transport.status()["fault"])
        self.assertTrue(transport.status()["stop_confirmed"])

    def test_ambiguous_native_trigger_is_not_repeated_and_still_cancels(self):
        motor = NativeHomeMotor()
        motor.setting_hook = lambda m, reg, val, tx: b"" if (reg, val) == (25, 1) else None
        transport, motor, clock, _ = self.begin_native(motor)
        self.advance_home(transport, clock, until="triggering_home")
        with self.assertRaises(TransportError):
            transport.poll_home()
        self.assertEqual(motor.settings.count((25, 1)), 1)
        self.assertIn((0, 0), motor.settings)
        self.assertEqual(motor.destinations, [])
        self.assertFalse(transport.status()["homed"])
        self.assertTrue(transport.status()["fault"])

    def test_native_configuration_change_fails_before_homing_trigger(self):
        transport, motor, clock, _ = self.begin_native()
        self.advance_home(transport, clock, until="verify_preparation")
        motor.values[7] += 1
        with self.assertRaises(TransportError):
            transport.poll_home()
        self.assertNotIn((25, 1), motor.settings)
        self.assertFalse(transport.status()["homed"])
        self.assertTrue(transport.status()["fault"])

    def test_construction_status_and_read_only_connect_close_never_control_motor(self):
        transport, motor, _, opens = self.make(allowed=False)
        self.assertEqual(opens, [])
        self.assertFalse(transport.status()["connected"])
        self.assertIsNone(transport.status()["position_raw"])
        status = transport.connect()
        self.assertEqual(opens, [{"port": "/dev/fake-offline", "baudrate": 19200,
                                "bytesize": 8, "parity": "N", "stopbits": 1,
                                "timeout": .15, "write_timeout": .15, "exclusive": True}])
        self.assertEqual(status["position_raw"], 20000)
        self.assertFalse(status["stop_confirmed"])
        with self.assertRaises(TransportError):
            transport.arm()
        transport.stop()
        transport.close()
        self.assertEqual(motor.commands, [])
        self.assertEqual(motor.writes, [read_motor.snapshot_request()])
        self.assertTrue(motor.closed)
        self.assertFalse(transport.status()["stop_confirmed"])

    def test_port_enumeration_uses_metadata_without_opening_or_probing(self):
        ports = [types.SimpleNamespace(device="/dev/fake-b", description="B"),
                 types.SimpleNamespace(device="/dev/fake-a", description="A")]
        serial = types.ModuleType("serial")
        serial.Serial = lambda **kwargs: self.fail("Enumeration must not open a device")
        serial_tools = types.ModuleType("serial.tools")
        serial_tools.list_ports = types.SimpleNamespace(comports=lambda: ports)
        with patch.dict("sys.modules", {"serial": serial, "serial.tools": serial_tools}):
            self.assertEqual(list_ports(), [{"device": "/dev/fake-a", "description": "A"},
                                           {"device": "/dev/fake-b", "description": "B"}])

    def test_current_and_output_limit_telemetry_remain_raw_and_read_only(self):
        transport, motor, _, opens = self.make(allowed=False)
        before = transport.status()
        self.assertIsNone(before["current_raw"])
        self.assertIsNone(before["output_limit_stall_raw"])
        self.assertEqual(opens, [])
        motor.values[0x0F], motor.values[0x18] = 4321, 0xABCD
        connected = transport.connect()
        self.assertEqual(connected["current_raw"], 4321)
        self.assertEqual(connected["output_limit_stall_raw"], 0xABCD)
        count = len(motor.writes)
        self.assertEqual(transport.status()["current_raw"], 4321)
        self.assertEqual(len(motor.writes), count, "status must not poll the drive")
        motor.values[0x0F], motor.values[0x18] = 0, 0xFFFF
        observed = transport.snapshot()
        self.assertEqual(observed["current_raw"], 0)
        self.assertEqual(observed["output_limit_stall_raw"], 0xFFFF)
        transport.close()
        self.assertEqual(len(opens), 1)
        self.assertEqual(motor.commands, [])
        self.assertEqual(motor.writes, [read_motor.snapshot_request()] * 2)

    def test_unknown_output_is_displayed_without_automatic_takeover(self):
        transport, motor, _, _ = self.make()
        motor.values[1] = 7
        status = transport.connect()
        self.assertIsNone(status["output_enabled"])
        self.assertEqual(status["output_raw"], 7)
        self.assertIsNone(status["fault"])
        with self.assertRaises(TransportError):
            transport.arm()
        transport.close()
        self.assertEqual(motor.commands, [])

    def test_enable_requires_launch_permission_and_explicit_arm_start(self):
        transport, motor, _, _ = self.make()
        transport.connect()
        for action in (transport.start, lambda: transport.command(.5)):
            with self.assertRaises(TransportError):
                action()
        transport.arm()
        with self.assertRaises(TransportError):
            transport.command(.5)
        self.assertEqual(motor.commands, [])
        transport.close()

    def test_each_arm_gate_rejects_without_control_writes(self):
        for address, bad in ((0, 0), (1, 1), (1, 4), (2, 3), (3, 10), (10, 1),
                             (14, 1), (20, 1), (21, 2), (25, 1), (12, 1), (19, 1)):
            with self.subTest(address=address):
                transport, motor, _, _ = self.make()
                motor.values[address] = bad
                transport.connect()
                with self.assertRaises(TransportError):
                    transport.arm()
                self.assertTrue(transport.status()["fault"])
                transport.close()
                self.assertEqual(motor.commands, [])

    def test_arm_observes_three_stable_fresh_positions_and_config(self):
        transport, motor, clock, _ = self.make()
        transport.connect()
        status = transport.arm()
        self.assertEqual(motor.read_count, 4)
        self.assertAlmostEqual(clock.elapsed, .2)
        self.assertEqual(status["raw_bounds"], [15904, 24096])
        self.assertEqual(status["position_normalized"], .5)
        transport.close()
        for change in ("position", "config"):
            transport, motor, _, _ = self.make()
            transport.connect()

            def changing(motor, change=change):
                if motor.read_count == 3:
                    if change == "position":
                        motor.position(20005)
                    else:
                        motor.values[7] += 1

            motor.on_read = changing
            with self.assertRaises(TransportError):
                transport.arm()
            self.assertEqual(motor.commands, [])

    def test_entire_window_must_avoid_zero_and_signed_counter_boundary(self):
        for position in (0, 4096, -4096, 1, (1 << 31) - 4096, -(1 << 31) + 4095):
            with self.subTest(position=position):
                transport, motor, _, _ = self.make()
                motor.position(position)
                transport.connect()
                with self.assertRaises(TransportError):
                    transport.arm()
                self.assertEqual(motor.commands, [])
        for position in (4097, -4097, -(1 << 31) + 4096, (1 << 31) - 4097):
            with self.subTest(valid_position=position):
                transport, motor, _, _ = self.make()
                motor.position(position)
                transport.connect()
                self.assertTrue(transport.arm()["armed"])
                transport.close()

    def test_start_verifies_off_then_enabled_stable_hold_before_any_target(self):
        transport, motor, clock, _ = self.running()
        self.assertEqual(motor.commands, ["clear", "enable"])
        self.assertEqual(motor.read_count, 11)
        self.assertAlmostEqual(clock.elapsed, .8)
        self.assertTrue(transport.status()["running"])
        self.assertEqual(motor.destinations, [])
        transport.command(.75)
        self.assertEqual(motor.destinations, [22048])
        self.assertEqual(motor.writes[-1][:11], bytes.fromhex("01 10 00 16 00 02 04 56 20 00 00"))
        transport.close()

    def test_start_revalidates_arm_before_claiming_write_ownership(self):
        transport, motor, _, _ = self.make()
        transport.connect()
        transport.arm()
        motor.values[1] = 1
        with self.assertRaises(TransportError):
            transport.start()
        self.assertEqual(motor.commands, [])
        self.assertFalse(transport.status()["stop_confirmed"])

    def test_ignored_enable_and_unstable_hold_cleanup_without_target(self):
        for scenario in ("ignored", "drift", "pending"):
            def change(motor, operation, tx, previous, scenario=scenario):
                if operation == "enable":
                    if scenario == "ignored":
                        motor.values[1] = 0
                    elif scenario == "drift":
                        motor.position(20017)
                    else:
                        motor.remaining(1)

            transport, motor, _, _ = self.make(FakeMotor(on_command=change))
            transport.connect()
            transport.arm()
            with self.assertRaises(TransportError):
                transport.start()
            self.assertEqual(motor.destinations, [])
            self.assertEqual(motor.commands, ["clear", "enable", "clear", "inhibit"])
            self.assertTrue(transport.status()["fault"])
            transport.close()
            self.assertEqual(len(motor.commands), 4)

    def test_signed_absolute_endpoints_and_zero_are_never_encoded(self):
        for origin in (20000, -20000):
            motor = FakeMotor()
            motor.position(origin)
            transport, motor, _, _ = self.running(motor)
            for normalized in (0, .5, 1):
                transport.command(normalized)
            self.assertEqual(motor.destinations, [origin - 4096, origin, origin + 4096])
            self.assertNotIn(0, motor.destinations)
            transport.close()

    def test_invalid_normalized_commands_fault_and_cleanup_without_absolute(self):
        for value in (-.1, 1.1, math.nan, math.inf, -math.inf, True, "0.5", None):
            with self.subTest(value=value):
                transport, motor, _, _ = self.running()
                with self.assertRaises(TransportError):
                    transport.command(value)
                self.assertEqual(motor.destinations, [])
                self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])
                self.assertTrue(transport.status()["fault"])
                self.assertTrue(transport.status()["stop_confirmed"])

    def test_ambiguous_target_ack_never_retries_and_fault_remains_after_confirmed_stop(self):
        for reply in (b"", frame(bytes.fromhex("01 10 00 0c 00 02")),
                      frame(bytes.fromhex("01 10 00 16 00 01"))):
            def bad_ack(motor, operation, tx, previous, reply=reply):
                return reply if operation == "absolute" else None

            transport, motor, _, _ = self.running(FakeMotor(on_command=bad_ack))
            with self.assertRaises(TransportError):
                transport.command(.6)
            self.assertEqual(len(motor.destinations), 1)
            self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])
            self.assertTrue(transport.status()["stop_confirmed"])
            self.assertTrue(transport.status()["fault"])
            with self.assertRaises(TransportError):
                transport.arm()
            transport.close()
            with self.assertRaises(TransportError):
                transport.connect()

    def test_active_config_alarm_output_and_bounds_are_checked_before_next_target(self):
        for scenario in ("config", "alarm", "output", "bounds"):
            with self.subTest(scenario=scenario):
                transport, motor, _, _ = self.running()
                if scenario == "config":
                    motor.values[7] += 1
                elif scenario == "alarm":
                    motor.values[14] = 1
                elif scenario == "output":
                    motor.values[1] = 3
                else:
                    motor.position(24096 + 129)
                with self.assertRaises(TransportError):
                    transport.command(.6)
                self.assertEqual(motor.destinations, [])
                self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])
                self.assertTrue(transport.status()["fault"])
                self.assertFalse(transport.status()["stop_confirmed"])

    def test_three_fresh_tracking_failures_stop_without_fourth_target(self):
        def ignore_absolute(motor, operation, tx, previous):
            if operation == "absolute":
                motor.position(20000)

        transport, motor, _, _ = self.running(FakeMotor(on_command=ignore_absolute))
        transport.command(1)
        transport.command(1)
        transport.command(1)
        with self.assertRaises(TransportError):
            transport.command(1)
        self.assertEqual(len(motor.destinations), 3)
        self.assertIn("Tracking error", transport.status()["fault"])
        self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])

    def test_fixed_duration_from_enable_blocks_late_commands_and_snapshots(self):
        for action in ("command", "snapshot"):
            transport, motor, clock, _ = self.running()
            clock.wait(MAX_RUN_SECONDS)
            with self.assertRaises(TransportError):
                transport.command(.6) if action == "command" else transport.snapshot()
            self.assertEqual(motor.destinations, [])
            self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])
            self.assertTrue(transport.status()["stop_confirmed"])

    def test_clear_failure_still_attempts_inhibit_once_and_never_confirms_uncertain_stop(self):
        transport, motor, _, _ = self.running()

        def lost_clear(motor, operation, tx, previous):
            return b"" if operation == "clear" else None

        motor.on_command = lost_clear
        with self.assertRaises(TransportError):
            transport.stop()
        self.assertEqual(motor.commands, ["clear", "enable", "clear", "inhibit"])
        self.assertFalse(transport.status()["stop_confirmed"])
        self.assertTrue(transport.status()["fault"])
        self.assertIn("physical power isolation", transport.status()["notice"])
        transport.close()
        self.assertEqual(len(motor.commands), 4)
        self.assertFalse(transport.status()["stop_confirmed"])

    def test_inhibit_failure_or_bad_readback_cannot_confirm_stop(self):
        for failure in ("ack", "pending", "pwm", "coasting"):
            with self.subTest(failure=failure):
                transport, motor, _, _ = self.running()

                def change(motor, operation, tx, previous, failure=failure):
                    if operation == "inhibit":
                        if failure == "ack":
                            return b""
                        if failure == "pending":
                            motor.remaining(2)
                        if failure == "pwm":
                            motor.values[19] = 1
                        if failure == "coasting":
                            motor.on_read = lambda m: m.position(read_motor.signed_position(m.values) + 3)

                motor.on_command = change
                with self.assertRaises(TransportError):
                    transport.stop()
                self.assertFalse(transport.status()["stop_confirmed"])
                self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])

    def test_close_after_enable_performs_cleanup_and_read_only_close_does_not(self):
        transport, motor, _, _ = self.running()
        transport.close()
        self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])
        self.assertFalse(transport.status()["connected"])
        self.assertTrue(transport.status()["stop_confirmed"])
        transport.close()
        self.assertEqual(len(motor.commands), 4)

    def test_stop_rearm_keeps_original_window_and_uses_current_hold_position(self):
        transport, motor, _, _ = self.running()
        transport.command(.875)
        transport.stop()
        status = transport.arm()
        self.assertEqual(status["origin_raw"], 20000)
        self.assertEqual(status["raw_bounds"], [15904, 24096])
        self.assertAlmostEqual(status["position_normalized"], .875)
        transport.start()
        transport.command(1)
        self.assertEqual(motor.destinations[-1], 24096)
        transport.close()

    def test_later_idle_read_invalidates_stop_if_clean_stationary_state_changes(self):
        for change in ("enabled", "unknown_output", "pending", "pwm", "drift", "config"):
            with self.subTest(change=change):
                transport, motor, _, _ = self.running()
                self.assertTrue(transport.stop()["stop_confirmed"])
                commands = list(motor.commands)
                if change == "enabled":
                    motor.values[1] = 1
                elif change == "unknown_output":
                    motor.values[1] = 4
                elif change == "pending":
                    motor.remaining(1)
                elif change == "pwm":
                    motor.values[19] = 1
                elif change == "drift":
                    motor.position(read_motor.signed_position(motor.values) + 5)
                else:
                    motor.values[7] += 1
                with self.assertRaises(TransportError):
                    transport.snapshot()
                status = transport.status()
                self.assertFalse(status["stop_confirmed"])
                self.assertFalse(status["owned"])
                self.assertTrue(status["fault"])
                transport.close()
                self.assertEqual(motor.commands, commands)

    def test_later_idle_read_failure_invalidates_stop_without_new_motor_writes(self):
        transport, motor, _, _ = self.running()
        transport.stop()
        commands = list(motor.commands)
        with patch("virtual_synth.transport.bench_jog.snapshot", side_effect=OSError("Lost readback")):
            with self.assertRaises(TransportError):
                transport.snapshot()
        self.assertFalse(transport.status()["stop_confirmed"])
        self.assertTrue(transport.status()["fault"])
        self.assertEqual(motor.commands, commands)

    def test_matching_idle_reads_preserve_stop_confirmation(self):
        transport, motor, _, _ = self.running()
        transport.stop()
        motor.position(read_motor.signed_position(motor.values) + 4)
        self.assertTrue(transport.snapshot()["stop_confirmed"])
        motor.position(read_motor.signed_position(motor.values) + 1)
        with self.assertRaises(TransportError):
            transport.snapshot()
        self.assertFalse(transport.status()["stop_confirmed"])

    def test_rearm_rejects_config_change_and_window_escape_instead_of_recentering(self):
        for failure in ("config", "window"):
            transport, motor, _, _ = self.running()
            transport.stop()
            if failure == "config":
                motor.values[7] += 1
            else:
                motor.position(24097)
            with self.assertRaises(TransportError):
                transport.arm()
            self.assertEqual(transport.status()["origin_raw"], 20000)
            self.assertEqual(transport.status()["raw_bounds"], [15904, 24096])
            self.assertEqual(motor.commands, ["clear", "enable", "clear", "inhibit"])

    def test_no_io_status_does_not_hide_latched_fault(self):
        transport, motor, _, _ = self.running()
        with self.assertRaises(TransportError):
            transport.command(math.nan)
        writes = len(motor.writes)
        status = transport.status()
        self.assertEqual(len(motor.writes), writes)
        self.assertTrue(status["fault"])
        self.assertFalse(status["running"])

    def test_connect_failure_closes_without_cleanup_writes(self):
        transport, motor, _, _ = self.make()
        with patch("virtual_synth.transport.bench_jog.snapshot", side_effect=OSError("offline failure")):
            with self.assertRaises(TransportError):
                transport.connect()
        self.assertTrue(motor.closed)
        self.assertEqual(motor.commands, [])
        self.assertFalse(transport.status()["connected"])
        self.assertFalse(transport.status()["stop_confirmed"])

    def test_active_read_failure_latches_and_attempts_independent_cleanup(self):
        transport, motor, _, _ = self.running()
        snapshot = bench_jog.snapshot
        calls = []

        def fail_once(*args, **kwargs):
            calls.append(None)
            if len(calls) == 1:
                raise OSError("Disconnected during active read")
            return snapshot(*args, **kwargs)

        with patch("virtual_synth.transport.bench_jog.snapshot", side_effect=fail_once):
            with self.assertRaises(TransportError):
                transport.snapshot()
        self.assertEqual(motor.commands, ["clear", "enable", "clear", "inhibit"])
        self.assertTrue(transport.status()["fault"])
        self.assertTrue(transport.status()["stop_confirmed"])
        self.assertFalse(transport.status()["owned"])

    def test_partial_absolute_transmission_is_not_retried(self):
        transport, motor, _, _ = self.running()
        original_write = motor.write

        def partial(tx):
            length = original_write(tx)
            if tx[1] == 16 and tx[3] == 22:
                # Unknown whether the drive got enough bytes: response loss and
                # a short OS write must never cause another absolute request.
                motor.incoming.clear()
                return length - 1
            return length

        motor.write = partial
        with self.assertRaises(TransportError):
            transport.command(.6)
        self.assertEqual(len(motor.destinations), 1)
        self.assertEqual(motor.commands[-2:], ["clear", "inhibit"])
        self.assertTrue(transport.status()["fault"])


if __name__ == "__main__":
    unittest.main()
