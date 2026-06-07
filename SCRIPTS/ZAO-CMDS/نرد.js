'use strict';
const DICE_FACES = ['⚀','⚁','⚂','⚃','⚄','⚅'];

module.exports.config = {
  name: 'نرد',
  aliases: ['dice', 'roll', 'دايس'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'رمي النرد — رمي 1-3 حبات نرد أو تحدّ شخصاً',
  commandCategory: 'ألعاب',
  usages: 'نرد [عدد 1-3] | نرد @شخص',
  cooldowns: 3,
};
module.exports.languages = { vi: {}, en: {} };

function rollDice(count) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(Math.floor(Math.random() * 6) + 1);
  return results;
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID, mentions } = event;

  // Challenge mode: .نرد @شخص
  const opponentID = Object.keys(mentions || {})[0];
  if (opponentID) {
    if (opponentID === senderID) return api.sendMessage('⚠️ لا تقدر تتحدى نفسك!', threadID, messageID);
    const myRolls  = rollDice(1);
    const oppRolls = rollDice(1);
    const myVal    = myRolls[0];
    const oppVal   = oppRolls[0];
    let result;
    if      (myVal > oppVal)  result = '🏆 أنت فزت!';
    else if (myVal < oppVal)  result = '😢 خصمك فاز!';
    else                       result = '🤝 تعادل!';
    return api.sendMessage(
      `🎲 تحدي النرد\n━━━━━━━━━━━━━\nأنت: ${DICE_FACES[myVal-1]} (${myVal})\nالخصم: ${DICE_FACES[oppVal-1]} (${oppVal})\n━━━━━━━━━━━━━\n${result}`,
      threadID, messageID
    );
  }

  // Solo roll: .نرد [عدد]
  const count = Math.min(3, Math.max(1, parseInt(args[0]) || 1));
  const rolls = rollDice(count);
  const total = rolls.reduce((s, v) => s + v, 0);
  const faces = rolls.map(v => DICE_FACES[v - 1]).join('  ');
  const vals  = rolls.join(' + ');
  return api.sendMessage(
    `🎲 النرد\n━━━━━━━━━━━━━\n${faces}\n${count > 1 ? `${vals} = ` : ''}${total}`,
    threadID, messageID
  );
};
