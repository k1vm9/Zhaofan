module.exports = function ({ api, models, Users, Threads, Currencies, globalData, usersData, threadsData, message }) {
  const humanTyping = (() => { try { return require("../humanTyping"); } catch (_) { return null; } })();

  return function ({ event, message: _message }) {
    const message = _message;
    const { handleReaction, commands } = global.client;
    const { messageID, threadID } = event;
    if (!handleReaction || handleReaction.length === 0) return;

    const indexOfHandle = handleReaction.findIndex(e => e.messageID == messageID);
    if (indexOfHandle < 0) return;

    const indexOfMessage = handleReaction[indexOfHandle];

    // ── CRITICAL FIX: Remove the entry BEFORE executing so it fires only once
    // and cannot accumulate in memory if a command never cleans up after itself.
    handleReaction.splice(indexOfHandle, 1);

    const handleNeedExec = commands.get(indexOfMessage.name);
    if (!handleNeedExec) return api.sendMessage(global.getText('handleReaction', 'missingValue'), threadID, messageID);

    // ── Guard: command exists but no handleReaction method ───────
    if (typeof handleNeedExec.handleReaction !== 'function') {
      console.error('[handleReaction] Command "' + indexOfMessage.name + '" has no handleReaction function.');
      return;
    }

    try {
      var getText2;
      if (handleNeedExec.languages && typeof handleNeedExec.languages == 'object') {
        getText2 = (...value) => {
          const react = handleNeedExec.languages || {};
          if (!react.hasOwnProperty(global.config.language)) return '';
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
        message,
        usersData,
        threadsData,
        Users,
        Threads,
        Currencies,
        handleReaction: indexOfMessage,
        getText: getText2
      };
      const reactResult = handleNeedExec.handleReaction(Obj);
      if (reactResult && typeof reactResult.catch === 'function') {
        reactResult.catch(error => {
          console.error(
            '[handleReaction] Unhandled rejection in handleReaction:',
            indexOfMessage?.name,
            error?.message || error
          );
        });
      }
    } catch (error) {
      return api.sendMessage(global.getText('handleReaction', 'executeError', error), threadID, messageID);
    }
  };
};
