"use strict";

/**
 * nkxfcaPatcher — applies runtime patches to the nkxfca library.
 *
 * All patches work through Node.js's require cache so they survive
 * npm install without touching node_modules directly.
 *
 * Patches:
 *  1. preventLoginHelperHandlers — stops the FCA from registering
 *     duplicate process exit/signal/uncaughtException handlers.
 *
 *  2. patchFcaDatabase — wraps backupAppStateSQL with a 4-second
 *     timeout so SQLITE_BUSY can't stall the login flow.
 *
 *  3. patchLoginHelper — the core fix:
 *     a) Pre-requires loginHelper.js before client.js captures it, so
 *        the wrapped version is what client.js stores as loginHelperModel.
 *     b) Sets MAX_CONCURRENT_REQUESTS=10 so the 60s-per-request × 3-retry
 *        stack can't pile up from a stale concurrency counter.
 *     c) Clears ALL rate-limiter state before login so no leftover window
 *        counts or endpoint cooldowns block the first HTTP request.
 *     d) Forces FCA logging ON so its own progress messages appear.
 *     e) Wraps with try/catch so any unhandled async error is forwarded
 *        to the callback instead of being silently swallowed.
 *     f) Fires a 5-second heartbeat so the log always shows the bot
 *        is alive and which sub-step it is on.
 *
 *  4. disableFcaInternalServices — stops the FCA's own session-monitor,
 *     token-refresh and presence-keepalive timers after login, since
 *     ZAO already has equivalent modules.
 *
 *  5. patchAntiSuspensionLimits — raises daily/hourly caps on the
 *     FCA's globalAntiSuspension instance.
 */

function preventLoginHelperHandlers() {
  if (!process._nkxfcaCleanupRegistered) {
    process._nkxfcaCleanupRegistered = true;
  }
}

/**
 * Wraps backupAppStateSQL with a 4-second timeout so SQLITE_BUSY never
 * freezes loginHelper.
 */
function patchFcaDatabase() {
  try {
    const mod = require("@neoaz07/nkxfca/src/database/appStateBackup");
    if (!mod || mod._zaoPatchedBackup) return;
    const orig = mod.backupAppStateSQL;
    if (typeof orig !== "function") return;
    mod.backupAppStateSQL = function (jar, userID) {
      const t = new Promise(r => setTimeout(r, 4000));
      return Promise.race([orig(jar, userID).catch(() => {}), t]);
    };
    mod._zaoPatchedBackup = true;
  } catch (_) {}
}

/**
 * Resets the FCA rate-limiter sliding windows and cooldown maps so no
 * stale state from a previous request blocks the login flow.
 *
 * Property names confirmed from rateLimiter.js source:
 *   COOLDOWN_DURATION  — thread/endpoint cooldown duration (ms)
 *   MAX_REQUESTS_PER_MINUTE
 *   MAX_CONCURRENT_REQUESTS
 */
function _resetFcaRateLimiter() {
  try {
    const { globalRateLimiter: rl } = require("@neoaz07/nkxfca/src/utils/rateLimiter");
    if (!rl) return;

    // Temporarily lift the concurrency cap so the login GET isn't queued
    rl.MAX_CONCURRENT_REQUESTS = 10;
    // Make sure activeRequests isn't stranded at a non-zero value
    rl.activeRequests = 0;
    // Clear the sliding request window so it can't look globally rate-limited
    if (Array.isArray(rl._requestWindow)) rl._requestWindow.length = 0;
    // Clear per-endpoint windows
    if (rl._endpointWindows && rl._endpointWindows.clear) rl._endpointWindows.clear();
    // Clear thread / endpoint cooldown maps
    if (rl.threadCooldowns && rl.threadCooldowns.clear)   rl.threadCooldowns.clear();
    if (rl.endpointCooldowns && rl.endpointCooldowns.clear) rl.endpointCooldowns.clear();
    // Clear error cache
    if (rl.errorCache && rl.errorCache.clear) rl.errorCache.clear();

    console.log('[PATCH] _resetFcaRateLimiter: done (MAX_CONCURRENT→10, activeRequests→0, windows cleared)');
  } catch (e) {
    console.log('[PATCH] _resetFcaRateLimiter: failed — ' + e.message);
  }
}

/**
 * Pre-patches loginHelper in the require cache BEFORE Emalogin (and
 * therefore client.js) is loaded, so the wrapped version is what
 * client.js captures as loginHelperModel.
 */
