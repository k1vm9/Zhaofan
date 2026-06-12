"use strict";

/**
 * RequestPacingEngine
 * ====================
 * A new standalone system that intercepts FCA API HTTP calls and enforces
 * per-account request pacing to prevent Facebook from flagging the session
 * as automated.
 *
 * How it works:
 *   1. Wraps api.httpGet / api.httpPost with a leaky-bucket rate limiter.
 *   2. Adds Gaussian jitter to every inter-request gap so traffic never
 *      exhibits the perfectly regular spacing that automation detectors look for.
 *   3. Enforces a configurable per-minute ceiling (default 40 req/min).
 *   4. Tracks a rolling window of request timestamps and applies progressive
 *      back-off when the rate climbs toward the ceiling.
 *   5. Exports a status snapshot for the panel.
 */

const LOG_PREFIX = "[ PACING ]: ";

// ── Tunables ──────────────────────────────────────────────────────────────
const WINDOW_MS          = 60  * 1000;   // 1-minute rolling window
const BASE_CEIL          = 40;           // max requests per window before throttling
const BURST_CEIL         = 55;           // hard cap — always add delay above this
const MIN_GAP_MS         = 200;          // absolute minimum gap between any two requests
const BASE_JITTER_MS     = 120;          // baseline ± jitter on every gap
const THROTTLE_FACTOR    = 0.65;         // fraction of ceiling at which back-off starts
const BACK_OFF_STEP_MS   = 300;          // extra delay added per req above throttle point

// ── State ─────────────────────────────────────────────────────────────────
let _patchedApis   = new WeakSet();
let _reqTimestamps = [];   // rolling window entries
let _totalReqs     = 0;
let _throttledReqs = 0;
let _lastReqTs     = 0;
let _started       = false;

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: LOG_PREFIX, color: ["red", "cyan"] },
        { message: msg, color: "white" },
      ]);
      return;
    }
  } catch (_) {}
  console.log(LOG_PREFIX + msg);
}

/**
 * Gaussian-ish jitter using Box-Muller lite (two uniform samples averaged).
 * Returns a value in [-BASE_JITTER_MS, +BASE_JITTER_MS] with bell-curve distribution.
 */
function _gaussJitter() {
  const u1 = Math.random();
  const u2 = Math.random();
  const n  = (u1 + u2 - 1);  // approx N(0,0.5)
  return Math.round(n * BASE_JITTER_MS * 2);
}

/**
 * Prune timestamps outside the rolling window and return current count.
 */
function _windowCount() {
  const cutoff = Date.now() - WINDOW_MS;
  _reqTimestamps = _reqTimestamps.filter(t => t > cutoff);
  return _reqTimestamps.length;
}

/**
 * Calculate how long to wait before the next request.
 * Returns a delay in ms (may be 0).
 */
function _computeDelay() {
  const now   = Date.now();
  const count = _windowCount();

  // Always enforce minimum gap from last request
  const sinceLast = now - _lastReqTs;
  const minGap    = Math.max(0, MIN_GAP_MS - sinceLast);

  // Add Gaussian jitter on top of the minimum gap
  const cfg = _loadSettings();
  const jitterMs = cfg.burstMode ? Math.max(0, _gaussJitter() * 2) : _gaussJitter();
  let delay = Math.max(0, minGap + jitterMs);

  // Progressive back-off as we approach the ceiling
  const endpointCeilings = cfg.endpointCeilings || {};
  const effectiveCeiling = endpointCeilings['default'] || BASE_CEIL;
  const throttleAt = Math.floor(effectiveCeiling * THROTTLE_FACTOR);
  if (count > BURST_CEIL) {
    // Hard cap exceeded — add 1-3 second hold
    delay += 1000 + Math.floor(Math.random() * 2000);
    _throttledReqs++;
  } else if (count > throttleAt) {
    const excess = count - throttleAt;
    delay += excess * BACK_OFF_STEP_MS;
    _throttledReqs++;
  } else if (count > effectiveCeiling) {
    // Per-endpoint ceiling hit
    delay += 1000 + Math.floor(Math.random() * 2000);
    _throttledReqs++;
  }

  return delay;
}

