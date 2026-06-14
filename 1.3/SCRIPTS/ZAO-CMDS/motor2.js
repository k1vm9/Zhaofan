"use strict";

const { motor2 } = require("../../includes/motorPersist");

function _getThreadName(tid) {
  try {
    const info = global.data?.threadInfo?.get(String(tid));
    if (info?.threadName) return info.threadName;
    if (info?.name) return info.name;
  } catch (_) {}
  return String(tid);
}

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
  if (minMs < 5000)    return null;
  if (maxMs <= minMs)  return null;
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

function _save() {
  motor2.persistAll(global.motorData2 || {});
}

function _ensureRow(threadID) {
  global.motorData2 = global.motorData2 || {};
  if (!global.motorData2[threadID]) {
    global.motorData2[threadID] = {
      status: false, message: null, time: null,
      randomTime: false, randomRange: null, interval: null
    };
  }
  return global.motorData2[threadID];
}

function _startLoop(api, threadID) {
  const d = global.motorData2[threadID];
  if (!d || !d.status || !d.message || !d.time) return;
  try { clearInterval(d.interval); } catch (_) {}
  try { clearTimeout(d.interval);  } catch (_) {}
  d.interval = null;

  // motor2 only fires when there has been recent non-bot activity in
  // the thread — kept as a closure so motorSafeSend can call it cheaply.
  d.shouldSend = function () {
    const lastActive = (global.lastActivity || {})[threadID];
    if (!lastActive) return false;
    return (Date.now() - lastActive) < (Number(d.time) || 0) * 2;
  };

  try {
    const { scheduleMotorLoop } = require("../../includes/motorSafeSend");
    scheduleMotorLoop({
      api,
      threadID,
      getData: () => global.motorData2[threadID],
      onDisable: () => { try { _save(); } catch (_) {} }
    });
  } catch (_) {}
}

module.exports.config = {
  name: "محرك2",
  version: "2.1.0",
  hasPermssion: 2,
  credits: "لي حواك",
  description: "إرسال رسالة تلقائية بشرط وجود نشاط — يبقى بعد إعادة التشغيل",
  commandCategory: "إدارة البوت",
  usages: "تفعيل | ايقاف | رسالة [نص] | وقت [30s | 0.5m | r] | حالة",
  cooldowns: 0
};

module.exports.languages = { vi: {}, en: {} };

module.exports.onLoad = function ({ api }) {
  global.motorData2   = global.motorData2   || {};
  global.lastActivity = global.lastActivity || {};

  const saved = motor2.loadAll();
  for (const [tid, d] of Object.entries(saved)) {
    global.motorData2[tid] = { ...d, interval: null };
    if (d.status && d.message && d.time) _startLoop(api, tid);
  }

  // Watchdog: every 60 s scan all active motor2 entries and revive any
  // loop that has died silently (e.g. after a listen-error reconnect or
  // a transient fatal-looking error that wrongly killed the loop).
  if (!global.__motorWatchdog2) {
    global.__motorWatchdog2 = setInterval(() => {
      try {
        const { isActiveLoop } = require("../../includes/motorSafeSend");
        const currentApi = global._botApi || api;
        for (const [tid, d] of Object.entries(global.motorData2 || {})) {
          if (d && d.status && d.message && d.time && !isActiveLoop(tid)) {
            _startLoop(currentApi, tid);
          }
        }
      } catch (_) {}
    }, 60 * 1000);
    if (typeof global.__motorWatchdog2.unref === "function") {
      global.__motorWatchdog2.unref();
    }
  }
};

