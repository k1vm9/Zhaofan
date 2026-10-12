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
const { atomicWriteJsonSync } = require('../../utils/atomicWrite');

const DATA_FILE = path.join(process.cwd(), 'data', 'angelData.json');

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
    const ht = require('../../src/protection/humanTyping');
    if (typeof ht.calcDelay === 'function' && typeof ht.simulateTyping === 'function') {
      const delay = ht.calcDelay(msg);
      if (delay > 0) await ht.simulateTyping(api, threadID, delay);
    } else {
      const delay = Math.min(Math.max(msg.length * 70, 1200), 8000);
      await new Promise(r => setTimeout(r, delay));
    }
  } catch (_) {}

  try {
    const throttle = require('../../src/protection/outgoingThrottle');
    await throttle.check(threadID);
  } catch (_) {}

  return api.sendMessage(msg, threadID);
}

function createAngelController({
  dataFile = DATA_FILE,
  intervals = getIntervals(),
  apiProvider = () => global.GoatBot?.fcaApi || null,
  send = humanTypeSend,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let currentApi = null;

  function loadData() {
    if (!fs.existsSync(dataFile)) return {};
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('ملف جداول Angel ليس كائن JSON صالحاً');
    }
    return data;
  }

  function saveData(data) {
    fs.ensureDirSync(path.dirname(dataFile));
    atomicWriteJsonSync(dataFile, data);
  }

  function normalizeThreadID(value) {
    const id = String(value || '').trim();
    if (!/^\d{1,32}$/.test(id)) throw new Error('معرّف المحادثة غير صالح');
    return id;
  }

  function stop(threadID) {
    if (!intervals[threadID]) return false;
    clearIntervalFn(intervals[threadID]);
    delete intervals[threadID];
    return true;
  }

  function start(threadID, schedule, api) {
    if (!schedule.message) throw new Error('اكتب رسالة قبل تفعيل الجدول');
    const sendApi = api || apiProvider();
    if (!sendApi || typeof sendApi.sendMessage !== 'function') {
      throw new Error('البوت غير متصل؛ لا يمكن تفعيل الإرسال الدوري');
    }
    const minutes = Number(schedule.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error('الفاصل الزمني يجب أن يكون بين دقيقة واحدة و24 ساعة');
    }
    stop(threadID);
    intervals[threadID] = setIntervalFn(() => {
      Promise.resolve(send(sendApi, threadID, schedule.message)).catch(error => {
        global.log?.error?.('ANGEL', error?.message || String(error));
      });
    }, minutes * 60_000);
  }

  function setSchedule(input, api) {
    if (!input || typeof input !== 'object') throw new Error('بيانات الجدول غير صالحة');
    const threadID = normalizeThreadID(input.threadID);
    const data = loadData();
    const previous = data[threadID] || { message: '', intervalMinutes: 10, active: false };
    const message = input.message === undefined ? String(previous.message || '') : String(input.message).trim();
    const intervalMinutes = input.intervalMinutes === undefined
      ? Number(previous.intervalMinutes || 10)
      : Number(input.intervalMinutes);
    const active = input.active === undefined ? Boolean(previous.active) : input.active === true;

    if (message.length > 2000) throw new Error('الرسالة تتجاوز الحد الأقصى البالغ 2000 حرف');
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      throw new Error('الفاصل الزمني يجب أن يكون بين دقيقة واحدة و24 ساعة');
    }
    if (active && !message.trim()) throw new Error('اكتب رسالة قبل تفعيل الجدول');
    if (active && !(api || apiProvider())) throw new Error('البوت غير متصل؛ لا يمكن تفعيل الإرسال الدوري');

    const schedule = { message, intervalMinutes, active };
    data[threadID] = schedule;
    saveData(data);
    stop(threadID);
    if (active) start(threadID, schedule, api);
    return { threadID, ...schedule, running: Boolean(intervals[threadID]) };
  }

  function getSchedules() {
    const data = loadData();
    return Object.entries(data).map(([threadID, value]) => ({
      threadID,
      message: String(value?.message || ''),
      intervalMinutes: Number(value?.intervalMinutes || 10),
      active: Boolean(value?.active),
      running: Boolean(intervals[threadID]),
    }));
  }

  function removeSchedule(value) {
    const threadID = normalizeThreadID(value);
    const data = loadData();
    stop(threadID);
    if (!Object.prototype.hasOwnProperty.call(data, threadID)) return false;
    delete data[threadID];
    saveData(data);
    return true;
  }

  function restore(api = apiProvider()) {
    if (!api || api === currentApi) return 0;
    currentApi = api;
    for (const threadID of Object.keys(intervals)) stop(threadID);
    let restored = 0;
    for (const [threadID, schedule] of Object.entries(loadData())) {
      if (!schedule?.active || !schedule?.message) continue;
      start(threadID, schedule, api);
      restored++;
    }
    if (restored) global.log?.info?.('ANGEL', `Restored ${restored} scheduled message(s).`);
    return restored;
  }

  return { loadData, saveData, getSchedules, setSchedule, removeSchedule, restore, stop };
}

const angelController = createAngelController();

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
  if (api) angelController.restore(api);
};
module.exports.dashboard = {
  getSchedules: () => angelController.getSchedules(),
  setSchedule: (schedule, api) => angelController.setSchedule(schedule, api),
  removeSchedule: threadID => angelController.removeSchedule(threadID),
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const rawBody = (event.body || '').trim();
  const args    = rawBody.split(/\s+/).slice(1);
  const sub     = (args[0] || '').toLowerCase();

  if (!isAdmin(senderID)) {
    return api.sendMessage('⛔ هذا الأمر خاص بأدمن البوت فقط.', threadID, messageID);
  }

  angelController.restore(api);

  const data      = angelController.loadData();
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
      angelController.setSchedule({ threadID, ...td }, api);
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
      try { angelController.setSchedule({ threadID, ...td }, api); }
      catch (error) { return api.sendMessage(`❌ ${error.message}`, threadID, messageID); }

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
      try { angelController.setSchedule({ threadID, ...td }, api); }
      catch (error) { return api.sendMessage(`❌ ${error.message}`, threadID, messageID); }
      return api.sendMessage(
        `✅ تم تفعيل الإرسال التلقائي!\n\n`
        + `📝 الرسالة: "${td.message}"\n`
        + `⏱️ كل: ${td.intervalMinutes} دقيقة\n`
        + `✍️ مؤشر الكتابة البشري: مفعّل`,
        threadID, messageID
      );
    }

    case 'off': {
      if (!intervals[threadID] && !td.active) {
        return api.sendMessage('⚠️ الإرسال التلقائي غير مُفعَّل في هذه المجموعة.', threadID, messageID);
      }
      td.active = false;
      angelController.setSchedule({ threadID, ...td, active: false }, api);
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
