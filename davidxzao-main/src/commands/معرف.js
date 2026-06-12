'use strict';
/**
 * معرف.js — عرض معرّف المحادثة أو المستخدم
 * مُقتبس من TatsuYTB/lib/modules/commands/idbox.js
 */

module.exports.config = {
  name:            'معرف',
  aliases:         ['id', 'uid', 'idbox', 'tid'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team (from TatsuYTB/idbox.js)',
  description:     'اعرض معرّف المحادثة الحالية أو معرّف أي مستخدم',
  commandCategory: 'أدوات',
  usages:          'معرف | معرف مني | معرف @mention',
  cooldowns:       3,
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID, mentions } = event;

  if (args[0] === 'مني' || args[0] === 'me' || args[0] === 'أنا') {
    return api.sendMessage(
      `🪪 معرّفك:\n${senderID}`,
      threadID, messageID
    );
  }

  if (mentions && Object.keys(mentions).length > 0) {
    const lines = Object.keys(mentions).map(uid => `${mentions[uid]}: ${uid}`);
    return api.sendMessage(
      `🪪 معرّفات المذكورين:\n${lines.join('\n')}`,
      threadID, messageID
    );
  }

  if (event.type === 'message_reply') {
    const repliedID = event.messageReply?.senderID;
    return api.sendMessage(
      `🪪 معرّف المُردّ عليه:\n${repliedID || 'غير معروف'}`,
      threadID, messageID
    );
  }

  return api.sendMessage(
    `📌 معلومات المحادثة:\n\n📋 معرّف المحادثة: ${threadID}\n🪪 معرّفك: ${senderID}`,
    threadID, messageID
  );
};
