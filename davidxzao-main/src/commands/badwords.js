'use strict';

/**
 * Bad Words Filter — ZAO Protection Layer
 * =========================================
 * Allows group admins to maintain a per-group blocked word list.
 * When a member sends a message containing a banned word:
 *   1st violation → warning
 *   2nd violation → kicked from group
 *
 * Usage:
 *   /badwords add <word1,word2>  — add words
 *   /badwords del <word1,word2>  — remove words
 *   /badwords list               — show list
 *   /badwords on | off           — enable/disable
 *   /badwords unwarn @mention    — clear a user's warning
 */

function hideWord(str) {
  if (!str || str.length < 2) return str;
  if (str.length === 2) return str[0] + '*';
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}

function _isGroupAdmin(event) {
  const admins = (global.config?.ADMINBOT || []).map(String);
  return admins.includes(String(event.senderID));
}

function _live(api) {
  return global._botApi || api;
}

module.exports = {
  config: {
    name: 'badwords',
    aliases: ['badword', 'bw'],
    version: '2.0',
    hasPermssion: 1,
    cooldowns: 3,
    commandCategory: 'إدارة المجموعة',
    shortDescription: 'Bad words filter — warn then kick',
    longDescription: 'Maintains a per-thread blocked word list. Members who violate are warned first, then kicked on second offense.',
    category: 'protection',
    guide: {
      en: [
        '{pn} add <word1,word2>  — add blocked words',
        '{pn} del <word1,word2>  — remove blocked words',
        '{pn} list               — show blocked word list',
        '{pn} on | off           — enable/disable filter',
        '{pn} unwarn @mention    — clear a user\'s warning'
      ].join('\n')
    }
  },

  // ── Command handler ──────────────────────────────────────────────────────
  onStart: async function ({ api, event, args, Threads, message }) {
    const { threadID, senderID } = event;
    const liveApi = _live(api);
    const isAdmin = _isGroupAdmin(event);

    let tData;
    try { tData = await Threads.getData(threadID); } catch (_) { tData = { data: {} }; }
    const stored = tData?.data?.badWords || { words: [], violations: {}, enabled: false };

    const sub = (args[0] || '').toLowerCase();

    if (sub === 'add') {
      if (!isAdmin) return liveApi.sendMessage('⚠️ Only bot admins can add blocked words.', threadID);
      const rawWords = args.slice(1).join(' ').split(/[,|]/).map(w => w.trim().toLowerCase()).filter(w => w.length >= 2);
      if (!rawWords.length) return api.sendMessage('⚠️ No valid words provided (min 2 characters each).', threadID);
      const added = [], dup = [];
      for (const w of rawWords) {
        if (stored.words.includes(w)) { dup.push(w); } else { stored.words.push(w); added.push(w); }
      }
      await _saveBadWords(Threads, threadID, tData, stored);
      let msg = '';
      if (added.length) msg += `✅ Added ${added.length} word(s): ${added.map(hideWord).join(', ')}`;
      if (dup.length) msg += `\n❌ Already in list: ${dup.map(hideWord).join(', ')}`;
      return liveApi.sendMessage(msg || '⚠️ No changes made.', threadID);
    }

    if (sub === 'del' || sub === 'delete' || sub === 'remove') {
      if (!isAdmin) return liveApi.sendMessage('⚠️ Only bot admins can remove blocked words.', threadID);
      const rawWords = args.slice(1).join(' ').split(/[,|]/).map(w => w.trim().toLowerCase()).filter(Boolean);
      if (!rawWords.length) return liveApi.sendMessage('⚠️ No words provided.', threadID);
      const removed = [], missing = [];
      for (const w of rawWords) {
        const idx = stored.words.indexOf(w);
        if (idx > -1) { stored.words.splice(idx, 1); removed.push(w); } else { missing.push(w); }
      }
      await _saveBadWords(Threads, threadID, tData, stored);
      let msg = '';
      if (removed.length) msg += `✅ Removed ${removed.length} word(s)`;
      if (missing.length) msg += `\n❌ Not found: ${missing.join(', ')}`;
      return liveApi.sendMessage(msg || 'No changes.', threadID);
    }

    if (sub === 'list' || sub === 'all') {
      if (!stored.words.length) return liveApi.sendMessage('📑 Blocked words list is empty.', threadID);
      const show = args[1] === 'show'
        ? stored.words.join(', ')
        : stored.words.map(hideWord).join(', ');
      return liveApi.sendMessage(`📑 Blocked words (${stored.words.length}):\n${show}`, threadID);
    }

    if (sub === 'on') {
      if (!isAdmin) return liveApi.sendMessage('⚠️ Only bot admins can enable this feature.', threadID);
      stored.enabled = true;
      await _saveBadWords(Threads, threadID, tData, stored);
      return liveApi.sendMessage('✅ Bad words filter enabled.', threadID);
    }

    if (sub === 'off') {
      if (!isAdmin) return liveApi.sendMessage('⚠️ Only bot admins can disable this feature.', threadID);
      stored.enabled = false;
      await _saveBadWords(Threads, threadID, tData, stored);
      return liveApi.sendMessage('🔓 Bad words filter disabled.', threadID);
    }

    if (sub === 'unwarn') {
      if (!isAdmin) return liveApi.sendMessage('⚠️ Only bot admins can clear warnings.', threadID);
      let targetID = Object.keys(event.mentions || {})[0]
        || args[1]
        || event.messageReply?.senderID;
      if (!targetID || isNaN(targetID)) return liveApi.sendMessage('⚠️ Tag a user or provide their ID.', threadID);
      targetID = String(targetID);
      if (!stored.violations[targetID]) return liveApi.sendMessage(`⚠️ User ${targetID} has no recorded violations.`, threadID);
      delete stored.violations[targetID];
      await _saveBadWords(Threads, threadID, tData, stored);
      return liveApi.sendMessage(`✅ Cleared violation record for user ${targetID}.`, threadID);
    }

    // Help
    return liveApi.sendMessage(
      '⚙️ Bad Words Filter\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '/badwords add <w1,w2>  — add words\n' +
      '/badwords del <w1,w2>  — remove words\n' +
      '/badwords list         — show list\n' +
      '/badwords on | off     — enable/disable\n' +
      '/badwords unwarn @tag  — clear warning\n\n' +
      `Status: ${stored.enabled ? '✅ Enabled' : '🔓 Disabled'} | Words: ${stored.words.length}`,
      threadID
    );
  },

  // ── Passive message scanner ──────────────────────────────────────────────
  handleEvent: async function ({ api, event, Threads }) {
    try {
      // Only act on real text messages — skip log events, reactions, etc.
      if (event.type !== 'message' && event.type !== 'message_reply') return;
      if (!event.body || !event.threadID || !event.isGroup) return;
      const { threadID, senderID, body } = event;
      const liveApi = _live(api);

      const admins = (global.config?.ADMINBOT || []).map(String);
      if (admins.includes(String(senderID))) return;

      let tData;
      try { tData = await Threads.getData(threadID); } catch (_) { return; }
      const stored = tData?.data?.badWords;
      if (!stored || !stored.enabled || !stored.words?.length) return;

      const bodyLow = body.toLowerCase();
      const found = stored.words.find(w => new RegExp(`\\b${w}\\b`, 'i').test(bodyLow));
      if (!found) return;

      const violations = stored.violations || {};
      const count = (violations[senderID] || 0) + 1;
      violations[senderID] = count;

      if (count === 1) {
        liveApi.sendMessage(
          `⚠️ @${senderID}\nYour message contained a blocked word ("${hideWord(found)}").\nFinal warning — a second violation will result in removal.`,
          threadID
        ).catch(() => {});
        await _saveBadWords(Threads, threadID, tData, { ...stored, violations }).catch(() => {});
      } else {
        violations[senderID] = 0;
        liveApi.removeUserFromGroup(senderID, threadID, (err) => {
          if (!err) {
            liveApi.sendMessage(
              `🚫 [BAD WORDS] User ${senderID} was removed after 2 violations.`,
              threadID
            ).catch(() => {});
          }
        });
        await _saveBadWords(Threads, threadID, tData, { ...stored, violations }).catch(() => {});
      }
    } catch (_) {}
  }
};

async function _saveBadWords(Threads, threadID, tData, stored) {
  const data = { ...(tData?.data || {}), badWords: stored };
  await Threads.setData(threadID, data);
}
