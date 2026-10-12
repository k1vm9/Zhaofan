"use strict";

/**
 * MQTT E2EE Patch v4
 * ==================
 * Intercepts Facebook MQTT messages BEFORE fca-unofficial silently drops
 * encrypted payloads.
 *
 * Detects:
 *   🔐ZAO|<base64>  — ZAO Signal Protocol E2EE (primary)
 *   🔒E2EE:<base64> — Liberty/PIN format (WHITE-V3 compat)
 *   000000          — Facebook native Labyrinth E2EE sentinel
 *   &&;)            — FB E2EE raw sentinel (variant 1)
 *   "" (empty)      — FB E2EE in DMs (no body = encrypted message dropped)
 *   null/undefined  — Missing body in encrypted DMs
 *   Raw null bytes  — \x00\x00\x00\x00\x00\x00 binary variant
 *
 * FIXES (v4):
 *   - Empty string body ("") now treated as FB E2EE sentinel (DM encrypted msgs)
 *   - null / undefined body explicitly handled instead of coercing to ""
 *   - All decrypt branches guard against null/undefined body before startsWith()
 *   - tryFetchEncryptedMessage: 3× retry with exponential backoff, better
 *     body validation, and active decryption for ZAO/Liberty wire formats
 *   - Module-level _patched flag checked correctly on re-install (reconnect)
 *   - wrapGlobalCallback: _e2eeType set consistently across all branches
 *   - Bot's own messages (senderID matches bot UID) are skipped
 */

const OUR_PREFIX = "🔐ZAO|";
const LIB_PREFIX = "🔒E2EE:";

// FIX: Added "" (empty string) — encrypted DMs in FB native Labyrinth have no body.
const FB_E2EE_BODIES = new Set(["&&;)", "000000", "\x00\x00\x00\x00\x00\x00", ""]);
const FB_E2EE_RAW_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

// Exported constants
const ENCRYPTED_SENTINEL = "000000";

let _labyrinth = null;
let _api       = null;
let _patched   = false;
let _botUID    = null;   // set when api is known — avoids re-decrypting own messages

function _log(msg, level) {
  try {
    const method = level === "warn" || level === "error" ? level : "info";
    if (typeof global.log?.[method] === "function") {
      global.log[method]("MQTT-E2EE-PATCH", msg);
      return;
    }
  } catch (_) {}
  console.log("[MQTT-E2EE-PATCH]", msg);
}

// ── FB E2EE sentinel detection ────────────────────────────────────────────────

function _isFbSentinel(body) {
  // FIX: Handle null/undefined explicitly — don't coerce to ""
  if (body === null || body === undefined) return true;

  // FIX: "" is now a valid sentinel (encrypted DMs arrive with no body)
  if (FB_E2EE_BODIES.has(body)) return true;

  // Raw null-byte variant (MQTT parser may return binary string)
  if (typeof body === "string" && body.length === 6) {
    try {
      const buf = Buffer.from(body, "binary");
      if (buf.equals(FB_E2EE_RAW_BYTES)) return true;
    } catch (_) {}
  }

  return false;
}

// ── Handshake notification ────────────────────────────────────────────────────

function _notifyHandshake(event, result) {
  try {
    if (typeof global._labyrinthHandshakeCb === "function") {
      global._labyrinthHandshakeCb(Object.assign({}, event, {
        body:                "🔐 E2EE session established.",
        _e2eeHandshakeDone:  true,
        _e2eeFirstPlaintext: result ? result.plaintext : null
      }));
    }
  } catch (_) {}
}

// ── Wrap globalCallback ───────────────────────────────────────────────────────

