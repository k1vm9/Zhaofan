/**
 * handleEvent.js
 * Dispatches system (log:*) events to ZAO-EVTS handlers
 * and fires handleEvent hooks on registered commands.
 *
 * @debugger Djamel — Added event.type to the Obj passed to cmd.handleEvent,
 *   so commands can guard against non-message events without crashing.
 */

module.exports = function ({ api, models, Users, Threads, Currencies, globalData, usersData, threadsData, message }) {
  const logger = require("../../utils/log.js");
  const moment = require("moment");
  // [PROTECT] sandbox event handlers with a 15s wall-clock timeout so a
  // misbehaving handleEvent in any command can't freeze the listener.
  const _sandbox = (() => { try { return require("../commandSandbox"); } catch (_) { return null; } })();
  const EVENT_TIMEOUT_MS = 15 * 1000;

  return function ({ event, message: _message }) {
    const message = _message;
    const timeStart = Date.now();
    const time = moment.tz("Asia/Manila").format("HH:mm:ss L");
    const { userBanned, threadBanned } = global.data;
    const { events, commands, eventRegistered } = global.client;
    const { allowInbox, DeveloperMode } = global.config;
    const senderID = String(event.senderID || "");
    const threadID = String(event.threadID || "");

    if (userBanned.has(senderID) || threadBanned.has(threadID)) return;
    if (allowInbox == false && senderID === threadID) return;
    // [PROTECT] graceful-shutdown drain — accept no new event work once draining.
    if (global.__draining === true) return;

    const eventType = event.logMessageType;

    // ── Dispatch to ZAO-EVTS events ──────────────────────────
    if (eventType) {
      for (const [key, value] of events.entries()) {
        if (!value.config?.eventType) continue;
        if (!value.config.eventType.includes(eventType)) continue;

        const eventRun = events.get(key);
        try {
          const Obj = {
            api,
            message,
            event,
            models,
            usersData,
            threadsData,
            Users,
            Threads,
            Currencies
          };
          const evtRunPromise = _sandbox
            ? _sandbox.runWithTimeout(() => eventRun.run(Obj), 'evt:' + (eventRun?.config?.name || key), EVENT_TIMEOUT_MS)
            : Promise.resolve().then(() => eventRun.run(Obj));
          evtRunPromise.catch(error => {
            logger(
              global.getText("handleEvent", "eventError", eventRun?.config?.name, String(error?.message || error)),
              "error"
            );
          });
          if (DeveloperMode == true) {
            logger(
              global.getText("handleEvent", "executeEvent", time, eventRun.config.name, threadID, Date.now() - timeStart),
              "[ Event ]"
            );
          }
        } catch (error) {
          logger(
            global.getText("handleEvent", "eventError", eventRun?.config?.name, String(error?.message || error)),
            "error"
          );
        }
      }
    }

    // ── Dispatch to commands that have handleEvent hooks ──────
    // This fixes the critical bug: commands like تكرار register a
    // handleEvent that needs to fire on group events (log:thread-name etc.)
    // but handleCommandEvent only runs for message-type events.
    if (Array.isArray(eventRegistered)) {
      for (const cmdName of eventRegistered) {
        const cmd = commands.get(cmdName);
        if (!cmd || typeof cmd.handleEvent !== "function") continue;

        try {
          const Obj = {
            api,
            event,
            models,
            Users,
            Threads,
            Currencies,
            usersData,
            threadsData,
            message,
            getText: (() => {
              if (cmd.languages && typeof cmd.languages === "object") {
                return (...values) => {
                  const lang = (cmd.languages[global.config.language]) || {};
                  let text = lang[values[0]] || "";
                  for (let i = values.length - 1; i > 0; i--) {
                    text = text.replace(new RegExp("%" + i, "g"), values[i]);
                  }
                  return text;
                };
              }
              return () => {};
            })()
          };
          const result = _sandbox
            ? _sandbox.runWithTimeout(() => cmd.handleEvent(Obj), 'cmdEvt:' + cmdName, EVENT_TIMEOUT_MS)
            : Promise.resolve().then(() => cmd.handleEvent(Obj));
          result.catch(err => {
            console.error("[handleEvent→cmd.handleEvent] Error in", cmdName, err?.message || err);
          });
        } catch (err) {
          console.error("[handleEvent→cmd.handleEvent] Sync error in", cmdName, err?.message || err);
        }
      }
    }
  };
};
