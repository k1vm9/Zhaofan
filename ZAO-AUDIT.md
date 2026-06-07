# ZAO Bot — Full Production Audit
**Date:** 2026-05-30  
**Scope:** `/includes`, `ZAO.js`, `webpanel/`, `sendPipeline`, key command scaffolding  
**Files examined:** ~25 source files, ~8,000 lines of code reviewed directly  

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| 🔴 Critical | 4 | Can kill the account or cause silent protection failure |
| 🟠 High | 6 | Stealth fingerprints, crash risks, or security gaps |
| 🟡 Medium | 7 | Reliability, performance, or correctness issues |
| 🟢 Low | 5 | Code hygiene, minor quirks |

---

## 🔴 Critical Issues

---

### C-01 — ZAO's own AntiSuspension volume limits are permanently infinite

**File:** `includes/antiSuspension.js` lines 120, 127, 136

```js
maxDailyMessages: 999999999,  // ← effectively ∞
maxPerHour: 999999999,         // ← effectively ∞
maxMessagesPerHour: 999999999  // ← warmup mode also ∞
```

**What this means:**  
ZAO has two anti-suspension layers:
1. The FCA library's internal `globalAntiSuspension` — **patched correctly** by `nkxfcaPatcher.patchAntiSuspensionLimits()` to 3500/day, 280/hour.
2. ZAO's own `AntiSuspension` class in `includes/antiSuspension.js` — **never patched**. Its `isHourlyLimitReached()` and `isDailyLimitReached()` will always return `false`. Per-thread stats are tracked, but volume limits never trigger. The warmup mode throttle also never fires.

The per-thread tracking, the dashboard reporting, the `checkVolumeLimit()` warnings — all run, but the guards that would actually pause sending are dead. ZAO's custom layer is providing false confidence.

**Fix:**  
In `ZAO.js` after `nkxPatcher.patchAntiSuspensionLimits()`, also sync the limits into ZAO's module:

```js
const { globalAntiSuspension } = require('./includes/antiSuspension');
const cfg = global.config || {};
globalAntiSuspension.dailyStats.maxDailyMessages = Number(cfg.maxDailyMessages) || 3500;
globalAntiSuspension.hourlyBucket.maxPerHour     = Number(cfg.maxPerHour)       || 280;
globalAntiSuspension.warmup.maxMessagesPerHour   = Math.round((Number(cfg.maxPerHour) || 280) * 0.4);
```

Or expose a `configure(cfg)` method on the class and call it post-login.

---

### C-02 — Hourly admin health broadcast is a stealth fingerprint

**File:** `includes/accountHealthMonitor.js` (referenced via `ZAO.js`)

A status DM is sent to every admin ID every 60 minutes on a perfectly predictable timer. Facebook's automation detection watches for:
- Automated messages sent at fixed, regular intervals  
- Outgoing DMs to the same IDs on a schedule

This is one of the cleaner bot fingerprints Facebook can act on, because it is regular, programmatic, and to internal IDs (not user-initiated conversations).

**Fix:**
- Change from fixed `setInterval(60 min)` to a jittered window: `55 + Math.random() * 15` minutes  
- Make this disabled by default (currently appears to be `notifyAdmins: true` by default)  
- Send only on status *changes* (healthy → degraded) rather than polling-style reports

---

### C-03 — `sendPipeline.js` uses `require()` inside the hot send path

**File:** `includes/sendPipeline.js` lines 76, 83, 91, 103, 113

```js
api.sendMessage = async function pipelinedSend(msg, threadID, callback, messageID) {
  // ...
  const rl = require("./EnhancedRateLimiter");   // ← inside send, every call
  const wm = require("./SessionWarmupManager");   // ← same
  const ht = require("./humanTyping");             // ← same
  const ot = require("./outgoingThrottle");        // ← same
  const eh = require("./errorHandler");            // ← same (in catch)
```

Node.js caches `require()` so this does not re-parse files. But it still hits the module registry map on every single send call. At high traffic (100+ messages/min), this is five unnecessary Map lookups per send, and it makes the dependency graph invisible to static analysis.

More critically, if **any** of these modules fail to load (startup race condition, bad require path after a move), the error is silently swallowed by the surrounding `try/catch` and the send proceeds without rate limiting or warmup protection — silently broken.

**Fix:** Move all five `require()` calls to the top of the file. Use the cached references inside the function.

---

### C-04 — `autoLockGuard.js` admin DM burst has no per-send delay

**File:** `includes/autoLockGuard.js` lines 154–165

```js
for (const adminID of admins) {
  try { api.sendMessage(msg, id, () => {}); } catch (_) {}
}
```

When a raid triggers a lock, this loop fires `api.sendMessage()` to every admin consecutively without any delay. With 3 admins, that is 3 rapid-fire outgoing DMs within milliseconds — exactly the burst pattern Facebook's automation detector flags.

