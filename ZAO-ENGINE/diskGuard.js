"use strict";
/**
 * ZAO-ENGINE — diskGuard stub
 * Disk guard caused false alarms on shared hosting. Dropped.
 * No-op stub so ZAO.js require() doesn't throw.
 */
function start(opts) {}
function stop() {}
function getStatus() { return { active: false, engine: "stub" }; }
module.exports = { start, stop, getStatus };
