const DEFAULT_SETTINGS = {
  engine: "free",
  targetLang: "zh-CN",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  deepseekApiKey: "",
  deepseekModel: "deepseek-chat",
};

const geminiFields = document.getElementById("geminiFields");
const deepseekFields = document.getElementById("deepseekFields");

function toggleGeminiFields() {
  const engine = document.querySelector('input[name="engine"]:checked')?.value;
  geminiFields.style.display = engine === "gemini" ? "block" : "none";
  deepseekFields.style.display = engine === "deepseek" ? "block" : "none";
}

document.querySelectorAll('input[name="engine"]').forEach((r) =>
  r.addEventListener("change", toggleGeminiFields)
);

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  document.querySelector(
    `input[name="engine"][value="${settings.engine}"]`
  ).checked = true;
  document.getElementById("geminiApiKey").value = settings.geminiApiKey;
  document.getElementById("geminiModel").value = settings.geminiModel;
  document.getElementById("deepseekApiKey").value = settings.deepseekApiKey;
  document.getElementById("deepseekModel").value = settings.deepseekModel;
  document.getElementById("targetLang").value = settings.targetLang;
  toggleGeminiFields();
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const geminiApiKey = document.getElementById("geminiApiKey").value.trim();
  const geminiModel = document.getElementById("geminiModel").value;
  const deepseekApiKey = document.getElementById("deepseekApiKey").value.trim();
  const deepseekModel = document.getElementById("deepseekModel").value;
  const targetLang = document.getElementById("targetLang").value;

  await chrome.storage.sync.set({
    engine,
    geminiApiKey,
    geminiModel,
    deepseekApiKey,
    deepseekModel,
    targetLang,
  });

  const status = document.getElementById("status");
  status.textContent = "已保存 ✓";
  setTimeout(() => (status.textContent = ""), 2000);
});

load();
