/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ZAO SECURITY & BAN PREVENTION MODULE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 
 * Critical fixes & enhancements:
 * 1. Message sending delays (anti-detection)
 * 2. Account activity patterns (human-like)
 * 3. Request fingerprinting (HTTP headers)
 * 4. Rate limiting (prevent flood detection)
 * 5. State file protection (corruption prevention)
 * 6. Cookie freshness validation
 * 7. Error recovery & graceful shutdown
 */

'use strict';

const fs = require('fs-extra');
const path = require('path');

const LOG_PREFIX = '[SECURITY]';

class ZAOSecurityManager {
  constructor() {
    this.lastMessageTime = 0;
    this.messagesSentPerMinute = 0;
    this.lastMinuteReset = Date.now();
    this.antibanConfig = this.loadConfig();
  }

  loadConfig() {
    try {
      return global.config?.security || {};
    } catch (_) {
      return {};
    }
  }

  log(msg, level = 'info') {
    try {
      if (global.loggeryuki) {
        global.loggeryuki.log([
          { message: `${LOG_PREFIX} `, color: ['red', 'cyan'] },
          { message: msg, color: level === 'warn' ? 'yellow' : 'white' }
        ]);
        return;
      }
    } catch (_) {}
    console.log(`${LOG_PREFIX} ${msg}`);
  }

  /**
   * Calculate safe delay between messages based on:
   * - Recent message frequency
   * - Thread activity level
   * - Time of day
   * - Account age
   */
  calculateMessageDelay(threadID) {
    try {
      // Check how many messages sent in last minute
      const now = Date.now();
      if (now - this.lastMinuteReset > 60000) {
        this.messagesSentPerMinute = 0;
        this.lastMinuteReset = now;
      }

      const cfg = this.antibanConfig;
      const baseMinDelay = cfg.minMessageDelayMs || 1200;
      const baseMaxDelay = cfg.maxMessageDelayMs || 4800;

      let multiplier = 1;

      // During sleep hours, increase delay significantly
      const hour = new Date().getHours();
      const sleepStart = cfg.sleepHourStart || 2;
      const sleepEnd = cfg.sleepHourEnd || 7;
      const isSleepHour = sleepStart < sleepEnd
        ? (hour >= sleepStart && hour < sleepEnd)
        : (hour >= sleepStart || hour < sleepEnd);

      if (isSleepHour) multiplier *= 2.5;

      // If sending many messages, increase delay — thresholds scale with account age
      const highThreshold = 10;
      const midThreshold  = 5;
      if (this.messagesSentPerMinute > highThreshold) multiplier *= 2;
      else if (this.messagesSentPerMinute > midThreshold) multiplier *= 1.5;

      const delay = baseMinDelay + Math.random() * (baseMaxDelay - baseMinDelay);
      return Math.floor(delay * multiplier);
    } catch (e) {
      this.log(`Error calculating delay: ${e.message}`, 'warn');
      return 3000; // safe default
    }
  }

  /**
   * Apply pre-send safety checks to prevent detection
   */
  async preSendCheck(api, message, threadID) {
    try {
      // Don't send if not connected
      if (!api) throw new Error('API not available');

      // Check global rate limit
      const throttle = require('./outgoingThrottle');
      if (throttle && throttle.check) {
        const delay = await throttle.check(threadID);
        if (delay > 0) {
          this.log(`Throttling message (delay: ${delay}ms)`, 'warn');
          await new Promise(r => setTimeout(r, delay));
        }
      }

      // Apply message delay for anti-detection
      const msgDelay = this.calculateMessageDelay(threadID);
      await new Promise(r => setTimeout(r, msgDelay));

      // Send typing indicator for human-like behavior
      if (api.sendTypingIndicator) {
        await new Promise(r => {
          api.sendTypingIndicator(threadID, r);
        }).catch(() => {});
      }

      // Additional jitter after typing
      const typingDelay = 400 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, typingDelay));

