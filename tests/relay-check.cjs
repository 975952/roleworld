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
      if (body.model === "empty") {
        // 200，但正文是空的、额度花在思考内容上（deepseek-flash 实测就是这个形状）。
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-empty",
          choices: [{ message: { role: "assistant", content: "", reasoning_content: "The user is asking me to reply with only two characters" }, finish_reason: "length" }],
          usage: { prompt_tokens: 11, completion_tokens: 64, total_tokens: 75 },
        }));
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

/**
 * 假的火山「豆包语音合成模型 2.0」上游。
 *
 * 把**协议**钉在这里（这些是官方文档里的硬事实，写错了整条链路就是"点了没反应"）：
 *   - 请求头要有资源标识 X-Api-Resource-Id: seed-tts-2.0，以及两套控制台鉴权之一；
 *   - 请求体是 { user:{uid}, req_params:{ text, speaker, audio_params } }；
 *   - 响应是**一行一个 JSON**（HTTP Chunked），音频是 base64 的 data 字段；
 *   - 结束那一行是 { code: 20000000, usage:{ text_words } }。
 * 另外造三种特例给用例用：FAIL（流里报错码）、TIMEOUT（不回）、SLOW（回一半挂着）。
 */
function startVoiceUpstream() {
  const seen = [];
  const state = { slowStarted: 0, slowAborted: false, release: null, held: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (_) { body = {}; }
      seen.push({ headers: req.headers, body });
      const text = String((body.req_params && body.req_params.text) || "");
      const json = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json", "X-Tt-Logid": "fake-log-1" });
        res.end(JSON.stringify(payload));
      };
      if (!req.headers["x-api-key"] && !req.headers["x-api-app-id"]) return json(401, { code: 40100000, message: "missing auth" });
      if (req.headers["x-api-resource-id"] !== "seed-tts-2.0") {
        return json(400, { code: 55000000, message: "resource ID is mismatched with speaker related resource" });
      }
      if (text.indexOf("FAIL") >= 0) {
        res.writeHead(200, { "Content-Type": "application/json", "X-Tt-Logid": "fake-log-2" });
        res.write(JSON.stringify({ code: 45000000, message: "上游拒绝了这次合成" }) + "\n");
        res.end();
        return;
      }
      if (text.indexOf("TIMEOUT") >= 0) {
        // 故意不回：让中转自己的超时兜底。
        res.writeHead(200, { "Content-Type": "application/json" });
        return;
      }
      const line = (audio) => JSON.stringify({ code: 0, message: "", data: Buffer.from(audio).toString("base64"), done: false }) + "\n";
      const done = JSON.stringify({ code: 20000000, message: "ok", data: null, usage: { text_words: text.length } }) + "\n";
      // 真实上游对"没有可念内容"的输入就是这个行为：回一个「合成结束」、**零字节音频**。
      // 用户 0.1.77 实测原话：「上游说合成结束了，但一个字节的音频都没给。」
      // 这条假上游按同一行为建模 —— 于是"这类输入压根不该被送上来"变成了可断言的。
      if (!/[\p{L}\p{N}]/u.test(text)) {
        res.writeHead(200, { "Content-Type": "application/json", "X-Tt-Logid": "fake-log-empty" });
        res.write(done);
        res.end();
        return;
      }
      if (text.indexOf("SLOW") >= 0) {
        state.held = true;
        state.slowStarted += 1;
        res.writeHead(200, { "Content-Type": "application/json", "X-Tt-Logid": "fake-log-slow" });
        res.write(line("MP3:" + text));
        let finished = false;
        res.on("close", () => { if (!finished) state.slowAborted = true; });
        state.release = () => {
          finished = true;
          try { res.write(line("MP3:" + text)); res.write(done); res.end(); } catch (_) { /* 已经断了 */ }
        };
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "X-Tt-Logid": "fake-log-3" });
      // 两段音频：客户端拼起来必须和这里一模一样（顺序 + 内容）。
      res.write(line("MP3:" + text));
      setTimeout(() => {
        try { res.write(line("MP3:" + text)); res.write(done); res.end(); } catch (_) { /* 已经断了 */ }
      }, 10);
    });
  });
  return {
    server,
    seen,
    get slowStarted() { return state.slowStarted; },
    get slowAborted() { return state.slowAborted; },
    releaseSlow() { if (state.release) state.release(); },
  };
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

  await check("流式请求会自动带上 include_usage（否则 token 额度永远记不到）", async () => {
    // 上游地址是本地假端点，不属于"DeepSeek 官方"，所以这里靠开关显式打开，
    // 顺便验证开关这条路径；线上指向 api.deepseek.com 时是自动带的。
    process.env.RELAY_INCLUDE_USAGE = "1";
    // 用一张新卡，别把主用例那张卡的次数吃掉。
    const fresh = await server.relay.createCard({ label: "include_usage", quota: { calls: 2, tokens: 0 } });
    const res = await chat(fresh.token, { model: "deepseek-flash", stream: true, messages: [{ role: "user", content: "再算一次" }] });
    assert.equal(res.status, 200);
    await res.text();
    const last = upstream.seen[upstream.seen.length - 1].body;
    assert.equal(last.stream_options && last.stream_options.include_usage, true,
      "流式请求应当带上 stream_options.include_usage：" + JSON.stringify(last.stream_options));
    delete process.env.RELAY_INCLUDE_USAGE;
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

  await check("上游自检：HTTP 200 但正文是空的 —— **不算可用**，并说清为什么", async () => {
    // 真事（2026-09-14 部署后核对时发现）：deepseek-flash 会先吐思考内容，
    // 而自检原来写死 max_tokens: 64 —— 额度全被思考吃掉，正文是空的，
    // 结果自检报 `ok: true` 却什么都没回。"报成功但没内容"比报错更坑：
    // 用户会以为链路是好的（当时差点因此去查一个不存在的问题）。
    const res = await admin("GET", "/admin/upstream/selftest?model=empty");
    assert.equal(res.status, 502, "没有正文就不该是 200：" + JSON.stringify(await res.clone().json().catch(() => ({}))));
    const body = await res.json();
    assert.equal(body.ok, false, "空正文不能算 ok：" + JSON.stringify(body));
    assert.equal(body.status, 200, "上游 HTTP 状态码要如实带出来");
    assert.ok(/空的/.test(body.warning || ""), "要说清是空的：" + JSON.stringify(body));
    assert.ok(/reasoning|思考/.test(body.warning || ""), "要说清是思考内容吃掉了额度：" + JSON.stringify(body));
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

  await check("加次数 / 续期：把老卡的上限与到期日就地改掉（不用重新发卡）", async () => {
    // 2026-09-12 新增：同学那边次数用完了，以前只能"重新发一张"（他就得重新配一次卡）。
    const created = await fetch(base + "/admin/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
      body: JSON.stringify({ label: "同学Z", calls: 10, days: 3 }),
    }).then((res) => res.json());
    const before = await fetch(base + "/card/quota", { headers: { Authorization: "Bearer " + created.token } }).then((res) => res.json());
    assert.equal(before.callsLeft, 10);

    const updated = await fetch(base + "/admin/cards/" + created.id + "/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
      body: JSON.stringify({ calls: 60, days: 30 }),
    }).then((res) => res.json());
    assert.equal(updated.quota.calls, 60, "上限没改上：" + JSON.stringify(updated));
    const after = await fetch(base + "/card/quota", { headers: { Authorization: "Bearer " + created.token } }).then((res) => res.json());
    assert.equal(after.callsLeft, 60, "改完之后剩余次数不对：" + JSON.stringify(after));
    const days = Math.round((Date.parse(after.expiresAt) - Date.now()) / 86400000);
    assert(days >= 29 && days <= 30, "续期后的到期日不对：" + after.expiresAt);
    // 已经用掉的不该被重置（加的是上限，不是把账抹掉）。
    assert.equal(after.used.calls, before.used.calls, "改上限把已用次数也清了");

    const missing = await fetch(base + "/admin/cards/nope/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
      body: JSON.stringify({ calls: 5 }),
    });
    assert.equal(missing.status, 404, "改一张不存在的卡应当 404");
    const noAuth = await fetch(base + "/admin/cards/" + created.id + "/update", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calls: 5 }),
    });
    assert.equal(noAuth.status, 401, "没带口令也能改卡？");
  });

  await check("按天用量：每一轮记到当天，并汇总成「最近 N 天」", async () => {
    const created = await fetch(base + "/admin/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
      body: JSON.stringify({ label: "同学Y", calls: 10, days: 3 }),
    }).then((res) => res.json());
    // 真发一轮（走假上游），用量应当同时进 used 和 daily。
    await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + created.token },
      body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "在吗" }] }),
    }).then((res) => res.text());
    const today = new Date().toISOString().slice(0, 10);
    const stored = await store.get(created.id);
    assert.ok(stored && stored.daily && stored.daily[today], "当天没有记上按天用量：" + JSON.stringify(stored && stored.daily));
    assert.equal(stored.daily[today].calls, 1, "按天的次数不对：" + JSON.stringify(stored.daily[today]));
    assert(stored.daily[today].tokens > 0, "按天的 token 没记上");

    const usage = await fetch(base + "/admin/usage?days=7", { headers: { Authorization: "Bearer admin-secret-123" } }).then((res) => res.json());
    assert.equal(usage.days.length, 7, "应当返回 7 天：" + usage.days.length);
    assert.equal(usage.days[6].day, today, "最后一行应当是今天");
    assert(usage.days[6].calls >= 1, "今天的汇总没算上：" + JSON.stringify(usage.days[6]));
    assert.equal(usage.days[0].calls, 0, "7 天前不该有量");
  });

  /* ==================================================================== *
   * 角色语音：火山「豆包语音合成模型 2.0」
   *
   * 用**假的上游**（一个本地 HTTP 服务）把协议钉住：请求头、请求体、NDJSON
   * 一行一个 JSON、base64 音频、结束码 20000000、错误码。
   * 这一套跑起来不需要任何火山凭据，也不会产生任何费用。
   * ==================================================================== */

  console.log("");
  console.log("== 体验卡中转：角色语音（假火山上游）==");

  const voiceUpstream = startVoiceUpstream();
  const voicePort = await listen(voiceUpstream.server);
  const voiceLogs = [];
  const voiceStore = createMemoryStore();
  const voiceEnv = {
    VOLC_TTS_APP_ID: "test-app-id",
    VOLC_TTS_ACCESS_KEY: "test-access-token",
    VOLC_TTS_BASE: "http://127.0.0.1:" + voicePort,
    VOLC_TTS_PATH: "/api/v3/tts/unidirectional",
  };
  const voiceRelay = createRelay({
    store: voiceStore,
    upstreamBase: "http://127.0.0.1:" + upstreamPort,
    upstreamKey: "sk-upstream-secret",
    adminSecret: "admin-secret-123",
    logSink: (line) => voiceLogs.push(line),
    voiceEnv,
    tts: require(path.join(RELAY, "tts.js")).createTtsClient({ env: voiceEnv, timeoutMs: 1500 }),
  });
  const voiceRelayPort = await listen(voiceRelay);
  const voiceBase = "http://127.0.0.1:" + voiceRelayPort;

  const speak = (token, body) => fetch(voiceBase + "/v1/audio/speech", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body || {}),
  });

  await check("语音：没带卡 → 401，且一个字节都不打上游", async () => {
    const before = voiceUpstream.seen.length;
    const res = await speak("", { text: "你好" });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "CARD_UNKNOWN");
    assert.equal(voiceUpstream.seen.length, before, "没通过卡校验就不该打火山上游");
  });

  const voiceCard = await voiceRelay.relay.createCard({ label: "语音卡", quota: { calls: 5, tokens: 0, voice: 3, voiceChars: 200 } });

  await check("语音：正常合成 → 200 audio/mpeg，字节与上游一致，且请求头/请求体符合官方协议", async () => {
    const res = await speak(voiceCard.token, { text: "你好呀。", speaker: "zh_female_xiaohe_uranus_bigtts", speech_rate: 10 });
    assert.equal(res.status, 200, "合成失败：" + await res.clone().text());
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
    const got = Buffer.from(await res.arrayBuffer());
    // 假上游把每段音频拼成 "MP3:" + 文本，两段 → 断言内容与顺序都对。
    assert.equal(got.toString("utf8"), "MP3:你好呀。MP3:你好呀。", "音频字节被改动了：" + got.toString("utf8"));

    const last = voiceUpstream.seen[voiceUpstream.seen.length - 1];
    // 旧版控制台鉴权：App ID + Access Key（两件套，缺一不可）。新版控制台则是单发 X-Api-Key。
    assert.equal(last.headers["x-api-app-id"], "test-app-id", "缺少 X-Api-App-Id");
    assert.equal(last.headers["x-api-access-key"], "test-access-token", "缺少 X-Api-Access-Key");
    assert.equal(last.headers["x-api-key"], undefined, "两套鉴权不要混发（同时出现会被上游当成配错）");
    assert.equal(last.headers["x-api-connect-id"], undefined, "X-Api-Connect-Id 是 WebSocket 那条接口的头，HTTP 不该发");
    assert.equal(last.headers["x-api-resource-id"], "seed-tts-2.0",
      "资源标识必须是「豆包语音合成模型 2.0」的 seed-tts-2.0，实际：" + last.headers["x-api-resource-id"]);
    assert.ok(last.headers["x-api-request-id"], "应当带一个 X-Api-Request-Id 便于排障");
    assert.equal(last.body.req_params.text, "你好呀。");
    assert.equal(last.body.req_params.speaker, "zh_female_xiaohe_uranus_bigtts");
    assert.equal(last.body.req_params.audio_params.format, "mp3");
    assert.equal(last.body.req_params.audio_params.sample_rate, 24000);
    assert.equal(last.body.req_params.audio_params.speech_rate, 10, "语速要透传给上游（[-50,100]）");
    assert.ok(last.body.user && last.body.user.uid, "官方协议要求 user.uid");
    // 响应里绝不能出现服务端的火山凭据
    const headers = JSON.stringify(Array.from(res.headers.entries()));
    assert.ok(headers.indexOf("test-access-token") < 0, "响应头里泄漏了上游凭据");
    assert.ok(headers.indexOf("test-app-id") < 0, "响应头里泄漏了上游凭据");
  });

  await check("语音：新版控制台鉴权（只有 X-Api-Key）也能走通，且不会混发 App-Id", async () => {
    const store2 = createMemoryStore();
    const env2 = Object.assign({}, voiceEnv, { VOLC_TTS_APP_ID: "", VOLC_TTS_ACCESS_KEY: "", VOLC_TTS_API_KEY: "new-console-key" });
    const relay2 = createRelay({
      store: store2,
      upstreamBase: "http://127.0.0.1:" + upstreamPort,
      upstreamKey: "sk-upstream-secret",
      adminSecret: "admin-secret-123",
      logSink: () => {},
      voiceEnv: env2,
      tts: require(path.join(RELAY, "tts.js")).createTtsClient({ env: env2, timeoutMs: 2000 }),
    });
    try {
      const port2 = await listen(relay2);
      const card2 = await relay2.relay.createCard({ label: "新版控制台", quota: { voice: 5 } });
      const res = await fetch("http://127.0.0.1:" + port2 + "/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + card2.token },
        body: JSON.stringify({ text: "新版鉴权" }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      await res.arrayBuffer();
      const last = voiceUpstream.seen[voiceUpstream.seen.length - 1];
      assert.equal(last.headers["x-api-key"], "new-console-key");
      assert.equal(last.headers["x-api-app-id"], undefined, "新版控制台模式下不该发 App-Id");
      const cfg = await fetch("http://127.0.0.1:" + port2 + "/admin/voice/config", { headers: { Authorization: "Bearer admin-secret-123" } }).then((r) => r.json());
      assert.equal(cfg.configured, true);
    } finally {
      // ⚠ 关闭必须放在 finally 里：断言失败时若跳过关闭，监听句柄会留活 ——
      //   汇总打完了进程也不退出，`npm test` 的 && 链就此永远卡住
      //   （2026-09-17 实测：一次瞬时 fetch failed 让整轮回归挂死十几分钟）。
      await new Promise((resolve) => relay2.close(resolve));
    }
  });

  await check("语音用量：记在独立的 voice / voiceChars 上，**不**吃聊天的次数", async () => {
    const info = await fetch(voiceBase + "/card/quota", { headers: { Authorization: "Bearer " + voiceCard.token } }).then((r) => r.json());
    assert.equal(info.used.voice, 1, "语音次数没记上：" + JSON.stringify(info.used));
    assert.equal(info.used.voiceChars, "你好呀。".length, "语音字符数没记上：" + JSON.stringify(info.used));
    assert.equal(info.used.calls, 0, "语音把聊天的次数也扣了（两者必须分开）：" + JSON.stringify(info.used));
    assert.equal(info.voiceLeft, 2);
    assert.equal(info.voiceCharsLeft, 200 - "你好呀。".length);
    const today = new Date().toISOString().slice(0, 10);
    const stored = await voiceStore.get(voiceCard.card.id);
    assert.equal(stored.daily[today].voice, 1, "按天没记语音：" + JSON.stringify(stored.daily[today]));
    assert.equal(stored.daily[today].chars, "你好呀。".length);
    assert.equal(stored.daily[today].calls, 0, "语音不该算进按天的聊天次数");
  });

  await check("语音：日志里只有字符数与音色，**没有那句话**", async () => {
    const dump = JSON.stringify(voiceLogs);
    assert.ok(dump.indexOf("你好呀") < 0, "日志里出现了要合成的正文：" + dump.slice(0, 300));
    assert.ok(dump.indexOf("test-access-token") < 0, "日志里出现了上游凭据");
    const row = voiceLogs.filter((one) => one.event === "voice").pop();
    assert.ok(row && row.chars > 0, "应当记一条语音用量：" + JSON.stringify(row));
    assert.equal(row.speaker, "zh_female_xiaohe_uranus_bigtts");
  });

  await check("语音：音色不在中转白名单里 → 400，并且不去打上游", async () => {
    const before = voiceUpstream.seen.length;
    const res = await speak(voiceCard.token, { text: "你好", speaker: "zh_male_not_a_real_voice" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VOICE_SPEAKER_UNKNOWN");
    assert.equal(voiceUpstream.seen.length, before, "音色没通过校验就不该打上游");
  });

  await check("语音：一次太长的文本 → 413，并说明该由客户端按句切分", async () => {
    const res = await speak(voiceCard.token, { text: "啊".repeat(500) });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "VOICE_TEXT_TOO_LONG");
    assert.ok(body.error.message.indexOf("切分") >= 0, "要说清正确的做法：" + body.error.message);
  });

  await check("语音：空文本 → 400（不当作「念了个空」）", async () => {
    const res = await speak(voiceCard.token, { text: "   " });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VOICE_EMPTY_TEXT");
  });

  await check("语音：只有标点 / 表情的文本也必须在门口挡住（用户 0.1.77 报的「一个字节的音频都没给」）", async () => {
    // 用户实测原话（角色 Alaric Vane 的一条语音消息）：
    //   「这条语音没做出来 / 上游说合成结束了，但一个字节的音频都没给。」
    // 根因：`speakableText()` 只清标记/符号/括号动作，**不判"还剩不剩下能念的字"**；
    //   而中转只挡"整串为空"（trim 之后为空）。于是「……」「😀」「——」这类回复
    //   会原样送去上游 —— 上游没有可念的东西，回一个「合成结束」但零字节音频。
    // 期望：这种文本**根本不该打到上游**（那是付费调用），也不该让用户看到一句查不下去的话。
    for (const text of ["……", "——", "😀😀", "。。。", "!?!"]) {
      const before = voiceUpstream.seen.length;
      const res = await speak(voiceCard.token, { text });
      const body = await res.json().catch(() => ({}));
      assert.equal(res.status, 400,
        JSON.stringify(text) + " 不该被送去合成，实际 HTTP " + res.status + "：" + JSON.stringify(body));
      assert.equal(body.error && body.error.code, "VOICE_EMPTY_TEXT",
        JSON.stringify(text) + " 该按「没有可合成的内容」处理：" + JSON.stringify(body));
      assert.equal(voiceUpstream.seen.length, before,
        JSON.stringify(text) + " 不该打火山上游（那是付费调用）");
    }
    // 反面对照：**带一个字**的就必须照常合成（别把正常内容一起挡了）
    const okRes = await speak(voiceCard.token, { text: "……好。" });
    assert.equal(okRes.status, 200, "带文字的不能一起挡掉：" + await okRes.clone().text());
    await okRes.arrayBuffer();
  });

  await check("语音：上游报错码原样带出来（不吞成「失败了」），并且**不扣**用量", async () => {
    const before = (await voiceStore.get(voiceCard.card.id)).used.voice;
    const res = await speak(voiceCard.token, { text: "请把这句话弄失败 FAIL" });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error.message.indexOf("上游拒绝") >= 0, "上游的原话要带出来：" + JSON.stringify(body));
    const after = (await voiceStore.get(voiceCard.card.id)).used.voice;
    assert.equal(after, before, "合成失败却扣了用户的语音次数");
  });

  await check("语音：上游超时 → 504 VOICE_TIMEOUT，同样不扣用量", async () => {
    const before = (await voiceStore.get(voiceCard.card.id)).used.voice;
    const res = await speak(voiceCard.token, { text: "这句会超时 TIMEOUT" });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, "VOICE_TIMEOUT");
    assert.equal((await voiceStore.get(voiceCard.card.id)).used.voice, before);
  });

  await check("语音：客户端中断（切角色/点停止）→ 上游被掐掉，且不扣用量", async () => {
    const before = (await voiceStore.get(voiceCard.card.id)).used.voice;
    const controller = new AbortController();
    const pending = fetch(voiceBase + "/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + voiceCard.token },
      body: JSON.stringify({ text: "这一句会被中途取消 SLOW" }),
      signal: controller.signal,
    }).catch(() => null);
    // 等上游真的收到请求了再取消（否则测的是"根本没发出去"）。
    for (let i = 0; i < 60 && voiceUpstream.slowStarted === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert(voiceUpstream.slowStarted > 0, "前置条件不成立：上游没收到那次慢请求");
    controller.abort();
    await pending;
    for (let i = 0; i < 80 && !voiceUpstream.slowAborted; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert(voiceUpstream.slowAborted, "客户端断了之后，中转没有把火山上游掐掉（钱还在烧）");
    // 中转把上游掐掉、写日志、回响应是几段异步，测试里不能假定"客户端一断日志就有了"。
    let canceled = 0;
    for (let i = 0; i < 80; i += 1) {
      canceled = voiceLogs.filter((one) => one.event === "voice-canceled").length;
      if (canceled > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await voiceStore.get(voiceCard.card.id)).used.voice, before, "被取消的合成不该扣用量");
    assert(canceled > 0, "应当记一条取消（只有元数据）");
    const row = voiceLogs.filter((one) => one.event === "voice-canceled").pop();
    assert.ok(JSON.stringify(row).indexOf("这一句") < 0, "取消日志里出现了正文：" + JSON.stringify(row));
  });

  await check("语音：同一张卡并发第二路 → 429 VOICE_BUSY（默认一路一句）", async () => {
    // 计数是累计的（上一个用例也走过慢路径），所以这里必须看**增量**，
    // 否则"等慢请求开始"会立刻通过，release 会被提前调掉。
    const before = voiceUpstream.slowStarted;
    const first = fetch(voiceBase + "/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + voiceCard.token },
      body: JSON.stringify({ text: "第一句会慢一点 SLOW" }),
    });
    for (let i = 0; i < 80 && voiceUpstream.slowStarted === before; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert(voiceUpstream.slowStarted > before, "前置条件不成立：慢请求没到上游");
    const second = await speak(voiceCard.token, { text: "第二句" });
    assert.equal(second.status, 429, "同一张卡并发应当被挡住");
    assert.equal((await second.json()).error.code, "VOICE_BUSY");
    voiceUpstream.releaseSlow();
    const done = await first;
    assert.equal(done.status, 200, "被放行的那一路应当正常完成：" + await done.clone().text());
    await done.arrayBuffer();
  });

  await check("语音：语音额度用完 → 402 CARD_NO_VOICE，**文字聊天不受影响**", async () => {
    const card = await voiceRelay.relay.createCard({ label: "语音用完", quota: { calls: 5, tokens: 0, voice: 1, voiceChars: 0 } });
    assert.equal((await speak(card.token, { text: "第一句" })).status, 200);
    const blocked = await speak(card.token, { text: "第二句" });
    assert.equal(blocked.status, 402);
    const body = await blocked.json();
    assert.equal(body.error.code, "CARD_NO_VOICE");
    assert.ok(body.error.message.indexOf("文字聊天不受影响") >= 0, "要说清聊天还能用：" + body.error.message);
    // 聊天照样能发（走假聊天上游）
    const chat = await fetch(voiceBase + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + card.token },
      body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    assert.equal(chat.status, 200, "语音额度用完不该影响文字聊天");
    await chat.text();
  });

  await check("语音：字数不够 → 402 CARD_NO_VOICE_CHARS，并写清「这次要多少字」", async () => {
    const card = await voiceRelay.relay.createCard({ label: "字数很少", quota: { calls: 5, tokens: 0, voice: 0, voiceChars: 4 } });
    const res = await speak(card.token, { text: "这句话有十个字" });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.code, "CARD_NO_VOICE_CHARS");
    assert.ok(body.error.message.indexOf("这次要 7 字") >= 0, "要说清差多少：" + body.error.message);
  });

  await check("语音：中转没配火山凭据 → 503 RELAY_NO_VOICE_KEY（客户端据此不显示朗读）", async () => {
    const bareStore = createMemoryStore();
    const bare = createRelay({
      store: bareStore,
      upstreamBase: "http://127.0.0.1:" + upstreamPort,
      upstreamKey: "k",
      adminSecret: "admin-secret-123",
      voiceEnv: {},
      tts: require(path.join(RELAY, "tts.js")).createTtsClient({ env: {} }),
    });
    const barePort = await listen(bare);
    const card = await bare.relay.createCard({ label: "没配语音" });
    const res = await fetch("http://127.0.0.1:" + barePort + "/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + card.token },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "RELAY_NO_VOICE_KEY");
    assert.ok(body.error.message.indexOf("VOLC_TTS_APP_ID") >= 0, "要说清缺哪个环境变量：" + body.error.message);
    const info = await fetch("http://127.0.0.1:" + barePort + "/voice/info", { headers: { Authorization: "Bearer " + card.token } }).then((r) => r.json());
    assert.equal(info.enabled, false, "没配凭据时 /voice/info 必须说 enabled=false");
    assert.equal(info.canSpeakNow, false);
    await new Promise((resolve) => bare.close(resolve));
  });

  await check("/voice/info：报出音色表、一次能合多长、还剩多少语音额度", async () => {
    const info = await fetch(voiceBase + "/voice/info", { headers: { Authorization: "Bearer " + voiceCard.token } }).then((r) => r.json());
    assert.equal(info.ok, true);
    assert.equal(info.enabled, true);
    assert.equal(info.format, "mp3");
    assert.ok(info.maxChars >= 100, "要报出单次上限：" + info.maxChars);
    assert.ok(Array.isArray(info.speakers) && info.speakers.length >= 4, "音色表太小：" + JSON.stringify(info.speakers));
    for (const one of info.speakers) {
      assert.ok(one.id && one.label, "每个音色都要有 id 与中文名：" + JSON.stringify(one));
      assert.ok(one.id.indexOf("uranus_bigtts") >= 0, "默认只下发与 seed-tts-2.0 配套的音色：" + one.id);
    }
    assert.ok(info.speakers.some((one) => one.id === info.defaultSpeaker), "defaultSpeaker 必须在音色表里");
    assert.equal(typeof info.voiceLeft, "number");
    assert.equal(typeof info.voiceCharsLeft, "number");
  });

  await check("/admin/voice/config：只报「配没配」，绝不联网、绝不产生费用", async () => {
    const before = voiceUpstream.seen.length;
    const res = await fetch(voiceBase + "/admin/voice/config", { headers: { Authorization: "Bearer admin-secret-123" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, true);
    assert.equal(body.resourceId, "seed-tts-2.0");
    assert.equal(body.maxChars >= 100, true);
    assert.equal(body.concurrency.perCard, 1);
    assert.equal(voiceUpstream.seen.length, before, "自检不该真的去合成（那是付费调用）");
    const dump = JSON.stringify(body);
    assert.ok(dump.indexOf("test-access-token") < 0, "自检结果里泄漏了凭据");
    // 没带管理口令时必须挡住
    assert.equal((await fetch(voiceBase + "/admin/voice/config")).status, 401);
  });

  await check("健康检查能看出语音配没配（避免以为配了、其实是空的）", async () => {
    const body = await (await fetch(voiceBase + "/healthz")).json();
    assert.equal(body.voiceKeySet, true);
    assert.equal(body.voiceResourceId, "seed-tts-2.0");
    assert.ok(body.voiceSpeakers >= 4);
    assert.ok(JSON.stringify(body).indexOf("test-access-token") < 0, "健康检查里泄漏了凭据");
  });

  await check("语音：发卡/改卡都能带语音额度，且列卡不泄露卡号", async () => {
    const created = await fetch(voiceBase + "/admin/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
      body: JSON.stringify({ label: "带语音的卡", calls: 10, voice: 20, voiceChars: 5000, days: 3 }),
    }).then((r) => r.json());
    assert.equal(created.quota.voice, 20);
    assert.equal(created.quota.voiceChars, 5000);
    const updated = await fetch(voiceBase + "/admin/cards/" + created.id + "/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-secret-123" },
      body: JSON.stringify({ voice: 50, voiceChars: 9000 }),
    }).then((r) => r.json());
    assert.equal(updated.quota.voice, 50, "加语音次数没生效：" + JSON.stringify(updated.quota));
    assert.equal(updated.quota.voiceChars, 9000);
    const list = await fetch(voiceBase + "/admin/cards", { headers: { Authorization: "Bearer admin-secret-123" } }).then((r) => r.json());
    const dump = JSON.stringify(list);
    assert.ok(dump.indexOf("RW-") < 0, "列卡结果里不该出现卡号");
    const usage = await fetch(voiceBase + "/admin/usage?days=3", { headers: { Authorization: "Bearer admin-secret-123" } }).then((r) => r.json());
    assert.equal(usage.days.length, 3);
    assert.ok(usage.totalVoice >= 1, "按天汇总里应当算上语音：" + JSON.stringify(usage));
    assert.ok(usage.days[2].voice >= 1 && usage.days[2].chars > 0, "今天的语音用量不对：" + JSON.stringify(usage.days[2]));
  });

  await check("音色表：从官方快照生成、与磁盘一致，且**不含名人/影视角色音色**", async () => {
    // 2026-09-14：用户问"只有 53 种吗" —— 不是。官方 2.0（`*_uranus_bigtts`）全表 230 个，
    // 原来那张 53 个的表是**手抄**的（从一份公开实现对照着列），中文少一半、英文只剩 1/6。
    // 现在改成从官方文档的快照生成（`scripts/make-voices.cjs`），这条守卫钉三件事：
    //   ① 生成结果与快照一致（有人手改 relay/voices.js 就会红）；
    //   ② 只放 2.0 那一族（别族进来上游必回 55000000）；
    //   ③ **一个名人/影视角色音色都不许下发**（授权风险）。
    const { execFileSync } = require("node:child_process");
    let checkOutput = "";
    try {
      checkOutput = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "make-voices.cjs"), "--check"], { encoding: "utf8" });
    } catch (error) {
      assert.fail("relay/voices.js 与官方快照不一致（手改了？）：" + String((error && error.stdout) || (error && error.message) || error));
    }
    assert(checkOutput.indexOf("是最新的") >= 0, "生成检查没通过：" + checkOutput);

    const voices = require(path.join(RELAY, "voices.js"));
    const all = voices.resolveSpeakers({}).speakers;
    assert(all.length >= 200, "音色表太小了（官方 2.0 有两百多个）：" + all.length);
    for (const one of all) {
      assert(voices.ID_RE.test(one.id), "有个音色不属于 2.0 那一族（上游会回 55000000）：" + one.id);
      assert(one.label && one.label.trim(), "音色没有名字：" + one.id);
      assert(one.langLabel, "音色没有分组用的语言标签：" + one.id);
    }
    // 名人/影视角色：按 id 匹配（有几条显示名看不出来，只有 id 暴露来历）
    const likeness = all.filter((one) => voices.LIKENESS_RE.test(one.id));
    assert(likeness.length === 0, "下发列表里出现了名人/影视角色音色（授权风险）：" + likeness.map((one) => one.id).join(", "));
    assert(voices.LIKENESS_EXCLUDED.length >= 10,
      "被排除的名人音色应当是记下来的（现在只有 " + voices.LIKENESS_EXCLUDED.length + " 条）");
    // 默认音色必须在表里，且是官方示例用的那个
    assert(all.some((one) => one.id === voices.DEFAULT_SPEAKER), "默认音色不在表里：" + voices.DEFAULT_SPEAKER);
    // 分组要能分出中文/英语
    const labels = new Set(all.map((one) => one.langLabel));
    assert(labels.has("中文") && labels.has("英语"), "语言分组不对：" + Array.from(labels).join(","));
    console.log("        音色表 " + all.length + " 个（中文 " + all.filter((o) => o.lang === "zh").length
      + " / 英语 " + all.filter((o) => o.lang === "en").length
      + " / 其他 " + all.filter((o) => o.lang === "other").length
      + "），已排除名人音色 " + voices.LIKENESS_EXCLUDED.length + " 个");
  });

  await check("/voice/info：报出分组字段（二百多个音色不分组没法挑）", async () => {
    const info = await fetch(voiceBase + "/voice/info", { headers: { Authorization: "Bearer " + voiceCard.token } }).then((r) => r.json());
    assert.ok(info.speakers.length >= 200, "下发的音色太少：" + info.speakers.length);
    for (const one of info.speakers) {
      assert(one.langLabel, "少了分组标签：" + JSON.stringify(one));
    }
    assert(info.speakers.some((one) => one.langLabel === "中文"), "没有中文分组");
    assert(info.speakers.some((one) => one.langLabel === "英语"), "没有英语分组");
    // 分组标签里不能混进名人音色（分组是界面直接显示的）
    const dump = JSON.stringify(info.speakers);
    assert(dump.indexOf("brad_pitt") < 0 && dump.indexOf("zendaya") < 0 && dump.indexOf("gollum") < 0,
      "下发的音色里出现了名人/影视角色");
  }); // ← 这两条必须放在 voiceRelay.close **之前**（后面还要打它的 /voice/info）

  await new Promise((resolve) => voiceRelay.close(resolve));
  await new Promise((resolve) => voiceUpstream.server.close(resolve));

  await check("云托管镜像里必须带上所有被 require 的本地模块（漏一个 = 服务起不来）", async () => {
    // 真事：2026-09-14 加语音时新增了 relay/tts.js 与 relay/voices.js，
    // 但 Dockerfile 的 COPY 是**写死的白名单**（刻意的：relay/ 下有 admin-secret.local.txt
    // 和 cards.local.jsonl 两个凭据文件，绝不能进镜像）。结果差点把"require 不到模块"
    // 的镜像发上去 —— 那不只是语音坏，聊天的中转会**整台起不来**。
    // 这条守卫拿"实际 require 的本地模块"去比 COPY 那一行，漏一个就红。
    const fs = require("node:fs");
    const dockerfile = fs.readFileSync(path.join(RELAY, "Dockerfile"), "utf8");
    // 把**所有** COPY ... ./ 的目标加起来（Dockerfile 里有两条：package.json 与源码那几个）。
    const copied = new Set();
    for (const match of dockerfile.matchAll(/^COPY\s+([^\n]*?)\s+\.\/\s*$/gm)) {
      for (const name of match[1].split(/\s+/).filter(Boolean)) copied.add(name.replace(/^\.\//, ""));
    }
    assert(copied.size > 0, "Dockerfile 里找不到 COPY ... ./ 那一行（结构变了？）");
    const needed = new Set();
    for (const file of ["server.js", "store.js", "index.js", "scf.js"]) {
      const full = path.join(RELAY, file);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/require\(\s*["']\.\/([A-Za-z0-9_.-]+\.js)["']\s*\)/g)) needed.add(match[1]);
    }
    const missing = Array.from(needed).filter((name) => !copied.has(name));
    assert(missing.length === 0,
      "Dockerfile 的 COPY 少了这些被 require 的模块（容器里会 require 不到）：" + missing.join(", "));
    // 反过来也要看一眼：凭据文件**绝不能**出现在 COPY 里。
    for (const secret of ["admin-secret.local.txt", "cards.local.jsonl"]) {
      assert(!copied.has(secret), "Dockerfile 把本机凭据文件打进镜像了：" + secret);
    }
    // 生成出来的音色表与快照也要一起进镜像（少一个就起不来）。
    assert(copied.has("voices.js") && copied.has("voices.official.json") === false,
      "Dockerfile 的 COPY 里音色表不对：voices.js 必须在（它被 require），voices.official.json 不必（只是生成用的快照）");
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

  const pg = { rows: new Map(), ddl: 0, addedColumns: [] };
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
        // 只认"管理员角色 + CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS"，
        // 别的一律拒绝 —— 免得真建错东西。
        // （ADD COLUMN 是给老库补新列的：2026-09-12 起有按天用量那一列。）
        const sql = String(body.sql || "");
        if (body.role !== "cloudbase_postgres") return send(403, { code: "ACTION_FORBIDDEN" });
        const isCreate = /^CREATE TABLE IF NOT EXISTS rw_cards \(/.test(sql);
        const isAddColumn = /^ALTER TABLE rw_cards ADD COLUMN IF NOT EXISTS [a-z_]+ /.test(sql);
        if (!isCreate && !isAddColumn) {
          return send(400, { code: "INVALID_PARAM", message: "unexpected sql" });
        }
        pg.ddl += 1;
        if (isAddColumn) pg.addedColumns.push(String(sql.match(/EXISTS\s+([a-z_]+)/)[1]));
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
    // 一次建表 + 给老库补上"建表之后才加的列"各一次。列清单以 store 自己导出的为准 ——
    // 免得每次加一列（例如语音那四列）都要回来手改这个数字。
    const expectedDdl = 1 + require(path.join(RELAY, "store.js")).PG_UPGRADE_COLUMNS.length;
    assert.equal(pg.ddl, expectedDdl, "应当是「建表 + 补列」各一次，实际 " + pg.ddl);
    assert.ok(pg.addedColumns.indexOf("daily") >= 0, "应当补上按天用量那一列：" + JSON.stringify(pg.addedColumns));
    assert.ok(pg.addedColumns.indexOf("used_voice") >= 0, "应当补上语音用量那一列：" + JSON.stringify(pg.addedColumns));
    const found = await store.findByToken("RW-PG01-PG02-PG03");
    assert.ok(found && found.label === "同学A", "按卡号查不到：" + JSON.stringify(found));
    assert.equal(found.quota.calls, 20);
    assert.equal(found.quota.voice, 0, "老库里没有语音额度时应当按 0（不限制）读出来：" + JSON.stringify(found.quota));
    assert.deepEqual(found.daily, {}, "新卡的按天用量应当是空对象");
    // 记一次用量：同一张卡再存一次应当走 upsert 合并，而不是插出第二条。
    await store.save(Object.assign({}, found, { used: { calls: 1, tokens: 33, voice: 2, voiceChars: 40 } }));
    assert.equal(pg.ddl, expectedDdl, "不该重复建表/补列");
    assert.equal(pg.rows.size, 1, "同一张卡不该插成两行");
    const again = await store.get("card-9");
    assert.equal(again.used.calls, 1);
    assert.equal(again.used.tokens, 33);
    assert.equal(again.used.voice, 2, "语音次数没存进 PG：" + JSON.stringify(again.used));
    assert.equal(again.used.voiceChars, 40);
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
  // 兜底：某条用例失败时可能留下没关的监听句柄，于是"汇总打完了、进程却不退出"，
  // `npm test` 的 && 链就会**永远卡住**（2026-09-17 实测：一次瞬时 fetch failed
  // 让整轮回归挂死十几分钟，后面的套件一个都没跑）。这里给一个明确的收尾：
  // 5 秒还没自然退出就点名并强制退出。unref 保证它自己不会把进程吊住。
  const hangGuard = setTimeout(() => {
    console.error("relay-check：汇总之后仍有句柄没关掉，强制退出（请检查上面失败用例里的服务器是否 close）");
    process.exit(process.exitCode || 0);
  }, 5000);
  if (typeof hangGuard.unref === "function") hangGuard.unref();
}

main().catch((error) => {
  console.error("跑挂了：" + (error && error.stack || error));
  process.exitCode = 1;
});