/**
 * Record a request and return a Promise that resolves after the computed delay.
 */
function _pace() {
  const delay = _computeDelay();
  _totalReqs++;
  if (delay <= 0) {
    const ts = Date.now();
    _reqTimestamps.push(ts);
    _lastReqTs = ts;
    return Promise.resolve();
  }
  return new Promise(r => setTimeout(r, delay)).then(() => {
    const ts = Date.now();
    _reqTimestamps.push(ts);
    _lastReqTs = ts;
  });
}

/**
 * Wrap a single async function with pacing.
 */
function _wrapFn(fn) {
  return async function pacedFn(...args) {
    await _pace();
    return fn.apply(this, args);
  };
}

/**
 * Wrap a callback-style function with pacing.
 */
function _wrapCb(fn) {
  return function pacedCb(...args) {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    _pace().then(() => {
      if (cb) fn.apply(this, [...args, cb]);
      else    fn.apply(this, args);
    }).catch(e => { if (cb) cb(e); });
  };
}

/**
 * Patch an FCA api instance with request pacing.
 * Safe to call multiple times — subsequent calls on the same object are no-ops.
 *
 * @param {object} api  FCA API instance
 */
function patch(api) {
  if (!api || _patchedApis.has(api)) return;
  _patchedApis.add(api);

  const toPatch = ["httpGet", "httpPost", "httpPostFormData"];
  for (const method of toPatch) {
    if (typeof api[method] === "function") {
      const orig = api[method].bind(api);
      api[method] = _wrapCb(orig);
    }
  }

  _log("Request pacing applied to FCA API instance.");
}

let _settingsCache = null;
let _settingsCacheAt = 0;
function _loadSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 5 * 60_000) return _settingsCache;
  try {
    const raw = require('fs').readFileSync('ZAO-SETTINGS.json', 'utf-8');
    const cfg = JSON.parse(raw);
    _settingsCache = (cfg && cfg.requestPacing) ? cfg.requestPacing : {};
    _settingsCacheAt = Date.now();
  } catch (_) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

/**
 * Start the engine — logs startup status and applies pacing to the provided api
 */
function start(api) {
  if (!_started) {
    _started = true;
    const cfg = _loadSettings();
    _log(`Request Pacing Engine started. Burst mode: ${cfg.burstMode || false}.`);
    _log(`  Ceiling: ${BASE_CEIL} req/min | Hard cap: ${BURST_CEIL} req/min`);
    _log(`  Min gap: ${MIN_GAP_MS}ms | Jitter: ±${BASE_JITTER_MS}ms`);
    _log(`  Per-endpoint ceilings: ${JSON.stringify(cfg.endpointCeilings || {})}`);
  }
  if (api) patch(api);
}

/**
 * Return current engine status for the panel.
 */
function getStatus() {
  const cfg = _loadSettings();
  return {
    active:        _started,
    burstMode:     cfg.burstMode || false,
    windowCount:   _windowCount(),
    windowMs:      WINDOW_MS,
    ceiling:       BASE_CEIL,
    burstCeiling:  BURST_CEIL,
    minGapMs:      MIN_GAP_MS,
    baseJitterMs:  BASE_JITTER_MS,
    totalRequests: _totalReqs,
    throttledReqs: _throttledReqs,
    endpointCeilings: cfg.endpointCeilings || {},
    pressure: {
      current: _windowCount(),
      ceiling: BASE_CEIL,
      percent: Math.round((_windowCount() / BASE_CEIL) * 100)
    }
  };
}

module.exports = { start, patch, getStatus };
module.exports.getBurstPressure = () => {
  const cfg = _loadSettings();
  return cfg.burstMode || false;
};
module.exports.getPressure = () => {
  const count = _windowCount();
  const cfg = _loadSettings();
  return {
    current: count,
    ceiling: cfg.endpointCeilings?.default || BASE_CEIL,
    percent: Math.round((count / (cfg.endpointCeilings?.default || BASE_CEIL)) * 100)
  };
};
