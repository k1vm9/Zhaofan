'use strict';

module.exports = {
  config: {
    name: 'تقييم',
    aliases: ['rate', 'قيّم', 'score'],
    description: 'يعطيك تقييم عشوائي لأي شيء من 1-100',
    usage: '!تقييم [الشيء]',
    adminOnly: false,
    category: 'ترفيه',
  },
  run: async ({ reply, args }) => {
    const thing  = args.join(' ').trim();
    if (!thing) return reply('⚠️ مثال: !تقييم ذكائي');
    const score  = Math.floor(Math.random() * 101);
    const stars  = '⭐'.repeat(Math.round(score / 20));
    const emoji  = score >= 80 ? '🏆' : score >= 60 ? '😊' : score >= 40 ? '🤔' : score >= 20 ? '😅' : '💀';
    await reply(
      `${emoji} تقييم\n━━━━━━━━━━━━━\n` +
      `📌 الشيء: ${thing}\n` +
      `📊 التقييم: ${score}/100\n` +
      `${stars || '🌑'}`
    );
  },
};
