/**
 * handleRefresh.js  v2
 *
 * Ported & cleaned from seikobot/includes/handle/handleRefresh.js.
 *
 * Keeps the in-memory `threadInfo` cache (and the persisted Threads row)
 * in sync with Facebook's `log:*` system events:
 *   - log:thread-admins   (add_admin / remove_admin)
 *   - log:thread-name     (group renamed)
 *   - log:thread-image    (NEW) cover photo changed — refresh thread image URL
 *   - log:thread-icon     (NEW) group emoji changed — refresh threadEmoji field
 *   - log:subscribe       (members added — incl. bot itself → re-bootstrap data)
 *   - log:unsubscribe     (member or bot removed → drop user / drop thread row)
 *
 * Without this, the cache only ever gets initialised once (in listen.js
 * boot loop and handleCreateDatabase on first message), so admin lists,
 * group names, cover photos, and member arrays slowly drift from reality.
 *
 * The handler is wired from listen.js inside the `case "event"` branch,
 * alongside the existing `storedEvent` dispatcher.
 */

module.exports = function ({ api, Threads }) {
  const logger = require('../../utils/log.js');

  return async function ({ event }) {
    if (!event || !event.logMessageType) return;

    const { threadID, logMessageType, logMessageData } = event;
    if (!threadID) return;

    let dataThread;
    try {
      const row = await Threads.getData(threadID);
      dataThread = (row && row.threadInfo) ? row.threadInfo : null;
    } catch (_) {
      dataThread = null;
    }

    try {
      switch (logMessageType) {

        // ── Admin added / removed ─────────────────────────────
        case 'log:thread-admins': {
          if (!dataThread) return;
          if (!Array.isArray(dataThread.adminIDs)) dataThread.adminIDs = [];

          const targetID = logMessageData && logMessageData.TARGET_ID;
          const action   = logMessageData && logMessageData.ADMIN_EVENT;
          if (!targetID || !action) return;

          if (action === 'add_admin') {
            if (!dataThread.adminIDs.find(a => String(a.id) === String(targetID))) {
              dataThread.adminIDs.push({ id: String(targetID) });
            }
          } else if (action === 'remove_admin') {
            dataThread.adminIDs = dataThread.adminIDs.filter(a => String(a.id) !== String(targetID));
          }

          await Threads.setData(threadID, { threadInfo: dataThread });
          try { global.data.threadInfo.set(String(threadID), dataThread); } catch (_) {}
          logger(`Refreshed admin list for thread ${threadID} (${action} ${targetID})`, 'REFRESH');
          break;
        }

        // ── Group renamed ─────────────────────────────────────
        case 'log:thread-name': {
          if (!dataThread) return;
          const newName = (logMessageData && logMessageData.name) || event.snippet || '';
          dataThread.threadName = newName;
          await Threads.setData(threadID, { threadInfo: dataThread });
          try { global.data.threadInfo.set(String(threadID), dataThread); } catch (_) {}
          logger(`Refreshed name for thread ${threadID} → "${newName}"`, 'REFRESH');
          break;
        }

        // ── Group cover photo changed ─────────────────────────
        // log:thread-image fires when any member (or admin) changes the
        // group's profile picture.  The new image URL is provided in
        // logMessageData.url (or occasionally event.snippet).  Without
        // this case, threadInfo.imageSrc stays as the URL from the
        // original bootstrap and links rot after Facebook's CDN expires them.
        case 'log:thread-image': {
          if (!dataThread) return;
          const newUrl = (logMessageData && (logMessageData.url || logMessageData.image_url))
            || event.snippet || '';
          if (!newUrl) return;
          dataThread.imageSrc = newUrl;
          await Threads.setData(threadID, { threadInfo: dataThread });
          try { global.data.threadInfo.set(String(threadID), dataThread); } catch (_) {}
          logger(`Refreshed cover image for thread ${threadID}`, 'REFRESH');
          break;
        }

        // ── Group emoji (thread icon) changed ─────────────────
        // log:thread-icon fires when any member changes the group emoji.
        // The new emoji character is in logMessageData.thread_icon.
        case 'log:thread-icon': {
          if (!dataThread) return;
          const newIcon = logMessageData && (logMessageData.thread_icon || logMessageData.emoji);
          if (!newIcon) return;
          dataThread.emoji = newIcon;
          await Threads.setData(threadID, { threadInfo: dataThread });
          try { global.data.threadInfo.set(String(threadID), dataThread); } catch (_) {}
          logger(`Refreshed thread icon for ${threadID} → ${newIcon}`, 'REFRESH');
          break;
        }

        // ── Members added (or bot itself added) ───────────────
        case 'log:subscribe': {
          const added = (logMessageData && Array.isArray(logMessageData.addedParticipants))
            ? logMessageData.addedParticipants : [];
          if (added.length === 0) return;

          const botID = (() => {
            try { return String(api.getCurrentUserID()); }
            catch (_) { return String(global.botUserID || ''); }
          })();

          // If the bot was just added → defer to handleCreateDatabase
          // (Allow MQTT a couple of seconds to settle so getThreadInfo works.)
          if (added.some(p => String(p.userFbId) === botID)) {
            logger(`Bot was added to thread ${threadID} — bootstrap will run on first message.`, 'REFRESH');
            return;
          }

          if (!dataThread) return;
          if (!Array.isArray(dataThread.participantIDs)) dataThread.participantIDs = [];

          let changed = 0;
          for (const p of added) {
            const id = String(p.userFbId || p.id || '');
            if (id && !dataThread.participantIDs.includes(id)) {
              dataThread.participantIDs.push(id);
              changed++;
            }
          }
          if (changed > 0) {
            await Threads.setData(threadID, { threadInfo: dataThread });
            try { global.data.threadInfo.set(String(threadID), dataThread); } catch (_) {}
            logger(`Refreshed members for thread ${threadID} (+${changed})`, 'REFRESH');
          }
          break;
        }

        // ── Member left (or bot itself removed) ───────────────
        case 'log:unsubscribe': {
          const leftID = String(
            (logMessageData && (logMessageData.leftParticipantFbId || logMessageData.leftParticipantId)) || ''
          );
          if (!leftID) return;

          const botID = (() => {
            try { return String(api.getCurrentUserID()); }
            catch (_) { return String(global.botUserID || ''); }
          })();

          // Bot itself was removed → drop the entire row + global cache
          if (leftID === botID) {
            try {
              const idx = global.data.allThreadID.indexOf(String(threadID));
              if (idx !== -1) global.data.allThreadID.splice(idx, 1);
              global.data.threadInfo.delete(String(threadID));
              global.data.threadData.delete(String(threadID));
            } catch (_) {}
            try { await Threads.delData(threadID); } catch (_) {}
            logger(`Bot was removed from thread ${threadID} — data cleared.`, 'REFRESH');
            return;
          }

          if (!dataThread) return;
          if (Array.isArray(dataThread.participantIDs)) {
            dataThread.participantIDs = dataThread.participantIDs.filter(id => String(id) !== leftID);
          }
          if (Array.isArray(dataThread.adminIDs)) {
            dataThread.adminIDs = dataThread.adminIDs.filter(a => String(a.id) !== leftID);
          }
          await Threads.setData(threadID, { threadInfo: dataThread });
          try { global.data.threadInfo.set(String(threadID), dataThread); } catch (_) {}
          logger(`Refreshed members for thread ${threadID} (-${leftID})`, 'REFRESH');
          break;
        }

        default:
          return;
      }
    } catch (e) {
      try { logger(`handleRefresh error on ${logMessageType}: ${e && e.message ? e.message : e}`, 'WARN'); }
      catch (_) {}
    }
  };
};
