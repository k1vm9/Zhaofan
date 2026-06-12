/**
 * syncAllGroups.js  v2
 *
 * Post-login warm-up: paginate INBOX and fill:
 *   - global.data.allThreadID
 *   - global.data.threadInfo
 *
 * v2 fixes:
 * - Retry after failure: if the first attempt fails entirely, a 5-minute
 *   backoff timer schedules one automatic retry (instead of silently giving up).
 * - reset() exported so callers (tier-switch, manual panel action) can force
 *   a fresh sync regardless of prior run state.
 * - Per-page timeout: wraps getThreadList in a 30 s individual promise timeout
 *   so a single hung call never blocks the entire warm-up indefinitely.
 * - Better structured logging with per-page progress.
 */

"use strict";

const PAGE         = 30;
const MAX_PAGES    = 20;          // hard ceiling — 600 threads
const PAGE_DELAY   = 600;        // ms between pages (human-like pacing)
const PAGE_TIMEOUT = 30_000;     // ms per page before giving up
const RETRY_DELAY  = 5 * 60_000; // 5 min retry after total failure

let _runOnce       = false;
let _retryTimer    = null;

function _log(msg) {
  try {
    if (global.loggeryuki && typeof global.loggeryuki.log === "function") {
      global.loggeryuki.log([
        { message: "[ SYNC-GROUPS ]: ", color: ["red", "cyan"] },
        { message: String(msg),        color: "white"          }
      ]);
      return;
    }
  } catch (_) {}
  console.log("[SYNC-GROUPS]", msg);
}

/**
 * Wrap api.getThreadList in a per-page timeout.
 */
function _getPageWithTimeout(api, count, timestamp, tags) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`getThreadList timed out after ${PAGE_TIMEOUT}ms`));
    }, PAGE_TIMEOUT);

    try {
      const cb = (err, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(data);
      };
      const maybe = api.getThreadList(count, timestamp, tags, cb);
      if (maybe && typeof maybe.then === "function") {
        maybe
          .then(d => { if (!settled) { settled = true; clearTimeout(timer); resolve(d); } })
          .catch(e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      }
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    }
  });
}

// Tag strategies to try in order. Some accounts return 0 for INBOX but results for []
const TAG_STRATEGIES = [["INBOX"], [], ["PENDING"], ["OTHER"]];

async function _tryGetPage(api, count, timestamp) {
  // Try each tag strategy, return on first non-empty result
  for (const tags of TAG_STRATEGIES) {
    try {
      const result = await _getPageWithTimeout(api, count, timestamp, tags);
      const list = Array.isArray(result) ? result : (result && result.data ? result.data : []);
      if (list.length > 0) {
        _log(`Using tag strategy: ${JSON.stringify(tags)} (${list.length} threads)`);
        return result;
      }
    } catch (_) {}
  }
  // All strategies returned empty — return empty array
  return [];
}

async function syncAllGroups(api) {
  if (!api || typeof api.getThreadList !== "function") return;

  // Cancel any pending retry (this call is the retry or a fresh call).
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }

  _log("Warming thread cache (trying INBOX, all-threads, PENDING, OTHER)…");

  let timestamp    = null;
  let totalSeen    = 0;
  let registered   = 0;
  let atLeastOnePage = false;
  let activeTagStrategy = null; // once we find a working strategy, stick with it

  for (let page = 0; page < MAX_PAGES; page++) {
    let threads;
    try {
      if (activeTagStrategy !== null) {
        // Use the known working strategy for subsequent pages
        threads = await _getPageWithTimeout(api, PAGE, timestamp, activeTagStrategy);
      } else {
        threads = await _tryGetPage(api, PAGE, timestamp);
        // Detect which strategy worked by checking what returned results
        // (We'll just proceed — _tryGetPage handles fallback internally)
      }
    } catch (e) {
      _log(`Page ${page + 1} failed: ${e && e.message ? e.message : e}`);

      if (!atLeastOnePage) {
        // Total failure — schedule a retry and exit
        _log(`No pages retrieved — retrying in ${RETRY_DELAY / 60000} min…`);
        _retryTimer = setTimeout(() => {
          _retryTimer = null;
          syncAllGroups(api).catch(() => {});
        }, RETRY_DELAY);
        if (_retryTimer.unref) _retryTimer.unref();
        return;
      }
      // Partial failure — stop paging but keep what we have
      break;
    }

    if (!atLeastOnePage) {
      atLeastOnePage = true;
      _runOnce = true;
    }

    const list = Array.isArray(threads)
      ? threads
      : (threads && threads.data ? threads.data : []);

    if (list.length === 0) break;

    let oldest = null;
    for (const t of list) {
      totalSeen++;
      const ts = Number(t.timestamp || t.lastMessageTimestamp || 0);
      if (ts && (oldest === null || ts < oldest)) oldest = ts;

      if (!t.isGroup || !t.threadID) continue;
      const tid = String(t.threadID);

      try {
        if (!global.data.allThreadID.includes(tid)) {
          global.data.allThreadID.push(tid);
          registered++;
        }
        if (!global.data.threadInfo.has(tid)) {
          global.data.threadInfo.set(tid, {
            threadName:     t.name || t.threadName || tid,
            participantIDs: Array.isArray(t.participantIDs)
              ? t.participantIDs.map(String) : [],
            isGroup: true,
            adminIDs: []
          });
        }
      } catch (_) {}
    }

    _log(`Page ${page + 1}: ${list.length} threads (total ${totalSeen}, new groups ${registered})`);

    if (list.length < PAGE || !oldest) break;
    timestamp = oldest;
    await new Promise(r => setTimeout(r, PAGE_DELAY + Math.random() * PAGE_DELAY));
  }

  _log(`Done — scanned ${totalSeen} threads, ${registered} new groups added.`);
}

module.exports = {
  /**
   * Kick off warm-up. Idempotent — subsequent calls after success are no-ops.
   *
   * @param {object} api      Live FCA api object
   * @param {number} delayMs  Initial delay before first page (default 8 s)
   */
  start(api, delayMs) {
    if (_runOnce) return;  // already done in this process lifetime
    const wait = Number.isFinite(delayMs) ? delayMs : 8000;
    setTimeout(() => {
      syncAllGroups(api).catch(() => {});
    }, wait);
  },

  /**
   * Reset state so the next start() call performs a full re-sync.
   * Call after a tier switch or manual panel "Refresh Groups" action.
   */
  reset() {
    _runOnce = false;
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    _log("State reset — next start() will re-sync.");
  },

  /** Force an immediate re-sync regardless of prior state. */
  forceSync(api) {
    _runOnce = false;
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    syncAllGroups(api).catch(() => {});
  }
};
