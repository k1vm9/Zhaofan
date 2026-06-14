const fs   = require("fs-extra");
const path = require("path");
const { atomicWriteFileSync } = (() => {
  try { return require('../../utils/atomicWrite'); }
  catch (_) { return { atomicWriteFileSync: fs.writeFileSync }; }
})();

module.exports = {
  config: {
    name:            "cookieupdate",
    version:         "1.0",
    author:          "DJAMEL",
    cooldowns:       10,
    hasPermssion:    2,
    description:     "حفظ الكوكيز الحية الآن في ZAO-STATE.json و alt.json",
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
      const appState = api.getAppState();

      if (!appState || !Array.isArray(appState) || appState.length === 0) {
        return api.sendMessage("❌ لا توجد جلسة نشطة. هل البوت مسجّل الدخول؟", threadID, messageID);
      }

      const statePath = path.join(process.cwd(), global.config?.APPSTATEPATH || "ZAO-STATE.json");
      const altPath   = path.join(process.cwd(), "alt.json");

      const newData   = JSON.stringify(appState, null, 2);

      atomicWriteFileSync(statePath, newData, "utf-8");
      atomicWriteFileSync(altPath,   newData, "utf-8");

      global["lastAltJsonSave"] = Date.now();

      const now = new Date().toLocaleString("ar-DZ");

      return api.sendMessage(
        `✅ تم حفظ الكوكيز بنجاح!\n\n` +
        `🍪 عدد الكوكيز : ${appState.length}\n` +
        `🕐 وقت الحفظ   : ${now}\n` +
        `📁 الملفات     : ZAO-STATE.json & alt.json\n\n` +
        `⚡.`,
        threadID,
        messageID
      );
    } catch (err) {
      return api.sendMessage(`❌ فشل حفظ الكوكيز.\nالسبب: ${err.message}`, threadID, messageID);
    }
  }
};
