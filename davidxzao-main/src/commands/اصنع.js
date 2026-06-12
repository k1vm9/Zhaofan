'use strict';
/**
 * اصنع.js — AI Code Generation Command (admin only)
 *
 * Usage: .اصنع <طلبك>
 * Example: .اصنع اصنع نظام حماية جديد للبوت
 *
 * - Reads devGroupID from ZAO-SETTINGS.json (or asks for it)
 * - Sends the request + bot context to the AI DevHub agents
 * - Posts the generated code/response to devGroupID
 */

const ROOT = require('path').join(__dirname, '..', '..');
const fs   = require('fs');
const path = require('path');

module.exports.config = {
  name:            'اصنع',
  aliases:         ['create', 'generate', 'gen', 'code', 'كود', 'انشئ'],
  version:         '1.0.0',
  hasPermssion:    2,
  credits:         'ZAO Team',
  description:     'توليد كود أو نظام جديد عبر وكلاء الذكاء الاصطناعي — النتيجة تُرسل لمجموعة التطوير',
  commandCategory: 'مطور',
  usages:          'اصنع <وصف ما تريد إنشاءه>',
  cooldowns:       30,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function _loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'ZAO-SETTINGS.json'), 'utf8'));
  } catch (_) { return {}; }
}

function _saveSettings(obj) {
  try {
    const { atomicWriteFileSync } = require('../../utils/atomicWrite');
    atomicWriteFileSync(path.join(ROOT, 'ZAO-SETTINGS.json'), JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {
    fs.writeFileSync(path.join(ROOT, 'ZAO-SETTINGS.json'), JSON.stringify(obj, null, 2), 'utf8');
  }
}

function _readBotContext() {
  const parts = [];

  // Read ZAO-SETTINGS.json (structure only — no passwords/tokens)
  try {
    const cfg = _loadSettings();
    const safe = {
      version: cfg.version,
      PREFIX: cfg.PREFIX,
      language: cfg.language,
      mqttHealthCheck: cfg.mqttHealthCheck,
      humanTyping: cfg.humanTyping,
      autoLock: cfg.autoLock,
      stealthMode: cfg.stealthMode,
      e2ee: cfg.e2ee,
      nkxModern: cfg.nkxModern,
      autoUptime: cfg.autoUptime,
    };
    parts.push('=== ZAO-SETTINGS.json (structure) ===\n' + JSON.stringify(safe, null, 2));
  } catch (_) {}

  // Read the list of loaded commands
  try {
    const cmdNames = global.client?.commands ? [...global.client.commands.keys()].filter((k,i,a) => a.indexOf(k) === i) : [];
    parts.push('\n=== Loaded Commands ===\n' + cmdNames.join(', '));
  } catch (_) {}

  // Read key includes (abbreviated)
  const keyFiles = [
    'includes/listen.js',
    'includes/liveStats.js',
    'includes/mqttHealthCheck.js',
    'includes/stealthEngineV2.js',
  ];
  for (const rel of keyFiles) {
    try {
      const full = path.join(ROOT, rel);
      if (fs.existsSync(full)) {
        const src = fs.readFileSync(full, 'utf8').slice(0, 3000);
        parts.push(`\n=== ${rel} (first 3000 chars) ===\n${src}`);
      }
    } catch (_) {}
  }

  // Read a sample command for structure reference
  try {
    const samplePath = path.join(ROOT, 'SCRIPTS/ZAO-CMDS/ping.js');
    if (fs.existsSync(samplePath)) {
      parts.push('\n=== Sample Command (ping.js) ===\n' + fs.readFileSync(samplePath, 'utf8'));
    }
  } catch (_) {}

  return parts.join('\n');
}

async function _callAI(prompt, botContext) {
  const systemPrompt = `You are an expert Node.js bot developer specializing in Facebook Messenger bots.
You have full knowledge of the ZAO Bot codebase — a Node.js/Express bot using nkxfca (unofficial Facebook Chat API).

When asked to create/generate something:
1. Write clean, production-ready Node.js code
2. Follow the existing command file structure (module.exports.config + module.exports.run)
3. Use Arabic comments where appropriate (this is an Arabic-language bot)
4. Wrap all external calls in try/catch
5. Never hardcode API keys — use global.config or ZAO-SETTINGS.json
6. Keep responses concise — provide code first, explanation after

Bot Architecture context is provided below.`;

  const userContent = `${prompt}\n\n=== BOT CONTEXT ===\n${botContext.slice(0, 8000)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const r = await fetch('https://text.pollinations.ai/openai', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    'openai-large',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent },
        ],
        temperature: 0.7,
        max_tokens:  3000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || data?.content || String(data);
  } catch (e) {
    if (e.name === 'AbortError') return 'انتهت المهلة — حاول مرة أخرى';
    return 'خطأ في الاتصال بالذكاء الاصطناعي: ' + e.message;
  }
}

// ── Pending: waiting for group ID ───────────────────────────────────────────
const _pending = new Map(); // senderID → { request, threadID, messageID }

module.exports.handleReply = async function ({ api, event, handleReply }) {
  const { threadID, senderID, body, messageID } = event;
  const pending = _pending.get(String(senderID));
  if (!pending) return;
  _pending.delete(String(senderID));

  const groupID = (body || '').trim().replace(/\D/g, '');
  if (!groupID || groupID.length < 5) {
    return api.sendMessage('❌ معرف غير صالح. أرسل الأمر مجدداً وأدخل رقم المجموعة.', threadID);
  }

  // Save devGroupID
  const settings = _loadSettings();
  settings.devGroupID = groupID;
  _saveSettings(settings);
  if (global.config) global.config.devGroupID = groupID;

  await api.sendMessage(`✅ تم حفظ مجموعة التطوير: ${groupID}\n\nجارٍ معالجة طلبك...`, threadID);
  await _processRequest(api, pending.request, groupID, pending.threadID);
};

async function _processRequest(api, request, devGroupID, replyThreadID) {
  try {
    await api.sendMessage(`🧠 يعمل الذكاء الاصطناعي على طلبك...\n\n"${request.slice(0, 120)}"\n\nسيصل الرد لمجموعة التطوير.`, replyThreadID);
  } catch (_) {}

  const botContext = _readBotContext();
  const result     = await _callAI(request, botContext);

  const header = `🏗️ اصنع — نتيجة الذكاء الاصطناعي\n━━━━━━━━━━━━━━━━━━━━━━\n📝 الطلب: ${request.slice(0, 200)}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  const fullMsg = header + result;

  // Split if too long (Facebook limit ~20k chars but practical is 8k)
  const CHUNK = 7000;
  if (fullMsg.length <= CHUNK) {
    try { await api.sendMessage(fullMsg, devGroupID); } catch (e) {
      try { await api.sendMessage('⚠️ فشل الإرسال لمجموعة التطوير: ' + e.message, replyThreadID); } catch (_) {}
    }
  } else {
    const chunks = [];
    for (let i = 0; i < fullMsg.length; i += CHUNK) chunks.push(fullMsg.slice(i, i + CHUNK));
    for (let i = 0; i < chunks.length; i++) {
      try {
        await api.sendMessage(`[${i+1}/${chunks.length}]\n${chunks[i]}`, devGroupID);
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1500));
      } catch (_) {}
    }
  }
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;

  const request = args.join(' ').trim();
  if (!request) {
    return api.sendMessage(
      `🏗️ أمر الإنشاء\n\nالاستخدام: .اصنع <وصف ما تريد>\n\nمثال:\n.اصنع أمر يرد على الرسائل بشعر عربي\n.اصنع نظام حماية جديد للمجموعات\n.اصنع دالة تحليل الكوكيز`,
      threadID, messageID
    );
  }

  // Check devGroupID
  const settings = _loadSettings();
  const devGroupID = settings.devGroupID || (global.config && global.config.devGroupID);

  if (!devGroupID || String(devGroupID).trim() === '') {
    // Ask for group ID
    _pending.set(String(senderID), { request, threadID, messageID });
    const sentInfo = await new Promise(resolve => {
      api.sendMessage(
        `⚠️ لم يتم تحديد مجموعة التطوير بعد.\n\nأرسل معرّف المجموعة (رقم الـ threadID) التي تريد إرسال النتائج إليها:`,
        threadID,
        (err, info) => resolve(info)
      );
    });
    if (sentInfo?.messageID && global.client?.handleReply) {
      global.client.handleReply.push({
        name:      'اصنع',
        messageID: sentInfo.messageID,
        author:    String(senderID),
        callback:  module.exports.handleReply,
      });
    }
    return;
  }

  await _processRequest(api, request, String(devGroupID), threadID);
};
