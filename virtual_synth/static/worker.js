/* SPDX-License-Identifier: MPL-2.0 */
"use strict";

// This worker is the sole owner of the planner and open serial streams.
globalThis.MotionWorkerOwner = true;
importScripts("./ruckig-core.js", "./browser-engine.js", "./web-serial-io.js", "./web-serial-transport.js", "./browser-runtime.js");
(() => {
  const identity = port => {
    const info = port.getInfo?.() || {};
    return JSON.stringify(Object.fromEntries(Object.keys(info).sort().map(key => [key, info[key]])));
  };
  let runtime = null, selectedIdentity = null, initializing = null, shuttingDown = false, bridgeEpoch = 0;
  const nativeSerial = globalThis.navigator?.serial;
  const storageValues = new Map();
  const storage = {
    getItem: key => storageValues.get(key) ?? null,
    setItem(key, value) { storageValues.set(key, value); postMessage({ type: "storage", key, value }); },
  };
  const serial = nativeSerial && typeof nativeSerial.getPorts === "function" ? {
    async getPorts() {
      const epoch = bridgeEpoch, ports = await nativeSerial.getPorts();
      if (epoch !== bridgeEpoch) throw new Error("Adapter enumeration was cancelled by Stop.");
      return ports;
    },
    addEventListener: (...args) => nativeSerial.addEventListener(...args),
    removeEventListener: (...args) => nativeSerial.removeEventListener(...args),
    async requestPort() {
      // Window granted permission. Reacquire our own object; never transfer a
      // SerialPort or infer identity from catalog order or vendor ID alone.
      const requested = selectedIdentity; selectedIdentity = null;
      if (!requested || requested === "{}") throw new Error("Choose the USB adapter in the main browser window.");
      const matches = (await nativeSerial.getPorts()).filter(port => identity(port) === requested);
      if (matches.length !== 1) throw new Error("The selected adapter is unavailable or ambiguous. Connect only one matching adapter.");
      return matches[0];
    },
  } : null;
  async function handle(message, requestedEpoch) {
    if (message.type === "init") {
      if (initializing) return initializing;
      initializing = (async () => {
        if (typeof message.adapter_identity === "string") storageValues.set("motion-synth.adapter", message.adapter_identity);
        await globalThis.MotionRuckig.ready;
        runtime = globalThis.MotionBrowserRuntimeAPI.createRuntime({ serial, storage });
        return { supported: runtime.supported, state: runtime.state() };
      })();
      return initializing;
    }
    if (!runtime || shuttingDown) throw new Error("The motion worker is not available. Reload while stopped.");
    if (message.type === "choose") {
      selectedIdentity = message.identity;
      return runtime.choosePort();
    }
    if (message.type === "auto_connect") return runtime.autoConnect();
    if (message.type === "close") {
      shuttingDown = true;
      try {
        await runtime.close();
        const state = runtime.state(), hardware = state.hardware;
        if (state.unconfirmed_stop || hardware?.owned || hardware?.connected
            || (hardware && hardware.stop_confirmed !== true)) {
          throw new Error("Worker shutdown cannot confirm stopped and closed motor output. Use the physical stop.");
        }
        return { closed: true, state };
      } catch (error) { shuttingDown = false; throw error; }
    }
    if (message.type !== "request") throw new Error("Unknown motion worker message.");
    if (message.path === "/api/action" && message.payload?.action === "connect") {
      const ports = (await runtime.request("/api/ports")).ports;
      if (requestedEpoch !== bridgeEpoch) throw new Error("Connection was cancelled by Stop. Connect again explicitly.");
      const selected = ports.find(port => port.device === message.payload.port);
      if (!selected || !selected.identity || selected.identity === "{}"
          || ports.filter(port => port.identity === selected.identity).length !== 1) {
        throw new Error("The selected adapter is unavailable or ambiguous. Connect only one matching adapter.");
      }
    }
    // Do not serialize the message handler: Stop must fence an in-flight
    // Home/Play immediately through the runtime's own epoch machinery.
    const value = await runtime.request(message.path, message.payload);
    return message.path === "/api/motion-diagnostics" ? { ...value, execution_context: "dedicated_worker" } : value;
  }
  addEventListener("message", event => {
    const message = event.data;
    if (!message || !Number.isSafeInteger(message.id) || message.id < 1) return;
    if (message.type === "close" || message.type === "request" && message.path === "/api/action"
        && ["stop", "home_cancel"].includes(message.payload?.action)) bridgeEpoch++;
    const requestedEpoch = bridgeEpoch;
    Promise.resolve().then(() => handle(message, requestedEpoch)).then(
      value => postMessage({ id: message.id, ok: true, value }),
      error => postMessage({ id: message.id, ok: false, error: String(error.message || error), name: error.name || "Error" }),
    );
  });
})();
