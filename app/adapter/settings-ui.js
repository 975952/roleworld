"use strict";

/*
 * adapter/settings-ui.js —— 模型设置面板（自包含）
 *
 * 页面上只要出现带 data-roleworld 属性的元素，这个脚本就会把它们接到本地设置上：
 *   data-roleworld="provider"     服务商下拉框
 *   data-roleworld="endpoint"     接口地址输入框
 *   data-roleworld="model"        模型名输入框
 *   data-roleworld="key"          API Key 输入框
 *   data-roleworld="key-save" / "key-delete" / "save" / "test"   按钮
 *   data-roleworld="key-status" / "test-result"                  状态文案
 *
 * 这样 index.html 与 assistant.html 可以共用同一套面板，而不用往两个大脚本里塞逻辑。
 */

(function (global) {
  const STYLE_ID = "roleworld-settings-style";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".rw-field{width:min(320px,52vw);padding:8px 10px;border-radius:9px;",
      "border:1px solid var(--line,var(--border,#2a3038));background:var(--panel,var(--surface,#12151a));",
      "color:inherit;font:inherit;font-size:14px;}",
      ".rw-field:focus{outline:2px solid var(--accent,#6f8cff);outline-offset:1px;}",
      ".rw-field-num{width:104px;}",
      ".rw-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
      ".rw-status.is-error{color:#ff7a7a;}",
    ].join("");
    document.head.appendChild(style);
  }

  function pick(name) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-roleworld="' + name + '"]'));
  }

  function first(name) {
    return pick(name)[0] || null;
  }

  function setStatus(node, text, isError) {
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("is-error", !!isError);
  }

  async function refresh() {
    const adapter = global.RoleWorld;
    if (!adapter) return;
    // 首次运行时设置里可能还没有记录，先确保适配层（含内容包安装）已经初始化完。
    await adapter.init();
    const settings = await adapter.getLocalSettings();

    pick("provider").forEach((node) => {
      if (node.value !== settings.provider) node.value = settings.provider;
    });
    pick("endpoint").forEach((node) => {
      if (document.activeElement !== node) node.value = settings.endpoint || "";
    });
    pick("model").forEach((node) => {
      if (document.activeElement !== node) node.value = settings.model || "";
    });
    pick("thinking").forEach((node) => {
      node.checked = settings.thinking === true;
    });
    pick("auto-memory").forEach((node) => {
      node.checked = settings.auto_memory !== false;
    });
    pick("price-input").forEach((node) => {
      if (document.activeElement !== node) node.value = Number(settings.price_input) > 0 ? settings.price_input : "";
    });
    pick("price-output").forEach((node) => {
      if (document.activeElement !== node) node.value = Number(settings.price_output) > 0 ? settings.price_output : "";
    });
    // 旧对话 token 预算：留空表示用默认值。
    pick("history-budget").forEach((node) => {
      if (document.activeElement !== node) node.value = Number(settings.history_token_budget) > 0 ? settings.history_token_budget : "";
    });

    // 单价提示：把币种、时段、高峰翻倍一次说清（官方英文页用美元报价，容易被误读成"价格不对"）。
    const pricing = global.RoleWorldPricing;
    if (pricing) {
      const modelNode = first("model");
      const model = (modelNode && modelNode.value.trim()) || settings.model || "";
      const hasCustom = Number(settings.price_input) > 0 || Number(settings.price_output) > 0;
      const info = pricing.describe(model, { input: settings.price_input, output: settings.price_output }, new Date());
      pick("price-hint").forEach((node) => {
        const note = hasCustom ? "" : `　（高峰时段为 2 倍；来源：${pricing.SOURCE}）`;
        setStatus(node, info.text + note, false);
        node.title = info.title;
      });
    }

    const provider = (first("provider") && first("provider").value) || settings.provider;
    const keyName = global.RoleWorldModel.secretKeyFor({ provider });
    const saved = await adapter.secrets.get(keyName);
    pick("key-status").forEach((node) => {
      setStatus(node, saved ? "已保存到本机 · 不会上传到任何服务器" : "未保存", false);
    });
  }

  function notify(patch) {
    global.dispatchEvent(new global.CustomEvent("roleworld:settings-changed", { detail: patch }));
  }

  async function saveAll() {
    const adapter = global.RoleWorld;
    if (!adapter) return;
    const providerNode = first("provider");
    const endpointNode = first("endpoint");
    const modelNode = first("model");
    const thinkingNode = first("thinking");
    const patch = {};
    if (providerNode) patch.provider = providerNode.value;
    if (endpointNode) patch.endpoint = endpointNode.value.trim();
    if (modelNode && modelNode.value.trim()) patch.model = modelNode.value.trim();
    if (thinkingNode) patch.thinking = thinkingNode.checked === true;
    const autoMemoryNode = first("auto-memory");
    if (autoMemoryNode) patch.auto_memory = autoMemoryNode.checked === true;
    const priceIn = first("price-input");
    const priceOut = first("price-output");
    if (priceIn) patch.price_input = Math.max(0, Number(priceIn.value) || 0);
    if (priceOut) patch.price_output = Math.max(0, Number(priceOut.value) || 0);
    const historyBudget = first("history-budget");
    if (historyBudget) {
      const raw = String(historyBudget.value || "").trim();
      // 留空 = 用默认（60000）。填了就是填的值，下限 1000，避免填 0 把历史全关掉。
      patch.history_token_budget = raw === "" ? 0 : Math.max(1000, Number(raw) || 0);
    }
    await adapter.saveLocalSettings(patch);
    await refresh();
    // 页面里的模型徽标、剧情模式的模型都要跟着变。
    notify(patch);
    return patch;
  }

  async function saveKey() {
    const adapter = global.RoleWorld;
    const input = first("key");
    const value = input ? input.value.trim() : "";
    if (!value) { pick("key-status").forEach((node) => setStatus(node, "请先粘贴 API Key", true)); return; }
    const provider = (first("provider") && first("provider").value) || "deepseek";
    await adapter.secrets.set(global.RoleWorldModel.secretKeyFor({ provider }), value);
    if (input) input.value = "";
    await refresh();
  }

  async function deleteKey() {
    const adapter = global.RoleWorld;
    const provider = (first("provider") && first("provider").value) || "deepseek";
    await adapter.secrets.remove(global.RoleWorldModel.secretKeyFor({ provider }));
    await refresh();
  }

  async function testConnection() {
    const nodes = pick("test-result");
    nodes.forEach((node) => setStatus(node, "正在测试…", false));
    try {
      await saveAll();
      const adapter = global.RoleWorld;
      const settings = await adapter.getLocalSettings();
      const provider = settings.provider;
      const result = await global.RoleWorldModel.complete(
        { messages: [{ role: "user", content: "回复两个字：可用" }], max_tokens: 16 },
        {
          settings: {
            provider,
            endpoint: global.RoleWorldModel.endpointFor(settings),
            model: settings.model,
          },
          apiKey: (await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider })) || {}).value || "",
        }
      );
      nodes.forEach((node) => setStatus(node, "连接正常：" + String(result.content || "").slice(0, 60), false));
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      nodes.forEach((node) => setStatus(node, "连接失败：" + message.slice(0, 200), true));
    }
  }

  function bind() {
    injectStyle();
    pick("save").forEach((node) => node.addEventListener("click", () => { saveAll(); }));
    pick("key-save").forEach((node) => node.addEventListener("click", () => { saveKey(); }));
    pick("key-delete").forEach((node) => node.addEventListener("click", () => { deleteKey(); }));
    pick("test").forEach((node) => node.addEventListener("click", () => { testConnection(); }));
    pick("provider").forEach((node) => node.addEventListener("change", () => { refresh(); }));
    // 别处改了配置（比如在聊天顶栏切模型）也要把面板同步过来。
    global.addEventListener("roleworld:settings-changed", () => { refresh(); });
    // 思考模式与自动记忆是即时开关：先让页面立刻按新值走，再落盘，避免"刚打开就发送"用不上。
    pick("thinking").forEach((node) => node.addEventListener("change", () => {
      notify({ thinking: node.checked === true });
      saveAll();
    }));
    pick("auto-memory").forEach((node) => node.addEventListener("change", () => {
      notify({ auto_memory: node.checked === true });
      saveAll();
    }));
    // 端点留空时用所选服务商的默认地址做占位提示，减少"不知道该填什么"的困惑。
    pick("endpoint").forEach((node) => {
      node.addEventListener("focus", async () => {
        if (node.value) return;
        const settings = await global.RoleWorld.getLocalSettings();
        node.placeholder = global.RoleWorldModel.endpointFor(settings);
      });
    });
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }

  global.RoleWorldSettingsUI = { refresh, saveAll, testConnection };
})(typeof globalThis !== "undefined" ? globalThis : this);
