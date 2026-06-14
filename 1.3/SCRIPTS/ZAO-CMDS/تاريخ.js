'use strict';
module.exports.config = {
  name: 'تاريخ',
  aliases: ['date', 'datediff', 'فرق_تاريخ'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'احسب الفرق بين تاريخين أو الوقت المتبقي لحدث',
  commandCategory: 'أدوات',
  usages: 'تاريخ [DD/MM/YYYY] [DD/MM/YYYY] — أو تاريخ [DD/MM/YYYY] للوقت من الآن',
  cooldowns: 3,
};
module.exports.languages = { vi: {}, en: {} };

function parseDate(str) {
  const parts = str.split(/[\/\-\.]/);
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y || d > 31 || m > 12) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

function diffDesc(ms) {
  const abs   = Math.abs(ms);
  const secs  = Math.floor(abs / 1000);
  const mins  = Math.floor(secs / 60);
  const hrs   = Math.floor(mins / 60);
  const days  = Math.floor(abs / 86400000);
  const weeks = Math.floor(days / 7);
  const months= Math.floor(days / 30.44);
  const years = Math.floor(days / 365.25);
  const lines = [];
  if (years > 0)  lines.push(`${years} سنة`);
  if (months % 12 > 0) lines.push(`${months % 12} شهر`);
  if (weeks % 4 > 0)   lines.push(`${weeks % 4} أسبوع`);
  const remDays = days % 7;
  if (remDays > 0)     lines.push(`${remDays} يوم`);
  return { days, weeks, months, years, summary: lines.join(' و') || 'نفس اليوم' };
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  if (!args[0]) return api.sendMessage('⚠️ مثال: .تاريخ 01/01/2000\nأو: .تاريخ 01/01/2000 31/12/2025', threadID, messageID);
  const d1 = parseDate(args[0]);
  if (!d1) return api.sendMessage('❌ تاريخ غير صالح. الصيغة: DD/MM/YYYY', threadID, messageID);
  const d2 = args[1] ? parseDate(args[1]) : new Date();
  if (!d2) return api.sendMessage('❌ التاريخ الثاني غير صالح.', threadID, messageID);
  const diff = diffDesc(d2 - d1);
  const past = d2 >= d1;
  const label = args[1]
    ? `${args[0]} → ${args[1]}`
    : `${args[0]} → اليوم`;
  return api.sendMessage(
    `📅 الفرق بين التواريخ\n━━━━━━━━━━━━━\n📆 ${label}\n\n${diff.days.toLocaleString()} يوم\n${diff.weeks.toLocaleString()} أسبوع\n${diff.months.toLocaleString()} شهر\n${diff.years.toLocaleString()} سنة\n\n🕐 ${diff.summary} ${past ? 'مضت' : 'متبقية'}`,
    threadID, messageID
  );
};
