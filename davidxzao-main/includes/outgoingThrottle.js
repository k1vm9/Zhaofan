"use strict";
/**
 * DAVID V1 — Outgoing Message Throttle
 * Prevents bot from flooding — enforces minimum delay between outgoing messages per thread.
 */

const _lastSent = new Map();
const MIN_GAP_MS = 800;

async function check(threadID) {
  const tid = String(threadID || "");
  const now = Date.now();
  const last = _lastSent.get(tid) || 0;
  const gap = now - last;
  if (gap < MIN_GAP_MS) {
    await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
  }
  _lastSent.set(tid, Date.now());
}

function wrapSendMessage(api) {
  if (!api || api.__throttled) return api;
  const orig = api.sendMessage.bind(api);
  api.sendMessage = async function(msg, tid, cb, ...rest) {
    await check(tid).catch(() => {});
    return orig(msg, tid, cb, ...rest);
  };
  api.__throttled = true;
  return api;
}

module.exports = { check, wrapSendMessage };
