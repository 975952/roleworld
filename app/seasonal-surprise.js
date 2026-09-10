"use strict";

/*
 * 2026-09-09 「九月的信 · 返校季」惊喜层（Task-Surprise）
 *
 * 纯前端、自包含：进入产品后按账号一次性展示一封欢迎信，并可选开启
 * 九月限定的金色微光氛围。不调用生成接口、不读写服务端数据、不修改
 * 账号/角色/聊天/Memory Books；本机仅用 localStorage 记录“已看过”。
 *
 * 关闭方式：信件里的按钮或 Esc；氛围可在信里取消勾选。
 * 自动化兼容：?surprise=off 关闭全部；?surprise=on 强制开启（供测试）。
 * 默认在 navigator.webdriver 为真的浏览器里不打扰（回归测试不受影响）。
 */
(function () {
  var HANDLE_KEY = "task27a.current-account-handle.v1";
  var STATE_PREFIX = "task29.seasonal-surprise.v1.";
  var SEASON_MONTH = 8; /* 9 月（0 起始） */
  var MOTE_COUNT = 14;

  var layer = null;
  var state = { seen: false, ambient: true };
  var dismissed = false;

  function storage(kind) {
    try { return window[kind] || null; } catch (_) { return null; }
  }

  function currentHandle() {
    var s = storage("sessionStorage");
    if (!s) return "";
    try { return s.getItem(HANDLE_KEY) || ""; } catch (_) { return ""; }
  }

  function loadState(handle) {
    var s = storage("localStorage");
    if (!s) return { seen: false, ambient: true };
    try {
      var raw = s.getItem(STATE_PREFIX + handle);
      if (!raw) return { seen: false, ambient: true };
      var parsed = JSON.parse(raw);
      return {
        seen: !!(parsed && parsed.seen === true),
        ambient: !(parsed && parsed.ambient === false),
      };
    } catch (_) {
      return { seen: false, ambient: true };
    }
  }

  function saveState(handle, next) {
    var s = storage("localStorage");
    if (!s) return;
    try {
      s.setItem(STATE_PREFIX + handle, JSON.stringify({
        seen: next.seen === true,
        ambient: next.ambient !== false,
        at: new Date().toISOString(),
      }));
    } catch (_) { /* 存储不可用时不影响使用 */ }
  }

  function prefersReduced() {
    if (document.documentElement.dataset.motion === "reduced") return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function forced() {
    try {
      var value = new URLSearchParams(window.location.search).get("surprise");
      if (value === "on") return true;
      if (value === "off") return false;
      return null;
    } catch (_) {
      return null;
    }
  }

  function automation() {
    try {
      if (navigator.webdriver === true) return true;
      return /HeadlessChrome|HeadlessEdge|Puppeteer|Playwright/i.test(navigator.userAgent || "");
    } catch (_) {
      return false;
    }
  }

  function readyIdentity() {
    if (document.documentElement.classList.contains("theme-pending")) return "";
    var auth = document.getElementById("authGate");
    if (auth && !auth.hidden) return "";
    var template = document.getElementById("chatTemplateGate");
    if (template && !template.hidden) return "";
    var node = document.getElementById("userDisplayName");
    var name = node ? String(node.textContent || "").trim() : "";
    if (!name || name === "用户") return "";
    return name;
  }

  function applyAmbient(on) {
    document.documentElement.classList.toggle("season-ambient-on", !!on);
  }

  function makeMotes(host) {
    if (prefersReduced()) return;
    for (var i = 0; i < MOTE_COUNT; i += 1) {
      var mote = document.createElement("span");
      mote.className = "season-letter-mote";
      mote.style.setProperty("--mote-x", (4 + Math.random() * 92).toFixed(2) + "%");
      mote.style.setProperty("--mote-y", (12 + Math.random() * 74).toFixed(2) + "%");
      mote.style.setProperty("--mote-delay", (-Math.random() * 9).toFixed(2) + "s");
      mote.style.setProperty("--mote-duration", (7 + Math.random() * 6).toFixed(2) + "s");
      mote.style.setProperty("--mote-scale", (0.6 + Math.random() * 0.9).toFixed(2));
      host.appendChild(mote);
    }
  }

  function buildLayer(name) {
    var root = document.createElement("div");
    root.className = "season-letter-layer";
    root.id = "seasonLetterLayer";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.setAttribute("aria-labelledby", "seasonLetterTitle");
    root.setAttribute("aria-describedby", "seasonLetterBody");

    var backdrop = document.createElement("div");
    backdrop.className = "season-letter-backdrop";
    root.appendChild(backdrop);

    var motes = document.createElement("div");
    motes.className = "season-letter-motes";
    motes.setAttribute("aria-hidden", "true");
    makeMotes(motes);
    root.appendChild(motes);

    var card = document.createElement("section");
    card.className = "season-letter";

    var seal = document.createElement("div");
    seal.className = "season-letter-seal";
    seal.setAttribute("aria-hidden", "true");
    seal.appendChild(document.createElement("span")).textContent = "9¾";
    card.appendChild(seal);

    var ribbon = document.createElement("p");
    ribbon.className = "season-letter-ribbon";
    ribbon.textContent = "九月 · 返校季";
    card.appendChild(ribbon);

    var title = document.createElement("h2");
    title.id = "seasonLetterTitle";
    title.className = "season-letter-title";
    title.appendChild(document.createTextNode("致 "));
    var who = document.createElement("span");
    who.textContent = name;
    title.appendChild(who);
    card.appendChild(title);

    var body = document.createElement("div");
    body.id = "seasonLetterBody";
    body.className = "season-letter-body";
    [
      "九月一到，城堡的灯就亮了。",
      "角色世界已经为你备好六位角色：Harry、Tom Riddle、Ron、Hermione、Ginny 与 Luna，以及属于 Harry 的四本 Memory Books —— 每一段对话、每一条被修正的记忆，都只留在你自己的账号里。",
      "今天，想从哪个故事开始？",
    ].forEach(function (text) {
      var p = document.createElement("p");
      p.textContent = text;
      body.appendChild(p);
    });
    card.appendChild(body);

    var toggle = document.createElement("label");
    toggle.className = "season-letter-toggle";
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "seasonAmbientToggle";
    checkbox.checked = state.ambient !== false;
    toggle.appendChild(checkbox);
    toggle.appendChild(document.createTextNode("开启返校季氛围（金色微光，本月内可随时关闭）"));
    card.appendChild(toggle);

    var actions = document.createElement("div");
    actions.className = "season-letter-actions";
    var enter = document.createElement("button");
    enter.type = "button";
    enter.className = "primary-button";
    enter.id = "seasonLetterEnter";
    enter.textContent = "推开城堡大门";
    actions.appendChild(enter);
    var hint = document.createElement("span");
    hint.className = "season-letter-hint";
    hint.textContent = "Esc 也可以";
    actions.appendChild(hint);
    card.appendChild(actions);

    root.appendChild(card);
    return { root: root, enter: enter, checkbox: checkbox };
  }

  function shimmer() {
    if (prefersReduced()) return;
    var sweep = document.createElement("div");
    sweep.className = "season-sweep";
    sweep.setAttribute("aria-hidden", "true");
    document.body.appendChild(sweep);
    window.setTimeout(function () {
      if (sweep.parentNode) sweep.parentNode.removeChild(sweep);
    }, 1800);
  }

  function dismiss(handle, root, checkbox) {
    if (dismissed) return;
    dismissed = true;
    state.seen = true;
    state.ambient = !!(checkbox && checkbox.checked);
    saveState(handle, state);
    applyAmbient(state.ambient && !prefersReduced());
    root.classList.remove("is-open");
    root.classList.add("is-closing");
    window.setTimeout(function () {
      if (root.parentNode) root.parentNode.removeChild(root);
      if (layer === root) layer = null;
      shimmer();
    }, prefersReduced() ? 60 : 380);
  }

  function showLetter(handle, name) {
    var built = buildLayer(name);
    var root = built.root;
    layer = root;
    document.body.appendChild(root);

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss(handle, root, built.checkbox);
      }
    }
    function onBackdrop(event) {
      if (event.target === root || event.target.classList.contains("season-letter-backdrop")) {
        dismiss(handle, root, built.checkbox);
      }
    }

    built.enter.addEventListener("click", function () {
      document.removeEventListener("keydown", onKey);
      dismiss(handle, root, built.checkbox);
    });
    root.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);

    window.requestAnimationFrame(function () {
      root.classList.add("is-open");
      try { built.enter.focus({ preventScroll: true }); } catch (_) { built.enter.focus(); }
    });
  }

  function start(handle, name) {
    var force = forced();
    var allowed = force === true || (force === null && !automation());
    var inSeason = new Date().getMonth() === SEASON_MONTH;
    state = loadState(handle);
    if (!allowed || !inSeason) return;
    if (state.ambient !== false && !prefersReduced()) applyAmbient(true);
    if (state.seen) return;
    showLetter(handle, name);
  }

  function boot() {
    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      var name = readyIdentity();
      var handle = currentHandle();
      if (name && handle) {
        window.clearInterval(timer);
        try { start(handle, name); } catch (_) { /* 惊喜层失败不影响产品 */ }
        return;
      }
      if (tries >= 120) window.clearInterval(timer);
    }, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
