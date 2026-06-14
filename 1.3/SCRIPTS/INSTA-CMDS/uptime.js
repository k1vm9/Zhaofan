'use strict';

const os = require('os');

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = {
  config: {
    name: 'uptime',
    aliases: ['ابتيم', 'سيرفر', 'server'],
    description: 'معلومات السيرفر وحالة النظام',
    usage: '!uptime',
    adminOnly: false,
    category: 'النظام',
  },
  run: async ({ reply }) => {
    const mem    = process.memoryUsage();
    const cpus   = os.cpus();
    const totRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const useRam = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1);
    const heap   = Math.round(mem.heapUsed / 1024 / 1024);
    const rss    = Math.round(mem.rss / 1024 / 1024);
    const ramPct = Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 100);
    const cpuModel = (cpus[0]?.model || 'Unknown').replace(/\s+@.*$/, '').slice(0, 30);

    await reply(
      `🖥️ معلومات السيرفر\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏱️  Node.js Uptime : ${fmtUptime(Math.floor(process.uptime()))}\n` +
      `🖥️  OS Uptime      : ${fmtUptime(Math.floor(os.uptime()))}\n` +
      `\n💻 المعالج:\n` +
      `   ${cpuModel} (${cpus.length} نواة)\n` +
      `\n💾 الذاكرة:\n` +
      `   RAM  : ${useRam}/${totRam} GB (${ramPct}%)\n` +
      `   Heap : ${heap}MB  |  RSS: ${rss}MB\n` +
      `\n📦 Node.js  : ${process.version}\n` +
      `🐧 Platform : ${os.platform()} ${os.arch()}`
    );
  },
};
