'use strict';
const SIGNS = [
  { name: 'الحمل',    emoji: '♈', dates: '21 مارس - 19 أبريل' },
  { name: 'الثور',    emoji: '♉', dates: '20 أبريل - 20 مايو' },
  { name: 'الجوزاء',  emoji: '♊', dates: '21 مايو - 20 يونيو' },
  { name: 'السرطان',  emoji: '♋', dates: '21 يونيو - 22 يوليو' },
  { name: 'الأسد',    emoji: '♌', dates: '23 يوليو - 22 أغسطس' },
  { name: 'العذراء',  emoji: '♍', dates: '23 أغسطس - 22 سبتمبر' },
  { name: 'الميزان',  emoji: '♎', dates: '23 سبتمبر - 22 أكتوبر' },
  { name: 'العقرب',   emoji: '♏', dates: '23 أكتوبر - 21 نوفمبر' },
  { name: 'القوس',    emoji: '♐', dates: '22 نوفمبر - 21 ديسمبر' },
  { name: 'الجدي',    emoji: '♑', dates: '22 ديسمبر - 19 يناير' },
  { name: 'الدلو',    emoji: '♒', dates: '20 يناير - 18 فبراير' },
  { name: 'الحوت',    emoji: '♓', dates: '19 فبراير - 20 مارس' },
];
const MSGS = [
  'يومك ممتاز وكل شيء سيسير بسلاسة 🌟',
  'حظ موفور ينتظرك — استغل يومك 🍀',
  'يوم هادئ للتفكير والتخطيط 🧘',
  'ستلتقي بشخص مثير للاهتمام اليوم 😊',
  'تحذير: ابتعد عن القرارات المتسرعة اليوم ⚠️',
  'الطاقة عالية — الوقت المثالي لإنجاز مهام كبيرة 💪',
  'يوم للراحة واسترداد النشاط 🛌',
  'فرصة مالية ستظهر لك — كن يقظاً 💰',
  'العلاقات الاجتماعية في أفضل حالاتها 👥',
  'يوم مليء بالمفاجآت — بعضها سار! 🎁',
  'خذ نفساً عميقاً وابدأ بخطوة واحدة 👣',
  'الإبداع في ذروته — افعل شيئاً مختلفاً 🎨',
];

function seededRand(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

module.exports.config = {
  name: 'حظ',
  aliases: ['luck', 'fortune', 'برج'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'حظك اليومي وبرجك — يتجدد كل يوم',
  commandCategory: 'ألعاب',
  usages: 'حظ',
  cooldowns: 10,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seed  = parseInt(senderID.slice(-6)) + parseInt(today);
  const r1    = seededRand(seed);
  const r2    = seededRand(seed + 1);
  const r3    = seededRand(seed + 2);
  const score = Math.floor(r1 * 70) + 30; // 30–100
  const sign  = SIGNS[Math.floor(r2 * SIGNS.length)];
  const msg   = MSGS[Math.floor(r3 * MSGS.length)];
  const stars = '⭐'.repeat(Math.round(score / 20));
  return api.sendMessage(
    `${sign.emoji} حظك اليوم\n━━━━━━━━━━━━━\n🔯 برجك: ${sign.name}\n📅 ${sign.dates}\n\n${stars}\n🎯 درجة الحظ: ${score}/100\n\n📜 ${msg}`,
    threadID, messageID
  );
};
