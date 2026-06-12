"use strict";

const path = require("path");
const { createStore } = require("./kvStore");

const LOCKS_FILE = path.join(__dirname, "..", "data", "groupimg-locks.json");
const store = createStore(LOCKS_FILE);

function _norm(v) {
  if (!v) return null;
  if (typeof v === "string") return { imgPath: v, time: 30000, randomTime: false, randomRange: null };
  return {
    imgPath:     v.imgPath     || "",
    time:        v.time        || 30000,
    randomTime:  !!v.randomTime,
    randomRange: v.randomRange || null
  };
}

function asMap() {
  return {
    set(k, v)  { store.set(k, v); return this; },
    get(k)     { const r = store.get(k); return r ? _norm(r) : undefined; },
    has(k)     { return store.has(k); },
    delete(k)  { return store.delete(k); },
    clear()    { store.clear(); return this; },
    entries()  {
      const out = [];
      for (const [k, v] of store.entries()) out.push([k, _norm(v)]);
      return out[Symbol.iterator]();
    },
    keys()     { return store.keys(); },
    get size() { return store.size(); }
  };
}

function getLocks()   { if (!global.groupImgLocks) global.groupImgLocks = asMap(); return global.groupImgLocks; }

function setLock(threadID, imgPath, timeConfig) {
  const existing = store.get(String(threadID));
  const base = _norm(existing) || {};
  store.set(String(threadID), {
    imgPath,
    time:        timeConfig?.time        ?? base.time        ?? 30000,
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
    imgPath:     base.imgPath,
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
  LOCKS_FILE, getLocks, setLock, setLockTime, clearLock, getLock, flush,
  _store: store
};
