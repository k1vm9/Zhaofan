# Djamel-Fca Messenger bot — Replit runtime

## Run & Operate
- **Start**: `npm start` (runs `index.js`, which supervises the Djamel-Fca runtime and the independent Instagram process)
- **Runtime**: Node.js 22
- **Dashboard / preview**: port 5000
- **Dashboard password**: set the `DASHBOARD_PASSWORD` Replit Secret
- **Djamel-Fca config**: private `config.json`; use `config.example.json` as the safe template
- **Djamel-Fca Facebook session**: private `sessions/DJAMEL-FCA-STATE.json`
- **Original ZAO settings/session**: `ZAO-SETTINGS.json` and `sessions/ZAO-STATE.json` remain untouched for rollback

## Stack
- **Runtime**: Djamel-Fca Architecte core with the Djamel cookie/session, message, media, polling, dashboard, and protection layers
- **FCA transport**: the existing `@neoaz07/nkxfca` package, wrapped by `Djamel-fca`; the archive's `@dongdev/fca-unofficial` release was blocked by Replit's package security policy
- **Dashboard**: Express + Socket.IO with password login and a Replit-compatible UI
- **Database**: Djamel core JSON store under ignored `database/data/`
- **Instagram**: the existing `INSTA.js` process continues independently on port 3002

## Where things live
- `index.js` — process supervisor for Djamel-Fca and the independent Instagram bot
- `core-runtime-source.js` — active Facebook login, command, listener, dashboard, and protection runtime
- `Djamel-fca/` — Djamel cookie parsing, FCA helpers, and media API
- `src/` — Djamel engine, compatible command bridge, dashboard, media, database, and protection code
- `SCRIPTS/ZAO-CMDS/` — existing ZAO commands; compatible modules load through the adapter
- `Main.js`, `ZAO.js`, `ZAO-ENGINE/`, `DB/`, and `webpanel/` — retained old ZAO implementation; not launched by `npm start`
- `sessions/ZAO-STATE.json` — original tracked session; not modified by the active runtime
- `sessions/DJAMEL-FCA-STATE.json` — private copied session used by Djamel-Fca

## Architecture decisions
- **Active architecture**: Djamel-Fca is the Facebook runtime; the original ZAO runtime remains in the workspace but is not started by the Replit workflow.
- **Compatibility**: command permissions, aliases, replies, reactions, supported group events, and basic user/thread data are adapted. Modules that require ZAO-only engine state are skipped rather than silently run against missing services.
- **Session safety**: the active runtime writes only its private session copy. The original tracked ZAO session is retained unchanged.
- **Dashboard authentication**: dashboard API calls require an expiring in-memory token obtained with `DASHBOARD_PASSWORD`.

## Product
- Messenger bot using Djamel-Fca login/session and media helpers
- Dashboard sections for overview, commands, admins, session, settings, and logs
- Compatible ZAO commands are loaded from the existing command folder
- Instagram bot remains a separate child process
- ZAO-only tier switching, Labyrinth E2EE, and old ZAO dashboard routes are not part of the active Djamel runtime

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
- The dashboard serves on port 5000 for the Replit preview. The original Railway split-port settings are not used by this workflow.
- Facebook login requires a valid AppState in `sessions/DJAMEL-FCA-STATE.json`; the dashboard remains available when Facebook is offline.
- `DASHBOARD_PASSWORD` must be saved in Replit Secrets before dashboard sign-in will work. The sample `CHANGE_ME` value is rejected.
- The archive's `@dongdev/fca-unofficial` package is not installed because Replit's security policy blocked it; the compatible Djamel wrapper uses the existing FCA library instead.
- Some ZAO commands that depend on ZAO-only engines or globals are intentionally skipped by the command adapter.

## Pointers
- Workflows skill: `.local/skills/workflows/SKILL.md`
- Environment secrets skill: `.local/skills/environment-secrets/SKILL.md`
