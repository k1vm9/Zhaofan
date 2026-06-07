'use strict';

// ─── محرك (Motor 1) for Instagram ────────────────────────────────────────────
// Sends a message to a thread at a fixed or random interval.
// Persists to data/insta-motor.json so settings survive restarts.

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'insta-motor.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadAll() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf-8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveAll(data) {
  try {
    const clean = {};
    for (const [tid, d] of Object.entries(data)) {
      clean[tid] = {
        status: d.status, message: d.message, time: d.time,
        randomTime: d.randomTime || false, randomRange: d.randomRange || null,
      };
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Global motor state ────────────────────────────────────────────────────────
if (!global._instaMotor1) global._instaMotor1 = loadAll();
const motorData = global._instaMotor1;

// Track active timers: threadId → timeoutId
if (!global._instaMotor1Timers) global._instaMotor1Timers = new Map();
const timers = global._instaMotor1Timers;

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseRange(rangeStr) {
  if (!rangeStr || !rangeStr.trim()) return { min: 12000, max: 50000 };
  const m = String(rangeStr).trim().match(/^([0-9.]+)(s|m)?-([0-9.]+)(s|m)?$/i);
  if (!m) return null;
  const toMs = (v, u) => {
    const n = parseFloat(v);
    if (isNaN(n) || n <= 0) return null;
    return u?.toLowerCase() === 'm' ? Math.round(n * 60000) : Math.round(n * 1000);
  };
  const min = toMs(m[1], m[2]), max = toMs(m[3], m[4]);
  if (!min || !max || min < 5000 || max <= min) return null;
  return { min, max };
}

function fmtTime(d) {
  if (d.randomTime && d.randomRange) {
    return `🎲 عشوائي ${d.randomRange.min/1000}s–${d.randomRange.max/1000}s`;
  }
  const ms = d.time || 30000;
  return ms >= 60000 ? `${(ms/60000).toFixed(1)}م` : `${(ms/1000).toFixed(0)}ث`;
}

function nextDelay(d) {
  if (d.randomTime && d.randomRange) {
    const { min, max } = d.randomRange;
    return Math.round(min + Math.random() * (max - min));
  }
  return d.time || 30000;
}

function ensureRow(threadId) {
  if (!motorData[threadId]) {
    motorData[threadId] = { status: false, message: null, time: null, randomTime: false, randomRange: null };
  }
  return motorData[threadId];
}

function startLoop(sendText, threadId) {
  const d = motorData[threadId];
  if (!d || !d.status || !d.message || !d.time) return;
  stopLoop(threadId);

  const tick = () => {
    const cur = motorData[threadId];
    if (!cur || !cur.status || !cur.message) return;
    sendText(threadId, cur.message).catch(() => {});
    timers.set(threadId, setTimeout(tick, nextDelay(cur)));
  };
  timers.set(threadId, setTimeout(tick, nextDelay(d)));
}

function stopLoop(threadId) {
  const t = timers.get(threadId);
  if (t) { clearTimeout(t); timers.delete(threadId); }
}

module.exports = {
  config: {
    name: 'محرك',
    aliases: ['motor', 'motor1', 'م1'],
    description: 'إرسال رسالة تلقائية لخيط إنستاغرام كل فترة زمنية محددة',
    usage: '!محرك تفعيل | ايقاف | رسالة [نص] | وقت [30s|2m|r] | حالة',
    adminOnly: true,
    category: 'إدارة',
  },

  // Called once when INSTA.js boots — revive any active motors
  onLoad({ sendText }) {
    const saved = loadAll();
    for (const [tid, d] of Object.entries(saved)) {
      motorData[tid] = { ...d, };
      if (d.status && d.message && d.time) startLoop(sendText, tid);
    }
  },

  run: async ({ event, reply, args, sendText, isAdmin }) => {
    if (!isAdmin) return reply('⛔ هذا الأمر للمشرفين فقط.');

    const threadId = event.threadID;
    const sub      = args[0];
    const data     = ensureRow(threadId);

    if (!sub) return reply(
      '📌 أوامر المحرك:\n' +
      '!محرك رسالة [النص]\n' +
      '!محرك وقت [30s | 2m | r]\n' +
      '!محرك وقت r [نطاق] — مثال: r 15-60\n' +
      '!محرك تفعيل\n' +
      '!محرك ايقاف\n' +
      '!محرك حالة'
    );

    // ── رسالة ──
    if (sub === 'رسالة') {
      const msg = args.slice(1).join(' ').trim();
      if (!msg) return reply('⚠️ اكتب الرسالة بعد الأمر.');
      data.message = msg;
      saveAll(motorData);
      return reply(`✅ تم حفظ الرسالة:\n"${msg}"\n💾 يبقى بعد إعادة التشغيل.`);
    }

    // ── وقت ──
    if (sub === 'وقت') {
      const raw = args.slice(1).join(' ').trim();
      if (!raw) return reply('⚠️ أمثلة:\n!محرك وقت 30s\n!محرك وقت 2m\n!محرك وقت r\n!محرك وقت r 15-60');

      if (raw.toLowerCase().startsWith('r')) {
        const range = parseRange(raw.slice(1).trim());
        if (!range) return reply('⚠️ صيغة غير صحيحة. مثال: r 15-60 أو r 20s-2m (الحد الأدنى 5s)');
        data.randomTime  = true;
        data.randomRange = range;
        data.time        = Math.round((range.min + range.max) / 2);
        saveAll(motorData);
        if (data.status) startLoop(sendText, threadId);
        return reply(`🎲 وقت عشوائي: ${range.min/1000}s–${range.max/1000}s\n💾 محفوظ.`);
      }

      let ms = 0;
      if (raw.endsWith('s'))      ms = parseFloat(raw) * 1000;
      else if (raw.endsWith('m')) ms = parseFloat(raw) * 60000;
      else return reply('⚠️ استخدم s للثواني أو m للدقائق. مثال: 30s أو 2m');
      if (ms < 5000) return reply('⚠️ الحد الأدنى 5 ثواني.');
      data.time        = ms;
      data.randomTime  = false;
      data.randomRange = null;
      saveAll(motorData);
      if (data.status) startLoop(sendText, threadId);
      return reply(`✅ الوقت: ${fmtTime(data)}\n💾 محفوظ.`);
    }

    // ── تفعيل ──
    if (sub === 'تفعيل') {
      if (data.status)    return reply('⚠️ المحرك مفعل مسبقاً.');
      if (!data.message)  return reply('⚠️ حدد الرسالة أولاً: !محرك رسالة [النص]');
      if (!data.time)     return reply('⚠️ حدد الوقت أولاً: !محرك وقت [30s]');
      data.status = true;
      startLoop(sendText, threadId);
      saveAll(motorData);
      return reply(`✅ المحرك مفعل!\n📝 "${data.message}"\n⏱ ${fmtTime(data)}`);
    }

    // ── ايقاف ──
    if (sub === 'ايقاف') {
      if (!data.status) return reply('⚠️ المحرك غير مفعل أصلاً.');
      data.status = false;
      stopLoop(threadId);
      saveAll(motorData);
      return reply('🔴 تم إيقاف المحرك.\n💾 سيبقى موقوفاً بعد إعادة التشغيل.');
    }

    // ── حالة ──
    if (sub === 'حالة') {
      const active = Object.entries(motorData).filter(([, d]) => d.status);
      if (!active.length) return reply('📊 المحرك\n\n⚫ لا توجد خيوط نشطة حالياً.');
      let msg = `📊 المحرك — ${active.length} خيط نشط\n${'━'.repeat(18)}\n`;
      for (const [tid, d] of active) {
        const isCurrent = tid === threadId;
        msg += `\n${isCurrent ? '▶️' : '🟢'} ${tid.slice(-8)}\n`;
        msg += `   📝 "${(d.message || '').slice(0, 30)}"\n`;
        msg += `   ⏱ ${fmtTime(d)}\n`;
      }
      return reply(msg.trim());
    }

    return reply('❓ استخدم: !محرك للمساعدة');
  },
};
