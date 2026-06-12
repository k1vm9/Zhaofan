'use strict';

const { spawn }  = require('child_process');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
// [FIX Djamel] — atomic writes for settings + cookie files served by
// the panel API. A panel save mid-write would otherwise corrupt the
// active config or appstate.
const { atomicWriteFileSync } = (() => {
  try { return require('./utils/atomicWrite'); }
  catch (_) { return { atomicWriteFileSync: fs.writeFileSync.bind(fs) }; }
})();

// ─── Platform detection ────────────────────────────────────────────────────
const _platform = (() => {
  try { return require('./ZAO-ENGINE/utils/platformDetect'); }
  catch (_) { return { name: 'local', label: 'Local', port: parseInt(process.env.PORT || '5000', 10) }; }
})();
const PORT          = _platform.port;
const BOT_API_PORT   = 3001;
const BOT2_API_PORT  = 3003;
const INSTA_API_PORT = 3002;
const __dir          = __dirname;
const ALT_PATH      = path.join(__dir, 'sessions', 'alt.json');
const STATE_PATH    = path.join(__dir, 'sessions', 'ZAO-STATE.json');
const SETTINGS_PATH = path.join(__dir, 'ZAO-SETTINGS.json');
const CMDS_PATH     = path.join(__dir, 'SCRIPTS', 'ZAO-CMDS');

function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

log('ZAO', '══════════════════════════════════════');
log('ZAO', '   ZAO Bot — Unified Launcher          ');
log('ZAO', '   by SAIN — Single-bot mode           ');
log('ZAO', '══════════════════════════════════════');
log('ZAO', `Platform: ${_platform.label} | Port: ${PORT}${_platform.publicUrl ? ' | URL: ' + _platform.publicUrl : ''}`);

let botChild            = null;
let restarts            = 0;
let botStart            = Date.now();
let isStopping          = false;
let pendingRestartTimer = null; // [FIX M8] — tracked so shutdown() can cancel it

// ─── Secondary bot (Tier 2 active mode) ────────────────────────────────────
let botChild2       = null;
let restarts2       = 0;
let botStart2       = Date.now();
let pendingRestart2 = null;

// ─── Persistent restart counter + first-start timestamp ────────────────────
const DATA_DIR            = path.join(__dir, 'data');
const RESTART_STATS_FILE  = path.join(DATA_DIR, 'restart-stats.json');
const FIRST_START_FILE    = path.join(DATA_DIR, 'first-start.json');
const RESTART_HISTORY_FILE  = path.join(DATA_DIR, 'restart-history.json');
const SESSION_HISTORY_FILE  = path.join(DATA_DIR, 'session-history.json');

let totalRestarts = 0;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (_) {}
// Always reset restart counter on every cold start (new deployment).
// Bot-child crashes are tracked within the session via `restarts`, not persisted.
try {
  atomicWriteFileSync(RESTART_STATS_FILE,
    JSON.stringify({ total: 0, resetDate: new Date().toISOString() }, null, 2), 'utf-8');
} catch (_) {}
// Always reset uptime clock on every cold start (new deployment).
try {
  const currentPlatform = _platform.name;
  fs.writeFileSync(FIRST_START_FILE,
    JSON.stringify({ ts: Date.now(), date: new Date().toISOString(), platform: currentPlatform }, null, 2), 'utf-8');
} catch (_) {}

const logBuffer  = [];
const MAX_BUFFER = 1000;
const sseClients = new Set();
global._mainLogBuffer = logBuffer; // shared with AI Monitor (same process)

// ─── Instagram bot state ───────────────────────────────────────────────────
const instaLogBuffer  = [];
const MAX_INSTA_BUFFER = 500;
let instaChild   = null;
let instaRestarts = 0;

function appendInstaLog(line) {
  const entry = { ts: new Date().toISOString(), text: line };
  instaLogBuffer.push(entry);
  if (instaLogBuffer.length > MAX_INSTA_BUFFER) instaLogBuffer.shift();
}

const _crashFP = (() => {
  try { return require('./ZAO-ENGINE/crashFingerprinter'); } catch (_) { return null; }
})();

require('./ZAO-ENGINE/utils/netmon').start(() => {
  isStopping = true;
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  if (botChild) { try { botChild.kill('SIGKILL'); } catch (_) {} botChild = null; }
});

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJ]/g, '').replace(/\r/g, '');
}

