/**
 * Djamel-Fca Architecte Core — Core Globals (GoatBot Pattern)
 * Copyright © 2025 DJAMEL
 */
"use strict";

const path = require("path");
const zaoCompatibility = require("../utils/zaoCompatibility");

function initGlobals(config) {
  global.GoatBot = {
    startTime:      Date.now(),
    config,
    commands:       new Map(),
    eventCommands:  new Map(),
    aliases:        new Map(),
    onChat:         [],
    onReply:        new Map(),
    onReaction:     new Map(),
    onEvent:        [],
    fcaApi:         null,
    botID:          null,
    angelIntervals: {},
    divelWatchers:  {},
    nmLocks:        new Map(),
    dmLocked:       false,
    allThreadData:  {},
    reLoginBot:     () => {},
    _replyTimeout:  30 * 60 * 1000,
  };

  // State used by the command modules ported to Djamel-Fca. Keep it in
  // the new runtime, rather than relying on ZAO.js globals.
  Object.assign(global, {
    angelIntervals: global.GoatBot.angelIntervals,
    chatsSession: {},
    divelMonitor: global.GoatBot.divelWatchers,
    lastActivity: {},
    lastAltJsonSave: null,
    lastSessionSave: null,
    motorData: {},
    motorData2: {},
    nicknameLocks: {},
    repeatName: {},
    zaoHistory: Object.create(null),
    zaoWizard: new Map(),
    zaoViewWizard: new Map(),
    zaofanHistory: Object.create(null),
    zaofanWizard: new Map(),
    zaofanViewWizard: new Map(),
    _angelRestored: false,
    _groupImgNextApply: new Map(),
    _groupImgInterval: null,
    _labyrinth: null,
    _nmNextApply: new Map(),
    _nmInterval: null,
    _randomizer: require("./ported/randomizer"),
    _selfWriteConfig: false,
    _silentMode: false,
    __motorWatchdog1: null,
    __motorWatchdog2: null,
    __zaoHistorySweeper: null,
    __zaofanHistorySweeper: null,
    _mqttReady: false,
  });
  global._saveMotorState = () => require("./ported/motorPersist").motor1.persistAll(global.motorData);
  global._saveMotor2State = () => require("./ported/motorPersist").motor2.persistAll(global.motorData2);
  global.updateRuntimeConfig = nextConfig => {
    global.GoatBot.config = nextConfig;
    global.config = zaoCompatibility.mergeLegacySettings(nextConfig);
    global.ownerID = String(nextConfig?.ownerID || "");
    global.commandPrefix = nextConfig?.prefix || "/";
    return global.config;
  };

  global.db = { allThreadData: [], allUserData: [] };

  // utils globaux
  const fca = require("../../Djamel-fca");
  global.utils = {
    calcHumanTypingDelay: fca.calcTypingDelay,
    simulateTyping:       fca.simulateTyping,
    log:                  require("./logger"),
    sleep:   ms => new Promise(r => setTimeout(r, ms)),
    isNum:   v  => !isNaN(parseFloat(v)) && isFinite(v),
    getPrefix: () => global.GoatBot?.config?.prefix || "/",
    rand:    (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,
  };

  // Clean expired onReply entries every 5 min
  setInterval(() => {
    const now = Date.now();
    const timeout = global.GoatBot?._replyTimeout || 1800000;
    for (const [k, v] of global.GoatBot.onReply) {
      if (v.ts && now - v.ts > timeout) global.GoatBot.onReply.delete(k);
    }
  }, 5 * 60 * 1000);

  // Aliases
  global.log           = global.utils.log;
  global.config        = config;
  global.ownerID       = config.ownerID || "";
  global.commandPrefix = config.prefix  || "/";
  global.commands      = global.GoatBot.commands;
  global.djamelbot     = { startTime: Date.now(), version: config.botVersion || "2.0.0", api: null };
}

module.exports = { initGlobals };
