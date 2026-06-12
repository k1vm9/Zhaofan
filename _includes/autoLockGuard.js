'use strict';
/**
 * autoLockGuard.js  v3 — Persistent Escalation
 *
 * Anti-raid / anti-spam auto-locker.
 *
 * v3 upgrades over v2:
 * - Lock escalation counter (_lockCount) now persisted to disk and survives
 *   bot restarts. A restart no longer resets progressive lockout durations —
 *   only an explicit manual unlock resets the counter.
 * - State file: data/auto-lock-state.json
 * - Atomic write with debounce (same pattern as antiSuspension.js)
 * - All v2 features preserved: per-sender rate limiting, progressive durations,
 *   admin DM notifications, distinct sender tracking.
 */

const _fs   = require('fs');
const _path = require('path');
const _atomic = (() => {
  try { return require('../utils/atomicWrite').atomicWriteFileSync; }
  catch (_) { return _fs.writeFileSync.bind(_fs); }
})();

const STATE_FILE       = _path.join(process.cwd(), 'data', 'auto-lock-state.json');
const SAVE_DEBOUNCE_MS = 3000;

const _attempts      = [];  // { ts, sender }
let   _lockedAt      = 0;
let   _unlockTimer   = null;
let   _lockCount     = 0;   // progressive escalation — persisted
let   _saveTimer     = null;

// Per-sender throttle: sender → number[] (timestamps)
const _senderHistory = new Map();
const _senderWarned  = new Set();

// ── Persistence ──────────────────────────────────────────────────────────────

function _loadState() {
  try {
    if (!_fs.existsSync(STATE_FILE)) return;
    const raw = _fs.readFileSync(STATE_FILE, 'utf-8').trim();
    if (!raw) return;
    const s = JSON.parse(raw);
    if (Number.isFinite(s.lockCount) && s.lockCount > 0) {
      _lockCount = s.lockCount;
      // If there was an active lock when we shut down, restore locked state
      // only if it hasn't timed out yet.
      if (s.lockedAt && s.unlockDurationMs) {
        const elapsed = Date.now() - Number(s.lockedAt);
        const remaining = Number(s.unlockDurationMs) - elapsed;
        if (remaining > 0) {
          global.lockBot = true;
          _lockedAt = Number(s.lockedAt);
          _scheduleUnlockMs(remaining);
        }
      }
    }
  } catch (_) {}
}

function _markDirty() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _flushState();
  }, SAVE_DEBOUNCE_MS);
}

