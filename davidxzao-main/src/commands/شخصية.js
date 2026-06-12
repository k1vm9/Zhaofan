'use strict';
/**
 * شخصية.js — إدارة ملفات شخصيات المستخدمين (data/ai-users.json)
 *
 * الأوامر:
 *   .شخصية عرض             — عرض كل الشخصيات وأعداد IDs الخاصة بهم
 *   .شخصية معلومات [اسم]   — عرض التفاصيل الكاملة لشخصية معينة
 *   .شخصية إضافة_id [اسم] [id]  — إضافة ID فيسبوك لشخص موجود
 *   .شخصية حذف_id [اسم] [id]    — حذف ID من شخص
 *   .شخصية جديد [اسم] | [دور] | [وصف]  — إضافة شخصية جديدة
 *   .شخصية حذف [اسم]       — حذف شخصية بالكامل (أدمن فقط)
 */

const fs   = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('../../utils/atomicWrite');

const AI_USERS_FILE = path.join(process.cwd(), 'data', 'ai-users.json');

module.exports.config = {
  name:            'شخصية',
  aliases:         ['aiuser', 'شخصيات', 'personality'],
  version:         '1.0.0',
  hasPermssion:    0,
  credits:         'ZAO Team',
  description:     'إدارة ملفات شخصيات المستخدمين المعروفين للذكاء الاصطناعي',
  commandCategory: 'الذكاء الاصطناعي',
  usages:          'شخصية [عرض | معلومات | إضافة_id | حذف_id | جديد | حذف]',
  cooldowns:       3,
};

// ── File helpers ──────────────────────────────────────────────────────────────

function readUsers() {
  try {
    const raw  = fs.readFileSync(AI_USERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.users) ? data : { users: [] };
  } catch (_) { return { users: [] }; }
}

