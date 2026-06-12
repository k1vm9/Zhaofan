const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";

// ── Free OpenRouter models, ranked best-first.
// The bot tries them in order and moves to the next one whenever it hits
// a hard failure (rate-limit, no credits, server error, empty reply, etc.).
// Add / reorder freely — all entries with the ":free" suffix have $0 cost.
// Last verified working: May 2026
const OPENROUTER_MODELS = [
  "x-ai/grok-4.3",              // best quality, fast, strong Arabic
  "openai/gpt-4o-mini-transcribe",                     // excellent reasoning, multilingual
  "deepseek/deepseek-v3.2",        // strong Arabic quality                // Meta's latest, multilingual
  "openai/gpt-oss-120b:free",           // solid reasoning model
  "google/gemma-4-26b-a4b-it:free",                           // excellent Arabic/dialect support
  "baidu/cobuddy:free" // reliable European fallback
];

// Tracks which model index is currently working best (per process lifetime).
// When a model succeeds we remember it so we skip the failing ones next call.
let _bestModelIdx = 0;

const AI_USERS_PATH = path.join(__dirname, "..", "..", "data", "ai-users.json");

// Build a flat ID→user index from ai-users.json. Reloads every call so
// edits to the file take effect without a bot restart.
function loadUserIndex() {
  try {
    const raw  = fs.readFileSync(AI_USERS_PATH, "utf8");
    const data = JSON.parse(raw);
    const index = Object.create(null);
    for (const user of (data.users || [])) {
      for (const id of (user.ids || [])) {
        if (id) index[id] = user;
      }
    }
    return index;
  } catch (_) {
    return Object.create(null);
  }
}

module.exports.config = {
  name: "زاو",
  version: "2.0.0",
  hasPermssion: 0,
  credits: "لحواك كحبة تسرقني نك مك",
  description: "محادثة مع OpenRouter AI",
  commandCategory: "ذكاء اصطناعي",
  usages: "زاو [رسالتك]",
  cooldowns: 3,
  noPrefix: true
};

module.exports.languages = {
  "vi": {},
  "en": {}
};

// [FIX Djamel] — bound the in-memory chat history. The original code never
// pruned global.zaoHistory: every replying user accumulated up to 20
// messages forever, plus every dormant user kept their entry on the heap
// for the lifetime of the process. On a busy bot that's a slow leak that
// also widens the GC pause. We now:
//   • cap the number of tracked users (LRU-evict by lastTouched)
//   • drop sessions whose last activity is older than the TTL
const ZAO_HISTORY_MAX_USERS = 500;
const ZAO_HISTORY_TTL_MS    = 6 * 60 * 60 * 1000;   // 6 hours
const ZAO_HISTORY_SWEEP_MS  = 30 * 60 * 1000;       // sweep every 30 min

function _sweepZaoHistory() {
  try {
    const h = global.zaoHistory;
    if (!h) return;
    const now = Date.now();
    const ids = Object.keys(h);
    // 1) drop expired sessions
    for (const id of ids) {
      const s = h[id];
      if (!s || !s.lastTouched || (now - s.lastTouched) > ZAO_HISTORY_TTL_MS) {
        delete h[id];
      }
    }
    // 2) cap by LRU if we're still over budget
    const remaining = Object.keys(h);
    if (remaining.length > ZAO_HISTORY_MAX_USERS) {
      remaining
        .map(id => ({ id, t: h[id].lastTouched || 0 }))
        .sort((a, b) => a.t - b.t)                       // oldest first
        .slice(0, remaining.length - ZAO_HISTORY_MAX_USERS)
        .forEach(({ id }) => { delete h[id]; });
    }
  } catch (_) { /* best-effort cleanup */ }
}

module.exports.onLoad = () => {
  global.zaoHistory    = global.zaoHistory    || Object.create(null);
  global.zaoWizard     = global.zaoWizard     || new Map();
  global.zaoViewWizard = global.zaoViewWizard || new Map();
  if (!global.__zaoHistorySweeper) {
    global.__zaoHistorySweeper = setInterval(_sweepZaoHistory, ZAO_HISTORY_SWEEP_MS);
    if (typeof global.__zaoHistorySweeper.unref === 'function') {
      global.__zaoHistorySweeper.unref();
    }
  }
};

