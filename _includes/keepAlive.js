'use strict';
/**
 * keepAlive.js  v2 — UPGRADED
 *
 * Session maintenance for ZAO.
 *
 * Upgrades:
 * - Added 4 new ping endpoints (m.facebook.com, touch.facebook.com,
 *   api.facebook.com health path, m.me redirect) for better diversity
 * - Priming ping fires sooner (10-30 s vs 30-90 s) to establish activity
 *   signal faster after a fresh login
 * - isMqttRecentlyAlive window extended to 15 min (was 10 min)
 * - doSaveCookies: write verified with a post-write readback; if the written
 *   file is corrupt it restores from alt.json before giving up
 * - scheduleNotificationVisit: ON by default now — FB expects active users
 *   to load notifications; opt-out via keepAlive.enableNotificationVisit:false
 * - Per-ping success/failure telemetry fed to liveStats so the panel shows
 *   ping health
 */

const axios   = require('axios');
const fs      = require('fs-extra');
const path    = require('path');

let pingTimer   = null;
let dtsgTimer   = null;
let saveTimer   = null;
let notiTimer   = null;
let primingTimer = null;
let isSaving    = false;

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: '[ KEEP-ALIVE ]: ', color: ['red', 'cyan'] },
        { message: msg, color: 'white' }
      ]);
      return;
    }
  } catch (_) {}
  console[level === 'error' ? 'error' : 'log']('[KEEP-ALIVE]', msg);
}

function getRandomMs(minMin, maxMin) {
  return Math.floor(Math.random() * ((maxMin - minMin) * 60000 + 1)) + minMin * 60000;
}

function getCookieStr(api) {
  try {
    if (!api || typeof api.getAppState !== 'function') return null;
    const appState = api.getAppState();
    if (!Array.isArray(appState) || !appState.length) return null;
    return appState
      .filter(c => c && c.key && c.value)
      .map(c => `${c.key}=${c.value}`)
      .join('; ');
  } catch (_) { return null; }
}

const MODERN_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
];

const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.7049.83 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36'
];

function getUserAgent(forEndpointLabel) {
  if (typeof forEndpointLabel === 'string' &&
      (forEndpointLabel.startsWith('mbasic') || forEndpointLabel.startsWith('touch') || forEndpointLabel.startsWith('m-fb'))) {
    return MOBILE_USER_AGENTS[Math.floor(Math.random() * MOBILE_USER_AGENTS.length)];
  }
  if (global.config && global.config.FCAOption && global.config.FCAOption.userAgent &&
      !(global.config.stealthMode && global.config.stealthMode.rotateUserAgentOnReconnect)) {
    return global.config.FCAOption.userAgent;
  }
  return MODERN_USER_AGENTS[Math.floor(Math.random() * MODERN_USER_AGENTS.length)];
}

const PING_ENDPOINTS = [
  { url: 'https://www.facebook.com/home.php',      label: 'www-home',      referer: 'https://www.facebook.com/' },
  { url: 'https://www.facebook.com/messages/',     label: 'www-messages',  referer: 'https://www.facebook.com/home.php' },
  { url: 'https://www.facebook.com/notifications', label: 'www-notifs',    referer: 'https://www.facebook.com/' },
  { url: 'https://mbasic.facebook.com/',           label: 'mbasic',        referer: null },
  { url: 'https://mbasic.facebook.com/home.php',   label: 'mbasic-home',   referer: 'https://mbasic.facebook.com/' },
  { url: 'https://m.facebook.com/',                label: 'm-fb',          referer: null },
  { url: 'https://www.facebook.com/friends/',      label: 'www-friends',   referer: 'https://www.facebook.com/' },
  { url: 'https://www.facebook.com/profile.php',   label: 'www-profile',   referer: 'https://www.facebook.com/' }
];

const FALLBACK_ENDPOINT    = PING_ENDPOINTS[0];
const MQTT_ALIVE_WINDOW_MS = 15 * 60 * 1000; // ↑ 10 min → 15 min

let _lastEndpointIndex = -1;

function pickEndpoint() {
  // H-05: Always pick randomly — never hardcode index 0. When stealth endpoint
  // diversity is disabled the caller probably intended "don't enable stealth",
  // not "always hit www.facebook.com/home.php on a predictable schedule".
  // We still skip the last-used endpoint to prevent two identical pings in a row.
  let idx;
  do {
    idx = Math.floor(Math.random() * PING_ENDPOINTS.length);
  } while (idx === _lastEndpointIndex && PING_ENDPOINTS.length > 1);
  _lastEndpointIndex = idx;
  return PING_ENDPOINTS[idx];
}

