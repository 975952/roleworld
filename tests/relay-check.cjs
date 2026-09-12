"use strict";

/*
 * relay-check.cjs —— 「体验卡」中转服务的端到端回归（无需外网、无需云环境）
 *
 * 起一个假的上游模型端点 + 真的 relay 服务，验证：
 *   卡的校验（不存在 / 停用 / 过期 / 次数用完 / 吊销）、用量记账、
 *   SSE 原样透传、CORS、管理接口、模型白名单，
 *   以及**两条硬规矩**：账本里只有哈希（没有卡号明文）、日志里没有对话正文。
 */

const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");

const RELAY = path.join(__dirname, "..", "relay");
const { createRelay } = require(path.join(RELAY, "server.js"));
const { createMemoryStore, hashToken } = require(path.join(RELAY, "store.js"));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  PASS  " + name);
  } catch (error) {
    failed += 1;
    console.log("  FAIL  " + name);
    console.log("        " + String((error && error.message) || error).split("\n").join("\n        "));
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** 假的上游：流式 / 非流式 / 报错 三种行为，并记下收到的请求体。 */
function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://upstream.local");
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ body, auth: req.headers.authorization || "" });
      if (body.model === "boom") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "上游炸了" } }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
        const frames = [
          { choices: [{ delta: { content: "他" } }] },
          { choices: [{ delta: { content: "点点头。" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
        ];
        frames.forEach((frame) => res.write("data: " + JSON.stringify(frame) + "\n\n"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "他点点头。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }));
    });
  });
  return { server, seen };
}

async function main() {
  console.log("== 体验卡中转 ==");

  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const logs = [];
  const store = createMemoryStore();
  const server = createRelay({
    store,
    upstreamBase: "http://127.0.0.1:" + upstreamPort,
    upstreamKey: "sk-upstream-secret",
    adminSecret: "admin-secret-123",
    allowModels: ["deepseek-flash", "boom"],
    logSink: (line) => logs.push(line),
  });
  const port = await listen(server);
  const base = "http://127.0.0.1:" + port;

  const chat = (token, body, extra) => fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}, extra || {}),
    body: JSON.stringify(body),
  });
  const admin = (method, path, body) => fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
    body: body ? JSON.stringify(body) : undefined,
  });

  let cardToken = "";

  await check("没带卡：401，而且给的是人话", async () => {
    const res = await chat("", { model: "deepseek-flash", messages: [{ role: "user", content: "在吗" }] });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "CARD_UNKNOWN");
    assert.ok(body.error.message.indexOf("卡号") >= 0, "错误信息要能看懂：" + body.error.message);
  });

  await check("乱填卡号：401，不会拿去转发", async () => {
    const before = upstream.seen.length;
    const res = await chat("RW-AAAAA-BBBBB-CCCCC", { model: "deepseek-flash", messages: [] });
    assert.equal(res.status, 401);
    assert.equal(upstream.seen.length, before, "没通过校验就不该打上游");
  });

  await check("管理接口要口令：错了就 401", async () => {
    const res = await fetch(base + "/admin/cards", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body: "{}" });
    assert.equal(res.status, 401);
  });

  await check("发卡：返回 RW- 开头的卡号，并且只显示这一次", async () => {
    const res = await admin("POST", "/admin/cards", { label: "小明", calls: 3, tokens: 5000, days: 30 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(/^RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(body.token), "卡号格式不对：" + body.token);
    assert.equal(body.quota.calls, 3);
    assert.ok(body.hint.indexOf("只显示这一次") >= 0);
    cardToken = body.token;
  });

  await check("账本里只有哈希：翻遍账本也找不到卡号明文", async () => {
    const cards = await store.list();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].tokenHash, hashToken(cardToken));
    assert.ok(JSON.stringify(cards).indexOf(cardToken) < 0, "账本里出现了卡号明文");
  });

  await check("拿卡聊天（流式）：SSE 原样透传，正文一个字不差", async () => {
    const res = await chat(cardToken, { model: "deepseek-flash", stream: true, messages: [{ role: "user", content: "他怎么样" }] });
    assert.equal(res.status, 200);
    assert.ok(String(res.headers.get("content-type")).indexOf("text/event-stream") >= 0);
    const text = await res.text();
    assert.ok(text.indexOf('"他"') >= 0 && text.indexOf('"点点头。"') >= 0, "流式内容被改动了：" + JSON.stringify(text.slice(0, 200)));
    assert.ok(text.indexOf("data: [DONE]") >= 0, "结束帧丢了");
    // 响应头给的是"这一通之前还剩几次"，客户端据此提前告诉同学快用完了。
    assert.equal(res.headers.get("x-rw-card-calls-left"), "3", "响应头要告诉客户端还剩几次");
    // 上游拿到的是真 key，不是同学的卡号
    const last = upstream.seen[upstream.seen.length - 1];
    assert.equal(last.auth, "Bearer sk-upstream-secret", "上游鉴权头不对");
  });

  await check("用量记账：次数 +1，token 按上游的 usage 累加", async () => {
    const res = await fetch(base + "/card/quota", { headers: { Authorization: "Bearer " + cardToken } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.used.calls, 1);
    assert.equal(body.used.tokens, 18);
    assert.equal(body.callsLeft, 2);
    assert.equal(body.tokensLeft, 5000 - 18);
  });

  await check("非流式也通", async () => {
    const res = await chat(cardToken, { model: "deepseek-flash", messages: [{ role: "user", content: "在吗" }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "他点点头。");
  });

  await check("日志里没有正文（只有用量）", async () => {
    const dump = JSON.stringify(logs);
    assert.ok(dump.indexOf("他怎么样") < 0, "日志里出现了用户说的话");
    assert.ok(dump.indexOf("点点头") < 0, "日志里出现了模型的回复");
    const turn = logs.filter((row) => row.event === "turn").pop();
    assert.ok(turn && turn.calls >= 1, "至少要记下用量：" + JSON.stringify(turn));
    assert.equal(turn.cardId, (await store.list())[0].id);
  });

  await check("停用 / 重新启用", async () => {
    const id = (await store.list())[0].id;
    assert.equal((await admin("POST", "/admin/cards/" + id + "/disable")).status, 200);
    const blocked = await chat(cardToken, { model: "deepseek-flash", messages: [] });
    assert.equal(blocked.status, 402);
    assert.equal((await blocked.json()).error.code, "CARD_DISABLED");
    assert.equal((await admin("POST", "/admin/cards/" + id + "/enable")).status, 200);
    assert.equal((await chat(cardToken, { model: "deepseek-flash", messages: [] })).status, 200);
  });

  await check("次数用完：402，并说清楚上限是多少", async () => {
    const res = await admin("POST", "/admin/cards", { label: "用完的卡", calls: 1, days: 7 });
    const token = (await res.json()).token;
    assert.equal((await chat(token, { model: "deepseek-flash", messages: [] })).status, 200);
    const exhausted = await chat(token, { model: "deepseek-flash", messages: [] });
    assert.equal(exhausted.status, 402);
    const body = await exhausted.json();
    assert.equal(body.error.code, "CARD_NO_CALLS");
    assert.ok(body.error.message.indexOf("1 次") >= 0, "要说清上限：" + body.error.message);
  });

  await check("过期卡：402 CARD_EXPIRED", async () => {
    const created = await server.relay.createCard({ label: "过期的", expiresAt: new Date(Date.now() - 86400000).toISOString() });
    const res = await chat(created.token, { model: "deepseek-flash", messages: [] });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error.code, "CARD_EXPIRED");
  });

  await check("吊销：删掉之后立刻不认识这张卡", async () => {
    const created = await server.relay.createCard({ label: "要被收回的" });
    assert.equal((await chat(created.token, { model: "deepseek-flash", messages: [] })).status, 200);
    assert.equal((await admin("DELETE", "/admin/cards/" + created.card.id)).status, 200);
    const gone = await chat(created.token, { model: "deepseek-flash", messages: [] });
    assert.equal(gone.status, 401);
    assert.equal((await gone.json()).error.code, "CARD_UNKNOWN");
  });

  await check("模型白名单：不在名单里的模型直接挡掉", async () => {
    const created = await server.relay.createCard({ label: "白名单测试" });
    const res = await chat(created.token, { model: "gpt-4o", messages: [] });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "MODEL_NOT_ALLOWED");
  });

  await check("次数快用完时响应头会一路递减（客户端好提前提醒）", async () => {
    const created = await server.relay.createCard({ label: "递减", quota: { calls: 2, tokens: 0 } });
    const first = await chat(created.token, { model: "deepseek-flash", messages: [] });
    assert.equal(first.headers.get("x-rw-card-calls-left"), "2");
    const second = await chat(created.token, { model: "deepseek-flash", messages: [] });
    assert.equal(second.headers.get("x-rw-card-calls-left"), "1");
    const third = await chat(created.token, { model: "deepseek-flash", messages: [] });
    assert.equal(third.status, 402);
    assert.equal(third.headers.get("x-rw-card-calls-left"), "0");
  });

  await check("上游报错：状态码透传，并且照样记一次用量", async () => {
    const created = await server.relay.createCard({ label: "上游报错" });
    const res = await chat(created.token, { model: "boom", messages: [] });
    assert.equal(res.status, 500);
    assert.equal((await store.get(created.card.id)).used.calls, 1);
  });

  await check("CORS：预检 204，并且暴露卡额度响应头（网页版跨域要用）", async () => {
    const res = await fetch(base + "/v1/chat/completions", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(String(res.headers.get("access-control-expose-headers")).indexOf("x-rw-card-calls-left") >= 0);
    const list = await admin("GET", "/admin/cards");
    const headers = list.headers.get("access-control-allow-origin");
    assert.equal(headers, "*");
  });

  await check("列卡不泄露卡号，只给元数据", async () => {
    const body = await (await admin("GET", "/admin/cards")).json();
    assert.ok(body.cards.length >= 3);
    const dump = JSON.stringify(body);
    for (const card of body.cards) {
      assert.ok(card.tokenHash === undefined, "列表里不该有哈希");
      assert.ok(card.token === undefined, "列表里不该有卡号");
    }
    assert.ok(dump.indexOf("RW-") < 0, "列卡结果里不该出现任何卡号：" + dump.slice(0, 200));
  });

  await check("没配 ADMIN_SECRET 时，管理接口整体关闭", async () => {
    const bare = createRelay({ store: createMemoryStore(), upstreamBase: "http://127.0.0.1:" + upstreamPort, upstreamKey: "k", adminSecret: "" });
    const barePort = await listen(bare);
    const res = await fetch("http://127.0.0.1:" + barePort + "/admin/cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 503);
    await new Promise((resolve) => bare.close(resolve));
  });

  await check("上游自检接口：拿服务端的 Key 打一次最小请求，成功时报出模型与回复", async () => {
    const res = await admin("GET", "/admin/upstream/selftest?model=deepseek-flash");
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json().catch(() => ({}))));
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, "deepseek-flash");
    assert.ok(body.reply.indexOf("点点头") >= 0, "应带回答的前几十个字：" + JSON.stringify(body));
    // 上游鉴权头必须是真 Key，而且不能在返回里出现。
    assert.equal(upstream.seen[upstream.seen.length - 1].auth, "Bearer sk-upstream-secret");
    assert.ok(JSON.stringify(body).indexOf("sk-upstream-secret") < 0, "自检结果里不该出现 Key");
  });

  await check("上游自检：模型名写错时如实报错，不假装可用", async () => {
    const res = await admin("GET", "/admin/upstream/selftest?model=boom");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.status, 500, "上游状态码要原样带出来：" + JSON.stringify(body));
  });

  await check("账本自检接口：能写能读能删，并报出真正的后端类型", async () => {
    const before = (await store.list()).length;
    const res = await admin("GET", "/admin/store/selftest");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.kind, "memory");
    assert.equal(body.wrote && body.readBack && body.removed, true);
    // 自检必须自己收尾：不能往账本里留垃圾卡。
    assert.equal((await store.list()).length, before, "自检后账本里多出了卡");
  });

  await check("健康检查能看出账本类型（避免以为在存文件、其实在存内存）", async () => {
    const body = await (await fetch(base + "/healthz")).json();
    assert.equal(body.ok, true);
    assert.equal(body.store, "memory");
    assert.ok(body.upstream.indexOf("127.0.0.1") >= 0);
    assert.equal(body.upstreamChatPath, "/v1/chat/completions");
    assert.equal(body.upstreamKeySet, true);
    assert.equal(body.adminEnabled, true);
  });

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.server.close(resolve));

  /* ---------------- 云开发 HTTP 账本（假网关） ---------------- */

  console.log("");
  console.log("== 云开发 HTTP 账本（不用 SDK，直接走官方 HTTP API）==");

  const { createHttpStore, createPgStore, createStore } = require(path.join(RELAY, "store.js"));
  const fakeDocs = new Map();
  let collectionCreated = 0;
  const gateway = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gw.local");
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== "Bearer fake-apikey") return send(401, { code: "DATABASE_PERMISSION_DENIED" });
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (url.pathname === "/v1/database/instances/(default)/databases/(default)/collections") {
        collectionCreated += 1;
        return send(fakeDocs.collection ? 409 : 201, {});
      }
      const listMatch = url.pathname.match(/\/collections\/([^/]+)\/documents$/);
      const oneMatch = url.pathname.match(/\/collections\/([^/]+)\/documents\/([^/]+)$/);
      if (listMatch && req.method === "GET") {
        const rows = Array.from(fakeDocs.values());
        const query = JSON.parse(url.searchParams.get("query") || "{}");
        const filtered = rows.filter((row) => Object.keys(query).every((key) => row[key] === query[key]));
        return send(200, { offset: 0, limit: 500, list: filtered });
      }
      if (listMatch && req.method === "POST") {
        const doc = body.data[0];
        fakeDocs.set(doc._id, doc);
        return send(201, { insertedIds: [doc._id] });
      }
      if (oneMatch && req.method === "GET") {
        const doc = fakeDocs.get(decodeURIComponent(oneMatch[2]));
        return doc ? send(200, doc) : send(404, { code: "DOCUMENT_NOT_FOUND" });
      }
      if (oneMatch && req.method === "PATCH") {
        const key = decodeURIComponent(oneMatch[2]);
        const doc = fakeDocs.get(key);
        if (!doc) return send(404, { code: "DOCUMENT_NOT_FOUND" });
        fakeDocs.set(key, Object.assign({}, doc, body.data.$set || {}));
        return send(200, { updated: 1, matched: 1 });
      }
      if (oneMatch && req.method === "DELETE") {
        const key = decodeURIComponent(oneMatch[2]);
        return fakeDocs.delete(key) ? send(200, { deleted: 1 }) : send(404, { code: "DOCUMENT_NOT_FOUND" });
      }
      return send(404, { code: "NOT_FOUND", path: url.pathname });
    });
  });
  const gatewayPort = await listen(gateway);

  await check("HTTP 账本：自建集合（409 也算成功）、写入、按卡号查、改、删", async () => {
    const store = createHttpStore({ gatewayBase: "http://127.0.0.1:" + gatewayPort, apiKey: "fake-apikey", env: "cyan1-test" });
    assert.equal(store.kind, "cloudbase-http");
    const created = await store.save({ id: "card-1", tokenHash: hashToken("RW-TEST1-TEST2-TEST3"), label: "小明", quota: { calls: 5, tokens: 0 }, used: { calls: 0, tokens: 0 } });
    assert.equal(created.id, "card-1");
    assert.equal(collectionCreated, 1, "应当建一次集合");
    const found = await store.findByToken("RW-TEST1-TEST2-TEST3");
    assert.ok(found && found.label === "小明", "按卡号查不到：" + JSON.stringify(found));
    // 再保存一次走更新分支（$set），集合不该被重复创建。
    await store.save(Object.assign({}, found, { used: { calls: 1, tokens: 12 } }));
    assert.equal(collectionCreated, 1, "不该重复建集合");
    const again = await store.get("card-1");
    assert.equal(again.used.calls, 1);
    assert.equal(await store.remove("card-1"), true);
    assert.equal(await store.get("card-1"), null);
  });

  await check("HTTP 账本：缺 Key / 缺环境时明确报错，并退到 file 而不是假装成功", async () => {
    let message = "";
    try { createHttpStore({ env: "cyan1-test", apiKey: "" }); } catch (error) { message = error.message; }
    assert.ok(message.indexOf("CLOUDBASE_APIKEY") >= 0, "应当说清缺哪一项：" + message);
    // kind=cloudbase 时优先用 PG（新环境都是 PG），要强制走文档库 HTTP 得写 nosql。
    const preferPg = createStore({ kind: "cloudbase", apiKey: "fake-apikey", gatewayBase: "http://127.0.0.1:" + gatewayPort, env: "cyan1-test" });
    assert.equal(preferPg.kind, "cloudbase-pg", "cloudbase 应当优先 PG：" + preferPg.kind);
    const noSql = createStore({ kind: "nosql", apiKey: "fake-apikey", gatewayBase: "http://127.0.0.1:" + gatewayPort, env: "cyan1-test" });
    assert.equal(noSql.kind, "cloudbase-http", "kind=nosql 时应当走文档库 HTTP：" + noSql.kind);
  });

  /* ---------------- 云开发 PostgreSQL 账本（假 PostgREST 网关） ---------------- */

  console.log("");
  console.log("== 云开发 PostgreSQL 账本（Data API）==");

  const pg = { rows: new Map(), ddl: 0 };
  const pgGateway = http.createServer((req, res) => {
    const url = new URL(req.url, "http://pg.local");
    const send = (status, payload, extra) => {
      res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, extra || {}));
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (req.headers.authorization !== "Bearer fake-apikey") return send(401, { code: "UNAUTHORIZED" });
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      if (url.pathname === "/v1/rdb/exec-pgsql") {
        // 只认"管理员角色 + CREATE TABLE IF NOT EXISTS"，别的一律拒绝 —— 免得真建错东西。
        if (body.role !== "cloudbase_postgres") return send(403, { code: "ACTION_FORBIDDEN" });
        if (!/^CREATE TABLE IF NOT EXISTS rw_cards \(/.test(String(body.sql || ""))) {
          return send(400, { code: "INVALID_PARAM", message: "unexpected sql" });
        }
        pg.ddl += 1;
        return send(200, []);
      }
      const table = url.pathname.match(/^\/v1\/rdb\/rest\/([a-z_]+)$/);
      if (!table) return send(404, { code: "RESOURCE_NOT_FOUND", path: url.pathname });
      const idFilter = (url.searchParams.get("id") || "").replace(/^eq\./, "");
      const hashFilter = (url.searchParams.get("token_hash") || "").replace(/^eq\./, "");
      if (req.method === "GET") {
        let rows = Array.from(pg.rows.values());
        if (idFilter) rows = rows.filter((row) => row.id === idFilter);
        if (hashFilter) rows = rows.filter((row) => row.token_hash === hashFilter);
        return send(200, rows.slice(0, Number(url.searchParams.get("limit")) || 500));
      }
      if (req.method === "POST") {
        pg.rows.set(body.id, body);   // upsert（主键合并）
        return send(201, [body], { "Content-Range": "*/1", "Preference-Applied": "resolution=merge-duplicates" });
      }
      if (req.method === "DELETE") {
        const existed = pg.rows.delete(idFilter);
        return send(existed ? 200 : 204, existed ? [{ id: idFilter }] : []);
      }
      return send(405, { code: "METHOD_NOT_ALLOWED" });
    });
  });
  const pgPort = await listen(pgGateway);

  await check("PG 账本：先建表（管理员角色）、再 upsert 一张卡、按卡号查、改、删", async () => {
    const store = createPgStore({ gatewayBase: "http://127.0.0.1:" + pgPort, apiKey: "fake-apikey", env: "cyan1-test" });
    assert.equal(store.kind, "cloudbase-pg");
    await store.save({ id: "card-9", tokenHash: hashToken("RW-PG01-PG02-PG03"), label: "同学A", quota: { calls: 20, tokens: 0 }, used: { calls: 0, tokens: 0 } });
    assert.equal(pg.ddl, 1, "应当建一次表");
    const found = await store.findByToken("RW-PG01-PG02-PG03");
    assert.ok(found && found.label === "同学A", "按卡号查不到：" + JSON.stringify(found));
    assert.equal(found.quota.calls, 20);
    // 记一次用量：同一张卡再存一次应当走 upsert 合并，而不是插出第二条。
    await store.save(Object.assign({}, found, { used: { calls: 1, tokens: 33 } }));
    assert.equal(pg.ddl, 1, "不该重复建表");
    assert.equal(pg.rows.size, 1, "同一张卡不该插成两行");
    const again = await store.get("card-9");
    assert.equal(again.used.calls, 1);
    assert.equal(again.used.tokens, 33);
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.remove("card-9"), true);
    assert.equal(await store.get("card-9"), null);
  });

  await check("PG 账本：DDL 被拒时报清楚，不假装成功", async () => {
    const store = createPgStore({ gatewayBase: "http://127.0.0.1:" + pgPort, apiKey: "fake", env: "cyan1-test" });
    let message = "";
    try { await store.list(); } catch (error) { message = error.message; }
    assert.ok(message.indexOf("建表失败") >= 0, "应当说明卡在建表这一步：" + message);
  });

  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => pgGateway.close(resolve));

  console.log("");
  console.log(`RELAY_CHECK=${passed}/${passed + failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("跑挂了：" + (error && error.stack || error));
  process.exitCode = 1;
});
