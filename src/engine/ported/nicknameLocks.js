"use strict";

/**
 * nicknameLocks.js — v3  (User-Level Lock + Group Lock with Priority)
 *
 * Priority: User Lock > Group Lock > No Lock
 *
 * User lock  → a single UID in a thread has their nickname pinned; the
 *              group-wide lock MUST NOT override it.
 * Group lock → every member in a thread shares a template; users with
 *              an individual lock are skipped during group enforcement.
 *
 * Storage format (nickname-locks.json):
 * {
 *   "<threadID>": {
 *     "_meta": { "scope": "all"|"bot", "template": "..." },
 *     "members": { "<uid>": "<nick>" },
 *     "userLocked": ["<uid>", ...]   ← NEW: UIDs with individual locks
 *   }
 * }
 */

const fs   = require("fs-extra");
const path = require("path");

let _log = { debug: () => {} };
try { _log = require("../logger"); } catch (_) {}

const { atomicWriteFileSync } = (() => {
  try { return require("../../../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: null }; }
})();

const LOCKS_FILE = path.join(process.cwd(), "data", "nickname-locks.json");

// ─── Core storage ─────────────────────────────────────────────────────────────
// Map<threadID, Map<userID, nickname>>
const lockedNicknames = new Map();

// Per-thread metadata
// Map<threadID, { scope: "bot"|"all", template: string }>
const _meta = new Map();

// User-level locks: Map<threadID, Set<userID>>
// A UID in this set means their nickname is individually pinned.
// Group-lock enforcement MUST skip these users.
const userLockedMembers = new Map();

// ─── Enforce loop ─────────────────────────────────────────────────────────────
let _apiRef       = null;
let _enforceTimer = null;
let _enforcing    = false;

const ENFORCE_INTERVAL = 300_000;  // check every 5 min (was 60s — too aggressive)
const CALL_DELAY_MS    = 3_000;    // 3 s between API calls (was 900ms — much safer)

async function _enforce() {
  if (!_apiRef || lockedNicknames.size === 0 || _enforcing) return;
  _enforcing = true;
  try {
    for (const [threadID, members] of lockedNicknames.entries()) {
      // Get user-locked UIDs for this thread to skip during group enforcement
      const userLocked = userLockedMembers.get(threadID) || new Set();
      const meta       = _meta.get(threadID) || {};

      for (const [userID, nickname] of members.entries()) {
        // PRIORITY RULE: if this user has an individual lock AND the entry
        // was set by a group lock (scope=all), DO NOT override their
        // individual lock by re-enforcing the group template.
        // However if THIS entry IS the user lock (userLocked contains the UID
        // regardless of scope), we always enforce it.
        // Logic: always enforce the stored nickname for every member — the
        // stored nickname for a user-locked member is already their individual
        // nick.  The skip only matters if we were about to apply a DIFFERENT
        // (group) template to a user-locked member — but since we store the
        // correct nick per UID, simply enforcing the stored value is always safe.
        try {
          if (typeof _apiRef.changeNickname === "function") {
            await _apiRef.changeNickname(nickname, threadID, userID);
          } else if (typeof _apiRef.nickname === "function") {
            await _apiRef.nickname(nickname, threadID, userID);
          }
        } catch (e) {
          if (_log.debug) _log.debug("NickLock", `Re-enforce failed [${threadID}/${userID}]: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, CALL_DELAY_MS));
      }
    }
  } finally {
    _enforcing = false;
  }
}

function setApi(api) {
  _apiRef = api;
  if (!_enforceTimer) {
    // Use a randomized first-fire delay (30-90s) so multiple group locks
    // don't all fire at exactly the same wall-clock moment when the bot restarts.
    const firstDelay = 30_000 + Math.floor(Math.random() * 60_000);
    const t = setTimeout(() => {
      _enforce();
      _enforceTimer = setInterval(_enforce, ENFORCE_INTERVAL);
      if (_enforceTimer.unref) _enforceTimer.unref();
    }, firstDelay);
    if (t.unref) t.unref();
    _enforceTimer = t;
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────
function _save() {
  try {
    fs.ensureDirSync(path.dirname(LOCKS_FILE));
    const obj = {};
    for (const [tid, members] of lockedNicknames.entries()) {
      obj[tid] = {
        _meta:      _meta.get(tid) || { scope: "all", template: "" },
        members:    Object.fromEntries(members),
        userLocked: Array.from(userLockedMembers.get(tid) || [])
      };
    }
    const data = JSON.stringify(obj, null, 2);
    if (typeof atomicWriteFileSync === "function") {
      atomicWriteFileSync(LOCKS_FILE, data, "utf-8");
    } else {
      fs.writeFileSync(LOCKS_FILE, data, "utf8");
    }
  } catch (_) {}
}

function _load() {
  try {
    if (!fs.existsSync(LOCKS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(LOCKS_FILE, "utf8"));
    for (const [tid, entry] of Object.entries(obj)) {
      if (!entry || typeof entry !== "object") continue;

      if (entry.members && typeof entry.members === "object") {
        lockedNicknames.set(tid, new Map(Object.entries(entry.members)));
        if (entry._meta) _meta.set(tid, entry._meta);
        // Load user-locked set
        if (Array.isArray(entry.userLocked) && entry.userLocked.length) {
          userLockedMembers.set(tid, new Set(entry.userLocked.map(String)));
        }
      } else if (typeof entry.nickname === "string") {
        // Old flat ZAO format — skip
      } else {
        const pairs = Object.entries(entry).filter(([k]) => !k.startsWith("_"));
        if (pairs.length) lockedNicknames.set(tid, new Map(pairs));
      }
    }
  } catch (_) {}
}

_load();

// ─── Public API ───────────────────────────────────────────────────────────────

/** Set all per-member nickname locks for a thread at once. */
function setMembers(threadID, membersMap, meta) {
  lockedNicknames.set(String(threadID), membersMap);
  if (meta) _meta.set(String(threadID), meta);
  _save();
}

/** Remove all locks for a thread (group + individual). */
function clearLock(threadID) {
  const tid = String(threadID);
  const had = lockedNicknames.delete(tid);
  _meta.delete(tid);
  userLockedMembers.delete(tid);
  if (had) _save();
  return had;
}

/** Get lock info for a thread. */
function getLock(threadID) {
  const tid     = String(threadID);
  const members = lockedNicknames.get(tid);
  if (!members) return null;
  const meta    = _meta.get(tid) || { scope: "all", template: "" };
  const locked  = userLockedMembers.get(tid) || new Set();
  return {
    nickname:        meta.template,
    scope:           meta.scope,
    globalNick:      meta.globalNick    || null,
    botOverride:     meta.botOverride   || null,
    memberOverrides: meta.memberOverrides || {},
    memberCount:     members.size,
    members,
    userLockedCount: locked.size,
    userLockedSet:   locked
  };
}

/** All locked thread IDs → member maps. */
function getLocks() { return lockedNicknames; }

/**
 * Backward-compat: setLock(threadID, nickname, scope)
 */
function setLock(threadID, nickname, scope) {
  const tid = String(threadID);
  _meta.set(tid, { scope: scope || "all", template: nickname });
  if (!lockedNicknames.has(tid)) lockedNicknames.set(tid, new Map());
  if (scope === "bot") {
    const botId = global.botUserID ? String(global.botUserID) : null;
    if (botId) lockedNicknames.get(tid).set(botId, nickname);
  }
  _save();
}

const _lockTimes = new Map();
function setLockTime(threadID, userID) {
  if (!threadID) return;
  const key = `${String(threadID)}:${String(userID || '_group')}`;
  _lockTimes.set(key, Date.now());
}
function getLockTime(threadID, userID) {
  const key = `${String(threadID)}:${String(userID || '_group')}`;
  return _lockTimes.get(key) || null;
}

/** Add or update a single member's locked nickname. */
function updateMember(threadID, userID, nickname) {
  const tid = String(threadID);
  let map = lockedNicknames.get(tid);
  if (!map) { map = new Map(); lockedNicknames.set(tid, map); }
  map.set(String(userID), nickname);
  _save();
}

/** Remove a single member from a thread's lock. */
function removeMember(threadID, userID) {
  const tid = String(threadID);
  const map = lockedNicknames.get(tid);
  if (!map) return;
  const uid = String(userID);
  map.delete(uid);
  // Also remove from user-locked set if present
  const ul = userLockedMembers.get(tid);
  if (ul) { ul.delete(uid); if (ul.size === 0) userLockedMembers.delete(tid); }
  if (map.size === 0) clearLock(threadID);
  else _save();
}

// ─── NEW: User-Level Lock API ─────────────────────────────────────────────────

/**
 * Lock an individual user's nickname in a thread.
 * This lock takes PRIORITY over any group-wide lock.
 *
 * @param {string} threadID
 * @param {string} userID
 * @param {string} nickname  The nickname to pin for this user.
 */
function lockUser(threadID, userID, nickname) {
  const tid = String(threadID);
  const uid = String(userID);

  // Ensure member map exists for this thread
  if (!lockedNicknames.has(tid)) lockedNicknames.set(tid, new Map());
  lockedNicknames.get(tid).set(uid, nickname);

  // Mark as user-locked
  if (!userLockedMembers.has(tid)) userLockedMembers.set(tid, new Set());
  userLockedMembers.get(tid).add(uid);

  // If no group meta exists, set a minimal one so getLock() works
  if (!_meta.has(tid)) _meta.set(tid, { scope: "user", template: "" });

  _save();
}

/**
 * Remove an individual user's nickname lock in a thread.
 * If they were also part of a group lock their entry remains but is no
 * longer "user-locked" — the group template will be re-applied on the
 * next enforce cycle.
 *
 * @param {string} threadID
 * @param {string} userID
 */
function unlockUser(threadID, userID) {
  const tid = String(threadID);
  const uid = String(userID);

  const ul = userLockedMembers.get(tid);
  if (ul) {
    ul.delete(uid);
    if (ul.size === 0) userLockedMembers.delete(tid);
  }

  // If there is no group-wide lock either, remove the member entry entirely
  const meta = _meta.get(tid);
  const isGroupLock = meta && (meta.scope === "all" || meta.scope === "bot");
  if (!isGroupLock) {
    const map = lockedNicknames.get(tid);
    if (map) {
      map.delete(uid);
      if (map.size === 0) clearLock(threadID);
      else _save();
      return;
    }
  }
  _save();
}

/**
 * Check whether a given user has an individual lock in a thread.
 */
function isUserLocked(threadID, userID) {
  const ul = userLockedMembers.get(String(threadID));
  return ul ? ul.has(String(userID)) : false;
}

/**
 * Return list of individually locked UIDs for a thread.
 */
function getUserLockedMembers(threadID) {
  return Array.from(userLockedMembers.get(String(threadID)) || []);
}

/**
 * Set a global lock template for a thread — all members get `globalNick`,
 * with optional bot override and per-member overrides.
 * Populates the members map immediately from known group participants when
 * the bot API is wired in via setApi().
 */
function setGlobalLock(threadID, globalNick, botOverride, memberOverrides) {
  const tid = String(threadID);
  const existingMeta = _meta.get(tid) || {};
  _meta.set(tid, {
    ...existingMeta,
    scope:           "all",
    template:        globalNick || existingMeta.template || "",
    globalNick:      globalNick  || null,
    botOverride:     botOverride || null,
    memberOverrides: memberOverrides || {}
  });
  if (!lockedNicknames.has(tid))    lockedNicknames.set(tid, new Map());
  if (!userLockedMembers.has(tid))  userLockedMembers.set(tid, new Set());
  const members    = lockedNicknames.get(tid);
  const userLocked = userLockedMembers.get(tid);

  const botId = global.botUserID ? String(global.botUserID) : null;

  // Bot entry
  if (botId) {
    const botNick = botOverride || globalNick;
    if (botNick) members.set(botId, botNick);
    if (botOverride) userLocked.add(botId);
    else             userLocked.delete(botId);
  }

  // Per-member overrides → user-locked so the enforce loop keeps their custom nick
  if (memberOverrides && typeof memberOverrides === "object") {
    for (const [uid, nick] of Object.entries(memberOverrides)) {
      if (!uid || !nick) continue;
      members.set(String(uid), nick);
      userLocked.add(String(uid));
    }
  }

  // Try to pre-populate all known group members from threadInfo cache
  try {
    const info = (global.data && global.data.threadInfo && global.data.threadInfo.get(tid));
    const participants = info && (info.participantIDs || info.participants || []);
    if (participants && participants.length) {
      for (const uid of participants) {
        const uidStr = String(uid);
        if (userLocked.has(uidStr)) continue; // already has an override
        if (globalNick) members.set(uidStr, globalNick);
      }
    }
  } catch (_) {}

  _save();
}

const saveLocks = _save;
const flush     = _save;

module.exports = {
  lockedNicknames,
  userLockedMembers,
  setApi,
  setMembers,
  setLock,
  setLockTime,
  clearLock,
  getLock,
  getLocks,
  updateMember,
  removeMember,
  lockUser,
  unlockUser,
  isUserLocked,
  getUserLockedMembers,
  setGlobalLock,
  saveLocks,
  flush,
  getLockTime,
  LOCKS_FILE,
};
