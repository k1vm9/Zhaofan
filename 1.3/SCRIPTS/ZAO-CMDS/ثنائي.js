'use strict';
/**
 * ثنائي.js — تحويل النص إلى ثنائي والعكس
 * مُقتبس من TatsuYTB/lib/modules/commands/binary.js
 */

module.exports.config = {
  name:            'ثنائي',
  aliases:         ['binary', 'bin'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team (from TatsuYTB/binary.js)',
  description:     'تحويل النص إلى رمز ثنائي والعكس',
  commandCategory: 'أدوات',
  usages:          'ثنائي ترميز [نص] | ثنائي فك [رمز]',
  cooldowns:       3,
};

function encode(text) {
  return Array.from(text)
    .map(ch => {
      const b = ch.charCodeAt(0).toString(2);
      return '0'.repeat(8 - b.length) + b;
    })
    .join(' ');
}

function decode(binary) {
  return binary.split(' ')
    .map(b => String.fromCharCode(parseInt(b, 2)))
    .join('');
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  const HELP = `🔢 أمر الثنائي:\n.ثنائي ترميز [نص] — تحويل النص إلى ثنائي\n.ثنائي فك [رمز] — تحويل الثنائي إلى نص`;

  if (args.length < 2) return api.sendMessage(HELP, threadID, messageID);

  const type  = (args[0] || '').trim();
  const input = event.body.slice(event.body.indexOf(args[1])).trim();

  if (!input) return api.sendMessage('⚠️ أدخل النص أو الرمز.', threadID, messageID);

  if (type === 'ترميز' || type === 'encode' || type === 'en') {
    return api.sendMessage(`🔢 الثنائي:\n${encode(input)}`, threadID, messageID);
  }

  if (type === 'فك' || type === 'decode' || type === 'de') {
    try {
      const result = decode(input);
      return api.sendMessage(`📝 النص:\n${result}`, threadID, messageID);
    } catch (e) {
      return api.sendMessage('❌ رمز ثنائي غير صالح.', threadID, messageID);
    }
  }

  return api.sendMessage(HELP, threadID, messageID);
};
