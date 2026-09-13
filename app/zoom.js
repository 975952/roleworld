"use strict";

/*
 * zoom.js —— 界面大小：快捷键 + 应用缩放（对话页与剧情模式共用）
 *
 *   Ctrl/⌘ + -   缩小一档
 *   Ctrl/⌘ + =   放大一档（+ 要按 Shift，所以 = 也认）
 *   Ctrl/⌘ + 0   回到 100%
 *
 * **2026-09-13 重新定了基准**（用户：「所有的默认大小调到现在的90%，
 * 就是把现在的90改成100，然后重新规划」）：
 *   以前 100% = zoom 1，界面偏大；现在**默认就是 0.9**，并且把这一档叫作 100%。
 *   也就是说界面上的百分比 = zoom 值 × 100 + 10：
 *     0.85 → 95%   0.9 → 100%（默认）   0.95 → 105%   1 → 110%
 *     1.05 → 115%  1.1 → 120%           1.15 → 125%  1.2 → 130%
 *   为什么不直接把所有 CSS 尺寸乘 0.9：那样等于把整套设计稿重画一遍，
 *   而 zoom 是浏览器原生的整体缩放，字号、间距、圆角、命中区一起等比缩小，不会走形。
 *   代价是"渲染出来的命中区也小了 10%"，所以移动端那几处 44px 的触控目标
 *   同时上调到 49px（见 styles.css 的说明），保证**渲染后**仍然 ≥44px。
 *
 * 档位 8 档（95%–130%，5% 一档；比默认再小一档留着，免得想要更小的人没得选）。
 *
 * **跟着缩放 / 不跟着缩放的边界**（改布局前先看这一条）：
 *   zoom 加在 `#appShell`（剧情模式是 `.map-app`）上，所以**只有壳里面的**跟着变：
 *   对话页、设置页、「本次请求」、角色记忆面板、关系档案都在壳里 ✓。
 *   壳外面的是：底部导航条 `.mobile-bottom-nav`、`.toast`、记忆条目编辑弹窗 `#memoryModal`、
 *   AI 写角色 `#aiCreateDialog`、登录闸 `#authGate`。
 *   它们**故意不动** —— 这些层都是 `position: fixed; inset: 0`，给它们加 zoom 会变成
 *   "按视口宽度算完再缩 0.9"，右边空出一条（0.1.15 前后踩过这个坑）。
 *   代价是它们看着比页面大 11%；要修也是改布局，不要再往 fixed 层上叠 zoom。
 *   反过来：**在壳里给壳外的东西留位置**（比如给底部导航条留底部内边距）要除以缩放，
 *   否则会短一截 —— 见 styles.css 的 `--nav-reserve`。
 *
 * 偏好存在与外观设置同一份 localStorage 里（task27a.preferences.v1.<handle>），
 * 所以快捷键改完之后，设置里的下拉也会跟着变。
 */

