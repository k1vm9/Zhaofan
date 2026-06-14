'use strict';
/**
 * customPoller.js — HTTP Poller fallback when MQTT goes silent
 *
 * Ported from DAVID-FINAL and adapted for ZAO's architecture.
 * Starts automatically when MQTT health check cannot recover the listener.
 * Runs getThreadList every N seconds as both a keepalive and a crude event
 * source — refreshes lastMqttActivity so the health check doesn't keep
 * triggering restarts during a genuine MQTT outage.
 *
 * Stops itself as soon as true MQTT activity resumes.
 */

let _active      = false;
let _timer       = null;
let _intervalMs  = 8000;
let _stopAfterMs = 10 * 60 * 1000; // auto-stop after 10 min; MQTT should have recovered
let _startedAt   = null;
let _stopTimer   = null;

function log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: '[ HTTP-POLLER ]: ', color: ['red', 'cyan'] },
        { message: msg, color: 'white' },
      ]);
      return;
    }
  } catch (_) {}
  console.log('[HTTP-POLLER]', msg);
}

function stopPoller() {
  _active = false;
  if (_timer)     { clearTimeout(_timer);     _timer     = null; }
  if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }
  _startedAt = null;
}

function startPoller(api, intervalMs) {
  if (_active) return;
  if (!api || typeof api.getThreadList !== 'function') return;

  _active     = true;
  _intervalMs = intervalMs || 8000;
  _startedAt  = Date.now();

  log(`HTTP poller started — interval ${_intervalMs}ms (MQTT fallback)`);

  // Auto-stop after _stopAfterMs so we don't poll forever if MQTT never recovers
  _stopTimer = setTimeout(() => {
    if (_active) {
      log('Auto-stopped after timeout — if MQTT is still dead the health check will handle it');
      stopPoller();
    }
  }, _stopAfterMs);
  if (_stopTimer.unref) _stopTimer.unref();

  let lastSeen = '';

  async function poll() {
    if (!_active) return;

    // If MQTT has recovered, stop the poller
    const lastTrue = global.lastMqttOnlyActivity || global.lastMqttActivity || 0;
    if (_startedAt && lastTrue > _startedAt) {
      log('MQTT recovered — stopping HTTP poller');
      stopPoller();
      return;
    }

    try {
      const threads = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('getThreadList timeout')), 10000);
        api.getThreadList(3, null, ['INBOX'], (e, d) => {
          clearTimeout(t);
          if (e) return rej(e);
          res(d);
        });
      });

      const key = JSON.stringify((threads || []).map(t => t.threadID));
      if (key !== lastSeen) {
        lastSeen = key;
        // Counts as activity — prevents health-check false-alarm restarts
        global.lastMqttActivity = Date.now();
      }
    } catch (e) {
      log('Poll error: ' + (e && e.message ? e.message : String(e)));
    }

    if (_active) _timer = setTimeout(poll, _intervalMs);
  }

  poll().catch(() => {});
}

function isActive() { return _active; }

module.exports = { startPoller, stopPoller, isActive };
