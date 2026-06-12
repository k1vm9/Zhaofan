'use strict';
/**
 * mqttHealthCheck.js  v2 — UPGRADED
 *
 * MQTT silence watchdog — upgraded with:
 * - Network probe pre-check before burning a restart slot (avoids wasted
 *   re-logins on transient Replit network blips)
 * - Double-confirm: waits 60 s after detecting silence, checks again before
 *   restarting — eliminates false positives from brief FB server pauses
 * - Auto-reset of restartCount after 20 min of continuous healthy activity
 * - Smarter backoff reset: resets immediately when MQTT recovers, not after
 *   a full restart cycle
 * - Per-restart reason history (last 5) for /bot/mqtt-status diagnostics
 * - Configurable via ZAO-SETTINGS.json with sane hardened defaults
 */

const networkProbe = (() => {
  try { return require('./networkProbe'); } catch (_) { return null; }
})();

let healthTimer         = null;
let restartCount        = 0;
let backoffMs           = 0;
let lastRestartTs       = null;
let lastRestartReason   = null;
let lastSuccessTime     = Date.now();
let _healthyResetTimer  = null;  // auto-resets restartCount after healthy stretch
const _restartHistory   = [];    // last 5 restart reasons + timestamps

// FIX: expose a function to reset counters when MQTT is healthy.
// Called by MQTT patches/listeners whenever a TRUE MQTT message is received.
// Sets global.lastMqttOnlyActivity — separate from keepAlive ping timestamps.
function onMqttActivity() {
  const now = Date.now();
  // Primary: true MQTT-only timestamp (not polluted by keepAlive HTTP pings)
  global.lastMqttOnlyActivity = now;
  // Keep lastMqttActivity updated for backwards compatibility with other modules
  global.lastMqttActivity = now;

  // If we've been healthy for a bit, reset restart counters.
  if (restartCount > 0 && (now - lastSuccessTime) > 5 * 60 * 1000) {
    restartCount    = 0;
    backoffMs       = 0;
    lastSuccessTime = now;
    log('info', 'MQTT is healthy — restart counter reset.');
  }
}

function getConfig() {
  const cfg = (global.config && global.config.mqttHealthCheck) || {};
  return {
    enable:               cfg.enable !== false,
    silentTimeoutMs:      (cfg.silentTimeoutMinutes  || 8)  * 60 * 1000,
    checkIntervalMinMs:   (cfg.checkIntervalMinMinutes || 2) * 60 * 1000,
    checkIntervalMaxMs:   (cfg.checkIntervalMaxMinutes || 4) * 60 * 1000,
    maxRestarts:          cfg.maxRestarts          || 8,
    notifyAdmins:         cfg.notifyAdmins         !== false,
    backoffMultiplier:    cfg.backoffMultiplier     || 1.8,
    maxBackoffMs:         (cfg.maxBackoffMinutes    || 20)  * 60 * 1000,
    doubleConfirmMs:      (cfg.doubleConfirmSeconds || 60)  * 1000,
    healthyResetMs:       (cfg.healthyResetMinutes  || 20)  * 60 * 1000
  };
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: '[ MQTT-HEALTH ]: ', color: ['red', 'cyan'] },
        { message: msg, color: level === 'warn' ? 'yellow' : 'white' }
      ]);
      return;
    }
  } catch (_) {}
  console[level === 'error' ? 'error' : 'log']('[MQTT-HEALTH]', msg);
}

function sendAdminMessage(message) {
  try {
    const api    = global._botApi;
    const admins = (global.config && global.config.ADMINBOT) || [];
    if (!api) return;
    for (const adminID of admins) {
      const id = String(adminID).trim();
      if (!id) continue;
      api.sendMessage(message, id).catch(() => {});
    }
  } catch (_) {}
}

/** Touch the healthy-reset timer whenever MQTT is alive. */
function _armHealthyReset(cfg) {
  if (_healthyResetTimer) { clearTimeout(_healthyResetTimer); _healthyResetTimer = null; }
  _healthyResetTimer = setTimeout(() => {
    if (restartCount > 0) {
      log('info', `MQTT سليم منذ ${Math.round(cfg.healthyResetMs / 60000)} دقيقة — إعادة تعيين عداد الإعادة.`);
      restartCount = 0;
      backoffMs    = 0;
    }
    _healthyResetTimer = null;
  }, cfg.healthyResetMs);
  if (_healthyResetTimer.unref) _healthyResetTimer.unref();
}

