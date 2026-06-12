'use strict';
/**
 * قفل.js — قفل/فتح البوت عالمياً (Owner Only)
 * عند القفل: البوت يتجاهل جميع الأوامر ما عدا مالكه (role ≥ 3).
 */

module.exports.config = {
  name:            'قفل',
  aliases:         ['lock', 'globallock', 'botlock', 'bl'],
  version:         '1.0.0',
  hasPermssion:    3,
  role:            3,
  credits:         'DJAMEL',
  description:     'قفل/فتح البوت عالمياً — عند القفل يتجاهل البوت جميع الأوامر ما عدا المالك',
  commandCategory: 'إدارة',
  usages:          'قفل [on/off]',
  cooldowns:       3,
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  // Ensure GoatBot is initialised
  if (!global.GoatBot) global.GoatBot = {};

  const arg = (args[0] || '').toLowerCase().trim();

  if (arg === 'on' || arg === 'تفعيل' || arg === '1') {
    global.GoatBot.globalLock = true;
    _emitState();
    return api.sendMessage(
      '🔒 تم قفل البوت عالمياً\n\nالبوت سيتجاهل جميع الأوامر الآن.\nفقط المالك (role 3) يمكنه استخدام الأوامر.\n\nأرسل /قفل off لفتح القفل.',
      threadID, messageID
    );
  }

  if (arg === 'off' || arg === 'إيقاف' || arg === '0') {
    global.GoatBot.globalLock = false;
    _emitState();
    return api.sendMessage(
      '🔓 تم فتح قفل البوت\n\nالبوت يقبل الأوامر من الجميع الآن.',
      threadID, messageID
    );
  }

  // Toggle
  global.GoatBot.globalLock = !global.GoatBot.globalLock;
  const state = global.GoatBot.globalLock;
  _emitState();
  return api.sendMessage(
    state
      ? '🔒 تم قفل البوت عالمياً\n\nالبوت سيتجاهل جميع الأوامر.\nفقط المالك يمكنه الاستخدام.\n\nأرسل /قفل off لفتح القفل.'
      : '🔓 تم فتح قفل البوت\n\nالبوت يقبل الأوامر من الجميع الآن.',
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
