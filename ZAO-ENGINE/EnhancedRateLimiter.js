"use strict";
/**
 * ZAO-ENGINE — EnhancedRateLimiter stub
 * The old over-engineered version is dropped. This stub uses the simple
 * rateLimit.js and exposes getStatus() so panel code doesn't crash.
 */
const rl = require("./rateLimit");
function getStatus() { return { active: true, engine: "ZAO-ENGINE/rateLimit" }; }
module.exports = { ...rl, getStatus };
