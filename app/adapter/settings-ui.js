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
      // 打开角色语音前的一次性告知：承诺边界变了（话会离开设备），
      // 所以做成必须点一下的对话框，而不是一行小字。
      ".rw-consent{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;",
      "background:rgba(6,8,12,.62);padding:20px;backdrop-filter:blur(2px);}",
      ".rw-consent-box{max-width:560px;width:100%;border-radius:16px;padding:22px 24px;",
      "background:var(--panel,var(--surface,#12151a));color:inherit;border:1px solid var(--line,var(--border,#2a3038));",
      "box-shadow:0 20px 60px rgba(0,0,0,.45);line-height:1.65;}",
      ".rw-consent-box h3{margin:0 0 10px;font-size:17px;}",
      ".rw-consent-box p{margin:0;font-size:13.5px;opacity:.92;}",
      ".rw-consent-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap;}",
      // 2026-09-16 极简：设置行默认**只显示标题与控件**，那一大段解释收进「说明」。
      // 为什么要这么改：用户原话「设置里面那么多想，废话全部删掉，只保留必须的极简的功能设置」——
      // 每行两行小字堆在一起，找东西全靠读，普通人根本读不完。
      // 解释**不是删掉**，是折叠：点一下「说明」还在，调参排障时照样查得到。
      ".settings-row .settings-desc-toggle{display:none;}",
      "@media (min-width:721px){",
      // ⚠ 折叠的是**解释文字**；标了 `rw-keep-note` 的行例外 —— 那几行的 span 是
      //   **点完按钮的结果**（体验卡 / API Key / 版本 / 最近一次导出），必须一直看得见。
      //   用户 2026-09-17 实测「点使用体验卡直接消失，其他按钮都没反应」的真因就在这里：
      //   结果写进去了，却被这条规则 display:none —— 唯一看得见的变化只有输入框被清空
      //   （而 test-result 是 <p>，所以"测试连接显示正常"）。
      ".settings-row:not(.rw-keep-note)>div>span{display:none;}",
      ".settings-row.rw-desc-open>div>span{display:block;margin-top:4px;}",
      ".settings-row.is-hidden-desc .settings-desc-toggle{display:inline-block;margin-left:6px;padding:0 6px;",
      "font-size:12px;line-height:18px;border-radius:6px;border:1px solid var(--line,var(--border,#2a3038));",
      "background:transparent;color:inherit;opacity:.7;cursor:pointer;vertical-align:middle;}",
      ".settings-row.is-hidden-desc .settings-desc-toggle:hover{opacity:1;}",
      "}",
      // 「更多设置 ▾」这个分组开关：它**不是**一个设置分区（没有 data-settings-section），
      // 所以样式独立写一份，不靠继承 .settings-nav-item 的排版。
      ".settings-nav-more{display:block;width:100%;margin-top:6px;padding:9px 12px;text-align:left;",
      "font:inherit;font-size:13px;border:0;border-top:1px solid var(--line,var(--border,#2a3038));",
      "border-radius:0;background:transparent;color:inherit;opacity:.85;font-weight:600;cursor:pointer;}",
      ".settings-nav-more:hover{opacity:1;}",
    ].join("");
    document.head.appendChild(style);
  }

  /**
   * 把每个设置行那一大段解释收进「说明」（只在宽屏；窄屏本来就一行一行排，不折叠）。
   * 幂等：重复调用不会重复插按钮。
   */
  function collapseSettingsNotes() {
    if (global.matchMedia && global.matchMedia("(max-width:720px)").matches) return 0;
    let count = 0;
    document.querySelectorAll(".settings-row").forEach((row) => {
      if (row.dataset.descReady === "1") return;
      const box = row.querySelector(":scope > div");
      const span = box ? box.querySelector(":scope > span") : null;
      if (!box || !span) return;
      // `rw-keep-note` 的行，span 是**点完按钮的结果**（体验卡 / API Key / 版本 / 最近一次导出），
      // 不是解释文字：它一直看得见（见上面的 CSS），也不该给它一个点了没反应的「说明」开关。
      if (row.classList.contains("rw-keep-note")) { row.dataset.descReady = "1"; return; }
      row.dataset.descReady = "1";
      row.classList.add("is-hidden-desc");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "settings-desc-toggle";
      toggle.textContent = "说明";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", (event) => {
        // 这一行可能整个是 <label>：不拦一下的话点按钮会连带触发那个控件。
        event.preventDefault();
        event.stopPropagation();
        const open = row.classList.toggle("rw-desc-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.textContent = open ? "收起" : "说明";
      });
      const strong = box.querySelector(":scope > strong");
      (strong || box).appendChild(toggle);
      count += 1;
    });
    return count;
  }

  function pick(name) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-roleworld="' + name + '"]'));
  }

  function first(name) {
    return pick(name)[0] || null;
  }

  function setStatus(node, text, isError, isOk) {
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("is-error", !!isError);
    node.classList.toggle("is-ok", !!isOk);
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

  /**
   * 设置分组：**常用只要 5 页**，其余收进「更多」（2026-09-16 用户要求：
   * "设置里面那么多想，废话全部删掉，只保留必须的极简的功能设置"）。
   *
   * 凭什么这么分：普通人打开设置**几乎只为这几件事** —— 用什么模型 / 开不开语音 /
   * 角色说什么语言 / 界面太小说 / 备份换机。其余（记忆条数、token 预算、单价、采样参数、
   * 角色管理、存档导入导出）是**调参和排障**时才找的，默认收起来但一键可展开 ——
   * 不是删掉：它们是这套应用的能力，删了等于砍功能。
   */
  const COMMON_SECTIONS = ["connection", "voice", "conversation", "appearance", "local-data"];
  const MORE_SECTIONS = ["characters", "memory", "advanced", "about"];

  /** 把导航按"常用 / 更多"重排，并给「更多」那一组一个可展开的分隔按钮。 */
  function arrangeSettingsNav() {
    const nav = document.querySelector(".settings-nav");
    if (!nav || nav.dataset.arranged === "1") return;
    nav.dataset.arranged = "1";
    const byName = {};
    Array.from(nav.querySelectorAll("[data-settings-section]")).forEach((node) => {
      byName[node.dataset.settingsSection] = node;
    });
    const order = COMMON_SECTIONS.concat(MORE_SECTIONS);
    order.forEach((name) => { if (byName[name]) nav.appendChild(byName[name]); });

    const toggle = document.createElement("button");
    toggle.type = "button";
    // ⚠ **不要**给它 `settings-nav-item` 这个类：它不是"一个设置分区"，只是分组开关。
    //   带上那个类之后，凡是"遍历 .settings-nav-item 当分区用"的代码（含回归测试与可达性检查）
    //   都会把它当成一个没有 data-settings-section 的分区，拿到 undefined 再去查面板 ——
    //   现象是"设置滚到底被挡住/点不到"这种看不懂的失败（2026-09-16 端到端实测踩到）。
    toggle.className = "settings-nav-more";
    toggle.dataset.settingsMore = "toggle";
    toggle.textContent = "更多设置 ▾";
    toggle.setAttribute("aria-expanded", "false");
    const more = MORE_SECTIONS.map((name) => byName[name]).filter(Boolean);
    const expand = (open) => {
      more.forEach((node) => { node.hidden = !open; });
      toggle.textContent = open ? "更多设置 ▴" : "更多设置 ▾";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      nav.dataset.moreOpen = open ? "1" : "0";
    };
    expand(false);
    toggle.addEventListener("click", () => expand(nav.dataset.moreOpen !== "1"));
    nav.appendChild(toggle);
    // 停在"更多"里某一页时（比如从角色管理按钮跳进来），默认展开，别让当前页看不见。
    const active = MORE_SECTIONS.some((name) => byName[name] && byName[name].classList.contains("is-active"));
    if (active) expand(true);
    global.__rwExpandSettingsMore = expand;
  }

  async function refresh(options) {
    const adapter = global.RoleWorld;
    if (!adapter) return;
    // 首次运行时设置里可能还没有记录，先确保适配层（含内容包安装）已经初始化完。
    // 刷新失败要向上抛：贴卡成功后的确认由 useCard() 自己兜住，不能在这里静默吞掉。
    try {
      await adapter.init();
    } catch (error) {
      if (options && options.preserveCardStatus) throw error;
      try {
        await adapter.getLocalSettings();
      } catch (_) {
        // 连设置都读不出来：说明文字继续失败时才按原样抛出。
      }
    }
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
    // 表情包：默认开。关掉之后提示词里不再出现 [Stickers]，角色也就不会发表情。
    pick("stickers").forEach((node) => {
      node.checked = settings.stickers_enabled !== false;
    });
    // 角色语音（朗读）：默认关 —— 会出声的功能不该默认打开。
    // 这一行只在真的有语音合成能力时才由 applyVoiceCapability() 露出来。
    pick("voice-enabled").forEach((node) => {
      node.checked = settings.voice_enabled === true;
    });
    pick("speech-input").forEach((node) => {
      node.checked = settings.speech_input_enabled !== false;
    });
    pick("language-mode").forEach((node) => {
      // 默认 "auto" = 跟着角色卡自己写的语言（2026-09-12 用户改的默认值）。
      node.value = settings.language_mode === "zh" || settings.language_mode === "en" ? settings.language_mode : "auto";
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
    // 浏览器（或密码管理器）可能把"记住的密码"自动填进这个密钥栏 ——
    // 用体验卡的人早先把卡号粘在这一栏过，之后每次都看到卡号被自动填回来
    // （用户 2026-09-13：「apikey 好像会自动填上那个卡啥的」）。
    // 只清"恰好等于本机已存的那个密钥"的情况：用户自己新粘的 Key 不会被误删。
    if (saved && saved.value) {
      pick("key").forEach((node) => {
        if (document.activeElement !== node && node.value === saved.value) node.value = "";
      });
    }
    // 刚贴卡成功的那次刷新**不改写卡状态行**（useCard 已给出确认与额度）。
    // 其他入口（打开设置、刷新）照旧：显示"正在用/没在用 + 额度"。
    await refreshCardStatus(settings, saved, !!(options && options.preserveCardStatus));
    // 连接方式：显示对应表单 + 写清"现在是直连还是走中转"（文案与实际行为一致）。
    try { await renderConnectionMode(settings); } catch (_) { /* 说明文字失败不影响设置 */ }
    await refreshVersion();
  }

  /** 版本行：显示"运行中的版本"，并和线上 version.json 对照 ——
   *  网页版有离线壳，浏览器可能还在跑旧 JS；没有这一行就只能靠猜（2026-09-12 真踩过：
   *  "我明明发新版了，用户那边还是旧行为"）。 */
  async function refreshVersion() {
    const nodes = pick("app-version");
    if (!nodes.length) return;
    const running = String(global.ROLEWORLD_BUILD || "");
    let online = "";
    try {
      const res = await fetch("version.json", { cache: "no-store" });
      if (res.ok) online = String(((await res.json()) || {}).version || "");
    } catch (_) { /* 离线时只有运行版本可显示 */ }
    let text;
    if (!running) text = online ? "运行版本未知 · 线上 " + online : "运行版本未知";
    else if (!online) text = "运行 " + running + "（离线，查不到线上版本）";
    else if (online === running) text = "运行 " + running + " · 已是最新";
    else text = "运行 " + running + " · 线上已更新到 " + online + "：点右边「检查更新」刷新页面";
    nodes.forEach((node) => setStatus(node, text, !!(running && online && online !== running)));
  }

  /* ---------------- 连接方式：自己配 API / 用体验卡 ----------------
   * 2026-09-13 重排设置页时加的。要求（用户原话）：
   *   「体验卡用户可以直接查额度、换卡，不必理解 API 参数」
   *   「切换连接方式时不误删已有配置或凭据，也不误用另一种方式的凭据」
   * 做法：
   *   - 当前是哪种方式**从真实状态推**（密钥看起来像卡号 = 体验卡），不新增一个标志位，
   *     免得出现"界面说体验卡、实际用着 Key"这种两套账。
   *   - 切回自己的 API：只改 provider / endpoint，**不删体验卡**（卡号与中转地址都留着），
   *     所以随时能一键切回去。
   *   - 体验卡占的是「自定义云端服务」那个密钥格（历史原因），
   *     所以切到体验卡前会把这件事写在状态行里，不能默默覆盖用户的自定义 Key。
   */
  const CONNECTION_PROVIDERS = ["deepseek", "openai", "openrouter", "siliconflow", "custom"];

  function providerLabel(provider) {
    return ({
      deepseek: "DeepSeek 官方",
      openai: "OpenAI",
      openrouter: "OpenRouter",
      siliconflow: "硅基流动",
      custom: "自定义云端服务",
    })[provider] || provider || "未设置";
  }

  function setConnectionStatus(text, bad) {
    const nodes = pick("connection-status");
    nodes.forEach((node) => setStatus(node, text || "", !!bad));
  }

  async function readSecret(provider) {
    try {
      const saved = await global.RoleWorld.secrets.get(global.RoleWorldModel.secretKeyFor({ provider }));
      return (saved && saved.value) || "";
    } catch (_) { return ""; }
  }

  function looksLikeCard(value) {
    const card = global.RoleWorldCard;
    return !!(card && typeof card.looksLikeCard === "function" && card.looksLikeCard(value));
  }

  /** 当前连接方式："card" | "key"。 */
  async function connectionMode(settings) {
    const current = settings || await global.RoleWorld.getLocalSettings();
    const provider = current.provider || "deepseek";
    return looksLikeCard(await readSecret(provider)) ? "card" : "key";
  }

  /** 用户自己的 Key 存在哪一家（跳过体验卡占用的自定义格）。 */
  async function ownKeyProvider() {
    for (const provider of CONNECTION_PROVIDERS) {
      if (provider === "custom") continue;
      const value = await readSecret(provider);
      if (value && !looksLikeCard(value)) return provider;
    }
    const custom = await readSecret("custom");
    if (custom && !looksLikeCard(custom)) return "custom";
    return "";
  }

  /**
   * 连接方式的两块表单，谁能看见。**这是唯一一处**切换它们的地方 ——
   * 以前 renderConnectionMode 里自己写一遍、两个"切过去"的函数都不写，
   * 结果：用户点「使用体验卡」时，提示语说"粘到下面的输入框"，
   * 而那个输入框（#connectionCardBlock）**根本没被显示出来**，
   * 只 focus 了一个看不见的框 —— 用户看到的就是"选了方式，但没有填卡号的地方"。
   * （2026-09-14 用户实测反馈，线上 0.1.54 也有这个问题。）
   */
  function showConnectionBlock(mode) {
    const keyBlock = document.querySelector("#connectionKeyBlock");
    const cardBlock = document.querySelector("#connectionCardBlock");
    if (keyBlock) keyBlock.hidden = mode !== "key";
    if (cardBlock) cardBlock.hidden = mode !== "card";
    document.querySelectorAll("[data-roleworld='connection-key']").forEach((node) => { node.checked = mode === "key"; });
    document.querySelectorAll("[data-roleworld='connection-card']").forEach((node) => { node.checked = mode === "card"; });
  }

  /** 把界面切成对应方式的表单 + 说明（不改任何配置，只改显示）。 */
  async function renderConnectionMode(settings) {
    const current = settings || await global.RoleWorld.getLocalSettings();
    const mode = await connectionMode(current);
    showConnectionBlock(mode);
    const summary = document.querySelector("#connectionSummary");
    if (!summary) return;
    let relay = "";
    try {
      const url = new URL(global.RoleWorldModel.endpointFor(current));
      relay = url.host;
    } catch (_) { relay = ""; }
    if (mode === "card") {
      summary.textContent = "当前：通过体验卡中转连接" + (relay ? "（" + relay + "）" : "")
        + "。卡号只在本机，换设备要重新粘一次发卡人给的整行。";
    } else {
      summary.textContent = "当前：直连 " + providerLabel(current.provider)
        + (relay ? "（" + relay + "）" : "") + "。对话内容直接发给这家服务商，不经过本项目。";
    }
    // 切到体验卡会占用「自定义云端服务」的 Key 格子 —— 这件事必须说出来，不能默默覆盖。
    const customKey = await readSecret("custom");
    const willOverwrite = mode !== "card" && current.provider !== "custom" && !!customKey && !looksLikeCard(customKey);
    setConnectionStatus(willOverwrite
      ? "注意：体验卡会用「自定义云端服务」的密钥格存卡号，切过去会覆盖你在这里填的自定义 Key（切回来需要重新粘一次）。"
      : "", false);
  }

  /** 切回"自己配 API"：只改 provider / endpoint，体验卡原样留着。 */
  async function switchToOwnKey() {
    const adapter = global.RoleWorld;
    // 先把界面切过去：下面要读密钥、要发请求，中间任何一步失败都不该让用户
    // 看着"选了自己配、却还是体验卡那张表单"。
    showConnectionBlock("key");
    const found = await ownKeyProvider();
    const provider = found || "deepseek";
    await adapter.saveLocalSettings({ provider, endpoint: "" });
    notify({ provider, endpoint: "" });
    await refresh();
    setConnectionStatus(found
      ? "已切回自己的 API 配置（" + providerLabel(provider) + "）。体验卡没删，随时能切回去。"
      : "已切回自己的 API 配置。这家服务商下还没有 Key，粘一把保存就能用。", false);
    reloadChat();
  }

  /** 切回体验卡：本机还留着卡号与中转地址就直接启用，否则让用户粘整行。 */
  async function switchToCard() {
    const card = global.RoleWorldCard;
    const adapter = global.RoleWorld;
    // ⚠ 先把卡号那一块**显示出来**：下面"本机还没存过卡"的分支就是要用户粘一整行，
    //   以前那块还是隐藏的，提示语却写着"粘到下面的输入框" —— 用户根本看不到框。
    showConnectionBlock("card");
    const settings = await adapter.getLocalSettings();
    const value = await readSecret("custom");
    const relay = settings.card_relay || "";
    if (card && looksLikeCard(value) && relay) {
      await adapter.saveLocalSettings({ provider: "custom", endpoint: card.endpointFor(relay) });
      notify({ provider: "custom", endpoint: card.endpointFor(relay) });
      await refresh();
      setConnectionStatus("已切回体验卡（本机还存着这张卡）。", false);
      reloadChat();
      return;
    }
    setConnectionStatus("把发卡人给你的那一整行（卡号@中转地址，或整条链接）粘到下面的输入框，再点「使用体验卡」。", false);
    const input = first("card");
    if (input) { input.focus(); }
  }

  function reloadChat() {
    if (global.TASK21 && typeof global.TASK21.reloadSettings === "function") {
      try { global.TASK21.reloadSettings(); } catch (_) { /* 对话页自己会读新设置 */ }
    }
  }

  /** 体验卡状态：密钥看起来像卡号时，顺手查一下还能用多少。
   *  @param {boolean} skipRewrite 贴卡刚成功的场景：不要改写状态行（成功确认由 useCard 负责）。 */
  async function refreshCardStatus(settings, savedSecret, skipRewrite) {    const card = global.RoleWorldCard;
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
    if (skipRewrite) return;
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
    if (!card) { reportCardError(); return; }
    if (!raw) {
      nodes.forEach((node) => setStatus(node, "先粘贴卡号或整条体验卡链接", true));
      return;
    }
    nodes.forEach((node) => setStatus(node, "正在配置…", false));
    const result = await card.apply(raw);
    if (!result.ok) {
      nodes.forEach((node) => setStatus(node, result.message || "这张卡没用上，请检查卡号和中转地址后重试。", true));
      return;
    }
    // 保存与界面刷新分开：init/reloadSettings 失败不能吞掉已保存的确认。
    const confirmation = "✓ 体验卡已启用：" + card.formatQuota(result.quota)
      + "（已保存在这台设备上，下次打开不用再填）";
    const warnings = [];
    const showResult = () => nodes.forEach((node) => setStatus(node,
      confirmation + (warnings.length ? "。" + warnings.join("；") : ""), false, true));
    showResult();
    if (input) input.value = "";
    // 超时不取消底层读取，但迟到的 refresh 也不能覆盖这次贴卡的结果。
    const sync = async (action, warning) => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(action),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("refresh timeout")), 8000); }),
        ]);
      } catch (_) {
        warnings.push(warning + "，不影响已保存；可关闭设置后重新打开");
      } finally {
        clearTimeout(timer);
        showResult();
      }
    };
    await sync(() => refresh({ preserveCardStatus: true }), "设置/额度刷新失败或超时");
    await sync(() => {
      if (global.TASK21 && typeof global.TASK21.reloadSettings === "function") return global.TASK21.reloadSettings();
    }, "对话设置刷新失败或超时");
  }

  function reportCardError() {
    // 不回显异常原文：存储/网络异常可能夹带卡号或地址。
    pick("card-status").forEach((node) => setStatus(node,
      "体验卡配置未完成：加载或保存失败。卡号仍留在框里，请重试；仍失败可关闭设置后重新打开。", true));
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
    const stickersNode = first("stickers");
    if (stickersNode) patch.stickers_enabled = stickersNode.checked === true;
    const voiceNode = first("voice-enabled");
    if (voiceNode) patch.voice_enabled = voiceNode.checked === true;
    const speechInputNode = first("speech-input");
    if (speechInputNode) patch.speech_input_enabled = speechInputNode.checked === true;
    const languageModeNode = first("language-mode");
    if (languageModeNode) {
      const value = languageModeNode.value;
      patch.language_mode = value === "zh" || value === "en" ? value : "auto";
    }
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

  /**
   * 语音相关的两行：只在**这个中转真的做得到**时才露出来，并把原因写清楚。
   *
   * 判据（2026-09-14 换的）：打开「角色语音」+ 在用体验卡 + 中转配了火山凭据。
   * **不再是** speechSynthesis / 安卓原生桥 —— 语音这一轮改成只走云端。
   *
   * 为什么不能无脑显示：摆一个"角色语音"开关然后点了没反应，比不显示更糟。
   * 所以：做不到就把开关藏起来、把原因写在标题上；做得到才显示。
   */
  function applyVoiceCapability() {
    const Cloud = global.RoleWorldVoiceCloud;
    const Voice = global.RoleWorldVoice;
    if (!Cloud) return;
    let cap;
    try { cap = Cloud.capability(); } catch (_) { return; }
    const voiceRow = document.querySelector("#voiceEnabledRow");
    const voiceNote = document.querySelector("#voiceEnabledNote");
    // 开关本身：**永远显示这一行**。
    // 教训（2026-09-14 用户实测"角色语音根本没有"）：以前用不了就整行藏起来，
    // 结果用户连"有这么个东西、为什么用不了、去哪配"都看不到 —— 藏起来等于没有。
    // 现在改成：看得见，但**不能用就禁用**（灰掉），旁边把原因和去哪儿解决写清楚。
    // 这不违背"不摆点了没反应的按钮"：那个原则说的是**看起来能用其实没用**，
    // 而一个明确禁用 + 说明原因的开关，本身就是最好的解释。
    const openable = !!(cap.relay && cap.enabled);
    const enabled = isVoiceEnabled();
    if (voiceRow) voiceRow.hidden = false;
    const voiceBox = voiceRow ? voiceRow.querySelector('input[type="checkbox"]') : null;
    if (voiceBox) voiceBox.disabled = !openable && !enabled;
    if (voiceNote) {
      voiceNote.title = cap.reason || "";
      if (!cap.relay) {
        voiceNote.textContent = "云端语音要用体验卡：卡号就是凭据，你不用自己配火山密钥。"
          + "现在这台设备没有在用体验卡，所以打不开 —— 去「连接方式 → 使用体验卡」粘上发卡人给你的那一整行就能用了。"
          + "（文字聊天不受影响。）";
      } else if (!cap.enabled) {
        voiceNote.textContent = (cap.reason || "这个中转还没配火山语音凭据，所以现在合成不了。")
          + "文字聊天不受影响。";
      } else if (!enabled) {
        voiceNote.textContent = "打开后，每条回复的「⋯」菜单里会多一个「朗读」，由云端合成。"
          + "打开时会把角色要说的话经体验卡中转发给火山引擎（只发那句话与音色，不发你的对话记录）。";
      } else if (!cap.canSpeak) {
        voiceNote.textContent = cap.checked ? (cap.reason || "现在还用不了。") : "正在确认这个中转的语音能力…";
      } else {
        voiceNote.textContent = "已打开。每条回复的「⋯」菜单里有「朗读」；角色说的话会经体验卡中转发给火山引擎合成。"
          + "每个角色的音色在「设置 → 语音」里单独挑。";
      }
    }

    // 「语音输入」（按住说话 → 文字）：**2026-09-14 用户拍板"先不做"，而且实测用不了** ——
    // 它靠浏览器自带的识别（要连 Chrome/Edge 自己的云服务，国内网络基本必然失败）。
    // 所以这一行**一直藏着**，而不是"有能力就露出来"：露出来就有人会去点，点了没反应。
    // 代码与能力探测都还在（`voice-core` 的 listen/transcribeBlob 没删），以后要做再打开这里。
    const inputRow = document.querySelector("#speechInputRow");
    if (inputRow) inputRow.hidden = true;
  }

  /** 现在「角色语音」这个开关是开的吗（读的是同步快照，菜单项也读它）。 */
  function isVoiceEnabled() {
    const snapshot = global.__rwVoiceSettingsSnapshot;
    return !!(snapshot && snapshot.voice_enabled === true);
  }

  /**
   * 打开语音前的**一次性明确告知**。
   *
   * 为什么必须有一次显式同意：这个应用的承诺是"文字只在这台设备上"，
   * 而打开语音之后，角色说的那些话会离开设备、经过体验卡中转到火山引擎。
   * 这是**承诺的边界变了**，不能靠一行小字暗示，必须让人点一下"我知道"。
   * 同意过的记在 `voice_consent_at`，之后不再打扰。
   */
  async function confirmVoiceConsent(options) {
    const settings = await global.RoleWorld.getLocalSettings().catch(() => ({}));
    if (settings && settings.voice_consent_at) return true;
    const agreed = await askConsent(options);
    if (!agreed) return false;
    await global.RoleWorld.saveLocalSettings({ voice_consent_at: new Date().toISOString() });
    return true;
  }

  /**
   * 第一次打开语音前的同意弹层。
   *
   * `options` 可以换文案（标题 / 正文 / 按钮字）——2026-09-16 的底部面板要用自己的说法，
   * 但"同意一次、记在 voice_consent_at"这件事只有这一处实现（不写第二套）。
   * 不传 options 时就是设置页里那句默认文案。
   */
  function askConsent(options) {
    const copy = options || {};
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "rw-consent";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      const box = document.createElement("div");
      box.className = "rw-consent-box";
      const title = document.createElement("h3");
      title.textContent = copy.title || "打开角色语音之前，先说清楚一件事";
      const body = document.createElement("p");
      body.innerHTML = copy.body || ("打开之后，<b>角色要说的话会离开这台设备</b>："
        + "它经你的体验卡中转发给<b>火山引擎「豆包语音合成模型 2.0」</b>合成音频，再发回来播放。<br><br>"
        + "发出去的是：<b>要念的那段文字 + 音色 + 语速</b>。<br>"
        + "不会发出去的是：你的对话记录、角色卡、记忆书、API Key —— 中转只按字符数记账，不记录正文。<br><br>"
        + "（文字聊天本身仍然只发给你配的模型端点，这一条没有变。）");
      const actions = document.createElement("div");
      actions.className = "rw-consent-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "plain-button";
      cancel.dataset.voiceConsent = "cancel";
      cancel.textContent = copy.cancelText || "先不开";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "primary-button";
      ok.dataset.voiceConsent = "accept";
      ok.textContent = copy.acceptText || "我知道，打开";
      actions.append(cancel, ok);
      box.append(title, body, actions);
      overlay.appendChild(box);
      function close(result) {
        overlay.remove();
        resolve(result);
      }
      ok.addEventListener("click", () => close(true));
      cancel.addEventListener("click", () => close(false));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(false); });
      document.body.appendChild(overlay);
      ok.focus();
    });
  }

  /**
   * 把「角色语音」这个开关一次性打开/关掉 —— **底部面板与设置页那一行共用这一条路**。
   *
   * 为什么不让面板自己写一套：开关有两个必须一起动的东西（DOM 复选框 + 落盘 + 能力快照），
   * 分开写迟早会出现"面板里显示开着、设置页显示关着"。
   *
   * ⚠ 顺序是这里的关键，踩过一次坑（2026-09-16，表现为"库里还是关着、按钮还写着开启角色语音"）：
   *   `saveAll()` 会**先落盘再 refresh()**，而 refresh() 是拿库里的值回写 DOM 复选框的。
   *   如果只改复选框就调 saveAll，saveAll 读的是**改之前**那一遍 DOM —— 落盘的还是旧值，
   *   紧接着 refresh 又把复选框按旧值改回去，等于整件事被无声地回滚。
   *   所以这里：① 先只写开关这一项到库里（不让任何别的东西被覆盖）；
   *   ② 再改复选框；③ 最后才走 saveAll（此时它读到的 DOM 与库已经一致）。
   */
  async function setVoiceEnabled(next, options) {
    const Cloud = global.RoleWorldVoiceCloud;
    const adapter = global.RoleWorld;
    const want = next !== false;
    const opts = options || {};
    await adapter.saveLocalSettings({ voice_enabled: want }).catch(() => {});
    let settings = await adapter.getLocalSettings().catch(() => ({}));
    if (!settings || settings.voice_enabled !== want) {
      // 连库都没写进去：**不能假装开好了**（文档 §7：保存失败不显示开启成功）。
      pick("voice-enabled").forEach((node) => { node.checked = !want; });
      applyVoiceCapability();
      return { error: "设置没保存上，请再试一次。" };
    }
    pick("voice-enabled").forEach((node) => { node.checked = want; });
    /**
     * ⚠ `saveAll()` 会把它读到的那一份设置**整份写回去**（provider / endpoint / model /
     * card_relay 都在里面）。而"贴完体验卡 → 开语音"这条路里，saveAll 读到的是**贴卡之前**
     * 的 DOM：于是它把刚配好的 provider=custom、endpoint、card_relay 一起写成旧值。
     * 后果是语音能力探测当场变成"没有在用体验卡"——现象是"开关明明开了，
     * 按钮还写着开启角色语音、也发不出声"（2026-09-16 实测踩到，查了很久）。
     * 这里只守在**连接方式**那一组上：开语音不该动"用哪条通道"。
     */
    const beforeSave = await adapter.getLocalSettings().catch(() => ({}));
    // ⚠ `saveAll()` 只是"把这一屏表单整份写回去"，它**不该拖死"开启语音"**：
    //   `voice_enabled` 在上面早就落盘了，这里挂住只会让用户看到"一直正在开启"。
    //   给个上限，超时就当没做成（界面那一侧还有 12 秒的兜底）。
    await Promise.race([
      Promise.resolve().then(saveAll),
      new Promise((resolve) => global.setTimeout(resolve, 5000)),
    ]).catch(() => {});
    const afterSave = await adapter.getLocalSettings().catch(() => ({}));
    const restore = {};
    ["provider", "endpoint", "card_relay", "model"].forEach((key) => {
      const before = beforeSave ? beforeSave[key] : undefined;
      if (before === undefined || before === "") return;
      if (afterSave && afterSave[key] !== before) restore[key] = before;
    });
    if (Object.keys(restore).length) {
      await adapter.saveLocalSettings(restore).catch(() => {});
    }
    settings = await adapter.getLocalSettings().catch(() => settings);
    // ⚠ 快照里的中转地址一定要补齐：这份快照是**同步**读的（入口文字、消息菜单都靠它），
    //   而它平时由设置页整份写入。拿到的若是一份**没带 card_relay** 的对象就覆盖上去，
    //   等于"语音能力探测还在用卡，界面却以为没有卡"——现象正是
    //   "开了语音，按钮还写着开启角色语音、也发不出声"。
    //   ① 先问 adapter 要真值（它读的就是探测用的那份卡状态）；② 问不到就沿用上一份快照。
    if (Cloud && typeof Cloud.credentials === "function") {
      try {
        const cred = await Promise.race([
          Cloud.credentials(),
          new Promise((resolve) => global.setTimeout(() => resolve(null), 5000)),
        ]);
        if (cred && cred.relay) settings = Object.assign({}, settings, { card_relay: cred.relay });
      } catch (_) { /* 读不到就按库里的值 */ }
    }
    if (!settings.card_relay) {
      const previous = global.__rwVoiceSettingsSnapshot || {};
      if (previous.card_relay) settings = Object.assign({}, settings, { card_relay: previous.card_relay });
    }
    if (Cloud) {
      Cloud.noteSettings(settings);
      if (want) Cloud.refresh({ force: opts.forceRefresh === true }).catch(() => {});
      else Cloud.stop();
    }
    applyVoiceCapability();
    return settings;
  }

  /** 开关一改：先把同意问清楚，再落盘，再让能力快照跟上。 */
  async function onVoiceToggle(node) {
    if (node.checked) {
      const agreed = await confirmVoiceConsent();
      if (!agreed) {
        node.checked = false;
        return;
      }
      await setVoiceEnabled(true);
      return;
    }
    await setVoiceEnabled(false);
  }

  function bind() {
    injectStyle();
    arrangeSettingsNav();
    // 「角色语音」那一行的小字是**状态**（能不能用、为什么不能用），不是解释：留着别折叠。
    const voiceRowKeep = document.getElementById("voiceEnabledRow");
    if (voiceRowKeep) voiceRowKeep.classList.add("rw-keep-note");
    collapseSettingsNotes();
    applyVoiceCapability();
    // 能力探测回来 / 换了卡 / 改了开关：重新画这一行与说明文字。
    global.addEventListener("roleworld:voice-changed", () => applyVoiceCapability());
    // 开关本身：先问一次同意（承诺边界变了，必须显式同意），再落盘。
    pick("voice-enabled").forEach((node) => node.addEventListener("change", () => { onVoiceToggle(node).catch(() => {}); }));
    pick("speech-input").forEach((node) => node.addEventListener("change", () => {
      const Cloud = global.RoleWorldVoiceCloud;
      if (Cloud) Cloud.noteSettings(Object.assign({}, global.__rwVoiceSettingsSnapshot || {}, { speech_input_enabled: node.checked === true }));
    }));
    pick("save").forEach((node) => node.addEventListener("click", () => { saveAll(); }));
    pick("key-save").forEach((node) => node.addEventListener("click", () => { saveKey(); }));
    pick("key-delete").forEach((node) => node.addEventListener("click", () => { deleteKey(); }));
    pick("test").forEach((node) => node.addEventListener("click", () => { testConnection(); }));
    pick("provider").forEach((node) => node.addEventListener("change", () => { refresh(); }));
    // 连接方式：单选按钮 = 真的切过去（不只是显示），另有一个显式按钮做同样的事。
    pick("connection-key").forEach((node) => node.addEventListener("change", () => { if (node.checked) switchToOwnKey(); }));
    pick("connection-card").forEach((node) => node.addEventListener("change", () => { if (node.checked) switchToCard(); }));
    pick("connection-key-mode").forEach((node) => node.addEventListener("click", () => { switchToOwnKey(); }));
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
    // 角色语言是即时开关：改完之后下一轮就按新语言走（单角色的覆盖在顶栏与「角色管理」里）。
    pick("language-mode").forEach((node) => node.addEventListener("change", () => {
      const value = node.value === "zh" || node.value === "en" ? node.value : "auto";
      notify({ language_mode: value });
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
    pick("card-use").forEach((node) => node.addEventListener("click", () => {
      useCard().catch((error) => {
        console.error("useCard failed:", error && error.message);
        reportCardError();
      });
    }));
    // 「检查更新」：让等待中的离线壳接管再刷新（和顶部那个更新提示是同一件事）。
    pick("force-update").forEach((node) => node.addEventListener("click", async () => {
      await refreshVersion();
      try {
        if (global.ROLEWORLD_PWA && typeof global.ROLEWORLD_PWA.reloadForUpdate === "function") {
          await global.ROLEWORLD_PWA.reloadForUpdate();
          return;
        }
      } catch (_) { /* 下面兜底 */ }
      global.location.reload();
    }));
    pick("card-check").forEach((node) => node.addEventListener("click", () => { checkCardQuota().catch(() => {}); }));
    pick("card").forEach((node) => node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        useCard().catch((error) => {
          console.error("useCard failed:", error && error.message);
          reportCardError();
        });
      }
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

  // applyVoiceCapability 也导出：集成层在"切到设置某一页"时会调一次，
  // 用来兜住"探测先跑完、监听后挂上"那种时序（否则「角色语音」那一行会永远不出现）。
  // confirmVoiceConsent / setVoiceEnabled 也导出：聊天页的「开启角色语音」底部面板走的是
  // **同一份**同意记录与同一套开关落盘，不另写第二份（两份实现迟早会不一致）。
  global.RoleWorldSettingsUI = {
    refresh,
    saveAll,
    testConnection,
    useCard,
    checkCardQuota,
    applyVoiceCapability,
    collapseSettingsNotes,
    confirmVoiceConsent,
    setVoiceEnabled,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
