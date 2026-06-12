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
 * Start all ZAO-ENGINE protection layers for a given API instance.
 * Call this once after a successful login.
 *
 * @param {object} api           - Live FCA api object
 * @param {string} stateFilePath - Absolute path to the active state file
 */
function start(api, stateFilePath) {
  if (!api) return;

  // Layer 1: Duplicate guard (must come first — wraps sendMessage)
  try { duplicateGuard.start(api); } catch (_) {}

  // Layer 2: Outgoing throttle (queues sends with human gap)
  try { outgoingThrottle.start(api); } catch (_) {}

  // Layer 3: Human typing delay (wraps sendMessage with typing indicator)
  try { humanTyping.start(api); } catch (_) {}

  // Layer 4: Human read receipts (delayed mark-as-read)
  try { humanReadReceipt.start(api); } catch (_) {}

  // Layer 5: Anti-detection jitter on reactions/unsend + UA rotation
  try { antiDetection.start(api); } catch (_) {}

  // Layer 6: Stealth presence loop (periodic FB pings with mobile UA)
  try { stealth.start(api); } catch (_) {}

  // Layer 7: Keep-alive (HTTP pings, cookie save, dtsg refresh, notification visit)
  try { keepAlive.startKeepAlive(); } catch (_) {}

  // Layer 8: Session guard (AppState snapshots + integrity checks)
  try { sessionGuard.start(api, stateFilePath); } catch (_) {}
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
  // High-level
  start,
  stop,
  // Individual modules
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
