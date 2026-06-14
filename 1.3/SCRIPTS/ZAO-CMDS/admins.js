const fs = require("fs-extra");
const path = require("path");
const { atomicWriteJsonSync } = require("../../utils/atomicWrite");
const runtimePersist = require("../../includes/runtimePersist");

const SETTINGS_PATH = path.join(process.cwd(), "ZAO-SETTINGS.json");

function loadSettings() {
  return fs.readJsonSync(SETTINGS_PATH);
}

function saveSettings(cfg) {
  // atomicWriteJsonSync writes to a temp file, fsyncs, then renames — so a
  // crash mid-write can never leave ZAO-SETTINGS.json empty or half-written.
  atomicWriteJsonSync(SETTINGS_PATH, cfg);
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const s = String(v);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function extractTargetIds(event, args) {
  const ids = new Set();

  try {
    if (event?.messageReply?.senderID) ids.add(String(event.messageReply.senderID));
  } catch (_) {}

  try {
    if (event?.mentions && typeof event.mentions === "object") {
      for (const k of Object.keys(event.mentions)) ids.add(String(k));
    }
  } catch (_) {}

  for (const a of args) {
    if (!a) continue;
    if (/^\d{5,}$/.test(a)) ids.add(String(a));
  }

  return Array.from(ids);
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
    return api.sendMessage("❌ فشل قراءة ZAO-SETTINGS.json", threadID, messageID);
  }

  cfg.ADMINBOT = uniqStrings(cfg.ADMINBOT || []);

  if (sub === "list" || sub === "-l") {
    const admins = cfg.ADMINBOT;
    if (!admins.length) return api.sendMessage("📭 لا يوجد أدمن حالياً.", threadID, messageID);
    return api.sendMessage("👑 أدمن البوت:\n" + admins.map((id, i) => `${i + 1}. ${id}`).join("\n"), threadID, messageID);
  }

  const targetIds = extractTargetIds(event, args.slice(1));
  if (!targetIds.length) {
    return api.sendMessage("⚠️ لازم تحدد UID أو تعمل منشن أو ترد على رسالة الشخص.", threadID, messageID);
  }

  if (sub === "add" || sub === "-a") {
    const already = [];
    const added = [];
    for (const id of targetIds) {
      if (cfg.ADMINBOT.includes(id)) already.push(id);
      else {
        cfg.ADMINBOT.push(id);
        added.push(id);
      }
    }
    cfg.ADMINBOT = uniqStrings(cfg.ADMINBOT);
    try {
      saveSettings(cfg);
      runtimePersist.setAdmins(cfg.ADMINBOT);
    } catch (e) {
      return api.sendMessage("❌ فشل حفظ الإعدادات.", threadID, messageID);
    }

    let msg = "";
    if (added.length) msg += "✅ تمت الإضافة:\n" + added.join("\n") + "\n\n";
    if (already.length) msg += "⚠️ موجودين من قبل:\n" + already.join("\n");
    msg = (msg.trim() || "⚠️ لم يتم أي تغيير.");
    msg += runtimePersist.persistHint(cfg.ADMINBOT);
    return api.sendMessage(msg, threadID, messageID);
  }

  if (sub === "remove" || sub === "-r") {
    const removed = [];
    const notAdmin = [];

    for (const id of targetIds) {
      if (!cfg.ADMINBOT.includes(id)) notAdmin.push(id);
      else {
        // protect from removing yourself as the last admin
        if (String(id) === String(senderID) && cfg.ADMINBOT.length === 1) {
          notAdmin.push(id);
          continue;
        }
        cfg.ADMINBOT.splice(cfg.ADMINBOT.indexOf(id), 1);
        removed.push(id);
      }
    }

    cfg.ADMINBOT = uniqStrings(cfg.ADMINBOT);
    if (!cfg.ADMINBOT.length) cfg.ADMINBOT = uniqStrings([String(senderID)]);

    try {
      saveSettings(cfg);
      runtimePersist.setAdmins(cfg.ADMINBOT);
    } catch (e) {
      return api.sendMessage("❌ فشل حفظ الإعدادات.", threadID, messageID);
    }

    let msg = "";
    if (removed.length) msg += "✅ تمت الإزالة:\n" + removed.join("\n") + "\n\n";
    if (notAdmin.length) msg += "⚠️ غير أدمن/لم تتم إزالتهم:\n" + notAdmin.join("\n");
    msg = (msg.trim() || "⚠️ لم يتم أي تغيير.");
    msg += runtimePersist.persistHint(cfg.ADMINBOT);
    return api.sendMessage(msg, threadID, messageID);
  }
};
