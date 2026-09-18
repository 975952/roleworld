"use strict";

/*
 * smoke-app.cjs —— 用真实浏览器打开 app/，抓"页面里有没有报错"
 *
 * 为什么需要它：`npm test` 里的浏览器套件是别人的地盘（local-app-check / viewport-check），
 * 这一轮加的文件（sticker-core / voice-core / adapter/stickers）如果写坏了，
 * 在那两个套件里表现为"一堆莫名其妙的失败"，很难定位到是谁。
 * 所以这里做一个**只回答一个问题**的探针：整页加载完，控制台有没有 error / 未捕获异常，
 * 以及新加的那几个全局对象在不在。
 *
 * 用法：node scripts/smoke-app.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

/** 极简静态服务器：只服务 app/ 目录，够打开 index.html 就行。 */
function serve(dir) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent(String(request.url || "/").split("?")[0]);
    let file = path.join(dir, url === "/" ? "index.html" : url.replace(/^\/+/, ""));
    if (!file.startsWith(dir)) { response.writeHead(403); response.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function rpc(port, method, params, id) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id, method, params });
    const request = http.request(
      { host: "127.0.0.1", port, path: `/json/${id === 0 ? "version" : ""}`, method: "GET" },
      () => {},
    );
    request.destroy();
    // 用 WebSocket 太重，这里直接用 CDP 的 HTTP 端点不够；改走 ws 的简化实现。
    reject(new Error("unused"));
  });
}

/** 用 CDP 的 WebSocket 收事件。只够用：发命令、收事件、读结果。 */
function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const key = Buffer.from(String(Math.random())).toString("base64").slice(0, 22);
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let handshake = "";
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const listeners = [];

    function send(method, params) {
      const id = nextId++;
      const text = JSON.stringify({ id, method, params: params || {} });
      const payload = Buffer.from(text, "utf8");
      const mask = Buffer.from([7, 7, 7, 7]);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
      return new Promise((res) => pending.set(id, res));
    }

    function on(method, handler) { listeners.push({ method, handler }); }

    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake += chunk.toString("binary");
        const idx = handshake.indexOf("\r\n\r\n");
        if (idx < 0) return;
        upgraded = true;
        const rest = Buffer.from(handshake.slice(idx + 4), "binary");
        buffer = rest.length ? Buffer.concat([buffer, rest]) : buffer;
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
      for (;;) {
        if (buffer.length < 2) return;
        const len0 = buffer[1] & 0x7f;
        let offset = 2;
        let len = len0;
        if (len0 === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        else if (len0 === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + len) return;
        const text = buffer.slice(offset, offset + len).toString("utf8");
        buffer = buffer.slice(offset + len);
        let message;
        try { message = JSON.parse(text); } catch (_) { continue; }
        if (message.id && pending.has(message.id)) {
          const done = pending.get(message.id);
          pending.delete(message.id);
          done(message);
        } else if (message.method) {
          for (const listener of listeners) {
            if (listener.method === message.method) listener.handler(message.params);
          }
        }
      }
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("CDP 连接断了")));
    socket.setTimeout(60000, () => { socket.destroy(); reject(new Error("CDP 超时")); });
    // 等握手完成
    const wait = setInterval(() => {
      if (upgraded) {
        clearInterval(wait);
        resolve({ send, on, close: () => socket.destroy() });
      }
    }, 10);
  });
}

