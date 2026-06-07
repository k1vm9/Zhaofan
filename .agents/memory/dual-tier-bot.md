---
name: Dual-tier bot system
description: How to run two simultaneous ZAO.js bot instances on different FB accounts
---

## Rule
Main.js manages an optional `botChild2` that runs ZAO.js locked to Tier 2 via `BOT_TIER=2` + `BOT_API_PORT=3003` env vars. The primary bot still uses Tier 1 on port 3001.

**Why:** User wants to run two accounts (tiers) simultaneously from the web panel, each serving different groups, with independent crash recovery.

**How to apply:**
- `ZAO-SETTINGS.json → tierModes: {"2": "active"}` triggers startBot2() at startup via checkSecondaryTier().
- Panel tier-settings page: mode toggles per tier (Active/Standby/Disabled); POST /api/tier-mode applies change + starts/stops botChild2 immediately.
- Emalogin reads `BOT_TIER` env and filters TIERS to only that tier (no fallback), so Tier-2 bot never steals Tier-1 cookies.
- ZAO.js reads `BOT_API_PORT` env for its internal API server (default 3001; Tier-2 uses 3003).
- `global._zaoBot2` exposes the control functions so the webpanel can access them.
