const fs = require("fs-extra");
const path = require("path");
const moment = require("moment-timezone");

const BAN_FILE = path.join(__dirname, "../../data/ban.json");

function loadBans() {
  try {
    if (!fs.existsSync(BAN_FILE)) return {};
    const raw = fs.readFileSync(BAN_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveBans(data) {
  try {
    fs.ensureDirSync(path.dirname(BAN_FILE));
    const tmp = BAN_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, BAN_FILE);
  } catch (e) { console.error("[ban.js:save]", e.message); }
}

function getBannedList(data, threadID) {
  return Array.isArray(data[threadID]) ? data[threadID] : [];
}

module.exports.config = {
  name: "ban",
  aliases: ["حظر"],
  version: "1.0.0",
  hasPermssion: 1,
  credits: "White → ZAO (NTKhang/adapted)",
  description: "حظر / رفع حظر / قائمة المحظورين في المجموعة",
  commandCategory: "إدارة المجموعة",
  usages: [
    "ban [@ذكر / رد / uid] [السبب] — حظر عضو",
    "ban unban [@ذكر / رد / uid]   — رفع الحظر",
    "ban list                       — قائمة المحظورين",
    "ban check                      — طرد المحظورين الموجودين"
  ].join("\n"),
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID, senderID, mentions } = event;
  const liveApi = global._botApi || api;
  const botID = liveApi.getCurrentUserID();

  async function getName(uid) {
    try {
      const info = await liveApi.getUserInfo(uid);
      return info?.[uid]?.name || uid;
    } catch { return uid; }
  }

  const data = loadBans();
  const list = getBannedList(data, threadID);

  // ── ban check ─────────────────────────────────────────────────────────────
  if (args[0] === "check") {
    if (!list.length) return api.sendMessage("📋 لا يوجد محظورون في هذه المجموعة.", threadID, messageID);
    let threadInfo;
    try { threadInfo = await liveApi.getThreadInfo(threadID); } catch {}
    const participants = threadInfo?.participantIDs || [];
    let kicked = 0;
    for (const entry of list) {
      if (participants.includes(entry.id)) {
        try { await liveApi.removeUserFromGroup(entry.id, threadID); kicked++; } catch {}
      }
    }
    return api.sendMessage(
      kicked > 0 ? `✅ تم طرد ${kicked} محظور موجود في المجموعة.` : "✅ لا يوجد محظورون داخل المجموعة حالياً.",
      threadID, messageID
    );
  }

  // ── ban unban ─────────────────────────────────────────────────────────────
  if (args[0] === "unban") {
    let target = null;
    if (!isNaN(args[1]) && args[1]) target = args[1];
    else if (event.messageReply?.senderID) target = event.messageReply.senderID;
    else if (Object.keys(mentions || {}).length) target = Object.keys(mentions)[0];

    if (!target) return api.sendMessage("⚠️ حدد الشخص المراد رفع حظره (ذكر / رد / uid).", threadID, messageID);

    const idx = list.findIndex(e => e.id === target);
    if (idx === -1) return api.sendMessage(`⚠️ المستخدم ${target} ليس محظوراً في هذه المجموعة.`, threadID, messageID);

    const name = await getName(target);
    list.splice(idx, 1);
    data[threadID] = list;
    saveBans(data);
    return api.sendMessage(`✅ تم رفع حظر ${name} من المجموعة.`, threadID, messageID);
  }

  // ── ban list ──────────────────────────────────────────────────────────────
  if (args[0] === "list") {
    if (!list.length) return api.sendMessage("📋 لا يوجد محظورون في هذه المجموعة.", threadID, messageID);
    let msg = "📋 قائمة المحظورين:\n━━━━━━━━━━━━━━━\n";
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      msg += `${i + 1}. ${e.name || e.id} (${e.id})\n   📌 السبب: ${e.reason}\n   🕒 ${e.time}\n\n`;
    }
    return api.sendMessage(msg.trim(), threadID, messageID);
  }

  // ── ban [target] [reason] ─────────────────────────────────────────────────
  let target = null;
  let reason = "";

  if (event.messageReply?.senderID) {
    target = event.messageReply.senderID;
    reason = args.join(" ").trim();
  } else if (Object.keys(mentions || {}).length) {
    target = Object.keys(mentions)[0];
    reason = args.join(" ").replace(mentions[target] || "", "").trim();
  } else if (!isNaN(args[0]) && args[0]) {
    target = args[0];
    reason = args.slice(1).join(" ").trim();
  }

  if (!target) {
    return api.sendMessage(
      "⚠️ الاستخدام: .ban [@ذكر / رد / uid] [السبب]\nأو: .ban unban [@ذكر]\nأو: .ban list",
      threadID, messageID
    );
  }

  if (target === senderID) return api.sendMessage("❌ لا يمكنك حظر نفسك!", threadID, messageID);
  if (target === botID) return api.sendMessage("❌ لا يمكنك حظر البوت!", threadID, messageID);

  if (list.find(e => e.id === target)) {
    return api.sendMessage("⚠️ هذا الشخص محظور مسبقاً.", threadID, messageID);
  }

  const name = await getName(target);
  const time = moment().tz("Asia/Riyadh").format("HH:mm DD/MM/YYYY");
  const entry = { id: target, name, reason: reason || "بدون سبب", time };

  list.push(entry);
  data[threadID] = list;
  saveBans(data);

  api.sendMessage(
    `🚫 تم حظر ${name} من المجموعة!\n━━━━━━━━━━━━━━━\n🔢 UID: ${target}\n📌 السبب: ${entry.reason}\n🕒 التوقيت: ${time}`,
    threadID, messageID
  );

  try { await liveApi.removeUserFromGroup(target, threadID); } catch {}
};

// ── Auto-kick banned members when they re-join ────────────────────────────
module.exports.handleEvent = async function ({ api, event }) {
  const liveApi = global._botApi || api;
  if (event.logMessageType !== "log:subscribe") return;
  const { threadID } = event;
  const data = loadBans();
  const list = getBannedList(data, threadID);
  if (!list.length) return;

  const added = event.logMessageData?.addedParticipants || [];
  for (const user of added) {
    const uid = user.userFbId;
    const banned = list.find(e => e.id === uid);
    if (banned) {
      try {
        await liveApi.removeUserFromGroup(uid, threadID);
        liveApi.sendMessage(
          `⛔ ${user.fullName || uid} محظور في هذه المجموعة وتم طرده تلقائياً.\n📌 السبب: ${banned.reason}`,
          threadID
        );
      } catch {}
    }
  }
};
