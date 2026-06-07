const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");

const CACHE_DIR = path.join(__dirname, "cache");
const PIN_API   = (q, n) => `https://betadash-api-swordslush-production.up.railway.app/pinterest?search=${encodeURIComponent(q)}&count=${n}`;

const DEFAULT_COUNT = 5;
const MAX_COUNT     = 10;

module.exports.config = {
  name: "بنترست",
  aliases: ["pinterest", "pin", "pint"],
  version: "2.0.0",
  hasPermssion: 0,
  credits: "nexo_here • ported by ZAO Team",
  description: "البحث في بنترست وإرسال الصور",
  commandCategory: "ميديا",
  usages: "بنترست [كلمة البحث] | [العدد]",
  cooldowns: 5
};

async function fetchImages(query, count) {
  const res = await axios.get(PIN_API(query, count), { timeout: 25000 });
  const list = res.data?.data;
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.filter(u => typeof u === "string" && /^https?:\/\//.test(u));
}

async function downloadOne(url, outPath) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  await fs.outputFile(outPath, Buffer.from(res.data));
  return outPath;
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;

  // Allow "بنترست naruto | 6" — split on the last `|` for a count override.
  let raw = args.join(" ").trim();
  if (!raw) {
    return api.sendMessage(
      "📌 الاستخدام: بنترست [كلمة البحث] | [العدد]\nمثال: بنترست ناروتو | 5",
      threadID,
      messageID
    );
  }

  let count = DEFAULT_COUNT;
  const pipeIdx = raw.lastIndexOf("|");
  if (pipeIdx !== -1) {
    const tail = raw.slice(pipeIdx + 1).trim();
    const n = parseInt(tail, 10);
    if (!isNaN(n) && n > 0) {
      count = Math.min(n, MAX_COUNT);
      raw   = raw.slice(0, pipeIdx).trim();
    }
  }

  if (!raw) {
    return api.sendMessage(
      "❗ يرجى إدخال كلمة البحث.\nمثال: بنترست ناروتو | 5",
      threadID,
      messageID
    );
  }

  await fs.ensureDir(CACHE_DIR);
  api.setMessageReaction("⏳", messageID, () => {}, true);

  const stamp     = Date.now();
  const downloads = [];

  try {
    const images = await fetchImages(raw, count);
    if (!images.length) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      return api.sendMessage(`❌ لا توجد نتائج لبحث: "${raw}"`, threadID, messageID);
    }

    const slice = images.slice(0, count);

    // Download in parallel — way faster than the original sequential loop,
    // and per-image failures don't kill the whole batch.
    const settled = await Promise.allSettled(
      slice.map((url, i) => {
        const outPath = path.join(CACHE_DIR, `pin_${stamp}_${i}.jpg`);
        downloads.push(outPath);
        return downloadOne(url, outPath);
      })
    );

    const ready = settled
      .map((r, i) => (r.status === "fulfilled" ? downloads[i] : null))
      .filter(Boolean);

    if (!ready.length) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      return api.sendMessage("❌ تعذّر تحميل أي صورة من النتائج.", threadID, messageID);
    }

    api.setMessageReaction("✅", messageID, () => {}, true);

    return api.sendMessage(
      {
        body: `🔍 نتائج بنترست عن: "${raw}"\n📦 الصور: ${ready.length}/${slice.length}`,
        attachment: ready.map(p => fs.createReadStream(p))
      },
      threadID,
      () => {
        // [FIX] Cleanup ALL temp files (including failed downloads), not just
        // the ones we sent — otherwise partial failures leak into cache/.
        for (const p of downloads) {
          try { fs.unlinkSync(p); } catch (_) {}
        }
      },
      messageID
    );

  } catch (err) {
    api.setMessageReaction("❌", messageID, () => {}, true);
    for (const p of downloads) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    const reason = err.response?.status
      ? `HTTP ${err.response.status}`
      : (err.message || "خطأ غير معروف");
    try {
      if (typeof global.loggeryuki?.warn === "function") {
        global.loggeryuki.warn(`[pinterest] ${reason}`);
      }
    } catch (_) {}
    return api.sendMessage(`🚫 خطأ في جلب نتائج بنترست: ${reason}`, threadID, messageID);
  }
};
