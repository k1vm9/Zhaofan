'use strict';

const FACES = ['⚀','⚁','⚂','⚃','⚄','⚅'];

function roll(n) {
  const r = [];
  for (let i = 0; i < n; i++) r.push(Math.floor(Math.random() * 6) + 1);
  return r;
}

module.exports = {
  config: {
    name: 'نرد',
    aliases: ['dice', 'roll', 'دايس'],
    description: 'رمي النرد — رمي 1-3 حبات نرد',
    usage: '!نرد [عدد 1-3]',
    adminOnly: false,
    category: 'ألعاب',
  },
  run: async ({ reply, args }) => {
    const count = Math.min(3, Math.max(1, parseInt(args[0]) || 1));
    const rolls = roll(count);
    const total = rolls.reduce((s, v) => s + v, 0);
    const faces = rolls.map(v => FACES[v - 1]).join('  ');
    const vals  = rolls.join(' + ');
    await reply(
      `🎲 النرد\n━━━━━━━━━━━━━\n${faces}\n${count > 1 ? `${vals} = ` : ''}${total}`
    );
  },
};
