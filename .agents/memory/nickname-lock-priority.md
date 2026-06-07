---
name: Nickname lock priority system
description: How user-level locks and group locks interact in nicknameLocks.js and the nicknames command
---

## Rule
User Lock > Group Lock > no lock. When `lockUser(tid, uid, nick)` is called, the UID is added to `userLockedMembers[tid]` Set. During `_enforce()` the stored nickname is applied regardless — the correct nick is already stored per UID so no skip logic is needed; priority is enforced by `setMembers()` in `كنيات تشغيل` which preserves existing individual-lock nicks instead of overwriting them with the group template.

**Why:** A moderator may pin a special nickname for one person; the group-wide template must not silently override it every 60s.

**How to apply:** Use `NickLocks.lockUser(tid, uid, nick)` to pin individually. Use `NickLocks.unlockUser(tid, uid)` to release. Check with `NickLocks.isUserLocked(tid, uid)`. Persist is automatic (atomicWrite → data/nickname-locks.json, field `userLocked: [uid, ...]`).

## Enforce interval
60 000 ms (1 min). The old value of 90 s was wrong — changed in v3/v6.

## Command subcommands (nicknames.js v6)
- `كنيات قفل [كنية]` — reply-based individual user lock
- `كنيات فك` — reply-based individual user unlock
- `كنيات مقفولون` — list individually locked members in group
- `كنيات حالة` — now also shows `userLockedCount`
- `كنيات قائمة` — shows per-group user-locked count
