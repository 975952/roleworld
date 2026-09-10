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

    const provider = (first("provider") && first("provider").value) || settings.provider;
    const keyName = global.RoleWorldModel.secretKeyFor({ provider });
    const saved = await adapter.secrets.get(keyName);
    pick("key-status").forEach((node) => {
      setStatus(node, saved ? "已保存到本机 · 不会上传到任何服务器" : "未保存", false);
    });
  }

  async function saveAll() {
    const adapter = global.RoleWorld;
    if (!adapter) return;
    const providerNode = first("provider");
    const endpointNode = first("endpoint");
    const modelNode = first("model");
    const patch = {};
    if (providerNode) patch.provider = providerNode.value;
    if (endpointNode) patch.endpoint = endpointNode.value.trim();
    if (modelNode && modelNode.value.trim()) patch.model = modelNode.value.trim();
    await adapter.saveLocalSettings(patch);
    await refresh();
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
