module.exports.config = {
  name: "رست",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "SAIN",
  description: "إعادة تشغيل البوت",
  commandCategory: "إدارة البوت",
  usages: "",
  cooldowns: 0
};

module.exports.languages = {
  "vi": {},
  "en": {}
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;

  if (!global.config.ADMINBOT.includes(senderID.toString()))
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);

  await api.sendMessage("🔄 جاري إعادة تشغيل البوت...", threadID, messageID);
  process.exit(0);
};