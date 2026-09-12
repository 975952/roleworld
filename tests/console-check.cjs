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
      assert.ok(card.shareText.indexOf(card.token + "@" + relayUrl) >= 0, "那段话里没有被粘贴的一整行");
      assert.ok(card.shareText.indexOf("只粘卡号是不够的") >= 0, "那段话里缺少「新设备要带中转地址」的提示");
      assert.ok(card.shareText.indexOf("http") >= 0, "那段话里没有一键链接");
      assert.ok(card.pasteLine.indexOf("@") > 0, "pasteLine 不对：" + card.pasteLine);

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

    await check("日志里没有卡号明文、也没有口令（和中转同一条硬规矩）", async () => {
      const all = logs.map((line) => JSON.stringify(line)).join("\n");
      assert.ok(!/RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/.test(all), "中转日志里出现了卡号明文");
      assert.ok(all.indexOf(ADMIN_SECRET) < 0, "中转日志里出现了发卡口令");
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
