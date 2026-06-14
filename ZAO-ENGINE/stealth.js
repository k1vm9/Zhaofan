"use strict";
/**
 * ZAO-ENGINE — Stealth (Presence Loop) v1.9
 * Simple, non-blocking, battle-tested session presence ping.
 * Rotates through Facebook endpoints every 8-20 min with a rotating UA
 * to keep the session signal alive. Respects sleep hours. Never crashes.
 *
 * v1.9 upgrades:
 *  - Updated UA pool to 2024-2025 agents (Chrome 124-131, Safari 18, Firefox 130)
 *  - Full browser fingerprinting headers: sec-fetch-*, sec-ch-ua, cache-control, dnt
 *  - Ping success/fail counters exposed in getStatus()
 */

const axios = require("axios");

// ── 2024-2025 User-Agent pool ────────────────────────────────────────────────
const UA_POOL = [
  // Chrome 131 — Android (Dec 2024)
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36",
  // Chrome 130 — Android (Nov 2024)
  "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.116 Mobile Safari/537.36",
  // Chrome 129 — Android (Oct 2024)
  "Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Mobile Safari/537.36",
  // Chrome 128 — Android (Sep 2024)
  "Mozilla/5.0 (Linux; Android 13; OnePlus 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.137 Mobile Safari/537.36",
  // Chrome 127 — Android (Aug 2024)
  "Mozilla/5.0 (Linux; Android 13; Xiaomi 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.103 Mobile Safari/537.36",
  // Chrome 126 — Android (Jul 2024)
  "Mozilla/5.0 (Linux; Android 14; SM-S916B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.134 Mobile Safari/537.36",
  // Chrome 125 — Android (Jun 2024)
  "Mozilla/5.0 (Linux; Android 13; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36",
  // Chrome 124 — Android (May 2024)
  "Mozilla/5.0 (Linux; Android 14; OPPO Find X8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.179 Mobile Safari/537.36",
  // Safari 18 — iPhone iOS 18.2 (2024)
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  // Safari 18.1 — iPhone iOS 18.1 (Oct 2024)
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  // Safari 17.6 — iPhone iOS 17.6 (Aug 2024)
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  // Firefox 130 — Android (Sep 2024)
  "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  // Samsung Internet 25 — Android (2024)
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
];

// UA → matching sec-ch-ua header (omit for Safari/Firefox — they don't send it)
const SEC_CH_UA = {
  "Chrome/131": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
  "Chrome/130": '"Chromium";v="130", "Google Chrome";v="130", "Not_A Brand";v="24"',
  "Chrome/129": '"Chromium";v="129", "Google Chrome";v="129", "Not_A Brand";v="24"',
  "Chrome/128": '"Chromium";v="128", "Google Chrome";v="128", "Not_A Brand";v="24"',
  "Chrome/127": '"Chromium";v="127", "Google Chrome";v="127", "Not_A Brand";v="24"',
  "Chrome/126": '"Chromium";v="126", "Google Chrome";v="126", "Not_A Brand";v="24"',
  "Chrome/125": '"Chromium";v="125", "Google Chrome";v="125", "Not_A Brand";v="24"',
  "Chrome/124": '"Chromium";v="124", "Google Chrome";v="124", "Not_A Brand";v="24"',
  "SamsungBrowser": '"Samsung Internet";v="25.0", "Chromium";v="121", "Not_A Brand";v="24"',
};

// Rotate through varied endpoints so the pattern doesn't look robotic
const ENDPOINTS = [
  { url: "https://www.facebook.com/",                 referer: null },
  { url: "https://www.facebook.com/messages/",        referer: "https://www.facebook.com/" },
  { url: "https://www.facebook.com/notifications",    referer: "https://www.facebook.com/" },
  { url: "https://www.facebook.com/home.php",         referer: "https://www.facebook.com/" },
  { url: "https://m.facebook.com/",                   referer: null },
];

let _uaIdx       = Math.floor(Math.random() * UA_POOL.length);
let _epIdx       = Math.floor(Math.random() * ENDPOINTS.length);
let _active      = false;
let _api         = null;
let _lastPingTs  = 0;
let _pingOk      = 0;
let _pingFail    = 0;

