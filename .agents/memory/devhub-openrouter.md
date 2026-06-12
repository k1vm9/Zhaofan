---
name: DevHub OpenRouter
description: All AI in the bot uses OpenRouter; keys split into internal (DevHub) and external (commands) both stored in ZAO-SETTINGS.json.
---

## Rule
Two OpenRouter keys live in `ZAO-SETTINGS.json`:
- `openrouterKeyInternal` — used by `zao-devhub.js` `callAI` (DevHub agents, AI Monitor)
- `openrouterKeyExternal` — used by `ai.js` (command زاو) and `زاوفان.js` (command زاوفان)

`زاوفان.js` was fully rewritten from pollinations.ai to OpenRouter (`_loadExternalKey()` + `_ZAOFAN_MODELS` retry loop).
`ai.js` uses `_getOpenRouterKey()` (fresh read on every call) so key changes don't require a bot restart.
`zao-devhub.js` `loadOpenRouterCfg()` reads key from ZAO-SETTINGS.json; models stay in `webpanel/devhub-openrouter.json`.
`saveOpenRouterCfg()` writes key to ZAO-SETTINGS.json via `saveZaoSettings()`, models to devhub-openrouter.json.

**Why:** Single source of truth — user manages all keys in ZAO-SETTINGS.json (or via the panel). No stale key in devhub-openrouter.json overriding ZAO-SETTINGS.

**How to apply:**
- Set `openrouterKeyInternal` in ZAO-SETTINGS.json (or via DevHub → الإعدادات → OpenRouter AI card) to activate DevHub agents
- Set `openrouterKeyExternal` in ZAO-SETTINGS.json to activate زاو/زاوفان commands — no restart needed for key changes
- API routes: `GET /api/devhub/openrouter` (read), `POST /api/devhub/openrouter` (save `{apiKey, model0, model1, model2}`)
- Default models: `openai/gpt-4o-mini`, `meta-llama/llama-3.1-8b-instruct:free`, `google/gemma-2-9b-it:free`
