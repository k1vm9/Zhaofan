"use strict";

module.exports.config = {
  name: "ضيفني",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "ZAO",
  description: "يعرض الغروبات اللي البوت فيها ويضيف المرسل لغروب محدد أو كل الغروبات",
  commandCategory: "إدارة البوت",
  usages: "ضيفني | ضيفني <رقم> | ضيفني <group id> | ضيفني all",
  cooldowns: 10
};

module.exports.languages = { vi: {}, en: {} };

// ── helpers ────────────────────────────────────────────────────────────────────

async function fetchGroups(api) {
  try {
    // [FIX] Use global._botApi if available to avoid stale handles after tier switch
    const liveApi = global._botApi || api;
    const list = await liveApi.getThreadList(100, null, ["INBOX"]);
    const threads = Array.isArray(list) ? list : (list?.data || []);
    return threads.filter(t => t.isGroup || t.isSubscribed === false || Number(t.threadID) > 1e14);
  } catch (_) {
    return [];
  }
}

function getGroupName(thread) {
  return thread.name || thread.threadName || thread.threadID;
}

function addUser(api, userID, threadID) {
  return new Promise((resolve) => {
    try {
      // [FIX] Use global._botApi if available to avoid stale handles after tier switch
      const liveApi = global._botApi || api;
      liveApi.addUserToGroup(String(userID), String(threadID), (err) => {
        resolve(err ? { ok: false, err: err.message || "خطأ" } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, err: e.message || "خطأ" });
    }
  });
}

// ── run ────────────────────────────────────────────────────────────────────────

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID, senderID } = event;
  const userID = String(senderID);
  const input  = args[0] ? String(args[0]).trim() : null;

  await api.sendMessage("⏳ جاري تحميل الغروبات...", threadID, messageID);

  const groups = await fetchGroups(api);

  if (!groups.length) {
    return api.sendMessage("❌ ما لقيت أي غروبات.", threadID, messageID);
  }

  // ── No argument: list groups ───────────────────────────────────────────────
  if (!input) {
    const lines = groups.map((g, i) =>
      `${i + 1}. ${getGroupName(g)}\n   🆔 ${g.threadID}`
    );
    const msg =
      `📋 الغروبات اللي البوت فيها (${groups.length}):\n\n` +
      lines.join("\n\n") +
      "\n\n─────────────────\n" +
      "لإضافتك:\n" +
      "• ضيفني <رقم>  ← غروب محدد بالرقم\n" +
      "• ضيفني <id>   ← غروب محدد بالـ ID\n" +
      "• ضيفني all    ← كل الغروبات";
    return api.sendMessage(msg, threadID, messageID);
  }

  // ── "all": add to every group ──────────────────────────────────────────────
  if (input.toLowerCase() === "all") {
    await api.sendMessage(
      `➕ جاري إضافتك لـ ${groups.length} غروب... انتظر قليلاً.`,
      threadID, messageID
    );

    let success = 0, failed = 0;
    for (const g of groups) {
      const res = await addUser(api, userID, g.threadID);
      if (res.ok) success++; else failed++;
      await new Promise(r => setTimeout(r, 600));
    }

    return api.sendMessage(
      `✅ تمت الإضافة!\n✔️ نجح: ${success}\n❌ فشل: ${failed}`,
      threadID, messageID
    );
  }

  // ── Number index: add to group at that position ────────────────────────────
  const idx = parseInt(input, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= groups.length) {
    const target = groups[idx - 1];
    const res = await addUser(api, userID, target.threadID);
    if (res.ok) {
      return api.sendMessage(
        `✅ تمت إضافتك لـ "${getGroupName(target)}"!`,
        threadID, messageID
      );
    } else {
      return api.sendMessage(
        `❌ فشلت الإضافة لـ "${getGroupName(target)}": ${res.err}`,
        threadID, messageID
      );
    }
  }

  // ── Raw thread ID ──────────────────────────────────────────────────────────
  const byID = groups.find(g => String(g.threadID) === input);
  if (byID) {
    const res = await addUser(api, userID, byID.threadID);
    if (res.ok) {
      return api.sendMessage(
        `✅ تمت إضافتك لـ "${getGroupName(byID)}"!`,
        threadID, messageID
      );
    } else {
      return api.sendMessage(
        `❌ فشلت الإضافة: ${res.err}`,
        threadID, messageID
      );
    }
  }

  // ── Not found ──────────────────────────────────────────────────────────────
  return api.sendMessage(
    `❌ ما لقيت غروب بهذا الرقم أو ID.\nاكتب .ضيفني بدون أي شي لترى قائمة الغروبات.`,
    threadID, messageID
  );
};
