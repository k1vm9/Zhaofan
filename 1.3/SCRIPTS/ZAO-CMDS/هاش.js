'use strict';
const crypto = require('crypto');

module.exports.config = {
  name: 'هاش',
  aliases: ['hash', 'encrypt', 'تشفير'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'تشفير النصوص — MD5 / SHA1 / SHA256 / SHA512',
  commandCategory: 'أدوات',
  usages: 'هاش [md5|sha1|sha256|sha512] [نص] — افتراضي: sha256',
  cooldowns: 3,
};
module.exports.languages = { vi: {}, en: {} };

const ALGOS = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha512: 'sha512' };

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  if (!args.length) return api.sendMessage('⚠️ مثال: .هاش sha256 كلمة_المرور', threadID, messageID);
  let algo = 'sha256';
  let text;
  if (ALGOS[args[0]?.toLowerCase()]) {
    algo = args[0].toLowerCase();
    text = args.slice(1).join(' ');
  } else {
    text = args.join(' ');
  }
  if (!text) return api.sendMessage('⚠️ ضع النص المراد تشفيره.', threadID, messageID);
  const hash = crypto.createHash(algo).update(text, 'utf8').digest('hex');
  return api.sendMessage(
    `🔐 تشفير النص\n━━━━━━━━━━━━━\n📝 النص: ${text.length > 60 ? text.slice(0, 60) + '…' : text}\n🔑 الخوارزمية: ${algo.toUpperCase()}\n\n${hash}`,
    threadID, messageID
  );
};
