'use strict';

const fs   = require('fs');
const path = require('path');

const SLOT_FILE     = path.join(__dirname, '..', '..', 'data', 'insta-slot.json');
const START_BALANCE = 500;
const SYMBOLS       = ['🍎', '🍌', '🍒', '⭐', '7️⃣', '🍇', '🔔'];
const WIN_CHANCE    = 35;

function load() {
  try {
    if (!fs.existsSync(SLOT_FILE)) return {};
    return JSON.parse(fs.readFileSync(SLOT_FILE, 'utf-8').trim() || '{}');
  } catch { return {}; }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(SLOT_FILE), { recursive: true });
    fs.writeFileSync(SLOT_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

function getBal(data, uid) {
  return typeof data[uid]?.balance === 'number' ? data[uid].balance : START_BALANCE;
}

module.exports = {
  config: {
    name: 'slot',
    aliases: ['سلوت', 'قمار'],
    description: 'لعبة السلوت — راهن وحاول حظك',
    usage: '!slot [المبلغ] | !slot balance | !slot top',
    adminOnly: false,
    category: 'ألعاب',
  },
  run: async ({ reply, args, event }) => {
    const uid  = event.senderID;
    const data = load();

    if (args[0] === 'balance' || args[0] === 'رصيد') {
      return reply(`💰 رصيدك: ${getBal(data, uid).toLocaleString()} $`);
    }

    if (args[0] === 'top') {
      const sorted = Object.entries(data)
        .filter(([, v]) => typeof v.balance === 'number')
        .sort(([, a], [, b]) => b.balance - a.balance)
        .slice(0, 10);
      if (!sorted.length) return reply('📊 لا توجد بيانات بعد.');
      let msg = '🏆 أثرى اللاعبين:\n━━━━━━━━━━━━━━━\n';
      sorted.forEach(([id, v], i) => { msg += `${i + 1}. ${id.slice(-6)}: ${v.balance.toLocaleString()} $\n`; });
      return reply(msg.trim());
    }

    const bet = parseInt(args[0]);
    if (!bet || bet <= 0 || isNaN(bet)) {
      return reply('⚠️ الاستخدام: !slot [المبلغ]\nمثال: !slot 100\n\n• !slot balance — رصيدك\n• !slot top — أثرى اللاعبين');
    }

    let balance = getBal(data, uid);
    if (balance < bet) return reply(`❌ رصيدك غير كافٍ! رصيدك: ${balance.toLocaleString()} $`);

    const win = Math.random() * 100 < WIN_CHANCE;
    let s1, s2, s3;

    if (win) {
      const sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      s1 = s2 = s3 = sym;
      balance += bet;
    } else {
      do {
        s1 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
        s2 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
        s3 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      } while (s1 === s2 && s2 === s3);
      balance -= bet;
    }

    if (!data[uid]) data[uid] = {};
    data[uid].balance = balance;
    save(data);

    await reply(
      win
        ? `🎰 لعبة السلوت\n━━━━━━━━━━━━━━━\n\n[ ${s1} | ${s2} | ${s3} ]\n\n🏆 فزت! +${bet.toLocaleString()} $\n💰 الرصيد: ${balance.toLocaleString()} $`
        : `🎰 لعبة السلوت\n━━━━━━━━━━━━━━━\n\n[ ${s1} | ${s2} | ${s3} ]\n\n💸 خسرت! -${bet.toLocaleString()} $\n💰 الرصيد: ${balance.toLocaleString()} $`
    );
  },
};
