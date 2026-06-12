const pendingThreadRequests = new Set();
const threadRequestCooldown = new Map();
const THREAD_COOLDOWN_MS = 30000;

// [FIX] Periodic prune of the cooldown map. Without this, every brand-new
// thread the bot ever sees gets a permanent entry. Over weeks of operation
// in a busy bot pool this can grow to tens of thousands of stale entries.
// Entries older than 5× the cooldown window are guaranteed irrelevant.
const _COOLDOWN_PRUNE_INTERVAL_MS = 10 * 60 * 1000;   // every 10 min
const _COOLDOWN_STALE_AGE_MS      = THREAD_COOLDOWN_MS * 5;
let _cooldownPruneTimer = null;
function _ensureCooldownPruner() {
  if (_cooldownPruneTimer) return;
  _cooldownPruneTimer = setInterval(() => {
    try {
      const cutoff = Date.now() - _COOLDOWN_STALE_AGE_MS;
      for (const [tid, ts] of threadRequestCooldown.entries()) {
        if (ts < cutoff) threadRequestCooldown.delete(tid);
      }
    } catch (_) {}
  }, _COOLDOWN_PRUNE_INTERVAL_MS);
  if (typeof _cooldownPruneTimer.unref === 'function') _cooldownPruneTimer.unref();
}

module.exports = function ({ Users, Threads, Currencies }) {
  const logger = require("../../utils/log.js");
  _ensureCooldownPruner();
  return async function ({ event }) {
    const { allUserID, allCurrenciesID, allThreadID, userName, threadInfo } = global.data;
    const { autoCreateDB } = global.config;
    if (autoCreateDB == false) return;
    var { senderID, threadID } = event;
    senderID = String(senderID);
    threadID = String(threadID);
    try {
      if (!allThreadID.includes(threadID) && event.isGroup == true) {
        const now = Date.now();
        const lastRequest = threadRequestCooldown.get(threadID) || 0;
        if (pendingThreadRequests.has(threadID) || (now - lastRequest < THREAD_COOLDOWN_MS)) return;

        pendingThreadRequests.add(threadID);
        threadRequestCooldown.set(threadID, now);
        allThreadID.push(threadID);

        try {
          const threadIn4 = await Threads.getInfo(threadID);
          // [FIX Djamel] — guard against null/empty getInfo response.
          // Several FB API failures (rate limits, permission errors, fresh
          // groups) return undefined or {} here, and the original code then
          // crashed on threadIn4.threadName / threadIn4.userInfo, killing
          // the whole handler chain for the message.
          if (!threadIn4 || typeof threadIn4 !== "object") {
            throw new Error("Threads.getInfo returned no data");
          }
          const setting = {};
          setting.threadName = threadIn4.threadName || "";
          setting.adminIDs   = Array.isArray(threadIn4.adminIDs)  ? threadIn4.adminIDs  : [];
          setting.nicknames  = threadIn4.nicknames || {};
          const dataThread = setting;
          threadInfo.set(threadID, dataThread);
          const setting2 = {};
          setting2.threadInfo = dataThread;
          setting2.data = {};
          await Threads.setData(threadID, setting2);
          const userInfoList = Array.isArray(threadIn4.userInfo) ? threadIn4.userInfo : [];
          for (const singleData of userInfoList) {
            userName.set(String(singleData.id), singleData.name);
            try {
              if (global.data.allUserID.includes(String(singleData.id))) {
                await Users.setData(String(singleData.id), { name: singleData.name });
              } else {
                await Users.createData(singleData.id, { name: singleData.name, data: {} });
                global.data.allUserID.push(String(singleData.id));
                logger(global.getText('handleCreateDatabase', 'newUser', singleData.id), '[ DATABASE ]');
              }
            } catch (e) { console.log(e); }
          }
          logger(global.getText('handleCreateDatabase', 'newThread', threadID), '[ DATABASE ]');
        } catch (err) {
          const _idx = allThreadID.indexOf(threadID);
          if (_idx !== -1) allThreadID.splice(_idx, 1);
          threadRequestCooldown.delete(threadID);
          console.log('[DB] خطأ في جلب معلومات المجموعة:', err.message || err);
        } finally {
          pendingThreadRequests.delete(threadID);
        }
      }

      if (!allUserID.includes(senderID)) {
        // Genuinely new user: push to cache FIRST so concurrent messages don't
        // trigger another createData before the first one completes.
        allUserID.push(senderID);
        try {
          const infoUsers = await Users.getInfo(senderID);
          // [FIX Djamel] — Users.getInfo can return null/undefined or an
          // object missing `.name` on transient FB API failures (rate limit,
          // permission). Previously `infoUsers.name` then threw and the catch
          // silently swallowed it, leaving senderID permanently shadow-cached
          // in allUserID with NO matching DB row — every later message would
          // skip the create branch, fall through to the `!userName.has`
          // branch, and `setData` would silently no-op forever (user has no
          // currency row, no name, profile commands return blank, etc.).
          // Fall back to a placeholder name so the row is always created;
          // a later message will refresh the real name via the
          // `!userName.has(senderID)` branch below.
          const realName = (infoUsers && typeof infoUsers.name === 'string' && infoUsers.name)
            ? infoUsers.name
            : `User_${senderID}`;
          await Users.createData(senderID, { name: realName, data: {} });
          userName.set(senderID, realName);
          logger(global.getText('handleCreateDatabase', 'newUser', senderID), '[ DATABASE ]');
        } catch (e) {
          // [FIX Djamel] — if createData itself failed (DB issue, unique
          // conflict from a concurrent insert) we MUST roll the cache push
          // back, otherwise the user stays shadow-cached forever.
          const _idx = allUserID.indexOf(senderID);
          if (_idx !== -1) allUserID.splice(_idx, 1);
        }
      } else if (!userName.has(senderID)) {
        // User exists in DB but name is absent from the in-memory cache
        // (e.g. partial startup load). Fetch and cache the name only —
        // calling createData here would hit a unique-constraint failure every
        // single message and silently loop forever.
        try {
          const infoUsers = await Users.getInfo(senderID);
          // Guard: getInfo can return null/undefined on rate limits or FB
          // permission errors. Without this check, infoUsers.name throws
          // a TypeError that is silently swallowed by the catch block,
          // leaving the user permanently without a resolved name.
          if (!infoUsers || typeof infoUsers.name !== 'string' || !infoUsers.name) return;
          userName.set(senderID, infoUsers.name);
          await Users.setData(senderID, { name: infoUsers.name });
        } catch (e) {}
      }

      if (!allCurrenciesID.includes(senderID)) {
        try {
          const setting4 = {};
          setting4.data = {};
          await Currencies.createData(senderID, setting4);
          allCurrenciesID.push(senderID);
        } catch (e) {}
      }
      return;
    } catch (err) {
      return console.log(err);
    }
  };
};
