"use strict";

/**
 * Labyrinth Boot Module v4
 * ========================
 * Initialises the full merged E2EE stack:
 *   1. KeyStore    — load / generate identity keys, unlock with PIN
 *   2. SessionStore — load persisted DR sessions + extended state (PIN, autoEnc)
 *   3. Labyrinth v4 engine — Signal + PIN passive + Liberty compat
 *   4. MqttPatch v4 — dual-prefix, empty-body sentinel, retry, passive fallback
 *   5. sendMessage wrapper — auto-encrypt outgoing when session active
 *   6. Startup self-diagnose — runs diagnose() and logs result
 *   7. Periodic housekeeping — prune skipped keys, replenish OPKs, flush state
 *
 * FIXES (v4):
 *   - loadExtendedState() called after engine init — PIN sessions, autoEncrypt
 *     flags, peer IK pubs survive bot restarts.
 *   - Startup diagnose() called and result logged — shows any broken subsystem.
 *   - Handshake callback sends the safety number correctly.
 *   - _wrapSendMessage already-encrypted guard added — won't double-encrypt
 *     messages that already start with the wire prefix.
 *   - api.sendMessage call in handshake callback wrapped with Promise.resolve()
 *     to handle both callback-style and Promise-style sendMessage.
 *   - Graceful shutdown handler flushes SessionStore to disk.
 */

const path         = require("path");
const KeyStore     = require("./KeyStore");
const SessionStore = require("./SessionStore");
const Labyrinth    = require("./Labyrinth");
const MqttPatch    = require("./MqttPatch");

const SIGNAL_PREFIX = "🔐ZAO|";
const LIB_PREFIX    = "🔒E2EE:";

function _log(msg, level) {
  try {
    const method = level === "warn" || level === "error" ? level : "info";
    if (typeof global.log?.[method] === "function") {
      global.log[method]("LABYRINTH", msg);
      return;
    }
  } catch (_) {}
  console.log("[LABYRINTH]", msg);
}

function getConfig() {
  const cfg = (global.config && global.config.labyrinth) || {};
  return {
    enabled:       cfg.enabled !== false,
    pin:           cfg.pin           || "",
    globalPin:     cfg.globalPin     || cfg.pinPassive || "",
    keyFile:       cfg.keyFile       || "data/labyrinth-keys.json",
    sessionFile:   cfg.sessionFile   || "data/labyrinth-sessions.json",
    autoHandshake: cfg.autoHandshake !== false,
    announceReady: cfg.announceReady !== false,
    wrapSendMsg:   cfg.wrapSendMsg   !== false,
    runDiagnose:   cfg.runDiagnose   !== false
  };
}

// ── sendMessage auto-encrypt wrapper ─────────────────────────────────────────

function _wrapSendMessage(api, labyrinth) {
  if (!api || typeof api.sendMessage !== "function") return;
  if (api.__labyrinthWrapped) return;

  const orig = api.sendMessage.bind(api);

  api.sendMessage = function (message, threadID, callback, messageID) {
    try {
      if (!labyrinth) return orig(message, threadID, callback, messageID);
      const tid = String(threadID || "");

      if (labyrinth.isAutoEncrypt(tid) && labyrinth.hasAnySession(tid)) {
        let plaintext = null;

        if (typeof message === "string") {
          plaintext = message;
        } else if (message && typeof message === "object" && typeof message.body === "string") {
          plaintext = message.body;
        }

        // FIX: Don't double-encrypt messages already in wire format
        if (plaintext &&
            !plaintext.startsWith(SIGNAL_PREFIX) &&
            !plaintext.startsWith(LIB_PREFIX)) {
          const encrypted = labyrinth.encryptSmart(tid, plaintext);
          if (encrypted) {
            const outMsg = typeof message === "string"
              ? encrypted
              : Object.assign({}, message, { body: encrypted });
            return orig(outMsg, threadID, callback, messageID);
          }
        }
      }
    } catch (_) { /* never break sending */ }

    return orig(message, threadID, callback, messageID);
  };

  api.__labyrinthWrapped = true;
  _log("api.sendMessage wrapped for auto-encrypt.");
}

// ── Safe reply helper ─────────────────────────────────────────────────────────

