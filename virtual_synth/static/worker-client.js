/* SPDX-License-Identifier: MPL-2.0 */
"use strict";
((root, factory) => {
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  else {
    root.MotionWorkerClient = exported;
    const script = root.document.currentScript.src;
    root.MotionBrowserRuntime = exported.createClient({ workerURL: new URL("./worker.js", script) });
  }
})(globalThis, () => {
  function createClient(options = {}) {
    const serial = options.serial === undefined ? globalThis.navigator?.serial : options.serial;
    const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    const workerFactory = options.workerFactory || (url => new Worker(url));
    const pending = new Map();
    let worker = null, nextId = 1, failed = null, closed = false, closing = null;
    let cached = null, supported = false, selectionEpoch = 0;
    let pendingMotionRequests = 0, unobservedMotion = false, safeStateAfterId = 0;
    const copy = value => structuredClone(value);
    const ownsMotion = state => Boolean(state?.hardware?.owned || state?.armed || state?.running
      || state?.homing?.active || state?.stopping || state?.unconfirmed_stop);
    const rememberState = (value, responseId = 0) => {
      const state = value?.state || value;
      if (state && ["simulation", "hardware"].includes(state.mode) && state.params) {
        if (cached && Number.isInteger(state.control_revision) && Number.isInteger(cached.control_revision)
            && state.control_revision < cached.control_revision) {
          return value?.state ? { ...value, state: copy(cached) } : copy(cached);
        }
        cached = copy(state);
        // An error reply carries no ownership state. Only a state requested
        // after that error may establish that the motion owner is stopped.
        if (unobservedMotion && responseId >= safeStateAfterId && !ownsMotion(state)) unobservedMotion = false;
      }
      return value;
    };
    function fail(error) {
      failed ||= error instanceof Error ? error : new Error(String(error));
      supported = false;
      const pendingMotion = Array.from(pending.values()).some(task => task.details?.path === "/api/action"
        && ["play", "arm", "run", "resume", "home_start", "connect"].includes(task.details.payload?.action));
      if (cached) cached = { ...cached, running: false, armed: false, fault: failed.message,
        hardware: cached.hardware ? { ...cached.hardware, stop_confirmed: false } : null,
        unconfirmed_stop: Boolean(cached.hardware?.connected || cached.hardware?.owned || cached.running || cached.armed || pendingMotion) };
      for (const task of pending.values()) task.reject(failed);
      pending.clear();
      // Terminating/replacing an owner cannot prove electrical Stop. Leave
      // its ownership uncertain and never open a second serial controller.
    }
    function send(type, details = {}) {
      if (failed || closed || !worker) return Promise.reject(failed || new Error("The motion worker is closed. Reload while stopped."));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, details });
        try { worker.postMessage({ id, type, ...details }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    }
    let ready;
    try {
      worker = workerFactory(options.workerURL);
      worker.addEventListener("message", event => {
        const response = event.data;
        if (response?.type === "storage") {
          if (response.key === "motion-synth.adapter" && typeof response.value === "string") {
            try { storage?.setItem(response.key, response.value); } catch (_) { /* Optional remembered permission. */ }
          }
          return;
        }
        const task = pending.get(response?.id); if (!task) return;
        pending.delete(response.id);
        if (response.ok === true) task.resolve(rememberState(response.value, response.id));
        else { const error = new Error(response.error || "Motion worker request failed."); error.name = response.name || "Error"; task.reject(error); }
      });
      worker.addEventListener("error", () => fail(new Error("Motion worker failed. Motor Stop is unconfirmed; use the physical stop if moving.")));
      worker.addEventListener("messageerror", () => fail(new Error("Motion worker communication failed. Motor Stop is unconfirmed; use the physical stop if moving.")));
      let identity = null; try { identity = storage?.getItem("motion-synth.adapter") || null; } catch (_) { /* Optional storage. */ }
      ready = send("init", { adapter_identity: identity }).then(value => { supported = value.supported === true; return value; });
    } catch (error) { fail(error); ready = Promise.reject(error); }
    ready.catch(() => {});
    const request = async (path, payload) => {
      const motion = path === "/api/action" && ["play", "arm", "run", "resume", "home_start"].includes(payload?.action);
      // Set this before awaiting readiness or a worker reply: closing in the
      // same task as Play/Home must not rely on the previous stopped snapshot.
      if (motion) pendingMotionRequests++;
      let dispatched = false;
      if (path === "/api/action" && ["stop", "home_cancel"].includes(payload?.action)) selectionEpoch++;
      try {
        if (path === "/api/state" && failed && cached) return copy(cached);
        await ready;
        dispatched = true;
        const result = await send("request", { path, payload });
        if (motion && !(result?.state || result)?.params) {
          unobservedMotion = true; safeStateAfterId = nextId;
        }
        return result;
      } catch (error) {
        if (motion && dispatched) { unobservedMotion = true; safeStateAfterId = nextId; }
        throw error;
      } finally { if (motion) pendingMotionRequests--; }
    };
    async function choosePort() {
      if (closed || failed) throw failed || new Error("The motion worker is closed.");
      if (typeof serial?.requestPort !== "function") throw new Error("Direct USB connection needs desktop Chrome or Edge with Web Serial.");
      const epoch = selectionEpoch;
      // Invoke directly before an await to retain the click's user activation.
      const choice = serial.requestPort();
      const port = await choice, info = port.getInfo?.() || {};
      if (epoch !== selectionEpoch) throw new Error("Adapter selection was cancelled by Stop. Choose again when ready.");
      const identity = JSON.stringify(Object.fromEntries(Object.keys(info).sort().map(key => [key, info[key]])));
      await ready;
      if (epoch !== selectionEpoch) throw new Error("Adapter selection was cancelled by Stop.");
      return send("choose", { identity });
    }
    function stop() { return request("/api/action", { action: "stop" }); }
    async function close() {
      if (closed) return cached;
      if (closing) return closing;
      selectionEpoch++;
      closing = (async () => {
        await ready;
        const result = await send("close");
        const state = result?.state, hardware = state?.hardware;
        if (result?.closed !== true || !state?.params || state.running || state.armed || state.stopping
            || state.unconfirmed_stop || state.homing?.active || hardware?.owned || hardware?.connected
            || (hardware && (hardware.stop_confirmed !== true || hardware.output_enabled !== false))) {
          throw new Error("The motion worker did not confirm stopped and closed output.");
        }
        closed = true; unobservedMotion = false; worker.terminate(); return rememberState(result.state);
      })().finally(() => { closing = null; });
      return closing;
    }
    return { request, choosePort, stop, close, ready, get supported() { return supported && !closed; },
      get mustStopBeforeClose() { return pendingMotionRequests > 0 || unobservedMotion || ownsMotion(cached); },
      state: () => cached ? copy(cached) : null,
      async autoConnect() { await ready; return send("auto_connect"); } };
  }
  return { createClient };
});
