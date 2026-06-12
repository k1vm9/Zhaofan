/**
 * DAVID V1 — Human Typing Simulator (Layer 4)
 * Copyright © 2025 DJAMEL
 * THE ONLY layer that wraps api.sendMessage with a typing indicator.
 * Uses typingVariator.calcVariedDelay() when available for time-of-day
 * awareness, falling back to its own length-proportional calcDelay().
 */
"use strict";

let _active = false;
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function calcDelay(msg) {
  // Prefer typingVariator's richer delay if it has been started already
  if (global._typingVariator?.calcVariedDelay) {
    return global._typingVariator.calcVariedDelay(msg);
  }
  const text = typeof msg === "string" ? msg : (msg?.body || "");
  const len  = text.replace(/<[^>]*>/g, "").length;
  const wpm  = rand(160, 280);
  const base = Math.round((len / (wpm * 5 / 60)) * 1000);
  const jit  = (Math.random() - 0.5) * 600;
  return Math.min(Math.max(base + jit, 500), 8000);
}

async function simulateTyping(api, threadID, ms) {
  try {
    if (typeof api.sendTypingIndicator === "function") {
      const stop = api.sendTypingIndicator(threadID, () => {});
      await new Promise(r => setTimeout(r, ms));
      if (typeof stop === "function") stop();
    } else {
      await new Promise(r => setTimeout(r, ms));
    }
  } catch (_) {
    await new Promise(r => setTimeout(r, ms));
  }
}

function start(api) {
  if (_active || !api) return;
  _active = true;

  const orig = api.sendMessage.bind(api);
  api.sendMessage = async function(msg, threadID, callback) {
    try {
      const delay = calcDelay(msg);
      await simulateTyping(api, threadID, delay);
    } catch (_) {}
    return orig(msg, threadID, callback);
  };
}

function stop() { _active = false; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active, calcDelay, simulateTyping };
