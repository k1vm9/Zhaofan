'use strict';

module.exports = {
  config: {
    name: 'عشوائي',
    aliases: ['random', 'pick', 'اختر'],
    description: 'اختيار عنصر عشوائي من قائمة أو رقم بين نطاقين',
    usage: '!عشوائي [خيار1, خيار2, ...] أو !عشوائي [min] [max]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    const input = args.join(' ').trim();
    if (!input) return reply('⚠️ مثال: !عشوائي تفاحة, موزة, عنب\nأو: !عشوائي 1 100');

    if (args.length === 2 && !isNaN(args[0]) && !isNaN(args[1])) {
      const min = parseInt(args[0]), max = parseInt(args[1]);
      if (min >= max) return reply('❌ الحد الأدنى يجب أن يكون أصغر من الأعلى.');
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      return reply(`🎲 عشوائي بين ${min} و ${max}\n━━━━━━━━━━━━━\n✅ الناتج: ${result}`);
    }

    const items = input.split(/[،,;\/|]/).map(s => s.trim()).filter(Boolean);
    if (items.length < 2) return reply('⚠️ ضع خيارين أو أكثر مفصولة بفاصلة.\nمثال: !عشوائي علي, محمد, أحمد');
    const chosen = items[Math.floor(Math.random() * items.length)];
    await reply(`🎲 الاختيار العشوائي\n━━━━━━━━━━━━━\n📋 الخيارات: ${items.join(' | ')}\n\n✅ الاختيار: ${chosen}`);
  },
};
