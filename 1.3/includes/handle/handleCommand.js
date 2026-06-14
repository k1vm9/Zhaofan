/**
 * handleCommand.js
 * Parses incoming messages and dispatches to registered commands.
 *
 * @debugger Djamel — Fixed undefined senderID/threadID crash before toString(),
 *   guarded commandCategory against undefined, fixed lockBot check order.
 */

module.exports = function ({ api, models, Users, Threads, Currencies, globalData, usersData, threadsData ,message }) {
  const humanTyping = (() => { try { return require("../humanTyping"); } catch (_) { return null; } })();
  const stringSimilarity = require("string-similarity"),
    escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    logger = require("../../utils/log.js");
  const chalk = require("chalk");
  const moment = require("moment-timezone");
  // [PROTECT] sandbox + per-command error budget
  const _sandbox    = (() => { try { return require("../commandSandbox");      } catch (_) { return null; } })();
  const _errBudget  = (() => { try { return require("../commandErrorBudget");  } catch (_) { return null; } })();
  
 return async function ({ event, message: _message }) {
    const message = _message;
    const dateNow = Date.now();
    const time = moment.tz("Asia/Manila").format("HH:mm:ss DD/MM/YYYY");
    const { allowInbox, PREFIX, ADMINBOT, DeveloperMode, adminOnly } =
      global.config;

    const { userBanned, threadBanned, threadInfo, threadData, commandBanned } =
      global.data;
    const { commands, cooldowns } = global.client;
    
    var { body, senderID, threadID, messageID } = event;

    // ── [FIX Djamel] — Guard undefined IDs before ANY toString call ──
    if (!senderID || !threadID) return;

    // ── فحص قفل البوت ──────────────────────────────────────
    if (global.lockBot === true && !ADMINBOT.includes(String(senderID))) return;
    // ────────────────────────────────────────────────────────

    var senderID = String(senderID),
      threadID = String(threadID);

    // Drop messages with no text (attachments, stickers, etc.)
    if (!body || !body.trim()) return;

    const isDM = senderID === threadID;

    // ── [FIX Djamel] — Honour `allowInbox: false` for ALL DM commands.
    // The original ban-check block below only fired the early-return path
    // when the sender or thread was *also* on the ban list, so a normal
    // user DMing the bot when allowInbox=false still ran every command.
    // handleEvent.js and handleCommandEvent.js already drop DM events here;
    // commands must too. Admins bypass so the operator can always reach the bot.
    if (allowInbox === false && isDM && !ADMINBOT.includes(senderID)) return;
    const threadSetting = threadData.get(threadID) || {};
    const activePrefix = threadSetting.hasOwnProperty("PREFIX")
      ? threadSetting.PREFIX
      : PREFIX;

    // In DMs no prefix is required — match prefix OR bare command
    const prefixRegex = isDM
      ? new RegExp(`^(<@!?${senderID}>|${escapeRegex(activePrefix)}|)`, "i")
      : new RegExp(`^(<@!?${senderID}>|${escapeRegex(activePrefix)})`);

    // ── No-prefix commands ─────────────────────────────────
    // Commands may opt into being callable without the configured prefix
    // by setting `config.noPrefix = true`. We test the very first word of
    // the message against the registered command map (exact match only —
    // similarity matching would falsely trigger on every Arabic message
    // starting with a substring of a command name). When the first word
    // matches a noPrefix command we let processing continue even though
    // the prefix regex would otherwise reject the message.
    const firstRawWord = body.trim().split(/\s+/)[0] || "";
    const firstWord = firstRawWord.replace(/[a-zA-Z]/g, c => c.toLowerCase());
    const noPrefixHit = (() => {
      try {
        const cmd = commands.get(firstWord);
        return !!(cmd && cmd.config && cmd.config.noPrefix === true);
      } catch (_) { return false; }
    })();

    if (!isDM && !noPrefixHit && !prefixRegex.test(body)) return;

    if (
      userBanned.has(senderID) ||
      threadBanned.has(threadID) ||
      (allowInbox === false && isDM)
    ) {
    

        
      if (!ADMINBOT.includes(String(senderID))) {
        if (userBanned.has(senderID)) {
          const { reason, dateAdded } = userBanned.get(senderID) || {};
          return api.sendMessage(
            global.getText("handleCommand", "userBanned", reason, dateAdded),
            threadID,
            async (err, info) => {
              if (err || !info) return;
              await new Promise((resolve) => setTimeout(resolve, 5 * 1000));
              return api.unsendMessage(info.messageID);
            },
            messageID
          );
        } else {
          if (threadBanned.has(threadID)) {
            const { reason, dateAdded } = threadBanned.get(threadID) || {};
            return api.sendMessage(
              global.getText(
                "handleCommand",
                "threadBanned",
                reason,
                dateAdded
              ),
              threadID,
              async (err, info) => {
                if (err || !info) return;
                await new Promise((resolve) => setTimeout(resolve, 5 * 1000));
                return api.unsendMessage(info.messageID);
              },
              messageID
            );
          }
        }
      }
    }

    
    // For noPrefix hits in groups the prefixRegex won't match — treat the
    // matched prefix as empty so the body itself becomes the command stream.
    const _prefixMatch = body.match(prefixRegex);
    const matchedPrefix = (_prefixMatch && _prefixMatch[0]) || "";
    const args = body.slice(matchedPrefix.length).trim().split(/ +/);
    var commandName = args.shift();
    if (!commandName) return;
    // Lowercase only for ASCII — preserve Arabic/non-Latin characters
    commandName = commandName.replace(/[a-zA-Z]/g, c => c.toLowerCase());

    // ── Auto-lock raid guard ────────────────────────────────
    // Tally non-admin command attempts in a rolling window. If the
    // configured threshold is breached, this flips global.lockBot=true
    // so the lockBot check at the top of this file silently drops
    // every subsequent non-admin command. Admins are never counted.
    try {
      if (!ADMINBOT.includes(senderID)) {
        require("../autoLockGuard").record(senderID);
      }
    } catch (_) {}
    // [PROTECT] graceful-shutdown drain — once draining, accept no new dispatches.
    if (global.__draining === true) return;

    var command = commands.get(commandName);
    if (!command) {
      var allCommandName = [];
      const commandValues = commands["keys"]();
      for (const cmd of commandValues) allCommandName.push(cmd);
      if (allCommandName.length === 0) return;
      const checker = stringSimilarity.findBestMatch(
        commandName,
        allCommandName
      );
      if (checker.bestMatch.rating >= 0.8)
        command = global.client.commands.get(checker.bestMatch.target);
      else
        return;
    }

    // [PROTECT] error-budget trip — silently skip commands currently in cooldown
    // due to repeated unhandled errors (admins were already notified once).
    try {
      if (_errBudget && _errBudget.isTripped(command.config.name)) return;
    } catch (_) {}
  
    if (commandBanned.get(threadID) || commandBanned.get(senderID)) {
      if (!ADMINBOT.includes(senderID)) {
        const banThreads = commandBanned.get(threadID) || [],
          banUsers = commandBanned.get(senderID) || [];
        if (banThreads.includes(command.config.name))
          return api.sendMessage(
            global.getText(
              "handleCommand",
              "commandThreadBanned",
              command.config.name
            ),
            threadID,
            async (err, info) => {
              if (err || !info) return;
              await new Promise((resolve) => setTimeout(resolve, 5 * 1000));
              return api.unsendMessage(info.messageID);
            },
            messageID
          );
        if (banUsers.includes(command.config.name))
          return api.sendMessage(
            global.getText(
              "handleCommand",
              "commandUserBanned",
              command.config.name
            ),
            threadID,
            async (err, info) => {
              if (err || !info) return;
              await new Promise((resolve) => setTimeout(resolve, 5 * 1000));
              return api.unsendMessage(info.messageID);
            },
            messageID
          );
      }
    }
    // [FIX Djamel] — guard commandCategory: some commands omit it, causing crash
    if (
      (command.config.commandCategory || "").toLowerCase() == "nsfw" &&
      !global.data.threadAllowNSFW.includes(threadID) &&
      !ADMINBOT.includes(senderID)
    )
      return api.sendMessage(
        global.getText("handleCommand", "threadNotAllowNSFW"),
        threadID,
        async (err, info) => {
          if (err || !info) return;
          await new Promise((resolve) => setTimeout(resolve, 5 * 1000));
          return api.unsendMessage(info.messageID);
        },
        messageID
      );
    var threadInfo2;
    try {
      threadInfo2 = threadInfo.get(threadID) || (await Threads.getInfo(threadID));
      if (!threadInfo2 || Object.keys(threadInfo2).length == 0) threadInfo2 = null;
    } catch (err) {
      threadInfo2 = null;
    }
    var permssion = 0;
    const adminIDs = (threadInfo2 && Array.isArray(threadInfo2.adminIDs)) ? threadInfo2.adminIDs : [];
    const find = adminIDs.find((el) => el.id == senderID);
    if (ADMINBOT.includes(String(senderID))) permssion = 2;
    else if (!ADMINBOT.includes(senderID) && find) permssion = 1;
    if (command.config.hasPermssion > permssion)
      // [FIX Djamel] — original passed `event.messageID` in the callback slot,
      // so the reply-context was silently lost (and on stricter FCAs throws
      // because it tries to invoke a string as a function). Pass `undefined`
      // for the callback and `event.messageID` as the replyToMessageID arg.
      return api.sendMessage(
        global.getText(
          "handleCommand",
          "permssionNotEnough",
          command.config.name
        ),
        event.threadID,
        undefined,
        event.messageID
      );
    // ── [FIX] use destructured `cooldowns` (line 26) — `client` is undefined here ──
    if (!cooldowns.has(command.config.name))
      cooldowns.set(command.config.name, new Map());
    const timestamps = cooldowns.get(command.config.name);
    const expirationTime = (command.config.cooldowns || 1) * 1000;
    if (
      timestamps.has(senderID) &&
      dateNow < timestamps.get(senderID) + expirationTime
    )
      return api.setMessageReaction(
        "😼",
        event.messageID,
        (err) =>
          err
            ? logger("حدث خطأ أثناء تنفيذ setMessageReaction", "warn")
            : "",
        !![]
      );
    // [FIX Djamel] — set cooldown BEFORE invoking command.run(). Async
    // commands previously left a window between dispatch and timestamps.set
    // during which a spamming user could fire the same command 5-10 times
    // (every concurrent invocation passes the gate, then races for state).
    // Setting the timestamp up-front gives strict serialisation and stops
    // bursty per-user fan-out — a major load+ban reducer.
    timestamps.set(senderID, dateNow);
    var getText2;
    if (
      command.languages &&
      typeof command.languages == "object" &&
      command.languages.hasOwnProperty(global.config.language)
    )
      getText2 = (...values) => {
        var lang = command.languages[global.config.language][values[0]] || "";
        for (var i = values.length - 1; i > 0; i--) {
          lang = lang.replace(new RegExp("%" + i, "g"), values[i]);
        }
        return lang;
      };
    else getText2 = () => {};
    try {
      const Obj = {};

      // ── Wrap api.sendMessage: log + humanTyping + silent mode ───
      const _origSend = api.sendMessage.bind(api);
      const _loggingApi = Object.assign(Object.create(api), {
        sendMessage: async function (msg, tid, ...rest) {
          const preview = (() => {
            try {
              return typeof msg === "string" ? msg : (msg && msg.body ? msg.body : JSON.stringify(msg));
            } catch (_) { return ''; }
          })();

          // ── Silent mode: log to console only, never send to Messenger ──
          if (global._silentMode) {
            console.log(
              chalk.bold.hex("#888888")("[SILENT] ") +
              chalk.hex("#aaaaaa")("[" + commandName + "] ") +
              chalk.hex("#ffaa00")("[" + String(tid || threadID) + "] → ") +
              chalk.hex("#cccccc")(preview.slice(0, 500))
            );
            const cb = rest.find(x => typeof x === 'function');
            if (cb) cb(null, { messageID: 'silent-' + Date.now() });
            return Promise.resolve({ messageID: 'silent-' + Date.now() });
          }

          console.log(
            chalk.bold.hex("#ffaa00")("[CMD REPLY] ") +
            chalk.hex("#aaaaaa")("[" + commandName + "] → ") +
            chalk.hex("#ffffff")(preview.slice(0, 300))
          );
          if (!api.__nkxModernized && humanTyping) {
            const delay = humanTyping.calcDelay(msg);
            if (delay > 0) await humanTyping.simulateTyping(api, tid || threadID, delay);
          }
          return _origSend(msg, tid, ...rest);
        }
      });

      // ── Log the detected command ─────────────────────────────
      console.log(
        chalk.bold.hex("#ff66ff")("[CMD] ") +
        chalk.hex("#aaaaaa")("by " + (global.data.userName.get(senderID) || senderID)) +
        (global.config.ADMINBOT && global.config.ADMINBOT.map(String).includes(senderID)
          ? chalk.bold.hex("#ff4444")(" [BOT ADMIN]") : "") +
        chalk.hex("#ffffff")(" → ") +
        chalk.bold.hex("#ffff00")(commandName) +
        (args.length ? chalk.hex("#cccccc")(" " + args.join(" ")) : "")
      );

      Obj.api = _loggingApi;
      Obj.event = event;
      Obj.args = args;
      Obj.models = models;
      Obj.usersData = usersData;
      Obj.threadsData = threadsData;
      Obj.globalData = globalData;
      Obj.Users = Users;
      Obj.message = message;
      Obj.Threads = Threads;
      Obj.Currencies = Currencies;
      Obj.permssion = permssion;
      Obj.getText = getText2;
      // [FIX L1] — wrap in Promise.resolve().then() so BOTH synchronous throws
      // AND async rejections from command.run() are caught by the same .catch().
      // [PROTECT] commandSandbox enforces a 30s wall-clock timeout so a hung
      // command can never freeze the listener; commandErrorBudget tallies any
      // rejection so a chronically-broken command auto-disables for 1h.
      try { require("../liveStats").trackCommandByName(commandName); } catch (_) {}
      // Pass per-command timeout from cmd.config.timeout if set (upgrade #2)
      const _cmdTimeout = (command.config && typeof command.config.timeout === 'number' && command.config.timeout > 0)
        ? command.config.timeout : undefined;
      const _runPromise = _sandbox
        ? _sandbox.runWithTimeout(() => command.run(Obj), 'cmd:' + commandName, _cmdTimeout)
        : Promise.resolve().then(() => command.run(Obj));
      _runPromise.catch(e => {
        logger.log([
          { message: '[ CMD-PROMISE ]: ', color: ['red', 'cyan'] },
          { message: `Unhandled rejection in command "${commandName}": ${e && e.message ? e.message : String(e)}`, color: 'white' }
        ]);
        try { if (_errBudget) _errBudget.record(command.config.name, e); } catch (_) {}
      });
      // [FIX Djamel] — cooldown now set BEFORE command.run (above), so
      // we don't double-write here. Kept the comment for future readers.
      if (DeveloperMode == !![])
        logger(
          global.getText(
            "handleCommand",
            "executeCommand",
            time,
            commandName,
            senderID,
            threadID,
            args.join(" "),
            Date.now() - dateNow
          ),
          "[ DEV MODE ]"
        );
      return;
    } catch (e) {
      return api.sendMessage(
        global.getText("handleCommand", "commandError", commandName, e),
        threadID
      );
    }
  };
};
