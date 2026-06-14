---
name: DevHub OpenRouter
description: DevHub AI now uses OpenRouter (replaced pollinations.ai); config file, API routes, and UI card.
---

## Rule
DevHub AI (zao-devhub.js `callAI`) uses OpenRouter at `https://openrouter.ai/api/v1/chat/completions`. Config lives in `webpanel/devhub-openrouter.json` (`apiKey` + `models` array of up to 3). The old `_callAIRaw` + pollinations logic is gone.

**Why:** pollinations.ai returns HTML on errors (JSON parse fails) and has unreliable uptime. OpenRouter provides a standard OpenAI-compatible API with many free models and a masked key the user can manage.

**How to apply:**
- `callAI(_model, messages)` — `_model` param is ignored, uses `loadOpenRouterCfg().models` in order, falls back on error
- API routes: `GET /api/devhub/openrouter` (read, masked key), `POST /api/devhub/openrouter` (save `{apiKey, model0, model1, model2}`)
- Settings UI in `settingsTab()` — loads `loadOpenRouterCfg()` directly (both are module-level)
- Default models: `openai/gpt-4o-mini`, `meta-llama/llama-3.1-8b-instruct:free`, `google/gemma-2-9b-it:free`
- User must enter API key at DevHub → الإعدادات → OpenRouter AI card to activate
