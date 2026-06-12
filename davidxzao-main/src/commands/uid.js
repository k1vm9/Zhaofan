module.exports.config = {
  name: "uid",
  aliases: ["id", "getid"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO Team",
  description: "الحصول على معرف المستخدم (UID) — اذكر شخصاً أو رد على رسالته",
  commandCategory: "أدوات",
  usages: "uid [@ذكر / رد على رسالة]",
  cooldowns: 3
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID, mentions } = event;

  let targetID = null;
  let source = "أنت";

  if (event.messageReply) {
    targetID = event.messageReply.senderID;
    source = "المستخدم المردود عليه";
  } else if (mentions && Object.keys(mentions).length > 0) {
    targetID = Object.keys(mentions)[0];
    source = "المستخدم المذكور";
  } else if (args[0] && /^\d{5,}$/.test(args[0])) {
    targetID = args[0];
    source = "المعرف المُدخل";
  } else {
    targetID = senderID;
    source = "أنت";
  }

  try {
    const info = await api.getUserInfo(targetID);
    const user = info?.[targetID];
    const name = user?.name || `مستخدم`;
    const gender = user?.gender === "MALE" ? "ذكر" : user?.gender === "FEMALE" ? "أنثى" : "غير محدد";

    const msg = [
      "┌────────────────────┐",
      "│   🆔 معلومات المستخدم   │",
      "└────────────────────┘",
      "",
      `👤 الاسم:    ${name}`,
      `🔢 المعرف:  ${targetID}`,
      `⚧️ الجنس:   ${gender}`,
      `📌 المصدر:  ${source}`
    ].join("\n");

    api.sendMessage(msg, threadID, messageID);

  } catch (e) {
    const msg = [
      "┌────────────────────┐",
      "│   🆔 معرف المستخدم   │",
      "└────────────────────┘",
      "",
      `🔢 المعرف: ${targetID}`,
      `📌 المصدر: ${source}`
    ].join("\n");

    api.sendMessage(msg, threadID, messageID);
  }
};
