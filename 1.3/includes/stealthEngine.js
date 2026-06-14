"use strict";

/**
 * stealthEngine.js  v2.0
 *
 * Features:
 *  - Burst protection: sliding-window throttles responses when many messages arrive rapidly
 *  - Adaptive jitter: response jitter scales UP with burst frequency — the busier a thread
 *    the longer the random pause, making busy-group behaviour look more human
 *  - Minimum response gap (1200 ms floor): never reply in sub-human-fast time
 *  - Night-mode awareness: quieter behavior during configured night hours
 *  - Read-receipt randomization: delays/randomizes autoMarkRead timing
 *  - Per-thread response jitter: each thread gets unique response timing
 *  - Session fingerprint lock: consistent headers across entire session
 *  - Updated UA pool: 2025-era Chrome 130-135, Edge 135, Firefox 133-134
 */

// ── 2025-era user-agent pool ──────────────────────────────────────────────────
const MODERN_USER_AGENTS = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="8"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="133", "Chromium";v="133", "Not:A-Brand";v="99"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="132", "Chromium";v="132", "Not:A-Brand";v="99"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    platform: '"macOS"'
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    secChUa: '',
    platform: '"macOS"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
    secChUa: '"Microsoft Edge";v="135", "Chromium";v="135", "Not:A-Brand";v="8"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    secChUa: '',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    secChUa: '',
    platform: '"Windows"'
  }
];

// ── Minimum human response time (ms) ─────────────────────────────────────────
// A human needs time to read the message AND then physically type/tap.
// 250 ms was unrealistically fast — matches a machine, not a person.
// 1200 ms aligns with humanTyping.js minDelay and antiSuspension.messageDelayMs.
const MIN_RESPONSE_GAP_MS = 1200;

function getCfg() {
  return global.config?.stealthMode || {};
}

