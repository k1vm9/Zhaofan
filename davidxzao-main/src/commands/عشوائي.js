'use strict';
module.exports.config = {
  name: 'عشوائي',
  aliases: ['random', 'pick', 'اختر'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'اختار عنصراً عشوائياً من قائمة — أو رقماً بين نطاقين',
  commandCategory: 'أدوات',
  usages: 'عشوائي [خيار1, خيار2, ...] — أو عشوائي [min] [max]',
  cooldowns: 3,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const input = args.join(' ').trim();
  if (!input) return api.sendMessage('⚠️ مثال: .عشوائي تفاحة, موزة, عنب\nأو: .عشوائي 1 100', threadID, messageID);

  // Number range mode
  if (args.length === 2 && !isNaN(args[0]) && !isNaN(args[1])) {
    const min = parseInt(args[0]);
    const max = parseInt(args[1]);
    if (min >= max) return api.sendMessage('❌ الحد الأدنى يجب أن يكون أصغر من الأعلى.', threadID, messageID);
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    return api.sendMessage(
      `🎲 عشوائي بين ${min} و ${max}\n━━━━━━━━━━━━━\n✅ الناتج: ${result}`,
      threadID, messageID
    );
  }

  // List mode — split by comma, semicolon, or slash
  const items = input.split(/[،,;\/|]/).map(s => s.trim()).filter(Boolean);
  if (items.length < 2) return api.sendMessage('⚠️ ضع خيارين أو أكثر مفصولة بفاصلة.\nمثال: .عشوائي علي, محمد, أحمد', threadID, messageID);
  const chosen = items[Math.floor(Math.random() * items.length)];
  return api.sendMessage(
    `🎲 الاختيار العشوائي\n━━━━━━━━━━━━━\n📋 الخيارات: ${items.join(' | ')}\n\n✅ الاختيار: ${chosen}`,
    threadID, messageID
  );
};
