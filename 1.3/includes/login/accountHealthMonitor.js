"use strict";

/**
 * AccountHealthMonitor
 * =====================
 * Two independent health signals are watched simultaneously:
 *
 * @debugger Djamel — Enhanced messaging-block detection patterns,
 *   added periodic account status broadcast to admins,
 *   added messaging-restriction detection separate from full session death.
 *
 * 1. PERIODIC COOKIE SCAN — every CHECK_INTERVAL_MS, the live cookie is
 *    validated against Facebook.  A confirmed-dead response triggers
 *    autoRelogin() (which already handles tier advancement).
 *
 * 2. SEND-FAILURE WATCHDOG — every api.sendMessage call that returns an
 *    error is classified:
 *      • Auth / session errors → already handled by nkxfcaModernizer +
 *        _triggerAutoRelogin.  We ignore them here to avoid double-firing.
 *      • "Message couldn't be sent" / generic send errors → counted in a
 *        sliding window.  After SEND_FAIL_THRESHOLD failures within
 *        SEND_FAIL_WINDOW_MS the health monitor calls forceTierSwitch()
 *        to jump to the next account immediately.
 *
 * The module wraps api.sendMessage once (idempotent guard) so it is safe
 * to call start() multiple times or after a hot-reload.
 */

const checkLiveCookie  = require("./checkLiveCookie");
const autoRelogin      = require("./autoRelogin");

// ── Tunables ──────────────────────────────────────────────────────────────
// [FIX Djamel] — cookie scan was every 5 min = 12/h = 36 page loads/h
// (mbasic + home + m fallbacks). Combined with the keepAlive ping every
// 8-18 min, the bot generated ~50 silent page loads per hour with no user
// activity — a clear automation fingerprint. Scan every 25-35 min instead
// (jittered) and skip entirely while a relogin is in flight.
const CHECK_INTERVAL_MS      = 30 * 60 * 1000;   // base cookie health scan period
const CHECK_JITTER_MS        = 10 * 60 * 1000;   // ± random spread on top
const SEND_FAIL_THRESHOLD    = 3;                 // failures before tier switch
const SEND_FAIL_WINDOW_MS    = 5  * 60 * 1000;   // sliding window for failures
const SWITCH_COOLDOWN_MS     = 8  * 60 * 1000;   // min time between switches (was 3 — too jumpy)
const HEALTH_LOG_PREFIX      = "[ HEALTH ]: ";

// ── Auth-error keywords (these are already handled by nkxfcaModernizer) ──
const AUTH_KEYWORDS = [
  "checkpoint", "login", "session expired", "not-authorized",
  "auth", "cookie", "invalid token", "account"
];

// ── Send-error patterns that indicate the account can't send ─────────────
// Facebook error codes / messages that mean the account is restricted
// [ENHANCED Djamel] — Added more FB error codes and messaging-block patterns
const SEND_BLOCKED_PATTERNS = [
  "send message failed",
  "message couldn",         // "message couldn't be sent"
  "couldn't send",
  "not allowed to send",
  "blocked from sending",
  "temporarily blocked",
  "rate limited",
  "feature temporarily",
  "spam",
  "error 1545012",          // not in conversation — not an account issue per se
  '"error":200',            // FB API error 200 = permissions
  '"error":368',            // FB API blocked / messaging disabled
  '"error":190',            // OAuth token error
  '"error":1357004',        // messaging blocked
  '"error":1357031',        // can't send to this person right now
  '"error":506',            // duplicate post / flood
  '"error":100',            // invalid parameter / action not allowed
  '"error":613',            // rate limit for this endpoint
  '"error":2000',           // temporarily unavailable
  '"error":10',             // permission denied
  "action blocked",
  "you can't send",
  "you cannot send",
  "your account has been restricted",
  "messaging restricted",
  "you've been blocked",
  "unable to send",
  "message limit",
  "too many messages",
  "send limit",
  "you're temporarily blocked from sending",
];

// ── State ─────────────────────────────────────────────────────────────────
let _started          = false;
let _checkTimer       = null;
let _statusBroadcastTimer = null;   // [FIX] track so _stop() can clear it
let _lastSwitch       = 0;
let _sendFailTimes    = [];   // timestamps of recent send failures
let _lastCookieScan   = { result: "pending", ts: null };

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: HEALTH_LOG_PREFIX, color: ["red", "cyan"] },
        { message: msg,               color: "white"          }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[HEALTH]", msg);
}

function _isAuthError(errStr) {
  const s = errStr.toLowerCase();
  return AUTH_KEYWORDS.some(k => s.includes(k));
}

function _isSendBlockedError(errStr) {
  const s = errStr.toLowerCase();
  return SEND_BLOCKED_PATTERNS.some(p => s.includes(p));
}

/**
 * Prune send-fail timestamps outside the sliding window,
 * then record the new one and return the current count.
 */
