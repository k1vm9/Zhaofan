"use strict";

/**
 * ZAO-ENGINE — SessionWarmupManager v1.9
 * Ported from 1.3/includes/SessionWarmupManager.js
 *
 * Manages a warm-up phase whenever the bot switches to a fresh tier.
 * Prevents the "brand new session + full volume immediately" pattern that
 * Facebook's anomaly detection flags heavily.
 *
 * Warm-up phases (base):
 *   Phase 1 (0-5 min):   ≤  6 messages/min  — bot just logged in
 *   Phase 2 (5-15 min):  ≤ 15 messages/min  — session warming
 *   Phase 3 (15-30 min): ≤ 30 messages/min  — nearly full speed
 *   Phase 4 (30+ min):   No limit            — warm-up complete
 *
 * Account age scaling (via accountAgeScale.js):
 *   Fresh (2023+): extra Phase 0 — 60 min at ≤ 2/min
 *   Mid (2009-2022): Phase 0 — 20 min at ≤ 2/min
 *   Veteran (2004-2008): skips Phase 0
 *
 * Integration:
 *   sendPipeline.js step 3 calls checkWarmup() before every send.
 *   This module does NOT wrap api.sendMessage — sendPipeline owns that.
 *   Call notifyTierSwitch(api, tier) after every successful login/tier switch.
 */

const LOG_PREFIX = "[ WARMUP ]: ";

const BASE_PHASES = [
  { durationMs:  5 * 60 * 1000, maxPerMin:  6, name: "Phase 1 (cold)" },
  { durationMs: 10 * 60 * 1000, maxPerMin: 15, name: "Phase 2 (warming)" },
  { durationMs: 15 * 60 * 1000, maxPerMin: 30, name: "Phase 3 (nearly full)" },
];

function _buildPhases() {
  try {
    const age = require("./accountAgeScale");
    const era = age.getEra();
    if (era.warmupExtraMin > 0) {
      return [
        { durationMs: era.warmupExtraMin * 60 * 1000, maxPerMin: Math.min(era.maxMsgsPerMin, 4), name: `Phase 0 (age-scaled: ${era.label})` },
        ...BASE_PHASES
      ];
    }
  } catch (_) {}
  return BASE_PHASES;
}

let PHASES          = BASE_PHASES;
let _warmupStartTs  = null;
let _sendTimestamps = [];
let _heldCount      = 0;
let _started        = false;

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([{ message: LOG_PREFIX, color: ["red", "cyan"] }, { message: msg, color: "white" }]);
      return;
    }
  } catch (_) {}
  console.log(LOG_PREFIX + msg);
}

function _currentPhase() {
  if (_warmupStartTs === null) return null;
  const elapsed = Date.now() - _warmupStartTs;
  let cumulative = 0;
  for (const phase of PHASES) {
    if (elapsed < cumulative + phase.durationMs) return phase;
    cumulative += phase.durationMs;
  }
  return null;
}

function _windowCount() {
  const cutoff = Date.now() - 60000;
  _sendTimestamps = _sendTimestamps.filter(t => t > cutoff);
  return _sendTimestamps.length;
}

/**
 * Called by sendPipeline step 3 before every send.
 * Returns immediately when warm-up is complete or not started.
 * Waits when the current phase rate limit is exceeded.
 */
async function checkWarmup() {
  const phase = _currentPhase();
  if (!phase) return;

  while (true) {
    const count = _windowCount();
    if (count < phase.maxPerMin) break;
    const oldest  = _sendTimestamps[0];
    const waitMs  = Math.max(0, oldest + 60000 - Date.now()) + 200;
    _heldCount++;
    _log(`${phase.name}: ${count}/${phase.maxPerMin}/min — holding ${Math.ceil(waitMs / 1000)}s`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  _sendTimestamps.push(Date.now());
}

/**
 * Call after every successful login or tier switch.
 * Resets the warm-up clock and rebuilds phases using the now-known UID.
 */
function notifyTierSwitch(api, tier) {
  _warmupStartTs  = Date.now();
  _sendTimestamps = [];
  PHASES          = _buildPhases();

  const totalMin = Math.round(PHASES.reduce((s, p) => s + p.durationMs, 0) / 60000);
  _log(`Tier ${tier || "?"} activated — warm-up started (${totalMin} min total)`);
  _log(`  ${PHASES.map(p => `${p.name}: ≤${p.maxPerMin}/min for ${Math.round(p.durationMs / 60000)}min`).join(" → ")}`);

  try {
    const age  = require("./accountAgeScale");
    const info = age.getAgeInfo();
    _log(`  Account: ${info.era} (${info.label}) — multiplier: ${info.multiplier}`);
  } catch (_) {}
}

function start(api, tier) {
  if (!_started) { _started = true; _log("Session Warm-Up Manager v1.9 ready."); }
  if (api) notifyTierSwitch(api, tier || global.activeAccountTier || 1);
}

function stop() {
  _warmupStartTs  = null;
  _sendTimestamps = [];
}

function getStatus() {
  const phase   = _currentPhase();
  const elapsed = _warmupStartTs ? Date.now() - _warmupStartTs : null;
  const totalMs = PHASES.reduce((s, p) => s + p.durationMs, 0);
  return {
    active:        _started,
    inWarmup:      phase !== null,
    currentPhase:  phase ? phase.name : "Full speed",
    currentLimit:  phase ? phase.maxPerMin + "/min" : "None",
    warmupStartTs: _warmupStartTs ? new Date(_warmupStartTs).toISOString() : null,
    elapsedMs:     elapsed,
    progressPct:   elapsed !== null ? Math.min(100, Math.round((elapsed / totalMs) * 100)) : null,
    heldCount:     _heldCount,
    windowSends:   _windowCount(),
  };
}

module.exports = { start, stop, notifyTierSwitch, checkWarmup, getStatus };
