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

  // Task-39A：保存其实成功、界面却当失败时，用户重发同一句不能写第二遍（也不能再计一次费）。
  const Core22ForChat = require(path.join(__dirname, "..", "app", "task22-core.js"));

  function turnApi() {
    return {
      listChats: (avatar) => Store.listChats(avatar),
      getChat: (avatar, fileName) => Store.getChat(avatar, fileName),
      saveChat: (avatar, fileName, messages) => Store.saveChat(avatar, fileName, messages),
    };
  }

  // 回执通道与 integration.js 一致：同一个本地 store，不新增存储层。
  const turnReceipts = {
    get: (avatar, fileName) => Store.getKV("turn:" + avatar + ":" + fileName, null),
    set: (avatar, fileName, value) => Store.setKV("turn:" + avatar + ":" + fileName, value),
  };

  function makeTurnModel() {
    return Core22ForChat.createHarryChatModel({
      api: turnApi(),
      receipts: turnReceipts,
      avatar: "a.png",
      charName: "甲",
      userName: "我",
      userHandle: "unit",
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      characters: [{ avatar: "a.png", name: "甲" }],
    });
  }

  async function turnCount(avatar, fileName) {
    const lines = await Store.getChat(avatar, fileName);
    return lines.filter((line) => line && typeof line.mes === "string" && line.mes).length;
  }

  await test("重发同一轮（同一个 turnId）不写第二遍，第二轮照旧写入", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("a.png", "甲"));
    const model = makeTurnModel();
    await model.refresh();
    model.bindActive({ avatar: "a.png", charName: "甲" });

    const first = await model.saveTurn("第一句", "第一答", { userName: "我", charName: "甲", turnId: "turn-1" });
    assert.equal(first.duplicate, false, "第一次保存不该被当成重复");
    const fileName = model.getActive().fileName;
    assert.equal(await turnCount("a.png", fileName), 2);

    const again = await model.saveTurn("第一句", "第一答", { userName: "我", charName: "甲", turnId: "turn-1" });
    assert.equal(again.duplicate, true, "重发同一轮没有被识别成重复");
    assert.equal(await turnCount("a.png", fileName), 2, "重发之后消息数变了");

    await model.saveTurn("第二句", "第二答", { userName: "我", charName: "甲", turnId: "turn-2" });
    assert.equal(await turnCount("a.png", fileName), 4, "正常的新一轮应当照旧写入");
  });

  await test("幂等回执跨刷新有效（新模型实例仍然认得这一轮）", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("a.png", "甲"));
    const firstModel = makeTurnModel();
    await firstModel.refresh();
    firstModel.bindActive({ avatar: "a.png", charName: "甲" });
    await firstModel.saveTurn("我改主意了", "好，听你的。", { userName: "我", charName: "甲", turnId: "turn-r" });
    const fileName = firstModel.getActive().fileName;

    const secondModel = makeTurnModel();   // 等同刷新页面：内存全丢
    await secondModel.refresh();
    assert.equal(secondModel.getActive().fileName, fileName);
    const retry = await secondModel.saveTurn("我改主意了", "好，听你的。", { userName: "我", charName: "甲", turnId: "turn-r" });
    assert.equal(retry.duplicate, true, "刷新后重发没有被识别成重复");
    assert.equal(await turnCount("a.png", fileName), 2, "刷新后重发还是写了一遍");
  });

  await test("保存失败的那一轮不留回执，重发会被真正写入", async () => {
    Store.resetForTests();
    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.putCharacter(card("a.png", "甲"));
    const model = makeTurnModel();
    await model.refresh();
    model.bindActive({ avatar: "a.png", charName: "甲" });
    const original = Store.saveChat;
    let failOnce = true;
    const failing = async function () {
      if (failOnce) { failOnce = false; throw new Error("network down"); }
      return original.apply(null, arguments);
    };
    const api = turnApi();
    api.saveChat = failing;
    const flaky = Core22ForChat.createHarryChatModel({
      api,
      receipts: turnReceipts,
      avatar: "a.png",
      charName: "甲",
      userName: "我",
      userHandle: "unit",
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      characters: [{ avatar: "a.png", name: "甲" }],
    });
    await flaky.refresh();
    flaky.bindActive({ avatar: "a.png", charName: "甲" });

    let threw = false;
    try { await flaky.saveTurn("会失败的", "不会成功", { userName: "我", charName: "甲", turnId: "turn-f" }); }
    catch (_) { threw = true; }
    assert.ok(threw, "第一次保存应当失败");

    const retry = await flaky.saveTurn("会失败的", "这次成功", { userName: "我", charName: "甲", turnId: "turn-f" });
    assert.equal(retry.duplicate, false, "失败的那轮不该留下回执");
    const chats = await Store.listChats("a.png");
    assert.equal(chats.length, 1);
    assert.equal(await turnCount("a.png", chats[0].file_name), 2);
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

  await test("接口报错时抛出带状态码的可读错误（401 还要说清打到哪、用的什么凭据）", async () => {
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
      // 光说"接口返回 401"没法查：错误里要带上端点与凭据形态（只留末 4 位，绝不带完整密钥）。
      let captured = null;
      try {
        await Model.complete({ messages: [], settings: { provider: "deepseek", endpoint: "https://api.example.com/v1/chat/completions" } }, { apiKey: "sk-abcdef1234" });
      } catch (error) { captured = error; }
      assert.ok(captured, "没有抛出错误");
      assert.equal(captured.authKind, "key", "凭据形态没带上：" + captured.authKind);
      assert.equal(captured.authTail, "1234", "末 4 位不对：" + captured.authTail);
      assert.ok(String(captured.endpoint).indexOf("api.example.com") >= 0, "端点没带上：" + captured.endpoint);
      assert.ok(String(captured.message).indexOf("sk-abcdef1234") < 0, "错误信息里不该出现完整密钥");
      // 体验卡形态要能分出来（这决定了提示里让用户去改哪一处）。
      let cardError = null;
      try {
        await Model.complete({ messages: [], settings: { provider: "custom", endpoint: "https://relay.example.com/v1/chat/completions" } }, { apiKey: "RW-AAAAA-BBBBB-CCCCC" });
      } catch (error) { cardError = error; }
      assert.equal(cardError.authKind, "card", "卡号没被认出来：" + cardError.authKind);
      assert.ok(String(cardError.message).indexOf("RW-AAAAA-BBBBB-CCCCC") < 0, "错误信息里不该出现完整卡号");
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

  await test("已知云端端点自动匹配服务商", () => {
    assert.equal(Model.providerForEndpoint("https://api.deepseek.com/chat/completions"), "deepseek");
    assert.equal(Model.providerForEndpoint("https://api.deepseek.com/chat/completions/"), "deepseek");
    assert.equal(Model.providerForEndpoint("HTTP://127.0.0.1:8080/v1/chat/completions"), "");
    assert.equal(Model.providerForEndpoint("https://my-proxy.example/v1/chat/completions"), "");
    assert.equal(Model.providerForEndpoint(""), "");
  });

  await test("写角色走 custom 路径时带的是 DeepSeek 的 Key", async () => {
    // 页面在自定义路径上会发 chat_completion_source:"custom" + custom_url，
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

  await test("关于页的状态 JSON 能解析，且版本号与 package.json 一致", () => {
    // 关于页兼作"机器可读的状态页"：版本号、测试口径、数据边界、已知限制。
    // 手写 JSON 最容易漂的就是版本号，所以这里直接对一次。
    const html = fs.readFileSync(path.join(__dirname, "..", "app", "about.html"), "utf8");
    const match = html.match(/<script type="application\/json" id="roleworld-status">([\s\S]*?)<\/script>/);
    assert.ok(match, "about.html 里找不到 roleworld-status 那段 JSON");
    let status = null;
    try {
      status = JSON.parse(match[1]);
    } catch (error) {
      throw new Error("状态 JSON 解析失败：" + (error && error.message));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert.equal(status.version, pkg.version, "关于页的版本号和 package.json 不一致");
    assert.ok(Array.isArray(status.runs && status.runs.suites) && status.runs.suites.length >= 6,
      "状态里应当列出测试套件");
    for (const row of status.runs.suites) {
      assert.ok(row.name && Number(row.checks) > 0, "套件条目缺名称或项数：" + JSON.stringify(row));
    }
    assert.ok(Array.isArray(status.privacy && status.privacy.leavesDevice) && status.privacy.leavesDevice.length,
      "状态里应当写明「哪些内容会离开设备」");
    assert.ok(Array.isArray(status.knownLimitations) && status.knownLimitations.length >= 3,
      "状态里应当列出已知限制");
  });

  await test("关于页说清楚「本地保存不等于不上云」，并写明密钥的去向", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "app", "about.html"), "utf8");
    // 以前的写法是"密钥不会上传到任何服务器"，那是错的：它会作为鉴权头发给用户配置的端点。
    assert.ok(html.indexOf("不等于") >= 0, "应当明确写出本地保存不等于不上云");
    assert.ok(html.indexOf("鉴权头") >= 0, "应当写明 API Key 会作为鉴权头发给配置的端点");
    assert.ok(html.indexOf("不会上传到任何服务器") < 0,
      "不要再写「密钥不会上传到任何服务器」——它指的是别处，容易被读成「绝对不会离开设备」");
  });

  await test("应用没打开时够不到用户：没有通知 / 推送 / 后台调度（P3-2，2026-09-12 修订）", () => {
    // 2026-09-12 用户拍板：伴侣类版本**允许**主动消息 / 亲近度 / 冷落反应。
    // 怎么落地很关键 —— **主动消息只发生在"用户回来的时候"**（打开这个角色的对话，它先开口），
    // 所以这条用例守的东西没变：应用没打开时，任何东西都不许够到用户。
    // 也就是说通知、推送、后台同步、长定时器**一个都不许有**；伴侣模式那套只需要
    // "算一算该不该开口"，不需要任何唤醒能力（默认还关着，见 companion-unit）。
    const appDir = path.join(__dirname, "..", "app");
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
        if (!/\.(js|html|css)$/.test(entry.name)) continue;
        files.push(path.join(dir, entry.name));
      }
    };
    walk(appDir);

    const offenders = [];
    // 短定时器是界面防抖/回收（例如 10 秒后回收一个下载 URL），不算调度。
    // 真正要拦的是"几分钟起步、用来定时唤起用户"的那种。
    const LONG_TIMER_MS = 300000;
    const longTimerRe = /setTimeout\s*\([^,]+,\s*(\d+)/g;
    const intervalRe = /setInterval\s*\([^,]+,\s*(\d+)/g;
    for (const file of files) {
      const rel = path.relative(path.join(__dirname, ".."), file);
      const text = fs.readFileSync(file, "utf8");
      // 1) 能在应用没打开时"够到"用户的东西：通知、推送、后台同步 —— 一个都不该有。
      //    注意：serviceWorker 本身不在此列 —— 离线壳只是让界面断网能开，
      //    它**不会**主动联系用户；真正的判据是下面第二条（壳里不许有 push/notification/sync 处理）。
      for (const api of ["new Notification", "Notification.requestPermission", "showNotification",
        "pushManager", "periodicSync", "PeriodicSync", "registration.sync"]) {
        if (text.indexOf(api) >= 0) offenders.push(rel + " 用了 " + api);
      }
      // 2) 长定时器（≥ 5 分钟）当调度用；短定时器是界面防抖，不算。
      let match;
      longTimerRe.lastIndex = 0;
      while ((match = longTimerRe.exec(text))) {
        if (Number(match[1]) >= LONG_TIMER_MS) offenders.push(rel + " 里有一个 " + match[1] + "ms 的 setTimeout");
      }
      intervalRe.lastIndex = 0;
      while ((match = intervalRe.exec(text))) {
        if (Number(match[1]) >= 60000) offenders.push(rel + " 里有一个 " + match[1] + "ms 的 setInterval");
      }
    }
    // 离线壳里不许有任何"被服务端唤醒"的入口。
    const swPath = path.join(appDir, "sw.js");
    if (fs.existsSync(swPath)) {
      const sw = fs.readFileSync(swPath, "utf8");
      for (const handler of ["\"push\"", "'push'", "\"notificationclick\"", "'notificationclick'",
        "\"periodicsync\"", "'periodicsync'", "\"sync\"", "'sync'"]) {
        if (sw.indexOf("addEventListener(" + handler) >= 0) offenders.push("app/sw.js 里注册了 " + handler + " 事件");
      }
    }
    assert.deepEqual(offenders, [], "发现了疑似主动提醒/后台调度：" + offenders.join("；"));

    // 3) 召回类话术不该出现在任何界面文案里（这些是"拿愧疚留人"的措辞，和亲近度不是一回事）。
    //    例外：about.html 是"说明页"，它恰好要用这些词来说明"我们不做这些事"。
    //    注：2026-09-12 起「亲近度 / 主动开口 / 冷落反应」在伴侣模式内是**允许**的
    //    （用户拍板），所以它们不在这个词表里；上限与默认关由 companion-unit 守着。
    const bait = ["连续打卡", "签到", "好感度", "你多久没来", "一直在等你", "想我了吗", "已经 N 天没"];
    const baitHits = [];
    for (const file of files) {
      const rel = path.relative(path.join(__dirname, ".."), file);
      if (rel.endsWith(path.join("app", "about.html"))) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const word of bait) if (text.indexOf(word) >= 0) baitHits.push(rel + " 出现「" + word + "」");
    }
    assert.deepEqual(baitHits, [], "界面文案里有召回/打卡类话术：" + baitHits.join("；"));

    // 4) 内疚话术那几句只允许出现在"禁止它们"的地方（companion-core 的硬规矩与自检）。
    const guilt = ["你都不理我", "我等了你很久", "没有你我该怎么办"];
    for (const file of files) {
      const rel = path.relative(path.join(__dirname, ".."), file);
      if (rel.endsWith(path.join("app", "companion-core.js"))) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const phrase of guilt) {
        assert.ok(text.indexOf(phrase) < 0, rel + " 里出现了内疚话术「" + phrase + "」");
      }
    }
  });

  await test("版本号五处一致：package.json / tauri.conf.json / Cargo.toml / app/version.json / app/build.js", () => {
    // app/version.json 是给网页版判断"线上是不是发了新版"用的（见 app/pwa.js）；
    // Cargo.toml 决定 **Windows「应用和功能」里显示的版本** —— 它以前漏了，
    // 于是装出来的 0.1.15 在系统里显示成 0.1.0。五处都由 scripts/set-version.cjs 一起改。
    const root = path.join(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const tauri = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    const web = JSON.parse(fs.readFileSync(path.join(root, "app", "version.json"), "utf8"));
    const cargo = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
    const cargoVersion = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || "";
    assert.equal(web.version, pkg.version, "app/version.json 与 package.json 版本号不一致");
    assert.equal(tauri.version, pkg.version, "tauri.conf.json 与 package.json 版本号不一致");
    assert.equal(cargoVersion, pkg.version, "Cargo.toml 与 package.json 版本号不一致（系统里会显示错版本）");
    // app/build.js 是"运行中的版本"的唯一来源：设置里靠它和线上 version.json 对照，
    // 才能发现浏览器还在跑旧缓存（2026-09-12 用户报"还是英文"时就是靠这一手定位的）。
    const buildJs = fs.readFileSync(path.join(root, "app", "build.js"), "utf8");
    const buildVersion = (buildJs.match(/window\.ROLEWORLD_BUILD\s*=\s*"([^"]+)"/) || [])[1] || "";
    assert.equal(buildVersion, pkg.version, "app/build.js 与 package.json 版本号不一致（界面会显示错的运行版本）");
    assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), "版本号格式不对：" + pkg.version);
  });

  await test("PWA 清单与离线壳都在位，且清单里的图标真的存在", () => {
    const root = path.join(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "app", "manifest.webmanifest"), "utf8"));
    assert.ok(manifest.name && manifest.short_name, "清单缺名称");
    assert.equal(manifest.start_url, "./index.html", "start_url 应当是相对路径（部署在子路径下也能用）");
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "清单里的图标太少");
    for (const icon of manifest.icons) {
      const file = path.join(root, "app", icon.src);
      assert.ok(fs.existsSync(file), "清单里的图标不存在：" + icon.src);
      assert.ok(fs.statSync(file).size > 0, "图标是空文件：" + icon.src);
    }
    // index.html 要真的挂上清单，否则前面这些都没用。
    const html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
    assert.ok(html.indexOf('rel="manifest"') >= 0, "index.html 没有引用清单");
    assert.ok(html.indexOf("pwa.js") >= 0, "index.html 没有加载 pwa.js");
    // 离线壳必须能被解析（语法错误会让整个离线能力失效，而且只在浏览器里才报）。
    const sw = fs.readFileSync(path.join(root, "app", "sw.js"), "utf8");
    assert.ok(sw.indexOf('addEventListener("fetch"') >= 0, "离线壳没有 fetch 处理");
    assert.ok(sw.indexOf('addEventListener("install"') >= 0, "离线壳没有 install 处理");
    // 行为正确性（真离线打开、提示页不覆盖外壳）由 tests/offline-check.cjs 在真实浏览器里验。
  });

  await test("Android 打包的地基没被拆掉：lib 目标 + 移动入口 + 工具链钉版一致", () => {
    const root = path.join(__dirname, "..");
    const cargo = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
    const packageName = (cargo.match(/^\[package\]([\s\S]*?)(?=^\[|\Z)/m) || ["", ""])[1];
    const appName = (packageName.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || "";

    // 1) `[lib]` 段必须存在且是 cdylib。
    //    Android **不加载可执行文件，只加载动态库** —— `tauri android build` 从
    //    `[lib] name` 推导出要加载的 `lib<name>.so`。少一段 `[lib]` 或少了 cdylib，
    //    命令行一切正常、APK 也出得来，**装到手机上一点就闪退**（`UnsatisfiedLinkError`），
    //    所以这条必须在打包前就红。
    const libBlock = cargo.match(/^\[lib\]([\s\S]*?)(?=^\[|\Z)/m);
    assert.ok(libBlock, "src-tauri/Cargo.toml 缺 [lib] 段：Android 只加载动态库");
    const crateTypes = ((libBlock[1].match(/crate-type\s*=\s*\[([^\]]*)\]/) || [])[1] || "");
    assert.ok(crateTypes.indexOf("cdylib") >= 0, "[lib] 的 crate-type 必须含 cdylib（Android 加载 .so）");
    const libBlockName = (libBlock[1].match(/name\s*=\s*"([^"]+)"/) || [])[1] || "";
    assert.ok(
      libBlockName && libBlockName === appName,
      "[lib] name 与 package name 不一致（.so 名字会对不上，手机闪退）：" + libBlockName + " vs " + appName,
    );

    // 2) 移动入口：这个宏生成 Android/iOS 侧要调用的 `start_app` 符号。
    const libRs = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
    assert.ok(
      libRs.indexOf("tauri::mobile_entry_point") >= 0,
      "src/lib.rs 缺 #[cfg_attr(mobile, tauri::mobile_entry_point)]：手机会起不来",
    );
    assert.ok(/pub\s+fn\s+run\s*\(/.test(libRs), "src/lib.rs 没有 pub fn run()（移动入口）");
    // 桌面入口只是薄壳，真正的命令在库里，改一处两端都变。
    const mainRs = fs.readFileSync(path.join(root, "src-tauri", "src", "main.rs"), "utf8");
    assert.ok(mainRs.indexOf("roleworld::run()") >= 0, "src/main.rs 没有调用 roleworld::run()（桌面入口断了）");

    // 3) 打包脚本里钉的 NDK 版本。
    //    踩过：SDK 下同时装了 27 和 29 时，tauri-cli 会挑**字典序最大**的那个，
    //    而 CLI 2.11.4 认的是 29.0.13846066。写错版本号时构建能过、行为却不对，
    //    所以这里和 CLI 的常量和脚本的常量对齐。
    const script = fs.readFileSync(path.join(root, "scripts", "build-android.cjs"), "utf8");
    const pinned = (script.match(/NDK_VERSION\s*=\s*"([^"]+)"/) || [])[1] || "";
    assert.equal(pinned, "29.0.13846066", "build-android.cjs 里的 NDK 版本和 tauri-cli 2.11.4 钉的不一致");
    // 构建命令必须真的接进 package.json，否则没人知道怎么出包。
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.ok(pkg.scripts["android:build"], "package.json 里没有 android:build 命令");

    // 4) **手机白屏的元凶**（2026-09-13 用户真机踩到，必须钉住）：
    //    tauri 的 build.rs 里 `let dev = !custom_protocol;`。直接 `cargo build` 时
    //    `custom-protocol` 没开 → `dev = true` → `src/protocol/tauri.rs` 里
    //    `#[cfg(all(dev, mobile))]` 会让**所有**资源请求走"开发服务器代理"
    //    （reqwest 去请求一个根本不存在的 devUrl），手机上打开就是：
    //      Failed to request http://tauri.localhost/: error sending request for url
    //    桌面端不会现形（那条分支只在 mobile + dev 下编译进去），所以"打包成功"
    //    完全不能说明手机上能开 —— 只能在测试里钉住。
    assert.ok(
      script.indexOf("tauri/custom-protocol") >= 0,
      "build-android.cjs 少了 --features tauri/custom-protocol：手机上会白屏（资源请求被当成开发服务器代理）",
    );
    assert.ok(
      /"--lib"/.test(script),
      "build-android.cjs 少了 --lib：手机只加载 libroleworld.so，不该去构建可执行文件",
    );
    // 反过来也得钉住：这个 feature **不能**进 default features ——
    // 一旦进 default，`tauri dev` 桌面开发就会失去 devUrl 热更新。
    assert.ok(
      !/default\s*=\s*\[[^\]]*custom-protocol/.test(cargo),
      "custom-protocol 不能进 Cargo.toml 的 default features（会让 tauri dev 失去热更新）",
    );

    // 5) 手机侧的地基。
    //    ⚠ 这一段在 2026-09-14 换过判据：**语音方向变了** —— 语音只走云端
    //    （火山豆包 TTS 2.0，经体验卡中转），不再做 Android 系统 TTS / 浏览器朗读。
    //    所以"必须接原生语音桥"那条断言**已经不再是事实**，换成：
    //      · 麦克风权限仍然要有（**语音输入没变**，删了它录音直接拿不到权限）；
    //      · 前端**不许**再接系统朗读那两条路（防止哪天有人"顺手加个兜底"又把方向带回去）；
    //      · 云端那条路必须真的在（否则手机上就彻底没声了，而且没人会发现）。
    const shell = fs.readFileSync(path.join(root, "scripts", "ensure-android-shell.cjs"), "utf8");
    assert.ok(
      shell.indexOf("RECORD_AUDIO") >= 0 && shell.indexOf("MODIFY_AUDIO_SETTINGS") >= 0,
      "ensure-android-shell.cjs 少了麦克风权限：Android 上 getUserMedia 会直接失败（语音输入会一起坏掉）",
    );
    // 前端这一侧：语音输入必须还在；系统朗读那两条路必须都不在。
    const voiceCore = fs.readFileSync(path.join(root, "app", "voice-core.js"), "utf8");
    assert.ok(
      voiceCore.indexOf("startRecording") >= 0 && voiceCore.indexOf("transcribeBlob") >= 0,
      "voice-core.js 少了录音或转写：清理系统朗读时误伤了语音输入",
    );
    assert.ok(
      voiceCore.indexOf("__rwNativeTts") < 0 && voiceCore.indexOf("__rwVoiceCallback") < 0,
      "voice-core.js 又接回原生语音桥了 —— 语音这一轮只走云端，不做安卓系统 TTS",
    );
    assert.ok(
      voiceCore.indexOf("speechSynthesis") < 0 && voiceCore.indexOf("SpeechSynthesisUtterance") < 0,
      "voice-core.js 又接回浏览器自带了朗读 —— 那会让同一个角色有时候是情感音色、有时候是播报腔",
    );
    // 云端那条路必须真的在：客户端发什么、往哪发、用什么资源标识，都在这里钉住。
    const voiceAdapter = fs.readFileSync(path.join(root, "app", "adapter", "voice.js"), "utf8");
    assert.ok(
      voiceAdapter.indexOf("/v1/audio/speech") >= 0 && voiceAdapter.indexOf("/voice/info") >= 0,
      "adapter/voice.js 少了云端语音的两个接口（合成 / 音色表）",
    );
    const relayTts = fs.readFileSync(path.join(root, "relay", "tts.js"), "utf8");
    assert.ok(
      relayTts.indexOf("seed-tts-2.0") >= 0,
      "relay/tts.js 的资源标识不是「豆包语音合成模型 2.0」的 seed-tts-2.0",
    );
    assert.ok(
      relayTts.indexOf("/api/v3/tts/unidirectional") >= 0,
      "relay/tts.js 打的不是官方 HTTP 单向流式端点",
    );
    // 两套控制台鉴权都支持，而且**不会混发**（同时发会被上游当成配错）。
    assert.ok(
      relayTts.indexOf("X-Api-App-Id") >= 0 && relayTts.indexOf("X-Api-Key") >= 0 && relayTts.indexOf("X-Api-Access-Key") >= 0,
      "relay/tts.js 少了某一套控制台鉴权头",
    );
  });

  await test("index.html 里没有重复的 id", () => {
    // 真踩过：两个 id="memoryList"（角色记忆弹层一个、右侧记忆栏一个）。
    // querySelector 只会命中第一个，于是"渲染到 A、用户看的是 B"这种错很难查。
    const html = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
    const ids = [];
    const re = /\sid="([^"]+)"/g;
    let match;
    while ((match = re.exec(html))) ids.push(match[1]);
    const seen = new Set();
    const duplicates = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    assert.deepEqual(duplicates, [], "index.html 里有重复 id：" + duplicates.join(", "));
    assert.ok(ids.length > 50, "id 数量看起来不对（正则失效？）：" + ids.length);
  });

  await test("主要入口按钮不能带 hidden（用户点不到就等于没做）", () => {
    // 2026-09-12：用户反馈"看不到记忆"。根因是顶栏那颗「记忆」按钮自带 hidden，
    // 而整个前端没有任何代码把它摘掉——只有 window.TASK21.openMemoryPanel() 能开右栏。
    // 端到端用例当时全都在调内部函数，所以一次也没碰到这个入口。这条在静态层面守着。
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
    for (const action of ["open-memories"]) {
      const match = html.match(new RegExp('<button[^>]*data-action="' + action + '"[^>]*>'));
      assert.ok(match, "index.html 里找不到入口按钮：" + action);
      assert.ok(!/\shidden(\s|>)/.test(match[0]), "入口按钮带 hidden，用户点不到：" + match[0]);
    }
    // 能开也得能关，否则右栏一直挡着对话。
    assert.ok(html.indexOf('data-action="close-memories"') >= 0, "记忆栏没有关闭按钮");
    const appJs = fs.readFileSync(path.join(root, "app", "app.js"), "utf8");
    assert.ok(appJs.indexOf('action === "open-memories"') >= 0, "app.js 里没有处理 open-memories 的动作");
  });

  await test("内置包里那些「别人的存档」条目能被精准清掉，且不碰用户改过的条目", () => {
    // 2026-09-12 用户原话「我又不是 Lin」：内置包以前带着原 SillyTavern 存档的记忆书，
    // 里面 Lin 是那份存档的玩家角色，其中 3 条还是 constant（每条消息都注入）。
    const Cleanup = require(path.join(__dirname, "..", "app", "adapter", "pack-cleanup.js"));
    const spec = Cleanup.SAMPLE_MEMORIES.find((row) => row.world === "MB Harry — fact clips (EN)");
    assert.ok(spec, "示例表里应当登记 fact clips 这本");
    const entries = {
      "mb-fact-home": { uid: "mb-fact-home", content: "Lin's home city is Shanghai, China. She grew up there before coming to Hogwarts." },
      "mb-fact-heights": { uid: "mb-fact-heights", content: "我自己改成了：玩家怕高。" },
      "0": { uid: 0, content: "合成记忆内容" },
    };
    const result = Cleanup.stripSampleEntries(entries, spec);
    assert.deepEqual(result.removed.map((row) => row.key), ["mb-fact-home"], "只该删掉那条原样的示例");
    assert.deepEqual(Object.keys(result.keep).sort(), ["0", "mb-fact-heights"], "改过的与用户自己的都要留");
  });

  await test("一次性清理：整本都是示例的书删掉、还有用户条目的书保留、表外的书一律不碰", async () => {
    const Cleanup = require(path.join(__dirname, "..", "app", "adapter", "pack-cleanup.js"));
    const store = {
      data: {
        "MB Harry — scene memories (EN)": { entries: {
          "mb-scene-meeting": { uid: "mb-scene-meeting", content: "Lin, a new Muggle-born student from Shanghai, nervously asked Harry Potter for directions to the Gryffindor common room." },
        } },
        "MB Harry — fact clips (EN)": { entries: {
          "mb-fact-home": { uid: "mb-fact-home", content: "Lin's home city is Shanghai, China." },
          "1": { uid: 1, content: "用户自己写的" },
        } },
        "MB Harry — role lock (EN)": { entries: {
          "mb-role-shared-lin": { uid: "mb-role-shared-lin", content: "Lin is a new student at Hogwarts who grew up in Shanghai, China." },
          "mb-role-timeline": { uid: "mb-role-timeline", content: "乌姆里奇上任，魔法部否认去年夏天的事。" },
        } },
        "我自己的书": { entries: { 0: { uid: 0, content: "Lin's home city is Shanghai, China." } } },
      },
      deleted: [],
      async getWorld(name) { return this.data[name] || null; },
      async putWorld(name, value) { this.data[name] = value; },
      async deleteWorld(name) { this.deleted.push(name); delete this.data[name]; },
    };
    const report = await Cleanup.cleanupSampleMemories(store);
    assert.equal(report.removed, 3, "应当清掉 3 条示例，实际 " + report.removed);
    assert.deepEqual(store.deleted, ["MB Harry — scene memories (EN)"], "整本都是示例的书应当删掉");
    assert.deepEqual(Object.keys(store.data["MB Harry — fact clips (EN)"].entries), ["1"], "用户条目要留下");
    assert.deepEqual(Object.keys(store.data["MB Harry — role lock (EN)"].entries), ["mb-role-timeline"], "世界观设定那条要留");
    assert.ok(store.data["我自己的书"], "表里没登记的书一律不碰（哪怕正文里也写着同样的话）");
    const again = await Cleanup.cleanupSampleMemories(store);
    assert.equal(again.removed, 0, "再跑一次不该再删任何东西");
  });

  await test("体验卡：三种粘贴形式都认（卡号 / 卡号@中转 / 整条链接）", () => {
    // 同学那边的门槛要尽量低：发卡人给什么，他就粘什么。
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    const bare = Card.parseCardInput("RW-0AA71-B79FC-DCB79");
    assert.equal(bare.ok, true);
    assert.equal(bare.token, "RW-0AA71-B79FC-DCB79");
    assert.equal(bare.relay, "", "只给卡号时不该编一个中转地址出来");

    const withRelay = Card.parseCardInput("RW-0AA71-B79FC-DCB79@https://relay.example.com/");
    assert.equal(withRelay.ok, true);
    assert.equal(withRelay.relay, "https://relay.example.com", "末尾斜杠要去掉");

    const link = Card.parseCardInput("https://app.example.com/index.html#card=RW-0AA71-B79FC-DCB79%40https%3A%2F%2Frelay.example.com");
    assert.equal(link.ok, true, "整条链接要能解析：" + JSON.stringify(link));
    assert.equal(link.token, "RW-0AA71-B79FC-DCB79");
    assert.equal(link.relay, "https://relay.example.com");
    assert.equal(Card.endpointFor(link.relay), "https://relay.example.com/v1/chat/completions");

    const bad = Card.parseCardInput("我这就把卡号发你");
    assert.equal(bad.ok, false);
    assert.ok(bad.message.indexOf("RW-") >= 0, "错误提示要给出正确格式：" + bad.message);
    assert.equal(Card.parseCardInput("").ok, false);
  });

  await test("体验卡：新设备只粘卡号会被挡住，并说清「要带上中转地址」", async () => {
    // 2026-09-12 用户实测：「为什么我登的时候还是要输 apikey」。
    // 第二台设备 / 换浏览器时本机并不知道中转地址，而发卡文案当时只给了卡号 —— 照着做必然失败。
    // 这条用例把两头都钉住：① 应用侧的报错要说清缺什么、给出能直接粘贴的形式；
    // ② 发卡文案必须直接给「卡号@中转地址」那一整行。
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    const previous = globalThis.RoleWorld;
    globalThis.RoleWorld = {
      getLocalSettings: async () => ({ card_relay: "", provider: "deepseek" }),
      saveLocalSettings: async () => ({}),
    };
    try {
      const result = await Card.apply("RW-0AA71-B79FC-DCB79");
      assert.equal(result.ok, false, "没有中转地址却当成功了");
      assert.ok(result.message.indexOf("中转地址") >= 0, "没说清缺什么：" + result.message);
      assert.ok(result.message.indexOf("RW-XXXXX-XXXXX-XXXXX@") >= 0, "要给能直接粘贴的形式：" + result.message);
    } finally {
      if (previous === undefined) delete globalThis.RoleWorld;
      else globalThis.RoleWorld = previous;
    }

    // 发卡文案是同学唯一会照着做的东西 —— 静态检查它必须给"可直接粘贴的那一行"。
    // 0.1.30 起这份文案抽到 relay/card-text.js（CLI 与控制台共用同一份，免得两边写歪）。
    // 2026-09-16：文案改过一轮 —— **不再给一键链接**（那条链接会先撞腾讯云的「测试域名风险提醒」页），
    //   改成"卡号 + 中转地址 + 三步说明"。所以这里钉的也换成新的三样：
    //   ① 有一整行可粘贴的形式；② 明说中转地址要填；③ 有"打开网址之后怎么填"的步骤。
    const text = fs.readFileSync(path.join(__dirname, "..", "relay", "card-text.js"), "utf8");
    assert.ok(/function pasteLine\(token,\s*options\)/.test(text), "card-text 里应当有「可直接粘贴的那一行」");
    const sharePart = text.split("function shareText")[1] || "";
    assert.ok(/pasteLine\(token/.test(sharePart), "发卡文案没有把那一整行放进去");
    assert.ok(sharePart.indexOf("中转地址") >= 0, "发卡文案要说明新设备必须带中转地址（否则照着做必然失败）");
    assert.ok(sharePart.indexOf("卡号：") >= 0 && sharePart.indexOf("怎么用") >= 0,
      "发卡文案要给「卡号 + 怎么用」这两样（同学照着做的东西）");
    // CLI 与控制台都必须用这一份，不许各写一份。
    const cli = fs.readFileSync(path.join(__dirname, "..", "scripts", "card-cli.cjs"), "utf8");
    assert.ok(cli.indexOf('relay", "card-text.js"') >= 0, "card-cli 没用共用文案");
    const consoleServer = fs.readFileSync(path.join(__dirname, "..", "scripts", "console.cjs"), "utf8");
    assert.ok(consoleServer.indexOf('relay", "card-text.js"') >= 0, "控制台没用共用文案");
  });

  await test("体验卡：认得出本机正在用的是卡号（而不是普通 API Key）", () => {
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    assert.equal(Card.looksLikeCard("RW-0AA71-B79FC-DCB79"), true);
    assert.equal(Card.looksLikeCard("sk-1234567890abcdef"), false);
    assert.equal(Card.looksLikeCard(""), false);
  });

  await test("体验卡：额度翻成人话（次数 / token / 到期）", () => {
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    const text = Card.formatQuota({ ok: true, callsLeft: 12, tokensLeft: 4980, expiresAt: "2026-10-12T11:21:59.750Z" });
    assert.ok(text.indexOf("剩 12 次") >= 0, text);
    assert.ok(text.indexOf("剩 4980 token") >= 0, text);
    assert.ok(text.indexOf("到期 2026-10-12") >= 0, text);
    assert.ok(Card.formatQuota({ ok: true, callsLeft: 3 }).indexOf("不过期") >= 0);
    assert.ok(Card.formatQuota({ ok: false, message: "中转没回应" }).indexOf("中转没回应") >= 0);
  });

  await test("体验卡：顶栏徽标文案与颜色档（剩几次要一眼看见）", () => {
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    const state = { active: true };
    assert.equal(Card.chipText(state, { ok: true, callsLeft: 12 }), "体验卡 · 剩 12 次");
    assert.equal(Card.chipText(state, { ok: true, callsLeft: 2 }), "体验卡 · 只剩 2 次");
    assert.equal(Card.chipText(state, { ok: true, callsLeft: 0 }), "体验卡 · 次数已用完");
    assert.equal(Card.chipText(state, { ok: true, callsLeft: null }), "体验卡 · 不限次");
    assert.equal(Card.chipText({ active: false }, null), "", "没在用体验卡就不该有文案");
    assert.equal(Card.chipLevel(state, { ok: true, callsLeft: 12 }), "ok");
    assert.equal(Card.chipLevel(state, { ok: true, callsLeft: 2 }), "warn");
    assert.equal(Card.chipLevel(state, { ok: true, callsLeft: 0 }), "bad");
    assert.equal(Card.chipLevel({ active: false }, null), "off");
  });

  await test("体验卡：从响应头刷新剩余次数（中转每轮都回，不用额外请求）", () => {
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    const headers = new Headers({
      "x-rw-card-calls-left": "3",
      "x-rw-card-tokens-left": "4800",
      "x-rw-card-expires": "2026-10-12T00:00:00.000Z",
      "x-rw-card-id": "abc",
    });
    const quota = Card.noteQuotaFromHeaders(headers);
    assert.equal(quota.callsLeft, 3);
    assert.equal(quota.tokensLeft, 4800);
    assert.equal(quota.expiresAt, "2026-10-12T00:00:00.000Z");
    assert.equal(Card.knownQuota().callsLeft, 3);
    // 普通 API Key 的响应没有这些头：不能瞎猜，返回 null 并保持原值。
    assert.equal(Card.noteQuotaFromHeaders(new Headers({ "content-type": "application/json" })), null);
    assert.equal(Card.knownQuota().callsLeft, 3);
    // 不限次 / 不过期要能识别，别显示成"剩 null 次"。
    const unlimited = Card.noteQuotaFromHeaders(new Headers({ "x-rw-card-calls-left": "unlimited", "x-rw-card-expires": "never" }));
    assert.equal(unlimited.callsLeft, null);
    assert.equal(unlimited.expiresAt, null);
    assert.equal(Card.chipText({ active: true }, unlimited), "体验卡 · 不限次");
  });

  await test("体验卡：402/401 的错误翻成人话，普通错误不冒充体验卡问题", () => {
    const Card = require(path.join(__dirname, "..", "app", "adapter", "card.js"));
    const noCalls = Card.describeCardError(402, { error: { code: "CARD_NO_CALLS", message: "这张体验卡的次数用完了（上限 20 次）。" } });
    assert.ok(noCalls.indexOf("次数用完了") >= 0, noCalls);
    assert.ok(noCalls.indexOf("换一张") >= 0, "要告诉用户怎么办：" + noCalls);
    const unknown = Card.describeCardError(401, { error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识。" } });
    assert.ok(unknown.indexOf("不认识") >= 0, unknown);
    assert.equal(Card.describeCardError(500, { error: { code: "UPSTREAM_UNREACHABLE", message: "连不上模型服务" } }), null);
    assert.equal(Card.describeCardError(200, null), null);
  });

  await test("角色语言：默认跟角色卡自己，中文/英文是可开启的选项，且每个角色单独可设", () => {
    // 用户 2026-09-12 定的两句话：
    //   「应该是可以开启强制全部中文，默认应该是角色自身的语言」
    //   「或者说要不每个角色都弄一个语言开关选项？」
    const Core22 = require(path.join(__dirname, "..", "app", "task22-core.js"));
    const enCard = { name: "Harry", description: "Boy.", personality: "", scenario: "", language: "en" };
    const zhCard = { name: "小明", description: "学生。", personality: "", scenario: "", language: "zh" };
    const noLangCard = { name: "无名", description: "?", personality: "", scenario: "" };

    // ① 默认（什么都不设）：按角色卡自己写的语言说话 —— 英文卡要英文、中文卡要中文。
    assert.ok(Core22.buildSystemPrompt(enCard, [], "你好", {}).indexOf("English only") >= 0, "默认应当按角色卡说英文");
    assert.equal(Core22.buildSystemPrompt(enCard, [], "你好", {}).indexOf("一律用简体中文回复"), -1, "默认不该强制中文");
    assert.ok(Core22.buildSystemPrompt(zhCard, [], "你好", {}).indexOf("这个角色说简体中文") >= 0, "中文卡应当要求中文");
    assert.equal(Core22.buildSystemPrompt(noLangCard, [], "你好", {}).indexOf("[Language]"), -1,
      "角色卡没写语言就不加语言约束（跟着玩家说）");

    // ② 一律中文：压过角色卡 —— 这就是"有些人看不懂英文"那条路。
    const zhLine = Core22.languageLine(enCard, { language: "zh" });
    assert.ok(zhLine.indexOf("一律用简体中文回复") >= 0, "没给出全中文要求：" + zhLine);
    assert.ok(zhLine.indexOf("English only") < 0, "开着全中文就不该再要求说英文");
    assert.ok(zhLine.indexOf("先用中文把上一条的意思重说一遍") >= 0, "英文开场白也要被翻过来：" + zhLine);
    assert.ok(zhLine.indexOf("Hard requirement") >= 0, "要有一句英文硬要求兜底（整段历史是英文时更管用）");
    // 一律英文是对称的一条（中文卡也能被要求说英文）。
    const enLine = Core22.languageLine(zhCard, { language: "en" });
    assert.ok(enLine.indexOf("一律用英文回复") >= 0, "没有一律英文的要求：" + enLine);
    assert.ok(enLine.indexOf("English only") >= 0, "一律英文里要有一句英文硬要求：" + enLine);
    assert.ok(enLine.indexOf("一律用简体中文回复") < 0, "强制英文时不该再要求中文");

    // ③ 语言要求**两头都要有**（中间一处 + 格式指令之后再一处）：
    //    只留一处实测会漏（"旁白英文、台词中文"）。
    const withFormat = Core22.buildSystemPromptWithFormat(enCard, [], "你好", null, { language: "zh" });
    assert.ok(withFormat.split("一律用简体中文回复").length - 1 >= 2, "全中文要求应当出现两次：" + withFormat.slice(-200));
    assert.ok(withFormat.lastIndexOf("一律用简体中文回复") > withFormat.indexOf(Core22.REPLY_FORMAT_INSTRUCTION),
      "结尾那处必须在格式指令之后，否则会被盖过去");

    // ④ 第三处：紧贴用户这句话之前的一条系统提醒 —— **只在玩家自己选了语言时**才插。
    //    整段历史都是英文时，只靠最前面那句压不住（用户 2026-09-12 连着两次反馈"还是英文"）。
    const messages = Core22.buildGeneratePayload({
      card: enCard, memoryBooks: [], history: [{ is_user: false, mes: "Harry stares at you." }],
      userText: "在吗", engine: "A", mode: "local", settings: {}, language: "zh",
    }).messages;
    assert.equal(messages[messages.length - 1].role, "user", "最后一条应当是用户这句话");
    assert.equal(messages[messages.length - 2].role, "system", "用户这句话之前应当有一条语言提醒");
    assert.ok(messages[messages.length - 2].content.indexOf("必须用简体中文回复") >= 0,
      "语言提醒内容不对：" + messages[messages.length - 2].content);
    const enMessages = Core22.buildGeneratePayload({
      card: zhCard, memoryBooks: [], history: [], userText: "在吗", engine: "A", mode: "local", settings: {}, language: "en",
    }).messages;
    assert.ok(enMessages[enMessages.length - 2].content.indexOf("必须用英文回复") >= 0,
      "一律英文时也该贴一条英文提醒：" + JSON.stringify(enMessages[enMessages.length - 2]));
    // 默认（跟着角色卡）不多这条消息：既然按角色卡说话，就没有要压的东西。
    const byCard = Core22.buildGeneratePayload({
      card: enCard, memoryBooks: [], history: [], userText: "在吗", engine: "A", mode: "local", settings: {},
    }).messages;
    assert.equal(byCard.length, 2, "默认不该多出语言提醒：" + byCard.length);

    // ⑤ 老调用点（0.1.24~0.1.26 的布尔 fullChinese）继续可用，等价于"一律中文"。
    assert.ok(Core22.languageLine(enCard, { fullChinese: true }).indexOf("一律用简体中文回复") >= 0);
    assert.ok(Core22.buildSystemPrompt(enCard, [], "你好", { fullChinese: false }).indexOf("English only") >= 0,
      "老调用点传 false 时保持原行为");

    // ⑥ 两级设置：**单个角色的设置压过全局默认** —— "每个角色一个语言开关"就是这一条。
    const mixed = { language_mode: "auto", language_by_card: { "Harry Potter (EN).png": "zh" } };
    assert.equal(Core22.languageFromSettings(mixed, "Harry Potter (EN).png"), "zh", "单角色设置没生效");
    assert.equal(Core22.languageFromSettings(mixed, "Hermione Granger (EN).png"), null, "没设过的角色应当按角色卡来");
    assert.equal(Core22.languageFromSettings({ language_mode: "zh" }, "Harry Potter (EN).png"), "zh", "全局默认没生效");
    assert.equal(Core22.languageFromSettings({ language_mode: "zh", language_by_card: { "Harry Potter (EN).png": "en" } },
      "Harry Potter (EN).png"), "en", "单角色设置应当压过全局");
    assert.equal(Core22.languageFromSettings({ language_mode: "auto", language_by_card: { "x.png": "auto" } }, "x.png"), null,
      "单角色选「跟随设置」时应当落回全局/角色卡");
    assert.equal(Core22.languageFromSettings({}, "x.png"), null, "什么都没有时 = 不强制（默认）");
  });

  await test("界面里没有账号相关的入口或文案（产品里已经没有账号）", () => {
    // 2026-09-12：清理过一次账号死代码（注销/改密/改名/管理员账号列表）。
    // 这条守着一件事：别再让它们长回来。
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
    const appJs = fs.readFileSync(path.join(root, "app", "app.js"), "utf8");
    const banned = ["退出登录", "注销账户", "重置密码", "修改密钥", "账号管理", "新建账号", "登录密钥"];
    for (const word of banned) {
      assert.ok(html.indexOf(word) < 0, "index.html 里还有账号文案：「" + word + "」");
      assert.ok(appJs.indexOf(word) < 0, "app.js 里还有账号文案：「" + word + "」");
    }
    const bannedIds = ["logoutDialog", "passwordDialog", "renameDialog", "adminCreateDialog", "adminDeleteDialog", "selfDeleteDialog", "adminUsersList"];
    for (const id of bannedIds) {
      assert.ok(html.indexOf('id="' + id + '"') < 0, "index.html 里还有账号对话框：" + id);
    }
    const bannedFns = ["openLogoutDialog", "confirmPassword", "refreshAdminUsers", "promoteUser", "openSelfDeleteDialog", "setAdminMenuVisible"];
    for (const fn of bannedFns) {
      assert.ok(appJs.indexOf(fn) < 0, "app.js 里还有账号逻辑：" + fn);
    }
    // 保留的是"本地档案"这套：没有密码、不同步。别把这段也一起删了。
    assert.ok(html.indexOf("不是账号") >= 0, "关于页应当说明本地档案不是账号");
    assert.ok(appJs.indexOf("setUserContext") >= 0, "本地档案的读取路径不该被删掉");
  });

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

  await test("仓库文本文件是合法 UTF-8（不乱码）", () => {
    // 真发生过：用 PowerShell 的 Add-Content -Encoding UTF8 追加中文 CSS 注释，
    // 结果那一整段被写成 GBK，文件里混进 153 处非法字节 —— 浏览器把中文注释全变成乱码，
    // 而且编辑器打不开这个文件。BOM 检查抓不到这种，必须逐个字节校验编码。
    const skip = new Set([".git", "node_modules", "target", "gen", "packs", "build"]);
    const exts = [".json", ".js", ".cjs", ".html", ".css", ".yml", ".yaml", ".toml", ".rs", ".md", ".txt"];
    // 没有扩展名但一样是文本、一样会被写坏的根文件（2026-09-12：`.gitignore` 末尾那段
    // 中文注释就是 GBK 坏字节，正因为扩展名不在名单里而漏过了这条守卫）。
    const names = new Set([".gitignore", ".gitattributes", ".editorconfig", ".npmrc"]);
    const offenders = [];
    let checked = 0;

    const invalidOffset = (buffer) => {
      let i = 0;
      while (i < buffer.length) {
        const byte = buffer[i];
        if (byte < 0x80) { i += 1; continue; }
        const need = (byte & 0xe0) === 0xc0 ? 1 : (byte & 0xf0) === 0xe0 ? 2 : (byte & 0xf8) === 0xf0 ? 3 : -1;
        if (need < 0 || i + need >= buffer.length) return i;
        for (let k = 1; k <= need; k += 1) if ((buffer[i + k] & 0xc0) !== 0x80) return i;
        i += need + 1;
      }
      return -1;
    };

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
          continue;
        }
        if (!exts.includes(path.extname(entry.name).toLowerCase()) && !names.has(entry.name)) continue;
        // ⚠ 按字节保留的**受损原件**不参与这条断言：`*.pre-replace-*.cjs` 是历史上那个坏掉的
        //   测试文件（用户明确要求留档），它本来就不是合法 UTF-8 —— 扫它只会得到一个假的失败。
        if (/\.pre-replace-[0-9]+\.cjs$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        const buffer = fs.readFileSync(file);
        checked += 1;
        const bad = invalidOffset(buffer);
        if (bad >= 0) {
          offenders.push(path.relative(path.join(__dirname, ".."), file) + "（偏移 " + bad + "）");
        }
      }
    };
    walk(path.join(__dirname, ".."));
    assert.ok(checked >= 20, "扫描到的文本文件太少，检查可能失效：" + checked);
    assert.deepEqual(offenders, [], "这些文件不是合法 UTF-8：" + offenders.join(", "));
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

  await test("DeepSeek 正式模型名用于对话，旧别名仍可兼容", () => {
    assert.equal(Core22.CHAT_MODES.DEEPSEEK_FLASH, "deepseek-flash");
    assert.ok(Core22.DEEPSEEK_CHAT_MODES.includes("deepseek-flash"));
    assert.ok(!Core22.DEEPSEEK_CHAT_MODES.includes("deepseek-v4-flash"), "旧型号不应再作为可选项");
    assert.ok(Core22.isDeepSeekChatMode("deepseek-v4-flash"), "旧型号应仍能识别为 DeepSeek 请求");
    const payload = Core22.buildGeneratePayload({
      mode: Core22.CHAT_MODES.DEEPSEEK_FLASH,
      card: { name: "甲", description: "角色" },
      memoryBooks: [],
      history: [],
      userText: "你好",
      stream: true,
    });
    assert.equal(payload.model, "deepseek-flash");
    assert.equal(payload.chat_completion_source, "deepseek");
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

  await test("生成中途被按停：半截的记忆标记不会被当成正文", () => {
    // 用户可能在模型刚打出 `[[记住:` 的时候按停止键，这时标记是断的。
    const samples = [
      "他把书合上。\n[[记住",
      "他把书合上。\n[[记住:",
      "他把书合上。\n[[记住: 玩家叫小林",
      "他把书合上。\n【记住：玩家叫小林",
    ];
    for (const sample of samples) {
      const visible = Core22.stripPartialMemoryMarkers(sample);
      assert.equal(visible, "他把书合上。", "半截标记没清掉：" + JSON.stringify(visible));
      const parsed = Core22.extractMemory(sample);
      assert.equal(parsed.text, "他把书合上。", "半截标记进了要保存的正文：" + JSON.stringify(parsed.text));
      assert.deepEqual(parsed.memories, [], "半截标记被当成了记忆要点：" + JSON.stringify(parsed.memories));
    }
  });

  await test("半截标记拦不住完整标记：完整的照收，半截的丢掉", () => {
    const raw = "他把书合上。\n[[记住: 玩家叫小林]]\n[[记住: 玩家怕黑";
    assert.equal(Core22.stripPartialMemoryMarkers(raw).indexOf("怕黑"), -1, "半截那条还在显示文本里");
    const parsed = Core22.extractMemory(raw);
    assert.equal(parsed.text, "他把书合上。");
    assert.deepEqual(parsed.memories, ["玩家叫小林"], "完整那一条应当照收：" + JSON.stringify(parsed.memories));
  });

  await test("没有半截标记时，strip 不改动原文", () => {
    const raw = "他把书合上。\n\n“明天见。”";
    assert.equal(Core22.stripPartialMemoryMarkers(raw), raw);
    assert.equal(Core22.stripPartialMemoryMarkers(""), "");
    assert.equal(Core22.stripPartialMemoryMarkers(null), "");
  });

  console.log("== 角色语言约束 ==");

  await test("语言标记：CCv3 嵌套与顶层两种写法都认", () => {
    assert.equal(Core22.cardLanguageOf({ data: { extensions: { task29: { language: "en" } } } }), "en");
    assert.equal(Core22.cardLanguageOf({ data: { extensions: { task29: { language: "zh" } } } }), "zh");
    assert.equal(Core22.cardLanguageOf({ language: "en" }), "en");
    assert.equal(Core22.cardLanguageOf({ language: "zh-cn" }), "zh");
    assert.equal(Core22.cardLanguageOf({ language: "english" }), "en");
    assert.equal(Core22.cardLanguageOf({}), null);
    assert.equal(Core22.cardLanguageOf(null), null);
  });

  await test("英文卡：写明即使用中文提问也用英文回答（实测踩过的坑）", () => {
    const card = { name: "Harry", description: "d", data: { extensions: { task29: { language: "en" } } } };
    const prompt = Core22.buildSystemPrompt(card, [], "你好", {});
    assert.ok(prompt.indexOf("[Language]") >= 0, "没有语言约束：" + prompt.slice(0, 200));
    assert.ok(/English only/.test(prompt), "没有说明只说英文");
    assert.ok(/even when the player writes/i.test(prompt), "没有说明玩家用别的语言时也要说英文");
    assert.ok(/Never switch languages/i.test(prompt), "没有禁止跟着玩家切语言");
  });

  await test("中文卡：同样不许跟着玩家切语言", () => {
    const card = { name: "小明", description: "d", data: { extensions: { task29: { language: "zh" } } } };
    const prompt = Core22.buildSystemPrompt(card, [], "hello", {});
    assert.ok(prompt.indexOf("一律使用中文") >= 0 || prompt.indexOf("用中文回答") >= 0, "没有中文约束");
    assert.ok(prompt.indexOf("切换语言") >= 0, "没有禁止跟着玩家切语言");
  });

  await test("语言要求钉在系统提示的最后（格式指令之后）", () => {
    // 实测症状：只写在中间时，模型"旁白英文、台词中文" —— 被最后的格式指令盖过去了。
    const card = { name: "Harry", description: "d", data: { extensions: { task29: { language: "en" } } } };
    const prompt = Core22.buildSystemPromptWithFormat(card, [], "你好", null, {});
    const lines = prompt.split("\n").filter((line) => line.trim());
    assert.ok(/^\[Language\]/.test(lines[lines.length - 1]),
      "最后一条规则应当是语言要求，实际是：" + JSON.stringify(lines[lines.length - 1].slice(0, 60)));
    assert.ok(prompt.indexOf("[Reply format]") < prompt.lastIndexOf("[Language]"),
      "语言要求必须排在回复格式之后");
    // 两头都要有：开头是身份级约束，结尾是"最后一条规则"。
    assert.ok(/^\[Language\]/.test(lines[0]), "开头没有语言要求：" + JSON.stringify(lines[0].slice(0, 40)));
    assert.ok((prompt.match(/\[Language\]/g) || []).length >= 3,
      "语言要求应当出现在开头、中间、结尾三处，实际 " +
      (prompt.match(/\[Language\]/g) || []).length + " 处");
  });

  await test("没设语言的卡不硬塞语言约束", () => {
    const card = { name: "X", description: "d", data: {} };
    assert.equal(Core22.buildSystemPrompt(card, [], "你好", {}).indexOf("[Language]"), -1, "没设语言却塞了语言要求");
    assert.equal(Core22.buildSystemPromptWithFormat(card, [], "你好", null, {}).indexOf("[Language]"), -1,
      "带格式的完整系统提示里也不该有语言要求");
    assert.equal(Core22.languageLine(card), "");
  });

  console.log("== 旧对话的 token 预算 ==");

  const manyMessages = (count, length) => Array.from({ length: count }, (_, i) => ({
    is_user: i % 2 === 0,
    mes: "第" + i + "条：" + "字".repeat(length),
  }));

  await test("预算够时全部保留，不截断", () => {
    const plan = Core22.planHistory(manyMessages(20, 10), { budget: 60000 });
    assert.equal(plan.kept.length, 20);
    assert.equal(plan.dropped, 0);
    assert.equal(plan.truncated, false);
    assert.equal(plan.keptTokens, plan.totalTokens);
  });

  await test("超出预算时从最近往前保留，并报告丢了几条", () => {
    const plan = Core22.planHistory(manyMessages(200, 100), { budget: 3000, minMessages: 4 });
    assert.ok(plan.kept.length < 200 && plan.kept.length > 4, "保留条数不合理：" + plan.kept.length);
    assert.equal(plan.dropped, 200 - plan.kept.length);
    assert.ok(plan.keptTokens <= 3000, "超预算了：" + plan.keptTokens);
    assert.equal(plan.truncated, true);
    // 保留的必须是最后那一段（最近的），顺序不变
    assert.equal(plan.kept[plan.kept.length - 1].mes, "第199条：" + "字".repeat(100));
    assert.equal(plan.kept[0].mes, "第" + plan.dropped + "条：" + "字".repeat(100));
  });

  await test("预算再紧也至少留最近几条，不会一条都不带", () => {
    const plan = Core22.planHistory(manyMessages(50, 100), { budget: 1, minMessages: 4 });
    assert.equal(plan.kept.length, 4, "至少保留最近 4 条，实际 " + plan.kept.length);
    assert.equal(plan.dropped, 46);
  });

  await test("空历史与脏数据不炸", () => {
    assert.deepEqual(Core22.planHistory([], {}).kept, []);
    assert.equal(Core22.planHistory(null, {}).dropped, 0);
    const dirty = [{ mes: "有效" }, null, { mes: "" }, { mes: 123 }, undefined];
    const plan = Core22.planHistory(dirty, { budget: 60000 });
    assert.equal(plan.kept.length, 1, "只应保留 mes 是字符串且非空的那条");
  });

  await test("默认不限制：不填预算就全部带上，不丢内容", () => {
    const many = manyMessages(500, 50);
    const plan = Core22.planHistory(many, {});
    assert.equal(plan.kept.length, 500, "默认应当全带，实际 " + plan.kept.length);
    assert.equal(plan.dropped, 0);
    assert.equal(plan.truncated, false);
    assert.equal(plan.unlimited, true);
    assert.equal(Core22.planHistory(many, { budget: 0 }).kept.length, 500, "预算 0 也应当是不限制");
    assert.equal(Core22.planHistory(many, { budget: -5 }).kept.length, 500, "负数视为没设");
    assert.equal(Core22.HISTORY_TOKEN_BUDGET, 0, "默认预算应为 0（不限制）");
  });

  await test("用户自己填了上限才截断", () => {
    const plan = Core22.planHistory(manyMessages(500, 50), { budget: 3000 });
    assert.ok(plan.kept.length < 500, "填了上限就该截断");
    assert.ok(plan.keptTokens <= 3000);
    assert.equal(plan.unlimited, false);
    assert.equal(plan.truncated, true);
  });

  console.log("== 用途档案：不同模式该有不同的默认 ==");

  await test("三种用途各有档案，数字只在核心层定义一处", () => {
    assert.deepEqual(Core22.PURPOSE_IDS.slice().sort(), ["chat", "companion", "scene"]);
    const chat = Core22.resolveProfile("chat");
    const companion = Core22.resolveProfile("companion");
    const scene = Core22.resolveProfile("scene");
    assert.equal(chat.replyFormat, "dialogue");
    // 2026-09-12 用户：「伴侣模式直接取消渲染，不要加入动作，就是纯对话」——
    // 所以它不再沿用对话页那套"旁白/台词"约定，而是"只说话"。
    assert.equal(companion.replyFormat, "plain", "伴侣模式应当是纯对话（不写旁白与动作）");
    assert.ok(/Just talk/.test(Core22.PLAIN_FORMAT_INSTRUCTION), "纯对话那条约定没有说明「只说话」");
    assert.ok(/no narration/i.test(Core22.PLAIN_FORMAT_INSTRUCTION), "纯对话那条要明写不要旁白");
    assert.ok(/no action/i.test(Core22.PLAIN_FORMAT_INSTRUCTION), "纯对话那条要明写不要动作描写");
    // 而且真的会用到提示词里（不是只定义不接线）。
    const companionPrompt = Core22.buildSystemPromptWithFormat({ name: "X", description: "d" }, [], "在吗", null, { purpose: "companion" });
    assert.ok(companionPrompt.indexOf("Just talk") >= 0, "伴侣模式的提示词里没有用纯对话约定");
    assert.ok(companionPrompt.indexOf("NARRATION") < 0, "伴侣模式不该再带「旁白/台词」那套格式指令");
    assert.equal(scene.replyFormat, "scene", "剧情模式页要用多角色那一套");
    assert.equal(chat.autoSearch, true);
    assert.equal(scene.autoSearch, false, "剧情页不该自动翻旧对话（它有自己的场景历史）");
    // 没见过的用途一律当 chat，不炸
    assert.equal(Core22.normalizePurpose("nope"), "chat");
    assert.equal(Core22.resolveProfile("nope").replyFormat, "dialogue");
  });

  await test("用途档案不能凭空加字段（防止页面各写各的）", () => {
    const patched = Core22.resolveProfile("chat", { temperature: 0.2, 乱加的字段: 1 });
    assert.equal(patched.temperature, 0.2);
    assert.equal(patched["乱加的字段"], undefined, "表里没有的键不该被塞进来");
    assert.equal(patched.topP, Core22.PURPOSE_PROFILES.chat.topP, "没覆盖的项保持表里的值");
  });

  await test("输出上限：用途与渠道一起决定；目前三种用途都不硬压", () => {
    assert.equal(Core22.outputLimitFor("deepseek-flash", "chat"), 32768);
    assert.equal(Core22.outputLimitFor("deepseek-flash", "scene"), 32768,
      "用户明确否掉了按模式硬压输出：剧情页靠提示词约束 + 记录实测，不靠截断");
    assert.equal(Core22.outputLimitFor("local", "companion"), 2048);
    // 表里留了 maxOutput 这个口子：以后有数据了加上去，只改一处。
    assert.equal(Core22.PURPOSE_PROFILES.scene.maxOutput, undefined);
  });

  await test("剧情模式页的提示词：只写自己这一小段，不替别人说话", () => {
    const card = { name: "Harry", description: "被选中的男孩。", personality: "勇敢", scenario: "霍格沃茨" };
    const scenePrompt = Core22.buildSystemPromptWithFormat(card, [], "这一幕", null, { purpose: "scene" });
    assert.ok(scenePrompt.indexOf(Core22.SCENE_FORMAT_INSTRUCTION) >= 0, "缺剧情页的输出约定");
    assert.ok(scenePrompt.indexOf("Do NOT speak, act, or decide for any other character") >= 0,
      "必须明确禁止替别的角色说话");
    assert.ok(scenePrompt.indexOf("Do NOT recap") >= 0, "必须禁止复述刚发生的事");
    const chatPrompt = Core22.buildSystemPromptWithFormat(card, [], "这句话", null, { purpose: "chat" });
    assert.ok(chatPrompt.indexOf(Core22.REPLY_FORMAT_INSTRUCTION) >= 0, "对话页仍用旁白/台词那套");
    assert.ok(chatPrompt.indexOf(Core22.SCENE_FORMAT_INSTRUCTION) < 0, "对话页不该带上剧情页的约定");
    // 采样口味按用途走（同一张表）
    const payload = Core22.buildGeneratePayload({
      card, memoryBooks: [], history: [], userText: "你好",
      mode: "deepseek-flash", modelName: "deepseek-flash", engine: "A", purpose: "scene",
    });
    assert.equal(payload.temperature, Core22.PURPOSE_PROFILES.scene.temperature);
    assert.ok(payload.messages[0].content.indexOf(Core22.SCENE_FORMAT_INSTRUCTION) >= 0,
      "请求体里的系统提示也应当是剧情页那一套");
  });

  await test("剧情类记忆在注入时会带上 [剧情] 前缀", () => {
    const card = { name: "Harry", description: "男孩。", personality: "", scenario: "" };
    const books = [{ name: "MB Harry — 自动记忆", entries: [
      { uid: 1, content: "玩家住在杭州", constant: true, rw_source: { kind: "fact" } },
      { uid: 2, content: "他拔出魔杖", constant: true, rw_source: { kind: "story" } },
    ] }];
    const prompt = Core22.buildSystemPrompt(card, books, "", {});
    assert.ok(prompt.indexOf("[1] 玩家住在杭州") >= 0, "事实条目原样注入");
    assert.ok(prompt.indexOf("[2] [剧情] 他拔出魔杖") >= 0,
      "剧情条目必须标明，否则模型会把它当成玩家的事实：" + JSON.stringify(prompt.slice(-260)));
  });

  await test("事件类记忆在注入时会带上 [此前发生] 前缀", () => {
    // 用户 2026-09-12：「我是要让哈利等小说人物记得之前发生了什么」。
    // 事件要记得，但绝不能和"关于你的事实"混为一谈。
    const card = { name: "Harry", description: "男孩。", personality: "", scenario: "" };
    const books = [{ name: "MB Harry — 自动记忆", entries: [
      { uid: 1, content: "玩家住在杭州", constant: true, rw_source: { kind: "fact" } },
      { uid: 2, content: "两人约好周六下午在球场学飞行", constant: true, rw_source: { kind: "event" } },
    ] }];
    const prompt = Core22.buildSystemPrompt(card, books, "", {});
    assert.ok(prompt.indexOf("[1] 玩家住在杭州") >= 0, "事实条目原样注入");
    assert.ok(prompt.indexOf("[2] [此前发生] 两人约好周六下午在球场学飞行") >= 0,
      "事件条目必须标明是「此前发生」：" + JSON.stringify(prompt.slice(-260)));
  });

  console.log("== 记忆标记：事实与事件 ==");

  await test("[[事件: …]] 作为事件解析，正文里不留标记", () => {
    const parsed = Core22.extractMemory("好，那就这么定了。\n[[事件: 两人约好周六下午在球场学飞行]]");
    assert.equal(parsed.topics.length, 1);
    assert.equal(parsed.topics[0].kind, "event", "应当标成事件：" + JSON.stringify(parsed.topics));
    assert.equal(parsed.topics[0].content, "两人约好周六下午在球场学飞行");
    assert.ok(parsed.text.indexOf("事件") < 0, "标记不该留在正文里：" + JSON.stringify(parsed.text));
    assert.equal(parsed.text, "好，那就这么定了。");
  });

  await test("把事件写进 [[记住: 事件 | …]] 也当事件（模型常这么写）", () => {
    const parsed = Core22.extractMemory("[[记住: 事件 | 他们上周末一起去了图书馆]]");
    assert.equal(parsed.topics[0].kind, "event");
    assert.equal(parsed.topics[0].content, "他们上周末一起去了图书馆");
  });

  await test("半截的 [[事件: 标记在流式阶段就被丢掉", () => {
    const partial = Core22.stripPartialMemoryMarkers("他点点头。\n[[事件: 两人约好周六");
    assert.equal(partial.trim(), "他点点头。", "半截标记不该当正文：" + JSON.stringify(partial));
    // 完整标记照常解析。
    assert.equal(Core22.extractMemory("[[事件: 完整的经过]]").topics.length, 1);
  });

  await test("事实最多 3 条、事件最多 2 条", () => {
    const text = [
      "[[记住: 称呼 | 玩家叫小林]]",
      "[[记住: 饮料 | 玩家喜欢咖啡]]",
      "[[记住: 住处 | 玩家住在杭州]]",
      "[[记住: 怕的 | 玩家怕高]]",
      "[[事件: 第一件事]]",
      "[[事件: 第二件事]]",
      "[[事件: 第三件事]]",
    ].join("\n");
    const parsed = Core22.extractMemory(text);
    const facts = parsed.topics.filter((row) => row.kind !== "event");
    const events = parsed.topics.filter((row) => row.kind === "event");
    assert.equal(facts.length, 3, "事实最多 3 条：" + JSON.stringify(parsed.topics));
    assert.equal(events.length, 2, "事件最多 2 条：" + JSON.stringify(parsed.topics));
  });

  await test("记忆指令：默认告诉模型可以记事件，并说明事件会标成「此前发生」", () => {
    const withEvents = Core22.memoryInstruction("Harry", { events: true });
    assert.ok(withEvents.indexOf("[[事件:") >= 0, "没告诉模型事件怎么写");
    assert.ok(withEvents.indexOf("此前发生") >= 0, "没说明事件注入时的标记");
    assert.ok(withEvents.indexOf("[[记住:") >= 0, "事实的写法不能丢");
    const without = Core22.memoryInstruction("Harry", { events: false });
    assert.equal(without.indexOf("[[事件:"), -1, "关掉事件记忆后不该再教模型写事件");
    assert.ok(without.indexOf("不要写进记忆") >= 0, "关掉时要明确说剧情不记");
    // 通过 buildSystemPrompt 传开关也要生效。
    const card = { name: "Harry", description: "男孩。", personality: "", scenario: "" };
    assert.ok(Core22.buildSystemPrompt(card, [], "你好", { autoMemory: true }).indexOf("[[事件:") >= 0);
    assert.equal(Core22.buildSystemPrompt(card, [], "你好", { autoMemory: true, autoEventMemory: false }).indexOf("[[事件:"), -1);
  });

  console.log("== 生成参数（预设 + 自己填）==");
  await test("默认跟随用途：三种用途各用各的温度", () => {
    const chat = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "chat" });
    const companion = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "companion" });
    const scene = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "scene" });
    assert.equal(chat.temperature, Core22.PURPOSE_PROFILES.chat.temperature);
    assert.equal(companion.temperature, Core22.PURPOSE_PROFILES.companion.temperature);
    assert.equal(scene.temperature, Core22.PURPOSE_PROFILES.scene.temperature);
    assert.ok(chat.source.indexOf("用途默认") >= 0, "应当说明值是从哪层来的：" + chat.source);
    assert.equal(chat.preset, "auto");
  });

  await test("预设：稳一点 / 活泼一点各有各的数", () => {
    const steady = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "chat", preset: "steady" });
    const lively = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "chat", preset: "lively" });
    assert.equal(steady.temperature, 0.6);
    assert.equal(steady.topP, 0.85);
    assert.equal(lively.temperature, 1.1);
    assert.equal(lively.topP, 0.95);
    assert.ok(steady.temperature < lively.temperature);
    // 没见过的预设按"跟随用途"，不炸也不静默改成别的
    assert.equal(Core22.normalizePreset("乱写"), "auto");
    assert.equal(Core22.resolveSampling({ mode: "deepseek-flash", preset: "乱写" }).preset, "auto");
  });

  await test("自己填：只在 manual 下生效，且会被夹到合法区间", () => {
    const manual = Core22.resolveSampling({
      mode: "deepseek-flash", purpose: "chat", preset: "manual", temperature: 1.4, topP: 0.5,
    });
    assert.equal(manual.temperature, 1.4);
    assert.equal(manual.topP, 0.5);
    assert.ok(manual.source.indexOf("自己填") >= 0);
    // 越界会被夹住，而不是原样塞进请求
    assert.equal(Core22.resolveSampling({ preset: "manual", temperature: 9 }).temperature, 2);
    assert.equal(Core22.resolveSampling({ preset: "manual", temperature: -3 }).temperature, 0);
    assert.equal(Core22.resolveSampling({ preset: "manual", topP: 0 }).topP, 0.01);
    assert.equal(Core22.resolveSampling({ preset: "manual", topP: 5 }).topP, 1);
    // 不是 manual 时，手填的数**不该**生效（否则旧版本存的 0.8/0.9 会把"跟随用途"钉死）
    const auto = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "companion", preset: "auto", temperature: 1.9 });
    assert.equal(auto.temperature, Core22.PURPOSE_PROFILES.companion.temperature);
  });

  await test("输出上限：留空用渠道默认，填了取小，越小越会被截断", () => {
    assert.equal(Core22.outputLimitFor("deepseek-flash", "chat"), 32768);
    assert.equal(Core22.outputLimitFor("deepseek-flash", "chat", 600), 600);
    assert.equal(Core22.outputLimitFor("local", "chat"), 2048, "本地渠道默认上限不变");
    assert.equal(Core22.outputLimitFor("local", "chat", 99999), 2048, "填得比渠道上限大也没用");
    assert.equal(Core22.outputLimitFor("deepseek-flash", "chat", 10), 64, "下限 64，免得只能说一个字");
    const picked = Core22.resolveSampling({ mode: "deepseek-flash", purpose: "chat", maxOutput: 800 });
    assert.equal(picked.maxOutput, 800);
    assert.ok(picked.outputSource.indexOf("自己填") >= 0, "输出上限的来源要说明：" + picked.outputSource);
  });

  await test("请求体里用的是算出来的那套数", () => {
    const card = { name: "Harry", description: "男孩。", personality: "", scenario: "" };
    const payload = Core22.buildGeneratePayload({
      card, memoryBooks: [], history: [], userText: "你好",
      mode: "deepseek-flash", modelName: "deepseek-flash", engine: "A",
      purpose: "companion", sampling: { preset: "steady" },
    });
    assert.equal(payload.temperature, 0.6);
    assert.equal(payload.top_p, 0.85);
    const payload2 = Core22.buildGeneratePayload({
      card, memoryBooks: [], history: [], userText: "你好",
      mode: "deepseek-flash", modelName: "deepseek-flash", engine: "A",
      purpose: "chat", sampling: { maxOutput: 500 },
    });
    assert.equal(payload2.max_tokens, 500);
    assert.equal(payload2.temperature, Core22.PURPOSE_PROFILES.chat.temperature, "没动预设就还是用途默认");
  });

  console.log("== 上下文上限 与 输出上限（分开算）==");

  await test("上下文与输出是两件事，各有各的值", () => {
    assert.equal(Core22.contextLimitFor("local"), 32768);
    assert.equal(Core22.contextLimitFor("deepseek-flash"), 1000000);
    assert.equal(Core22.contextLimitFor("deepseek-v4-pro"), 1000000);
    assert.equal(Core22.contextLimitFor("没见过的模型"), 32768, "不知道的模型按最小上下文保守估计");
    assert.equal(Core22.outputLimitFor("local"), 2048);
    assert.equal(Core22.outputLimitFor("deepseek-flash"), 32768);
  });

  await test("没超限就放行，并且算得出输入占了多少上下文", () => {
    const check = Core22.checkContextBudget({ inputTokens: 5000, mode: "deepseek-flash" });
    assert.equal(check.ok, true);
    assert.equal(check.context, 1000000);
    assert.equal(check.output, 32768);
    assert.equal(check.total, 37768);
    assert.equal(check.message, "", "放行时不该有提示语");
    assert.ok(check.ratio > 0 && check.ratio < 0.01);
  });

  await test("超限时给出可操作的说明，而不是一句「请重试」", () => {
    const check = Core22.checkContextBudget({ inputTokens: 40000, mode: "local" });
    assert.equal(check.ok, false, "输入 40000 + 输出 2048 已经超过 32768");
    assert.equal(check.total, 42048);
    assert.ok(check.message.indexOf("历史预算") >= 0, "应当告诉用户去哪儿调小：" + check.message);
    assert.ok(check.message.indexOf("32768") >= 0, "应当写出上限是多少：" + check.message);
  });

  await test("本地端点的上下文可以自己填，猜错了能改", () => {
    // 本地模型 8k / 32k / 128k 都有，按一个数字硬猜会误拦；所以允许覆盖。
    assert.equal(Core22.contextLimitFor("local", 131072), 131072);
    assert.equal(Core22.contextLimitFor("local", 2000), 2000);
    assert.equal(Core22.contextLimitFor("local", 100), 32768, "太小的值视为没填");
    assert.equal(Core22.contextLimitFor("local", "abc"), 32768);
    // 核心函数是"显式传了就用传的"；**要不要传是调用方的事** ——
    // 界面上只在本地/自定义端点才传（DeepSeek 官方固定 1M，用 32k 去套会让每次发送都被拦）。
    assert.equal(Core22.contextLimitFor("deepseek-flash", 8000), 8000);
    const tight = Core22.checkContextBudget({ inputTokens: 9000, mode: "local", contextLimit: 8192 });
    assert.equal(tight.ok, false, "8k 上下文的本地模型应当被拦下");
    assert.ok(tight.message.indexOf("本地/自定义端点") >= 0, "本地端点要提示这个值是估的：" + tight.message);
    const wide = Core22.checkContextBudget({ inputTokens: 9000, mode: "local", contextLimit: 131072 });
    assert.equal(wide.ok, true, "128k 上下文不该被拦");
    assert.equal(wide.message, "");
    // DeepSeek 官方：输入 + 输出上限远小于 1M，不该被拦，也不该出现"本地"那句提示。
    const cloud = Core22.checkContextBudget({ inputTokens: 40000, mode: "deepseek-flash" });
    assert.equal(cloud.ok, true, "官方 1M 上下文不该被拦");
    assert.equal(cloud.context, 1000000);
  });

  await test("脏数据不炸：负数、NaN、字符串一律当 0", () => {
    assert.equal(Core22.checkContextBudget({}).input, 0);
    assert.equal(Core22.checkContextBudget({ inputTokens: -100 }).input, 0);
    assert.equal(Core22.checkContextBudget({ inputTokens: "abc" }).input, 0);
    assert.equal(Core22.checkContextBudget({ inputTokens: 10.7 }).input, 10);
    assert.equal(Core22.checkContextBudget({ inputTokens: 0, outputLimit: 0 }).output, Core22.outputLimitFor("local"),
      "输出上限填 0 视为没填");
  });

  console.log("== AI 写角色：描述 → 提示词 → 角色卡 ==");

  await test("第一步的请求：关掉思考、给足额度、温度比写卡高", () => {
    const description = "一个冷淡的图书管理员，说话很短，不太愿意搭理人";
    const brief = CharCore.buildBriefGeneratePayload({ description, settings: {}, language: "zh" });
    const card = CharCore.buildDraftGeneratePayload({ description, settings: {}, language: "zh" });
    assert.equal(brief.include_reasoning, false, "扩写也要关掉思考，否则思维链会吃光额度");
    assert.equal(brief.stream, false, "扩写是一次性返回的");
    assert.ok(brief.max_tokens >= 1024, "扩写额度太小会被截断：" + brief.max_tokens);
    assert.ok(brief.temperature > card.temperature, "扩写要一点发挥空间，温度应当高于写卡");
    assert.equal(brief.messages.length, 2, "应当是系统提示 + 用户描述两条");
    assert.equal(brief.messages[1].content, description, "用户描述要原样送过去");
  });

  await test("提示词里写清了要哪几段，以及长度范围", () => {
    const system = CharCore.buildBriefGeneratePayload({ description: "一个冷淡的图书管理员", settings: {} }).messages[0].content;
    for (const section of ["名称", "身份与处境", "性格", "说话方式", "关系", "边界", "开场情境"]) {
      assert.ok(system.indexOf(section) >= 0, "缺少这一段的要求：" + section);
    }
    const limits = CharCore.BRIEF_LIMITS;
    assert.ok(system.indexOf(String(limits.target)) >= 0, "没有写目标长度");
    assert.ok(system.indexOf(String(limits.min)) >= 0 && system.indexOf(String(limits.max)) >= 0, "没有写长度范围");
    assert.ok(/Do not write example dialogue/i.test(system), "应当明确不要在扩写阶段写台词/开场白");
  });

  await test("描述太短或太长都明确拒绝，并说清原因", () => {
    assert.throws(() => CharCore.buildBriefGeneratePayload({ description: "abc" }), /太短/);
    assert.throws(() => CharCore.buildBriefGeneratePayload({ description: "字".repeat(5000) }), /4000/);
  });

  await test("扩写结果整理：太短/太长/空各自被标出来，但内容不丢", () => {
    const long = CharCore.normalizeBrief("字".repeat(3000));
    assert.equal(long.length, CharCore.BRIEF_LIMITS.max, "超长应当截到上限");
    assert.equal(long.truncated, true);
    assert.equal(long.empty, false);
    const short = CharCore.normalizeBrief("太短了");
    assert.equal(short.tooShort, true);
    assert.equal(short.text, "太短了", "短也应当保留内容，不丢");
    const empty = CharCore.normalizeBrief("   ");
    assert.equal(empty.empty, true);
    assert.equal(empty.text, "");
  });

  await test("扩写结果裹了围栏也能剥掉", () => {
    const fenced = CharCore.normalizeBrief("```\n名称：小明\n身份与处境：测试\n```");
    assert.equal(fenced.text.indexOf("```"), -1, "围栏没剥干净：" + JSON.stringify(fenced.text));
    assert.ok(fenced.text.indexOf("名称：小明") >= 0, "内容被剥掉了");
  });

  await test("扩写稿作为写卡输入时截到 4000（写卡接口的上限）", () => {
    assert.equal(CharCore.briefAsDescription("字".repeat(5000)).length, 4000);
    assert.equal(CharCore.briefAsDescription("短稿"), "短稿");
    assert.equal(CharCore.briefAsDescription(null), "");
  });

  await test("两步串起来能跑通：扩写稿喂给写卡请求", () => {
    const description = "一个冷淡的图书管理员，说话很短";
    const briefPayload = CharCore.buildBriefGeneratePayload({ description, settings: {} });
    assert.equal(briefPayload.messages[1].content, description);
    // 模拟模型返回的扩写稿
    const brief = CharCore.normalizeBrief("名称：沈默\n身份与处境：市立图书馆夜班管理员\n性格：冷淡、怕麻烦\n说话方式：短句，少用形容词\n关系：对读者保持距离\n边界：不谈私事\n开场情境：闭馆前十分钟");
    assert.equal(brief.empty, false);
    const cardPayload = CharCore.buildDraftGeneratePayload({
      description: CharCore.briefAsDescription(brief.text),
      settings: {},
      language: "zh",
    });
    assert.equal(cardPayload.messages[1].content, brief.text, "写卡那一步拿到的应当是扩写稿");
    assert.ok(cardPayload.messages[1].content.indexOf("开场情境") >= 0, "扩写稿的段落应当带过去");
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
    // 2026-09-10 起官方目录里 flash 系列统一叫 deepseek-flash；老用户本机存的旧名要自动升。
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-v4-flash" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-flash", "官方别名没有迁移");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-v4-flash-0731" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-flash", "V4 Flash 0731 没有迁移");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-chat" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-flash", "deepseek-chat 没有迁移");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "https://my-proxy.example/v1/chat/completions", model: "deepseek-v4-flash" });
    assert.equal((await Adapter.getLocalSettings()).model, "deepseek-v4-flash", "第三方端点的模型名被误改");
    await Adapter.saveLocalSettings({ provider: "deepseek", endpoint: "", model: "deepseek-flash" });
  });

  await test("官方目录只列在售型号", () => {
    const models = Model.PRESETS.deepseek.models;
    assert.ok(models.indexOf("deepseek-flash") >= 0, "缺少 deepseek-flash：" + JSON.stringify(models));
    assert.ok(models.indexOf("deepseek-v4-pro") < 0,
      "DeepSeek 只留 deepseek-flash（用户要求不再用 v4-pro）：" + JSON.stringify(models));
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
  console.log("== 每条消息的时间进提示词（2026-09-18 用户要求） ==");

  await test("消息时间：真的进了请求体，而且是 [MM-DD HH:MM] 的本机时间", () => {
    // 用户原话：「每条消息的时间也要加进给模型的提示里」。
    // 这条**只认请求体**（payload.messages），不看界面、不看中间变量 ——
    // 否则又是"看着在守、其实什么都没守"。
    const card = { name: "Harry", description: "d", first_mes: "hi", data: {} };
    const stamp = "2026-09-18T14:32:00+08:00";
    const payload = Core22.buildGeneratePayload({
      card, memoryBooks: [], history: [{ is_user: false, mes: "我回来了。", send_date: stamp }],
      userText: "在吗", engine: "A", mode: "local", settings: {},
    });
    const assistant = payload.messages.filter((m) => m.role === "assistant").map((m) => String(m.content));
    assert.equal(assistant.length, 1, "历史里那条助手消息应当原样送过去一条：" + JSON.stringify(payload.messages));
    assert.equal(assistant[0], "[09-18 14:32] 我回来了。",
      "历史消息没有带上时间前缀：" + JSON.stringify(assistant[0]));
    // 系统提示里要有一句说明这些前缀是什么（否则模型只会看到一个方括号）。
    assert.ok(/\[Message times\]/.test(String(payload.messages[0].content)),
      "系统提示里没有说明时间前缀的含义");
    // 时间用的是**本机时区**：这条前缀必须与同一台机器上的本地时刻一致（换时区跑 CI 时也不假失败）。
    const local = new Date(stamp);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    assert.equal(Core22.messageTimePrefix(stamp),
      "[" + pad(local.getMonth() + 1) + "-" + pad(local.getDate()) + " " + pad(local.getHours()) + ":" + pad(local.getMinutes()) + "]",
      "messageTimePrefix 与本机时区不一致");
  });

  await test("消息时间：老存档没有时间戳就**不加**，绝不编一个", () => {
    // 既有口径（「上次说到」那一套）：缺数据时宁可不说，也不编一个日期。
    const card = { name: "Harry", description: "d", first_mes: "hi", data: {} };
    const payload = Core22.buildGeneratePayload({
      card, memoryBooks: [],
      history: [{ is_user: true, mes: "以前说过的话。" }, { is_user: false, mes: "嗯。", send_date: "不是时间" }],
      userText: "在吗", engine: "A", mode: "local", settings: {},
    });
    const contents = payload.messages.map((m) => String(m.content));
    assert.ok(contents.indexOf("以前说过的话。") >= 0, "没有时间戳的那条应当原样发出去：" + JSON.stringify(contents));
    assert.ok(contents.indexOf("嗯。") >= 0, "时间戳解析不了的那些也原样发：" + JSON.stringify(contents));
    assert.equal(Core22.messageTimePrefix(""), "");
    assert.equal(Core22.messageTimePrefix(null), "");
    assert.equal(Core22.messageTimePrefix("不是时间"), "");
    // 一条有效时间都没有时，那句说明也不该出现（不多发一段没用的 token）。
    assert.equal(String(payload.messages[0].content).indexOf("[Message times]"), -1,
      "没有任何有效时间时不该多出一段说明");
  });

  await test("消息时间：只改发出去的那一份，存档里的 mes 一个字都不动", () => {
    const card = { name: "Harry", description: "d", first_mes: "hi", data: {} };
    const history = [{ is_user: true, mes: "原话。", send_date: "2026-09-18T14:32:00+08:00" }];
    Core22.buildGeneratePayload({ card, memoryBooks: [], history, userText: "在吗", engine: "A", mode: "local", settings: {} });
    assert.equal(history[0].mes, "原话。", "存档里那条被改写了（这是绝不允许的）");
    assert.equal(history[0].send_date, "2026-09-18T14:32:00+08:00", "时间戳也被改写了");
    // 关掉开关时（给"逐字节对齐老请求"的用例留的），时间前缀与说明都不出现。
    const off = Core22.buildGeneratePayload({
      card, memoryBooks: [], history, userText: "在吗", engine: "A", mode: "local", settings: {}, messageTimes: false,
    });
    assert.ok(off.messages.some((m) => m.content === "原话。"), "messageTimes:false 时应当是没有前缀的老形状");
    assert.equal(String(off.messages[0].content).indexOf("[Message times]"), -1);
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