function _recordSendFailure() {
  const now    = Date.now();
  const cutoff = now - SEND_FAIL_WINDOW_MS;
  _sendFailTimes = _sendFailTimes.filter(t => t > cutoff);
  _sendFailTimes.push(now);
  return _sendFailTimes.length;
}

function _resetSendFailures() {
  _sendFailTimes = [];
}

/**
 * Trigger a tier switch, respecting a cooldown to prevent rapid looping.
 */
async function _triggerSwitch(api, reason) {
  const now = Date.now();
  if (now - _lastSwitch < SWITCH_COOLDOWN_MS) {
    _log(`Switch cooldown active — suppressing duplicate switch. Reason: ${reason}`);
    return;
  }
  _lastSwitch = now;
  _resetSendFailures();
  _log(`Triggering tier switch — ${reason}`);
  try {
    await autoRelogin.forceTierSwitch(api, reason);
  } catch (e) {
    _log(`forceTierSwitch threw: ${e.message || e}`);
  }
}

/**
 * Wrap api.sendMessage to intercept send errors.
 * Only wraps once (checked via a flag on the api object).
 */
function _patchSendMessage(api) {
  if (api.__healthMonitorPatched) return;
  api.__healthMonitorPatched = true;

  const original = api.sendMessage.bind(api);

  api.sendMessage = function monitoredSendMessage(form, threadID, callback, replyToMessage) {
    const run = async () => {
      return new Promise((resolve, reject) => {
        original(form, threadID, (err, info) => {
          if (err) {
            const errStr = String(err.message || err.error || err || "");

            // Skip auth errors — nkxfcaModernizer already handles those
            if (!_isAuthError(errStr)) {
              const isSendBlocked = _isSendBlockedError(errStr);
              // Count ALL non-auth errors (including generic send failures)
              const failCount = _recordSendFailure();

              _log(`Send error (${isSendBlocked ? "BLOCKED" : "generic"}) — ${errStr.slice(0, 120)} | window failures: ${failCount}/${SEND_FAIL_THRESHOLD}`);

              if (failCount >= SEND_FAIL_THRESHOLD) {
                // Fire-and-forget — don't block the callback
                _triggerSwitch(api, `${failCount} send failures in ${SEND_FAIL_WINDOW_MS / 60000} min — last: ${errStr.slice(0, 100)}`);
              }
            }

            return reject(err);
          }
          // Successful send → reset the failure window
          _resetSendFailures();
          resolve(info);
        }, replyToMessage);
      });
    };

    const p = run();
    if (typeof callback === "function") {
      p.then(info => callback(null, info)).catch(e => callback(e));
      return;
    }
    return p;
  };
}

/**
 * Run one periodic cookie-health scan.
 */
async function _runCookieScan(api) {
  try {
    let cookieStr = null;

    // Build a cookie string from the current app state
    const appState = api.getAppState ? api.getAppState() : [];
    if (Array.isArray(appState) && appState.length > 0) {
      cookieStr = appState
        .filter(c => c && c.key && c.value)
        .map(c => `${c.key}=${c.value}`)
        .join("; ");
    }

    if (!cookieStr) {
      _log("Cookie scan: no cookies available — skipping.");
      return;
    }

    const alive = await checkLiveCookie(cookieStr);

    if (alive === false) {
      _lastCookieScan = { result: "dead", ts: Date.now() };
      _log("Cookie scan: session CONFIRMED DEAD — triggering auto re-login.");
      if (typeof global._triggerAutoRelogin === "function") {
        global._triggerAutoRelogin("health-monitor: cookie scan confirmed dead session");
      } else {
        autoRelogin(api, "health-monitor: cookie scan confirmed dead session").catch(() => {});
      }
    } else if (alive === true) {
      _lastCookieScan = { result: "alive", ts: Date.now() };
      _log("Cookie scan: session alive ✓");
    } else {
      _lastCookieScan = { result: "uncertain", ts: Date.now() };
      _log("Cookie scan: result uncertain (network issue) — no action.");
    }
  } catch (e) {
    _log(`Cookie scan threw: ${e.message || e}`);
  }
}

/**
 * Start the health monitor.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param {object} api  FCA API instance
 */
