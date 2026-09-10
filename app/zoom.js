"use strict";

/*
 * zoom.js —— 界面大小：快捷键 + 应用缩放（对话页与剧情模式共用）
 *
 *   Ctrl/⌘ + -   缩小一档
 *   Ctrl/⌘ + =   放大一档（+ 要按 Shift，所以 = 也认）
 *   Ctrl/⌘ + 0   回到 100%
 *
 * 档位只有 7 档（90%–120%，5% 一档）——上一版最大到 150%，缩放幅度太大，
 * 一按整个界面就"跳"一下。收窄之后是细调，不会有强烈违和感。
 *
 * 偏好存在与外观设置同一份 localStorage 里（task27a.preferences.v1.<handle>），
 * 所以快捷键改完之后，设置里的下拉也会跟着变。
 */

(function (global) {
  const LADDER = [0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];
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

  function writeScale(scale) {
    const key = prefsKey();
    if (!key) return;
    const prefs = readPrefs() || {};
    prefs.version = prefs.version || 1;
    prefs.scale = String(scale);
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

  function apply(scale) {
    const element = target();
    document.documentElement.dataset.scale = String(scale);
    if (!element) return;
    if (scale === 1) element.style.removeProperty("zoom");
    else element.style.zoom = String(scale);
  }

  function current() {
    const prefs = readPrefs();
    const value = Number(prefs && prefs.scale);
    return LADDER.indexOf(value) >= 0 ? value : 1;
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
    if (!options || options.silent !== true) toast("界面大小 " + Math.round(scale * 100) + "%");
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
      toast(direction > 0 ? "已经是最大 " + Math.round(next * 100) + "%" : "已经是最小 " + Math.round(next * 100) + "%");
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
      if (current() === 1) { toast("界面大小 100%"); return; }
      setScale(1);
    }
  }

  function boot() {
    document.addEventListener("keydown", onKeydown, true);
    const prefs = readPrefs();
    const value = Number(prefs && prefs.scale);
    apply(LADDER.indexOf(value) >= 0 ? value : 1);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  global.RoleWorldZoom = { LADDER, setScale, current, apply };
})(typeof globalThis !== "undefined" ? globalThis : this);
