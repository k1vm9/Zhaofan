module.exports.config = {
  name: "خمن",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "خمن الرقم بين 1 و 100 — البوت يقولك حار/بارد",
  commandCategory: "ألعاب",
  usages: "خمن",
  cooldowns: 3
};

module.exports.languages = { vi: {}, en: {} };

const MAX_TRIES = 7;
const RANGE_MAX = 100;

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;
  const secret = Math.floor(Math.random() * RANGE_MAX) + 1;

  const msg =
    `🎯 خمّن الرقم\n━━━━━━━━━━━━━\n` +
    `خمنت رقم بين 1 و ${RANGE_MAX}\n` +
    `عندك ${MAX_TRIES} محاولات\n\n` +
    `↩️ رد برقمك`;

  return api.sendMessage(msg, threadID, (err, info) => {
    if (err || !info) return;
    global.client.handleReply.push({
      name: "خمن",
      messageID: info.messageID,
      author: senderID,
      secret,
      tries: 0,
      lastDiff: null
    });
  }, messageID);
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;

  const guess = parseInt(String(body || "").trim(), 10);
  if (isNaN(guess) || guess < 1 || guess > RANGE_MAX) {
    // re-register so the user can retry without losing the game
    global.client.handleReply.push({ ...handleReply, messageID });
    return api.sendMessage(`⚠️ ابعث رقم صحيح بين 1 و ${RANGE_MAX}.`, threadID, messageID);
  }

  handleReply.tries++;

  if (guess === handleReply.secret) {
    return api.sendMessage(
      `🎉 برافو! الرقم كان ${handleReply.secret}\n✅ ربحت في ${handleReply.tries} محاولة`,
      threadID, messageID
    );
  }

  if (handleReply.tries >= MAX_TRIES) {
    return api.sendMessage(
      `💀 خلصت محاولاتك!\nالرقم كان: ${handleReply.secret}`,
      threadID, messageID
    );
  }

  const diff = Math.abs(guess - handleReply.secret);
  const dir = guess < handleReply.secret ? "⬆️ كبّر" : "⬇️ صغّر";

  let temp;
  if (diff <= 3)       temp = "🔥 حار جداً";
  else if (diff <= 7)  temp = "♨️ حار";
  else if (diff <= 15) temp = "😎 دافي";
  else if (diff <= 30) temp = "❄️ بارد";
  else                 temp = "🧊 بارد جداً";

  let trend = "";
  if (handleReply.lastDiff != null) {
    if (diff < handleReply.lastDiff)      trend = " · تقربت 🟢";
    else if (diff > handleReply.lastDiff) trend = " · بعدت 🔴";
    else                                   trend = " · نفس البعد 🟡";
  }
  handleReply.lastDiff = diff;

  // re-register for the next reply
  global.client.handleReply.push({
    name: "خمن",
    messageID: messageID,
    author: senderID,
    secret: handleReply.secret,
    tries: handleReply.tries,
    lastDiff: handleReply.lastDiff
  });

  return api.sendMessage(
    `${temp} ${dir}${trend}\nالمحاولة ${handleReply.tries}/${MAX_TRIES}`,
    threadID, messageID
  );
};
