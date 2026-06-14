"use strict";

/**
 * humanTyping.js  v3.0 — Fully Adaptive
 * ──────────────────────────────────────────────────────────────────────────────
 * Simulates realistic human typing delays based on message content AND
 * conversation context — not just static config values.
 *
 * What "adaptive" means here:
 *
 *   Per-thread state (Map)
 *     • Ring buffer of last 8 inter-response gaps → derives conversation tempo
 *       ("fast" < 20 s avg | "slow" > 90 s avg | "normal" in between)
 *     • Ring buffer of last 6 incoming message lengths → scales reading pause
 *     • jitterSeed: grows when consecutive delays are too similar (pattern
 *       detected by FB's timing analysis), widens jitter range automatically
 *     • lastResponseAt: powers the cold-thread context-switch delay
 *
 *   Message content classification
 *     micro / emoji / quick / short / medium / question / long / long_essay /
 *     url_share / urgent / attachment — each class gets its own timing profile
 *
 *   Adaptive CPS (chars per second)
 *     • Arabic-dominant text → slower CPS (realistic composition speed)
 *     • Fast-tempo thread → slightly higher CPS (warm conversation)
 *     • Slow-tempo thread → slightly lower CPS (casual check-in)
 *     • Range clamped 5–14 CPS regardless of all multipliers
 *
 *   Thinking pauses
 *     • Scaled by message class: questions get 70 % pause chance, micro = 10 %
 *     • Incoming message length adds reading time (≈ 8 chars/sec human read)
 *     • Fast-tempo threads cut thinking pauses by 30 %
 *
 *   Cold-thread context-switch cost
 *     0 ms (< 3 min gap) → 800 ms (3-10 min) → 1800 ms (10-30 min) →
 *     3000 ms (30-120 min) → 4500 ms (> 2 h)
 *
 *   Risk-aware multiplier
 *     • Integrates with antiSuspension circuit breaker → ×3.5 when tripped
 *     • Integrates with HumanActivitySimulator activityPressure → up to ×1.6
 *
 *   Time-of-day curve
 *     Deep night (01-06) ×2.8 | Early morning (06-09) ×1.5 |
 *     Daytime (09-17) ×1.0 | Evening (17-21) ×1.15 | Late night (21-24) ×1.6
 *
 *   Dynamic jitter
 *     Jitter range expands automatically when repetitive timing patterns are
 *     detected (jitterSeed grows), breaking fingerprint patterns over long runs.
 *
 * Exports
 *   calcDelay(form, threadID, incomingMessage) → ms
 *   simulateTyping(api, threadID, delayMs)     → Promise<void>
 *   wrapApiWithTyping(api, threadID)            → wrappedApi
 *   recordIncoming(threadID, messageOrLen)      → void
 *   getThreadProfile(threadID)                  → object
 *   isNightMode()                               → bool
 */

// ── Regex constants ────────────────────────────────────────────────────────────
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const EMOJI_RE  = /^[\p{Emoji}\s\u200d\ufe0f]+$/u;
const URL_RE    = /https?:\/\/\S+/;

function _arabicRatio(text) {
  if (!text || !text.length) return 0;
  let count = 0;
  for (const ch of text) { if (ARABIC_RE.test(ch)) count++; }
  return count / text.length;
}

// ── Per-thread adaptive state ──────────────────────────────────────────────────
/**
 * AdaptiveState per thread:
 *   responseGaps   : number[]  — ring buffer (max 8) of inter-response gaps (ms)
 *   lastResponseAt : number    — timestamp of last outgoing response
 *   incomingLens   : number[]  — ring buffer (max 6) of incoming message lengths
 *   tempo          : "fast"|"normal"|"slow"
 *   jitterSeed     : number    — 0.0–1.0 pattern-detection pressure
 */
const _threadState = new Map();

function _getState(threadID) {
  const key = String(threadID || '__global__');
  if (!_threadState.has(key)) {
    _threadState.set(key, {
      responseGaps:   [],
      lastResponseAt: 0,
      incomingLens:   [],
      tempo:          'normal',
      jitterSeed:     0
    });
  }
  return _threadState.get(key);
}

