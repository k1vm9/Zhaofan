const fs   = require("fs-extra");
const path = require("path");

module.exports.config = {
  name: "حسابات",
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO",
  description: "عرض حالة ملفات الحسابات الثلاثة (كوكيز / كريدز / الحساب النشط)",
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

  const cwd = process.cwd();

  const TIERS = [
    {
      tier: 1,
      stateFile:  "ZAO-STATE.json",
      altFile:    "alt.json",
      credsFile:  "ZAO-STATEC.json"
    },
    {
      tier: 2,
      stateFile:  "ZAO-STATEX.json",
      altFile:    "altx.json",
      credsFile:  "ZAO-STATEXC.json"
    },
    {
      tier: 3,
      stateFile:  "ZAO-STATEV.json",
      altFile:    "altv.json",
      credsFile:  "ZAO-STATEVC.json"
    }
  ];

  function fileInfo(filename) {
    const full = path.join(cwd, filename);
    try {
      if (!fs.existsSync(full)) return "❌ غير موجود";
      const stat = fs.statSync(full);
      const kb   = (stat.size / 1024).toFixed(1);
      if (stat.size < 10) return `⚠️ فارغ (${kb}KB)`;
      return `✅ موجود (${kb}KB)`;
    } catch (_) {
      return "⚠️ خطأ في القراءة";
    }
  }

  const activeTier   = global.activeAccountTier || "—";
  const loginMethod  = global.loginMethod        || "—";
  const activeState  = global.activeStateFile    ? path.basename(global.activeStateFile)  : "—";
  const activeAlt    = global.activeAltFile       ? path.basename(global.activeAltFile)    : "—";

  const methodLabel  = loginMethod === "credentials"
    ? "📧 بريد + كلمة مرور"
    : loginMethod === "appstate-alt"
    ? "🍪 كوكيز (alt)"
    : loginMethod === "appstate"
    ? "🍪 كوكيز (رئيسي)"
    : loginMethod;

  const lines = [
    "┌───────────────────────────┐",
    "│   🔐 حالة ملفات الحسابات   │",
    "└───────────────────────────┘",
    "",
    `✨ الحساب النشط: الطبقة ${activeTier}`,
    `🔑 طريقة الدخول: ${methodLabel}`,
    `📄 الملف الرئيسي: ${activeState}`,
    `📄 الملف الاحتياطي: ${activeAlt}`,
    ""
  ];

  for (const t of TIERS) {
    const isActive = (t.tier === activeTier);
    const mark = isActive ? "◀ نشط" : "";
    lines.push(`${isActive ? "🟢" : "⚪"} ──── الطبقة ${t.tier} ${mark} ────`);
    lines.push(`   🍪 ${t.stateFile}: ${fileInfo(t.stateFile)}`);
    lines.push(`   🍪 ${t.altFile}: ${fileInfo(t.altFile)}`);
    lines.push(`   📧 ${t.credsFile}: ${fileInfo(t.credsFile)}`);
    lines.push("");
  }

  lines.push("💡 لإضافة كوكيز: استخدم الباحة أو ملف ZAO-STATE.json");
  lines.push("💡 لإضافة كريدز: أنشئ ملف ZAO-STATEC.json بصيغة:");
  lines.push('   {"email":"...","password":"..."}');

  return api.sendMessage(lines.join("\n"), threadID, messageID);
};
