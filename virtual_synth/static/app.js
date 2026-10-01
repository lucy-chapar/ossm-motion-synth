/* SPDX-License-Identifier: MPL-2.0 */
"use strict";

(() => {
  const browserRuntime = globalThis.MotionBrowserRuntime || null;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const COLORS = { lfo: "#7bdccb", envelope: "#efba74" };
  const LABELS = { lfo: "LFO", envelope: "Envelope", rate: "Rate", stroke: "Stroke", center: "Center", position: "Position" };
  const LOG_RANGES = { rate_hz: [0.02, 4], lfo_rate_hz: [0.01, 4], attack_s: [0.02, 10], release_s: [0.02, 10] };
  const PERCENT = new Set(["stroke", "center", "lower", "upper"]);
  const DEFAULTS = { rate_hz: 0.25, stroke: 0.7, center: 0.5, shape: "sine", attack_s: 0.8, release_s: 1.2, env_to_stroke: false, lfo_rate_hz: 0.07, lower: 0.1, upper: 0.9, patches: [] };
  const PRESETS = {
    slow: { ...DEFAULTS, patches: [] },
    breathe: { ...DEFAULTS, rate_hz: 0.15, stroke: 0.62, lfo_rate_hz: 0.035, patches: [{ source: "lfo", target: "stroke", depth: 0.3 }] },
    drift: { ...DEFAULTS, rate_hz: 0.23, stroke: 0.35, lfo_rate_hz: 0.04, patches: [{ source: "lfo", target: "center", depth: 0.3 }, { source: "lfo", target: "rate", depth: 0.22 }] },
    gesture: { ...DEFAULTS, rate_hz: 0.45, stroke: 0.7, attack_s: 1.5, release_s: 2.5, env_to_stroke: true, patches: [{ source: "envelope", target: "rate", depth: 0.18 }] },
  };
  let token = null, state = null, online = false, stopped = false;
  let selectedSource = null, selectedPreset = "slow", patchSignature = "";
  let pendingParams = {}, configureTimer = null, actionChain = Promise.resolve();
  let configureResult = Promise.resolve(true), configurationRejected = false;
  let pollBusy = false, heartbeatBusy = false, rendering = false, noticeTimer = null;
  let scopeWidth = 0, scopeHeight = 0, pixelRatio = 1;
  let lastSuccessfulRequest = 0, lastStateReceipt = 0, motionEpoch = 0;
  let connecting = false, homeCancelledByTab = false;
  const canvas = $("scope"), ctx = canvas.getContext("2d");
  const paramInputs = Array.from(document.querySelectorAll("[data-param]"));
  const audioPreview = (() => {
    try {
      if (globalThis.MotionAudio) return new globalThis.MotionAudio.Preview();
    } catch (_) { /* Optional sound must never prevent the controls from loading. */ }
    return { enabled: false, disable() {}, update() { return { gain: 0 }; },
      async enable() { throw new Error("Audio preview did not load. Reload to try again."); } };
  })();
  let audioMessage = "", audioStarting = false;

  function finite(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
  function clamp(value, low = 0, high = 1) { return Math.min(high, Math.max(low, value)); }
  function format(value, places = 2) { return finite(value).toFixed(places); }
  function isHardware() { return state && state.mode === "hardware"; }
  function isHoming() { return Boolean(state && state.homing && state.homing.active); }
  function currentParams() { return { ...DEFAULTS, ...(state ? state.params : {}), ...pendingParams }; }
  function report(message, error = false) {
    clearTimeout(noticeTimer);
    $("notice").textContent = String(message);
    $("notice").classList.toggle("error", error);
    $("notice").hidden = false;
    if (!error) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 6500);
  }

  async function api(path, payload) {
    if (browserRuntime) {
      const result = await browserRuntime.request(path, payload);
      lastSuccessfulRequest = performance.now();
      return result;
    }
    const options = { cache: "no-store" };
    if (payload !== undefined) {
      if (!token) throw new Error("The local session is not ready. Wait for the connection to recover.");
      options.method = "POST";
      options.headers = { "Content-Type": "application/json", "X-Synth-Token": token };
      options.body = JSON.stringify(payload);
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    options.signal = abort.signal;
    try {
      const response = await fetch(path, options);
      let value;
      try { value = await response.json(); }
      catch (_) { throw new Error("The local app returned an unreadable response."); }
      if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : `Request failed (${response.status}).`);
      lastSuccessfulRequest = performance.now();
      return value;
    } finally { clearTimeout(timer); }
  }

  function acceptState(value) {
    const next = value && value.state ? value.state : value;
    if (!next || typeof next !== "object" || !["simulation", "hardware"].includes(next.mode) || !next.params) return false;
    state = next;
    lastStateReceipt = performance.now();
    online = true;
    render();
    updateAudio();
    return true;
  }

  function audioOptions() {
    return { mode: $("audio-mode").value, source: $("audio-source").value,
      volume: Number($("audio-volume").value) / 100,
      active: online && !document.hidden && performance.now() - lastStateReceipt <= 500 };
  }

  function muteAudio(message = "") {
    audioPreview.disable();
    audioMessage = message;
    renderAudio();
  }

  function renderAudio(frame = null) {
    const enabled = audioPreview.enabled, wave = $("audio-mode").value === "wave";
    $("audio-toggle").textContent = audioStarting ? "Starting audio…" : enabled ? "Mute audio" : "Enable audio";
    $("audio-toggle").setAttribute("aria-pressed", String(enabled));
    $("audio-toggle").disabled = audioStarting;
    $("audio-source").disabled = wave;
    const positionPatch = Boolean(state && state.signal && state.signal.position_patched);
    $("audio-explanation").textContent = wave
      ? positionPatch ? "A Position cable replaces the main wave. Choose Hear movement to listen to that patch."
        : "Sine sounds smooth; square and saw sound buzzy. Rate is sped up ×1,000 into a tone; stroke and its envelope control loudness. This is before motion limiting."
      : `Pitch rises and falls with the ${$("audio-source").value === "command" ? "planned position" : "requested wave"}. Rate sets the pace; stroke sets how far the pitch travels. A held position sounds like a steady note.`;
    $("audio-status").textContent = audioMessage || (!enabled ? "Muted"
      : state && !state.running ? "Audio ready · Arm, then Run"
      : wave && positionPatch ? "Wave bypassed · choose Hear movement"
      : frame && frame.gain > 0 ? "Listening"
      : "Silent");
  }

  function updateAudio() {
    if (state && (state.fault || state.unconfirmed_stop)) {
      if (audioPreview.enabled || audioStarting) muteAudio("Audio muted · output fault");
      else renderAudio();
      return;
    }
    try { renderAudio(audioPreview.update(state, audioOptions())); }
    catch (_) { muteAudio("Audio unavailable · try enabling it again"); }
  }

  function action(name, details = {}, quiet = false) {
    const epoch = motionEpoch;
    const run = async () => {
      try {
        if (["arm", "run", "home_start", "connect"].includes(name) && epoch !== motionEpoch) return;
        if (name === "home_start") homeCancelledByTab = false;
        const result = await api("/api/action", { action: name, ...details });
        if (!acceptState(result)) await poll();
        if (["connect", "disconnect", "reset", "home_start"].includes(name) && state && !state.fault && !state.unconfirmed_stop) $("notice").hidden = true;
        return result;
      } catch (error) {
        if (!quiet) report(error.name === "AbortError" ? "The local app did not respond. Output state is unknown until feedback returns." : error.message, true);
        throw error;
      }
    };
    const result = actionChain.then(run, run);
    actionChain = result.catch(() => {});
    return result;
  }

  function readInput(input) {
    const key = input.dataset.param;
    if (input.type === "checkbox") return input.checked;
    if (input.tagName === "SELECT") return input.value;
    if (LOG_RANGES[key]) {
      const [low, high] = LOG_RANGES[key];
      return low * Math.pow(high / low, Number(input.value) / 1000);
    }
    return Number(input.value) / (PERCENT.has(key) ? 100 : 1);
  }

  function updateInputLook(input, value) {
    const key = input.dataset.param;
    const output = $("value-" + key);
    if (output) output.textContent = PERCENT.has(key) ? format(value * 100, value * 100 % 1 < 0.01 ? 0 : 1) : format(value, 2);
    if (input.type === "range") {
      const fill = 100 * (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
      input.style.setProperty("--fill", `${clamp(fill, 0, 100)}%`);
      input.setAttribute("aria-valuetext", PERCENT.has(key) ? `${format(value * 100, 1)} percent` : `${format(value, 2)} ${key.endsWith("_hz") ? "hertz" : "seconds"}`);
    }
  }

  function setInput(input, value) {
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (LOG_RANGES[input.dataset.param]) {
      const [low, high] = LOG_RANGES[input.dataset.param];
      input.value = String(Math.round(1000 * Math.log(clamp(value, low, high) / low) / Math.log(high / low)));
    } else input.value = String(PERCENT.has(input.dataset.param) ? value * 100 : value);
    updateInputLook(input, value);
  }

  function queueConfigure(changes, preservePreset = false) {
    if (!preservePreset) { selectedPreset = null; renderPreset(); }
    pendingParams = { ...pendingParams, ...changes };
    clearTimeout(configureTimer);
    configureTimer = setTimeout(flushConfigure, 75);
  }

  function flushConfigure() {
    clearTimeout(configureTimer);
    configureTimer = null;
    const changes = pendingParams;
    if (!Object.keys(changes).length) return configureResult.then(() => !configurationRejected);
    pendingParams = {};
    // The latest promise includes earlier edits through actionChain. Arm/run
    // must wait even when the debounce timer already submitted these changes.
    configureResult = action("configure", { params: changes }).then(() => {
      configurationRejected = false;
      return true;
    }, () => {
      configurationRejected = true;
      if (state) render();
      return false;
    });
    return configureResult;
  }

  function renderPreset() {
    document.querySelectorAll("[data-preset]").forEach((button) => {
      const active = selectedPreset === button.dataset.preset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function shapePath(shape) {
    const paths = {
      sine: "M4 27 C16 27 16 6 39 6 S62 48 76 48 94 6 111 6 134 27 146 27",
      triangle: "M4 27 22 6 58 48 94 6 130 48 146 29",
      saw: "M4 42 47 7 47 47 96 7 96 47 146 7",
      square: "M4 44 18 44 18 9 65 9 65 44 112 44 112 9 146 9",
    };
    $("shape-path").setAttribute("d", paths[shape] || paths.sine);
  }

  function render() {
    if (!state || rendering) return;
    rendering = true;
    const params = currentParams(), signal = state.signal || {};
    const hw = isHardware(), canMove = !hw || state.allow_motion === true;
    $("mode-badge").replaceChildren();
    const dot = document.createElement("span"); dot.className = "status-dot";
    $("mode-badge").append(dot, document.createTextNode(hw ? "HARDWARE" : "SIMULATION"));
    $("mode-badge").classList.toggle("hardware", hw);
    $("connection-indicator").textContent = browserRuntime ? hw ? "USB–RS485 connected" : "Running in your browser" : online ? "Local app connected" : "Local app disconnected";
    $("scope-corner").textContent = hw ? "HARDWARE · ENCODER WHEN AVAILABLE" : "SIMULATED OUTPUT";
    const runningLabel = state.stopping ? "STOPPING" : state.unconfirmed_stop ? "STOP UNCONFIRMED" : state.fault ? "FAULT" : isHoming() ? "HOMING" : state.running ? "RUNNING" : state.armed ? "ARMED" : "STOPPED";
    $("run-status").replaceChildren();
    const runDot = document.createElement("span"); runDot.className = "status-dot";
    $("run-status").append(runDot, document.createTextNode(runningLabel));
    $("run-status").classList.toggle("running", Boolean(state.running));
    $("run-status").classList.toggle("armed", Boolean(state.armed && !state.running));
    $("arm-button").disabled = !online || isHoming() || !canMove || (hw && !state.homing?.valid) || Boolean(state.armed) || Boolean(state.fault || state.unconfirmed_stop);
    $("arm-button").setAttribute("aria-pressed", String(Boolean(state.armed)));
    $("run-button").disabled = !online || !canMove || !state.armed || Boolean(state.running) || Boolean(state.fault || state.unconfirmed_stop);
    $("stop-button").disabled = !token;
    $("gate-button").disabled = !online || isHoming();
    $("gate-button").setAttribute("aria-pressed", String(Boolean(state.gate)));
    $("fault-notice").hidden = !(state.fault || state.unconfirmed_stop);
    $("fault-text").textContent = state.unconfirmed_stop ? "Motor stop is unconfirmed. The software stop is not an emergency stop; use the independent physical stop or power isolation." : state.fault || "";
    $("reset-button").disabled = !online || isHoming() || Boolean(state.running || state.unconfirmed_stop);
    $("scope-empty").hidden = Boolean(state.running || (state.history && state.history.length > 1));
    $("actual-legend").hidden = !hw || !(state.history || []).some((sample) => Number.isFinite(sample.actual));
    $("transport-message").textContent = hw ? state.running ? "Hardware running · Stop output to finish" : canMove ? state.homing?.valid ? "Motor homed · Arm, then Run" : "Motor connected · Home before arming" : "Read-only connection · motion locked" : state.running ? "Simulated motion · no motor commands" : "Simulation · no motor connected";
    for (const input of paramInputs) {
      const key = input.dataset.param;
      if (document.activeElement !== input && !(key in pendingParams)) setInput(input, params[key]);
      input.disabled = !online || isHoming() || ((key === "lower" || key === "upper") && Boolean(state.armed || state.running));
    }
    $("limits-lock").hidden = !(state.armed || state.running);
    $("limits-lock").textContent = "Limits locked while armed";
    $("lower-label").textContent = `${format(params.lower * 100, 0)}% lower limit`;
    $("upper-label").textContent = `${format(params.upper * 100, 0)}% upper limit`;
    $("travel-window").style.left = `${clamp(params.lower) * 100}%`;
    $("travel-window").style.right = `${(1 - clamp(params.upper)) * 100}%`;
    const command = clamp(finite(signal.command, 0.5));
    const requested = clamp(finite(signal.requested, 0.5));
    $("carriage").style.left = `${command * 100}%`;
    $("carriage-requested").style.left = `${requested * 100}%`;
    $("carriage-readout").replaceChildren(document.createTextNode(format(command * 100, 1)));
    const percent = document.createElement("span"); percent.textContent = "%"; $("carriage-readout").append(percent);
    $("carriage-track").setAttribute("aria-label", `Command position ${format(command * 100, 1)} percent`);
    $("limiter-status").textContent = signal.limited ? "COMMAND LIMITED" : "COMMAND IN RANGE";
    $("limiter-status").classList.toggle("limited", Boolean(signal.limited));
    $("lfo-value").textContent = `${finite(signal.lfo) >= 0 ? "+" : ""}${format(finite(signal.lfo) * 5, 2)} V eq.`;
    $("lfo-value").title = "Virtual ±5 V equivalent signal; no electrical output";
    $("envelope-value").textContent = `${format(clamp(finite(signal.envelope)) * 5, 2)} V eq.`;
    $("envelope-value").title = "Virtual 0–5 V equivalent envelope; no electrical output";
    shapePath(params.shape);
    renderPatches(params.patches || []);
    document.querySelectorAll("[data-preset], [data-source], [data-target], .patch-card button, .patch-card input").forEach((control) => {
      control.disabled = !online || isHoming();
    });
    renderHardware();
    renderHoming();
    if (state.stopping) {
      for (const id of ["home-button", "arm-button", "run-button", "connect-button", "disconnect-button", "reset-button"]) $(id).disabled = true;
      $("transport-message").textContent = "Stopping motor · waiting for feedback";
    }
    const lastSample = (state.history || [])[Math.max(0, (state.history || []).length - 1)];
    const lastActual = hw && lastSample && Number.isFinite(lastSample.actual) ? lastSample : null;
    $("carriage-actual").hidden = !lastActual;
    if (lastActual) $("carriage-actual").style.left = `${clamp(lastActual.actual) * 100}%`;
    rendering = false;
    drawScope();
  }

  function renderHardware() {
    const connected = isHardware(), hardware = state.hardware || {};
    const canSelectPort = browserRuntime ? browserRuntime.supported : Boolean($("port-select").value);
    $("connect-button").disabled = !online || connecting || isHoming() || connected || !canSelectPort || Boolean(state.armed || state.running || state.stopping);
    $("connect-button").textContent = connecting ? "Connecting…" : "Connect";
    $("connect-button").setAttribute("aria-busy", String(connecting));
    $("disconnect-button").disabled = !online || !connected || isHoming();
    $("port-select").disabled = connecting || connected || Boolean(state.armed || state.running);
    if (browserRuntime) $("refresh-ports").disabled = !browserRuntime.supported || connecting || connected || Boolean(state.armed || state.running || state.stopping);
    $("hardware-metrics").hidden = !connected;
    $("hardware-status").textContent = connected ? `${hardware.port ? `Connected: ${hardware.port}` : hardware.device ? `Connected: ${hardware.device}` : "Connected to motor interface."}${hardware.notice ? ` ${hardware.notice}` : ""}` : "No motor connected.";
    $("encoder-raw").textContent = Number.isFinite(hardware.position_raw) ? `${hardware.position_raw} counts` : "No feedback";
    $("current-raw").textContent = Number.isFinite(hardware.current_raw) ? `${hardware.current_raw} raw` : "No feedback";
    const confirmed = hardware.stop_confirmed === true
      && hardware.output_enabled === false
      && hardware.pending_raw === 0 && hardware.pwm_raw === 0
      && hardware.owned === false && hardware.running === false
      && !hardware.fault && !state.fault && !state.running && !state.unconfirmed_stop;
    $("stop-confirmed").textContent = confirmed ? "Confirmed" : "Unconfirmed";
    $("stop-confirmed").classList.toggle("unconfirmed", !confirmed);
    $("hardware-boundary").textContent = state.allow_motion ? "Ready for hardware: Connect → Home → Arm → Run. Connect only reads status; Home moves the motor." : "Launch ./synth --allow-motion for hardware Home and Run. Connecting here reads status only.";
    $("hardware-boundary").classList.toggle("motion-enabled", Boolean(state.allow_motion));
    if (browserRuntime) {
      $("hardware-boundary").textContent = browserRuntime.supported
        ? "Connect → Home → Arm → Run. Connect lets you choose your USB–RS485 adapter. Everything runs in this browser."
        : "Direct USB connection needs desktop Chrome or Edge with Web Serial. Wave shaping and audio still work here.";
      if (!browserRuntime.supported) $("hardware-status").textContent = "Web Serial is unavailable in this browser.";
    }
  }

  function renderHoming() {
    const active = isHoming();
    const connected = isHardware() && state.hardware?.connected === true;
    $("home-button").disabled = !online || !connected || !state.allow_motion || active
      || Boolean(state.armed || state.running || state.fault || state.unconfirmed_stop);
    $("home-button").textContent = active ? "Homing…" : "Home";
    $("home-button").setAttribute("aria-busy", String(active));
    if (active) {
      const phase = String(state.homing.phase || "");
      const message = phase.includes("centering") || phase.includes("center") ? "Parking at center"
        : phase.includes("second_retreat") ? "Backing away from second end"
        : phase.includes("second_") ? "Finding second end"
        : phase.includes("first_retreat") ? "Backing away from first end"
        : phase.includes("first_") ? "Finding first end"
        : phase === "seeking" ? "Finding reference" : "Preparing motor";
      $("transport-message").textContent = `${message} · Stop output to cancel`;
    } else if (connected && state.homing?.phase === "cancelled" && homeCancelledByTab) {
      $("transport-message").textContent = "Home cancelled because the tab was left · Keep this tab visible and press Home again";
    } else if (connected && state.homing?.valid && !state.running && !state.armed && !state.fault) {
      const distance = state.hardware.measured_travel_raw;
      const scale = state.hardware.nominal_counts_per_mm;
      const travel = Number.isFinite(distance) && Number.isFinite(scale) && scale > 0
        ? `Travel ≈ ${format(distance / scale, 1)} mm · ` : "";
      const centered = Number.isFinite(state.hardware.origin_raw) && Number.isFinite(state.hardware.position_raw)
        && Math.abs(state.hardware.position_raw - state.hardware.origin_raw) <= 16;
      $("transport-message").textContent = `${travel}${centered ? "Centered" : "Homed"} · Arm, then Run`;
    }
  }

  function renderPatches(patches) {
    $("patch-count").textContent = `${patches.length} / 4`;
    document.querySelectorAll("[data-mod]").forEach((indicator) => {
      indicator.classList.toggle("active", patches.some((patch) => patch.target === indicator.dataset.mod) || (indicator.dataset.mod === "stroke" && currentParams().env_to_stroke));
    });
    document.querySelectorAll("[data-target]").forEach((button) => button.classList.toggle("connected", patches.some((patch) => patch.target === button.dataset.target)));
    const signature = JSON.stringify(patches.map((patch) => [patch.source, patch.target]));
    if (signature !== patchSignature) {
      patchSignature = signature;
      $("patch-list").replaceChildren();
      if (!patches.length) {
        const empty = document.createElement("div"); empty.className = "empty-patches";
        empty.append(document.createTextNode("No cables yet."));
        const hint = document.createElement("span"); hint.textContent = "Try LFO → Center for a drifting wave."; empty.append(hint); $("patch-list").append(empty);
      }
      for (const patch of patches) {
        const card = document.createElement("div"); card.className = "patch-card"; card.dataset.patchTarget = patch.target;
        const heading = document.createElement("div"); heading.className = "patch-card-heading";
        const name = document.createElement("span"); name.className = "patch-card-name";
        const swatch = document.createElement("i"); swatch.className = "cable-swatch"; swatch.style.background = COLORS[patch.source] || COLORS.lfo;
        name.append(swatch, document.createTextNode(`${LABELS[patch.source] || patch.source} → ${LABELS[patch.target] || patch.target}`));
        const remove = document.createElement("button"); remove.className = "remove-patch"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${LABELS[patch.source]} to ${LABELS[patch.target]} cable`);
        remove.addEventListener("click", () => updatePatches(currentParams().patches.filter((item) => item.target !== patch.target)));
        heading.append(name, remove);
        const depth = document.createElement("div"); depth.className = "patch-depth";
        const label = document.createElement("label"); label.textContent = "DEPTH"; label.htmlFor = `depth-${patch.target}`;
        const slider = document.createElement("input"); slider.type = "range"; slider.min = "-1"; slider.max = "1"; slider.step = "0.01"; slider.id = `depth-${patch.target}`; slider.value = String(patch.depth);
        slider.setAttribute("aria-label", `${LABELS[patch.source]} to ${LABELS[patch.target]} modulation depth`);
        const output = document.createElement("output"); output.htmlFor = slider.id;
        slider.addEventListener("input", () => {
          const value = Number(slider.value);
          output.textContent = `${value >= 0 ? "+" : ""}${format(value, 2)}`;
          slider.style.setProperty("--fill", `${(value + 1) * 50}%`);
          updatePatches(currentParams().patches.map((item) => item.target === patch.target ? { ...item, depth: value } : item));
        });
        depth.append(label, slider, output); card.append(heading, depth); $("patch-list").append(card);
      }
    }
    for (const patch of patches) {
      const card = Array.from($("patch-list").children).find((item) => item.dataset.patchTarget === patch.target);
      if (!card) continue;
      const slider = card.querySelector("input"), output = card.querySelector("output");
      if (document.activeElement !== slider && !("patches" in pendingParams)) slider.value = String(patch.depth);
      const depth = Number(slider.value);
      slider.style.setProperty("--fill", `${(depth + 1) * 50}%`);
      output.textContent = `${depth >= 0 ? "+" : ""}${format(depth, 2)}`;
    }
    requestAnimationFrame(drawCables);
  }

  function updatePatches(patches) {
    queueConfigure({ patches });
    renderPatches(patches);
  }

  function drawCables() {
    const bay = $("patch-bay"), svg = $("patch-cables"), bounds = bay.getBoundingClientRect();
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    for (const [index, patch] of (currentParams().patches || []).entries()) {
      const source = Array.from(document.querySelectorAll("[data-source]")).find((el) => el.dataset.source === patch.source);
      const target = Array.from(document.querySelectorAll("[data-target]")).find((el) => el.dataset.target === patch.target);
      if (!source || !target) continue;
      const a = source.querySelector(".jack").getBoundingClientRect(), b = target.querySelector(".jack").getBoundingClientRect();
      const x1 = a.left + a.width / 2 - bounds.left, y1 = a.top + a.height / 2 - bounds.top;
      const x2 = b.left + b.width / 2 - bounds.left, y2 = b.top + b.height / 2 - bounds.top;
      const sag = 20 + index * 7;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 30} ${y1 + sag}, ${x2 - 30} ${y2 + sag}, ${x2} ${y2}`);
      path.setAttribute("stroke", COLORS[patch.source] || COLORS.lfo); path.setAttribute("stroke-width", "2.5"); path.setAttribute("opacity", "0.85"); svg.append(path);
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        const plug = document.createElementNS(SVG_NS, "circle"); plug.setAttribute("cx", String(x)); plug.setAttribute("cy", String(y)); plug.setAttribute("r", "3"); plug.setAttribute("fill", COLORS[patch.source] || COLORS.lfo); svg.append(plug);
      }
    }
  }

  function resizeScope() {
    const bounds = canvas.getBoundingClientRect();
    scopeWidth = Math.max(1, bounds.width); scopeHeight = Math.max(1, bounds.height); pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(scopeWidth * pixelRatio); canvas.height = Math.round(scopeHeight * pixelRatio);
    drawScope(); drawCables();
  }

  function drawScope() {
    if (!ctx || !scopeWidth) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, scopeWidth, scopeHeight);
    const left = 38, right = scopeWidth - 12, top = 22, bottom = scopeHeight - 17;
    const y = (value) => bottom - clamp(value) * (bottom - top);
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      ctx.strokeStyle = i === 5 ? "#31453d" : "#25342e";
      ctx.beginPath(); ctx.moveTo(left, top + (bottom - top) * i / 10); ctx.lineTo(right, top + (bottom - top) * i / 10); ctx.stroke();
      ctx.strokeStyle = "#25342e"; ctx.beginPath(); ctx.moveTo(left + (right - left) * i / 10, top); ctx.lineTo(left + (right - left) * i / 10, bottom); ctx.stroke();
    }
    const params = currentParams();
    ctx.fillStyle = "#d0aa6809"; ctx.fillRect(left, top, right - left, y(params.upper) - top); ctx.fillRect(left, y(params.lower), right - left, bottom - y(params.lower));
    ctx.setLineDash([3, 5]); ctx.strokeStyle = "#b18e5540";
    for (const limit of [params.lower, params.upper]) { ctx.beginPath(); ctx.moveTo(left, y(limit)); ctx.lineTo(right, y(limit)); ctx.stroke(); }
    ctx.setLineDash([]);
    const history = state && Array.isArray(state.history) ? state.history.filter((p) => Number.isFinite(p.t)) : [];
    if (!history.length) return;
    const end = history[history.length - 1].t, start = end - 10;
    const samples = history.filter((sample) => sample.t >= start);
    const x = (t) => left + clamp((t - start) / 10) * (right - left);
    const trace = (key, color, width) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
      let begun = false;
      for (const sample of samples) {
        if (!Number.isFinite(sample[key])) { begun = false; continue; }
        if (!begun) { ctx.moveTo(x(sample.t), y(sample[key])); begun = true; }
        else ctx.lineTo(x(sample.t), y(sample[key]));
      }
      ctx.stroke();
    };
    trace("requested", "#7bdccb9c", 1.6);
    trace("command", "#efba74", 2);
    if (isHardware()) trace("actual", "#b3d697", 1.6);
    const latest = samples[samples.length - 1];
    if (latest && Number.isFinite(latest.command)) { ctx.beginPath(); ctx.arc(x(latest.t), y(latest.command), 3, 0, Math.PI * 2); ctx.fillStyle = "#efba74"; ctx.fill(); }
  }

  async function poll() {
    if (pollBusy || stopped) return;
    pollBusy = true;
    try { acceptState(await api("/api/state")); }
    catch (_) {
      // A working heartbeat endpoint must not lease a UI that has lost state feedback.
      online = false;
      if (audioPreview.enabled || audioStarting) muteAudio("Audio muted · connection lost");
      if (performance.now() - lastStateReceipt > 1500) {
        $("connection-indicator").textContent = browserRuntime ? "Browser controller unavailable" : "Local app disconnected";
        $("transport-message").textContent = "Connection lost · output state unconfirmed";
        $("home-button").disabled = true; $("arm-button").disabled = true; $("run-button").disabled = true;
      }
    } finally { pollBusy = false; }
  }

  async function heartbeat() {
    if (heartbeatBusy || document.hidden || !online || !token || !state || performance.now() - lastStateReceipt > 500 || !(state.armed || state.running || isHoming())) return;
    heartbeatBusy = true;
    try { await api("/api/action", { action: "heartbeat" }); }
    catch (_) { online = false; /* The server's watchdog owns motion on heartbeat loss. */ }
    finally { heartbeatBusy = false; }
  }

  async function refreshPorts() {
    $("refresh-ports").disabled = true;
    try {
      const result = await api("/api/ports"), previous = $("port-select").value;
      $("port-select").replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = result.ports && result.ports.length ? "Select a serial port" : browserRuntime ? "Choose an adapter to grant access" : "No serial ports found"; $("port-select").append(placeholder);
      for (const port of result.ports || []) {
        if (typeof port.device !== "string") continue;
        const option = document.createElement("option"); option.value = port.device; option.textContent = port.description ? `${port.device} · ${port.description}` : port.device; $("port-select").append(option);
      }
      if (Array.from($("port-select").options).some((option) => option.value === previous)) $("port-select").value = previous;
      if (state) renderHardware();
    } catch (error) { report(error.message, true); }
    finally { $("refresh-ports").disabled = false; if (state) renderHardware(); }
  }

  paramInputs.forEach((input) => {
    input.addEventListener(input.type === "range" ? "input" : "change", () => {
      const value = readInput(input); updateInputLook(input, value);
      queueConfigure({ [input.dataset.param]: value });
      if (input.dataset.param === "shape") shapePath(value);
    });
  });
  document.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", async () => {
    const preset = PRESETS[button.dataset.preset];
    const { lower, upper, ...musical } = preset;
    // Presets change the musical patch; they never widen the user's travel window.
    selectedPreset = button.dataset.preset; renderPreset();
    queueConfigure({ ...musical, patches: preset.patches.map((patch) => ({ ...patch })) }, true);
    render();
  }));
  document.querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", () => {
    selectedSource = selectedSource === button.dataset.source ? null : button.dataset.source;
    document.querySelectorAll("[data-source]").forEach((source) => source.setAttribute("aria-pressed", String(source.dataset.source === selectedSource)));
    $("patch-instruction").textContent = selectedSource ? `${LABELS[selectedSource]} selected. Choose a destination.` : "Select a source, then a destination.";
  }));
  document.querySelectorAll("[data-target]").forEach((button) => button.addEventListener("click", () => {
    if (!selectedSource) { report("Select LFO or Envelope first, then choose its destination."); return; }
    const patches = currentParams().patches.filter((patch) => patch.target !== button.dataset.target);
    patches.push({ source: selectedSource, target: button.dataset.target, depth: 0.25 });
    updatePatches(patches);
    if (button.dataset.target === "position") report("Position replaces the main waveform. The envelope-to-stroke toggle is bypassed; command travel and motion limits still apply.");
    selectedSource = null;
    document.querySelectorAll("[data-source]").forEach((source) => source.setAttribute("aria-pressed", "false"));
    $("patch-instruction").textContent = "Cable connected. Adjust its depth below.";
  }));
  async function requestMotion(name) {
    const epoch = motionEpoch;
    if (!await flushConfigure()) {
      report("A control change was rejected. Successfully update a control before arming or running.", true);
      return;
    }
    if (epoch === motionEpoch) action(name).catch(() => {});
  }
  $("arm-button").addEventListener("click", () => requestMotion("arm"));
  $("run-button").addEventListener("click", () => requestMotion("run"));
  $("stop-button").addEventListener("click", () => {
    motionEpoch++;
    muteAudio();
    // Stop bypasses queued edits so network work cannot delay this request.
    api("/api/action", { action: "stop" }).then(acceptState).catch((error) => report(`Stop is unconfirmed: ${error.message}`, true));
  });
  $("stop-button").title = "Software stop. This is not a physical emergency stop.";
  $("home-button").addEventListener("click", async () => {
    const epoch = motionEpoch;
    if (!await flushConfigure() || epoch !== motionEpoch) return;
    muteAudio();
    action("home_start", { control_revision: state.control_revision }).catch(() => {});
  });
  $("gate-button").addEventListener("click", () => action("gate", { value: !Boolean(state && state.gate) }).catch(() => {}));
  $("reset-button").addEventListener("click", () => action("reset").catch(() => {}));
  $("refresh-ports").addEventListener("click", async () => {
    if (!browserRuntime) return refreshPorts();
    try {
      const id = await browserRuntime.choosePort();
      await refreshPorts();
      $("port-select").value = id;
      if (state) renderHardware();
    } catch (error) { if (error.name !== "NotFoundError") report(error.message, true); }
  });
  $("port-select").addEventListener("change", () => { if (state) renderHardware(); });
  $("connect-button").addEventListener("click", async () => {
    if ($("connect-button").disabled || connecting) return;
    const epoch = motionEpoch;
    connecting = true;
    renderHardware();
    try {
      let port = $("port-select").value;
      if (!port && browserRuntime) {
        // Keep the chooser in this click's user activation, before any other await.
        port = await browserRuntime.choosePort();
        if (epoch !== motionEpoch) return;
        await refreshPorts();
        $("port-select").value = port;
      }
      if (!port || epoch !== motionEpoch) return;
      await action("connect", { port }, true);
      $("hardware-details").open = true;
    } catch (error) {
      if (error.name !== "NotFoundError" && epoch === motionEpoch) report(error.message, true);
    } finally {
      connecting = false;
      if (state) renderHardware();
    }
  });
  $("disconnect-button").addEventListener("click", () => action("disconnect").catch(() => {}));
  $("hardware-details").addEventListener("toggle", () => { if ($("hardware-details").open) refreshPorts(); });
  $("audio-toggle").addEventListener("click", async () => {
    if (audioPreview.enabled) { muteAudio(); return; }
    audioStarting = true;
    audioMessage = "";
    renderAudio();
    try {
      await audioPreview.enable();
      if (document.hidden || !online || performance.now() - lastStateReceipt > 500) {
        muteAudio("Audio muted · waiting for live feedback");
      } else updateAudio();
    } catch (error) {
      muteAudio(error.message || "Audio is unavailable in this browser.");
    } finally { audioStarting = false; updateAudio(); }
  });
  $("audio-mode").addEventListener("change", updateAudio);
  $("audio-source").addEventListener("change", updateAudio);
  $("audio-volume").addEventListener("input", () => {
    const value = $("audio-volume").value;
    $("audio-volume-value").textContent = `${value}%`;
    $("audio-volume").setAttribute("aria-valuetext", `${value} percent`);
    $("audio-volume").style.setProperty("--fill", `${value}%`);
    updateAudio();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      homeCancelledByTab ||= isHoming();
      muteAudio("Audio muted · tab left");
      if (browserRuntime) { motionEpoch++; browserRuntime.stop().then(acceptState).catch(() => {}); }
    }
    else poll();
  });
  window.addEventListener("pagehide", () => {
    stopped = true;
    motionEpoch++;
    muteAudio();
    if (browserRuntime) browserRuntime.stop().catch(() => {});
    else if (token) fetch("/api/action", { method: "POST", headers: { "Content-Type": "application/json", "X-Synth-Token": token }, body: JSON.stringify({ action: "stop" }), keepalive: true }).catch(() => {});
  });
  window.addEventListener("pageshow", () => { stopped = false; poll(); });
  new ResizeObserver(resizeScope).observe(canvas.parentElement);
  new ResizeObserver(drawCables).observe($("patch-bay"));
  renderPreset();
  renderAudio();
  if (browserRuntime) {
    $("refresh-ports").textContent = "Choose adapter";
    $("refresh-ports").dataset.tooltip = "Open the browser's serial-device chooser. Choosing an adapter grants this page access; Connect reads motor status without moving it.";
    $("port-select").dataset.tooltip = "Select an adapter you have allowed this website to access. Choose adapter opens the browser permission dialog.";
    $("connect-button").dataset.tooltip = "Choose your USB–RS485 adapter and connect to the motor at 19200 baud. If an adapter is already selected, connect to it directly. Then Home → Arm → Run.";
    document.querySelector("#hardware-details .panel-description").textContent = "Connect directly to your USB–RS485 adapter through Web Serial.";
    document.querySelector("footer span").lastChild.textContent = "RUNS IN YOUR BROWSER · NO INSTALL REQUIRED";
  }
  try { globalThis.MotionTooltips?.install(); }
  catch (_) { /* Hover help is optional; motion controls must remain available. */ }
  for (const input of paramInputs) setInput(input, DEFAULTS[input.dataset.param]);
  resizeScope();
  async function initialize() {
    try {
      const session = await api("/api/session");
      if (typeof session.token !== "string" || !session.token) throw new Error("The local app did not provide a session token.");
      token = session.token;
      await poll();
    } catch (error) {
      report(browserRuntime ? `Cannot start the browser synth: ${error.message}` : "Cannot connect to the local synth app. Keep this page open and check that the server is running.", true);
      setTimeout(initialize, 2000);
    }
  }
  initialize();
  setInterval(poll, 100);
  setInterval(heartbeat, 250);
  setInterval(() => {
    if ((audioPreview.enabled || audioStarting) && performance.now() - lastStateReceipt > 500) {
      muteAudio("Audio muted · feedback expired");
    }
  }, 100);
})();
