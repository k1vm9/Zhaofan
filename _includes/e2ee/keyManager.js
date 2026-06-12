"use strict";

/**
 * E2EE Key Manager
 * ════════════════
 * Persists the bot's X25519 key pair and all registered peer public keys
 * to disk so sessions survive restarts.
 *
 * The underlying crypto lives in @neoaz07/nkxfca/src/security/e2ee.
 * This module only owns persistence and the load/save lifecycle.
 *
 * Key file schema (data/e2ee-keys.json):
 * {
 *   "botPublicKey":  "<base64 SPKI der>",
 *   "botPrivateKey": "<base64 PKCS8 der>",
 *   "peers": {
 *     "<threadID>": "<base64 SPKI der of peer>"
 *   }
 * }
 */

const fs   = require("fs-extra");
const path = require("path");

const DEFAULT_KEY_FILE = path.join(process.cwd(), "data", "e2ee-keys.json");

function _log(msg, color) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ E2EE ]: ", color: ["red", "cyan"] },
        { message: msg, color: color || "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[E2EE]", msg);
}

function _keyFilePath() {
  const cfg = global.config?.e2ee || {};
  return path.join(process.cwd(), cfg.keyFile || "data/e2ee-keys.json");
}

/**
 * Load persisted keys into the api.e2ee context.
 * Safe to call even when no key file exists yet.
 */
function load(api) {
  if (!api || !api.e2ee) return;

  const filePath = _keyFilePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const raw  = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);

    if (data.botPublicKey && data.botPrivateKey) {
      const e2eeCore = _getCoreModule();
      if (e2eeCore) {
        const ctx = _getCtx(api);
        if (ctx) {
          ctx.e2ee = ctx.e2ee || { enabled: false, bot: null, peers: Object.create(null) };
          ctx.e2ee.bot = {
            publicKey:  Buffer.from(data.botPublicKey,  "base64"),
            privateKey: Buffer.from(data.botPrivateKey, "base64")
          };
          if (data.peers && typeof data.peers === "object") {
            for (const [tid, pk] of Object.entries(data.peers)) {
              ctx.e2ee.peers[String(tid)] = pk;
            }
          }
          _log(
            `Keys loaded — ${Object.keys(data.peers || {}).length} peer(s) restored.`,
            "green"
          );
        }
      }
    }
  } catch (e) {
    _log("Key load failed: " + (e.message || e), "yellow");
  }
}

/**
 * Save current bot key pair + all peer keys to disk.
 */
function save(api) {
  if (!api || !api.e2ee) return;

  const filePath = _keyFilePath();
  try {
    fs.ensureDirSync(path.dirname(filePath));
    const ctx = _getCtx(api);
    if (!ctx || !ctx.e2ee || !ctx.e2ee.bot) return;

    const data = {
      botPublicKey:  Buffer.from(ctx.e2ee.bot.publicKey).toString("base64"),
      botPrivateKey: Buffer.from(ctx.e2ee.bot.privateKey).toString("base64"),
      peers:         Object.assign({}, ctx.e2ee.peers || {})
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    _log("Key save failed: " + (e.message || e), "yellow");
  }
}

/**
 * Register a peer's public key for a thread and persist immediately.
 */
function addPeer(api, threadID, peerPublicKeyB64) {
  if (!api || !api.e2ee) return false;
  try {
    api.e2ee.setPeerKey(String(threadID), peerPublicKeyB64);
    save(api);
    return true;
  } catch (e) {
    _log("addPeer failed: " + (e.message || e), "yellow");
    return false;
  }
}

/**
 * Remove a peer's key for a thread and persist.
 */
function removePeer(api, threadID) {
  if (!api || !api.e2ee) return false;
  try {
    api.e2ee.clearPeerKey(String(threadID));
    save(api);
    return true;
  } catch (e) {
    _log("removePeer failed: " + (e.message || e), "yellow");
    return false;
  }
}

/**
 * List all threads that have a registered peer key.
 */
function listPeers(api) {
  if (!api || !api.e2ee) return [];
  try {
    const ctx = _getCtx(api);
    if (!ctx || !ctx.e2ee || !ctx.e2ee.peers) return [];
    return Object.keys(ctx.e2ee.peers);
  } catch (_) {
    return [];
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

function _getCoreModule() {
  try {
    return require("@neoaz07/nkxfca/src/security/e2ee");
  } catch (_) {
    return null;
  }
}

function _getCtx(api) {
  try {
    if (api.__ctx) return api.__ctx;
    if (api._ctx)  return api._ctx;
    if (api.ctx)   return api.ctx;
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { load, save, addPeer, removePeer, listPeers };