**Fix:** Add a random 800–2000ms delay between each admin DM:

```js
for (const adminID of admins) {
  await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
  try { api.sendMessage(msg, adminID, () => {}); } catch (_) {}
}
```
(Make the `_sendAdminDM` function async and await it in the caller.)

---

## 🟠 High Issues

---

### H-01 — Global `burstCoolingUntil` in EnhancedRateLimiter silences all threads

**File:** `includes/EnhancedRateLimiter.js` line 43

```js
let burstCoolingUntil = 0;  // module-level, single value for ALL threads
```

When burst cooling triggers (3 limit hits in 25 min), the cooling period blocks **every thread** — not just the thread that caused the burst. A spam attack in Group A causes the bot to go silent in Groups B, C, D during the cooling window (2–6 minutes).

This is a denial-of-service vector: a single bad actor in one group can mute the bot everywhere.

**Fix:** Make `burstCoolingUntil` a `Map()` keyed by `threadID`, so cooling is per-thread only.

---

### H-02 — No CSRF token protection on panel state-changing routes

**File:** `webpanel/zao-server.js` line 1066

The panel uses `sameSite: 'lax'` on the session cookie. `lax` blocks CSRF on top-level navigations but **not on same-origin form posts** from a page the attacker can get the user to visit (e.g., link in a Messenger chat). There are no CSRF tokens on the POST routes that change bot settings, lock/unlock the bot, execute commands, or manage accounts.

If an admin with an active panel session visits a malicious page, that page can send a POST to `http://localhost:5000/config` (or the public Replit URL) and change any setting.

**Fix:**
```js
const crypto = require('crypto');
// On GET login page render, store in session:
req.session.csrfToken = crypto.randomBytes(24).toString('hex');
// On every state-changing POST, verify:
if (req.body._csrf !== req.session.csrfToken) return res.status(403).send('CSRF');
// Include in every form as hidden field:
// <input type="hidden" name="_csrf" value="${csrfToken}">
```

---

### H-03 — `handleCommand.js` runs string similarity on every unrecognized input

**File:** `includes/handle/handleCommand.js`

```js
const match = stringSimilarity.findBestMatch(body, allCommandNames);
```

This runs on every message that doesn't match a known command. With 50+ commands loaded, this is 50+ string similarity calculations per typo or casual message. In a busy group where non-command messages are common, this is constant CPU work. `stringSimilarity.findBestMatch` is O(n × m) where n = command count and m = message length.

