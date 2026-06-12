module.exports.config = {
  name: "تصويت",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "SAIN",
  description: "إنشاء تصويت سريع في الغروب",
  commandCategory: "أدوات",
  usages: "تصويت [السؤال] | [خيار1] | [خيار2] ...",
  cooldowns: 10
};

module.exports.run = async function ({ api, event, args }) {
  const raw   = args.join(" ");
  const parts = raw.split("|").map(p => p.trim()).filter(Boolean);

  if (parts.length < 3) {
    return api.sendMessage(
      "📊 الاستخدام:\nتصويت [السؤال] | [خيار1] | [خيار2] ...\n\nمثال:\nتصويت ما رأيك؟ | جيد | سيئ | لا أعرف",
      event.threadID,
      event.messageID
    );
  }

  const question = parts[0];
  const options  = parts.slice(1, 9);
  const emojis   = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];
  const lines    = options.map((opt, i) => `${emojis[i]} ${opt}`);

  const msg =
    `📊 ${question}\n` +
    `${"─".repeat(30)}\n` +
    lines.join("\n") +
    `\n${"─".repeat(30)}\n` +
    `💬 صوّت بالإيموجي المناسب!`;

  api.sendMessage(msg, event.threadID, event.messageID);
};
