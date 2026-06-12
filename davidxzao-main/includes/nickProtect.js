"use strict";

const fs   = require("fs-extra");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "nick-protect.json");

const { atomicWriteFileSync } = (() => {
  try { return require("../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: null }; }
})();

// ─── in-memory store: Map<threadID, { enabled, nicknames: {uid: nick} }> ──────
let _store = null;

function _load() {
  try {
    fs.ensureDirSync(path.dirname(DATA_FILE));
    if (fs.existsSync(DATA_FILE)) {
      const obj = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const m = new Map();
      for (const [tid, v] of Object.entries(obj)) {
        if (v && typeof v === "object") m.set(String(tid), v);
      }
      return m;
    }
  } catch (_) {}
  return new Map();
}

function _save(store) {
  try {
    fs.ensureDirSync(path.dirname(DATA_FILE));
    const obj = {};
    for (const [k, v] of store.entries()) obj[k] = v;
    const data = JSON.stringify(obj, null, 2);
    if (typeof atomicWriteFileSync === "function") {
      atomicWriteFileSync(DATA_FILE, data, "utf-8");
    } else {
      fs.writeFileSync(DATA_FILE, data, "utf8");
    }
  } catch (_) {}
}

function _getStore() {
  if (!_store) _store = _load();
  return _store;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function isEnabled(threadID) {
  const e = _getStore().get(String(threadID));
  return !!(e && e.enabled);
}

function enable(threadID, nicknames) {
  const store = _getStore();
  store.set(String(threadID), { enabled: true, nicknames: nicknames || {} });
  _save(store);
}

function disable(threadID) {
  const store = _getStore();
  store.delete(String(threadID));
  _save(store);
}

function getNicknames(threadID) {
  const e = _getStore().get(String(threadID));
  return (e && e.nicknames) ? e.nicknames : null;
}

function updateNickname(threadID, userID, nickname) {
  const store = _getStore();
  const e = store.get(String(threadID));
  if (!e) return;
  if (!e.nicknames) e.nicknames = {};
  e.nicknames[String(userID)] = nickname;
  _save(store);
}

function getAll() {
  const out = {};
  for (const [tid, v] of _getStore().entries()) {
    out[tid] = { enabled: v.enabled, count: Object.keys(v.nicknames || {}).length };
  }
  return out;
}

module.exports = { isEnabled, enable, disable, getNicknames, updateNickname, getAll };
