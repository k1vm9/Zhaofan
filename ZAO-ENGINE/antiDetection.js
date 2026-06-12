"use strict";
/**
 * ZAO-ENGINE — Anti-Detection Layer
 * Source: David's antiDetection.js — adds jitter to react/unsend calls,
 * rotates UA every 25-35 min. Simple and non-blocking.
 */

let _active = false;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
let _rotateTimer = null;

function start(api) {
  if (_active || !api) return;
  _active = true;

  ["setMessageReaction", "unsendMessage"].forEach(method => {
    if (typeof api[method] === "function") {
      const orig = api[method].bind(api);
      api[method] = function(...args) {
        const delay = rand(200, 900);
        setTimeout(() => { try { orig(...args); } catch (_) {} }, delay);
      };
    }
  });

  const { rotateUA } = require("./fca");
  _rotateTimer = setInterval(() => {
    try {
      if (!_active) return;
      const ua = rotateUA();
      if (typeof api.setOptions === "function") api.setOptions({ userAgent: ua });
    } catch (_) {}
  }, rand(25, 35) * 60000);
  if (_rotateTimer.unref) _rotateTimer.unref();
}

function stop() {
  _active = false;
  if (_rotateTimer) { try { clearInterval(_rotateTimer); } catch (_) {} _rotateTimer = null; }
}

module.exports = { start, stop, isActive: () => _active };
