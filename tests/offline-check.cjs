"use strict";

/*
 * offline-check.cjs —— PWA 离线壳与"有新版本"提示（不需要真实模型）
 *
 * 覆盖：
 *   ① 清单（manifest.webmanifest）能解析、图标真的能取到；
 *   ② 离线壳注册成功，并且**接管了这个页面**（navigator.serviceWorker.controller）；
 *   ③ **关掉服务器之后刷新，界面照样打得开**，而且本机的对话还看得到
 *      —— 这才是"断网也能用"的真正含义（数据本来就在本机）；
 *   ④ 线上发了新版（version.json 变了）时会提示刷新；没变时不打扰。
 *
 * 全部离线合成：自带静态服务与假模型端点，不联网、不碰真实数据。
 * 需要本机装有 Chrome / Chromium（可用 CHROME_PATH 指定）。
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { CDP, launchChrome, sleep } = require("./cdp.js");

const APP = path.join(__dirname, "..", "app");

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && fs.existsSync(candidate)) || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

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

/** 静态服务 + 假模型端点；servedVersion 可在运行中改，用来模拟"线上发了新版"。 */
function startServer() {
  const state = { servedVersion: "0.1.14", notice: false, requests: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);
    state.requests += 1;

    if (p === "/__version") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try { state.servedVersion = JSON.parse(raw).version || state.servedVersion; } catch (_) {}
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    // 切换"平台提示页"：模拟托管平台在首次访问时插进来的那一页。
    if (p === "/__notice") {
      state.notice = !state.notice;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(state.notice ? "on" : "off");
      return;
    }

    if (state.notice && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=\"utf-8\"><title>平台提示页</title>"
        + "<body><h1>平台提示页</h1><p>这是托管平台插进来的一页，不是应用本身。</p></body>");
      return;
    }

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        for (const piece of ["离线壳测试：", "这是合成回复。"]) {
          res.write("data: " + JSON.stringify({ model: "synthetic", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "synthetic", choices: [{ message: { role: "assistant", content: "收到了。" } }] }));
      return;
    }

    if (p === "/") p = "/index.html";
    const file = path.join(APP, p.replace(/^\/+/, ""));
    if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    if (p === "/version.json") {
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
      res.end(JSON.stringify({ version: state.servedVersion }));
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}

