"use strict";

/*
 * adapter/onboarding.js —— 首次启动引导
 *
 * 三条硬性要求（用户反馈）：
 *   1. 第一遍必须走完，不给「跳过」；
 *   2. 第二步**直接就是填 API Key 的地方**，不用自己去找设置；
 *   3. 配色自己带，不继承页面变量 —— 之前继承导致黑字压在深色背景上完全看不见。
 *
 * 触发条件：本机设置里 tutorial_seen 不是 true 才弹。已经配好 Key 的老用户不会被打扰
 * （配好 Key 即视为走过流程）。想再看一次：设置 → 关于 →「再看一次教程」。
 */

(function (global) {
  const STYLE_ID = "roleworld-onboarding-style";
  const SEEN_KEY = "tutorial_seen";

  const STEPS = ["welcome", "key", "ready"];

  let overlay = null;
  let index = 0;
  let busy = false;

  /* ------------------------------------------------------------------ *
   * 样式：全部写死，明暗两套，不依赖页面变量
   * ------------------------------------------------------------------ */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.rw-ob{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(6,8,12,.78);
  --rw-bg:#171b23; --rw-line:#2f3743; --rw-fg:#e9edf3; --rw-muted:#9aa5b4; --rw-accent:#6f8cff; --rw-on-accent:#0a0d13;}
html[data-theme="light"] .rw-ob{
  --rw-bg:#ffffff; --rw-line:#dfe4ec; --rw-fg:#1a1f28; --rw-muted:#5b6675; --rw-accent:#3a5bf0; --rw-on-accent:#ffffff;}
.rw-ob *{box-sizing:border-box;}
.rw-ob-card{width:min(520px,100%);max-height:min(84vh,660px);overflow:auto;border-radius:16px;
  border:1px solid var(--rw-line);background:var(--rw-bg);color:var(--rw-fg);
  box-shadow:0 24px 64px rgba(0,0,0,.5);padding:26px 26px 20px;
  font:15px/1.75 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;}
.rw-ob-card h2{margin:0 0 14px;font-size:19px;color:var(--rw-fg);}
.rw-ob-card p{margin:0 0 10px;color:var(--rw-muted);}
.rw-ob-card p strong{color:var(--rw-fg);font-weight:600;}
.rw-ob-card code{background:rgba(127,127,127,.18);border-radius:5px;padding:1px 5px;font-size:13px;color:var(--rw-fg);}
.rw-ob-dots{display:flex;gap:6px;margin:18px 0 16px;}
.rw-ob-dots i{width:7px;height:7px;border-radius:50%;background:var(--rw-fg);opacity:.22;}
.rw-ob-dots i.is-on{opacity:.85;}
.rw-ob-actions{display:flex;gap:10px;align-items:center;}
.rw-ob-actions .rw-ob-grow{flex:1;}
.rw-ob button{border-radius:10px;padding:8px 16px;font:inherit;font-size:14px;cursor:pointer;
  border:1px solid var(--rw-line);background:transparent;color:var(--rw-fg);}
.rw-ob button.rw-ob-primary{background:var(--rw-accent);border-color:transparent;color:var(--rw-on-accent);font-weight:600;}
.rw-ob button:disabled{opacity:.45;cursor:default;}
.rw-ob-field{display:flex;gap:8px;margin:14px 0 4px;}
.rw-ob-field select,.rw-ob-field input{flex:1;min-width:0;padding:9px 11px;border-radius:10px;
  border:1px solid var(--rw-line);background:transparent;color:var(--rw-fg);font:inherit;font-size:14px;}
.rw-ob-field select{flex:0 0 150px;}
.rw-ob-field input::placeholder{color:var(--rw-muted);}
.rw-ob-status{margin:6px 0 0;font-size:13px;color:var(--rw-muted);min-height:20px;}
.rw-ob-status.is-ok{color:#3ecf8e;}
.rw-ob-status.is-bad{color:#ff7a7a;}
.rw-ob-hint{font-size:13px;color:var(--rw-muted);margin:10px 0 0;}
`;
    document.head.appendChild(style);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function format(line) {
    return escapeHtml(line)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
  }

  /* ------------------------------------------------------------------ *
   * 内容
   * ------------------------------------------------------------------ */

  function stepHtml(step) {
    if (step === "welcome") {
      return [
        "<h2>欢迎使用角色世界</h2>",
        "<p>这是一个**完全本地**的角色对话应用：没有服务器、没有账号、没有遥测。</p>",
        "<p>角色卡、对话记录、记忆书、API Key 全部只存在这台设备上，谁也不会替你看到它们。</p>",
        "<p>代价只有一条：没人替你备份，换电脑前记得自己导出。</p>",
        "<p>下一步需要填一个模型接口的 API Key，请先准备好。</p>",
      ].join("");
    }
    if (step === "key") {
      return [
        "<h2>填入你的 API Key</h2>",
        "<p>请求从这台设备**直接**发给你选的模型服务，不经过任何中转。Key 只保存在本机。</p>",
        '<div class="rw-ob-field"><select data-ob="provider" aria-label="服务商">',
        '<option value="deepseek">DeepSeek 官方</option>',
        '<option value="openai">OpenAI</option>',
        '<option value="openrouter">OpenRouter</option>',
        '<option value="siliconflow">硅基流动</option>',
        '<option value="custom">自定义 / 本地模型</option>',
        "</select>",
        '<input type="password" data-ob="key" placeholder="粘贴 API Key（sk-…）" autocomplete="off" spellcheck="false" maxlength="200" aria-label="API Key">',
        "</div>",
        '<div class="rw-ob-field"><input type="text" data-ob="endpoint" placeholder="接口地址（留空用服务商默认）" spellcheck="false" autocomplete="off" aria-label="接口地址"></div>',
        '<p class="rw-ob-status" data-ob="status"></p>',
        '<p class="rw-ob-hint">用本地模型（llama.cpp / Ollama / LM Studio）就把服务商选成"自定义"，地址填 <code>/v1/chat/completions</code>，Key 留空即可。</p>',
      ].join("");
    }
    return [
      "<h2>准备就绪</h2>",
      "<p>已经装好 **6 个角色**和 4 本记忆书，直接开始聊就行。</p>",
      "<p>每个角色有**自己的记忆**，跨对话保留；模型还会自己记要点（可在设置里关掉）。</p>",
      "<p>桌面版数据在 `%APPDATA%\\app.roleworld.desktop\\data\\`，都是普通文件；换电脑用「设置 → 关于 → 导出存档」。</p>",
      "<p>想换模型、调界面大小、管记忆书，都在**设置**里。</p>",
    ].join("");
  }

  function actionsHtml(step) {
    const last = index === STEPS.length - 1;
    const dots = STEPS.map((_, i) => `<i class="${i === index ? "is-on" : ""}"></i>`).join("");
    return `
      <div class="rw-ob-dots" aria-hidden="true">${dots}</div>
      <div class="rw-ob-actions">
        <button type="button" data-ob="prev" ${index === 0 ? "disabled" : ""}>上一步</button>
        <span class="rw-ob-grow"></span>
        ${step === "key" ? '<button type="button" data-ob="save">保存并测试</button>' : ""}
        <button type="button" class="rw-ob-primary" data-ob="next">${last ? "开始使用" : "下一步"}</button>
      </div>`;
  }

  /* ------------------------------------------------------------------ *
   * 渲染与交互
   * ------------------------------------------------------------------ */

  function render() {
    const step = STEPS[index];
    overlay.innerHTML = `<div class="rw-ob-card" role="dialog" aria-modal="true">${stepHtml(step)}${actionsHtml(step)}</div>`;
    overlay.querySelector('[data-ob="prev"]').addEventListener("click", () => {
      if (index > 0) { index -= 1; render(); }
    });
    overlay.querySelector('[data-ob="next"]').addEventListener("click", onNext);
    const saveButton = overlay.querySelector('[data-ob="save"]');
    if (saveButton) saveButton.addEventListener("click", onSaveKey);
    const provider = overlay.querySelector('[data-ob="provider"]');
    if (provider) provider.addEventListener("change", () => { syncKeyFields(); setStatus(""); });
    syncKeyFields();
    if (step === "key") prefillKeyStep();
  }

  // 把已有的服务商 / 接口地址带出来，别让「保存并测试」把用户先前的配置冲掉。
  async function prefillKeyStep() {
    try {
      const settings = await global.RoleWorld.getLocalSettings();
      const provider = overlay && overlay.querySelector('[data-ob="provider"]');
      const endpoint = overlay && overlay.querySelector('[data-ob="endpoint"]');
      if (provider && settings.provider) provider.value = settings.provider;
      if (endpoint && settings.endpoint) endpoint.value = settings.endpoint;
      syncKeyFields();
    } catch (_) { /* 用默认值即可 */ }
  }

  function syncKeyFields() {
    const provider = overlay.querySelector('[data-ob="provider"]');
    const keyInput = overlay.querySelector('[data-ob="key"]');
    const endpoint = overlay.querySelector('[data-ob="endpoint"]');
    if (!provider || !keyInput || !endpoint) return;
    const isCustom = provider.value === "custom";
    keyInput.disabled = isCustom;
    keyInput.placeholder = isCustom ? "本地模型不需要 Key" : "粘贴 API Key（sk-…）";
    endpoint.placeholder = isCustom
      ? "http://127.0.0.1:8080/v1/chat/completions"
      : "接口地址（留空用服务商默认）";
  }

  function setStatus(text, kind) {
    const node = overlay && overlay.querySelector('[data-ob="status"]');
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("is-ok", kind === "ok");
    node.classList.toggle("is-bad", kind === "bad");
  }

  async function onSaveKey() {
    if (busy) return;
    const adapter = global.RoleWorld;
    const provider = overlay.querySelector('[data-ob="provider"]').value;
    const keyInput = overlay.querySelector('[data-ob="key"]');
    const endpoint = overlay.querySelector('[data-ob="endpoint"]').value.trim();
    const key = keyInput ? keyInput.value.trim() : "";
    busy = true;
    try {
      await adapter.saveLocalSettings({ provider, endpoint });
      if (provider !== "custom" && key) {
        await adapter.secrets.set(global.RoleWorldModel.secretKeyFor({ provider }), key);
        keyInput.value = "";
      }
      setStatus("正在测试连接…", null);
      const settings = await adapter.getLocalSettings();
      const result = await global.RoleWorldModel.complete(
        { messages: [{ role: "user", content: "回复两个字：可用" }], max_tokens: 16 },
        {
          settings: { provider, endpoint: global.RoleWorldModel.endpointFor(settings), model: settings.model },
          apiKey: (await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider })) || {}).value || "",
        }
      );
      setStatus("连接正常：" + String(result.content || "").slice(0, 40), "ok");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatus("连接失败：" + message.slice(0, 160), "bad");
    } finally {
      busy = false;
      notifySettings();
    }
  }

  function notifySettings() {
    global.dispatchEvent(new global.CustomEvent("roleworld:settings-changed", { detail: {} }));
  }

  async function onNext() {
    const step = STEPS[index];
    if (step === "key" && !(await keyReady())) return;
    if (index < STEPS.length - 1) {
      index += 1;
      render();
      return;
    }
    await finish();
  }

  // 第二步的放行条件：本地端点，或者已经存好了对应服务商的 Key。
  async function keyReady() {
    const adapter = global.RoleWorld;
    const provider = overlay.querySelector('[data-ob="provider"]').value;
    if (provider === "custom") return true;
    const saved = await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider }));
    if (saved && saved.value) return true;
    setStatus("请先粘贴 API Key 并点「保存并测试」，或者把服务商换成「自定义 / 本地模型」。", "bad");
    return false;
  }

  async function finish() {
    close();
    try {
      await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true });
    } catch (_) { /* 存不下也不能卡住用户 */ }
    notifySettings();
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeydown, true);
  }

  // Esc 不退出一一必须走完；只拦掉，避免误关。
  function onKeydown(event) {
    if (!overlay) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
  }

  function show() {
    if (overlay) return;
    injectStyle();
    index = 0;
    overlay = document.createElement("div");
    overlay.className = "rw-ob";
    (document.getElementById("appShell") || document.body).appendChild(overlay);
    document.addEventListener("keydown", onKeydown, true);
    render();
  }

  async function maybeShow() {
    try {
      if (!global.RoleWorld || typeof global.RoleWorld.getLocalSettings !== "function") return false;
      const settings = await global.RoleWorld.getLocalSettings();
      if (settings[SEEN_KEY] === true) return false;
      // 已经配过 Key 的老用户（或导入过存档）不该被打扰，直接标记为已看。
      const saved = await global.RoleWorld.secrets.get(global.RoleWorldModel.secretKeyFor(settings));
      if (saved && saved.value) {
        await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true });
        return false;
      }
    } catch (_) {
      return false;
    }
    show();
    return true;
  }

  // 等页面启动落定再弹，免得盖在启动遮罩上面。
  function schedule() {
    let done = false;
    const attempt = () => {
      if (done) return;
      if (global.TASK21_READY === true) { done = true; maybeShow(); return; }
      window.setTimeout(attempt, 250);
    };
    attempt();
    window.setTimeout(() => { if (!done) { done = true; maybeShow(); } }, 8000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }

  global.RoleWorldOnboarding = { show, maybeShow, steps: STEPS };
})(typeof globalThis !== "undefined" ? globalThis : this);
