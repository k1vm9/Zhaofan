"use strict";

/**
 * randomizer.js — AI-powered interval randomizer
 *
 * Flow (2-call AI chain per batch):
 *   1. Ask AI to generate a creative prompt asking for N random decimal values (0–1)
 *   2. Send that prompt; parse the floats from the response
 *   3. Store them in a pool; callers draw from the pool synchronously
 *   4. Pool auto-refills in the background — callers never block
 *
 * If OpenRouter is unavailable the pool runs dry and getIntervalSync() falls
 * back silently to Math.random() — the bot keeps running.
 *
 * Startup gate:
 *   validateKey() MUST be awaited before the bot starts. It sends a probe
 *   call to OpenRouter. If the key is missing or rejected, it throws and the
 *   caller should exit(1).
 */

const axios = require("axios");
const path  = require("path");
const fs    = require("fs");

const SETTINGS_PATH = path.join(__dirname, "..", "ZAO-SETTINGS.json");
const POOL_TARGET   = 40;   // keep this many pre-fetched fractions ready
const BATCH_SIZE    = 12;   // fractions to request per AI round-trip
const REFILL_LOW    = 15;   // start refill when pool drops below this
const PROBE_TIMEOUT = 14000;
const CALL_TIMEOUT  = 12000;

let _key       = "";
let _model     = "openai/gpt-3.5-turbo";
let _pool      = [];
let _filling   = false;
let _validated = false;

const _status = {
  ok:         false,
  mode:       "fallback",
  lastCallAt: null,
  failCount:  0,
  failStreak: 0,
  lastError:  null,
  totalAiCalls: 0,
  poolSize:   0,
};

// ─── Settings loader ──────────────────────────────────────────────────────
function _loadKey() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    _key   = (s.openrouterKeyInternal || "").trim();
    const models = Array.isArray(s.openrouterModelsInternal) ? s.openrouterModelsInternal : [];
    _model = models[0] || "openai/gpt-4o-mini";
  } catch (_) {}
}

// ─── Single OpenRouter call ────────────────────────────────────────────────
async function _aiCall(prompt, timeoutMs = CALL_TIMEOUT) {
  if (!_key) throw new Error("openrouterKeyInternal is empty");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model:      _model,
      messages:   [{ role: "user", content: prompt }],
      max_tokens: 200,
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

    const creativePrompt = await _aiCall(metaPrompt);

    // === Call 2: get the actual numbers using that prompt ===
    const numberPrompt =
      `${creativePrompt}\n\n` +
      `(Important: reply with ONLY ${BATCH_SIZE} decimal numbers between 0 and 1, ` +
      `one per line, no words, no labels, no explanations.)`;

    const response = await _aiCall(numberPrompt);
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
    _filling    = false;
    _status.poolSize = _pool.length;
  }
}

// ─── Startup key validation ────────────────────────────────────────────────
/**
 * Call this at bot startup. Throws if the key is missing or invalid.
 * On success: starts filling the pool in background.
 */
async function validateKey() {
  _loadKey();
  if (!_key) {
    throw new Error(
      "openrouterKeyInternal is empty in ZAO-SETTINGS.json.\n" +
      "The ZAO randomizer requires a working OpenRouter key to start.\n" +
      "Get a free key at https://openrouter.ai/keys and set openrouterKeyInternal in ZAO-SETTINGS.json"
    );
  }

  let reply;
  try {
    reply = await _aiCall("Reply with only the number 7.", PROBE_TIMEOUT);
  } catch (e) {
    throw new Error(`OpenRouter API key validation failed: ${e.message}`);
  }

  if (!reply || !/7/.test(reply)) {
    throw new Error(`OpenRouter returned unexpected probe response: "${reply}"`);
  }

  _validated        = true;
  _status.ok        = true;
  _status.mode      = "ai";
  _status.totalAiCalls++;

  // Start filling pool in background — don't block startup
  setImmediate(() => _fillPool().catch(() => {}));
  return true;
}

// ─── Public: async version (awaitable) ───────────────────────────────────
/**
 * Returns a random integer in [minMs, maxMs].
 * Draws from AI pre-fetched pool when available, else Math.random().
 */
async function getInterval(minMs, maxMs) {
  return getIntervalSync(minMs, maxMs);
}

// ─── Public: sync version (drop-in for Math.random() calls) ───────────────
/**
 * Returns a random integer in [minMs, maxMs] synchronously.
 * Uses AI-seeded entropy from pool; falls back to Math.random() if pool empty.
 */
function getIntervalSync(minMs, maxMs) {
  let fraction;

  if (_pool.length > 0) {
    fraction = _pool.shift();
    _status.poolSize = _pool.length;
    if (_pool.length < REFILL_LOW) {
      setImmediate(() => _fillPool().catch(() => {}));
    }
  } else {
    // Pool empty — use Math.random() and trigger async refill
    fraction = Math.random();
    if (!_filling) setImmediate(() => _fillPool().catch(() => {}));
    if (_status.mode === "ai") {
      _status.mode = "fallback";
    }
  }

  return Math.floor(minMs + fraction * (maxMs - minMs + 1));
}

// ─── Manual refill trigger (for test button) ─────────────────────────────
async function refillNow() {
  _pool = [];
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
    poolSize:     _pool.length,
    validated:    _validated,
    model:        _model,
  };
}

module.exports = { validateKey, getInterval, getIntervalSync, getStatus, refillNow };
