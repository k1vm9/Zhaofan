'use strict';
/**
 * gcadmin.js — ZAO Bot Command
 * ==============================
 * Promote or demote group chat admins via MQTT.
 *
 * Usage:
 *   .مشرف [@tag / uid / reply]         → promote user to admin
 *   .مشرف إلغاء [@tag / uid / reply]   → demote user from admin
 *   .gcadmin add [uid]
 *   .gcadmin remove [uid]
 */

module.exports.config = {
  name:            'مشرف',
  aliases:         ['gcadmin', 'admin-gc', 'مشرف-غروب'],
  version:         '1.0.0',
  hasPermssion:    1,
  credits:         'ZAO Team',
  description:     'ترقية أو إزالة مشرف في المجموعة',
  commandCategory: 'إدارة المجموعة',
  usages:          'مشرف [@tag/uid/reply] أو مشرف إلغاء [@tag/uid/reply]',
  cooldowns:       5,
};

function extractTargets(event, args) {
  const ids = new Set();
  try {
    if (event?.messageReply?.senderID) ids.add(String(event.messageReply.senderID));
  } catch (_) {}
  try {
    if (event?.mentions && typeof event.mentions === 'object') {
      for (const k of Object.keys(event.mentions)) ids.add(String(k));
    }
  } catch (_) {}
  for (const a of args) {
    if (a && /^\d{5,}$/.test(a)) ids.add(String(a));
  }
  return Array.from(ids);
}

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID } = event;

  if (permssion < 1) {
    return api.sendMessage('⛔ هذا الأمر خاص بأدمن البوت.', threadID, messageID);
  }

  if (!api.gcrule) {
    return api.sendMessage('❌ واجهة إدارة المشرفين غير متاحة حالياً.', threadID, messageID);
  }

  const sub = (args[0] || '').toLowerCase();
  const isRemove = sub === 'إلغاء' || sub === 'remove' || sub === 'off' || sub === 'unadmin';
  const action = isRemove ? 'unadmin' : 'admin';
  const skipArg = (sub === 'إلغاء' || sub === 'remove' || sub === 'off' || sub === 'unadmin' || sub === 'add') ? 1 : 0;

  const targets = extractTargets(event, args.slice(skipArg));

  if (!targets.length) {
    return api.sendMessage(
      '📌 الاستخدام:\n' +
      '.مشرف @tag / uid / رد → ترقية إلى مشرف\n' +
      '.مشرف إلغاء @tag / uid / رد → إزالة من المشرفين',
      threadID, messageID
    );
  }

  const results = { ok: [], fail: [] };

  for (const uid of targets) {
    try {
      await api.gcrule(action, uid, String(threadID));
      results.ok.push(uid);
    } catch (e) {
      results.fail.push({ uid, reason: (e.message || String(e)).slice(0, 100) });
    }
  }

  let msg = '';
  const verb = action === 'admin' ? 'ترقية' : 'إزالة';
  if (results.ok.length)   msg += `✅ تمت ${verb} (${results.ok.length}):\n` + results.ok.join('\n') + '\n\n';
  if (results.fail.length) msg += `❌ فشلت (${results.fail.length}):\n` + results.fail.map(f => `${f.uid}: ${f.reason}`).join('\n');

  return api.sendMessage(msg.trim() || '⚠️ لم يتم أي تغيير.', threadID, messageID);
};
