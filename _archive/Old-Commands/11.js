const fs = global.nodemodule["fs-extra"];
module.exports.config = {
  name: "BbV",
  version: "1.0.1",
  hasPermssion: 0,
  credits: "Mod by John Lester",
  description: " ",
  commandCategory:"𝓓𝓮𝓿𝓮𝓵𝓸𝓹𝓮𝓻 🔱🔥",
  usages: " ",
  cooldowns: 5,
};
module.exports.handleEvent = async function({ api, event, args, Threads, Users }) {
  var { threadID, messageID, reason } = event;
  const moment = require("moment-timezone");
  const time = moment.tz("Asia/Manila").format("HH:MM:ss L");
  var idgr = `${event.threadID}`;
  var id = event.senderID;
  var name = await Users.getNameUser(event.senderID);

  var tl = ["hello friend, I'm Hai's bot", "what are you asking me to do?", "I love you shoulder lon", "Love you <3", "Hi, hello baby wife :3", "My wife called for a job.  what?", "Use callad to contact admin!", "You're the cutest bot on the planet", "What are you talking about pig", "It's me~~~~"];
  var rand = tl[Math.floor(Math.random() * tl.length)]

    if ((event.body.toLowerCase() == "احبك") || (event.body.toLowerCase() == "نحبك")) {
     return api.sendMessage("كسم حب", threadID);
   };

    if ((event.body.toLowerCase() == "ماهذا") || (event.body.toLowerCase() == "مهذا")) {
     return api.sendMessage("ايش", threadID);
   };

    if ((event.body.toLowerCase() == "نكحتشونيماك") || (event.body.toLowerCase() == "كسمك و كسمه")) {
     return api.sendMessage("ياولد قح... بة نكمك", threadID);
   };

   if ((event.body.toLowerCase() == "صباح الخير") || (event.body.toLowerCase() == "صباح")) {
     return api.sendMessage("صباح النور ", threadID);
   };

   if ((event.body.toLowerCase() == "كيفكم") || (event.body.toLowerCase() == "كيفك")) {
     return api.sendMessage("بخير الحمدلله وانت/ي", threadID);
   };

   if ((event.body.toLowerCase() == "اتفق") || (event.body.toLowerCase() == "أتفق")) {
     return api.sendMessage("اقحب من يتفق", threadID);
   };

  if ((event.body.toLowerCase() == "الو") || (event.body.toLowerCase() == "ألو")) {
     return api.sendMessage("طيزك حلو", threadID);
   };

   if ((event.body.toLowerCase() == "كسمك") || (event.body.toLowerCase() == "كسختك")) {
     return api.sendMessage("تشتم زبي؟ ", threadID);
   };

   if ((event.body.toLowerCase() == "هلو") || (event.body.toLowerCase() == "هلا")) {
     return api.sendMessage("هلاوات", threadID);
   };

   if ((event.body.toLowerCase() == "بوت متناك") || (event.body.toLowerCase() == "بوت منيوك")) {
     return api.sendMessage(`نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.   ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ سـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــطـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـحـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ سـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـسـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـخـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـتـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. فـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـۅقـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ. ڒٍبـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـيـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــޢޢـ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـحـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــرقـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ. كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـسـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ مـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. خـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـتـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ سـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. ۅكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ خـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـتـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـسـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ ۅكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـطـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ نـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـمـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ خـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـتـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  كـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـسـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ. ڒٍكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ.  خـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـتـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢــكـ🌙ــ❤ــ🌙ــ❤ــ⭐️ــ❣ـہـޢޢـ
( بـوت ســايــم يـركـب ام الـقحـبة الي تشتمه ]`, threadID);
   };

   if ((event.body.toLowerCase() == "جميل") || (event.body.toLowerCase() == "حلو")) {
     return api.sendMessage("نايس", threadID);
   };

   if ((event.body.toLowerCase() == "محح") || (event.body.toLowerCase() == "مح")) {
     return api.sendMessage("محح بكسمك", threadID);
   };


   if ((event.body.toLowerCase() == "كسم الحال") || (event.body.toLowerCase() == "كسم الحياة")) {
     return api.sendMessage("وكسمك", threadID);
   };

   if ((event.body.toLowerCase() == "ملل") || (event.body.toLowerCase() == "مللل")) {
     return api.sendMessage("️كثيير", threadID);
   };

   if ((event.body.toLowerCase() == "طيزك") || (event.body.toLowerCase() == "كسك")) {
     return api.sendMessage(" زبي فيه", threadID);
   };

   if ((event.body.toLowerCase() == "ثباحو") || (event.body.toLowerCase() == "ثباحوو")) {
     return api.sendMessage("️ثباحوات", threadID);
   };

   if ((event.body.toLowerCase() == "من انت؟ ") || (event.body.toLowerCase() == "من انت")) {
     return api.sendMessage("️الي حواك", threadID);
   };

   if ((event.body.toLowerCase() == "السلام عليكم") || (event.body.toLowerCase() == "سلام")) {
     return api.sendMessage("️وعليكم السلام ورحمة الله وبركاته", threadID);
   };

   if ((event.body.toLowerCase() == "كسمكم") || (event.body.toLowerCase() == "نكمكم")) {
     return api.sendMessage("️ياولد القحبة لاتجمع نكحتشونيماك ", threadID);
   };

   if ((event.body.toLowerCase() == "بوت نكمك") || (event.body.toLowerCase() == "بوت كسمك")) {
     return api.sendMessage("️﷽؟", threadID);
   };

   if ((event.body.toLowerCase() == "كسم الضحك") || (event.body.toLowerCase() == "كسم ضحك")) {
     return api.sendMessage("️وكسم قحابزا", threadID);
   };

   if ((event.body.toLowerCase() == "سايمة") || (event.body.toLowerCase() == "سايمه")) {
     return api.sendMessage("️نياڪ مڪ وتاء بڪسمڪ", threadID);
   };

   if ((event.body.toLowerCase() == "dm bot") || (event.body.toLowerCase() == "dm bot")) {
     return api.sendMessage("️Swear something to your dad :), you're a kid but you like to be alive :)", threadID);
   };

   if ((event.body.toLowerCase() == "nobody loves me") || (event.body.toLowerCase() == "nobody loves me")) {
     return api.sendMessage("️Come on, the bot loves you <3 <3", threadID);
   };

   if ((event.body.toLowerCase() == "does the bot love the admin bot") || (event.body.toLowerCase() == "does the bot love the admin bot")) {
     return api.sendMessage("Yes, love him the most, don't try to rob me", threadID);
   };

   if ((event.body.toLowerCase() == "bot im going") || (event.body.toLowerCase() == "bot im di")) {
     return api.sendMessage("Im cc :))) m stop barking for me, but tell me im :>>", threadID);
   };

   if ((event.body.toLowerCase() == "bot go away") || (event.body.toLowerCase() == "bot cut di")) {
     return api.sendMessage("You're gone, your dad's gone, don't make you speak :))))", threadID);
   };

   if ((event.body.toLowerCase() == "What's the bot swearing") || (event.body.toLowerCase() == "bot cursing")) {
     return api.sendMessage("Damn you, shame on hahaha :>>, still asking", threadID);
   };

   if ((event.body.toLowerCase() == "is the bot sad") || (event.body.toLowerCase() == "is the bot sad")) {
     return api.sendMessage("Why can't I be sad because of everyone <3 love you <3", threadID);
   };

   if ((event.body.toLowerCase() == "does the bot love you") || (event.body.toLowerCase() == "does the bot love you")) {
     return api.sendMessage("Yes I love you and everyone so much", threadID);
   };

   if ((event.body.toLowerCase() == "bot goes to sleep") || (event.body.toLowerCase() == "bot goes to sleep")) {
     return api.sendMessage("I'm a bot, you're the one who should go to sleep <3", threadID);
   };

   if ((event.body.toLowerCase() == "has the bot eaten yet") || (event.body.toLowerCase() == "bot an comrade")) {
     return api.sendMessage("I'm full when I see you eat <3", threadID);
   };

   if ((event.body.toLowerCase() == "does the bot love me") || (event.body.toLowerCase() == "does the bot love me")) {
     return api.sendMessage("Yes <3", threadID);
   };

   if ((event.body.toLowerCase() == "does the bot have a brand") || (event.body.toLowerCase() == "does the bot fall")) {
     return api.sendMessage("Yes <3", threadID);
   };

  if (event.body.indexOf("bot") == 0 || (event.body.indexOf("Bot") == 0)) {
    var msg = {
      body: `${name}, ${rand}`
    }
    return api.sendMessage(msg, threadID, messageID);
  };

}

module.exports.run = function({ api, event, client, __GLOBAL }) { }
