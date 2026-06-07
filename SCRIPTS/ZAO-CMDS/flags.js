module.exports.config = {
  name: "اعلام",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "لعبة تخمين الدولة من العلم",
  commandCategory: "ألعاب",
  usages: "اعلام",
  cooldowns: 3
};

module.exports.languages = { vi: {}, en: {} };

const FLAGS = [
  { flag: "🇩🇿", names: ["الجزائر", "جزائر", "algeria", "algerie"] },
  { flag: "🇲🇦", names: ["المغرب", "مغرب", "morocco", "maroc"] },
  { flag: "🇹🇳", names: ["تونس", "tunisia", "tunisie"] },
  { flag: "🇪🇬", names: ["مصر", "egypt", "egypte"] },
  { flag: "🇱🇾", names: ["ليبيا", "libya", "libye"] },
  { flag: "🇸🇦", names: ["السعودية", "سعودية", "saudi", "saudi arabia"] },
  { flag: "🇶🇦", names: ["قطر", "qatar"] },
  { flag: "🇰🇼", names: ["الكويت", "كويت", "kuwait"] },
  { flag: "🇦🇪", names: ["الامارات", "الإمارات", "امارات", "uae", "emirates"] },
  { flag: "🇧🇭", names: ["البحرين", "بحرين", "bahrain"] },
  { flag: "🇴🇲", names: ["عمان", "oman"] },
  { flag: "🇾🇪", names: ["اليمن", "يمن", "yemen"] },
  { flag: "🇯🇴", names: ["الاردن", "الأردن", "اردن", "jordan"] },
  { flag: "🇱🇧", names: ["لبنان", "lebanon", "liban"] },
  { flag: "🇸🇾", names: ["سوريا", "syria", "syrie"] },
  { flag: "🇮🇶", names: ["العراق", "عراق", "iraq"] },
  { flag: "🇵🇸", names: ["فلسطين", "palestine"] },
  { flag: "🇸🇩", names: ["السودان", "سودان", "sudan"] },
  { flag: "🇸🇴", names: ["الصومال", "صومال", "somalia"] },
  { flag: "🇹🇷", names: ["تركيا", "turkey", "turkiye"] },
  { flag: "🇮🇷", names: ["ايران", "إيران", "iran"] },
  { flag: "🇫🇷", names: ["فرنسا", "france"] },
  { flag: "🇪🇸", names: ["اسبانيا", "إسبانيا", "spain", "espagne"] },
  { flag: "🇮🇹", names: ["ايطاليا", "إيطاليا", "italy", "italie"] },
  { flag: "🇩🇪", names: ["المانيا", "ألمانيا", "germany", "allemagne"] },
  { flag: "🇬🇧", names: ["بريطانيا", "انجلترا", "england", "uk", "britain"] },
  { flag: "🇺🇸", names: ["امريكا", "أمريكا", "usa", "america", "etats unis"] },
  { flag: "🇨🇦", names: ["كندا", "canada"] },
  { flag: "🇧🇷", names: ["البرازيل", "برازيل", "brazil", "bresil"] },
  { flag: "🇦🇷", names: ["الارجنتين", "الأرجنتين", "argentina"] },
  { flag: "🇲🇽", names: ["المكسيك", "مكسيك", "mexico"] },
  { flag: "🇨🇳", names: ["الصين", "صين", "china", "chine"] },
  { flag: "🇯🇵", names: ["اليابان", "يابان", "japan", "japon"] },
  { flag: "🇰🇷", names: ["كوريا الجنوبية", "كوريا", "korea", "south korea"] },
  { flag: "🇮🇳", names: ["الهند", "هند", "india", "inde"] },
  { flag: "🇵🇰", names: ["باكستان", "pakistan"] },
  { flag: "🇷🇺", names: ["روسيا", "russia", "russie"] },
  { flag: "🇺🇦", names: ["اوكرانيا", "أوكرانيا", "ukraine"] },
  { flag: "🇵🇹", names: ["البرتغال", "برتغال", "portugal"] },
  { flag: "🇳🇱", names: ["هولندا", "netherlands", "holland", "pays bas"] },
  { flag: "🇧🇪", names: ["بلجيكا", "belgium", "belgique"] },
  { flag: "🇨🇭", names: ["سويسرا", "switzerland", "suisse"] },
  { flag: "🇸🇪", names: ["السويد", "سويد", "sweden", "suede"] },
  { flag: "🇳🇴", names: ["النرويج", "نرويج", "norway", "norvege"] },
  { flag: "🇫🇮", names: ["فنلندا", "finland", "finlande"] },
  { flag: "🇩🇰", names: ["الدنمارك", "دنمارك", "denmark"] },
  { flag: "🇬🇷", names: ["اليونان", "يونان", "greece", "grece"] },
  { flag: "🇵🇱", names: ["بولندا", "poland", "pologne"] },
  { flag: "🇦🇺", names: ["استراليا", "أستراليا", "australia", "australie"] },
  { flag: "🇳🇿", names: ["نيوزيلندا", "new zealand", "nouvelle zelande"] },
  { flag: "🇿🇦", names: ["جنوب افريقيا", "south africa", "afrique du sud"] },
  { flag: "🇳🇬", names: ["نيجيريا", "nigeria"] },
  { flag: "🇰🇪", names: ["كينيا", "kenya"] },
  { flag: "🇪🇹", names: ["اثيوبيا", "إثيوبيا", "ethiopia", "ethiopie"] },
  { flag: "🇸🇳", names: ["السنغال", "سنغال", "senegal"] },
  { flag: "🇨🇮", names: ["ساحل العاج", "ivory coast", "cote d'ivoire"] },
  { flag: "🇲🇱", names: ["مالي", "mali"] },
  { flag: "🇹🇭", names: ["تايلاند", "thailand", "thailande"] },
  { flag: "🇻🇳", names: ["فيتنام", "vietnam"] },
  { flag: "🇮🇩", names: ["اندونيسيا", "إندونيسيا", "indonesia", "indonesie"] },
  { flag: "🇲🇾", names: ["ماليزيا", "malaysia", "malaisie"] },
  { flag: "🇸🇬", names: ["سنغافورة", "singapore", "singapour"] },
  { flag: "🇵🇭", names: ["الفلبين", "فلبين", "philippines"] }
];

