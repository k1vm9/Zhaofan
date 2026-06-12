'use strict';

// ─── محرك2 (Motor 2) for Instagram ───────────────────────────────────────────
// Smart motor: sends a message periodically, but ONLY when the thread has
// seen recent activity from other users (not just the bot itself).
// Activity is tracked by the INSTA.js poll loop updating global._instaActivity.

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'insta-motor2.json');

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

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._instaMotor2)       global._instaMotor2 = loadAll();
if (!global._instaMotor2Timers) global._instaMotor2Timers = new Map();
if (!global._instaActivity)     global._instaActivity = {};   // { threadId: lastActivityTimestamp }

const motorData = global._instaMotor2;
const timers    = global._instaMotor2Timers;

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

function fmtRelTime(ts) {
  if (!ts) return 'لا نشاط';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)  return `منذ ${diff}ث`;
  if (diff < 3600) return `منذ ${Math.floor(diff/60)}د`;
  return `منذ ${Math.floor(diff/3600)}س`;
}

function nextDelay(d) {
  if (d.randomTime && d.randomRange) {
    const { min, max } = d.randomRange;
    return Math.round(min + Math.random() * (max - min));
  }
  return d.time || 30000;
}

function hasRecentActivity(threadId, window) {
  const last = (global._instaActivity || {})[threadId];
  if (!last) return false;
  return (Date.now() - last) < (window * 2);
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

  let consecutiveErrors = 0;
  let backoffMs = 0;

  const tick = async () => {
    const cur = motorData[threadId];
    // If row was deleted or motor disabled, stop the loop cleanly.
    if (!cur || !cur.status || !cur.message) {
      timers.delete(threadId);
      return;
    }

    let delay = nextDelay(cur);

    try {
      if (hasRecentActivity(threadId, cur.time)) {
        await sendText(threadId, cur.message);
      }
      // Successful tick — reset error counters.
      consecutiveErrors = 0;
      backoffMs = 0;
    } catch (err) {
      consecutiveErrors++;
      // Exponential backoff capped at 5 minutes; reset after 10 failures
      // so the loop keeps retrying rather than waiting forever.
      if (consecutiveErrors >= 10) {
        backoffMs = 30 * 1000;
        consecutiveErrors = 0;
      } else {
        backoffMs = backoffMs > 0
          ? Math.min(Math.floor(backoffMs * 1.5 + Math.random() * 5000), 5 * 60 * 1000)
          : 30 * 1000;
      }
      delay = backoffMs;
    }

    // Always reschedule so the loop survives errors.
    timers.set(threadId, setTimeout(tick, delay));
  };

  timers.set(threadId, setTimeout(tick, nextDelay(d)));
}

function stopLoop(threadId) {
  const t = timers.get(threadId);
  if (t) { clearTimeout(t); timers.delete(threadId); }
}

