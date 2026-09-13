"use strict";

/*
 * devtools-probe.cjs —— 通过 DevTools 协议直接检查手机上 WebView 里的页面
 *
 * 为什么需要它：手机上"打开是白屏还是界面"用眼睛看可以，但**验收要能量**。
 * adb 的 uiautomator 只能看到原生视图（WebView 就是一大块，看不到里面的 DOM），
 * 而 Tauri 的界面全在 WebView 里。所以：adb forward 出 WebView 的调试 socket，
 * 用 CDP 直接在页面里跑 JS —— 能拿到标题、可见文字、某个元素的真实坐标。
 *
 * 用法：
 *   node scripts/devtools-probe.cjs --port 9222                 # 列出页面
 *   node scripts/devtools-probe.cjs --port 9222 --eval "document.title"
 *   node scripts/devtools-probe.cjs --port 9222 --check-inset   # 量顶部让位
 *
 * 注意：WebView 的 /json 端点对请求行挑食，PowerShell 的 Invoke-WebRequest 会被
 * 直接关连接（踩过），所以这里用裸 socket 自己拼 HTTP。
 */

const net = require("node:net");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", "9222"));

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      // Host 必须写 localhost：Chromium 的 DevTools 端点对 Host 头挑剔，
      // 写 127.0.0.1 会被直接关连接（踩过）。
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.on("data", (c) => { raw += c.toString("utf8"); });
    socket.on("end", () => {
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) {
        return reject(new Error(`响应不完整（收到 ${raw.length} 字节：${JSON.stringify(raw.slice(0, 120))}）`));
      }
      const head = raw.slice(0, split);
      let body = raw.slice(split + 4);
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        // 逐块解码
        let out = "";
        let rest = body;
        for (;;) {
          const nl = rest.indexOf("\r\n");
          if (nl < 0) break;
          const size = parseInt(rest.slice(0, nl), 16);
          if (!size) break;
          out += rest.slice(nl + 2, nl + 2 + size);
          rest = rest.slice(nl + 2 + size + 2);
        }
        body = out;
      }
      resolve({ head, body });
    });
    socket.on("error", reject);
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error("超时")); });
  });
}

/* 极简 WebSocket 客户端（只做"发一帧文本、收一帧文本"） */
function wsEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const key = Buffer.from(String(Math.random())).toString("base64").slice(0, 22);
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let handshake = "";
    let upgraded = false;
    let buffer = Buffer.alloc(0);

    function sendText(text) {
      const payload = Buffer.from(text, "utf8");
      const mask = Buffer.from([1, 2, 3, 4]);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    }

    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake += chunk.toString("binary");
        const idx = handshake.indexOf("\r\n\r\n");
        if (idx < 0) return;
        upgraded = true;
        const rest = Buffer.from(handshake.slice(idx + 4), "binary");
        if (rest.length) buffer = Buffer.concat([buffer, rest]);
        sendText(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        // 握手残留里可能已经有数据，交给下面的解析
        chunk = Buffer.alloc(0);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
      // 解析帧
      for (;;) {
        if (buffer.length < 2) return;
        const len0 = buffer[1] & 0x7f;
        let offset = 2;
        let len = len0;
        if (len0 === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        else if (len0 === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + len) return;
        const payload = buffer.slice(offset, offset + len).toString("utf8");
        buffer = buffer.slice(offset + len);
        try {
          const msg = JSON.parse(payload);
          if (msg.id === 1) {
            socket.destroy();
            if (msg.result && msg.result.exceptionDetails) {
              return reject(new Error("页面里报错: " + JSON.stringify(msg.result.exceptionDetails.text || "")));
            }
            return resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
          }
        } catch (_) { /* 其它事件帧忽略 */ }
      }
    });
    socket.on("error", reject);
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error("超时")); });
  });
}

const INSET_PROBE = `(() => {
  const topbar = document.querySelector('.topbar') || document.querySelector('[class*=topbar]');
  const r = topbar ? topbar.getBoundingClientRect() : null;
  return JSON.stringify({
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    bodyText: (document.body ? document.body.innerText : '').slice(0, 160),
    topbarTop: r ? Math.round(r.top) : null,
    topbarHeight: r ? Math.round(r.height) : null,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  });
})()`;

(async () => {
  const list = await httpGet("/json");
  const targets = JSON.parse(list.body);
  const pages = targets.filter((t) => t.type === "page");
  console.log(`页面数：${pages.length}`);
  for (const p of pages) {
    console.log(`  · title="${p.title}"  url=${p.url}`);
  }
  const target = pages.find((p) => (p.url || "").indexOf("tauri.localhost") >= 0) || pages[0];
  if (!target) {
    console.error("没有可用的页面目标");
    process.exit(1);
  }
  console.log(`\n检查目标：${target.url}`);

  const expression = process.argv.includes("--check-inset")
    ? INSET_PROBE
    : arg("--eval", "document.title");
  const value = await wsEval(target.webSocketDebuggerUrl, expression);

  if (process.argv.includes("--check-inset")) {
    const info = JSON.parse(value);
    console.log(JSON.stringify(info, null, 2));
    const insetPx = Math.round((5 / 25.4) * 160 * (info.viewport.dpr || 1) * (info.viewport.w / (info.viewport.w))); // 参考值
    console.log("");
    console.log(`topbar 顶部 = ${info.topbarTop}px（CSS px）；视口宽 ${info.viewport.w} CSS px、dpr=${info.viewport.dpr}`);
    console.log(info.topbarTop > 0 ? "✅ 顶栏没有贴在屏幕最顶端" : "❌ 顶栏贴在 y=0");
  } else {
    console.log(value);
  }
})().catch((error) => {
  console.error("探测失败：" + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
