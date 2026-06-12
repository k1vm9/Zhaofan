'use strict';
/**
 * عملة.js — سعر العملات الرقمية (Binance API)
 * مُقتبس من TatsuYTB/lib/modules/commands/crypto.js (نسخة مبسّطة)
 */

module.exports.config = {
  name:            'عملة',
  aliases:         ['crypto', 'coin', 'btc', 'eth', 'عملات_رقمية'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team (from TatsuYTB/crypto.js)',
  description:     'اعرض سعر أي عملة رقمية لحظياً من Binance',
  commandCategory: 'أدوات',
  usages:          'عملة [رمز_العملة] — مثال: .عملة BTCUSDT',
  cooldowns:       8,
};

const axios = require('axios');

function numberFmt(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return n;
  if (num >= 1) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num.toFixed(8);
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  if (!args[0]) {
    return api.sendMessage(
      '💰 مثال: .عملة BTCUSDT\nأو: .عملة ETHUSDT\nأو: .عملة SOLUSDT',
      threadID, messageID
    );
  }

  const symbol = args[0].toUpperCase();

  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`,
      { timeout: 10000 }
    );
    const d = res.data;
    if (!d || d.code) {
      return api.sendMessage(
        `❌ لم يُعثر على العملة "${symbol}".\nجرّب مثلاً: BTCUSDT، ETHUSDT، SOLUSDT`,
        threadID, messageID
      );
    }
    const changeSign = parseFloat(d.priceChangePercent) >= 0 ? '📈 +' : '📉 ';
    const msg = [
      `💰 ${symbol}`,
      ``,
      `💵 السعر الحالي: $${numberFmt(d.lastPrice)}`,
      `${changeSign}${parseFloat(d.priceChangePercent).toFixed(2)}% (24 ساعة)`,
      `📊 أعلى 24 ساعة: $${numberFmt(d.highPrice)}`,
      `📊 أدنى 24 ساعة: $${numberFmt(d.lowPrice)}`,
      `📦 الحجم: ${numberFmt(d.volume)}`,
    ].join('\n');
    return api.sendMessage(msg, threadID, messageID);
  } catch (e) {
    return api.sendMessage(`❌ تعذّر جلب سعر "${symbol}": ` + e.message, threadID, messageID);
  }
};
