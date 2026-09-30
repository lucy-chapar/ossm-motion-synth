# SPDX-License-Identifier: MPL-2.0
import unittest
from unittest.mock import patch

from virtual_synth.controller import Controller
from virtual_synth.engine import MAX_ACCELERATION, MAX_VELOCITY


class Clock:
    def __init__(self): self.t = 100.0
    def __call__(self): return self.t
    def advance(self, amount): self.t += amount


class FakeTransport:
    def __init__(self, port="fake", allow_motion=False):
        self.s = dict(connected=False, armed=False, running=False, owned=False,
                      stop_confirmed=False, fault=None, position_normalized=.5,
                      position_raw=100000, pending_raw=0, pwm_raw=0, mode=1,
                      raw_bounds=[95904, 104096],
                      output_enabled=False, homed=False, homing=False, home_phase="idle")
        self.commands = []
        self.stop_calls = 0
        self.fail_stop = False
        self.home_polls = 0
        self.fail_home = False
    def status(self): return dict(self.s)
    def connect(self): self.s["connected"] = True; return self.status()
    def snapshot(self): return self.status()
    def begin_home(self, reverse=False):
        self.home_polls = 0
        self.s.update(homing=True, homed=False, owned=True, home_phase="seek",
                      home_direction="reverse" if reverse else "normal")
        return self.status()
    def poll_home(self):
        self.home_polls += 1
        if self.fail_home:
            self.s["fault"] = "Home feedback lost"
            raise RuntimeError(self.s["fault"])
        if self.home_polls == 3:
            self.s.update(homing=False, homed=True, owned=False, stop_confirmed=True,
                          home_phase="ready", home_progress=1, home_origin_raw=0,
                          raw_bounds=[4096, 12288], position_raw=8192,
                          measured_endpoints_raw=[2458, 13926], measured_travel_raw=11468)
        return self.status()
    def arm(self): self.s["armed"] = True; return self.status()
    def start(self):
        self.s.update(running=True, owned=True, output_enabled=True)
        return self.status()
    def command(self, value): self.commands.append(value); return self.status()
    def stop(self):
        self.stop_calls += 1
        owned = self.s["owned"]
        if self.s["homing"]:
            self.s.update(homing=False, homed=False, home_phase="cancelled")
        self.s.update(armed=False, running=False)
        if self.fail_stop:
            self.s["fault"] = "Bus lost"
            raise RuntimeError("Bus lost")
        if owned:
            self.s.update(owned=False, output_enabled=False, stop_confirmed=True)
        return self.status()
    def close(self): self.s["connected"] = False


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.c = Controller(clock=self.clock, transport_factory=FakeTransport)
    def action(self, action, client="one", **values):
        if action == "home_start":
            values.setdefault("control_revision", self.c.state()["control_revision"])
        return self.c.action(dict(action=action, **values), client)
    def arm_run(self): self.action("arm"); self.action("run")
    def tick(self, dt=.02): self.clock.advance(dt); self.c.tick()
    def hardware(self, homed=True):
        self.c.allow_motion = True
        with patch("virtual_synth.controller.list_ports", return_value=[{"device":"fake"}]):
            self.action("connect", port="fake")
        self.c.transport.s["homed"] = homed
        return self.c.transport

    def test_default_has_no_transport_and_does_not_move_command(self):
        self.assertIsNone(self.c.transport)
        for _ in range(20): self.tick()
        self.assertEqual(self.c.state()["signal"]["command"], .5)
        self.assertFalse(self.c.running)
    def test_requires_arm_and_owner_for_run(self):
        with self.assertRaises(ValueError): self.action("run")
        self.action("arm")
        with self.assertRaises(ValueError): self.action("run", client="two")
        self.action("run")
        self.tick()
        self.assertTrue(self.c.running)
    def test_heartbeat_from_other_tab_cannot_keep_run_alive(self):
        self.arm_run()
        with self.assertRaises(ValueError): self.action("heartbeat", client="two")
        for _ in range(80): self.tick()
        self.assertFalse(self.c.running)
        self.assertIn("heartbeat", self.c.fault)
    def test_stale_tick_stops_without_catch_up_targets(self):
        t = self.hardware(); self.arm_run()
        self.tick(.3)
        self.assertEqual(t.commands, [])
        self.assertFalse(self.c.running)
        self.assertIn("deadline", self.c.fault)
    def test_any_local_session_can_stop(self):
        self.arm_run(); self.action("stop", client="two")
        self.assertFalse(self.c.armed)
        with self.assertRaises(ValueError): self.action("run")
    def test_window_changes_rejected_while_armed(self):
        self.action("arm")
        with self.assertRaises(ValueError): self.action("configure", params={"lower":.2})
        self.assertEqual(self.c.engine.params["lower"], .1)
    def test_gate_does_not_arm_and_release_is_separate_from_stop(self):
        with self.assertRaises(ValueError): self.action("gate", value=True)
        self.arm_run(); self.action("gate", value=True); self.tick(.1)
        self.assertGreater(self.c.signal["envelope"], 0)
        self.action("gate", value=False); self.tick(.02)
        self.assertTrue(self.c.running)
        self.action("stop")
        self.assertFalse(self.c.running)
    def test_readonly_disconnect_never_requests_motor_stop(self):
        t = self.hardware(); self.action("disconnect")
        self.assertEqual(t.stop_calls, 0)
        self.assertFalse(self.c.unconfirmed_stop)
    def test_cancel_readonly_arm_is_not_unconfirmed_motor_stop(self):
        t = self.hardware(); self.action("arm"); self.action("stop")
        self.assertEqual(t.stop_calls, 1)
        self.assertFalse(self.c.unconfirmed_stop)
        self.assertIsNone(self.c.fault)
    def test_transport_is_fixed_rate_and_run_is_bounded(self):
        t = self.hardware(); self.arm_run()
        for _ in range(1010):
            self.action("heartbeat"); self.tick()
        self.assertFalse(self.c.running)
        self.assertLessEqual(len(t.commands), 200)
        self.assertGreater(len(t.commands), 150)
        self.assertTrue(t.s["stop_confirmed"])
    def test_uncertain_stop_cannot_be_reset_as_safe(self):
        t = self.hardware(); self.arm_run(); t.fail_stop = True
        self.action("stop")
        self.assertTrue(self.c.unconfirmed_stop)
        with self.assertRaises(ValueError): self.action("reset")
        self.assertFalse(self.c.running)
    def test_launch_motion_optin_is_required_even_when_connected(self):
        self.hardware(); self.c.allow_motion = False
        with self.assertRaises(ValueError): self.action("arm")
    def test_unlisted_port_and_malformed_actions_rejected(self):
        with patch("virtual_synth.controller.list_ports", return_value=[]):
            with self.assertRaises(ValueError): self.action("connect", port="unlisted")
        for payload in ({"action":"run", "surprise":1}, [], {"action":"configure", "params":{"rate_hz":float("nan")}}):
            with self.assertRaises(ValueError): self.c.action(payload, "one")

    def test_hardware_arm_scales_measured_span_and_run_preserves_limits(self):
        for low, high in ((100000, 104097), (-4096, 4096), (-4000, 159841)):
            with self.subTest(bounds=(low, high)):
                transport = self.hardware()
                span = high - low
                position_raw = round((low + high) / 2)
                normalized = (position_raw - low) / span
                transport.s.update(raw_bounds=[low, high], position_raw=position_raw,
                                   position_normalized=normalized)
                self.action("arm")
                self.assertEqual(self.c.signal["command"], normalized)
                self.assertEqual(self.c.engine.trajectory.vmax, 3822 / span)
                self.assertEqual(self.c.engine.trajectory.amax, 8192 / span)
                self.action("run")
                self.assertEqual(self.c.engine.trajectory.vmax, 3822 / span)
                self.assertEqual(self.c.engine.trajectory.amax, 8192 / span)
                self.assertEqual(self.c.signal["command"], normalized)
                self.tick(.1)
                held = self.c.signal["command"]
                self.assertNotEqual(held, normalized)
                self.action("disconnect")
                self.assertEqual(self.c.signal["command"], held)
                self.assertEqual(self.c.engine.trajectory.vmax, MAX_VELOCITY)
                self.assertEqual(self.c.engine.trajectory.amax, MAX_ACCELERATION)
                self.assertEqual(self.c.engine.trajectory.velocity, 0)

    def test_invalid_hardware_bounds_cannot_arm_or_change_planner_limits(self):
        malformed = (None, [], [1], [1, 2, 3], "12", [2, 2], [3, 2],
                     [True, 2], [0, 10.0], [float("nan"), 10],
                     [-(2**31)-1, 10], [0, 2**31])
        for bounds in malformed:
            with self.subTest(bounds=bounds):
                transport = self.hardware()
                transport.s["raw_bounds"] = bounds
                self.c.engine.reset(.61)
                with self.assertRaisesRegex(ValueError, "raw travel bounds"):
                    self.action("arm")
                self.assertFalse(self.c.armed or self.c.running or transport.s["armed"])
                self.assertEqual(self.c.signal["command"], .61)
                self.assertEqual(self.c.engine.trajectory.vmax, MAX_VELOCITY)
                self.assertEqual(self.c.engine.trajectory.amax, MAX_ACCELERATION)
                self.assertEqual(transport.commands, [])
                self.assertFalse(transport.s["output_enabled"])
                self.action("disconnect")

    def test_hardware_arm_rejects_invalid_actual_position_atomically(self):
        for position in (None, True, float("nan"), float("inf"), -.1, .95):
            with self.subTest(position=position):
                transport = self.hardware()
                transport.s.update(raw_bounds=[-10000, 90000], position_normalized=position)
                self.c.engine.reset(.57)
                with self.assertRaises(ValueError):
                    self.action("arm")
                self.assertFalse(self.c.armed or self.c.running)
                self.assertEqual(self.c.signal["command"], .57)
                self.assertEqual(self.c.engine.trajectory.vmax, MAX_VELOCITY)
                self.assertEqual(transport.commands, [])
                self.action("disconnect")

    def test_homing_reports_measured_span_and_usable_endpoints(self):
        transport = self.hardware()
        transport.s.update(raw_bounds=[-3000, 97000],
                           measured_endpoints_raw=[-4638, 98638],
                           measured_travel_raw=103276)
        homing = self.c.state()["homing"]
        self.assertEqual(homing["measured_travel_raw"], 103276)
        self.assertEqual(homing["measured_endpoints_raw"], [-4638, 98638])
        self.assertEqual(homing["endpoints"], {"usable_low_raw": -3000, "usable_high_raw": 97000})

    def test_live_homing_is_exclusive_and_cancellable_by_another_tab(self):
        transport = self.hardware(homed=False)
        before = self.c.engine.params.copy()
        self.action("home_start")
        self.assertTrue(self.c.state()["homing"]["active"])
        self.assertFalse(self.c.armed or self.c.running)
        for action, values in (("arm", {}), ("run", {}),
                               ("configure", {"params":{"rate_hz":1}}),
                               ("connect", {"port":"fake"})):
            with self.assertRaises(ValueError): self.action(action, **values)
        with self.assertRaises(ValueError): self.action("heartbeat", client="two")
        self.tick()
        self.action("home_cancel", client="two")
        self.assertFalse(self.c.state()["homing"]["active"])
        self.assertFalse(self.c.state()["homing"]["valid"])
        self.assertIsNone(self.c.owner)
        self.assertEqual(self.c.engine.params, before)
        self.assertIs(self.c.transport, transport)
        self.assertEqual(transport.commands, [])

    def test_homing_heartbeat_and_scheduling_deadlines_cancel(self):
        transport = self.hardware(homed=False)
        transport.poll_home = transport.status  # Keep the fake drive seeking.
        self.action("home_start")
        for _ in range(80): self.tick()
        self.assertFalse(self.c.state()["homing"]["active"])
        self.assertIn("heartbeat", self.c.fault)
        self.action("reset")
        self.action("home_start")
        self.tick(1.1)
        self.assertFalse(self.c.state()["homing"]["active"])
        self.assertIn("deadline", self.c.fault)

    def test_live_home_polls_without_wave_targets_and_enables_explicit_arm(self):
        transport = self.hardware(homed=False)
        with self.assertRaisesRegex(ValueError, "Home the motor"):
            self.action("arm")
        self.action("home_start", direction="reverse")
        self.assertTrue(self.c.state()["homing"]["active"])
        self.assertEqual(transport.s["home_direction"], "reverse")
        with self.assertRaises(ValueError): self.action("arm")
        for _ in range(4):
            self.action("heartbeat"); self.tick(.12)
        home = self.c.state()["homing"]
        self.assertTrue(home["valid"])
        self.assertFalse(home["active"] or home["simulated"])
        self.assertIsNone(self.c.owner)
        self.assertEqual(transport.commands, [])
        self.assertFalse(self.c.armed or self.c.running)
        self.assertEqual(home["endpoints"]["usable_low_raw"], 4096)
        self.action("arm"); self.action("run")
        self.assertTrue(self.c.running)

    def test_live_home_cancel_and_lost_heartbeat_stop_transport(self):
        transport = self.hardware(homed=False)
        self.action("home_start")
        self.action("home_cancel", client="two")
        self.assertEqual(transport.stop_calls, 1)
        self.assertFalse(self.c.state()["homing"]["valid"])
        self.action("home_start")
        self.clock.advance(1.6); self.c.tick()
        self.assertEqual(transport.stop_calls, 2)
        self.assertFalse(self.c.state()["homing"]["active"])
        self.assertIn("heartbeat", self.c.fault)

    def test_live_home_requires_motion_optin_and_rejects_synthetic_inputs(self):
        self.hardware(homed=False)
        self.c.allow_motion = False
        with self.assertRaisesRegex(ValueError, "allow-motion"):
            self.action("home_start")
        self.c.allow_motion = True
        with self.assertRaisesRegex(ValueError, "Unexpected action fields"):
            self.action("home_start", scenario="normal")
        with self.assertRaises(ValueError): self.action("home_start", direction="sideways")

    def test_stop_and_cancel_fence_an_older_home_request(self):
        transport = self.hardware(homed=False)
        for cancel in ("stop", "home_cancel"):
            with self.subTest(cancel=cancel):
                older = {"action": "home_start", "control_revision": self.c.state()["control_revision"]}
                self.action(cancel, client="two")
                with self.assertRaisesRegex(ValueError, "Controls changed"):
                    self.c.action(older, "one")
                self.assertFalse(transport.s["homing"] or transport.s["owned"])
        for revision in (None, True, -1):
            with self.assertRaises(ValueError):
                self.c.action({"action":"home_start", "control_revision":revision}, "one")
        with self.assertRaises(ValueError): self.c.action({"action":"home_start"}, "one")

    def test_older_home_request_cannot_be_replayed_after_motor_connect(self):
        older = {"action":"home_start", "direction":"normal",
                 "control_revision":self.c.state()["control_revision"]}
        transport = self.hardware(homed=False)
        with self.assertRaisesRegex(ValueError, "Controls changed"):
            self.c.action(older, "one")
        self.assertFalse(transport.s["homing"] or transport.s["owned"])

    def test_home_request_cannot_be_repeated_after_completion(self):
        self.hardware(homed=False)
        request = {"action":"home_start", "control_revision":self.c.state()["control_revision"]}
        self.c.action(request, "one")
        for _ in range(4):
            self.action("heartbeat"); self.tick(.12)
        self.assertTrue(self.c.state()["homing"]["valid"])
        with self.assertRaisesRegex(ValueError, "Controls changed"):
            self.c.action(request, "one")

    def test_live_home_bus_failure_propagates_and_preserves_uncertain_stop(self):
        transport = self.hardware(homed=False)
        self.action("home_start")
        transport.fail_home = transport.fail_stop = True
        self.tick(.12)
        self.assertFalse(self.c.state()["homing"]["valid"])
        self.assertTrue(self.c.unconfirmed_stop)
        self.assertIsNotNone(self.c.fault)
        with self.assertRaises(ValueError): self.action("arm")

    def test_home_requires_a_connected_motor_and_has_no_preview_path(self):
        before = self.c.state()
        with self.assertRaisesRegex(ValueError, "Connect a motor"):
            self.action("home_start")
        self.assertEqual(self.c.state(), before)
        home = self.c.state()["homing"]
        self.assertEqual(home["phase"], "disconnected")
        self.assertFalse(home["active"] or home["valid"] or home["simulated"])
        self.assertIsNone(home["endpoints"])
        transport = self.hardware(homed=False)
        transport.s["connected"] = False
        with self.assertRaisesRegex(ValueError, "Connect a motor"):
            self.action("home_start")
        self.assertFalse(transport.s["homing"])

    def test_homing_rejects_running_and_all_scenario_fields(self):
        self.hardware(homed=True)
        for value in ("normal", "unknown", {}, None):
            with self.assertRaisesRegex(ValueError, "Unexpected action fields"):
                self.action("home_start", scenario=value)
        self.arm_run()
        with self.assertRaises(ValueError): self.action("home_start")
        self.assertTrue(self.c.running)


if __name__ == "__main__": unittest.main()
