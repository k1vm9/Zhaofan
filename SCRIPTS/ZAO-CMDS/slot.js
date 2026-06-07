const fs = require("fs-extra");
const path = require("path");

const SLOT_FILE = path.join(__dirname, "../../data/slot.json");
const STARTING_BALANCE = 500;
const SYMBOLS = ["🍎", "🍌", "🍒", "⭐", "7️⃣", "🍇", "🔔"];
const WIN_CHANCE = 35;

function loadData() {
  try {
    if (!fs.existsSync(SLOT_FILE)) return {};
    const raw = fs.readFileSync(SLOT_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveData(data) {
  try {
    fs.ensureDirSync(path.dirname(SLOT_FILE));
    fs.writeFileSync(SLOT_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) { console.error("[slot.js:save]", e.message); }
}

function getBalance(data, uid) {
  return typeof data[uid]?.balance === "number" ? data[uid].balance : STARTING_BALANCE;
}

function setBalance(data, uid, balance) {
  if (!data[uid]) data[uid] = {};
  data[uid].balance = balance;
}

module.exports.config = {
  name: "slot",
  aliases: ["سلوت", "قمار"],
  version: "1.0.0",
  hasPermssion: 0,
  credits: "White → ZAO (MOHAMMAD AKASH/adapted)",
  description: "لعبة السلوت — راهن وحاول حظك!",
  commandCategory: "ألعاب",
  usages: "slot [المبلغ] — slot balance — slot top",
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const data = loadData();

  if (args[0] === "balance" || args[0] === "رصيد") {
    const bal = getBalance(data, senderID);
    return api.sendMessage(`💰 رصيدك الحالي: ${bal.toLocaleString()} $`, threadID, messageID);
  }

  if (args[0] === "top") {
    const sorted = Object.entries(data)
      .filter(([, v]) => typeof v.balance === "number")
      .sort(([, a], [, b]) => b.balance - a.balance)
      .slice(0, 10);
    if (!sorted.length) return api.sendMessage("📊 لا توجد بيانات بعد.", threadID, messageID);
    let msg = "🏆 أثرى اللاعبين:\n━━━━━━━━━━━━━━━\n";
    sorted.forEach(([uid, v], i) => {
      const name = (global.data?.userName?.get(uid)) || uid;
      msg += `${i + 1}. ${name}: ${v.balance.toLocaleString()} $\n`;
    });
    return api.sendMessage(msg.trim(), threadID, messageID);
  }

  const bet = parseInt(args[0]);
  if (!bet || bet <= 0 || isNaN(bet)) {
    return api.sendMessage(
      "⚠️ الاستخدام: .slot [المبلغ]\nمثال: .slot 100\n\nأوامر أخرى:\n• .slot balance — رصيدك\n• .slot top — أثرى اللاعبين",
      threadID, messageID
    );
  }

  let balance = getBalance(data, senderID);
  if (balance < bet) {
    return api.sendMessage(`❌ رصيدك غير كافٍ! رصيدك: ${balance.toLocaleString()} $`, threadID, messageID);
  }
  if (bet > balance) {
    return api.sendMessage(`❌ لا يمكنك المراهنة بأكثر من رصيدك (${balance.toLocaleString()} $).`, threadID, messageID);
  }

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

  setBalance(data, senderID, balance);
  saveData(data);

  const resultMsg = win
    ? `🎰 لعبة السلوت\n━━━━━━━━━━━━━━━\n\n🎲 النتيجة:\n[ ${s1} | ${s2} | ${s3} ]\n\n🏆 فزت! جاكبوت!\n💵 ربحت: +${bet.toLocaleString()} $\n\n💰 الرصيد: ${balance.toLocaleString()} $`
    : `🎰 لعبة السلوت\n━━━━━━━━━━━━━━━\n\n🎲 النتيجة:\n[ ${s1} | ${s2} | ${s3} ]\n\n💸 خسرت!\n💵 خسرت: -${bet.toLocaleString()} $\n\n💰 الرصيد: ${balance.toLocaleString()} $`;

  return api.sendMessage(resultMsg, threadID, messageID);
};
