# ZAO Bot — Agent Change Log

All changes made by the AI agent. Most recent session at the top.

---

## Session — 2026-05-30

### 1. DevHub AI → OpenRouter (Full Replacement)

**Files changed:**
- `webpanel/zao-devhub.js`
- `webpanel/devhub-openrouter.json` *(created)*

**What changed:**
- Removed all `pollinations.ai` code (`_callAIRaw` + the old `callAI` retry loop).
- Rewrote `callAI` to call `https://openrouter.ai/api/v1/chat/completions`.
- Added `loadOpenRouterCfg()` / `saveOpenRouterCfg()` functions that read/write `webpanel/devhub-openrouter.json`.
- `callAI` tries each configured model in order; falls back to the next on error (non-JSON response, 4xx, empty reply, timeout).
- Added two API routes:
  - `GET  /api/devhub/openrouter` — returns current config (API key masked as ••••••••)
  - `POST /api/devhub/openrouter` — saves `{ apiKey, model0, model1, model2 }`
- Added `saveOpenRouterSettings()` client-side JS function.
- Added **OpenRouter AI** card to DevHub → الإعدادات tab: API key input + 3 model name inputs + Save button.
- Default models in `devhub-openrouter.json`:
  - `openai/gpt-4o-mini`
  - `meta-llama/llama-3.1-8b-instruct:free`
  - `google/gemma-2-9b-it:free`

**How to activate:**
1. Get a free API key from https://openrouter.ai/keys
2. Open DevHub → الإعدادات → OpenRouter AI card
3. Paste the key and click "💾 حفظ OpenRouter"

---

### 2. Friend Requests Fix (`أصدقاء طلبات`)

**File changed:** `includes/friendManager.js`

**What changed:**
- Wrapped the GraphQL call in `try/catch` (was silent on error).
- Added multi-path response parser — tries `viewer.friend_requests.edges`, `viewer.friendship_requests.edges`, `viewer.pending_friend_requests.edges`, `viewer.friends.friend_requests.edges` (Facebook changes this shape occasionally).
- If the primary doc_id `9103543533085580` returns nothing, a second attempt runs with doc_id `4283060988374460` (`FriendingCometFriendRequestsRootQuery`).
- Both failures log a `[FriendManager]` line for diagnosis. If both methods return empty the function returns `[]` (correct — no pending requests).

---

### 3. Control Tab — Groups List

**Already fixed in previous session.**
`autoLoadHoldGroups()` calls `/api/groups-list` — the same endpoint used by the Groups tab. No further change needed.

---

### 4. Critical Codebase Scan & Fixes

Codebase scanned by explore subagent across `ZAO.js`, `SCRIPTS/ZAO-CMDS/*.js`, `SCRIPTS/ZAO-EVTS/*.js`, `includes/*.js`.

#### 4a. `artoeine.js` — Anti-out loop (ban risk) — FIXED

**File:** `SCRIPTS/ZAO-EVTS/artoeine.js`

**Problem:** No cooldown on the anti-out re-add. A user leaving repeatedly triggered infinite `addUserToGroup` calls — a high-ban-risk pattern on Facebook.

**Fix:**
- Added `_cooldown` Map (same pattern as `ADMINATEK.js`).
- 45-second per-user-per-thread cooldown before allowing another re-add.
- Added `try/catch` wrapping the entire handler.
- Added null guard: `if (!event.logMessageData) return`.
- Map is pruned when it exceeds 300 entries to prevent memory growth.

#### 4b. `ADMINATEK.js` — Null guard — FIXED

**File:** `SCRIPTS/ZAO-EVTS/ADMINATEK.js`

**Problem:** `event.logMessageData.leftParticipantFbId` was accessed before checking `logMessageData` is non-null. A malformed `log:unsubscribe` event would crash the handler.

**Fix:**
- Added `if (!event.logMessageData) return` before any property access.
- Added explicit null check on `leftID` before proceeding.

#### 4c. `تقييم.js` — eval() (intentionally kept)

`eval(code)` at line 37 is protected by `hasPermssion: 3` (bot owner only) and an explicit `ownerIDs` check. This is an intentional developer tool. No change made — risk is accepted by design.

#### 4d. صورة.js — `global._groupImgInterval` (noted, not changed)

The global interval is intentional but can accumulate if the command runs multiple times without restart. Documented here for awareness. Fix would require checking `clearInterval(global._groupImgInterval)` before setting a new one.

---

### Summary of Files Changed

| File | Change |
|---|---|
| `webpanel/devhub-openrouter.json` | Created — OpenRouter config (apiKey + 3 models) |
| `webpanel/zao-devhub.js` | callAI → OpenRouter; OR API routes; settings tab card; client JS |
| `includes/friendManager.js` | requests() → multi-path + fallback doc_id + error logging |
| `SCRIPTS/ZAO-EVTS/artoeine.js` | Cooldown + null guard + try/catch |
| `SCRIPTS/ZAO-EVTS/ADMINATEK.js` | Null guard for logMessageData |
| `agent.md` | This file |

---

## Session — 2026-06-12

### 1. OpenRouter key unification — two keys in ZAO-SETTINGS.json

**Files changed:**
- `ZAO-SETTINGS.json` *(two new keys added)*
- `SCRIPTS/ZAO-CMDS/زاوفان.js`
- `SCRIPTS/ZAO-CMDS/ai.js`
- `webpanel/zao-devhub.js`

**What changed:**

Added to `ZAO-SETTINGS.json`:
- `"openrouterKeyInternal": ""` — for DevHub AI agents (zao-devhub.js)
- `"openrouterKeyExternal": ""` — for bot commands زاو and زاوفان

