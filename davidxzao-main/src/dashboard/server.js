/**
 * DAVID V1 — Dashboard Server (Express + Socket.io)
 * Copyright © 2025 DJAMEL
 */
"use strict";

const express    = require("express");
const http       = require("http");
const socketio   = require("socket.io");
const path       = require("path");
const fs         = require("fs-extra");
const bodyParser = require("body-parser");
const chalk      = require("chalk");
const crypto     = require("crypto");

const ROOT          = path.join(__dirname, "../../");
const ACCOUNT_PATH  = path.join(ROOT, "account.txt");
const CONFIG_PATH   = path.join(ROOT, "config.json");
const CMDS_DIR      = path.join(ROOT, "src/commands");
const SESSIONS_DIR  = path.join(ROOT, "data/sessions");
const ACTIVE_TIER_PATH = path.join(ROOT, "data/active-tier.json");

fs.ensureDirSync(SESSIONS_DIR);

let _io      = null;
let _server  = null;
let _logBuf  = [];
const MAX_LOG_BUF = 500;

const stats = {
  totalMessages: 0,
  totalCommands: 0,
  activeThreads: new Set(),
  activeUsers:   new Set(),
  msgLog:        [],
};

// ── Token store ──────────────────────────────────────────────────────────────
const _tokens = new Map();
function genToken() {
  const tok = crypto.randomBytes(24).toString("hex");
  _tokens.set(tok, Date.now() + 8 * 3600 * 1000);
  return tok;
}
function validToken(tok) {
  const exp = _tokens.get(tok);
  if (!exp) return false;
  if (Date.now() > exp) { _tokens.delete(tok); return false; }
  return true;
}
function getDashPwd() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return cfg.dashboard?.password || "Sain12";
  } catch (_) { return "Sain12"; }
}

// ── Live log interceptor ──────────────────────────────────────────────────────
function interceptLogs() {
  const origWrite = process.stdout.write.bind(process.stdout);
  const errWrite  = process.stderr.write.bind(process.stderr);
  const push = (data) => {
    const line = String(data).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!line) return;
    if (_logBuf.length >= MAX_LOG_BUF) _logBuf.shift();
    _logBuf.push({ ts: Date.now(), line });
    if (_io) _io.emit("log-line", { ts: Date.now(), line });
  };
  process.stdout.write = function(chunk, ...args) { push(chunk); return origWrite(chunk, ...args); };
  process.stderr.write = function(chunk, ...args) { push(chunk); return errWrite(chunk, ...args); };
}

function getIO()  { return _io; }

function _bufferMsg(event) {
  stats.totalMessages++;
  if (event.threadID) stats.activeThreads.add(String(event.threadID));
  if (event.senderID) stats.activeUsers.add(String(event.senderID));
  if (stats.msgLog.length >= 60) stats.msgLog.shift();
  stats.msgLog.push({ body: (event.body || "").slice(0, 100), ts: Date.now(), tid: event.threadID, sid: event.senderID });
  if (_io) _io.emit("stats-update", getStats());
}
function _trackMsg(tid, uid, body) {
  const px = global.GoatBot?.config?.prefix || "/";
  if (body?.trimStart().startsWith(px)) stats.totalCommands++;
}
global._bufferMsg = _bufferMsg;
global._trackMsg  = _trackMsg;

function getStats() {
  const upMs = Date.now() - (global.GoatBot?.startTime || Date.now());
  const mem  = process.memoryUsage();
  return {
    uptime:        upMs,
    totalMessages: stats.totalMessages,
    totalCommands: stats.totalCommands,
    activeThreads: stats.activeThreads.size,
    activeUsers:   stats.activeUsers.size,
    commands:      global.GoatBot?.commands?.size || 0,
    botID:         global.GoatBot?.botID  || null,
    botName:       global.GoatBot?.config?.botName || "DAVID V1",
    memMB:         +(mem.heapUsed / 1048576).toFixed(1),
    prefix:        global.GoatBot?.config?.prefix || "/",
    protection:    20,
    online:        !!global.GoatBot?.fcaApi && !!global.GoatBot?.botID,
    globalLock:    !!global.GoatBot?.globalLock,
    silentMode:    !!global.GoatBot?.silentMode,
    activeTier:    getActiveTier(),
  };
}

