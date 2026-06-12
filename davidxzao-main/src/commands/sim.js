"use strict";

module.exports.config = {
  name: "sim",
  version: "1.0.0",
  hasPermssion: 1,
  credits: "ZAO",
  description: "Human Activity Simulator status — cycles, actions, topic, pressure",
  commandCategory: "System",
  usages: "sim",
  cooldowns: 5
};

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  let sim;
  try { sim = require("../../includes/HumanActivitySimulator"); }
  catch (e) {
    return api.sendMessage("❌ Could not load Human Activity Simulator.", threadID, messageID);
  }

  const s = sim.getStatus();

  const pressureBar = (() => {
    const p = Math.round((s.activityPressure || 0) * 10);
    const filled = "█".repeat(p);
    const empty  = "░".repeat(10 - p);
    return filled + empty;
  })();

  const pressureLabel = s.activityPressure >= 0.8 ? "🔴 High"
                      : s.activityPressure >= 0.5 ? "🟡 Moderate"
                      : "🟢 Low";

  const statusIcon = s.active ? (s.online ? "🟢 Online" : "🟡 Offline-sync") : "⛔ Disabled";

  const recent = (s.recentActions || []).slice(0, 8).map(a => {
    const icon = a.ok ? "✅" : "❌";
    const time = a.ts ? new Date(a.ts).toISOString().slice(11, 16) : "--";
    return `  ${icon} [${time}] ${a.type}${a.detail ? ` → ${a.detail.slice(0, 40)}` : ""}`;
  }).join("\n") || "  (none yet)";

  const backoffNote = s.errorBackoffUntil
    ? `\n⏸ Error backoff until: ${s.errorBackoffUntil}`
    : "";

  const msg = [
    "╔══ 🤖 Human Simulator Status ══╗",
    `  Status : ${statusIcon}`,
    `  Cycles : ${s.cycleCount}  |  Actions: ${s.actionsTotal}`,
    `  Last cycle : ${s.lastCycleTs ? s.lastCycleTs.replace("T", " ").slice(0, 19) : "none"}`,
    `  Weekend: ${s.isWeekend ? "Yes" : "No"}  |  Night mode: ${(s.config || {}).nightMode ? "On" : "Off"}`,
    "",
    `🎯 Active topic: ${(s.activeTopic || "—").toUpperCase()}`,
    `   Search pool: ${(s.topicSearchPool || []).slice(0, 4).join(", ")}…`,
    "",
    `📊 Activity pressure: ${pressureLabel}`,
    `   [${pressureBar}] ${Math.round((s.activityPressure || 0) * 100)}%`,
    `   Consecutive errors: ${s.consecutiveErrors || 0}`,
    backoffNote,
    "",
    `⚙️  Cycle: ${(s.config || {}).cycleInterval}  |  Max/cycle: ${(s.config || {}).maxPerCycle}`,
    `   Burst: ${(s.config || {}).burstActions} actions  |  Total action types: ${(s.config || {}).totalActions}`,
    "",
    "🕐 Recent actions:",
    recent,
    "╚═══════════════════════════╝"
  ].join("\n");

  api.sendMessage(msg, threadID, messageID);
};
