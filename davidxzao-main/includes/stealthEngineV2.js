"use strict";
/**
 * DAVID V1 — Stealth Engine V2 (re-export wrapper)
 * Provides a unified interface over the protection/stealth layer.
 */

let _prot = null;
try { _prot = require("../src/protection/stealth"); } catch (_) {}

let _running = false;
const LAYERS = 20;

function start(api, opts = {}) {
  _running = true;
  if (_prot?.start) try { _prot.start(api, opts); } catch (_) {}
}

function stop() {
  _running = false;
  if (_prot?.stop) try { _prot.stop(); } catch (_) {}
}

function isRunning() {
  try { return _prot?.isRunning ? _prot.isRunning() : _running; }
  catch (_) { return _running; }
}

function getStatus() {
  return {
    running: isRunning(),
    layers:  LAYERS,
    version: "2.0",
    engine:  "DAVID V1 — WHITE V3",
  };
}

module.exports = { start, stop, isRunning, getStatus };
