"use strict";
/**
 * ZAO-ENGINE — Anti-Detection Layer
 * Source: David's antiDetection.js — adds jitter to react/unsend calls,
 * rotates UA every 25-35 min. Simple and non-blocking.
 *
 * start(api) is idempotent for the same api but safe to call with a new api
 * object — it replaces the rotation timer and wraps the new api's methods.
 */

let _active      = false;
let _currentApi  = null;
let _rotateTimer = null;
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function _applyJitter(api) {
  ["setMessageReaction", "unsendMessage"].forEach(method => {
    if (typeof api[method] === "function" && !api[`__jitter_${method}`]) {
      const orig = api[method].bind(api);
      api[method] = function(...args) {
        const delay = rand(200, 900);
        const t = setTimeout(() => { try { orig(...args); } catch (_) {} }, delay);
        if (t?.unref) t.unref();
      };
      api[`__jitter_${method}`] = true;
    }
  });
}

function _startRotateTimer(api) {
  if (_rotateTimer) { try { clearInterval(_rotateTimer); } catch (_) {} _rotateTimer = null; }
  const { rotateUA } = require("./fca");
  _rotateTimer = setInterval(() => {
    try {
      if (!_active) return;
      const ua = rotateUA();
      if (typeof api.setOptions === "function") api.setOptions({ userAgent: ua });
    } catch (_) {}
  }, rand(25, 35) * 60000);
  if (_rotateTimer?.unref) _rotateTimer.unref();
}

function start(api) {
  if (!api) return;
  if (_active && _currentApi === api) return;  // same api — no-op
  _currentApi = api;
  _active     = true;
  _applyJitter(api);
  _startRotateTimer(api);
}

function stop() {
  _active     = false;
  _currentApi = null;
  if (_rotateTimer) { try { clearInterval(_rotateTimer); } catch (_) {} _rotateTimer = null; }
}

module.exports = { start, stop, isActive: () => _active };
