"use strict";

/**
 * user-agents.js — Modern browser UA pool for ZAO Bot  v2.0
 * Updated to 2025-era Chrome 130-135, Edge 130, Firefox 133-134.
 * Provides randomized, realistic browser fingerprints to avoid detection.
 *
 * @author  SAIN
 * @debugger Djamel
 * @version 2.0.0
 */

const USER_AGENTS = [
  // ── Chrome 135 (Windows) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    secChUaPlatform: '"Windows"'
  },
  // ── Chrome 134 (Windows) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="8"',
    secChUaPlatform: '"Windows"'
  },
  // ── Chrome 133 (Windows) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="133", "Chromium";v="133", "Not:A-Brand";v="99"',
    secChUaPlatform: '"Windows"'
  },
  // ── Chrome 132 (Windows) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="132", "Chromium";v="132", "Not:A-Brand";v="99"',
    secChUaPlatform: '"Windows"'
  },
  // ── Chrome 131 (Windows) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not:A-Brand";v="99"',
    secChUaPlatform: '"Windows"'
  },
  // ── Chrome 130 (Windows) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="130", "Chromium";v="130", "Not:A-Brand";v="99"',
    secChUaPlatform: '"Windows"'
  },
  // ── Chrome 135 (macOS Sequoia) ────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    secChUaPlatform: '"macOS"'
  },
  // ── Chrome 134 (macOS) ────────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="8"',
    secChUaPlatform: '"macOS"'
  },
  // ── Safari 18 (macOS Sequoia) ─────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    secChUa: "",
    secChUaPlatform: '"macOS"'
  },
  // ── Safari 17.6 (macOS Sonoma) ────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    secChUa: "",
    secChUaPlatform: '"macOS"'
  },
  // ── Edge 135 (Windows) ────────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
    secChUa: '"Microsoft Edge";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    secChUaPlatform: '"Windows"'
  },
  // ── Edge 134 (Windows) ────────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
    secChUa: '"Microsoft Edge";v="134", "Chromium";v="134", "Not:A-Brand";v="8"',
    secChUaPlatform: '"Windows"'
  },
  // ── Firefox 134 (Windows) ─────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
    secChUa: "",
    secChUaPlatform: '"Windows"'
  },
  // ── Firefox 133 (Windows) ─────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    secChUa: "",
    secChUaPlatform: '"Windows"'
  },
  // ── Firefox 134 (macOS) ───────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:134.0) Gecko/20100101 Firefox/134.0",
    secChUa: "",
    secChUaPlatform: '"macOS"'
  },
  // ── Chrome 135 (Linux) ────────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    secChUaPlatform: '"Linux"'
  },
  // ── iPhone iOS 18 Safari ──────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
    secChUa: "",
    secChUaPlatform: '"iOS"'
  },
  // ── iPhone CriOS 135 ──────────────────────────────────────────────────
  {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.7049.83 Mobile/15E148 Safari/604.1",
    secChUa: "",
    secChUaPlatform: '"iOS"'
  }
];

/**
 * Returns a random user-agent object from the pool.
 * @returns {{ userAgent: string, secChUa: string, secChUaPlatform: string }}
 */
function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Returns a random desktop (non-mobile) UA.
 * @returns {{ userAgent: string, secChUa: string, secChUaPlatform: string }}
 */
function randomDesktopUserAgent() {
  const desktops = USER_AGENTS.filter(u => !u.userAgent.includes("Mobile") && !u.userAgent.includes("iPhone"));
  return desktops[Math.floor(Math.random() * desktops.length)];
}

/**
 * Returns the full pool of user-agents.
 * @returns {Array}
 */
function getAllUserAgents() {
  return USER_AGENTS;
}

module.exports = { randomUserAgent, randomDesktopUserAgent, getAllUserAgents, USER_AGENTS };
