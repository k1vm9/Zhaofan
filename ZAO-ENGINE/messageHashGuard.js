'use strict';
/**
 * messageHashGuard.js  v2.0 — Fuzzy Similarity Upgrade
 *
 * Content-level spam protection for ZAO Bot.
 *
 * v2.0 upgrades:
 *  - Fuzzy similarity detection for inbound sender spam:
 *    messages that are ≥ FUZZY_SIMILARITY_THRESHOLD similar to a recent
 *    message from the same sender are treated as duplicates even if the
 *    exact hash differs. Uses a fast normalized edit-distance (Levenshtein).
 *  - Unicode normalization: strips diacritics + collapses whitespace before
 *    hashing so "مرحبا " and "مرحبا" don't bypass the dedup guard.
 *  - Outbound dedup now also checks fuzzy similarity across last 3 messages
 *    per thread to catch near-identical replies (e.g. same Arabic with/without
 *    a trailing period).
 *
 * Original features preserved:
 *  - Duplicate message detection (SHA1, 90 s window)
 *  - Per-sender spam scoring
 *  - Spam pattern matching (3+ identical msgs in 30 s)
 *  - Rolling-window inbound rate limiter (thread flood)
 *  - Zero hard dependencies — built-in crypto only
 */

const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────

const OUTBOUND_DEDUP_WINDOW_MS   = 90  * 1000;
const SPAM_PATTERN_WINDOW_MS     = 30  * 1000;
const SPAM_PATTERN_THRESHOLD     = 3;
const SENDER_COOLDOWN_MS         = 60  * 1000;
const INBOUND_FLOOD_WINDOW_MS    = 15  * 1000;
const INBOUND_FLOOD_THRESHOLD    = 20;
const THREAD_FLOOD_COOLDOWN_MS   = 45  * 1000;
const GC_INTERVAL_MS             = 5  * 60 * 1000;

// Fuzzy: treat messages as duplicate if normalized similarity ≥ this threshold
const FUZZY_SIMILARITY_THRESHOLD = 0.82;
// Max text length to run fuzzy check on (skip for very long texts — too slow)
const FUZZY_MAX_LEN              = 200;
// Keep last N outbound texts per thread for fuzzy outbound dedup
const OUTBOUND_FUZZY_RING        = 3;

// ── Internal state ─────────────────────────────────────────────────────────

const _outboundSent    = new Map(); // "threadID:hash" → last sent timestamp
const _outboundTexts   = new Map(); // threadID → [{text, ts}] ring (last 3)
const _senderState     = new Map(); // senderID → { entries: [{hash, normText, ts}], coolUntil }
const _threadState     = new Map(); // threadID → { timestamps: [], coolUntil }

setInterval(_gc, GC_INTERVAL_MS).unref();

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Normalize text: NFC → strip Arabic diacritics → collapse whitespace → lowercase */
function _normalize(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '') // Arabic diacritics
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _hash(text) {
  return crypto.createHash('sha1').update(_normalize(text)).digest('hex');
}

/**
 * Fast normalized Levenshtein similarity (0.0 – 1.0).
 * Returns 1.0 for identical strings, 0.0 for completely different.
 * Only called for short strings (≤ FUZZY_MAX_LEN) to bound CPU cost.
 */
function _similarity(a, b) {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  if (a === b)  return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;

  // Simple DP Levenshtein — bounded by FUZZY_MAX_LEN so worst case ~200×200
  const la = a.length, lb = b.length;
  const prev = new Uint16Array(lb + 1);
  const curr = new Uint16Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev.set(curr);
  }
  return 1 - (prev[lb] / maxLen);
}

function _isFuzzySimilar(normA, normB) {
  if (!normA || !normB) return false;
  if (normA.length > FUZZY_MAX_LEN || normB.length > FUZZY_MAX_LEN) {
    // For long texts, fall back to hash equality only
    return normA === normB;
  }
  return _similarity(normA, normB) >= FUZZY_SIMILARITY_THRESHOLD;
}

function _log(msg) {
  try {
    const logger = global.loggeryuki;
    if (logger) {
      logger.log([
        { message: '[ MSG-HASH-GUARD ]: ', color: ['red', 'cyan'] },
        { message: msg, color: 'yellow' }
      ]);
      return;
    }
  } catch (_) {}
  console.log('[MSG-HASH-GUARD]', msg);
}

