// content.js - scans page text and inserts non-destructive bilingual translations.
// ASCII only. All user-facing strings live in _locales/*/messages.json.

(() => {
  const MARK = "data-immt";
  const BATCH_SIZE = 40;
  const MIN_LEN = 2;

  // A translation line needs real horizontal room. Anything narrower than this
  // renders one character per line (the vertical-column bug), so we refuse to
  // insert there at all.
  const MIN_INSERT_WIDTH = 80;   // px of usable content width required
  const MIN_SPAN_WIDTH = 60;     // px the inserted line must actually occupy
  const MIN_BOX = 6;             // px: anything smaller is a screen-reader box
  const OVERLAY_MIN_WIDTH = 260;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE",
    "IFRAME", "SVG", "CANVAS", "OPTION", "SELECT", "BUTTON", "TITLE",
    "HEAD", "META", "LINK", "TEMPLATE", "MAP", "AREA",
  ]);

  // Class names every major framework uses for screen-reader-only text.
  // Canvas LMS, Bootstrap, WordPress, Material, jQuery UI, Drupal, GOV.UK...
  const SR_ONLY_SELECTOR = [
    "[aria-hidden='true']", "[hidden]",
    ".screenreader-only", ".screen-reader-only", ".screen-reader-text",
    ".sr-only", ".sr-only-focusable", ".srOnly",
    ".visually-hidden", ".visuallyhidden", ".visually-hidden-focusable",
    ".hidden-visually", ".a11y-hidden", ".accessibly-hidden",
    ".assistive-text", ".ui-helper-hidden-accessible",
    ".element-invisible", ".hide-text", ".govuk-visually-hidden",
    ".MuiBox-visuallyHidden", ".offscreen", ".off-screen",
  ].join(",");

  const t = (key, subs) => {
    try { return chrome.i18n.getMessage(key, subs) || key; }
    catch (e) { return key; }
  };

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
      toastEl.setAttribute("translate", "no");
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

  // ---------- visibility ----------
  // The root cause of the broken layout report: text that is present in the DOM
  // but visually hidden (screen-reader labels, clipped 1px boxes, off-screen
  // helpers) was being translated. Its container is ~1px wide, so the inserted
  // line wrapped after every single character and produced vertical columns of
  // text scattered across the page. Nothing visually hidden is ever translated.
  function isVisuallyHidden(el) {
    const st = cs(el);
    if (st.display === "none") return true;
    if (st.visibility === "hidden" || st.visibility === "collapse") return true;
    if (parseFloat(st.opacity || "1") === 0) return true;
    if (st.contentVisibility === "hidden") return true;

    // rect(1px,1px,1px,1px) / rect(0,0,0,0) - the classic clipping trick
    if (st.clip && st.clip !== "auto" && st.clip !== "" && /rect\(/.test(st.clip)) return true;
    if (st.clipPath && st.clipPath !== "none" && /inset\(\s*(?:100%|50%)/.test(st.clipPath)) return true;

    // A 1px x 1px (or 0-sized) box can never hold a readable line of text.
    const r = el.getBoundingClientRect();
    if (r.width < MIN_BOX || r.height < MIN_BOX) return true;

    // Parked far off-screen
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    if (r.right < -2000 || r.bottom < -5000) return true;
    if (r.left > vw + 5000) return true;

    return false;
  }

  // Hidden-ness is inherited: a visible <b> inside a clipped 1px <span> is still
  // invisible, so walk a few ancestors as well.
  function isHiddenChain(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && depth++ < 8) {
      if (isVisuallyHidden(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ---------- filtering ----------
  function isTranslatableTextNode(node) {
    const text = node.nodeValue.trim();
    if (text.length < MIN_LEN) return false;
    if (/^[\d\s.,\-+%$#@!?()\[\]|/\\:;"'`~*_=<>{}]+$/.test(text)) return false;

    // skip text that is already mostly in the target script
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk / text.length > 0.3) return false;

    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.closest(`[${MARK}]`)) return false;
    if (parent.closest(".immt-inserted,.immt-toast,.immt-img-cap,.immt-overlay")) return false;

    // Never translate accessibility-only text.
    if (parent.closest(SR_ONLY_SELECTOR)) return false;

    // Short labels inside chrome/navigation break fixed-height rows.
    if (text.length < 14 && parent.closest(
      "nav,[role='navigation'],[role='menu'],[role='menubar'],[role='tablist']," +
      "[role='toolbar'],[role='tab'],[role='menuitem'],button,[role='button']," +
      "[role='listitem'] > [role='button'],thead,th"
    )) return false;

    if (isHiddenChain(parent)) return false;
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

  // Tags whose text is never painted. Inline tags such as CODE, KBD or ABBR
  // are deliberately absent: their words are part of the surrounding sentence.
  const NON_RENDERED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE",
  ]);

  // innerText still returns text from clipped screen-reader spans, which would
  // otherwise be sent to the translator and shown to the reader as noise
  // ("Due 27 Oct | -/15 pts" + "Not submitted for this assignment..."), so the
  // source string is rebuilt from visible text nodes only.
  function blockText(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const v = n.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        const pe = n.parentElement;
        if (!pe) return NodeFilter.FILTER_REJECT;
        if (NON_RENDERED_TAGS.has(pe.tagName)) return NodeFilter.FILTER_REJECT;
        if (pe.classList.contains("immt-inserted")) return NodeFilter.FILTER_REJECT;
        if (pe.closest(".immt-inserted,.immt-img-cap,.immt-overlay")) return NodeFilter.FILTER_REJECT;
        const sr = pe.closest(SR_ONLY_SELECTOR);
        if (sr && (sr === el || el.contains(sr))) return NodeFilter.FILTER_REJECT;
        if (pe !== el && el.contains(pe) && isHiddenChain(pe)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    // Raw node values are kept (only collapsed) rather than trimmed-and-joined,
    // so "<code>MutationObserver</code>'s queue" stays glued and does not become
    // "MutationObserver 's queue". A space is added only where two different
    // block-level children meet, which is where a line break really was.
    const parts = [];
    let prevBlock = null;
    let n;
    while ((n = walker.nextNode())) {
      const blk = findBlockAncestor(n.parentElement);
      if (prevBlock && blk !== prevBlock) parts.push(" ");
      parts.push(n.nodeValue.replace(/\s+/g, " "));
      prevBlock = blk;
    }
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  // Usable inner width: how much horizontal room a translation line would get.
  function usableWidth(el) {
    const r = el.getBoundingClientRect();
    const st = cs(el);
    const pl = parseFloat(st.paddingLeft) || 0;
    const pr = parseFloat(st.paddingRight) || 0;
    return r.width - pl - pr;
  }

  const MAX_BLOCKS_PER_PASS = 600;

  function pickBlocks(textNodes) {
    const set = new Set();
    for (const tn of textNodes) {
      const b = findBlockAncestor(tn.parentElement);
      const txt = blockText(b);
      if (!txt || txt.length > 2000) continue;
      if (b.closest(SR_ONLY_SELECTOR)) continue;
      if (isHiddenChain(b)) continue;
      // Too narrow to ever hold a line of translated text.
      if (usableWidth(b) < MIN_INSERT_WIDTH) continue;
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
      "[contenteditable='true'],[contenteditable=''],[role='textbox']," +
      "[role='document'],.docs-texteventtarget-iframe"
    );
  }

  function ensureOverlayLayer() {
    if (overlayLayer && overlayLayer.isConnected) return overlayLayer;
    overlayLayer = document.createElement("div");
    overlayLayer.className = "immt-overlay-layer";
    overlayLayer.setAttribute("contenteditable", "false");
    overlayLayer.setAttribute("translate", "no");
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
    const vw = window.innerWidth || document.documentElement.clientWidth;
    for (let i = overlayPairs.length - 1; i >= 0; i--) {
      const { block, el } = overlayPairs[i];
      if (!block.isConnected) {
        el.remove();
        overlayPairs.splice(i, 1);
        continue;
      }
      const r = block.getBoundingClientRect();
      if (r.width < MIN_BOX || r.height < MIN_BOX) {
        el.style.display = "none";
        continue;
      }
      // An overlay narrower than a word wraps one character per line. Give it a
      // sane minimum and keep it inside the viewport.
      const left = Math.max(0, Math.min(r.left, vw - 40));
      const width = Math.max(OVERLAY_MIN_WIDTH, Math.min(r.width, vw - left - 12));
      el.style.display = "block";
      el.style.left = left + sx + "px";
      el.style.top = r.bottom + sy + "px";
      el.style.width = width + "px";
    }
  }

  function insertOverlayTranslation(block, translated) {
    const r = block.getBoundingClientRect();
    // Never float an overlay off a box that has no real size.
    if (r.width < MIN_BOX || r.height < MIN_BOX) return false;
    const layer = ensureOverlayLayer();
    const el = document.createElement("div");
    el.className = "immt-overlay";
    el.setAttribute("contenteditable", "false");
    el.setAttribute("translate", "no");
    el.textContent = translated;
    layer.appendChild(el);
    overlayPairs.push({ block, el });
    scheduleReposition();
    return true;
  }

  // Reject a rendered line that came out as a vertical stack of characters.
  function looksVertical(span) {
    const r = span.getBoundingClientRect();
    if (r.width < MIN_SPAN_WIDTH) return true;
    // Tall and thin means the text wrapped character-by-character.
    if (r.width < 160 && r.height > r.width * 2.5) return true;
    return false;
  }

  function insertTranslation(block, translated) {
    if (!translated || block.getAttribute(MARK)) return false;
    const original = blockText(block);
    if (translated.trim() === original) {
      block.setAttribute(MARK, "same");
      return false;
    }

    // Final safety net before touching the DOM.
    if (isHiddenChain(block) || usableWidth(block) < MIN_INSERT_WIDTH) {
      block.setAttribute(MARK, "narrow");
      return false;
    }

    block.setAttribute(MARK, "1");

    if (isEditable(block)) {
      // Never touch the document itself - float the translation above it.
      return insertOverlayTranslation(block, translated);
    }

    // Measure the nearest clipping/positioned ancestor BEFORE inserting so we
    // can tell whether our insertion overflowed it.
    const guard = findClipGuard(block);
    const before = guard ? guard.el.getBoundingClientRect().height : 0;

    const span = document.createElement("span");
    span.className = "immt-inserted";
    span.setAttribute("translate", "no");
    span.textContent = translated;
    block.appendChild(span);

    // Verify what actually rendered. If it stacked vertically, back it out.
    if (looksVertical(span)) {
      span.remove();
      block.setAttribute(MARK, "narrow");
      return false;
    }

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
        if (!insertOverlayTranslation(block, translated)) {
          block.setAttribute(MARK, "narrow");
          return false;
        }
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
      const fixedH = /px$/.test(st.height) && parseFloat(st.height) > 0 && (clips || absolute);
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
    return imgs.slice(0, 12); // cap per pass - vision calls are expensive
  }

  function translateImages(imgs) {
    imgs.forEach((img) => {
      img.setAttribute(MARK, "img-pending");
      chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", src: img.src }, (resp) => {
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
        cap.setAttribute("translate", "no");
        cap.textContent = text;
        img.insertAdjacentElement("afterend", cap);
      });
    });
  }

  // ---------- progress ----------
  function updateProgress() {
    if (stats.done + stats.failed >= stats.total) {
      const msg = stats.failed > 0
        ? t("toastDonePartial", [String(stats.done), String(stats.failed)])
        : t("toastDone", [String(stats.done)]);
      showToast(msg, stats.failed > 0, true);
    } else {
      showToast(t("toastProgress", [String(stats.done + stats.failed), String(stats.total)]));
    }
  }

  function translateBatch(blocks) {
    const texts = blocks.map(blockText);
    chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts }, (resp) => {
      if (chrome.runtime.lastError) {
        stats.failed += blocks.length;
        showToast(t("toastExtError") + " " + chrome.runtime.lastError.message, true);
        return;
      }
      if (!resp?.ok) {
        stats.failed += blocks.length;
        console.error("[Web Translator]", resp?.error);
        showToast(t("toastFailed") + " " + String(resp?.error || "").slice(0, 180), true);
        return;
      }
      resp.results.forEach((tr, i) => {
        if (tr) {
          insertTranslation(blocks[i], tr);
          stats.done++;
        } else {
          stats.failed++;
        }
      });
      updateProgress();
    });
  }

  // ---------- viewport-priority queue ----------
  let queue = [];
  let io = null;
  let dispatchTimer = null;
  let queued = new WeakSet();

  function inViewport(el, margin = 300) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > -margin && r.top < vh + margin;
  }

  function ensureIO() {
    if (io) return io;
    io = new IntersectionObserver((entries) => {
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
    }, { rootMargin: "400px 0px" });
    return io;
  }

  function scheduleDispatch() {
    if (dispatchTimer) return;
    dispatchTimer = setTimeout(() => {
      dispatchTimer = null;
      dispatchQueue();
    }, 120);
  }

  function dispatchQueue() {
    if (!enabled || !queue.length) return;
    const batchBlocks = queue.splice(0, queue.length)
      .filter((b) => b.isConnected && !b.getAttribute(MARK));
    if (!batchBlocks.length) return;

    stats.total += batchBlocks.length;
    updateProgress();
    for (let i = 0; i < batchBlocks.length; i += BATCH_SIZE) {
      translateBatch(batchBlocks.slice(i, i + BATCH_SIZE));
    }
  }

  function scanAndTranslate(root = document.body) {
    styleCache = new WeakMap(); // styles change between passes
    const blocks = pickBlocks(collectTextNodes(root))
      .filter((b) => !b.getAttribute(MARK) && !queued.has(b));

    if (settings.translateImages) {
      const imgs = collectImages(root);
      if (imgs.length) translateImages(imgs);
    }

    if (!blocks.length) {
      if (root === document.body && !stats.total) {
        showToast(t("toastNothing"), true, true);
      }
      return;
    }

    const visible = [];
    const lazy = ensureIO();
    for (const b of blocks) {
      queued.add(b);
      if (inViewport(b)) visible.push(b);
      else lazy.observe(b);
    }

    if (visible.length) {
      queue.push(...visible);
      dispatchQueue(); // fire immediately, no debounce, for first paint
    }
  }

  // ---------- sweep: catch content rendered later by SPA frameworks ----------
  let sweepTimer = null;
  let sweepsLeft = 0;
  function startSweep() {
    stopSweep();
    sweepsLeft = 20;
    sweepTimer = setInterval(() => {
      if (!enabled || sweepsLeft-- <= 0) { stopSweep(); return; }
      scanAndTranslate();
      scheduleReposition();
    }, 2500);
  }
  function stopSweep() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function removeAll() {
    document.querySelectorAll(".immt-inserted,.immt-img-cap,.immt-overlay")
      .forEach((e) => e.remove());
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
            !n.classList?.contains("immt-overlay") &&
            !n.classList?.contains("immt-overlay-layer") &&
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
      startSweep();
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
    stopSweep();
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

    const pushText = (txt) => {
      const v = (txt || "").replace(/\u00a0/g, " ").trim();
      if (v.length < 2 || seen.has(v)) return;
      seen.add(v);
      blocks.push(v);
    };

    for (const root of roots) {
      if (root.tagName === "TEXTAREA") {
        root.value.split(/\n\s*\n/).forEach(pushText);
        continue;
      }
      const kids = root.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,td,pre,blockquote");
      if (kids.length) {
        kids.forEach((k) => {
          if (k.querySelector("p,div,li,h1,h2,h3,h4,h5,h6,td,pre,blockquote")) return;
          pushText(k.innerText);
        });
      } else {
        root.innerText.split(/\n\s*\n/).forEach(pushText);
      }
    }

    if (!blocks.length) {
      const main = document.querySelector("main,article,[role='main']") || document.body;
      main.innerText.split(/\n\s*\n/).slice(0, 300).forEach(pushText);
    }
    return blocks;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
