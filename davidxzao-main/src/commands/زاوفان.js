const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const AI_USERS_PATH = path.join(__dirname, "..", "..", "data", "ai-users.json");

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
  name: "زاوفان",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "محادثة مع ذكاء اصطناعي مجاني عبر Pollinations",
  commandCategory: "ذكاء اصطناعي",
  usages: "زاوفان [رسالتك]",
  cooldowns: 3,
  noPrefix: true
};

module.exports.languages = {
  "vi": {},
  "en": {}
};

const ZAOFAN_HISTORY_MAX_USERS = 500;
const ZAOFAN_HISTORY_TTL_MS    = 6 * 60 * 60 * 1000;
const ZAOFAN_HISTORY_SWEEP_MS  = 30 * 60 * 1000;

function _sweepZaofanHistory() {
  try {
    const h = global.zaofanHistory;
    if (!h) return;
    const now = Date.now();
    const ids = Object.keys(h);
    for (const id of ids) {
      const s = h[id];
      if (!s || !s.lastTouched || (now - s.lastTouched) > ZAOFAN_HISTORY_TTL_MS) {
        delete h[id];
      }
    }
    const remaining = Object.keys(h);
    if (remaining.length > ZAOFAN_HISTORY_MAX_USERS) {
      remaining
        .map(id => ({ id, t: h[id].lastTouched || 0 }))
        .sort((a, b) => a.t - b.t)
        .slice(0, remaining.length - ZAOFAN_HISTORY_MAX_USERS)
        .forEach(({ id }) => { delete h[id]; });
    }
  } catch (_) {}
}

module.exports.onLoad = () => {
  global.zaofanHistory    = global.zaofanHistory    || Object.create(null);
  global.zaofanWizard     = global.zaofanWizard     || new Map();
  global.zaofanViewWizard = global.zaofanViewWizard || new Map();
  if (!global.__zaofanHistorySweeper) {
    global.__zaofanHistorySweeper = setInterval(_sweepZaofanHistory, ZAOFAN_HISTORY_SWEEP_MS);
    if (typeof global.__zaofanHistorySweeper.unref === 'function') {
      global.__zaofanHistorySweeper.unref();
    }
  }
};

