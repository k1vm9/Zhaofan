"use strict";
/**
 * ZAO-ENGINE — Session Guard (3 layers)
 * Based on ZAO's sessionGuard.js — unchanged, it works well.
 * Layer 1: AppState snapshot ring every 30 min
 * Layer 2: Cookie integrity check every 20 min
 * Layer 3: Pre-relogin hook (snapshot before any re-login attempt)
 */

const fs   = require("fs");
const path = require("path");

const SNAPSHOT_INTERVAL  = 30 * 60_000;
const INTEGRITY_INTERVAL = 20 * 60_000;
const SNAPSHOT_KEEP      = 7;
// Only c_user and xs are truly mandatory — datr is not always present
// in all AppState formats and its absence is not a real session problem.
const REQUIRED_COOKIES   = ["c_user", "xs"];
const OPTIONAL_COOKIES   = ["datr"];

function _log(level, msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ SESSION-GUARD ]: ", color: ["red", "cyan"] },
        { message: msg, color: level === "warn" ? "yellow" : level === "error" ? "red" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log(`[SESSION-GUARD] ${msg}`);
}

function _snap() {
  try { return require("./cookieSnapshot"); } catch (_) { return null; }
}

function _getAppState(api) {
  try { if (api && typeof api.getAppState === "function") return api.getAppState(); } catch (_) {}
  return null;
}

function _validateCookies(appState) {
  if (!Array.isArray(appState) || !appState.length) return { ok: false, reason: "empty" };
  const seen = new Map();
  for (const c of appState) {
    const key = String(c.key || c.name || "").toLowerCase();
    const val = c.value !== undefined && c.value !== null ? String(c.value).trim() : "";
    if (key && val) seen.set(key, val);
  }
  const missing = REQUIRED_COOKIES.filter(k => !seen.has(k));
  if (missing.length) return { ok: false, reason: "missing: " + missing.join(", ") };
  const cuser = seen.get("c_user");
  if (!/^\d{5,25}$/.test(cuser)) return { ok: false, reason: "c_user invalid" };
  return { ok: true };
}

function _notifyAdmins(msg) {
  try {
    const api    = global._botApi;
    const admins = (global.config && global.config.ADMINBOT) || [];
    if (!api || !admins.length) return;
    for (const id of admins) {
      const sid = String(id).trim();
      if (!sid) continue;
      api.sendMessage(msg, sid).catch(() => {});
    }
  } catch (_) {}
}

let _snapshotTimer   = null;
let _integrityTimer  = null;
let _stateFilePath   = null;
let _apiRef          = null;
let _lastSnapshotTs  = 0;
let _lastIntTs       = 0;
let _lastIntOk       = null;
let _lastIntMsg      = "";
let _snapCount       = 0;
let _running         = false;

function _doSnapshot() {
  try {
    const snap = _snap();
    if (!snap) return;
    const appState = _getAppState(_apiRef);
    if (appState) {
      const result = snap.snapshot(appState, _stateFilePath || "ZAO-STATE.json");
      if (result.ok) {
        _lastSnapshotTs = Date.now();
        _snapCount++;
        snap.pruneOld(path.basename(_stateFilePath || "ZAO-STATE.json"), SNAPSHOT_KEEP);
        _log("info", `Snapshot saved (${_snapCount}).`);
      }
    }
  } catch (e) {
    _log("warn", "Snapshot failed: " + (e?.message || e));
  }
}

function _doIntegrityCheck() {
  _lastIntTs = Date.now();
  try {
    const appState = _getAppState(_apiRef);
    if (!appState) { _lastIntOk = null; _lastIntMsg = "API not ready"; return; }
    const { ok, reason } = _validateCookies(appState);
    _lastIntOk  = ok;
    _lastIntMsg = ok ? "c_user/xs OK" : reason;
    if (ok) { _log("info", "Cookie integrity OK."); return; }
    _log("error", `Cookie integrity FAILED: ${reason}`);
    const snap = _snap();
    if (snap && _stateFilePath) snap.snapshotFile(_stateFilePath);
    _notifyAdmins(`🚨 SESSION-GUARD: بيانات الجلسة تالفة\nالسبب: ${reason}`);
  } catch (e) {
    _lastIntOk = false;
    _lastIntMsg = e?.message || String(e);
    _log("warn", "Integrity check error: " + _lastIntMsg);
  }
}

