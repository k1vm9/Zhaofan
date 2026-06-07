/**
 * refresh.js — Hot-reload bot commands
 * @debugger Djamel — Fixed critical bug: global.client.events is a Map,
 *   but this file was treating it as an Array (.push, .filter, Array.isArray).
 *   All operations now use Map methods (.set, .delete, .has).
 *   Also fixed eventRegistered Array sync to match Map state.
 */

const fs   = require("fs");
const path = require("path");

module.exports.config = {
  name: "ريفرش",
  version: "3.1.0",
  hasPermssion: 2,
  credits: "Yassin",
  description: "تحديث الأوامر + قراءة الجديد + حذف المحذوف",
  commandCategory: "system",
  usages: "[command name]",
  cooldowns: 3
};

/**
 * Remove a command from both the commands Map and eventRegistered Array.
 * If the command also registered a ZAO-EVT (events Map), remove that too.
 */
function unregisterCommand(cmdName) {
  // Remove from commands Map
  global.client.commands.delete(cmdName);

  // Remove from eventRegistered Array
  const idx = (global.client.eventRegistered || []).indexOf(cmdName);
  if (idx !== -1) global.client.eventRegistered.splice(idx, 1);
}

/**
 * Register a freshly-loaded command module.
 */
function registerCommand(command) {
  const name = command.config.name;

  // Add to commands Map
  global.client.commands.set(name, command);

  // If it has a handleEvent hook, add name to eventRegistered Array
  if (typeof command.handleEvent === "function") {
    if (!global.client.eventRegistered.includes(name)) {
      global.client.eventRegistered.push(name);
    }
  }
}

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  const commandsPath = __dirname;

  try {
    const files     = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));
    const fileNames = files.map(f => f.replace(".js", ""));

    // ── 1. Remove stale commands (file deleted but still in memory) ──────────
    for (const [name, cmd] of global.client.commands) {
      if (cmd && cmd.__filename && !fileNames.includes(cmd.__filename)) {
        unregisterCommand(name);
        console.log("🗑️ Removed stale command:", name);
      }
    }

    const targetName = args[0];

    // ── 2. Reload a single command ──────────────────────────────────────────
    if (targetName) {
      const filePath = path.join(commandsPath, targetName + ".js");
      if (!fs.existsSync(filePath)) {
        return api.sendMessage("❌ الأمر غير موجود: " + targetName, threadID, messageID);
      }

      delete require.cache[require.resolve(filePath)];
      const command = require(filePath);
      command.__filename = targetName;

      unregisterCommand(command.config.name);
      registerCommand(command);

      return api.sendMessage(`✅ تم تحديث الأمر: ${command.config.name}`, threadID, messageID);
    }

    // ── 3. Reload all commands ───────────────────────────────────────────────
    let success = 0, failed = 0, added = 0;

    for (const file of files) {
      try {
        const filePath = path.join(commandsPath, file);
        delete require.cache[require.resolve(filePath)];
        const command = require(filePath);
        command.__filename = file.replace(".js", "");

        const isNew = !global.client.commands.has(command.config.name);
        unregisterCommand(command.config.name);
        registerCommand(command);

        if (isNew) { added++; console.log("🆕 New:", command.config.name); }
        success++;
      } catch (err) {
        console.error(`❌ ${file}:`, err.message);
        failed++;
      }
    }

    api.sendMessage(
      `🔄 تم التحديث\n✅ نجاح: ${success}\n🆕 جديد: ${added}\n❌ فشل: ${failed}`,
      threadID, messageID
    );

  } catch (err) {
    console.error(err);
    api.sendMessage("⚠️ حصل خطأ أثناء التحديث: " + (err.message || err), threadID, messageID);
  }
};
