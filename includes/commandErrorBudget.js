'use strict';
/**
 * commandErrorBudget.js  v2 — UPGRADED
 *
 * Rolling-window per-command error tracker.
 * - THRESHOLD raised to 6 (user requirement: "nearly 6 mistakes")
 * - Window widened to 15 min so burst spikes don't insta-trip slow commands
 * - Graduated trip durations: 1st trip = 30 min, 2nd = 1 h, 3rd+ = 2 h
 * - Decay: errors older than half the window count as 0.5 (weighted count)
 * - Trips persisted to disk so a restart can't bypass a rightfully-tripped cmd
 * - Admin notify rate-limited per-trip (not per-hour) to avoid spam
 */

const fs   = require('fs');
const path = require('path');

const WINDOW_MS        = 15 * 60 * 1000;   // 15-min rolling window
const THRESHOLD        = 6;                 // errors needed to trip (nearly 6)
const HALF_WINDOW_MS   = WINDOW_MS / 2;     // decay boundary

// Graduated trip durations: [1st, 2nd, 3rd+] in ms
const TRIP_DURATIONS   = [
  30 * 60 * 1000,   // 1st trip → 30 min
  60 * 60 * 1000,   // 2nd trip → 1 h
  2 * 60 * 60 * 1000 // 3rd+ → 2 h
];
const TRIP_DURATION_MS = TRIP_DURATIONS[0]; // kept for module.exports compat

const PERSIST_FILE = path.join(process.cwd(), 'data', 'err-budget-state.json');

const errorTimes = new Map(); // commandName -> number[] (timestamps)
const tripped    = new Map(); // commandName -> { untripAt, tripCount }
const tripCounts = new Map(); // commandName -> total trip count (persists across untrip)
const notifiedAt = new Map(); // commandName -> last notify ms

// ── Persistence ──────────────────────────────────────────────────────────────

function _loadPersistedTrips() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = fs.readFileSync(PERSIST_FILE, 'utf-8').trim();
    if (!raw) return;
    const data = JSON.parse(raw);
    const now  = Date.now();
    for (const [name, entry] of Object.entries(data)) {
      if (!entry || typeof entry.untripAt !== 'number') continue;
      // Always restore the total trip count so graduated durations work after restart
      if (typeof entry.tripCount === 'number' && entry.tripCount > 0) {
        tripCounts.set(name, entry.tripCount);
      }
      if (entry.untripAt <= now) continue; // already expired — skip active trip
      tripped.set(name, { untripAt: entry.untripAt });
    }
  } catch (_) {}
}

