/** Djamel-Fca Architecte Core — Session Connectivity Check */
"use strict";
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { ACCOUNT_PATH } = require("../utils/runtimePaths");
let timer = null;
let sessionWriteTimer = null;
const rand = (a,b) => Math.floor(Math.random() * (b-a+1)) + a;

async function ping() {
  try {
    const api = global.GoatBot?.fcaApi;
    if (!api) return;
    const state = api.getAppState?.() || [];
    if (!state.length) return;
    const cookie = state.map(c => `${c.key}=${c.value}`).join("; ");
    const r = await axios.head("https://www.facebook.com/", {
      headers: { cookie }, timeout: 10000, validateStatus: null, maxRedirects: 2,
    });
    const location = String(r.headers?.location || "");
    if (/login|checkpoint/i.test(location)) {
      global.log?.warn?.("SESSION", "The session may require re-authentication");
      global.GoatBot.sessionState = "reauth_required";
    } else {
      global.GoatBot.sessionState = "ok";
    }
  } catch (e) {
    global.log?.warn?.("KEEP_ALIVE", e.message || String(e));
  }
}

function start() {
  if (timer || global.GoatBot?.config?.keepAlive?.enable === false) return;
  const c = global.GoatBot?.config?.keepAlive || {};
  const min = Math.max(1, Number(c.pingIntervalMinMinutes || 8)) * 60000;
  const max = Math.max(min, Number(c.pingIntervalMaxMinutes || 15) * 60000);
  const schedule = () => {
    timer = setTimeout(async () => { timer = null; await ping(); schedule(); }, rand(min, max));
    if (timer.unref) timer.unref();
  };
  schedule();
}
function stop() { if (timer) clearTimeout(timer); timer = null; }

async function doSaveCookies(reason = "manual", api = global.GoatBot?.fcaApi) {
  if (!api || typeof api.getAppState !== "function") {
    throw new Error("لا توجد جلسة نشطة لحفظها.");
  }
  const state = api.getAppState();
  if (!Array.isArray(state) || state.length === 0) {
    throw new Error("الجلسة الحالية لا تحتوي على كوكيز.");
  }
  fs.mkdirSync(path.dirname(ACCOUNT_PATH), { recursive: true });
  const tempPath = `${ACCOUNT_PATH}.save-${process.pid}-${Date.now()}`;
  global._selfWrite = true;
  clearTimeout(sessionWriteTimer);
  sessionWriteTimer = setTimeout(() => { global._selfWrite = false; }, 6000);
  if (typeof sessionWriteTimer.unref === "function") sessionWriteTimer.unref();
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, ACCOUNT_PATH);
    try { fs.chmodSync(ACCOUNT_PATH, 0o600); } catch (_) {}
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
    throw error;
  }
  global.lastSessionSave = Date.now();
  global.lastAltJsonSave = global.lastSessionSave;
  global.log?.info?.("SESSION", `Saved ${state.length} cookies (${reason}).`);
  return { count: state.length, path: ACCOUNT_PATH };
}

module.exports = { start, stop, ping, doSaveCookies };
