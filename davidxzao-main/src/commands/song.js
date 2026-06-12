'use strict';
/**
 * song.js — تحميل أغاني من يوتيوب  v7.0
 * ==========================================
 * لا يستخدم ytdl-core مطلقاً — يعمل على Railway و Replit و Render.
 *
 * سلسلة الاحتياط (Fallback chain):
 *  1. nixhost API  — أسرع وأكثر موثوقية
 *  2. baby-apis    — احتياط (نفس المطوّر)
 *  3. alldl API    — احتياط ثالث
 *  4. play-dl      — تحميل مباشر من YouTube CDN (بدون IP محدود)
 */

const fs   = require('fs-extra');
const path = require('path');
const axios = require('axios');

const CACHE_DIR        = path.join(__dirname, 'cache');
const MAX_BYTES        = 25 * 1024 * 1024;   // 25 MB — Messenger limit
const MAX_DURATION_SEC = 20 * 60;            // 20 minutes
const BROWSER_UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Cached config from aryannix (TTL 30 min) ─────────────────────────────────
let _cfgCache = { data: null, ts: 0 };

async function _getConfig() {
  const now = Date.now();
  if (_cfgCache.data && now - _cfgCache.ts < 30 * 60 * 1000) return _cfgCache.data;
  const r = await axios.get('https://raw.githubusercontent.com/aryannix/stuffs/master/raw/apis.json', {
    timeout: 8000, headers: { 'User-Agent': BROWSER_UA }
  });
  if (!r.data) throw new Error('config empty');
  _cfgCache = { data: r.data, ts: now };
  return r.data;
}

// ── API 1: nixhost (primary, fastest) ────────────────────────────────────────
async function _nixhostDl(videoUrl) {
  const r = await axios.get('https://api.nixhost.top/aryan/ytdl', {
    params: { url: videoUrl, type: 'audio' },
    timeout: 30000,
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!r.data?.status || !r.data?.downloadUrl) throw new Error('nixhost: no downloadUrl');
  return { url: r.data.downloadUrl, title: r.data.title || null };
}

// ── API 2: baby-apis (fallback from same config) ──────────────────────────────
async function _babyApiDl(videoUrl) {
  const cfg  = await _getConfig();
  const base = cfg.baby || 'https://baby-apisx.vercel.app';
  const r    = await axios.get(`${base}/ytdl`, {
    params:  { url: videoUrl, type: 'audio' },
    timeout: 30000,
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!r.data?.status || !r.data?.downloadUrl) throw new Error('baby-api: no downloadUrl');
  return { url: r.data.downloadUrl, title: r.data.title || null };
}

// ── API 3: alldl (fallback) ───────────────────────────────────────────────────
async function _alldlDl(videoUrl) {
  const cfg  = await _getConfig();
  const base = cfg.alldl || 'https://aryan-video-downloader.vercel.app';
  const r    = await axios.get(`${base}/ytdl`, {
    params:  { url: videoUrl, type: 'audio' },
    timeout: 35000,
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!r.data?.status || !r.data?.downloadUrl) throw new Error('alldl: no downloadUrl');
  return { url: r.data.downloadUrl, title: r.data.title || null };
}

// ── API 4: play-dl (pure stream — no ytdl dependency, no blocked IPs) ─────────
async function _playdlDl(videoUrl, outPath) {
  let play;
  try { play = require('play-dl'); } catch (_) { throw new Error('play-dl not installed'); }

  const info = await play.video_info(videoUrl);
  if (!info?.video_details) throw new Error('play-dl: no video info');

  const stream = await play.stream(videoUrl, { quality: 2 });
  if (!stream?.stream) throw new Error('play-dl: no stream');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    let total = 0;
    stream.stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        stream.stream.destroy(new Error('file too large'));
      }
    });
    stream.stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.stream.pipe(out);
  });

  return { url: null, title: info.video_details.title || null, direct: true };
}

// ── Download a URL to file ────────────────────────────────────────────────────
async function _download(url, outPath) {
  const res = await axios.get(url, {
    responseType:   'stream',
    timeout:        180_000,
    maxRedirects:   8,
    headers:        { 'User-Agent': BROWSER_UA },
  });

  const len = parseInt(res.headers['content-length'] || '0', 10);
  if (len && len > MAX_BYTES) {
    res.data.destroy();
    throw new Error('file too large');
  }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    let total = 0, aborted = false;

    const kill = setTimeout(() => {
      aborted = true;
      try { res.data.destroy(); } catch (_) {}
      try { out.destroy(new Error('download timeout')); } catch (_) {}
    }, 180_000);

    res.data.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        aborted = true;
        try { res.data.destroy(); } catch (_) {}
        try { out.destroy(new Error('file too large')); } catch (_) {}
      }
    });
    res.data.on('error', (e) => { clearTimeout(kill); out.destroy(e); reject(e); });
    out.on('finish', () => { clearTimeout(kill); if (aborted) return reject(new Error('aborted')); resolve(); });
    out.on('error', (e) => { clearTimeout(kill); reject(e); });
    res.data.pipe(out);
  });
}

