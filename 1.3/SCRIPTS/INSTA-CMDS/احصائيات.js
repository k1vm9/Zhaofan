'use strict';

module.exports = {
  config: {
    name: 'احصائيات',
    aliases: ['stats', 'sysinfo'],
    description: 'إحصائيات شاملة لبوت إنستاغرام',
    usage: '!احصائيات',
    adminOnly: false,
    category: 'معلومات',
  },
  run: async ({ reply, stats, commands, currentUser, settings, loginMethod }) => {
    const uptimeSec = Math.floor((Date.now() - stats.startedAt) / 1000);
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = d ? `${d}ي ${h}س ${m}د` : h ? `${h}س ${m}د` : m ? `${m}د ${s}ث` : `${s}ث`;

    const mem     = process.memoryUsage();
    const heapMB  = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTot = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB   = Math.round(mem.rss / 1024 / 1024);
    const heapPct = Math.round(mem.heapUsed / mem.heapTotal * 100);

    const uniqueCmds = new Set([...commands.values()].map(m => m.config.name)).size;

    await reply(
      `📊 إحصائيات ZAO-INSTA\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 الحساب     : @${currentUser?.username || '—'}\n` +
      `🔑 طريقة الدخول: ${loginMethod || '—'}\n` +
      `⏱️  مدة التشغيل : ${uptimeStr}\n` +
      `\n📈 الاستخدام:\n` +
      `   📨 رسائل معالجة : ${stats.totalMessages}\n` +
      `   ⚡ أوامر نُفِّذت : ${stats.totalCommands}\n` +
      `   📦 أوامر محملة  : ${uniqueCmds}\n` +
      `\n💾 الذاكرة:\n` +
      `   Heap: ${heapMB}/${heapTot}MB (${heapPct}%)\n` +
      `   RSS : ${rssMB}MB\n` +
      `\n⚙️  الإعدادات:\n` +
      `   🔤 البادئة : ${settings.prefix || '!'}\n` +
      `   👥 المجموعات: ${settings.replyInGroups ? '✅' : '❌'}\n` +
      `   💬 DMs      : ${settings.replyInDMs ? '✅' : '❌'}\n` +
      `   ⌨️  الكتابة  : ${settings.typing ? '✅' : '❌'}\n` +
      `\n⚙️  Node.js: ${process.version}`
    );
  },
};
