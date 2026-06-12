"use strict";
const express  = require("express");
const session  = require("express-session");
const fs       = require("fs");
const path     = require("path");
const http     = require("http");
const crypto   = require("crypto");

// ─── Login Rate Limiter (in-memory, no extra deps) ────────────────────────────
// 5 failed attempts per IP within 15 minutes → locked out for 15 minutes.
const _loginAttempts = new Map(); // ip → { count, firstTs, lockedUntil }
const _LOGIN_MAX     = 5;
const _LOGIN_WIN_MS  = 15 * 60 * 1000;
const _LOGIN_LOCK_MS = 15 * 60 * 1000;

function _loginRateLimit(req, res, next) {
  const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let rec   = _loginAttempts.get(ip);

  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    const remainSec = Math.ceil((rec.lockedUntil - now) / 1000);
    return res.status(429).send(`<!DOCTYPE html><html dir="rtl"><body style="font-family:sans-serif;background:#080a16;color:#ff3b6e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>❌ محظور مؤقتاً</h2><p>تجاوزت الحد المسموح به من المحاولات.<br>انتظر <strong>${remainSec}</strong> ثانية ثم أعد المحاولة.</p></div></body></html>`);
  }

  if (!rec || now - rec.firstTs > _LOGIN_WIN_MS) {
    rec = { count: 0, firstTs: now, lockedUntil: 0 };
  }

  req._loginIp  = ip;
  req._loginRec = rec;
  next();
}

function _loginRecordFailure(req) {
  const rec = req._loginRec;
  if (!rec) return;
  rec.count++;
  if (rec.count >= _LOGIN_MAX) rec.lockedUntil = Date.now() + _LOGIN_LOCK_MS;
  _loginAttempts.set(req._loginIp, rec);
}

function _loginRecordSuccess(req) {
  if (req._loginIp) _loginAttempts.delete(req._loginIp);
}

// Prune stale records every 30 minutes so the Map never grows forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _loginAttempts.entries()) {
    if (now - rec.firstTs > _LOGIN_LOCK_MS * 2) _loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

const ROOT = path.join(__dirname, "..");

// ─── Notification Ring ────────────────────────────────────────────────────────
const NOTIF_MAX  = 80;
const _notifRing = [];
let   _notifSeq  = 0;
const _notifSSE  = new Set();

function _pushNotif(level, msg) {
  const n = { id: ++_notifSeq, ts: Date.now(), level, msg: String(msg).substring(0, 280) };
  if (_notifRing.length >= NOTIF_MAX) _notifRing.shift();
  _notifRing.push(n);
  for (const res of _notifSSE) {
    try { res.write(`data: ${JSON.stringify(n)}\n\n`); } catch(_) { _notifSSE.delete(res); }
  }
}

function htmlEscape(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function getUptime(startMs) {
  const s   = Math.floor((Date.now() - startMs) / 1000);
  const d   = Math.floor(s / 86400);
  const h   = Math.floor((s % 86400) / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return d ? `${d}d ${h}h ${m}m ${sec}s` : `${h}h ${m}m ${sec}s`;
}

function colorLog(line) {
  const esc = htmlEscape(line);
  if (/\[\s*PROTECT\s*\]|\[\s*ZAO\s*\]|\[\s*WATCHDOG\s*\]|\[\s*STEALTH\s*\]|\[\s*HEALTH\s*\]|\[\s*SESSION\s*\]|\[\s*SYNC\s*\]|\[\s*LABYRINTH\s*\]|📌|INFO|MQTT|MOTOR|RECONNECT/.test(line)) return `<span class="log-info">${esc}</span>`;
  if (/❌|\bERROR\b/.test(line))             return `<span class="log-error">${esc}</span>`;
  if (/⚠️|\bWARN\b/.test(line))              return `<span class="log-warn">${esc}</span>`;
  if (/✅|SUCCESS|connected/.test(line))     return `<span class="log-ok">${esc}</span>`;
  return `<span class="log-dim">${esc}</span>`;
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function layout(title, body, activeTab = "", opts = {}) {
  const isBotOnline = opts.botOnline || false;
  const tabs = [
    ["status",        "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6", "الرئيسية"],
    ["logs",          "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z", "السجلات"],
    ["commands",      "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z", "الأوامر"],
    ["scheduler",     "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z", "الجدولة"],
    ["hold",          "M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z", "التحكم"],
    ["config",        "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z", "الإعدادات"],
    ["tier-settings", "M4 6h16M4 12h16M4 18h7", "إعدادات التيرات"],
    ["groups",        "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z", "الغروبات"],
    ["health",        "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z", "الصحة"],
    ["readiness",     "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", "الجاهزية"],
    ["notifications", "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9", "الإشعارات"],
    ["protection",    "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z", "الحماية"],
    ["session-guard", "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z", "حارس الجلسة"],
    ["crashes",       "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z", "الأعطال"],
    ["friends",       "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z", "الأصدقاء"],
    ["social",        "M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z", "الاجتماعي"],
    ["devhub",        "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z", "مركز التطوير"],
    ["github-files",  "M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18", "ملفات GitHub"],
    ["ai-users",      "M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z", "شخصيات AI"],
    ["__sep__",       "", ""],
    ["insta",         "M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M15 13a3 3 0 11-6 0 3 3 0 016 0z", "ZAO-INSTA 📸"],
  ];

  const nav = tabs.map(([id, icon, label]) => {
    if (id === '__sep__') return `<div style="margin:8px 14px;border-top:1px solid rgba(255,255,255,.055)"></div>`;
    const isInsta = id === 'insta';
    return `
    <a href="/${id}" class="nav-item ${activeTab === id ? "active" : ""}" onclick="closeSidebar()" ${isInsta ? `style="${activeTab===id?'':'color:rgba(225,130,180,.85)'}"` : ''}>
      <span class="nav-icon-wrap" ${isInsta ? `style="background:${activeTab===id?'linear-gradient(135deg,rgba(225,48,108,.25),rgba(131,58,180,.2))':'rgba(225,48,108,.07)'};border-color:rgba(225,48,108,.15)"` : ''}>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="17" height="17"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="${icon}"/></svg>
      </span>
      <span class="nav-label">${label}</span>
      ${activeTab === id ? `<span class="nav-active-bar" ${isInsta?'style="background:linear-gradient(180deg,#e1306c,#833ab4)"':''}></span>` : ""}
    </a>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>ZAO — ${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#07080f;
  --bg2:#0d0f1c;
  --bg3:#111422;
  --bg4:#161928;
  --bg5:#1c2030;
  --glass:rgba(255,255,255,.032);
  --glass2:rgba(255,255,255,.055);
  --glass3:rgba(255,255,255,.08);
  --border:rgba(255,255,255,.065);
  --border2:rgba(255,255,255,.115);
  --border3:rgba(255,255,255,.16);
  --accent:#ff3c5f;
  --accent2:#60d0ff;
  --accent3:#ffaabb;
  --accent-glow:rgba(255,60,95,.22);
  --accent-soft:rgba(255,60,95,.08);
  --green:#30d988;
  --green-dim:#1a8c52;
  --green-bg:rgba(48,217,136,.08);
  --yellow:#f5c842;
  --yellow-bg:rgba(245,200,66,.09);
  --red:#f0536a;
  --red-bg:rgba(240,83,106,.09);
  --text:#e8eaf6;
  --text2:#8892b0;
  --text3:#3f4a68;
  --purple:#9b72f7;
  --sidebar-w:268px;
  --topbar-h:58px;
  --radius-xl:24px;
  --radius-lg:18px;
  --radius-md:13px;
  --radius-sm:9px;
  --radius-xs:6px;
  --shadow-xl:0 32px 64px rgba(0,0,0,.7),0 8px 24px rgba(0,0,0,.5);
  --shadow-lg:0 16px 40px rgba(0,0,0,.55),0 4px 12px rgba(0,0,0,.4);
  --shadow-md:0 8px 24px rgba(0,0,0,.45);
  --shadow-sm:0 2px 10px rgba(0,0,0,.35);
  --glow-blue:0 0 20px rgba(255,60,95,.28);
  --glow-ice:0 0 20px rgba(96,208,255,.22);
  --glow-green:0 0 16px rgba(48,217,136,.25);
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);font-family:'Cairo',sans-serif;
  min-height:100vh;overflow-x:hidden;
  background-image:
    radial-gradient(ellipse 70% 50% at 85% -5%,rgba(255,60,95,.06) 0%,transparent 55%),
    radial-gradient(ellipse 50% 40% at 5% 95%,rgba(96,208,255,.045) 0%,transparent 50%),
    radial-gradient(ellipse 40% 30% at 50% 50%,rgba(255,60,95,.018) 0%,transparent 60%);
}

/* ─── SCROLLBAR ─── */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2)}

/* ─── TOPBAR ─── */
.topbar{
  position:fixed;top:0;left:0;right:0;height:var(--topbar-h);
  background:rgba(7,8,15,.82);
  backdrop-filter:blur(28px) saturate(1.6);
  -webkit-backdrop-filter:blur(28px) saturate(1.6);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 18px;z-index:300;
}
.topbar::after{
  content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent 0%,rgba(255,60,95,.2) 30%,rgba(96,208,255,.15) 70%,transparent 100%);
}
.topbar-right{display:flex;align-items:center;gap:10px}
.topbar-left{display:flex;align-items:center;gap:7px}
.topbar-brand{display:flex;align-items:center;gap:9px;text-decoration:none}
.topbar-logo{
  width:34px;height:34px;
  background:#050505;
  border:1px solid rgba(255,60,95,.28);
  border-radius:10px;display:flex;align-items:center;justify-content:center;
  box-shadow:var(--glow-blue),0 0 10px rgba(96,208,255,.12),0 2px 8px rgba(0,0,0,.5);flex-shrink:0;
  transition:transform .25s cubic-bezier(.34,1.56,.64,1);
}
.topbar-logo:hover{transform:scale(1.06)}
.topbar-name{
  font-size:.92rem;font-weight:800;
  background:linear-gradient(90deg,#ff3c5f 0%,#60d0ff 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  letter-spacing:.5px;
}
.topbar-tag{font-size:.58rem;color:var(--text3);font-weight:500;margin-top:-2px;letter-spacing:.3px}
.menu-btn{
  width:34px;height:34px;border-radius:var(--radius-sm);
  border:1px solid var(--border);background:var(--glass);
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:var(--text2);transition:all .2s cubic-bezier(.4,0,.2,1);flex-shrink:0;
}
.menu-btn:hover{background:var(--glass2);color:var(--accent);border-color:rgba(61,158,255,.25)}
.menu-btn.active{background:var(--accent-soft);border-color:rgba(61,158,255,.35);color:var(--accent)}
.menu-btn svg{width:17px;height:17px}
.topbar-dot{
  width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:${isBotOnline ? "var(--green)" : "var(--red)"};
  box-shadow:${isBotOnline ? "var(--glow-green)" : "0 0 12px rgba(240,83,106,.45)"};
  animation:pulse-dot 2.5s ease-in-out infinite;
}
@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.65;transform:scale(.82)}}

/* ─── SIDEBAR BACKDROP ─── */
.sb-backdrop{
  position:fixed;inset:0;z-index:390;
  background:rgba(0,0,0,.6);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  opacity:0;pointer-events:none;
  transition:opacity .3s cubic-bezier(.4,0,.2,1);
}
.sb-backdrop.show{opacity:1;pointer-events:all}

/* ─── SIDEBAR ─── */
.sidebar{
  position:fixed;top:0;right:0;bottom:0;width:var(--sidebar-w);
  background:rgba(10,11,20,.94);
  backdrop-filter:blur(40px) saturate(1.8);
  -webkit-backdrop-filter:blur(40px) saturate(1.8);
  border-left:1px solid var(--border);
  display:flex;flex-direction:column;z-index:400;
  transform:translateX(102%);
  transition:transform .38s cubic-bezier(.4,0,.2,1);
  box-shadow:var(--shadow-xl);overflow:hidden;
}
.sidebar.open{transform:translateX(0)}
.sidebar-head{
  padding:18px 14px 14px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
  background:rgba(255,255,255,.018);
}
.sb-brand{display:flex;align-items:center;gap:10px}
.sb-logo{
  width:40px;height:40px;
  background:#050505;
  border:1px solid rgba(255,60,95,.3);
  border-radius:12px;display:flex;align-items:center;justify-content:center;
  box-shadow:var(--glow-blue),0 0 12px rgba(96,208,255,.12),0 4px 12px rgba(0,0,0,.5);flex-shrink:0;
}
.sb-title{font-size:1rem;font-weight:800;letter-spacing:.3px;
  background:linear-gradient(90deg,#ff3c5f,#60d0ff);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.sb-ver{font-size:.63rem;color:var(--text3);margin-top:2px;font-weight:500;letter-spacing:.4px}
.sb-close{
  width:28px;height:28px;border-radius:var(--radius-xs);border:1px solid var(--border);
  background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:var(--text3);transition:all .2s;flex-shrink:0;
}
.sb-close:hover{background:var(--red-bg);border-color:rgba(240,83,106,.3);color:var(--red)}
.sb-status{
  margin:12px 12px 0;display:flex;align-items:center;gap:8px;padding:9px 12px;
  background:${isBotOnline ? "rgba(48,217,136,.06)" : "rgba(240,83,106,.06)"};
  border:1px solid ${isBotOnline ? "rgba(48,217,136,.18)" : "rgba(240,83,106,.18)"};
  border-radius:var(--radius-sm);
}
.sb-status-dot{
  width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:${isBotOnline ? "var(--green)" : "var(--red)"};
  box-shadow:${isBotOnline ? "var(--glow-green)" : "0 0 8px rgba(240,83,106,.5)"};
  animation:pulse-dot 2.5s ease-in-out infinite;
}
.sb-status-txt{font-size:.78rem;font-weight:700;color:${isBotOnline ? "var(--green)" : "var(--red)"}; letter-spacing:.3px}
.sb-section-lbl{
  padding:14px 14px 5px;font-size:.58rem;color:var(--text3);
  text-transform:uppercase;letter-spacing:1.8px;font-weight:700;flex-shrink:0;
}
.sb-nav{flex:1;overflow-y:auto;padding:3px 8px;overscroll-behavior:contain}
.sb-nav::-webkit-scrollbar{width:0}
.nav-item{
  display:flex;align-items:center;gap:9px;padding:8px 9px;margin-bottom:1px;
  border-radius:var(--radius-sm);color:var(--text2);text-decoration:none;
  font-size:.83rem;font-weight:500;
  transition:all .2s cubic-bezier(.4,0,.2,1);
  cursor:pointer;position:relative;
}
.nav-item:hover{color:var(--text);background:var(--glass2)}
.nav-item.active{
  color:var(--accent2);background:var(--accent-soft);font-weight:700;
  box-shadow:inset 0 0 0 1px rgba(61,158,255,.14);
}
.nav-icon-wrap{
  width:28px;height:28px;border-radius:7px;
  display:flex;align-items:center;justify-content:center;
  background:var(--glass);flex-shrink:0;transition:all .2s;
}
.nav-item:hover .nav-icon-wrap{background:var(--glass2)}
.nav-item.active .nav-icon-wrap{
  background:rgba(61,158,255,.14);
  box-shadow:0 0 12px rgba(61,158,255,.18);
}
.nav-item svg{opacity:.65;transition:opacity .2s}
.nav-item.active svg,.nav-item:hover svg{opacity:1}
.nav-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-active-bar{
  width:3px;height:16px;border-radius:2px;
  background:var(--accent);flex-shrink:0;
  box-shadow:var(--glow-blue);
}
.sb-footer{padding:10px 8px;border-top:1px solid var(--border);flex-shrink:0;background:rgba(255,255,255,.01)}
.sb-logout{
  display:flex;align-items:center;gap:9px;padding:9px 9px;border-radius:var(--radius-sm);
  color:var(--text3);text-decoration:none;font-size:.82rem;font-weight:500;transition:all .2s;
}
.sb-logout:hover{background:var(--red-bg);color:var(--red)}
.sb-logout .nav-icon-wrap{background:var(--glass)}
.sb-logout:hover .nav-icon-wrap{background:rgba(240,83,106,.12)}

/* ─── MAIN ─── */
.main{
  padding:calc(var(--topbar-h) + 22px) 26px 44px;
  min-height:100vh;max-width:1240px;margin:0 auto;
}

/* ─── PAGE HEADER ─── */
.page-header{margin-bottom:24px}
.page-title{
  font-size:1.35rem;font-weight:800;color:var(--text);
  letter-spacing:-.4px;display:flex;align-items:center;gap:10px;
}
.page-title-icon{
  width:34px;height:34px;border-radius:10px;
  background:var(--accent-soft);
  border:1px solid rgba(61,158,255,.2);
  display:flex;align-items:center;justify-content:center;
  font-size:.95rem;flex-shrink:0;
}
.page-sub{font-size:.8rem;color:var(--text3);margin-top:5px;font-weight:400;padding-right:44px}

/* ─── GLASS CARDS ─── */
.card{
  background:var(--glass);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  padding:20px;margin-bottom:14px;
  transition:border-color .3s,box-shadow .3s;
  position:relative;overflow:hidden;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent 10%,rgba(255,255,255,.06) 50%,transparent 90%);
}
.card:hover{border-color:var(--border2);box-shadow:0 4px 24px rgba(0,0,0,.2)}
.card-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:16px;gap:10px;
}
.card-title{
  font-size:.9rem;font-weight:700;color:var(--text);
  display:flex;align-items:center;gap:7px;
}

/* ─── STATS GRID ─── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-bottom:18px}
.stat{
  background:var(--glass);
  border:1px solid var(--border);
  border-radius:var(--radius-md);padding:16px;
  position:relative;overflow:hidden;
  transition:all .28s cubic-bezier(.4,0,.2,1);
  cursor:default;
}
.stat:hover{
  border-color:var(--border2);
  transform:translateY(-3px);
  box-shadow:var(--shadow-md);
}
.stat-glow{
  position:absolute;top:-24px;right:-24px;
  width:80px;height:80px;border-radius:50%;
  opacity:.12;filter:blur(22px);pointer-events:none;
  transition:opacity .3s;
}
.stat:hover .stat-glow{opacity:.22}
.stat-icon{font-size:1.2rem;margin-bottom:9px;line-height:1}
.stat-val{
  font-size:1.55rem;font-weight:900;color:var(--text);
  line-height:1;letter-spacing:-.6px;
}
.stat-lbl{font-size:.69rem;color:var(--text3);margin-top:5px;font-weight:600;letter-spacing:.3px;text-transform:uppercase}
.stat-cyan .stat-glow{background:#3d9eff}
.stat-cyan:hover{border-color:rgba(61,158,255,.22);box-shadow:0 8px 24px rgba(61,158,255,.08)}
.stat-green .stat-glow{background:#30d988}
.stat-green:hover{border-color:rgba(48,217,136,.22);box-shadow:0 8px 24px rgba(48,217,136,.08)}
.stat-purple .stat-glow{background:#9b72f7}
.stat-purple:hover{border-color:rgba(155,114,247,.22);box-shadow:0 8px 24px rgba(155,114,247,.08)}
.stat-red .stat-glow{background:#f0536a}
.stat-red:hover{border-color:rgba(240,83,106,.22);box-shadow:0 8px 24px rgba(240,83,106,.08)}

/* ─── BADGES ─── */
.badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 10px;border-radius:20px;
  font-size:.72rem;font-weight:700;letter-spacing:.3px;
}
.badge-green{background:var(--green-bg);color:var(--green);border:1px solid rgba(48,217,136,.22)}
.badge-red{background:var(--red-bg);color:var(--red);border:1px solid rgba(240,83,106,.22)}
.badge-yellow{background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(245,200,66,.22)}
.badge-blue{background:var(--accent-soft);color:var(--accent2);border:1px solid rgba(61,158,255,.22)}
.badge-purple{background:rgba(155,114,247,.09);color:var(--purple);border:1px solid rgba(155,114,247,.22)}

/* ─── TABLE ─── */
.table{width:100%;border-collapse:collapse}
.table th{
  color:var(--text3);font-size:.7rem;text-transform:uppercase;
  letter-spacing:.8px;padding:9px 13px;text-align:right;
  border-bottom:1px solid var(--border);font-weight:700;
}
.table td{
  padding:11px 13px;border-bottom:1px solid var(--border);
  font-size:.85rem;color:var(--text);line-height:1.5;
}
.table tr:last-child td{border-bottom:none}
.table tr:hover td{background:rgba(255,255,255,.018)}
.table-wrap{overflow-x:auto;overflow-y:visible;border-radius:var(--radius-sm);-webkit-overflow-scrolling:touch}

/* ─── FORMS ─── */
.form-group{margin-bottom:14px}
.form-label{display:block;font-size:.78rem;color:var(--text2);margin-bottom:6px;font-weight:600;letter-spacing:.2px}
.form-control{
  width:100%;
  background:rgba(255,255,255,.04);
  border:1px solid var(--border);
  color:var(--text);
  border-radius:var(--radius-sm);
  padding:9px 12px;font-size:.85rem;
  font-family:'Cairo',sans-serif;
  transition:all .22s;outline:none;line-height:1.5;
}
.form-control:focus{
  border-color:rgba(61,158,255,.45);
  box-shadow:0 0 0 3px rgba(61,158,255,.12),0 0 0 1px rgba(61,158,255,.2);
  background:rgba(61,158,255,.04);
}
.form-control::placeholder{color:var(--text3)}
textarea.form-control{resize:vertical;line-height:1.6}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}

/* ─── BUTTONS ─── */
.btn{
  display:inline-flex;align-items:center;gap:6px;padding:8px 16px;
  border-radius:var(--radius-sm);font-size:.83rem;font-weight:700;
  font-family:'Cairo',sans-serif;cursor:pointer;border:none;
  transition:all .22s cubic-bezier(.4,0,.2,1);text-decoration:none;white-space:nowrap;
  letter-spacing:.2px;
}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent2);transform:translateY(-1px);box-shadow:0 4px 18px rgba(61,158,255,.4)}
.btn-success{background:var(--green);color:#000;color:rgba(0,0,0,.85)}
.btn-success:hover{background:#3de898;transform:translateY(-1px);box-shadow:0 4px 18px rgba(48,217,136,.35)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{background:#f5677b;transform:translateY(-1px);box-shadow:0 4px 18px rgba(240,83,106,.4)}
.btn-purple{background:var(--purple);color:#fff}
.btn-purple:hover{background:#b08bfa;transform:translateY(-1px);box-shadow:0 4px 18px rgba(155,114,247,.4)}
.btn-outline{
  background:transparent;color:var(--text2);
  border:1px solid var(--border);
}
.btn-outline:hover{background:var(--glass2);color:var(--text);border-color:var(--border2)}
.btn-sm{padding:5px 12px;font-size:.76rem}
.btn-icon{width:32px;height:32px;padding:0;justify-content:center;border-radius:var(--radius-sm)}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}

/* ─── CONTROL BUTTONS ─── */
.control-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}
.control-btn{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:9px;padding:20px 12px;border-radius:var(--radius-md);
  border:1px solid var(--border);
  cursor:pointer;transition:all .25s cubic-bezier(.4,0,.2,1);
  text-decoration:none;font-family:'Cairo',sans-serif;
  background:var(--glass);color:var(--text2);
  font-size:.83rem;font-weight:600;
}
.control-btn:hover{transform:translateY(-2px);box-shadow:var(--shadow-md)}
.control-btn .icon{font-size:1.65rem;line-height:1;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.control-btn:hover .icon{transform:scale(1.1)}
.control-btn.cyan{border-color:rgba(61,158,255,.2);color:var(--accent2)}
.control-btn.cyan:hover{background:rgba(61,158,255,.06);box-shadow:0 8px 24px rgba(61,158,255,.12),var(--shadow-sm)}
.control-btn.green{border-color:rgba(48,217,136,.2);color:var(--green)}
.control-btn.green:hover{background:rgba(48,217,136,.06);box-shadow:0 8px 24px rgba(48,217,136,.12),var(--shadow-sm)}
.control-btn.red{border-color:rgba(240,83,106,.2);color:var(--red)}
.control-btn.red:hover{background:rgba(240,83,106,.06);box-shadow:0 8px 24px rgba(240,83,106,.12),var(--shadow-sm)}
.control-btn.yellow{border-color:rgba(245,200,66,.2);color:var(--yellow)}
.control-btn.yellow:hover{background:rgba(245,200,66,.06);box-shadow:0 8px 24px rgba(245,200,66,.12),var(--shadow-sm)}
.control-btn.purple{border-color:rgba(155,114,247,.2);color:var(--purple)}
.control-btn.purple:hover{background:rgba(155,114,247,.06);box-shadow:0 8px 24px rgba(155,114,247,.12),var(--shadow-sm)}

/* ─── LOGS ─── */
.log-box{
  background:rgba(4,4,10,.9);
  border:1px solid var(--border);border-radius:var(--radius-md);
  padding:14px 16px;font-family:'Courier New',monospace;font-size:.74rem;
  max-height:520px;overflow-y:auto;white-space:pre-wrap;line-height:1.8;
}
.log-error{color:#f5677b}
.log-warn{color:#f5c842}
.log-ok{color:#30d988}
.log-info{color:#5aadff}
.log-dim{color:#7a8aaa}

/* ─── TOGGLE ─── */
.toggle-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:11px 0;border-bottom:1px solid var(--border);
}
.toggle-row:last-child{border-bottom:none}
.toggle-info{font-size:.85rem;color:var(--text);font-weight:500}
.toggle-sub{font-size:.72rem;color:var(--text3);margin-top:2px}
.toggle{position:relative;display:inline-block;width:42px;height:23px;flex-shrink:0}
.toggle input{display:none}
.slider{
  position:absolute;cursor:pointer;inset:0;
  background:rgba(255,255,255,.08);border-radius:23px;
  transition:.28s cubic-bezier(.4,0,.2,1);
  border:1px solid var(--border);
}
.slider:before{
  position:absolute;content:"";height:17px;width:17px;
  left:2px;bottom:2px;background:rgba(255,255,255,.7);
  border-radius:50%;transition:.28s cubic-bezier(.4,0,.2,1);
  box-shadow:0 2px 6px rgba(0,0,0,.3);
}
input:checked+.slider{background:var(--accent);border-color:var(--accent)}
input:checked+.slider:before{transform:translateX(19px);background:#fff}
.divider{border:none;border-top:1px solid var(--border);margin:16px 0}

/* ─── CODE ─── */
code{
  background:rgba(61,158,255,.08);color:var(--accent3);
  padding:2px 7px;border-radius:5px;font-size:.79rem;
  font-family:'Courier New',monospace;
  border:1px solid rgba(61,158,255,.14);
}
.gradient-text{
  background:linear-gradient(90deg,var(--accent3) 0%,#c5b0ff 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}

/* ─── TOAST ─── */
#toast-container{
  position:fixed;bottom:26px;left:22px;z-index:9999;
  display:flex;flex-direction:column;gap:8px;pointer-events:none;
}
.toast-msg{
  padding:11px 16px;border-radius:var(--radius-md);
  font-size:.82rem;font-weight:600;
  display:flex;align-items:center;gap:9px;
  animation:toast-spring .38s cubic-bezier(.34,1.56,.64,1);
  box-shadow:var(--shadow-lg);pointer-events:all;max-width:320px;
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
}
.toast-success{
  background:rgba(10,28,20,.9);
  border:1px solid rgba(48,217,136,.22);color:var(--green);
}
.toast-error{
  background:rgba(28,10,14,.9);
  border:1px solid rgba(240,83,106,.22);color:#f5a0ae;
}
.toast-info{
  background:rgba(8,16,32,.9);
  border:1px solid rgba(61,158,255,.22);color:var(--accent3);
}
@keyframes toast-spring{
  from{opacity:0;transform:translateY(14px) scale(.88)}
  to{opacity:1;transform:translateY(0) scale(1)}
}

/* ─── NOTIFICATION PANEL ─── */
.notif-panel{
  position:fixed;top:66px;left:14px;width:360px;
  max-width:calc(100vw - 28px);z-index:9500;
  background:rgba(10,12,22,.94);
  backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
  border:1px solid var(--border2);border-radius:var(--radius-lg);
  box-shadow:var(--shadow-xl);overflow:hidden;
  max-height:480px;flex-direction:column;display:none;
  animation:panel-in .25s cubic-bezier(.4,0,.2,1);
}
@keyframes panel-in{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}

/* ─── MOBILE BOTTOM NAV ─── */
.mobile-nav{
  display:none;position:fixed;bottom:0;left:0;right:0;
  height:calc(62px + env(safe-area-inset-bottom,0px));
  background:rgba(7,8,15,.9);
  backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
  border-top:1px solid var(--border);
  flex-direction:row;align-items:flex-start;justify-content:space-around;
  z-index:200;padding:8px 0 env(safe-area-inset-bottom,0px);
}
.mob-nav-item{
  display:flex;flex-direction:column;align-items:center;gap:3px;
  text-decoration:none;color:var(--text3);font-size:.56rem;
  font-weight:700;flex:1;padding:4px 0;
  transition:color .2s;position:relative;letter-spacing:.2px;
}
.mob-nav-item.active{color:var(--accent2)}
.mob-nav-item.active::before{
  content:'';position:absolute;top:-8px;left:35%;right:35%;height:2px;
  background:linear-gradient(90deg,var(--accent),var(--purple));
  border-radius:0 0 3px 3px;
}
.mob-nav-item svg{width:20px;height:20px;transition:transform .2s cubic-bezier(.34,1.56,.64,1)}
.mob-nav-item.active svg{transform:scale(1.12)}

/* ─── MODAL BASE ─── */
.modal-glass{
  position:fixed;inset:0;z-index:9000;
  background:rgba(0,0,0,.75);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  align-items:center;justify-content:center;
}
.modal-glass-box{
  background:rgba(12,14,24,.96);
  backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
  border:1px solid var(--border2);border-radius:var(--radius-xl);
  box-shadow:var(--shadow-xl);overflow:hidden;
}

/* ─── RESPONSIVE ─── */
@media(max-width:768px){
  .main{padding:calc(var(--topbar-h) + 12px) 13px calc(80px + env(safe-area-inset-bottom,0px))}
  .mobile-nav{display:flex}
  .stats-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .control-panel{grid-template-columns:repeat(2,1fr)}
  .page-title{font-size:1.15rem}
  .card{padding:14px;margin-bottom:11px}
  #toast-container{left:10px;right:10px;bottom:calc(74px + env(safe-area-inset-bottom,0px))}
  .toast-msg{max-width:100%}
}
@media(prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
</style>
</head>
<body>
<script>
function openSidebar(){var s=document.getElementById('mainSidebar'),b=document.getElementById('sbBackdrop'),m=document.getElementById('menuBtn');if(!s)return;s.classList.add('open');if(b)b.classList.add('show');if(m)m.classList.add('active');document.body.style.overflow='hidden'}
function closeSidebar(){var s=document.getElementById('mainSidebar'),b=document.getElementById('sbBackdrop'),m=document.getElementById('menuBtn');if(!s)return;s.classList.remove('open');if(b)b.classList.remove('show');if(m)m.classList.remove('active');document.body.style.overflow=''}
function toggleSidebar(){var s=document.getElementById('mainSidebar');if(s&&s.classList.contains('open'))closeSidebar();else openSidebar()}
</script>

<div class="sb-backdrop" id="sbBackdrop" onclick="closeSidebar()"></div>

<header class="topbar">
  <div class="topbar-right">
    <button class="menu-btn" id="menuBtn" onclick="toggleSidebar()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="6.5" x2="21" y2="6.5"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17.5" x2="21" y2="17.5"/></svg>
    </button>
    <a class="topbar-brand" href="/status">
      <div class="topbar-logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M1 12s4.5-9 11-9 11 9 11 9-4.5 9-11 9S1 12 1 12z" stroke="rgba(255,255,255,.9)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="4" stroke="rgba(255,255,255,.9)" stroke-width="1.5"/><circle cx="12" cy="12" r="1.8" fill="rgba(255,255,255,.9)"/></svg></div>
      <div>
        <div class="topbar-name">ZAO</div>
      </div>
    </a>
  </div>
  <div class="topbar-left">
    <span class="topbar-page" style="display:none" id="pageLabel">${title}</span>
    <button id="langToggleBtn" onclick="toggleLang()" title="AR / EN" style="background:var(--glass);border:1px solid var(--border);color:var(--text2);border-radius:var(--radius-xs);padding:4px 9px;font-size:.72rem;font-weight:700;cursor:pointer;font-family:'Cairo',sans-serif;transition:all .2s;letter-spacing:.5px">EN</button>
    <div style="position:relative">
      <button class="menu-btn" id="notifBtn" onclick="toggleNotifPanel()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
      </button>
      <span id="notifBadge" style="display:none;position:absolute;top:-4px;left:-4px;min-width:16px;height:16px;border-radius:8px;background:var(--red);color:#fff;font-size:.55rem;font-weight:800;align-items:center;justify-content:center;line-height:1;border:2px solid var(--bg);padding:0 3px">0</span>
    </div>
    <div class="topbar-dot" title="${isBotOnline ? "البوت متصل" : "البوت غير متصل"}"></div>
  </div>
</header>

<div class="notif-panel" id="notifPanel">
  <div style="padding:13px 15px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:rgba(255,255,255,.02)">
    <span style="font-size:.85rem;font-weight:700;display:flex;align-items:center;gap:7px">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
      الإشعارات
    </span>
    <div style="display:flex;gap:7px;align-items:center">
      <button onclick="clearNotifs()" style="font-size:.7rem;color:var(--text3);background:var(--glass);border:1px solid var(--border);border-radius:var(--radius-xs);padding:3px 9px;cursor:pointer;font-family:'Cairo',sans-serif;transition:all .2s">مسح الكل</button>
      <button onclick="toggleNotifPanel()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:1rem;line-height:1;padding:2px;transition:color .2s" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text3)'">✕</button>
    </div>
  </div>
  <div id="notifList" style="overflow-y:auto;flex:1;padding:8px"></div>
  <div id="notifEmpty" style="padding:32px;text-align:center;color:var(--text3);font-size:.83rem">لا توجد إشعارات</div>
</div>

<aside class="sidebar" id="mainSidebar">
  <div class="sidebar-head">
    <div class="sb-brand">
      <div class="sb-logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M1 12s4.5-9 11-9 11 9 11 9-4.5 9-11 9S1 12 1 12z" stroke="rgba(255,255,255,.88)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="4" stroke="rgba(255,255,255,.88)" stroke-width="1.5"/><circle cx="12" cy="12" r="1.8" fill="rgba(255,255,255,.88)"/></svg></div>
      <div>
        <div class="sb-title">ZAO Panel</div>
        <div class="sb-ver">ZAO Bot v1.8 · Admin</div>
      </div>
    </div>
    <button class="sb-close" onclick="closeSidebar()">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="sb-status">
    <div class="sb-status-dot"></div>
    <span class="sb-status-txt">${isBotOnline ? "متصل ومستعد" : "البوت غير متصل"}</span>
  </div>
  <div class="sb-section-lbl">التنقل</div>
  <nav class="sb-nav">${nav}</nav>
  <div class="sb-footer">
    <a class="sb-logout" href="/logout">
      <span class="nav-icon-wrap">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
      </span>
      <span class="nav-label">تسجيل الخروج</span>
    </a>
    <div style="padding:8px 9px 2px;font-size:.59rem;color:var(--text3);text-align:center;border-top:1px solid var(--border);margin-top:6px;line-height:1.8;letter-spacing:.3px">
      © ${new Date().getFullYear()} <strong style="background:linear-gradient(90deg,#ff3c5f,#60d0ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">ZAO</strong> · ZAO Bot
    </div>
  </div>
</aside>

<nav class="mobile-nav">
  <a href="/status" class="mob-nav-item ${activeTab==="status"?"active":""}">
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
    الرئيسية
  </a>
  <a href="/logs" class="mob-nav-item ${activeTab==="logs"?"active":""}">
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
    السجلات
  </a>
  <a href="/commands" class="mob-nav-item ${activeTab==="commands"?"active":""}">
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
    الأوامر
  </a>
  <a href="/config" class="mob-nav-item ${activeTab==="config"?"active":""}">
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
    إعدادات
  </a>
  <a href="/devhub" class="mob-nav-item ${activeTab==="devhub"?"active":""}">
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
    DevHub
  </a>
</nav>

<main class="main">
  <div id="toast-container"></div>
  ${body}
</main>

<script>
function showToast(msg,type='success'){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className='toast-msg toast-'+type;
  t.innerHTML=msg;
  c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transform='translateY(8px)';t.style.transition='opacity .3s,transform .3s';setTimeout(()=>t.remove(),300);},3800);
}
function _getCsrf(){try{const m=document.cookie.match(/(?:^|;\s*)_csrf=([^;]+)/);return m?decodeURIComponent(m[1]):''}catch(_){return''}}
async function api(url,data,method='POST'){
  try{
    let csrf=_getCsrf();
    const _doFetch=async(tok)=>{
      const h={'Content-Type':'application/json','X-CSRF-Token':tok};
      return await fetch(url,{method,headers:h,body:method!=='GET'?JSON.stringify(data):undefined});
    };
    let r=await _doFetch(csrf);
    if(r.status===403){
      try{
        const cr=await fetch('/api/csrf');const cd=await cr.json();
        if(cd.token){
          csrf=cd.token;
          document.cookie='_csrf='+cd.token+';path=/;samesite=lax;max-age=43200';
        }
        r=await _doFetch(csrf);
      }catch(_){}
    }
    return await r.json();
  }catch(e){return{error:e.message};}
}
const _sidebar=document.getElementById('mainSidebar');
const _backdrop=document.getElementById('sbBackdrop');
const _menuBtn=document.getElementById('menuBtn');
function openSidebar(){_sidebar.classList.add('open');_backdrop.classList.add('show');_menuBtn.classList.add('active');document.body.style.overflow='hidden'}
function closeSidebar(){_sidebar.classList.remove('open');_backdrop.classList.remove('show');_menuBtn.classList.remove('active');document.body.style.overflow=''}
function toggleSidebar(){_sidebar.classList.contains('open')?closeSidebar():openSidebar()}
function goHold(id){window.location='/hold?tid='+encodeURIComponent(id);}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSidebar()});
window.addEventListener('resize',()=>{if(window.innerWidth>900)closeSidebar()});
(function(){const lbl=document.getElementById('pageLabel');if(lbl&&window.innerWidth<500)lbl.style.display=''})();

// ── Language Toggle (AR ↔ EN) ────────────────────────────────────
const _ZAO_LANG_DICT={
  // ── Navigation ─────────────────────────────────────────────────
  'الرئيسية':'Home','السجلات':'Logs','الأوامر':'Commands','تنفيذ':'Execute',
  'الجدولة':'Scheduler','التحكم':'Control','الإعدادات':'Settings','الحسابات':'Accounts',
  'الغروبات':'Groups','الصحة':'Health','الإشعارات':'Notifications','الحماية':'Protection',
  'الأصدقاء':'Friends','الاجتماعي':'Social','مركز التطوير':'DevHub','ملفات GitHub':'GitHub Files',
  'لوحة التحكم':'Dashboard','البوت متصل ✓':'Bot Online ✓','البوت غير متصل':'Bot Offline',
  'متصل ومستعد':'Online & Ready','التنقل':'Navigation','تسجيل الخروج':'Logout',
  'ZAO Bot v1.8 · Admin':'ZAO Bot v1.8 · Admin','ZAO Panel':'ZAO Panel',
  // ── Status bar ─────────────────────────────────────────────────
  'إعادة التشغيل':'Restart','إيقاف البوت':'Stop Bot',
  'قفل الأوامر':'Lock Cmds','فتح الأوامر':'Unlock Cmds',
  'إعادة تحميل الأوامر':'Reload Cmds','هوت-ريلود كامل':'Full Hot-Reload',
  'مسح الكل':'Clear All','لا توجد إشعارات':'No notifications',
  // ── Health tab ─────────────────────────────────────────────────
  'الصحة والأداء':'Health & Performance',
  'مقاييس الأداء والاتصال — يتحدث كل 5 ثوانٍ':'Performance metrics — updates every 5 s',
  'اتصال البوت':'Bot Connection','Uptime':'Uptime','Restarts':'Restarts',
  'رسم بياني مباشر — CPU / RAM':'Live Chart — CPU / RAM',
  'تفاصيل الذاكرة':'Memory Details','حالة البوت':'Bot Status',
  'إجراءات':'Actions','تحديث فوري':'Refresh Now',
  'إعادة تشغيل البوت':'Restart Bot',
  // ── Execute tab ─────────────────────────────────────────────────
  'تنفيذ أمر':'Execute Command','أرسل أمراً أو رسالة مباشرة من اللوحة إلى أي مجموعة':'Send a command or message to any group directly',
  'تنفيذ سريع':'Quick Execute','جلب الغروبات':'Fetch Groups',
  'معرف الغروب (Thread ID)':'Group Thread ID','الأمر والمتغيرات':'Command & Args',
  'رسالة مباشرة (بديل للأمر — ترسل نصاً للغروب فوراً)':'Direct message (alternative to command)',
  'تنفيذ الأمر':'Run Command','إرسال رسالة':'Send Message',
  'إرسال رسالة جماعية':'Broadcast Message',
  'تأخير بين الرسائل (ثانية)':'Delay between messages (s)',
  'إرسال جماعي':'Send Broadcast',
  // ── Control (Hold) tab ─────────────────────────────────────────
  'التحكم المركزي':'Central Control',
  'تحكم بـ NM والكنيات والمحركات من مكان واحد':'Control NM, nicknames & motors from one place',
  'اختر الغروب':'Select Group','تحميل الحالة':'Load Status',
  'NM — قفل اسم الغروب':'NM — Group Name Lock',
  'كنيات — قفل الألقاب':'Nicknames — Lock Nicknames',
  'محرك 1 — إرسال دوري':'Motor 1 — Periodic Send',
  'محرك 2 — إرسال ذكي':'Motor 2 — Smart Send',
  'مفعل':'Active','غير مفعل':'Inactive',
  'طلبات الرسائل المعلّقة':'Pending Message Requests',
  // ── Groups tab ─────────────────────────────────────────────────
  'الغروبات المتاحة':'Available Groups',
  'جلب الغروبات من فيسبوك':'Fetch groups from Facebook',
  // ── Friends tab ─────────────────────────────────────────────────
  'إدارة الأصدقاء':'Friends Management',
  'إرسال وقبول وإزالة طلبات الصداقة — تحكم كامل من اللوحة':'Send, accept & remove friend requests',
  'طلبات الصداقة المعلّقة':'Pending Friend Requests',
  'إرسال طلب صداقة':'Send Friend Request',
  'أشخاص قد تعرفهم':'People You May Know',
  'قائمة الأصدقاء':'Friends List',
  // ── Social / Stories tab ────────────────────────────────────────
  'الاجتماعي':'Social','نشر قصة نصية':'Post Text Story',
  'الرد على قصة':'Reply to Story','تعليق على منشور':'Comment on Post',
  'متابعة / إلغاء متابعة':'Follow / Unfollow',
  'تثبيت رسالة':'Pin Message','إدارة مشرفي المجموعة':'Manage Group Admins',
  // ── Common ─────────────────────────────────────────────────────
  'تحديث':'Refresh','إلغاء':'Cancel','حفظ':'Save','تأكيد':'Confirm',
  'جارٍ التحميل...':'Loading...','لا توجد نتائج':'No results',
  'البوت غير متصل أو لم يرد في الوقت المحدد':'Bot offline or did not respond in time',
};
const _ZAO_LANG_DICT_INV=Object.fromEntries(Object.entries(_ZAO_LANG_DICT).map(([a,e])=>[e,a]));
let _zaoLang=localStorage.getItem('zao_lang')||'ar';
function _applyLang(){
  const btn=document.getElementById('langToggleBtn');
  const isEN=_zaoLang==='en';
  if(btn)btn.textContent=isEN?'AR':'EN';
  document.querySelectorAll('.nav-label,.sb-ver,.sb-status-txt,.sb-section-lbl,.sb-logout .nav-label').forEach(el=>{
    const cur=el.textContent.trim();
    const translated=isEN?(_ZAO_LANG_DICT[cur]||cur):(_ZAO_LANG_DICT_INV[cur]||cur);
    if(translated!==cur)el.textContent=translated;
  });
  document.documentElement.dir=isEN?'ltr':'rtl';
  document.documentElement.lang=isEN?'en':'ar';
}
function toggleLang(){
  _zaoLang=_zaoLang==='ar'?'en':'ar';
  try{localStorage.setItem('zao_lang',_zaoLang);}catch(_){}
  _applyLang();
}
(function(){_applyLang();})();

// ── Notification System ──────────────────────────────────────────
let _notifPanelOpen=false;
let _notifSeen=parseInt(localStorage.getItem('zao_ns')||'0');
let _notifData=[];
(function(){const p=document.getElementById('notifPanel');if(p)p.style.display='none'})();
function toggleNotifPanel(){
  _notifPanelOpen=!_notifPanelOpen;
  const p=document.getElementById('notifPanel');
  p.style.display=_notifPanelOpen?'flex':'none';
  if(_notifPanelOpen){_notifSeen=_notifData.length?_notifData[_notifData.length-1].id:_notifSeen;try{localStorage.setItem('zao_ns',_notifSeen)}catch(_){}renderNotifs();hideBadge()}
}
function hideBadge(){const b=document.getElementById('notifBadge');if(b){b.style.display='none';b.textContent='0'}}
function escN(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function renderNotifs(){
  const list=document.getElementById('notifList');
  const empty=document.getElementById('notifEmpty');
  if(!_notifData.length){list.innerHTML='';empty.style.display='';return}
  empty.style.display='none';
  const icons={error:'❌',warn:'⚠️',info:'ℹ️'};
  const cols={error:'var(--red)',warn:'var(--yellow)',info:'var(--accent)'};
  list.innerHTML=[..._notifData].reverse().slice(0,40).map(n=>{
    const t=new Date(n.ts).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return \`<div style="padding:9px 10px;border-radius:8px;margin-bottom:6px;background:var(--bg3);border:1px solid var(--border);border-right:3px solid \${cols[n.level]||cols.info}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
        <span style="font-size:.72rem;color:\${cols[n.level]||cols.info};font-weight:700">\${icons[n.level]||'ℹ️'} \${n.level.toUpperCase()}</span>
        <span style="font-size:.65rem;color:var(--text3);white-space:nowrap">\${t}</span>
      </div>
      <div style="font-size:.76rem;color:var(--text2);margin-top:4px;line-height:1.5;word-break:break-all">\${escN(n.msg)}</div>
    </div>\`;
  }).join('');
}
async function clearNotifs(){
  await fetch('/api/notifications/clear',{method:'POST'});
  _notifData=[];renderNotifs();hideBadge();
  _notifSeen=0;try{localStorage.setItem('zao_ns',0)}catch(_){}
}
async function _pollNotifs(){
  try{const r=await fetch('/api/notifications');if(!r.ok)return;const d=await r.json();_notifData=d.items||[];const unseen=_notifData.filter(n=>n.id>_notifSeen).length;const b=document.getElementById('notifBadge');if(b){if(unseen>0){b.textContent=unseen>99?'99+':unseen;b.style.display='flex'}else{b.style.display='none'}}if(_notifPanelOpen)renderNotifs()}catch(_){}
}
_pollNotifs();setInterval(_pollNotifs,60000);
document.addEventListener('click',e=>{if(_notifPanelOpen&&!document.getElementById('notifPanel').contains(e.target)&&!document.getElementById('notifBtn').contains(e.target)){_notifPanelOpen=false;document.getElementById('notifPanel').style.display='none'}});
</script>
</body>
</html>`;
}

// ─── Module Export ────────────────────────────────────────────────────────────
module.exports.start = function startPanel(options) {
  const {
    logBuffer    = [],
    sseClients   = new Set(),
    appendLog    = () => {},
    getBotChild  = () => null,
    getRestarts  = () => 0,
    restartBotFn = () => {},
    killBotFn    = () => {},
    lockBotFn    = () => {},
    unlockBotFn  = () => {},
    password     = process.env.PANEL_PASSWORD || 'SainxSain',
    port         = parseInt(process.env.PORT || '5000', 10),
    paths        = {}
  } = options;

  // ─── Instagram bot integration ────────────────────────────────────────────
  const INSTA_API_PORT   = options.instaApiPort   || 3002;
  const instaLogBuffer   = options.instaLogBuffer  || [];
  const getInstaChild    = options.getInstaChild   || (() => null);
  const restartInstaFn   = options.restartInstaFn  || (() => {});
  const killInstaFn      = options.killInstaFn     || (() => {});

  // ─── Secondary bot (Tier 2) integration ───────────────────────────────────
  const getBotChild2  = options.getBotChild2  || (() => null);
  const getRestarts2  = options.getRestarts2  || (() => 0);
  const startBot2Fn   = options.startBot2Fn   || (() => {});
  const stopBot2Fn    = options.stopBot2Fn    || (() => {});
  const BOT2_API_PORT = options.bot2ApiPort   || 3003;

  const SETTINGS_PATH = paths.settings || path.join(ROOT, 'ZAO-SETTINGS.json');
  const STATE_PATH    = paths.state    || path.join(ROOT, 'sessions', 'ZAO-STATE.json');
  const ALT_PATH      = paths.alt      || path.join(ROOT, 'sessions', 'alt.json');
  const CMDS_PATH     = paths.cmds     || path.join(ROOT, 'SCRIPTS', 'ZAO-CMDS');
  const DATA_DIR      = paths.data     || path.join(ROOT, 'data');
  const BOT_API_PORT  = options.botApiPort || 3001;
  const PANEL_STARTED_AT = Date.now();
  // System uptime: read the first-ever start timestamp written by Main.js.
  // This survives panel and bot restarts, showing true total uptime.
  const STARTED_AT = (() => {
    try {
      const f = path.join(ROOT, 'data', 'first-start.json');
      if (fs.existsSync(f)) {
        const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
        return Number(d.ts) || PANEL_STARTED_AT;
      }
    } catch (_) {}
    return PANEL_STARTED_AT;
  })();

  const TIER_FILES = [
    { tier:1, stateFile:'sessions/ZAO-STATE.json',  altFile:'sessions/alt.json',  credsFile:'sessions/ZAO-STATEC.json'  },
    { tier:2, stateFile:'sessions/ZAO-STATEX.json', altFile:'sessions/altx.json', credsFile:'sessions/ZAO-STATEXC.json' },
    { tier:3, stateFile:'sessions/ZAO-STATEV.json', altFile:'sessions/altv.json', credsFile:'sessions/ZAO-STATEVC.json' },
    { tier:4, stateFile:'sessions/ZAO-STATE4.json', altFile:'sessions/alt4.json', credsFile:'sessions/ZAO-STATE4C.json' },
    { tier:5, stateFile:'sessions/ZAO-STATE5.json', altFile:'sessions/alt5.json', credsFile:'sessions/ZAO-STATE5C.json' },
  ];

  function readSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); }
    catch(_) { return {}; }
  }
  function saveSettings(cfg) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  }

  function proxyToBot(method, botPath, body) {
    return new Promise((resolve) => {
      const opts = {
        hostname:'127.0.0.1', port:BOT_API_PORT, path:botPath, method,
        headers:{'Content-Type':'application/json','Content-Length':body?Buffer.byteLength(body):0}
      };
      const req = http.request(opts, res2 => {
        let d='';
        res2.on('data',c=>d+=c);
        res2.on('end',()=>{ try{resolve({ok:true,data:JSON.parse(d),status:res2.statusCode})}catch(_){resolve({ok:false,data:{error:'parse error'}})} });
      });
      req.setTimeout(8000,()=>{req.destroy();resolve({ok:false,data:{error:'Bot API timed out'},status:503})});
      req.on('error',()=>resolve({ok:false,data:{error:'Bot API unavailable. Bot may be connecting...'},status:503}));
      if(body) req.write(body);
      req.end();
    });
  }

  function safeReadData(file) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')); }
    catch(_) { return {}; }
  }

  // ─── Express App ────────────────────────────────────────────────────────────
  const app = express();
  // [SEC] Most endpoints only need small JSON payloads. File-upload routes
  // (config save, cookie paste) are individually raised to 10 MB below.
  app.use(express.json({ limit:'2mb' }));
  app.use(express.urlencoded({ extended:true, limit:'2mb' }));
  app.get('/favicon.ico', (_req,res) => {
    res.setHeader('Content-Type','image/svg+xml');
    res.setHeader('Cache-Control','public,max-age=86400');
    res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#050505"/><rect width="32" height="32" rx="8" fill="none" stroke="#ff3c5f" stroke-width=".8" opacity=".5"/><g transform="translate(4,8)"><path d="M0 8s3.5-7 8-7 8 7 8 7-3.5 7-8 7-8-7-8-7z" stroke="white" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="8" cy="8" r="3" stroke="white" stroke-width="1.2" fill="none"/><circle cx="8" cy="8" r="1.3" fill="white"/></g></svg>');
  });

  // [SEC] Warn loudly if SESSION_SECRET is the insecure Date.now() fallback.
  // Every operator restart generates a new secret, invalidating all sessions.
  // Set SESSION_SECRET in Replit Secrets to get a stable, safe secret.
  const _sessionSecret = process.env.SESSION_SECRET;
  if (!_sessionSecret) {
    console.warn('[PANEL] WARNING: SESSION_SECRET env var is not set. ' +
      'Using a random per-restart secret — all sessions will be invalidated on every restart. ' +
      'Set SESSION_SECRET in Replit Secrets for persistent, secure sessions.');
  }

  app.use(session({
    secret: _sessionSecret || ('zao-panel-' + crypto.randomBytes(16).toString('hex')),
    resave: false,
    saveUninitialized: false,
    // [SEC] rolling:true refreshes the session cookie's maxAge on every request
    // so active users are never unexpectedly logged out mid-session.
    rolling: true,
    cookie: {
      maxAge:   12 * 60 * 60 * 1000, // 12 hours of inactivity
      httpOnly: true,                 // JS cannot read the cookie
      sameSite: 'lax',               // CSRF mitigation for form posts
    }
  }));

  // [SEC] Per-route body limit overrides for endpoints that receive large payloads
  // (full config JSON, raw AppState cookie arrays). All other routes use the
  // global 2 MB limit set above.
  const _bigBody           = express.json({ limit: '10mb' });
  const _bigBodyUrlEncoded = express.urlencoded({ extended: true, limit: '10mb' });

  function auth(req, res, next) {
    if (!req.session.loggedIn) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error:'Unauthorized' });
      return res.redirect('/login');
    }
    // H-02: CSRF check for every state-changing request.
    // The client reads the _csrf cookie (httpOnly:false) and sends it as
    // X-CSRF-Token. An attacker on a different origin cannot read our cookie
    // (same-origin policy), so they cannot forge the header.
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const clientToken = req.headers['x-csrf-token'] || '';
      if (!req.session.csrfToken || clientToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'CSRF validation failed — refresh the page and try again.' });
      }
    }
    return next();
  }

  function isBotOnline() { return getBotChild() !== null; }

  function pageOpts() { return { botOnline: isBotOnline() }; }

  // ─── LOGIN ──────────────────────────────────────────────────────────────────
  app.get('/', (req,res) => res.redirect(req.session.loggedIn ? '/status' : '/login'));
  app.get('/login', (req,res) => {
    if (req.session.loggedIn) return res.redirect('/status');
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>ZAO — تسجيل الدخول</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{
  background:#07080f;color:#e8eaf6;
  font-family:'Cairo',sans-serif;
  display:flex;align-items:center;justify-content:center;
  min-height:100vh;overflow:hidden;
  background-image:
    radial-gradient(ellipse 60% 50% at 15% 15%,rgba(255,60,95,.07) 0%,transparent 55%),
    radial-gradient(ellipse 50% 40% at 85% 85%,rgba(96,208,255,.055) 0%,transparent 50%),
    radial-gradient(ellipse 30% 25% at 70% 20%,rgba(255,60,95,.03) 0%,transparent 45%);
}
.orb{
  position:fixed;border-radius:50%;filter:blur(80px);pointer-events:none;
  animation:orb-drift 8s ease-in-out infinite alternate;
}
.orb1{width:400px;height:400px;background:rgba(255,60,95,.04);top:-10%;right:-10%;animation-delay:0s}
.orb2{width:350px;height:350px;background:rgba(96,208,255,.035);bottom:-10%;left:-10%;animation-delay:-3s}
@keyframes orb-drift{0%{transform:translate(0,0)}100%{transform:translate(24px,20px)}}
.wrap{
  position:relative;z-index:1;
  display:flex;flex-direction:column;align-items:center;
  padding:20px 16px;width:100%;max-width:400px;
}
.logo-ring{
  position:relative;margin-bottom:20px;
  animation:logo-float 4s ease-in-out infinite;
}
@keyframes logo-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
.logo-outer{
  width:76px;height:76px;border-radius:22px;
  background:#050505;
  border:1.5px solid rgba(255,60,95,.35);
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 32px rgba(255,60,95,.28),0 0 64px rgba(96,208,255,.1),0 8px 24px rgba(0,0,0,.6);
}
.logo-glow{
  position:absolute;inset:-6px;border-radius:26px;
  background:linear-gradient(145deg,rgba(255,60,95,.16),rgba(96,208,255,.12));
  filter:blur(10px);z-index:-1;
}
.brand-name{
  font-size:2rem;font-weight:900;letter-spacing:1px;margin-bottom:3px;
  background:linear-gradient(90deg,#ff3c5f 0%,#60d0ff 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.brand-sub{font-size:.8rem;color:#3f4a68;margin-bottom:28px;font-weight:500;letter-spacing:.5px}
.card{
  width:100%;
  background:rgba(255,255,255,.035);
  backdrop-filter:blur(32px) saturate(1.6);
  -webkit-backdrop-filter:blur(32px) saturate(1.6);
  border:1px solid rgba(255,255,255,.08);
  border-radius:22px;padding:30px 26px;
  box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) inset;
  animation:card-in .45s cubic-bezier(.34,1.26,.64,1);
}
@keyframes card-in{from{opacity:0;transform:translateY(22px) scale(.96)}to{opacity:1;transform:none}}
.form-label{
  display:block;font-size:.76rem;color:#8892b0;
  margin-bottom:7px;font-weight:700;letter-spacing:.5px;text-align:right;
}
.field{position:relative;margin-bottom:16px}
.field-icon{
  position:absolute;right:12px;top:50%;transform:translateY(-50%);
  color:#3f4a68;font-size:.9rem;pointer-events:none;
}
.field input{
  width:100%;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.09);color:#e8eaf6;
  border-radius:11px;padding:11px 40px 11px 14px;
  font-size:.9rem;font-family:'Cairo',sans-serif;outline:none;
  transition:all .22s;letter-spacing:.3px;
}
.field input:focus{
  border-color:rgba(255,60,95,.5);
  box-shadow:0 0 0 3px rgba(255,60,95,.1),0 0 0 1px rgba(255,60,95,.22);
  background:rgba(255,60,95,.04);
}
.field input::placeholder{color:#3f4a68}
.submit-btn{
  width:100%;padding:12px;margin-top:6px;
  background:linear-gradient(135deg,#ff3c5f 0%,#60d0ff 100%);
  color:#fff;border:none;border-radius:11px;
  font-size:.95rem;font-weight:800;font-family:'Cairo',sans-serif;
  cursor:pointer;transition:all .22s cubic-bezier(.4,0,.2,1);
  letter-spacing:.4px;
  box-shadow:0 4px 18px rgba(255,60,95,.3);
}
.submit-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(255,60,95,.45)}
.submit-btn:active{transform:translateY(0);box-shadow:0 2px 10px rgba(255,60,95,.2)}
.err-msg{
  display:flex;align-items:center;gap:8px;
  color:#f5a0ae;font-size:.8rem;margin-top:13px;
  padding:10px 13px;
  background:rgba(240,83,106,.08);
  border-radius:9px;border:1px solid rgba(240,83,106,.2);
  text-align:right;
}
.footer-note{margin-top:22px;font-size:.65rem;color:#2e3755;letter-spacing:.4px;text-align:center}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="wrap">
  <div class="logo-ring">
    <div class="logo-outer"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="38" height="38"><path d="M1 12s4.5-9 11-9 11 9 11 9-4.5 9-11 9S1 12 1 12z" stroke="rgba(255,255,255,.92)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="4.5" stroke="rgba(255,255,255,.92)" stroke-width="1.3"/><circle cx="12" cy="12" r="2" fill="rgba(255,255,255,.92)"/></svg></div>
    <div class="logo-glow"></div>
  </div>
  <div class="brand-name">ZAO</div>
  <div class="brand-sub">ZAO Bot · لوحة الإدارة</div>
  <div class="card">
    <form method="POST" action="/login">
      <label class="form-label">كلمة المرور</label>
      <div class="field">
        <span class="field-icon">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        </span>
        <input type="password" name="password" placeholder="أدخل كلمة المرور" autofocus required autocomplete="current-password"/>
      </div>
      <button type="submit" class="submit-btn">دخول</button>
      ${req.query.err ? '<div class="err-msg"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> كلمة المرور غير صحيحة</div>' : ''}
    </form>
  </div>
  <div class="footer-note">ZAO Panel · © ${new Date().getFullYear()}</div>
</div>
</body></html>`);
  });

  app.post('/login', _loginRateLimit, (req,res) => {
    if (req.body.password === password) {
      _loginRecordSuccess(req);
      req.session.loggedIn = true;
      // H-02: Generate a CSRF token for this session and expose it via a
      // JS-readable cookie (_csrf). The session also stores the canonical
      // value; the auth() middleware compares the two on every POST/PUT/DELETE.
      const csrfToken = crypto.randomBytes(24).toString('hex');
      req.session.csrfToken = csrfToken;
      res.cookie('_csrf', csrfToken, {
        httpOnly: false,   // must be JS-readable so the frontend can send it
        sameSite: 'lax',  // still blocks cross-site navigations
        maxAge: 12 * 60 * 60 * 1000
      });
      return res.redirect('/status');
    }
    _loginRecordFailure(req);
    res.redirect('/login?err=1');
  });
  // H-02: Allow the frontend to refresh the CSRF token after a soft navigation
  // or page-focus event without a full re-login.
  app.get('/api/csrf', auth, (req, res) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      res.cookie('_csrf', req.session.csrfToken, { httpOnly: false, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
    }
    res.json({ token: req.session.csrfToken });
  });
  app.get('/logout', (req,res) => { req.session.destroy(() => res.redirect('/login')); });

  // ─── STATUS / DASHBOARD ──────────────────────────────────────────────────────
  app.get('/status', auth, (req,res) => {
    const cfg = readSettings();
    const online = isBotOnline();
    const cmds = global.client?.commands?.size || 0;
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    let activeTier = null;
    try { activeTier = JSON.parse(fs.readFileSync(path.join(DATA_DIR,'active-tier.json'),'utf-8')).tier; } catch(_) {}

    let cmdCount = 0;
    try { cmdCount = fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith('.js')).length; } catch(_) {}

    const body = `
<style>
/* ── ZaoFan / Manga decorative styles ─────────────────────────── */
.zaofan-hero{
  position:relative;overflow:hidden;border-radius:var(--radius-lg);
  background:linear-gradient(135deg,rgba(255,60,95,.06) 0%,rgba(96,208,255,.04) 40%,rgba(155,114,247,.05) 100%);
  border:1px solid rgba(255,60,95,.14);
  padding:20px 24px;margin-bottom:16px;
  display:flex;align-items:center;gap:20px;
}
.zaofan-hero::before{
  content:'';position:absolute;top:-30px;left:-40px;
  width:200px;height:200px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,60,95,.07),transparent 70%);
  pointer-events:none;
}
.zaofan-art{
  width:80px;height:80px;flex-shrink:0;position:relative;
  display:flex;align-items:center;justify-content:center;
}
/* Manga speed-line art for ZaoFan */
.zaofan-art svg{width:80px;height:80px}
.zaofan-speedlines{
  position:absolute;inset:0;
  background:
    repeating-conic-gradient(from 0deg,transparent 0deg,transparent 10deg,rgba(255,60,95,.03) 10deg,rgba(255,60,95,.03) 11deg);
  border-radius:50%;
  animation:spin-slow 20s linear infinite;
}
@keyframes spin-slow{to{transform:rotate(360deg)}}
.zaofan-char{
  position:relative;z-index:1;
  width:64px;height:64px;border-radius:50%;
  background:linear-gradient(135deg,rgba(255,60,95,.2),rgba(96,208,255,.15));
  border:2px solid rgba(255,60,95,.3);
  display:flex;align-items:center;justify-content:center;
  font-size:1.9rem;
  box-shadow:0 0 20px rgba(255,60,95,.2),0 0 40px rgba(96,208,255,.1);
}
.zaofan-text{flex:1}
.zaofan-title{font-size:1.05rem;font-weight:800;background:linear-gradient(90deg,#ff3c5f,#60d0ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px}
.zaofan-sub{font-size:.78rem;color:var(--text3);line-height:1.5}
.zaofan-tag{display:inline-block;background:rgba(255,60,95,.12);border:1px solid rgba(255,60,95,.25);color:#ff3c5f;border-radius:6px;padding:2px 8px;font-size:.7rem;font-weight:700;margin-left:6px}
/* Manga panel corner decorations */
.manga-corners{position:absolute;pointer-events:none;inset:0}
.manga-corners::before,.manga-corners::after{content:'';position:absolute;width:20px;height:20px;border-color:rgba(255,60,95,.3);border-style:solid}
.manga-corners::before{top:8px;right:8px;border-width:2px 2px 0 0;border-radius:0 4px 0 0}
.manga-corners::after{bottom:8px;left:8px;border-width:0 0 2px 2px;border-radius:0 0 0 4px}
</style>

<!-- ── ZaoFan Hero Banner ──────────────────────────────────────────── -->
<div class="zaofan-hero">
  <div class="manga-corners"></div>
  <div class="zaofan-art">
    <div class="zaofan-speedlines"></div>
    <div class="zaofan-char">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="44" height="44" fill="none">
        <ellipse cx="32" cy="32" rx="28" ry="18" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="32" cy="32" r="9" stroke="white" stroke-width="2.5"/>
        <circle cx="32" cy="32" r="4" fill="white"/>
        <circle cx="36" cy="28" r="2" fill="rgba(255,255,255,0.5)"/>
      </svg>
    </div>
  </div>
  <div class="zaofan-text">
    <div class="zaofan-title">ZAO Bot — نظام التحكم المتكامل
      <span class="zaofan-tag">v1.8</span>
    </div>
    <div class="zaofan-sub">مرحباً في لوحة تحكم ZAO — نظام بوت فيسبوك الذكي مع دعم إنستقرام ونظام متعدد الطبقات<br>
    ${new Date().toLocaleDateString('ar-EG',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
  </div>
</div>

<div class="page-header" style="display:none">
  <div class="page-title">📊 لوحة التحكم</div>
  <div class="page-sub">مرحباً بك في ZAO Bot — ${new Date().toLocaleDateString('ar-EG',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
</div>

<div class="stats-grid">
  <div class="stat stat-cyan">
    <div class="stat-glow"></div>
    <div class="stat-icon">💬</div>
    <div class="stat-val">${cmdCount}</div>
    <div class="stat-lbl">أوامر مُحمَّلة</div>
  </div>
  <div class="stat stat-green">
    <div class="stat-glow"></div>
    <div class="stat-icon">🔄</div>
    <div class="stat-val">${getRestarts()}</div>
    <div class="stat-lbl">إعادات التشغيل</div>
  </div>
  <div class="stat stat-purple">
    <div class="stat-glow"></div>
    <div class="stat-icon">🔑</div>
    <div class="stat-val">${activeTier !== null ? 'T'+activeTier : '—'}</div>
    <div class="stat-lbl">الطبقة النشطة</div>
  </div>
  <div class="stat stat-red">
    <div class="stat-glow"></div>
    <div class="stat-icon">💾</div>
    <div class="stat-val">${memMB}</div>
    <div class="stat-lbl">RAM (MB)</div>
  </div>
  <div class="stat stat-cyan">
    <div class="stat-glow"></div>
    <div class="stat-icon">⏱️</div>
    <div class="stat-val" id="stat-uptime" style="font-size:1rem">${getUptime(STARTED_AT)}</div>
    <div class="stat-lbl">وقت التشغيل</div>
  </div>
  <div class="stat stat-purple" id="rand-stat" style="cursor:pointer" onclick="testRandomizer()" title="اضغط لتعبئة المجمّع">
    <div class="stat-glow"></div>
    <div class="stat-icon">🎲</div>
    <div class="stat-val" id="rand-mode" style="font-size:.95rem">—</div>
    <div class="stat-lbl">المُعشِّش AI</div>
  </div>
</div>

<!-- ── Session Health Widget ─────────────────────────────────────────── -->
<div class="card" id="session-health-card">
  <div class="card-header">
    <div class="card-title">📡 صحة الجلسة</div>
    <div style="display:flex;align-items:center;gap:10px">
      <span id="sh-ts" style="font-size:.75rem;color:var(--text3)">جارٍ التحميل...</span>
      <button class="btn btn-outline btn-sm" onclick="refreshSessionHealth()">🔄</button>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;padding:4px 0">

    <!-- Quality Score -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:8px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);letter-spacing:.4px">جودة الاتصال</div>
      <div style="position:relative;width:72px;height:72px">
        <svg viewBox="0 0 36 36" style="transform:rotate(-90deg);width:72px;height:72px">
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>
          <circle id="sh-ring" cx="18" cy="18" r="15.9" fill="none" stroke="var(--cyan)" stroke-width="3"
            stroke-dasharray="100 100" stroke-linecap="round" style="transition:stroke-dasharray .6s ease,stroke .4s"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:700" id="sh-score">—</div>
      </div>
      <div id="sh-quality-lbl" style="font-size:.78rem;font-weight:600;color:var(--text2)">—</div>
    </div>

    <!-- Last Activity -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);letter-spacing:.4px">آخر نشاط MQTT</div>
      <div id="sh-last-msg" style="font-size:1.5rem;font-weight:700;color:var(--cyan)">—</div>
      <div id="sh-last-msg-lbl" style="font-size:.78rem;color:var(--text3)">—</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
        <span id="sh-watchdog-dot" style="width:8px;height:8px;border-radius:50%;background:var(--text3);display:inline-block"></span>
        <span id="sh-watchdog-lbl" style="font-size:.75rem;color:var(--text3)">Watchdog —</span>
      </div>
    </div>

    <!-- Tier & Session -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);letter-spacing:.4px">الطبقة النشطة</div>
      <div id="sh-tier" style="font-size:1.5rem;font-weight:700;color:var(--purple)">—</div>
      <div id="sh-session-file" style="font-size:.75rem;color:var(--text3);word-break:break-all">—</div>
      <div style="margin-top:4px">
        <span id="sh-login-method" style="font-size:.75rem;padding:3px 8px;border-radius:20px;background:rgba(255,255,255,.06);color:var(--text2)">—</span>
      </div>
    </div>

    <!-- dtsg token refresh -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);letter-spacing:.4px">تجديد fb_dtsg</div>
      <div id="sh-dtsg-next" style="font-size:1.4rem;font-weight:700;color:var(--orange,#f97316)">—</div>
      <div id="sh-dtsg-next-lbl" style="font-size:.78rem;color:var(--text3)">الوقت المتبقي للتجديد</div>
      <div id="sh-dtsg-last" style="font-size:.75rem;color:var(--text3);margin-top:4px">—</div>
    </div>

    <!-- Circuit Breaker -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);letter-spacing:.4px">Circuit Breaker</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <span id="sh-cb-indicator" style="width:14px;height:14px;border-radius:50%;background:var(--text3);display:inline-block;flex-shrink:0"></span>
        <span id="sh-cb-status" style="font-size:1rem;font-weight:700;color:var(--text2)">—</span>
      </div>
      <div id="sh-cb-detail" style="font-size:.75rem;color:var(--text3)">—</div>
    </div>

  </div>
</div>
<script>
(function(){
  function _fmt(sec){
    if(sec===null||sec===undefined) return {val:'—',lbl:'لا يوجد نشاط'};
    if(sec<60)   return {val:sec+'ث',   lbl:'منذ '+sec+' ثانية'};
    if(sec<3600) return {val:Math.floor(sec/60)+'د', lbl:'منذ '+Math.floor(sec/60)+' دقيقة'};
    return {val:Math.floor(sec/3600)+'س', lbl:'منذ '+Math.floor(sec/3600)+' ساعة'};
  }
  function _score(online,mqttReady,silentSec){
    if(!online) return 0;
    if(!mqttReady) return 12;
    if(silentSec===null||silentSec===undefined) return 55;
    if(silentSec>600) return 35;
    if(silentSec>180) return 62;
    if(silentSec>30)  return 82;
    return 97;
  }
  function _scoreColor(s){
    if(s>=80) return 'var(--green,#22c55e)';
    if(s>=50) return 'var(--yellow,#eab308)';
    return 'var(--red,#ef4444)';
  }
  function _scoreLbl(s){
    if(s>=80) return '✅ ممتاز';
    if(s>=50) return '⚠️ متوسط';
    if(s>0)   return '❌ ضعيف';
    return '⭕ غير متصل';
  }
  window.refreshSessionHealth = async function(){
    try{
      const d = await fetch('/api/readiness').then(r=>r.json()).catch(()=>({}));
      const online     = !!(d.bot && d.bot.online);
      const mqttReady  = !!(d.mqtt && d.mqtt.ready);
      const silentSec  = d.mqtt ? d.mqtt.lastActivitySec : null;
      const watchdog   = !!(d.mqtt && d.mqtt.watchdog);
      const tier       = d.session && d.session.tier !== undefined ? 'T'+d.session.tier : '—';
      const stateFile  = (d.session && d.session.stateFile) || '—';
      const loginMeth  = (d.session && d.session.loginMethod) || '—';

      const sc = _score(online, mqttReady, silentSec);
      const col = _scoreColor(sc);
      const ring = document.getElementById('sh-ring');
      if(ring){ ring.setAttribute('stroke-dasharray', sc+' 100'); ring.style.stroke=col; }
      const scoreEl = document.getElementById('sh-score');
      if(scoreEl){ scoreEl.textContent=sc; scoreEl.style.color=col; }
      const qlbl = document.getElementById('sh-quality-lbl');
      if(qlbl){ qlbl.textContent=_scoreLbl(sc); qlbl.style.color=col; }

      const fmt = _fmt(silentSec);
      const lm = document.getElementById('sh-last-msg');
      if(lm){ lm.textContent=fmt.val; lm.style.color=mqttReady?col:'var(--text3)'; }
      const lml = document.getElementById('sh-last-msg-lbl');
      if(lml) lml.textContent=fmt.lbl;

      const wdDot = document.getElementById('sh-watchdog-dot');
      const wdLbl = document.getElementById('sh-watchdog-lbl');
      if(wdDot) wdDot.style.background = watchdog ? 'var(--green,#22c55e)' : 'var(--text3)';
      if(wdLbl) wdLbl.textContent = 'Watchdog ' + (watchdog ? '✅ نشط' : '⭕ معطّل');

      const tierEl = document.getElementById('sh-tier');
      if(tierEl) tierEl.textContent = tier;
      const sfEl = document.getElementById('sh-session-file');
      if(sfEl) sfEl.textContent = stateFile;
      const lmEl = document.getElementById('sh-login-method');
      if(lmEl) lmEl.textContent = loginMeth !== '—' ? '🔑 '+loginMeth : '—';

      // ── dtsg token + circuit breaker from /api/health ────────────────────
      try{
        const h=await fetch('/api/health').then(r=>r.json()).catch(()=>({}));
        const bot=h.bot||{};
        const dtsg=bot.dtsg||{};
        const cb=bot.circuitBreaker||{};
        const nextEl=document.getElementById('sh-dtsg-next');
        const nextLbl=document.getElementById('sh-dtsg-next-lbl');
        const lastEl=document.getElementById('sh-dtsg-last');
        if(nextEl){
          if(dtsg.nextAt){
            const remMs=Math.max(0,Number(dtsg.nextAt)-Date.now());
            const remH=Math.floor(remMs/3600000);
            const remM=Math.floor((remMs%3600000)/60000);
            nextEl.textContent=remH>0?remH+'س '+remM+'د':remM+'د';
            if(nextLbl)nextLbl.textContent='التجديد القادم';
          }else{if(nextEl)nextEl.textContent='جارٍ التشغيل...';}
        }
        if(lastEl){
          if(dtsg.lastAt){
            const ago=Math.round((Date.now()-Number(dtsg.lastAt))/60000);
            lastEl.textContent='آخر تجديد: منذ '+ago+' دقيقة';
          }else{lastEl.textContent='لم يُجدَّد بعد في هذه الجلسة';}
        }
        const cbInd=document.getElementById('sh-cb-indicator');
        const cbSt=document.getElementById('sh-cb-status');
        const cbDt=document.getElementById('sh-cb-detail');
        if(cbInd&&cbSt){
          if(cb.tripped){
            cbInd.style.background='var(--red,#ef4444)';
            cbSt.style.color='var(--red,#ef4444)';
            cbSt.textContent='⛔ مُفعَّل';
            const remM=cb.remainingMs?Math.ceil(cb.remainingMs/60000):0;
            if(cbDt)cbDt.textContent=remM>0?'تعافٍ: '+remM+' دقيقة':'جارٍ التعافي...';
          }else{
            cbInd.style.background='var(--green,#22c55e)';
            cbSt.style.color='var(--green,#22c55e)';
            cbSt.textContent='✅ طبيعي';
            if(cbDt)cbDt.textContent='لا قيود نشطة';
          }
        }
      }catch(_){}
      const ts = document.getElementById('sh-ts');
      if(ts) ts.textContent = 'آخر تحديث: '+new Date().toLocaleTimeString('ar-EG');
    } catch(_){}
  };
  refreshSessionHealth();
  setInterval(refreshSessionHealth, 15000);
})();
</script>

<!-- ── Randomizer Timers Live Dashboard ───────────────────────────────── -->
<div class="card" id="rand-timers-card">
  <div class="card-header">
    <div class="card-title">🎲 المُعشِّش — لوحة التوقيتات الحية</div>
    <div style="display:flex;align-items:center;gap:10px">
      <span id="rt-ts" style="font-size:.75rem;color:var(--text3)">جارٍ التحميل...</span>
      <button class="btn btn-outline btn-sm" onclick="refreshRandTimers()">🔄</button>
    </div>
  </div>

  <!-- Row 1: Randomizer Engine + MQTT Health -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:16px">

    <!-- Randomizer Engine card -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);margin-bottom:10px;letter-spacing:.4px;font-weight:600">⚙️ محرك المُعشِّش AI</div>
      <div style="display:flex;flex-direction:column;gap:9px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">الوضع</span>
          <span id="rt-mode" style="font-weight:700;font-size:.9rem">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">المجمّع المتاح</span>
          <span id="rt-pool" style="font-weight:700;color:var(--cyan)">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">إجمالي طلبات AI</span>
          <span id="rt-total" style="font-weight:700">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">الإخفاقات</span>
          <span id="rt-fails" style="font-weight:700">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">آخر طلب AI</span>
          <span id="rt-last-call" style="font-weight:700;color:var(--purple)">—</span>
        </div>
      </div>
    </div>

    <!-- MQTT Health card -->
    <div style="background:var(--card2,rgba(255,255,255,.04));border-radius:10px;padding:16px;border:1px solid var(--border)">
      <div style="font-size:.75rem;color:var(--text3);margin-bottom:10px;letter-spacing:.4px;font-weight:600">📡 فحص صحة MQTT</div>
      <div style="display:flex;flex-direction:column;gap:9px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">حالة MQTT</span>
          <span id="rt-mqtt-alive" style="font-weight:700;font-size:.9rem">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">الفحص القادم (عشوائي 2–4د)</span>
          <span id="rt-mqtt-next" style="font-weight:700;color:var(--orange,#f97316)">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">صامت منذ</span>
          <span id="rt-mqtt-silent" style="font-weight:700">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">Backoff</span>
          <span id="rt-mqtt-backoff" style="font-weight:700;color:var(--yellow,#ffc107)">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.82rem;color:var(--text2)">إعادات التشغيل</span>
          <span id="rt-mqtt-restarts" style="font-weight:700">—</span>
        </div>
      </div>
    </div>

  </div>

  <!-- Row 2: Keep-Alive Timers table -->
  <div style="margin-bottom:16px">
    <div style="font-size:.75rem;color:var(--text3);margin-bottom:8px;letter-spacing:.4px;font-weight:600">⏱️ مؤقتات الجلسة — كل فترة عشوائية مستقلة</div>
    <table class="table">
      <thead><tr><th>المؤقت</th><th>النطاق العشوائي</th><th style="text-align:left">التالي بعد</th></tr></thead>
      <tbody id="rt-keepalive-body">
        <tr><td colspan="3" style="text-align:center;color:var(--text3);padding:14px">جارٍ التحميل...</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Row 3: Motor Loops table -->
  <div style="margin-bottom:16px">
    <div style="font-size:.75rem;color:var(--text3);margin-bottom:8px;letter-spacing:.4px;font-weight:600">⚙️ محركات نشطة — Motor Loops</div>
    <table class="table">
      <thead><tr><th>الغروب</th><th>آخر إرسال</th><th>الإرسال القادم</th><th>Backoff</th></tr></thead>
      <tbody id="rt-motors-body">
        <tr><td colspan="4" style="text-align:center;color:var(--text3);padding:14px">جارٍ التحميل...</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Row 4: Name Locks (nm) table -->
  <div>
    <div style="font-size:.75rem;color:var(--text3);margin-bottom:8px;letter-spacing:.4px;font-weight:600">🔒 أقفال الأسماء nm — فترات عشوائية</div>
    <table class="table">
      <thead><tr><th>الغروب</th><th>الاسم المقفول</th><th>الفترة</th><th>التطبيق القادم</th></tr></thead>
      <tbody id="rt-nm-body">
        <tr><td colspan="4" style="text-align:center;color:var(--text3);padding:14px">جارٍ التحميل...</td></tr>
      </tbody>
    </table>
  </div>

</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">🎮 التحكم بالبوت</div>
    <span class="badge ${online?'badge-green':'badge-red'}">${online?'🟢 متصل':'🔴 غير متصل'}</span>
  </div>
  <div class="control-panel">
    <button class="control-btn cyan" onclick="botControl('restart')">
      <div class="icon">🔄</div><span>إعادة التشغيل</span>
    </button>
    <button class="control-btn red" onclick="botControl('kill')">
      <div class="icon">⛔</div><span>إيقاف البوت</span>
    </button>
    <button class="control-btn yellow" onclick="botControl('lock')">
      <div class="icon">🔒</div><span>قفل الأوامر</span>
    </button>
    <button class="control-btn green" onclick="botControl('unlock')">
      <div class="icon">🔓</div><span>فتح الأوامر</span>
    </button>
    <button class="control-btn purple" onclick="botControl('reload')">
      <div class="icon">⚡</div><span>إعادة تحميل الأوامر</span>
    </button>
    <button class="control-btn cyan" onclick="botControl('hot-reload')" title="إعادة تحميل الأوامر + الأحداث + الإعدادات بدون إعادة تشغيل">
      <div class="icon">🔥</div><span>هوت-ريلود كامل</span>
    </button>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">🔐 قفل الأوامر العام</div>
    <span id="globalLockBadge" class="badge badge-green">جارٍ التحقق...</span>
  </div>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 0">
    <button class="control-btn yellow" id="globalLockBtn" onclick="toggleGlobalLock()" style="min-width:160px">
      <div class="icon">⏳</div><span>جارٍ التحميل...</span>
    </button>
    <span style="font-size:.82rem;color:var(--text3)" id="globalLockNote">اضغط للتبديل بين قفل الأوامر وفتحها عالمياً</span>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">🔇 وضع الصمت</div>
    <span id="silentModeBadge" class="badge badge-green">جارٍ التحقق...</span>
  </div>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 0">
    <button class="control-btn green" id="silentModeBtn" onclick="toggleSilentMode()" style="min-width:160px">
      <div class="icon">⏳</div><span>جارٍ التحميل...</span>
    </button>
    <span style="font-size:.82rem;color:var(--text3)" id="silentModeNote">البوت ينفذ الأوامر دون إرسال ردود للمحادثة</span>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">⚙️ إعدادات ZAO</div>
    <a href="/config" class="btn btn-outline btn-sm">تعديل الإعدادات</a>
  </div>
  <table class="table">
    <tbody>
      ${[
        ['اللغة', cfg.language || '—'],
        ['المفتاح النشط', cfg.keyActive !== undefined ? (cfg.keyActive ? '<span class="badge badge-green">✅ نشط</span>' : '<span class="badge badge-red">غير نشط</span>') : '—'],
        ['وضع المطور', cfg.DeveloperMode ? '<span class="badge badge-yellow">⚠️ مفعّل</span>' : '<span class="badge badge-green">معطّل</span>'],
        ['الكتابة البشرية', cfg.humanTyping ? '<span class="badge badge-green">✅ فعّال</span>' : '<span class="badge badge-red">معطّل</span>'],
        ['التحقق من MQTT', cfg.mqttHealthCheck ? '<span class="badge badge-green">✅ فعّال</span>' : '<span class="badge badge-red">معطّل</span>'],
        ['adminOnly', cfg.adminOnly ? '<span class="badge badge-yellow">أوامر المشرف فقط</span>' : '<span class="badge badge-blue">الجميع</span>'],
        ['الإشعارات', cfg.notiWhenListenMqttError?.enable ? '<span class="badge badge-green">✅ فعّال</span>' : '<span class="badge badge-red">معطّل</span>'],
      ].map(([k,v])=>`<tr><td style="color:var(--text3);width:180px">${k}</td><td>${v}</td></tr>`).join('')}
    </tbody>
  </table>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">🛡️ الحماية والمحاور</div>
    <button class="btn btn-outline btn-sm" onclick="refreshLiveStats()">🔄 تحديث</button>
  </div>
  <div id="live-stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:4px 0">
    <div class="stat stat-cyan" style="padding:14px">
      <div class="stat-icon">💬</div>
      <div class="stat-val" id="ls-ai-sessions">—</div>
      <div class="stat-lbl">جلسات ذكاء اصطناعي</div>
    </div>
    <div class="stat stat-green" style="padding:14px">
      <div class="stat-icon">⚙️</div>
      <div class="stat-val" id="ls-motors">—</div>
      <div class="stat-lbl">محركات نشطة</div>
    </div>
    <div class="stat stat-purple" style="padding:14px">
      <div class="stat-icon">🔒</div>
      <div class="stat-val" id="ls-locks">—</div>
      <div class="stat-lbl">غروبات مقفولة</div>
    </div>
    <div class="stat stat-red" style="padding:14px">
      <div class="stat-icon">🌡️</div>
      <div class="stat-val" id="ls-cb">—</div>
      <div class="stat-lbl">قاطع الدائرة</div>
    </div>
    <div class="stat stat-cyan" style="padding:14px">
      <div class="stat-icon">📊</div>
      <div class="stat-val" id="ls-rate">—</div>
      <div class="stat-lbl">معدل الإرسال</div>
    </div>
  </div>
  <div id="ls-notice" style="font-size:.78rem;color:var(--text3);margin-top:10px;padding:0 4px"></div>
</div>

<script>
async function refreshLiveStats(){
  const notice = document.getElementById('ls-notice');
  try {
    const [sched, prot] = await Promise.allSettled([
      fetch('/api/scheduler').then(r=>r.json()).catch(()=>({})),
      fetch('/api/protection/status').then(r=>r.json()).catch(()=>({}))
    ]);
    const s = sched.value || {};
    const p = prot.value || {};

    const m1 = s.motor1 || {};
    const m2 = s.motor2 || {};
    const nm = s.nmLocks || {};
    const nick = s.nicknames || {};

    const m1Active = Object.values(m1).filter(v=>v&&v.status).length;
    const m2Active = Object.values(m2).filter(v=>v&&v.status).length;
    document.getElementById('ls-motors').textContent = (m1Active + m2Active);

    const nmActive = Object.values(nm).filter(v=>v&&v.name).length;
    const nickActive = Object.values(nick).filter(v=>v&&v.nickname).length;
    document.getElementById('ls-locks').textContent = Math.max(nmActive, nickActive);

    const cb = p.circuitBreaker || {};
    const cbEl = document.getElementById('ls-cb');
    cbEl.textContent = cb.state || (p.ok===false ? 'غير متصل' : '—');
    cbEl.style.color = cb.state==='tripped'?'var(--red)':cb.state==='half-open'?'var(--yellow)':'var(--green)';

    const rl = p.rateLimit || p.rateLimiter || {};
    const rateEl = document.getElementById('ls-rate');
    const wc = rl.windowCount !== undefined ? rl.windowCount : '—';
    const wl = rl.windowLimit !== undefined ? ('/'+rl.windowLimit) : '';
    rateEl.textContent = wc + wl;

    if(notice) notice.textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
  } catch(e) {
    if(notice) notice.textContent = '⚠️ تعذّر جلب البيانات';
  }
  try {
    const aiSess = (Object.keys(global?.aiHistory||{})||[]).length + (Object.keys(global?.zaofanHistory||{})||[]).length;
    document.getElementById('ls-ai-sessions').textContent = aiSess;
  } catch(_) {}
}
refreshLiveStats();
setInterval(refreshLiveStats, 60000);
</script>

<script>
setInterval(()=>{
  const el=document.getElementById('stat-uptime');
  if(el){fetch('/api/status').then(r=>r.json()).then(d=>{if(d.uptime)el.textContent=new Date(d.uptime*1000).toISOString().substr(11,8)}).catch(()=>{})}
},30000);
async function botControl(action){
  const labels={restart:'إعادة التشغيل',kill:'إيقاف البوت',lock:'قفل الأوامر',unlock:'فتح الأوامر',reload:'إعادة تحميل الأوامر','hot-reload':'هوت-ريلود كامل'};
  if(action==='kill'&&!confirm('هل تريد إيقاف البوت؟'))return;
  const postActions=new Set(['restart','kill','lock','unlock','reload','hot-reload']);
  const r=await api('/api/bot/'+action,{},postActions.has(action)?'POST':'GET');
  if(r.ok||r.message){showToast('✅ '+labels[action],'success');if(action==='lock'||action==='unlock')refreshLockState();}
  else showToast('❌ '+(r.error||'فشل'),'error');
}
let _isLocked=false;
async function refreshLockState(){
  try{
    const r=await fetch('/api/bot/lock').then(x=>x.json()).catch(()=>({}));
    _isLocked=!!(r.locked);
    const badge=document.getElementById('globalLockBadge');
    const btn=document.getElementById('globalLockBtn');
    const note=document.getElementById('globalLockNote');
    if(badge){badge.className='badge '+(_isLocked?'badge-red':'badge-green');badge.textContent=_isLocked?'🔒 مقفول':'🔓 مفتوح';}
    if(btn){btn.innerHTML=_isLocked?'<div class="icon">🔓</div><span>فتح الأوامر</span>':'<div class="icon">🔒</div><span>قفل الأوامر</span>';btn.className='control-btn '+(_isLocked?'green':'yellow');}
    if(note)note.textContent=_isLocked?'الأوامر مقفولة — انقر لفتحها':'الأوامر مفتوحة — انقر لقفلها';
  }catch(_){}
}
async function toggleGlobalLock(){
  await botControl(_isLocked?'unlock':'lock');
}
refreshLockState();

let _isSilent = false;
async function refreshSilentMode() {
  try {
    const r = await fetch('/api/silent').then(x=>x.json()).catch(()=>({}));
    _isSilent = !!(r.silent);
    const badge = document.getElementById('silentModeBadge');
    const btn   = document.getElementById('silentModeBtn');
    const note  = document.getElementById('silentModeNote');
    if (badge) { badge.className = 'badge ' + (_isSilent ? 'badge-red' : 'badge-green'); badge.textContent = _isSilent ? '🔇 مُفعَّل' : '🔊 معطّل'; }
    if (btn)   { btn.innerHTML = _isSilent ? '<div class="icon">🔊</div><span>إيقاف الصمت</span>' : '<div class="icon">🔇</div><span>تفعيل الصمت</span>'; btn.className = 'control-btn ' + (_isSilent ? 'red' : 'green'); }
    if (note)  { note.textContent = _isSilent ? 'الصمت مفعّل — البوت لا يُرسل ردوداً للمحادثات' : 'انقر لتفعيل وضع الصمت (البوت ينفذ بدون ردود)'; }
  } catch(_) {}
}
async function toggleSilentMode() {
  const r = await api('/api/silent', { silent: !_isSilent });
  if (r.ok) { showToast(_isSilent ? '🔊 وضع الصمت مُوقَف' : '🔇 وضع الصمت مُفعَّل', 'success'); refreshSilentMode(); }
  else showToast('❌ ' + (r.error || 'فشل'), 'error');
}
refreshSilentMode();
// ── Randomizer status widget ──────────────────────────────────────────────
async function refreshRandomizerStat() {
  try {
    const d = await fetch('/api/randomizer/status').then(r=>r.json()).catch(()=>({}));
    const el = document.getElementById('rand-mode');
    if (!el) return;
    if (d.mode === 'ai') {
      el.textContent = '🤖 AI';
      el.style.color = 'var(--green)';
    } else if (d.mode === 'fallback') {
      el.textContent = '🔀 Fallback';
      el.style.color = 'var(--yellow,#ffc107)';
    } else {
      el.textContent = '—';
      el.style.color = '';
    }
    const st = document.getElementById('rand-stat');
    if (st) st.title = d.pool != null ? 'المجمّع: ' + d.pool + ' رقم — اضغط للتعبئة' : 'اضغط للتعبئة';
  } catch(_) {}
}
async function testRandomizer() {
  showToast('⏳ جارٍ تعبئة مجمّع المُعشِّش...', 'info');
  const r = await api('/api/randomizer/test', {});
  if (r.ok) showToast('✅ المجمّع ممتلئ — ' + (r.pool||'') + ' رقم جاهز', 'success');
  else showToast('❌ ' + (r.error || 'تعذّر التعبئة'), 'error');
  refreshRandomizerStat();
}
refreshRandomizerStat();
setInterval(refreshRandomizerStat, 30000);
// ── Randomizer Timers Live Dashboard ────────────────────────────────────────
function _rtFmtRem(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  var rem = Math.max(0, ms);
  var h = Math.floor(rem / 3600000);
  var m = Math.floor((rem % 3600000) / 60000);
  var s = Math.floor((rem % 60000) / 1000);
  if (h > 0) return h + 'س ' + m + 'د';
  if (m > 0) return m + 'د ' + s + 'ث';
  return s + 'ث';
}
function _rtFmtAgo(ts, now) {
  if (!ts) return '—';
  var diff = Math.round((now - Number(ts)) / 1000);
  if (diff < 0) return 'قريباً';
  if (diff < 60) return 'منذ ' + diff + 'ث';
  if (diff < 3600) return 'منذ ' + Math.floor(diff / 60) + 'د';
  return 'منذ ' + Math.floor(diff / 3600) + 'س';
}
async function refreshRandTimers() {
  try {
    var d = await fetch('/api/randomizer/timers').then(function(r){return r.json();}).catch(function(){return {};});
    var now = Date.now();
    var rs  = d.randomizer || {};
    var mq  = d.mqtt       || {};
    var ka  = d.keepAlive  || {};
    var motors  = d.motors  || [];
    var nmLocks = d.nmLocks || [];

    // ── Randomizer Engine ──────────────────────────────────────────────────
    var modeEl = document.getElementById('rt-mode');
    if (modeEl) {
      if (rs.mode === 'ai')       { modeEl.textContent = '🤖 AI';       modeEl.style.color = 'var(--green)'; }
      else if (rs.mode === 'fallback') { modeEl.textContent = '🔀 Fallback'; modeEl.style.color = 'var(--yellow,#ffc107)'; }
      else                        { modeEl.textContent = '—';            modeEl.style.color = ''; }
    }
    var poolEl = document.getElementById('rt-pool');
    if (poolEl) poolEl.textContent = rs.poolSize != null ? rs.poolSize + ' رقم' : '—';
    var totalEl = document.getElementById('rt-total');
    if (totalEl) totalEl.textContent = rs.totalAiCalls != null ? rs.totalAiCalls : '—';
    var failsEl = document.getElementById('rt-fails');
    if (failsEl) {
      failsEl.textContent = rs.failCount != null ? rs.failCount : '—';
      failsEl.style.color = rs.failCount > 0 ? 'var(--red)' : 'var(--green)';
    }
    var lcEl = document.getElementById('rt-last-call');
    if (lcEl) lcEl.textContent = _rtFmtAgo(rs.lastCallAt, now);

    // ── MQTT Health ────────────────────────────────────────────────────────
    var aliveEl = document.getElementById('rt-mqtt-alive');
    if (aliveEl) {
      if (mq.mqttAlive) { aliveEl.textContent = '✅ نشط'; aliveEl.style.color = 'var(--green)'; }
      else              { aliveEl.textContent = '⭕ صامت'; aliveEl.style.color = mq.silentForSec > 300 ? 'var(--red)' : 'var(--yellow,#ffc107)'; }
    }
    var mqNextEl = document.getElementById('rt-mqtt-next');
    if (mqNextEl) {
      if (mq.nextCheckAt) {
        mqNextEl.textContent = _rtFmtRem(Number(mq.nextCheckAt) - now);
        mqNextEl.style.color = 'var(--orange,#f97316)';
      } else {
        mqNextEl.textContent = mq.watcherActive ? 'قريباً' : 'معطّل';
        mqNextEl.style.color = mq.watcherActive ? 'var(--yellow,#ffc107)' : 'var(--text3)';
      }
    }
    var silentEl = document.getElementById('rt-mqtt-silent');
    if (silentEl) {
      if (mq.silentForSec != null) {
        var s = mq.silentForSec;
        silentEl.textContent = s < 60 ? s + 'ث' : s < 3600 ? Math.round(s/60) + 'د' : Math.round(s/3600) + 'س';
        silentEl.style.color = s < 120 ? 'var(--green)' : s < 480 ? 'var(--yellow,#ffc107)' : 'var(--red)';
      } else { silentEl.textContent = '—'; silentEl.style.color = ''; }
    }
    var bkEl = document.getElementById('rt-mqtt-backoff');
    if (bkEl) {
      bkEl.textContent = mq.backoffMs > 0 ? Math.round(mq.backoffMs / 1000) + 'ث' : '—';
      bkEl.style.color = mq.backoffMs > 0 ? 'var(--yellow,#ffc107)' : 'var(--text3)';
    }
    var rstEl = document.getElementById('rt-mqtt-restarts');
    if (rstEl) {
      rstEl.textContent = mq.restartCount != null ? mq.restartCount + ' / ' + (mq.maxRestarts || 8) : '—';
      rstEl.style.color = mq.restartCount > 0 ? 'var(--yellow,#ffc107)' : 'var(--green)';
    }

    // ── Keep-Alive Timers table ────────────────────────────────────────────
    var kaBody = document.getElementById('rt-keepalive-body');
    if (kaBody) {
      var kaRows = [
        { name: '🔔 Ping الجلسة',       range: '8 – 22 دقيقة',   nextAt: ka.nextPingAt },
        { name: '🔑 تجديد fb_dtsg',      range: '6 – 8 ساعات',    nextAt: ka.nextDtsgAt },
        { name: '🔔 زيارة الإشعارات',    range: '60 – 180 دقيقة', nextAt: ka.nextNotiAt },
        { name: '💾 حفظ الكوكيز',        range: '25 – 45 دقيقة',  nextAt: ka.nextSaveAt },
      ];
      kaBody.innerHTML = kaRows.map(function(r) {
        var rem = r.nextAt ? _rtFmtRem(Number(r.nextAt) - now) : '—';
        var col = r.nextAt ? 'var(--cyan)' : 'var(--text3)';
        return '<tr><td>' + r.name + '</td>' +
          '<td style="color:var(--text3);font-size:.78rem">' + r.range + '</td>' +
          '<td style="color:' + col + ';font-weight:700">' + rem + '</td></tr>';
      }).join('');
    }

    // ── Motor Loops table ──────────────────────────────────────────────────
    var mBody = document.getElementById('rt-motors-body');
    if (mBody) {
      if (!motors.length) {
        mBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:14px">لا توجد محركات نشطة</td></tr>';
      } else {
        mBody.innerHTML = motors.map(function(m) {
          var tid   = m.threadID || '?';
          var disp  = m.name || (tid.length > 18 ? tid.slice(0,16) + '…' : tid);
          var last  = _rtFmtAgo(m.lastSentAt, now);
          var nxt   = m.nextSendAt ? _rtFmtRem(m.nextSendAt - now) : '—';
          var bk    = m.backoffMs > 0 ? Math.round(m.backoffMs / 1000) + 'ث' : '—';
          var nxtCol = m.nextSendAt && m.nextSendAt > now ? 'var(--green)' : 'var(--text3)';
          return '<tr>' +
            '<td style="font-size:.78rem;color:var(--text3)" title="' + tid + '">' + disp + '</td>' +
            '<td>' + last + '</td>' +
            '<td style="color:' + nxtCol + ';font-weight:700">' + nxt + '</td>' +
            '<td style="color:var(--yellow,#ffc107)">' + bk + '</td>' +
            '</tr>';
        }).join('');
      }
    }

    // ── nm Name Locks table ────────────────────────────────────────────────
    var nmBody = document.getElementById('rt-nm-body');
    if (nmBody) {
      if (!nmLocks.length) {
        nmBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:14px">لا توجد أقفال أسماء نشطة</td></tr>';
      } else {
        nmBody.innerHTML = nmLocks.map(function(n) {
          var tid  = n.threadID || '?';
          var disp = tid.length > 18 ? tid.slice(0,16) + '…' : tid;
          var nm   = (n.name || '—').slice(0, 22);
          var timeStr;
          if (n.randomTime) {
            timeStr = n.randomRange ? 'عشوائي ' + n.randomRange[0] + '–' + n.randomRange[1] + 'ث' : 'عشوائي';
          } else {
            timeStr = n.time ? Math.round(n.time / 1000) + 'ث' : '—';
          }
          var nxt = n.nextApplyAt ? _rtFmtRem(Number(n.nextApplyAt) - now) : '—';
          var nxtCol = n.nextApplyAt ? 'var(--purple)' : 'var(--text3)';
          return '<tr>' +
            '<td style="font-size:.75rem;color:var(--text3)" title="' + tid + '">' + disp + '</td>' +
            '<td style="color:var(--cyan)">' + nm + '</td>' +
            '<td style="color:var(--text2);font-size:.8rem">' + timeStr + '</td>' +
            '<td style="color:' + nxtCol + ';font-weight:700">' + nxt + '</td>' +
            '</tr>';
        }).join('');
      }
    }

    var ts = document.getElementById('rt-ts');
    if (ts) ts.textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
  } catch(_) {}
}
refreshRandTimers();
setInterval(refreshRandTimers, 10000);
</script>`;
    res.send(layout('الرئيسية', body, 'status', pageOpts()));
  });

  // ─── LOGS ───────────────────────────────────────────────────────────────────
  app.get('/logs', auth, (req,res) => {
    const initialLines = JSON.stringify(logBuffer.slice(-800).map(e => e.text||e));
    const body = `
<div class="page-header">
  <div class="page-title">📡 سجلات البوت</div>
  <div class="page-sub">بث مباشر — ${logBuffer.length} سطر محفوظ</div>
</div>
<div class="card" style="padding-bottom:0">
  <!-- Toolbar -->
  <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:0 0 12px 0">
    <span id="sseStatus" style="font-size:.78rem;color:var(--text3);display:flex;align-items:center;gap:5px;flex-shrink:0">
      <span id="sseDot" style="width:7px;height:7px;border-radius:50%;background:var(--red);display:inline-block"></span>
      <span id="sseTxt">جارٍ الاتصال...</span>
    </span>
    <input type="text" id="logFilter" placeholder="🔍 بحث في السجلات..." style="flex:1;min-width:140px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:5px 10px;font-size:.8rem;font-family:'Cairo',sans-serif;outline:none" oninput="filterLogs(this.value)"/>
    <label style="display:flex;align-items:center;gap:5px;font-size:.8rem;color:var(--text2);cursor:pointer;flex-shrink:0">
      <input type="checkbox" id="autoScroll" style="width:14px;height:14px"/>تمرير تلقائي
    </label>
    <button class="btn btn-outline btn-sm" onclick="clearLogs()" style="flex-shrink:0">🗑 مسح</button>
  </div>
  <!-- Section tabs -->
  <div id="logSections" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
    <button class="log-sec-btn active" data-sec="all"      onclick="switchSection(this)">📋 الكل <span class="log-cnt" id="cnt-all"></span></button>
    <button class="log-sec-btn"        data-sec="login"    onclick="switchSection(this)">🔐 تسجيل الدخول <span class="log-cnt" id="cnt-login"></span></button>
    <button class="log-sec-btn"        data-sec="messages" onclick="switchSection(this)">💬 الرسائل <span class="log-cnt" id="cnt-messages"></span></button>
    <button class="log-sec-btn"        data-sec="errors"   onclick="switchSection(this)">❌ الأخطاء <span class="log-cnt" id="cnt-errors"></span></button>
    <button class="log-sec-btn"        data-sec="warnings" onclick="switchSection(this)">⚠️ التحذيرات <span class="log-cnt" id="cnt-warnings"></span></button>
    <button class="log-sec-btn"        data-sec="system"   onclick="switchSection(this)">⚙️ النظام <span class="log-cnt" id="cnt-system"></span></button>
    <button class="log-sec-btn"        data-sec="mqtt"     onclick="switchSection(this)">📡 MQTT <span class="log-cnt" id="cnt-mqtt"></span></button>
  </div>
  <!-- Log box -->
  <div class="log-box" id="logBox" style="max-height:60vh;border-top:1px solid var(--border);padding-top:8px"></div>
</div>
<style>
.log-sec-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:20px;padding:3px 11px;font-size:.76rem;cursor:pointer;font-family:'Cairo',sans-serif;transition:all .15s}
.log-sec-btn:hover{background:var(--bg4,var(--border));color:var(--text)}
.log-sec-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.log-cnt{display:inline-block;background:rgba(255,255,255,.15);color:inherit;border-radius:8px;padding:0 5px;font-size:.68rem;font-weight:700;margin-right:2px;min-width:14px;text-align:center;line-height:1.55}
.log-sec-btn:not(.active) .log-cnt{background:rgba(255,255,255,.09);color:var(--text3)}
</style>
<script>
const _initialLines = ${initialLines};
let _allLines=[];
let _filter='';
let _section='all';
let _badgeRaf=null;
const _logBox=document.getElementById('logBox');
const _auto=()=>document.getElementById('autoScroll').checked;

const _SECTIONS={
  all:      ()=>true,
  login:    t=>/\\[\\s*Login\\s*\\]|\\[FCA-DIAG\\]|\\[PATCH\\]|\\[DIAG\\]|Tier \\d|AppState|loginHelper|credential|session/i.test(t),
  messages: t=>/sendMessage|\\[MOTOR\\]|محرك|\\[INSTA:MSG\\]|\\[MSG\\]|received message|body:|message from/i.test(t),
  errors:   t=>/❌|\\bERROR\\b|\\bError\\b|failed|exception/i.test(t),
  warnings: t=>/⚠️|\\bWARN\\b|warning|مفقود|missing/i.test(t),
  system:   t=>/\\[ZAO\\]|\\[WATCHDOG\\]|\\[PROTECT\\]|\\[INSTA:BOOT\\]|\\[INSTA:CMD\\]|ZAO Is working|Platform:|Port:|PID|restart|started/i.test(t),
  mqtt:     t=>/MQTT|mqtt|RECONNECT|reconnect|\\[HEALTH\\]|ping|keepalive/i.test(t),
};

function _classify(text){
  if(/❌|\\bERROR\\b|\\bError\\b/.test(text))return'log-error';
  if(/⚠️|\\bWARN\\b/.test(text))return'log-warn';
  if(/✅|SUCCESS|connected/.test(text))return'log-ok';
  if(/\\[\\s*ZAO\\s*\\]|\\[\\s*WATCHDOG\\s*\\]|\\[\\s*PROTECT\\s*\\]|\\[\\s*STEALTH\\s*\\]|\\[\\s*HEALTH\\s*\\]|\\[\\s*SESSION\\s*\\]|\\[\\s*SYNC\\s*\\]|\\[\\s*LABYRINTH\\s*\\]|MQTT|MOTOR|RECONNECT|📌/.test(text))return'log-info';
  if(/\\[Login\\]|\\[FCA-DIAG\\]|\\[PATCH\\]|\\[DIAG\\]|Tier \\d|AppState|loginHelper/.test(text))return'log-info';
  return'log-dim';
}

function _passes(text){
  if(!_SECTIONS[_section](text))return false;
  if(_filter&&!text.toLowerCase().includes(_filter.toLowerCase()))return false;
  return true;
}

function _updateBadges(){
  for(const sec of Object.keys(_SECTIONS)){
    const el=document.getElementById('cnt-'+sec);
    if(!el)continue;
    const n=sec==='all'?_allLines.length:_allLines.filter(_SECTIONS[sec]).length;
    el.textContent=n>0?n:'';
  }
}

function addLine(text){
  _allLines.push(text);
  if(_allLines.length>10000)_allLines.shift();
  if(_passes(text)){
    const span=document.createElement('span');
    span.className=_classify(text);
    span.textContent=text+'\\n';
    _logBox.appendChild(span);
    if(_auto())_logBox.scrollTop=_logBox.scrollHeight;
    while(_logBox.children.length>6000)_logBox.removeChild(_logBox.firstChild);
  }
  if(!_badgeRaf)_badgeRaf=setTimeout(function(){_updateBadges();_badgeRaf=null;},500);
}

function rerender(){
  _logBox.innerHTML='';
  let count=document.createDocumentFragment();
  for(const l of _allLines){
    if(_passes(l)){
      const span=document.createElement('span');
      span.className=_classify(l);
      span.textContent=l+'\\n';
      count.appendChild(span);
    }
  }
  _logBox.appendChild(count);
  if(_auto())_logBox.scrollTop=_logBox.scrollHeight;
  _updateBadges();
}

function filterLogs(val){_filter=val;rerender();}
function clearLogs(){_allLines=[];_logBox.innerHTML='';_updateBadges();}
function switchSection(btn){
  document.querySelectorAll('.log-sec-btn').forEach(function(b){b.classList.remove('active')});
  btn.classList.add('active');
  _section=btn.dataset.sec;
  rerender();
}

// Seed initial lines
for(const l of _initialLines)addLine(l);
if(_badgeRaf){clearTimeout(_badgeRaf);_badgeRaf=null;}
_updateBadges();

let _sse=null;
function connectSSE(){
  if(_sse)_sse.close();
  _sse=new EventSource('/api/logs');
  _sse.onopen=()=>{
    document.getElementById('sseDot').style.background='var(--green)';
    document.getElementById('sseTxt').textContent='متصل';
  };
  _sse.onerror=()=>{
    document.getElementById('sseDot').style.background='var(--red)';
    document.getElementById('sseTxt').textContent='إعادة الاتصال...';
    setTimeout(connectSSE,3000);
  };
  _sse.onmessage=(e)=>{
    try{const d=JSON.parse(e.data);if(d.text)addLine(d.text);}catch(_){}
  };
}
connectSSE();
</script>`;
    res.send(layout('السجلات', body, 'logs', pageOpts()));
  });

  // SSE endpoint — auth via session (cookie sent automatically by browser)
  app.get('/api/logs', auth, (req,res) => {
    res.writeHead(200,{
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache',
      'Connection':'keep-alive',
      'X-Accel-Buffering':'no'
    });
    res.write(': connected\n\n');
    for (const entry of logBuffer.slice(-500)) {
      res.write(`data: ${JSON.stringify({text:entry.text||entry,ts:entry.ts||Date.now()})}\n\n`);
    }
    sseClients.add(res);
    const ka = setInterval(()=>{ try{res.write(': ping\n\n')}catch(_){clearInterval(ka);sseClients.delete(res)} },20000);
    req.on('close',()=>{ clearInterval(ka); sseClients.delete(res); });
  });

  // ─── COMMANDS ───────────────────────────────────────────────────────────────
  app.get('/commands', auth, (req,res) => {
    let cmds = [], errors = [];
    try {
      const files = fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith('.js'));
      for (const file of files) {
        try {
          const fp = path.join(CMDS_PATH, file);
          delete require.cache[require.resolve(fp)];
          const cmd = require(fp);
          if (cmd?.config) cmds.push({
            name:cmd.config.name||file.replace('.js',''),
            description:cmd.config.description||'',
            category:cmd.config.commandCategory||cmd.config.category||'عام',
            usage:cmd.config.usages||cmd.config.usage||'',
            version:cmd.config.version||'1.0',
            permission:cmd.config.hasPermssion||0,
            file
          });
        } catch(e) { errors.push({file,error:e.message}); }
      }
    } catch(e) { errors.push({file:'*',error:e.message}); }

    const cats = [...new Set(cmds.map(c=>c.category))].sort();
    const permLabel = p => p===0?'<span class="badge badge-green">الجميع</span>':p===1?'<span class="badge badge-yellow">مشرف</span>':'<span class="badge badge-red">سوبر مشرف</span>';

    const ZAO_CMD_TEMPLATE = `module.exports = {
  config: {
    name: 'اسم_الأمر',
    version: '1.0',
    author: 'ZAO',
    countDown: 5,
    hasPermssion: 0,
    description: 'وصف الأمر',
    commandCategory: 'عام',
    usages: '[نص]',
    guide: {
      en: '{pn} [نص] — شرح'
    }
  },
  run: async function({ api, event, args, Users, Threads, Currencies }) {
    const { senderID, threadID, messageID } = event;
    try {
      return api.sendMessage('مرحباً! ✅', threadID, messageID);
    } catch(e) {
      return api.sendMessage('❌ حدث خطأ: ' + e.message, threadID);
    }
  }
};`;

    const body = `
<div class="page-header">
  <div class="page-title">💬 الأوامر (${cmds.length})</div>
  <div class="page-sub">إدارة وتعديل أوامر ZAO Bot من SCRIPTS/ZAO-CMDS/</div>
</div>

${errors.length ? `<div class="card" style="border-color:rgba(255,59,110,.3)"><div class="card-title" style="color:var(--red)">⚠️ أخطاء تحميل (${errors.length})</div><div style="margin-top:10px">${errors.map(e=>`<div style="font-size:.8rem;padding:6px 0;border-bottom:1px solid var(--border);color:var(--text2)"><code style="color:var(--red)">${htmlEscape(e.file)}</code>: ${htmlEscape(e.error)}</div>`).join('')}</div></div>` : ''}

<div class="card">
  <div class="card-header">
    <div class="card-title">🔍 بحث وفلترة</div>
    <button class="btn btn-success btn-sm" onclick="showAddCmd()">➕ إضافة أمر</button>
  </div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    <input type="text" id="cmdSearch" placeholder="🔍 ابحث عن أمر..." oninput="filterCmds()" style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:.86rem;font-family:'Cairo',sans-serif;outline:none"/>
    <select id="catFilter" onchange="filterCmds()" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:.86rem;font-family:'Cairo',sans-serif;outline:none">
      <option value="">كل التصنيفات</option>
      ${cats.map(c=>`<option value="${htmlEscape(c)}">${htmlEscape(c)}</option>`).join('')}
    </select>
  </div>
  <div class="table-wrap">
    <table class="table" id="cmdsTable">
      <thead><tr><th>الاسم</th><th>الوصف</th><th>التصنيف</th><th>الصلاحية</th><th>الإصدار</th><th>إجراءات</th></tr></thead>
      <tbody>
        ${cmds.map(c=>`<tr data-name="${htmlEscape(c.name.toLowerCase())}" data-cat="${htmlEscape(c.category.toLowerCase())}">
          <td><code>${htmlEscape(c.name)}</code></td>
          <td style="max-width:220px;color:var(--text2);font-size:.83rem">${htmlEscape(c.description||'—')}</td>
          <td><span class="badge badge-purple">${htmlEscape(c.category)}</span></td>
          <td>${permLabel(c.permission)}</td>
          <td style="color:var(--text3);font-size:.8rem">v${htmlEscape(c.version)}</td>
          <td><div style="display:flex;gap:5px">
            <button class="btn btn-outline btn-sm" onclick="editCmd('${htmlEscape(c.file)}')">✏️</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCmd('${htmlEscape(c.file)}','${htmlEscape(c.name)}')">🗑</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>

<!-- Edit Modal -->
<div id="editModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.8);backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(860px,95vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <div style="font-weight:700;font-size:.96rem">✏️ تعديل: <span id="editFileName" style="color:var(--accent)"></span></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success btn-sm" onclick="saveCmd()">💾 حفظ</button>
        <button class="btn btn-outline btn-sm" onclick="reloadAfterSave()">⚡ حفظ وإعادة تحميل</button>
        <button class="btn btn-outline btn-sm" onclick="closeEditModal()">✕</button>
      </div>
    </div>
    <div id="editStatus" style="padding:4px 20px;font-size:.78rem;min-height:22px"></div>
    <textarea id="editCode" style="flex:1;background:#03040d;color:#cdd6f4;font-family:'Courier New',monospace;font-size:.8rem;line-height:1.7;padding:16px 20px;border:none;outline:none;resize:none;min-height:400px"></textarea>
  </div>
</div>

<!-- Add Command Modal -->
<div id="addModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.8);backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(860px,95vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <div style="font-weight:700;font-size:.96rem">➕ إنشاء أمر جديد</div>
      <button class="btn btn-outline btn-sm" onclick="closeAddModal()">✕</button>
    </div>
    <div style="padding:16px 20px;display:flex;gap:10px;flex-shrink:0">
      <input type="text" id="newCmdName" placeholder="اسم الأمر (بالإنجليزية)" class="form-control" style="max-width:220px;margin:0"/>
      <button class="btn btn-primary" onclick="createCmd()">✅ إنشاء</button>
    </div>
    <textarea id="newCmdCode" style="flex:1;background:#03040d;color:#cdd6f4;font-family:'Courier New',monospace;font-size:.79rem;line-height:1.7;padding:16px 20px;border:none;outline:none;resize:none;min-height:360px">${ZAO_CMD_TEMPLATE.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
  </div>
</div>

<script>
function filterCmds(){
  const s=document.getElementById('cmdSearch').value.toLowerCase();
  const c=document.getElementById('catFilter').value.toLowerCase();
  document.querySelectorAll('#cmdsTable tbody tr').forEach(tr=>{
    const nm=tr.dataset.name||'';const ct=tr.dataset.cat||'';
    tr.style.display=(!s||nm.includes(s))&&(!c||ct===c)?'':'none';
  });
}
let _curFile='';
async function editCmd(file){
  _curFile=file;
  document.getElementById('editFileName').textContent=file;
  document.getElementById('editStatus').textContent='⏳ جارٍ التحميل...';
  document.getElementById('editModal').style.display='flex';
  const r=await fetch('/api/commands/source?file='+encodeURIComponent(file));
  const d=await r.json();
  document.getElementById('editCode').value=d.source||d.error||'';
  document.getElementById('editStatus').textContent='';
}
async function saveCmd(){
  const code=document.getElementById('editCode').value;
  const st=document.getElementById('editStatus');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';
  const r=await api('/api/commands/source',{file:_curFile,source:code});
  if(r.ok){st.innerHTML='<span style="color:var(--green)">✅ تم الحفظ</span>';showToast('✅ تم حفظ '+_curFile,'success')}
  else{st.innerHTML='<span style="color:var(--red)">❌ '+escH(r.error||'فشل')+'</span>';showToast('❌ فشل الحفظ','error')}
}
async function reloadAfterSave(){
  await saveCmd();
  const r=await api('/api/bot/reload-commands',{});
  showToast(r.ok||r.message?'⚡ تم الحفظ وإعادة التحميل':'⚠️ تم الحفظ — أعد تشغيل البوت لتطبيق التغييرات',r.ok||r.message?'success':'info');
}
async function deleteCmd(file,name){
  if(!confirm('حذف '+name+'؟ هذا لا يمكن التراجع عنه.'))return;
  const r=await api('/api/commands/delete',{file});
  if(r.ok){showToast('✅ تم حذف '+name,'success');setTimeout(()=>location.reload(),800)}
  else showToast('❌ '+(r.error||'فشل'),'error');
}
function closeEditModal(){document.getElementById('editModal').style.display='none'}
function showAddCmd(){document.getElementById('addModal').style.display='flex'}
function closeAddModal(){document.getElementById('addModal').style.display='none'}
async function createCmd(){
  const name=(document.getElementById('newCmdName').value.trim().replace(/[^a-zA-Z0-9_\\-]/g,'')||'').toLowerCase();
  if(!name)return showToast('أدخل اسم الأمر','error');
  const code=document.getElementById('newCmdCode').value;
  const r=await api('/api/commands/create',{name,code});
  if(r.ok){showToast('✅ تم إنشاء '+name,'success');setTimeout(()=>location.reload(),800)}
  else showToast('❌ '+(r.error||'فشل'),'error');
}
function escH(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeEditModal();closeAddModal()}});
</script>`;

    res.send(layout('الأوامر', body, 'commands', pageOpts()));
  });

  // ─── EXECUTE ────────────────────────────────────────────────────────────────

  // ─── SCHEDULER ──────────────────────────────────────────────────────────────
  app.get('/scheduler', auth, (req,res) => {
    const motor1  = safeReadData('motor-state.json');
    const motor2  = safeReadData('motor2-state.json');
    const nmLocks = safeReadData('nm-locks.json');
    const nicks   = safeReadData('nickname-locks.json');

    function motorCard(title, data, id) {
      const entries = Object.entries(data);
      return `<div class="card">
        <div class="card-header">
          <div class="card-title">${title}</div>
          <span class="badge badge-blue">${entries.length} إدخال</span>
        </div>
        ${entries.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Thread ID</th><th>البيانات</th></tr></thead><tbody>${
          entries.slice(0,20).map(([k,v])=>`<tr><td><code>${htmlEscape(k)}</code></td><td style="font-size:.78rem;color:var(--text2);max-width:200px;overflow:hidden;text-overflow:ellipsis">${htmlEscape(JSON.stringify(v).slice(0,80))}</td></tr>`).join('')
        }</tbody></table></div>` : '<div style="text-align:center;padding:20px;color:var(--text3)">لا توجد بيانات</div>'}
      </div>`;
    }

    const body = `
<div class="page-header">
  <div class="page-title">📅 الجدولة والمحرك</div>
  <div class="page-sub">حالة Motor1/Motor2 وأقفال الأسماء والألقاب</div>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">
  ${motorCard('🔴 Motor 1 — إرسال دوري', motor1, 'm1')}
  ${motorCard('🟢 Motor 2 — إرسال دوري 2', motor2, 'm2')}
  ${motorCard('🔒 أقفال أسماء الغروبات', nmLocks, 'nm')}
  ${motorCard('👤 أقفال الألقاب', nicks, 'nick')}
</div>
<div class="card" style="margin-top:4px">
  <div class="card-header"><div class="card-title">🔄 تحديث البيانات</div></div>
  <button class="btn btn-outline" onclick="location.reload()">🔄 تحديث</button>
</div>`;
    res.send(layout('الجدولة', body, 'scheduler', pageOpts()));
  });

  // ─── HOLD (Central Control) ─────────────────────────────────────────────────
  app.get('/hold', auth, (req,res) => {
    const preTid = htmlEscape(String(req.query.tid || ''));
    const body = `
<div class="page-header">
  <div class="page-title">🎛️ التحكم المركزي</div>
  <div class="page-sub">تحكم بـ NM والكنيات والمحركات من مكان واحد</div>
</div>

<div class="card" style="margin-bottom:14px">
  <div class="card-header"><div class="card-title">🔍 اختر الغروب</div></div>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <select id="holdTid" class="form-control" style="max-width:440px" onchange="if(this.value)loadHoldStatus()">
      <option value="">⏳ جارٍ تحميل الغروبات...</option>
    </select>
    <button class="btn btn-outline btn-sm" id="holdRefreshBtn" onclick="autoLoadHoldGroups()" title="تحديث قائمة الغروبات">🔄</button>
    <button class="btn btn-primary" onclick="loadHoldStatus()">📊 تحميل الحالة</button>
  </div>
  <div id="holdStatusBanner" style="margin-top:10px;min-height:18px;font-size:.83rem"></div>
</div>

<div id="holdCards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">

  <!-- NM Card -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">🔒 NM — قفل اسم الغروب</div>
      <span id="nmBadge" class="badge badge-red">غير مفعل</span>
    </div>
    <div class="form-group">
      <label class="form-label">اسم الغروب المراد قفله</label>
      <input id="nmName" class="form-control" placeholder="اسم المجموعة..."/>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between"><span>وقت إعادة التطبيق (ثانية)</span><label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.79rem;font-weight:400;color:var(--text2)"><input type="checkbox" id="nmRandom" onchange="toggleRandom('nm')"> 🎲 عشوائي</label></label>
      <div id="nmFixedWrap"><input id="nmTime" class="form-control" type="number" min="1" value="6" placeholder="6"/><div style="font-size:.71rem;color:var(--text3);margin-top:3px">بالثواني — الحد الأدنى 1s</div></div>
      <div id="nmRandWrap" style="display:none"><div style="display:flex;gap:8px"><input id="nmRandMin" class="form-control" type="number" min="1" value="6" placeholder="من (s)"/><span style="align-self:center;color:var(--text3)">—</span><input id="nmRandMax" class="form-control" type="number" min="2" value="30" placeholder="إلى (s)"/></div><div style="font-size:.71rem;color:var(--text3);margin-top:3px">نطاق عشوائي بالثواني (مثال: 6 — 30)</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary btn-sm" onclick="nmAction('enable')">✅ تفعيل</button>
      <button class="btn btn-outline btn-sm" onclick="nmAction('disable')">🔓 إيقاف</button>
      <button class="btn btn-outline btn-sm" onclick="nmAction('time')">⏱ حفظ الوقت</button>
    </div>
    <div id="nmStatus" style="margin-top:8px;font-size:.8rem;color:var(--text3);min-height:16px"></div>
  </div>

  <!-- Nicknames Card -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">👤 كنيات — قفل الألقاب</div>
      <span id="nickBadge" class="badge badge-red">غير مفعل</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;padding:8px 0 10px;border-bottom:1px solid var(--border);margin-bottom:10px">
      <span style="font-size:.82rem;color:var(--text2);flex:1">🛡️ تفعيل / إيقاف الحماية</span>
      <button class="btn btn-primary btn-sm" onclick="nickAction('enable')">✅ تفعيل</button>
      <button class="btn btn-outline btn-sm" onclick="nickAction('disable')">⏹ إيقاف</button>
    </div>
    <div class="form-group">
      <label class="form-label">الكنية</label>
      <input id="nickName" class="form-control" placeholder="الكنية المطلوبة..."/>
    </div>
    <div class="form-group">
      <label class="form-label">النطاق</label>
      <select id="nickScope" class="form-control">
        <option value="all">👥 الجميع</option>
        <option value="bot">🤖 البوت فقط</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between"><span>وقت إعادة التطبيق</span><label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.79rem;font-weight:400;color:var(--text2)"><input type="checkbox" id="nickRandom" onchange="toggleRandom('nick')"> 🎲 عشوائي</label></label>
      <div id="nickFixedWrap"><input id="nickTime" class="form-control" type="number" min="100" value="500" placeholder="500"/><div style="font-size:.71rem;color:var(--text3);margin-top:3px">بالميلي ثانية — الحد الأدنى 100ms</div></div>
      <div id="nickRandWrap" style="display:none"><div style="display:flex;gap:8px"><input id="nickRandMin" class="form-control" type="number" min="1" value="30" placeholder="من (s)"/><span style="align-self:center;color:var(--text3)">—</span><input id="nickRandMax" class="form-control" type="number" min="2" value="120" placeholder="إلى (s)"/></div><div style="font-size:.71rem;color:var(--text3);margin-top:3px">نطاق عشوائي بالثواني</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="nickAction('time')">⏱ حفظ الوقت</button>
    </div>
    <div id="nickStatus" style="margin-top:8px;font-size:.8rem;color:var(--text3);min-height:16px"></div>

    <!-- Global Lock Section -->
    <div style="margin-top:12px;padding:10px 12px;border:1px dashed var(--border);border-radius:8px">
      <div style="font-size:.82rem;font-weight:600;color:var(--text2);margin-bottom:10px">🌐 قفل شامل لجميع الأعضاء</div>
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label" style="font-size:.76rem">كنية مشتركة للكل</label>
        <input id="nickGlobal" class="form-control" style="font-size:.83rem" placeholder="مثال: عضو"/>
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label" style="font-size:.76rem">كنية البوت (مخصصة) — اختياري</label>
        <input id="nickBotOverride" class="form-control" style="font-size:.83rem" placeholder="فارغ = نفس الكنية الشاملة"/>
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label" style="font-size:.76rem;display:flex;align-items:center;justify-content:space-between">
          <span>استثناءات (أعضاء بكنيات خاصة)</span>
          <button class="btn btn-outline" style="padding:1px 8px;font-size:.72rem;line-height:1.6" onclick="addOverrideRow()">＋ إضافة</button>
        </label>
        <div id="overridesList" style="display:flex;flex-direction:column;gap:5px;margin-top:3px"></div>
      </div>
      <button class="btn btn-primary btn-sm" style="width:100%;margin-top:2px" onclick="applyGlobalLock()">🔒 تطبيق القفل الشامل</button>
    </div>
  </div>

  <!-- Motor 1 Card -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">🔴 محرك 1 — إرسال دوري</div>
      <span id="m1Badge" class="badge badge-red">غير مفعل</span>
    </div>
    <div class="form-group">
      <label class="form-label">الرسالة</label>
      <textarea id="m1Msg" class="form-control" rows="2" placeholder="نص الرسالة التلقائية..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between"><span>الفترة الزمنية (ثانية)</span><label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.79rem;font-weight:400;color:var(--text2)"><input type="checkbox" id="m1Random" onchange="toggleRandom('m1')"> 🎲 عشوائي</label></label>
      <div id="m1FixedWrap"><input id="m1Time" class="form-control" type="number" min="5" value="30" placeholder="30"/><div style="font-size:.71rem;color:var(--text3);margin-top:3px">بالثواني — الحد الأدنى 5s</div></div>
      <div id="m1RandWrap" style="display:none"><div style="display:flex;gap:8px"><input id="m1RandMin" class="form-control" type="number" min="5" value="15" placeholder="من (s)"/><span style="align-self:center;color:var(--text3)">—</span><input id="m1RandMax" class="form-control" type="number" min="10" value="60" placeholder="إلى (s)"/></div><div style="font-size:.71rem;color:var(--text3);margin-top:3px">نطاق عشوائي بالثواني — الحد الأدنى 5s</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="m1Action('message')">💾 حفظ الرسالة</button>
      <button class="btn btn-outline btn-sm" onclick="m1Action('time')">⏱ حفظ الوقت</button>
    </div>
    <div class="btn-row" style="margin-top:6px">
      <button class="btn btn-primary btn-sm" onclick="m1Action('enable')">▶️ تشغيل</button>
      <button class="btn btn-outline btn-sm" onclick="m1Action('disable')">⏹ إيقاف</button>
    </div>
    <div id="m1Status" style="margin-top:8px;font-size:.8rem;color:var(--text3);min-height:16px"></div>
    <div id="m1Preview" style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:6px;display:none">
      <div style="font-size:.72rem;font-weight:600;color:var(--text3);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between">
        <span>📨 آخر رسالة مُرسلة</span>
        <span id="m1BackoffBadge" style="color:var(--yellow);font-size:.7rem"></span>
      </div>
      <div id="m1PrevMsg" style="font-size:.78rem;color:var(--text2);margin-bottom:5px;word-break:break-word;font-style:italic;max-height:40px;overflow:hidden"></div>
      <div style="display:flex;gap:14px;font-size:.72rem;color:var(--text3)">
        <span>🕐 آخر: <b id="m1LastSent" style="color:var(--text2)">—</b></span>
        <span>⏭ التالي: <b id="m1NextSend" style="color:var(--text2)">—</b></span>
      </div>
    </div>
  </div>

  <!-- Motor 2 Card -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">🟢 محرك 2 — إرسال ذكي</div>
      <span id="m2Badge" class="badge badge-red">غير مفعل</span>
    </div>
    <div class="form-group">
      <label class="form-label">الرسالة</label>
      <textarea id="m2Msg" class="form-control" rows="2" placeholder="نص الرسالة التلقائية..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between"><span>الفترة الزمنية (ثانية)</span><label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.79rem;font-weight:400;color:var(--text2)"><input type="checkbox" id="m2Random" onchange="toggleRandom('m2')"> 🎲 عشوائي</label></label>
      <div id="m2FixedWrap"><input id="m2Time" class="form-control" type="number" min="5" value="30" placeholder="30"/><div style="font-size:.71rem;color:var(--text3);margin-top:3px">بالثواني — الحد الأدنى 5s</div></div>
      <div id="m2RandWrap" style="display:none"><div style="display:flex;gap:8px"><input id="m2RandMin" class="form-control" type="number" min="5" value="20" placeholder="من (s)"/><span style="align-self:center;color:var(--text3)">—</span><input id="m2RandMax" class="form-control" type="number" min="10" value="90" placeholder="إلى (s)"/></div><div style="font-size:.71rem;color:var(--text3);margin-top:3px">نطاق عشوائي بالثواني — الحد الأدنى 5s</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="m2Action('message')">💾 حفظ الرسالة</button>
      <button class="btn btn-outline btn-sm" onclick="m2Action('time')">⏱ حفظ الوقت</button>
    </div>
    <div class="btn-row" style="margin-top:6px">
      <button class="btn btn-primary btn-sm" onclick="m2Action('enable')">▶️ تشغيل</button>
      <button class="btn btn-outline btn-sm" onclick="m2Action('disable')">⏹ إيقاف</button>
    </div>
    <div id="m2Status" style="margin-top:8px;font-size:.8rem;color:var(--text3);min-height:16px"></div>
    <div id="m2Preview" style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:6px;display:none">
      <div style="font-size:.72rem;font-weight:600;color:var(--text3);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between">
        <span>📨 آخر رسالة مُرسلة</span>
        <span id="m2BackoffBadge" style="color:var(--yellow);font-size:.7rem"></span>
      </div>
      <div id="m2PrevMsg" style="font-size:.78rem;color:var(--text2);margin-bottom:5px;word-break:break-word;font-style:italic;max-height:40px;overflow:hidden"></div>
      <div style="display:flex;gap:14px;font-size:.72rem;color:var(--text3)">
        <span>🕐 آخر: <b id="m2LastSent" style="color:var(--text2)">—</b></span>
        <span>⏭ التالي: <b id="m2NextSend" style="color:var(--text2)">—</b></span>
      </div>
    </div>
  </div>

  <!-- Message Requests Card -->
  <div class="card" style="grid-column:1/-1">
    <div class="card-header">
      <div class="card-title">📩 طلبات الرسائل المعلّقة</div>
      <button class="btn btn-outline btn-sm" onclick="loadMsgRequests()">🔄 تحديث</button>
    </div>
    <div id="msgReqStatus" style="font-size:.82rem;color:var(--text3);margin-bottom:10px;min-height:16px"></div>
    <div id="msgReqList" style="font-size:.84rem;color:var(--text3)">⏳ جارٍ التحميل...</div>
  </div>

</div>

<!-- Group Picker Modal -->
<div id="holdPickerModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.85);backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(540px,95vw);max-height:80vh;display:flex;flex-direction:column;padding:20px;gap:12px">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div style="font-weight:700">📋 اختر الغروب</div>
      <button onclick="closeHoldPicker()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:1.1rem">✕</button>
    </div>
    <input id="holdPickerSearch" class="form-control" placeholder="🔍 بحث..." oninput="filterHoldPicker()"/>
    <div id="holdPickerStatus" style="font-size:.83rem;color:var(--text3)"></div>
    <div id="holdPickerList" style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:6px"></div>
  </div>
</div>

<script>
let _holdGroups=[];
function tid(){return document.getElementById('holdTid').value.trim();}
function setBadge(id,on){const el=document.getElementById(id);if(!el)return;el.className='badge '+(on?'badge-green':'badge-red');el.textContent=on?'مفعل':'غير مفعل';}
function setInfo(id,msg,ok){const el=document.getElementById(id);if(!el)return;el.innerHTML='<span style="color:var(--'+(ok?'green':'red')+')">'+(ok?'✅':'❌')+' '+msg+'</span>';}

function toggleRandom(prefix){
  const on=document.getElementById(prefix+'Random').checked;
  document.getElementById(prefix+'FixedWrap').style.display=on?'none':'';
  document.getElementById(prefix+'RandWrap').style.display=on?'':'none';
}

function fmtRelTime(ts){
  if(!ts)return '—';
  const diff=Date.now()-ts;
  const future=diff<0;
  const abs=Math.abs(diff);
  const s=Math.floor(abs/1000);
  const m=Math.floor(s/60);
  const h=Math.floor(m/60);
  let str;
  if(s<60)str=s+'ث';
  else if(m<60)str=m+'د '+(s%60)+'ث';
  else str=h+'س '+(m%60)+'د';
  return (future?'خلال ':'منذ ')+str;
}

function populateMotorPreview(prefix, data){
  const hasStats = data && (data.lastSentAt || data.nextSendAt || data.backoffMs);
  const isActive = data && data.status;
  const el = document.getElementById(prefix+'Preview');
  if(!el) return;
  if(isActive || hasStats){
    el.style.display='';
    const msg = (data.message||'').slice(0,80);
    document.getElementById(prefix+'PrevMsg').textContent = msg ? '"'+msg+(msg.length<(data.message||'').length?'...':'')+'"' : '(لا توجد رسالة محفوظة)';
    document.getElementById(prefix+'LastSent').textContent = fmtRelTime(data.lastSentAt||null);
    document.getElementById(prefix+'NextSend').textContent = fmtRelTime(data.nextSendAt||null);
    const bb = document.getElementById(prefix+'BackoffBadge');
    if(bb) bb.textContent = data.backoffMs>0 ? '⚠️ انتظار '+Math.round(data.backoffMs/1000)+'s' : '';
  } else {
    el.style.display='none';
  }
}

function addOverrideRow(uid, nick){
  uid = uid||''; nick = nick||'';
  const list = document.getElementById('overridesList');
  if(!list) return;
  const row = document.createElement('div');
  row.className = 'override-row';
  row.style.cssText = 'display:flex;gap:5px;align-items:center';
  const uidEl = document.createElement('input');
  uidEl.className = 'form-control override-uid';
  uidEl.style.cssText = 'flex:1;font-size:.78rem';
  uidEl.placeholder = 'Account ID...';
  uidEl.value = uid;
  const nickEl = document.createElement('input');
  nickEl.className = 'form-control override-nick';
  nickEl.style.cssText = 'flex:2;font-size:.78rem';
  nickEl.placeholder = 'الكنية...';
  nickEl.value = nick;
  const del = document.createElement('button');
  del.className = 'btn btn-outline';
  del.style.cssText = 'padding:2px 7px;font-size:.8rem;flex-shrink:0;color:var(--red)';
  del.textContent = '✕';
  del.onclick = function(){ row.remove(); };
  row.appendChild(uidEl); row.appendChild(nickEl); row.appendChild(del);
  list.appendChild(row);
}

async function applyGlobalLock(){
  const t=tid(); if(!t) return showToast('أدخل Thread ID','error');
  const globalNick = document.getElementById('nickGlobal').value.trim();
  if(!globalNick) return showToast('أدخل الكنية الشاملة','error');
  const botOverride = document.getElementById('nickBotOverride').value.trim()||null;
  const memberOverrides = {};
  document.querySelectorAll('#overridesList .override-row').forEach(function(row){
    const uid = row.querySelector('.override-uid').value.trim();
    const nick = row.querySelector('.override-nick').value.trim();
    if(uid&&nick) memberOverrides[uid]=nick;
  });
  const r = await api('/api/hold/nick-set',{threadID:t, action:'global-lock', globalNick, botOverride, memberOverrides});
  if(r.ok){ setBadge('nickBadge',true); setInfo('nickStatus','تم تطبيق القفل الشامل 🔒',true); showToast('✅ القفل الشامل مفعّل','success'); }
  else{ setInfo('nickStatus',r.error||'فشل',false); showToast('❌ '+(r.error||'فشل'),'error'); }
}

async function loadHoldStatus(){
  const t=tid();
  if(!t)return showToast('أدخل Thread ID','error');
  const st=document.getElementById('holdStatusBanner');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ التحميل...</span>';
  const r=await api('/api/hold/status',{threadID:t});
  if(!r.ok){st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';return;}
  st.innerHTML='<span style="color:var(--green)">✅ تم تحميل حالة: '+t+'</span>';
  // NM
  setBadge('nmBadge',r.nm?.locked);
  if(r.nm?.locked){
    document.getElementById('nmName').value=r.nm.name||'';
    if(r.nm.randomTime&&r.nm.randomRange){
      document.getElementById('nmRandom').checked=true;toggleRandom('nm');
      document.getElementById('nmRandMin').value=Math.round((r.nm.randomRange.min||6000)/1000);
      document.getElementById('nmRandMax').value=Math.round((r.nm.randomRange.max||30000)/1000);
      document.getElementById('nmStatus').textContent='مقفول على: "'+r.nm.name+'" — 🎲 '+Math.round((r.nm.randomRange.min||6000)/1000)+'s–'+Math.round((r.nm.randomRange.max||30000)/1000)+'s';
    } else {
      document.getElementById('nmRandom').checked=false;toggleRandom('nm');
      document.getElementById('nmTime').value=Math.round((r.nm.time||6000)/1000);
      document.getElementById('nmStatus').textContent='مقفول على: "'+r.nm.name+'" — كل '+Math.round((r.nm.time||6000)/1000)+'s';
    }
  }
  // Nicknames
  setBadge('nickBadge',r.nick?.locked);
  if(r.nick?.locked){
    document.getElementById('nickName').value=r.nick.nickname||'';
    document.getElementById('nickScope').value=r.nick.scope||'all';
    if(r.nick.randomTime&&r.nick.randomRange){
      document.getElementById('nickRandom').checked=true;toggleRandom('nick');
      document.getElementById('nickRandMin').value=Math.round((r.nick.randomRange.min||30000)/1000);
      document.getElementById('nickRandMax').value=Math.round((r.nick.randomRange.max||120000)/1000);
      document.getElementById('nickStatus').textContent='مقفول على: "'+r.nick.nickname+'" ('+r.nick.scope+') — 🎲 '+Math.round((r.nick.randomRange.min||30000)/1000)+'s–'+Math.round((r.nick.randomRange.max||120000)/1000)+'s';
    } else {
      document.getElementById('nickRandom').checked=false;toggleRandom('nick');
      document.getElementById('nickTime').value=r.nick.time||500;
      document.getElementById('nickStatus').textContent='مقفول على: "'+r.nick.nickname+'" ('+r.nick.scope+') — كل '+r.nick.time+'ms';
    }
    // Global lock fields
    if(r.nick.globalNick){
      document.getElementById('nickGlobal').value=r.nick.globalNick;
      document.getElementById('nickBotOverride').value=r.nick.botOverride||'';
      document.getElementById('overridesList').innerHTML='';
      var overrides=r.nick.memberOverrides||{};
      Object.keys(overrides).forEach(function(uid){ addOverrideRow(uid,overrides[uid]); });
    }
  }
  // Motor 1
  setBadge('m1Badge',r.motor1?.status);
  if(r.motor1?.message)document.getElementById('m1Msg').value=r.motor1.message;
  if(r.motor1?.randomTime&&r.motor1?.randomRange){
    document.getElementById('m1Random').checked=true;toggleRandom('m1');
    document.getElementById('m1RandMin').value=Math.round((r.motor1.randomRange.min||15000)/1000);
    document.getElementById('m1RandMax').value=Math.round((r.motor1.randomRange.max||60000)/1000);
    document.getElementById('m1Status').textContent=r.motor1.status?'نشط — 🎲 '+Math.round((r.motor1.randomRange.min||15000)/1000)+'s–'+Math.round((r.motor1.randomRange.max||60000)/1000)+'s':'متوقف';
  } else if(r.motor1?.time){
    document.getElementById('m1Random').checked=false;toggleRandom('m1');
    document.getElementById('m1Time').value=Math.round(r.motor1.time/1000);
    document.getElementById('m1Status').textContent=r.motor1.status?'نشط — رسالة: "'+(r.motor1.message||'').slice(0,30)+'" — كل '+Math.round((r.motor1.time||0)/1000)+'s':'متوقف';
  } else { document.getElementById('m1Status').textContent=r.motor1?.status?'نشط':'متوقف'; }
  populateMotorPreview('m1', r.motor1);
  // Motor 2
  setBadge('m2Badge',r.motor2?.status);
  if(r.motor2?.message)document.getElementById('m2Msg').value=r.motor2.message;
  if(r.motor2?.randomTime&&r.motor2?.randomRange){
    document.getElementById('m2Random').checked=true;toggleRandom('m2');
    document.getElementById('m2RandMin').value=Math.round((r.motor2.randomRange.min||20000)/1000);
    document.getElementById('m2RandMax').value=Math.round((r.motor2.randomRange.max||90000)/1000);
    document.getElementById('m2Status').textContent=r.motor2.status?'نشط — 🎲 '+Math.round((r.motor2.randomRange.min||20000)/1000)+'s–'+Math.round((r.motor2.randomRange.max||90000)/1000)+'s':'متوقف';
  } else if(r.motor2?.time){
    document.getElementById('m2Random').checked=false;toggleRandom('m2');
    document.getElementById('m2Time').value=Math.round(r.motor2.time/1000);
    document.getElementById('m2Status').textContent=r.motor2.status?'نشط — رسالة: "'+(r.motor2.message||'').slice(0,30)+'" — كل '+Math.round((r.motor2.time||0)/1000)+'s':'متوقف';
  } else { document.getElementById('m2Status').textContent=r.motor2?.status?'نشط':'متوقف'; }
  populateMotorPreview('m2', r.motor2);
}

async function nmAction(action){
  const t=tid();if(!t)return showToast('أدخل Thread ID','error');
  const isRand=document.getElementById('nmRandom').checked;
  let payload={threadID:t,action};
  if(action==='enable'){
    payload.name=document.getElementById('nmName').value.trim();
    if(isRand){payload.randomMin=Number(document.getElementById('nmRandMin').value)*1000;payload.randomMax=Number(document.getElementById('nmRandMax').value)*1000;}
    else{payload.timeMs=Number(document.getElementById('nmTime').value)*1000;}
  }
  if(action==='time'){
    if(isRand){payload.action='random-time';payload.randomMin=Number(document.getElementById('nmRandMin').value)*1000;payload.randomMax=Number(document.getElementById('nmRandMax').value)*1000;}
    else{payload.timeMs=Number(document.getElementById('nmTime').value)*1000;}
  }
  const r=await api('/api/hold/nm-set',payload);
  if(r.ok){setInfo('nmStatus',action==='enable'?'تم تفعيل قفل الاسم':action==='disable'?'تم إيقاف القفل':isRand?'تم حفظ الوقت العشوائي 🎲':'تم حفظ الوقت',true);setBadge('nmBadge',action==='enable');showToast('✅ NM: '+action,'success');}
  else{setInfo('nmStatus',r.error||'فشل',false);showToast('❌ '+(r.error||'فشل'),'error');}
}

async function nickAction(action){
  const t=tid();if(!t)return showToast('أدخل Thread ID','error');
  const isRand=document.getElementById('nickRandom').checked;
  let payload={threadID:t,action,scope:document.getElementById('nickScope').value};
  if(action==='enable'){
    payload.nickname=document.getElementById('nickName').value.trim();
    if(isRand){payload.randomMin=Number(document.getElementById('nickRandMin').value)*1000;payload.randomMax=Number(document.getElementById('nickRandMax').value)*1000;}
    else{payload.timeMs=Number(document.getElementById('nickTime').value);}
  }
  if(action==='time'){
    if(isRand){payload.action='random-time';payload.randomMin=Number(document.getElementById('nickRandMin').value)*1000;payload.randomMax=Number(document.getElementById('nickRandMax').value)*1000;}
    else{payload.timeMs=Number(document.getElementById('nickTime').value);}
  }
  const r=await api('/api/hold/nick-set',payload);
  if(r.ok){setInfo('nickStatus',action==='enable'?'تم تفعيل حماية الكنيات':action==='disable'?'تم إيقاف الحماية':isRand?'تم حفظ الوقت العشوائي 🎲':'تم حفظ الوقت',true);setBadge('nickBadge',action==='enable');showToast('✅ كنيات: '+action,'success');}
  else{setInfo('nickStatus',r.error||'فشل',false);showToast('❌ '+(r.error||'فشل'),'error');}
}

async function m1Action(action){
  const t=tid();if(!t)return showToast('أدخل Thread ID','error');
  const isRand=document.getElementById('m1Random').checked;
  let payload={threadID:t,action};
  if(action==='message')payload.message=document.getElementById('m1Msg').value.trim();
  if(action==='time'){
    if(isRand){payload.action='random-time';payload.randomMin=Number(document.getElementById('m1RandMin').value)*1000;payload.randomMax=Number(document.getElementById('m1RandMax').value)*1000;}
    else{payload.timeMs=Number(document.getElementById('m1Time').value)*1000;}
  }
  const r=await api('/api/hold/motor1-set',payload);
  if(r.ok){const active=action==='enable';setInfo('m1Status',action==='enable'?'تم تشغيل المحرك':action==='disable'?'تم إيقاف المحرك':isRand&&(action==='time'||payload.action==='random-time')?'تم حفظ الوقت العشوائي 🎲':'تم الحفظ',true);if(action==='enable'||action==='disable')setBadge('m1Badge',active);showToast('✅ محرك1: '+action,'success');}
  else{setInfo('m1Status',r.error||'فشل',false);showToast('❌ '+(r.error||'فشل'),'error');}
}

async function m2Action(action){
  const t=tid();if(!t)return showToast('أدخل Thread ID','error');
  const isRand=document.getElementById('m2Random').checked;
  let payload={threadID:t,action};
  if(action==='message')payload.message=document.getElementById('m2Msg').value.trim();
  if(action==='time'){
    if(isRand){payload.action='random-time';payload.randomMin=Number(document.getElementById('m2RandMin').value)*1000;payload.randomMax=Number(document.getElementById('m2RandMax').value)*1000;}
    else{payload.timeMs=Number(document.getElementById('m2Time').value)*1000;}
  }
  const r=await api('/api/hold/motor2-set',payload);
  if(r.ok){const active=action==='enable';setInfo('m2Status',action==='enable'?'تم تشغيل المحرك':action==='disable'?'تم إيقاف المحرك':isRand&&(action==='time'||payload.action==='random-time')?'تم حفظ الوقت العشوائي 🎲':'تم الحفظ',true);if(action==='enable'||action==='disable')setBadge('m2Badge',active);showToast('✅ محرك2: '+action,'success');}
  else{setInfo('m2Status',r.error||'فشل',false);showToast('❌ '+(r.error||'فشل'),'error');}
}

async function openGroupPicker(){
  document.getElementById('holdPickerModal').style.display='flex';
  const st=document.getElementById('holdPickerStatus');
  st.textContent='⏳ جارٍ جلب الغروبات...';
  const d=await fetch('/api/groups-list').then(r=>r.json()).catch(()=>({}));
  _holdGroups=d.groups||[];
  st.textContent=_holdGroups.length?'اختر الغروب:':'لا توجد غروبات';
  renderHoldPicker(_holdGroups);
}
function closeHoldPicker(){document.getElementById('holdPickerModal').style.display='none';}
function filterHoldPicker(){const s=document.getElementById('holdPickerSearch').value.toLowerCase();renderHoldPicker(_holdGroups.filter(g=>(g.name||'').toLowerCase().includes(s)||(g.threadID||'').includes(s)));}
function renderHoldPicker(groups){
  const list=document.getElementById('holdPickerList');
  if(!groups.length){list.innerHTML='<div style="text-align:center;padding:32px;color:var(--text3)">لا توجد نتائج</div>';return;}
  list.innerHTML=groups.map(function(g){return '<div onclick="pickHoldGroup(this)" data-tid="'+g.threadID+'" style="cursor:pointer;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);display:flex;justify-content:space-between;align-items:center"><span style="font-weight:600">'+htmlE(g.name||'\u2014')+'</span><code style="font-size:.75rem;color:var(--text3)">'+g.threadID+'</code></div>';}).join('');
}
function htmlE(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function pickHoldGroup(el){var id=el.dataset?el.dataset.tid:el;document.getElementById('holdTid').value=id;closeHoldPicker();loadHoldStatus();}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){ closeHoldPicker(); closeMsgModal(); }});

async function autoLoadHoldGroups(){
  const sel=document.getElementById('holdTid');
  const btn=document.getElementById('holdRefreshBtn');
  const banner=document.getElementById('holdStatusBanner');
  if(!sel)return;
  sel.innerHTML='<option value="">⏳ جارٍ تحميل الغروبات...</option>';
  if(btn){btn.disabled=true;btn.textContent='⏳';}
  try{
    const resp=await fetch('/api/groups-list');
    const d=resp.ok?await resp.json():{};
    _holdGroups=d.groups||[];
    if(!_holdGroups.length){
      sel.innerHTML='<option value="">⚠️ لا توجد غروبات — تأكد من اتصال البوت بالغروبات</option>';
      showToast('لا توجد غروبات — ' + (d.error||'البوت غير متصل'),'error');
      return;
    }
    sel.innerHTML='<option value="">— اختر الغروب —</option>'+
      _holdGroups.map(g=>'<option value="'+g.threadID+'">'+htmlE(g.name||'—')+' ('+g.threadID+')</option>').join('');
    // Show a subtle notice if data came from the local cache (bot offline)
    if(d.cached&&banner){
      banner.innerHTML='<span style="color:var(--text3);font-size:.8rem">📦 بيانات الغروبات من الكاش (البوت قد يكون غير متصل) — اضغط 🔄 بعد الاتصال</span>';
    }
    const preTid='${preTid}';
    if(preTid){sel.value=preTid;if(sel.value)loadHoldStatus();}
    showToast((d.cached?'📦 كاش: ':'✅ ')+_holdGroups.length+' غروب','success');
  }catch(e){
    sel.innerHTML='<option value="">❌ فشل تحميل الغروبات: '+htmlE(e.message)+'</option>';
    showToast('❌ فشل تحميل الغروبات','error');
  } finally {
    if(btn){btn.disabled=false;btn.textContent='🔄';}
  }
}
document.addEventListener('DOMContentLoaded',()=>{autoLoadHoldGroups();loadMsgRequests();});

// ── Message Requests ────────────────────────────────────────────────────────
async function loadMsgRequests(){
  const st=document.getElementById('msgReqStatus');
  const list=document.getElementById('msgReqList');
  st.textContent='⏳ جارٍ الجلب...';
  list.innerHTML='';
  try{
    const r=await fetch('/api/message-requests');
    const d=await r.json();
    const reqs=Array.isArray(d)?d:(d.requests||d||[]);
    if(!reqs.length){
      st.textContent='';
      list.innerHTML='<span style="color:var(--text3)">📭 لا توجد طلبات رسائل معلّقة</span>';
      return;
    }
    st.textContent=reqs.length+' طلب معلّق';
    list.innerHTML=reqs.map(function(req){
      const id=htmlE(req.threadID||req.id||'');
      const name=htmlE(req.name||req.threadName||id);
      const isGrp=req.isGroup?'<span class="badge badge-blue">غروب</span>':'<span class="badge badge-purple">دايركت</span>';
      const folderBadge=(req.folder||'').toUpperCase()==='OTHER'?'<span class="badge" style="background:rgba(255,160,0,.18);color:#ffa000;border:1px solid rgba(255,160,0,.3)">فلتر</span>':'<span class="badge" style="background:rgba(0,180,120,.15);color:var(--green);border:1px solid rgba(0,180,120,.3)">طلب جديد</span>';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);gap:10px;flex-wrap:wrap">' +
        '<div><div style="font-weight:600;color:var(--text)">'+name+'</div>' +
        '<div style="font-size:.75rem;color:var(--text3);margin-top:2px;display:flex;gap:6px;align-items:center"><code style="font-size:.73rem">'+id+'</code>'+isGrp+folderBadge+'</div></div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0">' +
        '<button class="btn btn-outline btn-sm" style="color:var(--green)" data-rid="'+id+'" data-rname="'+name+'" onclick="msgReqAction(this.dataset.rid,\\'accept\\',this.dataset.rname)">✅ قبول</button>' +
        '<button class="btn btn-outline btn-sm" style="color:var(--red)"   data-rid="'+id+'" data-rname="'+name+'" onclick="msgReqAction(this.dataset.rid,\\'decline\\',this.dataset.rname)">❌ رفض</button>' +
        '</div></div>';
    }).join('');
  }catch(e){
    st.textContent='';
    list.innerHTML='<span style="color:var(--red)">❌ '+htmlE(e.message)+'</span>';
  }
}

// ── Message Request modal ─────────────────────────────────────────
let _msgReqModal=null;
function _ensureMsgModal(){
  if(_msgReqModal)return _msgReqModal;
  const el=document.createElement('div');
  el.id='msgReqModal';
  el.style.cssText='display:none;position:fixed;inset:0;z-index:9800;background:rgba(0,0,0,.85);backdrop-filter:blur(6px);align-items:center;justify-content:center';
  el.innerHTML='<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(420px,95vw);padding:24px;display:flex;flex-direction:column;gap:14px">'+
    '<div style="font-weight:700;font-size:1rem" id="msgReqModalTitle">تأكيد</div>'+
    '<div style="font-size:.87rem;color:var(--text2)" id="msgReqModalBody"></div>'+
    '<div class="btn-row">'+
      '<button id="msgReqModalConfirm" class="btn btn-primary">تأكيد</button>'+
      '<button class="btn btn-outline" onclick="closeMsgModal()">إلغاء</button>'+
    '</div>'+
    '<div id="msgReqModalStatus" style="font-size:.82rem;min-height:16px"></div>'+
  '</div>';
  document.body.appendChild(el);
  _msgReqModal=el;
  return el;
}
function closeMsgModal(){const m=document.getElementById('msgReqModal');if(m)m.style.display='none';}

async function msgReqAction(tid, action, name){
  const modal=_ensureMsgModal();
  const isAccept=action==='accept';
  document.getElementById('msgReqModalTitle').textContent=isAccept?'✅ قبول الطلب':'❌ رفض الطلب';
  document.getElementById('msgReqModalBody').textContent=(isAccept?'قبول طلب رسالة من: ':'رفض طلب رسالة من: ')+name+' ('+tid+')';
  document.getElementById('msgReqModalStatus').innerHTML='';
  document.getElementById('msgReqModalConfirm').onclick=async function(){
    const st=document.getElementById('msgReqModalStatus');
    st.innerHTML='⏳ جارٍ التنفيذ...';
    const r=await api('/api/message-requests/'+action,{threadID:tid});
    if(r&&(r.ok||r.accepted||r.declined)){
      st.innerHTML='<span style="color:var(--green)">✅ '+(isAccept?'تم القبول':'تم الرفض')+'</span>';
      showToast((isAccept?'✅ تم قبول الطلب':'✅ تم رفض الطلب'),'success');
      setTimeout(()=>{closeMsgModal();loadMsgRequests();},1000);
    }else{
      st.innerHTML='<span style="color:var(--red)">❌ '+(r&&r.error?htmlE(r.error):'فشل')+'</span>';
    }
  };
  modal.style.display='flex';
}

loadMsgRequests();
</script>`;
    res.send(layout('التحكم', body, 'hold', pageOpts()));
  });

  // ─── CONFIG ─────────────────────────────────────────────────────────────────
  app.get('/config', auth, (req,res) => {
    const cfg = readSettings();
    const raw = JSON.stringify(cfg, null, 2);

    const ht  = cfg.humanTyping          || {};
    const sm  = cfg.stealthMode          || {};
    const al  = cfg.autoLock             || {};
    const nkx = cfg.nkxModern            || {};
    const mq  = cfg.mqttHealthCheck      || {};
    const ka  = cfg.keepAlive            || {};
    const gnl = cfg.globalNicknameAutoLock || {};

    const toggle = (path, label, sub, checked) => `
      <div class="toggle-row">
        <div><div class="toggle-info">${label}</div>${sub?`<div class="toggle-sub">${sub}</div>`:''}</div>
        <label class="toggle"><input type="checkbox" ${checked?'checked':''} onchange="setNested('${path}',this.checked)"/><span class="slider"></span></label>
      </div>`;

    const numRow = (path, label, val, min, max, step) => `
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label" style="font-size:.78rem">${label}</label>
        <input type="number" class="form-control" value="${val||0}" min="${min}" max="${max||99999}" step="${step||1}"
          style="max-width:160px" onchange="setNested('${path}',+this.value)"/>
      </div>`;

    const textRow = (path, label, val, ph) => `
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label" style="font-size:.78rem">${label}</label>
        <input type="text" class="form-control" value="${htmlEscape(String(val||''))}" placeholder="${ph||''}"
          onchange="setNested('${path}',this.value)"/>
      </div>`;

    const body = `
<div class="page-header">
  <div class="page-title">⚙️ الإعدادات</div>
  <div class="page-sub">تعديل كامل لـ ZAO-SETTINGS.json</div>
</div>

<!-- ── Bot Identity ──────────────────────────────────────────────────────── -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;margin-bottom:14px">
  <div class="card">
    <div class="card-header"><div class="card-title">🤖 هوية البوت</div></div>
    ${textRow('BOTNAME','اسم البوت (BOTNAME)',cfg.BOTNAME,'ZAO Bot')}
    ${textRow('PREFIX','بادئة الأوامر (PREFIX)',cfg.PREFIX,'.')}
    ${textRow('OWNER','اسم المالك',cfg.OWNER,'')}
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label" style="font-size:.78rem">اللغة</label>
      <select class="form-control" style="max-width:160px" onchange="setNested('language',this.value)">
        <option ${cfg.language==='ar'?'selected':''} value="ar">🇦🇪 العربية</option>
        <option ${cfg.language==='en'?'selected':''} value="en">🇬🇧 English</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" style="font-size:.78rem">قائمة المشرفين ADMINBOT (كل ID في سطر)</label>
      <textarea class="form-control" rows="5" id="adminBotIds" placeholder="ID في كل سطر">${(cfg.ADMINBOT||[]).join('\n')}</textarea>
      <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="saveAdmins()">💾 حفظ المشرفين</button>
    </div>
  </div>

  <!-- ── Quick Toggles ── -->
  <div class="card">
    <div class="card-header"><div class="card-title">🔄 تبديلات سريعة</div></div>
    ${toggle('adminOnly','adminOnly — أوامر المشرف فقط','تجاهل أوامر غير المشرفين',cfg.adminOnly)}
    ${toggle('DeveloperMode','وضع المطور','يظهر سجلات إضافية للتصحيح',cfg.DeveloperMode)}
    ${toggle('autoClean','تنظيف تلقائي','حذف قواعد البيانات غير المستخدمة',cfg.autoClean)}
    ${toggle('allowInbox','السماح بالدردشة الخاصة','الرد على رسائل الـ Inbox',cfg.allowInbox)}
    ${toggle('autoCreateDB','إنشاء DB تلقائياً','إنشاء قاعدة بيانات جديدة عند الحاجة',cfg.autoCreateDB)}
    ${toggle('whiteListMode.enable','وضع القائمة البيضاء (مستخدمين)','قبول أوامر من مستخدمين محددين فقط',(cfg.whiteListMode||{}).enable)}
    ${toggle('whiteListModeThread.enable','وضع القائمة البيضاء (غروبات)','قبول أوامر من غروبات محددة فقط',(cfg.whiteListModeThread||{}).enable)}
  </div>
</div>

<!-- ── Security Systems ───────────────────────────────────────────────────── -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;margin-bottom:14px">

  <!-- Human Typing -->
  <div class="card">
    <div class="card-header"><div class="card-title">⌨️ محاكاة الكتابة البشرية</div><span class="badge ${ht.enable?'badge-green':'badge-red'}">${ht.enable?'مفعّل':'معطّل'}</span></div>
    ${toggle('humanTyping.enable','تفعيل محاكاة الكتابة','يضيف تأخيرات واقعية قبل الرد',ht.enable)}
    ${numRow('humanTyping.minDelay','أدنى تأخير (ms)',ht.minDelay,200,10000)}
    ${numRow('humanTyping.maxDelay','أقصى تأخير (ms)',ht.maxDelay,200,20000)}
    ${numRow('humanTyping.charsPerSecond','أحرف/ثانية',ht.charsPerSecond,1,60)}
    ${numRow('humanTyping.jitterPercent','جيتر % (تشويش)',ht.jitterPercent,0,100)}
    ${numRow('humanTyping.nightModeMultiplier','مضاعف وضع الليل',ht.nightModeMultiplier,1,10,0.1)}
    ${numRow('humanTyping.thinkingPauseChance','احتمال توقف تفكير (0-1)',ht.thinkingPauseChance,0,1,0.01)}
  </div>

  <!-- Stealth Mode -->
  <div class="card">
    <div class="card-header"><div class="card-title">🕵️ وضع التخفي</div><span class="badge ${sm.enabled?'badge-green':'badge-red'}">${sm.enabled?'مفعّل':'معطّل'}</span></div>
    ${toggle('stealthMode.enabled','تفعيل وضع التخفي','يحمي من كشف البوت',sm.enabled)}
    ${toggle('stealthMode.burstProtection','حماية الاندفاع','تقليل الردود السريعة المتتالية',sm.burstProtection)}
    ${toggle('stealthMode.nightModeSlowdown','إبطاء وضع الليل','ردود أبطأ بين 1-6 صباحاً',sm.nightModeSlowdown)}
    ${toggle('stealthMode.rotateUserAgentOnReconnect','تغيير User-Agent عند إعادة الاتصال','',sm.rotateUserAgentOnReconnect)}
    ${toggle('stealthMode.randomizeReadReceipts','عشوائية إيصالات القراءة','',sm.randomizeReadReceipts)}
    ${numRow('stealthMode.burstThreshold','حد الاندفاع (رسائل)',sm.burstThreshold,2,30)}
    ${numRow('stealthMode.burstCooldownMs','تهدئة الاندفاع (ms)',sm.burstCooldownMs,1000,60000,500)}
    ${numRow('stealthMode.nightModeStart','بداية وضع الليل (ساعة)',sm.nightModeStart,0,23)}
    ${numRow('stealthMode.nightModeEnd','نهاية وضع الليل (ساعة)',sm.nightModeEnd,0,23)}
  </div>

  <!-- Auto-Lock Guard -->
  <div class="card">
    <div class="card-header"><div class="card-title">🔒 حارس القفل التلقائي</div><span class="badge ${al.enable?'badge-green':'badge-red'}">${al.enable?'مفعّل':'معطّل'}</span></div>
    ${toggle('autoLock.enable','تفعيل القفل التلقائي','يقفل البوت عند اكتشاف هجوم أوامر',al.enable)}
    ${toggle('autoLock.notifyAdmins','إشعار المشرفين عند القفل','',al.notifyAdmins)}
    ${numRow('autoLock.maxCommands','أقصى أوامر في النافذة',al.maxCommands,1,100)}
    ${numRow('autoLock.windowSeconds','حجم النافذة (ثانية)',al.windowSeconds,5,300)}
    ${numRow('autoLock.unlockAfterMinutes','فتح تلقائي بعد (دقيقة) — 0=يدوي',al.unlockAfterMinutes,0,120)}
  </div>

  <!-- nkxModern -->
  <div class="card">
    <div class="card-header"><div class="card-title">⚡ نظام nkxModern</div><span class="badge ${nkx.enabled?'badge-green':'badge-red'}">${nkx.enabled?'مفعّل':'معطّل'}</span></div>
    ${toggle('nkxModern.enabled','تفعيل nkxModern','نظام الحماية المتقدم الرئيسي',nkx.enabled)}
    ${toggle('nkxModern.enableCircuitBreaker','قاطع الدائرة','يوقف الإرسال عند اكتشاف تعليق',nkx.enableCircuitBreaker)}
    ${toggle('nkxModern.enableWarmup','تسخين الجلسة','يبدأ بإرسال بطيء بعد تسجيل الدخول',nkx.enableWarmup)}
    ${toggle('nkxModern.enableTypingWrap','مؤشر الكتابة','يرسل typing indicator قبل كل رسالة',nkx.enableTypingWrap)}
    ${toggle('nkxModern.enableHealthBroadcast','بث الصحة','يبث حالة البوت للمشرفين',nkx.enableHealthBroadcast)}
    ${toggle('nkxModern.postSafeGuard','حماية الإرسال','تضيف حواجز أمان إضافية',nkx.postSafeGuard)}
    ${numRow('nkxModern.sendWindowLimit','حد الإرسال في النافذة',nkx.sendWindowLimit,1,50)}
    ${numRow('nkxModern.maxSendConcurrency','أقصى إرسال متزامن',nkx.maxSendConcurrency,1,10)}
    ${numRow('nkxModern.warmupMinutes','وقت التسخين (دقيقة)',nkx.warmupMinutes,1,120)}
  </div>

  <!-- MQTT Health -->
  <div class="card">
    <div class="card-header"><div class="card-title">📡 صحة MQTT</div><span class="badge ${mq.enable?'badge-green':'badge-red'}">${mq.enable?'مفعّل':'معطّل'}</span></div>
    ${toggle('mqttHealthCheck.enable','تفعيل مراقبة MQTT','يعيد الاتصال تلقائياً عند الانقطاع',mq.enable)}
    ${toggle('mqttHealthCheck.notifyAdmins','إشعار المشرفين عند إعادة التشغيل','',mq.notifyAdmins)}
    ${numRow('mqttHealthCheck.silentTimeoutMinutes','مهلة الصمت (دقيقة)',mq.silentTimeoutMinutes,1,60)}
    ${numRow('mqttHealthCheck.maxRestarts','أقصى إعادات تشغيل',mq.maxRestarts,1,20)}
    ${numRow('mqttHealthCheck.backoffMultiplier','مضاعف الـ Backoff',mq.backoffMultiplier,1,5,0.1)}
    ${numRow('mqttHealthCheck.maxBackoffMinutes','أقصى Backoff (دقيقة)',mq.maxBackoffMinutes,1,120)}
  </div>

  <!-- Keep Alive -->
  <div class="card">
    <div class="card-header"><div class="card-title">💓 الإبقاء على الجلسة</div><span class="badge ${ka.enabled?'badge-green':'badge-red'}">${ka.enabled?'مفعّل':'معطّل'}</span></div>
    ${toggle('keepAlive.enabled','تفعيل KeepAlive','',ka.enabled)}
    ${numRow('keepAlive.pingMinIntervalMin','أدنى فاصل Ping (دقيقة)',ka.pingMinIntervalMin,1,60)}
    ${numRow('keepAlive.pingMaxIntervalMin','أقصى فاصل Ping (دقيقة)',ka.pingMaxIntervalMin,1,120)}
    ${numRow('keepAlive.saveCookiesIntervalHours','حفظ الكوكيز كل (ساعة)',ka.saveCookiesIntervalHours,1,48)}
    ${numRow('keepAlive.refreshDtsgIntervalHours','تحديث DTSG كل (ساعة)',ka.refreshDtsgIntervalHours,1,168)}
  </div>

  <!-- Global Nickname Auto-Lock -->
  <div class="card">
    <div class="card-header"><div class="card-title">👤 قفل اللقب العالمي</div><span class="badge ${gnl.enable?'badge-green':'badge-red'}">${gnl.enable?'مفعّل':'معطّل'}</span></div>
    ${toggle('globalNicknameAutoLock.enable','تفعيل القفل التلقائي للقب','يُطبّق لقباً على البوت في جميع الغروبات',gnl.enable)}
    ${textRow('globalNicknameAutoLock.nickname','اللقب المراد تطبيقه',gnl.nickname,'مثال: ZAO Bot')}
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label" style="font-size:.78rem">النطاق</label>
      <select class="form-control" style="max-width:160px" onchange="setNested('globalNicknameAutoLock.scope',this.value)">
        <option ${gnl.scope==='bot'?'selected':''} value="bot">🤖 البوت فقط</option>
        <option ${gnl.scope==='all'?'selected':''} value="all">👥 الجميع</option>
      </select>
    </div>
    ${numRow('globalNicknameAutoLock.intervalMs','فاصل إعادة التطبيق (ms)',gnl.intervalMs,5000,300000,1000)}
    <div style="font-size:.75rem;color:var(--text3);margin-top:4px">💡 تأكد من تفعيل هذا الخيار وإدخال اللقب، ثم أعد تشغيل البوت ليطبّقه.</div>
  </div>

</div>

<!-- ── Raw JSON Editor ────────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-header">
    <div class="card-title">🗂 تعديل JSON الكامل</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-success btn-sm" onclick="saveRaw()">💾 حفظ</button>
      <button class="btn btn-outline btn-sm" onclick="formatJson()">✨ تنسيق</button>
      <button class="btn btn-outline btn-sm" onclick="reloadRaw()">🔄 تحديث</button>
    </div>
  </div>
  <textarea id="rawConfig" class="form-control" rows="22" style="font-family:monospace;font-size:.78rem">${htmlEscape(raw)}</textarea>
  <div id="rawStatus" style="margin-top:8px;font-size:.82rem;min-height:22px"></div>
</div>

<script>
async function setNested(path,val){
  const r=await api('/api/config/set-nested',{path,value:val});
  if(r.ok)showToast('✅ تم حفظ '+path,'success');
  else showToast('❌ '+(r.error||'فشل'),'error');
}
async function saveAdmins(){
  const ids=document.getElementById('adminBotIds').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  const r=await api('/api/config/set-nested',{path:'ADMINBOT',value:ids});
  if(r.ok)showToast('✅ تم حفظ قائمة المشرفين','success');
  else showToast('❌ '+(r.error||'فشل'),'error');
}
async function reloadRaw(){
  const r=await fetch('/api/config');const d=await r.json();
  document.getElementById('rawConfig').value=JSON.stringify(d,null,2);
  showToast('✅ تم التحديث','success');
}
async function saveRaw(){
  const val=document.getElementById('rawConfig').value;
  const st=document.getElementById('rawStatus');
  try{JSON.parse(val)}catch(e){st.innerHTML='<span style="color:var(--red)">❌ JSON غير صالح: '+e.message+'</span>';return}
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';
  const r=await api('/api/config',JSON.parse(val));
  if(r.ok){st.innerHTML='<span style="color:var(--green)">✅ تم الحفظ</span>';showToast('✅ تم حفظ الإعدادات','success')}
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}
function formatJson(){
  try{
    const v=document.getElementById('rawConfig').value;
    document.getElementById('rawConfig').value=JSON.stringify(JSON.parse(v),null,2);
    showToast('✅ تم التنسيق','success');
  }catch(e){showToast('❌ JSON غير صالح: '+e.message,'error')}
}
</script>`;
    res.send(layout('الإعدادات', body, 'config', pageOpts()));
  });

  // ─── ACCOUNTS ───────────────────────────────────────────────────────────────
  // Accounts tab merged into tier-settings — redirect old URL
  app.get('/accounts', auth, (req,res) => res.redirect('/tier-settings'));

  // ─── TIER SETTINGS ───────────────────────────────────────────────────────────
  app.get('/tier-settings', auth, (req,res) => {
    const cfg = readSettings();
    const activeTierNum = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'active-tier.json'),'utf-8')).tier || 1; } catch(_) { return 1; }
    })();
    const tierLimit = Number(cfg.tierLimit) || 3;
    const tierModes = cfg.tierModes || {};
    const totalRestarts = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'restart-stats.json'),'utf-8')).total || 0; } catch(_) { return 0; }
    })();
    const firstStartTs = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'first-start.json'),'utf-8')).ts || STARTED_AT; } catch(_) { return STARTED_AT; }
    })();
    const restartHistory = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'restart-history.json'),'utf-8')); } catch(_) { return []; }
    })();
    const sessionHistory = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'session-history.json'),'utf-8')); } catch(_) { return []; }
    })();
    const bot2Running = getBotChild2() !== null;
    function fileOk(fn) {
      try {
        if (!fs.existsSync(path.join(ROOT,fn))) return '🔴 غير موجود';
        const d = JSON.parse(fs.readFileSync(path.join(ROOT,fn),'utf-8'));
        return Array.isArray(d) && d.length > 0 ? `🟢 ${d.length} كوكي` : '🟡 فارغ';
      } catch(_) { return '🔴 خطأ'; }
    }
    const tierRows = TIER_FILES.map(t => {
      const isActive = activeTierNum === t.tier;
      const inRange  = t.tier <= tierLimit;
      const tMode    = tierModes[String(t.tier)] || (t.tier === 1 ? 'active' : 'standby');
      const modeLabel = tMode === 'active'
        ? '<span class="badge badge-green">نشط (تشغيل)</span>'
        : tMode === 'standby'
          ? '<span class="badge" style="background:rgba(255,193,7,.18);color:#ffc107">احتياطي</span>'
          : '<span class="badge" style="background:rgba(255,255,255,.08);color:var(--text3)">معطّل</span>';
      const modeActions = t.tier === 1 ? '' : `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <button class="btn btn-sm ${tMode==='active'?'btn-primary':'btn-outline'}" onclick="setTierMode(${t.tier},'active')" title="تشغيل هذا التير بالتوازي مع Tier 1">▶ تشغيل</button>
          <button class="btn btn-sm ${tMode==='standby'?'btn-primary':'btn-outline'}" onclick="setTierMode(${t.tier},'standby')" title="احتياطي فقط — يُستخدم إذا فشل Tier 1">⏸ احتياطي</button>
          <button class="btn btn-sm ${tMode==='disabled'?'btn-primary':'btn-outline'}" onclick="setTierMode(${t.tier},'disabled')" title="لا يُستخدم">✕ معطّل</button>
        </div>`;
      return `<tr style="${isActive ? 'background:rgba(0,212,255,.06)' : ''}">
        <td><strong>Tier ${t.tier}</strong>${isActive ? ' <span class="badge badge-green">البوت الرئيسي</span>' : ''}${!inRange ? ' <span class="badge" style="background:rgba(255,255,255,.1);color:var(--text3)">خارج النطاق</span>' : ''}</td>
        <td>${fileOk(t.stateFile)}</td>
        <td><code style="font-size:.75rem">${t.stateFile}</code></td>
        <td>
          ${modeLabel}
          ${modeActions}
        </td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          ${!isActive && inRange ? `<button class="btn btn-outline btn-sm" onclick="switchTier(${t.tier})">🔄 تبديل إليه</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    function msToHuman(ms) {
      if (!ms) return '—';
      const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
      if(d>0) return `${d}ي ${h%24}س`;
      if(h>0) return `${h}س ${m%60}د`;
      if(m>0) return `${m}د`;
      return `${s}ث`;
    }
    const historyRows = Array.isArray(sessionHistory) && sessionHistory.length > 0
      ? sessionHistory.slice().reverse().map((s, i) => {
          const num      = sessionHistory.length - i;
          const start    = new Date(s.startTs).toLocaleString('ar-SA');
          const duration = s.uptimeMs != null
            ? msToHuman(s.uptimeMs)
            : `<span style="color:#4dff91;font-weight:600">🟢 جارية</span>`;
          const code = s.exitCode != null ? `كود ${s.exitCode}` : `—`;
          return `<tr>
            <td style="color:var(--text3)">جلسة ${num}</td>
            <td>${start}</td>
            <td>${duration}</td>
            <td>${code}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--text3)">لا توجد جلسات مسجلة بعد — تبدأ التسجيل تلقائياً عند إعادة التشغيل</td></tr>';

    const body = `
<div class="page-header">
  <div class="page-title">⚙️ إعدادات التيرات</div>
  <div class="page-sub">إدارة حسابات Facebook والتيرات المتعددة</div>
</div>

<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">🔄</div><div class="stat-val">${totalRestarts}</div><div class="stat-lbl">إجمالي عمليات التشغيل</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">📌</div><div class="stat-val">Tier ${activeTierNum}</div><div class="stat-lbl">التير الرئيسي</div></div>
  <div class="stat ${bot2Running ? 'stat-green' : 'stat-cyan'}"><div class="stat-glow"></div><div class="stat-icon">${bot2Running ? '🟢' : '⚫'}</div><div class="stat-val">${bot2Running ? 'يعمل' : 'متوقف'}</div><div class="stat-lbl">بوت Tier 2</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">⚙️</div><div class="stat-val">${tierLimit} / 5</div><div class="stat-lbl">التيرات المُفعَّلة</div></div>
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">⏱️</div><div class="stat-val" id="ts-uptime">${getUptime(firstStartTs)}</div><div class="stat-lbl">وقت التشغيل الكلي</div></div>
</div>

<div class="card" style="margin-bottom:16px">
  <div class="card-header"><div class="card-title">📋 حالة كل التيرات</div></div>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>التير</th><th>حالة الكوكيز</th><th>ملف الحالة</th><th>وضع التشغيل</th><th>إجراء</th></tr></thead>
      <tbody>${tierRows}</tbody>
    </table>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <div class="card-header"><div class="card-title">🔢 عدد التيرات النشطة (tierLimit)</div></div>
  <div style="padding:16px">
    <p style="color:var(--text2);font-size:.88rem;margin-bottom:14px">حدد عدد الحسابات التي يمكن للبوت التبديل بينها عند فشل الاتصال. Tier 1 هو الرئيسي، والباقي احتياطي.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      ${[1,2,3,4,5].map(n => `<button class="btn ${tierLimit===n?'btn-primary':'btn-outline'}" onclick="setTierLimit(${n})">${n} ${n===1?'(1 حساب)':n===2?'(2 حسابات)':n===3?'(3 حسابات)':n===4?'(4 حسابات)':'(5 حسابات)'}</button>`).join('')}
    </div>
    <div id="tl-status" style="margin-top:12px;font-size:.83rem;min-height:20px"></div>
    <p style="color:var(--text3);font-size:.78rem;margin-top:10px">💡 لإضافة حساب جديد: ارفع ملف كوكيز إلى ZAO-STATE4.json أو ZAO-STATE5.json من قسم "إدارة AppState" أدناه، ثم اضبط tierLimit لتشمله.</p>
  </div>
</div>

<!-- ── Accounts Management (merged from old Accounts tab) ──────────── -->
<div class="card" style="margin-bottom:16px">
  <div class="card-header">
    <div class="card-title">🔑 إدارة AppState (الكوكيز)</div>
    <div style="font-size:.78rem;color:var(--text3)">Tier ${activeTierNum} نشط حالياً</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;padding:4px 0">
    ${TIER_FILES.map(t => {
      const isActive = activeTierNum === t.tier;
      const stOk = fileOk(t.stateFile);
      const altOk = fileOk(t.altFile);
      return `<div style="background:var(--bg3);border-radius:10px;padding:14px;border:1px solid ${isActive?'rgba(0,212,255,.3)':'var(--border)'};display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <strong>Tier ${t.tier}</strong>
          ${isActive ? '<span class="badge badge-green">✅ نشط</span>' : ''}
        </div>
        <div style="font-size:.78rem;color:var(--text3);display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;justify-content:space-between"><span>${t.stateFile}</span><span>${stOk}</span></div>
          <div style="display:flex;justify-content:space-between"><span>${t.altFile} (احتياطي)</span><span>${altOk}</span></div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          <button class="btn btn-primary btn-sm" onclick="acctView(${t.tier},'${t.stateFile}')">👁 عرض</button>
          <button class="btn btn-success btn-sm" onclick="acctPaste(${t.tier},'${t.stateFile}')">📋 لصق</button>
          <button class="btn btn-outline btn-sm" onclick="acctBackup(${t.tier},'${t.stateFile}','${t.altFile}')">💾 نسخ احتياطي</button>
          ${!isActive ? `<button class="btn btn-outline btn-sm" onclick="switchTier(${t.tier})">🔄 تفعيل</button>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>
</div>

<!-- AppState Modal -->
<div id="acctModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.85);backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(700px,95vw);max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <div style="font-weight:700" id="acctModalTitle">AppState</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success btn-sm" onclick="acctSave()">💾 حفظ</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('acctModal').style.display='none'">✕</button>
      </div>
    </div>
    <textarea id="acctStateArea" style="flex:1;background:#03040d;color:#cdd6f4;font-family:monospace;font-size:.76rem;padding:16px;border:none;outline:none;resize:none;min-height:300px" placeholder="AppState JSON..."></textarea>
    <div id="acctSaveStatus" style="padding:6px 16px;font-size:.8rem;min-height:26px"></div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <div class="card-header"><div class="card-title">📊 سجل الجلسات (آخر 10)</div></div>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>الجلسة</th><th>بدأت</th><th>المدة</th><th>كود الخروج</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
  </div>
</div>

<script>
async function switchTier(n) {
  if (!confirm('تأكيد: تبديل إلى Tier ' + n + '؟ سيتم إعادة تشغيل البوت.')) return;
  const r = await api('/api/accounts/switch', { tier: n });
  if (r.ok) { showToast('تم التبديل إلى Tier ' + n + ' — سيعيد البوت التشغيل', 'success'); setTimeout(() => location.reload(), 3000); }
  else showToast(r.error || 'فشل التبديل', 'error');
}
async function setTierMode(tier, mode) {
  const modeNames = { active: 'تشغيل متزامن', standby: 'احتياطي', disabled: 'معطّل' };
  const r = await api('/api/tier-mode', { tier, mode });
  if (r.ok) {
    showToast('Tier ' + tier + ': تم ضبطه على "' + (modeNames[mode] || mode) + '"', 'success');
    setTimeout(() => location.reload(), 1200);
  } else {
    showToast(r.error || 'فشل ضبط الوضع', 'error');
  }
}
async function setTierLimit(n) {
  const r = await api('/api/tier-limit', { limit: n });
  if (r.ok) { showToast('تم ضبط tierLimit = ' + n, 'success'); setTimeout(() => location.reload(), 1000); }
  else showToast(r.error || 'فشل', 'error');
}
setInterval(() => {
  const el = document.getElementById('ts-uptime');
  if (!el) return;
  const start = ${firstStartTs};
  const diff = Date.now() - start;
  const s=Math.floor(diff/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
  el.textContent = d>0?d+'ي '+( h%24)+'س ':h>0?h+'س '+(m%60)+'د ':m>0?m+'د '+(s%60)+'ث ':s+'ث';
}, 1000);
// ── Accounts management functions ───────────────────────────────────────────
let _acctFile='';
async function acctView(tier,file){
  _acctFile=file;
  document.getElementById('acctModalTitle').textContent='👁 Tier '+tier+' — '+file;
  document.getElementById('acctStateArea').value='⏳ جارٍ التحميل...';
  document.getElementById('acctModal').style.display='flex';
  const r=await fetch('/api/accounts/state?file='+encodeURIComponent(file));
  const d=await r.json();
  document.getElementById('acctStateArea').value=d.content||d.error||'';
}
function acctPaste(tier,file){
  _acctFile=file;
  document.getElementById('acctModalTitle').textContent='📋 Tier '+tier+' — لصق AppState جديد';
  document.getElementById('acctStateArea').value='';
  document.getElementById('acctModal').style.display='flex';
  document.getElementById('acctStateArea').focus();
}
async function acctSave(){
  const content=document.getElementById('acctStateArea').value.trim();
  const st=document.getElementById('acctSaveStatus');
  if(!content)return showToast('لصق AppState أولاً','error');
  let parsed;
  try{parsed=JSON.parse(content)}catch(e){return showToast('❌ JSON غير صالح: '+e.message,'error')}
  if(!Array.isArray(parsed)||!parsed.length)return showToast('❌ AppState يجب أن يكون مصفوفة غير فارغة','error');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';
  const r=await api('/api/accounts/state',{file:_acctFile,content});
  if(r.ok){st.innerHTML='<span style="color:var(--green)">✅ تم الحفظ</span>';showToast('✅ تم حفظ AppState','success')}
  else{st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>'}
}
async function acctBackup(tier,stateFile,altFile){
  const r=await api('/api/accounts/backup',{stateFile,altFile});
  if(r.ok)showToast('✅ تم النسخ الاحتياطي لـ Tier '+tier,'success');
  else showToast('❌ '+(r.error||'فشل'),'error');
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.getElementById('acctModal').style.display='none'});
</script>`;
    res.send(layout('إعدادات التيرات', body, 'tier-settings', pageOpts()));
  });

  app.post('/api/tier-limit', auth, (req,res) => {
    const n = parseInt(req.body.limit);
    if (!Number.isFinite(n) || n < 1 || n > 5) return res.json({ error: 'قيمة غير صالحة (1-5)' });
    try {
      const cfg = readSettings();
      cfg.tierLimit = n;
      saveSettings(cfg);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/tier-mode', auth, (req,res) => {
    const { tier, mode } = req.body;
    const validModes = ['active', 'standby', 'disabled'];
    const tierNum = parseInt(tier, 10);
    if (!Number.isFinite(tierNum) || tierNum < 1 || tierNum > 5) return res.json({ error: 'رقم تير غير صالح' });
    if (!validModes.includes(mode)) return res.json({ error: 'وضع غير صالح' });
    if (tierNum === 1) return res.json({ error: 'لا يمكن تغيير وضع Tier 1 (دائماً رئيسي)' });
    try {
      const cfg = readSettings();
      if (!cfg.tierModes) cfg.tierModes = {};
      cfg.tierModes[String(tierNum)] = mode;
      saveSettings(cfg);
      // Apply change immediately — start or stop the secondary bot
      if (tierNum === 2) {
        if (mode === 'active') startBot2Fn();
        else stopBot2Fn();
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── GROUPS ─────────────────────────────────────────────────────────────────
  app.get('/groups', auth, async (req,res) => {
    const body = `
<style>
/* ── Messenger Layout ─────────────────────────────────────────────────────── */
.msng-wrap{display:flex;height:calc(100vh - var(--topbar-h) - 56px);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:var(--bg2);min-height:400px;position:relative}
.msng-sidebar{width:300px;min-width:220px;flex-shrink:0;border-left:1px solid var(--border);display:flex;flex-direction:column;background:var(--bg2);transition:all .2s}
.msng-sidebar-head{padding:12px 14px 10px;border-bottom:1px solid var(--border);flex-shrink:0}
.msng-group-list{flex:1;overflow-y:auto;padding:4px 0}
.msng-group-item{padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.03);display:flex;align-items:center;gap:10px;transition:background .13s;position:relative}
.msng-group-item:hover{background:var(--bg3)}
.msng-group-item.active{background:rgba(255,60,95,.07);border-right:3px solid var(--accent)}
.msng-grp-ava{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#ff3c5f,#60d0ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.9rem;color:white;flex-shrink:0}
.msng-grp-info{flex:1;min-width:0}
.msng-grp-name{font-weight:600;font-size:.84rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msng-grp-meta{font-size:.7rem;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msng-unread-badge{background:var(--accent);color:#fff;font-size:.6rem;font-weight:800;padding:1px 5px;border-radius:8px;min-width:14px;text-align:center}
/* Chat panel */
.msng-chat{flex:1;display:flex;flex-direction:column;min-width:0;position:relative;background:var(--bg)}
.msng-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text3);text-align:center;padding:32px}
.msng-chat-inner{display:none;flex-direction:column;height:100%}
.msng-chat-header{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0;background:var(--bg2)}
.msng-back-btn{background:none;border:none;cursor:pointer;color:var(--text3);font-size:1.2rem;padding:4px 8px;border-radius:6px;display:none;line-height:1}
.msng-chat-name{font-weight:700;font-size:.93rem}
.msng-chat-sub{font-size:.72rem;color:var(--text3);margin-top:1px}
.msng-chat-actions{margin-right:auto;display:flex;gap:5px;align-items:center}
/* Messages */
.msng-messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.msng-messages.drag-over{background:rgba(255,60,95,.04);outline:2px dashed var(--accent);outline-offset:-4px}
.msng-bubble-wrap{display:flex;gap:8px;align-items:flex-end;max-width:88%}
.msng-bubble-wrap.mine{align-self:flex-end;flex-direction:row-reverse}
.msng-avatar-sm{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--purple),var(--accent));display:flex;align-items:center;justify-content:center;font-size:.63rem;font-weight:700;color:white;flex-shrink:0;cursor:pointer;user-select:none;transition:opacity .15s}
.msng-avatar-sm:hover{opacity:.8}
.msng-bubble{background:var(--bg3);border-radius:16px 16px 16px 4px;padding:8px 12px;font-size:.82rem;line-height:1.48;max-width:100%;word-break:break-word}
.msng-bubble.mine{background:rgba(255,60,95,.18);border-radius:16px 16px 4px 16px}
.msng-bubble-name{font-size:.68rem;color:var(--text3);margin-bottom:3px;cursor:pointer;transition:color .15s}
.msng-bubble-name:hover{color:var(--accent2)}
.msng-bubble-time{font-size:.63rem;color:var(--text3);margin-top:3px}
.msng-bubble-wrap.mine .msng-bubble-time{text-align:right}
.msng-reply-preview{background:rgba(255,255,255,.06);border-right:3px solid var(--accent);border-radius:6px;padding:4px 8px;font-size:.72rem;color:var(--text3);margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
/* Reply bar */
.msng-reply-bar{padding:7px 14px;background:rgba(255,60,95,.05);border-top:1px solid rgba(255,60,95,.15);display:flex;align-items:center;gap:10px;flex-shrink:0;font-size:.78rem}
.msng-reply-bar-text{flex:1;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Input area */
.msng-input-area{padding:9px 12px;border-top:1px solid var(--border);flex-shrink:0;background:var(--bg2)}
.msng-text-input{flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:8px 12px;font-size:.83rem;font-family:'Cairo',sans-serif;outline:none;transition:border .2s;min-width:0}
.msng-text-input:focus{border-color:rgba(255,60,95,.4)}
.msng-icon-btn{width:34px;height:34px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);cursor:pointer;color:var(--text2);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0;transition:all .15s;padding:0;line-height:1}
.msng-icon-btn:hover{background:var(--bg2);border-color:var(--accent)}
.msng-icon-btn.active-silent{background:rgba(255,60,95,.2);border-color:var(--accent)}
.msng-icon-btn.recording{background:rgba(255,60,95,.2);border-color:var(--accent);animation:rec-pulse 1s infinite}
@keyframes rec-pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* Context Menu */
.msng-ctx-menu{position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-md);box-shadow:0 8px 32px rgba(0,0,0,.55);min-width:168px;overflow:hidden;animation:ctx-in .1s ease}
@keyframes ctx-in{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
.msng-ctx-item{padding:10px 14px;cursor:pointer;font-size:.82rem;display:flex;align-items:center;gap:8px;transition:background .12s;white-space:nowrap}
.msng-ctx-item:hover{background:var(--bg3)}
.msng-ctx-sep{height:1px;background:var(--border);margin:2px 0}
.msng-ctx-react{display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap}
.msng-ctx-react span{font-size:1.2rem;cursor:pointer;border-radius:6px;padding:3px 6px;transition:background .12s}
.msng-ctx-react span:hover{background:var(--bg3)}
/* Modals */
.msng-modal-overlay{display:none;position:fixed;inset:0;z-index:9800;background:rgba(0,0,0,.85);backdrop-filter:blur(8px);align-items:center;justify-content:center}
.msng-modal-box{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);display:flex;flex-direction:column;overflow:hidden;max-height:90vh;position:relative}
.msng-modal-head{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.msng-modal-title{font-weight:700;font-size:.93rem}
.msng-modal-close{background:none;border:none;cursor:pointer;color:var(--text3);font-size:1.1rem;line-height:1;padding:2px 6px;border-radius:4px;transition:color .15s}
.msng-modal-close:hover{color:var(--text)}
.msng-member-row{padding:10px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .13s}
.msng-member-row:hover{background:var(--bg3)}
@media(max-width:640px){
  .msng-sidebar{position:absolute;width:100%;z-index:10;height:100%}
  .msng-sidebar.hidden{display:none}
  .msng-back-btn{display:block!important}
}
</style>

<div class="page-header" style="margin-bottom:10px">
  <div class="page-title">💬 الغروبات — مسنجر</div>
  <div class="page-sub">اضغط مطولاً على رسالة لخيارات · اسحب وأسقط الملفات لإرسالها · الرسائل الخضراء = رسائل البوت</div>
</div>

<div class="msng-wrap" id="msngWrap">

  <!-- Sidebar -->
  <div class="msng-sidebar" id="msngSidebar">
    <div class="msng-sidebar-head">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">
        <span style="font-weight:700;font-size:.87rem">الغروبات</span>
        <span id="msngGrpCount" class="badge badge-blue" style="margin-right:auto">0</span>
        <button class="msng-icon-btn" id="msngReqBtn" title="طلبات المراسلة" style="width:30px;height:30px;font-size:.83rem;position:relative">📩<span id="msngReqBadge" style="display:none;position:absolute;top:-3px;right:-3px;background:var(--accent);color:#fff;font-size:.55rem;font-weight:800;padding:1px 4px;border-radius:8px;min-width:13px;text-align:center;line-height:1.4"></span></button>
        <button class="msng-icon-btn" id="msngTreeBtn" title="شجرة الغروبات" style="width:30px;height:30px;font-size:.83rem">🌳</button>
        <button class="msng-icon-btn" id="msngRefreshBtn" title="تحديث" style="width:30px;height:30px;font-size:.83rem">🔄</button>
      </div>
      <input type="text" id="msngSearch" placeholder="🔍 بحث في الغروبات..."
        style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 10px;font-size:.79rem;font-family:'Cairo',sans-serif;outline:none;box-sizing:border-box;transition:border .2s"/>
    </div>
    <div class="msng-group-list" id="msngGroupList">
      <div style="text-align:center;padding:32px;color:var(--text3);font-size:.83rem">⏳ جارٍ التحميل...</div>
    </div>
  </div>

  <!-- Chat Panel -->
  <div class="msng-chat" id="msngChat">

    <!-- Placeholder -->
    <div class="msng-placeholder" id="msngPlaceholder">
      <div style="font-size:3.5rem;margin-bottom:14px;opacity:.3">💬</div>
      <div style="font-weight:700;font-size:1rem;margin-bottom:6px">اختر غروباً للبدء</div>
      <div style="font-size:.82rem;opacity:.7">انقر على أي غروب من القائمة لعرض رسائله والتفاعل معه</div>
    </div>

    <!-- Chat Inner -->
    <div class="msng-chat-inner" id="msngChatInner">

      <!-- Header -->
      <div class="msng-chat-header">
        <button class="msng-back-btn" id="msngBackBtn" title="رجوع">←</button>
        <div class="msng-grp-ava" id="msngChatAva" style="width:36px;height:36px;font-size:.8rem">G</div>
        <div style="flex:1;min-width:0">
          <div class="msng-chat-name" id="msngChatName">—</div>
          <div class="msng-chat-sub" id="msngChatSub">—</div>
        </div>
        <div class="msng-chat-actions">
          <button class="msng-icon-btn" id="msngSilentBtn" title="الصامت: موقف" style="font-size:.85rem">🔔</button>
          <button class="msng-icon-btn" id="msngStatusBtn" title="حالة الغروب وتفعيل الأوامر" style="font-size:.85rem">⚙️</button>
          <button class="msng-icon-btn" id="msngMembersBtn" title="الأعضاء" style="font-size:.85rem">👥</button>
          <button class="msng-icon-btn" id="msngRenameBtn" title="تغيير اسم الغروب" style="font-size:.85rem">✏️</button>
          <button class="msng-icon-btn" id="msngReloadBtn" title="تحديث الرسائل" style="font-size:.85rem">🔄</button>
        </div>
      </div>

      <!-- Reply Bar -->
      <div class="msng-reply-bar" id="msngReplyBar" style="display:none">
        <span style="color:var(--accent);font-size:.9rem;flex-shrink:0">↩</span>
        <span class="msng-reply-bar-text" id="msngReplyText"></span>
        <button id="msngCancelReply" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:1rem;padding:0 2px;line-height:1;flex-shrink:0">✕</button>
      </div>

      <!-- Messages -->
      <div class="msng-messages" id="msngMessages">
        <div style="text-align:center;padding:32px;color:var(--text3)">اختر غروباً...</div>
      </div>

      <!-- Context Menu -->
      <div class="msng-ctx-menu" id="msngCtxMenu" style="display:none">
        <div class="msng-ctx-react" id="msngCtxReact">
          <span data-emoji="👍">👍</span>
          <span data-emoji="❤️">❤️</span>
          <span data-emoji="😂">😂</span>
          <span data-emoji="😮">😮</span>
          <span data-emoji="😢">😢</span>
          <span data-emoji="😡">😡</span>
        </div>
        <div class="msng-ctx-sep"></div>
        <div class="msng-ctx-item" id="ctxReplyBtn"><span>↩</span> رد على الرسالة</div>
        <div class="msng-ctx-item" id="ctxCopyBtn"><span>📋</span> نسخ النص</div>
        <div class="msng-ctx-sep"></div>
        <div class="msng-ctx-item" id="ctxReportBtn" style="color:var(--red)"><span>🚩</span> تبليغ</div>
      </div>

      <!-- Input Area -->
      <div class="msng-input-area" style="position:relative">
        <!-- Slash Menu Popup -->
        <div id="slashMenu" style="display:none;position:absolute;bottom:100%;left:12px;right:12px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 -4px 20px rgba(0,0,0,.4);overflow:hidden;z-index:500;margin-bottom:4px">
          <div style="padding:7px 12px;font-size:.73rem;color:var(--text3);border-bottom:1px solid var(--border)">خيارات سريعة — اختر أو اضغط Esc للإغلاق</div>
          <div id="slashMenuItems"></div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
          <button class="msng-icon-btn" id="msngAttachImgBtn" title="صورة / فيديو" style="font-size:.88rem">🖼️</button>
          <button class="msng-icon-btn" id="msngAttachAudioBtn" title="ملف صوتي" style="font-size:.88rem">🎵</button>
          <button class="msng-icon-btn" id="msngRecBtn" title="تسجيل صوتي" style="font-size:.88rem">🎙️</button>
          <input type="text" id="msngMsgInput" class="msng-text-input" placeholder="💬 اكتب رسالة... (/ للخيارات السريعة)" style="flex:1"/>
          <button class="btn btn-primary btn-sm" id="msngSendBtn" style="flex-shrink:0;padding:7px 12px">📤</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:.74rem;color:var(--text3);flex-shrink:0;white-space:nowrap">⚡ أمر:</span>
          <input type="text" id="msngCmdInput" class="msng-text-input" placeholder="ping · help · nm اسم · ai سؤال · motor1 on/off · motor2 on/off · nm قفل" style="flex:1"/>
          <button class="btn btn-outline btn-sm" id="msngExecBtn" style="flex-shrink:0;padding:7px 10px;color:var(--accent)" title="تنفيذ الأمر في الغروب المختار">▶️</button>
        </div>
        <div id="msngActionSt" style="font-size:.73rem;min-height:13px;margin-top:5px;color:var(--text3)"></div>
        <input type="file" id="msngFileInp" style="display:none" multiple/>
      </div>
    </div>
  </div>
</div>

<!-- Members Modal -->
<div class="msng-modal-overlay" id="membersModal">
  <div class="msng-modal-box" style="width:min(500px,95vw)">
    <div class="msng-modal-head">
      <div class="msng-modal-title" id="memberModalTitle">👥 الأعضاء</div>
      <button class="msng-modal-close" id="closeMembersBtn">✕</button>
    </div>
    <div style="padding:8px 14px;border-bottom:1px solid var(--border);flex-shrink:0">
      <input id="memberSearch" placeholder="🔍 بحث باسم أو ID..."
        style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 10px;font-size:.8rem;font-family:'Cairo',sans-serif;outline:none;box-sizing:border-box"/>
    </div>
    <div id="membersList" style="overflow-y:auto;max-height:60vh;padding:4px 0"></div>
  </div>
</div>

<!-- Profile Modal -->
<div class="msng-modal-overlay" id="profileModal">
  <div class="msng-modal-box" style="width:min(330px,92vw);padding:22px;align-items:center;gap:12px">
    <button id="closeProfileBtn" style="position:absolute;top:10px;left:10px;background:none;border:none;cursor:pointer;color:var(--text3);font-size:1.1rem">✕</button>
    <div id="profileAva" style="width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.7rem;font-weight:700;color:white;border:3px solid rgba(255,255,255,.08)">?</div>
    <div id="profileName" style="font-size:1rem;font-weight:700;text-align:center">—</div>
    <div id="profileAdminBadge" style="display:none"><span class="badge badge-yellow">👑 مشرف</span></div>
    <div style="width:100%;display:flex;flex-direction:column;gap:7px">
      <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--bg3);border-radius:8px;align-items:center">
        <span style="color:var(--text3);font-size:.78rem">الـ UID</span>
        <code id="profileUID" style="font-size:.78rem;color:var(--accent2);cursor:pointer">—</code>
      </div>
      <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--bg3);border-radius:8px;align-items:center">
        <span style="color:var(--text3);font-size:.78rem">الملف الشخصي</span>
        <a id="profileLink" href="#" target="_blank" rel="noopener" style="font-size:.78rem;color:var(--purple)">🔗 رابط</a>
      </div>
    </div>
    <div style="display:flex;gap:7px;width:100%;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" id="profileSendBtn" style="flex:1">💬 رسالة</button>
      <button class="btn btn-outline btn-sm" id="profileNickBtn" style="flex:1">🏷️ كنية</button>
      <button class="btn btn-outline btn-sm" id="profileKickBtn" style="flex:1;color:var(--red)">🚫 كيك</button>
    </div>
    <div id="profileActSt" style="font-size:.74rem;min-height:14px;color:var(--text3);text-align:center;width:100%"></div>
  </div>
</div>

<!-- Nickname Modal -->
<div class="msng-modal-overlay" id="nicknameModal">
  <div class="msng-modal-box" style="width:min(360px,90vw);padding:22px;gap:12px">
    <div style="font-weight:700;margin-bottom:4px">🏷️ تغيير كنية العضو</div>
    <div style="font-size:.8rem;color:var(--text3)" id="nicknameForName"></div>
    <input type="text" id="nicknameInput" class="form-control" placeholder="الكنية الجديدة (اتركها فارغة للإزالة)..."/>
    <div class="btn-row">
      <button class="btn btn-primary" id="doNicknameBtn">✅ تطبيق</button>
      <button class="btn btn-outline" id="cancelNicknameBtn">إلغاء</button>
    </div>
    <div id="nicknameSt" style="font-size:.8rem;min-height:14px;color:var(--text3)"></div>
  </div>
</div>

<!-- Change Name Modal -->
<div class="msng-modal-overlay" id="changeNameModal">
  <div class="msng-modal-box" style="width:min(380px,90vw);padding:22px;gap:12px">
    <div style="font-weight:700;margin-bottom:4px">✏️ تغيير اسم الغروب</div>
    <div style="font-size:.8rem;color:var(--text3)" id="changeNameCurrent"></div>
    <input type="text" id="newGroupName" class="form-control" placeholder="الاسم الجديد..."/>
    <div class="btn-row">
      <button class="btn btn-primary" id="doChangeNameBtn">✅ تغيير</button>
      <button class="btn btn-outline" id="cancelChangeNameBtn">إلغاء</button>
    </div>
    <div id="changeNameSt" style="font-size:.8rem;min-height:14px;color:var(--text3)"></div>
  </div>
</div>

<!-- Group Tree Modal -->
<div class="msng-modal-overlay" id="groupTreeModal">
  <div class="msng-modal-box" style="width:min(680px,96vw);max-height:88vh;display:flex;flex-direction:column">
    <div class="msng-modal-head">
      <div class="msng-modal-title">🌳 شجرة الغروبات</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="treeSearch" placeholder="🔍 بحث..." style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 10px;font-size:.8rem;font-family:'Cairo',sans-serif;outline:none;width:160px"/>
        <button class="msng-modal-close" id="closeTreeBtn">✕</button>
      </div>
    </div>
    <div style="padding:6px 14px;border-bottom:1px solid var(--border);font-size:.78rem;color:var(--text3)" id="treeSummary">جارٍ التحميل...</div>
    <div id="treeList" style="overflow-y:auto;flex:1;padding:8px 4px"></div>
  </div>
</div>

<!-- Message Requests Modal -->
<div class="msng-modal-overlay" id="msgReqModal2">
  <div class="msng-modal-box" style="width:min(560px,96vw);max-height:88vh;display:flex;flex-direction:column">
    <div class="msng-modal-head">
      <div class="msng-modal-title">📩 طلبات المراسلة</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-outline btn-sm" id="msngReqRefreshBtn" style="font-size:.78rem;padding:4px 10px">🔄 تحديث</button>
        <button class="msng-modal-close" id="closeMsgReq2Btn">✕</button>
      </div>
    </div>
    <div style="padding:8px 16px;border-bottom:1px solid var(--border);font-size:.8rem;color:var(--text3)" id="msgReq2Status">⏳ جارٍ التحميل...</div>
    <div id="msgReq2List" style="overflow-y:auto;flex:1;padding:10px 16px;display:flex;flex-direction:column;gap:8px"></div>
  </div>
</div>

<!-- Group Status / Command Activation Modal -->
<div class="msng-modal-overlay" id="groupStatusModal">
  <div class="msng-modal-box" style="width:min(560px,96vw);max-height:90vh;display:flex;flex-direction:column">
    <div class="msng-modal-head">
      <div class="msng-modal-title" id="statusModalTitle">⚙️ حالة الغروب</div>
      <button class="msng-modal-close" id="closeStatusBtn">✕</button>
    </div>
    <div style="overflow-y:auto;flex:1;padding:14px;display:flex;flex-direction:column;gap:12px">
      <div id="statusModalBanner" style="font-size:.8rem;min-height:14px;color:var(--text3)"></div>

      <!-- Quick Status Badges -->
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="statusBadgesRow"></div>

      <!-- NM Section -->
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-weight:600;margin-bottom:8px;font-size:.88rem">🔒 NM — قفل اسم الغروب <span id="st_nmBadge" class="badge badge-red" style="font-size:.7rem">غير مفعل</span></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="st_nmName" class="form-control" placeholder="الاسم المراد قفله..." style="flex:1;min-width:140px;font-size:.83rem;padding:6px 10px"/>
          <input id="st_nmTime" type="number" class="form-control" value="6" min="1" placeholder="ث" style="width:70px;font-size:.83rem;padding:6px 8px" title="وقت إعادة التطبيق (ثانية)"/>
          <button class="btn btn-primary btn-sm" onclick="_stNmAction('enable')">✅</button>
          <button class="btn btn-outline btn-sm" onclick="_stNmAction('disable')">🔓</button>
        </div>
        <div id="st_nmSt" style="font-size:.76rem;color:var(--text3);margin-top:5px;min-height:12px"></div>
      </div>

      <!-- Nicknames Section -->
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-weight:600;margin-bottom:8px;font-size:.88rem">👤 كنيات — قفل الألقاب <span id="st_nickBadge" class="badge badge-red" style="font-size:.7rem">غير مفعل</span></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="st_nickName" class="form-control" placeholder="الكنية..." style="flex:1;min-width:120px;font-size:.83rem;padding:6px 10px"/>
          <select id="st_nickScope" class="form-control" style="width:110px;font-size:.83rem;padding:6px 8px">
            <option value="all">👥 الجميع</option>
            <option value="bot">🤖 البوت فقط</option>
          </select>
          <button class="btn btn-primary btn-sm" onclick="_stNickAction('enable')">✅</button>
          <button class="btn btn-outline btn-sm" onclick="_stNickAction('disable')">🔓</button>
        </div>
        <div id="st_nickSt" style="font-size:.76rem;color:var(--text3);margin-top:5px;min-height:12px"></div>
      </div>

      <!-- Motor 1 -->
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-weight:600;margin-bottom:8px;font-size:.88rem">🔴 محرك 1 — إرسال دوري <span id="st_m1Badge" class="badge badge-red" style="font-size:.7rem">غير مفعل</span></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="st_m1Msg" class="form-control" placeholder="نص الرسالة التلقائية..." style="flex:1;min-width:160px;font-size:.83rem;padding:6px 10px"/>
          <input id="st_m1Time" type="number" class="form-control" value="30" min="5" placeholder="ث" style="width:70px;font-size:.83rem;padding:6px 8px"/>
          <button class="btn btn-primary btn-sm" onclick="_stM1Action('enable')">▶️</button>
          <button class="btn btn-outline btn-sm" onclick="_stM1Action('disable')">⏹</button>
          <button class="btn btn-outline btn-sm" onclick="_stM1Action('message')">💾</button>
        </div>
        <div id="st_m1St" style="font-size:.76rem;color:var(--text3);margin-top:5px;min-height:12px"></div>
      </div>

      <!-- Motor 2 -->
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-weight:600;margin-bottom:8px;font-size:.88rem">🟢 محرك 2 — إرسال ذكي <span id="st_m2Badge" class="badge badge-red" style="font-size:.7rem">غير مفعل</span></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="st_m2Msg" class="form-control" placeholder="نص الرسالة التلقائية..." style="flex:1;min-width:160px;font-size:.83rem;padding:6px 10px"/>
          <input id="st_m2Time" type="number" class="form-control" value="30" min="5" placeholder="ث" style="width:70px;font-size:.83rem;padding:6px 8px"/>
          <button class="btn btn-primary btn-sm" onclick="_stM2Action('enable')">▶️</button>
          <button class="btn btn-outline btn-sm" onclick="_stM2Action('disable')">⏹</button>
          <button class="btn btn-outline btn-sm" onclick="_stM2Action('message')">💾</button>
        </div>
        <div id="st_m2St" style="font-size:.76rem;color:var(--text3);margin-top:5px;min-height:12px"></div>
      </div>

      <!-- Command Activation -->
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-weight:600;margin-bottom:8px;font-size:.88rem">⚡ تفعيل أمر في هذا الغروب</div>
        <div style="font-size:.78rem;color:var(--text3);margin-bottom:8px">اكتب أمراً مباشرة وسيُرسل للغروب — البوت سيستجيب</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="st_cmdInput" class="form-control" placeholder="مثال: ping · help · ai مرحبا · nm اسم الغروب" style="flex:1;font-size:.83rem;padding:6px 10px"/>
          <button class="btn btn-primary btn-sm" onclick="_stExecCmd()">▶️ تنفيذ</button>
        </div>
        <div id="st_cmdSt" style="font-size:.76rem;color:var(--text3);margin-top:5px;min-height:12px"></div>
      </div>
    </div>
  </div>
</div>

<script>
/* ────────────────────────────────── State ─────────────────────────────────── */
var _allGroups=[], _selTID='', _allMembers=[], _curUID='', _curUName='';
var _botID='', _silentMode=false, _replyTo=null, _ctxMsg=null;
var _mediaRecorder=null, _audioChunks=[], _pollTimer=null, _lastMsgTS=0;
var _lpTimer=null;

/* ─────────────────────────────── Utilities ────────────────────────────────── */
function _h(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function _ini(n){return((String(n||'G').trim().split(/\\s+/)[0]||'G')[0]||'G').toUpperCase();}
function _grad(s){var h=['135deg,#ff3c5f,#60d0ff','135deg,#9b72f7,#60d0ff','135deg,#30d988,#43e97b','135deg,#f5c842,#ff6b6b'];var n=0;for(var i=0;i<String(s).length;i++)n+=String(s).charCodeAt(i);return h[n%h.length];}
function _fmt(ts){if(!ts)return'';var d=new Date(Number(ts)),now=new Date(),dif=(now-d)/1000;if(dif<60)return'الآن';if(dif<3600)return Math.floor(dif/60)+'د';if(dif<86400)return Math.floor(dif/3600)+'س';return d.toLocaleDateString('ar');}
function _fmtFull(ts){if(!ts)return'';return new Date(Number(ts)).toLocaleString('ar');}
function _st(html,id){document.getElementById(id||'msngActionSt').innerHTML=html;}
function _q(id){return document.getElementById(id);}

/* ──────────────────────────── Bot ID init ─────────────────────────────────── */
async function _initBotID(){
  try{var d=await fetch('/api/bot-id').then(function(r){return r.json();});_botID=String(d.botID||'');}catch(e){}
}

/* ─────────────────────── Slash Menu (/ commands) ──────────────────────────── */
var _slashItems=[
  {icon:'🔕',label:'صامت',desc:'إرسال بدون إشعار (صامت)',action:function(){
    _silentMode=true;
    var btn=_q('msngSilentBtn');if(btn){btn.textContent='🔕';btn.title='الصامت: مفعل';}
    _q('slashMenu').style.display='none';
    var inp=_q('msngMsgInput');inp.value=inp.value.replace(/^\\/\\S*\\s*/,'');inp.focus();
    showToast('🔕 الصامت مفعل لهذه الرسالة','info');
  }},
  {icon:'🔔',label:'عادي',desc:'إرسال عادي مع إشعار',action:function(){
    _silentMode=false;
    var btn=_q('msngSilentBtn');if(btn){btn.textContent='🔔';btn.title='الصامت: موقف';}
    _q('slashMenu').style.display='none';
    var inp=_q('msngMsgInput');inp.value=inp.value.replace(/^\\/\\S*\\s*/,'');inp.focus();
    showToast('🔔 الإرسال العادي مفعل','info');
  }},
  {icon:'🌳',label:'شجرة الغروبات',desc:'عرض جميع الغروبات مع حالتها',action:function(){
    _q('slashMenu').style.display='none';
    var inp=_q('msngMsgInput');inp.value='';
    _openGroupTree();
  }},
  {icon:'⚙️',label:'إعدادات الغروب',desc:'NM، كنيات، محركات، تفعيل أمر',action:function(){
    _q('slashMenu').style.display='none';
    var inp=_q('msngMsgInput');inp.value='';
    _openGroupStatus();
  }}
];

function _showSlashMenu(query){
  var q=(query||'').toLowerCase().replace(/^[/]/,'');
  var items=q?_slashItems.filter(function(i){return i.label.includes(q)||i.desc.includes(q);}):_slashItems;
  var container=_q('slashMenuItems');
  if(!items.length){_q('slashMenu').style.display='none';return;}
  container.innerHTML=items.map(function(item,i){
    return '<div class="_slashItem" data-idx="'+i+'" style="display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;transition:background .12s" '
      +'onmouseenter="this.style.background=\\'var(--bg3)\\'" onmouseleave="this.style.background=\\'none\\'">'
      +'<span style="font-size:1.1rem">'+item.icon+'</span>'
      +'<div><div style="font-size:.84rem;font-weight:600;color:var(--text)">'+_h(item.label)+'</div>'
      +'<div style="font-size:.73rem;color:var(--text3)">'+_h(item.desc)+'</div></div>'
      +'</div>';
  }).join('');
  container.querySelectorAll('._slashItem').forEach(function(el){
    el.addEventListener('click',function(){
      var idx=parseInt(el.dataset.idx);
      // re-filter to get same index
      var filteredItems=q?_slashItems.filter(function(i){return i.label.includes(q)||i.desc.includes(q);}):_slashItems;
      if(filteredItems[idx])filteredItems[idx].action();
    });
  });
  _q('slashMenu').style.display='block';
}

function _hideSlashMenu(){_q('slashMenu').style.display='none';}

/* ─────────────────────── Group Tree ───────────────────────────────────────── */
var _treeData=[];
var _treeStatusMap={};

async function _openGroupTree(){
  _q('groupTreeModal').style.display='flex';
  _q('treeSummary').textContent='⏳ جارٍ تحميل الغروبات...';
  _q('treeList').innerHTML='';
  var d=await fetch('/api/groups-list').then(function(r){return r.json();}).catch(function(){return{};});
  _treeData=d.groups||[];
  _q('treeSummary').textContent=_treeData.length+' غروب'+(d.cached?' (كاش — البوت قد يكون غير متصل)':'')+' — انقر لاختيار غروب أو فتح إعداداته';
  _renderTree(_treeData);
  _q('treeSearch').value='';
}

function _renderTree(groups){
  var list=_q('treeList');
  if(!groups.length){list.innerHTML='<div style="text-align:center;padding:32px;color:var(--text3);font-size:.83rem">لا توجد غروبات</div>';return;}
  list.innerHTML=groups.map(function(g){
    var isSel=g.threadID===_selTID;
    var lastT=g.lastTime?_fmt(g.lastTime):'';
    var unr=g.unread?'<span class="msng-unread-badge" style="margin-right:4px">'+g.unread+'</span>':'';
    return '<div class="_treeRow" data-tid="'+_h(g.threadID)+'" style="display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-radius:8px;margin:2px 4px;'+(isSel?'background:rgba(255,60,95,.1);border:1px solid rgba(255,60,95,.2)':'border:1px solid transparent')+'" '
      +'onmouseenter="if(!this.style.borderColor||this.style.borderColor===\\'transparent\\')this.style.background=\\'var(--bg3)\\'" onmouseleave="if(this.dataset.tid!==_selTID){this.style.background=\\'none\\';this.style.borderColor=\\'transparent\\';}">'
      +'<div class="msng-grp-ava" style="background:linear-gradient('+_grad(g.threadID)+');flex-shrink:0">'+_ini(g.name)+'</div>'
      +'<div style="flex:1;min-width:0">'
        +'<div style="display:flex;align-items:center;gap:6px;justify-content:space-between">'
          +'<div style="font-weight:600;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_h(g.name||'غير مسمى')+'</div>'
          +'<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">'+unr+'<span style="font-size:.65rem;color:var(--text3)">'+lastT+'</span></div>'
        +'</div>'
        +'<div style="font-size:.73rem;color:var(--text3);margin-top:2px"><code style="font-size:.7rem;opacity:.7">'+g.threadID+'</code>'+(g.memberCount?' · '+g.memberCount+' عضو':'')+'</div>'
      +'</div>'
      +'<button onclick="event.stopPropagation();_treeOpenSettings(this.dataset.tid)" data-tid="'+_h(g.threadID)+'" style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:.75rem;color:var(--text3);flex-shrink:0" title="إعدادات الغروب">⚙️</button>'
    +'</div>';
  }).join('');
  list.querySelectorAll('._treeRow').forEach(function(el){
    el.addEventListener('click',function(e){
      if(e.target.closest('button'))return;
      var tid=el.dataset.tid;
      var grp=_treeData.find(function(g){return g.threadID===tid;});
      if(grp){_q('groupTreeModal').style.display='none';_selectGroup(grp.threadID,grp.name,grp.memberCount);}
    });
  });
}

function _treeOpenSettings(tid){
  var grp=_allGroups.find(function(g){return g.threadID===tid;})||_treeData.find(function(g){return g.threadID===tid;});
  _q('groupTreeModal').style.display='none';
  _selTID=tid;
  if(grp){
    _q('msngChatName').textContent=grp.name||tid;
    _q('msngChatSub').textContent=grp.threadID;
  }
  _openGroupStatus();
}

/* ─────────────── Group Status / Command Activation Panel ──────────────────── */
async function _openGroupStatus(){
  if(!_selTID){showToast('اختر غروباً أولاً','warn');return;}
  _q('groupStatusModal').style.display='flex';
  _q('statusModalTitle').textContent='⚙️ '+(_q('msngChatName').textContent||_selTID);
  _q('statusModalBanner').innerHTML='<span style="color:var(--text3)">⏳ جارٍ جلب الحالة...</span>';
  _q('statusBadgesRow').innerHTML='';

  var r=await api('/api/hold/status',{threadID:_selTID});
  if(!r.ok&&!r.nm){
    _q('statusModalBanner').innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل جلب الحالة — تأكد من اتصال البوت')+'</span>';
    return;
  }
  _q('statusModalBanner').innerHTML='<span style="color:var(--green)">✅ تم تحميل حالة الغروب</span>';

  // Badges
  var badges=[];
  if(r.nm?.locked)badges.push('<span class="badge badge-green">🔒 NM مفعل</span>');
  if(r.nick?.locked)badges.push('<span class="badge badge-green">👤 كنيات مفعلة</span>');
  if(r.motor1?.status)badges.push('<span class="badge" style="background:rgba(255,60,60,.18);color:#ff6060;border:1px solid rgba(255,60,60,.3)">🔴 محرك1 نشط</span>');
  if(r.motor2?.status)badges.push('<span class="badge" style="background:rgba(0,200,100,.15);color:var(--green);border:1px solid rgba(0,200,100,.3)">🟢 محرك2 نشط</span>');
  if(!badges.length)badges.push('<span class="badge badge-red">لا توجد ميزات مفعلة</span>');
  _q('statusBadgesRow').innerHTML=badges.join('');

  // NM
  _stSetBadge('st_nmBadge',r.nm?.locked);
  if(r.nm?.locked){_q('st_nmName').value=r.nm.name||'';_q('st_nmTime').value=Math.round((r.nm.time||6000)/1000);}
  _q('st_nmSt').textContent=r.nm?.locked?'مقفول على: "'+r.nm.name+'" كل '+Math.round((r.nm.time||6000)/1000)+'s':'—';

  // Nicknames
  _stSetBadge('st_nickBadge',r.nick?.locked);
  if(r.nick?.locked){_q('st_nickName').value=r.nick.nickname||'';_q('st_nickScope').value=r.nick.scope||'all';}
  _q('st_nickSt').textContent=r.nick?.locked?'مقفول على: "'+r.nick.nickname+'" ('+r.nick.scope+')':'—';

  // Motor1
  _stSetBadge('st_m1Badge',r.motor1?.status);
  if(r.motor1?.message)_q('st_m1Msg').value=r.motor1.message;
  if(r.motor1?.time)_q('st_m1Time').value=Math.round(r.motor1.time/1000);
  _q('st_m1St').textContent=r.motor1?.status?'نشط — كل '+Math.round((r.motor1.time||0)/1000)+'s':'متوقف';

  // Motor2
  _stSetBadge('st_m2Badge',r.motor2?.status);
  if(r.motor2?.message)_q('st_m2Msg').value=r.motor2.message;
  if(r.motor2?.time)_q('st_m2Time').value=Math.round(r.motor2.time/1000);
  _q('st_m2St').textContent=r.motor2?.status?'نشط — كل '+Math.round((r.motor2.time||0)/1000)+'s':'متوقف';
}

function _stSetBadge(id,on){var el=_q(id);if(!el)return;el.className='badge '+(on?'badge-green':'badge-red');el.textContent=on?'مفعل':'غير مفعل';}
function _stInfo(id,msg,ok){var el=_q(id);if(!el)return;el.innerHTML='<span style="color:var(--'+(ok?'green':'red')+')">'+(ok?'✅':'❌')+' '+_h(msg)+'</span>';}

async function _stNmAction(action){
  if(!_selTID)return;
  var p={threadID:_selTID,action};
  if(action==='enable'){p.name=_q('st_nmName').value.trim();p.timeMs=Number(_q('st_nmTime').value)*1000;}
  var r=await api('/api/hold/nm-set',p);
  if(r.ok){_stSetBadge('st_nmBadge',action==='enable');_stInfo('st_nmSt',action==='enable'?'تم تفعيل قفل الاسم':'تم إيقاف القفل',true);}
  else _stInfo('st_nmSt',r.error||'فشل',false);
}

async function _stNickAction(action){
  if(!_selTID)return;
  var p={threadID:_selTID,action,scope:_q('st_nickScope').value};
  if(action==='enable'){p.nickname=_q('st_nickName').value.trim();}
  var r=await api('/api/hold/nick-set',p);
  if(r.ok){_stSetBadge('st_nickBadge',action==='enable');_stInfo('st_nickSt',action==='enable'?'تم تفعيل قفل الكنيات':'تم إيقاف القفل',true);}
  else _stInfo('st_nickSt',r.error||'فشل',false);
}

async function _stM1Action(action){
  if(!_selTID)return;
  var p={threadID:_selTID,action};
  if(action==='message')p.message=_q('st_m1Msg').value.trim();
  if(action==='time'||action==='enable')p.timeMs=Number(_q('st_m1Time').value)*1000;
  var r=await api('/api/hold/motor1-set',p);
  if(r.ok){if(action==='enable'||action==='disable')_stSetBadge('st_m1Badge',action==='enable');_stInfo('st_m1St',action==='enable'?'تم تشغيل المحرك':action==='disable'?'تم الإيقاف':'تم الحفظ',true);}
  else _stInfo('st_m1St',r.error||'فشل',false);
}

async function _stM2Action(action){
  if(!_selTID)return;
  var p={threadID:_selTID,action};
  if(action==='message')p.message=_q('st_m2Msg').value.trim();
  if(action==='time'||action==='enable')p.timeMs=Number(_q('st_m2Time').value)*1000;
  var r=await api('/api/hold/motor2-set',p);
  if(r.ok){if(action==='enable'||action==='disable')_stSetBadge('st_m2Badge',action==='enable');_stInfo('st_m2St',action==='enable'?'تم تشغيل المحرك':action==='disable'?'تم الإيقاف':'تم الحفظ',true);}
  else _stInfo('st_m2St',r.error||'فشل',false);
}

async function _stExecCmd(){
  if(!_selTID)return;
  var cmd=(_q('st_cmdInput').value||'').trim();
  if(!cmd)return;
  _q('st_cmdSt').innerHTML='⏳ جارٍ التنفيذ...';
  var r=await api('/api/execute',{threadID:_selTID,command:cmd});
  if(r&&(r.ok||r.sent||r.message||r.messageID)){
    _q('st_cmdSt').innerHTML='<span style="color:var(--green)">✅ تم تنفيذ الأمر</span>';
    _q('st_cmdInput').value='';
    showToast('✅ تم تنفيذ الأمر','success');
  }else{
    _q('st_cmdSt').innerHTML='<span style="color:var(--red)">❌ '+(r&&r.error?_h(r.error):'فشل التنفيذ')+'</span>';
  }
}

/* ──────────────────────────── Group list ──────────────────────────────────── */
async function refreshGroups(){
  var btn=_q('msngRefreshBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳';}
  try{
    var r=await fetch('/api/groups-list');
    var d=await r.json();
    var groups=d.groups||[];
    groups.sort(function(a,b){return Number(b.lastTime||b.timestamp||0)-Number(a.lastTime||a.timestamp||0);});
    _allGroups=groups;
    _q('msngGrpCount').textContent=_allGroups.length;
    _renderGroupList(_allGroups);
    if(!_allGroups.length)showToast('⚠️ '+(d.error||'لا توجد غروبات — البوت قد يكون غير متصل'),'warn');
    else showToast('✅ '+_allGroups.length+' غروب'+(d.cached?' (كاش)':''),'success');
  }catch(e){
    _q('msngGroupList').innerHTML='<div style="text-align:center;padding:32px;color:var(--red);font-size:.83rem">❌ '+_h(String(e.message||e))+'</div>';
    showToast('❌ فشل جلب الغروبات','error');
  }
  if(btn){btn.disabled=false;btn.textContent='🔄';}
}

function _renderGroupList(groups){
  var list=_q('msngGroupList');
  if(!groups.length){list.innerHTML='<div style="text-align:center;padding:32px;color:var(--text3);font-size:.82rem">لا توجد نتائج</div>';return;}
  list.innerHTML=groups.map(function(g){
    var act=g.threadID===_selTID;
    var lastT=g.lastTime?_fmt(g.lastTime):'';
    var lastM=g.lastMsg?_h(String(g.lastMsg).slice(0,45)):'';
    var unr=g.unread?'<span class="msng-unread-badge">'+g.unread+'</span>':'';
    return '<div class="msng-group-item'+(act?' active':'')+'" id="gi-'+_h(g.threadID)+'"'
      +' data-tid="'+_h(g.threadID)+'" data-name="'+_h(g.name||'')+'" data-mc="'+(Number(g.memberCount)||0)+'">'
      +'<div class="msng-grp-ava" style="background:linear-gradient('+_grad(g.threadID)+')">'+_ini(g.name)+'</div>'
      +'<div class="msng-grp-info">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;gap:4px">'
          +'<div class="msng-grp-name">'+_h(g.name||'غير مسمى')+'</div>'
          +'<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">'+unr+'<span style="font-size:.63rem;color:var(--text3)">'+lastT+'</span></div>'
        +'</div>'
        +'<div class="msng-grp-meta">'+(lastM||_h(g.threadID))+'</div>'
      +'</div>'
    +'</div>';
  }).join('');
}

function _filterGroups(){
  var s=_q('msngSearch').value.toLowerCase();
  _renderGroupList(_allGroups.filter(function(g){return (g.name||'').toLowerCase().includes(s)||String(g.threadID).includes(s);}));
}

function _bumpGroup(tid,lastMsg,ts){
  var idx=_allGroups.findIndex(function(g){return g.threadID===tid;});
  if(idx>=0){_allGroups[idx].lastMsg=lastMsg;_allGroups[idx].lastTime=ts||Date.now();}
  _allGroups.sort(function(a,b){return Number(b.lastTime||0)-Number(a.lastTime||0);});
  _filterGroups();
}

/* ──────────────────────────── Select group ────────────────────────────────── */
function _selectGroup(tid,name,mc){
  _selTID=tid;
  document.querySelectorAll('.msng-group-item').forEach(function(el){el.classList.remove('active');});
  var el=_q('gi-'+tid);if(el)el.classList.add('active');
  _q('msngPlaceholder').style.display='none';
  _q('msngChatInner').style.display='flex';
  var ava=_q('msngChatAva');
  ava.textContent=_ini(name);ava.style.background='linear-gradient('+_grad(tid)+')';
  _q('msngChatName').textContent=name||tid;
  _q('msngChatSub').textContent=tid+(mc?' · '+mc+' عضو':'');
  if(window.innerWidth<=640)_q('msngSidebar').classList.add('hidden');
  _cancelReply();
  if(_pollTimer)clearInterval(_pollTimer);
  _lastMsgTS=0;
  _loadMessages(tid);
  _pollTimer=setInterval(function(){if(_selTID===tid)_pollNew(tid);},30000);
}

function _deselectGroup(){
  _q('msngSidebar').classList.remove('hidden');
  _q('msngPlaceholder').style.display='flex';
  _q('msngChatInner').style.display='none';
  document.querySelectorAll('.msng-group-item').forEach(function(el){el.classList.remove('active');});
  _selTID='';
  if(_pollTimer)clearInterval(_pollTimer);_pollTimer=null;
}

/* ──────────────────────────── Messages ────────────────────────────────────── */
async function _loadMessages(tid){
  var box=_q('msngMessages');
  box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text3);font-size:.83rem">⏳ جارٍ تحميل الرسائل...</div>';
  try{
    var r=await fetch('/api/thread-history?threadID='+encodeURIComponent(tid)+'&count=40');
    var d=await r.json();
    if(!d.ok&&!Array.isArray(d.messages)){
      box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text3);font-size:.83rem">💬 '+(d.error||'المكتبة لا تدعم جلب سجل الرسائل')+'</div>';return;
    }
    var msgs=d.messages||[];
    _lastMsgTS=msgs.length?Number(msgs[msgs.length-1].timestamp||0):0;
    if(!msgs.length){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text3);font-size:.83rem">📭 لا توجد رسائل محفوظة</div>';return;}
    box.innerHTML='<div id="msngMsgsInner">'+msgs.map(function(m){return _renderBubble(m,_botID);}).join('')+'</div>';
    box.scrollTop=box.scrollHeight;
    _attachBubbleEvents();
  }catch(e){
    box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text3);font-size:.83rem">💬 جلب الرسائل غير متاح ('+_h(String(e.message||''))+')...</div>';
  }
}

async function _pollNew(tid){
  try{
    var r=await fetch('/api/thread-history?threadID='+encodeURIComponent(tid)+'&count=8');
    var d=await r.json();
    if(!d.ok)return;
    var news=(d.messages||[]).filter(function(m){return Number(m.timestamp||0)>_lastMsgTS;});
    if(!news.length)return;
    var box=_q('msngMessages'),inner=_q('msngMsgsInner');
    if(!inner)return;
    var atBot=(box.scrollTop+box.clientHeight)>=(box.scrollHeight-100);
    news.forEach(function(m){
      var tmp=document.createElement('div');tmp.innerHTML=_renderBubble(m,_botID);
      if(tmp.firstChild)inner.appendChild(tmp.firstChild);
      _lastMsgTS=Math.max(_lastMsgTS,Number(m.timestamp||0));
    });
    if(atBot)box.scrollTop=box.scrollHeight;
    _attachBubbleEvents();
    var last=news[news.length-1];
    _bumpGroup(tid,last.body||'📎',last.timestamp);
  }catch(e){}
}

function _reloadMessages(){if(_selTID)_loadMessages(_selTID);}

function _renderBubble(m,myID){
  var isMe=!!(myID&&String(m.senderID)===String(myID)&&myID);
  var senderName=m.senderName||m.senderID||'مجهول';
  var msgID=m.messageID||m.id||'';
  var bodyText=m.body||'';
  var time=_fmt(m.timestamp);
  var fullT=_fmtFull(m.timestamp);
  var ini=((senderName||'?')[0]||'?').toUpperCase();
  var grad=_grad(String(m.senderID||'0'));

  var attaches='';
  var aa=m.attachments||[];
  for(var i=0;i<aa.length;i++){
    var a=aa[i];
    if((a.type==='photo'||a.type==='sticker')&&a.url){
      attaches+='<div style="margin-top:5px"><img src="'+_h(a.url)+'" style="max-width:180px;max-height:180px;border-radius:10px;cursor:pointer;display:block" onclick="window.open(\\''+_h(a.url)+'\\',\\'_blank\\')" onerror="this.parentElement.style.display=\\'none\\'"/></div>';
    }else if(a.type==='audio'&&a.url){
      attaches+='<div style="margin-top:5px"><audio src="'+_h(a.url)+'" controls style="max-width:200px;height:32px"></audio></div>';
    }else if(a.type==='video'&&a.url){
      attaches+='<div style="margin-top:5px"><video src="'+_h(a.url)+'" controls style="max-width:200px;border-radius:8px"></video></div>';
    }else if(a.url){
      attaches+='<div style="margin-top:5px"><a href="'+_h(a.url)+'" target="_blank" rel="noopener" style="color:var(--accent2);font-size:.75rem">📎 '+_h(a.type||'مرفق')+'</a></div>';
    }
  }

  if(m.isUnsent)return '<div style="text-align:center;color:var(--text3);font-size:.75rem;padding:4px 0;font-style:italic">🚫 تم حذف رسالة</div>';

  return '<div class="msng-bubble-wrap'+(isMe?' mine':'')+'" data-msgid="'+_h(msgID)+'" data-body="'+_h(bodyText.slice(0,200))+'" data-sender="'+_h(senderName.slice(0,80))+'">'
    +'<div class="msng-avatar-sm" style="background:linear-gradient('+grad+')" data-uid="'+_h(String(m.senderID||''))+'" data-uname="'+_h(senderName)+'">'+ini+'</div>'
    +'<div style="max-width:80%;display:flex;flex-direction:column;'+(isMe?'align-items:flex-end':'align-items:flex-start')+'">'
      +(isMe?'':'<div class="msng-bubble-name" data-uid="'+_h(String(m.senderID||''))+'" data-uname="'+_h(senderName)+'">'+_h(senderName)+'</div>')
      +(m.messageReply?('<div class="msng-reply-preview">↩ '+_h(String(m.messageReply.body||'').slice(0,60))+'</div>'):'')
      +'<div class="msng-bubble'+(isMe?' mine':'')+'">'+(bodyText?_h(bodyText):'<em style="color:var(--text3);font-size:.78rem">بلا نص</em>')+attaches+'</div>'
      +'<div class="msng-bubble-time" title="'+_h(fullT)+'">'+time+(isMe?' ✓✓':'')+'</div>'
    +'</div>'
  +'</div>';
}

/* ─────────────────────────── Context menu ─────────────────────────────────── */
function _attachBubbleEvents(){
  document.querySelectorAll('.msng-bubble-wrap:not([data-ev])').forEach(function(el){
    el.setAttribute('data-ev','1');
    el.addEventListener('contextmenu',function(e){e.preventDefault();_showCtx(el,e.clientX,e.clientY);});
    el.addEventListener('touchstart',function(e){var t=e.touches[0];_lpTimer=setTimeout(function(){_showCtx(el,t.clientX,t.clientY);},500);},{passive:true});
    el.addEventListener('touchend',function(){clearTimeout(_lpTimer);},{passive:true});
    el.addEventListener('touchmove',function(){clearTimeout(_lpTimer);},{passive:true});
  });
}

function _showCtx(el,x,y){
  _ctxMsg={msgID:el.getAttribute('data-msgid'),body:el.getAttribute('data-body')||'',sender:el.getAttribute('data-sender')||''};
  var menu=_q('msngCtxMenu');
  menu.style.display='block';
  var vw=window.innerWidth,vh=window.innerHeight;
  var left=x,top=y;
  if(left+185>vw)left=vw-192;
  if(top+230>vh)top=Math.max(4,y-230);
  menu.style.left=left+'px';menu.style.top=top+'px';
}
function _closeCtx(){var m=_q('msngCtxMenu');if(m)m.style.display='none';_ctxMsg=null;}

/* ──────────────────────────── Reply ───────────────────────────────────────── */
function _setReply(msgID,body,sender){
  _replyTo={msgID:msgID,body:body,sender:sender};
  _q('msngReplyText').textContent=(sender?sender+': ':'')+String(body||'').slice(0,80);
  _q('msngReplyBar').style.display='flex';
  _q('msngMsgInput').focus();
}
function _cancelReply(){
  _replyTo=null;
  _q('msngReplyBar').style.display='none';
  _q('msngReplyText').textContent='';
}

/* ──────────────────────────── Silent mode ─────────────────────────────────── */
function _toggleSilent(){
  _silentMode=!_silentMode;
  var btn=_q('msngSilentBtn');
  if(btn){
    btn.textContent=_silentMode?'🔕':'🔔';
    btn.title=_silentMode?'الصامت: مفعّل':'الصامت: موقف';
    if(_silentMode)btn.classList.add('active-silent');else btn.classList.remove('active-silent');
  }
  showToast(_silentMode?'🔕 وضع الصامت مفعّل':'🔔 وضع الصامت موقف','info');
}

/* ──────────────────────────── Send message ────────────────────────────────── */
async function _sendMsg(){
  if(!_selTID)return showToast('اختر غروباً أولاً','error');
  var inp=_q('msngMsgInput'),msg=inp.value.trim();
  if(!msg)return;
  _st('⏳ جارٍ الإرسال...');
  var payload={threadID:_selTID,message:msg};
  if(_replyTo&&_replyTo.msgID)payload.replyToMessage=_replyTo.msgID;
  if(_silentMode)payload.silent=true;
  var r=await api('/api/send',payload);
  if(r.ok||r.message||r.messageID){
    inp.value='';_cancelReply();
    _st('<span style="color:var(--green)">✅ تم الإرسال</span>');
    showToast('✅ الرسالة أُرسلت','success');
    _bumpGroup(_selTID,msg,Date.now());
    setTimeout(function(){_st('');_reloadMessages();},1500);
  }else{
    _st('<span style="color:var(--red)">❌ '+(r.error||'فشل الإرسال — البوت قد يكون غير متصل')+'</span>');
    showToast('❌ '+(r.error||'فشل'),'error');
  }
}

/* ──────────────────────────── Execute command ─────────────────────────────── */
async function _execCmd(){
  if(!_selTID)return showToast('اختر غروباً أولاً','error');
  var inp=_q('msngCmdInput'),cmd=inp.value.trim();
  if(!cmd)return;
  _st('⏳ تنفيذ الأمر "'+_h(cmd)+'"...');
  var r=await api('/api/execute',{threadID:_selTID,command:cmd});
  if(r.ok){
    inp.value='';
    _st('<span style="color:var(--green)">✅ '+(r.message||'تم تنفيذ الأمر — الرد سيصل في الغروب')+'</span>');
    showToast('✅ تم تنفيذ الأمر','success');
    setTimeout(function(){_st('');_reloadMessages();},2500);
  }else{
    var em=r.error||'فشل';
    if(r.availableCount!==undefined)em+=' ('+r.availableCount+' أمر متاح)';
    _st('<span style="color:var(--red)">❌ '+_h(em)+'</span>');
    showToast('❌ '+em,'error');
  }
}

/* ────────────────────────── Media / file upload ───────────────────────────── */
async function _uploadMedia(file){
  if(!_selTID)return showToast('اختر غروباً أولاً','error');
  if(file.size>20*1024*1024)return showToast('❌ الملف أكبر من 20 ميجابايت','error');
  _st('⏳ جارٍ رفع '+_h(file.name)+'...');
  var reader=new FileReader();
  reader.onload=async function(ev){
    var b64=ev.target.result.split(',')[1];
    if(!b64){_st('<span style="color:var(--red)">❌ تعذّر قراءة الملف</span>');return;}
    var r=await api('/api/send-media',{threadID:_selTID,base64:b64,mimeType:file.type||'application/octet-stream',filename:file.name});
    if(r.ok){
      _st('<span style="color:var(--green)">✅ تم إرسال '+_h(file.name)+'</span>');
      showToast('✅ تم إرسال الملف','success');
      _bumpGroup(_selTID,file.name,Date.now());
      setTimeout(function(){_st('');_reloadMessages();},2000);
    }else{
      _st('<span style="color:var(--red)">❌ '+(r.error||'فشل الإرسال')+'</span>');
      showToast('❌ '+(r.error||'فشل'),'error');
    }
  };
  reader.onerror=function(){_st('<span style="color:var(--red)">❌ خطأ في قراءة الملف</span>');};
  reader.readAsDataURL(file);
}

/* ─────────────────────────── Audio recording ──────────────────────────────── */
var _recTimer=null,_recSecs=0;

function _toggleRecord(){
  if(_mediaRecorder&&_mediaRecorder.state==='recording')_stopRecord();
  else _startRecord();
}

function _startRecord(){
  if(!_selTID)return showToast('اختر غروباً أولاً','error');
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return showToast('❌ المتصفح لا يدعم التسجيل','error');
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    _audioChunks=[];
    var mt='audio/webm';
    if(!MediaRecorder.isTypeSupported(mt))mt='audio/ogg;codecs=opus';
    if(!MediaRecorder.isTypeSupported(mt))mt='';
    try{_mediaRecorder=new MediaRecorder(stream,mt?{mimeType:mt}:{});}
    catch(e){_mediaRecorder=new MediaRecorder(stream);}
    _mediaRecorder.ondataavailable=function(e){if(e.data&&e.data.size>0)_audioChunks.push(e.data);};
    _mediaRecorder.onstop=function(){
      stream.getTracks().forEach(function(t){t.stop();});
      var mime=_mediaRecorder.mimeType||'audio/webm';
      var ext=mime.includes('ogg')?'ogg':'webm';
      var blob=new Blob(_audioChunks,{type:mime});
      var rd=new FileReader();
      rd.onload=async function(ev){
        var b64=ev.target.result.split(',')[1];
        if(!b64)return;
        _st('⏳ جارٍ إرسال التسجيل الصوتي...');
        var r=await api('/api/send-media',{threadID:_selTID,base64:b64,mimeType:mime,filename:'voice-'+Date.now()+'.'+ext});
        if(r.ok){
          _st('<span style="color:var(--green)">✅ تم إرسال الصوت</span>');
          showToast('✅ تم إرسال التسجيل','success');
          _bumpGroup(_selTID,'🎤 تسجيل صوتي',Date.now());
          setTimeout(function(){_st('');_reloadMessages();},2000);
        }else{
          _st('<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>');
        }
      };
      rd.readAsDataURL(blob);
    };
    _mediaRecorder.start(200);
    var btn=_q('msngRecBtn');if(btn){btn.classList.add('recording');btn.textContent='⏹️';btn.title='إيقاف التسجيل';}
    _recSecs=0;
    _recTimer=setInterval(function(){
      _recSecs++;
      _st('🔴 يسجل... '+_recSecs+'ث — اضغط ⏹️ للإيقاف والإرسال');
      if(_recSecs>=120)_stopRecord();
    },1000);
  }).catch(function(e){showToast('❌ الميكروفون: '+String(e.message||e),'error');});
}

function _stopRecord(){
  clearInterval(_recTimer);_recTimer=null;
  if(_mediaRecorder&&_mediaRecorder.state!=='inactive'){try{_mediaRecorder.stop();}catch(e){}}
  _mediaRecorder=null;
  var btn=_q('msngRecBtn');if(btn){btn.classList.remove('recording');btn.textContent='🎙️';btn.title='تسجيل صوتي';}
}

/* ──────────────────────────── Members modal ────────────────────────────────── */
async function _openMembers(){
  if(!_selTID)return showToast('اختر غروباً أولاً','error');
  _q('membersModal').style.display='flex';
  _q('membersList').innerHTML='<div style="text-align:center;padding:24px;color:var(--text3)">⏳ جارٍ التحميل...</div>';
  _q('memberModalTitle').textContent='👥 أعضاء: '+_q('msngChatName').textContent;
  try{
    var r=await fetch('/api/group-members?threadID='+encodeURIComponent(_selTID));
    var d=await r.json();
    _allMembers=d.members||[];
    _q('memberModalTitle').textContent='👥 الأعضاء ('+_allMembers.length+')';
    _renderMembers(_allMembers);
  }catch(e){
    _q('membersList').innerHTML='<div style="text-align:center;padding:24px;color:var(--red)">❌ '+_h(String(e.message||e))+'</div>';
  }
}

function _renderMembers(members){
  var list=_q('membersList');
  if(!members.length){list.innerHTML='<div style="text-align:center;padding:24px;color:var(--text3)">لا يوجد أعضاء</div>';return;}
  list.innerHTML=members.map(function(m){
    var ini=((m.name||'?')[0]||'?').toUpperCase();
    var grad=_grad(m.userID||'0');
    return '<div class="msng-member-row" data-uid="'+_h(m.userID||'')+'" data-uname="'+_h(m.name||m.userID||'مجهول')+'" data-admin="'+(m.isAdmin?'true':'false')+'">'
      +'<div class="msng-avatar-sm" style="background:linear-gradient('+grad+');width:36px;height:36px;font-size:.78rem">'+ini+'</div>'
      +'<div style="flex:1;min-width:0">'
        +'<div style="font-weight:600;font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+_h(m.name||'مجهول')+(m.isAdmin?' <span class="badge badge-yellow" style="font-size:.58rem">مشرف</span>':'')+'</div>'
        +'<div style="font-size:.69rem;color:var(--text3);font-family:monospace">'+_h(m.userID||'')+'</div>'
      +'</div>'
      +'<span style="color:var(--text3);font-size:.8rem">↗</span>'
    +'</div>';
  }).join('');
}

/* ─────────────────────────── Profile modal ─────────────────────────────────── */
function _openProfile(uid,name,isAdmin){
  _curUID=uid;_curUName=name;
  var ini=((name||'?')[0]||'?').toUpperCase();
  _q('profileAva').textContent=ini;
  _q('profileAva').style.background='linear-gradient('+_grad(uid||'0')+')';
  _q('profileName').textContent=name||uid||'—';
  _q('profileUID').textContent=uid||'—';
  _q('profileLink').href='https://www.facebook.com/profile.php?id='+encodeURIComponent(uid||'');
  _q('profileAdminBadge').style.display=isAdmin?'block':'none';
  _q('profileActSt').innerHTML='';
  _q('profileModal').style.display='flex';
  _q('membersModal').style.display='none';
}

/* ────────────────────────── Nickname modal ─────────────────────────────────── */
function _openNickname(){
  if(!_selTID||!_curUID)return showToast('يجب اختيار غروب وعضو','error');
  _q('nicknameForName').textContent='العضو: '+_q('profileName').textContent;
  _q('nicknameInput').value='';_q('nicknameSt').innerHTML='';
  _q('nicknameModal').style.display='flex';
}

async function _doNickname(){
  var nick=_q('nicknameInput').value.trim();
  _st('⏳ جارٍ التغيير...','nicknameSt');
  var r=await api('/api/set-nickname',{threadID:_selTID,userID:_curUID,nickname:nick});
  if(r.ok){
    _st('<span style="color:var(--green)">✅ تم تغيير الكنية</span>','nicknameSt');
    showToast('✅ تم تغيير الكنية','success');
    setTimeout(function(){_q('nicknameModal').style.display='none';},1200);
  }else{
    _st('<span style="color:var(--red)">❌ '+(r.error||'فشل — قد لا يكون مدعوماً')+'</span>','nicknameSt');
  }
}

/* ─────────────────────────── Change name ────────────────────────────────────── */
function _openChangeName(){
  if(!_selTID)return showToast('اختر غروباً أولاً','error');
  _q('changeNameCurrent').textContent='الاسم الحالي: '+_q('msngChatName').textContent;
  _q('newGroupName').value='';_q('changeNameSt').innerHTML='';
  _q('changeNameModal').style.display='flex';
  setTimeout(function(){_q('newGroupName').focus();},100);
}

async function _doChangeName(){
  var name=_q('newGroupName').value.trim();
  if(!name)return showToast('أدخل الاسم الجديد','error');
  _st('⏳ جارٍ التغيير...','changeNameSt');
  var r=await api('/api/group-change-name',{threadID:_selTID,name:name});
  if(r.ok){
    _q('msngChatName').textContent=name;
    var grp=_allGroups.find(function(g){return g.threadID===_selTID;});
    if(grp){grp.name=name;_filterGroups();}
    _st('<span style="color:var(--green)">✅ تم تغيير الاسم</span>','changeNameSt');
    showToast('✅ تم تغيير اسم الغروب','success');
    setTimeout(function(){_q('changeNameModal').style.display='none';},1500);
  }else{
    _st('<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>','changeNameSt');
    showToast('❌ '+(r.error||'فشل'),'error');
  }
}

/* ─────────────────────────── Report ────────────────────────────────────────── */
async function _reportMessage(msgID){
  if(!_selTID)return;
  var r=await api('/api/report-message',{threadID:_selTID,messageID:msgID||''});
  if(r.ok)showToast('✅ تم التبليغ','success');
  else showToast('⚠️ '+(r.error||'التبليغ غير متاح في هذا الإصدار'),'warn');
}

/* ─────────────────────────── Event delegation setup ─────────────────────────── */
(function _setupEvents(){

  /* Group list */
  _q('msngGroupList').addEventListener('click',function(e){
    var item=e.target.closest('.msng-group-item');
    if(item)_selectGroup(item.dataset.tid,item.dataset.name,item.dataset.mc);
  });
  _q('msngSearch').addEventListener('input',_filterGroups);

  /* Header buttons */
  _q('msngRefreshBtn').addEventListener('click',refreshGroups);
  _q('msngBackBtn').addEventListener('click',_deselectGroup);
  _q('msngSilentBtn').addEventListener('click',_toggleSilent);
  _q('msngMembersBtn').addEventListener('click',_openMembers);
  _q('msngRenameBtn').addEventListener('click',_openChangeName);
  _q('msngReloadBtn').addEventListener('click',_reloadMessages);

  /* Reply bar */
  _q('msngCancelReply').addEventListener('click',_cancelReply);

  /* Messages area — avatar / name click → profile; drag-drop */
  var msgBox=_q('msngMessages');
  msgBox.addEventListener('click',function(e){
    var ava=e.target.closest('.msng-avatar-sm');
    if(ava&&ava.dataset.uid){_openProfile(ava.dataset.uid,ava.dataset.uname||ava.dataset.uid,false);return;}
    var bn=e.target.closest('.msng-bubble-name');
    if(bn&&bn.dataset.uid){_openProfile(bn.dataset.uid,bn.dataset.uname||bn.dataset.uid,false);}
  });
  msgBox.addEventListener('dragover',function(e){e.preventDefault();msgBox.classList.add('drag-over');});
  msgBox.addEventListener('dragleave',function(){msgBox.classList.remove('drag-over');});
  msgBox.addEventListener('drop',function(e){
    e.preventDefault();msgBox.classList.remove('drag-over');
    if(!_selTID){showToast('اختر غروباً أولاً','error');return;}
    var files=e.dataTransfer.files;
    for(var i=0;i<files.length;i++)_uploadMedia(files[i]);
  });

  /* Close ctx on outside click */
  document.addEventListener('click',function(e){var m=_q('msngCtxMenu');if(m&&!m.contains(e.target))_closeCtx();});

  /* Context menu buttons */
  _q('ctxReplyBtn').addEventListener('click',function(){if(_ctxMsg)_setReply(_ctxMsg.msgID,_ctxMsg.body,_ctxMsg.sender);_closeCtx();});
  _q('ctxCopyBtn').addEventListener('click',function(){
    if(_ctxMsg&&_ctxMsg.body)navigator.clipboard.writeText(_ctxMsg.body).then(function(){showToast('✅ تم النسخ','success');});
    _closeCtx();
  });
  _q('ctxReportBtn').addEventListener('click',function(){if(_ctxMsg)_reportMessage(_ctxMsg.msgID);_closeCtx();});
  _q('msngCtxReact').addEventListener('click',function(e){
    var sp=e.target.closest('span');
    if(!sp||!_selTID)return;
    var emoji=sp.getAttribute('data-emoji');
    if(emoji)api('/api/send',{threadID:_selTID,message:emoji}).then(function(r){if(r.ok||r.message)showToast('✅ تم','success');});
    _closeCtx();
  });

  /* Input buttons */
  _q('msngSendBtn').addEventListener('click',_sendMsg);
  _q('msngMsgInput').addEventListener('keydown',function(e){
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();_hideSlashMenu();_sendMsg();return;}
    if(e.key==='Escape'){_hideSlashMenu();}
  });
  _q('msngMsgInput').addEventListener('input',function(){
    var v=this.value;
    if(v.startsWith('/')){_showSlashMenu(v);}
    else{_hideSlashMenu();}
  });
  /* close slash menu when clicking outside */
  document.addEventListener('click',function(e){if(!e.target.closest('#slashMenu')&&!e.target.closest('#msngMsgInput'))_hideSlashMenu();});
  _q('msngExecBtn').addEventListener('click',_execCmd);
  _q('msngCmdInput').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();_execCmd();}});

  _q('msngAttachImgBtn').addEventListener('click',function(){var fi=_q('msngFileInp');fi.accept='image/*,video/*';fi.click();});
  _q('msngAttachAudioBtn').addEventListener('click',function(){var fi=_q('msngFileInp');fi.accept='audio/*';fi.click();});
  _q('msngRecBtn').addEventListener('click',_toggleRecord);
  _q('msngFileInp').addEventListener('change',function(e){
    var files=e.target.files;
    for(var i=0;i<files.length;i++)_uploadMedia(files[i]);
    e.target.value='';
  });

  /* Profile modal */
  _q('profileUID').addEventListener('click',function(){navigator.clipboard.writeText(this.textContent).then(function(){showToast('✅ تم نسخ الـ ID','success');});});
  _q('closeProfileBtn').addEventListener('click',function(){_q('profileModal').style.display='none';});
  _q('profileSendBtn').addEventListener('click',function(){
    if(!_curUID)return;
    var msg=prompt('رسالة لـ '+_q('profileName').textContent+':');
    if(!msg)return;
    api('/api/send',{threadID:_curUID,message:msg}).then(function(r){
      _st((r.ok||r.message||r.messageID)?'<span style="color:var(--green)">✅ تم الإرسال</span>':'<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>','profileActSt');
    });
  });
  _q('profileNickBtn').addEventListener('click',_openNickname);
  _q('profileKickBtn').addEventListener('click',async function(){
    if(!_selTID||!_curUID)return;
    if(!confirm('هل تريد إخراج هذا العضو من الغروب؟'))return;
    _st('⏳ جارٍ الكيك...','profileActSt');
    var r=await api('/api/group-kick',{threadID:_selTID,userID:_curUID});
    if(r.ok){
      _st('<span style="color:var(--green)">✅ تم الكيك</span>','profileActSt');
      setTimeout(function(){_q('profileModal').style.display='none';_openMembers();},1000);
    }else{
      _st('<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>','profileActSt');
    }
  });

  /* Members modal */
  _q('closeMembersBtn').addEventListener('click',function(){_q('membersModal').style.display='none';});
  _q('memberSearch').addEventListener('input',function(){
    var s=this.value.toLowerCase();
    _renderMembers(_allMembers.filter(function(m){return (m.name||'').toLowerCase().includes(s)||String(m.userID||'').includes(s);}));
  });
  _q('membersList').addEventListener('click',function(e){
    var row=e.target.closest('.msng-member-row');
    if(row)_openProfile(row.dataset.uid,row.dataset.uname,row.dataset.admin==='true');
  });

  /* Nickname modal */
  _q('doNicknameBtn').addEventListener('click',_doNickname);
  _q('cancelNicknameBtn').addEventListener('click',function(){_q('nicknameModal').style.display='none';});
  _q('nicknameInput').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();_doNickname();}});

  /* Change name modal */
  _q('doChangeNameBtn').addEventListener('click',_doChangeName);
  _q('cancelChangeNameBtn').addEventListener('click',function(){_q('changeNameModal').style.display='none';});
  _q('newGroupName').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();_doChangeName();}});

  /* Status modal (⚙️ button) */
  _q('msngStatusBtn').addEventListener('click',_openGroupStatus);
  _q('closeStatusBtn').addEventListener('click',function(){_q('groupStatusModal').style.display='none';});
  _q('st_cmdInput').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();_stExecCmd();}});

  /* Group Tree modal */
  _q('msngTreeBtn').addEventListener('click',_openGroupTree);
  _q('closeTreeBtn').addEventListener('click',function(){_q('groupTreeModal').style.display='none';});
  _q('treeSearch').addEventListener('input',function(){
    var s=this.value.toLowerCase();
    _renderTree(s?_treeData.filter(function(g){return (g.name||'').toLowerCase().includes(s)||(g.threadID||'').includes(s);}):_treeData);
  });

  /* Keyboard ESC */
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){
      _q('membersModal').style.display='none';
      _q('profileModal').style.display='none';
      _q('nicknameModal').style.display='none';
      _q('changeNameModal').style.display='none';
      _q('groupTreeModal').style.display='none';
      _q('groupStatusModal').style.display='none';
      _q('msgReqModal2').style.display='none';
      _hideSlashMenu();
      _closeCtx();
    }
  });

  /* Overlay click to close */
  ['membersModal','profileModal','nicknameModal','changeNameModal','groupTreeModal','groupStatusModal','msgReqModal2'].forEach(function(id){
    _q(id).addEventListener('click',function(e){if(e.target===_q(id))_q(id).style.display='none';});
  });

  /* ── Message Requests ──────────────────────────────────────────────────── */
  async function _loadMsgReq2(){
    var st=_q('msgReq2Status'),list=_q('msgReq2List');
    if(!st||!list)return;
    st.textContent='⏳ جارٍ الجلب...';list.innerHTML='';
    try{
      var r=await fetch('/api/message-requests');
      var d=await r.json();
      var reqs=Array.isArray(d)?d:(d.requests||d||[]);
      if(!reqs.length){
        st.textContent='📭 لا توجد طلبات مراسلة معلّقة';
        list.innerHTML='<div style="text-align:center;padding:32px;color:var(--text3);font-size:2rem">📭<br><span style="font-size:.83rem">لا توجد طلبات</span></div>';
        _q('msngReqBadge').style.display='none';
        return;
      }
      st.textContent=reqs.length+' طلب معلّق — انقر قبول أو رفض';
      var badge=_q('msngReqBadge');
      if(badge){badge.textContent=reqs.length;badge.style.display='block';}
      list.innerHTML=reqs.map(function(req){
        var tid=_h(String(req.threadID||req.id||''));
        var name=_h(String(req.name||req.threadName||tid));
        var isGrp=req.isGroup?'<span class="badge badge-blue" style="font-size:.65rem">غروب</span>':'<span class="badge badge-purple" style="font-size:.65rem">دايركت</span>';
        var folderC=(req.folder||'').toUpperCase()==='OTHER'?'rgba(255,160,0,.15)':'rgba(0,180,120,.12)';
        var folderTxt=(req.folder||'').toUpperCase()==='OTHER'?'فلتر رسائل':'طلب جديد';
        return '<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
          +'<div class="msng-grp-ava" style="background:linear-gradient('+_grad(req.threadID||'0')+');flex-shrink:0;width:38px;height:38px;font-size:.85rem">'+_ini(req.name||'?')+'</div>'
          +'<div style="flex:1;min-width:0">'
            +'<div style="font-weight:700;font-size:.87rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+name+'</div>'
            +'<div style="display:flex;gap:5px;align-items:center;margin-top:3px;flex-wrap:wrap">'
              +'<code style="font-size:.69rem;color:var(--text3)">'+tid+'</code>'+isGrp
              +'<span style="background:'+folderC+';border-radius:4px;padding:1px 6px;font-size:.67rem;color:var(--text2)">'+folderTxt+'</span>'
            +'</div>'
          +'</div>'
          +'<div style="display:flex;gap:6px;flex-shrink:0">'
            +'<button class="btn btn-outline btn-sm" style="color:var(--green);font-size:.8rem" onclick="this._act(\\'accept\\')" data-tid="'+tid+'" data-name="'+name+'">✅ قبول</button>'
            +'<button class="btn btn-outline btn-sm" style="color:var(--red);font-size:.8rem" onclick="this._act(\\'decline\\')" data-tid="'+tid+'" data-name="'+name+'">❌ رفض</button>'
          +'</div>'
        +'</div>';
      }).join('');
      // Attach action handlers to buttons (avoids global scope issues)
      list.querySelectorAll('.btn').forEach(function(btn){
        btn.addEventListener('click',function(){
          var action=this.textContent.includes('قبول')?'accept':'decline';
          var row=this.closest('div[data-tid]')||this.parentElement.parentElement;
          // get tid/name from the buttons' parent structure
          var p=this.closest('[data-tid]')||this.parentElement;
          while(p&&!p.dataset.tid)p=p.parentElement;
          var btid=p?p.dataset.tid:this.dataset.tid;
          var bname=p?p.dataset.name:this.dataset.name;
          _msgReq2Act(btid,action,bname,this);
        });
      });
    }catch(e){
      st.textContent='❌ '+_h(String(e.message||e));
      list.innerHTML='<div style="text-align:center;padding:24px;color:var(--red)">❌ فشل جلب الطلبات</div>';
    }
  }

  async function _msgReq2Act(tid,action,name,btn){
    if(!confirm((action==='accept'?'قبول':'رفض')+' طلب مراسلة من: '+name+'?'))return;
    if(btn){btn.disabled=true;btn.textContent='⏳';}
    try{
      var r=await api('/api/message-requests/'+action,{threadID:tid});
      if(r&&(r.ok||r.accepted||r.declined)){
        showToast(action==='accept'?'✅ تم قبول الطلب':'✅ تم رفض الطلب','success');
        setTimeout(_loadMsgReq2,600);
      }else{
        showToast('❌ '+(r&&r.error?r.error:'فشل التنفيذ'),'error');
        if(btn){btn.disabled=false;btn.textContent=action==='accept'?'✅ قبول':'❌ رفض';}
      }
    }catch(e){
      showToast('❌ '+String(e.message||e),'error');
      if(btn){btn.disabled=false;btn.textContent=action==='accept'?'✅ قبول':'❌ رفض';}
    }
  }

  /* ── Init ──────────────────────────────────────────────────────────────── */
  (async function(){
    await _initBotID();
    await refreshGroups();
    setInterval(refreshGroups,60000);
    // Silent badge check for message requests
    fetch('/api/message-requests').then(function(r){return r.json();}).then(function(d){
      var reqs=Array.isArray(d)?d:(d.requests||d||[]);
      var badge=_q('msngReqBadge');
      if(badge&&reqs.length){badge.textContent=reqs.length;badge.style.display='block';}
    }).catch(function(){});
    // Wire message-requests modal buttons
    _q('msngReqBtn').addEventListener('click',function(){_q('msgReqModal2').style.display='flex';_loadMsgReq2();});
    _q('msngReqRefreshBtn').addEventListener('click',_loadMsgReq2);
    _q('closeMsgReq2Btn').addEventListener('click',function(){_q('msgReqModal2').style.display='none';});
  })();

})();
</script>`;
    res.send(layout('الغروبات', body, 'groups', pageOpts()));
  });

  // ─── HEALTH ─────────────────────────────────────────────────────────────────
  app.get('/health', auth, async (req,res) => {
    const mem = process.memoryUsage();
    const body = `
<div class="page-header">
  <div class="page-title">💊 الصحة والأداء</div>
  <div class="page-sub">مقاييس الأداء والاتصال — يتحدث كل 5 ثوانٍ</div>
</div>

<!-- Stat cards -->
<div class="stats-grid" id="hlt-stats-grid">
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">🔗</div><div class="stat-val" id="hlt-bot-status" style="font-size:.9rem">${isBotOnline()?'<span class="badge badge-green">متصل</span>':'<span class="badge badge-red">غير متصل</span>'}</div><div class="stat-lbl">اتصال البوت</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">📡</div><div class="stat-val" id="hlt-mqtt" style="font-size:.9rem">—</div><div class="stat-lbl">MQTT</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">💾</div><div class="stat-val" id="hlt-ram">${Math.round(mem.rss/1024/1024)} MB</div><div class="stat-lbl">RAM (RSS)</div></div>
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">🖥️</div><div class="stat-val" id="hlt-cpu">—</div><div class="stat-lbl">CPU %</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">⏱️</div><div class="stat-val" id="hlt-uptime">${getUptime(STARTED_AT)}</div><div class="stat-lbl">Uptime</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">🔄</div><div class="stat-val">${getRestarts()}</div><div class="stat-lbl">Restarts</div></div>
</div>

<!-- Live CPU/RAM graph -->
<div class="card" style="margin-bottom:14px">
  <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
    <div class="card-title">📊 رسم بياني مباشر — CPU / RAM</div>
    <div style="display:flex;gap:14px;font-size:.76rem;color:var(--text3)">
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:#00d4ff;display:inline-block"></span>CPU %</span>
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:#00ff9f;display:inline-block"></span>RAM (MB)</span>
    </div>
  </div>
  <div style="position:relative;height:220px;margin-top:10px">
    <canvas id="hltChart"></canvas>
  </div>
</div>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
  <!-- Memory breakdown -->
  <div class="card">
    <div class="card-title" style="margin-bottom:14px">🧠 تفاصيل الذاكرة</div>
    <div id="hlt-mem-detail">
      ${[['RSS',mem.rss],['Heap Used',mem.heapUsed],['Heap Total',mem.heapTotal],['External',mem.external]].map(([k,v])=>`
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text3);font-size:.84rem">${k}</span>
        <span style="font-weight:700;color:var(--accent);font-size:.84rem">${Math.round(v/1024/1024)} MB</span>
      </div>`).join('')}
    </div>
  </div>
  <!-- Bot health detail -->
  <div class="card">
    <div class="card-title" style="margin-bottom:14px">🤖 حالة البوت</div>
    <div id="hlt-bot-detail" style="color:var(--text3);font-size:.84rem">⏳ جارٍ التحميل...</div>
  </div>
</div>

<div class="card" style="margin-top:4px">
  <div class="card-title" style="margin-bottom:14px">🔄 إجراءات</div>
  <div class="btn-row">
    <button class="btn btn-outline" onclick="hltPoll()">🔄 تحديث فوري</button>
    <button class="btn btn-primary" onclick="botAction('restart')">🔄 إعادة تشغيل البوت</button>
    <a href="/logs" class="btn btn-purple">📡 السجلات</a>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script>
async function botAction(a){const r=await api('/api/bot/'+a,{});showToast(r.ok||r.message?'✅ تم':'❌ '+(r.error||'فشل'),r.ok||r.message?'success':'error')}

// ── Chart setup ───────────────────────────────────────────────────
const _chartCtx = document.getElementById('hltChart').getContext('2d');
const _chartLabels = [];
const _cpuData     = [];
const _ramData     = [];

const _hltChart = new Chart(_chartCtx, {
  type: 'line',
  data: {
    labels: _chartLabels,
    datasets: [
      {
        label: 'CPU %',
        data: _cpuData,
        borderColor: '#00d4ff',
        backgroundColor: 'rgba(0,212,255,.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
        yAxisID: 'yCpu',
      },
      {
        label: 'RAM (MB)',
        data: _ramData,
        borderColor: '#00ff9f',
        backgroundColor: 'rgba(0,255,159,.06)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
        yAxisID: 'yRam',
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0c0f20',
        borderColor: 'rgba(255,255,255,.1)',
        borderWidth: 1,
        titleColor: '#8899bb',
        bodyColor: '#dde2f5',
        callbacks: {
          label: ctx => ctx.datasetIndex === 0
            ? 'CPU: ' + ctx.parsed.y + '%'
            : 'RAM: ' + ctx.parsed.y + ' MB'
        }
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,.04)' },
        ticks: { color: '#556', font: { size: 10 }, maxTicksLimit: 8, maxRotation: 0 }
      },
      yCpu: {
        type: 'linear',
        position: 'right',
        min: 0, max: 100,
        grid: { color: 'rgba(0,212,255,.06)' },
        ticks: { color: '#00d4ff', font: { size: 10 }, callback: v => v + '%' }
      },
      yRam: {
        type: 'linear',
        position: 'left',
        min: 0,
        grid: { color: 'rgba(0,255,159,.04)' },
        ticks: { color: '#00ff9f', font: { size: 10 }, callback: v => v + 'M' }
      }
    }
  }
});

function _fmt(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0') + ':' + d.getSeconds().toString().padStart(2,'0');
}

// ── Poll sys-stats ────────────────────────────────────────────────
async function hltPollSys() {
  try {
    const r = await fetch('/api/sys-stats');
    if (!r.ok) return;
    const d = await r.json();
    if (!d.samples) return;
    // Rebuild chart data from samples
    _chartLabels.length = 0;
    _cpuData.length     = 0;
    _ramData.length     = 0;
    d.samples.forEach(s => {
      _chartLabels.push(_fmt(s.ts));
      _cpuData.push(s.cpuPct);
      _ramData.push(s.memMB);
    });
    _hltChart.update('none');
    // Update stat cards
    if (d.samples.length) {
      const last = d.samples[d.samples.length - 1];
      const cpuEl = document.getElementById('hlt-cpu');
      const ramEl = document.getElementById('hlt-ram');
      if (cpuEl) { cpuEl.textContent = last.cpuPct + '%'; cpuEl.style.color = last.cpuPct > 80 ? 'var(--red)' : last.cpuPct > 50 ? 'var(--yellow)' : 'var(--green)'; }
      if (ramEl) { ramEl.textContent = last.memMB + ' MB'; ramEl.style.color = last.memMB > 500 ? 'var(--red)' : last.memMB > 300 ? 'var(--yellow)' : 'var(--accent)'; }
    }
  } catch (_) {}
}

// ── Poll bot health ───────────────────────────────────────────────
async function hltPollBot() {
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    const mqEl = document.getElementById('hlt-mqtt');
    const detEl = document.getElementById('hlt-bot-detail');
    if (mqEl) {
      const mq = d.bot?.mqttConnected ?? d.mqttConnected;
      mqEl.innerHTML = mq === true
        ? '<span class="badge badge-green">متصل</span>'
        : mq === false
          ? '<span class="badge badge-red">منقطع</span>'
          : '—';
    }
    if (detEl && d.bot) {
      const rows = [
        ['MQTT', d.bot.mqttConnected ? '✅ متصل' : '❌ منقطع'],
        ['Tier', d.bot.activeTier ? 'Tier ' + d.bot.activeTier : '—'],
        ['Send Fails', d.bot.sendFailCount ?? '—'],
        ['Last Cookie Scan', d.bot.lastCookieScan?.result || '—'],
        ['Active Motors', (d.bot.activeMotors||[]).length],
        ['Active Name Locks', (d.bot.activeLocks||[]).length],
      ];
      detEl.innerHTML = rows.map(([k,v]) =>
        '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">' +
        '<span style="color:var(--text3)">' + k + '</span>' +
        '<span style="font-weight:600">' + v + '</span></div>'
      ).join('');
    } else if (detEl && !d.bot) {
      detEl.innerHTML = '<span style="color:var(--red)">⚠️ البوت غير متصل</span>';
    }
  } catch (_) {}
}

async function hltPoll() {
  await Promise.all([hltPollSys(), hltPollBot()]);
}

hltPoll();
setInterval(hltPollSys, 5000);
setInterval(hltPollBot, 15000);
</script>`;
    res.send(layout('الصحة', body, 'health', pageOpts()));
  });

  // ─── READINESS ──────────────────────────────────────────────────────────────
  app.get('/readiness', auth, (req, res) => {
    const body = `
<div class="page-header">
  <div class="page-title">✅ الجاهزية</div>
  <div class="page-sub">حالة MQTT والجلسة وصحة البوت — يتحدث كل 5 ثوانٍ</div>
</div>

<div class="stats-grid" id="rdy-grid">
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">📡</div><div class="stat-val" id="rdy-mqtt" style="font-size:.9rem">—</div><div class="stat-lbl">MQTT</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">🔗</div><div class="stat-val" id="rdy-bot" style="font-size:.9rem">—</div><div class="stat-lbl">البوت</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">🔑</div><div class="stat-val" id="rdy-tier">—</div><div class="stat-lbl">الطبقة النشطة</div></div>
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">🛡️</div><div class="stat-val" id="rdy-method" style="font-size:.8rem">—</div><div class="stat-lbl">طريقة الدخول</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">⏱️</div><div class="stat-val" id="rdy-last" style="font-size:.8rem">—</div><div class="stat-lbl">آخر نشاط MQTT</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">🍪</div><div class="stat-val" id="rdy-renew" style="font-size:.85rem">—</div><div class="stat-lbl">دورة تجديد الكوكيز</div></div>
</div>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px;margin-top:4px">
  <div class="card">
    <div class="card-title" style="margin-bottom:14px">📡 حالة MQTT</div>
    <div id="rdy-mqtt-detail" style="font-size:.84rem;color:var(--text3)">⏳ جارٍ التحميل...</div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:14px">🔐 الجلسة والحساب</div>
    <div id="rdy-session-detail" style="font-size:.84rem;color:var(--text3)">⏳ جارٍ التحميل...</div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:14px">🏓 جدول البينغ</div>
    <div id="rdy-ping-detail" style="font-size:.84rem;color:var(--text3)">⏳ جارٍ التحميل...</div>
  </div>
</div>

<div class="card" style="margin-top:4px">
  <div class="card-title" style="margin-bottom:10px">🔄 إجراءات</div>
  <div class="btn-row">
    <button class="btn btn-outline" onclick="rdyPoll()">🔄 تحديث</button>
    <button class="btn btn-primary"  onclick="rdyAction('restart')">🔄 إعادة تشغيل البوت</button>
    <a href="/health" class="btn btn-purple">📊 الصحة والأداء</a>
  </div>
</div>

<script>
async function rdyAction(a){const r=await api('/api/bot/'+a,{});showToast(r.ok||r.message?'✅ تم':'❌ '+(r.error||'فشل'),r.ok||r.message?'success':'error');}

function _rdyRow(k,v,vc){
  return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">'+
    '<span style="color:var(--text3)">'+k+'</span>'+
    '<span style="font-weight:600;color:'+(vc||'var(--text)')+'">'+v+'</span></div>';
}
function _fmtAgo(sec){
  if(sec===null||sec===undefined)return '—';
  if(sec<60)return sec+'ث';
  if(sec<3600)return Math.floor(sec/60)+'د';
  return Math.floor(sec/3600)+'س';
}

async function rdyPoll(){
  try{
    const d=await fetch('/api/readiness').then(r=>r.json());
    if(!d||!d.ok)return;

    const mqttOk = d.mqtt&&d.mqtt.ready;
    const ago    = d.mqtt&&d.mqtt.lastActivitySec;

    const set=(id,v)=>{const el=document.getElementById(id);if(el)el.innerHTML=v;};

    set('rdy-mqtt',  mqttOk?'<span class="badge badge-green">✅ نشط</span>':'<span class="badge badge-red">❌ غير نشط</span>');
    set('rdy-bot',   d.bot&&d.bot.online?'<span class="badge badge-green">متصل</span>':'<span class="badge badge-red">غير متصل</span>');
    set('rdy-tier',  d.session?'T'+d.session.tier:'—');

    const mLbl=(m)=>m==='credentials'?'Credentials':m==='appstate-alt'?'Alt Cookies':m?'Cookies':'—';
    set('rdy-method', mLbl(d.session&&d.session.loginMethod));
    set('rdy-last',   ago!==null&&ago!==undefined?_fmtAgo(ago)+' مضت':'—');

    const rm=d.bot&&d.bot.renewIntervalMins;
    set('rdy-renew', rm?(rm>=60?Math.round(rm/60)+'س':rm+'د'):'—');

    // MQTT detail
    set('rdy-mqtt-detail',[
      _rdyRow('حالة الاتصال', mqttOk?'✅ متصل':'❌ منقطع', mqttOk?'var(--green)':'var(--red)'),
      _rdyRow('آخر رسالة',    ago!==null?_fmtAgo(ago)+' مضت':'لا يوجد', ago<120?'var(--green)':'var(--yellow)'),
      _rdyRow('حارس MQTT',    d.mqtt&&d.mqtt.watchdog?'✅ نشط':'—'),
    ].join(''));

    // Session detail
    if(d.session){
      const ml=mLbl(d.session.loginMethod);
      set('rdy-session-detail',[
        _rdyRow('الطبقة النشطة', 'Tier '+d.session.tier,                          'var(--accent)'),
        _rdyRow('طريقة الدخول',  ml),
        _rdyRow('تجديد الكوكيز', rm?(rm>=60?'كل '+Math.round(rm/60)+' ساعة':'كل '+rm+' دقيقة'):'—'),
        _rdyRow('ملف الجلسة',   d.session.stateFile||'—'),
      ].join(''));
    }

    // Ping detail
    if(d.ping){
      set('rdy-ping-detail',[
        _rdyRow('Auto-Ping',     d.ping.autoPing,      'var(--accent)'),
        _rdyRow('Keep-Alive',    d.ping.keepAlive,      'var(--green)'),
        _rdyRow('GraphQL Visit', d.ping.graphqlVisit,   'var(--purple)'),
        _rdyRow('تجديد الكوكيز',d.ping.cookieRefresh,  'var(--yellow)'),
      ].join(''));
    }

  }catch(_){}
}

rdyPoll();
setInterval(rdyPoll,5000);
</script>`;
    res.send(layout('الجاهزية', body, 'readiness', pageOpts()));
  });

  // ─── NOTIFICATIONS ──────────────────────────────────────────────────────────
  app.get('/notifications', auth, (req,res) => {
    const cfg = readSettings();
    const noti = cfg.notiWhenListenMqttError || {};
    const tg = noti.telegram || {};
    const dc = noti.discord  || {};

    const body = `
<div class="page-header">
  <div class="page-title">🔔 الإشعارات</div>
  <div class="page-sub">إعداد تنبيهات Telegram و Discord عند انقطاع البوت</div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-title">⚙️ إعداد عام</div>
    <span class="badge ${noti.enable?'badge-green':'badge-red'}">${noti.enable?'✅ مفعّل':'❌ معطّل'}</span>
  </div>
  <div class="toggle-row">
    <div><div class="toggle-info">تفعيل الإشعارات</div><div class="toggle-sub">إرسال تنبيه عند انقطاع MQTT أو تعطّل البوت</div></div>
    <label class="toggle"><input type="checkbox" ${noti.enable?'checked':''} onchange="setNoti('enable',this.checked)"/><span class="slider"></span></label>
  </div>
</div>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">
  <!-- Telegram -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">✈️ Telegram</div>
      <span class="badge ${tg.enable?'badge-green':'badge-red'}">${tg.enable?'✅ فعّال':'معطّل'}</span>
    </div>
    <div class="toggle-row">
      <div><div class="toggle-info">تفعيل Telegram</div></div>
      <label class="toggle"><input type="checkbox" ${tg.enable?'checked':''} onchange="setNotiTg('enable',this.checked)"/><span class="slider"></span></label>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Bot Token</label>
      <input type="text" id="tgToken" class="form-control" value="${htmlEscape(tg.botToken||'')}" placeholder="123456:AAAA..."/>
    </div>
    <div class="form-group">
      <label class="form-label">Chat ID</label>
      <input type="text" id="tgChatId" class="form-control" value="${htmlEscape(tg.chatId||'')}" placeholder="-100123456789"/>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary btn-sm" onclick="saveTg()">💾 حفظ</button>
      <button class="btn btn-outline btn-sm" onclick="testTg()">🧪 اختبار</button>
    </div>
    <div id="tgStatus" style="margin-top:8px;font-size:.82rem;min-height:22px"></div>
  </div>

  <!-- Discord -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">🎮 Discord</div>
      <span class="badge ${dc.enable?'badge-green':'badge-red'}">${dc.enable?'✅ فعّال':'معطّل'}</span>
    </div>
    <div class="toggle-row">
      <div><div class="toggle-info">تفعيل Discord</div></div>
      <label class="toggle"><input type="checkbox" ${dc.enable?'checked':''} onchange="setNotiDc('enable',this.checked)"/><span class="slider"></span></label>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Webhook URL</label>
      <input type="text" id="dcWebhook" class="form-control" value="${htmlEscape(dc.webhookUrl||'')}" placeholder="https://discord.com/api/webhooks/..."/>
    </div>
    <div class="form-group">
      <label class="form-label">اسم البوت في Discord (اختياري)</label>
      <input type="text" id="dcUsername" class="form-control" value="${htmlEscape(dc.username||'ZAO Bot')}" placeholder="ZAO Bot"/>
    </div>
    <div class="btn-row">
      <button class="btn btn-purple btn-sm" onclick="saveDc()">💾 حفظ</button>
      <button class="btn btn-outline btn-sm" onclick="testDc()">🧪 اختبار</button>
    </div>
    <div id="dcStatus" style="margin-top:8px;font-size:.82rem;min-height:22px"></div>
  </div>
</div>

<div class="card">
  <div class="card-header"><div class="card-title">📋 آخر الإشعارات</div><button class="btn btn-outline btn-sm" onclick="clearNotifLog()">🗑 مسح</button></div>
  <div id="notifLog" style="max-height:280px;overflow-y:auto">
    ${_notifRing.length ? [..._notifRing].reverse().slice(0,30).map(n=>{
      const cols={error:'var(--red)',warn:'var(--yellow)',info:'var(--accent)'};
      const t=new Date(n.ts).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return `<div style="padding:8px;border-bottom:1px solid var(--border);font-size:.8rem;display:flex;gap:8px;align-items:flex-start">
        <span style="color:${cols[n.level]||cols.info};font-weight:700;white-space:nowrap">${n.level.toUpperCase()}</span>
        <span style="color:var(--text3);white-space:nowrap">${t}</span>
        <span style="color:var(--text2)">${htmlEscape(n.msg)}</span>
      </div>`;
    }).join('') : '<div style="text-align:center;padding:24px;color:var(--text3)">لا توجد إشعارات مسجّلة</div>'}
  </div>
</div>

<script>
async function setNoti(key,val){
  const r=await api('/api/notifications/settings',{section:'root',key,value:val});
  if(r.ok)showToast('✅ تم','success');else showToast('❌ '+(r.error||'فشل'),'error');
}
async function setNotiTg(key,val){
  const r=await api('/api/notifications/settings',{section:'telegram',key,value:val});
  if(r.ok)showToast('✅ تم','success');else showToast('❌ '+(r.error||'فشل'),'error');
}
async function setNotiDc(key,val){
  const r=await api('/api/notifications/settings',{section:'discord',key,value:val});
  if(r.ok)showToast('✅ تم','success');else showToast('❌ '+(r.error||'فشل'),'error');
}
async function saveTg(){
  const token=document.getElementById('tgToken').value.trim();
  const chatId=document.getElementById('tgChatId').value.trim();
  const st=document.getElementById('tgStatus');
  const r=await api('/api/notifications/telegram',{botToken:token,chatId});
  if(r.ok){st.innerHTML='<span style="color:var(--green)">✅ تم الحفظ</span>';showToast('✅ تم حفظ Telegram','success')}
  else{st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>'}
}
async function testTg(){
  const st=document.getElementById('tgStatus');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الاختبار...</span>';
  const r=await api('/api/notifications/test',{channel:'telegram'});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ تم إرسال رسالة الاختبار</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل — تحقق من Token و Chat ID')+'</span>';
}
async function saveDc(){
  const webhook=document.getElementById('dcWebhook').value.trim();
  const username=document.getElementById('dcUsername').value.trim()||'ZAO Bot';
  const st=document.getElementById('dcStatus');
  const r=await api('/api/notifications/discord',{webhookUrl:webhook,username});
  if(r.ok){st.innerHTML='<span style="color:var(--green)">✅ تم الحفظ</span>';showToast('✅ تم حفظ Discord','success')}
  else{st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>'}
}
async function testDc(){
  const st=document.getElementById('dcStatus');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الاختبار...</span>';
  const r=await api('/api/notifications/test',{channel:'discord'});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ تم إرسال رسالة الاختبار</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل — تحقق من Webhook URL')+'</span>';
}
async function clearNotifLog(){
  await fetch('/api/notifications/clear',{method:'POST'});
  document.getElementById('notifLog').innerHTML='<div style="text-align:center;padding:24px;color:var(--text3)">تم المسح</div>';
}
</script>`;
    res.send(layout('الإشعارات', body, 'notifications', pageOpts()));
  });

  // ─── CRASHES TAB ─────────────────────────────────────────────────────────────
  app.get('/crashes', auth, (req,res) => {
    let crashes = { signatures: [] };
    try { crashes = JSON.parse(fs.readFileSync(path.join(ROOT, 'ZAO-ENGINE', 'crashFingerprints.json'), 'utf8')); } catch(_) {}
    const sigs = Array.isArray(crashes.signatures) ? crashes.signatures : [];
    const fmtDate = ts => ts ? new Date(ts).toLocaleString('ar-EG') : '—';
    const rows = sigs.map(s => `
      <tr>
        <td style="font-size:.75rem;font-family:monospace;color:var(--accent);max-width:160px;overflow:hidden;text-overflow:ellipsis">${htmlEscape(s.errorType||'—')}</td>
        <td style="font-size:.78rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;color:var(--text2)">${htmlEscape((s.errorMsg||'').slice(0,80))}</td>
        <td style="text-align:center"><span class="badge badge-red">${s.count||0}</span></td>
        <td style="font-size:.76rem;color:var(--text3)">${fmtDate(s.firstSeen)}</td>
        <td style="font-size:.76rem;color:var(--text3)">${fmtDate(s.lastSeen)}</td>
        <td style="font-size:.74rem;font-family:monospace;color:var(--text3)">${htmlEscape((s.topFrame||'—').slice(0,60))}</td>
        <td><button class="btn btn-outline btn-sm" onclick="showSnippet(${sigs.indexOf(s)})">📋</button></td>
      </tr>`).join('');

    const body = `
<div class="page-header">
  <div class="page-title">💥 الأعطال والأخطاء</div>
  <div class="page-sub">سجل البصمات الفريدة للأعطال — مُحدَّث تلقائياً من crashFingerprinter</div>
</div>
<div class="card">
  <div class="card-header">
    <div class="card-title">📊 ${sigs.length} بصمة عطل فريدة</div>
    <button class="btn btn-outline btn-sm" onclick="location.reload()">🔄 تحديث</button>
  </div>
  ${sigs.length ? `<div class="table-wrap"><table class="table"><thead><tr>
    <th>نوع الخطأ</th><th>الرسالة</th><th>عدد</th><th>أول ظهور</th><th>آخر ظهور</th><th>الإطار</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table></div>` :
  '<div style="text-align:center;padding:40px;color:var(--text3)">✅ لا توجد أعطال مسجّلة</div>'}
</div>

<!-- Snippet Modal -->
<div id="crashModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.88);backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(700px,95vw);max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <div style="font-weight:700" id="crashModalTitle">سجل الخطأ</div>
      <button onclick="closeCrashModal()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:1.1rem">✕</button>
    </div>
    <pre id="crashModalBody" style="overflow:auto;flex:1;padding:16px;font-size:.78rem;font-family:monospace;color:var(--text2);white-space:pre-wrap;line-height:1.6"></pre>
  </div>
</div>

<script>
const _crashData=${JSON.stringify(sigs.map(s=>({key:s.key,snippet:s.snippet||[]})))};
function showSnippet(idx){
  const d=_crashData[idx];if(!d)return;
  document.getElementById('crashModalTitle').textContent='\\uD83D\\uDCCB '+d.key;
  document.getElementById('crashModalBody').textContent=(d.snippet||[]).join('\\n')||'لا توجد بيانات';
  document.getElementById('crashModal').style.display='flex';
}
function closeCrashModal(){document.getElementById('crashModal').style.display='none';}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeCrashModal();});
</script>`;
    res.send(layout('الأعطال', body, 'crashes', pageOpts()));
  });

  // ─── FRIENDS TAB ─────────────────────────────────────────────────────────────
  app.get('/friends', auth, (req,res) => {
    const body = `
<div class="page-header">
  <div class="page-title">👥 إدارة الأصدقاء</div>
  <div class="page-sub">إرسال وقبول وإزالة طلبات الصداقة — تحكم كامل من اللوحة</div>
</div>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-bottom:14px">

  <!-- طلبات الصداقة -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">📩 طلبات الصداقة المعلّقة</div>
      <button class="btn btn-outline btn-sm" onclick="loadRequests()">🔄</button>
    </div>
    <div id="req-list" style="font-size:.83rem;color:var(--text3);padding:12px 0">⏳ جارٍ التحميل...</div>
  </div>

  <!-- إرسال طلب صداقة -->
  <div class="card">
    <div class="card-header"><div class="card-title">➕ إرسال طلب صداقة</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <input id="send-uid" class="form-control" placeholder="UID الشخص (أرقام فقط)" type="text" inputmode="numeric"/>
      <button class="btn btn-primary" onclick="sendFriendReq()">📤 إرسال الطلب</button>
      <div id="send-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

  <!-- اقتراحات -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">💡 أشخاص قد تعرفهم</div>
      <button class="btn btn-outline btn-sm" onclick="loadSuggestions()">🔄</button>
    </div>
    <div id="sugg-list" style="font-size:.83rem;color:var(--text3);padding:12px 0">⏳ جارٍ التحميل...</div>
  </div>

  <!-- قائمة الأصدقاء -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">👤 قائمة الأصدقاء</div>
      <button class="btn btn-outline btn-sm" onclick="loadFriends()">🔄</button>
    </div>
    <div id="friends-list" style="font-size:.83rem;color:var(--text3);padding:12px 0">انقر 🔄 للتحميل</div>
  </div>

</div>

<!-- Accept/Remove modal -->
<div id="frModal" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.85);backdrop-filter:blur(8px);align-items:center;justify-content:center">
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:min(420px,95vw);padding:24px">
    <div style="font-weight:700;margin-bottom:12px" id="frModal-title">تأكيد العملية</div>
    <div id="frModal-body" style="font-size:.88rem;color:var(--text2);margin-bottom:16px"></div>
    <div class="btn-row">
      <button id="frModal-confirm" class="btn btn-primary">تأكيد</button>
      <button class="btn btn-outline" onclick="closeFrModal()">إلغاء</button>
    </div>
    <div id="frModal-status" style="margin-top:10px;font-size:.82rem;min-height:18px"></div>
  </div>
</div>

<script>
let _frModalCb = null;

function openFrModal(title, body, cb) {
  document.getElementById('frModal-title').textContent = title;
  document.getElementById('frModal-body').textContent  = body;
  document.getElementById('frModal-status').innerHTML  = '';
  document.getElementById('frModal-confirm').onclick   = cb;
  document.getElementById('frModal').style.display     = 'flex';
}
function closeFrModal() { document.getElementById('frModal').style.display = 'none'; }

async function loadRequests() {
  const el = document.getElementById('req-list');
  el.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ التحميل...</span>';
  const r = await fetch('/api/friends/requests').then(x=>x.json()).catch(()=>({ok:false}));
  if (!r.ok) { el.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'خطأ') + '</span>'; return; }
  if (!r.requests?.length) { el.innerHTML = '<span style="color:var(--text3)">📭 لا توجد طلبات</span>'; return; }
  el.innerHTML = r.requests.map(req => \`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600;color:var(--text)">\${htmlEsc(req.name||'—')}</div>
        <div style="font-size:.76rem;color:var(--text3)">\${htmlEsc(req.userID||'')}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" style="color:var(--green)" onclick="acceptReq('\${htmlEsc(req.userID)}','\${htmlEsc(req.name||req.userID)}')">✅ قبول</button>
        <button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="rejectReq('\${htmlEsc(req.userID)}','\${htmlEsc(req.name||req.userID)}')">🚫 رفض</button>
      </div>
    </div>\`).join('');
}

async function acceptReq(uid, name) {
  openFrModal('قبول طلب صداقة', 'هل تريد قبول طلب صداقة: ' + name + ' (' + uid + ')?', async () => {
    const st = document.getElementById('frModal-status');
    st.innerHTML = '⏳ جارٍ القبول...';
    const r = await api('/api/friends/accept', { identifier: uid });
    if (r.ok) { st.innerHTML = '<span style="color:var(--green)">✅ تم القبول</span>'; showToast('تم القبول ✅','success'); setTimeout(()=>{closeFrModal();loadRequests();},1200); }
    else st.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'فشل') + '</span>';
  });
}

async function rejectReq(uid, name) {
  openFrModal('رفض طلب صداقة', 'هل تريد رفض طلب صداقة: ' + name + ' (' + uid + ')?', async () => {
    const st = document.getElementById('frModal-status');
    st.innerHTML = '⏳ جارٍ الرفض...';
    const r = await api('/api/friends/reject', { identifier: uid });
    if (r.ok) { st.innerHTML = '<span style="color:var(--green)">✅ تم الرفض</span>'; showToast('تم الرفض ✅','success'); setTimeout(()=>{closeFrModal();loadRequests();},1200); }
    else st.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'فشل') + '</span>';
  });
}

async function sendFriendReq() {
  const uid = document.getElementById('send-uid').value.trim();
  const st  = document.getElementById('send-status');
  if (!uid || !/^\\d+$/.test(uid)) { st.innerHTML='<span style="color:var(--red)">⚠️ أدخل UID صحيح</span>'; return; }
  st.innerHTML = '⏳ جارٍ الإرسال...';
  const r = await api('/api/friends/send', { userID: uid });
  if (r.ok) { st.innerHTML='<span style="color:var(--green)">✅ تم إرسال الطلب</span>'; showToast('تم الإرسال ✅','success'); }
  else st.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'فشل') + '</span>';
}

async function loadSuggestions() {
  const el = document.getElementById('sugg-list');
  el.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ التحميل...</span>';
  const r = await fetch('/api/friends/suggestions').then(x=>x.json()).catch(()=>({ok:false}));
  if (!r.ok) { el.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'خطأ') + '</span>'; return; }
  if (!r.suggestions?.length) { el.innerHTML = '<span style="color:var(--text3)">📭 لا توجد اقتراحات</span>'; return; }
  el.innerHTML = r.suggestions.slice(0,15).map(p => \`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600;color:var(--text)">\${htmlEsc(p.name||'—')}</div>
        <div style="font-size:.76rem;color:var(--text3)">\${htmlEsc(p.userID||'')} \${p.socialContext?' · '+htmlEsc(p.socialContext):''}</div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="doSendReq('\${htmlEsc(p.userID)}')">➕ أضف</button>
    </div>\`).join('');
}

async function doSendReq(uid) {
  const r = await api('/api/friends/send', { userID: uid });
  if (r.ok) showToast('تم إرسال الطلب ✅','success');
  else showToast('❌ ' + (r.error||'فشل'),'error');
}

async function loadFriends() {
  const el = document.getElementById('friends-list');
  el.innerHTML = '<span style="color:var(--text3)">⏳ جارٍ التحميل...</span>';
  const r = await fetch('/api/friends/list').then(x=>x.json()).catch(()=>({ok:false}));
  if (!r.ok) { el.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'خطأ') + '</span>'; return; }
  if (!r.friends?.length) { el.innerHTML = '<span style="color:var(--text3)">📭 قائمة الأصدقاء فارغة</span>'; return; }
  el.innerHTML = '<div style="color:var(--text2);margin-bottom:8px">إجمالي: ' + r.count + ' صديق</div>' +
    r.friends.slice(0,25).map(f => \`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:600;color:var(--text)">\${htmlEsc(f.name||'—')}</div>
        <div style="font-size:.76rem;color:var(--text3)">\${htmlEsc(f.userID||'')}</div>
      </div>
      <button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="removeFriend('\${htmlEsc(f.userID)}','\${htmlEsc(f.name||f.userID)}')">🗑️</button>
    </div>\`).join('');
}

async function removeFriend(uid, name) {
  openFrModal('إزالة صديق', 'هل تريد إزالة: ' + name + ' (' + uid + ') من قائمة الأصدقاء؟', async () => {
    const st = document.getElementById('frModal-status');
    st.innerHTML = '⏳ جارٍ الإزالة...';
    const r = await api('/api/friends/remove', { userID: uid });
    if (r.ok) { st.innerHTML = '<span style="color:var(--green)">✅ تمت الإزالة</span>'; showToast('تمت الإزالة ✅','success'); setTimeout(()=>{closeFrModal();loadFriends();},1200); }
    else st.innerHTML = '<span style="color:var(--red)">❌ ' + (r.error||'فشل') + '</span>';
  });
}

function htmlEsc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeFrModal();});
loadRequests();
loadSuggestions();
</script>`;
    res.send(layout('الأصدقاء', body, 'friends', pageOpts()));
  });

  // ─── SOCIAL TAB ──────────────────────────────────────────────────────────────
  app.get('/social', auth, (req,res) => {
    const body = `
<div class="page-header">
  <div class="page-title">🌐 الاجتماعي</div>
  <div class="page-sub">إدارة القصص، التعليقات، المتابعة، وتثبيت الرسائل</div>
</div>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">

  <!-- إنشاء قصة -->
  <div class="card">
    <div class="card-header"><div class="card-title">📸 نشر قصة نصية</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <textarea id="story-text" class="form-control" rows="3" placeholder="نص القصة..."></textarea>
      <div style="display:flex;gap:8px">
        <select id="story-font" class="form-control" style="flex:1">
          <option value="classic">Classic</option>
          <option value="headline">Headline</option>
          <option value="fancy">Fancy</option>
          <option value="casual">Casual</option>
        </select>
        <select id="story-bg" class="form-control" style="flex:1">
          <option value="blue">أزرق</option>
          <option value="orange">برتقالي</option>
          <option value="green">أخضر</option>
          <option value="modern">عصري</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick="createStory()">📤 نشر القصة</button>
      <div id="story-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

  <!-- الرد على قصة -->
  <div class="card">
    <div class="card-header"><div class="card-title">💬 الرد على قصة</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <input id="react-story-id" class="form-control" placeholder="Story ID"/>
      <input id="react-msg" class="form-control" placeholder="رسالة أو ردّ فعل (❤️ 👍 😆 ...)"/>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="replyStory('msg')">💬 رد نصي</button>
        <button class="btn btn-outline" style="flex:1" onclick="replyStory('react')">❤️ تفاعل</button>
      </div>
      <div id="react-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

  <!-- تعليق على منشور -->
  <div class="card">
    <div class="card-header"><div class="card-title">🗨️ تعليق على منشور</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <input id="cmt-post-id" class="form-control" placeholder="Post ID"/>
      <textarea id="cmt-text" class="form-control" rows="2" placeholder="نص التعليق..."></textarea>
      <button class="btn btn-primary" onclick="postComment()">📝 نشر التعليق</button>
      <div id="cmt-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

  <!-- متابعة/إلغاء متابعة -->
  <div class="card">
    <div class="card-header"><div class="card-title">➕ متابعة / إلغاء متابعة</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <input id="follow-uid" class="form-control" placeholder="UID المستخدم"/>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="doFollow(true)">➕ متابعة</button>
        <button class="btn btn-outline" style="flex:1" onclick="doFollow(false)">➖ إلغاء</button>
      </div>
      <div id="follow-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

  <!-- تثبيت رسالة -->
  <div class="card">
    <div class="card-header"><div class="card-title">📌 تثبيت رسالة</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <input id="pin-thread" class="form-control" placeholder="Thread ID (المجموعة)"/>
      <input id="pin-msg" class="form-control" placeholder="Message ID"/>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="doPin('pin')">📌 تثبيت</button>
        <button class="btn btn-outline" style="flex:1" onclick="doPin('unpin')">📍 إلغاء</button>
      </div>
      <div id="pin-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

  <!-- إدارة مشرفي المجموعة -->
  <div class="card">
    <div class="card-header"><div class="card-title">👑 إدارة مشرفي المجموعة</div></div>
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <input id="gc-thread" class="form-control" placeholder="Thread ID (المجموعة)"/>
      <input id="gc-uid" class="form-control" placeholder="User ID"/>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="doGcRule('admin')">⬆️ ترقية</button>
        <button class="btn btn-outline" style="flex:1" onclick="doGcRule('unadmin')">⬇️ إزالة</button>
      </div>
      <div id="gc-status" style="font-size:.82rem;min-height:18px"></div>
    </div>
  </div>

</div>

<script>
async function createStory(){
  const text=document.getElementById('story-text').value.trim();
  const font=document.getElementById('story-font').value;
  const bg=document.getElementById('story-bg').value;
  const st=document.getElementById('story-status');
  if(!text){st.innerHTML='<span style="color:var(--red)">⚠️ أدخل نص القصة</span>';return;}
  st.innerHTML='⏳ جارٍ النشر...';
  const r=await api('/api/social/story-create',{message:text,font,background:bg});
  if(r.ok)st.innerHTML=\`<span style="color:var(--green)">✅ تم النشر — Story ID: \${r.storyID||'—'}</span>\`;
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}

async function replyStory(mode){
  const id=document.getElementById('react-story-id').value.trim();
  const msg=document.getElementById('react-msg').value.trim();
  const st=document.getElementById('react-status');
  if(!id||!msg){st.innerHTML='<span style="color:var(--red)">⚠️ أدخل ID والرسالة</span>';return;}
  st.innerHTML='⏳ جارٍ الإرسال...';
  const endpoint=mode==='react'?'/api/social/story-react':'/api/social/story-msg';
  const r=await api(endpoint,{storyID:id,message:msg,reaction:msg});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ تم</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}

async function postComment(){
  const postID=document.getElementById('cmt-post-id').value.trim();
  const message=document.getElementById('cmt-text').value.trim();
  const st=document.getElementById('cmt-status');
  if(!postID||!message){st.innerHTML='<span style="color:var(--red)">⚠️ أدخل Post ID والتعليق</span>';return;}
  st.innerHTML='⏳ جارٍ النشر...';
  const r=await api('/api/social/comment',{postID,message});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ تم النشر</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}

async function doFollow(shouldFollow){
  const uid=document.getElementById('follow-uid').value.trim();
  const st=document.getElementById('follow-status');
  if(!uid){st.innerHTML='<span style="color:var(--red)">⚠️ أدخل UID</span>';return;}
  st.innerHTML='⏳ جارٍ التنفيذ...';
  const r=await api('/api/social/follow',{userID:uid,shouldFollow});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ '+(shouldFollow?'تمت المتابعة':'تم الإلغاء')+'</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}

async function doPin(action){
  const threadID=document.getElementById('pin-thread').value.trim();
  const messageID=document.getElementById('pin-msg').value.trim();
  const st=document.getElementById('pin-status');
  if(!threadID||!messageID){st.innerHTML='<span style="color:var(--red)">⚠️ أدخل Thread ID وMessage ID</span>';return;}
  st.innerHTML='⏳ جارٍ التنفيذ...';
  const r=await api('/api/social/pin',{action,threadID,messageID});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ '+(action==='pin'?'تم التثبيت':'تم الإلغاء')+'</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}

async function doGcRule(action){
  const threadID=document.getElementById('gc-thread').value.trim();
  const userID=document.getElementById('gc-uid').value.trim();
  const st=document.getElementById('gc-status');
  if(!threadID||!userID){st.innerHTML='<span style="color:var(--red)">⚠️ أدخل Thread ID وUser ID</span>';return;}
  st.innerHTML='⏳ جارٍ التنفيذ...';
  const r=await api('/api/social/gcrule',{action,userID,threadID});
  if(r.ok)st.innerHTML='<span style="color:var(--green)">✅ '+(action==='admin'?'تمت الترقية':'تمت الإزالة')+'</span>';
  else st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';
}
</script>`;
    res.send(layout('الاجتماعي', body, 'social', pageOpts()));
  });

  // ─── PROTECTION STATUS TAB ───────────────────────────────────────────────────
  app.get('/protection', auth, (req,res) => {
    const cfg = readSettings();
    const body = `
<div class="page-header">
  <div class="page-title">🛡️ حالة الحماية الحية</div>
  <div class="page-sub">مراقبة لحظية لجميع أنظمة الأمان — يتحدث كل 5 ثوانٍ</div>
</div>

<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
  <div id="ps-status" style="font-size:.85rem;color:var(--text3)">⏳ جارٍ تحميل البيانات...</div>
  <label style="display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--text3);margin-right:auto;cursor:pointer">
    <input type="checkbox" id="ps-autorefresh" checked onchange="toggleAR(this.checked)" style="width:14px;height:14px"/>
    تحديث تلقائي كل 5 ثوان
  </label>
  <button class="btn btn-outline btn-sm" onclick="loadProtection()">🔄 تحديث يدوي</button>
</div>

<div id="ps-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px"></div>

<div class="card" style="margin-top:14px">
  <div class="card-header">
    <div class="card-title">🔍 تشخيص التداخلات في أنظمة الأمان</div>
  </div>
  <div style="font-size:.83rem;color:var(--text2);line-height:1.8">
    <div style="margin-bottom:8px;padding:10px;background:var(--bg3);border-radius:8px;border-right:3px solid var(--accent)">
      <strong style="color:var(--accent)">sendPipeline.js</strong> — المسار المركزي لكل رسالة صادرة. يُشغّل بالترتيب: EnhancedRateLimiter → SessionWarmupManager → humanTyping → outgoingThrottle → الإرسال الفعلي.
    </div>
    <div style="margin-bottom:8px;padding:10px;background:var(--bg3);border-radius:8px;border-right:3px solid var(--yellow)">
      <strong style="color:var(--yellow)">⚠️ تداخل محتمل</strong> — <code>EnhancedRateLimiter.wrapSendMessage()</code> يُغلّف api.sendMessage بشكل مباشر، بينما sendPipeline يستدعي نفس المحدِّد داخلياً. إذا استُخدِم الاثنان معاً، يُطبَّق تحديد الإرسال مرتين. sendPipeline هو المسار الرسمي الوحيد منذ ZAO.js v1.2.
    </div>
    <div style="padding:10px;background:var(--bg3);border-radius:8px;border-right:3px solid var(--green)">
      <strong style="color:var(--green)">✅ بدون تداخل</strong> — <code>stealthEngine</code> يعالج الرسائل الواردة فقط (لا تداخل مع الصادرة). <code>autoLockGuard</code> يُفعَّل قبل معالجة الأوامر (حارس المدخلات). <code>ZAOSecurityManager.preSendCheck</code> تم توحيده مع sendPipeline منذ v1.2.
    </div>
  </div>
</div>

<script>
let _arTimer=null;

function statusColor(v){
  if(v===true||v==='active'||v==='healthy'||v==='ok'||v==='enabled')return'var(--green)';
  if(v===false||v==='tripped'||v==='blocked'||v==='error')return'var(--red)';
  if(v==='warmup'||v==='pacing'||v==='throttled'||v==='limited')return'var(--yellow)';
  return'var(--accent)';
}

function badge(label,color){
  return \`<span style="background:\${color}22;color:\${color};border:1px solid \${color}44;border-radius:5px;padding:2px 8px;font-size:.72rem;font-weight:700">\${label}</span>\`;
}

function makeCard(title,icon,rows,extraBadge){
  const rowsHtml=rows.map(([k,v,hint])=>\`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:.8rem;color:var(--text3)">\${k}\${hint?\`<br><span style='font-size:.7rem;color:var(--text3)'>\${hint}</span>\`:''}</span>
      <span style="font-size:.82rem;color:var(--text2);font-weight:600">\${typeof v==='boolean'?badge(v?'مفعّل':'معطّل',v?'var(--green)':'var(--red)'):String(v??'—')}</span>
    </div>\`).join('');
  return \`<div class="card">
    <div class="card-header">
      <div class="card-title">\${icon} \${title}</div>
      \${extraBadge||''}
    </div>
    <div style="padding:0 4px">\${rowsHtml||'<div style="color:var(--text3);font-size:.8rem;padding:12px 0">لا توجد بيانات</div>'}</div>
  </div>\`;
}

function fmt(v,unit){if(v===undefined||v===null)return'—';if(unit==='ms')return(v/1000).toFixed(1)+'s';if(unit==='ts')return v?new Date(v).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';return String(v);}

function renderProtection(d){
  const cards=[];

  // Rate Limiter
  const rl=d.rateLimit||{};
  cards.push(makeCard('حد الإرسال (Rate Limiter)','📊',[
    ['حالة النافذة',rl.windowCount!==undefined?\`\${rl.windowCount}/\${rl.windowLimit}\`:'—'],
    ['مرفوضة (محظورة)',fmt(rl.rejectedCount)],
    ['وقت إعادة الضبط',fmt(rl.resetAt,'ts')],
    ['مفعّل',rl.enabled!==undefined?rl.enabled:true],
  ],badge(rl.throttled?'محدود':'عادي',rl.throttled?'var(--yellow)':'var(--green)')));

  // Request Pacing
  const rp=d.requestPacing||{};
  cards.push(makeCard('ضبط الإيقاع','⏱️',[
    ['طابور الانتظار',fmt(rp.queueLength)],
    ['طلبات/دقيقة',fmt(rp.requestsPerMin)],
    ['متوسط التأخير',fmt(rp.avgDelayMs,'ms')],
    ['تأخير مُضاف',fmt(rp.totalPacingMs,'ms')],
  ],badge(rp.active?'نشط':'خامل',rp.active?'var(--green)':'var(--text3)')));

  // Send Pipeline
  const sp=d.sendPipeline||{};
  cards.push(makeCard('مسار الإرسال (Pipeline)','🔀',[
    ['إجمالي المُرسَل',fmt(sp.totalSent)],
    ['المحظور بالتسخين',fmt(sp.warmupBlocked)],
    ['المحظور بالتحديد',fmt(sp.rateLimitBlocked)],
    ['آخر إرسال',fmt(sp.lastSentAt,'ts')],
  ],badge('نشط','var(--green)')));

  // Anti Suspension
  const as=d.antiSuspension||{};
  const cb=as.circuitBreaker||{};
  cards.push(makeCard('قاطع الدائرة','⚡',[
    ['حالة القاطع',cb.tripped?'🔴 مفعّل (محظور)':'🟢 طبيعي'],
    ['إشارات تعليق',fmt(cb.signalCount)],
    ['يُعاد بعد',cb.tripped&&cb.remainingMs?\`\${Math.ceil(cb.remainingMs/1000)}s\`:'—'],
    ['رسائل اليوم',fmt(as.dailyStats?.sent)],
  ],badge(cb.tripped?'مُفعَّل':'سليم',cb.tripped?'var(--red)':'var(--green)')));

  // MQTT Health
  const mh=d.mqttHealth||{};
  cards.push(makeCard('صحة MQTT','📡',[
    ['إعادات التشغيل',fmt(mh.restartCount)],
    ['آخر نشاط MQTT',fmt(mh.lastMqttOnlyActivity,'ts')],
    ['Backoff الحالي',fmt(mh.backoffMs,'ms')],
    ['أقصى إعادات',fmt(mh.maxRestarts)],
  ],badge(mh.restartCount>0?'إعادات':'طبيعي',mh.restartCount>0?'var(--yellow)':'var(--green)')));

  // Outgoing Throttle
  const ot=d.outgoingThrottle||{};
  cards.push(makeCard('خانق الإرسال','🚦',[
    ['متوسط فاصل/thread',fmt(ot.avgIntervalMs,'ms')],
    ['طابور نشط',fmt(ot.activeThreads)],
    ['رسائل مؤجلة',fmt(ot.deferredCount)],
  ],badge(ot.active?'نشط':'خامل',ot.active?'var(--green)':'var(--text3)')));

  // Stealth Engine
  const se=d.stealthEngine||{};
  cards.push(makeCard('محرك التخفي','🕵️',[
    ['وضع الليل',se.nightMode?'🌙 نشط':'☀️ غير نشط'],
    ['اندفاع نشط',se.burstActive],
    ['رسائل واردة/دقيقة',fmt(se.incomingPerMin)],
  ],badge(se.enabled?'مفعّل':'معطّل',se.enabled?'var(--green)':'var(--red)')));

  // Error Summary
  const er=d.errorSummary||{};
  cards.push(makeCard('ملخص الأخطاء','🔴',[
    ['آخر ساعة',fmt(er.lastHour)],
    ['إجمالي اليوم',fmt(er.today)],
    ['أكثر خطأ',er.topError||'—'],
  ],badge((er.lastHour||0)>10?'تحذير':'جيد',(er.lastHour||0)>10?'var(--red)':'var(--green)')));

  document.getElementById('ps-grid').innerHTML=cards.join('');
}

async function loadProtection(){
  const st=document.getElementById('ps-status');
  try{
    const r=await fetch('/api/protection/status');
    if(r.status===503){
      st.innerHTML='🔴 البوت غير متصل — لا يمكن جلب بيانات الحماية';
      document.getElementById('ps-grid').innerHTML='<div class="card" style="grid-column:1/-1;text-align:center;padding:32px;color:var(--red)">⚠️ البوت غير متصل. شغّل البوت أولاً.</div>';
      return;
    }
    const d=await r.json();
    renderProtection(d);
    st.innerHTML='✅ آخر تحديث: '+new Date().toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }catch(e){
    st.innerHTML='❌ خطأ في الاتصال: '+e.message;
  }
}

function toggleAR(on){
  clearInterval(_arTimer);
  if(on)_arTimer=setInterval(loadProtection,30000);
}

loadProtection();
_arTimer=setInterval(loadProtection,30000);
</script>`;
    res.send(layout('الحماية', body, 'protection', pageOpts()));
  });

  // ─── Session Guard Tab ───────────────────────────────────────────────────────
  app.get('/session-guard', auth, (req, res) => {
    const body = `
<div class="page-header">
  <div class="page-title">🔐 حارس الجلسة</div>
  <div class="page-sub">مراقبة لحظية لأنظمة حفظ الجلسة — لقطات تلقائية + فحص سلامة الكوكيز + خطاف ما قبل إعادة الدخول</div>
</div>

<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
  <div id="sg-ts" style="font-size:.82rem;color:var(--text3)">⏳ جارٍ تحميل...</div>
  <div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn btn-outline btn-sm" onclick="sgLoad()">🔄 تحديث</button>
    <button class="btn btn-sm" id="sg-snap-btn" onclick="sgSnapshot()" style="background:var(--accent);color:#fff;border:none">📸 لقطة الآن</button>
    <button class="btn btn-outline btn-sm" onclick="sgCheck()">🔍 فحص السلامة</button>
  </div>
</div>

<!-- Status cards row -->
<div id="sg-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:14px"></div>

<!-- Snapshot history table -->
<div class="card">
  <div class="card-header">
    <div class="card-title">📁 سجل اللقطات المحفوظة</div>
    <div id="sg-snap-count" style="font-size:.78rem;color:var(--text3)"></div>
  </div>
  <div id="sg-snap-list" style="font-size:.82rem"></div>
</div>

<!-- Legend -->
<div class="card" style="margin-top:14px">
  <div class="card-header"><div class="card-title">📖 كيف يعمل حارس الجلسة</div></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;font-size:.82rem;color:var(--text2)">
    <div style="padding:12px;background:var(--bg3);border-radius:10px;border-right:3px solid var(--accent)">
      <div style="color:var(--accent);font-weight:700;margin-bottom:6px">🔵 الطبقة 1 — لقطات تلقائية</div>
      كل 30 دقيقة يحفظ نسخة من AppState في مجلد backups/ (حد أقصى 7 نسخ). إذا تلفت الجلسة، يمكن استعادتها منها دون الحاجة لتسجيل دخول جديد.
    </div>
    <div style="padding:12px;background:var(--bg3);border-radius:10px;border-right:3px solid var(--green)">
      <div style="color:var(--green);font-weight:700;margin-bottom:6px">🟢 الطبقة 2 — فحص سلامة الكوكيز</div>
      كل 20 دقيقة يتحقق من وجود c_user و xs و datr. إذا غابت أي منها يُنبّه الأدمن فوراً عبر ماسنجر ويأخذ لقطة احتياطية.
    </div>
    <div style="padding:12px;background:var(--bg3);border-radius:10px;border-right:3px solid var(--yellow)">
      <div style="color:var(--yellow);font-weight:700;margin-bottom:6px">🟡 الطبقة 3 — خطاف ما قبل الدخول</div>
      قبل أي محاولة إعادة تسجيل دخول، يُنفَّذ الخطاف تلقائياً لحفظ النسخة الحالية من الجلسة — حتى لو كانت ستُستبدَل. تسجيل الدخول هو أخطر عملية على حساب فيسبوك.
    </div>
  </div>
</div>

<script>
let _sgTimer = null;

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('ar-EG') + ' ' + d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
}
function fmtSec(s) {
  if (s === null || s === undefined) return '—';
  if (s < 60) return s + ' ث';
  if (s < 3600) return Math.floor(s/60) + ' د ' + (s%60) + ' ث';
  return Math.floor(s/3600) + ' س ' + Math.floor((s%3600)/60) + ' د';
}
function badge(label, color) {
  return \`<span style="background:\${color}22;color:\${color};border:1px solid \${color}44;border-radius:5px;padding:2px 9px;font-size:.71rem;font-weight:700">\${label}</span>\`;
}
function row(k, v) {
  return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
    <span style="font-size:.8rem;color:var(--text3)">\${k}</span>
    <span style="font-size:.82rem;color:var(--text2);font-weight:600">\${v ?? '—'}</span>
  </div>\`;
}
function card(title, icon, rows, badge2) {
  return \`<div class="card">
    <div class="card-header">
      <div class="card-title">\${icon} \${title}</div>
      \${badge2 || ''}
    </div>
    <div style="padding:0 4px">\${rows.join('')}</div>
  </div>\`;
}

function renderCards(d) {
  const cards = [];

  // Running status
  const runBadge = d.running
    ? badge('يعمل', 'var(--green)')
    : badge('متوقف', 'var(--red)');
  cards.push(card('الحالة العامة', '⚙️', [
    row('الحالة',       d.running ? '✅ نشط' : '❌ متوقف'),
    row('ملف الجلسة',  d.stateFile || '—'),
    row('خطاف ما قبل الدخول', d.preReloginHookActive ? '✅ مُسجَّل' : '⚠️ غير مُسجَّل'),
  ], runBadge));

  // Layer 1 — Snapshots
  const l1Ok = (d.snapshotsTaken || 0) > 0;
  cards.push(card('الطبقة 1 — اللقطات التلقائية', '🔵', [
    row('الفترة الزمنية',   d.snapshotIntervalMin + ' دقيقة'),
    row('اللقطات المحفوظة', (d.snapshotsTaken || 0) + ' من ' + d.snapshotKeep + ' حد أقصى'),
    row('آخر لقطة',        fmtTs(d.lastSnapshotTs)),
    row('اللقطة التالية خلال', fmtSec(d.nextSnapshotIn)),
  ], badge(l1Ok ? 'نشطة' : 'لم تُنفَّذ بعد', l1Ok ? 'var(--green)' : 'var(--yellow)')));

  // Layer 2 — Integrity
  const intOk = d.integrityOk === true;
  const intBadge = d.integrityOk === null
    ? badge('لم يُفحص بعد', 'var(--text3)')
    : badge(intOk ? 'سليمة' : 'تنبيه!', intOk ? 'var(--green)' : 'var(--red)');
  cards.push(card('الطبقة 2 — فحص سلامة الكوكيز', intOk ? '🟢' : (d.integrityOk === null ? '⚪' : '🔴'), [
    row('الفترة الزمنية',  d.integrityIntervalMin + ' دقيقة'),
    row('آخر فحص',        fmtTs(d.lastIntegrityTs)),
    row('الفحص التالي خلال', fmtSec(d.nextIntegrityIn)),
    row('نتيجة الفحص',    d.integrityMsg || '—'),
  ], intBadge));

  document.getElementById('sg-cards').innerHTML = cards.join('');
}

function renderSnapshots(snaps) {
  const el = document.getElementById('sg-snap-list');
  const ct = document.getElementById('sg-snap-count');
  if (!snaps || !snaps.length) {
    el.innerHTML = '<div style="color:var(--text3);padding:16px 0;text-align:center">لا توجد لقطات محفوظة بعد</div>';
    ct.textContent = '';
    return;
  }
  ct.textContent = snaps.length + ' لقطة';
  const sorted = [...snaps].sort((a,b) => b.mtime - a.mtime);
  el.innerHTML = \`<table style="width:100%;border-collapse:collapse">
    <thead><tr style="font-size:.75rem;color:var(--text3)">
      <th style="text-align:right;padding:6px 4px;border-bottom:1px solid var(--border)">اسم الملف</th>
      <th style="text-align:center;padding:6px 4px;border-bottom:1px solid var(--border)">التاريخ</th>
      <th style="text-align:center;padding:6px 4px;border-bottom:1px solid var(--border)">الحجم</th>
    </tr></thead>
    <tbody>\${sorted.map((s,i) => \`
      <tr style="background:\${i%2?'var(--bg3)':'transparent'}">
        <td style="padding:7px 4px;font-size:.78rem;color:var(--text2);font-family:monospace">\${s.file}</td>
        <td style="padding:7px 4px;font-size:.78rem;color:var(--text3);text-align:center">\${fmtDate(s.mtime)}</td>
        <td style="padding:7px 4px;font-size:.78rem;color:var(--accent);text-align:center">\${s.sizeKb} KB</td>
      </tr>\`).join('')}
    </tbody>
  </table>\`;
}

async function sgLoad() {
  try {
    const r = await fetch('/api/session-guard/status');
    const d = await r.json();
    document.getElementById('sg-ts').textContent = '🕒 آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
    renderCards(d);
    renderSnapshots(d.snapshots || []);
  } catch(e) {
    document.getElementById('sg-ts').textContent = '❌ فشل التحميل';
  }
}

async function sgSnapshot() {
  const btn = document.getElementById('sg-snap-btn');
  btn.disabled = true;
  btn.textContent = '⏳ جارٍ الحفظ...';
  try {
    const r = await fetch('/api/session-guard/snapshot', { method:'POST' });
    const d = await r.json();
    btn.textContent = d.ok ? '✅ تم الحفظ' : '❌ فشل';
    setTimeout(() => { btn.disabled=false; btn.textContent='📸 لقطة الآن'; }, 2500);
    await sgLoad();
  } catch(_) {
    btn.disabled=false;
    btn.textContent='📸 لقطة الآن';
  }
}

async function sgCheck() {
  document.getElementById('sg-ts').textContent = '⏳ جارٍ فحص السلامة...';
  try {
    await fetch('/api/session-guard/check', { method:'POST' });
    await sgLoad();
  } catch(_) {
    document.getElementById('sg-ts').textContent = '❌ فشل الفحص';
  }
}

sgLoad();
_sgTimer = setInterval(sgLoad, 30000);
window.addEventListener('beforeunload', () => clearInterval(_sgTimer));
</script>`;
    res.send(layout('حارس الجلسة', body, 'session-guard', pageOpts()));
  });

  app.get('/api/session-guard/status', auth, (req, res) => {
    try {
      const sg = require('../ZAO-ENGINE/sessionGuard');
      return res.json(sg.getStatus());
    } catch (e) {
      return res.json({ running: false, error: e.message });
    }
  });

  app.post('/api/session-guard/snapshot', auth, async (req, res) => {
    try {
      const sg = require('../ZAO-ENGINE/sessionGuard');
      sg.flush();
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/session-guard/check', auth, (req, res) => {
    try {
      const sg = require('../ZAO-ENGINE/sessionGuard');
      const status = sg.getStatus();
      // Trigger a fresh integrity check via flush (runs both snapshot + check)
      sg.flush();
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ─── Load DevHub ─────────────────────────────────────────────────────────────
  try {
    const devhub = require('./zao-devhub');
    devhub.register(app, auth, { ROOT, CMDS_PATH, SETTINGS_PATH, DATA_DIR, proxyToBot, readSettings, saveSettings, isBotOnline, pageOpts, layout });
  } catch(e) {
    app.get('/devhub', auth, (req,res) => res.send(layout('مركز التطوير', `<div class="page-header"><div class="page-title">🤖 مركز التطوير</div></div><div class="card"><div class="card-title" style="color:var(--red)">⚠️ DevHub غير متاح</div><pre style="color:var(--text3);margin-top:10px;font-size:.8rem">${htmlEscape(e.message)}</pre></div>`, 'devhub', pageOpts())));
    app.get('/github-files', auth, (req,res) => res.redirect('/devhub'));
  }

  // ─── AI USERS ─────────────────────────────────────────────────────────────────
  const AI_USERS_FILE = path.join(DATA_DIR, 'ai-users.json');
  function readAiUsers() {
    try { const d = JSON.parse(fs.readFileSync(AI_USERS_FILE,'utf8')); return Array.isArray(d.users) ? d : {_note:'',users:[]}; }
    catch(_) { return {_note:'',users:[]}; }
  }
  function saveAiUsers(data) {
    const tmp = AI_USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data,null,2),'utf8');
    fs.renameSync(tmp, AI_USERS_FILE);
  }

  app.get('/ai-users', auth, (req,res) => {
    const data  = readAiUsers();
    const users = data.users || [];

    const rows = users.map((u,i) => {
      const ids = (u.ids||[]).filter(Boolean);
      return `
      <tr data-idx="${i}">
        <td style="font-weight:600;color:var(--accent)">${htmlEscape(u.name||'')}</td>
        <td style="color:var(--text2)">${htmlEscape(u.role||'—')}</td>
        <td>
          ${ids.map(id=>`<span class="id-chip">${htmlEscape(id)}<button class="chip-del" onclick="removeId(${i},'${htmlEscape(id)}')" title="حذف">×</button></span>`).join('')}
          <button class="btn btn-outline btn-xs" style="margin-top:4px" onclick="openAddId(${i})">+ ID</button>
        </td>
        <td style="font-size:.78rem;color:var(--text3);max-width:300px;white-space:pre-wrap">${htmlEscape(u.character||'—')}</td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn btn-outline btn-xs" onclick="openEdit(${i})">✏️</button>
            <button class="btn btn-xs" style="background:var(--red-bg);color:var(--red);border:1px solid var(--red)" onclick="deleteUser(${i})">🗑️</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    const body = `
<div class="page-header">
  <div class="page-title">👤 شخصيات AI</div>
  <div class="page-sub">قاعدة بيانات الشخصيات المعروفة للذكاء الاصطناعي (data/ai-users.json)</div>
</div>

<style>
.id-chip{display:inline-flex;align-items:center;gap:4px;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);border-radius:20px;padding:2px 10px;font-size:.75rem;color:var(--accent);margin:2px}
.chip-del{background:none;border:none;color:var(--text3);cursor:pointer;font-size:.9rem;line-height:1;padding:0 2px}
.chip-del:hover{color:var(--red)}
.btn-xs{font-size:.72rem;padding:3px 8px;border-radius:6px}
#aiTable td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
#aiTable th{padding:8px;text-align:right;color:var(--text3);font-size:.75rem;font-weight:600;border-bottom:1px solid var(--border2)}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-box{background:var(--bg3);border:1px solid var(--border2);border-radius:var(--radius-lg);padding:28px;width:min(500px,95vw);max-height:90vh;overflow-y:auto}
.modal-title{font-size:1.1rem;font-weight:700;margin-bottom:18px;color:var(--accent)}
</style>

<div class="card" style="margin-bottom:14px">
  <div class="card-header">
    <div class="card-title">🧑‍🤝‍🧑 الشخصيات المسجّلة (${users.length})</div>
    <button class="btn btn-primary btn-sm" onclick="openNew()">+ شخصية جديدة</button>
  </div>
  <div style="overflow-x:auto">
    <table id="aiTable" style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th>الاسم</th><th>الدور</th><th>IDs الفيسبوك</th><th>وصف الشخصية</th><th>إجراءات</th>
      </tr></thead>
      <tbody id="aiBody">${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text3)">لا توجد شخصيات مسجّلة</td></tr>'}</tbody>
    </table>
  </div>
</div>

<!-- Persist notice -->
<div class="card" style="border-color:rgba(255,193,7,.2);background:rgba(255,193,7,.04)">
  <div class="card-title" style="color:var(--yellow)">💡 استمرارية البيانات عبر النشر</div>
  <div style="font-size:.82rem;color:var(--text2);margin-top:8px;line-height:1.8">
    هذا الملف (<code>data/ai-users.json</code>) والملف <code>data/runtime-overrides.json</code> (قائمة الأدمن) يتم مسحهما عند كل نشر جديد في Railway ما لم تُفعّل <strong>Persistent Volume</strong>.<br>
    لتفعيله: Railway Dashboard → مشروعك → Service → Volumes → Add Volume → Mount Path: <code>/app/data</code><br>
    <strong>أو</strong> أضف متغير البيئة <code>ZAO_ADMIN_LIST</code> = قائمة IDs الأدمن مفصولة بفواصل لضمان بقاء قائمة الأدمن.
  </div>
</div>

<!-- Modal: New / Edit -->
<div class="modal-overlay" id="editModal">
  <div class="modal-box">
    <div class="modal-title" id="editModalTitle">شخصية جديدة</div>
    <input type="hidden" id="editIdx" value="-1"/>
    <div class="form-group" style="margin-bottom:12px">
      <label class="form-label">الاسم *</label>
      <input type="text" class="form-control" id="editName" placeholder="مثال: علي"/>
    </div>
    <div class="form-group" style="margin-bottom:12px">
      <label class="form-label">الدور</label>
      <input type="text" class="form-control" id="editRole" placeholder="مثال: مطور البوت"/>
    </div>
    <div class="form-group" style="margin-bottom:12px">
      <label class="form-label">وصف الشخصية</label>
      <textarea class="form-control" id="editChar" rows="4" placeholder="صف شخصية هذا الشخص كما تريد البوت أن يتعامل معه..."></textarea>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" onclick="saveUser()">💾 حفظ</button>
      <button class="btn btn-outline" onclick="closeModal('editModal')">إلغاء</button>
    </div>
  </div>
</div>

<!-- Modal: Add ID -->
<div class="modal-overlay" id="addIdModal">
  <div class="modal-box">
    <div class="modal-title">إضافة ID فيسبوك</div>
    <input type="hidden" id="addIdIdx" value="-1"/>
    <div class="form-group">
      <label class="form-label">UID الفيسبوك</label>
      <input type="text" class="form-control" id="addIdValue" placeholder="مثال: 100000434205615" style="font-family:monospace"/>
      <div style="font-size:.75rem;color:var(--text3);margin-top:6px">رقم المعرّف الفريد للحساب على فيسبوك</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" onclick="saveAddId()">✅ إضافة</button>
      <button class="btn btn-outline" onclick="closeModal('addIdModal')">إلغاء</button>
    </div>
  </div>
</div>

<script>
const _users = ${JSON.stringify(users)};

function closeModal(id){document.getElementById(id).classList.remove('open')}
function openModal(id){document.getElementById(id).classList.add('open')}

function openNew(){
  document.getElementById('editModalTitle').textContent='شخصية جديدة';
  document.getElementById('editIdx').value='-1';
  document.getElementById('editName').value='';
  document.getElementById('editRole').value='';
  document.getElementById('editChar').value='';
  openModal('editModal');
}

function openEdit(idx){
  const u=_users[idx]||{};
  document.getElementById('editModalTitle').textContent='تعديل: '+u.name;
  document.getElementById('editIdx').value=idx;
  document.getElementById('editName').value=u.name||'';
  document.getElementById('editRole').value=u.role||'';
  document.getElementById('editChar').value=u.character||'';
  openModal('editModal');
}

async function saveUser(){
  const idx=parseInt(document.getElementById('editIdx').value);
  const name=document.getElementById('editName').value.trim();
  const role=document.getElementById('editRole').value.trim();
  const character=document.getElementById('editChar').value.trim();
  if(!name){showToast('❌ الاسم مطلوب','error');return;}
  const r=await api('/api/ai-users/upsert',{idx,name,role,character});
  if(r.ok){showToast('✅ تم الحفظ','success');setTimeout(()=>location.reload(),600);}
  else showToast('❌ '+(r.error||'فشل الحفظ'),'error');
}

function openAddId(idx){
  document.getElementById('addIdIdx').value=idx;
  document.getElementById('addIdValue').value='';
  openModal('addIdModal');
}

async function saveAddId(){
  const idx=parseInt(document.getElementById('addIdIdx').value);
  const newId=document.getElementById('addIdValue').value.trim();
  if(!newId){showToast('❌ أدخل الـ ID','error');return;}
  const r=await api('/api/ai-users/add-id',{idx,id:newId});
  if(r.ok){showToast('✅ تمت الإضافة','success');setTimeout(()=>location.reload(),600);}
  else showToast('❌ '+(r.error||'فشل'),'error');
}

async function removeId(idx,id){
  if(!confirm('حذف '+id+' من هذه الشخصية؟'))return;
  const r=await api('/api/ai-users/remove-id',{idx,id});
  if(r.ok){showToast('✅ تم الحذف','success');setTimeout(()=>location.reload(),600);}
  else showToast('❌ '+(r.error||'فشل'),'error');
}

async function deleteUser(idx){
  const name=_users[idx]?.name||'هذه الشخصية';
  if(!confirm('حذف '+name+' بالكامل؟'))return;
  const r=await api('/api/ai-users/delete',{idx});
  if(r.ok){showToast('✅ تم الحذف','success');setTimeout(()=>location.reload(),600);}
  else showToast('❌ '+(r.error||'فشل'),'error');
}

document.querySelectorAll('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));
</script>`;
    res.send(layout('شخصيات AI', body, 'ai-users', pageOpts()));
  });

  // ─── API ROUTES ───────────────────────────────────────────────────────────────
  // Status
  app.get('/api/status', (req,res) => {
    let activeTier = null;
    try { activeTier = JSON.parse(fs.readFileSync(path.join(DATA_DIR,'active-tier.json'),'utf-8')).tier; } catch(_) {}
    res.json({ status:'running', bot:'ZAO', botAlive:isBotOnline(), restarts:getRestarts(), uptime:Math.floor(process.uptime()), activeTier, time:new Date().toISOString() });
  });

  // Notifications bell list
  app.get('/api/notifications', auth, (req,res) => res.json({ items:_notifRing }));
  app.post('/api/notifications/clear', auth, (req,res) => { _notifRing.length=0; res.json({ok:true}); });

  // Notifications settings
  app.post('/api/notifications/settings', auth, (req,res) => {
    try {
      const { section, key, value } = req.body;
      const cfg = readSettings();
      if (!cfg.notiWhenListenMqttError) cfg.notiWhenListenMqttError = {};
      if (section === 'root') cfg.notiWhenListenMqttError[key] = value;
      else {
        if (!cfg.notiWhenListenMqttError[section]) cfg.notiWhenListenMqttError[section] = {};
        cfg.notiWhenListenMqttError[section][key] = value;
      }
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  app.post('/api/notifications/telegram', auth, (req,res) => {
    try {
      const { botToken, chatId } = req.body;
      const cfg = readSettings();
      if (!cfg.notiWhenListenMqttError) cfg.notiWhenListenMqttError = {};
      if (!cfg.notiWhenListenMqttError.telegram) cfg.notiWhenListenMqttError.telegram = {};
      cfg.notiWhenListenMqttError.telegram.botToken = botToken;
      cfg.notiWhenListenMqttError.telegram.chatId = chatId;
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  app.post('/api/notifications/discord', auth, (req,res) => {
    try {
      const { webhookUrl, username } = req.body;
      const cfg = readSettings();
      if (!cfg.notiWhenListenMqttError) cfg.notiWhenListenMqttError = {};
      if (!cfg.notiWhenListenMqttError.discord) cfg.notiWhenListenMqttError.discord = {};
      cfg.notiWhenListenMqttError.discord.webhookUrl = webhookUrl;
      cfg.notiWhenListenMqttError.discord.username = username;
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  app.post('/api/notifications/test', auth, async (req,res) => {
    const { channel } = req.body;
    const cfg = readSettings();
    const noti = cfg.notiWhenListenMqttError || {};
    try {
      if (channel === 'telegram') {
        const { botToken, chatId } = noti.telegram || {};
        if (!botToken || !chatId) return res.json({ error:'لم يتم ضبط Token أو Chat ID بعد' });
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:chatId, text:'🧪 ZAO Bot — رسالة اختبار من لوحة التحكم ✅' }) });
        const d = await r.json();
        if (d.ok) return res.json({ ok:true });
        return res.json({ error:d.description || 'فشل Telegram API' });
      }
      if (channel === 'discord') {
        const { webhookUrl, username } = noti.discord || {};
        if (!webhookUrl) return res.json({ error:'لم يتم ضبط Webhook URL بعد' });
        const r = await fetch(webhookUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ content:'🧪 ZAO Bot — رسالة اختبار من لوحة التحكم ✅', username:username||'ZAO Bot' }) });
        if (r.status === 204 || r.ok) return res.json({ ok:true });
        return res.json({ error:'HTTP '+r.status+' — تحقق من Webhook URL' });
      }
      res.json({ error:'قناة غير معروفة' });
    } catch(e) { res.json({ error:e.message }); }
  });

  // Config
  app.get('/api/config', auth, (req,res) => { try { res.json(readSettings()); } catch(e) { res.status(500).json({ error:e.message }); } });
  app.post('/api/config', auth, _bigBody, _bigBodyUrlEncoded, (req,res) => {
    try { saveSettings(req.body); res.json({ ok:true }); }
    catch(e) { res.status(400).json({ error:e.message }); }
  });
  app.post('/api/config/toggle', auth, (req,res) => {
    try {
      const { key, value } = req.body;
      const cfg = readSettings();
      cfg[key] = value;
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });
  app.post('/api/config/set', auth, (req,res) => {
    try {
      const { key, value } = req.body;
      const cfg = readSettings();
      cfg[key] = value;
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });
  app.post('/api/config/admins', auth, (req,res) => {
    try {
      const { ids } = req.body;
      const cfg = readSettings();
      if (!cfg.data) cfg.data = {};
      cfg.data.adminBot = ids;
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // Set nested config path (e.g. "humanTyping.enable" or "ADMINBOT")
  app.post('/api/config/set-nested', auth, (req,res) => {
    try {
      const { path: dotPath, value } = req.body;
      if (!dotPath || typeof dotPath !== 'string') return res.json({ error:'path مطلوب' });
      const parts = dotPath.split('.');
      const cfg = readSettings();
      let obj = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] === undefined || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      saveSettings(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // Commands
  app.get('/api/commands', auth, (req,res) => {
    try {
      const files = fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith('.js'));
      const cmds=[], errors=[];
      for (const file of files) {
        try {
          const fp = path.join(CMDS_PATH, file);
          const cmd = require(fp);
          if (cmd?.config) cmds.push({ name:cmd.config.name||file, description:cmd.config.description||'', category:cmd.config.commandCategory||'عام', permission:cmd.config.hasPermssion||0, file });
        } catch(e) { errors.push({ file, error:e.message }); }
      }
      res.json({ commands:cmds, errors });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/commands/source', auth, (req,res) => {
    const file = req.query.file || '';
    if (!file || !file.endsWith('.js')) return res.json({ error:'ملف غير صالح' });
    const fp = path.join(CMDS_PATH, path.basename(file));
    try { res.json({ source:fs.readFileSync(fp,'utf-8') }); }
    catch(e) { res.status(404).json({ error:e.message }); }
  });

  app.post('/api/commands/source', auth, (req,res) => {
    const { file, source } = req.body;
    if (!file || !source) return res.json({ error:'file و source مطلوبان' });
    const fp = path.join(CMDS_PATH, path.basename(file));
    try {
      fs.writeFileSync(fp, source, 'utf-8');
      try { delete require.cache[require.resolve(fp)]; } catch(_) {}
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/commands/create', auth, (req,res) => {
    const { name, code } = req.body;
    if (!name || !code) return res.json({ error:'name و code مطلوبان' });
    const safe = name.replace(/[^a-zA-Z0-9_-]/g,'');
    if (!safe) return res.json({ error:'اسم غير صالح' });
    const fp = path.join(CMDS_PATH, safe+'.js');
    try {
      fs.writeFileSync(fp, code, 'utf-8');
      try { delete require.cache[require.resolve(fp)]; } catch(_) {}
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/commands/delete', auth, (req,res) => {
    const { file } = req.body;
    if (!file) return res.json({ error:'file مطلوب' });
    const fp = path.join(CMDS_PATH, path.basename(file));
    try {
      fs.unlinkSync(fp);
      try { delete require.cache[require.resolve(fp)]; } catch(_) {}
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // Accounts
  app.get('/api/accounts', auth, (req,res) => {
    let activeTier = null;
    try { activeTier = JSON.parse(fs.readFileSync(path.join(DATA_DIR,'active-tier.json'),'utf-8')).tier; } catch(_) {}
    const tiers = TIER_FILES.map(t => {
      function fs2(fn) {
        const full = path.join(ROOT, fn);
        try {
          if (!fs.existsSync(full)) return { exists:false, size:0, valid:false };
          const st = fs.statSync(full);
          let valid=false; try{const d=JSON.parse(fs.readFileSync(full,'utf-8'));valid=Array.isArray(d)&&d.length>0}catch(_){}
          return { exists:true, size:st.size, valid };
        } catch(_) { return { exists:false, size:0, valid:false }; }
      }
      return { tier:t.tier, stateFile:t.stateFile, altFile:t.altFile, state:fs2(t.stateFile), alt:fs2(t.altFile) };
    });
    res.json({ tiers, activeTier });
  });

  app.get('/api/accounts/state', auth, (req,res) => {
    const file = req.query.file || '';
    if (!file) return res.json({ error:'file مطلوب' });
    const safeName = path.basename(file);
    if (!safeName.startsWith('ZAO-STATE') && !safeName.startsWith('alt')) return res.json({ error:'ملف غير مسموح' });
    const fp = path.join(ROOT, 'sessions', safeName);
    try { res.json({ content:fs.readFileSync(fp,'utf-8') }); }
    catch(e) { res.json({ content:'[]', error:e.message }); }
  });

  app.post('/api/accounts/state', auth, _bigBody, (req,res) => {
    const { file, content } = req.body;
    if (!file || !content) return res.json({ error:'file و content مطلوبان' });
    const safeName = path.basename(file);
    if (!safeName.startsWith('ZAO-STATE') && !safeName.startsWith('alt')) return res.json({ error:'ملف غير مسموح' });
    let parsed;
    try { parsed = JSON.parse(content); } catch(_) { return res.json({ error:'JSON غير صالح' }); }
    if (!Array.isArray(parsed) || !parsed.length) return res.json({ error:'AppState يجب أن يكون مصفوفة غير فارغة' });
    try {
      fs.writeFileSync(path.join(ROOT, 'sessions', safeName), content, 'utf-8');
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  app.post('/api/accounts/backup', auth, (req,res) => {
    const { stateFile, altFile } = req.body;
    try {
      const src = path.join(ROOT, path.basename(stateFile));
      const dst = path.join(ROOT, path.basename(altFile));
      if (!fs.existsSync(src)) return res.json({ error:'الملف الأصلي غير موجود' });
      fs.copyFileSync(src, dst);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  app.post('/api/accounts/switch', auth, (req,res) => {
    const { tier } = req.body;
    const t = parseInt(tier);
    if (!TIER_FILES.find(tf=>tf.tier===t)) return res.json({ error:'Tier غير صالح' });
    try {
      fs.writeFileSync(path.join(DATA_DIR,'active-tier.json'), JSON.stringify({ tier:t }), 'utf-8');
      setTimeout(() => { try { restartBotFn(); } catch(_) {} }, 500);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  // ─── Randomizer timers (all random-interval data in one payload) ───────────
  app.get('/api/randomizer/timers', auth, async (req,res) => {
    try {
      const r = await proxyToBot('GET', '/bot/randomizer-timers', null);
      if (r && r.data && typeof r.data === 'object') return res.json(r.data);
    } catch(_) {}
    res.json({ ok:false, error:'Bot offline' });
  });

  // ─── Randomizer status + refill ────────────────────────────────────────────
  app.get('/api/randomizer/status', auth, async (req,res) => {
    try {
      const r = await proxyToBot('GET', '/bot/randomizer-status', null);
      if (r && r.data && typeof r.data === 'object') return res.json(r.data);
    } catch(_) {}
    res.json({ ok:true, mode:'unknown', pool:null, total:0 });
  });

  app.post('/api/randomizer/test', auth, async (req,res) => {
    try {
      const r = await proxyToBot('POST', '/bot/randomizer-refill', '{}');
      if (r && r.data && typeof r.data === 'object') return res.json(r.data);
    } catch(_) {}
    res.json({ ok:false, error:'Bot offline or randomizer not available' });
  });

  // Bot control endpoints
  app.post('/api/bot/restart', auth, (req,res) => {
    res.json({ ok:true, message:'جارٍ إعادة التشغيل...' });
    setTimeout(() => { try { restartBotFn(); } catch(_) {} }, 300);
  });

  app.post('/api/bot/kill', auth, (req,res) => {
    res.json({ ok:true, message:'جارٍ الإيقاف...' });
    setTimeout(() => { try { killBotFn(); } catch(_) {} }, 300);
  });

  app.post('/api/bot/lock', auth, (req,res) => {
    try { lockBotFn(); res.json({ ok:true }); } catch(_) { res.json({ ok:true, note:'لا يوجد lock API' }); }
  });

  app.post('/api/bot/unlock', auth, (req,res) => {
    try { unlockBotFn(); res.json({ ok:true }); } catch(_) { res.json({ ok:true, note:'لا يوجد unlock API' }); }
  });

  app.post('/api/bot/reload-commands', auth, async (req,res) => {
    const result = await proxyToBot('POST', '/bot/reload-commands', '{}');
    if (result.ok) res.json(result.data);
    else res.status(result.status||503).json(result.data);
  });

  app.post('/api/bot/hot-reload', auth, async (req,res) => {
    const result = await proxyToBot('POST', '/bot/hot-reload', '{}');
    if (result.ok) res.json(result.data);
    else res.status(result.status||503).json(result.data);
  });

  // Upgrade #10: reset commandErrorBudget for one or all commands
  app.post('/api/bot/reset-error-budget', auth, (req,res) => {
    try {
      const budget = require('../ZAO-ENGINE/commandErrorBudget');
      const name   = req.body && req.body.command ? String(req.body.command).trim() : null;
      budget.reset(name || undefined);
      res.json({ ok: true, reset: name || 'ALL' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Upgrade #10: get commandErrorBudget status
  app.get('/api/bot/error-budget', auth, (req,res) => {
    try {
      const budget = require('../ZAO-ENGINE/commandErrorBudget');
      res.json({ ok: true, status: budget.getStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Proxy remaining /api/bot/* to bot
  app.all('/api/bot/*', auth, async (req,res) => {
    const botPath = req.path.replace('/api', '');
    const body = ['POST','PUT','PATCH'].includes(req.method) ? JSON.stringify(req.body) : null;
    const result = await proxyToBot(req.method, botPath, body);
    res.status(result.status||200).json(result.data);
  });

  // ─── Friends API routes ───────────────────────────────────────────────────
  app.get('/api/friends/requests',     auth, async (req,res) => { const r=await proxyToBot('GET','/bot/friends/requests',null); res.status(r.status||200).json(r.data); });
  app.get('/api/friends/list',         auth, async (req,res) => { const r=await proxyToBot('GET','/bot/friends/list',null);     res.status(r.status||200).json(r.data); });
  app.get('/api/friends/suggestions',  auth, async (req,res) => { const r=await proxyToBot('GET','/bot/friends/suggestions',null); res.status(r.status||200).json(r.data); });
  app.post('/api/friends/accept',      auth, async (req,res) => { const r=await proxyToBot('POST','/bot/friends/accept',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/friends/send',        auth, async (req,res) => { const r=await proxyToBot('POST','/bot/friends/send',JSON.stringify(req.body));   res.status(r.status||200).json(r.data); });
  app.post('/api/friends/remove',      auth, async (req,res) => { const r=await proxyToBot('POST','/bot/friends/remove',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/friends/reject',      auth, async (req,res) => { const r=await proxyToBot('POST','/bot/friends/reject',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });

  // ─── Silent mode API routes ───────────────────────────────────────────────
  app.get('/api/silent',  auth, async (req,res) => { const r=await proxyToBot('GET','/bot/silent',null); res.status(r.status||200).json(r.data); });
  app.post('/api/silent', auth, async (req,res) => { const r=await proxyToBot('POST','/bot/silent',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });

  // ─── Social API routes ────────────────────────────────────────────────────
  app.post('/api/social/story-create', auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/story-create',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/story-react',  auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/story-react', JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/story-msg',    auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/story-msg',   JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/comment',      auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/comment',     JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/follow',       auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/follow',      JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/pin',          auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/pin',         JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/gcrule',       auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/gcrule',      JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/social/notes',        auth, async (req,res) => { const r=await proxyToBot('POST','/bot/social/notes',       JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });

  // ─── Hold API routes ──────────────────────────────────────────────────────
  const _botRequired = (req,res,next) => isBotOnline() ? next() : res.status(503).json({ok:false,error:'البوت غير متصل — أضف كوكيز صالحة لتشغيل البوت'});
  app.post('/api/hold/status',    auth, _botRequired, async (req,res) => { const r = await proxyToBot('POST', '/bot/hold/status',    JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/hold/nm-set',    auth, _botRequired, async (req,res) => { const r = await proxyToBot('POST', '/bot/hold/nm-set',    JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/hold/nick-set',  auth, _botRequired, async (req,res) => { const r = await proxyToBot('POST', '/bot/hold/nick-set',  JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/hold/motor1-set',auth, _botRequired, async (req,res) => { const r = await proxyToBot('POST', '/bot/hold/motor1-set',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/hold/motor2-set',auth, _botRequired, async (req,res) => { const r = await proxyToBot('POST', '/bot/hold/motor2-set',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });

  // Groups list (lightweight — for the execute tab picker)
  app.get('/api/groups-list', auth, async (req,res) => {
    const _groupCachePath = path.join(DATA_DIR, 'groupCache.json');
    function _readGroupCache() {
      try { return JSON.parse(fs.readFileSync(_groupCachePath, 'utf8')); } catch (_) { return []; }
    }
    function _mapGroup(g) {
      return {
        threadID:    String(g.threadID || g.id || ''),
        name:        String(g.name || g.threadName || 'غير مسمى'),
        memberCount: g.members || g.memberCount || g.participants || null,
        timestamp:   g.timestamp || g.lastTime || 0,
        lastTime:    g.lastTime  || g.timestamp || 0,
        lastMsg:     g.lastMsg   || g.lastMessage || null,
        unread:      g.unread    || g.unreadCount  || 0
      };
    }

    // ── Fast path: bot offline → return cache immediately (no 8s wait) ──
    if (!isBotOnline()) {
      const cached = _readGroupCache();
      const groups = cached.map(_mapGroup).filter(g => g.threadID);
      return res.json({
        ok: groups.length > 0,
        groups,
        cached: true,
        botOffline: true,
        error: groups.length === 0 ? 'البوت غير متصل ولا يوجد كاش — أضف كوكيز صالحة من إعدادات الجلسة' : undefined
      });
    }

    // ── Bot online → proxy to ZAO.js (has 8s timeout internally) ──
    const result = await proxyToBot('GET', '/bot/groups', null);
    const liveOk = result && result.status < 500;
    const raw    = liveOk && Array.isArray(result.data) ? result.data : [];

    let groups = raw.map(_mapGroup).filter(g => g.threadID);

    if (groups.length > 0) {
      try { fs.writeFileSync(_groupCachePath, JSON.stringify(groups, null, 2), 'utf8'); } catch (_) {}
      return res.json({ ok: true, groups, cached: false });
    }

    // Live returned empty → try cache
    const cached = _readGroupCache();
    if (cached.length > 0) {
      const cachedGroups = cached.map(_mapGroup).filter(g => g.threadID);
      if (cachedGroups.length > 0) {
        return res.json({ ok: true, groups: cachedGroups, cached: true });
      }
    }

    const errMsg = !liveOk ? (result?.data?.error || 'Bot unavailable') : 'No groups found';
    res.json({ ok: false, groups: [], error: errMsg });
  });

  // Execute
  app.post('/api/execute', auth, async (req,res) => {
    if (!isBotOnline()) return res.status(503).json({ ok:false, error:'البوت غير متصل — أضف كوكيز صالحة لتشغيل البوت' });
    const result = await proxyToBot('POST', '/bot/execute', JSON.stringify(req.body));
    res.status(result.status||200).json(result.data);
  });

  // Send message — proxies to /bot/send-message (the actual ZAO.js endpoint)
  app.post('/api/send', auth, async (req,res) => {
    if (!isBotOnline()) return res.status(503).json({ ok:false, error:'البوت غير متصل' });
    const result = await proxyToBot('POST', '/bot/send-message', JSON.stringify(req.body));
    res.status(result.status||200).json(result.data);
  });

  // Scheduler
  app.get('/api/scheduler', auth, (req,res) => {
    res.json({
      motor1:   safeReadData('motor-state.json'),
      motor2:   safeReadData('motor2-state.json'),
      nmLocks:  safeReadData('nm-locks.json'),
      nicknames:safeReadData('nickname-locks.json')
    });
  });

  // Health
  app.get('/api/health', async (req,res) => {
    const launcher = { launcherUp:true, botAlive:isBotOnline(), restarts:getRestarts(), time:new Date().toISOString() };
    if (!isBotOnline()) return res.status(503).json({ ok:false, ...launcher, bot:null });
    const result = await proxyToBot('GET', '/bot/health', null);
    const ok = result.status===200 && result.ok;
    res.status(ok?200:503).json({ ok, ...launcher, bot:result.data });
  });

  // Readiness
  app.get('/api/readiness', auth, async (req, res) => {
    const online        = isBotOnline();
    const tier          = global.activeAccountTier || 1;
    const loginMethod   = global.loginMethod || null;
    const renewMins     = (global.config && global.config.intervalGetNewCookieMinutes) || 1440;
    const stateFile     = global.activeStateFile ? path.basename(global.activeStateFile) : null;
    const cfg           = global.config || {};
    const ka            = cfg.keepAlive || {};
    const kaMin         = ka.pingMinIntervalMin || 40;
    const kaMax         = ka.pingMaxIntervalMin || 80;

    // ── MQTT status: proxy from bot's internal health module (source of truth) ──
    let mqttReady    = false;
    let mqttAgoSec   = null;
    let mqttWatchdog = false;
    if (online) {
      try {
        const mqttResult = await proxyToBot('GET', '/bot/mqtt-status', null);
        if (mqttResult && mqttResult.status === 200 && mqttResult.data) {
          const ms     = mqttResult.data;
          mqttReady    = ms.mqttAlive === true;
          mqttAgoSec   = ms.silentForSec !== null && ms.silentForSec !== undefined ? ms.silentForSec : null;
          mqttWatchdog = ms.watcherActive || false;
        }
      } catch (_) {}
    }

    res.json({
      ok: true,
      mqtt: {
        ready:           mqttReady,
        lastActivitySec: mqttAgoSec,
        watchdog:        mqttWatchdog,
      },
      session: { tier, loginMethod, stateFile },
      bot:     { online, renewIntervalMins: renewMins },
      ping: {
        autoPing:      '8–18 min',
        keepAlive:     `${kaMin}–${kaMax} min`,
        graphqlVisit:  '30–120 min',
        cookieRefresh: renewMins >= 60 ? `${Math.round(renewMins / 60)}h` : `${renewMins}m`,
      },
      ts: Date.now(),
    });
  });

  // Protection status
  app.get('/api/protection/status', auth, async (req,res) => {
    if (!isBotOnline()) return res.status(503).json({ ok:false, error:'Bot offline' });
    const result = await proxyToBot('GET', '/bot/protection/status', null);
    res.status(result.status||200).json(result.data);
  });

  // Nick-Protect status & toggle
  app.get('/api/nick-protect/status', auth, async (req,res) => {
    if (!isBotOnline()) return res.status(503).json({ ok:false, error:'Bot offline' });
    const r = await proxyToBot('GET', '/bot/nick-protect/status', null);
    res.status(r.status||200).json(r.data);
  });

  app.post('/api/nick-protect/toggle', auth, async (req,res) => {
    if (!isBotOnline()) return res.status(503).json({ ok:false, error:'Bot offline' });
    const r = await proxyToBot('POST', '/bot/nick-protect/toggle', JSON.stringify(req.body));
    res.status(r.status||200).json(r.data);
  });

  // System stats (CPU/RAM rolling samples for Health graph)
  app.get('/api/sys-stats', auth, async (req,res) => {
    if (!isBotOnline()) return res.json({ ok:false, samples:[], error:'Bot offline' });
    const result = await proxyToBot('GET', '/bot/sys-stats', null);
    res.status(result.status||200).json(result.data);
  });

  // Message requests (pending/other inbox threads)
  app.get('/api/message-requests',         auth, async (req,res) => { const r=await proxyToBot('GET','/bot/requests',null); res.status(r.status||200).json(r.data); });
  app.post('/api/message-requests/accept', auth, async (req,res) => { const r=await proxyToBot('POST','/bot/message-requests/accept',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });
  app.post('/api/message-requests/decline',auth, async (req,res) => { const r=await proxyToBot('POST','/bot/message-requests/decline',JSON.stringify(req.body)); res.status(r.status||200).json(r.data); });

  // ─── Messenger-style groups endpoints ─────────────────────────────────────
  app.get('/api/thread-history', auth, async (req,res) => {
    const qs = new URLSearchParams(req.query);
    const r = await proxyToBot('GET', '/bot/thread-history?threadID='+encodeURIComponent(req.query.threadID||'')+'&count='+(req.query.count||'30'), null);
    res.status(r.status||200).json(r.data);
  });
  app.get('/api/group-members', auth, async (req,res) => {
    const r = await proxyToBot('GET', '/bot/group-members?threadID='+encodeURIComponent(req.query.threadID||''), null);
    res.status(r.status||200).json(r.data);
  });
  app.post('/api/group-change-name', auth, async (req,res) => {
    const r = await proxyToBot('POST', '/bot/group-change-name', JSON.stringify(req.body));
    res.status(r.status||200).json(r.data);
  });
  app.post('/api/group-kick', auth, async (req,res) => {
    const r = await proxyToBot('POST', '/bot/group-kick', JSON.stringify(req.body));
    res.status(r.status||200).json(r.data);
  });

  // ── Bot user ID (used by groups page for message direction) ────────────────
  app.get('/api/bot-id', auth, async (req,res) => {
    if (!isBotOnline()) return res.json({ botID: '' });
    try { const r = await proxyToBot('GET', '/bot/my-id', null); res.json({ botID: r.data && r.data.botID || '' }); }
    catch(_) { res.json({ botID: '' }); }
  });

  // ── Set member nickname ─────────────────────────────────────────────────────
  app.post('/api/set-nickname', auth, async (req,res) => {
    const r = await proxyToBot('POST', '/bot/set-nickname', JSON.stringify(req.body));
    res.status(r.status||200).json(r.data);
  });

  // ── Send media / file (base64) ──────────────────────────────────────────────
  app.post('/api/send-media', auth, async (req,res) => {
    const r = await proxyToBot('POST', '/bot/send-media', JSON.stringify(req.body));
    res.status(r.status||200).json(r.data);
  });

  // ── Report message ──────────────────────────────────────────────────────────
  app.post('/api/report-message', auth, async (req,res) => {
    const r = await proxyToBot('POST', '/bot/report-message', JSON.stringify(req.body));
    res.status(r.status||200).json(r.data);
  });

  // (api/bot/send-message is served by /api/send above)

  // ─── AI Users API ─────────────────────────────────────────────────────────────
  app.get('/api/ai-users', auth, (req,res) => {
    try { res.json(readAiUsers()); } catch(e) { res.status(500).json({error:e.message}); }
  });

  app.post('/api/ai-users/upsert', auth, (req,res) => {
    try {
      const { idx, name, role, character } = req.body;
      if (!name) return res.status(400).json({error:'الاسم مطلوب'});
      const data = readAiUsers();
      const i    = parseInt(idx);
      if (i >= 0 && i < data.users.length) {
        data.users[i] = { ...data.users[i], name, role: role||'', character: character||'' };
      } else {
        data.users.push({ name, ids:[], role: role||'', character: character||'' });
      }
      saveAiUsers(data);
      res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
  });

  app.post('/api/ai-users/add-id', auth, (req,res) => {
    try {
      const { idx, id } = req.body;
      const newId = String(id||'').trim();
      if (!newId || !/^\d{5,}$/.test(newId)) return res.status(400).json({error:'ID غير صالح'});
      const data = readAiUsers();
      const i    = parseInt(idx);
      if (i < 0 || i >= data.users.length) return res.status(404).json({error:'شخصية غير موجودة'});
      if (!Array.isArray(data.users[i].ids)) data.users[i].ids = [];
      if (data.users[i].ids.includes(newId)) return res.status(400).json({error:'الـ ID مضاف مسبقاً'});
      data.users[i].ids.push(newId);
      saveAiUsers(data);
      res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
  });

  app.post('/api/ai-users/remove-id', auth, (req,res) => {
    try {
      const { idx, id } = req.body;
      const data = readAiUsers();
      const i    = parseInt(idx);
      if (i < 0 || i >= data.users.length) return res.status(404).json({error:'شخصية غير موجودة'});
      data.users[i].ids = (data.users[i].ids||[]).filter(x => x !== String(id));
      saveAiUsers(data);
      res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
  });

  app.post('/api/ai-users/delete', auth, (req,res) => {
    try {
      const i    = parseInt(req.body.idx);
      const data = readAiUsers();
      if (i < 0 || i >= data.users.length) return res.status(404).json({error:'شخصية غير موجودة'});
      data.users.splice(i, 1);
      saveAiUsers(data);
      res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
  });

  // ─── ZAO-INSTA sub-panel ─────────────────────────────────────────────────────
  try {
    require('./zao-insta').mount(app, {
      auth, layout, pageOpts,
      instaApiPort:  INSTA_API_PORT,
      instaLogBuffer,
      getInstaChild,
    });
    console.log('[ZAO-INSTA] Sub-panel mounted ✓');
  } catch (e) {
    console.error('[ZAO-INSTA] Failed to mount sub-panel:', e.message);
  }

  // ─── Start Server ─────────────────────────────────────────────────────────────
  const httpServer = http.createServer(app);
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[ZAO PANEL] ✅ لوحة التحكم تعمل على المنفذ ${port}`);
  });
  httpServer.on('error', err => {
    console.error(`[ZAO PANEL] ❌ خطأ في الخادم: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`[ZAO PANEL] المنفذ ${port} مشغول. تأكد من إيقاف الخادم القديم.`);
      process.exit(1);
    }
  });

  // Keep-alive ping
  const _kaTimer = setInterval(() => {
    http.get(`http://127.0.0.1:${port}/api/status`, { timeout:5000 }, ()=>{}).on('error',()=>{});
  }, 120000);
  if (_kaTimer.unref) _kaTimer.unref();

  // Auto-push error/warn logs to notif ring
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, enc, cb) {
    try {
      const len = typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      if (len > 4 && len < 4096) {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (/\bERROR\b/.test(s) || s.includes('❌')) {
          if (!s.includes('favicon')) _pushNotif('error', s.replace(/\x1b\[[0-9;]*m/g,'').trim().substring(0,200));
        } else if (s.includes('WARN') || s.includes('⚠️')) {
          _pushNotif('warn', s.replace(/\x1b\[[0-9;]*m/g,'').trim().substring(0,200));
        }
      }
    } catch(_) {}
    return _origStdoutWrite(chunk, enc, cb);
  };

  return httpServer;
};
