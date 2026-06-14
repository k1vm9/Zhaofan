  module.exports.config = {
  name: "اوامر",
  version: "1.0.2",
  hasPermssion: 0,
  credits: "𝑆𝐴𝐼𝑀",
  description: "الاوامر",
  commandCategory: "خدمات",
  usages: "[دليل المستخدم ]",
  cooldowns: 1,
  envConfig: {
    autoUnsend: true,
    delayUnsend: 300
  }
};

module.exports.languages = {
  //"vi": {
  //	"moduleInfo": "「 %1 」\n%2\n\n❯ Cách sử dụng: %3\n❯ Thuộc nhóm: %4\n❯ Thời gian chờ: %5 giây(s)\n❯ Quyền hạn: %6\n\n» Module code by %7 «",
  //	"helpList": '[ Hiện tại đang có %1 lệnh có thể sử dụng trên bot này, Sử dụng: "%2help nameCommand" để xem chi tiết cách sử dụng! ]"',
  //	"user": "Người dùng",
  //      "adminGroup": "Quản trị viên nhóm",
  //      "adminBot": "Quản trị viên bot"
//	},
  "en": {
    "moduleInfo": "『 %1』\n%2\n←كيفية الاستخدام: %3\n←فئة: %4\n←وقت الانتظار: %5 ثواني(s)\n←من لديه الصلاحية: %6\n\n←طور بواسطة %7",
    "helpList": '[ There are %1 commands on this bot, Use: "%2help nameCommand" to know how to use! ]',
    "user": "『الكل』",
        "adminGroup": "『مسؤل القروب』",
        "adminBot": "『المطور』"
  }
};

module.exports.handleEvent = function ({ api, event, getText }) {
  const { commands } = global.client;
  const { threadID, messageID, body } = event;

  if (!body || typeof body == "undefined" || body.indexOf("اوامر") != 0) return;
  const splitBody = body.slice(body.indexOf("أوامر")).trim().split(/\s+/);
  if (splitBody.length == 1 || !commands.has(splitBody[1].toLowerCase())) return;
  const threadSetting = global.data.threadData.get(parseInt(threadID)) || {};
  const command = commands.get(splitBody[1].toLowerCase());
  const prefix = (threadSetting.hasOwnProperty("PREFIX")) ? threadSetting.PREFIX : global.config.PREFIX;
  return api.sendMessage(getText("moduleInfo", command.config.name, command.config.description, `${prefix}${command.config.name} ${(command.config.usages) ? command.config.usages : ""}`, command.config.commandCategory, command.config.cooldowns, ((command.config.hasPermssion == 0) ? getText("user") : (command.config.hasPermssion == 1) ? getText("adminGroup") : getText("adminBot")), command.config.credits), threadID, messageID);
}

module.exports. run = function({ api, event, args, getText }) {
  const { commands } = global.client;
  const { threadID, messageID } = event;
  const command = commands.get((args[0] || "").toLowerCase());
  const threadSetting = global.data.threadData.get(parseInt(threadID)) || {};
  const { autoUnsend, delayUnsend } = global.configModule[this.config.name];
  const prefix = (threadSetting.hasOwnProperty("PREFIX")) ? threadSetting.PREFIX : global.config.PREFIX;

  if (!command) {
    const arrayInfo = [];
    const page = parseInt(args[0]) || 1;
    const numberOfOnePage = 20;
    //*số thứ tự 1 2 3.....cú pháp ${++i}*//
    let i = 0;
    let msg = "";

    for (var [name, value] of (commands)) {
      name += ``;
      arrayInfo.push(name);
    }

    arrayInfo.sort((a, b) => a.data - b.data);

    const startSlice = numberOfOnePage*page - numberOfOnePage;
    i = startSlice;
    const returnArray = arrayInfo.slice(startSlice, startSlice + numberOfOnePage);

    for (let item of returnArray) msg += `
${++i} ⧐        ❨ ${item} ❩ 🩸⚜️\n`;


    const siu = `   
    
⇱    😈🔥❨ 🩸𝗟𝗘𝗦𝗧🩸 ❩🔥😈    ⇲   
  
   ▱▱▱▱▱▱▱▱▱▱▱▱

🩸⚜️ 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝘁𝗼 𝘁𝗵𝗲 ⚜️🩸
𝗩𝗲𝗿𝗮 𝗯𝗼𝘁 𝗰𝗼𝗺𝗺𝗮𝗻𝗱 𝗹𝗶𝘀𝘁😈🔥

▱▱▱▱▱▱▱▱▱▱▱▱`;

    const text = `\nرقـم الـصـفـحـة (${page}/${Math.ceil(arrayInfo.length/numberOfOnePage)})\n 
    
    اسـتـخـدم ${prefix} قـبـل ڪـل امـر
    
  ✠ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ✠

  

      ❨🩸𝗔𝗗𝗠𝗜𝗡 ⚜️ 𝗕𝗢𝗧 🩸 ❩
      


   𝛺 ~ 🔥 ➪ 𝗦𝗔𝗜𝗠 ❦ 😈...♤

   


▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰`;

    return api.sendMessage(siu + "\n\n" + msg  + text, threadID, async (error, info) => {
      if (autoUnsend) {
        await new Promise(resolve => setTimeout(resolve, delayUnsend * 1000));
        return api.unsendMessage(info.messageID);
      } else return;
    }, event.messageID);
  }

  return api.sendMessage(getText("moduleInfo", command.config.name, command.config.description, `${prefix}${command.config.name} ${(command.config.usages) ? command.config.usages : ""}`, command.config.commandCategory, command.config.cooldowns, ((command.config.hasPermssion == 0) ? getText("user") : (command.config.hasPermssion == 1) ? getText("adminGroup") : getText("adminBot")), command.config.credits), threadID, messageID);
};