function appendLog(line) {
  const entry = { ts: new Date().toISOString(), text: line };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  // [FIX Djamel] — snapshot the Set into an array before iterating so that
  // delete() inside the catch can never confuse the live iterator. The
  // previous in-place delete during for…of worked in V8 today but relied on
  // implementation behaviour and risked dropping fan-out to peer clients.
  for (const client of Array.from(sseClients)) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

function readBody(req) {
  const MAX_BODY = 512 * 1024; // 512 KB — prevents oversized POST from consuming unbounded memory
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); return reject(new Error('Request body too large (max 512 KB)')); }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonRes(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function proxyToBot(method, botPath, body, res) {
  // [FIX H6] — single-response guard: timeout destroy() and the error event
  // can both fire in close succession, previously causing "headers already sent"
  // crashes. `responded` ensures exactly one reply reaches the client.
  let responded = false;
  function replyOnce(status, data) {
    if (responded) return;
    responded = true;
    jsonRes(res, data, status);
  }

  const opts = {
    hostname: '127.0.0.1',
    port: BOT_API_PORT,
    path: botPath,
    method,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body ? Buffer.byteLength(body) : 0 }
  };
  const proxyReq = http.request(opts, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      if (responded) return;
      responded = true;
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });
  proxyReq.on('error', () => {
    replyOnce(503, { error: 'Bot API unavailable. Bot may not be connected yet.', connected: false });
  });
  proxyReq.setTimeout(8000, () => {
    proxyReq.destroy();
    replyOnce(503, { error: 'Bot API timed out after 8s.', connected: false });
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

// ─── Bot control helpers for the webpanel ─────────────────────────────────────
function restartBotFn() {
  if (botChild) {
    try { botChild.kill('SIGTERM'); } catch (_) {}
  }
}

function killBotFn() {
  isStopping = true;
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  if (botChild) {
    try { botChild.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { if (botChild) { try { botChild.kill('SIGKILL'); } catch (_) {} } }, 3000);
  }
}

function lockBotFn() {
  const body = '{"value":true}';
  const opts = { hostname: '127.0.0.1', port: BOT_API_PORT, path: '/bot/lock', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
  const r = http.request(opts, () => {}); r.on('error', () => {}); r.write(body); r.end();
}

function unlockBotFn() {
  const body = '{"value":false}';
  const opts = { hostname: '127.0.0.1', port: BOT_API_PORT, path: '/bot/lock', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
  const r = http.request(opts, () => {}); r.on('error', () => {}); r.write(body); r.end();
}

// ─── Secondary bot (Tier 2) control ─────────────────────────────────────────────
function readTierModes() {
  try {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return cfg.tierModes || {};
  } catch (_) { return {}; }
}

function startBot2() {
  if (isStopping || botChild2 !== null) return;
  if (pendingRestart2) { clearTimeout(pendingRestart2); pendingRestart2 = null; }

  log('BOT2', 'Starting secondary bot (Tier 2)...');

  botChild2 = spawn(process.execPath, ['ZAO.js'], {
    cwd:   __dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env:   { ...process.env, FORCE_COLOR: '1', UV_THREADPOOL_SIZE: '8',
             BOT_TIER: '2', BOT_API_PORT: String(BOT2_API_PORT) },
  });

  botStart2 = Date.now();
  log('BOT2', `ZAO.js (Tier 2) started — PID ${botChild2.pid}`);
  appendLog(`[BOT2] Started ZAO.js Tier-2 (PID ${botChild2.pid})`);

  botChild2.stdout.on('data', chunk => {
    const raw = chunk.toString();
    process.stdout.write(raw);
    const clean = stripAnsi(raw);
    clean.split('\n').forEach(line => { if (line.trim()) appendLog('[T2] ' + line.trim()); });
  });

  botChild2.stderr.on('data', chunk => {
    const raw = chunk.toString();
    process.stderr.write(raw);
    const clean = stripAnsi(raw);
    clean.split('\n').forEach(line => { if (line.trim()) appendLog('[T2-ERR] ' + line.trim()); });
  });

  botChild2.on('error', err => {
    botChild2 = null;
    log('BOT2', `Spawn error: ${err.message}`);
    if (!isStopping && readTierModes()['2'] === 'active') {
      if (pendingRestart2) clearTimeout(pendingRestart2);
      pendingRestart2 = setTimeout(startBot2, 30_000);
    }
  });

  botChild2.on('close', code => {
    botChild2 = null;
    appendLog(`[BOT2] ZAO.js Tier-2 exited with code ${code}`);
    if (isStopping) return;
    if (readTierModes()['2'] !== 'active') return;
    restarts2++;
    const delay = restarts2 === 1 ? 30_000 : 10 * 60 * 1000;
    log('BOT2', `Tier-2 crash #${restarts2} — restarting in ${Math.round(delay / 1000)}s`);
    if (pendingRestart2) clearTimeout(pendingRestart2);
    pendingRestart2 = setTimeout(startBot2, delay);
  });
}

function stopBot2(permanent = false) {
  if (pendingRestart2) { clearTimeout(pendingRestart2); pendingRestart2 = null; }
  if (permanent) restarts2 = 0;
  if (botChild2) {
    try { botChild2.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { if (botChild2) { try { botChild2.kill('SIGKILL'); } catch (_) {} } }, 5000);
  }
}

function checkSecondaryTier() {
  const modes = readTierModes();
  if (modes['2'] === 'active') {
    if (!botChild2) startBot2();
  } else {
    if (botChild2) stopBot2(true);
  }
}

// ─── Instagram bot control ─────────────────────────────────────────────────────
let instaStartPending = null;

function startInstaBot() {
  if (isStopping) return;
  if (instaChild !== null) return;
  if (instaStartPending) { clearTimeout(instaStartPending); instaStartPending = null; }

  // Only start if credentials are configured
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dir, 'INSTA-SETTINGS.json'), 'utf-8'));
    if (!cfg.username) {
      log('INSTA', 'No Instagram credentials — API server will wait for config');
    }
  } catch (_) {}

  instaChild = spawn(process.execPath, ['INSTA.js'], {
    cwd:   __dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env:   { ...process.env, FORCE_COLOR: '1' },
  });

  log('INSTA', `ZAO-INSTA started — PID ${instaChild.pid}`);
  appendInstaLog(`[INSTA-WATCHDOG] Started INSTA.js (PID ${instaChild.pid})`);

  instaChild.stdout.on('data', chunk => {
    const raw   = chunk.toString();
    process.stdout.write(raw);
    const clean = stripAnsi(raw);
    clean.split('\n').forEach(line => { if (line.trim()) appendInstaLog(line.trim()); });
  });

  instaChild.stderr.on('data', chunk => {
    const raw   = chunk.toString();
    process.stderr.write(raw);
    const clean = stripAnsi(raw);
    clean.split('\n').forEach(line => { if (line.trim()) appendInstaLog('[ERR] ' + line.trim()); });
  });

  instaChild.on('error', err => {
    instaChild = null;
    log('INSTA', `Spawn error: ${err.message}`);
    if (!isStopping) {
      if (instaStartPending) clearTimeout(instaStartPending);
      instaStartPending = setTimeout(startInstaBot, 30_000);
    }
  });

  instaChild.on('close', code => {
    instaChild = null;
    appendInstaLog(`[INSTA-WATCHDOG] INSTA.js exited with code ${code}`);
    if (isStopping) return;
    if (instaStartPending) { clearTimeout(instaStartPending); instaStartPending = null; }

    if (code === 0) {
      instaStartPending = setTimeout(startInstaBot, 2_000);
      return;
    }
    instaRestarts++;
    const delay = instaRestarts === 1 ? 30_000 : 10 * 60 * 1000;
    log('INSTA', `Crash #${instaRestarts} — restarting in ${Math.round(delay / 1000)}s`);
    instaStartPending = setTimeout(startInstaBot, delay);
  });
}