function wrapGlobalCallback(originalCb) {
  return function patchedCb(err, event) {
    if (err) return originalCb(err, event);
    if (!event) return originalCb(null, event);

    // Touch MQTT health watchdog activity timestamp
    try {
      const mh = require('../../../protection/mqttHealthCheck');
      if (mh && typeof mh.onMqttActivity === 'function') mh.onMqttActivity();
      else global.lastMqttActivity = Date.now();
    } catch (_) {
      global.lastMqttActivity = Date.now();
    }

    try {
      // FIX: body may be null/undefined — coerce safely
      const rawBody = (event.body != null) ? event.body : null;
      const body    = rawBody || "";

      // Skip our own outgoing messages (avoid decrypt loop)
      if (_botUID && String(event.senderID || "") === String(_botUID)) {
        return originalCb(null, event);
      }

      // ── Case 1: ZAO or Liberty E2EE prefix ──────────────────────────────
      const isOurMsg = body.startsWith(OUR_PREFIX) || body.startsWith(LIB_PREFIX);

      if (isOurMsg && _labyrinth) {
        const result = _labyrinth.decrypt(event.threadID, body);

        if (result) {
          const { msgType, plaintext } = result;

          if (msgType === "handshake_init" || msgType === "handshake_ack") {
            _notifyHandshake(event, result);
            event.body               = plaintext || "";
            event._e2eeDecrypted     = true;
            event._e2eeHandshakeDone = true;
            event._e2eeType          = msgType;

          } else if (msgType === "pin_fail") {
            event._e2eeFailedDecrypt = true;
            event._e2eePinFail       = true;
            event._e2eeType          = "pin_fail";
            _log(`PIN decrypt failed — thread ${event.threadID}.`, "warn");

          } else if (plaintext !== null && plaintext !== undefined) {
            event.body           = plaintext;
            event._e2eeDecrypted = true;
            event._e2eeType      = msgType;

          } else {
            // Handshake variant with no plaintext (pure key exchange msg)
            event._e2eeDecrypted = true;
            event._e2eeType      = msgType;
          }

        } else {
          // FIX: result === null → Signal decrypt failed — try global PIN passive
          if (_labyrinth.tryPassiveDecrypt) {
            const passivePt = _labyrinth.tryPassiveDecrypt(body);
            if (passivePt !== null && passivePt !== undefined) {
              event.body           = passivePt;
              event._e2eeDecrypted = true;
              event._e2eeType      = "pin_passive";
            } else {
              event._e2eeFailedDecrypt = true;
              event._e2eeType          = "unknown";
              _log(`All decrypt methods failed — thread ${event.threadID}.`, "warn");
            }
          } else {
            event._e2eeFailedDecrypt = true;
            event._e2eeType          = "unknown";
            _log(`Decrypt failed — thread ${event.threadID} has no session.`, "warn");
          }
        }

        return originalCb(null, event);
      }

      // ── Case 2: Facebook native Labyrinth E2EE sentinel ──────────────────
      // FIX: also fires on null/undefined body (encrypted DMs) and ""
      if (!isOurMsg && (rawBody === null || rawBody === undefined || _isFbSentinel(body))) {
        event._fbE2eeEncrypted = true;
        event._e2eeType        = "fb_native";
        event.body             = "";  // normalise to empty string
        _log(`FB E2EE sentinel in thread ${event.threadID} — body=${JSON.stringify(body).slice(0, 40)}.`);
      }

    } catch (patchErr) {
      _log("Callback error: " + (patchErr.message || patchErr), "warn");
    }

    return originalCb(null, event);
  };
}

// ── Patch parseDelta ──────────────────────────────────────────────────────────

