---
name: npm install deadlock guard
description: Why and how the execSync npm install calls in ZAO.js have a timeout
---

## Rule
Both `execSync` npm install calls in ZAO.js (one in the command loader, one in the event loader) must include `timeout: 90_000` (90 seconds). Without it, a slow or unreachable npm registry hangs the entire Node process at bot startup — the watchdog in Main.js will eventually kill it, but only after the full watchdog timeout, losing the whole session.

**Why:** execSync with no timeout on a network call is a boot-deadlock risk. 90s is generous enough for slow connections but short enough to fail-fast and let the watchdog retry.

**How to apply:** The pattern is:
```js
try {
  execSync('npm ...', { ..., timeout: 90_000 });
} catch (installErr) {
  throw new Error(`npm install "${pkgName}" failed or timed out: ...`);
}
```
The thrown error is caught by the outer cmd/evt loader try-catch and logged as a load failure for that command only — the bot continues loading other commands.