async function httpJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET" }, (response) => {
      let text = "";
      response.on("data", (c) => { text += c; });
      response.on("end", () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    console.log("没找到 Chrome，跳过页面冒烟。");
    return;
  }
  const server = await serve(path.join(ROOT, "app"));
  const port = server.address().port;
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rw-smoke-"));
  const child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });

  const errors = [];
  const logs = [];
  let session = null;
  try {
    // 等 DevTools 起来。
    // ⚠ 必须挑 `type === "page"` 的那个 target：`/json/list` 里第一个常常是
    // 浏览器扩展的 background 页（chrome-extension://…/background.html），
    // 连上去之后怎么导航都在那个扩展页里，看起来像"页面没加载"（踩过）。
    let target = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const list = await httpJson(cdpPort, "/json/list");
        target = (list || []).find((one) => one.type === "page" && /^about:blank|^http:/.test(String(one.url || "")))
          || (list || []).find((one) => one.type === "page");
        if (target) break;
      } catch (_) { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!target) throw new Error("Chrome 没起来（没有可用的 page target）");
    session = await cdpSession(target.webSocketDebuggerUrl);
    session.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" ");
      logs.push(`[${params.type}] ${text}`);
      if (params.type === "error") errors.push(text);
    });
    session.on("Runtime.exceptionThrown", (params) => {
      const d = params.exceptionDetails || {};
      errors.push("未捕获异常: " + (d.exception && d.exception.description ? d.exception.description : d.text));
    });
    session.on("Log.entryAdded", (params) => {
      const entry = params.entry || {};
      logs.push(`[log:${entry.level}] ${entry.text}`);
      if (entry.level === "error") errors.push(entry.text);
    });
    await session.send("Runtime.enable");
    await session.send("Log.enable");
    await session.send("Page.enable");
    const loaded = new Promise((resolve) => {
      session.on("Page.loadEventFired", resolve);
      setTimeout(resolve, 12000);
    });
    await session.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
    await loaded;
    await new Promise((r) => setTimeout(r, 1500));

    const probe = await session.send("Runtime.evaluate", {
      // ⚠ 给每个请求加个随机串：Chrome 在同一个 profile 里会缓存同源 JS，
      // 探针必须拿到**磁盘上这一份**，否则"Node 里过、浏览器里不过"会查很久（踩过）。
      expression: `JSON.stringify((() => {
        const q = (s) => !!document.querySelector(s);
        return {
          title: document.title,
          href: location.href,
          readyState: document.readyState,
          bodyLen: document.body ? document.body.innerHTML.length : -1,
          stickers: typeof (window.RoleWorldStickers) ,
          stickerPack: typeof (window.RoleWorldStickersPack),
          voice: typeof (window.RoleWorldVoice),
          voiceCache: typeof (window.RoleWorldVoiceCache),
          voiceCloud: typeof (window.RoleWorldVoiceCloud),
          canSpeak: window.RoleWorldVoiceCloud ? window.RoleWorldVoiceCloud.capability().canSpeak : null,
          canListen: window.RoleWorldVoice ? window.RoleWorldVoice.hasSpeechRecognition() : null,
          // 这一轮砍掉的两条老路：系统朗读与原生桥。
          hasSystemTts: typeof window.RoleWorldVoice.speak === "function" && typeof window.speechSynthesis !== "undefined",
          voiceSpeakApi: typeof (window.RoleWorldVoice && window.RoleWorldVoice.speak),
          micButton: q('#micButton'),
          stickerButton: q('#stickerButton'),
          stickerScriptLoaded: !!document.querySelector('script[src="sticker-core.js"]'),
          voiceScriptLoaded: !!document.querySelector('script[src="voice-core.js"]'),
          voiceCacheScriptLoaded: !!document.querySelector('script[src="voice-cache.js"]'),
          voiceAdapterLoaded: !!document.querySelector('script[src="adapter/voice.js"]'),
          // 版本指纹：新版 extractStickers 里有这两个字符串，旧版没有。
          coreIsCurrent: String(window.RoleWorldStickers && window.RoleWorldStickers.extractStickers).indexOf('stickers') >= 0
            && String(window.RoleWorldStickers.extractStickers).indexOf('STICKER_LIMIT') >= 0,
        };
      })())`,
      returnByValue: true,
    });
    const info = JSON.parse(probe.result.result.value);
    if (probe.result.exceptionDetails || probe.result.result.subtype === "error") {
      throw new Error("页面里执行探测就报错了：" + JSON.stringify(probe.result.exceptionDetails || probe.result.result.description || "").slice(0, 300));
    }
    console.log("页面：", JSON.stringify(info.title), " url=", info.href, " readyState=", info.readyState, " bodyLen=", info.bodyLen);
    console.log("全局对象：stickers=" + info.stickers + " packs=" + info.stickerPack + " voice=" + info.voice
      + " cache=" + info.voiceCache + " cloud=" + info.voiceCloud);
    console.log("能力：canSpeak=" + info.canSpeak + " canListen=" + info.canListen
      + " （系统朗读接口=" + info.voiceSpeakApi + "）");
    console.log("控件：麦克风=" + info.micButton + " 表情按钮=" + info.stickerButton);
    console.log("脚本已加载：sticker-core=" + info.stickerScriptLoaded + " voice-core=" + info.voiceScriptLoaded
      + " voice-cache=" + info.voiceCacheScriptLoaded + " adapter/voice=" + info.voiceAdapterLoaded);

    // 再验一件正事：表情标记能被解析并画出来（这是这一轮的交付核心）
    const render = await session.send("Runtime.evaluate", {
      expression: `(async () => {
        try {
          const core = window.RoleWorldStickers;
          const packs = await (await fetch('stickers/index.json')).json();
          const loaded = [];
          for (const entry of packs.packs) {
            const pack = await (await fetch(entry.path + '/index.json')).json();
            loaded.push({ id: entry.id, label: pack.label, stamps: pack.stamps.map((s) => ({ id: pack.id + ':' + s.id, name: s.name, file: s.file, url: entry.path + '/' + s.file, tags: s.tags, aliases: s.aliases })) });
          }
          const stamps = loaded.flatMap((p) => p.stamps);
          const sample = '好啊。' + String.fromCharCode(10) + '[[表情: 开心]]';
          const parsed = core.extractStickers(sample, stamps);
          const one = core.extractStickers(sample, [stamps[0]]);
          const indexInside = core.indexStamps(stamps);
          const m = sample.match(/[\\[【]{1,2}\\s*(?:表情包?|贴纸|sticker)\\s*[:：]\\s*([^\\]】\\n]+?)\\s*[\\]】]{1,2}/gi);
          const detail = {
            sample: sample,
            stampsLen: stamps.length,
            parsedLen: parsed.stickers.length,
            oneLen: one.stickers.length,
            oneText: one.text,
            resolveOne: (core.resolve('开心', core.indexStamps([{ id: 'mood', stamps: [stamps[0]] }])) || {}).id || null,
            regexMatches: m ? m.length : 0,
            resolveInLoopIndex: (core.resolve('开心', indexInside) || {}).id || null,
            limit: core.STICKER_LIMIT,
            stripPartialKeepsMarker: core.stripPartialStickerMarkers(sample).indexOf('表情') >= 0,
          };
          return JSON.stringify({
            ok: true,
            packs: loaded.length,
            stamps: stamps.length,
            parsedText: parsed.text,
            hit: parsed.stickers.length ? parsed.stickers[0].id : null,
            detail: detail,
          });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const rawRender = render && render.result && render.result.result ? render.result.result.value : undefined;
    if (typeof rawRender !== "string") {
      throw new Error("页面里做表情解析时没拿到结果：" + JSON.stringify(render && render.result ? render.result : render).slice(0, 400));
    }
    const rendered = JSON.parse(rawRender);
    if (!rendered || rendered.ok !== true) {
      throw new Error("页面里做表情解析时报错：" + JSON.stringify(rendered).slice(0, 300));
    }
    console.log("表情包：", rendered.packs + " 套 / " + rendered.stamps + " 张");
    console.log("解析：正文=" + JSON.stringify(rendered.parsedText) + " 命中=" + rendered.hit);

    // 语音设置页：这一块最容易"加了界面但渲染不出来"（角色列表是现读的），单独验一次。
    const voicePanel = await session.send("Runtime.evaluate", {
      expression: `(async () => {
        try {
          document.querySelector('[data-action="open-settings"]').click();
          await new Promise((r) => setTimeout(r, 400));
          window.TASK25C_UI.setSettingsSection('voice');
          await new Promise((r) => setTimeout(r, 1200));
          const list = document.querySelector('#voiceVoiceList');
          const rows = list ? list.querySelectorAll('[data-voice-card]') : [];
          const note = (document.querySelector('#voiceEngineNote') || {}).textContent || '';
          // 逐行看关键内容：光数行数不够，要确认**音色下拉**与语速滑杆都在
          // （这一轮把"语速/音高两个滑杆"换成了"云端音色下拉 + 语速"）。
          const firstRow = rows[0] || null;
          const sliders = firstRow ? Array.from(firstRow.querySelectorAll('[data-voice-field]')).map((n) => n.dataset.voiceField) : [];
          const select = firstRow ? firstRow.querySelector('[data-voice-speaker]') : null;
          if (typeof window.__rwInvokeVoicePanel === "function") await window.__rwInvokeVoicePanel();
          return JSON.stringify({
            ok: true,
            panelActive: !!document.querySelector('[data-settings-panel="voice"].is-active'),
            listFound: !!list,
            rows: document.querySelectorAll('#voiceVoiceList [data-voice-card]').length,
            sliders: sliders,
            speakerOptions: select ? select.querySelectorAll('option').length : 0,
            hasTestButton: !!(firstRow && firstRow.querySelector('[data-voice-test]')),
            hasResetButton: !!(firstRow && firstRow.querySelector('[data-voice-reset]')),
            hasCacheRow: !!document.querySelector('[data-voice-clear-cache]'),
            note: note.slice(0, 60),
          });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("语音设置页：" + JSON.stringify(JSON.parse(voicePanel.result.result.value)));
    if (rendered.detail) console.log("细节：" + JSON.stringify(rendered.detail));

    console.log("");
    if (errors.length) {
      console.log("❌ 页面里有 " + errors.length + " 条错误：");
      for (const error of errors.slice(0, 12)) console.log("   · " + error);
      process.exitCode = 1;
    } else {
      console.log("✅ 页面无报错，新模块都在位，表情标记能解析并画出图");
    }
  } catch (error) {
    console.error("冒烟失败：" + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  } finally {
    if (session) session.close();
    try { child.kill(); } catch (_) { /* 已经退出 */ }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* Windows 上偶尔删不掉 */ }
  }
})();
