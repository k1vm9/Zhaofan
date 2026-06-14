'use strict';
/**
 * pinmsg.js — ZAO Bot Command
 * =============================
 * Pin or unpin a message in a group chat.
 * Reply to the message you want to pin/unpin.
 *
 * Usage:
 *   .تثبيت       → pin the replied-to message
 *   .تثبيت إلغاء → unpin the replied-to message
 *   .pinmsg      → pin the replied-to message
 *   .pinmsg off  → unpin
 */

module.exports.config = {
  name:            'تثبيت',
  aliases:         ['pinmsg', 'pin-msg', 'تثبيت-رسالة'],
  version:         '1.0.0',
  hasPermssion:    1,
  credits:         'ZAO Team',
  description:     'تثبيت أو إلغاء تثبيت رسالة في المجموعة',
  commandCategory: 'إدارة المجموعة',
  usages:          'تثبيت [إلغاء] — ردّ على الرسالة المراد تثبيتها',
  cooldowns:       5,
};

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID, messageReply } = event;

  if (!messageReply) {
    return api.sendMessage(
      '📌 ردّ على الرسالة التي تريد تثبيتها.\n' +
      'مثال: ردّ برسالة ثم اكتب: .تثبيت\n' +
      'لإلغاء التثبيت: .تثبيت إلغاء',
      threadID, messageID
    );
  }

  if (!api.pinMessage) {
    return api.sendMessage('❌ واجهة تثبيت الرسائل غير متاحة حالياً.', threadID, messageID);
  }

  const sub = (args[0] || '').toLowerCase();
  const action = (sub === 'إلغاء' || sub === 'off' || sub === 'unpin') ? 'unpin' : 'pin';
  const targetMsgID = messageReply.messageID;

  try {
    api.setMessageReaction('⏳', messageID, () => {}, true);
    await api.pinMessage(action, String(threadID), String(targetMsgID));
    api.setMessageReaction('✅', messageID, () => {}, true);
    const label = action === 'pin' ? 'تم تثبيت الرسالة ✅' : 'تم إلغاء تثبيت الرسالة ✅';
    return api.sendMessage(label, threadID, messageID);
  } catch (e) {
    api.setMessageReaction('❌', messageID, () => {}, true);
    const reason = e.message || String(e);
    return api.sendMessage('❌ فشل تثبيت الرسالة: ' + reason.slice(0, 200), threadID, messageID);
  }
};
