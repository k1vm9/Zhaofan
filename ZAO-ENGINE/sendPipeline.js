"use strict";

/**
 * sendPipeline.js
 *
 * Centralised outgoing message pipeline for ZAO.
 *
 * Eliminates the wrapper pile-up (B08 / B-NEW-06) by providing ONE ordered
 * chain that every send passes through:
 *
 *   1. Drain guard    — reject during graceful shutdown
 *   2. Rate limiter   — EnhancedRateLimiter.applyThrottle + recordSend
 *   3. Warmup gate    — SessionWarmupManager phase limits
 *   4. Human timing   — humanTyping.simulateTyping (if not already modernized)
 *   5. Anti-detect    — outgoingThrottle min-gap enforcement
 *   6. Actual send    — original api.sendMessage
 *   7. Error record   — errorHandler.record on failure
 *
 * Usage:
 *   const pipeline = require('./sendPipeline');
 *   pipeline.patch(api);          // call once after login
 *   pipeline.unpatch(api);        // call before tier switch
 *
 * Design decisions:
 * - Idempotent: patching an already-patched api is a no-op.
 * - Unpatch restores the exact original method.
 * - Each step is guarded with try/catch — a broken middleware never blocks the send.
 * - Works alongside nkxfcaModernizer: if api.__nkxModernized is true the human-
 *   typing step is skipped (modernizer already handles it).
 */

const LOG_PREFIX = "[ SEND-PIPELINE ]: ";

function _log(msg, warn = false) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: LOG_PREFIX, color: ["red", "cyan"] },
        { message: msg, color: warn ? "yellow" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console[warn ? "warn" : "log"](LOG_PREFIX + msg);
}

// WeakMap: api → original sendMessage function
const _originals = new WeakMap();

// Lazily-resolved module references — cached after first successful require so
// the hot send path does zero repeated Map lookups after the first call.
// Using lazy refs (not top-level requires) avoids startup ordering issues with
// circular dependencies between pipeline modules.
let _rlMod = null;
let _wmMod = null;
let _htMod = null;
let _otMod = null;
let _ehMod = null;
let _dgMod = null;

/**
 * Patch api.sendMessage with the centralised pipeline.
 * Safe to call multiple times on the same instance.
 *
 * @param {object} api  FCA api instance
 */
function patch(api) {
  if (!api || _originals.has(api)) return;

  const original = api.sendMessage.bind(api);
  _originals.set(api, original);

  api.sendMessage = async function pipelinedSend(msg, threadID, callback, messageID) {
    const tid = String(threadID || "");
    const uid = String(global.botUserID || "BOT");

    // ── Step 1: Drain guard ────────────────────────────────────────────────
    if (global.__draining === true) {
      _log("Send blocked — graceful shutdown in progress", true);
      if (typeof callback === "function") callback(new Error("draining"), null);
      return;
    }

    // ── Step 1.5: Duplicate guard ──────────────────────────────────────────
    // Block the send immediately (before any delay) if this is a double-send.
    try {
      if (!_dgMod) _dgMod = require("./duplicateGuard");
      const body = typeof msg === "string" ? msg : (msg?.body || "");
      if (body && typeof _dgMod.isDuplicateOutgoing === "function") {
        if (_dgMod.isDuplicateOutgoing(tid, body)) {
          _log(`Duplicate blocked — thread ${tid}`, true);
          if (typeof callback === "function") callback(null, { deduplicated: true });
          return;
        }
      }
    } catch (_) {}

    // ── Step 2: Rate limiter ───────────────────────────────────────────────
    try {
      if (!_rlMod) _rlMod = require("./EnhancedRateLimiter");
      await _rlMod.applyThrottle(tid, uid);
      _rlMod.recordSend(tid, uid);
    } catch (_) {}

    // ── Step 3: Warmup gate ────────────────────────────────────────────────
    try {
      if (!_wmMod) _wmMod = require("./SessionWarmupManager");
      if (typeof _wmMod._checkWarmup === "function") await _wmMod._checkWarmup();
    } catch (_) {}

    // ── Step 4: Human typing simulation ───────────────────────────────────
    // Skip if nkxfcaModernizer already wraps this api (it handles typing internally)
    if (!api.__nkxModernized) {
      try {
        if (!_htMod) _htMod = require("./humanTyping");
        if (_htMod && typeof _htMod.calcDelay === "function") {
          // M-01: msg may be an object {body, attachment} — extract text safely
          const msgText = typeof msg === "string" ? msg : ((msg && msg.body) || "");
          const delay = _htMod.calcDelay(msgText);
          if (delay > 0 && typeof _htMod.simulateTyping === "function") {
            await _htMod.simulateTyping(api, tid, delay);
          }
        }
      } catch (_) {}
    }

    // ── Step 5: Outgoing throttle (min-gap enforcement) ────────────────────
    try {
      if (!_otMod) _otMod = require("./outgoingThrottle");
      if (typeof _otMod.check === "function") await _otMod.check(tid);
    } catch (_) {}

    // ── Step 6: Actual send ────────────────────────────────────────────────
    try {
      return original(msg, threadID, callback, messageID);
    } catch (e) {
      // ── Step 7: Error recording ──────────────────────────────────────────
      try {
        if (!_ehMod) _ehMod = require("./errorHandler");
        _ehMod.record("sendPipeline", e, { threadID: tid });
      } catch (_) {}
      if (typeof callback === "function") callback(e, null);
      else throw e;
    }
  };

  _log(`Pipeline patched on api instance (nkxModernized=${!!api.__nkxModernized})`);
}

/**
 * Restore the original api.sendMessage, removing the pipeline wrapper.
 * Call before a tier switch so the new tier's api gets a fresh patch.
 *
 * @param {object} api  FCA api instance
 */
function unpatch(api) {
  if (!api || !_originals.has(api)) return;
  api.sendMessage = _originals.get(api);
  _originals.delete(api);
  _log("Pipeline unpatched from api instance");
}

/**
 * Return pipeline status for the /bot/protection/status endpoint.
 */
function getStatus() {
  let rateLimitStatus = {};
  let warmupStatus    = {};
  let outThrottleStatus = {};

  try { rateLimitStatus  = require("./EnhancedRateLimiter").getStatus();     } catch (_) {}
  try { warmupStatus     = require("./SessionWarmupManager").getStatus();    } catch (_) {}
  try { outThrottleStatus = require("./outgoingThrottle").getStatus ? require("./outgoingThrottle").getStatus() : {}; } catch (_) {}

  return {
    patchedApis:    _originals.size !== undefined ? "(WeakMap — count unavailable)" : 0,
    rateLimit:      rateLimitStatus,
    warmup:         warmupStatus,
    outThrottle:    outThrottleStatus
  };
}

module.exports = { patch, unpatch, getStatus };
