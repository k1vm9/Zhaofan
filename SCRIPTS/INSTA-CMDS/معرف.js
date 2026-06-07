'use strict';

module.exports = {
  config: {
    name: 'معرف',
    aliases: ['uid', 'id', 'thread'],
    description: 'عرض معرف الخيط والمرسل',
    usage: '!معرف',
    adminOnly: false,
    category: 'معلومات',
  },
  run: async ({ reply, event, currentUser }) => {
    await reply(
      `🆔 المعرفات\n` +
      `━━━━━━━━━━━━━\n` +
      `💬 Thread ID : ${event.threadID}\n` +
      `👤 Sender ID : ${event.senderID}\n` +
      `🤖 Bot ID    : ${currentUser?.pk || '—'}\n` +
      `👥 مجموعة   : ${event.isGroup ? 'نعم' : 'لا'}`
    );
  },
};
