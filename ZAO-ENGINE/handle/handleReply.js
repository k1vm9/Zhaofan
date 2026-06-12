module.exports = function ({ api, models, Users, Threads, Currencies, globalData, usersData, threadsData, message }) {
  const humanTyping = (() => { try { return require("../humanTyping"); } catch (_) { return null; } })();
  // [PROTECT] sandbox + per-command error budget
  const _sandbox   = (() => { try { return require("../commandSandbox");     } catch (_) { return null; } })();
  const _errBudget = (() => { try { return require("../commandErrorBudget"); } catch (_) { return null; } })();

  return function ({ event, message: _message }) {
    const message = _message;
    if (!event.messageReply) return;
    // [PROTECT] graceful-shutdown drain — accept no new replies once draining.
    if (global.__draining === true) return;
    const { handleReply, commands } = global.client;
    const { messageID, threadID, messageReply } = event;
    if (!handleReply || handleReply.length === 0) return;

    const indexOfHandle = handleReply.findIndex(e => e.messageID == messageReply.messageID);
    if (indexOfHandle < 0) return;

    const indexOfMessage = handleReply[indexOfHandle];

    // ── CRITICAL FIX: Remove the entry BEFORE executing so it fires only once
    // and cannot accumulate in memory if a command never cleans up after itself.
    handleReply.splice(indexOfHandle, 1);

    const handleNeedExec = commands.get(indexOfMessage.name);
    if (!handleNeedExec) return api.sendMessage(global.getText('handleReply', 'missingValue'), threadID, messageID);

    // ── Guard: command exists but no handleReply method ──────────
    if (typeof handleNeedExec.handleReply !== 'function') {
      console.error('[handleReply] Command "' + indexOfMessage.name + '" has no handleReply function.');
      return;
    }

    try {
      var getText2;
      if (handleNeedExec.languages && typeof handleNeedExec.languages == 'object') {
        getText2 = (...value) => {
          const reply = handleNeedExec.languages || {};
          if (!reply.hasOwnProperty(global.config.language)) return '';
          var lang = handleNeedExec.languages[global.config.language][value[0]] || '';
          for (var i = value.length - 1; i > 0; i--) {
            lang = lang.replace(new RegExp('%' + i, 'g'), value[i]);
          }
          return lang;
        };
      } else {
        getText2 = () => {};
      }

      const _origSend = api.sendMessage.bind(api);
      const _wrappedApi = Object.assign(Object.create(api), {
        sendMessage: async function (msg, tid, ...rest) {
          if (humanTyping) {
            const delay = humanTyping.calcDelay(msg);
            if (delay > 0) await humanTyping.simulateTyping(api, tid || threadID, delay);
          }
          return _origSend(msg, tid, ...rest);
        }
      });

      const Obj = {
        api: _wrappedApi,
        event,
        models,
        Users,
        Threads,
        Currencies,
        message,
        usersData,
        threadsData,
        handleReply: indexOfMessage,
        getText: getText2
      };
      // [PROTECT] sandbox handleReply with a 30s wall-clock timeout and
      // funnel any rejection into the per-command error budget so a chronically
      // broken reply handler auto-disables for 1h.
      const _name = indexOfMessage?.name || '<unknown>';
      const _replyPromise = _sandbox
        ? _sandbox.runWithTimeout(() => handleNeedExec.handleReply(Obj), 'reply:' + _name)
        : Promise.resolve().then(() => handleNeedExec.handleReply(Obj));
      _replyPromise.catch(error => {
        console.error(
          '[handleReply] Unhandled rejection in handleReply:',
          _name,
          error?.message || error
        );
        try { if (_errBudget) _errBudget.record(_name, error); } catch (_) {}
      });
    } catch (error) {
      return api.sendMessage(global.getText('handleReply', 'executeError', error), threadID, messageID);
    }
  };
};
