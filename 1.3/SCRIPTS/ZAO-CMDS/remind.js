module.exports.config = {
  name: "ذكرني",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "SAIN",
  description: "ضع تذكيراً يصلك بعد وقت محدد",
  commandCategory: "أدوات",
  usages: "ذكرني [الدقائق] [الرسالة]",
  cooldowns: 5
};

module.exports.run = async function ({ api, event, args }) {
  const mins = parseInt(args[0]);
  if (!mins || mins < 1 || mins > 1440) {
    return api.sendMessage(
      "⏰ الاستخدام:\nذكرني [1-1440 دقيقة] [رسالتك]\n\nمثال:\nذكرني 30 موعد الاجتماع",
      event.threadID,
      event.messageID
    );
  }
  const msg = args.slice(1).join(" ").trim() || "التذكير الذي طلبته";
  const displayTime = mins >= 60
    ? `${Math.floor(mins / 60)} ساعة${mins % 60 ? ` و${mins % 60} دقيقة` : ""}`
    : `${mins} دقيقة`;

  api.sendMessage(
    `✅ تم الضبط!\nسأذكّرك بعد ${displayTime}.\n📌 الرسالة: ${msg}`,
    event.threadID,
    event.messageID
  );

  setTimeout(() => {
    try {
      api.sendMessage(`⏰ تذكير!\n\n📌 ${msg}`, event.threadID);
    } catch (_) {}
  }, mins * 60 * 1000);
};
