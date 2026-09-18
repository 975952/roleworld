"use strict";

/*
 * back-nav.js —— 应用内返回手势（2026-09-18 用户要求：「APK 把返回手势做好，网页版也要接住应用内返回」）。
 *
 * 要解决的问题：手机上按返回键（或从边缘侧滑）时，WebView / 浏览器**直接退出整个应用** ——
 * 哪怕用户当时正开着一个面板。用户的期望是"返回 = 退回上一层"：
 *   面板（设置 / 角色 / 记忆 / 本次请求 / 语音面板 / "+" 面板 / 表情面板 / 抽屉）→ 关掉它；
 *   一层都没有了 → 才退出应用。
 *
 * 做法（不用任何依赖，双端同一份代码）：
 *   ① 进页面时往历史里压一条自己的记录（`rwLayer`）——有了它，第一次返回才**不会直接离开**；
 *   ② 用户每开一层，`pushLayer()` 再压一条，于是"返回"天然对应"退一层"；
 *   ③ `popstate` 到达时按固定顺序找**最上层还开着的**那一个并关掉它，
 *      一个都找不到就是"已经到底"：这时允许浏览器/WebView 自己退出（再按一次返回就走）。
 *
 * 为什么返回要分"按两次才退出"：如果第一次返回立刻 `history.back()` 退出，用户就再也没机会
 * 关掉面板了；反过来如果永远不退，用户会觉得"返回键坏了"。微信这类应用都是"面板先关、
 * 到底再退"。
 *
 * ⚠ 这里**不碰**任何业务逻辑：只调 integration 暴露出来的那几个 close 函数
 *   （它们各自负责落盘、清理定时器、恢复焦点）。`back()` 是唯一的判据实现，
 *   popstate 只是调它 —— 这样用例可以直接调它验证"哪一层被关掉"。
 */
