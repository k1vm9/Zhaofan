const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const moment = require("moment-timezone");
const { createCanvas, loadImage, registerFont } = require("canvas");

const ASSETS = path.join(__dirname, "uptime");
const FONT_DIR = path.join(ASSETS, "Roboto", "static");
const CACHE_DIR = path.join(__dirname, "cache");

let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  try {
    registerFont(path.join(FONT_DIR, "Roboto-Regular.ttf"), { family: "Roboto", weight: "400" });
    registerFont(path.join(FONT_DIR, "Roboto-Medium.ttf"),  { family: "Roboto", weight: "500" });
    registerFont(path.join(FONT_DIR, "Roboto-Bold.ttf"),    { family: "Roboto", weight: "700" });
    registerFont(path.join(FONT_DIR, "Roboto-Light.ttf"),   { family: "Roboto", weight: "300" });
    fontsRegistered = true;
  } catch (e) {
    console.error("[uptime] Font registration failed:", e.message);
  }
}

let prevCpu = null;
function sampleCpu() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const t in c.times) total += c.times[t];
    idle += c.times.idle;
  }
  return { idle, total };
}
function getCpuUsage() {
  const cur = sampleCpu();
  if (!prevCpu) { prevCpu = cur; return 8; }
  const di = cur.idle - prevCpu.idle;
  const dt = cur.total - prevCpu.total;
  prevCpu = cur;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - (100 * di / dt))));
}

function getDisk() {
  // Probe the most relevant mount: prefer the project workspace, then $HOME, then /
  const candidates = [process.cwd(), process.env.HOME || "/home", "/"];
  for (const target of candidates) {
    try {
      const line = execSync(`df -kP ${JSON.stringify(target)}`)
        .toString().trim().split("\n")[1].split(/\s+/);
      const totalKB = parseInt(line[1], 10);
      const usedKB  = parseInt(line[2], 10);
      if (totalKB > 1024 * 1024) {
        return {
          totalGB: totalKB / 1024 / 1024,
          usedGB:  usedKB  / 1024 / 1024,
          pct: Math.round((usedKB / totalKB) * 100)
        };
      }
    } catch { /* try next */ }
  }
  return { totalGB: 0, usedGB: 0, pct: 0 };
}

function fmtGB(gb) {
  if (gb >= 1024) return (gb / 1024).toFixed(1) + "TB";
  if (gb >= 100)  return Math.round(gb) + "GB";
  return gb.toFixed(1) + "GB";
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [];
  if (d) parts.push(`${d} day${d !== 1 ? "s" : ""}`);
  if (h || d) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
  parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  if (!d && !h) parts.push(`${s} second${s !== 1 ? "s" : ""}`);
  return parts.join(", ");
}

function roundedRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function card(c, x, y, w, h, r = 18) {
  c.save();
  c.shadowColor = "rgba(0,0,0,0.45)";
  c.shadowBlur = 22;
  c.shadowOffsetY = 4;
  c.fillStyle = "rgba(18, 18, 24, 0.78)";
  roundedRect(c, x, y, w, h, r);
  c.fill();
  c.restore();

  c.save();
  roundedRect(c, x, y, w, h, r);
  c.strokeStyle = "rgba(255,255,255,0.06)";
  c.lineWidth = 1;
  c.stroke();
  c.restore();
}

function progressBar(c, x, y, w, h, pct, color) {
  c.save();
  roundedRect(c, x, y, w, h, h / 2);
  c.fillStyle = "rgba(255,255,255,0.10)";
  c.fill();
  c.restore();

  const fillW = Math.max(h, (w * Math.min(100, Math.max(0, pct))) / 100);
  c.save();
  roundedRect(c, x, y, fillW, h, h / 2);
  c.fillStyle = color;
  c.fill();
  c.restore();
}

