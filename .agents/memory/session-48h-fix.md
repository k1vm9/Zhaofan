---
name: 48h session expiry fix
description: Why bots die at exactly 48 hours and the three-part fix applied.
---

## Rule
The FB session dies at ~48h because the `fb_dtsg` token (CSRF anti-forgery token embedded in cookies) expires. Without refreshing it, all API calls start returning auth errors around hour 48 and the bot disconnects.

**Why:** `keepAlive.js _scheduleDtsg()` previously defaulted to 48 hours (`|| 48`). This means the refresh was scheduled to fire at exactly the moment the token was already expiring — a race condition. Changed to 6 hours so the token is refreshed 8× before it could expire.

**How to apply:**
- `keepAlive.refreshDtsgIntervalHours` in ZAO-SETTINGS.json controls the interval (default now 6h)
- The fix is in `includes/keepAlive.js` line ~505: `Math.max(2, ... || 6)`

## FRESH account activity
FRESH accounts (615xxx UIDs) with zero passive activity look like pure bots to Facebook's ML between messages. Enabled for FRESH era in `includes/accountAgeScale.js`:
- `notificationVisit: true` — low-risk, mimics any real user checking notifications (fires every 60-180 min)
- `autoMarkRead: true` — marks incoming messages as read before reply
- `simulateTyping: true` — typing indicator before every reply
- Kept `browsing: false` and `graphqlFeed: false` — page crawling is higher risk for new accounts
