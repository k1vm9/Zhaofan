"use strict";

/**
 * liveStats.js
 *
 * Lightweight rolling-window counters fed by listen.js and the
 * command handler. Results are consumed by /bot/stats and displayed
 * in the Stats tab of the web panel.
 *
 * No external dependencies — all in-memory.
 */

// Rolling timestamp arrays (pruned lazily on read)
const _msgTimestamps  = [];   // one entry per message
const _cmdTimestamps  = [];   // one entry per command invocation
const _errTimestamps  = [];   // one entry per unhandled command error

// Per-command counters: commandName → { total, lastHour[] }
const _cmdByName = new Map();

let _totalMsgsToday  = 0;
let _totalCmdsToday  = 0;
let _dayStart        = _startOfDay();

function _startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function _pruneOlder(arr, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function _maybeResetDay() {
  const now = Date.now();
  if (now >= _dayStart + 86400000) {
    _dayStart       = _startOfDay();
    _totalMsgsToday = 0;
    _totalCmdsToday = 0;
  }
}

// ── Public: call these from listen.js / handleCommand ────────────────────────

function trackMessage() {
  _maybeResetDay();
  const now = Date.now();
  _msgTimestamps.push(now);
  _totalMsgsToday += 1;
}

function trackCommand() {
  _maybeResetDay();
  const now = Date.now();
  _cmdTimestamps.push(now);
  _totalCmdsToday += 1;
}

/** Track a command invocation by name for per-command stats (upgrade #6). */
function trackCommandByName(name) {
  if (!name) return;
  trackCommand();
  const now = Date.now();
  let rec = _cmdByName.get(name);
  if (!rec) {
    rec = { total: 0, lastHour: [] };
    _cmdByName.set(name, rec);
  }
  rec.total += 1;
  rec.lastHour.push(now);
}

function trackError() {
  _errTimestamps.push(Date.now());
}

// ── Public: returns snapshot for /bot/stats ───────────────────────────────────

function getStats() {
  _maybeResetDay();
  const now = Date.now();

  _pruneOlder(_msgTimestamps, 3600000);  // keep last 1 h
  _pruneOlder(_cmdTimestamps, 3600000);
  _pruneOlder(_errTimestamps, 3600000);

  // messages in the last 60 s  → msgs/min
  const msgsLastMin  = _msgTimestamps.filter(t => now - t < 60000).length;
  const msgsLastHour = _msgTimestamps.length;
  const cmdsLastHour = _cmdTimestamps.length;
  const errsLastHour = _errTimestamps.length;

  // active motors
  let motor1Active = 0;
  let motor2Active = 0;
  try {
    motor1Active = Object.values(global.motorData  || {}).filter(d => d && d.status).length;
    motor2Active = Object.values(global.motorData2 || {}).filter(d => d && d.status).length;
  } catch (_) {}

  // group count
  let groupCount = 0;
  try { groupCount = (global.data?.allThreadID || []).length; } catch (_) {}

  // name locks / nick locks count
  let nameLockCount = 0;
  let nickLockCount = 0;
  try {
    const { getLocks: getNameLocks } = require("./nameLocks");
    const { getLocks: getNickLocks } = require("./nicknameLocks");
    nameLockCount = getNameLocks().size;
    nickLockCount = getNickLocks().size;  // getLocks() returns a Map — use .size not Object.keys()
  } catch (_) {}

  // per-command stats (prune and build)
  const perCommand = {};
  for (const [name, rec] of _cmdByName.entries()) {
    const recent = rec.lastHour.filter(t => now - t < 3600000);
    rec.lastHour = recent;
    perCommand[name] = { total: rec.total, lastHour: recent.length };
  }

  return {
    msgsPerMin:   msgsLastMin,
    msgsLastHour,
    msgsToday:    _totalMsgsToday,
    cmdsLastHour,
    cmdsToday:    _totalCmdsToday,
    errsLastHour,
    motor1Active,
    motor2Active,
    nameLockCount,
    nickLockCount,
    groupCount,
    perCommand,
    timestamp:    now,
  };
}

// ── Pass 2: Auto-prune rolling arrays every 30 min ──────────────────────────
// Without this, _msgTimestamps / _cmdTimestamps / _errTimestamps grow
// indefinitely when the stats panel is never visited and getStats() is
// never called.  This keeps memory usage flat regardless of panel activity.
setInterval(() => {
  try {
    _pruneOlder(_msgTimestamps,  3600000);
    _pruneOlder(_cmdTimestamps,  3600000);
    _pruneOlder(_errTimestamps,  3600000);
    const cutoff = Date.now() - 3600000;
    for (const [, rec] of _cmdByName.entries()) {
      rec.lastHour = rec.lastHour.filter(t => t > cutoff);
    }
  } catch (_) {}
}, 30 * 60 * 1000).unref();

module.exports = { trackMessage, trackCommand, trackCommandByName, trackError, getStats };
