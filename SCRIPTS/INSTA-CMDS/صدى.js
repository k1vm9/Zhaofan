'use strict';

module.exports = {
  config: {
    name: 'صدى',
    aliases: ['echo', 'كرر', 'repeat'],
    description: 'كرر الرسالة التي ترسلها',
    usage: '!صدى [نص]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    const text = args.join(' ').trim();
    if (!text) return reply('⚠️ مثال: !صدى مرحبا');
    await reply(text);
  },
};
