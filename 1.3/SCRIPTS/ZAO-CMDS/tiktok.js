const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");

const CACHE_DIR = path.join(__dirname, "cache");

const TIKTOK_APIS = [
  url => `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
  url => `https://api.tikhub.io/api/v1/tiktok/app/v2/fetch_one_video?aweme_id=${url}`
];

const SEARCH_API = url => `https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(url)}&count=6&cursor=0&HD=1`;

module.exports.config = {
  name: "تيكتوك",
  aliases: ["tiktok", "tt", "tk"],
  version: "2.0.0",
  hasPermssion: 0,
  credits: "ZAO Team",
  description: "تحميل فيديو تيكتوك أو البحث عن مقاطع",
  commandCategory: "ميديا",
  usages: "تيكتوك [رابط أو كلمة بحث]",
  cooldowns: 8
};

async function downloadDirect(tiktokUrl) {
  const res = await axios.get(TIKTOK_APIS[0](tiktokUrl), { timeout: 20000 });
  if (res.data?.code === 0 && res.data?.data?.play) {
    return {
      downloadUrl: res.data.data.play,
      title: res.data.data.title || "TikTok Video",
      author: res.data.data.author?.nickname || "Unknown"
    };
  }
  throw new Error("فشل في تحميل الرابط المباشر");
}

async function searchVideos(query) {
  const res = await axios.get(SEARCH_API(query), { timeout: 20000 });
  if (res.data?.code === 0 && Array.isArray(res.data?.data?.videos)) {
    return res.data.data.videos.slice(0, 6).map(v => ({
      id: v.video_id || v.id,
      title: v.title || "بدون عنوان",
      author: v.author?.nickname || "Unknown",
      play: v.play || v.wmplay,
      cover: v.cover,
      duration: v.duration || 0
    }));
  }
  throw new Error("لم يتم إيجاد نتائج");
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const query = args.join(" ").trim();

  if (!query) {
    return api.sendMessage(
      "🎵 استخدم:\n.تيكتوك [رابط] — لتحميل فيديو مباشرة\n.تيكتوك [كلمة بحث] — للبحث عن مقاطع",
      threadID,
      messageID
    );
  }

  await fs.ensureDir(CACHE_DIR);
  api.setMessageReaction("⏳", messageID, () => {}, true);

  const isTikTokLink = /tiktok\.com\//i.test(query) || /vm\.tiktok|vt\.tiktok/i.test(query);

  if (isTikTokLink) {
    const outPath = path.join(CACHE_DIR, `tiktok_${Date.now()}.mp4`);
    try {
      const { downloadUrl, title, author } = await downloadDirect(query);

      const vidRes = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        timeout: 120000,
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      await fs.outputFile(outPath, Buffer.from(vidRes.data));

      api.setMessageReaction("✅", messageID, () => {}, true);

      return api.sendMessage(
        {
          body: `🎵 ${title}\n👤 ${author}`,
          attachment: fs.createReadStream(outPath)
        },
        threadID,
        () => { try { fs.unlinkSync(outPath); } catch (_) {} },
        messageID
      );

    } catch (e) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
      return api.sendMessage(`❌ خطأ: ${e.message}`, threadID, messageID);
    }
  }

  try {
    const videos = await searchVideos(query);

    if (!videos.length) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      return api.sendMessage("❌ لم يتم إيجاد نتائج لبحثك", threadID, messageID);
    }

    let body = `🔍 نتائج البحث عن: "${query}"\n\n`;
    videos.forEach((v, i) => {
      body += `${i + 1}️⃣ ${v.title.slice(0, 50)}\n`;
      body += `   👤 ${v.author} | ⏱ ${v.duration}s\n\n`;
    });
    body += `↩️ رد بالرقم (1-${videos.length}) لتحميل الفيديو`;

    api.setMessageReaction("✅", messageID, () => {}, true);

    api.sendMessage(body, threadID, (err, info) => {
      if (err || !info) return;
      global.client.handleReply.push({
        name: "تيكتوك",
        messageID: info.messageID,
        author: senderID,
        videos
      });
    }, messageID);

  } catch (e) {
    api.setMessageReaction("❌", messageID, () => {}, true);
    return api.sendMessage(`❌ خطأ في البحث: ${e.message}`, threadID, messageID);
  }
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, messageID, senderID, body } = event;

  if (handleReply.author !== senderID) return;

  const choose = parseInt(body.trim());
  const { videos } = handleReply;

  if (isNaN(choose) || choose < 1 || choose > videos.length) {
    return api.sendMessage(`❌ أدخل رقماً بين 1 و${videos.length}`, threadID, messageID);
  }

  const video = videos[choose - 1];
  api.setMessageReaction("⏳", messageID, () => {}, true);

  await fs.ensureDir(CACHE_DIR);
  const outPath = path.join(CACHE_DIR, `tiktok_${Date.now()}.mp4`);

  try {
    const vidRes = await axios.get(video.play, {
      responseType: "arraybuffer",
      timeout: 120000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    await fs.outputFile(outPath, Buffer.from(vidRes.data));

    api.setMessageReaction("✅", messageID, () => {}, true);

    return api.sendMessage(
      {
        body: `🎵 ${video.title}\n👤 ${video.author}`,
        attachment: fs.createReadStream(outPath)
      },
      threadID,
      () => { try { fs.unlinkSync(outPath); } catch (_) {} },
      messageID
    );

  } catch (e) {
    api.setMessageReaction("❌", messageID, () => {}, true);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    return api.sendMessage(`❌ فشل تحميل الفيديو: ${e.message}`, threadID, messageID);
  }
};
