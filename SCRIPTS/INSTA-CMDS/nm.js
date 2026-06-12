'use strict';

// ─── nm — Thread Name Locker for Instagram ────────────────────────────────────
// Periodically re-applies a locked thread title using Instagram's private API.
// Note: Instagram only supports renaming GROUP threads (not DMs).
// Persists to data/insta-nm.json so locks survive restarts.

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'insta-nm.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadAll() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf-8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveAll(locks) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(locks, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._instaNmLocks)   global._instaNmLocks   = loadAll();
if (!global._instaNmNextAt)  global._instaNmNextAt  = new Map();

const locks = global._instaNmLocks;

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseRange(rangeStr) {
  if (!rangeStr || !rangeStr.trim()) return { min: 6000, max: 30000 };
  const m = String(rangeStr).trim().match(/^([0-9.]+)(s|m)?-([0-9.]+)(s|m)?$/i);
  if (!m) return null;
  const toMs = (v, u) => {
    const n = parseFloat(v);
    if (isNaN(n) || n <= 0) return null;
    return u?.toLowerCase() === 'm' ? Math.round(n * 60000) : Math.round(n * 1000);
  };
  const min = toMs(m[1], m[2]), max = toMs(m[3], m[4]);
  if (!min || !max || min < 1000 || max <= min) return null;
  return { min, max };
}

function nextDelay(lock) {
  if (lock.randomTime && lock.randomRange) {
    const { min, max } = lock.randomRange;
    return Math.round(min + Math.random() * (max - min));
  }
  return lock.time || 6000;
}

function fmtTime(lock) {
  if (lock.randomTime && lock.randomRange) {
    return `🎲 عشوائي ${lock.randomRange.min/1000}s–${lock.randomRange.max/1000}s`;
  }
  const ms = lock.time || 6000;
  return ms >= 60000 ? `${(ms/60000).toFixed(1)}م` : `${(ms/1000).toFixed(1)}ث`;
}

// Apply the locked name via Instagram API
async function applyName(ig, threadId, name) {
  // instagram-private-api: ig.direct.updateThreadTitle(threadId, title)
  await ig.direct.updateThreadTitle(threadId, name);
}

// ── Global sweep timer ────────────────────────────────────────────────────────
function startSweep(ig) {
  if (global._instaNmSweep) return;

  global._instaNmSweep = setInterval(async () => {
    if (!ig) return;
    const now = Date.now();
    for (const [threadId, lock] of Object.entries(locks)) {
      if (!lock || !lock.name) continue;
      const nextAt = global._instaNmNextAt.get(threadId) || 0;
      if (now < nextAt) continue;

      try {
        await applyName(ig, threadId, lock.name);
      } catch (e) {
        const msg = String(e?.message || e).toLowerCase();
        if (msg.includes('not a participant') || msg.includes('thread') && msg.includes('not found')) {
          delete locks[threadId];
          saveAll(locks);
          global._instaNmNextAt.delete(threadId);
          continue;
        }
      }

      global._instaNmNextAt.set(threadId, Date.now() + nextDelay(lock));
    }
  }, 1000);
  if (typeof global._instaNmSweep.unref === 'function') global._instaNmSweep.unref();
}

