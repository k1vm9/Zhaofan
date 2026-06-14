/**
 * syncAllGroups.js
 *
 * Idea ported from holo (TypeScript bot.ts → MessengerBot.syncAllGroups()).
 *
 * Right after a successful login, paginate through getThreadList(...,'INBOX')
 * and warm the in-memory caches:
 *   - global.data.allThreadID    — set membership of every group the bot is in
 *   - global.data.threadInfo     — best-effort (name, participantIDs, isGroup, adminIDs)
 *
 * Without this, those caches only fill incrementally as messages arrive
 * (handleCreateDatabase fires per-thread on first message) — so anti-spam
 * limits, NSFW gating, and per-thread settings don't apply on a quiet group
 * until *someone* speaks there.
 *
 * This module never blocks the listener: it runs as a fire-and-forget async
 * task right after `_api` is set. All errors are swallowed and logged so a
 * flaky thread-list endpoint can't take the bot down.
 */

let _runOnce = false;

async function syncAllGroups(api) {
  if (_runOnce) return;          // only the first successful login warms the cache
  if (!api || typeof api.getThreadList !== 'function') return;

  // NOTE: _runOnce is NOT set here — it is set only after the first page is
  // successfully fetched. If the very first getThreadList call fails (network
  // glitch, rate limit, cold login), we reset so the next login attempt retries.
  const log = (msg, tag) => {
    try {
      if (global.loggeryuki && typeof global.loggeryuki.log === 'function') {
        global.loggeryuki.log([
          { message: '[ SYNC-GROUPS ]: ', color: ['red', 'cyan'] },
          { message: String(msg), color: 'white' }
        ]);
      } else {
        console.log(`[SYNC-GROUPS] ${msg}`);
      }
    } catch (_) {}
  };

  log('Warming thread cache from INBOX…');

  let timestamp = null;
  let totalSeen = 0;
  let registered = 0;
  let atLeastOnePage = false;  // tracks whether we successfully fetched ≥1 page
  const PAGE = 30;
  const MAX_PAGES = 20;          // hard ceiling — 600 threads is plenty

  for (let page = 0; page < MAX_PAGES; page++) {
    let threads;
    try {
      threads = await new Promise((resolve, reject) => {
        // FCA-style getThreadList: callback-or-promise, both are supported.
        try {
          const maybe = api.getThreadList(PAGE, timestamp, ['INBOX'], (err, data) => {
            if (err) return reject(err);
            resolve(data);
          });
          if (maybe && typeof maybe.then === 'function') {
            maybe.then(resolve).catch(reject);
          }
        } catch (e) { reject(e); }
      });
    } catch (e) {
      log(`getThreadList failed on page ${page + 1}: ${e && e.message ? e.message : e}`);
      // If we never got even one page, reset _runOnce so the next login attempt retries
      if (!atLeastOnePage) {
        _runOnce = false;
      }
      break;
    }

    // Mark success on first fetched page — from here any future call is a no-op
    if (!atLeastOnePage) {
      atLeastOnePage = true;
      _runOnce = true;
    }

    const list = Array.isArray(threads) ? threads : (threads && threads.data) ? threads.data : [];
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

        // Only fill threadInfo if it isn't already there — listen.js boot loop
        // and handleCreateDatabase populate richer rows from the DB / getThreadInfo,
        // so we don't want to overwrite their work with sparser data.
        if (!global.data.threadInfo.has(tid)) {
          global.data.threadInfo.set(tid, {
            threadName:     t.name || t.threadName || tid,
            participantIDs: Array.isArray(t.participantIDs) ? t.participantIDs.map(String) : [],
            isGroup:        true,
            adminIDs:       []   // unknown from getThreadList; handleRefresh will fill on the next admin event
          });
        }
      } catch (_) {}
    }

    if (list.length < PAGE || !oldest) break;
    timestamp = oldest;
    // Tiny pause between pages so we look like a human scrolling, not a scraper.
    await new Promise(r => setTimeout(r, 600 + Math.random() * 600));
  }

  log(`Done — scanned ${totalSeen} threads, ${registered} new groups added to cache.`);
}

module.exports = {
  /**
   * Kick off the warm-up. Safe to call multiple times — only the first call
   * actually executes (subsequent calls become no-ops).
   *
   * @param {object} api  the live FCA api object returned from login()
   * @param {number=} delayMs  optional initial delay (default 8 s, gives MQTT time to settle)
   */
  start(api, delayMs) {
    const wait = Number.isFinite(delayMs) ? delayMs : 8000;
    setTimeout(() => {
      syncAllGroups(api).catch(() => {});
    }, wait);
  }
};
