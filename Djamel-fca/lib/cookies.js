"use strict";

function dedup(cookies) {
  const seen = new Map();
  for (const cookie of cookies) {
    if (cookie?.key) seen.set(cookie.key, cookie);
  }
  return [...seen.values()];
}

function parseCookieInput(raw) {
  if (!raw) return { cookies: [], raw: "" };
  const text = String(raw).trim();

  // Standard AppState JSON.
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length && (arr[0]?.key || arr[0]?.name)) {
        const mapped = arr.map(cookie => ({
          key: cookie.key || cookie.name,
          value: cookie.value || "",
          domain: cookie.domain || ".facebook.com",
          path: cookie.path || "/",
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          sameSite: cookie.sameSite || "None",
        })).filter(cookie => cookie.key);
        return { cookies: dedup(mapped), raw: text };
      }
    } catch (_) {}
  }

  // c3c JSON, single cookie objects, and Android fbsettings JSON.
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (Array.isArray(obj.cookies)) {
        const mapped = obj.cookies.map(cookie => ({
          key: cookie.name || cookie.key || "",
          value: cookie.value || "",
          domain: cookie.domain || ".facebook.com",
          path: cookie.path || "/",
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          sameSite: cookie.sameSite || "None",
        })).filter(cookie => cookie.key);
        return { cookies: dedup(mapped), raw: text };
      }
      if (obj.key && obj.value) return { cookies: dedup([obj]), raw: text };
      const knownKeys = new Set(["c_user", "xs", "fr", "wd", "datr", "sb", "m_sess", "spin"]);
      const found = Object.entries(obj).filter(([key]) => knownKeys.has(key.toLowerCase()));
      if (found.length) {
        const mapped = found.map(([key, value]) => ({
          key,
          value: String(value),
          domain: ".facebook.com",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "None",
        }));
        return { cookies: dedup(mapped), raw: text };
      }
    } catch (_) {}
  }

  // Cookie header string.
  if (text.includes("=")) {
    const pairs = text.split(/;\s*/g).filter(Boolean);
    const mapped = pairs.map(pair => {
      const index = pair.indexOf("=");
      if (index < 1) return null;
      return {
        key: pair.slice(0, index).trim(),
        value: pair.slice(index + 1).trim(),
        domain: ".facebook.com",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "None",
      };
    }).filter(Boolean);
    if (mapped.length) return { cookies: dedup(mapped), raw: text };
  }

  return { cookies: [], raw: text };
}

function cookiesToString(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .map(cookie => `${cookie.key}=${cookie.value}`)
    .join("; ");
}

function hasMandatory(cookies) {
  const keys = new Set((Array.isArray(cookies) ? cookies : []).map(cookie => cookie.key));
  return keys.has("c_user") && keys.has("xs");
}

module.exports = { parseCookieInput, dedup, cookiesToString, hasMandatory };