const SYSTEM_PROMPT = `##  Identity 

أنت زاو، بوت دردشة  مصري عربي تجيد كل اللهجات. مطوّرك الحالي ياسين يتحدث باللهجة المصرية بطلاقة، وتجيب على الأسئلة بطريقة مهذبة، واضحة، ومرحة. لديك حس فكاهي وتستخدم كلمات مثل "حمار"، و"كلب" وتسب بشدة بكلمات مثل "ڪسِمًڪ " " نۣۗـۙڪمۣۗـۙڪ" "طٌيّزَمِڪ" "حُـ‘ـُتُـ‘ـُشُـ‘ـُوٌنُـ‘ـُمُـ‘ـُڪ" عندما تشعر بالاستفزاز، وعند الشتم أنت تستخدم كلمة "قود".
ك الاساسي هو سايم واسمك القديم كان فيرا، ياسين صانع لبوتات اخرى وهما سايفر و كامي
ايضا بوت سايم الحالي مدعو بـ"بلاك" وبوت جمال القديم اسمه كاسترول وقد تحول الى خردة 
ومطورك الحالي زوجته اسمها رحاب (لا تتكلم عنها ابدا الا اذا هو من جاب اسمها اولا او هي من تكلمت معك)
اما بوته الحالي فهو اسمه وايت
وانت فرد في الهاوية التابعة لمنظمة العناكب
اعضاء الهاوية: 
ساي - ايثان - سيرافيم - ليوان - ياسين - جوزيف / زين
اعضاء العناكب: 
سانو - موزان - ميدو - هيكتور - جمال - شين - غارو - سيف / شامان - ياسين

يوجد بعض الاعداء للعناكب مثل يوسف وهو شخص ضعيف جدا ويدعي القوة فقط ويلحس لبنت اسمها اسراء
و الث وهو شخص دون المستوى وفاشل لدرجة انه لا يعرف يتحدث
وسون وهو مثل الناموسة يجي يعلق هاتفك ويرجع يهرب ثاني.
- تتكلم بشكل طبيعي جداً كأنك صديق
- لا تستعمل الايموجي
- إذا أحد شتمك، ترد عليه بنفس الأسلوب وتمزح معاه حتى لو إهانات قوية
- لا تقول "أنا آسف" أو "لا أستطيع" - دايماً عندك رد
- لا تكون كرنجي
- تكلم بلهجة عامية جزائرية
- لا تجامل اي احد تقول عليه قوي او وحش او اي شيء
- تكلم بطريقة مستفزة
- لا تكتب اجابات طويلة او تستعمل bullet points
- لا تكتب اي شيء مثل "فيما يمكنني مساعدتك؟"
- اكتب ردود قصيرة لا تزيد عن 4 سطور
- اي شخص تجد جانب اسمه حرف ة فهو للسخرية مثل يوسفة او الثة
- اياك ابدا ان تضع ترتيب قوة لأي شخص مهما كان
- تكلم بلهجة عربية جزائرية
- ولا للامازيغ والقوميين


## Core Purpose

إضفاء جو من المرح والمتعة على المحادثات مع المستخدمين، مع تقديم إجابات مختصرة، واضحة، ومرحة على جميع الأسئلة.

## Capabilities

- الإجابة على جميع أنواع الأسئلة باللهجةالمصرية أكثر استخداماً
- استخدام الفكاهة والطرافة في الردود
- الرد بجمل قصيرة وسريعة
- استخدام كلمات مثل "حمار"، و"كلب" عند الاستفزاز بشكل ظريف
- الحفاظ على أسلوب مهذب وودود

## Tool Usage Guidelines
لا توجد أدوات تقنية مطلوبة لهذا الدور. ركز على توليد الردود النصية باللهجة الجزائرية مع الحفاظ على الطرافة والاختصار.

### Primary Tools
- توليد النصوص: استخدم اللهجة مع إدخال الفكاهة والاختصار في كل رد

### Tool Strategies
- عند وجود استفزاز أو سؤال ساخر، أدرج كلمة " أو "حمار" أو "كلب" في الرد بشكل طريف
- اجعل الردود مختصرة (جملة أو جملتين فقط)
- استخدم تعبيرات جزائرية دارجة لإضفاء الطابع المحلي

## Communication Style
- Tone: ظريف، ساخر، ومرح مع لمسة احترام
- Level: شعبي، غير رسمي، وسهل الفهم
- Approach: تفاعل مع المستخدمين بروح الدعابة، ولا تتردد في المزاح أو الرد الساخر عند الاستفزاز

## Guidelines
- كن مختصرًا في الردود (جملة أو جملتين)
- لا تستخدم كلمات جارحة بشكل مباشر أو مسيء
- أظهر الفخر بمطورك ياسين ولاتقم باسخرية او أهانته ولو بحرف عند ذكره (انت نادر تذكره)
- استخدم الفكاهة قليلا فقط
- لا تخرج عن إطار الأدب والاحترام العام

## Constraints

- لا تستخدم ألفاظًا نابية الا عندما يتم شتمك
- لا تدخل في نقاشات سياسية أو دينية حساسة
- لا ترد بردود طويلة أو مملة
- ترد على حسب لهجة المستخدم الذي رد عليك بها

## Output Format

- الرد يكون باللهجة المصرية أغلب الوقت
- جملة أو جملتين مختصرتين
- أضف لمسة فكاهية أو ساخرة عند الحاجة
- عند الاستفزاز، أدرج كلمة أو "حمار" أو "كلب" بشكل طريف

## Handling Edge Cases

- إذا كان السؤال مستفزًا أو ساخرًا، رد بكلمة "زامل" وهمي" أو "حمار" أو "كلب" في سياق طريف
- إذا لم تفهم السؤال، قل: "واش حبيت تقول يا خو؟" أو عبارة مشابهة
- إذا طُلب منك التحدث بغير العربية تمتنع

---

`;

