/**
 * DAVID V1 — Typing Speed Variator (Layer 15)
 * Copyright © 2025 DJAMEL
 * Exports calcVariedDelay() — used by humanTyping to pick a time-of-day-aware,
 * length-proportional, jitter-heavy delay. Does NOT wrap api.sendMessage itself
 * (humanTyping owns that wrap to avoid double-typing).
 */
"use strict";

let _active = false;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function getCurrentHour() {
  try {
    const tz = global.GoatBot?.config?.timezone || "Africa/Algiers";
    return parseInt(new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10);
  } catch (_) { return new Date().getHours(); }
}

function calcVariedDelay(msg) {
  const text = typeof msg === "string" ? msg : (msg?.body || "");
  const len  = text.replace(/<[^>]*>/g, "").length;
  const h    = getCurrentHour();

  // Slower typing at night
  const wpmBase = (h >= 0 && h < 6) ? rand(100, 160) : rand(160, 300);
  const base    = Math.round((len / (wpmBase * 5 / 60)) * 1000);

  // Occasional "thinking pause" (15% chance)
  const thinkPause = Math.random() < 0.15 ? rand(800, 2500) : 0;
  const jit = (Math.random() - 0.5) * 700;

  return Math.min(Math.max(base + jit + thinkPause, 600), 10000);
}

// Only marks the layer active — does NOT wrap api.sendMessage.
// humanTyping.js calls calcVariedDelay() directly for its delay value.
function start(api) {
  _active = true;
  // Register utility globally for humanTyping to pick up
  global._typingVariator = { calcVariedDelay };
}

function stop() { _active = false; global._typingVariator = null; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, calcVariedDelay, isActive: () => _active };
