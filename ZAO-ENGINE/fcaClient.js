"use strict";
/**
 * ZAO-ENGINE — FCA Client shim
 * Re-exports from fca.js so internal modules that require("../fcaClient")
 * continue to work without path changes.
 */
module.exports = require("./fca");
