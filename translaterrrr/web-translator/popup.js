const toggleBtn = document.getElementById("toggleBtn");
const engineLabel = document.getElementById("engineLabel");
const imgToggle = document.getElementById("imgToggle");
const imgNote = document.getElementById("imgNote");

function getActiveTab() {
  return new Promise((r) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t[0])));
}

function send(type, payload = {}) {
  return new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
}

function tabSend(tabId, msg) {
  return new Promise((r) =>
    chrome.tabs.sendMessage(tabId, msg, (resp) =>
      r(chrome.runtime.lastError ? null : resp)));
}

function updateBtn(enabled) {
  toggleBtn.classList.toggle("off", !enabled);
  toggleBtn.textContent = enabled
    ? "Disable translation on this page"
    : "Enable translation on this page";
}

async function init() {
  const { settings } = await send("GET_SETTINGS");

  const provider = settings.providers.find((p) => p.id === settings.engine);
  engineLabel.textContent = "Engine: " + (settings.engine === "free" ? "Free" : provider?.name || settings.engine);

  imgToggle.checked = !!settings.translateImages;

  // Warn if OCR is on but the current engine can't do vision
  const canVision = provider?.vision;
  if (settings.translateImages && !canVision) {
    imgNote.textContent = settings.engine === "free"
      ? "⚠ The free engine can't read images. Pick a vision provider in Settings."
      : `⚠ ${provider?.name || "This provider"} has no vision support. Pick one that does in Settings.`;
    imgNote.style.color = "#c5221f";
  }

  imgToggle.addEventListener("change", async () => {
    await send("SET_SETTING", { key: "translateImages", value: imgToggle.checked });
    if (imgToggle.checked && !canVision) {
      imgNote.textContent = "⚠ Current engine can't read images — choose a vision provider in Settings.";
      imgNote.style.color = "#c5221f";
    } else {
      imgNote.textContent = "Reads text inside images. Needs a vision-capable AI provider.";
      imgNote.style.color = "#80868b";
    }
  });

  const tab = await getActiveTab();
  if (!tab?.id) return;
  const state = await tabSend(tab.id, { type: "GET_STATE" });
  if (!state) {
    toggleBtn.textContent = "Not available here — reload the page";
    toggleBtn.disabled = true;
    return;
  }
  updateBtn(state.enabled);
}

toggleBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const resp = await tabSend(tab.id, { type: "TOGGLE_TRANSLATE" });
  if (resp) updateBtn(resp.enabled);
});

// ---- editable document translator ----
document.getElementById("docBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  let grabbed = null;
  if (tab?.id) {
    const resp = await tabSend(tab.id, { type: "GRAB_EDITABLE" });
    if (resp?.ok && resp.blocks?.length) grabbed = resp.blocks;
  }
  await chrome.storage.local.set({
    immt_doc_input: grabbed || [],
    immt_doc_source: tab?.title || "",
  });
  chrome.tabs.create({ url: chrome.runtime.getURL("doc.html") });
  window.close();
});

// ---- PDF ----
document.getElementById("pdfBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const url = tab?.url || "";
  const isPdf = /\.pdf(\?|#|$)/i.test(url);
  chrome.tabs.create({
    url: chrome.runtime.getURL("pdf.html") + (isPdf ? "?file=" + encodeURIComponent(url) : ""),
  });
  window.close();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
