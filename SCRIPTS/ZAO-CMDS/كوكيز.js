module.exports.config = {
  name: "كوكيز",
  aliases: ["savecookies"],
  version: "1.1.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "حفظ الكوكيز الحالية فوراً على الملفات",
  commandCategory: "النظام",
  usages: "كوكيز",
  cooldowns: 10
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;

  const adminIDs = (global.config?.ADMINBOT || []).map(String);
  if (!adminIDs.includes(String(senderID))) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }

  try {
    const { doSaveCookies } = require("../../src/protection/keepAlive");
    await doSaveCookies("manual-cmd", api);
    return api.sendMessage(
      "✅ تم حفظ الكوكيز بنجاح!\n" +
      "📄 ملف جلسة Djamel-Fca ✓",
      threadID,
      messageID
    );
  } catch (e) {
    return api.sendMessage(`❌ فشل حفظ الكوكيز:\n${e.message}`, threadID, messageID);
  }
};
