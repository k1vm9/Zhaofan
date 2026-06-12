"use strict";

const { login } = require("@neoaz07/nkxfca");

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

function loginAsync(credentials, options = {}) {
  console.log('[FCA-DIAG] loginAsync: START — calling FCA login()');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.log('[FCA-DIAG] loginAsync: TIMEOUT after 3 minutes — network or DB stuck');
      reject(new Error("loginAsync timed out after 3 minutes — network may be stuck"));
    }, LOGIN_TIMEOUT_MS);

    console.log('[FCA-DIAG] loginAsync: timer set, calling login()...');
    login(credentials, options, (err, api) => {
      clearTimeout(timer);
      console.log('[FCA-DIAG] loginAsync: callback received — err=' + (err ? err.message : 'none') + ' api=' + (api ? 'present' : 'null'));
      if (err) return reject(err);
      resolve(api);
    });
    console.log('[FCA-DIAG] loginAsync: login() call dispatched (async)');
  });
}

module.exports = {
  login,
  loginAsync
};
