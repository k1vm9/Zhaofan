'use strict';
/**
 * friends.js — ZAO Bot Command v2
 * ================================
 * إدارة شاملة للأصدقاء على فيسبوك مباشرة من المحادثة.
 *
 * الأوامر:
 *   .أصدقاء قائمة [رقم الصفحة]   → قائمة الأصدقاء (30 لكل صفحة)
 *   .أصدقاء طلبات                 → طلبات الصداقة المعلّقة
 *   .أصدقاء قبول [uid/اسم]        → قبول طلب صداقة
 *   .أصدقاء قبول الكل             → قبول جميع الطلبات المعلّقة تلقائياً
 *   .أصدقاء رفض [uid/اسم]         → رفض طلب صداقة
 *   .أصدقاء رفض الكل              → رفض وإزالة جميع الطلبات المعلّقة
 *   .أصدقاء أرسل [uid]            → إرسال طلب صداقة
 *   .أصدقاء احذف [uid]            → إزالة صديق
 *   .أصدقاء حظر [uid]             → حظر مراسلة مستخدم
 *   .أصدقاء رفع [uid]             → رفع الحظر عن مستخدم
 *   .أصدقاء مشترك [uid]           → عرض الأصدقاء المشتركين
 *   .أصدقاء بحث [اسم]             → البحث عن مستخدمين
 *   .أصدقاء اقتراحات              → أشخاص قد تعرفهم
 */

module.exports.config = {
  name:            'أصدقاء',
  aliases:         ['friends', 'friend', 'فريندز', 'صديق'],
  version:         '2.1.0',
  hasPermssion:    2,
  credits:         'ZAO Team',
  description:     'إدارة كاملة للأصدقاء: قائمة مع ترقيم، طلبات، قبول/رفض الكل، إزالة، حظر، مشترك، بحث',
  commandCategory: 'إدارة البوت',
  usages:          'أصدقاء [قائمة|طلبات|قبول|رفض|أرسل|احذف|حظر|رفع|مشترك|بحث|اقتراحات] [uid/اسم/رقم_صفحة]',
  cooldowns:       8,
};

const PAGE_SIZE = 30;

const HELP = `👥 أوامر إدارة الأصدقاء:

.أصدقاء قائمة [صفحة] — قائمة أصدقائي (30 لكل صفحة)
.أصدقاء طلبات — طلبات الصداقة المعلّقة
.أصدقاء قبول [uid/اسم] — قبول طلب صداقة محدد
.أصدقاء قبول الكل — قبول جميع الطلبات تلقائياً
.أصدقاء رفض [uid/اسم] — رفض طلب صداقة محدد
.أصدقاء رفض الكل — رفض وإزالة جميع الطلبات
.أصدقاء أرسل [uid] — إرسال طلب صداقة
.أصدقاء احذف [uid] — إزالة صديق
.أصدقاء حظر [uid] — حظر مراسلة مستخدم
.أصدقاء رفع [uid] — رفع الحظر عن مستخدم
.أصدقاء مشترك [uid] — الأصدقاء المشتركين
.أصدقاء بحث [اسم] — البحث عن مستخدمين
.أصدقاء اقتراحات — أشخاص قد تعرفهم`;

