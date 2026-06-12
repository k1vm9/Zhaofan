'use strict';
/**
 * runtimePersist.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Solves the Railway / Replit "wipe on deploy" problem.
 *
 * WHY:  ZAO-SETTINGS.json is part of the git repo. Every fresh deployment
 *       resets it to the committed version, erasing admins added at runtime.
 *       data/ files are also ephemeral unless a persistent volume is mounted.
 *
 * HOW:
 *  1.  Runtime mutations (admin additions/removals) are written to
 *      data/runtime-overrides.json  (persists if a Railway volume is mounted).
 *  2.  ZAO_ADMIN_LIST env var  (comma-separated UIDs) acts as a permanent
 *      static override — set it once in Railway/Replit secrets and it survives
 *      every deployment without a volume.
 *  3.  On startup mergeIntoConfig() blends both sources into global.config so
 *      the rest of the bot sees a unified admin list.
 *
 * Priority (highest wins):  env var  >  runtime-overrides.json  >  ZAO-SETTINGS.json
 */

const fs   = require('fs');
const path = require('path');

const OVERRIDE_FILE = path.join(process.cwd(), 'data', 'runtime-overrides.json');

// ── helpers ──────────────────────────────────────────────────────────────────

function _uniq(arr) {
  const seen = new Set();
  return (arr || []).map(String).filter(v => { if (!v || seen.has(v)) return false; seen.add(v); return true; });
}

function _readFile() {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) return {};
    return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
  } catch (_) { return {}; }
}

function _writeFile(data) {
  try {
    const dir = path.dirname(OVERRIDE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // atomic write: temp → rename
    const tmp = OVERRIDE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, OVERRIDE_FILE);
    return true;
  } catch (e) {
    console.error('[runtimePersist] write failed:', e.message);
    return false;
  }
}

// ── env var helpers ───────────────────────────────────────────────────────────

function _envAdmins() {
  const raw = process.env.ZAO_ADMIN_LIST || '';
  return _uniq(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns the current admin list.
 * Priority: ZAO_ADMIN_LIST env  >  runtime-overrides.json  >  global.config.ADMINBOT
 */
function getAdmins() {
  const fromEnv      = _envAdmins();
  if (fromEnv.length) return fromEnv;

  const overrides = _readFile();
  if (Array.isArray(overrides.ADMINBOT) && overrides.ADMINBOT.length)
    return _uniq(overrides.ADMINBOT);

  return _uniq((global.config || {}).ADMINBOT || []);
}

/**
 * Persists a new admin list to runtime-overrides.json.
 * Also updates global.config so the running bot sees the change immediately.
 */
function setAdmins(arr) {
  const list = _uniq(arr);
  const overrides = _readFile();
  overrides.ADMINBOT    = list;
  overrides._updatedAt  = new Date().toISOString();
  _writeFile(overrides);

  if (global.config) global.config.ADMINBOT = list;
  return list;
}

/**
 * Call once at startup (after ZAO-SETTINGS.json is loaded into global.config).
 * Merges runtime overrides + env var into global.config.
 */
function mergeIntoConfig() {
  if (!global.config) return;

  // Build merged admin list
  const fromEnv      = _envAdmins();
  const overrides    = _readFile();
  const fromFile     = Array.isArray(overrides.ADMINBOT) ? overrides.ADMINBOT : [];
  const fromSettings = Array.isArray(global.config.ADMINBOT) ? global.config.ADMINBOT : [];

  let merged;
  if (fromEnv.length) {
    // env var wins — combine with settings so repo-committed admins are kept
    merged = _uniq([...fromEnv, ...fromSettings]);
  } else if (fromFile.length) {
    // runtime-overrides wins over ZAO-SETTINGS (which may be stale from repo)
    merged = _uniq([...fromFile, ...fromSettings]);
  } else {
    merged = _uniq(fromSettings);
  }

  global.config.ADMINBOT = merged;

  if (fromEnv.length || fromFile.length) {
    try {
      const logger = require('./logger') || console;
      const src = fromEnv.length ? 'ZAO_ADMIN_LIST env' : 'runtime-overrides.json';
      (logger.log || logger.info || console.log)(
        `[runtimePersist] Admin list merged from ${src}: ${merged.length} admins`
      );
    } catch (_) {}
  }
}

/**
 * Returns a one-liner instruction string for making current admins permanent.
 * Shown in the bot response after .admins add so the user knows what to do.
 */
function persistHint(adminList) {
  return (
    `\n\n💡 لضمان البقاء بعد كل نشر:\n` +
    `أضف هذا إلى متغيرات البيئة في Railway/Replit:\n` +
    `ZAO_ADMIN_LIST=${adminList.join(',')}`
  );
}

module.exports = { getAdmins, setAdmins, mergeIntoConfig, persistHint };
