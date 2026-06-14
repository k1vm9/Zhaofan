'use strict';
/**
 * حقيقة.js — حقيقة عشوائية
 * مُقتبس من TatsuYTB/lib/modules/commands/fact.js
 * يستخدم api.popcat.xyz ويترجم النتيجة للعربية تلقائياً.
 */

module.exports.config = {
  name:            'حقيقة',
  aliases:         ['fact', 'facts', 'معلومة'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team (from TatsuYTB/fact.js)',
  description:     'اعرض حقيقة علمية عشوائية',
  commandCategory: 'ترفيه',
  usages:          'حقيقة',
  cooldowns:       10,
};

const axios = require('axios');

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  try {
    const factRes  = await axios.get('https://api.popcat.xyz/fact', { timeout: 10000 });
    const factEn   = factRes.data?.fact;
    if (!factEn) throw new Error('no fact returned');

    const transRes = await axios.get(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(factEn)}`,
      { timeout: 8000 }
    );
    let translated = '';
    const td = transRes.data;
    if (Array.isArray(td[0])) td[0].forEach(item => { if (item[0]) translated += item[0]; });

    return api.sendMessage(
      `💡 هل تعلم؟\n\n${translated || factEn}`,
      threadID, messageID
    );
  } catch (e) {
    return api.sendMessage('❌ تعذّر جلب الحقيقة: ' + e.message, threadID, messageID);
  }
};
