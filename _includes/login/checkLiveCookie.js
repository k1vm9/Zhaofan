const axios = require("axios");

/**
 * Validates a Facebook session by attempting to load user-specific pages.
 *
 * Strategy:
 *   1. Hit mbasic.facebook.com root — lightest, fastest signal.
 *   2. Fallback: hit www.facebook.com/home.php — standard desktop check.
 *   3. Fallback: hit m.facebook.com/ — mobile web as final arbiter.
 *   4. If all three requests fail for non-auth reasons (timeout, 5xx),
 *      return null ("uncertain") so the caller can still try with FCA.
 *
 * @param {string} cookie     Cookie string "c_user=123; xs=456; ..."
 * @param {string} [userAgent]
 * @returns {Promise<boolean|null>}
 *   true  = session is confirmed alive
 *   false = session is confirmed dead (got a login redirect)
 *   null  = uncertain — network error, let FCA decide
 */
module.exports = async function checkLiveCookie(cookie, userAgent) {
  // [FIX Djamel] — fall back to the configured FCAOption.userAgent so
  // the validation request matches the persona FCA uses for everything
  // else (desktop). The old hard-coded mobile Android UA looked
  // suspicious back-to-back with desktop login traffic from the same IP.
  const UA = userAgent
    || (global.config && global.config.FCAOption && global.config.FCAOption.userAgent)
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const DEAD_SIGNALS = [
    'id="login_form"',
    'id="loginbutton"',
    'action="/login/device-based/regular/login/',
    "/login/?next=",
    "/login/identify",
    "You must log in to continue",
    "checkpoint/?next=",
    'name="email"',
    'name="pass"',
    "Log into Facebook",
    "Log In to Facebook"
  ];

  const ALIVE_SIGNALS = [
    "/messages/",
    "/notifications/",
    'href="/profile.php',
    'content="fb://',
    "mbasic_logout_button",
    "/logout.php",
    "userLink",
    "composer_photo",
    "feed_story",
    "pagelet_bluebar",
    "home_stream",
    '"USER_ID"',
    "c_user"
  ];

  async function tryUrl(url) {
    try {
      const resp = await axios({
        url,
        method: "GET",
        maxRedirects: 5,
        timeout: 15000,
        headers: {
          cookie,
          "user-agent": UA,
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "upgrade-insecure-requests": "1",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none"
        },
        validateStatus: () => true
      });

      const html     = String(resp.data || "");
      const finalUrl = String(resp.request?.res?.responseUrl || resp.config?.url || url);

      // Final URL after redirects contains /login → dead
      if (/\/login[/?]/.test(finalUrl)) return false;

      // Check body for dead signals
      if (DEAD_SIGNALS.some(s => html.includes(s))) return false;

      // Check body for alive signals
      if (ALIVE_SIGNALS.some(s => html.includes(s))) return true;

      // 200 with no recognisable signals — treat as alive
      if (resp.status === 200) return true;

      // Non-200 with no dead signals — uncertain
      return null;
    } catch (e) {
      // Network error (ECONNREFUSED, ETIMEDOUT, etc.) — uncertain
      return null;
    }
  }

  // 1. Try mbasic root first (most lightweight)
  const r1 = await tryUrl("https://mbasic.facebook.com/");
  if (r1 === true) return true;
  // Don't return false on first check alone — Replit IPs may get login walls even with valid cookies

  // 2. Fallback: home.php
  const r2 = await tryUrl("https://www.facebook.com/home.php");
  if (r2 === true) return true;

  // 3. Final fallback: mobile web
  const r3 = await tryUrl("https://m.facebook.com/");
  if (r3 === true) return true;

  // Only return false if ALL three confirmed dead (not just uncertain/null)
  if (r1 === false && r2 === false && r3 === false) return false;

  // At least one was uncertain — let FCA decide
  return null;
};
