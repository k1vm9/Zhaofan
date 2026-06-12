const { readFileSync, existsSync } = require("fs-extra");
const checkLiveCookie = require("./checkLiveCookie");
const getFbstate = require("./getFbstate");

/**
 * Filters an AppState array — keeps ALL cookies so we don't strip
 * messenger.com / m.facebook.com tokens that some API calls require.
 * Only strips obviously invalid entries (no key or no value).
 */
function filterKeysAppState(appState) {
  // Keep everything — the FCA sets cookies for all domains it needs.
  // Previously this stripped down to 6 keys which broke several API
  // features when using cookie-based login.
  return appState.filter(c => c.key && c.value && c.key !== "x-referer");
}

function isNetscapeCookie(str) {
  if (typeof str !== "string") return false;
  return /(.+)\t(1|TRUE|true)\t([\w\/.-]*)\t(1|TRUE|true)\t\d+\t([\w-]+)\t(.+)/i.test(str);
}

function netscapeToAppState(raw) {
  const result = [];
  for (const line of raw.split("\n")) {
    if (line.trim().startsWith("#") || !line.trim()) continue;
    const parts = line.split("\t").map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length < 7) continue;
    result.push({
      key: parts[5],
      value: parts[6],
      domain: parts[0],
      path: parts[2],
      hostOnly: parts[1] === "TRUE",
      creation: new Date(parseInt(parts[4]) * 1000).toISOString(),
      lastAccessed: new Date().toISOString()
    });
  }
  return result;
}

function normaliseAppStateArray(arr) {
  if (arr.some(c => c.name)) {
    arr = arr.map(c => {
      if (c.name && !c.key) { c.key = c.name; delete c.name; }
      return c;
    });
  }
  return arr
    .map(c => ({
      ...c,
      domain: c.domain || "facebook.com",
      path: c.path || "/",
      hostOnly: c.hostOnly ?? false,
      creation: c.creation || new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    }))
    .filter(c => c.key && c.value && c.key !== "x-referer");
}

/**
 * Reads and parses the AppState from a given file path.
 *
 * Validation is ADVISORY — if the live-cookie check returns false the
 * parsed array is still returned so the FCA library can make its own
 * determination.  Only null is returned when the file cannot be read or
 * parsed at all.
 *
 * @param {string} appStatePath
 * @param {string} [userAgent]
 * @returns {Promise<{appState: Array, confident: boolean}|null>}
 */
module.exports = async function parseAppState(appStatePath, userAgent) {
  if (!existsSync(appStatePath)) {
    console.log(`[ Login ]: AppState file not found (${appStatePath}) — skipping.`);
    return null;
  }

  let raw;
  try {
    raw = readFileSync(appStatePath, "utf-8").trim();
  } catch (e) {
    console.error(`[ Login ]: Could not read AppState file ${appStatePath}: ${e.message}`);
    return null;
  }

  if (!raw) {
    console.log(`[ Login ]: AppState file is empty (${appStatePath}).`);
    return null;
  }

  let appState = [];

  try {
    // ── Format 1: Access Token (EAAAA...) ──────────────────────────
    if (raw.startsWith("EAAAA")) {
      console.log("[ Login ]: Detected Access Token format — converting to cookies...");
      try {
        appState = await getFbstate(raw);
        console.log("[ Login ]: Access Token converted successfully.");
      } catch (e) {
        console.error(`[ Login ]: Access Token conversion failed: ${e.message}`);
        return null;
      }
    }

    // ── Format 2: Cookie string (key=value; key2=value2) ───────────
    else if (/^[\w-]+=/.test(raw) && raw.includes("=") && !raw.startsWith("[") && !raw.startsWith("{")) {
      console.log("[ Login ]: Detected cookie string format.");
      appState = raw
        .split(";")
        .map(part => {
          const eqIdx = part.indexOf("=");
          if (eqIdx === -1) return null;
          return {
            key:   part.slice(0, eqIdx).trim(),
            value: part.slice(eqIdx + 1).trim(),
            domain: "facebook.com",
            path: "/",
            hostOnly: true,
            creation: new Date().toISOString(),
            lastAccessed: new Date().toISOString()
          };
        })
        .filter(c => c && c.key && c.value && c.key !== "x-referer");
    }

    // ── Format 3: Netscape / EditThisCookie tab-separated ──────────
    else if (isNetscapeCookie(raw)) {
      console.log("[ Login ]: Detected Netscape cookie format.");
      appState = netscapeToAppState(raw);
    }

    // ── Format 4: JSON array ────────────────────────────────────────
    else {
      console.log("[ Login ]: Detected JSON array format.");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error(`[ Login ]: AppState JSON is malformed: ${e.message}`);
        return null;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        console.error("[ Login ]: AppState JSON is not a valid array or is empty.");
        return null;
      }
      appState = normaliseAppStateArray(parsed);
    }

    if (!appState || appState.length === 0) {
      console.error("[ Login ]: Parsed AppState is empty — cannot login.");
      return null;
    }

    // Ensure essential cookies are present
    const hasUser = appState.some(c => c.key === "c_user" || c.key === "i_user");
    const hasXs   = appState.some(c => c.key === "xs");
    if (!hasUser || !hasXs) {
      console.warn("[ Login ]: AppState is missing c_user or xs — may fail.");
    }

    // ── Advisory validation — skipped at startup to prevent thread-pool stall ──
    // [FIX DB-BOOT] — checkLiveCookie makes 3 sequential HTTP requests that each
    // need a DNS thread-pool slot. At startup the thread pool is occupied by
    // model .sync() retries (SQLITE_BUSY backoff), generating a microtask flood
    // that starves both DNS and setTimeout callbacks — the entire login stalls.
    //
    // The validation is 100% advisory: even if confident=false, tryLoginWithFile
    // still calls loginAsync and lets FCA make the authoritative determination.
    // Skipping it here is safe and lets the bot boot reliably.
    //
    // After login succeeds we fire a background validation for informational
    // logging so the panel still shows session health status.
    console.log("[ Login ]: Skipping pre-validation (FCA will validate) — proceeding with AppState...");
    const cookieStrForBg = appState.map(c => `${c.key}=${c.value}`).join("; ");
    const _ua = userAgent;
    setImmediate(() => {
      checkLiveCookie(cookieStrForBg, _ua)
        .then(r => {
          if (r === true)  console.log("[ Login ]: Background cookie check PASSED ✓");
          else if (r === false) console.warn("[ Login ]: Background cookie check FAILED — session may be dead.");
        })
        .catch(() => {});
    });

    return { appState: filterKeysAppState(appState), confident: false };

  } catch (e) {
    console.error(`[ Login ]: Unexpected error while parsing AppState: ${e.message}`);
    return null;
  }
};
