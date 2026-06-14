'use strict';
/**
 * تقييم.js — تنفيذ كود JavaScript (المطوّر فقط)
 * مُقتبس من TatsuYTB/lib/modules/commands/eval.js
 */

module.exports.config = {
  name:            'تقييم',
  aliases:         ['eval', 'run', 'js'],
  version:         '1.0.0',
  hasPermssion:    3,
  credits:         'ZAO Team (from TatsuYTB/eval.js)',
  description:     'تنفيذ كود JavaScript مباشرة (مطوّر البوت فقط)',
  commandCategory: 'نظام',
  usages:          'تقييم [كود JS]',
  cooldowns:       1,
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID, senderID } = event;

  const ownerIDs = [
    ...(global.config?.ADMINBOT || []),
    ...(global.config?.adminBot || []),
  ].map(String);

  if (!ownerIDs.includes(String(senderID)) && permssion < 3) {
    return api.sendMessage('⛔ هذا الأمر للمطوّر فقط.', threadID, messageID);
  }

  const code = args.join(' ');
  if (!code) return api.sendMessage('⚠️ أدخل الكود.\nمثال: .تقييم 1 + 1', threadID, messageID);

  const send = x => api.sendMessage(String(x), threadID, messageID);

  try {
    const result = eval(code);
    if (result !== undefined) send(result);
  } catch (e) {
    send('❌ خطأ:\n' + e.toString());
  }
};
