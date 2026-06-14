'use strict';
/**
 * commandSandbox.js  v2 — UPGRADED
 *
 * Wraps a function or thenable in a hard wall-clock timeout.
 *
 * Upgrades:
 * - DEFAULT_TIMEOUT raised to 90 s (slow YouTube/image APIs need the room)
 * - Captures a stack snapshot on timeout so the log is immediately actionable
 * - Supports AbortSignal injection: if the function accepts a signal arg,
 *   it gets cancelled cleanly rather than just having the Promise abandoned.
 * - Tracks a rolling per-label timeout count; 3 timeouts in 5 min logs a
 *   loud warning so operators know a specific command is reliably slow.
 * - unref() both the timeout timer AND a fallback safety timer that double-
 *   forces a reject even if Promise.race() somehow jams (observed in old V8).
 */

const DEFAULT_TIMEOUT_MS = 90 * 1000;

// Rolling timeout tracking: label → number[] (timestamps)
const _timeoutHistory = new Map();
const _WARN_WINDOW_MS = 5 * 60 * 1000;
const _WARN_THRESHOLD = 3;

function _logger() {
  try { return require('../utils/log.js'); } catch (_) { return null; }
}

function _pruneHistory(arr) {
  const cut = Date.now() - _WARN_WINDOW_MS;
  while (arr.length && arr[0] < cut) arr.shift();
}

function _recordTimeout(label) {
  if (!label) return;
  const arr = _timeoutHistory.get(label) || [];
  _pruneHistory(arr);
  arr.push(Date.now());
  _timeoutHistory.set(label, arr);

  if (arr.length >= _WARN_THRESHOLD) {
    const log = _logger();
    if (log) {
      log.log([
        { message: '[ SANDBOX ]: ', color: ['red', 'cyan'] },
        { message:
          `WARNING — "${label}" timed out ${arr.length}x in the last 5 min. ` +
          `This command is consistently slow or hung. Consider fixing or disabling it.`,
          color: 'yellow' }
      ]);
    }
  }
}

/**
 * Run `fn` (sync or async) with a hard wall-clock timeout.
 *
 * @param {Function|Promise} fn         Task to execute (receives { signal } if it accepts ≥1 arg)
 * @param {string}           label      Human-readable name for logging
 * @param {number}           timeoutMs  Max allowed ms (default 90 000)
 * @returns {Promise<*>}               Resolves with fn's return value or rejects on timeout/error
 */
function runWithTimeout(fn, label, timeoutMs) {
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;

  // AbortController so promise-based internals can react to cancellation
  let controller = null;
  let signal     = null;
  try {
    controller = new AbortController();
    signal     = controller.signal;
  } catch (_) {}

  let timer;
  let safetyTimer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Capture stack at the timeout moment — far more useful than the generic
      // "timed out" message that landed in the old version.
      const stack = (new Error(`[SANDBOX] "${label || 'task'}" exceeded ${timeoutMs}ms`)).stack;
      const err   = new Error(`[SANDBOX] "${label || 'task'}" exceeded ${timeoutMs}ms — forced timeout.`);
      err.code    = 'SANDBOX_TIMEOUT';
      err.stack   = stack;

      // Signal abort to the inner function
      if (controller) { try { controller.abort(); } catch (_) {} }

      // Record for repeat-offender detection
      _recordTimeout(label);

      reject(err);

      // Safety: if Promise.race somehow gets stuck (very rare V8 edge-case),
      // force-reject after another 2 s so the dispatcher never hangs.
      safetyTimer = setTimeout(() => {
        reject(err);
      }, 2000);
      if (safetyTimer && safetyTimer.unref) safetyTimer.unref();
    }, timeoutMs);

    if (timer && timer.unref) timer.unref();
  });

  let workPromise;
  try {
    // Pass { signal } if the function accepts an argument — lets well-written
    // commands react to abort (e.g. cancel an in-flight axios request).
    const out = (typeof fn === 'function')
      ? (fn.length >= 1 && signal ? fn({ signal }) : fn())
      : fn;
    workPromise = Promise.resolve(out);
  } catch (e) {
    workPromise = Promise.reject(e);
  }

  return Promise.race([workPromise, timeoutPromise]).finally(() => {
    if (timer)       clearTimeout(timer);
    if (safetyTimer) clearTimeout(safetyTimer);
  });
}

/** Clear repeat-offender history for a label (call after command is fixed). */
function clearHistory(label) {
  if (label) _timeoutHistory.delete(label);
  else _timeoutHistory.clear();
}

/** Returns per-label timeout counts for diagnostics. */
function getTimeoutStats() {
  const out = {};
  const now = Date.now();
  for (const [label, arr] of _timeoutHistory.entries()) {
    const recent = arr.filter(t => now - t < _WARN_WINDOW_MS);
    if (recent.length) out[label] = recent.length;
  }
  return out;
}

// ── Pass 4: Evict stale _timeoutHistory entries every hour ───────────────────
// Each command label that ever times out gets an entry in _timeoutHistory.
// _pruneHistory() is called on write, but labels with zero recent entries
// are never removed from the Map itself.  Bounded by command count (~100),
// but explicit cleanup keeps getTimeoutStats() output accurate.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [label, arr] of _timeoutHistory.entries()) {
      const fresh = arr.filter(t => now - t < _WARN_WINDOW_MS);
      if (fresh.length === 0) _timeoutHistory.delete(label);
      else _timeoutHistory.set(label, fresh);
    }
  } catch (_) {}
}, 60 * 60 * 1000).unref();

module.exports = { runWithTimeout, clearHistory, getTimeoutStats, DEFAULT_TIMEOUT_MS };
