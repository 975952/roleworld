"use strict";

/*
 * console-check.cjs —— 体验卡控制台（本机版）的回归（无需外网、无需云环境）
 *
 * 起一个真的 relay（内存账本）+ 真的控制台服务（随机端口、临时"卡号留底"文件），验证：
 *   列表 / 发卡 / 停用启用 / 吊销 / 那段话 / 本机留底 / 手工登记，
 * 以及**三道防线**（控制台 = 发卡权，这几条必须一直绿）：
 *   ① 只监听 127.0.0.1；Host 不是本机地址就拒；
 *   ② /api/* 都要带本次运行的钥匙头（?k= 是钥匙）；跨站预检 403；
 *   ③ 页面 HTML / 脚本 / 日志里**没有发卡口令**。
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const RELAY = path.join(ROOT, "relay");
const { createRelay } = require(path.join(RELAY, "server.js"));
const { createMemoryStore } = require(path.join(RELAY, "store.js"));
const { createAdminClient } = require(path.join(RELAY, "admin-client.js"));
const { createConsole } = require(path.join(ROOT, "scripts", "console.cjs"));

const ADMIN_SECRET = "admin-secret-123";
const RUN_KEY = "test-run-key";

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

function listen(server, port) {
  return new Promise((resolve) => server.listen(port || 0, "127.0.0.1", () => resolve(server.address().port)));
}

function startUpstream() {
  return http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "可用" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
  });
}

/** 带钥匙调控制台接口。 */
async function api(base, pathname, options) {
  const opts = options || {};
  const res = await fetch(base + pathname, {
    method: opts.method || "GET",
    headers: Object.assign({ "x-rw-console": opts.key === undefined ? RUN_KEY : opts.key }, opts.body ? { "Content-Type": "application/json" } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function main() {
  console.log("== 体验卡控制台（本机版）==");

  // 临时"卡号留底"文件：绝不碰用户真实的那份 relay/cards.local.jsonl。
  const recordFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rw-console-")), "cards.local.jsonl");

  const upstream = startUpstream();
  const upstreamPort = await listen(upstream);
  const store = createMemoryStore();
  const logs = [];
  const relay = createRelay({
    store,
    upstreamBase: "http://127.0.0.1:" + upstreamPort,
    upstreamKey: "sk-upstream-secret",
    adminSecret: ADMIN_SECRET,
    allowModels: ["deepseek-flash"],
    logSink: (line) => logs.push(line),
  });
  const relayPort = await listen(relay);
  const relayUrl = "http://127.0.0.1:" + relayPort;

  const consoleServer = createConsole({
    client: createAdminClient({ relayUrl, adminSecret: ADMIN_SECRET }),
    runToken: RUN_KEY,
    recordFile,
  });
  const consolePort = await listen(consoleServer);
  const base = "http://127.0.0.1:" + consolePort;

  // 直接往假中转发一张卡（模拟"以前发的卡"）。
  async function issueOnRelay(fields) {
    const res = await fetch(relayUrl + "/admin/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ADMIN_SECRET },
      body: JSON.stringify(fields),
    });
    return res.json();
  }

  try {
    await check("控制台只监听 127.0.0.1（不对外）", async () => {
      const address = consoleServer.address();
      assert.equal(address.address, "127.0.0.1", "绑到了 " + address.address);
    });

    await check("没有钥匙头一律 403；Host 不是本机地址也拒；跨站预检 403", async () => {
      assert.equal((await fetch(base + "/api/cards")).status, 403, "没带钥匙却放行");
      assert.equal((await api(base, "/api/cards", { key: "wrong" })).status, 403, "错钥匙却放行");
      assert.equal((await fetch(base + "/api/cards", { method: "OPTIONS" })).status, 403, "预检不该放行");
      // Host 头 fetch 不让改（forbidden header），得用 node:http 真发一次 ——
      // 这条挡的是 DNS rebinding：公网域名解析到 127.0.0.1 时 Host 会是那个域名。
      const rebound = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1", port: consolePort, path: "/api/state", method: "GET",
          headers: { "x-rw-console": RUN_KEY, Host: "evil.example.com" },
        }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on("error", reject);
        req.end();
      });
      assert.equal(rebound, 403, "Host 不是本机地址却放行");
    });

    await check("页面与脚本里没有发卡口令", async () => {
      const page = await (await fetch(base + "/")).text();
      const script = await (await fetch(base + "/console.js")).text();
      const css = await (await fetch(base + "/console.css")).text();
      for (const [name, text] of [["HTML", page], ["脚本", script], ["样式", css]]) {
        assert.ok(text.indexOf(ADMIN_SECRET) < 0, name + "里出现了口令");
      }
      assert.ok(script.indexOf("?k=") >= 0, "脚本应当从地址栏取钥匙");
      assert.ok(page.indexOf("体验卡控制台") >= 0, "首页没渲染出来：" + page.slice(0, 80));
    });

    await check("状态：中转地址 / 口令是否读到 / 留底文件路径", async () => {
      const state = await api(base, "/api/state");
      assert.equal(state.status, 200, JSON.stringify(state.body));
      assert.equal(state.body.relayUrl, relayUrl);
      assert.equal(state.body.hasSecret, true);
      assert.equal(state.body.recordFile, recordFile);
      assert.ok(state.body.health && state.body.health.ok === true, "健康检查没通：" + JSON.stringify(state.body.health));
    });

    await check("卡列表：用量 / 上限 / 到期都回来了，没留底的卡不给卡号", async () => {
      const created = await issueOnRelay({ label: "同学A", calls: 50, days: 14 });
      const list = await api(base, "/api/cards");
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const row = (list.body.cards || []).find((card) => card.id === created.id);
      assert.ok(row, "列表里没有刚发的卡");
      assert.equal(row.quota.calls, 50);
      assert.equal(row.used.calls, 0);
      assert.equal(row.token, null, "没留底的卡不该凭空有卡号");
    });

    await check("发卡：一次发两张、返回可转发的那段话（含 卡号@中转地址），并写进本机留底", async () => {
      const issued = await api(base, "/api/issue", { method: "POST", body: { label: "同学B", calls: 50, days: 14, count: 2 } });
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      assert.equal(issued.body.cards.length, 2, "张数不对");
      const card = issued.body.cards[0];
      assert.ok(/^RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(card.token), "卡号格式不对：" + card.token);
      // 2026-09-16：交付文案改过一轮 —— **不再给一键链接**（那条链接会先撞腾讯云的
      // 「测试域名风险提醒」页，同学点过去片段容易丢）。现在只给：卡号 + 中转地址 +
      // 应用里怎么填的三步说明。这几条断言就照新的交付文案钉。
      assert.ok(card.shareText.indexOf("卡号：" + card.token) >= 0, "那段话里没有卡号：" + card.shareText.slice(0, 200));
      assert.ok(card.shareText.indexOf(relayUrl) >= 0, "那段话里没有中转地址");
      assert.ok(card.shareText.indexOf("中转地址") >= 0, "那段话里没写「中转地址」这一栏要填什么");
      assert.ok(card.shareText.indexOf("1.") >= 0, "那段话里没有「第一次打开时照着做」的步骤");
      assert.ok(card.pasteLine === card.token + "@" + relayUrl, "pasteLine 不是可粘贴的那一整行：" + card.pasteLine);
      assert.ok(card.shareText.indexOf(card.pasteLine) >= 0, "那段话里没有被粘贴的一整行");

      // 留底文件里应当有这两张卡的卡号（服务端只有哈希，只能靠这份）。
      const written = fs.readFileSync(recordFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(written.filter((row) => row.token === card.token).length, 1, "留底里没有这张卡");
      assert.ok(!fs.readFileSync(recordFile, "utf8").includes(ADMIN_SECRET), "留底里混进了口令");
    });

    await check("列表里留过底的卡带出卡号，界面才能「复制那段话」", async () => {
      const list = await api(base, "/api/cards");
      const withToken = (list.body.cards || []).filter((card) => card.token);
      assert.ok(withToken.length >= 2, "留过底的卡没有带出卡号：" + withToken.length);
    });

    await check("「复制那段话」：按卡号现生成，含真卡号 + 中转地址", async () => {
      const list = await api(base, "/api/cards");
      const card = (list.body.cards || []).find((row) => row.token);
      const text = await api(base, "/api/text", { method: "POST", body: { token: card.token } });
      assert.equal(text.status, 200, JSON.stringify(text.body));
      assert.ok(text.body.shareText.indexOf(card.token) >= 0, "那段话里没有这张卡");
      assert.ok(text.body.shareText.indexOf(relayUrl) >= 0, "那段话里没有中转地址");
    });

    await check("停用 / 启用 / 吊销都真的作用到中转", async () => {
      const created = await issueOnRelay({ label: "同学C", calls: 10, days: 7 });

      const off = await api(base, "/api/card/" + created.id + "/disable", { method: "POST" });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(off.body.disabled, true);
      const afterOff = await fetch(relayUrl + "/card/quota", { headers: { Authorization: "Bearer " + created.token } }).then((res) => res.json());
      assert.equal(afterOff.ok, false, "停用之后还查得到可用额度");
      assert.ok(/停用/.test(afterOff.reason || ""), "停用后的原因不对：" + afterOff.reason);

      const on = await api(base, "/api/card/" + created.id + "/enable", { method: "POST" });
      assert.equal(on.body.disabled, false);

      const killed = await api(base, "/api/card/" + created.id + "/revoke", { method: "POST" });
      assert.equal(killed.status, 200, JSON.stringify(killed.body));
      assert.equal(killed.body.removed, true);
      // 吊销之后查额度会 401（卡不认识），响应是错误形状而不是额度形状 —— 两种都算"用不了"。
      const afterKill = await fetch(relayUrl + "/card/quota", { headers: { Authorization: "Bearer " + created.token } }).then((res) => res.json());
      assert.ok(afterKill.ok !== true, "吊销之后还能用：" + JSON.stringify(afterKill));
      const reason = String(afterKill.reason || (afterKill.error && afterKill.error.message) || "");
      assert.ok(/不认识/.test(reason), "吊销后的原因不对：" + reason);
    });

    await check("手工登记旧卡号：格式不对拒绝、格式对就进留底", async () => {
      const bad = await api(base, "/api/remember", { method: "POST", body: { token: "我随手写的一句" } });
      assert.equal(bad.status, 400, "乱写的也登记了");

      const created = await issueOnRelay({ label: "同学E", calls: 5, days: 3 });
      const ok = await api(base, "/api/remember", { method: "POST", body: { token: created.token, label: "以前的卡" } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const rows = await api(base, "/api/record");
      assert.ok(rows.body.rows.some((row) => row.token === created.token), "登记之后留底里没有它");
    });

    await check("自检接口：账本 / 上游都通", async () => {
      const storeTest = await api(base, "/api/selftest/store");
      assert.equal(storeTest.status, 200, JSON.stringify(storeTest.body));
      assert.equal(storeTest.body.ok, true, "账本自检没过：" + JSON.stringify(storeTest.body));
      const upstreamTest = await api(base, "/api/selftest/upstream");
      assert.equal(upstreamTest.status, 200, JSON.stringify(upstreamTest.body));
      assert.equal(upstreamTest.body.ok, true, "上游自检没过：" + JSON.stringify(upstreamTest.body));
    });

    await check("加次数 / 续期 + 按天用量（2026-09-12 新增）", async () => {
      const created = await fetch(relayUrl + "/admin/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + ADMIN_SECRET },
        body: JSON.stringify({ label: "同学F", calls: 5, days: 3 }),
      }).then((res) => res.json());
      const extended = await api(base, "/api/card/" + created.id + "/extend", { method: "POST", body: { calls: 80, days: 30 } });
      assert.equal(extended.status, 200, JSON.stringify(extended.body));
      assert.equal(extended.body.card.quota.calls, 80, "上限没改上：" + JSON.stringify(extended.body.card));
      const quota = await fetch(relayUrl + "/card/quota", { headers: { Authorization: "Bearer " + created.token } }).then((res) => res.json());
      assert.equal(quota.callsLeft, 80, "改完之后剩余次数不对");
      // 什么都不给应当明确拒绝，而不是"假装成功"。
      const empty = await api(base, "/api/card/" + created.id + "/extend", { method: "POST", body: {} });
      assert.equal(empty.status, 400, "什么都没给却当成功了");
      // 按天用量：跑一轮之后今天应当有 1 次。
      await fetch(relayUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + created.token },
        body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "在吗" }] }),
      }).then((res) => res.text());
      const usage = await api(base, "/api/usage?days=7");
      assert.equal(usage.status, 200, JSON.stringify(usage.body));
      assert.equal(usage.body.days.length, 7, "应当返回 7 天");
      const today = new Date().toISOString().slice(0, 10);
      assert.equal(usage.body.days[6].day, today, "最后一行应当是今天");
      assert(usage.body.days[6].calls >= 1, "今天的用量没算上：" + JSON.stringify(usage.body.days[6]));
    });

    await check("日志里没有卡号明文、也没有口令（和中转同一条硬规矩）", async () => {
      const all = logs.map((line) => JSON.stringify(line)).join("\n");
      assert.ok(!/RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/.test(all), "中转日志里出现了卡号明文");
      assert.ok(all.indexOf(ADMIN_SECRET) < 0, "中转日志里出现了发卡口令");
    });

    /* ------------------------------------------------------------------ *
     * 2026-09-14：把控制台做成"顺手的体验卡管理工具"之后新增的用例。
     * 覆盖用户点名的五条工作流：发卡（含语音额度）→ 查找 → 看用量 → 续期 → 停用 → 恢复。
     * ------------------------------------------------------------------ */

    await check("发卡能一次写全五份额度（聊天次数 / token / 语音次数 / 语音字数 / 天数）", async () => {
      const issued = await api(base, "/api/issue", {
        method: "POST",
        body: { label: "同学G", calls: 30, tokens: 500000, voice: 20, voiceChars: 3000, days: 30, count: 1 },
      });
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      const card = issued.body.cards[0];
      assert.equal(card.quota.calls, 30, "聊天次数没写上：" + JSON.stringify(card.quota));
      assert.equal(card.quota.tokens, 500000, "token 上限没写上");
      assert.equal(card.quota.voice, 20, "语音次数没写上 —— 语音是独立的一份额度");
      assert.equal(card.quota.voiceChars, 3000, "语音字数没写上");
      // 交付文案要把语音的两份额度分开写清楚（不然同学以为语音吃聊天的次数）。
      assert.ok(card.shareText.indexOf("30 次聊天") >= 0, "那段话里没写聊天次数：" + card.shareText.slice(0, 200));
      assert.ok(card.shareText.indexOf("20 次语音") >= 0, "那段话里没写语音次数");
      assert.ok(card.shareText.indexOf("3000 字语音") >= 0, "那段话里没写语音字数");
      // 「不限制」= 0，交付文案应当说"不限"。
      const unlimited = await api(base, "/api/issue", { method: "POST", body: { label: "同学H", calls: 0, days: 0, count: 1 } });
      assert.equal(unlimited.body.cards[0].quota.calls, 0, "「不限制」应当是 0（服务端语义）");
      assert.ok(unlimited.body.cards[0].shareText.indexOf("额度：不限") >= 0, "不限额度时那段话没说清：" + unlimited.body.cards[0].shareText.slice(0, 160));
    });

    await check("防重复提交：同一个 requestId 连发两次只会真的发一次卡", async () => {
      const before = (await api(base, "/api/cards")).body.cards.length;
      const requestId = "test-idem-1";
      const first = await api(base, "/api/issue", { method: "POST", body: { label: "同学I", calls: 10, days: 7, count: 2, requestId: requestId } });
      const second = await api(base, "/api/issue", { method: "POST", body: { label: "同学I", calls: 10, days: 7, count: 2, requestId: requestId } });
      assert.equal(first.body.cards.length, 2, "第一次应当发 2 张");
      assert.equal(second.body.cards.length, 2, "重放应当把上次的结果还回来");
      assert.equal(second.body.replayed, true, "重放没有标出来（界面就不知道这次没真发）");
      assert.deepEqual(second.body.cards.map((c) => c.token), first.body.cards.map((c) => c.token), "重放回来的卡号应当和上次一样");
      const after = (await api(base, "/api/cards")).body.cards.length;
      assert.equal(after, before + 2, "重复提交真的多发卡了：账本从 " + before + " 变成 " + after);
      // 不同的 requestId 必须照常发（不能把"防重复"做成"只能发一次"）。
      const third = await api(base, "/api/issue", { method: "POST", body: { label: "同学I", calls: 10, days: 7, count: 1, requestId: "test-idem-2" } });
      assert.equal(third.body.replayed, undefined, "换了 requestId 却当成重放");
      assert.equal(third.body.cards.length, 1, "换了 requestId 应当正常发卡");
    });

    await check("部分失败保留已成功的结果，并给出「只补失败那几张」的口径", async () => {
      // 直接打桩：让第 2 张创建失败（模拟中转抖了一下 / 一张卡写不进去）。
      const inner = consoleServer.console.client.createCard;
      let calls = 0;
      consoleServer.console.client.createCard = async (fields) => {
        calls += 1;
        if (calls === 2) throw new Error("模拟：中转这一张没写进去");
        return inner(fields);
      };
      try {
        const data = await api(base, "/api/issue", { method: "POST", body: { label: "同学J", calls: 5, days: 3, count: 3, requestId: "test-partial-1" } });
        assert.equal(data.status, 200, JSON.stringify(data.body));
        assert.equal(data.body.cards.length, 2, "成功的那两张必须留住（它们真的发出去了）");
        assert.equal(data.body.failures.length, 1, "失败的张数不对：" + JSON.stringify(data.body.failures));
        assert.equal(data.body.ok, false, "有失败却报 ok");
        assert.ok(data.body.retryHint.indexOf("只补这几张") >= 0, "没给出「只补失败那几张」的口径：" + data.body.retryHint);
        // 成功的两张必须在账本里查得到（不是只在响应里）。
        const list = (await api(base, "/api/cards")).body.cards;
        for (const card of data.body.cards) {
          assert.ok(list.some((row) => row.id === card.id), "成功的卡没进账本：" + card.id);
        }
      } finally {
        consoleServer.console.client.createCard = inner;
      }
    });

    await check("卡详情：单独的接口给出这张卡的最近用量，且不泄漏别人的卡", async () => {
      const created = await issueOnRelay({ label: "同学K", calls: 12, voice: 4, voiceChars: 800, days: 9 });
      // 先真的用一次（聊天），这样按天用量里有东西。
      await fetch(relayUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + created.token },
        body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "在吗" }] }),
      }).then((res) => res.text());
      const detail = await api(base, "/api/card/" + created.id);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.card.id, created.id);
      assert.ok(Array.isArray(detail.body.daily), "缺按天用量");
      const today = new Date().toISOString().slice(0, 10);
      const row = detail.body.daily.find((one) => one.day === today);
      assert.ok(row && row.calls >= 1, "今天的用量没回来：" + JSON.stringify(detail.body.daily));
      // 不存在的卡要 404（不是 500，也不是空对象）。
      const missing = await api(base, "/api/card/nope-nope");
      assert.equal(missing.status, 404, "不存在的卡应当 404：" + missing.status);
    });

    await check("聊天与语音**各判各的**：聊天额度用完，独立的语音额度不该跟着被判死", async () => {
      const created = await issueOnRelay({ label: "同学L", calls: 1, voice: 5, voiceChars: 500, days: 7 });
      // 把聊天的那一次用掉。
      await fetch(relayUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + created.token },
        body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "你好" }] }),
      }).then((res) => res.text());
      const quota = await fetch(relayUrl + "/card/quota", { headers: { Authorization: "Bearer " + created.token } }).then((res) => res.json());
      assert.equal(quota.callsLeft, 0, "聊天次数应当用完了：" + JSON.stringify(quota));
      assert.equal(quota.voiceLeft, 5, "语音次数**不该**被聊天额度带着一起扣：" + JSON.stringify(quota));
      assert.equal(quota.voiceCharsLeft, 500, "语音字数不该被聊天额度带着一起扣：" + JSON.stringify(quota));
    });

    await check("续期能同时改四份额度（聊天 / token / 语音 / 语音字数）", async () => {
      const created = await issueOnRelay({ label: "同学M", calls: 5, voice: 1, voiceChars: 100, days: 3 });
      const extended = await api(base, "/api/card/" + created.id + "/extend", {
        method: "POST",
        body: { calls: 60, tokens: 200000, voice: 30, voiceChars: 4000, days: 20, label: "同学M（续）" },
      });
      assert.equal(extended.status, 200, JSON.stringify(extended.body));
      const quota = extended.body.card.quota;
      assert.equal(quota.calls, 60);
      assert.equal(quota.tokens, 200000);
      assert.equal(quota.voice, 30, "语音次数没改上");
      assert.equal(quota.voiceChars, 4000, "语音字数没改上");
      assert.equal(extended.body.card.label, "同学M（续）", "标签没改上");
      // 服务端看到的是同一份（不是只在响应里）。
      const list = (await api(base, "/api/cards")).body.cards;
      const row = list.find((one) => one.id === created.id);
      assert.equal(row.quota.voiceChars, 4000, "账本里的语音字数没改上");
    });

    await check("发卡 → 查找 → 看用量 → 续期 → 停用 → 恢复（一条完整流程走通）", async () => {
      const issued = await api(base, "/api/issue", { method: "POST", body: { label: "流程同学", calls: 2, voice: 2, voiceChars: 200, days: 5, count: 1, requestId: "test-flow-1" } });
      const token = issued.body.cards[0].token;
      const id = issued.body.cards[0].id;
      // 查找（控制台列表里的筛选是前端做的，这里验的是"列表里有它、且带得回卡号"）
      const listed = (await api(base, "/api/cards")).body.cards.find((one) => one.id === id);
      assert.ok(listed, "发出去的卡在列表里找不到");
      assert.equal(listed.token, token, "留过底的卡应当带得出卡号（否则复制不了交付文案）");
      // 看用量
      const detail = await api(base, "/api/card/" + id);
      assert.equal(detail.body.card.used.calls, 0, "新卡的用量应当是 0");
      // 续期
      const extended = await api(base, "/api/card/" + id + "/extend", { method: "POST", body: { calls: 9, days: 10 } });
      assert.equal(extended.body.card.quota.calls, 9);
      // 停用 → 拿卡去查额度应当被拒
      await api(base, "/api/card/" + id + "/disable", { method: "POST" });
      const off = await fetch(relayUrl + "/card/quota", { headers: { Authorization: "Bearer " + token } }).then((res) => res.json());
      assert.equal(off.ok, false, "停用之后还能用");
      // 恢复 → 又能用了
      await api(base, "/api/card/" + id + "/enable", { method: "POST" });
      const on = await fetch(relayUrl + "/card/quota", { headers: { Authorization: "Bearer " + token } }).then((res) => res.json());
      assert.equal(on.ok, true, "恢复之后还是不能用：" + JSON.stringify(on));
      assert.equal(on.callsLeft, 9, "续期之后的剩余次数不对：" + JSON.stringify(on));
    });

    await check("语音配置只读自检：只报配没配，不做任何合成（不花钱）", async () => {
      const before = logs.length;
      const voiceInfo = await api(base, "/api/selftest/voice");
      assert.equal(voiceInfo.status, 200, JSON.stringify(voiceInfo.body));
      assert.equal(typeof voiceInfo.body.configured, "boolean", "没报「配没配」：" + JSON.stringify(voiceInfo.body).slice(0, 200));
      // 没有配火山凭据时应当如实说 configured=false，而不是假装成功。
      assert.equal(voiceInfo.body.configured, false, "假中转没配语音凭据，不该报成已配");
      // 这条自检不该往语音上游发任何请求 —— 用"日志没有新增语音记录"来钉。
      const added = logs.slice(before).filter((line) => JSON.stringify(line).indexOf("voice") >= 0);
      assert.equal(added.length, 0, "只读自检竟然发了语音请求：" + JSON.stringify(added));
    });
  } finally {
    consoleServer.close();
    relay.close();
    upstream.close();
  }

  console.log("");
  console.log("CONSOLE_CHECK=" + passed + "/" + (passed + failed));
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("控制台套件本身挂了：" + ((error && error.stack) || error));
  process.exitCode = 1;
});