function _recordOutgoing(threadID, delayMs) {
  const st  = _getState(threadID);
  const now = Date.now();

  if (st.lastResponseAt > 0) {
    const gap = now - st.lastResponseAt;
    st.responseGaps.push(gap);
    if (st.responseGaps.length > 8) st.responseGaps.shift();
  }
  st.lastResponseAt = now;

  // Derive tempo from average inter-response gap
  if (st.responseGaps.length >= 2) {
    const avg = st.responseGaps.reduce((a, b) => a + b, 0) / st.responseGaps.length;
    st.tempo = avg < 20000 ? 'fast' : avg > 90000 ? 'slow' : 'normal';
  }

  // Jitter seed: grows when last 3 delays cluster too tightly (timing pattern)
  if (st.responseGaps.length >= 3) {
    const last3  = st.responseGaps.slice(-3);
    const spread = Math.max(...last3) - Math.min(...last3);
    if (spread < 2000) {
      st.jitterSeed = Math.min(1.0, st.jitterSeed + 0.18);
    } else {
      st.jitterSeed = Math.max(0, st.jitterSeed - 0.05);
    }
  }
}

function _recordIncomingLen(threadID, len) {
  const st = _getState(threadID);
  st.incomingLens.push(len || 0);
  if (st.incomingLens.length > 6) st.incomingLens.shift();
}

// ── Time-of-day multiplier ─────────────────────────────────────────────────────
// Values match the header docstring exactly:
//   Deep night (01-06) ×2.8 | Early morning (06-09) ×1.5 |
//   Daytime (09-17) ×1.0    | Evening (17-21) ×1.15      | Late night (21-24) ×1.6
function _todMultiplier() {
  const h = new Date().getHours();
  if (h >= 1  && h < 6)  return 2.8;   // deep night — much slower (anti-suspension)
  if (h >= 6  && h < 9)  return 1.5;   // early morning — slower
  if (h >= 9  && h < 17) return 1.0;   // daytime — baseline
  if (h >= 17 && h < 21) return 1.15;  // evening — slightly slower
  if (h >= 21)            return 1.6;   // late night — noticeably slower
  return 1.0;
}