function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/[يى]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const round = pick(FLAGS);

  const msg =
    `🌍 لعبة الأعلام\n━━━━━━━━━━━━━\n${round.flag}\n━━━━━━━━━━━━━\n` +
    `↩️ رد باسم الدولة (عربي/فرنسي/انجليزي)\n💡 اكتب: استسلام — للتخلي`;

  return api.sendMessage(msg, threadID, (err, info) => {
    if (err || !info) return;
    global.client.handleReply.push({
      name: "اعلام",
      messageID: info.messageID,
      author: senderID,
      answer: round.names,
      flag: round.flag,
      tries: 0
    });
  }, messageID);
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;

  const guess = _norm(body);
  if (!guess) return;

  if (["استسلام", "استسلم", "give up", "skip"].includes(guess)) {
    return api.sendMessage(
      `🏳️ خلاص استسلمت.\nالعلم ${handleReply.flag} كان: ${handleReply.answer[0]}`,
      threadID, messageID
    );
  }

  const matched = handleReply.answer.some(a => _norm(a) === guess);

  if (matched) {
    return api.sendMessage(
      `✅ صح! ${handleReply.flag} هو ${handleReply.answer[0]} 🎉`,
      threadID, messageID
    );
  }

  handleReply.tries = (handleReply.tries || 0) + 1;

  if (handleReply.tries >= 3) {
    return api.sendMessage(
      `❌ خلاص! 3 محاولات راحوا.\nالجواب: ${handleReply.answer[0]} ${handleReply.flag}`,
      threadID, messageID
    );
  }

  // re-register the same handle so the user can keep trying
  global.client.handleReply.push({
    name: "اعلام",
    messageID: messageID,
    author: senderID,
    answer: handleReply.answer,
    flag: handleReply.flag,
    tries: handleReply.tries
  });

  return api.sendMessage(
    `❌ خطأ. حاول مرة أخرى (${handleReply.tries}/3)\n${handleReply.flag}`,
    threadID, messageID
  );
};
