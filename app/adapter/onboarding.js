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
  // 两条链在 `choose` 之后**殊途同归**：从卡链接进来的先看「卡说明」再二选一，
  // 自己打开网站的直接二选一；选完的那条路会自己把另一条的分支页摘掉（见 steps()）。
  const CARD_STEPS = ["card-welcome", "choose", "card-setup", "name", "language", "features", "card-ready"];
  // 2026-09-16：两条路都在**称呼之后问一次语言** —— 内置角色卡是英文的，看不懂英文的人
  // 需要在这一步就能选"一律中文"（以前只有卡那条路问，自己配 Key 的人要事后去设置里找）。
  const FULL_STEPS = ["welcome", "choose", "card-setup", "name", "language", "key", "features", "ready"];

  let overlay = null;
  let index = 0;
  let busy = false;
  let nickname = "";
  let mode = "full";
  let cardQuota = null;
  // 2026-09-16：第一步二选一的结果 —— "card"（朋友给了体验卡）或 "key"（用自己的 Key）。
  // 空串 = 还没选（第一次打开时就是这个状态）。
  let way = "";

  function steps() {
    const base = mode === "card" ? CARD_STEPS : FULL_STEPS;
    // 二选一的**结果**决定后面走哪条：选了"自己的 Key"就把填卡页摘掉，选了"体验卡"就把填 Key 页摘掉。
    // （摘 == 不出现，而不是"跳过去"：跳过去会留下一个空页。）
    if (!way) return base;
    const drop = way === "key" ? "card-setup" : "key";
    return base.filter((name) => name !== drop);
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
.rw-ob-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
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
.rw-ob-status.is-ok{color:#3ecf8e;font-size:14px;font-weight:600;}
.rw-ob-status.is-bad{color:#ff7a7a;}
.rw-ob-hint{font-size:13px;color:var(--rw-muted);margin:10px 0 0;}
.rw-ob-check{display:flex;gap:8px;align-items:center;margin:14px 0 0;font-size:14px;color:var(--rw-fg);cursor:pointer;}
.rw-ob-check input{width:16px;height:16px;accent-color:var(--rw-accent);}
/* 二选一的两张大按钮（2026-09-16）：要一眼看出是"两个选项"，不是一段说明文字 */
.rw-ob-choice{display:flex;flex-direction:column;gap:10px;margin:16px 0 6px;}
.rw-ob button.rw-ob-choice-btn{display:block;width:100%;text-align:left;padding:14px 16px;border-radius:12px;
  border:1px solid var(--rw-line);background:transparent;color:var(--rw-fg);line-height:1.6;cursor:pointer;}
.rw-ob button.rw-ob-choice-btn:hover{border-color:var(--rw-accent);background:rgba(127,127,127,.08);}
.rw-ob button.rw-ob-choice-btn.is-current{border-color:var(--rw-accent);}
.rw-ob button.rw-ob-choice-btn b{display:block;font-size:15px;margin-bottom:2px;color:var(--rw-fg);}
.rw-ob button.rw-ob-choice-btn span{display:block;font-size:13px;color:var(--rw-muted);}
.rw-ob-details{margin:12px 0 0;font-size:13px;color:var(--rw-muted);}
.rw-ob-details summary{cursor:pointer;color:var(--rw-fg);}
.rw-ob-details p{margin:8px 0 0;}
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
    if (step === "choose") {
      // 二选一：**普通人第一次打开网站看到的第一件事**（用户 2026-09-16 要求）。
      // 写法上刻意做到三件事：① 用大白话说"你手上有什么"；② 两个大按钮直接点；
      // ③ 选哪个都不用自己去设置里翻。
      return [
        "<h2>你手上有什么？</h2>",
        "<p>二选一，点一下就行 —— 选完才填对应的那一项，不用自己去找设置。</p>",
        '<div class="rw-ob-choice">',
        '<button type="button" class="rw-ob-choice-btn" data-ob="way" data-way="card">',
        "<b>有人给了我一张体验卡</b>",
        "<span>打开就能用，不用 API Key、不用付钱</span>",
        "卡号形如 <code>RW-XXXXX-XXXXX-XXXXX</code>，由发卡的人给你",
        "</button>",
        '<button type="button" class="rw-ob-choice-btn" data-ob="way" data-way="key">',
        "<b>我自己有 API Key</b>",
        "<span>直连你自己的服务商（DeepSeek / OpenAI 等），花自己的额度</span>",
        "在服务商官网申请，形如 <code>sk-…</code>",
        "</button>",
        "</div>",
        "<p class=\"rw-ob-hint\">不确定？只要有卡号就选第一个；两个都没有就先选第一个，进去也能随时改成第二种"
          + "（设置 → 连接方式）。</p>",
      ].join("");
    }
    if (step === "card-setup") {
      // 拆成两栏填：普通人手里只有"卡号"，中转地址是应用该自己填的。
      // 以前要求"把卡号@地址那一整行粘进来"——对没干过这事的人是纯门槛（用户 2026-09-16 反馈）。
      return [
        "<h2>把体验卡填进来</h2>",
        "<p>发卡的人给了你一个<b>卡号</b>（形如 <code>RW-XXXXX-XXXXX-XXXXX</code>）。把它粘在下面第一栏。</p>",
        '<div class="rw-ob-field"><input type="text" data-ob="card-token" placeholder="卡号：RW-XXXXX-XXXXX-XXXXX"'
          + ' autocomplete="off" spellcheck="false" maxlength="120" aria-label="体验卡号"></div>',
        "<p>第二栏是<b>中转地址</b>：发卡的人一般会连同卡号一起给你一段网址。填过一次就会记住，下次不用再填。</p>",
        '<div class="rw-ob-field"><input type="text" data-ob="card-relay" placeholder="中转地址：https://…"'
          + ' autocomplete="off" spellcheck="false" maxlength="300" aria-label="中转地址"></div>',
        '<div class="rw-ob-field"><button type="button" class="rw-ob-primary" data-ob="card-use">用这张卡</button></div>',
        '<p class="rw-ob-status" data-ob="card-status"></p>',
        '<details class="rw-ob-details"><summary>发卡的人只给了我一段话 / 一条链接，怎么填？</summary>'
          + "<p>把那段话里 <code>RW-…</code> 开头的那串<b>粘进第一栏</b>，"
          + "把 <code>https://</code> 开头的那段网址<b>粘进第二栏</b>。"
          + "如果只给了你一条链接，点开它、或者按上面的办法拆开填都可以。</p></details>",
      ].join("");
    }
    if (step === "language") {
      return [
        "<h2>角色说什么语言？</h2>",
        "<p>内置角色卡是英文的，所以默认他们**说英文**。</p>",
        "<p>看不懂英文就勾上下面这个：所有角色都改说简体中文。</p>",
        '<label class="rw-ob-check"><input type="checkbox" data-ob="language-zh"> 让角色一律说简体中文（看不懂英文就勾上）</label>',
        '<p class="rw-ob-hint">以后想改：**设置 → 回复偏好 → 角色语言**；只想让某一个角色说中文，用对话页顶栏的「语言」下拉。</p>',
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
        "<p><strong>语言</strong>：内置角色卡是英文的，所以默认说英文；想一律中文在**设置 → 回复偏好 → 角色语言**里改，也可以只给某一个角色改（对话页顶栏的「语言」）。</p>",
        "<p><strong>花的钱看得见</strong>：每轮显示 token 用量和费用估算；「本次请求」能看到这一轮到底发了什么。</p>",
        "<p><strong>数据只在这台设备上</strong>：没有账号、不上传；换电脑用**设置 → 数据与备份 → 导出存档**。</p>",
        "<p class=\"rw-ob-hint\">设置里**常用就那几页**（连接方式 / 语音 / 回复偏好 / 外观与布局 / 数据与备份），"
          + "其余收在下面的「更多设置」里，用到再展开。</p>",
      ].join("");
    }
    if (step === "card-ready") {
      const line = quotaLine();
      return [
        "<h2>可以开始了</h2>",
        "<p>左侧是角色（内置 6 个），点一个直接打字就能聊。</p>",
        "<p>**每个角色有自己的记忆**，跨对话保留；这些记录只存在这台设备上。</p>",
        line ? "<p>你的体验卡：" + format(line) + "。用完或想再要一张，找发卡的人。</p>" : "",
        "<p>想用自己的 API Key 也可以：**设置 → 连接方式** 里换成「自己配置 API」就行。</p>",
        "<p>以后想再看一遍这份说明：**设置 → 更多设置 → 关于 → 再看一次教程**。</p>",
      ].join("");
    }
    if (step === "welcome") {
      return [
        "<h2>欢迎使用角色世界</h2>",
        "<p>这是一个本地优先的角色对话应用：没有账号、没有遥测。</p>",
        "<p>角色卡、对话记录、记忆书、API Key 全部只存在这台设备上；发送给模型的内容只会到达你选定的云端服务。</p>",
        "<p>代价只有一条：没人替你备份，换电脑前记得自己导出。</p>",
        "<p>下一步先问你一句：**你手上有什么**（体验卡 / 自己的 API Key）—— 选完才填对应的那一项。</p>",
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
        "<h2>填入你的 API Key</h2>",
        "<p>你选的是「自己配置 API」：Key 只保存在本机，请求直连你选的服务商（不经过我们的中转）。</p>",
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
        '<p class="rw-ob-hint">只有选「自定义云端服务」时才需要填接口地址。Key 只保存在这台设备上。</p>',
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
    // 二选一那一页**不给「下一步」**：那一页的按钮本身就是下一步（点了才知道去哪儿），
    // 留一个灰色的「下一步」只会让人犹豫该点哪个（用户 2026-09-16 的诉求：步骤要简单明了）。
    const primary = step === "choose"
      ? ""
      : `<button type="button" class="rw-ob-primary" data-ob="next">${last ? "开始使用" : "下一步"}</button>`;
    return `
      <div class="rw-ob-dots" aria-hidden="true">${dots}</div>
      <div class="rw-ob-actions">
        <button type="button" data-ob="prev" ${index === 0 ? "disabled" : ""}>上一步</button>
        ${skipHtml()}
        <span class="rw-ob-grow"></span>
        ${step === "key" ? '<button type="button" data-ob="save">保存并测试</button>' : ""}
        ${primary}
      </div>`;
  }

  /** 「先跳过，稍后设置」——**引导层永远存在的出口**。
   *
   *  为什么必须有（2026-09-17 用户实测原话：「你的设置做的根本点不动」）：
   *  这层引导铺满屏幕、底下什么都点不到；而它的按钮只有「上一步 / 本步的下一步」，
   *  Escape 又被 onKeydown 故意拦掉。于是**卡不可用、或者手上没有 Key 的人走不完也退不出** ——
   *  连「设置」都进不去，想自己把卡修好都修不了。这不是"步骤要简单"，这是把人关在里面。
   *
   *  行为：记上"看过了"（两套标记都记，免得下次启动又弹），然后关掉浮层。
   *  先落盘再关（与 finish() 同一个理由：浮层消失就是对外信号）。 */
  function skipHtml() {
    return '<button type="button" class="rw-ob-skip" data-ob="skip">先跳过，稍后设置</button>';
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

  /** 二选一的处理：选定"card"（体验卡）或"key"（自己的 Key），并往前翻一页。
   *  抽成具名函数有两个用处：① 点击处理就是它；② 自动化可以用 `RoleWorldOnboarding.route()`
   *  **确定性地**设定路线，不必靠"盲点下一步、猜自己在哪一页"（那样一改顺序就假红，本轮真踩过）。 */
  function chooseWay(next) {
    way = next === "key" ? "key" : "card";
    index += 1;
    render();
  }

  function render() {
    const step = steps()[index];
    overlay.innerHTML = `<div class="rw-ob-card" role="dialog" aria-modal="true">${renderMarkdown(stepHtml(step))}${actionsHtml(step)}</div>`;
    // 二选一那一页：把"当前正在用"的那一项标出来（选完就没这个标记了）。
    if (step === "choose" && way) {
      const current = overlay.querySelector(`[data-ob="way"][data-way="${way}"]`);
      if (current) current.classList.add("is-current");
    }
    // ⚠ 每一处都要先判空：二选一那一页**故意没有「下一步」**（选项本身就是下一步），
    //   原来这里无条件 addEventListener → TypeError → 整页画不过去、点了没反应
    //   （2026-09-16 实测：点「体验卡」之后标题一直停在"你手上有什么？"）。
    const prevButton = overlay.querySelector('[data-ob="prev"]');
    if (prevButton) {
      prevButton.addEventListener("click", () => {
        if (index > 0) { index -= 1; render(); }
      });
    }
    const nextButton = overlay.querySelector('[data-ob="next"]');
    if (nextButton) nextButton.addEventListener("click", onNext);
    const saveButton = overlay.querySelector('[data-ob="save"]');
    if (saveButton) saveButton.addEventListener("click", onSaveKey);
    // 「先跳过，稍后设置」：**每一步都有**，所以同样要先判空（同上）。
    const skipButton = overlay.querySelector('[data-ob="skip"]');
    if (skipButton) skipButton.addEventListener("click", () => { skipOnboarding().catch(() => {}); });
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
    if (step === "choose") {
      // 点哪张卡就走哪条路：选"体验卡"进填卡页，选"自己的 Key"进填 Key 页。
      // 这里只记下选择，步骤链由 `steps()` 按选择现算（摘掉另一条的分支页）。
      overlay.querySelectorAll('[data-ob="way"]').forEach((button) => {
        button.addEventListener("click", () => {
          chooseWay(button.dataset.way === "key" ? "key" : "card");
        });
      });
    }
    if (step === "card-setup") {
      const cardButton = overlay.querySelector('[data-ob="card-use"]');
      if (cardButton) cardButton.addEventListener("click", () => { useCardInOnboarding().catch(() => {}); });
      prefillCardSetup();
      ["card-token", "card-relay"].forEach((field) => {
        const input = overlay.querySelector(`[data-ob="${field}"]`);
        if (!input) return;
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); useCardInOnboarding().catch(() => {}); }
        });
      });
    }
    if (step === "key") {
      prefillKeyStep();
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
        + "想换回自己的 Key，就在下面那一栏粘你的 Key。";
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

  /** 填卡页的预填：卡号留在密钥位里（`api_key_custom`），中转地址留在 `card_relay`。
   *  已经配过卡的人再进这一页（"再看一次教程"）时不该两手空空。 */
  async function prefillCardSetup() {
    try {
      const adapter = global.RoleWorld;
      const settings = await adapter.getLocalSettings();
      const relayInput = overlay && overlay.querySelector('[data-ob="card-relay"]');
      if (relayInput && !relayInput.value && settings.card_relay) relayInput.value = settings.card_relay;
      // 卡号**不回填**：卡号是凭据，回填等于把它摆在屏幕上（用户可能正在投屏/截图）。
      // 已经在用卡的话，状态行里会说清楚"已经在用卡了"，不用再填。
    } catch (_) { /* 预填失败就空着 */ }
  }

  /** 引导里用体验卡：两栏（卡号 + 中转地址）拼成 `卡号@地址` 再交给应用同一个 apply()。
   *  卡号只在这台设备上落盘，和「设置 → 连接方式 → 体验卡」那一行走的是同一个 apply()。 */
  async function useCardInOnboarding() {
    if (busy) return;
    const card = global.RoleWorldCard;
    const tokenInput = overlay && overlay.querySelector('[data-ob="card-token"]');
    const relayInput = overlay && overlay.querySelector('[data-ob="card-relay"]');
    const token = tokenInput ? String(tokenInput.value || "").trim() : "";
    const relay = relayInput ? String(relayInput.value || "").trim().replace(/\/+$/, "") : "";
    if (!card || typeof card.apply !== "function") { setCardStatus("这个版本不支持体验卡，请改成填 API Key。", "bad"); return; }
    if (!token) { setCardStatus("先填卡号（发卡的人给你的那串 RW-…）。", "bad"); return; }
    if (!relay) { setCardStatus("还要填中转地址：发卡的人给你的那段 https:// 开头的网址。", "bad"); return; }
    busy = true;
    setCardStatus("正在用这张卡…", null);
    try {
      const result = await card.apply(token + "@" + relay);
      if (!result.ok) { setCardStatus(result.message || "这张卡没用上。", "bad"); return; }
      if (tokenInput) tokenInput.value = "";
      setCardStatus("✓ 体验卡已启用（" + (result.message || "") + "）。点「下一步」继续。", "ok");
      // 把它滚进视野：这一页在窄屏/软键盘弹出时是**内部滚动**的，成功提示在按钮下面，
      // 不主动滚一下就可能"点了没反应"（用户 2026-09-17 反馈）。
      const statusNode = overlay && overlay.querySelector('[data-ob="card-status"]');
      if (statusNode && typeof statusNode.scrollIntoView === "function") {
        try { statusNode.scrollIntoView({ block: "nearest" }); } catch (_) { /* 滚不动也不影响结果 */ }
      }
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
    // 粘进来的其实是体验卡号？别往密钥位里写 —— 写进去等于把卡号当 API Key 用，
    // 下一轮请求必然 401（用户 2026-09-12 就是这么踩的）。
    // 现在这一步只服务"用自己的 Key"这条路，所以给一句指路：回上一步选另一个选项。
    if (key && global.RoleWorldCard && typeof global.RoleWorldCard.looksLikeCard === "function"
      && global.RoleWorldCard.looksLikeCard(key)) {
      setStatus("这看起来是**体验卡号**，不是 API Key。点下面的「上一步」回去选「有人给了我一张体验卡」。", "bad");
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
    // 填卡页：没配好卡不许往下走 —— 否则他会以为什么都没发生就"进去了"（用户 2026-09-16 反馈的核心痛点）。
    if (step === "card-setup" && !(await cardReady())) return;
    if (index < steps().length - 1) {
      index += 1;
      render();
      return;
    }
    await finish();
  }

  /** 填卡页的前置：这一页过完，本机必须真的在用一张卡。 */
  async function cardReady() {
    const card = global.RoleWorldCard && typeof global.RoleWorldCard.currentState === "function"
      ? await global.RoleWorldCard.currentState() : null;
    if (card && card.active) return true;
    // 卡号和中转地址都填了、只是没点按钮：顺手用掉（"填完就点下一步"是最自然的动作）。
    const tokenInput = overlay && overlay.querySelector('[data-ob="card-token"]');
    const relayInput = overlay && overlay.querySelector('[data-ob="card-relay"]');
    if (tokenInput && String(tokenInput.value || "").trim() && relayInput && String(relayInput.value || "").trim()) {
      await useCardInOnboarding();
      const after = await global.RoleWorldCard.currentState();
      if (after && after.active) return true;
    }
    setCardStatus("还没配上：卡号和中转地址两栏都填一下，然后点「用这张卡」。", "bad");
    return false;
  }

  // 填 Key 那一页必须有凭据：API Key（体验卡走的是另一条路，不经过这里）。
  async function keyReady() {
    const adapter = global.RoleWorld;
    const provider = overlay.querySelector('[data-ob="provider"]').value;
    const saved = await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider }));
    if (saved && saved.value) return true;
    // 极端情况：用户在这一页之前其实已经把卡配上了（导入存档 / 上一轮留下的），那就别拦他。
    const card = global.RoleWorldCard && typeof global.RoleWorldCard.currentState === "function"
      ? await global.RoleWorldCard.currentState() : null;
    if (card && card.active) return true;
    setStatus("请先粘贴 API Key 并点「保存并测试」。", "bad");
    return false;
  }

  async function finish() {
    const chinese = overlay && overlay.querySelector('[data-ob="language-zh"]');
    const patch = { [SEEN_KEY]: true };
    // 卡用户也记上「开场看过了」——他走的是卡那套，不该再被"填 Key"那套拦一次。
    if (mode === "card") patch[CARD_SEEN_KEY] = true;
    if (chinese) patch.language_mode = chinese.checked === true ? "zh" : "auto";
    // **先落盘，再关浮层。**
    // 关掉浮层是"这一步结束了"的对外信号（用户看的是它，自动化等的也是它），
    // 而这中间还有两次 await（读体验卡状态、写本机设置）。原来的顺序是先 close() 再写，
    // 于是"浮层已经消失、标记还没落盘"存在一个真实窗口：
    //   · 用户正好在这时刷新 / 关标签页 → 下次打开又弹一次开场；
    //   · 自动化正好在这时读设置 → 读到旧值（2026-09-13 那条偶发用例就卡在这里）。
    // 顺序调过来之后，"浮层没了"就等价于"标记已经写下去了"，两边都不再有窗口。
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
    close();
    notifySettings();
    global.dispatchEvent(new global.CustomEvent("roleworld:nickname-changed", { detail: { nickname } }));
  }

  async function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeydown, true);
  }

  /** 「先跳过，稍后设置」（见 skipHtml 的说明）：把人放出去，并把"看过了"落盘。 */
  async function skipOnboarding() {
    try {
      await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true, [CARD_SEEN_KEY]: true });
    } catch (_) { /* 存不下也绝不能把人关在里面 */ }
    close();
    notifySettings();
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
    // 每次打开都从"还没选"开始：二选一那一页不给默认值，避免用户以为已经选过了。
    way = "";
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
        // 卡已经在用了：二选一那一页把「体验卡」标成"当前在用"，别让他以为要重选一遍。
        // 注意这只影响**高亮**：`way` 仍然是"未选"，他照样可以改选"我自己的 Key"。
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
    /**
     * **只给自动化用**：在"二选一"那一页上确定性地选定路线并翻页。
     * 为什么要有它：用例如果靠"点下一步、再看标题猜自己走到哪"，顺序一变就假红
     * （2026-09-16 重排引导时连红四条）。这里让用例直接说"我走体验卡这条"。
     * 不在二选一那一页上时它什么也不做（返回 false），避免被误用。
     */
    route: (which) => {
      if (!overlay) return false;
      const step = steps()[index];
      if (step !== "choose") return false;
      chooseWay(which === "key" ? "key" : "card");
      return true;
    },
    // 给用例一个干净的起点：把浮层关掉（测试里"再看一次教程"要能重复开）。
    close: () => { close(); return true; },
    currentStep: () => steps()[index] || "",
    CARD_SEEN_KEY,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
