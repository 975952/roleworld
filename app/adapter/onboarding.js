"use strict";

/*
 * adapter/onboarding.js —— 首次启动引导
 *
 * 三条硬性要求（用户反馈）：
 *   1. 第一遍必须走完，不给「跳过」；
 *   2. 第二步**直接就是填 API Key 的地方**，不用自己去找设置；
 *   3. 配色自己带，不继承页面变量 —— 之前继承导致黑字压在深色背景上完全看不见。
 *
 * 2026-09-11 新增「怎么称呼你」这一步（用户要求：第一次登录让用户填自己的名字/称呼，
 * 以后在设置里能改）。存进本账号的外观偏好 preferences.nickname，角色与剧情模式都用它。
 *
 * 触发条件：本机设置里 tutorial_seen 不是 true 才弹。已经配好 Key 的老用户不会被打扰
 * （配好 Key 即视为走过流程）。想再看一次：设置 → 关于 →「再看一次教程」。
 */

(function (global) {
  const STYLE_ID = "roleworld-onboarding-style";
  const SEEN_KEY = "tutorial_seen";
  // 用体验卡进来的人走**另一套开场**（不问 API Key），单独记一个标记：
  // 他们已经可能是"tutorial_seen 已为 true"的老同学，不能用同一个标记。
  const CARD_SEEN_KEY = "card_welcome_seen";
  const NICKNAME_KEY = "nickname";
  const NICKNAME_FALLBACK = "我";

  // 两套步骤：自己配 Key 的是原来那套；拿体验卡的是"卡说明 → 称呼 → 语言 → 功能 → 开始"。
  // 中间那步「这里能做什么」两边共用（用户 2026-09-12：「第一次进的时候也要介绍网站的功能吧」）。
  const FULL_STEPS = ["welcome", "name", "key", "features", "ready"];
  const CARD_STEPS = ["card-welcome", "name", "language", "features", "card-ready"];

  let overlay = null;
  let index = 0;
  let busy = false;
  let nickname = "";
  let mode = "full";
  let cardQuota = null;

  function steps() {
    return mode === "card" ? CARD_STEPS : FULL_STEPS;
  }

  /** 卡还能用多少 → 一句话（"剩 4 次 · 到期 2026-10-12" / "次数已用完"）。 */
  function quotaLine() {
    const card = global.RoleWorldCard;
    if (!cardQuota) return "";
    if (card && typeof card.formatQuota === "function") return card.formatQuota(cardQuota);
    return "";
  }

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
.rw-ob-check{display:flex;gap:8px;align-items:center;margin:14px 0 0;font-size:14px;color:var(--rw-fg);cursor:pointer;}
.rw-ob-check input{width:16px;height:16px;accent-color:var(--rw-accent);}
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

  /** 卡片内容是**拼好的 HTML**（<p>/<label>/<input> 都在里面），不能整段 escape，
   *  所以只把文本里的强调标记转成标签：自己的标签里不会出现 ** 或反引号，替换是安全的。
   *  （以前 format() 根本没被调用过 —— 引导里一直字面显示 `**称呼**`，2026-09-12 顺手修掉。） */
  function renderMarkdown(html) {
    return String(html)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  /* ------------------------------------------------------------------ *
   * 内容
   * ------------------------------------------------------------------ */

  function stepHtml(step) {
    // ---- 体验卡开场（0.1.29）----
    // 用户 2026-09-12：「通过卡进入的应该也要有个正式的开始的步骤」。
    // 以前带卡进来是**直接被扔进对话**：不知道卡是什么、还剩几次、到期没到期、
    // 角色为什么说英文、记录存在哪、用完了找谁。
    if (step === "card-welcome") {
      const line = quotaLine();
      const usable = !cardQuota || cardQuota.ok !== false;
      return [
        "<h2>你拿到了一张体验卡</h2>",
        "<p>这张卡是别人给你的：**不用填 API Key**，打开就能用。</p>",
        line ? "<p>额度：" + format(line) + (usable ? "" : "（已经不能用了，找发卡的人再要一张）") + "</p>"
          : "<p>剩余次数随时看右上角那个「体验卡」小标签。</p>",
        "<p>卡的次数用完或到期就会停，到时候找发卡的人再要一张就行。</p>",
        "<p>你的**聊天记录只存在这台设备上**：别人搭的中转只统计「用了多少次」，看不到你聊了什么。</p>",
      ].join("");
    }
    if (step === "language") {
      return [
        "<h2>角色说什么语言？</h2>",
        "<p>内置角色卡是英文的，所以默认他们**说英文**。</p>",
        "<p>看不懂英文就勾上下面这个：所有角色都改说简体中文。</p>",
        '<label class="rw-ob-check"><input type="checkbox" data-ob="language-zh"> 让角色一律说简体中文（看不懂英文就勾上）</label>',
        '<p class="rw-ob-hint">以后想改：**设置 → 模型 → 角色语言**；只想让某一个角色说中文，用对话页顶栏的「语言」下拉。</p>',
      ].join("");
    }
    if (step === "features") {
      // 第一次进来的人（不管是用卡还是自己配 Key）都该知道"这里能干什么、东西在哪"。
      // 每条都尽量写成"能做什么 + 去哪里找"，别写成说明书。
      return [
        "<h2>这里能做什么</h2>",
        "<p><strong>跟角色聊天</strong>：内置 6 个角色（哈利、赫敏、罗恩、金妮、卢娜、汤姆·里德尔），左侧点一下就换人。也能**让 AI 照你的描述新建角色**，或导入别人给的角色卡。</p>",
        "<p><strong>他们记得你</strong>：每个角色有自己的一本记忆，跨对话保留；记忆可以随时查看、改、删，还能看到它是从哪句话来的。</p>",
        "<p><strong>剧情模式</strong>：想让好几个角色同时在同一个场景里，用左侧的「剧情模式」。</p>",
        "<p><strong>伴侣模式</strong>（可选）：给某个角色写一份关系档案（关系、称呼、共同经历），它会照这个来；里面有「不许用内疚留人」这类硬规矩。</p>",
        "<p><strong>语言</strong>：内置角色卡是英文的，所以默认说英文；想一律中文在**设置 → 模型 → 角色语言**里改，也可以只给某一个角色改（对话页顶栏的「语言」）。</p>",
        "<p><strong>花的钱看得见</strong>：每轮显示 token 用量和费用估算；「本次请求」能看到这一轮到底发了什么。</p>",
        "<p><strong>数据只在这台设备上</strong>：没有账号、不上传；换电脑用**设置 → 关于 → 导出存档**。</p>",
      ].join("");
    }
    if (step === "card-ready") {
      const line = quotaLine();
      return [
        "<h2>可以开始了</h2>",
        "<p>左侧是角色（内置 6 个），点一个直接打字就能聊。</p>",
        "<p>**每个角色有自己的记忆**，跨对话保留；这些记录只存在这台设备上。</p>",
        line ? "<p>你的体验卡：" + format(line) + "。用完或想再要一张，找发卡的人。</p>" : "",
        "<p>想用自己的 API Key 也可以：**设置 → 模型** 里填上就换成你自己的额度。</p>",
      ].join("");
    }
    if (step === "welcome") {
      return [
        "<h2>欢迎使用角色世界</h2>",
        "<p>这是一个本地优先的角色对话应用：没有账号、没有遥测。</p>",
        "<p>角色卡、对话记录、记忆书、API Key 全部只存在这台设备上；发送给模型的内容只会到达你选定的云端服务。</p>",
        "<p>代价只有一条：没人替你备份，换电脑前记得自己导出。</p>",
        "<p>接下来两步：先写一个**称呼**，再填模型接口的 **API Key**（可以先准备好）。</p>",
        // 语言：**默认不勾** —— 角色按自己角色卡的语言说话（默认行为）。
        // 看不懂英文的人勾一下就一律中文，勾的当下就生效（设置里随时能改）。
        '<label class="rw-ob-check"><input type="checkbox" data-ob="language-zh"> 全中文：角色一律说简体中文（看不懂英文就勾上）</label>',
        '<p class="rw-ob-hint">不勾就跟着角色卡自己的语言：内置的英文角色说英文，中文角色说中文。</p>',
      ].join("");
    }
    if (step === "name") {
      return [
        "<h2>怎么称呼你？</h2>",
        "<p>角色会用这个名字称呼你，剧情模式里也显示它。**只存在这台设备上**，随时能改。</p>",
        '<div class="rw-ob-field"><input type="text" data-ob="nickname" maxlength="24" autocomplete="off" spellcheck="false" placeholder="比如：小林、阿远、Wenbo" aria-label="你的称呼"></div>',
        '<p class="rw-ob-hint">想不出就先留着默认的「我」，之后在**设置 → 关于 → 称呼**里改。</p>',
      ].join("");
    }
    if (step === "key") {
      return [
        "<h2>填入你的 API Key，或用体验卡</h2>",
        "<p>用自己的 API Key 就是**直连**你选的服务商；用体验卡则经过发卡人搭的中转。Key 只保存在本机。</p>",
        // 正在用体验卡的人（点「再看一次教程」会走到这一步）先给一句说明，
        // 免得他对着下面那个中转地址和一栏空的 Key 发懵（用户 2026-09-13 实测反馈）。
        '<p class="rw-ob-status" data-ob="key-note"></p>',
        '<div class="rw-ob-field"><select data-ob="provider" aria-label="服务商">',
        '<option value="deepseek">DeepSeek 官方</option>',
        '<option value="openai">OpenAI</option>',
        '<option value="openrouter">OpenRouter</option>',
        '<option value="siliconflow">硅基流动</option>',
        '<option value="custom">自定义云端服务</option>',
        "</select>",
        // autocomplete="new-password"：这一栏是密钥，不是登录密码。
        // 写成 "off" 时浏览器（尤其是之前在这一栏存过密码的 Chrome）照样会把旧值自动填回来 ——
        // 用户 2026-09-13 报的「apikey 好像会自动填上那个卡啥的」就是这么来的：
        // 他早先把卡号粘在这一栏过，浏览器把它当密码存下来了。
        // new-password 是浏览器约定的"别自动填"，另外三个 data-* 是给密码管理器看的。
        '<input type="password" data-ob="key" placeholder="粘贴 API Key（sk-…）" autocomplete="new-password"'
          + ' data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellcheck="false" maxlength="200" aria-label="API Key">',
        "</div>",
        '<div class="rw-ob-field"><input type="text" data-ob="endpoint" placeholder="接口地址（留空用服务商默认）" spellcheck="false" autocomplete="off" aria-label="接口地址"></div>',
        '<p class="rw-ob-status" data-ob="status"></p>',
        '<p class="rw-ob-hint">自定义服务需要填写支持跨域访问的 HTTPS 接口地址和对应 API Key。</p>',
        // 2026-09-12：**别人给你体验卡**也要能在这一步进门。
        // 以前这里只有 API Key 一条路：发卡链接被聊天软件截掉、或者同学自己打开首页（地址里没带卡），
        // 就会看到"必须输 API Key"，看起来像进不去（用户实测反馈："为什么我登的时候还是要输 apikey"）。
        '<p class="rw-ob-hint">有人给你<b>体验卡</b>？不用 API Key —— 把他给的<b>卡号那一整行</b>'
          + '（形如 <code>RW-XXXXX-XXXXX-XXXXX@中转地址</code>，或者他发的那条整链接）粘在下面，点「用体验卡」。</p>',
        '<div class="rw-ob-field"><input type="text" data-ob="card" placeholder="RW-XXXXX-XXXXX-XXXXX@https://…" spellcheck="false" autocomplete="off" maxlength="400" aria-label="体验卡号或体验卡链接">',
        '<button type="button" data-ob="card-use">用体验卡</button></div>',
        '<p class="rw-ob-status" data-ob="card-status"></p>',
      ].join("");
    }
    return [
      "<h2>准备就绪</h2>",
      "<p>已经装好 **6 个角色**和他们的记忆书，直接开始聊就行。</p>",
      "<p>桌面版数据在 `%APPDATA%\\app.roleworld.desktop\\data\\`，都是普通文件；换电脑用「设置 → 关于 → 导出存档」。</p>",
      "<p>想换模型、调界面大小、管记忆书，都在**设置**里。</p>",
    ].join("");
  }

  function actionsHtml(step) {
    const last = index === steps().length - 1;
    const dots = steps().map((_, i) => `<i class="${i === index ? "is-on" : ""}"></i>`).join("");
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
   * 称呼：写进本账号的外观偏好（preferences.nickname）
   * ------------------------------------------------------------------ */

  function nicknameStorageKey() {
    try {
      const handle = global.sessionStorage.getItem("task27a.current-account-handle.v1") || "";
      return handle ? `task27a.preferences.v1.${handle}` : "";
    } catch (_) {
      return "";
    }
  }

  function readSavedNickname() {
    try {
      const ui = global.TASK25C_UI;
      if (ui && typeof ui.nickname === "function") return ui.nickname() || "";
    } catch (_) { /* 下面还有 localStorage 兜底 */ }
    try {
      const key = nicknameStorageKey();
      if (!key) return "";
      const prefs = JSON.parse(global.localStorage.getItem(key) || "null");
      return prefs && typeof prefs.nickname === "string" ? prefs.nickname : "";
    } catch (_) {
      return "";
    }
  }

  function cleanNickname(value) {
    const cleaned = String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 24);
    return cleaned || NICKNAME_FALLBACK;
  }

  async function saveNickname(value) {
    nickname = cleanNickname(value);
    try {
      const ui = global.TASK25C_UI;
      if (ui && typeof ui.savePreference === "function") {
        ui.savePreference(NICKNAME_KEY, nickname);
        return;
      }
    } catch (_) { /* 落到下面的直写 */ }
    try {
      const key = nicknameStorageKey();
      if (!key) return;
      const prefs = JSON.parse(global.localStorage.getItem(key) || "null") || {};
      prefs.nickname = nickname;
      global.localStorage.setItem(key, JSON.stringify(prefs));
    } catch (_) { /* 存不下不影响使用 */ }
  }

  function prefillNicknameStep(input) {
    if (!input) return;
    const saved = readSavedNickname();
    nickname = saved || NICKNAME_FALLBACK;
    input.value = nickname;
    try { input.focus({ preventScroll: true }); input.select(); } catch (_) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ *
   * 渲染与交互
   * ------------------------------------------------------------------ */

  function render() {
    const step = steps()[index];
    overlay.innerHTML = `<div class="rw-ob-card" role="dialog" aria-modal="true">${renderMarkdown(stepHtml(step))}${actionsHtml(step)}</div>`;
    overlay.querySelector('[data-ob="prev"]').addEventListener("click", () => {
      if (index > 0) { index -= 1; render(); }
    });
    overlay.querySelector('[data-ob="next"]').addEventListener("click", onNext);
    const saveButton = overlay.querySelector('[data-ob="save"]');
    if (saveButton) saveButton.addEventListener("click", onSaveKey);
    const provider = overlay.querySelector('[data-ob="provider"]');
    if (provider) provider.addEventListener("change", () => { syncKeyFields(); setStatus(""); });
    // 「全中文」勾一下就立刻生效（不等走完引导）——有人就是看不懂英文才需要它。
    const chinese = overlay.querySelector('[data-ob="language-zh"]');
    if (chinese) {
      chinese.addEventListener("change", async () => {
        try {
          await global.RoleWorld.saveLocalSettings({ language_mode: chinese.checked === true ? "zh" : "auto" });
          notifySettings();
        } catch (_) { /* 存不下不影响继续 */ }
      });
    }
    syncKeyFields();
    if (step === "key") {
      prefillKeyStep();
      const cardButton = overlay.querySelector('[data-ob="card-use"]');
      if (cardButton) cardButton.addEventListener("click", () => { useCardInOnboarding().catch(() => {}); });
      const cardInput = overlay.querySelector('[data-ob="card"]');
      if (cardInput) {
        cardInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); useCardInOnboarding().catch(() => {}); }
        });
      }
    }
    if (step === "name") {
      const input = overlay.querySelector('[data-ob="nickname"]');
      prefillNicknameStep(input);
      if (input) {
        // 回车=下一步（和填 Key 那一步的直觉一致）
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); onNext(); }
        });
      }
    }
  }

  // 把已有的服务商 / 接口地址带出来，别让「保存并测试」把用户先前的配置冲掉。
  async function prefillKeyStep() {
    try {
      const settings = await global.RoleWorld.getLocalSettings();
      const provider = overlay && overlay.querySelector('[data-ob="provider"]');
      const endpoint = overlay && overlay.querySelector('[data-ob="endpoint"]');
      const keyInput = overlay && overlay.querySelector('[data-ob="key"]');
      if (provider && settings.provider) provider.value = settings.provider;
      if (endpoint && settings.endpoint) endpoint.value = settings.endpoint;
      // 浏览器（或密码管理器）可能把"记住的密码"自动填进这一栏 —— 用户早先把卡号粘在这里过，
      // 之后每次进这一步都看到卡号被填回来（2026-09-13：「apikey 好像会自动填上那个卡啥的」）。
      // 只清掉"恰好等于本机已存的那个密钥"的值：用户自己刚粘进去、还没保存的 Key 不动。
      if (keyInput) {
        const providerName = (provider && provider.value) || settings.provider || "deepseek";
        const saved = await global.RoleWorld.secrets.get(global.RoleWorldModel.secretKeyFor({ provider: providerName }));
        const savedValue = (saved && saved.value) || "";
        if (savedValue && keyInput.value === savedValue) keyInput.value = "";
      }
      syncKeyFields();
      await showKeyNote();
    } catch (_) { /* 用默认值即可 */ }
  }

  /** 正在用体验卡的人走到这一步时，先说清楚"这栏不用填"。 */
  async function showKeyNote() {
    const node = overlay && overlay.querySelector('[data-ob="key-note"]');
    if (!node) return;
    node.textContent = "";
    node.classList.remove("is-ok", "is-bad");
    try {
      const state = global.RoleWorldCard && global.RoleWorldCard.currentState
        ? await global.RoleWorldCard.currentState() : null;
      if (!state || !state.active) return;
      const quota = global.RoleWorldCard.formatQuota ? global.RoleWorldCard.formatQuota(state.quota) : "";
      node.textContent = "你现在用的是体验卡" + (quota ? "（" + quota + "）" : "")
        + "，这一步不用填 API Key —— 直接点「下一步」就行。"
        + "下面那栏地址就是这张卡走的中转地址，不用改；想换回自己的 Key，就在上面那一栏粘你的 Key。";
      node.classList.add("is-ok");
    } catch (_) { /* 说明文字失败不影响流程 */ }
  }

  function syncKeyFields() {
    const provider = overlay.querySelector('[data-ob="provider"]');
    const keyInput = overlay.querySelector('[data-ob="key"]');
    const endpoint = overlay.querySelector('[data-ob="endpoint"]');
    if (!provider || !keyInput || !endpoint) return;
    const isCustom = provider.value === "custom";
    keyInput.disabled = false;
    keyInput.placeholder = "粘贴 API Key（sk-…）";
    endpoint.placeholder = isCustom ? "https://你的服务/v1/chat/completions" : "接口地址（留空用服务商默认）";
  }

  function setStatus(text, kind) {
    const node = overlay && overlay.querySelector('[data-ob="status"]');
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("is-ok", kind === "ok");
    node.classList.toggle("is-bad", kind === "bad");
  }

  function setCardStatus(text, kind) {
    const node = overlay && overlay.querySelector('[data-ob="card-status"]');
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("is-ok", kind === "ok");
    node.classList.toggle("is-bad", kind === "bad");
  }

  /** 引导里用体验卡：配好接口地址 + 把卡号存进密钥位 —— 之后 keyReady() 就认它，不再要求 API Key。
   *  卡号只在这台设备上落盘，和「设置 → 模型 → 体验卡」那一行走的是同一个 apply()。 */
  async function useCardInOnboarding() {
    if (busy) return;
    const card = global.RoleWorldCard;
    const input = overlay && overlay.querySelector('[data-ob="card"]');
    const raw = input ? String(input.value || "").trim() : "";
    if (!card || typeof card.apply !== "function") { setCardStatus("这个版本不支持体验卡，请填 API Key。", "bad"); return; }
    if (!raw) { setCardStatus("先粘贴卡号（或者发卡人给你的那条链接）。", "bad"); return; }
    busy = true;
    setCardStatus("正在配置…", null);
    try {
      const result = await card.apply(raw);
      if (!result.ok) { setCardStatus(result.message || "这张卡没用上。", "bad"); return; }
      if (input) input.value = "";
      // 「保存并测试」那一行留着的 Key 不该再把卡顶掉：清掉输入框。
      const keyInput = overlay.querySelector('[data-ob="key"]');
      if (keyInput) keyInput.value = "";
      setCardStatus("体验卡已配好：" + (result.message || "") + " 点「下一步」继续。", "ok");
    } catch (error) {
      setCardStatus("这张卡没用上：" + String((error && error.message) || error).slice(0, 120), "bad");
    } finally {
      busy = false;
      notifySettings();
    }
  }

  async function onSaveKey() {
    if (busy) return;
    const adapter = global.RoleWorld;
    const provider = overlay.querySelector('[data-ob="provider"]').value;
    const keyInput = overlay.querySelector('[data-ob="key"]');
    const endpoint = overlay.querySelector('[data-ob="endpoint"]').value.trim();
    const key = keyInput ? keyInput.value.trim() : "";
    // 粘进来的其实是体验卡号？那就别往密钥位里写 —— 写进去等于把卡号当 API Key 用，
    // 下一轮请求必然 401（用户 2026-09-12 就是这么踩的）。
    // 把那段文字挪到「体验卡」那一栏，并告诉他点哪个按钮。
    if (key && global.RoleWorldCard && typeof global.RoleWorldCard.looksLikeCard === "function"
      && global.RoleWorldCard.looksLikeCard(key)) {
      const cardInput = overlay.querySelector('[data-ob="card"]');
      if (cardInput) cardInput.value = key;
      if (keyInput) keyInput.value = "";
      setStatus("");
      setCardStatus("这看起来是体验卡号，不是 API Key。已经帮你放到下面的体验卡那一栏了 —— 点「用体验卡」。", "bad");
      return;
    }
    busy = true;
    try {
      await adapter.saveLocalSettings({ provider, endpoint });
      if (key) {
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
    const step = steps()[index];
    if (step === "name") {
      const input = overlay.querySelector('[data-ob="nickname"]');
      await saveNickname(input ? input.value : nickname);
    }
    if (step === "key" && !(await keyReady())) return;
    if (index < steps().length - 1) {
      index += 1;
      render();
      return;
    }
    await finish();
  }

  // 第二步必须有凭据：API Key，或者一张体验卡（卡号就存在密钥位里）。
  async function keyReady() {
    const adapter = global.RoleWorld;
    const currentCard = async () => (global.RoleWorldCard && typeof global.RoleWorldCard.currentState === "function"
      ? await global.RoleWorldCard.currentState() : null);
    const card = await currentCard();
    if (card && card.active) return true;
    // 卡号框里已经粘了东西、但还没点「用体验卡」就按了下一步 —— 顺手用掉它。
    // （同学的直觉就是"粘上、点下一步"，不该因为我们少做一步就把人挡回去。）
    const cardInput = overlay.querySelector('[data-ob="card"]');
    if (cardInput && String(cardInput.value || "").trim()) {
      await useCardInOnboarding();
      const after = await currentCard();
      if (after && after.active) return true;
    }
    const provider = overlay.querySelector('[data-ob="provider"]').value;
    const saved = await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider }));
    if (saved && saved.value) return true;
    setStatus("请先粘贴 API Key 并点「保存并测试」；有体验卡的话，把卡号粘在下面点「用体验卡」。", "bad");
    return false;
  }

  async function finish() {
    const chinese = overlay && overlay.querySelector('[data-ob="language-zh"]');
    const patch = { [SEEN_KEY]: true };
    // 卡用户也记上「开场看过了」——他走的是卡那套，不该再被"填 Key"那套拦一次。
    if (mode === "card") patch[CARD_SEEN_KEY] = true;
    if (chinese) patch.language_mode = chinese.checked === true ? "zh" : "auto";
    close();
    try {
      // 自己配 Key 的路上顺手用了体验卡（引导第二步那个入口）：卡说明他已经看过，
      // 别再在下一次启动时弹一遍卡开场。
      if (!patch[CARD_SEEN_KEY] && global.RoleWorldCard && typeof global.RoleWorldCard.currentState === "function") {
        const card = await global.RoleWorldCard.currentState();
        if (card && card.active) patch[CARD_SEEN_KEY] = true;
      }
    } catch (_) { /* 判断失败就按没看过处理 */ }
    try {
      await global.RoleWorld.saveLocalSettings(patch);
    } catch (_) { /* 存不下也不能卡住用户 */ }
    notifySettings();
    global.dispatchEvent(new global.CustomEvent("roleworld:nickname-changed", { detail: { nickname } }));
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

  /** 打开引导。which = "card" 时是体验卡开场（不问 Key）；默认/其他值是原来那套完整引导
   *  （「设置 → 关于 → 再看一次教程」走的也是这一套）。 */
  function show(which) {
    if (overlay) return;
    mode = which === "card" ? "card" : "full";
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
      // 打开的是「体验卡链接」：先把卡配好，再判断要不要引导 ——
      // 否则同学点开链接还是会被要求填 API Key（2026-09-12 实测反馈）。
      if (global.RoleWorldCard && typeof global.RoleWorldCard.applyFromLocation === "function") {
        try { await global.RoleWorldCard.applyFromLocation(global.location && global.location.href); } catch (_) { /* 坏卡不挡启动 */ }
      }
      // ?onboarding=off 只跳过引导，方便先随便看看界面（不影响正式流程）。
      try {
        if (new URLSearchParams(global.location.search).get("onboarding") === "off") {
          await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true, [CARD_SEEN_KEY]: true });
          return false;
        }
      } catch (_) { /* 拿不到 URL 参数就照常走 */ }
      const settings = await global.RoleWorld.getLocalSettings();
      const card = global.RoleWorldCard && typeof global.RoleWorldCard.currentState === "function"
        ? await global.RoleWorldCard.currentState() : null;
      // ① 用体验卡进来的：走**体验卡开场**（说明卡与额度 / 称呼 / 语言 / 开始），绝不问 API Key。
      //    这一步必须排在下面几个"已看过就返回"的判断之前 —— 同学那边的 tutorial_seen
      //    在他第一次打开链接时就被置成 true 了（老版本为了不弹"填 Key"那套而记的），
      //    所以只能靠 card_welcome_seen 这个新标记来判断"开场看过没有"。
      if (card && card.active && settings[CARD_SEEN_KEY] !== true) {
        cardQuota = card.quota || null;
        if (!cardQuota && card.relay) {
          try { cardQuota = await global.RoleWorldCard.quota(card.relay, card.token); } catch (_) { cardQuota = null; }
        }
        show("card");
        return true;
      }
      if (settings[SEEN_KEY] === true) return false;
      // 已经配过 Key 的老用户（或导入过存档）不该被打扰，直接标记为已看。
      const saved = await global.RoleWorld.secrets.get(global.RoleWorldModel.secretKeyFor(settings));
      if (saved && saved.value) {
        await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true });
        return false;
      }
      // 用体验卡进来的（开场已经看过）：卡号就存在密钥位里，同样不该再问 Key。
      if (card && card.active) {
        await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true });
        return false;
      }
    } catch (_) {
      return false;
    }
    show("full");
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

  global.RoleWorldOnboarding = {
    show,
    maybeShow,
    // 当前这一套的步骤名（供测试与调试看）。
    steps: () => steps().slice(),
    CARD_SEEN_KEY,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
