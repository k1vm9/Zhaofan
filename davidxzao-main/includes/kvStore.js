"use strict";

/**
 * kvStore.js — generic per-thread persistent K/V store.
 *
 * Why this exists:
 *   The bot has several "remember this per group across restarts" needs
 *   (group-name locks, motor1 timers, motor2 timers, nickname locks…).
 *   Each one used to roll its own load/save boilerplate, with subtle
 *   bugs:
 *     - threadID was sometimes a Number in memory but always a String
 *       on disk, so `delete(numberKey)` silently missed entries that
 *       had been reloaded from JSON, and the "stale lock keeps coming
 *       back after restart" symptom appeared.
 *     - Multiple writers (chat command + panel REST + graceful
 *       shutdown) raced for the same file and lost fields the others
 *       didn't know about.
 *     - Burst writes (rapid set/get) fragmented disk I/O and could
 *       interleave with shutdown writes.
 *
 * What this gives:
 *   - Keys are ALWAYS coerced to String at the boundary.
 *   - Writes are debounced (default 50 ms) so bursts coalesce, but
 *     `flushSync()` forces an immediate atomic write — which the
 *     command handlers call after every state-changing action so a
 *     restart milliseconds later still sees the change.
 *   - Atomic write through utils/atomicWrite (temp file + fsync +
 *     rename) so crashes never leave a half-written JSON.
 *
 * NOT a database — values must be JSON-serializable. The store does not
 * understand schema migrations; pass simple plain objects/strings.
 */

const fs = require("fs-extra");
const path = require("path");
const { atomicWriteJsonSync } = require("../utils/atomicWrite");

function createStore(filePath, opts = {}) {
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 50;
  const map = new Map();
  let dirty = false;
  let flushTimer = null;

  function _ensureDir() {
    try { fs.ensureDirSync(path.dirname(filePath)); } catch (_) {}
  }

  function _key(k) { return String(k); }

  function _doWrite() {
    flushTimer = null;
    if (!dirty) return;
    // Clear BEFORE the write so any set() that arrives during the synchronous
    // atomicWriteJsonSync call will re-set dirty=true and schedule a new flush.
    // If we cleared dirty AFTER the write, those concurrent changes would be
    // lost until the next externally-triggered flush.
    dirty = false;
    try {
      _ensureDir();
      const obj = {};
      for (const [k, v] of map.entries()) obj[k] = v;
      atomicWriteJsonSync(filePath, obj);
    } catch (_) {
      // Write failed — restore dirty and schedule a retry (with back-off).
      dirty = true;
      if (!flushTimer) {
        flushTimer = setTimeout(_doWrite, Math.max(debounceMs * 4, 200));
        if (typeof flushTimer.unref === "function") flushTimer.unref();
      }
    }
  }

  function _scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    if (debounceMs <= 0) { _doWrite(); return; }
    flushTimer = setTimeout(_doWrite, debounceMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function load() {
    try {
      _ensureDir();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const obj = raw && raw.trim() ? JSON.parse(raw) : {};
        if (obj && typeof obj === "object") {
          map.clear();
          for (const [k, v] of Object.entries(obj)) map.set(_key(k), v);
        }
      }
    } catch (_) {}
    return map;
  }

  function set(key, value)   { map.set(_key(key), value); _scheduleFlush(); return value; }
  function get(key)          { return map.get(_key(key)); }
  function has(key)          { return map.has(_key(key)); }
  function del(key)          { const had = map.delete(_key(key)); if (had) _scheduleFlush(); return had; }
  function clear()           { if (map.size === 0) return 0; const n = map.size; map.clear(); _scheduleFlush(); return n; }
  function entries()         { return map.entries(); }
  function keys()            { return map.keys(); }
  function values()          { return map.values(); }
  function size()            { return map.size; }
  function snapshot()        { const obj = {}; for (const [k, v] of map.entries()) obj[k] = v; return obj; }
  function flushSync()       { if (flushTimer) { try { clearTimeout(flushTimer); } catch (_) {} flushTimer = null; } if (dirty) _doWrite(); }

  load();

  return {
    file: filePath,
    load, set, get, has, delete: del, clear,
    entries, keys, values, size, snapshot, flushSync,
    raw: map
  };
}

module.exports = { createStore };
