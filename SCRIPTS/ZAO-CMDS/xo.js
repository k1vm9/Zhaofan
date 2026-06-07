module.exports.config = {
  name: "اكس",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "لعبة X-O — لاعبين، رد بالرقم 1-9",
  commandCategory: "ألعاب",
  usages: "اكس @لاعب",
  cooldowns: 3
};

module.exports.languages = { vi: {}, en: {} };

const SYMBOLS = { X: "❌", O: "⭕", "_": "▫️" };
const POS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];

function renderBoard(board) {
  const cells = board.map((c, i) => c === "_" ? POS[i] : SYMBOLS[c]);
  return (
    `${cells[0]} ${cells[1]} ${cells[2]}\n` +
    `${cells[3]} ${cells[4]} ${cells[5]}\n` +
    `${cells[6]} ${cells[7]} ${cells[8]}`
  );
}

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function checkWinner(board) {
  for (const [a,b,c] of WIN_LINES) {
    if (board[a] !== "_" && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  if (board.every(c => c !== "_")) return "draw";
  return null;
}

async function _getName(api, uid) {
  try {
    const info = await api.getUserInfo(uid);
    return info?.[uid]?.name || "لاعب";
  } catch { return "لاعب"; }
}

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID, mentions } = event;

  const opponentID = Object.keys(mentions || {})[0];
  if (!opponentID) {
    return api.sendMessage("⚠️ منشن اللاعب الثاني.\nمثال: اكس @زاو", threadID, messageID);
  }
  if (opponentID === senderID) {
    return api.sendMessage("⚠️ ما تقدرش تلعب مع روحك.", threadID, messageID);
  }

  const [n1, n2] = await Promise.all([_getName(api, senderID), _getName(api, opponentID)]);

  const board = ["_","_","_","_","_","_","_","_","_"];
  const players = { X: senderID, O: opponentID };
  const names   = { X: n1,       O: n2 };
  const turn = "X";

  const msg =
    `🎮 X-O — جولة جديدة\n━━━━━━━━━━━━━\n` +
    `${SYMBOLS.X} ${names.X}\n${SYMBOLS.O} ${names.O}\n━━━━━━━━━━━━━\n` +
    `${renderBoard(board)}\n━━━━━━━━━━━━━\n` +
    `الدور: ${SYMBOLS[turn]} ${names[turn]}\n` +
    `↩️ رد برقم الخانة (1-9)`;

  return api.sendMessage(msg, threadID, (err, info) => {
    if (err || !info) return;
    global.client.handleReply.push({
      name: "اكس",
      messageID: info.messageID,
      author: senderID, // first player started, but both can reply
      board,
      players,
      names,
      turn
    });
  }, messageID);
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;

  const { board, players, names, turn } = handleReply;

  // only the two registered players can interact
  if (senderID !== players.X && senderID !== players.O) return;

  // must be the player whose turn it is
  if (senderID !== players[turn]) {
    global.client.handleReply.push({ ...handleReply, messageID });
    return api.sendMessage(
      `⏳ مش دورك. الدور على ${SYMBOLS[turn]} ${names[turn]}`,
      threadID, messageID
    );
  }

  const cell = parseInt(String(body || "").trim(), 10);
  if (isNaN(cell) || cell < 1 || cell > 9) {
    global.client.handleReply.push({ ...handleReply, messageID });
    return api.sendMessage("⚠️ رقم بين 1 و 9 فقط.", threadID, messageID);
  }

  if (board[cell - 1] !== "_") {
    global.client.handleReply.push({ ...handleReply, messageID });
    return api.sendMessage("⚠️ الخانة محجوزة. اختار وحدة فاضية.", threadID, messageID);
  }

  board[cell - 1] = turn;
  const result = checkWinner(board);

  if (result === "draw") {
    return api.sendMessage(
      `${renderBoard(board)}\n━━━━━━━━━━━━━\n🤝 تعادل!`,
      threadID, messageID
    );
  }

  if (result === "X" || result === "O") {
    return api.sendMessage(
      `${renderBoard(board)}\n━━━━━━━━━━━━━\n🏆 فاز ${SYMBOLS[result]} ${names[result]}!`,
      threadID, messageID
    );
  }

  const nextTurn = turn === "X" ? "O" : "X";
  const newMsg =
    `🎮 X-O\n━━━━━━━━━━━━━\n` +
    `${SYMBOLS.X} ${names.X}\n${SYMBOLS.O} ${names.O}\n━━━━━━━━━━━━━\n` +
    `${renderBoard(board)}\n━━━━━━━━━━━━━\n` +
    `الدور: ${SYMBOLS[nextTurn]} ${names[nextTurn]}\n` +
    `↩️ رد برقم الخانة (1-9)`;

  return api.sendMessage(newMsg, threadID, (err, info) => {
    if (err || !info) return;
    global.client.handleReply.push({
      name: "اكس",
      messageID: info.messageID,
      author: handleReply.author,
      board,
      players,
      names,
      turn: nextTurn
    });
  });
};
