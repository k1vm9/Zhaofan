"use strict";

const path = require("path");
const { createStore } = require("./kvStore");

const LOCKS_FILE = path.join(__dirname, "..", "data", "nm-locks.json");
const store = createStore(LOCKS_FILE);

function _norm(v) {
  if (!v) return null;
  if (typeof v === "string") return { name: v, time: 6000, randomTime: false, randomRange: null };
  return {
    name:        v.name        || "",
    time:        v.time        || 6000,
    randomTime:  !!v.randomTime,
    randomRange: v.randomRange || null
  };
}

function asMap() {
  return {
    set(k, v)    { store.set(k, v); return this; },
    get(k)       { const r = store.get(k); return r ? _norm(r) : undefined; },
    has(k)       { return store.has(k); },
    delete(k)    { return store.delete(k); },
    clear()      { store.clear(); return this; },
    entries()    {
      const out = [];
      for (const [k, v] of store.entries()) out.push([k, _norm(v)]);
      return out[Symbol.iterator]();
    },
    keys()       { return store.keys(); },
    values()     {
      const out = [];
      for (const [, v] of store.entries()) out.push(_norm(v));
      return out[Symbol.iterator]();
    },
    forEach(cb)  { for (const [k, v] of store.entries()) cb(_norm(v), k, this); },
    get size()   { return store.size(); }
  };
}

function loadLocks()  { store.load(); return asMap(); }
function saveLocks()  { store.flushSync(); }
function getLocks()   { if (!global.nameLocks) global.nameLocks = asMap(); return global.nameLocks; }

function setLock(threadID, name, timeConfig) {
  const existing = store.get(threadID);
  const base = _norm(existing) || {};
  store.set(String(threadID), {
    name,
    time:        timeConfig?.time        ?? base.time        ?? 6000,
    randomTime:  timeConfig?.randomTime  ?? base.randomTime  ?? false,
    randomRange: timeConfig?.randomRange ?? base.randomRange ?? null
  });
  store.flushSync();
}

function setLockTime(threadID, timeConfig) {
  const existing = store.get(String(threadID));
  if (!existing) return;
  const base = _norm(existing);
  store.set(String(threadID), {
    name:        base.name,
    time:        timeConfig.time        ?? base.time,
    randomTime:  timeConfig.randomTime  ?? base.randomTime,
    randomRange: timeConfig.randomRange ?? base.randomRange
  });
  store.flushSync();
}

function clearLock(threadID) { const had = store.delete(String(threadID)); store.flushSync(); return had; }
function getLock(threadID)   { const r = store.get(String(threadID)); return r ? _norm(r) : null; }
function flush()             { store.flushSync(); }

module.exports = {
  LOCKS_FILE, loadLocks, saveLocks, getLocks,
  setLock, setLockTime, clearLock, getLock, flush,
  _store: store
};
