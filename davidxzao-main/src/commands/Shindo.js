module.exports.config = {
  name: "قفل",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "SAIN",
  description: "قفل البوت ومنع استخدامه إلا لأدمن البوت",
  commandCategory: "إدارة البوت",
  usages: "تفعيل / ايقاف",
  cooldowns: 0
};

module.exports.languages = {
  "vi": {},
  "en": {}
};

module.exports.onLoad = () => {
  global.lockBot = false;
};

module.exports.run = async function ({ api, event, permssion }) {
  const { threadID, messageID } = event;
  const args = event.body.trim().split(/ +/).slice(1);

  if (permssion < 2) return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  if (!args[0]) return api.sendMessage("📌 الاستخدام: قفل تفعيل | قفل ايقاف", threadID, messageID);

  if (args[0] === "تفعيل") {
    if (global.lockBot === true) return api.sendMessage("⚠️ البوت مقفل مسبقاً.", threadID, messageID);
    global.lockBot = true;
    return api.sendMessage("🔒 تم تفعيل قفل البوت بنجاح.\nلا يستطيع أحد استخدام الأوامر الآن.", threadID, messageID);
  }

  else if (args[0] === "ايقاف") {
    if (global.lockBot === false) return api.sendMessage("⚠️ البوت غير مقفل أصلاً.", threadID, messageID);
    global.lockBot = false;
    return api.sendMessage("🔓 تم إيقاف قفل البوت بنجاح.\nيمكن للجميع استخدام الأوامر الآن.", threadID, messageID);
  }

  else {
    return api.sendMessage("📌 الاستخدام: قفل تفعيل | قفل ايقاف", threadID, messageID);
  }
};