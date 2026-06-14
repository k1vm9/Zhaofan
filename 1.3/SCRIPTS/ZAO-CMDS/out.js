module.exports.config = {
  name: "out",
  version: "1.1.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "إخراج البوت من الغروب",
  commandCategory: "إدارة البوت",
  usages: "out [group id]",
  cooldowns: 5
};

module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, isGroup } = event;

  const targetID = args[0] ? String(args[0]).trim() : null;

  if (!targetID && !isGroup) {
    return api.sendMessage("⚠️ هذا الأمر يعمل في الغروبات فقط، أو حدد ID الغروب: .out <id>", threadID, messageID);
  }

  const exitThread = targetID || String(threadID);

  const botID = (api.getCurrentUserID && api.getCurrentUserID()) || global.botUserID;
  if (!botID) {
    return api.sendMessage("❌ ما قدرتش نحدد ID البوت.", threadID, messageID);
  }

  try {
    await api.sendMessage(
      targetID
        ? `👋 خارج من الغروب: ${exitThread}...`
        : "👋 وداعاً! خارج من الغروب...",
      threadID
    );
  } catch (_) {}

  setTimeout(() => {
    try {
      api.removeUserFromGroup(String(botID), exitThread, (err) => {
        if (err) {
          api.sendMessage(`❌ فشل الخروج: ${err.message || "خطأ غير معروف"}`, threadID, messageID);
        }
      });
    } catch (e) {
      api.sendMessage(`❌ فشل الخروج: ${e.message || "خطأ غير معروف"}`, threadID, messageID);
    }
  }, 800);
};
