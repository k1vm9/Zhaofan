const fs   = require("fs-extra");
const path = require("path");

// Folders that fill up over time and are safe to wipe.
// Each entry: directory path + optional `keep` regex of files to preserve.
const TARGETS = [
  { dir: path.join(process.cwd(), "cache") },
  { dir: path.join(process.cwd(), "SCRIPTS", "ZAO-CMDS", "cache") },
  { dir: path.join(process.cwd(), "SCRIPTS", "Old-Commands", "cache") },
  { dir: path.join(process.cwd(), ".cache") }
];

const PROTECTED = new Set([
  "ZAO-STATE.json", "ZAO-STATEX.json", "ZAO-STATEV.json",
  "alt.json", "altx.json", "altv.json",
  "ZAO-STATEC.json", "ZAO-STATEXC.json", "ZAO-STATEVC.json",
  "ZAO-SETTINGS.json", "fca-config.json"
]);

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function cleanDir(dir) {
  let removedFiles = 0;
  let removedBytes = 0;
  if (!(await fs.pathExists(dir))) return { removedFiles, removedBytes };

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (PROTECTED.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    try {
      const st = await fs.stat(full);
      const size = ent.isDirectory() ? await dirSize(full) : st.size;
      await fs.remove(full);
      removedFiles += 1;
      removedBytes += size;
    } catch (_) {}
  }
  return { removedFiles, removedBytes };
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      try {
        if (ent.isDirectory()) stack.push(full);
        else {
          const st = await fs.stat(full);
          total += st.size;
        }
      } catch (_) {}
    }
  }
  return total;
}

module.exports.config = {
  name: "تنظيف",
  aliases: ["clean", "cleanup", "clear-cache"],
  version: "1.0.0",
  hasPermssion: 2,
  credits: "ZAO Team",
  description: "تنظيف ذاكرة التخزين المؤقت (الأغاني، الفيديوهات، الصور المحملة)",
  commandCategory: "النظام",
  usages: "تنظيف",
  cooldowns: 10
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID } = event;

  const adminIDs = (global.config?.ADMINBOT || []).map(String);
  if (!adminIDs.includes(String(senderID))) {
    return api.sendMessage("⛔ هذا الأمر خاص بأدمن البوت فقط.", threadID, messageID);
  }

  api.setMessageReaction("⏳", messageID, () => {}, true);

  const memBefore = process.memoryUsage().heapUsed;

  const results = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const t of TARGETS) {
    const r = await cleanDir(t.dir).catch(() => ({ removedFiles: 0, removedBytes: 0 }));
    if (r.removedFiles > 0 || r.removedBytes > 0) {
      results.push({
        dir: path.relative(process.cwd(), t.dir) || t.dir,
        files: r.removedFiles,
        bytes: r.removedBytes
      });
    }
    totalFiles += r.removedFiles;
    totalBytes += r.removedBytes;
  }

  // Force a GC pass if --expose-gc is on; harmless otherwise.
  let memFreed = 0;
  try {
    if (typeof global.gc === "function") {
      global.gc();
      memFreed = Math.max(0, memBefore - process.memoryUsage().heapUsed);
    }
  } catch (_) {}

  api.setMessageReaction("✅", messageID, () => {}, true);

  const lines = [
    "🧹 تم تنظيف الذاكرة المؤقتة",
    "━━━━━━━━━━━━━━━━━━━━━",
    ""
  ];
  if (results.length === 0) {
    lines.push("✨ لا توجد ملفات للحذف — البوت نظيف بالفعل.");
  } else {
    for (const r of results) {
      lines.push(`📁 ${r.dir}`);
      lines.push(`   ${r.files} ملف — ${fmtBytes(r.bytes)}`);
    }
    lines.push("");
    lines.push(`📊 الإجمالي: ${totalFiles} ملف — ${fmtBytes(totalBytes)}`);
  }
  if (memFreed > 0) {
    lines.push(`🧠 ذاكرة محررة: ${fmtBytes(memFreed)}`);
  }

  return api.sendMessage(lines.join("\n"), threadID, messageID);
};
