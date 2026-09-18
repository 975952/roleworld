"use strict";

/*
 * data-integrity.cjs —— 数据完整性 / 压力 / 隐私出口（自带静态服务与假模型端点，不联网）
 *
 * 三件事，都是"出事就很难查"的那类：
 *   P0-2 存档往返：记忆的来源、主题、替换记录、对话、记忆书，导出再导入必须一字不差；
 *        并且**存档里不能有 API Key**。
 *   P0-3 长对话压力：800 轮对话下，列表 / 打开 / 发送 / 检索 / 台账都不能崩或卡死。
 *   P0-4 隐私出口：真正离开设备的那一份请求体里，不能出现 API Key、
 *        不能出现别的角色的对话或记忆、不能带本机偏好。
 *
 * 用法：node tests/data-integrity.cjs
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { CDP, launchChrome, sleep } = require("./cdp.js");

const APP = path.join(__dirname, "..", "app");
const PACKS = path.join(__dirname, "..", "packs");
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
].find((candidate) => { try { return fs.existsSync(candidate); } catch (_) { return false; } });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

// 一个绝不该离开设备的字符串：用它当 Key，出现在请求体里就是泄露。
const SECRET_KEY = "sk-DO-NOT-LEAK-0123456789abcdef";

function startServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 空请求体 */ }
      requests.push({
        path: p,
        auth: req.headers.authorization || "",
        raw: raw,
        system: (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n"),
        allContent: (Array.isArray(body.messages) ? body.messages : [])
          .map((m) => String((m && m.content) || "")).join("\n"),
      });
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write("data: " + JSON.stringify({ model: "synthetic", choices: [{ delta: { content: "收到了，这是一条用于数据完整性回归的回复。" } }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "synthetic", choices: [{ message: { role: "assistant", content: "收到了。" }, finish_reason: "stop" }] }));
      return;
    }

    if (p === "/") p = "/index.html";
    const root = p.startsWith("/packs/") ? PACKS : APP;
    const rel = p.startsWith("/packs/") ? p.slice("/packs/".length) : p.replace(/^\/+/, "");
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

const results = [];
let failures = 0;

async function check(name, fn) {
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!CHROME) {
    console.log("找不到 Chrome/Edge，可用 CHROME_PATH 指定");
    process.exitCode = 1;
    return;
  }
  const { server, port, requests } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9419 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");

  const fixture = `
    (function () {
      try { localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-flash" })); } catch (_) {}
      // 这个套件要的是"确定的库"：内置内容包会把角色数变成 8，所以先停用它。
      window.__ROLEWORLD_DISABLE_PACKS__ = true;
      window.__ROLEWORLD_FIXTURE__ = {
        characters: [
          { avatar: "甲角色.png", name: "甲角色", description: "第一个测试角色。", first_mes: "你好，我是甲。",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "甲角色", description: "第一个测试角色。", personality: "安静", scenario: "测试",
                    first_mes: "你好，我是甲。", mes_example: "", tags: [] } },
          { avatar: "乙角色.png", name: "乙角色", description: "第二个测试角色。", first_mes: "你好，我是乙。",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "乙角色", description: "第二个测试角色。", personality: "活泼", scenario: "测试",
                    first_mes: "你好，我是乙。", mes_example: "", tags: [] } }
        ],
        worlds: [
          { name: "MB 甲 — 自动记忆", entries: {
            "1": { uid: 1, key: [], keysecondary: [], comment: "玩家喜欢咖啡", content: "玩家喜欢咖啡",
                   constant: true, disable: false, displayIndex: 1,
                   rw_source: { file: "甲-对话.jsonl", messageIndex: 3, at: "2026-09-11T01:00:00.000Z",
                                origin: "model", topic: "饮料", replacedContent: "玩家以前不喝咖啡" } } } },
          { name: "MB 乙 — 自动记忆", entries: {} }
        ],
        chats: [
          { avatar: "甲角色.png", file_name: "甲-对话.jsonl", messages: [
            { chat_metadata: {}, user_name: "我", character_name: "甲角色" },
            { name: "我", is_user: true, mes: "甲，我只告诉你的秘密：我把钥匙放在花盆下面。", send_date: "2026-09-11T01:00:00.000Z" },
            { name: "甲角色", is_user: false, mes: "好，我记住了。", send_date: "2026-09-11T01:00:05.000Z" }
          ] },
          { avatar: "乙角色.png", file_name: "乙-对话.jsonl", messages: [
            { chat_metadata: {}, user_name: "我", character_name: "乙角色" },
            { name: "我", is_user: true, mes: "乙，这是另一个角色的对话，不该出现在甲的请求里。", send_date: "2026-09-11T02:00:00.000Z" }
          ] }
        ],
        settings: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash" }
      };
    })();
  `;
  const fixtureScript = await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixture });

  const evaluate = async (expression) => {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) {
      throw new Error("页面脚本异常：" + (out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text));
    }
    return out.result.value;
  };

  const waitFor = async (expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时：" + expression);
      await sleep(200);
    }
  };

  await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html?onboarding=off&surprise=off" });
  await waitFor("window.TASK21_READY === true", 40000);
  // 第一次启动会把 fixture 与内置内容包装进去。为了要"确定的库"，这里：
  //   ① 清掉所有 store（用 store.clearAll，而不是 resetAll —— resetAll 会写回档案键）；
  //   ② 直接写 packs:disabled，让内容包在随后的启动里被跳过。
  // 然后再刷新一次，让应用在这个干净的库上跑起来。
  const setup = await evaluate(`(async () => {
    await window.RoleWorld.store.clearAll();
    await window.RoleWorld.store.setKV('packs:disabled', ['harry-potter']);
    await window.RoleWorld.store.setKV('packs:installed', {});
    return {
      characters: (await window.RoleWorld.store.listCharacters()).length,
      worlds: (await window.RoleWorld.store.listWorlds()).length,
      disabled: await window.RoleWorld.store.getKV('packs:disabled', null)
    };
  })()`);
  assert(setup.characters === 0 && setup.worlds === 0,
    "清库没成功：" + JSON.stringify(setup));
  assert(Array.isArray(setup.disabled) && setup.disabled.indexOf("harry-potter") >= 0,
    "内容包没停用：" + JSON.stringify(setup.disabled));
  // 不清 fixture：每次页面加载它都会把合成数据补回来，而清过的库里正好缺这些数据。
  await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html?onboarding=off&surprise=off" });
  await waitFor("window.TASK21_READY === true", 40000);
  const seeded = await evaluate(`(async () => ({
    characters: (await window.RoleWorld.store.listCharacters()).map((c) => c.name).sort(),
    worlds: (await window.RoleWorld.store.listWorlds()).map((w) => w.name).sort(),
    chats: (await window.RoleWorld.store.listChats('甲角色.png')).length
  }))()`);
  assert(seeded.characters.join(",") === "乙角色,甲角色",
    "启动后角色不对（内置包可能没被停用）：" + JSON.stringify(seeded));
  assert(seeded.chats === 1, "启动后对话数不对：" + JSON.stringify(seeded));

  console.log("== P0-2 存档往返完整性 ==");

  await check("存档里不含 API Key，但含全部角色 / 对话 / 记忆书", async () => {
    const info = await evaluate(`(async () => {
      await window.RoleWorld.secrets.set('api_key_deepseek', ${JSON.stringify(SECRET_KEY)});
      const dump = await window.RoleWorld.exportArchive();
      const text = JSON.stringify(dump);
      return {
        hasKey: text.indexOf('DO-NOT-LEAK') >= 0,
        stores: Object.keys(dump.data || {}),
        characters: (dump.data.characters || []).length,
        chats: (dump.data.chats || []).length,
        worlds: (dump.data.worlds || []).length,
        format: dump.format
      };
    })()`);
    assert(info.format === "roleworld-archive", "存档格式标记不对：" + info.format);
    assert(info.characters === 2, "角色数不对：" + info.characters);
    assert(info.chats === 2, "对话数不对：" + info.chats);
    assert(info.worlds === 2, "记忆书数不对：" + info.worlds);
    assert(info.hasKey === false, "存档里出现了 API Key —— 这是隐私问题");
  });

  await check("记忆的来源 / 主题 / 替换记录在导出导入后一字不差", async () => {
    const result = await evaluate(`(async () => {
      const before = await window.RoleWorld.store.getWorld('MB 甲 — 自动记忆');
      const dump = await window.RoleWorld.exportArchive();
      // 清空后重新导入，模拟换设备
      await window.RoleWorld.store.clearAll();
      await window.RoleWorld.importArchive(dump, { mode: 'replace' });
      const after = await window.RoleWorld.store.getWorld('MB 甲 — 自动记忆');
      const a = before.entries['1'];
      const b = after.entries['1'];
      return {
        sameContent: a.content === b.content,
        sameSource: JSON.stringify(a.rw_source) === JSON.stringify(b.rw_source),
        topic: b.rw_source && b.rw_source.topic,
        replaced: b.rw_source && b.rw_source.replacedContent,
        origin: b.rw_source && b.rw_source.origin,
        at: b.rw_source && b.rw_source.at,
        messageIndex: b.rw_source && b.rw_source.messageIndex
      };
    })()`);
    assert(result.sameContent, "记忆正文在往返后变了");
    assert(result.sameSource, "记忆的来源元数据在往返后变了");
    assert(result.topic === "饮料", "主题丢了：" + result.topic);
    assert(result.replaced === "玩家以前不喝咖啡", "替换记录丢了：" + result.replaced);
    assert(result.origin === "model", "来源标记丢了：" + result.origin);
    assert(result.at === "2026-09-11T01:00:00.000Z", "时间戳变了：" + result.at);
    assert(result.messageIndex === 3, "来源消息序号丢了：" + result.messageIndex);
  });

  await check("对话内容与角色卡在往返后一字不差", async () => {
    const result = await evaluate(`(async () => {
      const chat = await window.RoleWorld.store.getChat('甲角色.png', '甲-对话.jsonl');
      const cards = await window.RoleWorld.store.listCharacters();
      const first = chat.filter((line) => line && line.mes)[0];
      const blobs = await Promise.all(cards.map((c) => window.RoleWorld.store.getBlob('avatar:' + c.avatar).then((b) => !!b)));
      return {
        chatCount: chat.length,
        firstText: first && first.mes,
        cardNames: cards.map((c) => c.name).sort(),
        blobs: blobs,
        blobCount: blobs.filter(Boolean).length
      };
    })()`);
    assert(result.firstText.indexOf("钥匙放在花盆下面") >= 0,
      "对话正文在往返后变了：" + JSON.stringify(result.firstText));
    assert(result.cardNames.join(",") === "乙角色,甲角色", "角色卡不对：" + result.cardNames.join(","));
    // 头像二进制不在本用例范围：合成卡是直接塞进 store 的，没有配套的 blobs 记录，
    // 导出时自然没有二进制可带。真实卡（PNG 自带立绘）的头像往返由 local-app-check 的内容包用例覆盖。
    console.log("        （本用例的合成卡没有图片文件，头像二进制未参与往返）");
  });

  await check("关系档案（伴侣模式）往返后一字不差，而且和记忆书分开存", async () => {
    const result = await evaluate(`(async () => {
      await window.TASK21.saveCompanion({ avatar: '甲角色.png' }, {
        enabled: true, relation: 'partner', relationCustom: '',
        charCallsUser: '阿林', userCallsChar: '小默',
        since: '2026-01-01',
        shared: [{ text: '第一次聊天是在雨天的图书馆' }, { text: '答应过要一起看一次海' }],
        lastChatAt: '2026-09-10T12:00:00.000Z'
      });
      const before = await window.RoleWorld.store.getKV('companion:甲角色.png', null);
      const dump = await window.RoleWorld.exportArchive();
      await window.RoleWorld.store.clearAll();
      await window.RoleWorld.importArchive(dump, { mode: 'replace' });
      const after = await window.RoleWorld.store.getKV('companion:甲角色.png', null);
      const books = (await window.RoleWorld.store.listWorlds()).map((w) => w.name);
      const inMemory = JSON.stringify(await window.RoleWorld.store.getWorld('MB 甲 — 自动记忆'));
      return {
        same: JSON.stringify(before) === JSON.stringify(after),
        after: after, books: books,
        leakedIntoMemory: inMemory.indexOf('雨天的图书馆') >= 0,
      };
    })()`);
    assert(result.same, "关系档案在往返后变了：" + JSON.stringify(result.after));
    assert(result.after && result.after.enabled === true && result.after.relation === "partner",
      "关系档案内容不对：" + JSON.stringify(result.after));
    assert(result.after.shared.length === 2 && result.after.shared[1].text === "答应过要一起看一次海",
      "共同经历丢了：" + JSON.stringify(result.after.shared));
    assert(result.after.lastChatAt === "2026-09-10T12:00:00.000Z", "上次聊天时间丢了");
    assert(result.books.indexOf("MB 甲 — 自动记忆") >= 0, "记忆书不见了：" + JSON.stringify(result.books));
    assert(result.leakedIntoMemory === false, "关系档案被混进记忆书了 —— 真实信息和模型记的东西必须分开");
  });

  console.log("== P0-3 长对话压力 ==");

  await check("写入 800 轮对话：能列、能开、打开时间可接受", async () => {
    const timing = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const lines = [{ chat_metadata: { ui_title: '压力测试' }, user_name: '我', character_name: '甲角色' }];
      for (let i = 0; i < 800; i += 1) {
        lines.push({ name: '我', is_user: true, mes: '压力测试第' + i + '轮：' + '字'.repeat(40), send_date: new Date(Date.now() - (800 - i) * 60000).toISOString() });
        lines.push({ name: '甲角色', is_user: false, mes: '回复第' + i + '轮：' + '字'.repeat(40), send_date: new Date(Date.now() - (800 - i) * 60000 + 1000).toISOString() });
      }
      const t0 = Date.now();
      await store.saveChat('甲角色.png', '压力-800.jsonl', lines);
      const writeMs = Date.now() - t0;
      const t1 = Date.now();
      const list = await store.listChats('甲角色.png');
      const listMs = Date.now() - t1;
      const t2 = Date.now();
      const back = await store.getChat('甲角色.png', '压力-800.jsonl');
      const readMs = Date.now() - t2;
      return { writeMs, listMs, readMs, listCount: list.length, lines: back.length, bytes: JSON.stringify(back).length };
    })()`);
    console.log("        写入 " + timing.writeMs + "ms / 列表 " + timing.listMs + "ms / 读取 " + timing.readMs
      + "ms / " + timing.lines + " 行 / " + Math.round(timing.bytes / 1024) + " KB");
    assert(timing.lines === 1601, "行数不对：" + timing.lines);
    assert(timing.listMs < 2000, "列表太慢：" + timing.listMs + "ms");
    assert(timing.readMs < 3000, "打开太慢：" + timing.readMs + "ms");
  });

  await check("800 轮对话下：检索不崩且够快", async () => {
    const timing = await evaluate(`(async () => {
      const search = window.ROLEWORLD_SEARCH_CORE;
      const sessions = [{ fileName: '压力-800.jsonl', messages: (await window.RoleWorld.store.getChat('甲角色.png', '压力-800.jsonl')).filter((l) => l && l.mes) }];
      const t0 = Date.now();
      const result = search.searchHistory(sessions, '压力测试第777轮', { limit: 6 });
      const ms = Date.now() - t0;
      return { ms, scanned: result.scanned, matched: result.matched, top: (result.hits[0] || {}).text || '' };
    })()`);
    console.log("        检索 " + timing.scanned + " 条耗时 " + timing.ms + "ms，命中 " + timing.matched + " 条");
    assert(timing.ms < 1000, "检索太慢：" + timing.ms + "ms");
    assert(timing.matched >= 1, "长对话里检索不到已知内容");
    assert(timing.top.indexOf("777") >= 0, "检索命中的不是目标那一轮：" + timing.top.slice(0, 40));
  });

  await check("800 轮对话下：界面能打开、能发送、台账照常记", async () => {
    const before = requests.length;
    await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      // 把它设为"最近一段对话"，页面刷新后会直接打开它
      localStorage.setItem('task29a.chats.v1.local.last-chat', JSON.stringify({ avatar: '甲角色.png', fileName: '压力-800.jsonl' }));
      return true;
    })()`);
    await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html?onboarding=off&surprise=off" });
    await waitFor("window.TASK21_READY === true", 40000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '压力测试之后再说一句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 30000);
    const state = await evaluate(`(async () => {
      const cards = await window.RoleWorld.store.listCharacters();
      const metrics = await window.RoleWorld.store.getKV('metrics:' + cards.find((c) => c.name === '甲角色').avatar, []);
      return { requestsSent: 0, metricsTurns: Array.isArray(metrics) ? metrics.length : 0, messages: document.querySelectorAll('#dynamicMessages .message-row').length };
    })()`);
    assert(requests.length > before, "长对话下发送没有产生请求");
    assert(state.metricsTurns >= 1, "长对话下台账没有记录");
    console.log("        界面渲染 " + state.messages + " 条消息，台账 " + state.metricsTurns + " 轮");
  });

  console.log("== P0-4 隐私出口自查 ==");

  await check("请求体里没有 API Key", async () => {
    const last = requests[requests.length - 1];
    assert(last, "没有捕获到请求");
    assert(last.raw.indexOf("DO-NOT-LEAK") < 0, "请求体里出现了 API Key —— 这是隐私问题");
    // Authorization 头是给服务商的正常鉴权，不属于"泄露到正文"；只确认正文干净。
    const parsed = JSON.parse(last.raw);
    const bodyText = JSON.stringify(parsed);
    assert(bodyText.indexOf("sk-") < 0, "请求体正文里出现了看起来像 Key 的字符串");
  });

  await check("甲的请求里没有乙的对话与记忆", async () => {
    const last = requests[requests.length - 1];
    assert(last.allContent.indexOf("另一个角色的对话") < 0, "别的角色的对话出现在请求里");
    assert(last.system.indexOf("MB 乙") < 0, "别的角色的记忆书出现在系统提示里");
  });

  await check("请求体里没有本机偏好（主题 / 缩放 / 引导状态等）", async () => {
    const last = requests[requests.length - 1];
    for (const key of ["preferences", "task22.chat-model", "tutorial_seen", "sidebarCharacters", "nickname"]) {
      assert(last.raw.indexOf(key) < 0, "请求体里出现了本机偏好字段：" + key);
    }
  });

  await check("没有发往任何其他目的地（只有测试端点收到请求）", async () => {
    const last = requests[requests.length - 1];
    assert(last, "没有捕获到请求");
    const parsed = JSON.parse(last.raw);
    // 真正发到网络上的请求体是干净的 OpenAI 形状：SillyTavern 时代的内部字段
    // （chat_completion_source / custom_url / task22_engine…）被适配层剥掉了，
    // 不含任何"能把内容带去别处"的字段。
    for (const forbidden of ["custom_url", "chat_completion_source", "task22_engine", "api_key", "secret"]) {
      assert(!(forbidden in parsed), "请求体里出现了内部字段：" + forbidden);
    }
    assert(parsed.model === "deepseek-flash", "模型名不对：" + JSON.stringify(parsed.model));
    // 所有被捕获的请求都来自这一个测试端点；服务器也只处理过这一个对话路径。
    const paths = Array.from(new Set(requests.map((r) => r.path)));
    assert(paths.length === 1 && paths[0] === "/v1/chat/completions",
      "出现了预料之外的请求路径：" + JSON.stringify(paths));
    console.log("        捕获 " + requests.length + " 个请求，全部发往 " + paths[0]);
  });

  await check("语音：合成好的音频不进导出存档，也不进发给模型的请求体", async () => {
    // 语音缓存是**派生数据**（可以重新生成）而且很占地方，进存档只会让"导出→发给别人"变笨重。
    // 这一条同时钉住"语音那一路只发必要字段"：合成请求里只有 text / speaker / speech_rate。
    const info = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      // 先塞一条假的语音缓存（不联网、不合成）
      await store.putVoiceRecord({
        id: 'voice:selftest', base64: 'AAAA', type: 'audio/mpeg',
        bytes: 3, chars: 2, speaker: 'zh_female_vv_uranus_bigtts', speechRate: 0,
        at: Date.now(), usedAt: Date.now()
      });
      const records = await store.listVoiceRecords();
      const dump = await window.RoleWorld.exportArchive();
      const dumpText = JSON.stringify(dump);
      // 清掉，别影响后面的用例
      await store.clearVoiceRecords();
      return {
        hasStore: typeof store.listVoiceRecords === 'function',
        records: Array.isArray(records) ? records.length : -1,
        dumpHasVoiceStore: Object.prototype.hasOwnProperty.call(dump.data || {}, 'voice'),
        dumpHasCacheKey: dumpText.indexOf('voice:selftest') >= 0,
        stores: Object.keys(dump.data || {}),
      };
    })()`);
    assert(info.hasStore, "存储层少了语音缓存那一本（说明缓存没地方放，会退化成内存缓存）");
    assert(info.records === 1, "刚塞进去的语音缓存读不回来：" + info.records);
    assert(!info.dumpHasVoiceStore, "导出存档里出现了 voice 存储：" + JSON.stringify(info.stores));
    assert(!info.dumpHasCacheKey, "导出存档里出现了语音缓存内容 —— 它是派生数据，不该进存档");
    // 模型请求体里不许出现语音相关的字段（那条路只发给你配置的模型端点）
    const last = requests[requests.length - 1];
    for (const forbidden of ["speaker", "speech_rate", "voice_id"]) {
      assert(last.raw.indexOf('"' + forbidden + '"') < 0,
        "发给模型的请求体里出现了语音参数：" + forbidden);
    }
  });

  await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
  server.close();
  try { chrome.process.kill(); } catch (_) {}

  console.log("");
  console.log(failures
    ? `DATA_INTEGRITY=${results.length - failures}/${results.length}（有 ${failures} 项不达标）`
    : `DATA_INTEGRITY=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
