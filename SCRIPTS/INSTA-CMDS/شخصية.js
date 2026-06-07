'use strict';

const PERSONALITIES = [
  '🦁 قائد طبيعي — شجاع وواثق من نفسه',
  '🦊 ذكي ومخادع — تفكيرك استراتيجي',
  '🐢 صبور وحكيم — تتأنى في قراراتك',
  '🦋 مبدع ومتحرر — تحب التغيير والجمال',
  '🐺 مستقل وقوي — لا تحتاج رأي الآخرين',
  '🦅 طموح عالٍ — نظرتك دائماً للأمام',
  '🐬 اجتماعي ومرح — تُسعد من حولك',
  '🦉 عالِم ومثابر — تحب التعلم والاكتشاف',
  '🐉 نادر ومتميز — شخصيتك لا تُضاهى',
  '🌊 هادئ في الخارج، عميق في الداخل',
];

module.exports = {
  config: {
    name: 'شخصية',
    aliases: ['personality', 'طبيعتي'],
    description: 'اكتشف نوع شخصيتك',
    usage: '!شخصية',
    adminOnly: false,
    category: 'ترفيه',
  },
  run: async ({ reply }) => {
    const p = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
    await reply(`🔮 شخصيتك:\n━━━━━━━━━━━━━\n${p}`);
  },
};
