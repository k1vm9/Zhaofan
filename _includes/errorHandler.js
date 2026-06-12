"use strict";

/**
 * errorHandler.js
 *
 * Centralised error classification, escalation, and recovery coordination.
 *
 * Features:
 * - Classifies errors into: network, auth, rate-limit, crash, timeout, unknown
 * - Escalates critical errors to admins via the bot API (if online)
 * - Tracks per-source error frequency for hotspot detection
 * - Recovery coordinator: suggests the appropriate action per error class
 * - Exports a status snapshot for the panel /bot/protection/status endpoint
 */

const LOG_PREFIX = "[ ERROR-HANDLER ]: ";

const CLASS = {
  NETWORK:    "network",
  AUTH:       "auth",
  RATE_LIMIT: "rate_limit",
  CRASH:      "crash",
  TIMEOUT:    "timeout",
  UNKNOWN:    "unknown"
};

const SEVERITY = {
  LOW:      "low",
  MEDIUM:   "medium",
  HIGH:     "high",
  CRITICAL: "critical"
};

// Rolling error history: source → [{ ts, class, severity, message }]
const _history = new Map();
const _HISTORY_WINDOW_MS = 30 * 60 * 1000;  // 30-minute window
const _HISTORY_MAX       = 200;              // hard cap per source

// Escalation throttle: source → last escalation timestamp
const _escalated = new Map();
const _ESCALATE_COOLDOWN_MS = 10 * 60 * 1000;  // 10 min between admin pings

function _log(msg, warn = false) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: LOG_PREFIX, color: ["red", "cyan"] },
        { message: msg, color: warn ? "yellow" : "white" }
      ]);
      return;
    }
  } catch (_) {}
  console[warn ? "warn" : "log"](LOG_PREFIX + msg);
}

/**
 * Classify an error object or message string into one of the CLASS values.
 *
 * @param {Error|string} err
 * @returns {{ class: string, severity: string }}
 */
function classify(err) {
  const msg = (err && err.message ? err.message : String(err || "")).toLowerCase();
  const code = (err && err.code) ? String(err.code).toUpperCase() : "";

  // Auth / session errors
  if (
    msg.includes("login") ||
    msg.includes("cookie") ||
    msg.includes("appstate") ||
    msg.includes("userid") ||
    msg.includes("unauthorized") ||
    msg.includes("session") ||
    code === "EAUTH"
  ) {
    return { class: CLASS.AUTH, severity: SEVERITY.HIGH };
  }

  // Rate limiting
  if (
    msg.includes("rate limit") ||
    msg.includes("too many request") ||
    msg.includes("429") ||
    code === "RATE_LIMIT"
  ) {
    return { class: CLASS.RATE_LIMIT, severity: SEVERITY.MEDIUM };
  }

  // Timeouts
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout") ||
    code === "SANDBOX_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT"
  ) {
    return { class: CLASS.TIMEOUT, severity: SEVERITY.MEDIUM };
  }

  // Network connectivity
  if (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("socket") ||
    msg.includes("getaddrinfo") ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ENETUNREACH"
  ) {
    return { class: CLASS.NETWORK, severity: SEVERITY.MEDIUM };
  }

  // Crash-level (uncaught, fatal signals)
  if (
    msg.includes("cannot read propert") ||
    msg.includes("is not a function") ||
    msg.includes("is not defined") ||
    msg.includes("typeerror") ||
    msg.includes("referenceerror")
  ) {
    return { class: CLASS.CRASH, severity: SEVERITY.HIGH };
  }

  return { class: CLASS.UNKNOWN, severity: SEVERITY.LOW };
}

/**
 * Suggest the recovery action for a given error class.
 *
 * @param {string} errorClass  One of CLASS.*
 * @returns {string}  Human-readable recovery suggestion.
 */
function recoveryAction(errorClass) {
  switch (errorClass) {
    case CLASS.AUTH:       return "Trigger tier fallback / relogin";
    case CLASS.RATE_LIMIT: return "Apply exponential back-off, pause outgoing sends";
    case CLASS.TIMEOUT:    return "Retry with longer timeout; check command for hangs";
    case CLASS.NETWORK:    return "Wait for connectivity; check MQTT keepalive";
    case CLASS.CRASH:      return "Log stack trace, notify admin, skip this event";
    default:               return "Log and continue";
  }
}

/**
 * Record an error from a given source and trigger escalation if warranted.
 *
 * @param {string}       source   Logical name (e.g. 'handleCommand', 'keepAlive')
 * @param {Error|string} err      The error to record
 * @param {object}       [ctx]    Extra context (threadID, commandName, etc.)
 */
