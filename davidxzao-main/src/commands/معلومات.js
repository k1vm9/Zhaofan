const os     = require("os");
const moment = require("moment-timezone");

module.exports.config = {
  name: "معلومات",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "معلومات شاملة عن البوت",
  commandCategory: "النظام",
  usages: "معلومات",
  cooldowns: 5
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  const uid   = api.getCurrentUserID ? api.getCurrentUserID() : "—";
  const upSec = Math.floor(process.uptime());
  const h     = Math.floor(upSec / 3600);
  const m     = Math.floor((upSec % 3600) / 60);
  const s     = upSec % 60;

  const cmdCount    = global.client?.commands?.size ?? "—";
  const threadCount = global.data?.allThreadID?.length ?? "—";
  const botName     = global.config?.BOTNAME || global.config?.BOT_NAME || "ZAO";
  const prefix      = global.config?.PREFIX  || ".";
  const adminCount  = (global.config?.ADMINBOT || []).length;

  const tier        = global.activeAccountTier  || "—";
  const loginMethod = global.loginMethod         || "—";
  const methodLabel = loginMethod === "credentials"
    ? "📧 بريد + كلمة مرور"
    : loginMethod === "appstate-alt"
    ? "🍪 كوكيز (alt)"
    : "🍪 كوكيز (رئيسي)";

  const freeMem  = (os.freemem()  / 1024 / 1024).toFixed(0);
  const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
  const usedMem  = totalMem - freeMem;
  const memPct   = Math.round((usedMem / totalMem) * 100);

  const nowCairo = moment.tz("Africa/Cairo").format("HH:mm:ss — DD/MM/YYYY");

  const lines = [
    "╔══════════════════════════╗",
    `║   🤖 بوت ${botName}   ║`,
    "╚══════════════════════════╝",
    "",
    `🆔 معرف البوت: ${uid}`,
    `🏷️  الاسم: ${botName}`,
    `🔣 البادئة: ${prefix}`,
    "",
    `⏳ وقت التشغيل: ${h}س ${m}د ${s}ث`,
    `📅 الوقت: ${nowCairo}`,
    "",
    `📦 الأوامر: ${cmdCount} أمر`,
    `💬 المحادثات: ${threadCount}`,
    `👑 الأدمن: ${adminCount}`,
    "",
    `🔑 طريقة الدخول: ${methodLabel}`,
    `📊 الطبقة النشطة: ${tier}`,
    "",
    `💾 الرام: ${usedMem}MB / ${totalMem}MB (${memPct}%)`,
    `🖥️  ${os.type()} | ${os.cpus().length} أنوية`,
  ];

  return api.sendMessage(lines.join("\n"), threadID, messageID);
};
