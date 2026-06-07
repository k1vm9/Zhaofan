'use strict';

const axios = require('axios');

module.exports = {
  config: {
    name: 'ترجم',
    aliases: ['translate', 'trans', 'tr'],
    description: 'ترجمة النصوص إلى أي لغة',
    usage: '!ترجم [نص] -> [رمز_اللغة]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    const joined = args.join(' ');
    if (!joined) {
      return reply('📝 الاستخدام:\n!ترجم [نص] -> [لغة]\n!ترجم [نص]  (تترجم للعربية)\n\nأمثلة:\n!ترجم hello\n!ترجم hello -> fr');
    }

    let text, lang = 'ar';
    const arrowIdx = joined.indexOf('->');
    if (arrowIdx !== -1) {
      text = joined.slice(0, arrowIdx).trim();
      lang = joined.slice(arrowIdx + 2).trim() || 'ar';
    } else {
      text = joined.trim();
    }

    if (!text) return reply('⚠️ أدخل النص المراد ترجمته.');

    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
      const res  = await axios.get(url, { timeout: 10000 });
      const translated = res.data?.[0]?.map?.(x => x?.[0]).filter(Boolean).join('') || '';
      const detectedLang = res.data?.[2] || 'auto';
      if (!translated) throw new Error('No translation');
      await reply(`🌐 ترجمة\n━━━━━━━━━━━━━\n📝 الأصل (${detectedLang}): ${text.slice(0, 100)}\n\n✅ ${lang.toUpperCase()}: ${translated}`);
    } catch (e) {
      await reply(`❌ فشلت الترجمة: ${e.message.slice(0, 80)}`);
    }
  },
};
