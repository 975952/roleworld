"use strict";

/*
 * viewport-check.cjs —— 多视口布局回归（自带静态服务与假模型端点，不联网）
 *
 * 为什么单独一套：本项目 UI 迭代很频繁，而"窄屏能不能用"以前只有 1280 / 360 两个点、
 * 且要外部先起服务。这里自己起服务、覆盖手机到桌面五个视口，盯的是**能不能用**而不是好不好看：
 *
 *   - 页面不许横向溢出（最常见的移动端毛病）
 *   - 「本次请求」弹层：在视口内、内容可滚动、关闭按钮可达可点
 *   - 「角色记忆」面板：同上
 *   - 消息旁的「记错 / 编造」按钮：触屏上要够大好点（命中区 ≥ 44px 高）
 *   - 输入框不能被压到看不见、发送键必须在视口内
 *
 * 用法：node tests/viewport-check.cjs
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { CDP, launchChrome, sleep } = require("./cdp.js");

const APP = path.join(__dirname, "..", "app");
const PACKS = path.join(__dirname, "..", "packs");
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((candidate) => { try { return fs.existsSync(candidate); } catch (_) { return false; } });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const VIEWPORTS = [
  { label: "桌面 1440×900", width: 1440, height: 900 },
  { label: "笔记本 1280×800", width: 1280, height: 800 },
  { label: "平板 768×1024", width: 768, height: 1024 },
  { label: "手机 390×844", width: 390, height: 844 },
  { label: "小手机 320×568", width: 320, height: 568 },
];

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 空请求体 */ }
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        for (const piece of ["收到了。", "这是一条用于布局回归的回复。"]) {
          res.write("data: " + JSON.stringify({ model: "synthetic", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "synthetic", choices: [{ message: { role: "assistant", content: "收到了。" }, finish_reason: "stop" }] }));
      return;
    }

    if (p === "/") p = "/index.html";
    const root = p.startsWith("/packs/") ? PACKS : APP;
    const rel = p.startsWith("/packs/") ? p.slice("/packs/".length) : p.replace(/^\/+/, "");
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error });
    console.log("  FAIL  " + name + "\n        " + (error && error.message ? error.message : String(error)));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!CHROME) {
    console.log("找不到 Chrome/Edge，可用 CHROME_PATH 指定");
    process.exitCode = 1;
    return;
  }
  const { server, port } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9418 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");

  const fixture = `
    (function () {
      try { localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-flash" })); } catch (_) {}
      window.__ROLEWORLD_FIXTURE__ = {
        characters: [
          { avatar: "布局测试角色.png", name: "布局测试角色", description: "用于布局回归的合成角色。",
            personality: "平静", scenario: "测试场景", first_mes: "你好。", mes_example: "",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "布局测试角色", description: "用于布局回归的合成角色。", personality: "平静",
                    scenario: "测试场景", first_mes: "你好。", mes_example: "", tags: [] } }
        ],
        worlds: [],
        settings: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash",
                    // 引导浮层（.rw-ob）是固定定位、盖满整屏的：不跳过它，量到的是"被盖住的界面"，
                    // 真人那时候什么都点不到。布局回归要量真正能用的那一层。
                    tutorial_seen: true }
      };
    })();
  `;
  const fixtureScript = await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixture });

  const evaluate = async (expression) => {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) {
      throw new Error("页面脚本异常：" + (out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text));
    }
    return out.result.value;
  };

  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时：" + expression);
      await sleep(200);
    }
  };

  const setViewport = (viewport) => cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 500,
  });

  const open = async (viewport) => {
    await setViewport(viewport);
    await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html?onboarding=off&surprise=off" });
    await waitFor("window.TASK21_READY === true", 30000);
  };

  // 发一轮消息：让消息行、标记按钮、台账都有内容
  const sendOnce = async () => {
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '布局回归用的一句话';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 25000);
  };

  // 通用布局体检：横向溢出 + 关键控件是否可见
  const layoutProbe = () => evaluate(`(() => {
    const doc = document.documentElement;
    const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
    const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      overflow,
      input: box('#messageInput'),
      send: box('#sendButton'),
      flag: box('.message-flag'),
      flagCount: document.querySelectorAll('.message-flag').length,
    };
  })()`);

  console.log("== 多视口布局回归 ==");

  for (const viewport of VIEWPORTS) {
    await open(viewport);
    await sendOnce();

    await check(`${viewport.label}：没有横向溢出`, async () => {
      const probe = await layoutProbe();
      const slack = viewport.width < 500 ? 2 : 4; // 亚像素容差
      assert(probe.overflow <= slack,
        `横向溢出 ${probe.overflow}px（视口 ${probe.innerWidth}）`);
    });

    await check(`${viewport.label}：输入框与发送键在视口内、可用`, async () => {
      const probe = await layoutProbe();
      assert(probe.input && probe.input.h >= 28, "输入框高度异常：" + JSON.stringify(probe.input));
      assert(probe.send && probe.send.w >= 28, "发送键太小或不存在：" + JSON.stringify(probe.send));
      assert(probe.send.bottom <= probe.innerHeight + 1, "发送键超出视口底部：" + JSON.stringify(probe.send));
      assert(probe.input.bottom <= probe.innerHeight + 1, "输入框超出视口底部：" + JSON.stringify(probe.input));
    });

    await check(`${viewport.label}：「本次请求」弹层能开、能关、内容可滚动`, async () => {
      await evaluate("window.TASK21.openRequestPeek(); true");
      await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const surface = document.querySelector('#requestPeek');
        const card = surface.querySelector('.request-peek-card');
        const body = surface.querySelector('.request-peek-body');
        const close = surface.querySelector("[data-action='close-request-peek']");
        const r = card.getBoundingClientRect();
        const c = close.getBoundingClientRect();
        const doc = document.documentElement;
        return {
          inView: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          cardRect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
          contentScrollable: body.scrollHeight <= body.clientHeight || getComputedStyle(body).overflowY !== 'visible',
          closeReachable: c.top >= 0 && c.bottom <= window.innerHeight && c.width >= 28 && c.height >= 20,
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        };
      })()`);
      assert(info.inView, "弹层超出视口：" + JSON.stringify(info.cardRect));
      assert(info.contentScrollable, "弹层内容不可滚动，长内容会被裁掉");
      assert(info.closeReachable, "关闭按钮不可达或过小");
      assert(info.overflow <= 4, "打开弹层后出现横向溢出：" + info.overflow);
      await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
      await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
    });

    await check(`${viewport.label}：「角色记忆」面板能开、能关`, async () => {
      await evaluate("window.TASK21.openMemoryPanel(); true");
      await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const card = document.querySelector('#memoryPanel .request-peek-card');
        const close = document.querySelector("#memoryPanel [data-action='close-memory']");
        const r = card.getBoundingClientRect();
        const c = close.getBoundingClientRect();
        const doc = document.documentElement;
        return {
          inView: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          closeReachable: c.top >= 0 && c.bottom <= window.innerHeight && c.width >= 28,
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        };
      })()`);
      assert(info.inView, "记忆面板超出视口");
      assert(info.closeReachable, "记忆面板关闭按钮不可达");
      assert(info.overflow <= 4, "打开记忆面板后出现横向溢出：" + info.overflow);
      await evaluate("document.querySelector(\"#memoryPanel [data-action='close-memory']\").click(); true");
      await waitFor("document.querySelector('#memoryPanel').hidden === true", 8000);
    });

    await check(`${viewport.label}：发送前预估那一行不挤坏输入区`, async () => {
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '预估一下这句大概会发多少内容出去';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const info = await evaluate(`(() => {
        const node = document.querySelector('#chatEstimateLine');
        const cost = document.querySelector('#chatCostLine');
        const send = document.querySelector('#sendButton');
        const r = node.getBoundingClientRect();
        const c = cost.getBoundingClientRect();
        const s = send.getBoundingClientRect();
        const overlap = (a, b) => !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5
          || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
        return {
          hidden: node.hidden,
          display: getComputedStyle(node).display,
          text: node.textContent,
          sendWidth: Math.round(s.width),
          overlapsCost: node.hidden ? false : overlap(r, c),
          overlapsSend: node.hidden ? false : overlap(r, s),
          inViewport: node.hidden ? true : (r.left >= -1 && r.right <= window.innerWidth + 1),
        };
      })()`);
      if (viewport.width <= 560) {
        // 窄屏上它让位（发送键和输入框优先），但不能把发送键挤小。
        assert(info.display === "none" || info.hidden, "窄屏上预估行应当让位：" + JSON.stringify(info));
      } else {
        assert(info.hidden === false, "宽屏上应当显示预估行：" + JSON.stringify(info));
        assert(/这次约|输出上限/.test(info.text), "预估行内容不对：" + info.text);
      }
      assert(info.overlapsCost === false && info.overlapsSend === false && info.inViewport,
        "预估行压到了别的控件：" + JSON.stringify(info));
      assert(info.sendWidth >= 28, "预估行把发送键挤小了：" + JSON.stringify(info));
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    });

    await check(`${viewport.label}：「关系档案」表单能开、能滚、按钮点得到`, async () => {
      await evaluate("window.TASK21.openCompanionDialog(); true");
      await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const surface = document.querySelector('#companionDialog');
        const card = surface.querySelector('.memory-modal');
        const save = document.querySelector('#companionSaveButton');
        const enabled = document.querySelector('#companionEnabled');
        const doc = document.documentElement;
        const r = card.getBoundingClientRect();
        const s = save.getBoundingClientRect();
        return {
          // 表单比屏幕高时必须自己滚，否则底部的"保存"永远点不到。
          scrollable: card.scrollHeight <= card.clientHeight + 1 || getComputedStyle(card).overflowY === 'auto',
          cardInView: r.top >= -1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          saveReachable: s.width >= 28 && s.height >= 24,
          // 开关本身要能被点到（窄屏上很容易被挤成一条缝）。
          enabledHit: (() => { const e = enabled.getBoundingClientRect(); return e.width >= 13 && e.height >= 13; })(),
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        };
      })()`);
      assert(info.scrollable, "表单不可滚动，矮屏上保存按钮会点不到");
      assert(info.cardInView, "表单横向超出视口：" + JSON.stringify(info));
      assert(info.saveReachable, "保存按钮不可达");
      assert(info.enabledHit, "伴侣模式开关太小，点不到");
      assert(info.overflow <= 4, "打开关系档案后出现横向溢出：" + info.overflow);
      await evaluate("document.querySelector(\"#companionDialog [data-action='close-companion']\").click(); true");
      await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    });

    await check(`${viewport.label}：触屏上「记错 / 编造」按钮够大好点`, async () => {
      const probe = await evaluate(`(() => {
        const button = document.querySelector('.message-flag');
        if (!button) return { exists: false };
        const r = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          exists: true,
          w: Math.round(r.width),
          h: Math.round(r.height),
          fontSize: parseFloat(style.fontSize) || 0,
          opacity: parseFloat(style.opacity),
          count: document.querySelectorAll('.message-flag').length,
        };
      })()`);
      assert(probe.exists, "没有找到「记错 / 编造」按钮");
      assert(probe.count >= 2, "标记按钮数量不对：" + probe.count);
      // 命中区是最硬的判据：窄屏（可能用手指点）要 ≥44px。
      // 刻意不把 opacity 当判据 —— 有些环境把 hover 报成 hover，媒体查询判不准；
      // 而"够不够大好点"这件事只跟尺寸有关。
      if (viewport.width <= 760) {
        assert(probe.h >= 44 && probe.w >= 44,
          "窄屏上标记按钮命中区不足 44px：" + JSON.stringify(probe));
      } else {
        assert(probe.h >= 20 && probe.w >= 20,
          "桌面标记按钮命中区过小：" + JSON.stringify(probe));
      }
    });

    // 每个视口检查完把弹层状态清掉，避免影响下一个视口
    await evaluate("try { window.TASK21.closeRequestPeek(); window.TASK21.closeMemoryPanel(); window.TASK21.closeCompanionDialog(); } catch (_) {} true");
  }

  await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
  server.close();
  try { chrome.process.kill(); } catch (_) {}

  console.log("");
  console.log(failures
    ? `VIEWPORT_CHECK=${results.length - failures}/${results.length}（有 ${failures} 项不达标）`
    : `VIEWPORT_CHECK=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
