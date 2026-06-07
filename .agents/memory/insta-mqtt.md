---
name: INSTA MQTT hybrid
description: INSTA.js uses instagram_mqtt realtime with polling fallback
---

## Rule
After login, call `startRealtime()` instead of `startPollLoop()`. The MQTT `receive` event debounces to trigger `pollInbox()` within 600ms. A 60s background safety poll always runs. On MQTT disconnect, falls back to original `pollIntervalMs` (4000ms).

**Why:** instagram_mqtt (`withRealtime`) is already installed. MQTT reduces latency from 4s → ~1s and cuts API calls significantly. Pure polling wastes Instagram API quota and may trigger rate limits.

**How to apply:**
- Wrap every `ig = new IgApiClient()` with `ig = withRealtime(new IgApiClient())` — there are 3 places in `doLogin()`.
- `_mqttConnected`, `_mqttPollScheduled`, `_fallbackPollTimer` are the runtime state vars.
- SIGTERM/SIGINT handlers must call `ig.realtime.disconnect()` and clear `_fallbackPollTimer`.
- Status API (`/insta/status`) exposes `mqttConnected` so panel can show MQTT vs poll mode.
