'use strict';
/**
 * احصائيات.js — Full system statistics (admin only)
 * Shows: cookies, all protection systems with their intervals/settings,
 * memory, uptime, MQTT, stealth, session health, motors, locks, etc.
 */

module.exports.config = {
  name:            'احصائيات',
  aliases:         ['stats', 'systems', 'انظمة', 'نظام', 'sysinfo', 'sysstat'],
  version:         '1.0.0',
  hasPermssion:    2,
  credits:         'ZAO Team',
  description:     'إحصائيات شاملة لجميع أنظمة البوت (admin only)',
  commandCategory: 'إدارة',
  usages:          'احصائيات',
  cooldowns:       10,
};

function _fmtMs(ms) {
  if (!ms || isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}س ${m % 60}د`;
  if (m > 0) return `${m}د ${s % 60}ث`;
  return `${s}ث`;
}

function _fmtMem(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  return (bytes / 1048576).toFixed(0) + ' MB';
}

function _fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}ي ${h % 24}س ${m % 60}د`;
  if (h > 0) return `${h}س ${m % 60}د`;
  if (m > 0) return `${m}د ${s % 60}ث`;
  return `${s}ث`;
}

function _ago(ts) {
  if (!ts) return '—';
  return _fmtMs(Date.now() - ts) + ' مضى';
}