function donut(c, cx, cy, rOuter, rInner, pct, color) {
  const start = -Math.PI / 2;
  const end = start + (Math.PI * 2 * Math.min(100, Math.max(0, pct))) / 100;

  c.save();
  c.beginPath();
  c.arc(cx, cy, rOuter, 0, Math.PI * 2);
  c.arc(cx, cy, rInner, 0, Math.PI * 2, true);
  c.fillStyle = "rgba(255,255,255,0.10)";
  c.fill("evenodd");
  c.restore();

  c.save();
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, rOuter, start, end);
  c.closePath();
  c.fillStyle = color;
  c.fill();

  c.globalCompositeOperation = "destination-out";
  c.beginPath();
  c.arc(cx, cy, rInner, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function pie(c, cx, cy, r, pct, color) {
  c.save();
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fillStyle = "rgba(255,255,255,0.10)";
  c.fill();
  c.restore();

  const start = -Math.PI / 2;
  const end = start + (Math.PI * 2 * Math.min(100, Math.max(0, pct))) / 100;
  c.save();
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, r, start, end);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.restore();
}

function cpuWave(c, x, y, w, h, pct) {
  c.save();
  roundedRect(c, x, y, w, h, 6);
  c.clip();

  c.fillStyle = "rgba(255,255,255,0.06)";
  c.fillRect(x, y, w, h);

  const bars = 64;
  const bw = w / bars;
  const seed = Date.now() / 1000;
  for (let i = 0; i < bars; i++) {
    const noise =
      0.5 +
      0.5 *
        Math.sin(i * 0.45 + seed) *
        Math.cos(i * 0.21 + seed * 0.7);
    const intensity = (pct / 100) * 0.85 + 0.15;
    const bh = Math.max(2, h * noise * intensity);
    const by = y + (h - bh);
    c.fillStyle = i < bars * (pct / 100)
      ? "rgba(178, 168, 250, 0.95)"
      : "rgba(140, 150, 170, 0.55)";
    c.fillRect(x + i * bw + 0.5, by, bw - 1, bh);
  }
  c.restore();
}

