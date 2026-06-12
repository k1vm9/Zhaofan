'use strict';
const crypto = require('crypto');

const UPPER  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER  = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMS   = '!@#$%^&*-_=+?';

module.exports.config = {
  name: 'كلمة_سر',
  aliases: ['password', 'passgen', 'جيل_كلمة'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'توليد كلمة مرور قوية عشوائية',
  commandCategory: 'أدوات',
  usages: 'كلمة_سر [الطول 8-64] [رموز:نعم|لا] — مثال: .كلمة_سر 16',
  cooldowns: 3,
};
module.exports.languages = { vi: {}, en: {} };

function generate(length, includeSyms) {
  const pool = UPPER + LOWER + DIGITS + (includeSyms ? SYMS : '');
  const bytes = crypto.randomBytes(length * 2);
  let pass = '';
  for (let i = 0; i < length; i++) {
    pass += pool[bytes[i] % pool.length];
  }
  // Ensure at least one of each required type
  const required = [
    UPPER[bytes[length]   % UPPER.length],
    LOWER[bytes[length+1] % LOWER.length],
    DIGITS[bytes[length+2] % DIGITS.length],
    ...(includeSyms ? [SYMS[bytes[length+3] % SYMS.length]] : []),
  ];
  const arr = [...pass];
  required.forEach((ch, i) => { arr[i] = ch; });
  return arr.sort(() => (crypto.randomBytes(1)[0] % 2) - 0.5).join('');
}

function strength(pass) {
  let score = 0;
  if (pass.length >= 12) score++;
  if (pass.length >= 16) score++;
  if (/[A-Z]/.test(pass)) score++;
  if (/[a-z]/.test(pass)) score++;
  if (/[0-9]/.test(pass)) score++;
  if (/[^A-Za-z0-9]/.test(pass)) score++;
  return score >= 5 ? '🟢 قوية جداً' : score >= 3 ? '🟡 متوسطة' : '🔴 ضعيفة';
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const length = Math.min(64, Math.max(8, parseInt(args[0]) || 16));
  const syms   = args[1] !== 'لا' && args[1] !== 'no';
  const pass   = generate(length, syms);
  return api.sendMessage(
    `🔐 كلمة المرور الجديدة\n━━━━━━━━━━━━━\n${pass}\n\n📏 الطول: ${length}\n${strength(pass)}\n⚠️ لا تشارك هذه الرسالة مع أحد`,
    threadID, messageID
  );
};
