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

  /**
   * 「发卡」的**防重复提交**（2026-09-14）。
   *
   * 为什么必须有：浏览器超时、用户连点两下、网络抖动重试 —— 任何一种都会让同一个
   * 请求到达两次，而每一次都真的会在账本里**多发一张卡**（卡这东西没有"幂等"可言，
   * 多发的就是白送出去的额度）。所以请求方带一个 `requestId`，同一个 id 在
   * `IDEMPOTENT_TTL_MS` 内只执行一次，第二次直接把它上次的结果还给它。
   *
   * 结果缓存**只活在内存里**：控制台一关就没了。重启之后同一个 id 会重新执行 ——
   * 这是刻意的取舍：为了"永不重复发卡"把卡号落进一个新文件，等于把凭据多抄一份。
   * 界面上还有一道闸（提交期间按钮禁用 + 同一个 requestId 复用），两道一起上。
   */
  const IDEMPOTENT_TTL_MS = 10 * 60 * 1000;
  const issueResults = new Map();

  function idempotencyKey(body) {
    const raw = body && body.requestId;
    const key = String(raw === undefined || raw === null ? "" : raw).trim();
    if (!key) return "";
    return key.slice(0, 80);
  }

  function replayIssue(key) {
    if (!key) return null;
    const hit = issueResults.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > IDEMPOTENT_TTL_MS) { issueResults.delete(key); return null; }
    return Object.assign({}, hit.body, { replayed: true });
  }

  function rememberIssue(key, body) {
    if (!key) return body;
    issueResults.set(key, { at: Date.now(), body: body });
    // 顺手清掉过期的：这是个长驻进程，Map 不能无限长。
    for (const [id, row] of issueResults) {
      if (Date.now() - row.at > IDEMPOTENT_TTL_MS) issueResults.delete(id);
    }
    return body;
  }

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
        // 界面要显示"数据是什么时候取的"（用户在总览里看的是快照，不是实时值）。
        checkedAt: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/cards") {
      const cards = await client.listCards();
      const known = recordIndex();
      return sendJson(res, 200, {
        // 本机有卡号就一起给（界面才能给「复制那段话」）；没有就只显示用量。
        cards: cards.map((card) => Object.assign({}, card, { token: known.has(String(card.id)) ? known.get(String(card.id)).token : null })),
        checkedAt: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/record") return sendJson(res, 200, { rows: readRecord().slice().reverse() });

    /* 加次数 / 续期（2026-09-12）：同学用完了就地补，不用换卡、不用他重新配。 */
    /* 2026-09-14 扩：语音的两份额度（voice / voiceChars）也在这里改。 */
    if (url.pathname === "/api/usage") {
      const days = url.searchParams.get("days") || 14;
      return sendJson(res, 200, await client.usage(days));
    }

    const extend = url.pathname.match(/^\/api\/card\/([^/]+)\/extend$/);
    if (extend && req.method === "POST") {
      const id = decodeURIComponent(extend[1]);
      const body = await readBody(req);
      const fields = {};
      if (body.calls !== undefined && body.calls !== null && body.calls !== "") fields.calls = normalizeInt(body.calls, 0, 0, 1000000);
      if (body.tokens !== undefined && body.tokens !== null && body.tokens !== "") fields.tokens = normalizeInt(body.tokens, 0, 0, 1000000000);
      if (body.voice !== undefined && body.voice !== null && body.voice !== "") fields.voice = normalizeInt(body.voice, 0, 0, 1000000);
      if (body.voiceChars !== undefined && body.voiceChars !== null && body.voiceChars !== "") fields.voiceChars = normalizeInt(body.voiceChars, 0, 0, 1000000000);
      if (body.days !== undefined && body.days !== null && body.days !== "") fields.days = normalizeInt(body.days, 0, 0, 3650);
      if (body.label !== undefined) fields.label = String(body.label || "").slice(0, 60);
      if (body.note !== undefined) fields.note = String(body.note || "").slice(0, 200);
      if (!Object.keys(fields).length) return sendJson(res, 400, { error: "要给点什么：聊天次数 / token / 语音次数 / 语音字数 / 天数 / 标签" });
      const updated = await client.updateCard(id, fields);
      return sendJson(res, 200, { ok: true, card: updated, changed: Object.keys(fields) });
    }

    /* 单张卡的用量明细（2026-09-14）：控制台的「卡详情」要用它画最近用量。 */
    const detail = url.pathname.match(/^\/api\/card\/([^/]+)$/);
    if (detail && req.method === "GET") {
      const id = decodeURIComponent(detail[1]);
      const cards = await client.listCards();
      const card = cards.find((one) => String(one.id) === String(id));
      if (!card) return sendJson(res, 404, { error: "没有这张卡（可能已经被吊销了）" });
      const known = recordIndex().get(String(card.id));
      const daily = Object.entries(card.daily || {})
        .map(([day, row]) => ({
          day: day,
          calls: Number(row && row.calls) || 0,
          tokens: Number(row && row.tokens) || 0,
          voice: Number(row && row.voice) || 0,
          chars: Number(row && row.chars) || 0,
        }))
        .sort((a, b) => (a.day < b.day ? 1 : -1))
        .slice(0, 14);
      return sendJson(res, 200, { card: Object.assign({}, card, { token: known ? known.token : null }), daily: daily });
    }

    if (url.pathname === "/api/issue" && req.method === "POST") {
      const body = await readBody(req);
      const key = idempotencyKey(body);
      const replayed = replayIssue(key);
      if (replayed) return sendJson(res, 200, replayed);
      const count = normalizeInt(body.count, 1, 1, 50);
      const calls = normalizeInt(body.calls, 50, 0, 100000);
      const tokens = normalizeInt(body.tokens, 0, 0, 100000000);
      const voice = normalizeInt(body.voice, 0, 0, 1000000);
      const voiceChars = normalizeInt(body.voiceChars, 0, 0, 1000000000);
      const days = normalizeInt(body.days, 14, 0, 3650);
      const label = String(body.label || "").slice(0, 60);
      const note = String(body.note || "").slice(0, 200);
      const quota = { calls, tokens, voice, voiceChars };
      const issued = [];
      const failures = [];
      // **部分失败也要把成功的留住**（2026-09-14）：一次发 5 张、第 3 张失败时，
      // 前 2 张已经真的发出去了（账本里有、额度已经花了）—— 不能因为"这一批失败了"
      // 就把它们丢掉，更不能让用户重来一次（那会重复发卡）。所以逐张记结果。
      for (let i = 1; i <= count; i += 1) {
        const oneLabel = count > 1 && label ? `${label}${i}` : (label || (count > 1 ? `体验卡${i}` : ""));
        try {
          const created = await client.createCard({ label: oneLabel, calls, tokens, voice, voiceChars, days, note });
          appendRecord({ id: created.id, label: created.label, token: created.token, calls, tokens, voice, voiceChars, days, expiresAt: created.expiresAt || null });
          issued.push({
            id: created.id,
            label: created.label,
            token: created.token,
            expiresAt: created.expiresAt || null,
            quota: created.quota || quota,
            shareText: cardText.shareText(created.token, created.quota || quota, { appUrl, relayUrl: client.relayUrl }),
            pasteLine: cardText.pasteLine(created.token, { relayUrl: client.relayUrl }),
          });
        } catch (error) {
          failures.push({ index: i, error: String((error && error.message) || error) });
        }
      }
      return sendJson(res, 200, rememberIssue(key, {
        ok: failures.length === 0,
        requested: count,
        cards: issued,
        failures: failures,
        // 重试口径写在响应里，界面直接显示 —— 用户不该自己猜"要不要再发一次"。
        retryHint: failures.length
          ? (issued.length
            ? "已经成功的 " + issued.length + " 张是真的发出去了（卡号在下面，先用这些）。剩下 "
              + failures.length + " 张没发成 —— 补发时**只补这几张**（把张数改成 " + failures.length + "），不要再发一整批。"
            : "这一批一张都没发成，可以直接重试同样的张数。")
          : "",
      }));
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
    // 语音配置（**只读**）：只报"配没配、有哪些音色"，绝不真去合成 ——
    // 语音按字符计费，一个自检按钮不该悄悄花掉用户的钱。
    if (url.pathname === "/api/selftest/voice") return sendJson(res, 200, await client.voiceConfig());

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
