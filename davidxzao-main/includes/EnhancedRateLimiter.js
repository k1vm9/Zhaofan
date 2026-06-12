/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ENHANCED RATE LIMITING ENGINE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 
 * Prevents detection through:
 * - Per-thread message limiting
 * - Global burst protection
 * - Per-user command limiting
 * - Intelligent cooling periods
 * - Admin exemptions
 * 
 * Facebook's detector watches for:
 * - Too many messages per minute (signature of automation)
 * - Identical patterns across threads
 * - Rapid-fire responses
 */

'use strict';

const logger = require('../utils/log.js');

function log(level, msg) {
  try {
    if (logger) {
      if (level === 'info') return logger.log([
        { message: '[RATE-LIMIT] ', color: ['red', 'cyan'] },
        { message: msg, color: 'white' }
      ]);
      if (level === 'warn') return logger.log([
        { message: '[RATE-LIMIT] ', color: ['red', 'cyan'] },
        { message: msg, color: 'yellow' }
      ]);
    }
  } catch (_) {}
  console.log(`[RATE-LIMIT] ${msg}`);
}

// ─── In-memory tracking ───────────────────────────────────────────────────────
const threadSendTimes = new Map();      // threadID → [timestamps]
const userCommandTimes = new Map();     // userID → [timestamps]
const globalSendTimes = [];
// H-01 fix: per-thread burst cooling so a spam attack in one group doesn't
// silence the bot in every other group during the cooling window.
const burstCoolingUntil = new Map();    // threadID → coolEnd timestamp

// ─── Configuration ────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  // Per-thread limits
  perThread: {
    enabled: true,
    maxMessages: 15,          // Max messages per thread in window
    windowMinutes: 5,         // Time window
  },
  
  // Global limits
  global: {
    enabled: true,
    maxMessages: 50,          // Max total messages in window
    windowMinutes: 10,        // Time window
  },
  
  // Per-user command limiting
  perUser: {
    enabled: true,
    maxCommands: 20,
    windowMinutes: 5,
  },
  
  // Burst cooling (when limits repeatedly triggered)
  burstCooling: {
    enabled: true,
    triggerCount: 3,          // How many times to trigger before cooling
    triggerWindowMinutes: 25,
    coolingMinMinutes: 2,
    coolingMaxMinutes: 6,
  },
  
  // Cooling delays
  cooling: {
    minSeconds: 15,
    maxSeconds: 80,
  },
  
  // Admin exemption
  adminIDs: [],
};

let config = { ...DEFAULT_CONFIG };

function getConfig() {
  // Try to read from global config — ZAO uses global.config, not global.GoatBot
  try {
    const cfg = global.config?.rateLimiting || {};
    if (cfg.perThread?.maxMessages) {
      config = { ...config, ...cfg };
    }
  } catch (_) {}
  return config;
}

