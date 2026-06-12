"use strict";
/**
 * ZAO-ENGINE — eventLoopGuard stub
 * The old event loop watchdog caused false-positive restarts under high load.
 * Dropped. No-op stub so ZAO.js require() doesn't throw.
 */
function start(opts) {}
function stop() {}
function getStatus() { return { active: false, engine: "stub" }; }
module.exports = { start, stop, getStatus };
