'use strict';
/**
 * صامت.js — وضع الصمت (Admin Only)
 * عند التفعيل: البوت ينفذ الأوامر لكن لا يرسل الردود للمحادثة — يطبع فقط في الكونسول.
 */

module.exports.config = {
  name:            'صامت',
  aliases:         ['silent', 'silentmode', 'وضع_صامت', 'كتم'],
  version:         '1.0.0',
  hasPermssion:    2,
  credits:         'ZAO Team',
  description:     'تفعيل/إيقاف وضع الصمت (admin only) — البوت ينفذ الأوامر دون إرسال ردود للمحادثة',
  commandCategory: 'إدارة',
  usages:          'صامت [on/off]',
  cooldowns:       3,
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;

  const arg = (args[0] || '').toLowerCase().trim();

  if (arg === 'on' || arg === 'تفعيل' || arg === '1') {
    global._silentMode = true;
    return api.sendMessage(
      '🔇 وضع الصمت مُفعَّل\n\nالبوت سيُنفِّذ الأوامر دون إرسال أي ردود للمحادثة.\nالردود ستظهر فقط في الكونسول.\n\nأرسل .صامت off للإيقاف.',
      threadID, messageID
    );
  }

  if (arg === 'off' || arg === 'إيقاف' || arg === '0') {
    global._silentMode = false;
    return api.sendMessage(
      '🔊 وضع الصمت مُوقَف\n\nالبوت يعمل بشكل طبيعي الآن.',
      threadID, messageID
    );
  }

  // Toggle
  global._silentMode = !global._silentMode;
  const state = global._silentMode;
  return api.sendMessage(
    state
      ? '🔇 وضع الصمت مُفعَّل\n\nالبوت سيُنفِّذ الأوامر دون إرسال ردود للمحادثة.\n\nأرسل .صامت off للإيقاف.'
      : '🔊 وضع الصمت مُوقَف\n\nالبوت يعمل بشكل طبيعي الآن.',
    threadID, messageID
  );
};