module.exports = {
  config: {
    name: 'nm',
    aliases: ['اسم', 'namelock', 'قفل_اسم'],
    description: 'قفل اسم مجموعة إنستاغرام ومنع تغييره',
    usage: '!nm تفعيل [الاسم] | ايقاف | وقت [6s|r] | حالة | قائمة | تنظيف',
    adminOnly: true,
    category: 'إدارة',
  },

  onLoad({ ig }) {
    if (ig) startSweep(ig);
  },

  run: async ({ ig, event, reply, args, isAdmin }) => {
    if (!isAdmin) return reply('⛔ هذا الأمر للمشرفين فقط.');
    if (!event.isGroup) return reply('⚠️ هذا الأمر يعمل فقط في المجموعات.');

    // Start sweep if not already started
    startSweep(ig);

    const threadId = event.threadID;
    const action   = args[0];

    const helpMsg =
      '📌 أوامر nm:\n' +
      '• !nm تفعيل [الاسم] — قفل اسم المجموعة\n' +
      '• !nm ايقاف — إيقاف القفل\n' +
      '• !nm وقت [قيمة] — ضبط فترة إعادة التطبيق\n' +
      '  مثال: !nm وقت 10s | !nm وقت 2m\n' +
      '  🎲 عشوائي: !nm وقت r | !nm وقت r 5-20\n' +
      '• !nm حالة — حالة هذا الخيط\n' +
      '• !nm قائمة — جميع الخيوط المقفولة\n' +
      '• !nm تنظيف — حذف جميع الأقفال';

    if (!action) return reply(helpMsg);

    // ── تفعيل ──
    if (action === 'تفعيل') {
      const name = args.slice(1).join(' ').trim();
      if (!name) return reply('⚠️ أدخل الاسم.\nمثال: !nm تفعيل اسم المجموعة');

      try { await applyName(ig, threadId, name); } catch (e) {
        return reply(`❌ فشل تغيير الاسم: ${e.message?.slice(0, 80)}`);
      }

      const existing = locks[threadId] || {};
      locks[threadId] = {
        name,
        time:        existing.time        || 6000,
        randomTime:  existing.randomTime  || false,
        randomRange: existing.randomRange || null,
      };
      saveAll(locks);
      global._instaNmNextAt.set(threadId, Date.now() + nextDelay(locks[threadId]));
      return reply(
        `🔒 تم قفل اسم المجموعة:\n"${name}"\n⏱ فترة إعادة التطبيق: ${fmtTime(locks[threadId])}`
      );
    }

    // ── ايقاف ──
    if (action === 'ايقاف') {
      if (!locks[threadId]) return reply('⚠️ لا يوجد قفل مفعل في هذه المجموعة.');
      delete locks[threadId];
      global._instaNmNextAt.delete(threadId);
      saveAll(locks);
      return reply('🔓 تم إيقاف قفل اسم المجموعة.\n💾 محفوظ.');
    }

    // ── وقت ──
    if (action === 'وقت') {
      const lock = locks[threadId];
      if (!lock) return reply('⚠️ فعّل القفل أولاً: !nm تفعيل [الاسم]');
      const raw = args.slice(1).join(' ').trim();
      if (!raw) return reply(`⏱ الوقت الحالي: ${fmtTime(lock)}\n\nمثال: !nm وقت 10s | !nm وقت r`);

      if (raw.toLowerCase().startsWith('r')) {
        const range = parseRange(raw.slice(1).trim());
        if (!range) return reply('⚠️ صيغة غير صحيحة. مثال: r | r 5-20 | r 10s-1m');
        lock.randomTime  = true;
        lock.randomRange = range;
        lock.time        = Math.round((range.min + range.max) / 2);
        saveAll(locks);
        return reply(`🎲 وقت عشوائي: ${range.min/1000}s–${range.max/1000}s\n💾 محفوظ.`);
      }

      let ms = 0;
      if (raw.endsWith('s'))      ms = parseFloat(raw) * 1000;
      else if (raw.endsWith('m')) ms = parseFloat(raw) * 60000;
      else return reply('⚠️ استخدم s أو m. مثال: 10s أو 2m');
      if (ms < 1000) return reply('⚠️ الحد الأدنى 1 ثانية.');
      lock.time        = ms;
      lock.randomTime  = false;
      lock.randomRange = null;
      saveAll(locks);
      global._instaNmNextAt.set(threadId, Date.now() + ms);
      return reply(`✅ الوقت: ${fmtTime(lock)}\n💾 محفوظ.`);
    }

    // ── حالة ──
    if (action === 'حالة') {
      const lock = locks[threadId];
      if (!lock) return reply('📋 لا يوجد قفل مفعل في هذه المجموعة.');
      const nextAt    = global._instaNmNextAt.get(threadId);
      const remaining = nextAt ? Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)) : '—';
      return reply(
        `🔒 قفل الاسم — حالة:\n` +
        `📝 الاسم: "${lock.name}"\n` +
        `⏱ الفترة: ${fmtTime(lock)}\n` +
        `⏳ التطبيق القادم: خلال ${remaining}s`
      );
    }

    // ── قائمة ──
    if (action === 'قائمة') {
      const entries = Object.entries(locks);
      if (!entries.length) return reply('📋 لا توجد مجموعات مقفولة حالياً.');
      let list = `🔒 الخيوط المقفولة (${entries.length}):\n`;
      entries.forEach(([tid, lock], i) => {
        list += `${i + 1}. ${tid.slice(-10)}: "${lock.name}" ⏱ ${fmtTime(lock)}\n`;
      });
      return reply(list.trim());
    }

    // ── تنظيف ──
    if (action === 'تنظيف') {
      const count = Object.keys(locks).length;
      if (!count) return reply('🗑️ لا توجد بيانات لحذفها.');
      for (const key of Object.keys(locks)) delete locks[key];
      global._instaNmNextAt.clear();
      saveAll(locks);
      return reply(`🧹 تم حذف جميع الأقفال (${count}).`);
    }

    return reply(helpMsg);
  },
};
