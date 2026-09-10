"use strict";

/*
 * gold-visual-check.cjs —— 外观回归（返校金配色 / 首帧落定 / 窄屏宽度 / 灰屏）
 *
 * 起因（2026-09-10 用户反馈）：
 *   1. 返校金"还是太浓，背景该偏黑，金色要更纯"；
 *   2. 亮色不该整屏蒙一层，应该做成渐变（羊皮纸那类整张纸的质感另走一路）；
 *   3. 第一次进入选择"保留返校金"却没显示出来；
 *   4. 窄屏时右侧空一块；
 *   5. 有时屏幕上什么都没有（灰屏）。
 *
 * 用无头 Chrome 打开真实页面（需要先起本地静态服务），逐条断言。
 *   node tests/gold-visual-check.cjs            # 默认 http://127.0.0.1:8090
 *   PROBE_BASE=http://127.0.0.1:8000 node ...
 */

const fs = require("node:fs");
const path = require("node:path");
const { CDP, launchChrome, sleep } = require("./cdp.js");

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:8090";
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => candidate && fs.existsSync(candidate)) || "";

const HANDLE_KEY = "task27a.current-account-handle.v1";
const PREF_KEY = "task27a.preferences.v1.local"; /* 探针里 handle 固定写 local */

const GOLD_DARK = { theme: "dark", style: "gold", ambient: true, density: "comfortable", motion: "full", scale: "1", sendMode: "enter" };
const GOLD_LIGHT = Object.assign({}, GOLD_DARK, { theme: "light" });

const MEASURE = `(() => {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const shell = document.getElementById("appShell") || document.querySelector(".map-app");
  const rect = shell ? shell.getBoundingClientRect() : null;
  const pick = (sel) => document.querySelector(sel);
  const bgImage = (sel) => { const n = pick(sel); return n ? getComputedStyle(n).backgroundImage : ""; };
  const btn = pick(".primary-button") || pick(".map-button-primary");
  return {
    style: root.dataset.style,
    theme: root.dataset.theme,
    ambient: root.classList.contains("season-ambient-on"),
    pending: root.classList.contains("theme-pending"),
    focus: css.getPropertyValue("--focus").trim(),
    canvas: css.getPropertyValue("--canvas").trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    shellVisibility: shell ? getComputedStyle(shell).visibility : "missing",
    innerWidth: window.innerWidth,
    vh: window.innerHeight,
    shellLeft: rect ? Math.round(rect.left) : -1,
    shellRight: rect ? Math.round(rect.right) : -1,
    ambientHeight: parseFloat(getComputedStyle(root, "::after").height) || 0,
    ambientBg: getComputedStyle(root, "::after").backgroundImage,
    headerBg: bgImage(".topbar") || bgImage(".map-header"),
    stageBg: bgImage(".main-stage") || bgImage(".map-app .stage-main"),
    buttonBg: btn ? getComputedStyle(btn).backgroundImage : "",
    buttonColor: btn ? getComputedStyle(btn).color : "",
  };
})()`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
  console.log(`${ok ? "  PASS  " : "  FAIL  "}${name}${detail === undefined ? "" : "  [" + detail + "]"}`);
}

function rgbLuma(value) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || "");
  if (!m) return -1;
  return Math.round((Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000);
}