// ── YouTube search via yt-search (with 3-attempt retry) ──────────────────────
async function _search(query) {
  const yts = require('yt-search');
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await yts(query);
      const v = r?.videos?.[0];
      if (!v?.url) throw new Error('لم يُعثر على النتيجة');
      return { url: v.url, title: v.title || query, seconds: v.seconds || 0 };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  }
  throw lastErr;
}

function _videoId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports.config = {
  name:            'song',
  aliases:         ['music', 'play', 'أغنية', 'اغنية'],
  version:         '7.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team',
  description:     'تحميل أغنية من يوتيوب (يعمل على Railway بدون ytdl)',
  commandCategory: 'ميديا',
  usages:          'song [اسم الأغنية أو رابط يوتيوب]',
  cooldowns:       15,
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const query = args.join(' ').trim();

  if (!query) {
    return api.sendMessage(
      '🎵 أرسل اسم الأغنية أو رابط يوتيوب.\nمثال: .song faded alan walker',
      threadID, messageID
    );
  }

  api.setMessageReaction('⏳', messageID, () => {}, true);
  await fs.ensureDir(CACHE_DIR);

  const outPath = path.join(CACHE_DIR, `song_${Date.now()}.mp3`);

  try {
    // ── 1. Resolve video URL ───────────────────────────────────────────────────
    let videoUrl = query;
    let title    = query;
    let seconds  = 0;

    const isYtLink = /youtu(be\.com|\.be)\//i.test(query);
    if (!isYtLink) {
      const found = await _search(query);
      videoUrl = found.url;
      title    = found.title;
      seconds  = found.seconds;
    } else {
      const id = _videoId(videoUrl);
      if (id) videoUrl = `https://www.youtube.com/watch?v=${id}`;
    }

    if (seconds && seconds > MAX_DURATION_SEC) {
      throw new Error('الأغنية طويلة جداً (أكثر من 20 دقيقة)');
    }

    api.sendMessage(`🔍 جاري تحميل: ${title}`, threadID, messageID);

    // ── 2. Try download APIs in order ─────────────────────────────────────────
    let downloadUrl = null;
    const APIS = [
      { name: 'nixhost',  fn: () => _nixhostDl(videoUrl) },
      { name: 'baby-api', fn: () => _babyApiDl(videoUrl) },
      { name: 'alldl',    fn: () => _alldlDl(videoUrl) },
    ];

    let info      = null;
    let usedDirect = false;

    for (const api_item of APIS) {
      try {
        info = await api_item.fn();
        if (info.url) { downloadUrl = info.url; break; }
      } catch (e) {
        console.log(`[SONG] ${api_item.name} failed: ${e.message}`);
      }
    }

    if (!downloadUrl) {
      // ── 3. Fallback: play-dl direct stream ────────────────────────────────
      try {
        await _playdlDl(videoUrl, outPath);
        usedDirect = true;
        if (!info) info = {};
      } catch (e) {
        console.log(`[SONG] play-dl failed: ${e.message}`);
        throw new Error('all download methods failed: ' + e.message);
      }
    }

    if (!usedDirect) {
      if (info?.title) title = info.title;
      await _download(downloadUrl, outPath);
    }

    // ── 4. Validate file ──────────────────────────────────────────────────────
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 8000) {
      throw new Error('الملف الصوتي فارغ أو تالف');
    }
    if (fs.statSync(outPath).size > MAX_BYTES) {
      throw new Error('file too large');
    }

    api.setMessageReaction('✅', messageID, () => {}, true);

    return api.sendMessage(
      {
        body:       `🎵 ${title}\n🔗 ${videoUrl}`,
        attachment: fs.createReadStream(outPath),
      },
      threadID,
      () => { try { fs.unlinkSync(outPath); } catch (_) {} },
      messageID
    );

  } catch (e) {
    api.setMessageReaction('❌', messageID, () => {}, true);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}

    const msg = String(e?.message || e);
    const friendly =
      msg.includes('file too large')       ? '❌ الملف كبير جداً. جرب أغنية أقصر.' :
      msg.includes('download timeout')     ? '❌ استغرق التحميل وقتاً طويلاً. جرب مرة أخرى.' :
      /طويلة جداً/.test(msg)               ? `❌ ${msg}` :
      /لم يُعثر/.test(msg)                 ? `❌ ${msg}` :
      /sign[- ]?in|login|age|confirm/i.test(msg) ? '❌ الفيديو يتطلب تسجيل دخول أو محجوب بالعمر.' :
      /unavailable|private|removed/i.test(msg)   ? '❌ الفيديو غير متاح.' :
      /all download methods failed/.test(msg)     ? '❌ فشلت جميع خدمات التحميل. جرب لاحقاً أو جرب أغنية أخرى.' :
      `❌ خطأ: ${msg.slice(0, 120)}`;

    return api.sendMessage(friendly, threadID, messageID);
  }
};
