"use strict";

/**
 * React-to-Unsend
 * ================
 * Allows bot admins to unsend any bot message by reacting to it
 * with a configured emoji (default: 😡).
 *
 * How it works:
 *   1. Every message the bot sends is tracked (messageID → threadID).
 *   2. When a reaction event arrives with the trigger emoji on a tracked message
 *      from a bot admin, the bot calls api.unsendMessage(messageID).
 *   3. Old tracked messages are automatically purged after TTL (default 24 h).
 *
 * Config key: global.config.reactUnsend  (in ZAO-SETTINGS.json)
 *   enable        — true/false
 *   triggerEmoji  — emoji that triggers unsend (default "😡")
 *   ttlHours      — how long to track messages (default 24)
 *   maxTracked    — max messages to keep in memory (default 500)
 */

function _log(msg) {
  try {
    if (global.loggeryuki) {
      global.loggeryuki.log([
        { message: "[ UNSEND ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[UNSEND]", msg);
}

function _getCfg() {
  return global.config?.reactUnsend || {};
}

function _isEnabled() {
  const cfg = _getCfg();
  return cfg.enable !== false;
}

function _isAdmin(userID) {
  const uid    = String(userID);
  const admins = (global.config?.ADMINBOT || []).map(String);
  return admins.includes(uid);
}

const _tracked = new Map();  // messageID → { threadID, sentAt }

function _prune() {
  const cfg    = _getCfg();
  const ttlMs  = (cfg.ttlHours ?? 24) * 3600_000;
  const maxN   = cfg.maxTracked ?? 500;
  const cutoff = Date.now() - ttlMs;

  for (const [mid, rec] of _tracked.entries()) {
    if (rec.sentAt < cutoff) _tracked.delete(mid);
  }

  if (_tracked.size > maxN) {
    const entries = [..._tracked.entries()].sort((a, b) => a[1].sentAt - b[1].sentAt);
    const toDelete = entries.slice(0, _tracked.size - maxN);
    for (const [mid] of toDelete) _tracked.delete(mid);
  }
}

let _pruneTimer = null;

function _startPruner() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(_prune, 15 * 60_000);
  if (typeof _pruneTimer.unref === "function") _pruneTimer.unref();
}

/**
 * Call this after the bot sends a message to track it.
 * @param {string} messageID
 * @param {string} threadID
 */
function track(messageID, threadID) {
  if (!_isEnabled()) return;
  if (!messageID || !threadID) return;
  _startPruner();
  _tracked.set(String(messageID), { threadID: String(threadID), sentAt: Date.now() });
}

/**
 * Handle a reaction event. Call from the message listener.
 * @param {object} api
 * @param {object} event — reaction event (type === 'message_reaction')
 */
async function handleReaction(api, event) {
  if (!_isEnabled()) return;
  if (!event || event.type !== "message_reaction") return;

  const cfg          = _getCfg();
  const triggerEmoji = cfg.triggerEmoji ?? "😡";
  const { reaction, userReactedID, messageID } = event;

  if (reaction !== triggerEmoji) return;
  if (!_isAdmin(userReactedID)) return;

  const rec = _tracked.get(String(messageID));
  if (!rec) return;

  try {
    await api.unsendMessage(String(messageID));
    _tracked.delete(String(messageID));
    _log(`✅ Unsent message ${messageID} in thread ${rec.threadID} (reacted by ${userReactedID})`);
  } catch (e) {
    _log(`❌ Failed to unsend ${messageID}: ${e.message || e}`);
  }
}

/**
 * Wrap api.sendMessage so every sent message is auto-tracked.
 * Call once after login: wrapApi(api).
 */
function wrapApi(api) {
  if (!api || typeof api.sendMessage !== "function") return;
  if (api.__reactUnsendWrapped) return;

  const orig = api.sendMessage.bind(api);

  api.sendMessage = function (message, threadID, callback, messageID) {
    const result = orig(message, threadID, (err, info) => {
      if (!err && info?.messageID) {
        track(info.messageID, threadID);
      }
      if (typeof callback === "function") callback(err, info);
    }, messageID);

    if (result && typeof result.then === "function") {
      result.then(info => {
        if (info?.messageID) track(info.messageID, threadID);
      }).catch(() => {});
    }

    return result;
  };

  api.__reactUnsendWrapped = true;
  _log("api.sendMessage wrapped for react-to-unsend tracking.");
}

function getStatus() {
  const cfg = _getCfg();
  return {
    enabled:       _isEnabled(),
    triggerEmoji:  cfg.triggerEmoji ?? "😡",
    trackedCount:  _tracked.size,
    ttlHours:      cfg.ttlHours ?? 24,
    maxTracked:    cfg.maxTracked ?? 500,
  };
}

module.exports = { track, handleReaction, wrapApi, getStatus };
