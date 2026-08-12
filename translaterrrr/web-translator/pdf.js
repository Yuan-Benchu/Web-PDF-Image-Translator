// pdf.js — PDF viewer with side-by-side / bilingual / overlay translation
let pdfjsLib = null, pdfDoc = null;
let pageInfos = [];
const SCALE = 1.4;

const statusEl = document.getElementById("status");
const pagesEl = document.getElementById("pages");
const dropEl = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const translateBtn = document.getElementById("translateBtn");
const viewMode = document.getElementById("viewMode");

const setStatus = (m) => (statusEl.textContent = m);
const send = (type, payload = {}) =>
  new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, (resp) =>
    r(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : resp)));

async function initPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(chrome.runtime.getURL("pdfjs/pdf.min.mjs"));
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdfjs/pdf.worker.min.mjs");
  return pdfjsLib;
}

// ---- group PDF text fragments into paragraphs ----
function groupIntoLines(textContent, viewport) {
  const items = textContent.items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]) || 10;
      return { text: it.str, x: tx[4], y: tx[5] - h, w: it.width * viewport.scale, h };
    });
  if (!items.length) return [];
  items.sort((a, b) => a.y - b.y || a.x - b.x);

  const lines = [];
  let cur = null;
  for (const it of items) {
    if (cur && Math.abs(it.y - cur.y) <= Math.max(3, cur.h * 0.6)) {
      const gap = it.x - (cur.x + cur.w);
      cur.text += (gap > cur.h * 0.25 ? " " : "") + it.text;
      cur.w = it.x + it.w - cur.x;
      cur.h = Math.max(cur.h, it.h);
    } else {
      if (cur) lines.push(cur);
      cur = { ...it };
    }
  }
  if (cur) lines.push(cur);

  const paras = [];
  let p = null;
  for (const ln of lines) {
    const txt = ln.text.trim();
    if (!txt) continue;
    if (p && ln.y - (p.y + p.h) < p.h * 0.9 && Math.abs(ln.x - p.x) < p.h * 2 &&
        !/[.!?:;。！？]$/.test(p.text.trim())) {
      p.text += " " + txt;
      p.h = ln.y + ln.h - p.y;
      p.w = Math.max(p.w, ln.w);
    } else {
      if (p) paras.push(p);
      p = { ...ln, text: txt };
    }
  }
  if (p) paras.push(p);
  return paras.filter((l) => l.text.trim().length > 1);
}

// ---- build the DOM for one page according to view mode ----
function buildPageDom(n, viewport, mode) {
  const wrap = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const tlayer = document.createElement("div");
  tlayer.className = "tlayer";

  if (mode === "side") {
    wrap.className = "spread";

    // LEFT: translation sheet (blank white page + translated text)
    const left = document.createElement("div");
    left.className = "side transsheet";
    left.style.width = viewport.width + "px";
    left.style.height = viewport.height + "px";
    const ll = document.createElement("div");
    ll.className = "side-label";
    ll.textContent = "译文 TRANSLATION";
    left.appendChild(ll);
    left.appendChild(tlayer);

    // RIGHT: original rendered page
    const right = document.createElement("div");
    right.className = "side";
    right.style.width = viewport.width + "px";
    right.style.height = viewport.height + "px";
    const rl = document.createElement("div");
    rl.className = "side-label";
    rl.textContent = "原文 ORIGINAL";
    right.appendChild(rl);
    right.appendChild(canvas);

    wrap.appendChild(left);
    wrap.appendChild(right);
  } else {
    wrap.className = "single side";
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";
    wrap.style.position = "relative";
    wrap.appendChild(canvas);
    wrap.appendChild(tlayer);
  }

  return { wrap, canvas, tlayer };
}

async function loadPdf(data) {
  await initPdfJs();
  setStatus("Loading…");
  pagesEl.innerHTML = "";
  pageInfos = [];
  dropEl.style.display = "none";

  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  const mode = viewMode.value;

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale: SCALE });
    const { wrap, canvas, tlayer } = buildPageDom(n, viewport, mode);

    pagesEl.appendChild(wrap);
    const num = document.createElement("div");
    num.className = "pagenum";
    num.textContent = `Page ${n} / ${pdfDoc.numPages}`;
    pagesEl.appendChild(num);

    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const lines = groupIntoLines(await page.getTextContent(), viewport);
    // vertical budget for each block = distance to the next block below it
    lines.forEach((l, i) => {
      const next = lines[i + 1];
      l.nextY = next ? next.y : viewport.height - 4;
    });
    pageInfos.push({ pageNum: n, tlayer, lines, viewport, page });

    setStatus(`Rendering ${n}/${pdfDoc.numPages}…`);
  }

  const total = pageInfos.reduce((s, p) => s + p.lines.length, 0);
  setStatus(`${pdfDoc.numPages} pages, ${total} text blocks — ready`);
  translateBtn.disabled = false;
  translateBtn.classList.remove("ghost");
}