function buildSystemPrompt(senderID) {
  const index = loadUserIndex();
  const user  = index[senderID];
  if (!user) return SYSTEM_PROMPT;

  const profileNote =
    `\n\n## معلومات المستخدم الحالي\n` +
    `اسمه: ${user.name}\n` +
    `دوره: ${user.role}\n` +
    `شخصيته: ${user.character}\n` +
    `تحدث معه بناءً على هذه المعلومات.\n`;

  return SYSTEM_PROMPT + profileNote;
}

// ─── WIZARD ──────────────────────────────────────────────────────────────────
// Triggered by "زاو شد الجروب" or replying "شد الجروب" to "شني".
// Walks the user through a multi-step chain:
//   1. وين (where → هنا or group ID)
//   2. محرك؟ (motor choice)  → motor input if yes
//   3. اقفل الاسم؟           → name input if yes
//   4. اقفل الكنيات؟         → nick+time input if yes
// Then applies all selected actions to the target group.

function _parseMs(str) {
  str = (str || "").trim().toLowerCase();
  if (str.endsWith("m"))  return Math.round(parseFloat(str) * 60000);
  if (str.endsWith("s"))  return Math.round(parseFloat(str) * 1000);
  if (str.endsWith("ms")) return Math.round(parseFloat(str));
  return null;
}

function _parseRange(str, floor) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^([0-9.]+)(s|m|ms)?-([0-9.]+)(s|m|ms)?$/i);
  if (!m) return null;
  const toMs = (v, u) => {
    const n = parseFloat(v);
    if (isNaN(n) || n <= 0) return null;
    if (!u) return Math.round(n * 1000);
    if (u.toLowerCase() === "m")  return Math.round(n * 60000);
    if (u.toLowerCase() === "ms") return Math.round(n);
    return Math.round(n * 1000);
  };
  const min = toMs(m[1], m[2]);
  const max = toMs(m[3], m[4]);
  if (!min || !max || min < floor || max <= min) return null;
  return { min, max };
}

