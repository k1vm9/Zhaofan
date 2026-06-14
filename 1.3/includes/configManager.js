"use strict";

/**
 * configManager.js
 *
 * Unified configuration manager for ZAO.
 * - TTL-cached reads (avoids repeated disk I/O on every ping/paced request)
 * - Explicit reload on demand
 * - Centralised validation so callers never parse raw JSON
 * - Falls back gracefully when the file is missing or malformed
 */

const fs   = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(process.cwd(), "ZAO-SETTINGS.json");
const DEFAULT_TTL_MS = 5 * 60 * 1000;  // 5-minute cache lifetime

let _cache    = null;
let _cacheAt  = 0;
let _loading  = false;

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: "[ CONFIG-MGR ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[CONFIG-MGR]", msg);
}

/**
 * Load and cache ZAO-SETTINGS.json.
 * Returns the full parsed object, or {} on failure.
 * TTL is respected unless `force` is true.
 *
 * @param {boolean} [force=false]  Skip TTL and reload immediately.
 * @returns {object}
 */
function get(force = false) {
  if (!force && _cache && (Date.now() - _cacheAt) < DEFAULT_TTL_MS) {
    return _cache;
  }
  if (_loading) return _cache || {};
  _loading = true;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    _cache   = parsed || {};
    _cacheAt = Date.now();
  } catch (e) {
    _log(`Failed to load ZAO-SETTINGS.json: ${e.message} — using cached/empty config`);
    _cache = _cache || {};
  } finally {
    _loading = false;
  }
  return _cache;
}

/**
 * Get a specific top-level section of the config.
 *
 * @param {string} section  e.g. "keepAlive", "requestPacing", "stealthMode"
 * @param {boolean} [force=false]
 * @returns {object}
 */
function section(section, force = false) {
  const cfg = get(force);
  return (cfg && cfg[section]) ? cfg[section] : {};
}

/**
 * Force an immediate reload of the config file.
 * Call this after the panel saves new settings.
 *
 * @returns {object}  The freshly loaded config.
 */
function reload() {
  return get(true);
}

/**
 * Invalidate the cache without reloading (lazy — next access will reload).
 */
function invalidate() {
  _cache  = null;
  _cacheAt = 0;
}

/**
 * Return cache age in milliseconds (for diagnostics).
 */
function cacheAge() {
  return _cache ? Date.now() - _cacheAt : null;
}

module.exports = { get, section, reload, invalidate, cacheAge };
