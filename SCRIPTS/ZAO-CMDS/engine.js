"use strict";

const { motor1 } = require("../../includes/motorPersist");

function _getThreadName(tid) {
  try {
    const info = global.data?.threadInfo?.get(String(tid));
    if (info?.threadName) return info.threadName;
    if (info?.name) return info.name;
  } catch (_) {}
  return String(tid);
}

// Parses a random range string like "15-30", "15s-2m", or "" (default).
// Returns { min, max } in ms, or null if the format is invalid.
function _parseRandomRange(rangeStr) {
  if (!rangeStr || !rangeStr.trim()) return { min: 12000, max: 50000 };
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
  if (minMs < 5000)    return null; // floor 5s
  if (maxMs <= minMs)  return null; // max must exceed min
  return { min: minMs, max: maxMs };
}

function _fmtRelTime(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  let str;
  if (s < 60)      str = `${s}ث`;
  else if (m < 60) str = `${m}د ${s % 60}ث`;
  else              str = `${h}س ${m % 60}د`;
  return future ? `خلال ${str}` : `منذ ${str}`;
}

module.exports.config = {
  name: "محرك",
  version: "2.0.0",
  hasPermssion: 2,
  credits: "SAIN",
  description: "إرسال رسالة تلقائية كل فترة زمنية محددة — يبقى بعد إعادة التشغيل",
  commandCategory: "إدارة البوت",
  usages: "تفعيل | ايقاف | رسالة [نص] | وقت [30s | 0.5m | r] | حالة",
  cooldowns: 0
};

module.exports.languages = { vi: {}, en: {} };

function _ensureRow(threadID) {
  global.motorData = global.motorData || {};
  if (!global.motorData[threadID]) {
    global.motorData[threadID] = {
      status: false, message: null, time: null,
      randomTime: false, randomRange: null, interval: null
    };
  }
  return global.motorData[threadID];
}

function _save() {
  // Snapshot current memory → disk; flushes synchronously so a restart
  // milliseconds after a command still sees the change.
  motor1.persistAll(global.motorData || {});
}

function _startLoop(api, threadID) {
  const d = global.motorData[threadID];
  if (!d || !d.status || !d.message || !d.time) return;
  try { clearInterval(d.interval); } catch (_) {}
  try { clearTimeout(d.interval);  } catch (_) {}
  d.interval = null;

  try {
    const { scheduleMotorLoop } = require("../../includes/motorSafeSend");
    scheduleMotorLoop({
      api,
      threadID,
      getData: () => global.motorData[threadID],
      onDisable: () => { try { _save(); } catch (_) {} }
    });
  } catch (_) {}
}