async function main() {
  if (!CHROME) throw new Error("找不到 Chrome/Edge；可用 CHROME_PATH 指定");
  const chrome = await launchChrome(CHROME, { debugPort: 9411, viewport: "1280,900" });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");

  const evaluate = async (expression) => {
    const res = await cdp.sessionSend(session, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res.result.value;
  };

  const open = async (url, prefs, viewport) => {
    if (viewport) {
      await cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", {
        width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: viewport[0] < 500,
      });
    }
    await cdp.sessionSend(session, "Page.navigate", { url: "about:blank" });
    await sleep(180);
    await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { try {
        localStorage.setItem(${JSON.stringify(PREF_KEY)}, ${JSON.stringify(JSON.stringify(prefs))});
        sessionStorage.setItem(${JSON.stringify(HANDLE_KEY)}, "local");
      } catch (_) {} })()`,
    });
    await cdp.sessionSend(session, "Page.navigate", { url });
    await sleep(2600);
    return evaluate(MEASURE);
  };

  const pages = [
    ["对话页", `${BASE}/app/index.html?onboarding=off&surprise=off`],
    ["剧情模式", `${BASE}/app/magic-map.html?surprise=off`],
  ];

  console.log("── 返校金 · 暗色 ──");
  for (const [label, url] of pages) {
    const m = await open(url, GOLD_DARK, [1280, 900]);
    check(`${label}：风格已落定`, m.style === "gold", m.style);
    check(`${label}：配色是纯金 #f5c518`, m.focus === "#f5c518", m.focus);
    check(`${label}：底色接近黑`, m.canvas === "#0a0a0a" && rgbLuma(m.bodyBg) <= 20, `${m.canvas} / ${m.bodyBg}`);
    check(`${label}：亮色是渐变不是平涂`, /linear-gradient|radial-gradient/.test(m.buttonBg), m.buttonBg.slice(0, 72));
    check(`${label}：金色落在顶栏渐变上`, /gradient/.test(m.headerBg), m.headerBg.slice(0, 72));
    check(`${label}：主区有金色渐变` , /gradient/.test(m.stageBg), m.stageBg.slice(0, 72));
    check(`${label}：氛围只占顶部一条`, m.ambientHeight > 0 && m.ambientHeight <= m.vh * 0.5, `${m.ambientHeight}px / ${m.vh}px`);
  }

  console.log("── 灰屏兜底 ──");
  for (const [label, url] of pages) {
    await open(url, GOLD_DARK, [1280, 900]);
    const visibility = await evaluate(`(() => {
      document.documentElement.classList.add("theme-pending");
      const shell = document.getElementById("appShell") || document.querySelector(".map-app");
      return shell ? getComputedStyle(shell).visibility : "missing";
    })()`);
    check(`${label}：theme-pending 下界面仍可见`, visibility === "visible", visibility);
  }

  console.log("── 窄屏宽度（右侧不能空一块） ──");
  for (const scale of ["1", "0.9", "1.2"]) {
    for (const [label, url] of pages) {
      const m = await open(url, Object.assign({}, GOLD_DARK, { scale }), [360, 740]);
      const gap = m.innerWidth - m.shellRight;
      const overflow = m.shellLeft;
      check(`${label}：scale ${scale} 铺满宽度`, Math.abs(gap) <= 1 && Math.abs(overflow) <= 1, `left ${m.shellLeft} / right ${m.shellRight} / vw ${m.innerWidth}`);
    }
  }

  console.log("── 返校金 · 亮色 ──");
  for (const [label, url] of pages) {
    const m = await open(url, GOLD_LIGHT, [1280, 900]);
    check(`${label}：亮色下风格仍生效`, m.style === "gold" && m.theme === "light", `${m.style}/${m.theme}`);
    check(`${label}：亮色下按钮是渐变`, /gradient/.test(m.buttonBg), m.buttonBg.slice(0, 72));
  }

  console.log("── 返校季第一封信：勾选「保留返校金」必须真的生效 ──");
  {
    const url = `${BASE}/app/index.html?onboarding=off&surprise=on`;
    await cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.sessionSend(session, "Page.navigate", { url: "about:blank" });
    await sleep(180);
    await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { try {
        localStorage.setItem(${JSON.stringify(PREF_KEY)}, ${JSON.stringify(JSON.stringify(Object.assign({}, GOLD_DARK, { style: "default", ambient: false })))});
        localStorage.removeItem("task29.seasonal-surprise.v1.local");
        sessionStorage.setItem(${JSON.stringify(HANDLE_KEY)}, "local");
      } catch (_) {} })()`,
    });
    await cdp.sessionSend(session, "Page.navigate", { url });
    await sleep(3400);
    const before = await evaluate(`(() => ({
      letter: !!document.getElementById("seasonLetterLayer"),
      checked: !!(document.getElementById("seasonAmbientToggle") || {}).checked,
      style: document.documentElement.dataset.style,
    }))()`);
    check("信件出现且默认勾选", before.letter && before.checked, JSON.stringify(before));
    check("打开信时先给一层金色预览", before.style === "gold", before.style);
    await evaluate(`(() => { const b = document.getElementById("seasonLetterEnter"); if (b) b.click(); return true; })()`);
    await sleep(1200);
    const after = await evaluate(`(() => ({
      style: document.documentElement.dataset.style,
      ambient: document.documentElement.classList.contains("season-ambient-on"),
      savedStyle: (JSON.parse(localStorage.getItem(${JSON.stringify(PREF_KEY)}) || "null") || {}).style,
      savedAmbient: (JSON.parse(localStorage.getItem(${JSON.stringify(PREF_KEY)}) || "null") || {}).ambient,
    }))()`);
    check("点「推开城堡大门」后金色生效", after.style === "gold" && after.ambient === true, JSON.stringify(after));
    check("金色写进了外观偏好（刷新后仍在）", after.savedStyle === "gold" && after.savedAmbient === true, `${after.savedStyle}/${after.savedAmbient}`);
  }

  console.log("── 返校季第一封信：取消勾选不能把风格锁死成金色 ──");
  {
    const url = `${BASE}/app/index.html?onboarding=off&surprise=on`;
    await cdp.sessionSend(session, "Page.navigate", { url: "about:blank" });
    await sleep(180);
    await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { try {
        localStorage.setItem(${JSON.stringify(PREF_KEY)}, ${JSON.stringify(JSON.stringify(Object.assign({}, GOLD_DARK, { style: "default", ambient: false })))});
        localStorage.removeItem("task29.seasonal-surprise.v1.local");
        sessionStorage.setItem(${JSON.stringify(HANDLE_KEY)}, "local");
      } catch (_) {} })()`,
    });
    await cdp.sessionSend(session, "Page.navigate", { url });
    await sleep(3400);
    await evaluate(`(() => {
      const box = document.getElementById("seasonAmbientToggle");
      if (box) { box.checked = false; box.dispatchEvent(new Event("change", { bubbles: true })); }
      const b = document.getElementById("seasonLetterEnter");
      if (b) b.click();
      return true;
    })()`);
    await sleep(1200);
    const off = await evaluate(`(() => ({
      style: document.documentElement.dataset.style,
      ambient: document.documentElement.classList.contains("season-ambient-on"),
      savedStyle: (JSON.parse(localStorage.getItem(${JSON.stringify(PREF_KEY)}) || "null") || {}).style,
      savedAmbient: (JSON.parse(localStorage.getItem(${JSON.stringify(PREF_KEY)}) || "null") || {}).ambient,
    }))()`);
    check("取消勾选后回到默认配色", off.style === "default" && off.ambient === false, JSON.stringify(off));
    check("取消勾选后偏好里也没有金色", off.savedStyle === "default" && off.savedAmbient === false, `${off.savedStyle}/${off.savedAmbient}`);
  }

  cdp.close();
  try { chrome.proc.kill(); } catch (_) {}

  const failed = results.filter((r) => !r.ok);
  console.log(`\nGOLD_VISUAL=${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("失败项：" + failed.map((f) => f.name).join("；"));
    process.exit(1);
  }
}

main().catch((error) => { console.error("CHECK_FAIL", error.message); process.exit(1); });
