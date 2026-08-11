// content.js — 扫描页面文本节点，插入双语对照翻译

(() => {
  const MARK_ATTR = "data-immt-translated";
  const BATCH_SIZE = 25;
  const MIN_LEN = 2; // 短于此长度的文本不翻译（如单个符号、数字）
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE",
    "IFRAME", "SVG", "CANVAS",
  ]);

  let enabled = false;
  let observer = null;
  let pendingQueue = [];
  let flushTimer = null;

  // ---------- 判断一个文本节点是否值得翻译 ----------
  function isTranslatableTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue.trim();
    if (text.length < MIN_LEN) return false;
    if (/^[\d\s\.\,\-\+\%\$\#\@\!\?\(\)\[\]]+$/.test(text)) return false; // 纯符号/数字
    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.closest("[contenteditable='true']")) return false;
    if (parent.closest(`[${MARK_ATTR}]`)) return false; // 已翻译过的块不再重复处理
    if (parent.closest(".immt-inserted")) return false; // 跳过我们自己插入的译文
    return true;
  }

  // ---------- 收集页面上待翻译的文本节点（按块级祖先分组，避免打散内联结构）----------
  function collectCandidates(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        isTranslatableTextNode(n)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // 找到一个合适插入译文的块级容器（避免插到 <span> 中间破坏布局）
  function findBlockAncestor(el) {
    const blockDisplay = new Set([
      "block", "list-item", "table-cell", "flex", "grid",
    ]);
    let cur = el;
    while (cur && cur !== document.body) {
      const disp = getComputedStyle(cur).display;
      if (blockDisplay.has(disp)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  // ---------- 分组：每个块级祖先对应一份待翻译文本 ----------
  function groupByBlock(textNodes) {
    const map = new Map(); // blockEl -> 拼接文本 & 归属信息（简化版：整块取 innerText）
    for (const tn of textNodes) {
      const block = findBlockAncestor(tn.parentElement);
      if (!map.has(block)) map.set(block, true);
    }
    return Array.from(map.keys());
  }

  // ---------- 插入译文 ----------
  function insertTranslation(block, translatedText) {
    if (!translatedText || block.getAttribute(MARK_ATTR)) return;
    block.setAttribute(MARK_ATTR, "1");
    const div = document.createElement("div");
    div.className = "immt-inserted";
    div.textContent = translatedText;
    block.insertAdjacentElement("afterend", div);
  }

  // ---------- 请求后台翻译 ----------
  function translateBatch(blocks) {
    const texts = blocks.map((b) => b.innerText.trim());
    chrome.runtime.sendMessage(
      { type: "TRANSLATE_BATCH", texts },
      (resp) => {
        if (chrome.runtime.lastError) return;
        if (!resp?.ok) {
          console.warn("[沉浸式翻译] 翻译失败:", resp?.error);
          return;
        }
        resp.results.forEach((translated, i) => {
          if (translated) insertTranslation(blocks[i], translated);
        });
      }
    );
  }

  // ---------- 扫描 + 分批翻译 ----------
  function scanAndTranslate(root = document.body) {
    const textNodes = collectCandidates(root);
    const blocks = groupByBlock(textNodes).filter(
      (b) => !b.getAttribute(MARK_ATTR)
    );
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      translateBatch(blocks.slice(i, i + BATCH_SIZE));
    }
  }

  // ---------- 移除所有已插入的译文，恢复原页面 ----------
  function removeAllTranslations() {
    document.querySelectorAll(".immt-inserted").forEach((el) => el.remove());
    document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) =>
      el.removeAttribute(MARK_ATTR)
    );
  }

  // ---------- 动态内容监听（节流）----------
  function startObserving() {
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingQueue.push(node);
          }
        });
      }
      if (pendingQueue.length && !flushTimer) {
        flushTimer = setTimeout(() => {
          const roots = pendingQueue.splice(0, pendingQueue.length);
          flushTimer = null;
          roots.forEach((r) => r.isConnected && scanAndTranslate(r));
        }, 800);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    observer?.disconnect();
    observer = null;
  }

  // ---------- 开关 ----------
  function enableTranslation() {
    if (enabled) return;
    enabled = true;
    scanAndTranslate();
    startObserving();
  }

  function disableTranslation() {
    if (!enabled) return;
    enabled = false;
    stopObserving();
    removeAllTranslations();
  }

  function toggleTranslation() {
    enabled ? disableTranslation() : enableTranslation();
  }

  // ---------- 消息监听（来自 popup / 快捷键）----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "TOGGLE_TRANSLATE") {
      toggleTranslation();
      sendResponse({ ok: true, enabled });
    }
    if (msg.type === "GET_STATE") {
      sendResponse({ ok: true, enabled });
    }
  });

  // ---------- 初始化：根据全局设置决定是否自动翻译当前站点 ----------
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
    // 简化版默认不自动翻译，等待用户通过 popup 手动开启
  });
})();
