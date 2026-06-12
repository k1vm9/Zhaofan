---
name: Command loader run key requirement
description: ZAO.js command loader only accepts run: not onStart: — mirai-style commands silently fail to load every boot
---

# Command Loader Requires `run:` Not `onStart:`

## The rule
ZAO.js command loader (line ~438) checks `if (!cmd['config'] || !cmd['run'])` and throws. Commands that export `onStart` instead of `run` silently fail to load on every boot with the error `"mirai - Not found key language: Error in cmd format"`.

**Why:** The ZAO framework uses `run` as the universal command entry point. Some commands were written using the "mirai bot" style (`onStart`) which is a different framework convention.

**How to apply:** Any new or imported command file must export `run:` as the function key. `handleEvent:` is also supported alongside `run:` for passive event listeners. If a command fails to load with "Error in cmd format", check for `onStart` and rename it to `run`.

## Affected files (fixed in v1.8 session)
- `SCRIPTS/ZAO-CMDS/badwords.js` — renamed `onStart` → `run`
- `SCRIPTS/ZAO-CMDS/uptime/up.js` — renamed `onStart` → `run`