async function doHealthCheck() {
  const cfg = getConfig();
  if (!cfg.enable) return scheduleNextCheck();

  const api = global._botApi;
  if (!api) return scheduleNextCheck();

  // Prefer true MQTT-only activity — not polluted by keepAlive HTTP pings
  const lastActivity = global.lastMqttOnlyActivity || global.lastMqttActivity || global._botStartTime || Date.now();
  const silentFor    = Date.now() - lastActivity;

  // MQTT alive — arm healthy-reset timer and bail early
  if (silentFor < cfg.silentTimeoutMs) {
    // Immediate recovery reset (prevents long backoff after a quick blip)
    if (restartCount > 0) {
      restartCount    = 0;
      backoffMs       = 0;
      lastSuccessTime = Date.now();
      log('info', 'MQTT recovered — counters reset.');
    } else {
      backoffMs = 0;
    }
    _armHealthyReset(cfg);
    return scheduleNextCheck();
  }

  // Skip if already re-logging in
  if (global.isRelogining) {
    log('warn', 'إعادة تسجيل الدخول جارية — تخطي فحص MQTT.');
    return scheduleNextCheck();
  }

  // ── DOUBLE CONFIRM ────────────────────────────────────────────────────────
  // Wait doubleConfirmMs then re-read lastMqttActivity before restarting.
  // A brief FB server pause can look like silence; this eliminates false trips.
  const confirmWaitMs = Math.min(cfg.doubleConfirmMs, 60 * 1000);
  log('warn',
    `صمت MQTT منذ ${Math.round(silentFor / 60000)} دقيقة — التأكيد المزدوج بعد ${Math.round(confirmWaitMs / 1000)} ثانية...`
  );
  await new Promise(r => setTimeout(r, confirmWaitMs));

  const latestActivity = global.lastMqttOnlyActivity || global.lastMqttActivity || global._botStartTime || lastActivity;
  const latestSilentFor = Date.now() - latestActivity;
  if (latestSilentFor < cfg.silentTimeoutMs) {
    log('info', 'MQTT استعاد النشاط أثناء التأكيد المزدوج — إلغاء الإعادة.');
    backoffMs = 0;
    return scheduleNextCheck();
  }

  // ── NETWORK PROBE ─────────────────────────────────────────────────────────
  // Don't burn a restart slot if Facebook itself is unreachable from Replit.
  if (networkProbe) {
    try {
      const reachable = await networkProbe.isFacebookReachable({ ttlMs: 0 });
      if (!reachable) {
        log('warn', 'فيسبوك غير قابل للوصول — تخطي إعادة تشغيل MQTT (مشكلة شبكة وليس جلسة).');
        return scheduleNextCheck();
      }
    } catch (_) {}
  }

  // ── MAX RESTARTS CHECK ────────────────────────────────────────────────────
  if (restartCount >= cfg.maxRestarts) {
    log('error',
      `تجاوز الحد الأقصى (${cfg.maxRestarts} محاولة). إيقاف watchdog. يلزم تدخل يدوي.`
    );
    stopHealthCheck();
    if (cfg.notifyAdmins) {
      sendAdminMessage(
        `⛔ MQTT صحة البوت\n\n` +
        `أُعيد تشغيل MQTT ${cfg.maxRestarts} مرة بدون استرداد.\n` +
        `يتطلب تدخلاً يدوياً — افحص cookies / tier.`
      );
    }
    return;
  }

  // ── BACKOFF ───────────────────────────────────────────────────────────────
  if (backoffMs > 0) {
    log('warn', `انتظار backoff ${Math.round(backoffMs / 1000)} ثانية...`);
    await new Promise(r => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * cfg.backoffMultiplier, cfg.maxBackoffMs);
  } else {
    backoffMs = randomBetween(20000, 50000);
  }

  restartCount++;
  const silentMinutes = Math.round(latestSilentFor / 60000);
  log('warn',
    `لا نشاط MQTT منذ ${silentMinutes} دقيقة — إعادة تشغيل المستمع (${restartCount}/${cfg.maxRestarts})...`
  );

  // Record in history ring (keep last 5)
  _restartHistory.push({ ts: Date.now(), reason: `silence-${silentMinutes}min`, count: restartCount });
  if (_restartHistory.length > 5) _restartHistory.shift();

  if (cfg.notifyAdmins) {
    sendAdminMessage(
      `⚠️ MQTT صمت ${silentMinutes} دقيقة\n` +
      `إعادة تشغيل #${restartCount} من ${cfg.maxRestarts}...`
    );
  }

  if (typeof global._restartListener !== 'function') {
    log('warn', 'دالة _restartListener غير متوفرة — تأجيل. عداد غير محروق.');
    global.lastMqttActivity = Date.now();
    lastSuccessTime = Date.now();
    restartCount = Math.max(0, restartCount - 1);
    return scheduleNextCheck();
  }

  try {
    if (global.handleListen) {
      try { global.handleListen.stopListening(); } catch (_) {}
    }
    const pauseMs = randomBetween(1000, 3000);
    await new Promise(r => setTimeout(r, pauseMs));

    const restartReason = `mqtt-health-${restartCount}-of-${cfg.maxRestarts}`;
    lastRestartTs     = Date.now();
    lastRestartReason = restartReason;
    log('info', 'تنفيذ _restartListener لاسترداد MQTT...');
    global._restartListener(restartReason);
  } catch (e) {
    log('error', 'خطأ أثناء إعادة التشغيل: ' + (e && e.message ? e.message : String(e)));
  }

  scheduleNextCheck();
}

