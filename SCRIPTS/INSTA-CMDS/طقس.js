'use strict';

const axios = require('axios');

module.exports = {
  config: {
    name: 'طقس',
    aliases: ['weather', 'طقس_مدينة', 'جو'],
    description: 'اعرض الطقس الحالي لأي مدينة',
    usage: '!طقس [المدينة]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    if (!args.length) return reply('☁️ مثال: !طقس الجزائر\nأو: !طقس Cairo');
    const city = args.join(' ');
    try {
      const res  = await axios.get(
        `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ar`,
        { timeout: 12000 }
      );
      const d    = res.data?.current_condition?.[0];
      const area = res.data?.nearest_area?.[0]?.areaName?.[0]?.value || city;
      if (!d) throw new Error('no data');
      const desc = d.lang_ar?.[0]?.value || d.weatherDesc?.[0]?.value || '';
      await reply([
        `🌍 الطقس في ${area}:`,
        ``,
        `🌡️ الحرارة: ${d.temp_C}°م (تشعر بـ ${d.FeelsLikeC}°م)`,
        `💧 الرطوبة: ${d.humidity}%`,
        `💨 الريح: ${d.windspeedKmph} كم/س`,
        `👁️ الرؤية: ${d.visibility} كم`,
        `🌤️ الحالة: ${desc}`,
      ].join('\n'));
    } catch (e) {
      await reply(`❌ فشل جلب الطقس: ${e.message.slice(0, 80)}`);
    }
  },
};