function _persistTrips() {
  try {
    const dir = path.dirname(PERSIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = {};
    // Merge all known names (active trips + total counts)
    const allNames = new Set([...tripped.keys(), ...tripCounts.keys()]);
    for (const name of allNames) {
      const entry = tripped.get(name);
      const tc    = tripCounts.get(name) || 0;
      out[name] = {
        untripAt:  entry ? entry.untripAt : 0,
        tripCount: tc
      };
    }
    const tmp = PERSIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
    fs.renameSync(tmp, PERSIST_FILE);
  } catch (_) {}
}

_loadPersistedTrips();

// ── Helpers ───────────────────────────────────────────────────────────────────

function _logger() { try { return require('../utils/log.js'); } catch (_) { return null; } }

function _api() {
  try {
    if (global.api) return global.api;
    if (global.client && global.client.api) return global.client.api;
  } catch (_) {}
  return null;
}

/**
 * Weighted error count — errors in the newer half of the window count as 1,
 * errors in the older half count as 0.5. This prevents a burst from 14 min
 * ago from insta-tripping a command that just woke up.
 */
function _weightedCount(arr) {
  const now = Date.now();
  let score = 0;
  for (const t of arr) {
    const age = now - t;
    if (age < HALF_WINDOW_MS) score += 1;
    else score += 0.5;
  }
  return score;
}

function _tripDuration(tripCount) {
  const idx = Math.min(tripCount - 1, TRIP_DURATIONS.length - 1);
  return TRIP_DURATIONS[Math.max(0, idx)];
}

function _notifyAdmins(name, count, untilAt, tripCount) {
  try {
    const api = _api();
    const admins = (global.config && global.config.ADMINBOT) || [];
    if (!api || !admins.length) return;
    const last = notifiedAt.get(name) || 0;
    if (Date.now() - last < 5 * 60 * 1000) return; // throttle 5 min
    notifiedAt.set(name, Date.now());
    const until   = new Date(untilAt).toLocaleTimeString();
    const durMins  = Math.round(_tripDuration(tripCount) / 60000);
    const msg =
      `⚠️ ميزانية أخطاء الأمر (رحلة #${tripCount})\n\n` +
      `الأمر: .${name}\n` +
      `الأخطاء المرجّحة: ${count.toFixed(1)} في 15 دقيقة\n` +
      `معطّل لمدة ${durMins} دقيقة (حتى: ${until})\n\n` +
      `راجع السجلات [ CMD-PROMISE ] أو [ SANDBOX ] للتشخيص.`;
    for (const adminID of admins) {
      const id = String(adminID).trim();
      if (!id) continue;
      try { api.sendMessage(msg, id, () => {}); } catch (_) {}
    }
  } catch (_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────

function record(name, err) {
  if (!name) return;
  const now = Date.now();
  let arr = (errorTimes.get(name) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  errorTimes.set(name, arr);

  const weighted = _weightedCount(arr);

  if (weighted >= THRESHOLD && !tripped.has(name)) {
    // Use tripCounts (separate from active trip map) so graduated durations
    // correctly escalate across multiple trips — the old code always read
    // tripped.get(name) which is always undefined inside this !tripped.has() guard.
    const prevCount  = tripCounts.get(name) || 0;
    const newCount   = prevCount + 1;
    tripCounts.set(name, newCount);
    const durMs      = _tripDuration(newCount);
    const untripAt   = now + durMs;

    tripped.set(name, { untripAt });
    _persistTrips();

    const log = _logger();
    if (log) {
      log.log([
        { message: '[ ERR-BUDGET ]: ', color: ['red', 'cyan'] },
        { message:
          `Command "${name}" tripped #${newCount} (graduated) — weighted score ${weighted.toFixed(1)} ` +
          `(threshold ${THRESHOLD}). Disabled for ${Math.round(durMs / 60000)} min until ` +
          `${new Date(untripAt).toLocaleTimeString()}.` +
          (err && err.message ? ` Last: ${String(err.message).slice(0, 180)}` : ''),
          color: 'white' }
      ]);
    }
    _notifyAdmins(name, weighted, untripAt, newCount);
  }
}

function isTripped(name) {
  if (!name) return false;
  const entry = tripped.get(name);
  if (!entry) return false;
  if (Date.now() >= entry.untripAt) {
    // Active trip is over — remove it but keep tripCounts for future graduated escalation
    tripped.delete(name);
    errorTimes.delete(name);
    notifiedAt.delete(name);
    _persistTrips();
    const log = _logger();
    if (log) {
      const tc = tripCounts.get(name) || 1;
      log.log([
        { message: '[ ERR-BUDGET ]: ', color: ['red', 'cyan'] },
        { message: `Command "${name}" cooldown over — re-enabled (trip #${tc} history retained for escalation).`, color: 'white' }
      ]);
    }
    return false;
  }
  return true;
}

function reset(name) {
  if (name) {
    errorTimes.delete(name);
    tripped.delete(name);
    tripCounts.delete(name);
    notifiedAt.delete(name);
  } else {
    errorTimes.clear();
    tripped.clear();
    tripCounts.clear();
    notifiedAt.clear();
  }
  _persistTrips();
}

function getStatus() {
  const out = {};
  const now = Date.now();
  const seen = new Set([...errorTimes.keys(), ...tripped.keys(), ...tripCounts.keys()]);
  for (const n of seen) {
    const arr   = (errorTimes.get(n) || []).filter(t => now - t < WINDOW_MS);
    const entry = tripped.get(n);
    const tc    = tripCounts.get(n) || 0;
    out[n] = {
      errorsInWindow:  arr.length,
      weightedScore:   +_weightedCount(arr).toFixed(2),
      tripped:         !!(entry && entry.untripAt > now),
      tripCount:       tc,
      untilAt:         (entry && entry.untripAt > now) ? entry.untripAt : null
    };
  }
  return out;
}

// ── Pass 5: Evict orphaned errorTimes entries every 2 hours ─────────────────
// errorTimes Map gets one entry per command name that has ever errored.
// Individual timestamp arrays inside are pruned on record/isTripped access,
// but the Map keys are never deleted — an untripped command with zero recent
// errors stays as an empty-array entry forever.  This GC removes those dead
// entries so the Map stays tightly bounded to actively-failing commands only.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [name, arr] of errorTimes.entries()) {
      const fresh = arr.filter(t => now - t < WINDOW_MS);
      if (fresh.length === 0 && !tripped.has(name)) {
        errorTimes.delete(name);
      } else {
        errorTimes.set(name, fresh);
      }
    }
  } catch (_) {}
}, 2 * 60 * 60 * 1000).unref();

module.exports = {
  record, isTripped, reset, getStatus,
  WINDOW_MS, THRESHOLD, TRIP_DURATION_MS
};