`زاوفان.js` — completely replaced `askAI()`: removed pollinations.ai backend, added OpenRouter backend (`_loadExternalKey()` reads `openrouterKeyExternal` from ZAO-SETTINGS.json fresh on every call, `_ZAOFAN_MODELS` fallback loop).

`ai.js` — replaced static `OPENROUTER_API_KEY` constant with `_getOpenRouterKey()` function (reads `openrouterKeyExternal` from ZAO-SETTINGS.json each time, so no restart needed when key changes). Updated all 3 call sites.

`zao-devhub.js` — added `loadZaoSettings()` / `saveZaoSettings()` helpers. `loadOpenRouterCfg()` now reads key from `openrouterKeyInternal` in ZAO-SETTINGS.json (models still from devhub-openrouter.json). `saveOpenRouterCfg()` writes key to ZAO-SETTINGS.json. Settings tab UI label updated to show key source.

**How to activate:**
1. Get a free key from https://openrouter.ai/keys
2. Open `ZAO-SETTINGS.json` and paste it into `openrouterKeyInternal` (for DevHub) and/or `openrouterKeyExternal` (for زاو / زاوفان commands)
3. OR use DevHub → الإعدادات → OpenRouter AI card (saves to ZAO-SETTINGS.json)

---

### 2. Bug fixes (ZAO-AUDIT.md)

**Files changed:**
- `includes/handle/handleCommand.js`

**What changed:**

L-01 fix: `!![]` → `true` at line 275 (setMessageReaction 4th arg — `!![]` always evaluates to `true` but is semantically misleading).

M-01 fix: `humanTyping.calcDelay(msg)` → `humanTyping.calcDelay(preview || '')` at line 333. `msg` can be a string or object; `preview` is already the extracted text string computed earlier in the same closure.

---

### Summary of Files Changed

| File | Change |
|---|---|
| `ZAO-SETTINGS.json` | Added openrouterKeyInternal + openrouterKeyExternal keys |
| `SCRIPTS/ZAO-CMDS/زاوفان.js` | Replaced pollinations.ai askAI() with OpenRouter + ZAO-SETTINGS.json key |
| `SCRIPTS/ZAO-CMDS/ai.js` | _getOpenRouterKey() reads openrouterKeyExternal from ZAO-SETTINGS.json dynamically |
| `webpanel/zao-devhub.js` | loadOpenRouterCfg() reads key from ZAO-SETTINGS.json openrouterKeyInternal |
| `includes/handle/handleCommand.js` | L-01: !![] → true; M-01: calcDelay(preview) not calcDelay(msg) |
| `agent.md` | This file |

---

## Session — 2026-06-12 (part 2)

### 1. اصنع.js — Replace pollinations.ai with OpenRouter (openrouterKeyInternal)

Replaced `_callAI()` pollinations.ai backend with OpenRouter. Now reads `openrouterKeyInternal` from `ZAO-SETTINGS.json` fresh on every call. Model fallback list: `openai/gpt-4o-mini`, `llama-3.3-70b:free`, `llama-3.1-8b:free`, `gemma-2-9b:free`, `mistral-7b:free`. Shows a clear Arabic error message if key is missing.

### 2. Groups tab stuck at ⏳ جارٍ التحميل... — ZAO.js /bot/groups timeout fix

Root cause: `/bot/groups` handler made TWO sequential `getThreadList` calls with no timeout. Each could take 10-20 seconds. `proxyToBot` times out after 8s, returns 503, panel falls back to empty cache → loading spinner never resolves.

Fix: Added `_tl()` helper using `Promise.race` with 6s timeout per `getThreadList` call. Also added `res.destroyed` / `res.writableEnded` guards before writing to prevent EPIPE errors when the proxy already timed out.

### 3. 48-hour bot session expiry — keepAlive.js dtsg interval

Root cause: `_scheduleDtsg()` defaulted to `refreshDtsgIntervalHours: 48`. The `fb_dtsg` token expires at ~48h, meaning it was refreshing too late (or not at all before expiry).

Fix: Changed default from `|| 48` to `|| 6` hours. Token now refreshes every ~6h ±20% jitter. Configurable via `keepAlive.refreshDtsgIntervalHours` in ZAO-SETTINGS.json.

### 4. FRESH account session longevity — accountAgeScale.js

Root cause: FRESH accounts (615xxx UIDs) had ALL passive activities disabled (`notificationVisit: false`, `autoMarkRead: false`, `simulateTyping: false`). A totally silent account between messages is the strongest bot signal to Facebook's ML.

Fix: Enabled `notificationVisit: true`, `autoMarkRead: true`, `simulateTyping: true` for FRESH era. Kept `browsing: false` and `graphqlFeed: false` (page-crawling is higher risk for new accounts). These passive activities mimic normal Messenger use without looking automated.

### 5. Scan result: No syntax errors

Node `--check` on all files in `includes/`, `webpanel/`, `ZAO.js`, `Main.js` — clean.

---

### Summary of Files Changed

| File | Change |
|---|---|
| `SCRIPTS/ZAO-CMDS/اصنع.js` | _callAI() → OpenRouter (openrouterKeyInternal), model fallback list |
| `ZAO.js` | /bot/groups: Promise.race 6s timeout on getThreadList, res.destroyed guards |
| `includes/keepAlive.js` | dtsg refresh default: 48h → 6h |
| `includes/accountAgeScale.js` | FRESH era: notificationVisit + autoMarkRead + simulateTyping = true |
