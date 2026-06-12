'use strict';

module.exports.config = {
  name:            'اوامر',
  aliases:         ['help', 'cmds', 'commands', 'أوامر', 'الاوامر', 'helpme', 'h'],
  version:         '5.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team',
  description:     'عرض فئات الأوامر — رد برقم الفئة لعرض أوامرها',
  commandCategory: 'معلومات',
  usages:          'اوامر | اوامر أمر [اسم]',
  cooldowns:       4,
};

module.exports.languages = { vi: {}, en: {} };

// ─── Category merge map ───────────────────────────────────────────────────────
const CAT_MERGE = {
  'admin':              'إدارة البوت',
  'إدارة':             'إدارة المجموعة',
  'المجموعة':          'إدارة المجموعة',
  'النظام':            'نظام',
  'System':            'نظام',
  'system':            'نظام',
  'Security':          'نظام',
  'الأدوات':           'أدوات',
  'الذكاء الاصطناعي': 'ذكاء اصطناعي',
  'تيست':              'مطور',
};

const CAT_ORDER = [
  ['إدارة البوت',    '🪭'],
  ['إدارة المجموعة', '☕'],
  ['نظام',           '⚖️'],
  ['أدوات',          '🪙'],
  ['ألعاب',          '🕸'],
  ['ترفيه',          '🪶'],
  ['ذكاء اصطناعي',   '🧲'],
  ['ميديا',          '☢️'],
  ['معلومات',        '🪅'],
  ['مطور',           '🧬'],
];

const CAT_EMOJI_MAP  = new Map(CAT_ORDER);
const EXTRA_EMOJIS   = ['🌀','🔮','🎯','🧩','🎲','🌙','⚡','🔭','🎪','🧸'];
const HEADER         = `⌗ ∝ 𝐙͋'𝖆⃪̷͟𝛔͓𝖋̶𝐚̸̷̶̝ƞ͟ິ'͓👁️‍🗨️  𖣴 𝕭ິ︩︪𝐨̸ȶ 🪭`;
const _BOLD_DIGITS   = ['𝟎','𝟏','𝟐','𝟑','𝟒','𝟓','𝟔','𝟕','𝟖','𝟗'];

function _boldNum(n) {
  return String(n).split('').map(c => _BOLD_DIGITS[parseInt(c)] || c).join('');
}
const PREFIX = () => global.config?.PREFIX || '.';

// ─── helpers ──────────────────────────────────────────────────────────────────
function _getMap() {
  try { return global['client']?.commands; } catch (_) { return null; }
}

function _normCat(raw) {
  const c = (raw || 'عام').trim();
  return CAT_MERGE[c] || c;
}

function _buildCategoryMap(cmdMap) {
  const cats = new Map();
  if (!cmdMap) return cats;
  for (const [, cmd] of cmdMap.entries()) {
    const raw = cmd.config?.commandCategory || cmd.config?.commandcategory || 'عام';
    const cat = _normCat(raw);
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push(cmd.config?.name || '?');
  }
  return cats;
}

function _sortedCats(cats) {
  const orderedNames = CAT_ORDER.map(([n]) => n);
  return [
    ...orderedNames.filter(n => cats.has(n)),
    ...[...cats.keys()].filter(n => !orderedNames.includes(n)),
  ];
}

function _catEmoji(catName, idx) {
  if (CAT_EMOJI_MAP.has(catName)) return CAT_EMOJI_MAP.get(catName);
  return EXTRA_EMOJIS[idx % EXTRA_EMOJIS.length];
}