function record(source, err, ctx = {}) {
  const { class: errClass, severity } = classify(err);
  const entry = {
    ts:       Date.now(),
    class:    errClass,
    severity,
    message:  err && err.message ? err.message : String(err || ""),
    ctx
  };

  if (!_history.has(source)) _history.set(source, []);
  const arr = _history.get(source);

  // Prune old entries
  const cutoff = Date.now() - _HISTORY_WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();

  arr.push(entry);
  if (arr.length > _HISTORY_MAX) arr.shift();

  const tag = `[${severity.toUpperCase()}/${errClass}]`;
  _log(`${tag} ${source}: ${entry.message}`, severity === SEVERITY.HIGH || severity === SEVERITY.CRITICAL);

  // Escalate critical / high-frequency errors to admins
  if (severity === SEVERITY.HIGH || severity === SEVERITY.CRITICAL) {
    _maybeEscalate(source, entry, arr);
  }
}

/**
 * Send an admin notification (via bot API) if the cooldown has elapsed.
 */
function _maybeEscalate(source, entry, arr) {
  try {
    const lastEsc = _escalated.get(source) || 0;
    if (Date.now() - lastEsc < _ESCALATE_COOLDOWN_MS) return;

    const api = global._botApi;
    const admins = (global.config && Array.isArray(global.config.ADMINBOT))
      ? global.config.ADMINBOT
      : [];
    if (!api || !admins.length) return;

    _escalated.set(source, Date.now());

    const recentCount = arr.filter(e => Date.now() - e.ts < 5 * 60 * 1000).length;
    const msg =
      `⚠️ ZAO Error Alert\n` +
      `Source: ${source}\n` +
      `Type: ${entry.class} (${entry.severity})\n` +
      `Message: ${entry.message.slice(0, 200)}\n` +
      `Recent (5 min): ${recentCount} errors\n` +
      `Action: ${recoveryAction(entry.class)}`;

    for (const adminID of admins) {
      try {
        api.sendMessage(msg, String(adminID), () => {});
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Return the error history for a source (optionally filtered by class).
 *
 * @param {string}  [source]      Omit to get all sources.
 * @param {string}  [errorClass]  Filter to a specific CLASS.*
 * @returns {Array}
 */
function getHistory(source, errorClass) {
  const cutoff = Date.now() - _HISTORY_WINDOW_MS;
  if (source) {
    const arr = (_history.get(source) || []).filter(e => e.ts >= cutoff);
    return errorClass ? arr.filter(e => e.class === errorClass) : arr;
  }
  const out = {};
  for (const [src, arr] of _history.entries()) {
    const fresh = arr.filter(e => e.ts >= cutoff);
    if (fresh.length) out[src] = errorClass ? fresh.filter(e => e.class === errorClass) : fresh;
  }
  return out;
}

/**
 * Return a status snapshot suitable for the /bot/protection/status endpoint.
 */
function getStatus() {
  const cutoff5m  = Date.now() - 5  * 60 * 1000;
  const cutoff30m = Date.now() - 30 * 60 * 1000;
  const summary   = {};

  for (const [src, arr] of _history.entries()) {
    const last5  = arr.filter(e => e.ts >= cutoff5m);
    const last30 = arr.filter(e => e.ts >= cutoff30m);
    if (!last30.length) continue;
    summary[src] = {
      last5min:  last5.length,
      last30min: last30.length,
      topClass:  _topClass(last5.length ? last5 : last30),
      severity:  _maxSeverity(last5.length ? last5 : last30)
    };
  }
  return { sources: summary, classEnum: CLASS, severityEnum: SEVERITY };
}

function _topClass(arr) {
  const counts = {};
  for (const e of arr) counts[e.class] = (counts[e.class] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || CLASS.UNKNOWN;
}

function _maxSeverity(arr) {
  const order = [SEVERITY.LOW, SEVERITY.MEDIUM, SEVERITY.HIGH, SEVERITY.CRITICAL];
  let max = 0;
  for (const e of arr) {
    const idx = order.indexOf(e.severity);
    if (idx > max) max = idx;
  }
  return order[max];
}

// Cleanup stale history every 15 minutes
const _cleanTimer = setInterval(() => {
  const cutoff = Date.now() - _HISTORY_WINDOW_MS;
  for (const [src, arr] of _history.entries()) {
    const fresh = arr.filter(e => e.ts >= cutoff);
    if (!fresh.length) _history.delete(src);
    else _history.set(src, fresh);
  }
}, 15 * 60 * 1000);
if (_cleanTimer.unref) _cleanTimer.unref();

module.exports = { record, classify, recoveryAction, getHistory, getStatus, CLASS, SEVERITY };
