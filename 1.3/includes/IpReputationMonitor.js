"use strict";

/**
 * IpReputationMonitor
 * ====================
 * A new standalone system that detects whether the current outbound IP
 * address is a known datacenter or hosting-provider range — a major factor
 * in Facebook triggering the "automated behaviour" checkpoint.
 *
 * Facebook's risk engine heavily weights the following signals:
 *   • IP is in an ASN known to host bots / VPS providers (AWS, GCP, Azure,
 *     DigitalOcean, Linode, OVH, Hetzner, Vultr, Replit, etc.)
 *   • IP has no reverse-DNS hostname, or its rDNS is a datacenter pattern
 *   • IP country differs from the account's registration country
 *
 * This monitor:
 *   1. Resolves the public IP on startup and every CHECK_INTERVAL_MS.
 *   2. Queries ip-api.com (free, no key needed, 45 req/min limit) for
 *      ASN and org info.
 *   3. Classifies the result as "datacenter", "residential", or "unknown".
 *   4. Logs + admin-notifies on first detection of a datacenter IP.
 *   5. Exposes getStatus() for the panel.
 */

const axios    = require("axios");
const LOG_PREFIX = "[ IP-MONITOR ]: ";

// ── Tunables ──────────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;   // re-check every 4 hours
const IP_RESOLVE_URL    = "https://api.ipify.org?format=json";
const IP_INFO_URL       = "https://ip-api.com/json/";  // append IP
const TIMEOUT_MS        = 10000;

// Known datacenter ASN organisation keywords (lower-case)
const DC_KEYWORDS = [
  "amazon",  "aws",       "google",      "gcp",         "microsoft",  "azure",
  "digitalocean", "linode", "akamai",    "ovh",         "hetzner",    "vultr",
  "leaseweb", "contabo",  "cogent",      "choopa",      "quadranet",  "psychz",
  "replit",  "flyio",     "railway",     "render",      "heroku",     "vercel",
  "cloudflare", "fastly", "incapsula",   "sucuri",      "maxcdn",     "keycdn",
  "serverius", "colocation", "datacenter", "hosting",   "cloud",      "vps",
  "dedicated server", "server farm",    "ip transit",  "internet exchange",
  "bgp",     "peering",   "autonomous system",          "idc",        "ix",
];

// ── State ─────────────────────────────────────────────────────────────────
let _lastIp        = null;
let _lastOrg       = null;
let _lastAsn       = null;
let _lastCountry   = null;
let _ipClass       = "unknown";   // "datacenter" | "residential" | "unknown"
let _alerted       = false;
let _checkCount    = 0;
let _lastCheckTs   = null;
let _timer         = null;
let _started       = false;

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: LOG_PREFIX, color: ["red", "cyan"] },
        { message: msg, color: "white" },
      ]);
      return;
    }
  } catch (_) {}
  console.log(LOG_PREFIX + msg);
}

function _notifyAdmins(msg) {
  try {
    const api    = global._botApi;
    const admins = global.config?.ADMINBOT || [];
    if (!api || !admins.length) return;
    for (const id of admins) {
      const sid = String(id).trim();
      if (!sid) continue;
      const p = api.sendMessage(msg, sid);
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (_) {}
}

function _isDatacenterOrg(org) {
  if (!org) return false;
  const lower = org.toLowerCase();
  return DC_KEYWORDS.some(k => lower.includes(k));
}

async function _resolvePublicIp() {
  const resp = await axios({ url: IP_RESOLVE_URL, timeout: TIMEOUT_MS, validateStatus: () => true });
  return resp.data && resp.data.ip ? String(resp.data.ip).trim() : null;
}

async function _lookupIp(ip) {
  const resp = await axios({ url: IP_INFO_URL + ip, timeout: TIMEOUT_MS, validateStatus: () => true });
  if (!resp.data || resp.data.status === "fail") return null;
  return {
    org:     resp.data.org     || "",
    asn:     resp.data.as      || "",
    country: resp.data.country || "",
    city:    resp.data.city    || "",
    isp:     resp.data.isp     || "",
  };
}

async function _runCheck() {
  _checkCount++;
  _lastCheckTs = new Date().toISOString();

  let ip, info;
  try {
    ip = await _resolvePublicIp();
    if (!ip) { _log("Could not resolve public IP — skipping check."); return; }
  } catch (e) {
    _log(`IP resolve failed: ${e.message}`);
    return;
  }

  try {
    info = await _lookupIp(ip);
  } catch (e) {
    _log(`IP lookup failed for ${ip}: ${e.message}`);
    _lastIp    = ip;
    _ipClass   = "unknown";
    return;
  }

  _lastIp      = ip;
  _lastOrg     = info ? info.org     : null;
  _lastAsn     = info ? info.asn     : null;
  _lastCountry = info ? info.country : null;

  const isDatacenter = info && (_isDatacenterOrg(info.org) || _isDatacenterOrg(info.isp));
  _ipClass = isDatacenter ? "datacenter" : info ? "residential" : "unknown";

  _log(`IP: ${ip} | Org: ${_lastOrg || "?"} | Country: ${_lastCountry || "?"} | Class: ${_ipClass}`);

  if (isDatacenter && !_alerted) {
    _alerted = true;
    const warn =
      `⚠️ IP REPUTATION ALERT\n\n` +
      `Outbound IP: ${ip}\n` +
      `Provider: ${_lastOrg || "Unknown"}\n` +
      `Country: ${_lastCountry || "Unknown"}\n\n` +
      `This IP is identified as a DATACENTER range. ` +
      `Facebook is more likely to trigger checkpoints for sessions logging in from datacenter IPs.\n\n` +
      `Consider using a residential proxy or VPN to reduce checkpoint risk.`;
    _log("WARNING: Datacenter IP detected — notifying admins.");
    _notifyAdmins(warn);
  } else if (!isDatacenter && _alerted) {
    _alerted = false;  // Reset if IP changes to residential
  }
}

function _scheduleNext() {
  _timer = setTimeout(async () => {
    try { await _runCheck(); } catch (_) {}
    _scheduleNext();
  }, CHECK_INTERVAL_MS);
  if (typeof _timer.unref === "function") _timer.unref();
}

/**
 * Start the IP Reputation Monitor.
 * Performs an immediate check then schedules periodic re-checks.
 */
async function start() {
  if (_started) return;
  _started = true;
  _log(`IP Reputation Monitor started. Re-check every ${CHECK_INTERVAL_MS / 3600000}h.`);

  // First check with a short random delay (15-45s) to not block bot startup
  const firstDelay = 15000 + Math.floor(Math.random() * 30000);
  const t = setTimeout(async () => {
    try { await _runCheck(); } catch (_) {}
    _scheduleNext();
  }, firstDelay);
  if (t && typeof t.unref === "function") t.unref();
}

/**
 * Return current status for the panel.
 */
function getStatus() {
  return {
    active:      _started,
    currentIp:   _lastIp,
    org:         _lastOrg,
    asn:         _lastAsn,
    country:     _lastCountry,
    ipClass:     _ipClass,         // "datacenter" | "residential" | "unknown"
    alerted:     _alerted,
    checkCount:  _checkCount,
    lastCheckTs: _lastCheckTs,
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

module.exports = { start, getStatus };
