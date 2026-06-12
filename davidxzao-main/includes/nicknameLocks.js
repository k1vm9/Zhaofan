"use strict";

const fs   = require("fs-extra");
const path = require("path");

// ─── Logger (optional) ────────────────────────────────────────────────────────
let _log = { debug: () => {} };
try { _log = require("./logger"); } catch (_) {}

// ─── Atomic write fallback ────────────────────────────────────────────────────
const { atomicWriteFileSync } = (() => {
  try { return require("../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: null }; }
})();

const LOCKS_FILE = path.join(__dirname, "..", "data", "nickname-locks.json");

// ─── Core storage ─────────────────────────────────────────────────────────────
// Map<threadID, Map<userID, nickname>>
const lockedNicknames = new Map();

// Per-thread metadata for status display and backward-compat
// Map<threadID, { scope: "bot"|"all", template: string }>
const _meta = new Map();

// ─── Enforce loop (Madox-style) ───────────────────────────────────────────────
// Re-applies ALL locked nicknames every 90 seconds with 800 ms between calls.
// No sweep cursor — every member in every thread gets re-enforced each cycle.
let _apiRef       = null;
let _enforceTimer = null;
let _enforcing    = false;

const ENFORCE_INTERVAL = 60_000;
const CALL_DELAY_MS    = 800;

async function _enforce() {
  if (!_apiRef || lockedNicknames.size === 0 || _enforcing) return;
  _enforcing = true;
  try {
    for (const [threadID, members] of lockedNicknames.entries()) {
      for (const [userID, nickname] of members.entries()) {
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
    _enforceTimer = setInterval(_enforce, ENFORCE_INTERVAL);
    if (_enforceTimer.unref) _enforceTimer.unref();
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────
function _save() {
  try {
    fs.ensureDirSync(path.dirname(LOCKS_FILE));
    const obj = {};
    for (const [tid, members] of lockedNicknames.entries()) {
      obj[tid] = {
        _meta:   _meta.get(tid) || { scope: "all", template: "" },
        members: Object.fromEntries(members)
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
        // New format: { _meta, members: { uid: nick } }
        lockedNicknames.set(tid, new Map(Object.entries(entry.members)));
        if (entry._meta) _meta.set(tid, entry._meta);
      } else if (typeof entry.nickname === "string") {
        // Old ZAO flat format: { nickname, scope, time, ... } — not compatible, skip
      } else {
        // Legacy flat uid→nick object
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

/** Remove all locks for a thread. */
function clearLock(threadID) {
  const tid = String(threadID);
  const had = lockedNicknames.delete(tid);
  _meta.delete(tid);
  if (had) _save();
  return had;
}

/** Get lock info for a thread (also compat with old getLock API). */
function getLock(threadID) {
  const tid     = String(threadID);
  const members = lockedNicknames.get(tid);
  if (!members) return null;
  const meta = _meta.get(tid) || { scope: "all", template: "" };
  return { nickname: meta.template, scope: meta.scope, memberCount: members.size, members };
}

/** All locked thread IDs → member maps. */
function getLocks() { return lockedNicknames; }

/**
 * Backward-compat: setLock(threadID, nickname, scope)
 * For "bot" scope: registers bot's current UID → nickname immediately.
 * For "all" scope: stores template only; use setMembers for full per-member lock.
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

/** No-op — new system uses a fixed 90 s timer, not per-thread timing. */
function setLockTime() {}

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
  const map = lockedNicknames.get(String(threadID));
  if (!map) return;
  map.delete(String(userID));
  if (map.size === 0) clearLock(threadID);
  else _save();
}

const saveLocks = _save;
const flush     = _save;

module.exports = {
  lockedNicknames,
  setApi,
  setMembers,
  setLock,
  setLockTime,
  clearLock,
  getLock,
  getLocks,
  updateMember,
  removeMember,
  saveLocks,
  flush,
  LOCKS_FILE,
};
