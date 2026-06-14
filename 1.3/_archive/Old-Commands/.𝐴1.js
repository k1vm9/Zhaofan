module.exports.config = {
  name: "صمت",
  version: "1.0.6",
  haPermission: 2,
  credits: "DRIDI-RAYEN",
  description: "",
    usePrefix: false,
  commandCategory:"",
  usages: "سكوت تشغيل/ايقاف",
  cooldowns: 5,

  allowedThreads: [] 
};

module.exports.handleEvent = async ({ api, event }) => {
  if (!module.exports.config.isOn) return;

  let user = await api.getUserInfo(event.senderID);
  let thread = await api.getThreadInfo(event.threadID);
  let name = user[event.senderID].name;
  var admin = global.config.ADMINBOT;

  if (event.senderID == api.getCurrentUserID() || admin.includes(event.senderID)) return;
  if (!module.exports.config.allowedThreads.includes(event.threadID)) return;

  if (event.type === "message" && !(thread.adminIDs.some(user => user.id == event.senderID))) {
    api.removeUserFromGroup(event.senderID, event.threadID);
    return api.sendMessage(
      {
        body: `قلت لا تتحدث يا \n${name} 👿`,
        mentions: [
          {
            tag: name,
            id: event.senderID
          }
        ]
      },
      event.threadID,
      () => {
        var idad = admin;
        for (let ad of idad) {
          setTimeout(() => {
            var callback = () =>
              api.sendMessage(
                {
                  body: ``
                },
                event.threadID,
                event.messageID
              );
          }, 1000);
        }
      }
    );
  }
};

module.exports.run = async function ({ api, args, event }) {
  if (args[0] == "تشغيل") {
    module.exports.config.isOn = true;
    module.exports.config.allowedThreads.push(event.threadID); 
    return api.sendMessage(
      "تـم تــشـغـيـل وضـع الـسـكـوت مـن يـتـحـدث يـتم يــتـنــاڪ للـفـضـاء",
      event.threadID,
      event.messageID
    );
  } else if (args[0] == "ايقاف") {
    module.exports.config.isOn = false;
    const index = module.exports.config.allowedThreads.indexOf(event.threadID);
    if (index > -1) {
      module.exports.config.allowedThreads.splice(index, 1); 
    }
    return api.sendMessage(
      "تـم ايـقـاف وضـع الـسـكـوت  يــمــكـنـكـم الــكـلام 👿 👿",
      event.threadID,
      event.messageID
    );
  } else {
    return;
  }
};