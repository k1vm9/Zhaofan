"use strict";
/**
 * ZAO-ENGINE — StealthEngine shim
 * Wraps the new simple stealth.js and exposes the `globalStealthEngine`
 * API that ZAO.js /bot/stats endpoint expects.
 */

const stealth = require("./stealth");

const globalStealthEngine = {
  getStatus: () => ({ active: stealth.isActive(), engine: "ZAO-ENGINE/stealth" }),
};

module.exports = { globalStealthEngine, stealth, ...stealth };