**Fix:**
- Gate the check with a quick prefix check first: only run similarity if the message starts with the bot prefix
- Cache the command name array (currently rebuilt on every call?) — verify it's not reconstructed per-event
- Consider a cheaper early exit: if `body.length > 30`, skip similarity (user clearly isn't typing a command name)

---

### H-04 — `antiSuspension.js` internal timers have no `.unref()`

**File:** `includes/antiSuspension.js` lines 139, 140, 147

```js
this._dailyResetInterval  = setInterval(...)  // no .unref()
this._hourlyResetInterval = setInterval(...)  // no .unref()
this._persistInterval     = setInterval(...)  // no .unref()
```

These three intervals keep the process alive even if the bot hits a fatal error and the rest of the code tries to exit. This is low impact in normal operation, but during graceful shutdown or error recovery they can delay the watchdog from detecting the child process has exited.

**Fix:** Add `.unref()` after each:
```js
this._dailyResetInterval = setInterval(...).unref();
```

---

### H-05 — `keepAlive.js` pings 8 endpoints on a predictable schedule

**File:** `includes/keepAlive.js`

Pinging 8 different Facebook endpoints at regular intervals with authenticated cookies creates a detectable network signature. Real users do not access `graph.facebook.com`, `www.facebook.com/ajax/...`, and `business.facebook.com` endpoints in a regular, scripted rotation.

The stealth engine's user-agent rotation helps but does not hide the traffic *timing* pattern.

**Fix:**
- Reduce to 2–3 of the most realistic endpoints (the ones real mobile apps actually hit)
- Apply jitter of ±40% to the interval, not just ±15%
- Wrap individual pings in sleep mode awareness: skip pings during sleep hours

---

### H-06 — `autoRelogin.js` notifies admins before confirming tier switch succeeded

**File:** `includes/login/autoRelogin.js`

The "Switching to tier X" DM is sent to admins before the login attempt with the new tier's cookies. If that login fails, admins received a notification about a switch that never happened, and no failure notification is sent. On repeated tier exhaustion, admins receive up to 5 misleading notifications.

**Fix:** Move the admin DM to the success callback path, after the new tier is confirmed live.

---

## 🟡 Medium Issues

---

### M-01 — `sendPipeline.js` passes raw `msg` object to `humanTyping.calcDelay()`

**File:** `includes/sendPipeline.js` line 93

```js
const delay = ht.calcDelay(msg);
```

When `api.sendMessage` is called with an object (`{body: "hello", attachment: ...}`), `msg` is a plain object. If `calcDelay()` calls `.length` on it or tries to compute delay from its text, it receives `undefined` or `"[object Object]"`. The typing delay becomes meaningless or zero.

**Fix:**
```js
const msgText = typeof msg === 'string' ? msg : (msg && msg.body) || '';
const delay = ht.calcDelay(msgText);
```

---

### M-02 — `commandSandbox.js` 90-second default timeout is too long

**File:** `includes/commandSandbox.js` line 18

```js
const DEFAULT_TIMEOUT_MS = 90 * 1000;
```

90 seconds is the max for slow YouTube/image APIs, but the default for ALL commands. A command that hangs for 90 seconds holds a memory allocation (the promise, its closure, the AbortController) for the full duration. With 10 concurrent stuck commands, that's 15 minutes of accumulated hung memory. Commands that are purely text-based (8ball, uid, weather cached) should have a much tighter timeout.

**Fix:** Expose a `timeout` config per command in the command manifest, e.g.:
```js
module.exports.timeout = 15000; // override default for fast commands
```
Set the default to 30 seconds. Keep 90 seconds available as an opt-in for slow media commands.

---

### M-03 — `messageHashGuard.js` inbound sender-level deduplication disabled

**File:** `includes/messageHashGuard.js`

The comment documents this was "disabled by operator request." This means identical commands from the same user in the same thread are processed multiple times (e.g., double-tap sends). The only remaining protection is the thread-level flood guard.

This is a **known intentional choice**, but it should be documented clearly in `ZAO-SETTINGS.json` as a toggle (`hashGuard.perSenderEnabled: false`) rather than a hardcoded comment, so it can be re-enabled without a code deploy.

---

### M-04 — `autoRelogin.js` uses `require()` for ZAO-SETTINGS.json

**File:** `includes/login/autoRelogin.js`

```js
const settings = require("../../ZAO-SETTINGS.json");
```

Node.js caches this at first load. Runtime changes to `ZAO-SETTINGS.json` (e.g., from the panel's Settings tab) are not reflected in subsequent calls to `_getCooldownMs()` or `_getMaxRetries()`. The cooldown and retry values come from the cached (stale) version.

**Fix:** Replace with:
```js
const settings = global.config || JSON.parse(require('fs').readFileSync('./ZAO-SETTINGS.json', 'utf8'));
```

---

### M-05 — `stringSimilarity.findBestMatch()` called without checking if `allCommandNames` is empty

**File:** `includes/handle/handleCommand.js`

If commands fail to load (disk error, syntax error in a command file), `allCommandNames` could be an empty array. Passing an empty array to `findBestMatch()` causes it to throw or return `undefined.bestMatch`, crashing the handler.

**Fix:**
```js
if (allCommandNames.length > 0) {
  const match = stringSimilarity.findBestMatch(body, allCommandNames);
  // ...
}
```

---

### M-06 — `EnhancedRateLimiter.js` cooling config not read from `global.config`

**File:** `includes/EnhancedRateLimiter.js`

The `DEFAULT_CONFIG` object is hardcoded at module load time. If the user changes rate limit settings via the panel, those changes never reach the limiter (it keeps the original defaults). The antiSuspension module correctly re-reads from `global.config` on every call via `_getCfg()` — the rate limiter should do the same.

**Fix:** Replace `DEFAULT_CONFIG` usage with a `_getCfg()` helper that reads from `global.config.rateLimit || DEFAULT_CONFIG` at call time.

---

### M-07 — Three parallel wrapping layers on `api.sendMessage`

There are up to 3 simultaneous wrappers stacked on `api.sendMessage`:
1. `sendPipeline.patch(api)` — rate limit, warmup, typing, throttle  
2. `nkxfcaModernizer` — async queue, typing, human delay  
3. (referenced) accountHealthMonitor wrapper — tracks outgoing messages  

These wrappers don't coordinate. A message may get two rounds of typing simulation (one from the pipeline, one from the modernizer), though the `__nkxModernized` flag tries to skip the pipeline's typing step. The healthMonitor wrapper exists as a separate independent patch outside `sendPipeline`.

**Fix:** Audit that only ONE typing delay is applied per send. Verify the modernizer's `__nkxModernized` flag is set before `sendPipeline.patch()` is called, so the flag check works correctly. Consolidate all monitoring into `sendPipeline.js` Steps and remove the healthMonitor wrapper.

---

## 🟢 Low / Code Quality Issues

---

### L-01 — `DeveloperMode == !![]` is confusing

**File:** `includes/handle/handleCommand.js`

```js
if (DeveloperMode == !![])) { ... }
```

`!![]` is always `true` in JavaScript. This is equivalent to `if (DeveloperMode == true)`. Use `if (DeveloperMode === true)` for clarity and to use strict equality.

---

### L-02 — RAW event logging exposes senderID on every single message

**File:** `includes/listen.js`

Every incoming message logs a `[RAW]` line containing `senderID` and `threadID`. In busy group chats this is hundreds of PII-containing log lines per hour, making log files large and potentially leaking Facebook user IDs into any log aggregator.

**Fix:** Guard with a `DEBUG_RAW` flag that defaults to `false`, or log only `threadID` (not senderID) at the INFO level.

---

### L-03 — `autoLockGuard.js` `_senderWarned` Set is never cleared on unlock

**File:** `includes/autoLockGuard.js`

`setLock(false)` calls `_senderWarned.clear()` but only on **manual** unlock. If the lock expires automatically via `_scheduleUnlock`, `_senderWarned` is never cleared. The same sender may not receive a warning on the next raid trigger even if they have been quiet for hours.

---

### L-04 — `commandErrorBudget.js` persists trip state but not error history

**File:** `includes/commandErrorBudget.js`

Trips are persisted to disk so a restart doesn't reset them. But `errorTimes` (the rolling error window) is not persisted. After a restart, a command that had 5 errors in the last 14 minutes will appear clean — one more error won't trip it. This can be intentional (give commands a fresh window on restart) but creates a restart-as-escape-hatch pattern where crashing the bot resets error budgets.

---

### L-05 — `stealthEngineV2.js` UA pool mixes browser and app fingerprints

**File:** `includes/stealthEngineV2.js` lines 85–100

The user-agent pool includes Android Chrome browser UAs mixed with Facebook App (FBiOS/FBAN) UAs. The underlying MQTT connection uses the Facebook app protocol, not the browser protocol. If Facebook correlates the UA header sent in Layer 2 HTTP requests with the MQTT connection fingerprint, a browser UA on an app-protocol connection is a mismatch fingerprint.

**Fix:** Keep HTTP layer UAs and MQTT layer UAs in separate pools. HTTP keepalive pings should use browser UAs. MQTT should use app UAs that match the connection's actual client type.

---

## Architecture Observations

These are not bugs but patterns worth being aware of:

**Two-process watchdog** (`Main.js` → `ZAO.js`) is a solid design. The web panel survives bot crashes cleanly.

**Atomic file writes** (`utils/atomicWrite.js`) are correctly used for cookies and settings. This is the right approach and has been applied consistently.

**`commandSandbox.js`** is a good addition. Repeat-offender detection is particularly useful.

**`commandErrorBudget.js`** graduated trip durations (30min → 1h → 2h) with disk persistence is a well-thought-out feature.

**`autoLockGuard.js` v3** persistent escalation counter (survives restarts) is correct and thorough.

**`sendPipeline.js`** centralizing all outgoing middleware into one ordered chain was the right architectural decision. The main gap is that not all wrappers are fully consolidated yet (see M-07).

---

## Priority Fix Order

| Priority | Issue | Risk if left |
|----------|-------|-------------|
| 1 | **C-01** AntiSuspension volume limits = ∞ | Volume-based suspension |
| 2 | **C-02** Hourly admin broadcast schedule | Stealth fingerprint → ban |
| 3 | **H-01** Global burst cooling affects all threads | DoS by single bad actor |
| 4 | **C-04** Admin DM burst on lock event | Automation pattern |
| 5 | **H-02** No CSRF on panel routes | Admin account takeover |
| 6 | **C-03** `require()` in send hot path | Silent middleware failures |
| 7 | **H-06** Admin notified before tier switch confirmed | Misleading notifications |
| 8 | **M-01** `msg` object passed to `calcDelay()` | Wrong typing delays |
| 9 | **M-06** Rate limiter ignores runtime config changes | Panel settings ignored |
| 10 | **M-07** Triple-wrapped `sendMessage` | Double typing delays |

---

## Quick Wins (minimal code changes, high impact)

1. **C-01 fix is ~4 lines** in `ZAO.js` post-login — highest return for lowest effort  
2. **C-03 fix** — move 5 `require()` calls to the top of `sendPipeline.js` — 30 seconds of work  
3. **L-01** — change `!![]` to `true` — one character  
4. **M-01** — add `typeof msg === 'string' ? msg : msg.body` guard — one line  
5. **H-04** — add `.unref()` to 3 timers in `antiSuspension.js` — three characters × 3  
6. **M-05** — guard `findBestMatch` with `if (allCommandNames.length > 0)` — one line  

---

*Audit completed: 2026-05-30. All findings are based on static analysis of source code. No live account was used for testing.*
