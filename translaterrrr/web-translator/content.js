// content.js — scans page text and inserts non-destructive bilingual translations

(() => {
  const MARK = "data-immt";
  const BATCH_SIZE = 40;
  const MIN_LEN = 2;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE",
    "IFRAME", "SVG", "CANVAS", "OPTION", "SELECT", "BUTTON",
  ]);

  let enabled = false;
  let observer = null;
  let pendingQueue = [];
  let flushTimer = null;
  let stats = { total: 0, done: 0, failed: 0 };
  let settings = { translateImages: false };

  // ---------- status toast ----------
  let toastEl = null;
  function showToast(msg, isError = false, autoHide = false) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "immt-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.toggle("immt-toast-error", isError);
    toastEl.style.display = "block";
    clearTimeout(toastEl._t);
    if (autoHide) toastEl._t = setTimeout(hideToast, 3500);
  }
  function hideToast() {
    if (toastEl) toastEl.style.display = "none";
  }

  // ---------- style cache (getComputedStyle is a forced-reflow hotspot) ----------
  let styleCache = new WeakMap();
  function cs(el) {
    let v = styleCache.get(el);
    if (!v) { v = getComputedStyle(el); styleCache.set(el, v); }
    return v;
  }

  // ---------- filtering ----------
  function isTranslatableTextNode(node) {
    const text = node.nodeValue.trim();
    if (text.length < MIN_LEN) return false;
    if (/^[\d\s\.\,\-\+\%\$\#\@\!\?\(\)\[\]\|\/\\:;"'`~*_=<>{}]+$/.test(text)) return false;
    // skip text that is already mostly Chinese (target language)
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk / text.length > 0.3) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.closest(`[${MARK}]`)) return false;
    if (parent.closest(".immt-inserted, .immt-toast, .immt-img-cap, .immt-overlay")) return false;

    // Short labels inside chrome/navigation are the main cause of broken layouts
    // (fixed-height rows, absolutely positioned menus). Skip them.
    if (text.length < 14 && parent.closest(
      "nav,[role='navigation'],[role='menu'],[role='menubar'],[role='tablist']," +
      "[role='toolbar'],[role='tab'],[role='menuitem'],button,[role='button']," +
      "[role='listitem'] > [role='button'],thead,th"
    )) return false;
    const st = cs(parent);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    return true;
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        isTranslatableTextNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  const BLOCK_DISPLAY = new Set([
    "block", "list-item", "table-cell", "flex", "grid", "flow-root", "inline-block",
  ]);

  function findBlockAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (BLOCK_DISPLAY.has(cs(cur).display)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  const MAX_BLOCKS_PER_PASS = 600;

  function pickBlocks(textNodes) {
    const set = new Set();
    for (const tn of textNodes) {
      const b = findBlockAncestor(tn.parentElement);
      const t = (b.innerText || "").trim();
      if (!t || t.length > 2000) continue;
      set.add(b);
    }
    let arr = [...set];
    if (arr.length > MAX_BLOCKS_PER_PASS) arr = arr.slice(0, MAX_BLOCKS_PER_PASS);

    // Keep innermost blocks only. Naive O(n^2) contains() is far too slow on big
    // pages, so mark ancestors in a single pass instead.
    const drop = new Set();
    for (const b of arr) {
      let cur = b.parentElement;
      let depth = 0;
      while (cur && depth++ < 20) {
        if (set.has(cur)) { drop.add(cur); break; }
        cur = cur.parentElement;
      }
    }
    return arr.filter((b) => !drop.has(b));
  }

  // ---------- insertion (non-destructive) ----------

  // Editable regions (Google Docs, Tencent Docs, CMS editors, comment boxes)
  // must NEVER receive injected nodes: anything we add becomes part of the
  // user's document and gets saved. For those we draw a separate overlay layer
  // positioned over the page instead.
  let overlayLayer = null;
  const overlayPairs = []; // { block, el }
  let repositionScheduled = false;

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    return !!el.closest?.(
      "[contenteditable='true'],[contenteditable='']," +
      "[role='textbox'],[role='document'],.docs-texteventtarget-iframe"
    );
  }

  function ensureOverlayLayer() {
    if (overlayLayer && overlayLayer.isConnected) return overlayLayer;
    overlayLayer = document.createElement("div");
    overlayLayer.className = "immt-overlay-layer";
    // contenteditable=false + inert-ish so editors ignore it entirely
    overlayLayer.setAttribute("contenteditable", "false");
    document.body.appendChild(overlayLayer);
    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);
    return overlayLayer;
  }

  function scheduleReposition() {
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(() => {
      repositionScheduled = false;
      repositionOverlays();
    });
  }

  function repositionOverlays() {
    if (!overlayPairs.length) return;
    const sx = window.scrollX, sy = window.scrollY;
    for (let i = overlayPairs.length - 1; i >= 0; i--) {
      const { block, el } = overlayPairs[i];
      if (!block.isConnected) {
        el.remove();
        overlayPairs.splice(i, 1);
        continue;
      }
      const r = block.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      el.style.left = r.left + sx + "px";
      el.style.top = r.bottom + sy + "px";
      el.style.width = r.width + "px";
    }
  }

  function insertOverlayTranslation(block, translated) {
    const layer = ensureOverlayLayer();
    const el = document.createElement("div");
    el.className = "immt-overlay";
    el.setAttribute("contenteditable", "false");
    el.textContent = translated;
    layer.appendChild(el);
    overlayPairs.push({ block, el });
    scheduleReposition();
  }

  function insertTranslation(block, translated) {
    if (!translated || block.getAttribute(MARK)) return false;
    const original = (block.innerText || "").trim();
    if (translated.trim() === original) {
      block.setAttribute(MARK, "same");
      return false;
    }
    block.setAttribute(MARK, "1");

    if (isEditable(block)) {
      // Never touch the document itself — float the translation above it.
      insertOverlayTranslation(block, translated);
      return true;
    }

    // Measure the nearest clipping/positioned ancestor BEFORE inserting so we
    // can tell whether our insertion overflowed it.
    const guard = findClipGuard(block);
    const before = guard ? guard.el.getBoundingClientRect().height : 0;

    const span = document.createElement("span");
    span.className = "immt-inserted";
    span.textContent = translated;
    block.appendChild(span);

    // If the container clips its content (fixed height + hidden overflow) or is
    // absolutely positioned, adding a line can overlap neighbouring UI. Detect
    // that and fall back to a floating overlay instead of wrecking the layout.
    if (guard) {
      const st = cs(guard.el);
      const clipped = guard.el.scrollHeight > guard.el.clientHeight + 2;
      const grew = Math.abs(guard.el.getBoundingClientRect().height - before) > 1;
      const risky = guard.absolute || /hidden|clip/.test(st.overflowY);
      if (risky && (clipped || (guard.absolute && grew))) {
        span.remove();
        insertOverlayTranslation(block, translated);
        return true;
      }
    }
    return true;
  }

  // Nearest ancestor that would clip or be displaced by extra content.
  function findClipGuard(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth++ < 6) {
      const st = cs(cur);
      const absolute = st.position === "absolute" || st.position === "fixed";
      const clips = /hidden|clip|auto/.test(st.overflowY) && st.overflowY !== "visible";
      const fixedH = /px$/.test(st.height) && parseFloat(st.height) > 0 &&
                     (clips || absolute);
      if (absolute || (clips && fixedH)) return { el: cur, absolute };
      cur = cur.parentElement;
    }
    return null;
  }

  // ---------- image translation ----------
  function collectImages(root) {
    const imgs = [...root.querySelectorAll("img")].filter((img) => {
      if (img.getAttribute(MARK)) return false;
      const r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 60) return false; // skip icons/avatars
      if (!img.src || img.src.startsWith("data:image/gif")) return false;
      return true;
    });
    return imgs.slice(0, 12); // cap per pass — vision calls are expensive
  }

  function translateImages(imgs) {
    imgs.forEach((img) => {
      img.setAttribute(MARK, "img-pending");
      chrome.runtime.sendMessage(
        { type: "TRANSLATE_IMAGE", src: img.src },
        (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            img.setAttribute(MARK, "img-failed");
            return;
          }
          const text = (resp.text || "").trim();
          if (!text || text === "NO_TEXT") {
            img.setAttribute(MARK, "img-none");
            return;
          }
          img.setAttribute(MARK, "img-done");
          const cap = document.createElement("div");
          cap.className = "immt-img-cap";
          cap.textContent = text;
          img.insertAdjacentElement("afterend", cap);
        }
      );
    });
  }

  // ---------- progress ----------
  function updateProgress() {
    if (stats.done + stats.failed >= stats.total) {
      const msg =
        stats.failed > 0
          ? `已翻译 ${stats.done} 段，${stats.failed} 段失败`
          : `已翻译 ${stats.done} 段 ✓ 继续滚动翻译更多`;
      showToast(msg, stats.failed > 0, true);
    } else {
      showToast(`翻译中… ${stats.done + stats.failed}/${stats.total}`);
    }
  }

  function translateBatch(blocks) {
    const texts = blocks.map((b) => (b.innerText || "").trim());
    chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts }, (resp) => {
      if (chrome.runtime.lastError) {
        stats.failed += blocks.length;
        showToast("扩展错误：" + chrome.runtime.lastError.message, true);
        return;
      }
      if (!resp?.ok) {
        stats.failed += blocks.length;
        console.error("[Web Translator]", resp?.error);
        showToast("翻译失败：" + String(resp?.error || "").slice(0, 180), true);
        return;
      }
      resp.results.forEach((t, i) => {
        if (t) {
          insertTranslation(blocks[i], t);
          stats.done++;
        } else {
          stats.failed++;
        }
      });
      updateProgress();
    });
  }

  // ---------- viewport-priority queue ----------
  // Blocks near/in the viewport get translated first; the rest are translated
  // as they scroll into view. This makes long pages feel instant.
  let queue = [];              // blocks waiting to be translated
  let io = null;               // IntersectionObserver for lazy blocks
  let dispatchTimer = null;
  let queued = new WeakSet();  // blocks already queued/observed

  function inViewport(el, margin = 300) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > -margin && r.top < vh + margin;
  }

  function ensureIO() {
    if (io) return io;
    io = new IntersectionObserver(
      (entries) => {
        let hit = false;
        for (const e of entries) {
          if (e.isIntersecting) {
            io.unobserve(e.target);
            if (!e.target.getAttribute(MARK)) {
              queue.push(e.target);
              hit = true;
            }
          }
        }
        if (hit) scheduleDispatch();
      },
      { rootMargin: "400px 0px" }
    );
    return io;
  }

  function scheduleDispatch() {
    if (dispatchTimer) return;
    dispatchTimer = setTimeout(() => {
      dispatchTimer = null;
      dispatchQueue();
    }, 120); // coalesce bursts of scroll events into one dispatch
  }

  function dispatchQueue() {
    if (!enabled || !queue.length) return;
    const batchBlocks = queue.splice(0, queue.length).filter(
      (b) => b.isConnected && !b.getAttribute(MARK)
    );
    if (!batchBlocks.length) return;

    stats.total += batchBlocks.length;
    updateProgress();
    for (let i = 0; i < batchBlocks.length; i += BATCH_SIZE) {
      translateBatch(batchBlocks.slice(i, i + BATCH_SIZE));
    }
  }

  function scanAndTranslate(root = document.body) {
    styleCache = new WeakMap(); // styles change between passes
    const blocks = pickBlocks(collectTextNodes(root)).filter(
      (b) => !b.getAttribute(MARK) && !queued.has(b)
    );

    if (settings.translateImages) {
      const imgs = collectImages(root);
      if (imgs.length) translateImages(imgs);
    }

    if (!blocks.length) {
      if (root === document.body && !stats.total) {
        showToast("本页没有找到需要翻译的内容", true, true);
      }
      return;
    }

    // Split: visible now vs. below the fold
    const visible = [];
    const observer2 = ensureIO();
    for (const b of blocks) {
      queued.add(b);
      if (inViewport(b)) {
        visible.push(b);
      } else {
        observer2.observe(b); // translate lazily when scrolled into view
      }
    }

    if (visible.length) {
      queue.push(...visible);
      dispatchQueue(); // fire immediately, no debounce, for first paint
    }
  }

  function removeAll() {
    document.querySelectorAll(".immt-inserted, .immt-img-cap, .immt-overlay").forEach((e) => e.remove());
    document.querySelectorAll(`[${MARK}]`).forEach((e) => e.removeAttribute(MARK));
  }

  function startObserving() {
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (
            n.nodeType === Node.ELEMENT_NODE &&
            !n.classList?.contains("immt-inserted") &&
            !n.classList?.contains("immt-img-cap") &&
            !n.classList?.contains("immt-toast")
          ) {
            pendingQueue.push(n);
          }
        });
      }
      if (pendingQueue.length && !flushTimer) {
        flushTimer = setTimeout(() => {
          const roots = pendingQueue.splice(0);
          flushTimer = null;
          if (enabled) {
            roots.forEach((r) => r.isConnected && scanAndTranslate(r));
            scheduleReposition();
          }
        }, 1200);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    stats = { total: 0, done: 0, failed: 0 };
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
      if (resp?.ok) settings = resp.settings;
      scanAndTranslate();
      startObserving();
    });
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    observer?.disconnect();
    observer = null;
    io?.disconnect();
    io = null;
    queue = [];
    queued = new WeakSet();
    overlayPairs.splice(0).forEach(({ el }) => el.remove());
    overlayLayer?.remove();
    overlayLayer = null;
    window.removeEventListener("scroll", scheduleReposition, true);
    window.removeEventListener("resize", scheduleReposition);
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
    removeAll();
    hideToast();
  }


  // ---------- grab text from editable regions (for the Document Translator) ----------
  function grabEditableText() {
    const roots = [...document.querySelectorAll(
      "[contenteditable='true'],[contenteditable=''],[role='textbox'],[role='document'],textarea"
    )];

    const blocks = [];
    const seen = new Set();

    const pushText = (t) => {
      const v = (t || "").replace(/\u00a0/g, " ").trim();
      if (v.length < 2) return;
      if (seen.has(v)) return;
      seen.add(v);
      blocks.push(v);
    };

    for (const root of roots) {
      if (root.tagName === "TEXTAREA") {
        root.value.split(/\n\s*\n/).forEach(pushText);
        continue;
      }
      // Walk block-level children so paragraphs stay separate
      const kids = root.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,td,pre,blockquote");
      if (kids.length) {
        kids.forEach((k) => {
          // only leaf-ish blocks, avoid duplicating nested containers
          if (k.querySelector("p,div,li,h1,h2,h3,h4,h5,h6,td,pre,blockquote")) return;
          pushText(k.innerText);
        });
      } else {
        root.innerText.split(/\n\s*\n/).forEach(pushText);
      }
    }

    // Fallback: nothing editable found — offer the main readable text instead
    if (!blocks.length) {
      const main = document.querySelector("main,article,[role='main']") || document.body;
      main.innerText.split(/\n\s*\n/).slice(0, 300).forEach(pushText);
    }
    return blocks;
  }

  chrome.runtime.onMessage.addListener((msg, s, sendResponse) => {
    if (msg.type === "TOGGLE_TRANSLATE") {
      enabled ? disable() : enable();
      sendResponse({ ok: true, enabled });
    }
    if (msg.type === "GET_STATE") sendResponse({ ok: true, enabled });
    if (msg.type === "GRAB_EDITABLE") {
      try { sendResponse({ ok: true, blocks: grabEditableText() }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    }
  });
})();
