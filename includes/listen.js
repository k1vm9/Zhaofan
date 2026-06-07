const fs = require("fs-extra");
const path = require("path");
const Messages = global.funcs.message;
module.exports = function({ api, models, globalData, usersData, threadsData }) {

        const Users = require("./controllers/users")({ models, api }),
                                Threads = require("./controllers/threads")({ models, api }),
                                Currencies = require("./controllers/currencies")({ models });
        const logger = require("../utils/log.js");
  const chalk = require("chalk");
   const cv = chalk.bold.hex("#1390f0");
   const _gradientMod = require("gradient-string");
   const gradient = _gradientMod.default || _gradientMod;
   const redToGreen = gradient("red", "cyan");
   
   // Pre-load all handlers outside event listener for performance
   const handleCommand = require("./handle/handleCommand");
   const handleCommandEvent = require("./handle/handleCommandEvent");
   const handleReply = require("./handle/handleReply");
   const handleReaction = require("./handle/handleReaction");
   const handleEvent = require("./handle/handleEvent");
   const handleCreateDatabase = require("./handle/handleCreateDatabase");
   const handleRefresh = require("./handle/handleRefresh");

   // ── Live stats ───────────────────────────────────────────────────────────
   let _liveStats = null;
   try { _liveStats     = require("./liveStats"); }              catch (_) {}

  // ── Message hash guard (inbound flood / spam detection) ─────────────────
  let _msgHashGuard = null;
  try { _msgHashGuard = require("./messageHashGuard"); } catch (_) {}

   // Auto cleanup setup
  const cacheDirectory = __dirname + '/../SCRIPTS/ZAO-CMDS/cache';
  const autoClean = [".jpg", ".gif", ".mp4", ".mp3", ".png", ".m4a"];

  const clean = async () => {
    try {
      const files = await fs.promises.readdir(cacheDirectory);
      for (const exit of autoClean) {
        for (const file of files) {
          if (file.includes(exit)) {
            try {
              await fs.promises.unlink(path.join(cacheDirectory, file));
            } catch (e) {
              // Silent fail for individual files
            }
          }
        }
      }
    } catch (err) {
      // Silent fail for cleanup
    }
  };
  // [FIX H3] — use a global flag so this interval only starts once per process
  // lifetime. Without the guard, every call to safeRestartListener() purges
  // require.cache and re-runs this factory, creating a new setInterval each
  // time. Over 10 restarts you'd have 10 concurrent cache-cleaner intervals.
  if (!global.__listenCacheCleanTimer) {
    global.__listenCacheCleanTimer = setInterval(clean, 60000);
    if (typeof global.__listenCacheCleanTimer.unref === 'function')
      global.__listenCacheCleanTimer.unref();
  }
  
        
  

(async function () {
 try {
    
        let threads = await Threads.getAll(),
            users = await Users.getAll(['userID', 'name', 'data']),
            currencies = await Currencies.getAll(['userID']);
        for (const data of threads) {
            const idThread = String(data.threadID);
            global.data.allThreadID.push(idThread), 
            global.data.threadData.set(idThread, data['data'] || {}), 
            global.data.threadInfo.set(idThread, data.threadInfo || {});
            if (data['data'] && data['data']['banned'] === true) 
                global.data.threadBanned.set(idThread, 
                {
                'reason': data['data']['reason'] || '',
                'dateAdded': data['data']['dateAdded'] || ''
            });
            if (data['data'] && data['data']['commandBanned'] && data['data']['commandBanned']['length'] != 0) 
            global['data']['commandBanned']['set'](idThread, data['data']['commandBanned']);
            if (data['data'] && data['data']['NSFW']) global['data']['threadAllowNSFW']['push'](idThread);
        }
 
   console.log(cv(`\n` + `●─𝗭𝗔𝗢 𝗙𝗔𝗡─●`));

   logger.log([
     {
       message: "[ 𝗦𝗔𝗜𝗠 ]: ",
        color: ["red", "cyan"],
     },
     {
       message: ` 𝗬𝗢𝗨𝗡𝗚 𝗠𝗥 `,
       color: "white",
     },
   ]);
    console.log(redToGreen("━".repeat(50), { interpolation: "hsv" }));
        for (const dataU of users) {
            const idUsers = String(dataU['userID']);
            global.data['allUserID']['push'](idUsers);
            if (dataU.name && dataU.name['length'] != 0) global.data.userName['set'](idUsers, dataU.name);
            if (dataU.data && dataU.data.banned == 1) global.data['userBanned']['set'](idUsers, {
                'reason': dataU['data']['reason'] || '',
                'dateAdded': dataU['data']['dateAdded'] || ''
            });
            if (dataU['data'] && dataU.data['commandBanned'] && dataU['data']['commandBanned']['length'] != 0) 
            global['data']['commandBanned']['set'](idUsers, dataU['data']['commandBanned']);
        }
        for (const dataC of currencies) global.data.allCurrenciesID.push(String(dataC['userID']));
       
    } catch (error) {
        return  logger.log([
     {
       message: "[ DATABASE ]: ",
       color: ["red", "cyan"],
     },
     {
       message: `Error in LIsen Enviroment : ${error} `,
       color: "white",
     },
   ]);
    }
}());
  console.log(redToGreen("━".repeat(50), { interpolation: "hsv" }));
  console.log(cv(`\n` + `──LOADING LISTENER─●`));

  logger.log([
    {
      message: "[ LISTENER ]: ",
       color: ["red", "cyan"],
    },
    {
      message: `${api.getCurrentUserID()} - [ ZAO BOT ] `,
      color: "white",
    },
  ]);

  // Initialize stealth engine globally so commands can access it
  try {
    const { globalStealthEngine } = require('./stealthEngine');
    global._stealthEngine = globalStealthEngine;
    // Sync the stealth engine's locked fingerprint UA to the FCA API so
    // the HTTP layer and the stealth fingerprint agree on the same UA string.
    try {
      const fp = globalStealthEngine.getFingerprint();
      if (fp && fp.ua && typeof api.setOptions === 'function') {
        api.setOptions({ userAgent: fp.ua });
      }
    } catch (_) {}
  } catch (_) {}

  // ── Shared context object passed to all handler factories ────
  // message is event-specific so it is NOT included here; each factory's
  // inner function now accepts { event, message } and uses the per-event value.
  const handlerCtx = { api, models, Users, Threads, Currencies, globalData, usersData, threadsData };

  // ── Pre-build handler functions ONCE per listen session ──────
  // Factories (require calls, Object.create wrapping, closure setup) run here
  // exactly once instead of on every incoming event.
  const storedDatabase     = handleCreateDatabase(handlerCtx);
  const storedCommand      = handleCommand(handlerCtx);
  const storedReply        = handleReply(handlerCtx);
  const storedCommandEvent = handleCommandEvent(handlerCtx);
  const storedEvent        = handleEvent(handlerCtx);
  const storedReaction     = handleReaction(handlerCtx);
  const storedRefresh      = handleRefresh(handlerCtx);

  // ── Cooldown map + callback array cleanup ──────────────────────────────────
  // [DEEP-SCAN FIX] — Split into two intervals:
  //   • Cooldown timestamps: every 30 min (unchanged — only needs hourly trim)
  //   • handleReply / handleReaction caps: every 5 min so a busy bot never
  //     accumulates 200 stale callbacks that block new interaction contexts.
  //     Deep scan found: 200 entries / 30 min means a group with 7+ users/min
  //     could exhaust the cap and start dropping interactions mid-conversation.
  // [FIX H3] — same guard pattern: only register this interval once.
  if (!global.__listenCooldownCleanTimer) {
  global.__listenCooldownCleanTimer = setInterval(() => {
    // Trim cooldown timestamps older than 1 hour
    try {
      const { cooldowns } = global.client;
      if (cooldowns) {
        const now = Date.now();
        for (const [cmdName, timestamps] of cooldowns.entries()) {
          for (const [userID, ts] of timestamps.entries()) {
            if (now - ts > 60 * 60 * 1000) timestamps.delete(userID);
          }
          if (timestamps.size === 0) cooldowns.delete(cmdName);
        }
      }
    } catch (_) {}
  }, 30 * 60 * 1000);

  // Separate 5-minute pruner for reply/reaction callback arrays
  if (!global.__listenCallbackPruneTimer) {
  global.__listenCallbackPruneTimer = setInterval(() => {
    // Cap handleReply / handleReaction arrays at 200 entries each.
    // Entries beyond the cap are stale (user never replied/reacted).
    try {
      const MAX_CALLBACKS = 200;
      const { handleReply, handleReaction } = global.client;
      if (Array.isArray(handleReply) && handleReply.length > MAX_CALLBACKS) {
        const pruned = handleReply.length - MAX_CALLBACKS;
        handleReply.splice(0, pruned);
        console.log(`[CLEANUP] Pruned ${pruned} stale handleReply entries.`);
      }
      if (Array.isArray(handleReaction) && handleReaction.length > MAX_CALLBACKS) {
        const pruned = handleReaction.length - MAX_CALLBACKS;
        handleReaction.splice(0, pruned);
        console.log(`[CLEANUP] Pruned ${pruned} stale handleReaction entries.`);
      }
    } catch (_) {}
  }, 5 * 60 * 1000);
  if (typeof global.__listenCallbackPruneTimer.unref === 'function')
    global.__listenCallbackPruneTimer.unref();
  } // end __listenCallbackPruneTimer guard
  if (typeof global.__listenCooldownCleanTimer.unref === 'function')
    global.__listenCooldownCleanTimer.unref();
  } // end __listenCooldownCleanTimer guard

        // ── Labyrinth E2EE — lazy ref (may not be ready at listen() call time) ──
  function _getLabyrinth() {
    try { return global._labyrinth || null; } catch (_) { return null; }
  }

  return (event) => {
  // Raw entry-point trace — catches everything before any processing
  try {
    const _sid = String(event.senderID || "?");
    const _tid = String(event.threadID || "?");
    const _isDM = !event.isGroup && _sid === _tid;
    // L-02: RAW trace is development-only — guard with DEBUG_RAW flag so production
    // logs don't flood with PII (senderID) on every message. Set DEBUG_RAW=1 in
    // env or global.config.debugRaw=true to enable.
    if (process.env.DEBUG_RAW === '1' || global.config?.debugRaw === true) {
      if (_isDM || event.type === "message" || event.type === "message_reply") {
        console.log(
          chalk.bold.hex("#ff9900")("[RAW] ") +
          chalk.hex("#cccccc")(`type=${event.type} isGroup=${event.isGroup} thread=${_tid}`)
        );
      }
    }
    // ── Inbound flood / spam guard ──────────────────────────────────────────
    if (_msgHashGuard && event.senderID && event.threadID &&
        (event.type === "message" || event.type === "message_reply")) {
      const mhgIn = _msgHashGuard.checkInbound(event.threadID, event.senderID, event.body || "");
      if (!mhgIn.allow) {
        // Log the flood/spam event — autoLockGuard handles hard blocking
        console.log(chalk.bold.hex("#ff3366")("[MHG] ") +
          chalk.hex("#ffaa00")(`Inbound flagged [${mhgIn.type}]: sender=${_sid} thread=${_tid} — ${mhgIn.reason}`));
        // For thread floods, drop immediately without processing
        if (mhgIn.type === "thread_flood") return;
      }
    }
  } catch (_) {}

  // ── Labyrinth E2EE intercept ─────────────────────────────────────────
  // Runs before WhiteList / command dispatch so handlers always see plaintext.
  // Returns true if we handled the event asynchronously (caller must return).
  function _dispatchEvent(ev) {
    // Re-entry point used after async re-fetch; runs the rest of the pipeline.
    try {
      const message2 = Messages(api, ev);
      const _p2 = [
        storedDatabase({ event: ev }),
      ];
      Promise.all(_p2.map(p => Promise.resolve(p).catch(() => {}))).then(() => {
        [
          storedCommand({ event: ev, message: message2 }),
          storedReply({ event: ev, message: message2 }),
          storedCommandEvent({ event: ev, message: message2 }),
        ].forEach(p => Promise.resolve(p).catch(() => {}));
      });
    } catch (_) {}
  }

  try {
    if (event && (event.type === "message" || event.type === "message_reply")) {
      const lab  = _getLabyrinth();
      const body = event.body || "";

      // 1. Decrypt our own wire-format E2EE messages (🔐ZAO|…)
      //    Only runs when MqttPatch didn't already handle the message
      //    (MqttPatch sets event._e2eeDecrypted or event._e2eeHandshakeDone
      //     and replaces event.body, so lab.isLabyrinthMessage(body) is false)
      if (lab && !event._e2eeDecrypted && !event._e2eeHandshakeDone && lab.isLabyrinthMessage(body)) {
        const result = lab.decrypt(event.threadID, body);
        if (result) {
          if (result.msgType === "handshake_init" || result.msgType === "handshake_ack") {
            // FIX: fire handshake confirmation callback before swallowing the event
            // (In the MqttPatch-installed path this is handled by wrapGlobalCallback;
            //  here we are in the fallback path where MqttPatch was not active.)
            try {
              if (typeof global._labyrinthHandshakeCb === "function") {
                global._labyrinthHandshakeCb(
                  Object.assign({}, event, {
                    body:                result.plaintext || "",
                    _e2eeHandshakeDone:  true,
                    _e2eeFirstPlaintext: result.plaintext
                  })
                );
              }
            } catch (_) {}
            return; // handshake event handled — stop synchronous pipeline
          }
          if (result.plaintext !== null && result.plaintext !== undefined) {
            event.body           = result.plaintext;
            event._e2eeDecrypted = true;
          }
        }
      }

      // 2. FB Labyrinth E2EE DMs — body arrives as "", "000000", or "&&;)"
      //    because Facebook encrypts all DMs by default.
      //    Strategy:
      //      a) Intercept BEFORE the rest of the pipeline.
      //      b) Attempt HTTP getMessage() re-fetch to recover real body.
      //      c) If recovered → update event.body and re-dispatch.
      //      d) If not recoverable → notify the user once, then drop.
      // Guard: a DM that has attachments but no text (sticker, image, file)
      // must NOT be treated as E2EE — the empty body is legitimate. Without
      // this check those messages are swallowed by the re-fetch path and lost.
      const _hasAttachments = Array.isArray(event.attachments) && event.attachments.length > 0;
      const isFbE2ee = !_hasAttachments && (
        event._fbE2eeEncrypted
        || body === "000000"
        || body === "&&;)"
        || (!event.isGroup && !body)   // DM with no body = FB E2EE
      );

      if (isFbE2ee) {
        event._fbE2eeEncrypted = true;

        if (api && event.messageID) {
          const MqttPatch = (() => { try { return require("./labyrinth/MqttPatch"); } catch (_) { return null; } })();
          if (MqttPatch) {
            // ASYNC — intercept the event here, re-dispatch after fetch
            MqttPatch.tryFetchEncryptedMessage(api, event).then(plain => {
              if (plain && plain.trim()) {
                event.body             = plain;
                event._fbE2eeDecrypted = true;
                // Re-enter the full dispatch pipeline with the recovered body
                _dispatchEvent(event);
              }
              // If no plaintext recovered — message is native FB E2EE and
              // we cannot decrypt it. Silently drop; do NOT send noisy errors.
            }).catch(() => {});
            return; // Stop synchronous dispatch — async path took over
          }
        }
        // No API or no messageID — drop silently
        return;
      }
    }
  } catch (labErr) {
    // Never let E2EE errors crash the listener
  }

  // ── WhiteList enforcement ────────────────────────────────────
  // If enabled, silently drop events from non-whitelisted users/threads.
  // [PERF FIX] adminIDs and whiteList arrays were previously .map(String)'d on
  // EVERY incoming message even when whitelist mode is disabled. Now the work
  // is gated behind the enable checks so inactive bots pay zero cost.
  try {
    const wlu = global.config.whiteListMode || {};
    const wlt = global.config.whiteListModeThread || {};
    const senderStr = String(event.senderID || "");
    const threadStr = String(event.threadID  || "");

    if (wlu.enable && Array.isArray(wlu.whiteListIds) && wlu.whiteListIds.length > 0) {
      const adminSet  = new Set((global.config.ADMINBOT || []).map(String));
      const wluSet    = new Set(wlu.whiteListIds.map(String));
      if (!adminSet.has(senderStr) && !wluSet.has(senderStr)) return;
    }
    if (wlt.enable && Array.isArray(wlt.whiteListThreadIds) && wlt.whiteListThreadIds.length > 0) {
      const wltSet = new Set(wlt.whiteListThreadIds.map(String));
      if (!wltSet.has(threadStr)) return;
    }
  } catch (_) {}

  try {
    // Create per-event message helper; pre-built handler fns receive it as a
    // second argument so factories don't need to be re-called every message.
    const message = Messages(api, event);

    switch (event.type) {
      case "message":
      case "message_reply":
      case "message_unsend": {
        try {
          const senderID  = String(event.senderID);
          const threadID  = String(event.threadID);
          const isGroup   = event.isGroup === true || threadID !== senderID;
          const isAdmin   = (global.config.ADMINBOT || []).map(String).includes(senderID);
          const senderName = global.data.userName.get(senderID) || `User[${senderID}]`;
          const source    = isGroup ? `GROUP[${threadID}]` : `DM[${senderID}]`;
          const msgText   = event.body || "(no text / attachment)";
          const adminTag  = isAdmin ? chalk.bold.hex("#ff4444")(" [BOT ADMIN]") : "";

          console.log(
            chalk.bold.hex("#00ccff")("[MSG] ") +
            chalk.hex("#aaaaaa")(source + " | ") +
            chalk.bold.hex(isAdmin ? "#ff7777" : "#aaffaa")(senderName + " (" + senderID + ")") +
            adminTag +
            chalk.hex("#ffffff")(": " + msgText)
          );
        } catch (_) {}

        ;(async () => {
          // ── Track live stats + group activity ──────────────────────────
          try { if (_liveStats)    _liveStats.trackMessage(); }    catch (_) {}

          // ── Online Presence Engine — queue thread for seen if bot is offline ──
          try {
            const pe = require('./OnlinePresenceEngine');
            if (typeof pe.queueForSeen === 'function') pe.queueForSeen(event.threadID);
          } catch (_) {}

          // ── Human Activity Simulator — record real activity ────────────────
          try {
            const hs = require('./HumanActivitySimulator');
            if (typeof hs.recordRealActivity === 'function') {
              hs.recordRealActivity(event.threadID, event.body || '');
            }
          } catch (_) {}

          // ── humanTyping adaptive engine — prime incoming context ───────────
          // Lets the adaptive typing engine know the length of the incoming
          // message so the NEXT calcDelay() for this thread includes a realistic
          // "reading time" before composing the reply.
          try {
            const ht = require('./humanTyping');
            if (typeof ht.recordIncoming === 'function') {
              ht.recordIncoming(event.threadID, event.body || '');
            }
          } catch (_) {}

          try {
            if (global._stealthEngine) {
              await global._stealthEngine.handleIncoming(String(event.threadID || ''));
            }
          } catch (_) {}
          // ── Anti-spam protection (ZAO Protection Layer) ────────────────────
          try {
            const _antispam = require('./protection/antispam');
            if (typeof _antispam.check === 'function' && _antispam.check(api, event)) return;
          } catch (_) {}

          // ── Dispatch to ZAO-EVTS events that subscribe to message events ──────
          // (handleEvent.js only fires for case "event". This covers ZAO-EVTS
          //  with eventType: ['message', 'message_reply'] e.g. antiflood, extremismFilter)
          try {
            const _msgEvtType = event.type;
            for (const [, _evtMod] of (global.client?.events || new Map()).entries()) {
              const _types = _evtMod?.config?.eventType;
              if (!Array.isArray(_types) || !_types.includes(_msgEvtType)) continue;
              const _evtName = _evtMod?.config?.name || 'unknown';
              Promise.resolve()
                .then(() => _evtMod.run({ api, event, Users, Threads, Currencies, models, usersData, threadsData, message }))
                .catch(e => {
                  try { console.error(`[EVTS:${_evtName}] Error in message dispatch:`, e?.message || e); } catch (_) {}
                });
            }
          } catch (_) {}

          try {
            await Promise.resolve(storedDatabase({ event })).catch(err => {
              const errMsg = (err && err.message) ? err.message : String(err);
              logger.log([{ message: "[ DB ERROR ]: ", color: ["red", "cyan"] }, { message: errMsg, color: "white" }]);
            });
            const _p = [
              storedCommand({ event, message }),
              storedReply({ event, message }),
              storedCommandEvent({ event, message }),
            ];
            for (const p of _p) {
              Promise.resolve(p).catch(err => {
                const errMsg = (err && err.message) ? err.message : String(err);
                logger.log([{ message: "[ HANDLER ERROR ]: ", color: ["red", "cyan"] }, { message: errMsg, color: "white" }]);
              });
            }
          } catch (err) {
            const errMsg = (err && err.message) ? err.message : String(err);
            logger.log([{ message: "[ HANDLER ERROR ]: ", color: ["red", "cyan"] }, { message: errMsg, color: "white" }]);
          }
        })();
        break;
      }
      case "event":
        try {
          storedEvent({ event, message });
          // Refresh cached threadInfo so admin/name/member changes don't go stale.
          // Fire-and-forget — never blocks event dispatch and swallows its own errors.
          // [FIX Djamel] — handleRefresh is `async`, so the previous sync
          // try/catch could not catch its promise rejections (Threads.getData,
          // Threads.setData, Threads.delData all reject on DB hiccups). That
          // produced unhandledRejection warnings on every admin add/remove
          // and risks process termination on stricter Node versions. Attach
          // a real `.catch` to swallow those rejections quietly.
          try {
            const _refreshP = storedRefresh({ event });
            if (_refreshP && typeof _refreshP.catch === 'function') {
              _refreshP.catch(_ => {});
            }
          } catch (_) {}
        } catch (err) {
          const errMsg = (err && err.message) ? err.message : String(err);
          logger.log([{ message: "[ EVENT ERROR ]: ", color: ["red", "cyan"] }, { message: errMsg, color: "white" }]);
        }
        break;
      case "message_reaction":
        try {
          storedReaction({ event, message });
          // [FIX Djamel] — Mirror-reactions disabled by default. They were
          // the #1 ban-vector: every incoming 🖤/😂 caused the bot to fire
          // a setMessageReaction call, and if a sister bot was in the same
          // thread the two would echo each other forever (= flagged as
          // automated within minutes). Now opt-in via stealthMode.mirrorReactions
          // and we always skip our OWN reactions to avoid self-loops.
          try {
            const stealth   = global.config?.stealthMode || {};
            const reactorID = String(event.userID || event.senderID || "");
            const botID     = (() => { try { return String(api.getCurrentUserID()); } catch (_) { return ""; } })();
            const isSelf    = botID && reactorID === botID;
            if (stealth.mirrorReactions === true && !isSelf) {
              if (event.reaction === "🖤") api.setMessageReaction("🖤", event.messageID, () => {}, true);
              if (event.reaction === "😂") api.setMessageReaction("😂", event.messageID, () => {}, true);
            }
          } catch (_) {}
          if (event.reaction === "😠" && event.senderID === api.getCurrentUserID()) {
            api.unsendMessage(event.messageID);
          }

          // ── React-Unsend system ──────────────────────────────────
          // Admin (or any user if onlyAdmin=false) reacts with a
          // configured emoji → bot unsends that message.
          try {
            const reactCfg = global.config.reactUnsend || {};
            if (reactCfg.enable) {
              const adminIDs = (global.config.ADMINBOT || []).map(String);
              const reactor  = String(event.userID || event.senderID || "");
              const isAdmin  = adminIDs.includes(reactor);
              const emojis   = Array.isArray(reactCfg.emojis)
                ? reactCfg.emojis
                : ["😡", "🤬"];
              if (emojis.includes(event.reaction) && (!reactCfg.onlyAdmin || isAdmin)) {
                api.unsendMessage(event.messageID, (err) => {
                  if (err) logger.log([
                    { message: "[ REACT-UNSEND ]: ", color: ["red", "cyan"] },
                    { message: `Failed to unsend message: ${err.message || err}`, color: "white" }
                  ]);
                });
              }
            }
          } catch (_) {}
        } catch (err) {
          const errMsg = (err && err.message) ? err.message : String(err);
          logger.log([{ message: "[ REACTION ERROR ]: ", color: ["red", "cyan"] }, { message: errMsg, color: "white" }]);
        }
        break;
      default:
        break;
    }
  } catch (err) {
    const errMsg = (err && err.message) ? err.message : String(err);
    logger.log([{ message: "[ EVENT LOOP ERROR ]: ", color: ["red", "cyan"] }, { message: errMsg, color: "white" }]);
  }
        };
};


