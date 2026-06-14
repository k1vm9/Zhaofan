'use strict';

/**
 * angel.js — Auto-Send Scheduler
 * ================================
 * Automatically sends a configured message in a group at a set interval,
 * with full human-typing simulation. Ported from White V3, adapted for ZAO.
 *
 * Commands (bot admin only):
 *   .angel on               — start auto-sending in this group
 *   .angel off              — stop auto-sending
 *   .angel change <msg>     — set the message to send
 *   .angel time <minutes>   — set the interval in minutes
 *   .angel status           — show current config
 */

const fs   = require('fs-extra');
const path = require('path');

const DATA_FILE = path.join(process.cwd(), 'data', 'angelData.json');

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveData(data) {
  try {
    fs.ensureDirSync(path.dirname(DATA_FILE));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(senderID) {
  return (global.config?.ADMINBOT || []).map(String).includes(String(senderID));
}

function getIntervals() {
  if (!global.angelIntervals) global.angelIntervals = {};
  return global.angelIntervals;
}

async function humanTypeSend(api, threadID, msg) {
  try {
    const ht = require('../../includes/humanTyping');
    if (typeof ht.calcDelay === 'function' && typeof ht.simulateTyping === 'function') {
      const delay = ht.calcDelay(msg);
      if (delay > 0) await ht.simulateTyping(api, threadID, delay);
    } else {
      const delay = Math.min(Math.max(msg.length * 70, 1200), 8000);
      await new Promise(r => setTimeout(r, delay));
    }
  } catch (_) {}

  try {
    const throttle = require('../../includes/outgoingThrottle');
    await throttle.check(threadID);
  } catch (_) {}

  return api.sendMessage(msg, threadID);
}

// ─── Restore intervals after restart ─────────────────────────────────────────

function restoreIntervals(api) {
  if (global._angelRestored) return;
  global._angelRestored = true;

  const data     = loadData();
  const intervals = getIntervals();
  let restored   = 0;

  for (const [threadID, td] of Object.entries(data)) {
    if (td.active && td.message && !intervals[threadID]) {
      const ms = (td.intervalMinutes || 10) * 60_000;
      intervals[threadID] = setInterval(() => {
        humanTypeSend(api, threadID, td.message).catch(() => {});
      }, ms);
      restored++;
    }
  }

  if (restored > 0) {
    try {
      global.loggeryuki?.log([
        { message: '[ ANGEL ]: ', color: ['red', 'cyan'] },
        { message: `✅ Restored ${restored} auto-send interval(s) after restart`, color: 'white' }
      ]);
    } catch (_) {}
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports.config = {
  name:            'angel',
  version:         '1.2',
  author:          'ZAO',
  cooldowns:       3,
  hasPermssion:    2,
  description:     'Auto-send a message repeatedly in a group at a set interval with human-typing effect',
  commandCategory: 'الأدوات',
  guide:           '  {pn} on | off | change <msg> | time <mins> | status',
  usePrefix:       true,
};

module.exports.onLoad = function ({ api }) {
  if (api) restoreIntervals(api);
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const rawBody = (event.body || '').trim();
  const args    = rawBody.split(/\s+/).slice(1);
  const sub     = (args[0] || '').toLowerCase();

  if (!isAdmin(senderID)) {
    return api.sendMessage('⛔ هذا الأمر خاص بأدمن البوت فقط.', threadID, messageID);
  }

  restoreIntervals(api);

  const data      = loadData();
  const intervals = getIntervals();

  if (!data[threadID]) {
    data[threadID] = { message: null, intervalMinutes: 10, active: false };
  }
  const td = data[threadID];

  switch (sub) {

    case 'change': {
      const newMsg = args.slice(1).join(' ').trim();
      if (!newMsg) {
        return api.sendMessage(
          '❌ اكتب الرسالة بعد الأمر.\n\nمثال: .angel change مرحباً بالجميع!',
          threadID, messageID
        );
      }
      td.message = newMsg;
      saveData(data);
      return api.sendMessage(
        `✅ تم تحديث الرسالة!\n\n📝 الرسالة الجديدة:\n"${newMsg}"`,
        threadID, messageID
      );
    }

    case 'time': {
      const mins = parseFloat(args[1]);
      if (isNaN(mins) || mins <= 0) {
        return api.sendMessage(
          '❌ اكتب عدد الدقائق.\n\nمثال: .angel time 10',
          threadID, messageID
        );
      }
      td.intervalMinutes = mins;
      saveData(data);

      if (intervals[threadID]) {
        clearInterval(intervals[threadID]);
        delete intervals[threadID];
        if (td.message && td.active) {
          intervals[threadID] = setInterval(() => {
            humanTypeSend(api, threadID, td.message).catch(() => {});
          }, mins * 60_000);
        }
      }

      return api.sendMessage(
        `✅ تم تحديث الفاصل الزمني!\n\n⏱️ كل ${mins} دقيقة`
        + (td.active ? '\n♻️ تم إعادة تشغيله بالفاصل الجديد.' : ''),
        threadID, messageID
      );
    }

    case 'on': {
      if (!td.message) {
        return api.sendMessage(
          '❌ لم يتم ضبط رسالة بعد.\n\nاضبطها أولاً:\n.angel change [رسالتك]',
          threadID, messageID
        );
      }
      if (intervals[threadID]) {
        return api.sendMessage('⚠️ الإرسال التلقائي مُفعَّل مسبقاً في هذه المجموعة.', threadID, messageID);
      }
      td.active = true;
      saveData(data);
      const ms = td.intervalMinutes * 60_000;
      intervals[threadID] = setInterval(() => {
        humanTypeSend(api, threadID, td.message).catch(() => {});
      }, ms);
      return api.sendMessage(
        `✅ تم تفعيل الإرسال التلقائي!\n\n`
        + `📝 الرسالة: "${td.message}"\n`
        + `⏱️ كل: ${td.intervalMinutes} دقيقة\n`
        + `✍️ مؤشر الكتابة البشري: مفعّل`,
        threadID, messageID
      );
    }

    case 'off': {
      if (!intervals[threadID]) {
        return api.sendMessage('⚠️ الإرسال التلقائي غير مُفعَّل في هذه المجموعة.', threadID, messageID);
      }
      clearInterval(intervals[threadID]);
      delete intervals[threadID];
      td.active = false;
      saveData(data);
      return api.sendMessage('✅ تم إيقاف الإرسال التلقائي.', threadID, messageID);
    }

    case 'status': {
      const isRunning = !!intervals[threadID];
      return api.sendMessage(
        `📊 حالة Angel — هذه المجموعة\n\n`
        + `▪️ الحالة: ${isRunning ? '🟢 يعمل' : '🔴 موقوف'}\n`
        + `▪️ الرسالة: ${td.message ? `"${td.message}"` : 'لم تُضبط'}\n`
        + `▪️ الفاصل: ${td.intervalMinutes} دقيقة\n`
        + `▪️ مؤشر الكتابة: ✍️ مفعّل دائماً`,
        threadID, messageID
      );
    }

    default: {
      return api.sendMessage(
        '📖 أوامر Angel:\n\n'
        + '.angel change [رسالة] — ضبط الرسالة\n'
        + '.angel time [دقائق]   — ضبط الفاصل الزمني\n'
        + '.angel on             — تفعيل الإرسال\n'
        + '.angel off            — إيقاف الإرسال\n'
        + '.angel status         — عرض الحالة',
        threadID, messageID
      );
    }
  }
};
