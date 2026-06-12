const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache");

module.exports.config = {
  name: "imgen",
  aliases: ["imggen", "imagine", "صورة-ai"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (nexo_here/adapted)",
  description: "توليد صورة بالذكاء الاصطناعي من وصف نصي",
  commandCategory: "ذكاء اصطناعي",
  usages: "imgen [وصف الصورة بالإنجليزي]\nمثال: imgen a dragon flying over a castle",
  cooldowns: 15
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const prompt = args.join(" ").trim();

  if (!prompt) {
    return api.sendMessage(
      "⚠️ الاستخدام: .imgen [وصف الصورة]\nمثال: .imgen a dragon flying over a castle at sunset",
      threadID,
      messageID
    );
  }

  const waitMsg = await new Promise((resolve) =>
    api.sendMessage("🧠 جاري توليد الصورة، انتظر...", threadID, (err, info) => resolve(info))
  );

  const tmpPath = path.join(CACHE_DIR, `imgen_${senderID}_${Date.now()}.png`);

  try {
    fs.ensureDirSync(CACHE_DIR);

    const res = await axios({
      method: "GET",
      url: "https://www.arch2devs.ct.ws/api/imgen",
      params: { prompt },
      responseType: "arraybuffer",
      timeout: 30000
    });

    fs.writeFileSync(tmpPath, Buffer.from(res.data, "binary"));

    await api.sendMessage(
      {
        body: `✅ الصورة جاهزة!\n📝 الوصف: ${prompt.length > 100 ? prompt.slice(0, 100) + "…" : prompt}`,
        attachment: fs.createReadStream(tmpPath)
      },
      threadID,
      messageID
    );

    if (waitMsg?.messageID) {
      try { api.unsendMessage(waitMsg.messageID); } catch {}
    }
  } catch (e) {
    if (waitMsg?.messageID) {
      try { api.unsendMessage(waitMsg.messageID); } catch {}
    }
    return api.sendMessage(
      "❌ فشل توليد الصورة — السيرفر مشغول، حاول لاحقاً.",
      threadID,
      messageID
    );
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
};
