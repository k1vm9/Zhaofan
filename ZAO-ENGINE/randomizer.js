"use strict";

/**
 * randomizer.js — AI-powered interval randomizer v1.9
 *
 * Flow (2-call AI chain per batch):
 *   1. Ask AI to generate a creative prompt requesting N random decimal values (0-1)
 *   2. Send that prompt; parse the floats from the response
 *   3. Store them in a pool; callers draw from the pool synchronously
 *   4. Pool auto-refills in the background — callers never block
 *
 * If OpenRouter is unavailable the pool runs dry and getIntervalSync() / random()
 * fall back silently to Math.random() — the bot keeps running.
 *
 * v1.9 fixes:
 *   - Added random() export — returns a 0-1 float from the AI pool (was missing;
 *     ZAO.js calls global._randomizer.random() which threw a silent TypeError).
 *   - validateKey() uses a hardcoded reliable probe model, not the settings model.
 *     This prevents startup failures caused by an invalid model in settings.
 *   - validateKey() treats HTTP 429 as "key valid but rate-limited" — warns and
 *     continues instead of throwing.  The bot was staying in Math.random() fallback
 *     forever because the 550B nemotron model (wrong ID) always returned 429/404.
 *   - 30-minute validation cache: restarts within the cooldown window skip the
 *     probe call entirely, avoiding unnecessary rate-limit pressure.
 */

const axios = require("axios");
const path  = require("path");
const fs    = require("fs");

const SETTINGS_PATH = path.join(__dirname, "..", "ZAO-SETTINGS.json");
const POOL_TARGET   = 40;    // keep this many pre-fetched fractions ready
const BATCH_SIZE    = 12;    // fractions to request per AI round-trip
const REFILL_LOW    = 15;    // start refill when pool drops below this
const PROBE_TIMEOUT = 14000;
const CALL_TIMEOUT  = 12000;

// Hardcoded reliable probe model — small, always available on OpenRouter free tier.
// We intentionally do NOT use the settings model for the probe so a misconfigured
// model name can't block bot startup.
const PROBE_MODEL = "meta-llama/llama-3.1-8b-instruct:free";

// Validation cache — skip the probe call if we validated within this window.
// Prevents rate-limit pressure from repeated restarts (watchdog/crash loops).
const VALIDATE_CACHE_MS = 30 * 60 * 1000;  // 30 minutes
let _lastValidatedAt = 0;

let _key       = "";
let _model     = "meta-llama/llama-3.1-8b-instruct:free";
let _pool      = [];
let _filling   = false;
let _validated = false;

const _status = {
  ok:           false,
  mode:         "fallback",
  lastCallAt:   null,
  failCount:    0,
  failStreak:   0,
  lastError:    null,
  totalAiCalls: 0,
  poolSize:     0,
};

// ─── Settings loader ──────────────────────────────────────────────────────
function _loadKey() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    _key = (s.openrouterKeyInternal || "").trim();
    const models = Array.isArray(s.openrouterModelsInternal) ? s.openrouterModelsInternal : [];
    // Use first valid model from settings; fall back to reliable default
    const firstValid = models.find(m => m && m.trim());
    _model = firstValid || "meta-llama/llama-3.1-8b-instruct:free";
  } catch (_) {}
}

