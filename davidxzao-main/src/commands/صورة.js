"use strict";

const fs    = require("fs-extra");
const path  = require("path");
const axios = require("axios");

const { getLocks, getLock, setLock, setLockTime, clearLock, flush } = require("../../includes/groupImgLocks");

const IMG_DIR = path.join(__dirname, "..", "..", "data", "groupimg");
fs.ensureDirSync(IMG_DIR);

function imgPath(threadID) {
  return path.join(IMG_DIR, `${String(threadID)}.jpg`);
}

function _parseRandomRange(rangeStr) {
  if (!rangeStr || !rangeStr.trim()) return { min: 20000, max: 60000 };
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

function _randInRange(range) {
  return Math.round(range.min + Math.random() * (range.max - range.min));
}

function _fmtTime(lock) {
  if (lock.randomTime && lock.randomRange) {
    const mn = lock.randomRange.min / 1000;
    const mx = lock.randomRange.max / 1000;
    if (mx >= 60) return `🎲 ${(mn/60).toFixed(1)}m–${(mx/60).toFixed(1)}m`;
    return `🎲 ${mn}s–${mx}s`;
  }
  const ms = lock.time || 30000;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function downloadImage(url, destPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function changeGroupImageP(api, threadID) {
  const filePath = imgPath(threadID);
  if (!fs.existsSync(filePath)) throw new Error("ملف الصورة غير موجود");
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    try {
      const r = api.changeGroupImage(stream, String(threadID), (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
      if (r && typeof r.then === "function") r.then(resolve).catch(reject);
    } catch (e) { reject(e); }
  });
}

module.exports.config = {
  name: "صورة",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "قفل صورة المجموعة ومنع تغييرها — رد على صورة بـ .صورة",
  commandCategory: "نظام",
  usages: "[رد على صورة] | ايقاف | وقت [s/m أو r] | حالة | قائمة | تنظيف",
  cooldowns: 5
};

module.exports.languages = { vi: {}, en: {} };

module.exports.onLoad = function ({ api }) {
  if (global._groupImgInterval) {
    clearInterval(global._groupImgInterval);
    global._groupImgInterval = null;
  }
  if (!global._groupImgNextApply) global._groupImgNextApply = new Map();

  global._groupImgInterval = setInterval(async () => {
    const botApi = global._botApi || api;
    if (!botApi) return;

    const locks = getLocks();
    if (locks.size === 0) return;

    const health = global.nkx?.health;
    if (health) {
      const mqttOk = health?.mqtt?.isConnected ?? health?.mqttConnected ?? true;
      if (!mqttOk) return;
    }

    const now = Date.now();
    for (const [threadID, lock] of locks.entries()) {
      const nextApply = global._groupImgNextApply.get(threadID) || 0;
      if (now < nextApply) continue;

      if (!lock.imgPath || !fs.existsSync(lock.imgPath)) {
        clearLock(threadID);
        global._groupImgNextApply.delete(threadID);
        continue;
      }

      try {
        await changeGroupImageP(botApi, threadID);
      } catch (err) {
        const msg = String(err?.message || err).toLowerCase();
        if (msg.includes("not connected to mqtt") ||
            msg.includes("mqtt client is not initialized") ||
            msg.includes("mqtt")) {
          continue;
        }
        if (msg.includes("no message_thread") ||
            msg.includes("thread may not exist") ||
            msg.includes("not a participant") ||
            msg.includes("not found")) {
          clearLock(threadID);
          global._groupImgNextApply.delete(threadID);
          continue;
        }
      }

      const interval = lock.randomTime && lock.randomRange
        ? _randInRange(lock.randomRange)
        : (lock.time || 30000);
      global._groupImgNextApply.set(threadID, Date.now() + interval);
    }
  }, 2000);
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, messageReply } = event;
  const tid    = String(threadID);
  const action = args[0];

  const helpMsg =
    "🖼 أوامر صورة:\n" +
    "• [رد على صورة] + .صورة — قفل صورة المجموعة\n" +
    "• .صورة ايقاف — إيقاف القفل\n" +
    "• .صورة وقت [قيمة] — ضبط فترة إعادة التطبيق\n" +
    "  مثال: .صورة وقت 30s | .صورة وقت 2m\n" +
    "  🎲 عشوائي: .صورة وقت r | .صورة وقت r 20-60 | .صورة وقت r 30s-5m\n" +
    "• .صورة حالة — عرض الإعدادات الحالية\n" +
    "• .صورة قائمة — عرض كل المجموعات المقفولة\n" +
    "• .صورة تنظيف — حذف جميع الأقفال";

  if (!action) {
    if (!messageReply) return api.sendMessage(helpMsg, threadID, messageID);

    const attachments = messageReply.attachments || [];
    const photo = attachments.find(a =>
      a.type === "photo" || a.type === "animated_image"
    );

    if (!photo) {
      return api.sendMessage(
        "⚠️ الرسالة التي رددت عليها لا تحتوي على صورة.\nأرسل صورة ثم ارد عليها بـ .صورة",
        threadID, messageID
      );
    }

    const imgUrl = photo.largePreviewUrl || photo.url || photo.previewUrl;
    if (!imgUrl) return api.sendMessage("❌ تعذّر الحصول على رابط الصورة.", threadID, messageID);

    await api.sendMessage("⏳ جاري تحميل الصورة وقفل صورة المجموعة...", threadID);

    try {
      fs.ensureDirSync(IMG_DIR);
      const dest = imgPath(tid);
      await downloadImage(imgUrl, dest);

      await changeGroupImageP(api, tid);

      const existing = getLock(tid);
      setLock(tid, dest, {
        time:        existing?.time        ?? 30000,
        randomTime:  existing?.randomTime  ?? false,
        randomRange: existing?.randomRange ?? null
      });

      if (!global._groupImgNextApply) global._groupImgNextApply = new Map();
      const lock = getLock(tid);
      const interval = lock.randomTime && lock.randomRange
        ? _randInRange(lock.randomRange)
        : (lock.time || 30000);
      global._groupImgNextApply.set(tid, Date.now() + interval);

      return api.sendMessage(
        `🔒 تم قفل صورة المجموعة!\n⏱ فترة إعادة التطبيق: ${_fmtTime(lock)}\n\n💡 لتغيير الوقت: .صورة وقت [قيمة]\n💡 لإيقاف القفل: .صورة ايقاف`,
        threadID, messageID
      );
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 150);
      return api.sendMessage(`❌ فشل قفل صورة المجموعة:\n${msg}`, threadID, messageID);
    }
  }

  if (action === "ايقاف") {
    if (!getLock(tid)) {
      return api.sendMessage("⚠️ لا يوجد قفل مفعل في هذه المجموعة.", threadID, messageID);
    }
    clearLock(tid);
    if (global._groupImgNextApply) global._groupImgNextApply.delete(tid);
    return api.sendMessage("🔓 تم إيقاف قفل صورة المجموعة.", threadID, messageID);
  }

  if (action === "وقت") {
    const lock = getLock(tid);
    if (!lock) return api.sendMessage(
      "⚠️ لا يوجد قفل مفعل في هذه المجموعة.\nفعّل القفل أولاً بالرد على صورة بـ .صورة",
      threadID, messageID
    );

    const rawInput = args.slice(1).join(" ").trim();
    if (!rawInput) {
      return api.sendMessage(
        `⏱ الوقت الحالي: ${_fmtTime(lock)}\n\n` +
        "ضبط جديد:\n" +
        "• .صورة وقت 30s — كل 30 ثانية\n" +
        "• .صورة وقت 2m — كل دقيقتين\n" +
        "🎲 .صورة وقت r — عشوائي (افتراضي 20s–60s)\n" +
        "🎲 .صورة وقت r 20-90 — عشوائي 20s–90s\n" +
        "🎲 .صورة وقت r 1m-5m — عشوائي 1m–5m",
        threadID, messageID
      );
    }

    if (rawInput.toLowerCase().startsWith("r")) {
      const rangeStr = rawInput.slice(1).trim();
      const range = _parseRandomRange(rangeStr);
      if (!range) return api.sendMessage(
        "⚠️ صيغة النطاق غير صحيحة.\nأمثلة: r  |  r 20-90  |  r 30s-5m\n(الحد الأدنى 5s، القيمة الكبرى > الصغرى)",
        threadID, messageID
      );
      setLockTime(tid, { time: Math.round((range.min + range.max) / 2), randomTime: true, randomRange: range });
      if (global._groupImgNextApply) global._groupImgNextApply.set(tid, Date.now() + _randInRange(range));
      return api.sendMessage(
        `🎲 تم تفعيل الوقت العشوائي لقفل الصورة.\nالنطاق: ${range.min / 1000}s — ${range.max / 1000}s\n💾 يُحفظ بعد إعادة التشغيل.`,
        threadID, messageID
      );
    }

    let ms = 0;
    if (rawInput.endsWith("s"))      ms = parseFloat(rawInput) * 1000;
    else if (rawInput.endsWith("m")) ms = parseFloat(rawInput) * 60000;
    else return api.sendMessage("⚠️ استخدم s للثواني أو m للدقائق.\n🎲 أو r للعشوائي.", threadID, messageID);
    if (ms < 5000) return api.sendMessage("⚠️ الحد الأدنى 5 ثواني.", threadID, messageID);

    setLockTime(tid, { time: ms, randomTime: false, randomRange: null });
    if (global._groupImgNextApply) global._groupImgNextApply.set(tid, Date.now() + ms);
    const updated = getLock(tid);
    return api.sendMessage(`✅ تم حفظ الوقت: ${_fmtTime(updated)}\n💾 يُحفظ بعد إعادة التشغيل.`, threadID, messageID);
  }

  if (action === "حالة") {
    const lock = getLock(tid);
    if (!lock) return api.sendMessage("📋 لا يوجد قفل مفعل في هذه المجموعة.", threadID, messageID);
    const nextApply = global._groupImgNextApply?.get(tid);
    const remaining = nextApply ? Math.max(0, Math.ceil((nextApply - Date.now()) / 1000)) : "—";
    return api.sendMessage(
      `🔒 قفل الصورة — حالة:\n` +
      `🖼 الصورة محفوظة: ${fs.existsSync(lock.imgPath) ? "✅ نعم" : "❌ لا — سيُحذف القفل"}\n` +
      `⏱ الفترة: ${_fmtTime(lock)}\n` +
      `⏳ التطبيق القادم: خلال ${remaining}s`,
      threadID, messageID
    );
  }

  if (action === "قائمة") {
    const locks = getLocks();
    if (locks.size === 0) {
      return api.sendMessage("📋 لا توجد مجموعات مقفولة الصورة حالياً.", threadID, messageID);
    }
    let list = `🔒 المجموعات المقفولة الصورة (${locks.size}):\n`;
    let i = 1;
    for (const [t, lock] of locks.entries()) {
      list += `${i}. [${t}] ⏱ ${_fmtTime(lock)}\n`;
      i++;
    }
    return api.sendMessage(list.trim(), threadID, messageID);
  }

  if (action === "تنظيف") {
    const locks = getLocks();
    const count = locks.size;
    if (count === 0) return api.sendMessage("🗑️ لا توجد بيانات لحذفها.", threadID, messageID);
    for (const [t] of locks.entries()) {
      const p = imgPath(t);
      try { if (fs.existsSync(p)) fs.removeSync(p); } catch (_) {}
    }
    locks.clear();
    flush();
    if (global._groupImgNextApply) global._groupImgNextApply.clear();
    return api.sendMessage(`🧹 تم حذف جميع أقفال الصور.\nعدد المجموعات المحذوفة: ${count}`, threadID, messageID);
  }

  return api.sendMessage(helpMsg, threadID, messageID);
};
