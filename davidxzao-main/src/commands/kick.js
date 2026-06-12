const moment = require("moment-timezone");

module.exports.config = {
  name: "kick",
  aliases: ["طرد"],
  version: "1.0.0",
  hasPermssion: 1,
  credits: "White → ZAO (NTKhang/adapted)",
  description: "طرد عضو أو أعضاء من المجموعة",
  commandCategory: "إدارة المجموعة",
  usages: "kick [@ذكر / رد على رسالة]",
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, mentions } = event;

  const botID = api.getCurrentUserID();

  async function doKick(uid) {
    if (uid === botID) {
      return api.sendMessage("❌ لا يمكنني طرد نفسي.", threadID, messageID);
    }
    try {
      await api.removeUserFromGroup(uid, threadID);
    } catch (e) {
      api.sendMessage(
        "⚠️ فشل الطرد — تأكد أن البوت أدمن في المجموعة.",
        threadID,
        messageID
      );
    }
  }

  const mentionIDs = Object.keys(mentions || {});

  if (mentionIDs.length > 0) {
    for (const uid of mentionIDs) await doKick(uid);
    return api.sendMessage(
      `✅ تم طرد ${mentionIDs.length} عضو${mentionIDs.length > 1 ? "ين" : ""} من المجموعة.`,
      threadID,
      messageID
    );
  }

  if (event.messageReply) {
    const uid = event.messageReply.senderID;
    await doKick(uid);
    try {
      const info = await api.getUserInfo(uid);
      const name = info?.[uid]?.name || uid;
      return api.sendMessage(`✅ تم طرد ${name} من المجموعة.`, threadID, messageID);
    } catch {
      return api.sendMessage("✅ تم الطرد.", threadID, messageID);
    }
  }

  return api.sendMessage(
    "⚠️ الاستخدام: اذكر شخصاً أو رد على رسالته\nمثال: .kick @شخص",
    threadID,
    messageID
  );
};
