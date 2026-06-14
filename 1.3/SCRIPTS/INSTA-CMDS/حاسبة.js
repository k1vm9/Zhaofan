'use strict';

function safeEval(expr) {
  const cleaned = expr
    .replace(/[^0-9+\-*/.() %^sqrt]/g, '')
    .replace(/\^/g, '**')
    .replace(/sqrt\(([^)]+)\)/g, (_, n) => `Math.sqrt(${n})`);
  return Function('"use strict"; return (' + cleaned + ')')();
}

module.exports = {
  config: {
    name: 'حاسبة',
    aliases: ['calc', 'calculate', 'math', 'رياضيات'],
    description: 'حاسبة رياضية — تدعم +، -، *، /، ^، sqrt',
    usage: '!حاسبة [عملية]',
    adminOnly: false,
    category: 'أدوات',
  },
  run: async ({ reply, args }) => {
    const expr = args.join(' ');
    if (!expr) return reply('🔢 مثال: !حاسبة 25 * 4 + 10');
    try {
      const result = safeEval(expr);
      if (typeof result !== 'number' || !isFinite(result)) throw new Error('invalid');
      await reply(`🔢 ${expr}\n= ${result.toLocaleString('en-US', { maximumFractionDigits: 10 })}`);
    } catch (_) {
      await reply(`❌ عملية غير صالحة: ${expr}`);
    }
  },
};
