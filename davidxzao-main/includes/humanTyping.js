"use strict";
/**
 * DAVID V1 — Human Typing Simulator
 * Calculates realistic typing delays and simulates the "typing" indicator.
 */

const CHARS_PER_SEC = 12;
const MIN_DELAY     = 600;
const MAX_DELAY     = 5000;

function calcDelay(text) {
  try {
    const cfg = global.GoatBot?.config?.humanTyping || {};
    const cps  = cfg.charsPerSecond || CHARS_PER_SEC;
    const minD = cfg.minDelay       || MIN_DELAY;
    const maxD = cfg.maxDelay       || MAX_DELAY;
    const len  = String(text || "").length;
    const raw  = Math.round((len / cps) * 1000);
    return Math.max(minD, Math.min(maxD, raw));
  } catch (_) { return MIN_DELAY; }
}

async function simulateTyping(api, threadID, delayMs) {
  return new Promise(resolve => {
    try {
      if (typeof api.sendTypingIndicator === "function") {
        const stop = api.sendTypingIndicator(threadID, () => {});
        setTimeout(() => { try { if (typeof stop === "function") stop(); } catch (_) {} resolve(); }, delayMs || MIN_DELAY);
      } else {
        setTimeout(resolve, delayMs || MIN_DELAY);
      }
    } catch (_) { resolve(); }
  });
}

module.exports = { calcDelay, simulateTyping };
