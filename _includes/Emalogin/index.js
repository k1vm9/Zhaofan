"use strict";

const { writeFileSync, existsSync, readFileSync } = require("fs");
const { join }  = require("path");
const { loginAsync } = require("../fcaClient");
const parseAppState  = require("../login/parseAppState");
const { patchCookieApi } = require("../zaoCookiePatcher");
// [FIX Djamel] — atomic writes for cookie state files. Without this a
// SIGKILL during the initial saveState would leave both the main and
// alt cookie files truncated, locking the user out on next boot.
const { atomicWriteFileSync } = (() => {
  try { return require("../../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: writeFileSync }; }
})();

// ── Tier persistence helpers ─────────────────────────────────────────────────
// Store the last-active tier to disk so restarts resume from the right account
// instead of always falling back to Tier 1.
const TIER_PERSIST_FILE = join(process.cwd(), "data", "active-tier.json");

function readPersistedTier() {
  try {
    if (!existsSync(TIER_PERSIST_FILE)) return 1;
    const raw  = readFileSync(TIER_PERSIST_FILE, "utf-8").trim();
    const data = JSON.parse(raw);
    const t    = parseInt(data && data.tier, 10);
    if (t >= 1 && t <= 3) return t;
  } catch (_) {}
  return 1;
}

function writePersistedTier(tier) {
  try {
    require("fs-extra").ensureDirSync(require("path").dirname(TIER_PERSIST_FILE));
    atomicWriteFileSync(TIER_PERSIST_FILE, JSON.stringify({ tier, ts: new Date().toISOString() }, null, 2), "utf-8");
  } catch (_) {}
}

/**
 * ZAO Multi-Account Login Module
 * ================================
 * Tries three account tiers in order, falling back on failure:
 *
 *   Tier 1 — ZAO-STATE.json  + alt.json      (primary account)
 *   Tier 2 — ZAO-STATEX.json + altx.json     (secondary account)
 *   Tier 3 — ZAO-STATEV.json + altv.json     (tertiary account)
 *
 * Within each tier the flow is:
 *   1. Try the main state file
 *   2. If that fails, try the alt (backup) file for the same tier
 *   3. If both cookie files fail AND tier 1 has email/password → try credentials
 *
 * On success the fresh AppState is written back to BOTH files of that tier
 * so the next boot reuses the live session.
 *
 * The active tier is stored in global.activeAccountTier (1 / 2 / 3) so
 * the autoRelogin module knows which files to update.
 */

const TIERS = [
  { tier: 1, stateFile: "sessions/ZAO-STATE.json",  altFile: "sessions/alt.json",  credsFile: "sessions/ZAO-STATEC.json"  },
  { tier: 2, stateFile: "sessions/ZAO-STATEX.json", altFile: "sessions/altx.json", credsFile: "sessions/ZAO-STATEXC.json" },
  { tier: 3, stateFile: "sessions/ZAO-STATEV.json", altFile: "sessions/altv.json", credsFile: "sessions/ZAO-STATEVC.json" },
];

function buildLoginOptions(extra = {}) {
  const nkxDefaults = {
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
    // ZAO has its own autoRelogin + accountHealthMonitor — disable FCA's
    // built-in session watcher so there's no double-polling of Facebook.
    autoReLogin: false,
  };
  return Object.assign({}, nkxDefaults, global.config?.FCAOption || {}, extra);
}

function saveState(stateFile, altFile, appState) {
  try {
    const data = JSON.stringify(appState, null, 2);
    atomicWriteFileSync(stateFile, data, "utf-8");
    if (altFile) atomicWriteFileSync(altFile, data, "utf-8");
  } catch (e) {
    console.warn(`[ Login ]: Warning — could not save cookies: ${e.message}`);
  }
}

async function tryLoginWithFile(filePath, loginOptions, label) {
  const userAgent = loginOptions.userAgent || global.config?.FCAOption?.userAgent;
  const parsed    = await parseAppState(filePath, userAgent);

  if (!parsed || !Array.isArray(parsed.appState) || parsed.appState.length === 0) {
    console.log(`[ Login ]: ${label} — no usable AppState in ${filePath}`);
    return null;
  }

  const { appState, confident } = parsed;
  if (!confident) {
    console.log(`[ Login ]: ${label} — cookies in ${filePath} could not be pre-validated, trying anyway...`);
  } else {
    console.log(`[ Login ]: ${label} — session confirmed alive, logging in via AppState...`);
  }

  try {
    const api = await loginAsync({ appState }, loginOptions);
    const uid  = api && api.getCurrentUserID ? api.getCurrentUserID() : null;
    if (!uid || uid === "0") {
      throw new Error("FCA returned userID=0 — session rejected by Facebook.");
    }
    console.log(`[ Login ]: ${label} — AppState login successful ✓  (uid=${uid})`);
    return { api, appState: api.getAppState ? api.getAppState() : appState };
  } catch (e) {
    console.error(`[ Login ]: ${label} — AppState login rejected: ${e.message}`);
    return null;
  }
}

async function tryLoginWithCredentials(email, password, loginOptions, label) {
  if (!email || !password) {
    console.log(`[ Login ]: ${label} — no email/password configured, skipping credential login.`);
    return null;
  }
  console.log(`[ Login ]: ${label} — attempting credential login for ${email}...`);
  // [FIX] forceLogin must be true for credential-based logins. When forceLogin is false
  // nkxfca may attempt to reuse a cached/stale session from a previous failed appState
  // login, causing a false "Wrong password / email" error even with valid credentials.
  // We also relax rate-limiting for the login call itself.
  const credOptions = Object.assign({}, loginOptions, {
    forceLogin: true,
    maxRequestsPerMinute: 30,
    requestCooldownMs: 5000,
  });
  try {
    const api = await loginAsync({ email, password }, credOptions);
    const uid  = api && api.getCurrentUserID ? api.getCurrentUserID() : null;
    if (!uid || uid === "0") {
      throw new Error("Credentials login returned userID=0 — Facebook may have blocked the login.");
    }
    console.log(`[ Login ]: ${label} — credential login successful ✓  (uid=${uid})`);
    return { api, appState: api.getAppState ? api.getAppState() : [] };
  } catch (e) {
    console.error(`[ Login ]: ${label} — credential login failed: ${e.message}`);
    return null;
  }
}

/**
 * Reads email + password from a creds JSON file.
 * Expected format: { "email": "...", "password": "..." }
 * Returns null if the file doesn't exist or is malformed.
 */
function readCredsFile(credsFullPath) {
  try {
    if (!existsSync(credsFullPath)) return null;
    const raw  = readFileSync(credsFullPath, "utf-8").trim();
    const data = JSON.parse(raw);
    if (data && data.email && data.password) return { email: data.email, password: data.password };
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = async function multiAccountLogin({ FCAOption = {}, email, password } = {}) {
  const loginOptions = buildLoginOptions(FCAOption);
  const cwd          = process.cwd();

  // Global config credentials are used as a last-resort for Tier 1 only
  const configEmail    = email    || process.env.FB_EMAIL    || global.config?.EMAIL;
  const configPassword = password || process.env.FB_PASSWORD || global.config?.PASSWORD;

  // ── Tier persistence: resume from the last-active tier if known ──────────
  // On crash+restart the watchdog restores Tier 1 cookies, but if the active
  // tier at crash time was 2 or 3 we start there to avoid re-triggering with
  // a known-restricted Tier 1 account.
  const persistedTier = readPersistedTier();
  if (persistedTier > 1) {
    console.log(`[ Login ]: Persisted tier = ${persistedTier} — starting login loop from Tier ${persistedTier}.`);
  }

  // Build an ordered list: [persistedTier, persistedTier+1, ..., 3, 1, 2, ..., persistedTier-1]
  // This ensures we always try the last-known-good tier first, then advance, then wrap around.
  const tiersOrdered = [];
  for (let i = 0; i < TIERS.length; i++) {
    tiersOrdered.push(TIERS[(persistedTier - 1 + i) % TIERS.length]);
  }

  // BOT_TIER env var: when running a secondary bot instance, lock it to a
  // specific tier so it never falls back to a tier already used by another
  // instance. Example: BOT_TIER=2 forces this process to use Tier 2 only.
  const forcedTier = parseInt(process.env.BOT_TIER, 10);
  const tiersToTry = (forcedTier >= 1 && forcedTier <= TIERS.length)
    ? TIERS.filter(t => t.tier === forcedTier)
    : tiersOrdered;

  if (forcedTier >= 1 && forcedTier <= TIERS.length) {
    console.log(`[ Login ]: BOT_TIER=${forcedTier} — locked to Tier ${forcedTier} only (no fallback).`);
  }

  for (const tierInfo of tiersToTry) {
    const { tier, stateFile, altFile, credsFile } = tierInfo;
    const stateFullPath = join(cwd, stateFile);
    const altFullPath   = join(cwd, altFile);
    const credsFullPath = join(cwd, credsFile);
    const label         = `Tier ${tier}`;

    console.log(`[ Login ]: ── Trying ${label} (${stateFile}) ──`);

    // helper: record success for this tier
    function _recordSuccess(api, method) {
      saveState(stateFullPath, altFullPath, api.getAppState ? api.getAppState() : []);
      global.loginMethod       = method;
      global.activeAccountTier = tier;
      global.activeStateFile   = stateFullPath;
      global.activeAltFile     = altFullPath;
      writePersistedTier(tier);
      return patchCookieApi(api, { tier, stateFile: stateFullPath, altFile: altFullPath, loginMethod: method });
    }

    // ── 1. Try main state file ──────────────────────────────────────
    let result = await tryLoginWithFile(stateFullPath, loginOptions, `${label}/${stateFile}`);

    if (result) {
      const api = _recordSuccess(result.api, "appstate");
      console.log(`[ Login ]: Active account — ${label} via ${stateFile} ✓`);
      return api;
    }

    // ── 2. Try alt file for same tier ──────────────────────────────
    if (existsSync(altFullPath)) {
      console.log(`[ Login ]: ${label} — main file failed, trying alt (${altFile})...`);
      result = await tryLoginWithFile(altFullPath, loginOptions, `${label}/${altFile}`);

      if (result) {
        const api = _recordSuccess(result.api, "appstate-alt");
        console.log(`[ Login ]: Active account — ${label} via ${altFile} (alt) ✓`);
        return api;
      }
    }

    // ── 3. Try creds file for this tier ────────────────────────────
    const fileCreds = readCredsFile(credsFullPath);
    if (fileCreds) {
      console.log(`[ Login ]: ${label} — cookie files failed, trying ${credsFile}...`);
      result = await tryLoginWithCredentials(fileCreds.email, fileCreds.password, loginOptions, `${label}/${credsFile}`);

      if (result) {
        const api = _recordSuccess(result.api, "credentials");
        console.log(`[ Login ]: Active account — ${label} via ${credsFile} ✓`);
        return api;
      }
    }

    // ── 4. Config/env credentials fallback (Tier 1 only) ───────────
    if (tier === 1 && !fileCreds && (configEmail || configPassword)) {
      console.log(`[ Login ]: ${label} — trying ZAO-SETTINGS.json credentials...`);
      result = await tryLoginWithCredentials(configEmail, configPassword, loginOptions, `${label}/config`);

      if (result) {
        const api = _recordSuccess(result.api, "credentials");
        console.log(`[ Login ]: Active account — Tier 1 via ZAO-SETTINGS.json credentials ✓`);
        return api;
      }
    }

    console.log(`[ Login ]: ${label} — all methods failed, moving to next tier...`);
  }

  // All tiers exhausted — clear the persisted tier so next restart tries Tier 1 fresh
  writePersistedTier(1);

  // All tiers exhausted
  console.error(
    "[ Login ]: All account tiers failed.\n" +
    "  → Tier 1: ZAO-STATE.json / alt.json / ZAO-STATEC.json / ZAO-SETTINGS credentials\n" +
    "  → Tier 2: ZAO-STATEX.json / altx.json / ZAO-STATEXC.json\n" +
    "  → Tier 3: ZAO-STATEV.json / altv.json / ZAO-STATEVC.json\n" +
    "  Add valid cookies or a creds file to one of these paths via the panel."
  );
  return null;
};
