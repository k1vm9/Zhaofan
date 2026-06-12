"use strict";
/**
 * DAVID V1 — Motor Safe Send (scheduled loop system)
 * Manages per-thread timed message loops with rate limiting.
 */

const _loops  = new Map(); // tid → { interval, opts }
const _stats  = { started: 0, stopped: 0, errors: 0 };

/**
 * scheduleMotorLoop({ api, threadID, getData, onDisable })
 * Sends a recurring message to threadID based on getData().
 */
function scheduleMotorLoop({ api, threadID, getData, onDisable } = {}) {
  if (!api || !threadID) return;

  stopMotorLoop(threadID); // clear any existing loop

  const tid = String(threadID);

  function tick() {
    try {
      const d = getData ? getData() : null;
      if (!d || !d.status || !d.message || !d.time) {
        stopMotorLoop(tid);
        if (typeof onDisable === "function") onDisable();
        return;
      }
      api.sendMessage(d.message, tid, (err) => {
        if (err) {
          _stats.errors++;
          const errStr = String(err.error || err.message || err);
          // Stop loop on fatal errors
          if (/block|banned|spam|checkpoint/i.test(errStr)) {
            stopMotorLoop(tid);
            if (typeof onDisable === "function") onDisable();
          }
        }
      });
    } catch (_) {}
  }

  const d = getData ? getData() : null;
  const intervalMs = d?.time ? Math.max(d.time * 60 * 1000, 30000) : 60000;

  const id = setInterval(tick, intervalMs);
  _loops.set(tid, { id, onDisable, startedAt: Date.now() });
  _stats.started++;
}

function stopMotorLoop(threadID) {
  const tid = String(threadID);
  if (_loops.has(tid)) {
    try { clearInterval(_loops.get(tid).id); } catch (_) {}
    _loops.delete(tid);
    _stats.stopped++;
    return true;
  }
  return false;
}

function isActiveLoop(threadID) {
  return _loops.has(String(threadID));
}

function getLoopStats() {
  const active = [];
  for (const [tid, info] of _loops) {
    active.push({ tid, uptimeMs: Date.now() - info.startedAt });
  }
  return { active: active.length, loops: active, ..._stats };
}

module.exports = { scheduleMotorLoop, stopMotorLoop, isActiveLoop, getLoopStats };
