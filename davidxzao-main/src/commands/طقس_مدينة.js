'use strict';
/**
 * طقس_مدينة.js — الطقس بدون API key (wttr.in)
 * مستوحى من أوامر TatsuYTB
 */

module.exports.config = {
  name:            'طقس_مدينة',
  aliases:         ['weather', 'طقس', 'جو'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team',
  description:     'اعرض الطقس الحالي لأي مدينة (بدون API key)',
  commandCategory: 'أدوات',
  usages:          'طقس_مدينة [المدينة] — مثال: .طقس_مدينة الجزائر',
  cooldowns:       10,
};

const axios = require('axios');

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  if (!args.length) {
    return api.sendMessage('☁️ مثال: .طقس_مدينة الجزائر\nأو: .طقس_مدينة Cairo', threadID, messageID);
  }

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
    const msg  = [
      `🌍 الطقس في ${area}:`,
      ``,
      `🌡️ الحرارة: ${d.temp_C}°م (تشعر بـ ${d.FeelsLikeC}°م)`,
      `💧 الرطوبة: ${d.humidity}%`,
      `💨 الريح: ${d.windspeedKmph} كم/س`,
      `👁️ الرؤية: ${d.visibility} كم`,
      `🌤️ الحالة: ${desc}`,
    ].join('\n');

    return api.sendMessage(msg, threadID, messageID);
  } catch (e) {
    return api.sendMessage(`❌ تعذّر جلب طقس "${city}": ` + e.message, threadID, messageID);
  }
};
