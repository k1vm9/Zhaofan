"use strict";
// ZAO-ENGINE — crashFingerprinter stub (dropped — was causing restart loops)
// Provides all methods that Main.js calls so logs stay clean.
function feedLine() {}
function recordCrash() {}
function getStatus() { return { active: false, engine: "stub" }; }
module.exports = { feedLine, recordCrash, getStatus };
