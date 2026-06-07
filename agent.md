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
