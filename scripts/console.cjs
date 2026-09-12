"use strict";

/*
 * scripts/console.cjs —— 体验卡控制台（**本机版**）
 *
 *   npm run console                 # 只监听 127.0.0.1，启动后打印带钥匙的地址
 *   npm run console -- --port 8899
 *
 * 为什么是本机版而不是放到网页版上：**控制台 = 发卡权 = 用户自己的钱**。
 * 静态托管是公开目录、没有服务端，口令只能落进浏览器 —— 谁打开谁就是发卡人。
 * 这里口令只活在这个进程里：浏览器只跟 127.0.0.1 说话，页面里没有口令。
 *
 * 三道防线（都写进 tests/console-check.cjs）：
 *   ① 只绑 127.0.0.1；Host 头必须是本机地址（防 DNS rebinding）；
 *   ② 每个 /api/* 请求都要带 `x-rw-console: <本次运行的随机钥匙>`，页面从 ?k= 拿；
 *      跨站请求发不出自定义头（预检一律 403）；
 *   ③ 不发任何 CORS 头。
 *
 * 卡号留底：自己发的卡会把卡号追加进 relay/cards.local.jsonl（gitignored）。
 * 服务端账本只有 sha256(卡号)、永远拿不回卡号，所以"以后还能重印那段话"只能靠这份本机文件。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const admin = require(path.join(__dirname, "..", "relay", "admin-client.js"));
const cardText = require(path.join(__dirname, "..", "relay", "card-text.js"));

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "console");
const DEFAULT_RECORD_FILE = path.join(ROOT, "relay", "cards.local.jsonl");

function argValue(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? true : value;
}

function isCardToken(value) {
  return /RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/i.test(String(value || ""));
}

function normalizeInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function createConsole(options) {
  const opts = options || {};
  const client = opts.client || admin.createAdminClient({ relayUrl: opts.relayUrl, adminSecret: opts.adminSecret });
  const runToken = opts.runToken || crypto.randomBytes(16).toString("hex");
  const recordFile = opts.recordFile || DEFAULT_RECORD_FILE;
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const appUrl = String(opts.appUrl || process.env.APP_URL || cardText.DEFAULT_APP_URL).replace(/\/+$/, "");

  /* ---------- 本机卡号留底 ---------- */

  function readRecord() {
    try {
      return fs.readFileSync(recordFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function appendRecord(rows) {
    const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
    if (!list.length) return;
    const lines = list.map((row) => JSON.stringify(Object.assign({ at: new Date().toISOString() }, row))).join("\n") + "\n";
    fs.appendFileSync(recordFile, lines, { encoding: "utf8", mode: 0o600 });
  }

  function recordIndex() {
    const byId = new Map();
    for (const row of readRecord()) if (row && row.id) byId.set(String(row.id), row);
    return byId;
  }

  /* ---------- HTTP 工具 ---------- */

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  function sendFile(res, file, type) {
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("找不到：" + path.basename(file)); return; }
      res.writeHead(200, { "Content-Type": type, "Content-Length": String(data.length), "Cache-Control": "no-store" });
      res.end(data);
    });
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > (limit || 64 * 1024)) { reject(new Error("请求体太大")); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error("请求体不是 JSON")); }
      });
      req.on("error", reject);
    });
  }

  /** Host 必须是本机地址：防 DNS rebinding 把公网域名解析到 127.0.0.1。 */
  function hostAllowed(req, port) {
    const host = String(req.headers.host || "");
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  }

  /* ---------- 接口 ---------- */

  async function handleApi(req, res, url, port) {
    if (!hostAllowed(req, port)) return sendJson(res, 403, { error: "Host 不对（只接受本机地址）" });
    if (String(req.headers["x-rw-console"] || "") !== runToken) {
      return sendJson(res, 403, { error: "控制台钥匙不对：请用启动时打印的那个带 ?k= 的地址打开" });
    }

    if (url.pathname === "/api/state") {
      const health = await client.health().catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
      return sendJson(res, 200, {
        ok: true,
        relayUrl: client.relayUrl,
        appUrl,
        hasSecret: client.hasSecret,
        secretFile: admin.SECRET_FILE,
        recordFile,
        recordCount: readRecord().length,
        health: health || null,
      });
    }

    if (url.pathname === "/api/cards") {
      const cards = await client.listCards();
      const known = recordIndex();
      return sendJson(res, 200, {
        // 本机有卡号就一起给（界面才能给「复制那段话」）；没有就只显示用量。
        cards: cards.map((card) => Object.assign({}, card, { token: known.has(String(card.id)) ? known.get(String(card.id)).token : null })),
      });
    }

    if (url.pathname === "/api/record") return sendJson(res, 200, { rows: readRecord().slice().reverse() });

    if (url.pathname === "/api/issue" && req.method === "POST") {
      const body = await readBody(req);
      const count = normalizeInt(body.count, 1, 1, 50);
      const calls = normalizeInt(body.calls, 50, 0, 100000);
      const tokens = normalizeInt(body.tokens, 0, 0, 100000000);
      const days = normalizeInt(body.days, 14, 0, 3650);
      const label = String(body.label || "").slice(0, 60);
      const note = String(body.note || "").slice(0, 200);
      const issued = [];
      for (let i = 1; i <= count; i += 1) {
        const created = await client.createCard({
          label: count > 1 && label ? `${label}${i}` : (label || (count > 1 ? `体验卡${i}` : "")),
          calls, tokens, days, note,
        });
        issued.push(created);
        appendRecord({ id: created.id, label: created.label, token: created.token, calls, tokens, days, expiresAt: created.expiresAt || null });
      }
      return sendJson(res, 200, {
        cards: issued.map((card) => ({
          id: card.id,
          label: card.label,
          token: card.token,
          expiresAt: card.expiresAt || null,
          quota: card.quota || { calls, tokens },
          shareText: cardText.shareText(card.token, card.quota || { calls, tokens }, { appUrl, relayUrl: client.relayUrl }),
          pasteLine: cardText.pasteLine(card.token, { relayUrl: client.relayUrl }),
        })),
      });
    }

    if (url.pathname === "/api/remember" && req.method === "POST") {
      const body = await readBody(req);
      const token = String(body.token || "").trim().toUpperCase();
      if (!isCardToken(token)) return sendJson(res, 400, { error: "这不像一个卡号（形如 RW-XXXXX-XXXXX-XXXXX）" });
      const info = await client.quota(token).catch(() => null);
      appendRecord({ id: (info && info.id) || null, label: String(body.label || "手工登记").slice(0, 60), token });
      return sendJson(res, 200, { ok: true, info: info || null });
    }

    if (url.pathname === "/api/text" && req.method === "POST") {
      const body = await readBody(req);
      const token = String(body.token || "").trim().toUpperCase();
      if (!isCardToken(token)) return sendJson(res, 400, { error: "卡号不对" });
      const info = await client.quota(token).catch(() => null);
      return sendJson(res, 200, {
        shareText: cardText.shareText(token, (info && info.quota) || null, { appUrl, relayUrl: client.relayUrl }),
        pasteLine: cardText.pasteLine(token, { relayUrl: client.relayUrl }),
        info: info || null,
      });
    }

    const action = url.pathname.match(/^\/api\/card\/([^/]+)\/(disable|enable|revoke)$/);
    if (action && req.method === "POST") {
      const id = decodeURIComponent(action[1]);
      if (action[2] === "revoke") {
        const body = await client.revoke(id);
        return sendJson(res, 200, { ok: body && body.removed !== false, removed: !!(body && body.removed) });
      }
      const body = await client.setDisabled(id, action[2] === "disable");
      return sendJson(res, 200, { ok: true, disabled: !!body.disabled });
    }

    if (url.pathname === "/api/selftest/store") return sendJson(res, 200, await client.storeSelftest());
    if (url.pathname === "/api/selftest/upstream") return sendJson(res, 200, await client.upstreamSelftest(url.searchParams.get("model") || ""));

    return sendJson(res, 404, { error: "没有这个接口：" + url.pathname });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://console.local");
    try {
      // 跨站预检一律拒绝：浏览器就不会替别的网站发出"带自定义头"的请求。
      if (req.method === "OPTIONS") { res.writeHead(403); res.end(); return; }
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, server.address().port);
      if (url.pathname === "/" || url.pathname === "/index.html") return sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
      if (url.pathname === "/console.css") return sendFile(res, path.join(publicDir, "console.css"), "text/css; charset=utf-8");
      if (url.pathname === "/console.js") return sendFile(res, path.join(publicDir, "console.js"), "text/javascript; charset=utf-8");
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("这里只有控制台：/");
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: String((error && error.message) || error) });
      else { try { res.end(); } catch (_) { /* 已经断了 */ } }
    }
  });

  server.console = { runToken, recordFile, client, readRecord };
  return server;
}