(function (global) {
  const GLOBAL = global || (typeof globalThis !== "undefined" ? globalThis : null);
  if (!GLOBAL) return;

  const LAYER_STATE = "rwLayer";
  // 「到底了」之后多久内再按一次返回 = 真的要退出（超过这个时间就当作"只是手滑按了一下"）。
  const EXIT_WINDOW_MS = 2500;
  let exitArmedAt = 0;
  let registered = false;
  let nextBackIsOurLayer = false;

  function isPhoneWidth() {
    return Number(GLOBAL.innerWidth || 0) <= 760;
  }

  /** 当前页面对应的文件名（`/app/index.html`、`index.html`、`/chat/` 都算）。 */
  function pageName() {
    const path = String((GLOBAL.location && GLOBAL.location.pathname) || "");
    const last = path.split("/").filter(Boolean).pop() || "index.html";
    return /\.html?$/i.test(last) ? last : "index.html";
  }

  function api() { return GLOBAL.TASK21 || null; }
  /** 上一次 `back()` 依次看了哪些层、看到的是什么（诊断用；只留最后一次）。 */
  let backTrace = [];  function call(name) {
    const a = api();
    if (!a || typeof a[name] !== "function") return false;
    try { a[name](); return true; } catch (_) { return false; }
  }
  function visible(selector) {
    const node = GLOBAL.document ? GLOBAL.document.querySelector(selector) : null;
    const shown = !!(node && node.hidden !== true);
    backTrace.push(selector + "=" + (node ? (shown ? "open" : "hidden") : "absent"));
    return shown;
  }
  function clickable(selector) {
    const node = GLOBAL.document ? GLOBAL.document.querySelector(selector) : null;
    if (!node) return false;
    try { node.click(); return true; } catch (_) { return false; }
  }

  /** 设置面板的开关在 app.js 的 `TASK25C_UI` 上（不在 TASK21 上）。 */
  function settingsUi() { return GLOBAL.TASK25C_UI || null; }
  function closeSettingsLayer() {
    const ui = settingsUi();
    if (ui && typeof ui.closeSettings === "function") {
      try { ui.closeSettings(); return true; } catch (_) { /* 走下面的兜底 */ }
    }
    return clickable("#settingsSurface [data-action='close-settings']");
  }
  function isSettingsLayerOpen() {
    const node = GLOBAL.document ? GLOBAL.document.querySelector("#settingsSurface") : null;
    return !!(node && node.hidden !== true);
  }

  /**
   * 关掉**最上层还开着**的那一个。返回它的名字；一层都没有就返回 ""。
   *
   * 顺序 = 视觉上的层级（后开的先关）：底部小面板 → 弹窗 → 整页 → 抽屉。
   * 这个顺序是"用户看到什么就先关什么"，不要按代码里的先后随便换。
   */
  function closeTopLayer() {
    backTrace = [];
    // ① 设置（整页覆盖，最"高"）
    if (isSettingsLayerOpen() && closeSettingsLayer()) return "settings";
    // ② 角色面板（设定 / 记忆 / 关系三页**都在这一个浮层里**）。
    //    ⚠ 不要再单独判里面那两页（`#memoryPanel` / `#companionDialog`）：它们的 hidden
    //      管的是"这一页显不显示"，整块浮层关掉时它们照样是 hidden=false ——
    //      按它们判会把"角色面板关着"误读成"还开着一层"（实测就这么误判过一次）。
    if (visible("#characterPanel")) {
      if (clickable('[data-action="close-character-panel"]')) return "characterPanel";
      if (call("closeCharacterPanel")) return "characterPanel";
    }
    // ③ 「本次请求」
    if (visible("#requestPeek")) {
      if (call("closeRequestPeek")) return "requestPeek";
      if (clickable('[data-action="close-request-peek"]')) return "requestPeek";
    }
    // ④ 语音开启面板
    if (visible("#voiceSheet")) {
      if (call("closeVoiceSetup")) return "voiceSheet";
      const voiceClose = GLOBAL.document.querySelector("#voiceSheet .rw-voice-sheet-close");
      if (voiceClose) { voiceClose.click(); return "voiceSheet"; }
    }
    // ⑥ 记忆条目编辑弹窗 / 提示框 / AI 写角色
    for (const [selector, action] of [["#memoryModal", "close-modal"], ["#aiCreateDialog", "close-ai-create"], [".confirm-backdrop", "close-confirm"]]) {
      if (visible(selector) && clickable('[data-action="' + action + '"]')) return selector;
    }
    // ⑦ 输入条那两块（「+」面板 / 表情面板）/ 角色选择器。
    //    ⚠ 必须**先确认它开着**再关：`closeComposerMenus()` 会返回"关掉了没有"，
    //      但如果不先看状态就问，一个没开的浮层也会让 `back()` 报出名字 ——
    //      于是"已经到底"被误判成"又关了一层"，用户按返回永远退不出去（实测踩到）。
    if (visible("#composerMenu") || visible(".sticker-picker") || visible("#characterPickerMenu")) {
      if (call("closeComposerMenus")) return "composerMenu";
    }
    // ⑧ 用户菜单
    if (visible("#userMenu")) return call("closeUserMenu") ? "userMenu" : "";
    // ⑨ 左侧抽屉（手机上）
    if (isPhoneWidth() && GLOBAL.document.body.classList.contains("mobile-drawer-visible")) {
      if (clickable("[data-action='close-mobile-drawer']")) return "mobileDrawer";
    }
    return "";
  }

  /**
   * 接住一次"返回"。返回**被关掉的那一层的名字**；""= 已经到底（这时**允许**退出应用）。
   *
   * ⚠ 返回名字（而不是 true/false）是刻意的：用例要能断言"是哪一层被关掉了"，
   *   而不是只看到"有反应"。这个项目反复踩过"判据太宽 = 什么都没守"的坑。
   *
   * 到底之后的规矩：第一次到"底"只是记下时间；`EXIT_WINDOW_MS` 之内再来一次才算真的要退出，
   * 那次由浏览器/WebView 自己完成（我们 push 回一条自己的记录把页面留住）。
   */
  function back() {
    // 只有**真的从 popstate 进来**时才允许补记历史（顺序：进来先取走这个标记）。
    const fromPopstate = nextBackIsOurLayer;
    nextBackIsOurLayer = false;
    const closed = closeTopLayer();
    if (closed) { exitArmedAt = 0; return closed; }
    const now = Date.now();
    // 到底之后**再塞回一条自己的记录**（只在"用户真的按返回"时塞）：这样两次返回之间
    // 页面不会被浏览器带走，用户还有第二次机会。直接调 `back()`（用例、诊断）时不塞，
    // 免得把测试环境的历史越堆越长。
    if (fromPopstate) pushLayer();
    if (now - exitArmedAt <= EXIT_WINDOW_MS) { exitArmedAt = 0; return ""; }
    exitArmedAt = now;
    return "";
  }

  function pushLayer() {
    if (!GLOBAL.history || typeof GLOBAL.history.pushState !== "function") return false;
    try {
      GLOBAL.history.pushState(Object.assign({}, (GLOBAL.history.state || {}), { [LAYER_STATE]: true }), "", GLOBAL.location.href);
      return true;
    } catch (_) { return false; }
  }

  /* 观测"哪一层开了"：面板的开关散在好几个函数里（打开设置 / 角色面板 / 记忆 / 本次请求 /
     语音面板 / 弹窗），一处一处去调 pushLayer 迟早漏一个 —— 漏掉的那一个就是"按返回直接退出应用"。
     所以这里只认**结果**：某个浮层的 hidden 变成 false 就补一条历史记录。
     这样新加一个面板只要它是个带 hidden 的浮层，返回手势自动就有，不需要再改这个文件。 */
  const LAYER_ROOTS = [
    "#settingsSurface", "#characterPanel", "#requestPeek", "#voiceSheet",
    "#memoryModal", "#aiCreateDialog", "#composerMenu",
    "#userMenu", ".sticker-picker", ".confirm-backdrop",
  ];

  function watchingNode(node) {
    return node && node.nodeType === 1 && (node.matches && LAYER_ROOTS.some((sel) => node.matches(sel)));
  }

  /** 现在有几个浮层开着（诊断用；用例拿它验证"观测真的在跟"）。 */
  function openLayerCount() {
    return openLayerNames().length;
  }

  /** 现在开着哪些浮层（按名字，诊断用）。 */
  function openLayerNames() {
    return LAYER_ROOTS.filter((sel) => visible(sel));
  }

  function startWatching() {
    const doc = GLOBAL.document;
    if (!doc || typeof GLOBAL.MutationObserver !== "function") return;
    let armed = false;
    const observer = new GLOBAL.MutationObserver((records) => {
      let shouldPush = false;
      for (const record of records) {
        if (record.type === "attributes") {
          const node = record.target;
          if (watchingNode(node) && node.hidden !== true) shouldPush = true;
        } else if (record.type === "childList") {
          for (const added of Array.from(record.addedNodes || [])) {
            if (watchingNode(added) && added.hidden !== true) shouldPush = true;
          }
        }
      }
      if (!shouldPush || armed) return;
      armed = true;
      // 合并同一轮的多次变化（一次打开动作常常连着改好几个属性），别把历史堆成十几条。
      GLOBAL.setTimeout(() => { armed = false; }, 80);
      pushLayer();
    });
    observer.observe(doc.body || doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }

  /** 进页面时压一条自己的记录：没有它，第一次返回会**直接离开**应用（用户报的就是这个）。 */
  function arm() {
    if (!GLOBAL.history || typeof GLOBAL.history.replaceState !== "function") return;
    try {
      const state = Object.assign({}, (GLOBAL.history.state || {}), { [LAYER_STATE]: true, rwPage: pageName() });
      GLOBAL.history.replaceState(state, "", GLOBAL.location.href);
    } catch (_) { /* 隐私模式下可能不让改，忽略 */ }
  }

  function init() {
    if (registered) return true;
    registered = true;
    arm();
    startWatching();
    GLOBAL.addEventListener("popstate", () => {
      nextBackIsOurLayer = true;
      back();
    });
    return true;
  }

  GLOBAL.RoleWorldBack = {
    init: init,
    back: back,
    pushLayer: pushLayer,
    closeTopLayer: closeTopLayer,
    openLayerCount: openLayerCount,
    openLayerNames: openLayerNames,
    lastTrace: () => backTrace.slice(),
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
