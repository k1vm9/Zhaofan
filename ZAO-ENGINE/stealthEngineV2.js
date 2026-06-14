"use strict";

/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  STEALTH ENGINE V2 — Human Camouflage System (10 Layers)
 *  ZAO v1.9 — restored from v1.3 includes/ with ZAO-ENGINE paths
 *  and AI-seeded randomizer support
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  Layer 1  — Presence Cycling (online/idle/offline rotation)
 *  Layer 2  — Human Page Browsing (GET + HEAD with real browser headers)
 *  Layer 3  — Mark-as-Read Simulation
 *  Layer 4  — Sleep Mode (configurable window, default 01:00–08:00)
 *  Layer 5  — User-Agent Rotation (expanded Android/iOS/WebView pool)
 *  Layer 6  — Action Jitter (±15% randomisation on all intervals)
 *  Layer 7  — Outgoing Message Throttle (via outgoingThrottle.js)
 *  Layer 8  — HTTP Request Fingerprinting (Sec-Fetch-*, sec-ch-ua, …)
 *  Layer 9  — Warmup Mode (minimal activity for first N minutes)
 *  Layer 10 — Typing Indicator before every reply (via humanTyping.js)
 *
 *  Config key: global.config.stealth  (in ZAO-SETTINGS.json)
 *
 *  NOTE: Layers 1, 2, 3 are DISABLED by default — they are optional
 *  additions when OnlinePresenceEngine / humanStealth are NOT in use.
 *  Enable via stealth.enablePresenceCycling / .enableBrowsing / .enableReadSimulation
 */

const axios = require("axios");

