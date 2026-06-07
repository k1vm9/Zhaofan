# ZAO Bot — Bug & Flow Scan Report
> Generated: June 2026 | Covers: ZAO.js, ZAO-SETTINGS.json, includes/, SCRIPTS/ZAO-CMDS/, SCRIPTS/ZAO-EVTS/, webpanel/

---

## SECTION 1 — FIXED BUGS (This Session)

| ID | File | Fix Applied |
|----|------|-------------|
| B05 | `includes/groupActivityTracker.js` | Guard empty `botID` before calling `removeUserFromGroup` — null botID caused `removeUserFromGroup(null, …)` silent no-op + confusion |
| B06 | `includes/kvStore.js` | Added `_retryCount` + `MAX_RETRIES=8` with exponential backoff capped at 30s; was infinite retry on permanently-unwritable disk |
| B07 | `includes/motorSafeSend.js` | `shouldSend()===false` recheck interval was hardcoded `10000ms`; now reads `getData().hardMinMs` first |
| B08 | `includes/humanTyping.js` | `liveApi` was `global._botApi \|\| api`; passthrough `api` should take priority → fixed to `api \|\| global._botApi` |
| B10 | `includes/nicknameLocks.js` | `setLockTime()` was a no-op stub; implemented with `_lockTimes` Map + added `getLockTime()` export |
| B14 | `includes/OnlinePresenceEngine.js` | Hardcoded Chrome/124 UA; now pulls from `requires('./user-agents')` with fallback |
| B21 | `includes/motorSafeSend.js` | Removed dead `preSendEvasion()` function (defined, never called, references non-existent `antiSuspension.fullEvasionSequence`) |
| R12 | `includes/graphqlVisit.js` | **Deleted** — duplicate of `keepAlive.js:doNotificationVisit`; ZAO.js call removed, replaced with comment |

---

## SECTION 2 — OPEN RISKS (Not Yet Fixed)

### HIGH

| ID | File | Risk | Recommendation |
|----|------|------|----------------|
| R01 | `includes/labyrinth/Labyrinth.js` | Double-Ratchet state serialized to `data/labyrinth-*.json` without file locking — concurrent writes can corrupt the ratchet state and permanently break E2EE sessions | Replace with `atomicWriteJsonSync` from `utils/atomicWrite.js` |
| R02 | `ZAO.js` (login flow) | Emalogin forces a specific tier without fallback; if that tier cookie expires AND all other tiers also fail, the 3-minute retry loop fires but doesn't reset `BOT_TIER` env | Add tier-reset guard inside the retry loop |
| R03 | `includes/antiSuspension.js` | `getStatus()` method referenced by `AntiDetectionEnhanced.js` — if `antiSuspension` module is replaced or renamed, `AntiDetectionEnhanced` silently returns `{}` for the status block (no visible crash but misleading panel data) | Add explicit `module.exports.getStatus` to antiSuspension.js |
| R04 | `SCRIPTS/ZAO-CMDS/ai.js` | OpenRouter API key is **hardcoded** as a fallback string in source (`sk-or-v1-...`). This exposes the key in the repo. | Move to `process.env.OPENROUTER_API_KEY` only; read from devhub-openrouter.json via the DevHub settings path, never from source code |

### MEDIUM

| ID | File | Risk | Recommendation |
|----|------|------|----------------|
| M01 | `includes/keepAlive.js` | Cookie save (`doSaveCookies`) is debounced correctly but the debounce timer is NOT `unref()`'d — keeps the process alive even if the bot wants a clean exit | Add `timer.unref()` after `setTimeout` |
| M02 | `DB/sequelize/controllers/` | Sequelize models use `sync({ force: false })` silently; if a migration adds a column, production DB silently runs without it until `alter:true` is used | Add column-presence check on boot or use Umzug migrations |
| M03 | `SCRIPTS/ZAO-CMDS/warn.js` | `saveWarns` uses plain `fs.writeFileSync` (not atomic); concurrent kick+warn on same user can produce a torn JSON file | Replace with `atomicWriteJsonSync` |
| M04 | `SCRIPTS/ZAO-CMDS/ban.js` | Same as M03 — uses plain `fs.writeFileSync` in `saveBans` | Replace with `atomicWriteJsonSync` |
| M05 | `SCRIPTS/ZAO-CMDS/lockdown.js` | `autoinvite_settings.json` write uses `atomicWriteFileSync` (good) but the add-back logic in the event handler doesn't check if bot is still a member before calling `addUserToGroup` → can hit an error if bot was removed | Add member-check before re-add |
| M06 | `includes/sessionGuard.js` | Session snapshot path is hardcoded as `process.cwd()/sessions/ZAO-STATE.json` but the actual live state lives at `ZAO-STATE.json` (root); mismatched path means snapshots never actually restore the right file | Align path to `process.cwd()/ZAO-STATE.json` or make it configurable |
| M07 | `includes/nameLocks.js` | `getLocks()` returns the internal `_locks` Map directly (by reference), not a copy — callers can mutate the lock state without going through `setLock/clearLock` | Return `new Map(locks)` clone |

### LOW

