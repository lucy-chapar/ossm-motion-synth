# SPDX-License-Identifier: MPL-2.0
"""Offline physical-rail calibration cases; only in-memory serial frames exist."""

import unittest

from tests.serial_fakes import Clock
from tests.test_virtual_synth_transport import NativeHomeMotor
from virtual_synth.protocol import bench_jog
from virtual_synth.transport import MotorTransport, TransportError


class RailTransportTests(unittest.TestCase):
    def begin(self, reverse=False, motor=None):
        motor = motor or NativeHomeMotor()
        clock = Clock()
        transport = MotorTransport("/dev/offline-rail-test", allow_motion=True,
                                   connection_factory=lambda **kwargs: motor,
                                   clock=clock.now, wait=clock.wait)
        transport.connect()
        transport.begin_home(reverse=reverse)
        self.addCleanup(transport.close)
        return transport, motor, clock

    def advance(self, transport, clock, until="complete", limit=4000):
        for _ in range(limit):
            if transport.status()["home_phase"] == until:
                return transport.status()
            clock.wait(.1)
            transport.poll_home()
        self.fail("Calibration did not reach " + until)

    def expect_fault(self, transport, motor, clock):
        with self.assertRaises(TransportError):
            self.advance(transport, clock)
        status = transport.status()
        self.assertFalse(status["homed"])
        self.assertFalse(status["homing"])
        self.assertTrue(status["fault"])
        self.assertIn((0, 0), motor.settings)
        self.assertEqual(motor.values[1], 0)
        self.assertEqual(motor.settings.count((25, 1)), 1)
        return status

    def test_both_directions_measure_two_repeatable_ends_then_center(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                transport, motor, clock = self.begin(reverse=reverse)
                original_output = motor.values[24]
                status = self.advance(transport, clock)
                endpoints = [-3277, 160563] if reverse else [-160563, 3277]
                bounds = [endpoints[0] + 1638, endpoints[1] - 1638]
                center = (bounds[0] + bounds[1]) // 2
                sign = -1 if reverse else 1
                first, second = sign * 3277, sign * -160563
                self.assertEqual(status["measured_endpoints_raw"], endpoints)
                self.assertEqual(status["measured_travel_raw"], 163840)
                self.assertEqual(status["raw_bounds"], bounds)
                self.assertEqual(status["origin_raw"], center)
                self.assertEqual(status["target_raw"], center)
                self.assertEqual(status["position_raw"], center)
                self.assertEqual(status["position_normalized"], .5)
                self.assertTrue(status["homed"])
                self.assertTrue(status["stop_confirmed"])
                self.assertFalse(status["armed"])
                self.assertFalse(status["owned"])
                self.assertEqual(motor.destinations,
                                 [sign * 8192, first - sign * 1638,
                                  first + sign * 819, first - sign * (409600 + 819),
                                  second + sign * 1638, second - sign * 819, center])
                self.assertNotIn(0, motor.destinations)
                self.assertEqual(motor.settings.count((25, 1)), 1)
                self.assertNotIn((20, 1), motor.settings)
                self.assertEqual(motor.values[0:4], [1, 0, 7, 15])
                self.assertEqual(motor.values[24], original_output)
                self.assertEqual(motor.values[25], 0)
                # Every contact/release/center command uses the low profile.
                for before in motor.absolute_states:
                    self.assertEqual(before[0:4], [1, 1, 7, 15])
                    self.assertEqual(before[10], 0)
                    self.assertEqual(before[24], 89)
                    self.assertEqual(before[25], 0)

    def test_contact_needs_half_second_of_fresh_stable_loaded_reads(self):
        transport, motor, clock = self.begin()
        self.advance(transport, clock, "first_contact")
        self.assertGreaterEqual(abs(bench_jog.pending(motor.values)), 512)
        for _ in range(5):
            clock.wait(.1)
            transport.poll_home()
            self.assertEqual(transport.status()["home_phase"], "first_contact")
        self.advance(transport, clock, "commanding_first_retreat")
        self.assertTrue(transport.status()["homing"])
        self.assertEqual(motor.destinations, [8192])

    def test_stationary_contact_with_low_signed_load_never_becomes_an_endpoint(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                motor = NativeHomeMotor()
                motor.contact_pwm = 1965
                transport, motor, clock = self.begin(reverse=reverse, motor=motor)
                self.advance(transport, clock, "first_contact")
                # Reverse encodes a negative 16-bit PWM value. It must not be
                # mistaken for a large positive unsigned load.
                self.assertEqual(motor.values[19], (-1965 if reverse else 1965) & 65535)
                self.expect_fault(transport, motor, clock)
                self.assertEqual(len(motor.destinations), 1)

    def test_high_load_with_small_pending_is_not_a_contact(self):
        motor = NativeHomeMotor()

        def small_pending(motor):
            if motor.destinations and motor.values[1] == 1 and motor.values[19]:
                motor.remaining(511)

        motor.on_read = small_pending
        transport, motor, clock = self.begin(motor=motor)
        self.expect_fault(transport, motor, clock)
        self.assertEqual(len(motor.destinations), 1)

    def test_encoder_must_remain_still_for_contact_confirmation(self):
        transport, motor, clock = self.begin()
        self.advance(transport, clock, "first_contact")
        count = [0]

        def creep(motor):
            if motor.values[1] == 1:
                count[0] += 1
                position = 3277 + (8 if count[0] % 2 else 0)
                motor.position(position)
                motor.remaining(8192 - position)

        motor.on_read = creep
        self.expect_fault(transport, motor, clock)
        self.assertEqual(len(motor.destinations), 1)

    def test_retreat_requires_real_movement_and_load_to_fall(self):
        for failure in ("no_movement", "load_remains"):
            with self.subTest(failure=failure):
                transport, motor, clock = self.begin()
                self.advance(transport, clock, "commanding_first_retreat")

                def bad_release(motor, operation, tx, previous, failure=failure):
                    if operation == "absolute":
                        if failure == "no_movement":
                            motor.position(3277)
                            motor.remaining(motor.target - 3277)
                        motor.values[19] = 2500

                motor.on_command = bad_release
                self.expect_fault(transport, motor, clock)
                self.assertEqual(len(motor.destinations), 2)

    def test_contact_that_moves_on_retouch_is_rejected(self):
        for side, phase in (("first", "commanding_first_retouch"),
                            ("second", "commanding_second_retouch")):
            with self.subTest(side=side):
                transport, motor, clock = self.begin()
                self.advance(transport, clock, phase)
                motor.rail_contacts = (-160563, 3406) if side == "first" else (-160692, 3277)
                self.expect_fault(transport, motor, clock)
                self.assertEqual(len(motor.destinations), 3 if side == "first" else 6)

    def test_alarm_during_contact_invalidates_calibration_and_attempts_inhibit(self):
        transport, motor, clock = self.begin()
        self.advance(transport, clock, "first_contact")
        motor.values[14] = 1
        self.expect_fault(transport, motor, clock)
        self.assertEqual(len(motor.destinations), 1)
        self.assertIn("inhibit", motor.commands)

    def test_contact_timeout_never_reissues_an_absolute_target(self):
        transport, motor, clock = self.begin()
        self.advance(transport, clock, "second_contact")
        previous = list(motor.destinations)
        clock.wait(400)
        self.expect_fault(transport, motor, clock)
        self.assertEqual(motor.destinations, previous)

    def test_long_center_move_uses_distance_deadline_then_arrives_or_times_out(self):
        for arrives in (True, False):
            with self.subTest(arrives=arrives):
                transport, motor, clock = self.begin()
                self.advance(transport, clock, "commanding_centering")
                second_contact = -160563

                def slow_center(motor, operation, tx, previous):
                    if operation == "absolute":
                        motor.position(second_contact)
                        motor.remaining(motor.target - second_contact)
                        motor.values[19] = 500

                motor.on_command = slow_center
                self.advance(transport, clock, "centering")
                before_targets = list(motor.destinations)
                clock.wait(9)
                status = transport.poll_home()
                self.assertTrue(status["homing"])
                self.assertEqual(status["home_phase"], "centering")
                self.assertFalse(status["homed"])
                if arrives:
                    motor.position(motor.target)
                    motor.remaining(0)
                    motor.values[19] = 0
                    self.assertTrue(self.advance(transport, clock)["homed"])
                else:
                    seconds = abs(motor.target - second_contact) / (32768 * 7 / 60) + 7 / 15 + 5
                    clock.wait(seconds - 9 + .1)
                    self.expect_fault(transport, motor, clock)
                self.assertEqual(motor.destinations, before_targets)

    def test_travel_below_twenty_mm_never_publishes_a_usable_window(self):
        motor = NativeHomeMotor()
        motor.rail_contacts = (-4915, 3277)  # 10 mm, mechanically plausible but rejected.
        transport, motor, clock = self.begin(motor=motor)
        status = self.expect_fault(transport, motor, clock)
        self.assertIsNone(status["raw_bounds"])
        self.assertLessEqual(len(motor.destinations), 6)

    def test_exact_five_hundred_mm_span_can_be_measured_with_contact_overtravel(self):
        motor = NativeHomeMotor()
        motor.rail_contacts = (3277 - 409600, 3277)
        transport, motor, clock = self.begin(motor=motor)
        status = self.advance(transport, clock)
        self.assertEqual(status["measured_travel_raw"], 409600)
        self.assertEqual(status["measured_endpoints_raw"], [3277 - 409600, 3277])
        self.assertTrue(status["homed"])

    def test_span_over_five_hundred_mm_cannot_publish_calibration(self):
        motor = NativeHomeMotor()
        motor.rail_contacts = (3277 - round(501 * 819.2), 3277)
        transport, motor, clock = self.begin(motor=motor)
        status = self.expect_fault(transport, motor, clock)
        self.assertIsNone(status["raw_bounds"])
        self.assertIsNone(status["measured_endpoints_raw"])
        self.assertIsNone(status["measured_travel_raw"])

    def test_endpoints_are_published_only_after_centered_inhibited_completion(self):
        transport, motor, clock = self.begin()
        self.advance(transport, clock, "centering")
        for phase in ("centering", "verify_stop", "verify_complete"):
            status = self.advance(transport, clock, phase)
            self.assertIsNone(status["raw_bounds"])
            self.assertIsNone(status["measured_endpoints_raw"])
            self.assertIsNone(status["measured_travel_raw"])
            self.assertFalse(status["homed"])
        self.assertTrue(self.advance(transport, clock)["homed"])

    def test_zero_retreat_and_zero_runtime_endpoint_never_reset_coordinate(self):
        motor = NativeHomeMotor()
        motor.rail_contacts = (1638 - 163840, 1638)
        transport, motor, clock = self.begin(motor=motor)
        status = self.advance(transport, clock)
        self.assertIn(motor.destinations[1], (-1, 1))
        self.assertEqual(status["raw_bounds"][1], 0)
        transport.arm()
        transport.start()
        transport.command(1)
        self.assertEqual(motor.destinations[-1], -1)
        self.assertNotIn(0, motor.destinations)
        self.assertEqual(motor.settings.count((25, 1)), 1)

    def test_stop_during_release_cancels_the_retouch_and_center_targets(self):
        transport, motor, clock = self.begin()
        self.advance(transport, clock, "first_retreat")
        previous = list(motor.destinations)
        status = transport.stop()
        self.assertFalse(status["homed"])
        self.assertFalse(status["homing"])
        self.assertTrue(status["stop_confirmed"])
        clock.wait(.5)
        transport.poll_home()
        self.assertEqual(motor.destinations, previous)
        self.assertEqual(motor.settings.count((25, 1)), 1)

    def test_runtime_uses_measured_bounds_and_snaps_absolute_zero_by_one_count(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                transport, motor, clock = self.begin(reverse=reverse)
                status = self.advance(transport, clock)
                low, high = status["raw_bounds"]
                transport.arm()
                transport.start()
                transport.command(0)
                self.assertEqual(motor.destinations[-1], low)
                transport.command(1)
                self.assertEqual(motor.destinations[-1], high)
                transport.command(-low / (high - low))
                self.assertIn(motor.destinations[-1], (-1, 1))
                self.assertNotIn(0, motor.destinations)
                self.assertEqual(motor.settings.count((25, 1)), 1)
                self.assertEqual(transport.status()["raw_bounds"], [low, high])


if __name__ == "__main__":
    unittest.main()
