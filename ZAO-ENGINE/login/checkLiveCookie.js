"use strict";
/**
 * ZAO-ENGINE — Live Cookie Validator
 * Based on ZAO's checkLiveCookie.js — triple-URL check, returns:
 *   true  = session confirmed alive
 *   false = session confirmed dead
 *   null  = uncertain (network error, let FCA decide)
 */

const axios = require("axios");

const DEAD_SIGNALS = [
  'id="login_form"', 'id="loginbutton"',
  "action=\"/login/device-based/regular/login/",
  "/login/?next=", "/login/identify",
  "You must log in to continue",
  "checkpoint/?next=", 'name="email"', 'name="pass"',
  "Log into Facebook", "Log In to Facebook",
];

const ALIVE_SIGNALS = [
  "/messages/", "/notifications/", 'href="/profile.php',
  'content="fb://', "mbasic_logout_button", "/logout.php",
  "userLink", "home_stream", '"USER_ID"', "c_user",
];

module.exports = async function checkLiveCookie(cookie, userAgent) {
  const UA = userAgent
    || (global.config?.FCAOption?.userAgent)
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  async function tryUrl(url) {
    try {
      const resp = await axios({
        url, method: "GET", maxRedirects: 5, timeout: 15000,
        headers: {
          cookie, "user-agent": UA,
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "upgrade-insecure-requests": "1",
        },
        validateStatus: () => true,
      });
      const html     = String(resp.data || "");
      const finalUrl = String(resp.request?.res?.responseUrl || resp.config?.url || url);
      if (/\/login[/?]/.test(finalUrl)) return false;
      if (DEAD_SIGNALS.some(s => html.includes(s))) return false;
      if (ALIVE_SIGNALS.some(s => html.includes(s))) return true;
      if (resp.status === 200) return true;
      return null;
    } catch (_) { return null; }
  }

  const r1 = await tryUrl("https://mbasic.facebook.com/");
  if (r1 === true) return true;

  const r2 = await tryUrl("https://www.facebook.com/home.php");
  if (r2 === true) return true;

  const r3 = await tryUrl("https://m.facebook.com/");
  if (r3 === true) return true;

  if (r1 === false && r2 === false && r3 === false) return false;
  return null;
};
