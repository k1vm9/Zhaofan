'use strict';
/**
 * حاسبة.js — حاسبة رياضية آمنة
 * مستوحى من أوامر TatsuYTB
 */

module.exports.config = {
  name:            'حاسبة',
  aliases:         ['calc', 'calculate', 'math', 'رياضيات'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team',
  description:     'حاسبة رياضية — تدعم +، -، *، /، ^، sqrt، %',
  commandCategory: 'أدوات',
  usages:          'حاسبة [عملية] — مثال: .حاسبة 2 + 2',
  cooldowns:       3,
};

function safeEval(expr) {
  const cleaned = expr
    .replace(/[^0-9+\-*/.() %^sqrt]/g, '')
    .replace(/\^/g, '**')
    .replace(/sqrt\(([^)]+)\)/g, (_, n) => `Math.sqrt(${n})`);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${cleaned})`)();
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  const expr = args.join(' ');
  if (!expr) return api.sendMessage('🔢 مثال: .حاسبة 25 * 4 + 10', threadID, messageID);

  try {
    const result = safeEval(expr);
    if (typeof result !== 'number' || !isFinite(result)) throw new Error('invalid result');
    return api.sendMessage(
      `🔢 ${expr}\n= ${result.toLocaleString('en-US', { maximumFractionDigits: 10 })}`,
      threadID, messageID
    );
  } catch (e) {
    return api.sendMessage('❌ عملية غير صالحة: ' + expr, threadID, messageID);
  }
};