function _flushState(unlockDurationMs) {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const dir = _path.dirname(STATE_FILE);
    if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
    _atomic(STATE_FILE, JSON.stringify({
      savedAt:          Date.now(),
      lockCount:        _lockCount,
      lockedAt:         _lockedAt || null,
      unlockDurationMs: unlockDurationMs || null
    }, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Periodic GC: prune _senderHistory + _senderWarned for inactive senders ──
// Without this, every spammer that ever triggered the guard stays in memory
// forever. We evict entries whose timestamp window has fully expired.
const _SENDER_GC_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  try {
    const cfg = _cfg();
    const windowMs = cfg.senderWindowSeconds * 1000;
    const now = Date.now();
    for (const [sid, arr] of _senderHistory.entries()) {
      const fresh = arr.filter(t => now - t < windowMs);
      if (fresh.length === 0) {
        _senderHistory.delete(sid);
        _senderWarned.delete(sid);
      } else {
        _senderHistory.set(sid, fresh);
      }
    }
  } catch (_) {}
}, _SENDER_GC_INTERVAL_MS).unref();

// Load persisted state immediately on module load
_loadState();

// ── Config ──────────────────────────────────────────────────────────────────

function _cfg() {
  const c = (global.config && global.config.autoLock) || {};
  return {
    enable:              c.enable !== false,
    maxCommands:         Number.isFinite(c.maxCommands)        ? c.maxCommands        : 15,
    windowSeconds:       Number.isFinite(c.windowSeconds)      ? c.windowSeconds      : 30,
    unlockAfterMinutes:  Number.isFinite(c.unlockAfterMinutes) ? c.unlockAfterMinutes : 10,
    notifyAdmins:        c.notifyAdmins !== false,
    senderMaxCmds:       Number.isFinite(c.senderMaxCmds)      ? c.senderMaxCmds      : 10,
    senderWindowSeconds: Number.isFinite(c.senderWindowSeconds)? c.senderWindowSeconds: 20
  };
}

function _log(msg, color) {
  try {
    if (global.loggeryuki && typeof global.loggeryuki.log === 'function') {
      global.loggeryuki.log([
        { message: '[ AUTO-LOCK ]: ', color: ['red', 'cyan'] },
        { message: String(msg), color: color || 'white' }
      ]);
    } else {
      console.log(`[AUTO-LOCK] ${msg}`);
    }
  } catch (_) {}
}

function _prune(now, windowMs) {
  while (_attempts.length && (now - _attempts[0].ts) > windowMs) {
    _attempts.shift();
  }
}

function _pruneSender(arr, windowMs) {
  const cut = Date.now() - windowMs;
  while (arr.length && arr[0] < cut) arr.shift();
}

function _progressiveDuration(cfg) {
  const base = cfg.unlockAfterMinutes;
  if (_lockCount <= 1) return base;
  if (_lockCount === 2) return Math.min(base * 2, 60);
  return Math.min(base * 4, 60);
}

function _sendAdminDM(msg) {
  // C-04 fix: stagger per-admin sends with random 800-2000 ms delay so rapid-fire
  // DMs to multiple admins don't create a detectable automation burst pattern.
  const api    = global._botApi || (global.client && global.client.api);
  const admins = (global.config && global.config.ADMINBOT) || [];
  if (!api || !admins.length) return;
  (async () => {
    for (const adminID of admins) {
      const id = String(adminID).trim();
      if (!id) continue;
      await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 1200)));
      try { api.sendMessage(msg, id, () => {}); } catch (_) {}
    }
  })().catch(() => {});
}

function _scheduleUnlockMs(ms) {
  if (_unlockTimer) { try { clearTimeout(_unlockTimer); } catch (_) {} _unlockTimer = null; }
  if (ms <= 0) return;
  _unlockTimer = setTimeout(() => {
    if (global.lockBot === true && _lockedAt > 0) {
      global.lockBot = false;
      _lockedAt = 0;
      _attempts.length = 0;
      _senderWarned.clear();
      _log(`Auto-unlocked — bot is open again.`, 'green');
      _flushState();
    }
    _unlockTimer = null;
  }, ms);
  if (_unlockTimer && typeof _unlockTimer.unref === 'function') _unlockTimer.unref();
}

function _scheduleUnlock(durationMinutes) {
  _scheduleUnlockMs(durationMinutes > 0 ? durationMinutes * 60 * 1000 : 0);
}

function _trigger(cfg, count) {
  if (global.lockBot === true && _lockedAt === 0) {
    _log(`Threshold (${count}) reached but already manually locked — skipping.`);
    _attempts.length = 0;
    return;
  }
  if (global.lockBot === true) return;

  _lockCount++;
  global.lockBot = true;
  _lockedAt = Date.now();

  const durMin = _progressiveDuration(cfg);
  const durMs  = durMin > 0 ? durMin * 60 * 1000 : 0;
  _attempts.length = 0;

  const distinctSenders = [...new Set(
    _senderHistory.size
      ? [..._senderHistory.entries()]
          .filter(([, arr]) => arr.some(t => Date.now() - t < cfg.windowSeconds * 1000))
          .map(([s]) => s)
      : []
  )].slice(0, 5);

  const tail = durMin > 0 ? `auto-unlock in ${durMin} min` : 'manual unlock required';
  _log(
    `LOCKED #${_lockCount} — ${count} non-admin cmds in ${cfg.windowSeconds}s — ${tail}` +
    (distinctSenders.length ? ` — senders: ${distinctSenders.join(', ')}` : ''),
    'red'
  );

  // Persist immediately (including unlock duration so restart can restore)
  _flushState(durMs);

  if (cfg.notifyAdmins) {
    const dmMsg =
      `🔒 AUTO-LOCK #${_lockCount}\n` +
      `${count} cmds in ${cfg.windowSeconds}s\n` +
      `${durMin > 0 ? `Unlock in ${durMin} min` : 'Manual unlock needed'}\n` +
      (distinctSenders.length ? `Senders: ${distinctSenders.join(', ')}` : '');
    _sendAdminDM(dmMsg);
    try {
      const noti = require('./notiWhenListenError');
      if (noti && typeof noti.notify === 'function') {
        const fakeErr = new Error(`Auto-lock #${_lockCount}: ${count} non-admin commands in ${cfg.windowSeconds}s`);
        noti.notify(fakeErr, 'auto-lock raid guard');
      }
    } catch (_) {}
  }

  _scheduleUnlockMs(durMs);
}

