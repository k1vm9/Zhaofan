'use strict';
/**
 * صدى.js — إرسال رسالة بصوت البوت (أدمن فقط)
 * مُقتبس من TatsuYTB/lib/modules/commands/echo.js
 */

module.exports.config = {
  name:            'صدى',
  aliases:         ['echo', 'say', 'قل'],
  version:         '1.0.0',
  hasPermssion:    2,
  credits:         'ZAO Team (from TatsuYTB/echo.js)',
  description:     'أرسل رسالة بصوت البوت (أدمن البوت فقط)',
  commandCategory: 'إدارة البوت',
  usages:          'صدى [الرسالة]',
  cooldowns:       5,
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID } = event;

  if (permssion < 2) {
    return api.sendMessage('⛔ هذا الأمر لأدمن البوت فقط.', threadID, messageID);
  }

  const msg = args.join(' ');
  if (!msg) return api.sendMessage('⚠️ أدخل الرسالة.\nمثال: .صدى مرحباً بالجميع!', threadID, messageID);

  return api.sendMessage(msg, threadID);
};
