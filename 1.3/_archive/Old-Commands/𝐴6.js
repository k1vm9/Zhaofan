module.exports.config = {
  name: "تراجع",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "𝙈𝙧𝙏𝙤𝙢𝙓𝙭𝙓",
  description: "",
  commandCategory: "Admin",
  usages: "out [id]",
  cooldowns: 10,
};

module.exports.run = async function({ api, event, args }) {
      if (!args[0]) return api.removeUserFromGroup(api.getCurrentUserID(), event.threadID);
      if (!isNaN(args[0])) return api.removeUserFromGroup(api.getCurrentUserID(), args.join(" "));
}