let settings = null;
let presets = [];

const listEl = document.getElementById("providerList");
const presetSel = document.getElementById("presetSelect");

function msg(type, payload = {}) {
  return new Promise((res) => chrome.runtime.sendMessage({ type, ...payload }, res));
}

function uid() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render() {
  document.getElementById("engFree").checked = settings.engine === "free";
  document.getElementById("freeProv").classList.toggle("active", settings.engine === "free");

  listEl.innerHTML = "";
  settings.providers.forEach((p) => {
    const div = document.createElement("div");
    div.className = "prov" + (settings.engine === p.id ? " active" : "");
    div.innerHTML = `
      <div class="prov-head">
        <input type="radio" name="engine" value="${esc(p.id)}" ${settings.engine === p.id ? "checked" : ""} />
        <b>${esc(p.name)}</b>
        <span class="badge">${esc(p.format)}</span>
        ${p.vision ? '<span class="badge on">vision</span>' : ""}
        ${p.apiKey ? '<span class="badge on">key set</span>' : '<span class="badge">no key</span>'}
        <button class="sm ghost toggle">Edit</button>
        <button class="sm danger del">Delete</button>
      </div>
      <div class="prov-body">
        <div class="grid2">
          <div><label>Display name</label><input type="text" class="f-name" value="${esc(p.name)}" /></div>
          <div><label>API format</label>
            <select class="f-format">
              <option value="openai"${p.format === "openai" ? " selected" : ""}>OpenAI-compatible</option>
              <option value="anthropic"${p.format === "anthropic" ? " selected" : ""}>Anthropic</option>
              <option value="gemini"${p.format === "gemini" ? " selected" : ""}>Google Gemini</option>
            </select>
          </div>
        </div>
        <label>Base URL</label>
        <input type="text" class="f-baseUrl" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1" />
        <label>API Key</label>
        <input type="password" class="f-apiKey" value="${esc(p.apiKey)}" placeholder="sk-..." />
        <label>Model</label>
        <div class="row">
          <select class="f-modelSel" style="flex:1;"><option value="${esc(p.model)}">${esc(p.model || "(not set)")}</option></select>
          <button class="sm ghost loadModels">Load models</button>
        </div>
        <input type="text" class="f-model" value="${esc(p.model)}" placeholder="or type a model name" style="margin-top:6px;" />
        <label class="chk" style="margin-top:10px;">
          <input type="checkbox" class="f-vision" ${p.vision ? "checked" : ""} /> This model supports images (vision)
        </label>
        <div class="row" style="margin-top:12px;">
          <button class="sm testOne">Test this provider</button>
          <span class="testMsg hint"></span>
        </div>
        <pre class="testOut" style="display:none;"></pre>
      </div>`;

    div.querySelector(".toggle").addEventListener("click", () => div.classList.toggle("open"));
    div.querySelector(".del").addEventListener("click", () => {
      if (!confirm(`Delete "${p.name}"?`)) return;
      settings.providers = settings.providers.filter((x) => x.id !== p.id);
      if (settings.engine === p.id) settings.engine = "free";
      render();
    });
    div.querySelector('input[name="engine"]').addEventListener("change", () => {
      settings.engine = p.id;
      render();
    });

    const bind = (cls, key, prop = "value") => {
      const el = div.querySelector(cls);
      el.addEventListener("input", () => {
        p[key] = prop === "checked" ? el.checked : el.value;
      });
      el.addEventListener("change", () => {
        p[key] = prop === "checked" ? el.checked : el.value;
      });
    };
    // --- model dropdown ---
    const modelSel = div.querySelector(".f-modelSel");
    const modelInput = div.querySelector(".f-model");
    modelSel.addEventListener("change", () => {
      p.model = modelSel.value;
      modelInput.value = modelSel.value;
    });

    div.querySelector(".loadModels").addEventListener("click", async (ev) => {
      const btn = ev.target;
      const old = btn.textContent;
      btn.textContent = "Loading…";
      btn.disabled = true;
      const resp = await msg("FETCH_MODELS", { provider: { ...p } });
      btn.disabled = false;
      btn.textContent = old;
      if (!resp?.ok) {
        const m = div.querySelector(".testMsg");
        m.textContent = "Could not load models: " + String(resp?.error || "").slice(0, 120);
        m.style.color = "#c5221f";
        return;
      }
      modelSel.innerHTML = resp.models
        .map((id) => `<option value="${esc(id)}"${id === p.model ? " selected" : ""}>${esc(id)}</option>`)
        .join("");
      if (!resp.models.includes(p.model)) {
        p.model = resp.models[0];
        modelSel.value = p.model;
        modelInput.value = p.model;
      }
      const m = div.querySelector(".testMsg");
      m.textContent = `Loaded ${resp.models.length} models`;
      m.style.color = "#137333";
    });

    // --- per-provider test ---
    div.querySelector(".testOne").addEventListener("click", async (ev) => {
      const btn = ev.target;
      const out = div.querySelector(".testOut");
      const m = div.querySelector(".testMsg");
      btn.disabled = true;
      m.textContent = "";
      out.style.display = "block";
      out.textContent = "Testing…";
      const resp = await msg("TEST_PROVIDER", { provider: { ...p } });
      btn.disabled = false;
      if (!resp?.ok) {
        out.textContent = "❌ FAILED\n\n" + resp?.error;
        out.style.color = "#c5221f";
        return;
      }
      out.style.color = "#137333";
      out.textContent =
        `✅ WORKING  (${resp.result.ms} ms)\n\n` +
        `Input:  Hello, world.\n` +
        `Output: ${resp.result.translated || "(could not parse — raw below)"}\n` +
        (resp.result.translated ? "" : "\nRaw response:\n" + resp.result.raw);
    });

    bind(".f-name", "name");
    bind(".f-format", "format");
    bind(".f-baseUrl", "baseUrl");
    bind(".f-model", "model");
    bind(".f-apiKey", "apiKey");
    bind(".f-vision", "vision", "checked");

    listEl.appendChild(div);
  });

  document.getElementById("engFree").addEventListener("change", () => {
    settings.engine = "free";
    render();
  });
}

