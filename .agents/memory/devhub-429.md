---
name: DevHub 429 queue
description: How callAI in zao-devhub.js avoids rate-limit 429s from pollinations.ai
---

## Rule
`callAI()` chains all requests onto `_aiQueueChain` (one in-flight at a time). On HTTP 429, retries up to 3 times with `attempt * 2000 + jitter` ms backoff before rejecting.

**Why:** pollinations.ai (`text.pollinations.ai/openai`) applies per-IP rate limits. Rapid DevHub agent pipelines fire multiple requests in quick succession, exhausting the limit and returning 429 for every subsequent request until the window resets.

**How to apply:**
- `_callAIRaw()` is the raw single-attempt function; it throws an error with `e.is429 = true` on HTTP 429 so the wrapper knows to retry vs. give up.
- `callAI()` wraps `_callAIRaw` in the queue and retry loop.
- The GET fallback (`text.pollinations.ai/{prompt}?model=openai`) is inside `_callAIRaw` and also runs if POST models return empty/non-OK responses.
