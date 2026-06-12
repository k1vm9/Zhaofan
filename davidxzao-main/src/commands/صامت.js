'use strict';
/**
 * صامت.js — وضع الصمت (Admin Only)
 * عند التفعيل: البوت ينفذ الأوامر لكن لا يرسل الردود للمحادثة — يطبع فقط في الكونسول.
 */

module.exports.config = {
  name:            'صامت',
  aliases:         ['silent', 'silentmode', 'وضع_صامت', 'كتم'],
  version:         '1.0.1',
  hasPermssion:    2,
  role:            2,
  credits:         'ZAO Team',
  description:     'تفعيل/إيقاف وضع الصمت (admin only) — البوت ينفذ الأوامر دون إرسال ردود للمحادثة',
  commandCategory: 'إدارة',
  usages:          'صامت [on/off]',
  cooldowns:       3,
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  // Ensure GoatBot is initialised
  if (!global.GoatBot) global.GoatBot = {};

  const arg = (args[0] || '').toLowerCase().trim();

  if (arg === 'on' || arg === 'تفعيل' || arg === '1') {
    global.GoatBot.silentMode = true;
    _emitState();
    return api.sendMessage(
      '🔇 وضع الصمت مُفعَّل\n\nالبوت سيُنفِّذ الأوامر دون إرسال أي ردود للمحادثة.\nالردود ستظهر فقط في الكونسول.\n\nأرسل /صامت off للإيقاف.',
      threadID, messageID
    );
  }

  if (arg === 'off' || arg === 'إيقاف' || arg === '0') {
    global.GoatBot.silentMode = false;
    _emitState();
    return api.sendMessage(
      '🔊 وضع الصمت مُوقَف\n\nالبوت يعمل بشكل طبيعي الآن.',
      threadID, messageID
    );
  }

  // Toggle
  global.GoatBot.silentMode = !global.GoatBot.silentMode;
  const state = global.GoatBot.silentMode;
  _emitState();
  return api.sendMessage(
    state
      ? '🔇 وضع الصمت مُفعَّل\n\nالبوت سيُنفِّذ الأوامر دون إرسال ردود للمحادثة.\n\nأرسل /صامت off للإيقاف.'
      : '🔊 وضع الصمت مُوقَف\n\nالبوت يعمل بشكل طبيعي الآن.',
    threadID, messageID
  );
};

function _emitState() {
  try {
    const { getIO } = require('../dashboard/server');
    const io = getIO();
    if (io) io.emit('bot-state-change', {
      globalLock: !!global.GoatBot?.globalLock,
      silentMode: !!global.GoatBot?.silentMode,
    });
  } catch (_) {}
}
