/**
 * cookieSnapshot.js
 *
 * Keeps the last N known-good appstate snapshots on disk so a corrupted
 * ZAO-STATE.json (truncated write, partial refresh, bad cookie rotation)
 * can be restored from a recent valid snapshot WITHOUT forcing a full
 * re-login. Re-logins are the single riskiest operation for the account
 * pool, so avoiding them on transient state corruption is high-value.
 *
 * Layout:
 *   backups/<basename>-snap-<YYYYMMDD-HHmmss>.json
 *   e.g. backups/ZAO-STATE-snap-20260430-191847.json
 *
 * Public API:
 *   validate(appState)              -> { ok, reason, missing }
 *   snapshot(appState, target)      -> { ok, file?, reason? }
 *   snapshotFile(targetPath)        -> reads target and snapshots it
 *   restoreLatestValid(targetPath)  -> { ok, file?, reason? }
 *   listSnapshots(basenameFilter?)  -> [{ file, mtime, size, basename }]
 *   pruneOld(basenameFilter, keep)  -> removed count
 */

const fs   = require('fs');
const path = require('path');

const BACKUPS_DIR = path.join(process.cwd(), 'backups');
const KEEP_DEFAULT = 5;

// Minimum cookies that must be present + non-empty for an appstate to be
// considered usable for login. These are the 3 keys the FCA refuses to log
// in without — datr (browser fingerprint), c_user (uid), xs (session token).
const REQUIRED_COOKIES = ['c_user', 'xs', 'datr'];

function _logger() {
  try { return require('../utils/log.js'); } catch (_) { return null; }
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function _ts() {
  // YYYYMMDD-HHmmss in local time — readable + sortable as a string.
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear().toString()
       + pad(d.getMonth() + 1)
       + pad(d.getDate())
       + '-'
       + pad(d.getHours())
       + pad(d.getMinutes())
       + pad(d.getSeconds());
}

function _basenameNoExt(p) {
  const b = path.basename(String(p || ''));
  return b.replace(/\.json$/i, '') || 'state';
}

function _snapshotFilename(targetPath) {
  return `${_basenameNoExt(targetPath)}-snap-${_ts()}.json`;
}

function _atomicWriteSync(filePath, data) {
  // Local atomic-write so we don't depend on includes/utils being loaded yet.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Validate that an appstate is structurally sound AND contains all
 * authentication-critical cookies with non-empty values.
 */
function validate(appState) {
  if (!Array.isArray(appState)) {
    return { ok: false, reason: 'appstate is not an array' };
  }
  if (appState.length === 0) {
    return { ok: false, reason: 'appstate is empty' };
  }
  // Index by cookie key (lowercased) for tolerant matching.
  const seen = new Map();
  for (const c of appState) {
    if (!c || typeof c !== 'object') continue;
    const key = String(c.key || c.name || '').toLowerCase();
    if (!key) continue;
    const value = c.value;
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      seen.set(key, String(value).trim());
    }
  }
  const missing = REQUIRED_COOKIES.filter(k => !seen.has(k.toLowerCase()));
  if (missing.length) {
    return { ok: false, reason: 'missing required cookies', missing };
  }
  // Sanity: c_user must look like a numeric UID
  const cuser = seen.get('c_user');
  if (!/^\d{5,25}$/.test(cuser)) {
    return { ok: false, reason: 'c_user does not look like a uid', missing: ['c_user'] };
  }
  return { ok: true };
}

/**
 * Read+parse a JSON appstate file, validate it. Returns the parsed array
 * on success or null on any failure.
 */
function _readAppStateFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) { return null; }
}

/**
 * Snapshot the given appstate to backups/. Skips if invalid, or if the
 * newest existing snapshot has identical content (avoids gigabytes of
 * identical files when called from many places).
 */
function snapshot(appState, targetPath) {
  const v = validate(appState);
  if (!v.ok) return { ok: false, reason: v.reason };

  _ensureDir(BACKUPS_DIR);
  const data = JSON.stringify(appState, null, 2);
  const baseNoExt = _basenameNoExt(targetPath);

  // Dedupe — if newest existing snapshot for this basename is byte-identical,
  // skip writing a new one. Saves disk + keeps the ring meaningful.
  try {
    const existing = listSnapshots(baseNoExt);
    if (existing.length) {
      const newestRaw = fs.readFileSync(existing[0].file, 'utf-8');
      if (newestRaw.trim() === data.trim()) {
        return { ok: false, reason: 'identical to newest snapshot — skipped' };
      }
    }
  } catch (_) {}

  const file = path.join(BACKUPS_DIR, _snapshotFilename(targetPath));
  try {
    _atomicWriteSync(file, data);
  } catch (e) {
    return { ok: false, reason: `write failed: ${e.message}` };
  }
  // Keep the ring tight — only N most recent for this basename.
  pruneOld(baseNoExt, KEEP_DEFAULT);
  return { ok: true, file };
}

/**
 * Snapshot directly from a target file on disk (no FCA api needed).
 */
function snapshotFile(targetPath) {
  const appState = _readAppStateFile(targetPath);
  if (!appState) return { ok: false, reason: `target not readable: ${targetPath}` };
  return snapshot(appState, targetPath);
}

/**
 * List snapshot files for a basename, newest first. If no filter given,
 * lists every snapshot in the backups/ directory.
 */
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
        out.push({
          file: fp,
          basename: m ? m[1] : name,
          ts:       m ? m[2] : '',
          mtime: st.mtimeMs,
          size:  st.size
        });
      } catch (_) {}
    }
  } catch (_) {}
  // Sort newest-first by parsed timestamp string (sortable lexicographically).
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || '') || (b.mtime - a.mtime));
  return out;
}

/**
 * Prune older snapshots for a given basename, keeping only the newest `keep`.
 */
function pruneOld(basenameFilter, keep) {
  if (typeof keep !== 'number') keep = KEEP_DEFAULT;
  const list = listSnapshots(basenameFilter);
  let removed = 0;
  for (let i = keep; i < list.length; i++) {
    try { fs.unlinkSync(list[i].file); removed++; } catch (_) {}
  }
  return removed;
}

/**
 * Restore the newest VALID snapshot for `targetPath` onto that path. Snapshots
 * are revalidated before being chosen, so a file that turned bad on disk
 * after capture is still skipped over.
 *
 * Does NOT touch alt files — the watchdog should mirror state→alt itself
 * after restore (or just let the next cookie save do it).
 */
function restoreLatestValid(targetPath) {
  const list = listSnapshots(targetPath);
  if (!list.length) return { ok: false, reason: 'no snapshots available' };
  for (const snap of list) {
    const parsed = _readAppStateFile(snap.file);
    if (!parsed) continue;
    const v = validate(parsed);
    if (!v.ok) continue;
    try {
      _ensureDir(path.dirname(targetPath));
      _atomicWriteSync(targetPath, JSON.stringify(parsed, null, 2));
      const log = _logger();
      if (log) {
        log.log([
          { message: '[ COOKIE-SNAP ]: ', color: ['red', 'cyan'] },
          { message: `Restored ${path.basename(targetPath)} from ${path.basename(snap.file)} ✓`, color: 'white' }
        ]);
      }
      return { ok: true, file: snap.file };
    } catch (e) {
      // try the next-newest
    }
  }
  return { ok: false, reason: 'no valid snapshots restored' };
}

module.exports = {
  validate,
  snapshot,
  snapshotFile,
  restoreLatestValid,
  listSnapshots,
  pruneOld,
  REQUIRED_COOKIES,
  KEEP_DEFAULT,
  BACKUPS_DIR
};