function patchLoginHelper() {
  try {
    const lhPath = require.resolve('@neoaz07/nkxfca/src/engine/models/loginHelper');
    const original = require(lhPath);               // populates cache
    if (typeof original !== 'function') {
      console.log('[PATCH] patchLoginHelper: export is not a function — skipping');
      return;
    }
    const cached = require.cache[lhPath];
    if (!cached || cached._zaoPatchedLoginHelper) return;

    async function patchedLoginHelper(credentials, globalOptions, callback, ...rest) {
      const startMs = Date.now();
      console.log('[PATCH] patchedLoginHelper: ENTERED');

      // ── Restore FCA logging so progress messages appear ──────────────────
      try {
        const { logOptions, setLogLevel } = require('@neoaz07/nkxfca/src/utils/constants');
        if (logOptions)   logOptions(true);
        if (setLogLevel)  setLogLevel('info');
      } catch (_) {}

      // ── Clear rate-limiter state so the login GET is never blocked ────────
      _resetFcaRateLimiter();

      // ── Heartbeat: log every 5 seconds while loginHelper is running ───────
      let tick = 0;
      const hb = setInterval(() => {
        tick += 5;
        console.log('[PATCH] patchedLoginHelper: still running — ' + tick + 's elapsed');
      }, 5000);

      let wrappedCallback = callback;
      let callbackCalled = false;
      // Guard the callback so the heartbeat is always cleared
      wrappedCallback = function (...args) {
        if (callbackCalled) return;
        callbackCalled = true;
        clearInterval(hb);
        const outcome = args[0] ? 'ERROR: ' + args[0].message : 'SUCCESS';
        console.log('[PATCH] patchedLoginHelper: callback fired — ' + outcome + ' (took ' + Math.round((Date.now()-startMs)/1000) + 's)');
        try { callback(...args); } catch (_) {}
      };

      try {
        await original(credentials, globalOptions, wrappedCallback, ...rest);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.log('[PATCH] patchedLoginHelper: CAUGHT UNHANDLED ERROR — ' + msg);
        wrappedCallback(err);
      } finally {
        clearInterval(hb);
      }
    }

    cached.exports = patchedLoginHelper;
    cached._zaoPatchedLoginHelper = true;
    console.log('[PATCH] patchLoginHelper: loginHelper wrapped successfully');
  } catch (e) {
    console.log('[PATCH] patchLoginHelper: patch failed — ' + e.message);
  }
}

/**
 * Stops the FCA's internal timers after a successful login.
 * ZAO has keepAlive / mqttHealthCheck / autoRelogin equivalents,
 * so running both doubles HTTP traffic and CPU load.
 */
function disableFcaInternalServices(api) {
  if (!api) return;

  try {
    const { globalAutoReLoginManager } = require("@neoaz07/nkxfca/src/utils/autoReLogin");
    if (globalAutoReLoginManager) {
      globalAutoReLoginManager.stopSessionMonitoring();
      globalAutoReLoginManager.disable();
    }
  } catch (_) {}

  try {
    if (api.tokenRefreshManager) api.tokenRefreshManager.stopAutoRefresh();
  } catch (_) {}

  try {
    const ctx = api.ctx;
    if (ctx) {
      ['_periodicBackupInterval', '_mqttWatchdog', '_autoCycleTimer'].forEach(k => {
        if (ctx[k]) { clearInterval(ctx[k]); ctx[k] = null; }
      });
      ['_reconnectTimer', '_tmsTimeout'].forEach(k => {
        if (ctx[k]) { clearTimeout(ctx[k]); ctx[k] = null; }
      });
    }
  } catch (_) {}

  try {
    const trm = api.tokenRefreshManager;
    if (trm) {
      ['sessionHealthCheckInterval', 'presenceKeepaliveInterval'].forEach(k => {
        if (trm[k]) { clearInterval(trm[k]); trm[k] = null; }
      });
      if (trm.refreshInterval) { clearTimeout(trm.refreshInterval); trm.refreshInterval = null; }
    }
  } catch (_) {}
}

/**
 * Patches nkxfca's getThreadHistory factory to guard e.entity before
 * accessing e.entity.id — Facebook sometimes returns mention ranges with
 * entity: null (e.g. hashtags, page mentions), which causes a TypeError
 * that escapes as an unhandledRejection every time getThreadHistory is called.
 * Must be called before login so nkxfca's client binds the patched factory.
 */
function patchGetThreadHistory() {
  try {
    const modPath = require.resolve('@neoaz07/nkxfca/src/apis/getThreadHistory');
    require(modPath); // populate cache
    const cached = require.cache[modPath];
    if (!cached || cached._zaoPatchedGTH) return;

    const origFactory = cached.exports;
    if (typeof origFactory !== 'function') return;

    cached.exports = function patchedGetThreadHistoryFactory(defaultFuncs, api, ctx) {
      const origFn = origFactory(defaultFuncs, api, ctx);
      return async function getThreadHistory(threadID, amount, timestamp) {
        try {
          return await origFn(threadID, amount, timestamp);
        } catch (err) {
          const msg = String(err && err.message ? err.message : err);
          // Catch the e.entity null crash: "Cannot read properties of null (reading 'id')"
          // Return empty array so callers don't get an unhandled rejection storm.
          if (msg.includes("entity") ||
              (msg.toLowerCase().includes("cannot read") && msg.includes("null"))) {
            console.log('[PATCH] getThreadHistory: entity=null range caught — returning []');
            return [];
          }
          throw err;
        }
      };
    };
    cached._zaoPatchedGTH = true;
    console.log('[PATCH] patchGetThreadHistory: getThreadHistory factory wrapped successfully');
  } catch (e) {
    console.log('[PATCH] patchGetThreadHistory: patch failed — ' + e.message);
  }
}

/**
 * Raises the FCA's globalAntiSuspension caps to production-appropriate
 * values after login.
 */
function patchAntiSuspensionLimits() {
  try {
    const { globalAntiSuspension: gas } = require("@neoaz07/nkxfca/src/utils/antiSuspension");
    if (!gas) return;
    const cfg = (global.config && global.config.nkxModern) || {};
    gas.dailyStats.maxDailyMessages  = Number(cfg.maxDailyMessages)  || 3500;
    gas.hourlyBucket.maxPerHour      = Number(cfg.maxPerHour)        || 280;
    gas.warmup.durationMs            = (Number(cfg.warmupMinutes) || 15) * 60000;
    gas.warmup.maxMessagesPerHour    = Number(cfg.warmupMaxPerHour)  || 80;
  } catch (_) {}
}

module.exports = {
  preventLoginHelperHandlers,
  patchLoginHelper,
  patchFcaDatabase,
  patchGetThreadHistory,
  disableFcaInternalServices,
  patchAntiSuspensionLimits,
};
