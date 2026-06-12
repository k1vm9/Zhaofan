---
name: ZAO-ENGINE architecture
description: Describes the ZAO-ENGINE directory, what it replaces, what was dropped, and the stub pattern for dropped modules.
---

# ZAO-ENGINE Architecture

## What it is
`ZAO-ENGINE/` is a lean security + session engine that replaced the old `/includes/` directory.
Old includes/ is archived as `_includes/` — not deleted.

## Why
ZAO had too many competing security layers (stealthEngineV2, AntiDetectionEnhanced, OnlinePresenceEngine, ZAOSecurityManager, SessionWarmupManager, HumanActivitySimulator, IpReputationMonitor, sendFailureDetector, crashFingerprinter, commandSandbox, commandErrorBudget, EnhancedRateLimiter, RequestPacingEngine, eventLoopGuard, diskGuard) that caused crashes after a few hours. David's bot with 20 simple layers stayed up for weeks.

## What's NEW in ZAO-ENGINE (from David's simple code)
- `stealth.js` — presence loop, hits FB every 8-20 min with mobile UA, respects sleep hours
- `humanTyping.js` — wraps sendMessage with typing indicator delay (500-8000ms)
- `humanReadReceipt.js` — marks messages read after 800-3500ms delay
- `outgoingThrottle.js` — queues sends with 700-2000ms gaps (anti-spam)
- `duplicateGuard.js` — blocks double-sends within 8s window per thread
- `rateLimit.js` — simple sliding-window rate limiter (replaces EnhancedRateLimiter)
- `antiDetection.js` — 200-900ms jitter on react/unsend + UA rotation every 25-35 min
- `fca.js` — login wrapper with Djamel-fca cookie parsing (5 formats), UA pool, sendMessageHuman, buildReplyHelper, thread cache

## What's KEPT from ZAO (unchanged, proven)
- `keepAlive.js` — simplified ping + cookie save + dtsg refresh + notification visit
- `sessionGuard.js` — 3-layer session preservation (snapshot ring, integrity check, pre-relogin hook)
- `cookieSnapshot.js` — ring buffer of valid AppState snapshots in backups/
- `checkLiveCookie.js` — triple-URL validator (mbasic → home.php → m.facebook.com)
- `login/autoRelogin.js` — tier walk-forward relogin with per-tier cooldowns
- `fcaClient.js` — shim re-exporting from fca.js for internal compat

## Stub pattern for dropped modules
Dropped over-engineered modules are stubbed (not deleted) so ZAO.js try/catch blocks stay clean:
- `antiSuspension.js` → globalAntiSuspension with no-op methods
- `sendFailureDetector.js` → no-op onSendSuccess/Failure/onPingDetectedBlock
- `stealthEngineV2.js` → delegates to stealth.js
- `stealthEngine.js` → exposes globalStealthEngine.getStatus() wrapping stealth.js
- `EnhancedRateLimiter.js` → delegates to rateLimit.js
- `RequestPacingEngine.js` → getStatus() no-op
- `SessionWarmupManager.js` → no-op
- `OnlinePresenceEngine.js` → no-op
- `crashFingerprinter.js` → feedLine() + recordCrash() no-ops (Main.js needs feedLine)
- `commandSandbox.js` / `commandErrorBudget.js` → empty stubs
- `AntiDetectionEnhanced.js` → delegates to antiDetection.js

## Import migration
All `require('./includes/xxx')` in ZAO.js, Main.js, SCRIPTS/, webpanel/ were replaced with `require('./ZAO-ENGINE/xxx')` via sed. 0 stray includes/ refs remain.

**Why:** The crashFingerprinter stub MUST have `feedLine()` and `recordCrash()` — Main.js calls both directly (not in try/catch). Missing either causes uncaughtException spam that floods watchdog logs without killing the bot.
