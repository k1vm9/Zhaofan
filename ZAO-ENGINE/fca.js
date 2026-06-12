"use strict";
/**
 * ZAO-ENGINE — FCA Client
 * Wraps @neoaz07/nkxfca with Djamel-fca's best features:
 *   - Cookie parsing (5 formats)
 *   - Live session validation via mbasic.facebook.com
 *   - UA rotation (mobile agents)
 *   - sendMessageHuman() with typing delay
 *   - buildReplyHelper() helper factory
 *   - Thread info cache (10 min TTL)
 *   - 3-minute login timeout guard
 */

const { login: _loginFCA } = require("@neoaz07/nkxfca");
const axios = require("axios");

const UA_POOL = [
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; OnePlus 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; Redmi Note 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; SAMSUNG SM-G998B) SamsungBrowser/19.0 Chrome/102.0.0.0 Mobile Safari/537.36",
];
let _uaIdx = Math.floor(Math.random() * UA_POOL.length);
const getUA    = () => UA_POOL[_uaIdx];
const rotateUA = () => { _uaIdx = (_uaIdx + 1) % UA_POOL.length; return UA_POOL[_uaIdx]; };

function dedup(cookies) {
  const seen = new Map();
  for (const c of cookies) {
    const k = c.key || c.name;
    if (k) seen.set(k, c);
  }
  return [...seen.values()];
}

function hasMandatory(cookies) {
  const keys = new Set(cookies.map(c => c.key || c.name));
  return keys.has("c_user") && keys.has("xs");
}

function parseCookieInput(raw) {
  if (!raw) return [];
  const text = String(raw).trim();

  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length && (arr[0]?.key || arr[0]?.name)) {
        return dedup(arr.map(c => ({
          key: c.key || c.name, value: c.value || "",
          domain: c.domain || ".facebook.com", path: c.path || "/",
          secure: c.secure ?? true, httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || "None",
        })).filter(c => c.key));
      }
    } catch (_) {}
  }

  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (Array.isArray(obj.cookies)) {
        return dedup(obj.cookies.map(c => ({
          key: c.name || c.key || "", value: c.value || "",
          domain: c.domain || ".facebook.com", path: c.path || "/",
          secure: c.secure ?? true, httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || "None",
        })).filter(c => c.key));
      }
      // Single cookie object
      if (obj.key && obj.value) return dedup([obj]);
      // Android fbsettings format: { "c_user": "123", "xs": "abc" }
      const keys = ["c_user","xs","fr","wd","datr","sb","m_sess","spin"];
      const found = Object.entries(obj).filter(([k]) => keys.some(kk => k === kk || k.toLowerCase() === kk));
      if (found.length > 0) {
        return dedup(found.map(([k, v]) => ({
          key: k, value: String(v),
          domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "None",
        })));
      }
    } catch (_) {}
  }

  if (text.includes("=")) {
    const pairs = text.split(/;\s*/g).filter(Boolean);
    const mapped = pairs.map(p => {
      const i = p.indexOf("=");
      if (i < 1) return null;
      return { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim(),
               domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "None" };
    }).filter(Boolean);
    if (mapped.length > 0) return dedup(mapped);
  }

  return [];
}

function calcTypingDelay(text) {
  const len  = String(text || "").replace(/<[^>]*>/g, "").length;
  const wpm  = 180 + Math.floor(Math.random() * 120);
  const base = Math.round((len / (wpm * 5 / 60)) * 1000);
  const jit  = (Math.random() - 0.5) * 800;
  return Math.min(Math.max(base + jit, 600), 9000);
}

async function simulateTyping(api, threadID, ms) {
  const delay = ms ?? 1500;
  try {
    if (typeof api?.sendTypingIndicator === "function") {
      const stop = api.sendTypingIndicator(threadID, () => {});
      await new Promise(r => setTimeout(r, delay));
      if (typeof stop === "function") stop();
    } else {
      await new Promise(r => setTimeout(r, delay));
    }
  } catch (_) { await new Promise(r => setTimeout(r, delay)); }
}

function buildReplyHelper(api, event) {
  return {
    reply:  async (msg, cb) => {
      const delay = calcTypingDelay(typeof msg === "string" ? msg : msg?.body || "");
      await simulateTyping(api, event.threadID, delay);
      return api.sendMessage(msg, event.threadID, cb);
    },
    unsend: (mid, cb) => { try { api.unsendMessage(mid || event.messageID, cb); } catch (_) {} },
    react:  (emoji, mid) => { try { api.setMessageReaction(emoji, mid || event.messageID, () => {}, true); } catch (_) {} },
    send:   (msg, tid, cb) => api.sendMessage(msg, tid || event.threadID, cb),
  };
}

const _threadCache = new Map();
async function getThreadInfo(api, tid, ttl = 10 * 60000) {
  const cached = _threadCache.get(tid);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;
  return new Promise((res, rej) => {
    api.getThreadInfo(tid, (err, data) => {
      if (err) { rej(err); return; }
      _threadCache.set(tid, { ts: Date.now(), data });
      res(data);
    });
  });
}

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

function loginAsync(credentials, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("loginAsync timed out after 3 minutes"));
    }, LOGIN_TIMEOUT_MS);

    _loginFCA(credentials, options, (err, api) => {
      clearTimeout(timer);
      if (err) return reject(err);

      api.getUID = () => api.getCurrentUserID();

      api.sendMessageHuman = async (msg, tid, cb) => {
        const delay = calcTypingDelay(typeof msg === "string" ? msg : msg?.body || "");
        await simulateTyping(api, tid, delay);
        return api.sendMessage(msg, tid, cb);
      };

      api.buildReplyHelper     = (event) => buildReplyHelper(api, event);
      api.getThreadInfoCached  = (tid, ttl) => getThreadInfo(api, tid, ttl);

      resolve(api);
    });
  });
}

module.exports = {
  login: _loginFCA,
  loginAsync,
  parseCookieInput,
  dedup,
  hasMandatory,
  getUA,
  rotateUA,
  calcTypingDelay,
  simulateTyping,
  buildReplyHelper,
  getThreadInfo,
};
