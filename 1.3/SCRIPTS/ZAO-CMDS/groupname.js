module.exports.config = {
  name: "groupname",
  aliases: ["setname", "اسم"],
  version: "1.0.0",
  hasPermssion: 1,
  credits: "White → ZAO (Mohammad Akash/adapted)",
  description: "تغيير اسم المجموعة",
  commandCategory: "إدارة المجموعة",
  usages: "groupname [الاسم الجديد]",
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const newName = args.join(" ").trim();

  if (!newName) {
    return api.sendMessage(
      "⚠️ الاستخدام: .groupname [الاسم الجديد]\nمثال: .groupname مجموعة ZAO Bot",
      threadID,
      messageID
    );
  }

  try {
    await api.setTitle(newName, threadID);
    return api.sendMessage(
      `✅ تم تغيير اسم المجموعة إلى:\n➡️ ${newName}`,
      threadID,
      messageID
    );
  } catch (e) {
    return api.sendMessage(
      "⚠️ فشل تغيير الاسم — تأكد أن البوت أدمن في المجموعة.",
      threadID,
      messageID
    );
  }
};