async function load() {
  const r = await msg("GET_SETTINGS");
  settings = r.settings;
  const pr = await msg("GET_PRESETS");
  presets = pr.presets || [];

  presetSel.innerHTML = presets
    .map((p, i) => `<option value="${i}">+ ${esc(p.name)}</option>`)
    .join("");

  document.getElementById("targetLang").value = settings.targetLang;
  document.getElementById("translateImages").checked = !!settings.translateImages;
  const c = document.getElementById("concurrency");
  c.value = settings.concurrency || 16;
  document.getElementById("concVal").textContent = c.value;

  render();
}

document.getElementById("concurrency").addEventListener("input", (e) => {
  document.getElementById("concVal").textContent = e.target.value;
});

document.getElementById("addBtn").addEventListener("click", () => {
  const preset = presets[Number(presetSel.value)];
  if (!preset) return;
  settings.providers.push({
    id: uid(),
    name: preset.name,
    format: preset.format,
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: "",
    vision: !!preset.vision,
  });
  render();
  // open the newly added one for editing
  const last = listEl.lastElementChild;
  if (last) last.classList.add("open");
});

async function save() {
  await chrome.storage.sync.set({
    engine: settings.engine,
    providers: settings.providers,
    targetLang: document.getElementById("targetLang").value,
    translateImages: document.getElementById("translateImages").checked,
    concurrency: Number(document.getElementById("concurrency").value),
  });
  const st = document.getElementById("status");
  st.textContent = "Saved ✓";
  setTimeout(() => (st.textContent = ""), 2000);
}

document.getElementById("saveBtn").addEventListener("click", save);

document.getElementById("clearCacheBtn").addEventListener("click", async () => {
  await msg("CLEAR_CACHE");
  document.getElementById("cacheMsg").textContent = "Cache cleared";
  setTimeout(() => (document.getElementById("cacheMsg").textContent = ""), 2000);
});

document.getElementById("testBtn").addEventListener("click", async () => {
  const out = document.getElementById("testResult");
  out.style.display = "block";
  out.textContent = "Saving settings and testing…";
  await save();

  const resp = await msg("TRANSLATE_BATCH", {
    texts: ["Hello, world. This is a connection test."],
  });
  if (!resp) { out.textContent = "❌ No response from extension"; return; }
  if (!resp.ok) { out.textContent = "❌ FAILED\n\n" + resp.error; return; }
  const r = resp.results?.[0];
  out.textContent = r
    ? "✅ SUCCESS\n\nInput:  Hello, world. This is a connection test.\nOutput: " + r
    : "⚠️ Request succeeded but returned nothing.";
});

load();
