/**
 * notiWhenListenError.js
 * --------------------------------------------------------------
 * Pushes listener / session errors out to operator-side channels:
 *   - Telegram bot (chat IDs comma/space separated)
 *   - Discord webhook URL(s)
 *
 * Inspired by GoatBot's `handlerWhenListenMqttError` flow but made
 * standalone, throttled, and safe to call from anywhere.
 *
 * Config block in ZAO-SETTINGS.json (all optional):
 *   "notiWhenListenMqttError": {
 *     "minIntervalMinutes": 10,
 *     "telegram":   { "enable": false, "botToken": "", "chatId": "" },
 *     "discordHook":{ "enable": false, "webhookUrl": "" }
 *   }
 *
 * If a section is missing or `enable !== true`, that channel is skipped
 * silently. The whole module no-ops gracefully if the settings block
 * is absent — so it's safe to leave wired in by default.
 */

const axios = require('axios');

let lastSentAt = 0;

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger && typeof logger.log === 'function') {
      logger.log([
        { message: '[ ERR-NOTI ]: ', color: ['red', 'cyan'] },
        { message: msg, color: level === 'error' ? 'red' : 'white' }
      ]);
      return;
    }
  } catch (_) {}
  (level === 'error' ? console.error : console.log)('[ERR-NOTI]', msg);
}

function splitAddresses(s) {
  if (!s) return [];
  return String(s).split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
}

function formatError(error) {
  if (error == null) return 'unknown';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.stack || error.message || String(error);
  if (typeof error === 'object') {
    if (error.stack) return error.stack;
    try { return JSON.stringify(error, null, 2); } catch (_) { return String(error); }
  }
  return String(error);
}

// [SECURITY FIX] Strip any bot token / webhook id that axios may have echoed
// into its error message or stack. Without this, a Telegram 4xx with the
// usual `Request failed … https://api.telegram.org/bot<TOKEN>/sendMessage`
// message would print the token straight into the workflow log.
function _redactSecrets(s) {
  if (s == null) return '';
  let out = String(s);
  // Telegram bot tokens follow `<digits>:<base64-ish>` — replace inside any URL
  out = out.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<TOKEN_REDACTED>');
  // Discord webhooks: `https://discord(app)?.com/api/webhooks/<id>/<token>`
  out = out.replace(/(\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/gi, '$1<TOKEN_REDACTED>');
  return out;
}

async function sendTelegram(cfg, body) {
  const token = cfg.botToken;
  const chatIds = splitAddresses(cfg.chatId);
  if (!token || !chatIds.length) return;

  const MAX_LEN = 4000; // Telegram hard limit is 4096
  let payload = body;
  if (payload.length > MAX_LEN) payload = payload.slice(0, MAX_LEN - 25) + '\n\n... (truncated)';

  for (const chat of chatIds) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chat,
        text: '```\n' + payload + '\n```',
        parse_mode: 'Markdown'
      }, { timeout: 10000 });
    } catch (e) {
      const reason = e.response?.data?.description || e.message;
      log('warn', `Telegram → ${chat} failed: ${_redactSecrets(reason)}`);
    }
  }
}

async function sendDiscord(cfg, body) {
  const urls = splitAddresses(cfg.webhookUrl);
  if (!urls.length) return;

  const MAX_LEN = 1900; // Discord 2000-char limit; leave headroom
  let payload = body;
  if (payload.length > MAX_LEN) payload = payload.slice(0, MAX_LEN - 25) + '\n\n... (truncated)';

  for (const url of urls) {
    try {
      await axios.post(url, {
        content: '```\n' + payload + '\n```'
      }, { timeout: 10000 });
    } catch (e) {
      const reason = e.response?.data?.message || e.message;
      log('warn', `Discord webhook failed: ${_redactSecrets(reason)}`);
    }
  }
}

/**
 * @param {*} error  raw error from listenMqtt callback (or anywhere)
 * @param {string} reason  short human label (e.g. "session expired")
 */
async function notify(error, reason) {
  let cfg;
  try {
    cfg = (global.config && global.config.notiWhenListenMqttError) || {};
  } catch (_) { cfg = {}; }

  const tg = cfg.telegram || {};
  const dc = cfg.discordHook || {};
  if (tg.enable !== true && dc.enable !== true) return; // nothing wired

  // Throttle so a flood of identical errors doesn't spam channels
  const minMs = (cfg.minIntervalMinutes || 10) * 60 * 1000;
  const now = Date.now();
  if (now - lastSentAt < minMs) return;
  lastSentAt = now;

  const botID  = (global.client && global.client.api && global.client.api.getCurrentUserID
                  && global.client.api.getCurrentUserID()) || global.botUserID || 'unknown';
  const ts     = new Date().toISOString();
  const header = `[ZAO bot ${botID}] ${reason || 'listen error'} @ ${ts}`;
  const body   = `${header}\n\n${formatError(error)}`;

  const tasks = [];
  if (tg.enable === true) tasks.push(sendTelegram(tg, body));
  if (dc.enable === true) tasks.push(sendDiscord(dc, body));
  await Promise.allSettled(tasks);
}

module.exports = { notify };
