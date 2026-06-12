"use strict";
/**
 * ZAO-ENGINE — Keep-Alive
 * Based on ZAO's keepAlive.js — periodic pings, cookie save, dtsg refresh,
 * and notification visit. Simplified: removed complex circuit-breaker logic
 * that caused false positives and tier switches.
 */

const axios      = require("axios");
const fs         = require("fs-extra");
const path       = require("path");
const randomizer = (() => {
  try { return require("./randomizer"); }
  catch (_) { return null; }
})();

let pingTimer    = null;
let _nextPingAt  = null;
let _nextNotiAt  = null;
let _nextSaveAt  = null;
let dtsgTimer    = null;
let saveTimer    = null;
let notiTimer    = null;
let primingTimer = null;
let isSaving     = false;

function log(msg) {
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

// Use AI-seeded randomizer when available; falls back to Math.random() automatically
const rand = (minMin, maxMin) =>
  randomizer
    ? randomizer.getIntervalSync(minMin * 60000, maxMin * 60000)
    : Math.floor(Math.random() * ((maxMin - minMin) * 60000 + 1)) + minMin * 60000;

function getCookieStr(api) {
  try {
    if (!api || typeof api.getAppState !== "function") return null;
    const s = api.getAppState();
    if (!Array.isArray(s) || !s.length) return null;
    return s.filter(c => c && c.key && c.value).map(c => `${c.key}=${c.value}`).join("; ");
  } catch (_) { return null; }
}

const PING_ENDPOINTS = [
  { url: "https://www.facebook.com/home.php",      referer: "https://www.facebook.com/", label: "home" },
  { url: "https://www.facebook.com/messages/",     referer: "https://www.facebook.com/home.php", label: "messages" },
  { url: "https://mbasic.facebook.com/",           referer: null, label: "mbasic" },
  { url: "https://mbasic.facebook.com/home.php",   referer: "https://mbasic.facebook.com/", label: "mbasic-home" },
  { url: "https://m.facebook.com/",                referer: null, label: "m-fb" },
  { url: "https://www.facebook.com/notifications", referer: "https://www.facebook.com/", label: "notifs" },
];

const MOBILE_UA = [
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
];

function getUA() {
  const idx = randomizer
    ? randomizer.getIntervalSync(0, MOBILE_UA.length - 1)
    : Math.floor(Math.random() * MOBILE_UA.length);
  return MOBILE_UA[idx];
}

let _lastEpIdx = -1;
function pickEndpoint() {
  let idx;
  do {
    idx = randomizer
      ? randomizer.getIntervalSync(0, PING_ENDPOINTS.length - 1)
      : Math.floor(Math.random() * PING_ENDPOINTS.length);
  } while (idx === _lastEpIdx && PING_ENDPOINTS.length > 1);
  _lastEpIdx = idx;
  return PING_ENDPOINTS[idx];
}

function isLoginPage(html, url) {
  const u = String(url || ""), b = String(html || "");
  return /\/login[/?]/.test(u) || b.includes('id="login_form"') ||
         b.includes("You must log in") || b.includes("Log in to Facebook");
}

const TIER_PATHS = {
  1: { stateFile: "sessions/ZAO-STATE.json",  altFile: "sessions/alt.json"  },
  2: { stateFile: "sessions/ZAO-STATEX.json", altFile: "sessions/altx.json" },
  3: { stateFile: "sessions/ZAO-STATEV.json", altFile: "sessions/altv.json" },
};

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

    const tmp = statePath + ".tmp";
    await fs.writeFile(tmp, newData, "utf-8");
    await fs.move(tmp, statePath, { overwrite: true });

    const tmp2 = altPath + ".tmp";
    await fs.writeFile(tmp2, newData, "utf-8");
    await fs.move(tmp2, altPath, { overwrite: true });

    log(`Cookies saved → ${stateFile}${source ? ` (${source})` : ""} ✓`);

    try {
      const snap = require("./cookieSnapshot");
      snap.snapshot(appState, statePath);
    } catch (_) {}
  } catch (e) {
    log(`Failed to save cookies: ${e.message || e}`);
  } finally {
    isSaving = false;
  }
}