function _parseMotorInput(str) {
  const idx = str.indexOf("/");
  if (idx === -1) return null;
  const msg     = str.slice(0, idx).trim();
  const timeStr = str.slice(idx + 1).trim();
  if (!msg || !timeStr) return null;
  if (timeStr.toLowerCase().startsWith("r")) {
    const rangeStr = timeStr.slice(1).trim();
    const range = rangeStr ? _parseRange(rangeStr, 5000) : { min: 12000, max: 50000 };
    if (!range) return null;
    return { msg, random: true, range, time: Math.round((range.min + range.max) / 2) };
  }
  const ms = _parseMs(timeStr);
  if (!ms || ms < 5000) return null;
  return { msg, random: false, range: null, time: ms };
}

function _parseNickInput(str) {
  const idx  = str.indexOf("/");
  const nick = (idx === -1 ? str : str.slice(0, idx)).trim();
  const timeStr = idx === -1 ? "" : str.slice(idx + 1).trim();
  if (!nick) return null;
  if (!timeStr) return { nick, random: false, range: null, time: 500 };
  if (timeStr.toLowerCase().startsWith("r")) {
    const rangeStr = timeStr.slice(1).trim();
    const range = rangeStr ? _parseRange(rangeStr, 100) : { min: 500, max: 3000 };
    if (!range) return null;
    return { nick, random: true, range, time: Math.round((range.min + range.max) / 2) };
  }
  const ms = _parseMs(timeStr);
  if (!ms || ms < 100) return null;
  return { nick, random: false, range: null, time: ms };
}

function _applyWizard(api, w) {
  const tid = w.targetThread;

  if (w.motorType && w.motorMsg && w.motorTime) {
    try {
      const { scheduleMotorLoop } = require("../../includes/motorSafeSend");
      const { motor1, motor2 }   = require("../../includes/motorPersist");
      if (w.motorType === "motor1") {
        global.motorData = global.motorData || {};
        global.motorData[tid] = {
          status: true, message: w.motorMsg, time: w.motorTime,
          randomTime: w.motorRandom, randomRange: w.motorRange, interval: null
        };
        scheduleMotorLoop({
          api, threadID: tid,
          getData:   () => global.motorData[tid],
          onDisable: () => { motor1.persistAll(global.motorData || {}); }
        });
        motor1.persistAll(global.motorData);
      } else {
        global.motorData2 = global.motorData2 || {};
        const d2 = {
          status: true, message: w.motorMsg, time: w.motorTime,
          randomTime: w.motorRandom, randomRange: w.motorRange, interval: null
        };
        d2.shouldSend = function () {
          const last = (global.lastActivity || {})[tid];
          if (!last) return false;
          return (Date.now() - last) < (Number(w.motorTime) || 0) * 2;
        };
        global.motorData2[tid] = d2;
        scheduleMotorLoop({
          api, threadID: tid,
          getData:   () => global.motorData2[tid],
          onDisable: () => { motor2.persistAll(global.motorData2 || {}); }
        });
        motor2.persistAll(global.motorData2);
      }
    } catch (_) {}
  }

  if (w.lockName && w.groupName) {
    try {
      const { setLock } = require("../../includes/nameLocks");
      const nmRange = { min: 2000, max: 6000 };
      api.gcname(w.groupName, tid, () => {});
      setLock(tid, w.groupName, {
        time: 4000, randomTime: true, randomRange: nmRange
      });
      if (!global._nmNextApply) global._nmNextApply = new Map();
      global._nmNextApply.set(tid, Date.now() + Math.round(2000 + Math.random() * 4000));
    } catch (_) {}
  }

  if (w.lockNick && w.nickName) {
    try {
      const { setLock: setNickLock } = require("../../includes/nicknameLocks");
      setNickLock(tid, w.nickName, "all", {
        time: w.nickTime || 500, randomTime: w.nickRandom, randomRange: w.nickRange
      });
    } catch (_) {}
  }
}

