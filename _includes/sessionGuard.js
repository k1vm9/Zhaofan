"use strict";

/**
 * sessionGuard.js — Advanced Session Preservation System (3 layers)
 *
 * Layer 1 — AppState Guardian
 *   • Snapshots the AppState every SNAPSHOT_INTERVAL minutes if it changed.
 *   • Keeps a versioned ring (default 7 copies) in backups/.
 *   • On startup validates the current state file; if corrupt, auto-restores
 *     from the newest valid snapshot before the bot attempts login.
 *
 * Layer 2 — Cookie Integrity Monitor
 *   • Every INTEGRITY_INTERVAL minutes, reads the live AppState from the API
 *     and checks that c_user, xs, and datr are still present and non-empty.
 *   • On integrity failure: snapshots BEFORE the failure is written to disk,
 *     logs a warning, and notifies admins so a manual tier switch can happen.
 *
 * Layer 3 — Pre-Relogin Hook
 *   • Registers a global hook (global._sessionGuardPreRelogin) that callers
 *     invoke BEFORE a re-login.  The hook snapshots the current state (if
 *     still valid) so we always have the freshest known-good copy.
 *
 * Usage (from ZAO.js after login):
 *   const sg = require('./includes/sessionGuard');
 *   sg.start(api, stateFilePath);
 *
 * Usage (from Emalogin / autoRelogin before attempting re-login):
 *   await global._sessionGuardPreRelogin?.();
 */

const fs   = require("fs");
const path = require("path");

const SNAPSHOT_INTERVAL  = 30 * 60_000;   // 30 min
const INTEGRITY_INTERVAL = 20 * 60_000;   // 20 min
const SNAPSHOT_KEEP      = 7;             // versioned ring size

const REQUIRED_COOKIES = ["c_user", "xs", "datr"];

// ─── Logger ───────────────────────────────────────────────────────────────────
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
  const prefix = level === "warn" ? "⚠️" : level === "error" ? "❌" : "ℹ️";
  console.log(`[SESSION-GUARD] ${prefix} ${msg}`);
}

// ─── Lazy cookieSnapshot reference ────────────────────────────────────────────
function _snap() {
  try { return require("./cookieSnapshot"); } catch (_) { return null; }
}

