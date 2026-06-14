/**
 * graphqlVisit.js
 * --------------------------------------------------------------
 * Periodically fires an authenticated GraphQL request that mimics
 * what the real Messenger / Facebook web client does when the user
 * checks notifications. This generates "human-looking" background
 * traffic on the bot's session so Facebook is less likely to flag
 * it as a headless / inactive account.
 *
 * Pattern adapted from seikobot/utils/keepalive.js but rewritten:
 *   - Uses the FCA `api.httpPost` helper (rides on the live cookies).
 *   - Random 30–120 min cadence (not a fixed interval).
 *   - Self-healing: silent failure, just retry next cycle.
 *
 * This is *additive* to the existing keep-alive ping in keepAlive.js
 * and the simple GET-based notification visit already inside ZAO.js.
 * Three different traffic flavours = harder to fingerprint.
 */

let timer = null;

function log(level, msg) {
  try {
    const logger = global.loggeryuki;
    if (logger && typeof logger.log === 'function') {
      logger.log([
        { message: '[ GQL-VISIT ]: ', color: ['red', 'cyan'] },
        { message: msg, color: level === 'error' ? 'red' : 'white' }
      ]);
      return;
    }
  } catch (_) {}
  (level === 'error' ? console.error : console.log)('[GQL-VISIT]', msg);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function doVisit(api) {
  // [FIX X05] — Suppress GraphQL visits during humanStealth session breaks.
  if (global._humanStealthBreak) return;
  if (!api || typeof api.httpPost !== 'function' || typeof api.getCurrentUserID !== 'function') return;

  const botID = api.getCurrentUserID();
  if (!botID) return;

  const form = {
    av: botID,
    fb_api_req_friendly_name: 'CometNotificationsDropdownQuery',
    fb_api_caller_class: 'RelayModern',
    doc_id: '5025284284225032',
    variables: JSON.stringify({
      count: 5,
      environment: 'MAIN_SURFACE',
      menuUseEntryPoint: true,
      scale: 1
    })
  };

  return new Promise((resolve) => {
    try {
      api.httpPost('https://www.facebook.com/api/graphql/', form, (err) => {
        if (err) log('warn', `GraphQL notif fetch failed: ${err.message || err}`);
        else log('info', 'GraphQL notification dropdown fetched ✓');
        resolve();
      });
    } catch (e) {
      log('warn', `httpPost threw: ${e.message || e}`);
      resolve();
    }
  });
}

function scheduleNext(api) {
  // MODERATED: stretched from 30-120 min to 60-180 min.
  // keepAlive already fires a CometNotificationsDropdownQuery every 60-180 min.
  // Running the same query twice as often just doubles the automated API
  // footprint with no stealth benefit.
  const delay = rand(60, 180) * 60 * 1000;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await doVisit(api);
    scheduleNext(api);
  }, delay);
  log('info', `next GraphQL visit in ${Math.round(delay / 60000)} min`);
}

function start(api) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!api) return;
  // [Sustain priming — reinq pattern from handleNotification.js]
  // Fire one notification visit right after login (random 5-15s) so a
  // freshly-logged-in session shows immediate human-looking activity.
  // Without this the first GraphQL visit is 30-120 min after boot,
  // leaving a long blind window where Facebook sees no client traffic.
  const primingDelay = rand(5, 15) * 1000;
  setTimeout(() => {
    // [FIX X05] — Honour break flag even during priming window.
    if (global._humanStealthBreak) return;
    doVisit(api).catch(() => {});
  }, primingDelay);
  log('info', `priming GraphQL visit in ${Math.round(primingDelay / 1000)}s`);
  scheduleNext(api);
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = { start, stop };