module.exports.onLoad = function ({ api }) {
  global.motorData = global.motorData || {};

  // Restore persisted rows (preserves randomTime/randomRange too — the
  // old _saveMotorState in ZAO.js only stored status/message/time, so
  // a random-interval motor could come back as a fixed-interval one
  // after a restart. motorPersist fixes that.)
  const saved = motor1.loadAll();
  for (const [tid, d] of Object.entries(saved)) {
    global.motorData[tid] = { ...d, interval: null };
    if (d.status && d.message && d.time) _startLoop(api, tid);
  }

  // Watchdog: every 60 s scan all active motor1 entries and revive any
  // loop that has died silently (e.g. after a listen-error reconnect or
  // a transient fatal-looking error that wrongly killed the loop).
  if (!global.__motorWatchdog1) {
    global.__motorWatchdog1 = setInterval(() => {
      try {
        const { isActiveLoop } = require("../../includes/motorSafeSend");
        const currentApi = global._botApi || api;
        for (const [tid, d] of Object.entries(global.motorData || {})) {
          if (d && d.status && d.message && d.time && !isActiveLoop(tid)) {
            _startLoop(currentApi, tid);
          }
        }
      } catch (_) {}
    }, 60 * 1000);
    if (typeof global.__motorWatchdog1.unref === "function") {
      global.__motorWatchdog1.unref();
    }
  }
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID } = event;
  if (permssion < 2) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }
  if (!args[0]) {
    return api.sendMessage(
      "📌 الاستخدام:\nمحرك تفعيل\nمحرك ايقاف\nمحرك رسالة [النص]\nمحرك وقت [30s أو 0.5m]\n🎲 محرك وقت r — عشوائي بين 12s و 50s\nمحرك حالة",
      threadID, messageID
    );
  }

  const data = _ensureRow(threadID);

  if (args[0] === "رسالة") {
    // Use raw body slice so multi-word/Arabic messages keep spacing.
    const body = event.body || "";
    const idx  = body.indexOf("رسالة");
    const msg  = (idx !== -1 ? body.slice(idx + "رسالة".length) : args.slice(1).join(" "))
      .replace(/^ /, "");
    if (!msg.trim()) return api.sendMessage("⚠️ اكتب الرسالة بعد الأمر.", threadID, messageID);
    data.message = msg;
    _save();
    return api.sendMessage(`✅ تم حفظ رسالة المحرك:\n"${msg}"\n💾 سيبقى بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (args[0] === "وقت") {
    // Join all remaining args so "محرك وقت r 15-30" gives rawInput = "r 15-30"
    const rawInput = args.slice(1).join(" ").trim();
    if (!rawInput) return api.sendMessage(
      "⚠️ حدد الوقت.\nأمثلة:\nمحرك وقت 30s\nمحرك وقت 2m\n🎲 محرك وقت r\n🎲 محرك وقت r 15-30\n🎲 محرك وقت r 20s-2m",
      threadID, messageID
    );

    if (rawInput.toLowerCase().startsWith("r")) {
      const rangeStr = rawInput.slice(1).trim(); // "" or "15-30" or "20s-2m"
      const range = _parseRandomRange(rangeStr);
      if (!range) return api.sendMessage(
        "⚠️ صيغة النطاق غير صحيحة.\nأمثلة:\n🎲 محرك وقت r\n🎲 محرك وقت r 15-30\n🎲 محرك وقت r 20s-2m\n(الحد الأدنى 5s، والقيمة الكبرى يجب أن تتجاوز الصغرى)",
        threadID, messageID
      );
      data.randomTime  = true;
      data.randomRange = range;
      data.time        = Math.round((range.min + range.max) / 2);
      _save();
      return api.sendMessage(
        `🎲 تم تفعيل الوقت العشوائي.\nالنطاق: ${range.min/1000}s — ${range.max/1000}s\n💾 يُحفظ بعد إعادة التشغيل.`,
        threadID, messageID
      );
    }

    let ms = 0;
    if (rawInput.endsWith("s"))      ms = parseFloat(rawInput) * 1000;
    else if (rawInput.endsWith("m")) ms = parseFloat(rawInput) * 60 * 1000;
    else return api.sendMessage("⚠️ صيغة الوقت غير صحيحة.\nاستخدم s للثواني أو m للدقائق.\n🎲 أو r للعشوائي.", threadID, messageID);
    if (ms < 5000) return api.sendMessage("⚠️ الحد الأدنى 5 ثواني.", threadID, messageID);

    data.time        = ms;
    data.randomTime  = false;
    data.randomRange = null;
    _save();
    return api.sendMessage(`✅ تم حفظ الوقت: ${rawInput}\n💾 يُحفظ بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (args[0] === "تفعيل") {
    if (data.status === true) return api.sendMessage("⚠️ المحرك مفعل مسبقاً.", threadID, messageID);
    if (!data.message)        return api.sendMessage("⚠️ لم تحدد الرسالة. استخدم: محرك رسالة [النص]", threadID, messageID);
    if (!data.time)           return api.sendMessage("⚠️ لم تحدد الوقت. استخدم: محرك وقت [30s]", threadID, messageID);
    data.status = true;
    _startLoop(api, threadID);
    _save();
    const tStr = data.randomTime
      ? `🎲 عشوائي ${(data.randomRange?.min || 12000)/1000}s - ${(data.randomRange?.max || 50000)/1000}s`
      : `${data.time/1000}s`;
    return api.sendMessage(`✅ تم تفعيل المحرك.\n📝 الرسالة: "${data.message}"\n⏱ كل: ${tStr}\n💾 يبقى بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (args[0] === "ايقاف") {
    if (data.status === false) return api.sendMessage("⚠️ المحرك غير مفعل أصلاً.", threadID, messageID);
    // Mark stopped FIRST so any in-flight tick aborts before re-scheduling.
    data.status = false;
    try {
      const { stopMotorLoop } = require("../../includes/motorSafeSend");
      stopMotorLoop(threadID);
    } catch (_) {}
    try { clearInterval(data.interval); } catch (_) {}
    try { clearTimeout(data.interval);  } catch (_) {}
    data.interval = null;
    _save();   // Persists status:false → no zombie revival on restart.
    return api.sendMessage("🔴 تم إيقاف المحرك.\nسيبقى موقوفاً حتى بعد إعادة التشغيل.", threadID, messageID);
  }

  if (args[0] === "حالة") {
    const { getLoopStats } = require("../../includes/motorSafeSend");
    const allData = global.motorData || {};
    const activeEntries = Object.entries(allData).filter(([, d]) => d && d.status);

    if (!activeEntries.length) {
      return api.sendMessage("📊 المحرك العادي\n\n⚫ لا يوجد أي غروب مفعّل حالياً.", threadID, messageID);
    }

    let msg = `📊 المحرك العادي — ${activeEntries.length} غروب نشط\n${"━".repeat(18)}\n`;
    for (const [tid, d] of activeEntries) {
      const name = _getThreadName(tid);
      const stats = getLoopStats(tid);
      const tStr = d.randomTime && d.randomRange
        ? `🎲 ${(d.randomRange.min||12000)/1000}s-${(d.randomRange.max||50000)/1000}s`
        : (d.time ? d.time/1000 + "s" : "—");
      const inBackoff = stats && stats.backoffMs > 0;
      const alive = !stats ? "⚠️" : inBackoff ? "🟡" : "🟢";
      const last  = stats ? _fmtRelTime(stats.lastSentAt) : "—";
      const next  = stats ? _fmtRelTime(stats.nextSendAt)  : "—";
      msg += `\n${alive} ${name.slice(0, 28)}\n`;
      msg += `   ⏱ كل ${tStr}  |  📝 "${(d.message || "").slice(0, 20)}"\n`;
      if (inBackoff) msg += `   ⚠️ انتظار (backoff ${Math.round(stats.backoffMs/1000)}s)\n`;
      msg += `   آخر إرسال: ${last}\n`;
      msg += `   التالي:    ${next}\n`;
    }

    return api.sendMessage(msg, threadID, messageID);
  }

  return api.sendMessage(
    "📌 الاستخدام:\nمحرك تفعيل\nمحرك ايقاف\nمحرك رسالة [النص]\nمحرك وقت [30s | 0.5m | r]\nمحرك حالة",
    threadID, messageID
  );
};
