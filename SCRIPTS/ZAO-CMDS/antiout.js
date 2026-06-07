module.exports.config = {
  name: "antiout",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "SAIN",
  description: "تفعيل / إيقاف منع الخروج من المجموعة",
  commandCategory: "إدارة",
  usages: "تفعيل | ايقاف | حالة",
  cooldowns: 3
};

module.exports.run = async function ({ api, event, args, Threads }) {
  const { threadID, messageID } = event;

  const threadRow = await Threads.getData(threadID);
  const data = (threadRow && threadRow.data) ? { ...threadRow.data } : {};

  const action = (args[0] || "").trim();

  if (!action || action === "حالة") {
    const state = data.antiout === true ? "🟢 مفعّل" : "🔴 موقوف";
    return api.sendMessage(
      `🔒 حالة منع الخروج في هذه المجموعة: ${state}\n\n` +
      `📌 الأوامر:\n` +
      `• antiout تفعيل — تشغيل المنع\n` +
      `• antiout ايقاف — إيقاف المنع\n` +
      `• antiout حالة  — عرض الحالة الحالية`,
      threadID, messageID
    );
  }

  if (action === "تفعيل") {
    if (data.antiout === true) {
      return api.sendMessage("⚠️ منع الخروج مفعّل مسبقاً في هذه المجموعة.", threadID, messageID);
    }
    data.antiout = true;
    await Threads.setData(threadID, { data });
    return api.sendMessage(
      "✅ تم تفعيل منع الخروج.\nأي شخص يحاول المغادرة سيتم إعادته تلقائياً. 😈🔥",
      threadID, messageID
    );
  }

  if (action === "ايقاف") {
    if (data.antiout !== true) {
      return api.sendMessage("⚠️ منع الخروج غير مفعّل أصلاً في هذه المجموعة.", threadID, messageID);
    }
    data.antiout = false;
    await Threads.setData(threadID, { data });
    return api.sendMessage(
      "🔓 تم إيقاف منع الخروج.\nيمكن للأعضاء المغادرة بحرية الآن.",
      threadID, messageID
    );
  }

  return api.sendMessage(
    "❌ أمر غير معروف.\n\n📌 الأوامر المتاحة:\n" +
    "• antiout تفعيل\n• antiout ايقاف\n• antiout حالة",
    threadID, messageID
  );
};