const getUA    = () => UA_POOL[_uaIdx];
const rotateUA = () => { _uaIdx = (_uaIdx + 1) % UA_POOL.length; return UA_POOL[_uaIdx]; };
const pickEp   = () => { _epIdx = (_epIdx + 1) % ENDPOINTS.length; return ENDPOINTS[_epIdx]; };
const rand     = (a, b) => {
  const r = global._randomizer;
  if (r && typeof r.getIntervalSync === "function") return r.getIntervalSync(a, b);
  return Math.floor(Math.random() * (b - a + 1)) + a;
};
const sleep    = ms => new Promise(r => { const t = setTimeout(r, ms); if (t?.unref) t.unref(); });

// Build browser-fingerprint headers matching the given UA
function buildHeaders(cookieStr, ua, referer) {
  const headers = {
    cookie:                    cookieStr,
    "user-agent":              ua,
    "accept":                  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language":         "ar,en-US;q=0.9,en;q=0.8",
    "accept-encoding":         "gzip, deflate, br",
    "cache-control":           "max-age=0",
    "dnt":                     "1",
    "upgrade-insecure-requests": "1",
  };

  // sec-fetch-* — only for Chromium-based UAs
  const isChromium = ua.includes("Chrome/") || ua.includes("SamsungBrowser/");
  if (isChromium) {
    headers["sec-fetch-dest"]  = "document";
    headers["sec-fetch-mode"]  = "navigate";
    headers["sec-fetch-site"]  = referer ? "same-origin" : "none";
    headers["sec-fetch-user"]  = "?1";

    // Match sec-ch-ua to the specific Chrome version
    const vKey = Object.keys(SEC_CH_UA).find(k => ua.includes(k));
    if (vKey) {
      headers["sec-ch-ua"]         = SEC_CH_UA[vKey];
      headers["sec-ch-ua-mobile"]  = "?1";
      headers["sec-ch-ua-platform"] = '"Android"';
    }
  }

  if (referer) headers["referer"] = referer;
  return headers;
}

function isSleepHour() {
  try {
    const cfg = global.config?.stealth || {};
    const tz  = global.config?.timezone || "Africa/Algiers";
    const h   = parseInt(new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10);
    const s   = cfg.sleepHourStart ?? 1;
    const e   = cfg.sleepHourEnd   ?? 7;
    return s < e ? h >= s && h < e : h >= s || h < e;
  } catch (_) { return false; }
}

function log(msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ STEALTH ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
}

async function presenceLoop() {
  while (_active) {
    try {
      if (isSleepHour()) {
        log("Sleep hours — skipping ping.");
        await sleep(rand(15, 25) * 60000);
        continue;
      }
      if (!_api) { await sleep(rand(8, 15) * 60000); continue; }

      const state = _api.getAppState?.();
      if (state?.length) {
        const ck      = state.map(c => `${c.key}=${c.value}`).join("; ");
        const ep      = pickEp();
        const ua      = rotateUA();
        const headers = buildHeaders(ck, ua, ep.referer);

        try {
          await axios.get(ep.url, {
            headers,
            timeout: 12000,
            validateStatus: null,
            maxRedirects: 2,
          });
          _lastPingTs = Date.now();
          _pingOk++;
          log(`Ping → ${ep.url.replace("https://", "")} ✓`);
        } catch (e) {
          _pingFail++;
          log(`Ping → ${ep.url.replace("https://", "")} failed (${e.message || e})`);
        }
      }
    } catch (_) {}
    await sleep(rand(8, 20) * 60000);
  }
}

function start(api) {
  if (_active) { _api = api; return; }
  _api    = api;
  _active = true;
  presenceLoop().catch(() => {});
}

function stop() {
  _active = false;
  _api    = null;
}

function updateApi(api) { _api = api; }

function getStatus() {
  return {
    active:       _active,
    lastPingAgo:  _lastPingTs ? Math.round((Date.now() - _lastPingTs) / 1000) + "s" : "never",
    pingOk:       _pingOk,
    pingFail:     _pingFail,
    engine:       "ZAO-ENGINE/stealth v1.9",
  };
}

module.exports = { start, stop, updateApi, getUA, rotateUA, isActive: () => _active, getStatus };
