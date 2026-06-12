'use strict';

/**
 * Anti-Spam Module — ZAO Protection Layer
 * =========================================
 * Tracks message frequency per user per thread.
 * If a user exceeds the threshold within the time window:
 *   1. First offence → warning message
 *   2. Second offence → kick (or configured action)
 *
 * Called directly from handleCommand.js for command-based spam,
 * and from the main listen path for raw message spam.
 *
 * Config in ZAO-SETTINGS.json:
 *   "antispam": {
 *     "enable": true,
 *     "maxMessages": 6,
 *     "timeWindowSeconds": 8,
 *     "warnBeforeAction": true,
 *     "action": "kick"
 *   }
 */

const rateLimit = require('./rateLimit');

function _getConfig() {
  const cfg = global.config?.antispam || {};
  return {
    // DISABLED BY DEFAULT — must be explicitly set to true in ZAO-SETTINGS.json
    // under "antispam": { "enable": true } to re-enable warning/kick behaviour.
    enable:           cfg.enable           === true,
    maxMessages:      cfg.maxMessages      || 6,
    windowMs:         (cfg.timeWindowSeconds || 8) * 1000,
    warnBeforeAction: cfg.warnBeforeAction !== false,
    action:           cfg.action           || 'kick'
  };
}

function _isAdminOrBot(uid) {
  const admins = (global.config?.ADMINBOT || []).map(String);
  const botID  = String(global.botUserID || global._botApi?.getCurrentUserID?.() || '');
  return admins.includes(String(uid)) || String(uid) === botID;
}

/**
 * Check if a user is spamming and take action if needed.
 * @param {object} api     - FCA api object
 * @param {object} event   - Current event
 * @returns {boolean}      - true if spam was detected (caller should abort processing)
 */
function check(api, event) {
  try {
    const cfg = _getConfig();
    if (!cfg.enable) return false;

    const { senderID, threadID, isGroup } = event;
    if (!senderID || !threadID || !isGroup) return false;
    if (_isAdminOrBot(senderID)) return false;

    const key    = `${threadID}:${senderID}:spam`;
    const result = rateLimit.check(key, cfg.maxMessages, cfg.windowMs);

    if (!result.exceeded) return false;

    // First time exceeding threshold — warn
    if (cfg.warnBeforeAction && !result.warned) {
      rateLimit.setWarned(key);
      api.sendMessage(
        `⚠️ @${senderID} — You are sending messages too fast! Continue and you will be removed.`,
        threadID
      ).catch(() => {});
      return true;
    }

    // Second offence — take action
    rateLimit.reset(key);

    if (cfg.action === 'kick') {
      api.removeUserFromGroup(senderID, threadID, (err) => {
        if (!err) {
          api.sendMessage(`🚫 [ANTI-SPAM] User removed for spamming.`, threadID).catch(() => {});
        }
      });
    } else {
      api.sendMessage(
        `🚫 [ANTI-SPAM] User ${senderID} exceeded message limit.`,
        threadID
      ).catch(() => {});
    }

    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { check };
