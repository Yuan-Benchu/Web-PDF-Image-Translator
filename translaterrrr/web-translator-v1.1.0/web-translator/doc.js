const t = (key, subs) => {
  try { return chrome.i18n.getMessage(key, subs) || key; }
  catch (e) { return key; }
};

const srcEl = document.getElementById("src");
const outEl = document.getElementById("out");
const statusEl = document.getElementById("status");
const translateBtn = document.getElementById("translateBtn");

let lastTranslation = [];

function setStatus(t) { statusEl.textContent = t; }

function send(type, payload = {}) {
  return new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
}

// Split into paragraphs; blank lines separate blocks.
function splitBlocks(text) {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function translate() {
  const blocks = splitBlocks(srcEl.value);
  if (!blocks.length) { setStatus("Nothing to translate"); return; }

  translateBtn.disabled = true;
  outEl.innerHTML = "";
  const nodes = blocks.map((b) => {
    const d = document.createElement("div");
    d.className = "seg pending";
    d.textContent = t("docPending");
    outEl.appendChild(d);
    return d;
  });

  const BATCH = 20;
  let done = 0, failed = 0;
  lastTranslation = new Array(blocks.length).fill("");

  // fire batches in parallel; fill in as they arrive
  const jobs = [];
  for (let i = 0; i < blocks.length; i += BATCH) {
    const start = i;
    const slice = blocks.slice(i, i + BATCH);
    jobs.push(
      send("TRANSLATE_BATCH", { texts: slice }).then((resp) => {
        if (!resp?.ok) {
          slice.forEach((_, k) => {
            nodes[start + k].className = "seg";
            nodes[start + k].style.color = "#c5221f";
            nodes[start + k].textContent = t("docFailed") + " " + String(resp?.error || "unknown").slice(0, 120);
          });
          failed += slice.length;
          return;
        }
        resp.results.forEach((t, k) => {
          const node = nodes[start + k];
          if (t) {
            node.className = "seg tr";
            node.textContent = t;
            lastTranslation[start + k] = t;
            done++;
          } else {
            node.className = "seg";
            node.style.color = "#c5221f";
            node.textContent = t("docNotTranslated");
            failed++;
          }
        });
        setStatus(`Translating... ${done + failed}/${blocks.length}`);
      })
    );
  }

  await Promise.all(jobs);
  setStatus(failed ? `Done - ${done} blocks, ${failed} failed` : `Done - ${done} blocks \u2713`);
  translateBtn.disabled = false;
}

translateBtn.addEventListener("click", translate);

document.getElementById("copyBtn").addEventListener("click", async () => {
  const text = lastTranslation.filter(Boolean).join("\n\n");
  if (!text) { setStatus("Nothing to copy yet"); return; }
  await navigator.clipboard.writeText(text);
  setStatus("Translation copied \u2713");
});

document.getElementById("clearBtn").addEventListener("click", () => {
  srcEl.value = "";
  outEl.innerHTML = '<div class="empty">The translation appears here.<br />Your original document is never modified.</div>';
  lastTranslation = [];
  setStatus("Cleared");
});

document.getElementById("settingsBtn").addEventListener("click", () =>
  chrome.runtime.openOptionsPage());

// Ctrl/Cmd+Enter to translate
srcEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") translate();
});

// ---- import text grabbed from the page's editable areas ----
(async () => {
  try {
    const { immt_doc_input, immt_doc_source } = await chrome.storage.local.get([
      "immt_doc_input", "immt_doc_source",
    ]);
    if (Array.isArray(immt_doc_input) && immt_doc_input.length) {
      srcEl.value = immt_doc_input.join("\n\n");
      setStatus(
        `Imported ${immt_doc_input.length} blocks` +
        (immt_doc_source ? ` from "${immt_doc_source}"` : "")
      );
      await chrome.storage.local.remove(["immt_doc_input", "immt_doc_source"]);
    } else {
      setStatus("Paste your text on the left, then click Translate");
    }
  } catch (e) {
    setStatus("Paste your text on the left, then click Translate");
  }
})();
