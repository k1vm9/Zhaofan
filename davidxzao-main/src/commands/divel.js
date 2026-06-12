'use strict';

// ══════════════════════════════════════════════════════════════
//  divel.js — مراقب النشاط الآلي
//  يرسل رسالة مُعدّة مسبقاً عندما يصمت الجميع في المجموعة
//
//  الأوامر (أدمن البوت فقط):
//    .divel on              — تفعيل المراقب في هذه المجموعة
//    .divel off             — إيقاف المراقب
//    .divel change <نص>    — تحديد الرسالة التي سيرسلها البوت
//    .divel time <ثوانٍ>   — تحديد مدة الصمت قبل الإرسال
//    .divel status          — عرض الإعدادات الحالية
// ══════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(process.cwd(), 'DB', 'divelSettings.json');
const DEFAULT_TIME_MS   = 5 * 60 * 1000;   // 5 دقائق افتراضياً
const DEFAULT_MESSAGE   = '👋 أهلاً، هل من أحد هنا؟';

// ─── قراءة وكتابة الإعدادات ───────────────────────────────────
function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (_) { return {}; }
}

function saveSettings() {
  try {
    // لا نحفظ timer (دالة) — نحفظ البقية فقط
    const toSave = {};
    for (const [tid, cfg] of Object.entries(global.divelMonitor || {})) {
      toSave[tid] = {
        enabled:      cfg.enabled,
        message:      cfg.message,
        timeMs:       cfg.timeMs,
        botSentLast:  cfg.botSentLast,
      };
    }
    if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    }
    const { atomicWriteFileSync: _aw } = (() => { try { return require('../../utils/atomicWrite'); } catch(_){return{atomicWriteFileSync:fs.writeFileSync};} })();
    _aw(SETTINGS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (_) {}
}

// ─── الحصول على إعدادات مجموعة (إنشاء إذا لم توجد) ──────────
function getCfg(threadID) {
  if (!global.divelMonitor) global.divelMonitor = {};
  if (!global.divelMonitor[threadID]) {
    global.divelMonitor[threadID] = {
      enabled:     false,
      message:     DEFAULT_MESSAGE,
      timeMs:      DEFAULT_TIME_MS,
      timer:       null,
      botSentLast: true,  // true = لا نرسل حتى يُرسل أحد أولاً
    };
  }
  return global.divelMonitor[threadID];
}

// ─── إيقاف المؤقت لمجموعة ───────────────────────────────────
function clearTimer(cfg) {
  if (cfg.timer) {
    clearTimeout(cfg.timer);
    cfg.timer = null;
  }
}

function _live(api) {
  return global._botApi || api;
}

// ─── بدء مؤقت الصمت لمجموعة ─────────────────────────────────
function startTimer(api, threadID, cfg) {
  clearTimer(cfg);
  cfg.timer = setTimeout(async () => {
    cfg.timer = null;

    // لا نرسل إذا: المراقب موقوف، أو البوت كان آخر من أرسل
    if (!cfg.enabled || cfg.botSentLast) return;

    const liveApi = _live(api);
    try {
      await liveApi.sendMessage(cfg.message, threadID);
      cfg.botSentLast = true;   // البوت أرسل — لا نرسل مجدداً حتى يتحدث أحد
      saveSettings();
    } catch (_) {}
  }, cfg.timeMs);
}

// ══════════════════════════════════════════════════════════════
//  config
// ══════════════════════════════════════════════════════════════
module.exports.config = {
  name:            'divel',
  version:         '2.0',
  author:          'DJAMEL',
  cooldowns:       3,
  hasPermssion:    2,
  description:     'مراقب النشاط — يرسل رسالة مُعدّة عند صمت المجموعة',
  commandCategory: 'النظام',
  guide:           '  {pn} on | off | change <نص> | time <ثوانٍ> | status',
  usePrefix:       true,
};

// ══════════════════════════════════════════════════════════════
//  onLoad — استعادة الإعدادات من الملف عند تشغيل البوت
// ══════════════════════════════════════════════════════════════
module.exports.onLoad = function () {
  global.divelMonitor = global.divelMonitor || {};
  const saved = loadSettings();
  for (const [tid, data] of Object.entries(saved)) {
    global.divelMonitor[tid] = {
      enabled:     data.enabled     ?? false,
      message:     data.message     || DEFAULT_MESSAGE,
      timeMs:      data.timeMs      || DEFAULT_TIME_MS,
      timer:       null,             // المؤقتات لا تُحفظ — تبدأ من جديد
      botSentLast: true,             // ننتظر أول رسالة بشرية بعد إعادة التشغيل
    };
  }
};

// ══════════════════════════════════════════════════════════════
//  handleEvent — يُستدعى عند كل رسالة في أي محادثة
// ══════════════════════════════════════════════════════════════
module.exports.handleEvent = async function ({ api, event }) {
  try {
    const { threadID, senderID, type } = event;
    const liveApi = _live(api);

    // نتجاهل الأحداث التي ليست رسائل نصية
    if (type !== 'message' && type !== 'message_reply') return;

    const cfg = global.divelMonitor?.[threadID];
    if (!cfg || !cfg.enabled) return;

    const botID = String(liveApi.getCurrentUserID());
    const sender = String(senderID);

    // نتجاهل رسائل البوت نفسه
    if (sender === botID) return;

    // ── شخص أرسل رسالة ──
    // 1) البوت لم يعد آخر مُرسل
    cfg.botSentLast = false;
    // 2) إعادة تشغيل مؤقت الصمت (كل رسالة تُعيد العدّ)
    startTimer(liveApi, threadID, cfg);
  } catch (_) {}
};

// ══════════════════════════════════════════════════════════════
//  run — أوامر الأدمن
// ══════════════════════════════════════════════════════════════
module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const liveApi = _live(api);
  const rawBody = event.body || '';
  // نزيل البادئة والاسم: ".divel on" → ["on"]
  const args = rawBody.trim().split(/\s+/).slice(1);
  const sub  = (args[0] || '').toLowerCase();

  const ADMINBOT = (global.config?.ADMINBOT || []).map(String);
  if (!ADMINBOT.includes(String(senderID))) {
    return liveApi.sendMessage('⛔ هذا الأمر خاص بأدمن البوت فقط.', threadID, messageID);
  }

  const cfg = getCfg(threadID);

  // ── on ────────────────────────────────────────────────────
  if (sub === 'on') {
    if (cfg.enabled) {
      return liveApi.sendMessage('✅ المراقب مُفعَّل مسبقاً في هذه المجموعة.', threadID, messageID);
    }
    cfg.enabled     = true;
    cfg.botSentLast = true;   // ننتظر أول رسالة بشرية
    clearTimer(cfg);
    saveSettings();
    return liveApi.sendMessage(
      `✅ تم تفعيل مراقب النشاط.\n` +
      `⏱ المدة: ${Math.round(cfg.timeMs / 1000)} ثانية صمت\n` +
      `📝 الرسالة: ${cfg.message}`,
      threadID, messageID
    );
  }

  // ── off ───────────────────────────────────────────────────
  if (sub === 'off') {
    if (!cfg.enabled) {
      return liveApi.sendMessage('⚠️ المراقب غير مُفعَّل أصلاً.', threadID, messageID);
    }
    cfg.enabled = false;
    clearTimer(cfg);
    saveSettings();
    return liveApi.sendMessage('🔴 تم إيقاف مراقب النشاط.', threadID, messageID);
  }

  // ── change <رسالة> ────────────────────────────────────────
  if (sub === 'change') {
    const newMsg = args.slice(1).join(' ').trim();
    if (!newMsg) {
      return liveApi.sendMessage(
        '📝 استخدام: .divel change <نص الرسالة>\n\nمثال:\n.divel change أهلاً! هل أنتم هنا؟',
        threadID, messageID
      );
    }
    cfg.message = newMsg;
    saveSettings();
    return liveApi.sendMessage(`✅ تم تحديث الرسالة:\n\n${newMsg}`, threadID, messageID);
  }

  // ── time <ثوانٍ> ──────────────────────────────────────────
  if (sub === 'time') {
    const secs = parseInt(args[1], 10);
    if (!secs || secs < 10 || secs > 86400) {
      return liveApi.sendMessage(
        '⏱ استخدام: .divel time <ثوانٍ>\nالحد الأدنى: 10 ثوانٍ | الأقصى: 86400 (24 ساعة)\n\nمثال:\n.divel time 300 (= 5 دقائق)',
        threadID, messageID
      );
    }
    cfg.timeMs = secs * 1000;
    // إعادة تشغيل المؤقت إذا كان المراقب مُفعَّلاً
    if (cfg.enabled && !cfg.botSentLast) {
      startTimer(liveApi, threadID, cfg);
    }
    saveSettings();
    return liveApi.sendMessage(
      `✅ تم تحديث مدة الصمت: ${secs} ثانية (${(secs / 60).toFixed(1)} دقيقة).`,
      threadID, messageID
    );
  }

  // ── status ────────────────────────────────────────────────
  if (sub === 'status') {
    const state  = cfg.enabled ? '✅ مُفعَّل' : '🔴 موقوف';
    const mins   = (cfg.timeMs / 1000 / 60).toFixed(1);
    const secs   = Math.round(cfg.timeMs / 1000);
    const timer  = cfg.timer ? '⏳ جارٍ العدّ' : (cfg.botSentLast ? '😴 في انتظار رسالة بشرية' : '—');
    return liveApi.sendMessage(
      `📊 إعدادات مراقب النشاط (هذه المجموعة)\n\n` +
      `الحالة   : ${state}\n` +
      `المدة    : ${secs} ثانية (${mins} دقيقة)\n` +
      `المؤقت   : ${timer}\n` +
      `الرسالة  :\n${cfg.message}`,
      threadID, messageID
    );
  }

  // ── مساعدة ───────────────────────────────────────────────
  return liveApi.sendMessage(
    '📖 أوامر مراقب النشاط (أدمن البوت فقط):\n\n' +
    '.divel on              — تفعيل المراقب\n' +
    '.divel off             — إيقاف المراقب\n' +
    '.divel change <نص>    — تحديد الرسالة\n' +
    '.divel time <ثوانٍ>   — مدة الصمت قبل الإرسال\n' +
    '.divel status          — عرض الإعدادات الحالية\n\n' +
    ':\n' +
    '',
    threadID, messageID
  );
};