module.exports.handleEvent = async function ({ event }) {
  const { threadID, isGroup, senderID } = event;
  if (!isGroup) return;
  const botID = String(global.botUserID || "");
  if (String(senderID) !== botID) {
    if (!global.lastActivity) global.lastActivity = {};
    global.lastActivity[threadID] = Date.now();
  }
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID } = event;
  if (permssion < 2) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }
  if (!args[0]) {
    return api.sendMessage(
      "📌 الاستخدام:\nمحرك2 تفعيل\nمحرك2 ايقاف\nمحرك2 رسالة [النص]\nمحرك2 وقت [30s | 0.5m | r]\nمحرك2 حالة",
      threadID, messageID
    );
  }

  const data = _ensureRow(threadID);

  if (args[0] === "رسالة") {
    const body = event.body || "";
    const idx  = body.indexOf("رسالة");
    const msg  = (idx !== -1 ? body.slice(idx + "رسالة".length) : args.slice(1).join(" "))
      .replace(/^ /, "");
    if (!msg.trim()) return api.sendMessage("⚠️ اكتب الرسالة بعد الأمر.", threadID, messageID);
    data.message = msg;
    _save();
    return api.sendMessage(`✅ تم حفظ الرسالة:\n"${msg}"\n💾 يبقى بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (args[0] === "وقت") {
    const rawInput = args.slice(1).join(" ").trim();
    if (!rawInput) return api.sendMessage(
      "⚠️ حدد الوقت.\nأمثلة:\nمحرك2 وقت 30s\nمحرك2 وقت 2m\n🎲 محرك2 وقت r\n🎲 محرك2 وقت r 15-30\n🎲 محرك2 وقت r 20s-2m",
      threadID, messageID
    );

    if (rawInput.toLowerCase().startsWith("r")) {
      const rangeStr = rawInput.slice(1).trim();
      const range = _parseRandomRange(rangeStr);
      if (!range) return api.sendMessage(
        "⚠️ صيغة النطاق غير صحيحة.\nأمثلة:\n🎲 محرك2 وقت r\n🎲 محرك2 وقت r 15-30\n🎲 محرك2 وقت r 20s-2m\n(الحد الأدنى 5s، والقيمة الكبرى يجب أن تتجاوز الصغرى)",
        threadID, messageID
      );
      data.randomTime  = true;
      data.randomRange = range;
      data.time        = Math.round((range.min + range.max) / 2);
      _save();
      return api.sendMessage(
        `🎲 تم تفعيل الوقت العشوائي للمحرك الذكي.\nالنطاق: ${range.min/1000}s — ${range.max/1000}s\n💾 يُحفظ بعد إعادة التشغيل.`,
        threadID, messageID
      );
    }

    let ms = 0;
    if (rawInput.endsWith("s"))      ms = parseFloat(rawInput) * 1000;
    else if (rawInput.endsWith("m")) ms = parseFloat(rawInput) * 60 * 1000;
    else return api.sendMessage("⚠️ استخدم s للثواني أو m للدقائق.\n🎲 أو r للعشوائي.", threadID, messageID);
    if (ms < 5000) return api.sendMessage("⚠️ الحد الأدنى 5 ثواني.", threadID, messageID);

    data.time        = ms;
    data.randomTime  = false;
    data.randomRange = null;
    _save();
    return api.sendMessage(`✅ تم حفظ الوقت: ${rawInput}\n💾 يُحفظ بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (args[0] === "تفعيل") {
    if (data.status === true) return api.sendMessage("⚠️ المحرك مفعل مسبقاً.", threadID, messageID);
    if (!data.message)        return api.sendMessage("⚠️ لم تحدد الرسالة بعد. استخدم: محرك2 رسالة [النص]", threadID, messageID);
    if (!data.time)           return api.sendMessage("⚠️ لم تحدد الوقت بعد. استخدم: محرك2 وقت [30s]", threadID, messageID);
    data.status = true;
    _startLoop(api, threadID);
    _save();
    const tStr = data.randomTime
      ? `🎲 عشوائي ${(data.randomRange?.min || 12000)/1000}s - ${(data.randomRange?.max || 50000)/1000}s`
      : `${data.time/1000}s`;
    return api.sendMessage(
      `✅ تم تفعيل المحرك الذكي.\n📝 الرسالة: "${data.message}"\n⏱ كل: ${tStr}\n🔔 يرسل فقط عند وجود نشاط\n💾 يبقى بعد إعادة التشغيل.`,
      threadID, messageID
    );
  }

  if (args[0] === "ايقاف") {
    if (data.status === false) return api.sendMessage("⚠️ المحرك غير مفعل أصلاً.", threadID, messageID);
    data.status = false;
    try {
      const { stopMotorLoop } = require("../../includes/motorSafeSend");
      stopMotorLoop(threadID);
    } catch (_) {}
    try { clearInterval(data.interval); } catch (_) {}
    try { clearTimeout(data.interval);  } catch (_) {}
    data.interval = null;
    _save();
    return api.sendMessage("🔴 تم إيقاف المحرك.\nسيبقى موقوفاً حتى بعد إعادة التشغيل.", threadID, messageID);
  }

  if (args[0] === "حالة") {
    const { getLoopStats } = require("../../includes/motorSafeSend");
    const allData = global.motorData2 || {};
    const activeEntries = Object.entries(allData).filter(([, d]) => d && d.status);

    if (!activeEntries.length) {
      return api.sendMessage("📊 المحرك الذكي\n\n⚫ لا يوجد أي غروب مفعّل حالياً.", threadID, messageID);
    }

    let msg = `📊 المحرك الذكي — ${activeEntries.length} غروب نشط\n${"━".repeat(18)}\n`;
    for (const [tid, d] of activeEntries) {
      const name = _getThreadName(tid);
      const stats = getLoopStats(tid);
      const tStr = d.randomTime && d.randomRange
        ? `🎲 ${(d.randomRange.min||12000)/1000}s-${(d.randomRange.max||50000)/1000}s`
        : (d.time ? d.time/1000 + "s" : "—");
      const lastAct = (global.lastActivity || {})[tid];
      const inBackoff = stats && stats.backoffMs > 0;
      const alive = !stats ? "⚠️" : inBackoff ? "🟡" : "🟢";
      const last  = stats ? _fmtRelTime(stats.lastSentAt) : "—";
      const next  = stats ? _fmtRelTime(stats.nextSendAt)  : "—";
      const actStr = lastAct ? _fmtRelTime(lastAct) : "لا نشاط";
      msg += `\n${alive} ${name.slice(0, 28)}\n`;
      msg += `   ⏱ كل ${tStr}  |  📝 "${(d.message || "").slice(0, 20)}"\n`;
      if (inBackoff) msg += `   ⚠️ انتظار (backoff ${Math.round(stats.backoffMs/1000)}s)\n`;
      msg += `   آخر إرسال:  ${last}\n`;
      msg += `   التالي:     ${next}\n`;
      msg += `   آخر نشاط:  ${actStr}\n`;
    }

    return api.sendMessage(msg, threadID, messageID);
  }

  return api.sendMessage(
    "📌 الاستخدام:\nمحرك2 تفعيل\nمحرك2 ايقاف\nمحرك2 رسالة [النص]\nمحرك2 وقت [30s | 0.5m | r]\nمحرك2 حالة",
    threadID, messageID
  );
};
