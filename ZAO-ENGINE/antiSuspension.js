"use strict";
/**
 * ZAO-ENGINE — antiSuspension stub
 * The old complex anti-suspension engine is dropped (it was causing crashes).
 * ZAO-ENGINE's simple stealth.js + humanTyping.js provide equivalent coverage.
 * Stubs out globalAntiSuspension with safe no-op methods.
 */
const globalAntiSuspension = {
  start:                    () => {},
  stop:                     () => {},
  isCircuitBreakerTripped:  () => false,
  getStatus:                () => ({ active: false, engine: "stub" }),
  recordSuccess:            () => {},
  recordFailure:            () => {},
};
module.exports = { globalAntiSuspension };
