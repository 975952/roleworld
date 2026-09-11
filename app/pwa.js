"use strict";

/*
 * pwa.js —— 网页版的离线壳注册与"有新版本"提示
 *
 * 两件事，都刻意做得很轻：
 *  ① 注册 sw.js（只在 http/https 下注册；桌面端是 tauri:// 协议，注册会失败，直接跳过）。
 *  ② 版本对照：加载时抓一次 app/version.json 当作"这次会话的基准版本"，
 *     之后在**回到这个标签页**（visibilitychange / focus）时再抓一次；
 *     数字变了就说明线上已经发过新版，弹一个小胶囊提示刷新。
 *     为什么不做成定时轮询：a) 本项目有一条守卫用例明确禁止 ≥5 分钟的定时器（那条是针对
 *     "主动唤起用户"的，但定时轮询也不该悄悄加回来）；b) 用户没看这个页面时提示也没有意义。
 *
 * 注意：缓存策略是"网络优先"（见 sw.js），所以**正常刷新拿到的永远是最新文件**；
 * 这个提示主要服务于"页面开着一整天没关"的情况。
 */

(function (global) {
  const VERSION_URL = "version.json";
  const state = {
    baseline: "",      // 这次会话第一次看到的线上版本
    latest: "",        // 最近一次抓到的线上版本
    updateReady: false,
    registration: null,
    offlineCapable: false,   // 浏览器是否支持并成功注册了离线壳
  };

  function pillNode() {
    return document.querySelector("#updatePill");
  }

  function showPill(text) {
    const node = pillNode();
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
  }

  function hidePill() {
    const node = pillNode();
    if (node) node.hidden = true;
  }

  async function fetchVersion() {
    const response = await fetch(VERSION_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("version.json " + response.status);
    const data = await response.json();
    return String((data && data.version) || "");
  }

  /**
   * 抓一次线上版本。
   * @param {{baseline?: boolean}} options baseline=true 表示"这次会话的第一次"，
   *        只记基准、不提示（刚打开就提示"有新版本"是打扰 —— 页面本来就是新的）。
   */
  async function checkVersion(options) {
    const opts = options || {};
    let version = "";
    try {
      version = await fetchVersion();
    } catch (_) {
      // 离线或取不到：不提示（离线时页面用的是缓存，提示刷新没有意义）。
      return { ok: false, version: "" };
    }
    state.latest = version;
    if (opts.baseline || !state.baseline) {
      state.baseline = version;
      state.updateReady = false;
      hidePill();
      return { ok: true, version: version, changed: false };
    }
    const changed = version !== state.baseline;
    state.updateReady = changed;
    if (changed) {
      showPill(`有新版本（${version}），点这里刷新`);
    } else {
      hidePill();
    }
    return { ok: true, version: version, changed: changed };
  }

  /** 用户点胶囊：先让新版的离线壳接管，再刷新。 */
  async function reloadForUpdate() {
    try {
      const registration = state.registration;
      if (registration && registration.waiting) {
        registration.waiting.postMessage({ type: "skip-waiting" });
      }
    } catch (_) { /* 拿不到注册信息也照样刷新 */ }
    global.location.reload();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // 桌面端（tauri://）与 file:// 下没有可用的 SW，注册会抛错，静默跳过。
    if (global.location.protocol !== "http:" && global.location.protocol !== "https:") return;
    navigator.serviceWorker.register("sw.js").then((registration) => {
      state.registration = registration;
      state.offlineCapable = true;
      // 有新壳在等：提示一次（点胶囊时会让它 skipWaiting 再刷新）。
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            state.updateReady = true;
            showPill("有新版本，点这里刷新");
          }
        });
      });
      // 每次打开都问一次有没有新壳（浏览器自己也会周期性检查）。
      registration.update().catch(() => {});
    }).catch(() => {
      // 注册失败只意味着"没有离线壳"，不影响在线使用，也不打扰用户。
      state.offlineCapable = false;
    });
  }

  function bindReturnChecks() {
    // 回到这个标签页时才检查：用户没在看的时候提示没有意义，也避免任何定时器。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkVersion().catch(() => {});
    });
    global.addEventListener("focus", () => { checkVersion().catch(() => {}); });
  }

  function boot() {
    const pill = pillNode();
    if (pill) pill.addEventListener("click", () => { reloadForUpdate().catch(() => {}); });
    registerServiceWorker();
    bindReturnChecks();
    checkVersion({ baseline: true }).catch(() => {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  global.ROLEWORLD_PWA = {
    state: state,
    checkVersion: checkVersion,
    reloadForUpdate: reloadForUpdate,
  };
})(typeof window !== "undefined" ? window : globalThis);
