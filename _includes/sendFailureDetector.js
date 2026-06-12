'use strict';
/**
 * sendFailureDetector.js
 *
 * Monitors send-message calls for consecutive failures or known block-error
 * patterns and triggers autoRelogin when a threshold is crossed.
 *
 * Ported from white/bot/accountRotator/detector.js and adapted for ZAO
 * (uses global._triggerAutoRelogin instead of rotateAccount).
 *
 * Detection signals:
 *  1. Consecutive sendMessage failures within a sliding window
 *  2. Known Facebook block / spam / checkpoint error strings
 *  3. HTTP 403 / 429 responses detected externally via onHttpResponse()
 *  4. MQTT-level errors reported via onMqttError()
 */

// [FIX Dango] Raised threshold: 5/60s was hair-trigger on flaky networks (Replit).
// 8 failures in 2 minutes is a clearer signal of actual blocking.
const FAILURE_THRESHOLD  = 8;
const FAILURE_WINDOW_MS  = 2 * 60 * 1000;
const BLOCK_COOLDOWN_MS  = 5 * 60 * 1000;

let sendFailures      = 0;
let sendSuccesses     = 0;
let lastFailureTime   = 0;
let reportedBlockedAt = 0;

// [FIX Dango] Removed generic terms ('checkpoint', 'block', 'blocked', 'spam',
// 'suspended', 'disabled') — these appear in normal FB API responses and caused
// false-positive tier switches. Only keep unambiguous account-action errors.
const BLOCK_PATTERNS = [
  'account_inactive', 'login_blocked', 'OAuthException',
  'This account is not allowed', 'temporarily blocked',
  'message not sent', 'cannot send', "you can't send"
];

function isBlockError(err) {
  if (!err) return false;
  const msg = (typeof err === 'string'
    ? err
    : (err?.error || err?.message || JSON.stringify(err) || '')
  ).toLowerCase();
  return BLOCK_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: '[ SEND-DETECT ]: ', color: ['red', 'cyan'] },
        { message: msg, color: 'white' }
      ]);
      return;
    }
  } catch (_) {}
  console[level === 'error' ? 'error' : 'warn']('[SEND-DETECT]', msg);
}

async function triggerRotation(reason) {
  const now = Date.now();
  if (now - reportedBlockedAt < BLOCK_COOLDOWN_MS) return;
  reportedBlockedAt = now;
  sendFailures = 0;

  log('warn', `Block detected — ${reason}`);

  if (typeof global._triggerAutoRelogin === 'function') {
    try { global._triggerAutoRelogin(new Error(reason)); } catch (_) {}
  }
}

module.exports.onSendSuccess = function () {
  sendSuccesses++;
  if (sendSuccesses >= 3) {
    sendFailures  = 0;
    sendSuccesses = 0;
  }
};

module.exports.onSendFailure = function (err) {
  const now = Date.now();
  sendSuccesses = 0;

  if (now - lastFailureTime > FAILURE_WINDOW_MS) {
    sendFailures = 0;
  }
  lastFailureTime = now;
  sendFailures++;

  const errStr = typeof err === 'string' ? err : (err?.error || err?.message || '');
  log('warn', `Send failure #${sendFailures}: ${errStr}`);

  if (isBlockError(err)) {
    triggerRotation(`Send error: "${errStr}"`);
    return;
  }

  if (sendFailures >= FAILURE_THRESHOLD) {
    triggerRotation(`${sendFailures} consecutive send failures within ${FAILURE_WINDOW_MS / 1000}s`);
  }
};

module.exports.onMqttError = function (error) {
  if (!isBlockError(error)) return;
  const errStr = typeof error === 'string' ? error : (error?.error || error?.message || JSON.stringify(error) || '');
  triggerRotation(`MQTT error: "${errStr}"`);
};

module.exports.onHttpResponse = function (statusCode, body) {
  // [FIX Dango] Removed body.includes('checkpoint') and body.includes('blocked') —
  // these match normal Facebook HTML and cause false-positive tier switches.
  // HTTP 429 alone is also too aggressive — FB returns it for rate limits but the
  // session is still alive. Only act on definitive auth failures.
  const bodyStr = typeof body === 'string' ? body.toLowerCase() : '';
  const isBlocked =
    statusCode === 401 ||
    (statusCode === 403 && bodyStr.includes('login_required')) ||
    bodyStr.includes('account_inactive') ||
    bodyStr.includes('login_blocked');

  if (isBlocked) {
    triggerRotation(`HTTP ${statusCode} auth failure detected`);
  }
};

module.exports.onPingDetectedBlock = function (reason) {
  triggerRotation(`Ping detected: "${reason}"`);
};

module.exports.reset = function () {
  sendFailures = sendSuccesses = 0;
  lastFailureTime = reportedBlockedAt = 0;
};