function scheduleNextCheck() {
  if (healthTimer) clearTimeout(healthTimer);
  const cfg   = getConfig();
  if (!cfg.enable) return;
  const delay   = randomBetween(cfg.checkIntervalMinMs, cfg.checkIntervalMaxMs);
  const minutes = (delay / 60000).toFixed(1);
  log('info', `الفحص القادم بعد ${minutes} دقيقة`);
  healthTimer = setTimeout(doHealthCheck, delay);
  if (healthTimer.unref) healthTimer.unref();
}

function startHealthCheck() {
  if (healthTimer) clearTimeout(healthTimer);
  restartCount      = 0;
  backoffMs         = 0;
  lastRestartTs     = null;
  lastRestartReason = null;
  global.lastMqttActivity = Date.now();
  lastSuccessTime         = Date.now();

  const cfg = getConfig();
  if (!cfg.enable) {
    log('info', 'فحص صحة MQTT معطّل في الإعدادات.');
    return;
  }

  log('info',
    `بدأ — فحص كل ${cfg.checkIntervalMinMs / 60000}–${cfg.checkIntervalMaxMs / 60000} دقيقة (عشوائي)، ` +
    `صمت > ${cfg.silentTimeoutMs / 60000} دقيقة → تأكيد مزدوج → إعادة تشغيل`
  );
  scheduleNextCheck();
}

function stopHealthCheck() {
  if (healthTimer) clearTimeout(healthTimer);
  if (_healthyResetTimer) clearTimeout(_healthyResetTimer);
  healthTimer = null;
  _healthyResetTimer = null;
}

function getStatus() {
  const cfg         = getConfig();
  const now         = Date.now();
  const lastActivity = global.lastMqttActivity || null;
  const silentForMs  = lastActivity ? (now - lastActivity) : null;
  return {
    enabled:           cfg.enable,
    watcherActive:     healthTimer !== null,
    mqttAlive:         lastActivity ? silentForMs < 120000 : false,
    silentForMs,
    silentForSec:      silentForMs !== null ? Math.floor(silentForMs / 1000) : null,
    silentTimeoutMs:   cfg.silentTimeoutMs,
    lastActivity:      lastActivity ? new Date(lastActivity).toISOString() : null,
    restartCount,
    maxRestarts:       cfg.maxRestarts,
    backoffMs,
    lastRestartTs:     lastRestartTs ? new Date(lastRestartTs).toISOString() : null,
    lastRestartReason,
    restartHistory:    _restartHistory.slice()
  };
}

module.exports = { startHealthCheck, stopHealthCheck, getStatus, onMqttActivity };
