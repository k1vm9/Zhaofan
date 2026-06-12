"use strict";
/**
 * DAVID V1 — Platform Detect
 * Detects the hosting platform (Replit, Railway, local, etc.)
 */
const os = require("os");

function detect() {
  if (process.env.REPL_ID || process.env.REPLIT_DB_URL) return "Replit";
  if (process.env.RAILWAY_ENVIRONMENT)                   return "Railway";
  if (process.env.RENDER)                                return "Render";
  if (process.env.HEROKU_APP_ID)                         return "Heroku";
  if (process.env.VERCEL)                                return "Vercel";
  const h = os.hostname();
  if (h.includes("replit"))  return "Replit";
  if (h.includes("railway")) return "Railway";
  return `Local (${os.platform()})`;
}

const label    = detect();
const platform = label;

module.exports = { detect, label, platform };
