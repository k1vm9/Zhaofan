module.exports.config = {
  name: "تيست",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "",
  description: "",
  commandCategory: "تيست",
  usages: "",
  cooldowns: 0
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;
  try {
    const info = await api.getThreadInfo(threadID);
    return api.sendMessage(JSON.stringify(info, null, 2).slice(0, 1000), threadID, messageID);
  } catch (e) {
    return api.sendMessage("خطأ: " + e.message, threadID, messageID);
  }
};