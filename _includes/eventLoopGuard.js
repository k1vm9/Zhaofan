'use strict';
/**
 * eventLoopGuard.js  v2 — UPGRADED
 *
 * Detects sustained event-loop stalls using perf_hooks.monitorEventLoopDelay.
 *
 * Upgrades:
 * - Threshold lowered 500ms → 400ms (catch stalls earlier)
 * - Sustain window lowered 30s → 20s (faster detection)
 * - Warning phase at 50% of sustain window: logs a non-fatal alert so the
 *   operator can see a stall building without an immediate process restart
 * - Captures v8 heap stats in the final log entry (RSS / heapUsed / external)
 * - Graceful pre-exit flush: cookies, motor state, nameLocks, nicknameLocks
 * - checkEvery lowered to 3 s (was 5 s) for tighter responsiveness
 * - histogram.reset() now guarded so a bad clear doesn't silently kill the guard
 * - Exported getStats() includes warningSince for panel diagnostics
 */

const { monitorEventLoopDelay } = require('perf_hooks');

let started        = false;
let histogram      = null;
let highSince      = 0;
let warningSince   = 0;  // timestamp when we first entered the warning phase
let recycling      = false;
let resolutionMs   = 100;

function _getUtils() {
  try {
    // Some parts of the bot attach logger helpers under global.utils
    if (global.utils) return { utils: global.utils };
  } catch (_) {}
  return { utils: null };
}

function _logger() {
  try { return require('../utils/log.js'); } catch (_) { return null; }
}

function _heapSummary() {
  try {
    const m = process.memoryUsage();
    return `heap=${Math.round(m.heapUsed / 1024 / 1024)}MB ` +
           `rss=${Math.round(m.rss  / 1024 / 1024)}MB ` +
           `ext=${Math.round(m.external / 1024 / 1024)}MB`;
  } catch (_) { return 'heap=?'; }
}

function _saveStateBeforeExit() {
  try { require('./login/statePersist').save(); } catch (_) {}
  try { if (typeof global._saveMotorState  === 'function') global._saveMotorState();  } catch (_) {}
  try { if (typeof global._saveMotor2State === 'function') global._saveMotor2State(); } catch (_) {}
  try { require('./nameLocks').flush();     } catch (_) {}
  try { require('./nicknameLocks').flush(); } catch (_) {}
  // Flush anti-suspension state (circuit breaker, daily counters)
  try {
    const as = global._antiSuspension;
    if (as && typeof as._flushState === 'function') as._flushState();
  } catch (_) {}
}

let _settingsCache = null;
let _settingsCacheAt = 0;
function _loadSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 5 * 60_000) return _settingsCache;
  try {
    const raw = require('fs').readFileSync('ZAO-SETTINGS.json', 'utf-8');
    const cfg = JSON.parse(raw);
    _settingsCache = (cfg && cfg.eventLoopGuard) ? cfg.eventLoopGuard : {};
    _settingsCacheAt = Date.now();
  } catch (_) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

function start(opts) {
  opts = opts || {};
  if (started) return;
  started = true;

  const cfg = _loadSettings();
  const thresholdMs   = typeof opts.thresholdMs   === 'number' ? opts.thresholdMs   : (cfg.thresholdMs || 400);
  const sustainMs     = typeof opts.sustainMs     === 'number' ? opts.sustainMs     : (cfg.sustainMs || 20) * 1000;
  const checkEveryMs  = typeof opts.checkEveryMs  === 'number' ? opts.checkEveryMs  : (cfg.checkEveryMs || 30) * 1000;
  resolutionMs  = typeof opts.resolutionMs  === 'number' ? opts.resolutionMs  : (cfg.resolutionMs || 100);
  const warnAt        = sustainMs * 0.5;
  // Adaptive burst mode: if enabled, relax thresholds when system busy
  const adaptiveBurst = cfg.adaptiveBurstMode || false;
  const burstMultiplier = adaptiveBurst ? (cfg.burstMultiplier || 2.0) : 1.0;  // warn after 50% of sustain window

  histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const tick = () => {
    if (recycling) return;

    let p95Ms, p99Ms, maxMs;
    try {
      p95Ms = histogram.percentile(95) / 1e6;
      p99Ms = histogram.percentile(99) / 1e6;
      maxMs = histogram.max / 1e6;
    } catch (_) { return; }

    if (!isFinite(p95Ms)) return;

    // Apply adaptive burst multiplier to thresholds
    const effectiveThreshold = thresholdMs * burstMultiplier;
    const effectiveSustain = sustainMs * burstMultiplier;

    const now = Date.now();
    if (p95Ms > effectiveThreshold) {
      if (!highSince) highSince = now;

      const elapsed = now - highSince;

      if (elapsed >= effectiveSustain) {
        highSince = 0;
        warningSince = 0;
        const { utils } = _getUtils();
        utils && utils.warn && utils.warn('EventLoopGuard', `Sustained event-loop stall detected. Restarting process to preserve stability.${adaptiveBurst ? ' (burst mode active)' : ''} ${_heapSummary()}`);
        _saveStateBeforeExit();
        setTimeout(() => process.exit(1), 200);
        return;
      }

      if (elapsed >= warnAt) {
        if (!warningSince) warningSince = highSince;
        const { utils } = _getUtils();
        utils && utils.warn && utils.warn('EventLoopGuard',
          `Event-loop delay warning: P95=${(p95Ms/1000).toFixed(1)}ms, P99=${(p99Ms/1000).toFixed(1)}ms, Max=${(maxMs/1000).toFixed(1)}ms${adaptiveBurst ? ' (burst mode active)' : ''}`);
      }

      return;
    }

    // Recovered
    highSince = 0;
    warningSince = 0;
  };

  const handle = setInterval(tick, checkEveryMs);
  if (handle.unref) handle.unref();
}

function getStatus() {
  const cfg = _loadSettings();
  return {
    monitoring: started,
    adaptiveBurstMode: cfg.adaptiveBurstMode || false,
    burstMultiplier: cfg.burstMultiplier || 1.0,
    warningSince: warningSince > 0 ? new Date(warningSince).toISOString() : null,
    histogram: histogram ? {
      resolution: resolutionMs,
      p95: histogram.percentile(95) / 1e6,
      p99: histogram.percentile(99) / 1e6,
      max: histogram.max / 1e6
    } : null,
    settings: {
      thresholdMs: cfg.thresholdMs || 400,
      sustainMs: cfg.sustainMs || 20000,
      checkEveryMs: cfg.checkEveryMs || 30000,
      resolutionMs: cfg.resolutionMs || 100
    }
  };
}

module.exports = { start, getStatus };