function isAdmin(userID) {
  // ZAO stores admin IDs in global.config.ADMINBOT — global.GoatBot is never set
  const adminList = (global.config?.ADMINBOT || []).map(String);
  return adminList.includes(String(userID));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Check if a thread is approaching/exceeding message limit
 */
function checkThreadLimit(threadID) {
  const cfg = getConfig();
  if (!cfg.perThread.enabled) return { limited: false };
  
  if (isAdmin(threadID)) return { limited: false, reason: 'admin_exempt' };
  
  const now = Date.now();
  const windowMs = cfg.perThread.windowMinutes * 60_000;
  
  if (!threadSendTimes.has(threadID)) {
    threadSendTimes.set(threadID, []);
  }
  
  const times = threadSendTimes.get(threadID);
  const recent = times.filter(t => now - t < windowMs);
  threadSendTimes.set(threadID, recent);
  
  if (recent.length >= cfg.perThread.maxMessages) {
    return {
      limited: true,
      reason: 'thread_limit_exceeded',
      count: recent.length,
      max: cfg.perThread.maxMessages
    };
  }
  
  if (recent.length >= Math.floor(cfg.perThread.maxMessages * 0.7)) {
    return {
      limited: true,
      reason: 'thread_limit_approaching',
      count: recent.length,
      max: cfg.perThread.maxMessages
    };
  }
  
  return { limited: false };
}

/**
 * Check if user is exceeding command limit
 */
function checkUserCommandLimit(userID) {
  const cfg = getConfig();
  if (!cfg.perUser.enabled) return { limited: false };
  
  if (isAdmin(userID)) return { limited: false };
  
  const now = Date.now();
  const windowMs = cfg.perUser.windowMinutes * 60_000;
  
  if (!userCommandTimes.has(userID)) {
    userCommandTimes.set(userID, []);
  }
  
  const times = userCommandTimes.get(userID);
  const recent = times.filter(t => now - t < windowMs);
  userCommandTimes.set(userID, recent);
  
  if (recent.length >= cfg.perUser.maxCommands) {
    return {
      limited: true,
      reason: 'user_command_limit',
      count: recent.length,
      max: cfg.perUser.maxCommands
    };
  }
  
  return { limited: false };
}

/**
 * Check global message limit
 */
function checkGlobalLimit() {
  const cfg = getConfig();
  if (!cfg.global.enabled) return { limited: false };
  
  const now = Date.now();
  const windowMs = cfg.global.windowMinutes * 60_000;
  
  const recent = globalSendTimes.filter(t => now - t < windowMs);
  globalSendTimes.length = 0;
  globalSendTimes.push(...recent);
  
  if (recent.length >= cfg.global.maxMessages) {
    return {
      limited: true,
      reason: 'global_limit_exceeded',
      count: recent.length,
      max: cfg.global.maxMessages
    };
  }
  
  return { limited: false };
}

/**
 * Apply throttle delay
 */
async function applyThrottle(threadID, userID) {
  const cfg = getConfig();
  
  // Check if burst cooling is active for this specific thread
  const _threadCoolEnd = burstCoolingUntil.get(threadID) || 0;
  if (Date.now() < _threadCoolEnd) {
    const waitMs = _threadCoolEnd - Date.now();
    log('warn', `🧊 Burst cooling [${threadID}]: waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    burstCoolingUntil.delete(threadID);
    return;
  }
  
  // Check thread limit
  const threadCheck = checkThreadLimit(threadID);
  if (threadCheck.limited) {
    const delay = randInt(cfg.cooling.minSeconds * 1000, cfg.cooling.maxSeconds * 1000);
    log('warn', `⏱️  Thread limit (${threadCheck.count}/${threadCheck.max}): cooling ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
  
  // Check user command limit
  const userCheck = checkUserCommandLimit(userID);
  if (userCheck.limited) {
    const delay = randInt(cfg.cooling.minSeconds * 1000, cfg.cooling.maxSeconds * 1000);
    log('warn', `👤 User limit (${userCheck.count}/${userCheck.max}): cooling ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
  
  // Check global limit
  const globalCheck = checkGlobalLimit();
  if (globalCheck.limited) {
    const delay = randInt(cfg.cooling.minSeconds * 1000 * 2, cfg.cooling.maxSeconds * 1000 * 2);
    log('warn', `⛔ Global limit (${globalCheck.count}/${globalCheck.max}): cooling ${Math.round(delay / 1000)}s`);
    
    // Trigger per-thread burst cooling
    if (cfg.burstCooling.enabled) {
      const burstDelay = randInt(
        cfg.burstCooling.coolingMinMinutes * 60_000,
        cfg.burstCooling.coolingMaxMinutes * 60_000
      );
      burstCoolingUntil.set(threadID, Date.now() + burstDelay);
      log('warn', `🚨 BURST DETECTED [${threadID}]: ${Math.round(burstDelay / 60000)}min cooling activated (other threads unaffected)`);
    }
    
    await sleep(delay);
  }
}

/**
 * Record a sent message
 */
function recordSend(threadID, userID) {
  const now = Date.now();
  
  // Record in thread
  if (!threadSendTimes.has(threadID)) {
    threadSendTimes.set(threadID, []);
  }
  threadSendTimes.get(threadID).push(now);
  
  // Record globally
  globalSendTimes.push(now);
}

/**
 * Wrap api.sendMessage with rate limiting
 */
function wrapSendMessage(api) {
  if (!api || api._rateLimitWrapped) return;
  api._rateLimitWrapped = true;
  
  const original = api.sendMessage.bind(api);
  
  api.sendMessage = async function(msg, threadID, callback, messageID) {
    try {
      // Apply rate limiting
      const userID = global.botUserID || 'BOT';
      await applyThrottle(String(threadID), String(userID));
      recordSend(String(threadID), String(userID));
    } catch (e) {
      // Don't break the send
    }
    
    return original(msg, threadID, callback, messageID);
  };
  
  log('info', 'Rate limiting engine active');
}

/**
 * Cleanup old entries
 */
function cleanup() {
  const windowMs = 30 * 60_000;
  const now = Date.now();
  
  for (const [tid, times] of threadSendTimes.entries()) {
    const fresh = times.filter(t => now - t < windowMs);
    if (fresh.length === 0) threadSendTimes.delete(tid);
    else threadSendTimes.set(tid, fresh);
  }
  
  for (const [uid, times] of userCommandTimes.entries()) {
    const fresh = times.filter(t => now - t < windowMs);
    if (fresh.length === 0) userCommandTimes.delete(uid);
    else userCommandTimes.set(uid, fresh);
  }
}

// Cleanup every 15 minutes — guard so hot-reloads don't stack duplicate timers
if (!global.__enhancedRateLimiterCleanTimer) {
  global.__enhancedRateLimiterCleanTimer = setInterval(cleanup, 15 * 60_000);
  if (global.__enhancedRateLimiterCleanTimer.unref)
    global.__enhancedRateLimiterCleanTimer.unref();
}

// ── Pass 3: Periodic GC — evict inactive thread/user Map entries ─────────────
// threadSendTimes and userCommandTimes accumulate one Map entry per unique
// thread/user ever seen.  Arrays inside are pruned on access, but zero-length
// (or fully-expired) entries stay in the Map forever.  On a busy bot that
// interacts with hundreds of groups this causes steady unbounded growth.
// This GC runs every 10 min and deletes any entry whose window has expired.
setInterval(() => {
  try {
    const now        = Date.now();
    const threadWin  = (DEFAULT_CONFIG.perThread.windowMinutes || 5) * 60_000;
    const userWin    = (DEFAULT_CONFIG.perUser.windowMinutes   || 5) * 60_000;

    for (const [key, times] of threadSendTimes.entries()) {
      if (!times.length || now - Math.max(...times) > threadWin) {
        threadSendTimes.delete(key);
      }
    }
    for (const [key, times] of userCommandTimes.entries()) {
      if (!times.length || now - Math.max(...times) > userWin) {
        userCommandTimes.delete(key);
      }
    }
  } catch (_) {}
}, 10 * 60 * 1000).unref();

module.exports = {
  applyThrottle,
  recordSend,
  wrapSendMessage,
  checkThreadLimit,
  checkUserCommandLimit,
  checkGlobalLimit,
  setConfig: (newConfig) => { config = { ...config, ...newConfig }; },
  getStatus: () => ({
    threadsTracked: threadSendTimes.size,
    usersTracked: userCommandTimes.size,
    globalQueue: globalSendTimes.length,
    burstActive: [...burstCoolingUntil.values()].some(t => Date.now() < t),
    burstCoolingThreads: [...burstCoolingUntil.entries()]
      .filter(([, t]) => Date.now() < t)
      .map(([tid]) => tid)
  })
};
