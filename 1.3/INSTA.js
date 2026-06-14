'use strict';
/**
 * INSTA.js — ZAO-INSTA Instagram Bot Module
 * ============================================
 * @version 2.1.0
 * @author  SAIN (original), DJAMEL (cookie login, hot-reload, protection v2, MQTT reconnect,
 *          challenge handler, message reading fixes, enabled flag)
 * @updated 2026-05-26
 *
 * Login chain:
 *  1. INSTA-APPSTATE.json  — full cookie injection (all important cookies + device fingerprint)
 *     → if checkpoint: ig.challenge.auto(true) → waits for 6-digit code from panel
 *  2. INSTA-STATE.json     — serialized ig.state (saved session)
 *  3. username + password  — fresh credential login
 *     → if checkpoint: same challenge flow as #1
 *
 * Challenge flow: GET /insta/challenge-status | POST /insta/challenge-submit {"code":"123456"}
 * Hot-reload: POST /insta/reload-cookies — applies new INSTA-APPSTATE.json without restart
 */

const {
  IgApiClient,
  IgCheckpointError,
  IgChallengeWrongCodeError,
  IgLoginRequiredError,
  IgLoginBadPasswordError,
  IgLoginInvalidUserError,
} = require('instagram-private-api');
const { withRealtime } = require('instagram_mqtt');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ─── ANSI colors for prettier console output ──────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

const __dir           = __dirname;
const SETTINGS_FILE   = path.join(__dir, 'INSTA-SETTINGS.json');
const SESSIONS_DIR    = path.join(__dir, 'sessions');
const STATE_FILE      = path.join(SESSIONS_DIR, 'INSTA-STATE.json');
const APPSTATE_FILE   = path.join(SESSIONS_DIR, 'INSTA-APPSTATE.json');
const DATA_DIR        = path.join(__dir, 'data');
const CMDS_DIR        = path.join(__dir, 'SCRIPTS', 'INSTA-CMDS');
const INSTA_API_PORT  = 3002;
const MAX_SEEN        = 1000;

// ─── Logger ───────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(tag, msg) {
  const color = tag === 'BOOT' ? C.cyan : tag === 'LOGIN' ? C.green : tag === 'MQTT' ? C.magenta : tag === 'PROTECT' ? C.yellow : C.dim;
  process.stdout.write(`${C.bold}[${ts()}]${C.reset} ${color}[INSTA:${tag}]${C.reset} ${msg}\n`);
}
function logErr(tag, msg) {
  process.stderr.write(`${C.bold}[${ts()}]${C.reset} ${C.red}[INSTA:${tag}]${C.reset} ${C.red}${msg}${C.reset}\n`);
}

// ─── Runtime state ────────────────────────────────────────────────────────────
let ig          = null;
let settings    = {};
let commands    = new Map();
let seenItemIds = new Set();
let pollTimer          = null;
let _mqttConnected     = false;
let _mqttPollScheduled = false;
let _fallbackPollTimer = null;
let isRunning          = false;
let loginOk     = false;
let loginMethod = 'none';
let currentUser = null;
let startedAt   = Date.now();
let totalMessages  = 0;
let totalCommands  = 0;
let lastPollAt     = null;
let lastPollStatus = 'not started';

// ─── Challenge state (Instagram security verification) ────────────────────────
// When Instagram asks for a verification code (checkpoint), we store the state
// here so the panel can submit the code via POST /insta/challenge-submit
let _challengePending = false;
let _challengeType    = null;  // 'checkpoint' | 'credentials-checkpoint' | null

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const threadRates = new Map();
const globalRate  = { count: 0, windowStart: Date.now() };

function checkRate(threadId) {
  const now = Date.now();
  const maxThread = (settings.rateLimit && settings.rateLimit.maxPerMinPerThread) || 20;
  const maxGlobal = (settings.rateLimit && settings.rateLimit.globalMaxPerMin)    || 60;

  if (now - globalRate.windowStart > 60_000) { globalRate.count = 0; globalRate.windowStart = now; }
  if (globalRate.count >= maxGlobal) return false;

  let tr = threadRates.get(threadId) || { count: 0, windowStart: now };
  if (now - tr.windowStart > 60_000) { tr = { count: 0, windowStart: now }; }
  if (tr.count >= maxThread) return false;

  globalRate.count++;
  tr.count++;
  threadRates.set(threadId, tr);
  return true;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    // migrate sessionFile path to sessions/ folder
    if (settings.sessionFile && !settings.sessionFile.startsWith('sessions/')) {
      settings.sessionFile = 'sessions/INSTA-STATE.json';
    }
  } catch (_) {
    settings = {
      username: '', password: '', prefix: '!', adminIds: [],
      typing: true, typingDelayMs: 1200,
      replyInGroups: true, replyInDMs: true, enabled: false,
      pollIntervalMs: 4000,
      sessionFile: 'sessions/INSTA-STATE.json',
    };
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (_) {}
  }
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (_) {}
}

// ─── Session (full ig.state serialize/deserialize) ────────────────────────────
function loadSession() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8').trim();
    if (!raw || raw === '{}' || raw === '[]') return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

