const toggleBtn = document.getElementById("toggleBtn");
const engineLabel = document.getElementById("engineLabel");
const openOptions = document.getElementById("openOptions");

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      resolve(tabs[0])
    );
  });
}

async function refreshState() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "GET_STATE" }, (resp) => {
    if (chrome.runtime.lastError) {
      toggleBtn.textContent = "当前页面不支持（如浏览器内置页）";
      toggleBtn.disabled = true;
      return;
    }
    updateBtn(resp?.enabled);
  });
}

function updateBtn(enabled) {
  toggleBtn.classList.toggle("off", !enabled);
  toggleBtn.textContent = enabled ? "关闭本页翻译" : "在此页面开启翻译";
}

toggleBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATE" }, (resp) => {
    if (chrome.runtime.lastError) return;
    updateBtn(resp?.enabled);
  });
});

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

const ENGINE_NAMES = { free: "免费", gemini: "Gemini", deepseek: "DeepSeek" };
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
  if (resp?.ok) {
    engineLabel.textContent = "引擎：" + (ENGINE_NAMES[resp.settings.engine] || resp.settings.engine);
  }
});

refreshState();
