"use strict";

let globalActiveSends = 0;
const sendQueue = [];

// Use AI-seeded randomizer when wired; falls back to Math.random() automatically.
// global._randomizer is set by ZAO.js before any command loads.
function _r(lo, hi) {
  const r = global._randomizer;
  if (r && typeof r.getIntervalSync === "function") return r.getIntervalSync(lo, hi);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function pickJitter(baseMs) {
  const jitterPct = 0.30;
  const delta = baseMs * jitterPct;
  const sign  = _r(0, 1) === 0 ? -1 : 1;
  return Math.max(1000, Math.floor(baseMs + sign * _r(0, delta)));
}

function getNightMultiplier() {
  try {
    const hour = new Date().getHours();
    const cfg = global.config?.stealthMode || {};
    const start = Number(cfg.nightModeStart ?? 1);
    const end   = Number(cfg.nightModeEnd   ?? 6);
    const inNight = start <= end
      ? (hour >= start && hour < end)
      : (hour >= start || hour < end);
    return inNight ? 1.3 : 1.0;
  } catch (_) {
    return 1.0;
  }
}

function shouldDisableOnThreadError(errStr) {
  const s = String(errStr || "").toLowerCase();
  return (
    s.includes("no message_thread") ||
    s.includes("thread may not exist") ||
    s.includes("access may be restricted") ||
    s.includes("not a participant") ||
    // error 1545012 = bot was removed from / is not part of the conversation.
    // nkxfca throws new Error(JSON.stringify({error:1545012,...})) for this case.
    s.includes("1545012") ||
    // "not found" alone is far too broad — Facebook returns it for missing
    // stickers, users, and temporary server errors that are totally transient.
    // Only treat it as fatal when it clearly refers to the thread itself.
    (s.includes("not found") && (s.includes("thread") || s.includes("conversation") || s.includes("inbox")))
  );
}

function isRateLimited(errStr) {
  const s = String(errStr || "").toLowerCase();
  return (
    s.includes("too many requests") ||
    (s.includes("rate") && s.includes("limit")) ||
    s.includes("temporarily blocked") ||
    s.includes("spam")
  );
}

async function acquireSendSlot() {
  const max = global.config?.nkxModern?.maxSendConcurrency || 2;
  if (globalActiveSends < max) {
    globalActiveSends++;
    return;
  }
  await new Promise(resolve => sendQueue.push(resolve));
  globalActiveSends++;
}

function releaseSendSlot() {
  globalActiveSends = Math.max(0, globalActiveSends - 1);
  const next = sendQueue.shift();
  if (next) next();
}


// Track active loops per thread so we can guarantee a single live loop
// even after restarts/restored state (prevents duplicate-send → ban).
// Each entry: { stop, lastSentAt, nextSendAt }
const _activeLoops = new Map();

function scheduleMotorLoop({ api, threadID, getData, onDisable }) {
  // Hard guarantee: only ONE live loop per threadID at any time.
  const prev = _activeLoops.get(threadID);
  if (prev && typeof prev.stop === "function") {
    try { prev.stop(); } catch (_) {}
    _activeLoops.delete(threadID);
  }

  let stopped = false;
  let backoffMs = 0;
  let pendingTimer = null;
  let consecutiveErrors = 0;
  let lastSentAt = null;
  let nextSendAt = null;

  function clearPending() {
    if (pendingTimer) {
      try { clearTimeout(pendingTimer); } catch (_) {}
      pendingTimer = null;
    }
    try {
      const d = getData();
      if (d && d.interval) {
        try { clearTimeout(d.interval); } catch (_) {}
        try { clearInterval(d.interval); } catch (_) {}
        d.interval = null;
      }
    } catch (_) {}
  }

  function isStopped() {
    if (stopped) return true;
    const d = getData();
    if (!d || d.status !== true || !d.message || !d.time) return true;
    return false;
  }

  function _cleanupHandle() {
    if (_activeLoops.get(threadID) === handle) _activeLoops.delete(threadID);
  }

  async function tick() {
    // Outer guard: if anything before the inner try-catch throws (e.g. getData()
    // returning null/undefined on a deleted thread, or isStopped() itself), we
    // catch it here and reschedule rather than letting the Promise reject
    // unhandled, which would silently kill the loop until the 60-s watchdog
    // revives it.
    try {

    if (isStopped()) { _cleanupHandle(); return; }

    const data = getData();
    if (!data) { _cleanupHandle(); return; } // thread row was deleted
    const shouldSend = typeof data.shouldSend === "function" ? data.shouldSend : null;

    const MOTOR_MIN_MS = global.config?.motorSafeSend?.hardMinMs ?? 5000; // hard floor — configurable via ZAO-SETTINGS.json motorSafeSend.hardMinMs
    const nightMult = getNightMultiplier();

    let delay;
    if (backoffMs > 0) {
      delay = backoffMs;
    } else if (data.randomTime && data.randomRange &&
               Number.isFinite(data.randomRange.min) && Number.isFinite(data.randomRange.max) &&
               data.randomRange.max >= data.randomRange.min) {
      const lo = Math.max(MOTOR_MIN_MS, data.randomRange.min);
      const hi = Math.max(lo, data.randomRange.max);
      delay = _r(lo, hi);
      delay = Math.floor(delay * nightMult);
    } else {
      const base = Math.max(MOTOR_MIN_MS, Number(data.time) || 0);
      delay = Math.floor(pickJitter(base) * nightMult);
    }

    // Record when the next send is expected so callers can display it.
    // Also expose whether we're in backoff so status commands can show it.
    nextSendAt = Date.now() + delay;
    if (handle) {
      handle.nextSendAt = nextSendAt;
      handle.backoffMs  = backoffMs > 0 ? backoffMs : 0;
    }

    pendingTimer = setTimeout(async () => {
      pendingTimer = null;
      // Keep nextSendAt visible until the send actually completes so that
      // حالة / status always shows a meaningful timestamp instead of "—".
      if (isStopped()) { nextSendAt = null; if (handle) handle.nextSendAt = null; _cleanupHandle(); return; }

      try {
        // Always prefer the freshest API reference so reconnects are transparent.
        const botApi = global._botApi || api;
        if (!botApi) return;

        if (shouldSend && shouldSend() === false) {
          backoffMs = 0;
          // Reschedule so the loop keeps checking — use hardMinMs if configured, else 10s
          const _recheckMs = (() => { try { const d = getData(); return (d && d.hardMinMs > 0) ? d.hardMinMs : 10000; } catch(_) { return 10000; } })();
          pendingTimer = setTimeout(tick, _recheckMs);
          try { const d = getData(); if (d) d.interval = pendingTimer; } catch (_) {}
          return;
        }

        // NOTE: preSendEvasion() is intentionally NOT called here.
        // Motors are scheduled messages, not command responses — the full
        // evasion sequence (which can add 2-6 minute "session breaks")
        // would silently override the user-configured interval. The motors
        // already have their own randomised timing; no extra delay needed.

        if (isStopped()) return;

        await acquireSendSlot();
        try {
          if (isStopped()) return;

          // ── Typing indicator before send ───────────────────────────────────
          // Sends the "…typing" bubble so the motor looks human to recipients.
          // Delay is proportional to message length (≈ 70 ms/char) so short
          // messages don't over-pause and long ones don't look instant.
          try {
            const liveApiForTyping = global._botApi || api;
            if (typeof liveApiForTyping.sendTypingIndicator === 'function') {
              liveApiForTyping.sendTypingIndicator(threadID, () => {});
            }
            const msgLen   = String(data.message || '').length;
            const typingMs = Math.max(1200, Math.min(4000,
              900 + Math.floor(msgLen * 70) + _r(0, 1500)
            ));
            await new Promise(r => setTimeout(r, typingMs));
          } catch (_) {}

          if (isStopped()) return;
          const p = botApi.sendMessage(data.message, threadID);
          if (p && typeof p.then === "function") await p;
        } finally {
          releaseSendSlot();
        }

        // Successful send — clear the expected-send marker and record timing.
        nextSendAt = null;
        if (handle) handle.nextSendAt = null;
        lastSentAt = Date.now();
        if (handle) handle.lastSentAt = lastSentAt;
        backoffMs = 0;
        consecutiveErrors = 0;
      } catch (e) {
        const errStr = String(e && (e.message || e));
        consecutiveErrors++;

        if (shouldDisableOnThreadError(errStr)) {
          stopped = true;
          clearPending();
          data.status = false;
          _activeLoops.delete(threadID);
          if (typeof onDisable === "function") onDisable(errStr);
          return;
        }

        if (isRateLimited(errStr)) {
          // Cap at 5 minutes so the motor never appears dead for too long.
          const next = backoffMs > 0 ? Math.min(backoffMs * 2, 5 * 60 * 1000) : 2 * 60 * 1000;
          backoffMs = next;
        } else {
          // Generic error — cap at 3 minutes. If errors keep coming,
          // reset backoff after 10 consecutive failures so the loop
          // keeps retrying instead of silently waiting forever.
          if (consecutiveErrors >= 10) {
            backoffMs = 30 * 1000;
            consecutiveErrors = 0;
          } else {
            const next = backoffMs > 0 ? Math.min(backoffMs * 1.5, 3 * 60 * 1000) : 30 * 1000;
            backoffMs = Math.floor(next + _r(0, 5000));
          }
        }
      } finally {
        // Only reschedule via tick() if the try block did NOT already queue
        // a pendingTimer (the no-activity recheck path sets pendingTimer before
        // returning; calling tick() here too would spawn a duplicate loop that
        // compounds on every idle cycle until the motor appears to stop).
        if (pendingTimer !== null) {
          // Already rescheduled inside the try — do nothing here.
        } else if (!isStopped()) {
          tick();
        } else {
          _cleanupHandle();
        }
      }
    }, delay);

    // Mirror the timer handle on data so legacy stop paths still work.
    try { const d = getData(); if (d) d.interval = pendingTimer; } catch (_) {}

    } catch (_tickErr) {
      // Outer safety net: unexpected sync throw before/after the inner try-catch.
      // Reschedule with a short delay so the loop survives without hitting the
      // watchdog's 60-second revival window.
      if (!stopped) {
        pendingTimer = setTimeout(tick, 15000);
        try { const d = getData(); if (d) d.interval = pendingTimer; } catch (_) {}
      }
    }
  }

  const handle = {
    stop: () => {
      stopped = true;
      clearPending();
      _activeLoops.delete(threadID);
    },
    lastSentAt: null,
    nextSendAt: null,
    backoffMs:  0
  };
  _activeLoops.set(threadID, handle);

  tick();

  return handle;
}

function stopMotorLoop(threadID) {
  const h = _activeLoops.get(threadID);
  if (h && typeof h.stop === "function") {
    try { h.stop(); } catch (_) {}
  }
  _activeLoops.delete(threadID);
}

function stopAllMotorLoops() {
  for (const [tid, h] of _activeLoops.entries()) {
    try { h.stop(); } catch (_) {}
    _activeLoops.delete(tid);
  }
}

// Returns true if a live loop is registered for the given threadID.
// Used by the watchdog in engine.js / motor2.js.
function isActiveLoop(threadID) {
  return _activeLoops.has(String(threadID));
}

// Returns timing stats for a thread's loop, or null if no loop is active.
// { lastSentAt: number|null, nextSendAt: number|null, backoffMs: number }
function getLoopStats(threadID) {
  const h = _activeLoops.get(String(threadID));
  if (!h) return null;
  return {
    lastSentAt: h.lastSentAt || null,
    nextSendAt: h.nextSendAt || null,
    backoffMs:  h.backoffMs  || 0
  };
}

function getAllLoops() {
  const out = [];
  for (const [tid, h] of _activeLoops.entries()) {
    out.push({
      threadID:   tid,
      name:       h.name || null,
      lastSentAt: h.lastSentAt || null,
      nextSendAt: h.nextSendAt || null,
      backoffMs:  h.backoffMs  || 0,
    });
  }
  return out;
}

module.exports = { scheduleMotorLoop, stopMotorLoop, stopAllMotorLoops, isActiveLoop, getLoopStats, getAllLoops };
