"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT        = path.join(__dirname, "..");
const CFG_FILE    = path.join(__dirname, "devhub-config.json");
const OR_CFG_FILE = path.join(__dirname, "devhub-openrouter.json");
const ZAO_SETTINGS_FILE = path.join(ROOT, "ZAO-SETTINGS.json");

// ─── ZAO-SETTINGS helpers ─────────────────────────────────────────────────────
function loadZaoSettings() {
  try { return JSON.parse(fs.readFileSync(ZAO_SETTINGS_FILE, "utf8")); }
  catch(_) { return {}; }
}
function saveZaoSettings(patch) {
  const cur = loadZaoSettings();
  const updated = Object.assign(cur, patch);
  fs.writeFileSync(ZAO_SETTINGS_FILE, JSON.stringify(updated, null, 2), "utf8");
}

// ─── OpenRouter config ────────────────────────────────────────────────────────
// Key comes from ZAO-SETTINGS.json (openrouterKeyInternal).
// Models remain in devhub-openrouter.json so they can be changed from the panel.
function loadOpenRouterCfg() {
  const zao = loadZaoSettings();
  let models = ["openai/gpt-4o-mini","meta-llama/llama-3.3-70b-instruct:free","google/gemma-2-9b-it:free"];
  // Primary source: openrouterModelsInternal in ZAO-SETTINGS.json
  if (Array.isArray(zao.openrouterModelsInternal) && zao.openrouterModelsInternal.length) {
    models = zao.openrouterModelsInternal.slice(0, 3);
  } else {
    // Fallback: devhub-openrouter.json (legacy per-panel config)
    try {
      const c = JSON.parse(fs.readFileSync(OR_CFG_FILE, "utf8"));
      if (Array.isArray(c.models) && c.models.length) models = c.models.slice(0, 3);
    } catch(_) {}
  }
  return { apiKey: zao.openrouterKeyInternal || "", models };
}

function saveOpenRouterCfg(c) {
  if (c.apiKey !== undefined) saveZaoSettings({ openrouterKeyInternal: c.apiKey });
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(OR_CFG_FILE, "utf8")); } catch(_) {}
  if (Array.isArray(c.models)) existing.models = c.models;
  fs.writeFileSync(OR_CFG_FILE, JSON.stringify(existing, null, 2));
}
const VERSIONS_F = path.join(__dirname, "devhub-versions.json");

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch(_) { return { githubTokenEnc:"", baseRepo:"ZAO-Bot", baseOwner:"", chatHistory:[], claudeHistory:[] }; }
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); }
function encToken(t) { return Buffer.from(String(t),"utf8").toString("base64"); }
function decToken(t) { try { return Buffer.from(String(t),"base64").toString("utf8"); } catch(_){ return ""; } }
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return decToken(loadCfg().githubTokenEnc||""); } catch(_){ return ""; }
}
function loadVersions() { try { return JSON.parse(fs.readFileSync(VERSIONS_F,"utf8")); } catch(_){ return []; } }
function saveVersions(v) { fs.writeFileSync(VERSIONS_F, JSON.stringify(v,null,2)); }

// ─── ZAO File Scanner ────────────────────────────────────────────────────────
const SCAN_DIRS = ["SCRIPTS/ZAO-CMDS","SCRIPTS/ZAO-EVTS","includes","utils","webpanel","data",""];
const SKIP_DIRS = new Set(["node_modules",".git",".cache",".local","assets","images","backups","DB/data"]);
const SCAN_EXTS = new Set([".js",".json",".md",".txt",".yaml",".yml",".sh"]);

function listAllBotFiles() {
  const result = [];
  function scan(dir, depth=0) {
    if (depth>4) return;
    const full = dir ? path.join(ROOT,dir) : ROOT;
    try {
      const items = fs.readdirSync(full,{withFileTypes:true});
      for (const item of items) {
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) { if (!SKIP_DIRS.has(item.name)) scan(rel, depth+1); }
        else if (SCAN_EXTS.has(path.extname(item.name).toLowerCase())) result.push(rel);
      }
    } catch(_) {}
  }
  for (const dir of SCAN_DIRS) scan(dir, 0);
  return [...new Set(result)].slice(0,300);
}

function getFileTree() {
  const files = listAllBotFiles();
  const mapped = files.map(f => {
    const full = path.join(ROOT,f);
    let size = 0;
    try { size = fs.statSync(full).size; } catch(_) {}
    return { path:f, size };
  });
  return { files:mapped };
}

function readBotFile(relPath) {
  try { return fs.readFileSync(path.join(ROOT,relPath),"utf8").slice(0,50000); }
  catch(e) { return "Error: "+e.message; }
}

function writeBotFile(relPath, content) {
  const full = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full, content, "utf8");
}

function buildAutoContext(CMDS_PATH, SETTINGS_PATH) {
  const parts = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH,"utf8"));
    parts.push(`=== إعدادات ZAO Bot ===
اللغة: ${cfg.language||"—"}
adminOnly: ${cfg.adminOnly??"false"}
humanTyping: ${cfg.humanTyping??"false"}
mqttHealthCheck: ${cfg.mqttHealthCheck??"false"}
DeveloperMode: ${cfg.DeveloperMode??"false"}
الإشعارات: ${cfg.notiWhenListenMqttError?.enable??"false"}`);
  } catch(_) {}

  try {
    const cmds = fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith(".js"));
    parts.push(`=== أوامر ZAO Bot (${cmds.length} أمر) ===\n${cmds.join(", ")}`);
  } catch(_) {}

  try {
    const evts = fs.readdirSync(path.join(ROOT,"SCRIPTS","ZAO-EVTS")).filter(f=>f.endsWith(".js"));
    parts.push(`=== أحداث ZAO Bot (${evts.length} حدث) ===\n${evts.join(", ")}`);
  } catch(_) {}

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT,"package.json"),"utf8"));
    parts.push(`=== معلومات المشروع ===\nالاسم: ${pkg.name}, الإصدار: ${pkg.version}`);
  } catch(_) {}

  // Sample command for format reference
  try {
    const files = fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith(".js"));
    for (const f of files.slice(0,3)) {
      const content = fs.readFileSync(path.join(CMDS_PATH,f),"utf8").slice(0,3000);
      parts.push(`=== مثال أمر ZAO (${f}) ===\n${content}`);
      break;
    }
  } catch(_) {}

  return parts.join("\n\n");
}