module.exports.run = async function ({ api, event, args, permssion }) {
  const { threadID, messageID } = event;

  if (permssion < 2) {
    return api.sendMessage('⛔ هذا الأمر خاص بأدمن البوت فقط.', threadID, messageID);
  }

  if (!api.friend) {
    return api.sendMessage('❌ واجهة إدارة الأصدقاء غير متاحة حالياً.', threadID, messageID);
  }

  const sub = (args[0] || '').trim();
  if (!sub) return api.sendMessage(HELP, threadID, messageID);

  api.setMessageReaction('⏳', messageID, () => {}, true);

  try {

    // ── قائمة (مع ترقيم الصفحات) ────────────────────────────────────────────
    if (sub === 'قائمة' || sub === 'list') {
      const friends = await api.friend.list();
      if (!friends.length) {
        api.setMessageReaction('📭', messageID, () => {}, true);
        return api.sendMessage('📭 قائمة الأصدقاء فارغة.', threadID, messageID);
      }

      const totalPages = Math.ceil(friends.length / PAGE_SIZE);
      const page = Math.max(1, Math.min(parseInt(args[1]) || 1, totalPages));
      const start = (page - 1) * PAGE_SIZE;
      const slice = friends.slice(start, start + PAGE_SIZE);

      const lines = slice.map((f, i) => `${start + i + 1}. ${f.name || '—'} (${f.userID})`);
      const header = `👥 قائمة الأصدقاء — صفحة ${page}/${totalPages} (المجموع: ${friends.length})\n`;
      const footer = totalPages > 1
        ? `\n📄 اكتب .أصدقاء قائمة ${page < totalPages ? page + 1 : 1} للصفحة التالية`
        : '';

      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(header + '\n' + lines.join('\n') + footer, threadID, messageID);
    }

    // ── طلبات ───────────────────────────────────────────────────────────────
    if (sub === 'طلبات' || sub === 'requests') {
      const reqs = await api.friend.requests();
      if (!reqs.length) {
        api.setMessageReaction('📭', messageID, () => {}, true);
        return api.sendMessage('📭 لا توجد طلبات صداقة معلّقة.', threadID, messageID);
      }
      const lines = reqs.slice(0, 20).map((r, i) => `${i + 1}. ${r.name || '—'} (${r.userID})`);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`📩 طلبات الصداقة المعلّقة (${reqs.length}):\n\n` + lines.join('\n'), threadID, messageID);
    }

    // ── قبول الكل (auto-accept all pending) ─────────────────────────────────
    if ((sub === 'قبول' || sub === 'accept') && (args[1] === 'الكل' || args[1] === 'all')) {
      const reqs = await api.friend.requests();
      if (!reqs.length) {
        api.setMessageReaction('📭', messageID, () => {}, true);
        return api.sendMessage('📭 لا توجد طلبات صداقة معلّقة لقبولها.', threadID, messageID);
      }
      api.sendMessage(`⏳ جارٍ قبول ${reqs.length} طلب صداقة... قد يستغرق ذلك لحظات.`, threadID, messageID);
      let ok = 0, fail = 0;
      for (const req of reqs) {
        try {
          await api.friend.accept(req.userID);
          ok++;
          await new Promise(r => setTimeout(r, 800));
        } catch (_) { fail++; }
      }
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(
        `✅ اكتمل قبول الطلبات:\n✔️ تم القبول: ${ok}\n❌ فشل: ${fail}\nالمجموع: ${reqs.length}`,
        threadID, messageID
      );
    }

    // ── قبول (طلب محدد) ─────────────────────────────────────────────────────
    if (sub === 'قبول' || sub === 'accept') {
      const target = args[1];
      if (!target) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage(
          '⚠️ أدخل uid أو اسم الشخص، أو اكتب "الكل" لقبول جميع الطلبات.\nمثال: .أصدقاء قبول 123456789\nأو: .أصدقاء قبول الكل',
          threadID, messageID
        );
      }
      await api.friend.accept(target);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`✅ تم قبول طلب الصداقة من: ${target}`, threadID, messageID);
    }

    // ── رفض الكل (remove all pending requests) ──────────────────────────────
    if ((sub === 'رفض' || sub === 'reject') && (args[1] === 'الكل' || args[1] === 'all')) {
      const reqs = await api.friend.requests();
      if (!reqs.length) {
        api.setMessageReaction('📭', messageID, () => {}, true);
        return api.sendMessage('📭 لا توجد طلبات صداقة معلّقة لرفضها.', threadID, messageID);
      }
      api.sendMessage(`⏳ جارٍ رفض ${reqs.length} طلب صداقة... قد يستغرق ذلك لحظات.`, threadID, messageID);
      let ok = 0, fail = 0;
      for (const req of reqs) {
        try {
          await api.friend.reject(req.userID);
          ok++;
          await new Promise(r => setTimeout(r, 800));
        } catch (_) { fail++; }
      }
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(
        `🚫 اكتمل رفض الطلبات:\n✔️ تم الرفض: ${ok}\n❌ فشل: ${fail}\nالمجموع: ${reqs.length}`,
        threadID, messageID
      );
    }

    // ── رفض (طلب محدد) ──────────────────────────────────────────────────────
    if (sub === 'رفض' || sub === 'reject') {
      const target = args[1];
      if (!target) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage(
          '⚠️ أدخل uid أو اسم الشخص، أو اكتب "الكل" لرفض جميع الطلبات.\nمثال: .أصدقاء رفض 123456789\nأو: .أصدقاء رفض الكل',
          threadID, messageID
        );
      }
      await api.friend.reject(target);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`🚫 تم رفض طلب الصداقة من: ${target}`, threadID, messageID);
    }

    // ── إرسال ───────────────────────────────────────────────────────────────
    if (sub === 'أرسل' || sub === 'send') {
      const uid = args[1];
      if (!uid || !/^\d+$/.test(uid)) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage('⚠️ أدخل uid صحيح.\nمثال: .أصدقاء أرسل 123456789', threadID, messageID);
      }
      await api.friend.suggest.send(uid);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`✅ تم إرسال طلب الصداقة إلى: ${uid}`, threadID, messageID);
    }

    // ── احذف / إزالة صديق ──────────────────────────────────────────────────
    if (sub === 'احذف' || sub === 'remove' || sub === 'delete') {
      const uid = args[1];
      if (!uid || !/^\d+$/.test(uid)) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage('⚠️ أدخل uid صحيح.\nمثال: .أصدقاء احذف 123456789', threadID, messageID);
      }
      await api.friend.unfriend(uid);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`✅ تمت إزالة الصديق: ${uid}`, threadID, messageID);
    }

    // ── حظر ─────────────────────────────────────────────────────────────────
    if (sub === 'حظر' || sub === 'block') {
      const uid = args[1];
      if (!uid || !/^\d+$/.test(uid)) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage('⚠️ أدخل uid صحيح.\nمثال: .أصدقاء حظر 123456789', threadID, messageID);
      }
      await api.friend.block(uid);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`🔒 تم حظر مراسلة المستخدم: ${uid}`, threadID, messageID);
    }

    // ── رفع الحظر ───────────────────────────────────────────────────────────
    if (sub === 'رفع' || sub === 'unblock') {
      const uid = args[1];
      if (!uid || !/^\d+$/.test(uid)) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage('⚠️ أدخل uid صحيح.\nمثال: .أصدقاء رفع 123456789', threadID, messageID);
      }
      await api.friend.unblock(uid);
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`🔓 تم رفع الحظر عن المستخدم: ${uid}`, threadID, messageID);
    }

    // ── مشترك ───────────────────────────────────────────────────────────────
    if (sub === 'مشترك' || sub === 'mutual') {
      const uid = args[1];
      if (!uid || !/^\d+$/.test(uid)) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage('⚠️ أدخل uid صحيح.\nمثال: .أصدقاء مشترك 123456789', threadID, messageID);
      }
      const result = await api.friend.mutual(uid);
      api.setMessageReaction('✅', messageID, () => {}, true);
      if (!result.count) {
        return api.sendMessage(`🤝 لا يوجد أصدقاء مشتركين مع ${uid}.`, threadID, messageID);
      }
      const lines = result.friends.slice(0, 15).map((f, i) => `${i + 1}. ${f.name || '—'} (${f.userID})`);
      return api.sendMessage(`🤝 الأصدقاء المشتركين مع ${uid} (${result.count}):\n\n` + lines.join('\n'), threadID, messageID);
    }

    // ── بحث ─────────────────────────────────────────────────────────────────
    if (sub === 'بحث' || sub === 'search') {
      const query = args.slice(1).join(' ');
      if (!query) {
        api.setMessageReaction('❌', messageID, () => {}, true);
        return api.sendMessage('⚠️ أدخل اسماً للبحث.\nمثال: .أصدقاء بحث أحمد', threadID, messageID);
      }
      const results = await api.friend.search(query, 10);
      api.setMessageReaction('✅', messageID, () => {}, true);
      if (!results.length) {
        return api.sendMessage(`🔎 لم يُعثر على نتائج لـ "${query}".`, threadID, messageID);
      }
      const lines = results.map((u, i) => `${i + 1}. ${u.name || '—'} (${u.userID})${u.socialContext ? '\n   ↳ ' + u.socialContext : ''}`);
      return api.sendMessage(`🔎 نتائج البحث عن "${query}" (${results.length}):\n\n` + lines.join('\n'), threadID, messageID);
    }

    // ── اقتراحات ────────────────────────────────────────────────────────────
    if (sub === 'اقتراحات' || sub === 'suggest' || sub === 'suggestions') {
      const list = await api.friend.suggest.list(20);
      if (!list.length) {
        api.setMessageReaction('📭', messageID, () => {}, true);
        return api.sendMessage('📭 لا توجد اقتراحات حالياً.', threadID, messageID);
      }
      const lines = list.slice(0, 15).map((p, i) =>
        `${i + 1}. ${p.name || '—'} (${p.userID})${p.socialContext ? '\n   ↳ ' + p.socialContext : ''}`
      );
      api.setMessageReaction('✅', messageID, () => {}, true);
      return api.sendMessage(`💡 أشخاص قد تعرفهم (${list.length}):\n\n` + lines.join('\n'), threadID, messageID);
    }

    // ── أمر غير معروف ───────────────────────────────────────────────────────
    api.setMessageReaction('❓', messageID, () => {}, true);
    return api.sendMessage(HELP, threadID, messageID);

  } catch (e) {
    api.setMessageReaction('❌', messageID, () => {}, true);
    return api.sendMessage('❌ خطأ: ' + String(e.message || e).slice(0, 200), threadID, messageID);
  }
};
