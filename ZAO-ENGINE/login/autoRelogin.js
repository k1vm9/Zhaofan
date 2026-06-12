"use strict";

/**
 * ZAO Auto Re-Login
 * ==================
 * When the session expires this module tries to re-establish it.
 * It is multi-account-aware: it tries the same tier that is currently
 * active first (refreshing cookies), then advances to the next tier
 * if the current one is permanently dead.
 *
 * Tier order: 1 → 2 → 3
 *   Tier 1: ZAO-STATE.json / alt.json      (+ email/password fallback)
 *   Tier 2: ZAO-STATEX.json / altx.json
 *   Tier 3: ZAO-STATEV.json / altv.json
 */

const { loginAsync } = require("../fcaClient");
const fs             = require("fs-extra");
const path           = require("path");
const parseAppState  = require("./parseAppState");
const { patchCookieApi } = require("../zaoCookiePatcher");
// [FIX Djamel] — atomic writes for tier-state files. A torn write here
// would lose the active-tier marker AND corrupt the cookie file, forcing
// the bot back to Tier 1 on every restart.
const { atomicWriteFileSync } = (() => {
  try { return require("../../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: fs.writeFileSync.bind(fs) }; }
})();

// ── Tier persistence (mirrors logic in Emalogin/index.js) ────────────────────
const TIER_PERSIST_FILE = path.join(process.cwd(), "data", "active-tier.json");
function writePersistedTier(tier) {
  try {
    fs.ensureDirSync(path.dirname(TIER_PERSIST_FILE));
    atomicWriteFileSync(TIER_PERSIST_FILE, JSON.stringify({ tier, ts: new Date().toISOString() }, null, 2), "utf-8");
  } catch (_) {}
}

// Upgrade #8: configurable delays from ZAO-SETTINGS.json / global.config
function _getCooldownMs() {
  try {
    const v = (global.config && global.config.reloginCooldownMinutes) ||
              require("../../ZAO-SETTINGS.json").reloginCooldownMinutes;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 60 * 1000);
  } catch (_) {}
  return 3 * 60 * 1000; // default: 3 minutes
}

function _getMaxRetries() {
  try {
    const v = (global.config && global.config.reloginMaxRetries) ||
              require("../../ZAO-SETTINGS.json").reloginMaxRetries;
    const n = parseInt(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  return 4; // default
}

const RESTART_DELAY = 3000;

// ── Tier definitions (configurable via ZAO-SETTINGS.json "tierLimit") ────────
// Full pool of 5 tiers — the active slice is controlled by `tierLimit` (1–5).
// Tier 1: ZAO-STATE.json  / alt.json   / ZAO-STATEC.json
// Tier 2: ZAO-STATEX.json / altx.json  / ZAO-STATEXC.json
// Tier 3: ZAO-STATEV.json / altv.json  / ZAO-STATEVC.json
// Tier 4: ZAO-STATE4.json / alt4.json  / ZAO-STATE4C.json
// Tier 5: ZAO-STATE5.json / alt5.json  / ZAO-STATE5C.json
const ALL_TIERS = [
  { tier: 1, stateFile: "sessions/ZAO-STATE.json",  altFile: "sessions/alt.json",  credsFile: "sessions/ZAO-STATEC.json"  },
  { tier: 2, stateFile: "sessions/ZAO-STATEX.json", altFile: "sessions/altx.json", credsFile: "sessions/ZAO-STATEXC.json" },
  { tier: 3, stateFile: "sessions/ZAO-STATEV.json", altFile: "sessions/altv.json", credsFile: "sessions/ZAO-STATEVC.json" },
  { tier: 4, stateFile: "sessions/ZAO-STATE4.json", altFile: "sessions/alt4.json", credsFile: "sessions/ZAO-STATE4C.json" },
  { tier: 5, stateFile: "sessions/ZAO-STATE5.json", altFile: "sessions/alt5.json", credsFile: "sessions/ZAO-STATE5C.json" },
];

function _buildTiers() {
  try {
    const cfg = global.config || require("../../ZAO-SETTINGS.json");
    const limit = parseInt(cfg.tierLimit);
    if (Number.isFinite(limit) && limit >= 1 && limit <= ALL_TIERS.length) {
      return ALL_TIERS.slice(0, limit);
    }
  } catch (_) {}
  return ALL_TIERS.slice(0, 3); // default: 3 tiers (backwards compatible)
}

// Lazily evaluated so `global.config` is available at call time.
// Callers should use getTiers() instead of TIERS directly.
let _tiersCache = null;
function getTiers() {
  if (!_tiersCache) _tiersCache = _buildTiers();
  return _tiersCache;
}
// Keep TIERS as a live proxy for backwards compatibility with any code that
// directly references the variable. It will always reflect the current limit.
const TIERS = new Proxy([], {
  get(_, prop) { return getTiers()[prop]; },
  set(_, prop, value) { getTiers()[prop] = value; return true; },
});

let lastAttempt   = 0;
let retryCount    = 0;
let isAttempting  = false;
let currentTierIdx = 0;  // index into TIERS[]

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: "[ RELOGIN ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
  console[level === "error" ? "error" : "log"]("[RELOGIN]", msg);
}

function notifyAdmins(api, message) {
  try {
    const admins = global.config?.ADMINBOT || [];
    for (const adminID of admins) {
      const id = String(adminID).trim();
      if (!id) continue;
      api.sendMessage(message, id).catch(() => {});
    }
  } catch (_) {}
}

function buildLoginOptions() {
  return Object.assign({
    autoReconnect: true,
    listenEvents: true,
    autoMarkRead: true,
    simulateTyping: true,
    randomUserAgent: false,
    persona: "desktop",
    maxConcurrentRequests: 5,
    maxRequestsPerMinute: 50,
    requestCooldownMs: 60000,
    errorCacheTtlMs: 300000,
  }, global.config?.FCAOption || {});
}

function saveState(stateFile, altFile, appState) {
  try {
    const data = JSON.stringify(appState, null, 2);
    // [FIX Djamel] — atomic writes prevent half-written cookie files
    // when the bot is killed mid-save (very common during the
    // RESTART_DELAY window after a successful relogin).
    atomicWriteFileSync(stateFile, data, "utf-8");
    if (altFile && fs.existsSync(path.dirname(altFile))) {
      atomicWriteFileSync(altFile, data, "utf-8");
    }
    // [PROTECT] Cookie snapshot ring — fresh login = great moment to capture
    // a known-good snapshot for the watchdog's restore path.
    try {
      const snap = require("../cookieSnapshot");
      snap.snapshot(appState, stateFile);
    } catch (_) {}
  } catch (_) {}
}

function readCredsFile(credsFullPath) {
  try {
    if (!fs.existsSync(credsFullPath)) return null;
    const data = JSON.parse(fs.readFileSync(credsFullPath, "utf-8").trim());
    if (data && data.email && data.password) return { email: data.email, password: data.password };
    return null;
  } catch (_) {
    return null;
  }
}

async function tryTierLogin(tierInfo, api) {
  const cwd  = process.cwd();
  const opts = buildLoginOptions();
  const ua   = opts.userAgent || global.config?.FCAOption?.userAgent;

  const stateFullPath = path.join(cwd, tierInfo.stateFile);
  const altFullPath   = path.join(cwd, tierInfo.altFile);
  const credsFullPath = path.join(cwd, tierInfo.credsFile);

  // ── 1. Try main state file ──────────────────────────────────────
  let parsed = await parseAppState(stateFullPath, ua);
  if (parsed && Array.isArray(parsed.appState) && parsed.appState.length > 0) {
    try {
      const newApi = await loginAsync({ appState: parsed.appState }, opts);
      const uid    = newApi && newApi.getCurrentUserID ? newApi.getCurrentUserID() : null;
      if (uid && uid !== "0") return { newApi, stateFullPath, altFullPath };
    } catch (_) {}
  }

  // ── 2. Try alt file ─────────────────────────────────────────────
  if (fs.existsSync(altFullPath)) {
    parsed = await parseAppState(altFullPath, ua);
    if (parsed && Array.isArray(parsed.appState) && parsed.appState.length > 0) {
      try {
        const newApi = await loginAsync({ appState: parsed.appState }, opts);
        const uid    = newApi && newApi.getCurrentUserID ? newApi.getCurrentUserID() : null;
        if (uid && uid !== "0") return { newApi, stateFullPath, altFullPath };
      } catch (_) {}
    }
  }

  // ── 3. Try creds file for this tier ─────────────────────────────
  const fileCreds = readCredsFile(credsFullPath);
  if (fileCreds) {
    try {
      const newApi = await loginAsync({ email: fileCreds.email, password: fileCreds.password }, opts);
      const uid    = newApi && newApi.getCurrentUserID ? newApi.getCurrentUserID() : null;
      if (uid && uid !== "0") return { newApi, stateFullPath, altFullPath };
    } catch (_) {}
  }

  // ── 4. Config/env credentials (Tier 1 only, always tried as last resort) ─
  // This runs whether or not a creds file was present — the file might have
  // existed but contained wrong credentials, so we must still fall through to
  // the global config/env credentials before giving up on Tier 1.
  if (tierInfo.tier === 1) {
    const email    = process.env.FB_EMAIL    || global.config?.EMAIL;
    const password = process.env.FB_PASSWORD || global.config?.PASSWORD;
    if (email && password) {
      try {
        const newApi = await loginAsync({ email, password }, opts);
        const uid    = newApi && newApi.getCurrentUserID ? newApi.getCurrentUserID() : null;
        if (uid && uid !== "0") return { newApi, stateFullPath, altFullPath };
      } catch (_) {}
    }
  }

  return null;
}

/**
 * Immediately skip the current tier and attempt the next one.
 * Called by the AccountHealthMonitor when send failures are confirmed.
 * Bypasses the normal cooldown/retry-count gate.
 *
 * @param {object} api    - Current (possibly dead) FCA API instance
 * @param {string} reason - Why the forced switch was requested
 */
async function forceTierSwitch(api, reason) {
  if (isAttempting) {
    log("warn", "forceTierSwitch: re-login already in progress — skipping.");
    return false;
  }

  // [PROTECT] Network-Probe — before burning a tier slot, confirm Facebook is
  // actually reachable. A transient DNS/network blip on Replit otherwise
  // triggers a real tier walk, which compounds risk on the account pool.
  try {
    const probe = require("../networkProbe");
    const reachable = await probe.isFacebookReachable({ ttlMs: 30 * 1000 });
    if (!reachable) {
      log("warn", "forceTierSwitch: skipped — edge-mqtt.facebook.com unreachable (network blip). Will retry when network recovers.");
      return false;
    }
  } catch (_) {}

  // Resolve which tier we're on right now
  const activeTier = global.activeAccountTier || 1;
  let idx = TIERS.findIndex(t => t.tier === activeTier);
  if (idx === -1) idx = 0;

  isAttempting = true;

  // [FIX Djamel] — previous version tried ONLY the next tier and bailed.
  // If Tier 2 was dead and we were on Tier 1, the bot would keep failing
  // at Tier 2 forever and never reach Tier 3. Now we walk forward through
  // every remaining tier in the same call so a single forceTierSwitch
  // truly exhausts the account pool.
  // [FIX Djamel #2] — added a small per-tier cooldown between attempts so
  // back-to-back tier walks don't generate three near-simultaneous logins
  // from the same IP (Facebook's login throttle treats that as a brute-force
  // burst and locks every account in the pool).
  const PER_TIER_DELAY_MS = 12 * 1000;
  let loginResult = null;
  let tierInfo    = null;
  let firstAttemptInWalk = true;
  for (let nextIdx = idx + 1; nextIdx < TIERS.length; nextIdx++) {
    tierInfo = TIERS[nextIdx];
    if (!firstAttemptInWalk) {
      const wait = PER_TIER_DELAY_MS + Math.floor(Math.random() * 4000);
      log("info", `forceTierSwitch: spacing tier attempts — waiting ${Math.round(wait/1000)}s before Tier ${tierInfo.tier}.`);
      await new Promise(r => setTimeout(r, wait));
    }
    firstAttemptInWalk = false;

    log("warn", `forceTierSwitch → Tier ${tierInfo.tier} (${tierInfo.stateFile}) | reason: ${reason || "send failures"}`);
    // H-06 fix: notify AFTER success not before, to avoid misleading admins when
    // the login attempt fails. The success notification is sent at line ~348 below.
    // Here we only log internally so operators can trace the attempt without getting
    // a false "switching to tier X" DM that never completes.

    try {
      loginResult = await tryTierLogin(tierInfo, api);
    } catch (e) {
      log("error", `forceTierSwitch: Tier ${tierInfo.tier} login threw: ${e.message}`);
      loginResult = null;
    }

    if (loginResult) {
      currentTierIdx = nextIdx;
      retryCount     = 0;
      lastAttempt    = 0;
      break;
    }

    log("error", `forceTierSwitch: Tier ${tierInfo.tier} failed — trying next tier...`);
    notifyAdmins(api, `❌ HEALTH MONITOR: Tier ${tierInfo.tier} also failed.`);
  }

  if (!loginResult) {
    isAttempting = false;
    log("error", `forceTierSwitch: all tiers after Tier ${activeTier} have been tried — none succeeded.`);
    notifyAdmins(api,
      `⛔ HEALTH MONITOR: all account tiers have been tried.\n` +
      `Please upload fresh cookie files via the panel.\n` +
      `Reason: ${reason || "send failures"}`
    );
    // Force the relogin module to start the cycle from scratch on next call
    retryCount = _getMaxRetries();
    return false;
  }

  const { newApi, stateFullPath, altFullPath } = loginResult;
  try {
    const freshState = newApi.getAppState ? newApi.getAppState() : [];
    saveState(stateFullPath, altFullPath, freshState);
    retryCount               = 0;
    global.activeAccountTier = tierInfo.tier;
    global.activeStateFile   = stateFullPath;
    global.activeAltFile     = altFullPath;
    global.loginMethod       = "appstate";
    patchCookieApi(newApi, {
      tier:        tierInfo.tier,
      stateFile:   stateFullPath,
      altFile:     altFullPath,
      loginMethod: "appstate"
    });
    writePersistedTier(tierInfo.tier);
    try { require("./statePersist").save(); } catch (_) {}
    log("info", `forceTierSwitch: success — Tier ${tierInfo.tier}. Restarting in ${RESTART_DELAY / 1000}s...`);
    notifyAdmins(api,
      `✅ HEALTH MONITOR: switched to Tier ${tierInfo.tier} successfully.\nBot restarting...`
    );
    // S2-02: Stop old api's nkxfcaModernizer timers (health broadcast, cache
    // flush, etc.) before the process exits so they don't fire during the
    // RESTART_DELAY window against a now-stale api reference.
    try {
      if (typeof api.__nkxModernizerStop === 'function') {
        api.__nkxModernizerStop().catch(() => {});
      }
    } catch (_) {}
    // Lock the flag so no new relogin attempt can start during the exit window
    isAttempting = true;
    setTimeout(async () => {
      // Flush Labyrinth E2EE key store before exit to prevent partial-write
      // corruption (KeyStore._flush is async; give it a chance to complete).
      try {
        const _lab = global._labyrinth;
        if (_lab && _lab.keyStore && typeof _lab.keyStore._flush === 'function') {
          await _lab.keyStore._flush();
        }
      } catch (_) {}
      process.exit(0);
    }, RESTART_DELAY);
    return true;
  } catch (saveErr) {
    // [FIX Djamel] — without resetting isAttempting here a save failure
    // would jam the relogin module forever ("already in progress").
    isAttempting = false;
    log("error", `forceTierSwitch: login ok but could not save cookies: ${saveErr.message}`);
    return false;
  }
};

/**
 * Main re-login entry point.
 * @param {object} api    - Current (possibly dead) FCA API instance
 * @param {string} reason - Why re-login was triggered
 */
async function autoRelogin(api, reason) {
  const now = Date.now();

  if (isAttempting) {
    log("warn", "Already attempting re-login — skipping duplicate call.");
    return false;
  }

  const COOLDOWN_MS = _getCooldownMs();
  if (now - lastAttempt < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastAttempt)) / 1000);
    log("warn", `Cooldown active. Next attempt in ${waitSec}s.`);
    return false;
  }

  // [PROTECT] Network-Probe — confirm Facebook is reachable before attempting
  // a re-login. Saves a wasted attempt (and its rate-limit cost) when the
  // session "death" was actually a transient network failure on the host.
  try {
    const probe = require("../networkProbe");
    const reachable = await probe.isFacebookReachable({ ttlMs: 30 * 1000 });
    if (!reachable) {
      log("warn", `autoRelogin: skipped — Facebook edge unreachable. Will retry after cooldown. (reason was: ${reason || 'unknown'})`);
      return false;
    }
  } catch (_) {}

  // Sync current tier index from global state
  const activeTier = global.activeAccountTier || 1;
  currentTierIdx   = TIERS.findIndex(t => t.tier === activeTier);
  if (currentTierIdx === -1) currentTierIdx = 0;

  const MAX_RETRIES = _getMaxRetries();
  if (retryCount >= MAX_RETRIES) {
    // This tier is exhausted — advance to the next one
    if (currentTierIdx + 1 < TIERS.length) {
      currentTierIdx++;
      retryCount = 0;
      log("warn", `Tier ${activeTier} exhausted. Advancing to Tier ${TIERS[currentTierIdx].tier}...`);
    } else {
      const retryMs = _getCooldownMs(); // default 3 minutes
      log("error", `All ${TIERS.length} account tiers exhausted — retrying from Tier 1 in ${Math.round(retryMs / 60000)} minutes.`);
      notifyAdmins(
        api,
        `⛔ ALL ACCOUNT TIERS FAILED\n\n` +
        `Tried all ${TIERS.length} tiers — none could login.\n` +
        `Will automatically retry in ${Math.round(retryMs / 60000)} minutes.\n` +
        `You can also upload fresh cookies via the panel.`
      );
      // Reset state so next call starts from Tier 1
      currentTierIdx = 0;
      retryCount     = 0;
      lastAttempt    = Date.now(); // cooldown starts now → next attempt after retryMs
      // Self-schedule: try again after the cooldown without relying on external triggers
      setTimeout(async () => {
        if (!isAttempting) {
          log("info", `Scheduled retry after full exhaustion — starting fresh from Tier 1.`);
          try { await autoRelogin(api, "scheduled retry after tier exhaustion"); } catch (_) {}
        }
      }, retryMs + 1000); // +1s so cooldown gate is clear
      return false;
    }
  }

  isAttempting = true;
  lastAttempt  = now;
  retryCount++;

  const tierInfo   = TIERS[currentTierIdx];
  const reasonMsg  = reason
    ? ` | reason=${String(reason && (reason.message || reason.error || reason)).slice(0, 180)}`
    : "";

  log("info", `Re-login attempt ${retryCount}/${_getMaxRetries()} — Tier ${tierInfo.tier} (${tierInfo.stateFile})${reasonMsg}`);
  notifyAdmins(
    api,
    `🔄 SESSION EXPIRED — Attempting auto re-login...\n` +
    `Tier ${tierInfo.tier} | Attempt ${retryCount}/${_getMaxRetries()}` +
    (reasonMsg ? `\n${reasonMsg}` : "")
  );

  let loginResult = null;
  try {
    loginResult = await tryTierLogin(tierInfo, api);
  } catch (e) {
    log("error", `Re-login threw error: ${e.message}`);
  }

  isAttempting = false;

  if (!loginResult) {
    log("error", `Re-login failed for Tier ${tierInfo.tier}.`);
    notifyAdmins(
      api,
      `❌ AUTO RELOGIN FAILED (Tier ${tierInfo.tier} attempt ${retryCount}/${_getMaxRetries()})`
    );
    return false;
  }

  const { newApi, stateFullPath, altFullPath } = loginResult;

  try {
    const freshState = newApi.getAppState ? newApi.getAppState() : [];
    saveState(stateFullPath, altFullPath, freshState);

    retryCount                = 0;
    global.activeAccountTier  = tierInfo.tier;
    global.activeStateFile    = stateFullPath;
    global.activeAltFile      = altFullPath;
    global.loginMethod        = "appstate";

    patchCookieApi(newApi, {
      tier:        tierInfo.tier,
      stateFile:   stateFullPath,
      altFile:     altFullPath,
      loginMethod: "appstate"
    });

    writePersistedTier(tierInfo.tier);
    // Persist any pending callbacks before restart
    try { require("./statePersist").save(); } catch (_) {}

    log("info", `Re-login success — Tier ${tierInfo.tier}. Restarting in ${RESTART_DELAY / 1000}s...`);
    notifyAdmins(
      api,
      `✅ AUTO RELOGIN SUCCESS\n\nTier ${tierInfo.tier} session restored. Bot is restarting...`
    );

    // Lock the flag so no new relogin attempt can start during the exit window
    isAttempting = true;
    setTimeout(async () => {
      // Flush Labyrinth E2EE key store before exit to prevent partial-write
      // corruption (KeyStore._flush is async; give it a chance to complete).
      try {
        const _lab = global._labyrinth;
        if (_lab && _lab.keyStore && typeof _lab.keyStore._flush === 'function') {
          await _lab.keyStore._flush();
        }
      } catch (_) {}
      process.exit(0);
    }, RESTART_DELAY);
    return true;

  } catch (saveErr) {
    log("error", `Re-login succeeded but could not save cookies: ${saveErr.message}`);
    notifyAdmins(api, `❌ Re-login succeeded but failed to save: ${saveErr.message}`);
    return false;
  }
}

module.exports                   = autoRelogin;
module.exports.forceTierSwitch   = forceTierSwitch;
