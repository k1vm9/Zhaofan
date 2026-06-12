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

function _live(api) {
  return global._botApi || api;
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, isGroup } = event;
  const liveApi = _live(api);

  const targetID = args[0] ? String(args[0]).trim() : null;

  if (!targetID && !isGroup) {
    return liveApi.sendMessage("⚠️ هذا الأمر يعمل في الغروبات فقط، أو حدد ID الغروب: .out <id>", threadID, messageID);
  }

  const exitThread = targetID || String(threadID);

  const botID = (liveApi.getCurrentUserID && liveApi.getCurrentUserID()) || global.botUserID;
  if (!botID) {
    return liveApi.sendMessage("❌ ما قدرتش نحدد ID البوت.", threadID, messageID);
  }

  try {
    await liveApi.sendMessage(
      targetID
        ? `👋 خارج من الغروب: ${exitThread}...`
        : "👋 وداعاً! خارج من الغروب...",
      threadID
    );
  } catch (_) {}

  setTimeout(() => {
    try {
      const currentLive = _live(api);
      currentLive.removeUserFromGroup(String(botID), exitThread, (err) => {
        if (err) {
          currentLive.sendMessage(`❌ فشل الخروج: ${err.message || "خطأ غير معروف"}`, threadID, messageID);
        }
      });
    } catch (e) {
      const currentLive = _live(api);
      currentLive.sendMessage(`❌ فشل الخروج: ${e.message || "خطأ غير معروف"}`, threadID, messageID);
    }
  }, 800);
};
