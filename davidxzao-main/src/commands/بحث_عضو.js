'use strict';
/**
 * بحث_عضو.js — البحث عن مستخدم في المجموعات
 * مُقتبس من TatsuYTB/lib/modules/commands/finduser.js
 */

module.exports.config = {
  name:            'بحث_عضو',
  aliases:         ['finduser', 'بحث_مستخدم', 'ابحث'],
  version:         '1.0.0',
  hasPermssion:    1,
  credits:         'ZAO Team (from TatsuYTB/finduser.js)',
  description:     'ابحث عن مستخدم (uid أو اسم) في جميع المجموعات التي فيها البوت',
  commandCategory: 'أدوات',
  usages:          'بحث_عضو [uid أو اسم]',
  cooldowns:       15,
};

module.exports.run = async function ({ api, event, args, Users }) {
  const { threadID, messageID } = event;

  if (!args.length) {
    return api.sendMessage('⚠️ أدخل uid أو اسماً.\nمثال: .بحث_عضو 100000434205615\nأو: .بحث_عضو أحمد', threadID, messageID);
  }

  const query = args.join(' ').toLowerCase();
  const isUID = /^\d+$/.test(query);

  api.setMessageReaction('⏳', messageID, () => {}, true);

  try {
    const results = {};
    // [FIX] Use global._botApi if available to avoid stale handles after tier switch
    const liveApi = global._botApi || api;
    const allThreads = await liveApi.getThreadList(50, null, ['INBOX']);

    for (const t of allThreads) {
      let info;
      try { info = await liveApi.getThreadInfo(t.threadID); } catch (_) { continue; }
      const members = info.participantIDs || [];

      for (const memberID of members) {
        try {
          let name = '';
          try {
            const udata = await Users.getData(memberID);
            name = udata?.name || '';
          } catch (_) {}

          const matchUID  = isUID && memberID === query;
          const matchName = !isUID && name.toLowerCase().includes(query);

          if (matchUID || matchName) {
            if (!results[memberID]) {
              results[memberID] = { name: name || memberID, threads: [] };
            }
            results[memberID].threads.push(info.threadName || t.threadID);
          }
        } catch (_) {}
      }
    }

    if (!Object.keys(results).length) {
      api.setMessageReaction('📭', messageID, () => {}, true);
      return api.sendMessage(`❎ لم يُعثر على "${query}" في المجموعات.`, threadID, messageID);
    }

    const lines = Object.entries(results).map(([uid, data]) =>
      `• ${data.name} (${uid})\n  في: ${data.threads.slice(0, 3).join('، ')}${data.threads.length > 3 ? ' ...' : ''}`
    );

    api.setMessageReaction('✅', messageID, () => {}, true);
    return api.sendMessage(
      `🔎 نتائج البحث عن "${query}" (${Object.keys(results).length}):\n\n${lines.join('\n\n')}`,
      threadID, messageID
    );
  } catch (e) {
    api.setMessageReaction('❌', messageID, () => {}, true);
    return api.sendMessage('❌ خطأ أثناء البحث: ' + e.message, threadID, messageID);
  }
};
