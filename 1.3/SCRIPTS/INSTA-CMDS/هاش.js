'use strict';

const crypto = require('crypto');

const ALGOS = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha512: 'sha512' };

module.exports = {
  config: {
    name: 'هاش',
    aliases: ['hash', 'encrypt', 'تشفير'],
    description: 'تشفير النصوص — MD5 / SHA1 / SHA256 / SHA512',
    usage: '!هاش [md5|sha1|sha256|sha512] [نص]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    if (!args.length) return reply('⚠️ مثال: !هاش sha256 كلمة_المرور');
    let algo = 'sha256', text;
    if (ALGOS[args[0]?.toLowerCase()]) {
      algo = args[0].toLowerCase();
      text = args.slice(1).join(' ');
    } else {
      text = args.join(' ');
    }
    if (!text) return reply('⚠️ ضع النص المراد تشفيره.');
    const hash = crypto.createHash(algo).update(text, 'utf8').digest('hex');
    await reply(
      `🔐 تشفير النص\n━━━━━━━━━━━━━\n` +
      `📝 النص: ${text.length > 60 ? text.slice(0, 60) + '…' : text}\n` +
      `🔑 الخوارزمية: ${algo.toUpperCase()}\n\n${hash}`
    );
  },
};
