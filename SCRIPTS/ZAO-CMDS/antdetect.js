/**
 * Djamel-Fca runtime status for the protections it actually provides.
 * User-agent changes are applied at the next login, not to a live session.
 */

module.exports = {
  config: {
    name: 'antdetect',
    hasPermssion: 2,
    description: 'View Djamel-Fca connection and message-protection settings',
    commandCategory: 'إدارة البوت',
    usages: '[status|settings|ua|presence]',
    cooldowns: 0,
  },
  
  run: async function({ message, args, api, event }) {
    const command = args[0]?.toLowerCase() || 'status';
    const cfg = global.config || {};
    const rateLimit = cfg.rateLimit || {};
    const throttle = cfg.outgoingThrottle || {};

    if (command === "ua") {
      return api.sendMessage(
        "User-Agent is selected at Facebook login. Update facebookAccount.userAgent in the dashboard, then reconnect.",
        event.threadID,
        event.messageID,
      );
    }

    if (command === "settings") {
      return api.sendMessage(
        `🛡️ Djamel-Fca protection settings\n\n` +
        `Message limit: ${rateLimit.maxMessagesPerWindow || 8} per ${rateLimit.windowMs || 6000}ms\n` +
        `Outgoing pacing: ${JSON.stringify(throttle)}\n` +
        `Poll interval: ${cfg.pollIntervalMs || 6000}ms`,
        event.threadID,
        event.messageID,
      );
    }

    if (command === "status") {
      return api.sendMessage(
        `🛡️ Djamel-Fca runtime\n\n` +
        `Facebook: ${global._botApi ? "connected" : "offline"}\n` +
        `Command flood limit: ${rateLimit.maxMessagesPerWindow || 8} messages / ${rateLimit.windowMs || 6000}ms\n` +
        `Outgoing pacing: configured\n` +
        `User-Agent: fixed for the current login`,
        event.threadID,
        event.messageID,
      );
    }

    return api.sendMessage(
      "/antdetect status — connection and protection summary\n" +
      "/antdetect settings — active rate/pacing settings\n" +
      "/antdetect ua — how to change the next login's User-Agent",
      event.threadID,
      event.messageID,
    );
  }
};
