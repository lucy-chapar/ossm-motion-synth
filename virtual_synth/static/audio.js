/* SPDX-License-Identifier: MPL-2.0 */
"use strict";

/* Browser-only sonification. No network, serial, or motion-control operations. */
((root) => {
  const MAX_GAIN = 0.15;
  const SHAPES = { sine: "sine", triangle: "triangle", saw: "sawtooth", square: "square" };
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const unit = (value) => finite(value) && value >= 0 && value <= 1;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const silent = (reason) => ({ frequency: 0, gain: 0, type: "sine", reason });

  function mapAudio(state, options = {}) {
    if (!options || options.active !== true) return silent("inactive");
    if (!state || typeof state !== "object") return silent("invalid-data");
    if (state.fault || state.unconfirmed_stop) return silent("fault");
    if (state.running !== true) return silent("not-running");
    if (!finite(options.volume)) return silent("invalid-data");
    const volume = clamp(options.volume, 0, 1);
    const signal = state.signal;
    if (!signal || typeof signal !== "object") return silent("invalid-data");
    if (options.mode === "motion") {
      if (options.source !== "command" && options.source !== "requested") return silent("invalid-data");
      const position = signal[options.source];
      if (!unit(position)) return silent("invalid-data");
      // Actual motion timing is preserved; travel becomes a two-octave pitch span.
      return { frequency: 110 * 2 ** (2 * position), gain: MAX_GAIN * volume,
        type: "sine", reason: "ready" };
    }
    if (options.mode !== "wave") return silent("invalid-data");
    const params = state.params;
    if (!params || typeof params !== "object" || !Array.isArray(params.patches)) return silent("invalid-data");
    // Never play the bypassed carrier as though it were the patched position.
    if (signal.position_patched === true || params.patches.some((patch) => patch && patch.target === "position")) {
      return silent("position-patched");
    }
    const { effective_rate_hz: rate, effective_stroke: stroke, effective_center: center } = signal;
    if (!finite(rate) || rate < 0.02 || rate > 4 || !unit(stroke) || !unit(center)
        || !unit(params.lower) || !unit(params.upper) || params.lower >= params.upper
        || !Object.prototype.hasOwnProperty.call(SHAPES, params.shape)) return silent("invalid-data");
    // effective_stroke already includes the implicit attack/release multiplier.
    const span = stroke * (params.upper - params.lower) * 2 * Math.min(center, 1 - center);
    return { frequency: clamp(1000 * rate, 20, 4000),
      gain: clamp(MAX_GAIN * volume * span, 0, MAX_GAIN), type: SHAPES[params.shape], reason: "ready" };
  }

  class Preview {
    constructor(contextFactory) {
      this.enabled = false;
      this._factory = contextFactory || (() => {
        const Context = root.AudioContext || root.webkitAudioContext;
        if (!Context) throw new Error("Audio preview is unavailable in this browser.");
        return new Context();
      });
      this._generation = 0;
      this._pending = null;
      this._context = this._oscillator = this._gain = null;
    }

    async enable() {
      if (this.enabled && this._context && this._context.state === "running") return true;
      if (this._pending) return this._pending;
      if (this._context) this.disable();
      const generation = ++this._generation;
      const pending = this._enable(generation);
      this._pending = pending;
      try { return await pending; }
      finally { if (generation === this._generation) this._pending = null; }
    }

    async _enable(generation) {
      let context;
      try {
        context = this._factory();
        this._context = context;
        const gain = context.createGain();
        this._gain = gain;
        gain.gain.value = 0;
        const oscillator = context.createOscillator();
        this._oscillator = oscillator;
        oscillator.type = "sine";
        oscillator.frequency.value = 220;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        await context.resume();
        // A Stop/disable during resume must not bring an old audio graph back.
        if (generation !== this._generation) return false;
        if (context.state !== "running") throw new Error("Audio preview could not start. Try Listen again.");
        this.enabled = true;
        return true;
      } catch (error) {
        if (generation !== this._generation) return false;
        this.enabled = false;
        this._dispose();
        throw error;
      }
    }

    _hold(param, now) {
      if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
      else {
        const current = finite(param.value) ? clamp(param.value, 0, MAX_GAIN) : 0;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
    }

    silence() {
      if (!this._context || !this._gain) return;
      try {
        const now = this._context.currentTime;
        if (!finite(now)) throw new Error("Invalid audio clock");
        this._hold(this._gain.gain, now);
        this._gain.gain.linearRampToValueAtTime(0, now + 0.01);
      } catch (_) {
        // An audio failure cannot leave the last tone running.
        this.disable();
      }
    }

    disable() {
      this.enabled = false;
      ++this._generation;
      this._pending = null;
      this._dispose();
    }

    _dispose() {
      const context = this._context, oscillator = this._oscillator, gain = this._gain;
      this._context = this._oscillator = this._gain = null;
      if (gain) {
        try {
          const now = context && finite(context.currentTime) ? context.currentTime : 0;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(0, now);
        } catch (_) { /* Disconnecting below still removes the audible path. */ }
        try { gain.disconnect(); } catch (_) { /* Already disconnected. */ }
      }
      if (oscillator) {
        try { oscillator.stop(); } catch (_) { /* Already stopped or never started. */ }
        try { oscillator.disconnect(); } catch (_) { /* Already disconnected. */ }
      }
      if (context && typeof context.close === "function") {
        try { Promise.resolve(context.close()).catch(() => {}); } catch (_) { /* Graph already disconnected. */ }
      }
    }

    update(state, options) {
      const mapped = mapAudio(state, options);
      if (!this.enabled) return silent("inactive");
      if (!this._context || this._context.state !== "running") {
        this.disable();
        return silent("audio-unavailable");
      }
      if (mapped.gain === 0) {
        this.silence();
        return mapped;
      }
      try {
        const now = this._context.currentTime;
        if (!finite(now)) throw new Error("Invalid audio clock");
        this._oscillator.type = mapped.type;
        this._oscillator.frequency.cancelScheduledValues(now);
        this._oscillator.frequency.setTargetAtTime(mapped.frequency, now, 0.015);
        const gain = this._gain.gain;
        this._hold(gain, now);
        gain.linearRampToValueAtTime(mapped.gain, now + 0.012);
        // This expiry runs on the audio clock even if UI/JS stops receiving data.
        gain.setValueAtTime(mapped.gain, now + 0.35);
        gain.linearRampToValueAtTime(0, now + 0.4);
        return mapped;
      } catch (_) {
        this.disable();
        return silent("audio-unavailable");
      }
    }
  }

  const api = { Preview, mapAudio };
  root.MotionAudio = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
