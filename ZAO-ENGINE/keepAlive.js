"use strict";
/**
 * ZAO-ENGINE — Keep-Alive v1.9
 *
 * Merged best of v1.3 and v1.8:
 *  - isMqttRecentlyAlive() with 15-min window → adaptive ping (stretches when MQTT alive)
 *  - Full browser fingerprinting headers (sec-fetch-*, sec-ch-ua, cache-control, dnt)
 *  - Desktop + mobile UA pool (17 total)
 *  - 8 diverse ping endpoints
 *  - Fallback ping to home.php when primary fails
 *  - isSpamBlocked() — URL-only checkpoint detection (avoids false positives)
 *  - Post-write readback verification after saving cookies
 *  - httpPost fallback for notification visit (api.httpPost first, then axios)
 *  - Configurable ping intervals via ZAO-SETTINGS.json keepAlive section
 *  - Night mode multiplier (stretches all intervals at night)
 *  - AI-seeded randomizer when available; Math.random() fallback
 *  - 6–8 h dtsg refresh (NOT 48 h — that matched FB expiry and was a known bug)
 *  - getTimers() export for panel diagnostics
 *  - No circuit-breaker/antiSuspension integration (intentionally removed — caused false tier switches)
 */

const axios      = require("axios");
const fs         = require("fs-extra");
const path       = require("path");
const randomizer = (() => {
  try { return require("./randomizer"); } catch (_) { return null; }
})();

let pingTimer    = null;
let dtsgTimer    = null;
let saveTimer    = null;
let notiTimer    = null;
let primingTimer = null;
let isSaving     = false;

let _nextPingAt  = null;
let _nextNotiAt  = null;
let _nextSaveAt  = null;

function log(level, msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ KEEP-ALIVE ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[KEEP-ALIVE]", msg);
}

// Use AI-seeded randomizer when available; falls back to Math.random()
function getRandomMs(minMin, maxMin) {
  if (randomizer && typeof randomizer.getIntervalSync === "function") {
    return randomizer.getIntervalSync(minMin * 60000, maxMin * 60000);
  }
  return Math.floor(Math.random() * ((maxMin - minMin) * 60000 + 1)) + minMin * 60000;
}

function getCookieStr(api) {
  try {
    if (!api || typeof api.getAppState !== "function") return null;
    const s = api.getAppState();
    if (!Array.isArray(s) || !s.length) return null;
    return s.filter(c => c && c.key && c.value).map(c => `${c.key}=${c.value}`).join("; ");
  } catch (_) { return null; }
}

// ─── User-Agent Pools ───────────────────────────────────────────────────────

const DESKTOP_UA = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];

const MOBILE_UA = [
  "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.7049.83 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Redmi Note 13 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.135 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/492.0.0.38.109;]",
];

