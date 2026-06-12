---
name: Groups tab hang fix
description: Why the groups panel got stuck at the loading spinner and how it was fixed.
---

## Rule
The `/bot/groups` handler in ZAO.js made two sequential `getThreadList(100, null, ...)` calls with NO timeout. Each could take 10-20+ seconds when Facebook API is slow. The panel's `proxyToBot` only waits 8 seconds before returning 503 and resolving. Result: the panel got a 503, fell back to empty cache, and rendered an empty groups list (or, if the IIFE errored, stayed at the spinner).

**Why:** `getThreadList` is a Facebook Graph API call over MQTT/HTTP — slow and unreliable. Without a timeout, it blocks the HTTP response indefinitely.

**How to apply:**
- In ZAO.js `/bot/groups` handler, use `Promise.race([_api.getThreadList(...), timeoutReject(6000)])` 
- First call: 6s timeout (INBOX). Second call: 5s timeout (fallback unfiltered).
- Always check `res.destroyed || res.writableEnded` before calling `_json(res, ...)` to avoid EPIPE after proxyToBot timeout.
- The proxyToBot timeout (8s) must always be > the sum of both getThreadList timeouts (6+5=11s... but since second is only called on empty first result, effectively 6s in the happy path).