function patchMqttDelta() {
  if (_patched) return true;

  const candidates = [
    "@neoaz07/nkxfca/src/apis/mqttDeltaValue",
    "@neoaz07/nkxfca/src/apis/mqttDelta",
    "facebook-chat-api/src/apis/mqttDeltaValue",
    "facebook-chat-api/src/apis/mqttDelta",
    "fca-unofficial/src/apis/mqttDeltaValue",
    "fca-unofficial/src/apis/mqttDelta",
    "fca-unofficial-main/src/apis/mqttDeltaValue",
    "fca-unofficial-main/src/apis/mqttDelta"
  ];

  let mqttMod  = null;
  let mqttPath = null;

  for (const id of candidates) {
    try {
      mqttPath = require.resolve(id);
      mqttMod  = require(mqttPath);
      if (mqttMod && typeof mqttMod.parseDelta === "function") break;
    } catch (_) { mqttMod = null; }
  }

  if (!mqttMod || typeof mqttMod.parseDelta !== "function") {
    _log("parseDelta not found in any candidate path — will fall back to api.listen wrap.", "warn");
    return false;
  }

  if (mqttMod.parseDelta.__labyrinthPatched) {
    _patched = true;
    return true;
  }

  const original = mqttMod.parseDelta;
  function patchedParseDelta(defaultFuncs, api, ctx, globalCallback, v) {
    return original(defaultFuncs, api, ctx, wrapGlobalCallback(globalCallback), v);
  }
  patchedParseDelta.__labyrinthPatched  = true;
  patchedParseDelta.__labyrinthOriginal = original;
  mqttMod.parseDelta = patchedParseDelta;

  _patched = true;
  _log("parseDelta patched — E2EE intercept active. (" + mqttPath + ")");
  return true;
}

// ── Fallback: wrap api.listenMqtt / api.listen ────────────────────────────────

function _installListenFallback(apiInstance) {
  if (!apiInstance) return;
  const targets = ["listenMqtt", "listen"];
  for (const fn of targets) {
    if (typeof apiInstance[fn] === "function" && !apiInstance[fn].__labyrinthPatched) {
      const orig = apiInstance[fn].bind(apiInstance);
      function wrapped(handler) { return orig(wrapGlobalCallback(handler)); }
      wrapped.__labyrinthPatched  = true;
      wrapped.__labyrinthOriginal = orig;
      apiInstance[fn] = wrapped;
      _log(`api.${fn} wrapped (fallback) — E2EE intercept active.`);
      return;
    }
  }
}

// ── Re-fetch FB E2EE message (3× retry + exponential backoff) ─────────────────

async function tryFetchEncryptedMessage(api, event, maxRetries = 3) {
  if (!api || typeof api.getMessage !== "function") return null;
  if (!event || !event.threadID || !event.messageID) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("getMessage timeout")), 8000);
        api.getMessage(event.threadID, event.messageID, (err, msg) => {
          clearTimeout(timer);
          if (err) return reject(err);
          resolve(msg);
        });
      });

      // FIX: validate body properly — null/undefined/sentinel all mean "still encrypted"
      const body = (result && result.body != null) ? result.body : null;
      if (body === null || _isFbSentinel(body)) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 1200));
          continue;
        }
        return null;
      }

      // If the body is our format, decrypt it
      if (_labyrinth && _labyrinth.isLabyrinthMessage(body)) {
        const dec = _labyrinth.decrypt(event.threadID, body);
        if (dec && dec.plaintext != null) return dec.plaintext;
        if (_labyrinth.tryPassiveDecrypt) {
          const pt = _labyrinth.tryPassiveDecrypt(body);
          if (pt !== null) return pt;
        }
        return null;
      }

      return body;

    } catch (e) {
      _log(`getMessage attempt ${attempt}/${maxRetries} failed: ${e.message}`, "warn");
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
  }
  return null;
}

// ── Install ───────────────────────────────────────────────────────────────────

function install(labyrinthInstance, apiInstance) {
  _labyrinth = labyrinthInstance;
  _api       = apiInstance;

  // Try to get bot's own UID to avoid re-decrypting its outgoing messages
  try {
    if (apiInstance && typeof apiInstance.getCurrentUserID === "function") {
      _botUID = apiInstance.getCurrentUserID();
    }
  } catch (_) {}

  const didPatch = patchMqttDelta();
  if (!didPatch) {
    _installListenFallback(apiInstance);
  }

  _log("MQTT E2EE patch v4 installed.");
}

/** Update the labyrinth instance without re-patching (safe for reconnects). */
function update(labyrinthInstance) {
  _labyrinth = labyrinthInstance;
}

module.exports = {
  install,
  update,
  wrapGlobalCallback,
  tryFetchEncryptedMessage,
  ENCRYPTED_SENTINEL,
  OUR_PREFIX,
  LIB_PREFIX
};
