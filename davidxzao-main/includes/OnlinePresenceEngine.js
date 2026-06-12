"use strict";
/**
 * DAVID V1 — Online Presence Engine
 * Manages realistic online/offline presence cycles.
 */

let _running = false;
let _timer   = null;
let _status  = "offline";
let _schedule = null;

const PRESETS = {
  always:  [{ from: 0,  to: 24, weight: 1 }],
  daytime: [{ from: 7,  to: 22, weight: 1 }, { from: 22, to: 7, weight: 0.1 }],
  night:   [{ from: 20, to: 6,  weight: 1 }, { from: 6,  to: 20, weight: 0.1 }],
  random:  null,
};

function start(api, opts = {}) {
  if (_running) return;
  _running  = true;
  _status   = "online";
  _schedule = opts.schedule || "always";

  _timer = setInterval(() => {
    const h = new Date().getHours();
    _status = (h >= 6 && h < 23) ? "online" : "idle";
    try {
      if (typeof api?.setOptions === "function") api.setOptions({ online: _status === "online" });
    } catch (_) {}
  }, 15 * 60 * 1000);
}

function stop() {
  _running = false;
  _status  = "offline";
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function getStatus() {
  return { running: _running, status: _status, schedule: _schedule };
}

function setSchedule(s) {
  if (PRESETS[s] !== undefined) _schedule = s;
}

module.exports = { start, stop, getStatus, setSchedule, PRESETS };
