/* SPDX-License-Identifier: MPL-2.0 */
"use strict";

(() => {
  if (globalThis.MotionTooltips) return;

  const TOOLTIP_ID = "motion-control-tooltip";
  const CONTROL_SELECTOR = "button, input, select, summary, a.brand, [data-tooltip], #patch-cables path";
  const PRESETS = {
    slow: "Load a steady, slow sine wave. Your travel limits stay unchanged; loading a preset does not start motion.",
    breathe: "Load a slow wave whose stroke expands and contracts with the LFO. Your travel limits stay unchanged.",
    drift: "Load a small wave with LFO modulation of its center and rate. Your travel limits stay unchanged.",
    gesture: "Load an envelope-shaped gesture. Turn Gate on to build the stroke, then off to release it. Arm and Run separately.",
  };
  const PARAMS = {
    rate_hz: "Set the base movement speed in cycles per second. At 1 Hz, the wave repeats once per second. The planned motion may be slower when limited.",
    stroke: "Set the wave's span around Center, as a percentage of the available room inside the travel window. Zero stroke requests the center position.",
    center: "Move the wave's midpoint within the travel window. A center near either edge leaves less room for the stroke.",
    shape: "Choose the base movement waveform. Sharp corners and jumps are softened by the motion limits; a Position patch replaces this waveform.",
    lfo_rate_hz: "Set how quickly the low-frequency oscillator repeats. Patch this source into a destination to create a repeating change in the movement.",
    attack_s: "Set the time for the envelope to rise from zero to full level after Gate turns on.",
    release_s: "Set the time for the envelope to fall from full level to zero after Gate turns off.",
    env_to_stroke: "Use the envelope to scale the stroke. Gate builds it up and releases it. A direct Position patch bypasses this toggle.",
    lower: "Set the lower boundary for requested and planned positions. Stop and disarm before changing it. This is a command limit, not a physical end stop.",
    upper: "Set the upper boundary for requested and planned positions. Stop and disarm before changing it. This is a command limit, not a physical end stop.",
  };
  const SOURCES = {
    lfo: "Select the repeating LFO, then choose a destination. Its virtual signal swings between −5 V and +5 V; there is no electrical voltage output.",
    envelope: "Select the envelope, then choose a destination. Gate controls its rise and fall. Its virtual level is 0–5 V, with no electrical voltage output.",
  };
  const TARGETS = {
    rate: "Patch the selected source into movement rate. Depth sets the amount; a negative depth reverses the modulation. This replaces any cable already here.",
    stroke: "Patch the selected source into stroke size. Depth sets the amount; a negative depth reverses the modulation. This replaces any cable already here.",
    center: "Patch the selected source into the wave's center position. Depth sets the amount; a negative depth reverses it. This replaces any cable already here.",
    position: "Use the selected source in place of the base waveform. Stroke and Center still scale it, but Envelope → Stroke is bypassed. Command limits still apply.",
  };
  const IDS = {
    "arm-button": "Home the connected motor first, then prepare output without starting waveform motion. Run starts the armed motion. Hardware arming requires motion access and no unresolved fault.",
    "run-button": "Start the currently armed motion. Simulation moves only the preview; a permitted hardware session sends motor commands. Arm must succeed first.",
    "stop-button": "Request a stop and disarm output. This is a software stop, not a physical emergency stop. Check hardware feedback to see whether the stop was confirmed.",
    "gate-button": "Toggle the envelope on or off. On rises at the Attack rate; off falls at the Release rate. Gate does not arm, run, or stop the motor.",
    "reset-button": "Clear a recoverable fault while stopped. This cannot clear an unconfirmed hardware stop or make the mechanism safe to touch.",
    "port-select": "Choose the identified USB–RS485 adapter for your motor. Selecting a port does not connect or start motion.",
    "refresh-ports": "Refresh the list of local serial adapters. This lists ports without opening them or sending motor commands.",
    "connect-button": "Connect to the motor through the selected USB–RS485 adapter. Then Home → Arm → Run to start motion.",
    "disconnect-button": "Close the motor connection and return to simulation. This does not erase an unconfirmed stop; check the displayed status.",
    "audio-toggle": "Turn the browser sound preview on or off. Listening never arms or starts the motor.",
    "audio-mode": "Hear movement makes pitch rise and fall with position. Hear wave shape speeds the wave into a tone: sine is smooth, square and saw are buzzy. Only the sound preview changes.",
    "audio-source": "In Hear movement, compare the requested wave with the limited planned command. Hear wave shape always uses the main oscillator before limits, so this selector is disabled there.",
    "audio-volume": "Set the listening level. This changes speaker volume, not stroke, motor speed, or motor power.",
    "home-button": "Find both ends, measure the rail travel, then park at the center. Connect a motor to enable Home. Stop output cancels homing.",
  };

  let installed = false, tooltip = null, active = null, pending = null;
  let hovered = null, focused = null, suppressed = null, timer = null;
  let lastPointerDown = -Infinity;
  const originalTitles = new WeakMap();
  const cableAnchors = new WeakMap();

  function rememberTitle(element) {
    if (!(element instanceof Element) || !element.hasAttribute("title")) return;
    const value = element.getAttribute("title");
    if (value) originalTitles.set(element, value);
    element.removeAttribute("title");
  }

  function stripTitles(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(CONTROL_SELECTOR)) rememberTitle(root);
    root.querySelectorAll("[title]").forEach((element) => {
      if (element.matches(CONTROL_SELECTOR)) rememberTitle(element);
    });
  }

  function cableText(path) {
    const svg = path.closest("#patch-cables");
    if (!svg) return "";
    const index = Array.from(svg.querySelectorAll("path")).indexOf(path);
    const cards = document.querySelectorAll("#patch-list .patch-card");
    const name = cards[index] && cards[index].querySelector(".patch-card-name");
    const label = name ? name.textContent.trim() : "Modulation cable";
    cableAnchors.set(path, { index, label });
    return `${label}. Adjust its Depth slider below to change the amount or invert it. Use the remove button to disconnect it.`;
  }

  function replacedCable(element) {
    if (!element || element.isConnected) return element;
    const old = cableAnchors.get(element);
    if (!old) return null;
    const replacement = document.querySelectorAll("#patch-cables path")[old.index];
    if (!replacement) return null;
    cableText(replacement);
    return cableAnchors.get(replacement).label === old.label ? replacement : null;
  }

  function helpFor(element) {
    rememberTitle(element);
    if (element.hasAttribute("data-tooltip")) return element.getAttribute("data-tooltip").trim();
    if (IDS[element.id]) return IDS[element.id];
    if (PARAMS[element.dataset.param]) return PARAMS[element.dataset.param];
    if (PRESETS[element.dataset.preset]) return PRESETS[element.dataset.preset];
    if (SOURCES[element.dataset.source]) return SOURCES[element.dataset.source];
    if (TARGETS[element.dataset.target]) return TARGETS[element.dataset.target];
    if (element.matches("a.brand")) return "Return to the instrument's start page. Leaving the current page requests an output stop.";
    if (element.matches("summary") && element.closest("#hardware-details")) return "Show or hide the local motor connection controls. Opening this section does not connect to a motor.";
    if (element.matches("summary") && element.closest("#audio-details")) return "Show or hide the audio preview controls. Collapsing this section keeps your audio settings and does not mute playback.";
    if (element.matches("#patch-cables path")) return cableText(element);
    if (element.matches(".remove-patch")) {
      const label = element.getAttribute("aria-label") || "Remove this cable";
      return `${label}. Disconnecting this modulation does not stop the base movement.`;
    }
    if (element.matches("input[type=range]") && element.closest(".patch-card")) {
      const label = element.getAttribute("aria-label") || "Modulation depth";
      return `${label}. Zero has no effect; positive values add modulation and negative values invert it. Full depth is ±1.`;
    }
    return originalTitles.get(element) || "";
  }

  function findControl(node, point) {
    let element = node instanceof Element ? node : node && node.parentElement;
    if (!element) return null;
    let control = element.closest(CONTROL_SELECTOR);
    if (!control) {
      const label = element.closest("label");
      if (label) control = label.control || label.querySelector("input, select");
    }
    // Some browsers retarget pointer events around disabled native controls.
    // Find the control under the pointer without adding focusable wrappers.
    if (!control && point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)) {
      for (const hit of document.elementsFromPoint(point.clientX, point.clientY)) {
        const candidate = hit.closest(CONTROL_SELECTOR);
        if (candidate && helpFor(candidate)) { control = candidate; break; }
      }
    }
    return control && helpFor(control) ? control : null;
  }

  function removeDescription(element) {
    if (!element) return;
    const ids = (element.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== TOOLTIP_ID);
    if (ids.length) element.setAttribute("aria-describedby", ids.join(" "));
    else element.removeAttribute("aria-describedby");
  }

  function hide(suppress = false) {
    clearTimeout(timer); timer = null;
    if (suppress) suppressed = active || pending || hovered || focused;
    pending = null;
    if (active) removeDescription(active);
    active = null;
    if (tooltip) { tooltip.hidden = true; tooltip.textContent = ""; }
  }

  function place(element) {
    const anchor = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport ? viewport.offsetLeft : 0;
    const viewportTop = viewport ? viewport.offsetTop : 0;
    const width = viewport ? viewport.width : document.documentElement.clientWidth;
    const height = viewport ? viewport.height : document.documentElement.clientHeight;
    const margin = 10, gap = 11;
    tooltip.style.maxWidth = `${Math.max(100, Math.min(310, width - margin * 2))}px`;
    tooltip.style.left = "0px"; tooltip.style.top = "0px";
    const box = tooltip.getBoundingClientRect();
    const center = anchor.left + anchor.width / 2;
    const minLeft = viewportLeft + margin;
    const maxLeft = Math.max(minLeft, viewportLeft + width - box.width - margin);
    const left = Math.max(minLeft, Math.min(maxLeft, center - box.width / 2));
    const above = anchor.top - gap - box.height;
    const below = anchor.bottom + gap;
    const useAbove = above >= viewportTop + margin || below + box.height > viewportTop + height - margin;
    const maxTop = Math.max(viewportTop + margin, viewportTop + height - box.height - margin);
    const top = Math.max(viewportTop + margin, Math.min(maxTop, useAbove ? above : below));
    tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
    tooltip.style.setProperty("--tooltip-arrow-left", `${Math.max(13, Math.min(box.width - 13, center - left))}px`);
    tooltip.dataset.placement = useAbove ? "top" : "bottom";
  }

  function show(element) {
    if (!element || !element.isConnected || element === suppressed || document.hidden) return;
    const text = helpFor(element);
    if (!text) return;
    hide();
    active = element;
    tooltip.textContent = text;
    tooltip.hidden = false;
    const ids = new Set((element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(TOOLTIP_ID);
    element.setAttribute("aria-describedby", Array.from(ids).join(" "));
    place(element);
  }

  function pointerTarget(event) {
    if (event.pointerType === "touch") return;
    if (event.buttons) { hide(true); return; }
    const next = findControl(event.target, event);
    if (next === hovered) return;
    hovered = next;
    suppressed = null;
    hide();
    if (!next) return;
    pending = next;
    timer = setTimeout(() => {
      const candidate = pending;
      pending = null;
      if (candidate === hovered) show(candidate);
    }, 350);
  }

  function install() {
    if (installed) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", install, { once: true });
      return;
    }
    installed = true;
    tooltip = document.createElement("div");
    tooltip.id = TOOLTIP_ID;
    tooltip.className = "motion-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.append(tooltip);
    stripTitles(document.body);

    document.addEventListener("pointerover", pointerTarget, true);
    document.addEventListener("pointermove", pointerTarget, true);
    document.addEventListener("pointerout", (event) => {
      const next = findControl(event.relatedTarget);
      if (next === hovered && event.relatedTarget) return;
      hovered = null; suppressed = null; hide();
    }, true);
    document.addEventListener("pointerdown", () => { lastPointerDown = performance.now(); hide(true); }, true);
    document.addEventListener("click", () => hide(true), true);
    document.addEventListener("focusin", (event) => {
      focused = findControl(event.target);
      if (performance.now() - lastPointerDown < 400) return;
      suppressed = null;
      show(focused);
    });
    document.addEventListener("focusout", (event) => {
      if (findControl(event.target) === focused) { focused = null; hide(true); }
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(true); }, true);
    document.addEventListener("scroll", () => hide(true), true);
    document.addEventListener("visibilitychange", () => { if (document.hidden) hide(true); });
    window.addEventListener("blur", () => { hovered = null; focused = null; hide(true); });
    window.addEventListener("resize", () => hide(true));
    if (window.visualViewport) {
      window.visualViewport.addEventListener("scroll", () => hide(true));
      window.visualViewport.addEventListener("resize", () => hide(true));
    }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target.matches(CONTROL_SELECTOR)) rememberTitle(record.target);
        } else {
          record.addedNodes.forEach(stripTitles);
        }
      }
      // Cable graphics are redrawn with the scope. Keep the same cable's help
      // stable across that redraw, without retaining help for a removed cable.
      hovered = replacedCable(hovered);
      suppressed = replacedCable(suppressed);
      if (pending && !pending.isConnected) {
        pending = replacedCable(pending);
        if (!pending) { clearTimeout(timer); timer = null; }
      }
      if (active && !active.isConnected) {
        const replacement = replacedCable(active);
        if (replacement) {
          removeDescription(active);
          active = replacement;
          const ids = new Set((active.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
          ids.add(TOOLTIP_ID);
          active.setAttribute("aria-describedby", Array.from(ids).join(" "));
          place(active);
        } else hide();
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  }

  globalThis.MotionTooltips = Object.freeze({ install });
})();
