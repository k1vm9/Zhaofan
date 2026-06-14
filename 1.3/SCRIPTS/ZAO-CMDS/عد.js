'use strict';
module.exports.config = {
  name: 'عد',
  aliases: ['count', 'counter', 'احصاء'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'عدّ الأحرف والكلمات والأسطر في أي نص',
  commandCategory: 'أدوات',
  usages: 'عد [نص] — أو رد على رسالة بـ .عد',
  cooldowns: 3,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, messageReply } = event;
  const text = (args.join(' ').trim()) || (messageReply?.body?.trim()) || '';
  if (!text) return api.sendMessage('⚠️ اكتب نصاً بعد الأمر أو رد على رسالة.', threadID, messageID);
  const chars     = text.length;
  const noSpaces  = text.replace(/\s/g, '').length;
  const words     = text.trim().split(/\s+/).filter(Boolean).length;
  const lines     = text.split('\n').length;
  const sentences = (text.match(/[.!?؟।]/g) || []).length;
  const arabic    = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return api.sendMessage(
    `📊 إحصاء النص\n━━━━━━━━━━━━━\n📝 الأحرف الكلية: ${chars.toLocaleString()}\n🔤 بدون مسافات: ${noSpaces.toLocaleString()}\n📖 الكلمات: ${words.toLocaleString()}\n📄 الأسطر: ${lines.toLocaleString()}\n❓ الجُمَل: ${sentences.toLocaleString()}\n🇸🇦 أحرف عربية: ${arabic.toLocaleString()}`,
    threadID, messageID
  );
};
