module.exports.config = {
  name: "تيد",	version: "1.0.0", 
  hasPermssion: 0,
  credits: "NTKhang",
  description: "معرف المجموعة 👽", 
  commandCategory: "group",
  usages: "tid",
  cooldowns: 5, 
  dependencies: '',
};

module.exports.run = async function({ api, event }) {
  api.sendMessage(event.threadID, event.threadID);
};
