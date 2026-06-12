"use strict";

/**
 * SessionWarmupManager
 * =====================
 * A new standalone system that manages a "warm-up" phase whenever the bot
 * switches to a fresh tier. The goal is to prevent the sudden
 * "brand new session + full volume immediately" pattern that Facebook's
 * anomaly detection flags heavily.
 *
 * Warm-up phases:
 *   Phase 1 (0-5 min):  Allow ≤ 6 messages/min. Bot is "just logged in".
 *   Phase 2 (5-15 min): Allow ≤ 15 messages/min. Session is warming up.
 *   Phase 3 (15-30 min): Allow ≤ 30 messages/min. Nearly full speed.
 *   Phase 4 (30+ min):  Full speed — warm-up complete.
 *
 * Implementation:
 *   • Hooks into api.sendMessage via a wrapper that queues calls when the
 *     per-phase rate is exceeded.
 *   • Releases queued sends gradually (no burst on release).
 *   • Wraps only once per api instance (idempotent).
 *   • Provides notifyTierSwitch() for autoRelogin.js to call after switching.
 */

const LOG_PREFIX = "[ WARMUP ]: ";

// ── Phase definitions ─────────────────────────────────────────────────────
// Base phases — extended dynamically for fresh/mid accounts via _buildPhases()
const BASE_PHASES = [
  { durationMs:  5 * 60 * 1000, maxPerMin:  6, name: "Phase 1 (cold)" },
  { durationMs: 10 * 60 * 1000, maxPerMin: 15, name: "Phase 2 (warming)" },
  { durationMs: 15 * 60 * 1000, maxPerMin: 30, name: "Phase 3 (nearly full)" },
];
// After all phases elapsed, no limit applies.

/** Build phase list, prepending an age-scaled Phase 0 for fresh/mid accounts. */
function _buildPhases() {
  return BASE_PHASES;
}

let PHASES = BASE_PHASES;

// ── State ─────────────────────────────────────────────────────────────────
let _warmupStartTs  = null;   // timestamp of last tier switch
let _activePhaseIdx = -1;     // -1 = no warmup / full speed
let _patchedApis    = new WeakSet();
let _sendTimestamps = [];     // rolling 1-min window of actual sends
let _heldCount      = 0;      // calls delayed by warmup
let _started        = false;

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: LOG_PREFIX, color: ["red", "cyan"] },
        { message: msg, color: "white" },
      ]);
      return;
    }
  } catch (_) {}
  console.log(LOG_PREFIX + msg);
}

/**
 * Determine the current phase and its rate limit.
 * Returns null if warm-up is complete.
 */
function _currentPhase() {
  if (_warmupStartTs === null) return null;
  const elapsed = Date.now() - _warmupStartTs;
  let cumulative = 0;
  for (const phase of PHASES) {
    if (elapsed < cumulative + phase.durationMs) {
      return phase;
    }
    cumulative += phase.durationMs;
  }
  return null;  // warm-up complete
}

/**
 * Prune send timestamps outside the last 60s and return current count.
 */
function _windowCount() {
  const cutoff = Date.now() - 60000;
  _sendTimestamps = _sendTimestamps.filter(t => t > cutoff);
  return _sendTimestamps.length;
}

/**
 * Wait until the current phase allows another send.
 * If warm-up is complete, returns immediately.
 */
async function _waitForSlot() {
  const phase = _currentPhase();
  if (!phase) return;  // warm-up over

  let waitMs = 0;
  while (true) {
    const count = _windowCount();
    if (count < phase.maxPerMin) break;

    // Too many sends in the last minute — wait for the oldest to expire
    const oldest = _sendTimestamps[0];
    waitMs = Math.max(0, oldest + 60000 - Date.now()) + 200;
    _heldCount++;
    _log(`${phase.name}: rate ${count}/${phase.maxPerMin}/min — holding send for ${Math.ceil(waitMs / 1000)}s`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  _sendTimestamps.push(Date.now());
}

/**
 * Wrap api.sendMessage with warm-up rate limiting.
 * Idempotent — won't double-wrap.
 */
function _patch(api) {
  if (!api || _patchedApis.has(api)) return;
  _patchedApis.add(api);

  const original = api.sendMessage.bind(api);
  api.sendMessage = async function warmupSendMessage(form, threadID, callback, replyToMessage) {
    await _waitForSlot();
    const p = new Promise((resolve, reject) => {
      original(form, threadID, (err, info) => {
        if (err) reject(err); else resolve(info);
      }, replyToMessage);
    });

    if (typeof callback === "function") {
      p.then(info => callback(null, info)).catch(err => callback(err));
      return;
    }
    return p;
  };

  _log("sendMessage wrapped with warm-up rate limiter.");
}

/**
 * Call this whenever the bot switches to a new tier (or on first login).
 * Starts the warm-up clock and patches the api.
 *
 * @param {object} api     FCA API instance for the new tier
 * @param {number} [tier]  Which tier was just activated (for logging)
 */
function notifyTierSwitch(api, tier) {
  _warmupStartTs  = Date.now();
  _activePhaseIdx = 0;
  _sendTimestamps = [];

  // Rebuild phases each time — UID is now known so age scaling is accurate
  PHASES = _buildPhases();

  const totalWarmupMin = PHASES.reduce((s, p) => s + p.durationMs, 0) / 60000;
  _log(`Tier ${tier || "?"} activated — warm-up started. Total duration: ${totalWarmupMin} min.`);
  _log(`  ${PHASES.map(p => `${p.name}: ≤${p.maxPerMin}/min for ${p.durationMs / 60000}min`).join(" → ")}`);


  if (api) _patch(api);
}

/**
 * Start the manager. Patches the initial api if provided.
 * Use notifyTierSwitch() for subsequent tier changes.
 */
function start(api, tier) {
  if (!_started) {
    _started = true;
    _log("Session Warm-Up Manager started.");
  }
  if (api) {
    notifyTierSwitch(api, tier || global.activeAccountTier || 1);
  }
}

/**
 * Return status snapshot for the panel.
 */
function getStatus() {
  const phase   = _currentPhase();
  const elapsed = _warmupStartTs ? Date.now() - _warmupStartTs : null;
  const totalMs = PHASES.reduce((s, p) => s + p.durationMs, 0);
  const pct     = elapsed !== null ? Math.min(100, Math.round((elapsed / totalMs) * 100)) : null;

  return {
    active:         _started,
    inWarmup:       phase !== null,
    currentPhase:   phase ? phase.name : "Full speed",
    currentLimit:   phase ? phase.maxPerMin + "/min" : "None",
    warmupStartTs:  _warmupStartTs ? new Date(_warmupStartTs).toISOString() : null,
    elapsedMs:      elapsed,
    progressPct:    pct,
    heldCount:      _heldCount,
    windowSends:    _windowCount(),
  };
}

module.exports = { start, notifyTierSwitch, getStatus };
