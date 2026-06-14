const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache");

module.exports.config = {
  name: "pp",
  aliases: ["avatar", "pfp", "صورة"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (MOHAMMAD AKASH/adapted)",
  description: "عرض صورة الملف الشخصي لأي مستخدم",
  commandCategory: "أدوات",
  usages: "pp — صورتك\npp [@ذكر / رد على رسالة] — صورة شخص آخر",
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID, mentions } = event;

  let uid = senderID;

  if (event.messageReply) {
    uid = event.messageReply.senderID;
  } else if (mentions && Object.keys(mentions).length > 0) {
    uid = Object.keys(mentions)[0];
  } else if (args[0] && /^\d{5,}$/.test(args[0])) {
    uid = args[0];
  }

  const tmpPath = path.join(CACHE_DIR, `pp_${uid}_${Date.now()}.jpg`);

  try {
    fs.ensureDirSync(CACHE_DIR);

    let name = uid;
    try {
      const info = await api.getUserInfo(uid);
      name = info?.[uid]?.name || uid;
    } catch {}

    const imgUrl = `https://graph.facebook.com/${uid}/picture?height=720&width=720&access_token=6628568379%7Cc1e620fa708a1d5696fb991c1bde5662`;

    const res = await axios.get(imgUrl, { responseType: "arraybuffer", timeout: 15000 });
    fs.writeFileSync(tmpPath, Buffer.from(res.data));

    await api.sendMessage(
      {
        body: `🖼️ صورة الملف الشخصي لـ ${name}`,
        attachment: fs.createReadStream(tmpPath)
      },
      threadID,
      messageID
    );
  } catch (e) {
    return api.sendMessage("❌ تعذّر جلب الصورة الشخصية.", threadID, messageID);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
};