/** 起服务（被占用就 +1 重试），并把带钥匙的地址打印出来。 */
function start(port, attempt, options) {
  const server = createConsole(options);
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE" && (attempt || 0) < 10) { start(Number(port) + 1, (attempt || 0) + 1, options); return; }
    console.error("控制台起不来：" + String((error && error.message) || error));
    process.exitCode = 1;
  });
  server.listen(Number(port), "127.0.0.1", () => {
    const actual = server.address().port;
    const info = server.console;
    console.log("");
    console.log("体验卡控制台已启动（只监听本机，口令不进浏览器）：");
    console.log("  http://127.0.0.1:" + actual + "/?k=" + info.runToken);
    console.log("");
    console.log("  · 中转：" + info.client.relayUrl);
    console.log("  · 发卡口令：" + (info.client.hasSecret ? "已读到（" + (process.env.ADMIN_SECRET ? "环境变量 ADMIN_SECRET" : admin.SECRET_FILE) + "）" : "**没读到** —— 把口令写进 " + admin.SECRET_FILE));
    console.log("  · 卡号留底：" + info.recordFile + "（已 gitignore；这份文件等于凭据，别外传）");
    console.log("  · 上面那个带 ?k= 的地址就是钥匙，别贴给别人；关掉这个窗口控制台就停了。");
    console.log("");
  });
  return server;
}

if (require.main === module) {
  start(Number(argValue("port", process.env.CONSOLE_PORT || 8790)), 0, {
    relayUrl: argValue("relay", process.env.RELAY_URL || ""),
    adminSecret: argValue("admin", ""),
  });
}

module.exports = { createConsole, start, DEFAULT_RECORD_FILE };
