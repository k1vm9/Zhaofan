"use strict";

/**
 * Security Middleware — Centralized Permission & Abuse Guard
 * ===========================================================
 * Consolidates all security checks from White V3 into ZAO's architecture.
 *
 * Features:
 *  1. Role-based permission validation (role 0/1/2)
 *  2. Fake-admin detection (display names mimicking admin tags)
 *  3. Command injection sanitization
 *  4. Rate limiting per user (anti-spam per user, not per thread)
 *  5. Blacklist enforcement (banned users/threads)
 *  6. Admin identity verification (confirm admin IDs haven't been spoofed)
 */

function _log(level, msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ SECURITY ]: ", color: ["red", "cyan"] },
        { message: msg, color: level === "warn" ? "yellow" : level === "error" ? "red" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log(`[SECURITY][${level.toUpperCase()}] ${msg}`);
}

// ─── Suspicious name patterns — common fake-admin disguises ──────────────────
const FAKE_ADMIN_PATTERNS = [
  /\badmin\b/i,
  /\bowner\b/i,
  /\bmod(erator)?\b/i,
  /\bstaff\b/i,
  /\bzao\s*bot\b/i,
  /\bبوت\b/,
  /\bأدمن\b/,
  /\bمشرف\b/,
];

// ─── Command injection characters to strip ───────────────────────────────────
const INJECTION_CHARS = /[`${}|;&<>]/g;
const MAX_INPUT_LEN   = 4096;   // truncate oversized bodies before any regex work

// ─── Per-user rate limiting ───────────────────────────────────────────────────
const _userRates  = new Map();
const RATE_WINDOW = 30_000;    // 30 second window
const RATE_LIMIT  = 8;         // max 8 commands per window per user

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [uid, rec] of _userRates.entries()) {
    if (rec.lastSeen < cutoff) _userRates.delete(uid);
  }
}, 60_000).unref();

function _checkUserRate(senderID) {
  const uid  = String(senderID);
  const now  = Date.now();
  const rec  = _userRates.get(uid) || { count: 0, windowStart: now, lastSeen: now };

  if (now - rec.windowStart > RATE_WINDOW) {
    rec.count       = 1;
    rec.windowStart = now;
  } else {
    rec.count++;
  }

  rec.lastSeen = now;
  _userRates.set(uid, rec);
  return rec.count <= RATE_LIMIT;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getAdminIDs() {
  return (global.config?.ADMINBOT || []).map(String);
}

function _isBotAdmin(userID) {
  return _getAdminIDs().includes(String(userID));
}

function _isBanned(userID, threadID) {
  if (global.data?.userBanned?.has?.(String(userID))) return true;
  if (global.data?.threadBanned?.has?.(String(threadID))) return true;
  return false;
}

// ─── Fake-admin detection ─────────────────────────────────────────────────────

function checkFakeAdmin(displayName, senderID) {
  if (!displayName) return { suspicious: false };
  if (_isBotAdmin(senderID)) return { suspicious: false };

  const hasSuspiciousName = FAKE_ADMIN_PATTERNS.some(re => re.test(displayName));
  if (hasSuspiciousName) {
    _log("warn", `⚠️ Fake-admin name detected: "${displayName}" from user ${senderID}`);
    return { suspicious: true, name: displayName, userID: senderID };
  }
  return { suspicious: false };
}

// ─── Command injection sanitization ──────────────────────────────────────────

function sanitizeInput(text) {
  if (typeof text !== "string") return text;
  if (text.length > MAX_INPUT_LEN) text = text.slice(0, MAX_INPUT_LEN);
  return text.replace(INJECTION_CHARS, "");
}

// ─── Permission check ─────────────────────────────────────────────────────────

/**
 * Validate that a sender can execute a command with the given role requirement.
 *
 * Role levels:
 *   0 — anyone can use
 *   1 — group admins + bot admins
 *   2 — bot admins only
 *
 * Returns { allowed: bool, reason: string }
 */
async function checkPermission({ event, commandRole = 0, api }) {
  const { senderID, threadID, isGroup, participantIDs } = event;
  const uid = String(senderID);

  if (_isBanned(uid, threadID)) {
    return { allowed: false, reason: "banned" };
  }

  if (!_checkUserRate(uid)) {
    _log("warn", `⏱ Rate limit exceeded for user ${uid}`);
    return { allowed: false, reason: "rate_limited" };
  }

  if (commandRole === 0) return { allowed: true };

  if (commandRole >= 2) {
    if (!_isBotAdmin(uid)) return { allowed: false, reason: "bot_admin_required" };
    return { allowed: true };
  }

  if (commandRole === 1) {
    if (_isBotAdmin(uid)) return { allowed: true };

    if (isGroup !== false && api && typeof api.getThreadInfo === "function") {
      try {
        const info = await api.getThreadInfo(threadID);
        const isGroupAdmin = info?.adminIDs?.some(a => String(a.id) === uid);
        if (isGroupAdmin) return { allowed: true };
      } catch (_) {}
    }

    return { allowed: false, reason: "admin_required" };
  }

  return { allowed: true };
}

/**
 * Get a rejection message for the given reason.
 */
function getRejectionMessage(reason) {
  const lang = global.config?.language || "en";
  const ar = lang === "ar";

  switch (reason) {
    case "banned":
      return ar ? "⛔ أنت محظور من استخدام البوت." : "⛔ You are banned from using this bot.";
    case "rate_limited":
      return ar ? "⏱ ترسل أوامر بسرعة كبيرة. انتظر قليلاً." : "⏱ You are sending commands too fast. Please wait.";
    case "bot_admin_required":
      return ar ? "🔒 هذا الأمر خاص بأدمن البوت فقط." : "🔒 This command is for bot admins only.";
    case "admin_required":
      return ar ? "🔒 هذا الأمر يتطلب صلاحيات أدمن المجموعة." : "🔒 This command requires group admin permissions.";
    case "dm_locked":
      return ar ? "🔒 المحادثات الخاصة معطّلة." : "🔒 Private messages are disabled.";
    default:
      return ar ? "⛔ غير مصرح لك بذلك." : "⛔ You are not authorized.";
  }
}

function getUserRateStatus(userID) {
  return _userRates.get(String(userID)) || null;
}

function getSecurityStats() {
  return {
    trackedUsers:  _userRates.size,
    adminCount:    _getAdminIDs().length,
    rateWindow:    RATE_WINDOW,
    rateLimit:     RATE_LIMIT,
  };
}

module.exports = {
  checkPermission,
  checkFakeAdmin,
  sanitizeInput,
  getRejectionMessage,
  getUserRateStatus,
  getSecurityStats,
  isBotAdmin: _isBotAdmin,
};
