'use strict';
/**
 * zao-insta.js — ZAO-INSTA web panel routes
 * ===========================================
 * @author  SAIN (original), DJAMEL (hot-reload cookies button, MQTT status, overview improvements)
 * @updated 2026-05-26
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');

const INSTA_SETTINGS_FILE = path.join(__dirname, '..', 'INSTA-SETTINGS.json');
const APPSTATE_FILE       = path.join(__dirname, '..', 'sessions', 'INSTA-APPSTATE.json');

function readInstaSettings() {
  try { return JSON.parse(fs.readFileSync(INSTA_SETTINGS_FILE, 'utf-8')); }
  catch (_) { return {}; }
}

function writeInstaSettings(data) {
  try { fs.writeFileSync(INSTA_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8'); return true; }
  catch (_) { return false; }
}

// Proxy a request to the Instagram bot's internal API
function proxyInsta(apiPort, method, botPath, bodyObj, res) {
  let responded = false;
  function once(code, data) {
    if (responded) return;
    responded = true;
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const opts = {
    hostname: '127.0.0.1', port: apiPort, path: botPath, method,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  };

  const req = http.request(opts, proxyRes => {
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end', () => {
      if (responded) return;
      responded = true;
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });
  req.on('error', () => once(503, { error: 'ZAO-INSTA offline or not started', online: false }));
  req.setTimeout(6000, () => { req.destroy(); once(503, { error: 'Timeout', online: false }); });
  if (bodyStr) req.write(bodyStr);
  req.end();
}

// Sub-nav tab links for ZAO-INSTA pages
function instaSubNav(active) {
  const tabs = [
    ['/insta',          '🏠', 'الرئيسية'],
    ['/insta/threads',  '💬', 'المحادثات'],
    ['/insta/commands', '⚡', 'الأوامر'],
    ['/insta/settings', '⚙️', 'الإعدادات'],
  ];
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px">
    ${tabs.map(([href, icon, label]) => `
      <a href="${href}" style="
        display:inline-flex;align-items:center;gap:6px;padding:9px 18px;
        border-radius:40px;text-decoration:none;font-size:.84rem;font-weight:600;
        transition:all .2s;font-family:'Cairo',sans-serif;
        ${active === href
          ? 'background:linear-gradient(135deg,#e1306c,#833ab4);color:#fff;box-shadow:0 4px 18px rgba(225,48,108,.35)'
          : 'background:rgba(255,255,255,.06);color:rgba(232,234,246,.7);border:1px solid rgba(255,255,255,.08)'}
      ">${icon} ${label}</a>`).join('')}
  </div>`;
}

// Page header with Instagram gradient
function instaHeader(title, sub) {
  return `
<div class="page-header" style="position:relative;overflow:hidden;padding:28px 32px;border-radius:20px;
  background:linear-gradient(135deg,rgba(225,48,108,.12) 0%,rgba(131,58,180,.12) 50%,rgba(64,93,230,.10) 100%);
  border:1px solid rgba(225,48,108,.18);margin-bottom:28px">
  <div style="position:absolute;inset:0;background:
    radial-gradient(ellipse 60% 80% at 90% 50%,rgba(225,48,108,.08) 0%,transparent 60%),
    radial-gradient(ellipse 40% 60% at 10% 50%,rgba(131,58,180,.06) 0%,transparent 50%)"></div>
  <div style="position:relative;display:flex;align-items:center;gap:16px">
    <div style="width:52px;height:52px;border-radius:15px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.7rem;
      background:linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);
      box-shadow:0 8px 24px rgba(225,48,108,.4)">📸</div>
    <div>
      <div class="page-title" style="background:linear-gradient(90deg,#e1306c,#833ab4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${title}</div>
      <div class="page-sub" style="margin-top:4px">${sub}</div>
    </div>
  </div>
</div>`;
}

// Status badge
function statusBadge(online) {
  return online
    ? `<span class="badge badge-green">✅ متصل</span>`
    : `<span class="badge badge-red">❌ غير متصل</span>`;
}

// ─── Mount routes ────────────────────────────────────────────────────────────
module.exports.mount = function(app, opts) {
  const { auth, layout, pageOpts, instaApiPort, getInstaChild, instaLogBuffer } = opts;

  function isInstaOnline() { return getInstaChild ? getInstaChild() !== null : false; }

  // Helper: fetch status from insta bot
  async function fetchInstaStatus() {
    return new Promise(resolve => {
      const req = http.request(
        { hostname: '127.0.0.1', port: instaApiPort, path: '/insta/status', method: 'GET' },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({}); } });
        }
      );
      req.on('error', () => resolve({ online: false }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ online: false }); });
      req.end();
    });
  }

  // ─── ZAO-INSTA OVERVIEW ─────────────────────────────────────────────────────
  // @updated DJAMEL — live MQTT indicator with auto-refresh every 5s
  app.get('/insta', auth, async (req, res) => {
    const status = await fetchInstaStatus();
    const online = !!status.online;
    const cfg    = readInstaSettings();

    const upSec  = status.startedAt ? Math.floor((Date.now() - status.startedAt) / 1000) : 0;
    const upStr  = `${Math.floor(upSec/3600)}h ${Math.floor((upSec%3600)/60)}m ${upSec%60}s`;

    // Initial login method label (re-rendered live by JS)
    function loginMethodLabel(m) {
      if (m === 'appstate-cookies') return '🍪 كوكيز';
      if (m === 'saved-session')    return '💾 جلسة محفوظة';
      if (m === 'credentials')      return '🔑 كلمة مرور';
      return '—';
    }

    const body = `
${instaHeader('ZAO-INSTA', 'بوت إنستاغرام — رسائل مباشرة ومجموعات')}
${instaSubNav('/insta')}

<!-- ── Live MQTT status bar ── @added DJAMEL ──────────────────────────────── -->
<div id="mqttBar" style="
  display:flex;align-items:center;gap:14px;padding:12px 20px;border-radius:14px;
  margin-bottom:20px;border:1px solid rgba(255,255,255,.07);
  background:rgba(255,255,255,.03);transition:border-color .4s">
  <!-- Animated dot -->
  <div style="position:relative;width:14px;height:14px;flex-shrink:0">
    <div id="mqttDotPulse" style="
      position:absolute;inset:0;border-radius:50%;opacity:.45;
      animation:mqttPulse 2s ease-in-out infinite"></div>
    <div id="mqttDot" style="
      position:absolute;inset:2px;border-radius:50%;transition:background .4s"></div>
  </div>
  <!-- Label -->
  <div style="flex:1;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span id="mqttLabel" style="font-weight:700;font-size:.86rem;transition:color .4s">—</span>
    <span id="mqttSub"   style="font-size:.78rem;color:var(--text3)">يتصل…</span>
  </div>
  <!-- Ping badge -->
  <div style="display:flex;align-items:center;gap:6px">
    <span style="font-size:.74rem;color:var(--text3)">ping</span>
    <span id="mqttPing" style="
      font-size:.78rem;font-weight:700;padding:3px 9px;border-radius:20px;
      background:rgba(255,255,255,.06);color:var(--text2);transition:all .3s">—</span>
  </div>
  <!-- Auto-refresh indicator -->
  <div style="display:flex;align-items:center;gap:5px">
    <div id="refreshSpin" style="width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.15)"></div>
    <span style="font-size:.72rem;color:var(--text3)" id="lastRefresh">—</span>
  </div>
</div>

<style>
@keyframes mqttPulse {
  0%,100%{transform:scale(1);opacity:.45}
  50%{transform:scale(2.2);opacity:0}
}
@keyframes spin{to{transform:rotate(360deg)}}
</style>

<!-- Challenge banner — shown when Instagram requires identity verification code -->
<div id="challengeBanner" style="display:${status.challengePending ? 'block' : 'none'};
  background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.35);
  border-radius:14px;padding:20px;margin-bottom:20px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
    <span style="font-size:1.4rem">📨</span>
    <div>
      <div style="font-weight:700;color:#f5a623;font-size:.92rem">⚠️ تأكيد الهوية مطلوب</div>
      <div style="font-size:.79rem;color:var(--text2);margin-top:3px">
        Instagram أرسل كوداً على إيميلك أو رقمك — أدخله هنا لإكمال تسجيل الدخول تلقائياً</div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:stretch">
    <input id="challengeCodeInput" type="text" inputmode="numeric" maxlength="8"
      placeholder="الكود المكون من 6 أرقام"
      style="flex:1;padding:10px 14px;border-radius:10px;border:1px solid rgba(245,166,35,.4);
        background:rgba(255,255,255,.05);color:#fff;font-size:1.1rem;text-align:center;
        letter-spacing:6px;font-weight:700;outline:none"
      onkeydown="if(event.key==='Enter')submitChallengeCode()">
    <button onclick="submitChallengeCode()" id="challengeBtn" style="
      padding:10px 22px;background:linear-gradient(135deg,#f5a623,#e0820a);
      color:#fff;font-weight:700;border:none;border-radius:10px;cursor:pointer;
      font-size:.88rem;white-space:nowrap;transition:opacity .2s">✅ تأكيد</button>
  </div>
  <div id="challengeMsg" style="margin-top:10px;font-size:.8rem;min-height:18px;text-align:center"></div>
</div>

<!-- Status cards — IDs for live update -->
<div class="stats-grid" style="margin-bottom:28px">
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">🔗</div>
    <div class="stat-val" id="lv-status" style="font-size:.9rem">${statusBadge(online)}</div>
    <div class="stat-lbl">حالة الاتصال</div></div>
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">👤</div>
    <div class="stat-val" id="lv-user" style="font-size:.88rem">@${status.username || cfg.username || '—'}</div>
    <div class="stat-lbl">الحساب</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">📨</div>
    <div class="stat-val" id="lv-msgs">${status.totalMessages ?? '—'}</div>
    <div class="stat-lbl">رسائل معالجة</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">⚡</div>
    <div class="stat-val" id="lv-cmds">${status.totalCommands ?? '—'}</div>
    <div class="stat-lbl">أوامر نُفِّذت</div></div>
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">📦</div>
    <div class="stat-val" id="lv-cmdcount">${status.commandCount ?? '—'}</div>
    <div class="stat-lbl">أوامر محملة</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">⏱️</div>
    <div class="stat-val" id="lv-uptime" style="font-size:.82rem">${online ? upStr : '—'}</div>
    <div class="stat-lbl">Uptime</div></div>
</div>

<!-- Control + connection detail -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px">
  <div class="card">
    <div class="card-header"><div class="card-title">🎛️ التحكم</div></div>
    <div style="padding:20px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="instaAction('restart')">🔄 إعادة تشغيل</button>
      <button class="btn btn-outline" onclick="instaAction('reload')">♻️ إعادة تحميل الأوامر</button>
    </div>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">📡 تفاصيل الاتصال</div></div>
    <div style="padding:20px;display:flex;flex-direction:column;gap:9px">
      <div style="display:flex;justify-content:space-between;font-size:.83rem">
        <span style="color:var(--text2)">طريقة الدخول:</span>
        <span id="lv-loginMethod" style="color:var(--green)">${loginMethodLabel(status.loginMethod)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.83rem">
        <span style="color:var(--text2)">وضع الاستقبال:</span>
        <span id="lv-mode" style="color:${status.mqttConnected ? 'var(--green)' : '#f5a623'}">
          ${status.mqttConnected ? '🟢 MQTT لحظي' : '🟡 استطلاع دوري'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.83rem">
        <span style="color:var(--text2)">آخر فحص:</span>
        <span id="lv-pollAt" style="color:var(--text3);font-size:.78rem">
          ${status.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString('ar-DZ') : '—'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.83rem">
        <span style="color:var(--text2)">حالة الفحص:</span>
        <span id="lv-pollStatus" style="color:${status.lastPollStatus==='ok'?'var(--green)':'var(--red)'}">
          ${status.lastPollStatus || '—'}</span>
      </div>
    </div>
  </div>
</div>

<!-- Recent logs -->
<div class="card">
  <div class="card-header">
    <div class="card-title">📋 آخر السجلات</div>
    <div style="display:flex;align-items:center;gap:8px">
      <span id="liveTag" style="font-size:.7rem;padding:2px 8px;border-radius:10px;
        background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.25)">● مباشر</span>
      <button class="btn btn-outline btn-sm" onclick="location.reload()">🔄</button>
    </div>
  </div>
  <div style="padding:16px">
    <pre id="lv-logs" style="background:var(--bg3);border-radius:10px;padding:14px;font-size:.76rem;
      color:var(--text2);max-height:280px;overflow-y:auto;direction:ltr;text-align:left;
      border:1px solid var(--border);font-family:'JetBrains Mono',monospace">${
        (instaLogBuffer && instaLogBuffer.length
          ? instaLogBuffer.slice(-80).map(e => e.text || e).join('\n')
          : '— لا توجد سجلات بعد —')
      }</pre>
  </div>
</div>

<script>
// ── Live MQTT status updater — refreshes every 5 seconds ──────────────────────
// @added DJAMEL
let _liveTimer = null;
let _startedAt = ${status.startedAt || 'null'};

function fmtUptime(startedAt) {
  if (!startedAt) return '—';
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm ' + (s%60) + 's';
}
function loginLabel(m) {
  if (m === 'appstate-cookies') return '🍪 كوكيز';
  if (m === 'saved-session')    return '💾 جلسة محفوظة';
  if (m === 'credentials')      return '🔑 كلمة مرور';
  return '—';
}
function set(id, html)  { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setTxt(id, txt){ const el = document.getElementById(id); if (el) el.textContent = txt; }
function setStyle(id, prop, val){ const el = document.getElementById(id); if (el) el.style[prop] = val; }

function applyMqttBar(online, mqtt) {
  const bar  = document.getElementById('mqttBar');
  const dot  = document.getElementById('mqttDot');
  const pulse= document.getElementById('mqttDotPulse');
  const lbl  = document.getElementById('mqttLabel');
  const sub  = document.getElementById('mqttSub');
  if (!bar) return;

  if (!online) {
    const c = '#ef4444';
    dot.style.background   = c;
    pulse.style.background = c;
    lbl.style.color        = c;
    lbl.textContent        = 'غير متصل';
    sub.textContent        = 'ZAO-INSTA offline';
    bar.style.borderColor  = 'rgba(239,68,68,.25)';
  } else if (mqtt) {
    const c = '#22c55e';
    dot.style.background   = c;
    pulse.style.background = c;
    lbl.style.color        = c;
    lbl.textContent        = 'MQTT — متصل لحظياً';
    sub.textContent        = 'رسائل تصل فورياً عبر MQTT';
    bar.style.borderColor  = 'rgba(34,197,94,.25)';
  } else {
    const c = '#f5a623';
    dot.style.background   = c;
    pulse.style.background = c;
    lbl.style.color        = c;
    lbl.textContent        = 'استطلاع دوري';
    sub.textContent        = 'MQTT غير متصل — يفحص الرسائل دورياً';
    bar.style.borderColor  = 'rgba(245,166,35,.25)';
  }
}

async function liveRefresh() {
  const spin = document.getElementById('refreshSpin');
  if (spin) { spin.style.background = '#e1306c'; spin.style.animation = 'spin .6s linear infinite'; }

  const t0 = Date.now();
  let s = {};
  try {
    const r = await fetch('/api/insta/status', { cache: 'no-store' });
    s = await r.json();
  } catch(_) { s = { online: false }; }
  const ping = Date.now() - t0;

  // Update MQTT bar
  applyMqttBar(!!s.online, !!s.mqttConnected);

  // Update ping badge
  const pingEl = document.getElementById('mqttPing');
  if (pingEl) {
    pingEl.textContent = ping + 'ms';
    pingEl.style.color = ping < 150 ? '#22c55e' : ping < 400 ? '#f5a623' : '#ef4444';
  }

  // Update stats cards
  if (s.online) {
    if (_startedAt === null && s.startedAt) _startedAt = s.startedAt;
    set('lv-status', s.online ? '<span class="badge badge-green">✅ متصل</span>' : '<span class="badge badge-red">❌ غير متصل</span>');
    setTxt('lv-user', '@' + (s.username || '—'));
    setTxt('lv-msgs', s.totalMessages ?? '—');
    setTxt('lv-cmds', s.totalCommands ?? '—');
    setTxt('lv-cmdcount', s.commandCount ?? '—');
    setTxt('lv-uptime', fmtUptime(_startedAt || s.startedAt));
    // Connection detail
    setTxt('lv-loginMethod', loginLabel(s.loginMethod));
    const modeEl = document.getElementById('lv-mode');
    if (modeEl) { modeEl.textContent = s.mqttConnected ? '🟢 MQTT لحظي' : '🟡 استطلاع دوري'; modeEl.style.color = s.mqttConnected ? 'var(--green)' : '#f5a623'; }
    if (s.lastPollAt) setTxt('lv-pollAt', new Date(s.lastPollAt).toLocaleTimeString('ar-DZ'));
    const ps = document.getElementById('lv-pollStatus');
    if (ps) { ps.textContent = s.lastPollStatus || '—'; ps.style.color = s.lastPollStatus === 'ok' ? 'var(--green)' : 'var(--red)'; }
  } else {
    set('lv-status', '<span class="badge badge-red">❌ غير متصل</span>');
    applyMqttBar(false, false);
  }

  // Challenge banner — show when Instagram needs verification code
  const cb = document.getElementById('challengeBanner');
  if (cb) cb.style.display = s.challengePending ? 'block' : 'none';

  // Timestamp
  const lr = document.getElementById('lastRefresh');
  if (lr) lr.textContent = new Date().toLocaleTimeString('ar-DZ');
  if (spin) { spin.style.background = 'rgba(255,255,255,.15)'; spin.style.animation = ''; }
}

// Init on load, then every 5s
applyMqttBar(${online}, ${status.mqttConnected || false});
liveRefresh();
_liveTimer = setInterval(liveRefresh, 5000);

// Uptime counter ticks every second (no network call)
setInterval(() => { if (_startedAt) setTxt('lv-uptime', fmtUptime(_startedAt)); }, 1000);

// ── Challenge code submission ─────────────────────────────────────────────────
// @added DJAMEL — submits Instagram identity verification code from panel
async function submitChallengeCode() {
  const input = document.getElementById('challengeCodeInput');
  const msg   = document.getElementById('challengeMsg');
  const btn   = document.getElementById('challengeBtn');
  const code  = (input?.value || '').replace(/\s/g,'').trim();
  if (!code) {
    if (msg) { msg.style.color = '#ef4444'; msg.textContent = '⚠️ أدخل الكود أولاً'; }
    return;
  }
  if (btn)  { btn.disabled = true; btn.textContent = '⏳ جاري…'; btn.style.opacity = '.7'; }
  if (msg)  { msg.style.color = 'var(--text3)'; msg.textContent = 'يتحقق من الكود…'; }
  try {
    const r = await fetch('/api/insta/challenge-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const d = await r.json();
    if (d.ok) {
      if (msg) { msg.style.color = '#22c55e'; msg.textContent = '✅ تم تسجيل الدخول — @' + d.username; }
      if (input) input.value = '';
      setTimeout(liveRefresh, 1200);
    } else {
      if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ ' + (d.error || 'فشل التحقق'); }
    }
  } catch(e) {
    if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ خطأ في الشبكة — حاول مرة أخرى'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✅ تأكيد'; btn.style.opacity = '1'; }
  }
}

async function instaAction(action) {
  if (action === 'restart') {
    if (!confirm('إعادة تشغيل ZAO-INSTA؟')) return;
    clearInterval(_liveTimer);
    const r = await fetch('/api/insta/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    showToast(d.ok ? '🔄 جارٍ إعادة التشغيل...' : (d.error || 'فشل'), d.ok ? 'success' : 'error');
    if (d.ok) setTimeout(() => location.reload(), 3500);
  } else if (action === 'reload') {
    const r = await fetch('/api/insta/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    showToast(d.ok ? '✅ تم إعادة تحميل ' + (d.count || 0) + ' أمر' : (d.error || 'فشل'), d.ok ? 'success' : 'error');
  }
}
</script>`;

    res.send(layout('ZAO-INSTA', body, 'insta', pageOpts()));
  });

  // ─── THREADS ──────────────────────────────────────────────────────────────────
  app.get('/insta/threads', auth, async (req, res) => {
    let threads = [];
    let errMsg  = '';
    try {
      const r = await new Promise(resolve => {
        const req2 = http.request(
          { hostname: '127.0.0.1', port: instaApiPort, path: '/insta/threads', method: 'GET' },
          resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve({}); } }); }
        );
        req2.on('error', () => resolve({ ok: false, error: 'Bot offline' }));
        req2.setTimeout(5000, () => { req2.destroy(); resolve({ ok: false, error: 'Timeout' }); });
        req2.end();
      });
      if (r.ok) threads = r.threads || [];
      else errMsg = r.error || 'فشل';
    } catch (e) { errMsg = e.message; }

    const rows = threads.map(t => {
      const safeTitle = (t.title || '').replace(/"/g, '&quot;');
      return `<tr>
        <td><code style="font-size:.77rem">${t.threadId}</code></td>
        <td style="font-weight:600">${t.title || '—'}</td>
        <td><span class="badge ${t.isGroup ? 'badge-green' : 'badge-blue'}">${t.isGroup ? '👥 مجموعة' : '💬 DM'}</span></td>
        <td style="color:var(--text3);font-size:.8rem">${t.participantCount || '—'}</td>
        <td>
          <button class="btn btn-outline btn-sm" data-tid="${t.threadId}" data-title="${safeTitle}" onclick="openSendModal(this)">📤 إرسال</button>
        </td>
      </tr>`;
    }).join('');

    const body = `
${instaHeader('المحادثات', 'غروبات ومحادثات مباشرة — تحديث لحظي')}
${instaSubNav('/insta/threads')}
<div class="card">
  <div class="card-header">
    <div class="card-title">💬 المحادثات (${threads.length})</div>
    <button class="btn btn-outline btn-sm" onclick="location.reload()">🔄</button>
  </div>
  ${errMsg ? `<div style="text-align:center;padding:36px;color:var(--red)">❌ ${errMsg}</div>` :
    threads.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Thread ID</th><th>الاسم</th><th>النوع</th><th>الأعضاء</th><th>إرسال</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` :
    `<div style="text-align:center;padding:36px;color:var(--text3)">لا توجد محادثات — البوت قد يكون غير متصل</div>`}
</div>

<!-- Send Modal -->
<div id="sendModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.85);
  backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg3);border-radius:20px;padding:28px;width:min(480px,92vw);border:1px solid var(--border2)">
    <div style="font-size:1rem;font-weight:700;margin-bottom:16px">📤 إرسال رسالة — <span id="sendTitle"></span></div>
    <textarea id="sendMsg" style="width:100%;height:100px;background:var(--bg4);border:1px solid var(--border);
      color:var(--text);border-radius:10px;padding:10px;font-family:'Cairo',sans-serif;font-size:.88rem;resize:vertical"
      placeholder="اكتب رسالتك هنا..."></textarea>
    <div id="sendStatus" style="margin:8px 0;min-height:20px;font-size:.83rem"></div>
    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn btn-primary" onclick="doSend()">📤 إرسال</button>
      <button class="btn btn-outline" onclick="closeSend()">إلغاء</button>
    </div>
  </div>
</div>

<script>
let _tid = '';
function openSendModal(btn) {
  _tid = btn.dataset.tid;
  const title = btn.dataset.title || _tid;
  document.getElementById('sendTitle').textContent = title;
  document.getElementById('sendMsg').value = '';
  document.getElementById('sendStatus').innerHTML = '';
  document.getElementById('sendModal').style.display = 'flex';
  document.getElementById('sendMsg').focus();
}
function closeSend() { document.getElementById('sendModal').style.display = 'none'; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSend(); });
async function doSend() {
  const msg = document.getElementById('sendMsg').value.trim();
  if (!msg) return;
  const st = document.getElementById('sendStatus');
  st.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الإرسال...</span>';
  const r = await fetch('/api/insta/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: _tid, message: msg })
  });
  const d = await r.json();
  if (d.ok) { st.innerHTML = '<span style="color:var(--green)">✅ تم الإرسال</span>'; showToast('✅ تم الإرسال', 'success'); }
  else { st.innerHTML = '<span style="color:var(--red)">❌ ' + (d.error || 'فشل') + '</span>'; }
}
</script>`;

    res.send(layout('ZAO-INSTA — المحادثات', body, 'insta', pageOpts()));
  });

  // ─── COMMANDS ─────────────────────────────────────────────────────────────────
  app.get('/insta/commands', auth, async (req, res) => {
    let cmds   = [];
    let errMsg = '';
    try {
      const r = await new Promise(resolve => {
        const req2 = http.request(
          { hostname: '127.0.0.1', port: instaApiPort, path: '/insta/commands', method: 'GET' },
          resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve({}); } }); }
        );
        req2.on('error', () => resolve({ ok: false }));
        req2.setTimeout(3000, () => { req2.destroy(); resolve({ ok: false }); });
        req2.end();
      });
      if (r.ok) cmds = r.commands || [];
      else errMsg = 'البوت غير متصل';
    } catch (e) { errMsg = e.message; }

    const cfg  = readInstaSettings();
    const pfx  = cfg.prefix || '!';
    const rows = cmds.map(c => `
      <tr>
        <td><code style="font-size:.82rem">${pfx}${c.name}</code></td>
        <td>${c.description || '—'}</td>
        <td style="color:var(--text3);font-size:.79rem"><code>${c.usage || pfx + c.name}</code></td>
        <td>${c.adminOnly ? '<span class="badge badge-red">🔒 مشرف</span>' : '<span class="badge badge-green">🌐 عام</span>'}</td>
      </tr>`).join('');

    const body = `
${instaHeader('الأوامر', `${cmds.length} أمر محمل — البادئة: ${pfx}`)}
${instaSubNav('/insta/commands')}
<div class="card">
  <div class="card-header">
    <div class="card-title">⚡ قائمة الأوامر (${cmds.length})</div>
    <button class="btn btn-outline btn-sm" onclick="reloadCmds()">♻️ إعادة تحميل</button>
  </div>
  ${errMsg ? `<div style="text-align:center;padding:36px;color:var(--red)">❌ ${errMsg}</div>` :
    cmds.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>الأمر</th><th>الوصف</th><th>الاستخدام</th><th>الصلاحية</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` :
    `<div style="text-align:center;padding:36px;color:var(--text3)">لا توجد أوامر محملة</div>`}
</div>
<script>
async function reloadCmds() {
  const r = await fetch('/api/insta/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const d = await r.json();
  showToast(d.ok ? '✅ تم إعادة تحميل ' + (d.count || 0) + ' أمر' : (d.error || 'فشل'), d.ok ? 'success' : 'error');
  if (d.ok) setTimeout(() => location.reload(), 800);
}
</script>`;

    res.send(layout('ZAO-INSTA — الأوامر', body, 'insta', pageOpts()));
  });

  // ─── SETTINGS ─────────────────────────────────────────────────────────────────
  app.get('/insta/settings', auth, (req, res) => {
    const cfg = readInstaSettings();
    const body = `
${instaHeader('الإعدادات', 'إعداد حساب إنستاغرام والتفضيلات')}
${instaSubNav('/insta/settings')}

<div class="card" style="max-width:620px">
  <div class="card-header"><div class="card-title">⚙️ إعدادات ZAO-INSTA</div></div>
  <div style="padding:24px;display:flex;flex-direction:column;gap:18px">

    <div>
      <label style="font-size:.84rem;color:var(--text2);display:block;margin-bottom:6px">اسم المستخدم (Instagram Username)</label>
      <input id="cfg-username" value="${cfg.username || ''}" type="text" autocomplete="off"
        style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
          border-radius:10px;padding:10px 14px;font-family:'Cairo',sans-serif;font-size:.88rem;outline:none"/>
    </div>

    <div>
      <label style="font-size:.84rem;color:var(--text2);display:block;margin-bottom:6px">كلمة المرور</label>
      <div style="display:flex;gap:8px">
        <input id="cfg-password" type="password" placeholder="اتركه فارغاً للإبقاء على الحالي"
          style="flex:1;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
            border-radius:10px;padding:10px 14px;font-family:'Cairo',sans-serif;font-size:.88rem;outline:none"/>
        <button class="btn btn-outline btn-sm" onclick="togglePw()">👁️</button>
      </div>
      <div style="font-size:.77rem;color:var(--text3);margin-top:4px">تغيير البيانات يُعيد تشغيل البوت تلقائياً</div>
    </div>

    <div>
      <label style="font-size:.84rem;color:var(--text2);display:block;margin-bottom:6px">البادئة (Prefix)</label>
      <input id="cfg-prefix" value="${cfg.prefix || '!'}" maxlength="3"
        style="width:80px;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
          border-radius:10px;padding:10px 14px;font-family:'Cairo',sans-serif;font-size:.88rem;outline:none;text-align:center"/>
    </div>

    <div>
      <label style="font-size:.84rem;color:var(--text2);display:block;margin-bottom:6px">معرفات المشرفين (Instagram UIDs — مفصولة بفاصلة)</label>
      <input id="cfg-admins" value="${(cfg.adminIds || []).join(', ')}"
        style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
          border-radius:10px;padding:10px 14px;font-family:'Cairo',sans-serif;font-size:.88rem;outline:none"/>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <label class="toggle-row" style="display:flex;align-items:center;gap:12px;cursor:pointer">
        <input id="cfg-groups" type="checkbox" ${cfg.replyInGroups !== false ? 'checked' : ''}
          style="width:18px;height:18px;accent-color:#e1306c"/>
        <span style="font-size:.84rem">الرد في الغروبات</span>
      </label>
      <label class="toggle-row" style="display:flex;align-items:center;gap:12px;cursor:pointer">
        <input id="cfg-dms" type="checkbox" ${cfg.replyInDMs !== false ? 'checked' : ''}
          style="width:18px;height:18px;accent-color:#e1306c"/>
        <span style="font-size:.84rem">الرد في DMs</span>
      </label>
      <label class="toggle-row" style="display:flex;align-items:center;gap:12px;cursor:pointer">
        <input id="cfg-typing" type="checkbox" ${cfg.typing !== false ? 'checked' : ''}
          style="width:18px;height:18px;accent-color:#e1306c"/>
        <span style="font-size:.84rem">تأخير الكتابة (طبيعي)</span>
      </label>
    </div>

    <div>
      <label style="font-size:.84rem;color:var(--text2);display:block;margin-bottom:6px">مفتاح OpenRouter AI (اختياري)</label>
      <input id="cfg-openrouter" value="${cfg.openrouterKey || ''}" type="password"
        style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
          border-radius:10px;padding:10px 14px;font-family:'Cairo',sans-serif;font-size:.88rem;outline:none"/>
    </div>

    <div id="saveFeedback" style="min-height:24px;font-size:.84rem"></div>

    <button class="btn btn-primary" onclick="saveSettings()" style="
      background:linear-gradient(135deg,#e1306c,#833ab4);border:none;width:100%;padding:13px">
      💾 حفظ الإعدادات
    </button>
  </div>
</div>

<!-- ── تغيير الكوكيز (Hot Reload) ──────────────────────────────────────────── -->
<!-- @added DJAMEL — apply new cookies without restarting the bot -->
<div class="card" style="max-width:620px;margin-top:24px">
  <div class="card-header">
    <div class="card-title" style="background:linear-gradient(90deg,#e1306c,#833ab4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">
      🍪 تغيير الكوكيز (بدون إعادة تشغيل)
    </div>
  </div>
  <div style="padding:24px;display:flex;flex-direction:column;gap:16px">
    <div style="font-size:.83rem;color:var(--text2);line-height:1.6">
      الصق هنا محتوى ملف الكوكيز المُصدَّر من <strong>Cookie-Editor</strong> بصيغة JSON.<br>
      سيتم تطبيق الكوكيز الجديدة مباشرةً على البوت الجاري <strong>دون إيقافه</strong>.
    </div>

    <div style="background:rgba(225,48,108,.06);border:1px solid rgba(225,48,108,.15);border-radius:12px;padding:14px;font-size:.79rem;color:var(--text3)">
      💡 <strong>كيف تصدّر الكوكيز:</strong><br>
      1. افتح <code>instagram.com</code> في Chrome وسجّل الدخول<br>
      2. ثبّت إضافة <strong>Cookie-Editor</strong> من متجر Chrome<br>
      3. افتح الإضافة → اضغط <em>Export → Export as JSON</em><br>
      4. الصق النص كاملاً في الحقل أدناه
    </div>

    <div>
      <label style="font-size:.84rem;color:var(--text2);display:block;margin-bottom:6px">محتوى ملف الكوكيز (JSON)</label>
      <textarea id="cookieJson" rows="7" placeholder='[{"name":"sessionid","value":"..."},{"name":"csrftoken","value":"..."},...]'
        style="width:100%;background:var(--bg3);border:1px solid rgba(225,48,108,.3);color:var(--text);
          border-radius:10px;padding:12px 14px;font-family:'JetBrains Mono',monospace;font-size:.75rem;
          resize:vertical;outline:none;direction:ltr"></textarea>
    </div>

    <div id="cookieFeedback" style="min-height:22px;font-size:.84rem"></div>

    <div style="display:flex;gap:10px">
      <button class="btn btn-primary" onclick="applyHotCookies()" style="
        background:linear-gradient(135deg,#e1306c,#833ab4);border:none;flex:1;padding:12px">
        🔥 تطبيق الكوكيز الآن
      </button>
      <button class="btn btn-outline" onclick="document.getElementById('cookieJson').value='';document.getElementById('cookieFeedback').innerHTML=''">
        🗑️ مسح
      </button>
    </div>
  </div>
</div>

<script>
function togglePw() {
  const f = document.getElementById('cfg-password');
  f.type = f.type === 'password' ? 'text' : 'password';
}
async function saveSettings() {
  const fb = document.getElementById('saveFeedback');
  fb.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';
  const pw = document.getElementById('cfg-password').value.trim();
  const admins = document.getElementById('cfg-admins').value.split(',').map(x => x.trim()).filter(Boolean);
  const payload = {
    username:       document.getElementById('cfg-username').value.trim(),
    prefix:         document.getElementById('cfg-prefix').value.trim() || '!',
    adminIds:       admins,
    replyInGroups:  document.getElementById('cfg-groups').checked,
    replyInDMs:     document.getElementById('cfg-dms').checked,
    typing:         document.getElementById('cfg-typing').checked,
    openrouterKey:  document.getElementById('cfg-openrouter').value.trim(),
  };
  if (pw) payload.password = pw;
  const r = await fetch('/api/insta/save-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json();
  if (d.ok) {
    fb.innerHTML = '<span style="color:var(--green)">✅ تم الحفظ' + (d.needsRestart ? ' — البوت سيُعاد تشغيله تلقائياً' : '') + '</span>';
    showToast('✅ تم الحفظ', 'success');
    if (d.needsRestart) setTimeout(() => location.reload(), 4000);
  } else {
    fb.innerHTML = '<span style="color:var(--red)">❌ ' + (d.error || 'فشل الحفظ') + '</span>';
  }
}

async function applyHotCookies() {
  const fb  = document.getElementById('cookieFeedback');
  const raw = document.getElementById('cookieJson').value.trim();
  if (!raw) { fb.innerHTML = '<span style="color:var(--red)">❌ الحقل فارغ — الصق محتوى ملف الكوكيز</span>'; return; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { fb.innerHTML = '<span style="color:var(--red)">❌ JSON غير صالح: ' + e.message + '</span>'; return; }

  // Validate it has sessionid
  const arr = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
  const hasSession = Array.isArray(arr) ? arr.some(c => (c.name || c.key) === 'sessionid') : Object.keys(parsed).includes('sessionid');
  if (!hasSession) { fb.innerHTML = '<span style="color:var(--red)">❌ الملف لا يحتوي على sessionid — تأكد من تصدير الكوكيز من instagram.com</span>'; return; }

  fb.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ التطبيق...</span>';
  try {
    const r = await fetch('/api/insta/update-cookies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: parsed })
    });
    const d = await r.json();
    if (d.ok) {
      fb.innerHTML = '<span style="color:var(--green)">✅ تم تطبيق الكوكيز — @' + (d.username || '?') + ' (' + (d.uid || '') + ')</span>';
      showToast('✅ كوكيز مُحدَّثة بنجاح — @' + (d.username || '?'), 'success');
      setTimeout(() => location.reload(), 2500);
    } else {
      const msg = d.error || d.message || 'فشل';
      fb.innerHTML = '<span style="color:var(--red)">❌ ' + msg + '</span>';
      showToast('❌ ' + msg, 'error');
    }
  } catch (e) {
    fb.innerHTML = '<span style="color:var(--red)">❌ شبكة: ' + e.message + '</span>';
  }
}
</script>`;

    res.send(layout('ZAO-INSTA — الإعدادات', body, 'insta', pageOpts()));
  });

  // ─── API ENDPOINTS ────────────────────────────────────────────────────────────
  app.get('/api/insta/status', auth, (req, res) => {
    proxyInsta(instaApiPort, 'GET', '/insta/status', null, res);
  });

  app.post('/api/insta/restart', auth, (req, res) => {
    proxyInsta(instaApiPort, 'POST', '/insta/restart', {}, res);
  });

  app.post('/api/insta/reload', auth, (req, res) => {
    proxyInsta(instaApiPort, 'POST', '/insta/reload-cmds', {}, res);
  });

  app.post('/api/insta/send', auth, (req, res) => {
    const { threadId, message } = req.body || {};
    proxyInsta(instaApiPort, 'POST', '/insta/send', { threadId, message }, res);
  });

  app.post('/api/insta/save-settings', auth, async (req, res) => {
    try {
      const current = readInstaSettings();
      const update  = req.body || {};
      const merged  = { ...current, ...update };
      writeInstaSettings(merged);
      // Also push to running bot
      proxyInsta(instaApiPort, 'POST', '/insta/save-settings', merged, res);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  app.get('/api/insta/threads', auth, (req, res) => {
    proxyInsta(instaApiPort, 'GET', '/insta/threads', null, res);
  });

  // @added DJAMEL — hot cookie reload: saves + applies cookies to running bot
  app.post('/api/insta/update-cookies', auth, async (req, res) => {
    try {
      const { cookies } = req.body || {};
      if (!cookies) return res.json({ error: 'cookies field required' });

      // Save INSTA-APPSTATE.json on panel server side too (as backup)
      try {
        const dir = require('path').dirname(APPSTATE_FILE);
        fs.mkdirSync(dir, { recursive: true });
        const data = Array.isArray(cookies) ? cookies : { cookies };
        fs.writeFileSync(APPSTATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
      } catch (_) {}

      // Forward to bot's hot-reload endpoint
      proxyInsta(instaApiPort, 'POST', '/insta/reload-cookies', { cookies }, res);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // ── Challenge code submit — proxied to INSTA.js for identity verification ──
  // @added DJAMEL — panel submits Instagram 6-digit security code from Overview banner
  app.post('/api/insta/challenge-submit', auth, (req, res) => {
    const code = String((req.body || {}).code || '').trim();
    if (!code) return res.json({ error: 'code field required' });
    proxyInsta(instaApiPort, 'POST', '/insta/challenge-submit', { code }, res);
  });

  // ── Challenge status — returns whether a challenge is pending ───────────────
  app.get('/api/insta/challenge-status', auth, (req, res) => {
    proxyInsta(instaApiPort, 'GET', '/insta/challenge-status', null, res);
  });
};
