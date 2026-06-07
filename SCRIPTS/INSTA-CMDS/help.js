'use strict';

module.exports = {
  config: {
    name: 'help',
    aliases: ['اوامر', 'أوامر', 'cmds', 'h'],
    description: 'عرض قائمة الأوامر المتاحة',
    usage: '!help [اسم الأمر]',
    adminOnly: false,
    category: 'معلومات',
  },
  run: async ({ reply, args, commands, settings }) => {
    const prefix = settings.prefix || '!';

    if (args[0]) {
      const name = args[0].toLowerCase();
      const cmd  = commands.get(name);
      if (!cmd) return reply(`❌ الأمر "${args[0]}" غير موجود.`);
      const c = cmd.config;
      const aliasLine = c.aliases?.length ? `\n🔗 الأسماء البديلة: ${c.aliases.join(', ')}` : '';
      return reply(
        `📌 ${c.name}\n` +
        `📄 ${c.description || '—'}\n` +
        `🔧 الاستخدام: ${c.usage || prefix + c.name}` +
        aliasLine +
        `\n${c.adminOnly ? '🔒 للمشرفين فقط' : '🌐 متاح للجميع'}`
      );
    }

    // Group by category
    const cats = new Map();
    const seen = new Set();
    for (const mod of commands.values()) {
      const cname = mod.config.name;
      if (seen.has(cname)) continue;
      seen.add(cname);
      const cat = mod.config.category || 'عام';
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat).push(`${prefix}${cname}`);
    }

    const sections = [];
    for (const [cat, cmds] of cats) {
      sections.push(`📂 ${cat}:\n${cmds.join('  ')}`);
    }

    await reply(
      `╔══════════════════════════╗\n` +
      `║   ZAO-INSTA — الأوامر   ║\n` +
      `╚══════════════════════════╝\n\n` +
      sections.join('\n\n') +
      `\n\n📊 الإجمالي: ${seen.size} أمر\n` +
      `💡 تفاصيل أمر: ${prefix}help [اسم]`
    );
  },
};
