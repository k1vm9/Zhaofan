"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

module.exports = {
  ROOT,
  CONFIG_PATH: path.join(ROOT, "config.json"),
  // A separate copy keeps rollback to the original ZAO runner possible.
  ACCOUNT_PATH: path.join(ROOT, "sessions", "DJAMEL-FCA-STATE.json"),
};
