"use strict";

const NickLocks = require("../../includes/nicknameLocks");

const CHUNK          = 50;
const CLEAR_DELAY_MS = 400;

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function _live(api)  { return global._botApi || api; }

function _botId(api) {
  try { return String(global.botUserID || (api.getCurrentUserID ? api.getCurrentUserID() : "")); }
  catch (_) { return ""; }
}

function buildNick(template, name, index, id) {
  if (!template.includes("{")) return template;
  return template
    .replace(/\{name\}/g,  name)
    .replace(/\{index\}/g, String(index))
    .replace(/\{id\}/g,    String(id));
}

function getThreadInfoP(botApi, threadID) {
  return new Promise((res, rej) => {
    try {
      const r = botApi.getThreadInfo(threadID, (err, d) => err ? rej(err) : res(d));
      if (r && r.then) r.then(res).catch(rej);
    } catch (e) { rej(e); }
  });
}

async function getParticipants(botApi, threadID) {
  const info      = await getThreadInfoP(botApi, threadID);
  const fromIDs   = Array.isArray(info?.participantIDs) ? info.participantIDs : [];
  const fromUsers = Array.isArray(info?.userInfo)
    ? info.userInfo.map(u => u?.id).filter(Boolean) : [];
  const fromNicks = info?.nicknames ? Object.keys(info.nicknames) : [];
  return [...new Set([...fromIDs, ...fromUsers, ...fromNicks].map(String))];
}

async function getUserNames(botApi, ids) {
  const names = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      const result = await new Promise((res, rej) => {
        const r = botApi.getUserInfo(ids.slice(i, i + CHUNK), (err, d) => err ? rej(err) : res(d));
        if (r && r.then) r.then(res).catch(rej);
      });
      for (const [uid, u] of Object.entries(result || {})) {
        names[uid] = u.name || u.firstName || uid;
      }
    } catch (_) {}
  }
  return names;
}

// ─── Config ───────────────────────────────────────────────────────────────────

module.exports.config = {
  name:            "كنيات",
  aliases:         ["nickall", "na", "allnick"],
  version:         "5.0.0",
  hasPermssion:    2,
  credits:         "ZAO + Madox",
  description:     "قفل كنيات المجموعة مع تطبيق تلقائي كل 90 ثانية",
  commandCategory: "نظام",
  usages:          "تشغيل [الكنية] | بوت [الكنية] | ايقاف | تنظيف | حالة | قائمة",
  cooldowns:       3
};

module.exports.languages = { vi: {}, en: {} };

// ─── onLoad — wire the enforce timer to the live API ─────────────────────────

module.exports.onLoad = function ({ api }) {
  NickLocks.setApi(_live(api));
};

// ─── handleEvent — track joins/leaves ────────────────────────────────────────

module.exports.handleEvent = async function ({ api, event }) {
  try {
    const { threadID, logMessageType, logMessageData } = event;
    if (!threadID) return;

    // New member joined — add to lock immediately
    if (logMessageType === "log:subscribe") {
      const lock = NickLocks.getLock(threadID);
      if (!lock || lock.scope !== "all") return;
      const added = Array.isArray(logMessageData?.addedParticipants)
        ? logMessageData.addedParticipants : [];
      for (const p of added) {
        const uid = String(p?.userFbId || p?.userID || p?.id || "");
        if (!uid) continue;
        const name = p?.name || uid;
        const nick = buildNick(lock.nickname, name, lock.memberCount + 1, uid);
        NickLocks.updateMember(threadID, uid, nick);
        try {
          const botApi = _live(api);
          if (typeof botApi.changeNickname === "function") {
            await botApi.changeNickname(nick, threadID, uid);
          }
        } catch (_) {}
      }
      return;
    }

    // Member left — remove from lock
    if (logMessageType === "log:unsubscribe") {
      const gone = String(
        logMessageData?.leftParticipantFbId ||
        logMessageData?.participant_id || ""
      );
      if (gone) NickLocks.removeMember(threadID, gone);
    }
  } catch (_) {}
};

