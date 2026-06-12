"use strict";

/**
 * Outgoing Message Throttle — Layer 7 of Stealth Engine V2
 * ==========================================================
 * Limits how many messages the bot sends per thread and globally,
 * with burst-cooling when limits are hit repeatedly.
 *
 * Config key: global.config.stealth.outgoingThrottle  (ZAO-SETTINGS.json)
 *
 *   maxPerThread       — max messages per thread per threadWindowMinutes
 *   threadWindowMinutes
 *   maxGlobal          — max total messages per globalWindowMinutes
 *   globalWindowMinutes
 *   coolingMinSeconds  — random pause range when a limit is approached
 *   coolingMaxSeconds
 *
 * Config key: global.config.stealth.burstCooling
 *   enable             — enable burst-cooling subsystem
 *   triggerCount       — how many times the global limit must fire to trigger
 *   triggerWindowMinutes
 *   coolingMinMinutes  — forced silence duration
 *   coolingMaxMinutes
 */

function _log(msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ THROTTLE ]: ", color: ["red", "cyan"] },
        { message: msg, color: "yellow" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[THROTTLE]", msg);
}

function _getCfg() {
  return global.config?.stealth?.outgoingThrottle || {};
}

function _getBurstCfg() {
  return global.config?.stealth?.burstCooling || {};
}

function randMs(minSec, maxSec) {
  return (minSec + Math.random() * (maxSec - minSec)) * 1000;
}

class OutgoingThrottle {
  constructor() {
    this._perThread   = new Map();  // threadID -> [timestamps]
    this._global      = [];         // [timestamps]
    this._burstFires  = [];         // timestamps of global-limit fires
    // S2-01 fix: per-thread burst cooling map so a spam burst in one group
    // doesn't silence the bot in every other group (same fix as H-01 in
    // EnhancedRateLimiter). Map: threadID → coolUntil timestamp.
    this._coolingUntil = new Map();

    // S2-04 fix: Periodic GC now prunes stale timestamps from each array
    // before deciding to delete it. Previously only empty arrays were removed,
    // leaving stale timestamps forever for threads that received some messages
    // but then went quiet — a slow unbounded Map leak.
    const _gcTimer = setInterval(() => {
      try {
        const cfg = _getCfg();
        const threadWinMs = (cfg.threadWindowMinutes ?? 5) * 60_000;
        const cutoff      = Date.now() - threadWinMs;
        for (const [tid, arr] of this._perThread.entries()) {
          // Prune in-place to remove timestamps outside the window
          let i = 0;
          while (i < arr.length && arr[i] < cutoff) i++;
          if (i > 0) arr.splice(0, i);
          if (arr.length === 0) this._perThread.delete(tid);
        }
        // Also evict expired per-thread cooling entries
        for (const [tid, until] of this._coolingUntil.entries()) {
          if (Date.now() >= until) this._coolingUntil.delete(tid);
        }
      } catch (_) {}
    }, 20 * 60 * 1000);
    if (_gcTimer && typeof _gcTimer.unref === 'function') _gcTimer.unref();
  }

  _pruneWindow(arr, windowMs) {
    const cutoff = Date.now() - windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
    return arr;
  }

  _isCooling(threadID) {
    const until = this._coolingUntil.get(String(threadID || '')) || 0;
    return Date.now() < until;
  }

  _enterBurstCooling(threadID) {
    const cfg = _getBurstCfg();
    if (!cfg.enable) return;
    const minMs = (cfg.coolingMinMinutes ?? 2) * 60_000;
    const maxMs = (cfg.coolingMaxMinutes ?? 6) * 60_000;
    const dur   = minMs + Math.random() * (maxMs - minMs);
    this._coolingUntil.set(String(threadID || ''), Date.now() + dur);
    _log(`🧊 Burst cooling [${threadID}]: silent for ${Math.round(dur / 60000)} min (other threads unaffected)`);
  }

  _checkBurstTrigger(threadID) {
    const cfg        = _getBurstCfg();
    if (!cfg.enable) return;
    const windowMs   = (cfg.triggerWindowMinutes ?? 25) * 60_000;
    const triggerN   = cfg.triggerCount ?? 3;
    const now        = Date.now();

    this._burstFires = this._pruneWindow(this._burstFires, windowMs);
    this._burstFires.push(now);

    if (this._burstFires.length >= triggerN) {
      this._burstFires = [];
      this._enterBurstCooling(threadID);
    }
  }

  /**
   * Call before sending a message. Returns delay ms (0 = send now).
   * If currently in burst cooling for this thread, waits out the window.
   */
  async check(threadID) {
    const cfg = _getCfg();
    if (!cfg || Object.keys(cfg).length === 0) return;

    const tid = String(threadID || '');

    if (this._isCooling(tid)) {
      const wait = (this._coolingUntil.get(tid) || 0) - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this._coolingUntil.delete(tid);
      return;
    }

    const now          = Date.now();
    const threadWinMs  = (cfg.threadWindowMinutes ?? 5) * 60_000;
    const globalWinMs  = (cfg.globalWindowMinutes ?? 10) * 60_000;
    const maxThread    = cfg.maxPerThread  ?? 12;
    const maxGlobal    = cfg.maxGlobal     ?? 40;
    const coolMin      = cfg.coolingMinSeconds ?? 15;
    const coolMax      = cfg.coolingMaxSeconds ?? 80;

    if (!this._perThread.has(tid)) this._perThread.set(tid, []);
    const threadArr = this._perThread.get(tid);
    this._pruneWindow(threadArr, threadWinMs);
    this._pruneWindow(this._global, globalWinMs);

    let delay = 0;

    if (threadArr.length >= maxThread) {
      delay = Math.max(delay, randMs(coolMin, coolMax));
      _log(`⏳ Thread ${tid} rate limit — cooling ${Math.round(delay / 1000)}s`);
    }

    if (this._global.length >= maxGlobal) {
      delay = Math.max(delay, randMs(coolMin * 2, coolMax * 2));
      _log(`⏳ Global rate limit — cooling ${Math.round(delay / 1000)}s`);
      this._checkBurstTrigger(tid);
    }

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    threadArr.push(now);
    this._global.push(now);
  }

  getStatus() {
    const cfg = _getCfg();
    const now = Date.now();
    return {
      isCooling:       [...this._coolingUntil.values()].some(t => now < t),
      coolingThreads:  [...this._coolingUntil.entries()].filter(([,t]) => now < t).map(([tid]) => tid),
      globalCount:     this._global.length,
      threadCount:     this._perThread.size,
      burstFires:      this._burstFires.length,
      maxGlobal:       cfg.maxGlobal ?? 40,
      maxPerThread:    cfg.maxPerThread ?? 12,
    };
  }

  reset() {
    this._perThread.clear();
    this._global       = [];
    this._burstFires   = [];
    this._coolingUntil = new Map();
  }
}

const globalThrottle = new OutgoingThrottle();

module.exports = {
  OutgoingThrottle,
  globalThrottle,
  check: (threadID) => globalThrottle.check(threadID),
  getStatus: () => globalThrottle.getStatus(),
  reset: () => globalThrottle.reset(),
};
