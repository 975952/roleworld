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

  /** 「自己填」那一行只在选中 manual 时出现；顺带把当前生效的默认值讲清楚。 */
  function syncSamplingRows() {
    const presetNode = first("sampling-preset");
    const preset = presetNode ? presetNode.value : "auto";
    const row = document.getElementById("samplingManualRow");
    if (row) row.hidden = preset !== "manual";
    const hint = first("sampling-hint");
    if (!hint) return;
    const TASK22 = global.TASK22_CORE;
    const table = TASK22 && TASK22.PURPOSE_PROFILES;
    if (preset === "auto" && table) {
      hint.textContent = "当前生效：对话页 温度 " + table.chat.temperature + " / 伴侣 " + table.companion.temperature
        + " / 剧情页 " + table.scene.temperature + "（各自 top_p " + table.chat.topP + " 起）";
    } else if (preset === "manual") {
      hint.textContent = "留空则沿用该用途的默认值。";
    } else if (table && TASK22.SAMPLING_PRESETS[preset]) {
      const row2 = TASK22.SAMPLING_PRESETS[preset];
      hint.textContent = "当前生效：温度 " + row2.temperature + " / top_p " + row2.topP;
    } else {
      hint.textContent = "";
    }
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
    pick("event-memory").forEach((node) => {
      node.checked = settings.auto_event_memory !== false;
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
    // 自动记忆上限：留空用默认 50。
    pick("memory-max").forEach((node) => {
      if (document.activeElement !== node) node.value = Number(settings.auto_memory_max) > 0 ? settings.auto_memory_max : "";
    });
    // 本地端点上下文：留空用默认 32768。
    pick("local-context").forEach((node) => {
      if (document.activeElement !== node) {
        const value = Number(settings.local_context);
        node.value = value >= 2000 && value !== 32768 ? value : "";
      }
    });
    // 生成参数：预设 +（"自己填"时的）温度 / top_p + 输出上限。
    const preset = String(settings.sampling_preset || "auto");
    pick("sampling-preset").forEach((node) => { node.value = preset; });
    pick("temperature").forEach((node) => {
      if (document.activeElement !== node) node.value = Number(settings.temperature) > 0 ? settings.temperature : "";
    });
    pick("top-p").forEach((node) => {
      if (document.activeElement !== node) node.value = Number(settings.top_p) > 0 ? settings.top_p : "";
    });
    pick("max-output").forEach((node) => {
      if (document.activeElement !== node) {
        const value = Number(settings.max_tokens);
        // 与渠道默认相同就视为"没填"，免得把默认值显示成用户自己设的。
        node.value = Number.isFinite(value) && value > 0 && value !== 32768 ? value : "";
      }
    });
    syncSamplingRows();

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
    await refreshCardStatus(settings, saved);
  }

  /** 体验卡状态：密钥看起来像卡号时，顺手查一下还能用多少。 */
  async function refreshCardStatus(settings, savedSecret) {
    const card = global.RoleWorldCard;
    const nodes = pick("card-status");
    if (!card || !nodes.length) return;
    let secret = savedSecret;
    if (!secret && global.RoleWorld) {
      secret = await global.RoleWorld.secrets.get(global.RoleWorldModel.secretKeyFor({ provider: "custom" }));
    }
    const value = (secret && secret.value) || "";
    if (!card.looksLikeCard(value)) {
      nodes.forEach((node) => setStatus(node, "没有使用体验卡", false));
      return;
    }
    const relay = settings.card_relay || "";
    if (!relay) {
      nodes.forEach((node) => setStatus(node, "在用体验卡，但没记住中转地址：重新粘贴一次整条链接", true));
      return;
    }
    nodes.forEach((node) => setStatus(node, "正在查额度…", false));
    const info = await card.quota(relay, value);
    nodes.forEach((node) => setStatus(node, "体验卡：" + card.formatQuota(info), !info.ok));
  }

  /** 用一张体验卡：解析 → 落盘（接口指向中转、卡号进密钥位）→ 报剩余额度。 */
  async function useCard() {
    const card = global.RoleWorldCard;
    const input = first("card");
    const nodes = pick("card-status");
    const raw = input ? input.value.trim() : "";
    if (!card) return;
    if (!raw) {
      nodes.forEach((node) => setStatus(node, "先粘贴卡号或整条体验卡链接", true));
      return;
    }
    nodes.forEach((node) => setStatus(node, "正在配置…", false));
    const result = await card.apply(raw);
    if (!result.ok) {
      nodes.forEach((node) => setStatus(node, result.message, true));
      return;
    }
    if (input) input.value = "";
    await refresh();
    if (global.TASK21 && typeof global.TASK21.reloadSettings === "function") global.TASK21.reloadSettings();
  }

  async function checkCardQuota() {
    const card = global.RoleWorldCard;
    const nodes = pick("card-status");
    if (!card) return;
    const settings = await global.RoleWorld.getLocalSettings();
    const secret = await global.RoleWorld.secrets.get(global.RoleWorldModel.secretKeyFor({ provider: "custom" }));
    const value = (secret && secret.value) || "";
    if (!card.looksLikeCard(value)) {
      nodes.forEach((node) => setStatus(node, "本机没有正在使用的体验卡", true));
      return;
    }
    const relay = settings.card_relay || "";
    if (!relay) {
      nodes.forEach((node) => setStatus(node, "没记住中转地址：重新粘贴一次整条链接", true));
      return;
    }
    nodes.forEach((node) => setStatus(node, "正在查额度…", false));
    const info = await card.quota(relay, value);
    nodes.forEach((node) => setStatus(node, "体验卡：" + card.formatQuota(info), !info.ok));
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
    const eventMemoryNode = first("event-memory");
    if (eventMemoryNode) patch.auto_event_memory = eventMemoryNode.checked === true;
    const priceIn = first("price-input");
    const priceOut = first("price-output");
    if (priceIn) patch.price_input = Math.max(0, Number(priceIn.value) || 0);
    if (priceOut) patch.price_output = Math.max(0, Number(priceOut.value) || 0);
    const historyBudget = first("history-budget");
    if (historyBudget) {
      const raw = String(historyBudget.value || "").trim();
      // 留空 = 用默认（不限制）。填了就是填的值，下限 1000，避免填 0 把历史全关掉。
      patch.history_token_budget = raw === "" ? 0 : Math.max(1000, Number(raw) || 0);
    }
    const memoryMax = first("memory-max");
    if (memoryMax) {
      const raw = String(memoryMax.value || "").trim();
      // 留空 = 用默认 50；填了就按填的算，下限 5 上限 500。
      patch.auto_memory_max = raw === "" ? 50 : Math.min(500, Math.max(5, Number(raw) || 50));
    }
    const localContext = first("local-context");
    if (localContext) {
      const raw = String(localContext.value || "").trim();
      // 留空 = 默认 32768。下限 2000（再小没有可用性），上限 2M（比任何常见模型都大）。
      patch.local_context = raw === "" ? 32768 : Math.min(2000000, Math.max(2000, Number(raw) || 32768));
    }
    // 生成参数：预设；"自己填"时才有温度/top_p；输出上限留空 = 用渠道默认。
    const presetNode = first("sampling-preset");
    if (presetNode) patch.sampling_preset = presetNode.value || "auto";
    const tempNode = first("temperature");
    if (tempNode) {
      const raw = String(tempNode.value || "").trim();
      patch.temperature = raw === "" ? 0.8 : Math.min(2, Math.max(0, Number(raw)));
    }
    const topPNode = first("top-p");
    if (topPNode) {
      const raw = String(topPNode.value || "").trim();
      patch.top_p = raw === "" ? 0.9 : Math.min(1, Math.max(0.01, Number(raw)));
    }
    const maxOutNode = first("max-output");
    if (maxOutNode) {
      const raw = String(maxOutNode.value || "").trim();
      // 留空 = 32768（与渠道默认一致，等于"没设"）。下限 64，免得填出只能说一个字的值。
      patch.max_tokens = raw === "" ? 32768 : Math.min(1000000, Math.max(64, Number(raw) || 32768));
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
    // 生成参数预设：切换时先把"自己填"那一行显示/隐藏对，再落盘（改完立刻生效）。
    pick("sampling-preset").forEach((node) => node.addEventListener("change", () => {
      syncSamplingRows();
      notify({ sampling_preset: node.value || "auto" });
      saveAll();
    }));
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
    pick("event-memory").forEach((node) => node.addEventListener("change", () => {
      notify({ auto_event_memory: node.checked === true });
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
    pick("card-use").forEach((node) => node.addEventListener("click", () => { useCard().catch(() => {}); }));
    pick("card-check").forEach((node) => node.addEventListener("click", () => { checkCardQuota().catch(() => {}); }));
    pick("card").forEach((node) => node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); useCard().catch(() => {}); }
    }));
    // 同学点开的那条体验卡链接自带 #card=…：不用他手动填，直接配好并说一声。
    const applyCardFromUrl = () => {
      if (!global.RoleWorldCard || typeof global.RoleWorldCard.applyFromLocation !== "function") return;
      if (!global.RoleWorldCard.cardFromLocation(global.location && global.location.href)) return;
      global.RoleWorldCard.applyFromLocation(global.location.href).then((result) => {
        pick("card-status").forEach((node) => setStatus(node, result.ok
          ? (result.applied ? "体验卡已自动配好：" + result.message : "已在用这张体验卡：" + result.message)
          : result.message, !result.ok));
        if (result.ok) refresh();
      }).catch(() => {});
    };
    applyCardFromUrl();
    // 同一个标签页里粘链接（只改片段地址栏不会重新加载页面）时也要生效。
    global.addEventListener("hashchange", applyCardFromUrl);
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }

  global.RoleWorldSettingsUI = { refresh, saveAll, testConnection, useCard, checkCardQuota };
})(typeof globalThis !== "undefined" ? globalThis : this);
