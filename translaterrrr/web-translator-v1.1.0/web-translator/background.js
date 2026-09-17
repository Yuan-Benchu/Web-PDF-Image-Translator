// background.js - MV3 service worker
// Provider-agnostic translation engine + cache + vision OCR.
// ASCII only. All user-facing strings live in _locales/*/messages.json.

const t = (key, subs) => {
  try { return chrome.i18n.getMessage(key, subs) || key; }
  catch (e) { return key; }
};

// ---------------- Provider presets ----------------
// format: "openai" (chat/completions), "anthropic" (messages), "gemini" (generateContent)
const BUILTIN_PROVIDERS = [
  { id: "gemini", name: "Google Gemini", format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.0-flash", apiKey: "", vision: true },
  { id: "deepseek", name: "DeepSeek", format: "openai",
    baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "", vision: false },
];

const PROVIDER_PRESETS = [
  { name: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", vision: true },
  { name: "Anthropic Claude", format: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", vision: true },
  { name: "Google Gemini", format: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash", vision: true },
  { name: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", vision: false },
  { name: "xAI Grok", format: "openai", baseUrl: "https://api.x.ai/v1", model: "grok-2-latest", vision: true },
  { name: "Moonshot Kimi", format: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", vision: false },
  { name: "Zhipu GLM", format: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", vision: true },
  { name: "Alibaba Qwen", format: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-turbo", vision: true },
  { name: "SiliconFlow", format: "openai", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", vision: false },
  { name: "OpenRouter", format: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.0-flash-001", vision: true },
  { name: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", vision: false },
  { name: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", vision: false },
  { name: "Ollama (local)", format: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", vision: false },
  { name: "Custom (OpenAI-compatible)", format: "openai", baseUrl: "", model: "", vision: false },
];

const DEFAULT_SETTINGS = {
  engine: "free",           // "free" or a provider id
  targetLang: "zh-CN",
  providers: BUILTIN_PROVIDERS,
  translateImages: false,
  concurrency: 16,
};

const LANG_NAMES = {
  "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", en: "English",
  ja: "Japanese", ko: "Korean", fr: "French", de: "German", es: "Spanish",
  ru: "Russian", pt: "Portuguese", it: "Italian", ar: "Arabic", th: "Thai", vi: "Vietnamese",
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const s = { ...DEFAULT_SETTINGS, ...stored };
  if (!Array.isArray(s.providers) || !s.providers.length) s.providers = BUILTIN_PROVIDERS;
  return s;
}

function getProvider(settings) {
  return settings.providers.find((p) => p.id === settings.engine) || null;
}

// ---------------- concurrency limiter ----------------
let active = 0;
let maxConcurrent = 16;
const waiting = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < maxConcurrent) { active++; resolve(); }
    else waiting.push(resolve);
  });
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) { active++; next(); }
}

// ---------------- free engine ----------------
// Verified against the live endpoint: passing several "&q=" parameters only
// ever translates the FIRST one (the remaining top-level slots come back null).
// The endpoint DOES accept many lines inside a single "q", and returns them
// line-aligned, so batching is done by joining with newlines. Measured: 10
// segments in ~0.4s in one request instead of 10 requests.
const FREE_MAX_LINES = 24;
const FREE_MAX_URL = 6000;
const FREE_ENDPOINT =
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t";

// Newlines are the batch delimiter, so they must not survive inside a segment.
function flattenForFree(text) {
  const v = String(text == null ? "" : text).replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  return v || "-";
}

function buildFreeUrl(joined, targetLang) {
  return FREE_ENDPOINT + "&tl=" + encodeURIComponent(targetLang) +
         "&q=" + encodeURIComponent(joined);
}

// data[0] is an array of [translatedSegment, sourceSegment, ...] pieces that
// have to be concatenated before the newlines can be split back apart.
function decodeFree(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const parts = data[0].filter((seg) => Array.isArray(seg) && typeof seg[0] === "string");
  if (!parts.length) return null;
  return parts.map((seg) => seg[0]).join("");
}

async function fetchWithRetry(url, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status === 429 || resp.status === 503) {
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i) + Math.random() * 300));
        lastErr = new Error("HTTP " + resp.status);
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr || new Error("request failed");
}

async function freeSingle(text, targetLang) {
  const resp = await fetchWithRetry(buildFreeUrl(flattenForFree(text), targetLang));
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return decodeFree(await resp.json());
}

async function freeOneByOne(chunk, targetLang) {
  const out = [];
  for (const item of chunk) {
    try { out.push(await freeSingle(item, targetLang)); }
    catch (e) { out.push(null); }
  }
  return out;
}

async function freeChunk(chunk, targetLang) {
  if (chunk.length === 1) return [await freeSingle(chunk[0], targetLang)];

  const joined = chunk.map(flattenForFree).join("\n");
  const resp = await fetchWithRetry(buildFreeUrl(joined, targetLang));
  if (!resp.ok) throw new Error("HTTP " + resp.status);

  const decoded = decodeFree(await resp.json());
  if (decoded == null) return freeOneByOne(chunk, targetLang);

  const lines = decoded.split("\n").map((l) => l.trim());
  // Line-for-line alignment is the whole contract. If it does not hold, the
  // mapping would be silently wrong, so retranslate the chunk one at a time.
  if (lines.length !== chunk.length) return freeOneByOne(chunk, targetLang);
  return lines;
}

async function translateFree(texts, targetLang) {
  const chunks = [];
  let cur = [], curLen = 0;
  for (const item of texts) {
    const encLen = encodeURIComponent(flattenForFree(item)).length + 3;
    if (cur.length >= FREE_MAX_LINES || (cur.length && curLen + encLen > FREE_MAX_URL)) {
      chunks.push(cur); cur = []; curLen = 0;
    }
    cur.push(item); curLen += encLen;
  }
  if (cur.length) chunks.push(cur);

  const settled = await Promise.all(chunks.map(async (chunk) => {
    await acquire();
    try { return await freeChunk(chunk, targetLang); }
    catch (e) { console.error("[free chunk]", e); return chunk.map(() => null); }
    finally { release(); }
  }));
  return settled.flat();
}

// ---------------- LLM prompt ----------------
const SEP = "<<<SEP>>>";

function buildPrompt(texts, targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  const joined = texts.map((t, i) => `[${i}] ${t}`).join("\n" + SEP + "\n");
  return `You are a professional translation engine. Translate each segment below into ${langName}.
Rules:
1. Keep the [number] prefix on every segment exactly as-is.
2. Keep segments separated by "${SEP}", same order, same count.
3. Output ONLY translations. No explanations, no extra text.
4. If a segment is already in the target language or is meaningless symbols, return it unchanged.
5. Keep it natural, not word-for-word.

Source:
${joined}`;
}

function parseNumbered(outText, texts) {
  const parts = outText.split(SEP).map((s) => s.trim());
  const map = {};
  for (const p of parts) {
    const m = p.match(/^\[(\d+)\]\s*([\s\S]*)$/);
    if (m) map[Number(m[1])] = m[2].trim();
  }
  return texts.map((_, i) => map[i] ?? null);
}

async function errDetail(resp) {
  const t = await resp.text();
  try {
    const j = JSON.parse(t);
    return j?.error?.message || j?.message || t;
  } catch (e) { return t; }
}

// ---------------- unified provider call ----------------
// content: either a plain string prompt, or {text, imageBase64, imageMime}
async function callProvider(provider, content, opts = {}) {
  const { baseUrl, apiKey, model, format } = provider;
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl || "")) {
    throw new Error(provider.name + ": " + t("errNoApiKey"));
  }
  const isImage = typeof content === "object";
  const text = isImage ? content.text : content;

  let url, headers, body;

  if (format === "gemini") {
    const base = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    headers = { "Content-Type": "application/json" };
    const parts = isImage
      ? [{ inline_data: { mime_type: content.imageMime, data: content.imageBase64 } }, { text }]
      : [{ text }];
    body = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } });

  } else if (format === "anthropic") {
    const base = (baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
    url = `${base}/messages`;
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    const msgContent = isImage
      ? [{ type: "image", source: { type: "base64", media_type: content.imageMime, data: content.imageBase64 } },
         { type: "text", text }]
      : text;
    body = JSON.stringify({
      model, max_tokens: opts.maxTokens || 8000, temperature: 0.2,
      messages: [{ role: "user", content: msgContent }],
    });

  } else { // openai-compatible
    const base = (baseUrl || "").replace(/\/$/, "");
    if (!base) throw new Error(provider.name + ": " + t("errNoBaseUrl"));
    url = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    const msgContent = isImage
      ? [{ type: "image_url", image_url: { url: `data:${content.imageMime};base64,${content.imageBase64}` } },
         { type: "text", text }]
      : text;
    body = JSON.stringify({
      model, temperature: 0.2, stream: false,
      messages: [{ role: "user", content: msgContent }],
    });
  }

  const resp = await fetchWithRetry(url, { method: "POST", headers, body });
  if (!resp.ok) {
    let d = await errDetail(resp);
    if (resp.status === 401 || resp.status === 403) d = t("errBadKey") + " " + d;
    if (resp.status === 402) d = t("errNoCredit") + " " + d;
    if (resp.status === 404) d = t("errBadEndpoint") + " " + d;
    throw new Error(`${provider.name} ${resp.status}: ${String(d).slice(0, 300)}`);
  }
  const data = await resp.json();

  if (format === "gemini") {
    return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  }
  if (format === "anthropic") {
    return data?.content?.map((c) => c.text || "").join("") || "";
  }
  return data?.choices?.[0]?.message?.content || "";
}

async function translateWithProvider(texts, targetLang, provider) {
  await acquire();
  try {
    const out = await callProvider(provider, buildPrompt(texts, targetLang));
    return parseNumbered(out, texts);
  } finally { release(); }
}

const LLM_BATCH = 30;
async function runInBatches(texts, size, fn) {
  const chunks = [];
  for (let i = 0; i < texts.length; i += size) chunks.push(texts.slice(i, i + size));
  const out = await Promise.all(chunks.map((c) => fn(c)));
  return out.flat();
}

// ---------------- cache (memory + persistent) ----------------
const memCache = new Map();
const MEM_CACHE_MAX = 8000;
let cacheDirty = false;
let cacheLoaded = false;
let flushTimer = null;

const cacheKey = (t, l, e) => l + "\u0000" + e + "\u0000" + t;

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const { immt_cache } = await chrome.storage.local.get("immt_cache");
    if (immt_cache && typeof immt_cache === "object") {
      for (const [k, v] of Object.entries(immt_cache)) memCache.set(k, v);
    }
  } catch (e) { console.warn("[cache load]", e); }
}

