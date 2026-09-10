"use strict";

/*
 * adapter-unit.cjs —— 本地适配层的无浏览器单元测试。
 *
 * 覆盖：数据层增删改查与存档往返、OpenAI 请求体翻译、SSE 流式解析、ZIP 读写。
 * 全部使用合成数据，不联网、不接触真实模型。
 */

const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..", "app", "adapter");
const Store = require(path.join(ROOT, "store.js"));
const Model = require(path.join(ROOT, "model.js"));
const Zip = require(path.join(ROOT, "zip.js"));
const Cards = require(path.join(ROOT, "cards.js"));
const AccountCore = require(path.join(__dirname, "..", "app", "account-core.js"));

// 让 index.js 能在 Node 里跑起来：它启动时会去读这几个全局。
globalThis.RoleWorldStore = Store;
globalThis.RoleWorldModel = Model;
globalThis.RoleWorldZip = Zip;
globalThis.RoleWorldCards = Cards;
if (typeof globalThis.URL.createObjectURL !== "function") {
  globalThis.URL.createObjectURL = () => "blob:test";
  globalThis.URL.revokeObjectURL = () => {};
}
require(path.join(ROOT, "index.js"));
const Adapter = globalThis.RoleWorld;

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error });
    console.log("  FAIL  " + name + "\n        " + (error && error.message ? error.message : String(error)));
  }
}

function card(avatar, name) {
  return {
    avatar,
    name,
    description: name + " 的描述",
    first_mes: "你好，我是" + name + "。",
    data: { system_prompt: "", character_book: null, tags: ["测试"] },
  };
}

