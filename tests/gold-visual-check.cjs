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
    shellTop: rect ? Math.round(rect.top) : -1,
    // 主区顶部到壳子顶部的缝隙（用户要求最多 0.几毫米）＋它内部到第一条内容的距离。
    mainTopGap: (() => {
      const shell = document.getElementById("appShell") || document.querySelector(".map-app");
      const main = document.querySelector(".main-stage") || document.querySelector(".stage-main");
      if (!shell || !main) return -1;
      return Math.round(main.getBoundingClientRect().top - shell.getBoundingClientRect().top);
    })(),
    firstContentGap: (() => {
      const main = document.querySelector(".main-stage");
      if (!main) return -1;
      const node = main.querySelector(".message-row, .chat-content > *, .initial-message");
      if (!node) return -1;
      return Math.round(node.getBoundingClientRect().top - main.getBoundingClientRect().top);
    })(),
    ambientHeight: parseFloat(getComputedStyle(root, "::after").height) || 0,
    // 用 content 判断"这条光带到底生成了没有"：
    // 选择器不匹配时 height 会退回 html 自身的高度（900px），会误判成"有光带"。
    ambientContent: getComputedStyle(root, "::after").content,
    ambientBg: getComputedStyle(root, "::after").backgroundImage,
    headerBg: bgImage(".topbar") || bgImage(".map-header"),
    stageBg: bgImage(".main-stage") || bgImage(".map-app .stage-main"),
    shellBg: bgImage("#appShell") || bgImage(".map-app"),
    shellBgColor: (() => { const n = document.querySelector("#appShell") || document.querySelector(".map-app"); return n ? getComputedStyle(n).backgroundColor : ""; })(),
    sidebarBg: (() => { const n = document.querySelector(".archive-sidebar"); return n ? getComputedStyle(n).backgroundColor : ""; })(),
    stageColor: (() => { const n = document.querySelector(".main-stage") || document.querySelector(".map-app .stage-main"); return n ? getComputedStyle(n).backgroundColor : ""; })(),
    sendButtonBg: (() => { const n = document.getElementById("sendButton"); return n ? getComputedStyle(n).backgroundImage : ""; })(),
    sendButtonRadius: (() => { const n = document.getElementById("sendButton"); return n ? getComputedStyle(n).borderRadius : ""; })(),
    sendButtonW: (() => { const n = document.getElementById("sendButton"); return n ? Math.round(n.getBoundingClientRect().width) : -1; })(),
    sendArrow: (() => !!document.querySelector(".send-button b"))(),
    pillBg: (() => {
      const n = document.querySelector(".plain-button") || document.querySelector(".new-conversation-button")
        || document.querySelector(".map-app .cast-chip") || document.querySelector(".map-app .map-node");
      return n ? getComputedStyle(n).backgroundColor : "";
    })(),
    fontFamily: (() => { const n = document.querySelector("#appShell") || document.querySelector(".map-app"); return n ? getComputedStyle(n).fontFamily : ""; })(),
    displayName: (() => { const n = document.getElementById("userDisplayName"); return n ? n.textContent.trim() : ""; })(),
    focusRgb: (() => {
      const hex = String(css.getPropertyValue("--focus") || "").trim().replace("#", "");
      if (!/^[0-9a-f]{6}$/i.test(hex)) return [-1, -1, -1];
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    })(),
    // 强调色的色相：用来钉住"樱不要偏红"（红=0/360，粉≈325）。
    focusHue: (() => {
      const hex = String(css.getPropertyValue("--focus") || "").trim().replace("#", "");
      if (!/^[0-9a-f]{6}$/i.test(hex)) return -1;
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (!d) return 0;
      let h = 0;
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      return Math.round((h + 360) % 360);
    })(),
    accountText: (() => { const n = document.getElementById("mapAccount"); return n ? n.textContent.trim() : ""; })(),
    buttonRadius: (() => {
      const n = document.querySelector(".primary-button") || document.querySelector(".map-button-primary");
      return n ? getComputedStyle(n).borderRadius : "";
    })(),
    // 羊皮纸是"浅底 + 深墨"的皮肤，最怕有组件还按暗色主题写死浅色文字。
    // 直接算侧栏与正文区的文字对比度，掉到 4.5 以下就算回归。
    sidebarContrast: (() => {
      const lum = (value) => {
        const parts = (String(value).match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
        if (parts.length < 3) return null;
        const lin = parts.map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      };
      const node = document.querySelector(".archive-sidebar") || document.getElementById("appShell") || document.querySelector(".map-app");
      if (!node) return 0;
      const style = getComputedStyle(node);
      const a = lum(style.color);
      let bg = lum(style.backgroundColor);
      if (bg === null || bg === 0) bg = lum(getComputedStyle(document.body).backgroundColor);
      if (a === null || bg === null) return 0;
      const ratio = (Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05);
      return Math.round(ratio * 100) / 100;
    })(),
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

function rgbParts(value) {
  // Chrome 现在会把 color-mix 的结果算成 color(srgb r g b / a) 形式，
  // 所以两种写法都要认，否则断言会拿到 -1 而误判。
  const legacy = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || "");
  if (legacy) return [Number(legacy[1]), Number(legacy[2]), Number(legacy[3])];
  const modern = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value || "");
  if (modern) return [1, 2, 3].map((i) => Math.round(Number(modern[i]) * 255));
  return [-1, -1, -1];
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
    check(`${label}：底色是暖金近黑`, m.canvas === "#14110a" && rgbLuma(m.bodyBg) <= 40, `${m.canvas} / ${m.bodyBg}`);
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

  console.log("── 樱 / 深林 / 羊皮纸 / 返校金 ──");
  const CHAT = `${BASE}/app/index.html?onboarding=off&surprise=off`;

  const sakuraDark = await open(CHAT, Object.assign({}, GOLD_DARK, { style: "sakura" }), [1280, 900]);
  check("樱（暗）：底色是中性近黑，不是粉紫染底", sakuraDark.canvas === "#0a0a0b" && rgbLuma(sakuraDark.bodyBg) <= 24, `${sakuraDark.canvas} / ${sakuraDark.bodyBg}`);
  check("樱（暗）：粉很浅", sakuraDark.focus === "#f7e5ef", sakuraDark.focus);
  // 红=0/360°。335° 往上就开始发红，所以钉在"品红—粉"这一段。
  check("樱（暗）：粉不偏红（色相在 318–330°）", sakuraDark.focusHue >= 318 && sakuraDark.focusHue <= 330, `${sakuraDark.focusHue}°`);
  {
    const [r, g, b] = sakuraDark.focusRgb;
    check("樱（暗）：粉的偏离量收到 2/5（红绿差 ≤20）", r >= 0 && r - g <= 20 && b >= g, `R${r} G${g} B${b}（红绿差 ${r - g}）`);
  }
  {
    // "不要整栏变粉"：侧栏必须回到中性；粉只允许出现在按钮上。
    const [sr, sg, sb] = rgbParts(sakuraDark.sidebarBg);
    check("樱（暗）：侧栏不泛粉（中性灰）", sr < 0 || (sr - sg <= 3 && Math.abs(sb - sg) <= 3), `${sakuraDark.sidebarBg}`);
    const [mr, mg] = rgbParts(sakuraDark.stageColor);
    check("樱（暗）：主区也不泛粉（中性）", mg < 0 || mr - mg <= 3, `${sakuraDark.stageColor}`);
    check("樱（暗）：大面不是渐变色块", !/gradient/.test(sakuraDark.stageBg), sakuraDark.stageBg.slice(0, 50) || "none");
    check("樱（暗）：开了氛围也不出现整屏宽的粉带", sakuraDark.ambientContent === "none", `content=${sakuraDark.ambientContent}`);
  }
  {
    // 中性底色也会有 r>b>g 的微小差（--main-text 本身偏暖白），
    // 所以这里比的是"红绿差"：粉底会明显拉开，中性底色不会。
    const [r, g] = rgbParts(sakuraDark.pillBg);
    const tint = g < 0 ? 0 : r - g;
    check("樱（暗）：普通按钮不再上粉（粉的面积变小）", tint <= 6, `${sakuraDark.pillBg}（红绿差 ${tint}）`);
  }
  check("樱（暗）：主按钮是明确的粉（不是接近白）", rgbParts(sakuraDark.buttonBg)[0] - rgbParts(sakuraDark.buttonBg)[1] >= 40, `${sakuraDark.buttonBg.slice(0, 52)}`);
  {
    // "发送按钮太粉了，逆天"：它应该是比主按钮更浅的粉，而不是同款实粉。
    const [r, g] = rgbParts(sakuraDark.sendButtonBg);
    const sendTint = g < 0 ? -1 : r - g;
    const primaryTint = rgbParts(sakuraDark.buttonBg)[0] - rgbParts(sakuraDark.buttonBg)[1];
    check("樱（暗）：发送按钮是比主按钮浅的粉（15–35，且更淡）", sendTint >= 15 && sendTint <= 35 && sendTint < primaryTint, `${sakuraDark.sendButtonBg.slice(0, 52)}（红绿差 ${sendTint}）`);
  }
  check("樱（暗）：顶栏是中性，不带粉光", !/gradient/.test(sakuraDark.headerBg), sakuraDark.headerBg.slice(0, 68) || "none");
  check("樱（暗）：整屏光带被取消", sakuraDark.ambientContent === "none", `content=${sakuraDark.ambientContent}`);

  const sakuraLight = await open(CHAT, Object.assign({}, GOLD_DARK, { style: "sakura", theme: "light" }), [1280, 900]);
  check("樱（亮）：粉也不偏红（色相在 318–330°）", sakuraLight.focusHue >= 318 && sakuraLight.focusHue <= 330, `${sakuraLight.focusHue}°`);
  check("樱（亮）：主按钮也是明确的粉", rgbParts(sakuraLight.buttonBg)[0] - rgbParts(sakuraLight.buttonBg)[1] >= 40, `${sakuraLight.buttonBg.slice(0, 52)}`);

  const forestDark = await open(CHAT, Object.assign({}, GOLD_DARK, { style: "forest" }), [1280, 900]);
  const fd = rgbParts(forestDark.shellBgColor);
  check("深林（暗）：底色仍是近黑", rgbLuma(forestDark.shellBgColor) <= 24, forestDark.shellBgColor);
  check("深林（暗）：绿色是更浅的浅绿", forestDark.focus === "#a7e08f", forestDark.focus);
  check("深林（暗）：绿色没把界面染绿", Math.abs(fd[1] - fd[0]) <= 4 && Math.abs(fd[1] - fd[2]) <= 4, forestDark.shellBgColor);
  check("深林：主区不加渐变", !/gradient/.test(forestDark.stageBg), forestDark.stageBg.slice(0, 60) || "none");
  check("深林：按钮是实心平涂，不是渐变", !/gradient/.test(forestDark.buttonBg), forestDark.buttonBg.slice(0, 60) || "none");

  const forestLight = await open(CHAT, Object.assign({}, GOLD_DARK, { style: "forest", theme: "light" }), [1280, 900]);
  const fl = rgbParts(forestLight.shellBgColor);
  check("深林（亮）：底色是很浅很浅的浅绿", forestLight.canvas === "#f4fbf1" && rgbLuma(forestLight.shellBgColor) >= 235 && fl[1] > fl[0] && fl[1] > fl[2], `${forestLight.canvas} / ${forestLight.shellBgColor}`);
  check("深林（亮）：照样没有渐变", !/gradient/.test(forestLight.stageBg) && !/gradient/.test(forestLight.buttonBg), forestLight.stageBg.slice(0, 40) || "none");

  for (const theme of ["dark", "light"]) {
    const label = theme === "dark" ? "暗" : "亮";
    const paper = await open(CHAT, Object.assign({}, GOLD_DARK, { style: "paper", theme }), [1280, 900]);
    check(`羊皮纸（${label}）：纸面有纤维纹理`, /repeating-linear-gradient/.test(paper.shellBg || ""), (paper.shellBg || "").slice(0, 68));
    check(`羊皮纸（${label}）：整页换成衬线体`, /serif|Georgia|Songti/i.test(paper.fontFamily), paper.fontFamily.slice(0, 60));
    check(`羊皮纸（${label}）：按钮是实心墨色，不是渐变`, !/gradient/.test(paper.buttonBg), paper.buttonBg.slice(0, 60) || "none");
    check(`羊皮纸（${label}）：圆角收成直角`, parseFloat(paper.buttonRadius) <= 4, paper.buttonRadius);
    check(`羊皮纸（${label}）：是纸不是黑底`, rgbLuma(paper.shellBgColor) >= 150, paper.shellBgColor);
    check(`羊皮纸（${label}）：侧栏文字在纸上读得清`, paper.sidebarContrast >= 4.5, paper.sidebarContrast);
  }

  const goldDark = await open(CHAT, GOLD_DARK, [1280, 900]);
  check("返校金：暖金底（接管原来那版羊皮纸的质感）", goldDark.canvas === "#14110a" && rgbLuma(goldDark.shellBgColor) <= 40, `${goldDark.canvas} / ${goldDark.shellBgColor}`);
  check("返校金：金箔纤维纹理在", /repeating-linear-gradient/.test(goldDark.shellBg || ""), (goldDark.shellBg || "").slice(0, 68));
  check("返校金：金色仍是最纯的那个", goldDark.focus === "#f5c518", goldDark.focus);

  console.log("── 发送按钮形状（键帽做长、箭头不似签子）──");
  {
    const m = await open(CHAT, GOLD_DARK, [1280, 900]);
    check("发送按钮是胶囊形（键帽做长）", m.sendButtonW > 40 && /px/.test(m.sendButtonRadius) && parseFloat(m.sendButtonRadius) >= 900, `${m.sendButtonW}px / radius ${m.sendButtonRadius}`);
    check("发送箭头是 CSS 实心箭头（不是 ↑ 字符）", m.sendArrow === true, `b 元素存在=${m.sendArrow}`);
  }

  console.log("── 主区顶部缝隙（最多 0.几毫米）──");
  for (const [label, viewport] of [["宽屏", [1280, 900]], ["窄屏", [360, 740]]]) {
    const m = await open(CHAT, GOLD_DARK, viewport);
    // 0.9mm ≈ 3.4px；这里要求 ≤2px（100% 缩放下约 0.5mm）。
    check(`${label}：主区顶部只剩发丝缝（≤2px）`, m.mainTopGap >= 0 && m.mainTopGap <= 2, `${m.mainTopGap}px（首条内容距主区顶 ${m.firstContentGap}px）`);
  }

  console.log("── 称呼（第一次引导填的那个名字）──");
  {
    const chat = await open(CHAT, Object.assign({}, GOLD_DARK, { nickname: "阿远" }), [1280, 900]);
    check("对话页：界面显示称呼而不是档案名", chat.displayName === "阿远", chat.displayName);
    const map = await open(`${BASE}/app/magic-map.html?surprise=off`, Object.assign({}, GOLD_DARK, { nickname: "阿远" }), [1280, 900]);
    check("剧情模式：也认这个称呼", /阿远/.test(map.accountText || ""), (map.accountText || "").slice(0, 40));
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
