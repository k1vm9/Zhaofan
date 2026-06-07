"use strict";

/**
 * حماية.js — حماية كنيات الأعضاء
 *
 * حماية تفعيل  → يحفظ الكنية الحالية لكل عضو ويراقب أي تغيير
 * حماية ايقاف  → يوقف الحماية للغروب الحالي
 *
 * فقط أدمن البوت (ADMINBOT) يُسمح له بتغيير الكنى.
 * أي شخص آخر يغيّر كنية → تُعاد فوراً للقيمة المحفوظة.
 */

const NickProtect = require("../../includes/nickProtect");

module.exports.config = {
  name:            "حماية",
  aliases:         ["protect", "nickprotect", "nickguard"],
  version:         "1.0.0",
  hasPermssion:    2,
  credits:         "ZAO Team",
  description:     "حماية كنيات الأعضاء — فقط أدمن البوت يستطيع التعديل",
  commandCategory: "إدارة المجموعة",
  usages:          "حماية تفعيل | حماية ايقاف",
  cooldowns:       5,
};

module.exports.languages = { vi: {}, en: {} };

// ─── helpers ──────────────────────────────────────────────────────────────────

function _live(api) { return global._botApi || api; }

function _isAdmin(userID) {
  const admins = global.config?.ADMINBOT || [];
  return admins.includes(String(userID));
}

function changeNicknameP(api, nickname, threadID, userID) {
  const live = _live(api);
  return new Promise((resolve, reject) => {
    if (!live || typeof live.changeNickname !== "function") {
      return reject(new Error("changeNickname unavailable"));
    }
    try {
      const r = live.changeNickname(nickname, threadID, userID, (err) => {
        if (err) reject(err); else resolve();
      });
      if (r && typeof r.then === "function") r.then(resolve, reject);
    } catch (e) { reject(e); }
  });
}

async function _fetchNicknames(api, threadID) {
  try {
    const info = await _live(api).getThreadInfo(threadID);
    const raw  = info?.nicknames || info?.customization?.nicknames || {};
    const map  = {};

    // Seed map with ALL participant IDs so members without a nickname are also
    // tracked. Without this, anyone who has never set a nickname is invisible to
    // the protection system and their nickname can be changed freely.
    const ids = Array.isArray(info?.participantIDs) ? info.participantIDs : [];
    for (const uid of ids) {
      map[String(uid)] = "";
    }
    // Also pull from userInfo in case the library returns them there
    const userInfo = Array.isArray(info?.userInfo) ? info.userInfo : [];
    for (const u of userInfo) {
      const uid = String(u?.id || "");
      if (uid && !(uid in map)) map[uid] = "";
    }

    // Overlay with actual nicknames (non-empty values win)
    for (const [uid, nick] of Object.entries(raw)) {
      map[String(uid)] = nick || "";
    }
    return map;
  } catch (_) {
    return {};
  }
}

// ─── handleEvent — watch nickname change events ────────────────────────────────

module.exports.handleEvent = async function ({ api, event }) {
  try {
    const { threadID, logMessageType, logMessageData, author } = event;
    if (!threadID) return;

    if (
      logMessageType !== "log:subscribe:update-nickname" &&
      logMessageType !== "log:user-nickname"
    ) return;

    if (!NickProtect.isEnabled(threadID)) return;

    // Who changed it
    const changerID = String(
      logMessageData?.actorFbId  ||
      logMessageData?.actor_fbid ||
      author || ""
    );

    // Whose nickname was changed
    const targetID = String(
      logMessageData?.participant_id  ||
      logMessageData?.participantId   ||
      logMessageData?.target_id       ||
      ""
    );
    if (!targetID) return;

    const newNickname = logMessageData?.nickname ?? "";

    // Bot admin changed it → allow and update stored value
    if (_isAdmin(changerID)) {
      NickProtect.updateNickname(threadID, targetID, newNickname);
      return;
    }

    // Non-admin changed it → revert
    const stored = NickProtect.getNicknames(threadID);
    if (!stored) return;

    const original = stored[targetID] ?? "";
    if (newNickname === original) return; // already correct, nothing to do

    // Revert to stored nickname
    try {
      await changeNicknameP(api, original, threadID, targetID);
    } catch (_) {}
  } catch (_) {}
};

// ─── run ──────────────────────────────────────────────────────────────────────

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID } = event;

  if (permssion < 2) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }

  const sub = (args[0] || "").trim();

  // ── حماية تفعيل ─────────────────────────────────────────────────────────────
  if (sub === "تفعيل") {
    api.sendMessage("⏳ جاري جلب كنيات الأعضاء…", threadID, messageID);
    const nicknames = await _fetchNicknames(api, threadID);
    const count = Object.keys(nicknames).length;
    NickProtect.enable(threadID, nicknames);
    return api.sendMessage(
      `🛡️ تم تفعيل حماية الكنيات في هذا الغروب.\n`+
      `📋 تم حفظ ${count} كنية.\n\n`+
      `• أي شخص يغيّر كنية عضو → تُعاد تلقائياً\n`+
      `• فقط أدمن البوت يستطيع التغيير\n\n`+
      `لإيقاف الحماية: حماية ايقاف`,
      threadID, messageID
    );
  }

  // ── حماية ايقاف ─────────────────────────────────────────────────────────────
  if (sub === "ايقاف") {
    if (!NickProtect.isEnabled(threadID)) {
      return api.sendMessage("⚠️ الحماية غير مفعّلة في هذا الغروب أصلاً.", threadID, messageID);
    }
    NickProtect.disable(threadID);
    return api.sendMessage("🔓 تم إيقاف حماية الكنيات في هذا الغروب.", threadID, messageID);
  }

  // ── حالة / مساعدة ───────────────────────────────────────────────────────────
  const enabled = NickProtect.isEnabled(threadID);
  const stored  = enabled ? NickProtect.getNicknames(threadID) : null;
  const count   = stored ? Object.keys(stored).length : 0;

  return api.sendMessage(
    `🛡️ حماية الكنيات\n`+
    `━━━━━━━━━━━━━━━\n`+
    `الحالة: ${enabled ? `🟢 مفعّلة (${count} كنية محفوظة)` : "⚫ متوقفة"}\n\n`+
    `📌 الأوامر:\n`+
    `• حماية تفعيل — تفعيل الحماية وحفظ الكنيات الحالية\n`+
    `• حماية ايقاف — إيقاف الحماية`,
    threadID, messageID
  );
};