function _readCookieInfo(filePath) {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(p)) return { exists: false, cookies: 0, sizeKB: 0 };
    const stat = fs.statSync(p);
    const raw  = fs.readFileSync(p, 'utf8');
    let cookies = 0;
    try { const arr = JSON.parse(raw); cookies = Array.isArray(arr) ? arr.length : 0; } catch (_) {}
    return { exists: true, cookies, sizeKB: Math.round(stat.size / 1024 * 10) / 10 };
  } catch (_) { return { exists: false, cookies: 0, sizeKB: 0 }; }
}

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;
  const cfg = global.config || {};

  const lines = [];
  const sep  = () => lines.push('━━━━━━━━━━━━━━━━━━━━━━━');
  const head = (t) => lines.push(`\n${t}`);

  // ── 1. RUNTIME ───────────────────────────────────────────────────────────
  head('📊 إحصائيات النظام الكاملة');
  sep();

  const mem  = process.memoryUsage();
  const heapPct = Math.round(mem.heapUsed / mem.heapTotal * 100);
  lines.push(`⏱  مدة التشغيل   : ${_fmtUptime(process.uptime() * 1000)}`);
  lines.push(`⚙️  Node.js       : ${process.version} | PID ${process.pid}`);
  lines.push(`💾 Heap Used     : ${_fmtMem(mem.heapUsed)} / ${_fmtMem(mem.heapTotal)} (${heapPct}%)`);
  lines.push(`📦 RSS           : ${_fmtMem(mem.rss)}`);

  // Platform
  let platformLabel = 'غير معروف';
  try { platformLabel = require('../../includes/utils/platformDetect').label; } catch (_) {}
  lines.push(`🌐 المنصة        : ${platformLabel}`);

  // ── 2. FACEBOOK / SESSION ───────────────────────────────────────────────
  head('🔑 الجلسة والكوكيز');
  sep();

  const appStatePath = cfg.APPSTATEPATH || 'sessions/ZAO-STATE.json';
  const tierFiles = [
    { label: 'Tier 1 (رئيسي)',  path: appStatePath },
    { label: 'Tier 1 (alt)',    path: 'sessions/alt.json' },
    { label: 'Tier 2',          path: 'sessions/ZAO-STATEX.json' },
    { label: 'Tier 2 (alt)',    path: 'sessions/altx.json' },
    { label: 'Tier 3',          path: 'sessions/ZAO-STATEV.json' },
    { label: 'Tier 3 (alt)',    path: 'sessions/altv.json' },
    { label: 'Tier 4',          path: 'sessions/ZAO-STATE4.json' },
    { label: 'Tier 4 (alt)',    path: 'sessions/alt4.json' },
    { label: 'Tier 5',          path: 'sessions/ZAO-STATE5.json' },
    { label: 'Tier 5 (alt)',    path: 'sessions/alt5.json' },
  ];
  for (const t of tierFiles) {
    const info = _readCookieInfo(t.path);
    const icon = info.exists && info.cookies > 0 ? '🟢' : info.exists ? '🟡' : '⚫';
    lines.push(`${icon} ${t.label.padEnd(16)}: ${info.exists && info.cookies > 0 ? `${info.cookies} كوكي — ${info.sizeKB} KB` : info.exists ? 'فارغ' : 'غير موجود'}`);
  }

  // Active tier
  let activeTier = '1';
  try {
    const fs = require('fs');
    if (fs.existsSync('data/active-tier.json')) {
      activeTier = JSON.parse(fs.readFileSync('data/active-tier.json', 'utf8')).tier || '1';
    } else if (fs.existsSync('data/activeTier.json')) {
      activeTier = JSON.parse(fs.readFileSync('data/activeTier.json', 'utf8')).tier || '1';
    }
  } catch (_) {}
  const tierLimit = (() => { try { return JSON.parse(require('fs').readFileSync('ZAO-SETTINGS.json','utf8')).tierLimit || 3; } catch(_) { return 3; } })();
  lines.push(`📌 Tier النشط   : Tier ${activeTier} | الحد: ${tierLimit} تيرات`);

  // Last alt save
  const lastAlt = global['lastAltJsonSave'];
  lines.push(`💾 آخر حفظ كوكيز: ${lastAlt ? _ago(lastAlt) : 'لم يحدث بعد'}`);

  // System uptime and restart history
  head('🔄 إعادة التشغيل والتاريخ');
  sep();

  const totalRestarts = (() => {
    try { return JSON.parse(require('fs').readFileSync('data/restart-stats.json','utf8')).total || 0; } catch(_) { return 0; }
  })();
  const firstStart = (() => {
    try { return JSON.parse(require('fs').readFileSync('data/first-start.json','utf8')).ts || null; } catch(_) { return null; }
  })();
  lines.push(`🔢 إجمالي عمليات التشغيل: ${totalRestarts}`);
  if (firstStart) {
    lines.push(`📅 أول تشغيل    : ${new Date(firstStart).toLocaleString('ar-SA')}`);
    lines.push(`⏱  وقت التشغيل الكلي: ${_fmtUptime(Date.now() - firstStart)}`);
  }
  const restartHistory = (() => {
    try { return JSON.parse(require('fs').readFileSync('data/restart-history.json','utf8')); } catch(_) { return []; }
  })();
  if (Array.isArray(restartHistory) && restartHistory.length > 0) {
    lines.push('📜 آخر عمليات التشغيل:');
    for (const r of restartHistory.slice().reverse().slice(0, 3)) {
      const d = new Date(r.ts).toLocaleString('ar-SA', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' });
      lines.push(`   • ${d} | كود ${r.code} | استمر ${_fmtUptime(r.uptimeMs)}`);
    }
  }

  // ── 3. MQTT ──────────────────────────────────────────────────────────────
  head('📡 MQTT');
  sep();

  const lastMqtt = global['lastMqttActivity'] || global['lastMqttOnlyActivity'] || 0;
  const mqttAgoMs = Date.now() - lastMqtt;
  const mqttIcon = mqttAgoMs < 600000 ? '🟢' : mqttAgoMs < 1800000 ? '🟡' : '🔴';
  lines.push(`${mqttIcon} آخر نشاط MQTT : ${lastMqtt ? _ago(lastMqtt) : 'لم يُسجَّل'}`);
  lines.push(`   جاهز          : ${global._mqttReady ? '✅' : '⏳'}`);

  const mqttCfg = cfg.mqttHealthCheck || {};
  lines.push(`   فحص كل       : ${mqttCfg.checkIntervalMinMinutes || 2}-${mqttCfg.checkIntervalMaxMinutes || 5} دقيقة`);
  lines.push(`   حد الصمت     : ${mqttCfg.silentTimeoutMinutes || 10} دقيقة`);
  lines.push(`   حد إعادة تشغيل: ${mqttCfg.maxRestarts || 5} محاولات`);
  lines.push(`   Backoff       : ×${mqttCfg.backoffMultiplier || 1.5} (حد ${mqttCfg.maxBackoffMinutes || 15}د)`);

  // ── 4. STEALTH ───────────────────────────────────────────────────────────
  head('🛡️ محرك التمويه (Stealth)');
  sep();

  let stealthSt = null;
  try { stealthSt = require('../../includes/stealthEngineV2').getStatus(); } catch (_) {}
  if (stealthSt) {
    lines.push(`   الحالة        : ${stealthSt.running ? '🟢 يعمل' : '🔴 متوقف'}`);
    lines.push(`   طبقات الحماية : ${stealthSt.layers || 10}`);
    lines.push(`   المؤقتات النشطة: ${stealthSt.activeTimers}`);
    lines.push(`   وضع النوم     : ${stealthSt.sleepStart}:00 – ${stealthSt.sleepEnd}:00`);
    lines.push(`   الساعة الحالية: ${stealthSt.localHour}:00 ${stealthSt.isSleepHour ? '🌙 نوم' : '☀️ نشط'}`);
    lines.push(`   Warmup        : ${stealthSt.isWarmup ? '🟡 تسخين' : '✅ مكتمل'} (${stealthSt.warmupMinutes}د)`);
    lines.push(`   UA Pool       : ${stealthSt.uaPoolSize} عنوان`);
    lines.push(`   Page Pool     : ${stealthSt.pagePoolSize}`);
  } else {
    lines.push('   لم يُحمَّل بعد');
  }

  const stCfg = cfg.stealthMode || {};
  lines.push(`   Night Mode    : ${stCfg.nightModeStart || 1}:00 – ${stCfg.nightModeEnd || 6}:00`);
  lines.push(`   Burst Protection: ${stCfg.burstProtection ? '✅' : '❌'} (${stCfg.burstThreshold || 5} رسائل → ${stCfg.burstCooldownMs || 8000}ms)`);

  // ── 5. PROTECTION SYSTEMS ────────────────────────────────────────────────
  head('🔒 أنظمة الحماية');
  sep();

  // AutoLock
  const alCfg = cfg.autoLock || {};
  const alActive = !!global.lockBot;
  lines.push(`🔐 AutoLock     : ${alActive ? '🔴 مقفل' : '🟢 مفتوح'}`);
  lines.push(`   حد الأوامر   : ${alCfg.maxCommands || 15} في ${alCfg.windowSeconds || 30}ث`);
  lines.push(`   فتح تلقائي   : بعد ${alCfg.unlockAfterMinutes || 10}د`);

  // HumanTyping
  const htCfg = cfg.humanTyping || {};
  lines.push(`⌨️  Human Typing : ${htCfg.enable ? '✅' : '❌'}`);
  lines.push(`   تأخير        : ${htCfg.minDelay || 800}–${htCfg.maxDelay || 4200}ms @ ${htCfg.charsPerSecond || 12}ح/ث`);

  // E2EE
  const e2Cfg = cfg.e2ee || {};
  lines.push(`🔐 E2EE Labyrinth: ${e2Cfg.enabled ? '✅' : '❌'}`);
  lines.push(`   تشفير تلقائي : ${e2Cfg.autoEncryptDMs ? '✅' : '❌'} | فك تشفير: ${e2Cfg.autoDecryptIncoming ? '✅' : '❌'}`);

  // nkxModern
  const nkCfg = cfg.nkxModern || {};
  lines.push(`🧬 NKX Modern   : ${nkCfg.enabled ? '✅' : '❌'}`);
  lines.push(`   Circuit Breaker: ${nkCfg.enableCircuitBreaker ? '✅' : '❌'} | Warmup: ${nkCfg.enableWarmup ? `✅ ${nkCfg.warmupMinutes}د` : '❌'}`);
  lines.push(`   إرسال        : ${nkCfg.sendWindowLimit || 12} رسالة/${Math.round((nkCfg.sendWindowMs || 60000)/1000)}ث`);

  // Memory guard
  lines.push(`💾 Memory Guard : وقف عند 400MB (تحذير 300MB)`);

  // Cookie save interval
  lines.push(`🍪 حفظ كوكيز   : كل 10د (auto) + كل 2س (إلزامي)`);
  lines.push(`🔄 تجديد كوكيز : كل ${cfg.intervalGetNewCookieMinutes || 1440}د`);

  // Auto uptime
  const auCfg = cfg.autoUptime || {};
  lines.push(`📡 Auto-Uptime  : ${auCfg.enable ? `✅ كل ${auCfg.intervalSeconds || 180}ث` : '❌ (معطّل)'}`);

  // Session check
  lines.push(`🔍 Session Check: كل 35 دقيقة`);

  // Error budget
  const ebCfg = cfg.commandErrorBudget;
  lines.push(`⚠️  Error Budget  : >5 أخطاء/10د → تعطيل الأمر ساعة`);

  // ── 6. MOTORS & LOCKS ────────────────────────────────────────────────────
  head('⚙️ المحركات والأقفال');
  sep();

  let motor1Active = 0, motor2Active = 0;
  try { motor1Active = Object.values(global.motorData  || {}).filter(d => d?.status).length; } catch (_) {}
  try { motor2Active = Object.values(global.motorData2 || {}).filter(d => d?.status).length; } catch (_) {}

  let nameLockCount = 0, nickLockCount = 0;
  try { const NL = require('../../includes/nameLocks');     nameLockCount = NL.getLocks().size; } catch (_) {}
  try { const NCL = require('../../includes/nicknameLocks'); nickLockCount = NCL.getLocks().size; } catch (_) {}

  lines.push(`🔁 Motor 1 نشط  : ${motor1Active} مجموعة`);
  lines.push(`🔁 Motor 2 نشط  : ${motor2Active} مجموعة`);
  lines.push(`📛 Name Locks   : ${nameLockCount} مجموعة`);
  lines.push(`🏷️  Nick Locks   : ${nickLockCount} مجموعة`);

  // ── 7. LIVE STATS ────────────────────────────────────────────────────────
  head('📈 إحصائيات الاستخدام');
  sep();

  try {
    const ls = require('../../includes/liveStats').getStats();
    lines.push(`✉️  رسائل (آخر ساعة): ${ls.msgsLastHour} | اليوم: ${ls.msgsToday}`);
    lines.push(`⚡ أوامر (آخر ساعة): ${ls.cmdsLastHour} | اليوم: ${ls.cmdsToday}`);
    lines.push(`❌ أخطاء (آخر ساعة): ${ls.errsLastHour}`);
    lines.push(`👥 المجموعات      : ${ls.groupCount}`);
    const topCmds = Object.entries(ls.perCommand || {})
      .sort(([,a],[,b]) => b.total - a.total).slice(0, 5)
      .map(([n,v]) => `${n}(${v.total})`).join(' · ');
    if (topCmds) lines.push(`🏆 أكثر استخداماً : ${topCmds}`);
  } catch (_) {}

  // ── 8. COMMANDS ──────────────────────────────────────────────────────────
  head('📋 الأوامر');
  sep();

  const cmdCount = global.client?.commands?.size || 0;
  const disabledCmds = (cfg.commandDisabled || []).join(', ') || 'لا يوجد';
  lines.push(`📦 الأوامر المحملة : ${cmdCount}`);
  lines.push(`🚫 أوامر معطلة    : ${disabledCmds}`);
  lines.push(`🔇 وضع صامت      : ${global._silentMode ? '✅ مُفعَّل' : '❌ متوقف'}`);

  // ── 9. BOT INFO ──────────────────────────────────────────────────────────
  head('🤖 معلومات البوت');
  sep();

  lines.push(`📛 الاسم   : ${cfg.BOTNAME || '—'}`);
  lines.push(`🔣 البادئة : ${cfg.PREFIX || '.'}`);
  lines.push(`🌐 اللغة   : ${cfg.language || 'en'}`);
  lines.push(`👑 Admins  : ${(cfg.ADMINBOT || []).length} مدير`);
  lines.push(`📅 الإصدار : ${cfg.version || '—'}`);

  return api.sendMessage(lines.join('\n'), threadID, messageID);
};
