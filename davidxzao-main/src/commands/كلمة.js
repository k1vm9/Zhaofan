'use strict';
const WORDS = [
  'برتقال','سيارة','مدرسة','شجرة','كتاب','قمر','شمس','نجمة','بيت','ماء',
  'هواء','نار','جبل','بحر','نهر','صحراء','مدينة','قرية','فلسفة','علم',
  'حياة','سعادة','حزن','غضب','فرح','صديق','قلب','عقل','روح','جسد',
  'لغة','كلام','صوت','صمت','ضوء','ظلام','صباح','مساء','ربيع','صيف',
  'خريف','شتاء','يوم','ليل','اسبوع','شهر','سنة','تاريخ','مستقبل','وقت',
  'طعام','شراب','خبز','ملح','سكر','قهوة','شاي','حليب','تفاحة','موزة',
  'عنب','رمان','مانجو','فراولة','ليمون','بطيخ','سمك','دجاج','لحم','خضار',
  'مطبخ','غرفة','باب','نافذة','سقف','ارض','جدار','مفتاح','قفل','سلم',
  'طريق','جسر','نفق','ميناء','مطار','قطار','حافلة','دراجة','طائرة','سفينة',
  'قلم','ورقة','كرسي','طاولة','حقيبة','ساعة','هاتف','حاسوب','شاشة','لوحة',
];

function scramble(word) {
  const arr = [...word];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('') === word && word.length > 1 ? scramble(word) : arr.join('');
}

module.exports.config = {
  name: 'كلمة',
  aliases: ['scramble', 'تخليط'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'لعبة تخليط الكلمات — خمّن الكلمة الأصلية',
  commandCategory: 'ألعاب',
  usages: 'كلمة',
  cooldowns: 5,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const sc = scramble(word);
  return api.sendMessage(
    `🔤 لعبة تخليط الكلمات\n━━━━━━━━━━━━━\n🔀 الكلمة المخلوطة:\n${sc}\n\n↩️ ردّ بالكلمة الصحيحة (3 محاولات)`,
    threadID,
    (err, info) => {
      if (err || !info) return;
      global.client.handleReply.push({ name: 'كلمة', messageID: info.messageID, author: senderID, word, tries: 0 });
    },
    messageID
  );
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;
  const ans = String(body || '').trim();
  handleReply.tries++;
  if (ans === handleReply.word) {
    return api.sendMessage(`🎉 صحيح! الكلمة كانت: ${handleReply.word}\n✅ ربحت في ${handleReply.tries} محاولة`, threadID, messageID);
  }
  if (handleReply.tries >= 3) {
    return api.sendMessage(`💀 انتهت المحاولات!\nالكلمة كانت: ${handleReply.word}`, threadID, messageID);
  }
  global.client.handleReply.push({ ...handleReply, messageID });
  const hint = handleReply.word[0] + '*'.repeat(handleReply.word.length - 2) + handleReply.word.slice(-1);
  return api.sendMessage(
    `❌ خطأ! المحاولة ${handleReply.tries}/3\n💡 تلميح: ${hint} (${handleReply.word.length} حرف)`,
    threadID, messageID
  );
};
