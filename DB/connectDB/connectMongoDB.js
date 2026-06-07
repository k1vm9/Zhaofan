module.exports = async function (uriConnect) {
  const mongoose = require("mongoose");

  const threadModel = require("../models/mongodb/thread.js");
  const userModel = require("../models/mongodb/user.js");
  const globalModel = require("../models/mongodb/global.js");

  await mongoose.connect(uriConnect);

  return {
    threadModel,
    userModel,
    globalModel
  };
};
