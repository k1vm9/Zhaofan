---
name: Session guard wiring
description: Where and how sessionGuard.js is started inside ZAO.js
---

## Rule
`sessionGuard.start(api, statePath)` is called immediately after `syncAllGroups.start(_api)` in the main `onBot()` startup block (inside the post-MQTT-listen section). The state path is `path.join(process.cwd(), 'sessions', 'ZAO-STATE.json')`.

**Why:** Must start after login (needs a live api reference with `getAppState()`). Starting after syncAllGroups keeps the boot sequence linear and easy to read.

**How to apply:** If the tier is switched and a new api object is created, call `sessionGuard.updateApi(newApi)` to keep the cookie integrity monitor pointing at the correct session. Call `sessionGuard.stop()` before a tier switch to avoid double timers.

## Layers
- L1: AppState snapshot every 30 min → backups/ (via cookieSnapshot helper)
- L2: Cookie integrity check every 20 min (c_user / xs / datr must be present and non-empty)
- L3: `global._sessionGuardPreRelogin` hook — call before any re-login attempt to snapshot the current (possibly still valid) state
