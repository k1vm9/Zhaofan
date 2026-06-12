"use strict";
/**
 * ZAO-ENGINE — Cookie Snapshot Ring
 * Unchanged from ZAO's cookieSnapshot.js — it works perfectly.
 * Keeps the last N known-good appstate snapshots in backups/.
 */

const fs   = require("fs");
const path = require("path");

const BACKUPS_DIR    = path.join(process.cwd(), "backups");
const KEEP_DEFAULT   = 5;
const REQUIRED_COOKIES = ["c_user", "xs", "datr"];

function _ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }

function _ts() {
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
       + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function _basenameNoExt(p) {
  return path.basename(String(p || "")).replace(/\.json$/i, "") || "state";
}

function _atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
}

function validate(appState) {
  if (!Array.isArray(appState)) return { ok: false, reason: "not an array" };
  if (!appState.length) return { ok: false, reason: "empty" };
  const seen = new Map();
  for (const c of appState) {
    if (!c || typeof c !== "object") continue;
    const key = String(c.key || c.name || "").toLowerCase();
    if (!key) continue;
    const value = c.value;
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      seen.set(key, String(value).trim());
    }
  }
  const missing = REQUIRED_COOKIES.filter(k => !seen.has(k.toLowerCase()));
  if (missing.length) return { ok: false, reason: "missing required cookies", missing };
  const cuser = seen.get("c_user");
  if (!/^\d{5,25}$/.test(cuser)) return { ok: false, reason: "c_user not valid uid", missing: ["c_user"] };
  return { ok: true };
}

function _readAppStateFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) { return null; }
}

function listSnapshots(basenameFilter) {
  const out = [];
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return out;
    const filter = basenameFilter ? new RegExp(`^${_basenameNoExt(basenameFilter)}-snap-`) : null;
    for (const name of fs.readdirSync(BACKUPS_DIR)) {
      if (!/-snap-\d{8}-\d{6}\.json$/.test(name)) continue;
      if (filter && !filter.test(name)) continue;
      const fp = path.join(BACKUPS_DIR, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        const m = name.match(/^(.+)-snap-(\d{8}-\d{6})\.json$/);
        out.push({ file: fp, basename: m ? m[1] : name, ts: m ? m[2] : "", mtime: st.mtimeMs, size: st.size });
      } catch (_) {}
    }
  } catch (_) {}
  out.sort((a, b) => (b.ts || "").localeCompare(a.ts || "") || (b.mtime - a.mtime));
  return out;
}

function pruneOld(basenameFilter, keep) {
  if (typeof keep !== "number") keep = KEEP_DEFAULT;
  const list = listSnapshots(basenameFilter);
  let removed = 0;
  for (let i = keep; i < list.length; i++) {
    try { fs.unlinkSync(list[i].file); removed++; } catch (_) {}
  }
  return removed;
}

function snapshot(appState, targetPath) {
  const v = validate(appState);
  if (!v.ok) return { ok: false, reason: v.reason };
  _ensureDir(BACKUPS_DIR);
  const data       = JSON.stringify(appState, null, 2);
  const baseNoExt  = _basenameNoExt(targetPath);
  try {
    const existing = listSnapshots(baseNoExt);
    if (existing.length) {
      const newestRaw = fs.readFileSync(existing[0].file, "utf-8");
      if (newestRaw.trim() === data.trim()) return { ok: false, reason: "identical — skipped" };
    }
  } catch (_) {}
  const file = path.join(BACKUPS_DIR, `${baseNoExt}-snap-${_ts()}.json`);
  try { _atomicWriteSync(file, data); } catch (e) { return { ok: false, reason: `write failed: ${e.message}` }; }
  pruneOld(baseNoExt, KEEP_DEFAULT);
  return { ok: true, file };
}

function snapshotFile(targetPath) {
  const appState = _readAppStateFile(targetPath);
  if (!appState) return { ok: false, reason: `target not readable: ${targetPath}` };
  return snapshot(appState, targetPath);
}

function restoreLatestValid(targetPath) {
  const list = listSnapshots(targetPath);
  if (!list.length) return { ok: false, reason: "no snapshots" };
  for (const snap of list) {
    const parsed = _readAppStateFile(snap.file);
    if (!parsed) continue;
    const v = validate(parsed);
    if (!v.ok) continue;
    try {
      _ensureDir(path.dirname(targetPath));
      _atomicWriteSync(targetPath, JSON.stringify(parsed, null, 2));
      return { ok: true, file: snap.file };
    } catch (_) {}
  }
  return { ok: false, reason: "no valid snapshots restored" };
}

module.exports = { validate, snapshot, snapshotFile, restoreLatestValid, listSnapshots, pruneOld, REQUIRED_COOKIES, KEEP_DEFAULT, BACKUPS_DIR };
