'use strict';

module.exports = {
  config: {
    name: 'info',
    description: 'يعرض معلومات الخيط الحالي والمرسل',
    usage: '!info',
    adminOnly: false,
  },
  run: async ({ ig, event, reply, currentUser }) => {
    try {
      const { threadID, senderID, isGroup, threadName } = event;

      let senderInfo = '—';
      try {
        const user = await ig.user.info(senderID);
        senderInfo =
          `@${user.username}` +
          (user.full_name ? ` (${user.full_name})` : '') +
          (user.follower_count != null ? ` | 👥 ${user.follower_count} متابع` : '');
      } catch (_) {}

      await reply(
        `ℹ️ معلومات الخيط:\n\n` +
        `🆔 Thread ID: ${threadID}\n` +
        `${isGroup ? `👥 مجموعة: ${threadName || '—'}` : `💬 محادثة خاصة`}\n` +
        `👤 المرسل (${senderID}):\n   ${senderInfo}\n` +
        `🤖 البوت: @${currentUser?.username || '—'}`
      );
    } catch (e) {
      await reply(`❌ خطأ في جلب المعلومات: ${e.message}`);
    }
  },
};