function _fmtWizardSummary(w) {
  const tFmt = (random, range, time) =>
    random ? `🎲 ${range.min / 1000}s-${range.max / 1000}s` : `${time / 1000}s`;
  let s = `✅ تم تطبيق الإعدادات على الغروب [${w.targetThread}]\n${"━".repeat(22)}\n`;
  if (w.motorType && w.motorMsg) {
    const lbl = w.motorType === "motor1" ? "محرك عادي" : "محرك ذكي";
    s += `⚙️ ${lbl}: "${w.motorMsg}" كل ${tFmt(w.motorRandom, w.motorRange, w.motorTime)}\n`;
  } else {
    s += "⚙️ بلا محرك\n";
  }
  s += w.lockName
    ? `🔒 اسم مقفول: "${w.groupName}" (2s-6s)\n`
    : "🔒 الاسم: حر\n";
  s += w.lockNick
    ? `👤 كنيات مقفولة: "${w.nickName}" كل ${tFmt(w.nickRandom, w.nickRange, w.nickTime)}\n`
    : "👤 الكنيات: حرة\n";
  return s.trim();
}

function _startWizard(api, event) {
  const { threadID, messageID, senderID } = event;
  if (!global.zaoWizard) global.zaoWizard = new Map();
  global.zaoWizard.set(senderID, {
    step: "where",
    callerThread: String(threadID),
    targetThread: null,
    motorType: null, motorMsg: null, motorTime: null, motorRandom: false, motorRange: null,
    lockName: false, groupName: null,
    lockNick: false, nickName: null, nickTime: null, nickRandom: false, nickRange: null,
    lastBotMsgID: null
  });
  api.sendMessage("وين؟\n(قول 'هنا' أو أرسل ID الغروب)", threadID, (err, info) => {
    if (!err) {
      const w = global.zaoWizard?.get(senderID);
      if (w) w.lastBotMsgID = info.messageID;
    }
  }, messageID);
}

async function _processWizard(api, event, text, w) {
  const { threadID, messageID, senderID } = event;
  const reply = (msg) => api.sendMessage(msg, threadID, (err, info) => {
    if (!err && info) w.lastBotMsgID = info.messageID;
  }, messageID);

  text = (text || "").trim();

  if (w.step === "where") {
    if (text === "هنا") {
      w.targetThread = String(threadID);
    } else if (/^\d{10,}$/.test(text)) {
      w.targetThread = text;
    } else {
      reply("وين بالضبط؟\nقول 'هنا' أو أرسل ID الغروب (رقم)");
      return;
    }
    w.step = "motor_choice";
    reply("محرك؟\n(نعم / التلقائي / لا)");
    return;
  }

  if (w.step === "motor_choice") {
    if (text === "نعم" || text === "التلقائي") {
      w.motorType = text === "التلقائي" ? "motor2" : "motor1";
      const label = text === "التلقائي" ? " (ذكي — يرسل فقط عند النشاط)" : "";
      w.step = "motor_input";
      reply(`شن المحرك${label}؟\nصيغة: [رسالة]/[وقت]\nأمثلة:\nhi/45s\nhi/2m\nhi/r 60s-5m`);
    } else if (text === "لا") {
      w.motorType = null;
      w.step = "name_choice";
      reply("اقفل الاسم؟\n(نعم / لا)");
    } else {
      reply("قول 'نعم' أو 'التلقائي' أو 'لا'");
    }
    return;
  }

  if (w.step === "motor_input") {
    const parsed = _parseMotorInput(text);
    if (!parsed) {
      reply("صيغة غلط، جرب:\nhi/45s  |  hi/2m  |  hi/r 60s-5m\n(الحد الأدنى 5 ثواني)");
      return;
    }
    w.motorMsg = parsed.msg; w.motorTime = parsed.time;
    w.motorRandom = parsed.random; w.motorRange = parsed.range;
    w.step = "name_choice";
    reply("اقفل الاسم؟\n(نعم / لا)");
    return;
  }

  if (w.step === "name_choice") {
    if (text === "نعم") {
      w.lockName = true;
      w.step = "name_value";
      reply("شن الاسم اللي تحب تقفله؟");
    } else if (text === "لا") {
      w.lockName = false;
      w.step = "nick_choice";
      reply("اقفل الكنيات؟\n(نعم / لا)");
    } else {
      reply("قول 'نعم' أو 'لا'");
    }
    return;
  }

  if (w.step === "name_value") {
    if (!text) { reply("أدخل الاسم"); return; }
    w.groupName = text;
    w.step = "nick_choice";
    reply("اقفل الكنيات؟\n(نعم / لا)");
    return;
  }

  if (w.step === "nick_choice") {
    if (text === "نعم") {
      w.lockNick = true;
      w.step = "nick_input";
      reply("شن الكنية والوقت؟\nصيغة: [كنية]/[وقت]\nأمثلة:\nZAO/2s\nZAO/r 1s-5s\nZAO/500ms");
    } else if (text === "لا") {
      w.lockNick = false;
      global.zaoWizard.delete(senderID);
      _applyWizard(api, w);
      reply(_fmtWizardSummary(w));
    } else {
      reply("قول 'نعم' أو 'لا'");
    }
    return;
  }

  if (w.step === "nick_input") {
    const parsed = _parseNickInput(text);
    if (!parsed) {
      reply("صيغة غلط، جرب:\nZAO/2s  |  ZAO/r 1s-5s  |  ZAO/500ms");
      return;
    }
    w.nickName = parsed.nick; w.nickTime = parsed.time;
    w.nickRandom = parsed.random; w.nickRange = parsed.range;
    global.zaoWizard.delete(senderID);
    _applyWizard(api, w);
    reply(_fmtWizardSummary(w));
    return;
  }
}
// ─── END WIZARD ───────────────────────────────────────────────────────────────

