'use strict';
/**
 * مؤقت.js — مؤقت / عداد تنازلي
 * مستوحى من أوامر TatsuYTB
 */

module.exports.config = {
  name:            'مؤقت',
  aliases:         ['timer', 'countdown', 'عداد'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team',
  description:     'ابدأ مؤقتاً (عداداً تنازلياً) بالثواني/الدقائق',
  commandCategory: 'أدوات',
  usages:          'مؤقت [رقم] [ث/د] — مثال: .مؤقت 30 ث',
  cooldowns:       10,
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;

  const HELP = '⏱️ مثال: .مؤقت 30 ث (ثانية) أو .مؤقت 5 د (دقائق)\nالحد الأقصى: 10 دقائق';

  if (!args[0]) return api.sendMessage(HELP, threadID, messageID);

  const amount = parseInt(args[0]);
  if (isNaN(amount) || amount <= 0) return api.sendMessage('❌ أدخل رقماً صحيحاً موجباً.', threadID, messageID);

  const unit = (args[1] || 'ث').trim();
  const isMin = unit === 'د' || unit === 'min' || unit === 'm';
  const ms = isMin ? amount * 60000 : amount * 1000;

  const MAX_MS = 10 * 60 * 1000;
  if (ms > MAX_MS) return api.sendMessage('❌ الحد الأقصى 10 دقائق.', threadID, messageID);

  const label = isMin ? `${amount} دقيقة` : `${amount} ثانية`;
  await api.sendMessage(`⏱️ تم ضبط المؤقت لـ ${label}. سأنبّهك عند الانتهاء!`, threadID, messageID);

  setTimeout(async () => {
    try {
      const mentions = [{ tag: '@you', id: senderID }];
      await api.sendMessage(
        { body: `⏰ انتهى مؤقت ${label}! 🔔`, mentions },
        threadID
      );
    } catch (_) {}
  }, ms);
};
