module.exports.config = {
  name: "unsend",
  aliases: ["u", "uns", "del"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (NTKhang/adapted)",
  description: "سحب رسالة البوت — رد على رسالة البوت لسحبها",
  commandCategory: "أدوات",
  usages: "unsend [رد على رسالة البوت]",
  cooldowns: 3
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  if (!event.messageReply) {
    return api.sendMessage(
      "⚠️ رد على رسالة البوت التي تريد سحبها ثم استخدم الأمر.",
      threadID,
      messageID
    );
  }

  const botID = api.getCurrentUserID();
  if (event.messageReply.senderID !== botID) {
    return api.sendMessage(
      "❌ يمكنني فقط سحب رسائلي أنا.",
      threadID,
      messageID
    );
  }

  try {
    await api.unsendMessage(event.messageReply.messageID);
  } catch (e) {
    return api.sendMessage("❌ فشل سحب الرسالة.", threadID, messageID);
  }
};