async function main() {
  if (!CHROME) {
    console.log("找不到 Chrome/Edge，可用 CHROME_PATH 指定");
    process.exitCode = 1;
    return;
  }
  const { server, port, state } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9421 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");

  const fixture = `
    (function () {
      try {
        localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-flash" }));
        sessionStorage.setItem("task27a.current-account-handle.v1", "local");
      } catch (_) {}
      window.__ROLEWORLD_FIXTURE__ = {
        characters: [
          { avatar: "离线测试角色.png", name: "离线测试角色", description: "用于离线回归的合成角色。",
            personality: "平静", scenario: "测试场景", first_mes: "你好。", mes_example: "",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "离线测试角色", description: "用于离线回归的合成角色。", personality: "平静",
                    scenario: "测试场景", first_mes: "你好。", mes_example: "", tags: [] } }
        ],
        worlds: [],
        chats: [
          { avatar: "离线测试角色.png", file_name: "离线-以前的对话.jsonl", messages: [
            { chat_metadata: {}, user_name: "我", character_name: "离线测试角色" },
            { name: "我", is_user: true, mes: "断网之前说的一句：钥匙在花盆下面", send_date: "2026-09-01T10:00:00.000Z" },
            { name: "离线测试角色", is_user: false, mes: "记住了。", send_date: "2026-09-01T10:00:05.000Z" }
          ] }
        ],
        settings: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash" }
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

  const boot = async () => {
    await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html" });
    await waitFor("window.TASK21_READY === true", 30000);
    await sleep(600);
  };

  console.log("== PWA 清单与离线壳 ==");

  // 先真正打开应用，并清一次库让 fixture 生效（与其它套件同一套路）。
  await boot();
  await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); return true; })()");
  await boot();
  await waitFor("!!window.ROLEWORLD_PWA", 15000);

  await check("清单能解析，图标真的取得到", async () => {
    const manifest = await evaluate(`fetch('manifest.webmanifest').then((r) => r.json())`);
    assert(manifest.name && manifest.short_name, "清单缺名称：" + JSON.stringify(manifest));
    assert(manifest.start_url === "./index.html", "start_url 不对：" + manifest.start_url);
    assert(manifest.scope === "./", "scope 不对：" + manifest.scope);
    assert(manifest.display === "standalone", "display 应当是 standalone：" + manifest.display);
    assert(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "图标太少：" + JSON.stringify(manifest.icons));
    const sizes = manifest.icons.map((icon) => icon.sizes).join(",");
    assert(sizes.indexOf("192x192") >= 0 && sizes.indexOf("512x512") >= 0,
      "清单需要 192 与 512 两种尺寸（浏览器按这个决定能不能装）：" + sizes);
    const fetched = await evaluate(`(async () => {
      const rows = ${JSON.stringify(manifest.icons.map((icon) => icon.src))};
      const out = [];
      for (const src of rows) {
        const response = await fetch(src);
        out.push({ src: src, ok: response.ok, bytes: (await response.blob()).size });
      }
      return out;
    })()`);
    for (const row of fetched) {
      assert(row.ok && row.bytes > 0, "图标取不到：" + JSON.stringify(row));
    }
    // index.html 要真的挂上清单，否则前面这些都没用。
    assert(await evaluate("!!document.querySelector('link[rel=manifest]')"), "index.html 没有引用清单");
  });

  await check("离线壳注册成功并接管了这个页面", async () => {
    // 注意：注册是否成功要以**这一次页面加载**的 ROLEWORLD_PWA.state 为准 ——
    // registration.active 在上一次导航之后就存在了，只看它会提前返回。
    await waitFor("window.ROLEWORLD_PWA && window.ROLEWORLD_PWA.state.offlineCapable === true", 20000);
    const info = await evaluate(`(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        scope: registration ? registration.scope : '',
        state: registration && registration.active ? registration.active.state : 'none',
        controlled: !!navigator.serviceWorker.controller,
        offlineCapable: window.ROLEWORLD_PWA.state.offlineCapable,
      };
    })()`);
    assert(info.offlineCapable === true, "注册没有成功：" + JSON.stringify(info));
    assert(info.state === "activated", "离线壳没有激活：" + JSON.stringify(info));
    assert(String(info.scope).indexOf("/app/") >= 0 || String(info.scope).endsWith("/"),
      "作用域不对：" + info.scope);
    // 第一次打开时 controller 可能还是空的（要等下一次导航才接管），刷新一次再确认。
    await boot();
    const controlled = await waitFor("!!navigator.serviceWorker.controller", 15000);
    assert(controlled === true, "刷新之后页面仍然没有被离线壳接管");
  });

  console.log("== 新版提示 ==");

  await check("线上没发新版时不打扰", async () => {
    const result = await evaluate("window.ROLEWORLD_PWA.checkVersion()");
    assert(result && result.ok === true, "版本检查没成功：" + JSON.stringify(result));
    assert(result.changed === false, "版本没变却报有新版本：" + JSON.stringify(result));
    assert(await evaluate("document.querySelector('#updatePill').hidden === true"), "没新版却弹了提示");
  });

  await check("线上发了新版：提示刷新，点一下会重新加载", async () => {
    await fetch(base + "/__version", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "9.9.9" }),
    });
    const result = await evaluate("window.ROLEWORLD_PWA.checkVersion()");
    assert(result && result.changed === true, "换了版本却没认出来：" + JSON.stringify(result));
    const pill = await waitFor(`(() => {
      const node = document.querySelector('#updatePill');
      return node && !node.hidden ? node.textContent : '';
    })()`, 8000);
    assert(pill.indexOf("9.9.9") >= 0, "提示里应当写出新版本号：" + pill);
    // 点它 = 让新壳接管 + 刷新：这里只验证绑上了（真点会导航，后面的用例还要用这个页面）。
    const bound = await evaluate(`(() => {
      const node = document.querySelector('#updatePill');
      return typeof window.ROLEWORLD_PWA.reloadForUpdate === 'function' && !!node;
    })()`);
    assert(bound, "提示没有可用的刷新动作");
  });

  await check("回到标签页时会自己再查一次版本", async () => {
    // 模拟"页面开着没关，用户切走又切回来"：只靠 visibilitychange，不用任何定时器。
    await fetch(base + "/__version", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "0.1.14" }),
    });
    // 先把基准改成 9.9.9（模拟"这个页面加载时线上是 9.9.9"），再触发可见事件。
    const result = await evaluate(`(async () => {
      window.ROLEWORLD_PWA.state.baseline = '9.9.9';
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 800));
      return { updateReady: window.ROLEWORLD_PWA.state.updateReady, latest: window.ROLEWORLD_PWA.state.latest };
    })()`);
    assert(result.updateReady === true, "切回标签页时没有认出线上已经变了：" + JSON.stringify(result));
    assert(result.latest === "0.1.14", "抓到的线上版本不对：" + JSON.stringify(result));
  });

  console.log("== 断网之后 ==");

  await check("平台提示页不会被当成应用缓存下来", async () => {
    // 托管平台首次访问会插一个提示页（用户实际遇到过）。它也是 200 + HTML，
    // 如果被当成外壳缓存，以后断网打开看到的就是提示页 —— 这里专门盯住这件事。
    await fetch(base + "/__notice", { method: "POST" });
    await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html" });
    await waitFor("document.body.textContent.indexOf('平台提示页') >= 0", 20000);
    // 网络优先：有网时用户看到的就是网络给的那一页（提示页），这没问题；
    // 关键是**缓存里那份外壳没被覆盖**。
    const cached = await evaluate(`(async () => {
      const hit = await caches.match('./index.html') || await caches.match('./');
      return hit ? await hit.text() : '';
    })()`);
    assert(cached.indexOf("角色世界") >= 0,
      "缓存里的外壳被平台提示页覆盖了（以后断网会打开提示页）：" + JSON.stringify(String(cached).slice(0, 80)));
    // 关掉提示页开关，回到正常状态。
    await fetch(base + "/__notice", { method: "POST" });
    await boot();
  });

  await check("关掉服务器再刷新：界面照样打得开，本机对话还在", async () => {
    // 先把数据确认一遍（在线状态下的基线）。
    const before = await evaluate("(async () => (await window.STApi.listChats('离线测试角色.png')).map((c) => c.file_name))()");
    assert(before.length === 1, "在线时应当能看到 fixture 里那段对话：" + JSON.stringify(before));

    // 关掉服务器（等于拔网线/断网）。
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html" });
    // 导航请求交给离线壳：页面仍然要能起来。
    await waitFor("window.TASK21_READY === true", 30000);
    await sleep(800);

    const info = await evaluate(`(async () => ({
      title: document.title,
      ready: window.TASK21_READY === true,
      controlled: !!navigator.serviceWorker.controller,
      chats: (await window.STApi.listChats('离线测试角色.png')).map((c) => c.file_name),
      characters: (await window.STApi.listCharacters()).map((c) => c.name),
      styled: !!document.querySelector('link[rel=stylesheet]') && getComputedStyle(document.body).backgroundColor,
    }))()`);
    assert(info.title.indexOf("角色世界") >= 0, "离线打开的不是应用页面：" + JSON.stringify(info));
    assert(info.characters.length >= 1, "离线时角色卡读不到了（数据应当在本机）：" + JSON.stringify(info));
    assert(info.chats.length === 1 && info.chats[0].indexOf("以前的对话") >= 0,
      "离线时以前的对话不见了：" + JSON.stringify(info.chats));
    assert(info.styled, "离线时样式表没加载（壳不完整）：" + JSON.stringify(info));

    // 离线时点开那段对话，内容要真的显示出来。
    const opened = await evaluate(`(async () => {
      const row = window.TASK21.sessionList().find((session) => String(session.fileName).indexOf('以前的对话') >= 0);
      if (!row) return { switched: false };
      await window.TASK21.selectChat(row.id);
      await new Promise((r) => setTimeout(r, 600));
      return { switched: true, text: document.querySelector('#dynamicMessages').textContent };
    })()`);
    assert(opened.switched === true, "离线时选不中那段对话");
    assert(String(opened.text).indexOf("钥匙在花盆下面") >= 0,
      "离线时对话内容没显示出来：" + JSON.stringify(String(opened.text).slice(0, 120)));

    // 离线时不能发消息（没有网就是没有网），但要在界面上说清楚，而不是转圈。
    const offlineSend = await evaluate(`(async () => {
      const input = document.querySelector('#messageInput');
      input.value = '断网了还能发吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      await new Promise((r) => setTimeout(r, 2500));
      return {
        toast: (document.querySelector('#toast') || {}).textContent || '',
        inputValue: input.value,
        pending: window.TASK21.isLiveBusy(),
      };
    })()`);
    assert(offlineSend.pending === false, "离线发送后一直卡在「正在生成」：" + JSON.stringify(offlineSend));
    assert(offlineSend.inputValue.indexOf("断网了") >= 0,
      "离线发送失败后应当把输入内容还给我：" + JSON.stringify(offlineSend));
  });

  await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
  try { chrome.proc.kill(); } catch (_) {}

  console.log("");
  console.log(failures
    ? `OFFLINE_CHECK=${results.length - failures}/${results.length}（有 ${failures} 项不达标）`
    : `OFFLINE_CHECK=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
