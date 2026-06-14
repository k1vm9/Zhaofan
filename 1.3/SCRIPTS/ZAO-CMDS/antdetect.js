/**
 * Command: Anti-Detection Control Panel
 * Allows admins to view and manage anti-detection settings
 */

const antiDetection = require('../../includes/AntiDetectionEnhanced');
const rateLimiter = require('../../includes/EnhancedRateLimiter');

module.exports = {
  config: {
    name: 'antdetect',
    hasPermssion: 2,
    description: 'View and manage anti-detection settings',
    commandCategory: 'إدارة البوت',
    usages: '[status|settings|ua|presence]',
    cooldowns: 0,
  },
  
  run: async function({ message, args, api, event }) {
    const command = args[0]?.toLowerCase() || 'status';
    
    try {
      switch (command) {
        case 'status': {
          const status = antiDetection.getStatus();
          const rateLimitStatus = rateLimiter.getStatus();
          
          let msg = '🛡️ ANTI-DETECTION STATUS\n\n';
          msg += `📱 Current User-Agent:\n${status.currentUA}\n\n`;
          msg += `👤 Presence: ${status.currentPresence}\n\n`;
          msg += `⚙️ Rate Limiting:\n`;
          msg += `├ Threads Tracked: ${rateLimitStatus.threadsTracked}\n`;
          msg += `├ Users Tracked: ${rateLimitStatus.usersTracked}\n`;
          msg += `├ Global Queue: ${rateLimitStatus.globalQueue}\n`;
          msg += `└ Burst Active: ${rateLimitStatus.burstActive ? '🔥 YES' : '✅ NO'}\n`;
          
          return api.sendMessage(msg, event.threadID);
        }
        
        case 'ua': {
          antiDetection.rotateUA();
          const newUA = antiDetection.getCurrentUA();
          return api.sendMessage(
            `✅ User-Agent rotated:\n${newUA}`,
            event.threadID
          );
        }
        
        case 'settings': {
          const config = global.config?.rateLimiting || {};
          
          let msg = '⚙️ ANTI-DETECTION SETTINGS\n\n';
          msg += `Per-Thread:\n`;
          msg += `├ Max Messages: ${config.perThread?.maxMessages || 15}\n`;
          msg += `├ Window: ${config.perThread?.windowMinutes || 5}min\n\n`;
          msg += `Global:\n`;
          msg += `├ Max Messages: ${config.global?.maxMessages || 50}\n`;
          msg += `├ Window: ${config.global?.windowMinutes || 10}min\n\n`;
          msg += `Per-User:\n`;
          msg += `├ Max Commands: ${config.perUser?.maxCommands || 20}\n`;
          msg += `├ Window: ${config.perUser?.windowMinutes || 5}min\n\n`;
          msg += `Burst Cooling:\n`;
          msg += `├ Trigger Count: ${config.burstCooling?.triggerCount || 3}\n`;
          msg += `├ Min Cooling: ${config.burstCooling?.coolingMinMinutes || 2}min\n`;
          msg += `└ Max Cooling: ${config.burstCooling?.coolingMaxMinutes || 6}min`;
          
          return api.sendMessage(msg, event.threadID);
        }
        
        case 'help':
        default: {
          let msg = '🛡️ ANTI-DETECTION COMMANDS\n\n';
          msg += '/antdetect status - Show current status\n';
          msg += '/antdetect ua - Rotate user-agent\n';
          msg += '/antdetect settings - Show current settings\n';
          msg += '/antdetect help - Show this help\n';
          
          return api.sendMessage(msg, event.threadID);
        }
      }
    } catch (error) {
      return api.sendMessage(
        `❌ Error: ${error.message}`,
        event.threadID
      );
    }
  }
};
