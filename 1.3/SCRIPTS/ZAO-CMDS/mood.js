"use strict";

/**
 * mood.js — Bot activity mood and pressure readout.
 * Shows current behavioral topic, activity pressure, error state,
 * time-of-day mode, and a plain-language "mood" summary.
 */

module.exports.config = {
  name: "mood",
  version: "1.0.0",
  hasPermssion: 1,
  credits: "ZAO",
  description: "Show the bot's current activity mood, topic, and pressure level",
  commandCategory: "System",
  usages: "mood",
  cooldowns: 5
};

const TOPIC_EMOJI = {
  sports:        "⚽",
  tech:          "💻",
  entertainment: "🎬",
  lifestyle:     "✈️",
  arabic:        "🌙"
};

const TOPIC_DESC = {
  sports:        "Sports & fitness — searching match results, browsing sports reels",
  tech:          "Tech & gadgets — searching reviews, AI news, gaming setups",
  entertainment: "Entertainment — browsing music, movies, anime, funny clips",
  lifestyle:     "Lifestyle — travel, cooking, photography, home decor",
  arabic:        "Arabic mode — local news, religion, food, culture"
};

function _timeLabel() {
  const h = new Date().getHours();
  if (h >= 0  && h < 6)  return "🌃 Late night";
  if (h >= 6  && h < 9)  return "🌅 Morning";
  if (h >= 9  && h < 12) return "☀️ Mid-morning";
  if (h >= 12 && h < 14) return "🌞 Lunch time";
  if (h >= 14 && h < 17) return "☀️ Afternoon";
  if (h >= 17 && h < 20) return "🌇 Evening";
  if (h >= 20 && h < 23) return "🌙 Night";
  return "🌌 Late night";
}

module.exports.run = async function ({ api, event }) {
  const { threadID, messageID } = event;

  let sim;
  try { sim = require("../../includes/HumanActivitySimulator"); }
  catch (e) {
    return api.sendMessage("❌ Could not load Human Activity Simulator.", threadID, messageID);
  }

  let eng;
  try { eng = require("../../includes/OnlinePresenceEngine"); }
  catch (_) { eng = null; }

  const s  = sim.getStatus();
  const es = eng ? eng.getStatus() : null;

  const topic    = s.activeTopic || "tech";
  const emoji    = TOPIC_EMOJI[topic]  || "🤖";
  const desc     = TOPIC_DESC[topic]   || topic;
  const pressure = s.activityPressure  || 0;
  const errors   = s.consecutiveErrors || 0;

  const moodName =
    s.errorBackoffUntil                          ? "😴 Resting (error recovery)"  :
    !s.active                                    ? "💤 Disabled"                  :
    pressure >= 0.8 && errors >= 2               ? "😟 Stressed — slowing down"   :
    pressure >= 0.6                              ? "😤 Busy — high pressure"       :
    es && es.online && s.cycleCount > 0          ? "😊 Active & browsing"          :
    es && es.online                              ? "👀 Online — warming up"         :
    s.cycleCount > 0                             ? "😌 Idle background mode"        :
    "🥱 Just started";

  const pressurePct = Math.round(pressure * 100);
  const bar = "█".repeat(Math.round(pressure * 10)) + "░".repeat(10 - Math.round(pressure * 10));

  const onlineStatus = (() => {
    if (!es) return "unknown";
    if (es.online) return "🟢 Online";
    if (es.nextSession) {
      const m = Math.round((new Date(es.nextSession) - Date.now()) / 60000);
      const t = m <= 0 ? "soon" : m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${m % 60}m`;
      return `⚫ Offline — next: ${t}`;
    }
    return "⚫ Offline";
  })();

  const msg = [
    "╔══ 🧠 Bot Mood Report ══╗",
    `  Mood    : ${moodName}`,
    `  Time    : ${_timeLabel()}`,
    `  Online  : ${onlineStatus}`,
    "",
    `${emoji} Topic: ${topic.toUpperCase()}`,
    `   ${desc}`,
    "",
    `📊 Pressure: [${bar}] ${pressurePct}%`,
    `   Errors  : ${errors} consecutive`,
    s.errorBackoffUntil
      ? `   Backoff : until ${new Date(s.errorBackoffUntil).toISOString().slice(11,19)}`
      : null,
    "",
    `⚙️  Cycles run: ${s.cycleCount}  |  Total actions: ${s.actionsTotal}`,
    `   Weekend mode: ${s.isWeekend ? "Yes 🎉" : "No"}`,
    "╚═══════════════════════╝"
  ].filter(l => l !== null).join("\n");

  api.sendMessage(msg, threadID, messageID);
};
