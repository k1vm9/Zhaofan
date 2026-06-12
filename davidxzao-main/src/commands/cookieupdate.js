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

      const activeTier = global.activeAccountTier || 1;
      const statePath = global.activeStateFile ? path.join(process.cwd(), global.activeStateFile) : path.join(process.cwd(), "sessions/ZAO-STATE.json");
      const altPath   = global.activeAltFile   ? path.join(process.cwd(), global.activeAltFile)   : path.join(process.cwd(), "sessions/alt.json");

      const newData   = JSON.stringify(appState, null, 2);

      // Ensure sessions directory exists
      fs.ensureDirSync(path.join(process.cwd(), "sessions"));

      atomicWriteFileSync(statePath, newData, "utf-8");
      atomicWriteFileSync(altPath,   newData, "utf-8");

      global["lastAltJsonSave"] = Date.now();

      const now = new Date().toLocaleString("ar-DZ");

      return api.sendMessage(
        `✅ تم حفظ الكوكيز بنجاح (الطبقة ${activeTier})!\n\n` +
        `🍪 عدد الكوكيز : ${appState.length}\n` +
        `🕐 وقت الحفظ   : ${now}\n` +
        `📁 الملفات     : ${path.basename(statePath)} & ${path.basename(altPath)}\n\n` +
        `⚡.`,
        threadID,
        messageID
      );
    } catch (err) {
      return api.sendMessage(`❌ فشل حفظ الكوكيز.\nالسبب: ${err.message}`, threadID, messageID);
    }
  }
};
