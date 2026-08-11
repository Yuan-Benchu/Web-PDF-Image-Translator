// background.js — MV3 service worker
// 负责实际发起翻译请求（content script 通过 message 调用这里）

const DEFAULT_SETTINGS = {
  engine: "free", // "free" | "gemini" | "deepseek"
  targetLang: "zh-CN",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  deepseekApiKey: "",
  deepseekModel: "deepseek-chat",
  enabledGlobally: true,
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ---------- 免费翻译引擎（Google 公开接口，无需 Key）----------
async function translateFree(texts, targetLang) {
  // 逐条请求（该接口不支持真正的批量，但可以并发）
  const results = await Promise.all(
    texts.map(async (text) => {
      if (!text || !text.trim()) return "";
      const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
        encodeURIComponent(targetLang) +
        "&dt=t&q=" +
        encodeURIComponent(text);
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        // data[0] 是分段翻译结果数组
        return data[0].map((seg) => seg[0]).join("");
      } catch (e) {
        console.error("[免费翻译失败]", text, e);
        return null; // 标记失败，调用方决定是否重试/跳过
      }
    })
  );
  return results;
}

// ---------- Gemini 翻译引擎（用户自备 API Key）----------
async function translateGemini(texts, targetLang, apiKey, model) {
  if (!apiKey) throw new Error("未配置 Gemini API Key");

  // 把多条文本打包成一次请求，用分隔符隔开，减少请求数
  const SEP = "\n<<<SEP>>>\n";
  const joined = texts.map((t, i) => `[${i}] ${t}`).join(SEP);

  const prompt = `你是专业翻译引擎。请将下面用 "${SEP.trim()}" 分隔的多段文本翻译成${targetLang}。
严格规则：
1. 保持原有的 [数字] 编号前缀不变。
2. 每段翻译结果之间仍用 "${SEP.trim()}" 分隔，且顺序不变、条数不变。
3. 只输出翻译结果，不要解释、不要添加多余内容。
4. 如果原文本身就是目标语言或是无意义符号，原样返回。

原文：
${joined}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API 错误 ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const outText =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

  const parts = outText.split(SEP.trim()).map((s) => s.trim());
  // 按 [数字] 前缀对齐，防止模型漏行导致错位
  const resultMap = {};
  for (const part of parts) {
    const m = part.match(/^\[(\d+)\]\s*([\s\S]*)$/);
    if (m) resultMap[Number(m[1])] = m[2];
  }
  return texts.map((_, i) => resultMap[i] ?? null);
}

// ---------- DeepSeek 翻译引擎（OpenAI 兼容接口，用户自备 API Key）----------
async function translateDeepSeek(texts, targetLang, apiKey, model) {
  if (!apiKey) throw new Error("未配置 DeepSeek API Key");

  const SEP = "\n<<<SEP>>>\n";
  const joined = texts.map((t, i) => `[${i}] ${t}`).join(SEP);

  const prompt = `你是专业翻译引擎。请将下面用 "${SEP.trim()}" 分隔的多段文本翻译成${targetLang}。
严格规则：
1. 保持原有的 [数字] 编号前缀不变。
2. 每段翻译结果之间仍用 "${SEP.trim()}" 分隔，且顺序不变、条数不变。
3. 只输出翻译结果，不要解释、不要添加多余内容。
4. 如果原文本身就是目标语言或是无意义符号，原样返回。

原文：
${joined}`;

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek API 错误 ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const outText = data?.choices?.[0]?.message?.content || "";

  const parts = outText.split(SEP.trim()).map((s) => s.trim());
  const resultMap = {};
  for (const part of parts) {
    const m = part.match(/^\[(\d+)\]\s*([\s\S]*)$/);
    if (m) resultMap[Number(m[1])] = m[2];
  }
  return texts.map((_, i) => resultMap[i] ?? null);
}

// ---------- 统一入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TRANSLATE_BATCH") {
    (async () => {
      try {
        const settings = await getSettings();
        let results;
        if (settings.engine === "gemini") {
          results = await translateGemini(
            msg.texts,
            settings.targetLang,
            settings.geminiApiKey,
            settings.geminiModel
          );
        } else if (settings.engine === "deepseek") {
          results = await translateDeepSeek(
            msg.texts,
            settings.targetLang,
            settings.deepseekApiKey,
            settings.deepseekModel
          );
        } else {
          results = await translateFree(msg.texts, settings.targetLang);
        }
        sendResponse({ ok: true, results });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // 保持消息通道异步开放
  }

  if (msg.type === "GET_SETTINGS") {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }
});

// 快捷键：切换当前页翻译
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-translate") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_TRANSLATE" });
      }
    });
  }
});
