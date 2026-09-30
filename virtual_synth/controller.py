# SPDX-License-Identifier: MPL-2.0
"""Single-owner application state; browser timing never clocks motor targets."""

from collections import deque
import copy
import math
import threading
import time

from .engine import Engine, MAX_ACCELERATION, MAX_VELOCITY, validate_params
from .transport import MotorTransport, list_ports


LEASE_SECONDS = 1.5
HARDWARE_PERIOD = 0.1
MAX_RUN_SECONDS = 20.0
HOMING_SCHEDULING_SECONDS = 1.0
HARDWARE_MAX_VELOCITY_RAW = 3822.0
HARDWARE_MAX_ACCELERATION_RAW = 8192.0


def _raw_travel_span(hardware):
    """Require measured integer encoder bounds before scaling motor motion."""
    bounds = hardware.get("raw_bounds")
    if (not isinstance(bounds, (list, tuple)) or len(bounds) != 2
            or any(type(value) is not int or not -(2**31) <= value < 2**31
                   for value in bounds) or bounds[0] >= bounds[1]):
        raise ValueError("Measured raw travel bounds must be two increasing signed 32-bit integers.")
    return bounds[1] - bounds[0]


class Controller:
    def __init__(self, allow_motion=False, clock=time.monotonic,
                 transport_factory=MotorTransport):
        self.clock = clock
        self.allow_motion = bool(allow_motion)
        self.transport_factory = transport_factory
        self.engine = Engine()
        self.lock = threading.RLock()
        self.transport = None
        self.last_hardware = None
        self.unconfirmed_stop = False
        self.mode = "simulation"
        self.armed = self.running = self.gate = False
        self.fault = None
        self.owner = None
        self.control_revision = 0
        self.last_heartbeat = self.started = self.last_io = clock()
        self.began = self.last_tick = clock()
        self.history = deque(maxlen=500)
        self.signal = self.engine.step(0, gate=False, running=False)
        self.shutdown_event = threading.Event()
        self.worker = None

    def start_worker(self):
        self.worker = threading.Thread(target=self._work, name="motion-engine", daemon=True)
        self.worker.start()

    def _work(self):
        while not self.shutdown_event.wait(0.02):
            try:
                self.tick()
            except Exception as error:
                with self.lock:
                    self._fault(f"Engine failure: {error}")

    def _hardware_state(self):
        if self.transport is not None:
            self.last_hardware = self.transport.status()
        return self.last_hardware

    def _homing_state(self):
        if self.mode != "hardware" or self.transport is None:
            return {
                "simulated": False, "hardware_enabled": False,
                "active": False, "valid": False, "phase": "disconnected",
                "progress": 0, "direction": "normal", "position_raw": None,
                "current_raw": None, "origin_raw": None, "fault": None,
                "endpoints": None, "measured_endpoints_raw": None,
                "measured_travel_raw": None,
            }
        hw = self.transport.status()
        bounds = hw.get("raw_bounds")
        try:
            _raw_travel_span(hw)
        except ValueError:
            bounds = None
        return {
            "simulated": False, "hardware_enabled": self.allow_motion,
            "active": bool(hw.get("homing")), "valid": bool(hw.get("homed")),
            "phase": hw.get("home_phase", "idle"),
            "progress": hw.get("home_progress", 0),
            "direction": hw.get("home_direction", "normal"),
            "position_raw": hw.get("position_raw"), "current_raw": hw.get("current_raw"),
            "origin_raw": hw.get("home_origin_raw"), "fault": hw.get("fault"),
            "measured_endpoints_raw": hw.get("measured_endpoints_raw"),
            "measured_travel_raw": hw.get("measured_travel_raw"),
            "endpoints": ({"usable_low_raw": bounds[0], "usable_high_raw": bounds[1]}
                          if hw.get("homed") and bounds else None),
        }

    def state(self):
        with self.lock:
            homing = self._homing_state()
            remaining = None
            if self.mode == "hardware" and self.running:
                remaining = max(0, MAX_RUN_SECONDS - (self.clock() - self.started))
            return copy.deepcopy({
                "mode": self.mode, "armed": self.armed, "running": self.running,
                "gate": self.gate, "fault": self.fault, "params": self.engine.params,
                "signal": self.signal, "history": list(self.history),
                "hardware": self._hardware_state(), "allow_motion": self.allow_motion,
                "run_remaining_s": remaining, "unconfirmed_stop": self.unconfirmed_stop,
                "control_revision": self.control_revision,
                "homing": homing,
            })

    def _stop(self):
        self.control_revision += 1
        self.running = self.armed = self.gate = False
        self.owner = None
        error = None
        if self.transport is not None:
            before = self.transport.status()
            needs_confirmation = bool(before.get("running") or before.get("owned"))
            # Read-only observation never grants ownership of an already-enabled drive.
            if before.get("armed") or before.get("running") or before.get("owned") or before.get("homing"):
                try:
                    self.transport.stop()
                except Exception as exc:
                    error = str(exc)
                after = self._hardware_state()
                if needs_confirmation and after.get("stop_confirmed") is not True:
                    self.unconfirmed_stop = True
                    error = error or "Motor stop is unconfirmed; use the independent physical stop."
        self.signal = self.engine.step(0, gate=False, running=False)
        self.last_tick = self.clock()
        if error:
            self.fault = error

    def _fault(self, message):
        self.fault = str(message)
        self._stop()
        hardware = self._hardware_state()
        if hardware and hardware.get("owned") and hardware.get("stop_confirmed") is not True:
            self.unconfirmed_stop = True
            self.fault = f"{message} Stop unconfirmed; use the independent physical stop."

    def tick(self):
        with self.lock:
            now = self.clock()
            dt = now - self.last_tick
            self.last_tick = now
            if not math.isfinite(dt) or dt < 0:
                self._fault("Monotonic clock changed unexpectedly.")
                return
            active_home = self._homing_state()["active"]
            if (self.armed or active_home) and now - self.last_heartbeat > LEASE_SECONDS:
                self._fault("Control tab heartbeat expired. Output stopped; rearm explicitly.")
            elif (self.running and dt > 0.25) or (active_home and dt > HOMING_SCHEDULING_SECONDS):
                self._fault("Motion scheduling deadline missed. No catch-up targets were sent.")
            if self.mode == "hardware" and self.running and now - self.started >= MAX_RUN_SECONDS:
                self._stop()
            # A stopped synth may keep showing its request, but command position is held.
            self.signal = self.engine.step(min(dt, 0.25), gate=self.gate,
                                           running=self.running)
            actual = None
            if self.transport is not None and now - self.last_io >= (
                    HARDWARE_PERIOD if self.running or self._homing_state()["active"] else 0.5):
                self.last_io = now
                try:
                    if self._homing_state()["active"]:
                        hw = self.transport.poll_home()
                        if not hw.get("homing"):
                            self.owner = None
                            if hw.get("fault"):
                                self._fault(f"Sensorless homing: {hw['fault']}")
                    elif self.running:
                        hw = self.transport.command(self.signal["command"])
                    elif self.transport.status().get("connected") and not self.fault:
                        hw = self.transport.snapshot()
                    else:
                        hw = self.transport.status()
                    self.last_hardware = hw
                except Exception as error:
                    self._fault(f"RS485: {error}")
            hardware = self._hardware_state()
            if self.mode == "hardware" and hardware and not self.fault:
                actual = hardware.get("position_normalized")
            self.history.append({"t": round(now - self.began, 4),
                                 "requested": self.signal["requested"],
                                 "command": self.signal["command"],
                                 "actual": actual, "envelope": self.signal["envelope"]})

    def action(self, payload, client):
        if not isinstance(payload, dict) or not isinstance(payload.get("action"), str):
            raise ValueError("Expected an action object.")
        name = payload["action"]
        fields = {"configure": {"params"}, "gate": {"value"}, "connect": {"port"},
                  "home_start": {"direction", "control_revision"}}
        if set(payload) - ({"action"} | fields.get(name, set())):
            raise ValueError("Unexpected action fields.")
        with self.lock:
            if name == "stop":
                self._stop()  # Any authenticated local tab may request a stop.
                return self.state()
            if name == "home_cancel":
                if self._homing_state()["active"]:
                    self._stop()
                else:
                    # Fence an older Home request still in flight to the server.
                    self.control_revision += 1
                return self.state()
            if self.owner is not None and self.owner != client:
                raise ValueError("Another tab owns the controls. Stop before taking ownership.")
            if name == "heartbeat":
                if self.owner == client:
                    self.last_heartbeat = self.clock()
                return {"ok": True}
            if self._homing_state()["active"]:
                raise ValueError("Cancel sensorless homing before changing controls or connections.")
            if name == "home_start":
                revision = payload.get("control_revision")
                if type(revision) is not int or revision != self.control_revision:
                    raise ValueError("Controls changed since this Home request. Refresh status and start again.")
                if self.armed or self.running or self.fault or self.unconfirmed_stop:
                    raise ValueError("Stop output and clear the fault before homing.")
                if (self.mode != "hardware" or self.transport is None
                        or not self.transport.status().get("connected")):
                    raise ValueError("Connect a motor before homing.")
                direction = payload.get("direction", "normal")
                if direction not in ("normal", "reverse"):
                    raise ValueError("Select Normal or Reverse homing direction.")
                if not self.allow_motion:
                    raise ValueError("Launch with --allow-motion to use hardware homing.")
                try:
                    self.last_hardware = self.transport.begin_home(reverse=direction == "reverse")
                except Exception as error:
                    self._fault(f"Cannot home: {error}")
                    raise ValueError(self.fault) from error
                self.control_revision += 1  # A Home request is consumed exactly once.
                self.owner = client
                self.gate = False
                self.last_heartbeat = self.last_tick = self.clock()
                return self.state()
            if name == "configure":
                proposed = validate_params(payload.get("params"), self.engine.params)
                bounds_changed = any(proposed[k] != self.engine.params[k] for k in ("lower", "upper"))
                if bounds_changed and self.armed:
                    raise ValueError("Stop output before changing maximum travel limits.")
                self.engine.configure(proposed)
            elif name == "arm":
                if self.fault or self.unconfirmed_stop:
                    raise ValueError("Resolve and reset the fault before arming.")
                if self.armed:
                    raise ValueError("Already armed.")
                if self.transport is not None:
                    if not self.allow_motion:
                        raise ValueError("Bridge is read-only. Live bench control requires --allow-motion.")
                    if not self.transport.status().get("homed"):
                        raise ValueError("Home the motor before arming this connection.")
                    try:
                        hw = self.transport.arm()
                        span = _raw_travel_span(hw)
                        self.engine.reset(position=hw["position_normalized"],
                                          vmax=HARDWARE_MAX_VELOCITY_RAW / span,
                                          amax=HARDWARE_MAX_ACCELERATION_RAW / span)
                        self.signal = self.engine.step(0, running=False)
                    except Exception as error:
                        self._fault(f"Cannot arm: {error}")
                        raise ValueError(self.fault) from error
                self.armed, self.owner = True, client
                self.gate = False
                self.last_heartbeat = self.last_tick = self.clock()
            elif name == "run":
                if not self.armed or self.running or self.fault:
                    raise ValueError("Arm a stopped, healthy synth before running.")
                if self.transport is not None:
                    try:
                        hw = self.transport.start()
                        self.engine.reset(position=hw["position_normalized"])
                        self.signal = self.engine.step(0, running=False)
                    except Exception as error:
                        self._fault(f"Cannot start: {error}")
                        raise ValueError(self.fault) from error
                self.running = True
                self.started = self.last_tick = self.last_io = self.last_heartbeat = self.clock()
            elif name == "gate":
                value = payload.get("value")
                if type(value) is not bool:
                    raise ValueError("Gate must be true or false.")
                if value and (not self.armed or not self.running or self.fault):
                    raise ValueError("Start the armed synth before opening the envelope gate.")
                self.gate = value
            elif name == "reset":
                if self.running or self.armed:
                    raise ValueError("Stop before resetting a fault.")
                if self.unconfirmed_stop:
                    raise ValueError("Stop is unconfirmed. Reconnect and verify disabled output first.")
                if self.transport is not None and self.transport.status().get("fault"):
                    raise ValueError("Disconnect and inspect the drive before reconnecting.")
                self.fault = None
                self.gate = False
            elif name == "connect":
                if self.armed or self.transport is not None:
                    raise ValueError("Stop and disconnect before selecting another port.")
                port = payload.get("port")
                if not isinstance(port, str) or port not in {p["device"] for p in list_ports()}:
                    raise ValueError("Select a currently listed serial device.")
                candidate = self.transport_factory(port, allow_motion=self.allow_motion)
                try:
                    hw = candidate.connect()
                except Exception:
                    candidate.close()
                    raise
                self.transport = candidate
                self.mode = "hardware"
                self.control_revision += 1  # Home intent belongs to this connection only.
                self.last_hardware = hw
                self.history.clear()
                self.last_io = self.last_tick = self.clock()
                if self.unconfirmed_stop:
                    # Only fresh explicit readback may resolve a previous uncertain stop.
                    if (hw.get("mode") == 1 and hw.get("output_enabled") is False
                            and hw.get("pending_raw") == 0 and hw.get("pwm_raw") == 0):
                        self.unconfirmed_stop = False
                        self.fault = None
                else:
                    self.fault = None
            elif name == "disconnect":
                self._stop()
                if self.transport is not None:
                    self.transport.close()
                    self.last_hardware = self.transport.status()
                    self.transport = None
                self.mode = "simulation"
                self.engine.reset(position=self.engine.trajectory.position,
                                  vmax=MAX_VELOCITY, amax=MAX_ACCELERATION)
                self.signal = self.engine.step(0, running=False)
                if not self.unconfirmed_stop:
                    self.fault = None
                self.history.clear()
            else:
                raise ValueError("Unknown action.")
            return self.state()

    def close(self):
        self.shutdown_event.set()
        if self.worker is not None and self.worker is not threading.current_thread():
            self.worker.join(timeout=3)
        with self.lock:
            self._stop()
            if self.transport is not None:
                self.transport.close()
