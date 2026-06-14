# ZAO Bot — Facebook Messenger bot with a web-based admin dashboard

## Run & Operate
- **Start**: `npm start` (runs `node Main.js`)
- **Port**: 5000 (web panel)
- **Panel password**: set `PANEL_PASSWORD` env var (default: `SainxSain`)
- **Bot config**: `ZAO-SETTINGS.json`
- **Facebook session**: `ZAO-STATE.json` (AppState / cookies)

## Stack
- **Runtime**: Node.js 20.x
- **Web panel**: Express + express-session (SSR, no frontend framework)
- **Bot API**: Built-in HTTP server on port 3001 (internal only)
- **Database**: SQLite3 via Sequelize ORM (default); optional MongoDB via Mongoose
- **Facebook API**: `@neoaz07/nkxfca` (unofficial Facebook Chat API over MQTT)
- **Tier support**: 5 Facebook accounts (tiers 1-5); configurable via `tierLimit` in ZAO-SETTINGS.json

## Where things live
- `Main.js` — master launcher, watchdog, web panel HTTP server on port 5000
- `ZAO.js` — bot child process; Facebook login, command loading, MQTT
- `SCRIPTS/ZAO-CMDS/` — command modules (one file per command)
- `SCRIPTS/ZAO-EVTS/` — event handlers
- `webpanel/zao-server.js` — Express SSR panel (12 tabs)
- `webpanel/zao-devhub.js` — AI DevHub (5 agents)
- `includes/` — core library: login, labyrinth (E2EE), protection, utils
- `DB/` — Sequelize/Mongoose models and controllers
- `ZAO-SETTINGS.json` — all bot configuration (source of truth)
- `ZAO-STATE.json` — active Facebook session cookies (tier 1)
- `data/` — runtime state (active tier, group cache, etc.)
- `backups/` — timestamped cookie snapshots

## Architecture decisions
- **Two-process watchdog**: `Main.js` spawns `ZAO.js` as a child process so the web panel stays alive even if the bot crashes and restarts
- **Custom auth**: Panel uses its own session-token auth (no third-party provider); password set via `PANEL_PASSWORD` env var
- **Atomic writes**: `utils/atomicWrite.js` protects cookie and settings files from corruption on concurrent writes
- **Tier system**: Multiple Facebook accounts supported; auto-fallback on login failure
- **Optional API keys**: External service keys (YouTube, Wolfram, weather, etc.) are optional and configured in `ZAO-SETTINGS.json` — bot works without them

## Product
- Facebook Messenger chatbot responding to ~13 active commands + **Instagram bot** (ZAO-INSTA) running in parallel
- Real-time web admin panel with 13 Facebook tabs + **ZAO-INSTA sub-panel** (4 pages: overview, threads, commands, settings)
- Anti-suspension stealth engine (human typing simulation, user-agent rotation, read receipt randomization)
- End-to-end encryption support via Labyrinth (Signal Protocol / Double Ratchet)
- MQTT health monitoring with backoff-based reconnection and auto-restart
- Persistent restart counter and restart history (last 3) stored in `data/restart-stats.json` and `data/restart-history.json`
- System uptime tracked from first boot in `data/first-start.json` — survives panel/bot restarts
- Cookie retry loop: when all 5 tiers exhausted, auto-retries every 3 minutes instead of giving up

## User preferences
- Simple, everyday language in responses

## ZAO-INSTA
- **Process**: `INSTA.js` — child process on port **3002** (internal only, does NOT conflict with Facebook's port 3001)
- **API**: `instagram-private-api` + `instagram_mqtt` npm packages
- **Commands**: `SCRIPTS/INSTA-CMDS/` — `!ping`, `!help`, `!info`, `!احصائيات`, `!ai`
- **Session**: `INSTA-STATE.json` — persisted every 10 minutes
- **Settings**: `INSTA-SETTINGS.json` — username, password, prefix (`!`), admin IDs, rate limits
- **Panel**: `/insta` in the sidebar (pink/purple Instagram theme, 4 sub-pages)
- **E2EE**: Instagram handles transport encryption natively; ZAO-INSTA uses AES-256 session (no Labyrinth — different protocol)
- **Protection**: rate limiter (20/min/thread, 60/min global), session verify every 30 min, auto re-login, typing delay
- **Activation**: enter Instagram username + password in panel → ZAO-INSTA → الإعدادات

## Gotchas
- The bot needs a valid Facebook AppState (session cookies) in `ZAO-STATE.json` to connect — without it the bot logs a login failure but the web panel still runs
- API keys for optional integrations (YouTube, Wolfram Alpha, weather, SimSimi, etc.) are reported as missing on startup — this is normal and non-fatal
- Port 3001 is internal (bot API); only port 5000 is exposed externally
- `PANEL_PASSWORD` env var controls dashboard access; default is `SainxSain`
- Tier files for tiers 4 and 5 (`ZAO-STATE4.json`, `ZAO-STATE5.json`, `alt4.json`, `alt5.json`) exist as empty placeholders — upload valid cookie JSON to activate them, then set `tierLimit` in the Tier Settings tab
- `data/first-start.json` is written once on the very first run and never overwritten — it's the base for "total system uptime"
- All documentation is now merged into `ZAO.md` (6047 lines); `replit.md` is the short project overview

## Pointers
- Workflows skill: `.local/skills/workflows/SKILL.md`
- Environment secrets skill: `.local/skills/environment-secrets/SKILL.md`