function isNightMode() {
  const cfg = getCfg();
  if (!cfg.enabled || !cfg.nightModeSlowdown) return false;
  const hour  = new Date().getHours();
  const start = cfg.nightModeStart ?? 1;
  const end   = cfg.nightModeEnd   ?? 6;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// Stale-entry eviction: any thread that had no burst activity within this
// window (15 min) is safe to remove from the counter and jitter Maps.
const _MAP_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const _MAP_STALE_AGE_MS      = 15 * 60 * 1000;

class StealthEngine {
  constructor() {
    this._burstCounters   = new Map();
    this._burstCooldowns  = new Map();
    this._threadJitter    = new Map();
    this._fingerprint     = null;
    this._lockFingerprint();
    this._startPruner();
  }

  _startPruner() {
    this._prunerTimer = setInterval(() => {
      try {
        const now    = Date.now();
        const cutoff = now - _MAP_STALE_AGE_MS;
        for (const [key, entry] of this._burstCounters.entries()) {
          const lastStamp = Array.isArray(entry.stamps) && entry.stamps.length
            ? entry.stamps[entry.stamps.length - 1]
            : (entry.windowStart || 0);
          if (lastStamp < cutoff) {
            this._burstCounters.delete(key);
            this._threadJitter.delete(key);
          }
        }
        for (const [key, until] of this._burstCooldowns.entries()) {
          if (now >= until) this._burstCooldowns.delete(key);
        }
        for (const key of this._threadJitter.keys()) {
          if (!this._burstCounters.has(key)) this._threadJitter.delete(key);
        }
      } catch (_) {}
    }, _MAP_PRUNE_INTERVAL_MS);
    if (typeof this._prunerTimer.unref === 'function') this._prunerTimer.unref();
  }

  /** Stop all background timers — call this before discarding the engine instance. */
  stop() {
    if (this._prunerTimer) {
      clearInterval(this._prunerTimer);
      this._prunerTimer = null;
    }
  }

  _lockFingerprint() {
    if (this._fingerprint) return this._fingerprint;

    // Prefer the fingerprint already locked in antiSuspension (shared session fingerprint)
    try {
      const as = global._antiSuspension;
      if (as && typeof as.getSessionFingerprint === 'function') {
        const fp = as.getSessionFingerprint();
        if (fp && fp.ua) {
          this._fingerprint = {
            ua:       fp.ua,
            secChUa:  fp.secChUa || '',
            platform: fp.platform || '"Windows"',
            locale:   fp.locale   || 'en-US,en;q=0.9,ar;q=0.7',
            timezone: fp.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
            lockedAt: fp.lockedAt || Date.now()
          };
          return this._fingerprint;
        }
      }
    } catch (_) {}

    // Build a fresh fingerprint and push it to antiSuspension
    const pick = MODERN_USER_AGENTS[Math.floor(Math.random() * MODERN_USER_AGENTS.length)];
    this._fingerprint = {
      ua:       pick.ua,
      secChUa:  pick.secChUa,
      platform: pick.platform,
      locale:   'en-US,en;q=0.9,ar;q=0.7',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
      lockedAt: Date.now()
    };

    // Sync to antiSuspension so all modules share one fingerprint
    try {
      const as = global._antiSuspension;
      if (as && typeof as.lockSessionFingerprint === 'function') {
        as.lockSessionFingerprint(
          this._fingerprint.ua,
          this._fingerprint.secChUa,
          this._fingerprint.platform,
          this._fingerprint.locale,
          this._fingerprint.timezone
        );
      }
    } catch (_) {}

    return this._fingerprint;
  }

  getFingerprint() {
    return this._fingerprint || this._lockFingerprint();
  }

  _getThreadJitter(threadID) {
    const key = String(threadID);
    if (!this._threadJitter.has(key)) {
      // Each thread gets a stable base jitter between 200–800 ms
      this._threadJitter.set(key, Math.floor(Math.random() * 600) + 200);
    }
    return this._threadJitter.get(key);
  }

  _incrementBurst(threadID) {
    const key     = String(threadID);
    const now     = Date.now();
    const cfg     = getCfg();
    const windowMs = Number(cfg.burstWindowMs) || 30000;

    const entry = this._burstCounters.get(key) || { stamps: [] };
    if (!Array.isArray(entry.stamps)) entry.stamps = [];

    entry.stamps = entry.stamps.filter(t => (now - t) <= windowMs);
    entry.stamps.push(now);
    if (entry.stamps.length > 200) entry.stamps = entry.stamps.slice(-200);

    entry.count       = entry.stamps.length;
    entry.windowStart = entry.stamps[0];
    this._burstCounters.set(key, entry);
    return entry.count;
  }

  /**
   * Adaptive jitter — scales with burst count.
   * A thread getting 1-2 msgs/window gets a light jitter;
   * a thread flooding 10+ msgs/window gets a much larger randomised delay.
   *
   *   burstCount  |  extra jitter range (ms)
   *   ─────────────────────────────────────
   *   1           |  0 – 200
   *   2-4         |  0 – 400
   *   5-9         |  0 – 800
   *   10-14       |  0 – 1400
   *   15+         |  0 – 2200
   */
  _adaptiveJitter(burstCount) {
    let ceiling;
    if (burstCount >= 15)     ceiling = 2200;
    else if (burstCount >= 10) ceiling = 1400;
    else if (burstCount >= 5)  ceiling = 800;
    else if (burstCount >= 2)  ceiling = 400;
    else                        ceiling = 200;
    return Math.floor(Math.random() * ceiling);
  }

  isBurstCooldown(threadID) {
    const key      = String(threadID);
    const cooldown = this._burstCooldowns.get(key);
    if (!cooldown) return false;
    if (Date.now() >= cooldown) {
      this._burstCooldowns.delete(key);
      return false;
    }
    return true;
  }

  async handleIncoming(threadID) {
    const cfg = getCfg();
    if (!cfg.enabled) return;

    // ── Minimum human response gap ────────────────────────────────────────
    // Even with everything else disabled, never respond in under 250 ms
    const startTs = Date.now();

    let burstCount = 0;

    if (cfg.burstProtection) {
      burstCount      = this._incrementBurst(threadID);
      const threshold = cfg.burstThreshold || 5;

      if (burstCount >= threshold) {
        const cooldownMs = cfg.burstCooldownMs || 8000;
        const until      = Date.now() + cooldownMs + Math.floor(Math.random() * 2000);
        this._burstCooldowns.set(String(threadID), until);
        await new Promise(r => setTimeout(r, cooldownMs * 0.4));
      }
    }

    if (isNightMode()) {
      const nightDelay = 1500 + Math.floor(Math.random() * 2500);
      await new Promise(r => setTimeout(r, nightDelay));
    }

    // Base per-thread jitter + adaptive burst jitter
    const baseJitter     = this._getThreadJitter(threadID);
    const adaptiveExtra  = this._adaptiveJitter(burstCount);
    const totalJitter    = baseJitter + adaptiveExtra;
    await new Promise(r => setTimeout(r, totalJitter));

    // Enforce minimum gap floor
    const elapsed = Date.now() - startTs;
    if (elapsed < MIN_RESPONSE_GAP_MS) {
      await new Promise(r => setTimeout(r, MIN_RESPONSE_GAP_MS - elapsed));
    }
  }

  async randomizeReadReceipt(api, threadID) {
    const cfg = getCfg();
    if (!cfg.enabled || !cfg.randomizeReadReceipts) return;
    if (typeof api?.markAsRead !== 'function') return;

    if (!this._pendingReceipts) this._pendingReceipts = 0;
    const MAX_PENDING_RECEIPTS = 20;
    if (this._pendingReceipts >= MAX_PENDING_RECEIPTS) return;

    const baseDelay = cfg.readReceiptDelay || 1500;
    const delay     = baseDelay + Math.floor(Math.random() * baseDelay);

    this._pendingReceipts++;
    setTimeout(() => {
      this._pendingReceipts = Math.max(0, (this._pendingReceipts || 1) - 1);
      try {
        api.markAsRead(threadID, () => {});
      } catch (_) {}
    }, delay);
  }

  getNightModeStatus() {
    return {
      active:    isNightMode(),
      hour:      new Date().getHours(),
      nightStart: getCfg().nightModeStart ?? 1,
      nightEnd:   getCfg().nightModeEnd   ?? 6
    };
  }

  getStatus() {
    return {
      enabled:       getCfg().enabled,
      nightMode:     this.getNightModeStatus(),
      burstCounters: Object.fromEntries(this._burstCounters),
      fingerprint:   { ua: this._fingerprint?.ua, platform: this._fingerprint?.platform }
    };
  }
}

const globalStealthEngine = new StealthEngine();

module.exports = { StealthEngine, globalStealthEngine, isNightMode };