/**
 * Check per-sender rate and warn/note if a single user is hammering.
 */
function _checkSenderRate(senderID, cfg) {
  const windowMs = cfg.senderWindowSeconds * 1000;
  const arr      = _senderHistory.get(senderID) || [];
  _pruneSender(arr, windowMs);
  arr.push(Date.now());
  _senderHistory.set(senderID, arr);

  if (arr.length >= cfg.senderMaxCmds && !_senderWarned.has(senderID)) {
    _senderWarned.add(senderID);
    _log(
      `Single-sender rate limit: ${senderID} sent ${arr.length} cmds in ${cfg.senderWindowSeconds}s.`,
      'yellow'
    );
  }
  return arr.length >= cfg.senderMaxCmds;
}

/** Record a non-admin command attempt. */
function record(senderID) {
  const cfg = _cfg();
  if (!cfg.enable) return;
  if (cfg.maxCommands <= 0 || cfg.windowSeconds <= 0) return;

  const now      = Date.now();
  const windowMs = cfg.windowSeconds * 1000;

  if (senderID) _checkSenderRate(String(senderID), cfg);

  _prune(now, windowMs);
  _attempts.push({ ts: now, sender: String(senderID || '?') });

  if (_attempts.length >= cfg.maxCommands) {
    _trigger(cfg, _attempts.length);
  }
}

/** Manual control: true = lock, false = unlock. */
function setLock(value, reason) {
  const v = value === true;
  global.lockBot = v;
  if (_unlockTimer) { try { clearTimeout(_unlockTimer); } catch (_) {} _unlockTimer = null; }
  if (!v) {
    _attempts.length = 0;
    _lockedAt = 0;
    _lockCount = 0;  // manual unlock resets progressive escalation
    _senderWarned.clear();
    _log(`Manual UNLOCK${reason ? ` (${reason})` : ''} — bot open. Lock count reset.`, 'green');
    _flushState();
  } else {
    _lockedAt = 0;
    _log(`Manual LOCK${reason ? ` (${reason})` : ''}.`, 'yellow');
    _markDirty();
  }
}

function status() {
  const cfg = _cfg();
  const now = Date.now();
  _prune(now, cfg.windowSeconds * 1000);
  const hotSenders = [..._senderHistory.entries()]
    .map(([s, arr]) => {
      const recent = arr.filter(t => now - t < cfg.senderWindowSeconds * 1000);
      return { sender: s, count: recent.length };
    })
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    enabled:            cfg.enable,
    locked:             global.lockBot === true,
    autoLocked:         _lockedAt > 0,
    lockedAt:           _lockedAt || null,
    lockCount:          _lockCount,
    recentAttempts:     _attempts.length,
    maxCommands:        cfg.maxCommands,
    windowSeconds:      cfg.windowSeconds,
    unlockAfterMinutes: cfg.unlockAfterMinutes,
    hotSenders
  };
}

module.exports = { record, setLock, status };
