/**
 * autoUptime.js
 * --------------------------------------------------------------
 * Optional external-URL ping for free hosts (Render, Glitch, Replit
 * deployments) that put a project to sleep when no inbound traffic
 * is detected.
 *
 * Reads from ZAO-SETTINGS.json:
 *   "autoUptime": {
 *     "enable": false,
 *     "url": "https://my-bot.onrender.com/",   // omit → auto-detect Replit URL
 *     "intervalSeconds": 180,
 *     "_note": "Pings an external URL on a schedule so free hosts don't sleep the bot."
 *   }
 *
 * Auto-detect order when `url` is empty:
 *   1. process.env.REPLIT_DEV_DOMAIN
 *   2. https://<REPL_SLUG>.<REPL_OWNER>.repl.co
 *   3. http://localhost:<PORT>
 *
 * On its own this is *additive* — the Auto-Ping system in ZAO.js hits the
 * local panel every 8-18 min. This module exists so operators on free
 * hosts can also keep the *outside* world reaching the panel.
 */

const axios = require('axios');

let timer = null;
let consecutiveFailures = 0;

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger && typeof logger.log === 'function') {
      logger.log([
        { message: '[ AUTO-UPTIME ]: ', color: ['red', 'cyan'] },
        { message: msg, color: level === 'error' ? 'red' : 'white' }
      ]);
      return;
    }
  } catch (_) {}
  (level === 'error' ? console.error : console.log)('[AUTO-UPTIME]', msg);
}

function resolveUrl(cfg) {
  if (cfg.url && /^https?:\/\//.test(cfg.url)) return cfg.url;

  const port = process.env.PORT || 5000;

  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/`;
  }
  if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
    return `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/`;
  }
  return `http://127.0.0.1:${port}/`;
}

function start() {
  let cfg;
  try {
    cfg = (global.config && global.config.autoUptime) || {};
  } catch (_) { cfg = {}; }

  if (cfg.enable !== true) return;

  if (timer) { clearInterval(timer); timer = null; }

  const url = resolveUrl(cfg);
  const intervalMs = Math.max(30, Number(cfg.intervalSeconds) || 180) * 1000;

  log('info', `enabled — pinging ${url} every ${Math.round(intervalMs / 1000)} s`);

  const tick = async () => {
    try {
      await axios.get(url, { timeout: 15000, maxRedirects: 3 });
      if (consecutiveFailures > 0) {
        log('info', `recovered after ${consecutiveFailures} failed ping(s)`);
        consecutiveFailures = 0;
      }
    } catch (e) {
      consecutiveFailures++;
      // Only log every 3rd failure to avoid log spam
      if (consecutiveFailures === 1 || consecutiveFailures % 3 === 0) {
        log('warn', `ping #${consecutiveFailures} failed: ${e.code || e.message}`);
      }
    }
  };

  // First tick immediately so we surface config errors fast
  tick();
  timer = setInterval(tick, intervalMs);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  consecutiveFailures = 0;
}

module.exports = { start, stop };