(function (global) {
  // 每一档都是真实 zoom 值；对外显示的百分比见 percentOf()。
  const LADDER = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];
  /** 新基准：这一档就是界面上的「100%」（= 2026-09-13 之前的 90%）。 */
  const DEFAULT_SCALE = 0.9;
  /** 写回存档时打的基准标记，必须与 account-core 的 SCALE_BASE 一致。 */
  const SCALE_TAG = "0.9";
  /** zoom 值 → 界面上的百分比。默认档 0.9 读作 100%，所以整体 +10。 */
  function percentOf(scale) {
    return Math.round(scale * 100) + 10;
  }
  const PREF_PREFIX = "task27a.preferences.v1.";
  const HANDLE_KEY = "task27a.current-account-handle.v1";
  const TOAST_ID = "roleworld-zoom-toast";

  function handle() {
    try {
      return global.sessionStorage.getItem(HANDLE_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function prefsKey() {
    const value = handle();
    return value ? PREF_PREFIX + value : "";
  }

  function readPrefs() {
    const key = prefsKey();
    if (!key) return null;
    try {
      return JSON.parse(global.localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  /** 当前存着的档位。**问 account-core 要**，不要自己 parse：
   *  里面带着"2026-09-13 基准从 1 改成 0.9"的老存档迁移（老档位整体下一格），
   *  自己再写一份规则就会出现两套口径（一个页面里两个地方给出不同的缩放）。 */
  function readScale() {
    const prefs = readPrefs();
    if (!prefs) return DEFAULT_SCALE;
    const core = global.RoleWorldAccountCore;
    if (core && typeof core.normalizePreferences === "function") {
      try {
        const normalized = core.normalizePreferences(prefs);
        const value = Number(normalized && normalized.scale);
        if (LADDER.indexOf(value) >= 0) return value;
      } catch (_) { /* 下面还有兜底 */ }
    }
    const value = Number(prefs.scale);
    return LADDER.indexOf(value) >= 0 ? value : DEFAULT_SCALE;
  }

  function writeScale(scale) {
    const key = prefsKey();
    if (!key) return;
    const prefs = readPrefs() || {};
    prefs.version = prefs.version || 1;
    prefs.scale = String(scale);
    // 必须同时写下基准标记：否则这份存档看起来还是"老基准"，
    // 下次加载会被当成老存档再往下搬一格（用户按一次 Ctrl+= 就白按了）。
    prefs.scaleBase = SCALE_TAG;
    try {
      global.localStorage.setItem(key, JSON.stringify(prefs));
    } catch (_) { /* 存不下也不影响本次会话 */ }
  }

  // 缩放目标：对话页是 #appShell，剧情模式是 .map-app（body 上的 zoom 会被忽略）。
  function target() {
    return document.getElementById("appShell")
      || document.querySelector(".map-app")
      || document.body;
  }

  function syncViewport() {
    const viewport = global.visualViewport;
    const root = document.documentElement;
    // --viewport-w/h：给 #appShell 算宽度/高度用的绝对 px（zoom 会缩放 vw，
    // 用 vw 做缩放补偿会算错，右边会空出一条）。
    const layoutWidth = Number(document.documentElement.clientWidth || viewport?.width || global.innerWidth || 0);
    if (layoutWidth > 0) root.style.setProperty("--viewport-w", `${Math.round(layoutWidth)}px`);
    root.style.setProperty("--viewport-h", `${Math.round(viewport?.height || global.innerHeight)}px`);
    root.style.setProperty("--visual-viewport-width", `${viewport?.width || global.innerWidth}px`);
    root.style.setProperty("--visual-viewport-height", `${viewport?.height || global.innerHeight}px`);
  }

  function apply(scale) {
    syncViewport();
    const element = target();
    document.documentElement.dataset.scale = String(scale);
    document.documentElement.style.setProperty("--ui-scale", String(scale));
    if (!element) return;
    if (scale === 1) element.style.removeProperty("zoom");
    else element.style.zoom = String(scale);
  }

  function current() {
    return readScale();
  }

  function toast(text) {
    let node = document.getElementById(TOAST_ID);
    if (!node) {
      node = document.createElement("div");
      node.id = TOAST_ID;
      node.style.cssText = [
        "position:fixed", "left:50%", "bottom:28px", "transform:translateX(-50%)",
        "z-index:99998", "padding:7px 14px", "border-radius:999px",
        "font:13px system-ui,-apple-system,'Segoe UI',sans-serif",
        "pointer-events:none", "opacity:0", "transition:opacity .18s ease",
      ].join(";");
      (document.getElementById("appShell") || document.body).appendChild(node);
    }
    const styles = getComputedStyle(document.documentElement);
    node.style.background = styles.getPropertyValue("--raised").trim() || "#191b20";
    node.style.color = styles.getPropertyValue("--main-text").trim() || "#f1f2f4";
    node.style.border = "1px solid " + (styles.getPropertyValue("--hairline").trim() || "#2d3038");
    node.textContent = text;
    node.style.opacity = "1";
    clearTimeout(node._timer);
    node._timer = setTimeout(() => { node.style.opacity = "0"; }, 1200);
  }

  function setScale(next, options) {
    const scale = Math.round(next * 100) / 100;
    writeScale(scale);
    apply(scale);
    if (!options || options.silent !== true) toast("界面大小 " + percentOf(scale) + "%");
    // 让设置里的下拉和其它监听者同步（app.js 会更新 #scaleSelect）
    try {
      global.dispatchEvent(new global.CustomEvent("roleworld:scale-changed", { detail: { scale: String(scale) } }));
    } catch (_) { /* 老浏览器忽略 */ }
    return scale;
  }

  function step(direction) {
    const index = LADDER.indexOf(current());
    const next = LADDER[Math.min(LADDER.length - 1, Math.max(0, index + direction))];
    if (next === current()) {
      toast(direction > 0 ? "已经是最大 " + percentOf(next) + "%" : "已经是最小 " + percentOf(next) + "%");
      return;
    }
    setScale(next);
  }

  function onKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key;
    if (key === "-" || key === "_") {
      event.preventDefault();
      step(-1);
    } else if (key === "=" || key === "+") {
      event.preventDefault();
      step(1);
    } else if (key === "0") {
      event.preventDefault();
      if (current() === DEFAULT_SCALE) { toast("界面大小 " + percentOf(DEFAULT_SCALE) + "%"); return; }
      setScale(DEFAULT_SCALE);
    }
  }

  function boot() {
    document.addEventListener("keydown", onKeydown, true);
    global.addEventListener("resize", syncViewport);
    global.visualViewport?.addEventListener("resize", syncViewport);
    apply(readScale());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  global.RoleWorldZoom = { LADDER, DEFAULT_SCALE, percentOf, setScale, current, apply };
})(typeof globalThis !== "undefined" ? globalThis : this);
