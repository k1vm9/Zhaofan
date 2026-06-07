'use strict';
module.exports.config = {
  name: 'قصر',
  aliases: ['shorten', 'short', 'url'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'اختصار الروابط الطويلة باستخدام TinyURL',
  commandCategory: 'أدوات',
  usages: 'قصر [رابط]',
  cooldowns: 5,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const url = (args[0] || '').trim();
  if (!url || !/^https?:\/\/.+/.test(url)) {
    return api.sendMessage('⚠️ ضع رابطاً صحيحاً يبدأ بـ http أو https\nمثال: .قصر https://example.com/some/long/link', threadID, messageID);
  }
  try {
    const res  = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const short = (await res.text()).trim();
    if (!short.startsWith('https://tinyurl.com/')) throw new Error('invalid response');
    return api.sendMessage(
      `🔗 اختصار الرابط\n━━━━━━━━━━━━━\n📎 الأصلي:\n${url}\n\n✅ المختصر:\n${short}`,
      threadID, messageID
    );
  } catch (e) {
    return api.sendMessage('❌ فشل الاختصار: ' + e.message, threadID, messageID);
  }
};
