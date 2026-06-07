"use strict";

const fs = require("fs-extra");
const path = require("path");

function createLogger() {
  return function log(message, color = "white") {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: "[ NKX ]: ", color: ["red", "cyan"] },
          { message, color }
        ]);
        return;
      }
    } catch (_) {}
    console.log("[NKX]", message);
  };
}

function getCfg() {
  const cfg = global.config?.nkxModern || {};
  return {
    enabled: cfg.enabled !== false,
    enableHealthBroadcast: cfg.enableHealthBroadcast !== false,
    healthBroadcastMinutes: cfg.healthBroadcastMinutes || 15,
    enableWarmup: cfg.enableWarmup !== false,
    warmupMinutes: cfg.warmupMinutes || 20,
    enableCircuitBreaker: cfg.enableCircuitBreaker !== false,
    enableE2EE: cfg.enableE2EE === true,
    postSafeGuard: cfg.postSafeGuard !== false,
    enableTypingWrap: cfg.enableTypingWrap !== false,
    maxSendConcurrency: cfg.maxSendConcurrency || 4,
    sendWindowMs: cfg.sendWindowMs || 60000,
    sendWindowLimit: cfg.sendWindowLimit || 45,
    sqliteCacheFile: cfg.sqliteCacheFile || "cache/nkx-cache.json"
  };
}

function toCallbackStyle(fn, cb) {
  if (typeof cb !== "function") return fn;
  Promise.resolve(fn).then((res) => cb(null, res)).catch((err) => cb(err));
}