function restartInstaFn() {
  if (instaChild) { try { instaChild.kill('SIGTERM'); } catch (_) {} }
}

function killInstaFn() {
  if (instaStartPending) { clearTimeout(instaStartPending); instaStartPending = null; }
  if (instaChild) {
    try { instaChild.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { if (instaChild) { try { instaChild.kill('SIGKILL'); } catch (_) {} } }, 3000);
  }
}

// ─── Start webpanel (replaces old minimal panel/index.html server) ─────────────
require('./webpanel/zao-server').start({
  logBuffer,
  sseClients,
  appendLog,
  getBotChild:  () => botChild,
  getRestarts:  () => totalRestarts,
  restartBotFn,
  killBotFn,
  lockBotFn,
  unlockBotFn,
  port:         PORT,
  botApiPort:   BOT_API_PORT,
  instaApiPort:  INSTA_API_PORT,
  instaLogBuffer,
  getInstaChild: () => instaChild,
  getInstaRestarts: () => instaRestarts,
  restartInstaFn,
  killInstaFn,
  getBotChild2:     () => botChild2,
  getRestarts2:     () => restarts2,
  startBot2Fn:      startBot2,
  stopBot2Fn:       () => stopBot2(true),
  bot2ApiPort:      BOT2_API_PORT,
});

