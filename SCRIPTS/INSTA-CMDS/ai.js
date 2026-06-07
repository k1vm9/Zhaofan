'use strict';

const axios = require('axios');

const OPENROUTER_MODELS = [
  'x-ai/grok-4.3',
  'openai/gpt-4o-mini-transcribe',
  'deepseek/deepseek-v3.2',
  'openai/gpt-oss-120b:free',
  'google/gemma-4-26b-a4b-it:free',
  'baidu/cobuddy:free',
];

let _bestModelIdx = 0;

function callOpenRouter(prompt, apiKey) {
  return new Promise(async (resolve, reject) => {
    let lastErr = null;
    for (let i = _bestModelIdx; i < OPENROUTER_MODELS.length; i++) {
      try {
        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: OPENROUTER_MODELS[i],
            messages: [
              { role: 'system', content: 'أنت مساعد ذكي اسمه ZAO-INSTA. أجب باختصار وبوضوح باللغة العربية أو لغة المستخدم.' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 500,
            temperature: 0.7,
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://zao-bot.local',
              'X-Title': 'ZAO-INSTA',
            },
            timeout: 20000,
          }
        );
        const text = res.data?.choices?.[0]?.message?.content;
        if (text && text.trim()) {
          _bestModelIdx = i;
          return resolve(text.trim());
        }
        lastErr = new Error('Empty response');
      } catch (e) {
        lastErr = e;
      }
    }
    _bestModelIdx = 0;
    reject(lastErr || new Error('All models failed'));
  });
}

function callPollinations(prompt) {
  return axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`, { timeout: 15000 })
    .then(r => { if (r.data && String(r.data).trim()) return String(r.data).trim(); throw new Error('Empty'); });
}

module.exports = {
  config: {
    name: 'ai',
    aliases: ['زاو', 'بوت', 'gpt', 'chat'],
    description: 'دردشة مع الذكاء الاصطناعي',
    usage: '!ai <سؤالك هنا>',
    adminOnly: false,
    category: 'ذكاء اصطناعي',
  },
  run: async ({ reply, args, settings }) => {
    if (!args.length) return reply('❌ مثال: !ai ما هو الذكاء الاصطناعي؟');

    const prompt = args.join(' ');
    const apiKey = settings.openrouterKey || process.env.OPENROUTER_API_KEY || '';

    try {
      const answer = apiKey
        ? await callOpenRouter(prompt, apiKey)
        : await callPollinations(prompt);
      await reply(`🤖 ${answer}`);
    } catch (e) {
      await reply(`❌ فشل الذكاء الاصطناعي: ${e.message.slice(0, 100)}`);
    }
  },
};