// ── Night-mode helper ──────────────────────────────────────────────────────────
function isNightMode() {
  const cfg = global.config?.stealthMode;
  if (!cfg || !cfg.enabled || !cfg.nightModeSlowdown) return false;
  const hour  = new Date().getHours();
  const start = cfg.nightModeStart ?? 1;
  const end   = cfg.nightModeEnd   ?? 6;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// ── Risk multiplier (antiSuspension + activityPressure) ───────────────────────
function _riskMultiplier() {
  let mult = 1.0;
  try {
    const as = global._antiSuspension;
    if (as && typeof as.isCircuitBreakerTripped === 'function' && as.isCircuitBreakerTripped()) {
      mult *= 3.5;
    }
  } catch (_) {}
  try {
    const sim = require('./HumanActivitySimulator');
    const st  = typeof sim.getStatus === 'function' ? sim.getStatus() : null;
    if (st && typeof st.activityPressure === 'number' && st.activityPressure > 0.7) {
      mult *= 1.0 + (st.activityPressure - 0.7) * 2.0; // up to ×1.6 at pressure=1.0
    }
  } catch (_) {}
  return mult;
}

// ── Message classifier ─────────────────────────────────────────────────────────
function _classify(text, hasAttachment) {
  if (!text) return hasAttachment ? 'attachment' : 'empty';
  const t = text.trim();
  if (!t)             return 'empty';
  if (t.length <= 3)  return 'micro';
  if (EMOJI_RE.test(t)) return 'emoji';
  if (t.length <= 8)  return 'quick';
  if (URL_RE.test(t) && t.split(' ').length <= 3) return 'url_share';
  if (/[!?؟]{2,}/.test(t)) return 'urgent';
  if (/[?؟]/.test(t))      return 'question';
  if (t.length > 200) return 'long_essay';
  if (t.length > 80)  return 'long';
  if (t.length > 30)  return 'medium';
  return 'short';
}

// ── Adaptive CPS ───────────────────────────────────────────────────────────────
function _adaptiveCps(baseCps, arabicRatio, tempo, msgClass) {
  let cps;
  if (arabicRatio > 0.5) {
    cps = 7;
  } else if (arabicRatio > 0.2) {
    cps = 7 + (baseCps - 7) * 0.5;
  } else {
    cps = baseCps;
  }

  if (tempo === 'fast') cps = Math.min(cps * 1.25, 13);
  if (tempo === 'slow') cps = Math.max(cps * 0.85, 6);

  switch (msgClass) {
    case 'micro':
    case 'emoji':
    case 'quick':      cps = Math.min(baseCps * 1.3,  14); break;
    case 'urgent':     cps = Math.min(baseCps * 1.15, 12); break;
    case 'url_share':  cps = Math.max(cps * 0.7, 5);       break;
    case 'long_essay': cps = Math.max(cps * 0.9, 7);       break;
    default: break;
  }

  return Math.max(5, Math.min(14, cps));
}

// ── Thinking pauses ────────────────────────────────────────────────────────────
function _thinkingDelay(msgClass, cfg, incomingLen, tempo) {
  const thinkChance = cfg.thinkingPauseChance ?? 0.10;
  const thinkMs     = cfg.thinkingPauseMs     ?? 700;

  // Reading time scales with incoming message length (~8 chars/sec human read)
  const readingMs = incomingLen > 0
    ? Math.min(2200, (incomingLen / 8) * 1000)
    : 0;

  let total = readingMs;

  switch (msgClass) {
    case 'micro':
    case 'emoji':
      if (Math.random() < 0.10) total += thinkMs * 0.3;
      break;

    case 'quick':
      if (Math.random() < 0.18) total += thinkMs * 0.5;
      break;

    case 'question':
      if (Math.random() < 0.70) {
        total += thinkMs * (0.8 + Math.random() * 0.8);
        if (Math.random() < 0.30) total += thinkMs * 0.5;
      }
      break;

    case 'long':
    case 'long_essay': {
      const pauses = 2 + (Math.random() < 0.35 ? 1 : 0);
      for (let i = 0; i < pauses; i++) {
        if (Math.random() < thinkChance + 0.20) {
          total += thinkMs * (0.5 + Math.random() * 0.8);
        }
      }
      break;
    }

    case 'medium':
      if (Math.random() < thinkChance + 0.10) {
        total += thinkMs;
        if (Math.random() < 0.25) total += thinkMs * 0.5;
      }
      break;

    case 'url_share':
      total += 800 + Math.random() * 600; // paste + review URL
      if (Math.random() < thinkChance) total += thinkMs * 0.6;
      break;

    case 'urgent':
      if (Math.random() < 0.25) total += thinkMs * 0.4; // brief hesitation
      break;

    default:
      if (Math.random() < thinkChance) total += thinkMs;
      break;
  }

  if (tempo === 'fast') total *= 0.70;
  return total;
}

// ── Cold-thread context-switch cost ───────────────────────────────────────────
function _coldDelay(st) {
  if (!st.lastResponseAt) return 0;
  const gapMs = Date.now() - st.lastResponseAt;
  if (gapMs < 3   * 60 * 1000) return 0;
  if (gapMs < 10  * 60 * 1000) return 300;
  if (gapMs < 30  * 60 * 1000) return 600;
  if (gapMs < 120 * 60 * 1000) return 1000;
  return 1500;
}

// ── Adaptive jitter ────────────────────────────────────────────────────────────
function _adaptiveJitter(delay, jitterPct, jitterSeed) {
  const basePct   = (jitterPct || 30) / 100;
  const seedExtra = jitterSeed * 0.25; // up to +25 % extra when patterns detected
  const totalPct  = Math.min(0.55, basePct + seedExtra);
  const range     = delay * totalPct;
  return delay + (Math.random() * range * 2) - range;
}

// ── Core delay calculation ─────────────────────────────────────────────────────
/**
 * @param {string|object} form          — message form (string body or FCA form object)
 * @param {string|number} [threadID]    — thread ID for per-thread adaptive state
 * @param {string|object} [incoming]    — the message that triggered this response
 * @returns {number} delay in milliseconds (≥ 800, ≤ 18000)
 */
function calcDelay(form, threadID, incoming) {
  const cfg = global.config?.humanTyping;
  if (!cfg || !cfg.enable) return 0;

  let text          = '';
  let hasAttachment = false;

  if (typeof form === 'string') {
    text = form;
  } else if (form && typeof form === 'object') {
    if (typeof form.body === 'string') text = form.body;
    if (form.attachment || form.sticker || form.url) hasAttachment = true;
  }

  const minDelay  = cfg.minDelay       || 600;
  const maxDelay  = cfg.maxDelay       || 2500;
  const jitterPct = cfg.jitterPercent  || 30;
  const baseCps   = cfg.charsPerSecond || 10;

  const st = _getState(threadID);

  // Resolve incoming message length from argument or thread ring buffer
  let incomingLen = 0;
  if (incoming != null) {
    incomingLen = typeof incoming === 'number'
      ? incoming
      : typeof incoming === 'string'
        ? incoming.length
        : typeof incoming.body === 'string'
          ? incoming.body.length
          : 0;
  } else if (st.incomingLens.length) {
    incomingLen = st.incomingLens[st.incomingLens.length - 1];
  }

  // ── Attachment only: simulate gallery browsing ────────────────────────────
  if (hasAttachment && !text) {
    const base = Math.round(
      Math.max(1800, (1800 + Math.random() * 2200) + (Math.random() - 0.5) * 400)
    );
    return Math.round(Math.max(1800, base * _todMultiplier() * _riskMultiplier()));
  }

  const msgClass = _classify(text, hasAttachment);

  // ── Micro / emoji: instant tap reaction ──────────────────────────────────
  if (msgClass === 'micro' || msgClass === 'emoji') {
    const base = 600 + Math.random() * 900;
    return Math.round(Math.max(800, base * _todMultiplier() * _riskMultiplier()));
  }

  // ── Quick short messages ──────────────────────────────────────────────────
  if (msgClass === 'quick') {
    const base = 800 + Math.random() * 700;
    const cold = _coldDelay(st) * 0.5;
    return Math.round(Math.max(800, (base + cold) * _todMultiplier() * _riskMultiplier()));
  }

  // ── Adaptive CPS based on content + thread context ────────────────────────
  const arabicRatio = _arabicRatio(text);
  const cps         = _adaptiveCps(baseCps, arabicRatio, st.tempo, msgClass);

  // ── Base typing time ──────────────────────────────────────────────────────
  let delay = (text.length / cps) * 1000;
  delay     = Math.max(minDelay, Math.min(delay, maxDelay));

  // ── Adaptive jitter ───────────────────────────────────────────────────────
  delay = _adaptiveJitter(delay, jitterPct, st.jitterSeed);

  // ── Time-of-day / night-mode ──────────────────────────────────────────────
  if (isNightMode()) {
    delay *= (cfg.nightModeMultiplier || 2.4);
    delay += Math.random() * 1200;
  } else {
    delay *= _todMultiplier();
  }

  // ── Thinking pauses (content + incoming-length aware) ────────────────────
  delay += _thinkingDelay(msgClass, cfg, incomingLen, st.tempo);

  // ── Cold-thread context-switch cost ──────────────────────────────────────
  delay += _coldDelay(st);

  // ── Correction simulation (backspace & retype) ────────────────────────────
  const corrChance = cfg.correctionChance ?? 0.20;
  if (text.length > 15 && Math.random() < corrChance) {
    delay += 500 + Math.random() * 1200;
  }

  // ── Risk multiplier ───────────────────────────────────────────────────────
  delay *= _riskMultiplier();

  // ── Final hard clamp ──────────────────────────────────────────────────────
  const cap = isNightMode() ? 8000 : 5000;
  return Math.max(500, Math.round(Math.min(delay, cap)));
}

// ── Typing indicator simulation ────────────────────────────────────────────────
/**
 * Sends typing indicator(s) across the full delay window.
 * Long delays get 2-3 segments with mid-typing pauses (user re-reads, thinks).
 * Short delays get a single chunk.
 */
async function simulateTyping(api, threadID, delayMs) {
  if (!delayMs) return;

  const cfg         = global.config?.humanTyping;
  const thinkChance = cfg?.thinkingPauseChance ?? 0.24;
  const liveApi     = global._botApi || api;

  function _sendTyping() {
    try {
      if (liveApi && typeof liveApi.sendTypingIndicator === 'function') {
        const r = liveApi.sendTypingIndicator(threadID, () => {});
        if (r && typeof r.catch === 'function') r.catch(() => {});
      }
    } catch (_) {}
  }

  if (delayMs > 4000) {
    // Long message: 2-3 typing segments separated by thinking pauses
    const segments = 2 + (delayMs > 7000 && Math.random() < 0.4 ? 1 : 0);
    let remaining  = delayMs;

    for (let seg = 0; seg < segments; seg++) {
      const isLast  = seg === segments - 1;
      const portion = isLast
        ? remaining
        : Math.round(remaining * (0.30 + Math.random() * 0.30));
      remaining -= portion;

      _sendTyping();
      await new Promise(r => setTimeout(r, portion));

      if (!isLast && Math.random() < thinkChance + 0.20) {
        // Stop typing: user pauses to re-read or think
        await new Promise(r => setTimeout(r, 500 + Math.random() * 900));
      }
    }
  } else if (delayMs > 1800) {
    // Medium: 2 segments
    const split     = Math.floor(delayMs * (0.40 + Math.random() * 0.25));
    const remainder = delayMs - split;

    _sendTyping();
    await new Promise(r => setTimeout(r, split));

    if (Math.random() < thinkChance) {
      await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
    }

    _sendTyping();
    await new Promise(r => setTimeout(r, remainder));
  } else {
    // Short: single chunk
    _sendTyping();
    await new Promise(r => setTimeout(r, delayMs));
  }
}

// ── API wrapper ────────────────────────────────────────────────────────────────
function wrapApiWithTyping(api, threadID) {
  const _orig = api.sendMessage.bind(api);
  return Object.assign(Object.create(api), {
    sendMessage: async function (form, tid, ...rest) {
      const target = tid || threadID;
      const delay  = calcDelay(form, target);
      if (delay > 0) await simulateTyping(api, target, delay);
      _recordOutgoing(target, delay);
      return _orig(form, target, ...rest);
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call from the message event listener when an INCOMING message arrives.
 * Primes the adaptive engine with the incoming message length so the
 * next calcDelay() for this thread has accurate reading-time data.
 *
 * @param {string|number} threadID
 * @param {string|number|object} messageOrLen — message body string, length, or FCA event
 */
function recordIncoming(threadID, messageOrLen) {
  const len = typeof messageOrLen === 'number'
    ? messageOrLen
    : typeof messageOrLen === 'string'
      ? messageOrLen.length
      : typeof messageOrLen?.body === 'string'
        ? messageOrLen.body.length
        : 0;
  _recordIncomingLen(threadID, len);
}

/**
 * Diagnostic snapshot of per-thread adaptive state.
 */
function getThreadProfile(threadID) {
  const st = _getState(threadID);
  return {
    tempo:          st.tempo,
    jitterSeed:     parseFloat(st.jitterSeed.toFixed(3)),
    lastResponseAt: st.lastResponseAt ? new Date(st.lastResponseAt).toISOString() : null,
    responseGaps:   st.responseGaps.map(g => `${Math.round(g / 1000)}s`),
    incomingLens:   st.incomingLens,
    coldDelayMs:    _coldDelay(st)
  };
}

// ── Periodic stale-state eviction (threads inactive > 4 h) ───────────────────
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [key, st] of _threadState.entries()) {
    if (st.lastResponseAt && st.lastResponseAt < cutoff) {
      _threadState.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();

module.exports = {
  calcDelay,
  simulateTyping,
  wrapApiWithTyping,
  isNightMode,
  recordIncoming,
  getThreadProfile
};
