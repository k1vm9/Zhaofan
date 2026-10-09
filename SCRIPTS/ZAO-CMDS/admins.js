const fs = require("fs-extra");
const { CONFIG_PATH } = require("../../src/utils/runtimePaths");
const { mergeLegacySettings } = require("../../src/utils/zaoCompatibility");
const { extractAdminTargetIds, updateAdminIds } = require("../../src/utils/adminManagement");

function loadSettings() {
  return fs.readJsonSync(CONFIG_PATH);
}

function saveSettings(cfg) {
  const temp = `${CONFIG_PATH}.admin-${process.pid}-${Date.now()}`;
  fs.ensureDirSync(require("path").dirname(CONFIG_PATH));
  fs.writeFileSync(temp, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) {}
  if (typeof global.updateRuntimeConfig === "function") global.updateRuntimeConfig(cfg);
  else {
    global.config = mergeLegacySettings(cfg);
    global.ownerID = String(cfg.ownerID || "");
    global.commandPrefix = cfg.prefix || "/";
  }
}

module.exports.config = {
  name: "admins",
  aliases: ["admin", "ادمن", "أدمن"],
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "إضافة/حذف/عرض أدمن البوت بدون لوحة التحكم",
  commandCategory: "إدارة البوت",
  usages: "add/remove/list + (uid/@tag/reply)",
  cooldowns: 3
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID, senderID } = event;

  if (permssion < 2) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }

  const sub = (args[0] || "").toLowerCase();

  if (!sub || !["add", "-a", "remove", "-r", "list", "-l"].includes(sub)) {
    return api.sendMessage(
      "📌 الاستخدام:\n" +
        "admins add @tag / uid / reply\n" +
        "admins remove @tag / uid / reply\n" +
        "admins list",
      threadID,
      messageID
    );
  }

  let cfg;
  try {
    cfg = loadSettings();
  } catch (e) {
    return api.sendMessage("❌ تعذرت قراءة إعدادات Djamel-Fca.", threadID, messageID);
  }

  cfg.adminBot = Array.isArray(cfg.adminBot) ? cfg.adminBot.map(String) : [];

  if (sub === "list" || sub === "-l") {
    const admins = cfg.adminBot;
    if (!admins.length) return api.sendMessage("📭 لا يوجد أدمن حالياً.", threadID, messageID);
    return api.sendMessage("👑 أدمن البوت:\n" + admins.map((id, i) => `${i + 1}. ${id}`).join("\n"), threadID, messageID);
  }

  const targetIds = extractAdminTargetIds(event, args.slice(1));
  if (!targetIds.length) {
    return api.sendMessage("⚠️ لازم تحدد UID أو تعمل منشن أو ترد على رسالة الشخص.", threadID, messageID);
  }

  if (sub === "add" || sub === "-a") {
    const result = updateAdminIds(cfg.adminBot, "add", targetIds, { ownerID: cfg.ownerID, senderID });
    cfg.adminBot = result.adminBot;
    try {
      global._selfWriteConfig = true;
      saveSettings(cfg);
      setTimeout(() => { global._selfWriteConfig = false; }, 3000);
    } catch (e) {
      return api.sendMessage("❌ فشل حفظ الإعدادات.", threadID, messageID);
    }

    let msg = "";
    if (result.added.length) msg += "✅ تمت الإضافة:\n" + result.added.join("\n") + "\n\n";
    if (result.already.length) msg += "⚠️ موجودين من قبل:\n" + result.already.join("\n");
    msg = (msg.trim() || "⚠️ لم يتم أي تغيير.");
    return api.sendMessage(msg, threadID, messageID);
  }

  if (sub === "remove" || sub === "-r") {
    const result = updateAdminIds(cfg.adminBot, "remove", targetIds, { ownerID: cfg.ownerID, senderID });
    cfg.adminBot = result.adminBot;

    try {
      global._selfWriteConfig = true;
      saveSettings(cfg);
      setTimeout(() => { global._selfWriteConfig = false; }, 3000);
    } catch (e) {
      return api.sendMessage("❌ فشل حفظ الإعدادات.", threadID, messageID);
    }

    let msg = "";
    if (result.removed.length) msg += "✅ تمت الإزالة:\n" + result.removed.join("\n") + "\n\n";
    if (result.notAdmin.length) msg += "⚠️ غير أدمن/لم تتم إزالتهم:\n" + result.notAdmin.join("\n");
    msg = (msg.trim() || "⚠️ لم يتم أي تغيير.");
    return api.sendMessage(msg, threadID, messageID);
  }
};