// ---- render one translated block ----
// Translated text is usually a different length than the original (Chinese is
// much denser than English), so we auto-fit each block to its box instead of
// trusting the original font size.
function fitBlock(el, boxW, boxH, startFs) {
  el.style.fontSize = startFs + "px";
  // Fast path: already fits.
  if (el.scrollHeight <= boxH && el.scrollWidth <= boxW + 1) return;

  let lo = 6, hi = startFs, best = 6;
  for (let i = 0; i < 7; i++) {          // binary search, ~7 steps is plenty
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + "px";
    if (el.scrollHeight <= boxH && el.scrollWidth <= boxW + 1) {
      best = mid; lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.3) break;
  }
  el.style.fontSize = best.toFixed(1) + "px";
}

function placeBlock(pageInfo, line, text, mode) {
  const el = document.createElement("div");
  el.className = "tblock";
  el.textContent = text;

  const vw = pageInfo.viewport.width;
  const boxW = Math.max(Math.min(line.w, vw - line.x - 4), 60);
  el.style.left = line.x + "px";
  el.style.width = boxW + "px";

  if (mode === "bilingual") {
    el.style.top = line.y + line.h + 1 + "px";
  } else {
    el.style.top = line.y + "px";
  }
  pageInfo.tlayer.appendChild(el);

  // Available vertical room: up to the next block, so translations never
  // stack on top of each other.
  const nextY = line.nextY != null ? line.nextY : pageInfo.viewport.height;
  const room = mode === "bilingual"
    ? Math.max(nextY - (line.y + line.h) - 2, line.h)
    : Math.max(nextY - line.y - 2, line.h);

  const startFs = Math.max(8, Math.min(line.h * 0.86, 22));
  fitBlock(el, boxW, room, startFs);
}

async function translateAll() {
  if (!pageInfos.length) return;
  translateBtn.disabled = true;
  const mode = viewMode.value;
  pageInfos.forEach((p) => (p.tlayer.innerHTML = ""));

  const all = [];
  pageInfos.forEach((p) => p.lines.forEach((l) => all.push({ page: p, line: l })));

  const BATCH = 25;
  let done = 0, failed = 0;

  // Fire all batches in parallel — the background worker throttles them.
  const jobs = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    jobs.push(
      send("TRANSLATE_BATCH", { texts: slice.map((s) => s.line.text) }).then((resp) => {
        if (!resp?.ok) { failed += slice.length; return resp?.error; }
        resp.results.forEach((t, k) => {
          if (!t) { failed++; return; }
          const { page, line } = slice[k];
          if (mode !== "side" && t.trim() === line.text.trim()) { done++; return; }
          placeBlock(page, line, t, mode);
          done++;
        });
        setStatus(`Translating… ${done + failed}/${all.length}`);
      })
    );
  }

  const errors = (await Promise.all(jobs)).filter(Boolean);
  if (errors.length && !done) {
    setStatus("Failed: " + String(errors[0]).slice(0, 160));
  } else {
    setStatus(failed ? `Done — ${done} blocks, ${failed} failed` : `Done — ${done} blocks ✓`);
  }
  translateBtn.disabled = false;
}

// ---- re-layout when view mode changes ----
viewMode.addEventListener("change", async () => {
  if (!pdfDoc) return;
  setStatus("Switching view…");
  const data = lastData;
  if (data) await loadPdf(data.slice(0));
});

let lastData = null;
function handleFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    setStatus("Not a PDF file"); return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    lastData = new Uint8Array(reader.result);
    loadPdf(lastData.slice(0)).catch((e) => {
      console.error(e); setStatus("Failed to load: " + e.message);
    });
  };
  reader.readAsArrayBuffer(file);
}

document.getElementById("pickBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
translateBtn.addEventListener("click", translateAll);
document.getElementById("settingsBtn").addEventListener("click", () =>
  chrome.runtime.openOptionsPage());

["dragenter", "dragover"].forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.add("hover"); }));
["dragleave", "drop"].forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.remove("hover"); }));
document.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

(async () => {
  const src = new URLSearchParams(location.search).get("file");
  if (!src) return;
  try {
    setStatus("Fetching PDF…");
    const resp = await fetch(src);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    lastData = new Uint8Array(await resp.arrayBuffer());
    await loadPdf(lastData.slice(0));
  } catch (e) {
    setStatus("Could not fetch that PDF — open it manually. (" + e.message + ")");
  }
})();
