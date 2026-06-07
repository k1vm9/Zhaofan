"use strict";

/**
 * accountAgeScale.js
 * ==================
 * Derives account age from Facebook UID prefix and provides
 * behavior multipliers so fresh accounts run at ultra-low
 * activity while veteran accounts run at full speed.
 *
 * UID prefix → era mapping (from Facebook's ID allocation history):
 *   615xxxxxxx  → 2023+      (FRESH)   → multiplier 0.20
 *   100xxxxxxx  → 2009-2022  (MID)     → multiplier 0.65
 *   2-5xxxxxxx  → 2004-2008  (VETERAN) → multiplier 1.00
 *   anything else            (MID)     → multiplier 0.65
 *
 * Usage:
 *   const age = require('./accountAgeScale');
 *   const m   = age.getAgeMultiplier();   // 0.20 | 0.65 | 1.00
 *   const era = age.getEra();             // { name, multiplier, ... }
 */

const ERAS = [
  {
    name:                 "FRESH",
    label:                "2023+ account",
    prefixes:             ["615"],
    multiplier:           0.20,
    warmupExtraMin:       60,
    maxMsgsPerMin:        2,
    maxMsgsPerMinWindow:  3,
    notificationVisit:    false,
    maxRequestsPerMinute: 10,
    autoMarkRead:         false,
    simulateTyping:       false,
    browsing:             false,
    graphqlFeed:          false
  },
  {
    name:                 "MID",
    label:                "2009-2022 account",
    prefixes:             ["100"],
    multiplier:           0.65,
    warmupExtraMin:       20,
    maxMsgsPerMin:        5,
    maxMsgsPerMinWindow:  8,
    notificationVisit:    true,
    maxRequestsPerMinute: 30,
    autoMarkRead:         true,
    simulateTyping:       true,
    browsing:             true,
    graphqlFeed:          true
  },
  {
    name:                 "VETERAN",
    label:                "2004-2008 account",
    prefixes:             ["2", "3", "4", "5"],
    multiplier:           1.00,
    warmupExtraMin:       0,
    maxMsgsPerMin:        10,
    maxMsgsPerMinWindow:  15,
    notificationVisit:    true,
    maxRequestsPerMinute: 50,
    autoMarkRead:         true,
    simulateTyping:       true,
    browsing:             true,
    graphqlFeed:          true
  }
];

const DEFAULT_ERA = ERAS[1]; // MID if UID unknown

function _getUID() {
  try {
    if (global.botUserID) return String(global.botUserID).trim();
    const api = global._botApi;
    if (api && typeof api.getCurrentUserID === "function") {
      return String(api.getCurrentUserID()).trim();
    }
  } catch (_) {}
  return "";
}

/**
 * Determine which era this account belongs to based on UID prefix.
 * @returns {object} The matching era object.
 */
function getEra() {
  const uid = _getUID();
  if (!uid) return DEFAULT_ERA;
  for (const era of ERAS) {
    for (const prefix of era.prefixes) {
      if (uid.startsWith(prefix)) return era;
    }
  }
  return DEFAULT_ERA;
}

/**
 * Returns a 0.0–1.0 multiplier: lower = fresher account = less activity.
 */
function getAgeMultiplier() {
  return getEra().multiplier;
}

/**
 * Returns the era name: "FRESH" | "MID" | "VETERAN"
 */
function getAgeCategory() {
  return getEra().name;
}

/**
 * Returns a full info snapshot for logging/panel display.
 */
function getAgeInfo() {
  const era = getEra();
  const uid = _getUID();
  return {
    uid:                  uid ? uid.slice(0, 6) + "..." : "unknown",
    era:                  era.name,
    label:                era.label,
    multiplier:           era.multiplier,
    warmupExtra:          era.warmupExtraMin,
    maxMsgsPerMin:        era.maxMsgsPerMin,
    notificationVisit:    era.notificationVisit,
    maxRequestsPerMinute: era.maxRequestsPerMinute
  };
}

/**
 * Scale an interval UP by the inverse of the age multiplier.
 * Fresh accounts need LONGER gaps between actions.
 * e.g. base=35min, multiplier=0.20 → 175 min (capped at ceilMin)
 *
 * @param {number} baseMin  - Baseline interval in minutes
 * @param {number} [ceilMin] - Optional cap in minutes
 */
function scaleInterval(baseMin, ceilMin) {
  const m      = getAgeMultiplier();
  const scaled = Math.round(baseMin / m);
  return ceilMin ? Math.min(scaled, ceilMin) : scaled;
}

/**
 * Scale a COUNT down by the age multiplier.
 * Fresh accounts do fewer actions per cycle.
 * Floored at 1 so the simulator always does at least one thing.
 *
 * @param {number} base      - Baseline count
 * @param {number} [floor]   - Minimum value (defaults to 1)
 */
function scaleCount(base, floor) {
  const m      = getAgeMultiplier();
  const scaled = Math.max(floor !== undefined ? floor : 1, Math.round(base * m));
  return scaled;
}

module.exports = { getEra, getAgeMultiplier, getAgeCategory, getAgeInfo, scaleInterval, scaleCount };
