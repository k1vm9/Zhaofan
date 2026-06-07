'use strict';

const ANSWERS = [
  '✅ نعم، بالتأكيد!',
  '✅ كل المؤشرات تقول نعم',
  '✅ الأمور تسير لصالحك',
  '✅ يبدو ذلك صحيحاً',
  '✅ اعتمد عليه',
  '😎 بالتأكيد!',
  '😎 كما أرى، نعم!',
  '🔮 المصادر تقول نعم',
  '🔮 من الصعب التنبؤ الآن',
  '🔮 تركّز وأعد السؤال',
  '🤔 أعد السؤال لاحقاً',
  '🤔 غير واضح، حاول مجدداً',
  '🤔 لا أستطيع الإجابة الآن',
  '❌ لا تعتمد على ذلك',
  '❌ الإجابة هي لا',
  '❌ الأفق يبدو ضبابياً',
];

module.exports = {
  config: {
    name: 'كرة8',
    aliases: ['8ball', 'magic8', 'كرة'],
    description: 'كرة السحر الثمانية — جرب حظك',
    usage: '!كرة8 [سؤالك]',
    adminOnly: false,
    category: 'ألعاب',
  },
  run: async ({ reply, args }) => {
    const q      = args.join(' ').trim();
    const answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    await reply(
      q
        ? `🎱 سؤالك:\n${q}\n\n🔮 الإجابة:\n${answer}`
        : `🎱 الكرة السحرية تقول:\n\n${answer}`
    );
  },
};