// ─── Single OpenRouter call ────────────────────────────────────────────────
async function _aiCall(prompt, model, timeoutMs = CALL_TIMEOUT) {
  if (!_key) throw new Error("openrouterKeyInternal is empty");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model:       model || _model,
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  200,
      temperature: 1.1,
    },
    {
      headers: {
        Authorization:  `Bearer ${_key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://zao-bot.local",
        "X-Title":      "ZAO Bot Randomizer",
      },
      timeout: timeoutMs,
    }
  );
  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenRouter");
  return content.trim();
}

// ─── Extract floats from AI text ──────────────────────────────────────────
function _parseFloats(text) {
  const raw = text.match(/\b0?\.\d{2,6}\b|\b1\.0{2,6}\b/g) || [];
  return raw
    .map(v => parseFloat(v))
    .filter(v => !isNaN(v) && v >= 0 && v <= 1)
    .slice(0, BATCH_SIZE);
}

// ─── Background pool filler ────────────────────────────────────────────────
async function _fillPool() {
  if (_filling) return;
  if (_pool.length >= POOL_TARGET) return;
  _loadKey();
  if (!_key) return;
  _filling = true;

  try {
    // === Call 1: generate a creative prompt requesting decimal fractions ===
    const metaPrompt =
      `Invent a short, imaginative, unique question that asks someone to pick ` +
      `${BATCH_SIZE} random decimal numbers strictly between 0 and 1 (e.g. 0.37, 0.82). ` +
      `Make the question novel and unexpected each time — not the same wording as before. ` +
      `End by explicitly requesting ${BATCH_SIZE} decimal numbers on separate lines. ` +
      `Keep the total under 55 words.`;

    const creativePrompt = await _aiCall(metaPrompt, _model);

    // === Call 2: get the actual numbers using that prompt ===
    const numberPrompt =
      `${creativePrompt}\n\n` +
      `(Important: reply with ONLY ${BATCH_SIZE} decimal numbers between 0 and 1, ` +
      `one per line, no words, no labels, no explanations.)`;

    const response = await _aiCall(numberPrompt, _model);
    const values   = _parseFloats(response);

    if (values.length < 2) throw new Error(`Only got ${values.length} usable values`);

    _pool.push(...values);
    if (_pool.length > POOL_TARGET * 2) _pool = _pool.slice(-POOL_TARGET);

    _status.ok         = true;
    _status.mode       = "ai";
    _status.lastCallAt = Date.now();
    _status.failStreak = 0;
    _status.totalAiCalls += 2;
  } catch (e) {
    _status.failCount++;
    _status.failStreak++;
    _status.lastError = e.message;
    if (_status.failStreak >= 3) {
      _status.ok   = false;
      _status.mode = "fallback";
    }
  } finally {
    _filling         = false;
    _status.poolSize = _pool.length;
  }
}

// ─── Startup key validation ────────────────────────────────────────────────
/**
 * Call this at bot startup. Throws only if the key is completely absent.
 * Rate-limit errors (429) and model-not-found errors are treated as
 * "key valid but degraded" — the bot continues with Math.random() fallback
 * and background refill will pick up AI mode as soon as the rate limit clears.
 *
 * A 30-minute cache prevents re-probing on rapid restarts (watchdog loops).
 */
async function validateKey() {
  _loadKey();
  if (!_key) {
    throw new Error(
      "openrouterKeyInternal is empty in ZAO-SETTINGS.json.\n" +
      "Get a free key at https://openrouter.ai/keys and set openrouterKeyInternal in ZAO-SETTINGS.json"
    );
  }

  // ── 30-min validation cache ────────────────────────────────────────────
  if (_validated && Date.now() - _lastValidatedAt < VALIDATE_CACHE_MS) {
    // Already validated recently — skip the probe call
    setImmediate(() => _fillPool().catch(() => {}));
    return true;
  }

  // ── Probe call using reliable model, not the settings model ───────────
  let reply;
  try {
    reply = await _aiCall("Reply with only the number 7.", PROBE_MODEL, PROBE_TIMEOUT);
  } catch (e) {
    const status = e.response?.status;

    // 429 = rate limited — the key exists and works, just too many calls right now.
    // 402 = key over quota but valid. Both are NOT key-invalid errors.
    if (status === 429 || status === 402) {
      // Warn but continue — pool will fill later when rate limit clears
      _validated        = true;
      _lastValidatedAt  = Date.now();
      _status.ok        = false;
      _status.mode      = "fallback";
      _status.lastError = `Rate-limited (${status}) — will retry in background`;
      setImmediate(() => _fillPool().catch(() => {}));
      // Return normally — ZAO.js treats this as a warning, not a fatal error
      return true;
    }

    // 401 / 403 = genuinely invalid key
    if (status === 401 || status === 403) {
      throw new Error(`OpenRouter API key rejected (HTTP ${status}) — check openrouterKeyInternal in ZAO-SETTINGS.json`);
    }

    // Network error or unexpected status — warn and continue
    _status.lastError = `Probe failed: ${e.message}`;
    _status.mode      = "fallback";
    setImmediate(() => _fillPool().catch(() => {}));
    return true;
  }

  if (!reply || !/7/.test(reply)) {
    // Unexpected response but key was accepted — treat as degraded, not fatal
    _status.lastError = `Probe returned unexpected reply: "${reply?.slice(0, 40)}"`;
    _status.mode      = "fallback";
    setImmediate(() => _fillPool().catch(() => {}));
    return true;
  }

  _validated           = true;
  _lastValidatedAt     = Date.now();
  _status.ok           = true;
  _status.mode         = "ai";
  _status.totalAiCalls++;

  // Start filling pool in background — don't block startup
  setImmediate(() => _fillPool().catch(() => {}));
  return true;
}

// ─── Public: random() — drop-in replacement for Math.random() ─────────────
/**
 * Returns a random float in [0, 1) drawn from the AI pool.
 * Falls back to Math.random() if pool is empty.
 * This is the synchronous zero-argument form used by ZAO.js name-lock timers.
 */
function random() {
  if (_pool.length > 0) {
    const fraction = _pool.shift();
    _status.poolSize = _pool.length;
    if (_pool.length < REFILL_LOW) {
      setImmediate(() => _fillPool().catch(() => {}));
    }
    return fraction;
  }
  // Pool empty — use Math.random() and trigger async refill
  if (!_filling) setImmediate(() => _fillPool().catch(() => {}));
  if (_status.mode === "ai") _status.mode = "fallback";
  return Math.random();
}

// ─── Public: async version (awaitable) ────────────────────────────────────
async function getInterval(minMs, maxMs) {
  return getIntervalSync(minMs, maxMs);
}

// ─── Public: sync version (drop-in for Math.random() range calls) ─────────
/**
 * Returns a random integer in [minMs, maxMs] synchronously.
 * Uses AI-seeded entropy from pool; falls back to Math.random() if pool empty.
 */
function getIntervalSync(minMs, maxMs) {
  const fraction = random();
  return Math.floor(minMs + fraction * (maxMs - minMs + 1));
}

// ─── Manual refill trigger (for test button in panel) ─────────────────────
async function refillNow() {
  _pool          = [];
  _status.failStreak = 0;
  await _fillPool();
  return getStatus();
}

// ─── Status (for panel widget) ────────────────────────────────────────────
function getStatus() {
  return {
    ok:           _status.ok,
    mode:         _status.mode,
    lastCallAt:   _status.lastCallAt,
    failCount:    _status.failCount,
    failStreak:   _status.failStreak,
    lastError:    _status.lastError,
    totalAiCalls: _status.totalAiCalls,
    poolSize:      _pool.length,
    validated:    _validated,
    model:        _model,
  };
}

module.exports = { validateKey, getInterval, getIntervalSync, random, getStatus, refillNow };