| ID | File | Risk |
|----|------|------|
| L01 | `webpanel/zao-server.js` | Session secret falls back to `Date.now()` if `SESSION_SECRET` env not set — server warns, but all sessions invalidate on every restart |
| L02 | `SCRIPTS/ZAO-CMDS/uptime.js` | Registers Roboto fonts on every command call unless `fontsRegistered` flag is set; flag is module-level but is reset if the module is re-required after hot-reload |
| L03 | `data/restart-history.json` | Capped at 3 entries but uses `splice(0,1)` on a freshly-read array — if file is corrupted/empty, splice call throws and restarts are not tracked |
| L04 | `includes/humanTyping.js` | `nightModeMultiplier` applies between 22:00–06:00 UTC but the bot's user timezone isn't factored in — off by several hours for non-UTC operators |
| L05 | `SCRIPTS/ZAO-CMDS/e2ee.js` | `_parseWire` silently returns `null` on any decode failure, producing a confusing "message not understood" reply with no diagnostic info in logs |
| L06 | `includes/EnhancedRateLimiter.js` | Thread-level rate limiter stores entries in a plain `Map` with no TTL eviction for idle threads — memory grows unbounded in long-running sessions with many unique threads |

---

## SECTION 3 — FLOW ANALYSIS

### 3A — Bot Boot Flow
```
Main.js spawns ZAO.js as child
  └─ ZAO.js: selectTier() → load ZAO-STATE[n].json
  └─ ZAO.js: Emalogin() → facebook-chat-api MQTT connect
  └─ ZAO.js: loadCommands() + loadEvents() (execSync npm install, 90s timeout each)
  └─ ZAO.js: syncAllGroups() → populate global.data.allThreadID + threadInfo
  └─ ZAO.js: sessionGuard.start() → periodic session health checks
  └─ ZAO.js: keepAlive.start() → cookie save loop + GraphQL visit cadence
  └─ ZAO.js: mqttHealthCheck.start() → silent-timeout watchdog (2–5 min jitter)
  └─ ZAO.js: OnlinePresenceEngine.start() → HEAD facebook.com with rotating UA
  └─ ZAO.js: groupActivityTracker.start() → track per-group send volume
```

**Risk**: If `execSync npm install` hangs (slow registry), the entire boot blocks. Fixed with `timeout:90_000`.

### 3B — Incoming Message Flow
```
MQTT event → listen.js
  └─ filterSpam() — EnhancedRateLimiter
  └─ filterBadWords() — badwords.json check
  └─ autoLock check — if non-admin exceeds maxCommands/windowSeconds
  └─ whiteList/whiteListThread check
  └─ prefix match → find command in global.client.commands
  └─ hasPermssion check (0=all, 1=group-admin, 2=bot-admin)
  └─ cooldown check
  └─ humanTyping.simulateTyping() → send typing indicator
  └─ command.run({ api, event, args, ... })
  └─ reactUnsend check — if admin reacts 😡/😠 to a bot message, unsend it
```

### 3C — Cookie Rotation Flow
```
keepAlive.js (interval ~90min jitter)
  └─ doSaveCookies() → api.getAppState() → atomicWriteJsonSync(ZAO-STATE.json)
  └─ also writes alt.json backup

On MQTT session error / cookie expiry:
  selectTier(current + 1) → retry up to tierLimit
  If all tiers exhausted → wait 3 min → retry from tier 1 (infinite loop)
```

**Risk**: If tier 1 cookie is expired AND tier files 2-5 are empty placeholders, the 3-min loop fires forever (non-fatal, just wasteful).

### 3D — Motor (Group Name / Image) Loop Flow
```
engine.js / motor2.js / صورة.js commands start a per-thread loop:
  motorPersist.motor1/motor2 → setInterval-like loop with jitter
  shouldSend() guard → pauses loop if bot is locked/offline
  motorSafeSend.sendMessage → queue-based send with hardMinMs spacing
  On bot restart: loops are NOT automatically restored (state is lost)
```

**Improvement**: Add persistence of active motors to `data/motor-state.json` so they survive bot restarts.

### 3E — E2EE (Labyrinth) Session Flow
```
e2ee bundle → X3DH key exchange → Double Ratchet established
  Encrypted messages: prefixed with 🔐ZAO| or 🔒E2EE:
  Ratchet state stored in data/labyrinth-{threadID}.json
  PIN passive mode: fallback encrypt with PIN-derived AES-256 key

Known weakness: ratchet JSON file written without atomicWrite (R01)
```

### 3F — Web Panel Auth Flow
```
GET /login → render login form
POST /login → compare bcrypt(password, PANEL_PASSWORD env)
  → set express-session cookie (httpOnly, sameSite:strict)
  → redirect to /status
All panel routes: requireAuth middleware checks req.session.auth
POST /logout → destroys session
```

**Note**: No brute-force throttle on `/login`. Add rate limiting (e.g. 5 attempts/min per IP).

---

## SECTION 4 — MISSING GUARDS / HARDENING CHECKLIST

- [ ] `atomicWriteJsonSync` in `warn.js`, `ban.js` (currently plain writeFileSync)
- [ ] Login brute-force rate limiting (no throttle on `POST /login`)
- [ ] Motor state persistence across restarts (`data/motor-state.json`)
- [ ] Labyrinth ratchet file atomic writes
- [ ] `nameLocks.getLocks()` → return copy, not reference
- [ ] `keepAlive.js` debounce timer `unref()`
- [ ] OpenRouter key out of source code (move to env/settings file only)
- [ ] Session snapshot path alignment in `sessionGuard.js`
- [ ] `EnhancedRateLimiter` idle-thread eviction (TTL-based cleanup)
