/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ATOMIC STATE & COOKIE MANAGER
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 
 * Safe file operations for state and cookies:
 * - Atomic writes (prevent corruption)
 * - Backup before overwrite
 * - Validation on read
 * - Recovery mechanisms
 */

'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const LOG_PREFIX = '[STATE-MANAGER]';

function log(msg, level = 'info') {
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
 * Atomic write to file (write to temp file, then rename)
 * Prevents corruption if process crashes mid-write
 */
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  let tempFile;
  try {
    tempFile = path.join(dir, `.${filename}.tmp-${Date.now()}`);

    // Write to temporary file
    fs.writeFileSync(tempFile, data, 'utf8');

    // Create backup of original if it exists
    if (fs.existsSync(filePath)) {
      const backupFile = `${filePath}.backup-${Date.now()}`;
      fs.copySync(filePath, backupFile);
      
      // Keep only the 5 most recent backups
      const dir_contents = fs.readdirSync(path.dirname(filePath));
      const backups = dir_contents
        .filter(f => f.startsWith(`${filename}.backup-`))
        .sort()
        .reverse();
      
      if (backups.length > 5) {
        for (let i = 5; i < backups.length; i++) {
          fs.removeSync(path.join(path.dirname(filePath), backups[i]));
        }
      }
    }

    // Atomic rename (swap temp file with target)
    fs.renameSync(tempFile, filePath);
    log(`✓ Atomic write to ${filename}`, 'info');
    return true;
  } catch (e) {
    log(`✗ Atomic write failed: ${e.message}`, 'warn');
    // Clean up temp file if it exists — tempFile is declared in outer scope so it is accessible here
    try {
      if (tempFile && fs.existsSync(tempFile)) fs.removeSync(tempFile);
    } catch (_) {}
    return false;
  }
}

/**
 * Safe read with JSON validation
 */
function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      log(`File not found: ${filePath}`, 'warn');
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return data;
  } catch (e) {
    log(`✗ Failed to read ${path.basename(filePath)}: ${e.message}`, 'warn');
    
    // Try to recover from backup
    try {
      const dir_contents = fs.readdirSync(path.dirname(filePath));
      const backups = dir_contents
        .filter(f => f.startsWith(`${path.basename(filePath)}.backup-`))
        .sort()
        .reverse();
      
      if (backups.length > 0) {
        const latestBackup = path.join(path.dirname(filePath), backups[0]);
        log(`Recovering from backup: ${backups[0]}`, 'warn');
        const content = fs.readFileSync(latestBackup, 'utf8');
        return JSON.parse(content);
      }
    } catch (_) {}
    
    return null;
  }
}

/**
 * Validate cookie array structure
 */
function validateCookies(appState) {
  try {
    if (!Array.isArray(appState)) {
      return false;
    }

    // Check for required cookies
    const keys = appState.map(c => c.key);
    const required = ['c_user', 'xs', 'datr'];
    
    for (const req of required) {
      if (!keys.includes(req)) {
        log(`⚠️ Missing required cookie: ${req}`, 'warn');
        return false;
      }
    }

    return true;
  } catch (e) {
    log(`Cookie validation error: ${e.message}`, 'warn');
    return false;
  }
}

/**
 * Get cookie age (when appState was last updated)
 */
function getCookieAge(appState) {
  try {
    if (!Array.isArray(appState) || appState.length === 0) {
      return Infinity;
    }

    // Try to find the most recent cookie by expiration
    const now = Date.now();
    let minAge = Infinity;

    for (const cookie of appState) {
      if (cookie.expires) {
        const age = now - cookie.expires;
        minAge = Math.min(minAge, age);
      }
    }

    return minAge === Infinity ? now : minAge;
  } catch (e) {
    log(`Cookie age calculation error: ${e.message}`, 'warn');
    return Infinity;
  }
}

/**
 * Sanitize cookies (remove sensitive data for logging)
 */
function sanitizeCookies(appState) {
  try {
    if (!Array.isArray(appState)) return [];
    
    return appState.map(c => ({
      key: c.key,
      domain: c.domain || 'unknown',
      httpOnly: c.httpOnly || false,
      secure: c.secure || false
    }));
  } catch (e) {
    return [];
  }
}

module.exports = {
  atomicWrite,
  safeRead,
  validateCookies,
  getCookieAge,
  sanitizeCookies,
  log
};
