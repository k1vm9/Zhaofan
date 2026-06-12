"use strict";

/**
 * DM Lock — Anti-Inbox Security Module
 * ======================================
 * Blocks bot responses to non-admin users in private messages (DMs)
 * when `global.config.allowInbox` is false.
 *
 * Also provides a per-admin whitelist so certain admins can always
 * interact in DMs regardless of the global setting.
 *
 * Additionally flags and logs suspicious DM patterns (potential
 * abuse attempts via private messages).
 */

function _log(level, msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ DM-LOCK ]: ", color: ["red", "cyan"] },
        { message: msg, color: level === "warn" ? "yellow" : level === "error" ? "red" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log(`[DM-LOCK] ${msg}`);
}

const _abuseMap = new Map();  // userID → { count, firstSeen }
const ABUSE_THRESHOLD = 5;
const ABUSE_WINDOW_MS = 5 * 60_000;

function _trackAbuse(userID) {
  const now  = Date.now();
  const uid  = String(userID);
  const rec  = _abuseMap.get(uid) || { count: 0, firstSeen: now };

  if (now - rec.firstSeen > ABUSE_WINDOW_MS) {
    rec.count    = 1;
    rec.firstSeen = now;
  } else {
    rec.count++;
  }

  _abuseMap.set(uid, rec);

  if (rec.count === ABUSE_THRESHOLD) {
    _log("warn", `⚠️ Potential DM abuse from user ${uid} — ${rec.count} blocked attempts in ${Math.round(ABUSE_WINDOW_MS / 60000)} min`);
  }

  return rec.count;
}

function _isAdmin(userID) {
  const uid    = String(userID);
  const admins = (global.config?.ADMINBOT || []).map(String);
  return admins.includes(uid);
}

function _isGroupThread(threadID) {
  return String(threadID).length > 15;
}

/**
 * Check if a message from this thread/sender should be processed.
 * Returns { allowed: bool, reason: string }
 */
function check(event) {
  try {
    const { threadID, senderID } = event;
    if (!threadID || !senderID) return { allowed: true };

    if (_isGroupThread(threadID)) return { allowed: true };

    if (_isAdmin(senderID)) return { allowed: true };

    if (global.config?.allowInbox === false) {
      _trackAbuse(senderID);
      return { allowed: false, reason: "dm_locked" };
    }

    return { allowed: true };
  } catch (_) {
    return { allowed: true };
  }
}

/**
 * Returns a friendly rejection message (in Arabic if configured).
 */
function getRejectMessage() {
  const lang = global.config?.language || "en";
  if (lang === "ar") {
    return "🔒 المحادثات الخاصة معطّلة. يرجى التواصل في مجموعة.";
  }
  return "🔒 Private messages are disabled for this bot. Please use a group.";
}

function getAbuseReport() {
  const report = [];
  for (const [uid, rec] of _abuseMap.entries()) {
    report.push({ userID: uid, count: rec.count, firstSeen: new Date(rec.firstSeen).toISOString() });
  }
  return report.sort((a, b) => b.count - a.count);
}

function resetAbuse(userID) {
  if (userID) _abuseMap.delete(String(userID));
  else _abuseMap.clear();
}

module.exports = { check, getRejectMessage, getAbuseReport, resetAbuse };