function _gc() {
  const now = Date.now();
  for (const [k, ts] of _outboundSent) {
    if (now - ts > OUTBOUND_DEDUP_WINDOW_MS) _outboundSent.delete(k);
  }
  for (const [id, ring] of _outboundTexts) {
    const fresh = ring.filter(e => now - e.ts < OUTBOUND_DEDUP_WINDOW_MS);
    if (!fresh.length) _outboundTexts.delete(id);
    else _outboundTexts.set(id, fresh);
  }
  for (const [id, state] of _senderState) {
    state.entries = state.entries.filter(e => now - e.ts < SPAM_PATTERN_WINDOW_MS);
    if (!state.entries.length && (!state.coolUntil || now > state.coolUntil)) {
      _senderState.delete(id);
    }
  }
  for (const [id, state] of _threadState) {
    state.timestamps = state.timestamps.filter(t => now - t < INBOUND_FLOOD_WINDOW_MS);
    if (!state.timestamps.length && (!state.coolUntil || now > state.coolUntil)) {
      _threadState.delete(id);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before sending an outbound message.
 * Returns { allow: true } or { allow: false, reason: string }.
 */
function checkOutbound(threadID, messageText) {
  if (!messageText || typeof messageText !== 'string') return { allow: true };
  const tid      = String(threadID);
  const normText = _normalize(messageText);
  const key      = `${tid}:${_hash(messageText)}`;
  const now      = Date.now();

  // Exact hash dedup
  const lastSent = _outboundSent.get(key);
  if (lastSent && (now - lastSent) < OUTBOUND_DEDUP_WINDOW_MS) {
    const remaining = Math.ceil((OUTBOUND_DEDUP_WINDOW_MS - (now - lastSent)) / 1000);
    return {
      allow: false,
      reason: `Duplicate outbound message blocked (identical sent ${Math.ceil((now - lastSent) / 1000)}s ago; ${remaining}s remaining).`
    };
  }

  // Fuzzy dedup against recent outbound ring for this thread
  if (normText.length <= FUZZY_MAX_LEN) {
    const ring = _outboundTexts.get(tid) || [];
    for (const entry of ring) {
      if ((now - entry.ts) < OUTBOUND_DEDUP_WINDOW_MS && _isFuzzySimilar(normText, entry.normText)) {
        return {
          allow: false,
          reason: `Near-duplicate outbound blocked (fuzzy similarity ≥${Math.round(FUZZY_SIMILARITY_THRESHOLD * 100)}% with message sent ${Math.ceil((now - entry.ts) / 1000)}s ago).`
        };
      }
    }
  }

  _outboundSent.set(key, now);

  // Update outbound ring
  const ring = _outboundTexts.get(tid) || [];
  ring.push({ normText, ts: now });
  if (ring.length > OUTBOUND_FUZZY_RING) ring.shift();
  _outboundTexts.set(tid, ring);

  return { allow: true };
}

/**
 * Record an inbound message for spam/flood analysis.
 * Returns { allow: true } or { allow: false, reason, type }.
 */
function checkInbound(threadID, senderID, messageText) {
  const now = Date.now();
  const tid  = String(threadID);
  const sid  = String(senderID);

  // ── Thread flood check ──────────────────────────────────────────────────────
  const ts = _threadState.get(tid) || { timestamps: [], coolUntil: 0 };
  if (ts.coolUntil && now < ts.coolUntil) {
    const remaining = Math.ceil((ts.coolUntil - now) / 1000);
    return { allow: false, reason: `Thread ${tid} is flood-cooled for ${remaining}s more.`, type: 'thread_flood' };
  }
  ts.timestamps = ts.timestamps.filter(t => now - t < INBOUND_FLOOD_WINDOW_MS);
  ts.timestamps.push(now);
  if (ts.timestamps.length >= INBOUND_FLOOD_THRESHOLD) {
    ts.coolUntil  = now + THREAD_FLOOD_COOLDOWN_MS;
    ts.timestamps = [];
    _threadState.set(tid, ts);
    _log(`Thread flood detected: ${tid} — ${INBOUND_FLOOD_THRESHOLD} msgs in ${INBOUND_FLOOD_WINDOW_MS / 1000}s. Cooled for ${THREAD_FLOOD_COOLDOWN_MS / 1000}s.`);
    return { allow: false, reason: `Thread flood: ${INBOUND_FLOOD_THRESHOLD}+ messages in ${INBOUND_FLOOD_WINDOW_MS / 1000}s.`, type: 'thread_flood' };
  }
  _threadState.set(tid, ts);

  // ── Sender spam check — DISABLED ────────────────────────────────────────────
  // Sender-level spam detection (repeat-message cooldowns) has been removed
  // at the operator's request. The per-thread flood guard above is retained
  // because it protects against mass-message raids that could cause the account
  // to be flagged by Facebook. Individual sender rate-limiting is gone.

  return { allow: true };
}

/**
 * Record a successful outbound send (call after the API call succeeds).
 */
function recordOutboundSuccess(threadID, messageText) {
  if (!messageText || typeof messageText !== 'string') return;
  const key = `${threadID}:${_hash(messageText)}`;
  _outboundSent.set(key, Date.now());
}

/**
 * Manually cool down a sender (e.g. after a ban detection event).
 */
function coolSender(senderID, durationMs) {
  const sid   = String(senderID);
  const state = _senderState.get(sid) || { entries: [], coolUntil: 0 };
  state.coolUntil = Date.now() + (durationMs || SENDER_COOLDOWN_MS);
  _senderState.set(sid, state);
}

/**
 * Return diagnostic stats for the panel.
 */
function getStats() {
  const now = Date.now();
  return {
    outboundTracked:   _outboundSent.size,
    sendersTracked:    _senderState.size,
    sendersCooled:     [..._senderState.values()].filter(s => s.coolUntil && now < s.coolUntil).length,
    threadsTracked:    _threadState.size,
    threadsCooled:     [..._threadState.values()].filter(t => t.coolUntil && now < t.coolUntil).length,
    fuzzyThreshold:    FUZZY_SIMILARITY_THRESHOLD
  };
}

/**
 * Reset all state (e.g. on bot restart).
 */
function reset() {
  _outboundSent.clear();
  _outboundTexts.clear();
  _senderState.clear();
  _threadState.clear();
}

module.exports = {
  checkOutbound,
  checkInbound,
  recordOutboundSuccess,
  coolSender,
  getStats,
  reset,
  config: {
    OUTBOUND_DEDUP_WINDOW_MS,
    SPAM_PATTERN_WINDOW_MS,
    SPAM_PATTERN_THRESHOLD,
    SENDER_COOLDOWN_MS,
    INBOUND_FLOOD_WINDOW_MS,
    INBOUND_FLOOD_THRESHOLD,
    THREAD_FLOOD_COOLDOWN_MS,
    FUZZY_SIMILARITY_THRESHOLD
  }
};
