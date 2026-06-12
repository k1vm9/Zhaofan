"use strict";
/**
 * ZAO-ENGINE — Main Entry
 *
 * This is the lean, battle-tested security + session engine for ZAO.
 * It replaces the old /includes security layer with a simpler mix of
 * Djamel-fca's best ideas and ZAO's proven session management.
 *
 * What's included:
 *   fca.js              — Login wrapper with cookie parsing, UA rotation, human helpers
 *   stealth.js          — Simple presence loop (hits FB every 8-20 min, sleep hours)
 *   humanTyping.js      — Wraps sendMessage with realistic typing delay
 *   humanReadReceipt.js — Marks messages read after 800-3500ms delay
 *   outgoingThrottle.js — Queue sends with 700-2000ms gaps (anti-spam)
 *   duplicateGuard.js   — Prevents accidental double-sends (8s window)
 *   rateLimit.js        — Sliding-window rate limiter
 *   antiDetection.js    — Jitter on react/unsend + UA rotation
 *   keepAlive.js        — Periodic pings + cookie save + dtsg refresh
 *   sessionGuard.js     — 3-layer session preservation (snapshots + integrity)
 *   cookieSnapshot.js   — Ring buffer of known-good AppState snapshots
 *   checkLiveCookie.js  — Triple-URL session validator
 *   login/autoRelogin.js — Tier relogin with walk-forward exhaustion
 *
 * What was DROPPED (over-engineering that caused crashes after hours):
 *   - AntiDetectionEnhanced (complex timers + interference)
 *   - stealthEngineV2 (complex, replaced by simple stealth.js)
 *   - OnlinePresenceEngine (too aggressive, triggered detection)
 *   - ZAOSecurityManager (unnecessary orchestration layer)
 *   - SessionWarmupManager (redundant with keepAlive)
 *   - HumanActivitySimulator (too many concurrent timers)
 *   - IpReputationMonitor (false positives caused unnecessary tier switches)
 *   - crashFingerprinter (caused restart loops)
 *   - commandErrorBudget / commandSandbox (over-engineering)
 *   - EnhancedRateLimiter / RequestPacingEngine (replaced by simple rateLimit.js)
 *   - eventLoopGuard / diskGuard (risky, caused false alarms)
 *   - sendFailureDetector (false positives triggered unnecessary tier switches)
 *
 * Usage from ZAO.js:
 *   const engine = require('./ZAO-ENGINE');
 *   engine.start(api, stateFilePath);  — starts all protection layers
 *   engine.stop();                     — stops all protection layers
 */

const fca              = require("./fca");
const stealth          = require("./stealth");
const humanTyping      = require("./humanTyping");
const humanReadReceipt = require("./humanReadReceipt");
const outgoingThrottle = require("./outgoingThrottle");
const duplicateGuard   = require("./duplicateGuard");
const rateLimit        = require("./rateLimit");
const antiDetection    = require("./antiDetection");
const keepAlive        = require("./keepAlive");
const sessionGuard     = require("./sessionGuard");

/**
 * Start ZAO-ENGINE behavioral protection layers for a given API instance.
 * NOTE: humanTyping, outgoingThrottle, and duplicateGuard are handled
 * internally by sendPipeline (ZAO.js patches it before calling this).
 * This wires the layers that sendPipeline does NOT cover.
 *
 * @param {object} api           - Live FCA api object
 * @param {string} stateFilePath - Absolute path to the active state file
 */
function start(api, stateFilePath) {
  if (!api) return;

  // Layer 1: Human read receipts — delayed mark-as-read (800-3500ms)
  // sendPipeline doesn't handle this; we wire it here.
  try { humanReadReceipt.start(api); } catch (_) {}

  // Layer 2: Anti-detection — jitter on reactions/unsend + UA rotation
  try { antiDetection.start(api); } catch (_) {}

  // Layer 3: Stealth presence loop — periodic FB endpoint rotation
  try { stealth.start(api); } catch (_) {}

  // Layer 4: Keep-alive — HTTP pings, cookie save, dtsg refresh, notification visit
  // (ZAO.js also starts this individually — start() is idempotent)
  try { keepAlive.startKeepAlive(); } catch (_) {}

  // Layer 5: Session guard — AppState snapshots + integrity checks
  // (ZAO.js also starts this individually — idempotent)
  try { sessionGuard.start(api, stateFilePath); } catch (_) {}
}

/**
 * Update all engine modules to reference a new api instance.
 * Called when a new api object is created (e.g. hot-reload, manual tier switch
 * without process restart — rare but possible).
 *
 * @param {object} api - New live FCA api object
 */
function updateApi(api) {
  if (!api) return;
  try { humanReadReceipt.stop(); humanReadReceipt.start(api); } catch (_) {}
  try { antiDetection.start(api); } catch (_) {}
  try { if (typeof stealth.updateApi === "function") stealth.updateApi(api); } catch (_) {}
  try { sessionGuard.updateApi(api); } catch (_) {}
}

/**
 * Stop all running ZAO-ENGINE protection layers.
 * Call before a tier switch or graceful shutdown.
 */
function stop() {
  try { stealth.stop(); } catch (_) {}
  try { humanTyping.stop(); } catch (_) {}
  try { humanReadReceipt.stop(); } catch (_) {}
  try { outgoingThrottle.stop(); } catch (_) {}
  try { duplicateGuard.stop(); } catch (_) {}
  try { antiDetection.stop(); } catch (_) {}
  try { keepAlive.stopKeepAlive(); } catch (_) {}
  try { sessionGuard.stop(); } catch (_) {}
}

module.exports = {
  // High-level orchestration
  start,
  stop,
  updateApi,
  // Individual modules (for direct access)
  fca,
  stealth,
  humanTyping,
  humanReadReceipt,
  outgoingThrottle,
  duplicateGuard,
  rateLimit,
  antiDetection,
  keepAlive,
  sessionGuard,
  cookieSnapshot: require("./cookieSnapshot"),
  checkLiveCookie: require("./checkLiveCookie"),
};