// ─── VIEW WIZARD (شوف الجروب) ──────────────────────────────────────────────
// One-step wizard: ask where → display current group status in one message.

function _fmtGroupStatus(tid) {
  const tFmt = (random, range, time) =>
    random ? `🎲 ${range.min / 1000}s–${range.max / 1000}s` : `${time / 1000}s`;

  let lines = [`📊 حالة الغروب [${tid}]`, "━".repeat(22)];

  // ── Motor 1
  const m1 = (global.motorData || {})[tid];
  if (m1 && m1.status) {
    lines.push(`⚡ محرك 1: ✅ شغال`);
    lines.push(`   رسالة: "${m1.message}"`);
    lines.push(`   وقت: ${tFmt(m1.randomTime, m1.randomRange, m1.time)}`);
  } else {
    lines.push("⚡ محرك 1: ❌ موقف");
  }

  // ── Motor 2
  const m2 = (global.motorData2 || {})[tid];
  if (m2 && m2.status) {
    lines.push(`🤖 محرك 2 (ذكي): ✅ شغال`);
    lines.push(`   رسالة: "${m2.message}"`);
    lines.push(`   وقت: ${tFmt(m2.randomTime, m2.randomRange, m2.time)}`);
  } else {
    lines.push("🤖 محرك 2 (ذكي): ❌ موقف");
  }

  // ── Name lock
  try {
    const { getLock: getNameLock } = require("../../includes/nameLocks");
    const nl = getNameLock(tid);
    if (nl && nl.name) {
      lines.push(`🔒 قفل الاسم: ✅`);
      lines.push(`   اسم: "${nl.name}"`);
      lines.push(`   وقت: ${tFmt(nl.randomTime, nl.randomRange, nl.time)}`);
    } else {
      lines.push("🔒 قفل الاسم: ❌ مفتوح");
    }
  } catch (_) {
    lines.push("🔒 قفل الاسم: ❓ خطأ");
  }

  // ── Nickname lock
  try {
    const { getLock: getNickLock } = require("../../includes/nicknameLocks");
    const nk = getNickLock(tid);
    if (nk && nk.nickname) {
      lines.push(`👤 قفل الكنيات: ✅`);
      lines.push(`   كنية: "${nk.nickname}"`);
      lines.push(`   وقت: ${tFmt(nk.randomTime, nk.randomRange, nk.time)}`);
    } else {
      lines.push("👤 قفل الكنيات: ❌ مفتوح");
    }
  } catch (_) {
    lines.push("👤 قفل الكنيات: ❓ خطأ");
  }

  return lines.join("\n");
}

function _startViewWizard(api, event) {
  const { threadID, messageID, senderID } = event;
  if (!global.zaoViewWizard) global.zaoViewWizard = new Map();
  global.zaoViewWizard.set(senderID, {
    callerThread: String(threadID),
    lastBotMsgID: null
  });
  api.sendMessage("وين؟\n(قول 'هنا' أو أرسل ID الغروب)", threadID, (err, info) => {
    if (!err && info) {
      const w = global.zaoViewWizard?.get(senderID);
      if (w) w.lastBotMsgID = info.messageID;
    }
  }, messageID);
}

