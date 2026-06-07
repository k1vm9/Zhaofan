'use strict';
// Fast Math Quiz — answer before time runs out

const OPS = ['+', '-', '×', '÷'];

function mkQuestion(difficulty) {
  const op = OPS[Math.floor(Math.random() * OPS.length)];
  let a, b, answer, display;
  switch (op) {
    case '+':
      a = Math.floor(Math.random() * (difficulty * 50)) + 1;
      b = Math.floor(Math.random() * (difficulty * 50)) + 1;
      answer = a + b; display = `${a} + ${b}`;
      break;
    case '-':
      a = Math.floor(Math.random() * (difficulty * 50)) + 10;
      b = Math.floor(Math.random() * a) + 1;
      answer = a - b; display = `${a} - ${b}`;
      break;
    case '×':
      a = Math.floor(Math.random() * (difficulty * 12)) + 2;
      b = Math.floor(Math.random() * 12) + 2;
      answer = a * b; display = `${a} × ${b}`;
      break;
    case '÷':
      b = Math.floor(Math.random() * 11) + 2;
      answer = Math.floor(Math.random() * 20) + 1;
      a = b * answer;
      display = `${a} ÷ ${b}`;
      break;
  }
  return { display, answer };
}

const _timers = new Map(); // messageID → timeout handle

module.exports.config = {
  name: 'سريع',
  aliases: ['quickmath', 'fastmath', 'رياضيات'],
  version: '1.0.0',
  hasPermssion: 0,
  credits: 'ZAO',
  description: 'اختبار رياضيات سريع — أجب قبل انتهاء الوقت!',
  commandCategory: 'ألعاب',
  usages: 'سريع [سهل|وسط|صعب]',
  cooldowns: 5,
};
module.exports.languages = { vi: {}, en: {} };

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const lvl = (args[0] === 'صعب') ? 3 : (args[0] === 'وسط') ? 2 : 1;
  const q = mkQuestion(lvl);
  const TIME_SEC = lvl === 3 ? 15 : lvl === 2 ? 20 : 30;

  return api.sendMessage(
    `⚡ رياضيات سريع\n━━━━━━━━━━━━━\n❓ ${q.display} = ؟\n⏱️ عندك ${TIME_SEC} ثانية\n\n↩️ رد بالجواب`,
    threadID,
    (err, info) => {
      if (err || !info) return;
      const entry = { name: 'سريع', messageID: info.messageID, author: senderID, answer: q.answer, timeSec: TIME_SEC };
      global.client.handleReply.push(entry);
      // Auto-expire
      const t = setTimeout(() => {
        _timers.delete(info.messageID);
        const idx = (global.client.handleReply || []).findIndex(r => r.messageID === info.messageID && r.name === 'سريع');
        if (idx !== -1) global.client.handleReply.splice(idx, 1);
        api.sendMessage(`⏰ انتهى الوقت! الجواب كان: ${q.answer}`, threadID);
      }, TIME_SEC * 1000);
      if (t.unref) t.unref();
      _timers.set(info.messageID, t);
    },
    messageID
  );
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;
  if (handleReply.author !== senderID) return;
  const t = _timers.get(handleReply.messageID);
  if (t) { clearTimeout(t); _timers.delete(handleReply.messageID); }
  const guess = parseInt(String(body || '').trim(), 10);
  if (isNaN(guess)) {
    global.client.handleReply.push({ ...handleReply, messageID });
    return api.sendMessage('⚠️ أرسل رقماً فقط.', threadID, messageID);
  }
  if (guess === handleReply.answer) {
    return api.sendMessage(`🎉 صحيح! الجواب هو ${handleReply.answer} ✅`, threadID, messageID);
  }
  return api.sendMessage(`❌ خطأ! الجواب الصحيح: ${handleReply.answer}`, threadID, messageID);
};
