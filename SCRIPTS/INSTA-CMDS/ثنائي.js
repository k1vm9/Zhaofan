'use strict';

function encode(text) {
  return Array.from(text).map(ch => {
    const b = ch.charCodeAt(0).toString(2);
    return '0'.repeat(8 - b.length) + b;
  }).join(' ');
}

function decode(binary) {
  return binary.split(' ').map(b => String.fromCharCode(parseInt(b, 2))).join('');
}

module.exports = {
  config: {
    name: 'ثنائي',
    aliases: ['binary', 'bin'],
    description: 'تحويل النص إلى رمز ثنائي والعكس',
    usage: '!ثنائي ترميز [نص] | !ثنائي فك [رمز]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args, event }) => {
    const HELP = '🔢 أمر الثنائي:\n!ثنائي ترميز [نص] — تحويل النص إلى ثنائي\n!ثنائي فك [رمز] — تحويل الثنائي إلى نص';
    if (args.length < 2) return reply(HELP);
    const type  = args[0].trim();
    const input = args.slice(1).join(' ').trim();
    if (!input) return reply('⚠️ أدخل النص أو الرمز.');

    if (type === 'ترميز' || type === 'encode' || type === 'en') {
      return reply(`🔢 الثنائي:\n${encode(input)}`);
    }
    if (type === 'فك' || type === 'decode' || type === 'de') {
      try {
        return reply(`📝 النص:\n${decode(input)}`);
      } catch (_) {
        return reply('❌ رمز ثنائي غير صالح.');
      }
    }
    return reply(HELP);
  },
};
