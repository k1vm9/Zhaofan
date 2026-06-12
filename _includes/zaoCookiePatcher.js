"use strict";

/**
 * ZAO Cookie Patcher
 * ===================
 * Patches the FCA API instance after login to:
 *   1. Ensure ALL API features work with cookie-based sessions (not only credentials)
 *   2. Fix overly-aggressive anti-suspension signals that cause false circuit-breaker trips
 *   3. Improve token/cookie refresh for cookie sessions
 *   4. Register awareness of the active account slot for multi-account failover
 *
 * Linked from nkxfcaModernizer.js — called right after the FCA API object is created.
 */

const fs   = require("fs-extra");
const path = require("path");
// [FIX Djamel] — atomic cookie persistence. The token-refresh hook below
// fires constantly and can race with itself; atomic writes guarantee the
// file is never observed half-written by another reader (or a crash).
const { atomicWriteFileSync } = (() => {
  try { return require("../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: fs.writeFileSync.bind(fs) }; }
})();

/**
 * Suspension signal strings that are TOO BROAD and cause false trips.
 * These map normal Facebook API responses / transient network errors to
 * suspension events, which makes the circuit-breaker trip unnecessarily
 * and halts the bot for 45 minutes for no real reason.
 */
// [FIX Djamel] — tightened false-positive list. The previous version
// silently swallowed "something went wrong" and "please try again later",
// both of which Facebook returns alongside a real soft-block when the
// account is being throttled. Removing them lets the circuit breaker
// trip on those genuine signals and protects the account.
const FALSE_POSITIVE_SIGNALS = new Set([
  "feature temporarily unavailable",
  "this content isn't available",
]);

/**
 * After every successful login (cookie or credential), call this to:
 *   - Patch the FCA's internal anti-suspension module
 *   - Ensure getBotInfo / getBotInitialData work with cookie sessions
 *   - Set up proper cookie-persistence callbacks
 *
 * @param {object} api           - The raw FCA API object from nkxfca
 * @param {object} accountInfo   - { tier, stateFile, altFile, email, password }
 * @returns {object}             - The patched api (same reference)
 */
function patchCookieApi(api, accountInfo = {}) {
  if (!api || api.__zaoCookiePatched) return api;

  const log = (msg) => {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: "[ CookiePatch ]: ", color: ["red", "cyan"] },
          { message: msg, color: "white" }
        ]);
        return;
      }
    } catch (_) {}
    console.log("[CookiePatch]", msg);
  };

  // ── 1. Patch the FCA's built-in anti-suspension module ────────────────────
  // The FCA ships its own AntiSuspension singleton. We monkey-patch its
  // _onSuspensionSignalDetected to skip false-positive signal strings.
  try {
    const fcaAntiSuspension = require("@neoaz07/nkxfca/src/utils/antiSuspension");
    const instance = fcaAntiSuspension.globalAntiSuspension;

    if (instance && !instance.__zaoPatchedSignals) {
      const originalDetect = instance.detectSuspensionSignal.bind(instance);
      instance.detectSuspensionSignal = function patchedDetect(text) {
        if (!text || typeof text !== "string") return false;
        const lower = text.toLowerCase();
        // Skip if it matches a known false-positive phrase
        for (const fp of FALSE_POSITIVE_SIGNALS) {
          if (lower === fp || lower.includes(fp)) {
            // Only the full, standalone phrase triggers a false positive skip.
            // If text also contains genuine suspension phrases, let it through.
            const hasRealSignal = [
              "checkpoint", "action_required", "account_locked", "account_suspended",
              "account banned", "account has been disabled", "unusual_activity",
              "verify_your_account", "login_approvals", "bot detected",
              "automated_behavior", "spam_detected", "policy violation"
            ].some(s => lower.includes(s));
            if (!hasRealSignal) return false;
          }
        }
        return originalDetect(text);
      };

      instance.__zaoPatchedSignals = true;
      log("Anti-suspension false-positive filter applied ✓");
    }
  } catch (e) {
    log("Could not patch FCA anti-suspension: " + e.message);
  }

  // ── 2. Cookie persistence — save fresh cookies after any successful action ─
  // The FCA refreshes tokens internally. We hook the getAppState method so
  // every time it's called (e.g. by token refresh) we persist to disk too.
  // _persistPending prevents concurrent setImmediate writes from racing each
  // other and corrupting the JSON file when multiple token refreshes fire in
  // the same event-loop tick.
  if (typeof api.getAppState === "function") {
    const originalGetAppState = api.getAppState.bind(api);
    let _persistPending = false;
    api.getAppState = function patchedGetAppState() {
      const state = originalGetAppState();
      if (Array.isArray(state) && state.length > 0 && accountInfo.stateFile && !_persistPending) {
        _persistPending = true;
        setImmediate(() => {
          _persistPending = false;
          try {
            const data = JSON.stringify(state, null, 2);
            atomicWriteFileSync(accountInfo.stateFile, data, "utf-8");
            if (accountInfo.altFile) {
              atomicWriteFileSync(accountInfo.altFile, data, "utf-8");
            }
          } catch (_) {}
        });
      }
      return state;
    };
  }

  // ── 3. Ensure getBotInfo works with cookie sessions ────────────────────────
  // Some commands call api.getBotInfo(). If the FCA module loaded correctly
  // this should already work, but we add a safe wrapper in case it didn't.
  if (typeof api.getBotInfo !== "function") {
    api.getBotInfo = async function cookieBotInfo() {
      const uid = api.getCurrentUserID ? api.getCurrentUserID() : null;
      if (!uid) return { uid: null };
      try {
        const info = await new Promise((res, rej) => {
          if (typeof api.getUserInfo === "function") {
            api.getUserInfo(uid, (err, data) => {
              if (err) return rej(err);
              res(data && data[uid] ? data[uid] : data);
            });
          } else {
            res({ uid });
          }
        });
        return info || { uid };
      } catch (_) {
        return { uid };
      }
    };
    log("getBotInfo shim installed for cookie session ✓");
  }

  // ── 4. Expose active account tier on the API ───────────────────────────────
  api.__zaoAccountTier     = accountInfo.tier    || 1;
  api.__zaoStateFile       = accountInfo.stateFile;
  api.__zaoAltFile         = accountInfo.altFile;
  api.__zaoLoginMethod     = accountInfo.loginMethod || global.loginMethod || "unknown";

  // ── 5. Fix: ensure setOptions doesn't accidentally disable features ─────────
  // Some calls to setOptions override listenEvents etc. We wrap it to preserve
  // the minimum requirements for cookie-based sessions.
  if (typeof api.setOptions === "function") {
    const originalSetOptions = api.setOptions.bind(api);
    api.setOptions = function patchedSetOptions(opts) {
      const safe = Object.assign({
        listenEvents: true,
        autoReconnect: true,
      }, opts);
      return originalSetOptions(safe);
    };
  }

  api.__zaoCookiePatched = true;
  log(`Cookie patcher active — tier=${api.__zaoAccountTier} method=${api.__zaoLoginMethod} ✓`);
  return api;
}

module.exports = { patchCookieApi, FALSE_POSITIVE_SIGNALS };
