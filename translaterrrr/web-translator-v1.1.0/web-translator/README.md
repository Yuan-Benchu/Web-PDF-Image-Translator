# Web Translator v1.1.0

Bilingual side-by-side webpage translation for Chrome (Manifest V3).

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `web-translator` folder
4. Pin the extension, then press **Alt+T** on any page (or use the popup)

## What changed in 1.1.0

### Fixed: translations rendered as vertical columns of single characters

Root cause: pages hide text from sighted users with `clip: rect(1px,1px,1px,1px)`
plus a 1x1 pixel box (Canvas LMS `.screenreader-only`, Bootstrap
`.visually-hidden`, WordPress `.screen-reader-text`, and about twenty other
framework conventions). The old visibility test only looked at `display:none`,
`visibility:hidden` and `opacity:0`, so those elements were treated as visible.
A translation inserted into a 1px-wide container wraps after every character.

Four independent layers now prevent it:

1. `isVisuallyHidden()` also tests `clip`, `clip-path`, box size, off-screen
   placement and `content-visibility`.
2. A 20+ entry selector list catches framework screen-reader class names.
3. Blocks with less than 80px of usable width are never given a translation.
4. After insertion the rendered geometry is measured; anything that came out
   tall-and-thin is removed again. This is a measurement, not a heuristic.

### Fixed: hidden accessibility text leaked into the translation

`innerText` returns clipped screen-reader text, so a due date read as
"Due 27 Oct | -/15 pts Not submitted for this assignment. Possible 15 points."
Source strings are now rebuilt from visible text nodes only, while inline
elements such as `<code>` stay part of the sentence and original spacing is
preserved.

### Fixed: free engine sent one request per paragraph

Verified against the live endpoint: passing several `&q=` parameters translates
only the first one and returns nulls for the rest. Many lines inside a single
`q` do work and come back line-aligned. Batching now uses that, with a
per-segment fallback whenever the line count does not match.

Measured: 19 segments in one request, 552ms.

### No CJK characters in program code

All six `.js` files are pure ASCII. Every user-facing string lives in
`_locales/en/messages.json` and `_locales/zh_CN/messages.json`, which Chrome
always parses as UTF-8. The only other non-ASCII text is the native language
names in the `options.html` language picker, in a file that declares
`<meta charset="UTF-8">`.

## Layout

```
manifest.json          MV3 manifest, default_locale = zh_CN
background.js          service worker: engines, cache, vision OCR
content.js             page scanning, visibility filtering, insertion
content.css            translation line styling
popup.html/js          toolbar popup
options.html/js        provider settings
doc.html/js            editable-document translator
pdf.html/js            PDF translator
_locales/{en,zh_CN}/   all user-facing strings
```

## Engines

Free Google endpoint (no key needed), or any OpenAI-compatible, Anthropic or
Gemini API: DeepSeek, OpenAI, Claude, Gemini, Grok, Kimi, GLM, Qwen,
SiliconFlow, OpenRouter, Groq, Mistral, Ollama.
