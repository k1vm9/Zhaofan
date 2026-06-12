module.exports = function ({ api, models, Users, Threads, Currencies, globalData, usersData, threadsData, message }) {
  const humanTyping = (() => { try { return require("../humanTyping"); } catch (_) { return null; } })();

  return function ({ event, message: _message }) {
    const message = _message;
    const { allowInbox } = global.config;
    const { userBanned, threadBanned } = global.data;
    const { commands, eventRegistered } = global.client;

    if (!event.senderID || !event.threadID) return;

    const senderID = String(event.senderID);
    const threadID = String(event.threadID);

    if (userBanned.has(senderID) || threadBanned.has(threadID)) return;
    if (allowInbox === false && senderID === threadID) return;

    for (const eventReg of eventRegistered) {
      const cmd = commands.get(eventReg);
      if (!cmd || !cmd.handleEvent) continue;

      var getText2;
      if (cmd.languages && typeof cmd.languages == 'object') {
        getText2 = (...values) => {
          const lang = cmd.languages[global.config.language] || {};
          var text = lang[values[0]] || '';
          for (var i = values.length - 1; i > 0; i--) {
            text = text.replace(new RegExp('%' + i, 'g'), values[i]);
          }
          return text;
        };
      } else {
        getText2 = () => {};
      }

      try {
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
          event,
          api: _wrappedApi,
          models,
          Users,
          Threads,
          Currencies,
          usersData,
          threadsData,
          message,
          getText: getText2
        };
        const evtResult = cmd.handleEvent(Obj);
        if (evtResult && typeof evtResult.catch === 'function') {
          evtResult.catch(error => {
            console.error(
              '[handleCommandEvent] Unhandled rejection in handleEvent:',
              cmd?.config?.name,
              error?.message || error
            );
          });
        }
      } catch (error) {
        console.error('[handleCommandEvent] خطأ في تنفيذ الحدث:', cmd?.config?.name, error?.message || error);
      }
    }
  };
};