// [FIX Djamel] — restoreCookies now handles ALL three tiers, not just Tier 1.
// Exposed for webpanel tier-mode API (see getBotChild2, startBot2Fn, etc. below).
global._zaoBot2 = { startBot2, stopBot2, checkSecondaryTier, getBotChild2: () => botChild2, getRestarts2: () => restarts2 };
// Previously a corrupt ZAO-STATEX.json or ZAO-STATEV.json would never be
// restored from its sibling alt file, so a crash on Tier 2 or 3 would
// permanently nuke that tier on disk and force a downgrade to Tier 1.
function _validAppStateFile(p) {
  try {
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    if (!raw) return false;
    const data = JSON.parse(raw);
    return Array.isArray(data) && data.length > 0;
  } catch (_) {
    return false;
  }
}

function restoreCookies() {
  const TIER_PAIRS = [
    { state: STATE_PATH,                                                  alt: ALT_PATH },
    { state: path.join(__dir, 'sessions', 'ZAO-STATEX.json'),     alt: path.join(__dir, 'sessions', 'altx.json') },
    { state: path.join(__dir, 'sessions', 'ZAO-STATEV.json'),     alt: path.join(__dir, 'sessions', 'altv.json') },
  ];

  // [PROTECT] Cookie snapshot ring — load lazily so a missing module never
  // breaks the watchdog's startup path.
  const snap = (() => { try { return require('./ZAO-ENGINE/cookieSnapshot'); } catch (_) { return null; } })();

  for (const pair of TIER_PAIRS) {
    try {
      if (_validAppStateFile(pair.state)) continue;

      // Path 1 (preferred): mirror the sibling alt file when it's intact.
      if (_validAppStateFile(pair.alt)) {
        const altRaw = fs.readFileSync(pair.alt, 'utf-8').trim();
        atomicWriteFileSync(pair.state, altRaw, 'utf-8');
        log('PROTECT', `تم استعادة ${path.basename(pair.state)} من ${path.basename(pair.alt)} ✓`);
        continue;
      }

      // Path 2 (fallback): both state and alt are gone/corrupt — try the
      // snapshot ring before giving up. This is the situation that would
      // otherwise force a full re-login (the most account-risky operation).
      if (snap && typeof snap.restoreLatestValid === 'function') {
        const r = snap.restoreLatestValid(pair.state);
        if (r && r.ok) {
          // Mirror the restored state back to the alt file too, so future
          // restoreCookies() calls find a valid alt and the watchdog stays
          // on the fast path.
          try {
            const restored = fs.readFileSync(pair.state, 'utf-8').trim();
            if (restored) atomicWriteFileSync(pair.alt, restored, 'utf-8');
          } catch (_) {}
          log('PROTECT', `تم استعادة ${path.basename(pair.state)} من snapshot (${path.basename(r.file)}) ✓ — لا حاجة لإعادة تسجيل الدخول`);
          continue;
        } else if (r) {
          log('PROTECT', `لا يوجد snapshot صالح لـ ${path.basename(pair.state)} — ${r.reason || 'unknown'}`);
        }
      }
    } catch (e) {
      log('PROTECT', `خطأ في الاستعادة (${path.basename(pair.state)}): ${e.message}`);
    }
  }
}

const MAX_RESTARTS = 100;
const STABLE_MS    = 10 * 60 * 1000;
// [FIX Djamel] — Crash retry policy redesigned per user request:
//   • CLEAN_DELAY: clean exit (autoRelogin success) → restart immediately.
//   • QUICK_DELAY: a single fast retry after the FIRST crash, in case the
//     crash was transient (e.g. one-off network blip). Avoids 10 minutes
//     of downtime for benign crashes.
//   • CRASH_INTERVAL_MS: from the second crash onward, wait 10 minutes
//     between restart attempts. This gives the tier-switching logic a
//     full breath cycle and stops the watchdog from hammering Facebook
//     in tight loops, which is what gets accounts permanently banned.
const CLEAN_DELAY        = 1_000;
const QUICK_DELAY        = 30_000;
const CRASH_INTERVAL_MS  = 10 * 60 * 1000;