async function doPing() {
  if (global._humanStealthBreak) return;
  try {
    const api = global._botApi;
    if (!api) return;
    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;

    const ep  = pickEndpoint();
    const UA  = getUA();
    const headers = {
      cookie: cookieStr, "user-agent": UA,
      "accept": "text/html,*/*;q=0.8",
      "accept-language": "ar,en-US;q=0.9,en;q=0.8",
      "upgrade-insecure-requests": "1",
    };
    if (ep.referer) headers.referer = ep.referer;

    try {
      const r    = await axios.get(ep.url, { headers, timeout: 15000, validateStatus: null, maxRedirects: 3 });
      const html = String(r.data || "");
      const resUrl = String(r.request?.res?.responseUrl || ep.url);
      if (!isLoginPage(html, resUrl)) {
        global.lastPingActivity = Date.now();
        log(`Ping ${ep.label} ✓`);
        await doSaveCookies("post-ping");
        return;
      }
      log(`Ping ${ep.label} → login page (session may have expired)`);
    } catch (e) {
      log(`Ping ${ep.label} failed: ${e.message}`);
    }
  } catch (e) {
    log(`doPing error: ${e.message}`);
  }
}

async function doRefreshDtsg() {
  try {
    const api = global._botApi;
    if (!api || typeof api.refreshFb_dtsg !== "function") return;
    await api.refreshFb_dtsg();
    log("fb_dtsg token refreshed ✓");
    await doSaveCookies("post-dtsg-refresh");
  } catch (e) {
    log(`fb_dtsg refresh failed: ${e.message}`);
  }
}

async function doNotificationVisit() {
  try {
    const api   = global._botApi;
    if (!api) return;
    const botID = api.getCurrentUserID?.() || global.botUserID || "";
    if (!botID) return;
    const cookieStr = getCookieStr(api);
    if (!cookieStr) return;
    const body = new URLSearchParams({
      av: botID,
      fb_api_req_friendly_name: "CometNotificationsDropdownQuery",
      fb_api_caller_class: "RelayModern",
      doc_id: "5025284284225032",
      variables: JSON.stringify({ count: 5, environment: "MAIN_SURFACE", menuUseEntryPoint: true, scale: 1 }),
    });
    await axios.post("https://www.facebook.com/api/graphql/", body.toString(), {
      headers: {
        cookie: cookieStr, "user-agent": getUA(),
        "content-type": "application/x-www-form-urlencoded",
        "accept": "text/html,*/*;q=0.8",
      },
      timeout: 20000, maxRedirects: 0, validateStatus: () => true,
    });
    log("Notification visit ✓");
  } catch (_) {}
}

function schedulePing() {
  if (pingTimer) clearTimeout(pingTimer);
  if (!global._botApi) return;
  const minMin = 8, maxMin = 22;
  const delay  = rand(minMin, maxMin);
  _nextPingAt  = Date.now() + delay;
  pingTimer = setTimeout(async () => {
    _nextPingAt = null;
    try { await doPing(); } catch (_) {}
    schedulePing();
  }, delay);
  if (pingTimer.unref) pingTimer.unref();
  log(`Next ping in ${Math.round(delay / 60000)} min.`);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  const delay  = rand(25, 45);
  _nextSaveAt  = Date.now() + delay;
  saveTimer = setTimeout(async () => {
    _nextSaveAt = null;
    try { await doSaveCookies("scheduled"); } catch (_) {}
    scheduleSave();
  }, delay);
  if (saveTimer.unref) saveTimer.unref();
}

function scheduleDtsg() {
  if (dtsgTimer) clearTimeout(dtsgTimer);
  const delay  = rand(360, 480);   // 6–8 h in minutes → rand converts to ms
  global._dtsgNextAt = Date.now() + delay;
  dtsgTimer = setTimeout(async () => {
    try { await doRefreshDtsg(); } catch (_) {}
    scheduleDtsg();
  }, delay);
  if (dtsgTimer.unref) dtsgTimer.unref();
}

function scheduleNotificationVisit() {
  if (notiTimer) clearTimeout(notiTimer);
  const delay  = rand(60, 180);
  _nextNotiAt  = Date.now() + delay;
  notiTimer = setTimeout(async () => {
    _nextNotiAt = null;
    try { await doNotificationVisit(); } catch (_) {}
    scheduleNotificationVisit();
  }, delay);
  if (notiTimer.unref) notiTimer.unref();
}

function startKeepAlive() {
  [pingTimer, dtsgTimer, saveTimer, notiTimer, primingTimer].forEach(t => {
    if (t) try { clearTimeout(t); } catch (_) {}
  });
  pingTimer = dtsgTimer = saveTimer = notiTimer = primingTimer = null;

  log("Session keep-alive started.");

  const primingMs = rand(10 / 60, 30 / 60);  // 10–30 s expressed as minutes → ms
  primingTimer = setTimeout(() => { doPing().catch(() => {}); }, primingMs);
  if (primingTimer?.unref) primingTimer.unref();

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