// ─── run ──────────────────────────────────────────────────────────────────────

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const tid    = String(threadID);
  const botApi = _live(api);
  const action = (args[0] || "").trim();

  const helpMsg =
    "📌 أوامر كنيات:\n" +
    "━━━━━━━━━━━━━━━━━━━━━\n" +
    "• كنيات تشغيل [الكنية]\n" +
    "  قفل كنيات الجميع\n" +
    "  متغيرات: {name} الاسم  {index} الرقم  {id} المعرف\n" +
    "• كنيات بوت [الكنية]\n" +
    "  قفل كنية البوت فقط\n" +
    "• كنيات ايقاف — رفع القفل\n" +
    "• كنيات تنظيف — مسح كنيات الجميع\n" +
    "• كنيات حالة — عرض الحالة الحالية\n" +
    "• كنيات قائمة — المجموعات المقفولة\n" +
    "━━━━━━━━━━━━━━━━━━━━━\n" +
    "⏱ يُطبَّق تلقائياً كل 90 ثانية";

  if (!action) return api.sendMessage(helpMsg, threadID, messageID);

  // ── كنيات تشغيل ──────────────────────────────────────────────────────────────
  if (action === "تشغيل") {
    const template = args.slice(1).join(" ").trim();
    if (!template)
      return api.sendMessage(
        "⚠️ أدخل الكنية.\nمثال: كنيات تشغيل ZAO\nمثال مع الاسم: كنيات تشغيل ZAO | {name}",
        threadID, messageID
      );

    api.sendMessage("⏳ جاري جلب أعضاء المجموعة وأسمائهم…", threadID, messageID);

    let ids;
    try { ids = await getParticipants(botApi, threadID); }
    catch (e) { return api.sendMessage(`❌ فشل جلب الأعضاء: ${e.message}`, threadID, messageID); }

    if (!ids.length)
      return api.sendMessage("❌ لا يوجد أعضاء في المجموعة.", threadID, messageID);

    // Batch-fetch real names to build accurate per-member nicknames
    const names = await getUserNames(botApi, ids);

    const membersMap = new Map();
    for (let i = 0; i < ids.length; i++) {
      const uid = ids[i];
      membersMap.set(uid, buildNick(template, names[uid] || uid, i + 1, uid));
    }

    NickLocks.setMembers(tid, membersMap, { scope: "all", template });

    return api.sendMessage(
      `🔒 تم قفل كنيات ${membersMap.size} عضو\n` +
      `📝 القالب: "${template}"\n\n` +
      `⏱ يُطبَّق تلقائياً كل 90 ثانية\n` +
      `⚡ الأعضاء الجدد يضافون فوراً عند الانضمام`,
      threadID, messageID
    );
  }

  // ── كنيات بوت ────────────────────────────────────────────────────────────────
  if (action === "بوت") {
    const nickname = args.slice(1).join(" ").trim();
    if (!nickname)
      return api.sendMessage("⚠️ أدخل الكنية.\nمثال: كنيات بوت ZAO", threadID, messageID);

    const botId = _botId(botApi);
    if (!botId)
      return api.sendMessage("❌ لم يتمكن البوت من تحديد معرفه.", threadID, messageID);

    NickLocks.setLock(tid, nickname, "bot");
    try { await botApi.changeNickname(nickname, tid, botId); } catch (_) {}

    return api.sendMessage(
      `🔒 تم قفل كنية البوت على:\n"${nickname}"\n\n⏱ يُطبَّق تلقائياً كل 90 ثانية`,
      threadID, messageID
    );
  }

  // ── كنيات ايقاف ──────────────────────────────────────────────────────────────
  if (action === "ايقاف") {
    const had = NickLocks.clearLock(tid);
    return api.sendMessage(
      had ? "🔓 تم إيقاف قفل الكنيات." : "⚠️ لا يوجد قفل مفعل في هذه المجموعة.",
      threadID, messageID
    );
  }

  // ── كنيات تنظيف ──────────────────────────────────────────────────────────────
  if (action === "تنظيف") {
    let ids;
    try { ids = await getParticipants(botApi, threadID); }
    catch (e) { return api.sendMessage(`❌ فشل جلب الأعضاء: ${e.message}`, threadID, messageID); }

    if (!ids.length)
      return api.sendMessage("❌ لا يوجد أعضاء في المجموعة.", threadID, messageID);

    await api.sendMessage(
      `🧹 جاري مسح كنيات ${ids.length} عضو...\n⏳ هذا قد يأخذ بعض الوقت.`,
      threadID, messageID
    );

    let done = 0, failed = 0;
    for (const uid of ids) {
      try { await botApi.changeNickname("", tid, uid); done++; } catch (_) { failed++; }
      await _delay(CLEAR_DELAY_MS);
    }

    return api.sendMessage(
      `✅ تم تنظيف الكنيات!\n✔️ تم مسح: ${done}\n❌ فشل: ${failed}`,
      threadID, messageID
    );
  }

  // ── كنيات حالة ───────────────────────────────────────────────────────────────
  if (action === "حالة") {
    const lock = NickLocks.getLock(tid);
    if (!lock)
      return api.sendMessage("📋 لا يوجد قفل مفعل في هذه المجموعة.", threadID, messageID);
    return api.sendMessage(
      `🔒 كنيات — حالة:\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📝 القالب: "${lock.nickname}"\n` +
      `👥 النطاق: ${lock.scope === "bot" ? "البوت فقط" : "الجميع"}\n` +
      `🔢 الأعضاء المقفولون: ${lock.memberCount}\n` +
      `⏱ التطبيق التلقائي: كل 90 ثانية`,
      threadID, messageID
    );
  }

  // ── كنيات قائمة ──────────────────────────────────────────────────────────────
  if (action === "قائمة") {
    const locks = NickLocks.getLocks();
    if (locks.size === 0)
      return api.sendMessage("📋 لا توجد مجموعات مقفولة حالياً.", threadID, messageID);
    let list = "🔒 المجموعات المقفولة:\n━━━━━━━━━━━━━━━\n";
    let i = 1;
    for (const [t, members] of locks.entries()) {
      const lock = NickLocks.getLock(t);
      const scope = lock?.scope === "bot" ? "🤖 بوت فقط" : "👥 الجميع";
      list += `${i}. [${t}]\n   ${scope} — "${lock?.nickname || ""}" (${members.size} عضو)\n`;
      i++;
    }
    return api.sendMessage(list.trim(), threadID, messageID);
  }

  return api.sendMessage(helpMsg, threadID, messageID);
};
