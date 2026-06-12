'use strict';

/**
 * Centralized Rate Limit Store — ZAO Protection Layer
 * =====================================================
 * Provides a shared in-memory sliding-window rate limiter used by
 * antispam, antiflood, and any other protection system.
 *
 * Usage:
 *   const { check, setWarned, reset } = require('./protection/rateLimit');
 *   const result = check('threadID:userID:action', 5, 8000); // max 5 events in 8s
 *   if (result.exceeded) { ... }
 */

// key → { events: [timestamp, ...], warned: boolean }
const store = new Map();

/**
 * Check if a key has exceeded the rate limit.
 * @param {string} key        Unique key (e.g. "threadID:userID:action")
 * @param {number} maxEvents  Max allowed events in the window
 * @param {number} windowMs   Time window in milliseconds
 * @returns {{ exceeded: boolean, count: number, warned: boolean }}
 */
function check(key, maxEvents, windowMs) {
  const now = Date.now();

  if (!store.has(key)) store.set(key, { events: [], warned: false });

  const entry = store.get(key);

  // Prune events outside the window (sliding window)
  entry.events = entry.events.filter(t => now - t < windowMs);
  entry.events.push(now);

  const count    = entry.events.length;
  const exceeded = count > maxEvents;

  return { exceeded, count, warned: entry.warned };
}

/**
 * Mark a key as warned (tracks first-warning vs. action phase).
 * @param {string} key
 */
function setWarned(key) {
  if (store.has(key)) store.get(key).warned = true;
}

/**
 * Reset a key's rate limit record entirely.
 * @param {string} key
 */
function reset(key) {
  store.delete(key);
}

/**
 * Get the current count for a key without adding an event.
 * @param {string} key
 * @param {number} windowMs
 * @returns {number}
 */
function getCount(key, windowMs) {
  if (!store.has(key)) return 0;
  const now  = Date.now();
  const entry = store.get(key);
  entry.events = entry.events.filter(t => now - t < windowMs);
  return entry.events.length;
}

/**
 * Clean up all expired entries to prevent unbounded memory growth.
 * Called automatically every 5 minutes.
 * @param {number} maxWindowMs  Max window size of any consumer (default 5 min)
 */
function cleanup(maxWindowMs = 5 * 60 * 1000) {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    entry.events = entry.events.filter(t => now - t < maxWindowMs);
    if (entry.events.length === 0) store.delete(key);
  }
}

// Auto-cleanup every 5 minutes — prevents unbounded Map growth
setInterval(() => cleanup(5 * 60 * 1000), 5 * 60 * 1000).unref();

module.exports = { check, setWarned, reset, getCount, cleanup };
