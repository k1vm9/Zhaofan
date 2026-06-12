/**
 * statePersist.js — Save & restore active command callbacks across restarts.
 *
 * When ZAO dies mid-conversation (cookie death, memory guard, SIGTERM, etc.)
 * any user waiting on a .ai reply-chain, a quiz answer, or any other
 * handleReply / handleReaction prompt would lose their pending state.
 *
 * This module snapshots those arrays to disk before exiting, then reloads
 * them right after the next successful login so the conversations just continue.
 *
 * The entries in handleReply / handleReaction are plain data objects —
 * { messageID, name, data, ... } — no function references, so they
 * survive JSON serialisation cleanly.
 */

const fs   = require("fs-extra");
const path = require("path");
// [FIX Djamel] — atomic write so a SIGKILL during the snapshot doesn't
// leave a half-written .zao-pending-callbacks.json that the next boot
// fails to parse and silently discards (losing every pending reply chain).
const { atomicWriteFileSync } = (() => {
  try { return require("../../utils/atomicWrite"); }
  catch (_) { return { atomicWriteFileSync: fs.writeFileSync.bind(fs) }; }
})();

const STATE_FILE = path.join(process.cwd(), ".zao-pending-callbacks.json");

function log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: "[ CALLBACKS ]: ", color: ["red", "cyan"] },
        { message: msg, color: "white" }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[CALLBACKS]", msg);
}

/**
 * Persist current handleReply + handleReaction arrays to disk.
 * Call this right before any process.exit() during an unplanned restart.
 */
function save() {
  try {
    const handleReply    = global.client?.handleReply    || [];
    const handleReaction = global.client?.handleReaction || [];

    if (!handleReply.length && !handleReaction.length) return;

    const payload = {
      savedAt:        Date.now(),
      handleReply:    handleReply,
      handleReaction: handleReaction
    };

    atomicWriteFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf-8");
    log(`Saved ${handleReply.length} reply + ${handleReaction.length} reaction callbacks to disk.`);
  } catch (e) {
    log("Could not save callbacks: " + e.message);
  }
}

/**
 * Restore handleReply + handleReaction after a successful login.
 * Only restores entries whose command is still loaded in global.client.commands.
 * Entries older than maxAgeMs (default: 2 hours) are silently discarded.
 *
 * Call this after global.client.commands is populated (post-loadCommands).
 */
function restore(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const payload = JSON.parse(raw);

    fs.removeSync(STATE_FILE);

    const age = Date.now() - (payload.savedAt || 0);
    if (age > maxAgeMs) {
      log(`Saved callbacks are too old (${Math.round(age / 60000)} min) — discarding.`);
      return;
    }

    const commands = global.client?.commands;
    if (!commands) {
      log("Commands not loaded yet — skipping restore.");
      return;
    }

    let replyCount    = 0;
    let reactionCount = 0;

    for (const entry of (payload.handleReply || [])) {
      if (!entry?.messageID || !entry?.name) continue;
      if (!commands.has(entry.name)) continue;
      const existing = global.client.handleReply;
      if (!existing.some(e => e.messageID === entry.messageID)) {
        existing.push(entry);
        replyCount++;
      }
    }

    for (const entry of (payload.handleReaction || [])) {
      if (!entry?.messageID || !entry?.name) continue;
      if (!commands.has(entry.name)) continue;
      const existing = global.client.handleReaction;
      if (!existing.some(e => e.messageID === entry.messageID)) {
        existing.push(entry);
        reactionCount++;
      }
    }

    if (replyCount || reactionCount) {
      log(`Restored ${replyCount} reply + ${reactionCount} reaction callbacks — active commands resumed.`);
    } else {
      log("No restorable callbacks found (commands may have changed).");
    }
  } catch (e) {
    log("Could not restore callbacks: " + e.message);
    try { fs.removeSync(STATE_FILE); } catch (_) {}
  }
}

module.exports = { save, restore };