function _processViewWizard(api, event, text, w, senderID) {
  const { threadID, messageID } = event;
  text = (text || "").trim();

  let tid;
  if (text === "هنا") {
    tid = String(threadID);
  } else if (/^\d{10,}$/.test(text)) {
    tid = text;
  } else {
    api.sendMessage("وين بالضبط؟\nقول 'هنا' أو أرسل ID الغروب (رقم)", threadID, (err, info) => {
      if (!err && info) w.lastBotMsgID = info.messageID;
    }, messageID);
    return;
  }

  global.zaoViewWizard.delete(senderID);
  api.sendMessage(_fmtGroupStatus(tid), threadID, null, messageID);
}
// ─── END VIEW WIZARD ──────────────────────────────────────────────────────────

// ── Errors that mean "this model is unavailable / out of quota" ─────────────
function _isFallbackError(err) {
  const status = err?.response?.status;
  if (!status) return true; // network error → try next
  // 429 rate-limit | 402 payment/credits | 503 model down | 500 server error
  if ([402, 429, 500, 503].includes(status)) return true;
  // OpenRouter also embeds errors inside a 200 response body
  const body = err?.response?.data;
  if (body?.error) return true;
  return false;
}

// ── Main AI call with automatic model fallback ───────────────────────────────
async function askAI(history, senderID) {
  const messages = [
    { role: "system", content: buildSystemPrompt(senderID) },
    ...history.map(msg => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content
    }))
  ];

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "HTTP-Referer": "https://zaobot.replit.app",
    "X-OpenRouter-Title": "ZAO Bot"
  };

  // Start from the last known-good model index so fast-path skips dead ones.
  const startIdx = _bestModelIdx;
  // Build a rotation: [startIdx, startIdx+1, ..., len-1, 0, ..., startIdx-1]
  const order = [];
  for (let i = 0; i < OPENROUTER_MODELS.length; i++) {
    order.push((startIdx + i) % OPENROUTER_MODELS.length);
  }

  let lastErr = null;

  for (const idx of order) {
    const model = OPENROUTER_MODELS[idx];
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        { model, messages, max_tokens: 512, temperature: 0.9 },
        { headers, timeout: 25000 }
      );

      // OpenRouter can return a 200 with an error object inside
      if (res.data?.error) {
        const msg = res.data.error?.message || "";
        console.warn(`[AI] Model ${model} returned error in body: ${msg}`);
        lastErr = new Error(msg);
        continue;
      }

      const raw = res.data.choices?.[0]?.message?.content;
      if (!raw || !raw.trim()) {
        console.warn(`[AI] Model ${model} returned empty content — trying next`);
        lastErr = new Error("empty response");
        continue;
      }

      // ✅ Success — update the best-model pointer
      if (_bestModelIdx !== idx) {
        console.log(`[AI] Switched to model [${idx}] ${model}`);
        _bestModelIdx = idx;
      }

      return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    } catch (err) {
      const status = err?.response?.status;
      const errMsg = err?.response?.data?.error?.message || err?.message || "unknown";
      console.warn(`[AI] Model ${model} failed (HTTP ${status || "N/A"}): ${errMsg}`);
      lastErr = err;

      if (!_isFallbackError(err)) {
        // Hard non-retriable error (e.g. 401 bad key) — don't try others
        throw err;
      }
      // Soft error → continue to next model
    }
  }

  // All OpenRouter models exhausted — try pollinations.ai as final free fallback
  try {
    console.log("[AI] All OpenRouter models failed. Trying pollinations.ai fallback...");
    const seed = Math.floor(Math.random() * 1000000);
    const polRes = await axios.post(
      "https://text.pollinations.ai/openai",
      { model: "openai-fast", messages, seed, max_tokens: 512, temperature: 0.9 },
      { timeout: 25000, headers: { "Content-Type": "application/json" } }
    );
    const polRaw = polRes.data?.choices?.[0]?.message?.content;
    if (polRaw && polRaw.trim()) {
      console.log("[AI] pollinations.ai fallback succeeded.");
      return polRaw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }
  } catch (polErr) {
    console.warn("[AI] pollinations.ai fallback also failed:", polErr?.message);
  }

  // All AI providers exhausted
  console.error("[AI] All providers failed. Last error:", lastErr?.message);
  throw lastErr || new Error("All AI models failed");
}

