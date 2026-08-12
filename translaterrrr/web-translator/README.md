# Web Translator

Chrome MV3 extension: bilingual webpage translation, PDF translation, editable-document
translation, and image OCR — with a free engine by default and support for any AI provider.

## Install (Developer Mode)

1. `chrome://extensions/` → turn on **Developer mode**
2. **Load unpacked** → select this folder
3. Open a page → click the extension icon → **Enable translation on this page** (or Alt+T)

After reloading the extension, refresh any tabs that were already open.

## Translation engines

Anything works — the extension speaks three API dialects:

- **OpenAI-compatible** — OpenAI, DeepSeek, Grok, Kimi, GLM, Qwen, SiliconFlow, OpenRouter, Groq, Mistral, Ollama, or any custom endpoint
- **Anthropic** — Claude
- **Gemini** — Google

Settings → pick a preset (or "Custom") → fill in Base URL and API key → **Load models**
to pull the real model list from the provider and pick one from the dropdown (you can still
type a name manually) → **Test this provider** to confirm it works and see the latency.
Add as many providers as you want and switch between them with the radio buttons.
The **Free engine** (public Google Translate endpoint) needs no key and is the default.

## PDF translation

Popup → **Translate a PDF**. Three view modes:

- **Side by side** — translation page on the left, original page on the right (default)
- **Bilingual** — translation under each block on the original page
- **Overlay** — translation covers the original text

Rendered locally with PDF.js; only extracted text goes to your engine.

## Editable documents

Popup → **Translate editable document**. Text is pulled out of the editor (Google Docs,
Tencent Docs, textareas, CMS fields) and opened in a separate side-by-side page, so the
original file is never touched or modified. You can also just paste text in.

## Image OCR

Toggle **Image OCR translation** right in the popup. Requires a vision-capable provider
(Gemini, GPT-4o, Claude, Qwen-VL, GLM-4V…); the popup warns you if the current engine
can't read images.

## Speed

- Duplicate strings translated once (real pages repeat ~55% of their text)
- Persistent cache — revisiting a page costs zero requests
- Free engine batches ~28 texts per request; up to 16 requests in parallel (tunable in Settings)
- Visible text first, the rest as you scroll
- Automatic backoff and retry on rate limits

A 400-block page went from ~134 network round-trips (v0.1) to 1.

## Files

```
manifest.json   MV3 config
background.js   provider layer, cache, OCR
content.js      page scanning + injection
popup.*         toolbar UI, image toggle
options.*       provider manager
pdf.*           PDF viewer + translation
doc.*           editable-document translator
pdfjs/          bundled PDF.js (Apache 2.0)
```
