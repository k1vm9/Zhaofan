"use strict";

module.exports.config = {
  name: "presence",
  version: "1.0.0",
  hasPermssion: 1,
  credits: "ZAO",
  description: "Online Presence Engine status — sessions, schedule, pattern history",
  commandCategory: "System",
  usages: "presence",
  cooldowns: 5
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  let eng;
  try { eng = require("../../includes/OnlinePresenceEngine"); }
  catch (e) {
    return api.sendMessage("❌ Could not load Online Presence Engine.", threadID, messageID);
  }

  const s = eng.getStatus();

  const onlineIcon = s.online ? "🟢 ONLINE" : "⚫ OFFLINE";

  const nextStr = s.nextSession
    ? (() => {
        const diff = new Date(s.nextSession) - Date.now();
        const m = Math.round(diff / 60000);
        if (m <= 0) return "imminent";
        if (m < 60) return `in ${m} min`;
        const h = Math.floor(m / 60), rm = m % 60;
        return `in ${h}h ${rm}m`;
      })()
    : "none today";

  const coolingStr = s.coolingUntil
    ? (() => {
        const diff = new Date(s.coolingUntil) - Date.now();
        const m = Math.max(0, Math.round(diff / 60000));
        return `⏳ Cooling — ${m} min remaining`;
      })()
    : null;

  const history = (s.dayPatternHistory || []).slice(0, 5).map(h =>
    `  • ${h.ts.replace("T"," ").slice(0,16)} — ${h.key} — ${h.sessions} session(s), ${h.threadCount} threads`
  ).join("\n") || "  (none yet)";

  const recent = (s.recentChanges || []).slice(0, 6).map(r =>
    `  ${r.state === "online" ? "🟢" : "⚫"} [${r.ts.slice(11,16)}] ${r.state} ${r.note ? "— " + r.note : ""}`
  ).join("\n") || "  (none yet)";

  const msg = [
    "╔══ 📡 Online Presence Status ══╗",
    `  Status : ${onlineIcon}`,
    `  Sessions today: ${s.sessionCount} done  |  ${s.todayRemaining} remaining`,
    `  Next session: ${nextStr}`,
    coolingStr ? `  ${coolingStr}` : null,
    `  Weekend: ${s.isWeekend ? "Yes" : "No"}  |  Pattern: ${s.dayPatternKey || "—"}`,
    `  Pending seen queue: ${s.pendingQueue}`,
    "",
    "📅 Day pattern history:",
    history,
    "",
    "🕐 Recent presence changes:",
    recent,
    "╚═══════════════════════════╝"
  ].filter(l => l !== null).join("\n");

  api.sendMessage(msg, threadID, messageID);
};
