"use strict";
/**
 * ZAO-ENGINE — Duplicate Guard
 * Source: David's duplicateGuard.js — tracks recently sent message bodies
 * per thread (8s window) to block accidental double-sends.
 */

let _active  = false;
const _cache = new Map();
const WINDOW_MS = 8000;

function isDuplicateOutgoing(threadID, body) {
  if (!_active || !body) return false;
  const key  = `${threadID}:${String(body).slice(0, 120)}`;
  const last = _cache.get(key);
  if (last && Date.now() - last < WINDOW_MS) return true;
  _cache.set(key, Date.now());
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [k, ts] of _cache) { if (ts < cutoff) _cache.delete(k); }
  return false;
}

function start(api) {
  if (_active || !api) return;
  _active = true;

  const orig = api.sendMessage.bind(api);
  api.sendMessage = function(msg, threadID, callback) {
    const body = typeof msg === "string" ? msg : (msg?.body || "");
    if (isDuplicateOutgoing(threadID, body)) {
      if (typeof callback === "function") callback(null, { deduplicated: true });
      return;
    }
    return orig(msg, threadID, callback);
  };
}

function stop() { _active = false; _cache.clear(); }

module.exports = { start, stop, isDuplicateOutgoing, isActive: () => _active };
