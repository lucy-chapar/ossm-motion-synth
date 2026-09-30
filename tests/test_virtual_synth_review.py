# SPDX-License-Identifier: MPL-2.0
"""Independent application-boundary regressions using fake transport only."""

import threading
import unittest
from unittest.mock import patch

from virtual_synth.controller import Controller
from virtual_synth.transport import MotorTransport
from tests.serial_fakes import Clock as SerialClock
from tests.test_virtual_synth_transport import NativeHomeMotor


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class Transport:
    def __init__(self, port, allow_motion=False):
        self.data = {
            "connected": False, "armed": False, "running": False, "owned": False,
            "stop_confirmed": False, "fault": None, "position_normalized": .5,
            "position_raw": 100000, "raw_bounds": [95904, 104096],
            "output_enabled": False, "mode": 1, "pending_raw": 0, "pwm_raw": 0,
            "homed": True,  # These regressions begin with an established reference.
        }
        self.targets = []
        self.stop_count = 0
        self.fail_stop = False
        self.entered = self.release = None

    def status(self):
        return dict(self.data)

    def connect(self):
        self.data["connected"] = True
        return self.status()

    def snapshot(self):
        return self.status()

    def arm(self):
        self.data["armed"] = True
        return self.status()

    def start(self):
        self.data.update(running=True, owned=True, output_enabled=True)
        return self.status()

    def command(self, target):
        if self.entered is not None:
            self.entered.set()
            if not self.release.wait(2):
                raise RuntimeError("Fake exchange was not released")
        self.targets.append(target)
        return self.status()

    def stop(self):
        self.stop_count += 1
        self.data.update(armed=False, running=False)
        if self.fail_stop:
            self.data["fault"] = "Lost acknowledgement and readback"
            raise RuntimeError(self.data["fault"])
        if self.data["owned"]:
            self.data.update(owned=False, output_enabled=False, stop_confirmed=True)
        return self.status()

    def close(self):
        self.data["connected"] = False


class IndependentIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.controller = Controller(allow_motion=True, clock=self.clock,
                                     transport_factory=Transport)

    def action(self, action, **values):
        return self.controller.action({"action": action, **values}, "owner")

    def test_native_serial_home_through_controller_then_explicit_run_and_stop(self):
        for direction in ("normal", "reverse"):
            with self.subTest(direction=direction):
                clock, motor = SerialClock(), NativeHomeMotor()
                def factory(port, allow_motion=False):
                    return MotorTransport(port, allow_motion=allow_motion,
                        clock=clock.now, wait=clock.wait,
                        connection_factory=lambda **kwargs: motor)
                controller = Controller(allow_motion=True, clock=clock.now,
                                        transport_factory=factory)
                def action(name, **values):
                    return controller.action({"action":name, **values}, "owner")
                with patch("virtual_synth.controller.list_ports", return_value=[{"device":"fake"}]):
                    action("connect", port="fake")
                action("home_start", direction=direction,
                       control_revision=controller.state()["control_revision"])
                for _ in range(200):
                    action("heartbeat")
                    clock.wait(.12)
                    controller.tick()
                    if not controller.state()["homing"]["active"]:
                        break
                state = controller.state()
                self.assertIsNone(state["fault"])
                self.assertTrue(state["homing"]["valid"])
                self.assertFalse(state["running"] or state["armed"])
                contacts = [-160563, 3277] if direction == "normal" else [-3277, 160563]
                bounds = [contacts[0] + 1638, contacts[1] - 1638]
                park = round(sum(contacts) / 2)
                self.assertEqual(state["homing"]["measured_endpoints_raw"], contacts)
                self.assertEqual(state["homing"]["measured_travel_raw"], 163840)
                self.assertEqual(state["hardware"]["raw_bounds"], bounds)
                self.assertEqual(state["hardware"]["position_raw"], park)
                self.assertFalse(state["hardware"]["output_enabled"])
                self.assertEqual(motor.destinations[-1], park)
                homing_target_count = len(motor.destinations)
                self.assertGreater(homing_target_count, 1)
                action("arm"); action("run")
                self.assertAlmostEqual(controller.engine.trajectory.vmax * (bounds[1] - bounds[0]), 3822)
                self.assertAlmostEqual(controller.engine.trajectory.amax * (bounds[1] - bounds[0]), 8192)
                for _ in range(30):
                    action("heartbeat"); clock.wait(.02); controller.tick()
                self.assertTrue(controller.running)
                runtime_targets = motor.destinations[homing_target_count:]
                self.assertTrue(runtime_targets)
                self.assertTrue(all(bounds[0] <= p <= bounds[1] and p != 0
                                    for p in runtime_targets))
                action("stop")
                self.assertTrue(controller.state()["hardware"]["stop_confirmed"])
                self.assertFalse(controller.running)
                controller.close()

    def connect(self):
        with patch("virtual_synth.controller.list_ports", return_value=[{"device": "fake"}]):
            self.action("connect", port="fake")
        return self.controller.transport

    def start_run(self):
        transport = self.connect()
        self.action("arm")
        self.action("run")
        return transport

    def uncertain_disconnect(self):
        transport = self.start_run()
        transport.fail_stop = True
        self.action("disconnect")
        self.assertTrue(self.controller.unconfirmed_stop)
        self.assertEqual(self.controller.mode, "simulation")
        self.assertIsNone(self.controller.transport)

    def test_readonly_observation_of_enabled_drive_never_claims_or_stops_it(self):
        transport = self.connect()
        transport.data["output_enabled"] = True
        self.clock.value += .6
        self.controller.tick()
        self.action("stop")
        self.action("disconnect")
        self.assertEqual(transport.stop_count, 0)
        self.assertEqual(transport.targets, [])
        self.assertFalse(self.controller.unconfirmed_stop)

    def test_uncertain_stop_survives_disconnect_and_blocks_simulated_rearm(self):
        self.uncertain_disconnect()
        for action in ("reset", "arm", "run"):
            with self.subTest(action=action), self.assertRaises(ValueError):
                self.action(action)
        self.assertTrue(self.controller.unconfirmed_stop)

    def test_only_fresh_disabled_clean_reconnect_resolves_stop_uncertainty(self):
        for changes in ({"output_enabled": True}, {"output_enabled": None},
                        {"pending_raw": 1}, {"pwm_raw": 1}, {"mode": 2}):
            with self.subTest(changes=changes):
                self.setUp()
                self.uncertain_disconnect()
                replacement = Transport("fake")
                replacement.data.update(changes)
                self.controller.transport_factory = lambda *args, **kwargs: replacement
                self.connect()
                self.assertTrue(self.controller.unconfirmed_stop)
                self.assertIsNotNone(self.controller.fault)
                with self.assertRaises(ValueError):
                    self.action("arm")
        self.setUp()
        self.uncertain_disconnect()
        self.connect()
        self.assertFalse(self.controller.unconfirmed_stop)
        self.assertIsNone(self.controller.fault)

    def test_state_polling_never_renews_the_control_lease(self):
        transport = self.start_run()
        for _ in range(90):
            self.controller.state()
            self.clock.value += .02
            self.controller.tick()
        self.assertFalse(self.controller.running)
        self.assertIn("heartbeat", self.controller.fault)
        self.assertEqual(transport.stop_count, 1)

    def test_no_scheduling_catchup_after_late_tick_or_deadline(self):
        for elapsed in (.26, 20.0):
            with self.subTest(elapsed=elapsed):
                self.setUp()
                transport = self.start_run()
                self.clock.value += elapsed
                self.controller.tick()
                self.assertEqual(transport.targets, [])
                self.assertFalse(self.controller.running)
                self.assertEqual(transport.stop_count, 1)

    def test_stop_waits_for_existing_exchange_and_never_overlaps_transport(self):
        transport = self.start_run()
        transport.entered, transport.release = threading.Event(), threading.Event()
        self.clock.value += .11
        tick = threading.Thread(target=self.controller.tick)
        errors = []
        stopped = threading.Event()

        def request_stop():
            try:
                self.action("stop")
            except Exception as error:
                errors.append(error)
            finally:
                stopped.set()

        tick.start()
        self.assertTrue(transport.entered.wait(1))
        stop = threading.Thread(target=request_stop)
        stop.start()
        try:
            self.assertFalse(stopped.wait(.05))
            self.assertEqual(transport.stop_count, 0)
        finally:
            transport.release.set()
            tick.join(timeout=2)
            stop.join(timeout=2)
        self.assertFalse(tick.is_alive())
        self.assertFalse(stop.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(transport.stop_count, 1)
        self.assertFalse(self.controller.running)
        sent_before_stop = len(transport.targets)
        self.clock.value += .2
        self.controller.tick()
        self.assertEqual(len(transport.targets), sent_before_stop)


if __name__ == "__main__":
    unittest.main()
