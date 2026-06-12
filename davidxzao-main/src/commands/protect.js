'use strict';

/**
 * protect.js — Nickname Protection
 * ==================================
 * Protects group member nicknames from being changed by non-admins.
 *  • Bot admin changes a nickname → saved automatically
 *  • Anyone else changes a nickname → reverted to saved value
 *
 * Ported from White V3, adapted for ZAO's command format.
 *
 * Commands (bot admin only):
 *   .protect on           — enable protection & snapshot nicknames
 *   .protect off          — disable protection
 *   .protect set @user nick — manually set and save a nickname
 *   .protect list          — show saved nicknames
 */

const fs   = require('fs-extra');
const path = require('path');

const DATA_FILE = path.join(process.cwd(), 'data', 'protectData.json');

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

const { atomicWriteFileSync: _atomicWrite } = (() => {
  try { return require('../../utils/atomicWrite'); }
  catch (_) { return { atomicWriteFileSync: (p, d) => fs.writeFileSync(p, d) }; }
})();

function saveData(data) {
  try {
    fs.ensureDirSync(path.dirname(DATA_FILE));
    _atomicWrite(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

let _data = loadData();

function getThread(threadID) {
  if (!_data[threadID]) _data[threadID] = { enable: false, nicknames: {} };
  return _data[threadID];
}

function save() {
  _data = JSON.parse(JSON.stringify(_data));
  saveData(_data);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _live(api) {
  return global._botApi || api;
}

function isAdmin(senderID) {
  return (global.config?.ADMINBOT || []).map(String).includes(String(senderID));
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports.config = {
  name:            'protect',
  version:         '2.1',
  author:          'ZAO',
  cooldowns:       3,
  hasPermssion:    2,
  description:     'حماية كُنيات أعضاء المجموعة من التغيير',
  commandCategory: 'المجموعة',
  guide:           '  {pn} on | off | set @شخص كُنية | list',
  usePrefix:       true,
};

module.exports.onLoad = function () {
  _data = loadData();
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID, senderID, mentions } = event;
  const rawBody = (event.body || '').trim();
  const args    = rawBody.split(/\s+/).slice(1);
  const sub     = (args[0] || '').toLowerCase();

  if (!isAdmin(senderID)) {
    return api.sendMessage('⛔ هذا الأمر خاص بأدمن البوت فقط.', threadID, messageID);
  }

  const td = getThread(threadID);

  if (sub === 'on') {
    let info;
    try { info = await _live(api).getThreadInfo(threadID); } catch (_) {}
    if (!info) return api.sendMessage('❌ تعذّر جلب معلومات المجموعة.', threadID, messageID);

    const nicknames = {};
    (info.members || []).forEach(u => {
      nicknames[u.userID] = u.nickname || '';
    });

    td.enable    = true;
    td.nicknames = nicknames;
    save();

    return api.sendMessage(
      `🛡️ تم تفعيل حماية الكُنيات!\n`
      + `📋 تم حفظ كُنيات ${Object.keys(nicknames).length} عضو.\n\n`
      + '• أدمن البوت يمكنه تغيير الكُنيات بحرية.\n'
      + '• أي شخص آخر سيتم إعادة كُنيته تلقائياً.',
      threadID, messageID
    );
  }

  if (sub === 'off') {
    td.enable = false;
    save();
    return api.sendMessage('🔓 تم إيقاف حماية الكُنيات.', threadID, messageID);
  }

  if (sub === 'set') {
    const targetID = Object.keys(mentions || {})[0];
    if (!targetID) {
      return api.sendMessage('⚠️ حدد الشخص بالإشارة إليه: .protect set @شخص كُنيته', threadID, messageID);
    }
    const nickname = args.slice(2).join(' ').trim();
    if (!nickname) {
      return api.sendMessage('⚠️ اكتب الكُنية بعد اسم الشخص.', threadID, messageID);
    }
    if (!td.enable) {
      return api.sendMessage('⚠️ الحماية غير مفعّلة. شغّلها أولاً بـ .protect on', threadID, messageID);
    }

    try { await _live(api).changeNickname(nickname, threadID, targetID); } catch (_) {}
    td.nicknames[targetID] = nickname;
    save();

    return api.sendMessage(`✅ تم ضبط الكُنية إلى: "${nickname}" وحفظها.`, threadID, messageID);
  }

  if (sub === 'list') {
    if (!td.enable) {
      return api.sendMessage('⚠️ الحماية غير مفعّلة.', threadID, messageID);
    }
    const entries = Object.entries(td.nicknames || {}).filter(([, v]) => v);
    if (!entries.length) {
      return api.sendMessage('📋 لا توجد كُنيات مضبوطة حالياً.', threadID, messageID);
    }
    let msg = `📋 الكُنيات المحمية (${entries.length}):\n━━━━━━━━━━━━━━━\n`;
    entries.forEach(([id, nick]) => { msg += `• ${nick}  (${id})\n`; });
    return api.sendMessage(msg, threadID, messageID);
  }

  return api.sendMessage(
    '⚙️ الاستخدام:\n'
    + '.protect on          — تفعيل\n'
    + '.protect off         — إيقاف\n'
    + '.protect set @شخص كُنية — ضبط كُنية\n'
    + '.protect list        — عرض الكُنيات',
    threadID, messageID
  );
};

// ─── handleEvent: watch for nickname changes ──────────────────────────────────

module.exports.handleEvent = async function ({ api, event }) {
  try {
    if (event.logMessageType !== 'log:user-nickname') return;

    const { threadID, author, logMessageData } = event;
    const td = getThread(threadID);
    if (!td.enable) return;

    const { participant_id, nickname } = logMessageData || {};
    const liveApi = _live(api);
    let botID;
    try { botID = String(liveApi.getCurrentUserID()); } catch (_) { botID = ''; }

    if (String(author) === botID) return;

    if (isAdmin(author)) {
      td.nicknames[participant_id] = nickname || '';
      save();
      return;
    }

    const saved = td.nicknames?.[participant_id] ?? '';
    try { await liveApi.changeNickname(saved, threadID, participant_id); } catch (_) {}
  } catch (_) {}
};
