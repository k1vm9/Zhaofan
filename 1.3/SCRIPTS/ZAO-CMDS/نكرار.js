const fs = require("fs-extra");
const path = require("path");

const REPEAT_FILE = path.join(__dirname, "../../data/repeat-names.json");

function loadRepeatData() {
  try {
    fs.ensureDirSync(path.dirname(REPEAT_FILE));
    if (fs.existsSync(REPEAT_FILE)) {
      return JSON.parse(fs.readFileSync(REPEAT_FILE, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveRepeatData(data) {
  try {
    fs.ensureDirSync(path.dirname(REPEAT_FILE));
    fs.writeFileSync(REPEAT_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (_) {}
}

module.exports.config = {
  name: "تكرار",
  version: "2.0.0",
  hasPermssion: 2,
  credits: "نوت دفاين",
  description: "حماية اسم المجموعة — يستعيده فور تغييره",
  commandCategory: "نظام",
  usages: "تفعيل [اسم اختياري] | ايقاف",
  cooldowns: 0
};

module.exports.languages = {
  "vi": {},
  "en": {}
};

module.exports.onLoad = function () {
  global.repeatName = loadRepeatData();
};

// ── Fires on ALL group events (log:thread-name, etc.) ────────
// This now correctly fires because handleEvent.js dispatches
// group events to commands in eventRegistered as well.
module.exports.handleEvent = async function ({ api, event }) {
  try {
    const { threadID, isGroup, logMessageType, logMessageData } = event;
    if (!isGroup) return;
    if (logMessageType !== "log:thread-name") return;

    const entry = global.repeatName && global.repeatName[threadID];
    if (!entry || entry.status !== true) return;

    const savedName = entry.name;
    const newName = logMessageData?.name || logMessageData?.threadName;

    if (!savedName) return;
    if (newName && newName !== savedName) {
      try {
        await api.setTitle(savedName, threadID);
      } catch (_) {}
    }
  } catch (_) {}
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID, isGroup } = event;
  const args = event.body.trim().split(/ +/).slice(1);

  if (!isGroup) {
    return api.sendMessage("⛔ هذا الأمر للمجموعات فقط.", threadID, messageID);
  }

  if (!args[0]) {
    const entry = global.repeatName && global.repeatName[threadID];
    const status = entry && entry.status === true
      ? `✅ مفعّل — الاسم المحمي: "${entry.name}"`
      : "🔴 غير مفعّل";
    return api.sendMessage(
      `📌 حماية اسم المجموعة\nالحالة: ${status}\n\nالاستخدام:\nتكرار تفعيل\nتكرار تفعيل [اسم مخصص]\nتكرار ايقاف`,
      threadID, messageID
    );
  }

  if (!global.repeatName) global.repeatName = {};

  if (args[0] === "تفعيل") {
    const entry = global.repeatName[threadID];
    if (entry && entry.status === true) {
      return api.sendMessage(
        `⚠️ الحماية مفعّلة مسبقاً.\n📌 الاسم المحمي: "${entry.name}"\n\nلتغيير الاسم: تكرار ايقاف ثم تكرار تفعيل [الاسم الجديد]`,
        threadID, messageID
      );
    }

    const customName = args.slice(1).join(" ").trim();
    if (customName) {
      global.repeatName[threadID] = { name: customName, status: true };
      saveRepeatData(global.repeatName);
      return api.sendMessage(
        `✅ تم تفعيل حماية اسم المجموعة.\n🔒 الاسم المحمي: "${customName}"`,
        threadID, messageID
      );
    }

    // Auto-fetch current name
    api.sendMessage("⏳ جاري جلب اسم المجموعة...", threadID);
    try {
      const info = await new Promise((resolve, reject) => {
        api.getThreadInfo(threadID, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });

      const threadName = info?.threadName || info?.name;
      if (!threadName) {
        return api.sendMessage(
          "⚠️ لم أتمكن من جلب اسم المجموعة.\nاستخدم: تكرار تفعيل [الاسم]",
          threadID, messageID
        );
      }

      global.repeatName[threadID] = { name: threadName, status: true };
      saveRepeatData(global.repeatName);
      return api.sendMessage(
        `✅ تم تفعيل حماية اسم المجموعة.\n🔒 الاسم المحمي: "${threadName}"`,
        threadID, messageID
      );
    } catch (e) {
      return api.sendMessage(
        "⚠️ فشل جلب اسم المجموعة.\nاستخدم: تكرار تفعيل [الاسم]",
        threadID, messageID
      );
    }
  }

  if (args[0] === "ايقاف") {
    const entry = global.repeatName[threadID];
    if (!entry || entry.status === false) {
      return api.sendMessage("⚠️ الحماية غير مفعّلة أصلاً.", threadID, messageID);
    }
    global.repeatName[threadID].status = false;
    saveRepeatData(global.repeatName);
    return api.sendMessage("🔓 تم إيقاف حماية اسم المجموعة.", threadID, messageID);
  }

  return api.sendMessage(
    "📌 الاستخدام:\nتكرار تفعيل\nتكرار تفعيل [اسم مخصص]\nتكرار ايقاف",
    threadID, messageID
  );
};
