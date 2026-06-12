/**
 * DAVID V1 — Anti-Detection Layer (Layer 8)
 * Copyright © 2025 DJAMEL
 * Injects realistic jitter into every API call, rotates User-Agent headers,
 * and adds entropy to request timing to defeat bot-detection heuristics.
 */
"use strict";

let _active = false;
let _api    = null;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const UA_POOL = [
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 Chrome/101.0.0.0 Mobile Safari/537.36",
];
let _uaIdx = 0;
const rotateUA = () => { _uaIdx = (_uaIdx + 1) % UA_POOL.length; return UA_POOL[_uaIdx]; };

function wrapWithJitter(fn) {
  return function(...args) {
    const delay = rand(80, 450);
    return new Promise(resolve =>
      setTimeout(() => resolve(fn.apply(this, args)), delay)
    );
  };
}

function start(api) {
  if (_active || !api) return;
  _active = true;
  _api    = api;

  // Wrap react/unsend with jitter
  ["setMessageReaction", "unsendMessage"].forEach(method => {
    if (typeof api[method] === "function") {
      const orig = api[method].bind(api);
      api[method] = function(...args) {
        const delay = rand(200, 900);
        setTimeout(() => orig(...args), delay);
      };
    }
  });

  // Rotate UA every ~30 min
  setInterval(() => {
    try {
      if (!_active) return;
      const ua = rotateUA();
      if (typeof api.setOptions === "function") api.setOptions({ userAgent: ua });
    } catch (_) {}
  }, rand(25, 35) * 60000);
}

function stop() { _active = false; _api = null; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active, rotateUA };