function startBot() {
  if (isStopping) return;

  // [FIX DUPE-1] — Guard against double-spawn. Both botChild.on('error') and
  // botChild.on('close') can fire for the same child in sequence. Without this
  // check, two pending timers can each call startBot() and each successfully
  // spawn a new ZAO.js, giving you two listeners on the same Facebook session.
  if (botChild !== null) {
    log('WATCHDOG', 'startBot() called while child already running — ignoring duplicate spawn');
    return;
  }

  // [FIX DUPE-2] — Cancel any orphaned restart timer from a previous close/error
  // pair before spawning. This ensures we never accumulate stale timers.
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }

  restoreCookies();

  botChild = spawn(process.execPath, ['ZAO.js'], {
    cwd:   __dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env:   { ...process.env, FORCE_COLOR: '1', UV_THREADPOOL_SIZE: '8' },
  });

  botStart = Date.now();
  log('WATCHDOG', `تم تشغيل ZAO.js — PID ${botChild.pid} — إعادة تشغيل رقم ${restarts}`);

  // Record session start
  try {
    let sessions = [];
    try { sessions = JSON.parse(fs.readFileSync(SESSION_HISTORY_FILE, 'utf-8')); } catch (_) {}
    if (!Array.isArray(sessions)) sessions = [];
    sessions.push({ startTs: botStart, startDate: new Date(botStart).toISOString(), endTs: null, uptimeMs: null, exitCode: null, sessionNum: totalRestarts + 1 });
    if (sessions.length > 10) sessions = sessions.slice(-10);
    atomicWriteFileSync(SESSION_HISTORY_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
  } catch (_) {}
  appendLog(`[WATCHDOG] Started ZAO.js (PID ${botChild.pid}) — restart #${restarts}`);

  botChild.stdout.on('data', chunk => {
    const raw = chunk.toString();
    process.stdout.write(raw);
    const clean = stripAnsi(raw);
    const lines = clean.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        appendLog(line.trim());
        if (_crashFP) _crashFP.feedLine(line.trim());
      }
    }
  });

  botChild.stderr.on('data', chunk => {
    const raw = chunk.toString();
    process.stderr.write(raw);
    const clean = stripAnsi(raw);
    const lines = clean.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        appendLog('[ERR] ' + line.trim());
        if (_crashFP) _crashFP.feedLine('[ERR] ' + line.trim());
      }
    }
  });

  botChild.on('error', (err) => {
    log('WATCHDOG', `خطأ في spawn: ${err.message}`);
    appendLog(`[WATCHDOG] Spawn error: ${err.message}`);
    // [FIX M6] — spawn errors did not schedule a restart, leaving the launcher
    // permanently orphaned with no child. Now we retry after QUICK_DELAY.
    botChild = null;
    if (!isStopping) {
      // [FIX DUPE-3] — Cancel any existing timer before scheduling a new one.
      // The 'close' event may fire right after 'error' and would otherwise
      // create a second orphaned timer that startBot() can no longer cancel.
      if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
      log('WATCHDOG', `Spawn failed — retrying in ${Math.round(QUICK_DELAY / 1000)}s...`);
      pendingRestartTimer = setTimeout(startBot, QUICK_DELAY);
    }
  });

  botChild.on('close', (code) => {
    botChild = null;
    appendLog(`[WATCHDOG] ZAO.js exited with code ${code}`);
    if (code && code !== 0 && _crashFP) {
      try { _crashFP.recordCrash(code); } catch (_) {}
    }
    if (isStopping) return;

    // [FIX DUPE-4] — The 'error' event may have already scheduled a restart timer.
    // Cancel it here so the 'close' handler is the single authority on next action.
    if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }

    const uptime = Date.now() - botStart;

    // Update last session entry with end info
    try {
      let sessions = [];
      try { sessions = JSON.parse(fs.readFileSync(SESSION_HISTORY_FILE, 'utf-8')); } catch (_) {}
      if (Array.isArray(sessions) && sessions.length > 0) {
        const last = sessions[sessions.length - 1];
        if (last && last.endTs == null) {
          last.endTs    = Date.now();
          last.uptimeMs = uptime;
          last.exitCode = code;
          atomicWriteFileSync(SESSION_HISTORY_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
        }
      }
    } catch (_) {}

    if (code === 0) {
      // Clean exit usually means autoRelogin succeeded and asked us to
      // cycle. Restart immediately and reset the crash counter.
      log('WATCHDOG', 'خروج نظيف — إعادة التشغيل فوراً...');
      restarts = 0;
      pendingRestartTimer = setTimeout(startBot, CLEAN_DELAY);
      return;
    }

    if (uptime >= STABLE_MS) {
      // The bot stayed up for at least the stable window before crashing,
      // so this is treated as a fresh single failure, not a crash loop.
      log('WATCHDOG', `كان مستقراً ${Math.round(uptime / 60000)} دقيقة — إعادة تعيين عداد الأعطال.`);
      restarts = 0;
    }

    restarts++;
    totalRestarts++;
    log('WATCHDOG', `انتهى بكود ${code} — محاولة ${restarts}/${MAX_RESTARTS} | إجمالي عمليات التشغيل: ${totalRestarts}`);

    // Persist total restarts and append restart history ring (last 3)
    try {
      atomicWriteFileSync(RESTART_STATS_FILE,
        JSON.stringify({ total: totalRestarts, lastUpdated: new Date().toISOString() }, null, 2), 'utf-8');
      let history = [];
      try { history = JSON.parse(fs.readFileSync(RESTART_HISTORY_FILE, 'utf-8')); } catch (_) {}
      if (!Array.isArray(history)) history = [];
      history.push({ ts: Date.now(), date: new Date().toISOString(), code, uptimeMs: uptime });
      if (history.length > 10) history = history.slice(-10);
      atomicWriteFileSync(RESTART_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    } catch (_) {}

    if (restarts > MAX_RESTARTS) {
      log('WATCHDOG', `تجاوز الحد الأقصى — انتظار 10 دقائق.`);
      restarts = Math.floor(MAX_RESTARTS / 2);
      pendingRestartTimer = setTimeout(startBot, CRASH_INTERVAL_MS);
      return;
    }

    // [FIX Djamel] — 10-minute interval between crash retries (per user request).
    // First crash gets a 30-second grace retry in case the failure was
    // transient (network blip, momentary FCA glitch). From the second
    // crash onward we wait a full 10 minutes so:
    //   1. tier-switching logic in Emalogin can cycle accounts cleanly,
    //   2. Facebook stops seeing rapid login bursts that look bot-like,
    //   3. the operator gets a predictable rhythm to inspect logs.
    const delay = (restarts === 1) ? QUICK_DELAY : CRASH_INTERVAL_MS;
    log('WATCHDOG', `إعادة التشغيل بعد ${Math.round(delay / 60000)} دقيقة (${Math.round(delay / 1000)} ثانية)...`);
    pendingRestartTimer = setTimeout(startBot, delay);
  });
}

