# ZAO Bot — Complete Implementation Prompt
> **Purpose**: Use this document as the single authoritative reference when rebuilding, porting, or extending ZAO in another codebase. Every command, internal system, security layer, web panel tab, data schema, and architectural decision is described precisely enough to reimplement them from scratch.

---

## TABLE OF CONTENTS

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Command System](#3-command-system)
4. [All Commands — Full Reference](#4-all-commands--full-reference)
5. [Event Handlers](#5-event-handlers)
6. [Security & Protection Systems](#6-security--protection-systems)
7. [Send Pipeline & Rate Limiting](#7-send-pipeline--rate-limiting)
8. [Session & Cookie Management](#8-session--cookie-management)
9. [Anti-Suspension Engine](#9-anti-suspension-engine)
10. [MQTT Health & Watchdog](#10-mqtt-health--watchdog)
11. [E2EE / Labyrinth](#11-e2ee--labyrinth)
12. [Web Panel (zao-server.js)](#12-web-panel-zao-serverjs)
13. [Instagram Bot (INSTA.js)](#13-instagram-bot-instajs)
14. [DevHub AI Agents](#14-devhub-ai-agents)
15. [Database Layer](#15-database-layer)
16. [Key Data Files & Schemas](#16-key-data-files--schemas)
17. [Full ZAO-SETTINGS.json Reference](#17-full-zao-settingsjson-reference)
18. [Utility Modules](#18-utility-modules)
19. [Writing New Commands — Step-by-Step](#19-writing-new-commands--step-by-step)
20. [Debugging & Error Codes](#20-debugging--error-codes)
21. [Deployment Notes](#21-deployment-notes)

---

## 1. PROJECT OVERVIEW

ZAO is a multi-account Facebook Messenger chatbot with:
- A **two-process watchdog** architecture (Main.js → ZAO.js child)
- A **real-time web admin panel** (Express SSR on port 5000, 13 tabs)
- An **Instagram bot** running in parallel (INSTA.js, port 3002)
- **5-tier account failover** (5 Facebook AppState cookie files)
- **End-to-end encryption** via Signal Protocol / Double Ratchet (Labyrinth)
- **Anti-suspension stealth engine** (typing simulation, UA rotation, presence cycling)
- **AI DevHub** with 5 specialized agents powered by OpenRouter
- ~60+ active commands across Arabic and English

**Runtime**: Node.js 20.x  
**Facebook API**: `@neoaz07/nkxfca` (unofficial MQTT-based Facebook Chat API)  
**Database**: SQLite3 via Sequelize ORM (optional MongoDB via Mongoose)  
**Config source of truth**: `ZAO-SETTINGS.json`  
**Session cookies**: `ZAO-STATE.json` (tier 1), `ZAO-STATE2.json` … `ZAO-STATE5.json`

---

## 2. ARCHITECTURE

### 2A — Process Tree

```
Main.js (port 5000 — web panel, always running)
  ├── ZAO.js (Facebook bot child, MQTT, port 3001 internal)
  └── INSTA.js (Instagram bot child, port 3002 internal)
```

- **Main.js** is the master launcher and watchdog. It hosts the Express panel on port 5000, spawns `ZAO.js` and optionally `INSTA.js` as child processes via `child_process.spawn`, and restarts them on crash.
- **ZAO.js** is the Facebook bot process. It logs into Facebook, loads commands and events, connects via MQTT, and starts a lightweight API server on port 3001 for inter-process status queries from the panel.
- **INSTA.js** is the Instagram bot process. It logs into Instagram, loads Instagram commands, and connects via `instagram_mqtt`.
- If ZAO.js crashes, Main.js auto-restarts it with **exponential backoff** (up to `MAX_RESTARTS` attempts, then long-pause retry). The web panel stays alive throughout.
- Crash count and timestamps are persisted to `data/restart-stats.json` and `data/restart-history.json` (ring buffer of last 10).
- `data/first-start.json` is written once on the very first boot and never overwritten — used to compute total system uptime independent of restarts.

### 2B — Boot Sequence (ZAO.js)

1. Load `ZAO-SETTINGS.json` into `global.config`
2. Initialize SQLite database (Sequelize sync)
3. Load all commands from `SCRIPTS/ZAO-CMDS/` (dynamic `require`, `execSync npm install` with 90s timeout if `package.json` found per command)
4. Load all events from `SCRIPTS/ZAO-EVTS/`
5. Attempt Facebook login (Emalogin → `@neoaz07/nkxfca`) using tier 1 cookies
6. On login success: start listen loop, MQTT health check, session guard, account health monitor, stealth engine
7. On login failure: try next tier (2→3→4→5); after all exhausted, wait 3 minutes and retry from tier 1 indefinitely

### 2C — IPC Between Main.js and ZAO.js

- ZAO.js sends messages to Main.js parent via `process.send({ type: 'log'|'status'|'restart'|'clean' })`.
- Main.js sends IPC commands to ZAO.js: `{ type: 'restart' }`, `{ type: 'shutdown' }`.
- The panel's `/api/bot-status` endpoint queries ZAO.js internal HTTP server at `http://127.0.0.1:3001/status` for live metrics.

### 2D — Atomic Writes

All JSON state files that are both read and written by the running bot (cookies, settings, locks, warns, bans, etc.) use **atomic write**: write to a `.tmp` file first, then `fs.renameSync` to the target. This prevents torn/empty JSON from concurrent read+write.

Implementation: `utils/atomicWrite.js` → `atomicWriteFileSync(path, data, encoding)`.

### 2E — Global Objects

Key globals set by ZAO.js that commands and modules rely on:

| Global | Type | Contents |
|--------|------|----------|
| `global.config` | Object | Parsed `ZAO-SETTINGS.json` |
| `global.client` | Object | `{ commands: Map, events: Map }` |
| `global.data` | Object | `{ allThreadID: Set, allUserID: Set, userName: Map, threadName: Map, commandBanned: Map }` |
| `global.lockBot` | Boolean | If `true`, bot rejects all non-admin commands (autoLock) |
| `global._botApi` | FCA API | Current active Facebook API instance |
| `global._botStartTime` | Number | `Date.now()` when ZAO.js started |
| `global.activeAccountTier` | Number | Active tier (1–5) |
| `global.isRelogining` | Boolean | `true` while a relogin is in progress |
| `global._triggerAutoRelogin` | Function | Call to force a relogin cycle |
| `global.loggeryuki` | Object | Structured logger (colored console output) |
| `global._stealthEngine` | Object | AntiSuspension + HumanTyping instances |
| `global._rateLimiter` | Object | EnhancedRateLimiter instance |

---

## 3. COMMAND SYSTEM

### 3A — Command File Structure

Every command is a CommonJS module exporting two things:

```js
module.exports.config = {
  name:            "commandname",         // primary name (used as Map key)
  aliases:         ["alias1", "alias2"],  // alternate trigger words
  version:         "1.0.0",
  hasPermssion:    0,                     // 0=everyone, 1=group admin, 2=bot admin
  credits:         "Author Name",
  description:     "What this command does",
  commandCategory: "Category Name",       // used by help.js for grouping
  usages:          "commandname [arg]",   // shown in help
  cooldowns:       5,                     // seconds between uses per user
  timeout:         30000,                 // optional: max ms (overrides 30s default)
};

module.exports.run = async function ({ api, event, args, Users, Threads, Currencies, getText }) {
  const { threadID, messageID, senderID, body, isGroup } = event;
  // ... command logic ...
};
```

### 3B — Permission Levels

| Level | Who can use |
|-------|-------------|
| `0` | Any user in any thread |
| `1` | Facebook group administrators (checked via `api.getThreadInfo`) |
| `2` | Bot admins — UIDs in `global.config.ADMINBOT` or `global.config.adminBot` |

### 3C — Command Loading

`ZAO.js` reads every `.js` file in `SCRIPTS/ZAO-CMDS/` and calls `require()` on each. If a subdirectory contains a `package.json`, `execSync('npm install', { cwd: dir, timeout: 90000 })` is called first. Loaded commands are stored in `global.client.commands` as a `Map<name, module>`. Aliases are also registered in the same Map.

### 3D — Command Dispatch (`includes/handle/handleCommand.js`)

1. Check bot is not globally locked (`global.lockBot`) — admins bypass
2. Check thread is not DM-locked (`dmLock.js`)
3. Extract prefix from thread settings or global config
4. Match `body` against prefix regex
5. Parse `commandName` from the body (first word after prefix)
6. Look up command in `global.client.commands`
7. If no exact match and `commandName.length ≤ 30` and body starts with prefix: run `stringSimilarity.findBestMatch()` — if best match rating ≥ 0.8, use that command; otherwise silently return
8. Check permission level; send rejection if insufficient
9. Check per-user cooldown (per-command Map in `global.client.cooldowns`)
10. Wrap execution in `commandSandbox.runWithTimeout()` — 30s default, command can declare longer via `config.timeout`
11. Catch and log any uncaught error from the command; send a user-friendly error message

### 3E — Command Sandbox (`includes/commandSandbox.js`)

Wraps every command's `run()` call in a `Promise.race([commandPromise, timeoutPromise])`:
- Default timeout: **30 seconds**
- Commands with slow operations (YouTube download, image generation, AI, etc.) should declare `config.timeout: N` (in ms) to opt into a longer budget
- On timeout: logs to error budget tracker (`commandErrorBudget.js`), sends the user a timeout notification
- Rolling timeout history per command name (last 5 min window) used for diagnostics

### 3F — Hot-Reloadable Events

`SCRIPTS/ZAO-EVTS/` contains event handler modules. Each exports:
```js
module.exports.config = { name: "eventName", ... };
module.exports.run = async function ({ api, event }) { ... };
```
Events are matched to Facebook API event types (`message`, `event`, `message_reaction`, etc.).

---

## 4. ALL COMMANDS — FULL REFERENCE

### INFO & UTILITY

#### `ping` (aliases: `وضع`, `status`, `حالة`, `pong`, `صحة`) — Perm 0
- Sends an instant "🏓 Pong!" first (shows RTT), then follows up with a detailed status card.
- Status card includes: RTT in ms, Node.js memory (heap used/total), process uptime formatted (d h m s), MQTT connection status, active tier number, loaded command count, active thread count.
- Color-coded: green = healthy, yellow = degraded, red = critical.

#### `معلومات` — Perm 0
- Full bot info card: bot UID, display name, command count, thread count, admin count, prefix, active tier, bot build version, Node.js version.

#### `احصائيات` (aliases: `stats`, `systems`, `انظمة`, `نظام`, `sysinfo`) — Perm 2
- Comprehensive system stats reserved for bot admins.
- Shows: cookie file sizes per tier, health of each protection system (name + check interval + last result), RAM/CPU, MQTT state (connected/reconnecting), stealth engine config (human typing min/max, UA pool size), motor status (which threads have active name/image loops), all active locks.

#### `uptime` — Perm 0
- Generates a canvas image using the `canvas` npm package.
- Renders: CPU%, RAM bar, formatted uptime, system load average.
- Font: Roboto loaded from `SCRIPTS/ZAO-CMDS/uptime/Roboto/` directory.
- Returns the image as a file attachment to the thread.

#### `uid` (aliases: `id`, `getid`) — Perm 0
- Returns the Facebook UID of:
  - The sender (no arguments)
  - Mentioned user (any @mention in the message)
  - The user whose message was replied to
  - A manually typed UID (validated as numeric string)

#### `اوامر` / `help` (aliases: `cmds`, `commands`, `أوامر`, `الاوامر`, `h`) — Perm 0
- Step 1: Lists command categories with emoji icons. User replies with the number of the category they want.
- Step 2: Shows all commands in that category with name + `usages` inline.
- Categories defined per-command via `commandCategory` field.
- Uses `api.unsendMessage` to clean up the category list after selection.

#### `جلب` — Perm 0
- Returns the current thread ID and sender ID as text. Quick diagnostic for users who need their group ID.

---

### AI COMMANDS

#### `زاو` / `ai` — Perm 0
The main AI chat command. Full feature set:

- **Multi-model fallback**: Tries OpenRouter models in priority order. On any hard failure (rate limit, no credits, server error, empty reply, context length exceeded), automatically advances to the next model in the list. Current model order: grok-4.3 → gpt-4o-mini-transcribe → deepseek-v3.2 → gpt-oss-120b:free → gemma-4-26b → cobuddy:free.
- **State persistence**: `_bestModelIdx` tracks the last working model across calls within the same process lifetime. Next call starts at the last known-good model, not always from index 0.
- **Vision support**: If the user replies to a photo, the command extracts the image URL and passes it in the `content` array as `type: "image_url"` to OpenRouter.
- **User identity**: Loads `data/ai-users.json` on every call (so edits take effect without restart). If the sender's UID matches an entry, injects their name and note into the system prompt so the AI can address them by name.
- **API key**: Reads `OPENROUTER_API_KEY` env var first, then falls back to `devhub-openrouter.json` (`apiKey` field). Never hardcoded.
- **Arabic-first**: System prompt instructs the model to respond primarily in Arabic.

#### `sim` — Perm 0
- SimSimi-style chitchat via the SimSimi API.
- Requires `simsimiApiKey` in `ZAO-SETTINGS.json`.
- If the key is missing or the API is unreachable, returns a friendly fallback response.

#### `شخصية` — Perm 0
- Personality chat mode. User provides a persona description (e.g. "أنت صديق مضحك").
- Persona is stored per-thread in memory and injected into every subsequent AI call in that thread.
- Subcommands: `شخصية [وصف]` to set, `شخصية ايقاف` to clear.

#### `imgen` (aliases: `imggen`, `imagine`, `صورة-ai`) — Perm 0, timeout: 60s
- AI image generation from a text prompt.
- Calls an external image generation API (configurable in settings or via the command source).
- Returns the generated image as a file attachment.

#### `اصنع` (aliases: `create`, `generate`, `gen`, `code`, `كود`, `انشئ`) — Perm 2, timeout: 90s
- AI code/system generation via the DevHub AI agents.
- Takes a free-text description of what to build.
- Routes the request to the "مطور الأوامر" (Command Developer) DevHub agent.
- Response (complete command module code) is sent to the bot admin's DM or development group.

---

### GROUP MANAGEMENT

#### `ban` (aliases: `حظر`) — Perm 1
- Ban a member from a group thread. Banned members are tracked in `data/ban.json`.
- Subcommands:
  - `ban [@mention/reply/uid] [reason]` — add to ban list + optional kick
  - `ban unban [@mention/reply/uid]` — remove from ban list
  - `ban list` — show all banned UIDs in this thread with reasons
  - `ban check` — scan member list and kick anyone who is currently banned but slipped back in
- Ban data structure: `{ [threadID]: [{ uid, reason, bannedBy, ts }] }`
- Uses atomic write via `utils/atomicWrite.js`.

#### `kick` (aliases: `طرد`) — Perm 1
- Remove one or more members from the group.
- Supports: @mention, reply-to-message, multiple @mentions in one message.
- Validates that the bot is not attempting to kick itself.
- Sends a confirmation message after each successful kick.

#### `warn` — Perm 1
- Issue warnings to group members. After `MAX_WARNS` (3) warnings, the member is auto-kicked.
- Subcommands:
  - `warn [@user/reply] [reason]` — add a warning; auto-kicks on MAX_WARNS
  - `warn remove [@user/reply]` — remove all warnings for this user in this thread
  - `warn list` — show all warned members in this thread with warning counts and reasons
- Data stored atomically in `data/warn.json`: `{ [threadID]: { [uid]: { count, reasons: [string] } } }`

#### `مشرف` / `gcadmin` (aliases: `admin-gc`) — Perm 1
- Promote or demote group administrators via MQTT.
- `مشرف [@tag/uid/reply]` — promote to admin
- `مشرف إلغاء [@tag/uid/reply]` — demote from admin
- Uses `api.changeAdminStatus(threadID, uid, true/false)`.

#### `lockdown` (aliases: `ld`, `autoadd`, `lock`) — Perm 2
- Auto-readd members who leave the group.
- Subcommands: `lockdown on`, `lockdown off`, `lockdown status`
- State stored in `data/autoinvite_settings.json`: `{ [threadID]: { enabled: bool } }`
- Fires from the `removeParticipants` event — re-adds the removed UID immediately.

#### `antiout` — Perm 2
- Similar to lockdown but focuses on self-leave events.
- When `antiout` is enabled for a thread, any user who leaves (not kicked) is re-added immediately.
- Toggle: `antiout on / off`

#### `out` — Perm 2
- Makes the bot leave a specific group.
- Usage: `out [threadID]` — or run inside the target group with no argument.
- Uses `api.removeUserFromGroup(botUID, threadID)`.

#### `badwords` — Perm 2
- Manage a per-group auto-delete bad words list.
- Subcommands: `badwords add [word]`, `badwords remove [word]`, `badwords list`, `badwords on [threadID]`, `badwords off [threadID]`
- State: `data/badwords.json` → `{ [threadID]: { enabled: bool, words: [string] } }`
- Enforcement done in the message event handler: if any word in the list is found in `event.body`, the message is unsent via `api.unsendMessage`.

#### `صامت` — Perm 2
- Silence mode: bot ignores all non-admin messages in this group for N minutes.
- Usage: `صامت [minutes]`, `صامت off`

#### `groupname` — Perm 1
- Change the group name. Usage: `groupname [new name]`
- Uses `api.setTitle(threadID, newName)`.

#### `تثبيت` / `pinmsg` — Perm 1
- Pin a message in the group. Must be used as a reply to the target message.
- Uses `api.pinMessage(threadID, messageID)`.

#### `تصويت` / `poll` — Perm 0
- Create a group poll.
- Usage: `poll [question] / [option1] / [option2] / ...`
- Uses `api.createPoll(question, options, threadID)`.

#### `بحث_عضو` — Perm 1
- Search group members by name fragment.
- Returns matching UIDs + display names from `global.data.userName` map.

---

### NICKNAME SYSTEM

#### `كنيات` (nicknames) — Perm 1–2

Full nickname lock system. Priority: **User Lock > Group Lock > Normal**.

Subcommands:
- `كنيات تشغيل [template]` — Lock all members in this group with a template. Supports `{name}` (user's display name) and `{index}` (sequential number) placeholders. Example: `كنيات تشغيل زاو #{index}` → "زاو #1", "زاو #2"
- `كنيات بوت [nick]` — Lock the bot's own nickname in this group
- `كنيات ايقاف` — Remove the group lock for this thread
- `كنيات تنظيف` — Clear all nicknames in the group (set everyone to blank)
- `كنيات حالة` — Show current lock status (active template, how many users locked)
- `كنيات قائمة` — List all groups that currently have an active nickname lock
- `كنيات قفل [nick]` (reply to a user's message) — Apply a user-level lock to that specific user, overriding any group template
- `كنيات فك` (reply) — Release the individual user lock for that user
- `كنيات مقفولون` — List all individually locked members in this group

**Enforcement interval**: 60 seconds. The lock enforcer runs a `setInterval` that iterates all locked groups and re-applies nicknames for any user whose current nickname doesn't match the expected value (detected via `api.getThreadInfo`).

**Storage**: `data/nicknameLocks.json`:
```json
{
  "[threadID]": {
    "groupLock": { "template": "{name}", "botNick": "ZAO" },
    "userLocks": { "[uid]": "Custom Nick" }
  }
}
```

#### `nm` — Perm 2
- Group name rotation lock. Locks the group name and optionally rotates it on a timer.
- `nm [name]` — lock the name (no rotation)
- `nm off` — remove the name lock for this thread
- `nm random [range]` — e.g. `nm random 6s-30s` or `nm random 1m-5m` — change the group name on a random interval within the range
- Uses `nameLocks.js` for persistence (`data/nameLocks.json`).

#### `protect` / `حماية` — Perm 2
- Nickname protection. Saves the current nickname of each member and auto-reverts any unauthorized change.
- Subcommands: `protect on/off`, `protect set @user nick`, `protect list`
- Enforcement: fires on `changeNickname` event — if the changer is not an admin, immediately reverts.
- Storage: `data/protectData.json` → `{ [threadID]: { [uid]: "saved_nickname" } }`

---

### BOT ADMIN COMMANDS (Perm 2)

#### `shutdown` — Perm 2
- Gracefully shuts down the entire bot.
- Sends SIGTERM to `process.ppid` (Main.js parent) via `process.kill`. Fallback: `process.exit(0)`.

#### `رست` / `rest` — Perm 2
- Restart the ZAO.js bot child process without touching Main.js.
- Sends IPC message `{ type: 'restart' }` to Main.js, which kills and re-spawns ZAO.js.

#### `ريفرش` / `refresh` — Perm 2
- Hot-reload commands and events without a full restart.
- Clears the module require cache for `SCRIPTS/ZAO-CMDS/` and `SCRIPTS/ZAO-EVTS/`, then re-requires all files.

#### `cookieupdate` / `كوكيز` — Perm 2
- Manually saves the current live AppState to `ZAO-STATE.json` + `alt.json` immediately.
- Also creates a timestamped snapshot in `backups/`.

#### `setaccount` — Perm 2
- Switch the active Facebook tier (1–5).
- Updates `data/active-tier.json` and triggers a relogin with the new tier's cookies.
- Usage: `setaccount [1-5]`

#### `snapshot` — Perm 2
- Create a named version snapshot of key bot files.
- Snapshots stored in `panel/smart-versions.json` and viewable from the panel's Smart Deploy tab.
- Subcommands: `snapshot [label]` — create, `snapshot list` — list all snapshots.

#### `antdetect` — Perm 2
- View or manage anti-detection settings.
- Subcommands: `antdetect status` (current UA, presence interval, rate limit stats), `antdetect settings`, `antdetect ua` (show current user-agent), `antdetect presence`

#### `محرك` / `engine` — Perm 2
- Motor 1: group name rotation engine.
- Starts/stops a per-thread loop that changes the group name on a configurable interval.
- `محرك [interval]` — start (interval can be a fixed number of seconds, or a range like `5s-30s` or `1m-5m`)
- `محرك ايقاف` — stop the loop for this thread
- `محرك حالة` — show active loops with their current intervals

#### `محرك2` / `motor2` — Perm 2
- Motor 2: group image rotation.
- Same loop concept as `محرك` but changes the group photo.
- Cycles through a list of image URLs or local image paths.

#### `presence` — Perm 2
- Control the bot's online/away/typing presence state.
- Subcommands: `presence on`, `presence off`, `presence status`
- Uses `api.setOptions({ onlineStatus: true/false })` and `api.sendTypingIndicator`.

#### `التحكم` / `cp` — Perm 2
- Master control panel command. Single unified interface for managing:
  - `nameLocks` — list/clear group name locks
  - `nicknameLocks` — list/clear nickname locks
  - `groupImgLocks` — list/clear group image locks
  - `nickProtect` — enable/disable nickname protection per thread
  - Also generates a typed log of all recent command invocations

#### `e2ee` — Perm 2
- E2EE session management (full detail in Section 11).
- Subcommands: `status`, `bundle`, `handshake <msg>`, `send <msg>`, `pinmsg <msg>`, `pin set/clear [pin]`, `autoencrypt on/off`, `verify`, `selftest`, `diagnose`, `drop`, `list`, `import <bundle>`

---

### ENTERTAINMENT & TOOLS

#### `كرة8` / `8ball` — Perm 0
- Magic 8-ball. Picks a random answer from a predefined Arabic/English response list (~20 answers covering yes/no/maybe/ask-again).

#### `slot` — Perm 0
- Slot machine game. Generates 3 random emoji symbols. Win condition: all 3 match. Shows a spinning animation (two message edits) before revealing the result.

#### `خمن` / `guess` — Perm 0
- Number guessing game (1–100). Bot picks a number, user guesses. Bot responds with "higher", "lower", "correct!" Multi-turn: stores game state per-thread in memory.

#### `صراحة` / `truth` — Perm 0
- Truth or dare. Sends a random truth question from a predefined Arabic list.

#### `pair` — Perm 0
- Randomly "pairs" two group members. Pulls two random UIDs from `api.getThreadInfo(threadID).participantIDs`, fetches display names, formats as "💑 [Name1] × [Name2]".

#### `نرد` — Perm 0
- Roll a dice (1–6). Animates with edit-message: shows dice rolling, then final result.

#### `حظ` — Perm 0
- Daily luck score (1–100). Seed is `senderID + today's date` so the score is consistent per-user per-day.

#### `تقييم` — Perm 0
- Rate something (bot sends a random score 1–100 for whatever the user asked about).

#### `mood` — Perm 0
- Random mood/emotion generator from a list of Arabic moods with emoji.

#### `angel` — Perm 0
- Angel/devil personality quiz. Multi-turn: asks 3 questions, scores responses, gives a final angel/devil percentage.

#### `اعلام` / `flags` — Perm 0
- Country flag quiz. Bot sends a flag emoji, user has 30s to reply with the country name. Tracks score.

#### `ثنائي` — Perm 0
- Binary converter. `ثنائي [text]` → binary string. `ثنائي decode [binary]` → text.

#### `هاش` — Perm 0
- Hash generator. `هاش [text]` → MD5 and SHA-256 hashes.

#### `حاسبة` (aliases: `calc`, `calculate`, `math`) — Perm 0
- Safe math expression evaluator. Validates that the expression contains only digits, operators (`+−×÷*/^()%`), and dots. No `eval` on unvalidated input. Uses `mathjs` or equivalent safe parser.

#### `qrgen` — Perm 0
- Generate a QR code from text or URL.
- Uses the `qrcode` npm package to generate a PNG buffer, sends it as a file attachment.

#### `tempmail` — Perm 0
- Generate a temporary email address via the `temp-mail.io` or equivalent public API.
- Returns the address; if the API supports it, also watches for incoming messages (5 min polling).

#### `ذكرني` / `remind` — Perm 0
- Set a reminder. Bot mentions the user in the same thread when the time expires.
- Usage: `ذكرني [time] [message]` — time can be `5m`, `1h`, `2h30m`, etc.
- Stored in memory (lost on restart) or optionally in `data/reminders.json`.

#### `translate` / `ترجم` (aliases: `trans`, `dich`, `tr`) — Perm 0
- Translate text to any language.
- Usage: `ترجم [text] -> [lang_code]` or reply to a message to translate it.
- Defaults to Arabic (`ar`) if no target language specified.
- Uses LibreTranslate public instance or Google Translate proxy (no API key needed).

#### `طقس` / `طقس_مدينة` (aliases: `weather`, `جو`) — Perm 0
- Weather for any city via `wttr.in` — no API key required.
- Returns: temperature, weather condition, humidity, wind speed, sunrise/sunset.

#### `عملة` — Perm 0
- Currency conversion via a public exchange rate API (exchangerate.host or similar).
- Usage: `عملة [amount] [from] [to]` e.g. `عملة 100 USD SAR`

#### `تاريخ` — Perm 0
- Today's date in both Hijri (Islamic) and Gregorian calendar, formatted nicely in Arabic.

#### `pp` — Perm 0
- Fetch a Facebook profile picture.
- Accepts: @mention, reply to a message, or a bare UID.
- Downloads the profile picture and sends it as an image attachment.

#### `song` (aliases: `music`, `play`, `أغنية`, `اغنية`) — Perm 0, timeout: 75s
- Download a song from YouTube by name or URL.
- Uses `yt-dlp` or a YouTube API proxy (no `ytdl-core` — incompatible with Railway/Replit).
- Returns: audio file attachment + metadata (title, duration, thumbnail).

#### `تيكتوك` / `tiktok` (aliases: `tt`, `tk`) — Perm 0, timeout: 60s
- Download TikTok video without watermark.
- Tries multiple TikTok download APIs in sequence (primary → fallback).
- Returns: MP4 video attachment.

#### `unsend` — Perm 2
- Unsend a bot message. Must be a reply to the message to unsend.
- Uses `api.unsendMessage(messageID)`. Only works on the bot's own messages.

#### `تيست` / `test` — Perm 0
- Quick echo/debug command. Echoes back `args.join(" ")`. Used for testing bot responsiveness.

#### `divel` — Perm 0
- Divider line generator. Sends a styled ASCII separator line.

#### `أصدقاء` / `friends` — Perm 0
- Show the bot's friend list or friend count. Uses `api.getFriendsList()`.

#### `admins` — Perm 2
- List all bot admins (UIDs in `ADMINBOT` + `adminBot`) with their display names.

---

### PINTEREST

#### `بنترست` / `pin` — Perm 0
- Search Pinterest for images.
- Usage: `بنترست [search query]`
- Returns top result as image attachment.

---

## 5. EVENT HANDLERS

Event handlers live in `SCRIPTS/ZAO-EVTS/`. Each module is loaded once and its `run()` function is called on matching events from the `api.listenMqtt()` stream.

### Core Events (`includes/listen.js`)

The main listen loop (`api.listenMqtt`) fires events for:

| Event Type | Trigger |
|------------|---------|
| `message` | New message received (text, sticker, attachment) |
| `message_reply` | User replied to an existing message |
| `message_reaction` | Emoji reaction added/removed |
| `event` | Group event (member join/leave, name change, photo change, etc.) |
| `presence` | Online/offline status change |
| `read_receipt` | Message read |
| `delivered` | Message delivered |
| `typ` | Typing indicator |

### Listen.js Processing Pipeline

For every incoming event:
1. **Hash guard** (`msgHashGuard`): Deduplicates messages by computing `sha256(threadID + senderID + body)`. Drops duplicates within a 30s window.
2. **Rate limiter check** (`EnhancedRateLimiter`): Per-thread burst detection. If rate limit exceeded, queues message for later or drops silently.
3. **RAW trace** (dev-only): If `DEBUG_RAW=1` env var or `global.config.debugRaw === true`, logs the raw event object.
4. **Labyrinth decrypt**: If body starts with `🔐ZAO|` or `🔒E2EE:`, attempts decryption before passing to command handler.
5. **Auto-seen**: Queues a "mark as read" action with random jitter.
6. **Stealth engine**: Calls `_stealthEngine.handleIncoming(threadID)` to record activity for typing simulation calibration.
7. **Command dispatch**: Calls `handleCommand(event, api)`.
8. **Event dispatch**: Calls the matching event handler from `global.client.events`.

### Key Event Handlers

#### `addParticipants` event
- Fires when someone is added to a group.
- Sends a welcome message (configurable template in settings).
- Checks if the added user is in the ban list → kicks immediately if so.

#### `removeParticipants` event
- Fires when someone leaves or is kicked.
- If `lockdown` or `antiout` is enabled for this thread: re-adds the removed user via `api.addUserToGroup`.

#### `changeNickname` event
- Fires when any member changes a nickname.
- If `protect` is enabled for this thread: checks whether the changer is a group admin. If not, reverts the nickname to the saved value from `data/protectData.json`.
- If nickname locks are active: schedules an immediate lock re-enforcement.

#### `changeThreadName` event
- Fires when the group name changes.
- If a name lock is active for this thread: reverts to the locked name via `api.setTitle`.

#### `changeThreadImage` event
- Fires when the group photo changes.
- If a group image lock is active: reverts to the locked image.

#### `message_reaction` event
- If reaction emoji is in `reactUnsend.emojis` AND the reactor is a bot admin AND the reacted-to message was sent by the bot: calls `api.unsendMessage(messageID)`.

---

## 6. SECURITY & PROTECTION SYSTEMS

### 6A — Auto-Lock Guard (`includes/autoLockGuard.js`)

**Purpose**: Rate-limit command abuse. If non-admin commands exceed `maxCommands` within `windowSeconds`, the bot locks globally for `unlockAfterMinutes` minutes.

**How it works**:
- Every command invocation records a timestamp in `_attempts[]`.
- If `_attempts.filter(t => t > windowStart).length >= maxCommands` and sender is NOT a bot admin: `global.lockBot = true`.
- Sets `_lockedAt`, schedules auto-unlock timer.
- On auto-unlock: `global.lockBot = false`, `_attempts.length = 0`, **`_senderWarned.clear()`** (important — prevents stale "already warned" state after auto-unlock), calls `_flushState()`.
- On manual unlock (`setLock(false)` from panel or command): same cleanup.
- Admin bypass: commands from UIDs in `ADMINBOT/adminBot` never count toward the attempt window.
- DM send to admins when the lock triggers (random delay 800–2000ms to avoid burst-notifying all admins simultaneously).
- State persisted to `data/lock-state.json` (so lock survives a bot crash/restart).

### 6B — CSRF Protection (Web Panel)

**Implementation**: Double-submit cookie pattern.
- On login, server generates `crypto.randomBytes(24).toString('hex')` as the CSRF token.
- Stored in `req.session.csrfToken` (server-side, httpOnly session cookie).
- Also set as a JS-readable cookie `_csrf` (httpOnly: false, sameSite: lax).
- All state-changing panel requests must include `X-CSRF-Token: <token>` header.
- Middleware at the top of all POST/PUT/DELETE routes checks: `clientToken === req.session.csrfToken`.
- A separate GET `/api/csrf` route lets the frontend refresh the token after soft navigation.

### 6C — Rate Limiter (`includes/EnhancedRateLimiter.js`)

Per-thread `burstCoolingUntil` is a **Map** (keyed by threadID string), not a global boolean. This means a burst in one group doesn't block other groups.

Key tunables (from `ZAO-SETTINGS.json → rateLimit`):
- `maxMessagesPerWindow` — max messages per thread in the window
- `windowMs` — sliding window duration
- `burstCooldownMs` — how long a bursting thread is throttled
- `globalQueueCap` — max queued messages across all threads

### 6D — Session Guard (`includes/sessionGuard.js`)

- Periodically validates the active session by attempting a lightweight Facebook API call.
- On failure: saves a cookie snapshot to `backups/`, logs a warning, optionally triggers `global._triggerAutoRelogin`.
- Default state path: configured by caller (`ZAO.js` passes `statePath` at startup).
- Cookie snapshot format: `backups/ZAO-STATE-YYYY-MM-DD-HH-MM.json`.

### 6E — IP Reputation Monitor (`includes/IpReputationMonitor.js`)

- Periodically checks the current outbound IP against known block/proxy lists.
- On detection: logs warning to admins, optionally adjusts stealth engine settings.

### 6F — Whitelist Mode

Two independent whitelist modes from `ZAO-SETTINGS.json`:

| Setting | Effect |
|---------|--------|
| `whiteListMode.enable` | Only UIDs in `whiteListMode.whiteListIds` can use any command |
| `whiteListModeThread.enable` | Bot only responds in threads listed in `whiteListModeThread.whiteListThreadIds` |

Both are checked in `handleCommand.js` before any command dispatches.

### 6G — Bad Words Auto-Delete

- `data/badwords.json` → `{ [threadID]: { enabled: bool, words: [string] } }`
- Message event handler checks every inbound `event.body` against the active thread's word list.
- On match: `api.unsendMessage(event.messageID)` immediately.
- Case-insensitive, partial-word match (uses `includes()`).

### 6H — DM Lock (`includes/dmLock.js`)

- `global.config.allowInbox` setting controls whether the bot responds to DMs.
- If `allowInbox === false` and the thread is a DM (senderID === threadID) and sender is not a bot admin: silently ignore.

### 6I — Event Loop Guard (`includes/eventLoopGuard.js`)

- Monitors Node.js event loop lag using `process.hrtime()`.
- If lag exceeds a threshold (e.g. 500ms), logs a warning.
- Used to detect when a synchronous blocking operation is hanging the bot.

### 6J — Disk Guard (`includes/diskGuard.js`)

- Monitors available disk space.
- If disk usage exceeds 85%, logs a critical warning to admins.
- Prevents crash from log file growth.

---

## 7. SEND PIPELINE & RATE LIMITING

### `includes/sendPipeline.js`

All bot outgoing messages route through the send pipeline:

1. **Human typing delay** (`includes/humanTyping.js`): Calculates delay based on message length, `charsPerSecond`, jitter percent, and night mode multiplier. The `msg` object (containing the full message form) is passed to `calcDelay()` so image/file attachments get a longer "upload simulation" delay than plain text.
2. **Typing indicator**: Sends `api.sendTypingIndicator(threadID)` for the calculated delay duration.
3. **Rate limit check**: Checks `global._rateLimiter` before actually sending.
4. **sendMessage**: Calls `api.sendMessage(form, threadID, callback)`.
5. **Error interception**: Any send error is forwarded to `accountHealthMonitor`'s patched `sendMessage` wrapper for failure counting.

All `require()` calls inside the send path use lazy caching (load once on first call, store in a module-level variable) to avoid performance-critical `require()` on every message send.

---

## 8. SESSION & COOKIE MANAGEMENT

### Tier System

| Tier | Cookie File | Alt File |
|------|------------|---------|
| 1 | `sessions/ZAO-STATE.json` | `alt.json` |
| 2 | `sessions/ZAO-STATE2.json` | `alt2.json` |
| 3 | `sessions/ZAO-STATE3.json` | `alt3.json` |
| 4 | `sessions/ZAO-STATE4.json` | `alt4.json` |
| 5 | `sessions/ZAO-STATE5.json` | `alt5.json` |

- `tierLimit` in `ZAO-SETTINGS.json` controls the maximum tier to try (1–5). Default: 1.
- Tiers 4 and 5 start as empty placeholder files. Upload valid cookie JSON via the panel's Cookies tab to activate them.

### Login Flow (`includes/Emalogin/`)

1. Read active tier from `data/active-tier.json`
2. Load the corresponding `ZAO-STATE.json` file
3. Call `@neoaz07/nkxfca`'s `login({ appState })` to restore the session
4. If login fails (expired cookies, checkpoint, etc.): call `forceTierSwitch()` to increment tier and retry
5. After all tiers exhausted: wait 3 minutes, reset tier to 1, retry — **never exits**

### Auto-Relogin (`includes/login/autoRelogin.js`)

- `global._triggerAutoRelogin(reason)` — callable from anywhere to force a relogin
- `forceTierSwitch(api, reason)` — increments tier, saves new tier, triggers relogin
- Admins are notified **after** a successful tier switch (not before — avoids false alarms on failed attempts)
- Reads `global.config` first for admin IDs (most current), falls back to `ZAO-SETTINGS.json` on disk

### Account Health Monitor (`includes/login/accountHealthMonitor.js`)

Two independent health signals:
1. **Cookie scan** (every 25–35 min, jittered): Calls `checkLiveCookie(cookieStr)` against Facebook. On confirmed-dead response → triggers `global._triggerAutoRelogin`.
2. **Send-failure watchdog**: Patches `api.sendMessage`. On 3+ non-auth send failures within 5 min → triggers `forceTierSwitch()`.

Status broadcast to admins: every 55–75 min (jittered, using self-scheduling setTimeout — NOT a fixed setInterval, to avoid a predictable fingerprint).

### Cookie Snapshots

- `includes/cookieSnapshot.js` — creates `backups/ZAO-STATE-YYYY-MM-DD-HH-MM.json`
- Triggered on: manual `cookieupdate` command, session guard failure, successful relogin

---

## 9. ANTI-SUSPENSION ENGINE

`includes/antiSuspension.js` + `includes/stealthEngineV2.js` + `includes/HumanActivitySimulator.js`

### Human Typing Simulation

Settings (from `ZAO-SETTINGS.json → humanTyping`):
```json
{
  "enable": true,
  "minDelay": 800,
  "maxDelay": 4200,
  "charsPerSecond": 12,
  "jitterPercent": 30,
  "nightModeMultiplier": 2.2,
  "thinkingPauseChance": 0.18,
  "thinkingPauseMs": 1800
}
```

Calculation: `baseDelay = message.length / charsPerSecond * 1000`. Apply jitter: ± `jitterPercent`%. If nightMode (22:00–06:00 UTC): multiply by `nightModeMultiplier`. If `Math.random() < thinkingPauseChance`: add `thinkingPauseMs` extra pause. Clamp to `[minDelay, maxDelay]`.

### User-Agent Rotation

`stealthEngineV2.js` maintains a pool of 15+ realistic mobile/Android/iOS/Facebook-App user-agent strings (2024–2025 versions). A UA is randomly selected on each HTTP-based API call. Pool includes:
- Android Chrome (v132–135) on Pixel, Samsung, Xiaomi, OnePlus
- Facebook App (Android FBAV 489–492) with proper FBAN/FB4A tags

MQTT connections use a fixed UA matching the one that established the login session (changing it mid-session causes detection).

### Online Presence Cycling

- Sends a HEAD ping to `facebook.com` or `m.facebook.com` on a random interval (30–120 min).
- Uses a rotating UA from the pool.
- Timer uses `.unref()` so it doesn't prevent process exit.

### Read Receipt Randomization

- "Mark as seen" events are queued rather than sent instantly.
- Random jitter of 2–8 seconds before sending the seen receipt.

---

## 10. MQTT HEALTH & WATCHDOG

### `includes/mqttHealthCheck.js`

Monitors MQTT silence (no incoming messages):
- If no message received in `silentTimeoutMinutes` (default: 10 min): triggers reconnect
- Check interval is randomized between `checkIntervalMinMinutes`–`checkIntervalMaxMinutes` (default 2–5 min)
- Exponential backoff on repeated reconnect failures: `delay = min(base * backoffMultiplier^attempt, maxBackoff)`
- After `maxRestarts` failures: alerts admins and enters a long-wait state

### KeepAlive Pings (`includes/keepAlive.js`)

- Periodic HEAD request to `m.facebook.com` or `mbasic.facebook.com` (randomly chosen)
- Interval: 8–18 minutes (jittered)
- Uses rotating UA from the stealth engine pool
- Timer uses `.unref()` to avoid blocking clean shutdown

### `includes/nkxfcaModernizer.js`

Patches the `@neoaz07/nkxfca` API client to handle auth errors:
- Intercepts MQTT errors with keywords: checkpoint, session expired, not-authorized, cookie
- Routes them to `global._triggerAutoRelogin()` instead of crashing

---

## 11. E2EE / LABYRINTH

Full Signal Protocol implementation in `includes/labyrinth/Labyrinth.js`.

### Protocol

- **Key Exchange**: X3DH (Extended Triple Diffie-Hellman)
- **Message Encryption**: Double Ratchet (forward secrecy + break-in recovery)
- **Legacy fallback**: AES-256-CBC with a PIN-derived key (for users who haven't completed X3DH)

### Wire Format

```
Signal:   🔐ZAO|<base64-encoded-JSON>
Legacy:   🔒E2EE:<base64>
```

The emoji prefix allows the listener to identify encrypted messages before attempting Base64 decode.

### Session State

Per-thread session stored in `data/labyrinth-{threadID}.json`:
```json
{
  "ratchetState": { ... },
  "identityKey": "...",
  "sessionTs": 1234567890
}
```

### Commands (via `e2ee` command)

| Subcommand | Action |
|-----------|--------|
| `bundle` | Share your public key bundle (identity + signed prekey) |
| `handshake <bundle>` | Complete X3DH with a recipient's bundle |
| `send <msg>` | Send an encrypted message |
| `verify` | Verify the current session's safety number |
| `selftest` | Encrypt and decrypt a test message locally |
| `diagnose` | Check session health (ratchet state, message counters) |
| `drop` | End the E2EE session (clear local ratchet state) |
| `list` | List active E2EE sessions |
| `autoencrypt on/off` | Toggle: all outgoing messages automatically encrypted |
| `pin set [pin]` / `pin clear` | Set/clear a PIN for AES-256 fallback mode |
| `import <bundle>` | Import a pre-shared bundle (offline key exchange) |

---

## 12. WEB PANEL (zao-server.js)

Express SSR panel on port 5000. Auth: session-cookie middleware. Password via `PANEL_PASSWORD` env var (default: `SainxSain`).

All routes are behind `requireAuth` middleware. CSRF token required on all state-changing requests.

### Authentication Flow

1. GET `/login` → renders login form
2. POST `/login` with `password` field → if correct: `req.session.authenticated = true`, generate CSRF token, redirect to `/status`
3. All protected routes check `req.session.authenticated === true`, else redirect to `/login`

### Panel Tabs (13 Facebook Tabs)

| Tab | Route | Key Features |
|-----|-------|-------------|
| الرئيسية | `/status` | Bot online/offline badge, active tier, MQTT status, message counter, restart count, last 3 restarts (timestamp + exit code), total system uptime from `first-start.json`, process uptime |
| السجلات | `/logs` | Real-time log stream (Server-Sent Events `/api/logs`), filterable by level, last N lines, ANSI stripping, live search box |
| الإعدادات | `/settings` | Full `ZAO-SETTINGS.json` editor: all fields rendered as form inputs. Saving calls `atomicWriteFileSync` then optionally triggers a config reload in ZAO.js via IPC |
| الأوامر | `/commands` | Table: all loaded commands with name, category, perm, cooldown, aliases. Toggle enable/disable per command (updates `commandDisabled[]` in settings without restart) |
| المجموعات | `/groups` | All active threads from `global.data.allThreadID`. Name, thread ID, member count. Search. Send message to any thread directly from panel |
| الأدمن | `/admins` | Manage `ADMINBOT` + `adminBot` arrays: add/remove UIDs, display names shown via API lookup |
| الكوكيز | `/cookies` | Tier 1–5 cookie file manager: view file size + last-modified + validity indicator (calls `checkLiveCookie`). Upload new AppState JSON. Download current. Set `tierLimit` |
| الذاكرة | `/db` | SQLite browser: tables (users, threads, currencies). Search by ID. Export table as JSON download |
| الحماية | `/security` | AutoLock control (toggle + manual unlock + current lock status). Badwords list per group (add/remove/toggle). Whitelist mode toggle. Rate limiter live stats |
| الكنيات | `/nicknames` | Nickname lock state across all groups: active template, per-user locks, clear per group |
| الديف هب | `/devhub` | AI DevHub — 5 agents (see Section 14) |
| السمارت ديبلوي | `/smart-deploy` | Version snapshots: create, restore, view diff vs current |
| التيار | `/tier` | Active tier selector, tier file status (uploaded vs empty placeholder), upload tier files |

### Instagram Sub-Panel (4 pages, at `/insta/*`)

| Page | Route | Features |
|------|-------|---------|
| نظرة عامة | `/insta` | Instagram bot online/offline, session age, message count, reconnect status |
| المحادثات | `/insta/threads` | Active threads: name, ID, last message time. Send a message to any thread |
| الأوامر | `/insta/commands` | Instagram command list with enable/disable |
| الإعدادات | `/insta/settings` | Username/password input (triggers INSTA.js login), prefix, admin IDs, rate limit config |

### Key API Endpoints

```
GET  /api/bot-status          → Live ZAO.js metrics (queries port 3001)
GET  /api/logs                → SSE log stream
POST /api/settings            → Save ZAO-SETTINGS.json (CSRF required)
POST /api/commands/toggle     → Enable/disable a command
POST /api/lock/toggle         → Toggle autoLock on/off
POST /api/lock/unlock         → Manual unlock
GET  /api/csrf                → Refresh CSRF token
POST /api/cookies/upload/:tier → Upload AppState JSON for a tier
GET  /api/cookies/download/:tier → Download AppState JSON
POST /api/send-message        → Send a message to any thread
POST /api/restart             → Restart ZAO.js child
POST /api/snapshot            → Create a version snapshot
GET  /api/insta/status        → Instagram bot metrics
```

---

## 13. INSTAGRAM BOT (INSTA.js)

### Technology Stack

- **API**: `instagram-private-api` + `instagram_mqtt`
- **MQTT**: `instagram_mqtt.withRealtime(ig)` wraps `IgApiClient` instance
- **Pattern**: MQTT event triggers a poll + 60s safety poll always runs + falls back to `pollInterval` on disconnect

### Session Management

- Session persisted to `INSTA-STATE.json` every 10 minutes
- On startup: if `INSTA-STATE.json` exists and is valid JSON, restores session (no re-login needed)
- On session failure: re-login with username + password from `INSTA-SETTINGS.json`

### Protection

- Rate limiter: 20 commands/min per thread, 60 commands/min global
- Session health check every 30 min
- Auto re-login on session expiry
- Typing delay simulation (similar to Facebook bot but simpler)

### Encryption

Instagram handles transport encryption natively. ZAO-INSTA uses AES-256 session encryption (not Labyrinth/Signal — different protocol). No X3DH needed.

### Instagram Commands (`SCRIPTS/INSTA-CMDS/`)

| Command | Description |
|---------|-------------|
| `!ping` | Latency + status check |
| `!help` | List available commands |
| `!info` | Bot info (username, uptime, version) |
| `!احصائيات` | Instagram session stats |
| `!ai` | AI chat via OpenRouter (same models as Facebook bot) |
| `!nm` | Group name control for Instagram threads |
| `!slot` / `!نرد` / `!كرة8` | Entertainment commands |
| `!ترجم` / `!حاسبة` / `!طقس` / `!تاريخ` | Utility commands |
| `!حظ` / `!تقييم` / `!حقيقة` / `!ثنائي` | More entertainment |
| `!شخصية` / `!عشوائي` / `!معرف` | AI + utility |
| `!هاش` / `!صدى` / `!محرك` / `!محرك2` | Tools + motors |

---

## 14. DEVHUB AI AGENTS

`webpanel/zao-devhub.js` — 5 specialized AI agents powered by OpenRouter.

**Config**: `devhub-openrouter.json` — stores `apiKey`, `model` (active model for DevHub), and per-agent system prompts.

| Agent | Arabic Name | Role |
|-------|-------------|------|
| Command Developer | مطور الأوامر | Write or modify bot commands. Input: description of what you want → Output: complete `module.exports.config + run` block, ready to save in `SCRIPTS/ZAO-CMDS/` |
| Error Analyzer | محلل الأخطاء | Paste error/stack trace → explains cause + provides fix with code |
| Code Reviewer | مراجع الكود | Paste any code → security/quality review + improvement suggestions |
| Settings Generator | مولّد الإعدادات | Describe desired bot behavior → generates the matching `ZAO-SETTINGS.json` block |
| General Assistant | المساعد العام | Free-form questions about architecture, commands, deployment, debugging |

Each agent has a specialized system prompt injected at the start of every conversation. The DevHub settings page lets you change the OpenRouter API key, active model, and customize each agent's system prompt.

---

## 15. DATABASE LAYER

### Sequelize / SQLite (default)

Models in `DB/`:
- `Users` — `{ userID (PK), name, exp, money, data (JSON blob) }`
- `Threads` — `{ threadID (PK), settings (JSON blob), data (JSON blob) }`
- `Currencies` — `{ userID, threadID, balance, bankBalance, lastUpdated }` (composite PK)

`data` JSON blobs are used for arbitrary per-user / per-thread storage by commands (e.g. game state, custom preferences).

### Mongoose / MongoDB (optional)

If `MONGODB_URI` is set in environment, the bot uses Mongoose models instead of SQLite. Schema mirrors the Sequelize models. The database adapter layer (`DB/controllers/`) provides the same API regardless of backend.

### ORM Helper API

Commands use the ORM helpers passed in the `run` function signature:
```js
Users.getData(userID)           → { exp, money, data }
Users.setData(userID, data)
Threads.getData(threadID)       → { settings, data }
Threads.setData(threadID, data)
Currencies.getData(userID, threadID) → { balance, bankBalance }
Currencies.setData(userID, threadID, data)
```

---

## 16. KEY DATA FILES & SCHEMAS

```
data/
  ban.json
    { "[threadID]": [{ uid, reason, bannedBy, ts }] }

  warn.json
    { "[threadID]": { "[uid]": { count: N, reasons: ["reason1", ...] } } }

  ai-users.json
    { users: [{ ids: ["uid1", "uid2"], name: "Display Name", note: "extra info" }] }

  nameLocks.json
    { "[threadID]": { name: "Locked Name", interval: null | { min: ms, max: ms }, timer: null } }

  nicknameLocks.json
    { "[threadID]": { groupLock: { template: "{name}", botNick: "ZAO" }, userLocks: { "[uid]": "Nick" } } }

  groupImgLocks.json
    { "[threadID]": { imageUrl: "https://...", lockedBy: "uid", ts: ms } }

  badwords.json
    { "[threadID]": { enabled: true, words: ["word1", "word2"] } }

  autoinvite_settings.json
    { "[threadID]": { enabled: true } }

  protectData.json
    { "[threadID]": { "[uid]": "saved_nickname" } }

  restart-stats.json
    { count: N, totalAllTime: N }

  restart-history.json
    [ { ts: ms, date: "ISO string", code: N, uptimeMs: N }, ... ]  (max 10 entries)

  first-start.json
    { timestamp: "2025-01-01T00:00:00.000Z" }  (written once, NEVER overwritten)

  active-tier.json
    { tier: 1 }

  lock-state.json
    { locked: false, lockedAt: 0, attempts: [] }

  labyrinth-[threadID].json
    { ratchetState: {...}, identityKey: "...", sessionTs: ms }

  reminders.json (optional)
    [ { uid, threadID, fireAt: ms, message: "..." }, ... ]

backups/
  ZAO-STATE-YYYY-MM-DD-HH-MM.json    (timestamped cookie snapshots)

sessions/
  ZAO-STATE.json      (tier 1 live cookies — AppState array)
  ZAO-STATE2.json     (tier 2)
  ZAO-STATE3.json     (tier 3)
  ZAO-STATE4.json     (tier 4 — empty placeholder until uploaded)
  ZAO-STATE5.json     (tier 5 — empty placeholder until uploaded)
  alt.json            (tier 1 backup copy)
  alt2.json … alt5.json

panel/
  smart-versions.json
    [ { label: "v1.2", ts: ms, files: { "ZAO.js": "..content..", ... } }, ... ]
```

---

## 17. FULL ZAO-SETTINGS.json REFERENCE

```json
{
  "BOTNAME": "ZAO",
  "PREFIX": ".",
  "ADMINBOT": ["uid1", "uid2"],
  "adminBot":  ["uid1", "uid2"],
  "language": "vi",
  "adminOnly": false,
  "allowInbox": true,
  "DeveloperMode": false,
  "debugRaw": false,

  "humanTyping": {
    "enable": true,
    "minDelay": 800,
    "maxDelay": 4200,
    "charsPerSecond": 12,
    "jitterPercent": 30,
    "nightModeMultiplier": 2.2,
    "thinkingPauseChance": 0.18,
    "thinkingPauseMs": 1800
  },

  "mqttHealthCheck": {
    "enable": true,
    "silentTimeoutMinutes": 10,
    "checkIntervalMinMinutes": 2,
    "checkIntervalMaxMinutes": 5,
    "maxRestarts": 5,
    "backoffMultiplier": 1.5,
    "maxBackoffMinutes": 15,
    "notifyAdmins": true
  },

  "autoLock": {
    "enable": true,
    "maxCommands": 15,
    "windowSeconds": 30,
    "unlockAfterMinutes": 10,
    "notifyAdmins": true
  },

  "reactUnsend": {
    "enable": true,
    "onlyAdmin": true,
    "emojis": ["😡", "😠"]
  },

  "whiteListMode": {
    "enable": false,
    "whiteListIds": []
  },

  "whiteListModeThread": {
    "enable": false,
    "whiteListThreadIds": []
  },

  "commandDisabled": [],

  "notiWhenListenMqttError": {
    "minIntervalMinutes": 10,
    "telegram": {
      "enable": false,
      "botToken": "",
      "chatId": ""
    },
    "discordHook": {
      "enable": false,
      "webhookUrl": ""
    }
  },

  "rateLimit": {
    "maxMessagesPerWindow": 20,
    "windowMs": 10000,
    "burstCooldownMs": 30000,
    "globalQueueCap": 100
  },

  "tierLimit": 1,

  "simsimiApiKey": "",
  "youtubeApiKey": "",
  "wolframApiKey": "",
  "weatherApiKey": "",

  "keepAlive": {
    "enable": true,
    "minIntervalMs": 480000,
    "maxIntervalMs": 1080000
  },

  "sessionGuard": {
    "enable": true,
    "checkIntervalMs": 900000
  }
}
```

---

## 18. UTILITY MODULES

| Module | Path | Purpose |
|--------|------|---------|
| `atomicWrite` | `utils/atomicWrite.js` | `atomicWriteFileSync(path, data, enc)` — write-to-temp then rename |
| `configManager` | `includes/configManager.js` | Loads/saves/hot-reloads `ZAO-SETTINGS.json` |
| `kvStore` | `includes/kvStore.js` | In-memory key-value store with optional disk persistence |
| `liveStats` | `includes/liveStats.js` | Collects real-time metrics (message count, command count, uptime) for the panel |
| `errorHandler` | `includes/errorHandler.js` | Global uncaughtException / unhandledRejection handler; logs to file, alerts admins |
| `crashFingerprinter` | `includes/crashFingerprinter.js` | Tracks crash patterns; if the same error repeats 3+ times, flags it as a "recurring bug" |
| `commandErrorBudget` | `includes/commandErrorBudget.js` | Rolling timeout/error history per command (5-min window); used for diagnostics |
| `diskGuard` | `includes/diskGuard.js` | Monitors disk usage; alerts at 85% |
| `eventLoopGuard` | `includes/eventLoopGuard.js` | Detects event loop lag > 500ms |
| `groupActivityTracker` | `includes/groupActivityTracker.js` | Tracks per-thread inbound message frequency; used by stealth engine for timing calibration |
| `friendManager` | `includes/friendManager.js` | Manages the bot's friend list (accept requests, prune old friends) |
| `dmLock` | `includes/dmLock.js` | Per-thread DM block (global `allowInbox` setting) |
| `autoUptime` | `includes/autoUptime.js` | Generates the uptime canvas image for the `uptime` command |
| `devCenter` | `includes/devCenter.js` | Development mode helpers (stack traces, verbose logging) |

---

## 19. WRITING NEW COMMANDS — STEP-BY-STEP

1. **Create the file**: `SCRIPTS/ZAO-CMDS/mycommand.js`

2. **Export config**:
   ```js
   module.exports.config = {
     name:            "mycommand",
     aliases:         ["mc", "myalias"],
     version:         "1.0.0",
     hasPermssion:    0,           // 0/1/2
     credits:         "Your Name",
     description:     "What it does",
     commandCategory: "أدوات",    // Arabic category name for help.js
     usages:          "mycommand [arg1] [arg2]",
     cooldowns:       5,           // seconds between calls per user
     // timeout: 60000,            // uncomment only for slow commands (>30s)
   };
   ```

3. **Export run**:
   ```js
   module.exports.run = async function ({ api, event, args, Users, Threads }) {
     const { threadID, messageID, senderID, body, isGroup } = event;
     const input = args.join(" ").trim();

     if (!input) {
       return api.sendMessage("❌ يرجى إدخال نص.", threadID, messageID);
     }

     // Your logic here

     return api.sendMessage("✅ النتيجة: " + result, threadID, messageID);
   };
   ```

4. **Tips**:
   - **Always validate input** before using it. Never pass user input directly to `eval`, `exec`, or file paths.
   - **Use `api.sendMessage(form, threadID, messageID)` where `messageID` is passed as the third arg to reply to the triggering message.**
   - **For file attachments**: `api.sendMessage({ body: "caption", attachment: fs.createReadStream(filePath) }, threadID)` — delete temp files in a `finally` block.
   - **For slow APIs**: add `config.timeout: 60000` (or higher) to opt out of the 30s default sandbox timeout.
   - **For per-thread state**: use `global.data` Maps or the `Threads.getData(threadID)` ORM helper, not module-level variables (they're shared across threads).
   - **Atomic writes**: if your command saves a JSON file, use `atomicWriteFileSync` from `utils/atomicWrite.js`.
   - **Cooldown**: the sandbox enforces `config.cooldowns` automatically — you don't need to implement it yourself.

5. **Restart the bot** (or use the `ريفرش` command) to load the new command.

---

## 20. DEBUGGING & ERROR CODES

### Common Facebook API Errors

| Error / Code | Meaning | Fix |
|-------------|---------|-----|
| "checkpoint" | Account requires a security check | Upload fresh cookies from a clean browser session |
| "session expired" | AppState cookies are dead | Upload fresh cookies or wait for auto-relogin to try next tier |
| error 1545012 | Bot not in the conversation | The bot must be added to the group first |
| error 200 | Permission denied (Facebook API) | Bot account may be rate-limited or the action is blocked for this account |
| error 368 | Messaging disabled / blocked | Account is temporarily blocked from sending — trigger tier switch |
| error 190 | OAuth token expired | Fresh AppState required |
| error 1357004 | Messaging blocked | Same as 368 |
| error 613 | Rate limit for this endpoint | Back off; reduce send frequency |
| "not allowed to send" | Blocked from sending to this thread | The account is specifically blocked from messaging this person/group |

### Bot Not Responding

1. Check the panel `/status` tab — is the bot online?
2. Check `/logs` for MQTT disconnect or login failure messages
3. Verify `ZAO-STATE.json` is valid JSON and not empty
4. Check if `global.lockBot === true` (autoLock triggered) — unlock from panel `/security`
5. Check `whiteListMode` and `whiteListModeThread` — the sender or thread may be excluded
6. Check `commandDisabled` — the command may be disabled

### `DEBUG_RAW=1` Mode

Set the `DEBUG_RAW` environment variable to `1` (or `global.config.debugRaw = true`) to enable raw event logging. Every incoming MQTT event is printed in full detail including senderID, threadID, body, and all metadata. **Do not use in production** — floods logs with PII.

### `DeveloperMode` Setting

When `global.config.DeveloperMode === true`, the bot prints detailed stack traces for command errors instead of the user-friendly "an error occurred" message. Useful when developing new commands.

### Log File Access

- Structured logs: `global.loggeryuki` (colored, level-based console output)
- Panel SSE stream: GET `/api/logs` — real-time, filterable by level
- Plain file logs: check if `appendLog()` in Main.js is writing to a log file (default: `logs/bot.log`)

---

## 21. DEPLOYMENT NOTES

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PANEL_PASSWORD` | No | `SainxSain` | Web panel login password |
| `OPENROUTER_API_KEY` | For AI | — | OpenRouter API key (fallback: `devhub-openrouter.json`) |
| `MONGODB_URI` | No | — | If set, use MongoDB instead of SQLite |
| `DEBUG_RAW` | No | `0` | Set to `1` for raw event logging (dev only) |
| `BOT_TIER` | No | `1` | Force a specific account tier (bypasses auto-fallback) |
| `BOT_API_PORT` | No | `3001` | Internal bot API port |

### Port Usage

| Port | Used by | External? |
|------|---------|-----------|
| 5000 | Web panel (Express) | Yes — this is the only public port |
| 3001 | Bot internal API (ZAO.js) | No — localhost only |
| 3002 | Instagram bot internal API (INSTA.js) | No — localhost only |

### Startup Command

```bash
npm start
# → runs: node Main.js
```

Main.js spawns ZAO.js and INSTA.js as child processes. Do not run ZAO.js or INSTA.js directly — they need the IPC channel from Main.js to function correctly.

### First Boot

1. Set `PANEL_PASSWORD` environment variable
2. Upload valid Facebook AppState cookies (JSON array from a logged-in Facebook session) via the panel → الكوكيز tab, or place the file at `sessions/ZAO-STATE.json`
3. Set your admin UIDs in the panel → الإعدادات tab (`ADMINBOT` field)
4. Optionally set your OpenRouter API key for AI features
5. The bot will connect and begin responding to messages with the configured prefix (default: `.`)

### Cookie Format (AppState)

```json
[
  { "key": "c_user", "value": "1234567890", "domain": ".facebook.com", "path": "/", "hostOnly": false, "creation": "...", "lastAccessed": "..." },
  { "key": "xs", "value": "...", "domain": ".facebook.com", ... },
  ...
]
```

Obtain from a logged-in Facebook session using a browser extension (e.g. Cookie Editor). The bot needs at minimum `c_user` and `xs` cookies to authenticate.

### Scaling / Multiple Accounts

- Up to 5 Facebook accounts (tiers) supported.
- Set `tierLimit: N` in `ZAO-SETTINGS.json` (N = 1–5) to control how many tiers the bot will try.
- Tier switch is automatic on login failure. Manual switch: `setaccount [tier]` command or panel → التيار tab.
- Two-process variant: `BOT_TIER` and `BOT_API_PORT` env vars let Main.js run two independent ZAO.js instances on different ports (useful for running two active accounts simultaneously).