async function main() {
  console.log("== 数据层 ==");

  await test("内存后端：角色卡写入 / 读取 / 列表 / 删除", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("b.png", "乙"));
    await Store.putCharacter(card("a.png", "甲"));
    assert.equal((await Store.listCharacters()).length, 2);
    assert.deepEqual((await Store.listCharacters()).map((row) => row.name), ["甲", "乙"]);
    const one = await Store.getCharacter("a.png");
    assert.equal(one.name, "甲");
    assert.equal(one.data.tags[0], "测试");
    await Store.deleteCharacter("a.png", true);
    assert.equal((await Store.listCharacters()).length, 1);
    assert.equal(await Store.getCharacter("a.png"), null);
  });

  await test("聊天：保存 / 列出 / 读取 / 删除", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("harry.png", "Harry"));
    const messages = [
      { name: "Harry", is_user: false, is_system: false, mes: "嗨", send_date: "2026-09-10T10:00:00.000Z" },
      { name: "我", is_user: true, is_system: false, mes: "你好", send_date: "2026-09-10T10:00:05.000Z" },
    ];
    await Store.saveChat("harry.png", "chat_001", messages);
    const list = await Store.listChats("harry.png");
    assert.equal(list.length, 1);
    assert.equal(list[0].file_name, "chat_001");
    assert.equal(list[0].chat_items, 2);
    assert.equal(list[0].mes, "嗨");
    const back = await Store.getChat("harry.png", "chat_001");
    assert.equal(back.length, 2);
    assert.equal(back[1].is_user, true);
    await Store.deleteChat("harry.png", "chat_001");
    assert.equal((await Store.listChats("harry.png")).length, 0);
  });

  await test("删除角色可连带删除其聊天", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("x.png", "X"));
    await Store.saveChat("x.png", "chat_a", [{ mes: "a" }]);
    await Store.saveChat("x.png", "chat_b", [{ mes: "b" }]);
    await Store.deleteCharacter("x.png", true);
    assert.equal((await Store.listChats("x.png")).length, 0);
  });

  await test("世界书：写 / 读 / 列 / 删", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putWorld("记忆书", { entries: { "0": { uid: 0, key: ["哈利"], content: "魔法" } } });
    const worlds = await Store.listWorlds();
    assert.equal(worlds.length, 1);
    assert.equal(worlds[0].file_id, "记忆书");
    const world = await Store.getWorld("记忆书");
    assert.equal(world.entries["0"].content, "魔法");
    await Store.deleteWorld("记忆书");
    assert.equal((await Store.listWorlds()).length, 0);
  });

  await test("键值对与二进制：可存可取可删", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    assert.equal(await Store.getKV("missing", "默认"), "默认");
    await Store.setKV("settings", { model: "deepseek-flash" });
    assert.equal((await Store.getKV("settings")).model, "deepseek-flash");
    await Store.deleteKV("settings");
    assert.equal(await Store.getKV("settings", null), null);
    await Store.putBlob(Store.avatarBlobId("a.png"), new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    const blob = await Store.getBlob(Store.avatarBlobId("a.png"));
    assert.equal(blob.size, 3);
  });

  await test("存档导出 / 导入往返（replace 与 merge）", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("a.png", "甲"));
    await Store.saveChat("a.png", "chat_1", [{ mes: "hi" }]);
    await Store.putWorld("w", { entries: {} });
    await Store.setKV("settings", { provider: "deepseek" });
    const dump = await Store.exportAll();
    assert.equal(dump.format, "roleworld-archive");

    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    const counts = await Store.importAll(dump, { mode: "replace" });
    assert.equal(counts.characters, 1);
    assert.equal(counts.chats, 1);
    assert.equal((await Store.getCharacter("a.png")).name, "甲");
    assert.equal((await Store.getChat("a.png", "chat_1")).length, 1);
    assert.equal((await Store.getKV("settings")).provider, "deepseek");
  });

  await test("导入非法存档会明确报错", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await assert.rejects(() => Store.importAll({ format: "sillytavern" }, {}), /不是有效的角色世界存档/);
  });

  console.log("== 模型请求 ==");

  await test("ST 载荷翻译成 OpenAI 请求体", () => {
    const body = Model.buildBody({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "你好" }],
      stream: true,
      temperature: 0.9,
      top_p: 0.95,
      max_tokens: 32768,
      chat_completion_source: "deepseek",
      custom_url: "https://example.com/v1/chat/completions",
    });
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.9);
    assert.equal(body.max_tokens, 32768);
    assert.deepEqual(body.messages, [{ role: "user", content: "你好" }]);
    assert.equal(body.chat_completion_source, undefined);
    assert.equal(body.custom_url, undefined);
  });

  await test("采样参数缺失时用默认值，stream 默认关闭", () => {
    const body = Model.buildBody({ messages: [] });
    assert.equal(body.stream, false);
    assert.equal(body.model, Model.DEFAULT_SETTINGS.model);
    assert.equal(body.temperature, Model.DEFAULT_SETTINGS.temperature);
  });

  await test("请求头：DeepSeek 用 Bearer，未配置 Key 时不带 Authorization", () => {
    assert.equal(Model.buildHeaders({ provider: "deepseek" }, "sk-test").Authorization, "Bearer sk-test");
    assert.equal(Model.buildHeaders({ provider: "deepseek" }, "").Authorization, undefined);
  });

  await test("端点解析：默认用预设、设置里可覆盖", () => {
    assert.equal(Model.endpointFor({ provider: "deepseek" }), "https://api.deepseek.com/chat/completions");
    assert.equal(Model.endpointFor({ provider: "custom", endpoint: "http://127.0.0.1:8080/v1/chat/completions" }),
      "http://127.0.0.1:8080/v1/chat/completions");
  });

  await test("SSE 分块解析", () => {
    assert.deepEqual(Model.parseSseBlock('data: {"a":1}'), ['{"a":1}']);
    assert.deepEqual(Model.parseSseBlock("data: [DONE]"), ["[DONE]"]);
    assert.deepEqual(Model.parseSseBlock(": 心跳\n\n"), []);
  });

  await test("流式生成：逐段回调并累积内容", async () => {
    const originalFetch = globalThis.fetch;
    const sse = [
      'data: {"model":"m1","choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(init.headers.Authorization, "Bearer sk-x");
      const sent = JSON.parse(init.body);
      assert.equal(sent.stream, true);
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    try {
      const deltas = [];
      const out = await Model.streamComplete(
        { messages: [{ role: "user", content: "hi" }], settings: { provider: "deepseek", model: "m1" } },
        { apiKey: "sk-x", onDelta: (text) => deltas.push(text) }
      );
      assert.equal(out.content, "你好");
      assert.equal(out.reasoning, "想想");
      assert.deepEqual(deltas.filter(Boolean), ["你", "好"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("非流式生成：解析 choices[0].message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ model: "m1", choices: [{ message: { content: "答案" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    try {
      const out = await Model.complete({ messages: [], settings: { provider: "deepseek" } }, { apiKey: "sk-x" });
      assert.equal(out.content, "答案");
      assert.equal(out.model, "m1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("接口报错时抛出带状态码的可读错误", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "Invalid API key" } }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
    try {
      await assert.rejects(
        () => Model.complete({ messages: [], settings: { provider: "deepseek" } }, { apiKey: "bad" }),
        (error) => error.status === 401 && /Invalid API key/.test(error.message)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("服务端忽略 stream 参数时退回一次性读取", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ model: "m", choices: [{ message: { content: "整段" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    try {
      const deltas = [];
      const out = await Model.streamComplete(
        { messages: [], settings: { provider: "deepseek" } },
        { apiKey: "k", onDelta: (text) => deltas.push(text) }
      );
      assert.equal(out.content, "整段");
      assert.deepEqual(deltas.filter(Boolean), ["整段"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log("== 适配层门面 ==");

  await test("已知端点自动匹配服务商（AI 写角色失败的根因）", () => {
    assert.equal(Model.providerForEndpoint("https://api.deepseek.com/chat/completions"), "deepseek");
    assert.equal(Model.providerForEndpoint("https://api.deepseek.com/chat/completions/"), "deepseek");
    assert.equal(Model.providerForEndpoint("HTTP://127.0.0.1:8080/v1/chat/completions"), "custom");
    assert.equal(Model.providerForEndpoint("https://my-proxy.example/v1/chat/completions"), "");
    assert.equal(Model.providerForEndpoint(""), "");
  });

  await test("写角色走 custom 路径时带的是 DeepSeek 的 Key", async () => {
    // 页面在「本地模型」路径上会发 chat_completion_source:"custom" + custom_url，
    // 如果只按 custom 取密钥就会拿到空串 → 请求 401 → "角色生成失败"。
    await Adapter.secrets.set("api_key_deepseek", "sk-deepseek-test");
    await Adapter.saveLocalSettings({
      provider: "deepseek", endpoint: "", model: "deepseek-flash",
    });
    const originalFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, init) => {
      seen = { url, auth: init.headers.Authorization, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      await Adapter.STApi.generate({
        messages: [{ role: "user", content: "写一个角色" }],
        model: "local",
        chat_completion_source: "custom",
        custom_url: "https://api.deepseek.com/chat/completions",
        stream: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(seen.url, "https://api.deepseek.com/chat/completions");
    assert.equal(seen.auth, "Bearer sk-deepseek-test", "Key 取错了：拿到了 " + JSON.stringify(seen.auth));
    assert.equal(seen.body.model, "deepseek-flash", "model 应换成用户配置的模型名");
  });

  await test("思考模式开关会原样传进请求体", () => {
    const off = Model.buildBody({ messages: [], include_reasoning: false });
    assert.equal(off.include_reasoning, false, "关闭思考时必须显式发 false，否则接口照旧回思维链");
    const on = Model.buildBody({ messages: [], include_reasoning: true, reasoning_effort: "high" });
    assert.equal(on.include_reasoning, true);
    assert.equal(on.reasoning_effort, "high");
    const absent = Model.buildBody({ messages: [] });
    assert.equal("include_reasoning" in absent, false);
  });

  console.log("== 仓库卫生 ==");

  await test("仓库文本文件不带 UTF-8 BOM", () => {
    // Rust 的 serde_json 不接受 BOM，带上去整个桌面端打包会秒挂。
    // （真发生过：用 PowerShell 的 Set-Content -Encoding UTF8 改版本号。）
    const skip = new Set([".git", "node_modules", "target", "gen", "packs"]);
    const exts = [".json", ".js", ".cjs", ".html", ".css", ".yml", ".yaml", ".toml", ".rs", ".md"];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
          continue;
        }
        if (!exts.includes(path.extname(entry.name).toLowerCase())) continue;
        const file = path.join(dir, entry.name);
        const head = Buffer.alloc(3);
        const handle = fs.openSync(file, "r");
        try {
          fs.readSync(handle, head, 0, 3, 0);
        } finally {
          fs.closeSync(handle);
        }
        if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
          offenders.push(path.relative(path.join(__dirname, ".."), file));
        }
      }
    };
    walk(path.join(__dirname, ".."));
    assert.deepEqual(offenders, [], "这些文件带 BOM：" + offenders.join(", "));
  });

  console.log("== 角色草稿解析 ==");

  const CharCore = require(path.join(__dirname, "..", "app", "task29-character-core.js"));
  const Core22 = require(path.join(__dirname, "..", "app", "task22-core.js"));

  await test("模型在 JSON 前后加话、加多余字段，也能解析出来", () => {
    // 之前的实现只接受"整段就是一个 JSON"，模型多写一句解释、或多给一个字段就整张卡判死，
    // 用户看到的就是「草稿解析失败」。
    const raw = [
      "好的，这是根据描述生成的角色卡：",
      "```json",
      JSON.stringify({
        name: "测试角色",
        description: "一个用于测试的角色，描述足够长。",
        summary: "模型自作主张加的字段",
        greeting: "你好呀",
        tags: ["测试"],
        language: "zh",
      }),
      "```",
      "希望符合你的预期。",
    ].join("\n");
    const draft = CharCore.parseDraft(raw);
    assert.equal(draft.name, "测试角色");
    assert.equal(draft.description, "一个用于测试的角色，描述足够长。");
    assert.equal(draft.summary, undefined, "多余字段应当被忽略而不是保留");
    assert.deepEqual(draft.tags, ["测试"]);
  });

  await test("没有围栏、前后有解释文字也能解析", () => {
    const raw = '这是结果：{"name":"甲","description":"描述描述描述描述"} 完毕。';
    assert.equal(CharCore.parseDraft(raw).name, "甲");
  });

  await test("危险键仍然拒绝", () => {
    assert.throws(() => CharCore.parseDraft('{"name":"x","__proto__":{"polluted":1}}'),
      (error) => error.code === "DRAFT_DANGEROUS_KEY");
  });

  await test("真的不是 JSON 时给出带长度的可读错误", () => {
    assert.throws(() => CharCore.parseDraft("抱歉，我无法完成这个请求。"),
      (error) => error.code === "DRAFT_PARSE_ERROR" && /模型返回 \d+ 字/.test(error.message));
  });

  await test("截断的 JSON 会报解析错误而不是静默返回空卡", () => {
    assert.throws(() => CharCore.parseDraft('{"name":"甲","description":"被截断的描'),
      (error) => error.code === "DRAFT_PARSE_ERROR");
  });

  await test("写卡请求关掉了思考并放宽了输出上限", () => {
    const payload = CharCore.buildDraftGeneratePayload({
      description: "这是一个足够长的角色描述，用来通过最短长度校验。",
      language: "zh",
      settings: { oai_settings: { custom_url: "https://api.deepseek.com/chat/completions" } },
    });
    assert.equal(payload.stream, false);
    assert.equal(payload.include_reasoning, false, "思考会把输出额度吃光，正文就没了");
    assert.ok(payload.max_tokens >= 4096, "1024 太紧，整张卡会被截断");
  });

  console.log("== 角色记忆归属与自动记忆 ==");

  await test("记忆书按角色短名归属：Harry 的老书仍归 Harry，新角色各归各的", () => {
    const harry = { avatar: "Harry Potter (EN).png", charName: "Harry Potter (EN)" };
    const hermione = { avatar: "Hermione Granger (Triwizard Year).png", charName: "Hermione Granger" };
    const books = [
      { name: "MB Harry — fact clips (EN)" },
      { name: "MB Harry — scene memories (EN)" },
      { name: "MB Hermione — 自动记忆" },
      { name: "Eldoria" },
    ];
    assert.deepEqual(CharCore.memoryBooksFor(harry, books).map((b) => b.name),
      ["MB Harry — fact clips (EN)", "MB Harry — scene memories (EN)"]);
    assert.deepEqual(CharCore.memoryBooksFor(hermione, books).map((b) => b.name),
      ["MB Hermione — 自动记忆"]);
    // 不匹配的书谁都不给
    assert.equal(CharCore.memoryBooksFor(harry, [{ name: "Eldoria" }]).length, 0);
  });

  await test("没有记忆书的角色拿到空数组，而不是别人的书", () => {
    const ron = { avatar: "Ron Weasley (Triwizard Year).png", charName: "Ron Weasley (Triwizard Year)" };
    const books = [{ name: "MB Harry — fact clips (EN)" }];
    assert.deepEqual(CharCore.memoryBooksFor(ron, books), []);
  });

  await test("新建记忆书用当前角色的短名，不再永远叫 Harry", () => {
    assert.equal(CharCore.newMemoryBookName({ charName: "Hermione Granger" }, "自动记忆"),
      "MB Hermione — 自动记忆");
    assert.equal(CharCore.newMemoryBookName({ charName: "Harry Potter (EN)" }, "自动记忆"),
      "MB Harry — 自动记忆");
    assert.equal(CharCore.newMemoryBookName({ charName: "Tom Riddle (Adult)" }, "关系"),
      "MB Tom — 关系");
  });

  await test("记忆标记能从回复里剥出来，正文不留痕", () => {
    const reply = "“我记得的。”\n[[记住: 玩家叫小林]]\n[[记住: 他怕黑]]";
    const parsed = Core22.extractMemory(reply);
    assert.deepEqual(parsed.memories, ["玩家叫小林", "他怕黑"]);
    assert.equal(parsed.text, "“我记得的。”");
    assert.equal(parsed.text.indexOf("[["), -1);
  });

  await test("没有标记时原样返回，标记最多取 3 条", () => {
    assert.deepEqual(Core22.extractMemory("就是普通回复").memories, []);
    const many = Core22.extractMemory("正文\n[[记住: a]]\n[[记住: b]]\n[[记住: c]]\n[[记住: d]]");
    assert.equal(many.memories.length, 3);
  });

  await test("开了自动记忆时系统提示里才有记忆指令", () => {
    const card = { name: "Hermione", data: { name: "Hermione", description: "d", personality: "p", scenario: "s" } };
    const withMemory = Core22.buildSystemPrompt(card, [], "你好", { autoMemory: true });
    const without = Core22.buildSystemPrompt(card, [], "你好", { autoMemory: false });
    assert.ok(withMemory.indexOf("[Memory]") >= 0, "开了自动记忆却没有指令");
    assert.ok(without.indexOf("[Memory]") < 0, "关掉了还带记忆指令");
  });

  console.log("== 价格估算 ==");

  const Pricing = require(path.join(__dirname, "..", "app", "adapter", "pricing.js"));

  // 北京时间固定成几个点来测峰谷：用 UTC 构造，避免本机时区影响结果。
  const beijing = (iso) => new Date(iso);

  await test("峰谷时段按北京时间判断，周末全天闲时", () => {
    // 2026-09-10 是周四。北京时间 10:00 = UTC 02:00
    assert.equal(Pricing.isPeak(beijing("2026-09-10T02:00:00Z")), true, "周四上午应是高峰");
    assert.equal(Pricing.isPeak(beijing("2026-09-10T05:00:00Z")), false, "周四 13:00 应是闲时");
    assert.equal(Pricing.isPeak(beijing("2026-09-10T06:30:00Z")), true, "周四 14:30 应是高峰");
    assert.equal(Pricing.isPeak(beijing("2026-09-10T10:30:00Z")), false, "周四 18:30 应是闲时");
    // 2026-09-12 是周六
    assert.equal(Pricing.isPeak(beijing("2026-09-12T02:00:00Z")), false, "周六上午也算闲时");
  });

  await test("Flash 系列按 2026-09-10 官方价，高峰翻倍", () => {
    const off = Pricing.pricesFor("deepseek-v4-flash", null, beijing("2026-09-10T10:30:00Z"));
    assert.equal(off.input, 1);
    assert.equal(off.output, 4);
    assert.equal(off.cacheHit, 0.02);
    const peak = Pricing.pricesFor("deepseek-v4-flash", null, beijing("2026-09-10T02:00:00Z"));
    assert.equal(peak.input, 2);
    assert.equal(peak.output, 8);
  });

  await test("V4 Pro 用另一档价格，未知模型默认免费", () => {
    const pro = Pricing.pricesFor("deepseek-v4-pro", null, beijing("2026-09-10T10:30:00Z"));
    assert.equal(pro.output, 13.5);
    const unknown = Pricing.pricesFor("some-local-model", null, beijing("2026-09-10T10:30:00Z"));
    assert.equal(unknown.output, 0);
  });

  await test("用户填了单价就按用户填的算，且不再峰谷翻倍", () => {
    const custom = Pricing.pricesFor("gpt-4o", { input: 18, output: 72 }, beijing("2026-09-10T02:00:00Z"));
    assert.equal(custom.input, 18);
    assert.equal(custom.output, 72);
  });

  await test("token 估算：中文按字、英文按字符", () => {
    assert.equal(Pricing.estimateTokens(""), 1);
    const cjk = Pricing.estimateTokens("你好世界你好世界");
    assert.ok(cjk >= 4 && cjk <= 6, "8 个汉字应约 5 token，实际 " + cjk);
    const ascii = Pricing.estimateTokens("abcdefghijklmnop");
    assert.ok(ascii >= 3 && ascii <= 5, "16 个字母应约 4 token，实际 " + ascii);
  });

  await test("一次对话的费用算得对（含缓存命中）", () => {
    const prices = Pricing.pricesFor("deepseek-v4-flash", null, beijing("2026-09-10T10:30:00Z"));
    // 输入 10000（其中 8000 命中），输出 2000
    const cost = Pricing.costOf({ input: 10000, output: 2000, cacheHit: 8000 }, prices);
    const expected = (2000 / 1e6) * 1 + (8000 / 1e6) * 0.02 + (2000 / 1e6) * 4;
    assert.ok(Math.abs(cost - expected) < 1e-12, `应为 ${expected}，实际 ${cost}`);
    assert.equal(Pricing.formatCost(cost), "¥0.0102");
  });

  await test("官方旧别名自动迁移，第三方端点不动", async () => {
    // 2026-09-11 起官方目录里 flash 系列统一叫 deepseek-flash；老用户本机存的旧名要自动升。
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-v4-flash" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-flash", "官方别名没有迁移");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-chat" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-flash", "deepseek-chat 没有迁移");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "https://my-proxy.example/v1/chat/completions", model: "deepseek-v4-flash" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-v4-flash", "第三方端点的模型名被误改");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-flash" });
  });

  await test("官方目录只列在售型号", () => {
    const models = Model.PRESETS.deepseek.models;
    assert.ok(models.indexOf("deepseek-flash") >= 0, "缺少 deepseek-flash：" + JSON.stringify(models));
    assert.ok(models.indexOf("deepseek-v4-pro") >= 0, "缺少 deepseek-v4-pro：" + JSON.stringify(models));
    assert.ok(models.indexOf("deepseek-v4-flash") < 0, "已下线的旧型号还在列表里：" + JSON.stringify(models));
    assert.equal(Model.DEFAULT_SETTINGS.model, "deepseek-flash");
  });

  await test("接口回了 usage 就用真值，没回就按字数估", () => {
    const exact = Pricing.usageOf({ usage: { prompt_tokens: 1234, completion_tokens: 567 }, messages: [], reply: "" });
    assert.equal(exact.input, 1234);
    assert.equal(exact.output, 567);
    assert.equal(exact.exact, true);

    const guess = Pricing.usageOf({ messages: [{ role: "user", content: "你好你好你好你好" }], reply: "好的好的好的好的" });
    assert.equal(guess.exact, false);
    assert.ok(guess.input > 0 && guess.output > 0);
  });

  await test("官方价表钉住（对过官方中文页 2026-09-10 12:00 生效那版）", () => {
    const off = new Date("2026-09-10T10:30:00Z");   // 北京 18:30 周四 → 空闲
    const peak = new Date("2026-09-11T02:00:00Z");  // 北京 10:00 周五 → 高峰
    const flashOff = Pricing.pricesFor("deepseek-flash", null, off);
    assert.equal(flashOff.input, 1);
    assert.equal(flashOff.output, 4);
    assert.equal(flashOff.cacheHit, 0.02);
    const flashPeak = Pricing.pricesFor("deepseek-flash", null, peak);
    assert.equal(flashPeak.input, 2);
    assert.equal(flashPeak.output, 8);
    assert.equal(flashPeak.cacheHit, 0.04);
    const proOff = Pricing.pricesFor("deepseek-v4-pro", null, off);
    assert.equal(proOff.input, 4.5);
    assert.equal(proOff.output, 13.5);
    assert.equal(proOff.cacheHit, 0.15);
    const proPeak = Pricing.pricesFor("deepseek-v4-pro", null, peak);
    assert.equal(proPeak.input, 9);
    assert.equal(proPeak.output, 27);
    assert.equal(proPeak.cacheHit, 0.3);
  });

  await test("单价说明写清楚币种、时段与高峰翻倍", () => {
    const off = new Date("2026-09-10T10:30:00Z");
    const info = Pricing.describe("deepseek-flash", null, off);
    assert.ok(/元|¥/.test(info.text), "没写币种：" + info.text);
    assert.ok(/闲时|空闲/.test(info.text), "没写时段：" + info.text);
    assert.ok(info.title.indexOf("高峰") >= 0 && info.title.indexOf("¥2") >= 0, "没说明高峰翻倍：" + info.title);
    assert.ok(info.title.indexOf("北京时间") >= 0, "没写高峰时段口径");
    const custom = Pricing.describe("gpt-4o", { input: 18, output: 72 }, off);
    assert.ok(custom.text.indexOf("自定义") >= 0, "自定义单价没有标注：" + custom.text);
  });

  console.log("== ZIP ==");

  await test("ZIP 写入后能原样读回（含中文文件名与二进制）", async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const blob = Zip.write([
      { name: "archive.json", data: JSON.stringify({ 你好: "世界" }) },
      { name: "cards/哈利.png", data: payload },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const files = await Zip.read(bytes);
    assert.equal(files.size, 2);
    assert.deepEqual(JSON.parse(Zip.utf8Decode(files.get("archive.json"))), { 你好: "世界" });
    assert.deepEqual(Array.from(files.get("cards/哈利.png")), Array.from(payload));
  });

  await test("能读取外部工具压缩的 deflate ZIP", async () => {
    // 用 Node 的 zlib 手工造一个 method=8 的最小 ZIP，验证解压路径。
    const name = Buffer.from("a.txt", "utf8");
    const raw = Buffer.from("压缩内容 compressed", "utf8");
    const deflated = zlib.deflateRawSync(raw);
    const crc = Zip.crc32(new Uint8Array(raw));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + deflated.length, 16);
    const zip = Buffer.concat([local, name, deflated, central, name, end]);

    const files = await Zip.read(new Uint8Array(zip));
    assert.equal(Zip.utf8Decode(files.get("a.txt")), "压缩内容 compressed");
  });

  await test("非 ZIP 数据会明确报错", async () => {
    await assert.rejects(() => Zip.read(new Uint8Array([1, 2, 3, 4])), /不是有效的 ZIP 文件/);
  });

  console.log("");
  console.log("== 称呼（preferences.nickname）==");

  await test("称呼：默认是空串（还没设过）", () => {
    assert.equal(AccountCore.defaultPreferences().nickname, "");
    assert.equal(AccountCore.normalizePreferences({}).nickname, "");
  });

  await test("称呼：去掉首尾空白与控制字符", () => {
    assert.equal(AccountCore.nicknameValue("  小林  "), "小林");
    assert.equal(AccountCore.nicknameValue("阿\u0000远\n"), "阿远");
    assert.equal(AccountCore.nicknameValue(null), "");
    assert.equal(AccountCore.nicknameValue(123), "");
  });

  await test("称呼：超长截断而不是丢掉", () => {
    const long = "很".repeat(40);
    assert.equal(AccountCore.nicknameValue(long).length, AccountCore.NICKNAME_MAX);
    assert.equal(AccountCore.normalizePreferences({ nickname: long }).nickname.length, AccountCore.NICKNAME_MAX);
  });

  await test("称呼：能存进偏好并原样读回", () => {
    const store = new Map();
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };
    const written = AccountCore.writePreferences(storage, "local", { nickname: "  阿远  " });
    assert.equal(written.preferences.nickname, "阿远");
    const read = AccountCore.readPreferences(storage, "local", {});
    assert.equal(read.preferences.nickname, "阿远");
  });

  console.log("");
  const passed = results.filter((row) => row.ok).length;
  console.log(`ADAPTER_UNIT=${passed}/${results.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("测试运行失败：", error);
  process.exitCode = 1;
});