function shutdown(signal) {
  isStopping = true;
  log('LAUNCHER', `استُقبل ${signal} — إيقاف تشغيل ZAO...`);

  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  if (pendingRestart2)     { clearTimeout(pendingRestart2);     pendingRestart2 = null; }
  if (instaStartPending)   { clearTimeout(instaStartPending);   instaStartPending = null; }

  if (instaChild) {
    try { instaChild.kill('SIGTERM'); } catch (_) {}
  }

  if (botChild2) {
    try { botChild2.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { if (botChild2) { try { botChild2.kill('SIGKILL'); } catch (_) {} } }, 5000);
  }

  if (botChild) {
    try { botChild.kill('SIGTERM'); } catch (_) {}
    // [FIX S14] — Escalate to SIGKILL after 6s (was 3s). ZAO.js graceful
    // shutdown drains for 2s then saves cookies + DB, taking ~2.5s total.
    // The old 3s window was shorter than the drain, so SIGKILL always fired
    // mid-drain and could corrupt cookie files. 6s gives a comfortable margin.
    setTimeout(() => {
      if (botChild) {
        log('LAUNCHER', 'Child did not exit after SIGTERM — sending SIGKILL');
        try { botChild.kill('SIGKILL'); } catch (_) {}
      }
    }, 6000);
  }
  setTimeout(() => process.exit(0), 8_000);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason || 'unknown');
  log('LAUNCHER', `unhandledRejection: ${msg}`);
});

process.on('uncaughtException', (err) => {
  log('LAUNCHER', `uncaughtException: ${err?.message || err}`);
});

startBot();
startInstaBot();
checkSecondaryTier();
