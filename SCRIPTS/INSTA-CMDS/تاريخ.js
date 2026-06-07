'use strict';

function parseDate(str) {
  const parts = str.split(/[\/\-\.]/);
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y || d > 31 || m > 12) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

function diffDesc(ms) {
  const abs    = Math.abs(ms);
  const days   = Math.floor(abs / 86400000);
  const weeks  = Math.floor(days / 7);
  const months = Math.floor(days / 30.44);
  const years  = Math.floor(days / 365.25);
  const parts  = [];
  if (years > 0)       parts.push(`${years} سنة`);
  if (months % 12 > 0) parts.push(`${months % 12} شهر`);
  if (weeks % 4 > 0)   parts.push(`${weeks % 4} أسبوع`);
  const rd = days % 7;
  if (rd > 0)          parts.push(`${rd} يوم`);
  return { days, weeks, months, years, summary: parts.join(' و') || 'نفس اليوم' };
}

module.exports = {
  config: {
    name: 'تاريخ',
    aliases: ['date', 'datediff'],
    description: 'احسب الفرق بين تاريخين',
    usage: '!تاريخ [DD/MM/YYYY] [DD/MM/YYYY]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    if (!args[0]) return reply('⚠️ مثال: !تاريخ 01/01/2000\nأو: !تاريخ 01/01/2000 31/12/2025');
    const d1 = parseDate(args[0]);
    if (!d1) return reply('❌ تاريخ غير صالح. الصيغة: DD/MM/YYYY');
    const d2 = args[1] ? parseDate(args[1]) : new Date();
    if (!d2) return reply('❌ التاريخ الثاني غير صالح.');
    const diff  = diffDesc(d2 - d1);
    const label = args[1] ? `${args[0]} → ${args[1]}` : `${args[0]} → اليوم`;
    await reply(
      `📅 الفرق بين التواريخ\n━━━━━━━━━━━━━\n📆 ${label}\n\n` +
      `${diff.days.toLocaleString()} يوم\n` +
      `${diff.weeks.toLocaleString()} أسبوع\n` +
      `${diff.months.toLocaleString()} شهر\n` +
      `${diff.years.toLocaleString()} سنة\n\n` +
      `🕐 ${diff.summary} ${d2 >= d1 ? 'مضت' : 'متبقية'}`
    );
  },
};