// ─── Cookie extraction helpers ────────────────────────────────────────────────
function _getAppState(api) {
  try {
    if (api && typeof api.getAppState === "function") return api.getAppState();
  } catch (_) {}
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

// ─── Admin notification ───────────────────────────────────────────────────────
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

// ─── State ────────────────────────────────────────────────────────────────────
let _snapshotTimer    = null;
let _integrityTimer   = null;
let _stateFilePath    = null;
let _apiRef           = null;
let _lastSnapshotTs   = 0;
let _lastIntegrityTs  = 0;
let _lastIntegrityOk  = null;   // null = never checked, true/false = result
let _lastIntegrityMsg = "";
let _snapshotCount    = 0;
let _running          = false;

// ─── Layer 1: AppState snapshot ───────────────────────────────────────────────
function _doSnapshot() {
  try {
    const snap = _snap();
    if (!snap) return;
    const appState = _getAppState(_apiRef);
    if (appState) {
      const result = snap.snapshot(appState, _stateFilePath || "ZAO-STATE.json");
      if (result.ok) {
        _lastSnapshotTs = Date.now();
        _snapshotCount++;
        snap.pruneOld(path.basename(_stateFilePath || "ZAO-STATE.json"), SNAPSHOT_KEEP);
        _log("info", `AppState snapshot saved (${SNAPSHOT_KEEP} max): ${path.basename(result.file || "")}`);
      }
      // "identical to newest" is not an error — silently skip
    }
  } catch (e) {
    _log("warn", "Snapshot failed: " + (e && e.message ? e.message : String(e)));
  }
}

// ─── Layer 2: Cookie integrity check ─────────────────────────────────────────
function _doIntegrityCheck() {
  _lastIntegrityTs = Date.now();
  try {
    const appState = _getAppState(_apiRef);
    if (!appState) {
      _lastIntegrityOk  = null;
      _lastIntegrityMsg = "API not ready";
      return;
    }

    const { ok, reason } = _validateCookies(appState);
    _lastIntegrityOk  = ok;
    _lastIntegrityMsg = ok ? "c_user / xs / datr present" : reason;

    if (ok) {
      _log("info", "Cookie integrity OK (c_user/xs/datr present).");
      return;
    }

    _log("error", `Cookie integrity FAILED: ${reason}`);

    // Snapshot whatever we have on disk BEFORE it gets worse
    const snap = _snap();
    if (snap && _stateFilePath) {
      snap.snapshotFile(_stateFilePath);
    }

    _notifyAdmins(
      `🚨 SESSION-GUARD: بيانات الجلسة تالفة\n` +
      `السبب: ${reason}\n` +
      `يُنصح بتبديل Tier أو إعادة رفع الكوكيز.`
    );
  } catch (e) {
    _lastIntegrityOk  = false;
    _lastIntegrityMsg = e && e.message ? e.message : String(e);
    _log("warn", "Integrity check error: " + _lastIntegrityMsg);
  }
}

// ─── Layer 3: Pre-relogin hook ────────────────────────────────────────────────
function _preReloginHook() {
  return new Promise(resolve => {
    try {
      _log("info", "Pre-relogin hook fired — snapshotting current state…");
      _doSnapshot();
    } catch (_) {}
    resolve();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Startup: validate the state file, auto-restore if corrupt, then start
 * periodic snapshot + integrity timers.
 *
 * @param {object} api           Live FCA api object
 * @param {string} stateFilePath Absolute path to ZAO-STATE.json (or tier file)
 */
function start(api, stateFilePath) {
  _running       = true;
  _apiRef        = api;
  _stateFilePath = stateFilePath || path.join(process.cwd(), "sessions", "ZAO-STATE.json");

  // ── Startup validation + auto-restore ────────────────────────────────────
  try {
    const snap = _snap();
    if (snap) {
      const v = snap.validate(_getAppState(api) || []);
      if (!v.ok) {
        _log("warn", `Startup AppState invalid (${v.reason}) — attempting restore…`);
        const r = snap.restoreLatestValid(_stateFilePath);
        if (r.ok) {
          _log("info", `Auto-restored from: ${path.basename(r.file)}`);
        } else {
          _log("warn", "No valid snapshot to restore from — bot will attempt live login.");
        }
      } else {
        _log("info", "Startup AppState is valid.");
        // Take an initial snapshot
        _doSnapshot();
      }
    }
  } catch (e) {
    _log("warn", "Startup validation error: " + (e && e.message ? e.message : String(e)));
  }

  // ── Clear stale timers ────────────────────────────────────────────────────
  if (_snapshotTimer)  { clearInterval(_snapshotTimer);  _snapshotTimer  = null; }
  if (_integrityTimer) { clearInterval(_integrityTimer); _integrityTimer = null; }

  // ── Layer 1 timer ─────────────────────────────────────────────────────────
  _snapshotTimer = setInterval(_doSnapshot, SNAPSHOT_INTERVAL);
  if (_snapshotTimer.unref) _snapshotTimer.unref();

  // ── Layer 2 timer ─────────────────────────────────────────────────────────
  _integrityTimer = setInterval(_doIntegrityCheck, INTEGRITY_INTERVAL);
  if (_integrityTimer.unref) _integrityTimer.unref();

  // ── Layer 3 hook ──────────────────────────────────────────────────────────
  global._sessionGuardPreRelogin = _preReloginHook;

  _log("info", `Started — snapshot every ${SNAPSHOT_INTERVAL / 60000} min, integrity check every ${INTEGRITY_INTERVAL / 60000} min.`);
}

/** Stop all timers (call before tier switch or graceful shutdown). */
function stop() {
  _running = false;
  if (_snapshotTimer)  { clearInterval(_snapshotTimer);  _snapshotTimer  = null; }
  if (_integrityTimer) { clearInterval(_integrityTimer); _integrityTimer = null; }
  global._sessionGuardPreRelogin = null;
  _log("info", "Stopped.");
}

/** Update the API reference when a tier switch provides a new api object. */
function updateApi(api) {
  _apiRef = api;
  _log("info", "API reference updated.");
}

/** Force an immediate snapshot + integrity check. */
function flush() {
  _doSnapshot();
  _doIntegrityCheck();
}

/**
 * Return a live status snapshot for the web panel.
 */
function getStatus() {
  const snap = _snap();
  let snapshots = [];
  try {
    if (snap) {
      snapshots = (snap.listSnapshots() || []).map(s => ({
        file:    path.basename(s.file || ""),
        mtime:   s.mtime ? new Date(s.mtime).getTime() : 0,
        sizeKb:  s.size ? Math.round(s.size / 1024) : 0,
      }));
    }
  } catch (_) {}

  const now = Date.now();
  return {
    running:           _running,
    stateFile:         _stateFilePath ? path.basename(_stateFilePath) : "—",
    // Layer 1 (snapshots)
    snapshotIntervalMin: SNAPSHOT_INTERVAL / 60000,
    lastSnapshotTs:    _lastSnapshotTs || null,
    nextSnapshotIn:    _lastSnapshotTs
      ? Math.max(0, Math.round((_lastSnapshotTs + SNAPSHOT_INTERVAL - now) / 1000))
      : null,
    snapshotsTaken:    _snapshotCount,
    snapshotKeep:      SNAPSHOT_KEEP,
    snapshots,          // array of { file, mtime, sizeKb }
    // Layer 2 (integrity)
    integrityIntervalMin: INTEGRITY_INTERVAL / 60000,
    lastIntegrityTs:   _lastIntegrityTs || null,
    nextIntegrityIn:   _lastIntegrityTs
      ? Math.max(0, Math.round((_lastIntegrityTs + INTEGRITY_INTERVAL - now) / 1000))
      : null,
    integrityOk:       _lastIntegrityOk,
    integrityMsg:      _lastIntegrityMsg,
    // Layer 3 (hook)
    preReloginHookActive: typeof global._sessionGuardPreRelogin === "function",
  };
}

module.exports = { start, stop, updateApi, flush, getStatus };
