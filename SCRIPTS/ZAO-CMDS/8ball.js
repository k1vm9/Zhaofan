const ANSWERS = [
  "✅ نعم، بالتأكيد!",
  "✅ كل المؤشرات تقول نعم",
  "✅ الأمور تسير لصالحك",
  "✅ يبدو ذلك صحيحاً",
  "✅ اعتمد عليه",
  "😎 بالتأكيد!",
  "😎 كما أرى، نعم!",
  "🔮 المصادر تقول نعم",
  "🔮 من الصعب التنبؤ الآن",
  "🔮 تركّز وأعد السؤال",
  "🤔 أعد السؤال لاحقاً",
  "🤔 غير واضح، حاول مجدداً",
  "🤔 لا أستطيع الإجابة الآن",
  "❌ لا تعتمد على ذلك",
  "❌ الإجابة هي لا",
  "❌ الأفق يبدو ضبابياً",
];

module.exports.config = {
  name: "كرة8",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "SAIN",
  description: "كرة السحر الثمانية — جرب حظك",
  commandCategory: "ترفيه",
  usages: "كرة8 [سؤالك]",
  cooldowns: 3
};

module.exports.run = async function ({ api, event, args }) {
  const q      = args.join(" ").trim();
  const answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  const msg    = q
    ? `🎱 سؤالك:\n${q}\n\n🔮 الإجابة:\n${answer}`
    : `🎱 الكرة السحرية تقول:\n\n${answer}`;
  api.sendMessage(msg, event.threadID, event.messageID);
};
