/**
 * DAVID V1 — Ultimate Protection Monitor (Layer 16)
 * Copyright © 2025 DJAMEL
 * Monitors all active protection layers and emits periodic health stats
 * to the dashboard. Does NOT wrap api.sendMessage — all other layers
 * already handle that; this is the final health-check orchestrator only.
 */
"use strict";

let _active = false;
let _startTime = 0;
let _interval  = null;

const LAYERS = [
  "stealth", "keepAlive", "mqttHealthCheck", "outgoingThrottle",
  "humanTyping", "naturalPresence", "behaviorScheduler", "antiDetection",
  "sessionRefresher", "humanReadReceipt", "scrollSimulator", "reactionDelay",
  "connectionJitter", "duplicateGuard", "typingVariator",
];

function getLayerStatus() {
  const status = {};
  for (const name of LAYERS) {
    try {
      const mod = require(`./${name}`);
      status[name] = typeof mod.isActive === "function" ? mod.isActive() : true;
    } catch (_) { status[name] = false; }
  }
  return status;
}

function getStats() {
  return {
    active:    _active,
    uptime:    _active ? Date.now() - _startTime : 0,
    layers:    getLayerStatus(),
    activeCount: Object.values(getLayerStatus()).filter(Boolean).length,
  };
}

function start(api) {
  if (_active) return;
  _active    = true;
  _startTime = Date.now();

  // Emit protection health to dashboard every 5 min
  _interval = setInterval(() => {
    if (!_active) return;
    try {
      const server = require("../dashboard/server");
      const io = typeof server.getIO === "function" ? server.getIO() : null;
      if (io) io.emit("protection-stats", getStats());
    } catch (_) {}
  }, 5 * 60 * 1000);
}

function stop() {
  _active = false;
  if (_interval) { clearInterval(_interval); _interval = null; }
}

function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, getStats, isActive: () => _active };