// ─── run ──────────────────────────────────────────────────────────────────────
module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const cmdMap = _getMap();
  const P = PREFIX();

  if (!cmdMap || cmdMap.size === 0) {
    return api.sendMessage('⚠️ لم تُحمَّل الأوامر بعد. انتظر لحظة وأعد المحاولة.', threadID, messageID);
  }

  // ── .اوامر أمر [اسم] — تفاصيل أمر محدد ─────────────────────────────────────
  if (args[0] === 'أمر' || args[0] === 'cmd' || args[0] === 'info') {
    const search = args.slice(1).join(' ').toLowerCase();
    if (!search) return api.sendMessage(`ℹ️ مثال: ${P}اوامر أمر أصدقاء`, threadID, messageID);
    let found = null;
    for (const [, cmd] of cmdMap.entries()) {
      const nm  = (cmd.config?.name || '').toLowerCase();
      const ali = (cmd.config?.aliases || []).map(a => a.toLowerCase());
      if (nm === search || ali.includes(search)) { found = cmd; break; }
    }
    if (!found) return api.sendMessage(`❌ الأمر "${args.slice(1).join(' ')}" غير موجود.`, threadID, messageID);
    const c = found.config;
    const lines = [
      `${HEADER}`,
      ``,
      `📋 ${c.name}`,
      `📝 الوصف: ${c.description || '—'}`,
      `🔤 الاستخدام: ${P}${c.usages || c.name}`,
      `🏷️ الفئة: ${_normCat(c.commandCategory || '—')}`,
      `⏱️ التهدئة: ${c.cooldowns || 0}ث`,
      `🔐 الصلاحية: ${c.hasPermssion === 0 ? 'الجميع' : c.hasPermssion === 1 ? 'أدمن المجموعة' : c.hasPermssion === 2 ? 'أدمن البوت' : 'المطوّر'}`,
    ];
    if (c.aliases?.length) lines.push(`🔗 البدائل: ${c.aliases.join(', ')}`);
    return api.sendMessage(lines.join('\n'), threadID, messageID);
  }

  // ── .اوامر — قائمة الفئات فقط (بدون الأوامر) ─────────────────────────────
  const cats   = _buildCategoryMap(cmdMap);
  const sorted = _sortedCats(cats);
  const total  = cmdMap.size;

  const catIndex = [];   // catIndex[i] = canonical cat name (1-based: catIndex[0] = cat#1)
  let extraIdx = 0;
  const lines  = [HEADER, ''];

  let num = 0;
  for (const cat of sorted) {
    const names = cats.get(cat) || [];
    if (!names.length) continue;
    num++;
    const emoji = _catEmoji(cat, extraIdx);
    if (!CAT_EMOJI_MAP.has(cat)) extraIdx++;
    catIndex.push(cat);
    lines.push(`≼${_boldNum(num)}≽ ⥽ ꐾ̷̷̸'ິ ${cat} ↴̶ ໋${emoji}  · ${names.length} أمر`);
  }

  lines.push('');
  lines.push(`📊 ${total} أمر · ${cats.size} فئة`);
  lines.push(`↩️ رد برقم الفئة لعرض أوامرها`);
  lines.push(`💡 ${P}اوامر أمر [اسم] — تفاصيل أمر`);

  return api.sendMessage(lines.join('\n'), threadID, (err, info) => {
    if (err || !info) return;
    global.client.handleReply.push({
      name:      'اوامر',
      messageID: info.messageID,
      author:    senderID,
      catIndex,
      cats:      Object.fromEntries(cats),
    });
  }, messageID);
};

// ─── handleReply — reply with a category number ───────────────────────────────
module.exports.handleReply = async function ({ api, event, handleReply: hr }) {
  const { threadID, messageID, senderID, body } = event;
  const P = PREFIX();

  const num = parseInt(String(body || '').trim(), 10);
  if (isNaN(num) || num < 1 || num > hr.catIndex.length) {
    global.client.handleReply.push({ ...hr, messageID });
    return api.sendMessage(
      `⚠️ ابعث رقم بين 1 و ${hr.catIndex.length} لعرض أوامر الفئة.`,
      threadID, messageID
    );
  }

  const cat   = hr.catIndex[num - 1];
  const names = hr.cats[cat] || [];
  const emoji = CAT_EMOJI_MAP.get(cat) || '🌀';

  const lines = [
    HEADER,
    '',
    `≼${_boldNum(num)}≽ ⥽ ꐾ̷̷̸'ິ ${cat} ↴̶ ໋${emoji}`,
    '',
    ...names.map(n => `  • ${P}${n}`),
    '',
    `💡 ${P}اوامر أمر [اسم] — تفاصيل أمر`,
    `↩️ رد برقم آخر للتنقل بين الفئات`,
  ];

  // Re-register so user can keep navigating to other categories
  return api.sendMessage(lines.join('\n'), threadID, (err, info) => {
    if (err || !info) return;
    global.client.handleReply.push({ ...hr, messageID: info.messageID });
  }, messageID);
};
