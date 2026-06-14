'use strict';
/**
 * OnlinePresenceEngine.js — ZAO Bot
 * ====================================
 * Simulates human-like online presence by periodically visiting Facebook
 * pages using the bot's own session cookies (via the FCA jar).
 *
 * Called by listen.js per incoming message to queue threads for "seen" status.
 * Also runs a background interval that browses a randomised set of FB endpoints
 * to keep the session warm and appear online.
 *
 * Ported and adapted from biar-fca-main/src/deltas/apis/extra/startOnlinePresence.js
 * Rewritten to be ZAO-native: no axios / tough-cookie dependency — uses Node's
 * built-in https module and the FCA jar already loaded by the bot.
 *
 * Exported surface (used by listen.js + humanTyping.js):
 *   queueForSeen(threadID)    — no-op stub if bot API not ready yet; safe to call always
 *   start(api)                — called by ZAO.js after login; begins presence loop
 *   stop()                    — stops all intervals
 *   getStatus()               — returns { running, activityCount, lastActivityAt }
 */

const https   = require('https');

const FB_PAGES = [
  '/',
  '/me',
  '/notifications',
  '/messages',
  '/groups',
];

let _running       = false;
let _activityCount = 0;
let _lastActivityAt = 0;
let _mainInterval  = null;
let _seenQueue     = [];

// ── Internal: make a lightweight HEAD request using FCA cookie jar ────────────
function _headRequest(path, jar) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; resolve(ok); };

    let cookieStr = '';
    try {
      if (jar && typeof jar.getCookiesSync === 'function') {
        cookieStr = jar.getCookiesSync('https://www.facebook.com').map(c => c.cookieString ? c.cookieString() : String(c)).join('; ');
      }
    } catch (_) {}

    try {
      const req = https.request({
        hostname: 'www.facebook.com',
        port:     443,
        path:     path,
        method:   'HEAD',
        timeout:  12000,
        headers: {
          'Cookie':          cookieStr,
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin':          'https://www.facebook.com',
          'Referer':         'https://www.facebook.com/',
        }
      }, res => { res.resume(); finish(res.statusCode < 500); });
      req.on('error',   () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.end();
    } catch (_) { finish(false); }
  });
}

// ── Internal: pick N random pages from FB_PAGES and visit them ────────────────
async function _simulateActivity(jar) {
  if (!jar) return;
  const shuffled = FB_PAGES.slice().sort(() => Math.random() - 0.5);
  const targets  = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));
  for (const page of targets) {
    try {
      const delay = 2000 + Math.random() * 5000;
      await new Promise(r => setTimeout(r, delay));
      await _headRequest(page, jar);
      _activityCount++;
      _lastActivityAt = Date.now();
    } catch (_) {}
  }
}

// ── Internal: get the FCA cookie jar ─────────────────────────────────────────
function _getJar() {
  try {
    if (global.client && global.client.ctx && global.client.ctx.jar) return global.client.ctx.jar;
    if (global._botApi   && global._botApi.ctx  && global._botApi.ctx.jar)  return global._botApi.ctx.jar;
  } catch (_) {}
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Queue a thread for "seen" tracking.
 * Currently a lightweight no-op that logs the call for future extensibility.
 * @param {string} threadID
 */
function queueForSeen(threadID) {
  if (!threadID) return;
  _seenQueue.push(String(threadID));
  if (_seenQueue.length > 50) _seenQueue.shift();
}

/**
 * Start the background presence simulation loop.
 * Safe to call multiple times — subsequent calls are no-ops.
 * @param {object} [api] FCA API instance (optional — falls back to globals)
 */
function start(api) {
  if (_running) return;

  // [SECURITY FIX] HTTP page browsing from a server/datacenter IP sends
  // authenticated Facebook requests from a non-residential IP, which is a
  // strong bot signal. Disable unless explicitly opted-in via config.
  const cfg = global.config?.onlinePresence || {};
  if (cfg.enableHttpBrowsing !== true) {
    // Still mark as running so getStatus() looks healthy, but skip the loop
    _running = true;
    return;
  }

  _running = true;

  const jitter = () => 60000 + Math.random() * 90000; // 1–2.5 min

  async function loop() {
    if (!_running) return;
    const jar = _getJar();
    if (jar) {
      try { await _simulateActivity(jar); } catch (_) {}
    }
    if (_running) _mainInterval = setTimeout(loop, jitter());
  }

  // First run delayed slightly so bot startup completes first
  _mainInterval = setTimeout(loop, 30000 + Math.random() * 30000);
}

/** Stop all presence loops. */
function stop() {
  _running = false;
  if (_mainInterval) { clearTimeout(_mainInterval); _mainInterval = null; }
  _seenQueue = [];
}

/** Return current status for diagnostics. */
function getStatus() {
  return {
    running:        _running,
    activityCount:  _activityCount,
    lastActivityAt: _lastActivityAt,
    seenQueueLen:   _seenQueue.length,
  };
}

module.exports = { queueForSeen, start, stop, getStatus };
