"use strict";

module.exports.config = {
  name: "shutdown",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "إيقاف تشغيل البوت بالكامل",
  commandCategory: "إدارة البوت",
  usages: "shutdown",
  cooldowns: 10
};

module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  try {
    await api.sendMessage("🔴 جاري إيقاف تشغيل البوت... وداعاً!", threadID, messageID);
  } catch (_) {}

  setTimeout(() => {
    try {
      // Signal the launcher (Main.js parent process) to run its shutdown() handler.
      // Main.js listens for SIGTERM and gracefully kills the bot child then exits.
      process.kill(process.ppid, "SIGTERM");
    } catch (_) {}
    // Fallback: exit this process directly if parent signal fails.
    setTimeout(() => process.exit(0), 1000);
  }, 800);
};
