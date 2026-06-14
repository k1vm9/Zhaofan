'use strict';

module.exports = {
  config: {
    name: 'ping',
    aliases: ['وضع', 'status', 'حالة', 'pong'],
    description: 'فحص سرعة استجابة البوت وصحة النظام',
    usage: '!ping',
    adminOnly: false,
    category: 'معلومات',
  },
  run: async ({ reply, stats, loginMethod }) => {
    const t0 = Date.now();
    const uptimeSec = Math.floor((Date.now() - stats.startedAt) / 1000);
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = d ? `${d}ي ${h}س ${m}د` : h ? `${h}س ${m}د` : m ? `${m}د ${s}ث` : `${s}ث`;
    const mem     = process.memoryUsage();
    const heapMB  = Math.round(mem.heapUsed / 1024 / 1024);
    const rtt     = Date.now() - t0;
    const rttIcon = rtt < 300 ? '🟢' : rtt < 700 ? '🟡' : '🔴';
    await reply(
      `🏓 ZAO-INSTA — فحص الصحة\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `${rttIcon} الاستجابة  : ${rtt}ms\n` +
      `⏱️  مدة التشغيل: ${uptimeStr}\n` +
      `💾 الذاكرة    : ${heapMB}MB\n` +
      `📨 الرسائل    : ${stats.totalMessages}\n` +
      `⚡ الأوامر    : ${stats.totalCommands}\n` +
      `🔑 طريقة الدخول: ${loginMethod || '—'}\n` +
      `⚙️  Node.js    : ${process.version}`
    );
  },
};