function start(api) {
  if (!api) return;
  if (_started) {
    // If already started but api changed (e.g. after tier switch), re-patch
    _patchSendMessage(api);
    return;
  }
  _started = true;

  _log("Account Health Monitor started.");
  _log(`  Cookie scan every ${CHECK_INTERVAL_MS / 60000} min`);
  _log(`  Send-fail threshold: ${SEND_FAIL_THRESHOLD} errors in ${SEND_FAIL_WINDOW_MS / 60000} min → tier switch`);

  // Patch sendMessage on the current api
  _patchSendMessage(api);

  // Also re-patch whenever the api reference changes (e.g. after relogin)
  const _origSetApi = global.__setHealthApi;
  global.__setHealthApi = function (newApi) {
    if (newApi && newApi !== api) {
      _patchSendMessage(newApi);
    }
    if (_origSetApi) _origSetApi(newApi);
  };

  // [FIX Djamel] — jittered cookie scan instead of fixed setInterval.
  // Predictable polling on the same 5-min boundary is itself a fingerprint
  // (rolled-up access logs at FB show neat 5-min spikes). Scheduling each
  // next run with random jitter spreads the load and looks human.
  function _scheduleNextScan() {
    const jitter = Math.floor((Math.random() - 0.5) * 2 * CHECK_JITTER_MS);
    const delay  = Math.max(60 * 1000, CHECK_INTERVAL_MS + jitter);
    _checkTimer = setTimeout(async () => {
      // Don't fight an active relogin — the cookies may be in flight.
      if (!global.isRelogining) {
        try { await _runCookieScan(api); } catch (_) {}
      }
      _scheduleNextScan();
    }, delay);
  }
  _scheduleNextScan();

  // Run an initial scan after a short, randomised delay (90-180 s) so a
  // restart loop doesn't slam FB with simultaneous validations.
  setTimeout(() => _runCookieScan(api), 90 * 1000 + Math.floor(Math.random() * 90 * 1000));

  // [ADDED Djamel] — Periodic account health status broadcast to admins
  // Every 60 minutes, sends a brief status report so admins know the account is alive.
  const STATUS_BROADCAST_MS = 60 * 60 * 1000;
  if (_statusBroadcastTimer) { try { clearInterval(_statusBroadcastTimer); } catch (_) {} }
  _statusBroadcastTimer = setInterval(() => {
    try {
      // [FIX] Skip the broadcast while a relogin is in flight — the api
      // reference is mid-swap and any send call here just floods the
      // health-monitor's own send-failure window with garbage failures.
      if (global.isRelogining) return;

      const now     = Date.now();
      const cutoff  = now - SEND_FAIL_WINDOW_MS;
      const fails   = _sendFailTimes.filter(t => t > cutoff).length;
      const tier    = global.activeAccountTier || 1;
      const scanTs  = _lastCookieScan.ts
        ? new Date(_lastCookieScan.ts).toISOString().replace("T", " ").slice(0, 19)
        : "never";
      const scanRes = _lastCookieScan.result || "pending";
      const uptime  = global._botStartTime
        ? Math.floor((now - global._botStartTime) / 60000) + " min"
        : "unknown";

      const admins = global.config?.ADMINBOT || [];
      // [FIX] Always use the live api reference — the original captured
      // `api` would be stale after a tier switch.
      const botApi = global._botApi || api;
      if (!botApi || !admins.length) return;

      const msg =
        `📊 تقرير صحة الحساب الدوري\n\n` +
        `🏦 الحساب النشط: Tier ${tier}\n` +
        `⏱ وقت التشغيل: ${uptime}\n` +
        `🍪 آخر فحص كوكيز: ${scanTs} (${scanRes})\n` +
        `❌ أخطاء الإرسال (${SEND_FAIL_WINDOW_MS / 60000} دقيقة): ${fails}/${SEND_FAIL_THRESHOLD}\n` +
        `✅ البوت يعمل بشكل طبيعي`;

      for (const adminID of admins) {
        const id = String(adminID).trim();
        if (!id) continue;
        try {
          const p = botApi.sendMessage(msg, id);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }
    } catch (_) {}
  }, STATUS_BROADCAST_MS);
  if (typeof _statusBroadcastTimer.unref === 'function') _statusBroadcastTimer.unref();

  // Cleanup on process exit
  process.once("exit",    _stop);
  process.once("SIGTERM", _stop);
}

function _stop() {
  // [FIX Djamel] — clear both interval & timeout (the scheduler now uses
  // setTimeout for jitter, but older codepaths still set an interval).
  if (_checkTimer) {
    try { clearTimeout(_checkTimer); } catch (_) {}
    try { clearInterval(_checkTimer); } catch (_) {}
    _checkTimer = null;
  }
  // [FIX] Also clear the periodic status broadcast — without this it
  // kept ticking after stop() and held the event loop open.
  if (_statusBroadcastTimer) {
    try { clearInterval(_statusBroadcastTimer); } catch (_) {}
    _statusBroadcastTimer = null;
  }
  _started = false;
}

/**
 * Return a snapshot of the health monitor's current state.
 * Used by the /bot/health panel API endpoint.
 */
function getStatus() {
  const now    = Date.now();
  const cutoff = now - SEND_FAIL_WINDOW_MS;
  const windowFailures = _sendFailTimes.filter(t => t > cutoff).length;
  return {
    sendFailCount:  windowFailures,
    sendFailWindow: SEND_FAIL_WINDOW_MS,
    lastCookieScan: _lastCookieScan
  };
}

module.exports = { start, getStatus };
