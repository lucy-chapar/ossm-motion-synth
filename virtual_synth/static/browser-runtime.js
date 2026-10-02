/* SPDX-License-Identifier: MPL-2.0 */
"use strict";

// Each page owns its engine and explicit Web Serial connection. No HTTP bridge.
((root, factory) => {
  const engine = typeof module === "object" && module.exports
    ? require("./browser-engine.js") : root.MotionBrowserEngine;
  const exported = factory(engine);
  if (typeof module === "object" && module.exports) module.exports = exported;
  else root.MotionBrowserRuntime = exported.createRuntime();
})(globalThis, (engineAPI) => {
  const copy = (value) => structuredClone(value);
  const spanOf = (hw) => {
    const bounds = hw.raw_bounds;
    if (!Array.isArray(bounds) || bounds.length !== 2 || bounds.some((v) => !Number.isInteger(v) || v < -(2 ** 31) || v >= 2 ** 31) || bounds[0] >= bounds[1]) {
      throw new Error("Measured travel bounds are unavailable. Home the motor first.");
    }
    return bounds[1] - bounds[0];
  };

  function createRuntime(options = {}) {
    const clock = options.clock || (() => performance.now() / 1000);
    const serial = options.serial === undefined ? globalThis.navigator?.serial : options.serial;
    const transportFactory = options.transportFactory || ((port) => new globalThis.MotionWebSerialTransport.MotorTransport(port, { allowMotion: true, fastPositions: true }));
    const engine = new engineAPI.Engine();
    const ports = new Map();
    const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    const adapterKey = "motion-synth.adapter";
    const identity = port => JSON.stringify(port.getInfo?.() || {});
    let paused = false;
    let nextPort = 1, transport = null, connectedPort = null, lastHardware = null;
    let mode = "simulation", armed = false, running = false, gate = false, fault = null;
    let unconfirmedStop = false, stoppingCount = 0, revision = 0, epoch = 0, busy = false, closed = false;
    let lastTick = clock(), began = lastTick, lastIO = lastTick, lastHeartbeat = lastTick;
    let signal = engine.step(0, { gate: false, running: false }), history = [];
    let chain = Promise.resolve();
    let timer = null;
    const remember = (port) => {
      for (const [id, known] of ports) if (known === port) return id;
      const id = `adapter-${nextPort++}`; ports.set(id, port); return id;
    };
    const supported = Boolean(serial && typeof serial.requestPort === "function");
    const hardware = () => {
      if (transport) lastHardware = transport.status();
      return lastHardware;
    };
    const homing = () => {
      const hw = transport?.status() || {};
      let bounds = null;
      try { spanOf(hw); bounds = hw.raw_bounds; } catch (_) { /* Not measured yet. */ }
      return { simulated: false, hardware_enabled: supported, active: Boolean(hw.homing), valid: Boolean(hw.homed),
        phase: hw.home_phase || "disconnected", progress: hw.home_progress || 0, direction: hw.home_direction || "normal",
        position_raw: hw.position_raw ?? null, current_raw: hw.current_raw ?? null, origin_raw: hw.home_origin_raw ?? null,
        fault: hw.fault || null, measured_endpoints_raw: hw.measured_endpoints_raw || null,
        measured_travel_raw: hw.measured_travel_raw ?? null,
        endpoints: hw.homed && bounds ? { usable_low_raw: bounds[0], usable_high_raw: bounds[1] } : null };
    };
    function state() {
      return copy({ mode, armed, running, paused, gate, fault, params: engine.params, signal, history,
        hardware: hardware(), allow_motion: supported, run_remaining_s: null,
        unconfirmed_stop: unconfirmedStop, stopping: stoppingCount > 0, control_revision: revision, homing: homing(), web_serial_supported: supported });
    }
    function fence() {
      epoch++; revision++; paused = false; running = armed = gate = false;
      signal = engine.step(0, { running: false, gate: false });
    }
    function enqueue(task) {
      const run = async () => { busy = true; try { return await task(); } finally { busy = false; } };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    }
    async function stopTransport() {
      if (transport) {
        const before = transport.status();
        stoppingCount++;
        try {
          // Fence even a pending read-only preflight before it can claim motion.
          try { await transport.stop(); } catch (error) { fault ||= String(error.message || error); }
          const after = hardware();
          if (after.stop_confirmed === true) unconfirmedStop = false;
          if ((before.running || before.owned) && after.stop_confirmed !== true) {
            unconfirmedStop = true;
            fault ||= "Motor stop is unconfirmed. Use the independent physical stop.";
          }
        } finally { stoppingCount--; }
      }
      lastTick = clock();
    }
    async function fail(message) {
      fault = String(message); fence(); await stopTransport();
      const hw = hardware();
      if (hw?.owned && hw.stop_confirmed !== true) unconfirmedStop = true;
    }
    function stop() {
      fence(); // Immediately cancel queued intent, including an in-flight Home/Arm/Run.
      const stopping = stopTransport(); // The transport fences its own in-flight I/O immediately.
      return enqueue(async () => { await stopping; return state(); });
    }
    async function tickInside() {
      const now = clock(), dt = now - lastTick;
      lastTick = now;
      if (!Number.isFinite(dt) || dt < 0) { await fail("Monotonic clock changed unexpectedly."); return; }
      const activeHome = homing().active;
      if ((armed || activeHome) && now - lastHeartbeat > 1.5) await fail("Control tab heartbeat expired. Output stopped; rearm explicitly.");
      else if ((running && dt > 0.25) || (activeHome && dt > 1)) await fail("Motion scheduling deadline missed. No catch-up targets were sent.");
      signal = engine.step(paused ? 0 : Math.min(dt, 0.25), { gate, running });
      if (transport && now - lastIO >= (running ? 0.033 : homing().active ? 0.1 : 0.5)) {
        lastIO = now;
        const ioEpoch = epoch, recoveriesBefore = transport.status().communication_recoveries || 0;
        try {
          if (homing().active) {
            lastHardware = await transport.poll_home();
            if (!lastHardware.homing && lastHardware.fault) await fail(`Sensorless homing: ${lastHardware.fault}`);
          } else if (running) lastHardware = await transport.command(signal.command);
          else if (transport.status().connected && !fault) lastHardware = await transport.snapshot();
          // A bounded recovery pauses the planner. Do not advance through the
          // missed interval or send catch-up targets afterward.
          if ((lastHardware?.communication_recoveries || 0) > recoveriesBefore) lastTick = lastIO = clock();
        } catch (error) { if (ioEpoch === epoch) await fail(`RS485: ${error.message || error}`); }
      }
      const hw = hardware();
      history.push({ t: Math.round((now - began) * 1e4) / 1e4, requested: signal.requested, command: signal.command,
        actual: mode === "hardware" && hw && !fault ? hw.position_normalized ?? null : null, envelope: signal.envelope });
      if (history.length > 500) history.shift();
    }
    function tick() {
      if (busy || closed) return Promise.resolve();
      // Reserve before enqueueing so interval calls cannot build a backlog.
      busy = true;
      return enqueue(tickInside).catch(async (error) => { await fail(`Engine failure: ${error.message || error}`); });
    }
    async function listPorts() {
      if (!supported) return { ports: [] };
      const allowed = await serial.getPorts();
      return { ports: allowed.map((port) => {
        const info = port.getInfo?.() || {}, id = remember(port);
        const usb = info.usbVendorId !== undefined ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId || 0).toString(16).padStart(4, "0")}` : "Serial adapter";
        return { device: id, description: usb };
      }) };
    }
    // Called directly from a click handler to retain transient user activation.
    function choosePort() {
      if (closed) return Promise.reject(new Error("This synth session is closed. Reload to start a new session."));
      if (!supported) return Promise.reject(new Error("Direct USB connection needs a browser with Web Serial, such as desktop Chrome or Edge."));
      const requestedEpoch = epoch;
      return serial.requestPort().then((port) => {
        if (closed || requestedEpoch !== epoch) throw new Error("Adapter selection was cancelled. Choose again when ready.");
        return remember(port);
      });
    }
    async function act(payload, requestedEpoch) {
      const name = payload.action;
      if (requestedEpoch !== epoch) throw new Error("Controls were stopped. Repeat the action explicitly.");
      if (homing().active) throw new Error("Stop homing before changing controls or connections.");
      const assertCurrent = async () => {
        if (requestedEpoch !== epoch) { await stopTransport(); throw new Error("Output was stopped before the action completed."); }
      };
      const motionError = async (label, error) => {
        if (requestedEpoch !== epoch) { await stopTransport(); throw new Error("Output was stopped before the action completed."); }
        await fail(`${label}: ${error.message || error}`); throw new Error(fault);
      };
      if (name === "configure") {
        const proposed = engineAPI.validateParams(payload.params, engine.params);
        if (armed && (proposed.lower !== engine.params.lower || proposed.upper !== engine.params.upper)) throw new Error("Stop output before changing maximum travel limits.");
        engine.configure(proposed);
      } else if (name === "home_start") {
        if (!Number.isInteger(payload.control_revision) || payload.control_revision !== revision) throw new Error("Controls changed since this Home request. Refresh status and start again.");
        if (paused || armed || running || fault || unconfirmedStop) throw new Error("Stop output and clear the fault before homing.");
        if (!transport?.status().connected) throw new Error("Connect a motor before homing.");
        if (![undefined, "normal", "reverse"].includes(payload.direction)) throw new Error("Select Normal or Reverse homing direction.");
        try { lastHardware = await transport.begin_home(payload.direction === "reverse"); await assertCurrent(); }
        catch (error) { await motionError("Cannot home", error); }
        revision++; gate = false; lastHeartbeat = lastTick = clock();
      } else if (name === "play") {
        if (running || paused || fault || unconfirmedStop) throw new Error("Play requires a healthy stopped synth.");
        if (!armed) await act({ action: "arm" }, requestedEpoch);
        await assertCurrent();
        return act({ action: "run" }, requestedEpoch);
      } else if (name === "arm") {
        if (fault || unconfirmedStop) throw new Error("Resolve and reset the fault before arming.");
        if (paused) throw new Error("Resume or Stop the paused session before arming.");
        if (armed) throw new Error("Already armed.");
        if (transport) {
          if (!transport.status().homed) throw new Error("Home the motor before arming this connection.");
          try {
            const hw = await transport.arm(); await assertCurrent();
            const span = spanOf(hw);
            if (![hw.max_velocity_raw_s, hw.max_acceleration_raw_s2].every(v => Number.isFinite(v) && v > 0)) throw new Error("Motor motion limits are unavailable.");
            engine.reset({ position: hw.position_normalized, vmax: hw.max_velocity_raw_s / span, amax: hw.max_acceleration_raw_s2 / span });
            signal = engine.step(0, { running: false });
          } catch (error) { await motionError("Cannot arm", error); }
        }
        armed = true; gate = false; lastHeartbeat = lastTick = clock();
      } else if (name === "pause") {
        if (!running) throw new Error("Start before pausing.");
        fence(); await stopTransport();
        if (fault || unconfirmedStop) throw new Error(fault || "Stop is unconfirmed.");
        paused = true;
      } else if (name === "resume") {
        if (!paused || fault || unconfirmedStop) throw new Error("A healthy paused synth is required.");
        if (transport) {
          if (!transport.status().homed) throw new Error("Home the motor before resuming.");
          try {
            await transport.arm(); await assertCurrent();
            const hw = await transport.start(); await assertCurrent();
            engine.trajectory.reset(hw.position_normalized);
            signal = engine.step(0, { running: false, gate: false });
          } catch (error) { await motionError("Cannot resume", error); }
        }
        paused = false; armed = running = true; lastTick = lastIO = lastHeartbeat = clock();
      } else if (name === "run") {
        if (!armed || running || fault) throw new Error("Arm a stopped, healthy synth before running.");
        if (transport) {
          try {
            const hw = await transport.start(); await assertCurrent();
            engine.reset({ position: hw.position_normalized }); signal = engine.step(0, { running: false });
          } catch (error) { await motionError("Cannot start", error); }
        }
        running = true; lastTick = lastIO = lastHeartbeat = clock();
      } else if (name === "gate") {
        if (typeof payload.value !== "boolean") throw new Error("Gate must be true or false.");
        if (payload.value && (!armed || !running || fault)) throw new Error("Start the armed synth before opening the envelope gate.");
        gate = payload.value;
      } else if (name === "reset") {
        if (running || armed) throw new Error("Stop before resetting a fault.");
        if (unconfirmedStop) throw new Error("Stop is unconfirmed. Reconnect and verify disabled output first.");
        if (transport?.status().fault) {
          if (!transport.reset_fault) throw new Error("Reconnect before resetting this fault.");
          lastHardware = await transport.reset_fault(); await assertCurrent();
        }
        fault = null; gate = false;
      } else if (name === "connect") {
        if (paused || armed || transport) throw new Error("Stop and disconnect before selecting another port.");
        const listed = await listPorts();
        if (!listed.ports.some((port) => port.device === payload.port)) throw new Error("Choose a currently available serial adapter.");
        await assertCurrent();
        const candidate = transportFactory(ports.get(payload.port));
        try {
          lastHardware = await candidate.connect();
          if (unconfirmedStop && lastHardware.output_enabled && candidate.recover_stop) lastHardware = await candidate.recover_stop();
        }
        catch (error) { await candidate.close(); throw error; }
        if (requestedEpoch !== epoch || closed) {
          await candidate.close(); lastHardware = null;
          throw new Error("Connection was stopped before it completed.");
        }
        transport = candidate; connectedPort = ports.get(payload.port);
        try { storage?.setItem(adapterKey, identity(connectedPort)); } catch (_) { /* Storage may be unavailable. */ } mode = "hardware"; revision++; history = [];
        await assertCurrent();
        lastIO = lastTick = clock();
        const hw = hardware();
        if (!unconfirmedStop || (hw.mode === 1 && hw.output_enabled === false && Number.isInteger(hw.pending_raw) && Math.abs(hw.pending_raw) <= 2 && hw.pwm_raw === 0)) {
          unconfirmedStop = false; fault = null;
        }
      } else if (name === "disconnect") {
        fence(); await stopTransport();
        if (transport) { await transport.close(); lastHardware = transport.status(); transport = null; connectedPort = null; }
        mode = "simulation"; engine.reset({ position: engine.trajectory.position, vmax: engineAPI.MAX_VELOCITY, amax: engineAPI.MAX_ACCELERATION });
        signal = engine.step(0, { running: false }); history = [];
        if (!unconfirmedStop) fault = null;
      } else throw new Error("Unknown action.");
      return state();
    }
    function request(path, payload) {
      if (path === "/api/session") return Promise.resolve({ token: "browser-session" });
      if (path === "/api/state") return Promise.resolve(state());
      if (path === "/api/ports") return listPorts();
      if (path !== "/api/action" || !payload || typeof payload.action !== "string") return Promise.reject(new Error("Expected an action object."));
      if (closed) return Promise.reject(new Error("This synth session is closed. Reload to start a new session."));
      const allowed = { configure: ["params"], gate: ["value"], connect: ["port"], home_start: ["direction", "control_revision"] };
      if (Object.keys(payload).some((key) => key !== "action" && !(allowed[payload.action] || []).includes(key))) return Promise.reject(new Error("Unexpected action fields."));
      if (payload.action === "heartbeat") { if (armed || homing().active) lastHeartbeat = clock(); return Promise.resolve({ ok: true }); }
      if (payload.action === "stop" || payload.action === "home_cancel") return stop();
      const requestedEpoch = epoch;
      return enqueue(() => act(payload, requestedEpoch));
    }
    async function autoConnect() {
      if (!supported || transport || paused || armed || running || closed) return false;
      let saved; try { saved = storage?.getItem(adapterKey); } catch (_) { return false; }
      if (!saved || saved === "{}") return false;
      const available = await serial.getPorts();
      const matches = available.filter(port => identity(port) === saved);
      if (matches.length !== 1) return false;
      await request("/api/action", { action: "connect", port: remember(matches[0]) });
      return true;
    }
    function onConnect() { autoConnect().catch(() => {}); }
    function onDisconnect(event) {
      if (transport && (event.target === connectedPort || event.port === connectedPort)) {
        fence(); enqueue(async () => {
          await fail("USB serial adapter disconnected. Reconnect to continue.");
          const detached = transport;
          try { await detached?.close(); } catch (_) { /* Retain stop uncertainty. */ }
          if (transport === detached) {
            lastHardware = detached?.status() || lastHardware;
            if (lastHardware) lastHardware.connected = false;
            transport = null; connectedPort = null;
          }
        });
      }
    }
    serial?.addEventListener?.("disconnect", onDisconnect);
    serial?.addEventListener?.("connect", onConnect);
    if (options.autoStart !== false) timer = setInterval(tick, 20);
    return { request, choosePort, autoConnect, tick, state, stop, supported,
      async close() { closed = true; clearInterval(timer); await stop(); if (transport) await transport.close(); serial?.removeEventListener?.("disconnect", onDisconnect); serial?.removeEventListener?.("connect", onConnect); } };
  }
  return { createRuntime };
});
