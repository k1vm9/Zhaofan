module.exports.config = {
  name: "جلب",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "إرسال ID الغروب",
  commandCategory: "معلومات",
  usages: "جلب",
  cooldowns: 3
};

module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, isGroup } = event;

  const label = isGroup ? "🆔 ID الغروب" : "🆔 ID المحادثة";
  return api.sendMessage(`${label}:\n${threadID}`, threadID, messageID);
};
