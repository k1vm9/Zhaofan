"use strict";
/**
 * ZAO-ENGINE — Stealth (Presence Loop)
 * Source: David's stealth.js — simple, non-blocking, battle-tested.
 * Rotates through multiple Facebook endpoints every 8-20 min with a
 * rotating mobile UA to keep the session signal alive.
 * Respects sleep hours. Never crashes the bot.
 */

const axios = require("axios");

const UA_POOL = [
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 Version/16.5 Mobile Safari/604.1",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 Chrome/101.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; OnePlus 11) AppleWebKit/537.36 Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; Redmi Note 8 Pro) AppleWebKit/537.36 Chrome/100.0.4896.127 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36",
];

// Rotate through varied endpoints so the pattern doesn't look robotic
const ENDPOINTS = [
  { url: "https://mbasic.facebook.com/",              referer: null },
  { url: "https://www.facebook.com/",                 referer: null },
  { url: "https://mbasic.facebook.com/home.php",      referer: "https://mbasic.facebook.com/" },
  { url: "https://m.facebook.com/",                   referer: null },
  { url: "https://www.facebook.com/messages/",        referer: "https://www.facebook.com/" },
  { url: "https://www.facebook.com/notifications",    referer: "https://www.facebook.com/" },
];

let _uaIdx     = Math.floor(Math.random() * UA_POOL.length);
let _epIdx     = Math.floor(Math.random() * ENDPOINTS.length);
let _active    = false;
let _api       = null;
let _lastPingTs = 0;

const getUA    = () => UA_POOL[_uaIdx];
const rotateUA = () => { _uaIdx = (_uaIdx + 1) % UA_POOL.length; return UA_POOL[_uaIdx]; };
const pickEp   = () => { _epIdx = (_epIdx + 1) % ENDPOINTS.length; return ENDPOINTS[_epIdx]; };
const rand     = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const sleep    = ms => new Promise(r => { const t = setTimeout(r, ms); if (t?.unref) t.unref(); });

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
        const ck = state.map(c => `${c.key}=${c.value}`).join("; ");
        const ep = pickEp();
        const ua = rotateUA();
        const headers = {
          cookie: ck,
          "user-agent": ua,
          "accept": "text/html,*/*;q=0.8",
          "accept-language": "ar,en-US;q=0.9,en;q=0.8",
          "upgrade-insecure-requests": "1",
        };
        if (ep.referer) headers.referer = ep.referer;
        await axios.get(ep.url, {
          headers,
          timeout: 12000,
          validateStatus: null,
          maxRedirects: 2,
        });
        _lastPingTs = Date.now();
        log(`Ping → ${ep.url.replace("https://", "")} ✓`);
      }
    } catch (_) {}
    await sleep(rand(8, 20) * 60000);
  }
}

function start(api) {
  if (_active) { _api = api; return; }   // update api ref if already running
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
    engine:       "ZAO-ENGINE/stealth",
  };
}

module.exports = { start, stop, updateApi, getUA, rotateUA, isActive: () => _active, getStatus };
