module.exports.config = {
  name: "off",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "Des Bủh - Dựa trên demo của manhIT", /* vui lòng k sửa credit :) */
  description: "Shut down zao",
  commandCategory: "Hệ thống",
  cooldowns: 0
        };

module.exports.run = async({event, api}) =>{
const permission = ["61562787157854"];
      if (!permission.includes(event.senderID)) return api.sendMessage("𝗦𝗼𝗿𝗿𝘆, 𝗼𝗻𝗹𝘆 the S𝗮𝗶𝗺 𝗱𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿 𝗶𝘀 𝗮𝗹𝗹𝗼𝘄𝗲𝗱 𝘁𝗼 𝘂𝘀𝗲 𝘁𝗵𝗶𝘀 𝗰𝗼𝗺𝗺𝗮𝗻𝗱 :  عـذراً يـسـمـح للمـطـور فـقـط اسـتـخـدام هـذا الأمـر ♦❗", event.threadID, event.messageID);

api.sendMessage(" 𝗯𝗼𝘁 𝗵𝗮𝘀 𝗯𝗲𝗲𝗻 𝘀𝘁𝗼𝗽𝗽𝗲𝗱 : تـم تـنـفـيـذ الـبـوت فـي وضـع إيـقـاف الـتـشـغـيل ♦ ✓",event.threadID, () =>process.exit(0))}