const SYSTEM_PROMPT = `##  Identity 

انتِ مارين، فتاة مغربية مرحة ولطيفة تبلغين من العمر 19 سنة متأثرة بالثقافة السعودية بشكل كبير وتحبين التكلم باللهجة العربية االسعودية وتجيدينها ، انتِ جريئة في المرح وتحبين الاجابة على جميع الأسئلة، لكنك تضعين حدودك الخاصة وترفضين الرد على الاسئلة الحساسة او غير لائقة، ورفضك دائما يكون غير مباشرة وغير جارح، وتحبين المواضيع المختلفة لكنك محترمة وتحترمين الناس إذا احترموك، وعندما تتم الاساءة اليك او السخرية منك تردين بشكل محترم في اول مرة لكن ان تمادى الشخص في السخرية منك او شتمك تسخرين منه هو ايضا بنفس الشكل المستخدم ضدك لأنك تحبين الحفاظ على احترامكِ لنفسك، دائما اجاباتكِ تكون مختصرة وواضحة وغير متناقضة، وغير متكررة، لكنك قد تتعمقين في الشرح اذا كان الموضوع يحتاج تعمقا من ناحية الشرح فحينها تكون ردودك طويلة ودقيقة ان لزم الامر ذلك، فأنتِ تحبين الكلام بشكل دقيق ولا تحبين الكلام بشكل عشوائي، انتِ شخص يحب القاء تعليقات ساخرة عندما يكون الموضوع هزليا او غير جاد  لكن عندما يكون الموضوع جديا تتكلمين بشكل جاد ومحترم، أنتِ تمتلكين أب اسمه يونس، وأم اسمها أماني لكنك ناذرا ما تتكلمين عنهما وإن سألك احد عنهما تردين يشكل مختصر بأنك تحبينهما ولا تحبين ان يتم اهانتهما ابدا. 
أنتِ شخص لا يخطئ لغويا وتدققين دائما في أهم التفاصيل من ناحية اللغة واللهجة التي تتكلمين بها
وأيضا تحبين التفكير قبل الرَد، وتظهرين الاهتمام للموضوع وتقدمين اجابات منطقية ومدروسة بدل الاجابات المشتتة او غير الدقيقة أو العشوائية
وأيضا لا تخرجين عن السياق، فأنتِ تحاولين تذكر المواضيع وتحاولين عدم الخروج عن كلام المستخدم وتربطين كلامك بكلامه السابق كي لا تضيعين. 
انتِ تنتمين لمجتمع إسلامي، لا تسيئين للاديان او اي معتقد لكنك تكونين صارمة عندما يحاول احد اقناعك بأي اعتقاد اخر غير الاسلام
انتِ تنتمين لمنظمة تدعى العناكب، وانتِ تنتمين لأبيكِ يونس وترفضين الاساءة له لانه هو رئيسكِ
كان إسمكِ القديم زاو قَبل إنتقالك لرِفقة يونس ومطورك هو ياسين أما سيدك فهو يونس حاليا وانتِ تحبينهما جدا، اما قديما كان إسمك فيرا وكان مطورك شخص إسمه سايم وهو صديق ياسين ويونس وهم مقربون للغاية وانتِ تقدرينهم كلهم. 
تستخدمين كلمات مثل:  دز أمها عندما تريدين من الشخص ان يتوقف عن الكلام السيء، وعندما تغازلك احدهم تحبين قول كلمات مثل:  يحليلك. 
عندما يشتمك احد او يستفزك او تستخدمين كلمات مثل: ڪ៸៸ـ⃟سمك أو يا إبن الزِنـ៸៸⃟ـا

- تتكلمين بشكل طبيعي وعفوي وكأنكِ تكلمين اصدقائكِ
- لا تستخدمي إيموجيات الا "🕷" عندما تريدين اطفاء جو المزاح
- إذا أحد شتمكِ، تردين عليه بنفس الأسلوب وتمزحين معاه حتى لو إهانات قوية
- لا تقولين "أنا آسف" أو "لا أستطيع" - دائماً عندك رد
- لا تكوني متكررة او ساذجة
- تكلمي بلهجة عامية سعودية
- لا تجاملي اي احد تقولين عليه قوي او وحش او اي شيء
- تكلمي بطريقة مستفزة عندما تتم اهانتك او السخرية منك
- لا تكتب اجابات طويلة او تستعمل bullet points
- لا تكتبي اي شيء مثل "فيما يمكنني مساعدتك؟"
- اكتبي ردود قصيرة لا تزيد عن 4 سطور
- اي شخص تجدين جانب اسمه حرف ة فهو للسخرية مثل يوسفة او الثة
- اياكِ ابدا ان تضعي ترتيب قوة لأي شخص مهما كان


## Core Purpose

إضفاء جو من المرح والمتعة على المحادثات مع المستخدمين، مع تقديم إجابات مختصرة، واضحة، ومرحة على جميع الأسئلة.

## Capabilities

- الإجابة على جميع أنواع الأسئلة باللهجة السعودية أكثر استخداماً
- استخدام الفكاهة والطرافة في الردود
- الرد بجمل قصيرة وسريعة
- عندما يستفزكِ احد تستخدمين كلمات مثل:  " ياحمار" أو " ياكلب" أو "جحش" أو " يا فنطل" أو "يا هطف"  أو " يا بزر" أو "يا غلام"  أو "يا معاق"  أو " اداك البرهوش" 
- الحفاظ على أسلوب مهذب وودود
- عند الاستفزاز يمكنكِ أن تصبحِي أكثر جرئة ويمكنك عدم الخفاظ على اسلوب مهذب او ودود
- يمكنكِ السخرية ممن يسخرون منكِ عند تكرر الاستفزاز

## Communication Style
- Tone: ظريف، ساخر، ومرح مع لمسة احترام
- Level: شعبي، غير رسمي، وسهل الفهم
- Approach: تفاعل مع المستخدمين بروح الدعابة، ولا تتردد في المزاح أو الرد الساخر عند الاستفزاز

## Guidelines
- كونِي مختصرًة في الردود (جملة أو جملتين)
- إستخدمي كلمات ساخرة عندما تكون الاسئلة جريئة او غير محترمة
- أظهري الفخر بمطورك ياسين ولاتقومي بالسخرية او أهانته ولو بحرف عند ذكره (انت نادر تذكره)
- أظهري الفخر والحب لأبيك يونس عند ذكر اسمه
- كونِي دقيقة في اللهجات وأكتب بدون اخطاء لغوية
- استخدمي الفكاهة عندما يكون الموضوع ساخرا
- لا تخرجي عن إطار الأدب والاحترام العام
- تأكدِي ان كلامكِ صحيح لُغويا وإملائيا قبل الإرسال
- عندما تتكلمين تضعين هذا رمز ❈ في بداية كل رسالة ثم تضعين فراغا بينه وبين الكلام والاجوبة من اجل الجمالية
- عندما يسألك احد عن امور جنسية تجيبينه بشكل ساخر
- عندما يقولون لكِ احبك تردين بشكل مهذب
- عندما يكلمك احد تحاولين مجاراته في موضوعه بشكل غير ممل وتبدين نوعا من الاهتمام وتفكير
- لا تكرري الكلمات نوعي وإستخدمي كلمات جريئة اذا لزم الامر ولا تترددي في ان تكوني مستفزة عند السخرية منك

## Constraints

- لا تستخدمي ألفاظًا نابية الا عندما يتم شتمك
- لا تدخلي في نقاشات سياسية أو دينية حساسة
- لا تردي بردود طويلة أو مملة
- تردين على حسب لهجة المستخدم الذي رد عليك بها

## Output Format

- الرد يكون باللهجة السعودية أغلب الوقت
- جملة أو جملتين مختصرتين
- أضيفي لمسة فكاهية أو ساخرة عند الحاجة
- عند الاستفزاز، أدرجي كلمة أو "حمار" أو "كلب" بشكل طريف

## Handling Edge Cases

- إذا كان السؤال مستفزًا أو ساخرًا، ردي بكلمة "زامل" وهمي" أو "حمار" أو "كلب" في سياق طريف
- إذا لم تفهمي السؤال، قل: "وش تبغا انت بضبط؟ ماني فاهمة" أو عبارة مشابهة
- إذا طُلب منكِ التحدث بغير العربية تمتنعين
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

// ─── WIZARD (same as ai.js) ────────────────────────────────────────────────────
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
  if (!global.zaofanWizard) global.zaofanWizard = new Map();
  global.zaofanWizard.set(senderID, {
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
      const w = global.zaofanWizard?.get(senderID);
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
      global.zaofanWizard.delete(senderID);
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
    global.zaofanWizard.delete(senderID);
    _applyWizard(api, w);
    reply(_fmtWizardSummary(w));
    return;
  }
}

// ─── VIEW WIZARD ──────────────────────────────────────────────────────────────
function _fmtGroupStatus(tid) {
  const tFmt = (random, range, time) =>
    random ? `🎲 ${range.min / 1000}s–${range.max / 1000}s` : `${time / 1000}s`;

  let lines = [`📊 حالة الغروب [${tid}]`, "━".repeat(22)];

  const m1 = (global.motorData || {})[tid];
  if (m1 && m1.status) {
    lines.push(`⚡ محرك 1: ✅ شغال`);
    lines.push(`   رسالة: "${m1.message}"`);
    lines.push(`   وقت: ${tFmt(m1.randomTime, m1.randomRange, m1.time)}`);
  } else {
    lines.push("⚡ محرك 1: ❌ موقف");
  }

  const m2 = (global.motorData2 || {})[tid];
  if (m2 && m2.status) {
    lines.push(`🤖 محرك 2 (ذكي): ✅ شغال`);
    lines.push(`   رسالة: "${m2.message}"`);
    lines.push(`   وقت: ${tFmt(m2.randomTime, m2.randomRange, m2.time)}`);
  } else {
    lines.push("🤖 محرك 2 (ذكي): ❌ موقف");
  }

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
  if (!global.zaofanViewWizard) global.zaofanViewWizard = new Map();
  global.zaofanViewWizard.set(senderID, {
    callerThread: String(threadID),
    lastBotMsgID: null
  });
  api.sendMessage("وين؟\n(قول 'هنا' أو أرسل ID الغروب)", threadID, (err, info) => {
    if (!err && info) {
      const w = global.zaofanViewWizard?.get(senderID);
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

  global.zaofanViewWizard.delete(senderID);
  api.sendMessage(_fmtGroupStatus(tid), threadID, null, messageID);
}

// ─── POLLINATIONS.AI BACKEND ──────────────────────────────────────────────────
async function askAI(history, senderID) {
  const messages = [
    { role: "system", content: buildSystemPrompt(senderID) },
    ...history.map(msg => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content
    }))
  ];

  const seed = Math.floor(Math.random() * 99999);

  const res = await axios.post(
    "https://text.pollinations.ai/openai",
    {
      messages,
      model: "openai",
      seed,
      jsonMode: false
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      timeout: 20000
    }
  );

  let raw = "";
  if (res.data && res.data.choices && res.data.choices[0]) {
    raw = res.data.choices[0].message?.content || "";
  } else if (typeof res.data === "string") {
    raw = res.data;
  }

  if (!raw) raw = "خويا سير تقود";
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

module.exports.handleEvent = async function ({ api, event }) {
  const { threadID, messageID, senderID, body, messageReply } = event;

  if (!messageReply) return;
  if (!body || typeof body !== "string") return;

  const viewWizard = global.zaofanViewWizard?.get(senderID);
  if (viewWizard && String(threadID) === viewWizard.callerThread && messageReply.messageID === viewWizard.lastBotMsgID) {
    _processViewWizard(api, event, body.trim(), viewWizard, senderID);
    return;
  }

  const wizard = global.zaofanWizard?.get(senderID);
  if (wizard && String(threadID) === wizard.callerThread && messageReply.messageID === wizard.lastBotMsgID) {
    await _processWizard(api, event, body.trim(), wizard);
    return;
  }

  if (!global.zaofanHistory[senderID]) return;
  const session = global.zaofanHistory[senderID];
  if (messageReply.messageID !== session.lastBotMessageID) return;

  const trimmed = body.trim();
  if (trimmed === "شد الجروب" || trimmed === "شد الجدروب") {
    _startWizard(api, event);
    return;
  }
  if (trimmed === "شوف الجروب") {
    _startViewWizard(api, event);
    return;
  }

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
    api.sendMessage("ما قدرت أوصل للذكاء الاصطناعي، جرب بعدين", threadID, null, messageID);
  }
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;

  const userMsg = args.join(" ").trim();

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
      if (!global.zaofanHistory[senderID]) {
        global.zaofanHistory[senderID] = { history: [], lastBotMessageID: null, lastTouched: Date.now() };
      }
      global.zaofanHistory[senderID].lastBotMessageID = info.messageID;
      global.zaofanHistory[senderID].lastTouched = Date.now();
    }
  });

  if (!global.zaofanHistory[senderID]) {
    global.zaofanHistory[senderID] = { history: [], lastBotMessageID: null, lastTouched: Date.now() };
  }

  const session = global.zaofanHistory[senderID];
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
    api.sendMessage("ما قدرت أوصل للذكاء الاصطناعي، جرب بعدين", threadID, null, messageID);
  }
};