const _rand = (() => {
  const r = (() => { try { return require("./randomizer"); } catch (_) { return null; } })();
  return {
    ms:  (minMin, maxMin) => {
      const lo = minMin * 60_000, hi = maxMin * 60_000;
      if (r && typeof r.getIntervalSync === "function") return r.getIntervalSync(lo, hi);
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },
    int: (min, max) => {
      if (r && typeof r.getIntervalSync === "function") return r.getIntervalSync(min, max);
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
  };
})();

const sleep = ms => new Promise(res => setTimeout(res, ms));

function _log(level, msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ STEALTH-V2 ]: ", color: ["red", "cyan"] },
        { message: msg, color: level === "warn" ? "yellow" : level === "error" ? "red" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  const prefix = level === "warn" ? "[WARN]" : level === "error" ? "[ERR]" : "[INFO]";
  console.log(`[STEALTH-V2] ${prefix} ${msg}`);
}

function _getCfg() {
  return global.config?.stealth || {};
}

function localHour() {
  const tz = global.config?.timeZone || global.config?.timezone || "Africa/Algiers";
  try {
    return parseInt(
      new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10
    );
  } catch (_) { return new Date().getHours(); }
}

function isSleepHour() {
  const cfg = _getCfg();
  if (cfg.sleepModeEnable === false) return false;
  const start = cfg.sleepHourStart ?? 1;
  const end   = cfg.sleepHourEnd   ?? 8;
  const h     = localHour();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

function cookieStr(api) {
  try {
    const st = api.getAppState();
    if (!st?.length) return null;
    return st.map(c => `${c.key}=${c.value}`).join("; ");
  } catch (_) { return null; }
}

// ─── Layer 5: User-Agent Pool (realistic Android/iOS/FB WebView) ─────────────

const UA_POOL = [
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Redmi Note 13 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; 2311DRK48C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.135 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/492.0.0.38.109;]",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.98 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/489.0.0.42.115;]",
];

let _uaIdx = _rand.int(0, UA_POOL.length - 1);
const getUA  = () => UA_POOL[_uaIdx];
function rotateUA() {
  _uaIdx = (_uaIdx + _rand.int(1, UA_POOL.length - 1)) % UA_POOL.length;
}

// ─── Layer 8: HTTP Request Fingerprinting ─────────────────────────────────────

function buildBrowserHeaders(cookies, ua, referer = null) {
  const isChrome  = ua.includes("Chrome") && !ua.includes("FB_IAB");
  const isSafari  = ua.includes("Safari") && !ua.includes("Chrome");
  const isFbApp   = ua.includes("FB_IAB");
  const isMobile  = ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone");
  const chromeVer = (ua.match(/Chrome\/(\d+)/) || [])[1] || "124";

  const h = {
    "cookie":                    cookies,
    "user-agent":                ua,
    "accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language":           "ar-DZ,ar;q=0.9,en-US;q=0.8,en;q=0.7",
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

// ─── Layer 9: Warmup Mode ─────────────────────────────────────────────────────

let _startTime = Date.now();
function isWarmup() {
  const warmupMin = _getCfg().warmupMinutes ?? 15;
  return (Date.now() - _startTime) < warmupMin * 60_000;
}

// ─── Facebook pages to browse (Layer 2) ──────────────────────────────────────

const PAGE_POOL = [
  { url: "https://m.facebook.com/",                         label: "Home feed",       method: "GET"  },
  { url: "https://m.facebook.com/?sk=h_nor",               label: "News feed",       method: "HEAD" },
  { url: "https://m.facebook.com/notifications",           label: "Notifications",   method: "GET"  },
  { url: "https://m.facebook.com/messages",                label: "Messages list",   method: "HEAD" },
  { url: "https://m.facebook.com/profile.php",             label: "Own profile",     method: "GET"  },
  { url: "https://m.facebook.com/friend_requests",         label: "Friend requests", method: "HEAD" },
  { url: "https://m.facebook.com/events/upcoming",         label: "Events",          method: "HEAD" },
  { url: "https://m.facebook.com/groups/feed",             label: "Groups feed",     method: "HEAD" },
  { url: "https://m.facebook.com/marketplace",             label: "Marketplace",     method: "HEAD" },
  { url: "https://m.facebook.com/stories/feeds/",          label: "Stories feed",    method: "HEAD" },
  { url: "https://m.facebook.com/video_channel_browse",    label: "Reels browse",    method: "HEAD" },
  { url: "https://m.facebook.com/watch",                   label: "Watch / Video",   method: "HEAD" },
  { url: "https://m.facebook.com/bookmarks",               label: "Bookmarks",       method: "HEAD" },
  { url: "https://m.facebook.com/friends/center/requests", label: "Friend center",   method: "HEAD" },
  { url: "https://m.facebook.com/gaming",                  label: "Gaming hub",      method: "HEAD" },
  { url: "https://m.facebook.com/privacy/checkup",         label: "Privacy checkup", method: "HEAD" },
];

// ─── Timer state ──────────────────────────────────────────────────────────────

let _running = false;
let _api     = null;
const _timers = [];

function _addTimer(name, fn, ms) {
  let entry;
  const wrapped = function () {
    const idx = _timers.indexOf(entry);
    if (idx !== -1) _timers.splice(idx, 1);
    fn();
  };
  const id = setTimeout(wrapped, ms);
  if (id?.unref) id.unref();
  entry = { id, name, type: "timeout" };
  _timers.push(entry);
  return id;
}

function _clearAll() {
  for (const { id, type } of _timers) {
    if (type === "timeout") clearTimeout(id);
    else clearInterval(id);
  }
  _timers.length = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 1 — Presence Cycling
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function presenceLoop() {
  if (!_running) return;
  const api = _api;
  try {
    if (isSleepHour()) {
      try { api.setOptions({ online: false }); } catch (_) {}
      _addTimer("presence", presenceLoop, _rand.ms(25, 55));
      return;
    }
    if (isWarmup()) {
      try { api.setOptions({ online: false }); } catch (_) {}
      _addTimer("presence", presenceLoop, _rand.ms(3, 8));
      return;
    }
    const roll = Math.random();
    if (roll < 0.50) {
      try { api.setOptions({ online: true }); } catch (_) {}
      _addTimer("presence", presenceLoop, _rand.ms(6, 18));
    } else if (roll < 0.80) {
      try { api.setOptions({ online: false }); } catch (_) {}
      _addTimer("presence", presenceLoop, _rand.ms(5, 15));
    } else {
      try { api.setOptions({ online: false }); } catch (_) {}
      _addTimer("presence", presenceLoop, _rand.ms(10, 25));
    }
  } catch (_) {
    _addTimer("presence", presenceLoop, _rand.ms(10, 20));
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 2 — Human Page Browsing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function browseLoop() {
  if (!_running) return;
  const api = _api;
  try {
    const cookies = cookieStr(api);
    if (!cookies)      { _addTimer("browse", browseLoop, _rand.ms(25, 50)); return; }
    if (isSleepHour()) { _addTimer("browse", browseLoop, _rand.ms(40, 90)); return; }
    if (isWarmup())    { _addTimer("browse", browseLoop, _rand.ms(20, 40)); return; }

    if (Math.random() < 0.10) rotateUA();

    const page   = PAGE_POOL[_rand.int(0, PAGE_POOL.length - 1)];
    const ua     = getUA();
    const hdrs1  = buildBrowserHeaders(cookies, ua, null);
    const useGet = Math.random() < 0.40 || page.method === "GET";
    const method = useGet ? "get" : "head";

    await axios[method](page.url, {
      headers:          hdrs1,
      timeout:          12000,
      validateStatus:   null,
      maxRedirects:     3,
      maxContentLength: useGet ? 65536 : undefined,
    });

    _log("info", `🌐 Browsed (${method.toUpperCase()}): ${page.label}`);

    if (Math.random() < 0.20) {
      await sleep(_rand.int(6000, 22000));
      const page2 = PAGE_POOL[_rand.int(0, PAGE_POOL.length - 1)];
      const hdrs2 = buildBrowserHeaders(cookies, ua, page.url);
      await axios.head(page2.url, { headers: hdrs2, timeout: 8000, validateStatus: null, maxRedirects: 2 });
    }
  } catch (_) {}

  _addTimer("browse", browseLoop, isSleepHour() ? _rand.ms(50, 100) : _rand.ms(15, 35));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 3 — Mark-as-Read Simulation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function readLoop() {
  if (!_running) return;
  const api = _api;
  try {
    if (!isSleepHour()) {
      const threadIDs = new Set();
      try { Object.keys(global.divelMonitor || {}).forEach(id => threadIDs.add(id)); } catch (_) {}
      try { Object.keys(global.angelIntervals || {}).forEach(id => threadIDs.add(id)); } catch (_) {}

      if (threadIDs.size > 0) {
        const ids    = [...threadIDs];
        const count  = Math.min(_rand.int(1, 3), ids.length);
        const chosen = ids.sort(() => Math.random() - 0.5).slice(0, count);
        for (const tid of chosen) {
          try {
            await api.markAsRead(tid);
            await sleep(_rand.int(800, 3000));
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  _addTimer("read", readLoop, isSleepHour() ? _rand.ms(40, 80) : _rand.ms(15, 45));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 5 — Periodic UA Rotation (independent timer, no HTTP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function uaRotationLoop() {
  if (!_running) return;
  rotateUA();
  _log("info", `🔄 User-Agent rotated → ${getUA().slice(0, 60)}…`);
  _addTimer("ua-rotation", uaRotationLoop, _rand.ms(60, 180));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 6 — Action Jitter helper
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function jitter(intervalMs) {
  const factor = 0.85 + Math.random() * 0.30;
  return Math.round(intervalMs * factor);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PUBLIC API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

module.exports.start = function startStealthV2(api) {
  if (_running) {
    _log("warn", "Already running — skipping duplicate start.");
    return;
  }

  const cfg = _getCfg();
  if (cfg.enable === false) {
    _log("info", "Stealth V2 disabled in config (stealth.enable = false). Skipping.");
    return;
  }

  _running   = true;
  _api       = api;
  _startTime = Date.now();

  const warmupMin    = cfg.warmupMinutes ?? 15;
  const activeLayers = [];

  // Layer 1 — Presence Cycling: DISABLED by default (conflicts with OnlinePresenceEngine)
  if (cfg.enablePresenceCycling === true) {
    _addTimer("presence-init", presenceLoop, _rand.ms(0, 2));
    activeLayers.push("L1-presence");
  }

  // Layer 2 — Page Browsing: DISABLED by default (conflicts with humanStealth)
  if (cfg.enableBrowsing === true) {
    _addTimer("browse-init", browseLoop, _rand.ms(20, 35));
    activeLayers.push("L2-browse");
  }

  // Layer 3 — Mark-as-Read: DISABLED by default (conflicts with humanStealth readLoop)
  if (cfg.enableReadSimulation === true) {
    _addTimer("read-init", readLoop, _rand.ms(18, 35));
    activeLayers.push("L3-read");
  }

  // Layer 5 — UA Rotation: always active (no HTTP traffic, just header state)
  _addTimer("ua-rotation-init", uaRotationLoop, _rand.ms(70, 130));
  activeLayers.push("L5-ua-rotation");

  const disabled = ["L1-presence", "L2-browse", "L3-read"].filter(l => !activeLayers.includes(l));

  _log("info", `🕵️ Stealth Engine V2 started — active: [${activeLayers.join(", ")}]`);
  if (disabled.length) {
    _log("info", `⚠️  Disabled (duplicated by OPE/humanStealth): [${disabled.join(", ")}]`);
  }
  _log("info", `🌙 Sleep: ${cfg.sleepHourStart ?? 1}:00–${cfg.sleepHourEnd ?? 8}:00 | 🌱 Warmup: ${warmupMin} min`);
};

module.exports.stop = function stopStealthV2() {
  _running = false;
  _clearAll();
  _log("info", "🛑 Stealth Engine V2 stopped.");
};

module.exports.isRunning           = () => _running;
module.exports.getCurrentUA        = getUA;
module.exports.jitter              = jitter;
module.exports.isSleepHour         = isSleepHour;
module.exports.isWarmup            = isWarmup;
module.exports.buildBrowserHeaders = buildBrowserHeaders;

module.exports.getStatus = function () {
  const cfg = _getCfg();
  return {
    running:       _running,
    currentUA:     getUA().slice(0, 60) + "…",
    uaPoolSize:    UA_POOL.length,
    pagePoolSize:  PAGE_POOL.length,
    isSleepHour:   isSleepHour(),
    isWarmup:      isWarmup(),
    localHour:     localHour(),
    sleepStart:    cfg.sleepHourStart ?? 1,
    sleepEnd:      cfg.sleepHourEnd   ?? 8,
    warmupMinutes: cfg.warmupMinutes  ?? 15,
    activeTimers:  _timers.length,
    layers:        10,
  };
};
