"use strict";
/**
 * ZAO-ENGINE — sendFailureDetector stub
 * The old detector was causing false-positive tier switches. Dropped.
 * accountHealthMonitor in ZAO-ENGINE/login/ handles real failure detection.
 */
function onSendSuccess() {}
function onSendFailure() {}
function onPingDetectedBlock() {}
function getStatus() { return { active: false, engine: "stub" }; }
module.exports = { onSendSuccess, onSendFailure, onPingDetectedBlock, getStatus };
