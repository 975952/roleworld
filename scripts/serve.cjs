"use strict";

/*
 * serve.cjs —— 本地静态服务器（零依赖）
 *
 * 网页版需要从 http:// 打开：直接双击 index.html（file://）在多数浏览器里
 * 无法使用 IndexedDB，应用会退化成"关掉页面就丢数据"。
 *
 *   node scripts/serve.cjs [端口]
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  } catch (_) {
    res.writeHead(400).end("bad request");
    return;
  }
  if (pathname === "/") pathname = "/app/index.html";

  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`角色世界：http://127.0.0.1:${PORT}/app/index.html`);
  console.log("按 Ctrl+C 停止。");
});