function _safeReply(api, threadID, msg) {
  try {
    if (!api || typeof api.sendMessage !== "function") return;
    const r = api.sendMessage(msg, threadID);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────

let _instance     = null;
let _sessionStore = null;

async function init(api) {
  const cfg = getConfig();

  if (!cfg.enabled) {
    _log("Labyrinth E2EE disabled (set labyrinth.enabled=true to activate).", "warn");
    return null;
  }

  _log("Initialising Labyrinth v4 — Signal Protocol + PIN passive mode…");

  // 1. KeyStore
  const keyStore = new KeyStore(
    path.join(process.cwd(), cfg.keyFile),
    cfg.pin
  );
  await keyStore.init();

  // 2. SessionStore
  const sessionStore = new SessionStore(
    path.join(process.cwd(), cfg.sessionFile)
  );
  await sessionStore.init();
  _sessionStore = sessionStore;

  // 3. Engine
  const labyrinth = new Labyrinth(keyStore, sessionStore);

  // 4. FIX: Restore PIN sessions, autoEncrypt flags, peerIKpubs from disk
  labyrinth.loadExtendedState();

  // 5. Set global PIN for passive mode
  if (cfg.globalPin) {
    labyrinth.setGlobalPin(cfg.globalPin);
    _log("Global PIN set — passive PIN decrypt enabled.");
  } else if (!cfg.pin) {
    _log("⚠ No PIN set — keys stored unencrypted. Configure a key-store PIN before enabling E2EE.", "warn");
  }

  // 6. MQTT patch
  MqttPatch.install(labyrinth, api);

  // 7. sendMessage auto-encrypt wrapper
  if (cfg.wrapSendMsg && api) {
    _wrapSendMessage(api, labyrinth);
  }

  // 8. Handshake established callback
  global._labyrinthHandshakeCb = (event) => {
    try {
      if (!api) return;
      const sn  = labyrinth.getSafetyNumber(event.threadID);
      const msg = [
        "🔐 *E2EE Session Established*",
        "Messages are now protected by Signal Protocol (X3DH + Double Ratchet, AES-256-GCM).",
        "",
        "Use `.e2ee send <message>` or enable auto-encrypt with `.e2ee autoencrypt on`.",
        sn ? "\n🔑 *Safety Number* (verify out-of-band):\n" + sn : null,
        "\nType `.e2ee status` for session details."
      ].filter(l => l !== null).join("\n");
      _safeReply(api, event.threadID, msg);
    } catch (_) {}
  };

  // 9. FIX: Startup self-diagnose
  if (cfg.runDiagnose) {
    try {
      const health = labyrinth.diagnose();
      const passed = health.tests.filter(t => t.pass).length;
      const total  = health.tests.length;
      if (health.ok) {
        _log(`Self-diagnose: ${passed}/${total} tests passed — all systems OK.`);
      } else {
        const failed = health.tests.filter(t => !t.pass);
        _log(`Self-diagnose: ${passed}/${total} passed — ${failed.length} FAILED:`, "warn");
        failed.forEach(t => _log(`  ✗ ${t.name}: ${t.error}`, "warn"));
      }
    } catch (e) {
      _log("Self-diagnose error: " + (e.message || e), "warn");
    }
  }

  // 10. Periodic housekeeping (every 2 hours)
  // Guard: if init() is called again (reconnect), don't stack duplicate timers.
  if (global.__labyrinthHousekeepingTimer) {
    try { clearInterval(global.__labyrinthHousekeepingTimer); } catch (_) {}
  }
  global.__labyrinthHousekeepingTimer = setInterval(() => {
    try { sessionStore.pruneAll(); } catch (_) {}
    try { keyStore._replenishOPKs().catch(() => {}); } catch (_) {}
    try { sessionStore.flush().catch(() => {}); } catch (_) {}
  }, 2 * 3600 * 1000);
  if (global.__labyrinthHousekeepingTimer.unref)
    global.__labyrinthHousekeepingTimer.unref();

  // 11. FIX: Graceful shutdown — flush session state to disk
  const _onShutdown = () => {
    try { sessionStore.flush().catch(() => {}); } catch (_) {}
  };
  process.once("SIGTERM", _onShutdown);
  process.once("SIGINT",  _onShutdown);
  process.once("exit",    _onShutdown);

  _instance = labyrinth;
  global._labyrinth = labyrinth;

  _log(
    `Labyrinth v4 ready — Signal (X3DH + Double Ratchet) + PIN passive mode.` +
    ` | IK: ${Buffer.from(keyStore.IK.pub).toString("base64").slice(0, 16)}…` +
    ` | OPKs: ${keyStore.OPKs.length}` +
    ` | Global PIN: ${cfg.globalPin ? "✓" : "✗"}`
  );

  return labyrinth;
}

function getInstance() { return _instance; }

module.exports = { init, getInstance };
