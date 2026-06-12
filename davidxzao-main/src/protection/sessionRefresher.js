/**
 * DAVID V1 — Session Refresher (Layer 9)
 * Copyright © 2025 DJAMEL
 * Periodically fetches a lightweight Facebook endpoint to refresh session
 * tokens and saves the updated AppState to prevent cookie expiry.
 */
"use strict";

const fs   = require("fs-extra");
const path = require("path");
const axios = require("axios");
let _active = false;
let _api    = null;
let _timer  = null;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const ACCOUNT_PATH = path.join(process.cwd(), "account.txt");

async function refresh() {
  if (!_active || !_api) return;
  try {
    const state = _api.getAppState?.();
    if (!state?.length) return;

    const ck = state.map(c => `${c.key}=${c.value}`).join("; ");
    const ua = global.GoatBot?.config?.facebookAccount?.userAgent ||
               "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36";

    await axios.get("https://mbasic.facebook.com/", {
      headers: { cookie: ck, "user-agent": ua, "accept": "text/html,*/*;q=0.8" },
      timeout: 12000, validateStatus: null, maxRedirects: 2,
    });

    // Save fresh appstate
    const fresh = _api.getAppState?.();
    if (fresh?.length) {
      global._selfWrite = true;
      fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(fresh, null, 2));
      setTimeout(() => { global._selfWrite = false; }, 5000);
    }
  } catch (_) {}
}

function schedule() {
  if (!_active) return;
  const ms = rand(20, 40) * 60000; // every 20–40 min
  _timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, ms);
}

function start(api) {
  if (_active || !api) return;
  _active = true;
  _api    = api;
  schedule();
}

function stop() {
  _active = false;
  _api    = null;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function wrapSendMessage(api) { start(api); }
function wrapWithTyping(api)  { start(api); }

module.exports = { start, stop, wrapSendMessage, wrapWithTyping, isActive: () => _active };