function scheduleFlush() {
  if (!cacheDirty || flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    cacheDirty = false;
    try {
      const obj = {};
      let i = 0;
      const start = Math.max(0, memCache.size - MEM_CACHE_MAX);
      for (const [k, v] of memCache) {
        if (i++ < start) continue;
        obj[k] = v;
      }
      await chrome.storage.local.set({ immt_cache: obj });
    } catch (e) { console.warn("[cache flush]", e); }
  }, 4000);
}

function cacheGet(text, lang, engine) {
  const k = cacheKey(text, lang, engine);
  if (!memCache.has(k)) return undefined;
  const v = memCache.get(k);
  memCache.delete(k); memCache.set(k, v);
  return v;
}

function cacheSet(text, lang, engine, val) {
  if (val == null) return;
  memCache.set(cacheKey(text, lang, engine), val);
  cacheDirty = true;
  if (memCache.size > MEM_CACHE_MAX) {
    const drop = Math.ceil(MEM_CACHE_MAX * 0.1);
    let i = 0;
    for (const key of memCache.keys()) { memCache.delete(key); if (++i >= drop) break; }
  }
  scheduleFlush();
}

async function translateWithCache(texts, settings) {
  await loadCache();
  maxConcurrent = settings.concurrency || 16;
  const lang = settings.targetLang;
  const engine = settings.engine;

  const results = new Array(texts.length).fill(null);
  const miss = new Map();

  texts.forEach((t, i) => {
    const tr = (t || "").trim();
    if (!tr) { results[i] = ""; return; }
    const hit = cacheGet(tr, lang, engine);
    if (hit !== undefined) { results[i] = hit; return; }
    if (!miss.has(tr)) miss.set(tr, []);
    miss.get(tr).push(i);
  });

  const uniq = [...miss.keys()];
  if (!uniq.length) return results;

  let translated;
  if (engine === "free") {
    translated = await translateFree(uniq, lang);
  } else {
    const provider = getProvider(settings);
    if (!provider) throw new Error(t("errProviderMissing"));
    translated = await runInBatches(uniq, LLM_BATCH, (b) =>
      translateWithProvider(b, lang, provider));
  }

  uniq.forEach((t, i) => {
    const val = translated[i];
    cacheSet(t, lang, engine, val);
    for (const idx of miss.get(t)) results[idx] = val;
  });
  return results;
}