async function saveSession() {
  try {
    if (!ig) return;
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const state = await ig.state.serialize();
    delete state.constants;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch (e) { logErr('SESSION', `Save error: ${e.message}`); }
}

// ─── Cookie appstate loader ────────────────────────────────────────────────────
// Supports two formats:
//   "name cookies"  → array  [ {name:"sessionid", value:"xxx"}, … ]
//   "key cookies"   → object { "sessionid": "xxx", … }
// The file is sessions/INSTA-APPSTATE.json — upload it from the panel.
function loadAppstateCookies() {
  try {
    if (!fs.existsSync(APPSTATE_FILE)) return null;
    const raw  = fs.readFileSync(APPSTATE_FILE, 'utf-8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);

    // Skip if it's still the placeholder template
    if (data._comment) return null;

    let cookieArr = null;

    // Format 1: top-level "cookies" key → array or object
    if (data.cookies) {
      cookieArr = data.cookies;
    } else if (Array.isArray(data)) {
      // Format 2: bare array
      cookieArr = data;
    } else if (typeof data === 'object') {
      // Format 3: flat key→value object (key cookies)
      cookieArr = data;
    }

    if (!cookieArr) return null;

    // Normalise to { name, value } array
    let pairs = [];
    if (Array.isArray(cookieArr)) {
      // name-cookies format: [{name, value}] or [{key, value}]
      pairs = cookieArr
        .filter(c => c && (c.name || c.key) && c.value !== undefined)
        .map(c => ({ name: String(c.name || c.key), value: String(c.value) }));
    } else if (typeof cookieArr === 'object') {
      // key-cookies format: { sessionid: "xxx", ... }
      pairs = Object.entries(cookieArr)
        .filter(([k]) => !k.startsWith('_'))
        .map(([name, value]) => ({ name: String(name), value: String(value) }));
    }

    if (!pairs.length) return null;

    // Must have sessionid at minimum
    const hasSession = pairs.some(p => p.name === 'sessionid');
    if (!hasSession) {
      logErr('APPSTATE', 'Cookie file is missing "sessionid" — cannot use for login');
      return null;
    }

    return pairs;
  } catch (e) {
    logErr('APPSTATE', `Failed to read INSTA-APPSTATE.json: ${e.message}`);
    return null;
  }
}

// ─── Inject ALL important cookies into ig.state's cookie jar ─────────────────
// @fix DJAMEL — injecting only sessionid caused device-mismatch checkpoint.
//   We now inject every known Instagram cookie across all relevant domains
//   and extract the device fingerprint (ig_did, mid) so Instagram recognises
//   the same device that generated the cookies.
const INSTA_IMPORTANT_COOKIES = new Set([
  'sessionid', 'ds_user_id', 'csrftoken', 'mid', 'ig_did', 'ig_nrcb',
  'rur', 'shbts', 'shbid', 'wd', 'dpr', 'datr', 'sb',
]);
const INSTA_COOKIE_DOMAINS = [
  'https://www.instagram.com/',
  'https://i.instagram.com/',
  'https://b.instagram.com/',
];

async function injectCookies(ig, cookies) {
  let injected = 0;
  for (const cookie of cookies) {
    if (!INSTA_IMPORTANT_COOKIES.has(cookie.name)) continue;
    const line = `${cookie.name}=${cookie.value}; Domain=.instagram.com; Path=/; Secure; HttpOnly`;
    for (const url of INSTA_COOKIE_DOMAINS) {
      try { await ig.state.cookieJar.setCookie(line, url); injected++; } catch (_) {}
    }
  }
  log('LOGIN', `Injected ${injected} cookie slots across ${INSTA_COOKIE_DOMAINS.length} domains`);
}

// Extract device fingerprint from cookies and apply to ig.state
// so Instagram recognises the same device that created the session.
function applyDeviceFromCookies(ig, cookies) {
  const get = (name) => cookies.find(c => c.name === name)?.value || null;
  const igDid = get('ig_did');
  const mid   = get('mid');
  const uid   = get('ds_user_id');

  if (igDid) {
    try { ig.state.phoneId    = igDid; } catch (_) {}
    try { ig.state.uuid       = igDid; } catch (_) {}
    try { ig.state.deviceId   = 'android-' + igDid.replace(/-/g, '').slice(0, 16); } catch (_) {}
    log('LOGIN', `Device fingerprint from ig_did: ${igDid.slice(0, 18)}…`);
  }
  if (mid) {
    try { ig.state.adid = mid; } catch (_) {}
  }
  return { igDid, mid, uid };
}

// ─── Commands ─────────────────────────────────────────────────────────────────
function loadCommands() {
  commands.clear();
  try { fs.mkdirSync(CMDS_DIR, { recursive: true }); } catch (_) {}
  if (!fs.existsSync(CMDS_DIR)) return;

  const files = fs.readdirSync(CMDS_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const filePath = path.join(CMDS_DIR, file);
    try {
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);
      if (mod && mod.config && mod.config.name) {
        commands.set(mod.config.name.toLowerCase(), mod);
        // also register aliases
        if (Array.isArray(mod.config.aliases)) {
          for (const alias of mod.config.aliases) {
            commands.set(alias.toLowerCase(), mod);
          }
        }
        log('CMD', `Loaded: ${mod.config.name}`);
      }
    } catch (e) {
      logErr('CMD', `Failed to load ${file}: ${e.message}`);
    }
  }
  log('CMD', `${commands.size} command(s) loaded`);
}

// ─── Send ─────────────────────────────────────────────────────────────────────
async function sendText(threadId, text) {
  if (!ig || !loginOk) return;
  try {
    const thread = ig.entity.directThread(String(threadId));
    await thread.broadcastText(text);
  } catch (e) {
    logErr('SEND', `broadcastText failed: ${e.message}`);
    try {
      await ig.direct.sendMessage({ thread: [String(threadId)] }, text);
    } catch (e2) {
      logErr('SEND', `sendMessage fallback failed: ${e2.message}`);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Message handler ──────────────────────────────────────────────────────────
async function handleItem(thread, item) {
  if (!loginOk) return;

  const threadId = thread.thread_id;
  const isGroup  = !!thread.is_group;

  if (isGroup  && !settings.replyInGroups) return;
  if (!isGroup && !settings.replyInDMs)    return;
  if (!checkRate(threadId)) { log('RATE', `Throttled thread ${threadId}`); return; }

  const text = (item.text || '').trim();
  if (!text) return;

  const prefix = settings.prefix || '!';
  if (!text.startsWith(prefix)) return;

  const parts   = text.slice(prefix.length).trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args    = parts.slice(1);

  totalMessages++;

  const cmd = commands.get(cmdName);
  if (!cmd) return;

  totalCommands++;
  log('CMD', `[${isGroup ? 'GRP' : 'DM'}] ${prefix}${cmdName} from uid=${item.user_id}`);

  const senderId = String(item.user_id);
  const isAdmin  = Array.isArray(settings.adminIds) && settings.adminIds.includes(senderId);

  const reply = async (msg) => {
    if (settings.typing) await sleep(settings.typingDelayMs || 1200);
    await sendText(threadId, String(msg));
  };

  const event = {
    threadID:   threadId,
    senderID:   senderId,
    body:       text,
    isGroup,
    threadName: thread.thread_title || '',
    item,
    thread,
    timestamp:  item.timestamp,
  };

  try {
    await Promise.race([
      cmd.run({ ig, event, reply, args, settings, isAdmin, commands, sendText, currentUser,
        loginMethod,
        stats: { totalMessages, totalCommands, startedAt } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Command timeout 30s')), 30_000)),
    ]);
  } catch (e) {
    logErr('CMD', `Error in ${prefix}${cmdName}: ${e.message}`);
    try { await reply(`❌ خطأ: ${e.message.slice(0, 100)}`); } catch (_) {}
  }
}

// ─── MQTT realtime (replaces pure polling) ───────────────────────────────────
// Uses instagram_mqtt for push-based message delivery.
// A 60-second background safety poll runs even when MQTT is live.
// Falls back to the original poll interval if MQTT fails to connect.
async function startRealtime() {
  if (isRunning) return;
  isRunning = true;

  try {
    ig.realtime.on('receive', () => {
      if (!_mqttPollScheduled) {
        _mqttPollScheduled = true;
        setTimeout(async () => {
          _mqttPollScheduled = false;
          pollInbox().catch(e => logErr('MQTT-POLL', e.message));
        }, 600);
      }
    });

    ig.realtime.on('error', (e) => {
      logErr('MQTT', `Error: ${(e && e.message) || e}`);
    });

    ig.realtime.on('close', () => {
      _mqttConnected = false;
      log('MQTT', 'Connection closed — switching to fallback polling, will auto-reconnect in 60s');
      if (_fallbackPollTimer) { clearInterval(_fallbackPollTimer); _fallbackPollTimer = null; }
      const interval = settings.pollIntervalMs || 4000;
      _fallbackPollTimer = setInterval(pollInbox, interval);
      // @added DJAMEL — auto-reconnect MQTT after 60s if session is still valid
      setTimeout(async () => {
        if (!loginOk || _mqttConnected) return;
        log('MQTT', '🔄 Attempting MQTT auto-reconnect…');
        try {
          if (_fallbackPollTimer) { clearInterval(_fallbackPollTimer); _fallbackPollTimer = null; }
          isRunning = false;
          await startRealtime();
        } catch (e) {
          logErr('MQTT', `Auto-reconnect failed: ${e.message} — staying on fallback poll`);
          if (!_fallbackPollTimer) {
            _fallbackPollTimer = setInterval(pollInbox, interval);
          }
        }
      }, 60_000);
    });

    const irisData = await ig.feed.directInbox().request();
    await ig.realtime.connect({ irisData });
    _mqttConnected = true;
    log('MQTT', '✅ Connected to Instagram realtime (MQTT) — low-latency mode');
    // Background safety poll every 60s even when MQTT is live
    _fallbackPollTimer = setInterval(pollInbox, 60_000);
  } catch (e) {
    logErr('MQTT', `Failed to connect: ${e.message} — falling back to polling`);
    _mqttConnected = false;
    const interval = settings.pollIntervalMs || 4000;
    _fallbackPollTimer = setInterval(pollInbox, interval);
    log('POLL', `Fallback poll started — interval ${interval}ms`);
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function pollInbox() {
  if (!loginOk || !ig) return;
  try {
    lastPollAt     = new Date().toISOString();
    lastPollStatus = 'polling';

    const feed    = ig.feed.directInbox();
    const threads = await feed.items();

    for (const thread of threads) {
      for (const item of (thread.items || [])) {
        const key = item.item_id;
        if (seenItemIds.has(key)) continue;
        seenItemIds.add(key);
        if (seenItemIds.size > MAX_SEEN) {
          const arr = [...seenItemIds];
          seenItemIds = new Set(arr.slice(-MAX_SEEN));
        }
        if (currentUser && String(item.user_id) === String(currentUser.pk)) continue;
        if (item.item_type !== 'text') continue;

        handleItem(thread, item).catch(e => logErr('POLL', `handleItem: ${e.message}`));
      }
    }

    lastPollStatus = 'ok';
  } catch (e) {
    lastPollStatus = `error: ${e.message}`;
    if (e.name === 'IgLoginRequiredError' || (e.message && e.message.includes('login_required'))) {
      log('POLL', 'Session expired — re-logging in...');
      loginOk = false;
      await doLogin();
    } else {
      logErr('POLL', `Poll error: ${e.message}`);
    }
  }
}

async function seedSeenItems() {
  try {
    const feed    = ig.feed.directInbox();
    const threads = await feed.items();
    for (const thread of threads) {
      for (const item of (thread.items || [])) {
        seenItemIds.add(item.item_id);
      }
    }
    log('POLL', `Seeded ${seenItemIds.size} existing item IDs — only new messages will trigger commands`);
  } catch (e) {
    logErr('POLL', `Seed error: ${e.message}`);
  }
}

function startPollLoop() {
  if (isRunning) return;
  isRunning = true;
  const interval = settings.pollIntervalMs || 4000;
  log('POLL', `Poll loop started — interval ${interval}ms`);
  _fallbackPollTimer = setInterval(pollInbox, interval);
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function doLogin() {
  loadSettings();

  ig = withRealtime(new IgApiClient());

  // ── Step 1: Try cookie appstate file (sessions/INSTA-APPSTATE.json) ──────
  // @fix DJAMEL — inject ALL cookies + apply device fingerprint from ig_did/mid
  const cookiePairs = loadAppstateCookies();
  if (cookiePairs) {
    log('LOGIN', `📂 Found INSTA-APPSTATE.json with ${cookiePairs.length} cookies — trying full cookie login…`);
    try {
      const username = settings.username || 'instagram_user';
      ig.state.generateDevice(username);

      // Apply device fingerprint BEFORE cookie injection
      // so the library headers match the browser session
      applyDeviceFromCookies(ig, cookiePairs);

      // Inject ALL important cookies (sessionid, csrftoken, mid, ig_did, etc.)
      await injectCookies(ig, cookiePairs);

      // currentUser() verifies the session is alive
      currentUser = await ig.account.currentUser();
      loginOk     = true;
      loginMethod = 'appstate-cookies';
      _challengePending = false;
      _challengeType    = null;
      log('LOGIN', `${C.green}✅ Cookie login OK — @${currentUser.username} (uid: ${currentUser.pk})${C.reset}`);
      await saveSession();
      return true;
    } catch (e) {
      const msg = e.message || String(e);

      // ── Checkpoint: Instagram needs identity verification (email/phone code) ──
      if (e instanceof IgCheckpointError || msg.includes('checkpoint_required') || msg.includes('challenge_required')) {
        logErr('LOGIN', '⚠️  Checkpoint detected — Instagram requires verification code');
        try {
          // Extract checkpoint data from the HTTP response body
          // The library only auto-sets ig.state.checkpoint for 'challenge_required' (not 'checkpoint_required'),
          // so we extract it manually from e.response.body. — @fix DJAMEL
          const _cpBody = (e.response && e.response.body) ? e.response.body : {};
          log('LOGIN', `Checkpoint body keys: ${Object.keys(_cpBody).join(', ') || '(empty)'}`);

          // Detect "unsupported_version" — Instagram rejecting old API with browser cookies
          // (not a real verification challenge — cannot be resolved via challenge flow)
          // @fix DJAMEL
          if (_cpBody.checkpoint_url && _cpBody.checkpoint_url.includes('unsupported_version')) {
            logErr('LOGIN', '❌ Instagram API version unsupported for browser cookies');
            logErr('LOGIN', '   → Cookie login cannot work — use credential login or generate a session file locally');
            logErr('LOGIN', '   → To generate a session: run ig.account.login() on your local machine and upload INSTA-STATE.json');
            throw new Error('unsupported_version — cannot challenge');
          }

          if (_cpBody.challenge && _cpBody.challenge.api_path) {
            ig.state.checkpoint = _cpBody;
            log('LOGIN', `Checkpoint api_path: ${_cpBody.challenge.api_path}`);
          } else if (_cpBody.checkpoint_url) {
            // Extract path from URL; strip the host prefix
            let _apiPath = _cpBody.checkpoint_url
              .replace('https://i.instagram.com/api/v1', '')
              .replace('https://i.instagram.com', '');
            if (!_apiPath.startsWith('/')) _apiPath = '/' + _apiPath;
            ig.state.checkpoint = { challenge: { url: _cpBody.checkpoint_url, api_path: _apiPath } };
            log('LOGIN', `Checkpoint URL mapped: ${_cpBody.checkpoint_url} → ${_apiPath}`);
          } else if (!ig.state.checkpoint) {
            logErr('LOGIN', 'No checkpoint URL in response — cannot initiate challenge');
            throw new Error('No checkpoint data available');
          }
          await ig.challenge.auto(true);   // requests Instagram to send the code via email/SMS
          _challengePending = true;
          _challengeType    = 'checkpoint';
          log('LOGIN', `${C.yellow}📨 Challenge initiated — Instagram sent a code to your email/phone${C.reset}`);
          log('LOGIN', '   → Panel → ZAO-INSTA → Overview → enter the 6-digit code');
          log('LOGIN', '   → Or POST /insta/challenge-submit {"code":"123456"}');
          return 'challenge';   // stop retry loop — wait for user to submit code
        } catch (ce) {
          logErr('LOGIN', `Challenge auto-init failed: ${ce.message} — falling back to credentials`);
        }
      } else if (msg.includes('login_required') || msg.includes('Not authorized')) {
        logErr('LOGIN', 'Cookie login: session expired — re-export cookies from browser.');
      } else {
        logErr('LOGIN', `Cookie login failed: ${msg} — falling back to session/credentials`);
      }
      ig = withRealtime(new IgApiClient());
    }
  }

  // ── Step 2: Try saved session (INSTA-STATE.json) ──────────────────────────
  const username = settings.username;
  if (username) ig.state.generateDevice(username);

  const savedState = loadSession();
  if (savedState && username) {
    try {
      await ig.state.deserialize(savedState);
      currentUser = await ig.account.currentUser();
      loginOk    = true;
      loginMethod = 'saved-session';
      log('LOGIN', `✅ Session restored — @${currentUser.username} (${currentUser.pk})`);
      return true;
    } catch (_) {
      log('LOGIN', 'Saved session expired — trying credentials…');
      ig = withRealtime(new IgApiClient());
      if (username) ig.state.generateDevice(username);
    }
  }

  // ── Step 3: Username + Password login ─────────────────────────────────────
  if (!username || !settings.password) {
    log('LOGIN', '⚠️  No credentials set — configure from ZAO-INSTA panel or upload INSTA-APPSTATE.json');
    return false;
  }

  try {
    await ig.simulate.preLoginFlow();
    try {
      currentUser = await ig.account.login(username, settings.password);
    } catch (ce) {
      // Credential login checkpoint (Instagram suspicious-IP challenge)
      if (ce instanceof IgCheckpointError || (ce.message && (ce.message.includes('checkpoint_required') || ce.message.includes('challenge_required')))) {
        logErr('LOGIN', '⚠️  Credential checkpoint — Instagram requires verification code');
        try {
          // Same manual checkpoint extraction — @fix DJAMEL
          const _cpBody = (ce.response && ce.response.body) ? ce.response.body : {};
          log('LOGIN', `Cred-checkpoint body keys: ${Object.keys(_cpBody).join(', ') || '(empty)'}`);
          if (_cpBody.checkpoint_url && _cpBody.checkpoint_url.includes('unsupported_version')) {
            logErr('LOGIN', '❌ Credential checkpoint: unsupported_version — cannot challenge');
            throw new Error('unsupported_version — cannot challenge');
          }
          if (_cpBody.challenge && _cpBody.challenge.api_path) {
            ig.state.checkpoint = _cpBody;
          } else if (_cpBody.checkpoint_url) {
            let _apiPath = _cpBody.checkpoint_url
              .replace('https://i.instagram.com/api/v1', '')
              .replace('https://i.instagram.com', '');
            if (!_apiPath.startsWith('/')) _apiPath = '/' + _apiPath;
            ig.state.checkpoint = { challenge: { url: _cpBody.checkpoint_url, api_path: _apiPath } };
          } else if (!ig.state.checkpoint) {
            logErr('LOGIN', 'No checkpoint URL in credential response');
            throw new Error('No checkpoint data available');
          }
          await ig.challenge.auto(true);
          _challengePending = true;
          _challengeType    = 'credentials-checkpoint';
          log('LOGIN', `${C.yellow}📨 Challenge initiated — Instagram sent a code to your email/phone${C.reset}`);
          log('LOGIN', '   → Panel → ZAO-INSTA → Overview → enter the 6-digit code');
          return 'challenge';
        } catch (auto) {
          logErr('LOGIN', `Credential challenge auto-init failed: ${auto.message}`);
        }
      }
      throw ce;
    }
    await ig.simulate.postLoginFlow();
    loginOk    = true;
    loginMethod = 'credentials';
    _challengePending = false;
    _challengeType    = null;
    log('LOGIN', `✅ Fresh login OK — @${currentUser.username} (${currentUser.pk})`);
    await saveSession();
    return true;
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes('bad_password') || msg.includes('invalid_user') || msg.includes('Wrong password')) {
      logErr('LOGIN', `❌ Wrong username or password — check INSTA-SETTINGS.json`);
    } else if (msg.includes('We can send you an email') || msg.includes('help')) {
      logErr('LOGIN', `❌ Instagram locked the account — complete challenge at instagram.com first`);
    } else {
      logErr('LOGIN', `❌ Login failed: ${msg}`);
    }
    loginOk = false;
    return false;
  }
}

// ─── Internal HTTP API (port 3002) ────────────────────────────────────────────
function startApiServer() {
  const srv = http.createServer(async (req, res) => {
    const addr = req.socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const send = (data, code = 200) => {
      const body = JSON.stringify(data);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    };

    const readBody = () => new Promise((resolve, reject) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });

    const { method, url } = req;

    if (method === 'GET' && url === '/insta/status') {
      return send({
        ok: true, online: loginOk,
        loginMethod,
        username: currentUser?.username || settings.username || '—',
        uid: currentUser?.pk || null,
        startedAt, totalMessages, totalCommands,
        commandCount: commands.size,
        lastPollAt, lastPollStatus,
        mqttConnected: _mqttConnected,
        challengePending: _challengePending,
        challengeType:   _challengeType,
        settings: {
          prefix: settings.prefix,
          replyInGroups: settings.replyInGroups,
          replyInDMs: settings.replyInDMs,
          typing: settings.typing,
          enabled: settings.enabled,
        },
      });
    }

    // ── Challenge status ─────────────────────────────────────────────────────
    if (method === 'GET' && url === '/insta/challenge-status') {
      return send({
        ok: true,
        challengePending: _challengePending,
        challengeType:    _challengeType,
      });
    }

    // ── Challenge submit — user enters the 6-digit verification code ─────────
    // @added DJAMEL — lets the admin complete Instagram identity verification from panel
    if (method === 'POST' && url === '/insta/challenge-submit') {
      try {
        const body = await readBody();
        const code = String(body.code || '').trim();
        if (!code) return send({ error: 'code field required' }, 400);
        if (!_challengePending || !ig) {
          return send({ error: 'No pending challenge — use تغيير الكوكيز first to trigger one' }, 400);
        }
        log('LOGIN', `📩 Challenge code submitted: ${code}`);
        try {
          const loggedUser = await ig.challenge.sendSecurityCode(code);
          currentUser       = loggedUser;
          loginOk           = true;
          loginMethod       = _challengeType === 'credentials-checkpoint' ? 'credentials' : 'appstate-cookies';
          _challengePending = false;
          _challengeType    = null;
          log('LOGIN', `${C.green}✅ Challenge verified — @${currentUser.username} (${currentUser.pk})${C.reset}`);
          await saveSession();
          if (!isRunning) {
            await seedSeenItems();
            await startRealtime();
            startProtection();
            log('BOOT', `${C.green}✅ Bot started after challenge — method: ${loginMethod}${C.reset}`);
          }
          return send({ ok: true, username: currentUser.username, uid: currentUser.pk });
        } catch (e) {
          if (e instanceof IgChallengeWrongCodeError) {
            return send({ error: 'الكود غلط — تحقق وحاول مرة أخرى' }, 400);
          }
          _challengePending = false;
          _challengeType    = null;
          logErr('LOGIN', `Challenge submit error: ${e.message}`);
          return send({ error: `Challenge failed: ${e.message}` }, 500);
        }
      } catch (e) { return send({ error: e.message }, 500); }
    }

    if (method === 'GET' && url === '/insta/commands') {
      return send({
        ok: true,
        commands: [...new Set(commands.values())].map(mod => ({
          name: mod.config.name,
          description: mod.config?.description || '',
          usage: mod.config?.usage || mod.config?.usages || '',
          adminOnly: mod.config?.adminOnly || false,
          aliases: mod.config?.aliases || [],
        })),
      });
    }

    if (method === 'POST' && url === '/insta/send') {
      try {
        const body = await readBody();
        if (!body.threadId || !body.message) return send({ error: 'threadId and message required' }, 400);
        await sendText(body.threadId, body.message);
        return send({ ok: true });
      } catch (e) { return send({ error: e.message }, 500); }
    }

    if (method === 'POST' && url === '/insta/reload-cmds') {
      loadCommands();
      return send({ ok: true, count: commands.size });
    }

    if (method === 'POST' && url === '/insta/save-settings') {
      try {
        const body = await readBody();
        const oldCreds = `${settings.username}:${settings.password}`;
        settings = { ...settings, ...body };
        saveSettings();
        const newCreds = `${settings.username}:${settings.password}`;
        const needsRestart = (oldCreds !== newCreds);
        send({ ok: true, needsRestart });
        if (needsRestart) { setTimeout(() => process.exit(0), 800); }
        return;
      } catch (e) { return send({ error: e.message }, 500); }
    }

    if (method === 'POST' && url === '/insta/restart') {
      send({ ok: true });
      setTimeout(() => process.exit(0), 400);
      return;
    }

    if (method === 'GET' && url === '/insta/threads') {
      if (!loginOk || !ig) return send({ ok: false, error: 'Bot offline' });
      try {
        const feed    = ig.feed.directInbox();
        const threads = await feed.items();
        return send({
          ok: true,
          threads: threads.slice(0, 30).map(t => ({
            threadId:         t.thread_id,
            title:            t.thread_title || (t.users?.[0]?.username ? '@' + t.users[0].username : '—'),
            isGroup:          !!t.is_group,
            participantCount: (t.users || []).length,
            lastItemAt:       t.last_permanent_item?.timestamp || null,
          })),
        });
      } catch (e) { return send({ ok: false, error: e.message }); }
    }

    // Upload appstate cookies via API
    if (method === 'POST' && url === '/insta/upload-appstate') {
      try {
        const body = await readBody();
        if (!body.cookies) return send({ error: 'cookies field required' }, 400);
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(APPSTATE_FILE, JSON.stringify({ cookies: body.cookies }, null, 2), 'utf-8');
        send({ ok: true, message: 'Appstate saved — restart bot to apply' });
        return;
      } catch (e) { return send({ error: e.message }, 500); }
    }

    // ── HOT cookie reload — apply new INSTA-APPSTATE.json WITHOUT restart ──────
    // @added DJAMEL — lets admin update cookies from the panel without stopping the bot
    if (method === 'POST' && url === '/insta/reload-cookies') {
      try {
        const body = await readBody();

        // If cookies were sent in the request body, save them first
        if (body.cookies) {
          let cookieData;
          if (typeof body.cookies === 'string') {
            cookieData = JSON.parse(body.cookies);
          } else {
            cookieData = body.cookies;
          }
          fs.mkdirSync(SESSIONS_DIR, { recursive: true });
          fs.writeFileSync(APPSTATE_FILE, JSON.stringify(
            Array.isArray(cookieData) ? cookieData : { cookies: cookieData }, null, 2
          ), 'utf-8');
          log('LOGIN', '📥 New cookie file saved via hot-reload endpoint');
        }

        const cookiePairs = loadAppstateCookies();
        if (!cookiePairs) return send({ error: 'No valid cookies found in INSTA-APPSTATE.json' }, 400);

        if (!ig) {
          // Bot not yet initialized — do full login
          const ok = await doLogin();
          return send({ ok, message: ok ? 'Full login successful' : 'Login failed — check logs' });
        }

        // Apply to RUNNING ig instance without restart
        log('LOGIN', `🔄 Hot-reloading cookies (${cookiePairs.length} cookies)…`);
        try {
          applyDeviceFromCookies(ig, cookiePairs);
          await injectCookies(ig, cookiePairs);
          currentUser = await ig.account.currentUser();
          loginOk     = true;
          loginMethod = 'appstate-cookies';
          _challengePending = false;
          _challengeType    = null;
          log('LOGIN', `${C.green}✅ Hot-reload OK — @${currentUser.username}${C.reset}`);
          await saveSession();
          if (!isRunning) {
            await seedSeenItems();
            await startRealtime();
            startProtection();
          }
          return send({ ok: true, username: currentUser.username, uid: currentUser.pk });
        } catch (e) {
          const emsg = e.message || String(e);
          // Hot-reload also triggered a checkpoint → initiate challenge
          if (e instanceof IgCheckpointError || emsg.includes('checkpoint_required') || emsg.includes('challenge_required')) {
            logErr('LOGIN', '⚠️  Hot-reload: checkpoint detected — initiating challenge…');
            try {
              // Manual checkpoint extraction — @fix DJAMEL
              const _cpBody = (e.response && e.response.body) ? e.response.body : {};
              if (_cpBody.challenge && _cpBody.challenge.api_path) {
                ig.state.checkpoint = _cpBody;
              } else if (_cpBody.checkpoint_url) {
                const _apiPath = _cpBody.checkpoint_url.replace('https://i.instagram.com/api/v1', '') || _cpBody.checkpoint_url;
                ig.state.checkpoint = { challenge: { url: _cpBody.checkpoint_url, api_path: _apiPath } };
              }
              await ig.challenge.auto(true);
              _challengePending = true;
              _challengeType    = 'checkpoint';
              log('LOGIN', `${C.yellow}📨 Challenge initiated — submit the code in the Overview panel${C.reset}`);
              return send({ ok: false, challenge: true, message: 'Instagram sent a verification code — submit it from the panel' });
            } catch (ce) {
              logErr('LOGIN', `Challenge auto-init failed: ${ce.message}`);
            }
          }
          logErr('LOGIN', `Hot-reload failed: ${emsg} — attempting full re-login`);
          ig = withRealtime(new IgApiClient());
          const result = await doLogin();
          if (result === 'challenge') {
            return send({ ok: false, challenge: true, message: 'Challenge initiated — submit code from panel' });
          }
          return send({ ok: !!result, message: result ? 'Re-login successful' : `Re-login failed: ${emsg}` });
        }
      } catch (e) { return send({ error: e.message }, 500); }
    }

    res.writeHead(404); res.end('Not Found');
  });

  srv.listen(INSTA_API_PORT, '127.0.0.1', () => {
    log('API', `Internal API on port ${INSTA_API_PORT}`);
  });
  srv.on('error', e => logErr('API', `Server error: ${e.message}`));
}

// ─── Protection systems v2 ────────────────────────────────────────────────────
// @upgraded DJAMEL — added exponential backoff re-login + rate limit monitor
let _reloginAttempts = 0;

async function _reloginWithBackoff() {
  const maxAttempts = 5;
  const baseDelay   = 30_000; // 30 seconds
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const delay = baseDelay * Math.pow(2, attempt - 1); // 30s, 60s, 120s, 240s, 480s
    log('PROTECT', `Re-login attempt ${attempt}/${maxAttempts} in ${delay / 1000}s…`);
    await new Promise(r => setTimeout(r, delay));
    ig = withRealtime(new IgApiClient());
    const ok = await doLogin();
    if (ok) {
      _reloginAttempts = 0;
      log('PROTECT', `${C.green}✅ Re-login successful on attempt ${attempt}${C.reset}`);
      // Restart realtime after re-login
      isRunning = false;
      await startRealtime();
      return true;
    }
    logErr('PROTECT', `Re-login attempt ${attempt} failed`);
  }
  logErr('PROTECT', `All ${maxAttempts} re-login attempts failed — will retry on next protection cycle`);
  return false;
}

function startProtection() {
  // Save session every 10 minutes
  setInterval(saveSession, 10 * 60 * 1000);

  // Verify session every 30 minutes with backoff re-login
  setInterval(async () => {
    if (!ig || !loginOk) return;
    try {
      await ig.account.currentUser();
      _reloginAttempts = 0; // reset on success
    } catch (e) {
      log('PROTECT', `Session check failed (${e.message}) — re-logging in with backoff`);
      loginOk = false;
      await _reloginWithBackoff();
    }
  }, 30 * 60 * 1000);

  // Monitor rate limits — log warning if poll is failing
  setInterval(() => {
    if (!loginOk) return;
    if (lastPollStatus && lastPollStatus.startsWith('error:')) {
      logErr('PROTECT', `⚠️  Poll status: ${lastPollStatus}`);
    }
  }, 5 * 60 * 1000);

  log('PROTECT', `${C.yellow}✓ Session saver active (every 10 min)${C.reset}`);
  log('PROTECT', `${C.yellow}✓ Login verifier active (every 30 min, backoff re-login)${C.reset}`);
  log('PROTECT', `${C.yellow}✓ Rate limit monitor active (every 5 min)${C.reset}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
// @updated DJAMEL — exponential backoff retry loop, better startup logging
async function main() {
  log('BOOT', `${C.cyan}══════════════════════════════════════${C.reset}`);
  log('BOOT', `${C.bold}${C.cyan}   ZAO-INSTA — Instagram Bot Module v2  ${C.reset}`);
  log('BOOT', `${C.cyan}   by SAIN | fixes by DJAMEL            ${C.reset}`);
  log('BOOT', `${C.cyan}══════════════════════════════════════${C.reset}`);

  try { fs.mkdirSync(DATA_DIR,     { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(CMDS_DIR,     { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (_) {}

  loadSettings();
  loadCommands();
  startApiServer();

  // Check if we have either appstate cookies OR username/password
  const hasAppstate    = !!loadAppstateCookies();
  const hasCredentials = !!(settings.username && settings.password);

  if (!hasAppstate && !hasCredentials) {
    log('BOOT', `${C.yellow}⚠️  Instagram credentials not set${C.reset}`);
    log('BOOT', '   Option 1: Upload sessions/INSTA-APPSTATE.json (cookies from Cookie-Editor)');
    log('BOOT', '   Option 2: Panel → ZAO-INSTA → الإعدادات → enter username + password');
    log('BOOT', '   💡 Chrome extension: Cookie-Editor (cgagnier) → export as JSON → upload');
    log('BOOT', '   Bot API running on port 3002 — waiting for credentials…');
    return;
  }

  // Retry loop with exponential backoff (max 5 attempts before waiting 10 min)
  const MAX_BOOT_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = Math.min(30_000 * Math.pow(2, attempt - 2), 600_000); // 30s, 60s, 120s, 240s, max 10min
      log('BOOT', `Retry attempt ${attempt}/${MAX_BOOT_ATTEMPTS} in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }

    const result = await doLogin();

    // ── Challenge pending — stop retrying, wait for user to submit code ──────
    if (result === 'challenge') {
      log('BOOT', `${C.yellow}⏸️  Login paused — awaiting verification code from user${C.reset}`);
      log('BOOT', '   Panel → ZAO-INSTA → Overview → تأكيد الهوية');
      log('BOOT', '   After submitting the code the bot will start automatically');
      return;  // challenge-submit endpoint will resume the bot
    }

    if (result === true) {
      await seedSeenItems();
      await startRealtime();
      startProtection();
      log('BOOT', `${C.green}${C.bold}✅ ZAO-INSTA ready — @${currentUser?.username} | method: ${loginMethod} | prefix: "${settings.prefix}"${C.reset}`);
      log('BOOT', `${C.magenta}📡 Mode: ${_mqttConnected ? 'MQTT realtime ✓' : `Polling every ${settings.pollIntervalMs || 4000}ms`}${C.reset}`);
      return;
    }

    logErr('BOOT', `Login attempt ${attempt}/${MAX_BOOT_ATTEMPTS} failed`);
  }

  logErr('BOOT', `❌ All ${MAX_BOOT_ATTEMPTS} login attempts failed — bot will stay in standby`);
  log('BOOT', '   Upload valid cookies via panel → ZAO-INSTA → الإعدادات → تغيير الكوكيز');
  log('BOOT', '   Or use POST /insta/reload-cookies to apply cookies without restart');
}

process.on('SIGTERM', () => {
  log('SHUTDOWN', 'SIGTERM — saving session and exiting');
  if (_fallbackPollTimer) clearInterval(_fallbackPollTimer);
  if (pollTimer) clearInterval(pollTimer);
  try { if (ig && ig.realtime && _mqttConnected) ig.realtime.disconnect(); } catch (_) {}
  saveSession().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  if (_fallbackPollTimer) clearInterval(_fallbackPollTimer);
  if (pollTimer) clearInterval(pollTimer);
  try { if (ig && ig.realtime && _mqttConnected) ig.realtime.disconnect(); } catch (_) {}
  saveSession().finally(() => process.exit(0));
});

process.on('uncaughtException',   e => logErr('CRASH',     e.message + '\n' + e.stack));
process.on('unhandledRejection',  r => logErr('REJECTION', String(r?.message || r)));

main().catch(e => { logErr('MAIN', e.message); process.exit(1); });