function saveUsers(data) {
  const dir = path.dirname(AI_USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJsonSync(AI_USERS_FILE, data);
}

function findUser(users, name) {
  const n = name.trim();
  return users.find(u =>
    u.name === n ||
    u.name?.toLowerCase() === n.toLowerCase()
  );
}

// ── Command runner ────────────────────────────────────────────────────────────

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID, senderID } = event;
  const sub  = (args[0] || '').trim();
  const rest = args.slice(1);

  // ── عرض — list all ─────────────────────────────────────────────────────────
  if (!sub || sub === 'عرض' || sub === 'list') {
    const { users } = readUsers();
    if (!users.length)
      return api.sendMessage('📭 لا توجد شخصيات مسجّلة بعد.', threadID, messageID);

    const lines = users.map((u, i) => {
      const ids = (u.ids || []).filter(Boolean);
      return `${i + 1}. ${u.name}${u.role ? ' — ' + u.role : ''}\n   🆔 ${ids.length ? ids.join(', ') : 'لا يوجد ID'}`;
    });

    return api.sendMessage(
      `👥 الشخصيات المسجّلة (${users.length}):\n\n` + lines.join('\n\n'),
      threadID, messageID
    );
  }

  // ── معلومات [اسم] — full detail ────────────────────────────────────────────
  if (sub === 'معلومات' || sub === 'info') {
    const name = rest.join(' ').trim();
    if (!name) return api.sendMessage('⚠️ استخدم: .شخصية معلومات [اسم]', threadID, messageID);

    const { users } = readUsers();
    const u = findUser(users, name);
    if (!u) return api.sendMessage(`❌ لم أجد شخصية باسم "${name}"`, threadID, messageID);

    const ids = (u.ids || []).filter(Boolean);
    const lines = [
      `👤 ${u.name}`,
      u.role      ? `🎖️ الدور: ${u.role}` : '',
      `🆔 IDs (${ids.length}):`,
      ids.length  ? ids.map(id => `   • ${id}`).join('\n') : '   لا يوجد',
      '',
      `📝 الشخصية:`,
      u.character || 'لا يوجد وصف',
    ].filter(l => l !== undefined);

    return api.sendMessage(lines.join('\n'), threadID, messageID);
  }

  // ── إضافة_id [اسم] [id] ────────────────────────────────────────────────────
  if (sub === 'إضافة_id' || sub === 'add_id') {
    const name = rest[0]?.trim();
    let   newId = rest[1]?.trim();

    // also accept reply
    if (!newId && event?.messageReply?.senderID)
      newId = String(event.messageReply.senderID);

    if (!name || !newId)
      return api.sendMessage('⚠️ الاستخدام: .شخصية إضافة_id [اسم] [ID]\nأو رد على رسالة الشخص بدل الـ ID', threadID, messageID);

    if (!/^\d{5,}$/.test(newId))
      return api.sendMessage('❌ الـ ID غير صالح — يجب أن يكون رقماً.', threadID, messageID);

    const data = readUsers();
    const u    = findUser(data.users, name);
    if (!u) return api.sendMessage(`❌ لم أجد شخصية باسم "${name}"\nاستخدم .شخصية عرض لرؤية الأسماء الموجودة`, threadID, messageID);

    if (!Array.isArray(u.ids)) u.ids = [];
    if (u.ids.includes(newId))
      return api.sendMessage(`⚠️ الـ ID ${newId} مضاف مسبقاً لـ ${u.name}`, threadID, messageID);

    u.ids.push(newId);
    saveUsers(data);

    return api.sendMessage(
      `✅ تمت الإضافة!\n${u.name} ← ${newId}\n📋 كل IDs: ${u.ids.filter(Boolean).join(', ')}`,
      threadID, messageID
    );
  }

  // ── حذف_id [اسم] [id] ──────────────────────────────────────────────────────
  if (sub === 'حذف_id' || sub === 'remove_id') {
    const name  = rest[0]?.trim();
    const delId = rest[1]?.trim();

    if (!name || !delId)
      return api.sendMessage('⚠️ الاستخدام: .شخصية حذف_id [اسم] [ID]', threadID, messageID);

    const data = readUsers();
    const u    = findUser(data.users, name);
    if (!u) return api.sendMessage(`❌ لم أجد شخصية باسم "${name}"`, threadID, messageID);

    const before = (u.ids || []).length;
    u.ids = (u.ids || []).filter(id => id !== delId);
    if (u.ids.length === before)
      return api.sendMessage(`⚠️ الـ ID ${delId} غير موجود في قائمة ${u.name}`, threadID, messageID);

    saveUsers(data);
    return api.sendMessage(
      `✅ تم حذف ${delId} من ${u.name}\n📋 IDs المتبقية: ${u.ids.filter(Boolean).join(', ') || 'لا يوجد'}`,
      threadID, messageID
    );
  }

  // ── جديد [اسم] | [دور] | [وصف] ────────────────────────────────────────────
  if (sub === 'جديد' || sub === 'new') {
    // format: .شخصية جديد اسم | دور اختياري | وصف الشخصية
    const full = rest.join(' ');
    const parts = full.split('|').map(s => s.trim());
    const name      = parts[0] || '';
    const role      = parts[1] || '';
    const character = parts[2] || '';

    if (!name)
      return api.sendMessage(
        '⚠️ الاستخدام:\n.شخصية جديد [اسم] | [الدور] | [وصف الشخصية]\n\nمثال:\n.شخصية جديد علي | مطور | شخص هادئ وذكي يحب البرمجة',
        threadID, messageID
      );

    const data = readUsers();
    if (findUser(data.users, name))
      return api.sendMessage(`⚠️ شخصية باسم "${name}" موجودة بالفعل.\nاستخدم .شخصية إضافة_id لإضافة ID لها.`, threadID, messageID);

    data.users.push({ name, ids: [], role, character });
    saveUsers(data);

    return api.sendMessage(
      `✅ تمت إضافة شخصية جديدة:\n👤 ${name}${role ? '\n🎖️ ' + role : ''}${character ? '\n📝 ' + character : ''}\n\nلإضافة ID:\n.شخصية إضافة_id ${name} [ID الفيسبوك]`,
      threadID, messageID
    );
  }

  // ── حذف [اسم] — admin only ──────────────────────────────────────────────────
  if (sub === 'حذف' || sub === 'delete') {
    if (permssion < 2)
      return api.sendMessage('⛔ حذف الشخصيات خاص بأدمن البوت فقط.', threadID, messageID);

    const name = rest.join(' ').trim();
    if (!name)
      return api.sendMessage('⚠️ الاستخدام: .شخصية حذف [اسم]', threadID, messageID);

    const data = readUsers();
    const idx  = data.users.findIndex(u =>
      u.name === name || u.name?.toLowerCase() === name.toLowerCase()
    );

    if (idx === -1)
      return api.sendMessage(`❌ لم أجد شخصية باسم "${name}"`, threadID, messageID);

    const removed = data.users.splice(idx, 1)[0];
    saveUsers(data);

    return api.sendMessage(
      `🗑️ تم حذف شخصية "${removed.name}" بالكامل.`,
      threadID, messageID
    );
  }

  // ── help ────────────────────────────────────────────────────────────────────
  return api.sendMessage(
    `👤 إدارة الشخصيات — الأوامر:\n\n` +
    `.شخصية عرض — عرض الكل\n` +
    `.شخصية معلومات [اسم] — تفاصيل شخصية\n` +
    `.شخصية إضافة_id [اسم] [ID] — إضافة ID فيسبوك\n` +
    `.شخصية حذف_id [اسم] [ID] — حذف ID\n` +
    `.شخصية جديد [اسم] | [دور] | [وصف] — شخصية جديدة\n` +
    `.شخصية حذف [اسم] — حذف شخصية (أدمن فقط)`,
    threadID, messageID
  );
};