// ---------------- image OCR + translation ----------------
async function imageToBase64(src) {
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(t("errImgDownload") + " HTTP " + resp.status);
  const blob = await resp.blob();
  if (blob.size > 5 * 1024 * 1024) throw new Error(t("errImgTooBig"));
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  let mime = blob.type || "image/png";
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(mime)) mime = "image/png";
  return { base64: btoa(binary), mime };
}

async function translateImage(src, settings) {
  const provider = getProvider(settings);
  if (!provider) throw new Error(t("errNeedVisionProvider"));
  if (!provider.vision) {
    throw new Error(provider.name + ": " + t("errNoVision"));
  }
  await acquire();
  try {
    const { base64, mime } = await imageToBase64(src);
    const langName = LANG_NAMES[settings.targetLang] || settings.targetLang;
    const out = await callProvider(provider, {
      text: `Extract all readable text from this image and translate it into ${langName}.
Output ONLY the translated text, preserving line breaks where sensible.
If the image has no meaningful text, output exactly: NO_TEXT`,
      imageBase64: base64,
      imageMime: mime,
    }, { maxTokens: 2000 });
    return out;
  } finally { release(); }
}


// ---------------- fetch available models from a provider ----------------
async function fetchModels(provider) {
  const { baseUrl, apiKey, format } = provider;
  const base = (baseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error(t("errNoBaseUrl"));

  let url, headers = {};
  if (format === "gemini") {
    url = `${base}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  } else if (format === "anthropic") {
    url = `${base}/models?limit=100`;
    headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  } else {
    url = `${base}/models`;
    headers = { Authorization: `Bearer ${apiKey}` };
  }

  const resp = await fetchWithRetry(url, { method: "GET", headers }, 2);
  if (!resp.ok) {
    throw new Error(`${resp.status}: ${String(await errDetail(resp)).slice(0, 200)}`);
  }
  const data = await resp.json();

  let ids = [];
  if (format === "gemini") {
    ids = (data.models || [])
      .filter((m) => !m.supportedGenerationMethods ||
                     m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, ""));
  } else {
    ids = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  }

  ids = [...new Set(ids)].filter(Boolean).sort();
  if (!ids.length) throw new Error(t("errEmptyModelList"));
  return ids;
}

// Test one provider config directly (not the currently saved engine).
async function testProvider(provider) {
  const started = Date.now();
  const out = await callProvider(provider, buildPrompt(["Hello, world."], "zh-CN"), { maxTokens: 200 });
  const parsed = parseNumbered(out, ["Hello, world."]);
  return {
    ms: Date.now() - started,
    raw: String(out).slice(0, 400),
    translated: parsed[0],
  };
}

// ---------------- message router ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TRANSLATE_BATCH") {
    (async () => {
      try {
        const s = await getSettings();
        sendResponse({ ok: true, results: await translateWithCache(msg.texts, s) });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === "TRANSLATE_IMAGE") {
    (async () => {
      try {
        const s = await getSettings();
        sendResponse({ ok: true, text: await translateImage(msg.src, s) });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }

  if (msg.type === "SET_SETTING") {
    chrome.storage.sync.set({ [msg.key]: msg.value }).then(() =>
      sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "GET_PRESETS") {
    sendResponse({ ok: true, presets: PROVIDER_PRESETS });
    return false;
  }

  if (msg.type === "FETCH_MODELS") {
    (async () => {
      try { sendResponse({ ok: true, models: await fetchModels(msg.provider) }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === "TEST_PROVIDER") {
    (async () => {
      try { sendResponse({ ok: true, result: await testProvider(msg.provider) }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === "CLEAR_CACHE") {
    memCache.clear();
    chrome.storage.local.remove("immt_cache").then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-translate") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_TRANSLATE" });
    });
  }
});