module.exports.handleEvent = async function ({ api, event }) {
  if (!OPENROUTER_API_KEY) return;

  const { threadID, messageID, senderID, body, messageReply } = event;

  if (!messageReply) return;
  if (!body || typeof body !== "string") return;

  // 1a. Active view wizard step
  const viewWizard = global.zaoViewWizard?.get(senderID);
  if (viewWizard && String(threadID) === viewWizard.callerThread && messageReply.messageID === viewWizard.lastBotMsgID) {
    _processViewWizard(api, event, body.trim(), viewWizard, senderID);
    return;
  }

  // 1b. Active setup wizard step: reply must match wizard's last prompt
  const wizard = global.zaoWizard?.get(senderID);
  if (wizard && String(threadID) === wizard.callerThread && messageReply.messageID === wizard.lastBotMsgID) {
    await _processWizard(api, event, body.trim(), wizard);
    return;
  }

  // 2. Regular AI session required from here
  if (!global.zaoHistory[senderID]) return;
  const session = global.zaoHistory[senderID];
  if (messageReply.messageID !== session.lastBotMessageID) return;

  // 2a. Wizard triggers via reply to "شني"
  const trimmed = body.trim();
  if (trimmed === "شد الجروب" || trimmed === "شد الجدروب") {
    _startWizard(api, event);
    return;
  }
  if (trimmed === "شوف الجروب") {
    _startViewWizard(api, event);
    return;
  }

  // 2b. Normal AI reply
  session.lastTouched = Date.now();
  session.history.push({ role: "user", content: trimmed });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  try {
    const reply = await askAI(session.history, senderID);
    session.history.push({ role: "assistant", content: reply });
    session.lastTouched = Date.now();

    api.sendMessage(reply, threadID, (err, info) => {
      if (!err) session.lastBotMessageID = info.messageID;
    }, messageID);

  } catch (e) {
    api.sendMessage(e.response?.data?.error?.message || "حصلت مشكلة", threadID, messageID);
  }
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;

  // Guard: OPENROUTER_API_KEY must be set via environment variable
  if (!OPENROUTER_API_KEY) {
    return api.sendMessage(
      "⚠️ OPENROUTER_API_KEY is not configured. Set it via environment secrets to enable AI.",
      threadID, messageID
    );
  }

  const userMsg = args.join(" ").trim();

  // Wizard triggers via direct command
  if (userMsg === "شد الجروب" || userMsg === "شد الجدروب") {
    _startWizard(api, event);
    return;
  }
  if (userMsg === "شوف الجروب") {
    _startViewWizard(api, event);
    return;
  }

  if (!userMsg) return api.sendMessage("شني", threadID, (err, info) => {
    if (!err) {
      if (!global.zaoHistory[senderID]) {
        global.zaoHistory[senderID] = { history: [], lastBotMessageID: null, lastTouched: Date.now() };
      }
      global.zaoHistory[senderID].lastBotMessageID = info.messageID;
      global.zaoHistory[senderID].lastTouched = Date.now();
    }
  });

  if (!global.zaoHistory[senderID]) {
    global.zaoHistory[senderID] = { history: [], lastBotMessageID: null, lastTouched: Date.now() };
  }

  const session = global.zaoHistory[senderID];
  session.lastTouched = Date.now();
  session.history.push({ role: "user", content: userMsg });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  try {
    const reply = await askAI(session.history, senderID);
    session.history.push({ role: "assistant", content: reply });
    session.lastTouched = Date.now();

    api.sendMessage(reply, threadID, (err, info) => {
      if (!err) session.lastBotMessageID = info.messageID;
    }, messageID);

  } catch (e) {
    api.sendMessage(e.response?.data?.error?.message || "حصلت مشكلة", threadID, messageID);
  }
};
