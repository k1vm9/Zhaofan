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

    // ── Step 2: Rate limiter ───────────────────────────────────────────────
    try {
      const rl = require("./EnhancedRateLimiter");
      await rl.applyThrottle(tid, uid);
      rl.recordSend(tid, uid);
    } catch (_) {}

    // ── Step 3: Warmup gate ────────────────────────────────────────────────
    try {
      const wm = require("./SessionWarmupManager");
      if (typeof wm._checkWarmup === "function") await wm._checkWarmup();
    } catch (_) {}

    // ── Step 4: Human typing simulation ───────────────────────────────────
    // Skip if nkxfcaModernizer already wraps this api (it handles typing internally)
    if (!api.__nkxModernized) {
      try {
        const ht = require("./humanTyping");
        if (ht && typeof ht.calcDelay === "function") {
          const delay = ht.calcDelay(msg);
          if (delay > 0 && typeof ht.simulateTyping === "function") {
            await ht.simulateTyping(api, tid, delay);
          }
        }
      } catch (_) {}
    }

    // ── Step 5: Outgoing throttle (min-gap enforcement) ────────────────────
    try {
      const ot = require("./outgoingThrottle");
      if (typeof ot.check === "function") await ot.check(tid);
    } catch (_) {}

    // ── Step 6: Actual send ────────────────────────────────────────────────
    try {
      return original(msg, threadID, callback, messageID);
    } catch (e) {
      // ── Step 7: Error recording ──────────────────────────────────────────
      try {
        const eh = require("./errorHandler");
        eh.record("sendPipeline", e, { threadID: tid });
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
