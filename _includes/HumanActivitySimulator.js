'use strict';
/**
 * HumanActivitySimulator.js — ZAO Bot
 * ======================================
 * Tracks real incoming message activity per thread and computes an
 * "activity pressure" score (0.0–1.0) used by humanTyping.js to scale
 * typing delays when the bot is under conversation load.
 *
 * Why this exists:
 *   humanTyping.js tries to `require('./HumanActivitySimulator')` and reads
 *   `getStatus().activityPressure` — without this file that require() throws
 *   (silently caught, but still leaves the feature dead).
 *
 * Design:
 *   - Per-thread ring buffer (last 10 incoming messages with timestamps)
 *   - Pressure = how many messages arrived in the last 60 s / 10 (capped at 1.0)
 *   - Global pressure = max across all active threads (used by humanTyping.js)
 *
 * Exported surface:
 *   recordRealActivity(threadID, messageText)  — call on every incoming message
 *   getStatus()                                — returns { activityPressure, ... }
 *   getThreadPressure(threadID)                — pressure for a specific thread (0–1)
 *   reset(threadID?)                           — clear one or all threads
 */

const RING_SIZE       = 10;
const PRESSURE_WINDOW = 60 * 1000; // 60 seconds
const MAX_IN_WINDOW   = 10;        // 10 messages in 60 s → pressure = 1.0

// threadID → { times: number[], chars: number[] }
const _threads = new Map();

// ── Internal: prune old events ────────────────────────────────────────────────
function _prune(entry) {
  const cutoff = Date.now() - PRESSURE_WINDOW;
  while (entry.times.length && entry.times[0] < cutoff) {
    entry.times.shift();
    entry.chars.shift();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record that a real incoming message arrived on a thread.
 * @param {string} threadID
 * @param {string} messageText
 */
function recordRealActivity(threadID, messageText) {
  if (!threadID) return;
  const key = String(threadID);
  if (!_threads.has(key)) _threads.set(key, { times: [], chars: [] });
  const entry = _threads.get(key);
  _prune(entry);
  const now = Date.now();
  entry.times.push(now);
  entry.chars.push((messageText || '').length);
  // Keep ring size bounded
  if (entry.times.length > RING_SIZE) {
    entry.times.shift();
    entry.chars.shift();
  }
}

/**
 * Get activity pressure for a specific thread (0.0–1.0).
 * @param {string} threadID
 * @returns {number}
 */
function getThreadPressure(threadID) {
  const key   = String(threadID || '');
  const entry = _threads.get(key);
  if (!entry) return 0;
  _prune(entry);
  return Math.min(1, entry.times.length / MAX_IN_WINDOW);
}

/**
 * Get global status — activityPressure is the max across all active threads.
 * Used by humanTyping.js._riskMultiplier().
 * @returns {{ activityPressure: number, threadCount: number, totalMessages: number }}
 */
function getStatus() {
  let maxPressure   = 0;
  let totalMessages = 0;
  for (const [, entry] of _threads) {
    _prune(entry);
    const p = Math.min(1, entry.times.length / MAX_IN_WINDOW);
    if (p > maxPressure) maxPressure = p;
    totalMessages += entry.times.length;
  }
  return {
    activityPressure: +maxPressure.toFixed(3),
    threadCount:      _threads.size,
    totalMessages,
  };
}

/**
 * Reset activity data for one thread or all threads.
 * @param {string} [threadID] — omit to reset all
 */
function reset(threadID) {
  if (threadID) _threads.delete(String(threadID));
  else          _threads.clear();
}

// Auto-cleanup every 10 minutes to prevent unbounded Map growth
setInterval(() => {
  for (const [key, entry] of _threads) {
    _prune(entry);
    if (entry.times.length === 0) _threads.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { recordRealActivity, getStatus, getThreadPressure, reset };