module.exports = {
  config: {
    name: 'محرك2',
    aliases: ['motor2', 'م2', 'smartmotor'],
    description: 'محرك ذكي — يرسل فقط عند وجود نشاط حديث في الخيط',
    usage: '!محرك2 تفعيل | ايقاف | رسالة [نص] | وقت [30s|2m|r] | حالة',
    adminOnly: true,
    category: 'إدارة',
  },

  // Mark activity when a non-bot message arrives — called by INSTA.js handleItem
  onActivity(threadId) {
    if (!global._instaActivity) global._instaActivity = {};
    global._instaActivity[threadId] = Date.now();
  },

  // Revive motors on boot
  onLoad({ sendText }) {
    const saved = loadAll();
    for (const [tid, d] of Object.entries(saved)) {
      motorData[tid] = { ...d };
      if (d.status && d.message && d.time) startLoop(sendText, tid);
    }

    // Watchdog: every 60 s check all active entries and revive any loop whose
    // timer was silently dropped (e.g. after an unhandled rejection or a
    // session reconnect that killed the timer queue entry).
    if (!global.__instaMotorWatchdog2) {
      global.__instaMotorWatchdog2 = setInterval(() => {
        try {
          for (const [tid, d] of Object.entries(motorData || {})) {
            if (d && d.status && d.message && d.time && !timers.has(tid)) {
              startLoop(sendText, tid);
            }
          }
        } catch (_) {}
      }, 60 * 1000);
      if (typeof global.__instaMotorWatchdog2.unref === 'function') {
        global.__instaMotorWatchdog2.unref();
      }
    }
  },

  run: async ({ event, reply, args, sendText, isAdmin }) => {
    if (!isAdmin) return reply('⛔ هذا الأمر للمشرفين فقط.');

    const threadId = event.threadID;
    const sub      = args[0];
    const data     = ensureRow(threadId);

    if (!sub) return reply(
      '📌 أوامر المحرك الذكي:\n' +
      '!محرك2 رسالة [النص]\n' +
      '!محرك2 وقت [30s | 2m | r]\n' +
      '!محرك2 تفعيل\n' +
      '!محرك2 ايقاف\n' +
      '!محرك2 حالة\n\n' +
      '🔔 يرسل فقط عند وجود نشاط في الخيط'
    );

    if (sub === 'رسالة') {
      const msg = args.slice(1).join(' ').trim();
      if (!msg) return reply('⚠️ اكتب الرسالة بعد الأمر.');
      data.message = msg;
      saveAll(motorData);
      return reply(`✅ تم حفظ الرسالة:\n"${msg}"\n💾 محفوظ.`);
    }

    if (sub === 'وقت') {
      const raw = args.slice(1).join(' ').trim();
      if (!raw) return reply('⚠️ أمثلة:\n!محرك2 وقت 30s\n!محرك2 وقت 2m\n!محرك2 وقت r\n!محرك2 وقت r 20-120');

      if (raw.toLowerCase().startsWith('r')) {
        const range = parseRange(raw.slice(1).trim());
        if (!range) return reply('⚠️ صيغة غير صحيحة. مثال: r 15-60 أو r 20s-2m');
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
      else return reply('⚠️ استخدم s أو m. مثال: 30s أو 2m');
      if (ms < 5000) return reply('⚠️ الحد الأدنى 5 ثواني.');
      data.time        = ms;
      data.randomTime  = false;
      data.randomRange = null;
      saveAll(motorData);
      if (data.status) startLoop(sendText, threadId);
      return reply(`✅ الوقت: ${fmtTime(data)}\n💾 محفوظ.`);
    }

    if (sub === 'تفعيل') {
      if (data.status)    return reply('⚠️ المحرك الذكي مفعل مسبقاً.');
      if (!data.message)  return reply('⚠️ حدد الرسالة أولاً: !محرك2 رسالة [النص]');
      if (!data.time)     return reply('⚠️ حدد الوقت أولاً: !محرك2 وقت [30s]');
      data.status = true;
      startLoop(sendText, threadId);
      saveAll(motorData);
      return reply(
        `✅ المحرك الذكي مفعل!\n📝 "${data.message}"\n⏱ ${fmtTime(data)}\n🔔 يرسل فقط عند وجود نشاط`
      );
    }

    if (sub === 'ايقاف') {
      if (!data.status) return reply('⚠️ المحرك الذكي غير مفعل أصلاً.');
      data.status = false;
      stopLoop(threadId);
      saveAll(motorData);
      return reply('🔴 تم إيقاف المحرك الذكي.\n💾 محفوظ.');
    }

    if (sub === 'حالة') {
      const active = Object.entries(motorData).filter(([, d]) => d.status);
      if (!active.length) return reply('📊 المحرك الذكي\n\n⚫ لا توجد خيوط نشطة.');
      let msg = `📊 المحرك الذكي — ${active.length} خيط\n${'━'.repeat(18)}\n`;
      for (const [tid, d] of active) {
        const isCurrent = tid === threadId;
        const lastAct   = fmtRelTime((global._instaActivity || {})[tid]);
        msg += `\n${isCurrent ? '▶️' : '🟢'} ${tid.slice(-8)}\n`;
        msg += `   📝 "${(d.message || '').slice(0, 30)}"\n`;
        msg += `   ⏱ ${fmtTime(d)}\n`;
        msg += `   🕐 آخر نشاط: ${lastAct}\n`;
      }
      return reply(msg.trim());
    }

    return reply('❓ استخدم: !محرك2 للمساعدة');
  },
};
