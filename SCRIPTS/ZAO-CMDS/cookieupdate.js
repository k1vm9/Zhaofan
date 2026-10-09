module.exports = {
  config: {
    name:            "cookieupdate",
    version:         "1.0",
    author:          "DJAMEL",
    cooldowns:       10,
    hasPermssion:    2,
    description:     "حفظ الكوكيز الحية في ملف جلسة Djamel-Fca",
    commandCategory: "admin",
    guide:           "  {pn}",
    usePrefix:       true
  },

  run: async function ({ api, event }) {
    const { threadID, messageID, senderID } = event;

    const adminIDs = (global.config?.ADMINBOT || []).map(String);
    if (!adminIDs.includes(String(senderID))) {
      return api.sendMessage("❌ هذا الأمر مخصص للأدمن فقط.", threadID, messageID);
    }

    try {
      const { doSaveCookies } = require("../../src/protection/keepAlive");
      const saved = await doSaveCookies("manual-command", api);
      const now = new Date().toLocaleString("ar-DZ");
      return api.sendMessage(
        `✅ تم حفظ الكوكيز بنجاح!\n\n` +
        `🍪 عدد الكوكيز : ${saved.count}\n` +
        `🕐 وقت الحفظ   : ${now}\n` +
        `📁 ملف الجلسة  : ${require("../../src/utils/runtimePaths").ACCOUNT_PATH}\n\n` +
        `⚡.`,
        threadID,
        messageID
      );
    } catch (err) {
      return api.sendMessage(`❌ فشل حفظ الكوكيز.\nالسبب: ${err.message}`, threadID, messageID);
    }
  }
};
