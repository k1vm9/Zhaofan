'use strict';
/**
 * ترجم.js — ترجمة النصوص
 * مُقتبس من TatsuYTB/lib/modules/commands/dich.js
 *
 * الاستخدام:
 *   .ترجم [نص] -> [لغة]   — ترجمة النص إلى اللغة المحددة
 *   .ترجم [نص]             — ترجمة إلى العربية
 *   (رد على رسالة) .ترجم  — ترجمة الرسالة المُردّ عليها
 */

module.exports.config = {
  name:            'ترجم',
  aliases:         ['translate', 'trans', 'dich', 'tr'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team (from TatsuYTB/dich.js)',
  description:     'ترجمة النصوص إلى أي لغة',
  commandCategory: 'أدوات',
  usages:          'ترجم [نص] -> [رمز_اللغة] | مثال: .ترجم hello -> ar',
  cooldowns:       5,
};

const axios = require('axios');

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  let text = '';
  let lang = 'ar';

  if (event.type === 'message_reply') {
    text = event.messageReply?.body || '';
    const joined = args.join(' ');
    const arrowIdx = joined.indexOf('->');
    if (arrowIdx !== -1) {
      lang = joined.slice(arrowIdx + 2).trim() || 'ar';
    }
  } else {
    const joined = args.join(' ');
    const arrowIdx = joined.indexOf('->');
    if (arrowIdx !== -1) {
      text = joined.slice(0, arrowIdx).trim();
      lang = joined.slice(arrowIdx + 2).trim() || 'ar';
    } else {
      text = joined.trim();
      lang = 'ar';
    }
  }

  if (!text) {
    return api.sendMessage(
      '📝 الاستخدام:\n.ترجم [نص] -> [لغة]\n.ترجم [نص]  (تترجم للعربية)\nأو رُدّ على رسالة بـ .ترجم',
      threadID, messageID
    );
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res  = await axios.get(url, { timeout: 10000 });
    const data = res.data;
    let translated = '';
    if (Array.isArray(data[0])) {
      data[0].forEach(item => { if (item[0]) translated += item[0]; });
    }
    if (!translated) throw new Error('empty response');
    const from = data[2] || 'auto';
    return api.sendMessage(
      `🌍 ترجمة (${from} → ${lang}):\n\n${translated}`,
      threadID, messageID
    );
  } catch (e) {
    return api.sendMessage('❌ فشلت الترجمة: ' + e.message, threadID, messageID);
  }
};