function _preReloginHook() {
  return new Promise(resolve => {
    try { _log("info", "Pre-relogin snapshot…"); _doSnapshot(); } catch (_) {}
    resolve();
  });
}

function start(api, stateFilePath) {
  _running       = true;
  _apiRef        = api;
  _stateFilePath = stateFilePath || path.join(process.cwd(), "sessions", "ZAO-STATE.json");

  try {
    const snap = _snap();
    if (snap) {
      const v = snap.validate(_getAppState(api) || []);
      if (!v.ok) {
        _log("warn", `Startup AppState invalid (${v.reason}) — attempting restore…`);
        const r = snap.restoreLatestValid(_stateFilePath);
        if (r.ok) _log("info", `Auto-restored from: ${path.basename(r.file)}`);
        else _log("warn", "No valid snapshot — will attempt live login.");
      } else {
        _log("info", "Startup AppState valid.");
        _doSnapshot();
      }
    }
  } catch (e) {
    _log("warn", "Startup validation error: " + (e?.message || e));
  }

  if (_snapshotTimer)  { clearInterval(_snapshotTimer);  _snapshotTimer  = null; }
  if (_integrityTimer) { clearInterval(_integrityTimer); _integrityTimer = null; }

  _snapshotTimer = setInterval(_doSnapshot, SNAPSHOT_INTERVAL);
  if (_snapshotTimer.unref) _snapshotTimer.unref();

  _integrityTimer = setInterval(_doIntegrityCheck, INTEGRITY_INTERVAL);
  if (_integrityTimer.unref) _integrityTimer.unref();

  global._sessionGuardPreRelogin = _preReloginHook;

  _log("info", `Started — snapshot every ${SNAPSHOT_INTERVAL / 60000} min, integrity check every ${INTEGRITY_INTERVAL / 60000} min.`);
}

function stop() {
  _running = false;
  if (_snapshotTimer)  { clearInterval(_snapshotTimer);  _snapshotTimer  = null; }
  if (_integrityTimer) { clearInterval(_integrityTimer); _integrityTimer = null; }
  global._sessionGuardPreRelogin = null;
  _log("info", "Stopped.");
}

function updateApi(api) { _apiRef = api; }
function flush()        { _doSnapshot(); _doIntegrityCheck(); }

function getStatus() {
  const snap = _snap();
  let snapshots = [];
  try {
    if (snap) {
      snapshots = (snap.listSnapshots() || []).map(s => ({
        file: path.basename(s.file || ""), mtime: s.mtime ? new Date(s.mtime).getTime() : 0,
        sizeKb: s.size ? Math.round(s.size / 1024) : 0,
      }));
    }
  } catch (_) {}
  const now = Date.now();
  return {
    running: _running, stateFile: _stateFilePath ? path.basename(_stateFilePath) : "—",
    snapshotIntervalMin: SNAPSHOT_INTERVAL / 60000,
    lastSnapshotTs: _lastSnapshotTs || null,
    nextSnapshotIn: _lastSnapshotTs ? Math.max(0, Math.round((_lastSnapshotTs + SNAPSHOT_INTERVAL - now) / 1000)) : null,
    snapshotsTaken: _snapCount, snapshotKeep: SNAPSHOT_KEEP, snapshots,
    integrityIntervalMin: INTEGRITY_INTERVAL / 60000,
    lastIntegrityTs: _lastIntTs || null,
    nextIntegrityIn: _lastIntTs ? Math.max(0, Math.round((_lastIntTs + INTEGRITY_INTERVAL - now) / 1000)) : null,
    integrityOk: _lastIntOk, integrityMsg: _lastIntMsg,
    preReloginHookActive: typeof global._sessionGuardPreRelogin === "function",
  };
}

module.exports = { start, stop, updateApi, flush, getStatus };
