const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache");
const FB_TOKEN = "6628568379%7Cc1e620fa708a1d5696fb991c1bde5662";

module.exports.config = {
  name: "pair",
  aliases: ["زواج", "تزاوج"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (nexo_here/adapted)",
  description: "تزاوج عشوائي بين عضوين في المجموعة",
  commandCategory: "ترفيه",
  usages: "pair",
  cooldowns: 10
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;

  let participantIDs;
  try {
    const threadInfo = await api.getThreadInfo(threadID);
    participantIDs = threadInfo.participantIDs || [];
  } catch {
    return api.sendMessage("❌ فشل جلب أعضاء المجموعة.", threadID, messageID);
  }

  const botID = api.getCurrentUserID();
  const others = participantIDs.filter(id => id !== botID && id !== senderID);

  if (others.length === 0) {
    return api.sendMessage("❌ لا يوجد أعضاء كافيون للتزاوج!", threadID, messageID);
  }

  const partnerId = others[Math.floor(Math.random() * others.length)];
  const lovePercent = Math.floor(Math.random() * 101);

  let senderName = senderID, partnerName = partnerId;
  try {
    const info = await api.getUserInfo([senderID, partnerId]);
    senderName = info?.[senderID]?.name || senderID;
    partnerName = info?.[partnerId]?.name || partnerId;
  } catch {}

  fs.ensureDirSync(CACHE_DIR);

  const avt1Path = path.join(CACHE_DIR, `pair_avt1_${Date.now()}.png`);
  const avt2Path = path.join(CACHE_DIR, `pair_avt2_${Date.now()}.png`);
  const heartPath = path.join(CACHE_DIR, `pair_heart_${Date.now()}.png`);

  const attachments = [];

  try {
    const [a1, heart, a2] = await Promise.allSettled([
      axios.get(`https://graph.facebook.com/${senderID}/picture?width=512&height=512&access_token=${FB_TOKEN}`, { responseType: "arraybuffer", timeout: 10000 }),
      axios.get("https://i.ibb.co/y4dWfQq/image.gif", { responseType: "arraybuffer", timeout: 10000 }),
      axios.get(`https://graph.facebook.com/${partnerId}/picture?width=512&height=512&access_token=${FB_TOKEN}`, { responseType: "arraybuffer", timeout: 10000 })
    ]);

    if (a1.status === "fulfilled") { fs.writeFileSync(avt1Path, Buffer.from(a1.value.data)); attachments.push(fs.createReadStream(avt1Path)); }
    if (heart.status === "fulfilled") { fs.writeFileSync(heartPath, Buffer.from(heart.value.data)); attachments.push(fs.createReadStream(heartPath)); }
    if (a2.status === "fulfilled") { fs.writeFileSync(avt2Path, Buffer.from(a2.value.data)); attachments.push(fs.createReadStream(avt2Path)); }
  } catch {}

  const msgObj = {
    body: `💕 تهانينا على الزواج!\n━━━━━━━━━━━━━━━\n👤 ${senderName}\n💓 نسبة التوافق: ${lovePercent}%\n👤 ${partnerName}\n━━━━━━━━━━━━━━━\n🥂 عقبال مية عام سعادة!`,
    mentions: [
      { id: senderID, tag: senderName },
      { id: partnerId, tag: partnerName }
    ]
  };
  if (attachments.length > 0) msgObj.attachment = attachments;

  api.sendMessage(msgObj, threadID, () => {
    try { if (fs.existsSync(avt1Path)) fs.unlinkSync(avt1Path); } catch {}
    try { if (fs.existsSync(avt2Path)) fs.unlinkSync(avt2Path); } catch {}
    try { if (fs.existsSync(heartPath)) fs.unlinkSync(heartPath); } catch {}
  }, messageID);
};
