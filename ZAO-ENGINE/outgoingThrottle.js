"use strict";
/**
 * ZAO-ENGINE — Outgoing Message Throttle
 * Source: David's outgoingThrottle.js — enforces a random 700-2000ms gap
 * between sends to prevent burst-sending that triggers Facebook spam detection.
 *
 * Two operation modes:
 *  - check(tid): called by sendPipeline step 5 — returns a Promise that
 *    resolves once the min-gap has elapsed (primary mode, no api wrapping)
 *  - start(api): standalone wrapper mode — use only when sendPipeline is NOT
 *    active (avoids double-wrapping)
 */

let _active          = false;
let _lastSendGlobal  = 0;
let _queue           = Promise.resolve();
const _lastPerThread = new Map();
const rand           = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// ── Pipeline mode ─────────────────────────────────────────────────────────────
// Called by sendPipeline step 5. Returns a Promise that resolves once the
// per-thread and global gaps have elapsed. No api wrapping needed.
function check(threadID) {
  const now         = Date.now();
  const globalGap   = rand(400, 900);
  const threadGap   = rand(600, 1500);
  const lastGlobal  = _lastSendGlobal;
  const lastThread  = _lastPerThread.get(String(threadID)) || 0;
  const waitGlobal  = Math.max(0, lastGlobal  + globalGap  - now);
  const waitThread  = Math.max(0, lastThread  + threadGap  - now);
  const wait        = Math.max(waitGlobal, waitThread);

  _lastSendGlobal = now + wait;
  _lastPerThread.set(String(threadID), now + wait);

  if (_lastPerThread.size > 300) {
    const cutoff = now - 120000;
    for (const [k, v] of _lastPerThread) { if (v < cutoff) _lastPerThread.delete(k); }
  }

  if (wait <= 0) return Promise.resolve();
  return new Promise(r => { const t = setTimeout(r, wait); if (t?.unref) t.unref(); });
}

// ── Standalone mode ───────────────────────────────────────────────────────────
// Wraps api.sendMessage directly. Only use if sendPipeline is NOT active.
function start(api) {
  if (_active || !api) return;
  _active = true;

  const orig = api.sendMessage.bind(api);
  // Accept all args so reply-to messageID (4th arg) and any other extras
  // are forwarded to the real sendMessage instead of being silently dropped.
  api.sendMessage = function(msg, threadID, callback, ...rest) {
    _queue = _queue.then(() => new Promise(resolve => {
      const now  = Date.now();
      const gap  = rand(700, 2000);
      const wait = Math.max(0, _lastSendGlobal + gap - now);
      setTimeout(() => {
        _lastSendGlobal = Date.now();
        try {
          orig(msg, threadID, (err, info) => {
            if (typeof callback === "function") callback(err, info);
            resolve();
          }, ...rest);
        } catch (e) {
          if (typeof callback === "function") callback(e);
          resolve();
        }
      }, wait);
    }));
    return _queue;
  };
}

function stop() {
  _active = false;
  _lastPerThread.clear();
}

function getStatus() {
  const now = Date.now();
  return {
    active:         _active,
    lastSendAgoMs:  _lastSendGlobal ? now - _lastSendGlobal : null,
    threadCount:    _lastPerThread.size,
    engine:         "ZAO-ENGINE/outgoingThrottle",
  };
}

module.exports = { start, stop, check, getStatus, isActive: () => _active };