function getUserAgent(endpointLabel) {
  const isMobileEp = typeof endpointLabel === "string" &&
    (endpointLabel.startsWith("mbasic") || endpointLabel.startsWith("m-fb") || endpointLabel.startsWith("touch"));
  const pool = isMobileEp ? MOBILE_UA : (Math.random() < 0.45 ? MOBILE_UA : DESKTOP_UA);
  if (randomizer && typeof randomizer.getIntervalSync === "function") {
    return pool[randomizer.getIntervalSync(0, pool.length - 1)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Ping Endpoints (8 — diverse) ──────────────────────────────────────────

const PING_ENDPOINTS = [
  { url: "https://www.facebook.com/home.php",      label: "www-home",     referer: "https://www.facebook.com/" },
  { url: "https://www.facebook.com/messages/",     label: "www-messages", referer: "https://www.facebook.com/home.php" },
  { url: "https://www.facebook.com/notifications", label: "www-notifs",   referer: "https://www.facebook.com/" },
  { url: "https://mbasic.facebook.com/",           label: "mbasic",       referer: null },
  { url: "https://mbasic.facebook.com/home.php",   label: "mbasic-home",  referer: "https://mbasic.facebook.com/" },
  { url: "https://m.facebook.com/",                label: "m-fb",         referer: null },
  { url: "https://www.facebook.com/friends/",      label: "www-friends",  referer: "https://www.facebook.com/" },
  { url: "https://www.facebook.com/profile.php",   label: "www-profile",  referer: "https://www.facebook.com/" },
];

const FALLBACK_ENDPOINT = PING_ENDPOINTS[0]; // home.php — always reliable
const MQTT_ALIVE_WINDOW_MS = 15 * 60 * 1000; // 15-min window (1.3 upgrade from 10 min)

let _lastEpIdx = -1;
function pickEndpoint() {
  let idx;
  do {
    idx = (randomizer && typeof randomizer.getIntervalSync === "function")
      ? randomizer.getIntervalSync(0, PING_ENDPOINTS.length - 1)
      : Math.floor(Math.random() * PING_ENDPOINTS.length);
  } while (idx === _lastEpIdx && PING_ENDPOINTS.length > 1);
  _lastEpIdx = idx;
  return PING_ENDPOINTS[idx];
}

// ─── Full browser fingerprinting headers (merged from 1.3) ─────────────────

function buildHeaders(cookieStr, ua, referer) {
  const isChrome  = ua.includes("Chrome") && !ua.includes("FB_IAB");
  const isSafari  = ua.includes("Safari") && !ua.includes("Chrome");
  const isFbApp   = ua.includes("FB_IAB");
  const isMobile  = ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone") || ua.includes("iPad");
  const chromeVer = (ua.match(/Chrome\/(\d+)/) || [])[1] || "124";

  const h = {
    "cookie":                    cookieStr,
    "user-agent":                ua,
    "accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language":           "ar,en-US;q=0.9,en;q=0.8",
    "accept-encoding":           "gzip, deflate, br",
    "cache-control":             Math.random() < 0.5 ? "max-age=0" : "no-cache",
    "upgrade-insecure-requests": "1",
    "connection":                "keep-alive",
  };

  if (referer) {
    h["referer"]        = referer;
    h["sec-fetch-site"] = "same-origin";
  } else {
    h["sec-fetch-site"] = Math.random() < 0.7 ? "none" : "same-origin";
  }

  if (isChrome || isFbApp) {
    h["sec-fetch-mode"] = "navigate";
    h["sec-fetch-dest"] = "document";
    h["sec-fetch-user"] = "?1";
    h["sec-ch-ua"]          = `"Chromium";v="${chromeVer}", "Not:A-Brand";v="99", "Google Chrome";v="${chromeVer}"`;
    h["sec-ch-ua-mobile"]   = isMobile ? "?1" : "?0";
    h["sec-ch-ua-platform"] = isMobile ? '"Android"' : '"Windows"';
  } else if (isSafari) {
    if (Math.random() < 0.6) {
      h["sec-fetch-mode"] = "navigate";
      h["sec-fetch-dest"] = "document";
    }
  }

  if (Math.random() < 0.4) h["dnt"] = "1";
  return h;
}

// ─── Detection helpers ──────────────────────────────────────────────────────

function isLoginPage(html, responseUrl) {
  const url  = String(responseUrl || "");
  const body = String(html || "");
  return (
    /\/login[/?]/.test(url) ||
    body.includes('id="login_form"') ||
    body.includes("You must log in") ||
    body.includes("Log in to Facebook")
  );
}

function isSpamBlocked(html, responseUrl) {
  // URL-only checkpoint detection — avoids false positives from JS refs in normal pages
  const url  = String(responseUrl || "").toLowerCase();
  const body = String(html || "").toLowerCase();
  return (
    body.includes("your account has been temporarily locked") ||
    body.includes("your account has been disabled") ||
    body.includes("account is disabled") ||
    body.includes("we noticed unusual activity from your account") ||
    /\/checkpoint\/[?\/#]/i.test(url) ||
    url.includes("/checkpoint/?next=")
  );
}

function isMqttRecentlyAlive() {
  const ts = Number(global.lastMqttOnlyActivity) || Number(global.lastMqttActivity) || 0;
  if (!ts) return false;
  return (Date.now() - ts) < MQTT_ALIVE_WINDOW_MS;
}

// ─── Settings cache ─────────────────────────────────────────────────────────

let _settingsCache   = null;
let _settingsCacheAt = 0;
function _loadSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 5 * 60_000) return _settingsCache;
  try {
    const raw = require("fs").readFileSync("ZAO-SETTINGS.json", "utf-8");
    const cfg = JSON.parse(raw);
    _settingsCache   = (cfg && cfg.keepAlive) ? cfg.keepAlive : {};
    _settingsCacheAt = Date.now();
  } catch (_) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

function getNightModeMultiplier() {
  try {
    const { isNightMode } = require("./humanTyping");
    return isNightMode() ? 1.6 : 1.0;
  } catch (_) { return 1.0; }
}

// ─── Tier-aware cookie paths ────────────────────────────────────────────────

const TIER_PATHS = {
  1: { stateFile: "sessions/ZAO-STATE.json",  altFile: "sessions/alt.json"  },
  2: { stateFile: "sessions/ZAO-STATEX.json", altFile: "sessions/altx.json" },
  3: { stateFile: "sessions/ZAO-STATEV.json", altFile: "sessions/altv.json" },
};

// ─── Cookie save with readback verification ─────────────────────────────────

async function doSaveCookies(source) {
  if (isSaving || global.isRelogining) return;
  isSaving = true;
  try {
    const api = global._botApi;
    if (!api) return;
    const appState = api.getAppState();
    if (!appState || !appState.length) return;

    const activeTier = (global.activeAccountTier && TIER_PATHS[global.activeAccountTier])
      ? global.activeAccountTier : 1;
    const { stateFile, altFile } = TIER_PATHS[activeTier];
    const statePath = path.join(process.cwd(), stateFile);
    const altPath   = path.join(process.cwd(), altFile);
    const newData   = JSON.stringify(appState, null, 2);

    const current = await fs.readFile(statePath, "utf-8").catch(() => "");
    if (current.trim() === newData.trim()) return;

    // Atomic write via tmp → move
    const tmp = statePath + ".tmp";
    await fs.writeFile(tmp, newData, "utf-8");
    await fs.move(tmp, statePath, { overwrite: true });

    // Post-write readback verification (merged from 1.3)
    try {
      const written = await fs.readFile(statePath, "utf-8");
      if (!written || written.trim().length < 10) {
        log("warn", "Post-write readback failed — restoring from alt file");
        const altData = await fs.readFile(altPath, "utf-8").catch(() => "");
        if (altData && altData.trim().length > 10) {
          await fs.writeFile(statePath, altData, "utf-8");
        }
      }
    } catch (_) {}

    // Mirror to alt file
    const altTmp = altPath + ".tmp";
    await fs.writeFile(altTmp, newData, "utf-8");
    await fs.move(altTmp, altPath, { overwrite: true });

    log("info", `Cookies saved → ${stateFile}${source ? ` (${source})` : ""} ✓`);

    try {
      const snap = require("./cookieSnapshot");
      snap.snapshot(appState, statePath);
    } catch (_) {}
  } catch (e) {
    log("warn", `Failed to save cookies: ${e.message || e}`);
  } finally {
    isSaving = false;
  }
}

// ─── Ping with fallback ─────────────────────────────────────────────────────

async function doPing() {
  if (global._humanStealthBreak) {
    log("info", "Ping suppressed — stealth session break active.");
    return;
  }
  try {
    const api = global._botApi;
    if (!api) return;
    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;

    const ep       = pickEndpoint();
    const UA       = getUserAgent(ep.label);
    const headers  = buildHeaders(cookieStr, UA, ep.referer);

    let success             = false;
    let primaryWasLoginPage = false;

    try {
      const r    = await axios.get(ep.url, { headers, timeout: 18000, validateStatus: () => true, maxRedirects: 5 });
      const html = String(r.data || "");
      const resUrl = String(r.request?.res?.responseUrl || r.config?.url || ep.url);

      if (isLoginPage(html, resUrl)) {
        primaryWasLoginPage = true;
      } else if (isSpamBlocked(html, resUrl)) {
        log("warn", `Ping ${ep.label} → account locked page detected (URL: ${resUrl.slice(0, 80)})`);
      } else {
        success = true;
        log("info", `Ping ${ep.label} ✓`);
      }
    } catch (e) {
      log("warn", `Ping ${ep.label} failed: ${e.message || e}`);
    }

    // Fallback ping when primary fails
    if (!success) {
      const fb  = FALLBACK_ENDPOINT;
      const fbUA = getUserAgent(fb.label);
      try {
        const r2    = await axios.get(fb.url, {
          headers: buildHeaders(cookieStr, fbUA, fb.referer),
          timeout: 18000, validateStatus: () => true, maxRedirects: 5
        });
        const html2  = String(r2.data || "");
        const resUrl2 = String(r2.request?.res?.responseUrl || fb.url);

        if (isLoginPage(html2, resUrl2)) {
          if (isMqttRecentlyAlive()) {
            log("info", `Both pings got login page — MQTT still alive (${Math.round((Date.now() - (Number(global.lastMqttOnlyActivity) || Number(global.lastMqttActivity)))/1000)}s ago), ignoring`);
            success = true;
          } else if (primaryWasLoginPage) {
            log("warn", `Ping ${ep.label} & fallback ${fb.label} → login page; MQTT idle — session may have expired`);
          } else {
            log("warn", `Fallback ping ${fb.label} → login page — session may have expired`);
          }
        } else {
          success = true;
          log("info", `Fallback ping ${fb.label} ✓`);
        }
      } catch (e) {
        log("warn", `Fallback ping ${fb.label} failed: ${e.message || e}`);
      }
    }

    if (success) {
      global.lastPingActivity = Date.now();
      await doSaveCookies("post-ping");
    }
  } catch (e) {
    log("warn", `doPing unexpected error: ${e.message || e}`);
  }
}

// ─── dtsg refresh ───────────────────────────────────────────────────────────

async function doRefreshDtsg() {
  try {
    const api = global._botApi;
    if (!api || typeof api.refreshFb_dtsg !== "function") return;
    await api.refreshFb_dtsg();
    log("info", "fb_dtsg token refreshed ✓");
    await doSaveCookies("post-dtsg-refresh");
  } catch (e) {
    log("warn", `fb_dtsg refresh failed: ${e.message || e}`);
  }
}

// ─── Notification visit (httpPost first, then axios fallback) ───────────────

async function doNotificationVisit() {
  try {
    const api   = global._botApi;
    if (!api) return;
    const botID = api.getCurrentUserID?.() || global.botUserID || "";
    if (!botID) return;

    const graphqlPayload = {
      av:                       botID,
      fb_api_req_friendly_name: "CometNotificationsDropdownQuery",
      fb_api_caller_class:      "RelayModern",
      doc_id:                   "5025284284225032",
      variables:                JSON.stringify({ count: 5, environment: "MAIN_SURFACE", menuUseEntryPoint: true, scale: 1 }),
    };

    // Prefer api.httpPost (uses session cookies automatically, lower ban risk)
    if (typeof api.httpPost === "function") {
      await new Promise((resolve, reject) => {
        try { api.httpPost("https://www.facebook.com/api/graphql/", graphqlPayload, (err) => err ? reject(err) : resolve()); }
        catch (e) { reject(e); }
      });
      log("info", "Notifications tab visited ✓");
      return;
    }

    // Fallback: raw axios with cookie header
    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;
    const body = new URLSearchParams(graphqlPayload);
    await axios.post("https://www.facebook.com/api/graphql/", body.toString(), {
      headers: {
        ...buildHeaders(cookieStr, getUserAgent(), "https://www.facebook.com/"),
        "content-type": "application/x-www-form-urlencoded",
      },
      timeout: 20000, maxRedirects: 0, validateStatus: () => true,
    });
    log("info", "Notifications tab visited (http) ✓");
  } catch (e) {
    log("warn", `Notification visit failed: ${e.message || e}`);
  }
}

// ─── Schedulers ─────────────────────────────────────────────────────────────

function schedulePing() {
  if (pingTimer) clearTimeout(pingTimer);
  const api = global._botApi;
  if (!api) return;

  const cfg         = _loadSettings();
  const nightFactor = getNightModeMultiplier();
  const cfgMin      = Number(cfg.pingMinIntervalMin) || 8;
  const cfgMax      = Number(cfg.pingMaxIntervalMin) || 25;
  const minMin      = cfgMin * nightFactor;
  const maxMin      = Math.max(cfgMax, cfgMin + 1) * nightFactor;

  let delay;
  const recentMqttMs = Number(global.lastMqttActivity) || 0;
  const adaptive     = cfg.adaptivePing !== false; // ON by default
  if (adaptive && recentMqttMs > 0 && Date.now() - recentMqttMs < 5 * 60 * 1000) {
    // Bot is active — stretch ping interval up to 2× to avoid over-pinging
    delay = getRandomMs(minMin * 2, maxMin * 2);
    log("info", `Next ping in ${Math.round(delay / 60000)} min (adaptive — MQTT active).`);
  } else {
    delay = getRandomMs(minMin, maxMin);
    log("info", `Next ping in ${Math.round(delay / 60000)} min.`);
  }

  _nextPingAt = Date.now() + delay;
  pingTimer   = setTimeout(async () => {
    _nextPingAt = null;
    try { await doPing(); } catch (_) {}
    schedulePing();
  }, delay);
  if (pingTimer.unref) pingTimer.unref();
}

function scheduleNotificationVisit() {
  if (notiTimer) clearTimeout(notiTimer);

  const cfg    = _loadSettings();
  if (cfg.enableNotificationVisit === false) return;
  const minMin = Number(cfg.notiMinIntervalMin) || 60;
  const maxMin = Number(cfg.notiMaxIntervalMin) || 180;
  const delay  = getRandomMs(minMin, maxMin);
  _nextNotiAt  = Date.now() + delay;

  notiTimer = setTimeout(async () => {
    _nextNotiAt = null;
    try { await doNotificationVisit(); } catch (_) {}
    scheduleNotificationVisit();
  }, delay);
  if (notiTimer.unref) notiTimer.unref();
  log("info", `Next notifications visit in ${Math.round(delay / 60000)} min.`);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  const cfg     = _loadSettings();
  const baseHr  = Math.max(0.25, Number(cfg.saveCookiesIntervalHours) || 0.5);
  const baseMs  = baseHr * 60 * 60 * 1000;
  const jitter  = Math.floor((Math.random() - 0.5) * 0.4 * baseMs);
  const delay   = Math.max(2 * 60 * 1000, baseMs + jitter);
  _nextSaveAt   = Date.now() + delay;

  saveTimer = setTimeout(async () => {
    _nextSaveAt = null;
    try { await doSaveCookies("scheduled"); } catch (_) {}
    scheduleSave();
  }, delay);
  if (saveTimer.unref) saveTimer.unref();
}

function scheduleDtsg() {
  if (dtsgTimer) clearTimeout(dtsgTimer);
  // 6–8 h: keeps dtsg fresh without hitting FB's expiry window
  const delay = getRandomMs(360, 480);
  global._dtsgNextAt = Date.now() + delay;

  dtsgTimer = setTimeout(async () => {
    try { await doRefreshDtsg(); } catch (_) {}
    scheduleDtsg();
  }, delay);
  if (dtsgTimer.unref) dtsgTimer.unref();
}

// ─── Public API ─────────────────────────────────────────────────────────────

function startKeepAlive() {
  [pingTimer, dtsgTimer, saveTimer, notiTimer, primingTimer].forEach(t => {
    if (t) { try { clearTimeout(t); } catch (_) {} try { clearInterval(t); } catch (_) {} }
  });
  pingTimer = dtsgTimer = saveTimer = notiTimer = primingTimer = null;
  _nextPingAt = _nextNotiAt = _nextSaveAt = null;

  const cfg = _loadSettings();
  log("info", `Session keep-alive v1.9 started. Adaptive: ${cfg.adaptivePing !== false}, Night factor: ${getNightModeMultiplier().toFixed(1)}x.`);

  // Priming ping: 10–30 s after login to establish activity signal quickly
  const primingMs = (10 + Math.floor(Math.random() * 21)) * 1000;
  primingTimer = setTimeout(() => { doPing().catch(() => {}); }, primingMs);
  if (primingTimer?.unref) primingTimer.unref();
  log("info", `Priming ping in ${Math.round(primingMs / 1000)}s.`);

  schedulePing();
  scheduleNotificationVisit();
  scheduleSave();
  scheduleDtsg();
}

function stopKeepAlive() {
  [pingTimer, dtsgTimer, saveTimer, notiTimer, primingTimer].forEach(t => {
    if (t) { try { clearTimeout(t); } catch (_) {} try { clearInterval(t); } catch (_) {} }
  });
  pingTimer = dtsgTimer = saveTimer = notiTimer = primingTimer = null;
  _nextPingAt = _nextNotiAt = _nextSaveAt = null;
}

function getTimers() {
  return {
    nextPingAt:  _nextPingAt,
    nextDtsgAt:  global._dtsgNextAt || null,
    nextNotiAt:  _nextNotiAt,
    nextSaveAt:  _nextSaveAt,
  };
}

module.exports = { startKeepAlive, stopKeepAlive, doSaveCookies, doPing, getTimers };