// ─── GitHub API helper ────────────────────────────────────────────────────────
async function ghApi(token, method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "ZAO-DevHub/1.0"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub API error ${res.status}`);
  return data;
}

// ─── AI helper — OpenRouter ───────────────────────────────────────────────────
// Queue serialises all AI requests so parallel DevHub usage doesn't pile up.
let _aiQueueChain = Promise.resolve();

/**
 * callAI(model, messages)
 * Uses OpenRouter API with the models configured in devhub-openrouter.json.
 * Tries each model in order and resolves with the first successful reply.
 * The `model` parameter is kept for API compatibility but ignored — the
 * configured models list is always used.
 */
async function callAI(_model, messages) {
  return new Promise((resolve, reject) => {
    _aiQueueChain = _aiQueueChain.then(async () => {
      const cfg = loadOpenRouterCfg();
      if (!cfg.apiKey) {
        reject(new Error(
          "🔑 OpenRouter API key غير موجود.\n" +
          "اذهب إلى DevHub ← الإعدادات ← OpenRouter وأدخل مفتاح API."
        ));
        return;
      }

      const headers = {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "HTTP-Referer":  "https://zaobot.replit.app",
        "X-Title":       "ZAO DevHub"
      };

      let lastErr = "لا توجد موديلات محددة";

      for (const mdl of cfg.models) {
        if (!mdl || !mdl.trim()) continue;
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        try {
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
              model:       mdl.trim(),
              messages,
              max_tokens:  1024,
              temperature: 0.7
            })
          });
          clearTimeout(timer);

          let data;
          try { data = await res.json(); } catch (_) {
            lastErr = `استجابة غير JSON من ${mdl} (HTTP ${res.status})`;
            continue;
          }
          if (!res.ok) {
            lastErr = data?.error?.message || `HTTP ${res.status} من ${mdl}`;
            continue;
          }
          if (data?.error) {
            lastErr = data.error?.message || JSON.stringify(data.error).slice(0, 120);
            continue;
          }
          const reply = data?.choices?.[0]?.message?.content;
          if (reply?.trim()) { resolve(reply.trim()); return; }
          lastErr = `رد فارغ من ${mdl}`;
        } catch (e) {
          clearTimeout(timer);
          lastErr = e.name === "AbortError"
            ? `انتهت مهلة ${mdl} (45 ث)`
            : (e.message || String(e));
        }
      }

      reject(new Error(`فشل الذكاء الاصطناعي: ${lastErr}`));
    }).catch(() => {});
  });
}

// ─── AI Agents ────────────────────────────────────────────────────────────────
const AGENTS = {
  analyst: {
    name:"المحلل", model:"openai-fast", icon:"🔍", color:"#00d4ff",
    systemPrompt:`أنت المحلل الأول في فريق تطوير ZAO Bot — بوت فيسبوك Messenger مبني على Node.js.

=== هيكل ZAO Bot ===
- SCRIPTS/ZAO-CMDS/*.js → أوامر البوت (كل أمر ملف مستقل)
- SCRIPTS/ZAO-EVTS/*.js → أحداث البوت
- ZAO-SETTINGS.json → إعدادات البوت الرئيسية
- Main.js → المشغّل ومراقب العمليات (watchdog)
- ZAO.js → البوت الرئيسي + منطق الأوامر
- ZAO-STATE.json, ZAO-STATEX.json, ZAO-STATEV.json → AppState (T1/T2/T3)
- includes/ → مكتبات: antiSuspension, humanTyping, mqttHealthCheck, motorPersist...
- webpanel/zao-server.js → لوحة التحكم (Express، port 5000)

=== قالب أوامر ZAO Bot ===
module.exports = {
  config: { name, version, author, countDown, hasPermssion, description, commandCategory, usages, guide },
  run: async function({ api, event, args, Users, Threads, Currencies }) { ... }
};
hasPermssion: 0=الجميع  1=مشرف_مجموعة  2=سوبر_مشرف

=== قواعد التحليل ===
- اقرأ الطلب وحدد: أمر جديد؟ تعديل؟ إصلاح؟ سؤال؟
- اذكر الملفات المتأثرة بالضبط
- حدد الخطوات بالترتيب
- أجب بالعربية، موجز ومركّز
- لا تكتب الكود — فقط التحليل والخطة`
  },
  implementer: {
    name:"المطور", model:"openai-fast", icon:"💻", color:"#a855f7",
    systemPrompt:`أنت المطور المنفذ في فريق ZAO Bot (Facebook Messenger، Node.js).

=== قالب أوامر ZAO Bot ===
\`\`\`javascript
module.exports = {
  config: {
    name:            "اسم_الأمر",
    version:         "1.0",
    author:          "ZAO",
    countDown:       5,
    hasPermssion:    0,    // 0=الجميع  1=مشرف  2=سوبر
    description:     "وصف الأمر",
    commandCategory: "عام",
    usages:          "[نص]",
    guide: { en: "  {pn} [نص] — شرح" }
  },
  run: async function({ api, event, args, Users, Threads, Currencies }) {
    const { senderID, threadID, messageID } = event;
    try {
      // منطق الأمر
      return api.sendMessage("✅ مرحباً!", threadID, messageID);
    } catch(e) {
      return api.sendMessage("❌ خطأ: " + e.message, threadID);
    }
  }
};
\`\`\`

=== قواعد الكود ===
- استخدم module.exports = { config, run } دائماً
- معالجة الأخطاء بـ try/catch دائماً
- api.sendMessage للرسائل، api.setMessageReaction للردود التفاعلية
- اكتب الكود الكامل القابل للنسخ مباشرةً
- أجب بالعربية مع الكود في \`\`\`javascript`
  },
  reviewer: {
    name:"المراجع", model:"openai", icon:"✅", color:"#00ff9f",
    systemPrompt:`أنت المراجع النهائي في فريق ZAO Bot.

مهمتك: راجع الكود وأعطِ حكماً نهائياً واضحاً.

=== ما تتحقق منه ===
1. هل يستخدم module.exports = { config, run } ؟
2. هل config يحتوي: name, version, author, countDown, hasPermssion, description, commandCategory ؟
3. هل hasPermssion صحيح؟ (0/1/2)
4. هل run يستخدم { api, event, args, Users, Threads, Currencies } ؟
5. هل هناك أخطاء syntax ؟
6. هل يعالج الأخطاء بـ try/catch ؟

=== صيغة الرد ===
**الحكم:** ✅ جاهز  أو  ⚠️ يحتاج تعديل  أو  ❌ لا يعمل
**السبب:** جملة أو جملتان
**إن وجد مشكلة:** اذكرها بالضبط وكيف تُصلحها

أجب بالعربية.`
  },
  guide: {
    name:"المرشد", model:"openai-fast", icon:"📚", color:"#ffc107",
    systemPrompt:`أنت مرشد تقني صديق لأشخاص يريدون تطوير بوتات فيسبوك مع ZAO Bot.
قواعد:
- أجب بالعربية البسيطة جداً
- تحدث كأنك تشرح لشخص لا يعرف البرمجة
- استخدم أمثلة عملية وبسيطة
- اشرح الخطوات بترتيب واضح
- كن مشجعاً وإيجابياً
- إذا احتجت كود ضعه في \`\`\`javascript مع شرح بسيط لكل سطر`
  },
  advisor: {
    name:"مستشار ZAO", model:"openai-fast", icon:"💡", color:"#ff3b6e",
    systemPrompt:`أنت مستشار ذكي متخصص في ZAO Bot (Facebook Messenger، Node.js).
دورك: تقرأ ملفات البوت وتجيب على الأسئلة وتقترح أفكاراً — فقط بالكلام، لا تكتب كوداً كاملاً.
قواعد:
- أجب بالعربية دائماً
- اقترح أفكاراً وتحسينات عملية لـ ZAO Bot
- إذا سألوا عن ميزة موجودة، اشرحها بالضبط
- ردود مختصرة ومفيدة`
  }
};

// ─── AI Monitor Engine ────────────────────────────────────────────────────────
const AI_MON_INTERVAL   = 45 * 1000;
const AI_MON_LINES      = 80;
const AI_MON_MAX_LOG    = 100;
const BOT_INTERNAL_URL  = 'http://127.0.0.1:3001';

const AI_MONITOR_SYSTEM = `You are an automated real-time monitor for ZAO Bot — a Node.js Facebook Messenger bot.
Analyze the provided bot logs and file contents. Detect bugs. Propose fixes only when safe to do so.

RESPOND IN VALID JSON ONLY — no markdown text outside the JSON block.

Response schema:
{
  "severity": "ok" | "warn" | "error",
  "summary": "one-line summary in Arabic (max 120 chars)",
  "errors": [
    {
      "type": "syntax" | "runtime" | "network" | "facebook" | "config" | "crash" | "other",
      "fixable": true | false,
      "description": "brief Arabic description",
      "file": "relative path (e.g. SCRIPTS/ZAO-CMDS/example.js) or null",
      "snippet": "exact relevant log line"
    }
  ],
  "fixes": [
    {
      "file": "SCRIPTS/ZAO-CMDS/example.js",
      "reason": "brief Arabic reason",
      "code": "COMPLETE corrected file content — not a diff"
    }
  ]
}

STRICT RULES — a bad fix is worse than no fix:
1. "fixes" ONLY for files under SCRIPTS/ZAO-CMDS/ or SCRIPTS/ZAO-EVTS/
2. NEVER fix: Main.js, ZAO.js, webpanel/, includes/, data/, *.json files
3. NEVER fix: Facebook login errors, checkpoint errors, MQTT disconnects, network errors — these are external
4. Only produce a fix when you can see the FULL current file content AND there is a clear syntax/runtime bug
5. "code" must be the COMPLETE corrected file (not a snippet)
6. Max 2 fixes per response
7. If no real errors, return severity:"ok" with empty arrays
8. Do not flag missing API keys as errors`;

global._aiMonitorLog     = global._aiMonitorLog     || [];
global._aiMonitorEnabled = global._aiMonitorEnabled !== undefined ? global._aiMonitorEnabled : true;
global._aiMonitorLastIdx = global._aiMonitorLastIdx || 0;
global._aiMonitorStarted = global._aiMonitorStarted || false;
global._aiMonitorScanning= false;

async function _botAPI(method, endpoint, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BOT_INTERNAL_URL}${endpoint}`, opts);
  return r.json().catch(() => ({}));
}

async function runAIScan() {
  const buf = global._mainLogBuffer || [];
  if (!buf.length) return null;

  const lastIdx = global._aiMonitorLastIdx;
  global._aiMonitorLastIdx = buf.length;

  // Always scan at least the last AI_MON_LINES lines
  const recentLines = buf.slice(Math.max(0, buf.length - AI_MON_LINES));
  if (!recentLines.length) return null;

  const logText = recentLines.map(e => (e && e.text) ? e.text : String(e)).join('\n');

  // Extract command/event files mentioned in logs for context injection
  const mentioned = [...new Set((logText.match(/SCRIPTS\/ZAO-(?:CMDS|EVTS)\/[\w.-]+\.js/g) || []))];
  const fileParts = [];
  for (const rel of mentioned.slice(0, 3)) {
    try {
      const full = path.join(ROOT, rel);
      if (fs.existsSync(full)) {
        fileParts.push(`--- ${rel} ---\n${fs.readFileSync(full, 'utf8').slice(0, 4000)}`);
      }
    } catch (_) {}
  }

  const userContent = `=== Recent Bot Logs (last ${recentLines.length} lines) ===\n${logText}${fileParts.length ? `\n\n=== File Contents ===\n${fileParts.join('\n\n')}` : ''}`;

  let aiResult = { severity: 'ok', summary: 'لا يوجد أخطاء', errors: [], fixes: [] };
  try {
    const raw = await callAI('openai', [
      { role: 'system', content: AI_MONITOR_SYSTEM },
      { role: 'user', content: userContent }
    ]);
    const jsonStr = (raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw])[1].trim();
    aiResult = JSON.parse(jsonStr);
  } catch (e) {
    aiResult = { severity: 'warn', summary: 'AI parse error: ' + e.message, errors: [], fixes: [] };
  }

  // Apply fixes via bot internal API
  const appliedFixes = [];
  for (const fix of (aiResult.fixes || []).slice(0, 2)) {
    if (!fix.file || !fix.code || fix.code.length < 20) continue;
    // Capture "before" content for the diff viewer
    let beforeContent = null;
    try {
      const fullP = path.join(ROOT, fix.file);
      if (fs.existsSync(fullP)) beforeContent = fs.readFileSync(fullP, 'utf8');
    } catch (_) {}
    try {
      const r = await _botAPI('POST', '/bot/patch-command', {
        relPath: fix.file, content: fix.code, reason: fix.reason || 'AI auto-fix'
      });
      appliedFixes.push({
        file:    fix.file,
        reason:  fix.reason || '',
        ok:      !!r.ok,
        reloaded:!!r.reloaded,
        error:   r.error || null,
        before:  beforeContent,
        after:   fix.code,
      });
    } catch (e) {
      appliedFixes.push({ file: fix.file, reason: fix.reason || '', ok: false, error: e.message, before: beforeContent, after: fix.code });
    }
  }

  const event = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2,6),
    ts: new Date().toISOString(),
    severity: aiResult.severity || 'ok',
    summary: aiResult.summary || '',
    errors: (aiResult.errors || []).slice(0, 10),
    proposedFixes: (aiResult.fixes || []).length,
    appliedFixes,
    linesScanned: recentLines.length,
    newLines: Math.max(0, buf.length - lastIdx),
  };

  global._aiMonitorLog.push(event);
  if (global._aiMonitorLog.length > AI_MON_MAX_LOG) global._aiMonitorLog.shift();
  return event;
}

function startAIMonitor() {
  if (global._aiMonitorStarted) return;
  global._aiMonitorStarted = true;

  const tick = async () => {
    if (!global._aiMonitorEnabled || global._aiMonitorScanning) return;
    global._aiMonitorScanning = true;
    try { await runAIScan(); } catch (_) {}
    global._aiMonitorScanning = false;
  };

  // First scan after 30s (let bot settle), then every 45s
  setTimeout(() => {
    tick();
    setInterval(tick, AI_MON_INTERVAL).unref();
  }, 30000).unref();
}

// ─── Multi-Agent Pipeline ──────────────────────────────────────────────────────
async function runMultiAgentPipeline(message, files, history, autoCtx) {
  const ctxParts = [];
  if (autoCtx) ctxParts.push(`=== السياق التلقائي لـ ZAO Bot ===\n${autoCtx}`);
  for (const f of (files||[])) ctxParts.push(`--- ${f.path} ---\n${f.content}`);
  const ctxStr = ctxParts.join("\n\n");

  const steps = [];
  const agentList = [AGENTS.analyst, AGENTS.implementer, AGENTS.reviewer];

  let prevReplies = "";
  for (const agent of agentList) {
    const msgs = [
      { role:"system", content:agent.systemPrompt },
      ...(history||[]).slice(-6),
      { role:"user", content:message + (ctxStr ? `\n\n${ctxStr}` : "") + (prevReplies ? `\n\n=== ما قاله الفريق حتى الآن ===\n${prevReplies}` : "") }
    ];
    try {
      const reply = await callAI(agent.model, msgs);
      steps.push({ name:agent.name, icon:agent.icon, color:agent.color, reply });
      prevReplies += `\n[${agent.name}]: ${reply.slice(0,500)}`;
    } catch(e) {
      steps.push({ name:agent.name, icon:agent.icon, color:agent.color, reply:`❌ فشل: ${e.message}` });
    }
  }
  return steps;
}

// ─── Register routes ──────────────────────────────────────────────────────────
module.exports.register = function registerDevHub(app, auth, options) {
  const { ROOT, CMDS_PATH, SETTINGS_PATH, DATA_DIR, layout, pageOpts, isBotOnline, readSettings, saveSettings } = options;

  function htmlEscape(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // ─── DevHub Main Page ──────────────────────────────────────────────────────
  app.get("/devhub", auth, (req,res) => {
    const cfg = loadCfg();
    const hasToken = !!loadToken();
    const stats = (() => {
      let cmds=0, evts=0;
      try { cmds=fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith(".js")).length; } catch(_) {}
      try { evts=fs.readdirSync(path.join(ROOT,"SCRIPTS","ZAO-EVTS")).filter(f=>f.endsWith(".js")).length; } catch(_) {}
      return { cmds, evts };
    })();

    const body = `
<div class="page-header">
  <div class="page-title">🤖 مركز التطوير</div>
  <div class="page-sub">مركز تطوير ZAO Bot المدعوم بالذكاء الاصطناعي</div>
</div>

<!-- Stats quick -->
<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-bottom:16px">
  <div class="stat stat-cyan"><div class="stat-glow"></div><div class="stat-icon">💬</div><div class="stat-val">${stats.cmds}</div><div class="stat-lbl">أوامر</div></div>
  <div class="stat stat-purple"><div class="stat-glow"></div><div class="stat-icon">⚡</div><div class="stat-val">${stats.evts}</div><div class="stat-lbl">أحداث</div></div>
  <div class="stat stat-green"><div class="stat-glow"></div><div class="stat-icon">🔗</div><div class="stat-val">${hasToken?"✅":"—"}</div><div class="stat-lbl">GitHub Token</div></div>
</div>

<!-- Tab Bar -->
<div style="display:flex;gap:2px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-md);padding:4px;margin-bottom:18px;flex-wrap:wrap">
  ${[["agents","🤖 الوكلاء"],["claude","💬 محادثة"],["quick","⚡ سريع"],["guide","📚 المرشد"],["advisor","💡 مستشار"],["monitor","🧠 مراقب AI"],["github","🐙 GitHub"],["files","🗂 الملفات"],["create","🆕 إنشاء أمر"],["settings","⚙️ إعدادات"]].map(([id,label])=>`
    <button id="dhtab_${id}" onclick="showDHTab('${id}')" style="flex:1;min-width:80px;padding:7px 12px;border-radius:8px;border:none;background:transparent;color:var(--text3);font-size:.78rem;font-weight:600;font-family:'Cairo',sans-serif;cursor:pointer;transition:all .2s">${label}</button>`).join("")}
</div>

<!-- Tab Contents -->
<div id="dh_agents" class="dh-tab">
${agentsTab(cfg)}
</div>

<div id="dh_claude" class="dh-tab" style="display:none">
${claudeTab()}
</div>

<div id="dh_quick" class="dh-tab" style="display:none">
${quickTab()}
</div>

<div id="dh_guide" class="dh-tab" style="display:none">
${guideTab()}
</div>

<div id="dh_advisor" class="dh-tab" style="display:none">
${advisorTab()}
</div>

<div id="dh_monitor" class="dh-tab" style="display:none">
${monitorTab()}
</div>

<div id="dh_github" class="dh-tab" style="display:none">
${githubTab(cfg, hasToken)}
</div>

<div id="dh_files" class="dh-tab" style="display:none">
${filesTab()}
</div>

<div id="dh_create" class="dh-tab" style="display:none">
${createCmdTab()}
</div>

<div id="dh_settings" class="dh-tab" style="display:none">
${settingsTab(cfg, hasToken)}
</div>

<style>
.dh-tab{animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.chat-box{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px;max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.chat-box::-webkit-scrollbar{width:4px}
.chat-box::-webkit-scrollbar-thumb{background:var(--bg5)}
.msg{padding:10px 13px;border-radius:10px;font-size:.84rem;line-height:1.6}
.msg.user{background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.2);color:var(--text);align-self:flex-end;max-width:80%;border-radius:10px 10px 2px 10px;text-align:right}
.msg.ai{background:var(--bg4);border:1px solid var(--border);color:var(--text2);white-space:pre-wrap}
.msg.thinking{background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.2);color:var(--text3);font-style:italic}
.quick-actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.qa-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);font-size:.76rem;padding:5px 11px;border-radius:20px;cursor:pointer;font-family:'Cairo',sans-serif;transition:all .2s}
.qa-btn:hover{border-color:rgba(0,212,255,.4);color:var(--accent)}
.dh-input-row{display:flex;gap:8px;margin-top:10px;align-items:flex-end}
.dh-input-row textarea{flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:9px 12px;font-size:.84rem;font-family:'Cairo',sans-serif;resize:none;outline:none;line-height:1.5}
.dh-input-row textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-glow)}
.step-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;margin-bottom:10px}
.step-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-weight:700;font-size:.86rem}
.gh-file-item{padding:7px 10px;border-radius:6px;cursor:pointer;font-size:.82rem;color:var(--text2);display:flex;align-items:center;gap:8px;transition:background .15s}
.gh-file-item:hover,.gh-file-item.active{background:rgba(0,212,255,.08);color:var(--text)}
.gh-code{width:100%;background:#03040d;color:#cdd6f4;font-family:'Courier New',monospace;font-size:.78rem;line-height:1.7;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);resize:vertical;outline:none;min-height:220px}
.gh-code:focus{border-color:var(--accent)}
</style>

<script>
let activeTab='agents';
let chatHistory=[];
let claudeHistory=[];
let guideHistory=[];
let advisorHistory=[];
let _autoCtx='';
let _ghFiles=[];
let _ghCurrent=null;
let _ghLastAI=null;

function showDHTab(id){
  document.querySelectorAll('.dh-tab').forEach(el=>el.style.display='none');
  document.getElementById('dh_'+id).style.display='';
  document.querySelectorAll('[id^=dhtab_]').forEach(btn=>{
    const isActive=btn.id==='dhtab_'+id;
    btn.style.background=isActive?'rgba(0,212,255,.12)':'transparent';
    btn.style.color=isActive?'var(--accent)':'var(--text3)';
  });
  activeTab=id;
  if(id==='agents'&&!_autoCtx)loadAutoCtx();
}

async function loadAutoCtx(){
  try{const r=await fetch('/api/devhub/bot/context');const d=await r.json();if(d.ok)_autoCtx=d.context;}catch(_){}
}

// ── Common message helpers ──────────────────────────────────────────────────
function appendMsg(boxId, role, icon, color, text){
  const box=document.getElementById(boxId);if(!box)return;
  const div=document.createElement('div');
  div.className='msg '+role;
  div.style.borderColor=color?'rgba('+hexToRgb(color)+',.3)':'';
  div.innerHTML=role==='user'?escH(text):\`<span style="font-size:.78rem;font-weight:700;color:\${color||'var(--accent)'}">\${icon||'🤖'} \${escH(icon?'':'')+escH('')}</span><div style="white-space:pre-wrap;margin-top:4px">\${mdToHtml(text)}</div>\`;
  box.appendChild(div);box.scrollTop=box.scrollHeight;
}
function appendUserMsg(boxId,text){const box=document.getElementById(boxId);if(!box)return;const div=document.createElement('div');div.className='msg user';div.textContent=text;box.appendChild(div);box.scrollTop=box.scrollHeight}
function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function hexToRgb(hex){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return r+','+g+','+b}
function mdToHtml(text){
  return escH(text)
    .replace(/\`\`\`(?:javascript|js|json|bash|sh)?\\n([\\s\\S]*?)\`\`\`/g,'<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin:6px 0;font-family:monospace;font-size:.78rem;overflow-x:auto;white-space:pre">$1</div>')
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong style="color:var(--text)">$1</strong>')
    .replace(/\\n/g,'<br>');
}

// ── Agents Tab ──────────────────────────────────────────────────────────────
async function sendToAgents(){
  const inp=document.getElementById('agentsInput');const msg=inp.value.trim();if(!msg)return;
  const sendBtn=document.getElementById('agentsSendBtn');
  inp.value='';sendBtn.disabled=true;sendBtn.textContent='⏳';
  appendUserMsg('agentsBox',msg);
  chatHistory.push({role:'user',content:msg});
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='agentsThinking';thinking.textContent='⏳ الفريق يعمل... (قد يستغرق 30-60 ثانية)';
  document.getElementById('agentsBox').appendChild(thinking);
  document.getElementById('agentsBox').scrollTop=99999;
  try{
    const r=await fetch('/api/devhub/ai/pipeline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,history:chatHistory.slice(-6),autoCtx:_autoCtx})});
    const d=await r.json();
    const el=document.getElementById('agentsThinking');if(el)el.remove();
    if(d.ok&&d.steps){
      const box=document.getElementById('agentsBox');
      for(const step of d.steps){
        const div=document.createElement('div');div.className='step-card';
        div.innerHTML=\`<div class="step-head"><span>\${step.icon}</span><span style="color:\${step.color}">\${step.name}</span></div><div style="font-size:.84rem;line-height:1.6;white-space:pre-wrap">\${mdToHtml(step.reply)}</div>\`;
        box.appendChild(div);
      }
      box.scrollTop=box.scrollHeight;
      chatHistory.push({role:'assistant',content:d.steps.map(s=>s.reply).join('\\n\\n')});
    } else{
      appendMsg('agentsBox','ai','❌','var(--red)',d.error||'فشل');
    }
  }catch(e){const el=document.getElementById('agentsThinking');if(el)el.remove();appendMsg('agentsBox','ai','❌','var(--red)',e.message);}
  finally{sendBtn.disabled=false;sendBtn.textContent='⚡ إرسال';}
}
function agentsQuick(q){document.getElementById('agentsInput').value=q;sendToAgents()}
function clearAgents(){document.getElementById('agentsBox').innerHTML='';chatHistory=[];}

// ── Claude / Single Tab ─────────────────────────────────────────────────────
async function sendToClaude(){
  const inp=document.getElementById('claudeInput');const msg=inp.value.trim();if(!msg)return;
  const sendBtn=document.getElementById('claudeSendBtn');
  inp.value='';sendBtn.disabled=true;sendBtn.textContent='⏳';
  appendUserMsg('claudeBox',msg);
  claudeHistory.push({role:'user',content:msg});
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='claudeThinking';thinking.textContent='⏳ AI يفكر... (20-60 ثانية)';
  document.getElementById('claudeBox').appendChild(thinking);
  document.getElementById('claudeBox').scrollTop=99999;
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),90000);
  try{
    const r=await fetch('/api/devhub/ai/single',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({model:'openai',message:msg,history:claudeHistory.slice(-10),autoCtx:_autoCtx})});
    clearTimeout(timer);const d=await r.json();
    const el=document.getElementById('claudeThinking');if(el)el.remove();
    if(d.ok){appendMsg('claudeBox','ai','💬','#a855f7',d.reply);claudeHistory.push({role:'assistant',content:d.reply});}
    else appendMsg('claudeBox','ai','❌','var(--red)',d.error||'فشل');
  }catch(e){clearTimeout(timer);const el=document.getElementById('claudeThinking');if(el)el.remove();appendMsg('claudeBox','ai','❌','var(--red)',e.name==='AbortError'?'انتهت مهلة الانتظار':e.message);}
  finally{sendBtn.disabled=false;sendBtn.textContent='إرسال';}
}
function clearClaude(){document.getElementById('claudeBox').innerHTML='';claudeHistory=[];}

// ── Quick ────────────────────────────────────────────────────────────────────
async function sendQuick(){
  const inp=document.getElementById('quickInput');const msg=inp.value.trim();if(!msg)return;
  const sendBtn=document.getElementById('quickSendBtn');
  inp.value='';sendBtn.disabled=true;sendBtn.textContent='⏳';
  appendUserMsg('quickBox',msg);
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='quickThinking';thinking.textContent='⏳ جارٍ الرد...';
  document.getElementById('quickBox').appendChild(thinking);
  document.getElementById('quickBox').scrollTop=99999;
  try{
    const r=await fetch('/api/devhub/ai/single',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'openai-fast',message:msg,history:[],autoCtx:_autoCtx})});
    const d=await r.json();const el=document.getElementById('quickThinking');if(el)el.remove();
    if(d.ok)appendMsg('quickBox','ai','⚡','#00d4ff',d.reply);
    else appendMsg('quickBox','ai','❌','var(--red)',d.error||'فشل');
  }catch(e){const el=document.getElementById('quickThinking');if(el)el.remove();appendMsg('quickBox','ai','❌','var(--red)',e.message);}
  finally{sendBtn.disabled=false;sendBtn.textContent='⚡';}
}

// ── Guide ────────────────────────────────────────────────────────────────────
async function sendToGuide(){
  const inp=document.getElementById('guideInput');const msg=inp.value.trim();if(!msg)return;
  const sendBtn=document.getElementById('guideSendBtn');
  inp.value='';sendBtn.disabled=true;sendBtn.textContent='⏳';
  appendUserMsg('guideBox',msg);
  guideHistory.push({role:'user',content:msg});
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='guideThinking';thinking.textContent='⏳ المرشد يفكر...';
  document.getElementById('guideBox').appendChild(thinking);
  document.getElementById('guideBox').scrollTop=99999;
  try{
    const r=await fetch('/api/devhub/ai/guide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,history:guideHistory.slice(-6),autoCtx:_autoCtx})});
    const d=await r.json();const el=document.getElementById('guideThinking');if(el)el.remove();
    if(d.ok){appendMsg('guideBox','ai','📚','#ffc107',d.reply);guideHistory.push({role:'assistant',content:d.reply});}
    else appendMsg('guideBox','ai','❌','var(--red)',d.error||'فشل');
  }catch(e){const el=document.getElementById('guideThinking');if(el)el.remove();appendMsg('guideBox','ai','❌','var(--red)',e.message);}
  finally{sendBtn.disabled=false;sendBtn.textContent='📚';}
}

// ── Advisor ──────────────────────────────────────────────────────────────────
async function sendToAdvisor(){
  const inp=document.getElementById('advisorInput');const msg=inp.value.trim();if(!msg)return;
  const sendBtn=document.getElementById('advisorSendBtn');
  inp.value='';sendBtn.disabled=true;sendBtn.textContent='⏳';
  appendUserMsg('advisorBox',msg);
  advisorHistory.push({role:'user',content:msg});
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='advisorThinking';thinking.textContent='⏳ المستشار يحلل...';
  document.getElementById('advisorBox').appendChild(thinking);
  document.getElementById('advisorBox').scrollTop=99999;
  try{
    const r=await fetch('/api/devhub/ai/advisor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,history:advisorHistory.slice(-6),autoCtx:_autoCtx})});
    const d=await r.json();const el=document.getElementById('advisorThinking');if(el)el.remove();
    if(d.ok){appendMsg('advisorBox','ai','💡','#ff3b6e',d.reply);advisorHistory.push({role:'assistant',content:d.reply});}
    else appendMsg('advisorBox','ai','❌','var(--red)',d.error||'فشل');
  }catch(e){const el=document.getElementById('advisorThinking');if(el)el.remove();appendMsg('advisorBox','ai','❌','var(--red)',e.message);}
  finally{sendBtn.disabled=false;sendBtn.textContent='💡';}
}

// ── GitHub File Browser ──────────────────────────────────────────────────────
async function ghLoadTree(){
  const owner=document.getElementById('ghOwner').value.trim();
  const repo=document.getElementById('ghRepo').value.trim();
  const branch=document.getElementById('ghBranch').value.trim()||'main';
  if(!owner||!repo)return showToast('أدخل المالك والريبو','error');
  const list=document.getElementById('ghFileList');
  list.innerHTML='<div style="padding:12px;color:var(--text3);font-size:.82rem">⏳ جارٍ التحميل...</div>';
  const r=await fetch(\`/api/devhub/github/tree?owner=\${encodeURIComponent(owner)}&repo=\${encodeURIComponent(repo)}&branch=\${encodeURIComponent(branch)}\`);
  const d=await r.json();
  if(!d.ok){list.innerHTML=\`<div style="padding:12px;color:var(--red);font-size:.82rem">❌ \${d.error||'فشل'}</div>\`;return}
  _ghFiles=d.files||[];
  document.getElementById('ghFileCount').textContent=_ghFiles.length+' ملف';
  list.innerHTML=_ghFiles.map(f=>{
    const name=f.path.split('/').pop();
    const ext=(f.path.split('.').pop()||'').toLowerCase();
    const icon=ext==='js'?'📜':ext==='json'?'📋':ext==='md'?'📖':'📄';
    return \`<div class="gh-file-item" onclick="ghOpenFile('\${escH(f.path)}')" title="\${escH(f.path)}">\${icon} \${escH(name)}<span style="margin-right:auto;font-size:.7rem;color:var(--text3)">\${f.size?Math.round(f.size/1024*10)/10+'KB':''}</span></div>\`;
  }).join('');
  showToast('✅ تم تحميل '+_ghFiles.length+' ملف','success');
}
async function ghOpenFile(fp){
  _ghCurrent=fp;
  document.querySelectorAll('.gh-file-item').forEach(el=>el.classList.remove('active'));
  const owner=document.getElementById('ghOwner').value.trim();
  const repo=document.getElementById('ghRepo').value.trim();
  const branch=document.getElementById('ghBranch').value.trim()||'main';
  document.getElementById('ghEditor').value='⏳ جارٍ التحميل...';
  document.getElementById('ghCrumb').textContent=fp;
  const r=await fetch(\`/api/devhub/github/file?owner=\${encodeURIComponent(owner)}&repo=\${encodeURIComponent(repo)}&branch=\${encodeURIComponent(branch)}&path=\${encodeURIComponent(fp)}\`);
  const d=await r.json();
  if(d.ok)document.getElementById('ghEditor').value=d.content;
  else{document.getElementById('ghEditor').value='';showToast('❌ '+(d.error||'فشل'),'error')}
}
async function ghSaveFile(){
  if(!_ghCurrent)return showToast('اختر ملفاً أولاً','error');
  const owner=document.getElementById('ghOwner').value.trim();
  const repo=document.getElementById('ghRepo').value.trim();
  const branch=document.getElementById('ghBranch').value.trim()||'main';
  const content=document.getElementById('ghEditor').value;
  const commitMsg=prompt('رسالة الـ commit:','✏️ تعديل: '+_ghCurrent.split('/').pop())||'✏️ تعديل';
  const r=await fetch('/api/devhub/github/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,repo,branch,path:_ghCurrent,content,commitMsg})});
  const d=await r.json();
  if(d.ok)showToast('✅ تم الحفظ على GitHub','success');
  else showToast('❌ '+(d.error||'فشل'),'error');
}
async function ghAskAI(){
  const msg=document.getElementById('ghAiInput').value.trim();if(!msg)return;
  const editor=document.getElementById('ghEditor').value;
  const fileCtx=_ghCurrent&&editor?\`\\n\\nالملف: \${_ghCurrent}\\n\\\`\\\`\\\`javascript\\n\${editor.slice(0,3000)}\\n\\\`\\\`\\\`\`:'';
  document.getElementById('ghAiInput').value='';
  const box=document.getElementById('ghAiBox');
  appendUserMsg('ghAiBox',msg);
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='ghAiThinking';thinking.textContent='⏳ Claude يفكر...';
  box.appendChild(thinking);box.scrollTop=box.scrollHeight;
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),90000);
  try{
    const r=await fetch('/api/devhub/ai/claude',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({message:msg+fileCtx})});
    clearTimeout(timer);const d=await r.json();
    const el=document.getElementById('ghAiThinking');if(el)el.remove();
    if(d.ok){
      const codeMatch=d.reply.match(/\`\`\`(?:javascript|js)?[\\r\\n]([\\s\\S]*?)\`\`\`/);
      if(codeMatch){_ghLastAI=codeMatch[1].trim();const applyBtn=\`<button class="btn btn-success btn-sm" style="margin-top:8px;width:100%" onclick="ghApplyAI()">✨ تطبيق في المحرر</button>\`;appendMsg('ghAiBox','ai','🤖','#a855f7',d.reply);box.lastChild.innerHTML+=applyBtn;}
      else{_ghLastAI=null;appendMsg('ghAiBox','ai','🤖','#a855f7',d.reply);}
    } else appendMsg('ghAiBox','ai','❌','var(--red)',d.error||'فشل');
  }catch(e){clearTimeout(timer);const el=document.getElementById('ghAiThinking');if(el)el.remove();appendMsg('ghAiBox','ai','❌','var(--red)',e.name==='AbortError'?'انتهت مهلة الانتظار':e.message);}
}
function ghApplyAI(){if(!_ghLastAI)return showToast('اسأل AI أولاً','error');document.getElementById('ghEditor').value=_ghLastAI;showToast('✅ تم التطبيق في المحرر — اضغط حفظ للرفع','success')}
function ghClearAI(){document.getElementById('ghAiBox').innerHTML='<div class="msg thinking">اختر ملفاً واسألني عنه</div>';_ghLastAI=null}

// ── Create Command ────────────────────────────────────────────────────────────
async function mcGenerate(){
  const name=(document.getElementById('mcName').value.trim().replace(/[^a-zA-Z0-9_\\-]/g,'')||'custom').toLowerCase();
  const desc=document.getElementById('mcDesc').value.trim();
  if(!desc)return showToast('اكتب وصف الأمر أولاً','error');
  const btn=document.getElementById('mcGenBtn');btn.disabled=true;btn.textContent='⏳ AI يكتب...';
  document.getElementById('mcStatus').innerHTML='<span style="color:var(--text3)">⏳ الذكاء الاصطناعي يكتب الكود...</span>';
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),90000);
  try{
    const r=await fetch('/api/devhub/ai/generate-command',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({name,description:desc})});
    clearTimeout(timer);const d=await r.json();
    if(!d.ok)throw new Error(d.error||'فشل');
    document.getElementById('mcCode').value=d.code;
    document.getElementById('mcStep2').style.display='flex';
    document.getElementById('mcStatus').innerHTML='<span style="color:var(--green)">✅ تم توليد الكود — راجعه وعدّله إن أردت</span>';
  }catch(e){clearTimeout(timer);document.getElementById('mcStatus').innerHTML='<span style="color:var(--red)">❌ '+(e.name==='AbortError'?'انتهت المهلة':escH(e.message))+'</span>';}
  finally{btn.disabled=false;btn.textContent='🤖 AI يكتب الكود';}
}
function mcQuick(desc){document.getElementById('mcDesc').value=desc;mcGenerate()}
async function mcDeploy(){
  const name=(document.getElementById('mcName').value.trim().replace(/[^a-zA-Z0-9_\\-]/g,'')||'custom').toLowerCase();
  const code=document.getElementById('mcCode').value.trim();
  if(!code)return showToast('ولّد الكود أولاً','error');
  const st=document.getElementById('mcStatus');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الحفظ...</span>';
  const r=await api('/api/commands/create',{name,code});
  if(r.ok){st.innerHTML='<span style="color:var(--green)">✅ تم إنشاء وتشغيل الأمر!</span>';showToast('✅ الأمر '+name+' جاهز!','success');}
  else{st.innerHTML='<span style="color:var(--red)">❌ '+(r.error||'فشل')+'</span>';}
}
function mcRegenerate(){document.getElementById('mcCode').value='';document.getElementById('mcStep2').style.display='none';mcGenerate()}
async function mcCopyCode(){
  try{await navigator.clipboard.writeText(document.getElementById('mcCode').value);showToast('📋 تم النسخ','success')}catch(_){showToast('تعذّر النسخ','error')}
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function saveDevHubSettings(){
  const token=document.getElementById('ghTokenInput').value.trim();
  const owner=document.getElementById('settingsOwner').value.trim();
  const repo=document.getElementById('settingsRepo').value.trim();
  const r=await api('/api/devhub/settings',{githubToken:token,defaultOwner:owner,defaultRepo:repo});
  if(r.ok){showToast('✅ تم الحفظ','success');if(token&&token!=='••••••••')document.getElementById('ghTokenInput').value='••••••••';}
  else showToast('❌ '+(r.error||'فشل'),'error');
}

async function saveOpenRouterSettings(){
  const apiKey=document.getElementById('orApiKey').value.trim();
  const model0=document.getElementById('orModel0').value.trim();
  const model1=document.getElementById('orModel1').value.trim();
  const model2=document.getElementById('orModel2').value.trim();
  const r=await api('/api/devhub/openrouter',{apiKey,model0,model1,model2});
  if(r.ok){
    showToast('✅ تم حفظ إعدادات OpenRouter','success');
    if(apiKey&&apiKey!=='••••••••')document.getElementById('orApiKey').value='••••••••';
  } else showToast('❌ '+(r.error||'فشل'),'error');
}
async function pushToGitHub(){
  const repo=document.getElementById('pushRepo').value.trim();
  const owner=document.getElementById('pushOwner').value.trim();
  const branch=document.getElementById('pushBranch').value.trim()||'main';
  const msg=document.getElementById('pushMsg').value.trim()||'🚀 Push from ZAO Panel';
  if(!repo||!owner)return showToast('أدخل المالك والريبو','error');
  const st=document.getElementById('pushStatus');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الرفع...</span>';
  const r=await api('/api/devhub/github/push-all',{repo,owner,branch,commitMsg:msg});
  if(r.ok){st.innerHTML=\`<span style="color:var(--green)">✅ تم الرفع! <a href="\${r.url}" target="_blank" style="color:var(--accent)">🔗 GitHub</a></span>\`;showToast('✅ تم رفع الكود','success')}
  else{st.innerHTML=\`<span style="color:var(--red)">❌ \${r.error||'فشل'}</span>\`;}
}

// Keyboard shortcuts
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.key==='Enter'){
    if(activeTab==='agents')sendToAgents();
    else if(activeTab==='claude')sendToClaude();
    else if(activeTab==='quick')sendQuick();
    else if(activeTab==='guide')sendToGuide();
    else if(activeTab==='advisor')sendToAdvisor();
  }
});

// Init
(async function init(){
  try{
    const r=await fetch('/api/devhub/chat/history');const d=await r.json();
    if(d.chatHistory?.length){chatHistory=d.chatHistory;d.chatHistory.slice(-5).forEach(m=>{if(m.role==='user')appendUserMsg('agentsBox',m.content);else appendMsg('agentsBox','ai','🤖','#00d4ff',m.content)});}
    if(d.claudeHistory?.length){claudeHistory=d.claudeHistory;d.claudeHistory.slice(-4).forEach(m=>{if(m.role==='user')appendUserMsg('claudeBox',m.content);else appendMsg('claudeBox','ai','💬','#a855f7',m.content)});}
  }catch(_){}
  if(!chatHistory.length)appendMsg('agentsBox','ai','🤖','#00d4ff','مرحباً بك في مركز التطوير! 🚀\\n\\n🔍 **المحلل** — يحلل ويخطط\\n💻 **المطور** — يكتب الكود لـ ZAO Bot\\n✅ **المراجع** — يراجع ويتحقق\\n\\nجرّب أحد الأزرار السريعة أو اكتب طلبك. **Ctrl+Enter** للإرسال.');
  appendMsg('guideBox','ai','📚','#ffc107','مرحباً! 👋 أنا هنا لمساعدتك في ZAO Bot حتى لو لا تعرف البرمجة. اسألني أي شيء!');
  appendMsg('advisorBox','ai','💡','#ff3b6e','مرحباً! أنا مستشارك لـ ZAO Bot. أقرأ ملفات البوت وأجيب على أسئلتك وأقترح تحسينات. اسألني!');
  loadAutoCtx();
})();
</script>`;

    res.send(layout("مركز التطوير", body, "devhub", pageOpts()));
  });

  // ─── GitHub Files Page ──────────────────────────────────────────────────────
  app.get("/github-files", auth, (req,res) => {
    const cfg = loadCfg();
    const body = `
<div class="page-header">
  <div class="page-title">🗂 ملفات GitHub</div>
  <div class="page-sub">تصفّح وتعديل ملفات أي ريبو مباشرة من اللوحة</div>
</div>
<div style="display:grid;grid-template-columns:1fr 1.6fr;gap:14px;align-items:start">
  <div>
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <input type="text" id="ghOwner2" class="form-control" value="${htmlEscape(cfg.defaultOwner||'')}" placeholder="المالك" style="flex:1;min-width:100px;margin:0"/>
        <input type="text" id="ghRepo2"  class="form-control" value="${htmlEscape(cfg.defaultRepo||'')}" placeholder="الريبو" style="flex:1;min-width:100px;margin:0"/>
        <input type="text" id="ghBranch2" class="form-control" value="main" placeholder="الفرع" style="width:80px;margin:0"/>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="ghLoad2()">📥 تحميل</button>
        <span style="font-size:.76rem;color:var(--text3);align-self:center" id="ghCount2"></span>
      </div>
      <input type="text" id="ghSearch2" class="form-control" placeholder="🔍 بحث..." oninput="ghFilter2(this.value)" style="margin-top:8px"/>
    </div>
    <div class="card" style="padding:8px">
      <div id="ghList2" style="max-height:60vh;overflow-y:auto;font-size:.82rem">
        <div style="padding:16px;text-align:center;color:var(--text3)">اضغط تحميل للبدء</div>
      </div>
    </div>
  </div>
  <div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px">
        <code id="ghCrumb2" style="font-size:.8rem;color:var(--accent)">اختر ملفاً...</code>
        <div style="display:flex;gap:5px">
          <button class="btn btn-outline btn-sm" onclick="ghAskAI2()" title="اسأل AI عن الملف">🤖 AI</button>
          <button class="btn btn-success btn-sm" onclick="ghSave2()">💾 حفظ</button>
          <button class="btn btn-primary btn-sm" onclick="ghApplyAI2()">✨ AI Apply</button>
        </div>
      </div>
      <div id="ghEdStatus2" style="font-size:.75rem;min-height:18px;margin-bottom:4px"></div>
      <textarea id="ghEditor2" class="gh-code" style="min-height:400px" placeholder="اختر ملفاً من القائمة..."></textarea>
    </div>
    <div class="card" style="margin-top:0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-weight:700;font-size:.88rem">🤖 مساعد AI</div>
        <button class="btn btn-outline btn-sm" onclick="ghClearAI2()">🗑 مسح</button>
      </div>
      <div class="chat-box" id="ghAiBox2" style="max-height:220px">
        <div class="msg thinking">اختر ملفاً واسألني عنه أو اطلب مني تعديله</div>
      </div>
      <div class="dh-input-row" style="margin-top:8px">
        <textarea id="ghAiInput2" rows="2" placeholder="اسأل عن الملف المفتوح... (Ctrl+Enter)"></textarea>
        <button class="btn btn-primary" onclick="ghAsk2()" style="align-self:flex-end;padding:10px 14px">🤖</button>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
        ${["اشرح لي ما يفعله هذا الملف","ابحث عن الأخطاء وأصلحها","أضف تحسينات","اكتب النسخة الكاملة المحسّنة"].map(q=>`<button class="qa-btn" onclick="ghQuick2('${q}')">${q}</button>`).join("")}
      </div>
    </div>
  </div>
</div>

<style>
.gh-code{width:100%;background:#03040d;color:#cdd6f4;font-family:'Courier New',monospace;font-size:.79rem;line-height:1.7;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);resize:vertical;outline:none}
.gh-code:focus{border-color:var(--accent)}
.gh-file-item{padding:7px 10px;border-radius:6px;cursor:pointer;font-size:.82rem;color:var(--text2);display:flex;align-items:center;gap:8px;transition:background .15s}
.gh-file-item:hover,.gh-file-item.active{background:rgba(0,212,255,.08);color:var(--text)}
</style>

<script>
let _ghFiles2=[];let _ghCurrent2=null;let _ghLastAI2=null;
function ghFilter2(q){const lq=q.toLowerCase();document.querySelectorAll('#ghList2 .gh-file-item').forEach(el=>{el.style.display=el.dataset.path.toLowerCase().includes(lq)?'':'none'});}
async function ghLoad2(){
  const owner=document.getElementById('ghOwner2').value.trim();const repo=document.getElementById('ghRepo2').value.trim();const branch=document.getElementById('ghBranch2').value.trim()||'main';
  if(!owner||!repo)return showToast('أدخل المالك والريبو','error');
  const list=document.getElementById('ghList2');list.innerHTML='<div style="padding:12px;color:var(--text3)">⏳ جارٍ التحميل...</div>';
  const r=await fetch(\`/api/devhub/github/tree?owner=\${encodeURIComponent(owner)}&repo=\${encodeURIComponent(repo)}&branch=\${encodeURIComponent(branch)}\`);
  const d=await r.json();
  if(!d.ok){list.innerHTML=\`<div style="padding:12px;color:var(--red)">❌ \${d.error||'فشل'}</div>\`;return}
  _ghFiles2=d.files||[];document.getElementById('ghCount2').textContent=_ghFiles2.length+' ملف';
  list.innerHTML=_ghFiles2.map(f=>{const nm=f.path.split('/').pop();const ext=(nm.split('.').pop()||'').toLowerCase();const icon=ext==='js'?'📜':ext==='json'?'📋':ext==='md'?'📖':'📄';return \`<div class="gh-file-item" data-path="\${f.path}" onclick="ghOpen2('\${escH(f.path)}')">\${icon} \${escH(nm)}</div>\`;}).join('');
  showToast('✅ '+_ghFiles2.length+' ملف','success');
}
async function ghOpen2(fp){
  _ghCurrent2=fp;document.getElementById('ghCrumb2').textContent=fp;
  document.querySelectorAll('#ghList2 .gh-file-item').forEach(el=>el.classList.toggle('active',el.dataset.path===fp));
  document.getElementById('ghEditor2').value='⏳ جارٍ التحميل...';document.getElementById('ghEdStatus2').innerHTML='';
  const owner=document.getElementById('ghOwner2').value.trim();const repo=document.getElementById('ghRepo2').value.trim();const branch=document.getElementById('ghBranch2').value.trim()||'main';
  const r=await fetch(\`/api/devhub/github/file?owner=\${encodeURIComponent(owner)}&repo=\${encodeURIComponent(repo)}&branch=\${encodeURIComponent(branch)}&path=\${encodeURIComponent(fp)}\`);
  const d=await r.json();
  if(d.ok)document.getElementById('ghEditor2').value=d.content;
  else{document.getElementById('ghEditor2').value='';showToast('❌ '+(d.error||'فشل'),'error')}
}
async function ghSave2(){
  if(!_ghCurrent2)return showToast('اختر ملفاً أولاً','error');
  const commitMsg=prompt('رسالة commit:','✏️ '+_ghCurrent2.split('/').pop())||'✏️ تعديل';
  const owner=document.getElementById('ghOwner2').value.trim();const repo=document.getElementById('ghRepo2').value.trim();const branch=document.getElementById('ghBranch2').value.trim()||'main';
  const content=document.getElementById('ghEditor2').value;const st=document.getElementById('ghEdStatus2');
  st.innerHTML='<span style="color:var(--text3)">⏳ جارٍ الرفع...</span>';
  const r=await fetch('/api/devhub/github/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,repo,branch,path:_ghCurrent2,content,commitMsg})});
  const d=await r.json();
  if(d.ok){st.innerHTML=\`<span style="color:var(--green)">✅ محفوظ <a href="\${d.url}" target="_blank" style="color:var(--accent)">🔗</a></span>\`;showToast('✅ تم الحفظ','success')}
  else st.innerHTML=\`<span style="color:var(--red)">❌ \${d.error||'فشل'}</span>\`;
}
async function ghAsk2(){
  const msg=document.getElementById('ghAiInput2').value.trim();if(!msg)return;
  const editor=document.getElementById('ghEditor2').value;const fileCtx=_ghCurrent2&&editor?\`\\n\\nالملف: \${_ghCurrent2}\\n\\\`\\\`\\\`javascript\\n\${editor.slice(0,3000)}\\n\\\`\\\`\\\`\`:'';
  document.getElementById('ghAiInput2').value='';appendUserMsg('ghAiBox2',msg);
  const thinking=document.createElement('div');thinking.className='msg thinking';thinking.id='ghT2';thinking.textContent='⏳ AI يفكر...';document.getElementById('ghAiBox2').appendChild(thinking);document.getElementById('ghAiBox2').scrollTop=99999;
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),90000);
  try{
    const r=await fetch('/api/devhub/ai/claude',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({message:msg+fileCtx})});
    clearTimeout(timer);const d=await r.json();const el=document.getElementById('ghT2');if(el)el.remove();
    if(d.ok){const cm=d.reply.match(/\`\`\`(?:javascript|js)?[\\r\\n]([\\s\\S]*?)\`\`\`/);if(cm)_ghLastAI2=cm[1].trim();else _ghLastAI2=null;appendMsg('ghAiBox2','ai','🤖','#a855f7',d.reply);}
    else appendMsg('ghAiBox2','ai','❌','var(--red)',d.error||'فشل');
  }catch(e){clearTimeout(timer);const el=document.getElementById('ghT2');if(el)el.remove();appendMsg('ghAiBox2','ai','❌','var(--red)',e.name==='AbortError'?'انتهت المهلة':e.message);}
}
function ghAskAI2(){if(!_ghCurrent2)return showToast('اختر ملفاً','error');document.getElementById('ghAiInput2').value='اشرح لي هذا الملف';ghAsk2()}
function ghApplyAI2(){if(!_ghLastAI2)return showToast('اسأل AI أولاً','error');document.getElementById('ghEditor2').value=_ghLastAI2;showToast('✅ تم التطبيق','success')}
function ghClearAI2(){document.getElementById('ghAiBox2').innerHTML='<div class="msg thinking">اختر ملفاً واسألني عنه</div>';_ghLastAI2=null}
function ghQuick2(q){document.getElementById('ghAiInput2').value=q;ghAsk2()}
function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
document.getElementById('ghAiInput2').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();ghAsk2()}});
function appendUserMsg(boxId,text){const box=document.getElementById(boxId);if(!box)return;const div=document.createElement('div');div.className='msg user';div.textContent=text;box.appendChild(div);box.scrollTop=box.scrollHeight}
function appendMsg(boxId,role,icon,color,text){
  const box=document.getElementById(boxId);if(!box)return;const div=document.createElement('div');div.className='msg ai';
  div.innerHTML='<div style="font-size:.78rem;font-weight:700;color:'+(color||'var(--accent)')+'">'+icon+'</div><div style="margin-top:4px;white-space:pre-wrap;font-size:.84rem">'+mdToHtml(text)+'</div>';
  box.appendChild(div);box.scrollTop=box.scrollHeight;
}
function mdToHtml(text){return escH(text).replace(/\`\`\`(?:javascript|js|json|bash|sh)?\\n([\\s\\S]*?)\`\`\`/g,'<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin:6px 0;font-family:monospace;font-size:.78rem;overflow-x:auto;white-space:pre">$1</div>').replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\n/g,'<br>')}
</script>`;
    res.send(layout("ملفات GitHub", body, "github-files", pageOpts()));
  });

  // ─── DevHub API Routes ──────────────────────────────────────────────────────
  // Bot context
  app.get("/api/devhub/bot/context", auth, (req,res) => {
    try { res.json({ ok:true, context:buildAutoContext(CMDS_PATH, SETTINGS_PATH) }); }
    catch(e) { res.json({ error:e.message }); }
  });

  // File tree
  app.get("/api/devhub/file/tree", auth, (req,res) => {
    try { res.json({ ok:true, ...getFileTree() }); }
    catch(e) { res.json({ error:e.message }); }
  });

  // File read/write
  app.get("/api/devhub/file/read", auth, (req,res) => {
    const p = req.query.path || '';
    if (!p || p.includes('..')) return res.json({ error:'مسار غير صالح' });
    res.json({ ok:true, content:readBotFile(p) });
  });

  app.post("/api/devhub/file/write", auth, (req,res) => {
    const { path:p, content } = req.body;
    if (!p || p.includes('..')) return res.json({ error:'مسار غير صالح' });
    try { writeBotFile(p, content); res.json({ ok:true }); }
    catch(e) { res.json({ error:e.message }); }
  });

  // Chat history
  app.get("/api/devhub/chat/history", auth, (req,res) => {
    const cfg = loadCfg();
    res.json({ chatHistory:cfg.chatHistory||[], claudeHistory:cfg.claudeHistory||[] });
  });

  // AI Pipeline (multi-agent)
  app.post("/api/devhub/ai/pipeline", auth, async (req,res) => {
    try {
      const { message, files, history, autoCtx } = req.body;
      const steps = await runMultiAgentPipeline(message, files||[], history||[], autoCtx);
      const cfg = loadCfg();
      cfg.chatHistory = [...(cfg.chatHistory||[]).slice(-20), { role:"user", content:message }, ...steps.map(s=>({ role:"assistant", content:`[${s.name}]: ${s.reply}` }))];
      saveCfg(cfg);
      res.json({ ok:true, steps });
    } catch(e) { res.json({ error:e.message }); }
  });

  // AI Single
  app.post("/api/devhub/ai/single", auth, async (req,res) => {
    try {
      const { model, message, files, history, autoCtx } = req.body;
      const ctxParts = [];
      if (autoCtx) ctxParts.push(`=== السياق التلقائي لـ ZAO Bot ===\n${autoCtx}`);
      for (const f of (files||[])) ctxParts.push(`--- ${f.path} ---\n${f.content}`);
      const ctxStr = ctxParts.join("\n\n");
      const agentKey = model==="claude" ? "advisor" : model==="mistral" ? "implementer" : "analyst";
      const agent = AGENTS[agentKey] || AGENTS.analyst;
      const cfg = loadCfg();
      const savedHistory = (model==="claude" ? cfg.claudeHistory : cfg.chatHistory) || [];
      const combined = (history&&history.length) ? history : savedHistory.slice(-8);
      const msgs = [{ role:"system", content:agent.systemPrompt }, ...combined.slice(-8), { role:"user", content:message+(ctxStr?`\n\n${ctxStr}`:"") }];
      const reply = await callAI(model||"openai-fast", msgs);
      const histKey = model==="claude" ? "claudeHistory" : "chatHistory";
      cfg[histKey] = [...(cfg[histKey]||[]).slice(-20), { role:"user", content:message }, { role:"assistant", content:reply }];
      saveCfg(cfg);
      res.json({ ok:true, reply });
    } catch(e) { res.json({ error:e.message }); }
  });

  // AI Advisor
  app.post("/api/devhub/ai/advisor", auth, async (req,res) => {
    try {
      const { message, history, autoCtx } = req.body;
      const ctxStr = autoCtx ? `=== معلومات ZAO Bot ===\n${autoCtx}` : "";
      const msgs = [{ role:"system", content:AGENTS.advisor.systemPrompt }, ...(history||[]).slice(-6), { role:"user", content:message+(ctxStr?`\n\n${ctxStr}`:"") }];
      const reply = await callAI("openai-fast", msgs);
      res.json({ ok:true, reply });
    } catch(e) { res.json({ error:e.message }); }
  });

  // AI Guide
  app.post("/api/devhub/ai/guide", auth, async (req,res) => {
    try {
      const { message, history, autoCtx } = req.body;
      const ctxStr = autoCtx ? `=== معلومات ZAO Bot ===\n${autoCtx}` : "";
      const msgs = [{ role:"system", content:AGENTS.guide.systemPrompt }, ...(history||[]).slice(-6), { role:"user", content:message+(ctxStr?`\n\n${ctxStr}`:"") }];
      const reply = await callAI("openai-fast", msgs);
      res.json({ ok:true, reply });
    } catch(e) { res.json({ error:e.message }); }
  });

  // AI Claude (github files)
  app.post("/api/devhub/ai/claude", auth, async (req,res) => {
    try {
      const { message, history } = req.body;
      const msgs = [{ role:"system", content:AGENTS.advisor.systemPrompt }, ...(history||[]).slice(-6), { role:"user", content:message }];
      const reply = await callAI("openai", msgs);
      res.json({ ok:true, reply });
    } catch(e) { res.json({ error:e.message }); }
  });

  // AI Generate Command
  app.post("/api/devhub/ai/generate-command", auth, async (req,res) => {
    try {
      const { name, description } = req.body;
      const sampleCode = (() => {
        try {
          const files = fs.readdirSync(CMDS_PATH).filter(f=>f.endsWith(".js"));
          if (files.length) return fs.readFileSync(path.join(CMDS_PATH,files[0]),"utf8").slice(0,2000);
        } catch(_) {}
        return "";
      })();
      const msgs = [
        { role:"system", content:AGENTS.implementer.systemPrompt },
        { role:"user", content:`اكتب أمر ZAO Bot جديد بالاسم "${name}" يقوم بـ: ${description}\n\nالقالب المطلوب:\nmodule.exports = {\n  config: { name, version, author, countDown, hasPermssion, description, commandCategory, usages, guide },\n  run: async function({ api, event, args, Users, Threads, Currencies }) { ... }\n};\n\n${sampleCode ? `مثال من البوت للاسترشاد:\n${sampleCode}` : ""}\n\nاكتب الكود الكامل فقط في \`\`\`javascript بلوك واحد.` }
      ];
      const reply = await callAI("openai", msgs);
      const codeMatch = reply.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
      if (!codeMatch) throw new Error("لم يتم توليد كود صالح — حاول مجدداً");
      res.json({ ok:true, code:codeMatch[1].trim() });
    } catch(e) { res.json({ error:e.message }); }
  });

  // GitHub Tree
  app.get("/api/devhub/github/tree", auth, async (req,res) => {
    const { owner, repo, branch="main" } = req.query;
    if (!owner || !repo) return res.json({ error:"owner و repo مطلوبان" });
    const token = loadToken();
    if (!token) return res.json({ error:"لم يتم ضبط GitHub Token. اذهب لـ إعدادات DevHub." });
    try {
      const data = await ghApi(token, "GET", `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
      const files = (data.tree||[]).filter(f=>f.type==="blob").map(f=>({ path:f.path, size:f.size||0 }));
      res.json({ ok:true, files });
    } catch(e) { res.json({ error:e.message }); }
  });

  // GitHub File Read
  app.get("/api/devhub/github/file", auth, async (req,res) => {
    const { owner, repo, branch="main", path:filePath } = req.query;
    if (!owner || !repo || !filePath) return res.json({ error:"owner و repo و path مطلوبة" });
    const token = loadToken();
    if (!token) return res.json({ error:"لم يتم ضبط GitHub Token" });
    try {
      const data = await ghApi(token, "GET", `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`);
      const content = Buffer.from(data.content||"","base64").toString("utf8");
      res.json({ ok:true, content, sha:data.sha });
    } catch(e) { res.json({ error:e.message }); }
  });

  // GitHub File Write
  app.post("/api/devhub/github/file", auth, async (req,res) => {
    const { owner, repo, branch="main", path:filePath, content, commitMsg="✏️ Update via ZAO Panel" } = req.body;
    if (!owner || !repo || !filePath || content===undefined) return res.json({ error:"حقول مطلوبة مفقودة" });
    const token = loadToken();
    if (!token) return res.json({ error:"لم يتم ضبط GitHub Token" });
    try {
      // Get current SHA
      let sha;
      try { const cur = await ghApi(token,"GET",`/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`); sha=cur.sha; } catch(_) {}
      const body = { message:commitMsg, content:Buffer.from(content,"utf8").toString("base64"), branch };
      if (sha) body.sha = sha;
      await ghApi(token, "PUT", `/repos/${owner}/${repo}/contents/${filePath}`, body);
      res.json({ ok:true, url:`https://github.com/${owner}/${repo}/blob/${branch}/${filePath}` });
    } catch(e) { res.json({ error:e.message }); }
  });

  // GitHub Push All
  app.post("/api/devhub/github/push-all", auth, async (req,res) => {
    const { repo, owner, branch="main", commitMsg="🚀 Push from ZAO Panel" } = req.body;
    if (!repo || !owner) return res.json({ error:"repo و owner مطلوبان" });
    const token = loadToken();
    if (!token) return res.json({ error:"لم يتم ضبط GitHub Token" });
    try {
      const files = listAllBotFiles().slice(0,50);
      let pushed=0, failed=0;
      for (const f of files) {
        try {
          const content = readBotFile(f);
          let sha;
          try { const cur=await ghApi(token,"GET",`/repos/${owner}/${repo}/contents/${f}?ref=${branch}`); sha=cur.sha; } catch(_) {}
          const body = { message:commitMsg+` [${f}]`, content:Buffer.from(content,"utf8").toString("base64"), branch };
          if (sha) body.sha=sha;
          await ghApi(token,"PUT",`/repos/${owner}/${repo}/contents/${f}`,body);
          pushed++;
          await new Promise(r=>setTimeout(r,300)); // rate limit
        } catch(_) { failed++; }
      }
      res.json({ ok:true, pushed, failed, url:`https://github.com/${owner}/${repo}` });
    } catch(e) { res.json({ error:e.message }); }
  });

  // GitHub Repos
  app.get("/api/devhub/github/repos", auth, async (req,res) => {
    const token = loadToken();
    if (!token) return res.json({ error:"لم يتم ضبط GitHub Token" });
    try {
      const repos = await ghApi(token,"GET","/user/repos?per_page=50&sort=updated");
      res.json({ ok:true, repos:repos.map(r=>({ name:r.name, private:r.private, html_url:r.html_url, description:r.description||'' })) });
    } catch(e) { res.json({ error:e.message }); }
  });

  // DevHub Settings
  app.post("/api/devhub/settings", auth, (req,res) => {
    try {
      const { githubToken, defaultOwner, defaultRepo } = req.body;
      const cfg = loadCfg();
      if (githubToken && githubToken !== "••••••••") cfg.githubTokenEnc = encToken(githubToken);
      if (defaultOwner !== undefined) cfg.defaultOwner = defaultOwner;
      if (defaultRepo !== undefined) cfg.defaultRepo = defaultRepo;
      saveCfg(cfg);
      res.json({ ok:true });
    } catch(e) { res.json({ error:e.message }); }
  });

  app.get("/api/devhub/settings", auth, (req,res) => {
    const cfg = loadCfg();
    res.json({ ok:true, hasToken:!!loadToken(), defaultOwner:cfg.defaultOwner||'', defaultRepo:cfg.defaultRepo||'' });
  });

  // ─── OpenRouter Config API ────────────────────────────────────────────────────
  app.get("/api/devhub/openrouter", auth, (req, res) => {
    const c = loadOpenRouterCfg();
    res.json({ ok: true, hasKey: !!c.apiKey, apiKey: c.apiKey ? "••••••••" : "", models: c.models });
  });

  app.post("/api/devhub/openrouter", auth, (req, res) => {
    try {
      const { apiKey, model0, model1, model2 } = req.body;
      const cur = loadOpenRouterCfg();
      if (apiKey && apiKey !== "••••••••") cur.apiKey = apiKey.trim();
      const mods = [model0, model1, model2].map(m => (m || "").trim()).filter(Boolean);
      if (mods.length) cur.models = mods;
      saveOpenRouterCfg(cur);
      res.json({ ok: true });
    } catch(e) { res.json({ error: e.message }); }
  });

  // ─── AI Monitor API ──────────────────────────────────────────────────────────
  app.get("/api/devhub/monitor/status", auth, (req, res) => {
    const log = global._aiMonitorLog || [];
    const last = log[log.length - 1];
    const errTotal  = log.reduce((n, e) => n + (e.errors || []).length, 0);
    const fixOkTotal= log.reduce((n, e) => n + (e.appliedFixes || []).filter(f => f.ok).length, 0);
    res.json({
      ok: true,
      enabled:     !!global._aiMonitorEnabled,
      scanning:    !!global._aiMonitorScanning,
      lastScan:    last ? last.ts : null,
      totalScans:  log.length,
      errorsFound: errTotal,
      fixesApplied:fixOkTotal,
    });
  });

  app.get("/api/devhub/monitor/log", auth, (req, res) => {
    const log   = global._aiMonitorLog || [];
    const limit = Math.min(parseInt(req.query.limit) || 30, AI_MON_MAX_LOG);
    res.json({ ok: true, events: log.slice(-limit).reverse() });
  });

  app.post("/api/devhub/monitor/scan-now", auth, async (req, res) => {
    if (global._aiMonitorScanning) return res.json({ ok: false, error: 'Scan already in progress' });
    global._aiMonitorScanning = true;
    try {
      const event = await runAIScan();
      res.json({ ok: true, event });
    } catch (e) {
      res.json({ error: e.message });
    } finally {
      global._aiMonitorScanning = false;
    }
  });

  app.post("/api/devhub/monitor/toggle", auth, (req, res) => {
    global._aiMonitorEnabled = !global._aiMonitorEnabled;
    res.json({ ok: true, enabled: global._aiMonitorEnabled });
  });

  app.post("/api/devhub/monitor/clear", auth, (req, res) => {
    global._aiMonitorLog     = [];
    global._aiMonitorLastIdx = 0;
    res.json({ ok: true });
  });

  app.post("/api/devhub/monitor/rollback", auth, async (req, res) => {
    const { relPath } = req.body || {};
    if (!relPath) return res.json({ error: 'Missing relPath' });
    try {
      const r = await fetch('http://127.0.0.1:3001/bot/patch-rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath }),
      });
      const d = await r.json().catch(() => ({}));
      res.json(d);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // Start the background AI monitor loop (first scan after 30s, then every 45s)
  startAIMonitor();
};

// ─── HTML Tab Helpers ─────────────────────────────────────────────────────────
function htmlEscape(s) { return String(s||'').replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function agentsTab(cfg) {
  return `
<div class="quick-actions">
  ${["أضف أمر جديد لـ ZAO Bot","أصلح خطأ في الكود","حسّن أداء البوت","أضف ميزة حماية","اشرح كيف يعمل ZAO Bot","قيّم أوامر البوت الموجودة"].map(q=>`<button class="qa-btn" onclick="agentsQuick('${q}')">${q}</button>`).join("")}
</div>
<div class="chat-box" id="agentsBox" style="max-height:380px"></div>
<div class="dh-input-row">
  <textarea id="agentsInput" rows="2" placeholder="اكتب طلبك... مثال: أضف أمر للترحيب بالأعضاء الجدد (Ctrl+Enter)"></textarea>
  <button id="agentsSendBtn" class="btn btn-primary" onclick="sendToAgents()" style="align-self:flex-end;padding:10px 18px">⚡ إرسال</button>
</div>
<div style="display:flex;gap:8px;margin-top:8px">
  <button class="btn btn-outline btn-sm" onclick="clearAgents()">🗑 مسح</button>
  <span style="font-size:.72rem;color:var(--text3);align-self:center">💡 يعمل 3 وكلاء AI بالتسلسل: محلل → مطور → مراجع</span>
</div>`;
}

function claudeTab() {
  return `
<div class="quick-actions">
  ${["ما هي أوامر ZAO Bot الموجودة؟","كيف أضيف أمراً جديداً؟","اشرح نظام Tier في ZAO","كيف يعمل MQTT Health Check؟","ما هي الفرق بين Motor1 و Motor2؟"].map(q=>`<button class="qa-btn" onclick="document.getElementById('claudeInput').value='${q}';sendToClaude()">${q}</button>`).join("")}
</div>
<div class="chat-box" id="claudeBox" style="max-height:380px"></div>
<div class="dh-input-row">
  <textarea id="claudeInput" rows="2" placeholder="اسأل أي شيء عن ZAO Bot... (Ctrl+Enter)"></textarea>
  <button id="claudeSendBtn" class="btn btn-purple" onclick="sendToClaude()" style="align-self:flex-end;padding:10px 16px">إرسال</button>
</div>
<button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="clearClaude()">🗑 مسح المحادثة</button>`;
}

function quickTab() {
  return `
<div class="quick-actions">
  ${["كيف أوقف البوت مؤقتاً؟","ما معنى hasPermssion؟","كيف أرسل رسالة لغروب؟","شرح countDown","كيف أستعيد الكوكيز؟"].map(q=>`<button class="qa-btn" onclick="document.getElementById('quickInput').value='${q}';sendQuick()">${q}</button>`).join("")}
</div>
<div class="chat-box" id="quickBox" style="max-height:360px"></div>
<div class="dh-input-row">
  <textarea id="quickInput" rows="2" placeholder="سؤال سريع..."></textarea>
  <button id="quickSendBtn" class="btn btn-primary btn-icon" onclick="sendQuick()" style="align-self:flex-end;width:42px;height:42px">⚡</button>
</div>`;
}

function guideTab() {
  return `
<div class="quick-actions">
  ${["كيف أبدأ بتطوير بوت ZAO؟","شرح ملفات البوت الرئيسية","كيف أضيف أمراً جديداً خطوة بخطوة؟","ما الفرق بين البوت والبانيل؟","كيف أغيّر رسالة البوت؟"].map(q=>`<button class="qa-btn" onclick="document.getElementById('guideInput').value='${q}';sendToGuide()">${q}</button>`).join("")}
</div>
<div class="chat-box" id="guideBox" style="max-height:380px"></div>
<div class="dh-input-row">
  <textarea id="guideInput" rows="2" placeholder="اسألني بلغة بسيطة... (Ctrl+Enter)"></textarea>
  <button id="guideSendBtn" class="btn btn-success" onclick="sendToGuide()" style="align-self:flex-end;padding:10px 16px">📚</button>
</div>`;
}

function advisorTab() {
  return `
<div class="quick-actions">
  ${["ما هي نقاط قوة ZAO Bot؟","اقترح تحسينات للبوت","كيف أزيد أمان البوت؟","ما الأوامر الأكثر أهمية؟","كيف أتجنب إيقاف الحساب؟"].map(q=>`<button class="qa-btn" onclick="document.getElementById('advisorInput').value='${q}';sendToAdvisor()">${q}</button>`).join("")}
</div>
<div class="chat-box" id="advisorBox" style="max-height:380px"></div>
<div class="dh-input-row">
  <textarea id="advisorInput" rows="2" placeholder="استشرني عن ZAO Bot... (Ctrl+Enter)"></textarea>
  <button id="advisorSendBtn" class="btn btn-danger" onclick="sendToAdvisor()" style="align-self:flex-end;padding:10px 16px">💡</button>
</div>`;
}

function githubTab(cfg, hasToken) {
  return `
<div class="card">
  <div class="card-header"><div class="card-title">🐙 ملفات GitHub</div><a href="/github-files" class="btn btn-outline btn-sm">🗂 متصفح كامل</a></div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">المالك (Owner)</label>
      <input type="text" id="ghOwner" class="form-control" value="${htmlEscape(cfg.defaultOwner||'')}" placeholder="اسم المستخدم"/>
    </div>
    <div class="form-group">
      <label class="form-label">الريبو</label>
      <input type="text" id="ghRepo"  class="form-control" value="${htmlEscape(cfg.defaultRepo||'')}" placeholder="اسم الريبو"/>
    </div>
    <div class="form-group">
      <label class="form-label">الفرع</label>
      <input type="text" id="ghBranch" class="form-control" value="main" placeholder="main"/>
    </div>
  </div>
  <button class="btn btn-primary btn-sm" onclick="ghLoadTree()">📥 تحميل الملفات</button>
  <span id="ghFileCount" style="font-size:.78rem;color:var(--text3);margin-right:10px"></span>
  <div id="ghFileList" style="max-height:200px;overflow-y:auto;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px;margin-top:10px">
    <div style="text-align:center;padding:16px;color:var(--text3);font-size:.82rem">اضغط تحميل للبدء</div>
  </div>
</div>
<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <code id="ghCrumb" style="font-size:.8rem;color:var(--accent)">اختر ملفاً من القائمة...</code>
    <div style="display:flex;gap:5px">
      <button class="btn btn-outline btn-sm" onclick="ghAskAI()">🤖 AI</button>
      <button class="btn btn-success btn-sm" onclick="ghSaveFile()">💾 حفظ</button>
      <button class="btn btn-primary btn-sm" onclick="ghApplyAI()">✨ Apply AI</button>
    </div>
  </div>
  <textarea id="ghEditor" class="gh-code" style="min-height:260px" placeholder="اختر ملفاً..."></textarea>
</div>
<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-weight:700;font-size:.88rem">🤖 مساعد AI للملفات</div>
    <button class="btn btn-outline btn-sm" onclick="ghClearAI()">🗑</button>
  </div>
  <div class="chat-box" id="ghAiBox" style="max-height:220px"><div class="msg thinking">اختر ملفاً ثم اسألني عنه</div></div>
  <div class="dh-input-row" style="margin-top:8px">
    <textarea id="ghAiInput" rows="2" placeholder="اسأل عن الملف المفتوح... (Ctrl+Enter)"></textarea>
    <button class="btn btn-primary" onclick="ghAskAI()" style="align-self:flex-end;padding:10px 14px">🤖</button>
  </div>
  <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
    ${["اشرح الملف","أصلح الأخطاء","أضف تحسينات","أعد الكتابة"].map(q=>`<button class="qa-btn" onclick="document.getElementById('ghAiInput').value='${q}';ghAskAI()">${q}</button>`).join("")}
  </div>
</div>`;
}

function filesTab() {
  return `
<div class="card">
  <div class="card-header"><div class="card-title">📁 ملفات ZAO Bot المحلية</div><button class="btn btn-outline btn-sm" onclick="loadLocalFiles()">🔄 تحميل</button></div>
  <div id="localFileList" style="max-height:280px;overflow-y:auto;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px">
    <div style="text-align:center;padding:16px;color:var(--text3)">اضغط تحميل</div>
  </div>
</div>
<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <code id="localCrumb" style="font-size:.8rem;color:var(--accent)">اختر ملفاً...</code>
    <div style="display:flex;gap:5px">
      <button class="btn btn-success btn-sm" onclick="saveLocalFile()">💾 حفظ محلياً</button>
    </div>
  </div>
  <textarea id="localEditor" class="gh-code" style="min-height:320px" placeholder="اختر ملفاً من القائمة..."></textarea>
</div>
<script>
let _localPath=null;
async function loadLocalFiles(){
  const r=await fetch('/api/devhub/file/tree');const d=await r.json();
  const list=document.getElementById('localFileList');
  if(!d.ok){list.innerHTML='<div style="padding:12px;color:var(--red)">❌ '+escH(d.error||'فشل')+'</div>';return}
  list.innerHTML=d.files.map(f=>{
    const nm=f.path.split('/').pop();const ext=(nm.split('.').pop()||'').toLowerCase();
    const icon=ext==='js'?'📜':ext==='json'?'📋':ext==='md'?'📖':'📄';
    return \`<div class="gh-file-item" onclick="openLocalFile('\${escH(f.path)}')">\${icon} \${escH(f.path)}</div>\`;
  }).join('');
}
async function openLocalFile(p){
  _localPath=p;document.getElementById('localCrumb').textContent=p;
  document.getElementById('localEditor').value='⏳ جارٍ التحميل...';
  const r=await fetch('/api/devhub/file/read?path='+encodeURIComponent(p));
  const d=await r.json();
  document.getElementById('localEditor').value=d.ok?d.content:(d.error||'');
}
async function saveLocalFile(){
  if(!_localPath)return showToast('اختر ملفاً أولاً','error');
  const r=await api('/api/devhub/file/write',{path:_localPath,content:document.getElementById('localEditor').value});
  if(r.ok)showToast('✅ تم الحفظ: '+_localPath,'success');
  else showToast('❌ '+(r.error||'فشل'),'error');
}
function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
</script>`;
}

function createCmdTab() {
  return `
<div class="card">
  <div class="card-header">
    <div class="card-title">🆕 إنشاء أمر جديد بـ AI</div>
    <span style="font-size:.72rem;color:var(--green);background:rgba(0,255,159,.08);padding:3px 10px;border-radius:8px;border:1px solid rgba(0,255,159,.2)">⚡ يشتغل فوراً دون إيقاف البوت</span>
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
    <span style="font-size:.8rem;color:var(--text2);font-weight:700;flex-shrink:0">اسم الأمر:</span>
    <input type="text" id="mcName" class="form-control" placeholder="مثال: weather أو greet" style="flex:1;margin:0;max-width:220px;font-family:monospace"/>
  </div>
  <textarea id="mcDesc" class="form-control" rows="3" placeholder="ماذا يفعل الأمر؟ مثال: يرسل تحية شخصية للمستخدم مع اسمه والوقت الحالي..." style="margin-bottom:10px"></textarea>
  <div class="quick-actions">
    ${["يرحّب بالمستخدم باسمه","يرسل صورة عشوائية","يعرض إحصائيات الغروب","يلعب لعبة خمن الرقم","يترجم النص للعربية","يرسل رسالة تحفيزية عشوائية"].map(q=>`<button class="qa-btn" onclick="mcQuick('${q}')">${q}</button>`).join("")}
  </div>
  <button class="btn btn-primary" id="mcGenBtn" onclick="mcGenerate()" style="margin-top:8px;width:100%">🤖 AI يكتب الكود</button>
</div>

<div id="mcStep2" style="display:none;flex-direction:column;gap:10px">
  <div class="card">
    <div class="card-header">
      <div class="card-title">📜 الكود المولّد — راجع وعدّل</div>
      <div style="display:flex;gap:5px">
        <button class="btn btn-outline btn-sm" onclick="mcRegenerate()">🔄 أعد</button>
        <button class="btn btn-outline btn-sm" onclick="mcCopyCode()">📋 نسخ</button>
      </div>
    </div>
    <textarea id="mcCode" class="gh-code" rows="16" style="min-height:280px"></textarea>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn btn-success" id="mcDeployBtn" onclick="mcDeploy()" style="flex:1">💾 حفظ وتشغيل في البوت فوراً</button>
    </div>
  </div>
</div>

<div id="mcStatus" style="font-size:.82rem;min-height:24px;padding:4px 0"></div>`;
}

function monitorTab() {
  return `
<style>
.mon-stat{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 16px;display:flex;flex-direction:column;gap:3px;min-width:100px}
.mon-stat-val{font-size:1.5rem;font-weight:800;font-family:'Cairo',sans-serif}
.mon-stat-lbl{font-size:.72rem;color:var(--text3)}
.sev-ok{color:#00ff9f}.sev-warn{color:#ffc107}.sev-error{color:#ff3b6e}
.mon-event{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px;margin-bottom:8px;animation:fadeIn .25s ease}
.mon-event-head{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.mon-badge{padding:2px 9px;border-radius:20px;font-size:.7rem;font-weight:700;letter-spacing:.04em}
.badge-ok{background:rgba(0,255,159,.12);color:#00ff9f;border:1px solid rgba(0,255,159,.3)}
.badge-warn{background:rgba(255,193,7,.1);color:#ffc107;border:1px solid rgba(255,193,7,.25)}
.badge-error{background:rgba(255,59,110,.1);color:#ff3b6e;border:1px solid rgba(255,59,110,.25)}
.mon-err-item{font-size:.78rem;padding:5px 9px;border-radius:6px;background:var(--bg4);border:1px solid var(--border);margin-bottom:4px;line-height:1.55}
.mon-fix-item{font-size:.78rem;padding:5px 9px;border-radius:6px;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.2);margin-bottom:4px;line-height:1.55}
.mon-snippet{font-family:'Courier New',monospace;font-size:.72rem;color:var(--text3);background:var(--bg4);padding:3px 8px;border-radius:4px;white-space:pre-wrap;word-break:break-all;max-height:60px;overflow:hidden;margin-top:3px}
.pulse-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;animation:pulse 1.4s infinite}
.pulse-green{background:#00ff9f;box-shadow:0 0 6px #00ff9f}
.pulse-grey{background:#555;animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
</style>

<!-- Header + controls -->
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
  <div>
    <div style="font-size:1.1rem;font-weight:800;font-family:'Cairo',sans-serif">🧠 مراقب الذكاء الاصطناعي</div>
    <div style="font-size:.78rem;color:var(--text3)">يراقب سجلات البوت كل 45 ثانية — يكتشف الأخطاء ويصلحها تلقائياً</div>
  </div>
  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <span id="mon-status-dot"><span class="pulse-dot pulse-grey"></span><span style="font-size:.78rem;color:var(--text3)">جارٍ التحميل...</span></span>
    <button class="btn btn-outline btn-sm" onclick="monScanNow()" id="monScanBtn">⚡ فحص الآن</button>
    <button class="btn btn-outline btn-sm" onclick="monToggle()" id="monToggleBtn">⏸ إيقاف</button>
    <button class="btn btn-outline btn-sm" onclick="monClear()">🗑 مسح</button>
  </div>
</div>

<!-- Stats row -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:18px" id="monStats">
  <div class="mon-stat"><div class="mon-stat-val" id="ms-scans">—</div><div class="mon-stat-lbl">عمليات فحص</div></div>
  <div class="mon-stat"><div class="mon-stat-val sev-warn" id="ms-errors">—</div><div class="mon-stat-lbl">أخطاء اكتُشفت</div></div>
  <div class="mon-stat"><div class="mon-stat-val sev-ok" id="ms-fixes">—</div><div class="mon-stat-lbl">إصلاحات طُبّقت</div></div>
  <div class="mon-stat"><div class="mon-stat-val" id="ms-last" style="font-size:.85rem">—</div><div class="mon-stat-lbl">آخر فحص</div></div>
</div>

<!-- Event timeline -->
<div id="monTimeline" style="min-height:100px">
  <div style="text-align:center;padding:24px;color:var(--text3);font-size:.83rem">⏳ جارٍ تحميل أحداث المراقب...</div>
</div>

<script>
(function() {
  let _monEnabled = true;
  let _monRefreshTimer = null;

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }
  function timeSince(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return s + 'ث';
    if (s < 3600) return Math.floor(s/60) + 'د';
    return Math.floor(s/3600) + 'س';
  }
  function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sevBadge(s) {
    if (s === 'error') return '<span class="mon-badge badge-error">❌ خطأ</span>';
    if (s === 'warn')  return '<span class="mon-badge badge-warn">⚠️ تحذير</span>';
    return '<span class="mon-badge badge-ok">✅ سليم</span>';
  }

  async function monRefreshStatus() {
    try {
      const r = await fetch('/api/devhub/monitor/status');
      const d = await r.json();
      if (!d.ok) return;
      _monEnabled = d.enabled;
      const dotEl = document.getElementById('mon-status-dot');
      if (dotEl) dotEl.innerHTML = d.enabled
        ? '<span class="pulse-dot pulse-green"></span><span style="font-size:.78rem;color:#00ff9f">نشط</span>'
        : '<span class="pulse-dot pulse-grey"></span><span style="font-size:.78rem;color:var(--text3)">موقوف</span>';
      const togBtn = document.getElementById('monToggleBtn');
      if (togBtn) togBtn.textContent = d.enabled ? '⏸ إيقاف' : '▶ تشغيل';
      const scanBtn = document.getElementById('monScanBtn');
      if (scanBtn) scanBtn.disabled = !!d.scanning;
      if (d.scanning && scanBtn) scanBtn.textContent = '⏳ جارٍ...';
      else if (scanBtn) scanBtn.textContent = '⚡ فحص الآن';
      const e = document.getElementById('ms-scans');  if (e) e.textContent = d.totalScans;
      const e2= document.getElementById('ms-errors'); if (e2) e2.textContent = d.errorsFound;
      const e3= document.getElementById('ms-fixes');  if (e3) e3.textContent = d.fixesApplied;
      const e4= document.getElementById('ms-last');   if (e4) e4.textContent = d.lastScan ? timeSince(d.lastScan) + ' مضى' : 'لم يبدأ بعد';
    } catch(_) {}
  }

  async function monRefreshLog() {
    try {
      const r = await fetch('/api/devhub/monitor/log?limit=30');
      const d = await r.json();
      if (!d.ok) return;
      const tl = document.getElementById('monTimeline');
      if (!tl) return;
      if (!d.events || !d.events.length) {
        tl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text3);font-size:.83rem">لا توجد أحداث بعد — يبدأ الفحص خلال 30 ثانية من تشغيل البوت</div>';
        return;
      }
      tl.innerHTML = d.events.map(ev => {
        const errHtml = (ev.errors || []).map(e => \`
          <div class="mon-err-item">
            <strong style="color:\${e.type==='syntax'||e.type==='runtime'?'#ff3b6e':'#ffc107'}">\${escH(e.type||'?')}\${e.fixable?' 🔧':''}</strong>
            — \${escH(e.description||'')}
            \${e.file ? \`<code style="font-size:.7rem;color:var(--accent)"> \${escH(e.file)}</code>\` : ''}
            \${e.snippet ? \`<div class="mon-snippet">\${escH(e.snippet)}</div>\` : ''}
          </div>\`).join('');
        const fixHtml = (ev.appliedFixes || []).map((f, fi) => {
          const fixId = \`fix_\${ev.id}_\${fi}\`;
          const hasDiff = !!(f.before || f.after);
          return \`
          <div class="mon-fix-item" id="\${fixId}_wrap">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span>\${f.ok ? '✅' : '❌'} <code style="font-size:.72rem">\${escH(f.file||'')}</code></span>
              \${f.reason ? '<span style="color:var(--text3)">— ' + escH(f.reason) + '</span>' : ''}
              \${f.reloaded ? '<span style="color:#00ff9f;font-size:.68rem">↺ hot-reloaded</span>' : ''}
              \${f.error ? '<span style="color:#ff3b6e;font-size:.68rem">❌ ' + escH(f.error) + '</span>' : ''}
              <div style="display:flex;gap:4px;margin-right:auto">
                \${hasDiff ? \`<button onclick="monShowDiff('\${fixId}')" style="font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid rgba(0,212,255,.3);background:rgba(0,212,255,.05);color:#00d4ff;cursor:pointer">👁 فرق</button>\` : ''}
                \${f.ok ? \`<button onclick="monRollback('\${escH(f.file||'')}','\${fixId}_wrap')" style="font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid rgba(255,59,110,.3);background:rgba(255,59,110,.05);color:#ff3b6e;cursor:pointer">↩ تراجع</button>\` : ''}
              </div>
            </div>
            \${hasDiff ? \`
            <div id="\${fixId}_diff" style="display:none;margin-top:8px">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:.68rem">
                <div>
                  <div style="color:#ff3b6e;font-weight:700;margin-bottom:3px">← قبل الإصلاح</div>
                  <pre style="background:rgba(255,59,110,.05);border:1px solid rgba(255,59,110,.15);border-radius:4px;padding:6px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--text2);margin:0">\${escH((f.before||'(لا توجد نسخة سابقة)').slice(0,3000))}</pre>
                </div>
                <div>
                  <div style="color:#00ff9f;font-weight:700;margin-bottom:3px">→ بعد الإصلاح</div>
                  <pre style="background:rgba(0,255,159,.04);border:1px solid rgba(0,255,159,.15);border-radius:4px;padding:6px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--text2);margin:0">\${escH((f.after||'').slice(0,3000))}</pre>
                </div>
              </div>
            </div>\` : ''}
          </div>\`;
        }).join('');
        return \`
        <div class="mon-event">
          <div class="mon-event-head">
            \${sevBadge(ev.severity)}
            <span style="font-size:.76rem;color:var(--text3)">\${fmtTime(ev.ts)}</span>
            <span style="font-size:.78rem;color:var(--text2);flex:1">\${escH(ev.summary||'')}</span>
            <span style="font-size:.7rem;color:var(--text3)">\${ev.linesScanned||0} سطر</span>
          </div>
          \${errHtml ? \`<div style="margin-bottom:6px">\${errHtml}</div>\` : ''}
          \${fixHtml ? \`<div style="margin-top:4px"><span style="font-size:.72rem;color:var(--text3);font-weight:700">الإصلاحات المطبّقة:</span><div style="margin-top:4px">\${fixHtml}</div></div>\` : ''}
          \${ev.proposedFixes && !fixHtml ? \`<div style="font-size:.74rem;color:var(--text3);margin-top:4px">📋 \${ev.proposedFixes} إصلاح مقترح — لم يُطبَّق (البوت غير متصل)</div>\` : ''}
        </div>\`;
      }).join('');
    } catch(_) {}
  }

  async function monRefresh() {
    await Promise.all([monRefreshStatus(), monRefreshLog()]);
  }

  window.monScanNow = async function() {
    const btn = document.getElementById('monScanBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ جارٍ...'; }
    try {
      const r = await fetch('/api/devhub/monitor/scan-now', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const d = await r.json();
      if (d.error) showToast('❌ ' + d.error, 'error');
      else { showToast('✅ اكتمل الفحص', 'success'); monRefresh(); }
    } catch(e) { showToast('❌ فشل: ' + e.message, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '⚡ فحص الآن'; } }
  };

  window.monToggle = async function() {
    try {
      const r = await fetch('/api/devhub/monitor/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const d = await r.json();
      showToast(d.enabled ? '✅ المراقب نشط' : '⏸ المراقب موقوف', 'info');
      monRefreshStatus();
    } catch(e) { showToast('❌ ' + e.message, 'error'); }
  };

  window.monClear = async function() {
    if (!confirm('مسح كل سجلات المراقب؟')) return;
    await fetch('/api/devhub/monitor/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    monRefresh();
  };

  window.monShowDiff = function(fixId) {
    const el = document.getElementById(fixId + '_diff');
    if (!el) return;
    const isHidden = el.style.display === 'none' || el.style.display === '';
    el.style.display = isHidden ? 'block' : 'none';
    const btn = document.querySelector(\`[onclick="monShowDiff('\${fixId}')"]\`);
    if (btn) btn.textContent = isHidden ? '🔼 إخفاء' : '👁 فرق';
  };

  window.monRollback = async function(relPath, wrapId) {
    if (!relPath) return;
    if (!confirm('تراجع عن إصلاح الذكاء الاصطناعي واستعادة الملف الأصلي؟\\n\\n' + relPath)) return;
    try {
      const r = await fetch('/api/devhub/monitor/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath })
      });
      const d = await r.json();
      if (d.ok) {
        showToast('✅ تم التراجع وإعادة تحميل: ' + relPath, 'success');
        const wrap = document.getElementById(wrapId);
        if (wrap) {
          wrap.style.opacity = '0.4';
          wrap.style.pointerEvents = 'none';
          const note = document.createElement('div');
          note.textContent = '↩ تم التراجع';
          note.style.cssText = 'font-size:.7rem;color:#ffc107;margin-top:4px;font-weight:700';
          wrap.appendChild(note);
        }
      } else {
        showToast('❌ ' + (d.error || 'فشل التراجع'), 'error');
      }
    } catch(e) { showToast('❌ خطأ: ' + e.message, 'error'); }
  };

  // Initial load + auto-refresh every 12s when tab visible
  monRefresh();
  _monRefreshTimer = setInterval(monRefresh, 12000);
})();
</script>`;
}

function settingsTab(cfg, hasToken) {
  const or = loadOpenRouterCfg();
  return `
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">

  <!-- OpenRouter AI Settings -->
  <div class="card" style="border-color:rgba(99,102,241,.35)">
    <div class="card-header">
      <div class="card-title">🤖 OpenRouter AI — DevHub</div>
      <span class="badge ${or.apiKey ? 'badge-green' : 'badge-red'}">${or.apiKey ? '✅ مفعّل' : '❌ يحتاج مفتاح'}</span>
    </div>
    <div style="font-size:.76rem;color:var(--text3);margin-bottom:10px">
      المفتاح يُحفظ في <code>ZAO-SETTINGS.json</code> → <code>openrouterKeyInternal</code> · احصل على مفتاح مجاني من <a href="https://openrouter.ai/keys" target="_blank" style="color:var(--accent)">openrouter.ai/keys</a>
    </div>
    <div class="form-group">
      <label class="form-label">API Key (openrouterKeyInternal)</label>
      <input type="password" id="orApiKey" class="form-control" value="${or.apiKey ? '••••••••' : ''}" placeholder="sk-or-v1-xxxxxxxx"/>
    </div>
    <div class="form-group">
      <label class="form-label">الموديل الأول</label>
      <input type="text" id="orModel0" class="form-control" value="${htmlEscape(or.models[0]||'')}" placeholder="openai/gpt-4o-mini"/>
    </div>
    <div class="form-group">
      <label class="form-label">الموديل الثاني (احتياطي)</label>
      <input type="text" id="orModel1" class="form-control" value="${htmlEscape(or.models[1]||'')}" placeholder="meta-llama/llama-3.1-8b-instruct:free"/>
    </div>
    <div class="form-group">
      <label class="form-label">الموديل الثالث (احتياطي)</label>
      <input type="text" id="orModel2" class="form-control" value="${htmlEscape(or.models[2]||'')}" placeholder="google/gemma-2-9b-it:free"/>
    </div>
    <button class="btn btn-success" onclick="saveOpenRouterSettings()">💾 حفظ OpenRouter</button>
  </div>

  <!-- GitHub Token -->
  <div class="card">
    <div class="card-header"><div class="card-title">🔑 GitHub Token</div><span class="badge ${hasToken?'badge-green':'badge-red'}">${hasToken?'✅ موجود':'❌ غير موجود'}</span></div>
    <div class="form-group">
      <label class="form-label">GitHub Personal Access Token</label>
      <input type="password" id="ghTokenInput" class="form-control" value="${hasToken?'••••••••':''}" placeholder="ghp_xxxxxx (يحتاج صلاحية repo)"/>
    </div>
    <div class="form-group">
      <label class="form-label">المالك الافتراضي (Owner)</label>
      <input type="text" id="settingsOwner" class="form-control" value="${htmlEscape(cfg.defaultOwner||'')}" placeholder="اسم مستخدم GitHub"/>
    </div>
    <div class="form-group">
      <label class="form-label">الريبو الافتراضي</label>
      <input type="text" id="settingsRepo" class="form-control" value="${htmlEscape(cfg.defaultRepo||'')}" placeholder="اسم الريبو"/>
    </div>
    <button class="btn btn-success" onclick="saveDevHubSettings()">💾 حفظ GitHub</button>
  </div>

  <!-- Push to GitHub -->
  <div class="card">
    <div class="card-header"><div class="card-title">🚀 رفع الكود لـ GitHub</div></div>
    <div class="form-group">
      <label class="form-label">الريبو</label>
      <input type="text" id="pushRepo" class="form-control" value="${htmlEscape(cfg.defaultRepo||'')}" placeholder="اسم الريبو"/>
    </div>
    <div class="form-group">
      <label class="form-label">المالك</label>
      <input type="text" id="pushOwner" class="form-control" value="${htmlEscape(cfg.defaultOwner||'')}" placeholder="Owner"/>
    </div>
    <div class="form-group">
      <label class="form-label">الفرع</label>
      <input type="text" id="pushBranch" class="form-control" value="main"/>
    </div>
    <div class="form-group">
      <label class="form-label">رسالة Commit</label>
      <input type="text" id="pushMsg" class="form-control" value="🚀 Push from ZAO Panel"/>
    </div>
    <button class="btn btn-primary" onclick="pushToGitHub()">🚀 رفع الكود</button>
    <div id="pushStatus" style="margin-top:10px;font-size:.83rem;min-height:22px"></div>
  </div>

</div>`;
}
