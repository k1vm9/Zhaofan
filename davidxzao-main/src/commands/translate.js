const axios = require("axios");

module.exports.config = {
  name: "translate",
  aliases: ["trans", "ترجمة", "ترجم"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (NTKhang/adapted)",
  description: "ترجمة النص إلى أي لغة",
  commandCategory: "أدوات",
  usages: "translate [نص] [-> رمز اللغة]\nأو: رد على رسالة + translate [-> رمز اللغة]\nمثال: translate hello -> ar",
  cooldowns: 5
};

async function doTranslate(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await axios.get(url, { timeout: 10000 });
  const translated = res.data[0].map(item => item[0]).join("");
  const srcLang = res.data[2] || "auto";
  return { translated, srcLang };
}

const LANG_NAMES = {
  ar: "العربية", en: "الإنجليزية", fr: "الفرنسية", es: "الإسبانية",
  de: "الألمانية", tr: "التركية", fa: "الفارسية", ru: "الروسية",
  zh: "الصينية", ja: "اليابانية", ko: "الكورية", hi: "الهندية",
  pt: "البرتغالية", it: "الإيطالية", nl: "الهولندية", pl: "البولندية",
  vi: "الفيتنامية", th: "التايلاندية", id: "الإندونيسية", ms: "الملايوية"
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  let content = "";
  let targetLang = "ar";

  if (event.messageReply) {
    content = event.messageReply.body || "";
    const body = (event.body || "").trim();
    const arrowIdx = body.lastIndexOf("->");
    if (arrowIdx !== -1) {
      const candidate = body.slice(arrowIdx + 2).trim();
      if (/^[a-z]{2,3}$/.test(candidate)) targetLang = candidate;
    } else if (args[0] && /^[a-z]{2,3}$/.test(args[0])) {
      targetLang = args[0];
    }
  } else {
    const fullText = args.join(" ");
    const arrowIdx = fullText.lastIndexOf("->");
    if (arrowIdx !== -1) {
      const candidate = fullText.slice(arrowIdx + 2).trim();
      if (/^[a-z]{2,3}$/.test(candidate)) {
        targetLang = candidate;
        content = fullText.slice(0, arrowIdx).trim();
      } else {
        content = fullText;
      }
    } else {
      content = fullText;
    }
  }

  if (!content) {
    return api.sendMessage(
      "⚠️ الاستخدام:\n.translate [نص] [-> رمز اللغة]\nمثال: .translate hello -> ar\n\nأو رد على رسالة + .translate -> en",
      threadID,
      messageID
    );
  }

  try {
    const { translated, srcLang } = await doTranslate(content, targetLang);
    const fromName = LANG_NAMES[srcLang] || srcLang;
    const toName = LANG_NAMES[targetLang] || targetLang;
    return api.sendMessage(
      `🌐 ترجمة من ${fromName} ← إلى ${toName}\n━━━━━━━━━━━━━━━\n${translated}`,
      threadID,
      messageID
    );
  } catch (e) {
    return api.sendMessage("❌ فشلت الترجمة، حاول مرة أخرى.", threadID, messageID);
  }
};
