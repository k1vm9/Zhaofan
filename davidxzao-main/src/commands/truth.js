module.exports.config = {
  name: "صراحة",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "لعبة صراحة أو جرأة — اختر س أو ج",
  commandCategory: "ألعاب",
  usages: "صراحة | صراحة س | صراحة ج",
  cooldowns: 3
};

module.exports.languages = { vi: {}, en: {} };

const TRUTHS = [
  "شكون آخر شخص بقيت تخمم فيه قبل ما ترقد؟",
  "واش هي أكبر كذبة قلتها لوالديك؟",
  "شكون من الحاضرين تحب تتبادل معاه الحياة ليوم واحد؟",
  "آخر مرة بكيت فيها كانت علاش؟",
  "واش هي أكثر حاجة محرجة وقعتلك في المدرسة؟",
  "شكون من جروبك تحس بلي ما يحبكش؟",
  "واش هو السر اللي ما قلتو لحتى واحد؟",
  "آخر مرة دخلت فيها على بروفايل واحد بطريقة سرية؟",
  "كم من مرة كذبت اليوم؟",
  "واش هي أكبر غلطة دارتها في حياتك؟",
  "شكون أكثر شخص دير معاه فيك؟",
  "إذا قدرت تمسح ذكرى وحدة، شنو تختار؟",
  "واش راك معجب بشي حد دروك؟",
  "أصعب قرار خذيتو هاد العام شنو كان؟",
  "آخر مرة غششت في امتحان؟",
  "واش تفضل: تخسر هاتفك ولا تخسر صحاب؟",
  "شكون آخر شخص ستوكتو على إنستا؟",
  "واش هي عادة عندك وتحب تخبيها؟",
  "كنت كي صغير شنو حلمت تولي؟ وعلاش ما ولّيتش؟",
  "آخر مرة قلت 'نحبك' لشخص شكون كان؟"
];

const DARES = [
  "بدّل صورة بروفايلك بأول إيموجي يطلع كي تعمل سحب على الكيبورد لمدة ساعة.",
  "ابعث رسالة 'وحشتني' لآخر شخص حكيت معاه.",
  "غني سطر من أغنية وسجل صوتية وابعثها هنا.",
  "ابعث ستوري بكتابة: 'أنا فالس فلعبة صراحة' لمدة 10 دقايق.",
  "كلم أبوك ولا أمك وقولهم 'نحبكم' بدون ما تشرح.",
  "بدل اسمك في الجروب لـ 'ضحية اللعبة' لساعة كاملة.",
  "ابعث آخر صورة فالغاليري (بدون تشيت).",
  "اعمل 10 ضغطات على الأرض دروقا وقول 'نمبر وان' في كل وحدة.",
  "ابعث رسالة عشوائية من إيموجيات لآخر شخص ستوكتو.",
  "غير صورة بروفايلك بصورة بطاطا لـ 30 دقيقة.",
  "كلم رقم عشوائي من جهات اتصالك وقولو 'مبروك ربحت'.",
  "ابعث صوتية تضحك فيها لمدة 10 ثواني.",
  "اكتب اسم آخر شخص بحثت عليه في يوتيوب.",
  "اعطي هاتفك لشخص هنا ويبعث ستوري في حقك.",
  "قول 3 حاجات تكرهها على راسك أمام الجميع.",
  "كلم أحسن صديق ليك وقولو 'نحب نقطع معاك' وشوف ردة الفعل (بعدين قولو لازم).",
  "ابعث آخر رسالة بعتها لشكون قبل 'صراحة'.",
  "خذ صورة سيلفي حالاً وابعثها بدون فلاتر.",
  "كلم جارك وسلم عليه بصوت عالي.",
  "ابعث 'kiss' في الستوري بدون شرح."
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const choice = (args[0] || "").toLowerCase();

  let mode;
  if (["س", "صراحة", "truth", "t"].includes(choice)) mode = "truth";
  else if (["ج", "جرأة", "dare", "d"].includes(choice)) mode = "dare";

  if (!mode) {
    const msg = "🎮 صراحة أو جرأة\n━━━━━━━━━━━━━\nرد بـ:\n• س — صراحة (سؤال)\n• ج — جرأة (تحدي)";
    return api.sendMessage(msg, threadID, (err, info) => {
      if (err || !info) return;
      global.client.handleReply.push({
        name: "صراحة",
        messageID: info.messageID,
        author: senderID,
        type: "pick"
      });
    }, messageID);
  }

  const text = mode === "truth"
    ? `🟢 صراحة\n━━━━━━━━━━━━━\n${pick(TRUTHS)}`
    : `🔴 جرأة\n━━━━━━━━━━━━━\n${pick(DARES)}`;

  return api.sendMessage(text, threadID, messageID);
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;
  if (handleReply.type !== "pick") return;

  const input = (body || "").trim().toLowerCase();
  if (["س", "صراحة", "truth", "t"].includes(input)) {
    return api.sendMessage(`🟢 صراحة\n━━━━━━━━━━━━━\n${pick(TRUTHS)}`, threadID, messageID);
  }
  if (["ج", "جرأة", "dare", "d"].includes(input)) {
    return api.sendMessage(`🔴 جرأة\n━━━━━━━━━━━━━\n${pick(DARES)}`, threadID, messageID);
  }
  return api.sendMessage("⚠️ اختار س ولا ج فقط.", threadID, messageID);
};