async function buildImage() {
  ensureFonts();

  const bg = await loadImage(path.join(ASSETS, "blank.png"));
  const W = bg.width;
  const H = bg.height;
  const cv = createCanvas(W, H);
  const c = cv.getContext("2d");

  c.drawImage(bg, 0, 0, W, H);

  // Two darkened side bands — keep the middle of the artwork visible.
  // Left band covers the clocks column, right band covers the specs column.
  const leftBandW  = 568;
  const rightBandX = W - 568;
  c.fillStyle = "rgba(0,0,0,0.22)";
  c.fillRect(0, 0, leftBandW, H);
  c.fillRect(rightBandX, 0, W - rightBandX, H);

  // ---------- DATA ----------
  const cpus = os.cpus();
  const cpuModel = (cpus[0] && cpus[0].model || "Unknown CPU")
    .replace(/\(R\)|\(TM\)|CPU/gi, "")
    .replace(/\s+@.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const cores = cpus.length;
  const cpuPct = getCpuUsage();

  const totalRamGB = os.totalmem() / 1024 / 1024 / 1024;
  const usedRamGB  = (os.totalmem() - os.freemem()) / 1024 / 1024 / 1024;
  const ramPct     = Math.round((usedRamGB / totalRamGB) * 100);

  const disk = getDisk();

  const nodeVer = process.version;
  const upStr = fmtUptime(process.uptime());

  const cities = [
    { name: "Gomel",        tz: "Europe/Minsk" },
    { name: "Cairo",        tz: "Africa/Cairo" },
    { name: "Casablanca",   tz: "Africa/Casablanca" },
    { name: "Algeria",      tz: "Africa/Algiers" },
    { name: "Libya",        tz: "Africa/Tripoli" },
    { name: "Saudi Arabia", tz: "Asia/Riyadh" },
    { name: "Spain",        tz: "Europe/Madrid" }
  ];

  // ---------- LAYOUT (two columns: clocks left, specs right) ----------
  const accent     = "#b2a8fa";
  const accentSoft = "rgba(178,168,250,0.85)";
  const subText    = "rgba(220,220,230,0.88)";
  const labelText  = "rgba(255,255,255,0.60)";

  const leftX  = 24;
  const leftW  = 520;
  const rightW = 520;
  const rightX = W - 24 - rightW;       // 832
  const gap    = 16;
  const padL   = 28;                    // inner padding (left of card content)

  // ───────── LEFT COLUMN — World clocks ─────────
  // 7 cities laid out in 4 rows × 2 cols (last row holds 1).
  const timeY        = 22;
  const timeHeaderH  = 38;
  const timeRowH     = 100;
  const timeRows     = 4;
  const timeH        = timeHeaderH + timeRows * timeRowH + 24;
  card(c, leftX, timeY, leftW, timeH);

  c.fillStyle = labelText;
  c.font = "500 16px Roboto";
  c.fillText("WORLD CLOCKS", leftX + padL, timeY + 30);

  for (let i = 0; i < cities.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const colW = (leftW - padL * 2) / 2;
    const cx0  = leftX + padL + col * colW;
    const cy0  = timeY + 14 + timeHeaderH + row * timeRowH;

    c.fillStyle = subText;
    c.font = "400 19px Roboto";
    c.fillText(cities[i].name, cx0, cy0 + 12);

    c.fillStyle = "#ffffff";
    c.font = "300 50px Roboto";
    c.fillText(moment.tz(cities[i].tz).format("HH:mm"), cx0, cy0 + 60);
  }

  // ───────── RIGHT COLUMN — Specs stack ─────────
  let curY = timeY;     // align with clocks card

  // CPU card
  const cpuH = 168;
  card(c, rightX, curY, rightW, cpuH);
  c.fillStyle = "#ffffff";
  c.font = "500 24px Roboto";
  c.fillText("CPU Info", rightX + padL, curY + 38);

  c.fillStyle = subText;
  c.font = "400 18px Roboto";
  const cpuLabel = "Model: " + cpuModel;
  const maxCpuLabelW = rightW - padL * 2;
  let displayed = cpuLabel;
  while (c.measureText(displayed).width > maxCpuLabelW && displayed.length > 4) {
    displayed = displayed.slice(0, -2);
  }
  if (displayed !== cpuLabel) displayed = displayed.slice(0, -1) + "…";
  c.fillText(displayed, rightX + padL, curY + 70);
  c.fillText(`Cores: ${cores}`, rightX + padL, curY + 96);

  c.fillStyle = subText;
  c.fillText(`Usage: ${cpuPct}%`, rightX + padL, curY + 132);
  cpuWave(c, rightX + padL + 130, curY + 114, rightW - padL * 2 - 130, 28, cpuPct);

  curY += cpuH + gap;

  // Memory card
  const memH = 116;
  card(c, rightX, curY, rightW, memH);

  donut(c, rightX + padL + 26, curY + memH / 2, 32, 19, ramPct, accent);

  c.fillStyle = "#ffffff";
  c.font = "500 22px Roboto";
  c.fillText("Memory", rightX + padL + 80, curY + 38);

  progressBar(c, rightX + padL + 80, curY + 54, rightW - padL * 2 - 80, 10, ramPct, accentSoft);

  c.fillStyle = subText;
  c.font = "400 18px Roboto";
  c.fillText(
    `RAM: ${fmtGB(usedRamGB)} / ${fmtGB(totalRamGB)} (Used)`,
    rightX + padL + 80, curY + 92
  );

  curY += memH + gap;

  // Storage card
  const stoH = 116;
  card(c, rightX, curY, rightW, stoH);

  pie(c, rightX + padL + 26, curY + stoH / 2, 32, disk.pct, "#7da3e8");

  c.fillStyle = "#ffffff";
  c.font = "500 22px Roboto";
  c.fillText("Storage", rightX + padL + 80, curY + 38);

  progressBar(c, rightX + padL + 80, curY + 54, rightW - padL * 2 - 80, 10, disk.pct, "rgba(125,163,232,0.85)");

  c.fillStyle = subText;
  c.font = "400 18px Roboto";
  c.fillText(
    `SSD: ${fmtGB(disk.usedGB)} / ${fmtGB(disk.totalGB)} (Used)`,
    rightX + padL + 80, curY + 92
  );

  curY += stoH + gap;

  // Dev environment card
  const devH = 86;
  card(c, rightX, curY, rightW, devH);
  c.fillStyle = "#ffffff";
  c.font = "500 22px Roboto";
  c.fillText("Dev Environment", rightX + padL, curY + 34);
  c.fillStyle = subText;
  c.font = "400 18px Roboto";
  c.fillText(`Node.js Version: ${nodeVer}`, rightX + padL, curY + 64);

  curY += devH + gap;

  // System uptime + bot status card
  const loginMethodLabel = (() => {
    const m = global.loginMethod;
    if (m === 'credentials')   return 'Credentials';
    if (m === 'appstate-alt')  return 'Alt Cookies';
    if (m)                     return 'Cookies';
    return '—';
  })();
  const activeTierLabel = `Tier ${global.activeAccountTier || 1}`;
  const renewMins  = (global.config && global.config.intervalGetNewCookieMinutes) || 1440;
  const renewLabel = renewMins >= 60 ? `Every ${Math.round(renewMins / 60)}h` : `Every ${renewMins}m`;

  const specRows = [
    ["Uptime",          upStr],
    ["Login",           `${loginMethodLabel}  (${activeTierLabel})`],
    ["Cookie Refresh",  renewLabel],
    ["Pings",           "Auto 8–18 min · Keep-Alive 40–80 min"],
  ];

  const upH = 220;
  card(c, rightX, curY, rightW, upH);
  c.fillStyle = "#ffffff";
  c.font = "500 22px Roboto";
  c.fillText("Bot Status", rightX + padL, curY + 34);

  specRows.forEach(([lbl, val], i) => {
    const ry = curY + 64 + i * 38;
    c.fillStyle = labelText;
    c.font = "400 15px Roboto";
    c.fillText(lbl + ":", rightX + padL, ry);
    c.fillStyle = subText;
    c.font = "400 16px Roboto";
    let v = val;
    const maxW = rightW - padL * 2 - 148;
    while (c.measureText(v).width > maxW && v.length > 2) v = v.slice(0, -2);
    if (v !== val) v = v.slice(0, -1) + "…";
    c.fillText(v, rightX + padL + 148, ry);
  });

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = path.join(CACHE_DIR, `uptime_${Date.now()}.png`);
  fs.writeFileSync(out, cv.toBuffer("image/png"));
  return out;
}

module.exports.config = {
  name: "ابتيم",
  version: "2.0.0",
  hasPermssion: 0,
  credits: "SAIN",
  description: "عرض معلومات السيرفر بتصميم مرئي",
  commandCategory: "النظام",
  usages: "ابتيم",
  cooldowns: 5
};

module.exports.run = async function ({ api, event }) {
  let filePath;
  try {
    // Prime CPU sampler so the first reading isn't 0
    sampleCpu();
    await new Promise(r => setTimeout(r, 250));

    filePath = await buildImage();

    await new Promise((resolve, reject) => {
      api.sendMessage(
        { attachment: fs.createReadStream(filePath) },
        event.threadID,
        (err) => (err ? reject(err) : resolve()),
        event.messageID
      );
    });
  } catch (err) {
    console.error("[uptime] error:", err);
    api.sendMessage(`❌ تعذر إنشاء صورة الحالة: ${err.message}`, event.threadID, event.messageID);
  } finally {
    if (filePath) {
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 15000);
    }
  }
};
