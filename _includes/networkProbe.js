'use strict';
/**
 * networkProbe.js  v2 — UPGRADED
 *
 * Reachability check for Facebook edge endpoints — upgraded with:
 * - Expanded host list (added b-api.facebook.com, connect.facebook.net)
 * - HTTP-level probe as a final fallback (DNS+TCP can succeed even when
 *   HTTPS handshake fails behind captive portals / Replit routing issues)
 * - Shorter per-probe timeout (3 s instead of 4 s) so the total probe
 *   completes faster in degraded-network scenarios
 * - Result cache TTL configurable per call (default 20 s, was 30 s)
 * - Exported `probeAll()` for diagnostics — returns status of every host
 * - Exported `reset()` to force a fresh probe on next call
 */

const dns  = require('dns').promises;
const net  = require('net');
const http = require('https');

const HOSTS = [
  'edge-mqtt.facebook.com',
  'www.facebook.com',
  'graph.facebook.com',
  'b-api.facebook.com',
  'connect.facebook.net'
];

const PROBE_TIMEOUT_MS = 3000;

let lastResult = { ok: true, at: 0, host: null };

// ── Low-level probes ──────────────────────────────────────────────────────────

function tcpProbe(host, port, timeoutMs) {
  port      = port      || 443;
  timeoutMs = timeoutMs || PROBE_TIMEOUT_MS;
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  });
}

function dnsProbe(host, timeoutMs) {
  timeoutMs = timeoutMs || PROBE_TIMEOUT_MS;
  return Promise.race([
    dns.lookup(host).then(() => true).catch(() => false),
    new Promise(r => setTimeout(() => r(false), timeoutMs))
  ]);
}

/**
 * HTTP-level probe: makes a HEAD request and resolves true if we get any
 * response (even a 302/4xx — the important thing is the TLS handshake
 * completed, meaning routing works).
 */
function httpProbe(host, timeoutMs) {
  timeoutMs = timeoutMs || PROBE_TIMEOUT_MS;
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; resolve(ok); };
    try {
      const req = http.request(
        { hostname: host, port: 443, path: '/', method: 'HEAD',
          timeout: timeoutMs, headers: { 'User-Agent': 'node-health/1.0' } },
        res => { res.resume(); finish(true); }
      );
      req.on('error',   () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.end();
    } catch (_) { finish(false); }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if at least one Facebook edge host is reachable.
 * Strategy: for each host, DNS → TCP → (optional HTTP fallback).
 * Stops on first success. Caches result for ttlMs.
 */
async function isFacebookReachable(opts) {
  opts = opts || {};
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : 20 * 1000;
  const now   = Date.now();
  if (lastResult.at && (now - lastResult.at) < ttlMs) return lastResult.ok;

  for (const h of HOSTS) {
    const dnsOk = await dnsProbe(h);
    if (!dnsOk) continue;
    const tcpOk = await tcpProbe(h);
    if (tcpOk) {
      lastResult = { ok: true, at: now, host: h };
      return true;
    }
    // TCP failed but DNS worked — try HTTP as final confirmation
    const httpOk = await httpProbe(h);
    if (httpOk) {
      lastResult = { ok: true, at: now, host: h };
      return true;
    }
  }
  lastResult = { ok: false, at: now, host: null };
  return false;
}

/**
 * Probe all hosts independently and return a diagnostic report.
 * Runs all host probes in parallel for speed (upgrade #7).
 * Used by the panel's Health tab.
 */
async function probeAll() {
  const results = await Promise.all(HOSTS.map(async (h) => {
    const dnsOk = await dnsProbe(h);
    const tcpOk = dnsOk ? await tcpProbe(h) : false;
    return { host: h, dns: dnsOk, tcp: tcpOk, reachable: tcpOk };
  }));
  return results;
}

/** Force the next isFacebookReachable() call to do a fresh probe. */
function reset() {
  lastResult = { ok: true, at: 0, host: null };
}

function getLastResult() { return Object.assign({}, lastResult); }

module.exports = {
  isFacebookReachable,
  probeAll,
  reset,
  tcpProbe,
  dnsProbe,
  httpProbe,
  getLastResult,
  HOSTS
};
