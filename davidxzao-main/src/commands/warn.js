const fs = require("fs-extra");
const path = require("path");
const moment = require("moment-timezone");

const WARN_FILE = path.join(__dirname, "../../data/warn.json");
const MAX_WARNS = 3;

function loadWarns() {
  try {
    if (!fs.existsSync(WARN_FILE)) return {};
    const raw = fs.readFileSync(WARN_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveWarns(data) {
  try {
    fs.ensureDirSync(path.dirname(WARN_FILE));
    fs.writeFileSync(WARN_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) { console.error("[warn.js:save]", e.message); }
}

function getThreadWarns(data, threadID) {
  if (!data[threadID] || typeof data[threadID] !== "object") data[threadID] = {};
  return data[threadID];
}

function _live(api) {
  return global._botApi || api;
}

async function getNameSafe(api, uid) {
  const liveApi = _live(api);
  try {
    const info = await liveApi.getUserInfo(uid);
    return info?.[uid]?.name || uid;
  } catch { return uid; }
}

module.exports.config = {
  name: "warn",
  aliases: ["تحذير", "تحذر"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (NTKhang/adapted)",
  description: `تحذير الأعضاء — ${MAX_WARNS} تحذيرات = حظر`,
  commandCategory: "إدارة المجموعة",
  usages: [
    "warn [@ذكر / رد] [السبب]       — تحذير عضو",
    "warn info [@ذكر / رد / uid]    — معلومات تحذيرات عضو",
    "warn list                       — قائمة المحذَّرين",
    "warn unwarn [@ذكر / رد] [رقم]  — إزالة تحذير",
    "warn unban [@ذكر / رد / uid]   — رفع الحظر وحذف التحذيرات",
    "warn reset                      — تصفير جميع التحذيرات"
  ].join("\n"),
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID, senderID, mentions } = event;
  const liveApi = _live(api);
  const botID = liveApi.getCurrentUserID();
  const isAdmin = permssion >= 1;
  const now = () => moment().tz("Asia/Riyadh").format("HH:mm DD/MM/YYYY");

  const data = loadWarns();
  const threadWarns = getThreadWarns(data, threadID);

  // ── warn list ─────────────────────────────────────────────────────────────
  if (args[0] === "list") {
    const entries = Object.entries(threadWarns);
    if (!entries.length) return liveApi.sendMessage("📋 لا يوجد أعضاء محذَّرون.", threadID, messageID);
    let msg = "📋 قائمة التحذيرات:\n━━━━━━━━━━━━━━━\n";
    for (const [uid, warns] of entries) {
      if (!warns.length) continue;
      const name = (global.data?.userName?.get(uid)) || uid;
      msg += `👤 ${name} (${uid}): ${warns.length}/${MAX_WARNS} تحذير\n`;
    }
    return liveApi.sendMessage(msg.trim(), threadID, messageID);
  }

  // ── warn info ──────────────────────────────────────────────────────────────
  if (args[0] === "info" || args[0] === "check") {
    let uid = senderID;
    if (event.messageReply?.senderID) uid = event.messageReply.senderID;
    else if (Object.keys(mentions || {}).length) uid = Object.keys(mentions)[0];
    else if (args[1] && !isNaN(args[1])) uid = args[1];

    const warns = threadWarns[uid] || [];
    const name = await getNameSafe(api, uid);
    if (!warns.length) return liveApi.sendMessage(`✅ ${name} ليس لديه تحذيرات.`, threadID, messageID);

    let msg = `⚠️ تحذيرات ${name} (${uid}): ${warns.length}/${MAX_WARNS}\n━━━━━━━━━━━━━━━\n`;
    warns.forEach((w, i) => {
      msg += `${i + 1}. 📌 ${w.reason}\n   🕒 ${w.dateTime}\n`;
    });
    return liveApi.sendMessage(msg.trim(), threadID, messageID);
  }

  // ── warn unban ─────────────────────────────────────────────────────────────
  if (args[0] === "unban") {
    if (!isAdmin) return liveApi.sendMessage("❌ هذا الأمر للأدمنية فقط.", threadID, messageID);
    let uid = null;
    if (event.messageReply?.senderID) uid = event.messageReply.senderID;
    else if (Object.keys(mentions || {}).length) uid = Object.keys(mentions)[0];
    else if (args[1] && !isNaN(args[1])) uid = args[1];
    if (!uid) return liveApi.sendMessage("⚠️ حدد الشخص المراد رفع حظره.", threadID, messageID);

    if (!threadWarns[uid]?.length) return liveApi.sendMessage("⚠️ هذا الشخص ليس لديه تحذيرات.", threadID, messageID);
    const name = await getNameSafe(api, uid);
    delete threadWarns[uid];
    saveWarns(data);
    return liveApi.sendMessage(`✅ تم رفع حظر ${name} وإزالة جميع تحذيراته.`, threadID, messageID);
  }

  // ── warn unwarn ─────────────────────────────────────────────────────────────
  if (args[0] === "unwarn") {
    if (!isAdmin) return liveApi.sendMessage("❌ هذا الأمر للأدمنية فقط.", threadID, messageID);
    let uid = null;
    let num = null;
    if (event.messageReply?.senderID) { uid = event.messageReply.senderID; num = parseInt(args[1]); }
    else if (Object.keys(mentions || {}).length) { uid = Object.keys(mentions)[0]; num = parseInt(args[args.length - 1]); }
    else if (args[1] && !isNaN(args[1])) { uid = args[1]; num = parseInt(args[2]); }

    if (!uid) return liveApi.sendMessage("⚠️ حدد الشخص المراد إزالة تحذيره.", threadID, messageID);
    const warns = threadWarns[uid];
    if (!warns?.length) return liveApi.sendMessage("⚠️ هذا الشخص ليس لديه تحذيرات.", threadID, messageID);

    const name = await getNameSafe(api, uid);
    const idx = (!isNaN(num) && num > 0) ? (num - 1) : warns.length - 1;
    if (idx < 0 || idx >= warns.length) {
      return liveApi.sendMessage(`❌ رقم التحذير غير صحيح (1 → ${warns.length}).`, threadID, messageID);
    }
    warns.splice(idx, 1);
    if (!warns.length) delete threadWarns[uid];
    saveWarns(data);
    return liveApi.sendMessage(`✅ تم إزالة التحذير ${idx + 1} من ${name}.`, threadID, messageID);
  }

  // ── warn reset ──────────────────────────────────────────────────────────────
  if (args[0] === "reset") {
    if (!isAdmin) return liveApi.sendMessage("❌ هذا الأمر للأدمنية فقط.", threadID, messageID);
    data[threadID] = {};
    saveWarns(data);
    return liveApi.sendMessage("✅ تم تصفير جميع بيانات التحذيرات في هذه المجموعة.", threadID, messageID);
  }

  // ── warn [target] [reason] ─────────────────────────────────────────────────
  if (!isAdmin) return liveApi.sendMessage("❌ تحذير الأعضاء للأدمنية فقط.", threadID, messageID);

  let target = null;
  let reason = "";

  if (event.messageReply?.senderID) {
    target = event.messageReply.senderID;
    reason = args.join(" ").trim();
  } else if (Object.keys(mentions || {}).length) {
    target = Object.keys(mentions)[0];
    reason = args.join(" ").replace(mentions[target] || "", "").trim();
  }

  if (!target) {
    return liveApi.sendMessage(
      "⚠️ الاستخدام: .warn [@ذكر / رد على رسالة] [السبب]\nأو: .warn info | list | unban | unwarn | reset",
      threadID, messageID
    );
  }

  if (target === senderID) return liveApi.sendMessage("❌ لا يمكنك تحذير نفسك!", threadID, messageID);
  if (target === botID) return liveApi.sendMessage("❌ لا يمكنك تحذير البوت!", threadID, messageID);

  if (!threadWarns[target]) threadWarns[target] = [];
  const warnEntry = { reason: reason || "بدون سبب", dateTime: now(), warnBy: senderID };
  threadWarns[target].push(warnEntry);
  saveWarns(data);

  const name = await getNameSafe(api, target);
  const count = threadWarns[target].length;

  if (count >= MAX_WARNS) {
    liveApi.sendMessage(
      `⛔ تم تحذير ${name} (${count}/${MAX_WARNS})\n━━━━━━━━━━━━━━━\n🔢 UID: ${target}\n📌 السبب: ${warnEntry.reason}\n🕒 ${warnEntry.dateTime}\n\n❌ وصل إلى الحد الأقصى! يتم حظره الآن...\nللرفع: .warn unban ${target}`,
      threadID, messageID
    );
    try { await liveApi.removeUserFromGroup(target, threadID); } catch {}
  } else {
    liveApi.sendMessage(
      `⚠️ تحذير ${name} (${count}/${MAX_WARNS})\n━━━━━━━━━━━━━━━\n🔢 UID: ${target}\n📌 السبب: ${warnEntry.reason}\n🕒 ${warnEntry.dateTime}\n\n⚡ ${MAX_WARNS - count} تحذير${MAX_WARNS - count > 1 ? "ات" : ""} متبقية قبل الحظر`,
      threadID, messageID
    );
  }
};
