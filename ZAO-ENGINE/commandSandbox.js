"use strict";
// ZAO-ENGINE — commandSandbox: export null so callers fall through to
// the direct Promise.resolve().then() path. An empty object export ({})
// is truthy, causing _sandbox.runWithTimeout() to throw TypeError on
// every single command dispatch.
module.exports = null;
