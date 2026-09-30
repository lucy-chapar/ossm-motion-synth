# SPDX-License-Identifier: MPL-2.0
"""Offline signal semantics and continuous trajectory invariants; no serial IO."""

import copy
import random
import unittest

from virtual_synth.engine import DEFAULT_PARAMS, Engine, Trajectory, validate_params, waveform


class ParametersTests(unittest.TestCase):
    def test_defaults_and_edits_are_detached(self):
        supplied = {"patches": [{"source": "lfo", "target": "rate", "depth": .3}]}
        params = validate_params(supplied)
        params["patches"][0]["depth"] = .9
        self.assertEqual(supplied["patches"][0]["depth"], .3)
        self.assertEqual(DEFAULT_PARAMS["patches"], [])
        self.assertEqual(validate_params({"stroke": .1}, params)["rate_hz"], .25)

    def test_numbers_types_and_nonfinite_values_are_rejected(self):
        for key in ("rate_hz", "stroke", "center", "attack_s", "release_s",
                    "lfo_rate_hz", "lower", "upper"):
            for value in (True, None, "1", float("nan"), float("inf"), -1, 100, 10**1000):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    validate_params({key: value})
        for params in (None, [], "x", {"rate": .2}, {"shape": []},
                       {"shape": "noise"}, {"env_to_stroke": 1},
                       {"lower": .6, "upper": .55}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                validate_params(params)

    def test_patch_schema_rejects_unknowns_duplicates_and_invalid_depths(self):
        cable = {"source": "lfo", "target": "stroke", "depth": .5}
        # Keep nested malformed payloads explicit rather than coercing them.
        malformed = [None, {}, [cable] * 2, [cable] * 5,
                     [{**cable, "ignored": True}], [{"source": "lfo"}],
                     [{**cable, "source": "input"}], [{**cable, "target": []}]]
        malformed.extend([[{**cable, "depth": value}] for value in
                          (True, -1.01, 1.01, "0.3", float("nan"))])
        for patches in malformed:
            with self.subTest(patches=patches), self.assertRaises(ValueError):
                validate_params({"patches": patches})


class SignalTests(unittest.TestCase):
    def test_waveform_quarter_cycles_and_wrapping(self):
        expected = {
            "sine": (0, 1, 0, -1), "triangle": (0, 1, 0, -1),
            "saw": (-1, -.5, 0, .5), "square": (1, 1, -1, -1),
        }
        for shape, values in expected.items():
            for i, value in enumerate(values):
                self.assertAlmostEqual(waveform(shape, i / 4), value)
                self.assertAlmostEqual(waveform(shape, i / 4 + 1), value)
        for shape in expected:
            for i in range(1000):
                self.assertLessEqual(abs(waveform(shape, i / 997)), 1.000000000001)

    def test_envelope_attack_hold_release_and_retrigger_are_continuous(self):
        engine = Engine({"attack_s": 1, "release_s": 2})
        self.assertEqual(engine.step(0, True)["envelope"], 0)
        for _ in range(4):
            sample = engine.step(.25, True)
        self.assertEqual(sample["envelope"], 1)
        self.assertEqual(engine.step(.25, True)["envelope"], 1)
        self.assertEqual(engine.step(.25, False)["envelope"], .875)
        self.assertEqual(engine.step(0, True)["envelope"], .875)
        self.assertEqual(engine.step(.1, True)["envelope"], .975)
        for _ in range(8):
            sample = engine.step(.25, False)
        self.assertEqual(sample["envelope"], 0)

    def test_envelope_to_stroke_starts_at_center(self):
        engine = Engine({"env_to_stroke": True, "shape": "square"})
        sample = engine.step(.2, False)
        self.assertEqual(sample["requested"], .5)
        sample = engine.step(.2, True)
        self.assertAlmostEqual(sample["effective_stroke"], .175)
        self.assertAlmostEqual(sample["requested"], .57)

    def test_position_patch_overrides_carrier_and_bypasses_implicit_envelope(self):
        engine = Engine({"stroke": 1, "shape": "square", "env_to_stroke": True,
                         "attack_s": 1, "patches": [
                             {"source": "envelope", "target": "position", "depth": 1}]})
        sample = engine.step(0, False)
        self.assertAlmostEqual(sample["requested"], .1)
        self.assertTrue(sample["envelope_bypassed"])
        for _ in range(4):
            sample = engine.step(.25, True)
        self.assertAlmostEqual(sample["requested"], .9)
        engine.configure({"patches": [{"source": "envelope", "target": "position", "depth": -1}]})
        self.assertAlmostEqual(engine.step(0, True)["requested"], .1)
        engine.configure({"patches": [{"source": "lfo", "target": "position", "depth": 0}]})
        self.assertAlmostEqual(engine.step(0)["requested"], .5)

    def test_rate_patch_is_exponential_without_phase_reset(self):
        engine = Engine({"rate_hz": 1, "attack_s": 1, "patches": [
            {"source": "envelope", "target": "rate", "depth": 1}]})
        self.assertEqual(engine.step(0)["effective_rate_hz"], .25)
        previous_phase = 0
        previous_rate = .25
        for _ in range(4):
            sample = engine.step(.25, True)
            expected = (previous_phase + .125 * (previous_rate + sample["effective_rate_hz"])) % 1
            self.assertAlmostEqual(sample["phase"], expected)
            previous_phase, previous_rate = sample["phase"], sample["effective_rate_hz"]
        self.assertEqual(previous_rate, 4)
        engine.configure({"rate_hz": 2, "patches": []})
        self.assertEqual(engine.step(0)["phase"], previous_phase)

    def test_additive_stroke_center_and_lfo_sources(self):
        engine = Engine({"lfo_rate_hz": 1, "stroke": .2, "center": .5, "patches": [
            {"source": "lfo", "target": "stroke", "depth": .8},
            {"source": "lfo", "target": "center", "depth": .5}]})
        sample = engine.step(.25)
        self.assertEqual(sample["lfo"], 1)
        self.assertEqual(sample["effective_stroke"], 1)
        self.assertEqual(sample["effective_center"], .75)
        self.assertLessEqual(sample["requested"], .9)
        # Center shift shrinks symmetric stroke to the nearer limit.
        self.assertGreaterEqual(sample["requested"], .5)
        sample = engine.step(.25)
        sample = engine.step(.25)
        self.assertEqual(sample["lfo"], -1)
        self.assertEqual(sample["effective_stroke"], 0)
        self.assertAlmostEqual(sample["requested"], .3)

    def test_requested_signal_stays_inside_window_at_extreme_patches(self):
        rng = random.Random(601)
        for shape in ("sine", "triangle", "saw", "square"):
            engine = Engine({"shape": shape, "lower": .33, "upper": .61, "patches": [
                {"source": "lfo", "target": "rate", "depth": 1},
                {"source": "envelope", "target": "stroke", "depth": -1},
                {"source": "lfo", "target": "center", "depth": 1},
                {"source": "envelope", "target": "position", "depth": -1}]})
            for _ in range(1000):
                sample = engine.step(rng.uniform(.001, .25), gate=rng.choice((True, False)))
                self.assertTrue(.33 <= sample["requested"] <= .61)
                self.assertTrue(.33 <= sample["command"] <= .61)
                self.assertTrue(.02 <= sample["effective_rate_hz"] <= 4)

    def test_disarmed_holds_command_but_signals_continue(self):
        engine = Engine()
        start = engine.step(.1)
        sample = engine.step(.2, True, running=False)
        self.assertEqual(sample["command"], start["command"])
        self.assertEqual(sample["velocity"], 0)
        self.assertFalse(sample["limited"])
        self.assertGreater(sample["envelope"], start["envelope"])
        self.assertGreater(sample["phase"], start["phase"])

    def test_invalid_step_or_configuration_is_atomic(self):
        engine = Engine()
        before = copy.deepcopy(vars(engine))
        for dt in (True, -.1, .251, None, float("nan")):
            with self.assertRaises(ValueError):
                engine.step(dt)
        for key in ("gate", "running"):
            with self.assertRaises(ValueError):
                engine.step(.1, **{key: 1})
        with self.assertRaises(ValueError):
            engine.configure({"rate_hz": 0})
        self.assertEqual(engine.params, before["params"])
        self.assertEqual(engine.phase, before["phase"])
        self.assertEqual(engine.envelope, before["envelope"])
        self.assertEqual(vars(engine.trajectory), vars(before["trajectory"]))
        engine.reset(.85)
        with self.assertRaises(ValueError):
            engine.configure({"upper": .6, "rate_hz": 2})
        self.assertEqual(engine.params["upper"], .9)
        self.assertEqual(engine.params["rate_hz"], .25)
        with self.assertRaises(ValueError):
            engine.reset(.95)
        self.assertEqual(engine.trajectory.position, .85)

    def test_scaled_reset_preserves_limits_and_validates_atomically(self):
        engine = Engine({"lower": .2, "upper": .8})
        engine.reset(.63, vmax=.03, amax=.07)
        engine.step(.2, gate=True)
        for changes in ({"position": .9}, {"vmax": 0}, {"vmax": True},
                        {"amax": float("nan")}, {"amax": float("inf")},
                        {"vmax": .04, "amax": -1}):
            with self.subTest(changes=changes):
                before = copy.deepcopy(vars(engine))
                with self.assertRaises(ValueError):
                    engine.reset(**changes)
                self.assertEqual(vars(engine.trajectory), vars(before["trajectory"]))
                for key in ("params", "phase", "lfo_phase", "envelope"):
                    self.assertEqual(getattr(engine, key), before[key])
        engine.reset(.57)
        self.assertEqual((engine.trajectory.low, engine.trajectory.high), (.2, .8))
        self.assertEqual((engine.trajectory.vmax, engine.trajectory.amax), (.03, .07))
        self.assertEqual(engine.step(0)["command"], .57)
        self.assertEqual(engine.trajectory.velocity, 0)
        self.assertEqual((engine.phase, engine.lfo_phase, engine.envelope), (0, 0, 0))

    def test_measured_span_keeps_physical_speed_and_acceleration_bounded(self):
        for low, high in ((100000, 104097), (-4096, 4096), (-4000, 159841),
                          (-131072, 131072)):
            with self.subTest(bounds=(low, high)):
                span = high - low
                parked_raw = round((low + high) / 2)
                engine = Engine({"shape": "square", "stroke": 1,
                                 "rate_hz": .25, "lower": .15, "upper": .85})
                engine.reset((parked_raw - low) / span,
                             vmax=3822 / span, amax=8192 / span)
                before = engine.step(0)
                self.assertAlmostEqual(low + span * before["command"], parked_raw)
                peak_speed = 0
                for i in range(1200):
                    dt = (.01, .02, .07)[i % 3]
                    if i % 300 == 0:
                        engine.configure({"shape": ("square", "saw", "triangle", "sine")[i // 300]})
                    sample = engine.step(dt, gate=i % 40 < 20)
                    physical_speed = sample["velocity"] * span
                    peak_speed = max(peak_speed, abs(physical_speed))
                    self.assertLessEqual(abs(physical_speed), 3822 + 1e-7)
                    self.assertLessEqual(abs(sample["velocity"] - before["velocity"]) * span,
                                         8192 * dt + 1e-7)
                    self.assertLessEqual(abs(sample["command"] - before["command"]) * span,
                                         3822 * dt + 1e-7)
                    self.assertTrue(.15 <= sample["command"] <= .85)
                    stop = (sample["command"] + sample["velocity"] *
                            abs(sample["velocity"]) / (2 * engine.trajectory.amax))
                    self.assertTrue(.15 - 1e-10 <= stop <= .85 + 1e-10)
                    before = sample
                self.assertGreater(peak_speed, 3000)


class TrajectoryTests(unittest.TestCase):
    def assert_step(self, trajectory, target, dt):
        before_x, before_v = trajectory.position, trajectory.velocity
        command = trajectory.update(target, dt)
        self.assertTrue(trajectory.low <= command <= trajectory.high)
        self.assertLessEqual(abs(trajectory.velocity), trajectory.vmax + 1e-11)
        self.assertLessEqual(abs(trajectory.velocity - before_v), trajectory.amax * dt + 1e-11)
        self.assertLessEqual(abs(command - before_x), trajectory.vmax * dt + 1e-11)
        stop = command + trajectory.velocity * abs(trajectory.velocity) / (2 * trajectory.amax)
        self.assertTrue(trajectory.low - 1e-10 <= stop <= trajectory.high + 1e-10)
        return command

    def test_endpoints_reached_stationary_and_reversal_brakes_continuously(self):
        trajectory = Trajectory(low=.1, high=.9)
        for _ in range(30):
            self.assert_step(trajectory, .9, .01)
        self.assertGreater(trajectory.velocity, 0)
        self.assert_step(trajectory, .1, .01)
        self.assertGreater(trajectory.velocity, 0)
        for target in (.1, .9, .5):
            for _ in range(300):
                self.assert_step(trajectory, target, .01)
            self.assertEqual(trajectory.position, target)
            self.assertEqual(trajectory.velocity, 0)

    def test_random_reversals_variable_time_preserve_stopping_invariants(self):
        rng = random.Random(307)
        trajectory = Trajectory(low=.07, high=.93, vmax=.31, amax=.7)
        for _ in range(10000):
            self.assert_step(trajectory, rng.uniform(.07, .93), rng.uniform(.001, .25))
            trajectory.configure_bounds(.07, .93)

    def test_bound_updates_tolerate_endpoint_stopping_roundoff(self):
        rng = random.Random(901)
        trajectory = Trajectory(.1, .9)
        for _ in range(1000):
            self.assert_step(trajectory, rng.choice((.1, .9)), rng.uniform(.001, .25))
            trajectory.configure_bounds(.1, .9)

    def test_limits_cannot_shrink_past_stopping_point(self):
        trajectory = Trajectory()
        trajectory.update(1, .25)
        stop = trajectory.position + trajectory.velocity ** 2 / (2 * trajectory.amax)
        with self.assertRaises(ValueError):
            trajectory.configure_bounds(.1, (trajectory.position + stop) / 2)
        self.assertEqual(trajectory.high, 1)
        trajectory.configure_bounds(.1, stop + .01)
        self.assert_step(trajectory, .1, .2)

    def test_invalid_values_do_not_mutate_state(self):
        trajectory = Trajectory()
        before = dict(vars(trajectory))
        for bad in (True, float("nan"), float("inf"), -.1, 1.1):
            with self.assertRaises(ValueError):
                trajectory.update(bad, .1)
        for bad in (True, float("nan"), float("inf"), -.1, .251):
            with self.assertRaises(ValueError):
                trajectory.update(.8, bad)
        self.assertEqual(trajectory.update(.8, 0), .5)
        self.assertEqual(vars(trajectory), before)
        for kwargs in ({"low": .9, "high": .1}, {"vmax": 0}, {"amax": -1},
                       {"position": 1.1}, {"low": True}):
            with self.assertRaises(ValueError):
                Trajectory(**kwargs)


if __name__ == "__main__":
    unittest.main()
