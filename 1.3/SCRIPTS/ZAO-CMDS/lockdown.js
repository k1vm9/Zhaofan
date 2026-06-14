const fs = require("fs-extra");
const path = require("path");
const { atomicWriteFileSync } = (() => {
  try { return require('../../utils/atomicWrite'); }
  catch (_) { return { atomicWriteFileSync: fs.writeFileSync }; }
})();

const SETTINGS_PATH = path.join(__dirname, "../../data/autoinvite_settings.json");

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSettings(data) {
  try {
    fs.ensureDirSync(path.dirname(SETTINGS_PATH));
    atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) { console.error("[lockdown:save]", e.message); return false; }
}

module.exports.config = {
  name: "lockdown",
  aliases: ["ld", "autoadd", "lock"],
  version: "1.0.0",
  hasPermssion: 2,
  credits: "White → ZAO (Djamel/adapted)",
  description: "تفعيل أو إيقاف إعادة الإضافة التلقائية لمن يغادر المجموعة",
  commandCategory: "إدارة المجموعة",
  usages: "lockdown on | off | status",
  cooldowns: 3
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const action = (args[0] || "").toLowerCase().trim();

  const settings = loadSettings();

  if (action === "on") {
    settings[threadID] = true;
    if (!saveSettings(settings)) {
      return api.sendMessage("❌ فشل حفظ الإعداد.", threadID, messageID);
    }
    return api.sendMessage(
      "✅ تم تفعيل إعادة الإضافة التلقائية لهذه المجموعة.\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      "🔒 أي شخص يغادر سيتم إعادته تلقائياً.\n" +
      "⚠️ تأكد أن البوت لديه صلاحية إضافة الأعضاء.",
      threadID, messageID
    );
  }

  if (action === "off") {
    settings[threadID] = false;
    if (!saveSettings(settings)) {
      return api.sendMessage("❌ فشل حفظ الإعداد.", threadID, messageID);
    }
    return api.sendMessage(
      "🔓 تم إيقاف إعادة الإضافة التلقائية لهذه المجموعة.\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      "✅ يمكن للأعضاء المغادرة بحرية الآن.",
      threadID, messageID
    );
  }

  if (action === "status") {
    const isActive = settings[threadID] === true;
    return api.sendMessage(
      `📊 حالة إعادة الإضافة التلقائية:\n━━━━━━━━━━━━━━━━━━\n` +
      `${isActive ? "✅ مفعّلة — من يغادر يُعاد تلقائياً" : "🔓 موقوفة — يمكن للجميع المغادرة"}`,
      threadID, messageID
    );
  }

  return api.sendMessage(
    "⚙️ أوامر lockdown:\n━━━━━━━━━━━━━━━━━━\n" +
    "• .lockdown on     ─ تفعيل الإضافة التلقائية\n" +
    "• .lockdown off    ─ إيقاف الإضافة التلقائية\n" +
    "• .lockdown status ─ عرض الحالة الحالية\n\n" +
    "⚠️ يتطلب أن يكون البوت أدمناً في المجموعة.",
    threadID, messageID
  );
};
