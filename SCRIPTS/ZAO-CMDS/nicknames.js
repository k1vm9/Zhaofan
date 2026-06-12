"use strict";

/**
 * nicknames.js — v6
 *
 * Nickname lock command with user-level lock support.
 *
 * Priority (highest to lowest):
 *   User Lock  > Group Lock > Normal nickname behavior
 *
 * Subcommands:
 *   كنيات تشغيل [قالب]   — lock everyone in the group
 *   كنيات بوت [كنية]     — lock the bot's own nickname
 *   كنيات ايقاف          — remove ALL locks for this group
 *   كنيات تنظيف          — clear everyone's nickname
 *   كنيات حالة           — show current lock status
 *   كنيات قائمة          — list all locked groups
 *   كنيات قفل [كنية]     — (reply) lock ONE user's nickname individually
 *   كنيات فك             — (reply) remove ONE user's individual lock
 *   كنيات مقفولون        — list individually locked members in this group
 */

const NickLocks = require("../../ZAO-ENGINE/nicknameLocks");

const CHUNK              = 50;
const CLEAR_DELAY_MS     = 400; // legacy — not used for تنظيف anymore
const CLEAR_CALL_MIN_MS  = 3000;  // minimum delay between individual clear calls
const CLEAR_CALL_MAX_MS  = 6500;  // maximum delay between individual clear calls
const CLEAR_CHUNK_SIZE   = 5;     // members per batch before taking a longer rest
const CLEAR_REST_MIN_MS  = 35000; // rest between chunks (min)
const CLEAR_REST_MAX_MS  = 65000; // rest between chunks (max)

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
  version:         "6.0.0",
  hasPermssion:    2,
  credits:         "ZAO + Madox",
  description:     "قفل كنيات المجموعة — يدعم قفل فردي بأولوية أعلى من قفل المجموعة",
  commandCategory: "نظام",
  usages:          "تشغيل [القالب] | بوت [الكنية] | ايقاف | تنظيف | حالة | قائمة | قفل [كنية] (رد) | فك (رد) | مقفولون",
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

    // New member joined — add to group lock if active (skip if user has individual lock)
    if (logMessageType === "log:subscribe") {
      const lock = NickLocks.getLock(threadID);
      if (!lock || lock.scope !== "all") return;
      const added = Array.isArray(logMessageData?.addedParticipants)
        ? logMessageData.addedParticipants : [];
      for (const p of added) {
        const uid = String(p?.userFbId || p?.userID || p?.id || "");
        if (!uid) continue;
        // Skip: user already has an individual lock
        if (NickLocks.isUserLocked(threadID, uid)) continue;
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

    // Member left — remove from all locks (individual + group)
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
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "• كنيات تشغيل [القالب]\n" +
    "  قفل كنيات الجميع في المجموعة\n" +
    "  متغيرات: {name} الاسم  {index} الرقم  {id} المعرف\n\n" +
    "• كنيات بوت [الكنية]\n" +
    "  قفل كنية البوت فقط\n\n" +
    "• كنيات قفل [الكنية]  (رد على رسالة شخص)\n" +
    "  قفل كنية هذا الشخص فقط — أولوية أعلى من قفل المجموعة\n\n" +
    "• كنيات فك  (رد على رسالة شخص)\n" +
    "  رفع القفل الفردي عن هذا الشخص\n\n" +
    "• كنيات مقفولون — قائمة الأشخاص المقفولين فردياً\n\n" +
    "• كنيات ايقاف — رفع جميع الأقفال\n" +
    "• كنيات تنظيف — مسح كنيات الجميع\n" +
    "• كنيات حالة — الحالة الحالية\n" +
    "• كنيات قائمة — المجموعات المقفولة\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "⏱ يُطبَّق تلقائياً كل 60 ثانية\n" +
    "🔒 القفل الفردي له أولوية أعلى من قفل المجموعة";

  if (!action) return api.sendMessage(helpMsg, threadID, messageID);

  // ── كنيات تشغيل — group-wide lock ────────────────────────────────────────────
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

    const names = await getUserNames(botApi, ids);

    const membersMap = new Map();
    for (let i = 0; i < ids.length; i++) {
      const uid = ids[i];
      // PRIORITY: preserve existing individual lock nicknames — don't overwrite
      if (NickLocks.isUserLocked(tid, uid)) {
        const existingNick = NickLocks.getLock(tid)?.members?.get(uid);
        if (existingNick) { membersMap.set(uid, existingNick); continue; }
      }
      membersMap.set(uid, buildNick(template, names[uid] || uid, i + 1, uid));
    }

    NickLocks.setMembers(tid, membersMap, { scope: "all", template });

    const userLockedCount = NickLocks.getUserLockedMembers(tid).length;
    return api.sendMessage(
      `🔒 تم قفل كنيات ${membersMap.size} عضو\n` +
      `📝 القالب: "${template}"\n` +
      (userLockedCount ? `🛡️ تم الحفاظ على ${userLockedCount} قفل فردي (أولوية أعلى)\n\n` : "\n") +
      `⏱ يُطبَّق تلقائياً كل 60 ثانية\n` +
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
      `🔒 تم قفل كنية البوت على:\n"${nickname}"\n\n⏱ يُطبَّق تلقائياً كل 60 ثانية`,
      threadID, messageID
    );
  }

  // ── كنيات قفل — individual user lock (reply to message) ──────────────────────
  if (action === "قفل") {
    const targetID = event.messageReply?.senderID
      ? String(event.messageReply.senderID)
      : null;

    if (!targetID)
      return api.sendMessage(
        "⚠️ ردّ على رسالة الشخص المراد قفل كنيته.\nمثال: كنيات قفل ZAO (مع الرد على رسالته)",
        threadID, messageID
      );

    const nickname = args.slice(1).join(" ").trim();
    if (!nickname)
      return api.sendMessage(
        "⚠️ أدخل الكنية المراد تثبيتها.\nمثال: كنيات قفل ZAO ✨",
        threadID, messageID
      );

    // Apply the lock
    NickLocks.lockUser(tid, targetID, nickname);

    // Apply immediately via API
    try { await botApi.changeNickname(nickname, tid, targetID); } catch (_) {}

    // Fetch user's display name for the confirmation message
    let userName = targetID;
    try {
      const info = await new Promise((res, rej) => {
        const r = botApi.getUserInfo([targetID], (err, d) => err ? rej(err) : res(d));
        if (r && r.then) r.then(res).catch(rej);
      });
      userName = info?.[targetID]?.name || targetID;
    } catch (_) {}

    return api.sendMessage(
      `🔒 تم قفل كنية ${userName} فردياً على:\n"${nickname}"\n\n` +
      `🛡️ هذا القفل أعلى أولوية من قفل المجموعة.\n` +
      `⏱ يُطبَّق تلقائياً كل 60 ثانية.`,
      threadID, messageID
    );
  }

  // ── كنيات فك — remove individual lock (reply to message) ─────────────────────
  if (action === "فك") {
    const targetID = event.messageReply?.senderID
      ? String(event.messageReply.senderID)
      : null;

    if (!targetID)
      return api.sendMessage(
        "⚠️ ردّ على رسالة الشخص المراد رفع قفله الفردي.",
        threadID, messageID
      );

    const wasLocked = NickLocks.isUserLocked(tid, targetID);
    NickLocks.unlockUser(tid, targetID);

    let userName = targetID;
    try {
      const info = await new Promise((res, rej) => {
        const r = botApi.getUserInfo([targetID], (err, d) => err ? rej(err) : res(d));
        if (r && r.then) r.then(res).catch(rej);
      });
      userName = info?.[targetID]?.name || targetID;
    } catch (_) {}

    return api.sendMessage(
      wasLocked
        ? `🔓 تم رفع القفل الفردي عن ${userName}.\nسيُطبَّق قفل المجموعة عليه في الدورة القادمة (إذا كان مفعلاً).`
        : `⚠️ ${userName} لا يملك قفلاً فردياً في هذه المجموعة.`,
      threadID, messageID
    );
  }

  // ── كنيات مقفولون — list individually locked members ─────────────────────────
  if (action === "مقفولون") {
    const lockedUIDs = NickLocks.getUserLockedMembers(tid);
    if (!lockedUIDs.length)
      return api.sendMessage("📋 لا يوجد أعضاء مقفولون فردياً في هذه المجموعة.", threadID, messageID);

    const lock = NickLocks.getLock(tid);
    let list = `🛡️ الأعضاء المقفولون فردياً في هذه المجموعة:\n━━━━━━━━━━━━━━━━━━━━\n`;
    let i = 1;
    for (const uid of lockedUIDs) {
      const nick = lock?.members?.get(uid) || "—";
      list += `${i}. [${uid}]\n   الكنية: "${nick}"\n`;
      i++;
    }
    list += `━━━━━━━━━━━━━━━━━━━━\n📊 المجموع: ${lockedUIDs.length}`;
    return api.sendMessage(list, threadID, messageID);
  }

  // ── كنيات ايقاف ──────────────────────────────────────────────────────────────
  if (action === "ايقاف") {
    const had = NickLocks.clearLock(tid);
    return api.sendMessage(
      had ? "🔓 تم إيقاف جميع أقفال الكنيات (الجماعية والفردية)." : "⚠️ لا يوجد قفل مفعل في هذه المجموعة.",
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

    // Estimate time: (members × avg_call_delay) + (chunks × avg_rest)
    const avgCall  = (CLEAR_CALL_MIN_MS + CLEAR_CALL_MAX_MS) / 2;
    const avgRest  = (CLEAR_REST_MIN_MS + CLEAR_REST_MAX_MS) / 2;
    const chunks   = Math.ceil(ids.length / CLEAR_CHUNK_SIZE);
    const estMins  = Math.ceil((ids.length * avgCall + chunks * avgRest) / 60000);

    await api.sendMessage(
      `🧹 جاري مسح كنيات ${ids.length} عضو...\n` +
      `⚡ دفعات من ${CLEAR_CHUNK_SIZE} أعضاء — مع راحة بين كل دفعة لحماية الحساب.\n` +
      `⏳ المدة التقريبية: ${estMins}–${estMins + 2} دقيقة.`,
      threadID, messageID
    );

    let done = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      const uid = ids[i];
      try {
        if (typeof botApi.changeNickname === "function")
          await botApi.changeNickname("", tid, uid);
        else if (typeof botApi.nickname === "function")
          await botApi.nickname("", tid, uid);
        done++;
      } catch (_) { failed++; }

      // Randomized delay between individual API calls (avoids detectable cadence)
      const callDelay = CLEAR_CALL_MIN_MS + Math.floor(Math.random() * (CLEAR_CALL_MAX_MS - CLEAR_CALL_MIN_MS));
      await _delay(callDelay);

      // After each chunk: send progress, then take a longer rest
      const isLastOfChunk = (i + 1) % CLEAR_CHUNK_SIZE === 0;
      const isLast        = i + 1 === ids.length;
      if (isLastOfChunk && !isLast) {
        const remaining = ids.length - (i + 1);
        try {
          await api.sendMessage(
            `⏳ تقدم: ${i + 1} / ${ids.length}\n` +
            `✔️ نجح: ${done} | ❌ فشل: ${failed} | 🔄 متبقي: ${remaining}\n` +
            `💤 راحة قصيرة لحماية الحساب...`,
            threadID
          );
        } catch (_) {}
        const restDelay = CLEAR_REST_MIN_MS + Math.floor(Math.random() * (CLEAR_REST_MAX_MS - CLEAR_REST_MIN_MS));
        await _delay(restDelay);
      }
    }

    // Clear locks after cleaning so enforce loop doesn't re-apply old nicknames
    NickLocks.clearLock(tid);

    return api.sendMessage(
      `✅ تم تنظيف الكنيات!\n✔️ نجح: ${done}\n❌ فشل: ${failed}\n🔓 تم مسح أقفال الكنيات أيضاً.`,
      threadID, messageID
    );
  }

  // ── كنيات حالة ───────────────────────────────────────────────────────────────
  if (action === "حالة") {
    const lock = NickLocks.getLock(tid);
    if (!lock)
      return api.sendMessage("📋 لا يوجد قفل مفعل في هذه المجموعة.", threadID, messageID);

    const userLockedCount = NickLocks.getUserLockedMembers(tid).length;
    return api.sendMessage(
      `🔒 كنيات — حالة:\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📝 القالب: "${lock.nickname}"\n` +
      `👥 النطاق: ${lock.scope === "bot" ? "البوت فقط" : lock.scope === "user" ? "فردي" : "الجميع"}\n` +
      `🔢 الأعضاء المقفولون (إجمالي): ${lock.memberCount}\n` +
      `🛡️ الأعضاء المقفولون فردياً: ${userLockedCount}\n` +
      `⏱ التطبيق التلقائي: كل 60 ثانية\n` +
      `📌 أولوية: القفل الفردي > قفل المجموعة`,
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
      const lock   = NickLocks.getLock(t);
      const scope  = lock?.scope === "bot"  ? "🤖 بوت فقط"
                   : lock?.scope === "user" ? "🛡️ فردي"
                   : "👥 الجميع";
      const ulCount = NickLocks.getUserLockedMembers(t).length;
      list += `${i}. [${t}]\n   ${scope} — "${lock?.nickname || ""}" (${members.size} عضو`;
      if (ulCount) list += ` | ${ulCount} مقفول فردياً`;
      list += ")\n";
      i++;
    }
    return api.sendMessage(list.trim(), threadID, messageID);
  }

  return api.sendMessage(helpMsg, threadID, messageID);
};
