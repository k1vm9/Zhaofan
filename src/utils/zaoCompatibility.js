"use strict";

const fs = require("fs-extra");
const path = require("path");

const SETTINGS_PATH = path.join(process.cwd(), "ZAO-SETTINGS.json");
const MAX_TRACKED_IDS = 20000;
let apiRef = null;
let storeCache = null;

function readLegacySettings() {
  try {
    const settings = fs.readJsonSync(SETTINGS_PATH);
    return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  } catch (_) {
    return {};
  }
}

function mergeLegacySettings(config = {}) {
  const old = readLegacySettings();
  const prefix = String(config.prefix || old.PREFIX || ".");
  const ownerID = Object.hasOwn(config, "ownerID")
    ? String(config.ownerID || "")
    : String(old.OWNERID || "");
  const adminBot = Array.isArray(config.adminBot)
    ? config.adminBot.map(String)
    : (Array.isArray(old.ADMINBOT) ? old.ADMINBOT.map(String) : []);
  const botName = config.botName && config.botName !== "My Bot"
    ? config.botName
    : (old.BOTNAME || config.botName || "Djamel-Fca Architecte");

  return {
    ...old,
    ...config,
    PREFIX: prefix,
    OWNERID: ownerID,
    ADMINBOT: adminBot,
    BOTNAME: botName,
    prefix,
    ownerID,
    adminBot,
    superAdminBot: Array.isArray(config.superAdminBot)
      ? config.superAdminBot.map(String)
      : (ownerID ? [ownerID] : []),
    botName,
  };
}

function createLegacyClient() {
  return {
    commands: global.GoatBot?.commands || new Map(),
    events: new Map(),
    eventRegistered: [],
    handleReply: [],
    handleReaction: [],
    cooldowns: new Map(),
    mainPath: process.cwd(),
  };
}

function readStore() {
  if (storeCache) return storeCache;
  let store = {};
  try {
    const file = global.db?._path || path.join(process.cwd(), "database", "data", "core.json");
    if (fs.existsSync(file)) store = fs.readJsonSync(file);
  } catch (_) {}
  storeCache = {
    threads: store.threads && typeof store.threads === "object" ? store.threads : {},
    users: store.users && typeof store.users === "object" ? store.users : {},
    currencies: store.currencies && typeof store.currencies === "object" ? store.currencies : {},
    created: store.created || Date.now(),
  };
  return storeCache;
}