function getActiveTier() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_TIER_PATH, "utf8")).tier; } catch(_) { return null; }
}
function setActiveTier(tier) {
  fs.writeFileSync(ACTIVE_TIER_PATH, JSON.stringify({ tier }, null, 2));
}

// ── Auth middleware ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const tok = req.headers["x-david-token"] || req.query.token;
  if (tok && validToken(tok)) return next();
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ── Dashboard server ──────────────────────────────────────────────────────────
function startDashboard(port = 5000) {
  const app   = express();
  _server     = http.createServer(app);
  _io         = socketio(_server, { cors: { origin: "*" } });

  app.use(bodyParser.json({ limit: "10mb" }));
  app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  // ── Auth ─────────────────────────────────────────────────────────────────
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    if (password === getDashPwd()) {
      const tok = genToken();
      res.json({ ok: true, token: tok });
    } else {
      res.json({ ok: false, error: "كلمة السر خاطئة" });
    }
  });
  app.post("/api/logout", auth, (req, res) => {
    const tok = req.headers["x-david-token"] || req.query.token;
    _tokens.delete(tok);
    res.json({ ok: true });
  });
  app.get("/api/auth-check", auth, (_, res) => res.json({ ok: true }));

  // ── Stats ─────────────────────────────────────────────────────────────────
  app.get("/api/stats",  auth, (_, res) => res.json(getStats()));
  app.get("/api/status", auth, (_, res) => {
    const online = !!global.GoatBot?.fcaApi && !!global.GoatBot?.botID;
    res.json({ ok: true, online, botID: global.GoatBot?.botID || null, botName: global.GoatBot?.config?.botName || "DAVID V1" });
  });

  // ── Config ────────────────────────────────────────────────────────────────
  app.get("/api/config", auth, (_, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.facebookAccount) cfg.facebookAccount.password = "";
      res.json({ ok: true, config: cfg });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post("/api/config", auth, (req, res) => {
    try {
      const old     = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const updated = Object.assign({}, old, req.body);
      global._selfWriteConfig = true;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
      setTimeout(() => { global._selfWriteConfig = false; }, 3000);
      if (global.GoatBot) global.GoatBot.config = updated;
      global.config        = updated;
      global.commandPrefix = updated.prefix || "/";
      if (_io) _io.emit("config-reloaded", { ts: Date.now() });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Cookies ──────────────────────────────────────────────────────────────
  app.post("/api/cookies", auth, (req, res) => {
    const raw = req.body?.cookies;
    if (!raw) return res.json({ ok: false, error: "لا توجد بيانات" });
    try {
      const DjamelFCA = require("../../Djamel-fca");
      const parsed    = DjamelFCA.parseCookieInput(raw);
      const cookies   = parsed.cookies;
      if (!cookies.length) return res.json({ ok: false, error: "صيغة الكوكيز غير معروفة" });
      if (!DjamelFCA.hasMandatory(cookies)) return res.json({ ok: false, error: "كوكيز ناقصة (c_user أو xs مفقود)" });
      global._selfWrite = true;
      fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(cookies, null, 2));
      setTimeout(() => { global._selfWrite = false; }, 6000);
      res.json({ ok: true, count: cookies.length });
      setTimeout(() => { try { global.startBot?.(); } catch (_) {} }, 1500);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Bot Control ───────────────────────────────────────────────────────────
  app.post("/api/control", auth, (req, res) => {
    const { action } = req.body;
    if (action === "restart") {
      res.json({ ok: true });
      setTimeout(() => { try { global.startBot?.(); } catch (_) {} }, 400);
    } else if (action === "stop") {
      res.json({ ok: true });
      setTimeout(() => process.exit(0), 400);
    } else {
      res.json({ ok: false, error: "action غير معروف" });
    }
  });

  // ── Bot state (lock / silent) ─────────────────────────────────────────────
  app.get("/api/bot/state", auth, (_, res) => {
    res.json({
      ok:         true,
      globalLock: !!global.GoatBot?.globalLock,
      silentMode: !!global.GoatBot?.silentMode,
      dmLocked:   !!global.GoatBot?.dmLocked,
    });
  });

  app.post("/api/bot/lock", auth, (_, res) => {
    if (global.GoatBot) global.GoatBot.globalLock = true;
    if (_io) _io.emit("bot-state-change", { globalLock: true, silentMode: !!global.GoatBot?.silentMode });
    res.json({ ok: true, globalLock: true });
  });

  app.post("/api/bot/unlock", auth, (_, res) => {
    if (global.GoatBot) global.GoatBot.globalLock = false;
    if (_io) _io.emit("bot-state-change", { globalLock: false, silentMode: !!global.GoatBot?.silentMode });
    res.json({ ok: true, globalLock: false });
  });

  app.post("/api/bot/silent", auth, (req, res) => {
    const enable = req.body?.enable !== undefined ? !!req.body.enable : !global.GoatBot?.silentMode;
    if (global.GoatBot) global.GoatBot.silentMode = enable;
    if (_io) _io.emit("bot-state-change", { globalLock: !!global.GoatBot?.globalLock, silentMode: enable });
    res.json({ ok: true, silentMode: enable });
  });

  app.post("/api/bot/dm-lock", auth, (req, res) => {
    const enable = req.body?.enable !== undefined ? !!req.body.enable : !global.GoatBot?.dmLocked;
    if (global.GoatBot) global.GoatBot.dmLocked = enable;
    res.json({ ok: true, dmLocked: enable });
  });

  // ── Hot-reload all commands ────────────────────────────────────────────────
  app.post("/api/bot/hot-reload", auth, (req, res) => {
    try {
      const { loadCommands } = require("../engine/loader");
      const newCmds = loadCommands(CMDS_DIR);
      if (global.GoatBot) global.GoatBot.commands = newCmds;
      global.commands = newCmds;
      if (_io) _io.emit("commands-reloaded", { count: newCmds.size, ts: Date.now() });
      res.json({ ok: true, message: `✅ تم إعادة تحميل ${newCmds.size} أمر` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Send message to thread ────────────────────────────────────────────────
  app.post("/api/send", auth, async (req, res) => {
    const { threadID, message } = req.body;
    if (!threadID || !message) return res.json({ ok: false, error: "threadID والرسالة مطلوبان" });
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    try {
      await new Promise((resolve, reject) =>
        api.sendMessage(String(message), String(threadID), (err, info) => err ? reject(err) : resolve(info))
      );
      res.json({ ok: true, message: "✅ تم إرسال الرسالة" });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Broadcast to all threads ──────────────────────────────────────────────
  app.post("/api/broadcast", auth, async (req, res) => {
    const { message, delay = 800 } = req.body;
    if (!message) return res.json({ ok: false, error: "الرسالة مطلوبة" });
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });

    const threads = Object.keys(global.GoatBot?.allThreadData || {});
    if (!threads.length) return res.json({ ok: false, error: "لا توجد غروبات مسجلة" });

    res.json({ ok: true, message: `📡 جاري الإرسال إلى ${threads.length} غروب…`, count: threads.length });

    // Send async after response
    (async () => {
      let sent = 0, failed = 0;
      for (const tid of threads) {
        try {
          await new Promise(r => setTimeout(r, Number(delay) || 800));
          await new Promise((resolve, reject) =>
            api.sendMessage(String(message), String(tid), (err) => err ? reject(err) : resolve())
          );
          sent++;
        } catch (_) { failed++; }
      }
      if (_io) _io.emit("broadcast-done", { sent, failed, total: threads.length });
    })();
  });

  // ── Execute command in thread ──────────────────────────────────────────────
  app.post("/api/execute", auth, async (req, res) => {
    const { threadID, command } = req.body;
    if (!threadID || !command) return res.json({ ok: false, error: "threadID والأمر مطلوبان" });
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });

    const prefix = global.GoatBot?.config?.prefix || "/";
    const body   = command.startsWith(prefix) ? command : prefix + command;
    const parts  = body.slice(prefix.length).trim().split(/\s+/);
    const cmdName = (parts[0] || "").toLowerCase();
    const args    = parts.slice(1);
    const cmd     = global.GoatBot?.commands?.get(cmdName);
    if (!cmd) return res.json({ ok: false, error: `الأمر /${cmdName} غير موجود` });

    const fakeEvent = {
      type: "message", body,
      threadID: String(threadID),
      senderID: String(global.GoatBot?.botID || "0"),
      messageID: `exec_${Date.now()}`,
      isGroup: true,
      messageReply: null,
    };
    const msg = {
      reply: (m, cb) => new Promise((r,j) => api.sendMessage(m, String(threadID), (e,i) => e ? j(e) : r(i))),
      send:  (m, tid, cb) => new Promise((r,j) => api.sendMessage(m, String(tid||threadID), (e,i) => e ? j(e) : r(i))),
      react: (emoji, mid) => { try { api.setMessageReaction(emoji, mid||fakeEvent.messageID, ()=>{}, true); } catch(_) {} },
      unsend: () => {},
    };
    try {
      if (typeof cmd.onStart === "function") await cmd.onStart({ api, event: fakeEvent, args, message: msg, commandName: cmdName, prefix, role: 3, senderID: fakeEvent.senderID, threadID: String(threadID) });
      else if (typeof cmd.run === "function") await cmd.run({ api, event: fakeEvent, args, message: msg, commandName: cmdName, prefix, role: 3, senderID: fakeEvent.senderID, threadID: String(threadID) });
      res.json({ ok: true, message: `✅ تم تنفيذ /${cmdName}` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Groups list ───────────────────────────────────────────────────────────
  app.get("/api/groups", auth, (_, res) => {
    const groups = [];
    const allData = global.GoatBot?.allThreadData || {};
    for (const [tid, data] of Object.entries(allData)) {
      groups.push({ tid, name: data?.threadName || data?.name || `غروب ${tid}`, isGroup: !!data?.isGroup });
    }
    res.json({ ok: true, groups });
  });

  // ── Commands list ─────────────────────────────────────────────────────────
  app.get("/api/commands", auth, (_, res) => {
    const list = [];
    const seen = new Set();
    for (const [name, cmd] of (global.GoatBot?.commands || new Map())) {
      if (cmd?.config?.name?.toLowerCase() === name && !seen.has(name)) {
        seen.add(name);
        list.push({
          name:        cmd.config.name,
          aliases:     cmd.config.aliases || [],
          category:    cmd.config.category  || "other",
          role:        cmd.config.role       ?? 2,
          description: cmd.config.description || "",
          version:     cmd.config.version    || "1.0",
        });
      }
    }
    res.json({ ok: true, commands: list });
  });

  // ── Command source ────────────────────────────────────────────────────────
  app.get("/api/commands/:name/source", auth, (req, res) => {
    const name = req.params.name.toLowerCase().replace(/[^a-z0-9_\u0600-\u06ff-]/gi, "");
    const file = path.join(CMDS_DIR, `${name}.js`);
    if (!fs.existsSync(file)) return res.json({ ok: false, error: "الأمر غير موجود" });
    try {
      const code = fs.readFileSync(file, "utf8");
      res.json({ ok: true, name, code });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/commands/:name/source", auth, (req, res) => {
    const name = req.params.name.toLowerCase().replace(/[^a-z0-9_\u0600-\u06ff-]/gi, "");
    const { code } = req.body;
    if (!code) return res.json({ ok: false, error: "الكود فارغ" });
    const file = path.join(CMDS_DIR, `${name}.js`);
    try { new Function(code); } catch (syntaxErr) {
      return res.json({ ok: false, error: "خطأ في الكود: " + syntaxErr.message });
    }
    try {
      fs.writeFileSync(file, code, "utf8");
      const absPath = require.resolve(file);
      delete require.cache[absPath];
      const cmd = require(file);
      if (cmd?.config?.name) {
        const n = cmd.config.name.toLowerCase();
        global.GoatBot.commands.set(n, cmd);
        if (cmd.config.aliases) for (const a of cmd.config.aliases) if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
        if (_io) _io.emit("command-updated", { name: n });
        res.json({ ok: true, message: `✅ تم تحديث /${n} بدون إعادة تشغيل` });
      } else {
        res.json({ ok: false, error: "config.name مفقود في الأمر" });
      }
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Thread command control ────────────────────────────────────────────────
  app.get("/api/thread-commands", auth, (_, res) => {
    try { const ctrl = require("../utils/cmdControl"); ctrl.reload(); res.json({ ok: true, data: ctrl.getAll() }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get("/api/thread-commands/:tid", auth, (req, res) => {
    try { const ctrl = require("../utils/cmdControl"); res.json({ ok: true, config: ctrl.getThreadConfig(req.params.tid) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post("/api/thread-commands/:tid", auth, (req, res) => {
    try {
      const ctrl = require("../utils/cmdControl");
      const { mode, commands: cmds } = req.body;
      if (!["blacklist","whitelist"].includes(mode)) return res.json({ ok: false, error: "mode يجب أن يكون blacklist أو whitelist" });
      ctrl.setThreadConfig(req.params.tid, { mode, commands: Array.isArray(cmds) ? cmds : [] });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.delete("/api/thread-commands/:tid", auth, (req, res) => {
    try { const ctrl = require("../utils/cmdControl"); ctrl.resetThread(req.params.tid); res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Threads list ──────────────────────────────────────────────────────────
  app.get("/api/threads", auth, (_, res) => {
    try {
      const threads = [];
      const allData = global.GoatBot?.allThreadData || {};
      for (const [tid, data] of Object.entries(allData)) {
        threads.push({ tid, name: data?.threadName || data?.name || `غروب ${tid}`, type: data?.isGroup ? "group" : "dm" });
      }
      const ctrl = require("../utils/cmdControl");
      const ctrlTids = ctrl.getAllThreads();
      for (const tid of ctrlTids) {
        if (!threads.find(t => t.tid === tid)) threads.push({ tid, name: `غروب ${tid}`, type: "group" });
      }
      res.json({ ok: true, threads });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Command meta update ───────────────────────────────────────────────────
  app.post("/api/commands/:name/update-meta", auth, (req, res) => {
    const nameParam = req.params.name.toLowerCase().replace(/[^a-z0-9_\u0600-\u06ff-]/gi, "");
    const { newName, aliases, description, role, guide } = req.body;
    const file = path.join(CMDS_DIR, `${nameParam}.js`);
    if (!fs.existsSync(file)) return res.json({ ok: false, error: "الأمر غير موجود" });
    try {
      let code = fs.readFileSync(file, "utf8");
      if (newName && newName !== nameParam) code = code.replace(/name:\s*["']([^"']+)["']/, `name: "${newName}"`);
      if (Array.isArray(aliases)) code = code.replace(/aliases:\s*\[([^\]]*)\]/, `aliases: ${JSON.stringify(aliases)}`);
      if (description) code = code.replace(/description:\s*["']([^"']*)["']/, `description: "${description.replace(/"/g,'\\"')}"`);
      if (role !== undefined) code = code.replace(/role:\s*\d/, `role: ${parseInt(role) || 2}`);
      if (guide) code = code.replace(/guide:\s*\{[^}]*\}/, `guide: { en: "${guide.replace(/"/g,'\\"').replace(/\n/g,'\\n')}" }`);
      fs.writeFileSync(file, code, "utf8");
      const absPath = require.resolve(file);
      delete require.cache[absPath];
      const cmd = require(file);
      const finalName = (cmd?.config?.name || nameParam).toLowerCase();
      if (global.GoatBot?.commands) {
        if (newName && newName !== nameParam) global.GoatBot.commands.delete(nameParam);
        global.GoatBot.commands.set(finalName, cmd);
        if (cmd.config.aliases) for (const a of cmd.config.aliases||[]) if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
      }
      if (_io) _io.emit("command-updated", { name: finalName });
      res.json({ ok: true, name: finalName, message: `✅ تم تحديث /${finalName}` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Accounts / Tiers ─────────────────────────────────────────────────────
  app.get("/api/accounts", auth, (_, res) => {
    const activeTier = getActiveTier();
    const tiers = [1, 2, 3].map(n => {
      const file = path.join(SESSIONS_DIR, `account-${n}.json`);
      const hasSession = fs.existsSync(file);
      let uid = null;
      if (hasSession) {
        try {
          const cookies = JSON.parse(fs.readFileSync(file, "utf8"));
          const cUser = cookies.find(c => c.key === "c_user" || c.name === "c_user");
          uid = cUser?.value || cUser?.val || null;
        } catch(_) {}
      }
      return { tier: n, hasSession, uid, isActive: activeTier === n };
    });
    res.json({ ok: true, tiers, activeTier });
  });

  app.post("/api/accounts/:tier/upload", auth, (req, res) => {
    const tier = parseInt(req.params.tier);
    if (![1,2,3].includes(tier)) return res.json({ ok: false, error: "Tier يجب أن يكون 1 أو 2 أو 3" });
    const raw = req.body?.cookies;
    if (!raw) return res.json({ ok: false, error: "لا توجد بيانات" });
    try {
      const DjamelFCA = require("../../Djamel-fca");
      const parsed    = DjamelFCA.parseCookieInput(raw);
      const cookies   = parsed.cookies;
      if (!cookies.length) return res.json({ ok: false, error: "صيغة الكوكيز غير معروفة" });
      if (!DjamelFCA.hasMandatory(cookies)) return res.json({ ok: false, error: "كوكيز ناقصة (c_user أو xs مفقود)" });
      const file = path.join(SESSIONS_DIR, `account-${tier}.json`);
      fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
      res.json({ ok: true, message: `✅ تم حفظ الجلسة في Tier ${tier}` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/accounts/:tier/activate", auth, (req, res) => {
    const tier = parseInt(req.params.tier);
    if (![1,2,3].includes(tier)) return res.json({ ok: false, error: "Tier غير صالح" });
    const file = path.join(SESSIONS_DIR, `account-${tier}.json`);
    if (!fs.existsSync(file)) return res.json({ ok: false, error: `لا توجد جلسة محفوظة في Tier ${tier}` });
    try {
      const cookies = JSON.parse(fs.readFileSync(file, "utf8"));
      global._selfWrite = true;
      fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(cookies, null, 2));
      setTimeout(() => { global._selfWrite = false; }, 6000);
      setActiveTier(tier);
      res.json({ ok: true, message: `✅ تم تفعيل Tier ${tier} — البوت سيعيد الاتصال` });
      setTimeout(() => { try { global.startBot?.(); } catch(_) {} }, 1000);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.delete("/api/accounts/:tier", auth, (req, res) => {
    const tier = parseInt(req.params.tier);
    if (![1,2,3].includes(tier)) return res.json({ ok: false, error: "Tier غير صالح" });
    const file = path.join(SESSIONS_DIR, `account-${tier}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (getActiveTier() === tier) {
        try { fs.unlinkSync(ACTIVE_TIER_PATH); } catch(_) {}
      }
      res.json({ ok: true, message: `✅ تم حذف جلسة Tier ${tier}` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Messages log ──────────────────────────────────────────────────────────
  app.get("/api/messages", auth, (_, res) => {
    res.json({ ok: true, messages: [...stats.msgLog].reverse().slice(0, 30) });
  });

  // ── Live logs ─────────────────────────────────────────────────────────────
  app.get("/api/logs", auth, (_, res) => {
    res.json({ ok: true, logs: _logBuf.slice(-200) });
  });

  // ── Protection status ─────────────────────────────────────────────────────
  app.get("/api/protection-status", auth, (_, res) => {
    try {
      const uProt = require("../protection/Uprotection");
      res.json({ ok: true, stats: uProt.getStats() });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────
  _io.on("connection", socket => {
    const tok = socket.handshake.query?.token;
    if (!validToken(tok)) { socket.disconnect(); return; }

    socket.emit("stats-update", getStats());
    socket.emit("bot-status", {
      status:     global.GoatBot?.fcaApi ? "online" : "offline",
      uid:        global.GoatBot?.botID  || null,
      botName:    global.GoatBot?.config?.botName || "DAVID V1",
      globalLock: !!global.GoatBot?.globalLock,
      silentMode: !!global.GoatBot?.silentMode,
    });
    socket.emit("log-history", _logBuf.slice(-100));
    socket.on("ping-bot", () => socket.emit("pong-bot", { ts: Date.now() }));
  });

  // ── Catch-all SPA ─────────────────────────────────────────────────────────
  app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

  _server.listen(port, "0.0.0.0", () => {
    console.log();
    console.log(chalk.cyan("  ╔══════════════════════════════════════════╗"));
    console.log(chalk.cyan(`  ║  🌐 Dashboard: http://0.0.0.0:${port}       ║`));
    console.log(chalk.cyan("  ╚══════════════════════════════════════════╝"));
    console.log();
  });

  setInterval(() => { if (_io) _io.emit("stats-update", getStats()); }, 5000);
  return { app, server: _server, io: _io };
}

module.exports = { startDashboard, getIO, interceptLogs };
