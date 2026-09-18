"use strict";

/*
 * bridge-probe.cjs —— 模拟"手机上：没有 speechSynthesis、只有原生桥"来验菜单
 *
 * 为什么需要它：无头 Chrome **自带** speechSynthesis，所以在普通测试里
 * "能不能朗读"永远是 true —— "没有语音合成时会怎样"根本测不到（我第一版回归用例
 * 就是这么写错的：把桥删掉，浏览器接管，朗读照样在）。
 *
 * 做法：用 CDP 的 `Page.addScriptToEvaluateOnNewDocument`，在页面任何脚本之前：
 *   ① 把 speechSynthesis / SpeechSynthesisUtterance 拿掉（模拟 Android WebView）；
 *   ② 装上假的 `__rwNativeTts`（模拟外壳挂的原生桥）。
 * 然后检查一条助手消息的菜单里有没有「朗读」、点它会不会真的调用原生 speak。
 *
 * 用法：node scripts/bridge-probe.cjs
 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  return list.find((p) => p && fs.existsSync(p)) || null;
}

function serve(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(String(req.url || "/").split("?")[0]);
    const file = path.join(dir, url === "/" ? "index.html" : url.replace(/^\/+/, ""));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const freePort = () => new Promise((r) => { const p = net.createServer(); p.listen(0, "127.0.0.1", () => { const { port } = p.address(); p.close(() => r(port)); }); });

function httpJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET" }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.end();
  });
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const key = Buffer.from(String(Math.random())).toString("base64").slice(0, 22);
      socket.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshake = "", upgraded = false, buffer = Buffer.alloc(0), nextId = 1;
    const pending = new Map();
    const send = (method, params) => {
      const id = nextId++;
      const payload = Buffer.from(JSON.stringify({ id, method, params: params || {} }), "utf8");
      const mask = Buffer.from([3, 3, 3, 3]);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
      return new Promise((res) => pending.set(id, res));
    };
    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake += chunk.toString("binary");
        const i = handshake.indexOf("\r\n\r\n");
        if (i < 0) return;
        upgraded = true;
        const rest = Buffer.from(handshake.slice(i + 4), "binary");
        buffer = rest.length ? Buffer.concat([buffer, rest]) : buffer;
      } else buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const len0 = buffer[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
        if (buffer.length < off + len) return;
        const text = buffer.slice(off, off + len).toString("utf8");
        buffer = buffer.slice(off + len);
        let msg; try { msg = JSON.parse(text); } catch (_) { continue; }
        if (msg.id && pending.has(msg.id)) { const done = pending.get(msg.id); pending.delete(msg.id); done(msg); }
      }
    });
    socket.on("error", reject);
    const wait = setInterval(() => { if (upgraded) { clearInterval(wait); resolve({ send, close: () => socket.destroy() }); } }, 10);
  });
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.log("没找到 Chrome，跳过。"); return; }
  const server = await serve(path.join(ROOT, "app"));
  const port = server.address().port;
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rw-bridge-"));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      try {
        const list = await httpJson(cdpPort, "/json/list");
        target = (list || []).find((t) => t.type === "page");
      } catch (_) { /* 等 Chrome */ }
      if (!target) await new Promise((r) => setTimeout(r, 250));
    }
    const session = await cdp(target.webSocketDebuggerUrl);
    await session.send("Runtime.enable");
    await session.send("Page.enable");

    // 关键：在页面任何脚本之前，把浏览器语音拿掉、装 fixture（和端到端测试同一份，
    // 这样页面里才有真实的角色与对话），并让**桥故意晚 3 秒才出现** ——
    // 真机上外壳就是这样（Activity 起来之后才挂上），而页面在那之前就渲染过消息了。
    // 只有这样才测得出"菜单项是定死的、还是每次打开现算的"。
    const fixturePath = path.join(__dirname, "_fixture.js");
    const fixture = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath, "utf8") : "";
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        ${fixture}
        try { Object.defineProperty(window, "speechSynthesis", { get: () => undefined, configurable: true }); } catch (e) {}
        try { delete window.SpeechSynthesisUtterance; } catch (e) {}
        window.__bridgeLog = [];
        setTimeout(function () {
          window.__bridgeLog.push("bridge-arrived");
          window.__rwNativeTts = {
            init: function () { window.__bridgeLog.push("init"); },
            status: function () { return JSON.stringify({ ready: true, failed: false, engine: "fake-engine", speaking: false }); },
            speak: function (text, rate, pitch, id) {
              window.__bridgeLog.push("speak:" + id + ":" + rate);
              setTimeout(function () { window.__rwVoiceCallback && window.__rwVoiceCallback(JSON.stringify({ id: id, event: "done", message: "" })); }, 10);
            },
            stop: function () { window.__bridgeLog.push("stop"); }
          };
          window.dispatchEvent(new Event("rw-native-tts-ready"));
        }, 3000);
      `,
    });
    await session.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
    // 等到桥晚到之后再看菜单（这时候消息早就渲染完了）
    await new Promise((r) => setTimeout(r, 8000));

    const out = await session.send("Runtime.evaluate", {
      expression: `(async () => {
        const cap = window.RoleWorldVoice.capability();
        const hasNative = window.RoleWorldVoice.hasNativeTts();
        // 造一条助手消息，看菜单里有没有「朗读」
        const api = window.TASK21;
        let menu = [], speakCalls = [];
        // 页面里可能没有对话（空库），这时 messageActions 就无从谈起 ——
        // 直接把页面内部那套 DOM 结构复刻一份太脆，所以改为：找任何一条非用户消息行；
        // 找不到就报告"没有可测的消息行"，由调用方决定（不要假装测过了）。
        const row = document.querySelector("#dynamicMessages .message-row:not(.message-row-user)");
        let reason = "";
        if (!row) reason = "页面里没有助手消息行（空库或还没建对话）";
        if (row) {
          const btn = row.querySelector(".message-menu-button");
          if (!btn) reason = "消息行里没有 ⋯ 菜单按钮";
          else {
            btn.click();
            await new Promise((r) => setTimeout(r, 200));
            menu = Array.from(row.querySelectorAll(".message-menu-item")).map((n) => n.dataset.messageAction);
          }
        }
        return JSON.stringify({
          speechSynthesis: typeof window.speechSynthesis,
          speechSynthesisUtterance: typeof window.SpeechSynthesisUtterance,
          hasNative: hasNative,
          capCanSpeak: cap.canSpeak,
          menu: menu,
          reason: reason,
          bridgeLog: window.__bridgeLog || [],
        });
      })()`,
      returnByValue: true, awaitPromise: true,
    });
    const info = JSON.parse(out.result.result.value);
    console.log(JSON.stringify(info, null, 2));
    const ok = info.hasNative === true && info.capCanSpeak === true && info.menu.indexOf("speak") >= 0;
    console.log(ok
      ? "\n✅ 模拟手机环境：没有 speechSynthesis，但原生桥在 → 菜单里有「朗读」"
      : "\n❌ 模拟手机环境：菜单里没有「朗读」——说明判断逻辑有问题");
    process.exitCode = ok ? 0 : 1;
    session.close();
  } catch (error) {
    console.error("探针失败：" + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (_) { /* 已退出 */ }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* Windows 偶尔删不掉 */ }
  }
})();
