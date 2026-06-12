"use strict";

/**
 * groupActivityTracker.js
 *
 * Tracks per-group message activity in a rolling 24-hour window.
 * Groups that receive fewer than DEAD_THRESHOLD messages within a
 * 24 h window are automatically left.
 *
 * Grace period: groups first seen less than GRACE_DAYS days ago are
 * never auto-left, giving new additions time to warm up.
 *
 * State is persisted to data/group-activity.json so counts survive
 * a bot restart.
 */

const fs   = require("fs-extra");
const path = require("path");

const DATA_FILE      = path.join(process.cwd(), "data", "group-activity.json");
const DEAD_THRESHOLD = 50;          // messages / 24 h below this → leave
const GRACE_DAYS     = 3;           // days before a group is eligible for auto-leave
const CHECK_INTERVAL = 60 * 60 * 1000;  // run check every 1 hour
const DAY_MS         = 24 * 60 * 60 * 1000;

// in-memory state: Map<threadID, { count, windowStart, firstSeen, name, leftAt }>
let _state   = new Map();
let _api     = null;
let _timer   = null;
let _leftLog = [];     // recent auto-leave events shown in panel

// ── Persistence ──────────────────────────────────────────────────────────────

function _load() {
  try {
    const raw = fs.readJsonSync(DATA_FILE);
    _leftLog = Array.isArray(raw.leftLog) ? raw.leftLog.slice(-100) : [];
    for (const [tid, v] of Object.entries(raw.groups || {})) {
      _state.set(tid, {
        count:       v.count       || 0,
        windowStart: v.windowStart || Date.now(),
        firstSeen:   v.firstSeen   || Date.now(),
        name:        v.name        || tid,
      });
    }
  } catch (_) {}
}

function _save() {
  try {
    const groups = {};
    for (const [tid, v] of _state.entries()) {
      groups[tid] = {
        count:       v.count,
        windowStart: v.windowStart,
        firstSeen:   v.firstSeen,
        name:        v.name,
      };
    }
    fs.outputJsonSync(DATA_FILE, { groups, leftLog: _leftLog.slice(-100) }, { spaces: 2 });
  } catch (_) {}
}

// ── Public: called on every incoming group message ───────────────────────────

function trackMessage(threadID, threadName) {
  const tid  = String(threadID);
  const now  = Date.now();
  const name = threadName || tid;

  if (!_state.has(tid)) {
    _state.set(tid, { count: 1, windowStart: now, firstSeen: now, name });
    return;
  }

  const entry = _state.get(tid);
  if (name && name !== tid) entry.name = name;

  // If the current window is older than 24 h, open a new one.
  if (now - entry.windowStart >= DAY_MS) {
    entry.count       = 1;
    entry.windowStart = now;
  } else {
    entry.count += 1;
  }
}

// ── Dead group check ─────────────────────────────────────────────────────────

function _runCheck() {
  if (!_api) return;

  const now = Date.now();
  const botID = (() => { try { return String(_api.getCurrentUserID()); } catch (_) { return ""; } })();

  for (const [tid, entry] of _state.entries()) {
    // Grace period: skip if first seen less than GRACE_DAYS ago
    if (now - entry.firstSeen < GRACE_DAYS * DAY_MS) continue;

    // Only evaluate once the window is at least 24 h old
    if (now - entry.windowStart < DAY_MS) continue;

    if (entry.count < DEAD_THRESHOLD) {
      const logEntry = {
        threadID: tid,
        name:     entry.name,
        count:    entry.count,
        leftAt:   new Date().toISOString(),
      };
      _leftLog.push(logEntry);
      if (_leftLog.length > 100) _leftLog.shift();

      console.log(
        `[DEAD-GROUP] "${entry.name}" (${tid}) had only ${entry.count} msgs in 24h — leaving`
      );

      _state.delete(tid);

      if (botID) {
        try {
          _api.removeUserFromGroup(botID, tid, () => {});
        } catch (_) {}
      }
    } else {
      // Reset window for next 24 h cycle
      entry.count       = 0;
      entry.windowStart = now;
    }
  }

  _save();
}

// ── Public API ───────────────────────────────────────────────────────────────

function start(api) {
  _api = api;
  _load();

  if (!global.__groupActivityTimer) {
    global.__groupActivityTimer = setInterval(() => {
      _runCheck();
    }, CHECK_INTERVAL);
    if (typeof global.__groupActivityTimer.unref === "function") {
      global.__groupActivityTimer.unref();
    }
  }
}

function stop() {
  if (global.__groupActivityTimer) {
    clearInterval(global.__groupActivityTimer);
    global.__groupActivityTimer = null;
  }
  _save();
}

function getActivity() {
  const groups = [];
  const now    = Date.now();
  for (const [tid, v] of _state.entries()) {
    const windowAgeH  = Math.round((now - v.windowStart) / 36000) / 100;
    const graceLeft   = Math.max(0, GRACE_DAYS * DAY_MS - (now - v.firstSeen));
    const inGrace     = graceLeft > 0;
    groups.push({
      threadID:     tid,
      name:         v.name,
      count:        v.count,
      windowAgeH,
      inGrace,
      graceLeftH:   inGrace ? Math.ceil(graceLeft / 3600000) : 0,
      isDead:       !inGrace && (now - v.windowStart) >= DAY_MS && v.count < DEAD_THRESHOLD,
    });
  }
  groups.sort((a, b) => a.count - b.count);
  return {
    threshold: DEAD_THRESHOLD,
    graceDays: GRACE_DAYS,
    groups,
    leftLog:   _leftLog.slice(-20).reverse(),
  };
}

module.exports = { trackMessage, start, stop, getActivity };
