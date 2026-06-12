"use strict";
// ZAO-ENGINE — commandErrorBudget: export null so callers fall through
// gracefully. An empty object export ({}) is truthy and causes
// _errBudget.isTripped() / _errBudget.record() to throw TypeError.
module.exports = null;
