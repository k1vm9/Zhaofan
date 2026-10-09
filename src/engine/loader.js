/**
 * Djamel-Fca Architecte — Command Loader (with hot-reload support)
 * Copyright © 2025 DJAMEL
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");
const log  = require("./logger");

function loadCommands(dirs) {
  const commands = new Map();
  const roots = (Array.isArray(dirs) ? dirs : [dirs]).map(dir => path.resolve(process.cwd(), dir));
  let loaded = 0, failed = 0, skipped = 0;
  const seenFiles = new Set();

  for (const absDir of roots) {
    if (!fs.existsSync(absDir)) {
      log.warn("LOADER", `مجلد الأوامر غير موجود: ${absDir}`);
      continue;
    }
    const files = fs.readdirSync(absDir).filter(f => f.endsWith(".js") && !f.startsWith("_") && f !== "index.js");
    const isLegacyZAO = path.relative(process.cwd(), absDir).split(path.sep).join("/") === "SCRIPTS/ZAO-CMDS";

    console.log();
    console.log(`\x1b[36m  ─── Djamel-Fca Architecte — تحميل الأوامر (${files.length}) ───\x1b[0m`);

    for (const file of files) {
      const absPath = path.resolve(absDir, file);
      if (seenFiles.has(absPath)) continue;
      seenFiles.add(absPath);
      try {
        const source = fs.readFileSync(absPath, "utf8");
        if (isLegacyZAO) {
          const incompatibleDependency = /require\s*\(\s*["'][^"']*ZAO-ENGINE\//.test(source);
          const unsupportedGlobal = getLegacyUnsupportedGlobals(source);
          if (incompatibleDependency || unsupportedGlobal.length) {
            const reason = incompatibleDependency ? "ZAO engine dependency" : `runtime globals: ${unsupportedGlobal.join(", ")}`;
            console.log(`  \x1b[33m↷\x1b[0m ${file}: not carried over (${reason})`);
            skipped++;
            continue;
          }
        }
        delete require.cache[absPath];
        const cmd = require(absPath);
        if (cmd?.config?.name) {
          const normalized = normalizeCommand(cmd, { legacyZAO: isLegacyZAO, sourcePath: absPath });
          const name = normalized.config.name;
          registerCommand(commands, name, normalized);
          if (typeof normalized.onChat === "function" && global.GoatBot?.onChat && !global.GoatBot.onChat.includes(name))
            global.GoatBot.onChat.push(name);
          console.log(`  \x1b[32m✅\x1b[0m /${name}${isLegacyZAO ? " (ZAO compatible)" : ""}`);
          loaded++;
        } else if (cmd?.name && typeof cmd.run === "function") {
          const name = String(cmd.name).toLowerCase();
          registerCommand(commands, name, {
            config: { name, aliases: cmd.aliases || [], category: cmd.category || "other", role: isLegacyZAO ? 0 : 2, description: cmd.description || "" },
            onStart: ctx => cmd.run(ctx),
            __legacyZAO: isLegacyZAO,
            __sourcePath: absPath,
          });
          console.log(`  \x1b[32m✅\x1b[0m /${name} (legacy)`);
          loaded++;
        } else {
          console.log(`  \x1b[33m⚠\x1b[0m ${file}: لا يوجد config.name`);
          failed++;
        }
      } catch (e) {
        console.log(`  \x1b[31m❌\x1b[0m ${file}: ${e.message}`);
        failed++;
      }
    }
  }

  console.log();
  log.ok("LOADER", `تم تحميل \x1b[32m${loaded}\x1b[0m أمر${failed ? ` (${failed} فشل)` : ""}${skipped ? `، وتم تجاوز ${skipped} أمر غير متوافق` : ""} ✔`);
  return commands;
}

function normalizeCommand(cmd, { legacyZAO = false, sourcePath = "" } = {}) {
  const name = String(cmd.config.name).toLowerCase();
  const role = Number(cmd.config.role ?? (legacyZAO ? cmd.config.hasPermssion : undefined) ?? (legacyZAO ? 0 : 2));
  return {
    ...cmd,
    config: {
      ...cmd.config,
      name,
      aliases: Array.isArray(cmd.config.aliases) ? cmd.config.aliases : [],
      role: Number.isFinite(role) ? role : (legacyZAO ? 0 : 2),
      category: cmd.config.category || cmd.config.commandCategory || "other",
      description: cmd.config.description || "",
    },
    __legacyZAO: legacyZAO,
    __sourcePath: sourcePath,
  };
}

function registerCommand(commands, name, cmd) {
  commands.set(name, cmd);
  for (const alias of cmd.config.aliases || []) {
    if (alias) commands.set(String(alias).toLowerCase(), cmd);
  }
}

const SUPPORTED_LEGACY_GLOBALS = new Set([
  "config", "client", "commands", "commandPrefix", "utils", "log", "ownerID",
  "botUserID", "_botApi", "lastMqttActivity", "lastMqttOnlyActivity", "data", "lockBot",
  "_selfWriteConfig", "updateRuntimeConfig", "angelIntervals", "_angelRestored", "chatsSession",
  "divelMonitor", "lastActivity", "lastAltJsonSave", "lastSessionSave", "motorData", "motorData2",
  "nicknameLocks", "repeatName", "zaoHistory", "zaoWizard", "zaoViewWizard",
  "zaofanHistory", "zaofanWizard", "zaofanViewWizard", "_groupImgNextApply",
  "_groupImgInterval", "_labyrinth", "_nmNextApply", "_nmInterval", "_randomizer",
  "__motorWatchdog1", "__motorWatchdog2", "__zaoHistorySweeper", "__zaofanHistorySweeper",
  "_silentMode", "_mqttReady", "_saveMotorState", "_saveMotor2State", "gc",
]);

const SUPPORTED_LEGACY_DATA_KEYS = new Set([
  "allThreadID", "allUserID", "allCurrenciesID", "threadInfo", "threadData",
  "userData", "userName", "userBanned", "threadBanned", "threadAllowNSFW",
]);

function getLegacyUnsupportedGlobals(source) {
  const refs = [...source.matchAll(/\bglobal(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\2\s*\])/g)]
    .map(match => match[1] || match[3]);
  const unsupported = refs.filter(ref => !SUPPORTED_LEGACY_GLOBALS.has(ref));
  const dataRefs = [...source.matchAll(/\bglobal\.data(?:\?\.|\.)([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  unsupported.push(...dataRefs.filter(ref => !SUPPORTED_LEGACY_DATA_KEYS.has(ref)));
  return [...new Set(unsupported)];
}

function loadLegacyEvents(dir) {
  const events = new Map();
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) return events;
  const files = fs.readdirSync(absDir)
    .filter(file => file.endsWith(".js") && !file.startsWith("_") && file !== "index.js")
    .sort();
  let skipped = 0;
  let antioutLoaded = false;

  for (const file of files) {
    const absPath = path.join(absDir, file);
    try {
      const source = fs.readFileSync(absPath, "utf8");
      const unsupported = getLegacyUnsupportedGlobals(source);
      if (unsupported.length) {
        console.log(`  ↷ ${file}: event not carried over (runtime globals: ${unsupported.join(", ")})`);
        skipped++;
        continue;
      }
      delete require.cache[absPath];
      const event = require(absPath);
      const types = Array.isArray(event?.config?.eventType)
        ? event.config.eventType
        : (event?.config?.eventType ? [event.config.eventType] : []);
      if (!event?.config?.name || typeof event.run !== "function" || !types.length) {
        console.log(`  ↷ ${file}: event not carried over (incomplete event definition)`);
        skipped++;
        continue;
      }
      const name = String(event.config.name);
      if (events.has(name)) {
        console.log(`  ↷ ${file}: duplicate event name`);
        skipped++;
        continue;
      }
      const antiout = /anti[\s_-]?out|منع[\s_-]?الخروج/i.test(
        `${file} ${name} ${event.config.description || ""}`,
      );
      if (antiout && antioutLoaded) {
        console.log(`  ↷ ${file}: duplicate anti-out handler`);
        skipped++;
        continue;
      }
      if (antiout) antioutLoaded = true;
      event.__legacyZAO = true;
      event.__sourcePath = absPath;
      events.set(name, event);
      console.log(`  ✓ legacy event: ${name}`);
    } catch (error) {
      console.log(`  ✗ ${file}: ${error.message}`);
      skipped++;
    }
  }
  console.log(`  Legacy events loaded: ${events.size}${skipped ? `, skipped: ${skipped}` : ""}`);
  return events;
}

function hotReloadCommand(absPath) {
  try {
    delete require.cache[absPath];
    const cmd = require(absPath);
    if (!cmd?.config?.name) return { ok: false, error: "config.name مفقود" };
    const name = String(cmd.config.name).toLowerCase();
    if (global.GoatBot?.commands) {
      global.GoatBot.commands.set(name, cmd);
      if (cmd.config.aliases) for (const a of cmd.config.aliases||[]) if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
    }
    log.ok("HOT-CMD", `/${name} تم تحديثه بدون إعادة تشغيل ✔`);
    return { ok: true, name };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { loadCommands, loadLegacyEvents, hotReloadCommand, getLegacyUnsupportedGlobals, normalizeCommand };
