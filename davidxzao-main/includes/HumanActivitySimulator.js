"use strict";
/**
 * DAVID V1 — Human Activity Simulator
 * Simulates human-like online presence patterns.
 */

let _running = false;
let _mood    = "normal";
let _timer   = null;
const _log   = [];

const MOODS = ["active", "normal", "idle", "away", "busy"];

function start(api, opts = {}) {
  if (_running) return;
  _running = true;
  _mood    = opts.mood || "normal";
  _log.push({ ts: Date.now(), event: "started", mood: _mood });

  const intervalMs = opts.intervalMs || 30 * 60 * 1000;
  _timer = setInterval(() => {
    _log.push({ ts: Date.now(), event: "activity-tick", mood: _mood });
    if (_log.length > 100) _log.shift();
  }, intervalMs);
}

function stop() {
  _running = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
  _log.push({ ts: Date.now(), event: "stopped" });
}

function setMood(mood) {
  if (MOODS.includes(mood)) { _mood = mood; _log.push({ ts: Date.now(), event: "mood-change", mood }); }
}

function getStatus() {
  return {
    running:  _running,
    mood:     _mood,
    sessions: _log.length,
    lastEvent: _log[_log.length - 1] || null,
  };
}

module.exports = { start, stop, setMood, getStatus, MOODS };
