"use strict";

/**
 * ZAO-ENGINE — antiSuspension.js
 *
 * Lightweight circuit breaker that tracks send/API failures.
 * When the failure rate in a rolling window exceeds the threshold,
 * the breaker trips and callers should back off before retrying.
 *
 * Fine-grained volume control is handled by sendPipeline.js + stealth.js.
 * This module only exists to give callers a tripped/not-tripped signal.
 */

const WINDOW_MS         = 5 * 60 * 1000;  // 5-minute rolling window
const FAILURE_THRESHOLD = 8;               // failures in window before trip
const RESET_AFTER_MS    = 10 * 60 * 1000; // auto-reset after 10 min of no new failures

let _failures    = [];   // timestamps of recent failures
let _tripped     = false;
let _tripTs      = null;
let _totalFails  = 0;
let _totalSucc   = 0;

function _prune() {
  const cutoff = Date.now() - WINDOW_MS;
  _failures = _failures.filter(t => t > cutoff);
}

function recordFailure(context) {
  _prune();
  _failures.push(Date.now());
  _totalFails++;

  if (!_tripped && _failures.length >= FAILURE_THRESHOLD) {
    _tripped = true;
    _tripTs  = Date.now();
    try {
      const logger = global.loggeryuki;
      const msg = `Circuit breaker TRIPPED — ${_failures.length} failures in ${WINDOW_MS / 60000}min window${context ? ' (' + context + ')' : ''}`;
      if (logger) {
        logger.log([{ message: "[ ANTI-SUSP ]: ", color: ["red", "cyan"] }, { message: msg, color: "white" }]);
      } else {
        console.warn("[ANTI-SUSP]", msg);
      }
    } catch (_) {}
  }
}

function recordSuccess() {
  _totalSucc++;
  if (_tripped && _tripTs && Date.now() - _tripTs >= RESET_AFTER_MS) {
    _tripped  = false;
    _tripTs   = null;
    _failures = [];
    try { console.log("[ANTI-SUSP] Circuit breaker reset after cooldown."); } catch (_) {}
  }
}

function isCircuitBreakerTripped() {
  if (!_tripped) return false;
  if (_tripTs && Date.now() - _tripTs >= RESET_AFTER_MS) {
    _tripped  = false;
    _tripTs   = null;
    _failures = [];
    return false;
  }
  return true;
}

function getStatus() {
  _prune();
  return {
    active:        true,
    engine:        "real",
    tripped:       _tripped,
    tripTs:        _tripTs ? new Date(_tripTs).toISOString() : null,
    windowFails:   _failures.length,
    threshold:     FAILURE_THRESHOLD,
    windowMs:      WINDOW_MS,
    totalFailures: _totalFails,
    totalSuccess:  _totalSucc,
    resetAfterMs:  RESET_AFTER_MS,
  };
}

function start()  {}
function stop()   {}

const globalAntiSuspension = {
  start,
  stop,
  isCircuitBreakerTripped,
  getStatus,
  recordSuccess,
  recordFailure,
};

module.exports = { globalAntiSuspension };
