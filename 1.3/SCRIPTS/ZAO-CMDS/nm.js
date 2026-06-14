"use strict";

const { getLocks, setLock, setLockTime, clearLock, getLock, flush } = require("../../includes/nameLocks");

function setTitle(api, name, threadID) {
  return new Promise((resolve, reject) => {
    try {
      const result = api.gcname(name, String(threadID), (err) => {
        if (err) reject(err); else resolve();
      });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (e) {
      reject(e);
    }
  });
}

function _parseRandomRange(rangeStr) {
  if (!rangeStr || !rangeStr.trim()) return { min: 6000, max: 30000 };
  const m = String(rangeStr).trim().match(/^([0-9.]+)(s|m)?-([0-9.]+)(s|m)?$/i);
  if (!m) return null;
  const toMs = (v, u) => {
    const n = parseFloat(v);
    if (isNaN(n) || n <= 0) return null;
    return u && u.toLowerCase() === "m" ? Math.round(n * 60000) : Math.round(n * 1000);
  };
  const minMs = toMs(m[1], m[2]);
  const maxMs = toMs(m[3], m[4]);
  if (!minMs || !maxMs) return null;
  if (minMs < 1000)    return null;
  if (maxMs <= minMs)  return null;
  return { min: minMs, max: maxMs };
}

function _randInRange(range) {
  return Math.round(range.min + Math.random() * (range.max - range.min));
}

function _fmtTime(lock) {
  if (lock.randomTime && lock.randomRange) {
    return `🎲 ${lock.randomRange.min / 1000}s–${lock.randomRange.max / 1000}s`;
  }
  const ms = lock.time || 6000;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

module.exports.config = {
  name: "nm",
  version: "3.0.0",
  hasPermssion: 2,
  credits: "l7wak",
  description: "قفل اسم المجموعة ومنع تغييره مع نظام توقيت قابل للضبط",
  commandCategory: "نظام",
  usages: "تفعيل [الاسم] | ايقاف | قائمة | وقت [s/m أو r] | تنظيف",
  cooldowns: 3
};

module.exports.languages = { vi: {}, en: {} };

// Timestamp recorded when onLoad fires. The interval skips the first
// 25 seconds so MQTT has time to connect before we attempt gcname calls.
let _nmLoadTs = 0;
const NM_STARTUP_GRACE_MS = 25000;

/** Returns true when MQTT appears ready to handle gcname calls. */
function _isMqttReady(botApi) {
  // Grace period: never fire within 25 s of startup
  if (Date.now() - _nmLoadTs < NM_STARTUP_GRACE_MS) return false;

  // Prefer direct health status from the API (most accurate)
  if (botApi && typeof botApi.getHealthStatus === "function") {
    try {
      const h = botApi.getHealthStatus();
      return h?.mqtt?.isConnected ?? h?.mqttConnected ?? true;
    } catch (_) {}
  }

  // Fall back to NKX health broadcast (populated every 15 min, but better than nothing)
  const health = global.nkx?.health;
  if (health) {
    return health?.mqtt?.isConnected ?? health?.mqttConnected ?? true;
  }

  // No health info at all — only safe to proceed if enough time has passed
  return Date.now() - _nmLoadTs >= NM_STARTUP_GRACE_MS;
}

module.exports.onLoad = function ({ api }) {
  const locks = getLocks();
  _nmLoadTs = Date.now();

  if (global._nmInterval) {
    clearInterval(global._nmInterval);
    global._nmInterval = null;
  }
  if (!global._nmNextApply) global._nmNextApply = new Map();

  global._nmInterval = setInterval(async () => {
    try {
      const botApi = global._botApi || api;
      if (!botApi || locks.size === 0) return;

      // Always check MQTT readiness before calling gcname
      if (!_isMqttReady(botApi)) return;

      const now = Date.now();
      for (const [threadID, lock] of locks.entries()) {
        const nextApply = global._nmNextApply.get(threadID) || 0;
        if (now < nextApply) continue;

        try {
          await setTitle(botApi, lock.name, threadID);
        } catch (err) {
          const msg = String(err && (err.message || err)).toLowerCase();
          if (msg.includes("not connected to mqtt") ||
              msg.includes("mqtt client is not initialized") ||
              msg.includes("mqtt")) {
            continue;
          }
          if (msg.includes("no message_thread") ||
              msg.includes("thread may not exist") ||
              msg.includes("access may be restricted") ||
              msg.includes("not a participant") ||
              msg.includes("not found") ||
              msg.includes("cannot set title")) {
            clearLock(threadID);
            global._nmNextApply.delete(threadID);
            continue;
          }
        }

        const interval = lock.randomTime && lock.randomRange
          ? _randInRange(lock.randomRange)
          : (lock.time || 6000);
        global._nmNextApply.set(threadID, Date.now() + interval);
      }
    } catch (_) {
      // Top-level safety net — the async interval must never produce an
      // unhandled rejection that ZAO's global handler would catch.
    }
  }, 1000);
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const tid = String(threadID);
  const action = args[0];

  const helpMsg =
    "📌 أوامر nm:\n" +
    "• nm تفعيل [الاسم] — قفل اسم المجموعة\n" +
    "• nm ايقاف — إيقاف القفل\n" +
    "• nm وقت [قيمة] — ضبط فترة إعادة التطبيق\n" +
    "  مثال: nm وقت 10s | nm وقت 2m\n" +
    "  🎲 عشوائي: nm وقت r | nm وقت r 5-20 | nm وقت r 10s-1m\n" +
    "• nm حالة — عرض الإعدادات الحالية\n" +
    "• nm قائمة — عرض كل المجموعات المقفولة\n" +
    "• nm تنظيف — حذف جميع الأقفال";

  if (!action) return api.sendMessage(helpMsg, threadID, messageID);

  if (action === "تفعيل") {
    const name = args.slice(1).join(" ").trim();
    if (!name) return api.sendMessage("⚠️ أدخل الاسم.\nمثال: nm تفعيل اسم المجموعة", threadID, messageID);
    try {
      await setTitle(api, name, tid);
    } catch (e) {
      return api.sendMessage(`❌ فشل تغيير الاسم: ${e.message || e}`, threadID, messageID);
    }
    const existing = getLock(tid);
    setLock(tid, name, {
      time:        existing?.time        ?? 6000,
      randomTime:  existing?.randomTime  ?? false,
      randomRange: existing?.randomRange ?? null
    });
    if (!global._nmNextApply) global._nmNextApply = new Map();
    const lock = getLock(tid);
    const interval = lock.randomTime && lock.randomRange ? _randInRange(lock.randomRange) : (lock.time || 6000);
    global._nmNextApply.set(tid, Date.now() + interval);
    return api.sendMessage(`🔒 تم قفل اسم المجموعة:\n"${name}"\n⏱ فترة إعادة التطبيق: ${_fmtTime(lock)}`, threadID, messageID);
  }

  if (action === "ايقاف") {
    if (!getLock(tid)) {
      return api.sendMessage("⚠️ لا يوجد قفل مفعل في هذه المجموعة.", threadID, messageID);
    }
    clearLock(tid);
    if (global._nmNextApply) global._nmNextApply.delete(tid);
    return api.sendMessage("🔓 تم إيقاف قفل اسم المجموعة.\nسيبقى الإيقاف حتى بعد إعادة التشغيل.", threadID, messageID);
  }

  if (action === "وقت") {
    const lock = getLock(tid);
    if (!lock) return api.sendMessage("⚠️ لا يوجد قفل مفعل في هذه المجموعة.\nفعّل القفل أولاً بـ: nm تفعيل [الاسم]", threadID, messageID);

    const rawInput = args.slice(1).join(" ").trim();
    if (!rawInput) {
      return api.sendMessage(
        `⏱ الوقت الحالي: ${_fmtTime(lock)}\n\n` +
        "ضبط جديد:\n" +
        "• nm وقت 10s — كل 10 ثواني\n" +
        "• nm وقت 2m — كل دقيقتين\n" +
        "🎲 nm وقت r — عشوائي (افتراضي 6s–30s)\n" +
        "🎲 nm وقت r 5-20 — عشوائي 5s–20s\n" +
        "🎲 nm وقت r 10s-1m — عشوائي 10s–60s",
        threadID, messageID
      );
    }

    if (rawInput.toLowerCase().startsWith("r")) {
      const rangeStr = rawInput.slice(1).trim();
      const range = _parseRandomRange(rangeStr);
      if (!range) return api.sendMessage(
        "⚠️ صيغة النطاق غير صحيحة.\nأمثلة: r  |  r 5-20  |  r 10s-1m\n(الحد الأدنى 1s، القيمة الكبرى > الصغرى)",
        threadID, messageID
      );
      setLockTime(tid, { time: Math.round((range.min + range.max) / 2), randomTime: true, randomRange: range });
      if (global._nmNextApply) global._nmNextApply.set(tid, Date.now() + _randInRange(range));
      return api.sendMessage(
        `🎲 تم تفعيل الوقت العشوائي لقفل الاسم.\nالنطاق: ${range.min / 1000}s — ${range.max / 1000}s\n💾 يُحفظ بعد إعادة التشغيل.`,
        threadID, messageID
      );
    }

    let ms = 0;
    if (rawInput.endsWith("s"))      ms = parseFloat(rawInput) * 1000;
    else if (rawInput.endsWith("m")) ms = parseFloat(rawInput) * 60000;
    else return api.sendMessage("⚠️ استخدم s للثواني أو m للدقائق.\n🎲 أو r للعشوائي.", threadID, messageID);
    if (ms < 1000) return api.sendMessage("⚠️ الحد الأدنى 1 ثانية.", threadID, messageID);

    setLockTime(tid, { time: ms, randomTime: false, randomRange: null });
    if (global._nmNextApply) global._nmNextApply.set(tid, Date.now() + ms);
    const updated = getLock(tid);
    return api.sendMessage(`✅ تم حفظ الوقت: ${_fmtTime(updated)}\n💾 يُحفظ بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (action === "حالة") {
    const lock = getLock(tid);
    if (!lock) return api.sendMessage("📋 لا يوجد قفل مفعل في هذه المجموعة.", threadID, messageID);
    const nextApply = global._nmNextApply?.get(tid);
    const remaining = nextApply ? Math.max(0, Math.ceil((nextApply - Date.now()) / 1000)) : "—";
    return api.sendMessage(
      `🔒 قفل الاسم — حالة:\n` +
      `📝 الاسم: "${lock.name}"\n` +
      `⏱ الفترة: ${_fmtTime(lock)}\n` +
      `⏳ التطبيق القادم: خلال ${remaining}s`,
      threadID, messageID
    );
  }

  if (action === "قائمة") {
    const locks = getLocks();
    if (locks.size === 0) {
      return api.sendMessage("📋 لا توجد مجموعات مقفولة حالياً.", threadID, messageID);
    }
    let list = `🔒 المجموعات المقفولة (${locks.size}):\n`;
    let i = 1;
    for (const [t, lock] of locks.entries()) {
      list += `${i}. [${t}]: "${lock.name}" ⏱ ${_fmtTime(lock)}\n`;
      i++;
    }
    return api.sendMessage(list.trim(), threadID, messageID);
  }

  if (action === "تنظيف") {
    const locks = getLocks();
    const count = locks.size;
    if (count === 0) return api.sendMessage("🗑️ لا توجد بيانات لحذفها.", threadID, messageID);
    locks.clear();
    flush();
    if (global._nmNextApply) global._nmNextApply.clear();
    return api.sendMessage(`🧹 تم حذف جميع الأقفال.\nعدد المجموعات المحذوفة: ${count}`, threadID, messageID);
  }

  return api.sendMessage(helpMsg, threadID, messageID);
};
