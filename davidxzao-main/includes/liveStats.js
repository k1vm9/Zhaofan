"use strict";
/**
 * DAVID V1 — Live Stats (bridges to global stats tracked by server.js)
 */

const _hourBuckets = new Map(); // hour-key → {msgs, cmds, errs}
const _dayBuckets  = new Map(); // day-key  → {msgs, cmds}

function _hk() { return new Date().toISOString().slice(0, 13); } // "2025-01-01T14"
function _dk() { return new Date().toISOString().slice(0, 10); } // "2025-01-01"

function _bucket(map, key) {
  if (!map.has(key)) map.set(key, { msgs: 0, cmds: 0, errs: 0 });
  return map.get(key);
}

function trackMessage()  { _bucket(_hourBuckets, _hk()).msgs++; _bucket(_dayBuckets, _dk()).msgs++; }
function trackCommand()  { _bucket(_hourBuckets, _hk()).cmds++; _bucket(_dayBuckets, _dk()).cmds++; }
function trackError()    { _bucket(_hourBuckets, _hk()).errs++; }

function getStats() {
  const hk = _hk(), dk = _dk();
  const h = _hourBuckets.get(hk) || { msgs: 0, cmds: 0, errs: 0 };
  const d = _dayBuckets.get(dk)  || { msgs: 0, cmds: 0 };

  // Also pull from global server stats if available
  const g = global._serverStats || {};
  return {
    msgsLastHour: (g.totalMessages || 0) || h.msgs,
    msgsToday:    d.msgs,
    cmdsLastHour: (g.totalCommands || 0) || h.cmds,
    cmdsToday:    d.cmds,
    errsLastHour: h.errs,
  };
}

// Prune old buckets every hour
setInterval(() => {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 13);
  for (const k of _hourBuckets.keys()) { if (k < cutoff) _hourBuckets.delete(k); }
  const dcutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  for (const k of _dayBuckets.keys())  { if (k < dcutoff) _dayBuckets.delete(k); }
}, 3600 * 1000);

module.exports = { trackMessage, trackCommand, trackError, getStats };