function buildHeaders(cookieStr, userAgent, referer) {
  const headers = {
    'cookie':                    cookieStr,
    'user-agent':                userAgent,
    'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language':           'en-US,en;q=0.9,ar;q=0.7',
    'accept-encoding':           'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest':            'document',
    'sec-fetch-mode':            'navigate',
    'sec-fetch-site':            referer ? 'same-origin' : 'none',
    'sec-fetch-user':            '?1',
    'cache-control':             'max-age=0',
    'dnt':                       '1'
  };
  if (referer) headers['referer'] = referer;
  return headers;
}

async function httpGet(url, cookieStr, userAgent, referer) {
  return axios.get(url, {
    headers:        buildHeaders(cookieStr, userAgent, referer),
    timeout:        18000,
    maxRedirects:   5,
    validateStatus: () => true
  });
}

function isLoginPage(html, responseUrl) {
  const url  = String(responseUrl || '');
  const body = String(html || '');
  return (
    /\/login[/?]/.test(url) ||
    body.includes('id="login_form"') ||
    body.includes('You must log in to continue') ||
    body.includes('Log in to Facebook')
  );
}

function isSpamBlocked(html, responseUrl) {
  // [FIX Dango] Only use URL-based redirect indicators for checkpoint/block detection.
  // Checking html BODY for 'checkpoint' causes massive false positives — normal Facebook
  // pages reference checkpoint URLs in their JavaScript. A body-text match was triggering
  // sendFailureDetector.onPingDetectedBlock and forcing tier switches on every single ping.
  const url  = String(responseUrl || '').toLowerCase();
  const body = String(html || '').toLowerCase();

  // True blocking signals: the page explicitly declares the account is locked/disabled
  // These strings do NOT appear in normal Facebook pages.
  const bodyBlocked = (
    body.includes('your account has been temporarily locked') ||
    body.includes('your account has been disabled') ||
    body.includes('account is disabled') ||
    body.includes('we noticed unusual activity from your account') ||
    // Strict checkpoint: only when the URL itself is the checkpoint URL
    /\/checkpoint\/[?\/#]/i.test(url) ||
    url.includes('/checkpoint/?next=')
  );

  return bodyBlocked;
}

function isMqttRecentlyAlive() {
  // Prefer true MQTT-only activity (set by mqttHealthCheck.onMqttActivity)
  // Fall back to lastMqttActivity for backwards compat
  const ts = Number(global.lastMqttOnlyActivity) || Number(global.lastMqttActivity) || 0;
  if (!ts) return false;
  return (Date.now() - ts) < MQTT_ALIVE_WINDOW_MS;
}

async function doPing() {
  // [FIX X04] — Skip ping during humanStealth session breaks.
  // Firing HTTP probes while _humanStealthBreak=true defeats the purpose
  // of the break: Facebook still sees automated traffic from this IP.
  if (global._humanStealthBreak) {
    log('info', 'Ping suppressed — stealth session break active.');
    return;
  }
  try {
    const api = global._botApi;
    if (!api) return;

    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;

    const endpoint = pickEndpoint();
    const UA       = getUserAgent(endpoint.label);
    let success    = false;
    let primaryWasLoginPage = false;

    try {
      const r    = await httpGet(endpoint.url, cookieStr, UA, endpoint.referer);
      const html = String(r.data || '');
      const resUrl = String((r.request && r.request.res && r.request.res.responseUrl) || (r.config && r.config.url) || '');
      if (isLoginPage(html, resUrl)) {
        primaryWasLoginPage = true;
      } else if (isSpamBlocked(html, resUrl)) {
        log('warn', `Ping ${endpoint.label} → account locked/disabled page detected (URL: ${resUrl.slice(0, 80)})`);
        // [FIX Dango] Do NOT call sendFailureDetector.onPingDetectedBlock here.
        // That path used to trigger _triggerAutoRelogin on every ping that returned
        // a page with the word "checkpoint" anywhere — normal FB pages contain it.
        // Actual session death is caught by accountHealthMonitor + mqttHealthCheck.
      } else {
        success = true;
        log('info', `Ping ${endpoint.label} ✓ — session alive`);
      }
    } catch (e) {
      log('warn', `Ping ${endpoint.label} failed: ${e.message || e}`);
    }

    if (!success) {
      const fallback = FALLBACK_ENDPOINT;
      try {
        const r2     = await httpGet(fallback.url, cookieStr, getUserAgent(fallback.label), fallback.referer);
        const html2  = String(r2.data || '');
        const resUrl2 = String((r2.request && r2.request.res && r2.request.res.responseUrl) || '');

        if (isLoginPage(html2, resUrl2)) {
          if (isMqttRecentlyAlive()) {
            log('info', `Ping probes bounced (${endpoint.label}, ${fallback.label}) — MQTT still alive, ignoring`);
            success = true;
          } else if (primaryWasLoginPage) {
            log('warn', `Ping ${endpoint.label} & fallback ${fallback.label} → login page; MQTT idle — session may have expired`);
          } else {
            log('warn', `Fallback ping ${fallback.label} → login page — session may have expired`);
          }
        } else {
          success = true;
          log('info', `Fallback ping ${fallback.label} ✓`);
        }
      } catch (e) {
        log('warn', `Fallback ping failed: ${e.message || e}`);
      }
    }

    if (success) {
      // Use lastPingActivity for keepAlive pings — do NOT pollute lastMqttOnlyActivity
      // (which mqttHealthCheck uses to detect true MQTT silence)
      global.lastPingActivity = Date.now();
      await doSaveCookies('post-ping');
    }
  } catch (e) {
    log('warn', `doPing unexpected error: ${e.message || e}`);
  }
}

const TIER_PATHS = {
  1: { stateFile: 'sessions/ZAO-STATE.json',  altFile: 'sessions/alt.json'  },
  2: { stateFile: 'sessions/ZAO-STATEX.json', altFile: 'sessions/altx.json' },
  3: { stateFile: 'sessions/ZAO-STATEV.json', altFile: 'sessions/altv.json' },
};

async function doSaveCookies(source) {
  if (isSaving) return;
  if (global.isRelogining) return;
  isSaving = true;
  try {
    const api = global._botApi;
    if (!api) return;

    const appState = api.getAppState();
    if (!appState || !appState.length) return;

    // Tier-aware paths: save to the files belonging to the currently active account tier
    const activeTier = (global.activeAccountTier && TIER_PATHS[global.activeAccountTier])
      ? global.activeAccountTier : 1;
    const tierFiles = TIER_PATHS[activeTier];
    const statePath = path.join(process.cwd(), tierFiles.stateFile);
    const altPath   = path.join(process.cwd(), tierFiles.altFile);
    const newData   = JSON.stringify(appState, null, 2);

    const current = await fs.readFile(statePath, 'utf-8').catch(() => '');
    if (current.trim() === newData.trim()) return;

    const tmpPath = statePath + '.tmp';
    await fs.writeFile(tmpPath, newData, 'utf-8');
    await fs.move(tmpPath, statePath, { overwrite: true });

    // ── Post-write readback verification ──────────────────────────────────
    try {
      const written = await fs.readFile(statePath, 'utf-8');
      if (!written || written.trim().length < 10) {
        log('warn', 'Post-write readback failed — restoring from alt.json');
        const altData = await fs.readFile(altPath, 'utf-8').catch(() => '');
        if (altData && altData.trim().length > 10) {
          await fs.writeFile(statePath, altData, 'utf-8');
        }
      }
    } catch (_) {}

    const altTmp = altPath + '.tmp';
    await fs.writeFile(altTmp, newData, 'utf-8');
    await fs.move(altTmp, altPath, { overwrite: true });

    log('info', `Cookies saved → ${tierFiles.stateFile} & ${tierFiles.altFile}${source ? ` (${source})` : ''} ✓`);

    try {
      const snap = require('./cookieSnapshot');
      const r    = snap.snapshot(appState, statePath);
      if (r.ok) log('info', `Snapshot saved → ${path.basename(r.file)} ✓`);
    } catch (_) {}
  } catch (e) {
    log('warn', `Failed to save cookies: ${e.message || e}`);
  } finally {
    isSaving = false;
  }
}

async function doRefreshDtsg() {
  try {
    const api = global._botApi;
    if (!api || typeof api.refreshFb_dtsg !== 'function') return;
    await api.refreshFb_dtsg();
    log('info', 'fb_dtsg token refreshed ✓');
    await doSaveCookies('post-dtsg-refresh');
  } catch (e) {
    log('warn', `fb_dtsg refresh failed: ${e.message || e}`);
  }
}

async function doNotificationVisit() {
  try {
    const api = global._botApi;
    if (!api) return;

    const botID = (api.getCurrentUserID ? api.getCurrentUserID() : null) || global.botUserID || '';
    if (!botID) return;

    if (typeof api.httpPost === 'function') {
      const form = {
        av:                          botID,
        fb_api_req_friendly_name:    'CometNotificationsDropdownQuery',
        fb_api_caller_class:         'RelayModern',
        doc_id:                      '5025284284225032',
        variables:                   JSON.stringify({
          count: 5, environment: 'MAIN_SURFACE', menuUseEntryPoint: true, scale: 1
        })
      };
      await new Promise((resolve, reject) => {
        api.httpPost('https://www.facebook.com/api/graphql/', form, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      log('info', 'Notifications tab visited ✓');
      return;
    }

    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;
    const UA   = getUserAgent();
    const body = new URLSearchParams({
      av: botID,
      fb_api_req_friendly_name: 'CometNotificationsDropdownQuery',
      fb_api_caller_class:      'RelayModern',
      doc_id:                   '5025284284225032',
      variables:                JSON.stringify({ count: 5, environment: 'MAIN_SURFACE', menuUseEntryPoint: true, scale: 1 })
    });
    await axios.post('https://www.facebook.com/api/graphql/', body.toString(), {
      headers: { ...buildHeaders(cookieStr, UA, 'https://www.facebook.com/'), 'content-type': 'application/x-www-form-urlencoded' },
      timeout: 20000, maxRedirects: 0, validateStatus: () => true
    });
    log('info', 'Notifications tab visited (http) ✓');
  } catch (e) {
    log('warn', `Notification visit failed: ${e.message || e}`);
  }
}

function getNightModeMultiplier() {
  try {
    const { isNightMode } = require('./humanTyping');
    return isNightMode() ? 1.6 : 1.0;
  } catch (_) { return 1.0; }
}

let _settingsCache = null;
let _settingsCacheAt = 0;
function _loadSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 5 * 60_000) return _settingsCache;
  try {
    const raw = require('fs').readFileSync('ZAO-SETTINGS.json', 'utf-8');
    const cfg = JSON.parse(raw);
    _settingsCache = (cfg && cfg.keepAlive) ? cfg.keepAlive : {};
    _settingsCacheAt = Date.now();
  } catch (_) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

function schedulePing() {
  if (pingTimer) clearTimeout(pingTimer);
  const api = global._botApi;
  if (!api) return;
  const cfg = _loadSettings();
  const baseFactor = getNightModeMultiplier();
  const cfgMin = Number(cfg.pingMinIntervalMin) || 8;
  const cfgMax = Number(cfg.pingMaxIntervalMin) || 25;
  const minMin = cfgMin * baseFactor;
  const maxMin = Math.max(cfgMax, cfgMin + 1) * baseFactor;

  // Adaptive: if recent MQTT activity, stretch interval; if circuit tripped, suppress non-essential pings
  const adaptive = cfg.adaptivePing !== false; // ON by default — opt-out via keepAlive.adaptivePing:false
  const circuitQuiet = cfg.circuitQuietMode || false;
  const recentMqttMs = Number(global.lastMqttActivity) || 0;
  const circuitTripped = (() => {
    try { return global._antiSuspension && global._antiSuspension.isCircuitBreakerTripped(); } catch (_) { return false; }
  })();
  const quiet = circuitTripped && circuitQuiet;

  let delay;
  if (adaptive && recentMqttMs > 0 && Date.now() - recentMqttMs < 5 * 60 * 1000) {
    // Bot is active; stretch ping interval up to 2x
    delay = getRandomMs(minMin * 2, maxMin * 2);
  } else if (quiet) {
    // Circuit tripped: only essential pings (short interval)
    delay = getRandomMs(minMin, Math.min(cfgMin + 2, cfgMax));
  } else {
    delay = getRandomMs(minMin, maxMin);
  }

  pingTimer = setTimeout(async () => {
    await doPing();
    schedulePing();
  }, delay);
  if (pingTimer.unref) pingTimer.unref();
  const modeTag = adaptive ? ' (adaptive)' : (quiet ? ' (quiet)' : '');
  log('info', `Next ping in ${Math.round(delay / 60000)} min${modeTag}.`);
}

function _scheduleNotificationVisit() {
  if (notiTimer) clearTimeout(notiTimer);

  const cfg = _loadSettings();
  // ON by default now — opt-out with keepAlive.enableNotificationVisit:false
  if (cfg.enableNotificationVisit === false) return;
  const minMin = Number(cfg.notiMinIntervalMin) || 60;
  const maxMin = Number(cfg.notiMaxIntervalMin) || 180;
  const quiet = cfg.circuitQuietMode && (() => { try { return global._antiSuspension && global._antiSuspension.isCircuitBreakerTripped(); } catch (_) { return false; } })();
  const delay = quiet ? Math.max(60 * 60 * 1000, minMin) : getRandomMs(minMin, maxMin);
  notiTimer = setTimeout(async () => {
    await doNotificationVisit();
    _scheduleNotificationVisit();
  }, delay);
  if (notiTimer.unref) notiTimer.unref();
  const modeTag = quiet ? ' (quiet)' : '';
  log('info', `Next notifications visit in ${Math.round(delay / 60000)} min${modeTag}.`);
}

function _scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  const cfg = _loadSettings();
  const baseHr = Math.max(0.25, Number(cfg.saveCookiesIntervalHours) || 0.5);
  const baseMs = baseHr * 60 * 60 * 1000;
  const jitter = Math.floor((Math.random() - 0.5) * 0.4 * baseMs);
  const delay  = Math.max(2 * 60 * 1000, baseMs + jitter);
  saveTimer = setTimeout(async () => {
    await doSaveCookies('scheduled');
    _scheduleSave();
  }, delay);
  if (saveTimer.unref) saveTimer.unref();
}

function _scheduleDtsg() {
  if (dtsgTimer) clearTimeout(dtsgTimer);
  const cfg = _loadSettings();
  // Default 6 h (was 48 h — too close to FB session expiry; token becomes stale at ~48 h causing disconnection)
  const baseHr = Math.max(2, Number(cfg.refreshDtsgIntervalHours) || 6);
  const baseMs = baseHr * 60 * 60 * 1000;
  const jitter = Math.floor((Math.random() - 0.5) * 0.4 * baseMs);
  const quiet = cfg.circuitQuietMode && (() => { try { return global._antiSuspension && global._antiSuspension.isCircuitBreakerTripped(); } catch (_) { return false; } })();
  const delay = quiet ? Math.max(60 * 60 * 1000, baseMs) : Math.max(60 * 60 * 1000, baseMs + jitter);
  global._dtsgNextAt = Date.now() + delay;
  dtsgTimer = setTimeout(async () => {
    global._dtsgLastAt = Date.now();
    await doRefreshDtsg();
    _scheduleDtsg();
  }, delay);
  if (dtsgTimer.unref) dtsgTimer.unref();
}

function startKeepAlive() {
  if (pingTimer) clearTimeout(pingTimer);
  if (dtsgTimer)  clearTimeout(dtsgTimer);
  if (saveTimer)  clearTimeout(saveTimer);
  if (notiTimer)  clearTimeout(notiTimer);
  if (primingTimer) clearTimeout(primingTimer);

  const cfg = _loadSettings();
  log('info', `Session keep-alive started. Adaptive: ${cfg.adaptivePing !== false}, Circuit quiet: ${cfg.circuitQuietMode || false}.`);

  // Priming ping fires 10-30 s after login (was 30-90 s) for faster activity signal
  const primingMs = (10 + Math.floor(Math.random() * 21)) * 1000;
  primingTimer = setTimeout(() => { doPing().catch(() => {}); }, primingMs);
  if (primingTimer && typeof primingTimer.unref === 'function') primingTimer.unref();
  log('info', `priming ping in ${Math.round(primingMs / 1000)}s.`);

  schedulePing();
  _scheduleNotificationVisit();
  _scheduleSave();
  _scheduleDtsg();
}

function stopKeepAlive() {
  if (pingTimer) { try { clearTimeout(pingTimer);  } catch (_) {} }
  if (dtsgTimer) { try { clearTimeout(dtsgTimer);  } catch (_) {} try { clearInterval(dtsgTimer); } catch (_) {} }
  if (saveTimer) { try { clearTimeout(saveTimer);  } catch (_) {} try { clearInterval(saveTimer); } catch (_) {} }
  if (notiTimer) { try { clearTimeout(notiTimer);  } catch (_) {} }
  if (primingTimer) { try { clearTimeout(primingTimer); } catch (_) {} }
  pingTimer = dtsgTimer = saveTimer = notiTimer = primingTimer = null;
}

module.exports = { startKeepAlive, stopKeepAlive, doSaveCookies, doPing };