module.exports = function modernizeNkxApi(api) {
  if (!api || api.__nkxModernized) return api;
  const log = createLogger();
  const cfg = getCfg();

  // Apply the cookie patcher if it hasn't been applied yet.
  // (Normally called in Emalogin, but this is a safety net.)
  if (!api.__zaoCookiePatched) {
    try {
      const { patchCookieApi } = require("./zaoCookiePatcher");
      patchCookieApi(api, {
        tier: global.activeAccountTier || 1,
        stateFile: global.activeStateFile,
        altFile: global.activeAltFile,
        loginMethod: global.loginMethod || "unknown"
      });
    } catch (e) {
      log("Cookie patcher unavailable: " + (e.message || e), "yellow");
    }
  }

  if (!cfg.enabled) return api;

  const timers = [];
  const safeIntervals = {
    setInterval(fn, ms) {
      const t = setInterval(fn, ms);
      timers.push(t);
      return t;
    },
    setTimeout(fn, ms) {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    }
  };

  const rateState = {
    starts: [],
    active: 0,
    queue: []
  };

  // Size caps prevent unbounded Map growth over long uptimes.
  // When the limit is hit the oldest entries (first inserted) are evicted.
  const CACHE_MAX_THREADS = 800;
  const CACHE_MAX_USERS   = 2000;

  const cache = {
    threads: new Map(),
    users: new Map(),
    dirty: false
  };

  function _evict(map, maxSize) {
    if (map.size <= maxSize) return;
    const excess = map.size - maxSize;
    let i = 0;
    for (const key of map.keys()) {
      if (i++ >= excess) break;
      map.delete(key);
    }
  }

  const cachePath = path.join(process.cwd(), cfg.sqliteCacheFile);
  try {
    if (fs.existsSync(cachePath)) {
      const data = fs.readJsonSync(cachePath);
      for (const [k, v] of Object.entries(data.threads || {})) cache.threads.set(k, v);
      for (const [k, v] of Object.entries(data.users || {})) cache.users.set(k, v);
    }
  } catch (e) {
    log("Cache restore skipped: " + (e.message || e), "yellow");
  }

  async function flushCache() {
    if (!cache.dirty) return;
    try {
      await fs.ensureDir(path.dirname(cachePath));
      await fs.writeJson(
        cachePath,
        {
          threads: Object.fromEntries(cache.threads),
          users: Object.fromEntries(cache.users)
        },
        { spaces: 2 }
      );
      cache.dirty = false;
    } catch (e) {
      log("Cache flush failed: " + (e.message || e), "yellow");
    }
  }

  safeIntervals.setInterval(flushCache, 120000);

  // [FIX Dango] Tightened classifyAuthError — removed "checkpoint", "login", "auth",
  // "cookie", "account" which are far too broad and caused false-positive
  // _triggerAutoRelogin calls on normal FB API errors. Now only matches unambiguous
  // session-invalidation signals. "login" alone matches thousands of normal strings;
  // "account" appears in almost every FB error message.
  function classifyAuthError(errLike) {
    const str = String(
      (errLike && (errLike.error || errLike.message || errLike.reason)) || errLike || ""
    ).toLowerCase();
    return [
      "not logged in",
      "not_logged_in",
      "login_required",
      "session expired",
      "session_expired",
      "not-authorized",
      "invalid token",
      "invalid_token",
      "access token expired"
    ].some((k) => str.includes(k));
  }

  // [FIX M2] — hard queue length cap. Under sustained sendMessage failures
  // the pump() never drains, and each new command pushes another entry
  // onto rateState.queue with no ceiling, growing without bound until the
  // process is OOM-killed. Reject immediately when the queue is full so the
  // caller (command runner) gets a real error instead of a silent memory leak.
  const SEND_QUEUE_MAX = 500;

  async function enqueueSend(run) {
    if (rateState.queue.length >= SEND_QUEUE_MAX) {
      return Promise.reject(new Error(
        `Send queue full (${SEND_QUEUE_MAX} items) — dropping message to prevent memory overflow`
      ));
    }
    return new Promise((resolve, reject) => {
      rateState.queue.push({ run, resolve, reject });
      pump();
    });
  }

  function trimWindow(now) {
    const minTs = now - cfg.sendWindowMs;
    while (rateState.starts.length && rateState.starts[0] < minTs) rateState.starts.shift();
  }

  function jitterDelay() {
    return Math.floor(Math.random() * 300) + 80;
  }

  function pump() {
    if (!rateState.queue.length) return;
    if (rateState.active >= cfg.maxSendConcurrency) return;
    const now = Date.now();
    trimWindow(now);
    if (rateState.starts.length >= cfg.sendWindowLimit) {
      safeIntervals.setTimeout(pump, 400 + jitterDelay());
      return;
    }

    const item = rateState.queue.shift();
    rateState.active++;
    rateState.starts.push(now);

    Promise.resolve()
      .then(item.run)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        rateState.active--;
        safeIntervals.setTimeout(pump, jitterDelay());
      });
  }

  const typing = (() => {
    try {
      return require("./humanTyping");
    } catch (_) {
      return null;
    }
  })();

  const original = {
    sendMessage: typeof api.sendMessage === "function" ? api.sendMessage.bind(api) : null,
    listenMqtt: typeof api.listenMqtt === "function" ? api.listenMqtt.bind(api) : null,
    getThreadInfo: typeof api.getThreadInfo === "function" ? api.getThreadInfo.bind(api) : null,
    getUserInfo: typeof api.getUserInfo === "function" ? api.getUserInfo.bind(api) : null
  };

  const customAntiSuspension = (() => {
    try { return require("./antiSuspension").globalAntiSuspension; } catch (_) { return null; }
  })();

  const _msgHashGuard = (() => {
    try { return require("./messageHashGuard"); } catch (_) { return null; }
  })();

  if (original.sendMessage) {
    api.sendMessage = function patchedSendMessage(form, threadID, callback, replyToMessage) {
      const run = async () => {
        // ── Duplicate-message dedup check ──────────────────────────────────────
        if (_msgHashGuard) {
          try {
            const msgText = form && (typeof form === "string" ? form : (form.body || ""));
            if (msgText) {
              const mhgResult = _msgHashGuard.checkOutbound(threadID, msgText);
              if (!mhgResult.allow) {
                log(`[MHG] Skipped duplicate outbound to ${threadID}: ${mhgResult.reason}`, "yellow");
                return null;
              }
            }
          } catch (_) {}
        }

        if (customAntiSuspension) {
          try { await customAntiSuspension.prepareBeforeMessage(threadID, form); } catch (_) {}
        }
        if (cfg.enableTypingWrap && typing) {
          const d = typing.calcDelay(form, threadID);
          if (d > 0) await typing.simulateTyping(api, threadID, d);
        }
        return new Promise((resolve, reject) => {
          original.sendMessage(form, threadID, (err, info) => {
            if (err && customAntiSuspension) {
              try { customAntiSuspension.checkAccountHealth(err); } catch (_) {}
            }
            if (!err && _msgHashGuard) {
              try {
                const msgText = form && (typeof form === "string" ? form : (form.body || ""));
                if (msgText) _msgHashGuard.recordOutboundSuccess(threadID, msgText);
              } catch (_) {}
            }
            if (err && cfg.postSafeGuard && classifyAuthError(err) && typeof global._triggerAutoRelogin === "function") {
              global._triggerAutoRelogin(err);
            }
            // ── Send-failure detector (white/accountRotator pattern) ─────────
            try {
              const sfd = require('./sendFailureDetector');
              if (err) sfd.onSendFailure(err);
              else     sfd.onSendSuccess();
            } catch (_) {}
            if (err) return reject(err);
            resolve(info);
          }, replyToMessage);
        });
      };

      const p = enqueueSend(run);
      if (typeof callback === "function") {
        p.then((info) => callback(null, info)).catch((err) => callback(err));
        return;
      }
      return p;
    };
  }

  if (original.getThreadInfo) {
    api.getThreadInfo = function patchedGetThreadInfo(threadID, callback) {
      const key = String(threadID);
      const fromCache = cache.threads.get(key);
      if (fromCache) return toCallbackStyle(Promise.resolve(fromCache), callback);
      const p = Promise.resolve(original.getThreadInfo(threadID)).then((info) => {
        if (info) {
          cache.threads.set(key, info);
          _evict(cache.threads, CACHE_MAX_THREADS);
          cache.dirty = true;
        }
        return info;
      });
      return toCallbackStyle(p, callback);
    };
  }

  if (original.getUserInfo) {
    api.getUserInfo = function patchedGetUserInfo(userID, callback) {
      const key = String(userID);
      const fromCache = cache.users.get(key);
      if (fromCache) return toCallbackStyle(Promise.resolve({ [key]: fromCache }), callback);
      const p = Promise.resolve(original.getUserInfo(userID)).then((info) => {
        const data = info && info[key] ? info[key] : null;
        if (data) {
          cache.users.set(key, data);
          _evict(cache.users, CACHE_MAX_USERS);
          cache.dirty = true;
        }
        return info;
      });
      return toCallbackStyle(p, callback);
    };
  }

  if (original.listenMqtt) {
    let attempts = 0;
    api.listenMqtt = function patchedListenMqtt(handler) {
      const wrapped = (err, event) => {
        if (!err) {
          attempts = 0;
          return handler(err, event);
        }

        const authErr = classifyAuthError(err);
        if (authErr && typeof global._triggerAutoRelogin === "function") {
          global._triggerAutoRelogin(err);
        }

        if (!authErr && typeof global._restartListener === "function") {
          attempts++;
          const backoff = Math.min(45000, (2 ** Math.min(attempts, 6)) * 500 + Math.floor(Math.random() * 1000));
          log(`MQTT error detected, scheduling reconnect in ${Math.round(backoff / 1000)}s`, "yellow");
          safeIntervals.setTimeout(() => {
            try {
              global._restartListener();
            } catch (_) {}
          }, backoff);
        }

        return handler(err, event);
      };
      return original.listenMqtt(wrapped);
    };
  }

  if (cfg.enableCircuitBreaker) {
    try {
      const { globalAntiSuspension } = require("./antiSuspension");
      global.nkx = global.nkx || {};
      global.nkx.tripCircuit = (reason, ms) => globalAntiSuspension.tripCircuitBreaker(reason || "manual", ms || 30 * 60 * 1000);
      global.nkx.resetCircuit = () => globalAntiSuspension.resetCircuitBreaker();
      global.nkx.getCircuit = () => globalAntiSuspension.getConfig();
      log("Circuit breaker controls attached.", "green");
    } catch (e) {
      log("Circuit breaker hooks unavailable: " + (e.message || e), "yellow");
    }
  }

  if (cfg.enableWarmup) {
    try {
      const { globalAntiSuspension } = require("./antiSuspension");
      globalAntiSuspension.enableWarmup();
      log(`Warmup mode enabled for ${cfg.warmupMinutes} minutes.`, "green");
    } catch (e) {
      log("Warmup hook unavailable: " + (e.message || e), "yellow");
    }
  }

  if (cfg.enableE2EE && api.e2ee && typeof api.e2ee.enable === "function") {
    try {
      api.e2ee.enable();

      // ── Load persisted key pair + peer keys ──────────────────
      const keyManager = (() => {
        try { return require("./e2ee/keyManager"); } catch (_) { return null; }
      })();
      if (keyManager) keyManager.load(api);

      // ── If bot has no key pair yet, generate one and save it ─
      if (!api.e2ee.getPublicKey) {
        log("E2EE: getPublicKey not available — skipping key init.", "yellow");
      } else {
        try {
          api.e2ee.getPublicKey();
          if (keyManager) keyManager.save(api);
          log("E2EE key pair ready. Bot public key: " + api.e2ee.getPublicKey().slice(0, 20) + "…", "green");
        } catch (e) {
          log("E2EE key init warning: " + (e.message || e), "yellow");
        }
      }

      // ── Auto-encrypt outgoing messages ────────────────────────
      if (original.sendMessage) {
        const _origSend = api.sendMessage.bind(api);
        api.sendMessage = function e2eeSendMessage(form, threadID, callback, replyToMessage) {
          let encryptedForm = form;
          try {
            const e2eeCfg = global.config?.e2ee || {};
            if (e2eeCfg.autoEncryptDMs !== false && api.e2ee.isEnabled() && api.e2ee.hasPeer(threadID)) {
              if (typeof form === "string") {
                encryptedForm = api.e2ee.encrypt(threadID, form);
              } else if (form && typeof form === "object" && typeof form.body === "string") {
                encryptedForm = Object.assign({}, form, { body: api.e2ee.encrypt(threadID, form.body) });
              }
            }
          } catch (encErr) {
            log("E2EE encrypt skipped: " + (encErr.message || encErr), "yellow");
          }
          return _origSend(encryptedForm, threadID, callback, replyToMessage);
        };
      }

      // ── Auto-decrypt incoming messages ────────────────────────
      if (original.listenMqtt) {
        const _origListenMqtt = api.listenMqtt.bind(api);
        api.listenMqtt = function e2eeListenMqtt(handler) {
          const decryptingHandler = (err, event) => {
            if (!err && event && typeof event.body === "string" && event.body.startsWith(".NKX-E2EE|")) {
              try {
                const e2eeCfg = global.config?.e2ee || {};
                if (e2eeCfg.autoDecryptIncoming !== false && api.e2ee.isEnabled()) {
                  const plain = api.e2ee.decrypt(event.threadID, event.body);
                  if (plain !== null) event.body = plain;
                }
              } catch (_) {}
            }
            return handler(err, event);
          };
          return _origListenMqtt(decryptingHandler);
        };
      }

      log("E2EE enabled: auto-encrypt outgoing ✓ auto-decrypt incoming ✓", "green");
    } catch (e) {
      log("E2EE enable failed: " + (e.message || e), "yellow");
    }
  }

  if (cfg.enableHealthBroadcast && typeof api.getHealthStatus === "function") {
    safeIntervals.setInterval(() => {
      try {
        const health = api.getHealthStatus();
        global.nkx = global.nkx || {};
        global.nkx.health = health;
        const mqttHealthy = health?.mqtt?.isConnected ?? health?.mqttConnected;
        log(
          `Health mqtt=${String(mqttHealthy)} queue=${rateState.queue.length} active=${rateState.active}`,
          "white"
        );
      } catch (_) {}
    }, cfg.healthBroadcastMinutes * 60 * 1000);
  }

  if (typeof api.refreshFb_dtsg === "function") {
    safeIntervals.setInterval(async () => {
      try {
        await api.refreshFb_dtsg();
      } catch (_) {}
    }, (45 + Math.floor(Math.random() * 30)) * 60 * 1000);
  }

  api.__nkxModernized = true;
  api.__nkxModernizerStop = async function stopNkxModernizer() {
    for (const t of timers) {
      try {
        clearInterval(t);
        clearTimeout(t);
      } catch (_) {}
    }
    await flushCache();
  };

  log("NKX modernizer enabled.", "green");
  return api;
};