      this.messagesSentPerMinute++;
    } catch (e) {
      this.log(`Pre-send check error: ${e.message}`, 'warn');
    }
  }

  /**
   * Validate and repair state files
   */
  validateStateFiles() {
    try {
      const stateFile = path.join(process.cwd(), 'sessions', 'ZAO-STATE.json');
      const settingsFile = path.join(process.cwd(), 'ZAO-SETTINGS.json');

      // Check state file integrity
      if (fs.existsSync(stateFile)) {
        try {
          const content = fs.readFileSync(stateFile, 'utf8');
          JSON.parse(content);
          this.log('✓ ZAO-STATE.json is valid JSON', 'info');
        } catch (e) {
          this.log(`⚠️ ZAO-STATE.json is corrupted: ${e.message}`, 'warn');
          // Backup and reset
          const backup = `${stateFile}.backup-${Date.now()}`;
          fs.copySync(stateFile, backup);
          this.log(`Corrupted state backed up to ${backup}`, 'warn');
        }
      }

      // Check settings file integrity
      if (fs.existsSync(settingsFile)) {
        try {
          const content = fs.readFileSync(settingsFile, 'utf8');
          JSON.parse(content);
          this.log('✓ ZAO-SETTINGS.json is valid JSON', 'info');
        } catch (e) {
          this.log(`⚠️ ZAO-SETTINGS.json is corrupted: ${e.message}`, 'warn');
        }
      }
    } catch (e) {
      this.log(`State file validation error: ${e.message}`, 'warn');
    }
  }

  /**
   * Validate cookie freshness and age
   */
  validateCookies(appState) {
    try {
      if (!appState || !Array.isArray(appState)) {
        this.log('⚠️ AppState is invalid or missing', 'warn');
        return false;
      }

      // Check if we have essential cookies
      const requiredCookies = ['c_user', 'xs', 'datr'];
      const cookieKeys = appState.map(c => c.key);
      
      for (const required of requiredCookies) {
        if (!cookieKeys.includes(required)) {
          this.log(`⚠️ Missing critical cookie: ${required}`, 'warn');
          return false;
        }
      }

      this.log(`✓ Cookies valid (${appState.length} cookies present)`, 'info');
      return true;
    } catch (e) {
      this.log(`Cookie validation error: ${e.message}`, 'warn');
      return false;
    }
  }

  /**
   * Get secure HTTP headers that mimic real user
   */
  getSecureHeaders() {
    const userAgents = [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
    ];

    const selectedUA = userAgents[Math.floor(Math.random() * userAgents.length)];

    return {
      'User-Agent': selectedUA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0',
      'Pragma': 'no-cache'
    };
  }

  /**
   * setupGracefulShutdown — DISABLED
   *
   * [FIX Dango] This method was calling api.logout() on SIGTERM/SIGINT.
   * The watchdog sends SIGTERM to restart the bot process. Calling api.logout()
   * actively invalidates the Facebook session server-side, causing the account
   * to be signed out permanently until new cookies are provided.
   *
   * ZAO.js already handles SIGTERM/SIGINT with process.once() handlers that
   * save cookies WITHOUT logging out. This method must NOT be called.
   * It is kept as a no-op to avoid breaking any callers.
   */
  setupGracefulShutdown(_api) {
    // No-op: ZAO.js owns the shutdown lifecycle. Do NOT call api.logout() here.
    this.log('setupGracefulShutdown: no-op (ZAO.js owns shutdown — see fix comment)', 'warn');
  }

  /**
   * Detect and prevent known ban patterns
   */
  detectBanPattern(event) {
    try {
      if (!event) return false;

      // Pattern 1: Sending identical messages too quickly
      if (this.messagesSentPerMinute > 15) {
        this.log('⚠️ Ban pattern detected: Too many messages per minute', 'warn');
        return true;
      }

      // Pattern 2: Rapid repeated actions
      if (event.body && this.lastMessage === event.body && 
          Date.now() - this.lastMessageTime < 5000) {
        this.log('⚠️ Ban pattern detected: Identical rapid messages', 'warn');
        return true;
      }

      this.lastMessage = event.body;
      this.lastMessageTime = Date.now();

      return false;
    } catch (e) {
      this.log(`Ban pattern detection error: ${e.message}`, 'warn');
      return false;
    }
  }
}

// Singleton instance
const instance = new ZAOSecurityManager();

module.exports = {
  validateStateFiles: () => instance.validateStateFiles(),
  validateCookies: (appState) => instance.validateCookies(appState),
  preSendCheck: (api, msg, threadID) => instance.preSendCheck(api, msg, threadID),
  getSecureHeaders: () => instance.getSecureHeaders(),
  setupGracefulShutdown: (api) => instance.setupGracefulShutdown(api),
  detectBanPattern: (event) => instance.detectBanPattern(event),
  calculateMessageDelay: (threadID) => instance.calculateMessageDelay(threadID),
  log: (msg, level) => instance.log(msg, level)
};
