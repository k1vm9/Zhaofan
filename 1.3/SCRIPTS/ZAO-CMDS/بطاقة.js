'use strict';
// Blackjack — يقترب من 21 دون تجاوزه

const SUITS  = ['♠️','♥️','♦️','♣️'];
const RANKS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const VALUES = { A: 11, J: 10, Q: 10, K: 10 };

function cardVal(rank)  { return VALUES[rank] ?? parseInt(rank); }
function deckVal(hand)  {
  let total = hand.reduce((s, c) => s + cardVal(c.rank), 0);
  let aces  = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function drawCard(deck)  { return deck.splice(Math.floor(Math.random() * deck.length), 1)[0]; }
function makeDeck() {
  return SUITS.flatMap(s => RANKS.map(r => ({ suit: s, rank: r })));
}
function showHand(hand)  { return hand.map(c => `${c.suit}${c.rank}`).join(' '); }

module.exports.config = {
  name: 'بطاقة',
  aliases: ['blackjack', 'bj', 'بلاك_جاك'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'لعبة بلاك جاك — اقترب من 21 دون تجاوزه',
  commandCategory: 'ألعاب',
  usages: 'بطاقة',
  cooldowns: 5,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const deck    = makeDeck().sort(() => Math.random() - 0.5);
  const player  = [drawCard(deck), drawCard(deck)];
  const dealer  = [drawCard(deck), drawCard(deck)];
  const pVal    = deckVal(player);

  if (pVal === 21) {
    return api.sendMessage(
      `🃏 بلاك جاك!\n━━━━━━━━━━━━━\nورقك: ${showHand(player)} (${pVal})\n🏆 بلاك جاك! فزت فوراً!`,
      threadID, messageID
    );
  }

  return api.sendMessage(
    `🃏 بلاك جاك\n━━━━━━━━━━━━━\nورقك: ${showHand(player)} (${pVal})\nورق الديلر: ${dealer[0].suit}${dealer[0].rank} 🂠\n━━━━━━━━━━━━━\n↩️ رد بـ هيت (ورقة جديدة) أو وقف (انهِ)`,
    threadID,
    (err, info) => {
      if (err || !info) return;
      global.client.handleReply.push({
        name: 'بطاقة', messageID: info.messageID, author: senderID,
        player, dealer, deck,
      });
    },
    messageID
  );
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;
  const cmd = String(body || '').trim().toLowerCase();
  const { player, dealer, deck } = handleReply;

  if (cmd === 'هيت' || cmd === 'hit' || cmd === 'ورقة') {
    player.push(drawCard(deck));
    const pVal = deckVal(player);
    if (pVal > 21) {
      return api.sendMessage(
        `🃏 ورقك: ${showHand(player)} (${pVal})\n💥 تجاوزت 21! خسرت.`,
        threadID, messageID
      );
    }
    if (pVal === 21) {
      // auto-stand
      while (deckVal(dealer) < 17) dealer.push(drawCard(deck));
      const dVal = deckVal(dealer);
      const res  = pVal > dVal || dVal > 21 ? '🏆 فزت!' : pVal === dVal ? '🤝 تعادل!' : '😢 خسرت!';
      return api.sendMessage(
        `🃏 ورقك: ${showHand(player)} (${pVal})\nالديلر: ${showHand(dealer)} (${dVal})\n━━━━━━━━━━━━━\n${res}`,
        threadID, messageID
      );
    }
    global.client.handleReply.push({ ...handleReply, messageID, player, deck });
    return api.sendMessage(
      `🃏 ورقك: ${showHand(player)} (${pVal})\n↩️ هيت أو وقف`,
      threadID, messageID
    );
  }

  if (cmd === 'وقف' || cmd === 'stand' || cmd === 'stay') {
    while (deckVal(dealer) < 17) dealer.push(drawCard(deck));
    const pVal = deckVal(player);
    const dVal = deckVal(dealer);
    const res  = dVal > 21 ? '🏆 الديلر تجاوز 21! فزت!' :
                 pVal > dVal ? '🏆 فزت!' :
                 pVal === dVal ? '🤝 تعادل!' : '😢 خسرت!';
    return api.sendMessage(
      `🃏 بلاك جاك — النتيجة\n━━━━━━━━━━━━━\nورقك: ${showHand(player)} (${pVal})\nالديلر: ${showHand(dealer)} (${dVal})\n━━━━━━━━━━━━━\n${res}`,
      threadID, messageID
    );
  }

  global.client.handleReply.push({ ...handleReply, messageID });
  return api.sendMessage('↩️ رد بـ هيت (ورقة جديدة) أو وقف (انهِ)', threadID, messageID);
};
