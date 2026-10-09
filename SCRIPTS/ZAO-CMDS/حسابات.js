const fs   = require("fs-extra");
const path = require("path");
const { ACCOUNT_PATH } = require("../../src/utils/runtimePaths");

module.exports.config = {
  name: "حسابات",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "عرض حالة جلسة Djamel-Fca الحالية",
  commandCategory: "النظام",
  usages: "حسابات",
  cooldowns: 5
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;

  const adminIDs = (global.config?.ADMINBOT || []).map(String);
  if (!adminIDs.includes(String(senderID))) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }

  const accountExists = fs.existsSync(ACCOUNT_PATH);
  let cookieCount = 0;
  let accountBytes = 0;
  if (accountExists) {
    try {
      accountBytes = fs.statSync(ACCOUNT_PATH).size;
      const state = JSON.parse(fs.readFileSync(ACCOUNT_PATH, "utf8"));
      cookieCount = Array.isArray(state) ? state.length : 0;
    } catch (_) {}
  }
  const sessionState = global._botApi ? "online" : "offline";
  const activeState = accountExists ? path.basename(ACCOUNT_PATH) : "غير موجود";

  const lines = [
    "┌───────────────────────────┐",
    "│   🔐 حالة ملفات الحسابات   │",
    "└───────────────────────────┘",
    "",
    `✨ حالة الجلسة: ${sessionState}`,
    `📄 الملف الرئيسي: ${activeState}`,
    `🍪 الكوكيز المحفوظة: ${cookieCount}`,
    `📦 حجم الملف: ${(accountBytes / 1024).toFixed(1)} KB`,
    ""
  ];
  lines.push(`💡 لتحديث الجلسة: استخدم مسار حساب Djamel-Fca (${path.relative(process.cwd(), ACCOUNT_PATH)}).`);

  return api.sendMessage(lines.join("\n"), threadID, messageID);
};