function persistStore() {
  const file = global.db?._path || path.join(process.cwd(), "database", "data", "core.json");
  fs.ensureDirSync(path.dirname(file));
  const temp = `${file}.zao-tmp`;
  fs.writeFileSync(temp, JSON.stringify(readStore(), null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function upsert(collection, id, value) {
  const key = String(id);
  const current = collection[key] && typeof collection[key] === "object" ? collection[key] : {};
  collection[key] = { ...current, ...(value && typeof value === "object" ? value : {}) };
  persistStore();
  return collection[key];
}

function makeDataAdapters() {
  const userData = {
    async getData(id) { return { userID: String(id), ...(readStore().users[String(id)] || {}) }; },
    async getById(id) { return this.getData(id); },
    async getName(id) {
      return readStore().users[String(id)]?.name || global.data?.userName?.get(String(id)) || String(id);
    },
    async getNameUser(id) { return this.getName(id); },
    async setData(id, data) { return upsert(readStore().users, id, data); },
    async setName(id, name) { return upsert(readStore().users, id, { name }); },
  };
  const threadData = {
    async getData(id) { return { threadID: String(id), ...(readStore().threads[String(id)] || {}) }; },
    async getInfo(id) {
      if (apiRef && typeof apiRef.getThreadInfoCached === "function") {
        try {
          const info = await apiRef.getThreadInfoCached(String(id));
          if (info) {
            global.data?.threadInfo?.set(String(id), info);
            return info;
          }
        } catch (_) {}
      }
      return global.data?.threadInfo?.get(String(id)) || this.getData(id);
    },
    async setData(id, data) { return upsert(readStore().threads, id, data); },
    async setName(id, name) { return upsert(readStore().threads, id, { threadName: name }); },
  };
  const currencies = {
    async getData(id) {
      const record = readStore().currencies[String(id)] || {};
      return { userID: String(id), money: 0, ...record };
    },
    async setData(id, data) { return upsert(readStore().currencies, id, data); },
  };
  return { Users: userData, Threads: threadData, Currencies: currencies };
}

function legacyMessage(api, event) {
  return {
    reply: (content, callback) => api.sendMessage(content, event.threadID, callback),
    send: (content, threadID, callback) => api.sendMessage(content, threadID || event.threadID, callback),
    unsend: (messageID, callback) => api.unsendMessage?.(messageID || event.messageID, callback),
    react: (emoji, messageID, callback) =>
      api.setMessageReaction?.(emoji, messageID || event.messageID, callback || (() => {}), true),
  };
}

function getLegacyContextData() {
  return makeDataAdapters();
}

function createLegacyContext(api, event, args = [], extra = {}) {
  const adapters = makeDataAdapters();
  return {
    api,
    event,
    args,
    message: legacyMessage(api, event),
    Users: adapters.Users,
    Threads: adapters.Threads,
    Currencies: adapters.Currencies,
    models: {},
    globalData: global.db || {},
    usersData: adapters.Users,
    threadsData: adapters.Threads,
    getLang: () => "",
    permssion: 0,
    ...extra,
  };
}

function initLegacyState(commands) {
  const client = global.client || createLegacyClient();
  client.commands = commands || global.GoatBot?.commands || new Map();
  client.eventRegistered = [...new Set(
    [...new Set(client.commands.values())]
      .filter(cmd => cmd.__legacyZAO && typeof cmd.handleEvent === "function")
      .map(cmd => cmd.config.name)
  )];
  global.client = client;
  global.commands = client.commands;
  global.data = global.data || {
    allThreadID: [],
    allUserID: [],
    allCurrenciesID: [],
    threadInfo: new Map(),
    threadData: new Map(),
    userData: new Map(),
    userName: new Map(),
    userBanned: new Map(),
    threadBanned: new Map(),
    threadAllowNSFW: [],
  };
  if (!(global.data.threadInfo instanceof Map)) global.data.threadInfo = new Map();
  if (!(global.data.threadData instanceof Map)) global.data.threadData = new Map();
  if (!(global.data.userData instanceof Map)) global.data.userData = new Map();
  if (!(global.data.userName instanceof Map)) global.data.userName = new Map();
  if (!Array.isArray(global.data.allThreadID)) global.data.allThreadID = [];
  if (!Array.isArray(global.data.allUserID)) global.data.allUserID = [];
  if (!Array.isArray(global.data.allCurrenciesID)) global.data.allCurrenciesID = [];
  const adapters = makeDataAdapters();
  global.Users = adapters.Users;
  global.Threads = adapters.Threads;
  global.Currencies = adapters.Currencies;
  return client;
}

function setApi(api) {
  apiRef = api || null;
}

function trackId(list, id) {
  if (!Array.isArray(list) || id == null) return;
  const value = String(id);
  if (!list.includes(value)) list.push(value);
  if (list.length > MAX_TRACKED_IDS) list.splice(0, list.length - MAX_TRACKED_IDS);
}

function observeEvent(event) {
  const data = global.data;
  if (!data || !event) return;
  trackId(data.allThreadID, event.threadID);
  trackId(data.allUserID, event.senderID);
  if (event.senderID != null && (event.senderName || event.name)) {
    data.userName.set(String(event.senderID), event.senderName || event.name);
  }
  if (event.threadID && event.threadName) {
    data.threadData.set(String(event.threadID), { threadName: event.threadName });
  }
}

function runLegacyLoadHooks(api, commands) {
  const adapters = makeDataAdapters();
  for (const cmd of new Set(commands?.values?.() || [])) {
    if (!cmd.__legacyZAO || typeof cmd.onLoad !== "function") continue;
    try {
      const result = cmd.onLoad({
        api,
        ...adapters,
        models: {},
        globalData: global.db || {},
        client: global.client,
      });
      if (result && typeof result.then === "function") {
        result.catch(error => global.log?.warn?.("ZAO-COMPAT", `${cmd.config.name} onLoad: ${error.message}`));
      }
    } catch (error) {
      global.log?.warn?.("ZAO-COMPAT", `${cmd.config.name} onLoad: ${error.message}`);
    }
  }
  for (const event of global.client?.events?.values?.() || []) {
    if (typeof event.onLoad !== "function") continue;
    try {
      const result = event.onLoad({
        api,
        ...adapters,
        models: {},
        globalData: global.db || {},
        client: global.client,
      });
      if (result && typeof result.then === "function") {
        result.catch(error => global.log?.warn?.("ZAO-COMPAT", `${event.config.name} onLoad: ${error.message}`));
      }
    } catch (error) {
      global.log?.warn?.("ZAO-COMPAT", `${event.config.name} onLoad: ${error.message}`);
    }
  }
}

module.exports = {
  mergeLegacySettings,
  createLegacyClient,
  initLegacyState,
  setApi,
  observeEvent,
  runLegacyLoadHooks,
  getLegacyContextData,
  createLegacyContext,
};
