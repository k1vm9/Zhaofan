---
name: ZAO-ENGINE architecture
description: Describes the ZAO-ENGINE directory, what it replaces, what was dropped, the stub pattern, and the final wiring in ZAO.js.
---

# ZAO-ENGINE Architecture

## What it is
`ZAO-ENGINE/` is a lean security + session engine that replaced the old `/includes/` directory.
Old includes/ is archived as `_includes/` — not deleted.

## Why
ZAO had too many competing security layers that caused crashes after a few hours. David's bot with 20 simple layers stayed up for weeks.

## What's in ZAO-ENGINE (proven, simple)
- `fca.js` — login wrapper: cookie parsing (5 formats), UA pool, sendMessageHuman, buildReplyHelper, thread cache, `cookiesToString()`
- `stealth.js` — presence loop: hits 6 rotating FB endpoints every 8-20 min with mobile UA, respects sleep hours. Has `updateApi(api)` for hot-swap and `getStatus()`.
- `humanTyping.js` — wraps sendMessage with typing indicator delay (500-8000ms)
- `humanReadReceipt.js` — marks messages read after 800-3500ms delay
- `outgoingThrottle.js` — `check(tid)` for pipeline use (per-thread + global gap); also standalone `start(api)` wrapper. Has `getStatus()`.
- `duplicateGuard.js` — blocks double-sends within 8s window per thread
- `rateLimit.js` — simple sliding-window rate limiter. Cleanup interval uses `.unref()`. Has `getCount()`.
- `antiDetection.js` — jitter on react/unsend (200-900ms) + UA rotation every 25-35 min. Idempotent for same api; safe to call with new api (replaces timer, re-wraps methods guarded by `__jitter_<method>` flag).
- `keepAlive.js` — ping + cookie save + dtsg refresh + notification visit
- `sessionGuard.js` — 3-layer session preservation. `REQUIRED_COOKIES = ["c_user", "xs"]` — datr is OPTIONAL (its absence caused false alarms).
- `cookieSnapshot.js` — ring buffer of valid AppState snapshots in backups/
- `checkLiveCookie.js` — triple-URL validator
- `login/autoRelogin.js` — tier walk-forward relogin; both success paths do process.exit(0) so no live api hand-off needed
- `sendPipeline.js` — centralised send chain: drain→duplicate(1.5)→rateLimit→warmup→humanTyping→outgoingThrottle.check()→send→errorRecord. Patched onto api once after login.

## Stub pattern for dropped over-engineered modules
Dropped modules are stubbed (not deleted) so ZAO.js try/catch stays clean:
- `eventLoopGuard.js` / `diskGuard.js` → pure no-ops (caused false-positive restarts)
- `stealthEngineV2.js` → delegates to stealth.js
- `stealthEngine.js` → wraps stealth.js getStatus()
- `EnhancedRateLimiter.js` → delegates to rateLimit.js
- `RequestPacingEngine.js`, `SessionWarmupManager.js`, `OnlinePresenceEngine.js` → no-ops
- `crashFingerprinter.js` → feedLine() + recordCrash() no-ops (Main.js calls both directly — NOT in try/catch)
- `commandSandbox.js` / `commandErrorBudget.js` → empty stubs
- `AntiDetectionEnhanced.js` → delegates to antiDetection.js

## ZAO.js wiring order (after login success)
```
sendPipeline.patch(_api)          ← covers humanTyping + outgoingThrottle.check + duplicateGuard
stealth.start(_api)               ← FB presence loop
antiDetection.start(_api)         ← jitter + UA rotation
humanReadReceipt.start(_api)      ← delayed mark-as-read
... further down ...
keepAlive.startKeepAlive()        ← pings + cookie save + dtsg refresh
sessionGuard.start(_api, path)    ← snapshot ring + integrity check
```
**Why this order:** sendPipeline must be patched first so every subsequent send (including those triggered by humanReadReceipt) flows through the pipeline. stealth/antiDetection/humanReadReceipt are the three behavioral layers sendPipeline doesn't cover.

## index.js start() contract
`engine.start(api, stateFilePath)` starts only the layers sendPipeline does NOT cover: humanReadReceipt, antiDetection, stealth, keepAlive, sessionGuard. It does NOT call humanTyping/outgoingThrottle/duplicateGuard.start() — those live inside sendPipeline now.
`engine.updateApi(api)` is available for hot api-ref updates (rare).

**Why:** Before this fix, index.start() double-wrapped sendMessage (pipeline + standalone wrappers), causing double typing delays and double throttle gaps.
