'use strict';

/**
 * CrashFingerprinter — tracks, deduplicates, and stores recurring crash
 * signatures from the bot subprocess so the operator can identify which
 * exact code path is causing repeated restarts.
 *
 * How fingerprinting works:
 *  1. The launcher feeds every stdout/stderr line through feedLine().
 *  2. On each crash (recordCrash) the last N lines are scanned:
 *       a. Find the first "Xxxx Error: <message>" line  → errorType + errorMsg
 *       b. Find the first "at <frame>" line             → topFrame (normalised)
 *  3. A stable key is built from  errorType + ":" + topFrame (paths stripped).
 *  4. That key maps to a record: count / exitCode / firstSeen / lastSeen / snippet.
 *  5. Everything is persisted to STORE_PATH so restarts don't lose history.
 */

const fs   = require('fs');
const path = require('path');

const STORE_PATH      = path.join(__dirname, '..', 'includes', 'crashFingerprints.json');
const RING_SIZE       = 120;   // lines kept per run
const MAX_SIGNATURES  = 50;    // maximum unique fingerprints stored
const SNIPPET_LINES   = 15;    // context lines saved per crash

// ── helpers ──────────────────────────────────────────────────────────────────

function _normaliseFrame(frame) {
  // Strip absolute paths and keep only filename:line:col
  // "at Object.<anonymous> (/home/runner/workspace/ZAO.js:123:45)"
  //  → "ZAO.js:123:45"
  return frame
    .replace(/\(.*[/\\]([^/\\]+:\d+:\d+)\)/g, '($1)')   // strip dir, keep file:line:col
    .replace(/at\s+/, '')
    .trim()
    .slice(0, 120);
}

function _extractSignature(lines) {
  let errorType = 'UnknownError';
  let errorMsg  = '';
  let topFrame  = 'unknown';

  const ERROR_RE  = /^(\w*Error):\s*(.+)$/;
  const FRAME_RE  = /^\s+at\s+/;

  for (const line of lines) {
    const stripped = line.replace(/\x1B\[[0-9;]*m/g, '').trim();

    if (!errorMsg) {
      const m = stripped.match(ERROR_RE);
      if (m) {
        errorType = m[1];
        // truncate long messages so the key stays manageable
        errorMsg  = m[2].slice(0, 120);
      }
    }

    if (topFrame === 'unknown' && FRAME_RE.test(stripped)) {
      topFrame = _normaliseFrame(stripped);
    }

    if (errorMsg && topFrame !== 'unknown') break;
  }

  const key = `${errorType}::${topFrame}`;
  return { key, errorType, errorMsg, topFrame };
}

// ── persistence ──────────────────────────────────────────────────────────────

function _load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && Array.isArray(data.signatures)) {
      return data;
    }
  } catch (_) {}
  return { signatures: [] };
}

function _save(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (_) {}
}

// ── module state ─────────────────────────────────────────────────────────────

let _store = _load();

// Rolling ring-buffer of lines for the *current* bot run
const _ring = [];

// ── public API ───────────────────────────────────────────────────────────────

/**
 * feedLine(line) — call for every stdout/stderr line emitted by the bot child.
 */
function feedLine(line) {
  if (typeof line !== 'string') return;
  _ring.push(line.slice(0, 500));   // cap individual line length
  if (_ring.length > RING_SIZE) _ring.shift();
}

/**
 * recordCrash(exitCode) — call when the bot child exits with a non-zero code.
 * Extracts the fingerprint from the current ring, deduplicates, and persists.
 */
function recordCrash(exitCode) {
  const snippet = _ring.slice(-SNIPPET_LINES);
  _ring.length  = 0;   // reset for next run

  const { key, errorType, errorMsg, topFrame } = _extractSignature(snippet);
  const now = Date.now();

  let existing = _store.signatures.find(s => s.key === key);
  if (existing) {
    existing.count++;
    existing.lastSeen  = now;
    existing.exitCode  = exitCode;   // update to most recent code
    existing.snippet   = snippet;
  } else {
    // Enforce max — evict the least-seen entry when full
    if (_store.signatures.length >= MAX_SIGNATURES) {
      _store.signatures.sort((a, b) => a.count - b.count);
      _store.signatures.shift();
    }
    _store.signatures.push({
      key,
      errorType,
      errorMsg,
      topFrame,
      count:     1,
      exitCode,
      firstSeen: now,
      lastSeen:  now,
      snippet
    });
  }

  // Sort descending by count so the worst offenders appear first
  _store.signatures.sort((a, b) => b.count - a.count);

  _save(_store);

  // Upgrade #5: alert admins when a crash repeats 3+ times
  const updatedEntry = _store.signatures.find(s => s.key === key);
  if (updatedEntry && updatedEntry.count >= 3 && updatedEntry.count % 3 === 0) {
    try {
      const api    = global.api || (global.client && global.client.api);
      const admins = (global.config && global.config.ADMINBOT) || [];
      if (api && admins.length) {
        const msg =
          `🔴 تنبيه: عطل متكرر في البوت!\n\n` +
          `نوع الخطأ: ${errorType}\n` +
          `الرسالة: ${String(errorMsg).slice(0, 120)}\n` +
          `عدد مرات التكرار: ${updatedEntry.count}\n` +
          `المكان: ${topFrame}\n\n` +
          `راجع تبويب Crashes في لوحة التحكم للتفاصيل.`;
        for (const adminID of admins) {
          const id = String(adminID).trim();
          if (!id) continue;
          try { api.sendMessage(msg, id, () => {}); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  return { key, errorType, errorMsg, topFrame };
}

/**
 * getReport() — returns the full signature list plus summary stats.
 */
function getReport() {
  const sigs = _store.signatures;
  const total = sigs.reduce((s, x) => s + x.count, 0);
  const repeated = sigs.filter(x => x.count > 1).length;
  return {
    summary: {
      uniqueSignatures: sigs.length,
      totalCrashes:     total,
      repeatedPatterns: repeated
    },
    signatures: sigs.map(s => ({
      key:       s.key,
      errorType: s.errorType,
      errorMsg:  s.errorMsg,
      topFrame:  s.topFrame,
      count:     s.count,
      exitCode:  s.exitCode,
      firstSeen: s.firstSeen,
      lastSeen:  s.lastSeen,
      snippet:   s.snippet
    }))
  };
}

/**
 * clearAll() — wipes the stored signatures.
 */
function clearAll() {
  _store = { signatures: [] };
  _save(_store);
}

module.exports = { feedLine, recordCrash, getReport, clearAll };
