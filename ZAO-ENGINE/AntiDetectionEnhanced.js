"use strict";
/**
 * ZAO-ENGINE — AntiDetectionEnhanced shim
 * The old complex version is dropped. This shim delegates to the simple
 * antiDetection.js so existing command references don't break.
 */
const antiDetection = require("./antiDetection");
module.exports = { ...antiDetection, getStatus: () => ({ active: antiDetection.isActive(), engine: "ZAO-ENGINE/antiDetection" }) };
