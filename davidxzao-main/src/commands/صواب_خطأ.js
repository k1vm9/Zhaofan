'use strict';
const QUESTIONS = [
  { q: 'الشمس نجم وليس كوكب', a: true },
  { q: 'الماء يغلي عند 90 درجة مئوية', a: false },
  { q: 'القرآن الكريم يحتوي على 114 سورة', a: true },
  { q: 'السمكة تتنفس بالرئتين', a: false },
  { q: 'الصين أكبر دولة في العالم من حيث المساحة', a: false },
  { q: 'روسيا هي أكبر دولة في العالم مساحةً', a: true },
  { q: 'الفيل أكبر الحيوانات البرية', a: true },
  { q: 'الأخطبوط له 10 أذرع', a: false },
  { q: 'الأخطبوط له 8 أذرع', a: true },
  { q: 'المريخ هو الكوكب الأقرب للشمس', a: false },
  { q: 'عطارد هو الكوكب الأقرب للشمس', a: true },
  { q: 'القلب يضخ الدم في الجسم', a: true },
  { q: 'الدماغ البشري يعمل بكامل طاقته فقط 10%', a: false },
  { q: 'النيل أطول نهر في العالم', a: true },
  { q: 'الأمازون أطول نهر في العالم', a: false },
  { q: 'الذهب معدن موصل للكهرباء', a: true },
  { q: 'الهواء مكوّن بالكامل من الأكسجين', a: false },
  { q: 'الأرض تدور حول نفسها في 24 ساعة', a: true },
  { q: 'اليابان دولة عربية', a: false },
  { q: 'الكعبة المشرفة تقع في مكة المكرمة', a: true },
  { q: 'البرج الإيفل موجود في لندن', a: false },
  { q: 'تمثال الحرية هدية من فرنسا للولايات المتحدة', a: true },
  { q: 'القطب الجنوبي أكثر برودة من القطب الشمالي', a: true },
  { q: 'الضوء أسرع من الصوت', a: true },
  { q: 'الشوكولاتة مفيدة للكلاب', a: false },
  { q: 'القمر قمر طبيعي للأرض', a: true },
  { q: 'للمشتري قمر واحد فقط', a: false },
  { q: 'الديناصورات كانت تعيش مع البشر', a: false },
  { q: 'الدم البشري أحمر اللون', a: true },
  { q: 'كل البشر لديهم نفس بصمة الأصبع', a: false },
];

module.exports.config = {
  name: 'صواب_خطأ',
  aliases: ['trivia', 'tf', 'صح_خطأ'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'لعبة صواب وخطأ — 5 أسئلة متتالية',
  commandCategory: 'ألعاب',
  usages: 'صواب_خطأ',
  cooldowns: 5,
};
module.exports.languages = { vi: {}, en: {} };

function pickRandom(n) {
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const questions = pickRandom(5);
  const q = questions[0];
  return api.sendMessage(
    `🧠 صواب أم خطأ؟\n━━━━━━━━━━━━━\nسؤال 1/5:\n\n"${q.q}"\n\n↩️ رد بـ ص (صواب) أو خ (خطأ)`,
    threadID,
    (err, info) => {
      if (err || !info) return;
      global.client.handleReply.push({
        name: 'صواب_خطأ', messageID: info.messageID, author: senderID,
        questions, currentIdx: 0, score: 0,
      });
    },
    messageID
  );
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;
  const raw = String(body || '').trim().toLowerCase();
  const ans = raw === 'ص' || raw === 'صواب' || raw === 'صح' || raw === 'true';
  const { questions, currentIdx, score } = handleReply;
  const q = questions[currentIdx];
  const correct = ans === q.a;
  const newScore = score + (correct ? 1 : 0);
  const nextIdx = currentIdx + 1;
  let feedback = correct ? '✅ صحيح!' : `❌ خطأ! الجواب: ${q.a ? 'صواب' : 'خطأ'}`;
  if (nextIdx >= questions.length) {
    const emoji = newScore >= 4 ? '🏆' : newScore >= 2 ? '👍' : '😅';
    return api.sendMessage(
      `${feedback}\n\n${emoji} انتهت اللعبة!\nنتيجتك: ${newScore}/5`,
      threadID, messageID
    );
  }
  const next = questions[nextIdx];
  return api.sendMessage(
    `${feedback}\n\n🧠 سؤال ${nextIdx + 1}/5:\n\n"${next.q}"\n\n↩️ رد بـ ص أو خ`,
    threadID,
    (err, info) => {
      if (err || !info) return;
      global.client.handleReply.push({ ...handleReply, messageID: info.messageID, currentIdx: nextIdx, score: newScore });
    },
    messageID
  );
};
