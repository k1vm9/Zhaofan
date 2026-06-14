'use strict';
/**
 * memoryManager.js — Periodic cleanup of stale in-memory state
 *
 * The global.data Maps (threadInfo, threadData, userName, userBanned,
 * threadBanned, commandBanned) grow without bound on large bots.
 * After weeks of operation in busy group pools they can consume hundreds
 * of MB of RAM, eventually causing OOM crashes on memory-constrained hosts.
 *
 * This module runs a configurable pruner that evicts entries for threads/
 * users that have been silent for longer than a configurable TTL.
 * Evicted entries are re-fetched from the DB on the next message — no
 * data is lost, only the RAM copy is released.
 *
 * Also triggers Node.js GC (if exposed) after each prune cycle to return
 * freed pages to the OS immediately instead of waiting for the GC heuristic.
 */

const DEFAULT_THREAD_TTL_MS  = 4 * 60 * 60 * 1000;  // 4 hours inactive → evict
const DEFAULT_USER_TTL_MS    = 2 * 60 * 60 * 1000;  // 2 hours inactive → evict name cache
const DEFAULT_PRUNE_EVERY_MS = 30 * 60 * 1000;       // run every 30 min

let _timer    = null;
let _lastSeen = null; // Map<threadID|userID, lastSeenMs> — tracked by activity hook

// Called by the message handler to record per-thread / per-user activity.
// Lightweight — just updates a timestamp.
const _threadSeen = new Map();
const _userSeen   = new Map();

function onThreadActivity(threadID) {
  if (threadID) _threadSeen.set(String(threadID), Date.now());
}

function onUserActivity(userID) {
  if (userID) _userSeen.set(String(userID), Date.now());
}

function log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: '[ MEM-MGR ]: ', color: ['red', 'cyan'] },
        { message: msg, color: 'white' },
      ]);
      return;
    }
  } catch (_) {}
  console.log('[MEM-MGR]', msg);
}

function getConfig() {
  try {
    const cfg = (global.config && global.config.memoryManager) || {};
    return {
      enable:         cfg.enable !== false,
      threadTtlMs:    (cfg.threadTtlHours  || 4)  * 60 * 60 * 1000,
      userTtlMs:      (cfg.userTtlHours    || 2)  * 60 * 60 * 1000,
      pruneEveryMs:   (cfg.pruneEveryMinutes || 30) * 60 * 1000,
    };
  } catch (_) {
    return {
      enable:       true,
      threadTtlMs:  DEFAULT_THREAD_TTL_MS,
      userTtlMs:    DEFAULT_USER_TTL_MS,
      pruneEveryMs: DEFAULT_PRUNE_EVERY_MS,
    };
  }
}

function prune() {
  const cfg = getConfig();
  if (!cfg.enable) return;

  const data = global.data;
  if (!data) return;

  const now = Date.now();
  let evictedThreads = 0;
  let evictedUsers   = 0;

  // ── Prune threadInfo ──────────────────────────────────────────────────────
  if (data.threadInfo instanceof Map) {
    for (const [tid] of data.threadInfo) {
      const last = _threadSeen.get(tid) || 0;
      if (now - last > cfg.threadTtlMs) {
        data.threadInfo.delete(tid);
        data.threadData && data.threadData.delete && data.threadData.delete(tid);
        _threadSeen.delete(tid);
        evictedThreads++;
      }
    }
  }

  // ── Prune userName cache ──────────────────────────────────────────────────
  if (data.userName instanceof Map) {
    for (const [uid] of data.userName) {
      const last = _userSeen.get(uid) || 0;
      if (now - last > cfg.userTtlMs) {
        data.userName.delete(uid);
        data.userBanned  && data.userBanned.delete  && data.userBanned.delete(uid);
        data.commandBanned && data.commandBanned.delete && data.commandBanned.delete(uid);
        _userSeen.delete(uid);
        evictedUsers++;
      }
    }
  }

  // ── Trim allThreadID / allUserID arrays ───────────────────────────────────
  // These are used as existence caches. Remove IDs whose info we've evicted
  // so the DB creation logic will re-fetch them on the next message.
  if (evictedThreads > 0 && Array.isArray(data.allThreadID)) {
    const kept = new Set(data.threadInfo ? data.threadInfo.keys() : []);
    data.allThreadID = data.allThreadID.filter(id => kept.has(String(id)));
  }
  if (evictedUsers > 0 && Array.isArray(data.allUserID)) {
    const kept = new Set(data.userName ? data.userName.keys() : []);
    data.allUserID = data.allUserID.filter(id => kept.has(String(id)));
  }

  if (evictedThreads > 0 || evictedUsers > 0) {
    log(`Pruned ${evictedThreads} threads, ${evictedUsers} users — freed stale RAM`);
  }

  // Hint GC to release freed pages immediately (only available with --expose-gc flag,
  // which we do NOT require — this is a best-effort nudge).
  try {
    if (typeof global.gc === 'function') global.gc();
  } catch (_) {}
}

function start() {
  if (_timer) return;
  const cfg = getConfig();
  if (!cfg.enable) return;

  log(`Started — prune every ${cfg.pruneEveryMs / 60000}min, thread TTL ${cfg.threadTtlMs / 3600000}h, user TTL ${cfg.userTtlMs / 3600000}h`);

  function schedule() {
    const c = getConfig();
    _timer = setTimeout(() => {
      try { prune(); } catch (_) {}
      schedule();
    }, c.pruneEveryMs);
    if (_timer.unref) _timer.unref();
  }
  schedule();
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { start, stop, onThreadActivity, onUserActivity };
