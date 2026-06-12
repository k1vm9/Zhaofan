"use strict";
/**
 * DAVID V1 — Keep Alive (re-export from protection layer + cookie saver)
 */
const path = require("path");
const fs   = require("fs-extra");

let _prot = null;
try { _prot = require("../src/protection/keepAlive"); } catch (_) {}

function start(api, opts) {
  if (_prot?.start) return _prot.start(api, opts);
}
function stop() {
  if (_prot?.stop) return _prot.stop();
}

/**
 * doSaveCookies — saves current appState back to account.txt
 * Used by /كوكيز command to refresh/persist cookies.
 */
async function doSaveCookies(api) {
  const accountPath = path.join(process.cwd(), "account.txt");
  try {
    const state = api.getAppState ? api.getAppState() : null;
    if (state && state.length) {
      global._selfWrite = true;
      fs.writeFileSync(accountPath, JSON.stringify(state, null, 2));
      setTimeout(() => { global._selfWrite = false; }, 6000);
      return { ok: true, count: state.length };
    }
    return { ok: false, error: "لا يوجد AppState" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { start, stop, doSaveCookies };
