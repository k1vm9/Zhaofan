/**
 * DAVID V1 — Behavior Scheduler (Layer 7)
 * Copyright © 2025 DJAMEL
 * Enforces sleep-hour slowdowns and injects human-like response delays
 * that scale with time of day to simulate a real person's activity pattern.
 */
"use strict";

let _active = false;
let _api    = null;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function getCurrentHour() {
  try {
    const tz = global.GoatBot?.config?.timezone || "Africa/Algiers";
    return parseInt(new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10);
  } catch (_) { return new Date().getHours(); }
}

function isSleepHour() {
  try {
    const cfg = global.GoatBot?.config?.stealth || {};
    if (cfg.enable === false) return false;
    const h = getCurrentHour();
    const s = cfg.sleepHourStart ?? 1;
    const e = cfg.sleepHourEnd   ?? 7;
    return s < e ? h >= s && h < e : h >= s || h < e;
  } catch (_) { return false; }
}

function getActivityDelay() {
  const h = getCurrentHour();
  // Peak hours (9–22): minimal extra delay
  if (h >= 9 && h < 22)  return rand(0, 400);
  // Late night (22–1):   moderate delay
  if (h >= 22 || h < 1)  return rand(400, 1200);
  // Sleep hours (1–7):   long delay (bot "wakes up slowly")
  return rand(2000, 6000);
}

function start(api) {
  if (_active || !api) return;
  _active = true;
  _api    = api;

  const orig = api.sendMessage.bind(api);
  api.sendMessage = function(msg, threadID, callback) {
    if (isSleepHour()) {
      // During sleep: drop a large % of outgoing to simulate dormancy
      if (Math.random() < 0.6) {
        if (typeof callback === "function") callback(null, { fake: true });
        return;
      }
    }
    const delay = getActivityDelay();
    if (delay <= 0) return orig(msg, threadID, callback);
    setTimeout(() => orig(msg, threadID, callback), delay);
  };
}

function stop() { _active = false; _api = null; }
function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active, isSleepHour };
