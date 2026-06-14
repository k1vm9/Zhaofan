module.exports.config = {
  name: "تست",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "",
  description: "",
  commandCategory: "تيست",
  usages: "",
  cooldowns: 0
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;
  const funcs = Object.keys(api).filter(k => typeof api[k] === "function").join("\n");
  return api.sendMessage(funcs, threadID, messageID);
};
