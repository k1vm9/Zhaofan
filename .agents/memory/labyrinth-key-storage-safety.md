---
name: Labyrinth key-storage safety
description: The startup safety requirement for persisting the E2EE identity key store.
---

Do not initialize the Labyrinth E2EE key store unless its key-store PIN is configured. The key store persists identity keys unencrypted when no PIN is provided.

**Why:** Starting E2EE without a PIN can silently leave long-lived private keys in plaintext on disk.

**How to apply:** When wiring Labyrinth into a runtime, require both the explicit enabled flag and a non-empty key-store PIN before initialization; keep the feature disabled otherwise.
