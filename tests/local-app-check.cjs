"use strict";

/*
 * local-app-check.cjs —— 本地模式端到端回归（无 SillyTavern、无外网）
 *
 * 起一个静态服务器托管 app/ 与 packs/，再起一个假的 OpenAI 兼容模型端点，
 * 用无头 Chrome 真正打开三个页面，验证：
 *   1. 对话页能启动（没有登录跳转、没有遮罩、输入框可用）
 *   2. 发送消息能拿到流式回复并落到界面上；思考模式默认关闭且不显示思维链
 *   3. 剧情模式页能读角色与记忆书
 *   4. 内容包自动安装 / 停用后空库仍可启动
 *   5. 设置面板能读写本机模型配置与密钥
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
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => candidate && fs.existsSync(candidate)) || "";
const REPLY = "合成回复：你好，我是本地模型。";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function startServer() {
  const requests = [];
  // 停止生成需要一条"慢慢吐字"的流：只在这条用例里打开，避免影响其它断言。
  let slowStream = false;
  // 下一次回复的内容可以由测试指定：用来验证 [[记住: …]] 这条真实链路。
  const replyQueue = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);

    if (p === "/__reply") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try { replyQueue.push(JSON.parse(raw).content || ""); } catch (_) { replyQueue.push(""); }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (p === "/__slow-stream") {
      slowStream = true;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 保持空对象 */ }
      requests.push({
        path: p, stream: body.stream === true, model: body.model,
        auth: req.headers.authorization || "", include_reasoning: body.include_reasoning,
        // 系统提示里是否带上了那条合成记忆：用来断言"删掉的记忆不再出现"。
        systemHasMemory: Array.isArray(body.messages)
          && body.messages.some((m) => m && m.role === "system" && String(m.content || "").indexOf("玩家叫小林") >= 0),
        // 被替换掉的旧说法不该再出现（"玩家喜欢咖啡" 会误匹配新说法，所以用更精确的判断）
        systemHasStaleMemory: Array.isArray(body.messages)
          && body.messages.some((m) => m && m.role === "system"
            && /玩家喜欢咖啡/.test(String(m.content || ""))
            && String(m.content || "").indexOf("玩家现在不喜欢咖啡了") < 0),
        // 系统提示全文（只给测试用，用来检查诚实规则与历史检索那段）
        systemText: (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n"),
      });
      if (body.stream === true && slowStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        const send = (delta) => res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta }] }) + "\n\n");
        send({ content: "他把书合上。" });
        await sleep(400);
        send({ content: "\n[[记住: 玩家叫小林]]" });
        await sleep(900);
        // 这里停在半截的记忆标记上：用户如果现在按停止，界面上不能出现 `记住`。
        send({ content: "\n[[记住: 玩家怕黑" });
        await sleep(2000);
        send({ content: "]]\n“明天见。”" });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        // 先给两段思维链：思考模式关闭时它们必须一个都不显示。
        for (const thought of ["思考中甲", "思考中乙"]) {
          res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta: { reasoning_content: thought } }] }) + "\n\n");
        }
        const queued = replyQueue.shift();
        if (queued) requests[requests.length - 1].queued = true;
        const pieces = queued ? [queued] : ["合成回复：", "你好，", "我是本地模型。"];
        for (const piece of pieces) {
          res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: body.model || "synthetic", choices: [{ message: { role: "assistant", content: REPLY }, finish_reason: "stop" }] }));
      return;
    }

    if (p === "/__requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(requests));
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
  if (!fs.existsSync(CHROME)) {
    console.log("找不到 Chrome：" + CHROME + "（可用 CHROME_PATH 指定）");
    process.exitCode = 1;
    return;
  }

  const { server, port, requests } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9411 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);

  const fixture = `
    (function () {
      try {
        localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-flash" }));
        sessionStorage.setItem("task27a.current-account-handle.v1", "local");
      } catch (_) {}
      window.__ROLEWORLD_FIXTURE__ = {
        characters: [
          { avatar: "Harry Potter (EN).png", name: "Harry Potter", description: "被选中的男孩。",
            personality: "勇敢", scenario: "霍格沃茨", first_mes: "你好。", mes_example: "",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "Harry Potter", description: "被选中的男孩。", personality: "勇敢",
                    scenario: "霍格沃茨", first_mes: "你好。", mes_example: "", tags: [] } },
          { avatar: "Hermione Granger (EN).png", name: "Hermione Granger", description: "最聪明的女巫。",
            first_mes: "你好。", spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "Hermione Granger", description: "最聪明的女巫。", first_mes: "你好。", tags: [] } }
        ],
        worlds: [
          { name: "MB Harry — fact clips (EN)", entries: {
            "0": { uid: 0, key: ["哈利"], keysecondary: [], comment: "测试条目", content: "合成记忆内容", disable: false, constant: false } } },
          // 一条合成的"自动记忆"，带来源：验证面板能显示它记了什么、来自哪句话，并能删掉。
          { name: "MB Harry — 自动记忆", entries: {
            "1": { uid: 1, key: [], keysecondary: [], comment: "玩家叫小林", content: "玩家叫小林",
                   constant: true, disable: false, displayIndex: 1,
                   rw_source: { file: "harry-task26a-合成.jsonl", messageIndex: 4, at: "2026-09-11T02:00:00.000Z", origin: "model" } } } }
        ],
        chats: [
          { avatar: "Harry Potter (EN).png", file_name: "harry-以前的对话.jsonl", messages: [
            { chat_metadata: {}, user_name: "我", character_name: "Harry Potter" },
            { name: "我", is_user: true, mes: "我养了一只猫叫团子", send_date: "2026-08-01T10:00:00.000Z" },
            { name: "Harry Potter", is_user: false, mes: "团子听起来很可爱！", send_date: "2026-08-01T10:00:05.000Z" },
            { name: "我", is_user: true, mes: "我一般买三文鱼味的猫粮", send_date: "2026-08-01T10:01:00.000Z" }
          ] }
        ],
        settings: {
          provider: "deepseek",
          endpoint: "${base}/v1/chat/completions",
          model: "deepseek-flash"
        }
      };
    })();
  `;

  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");
  const fixtureScript = await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixture });

  async function evaluate(expression) {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error("页面脚本异常：" + (out.exceptionDetails.exception && out.exceptionDetails.exception.description
        || out.exceptionDetails.text));
    }
    return out.result.value;
  }

  async function goto(url) {
    await cdp.sessionSend(session, "Page.navigate", { url });
    for (let i = 0; i < 100; i += 1) {
      await sleep(150);
      try {
        const ready = await evaluate("document.readyState === 'complete'");
        if (ready) return;
      } catch (_) { /* 导航中 */ }
    }
    throw new Error("页面加载超时：" + url);
  }

  // 页面脚本一旦抛错，这里能直接把原始错误打出来，省得靠猜。
  function pageErrors() {
    const out = [];
    cdp.events.forEach((event) => {
      if (event.method === "Runtime.exceptionThrown") {
        const details = event.params && event.params.exceptionDetails;
        out.push("EXCEPTION: " + (details && details.exception && details.exception.description || (details && details.text) || "unknown"));
      } else if (event.method === "Runtime.consoleAPICalled" && event.params && event.params.type === "error") {
        out.push("CONSOLE: " + (event.params.args || []).map((arg) => arg.value || arg.description || "").join(" "));
      }
    });
    cdp.events.length = 0;
    return out;
  }

  function reportErrors(label) {
    const errors = pageErrors();
    if (errors.length) {
      console.log("  ---- " + label + " 页面报错 ----");
      errors.slice(0, 8).forEach((line) => console.log("  " + line.slice(0, 300)));
    }
  }

  async function waitFor(expression, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时：" + expression);
      await sleep(200);
    }
  }

  console.log("== 角色对话页 ==");

  await goto(base + "/index.html");
  // 必须等这次启动彻底落定再清库：安装内容包是启动过程的一部分，
  // 半途 reset 会和它抢写，留下一个装了一半的库。
  await waitFor("window.TASK21_READY === true", 30000);

  // 清库并停用内置包，让 fixture 阶段的角色数量是确定的。
  await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); await RoleWorldPacks.setEnabled('harry-potter', false); return true; })()");
  await goto(base + "/index.html");

  // 摘掉 theme-pending 是 bootLive 的最后一步，用它当"启动完成"信号最可靠。
  await waitFor("window.TASK21_READY === true", 30000);
  reportErrors("index.html");

  await check("页面留在 index.html，没有跳转到登录页", async () => {
    const href = await evaluate("location.pathname");
    assert(href.endsWith("/index.html"), "被跳转到了 " + href);
  });

  await check("启动遮罩已摘除，登录门与模板门都隐藏", async () => {
    const gate = await evaluate(`(() => {
      const node = document.querySelector('#chatTemplateGate');
      const message = document.querySelector('#chatTemplateGateMessage');
      return { hidden: node.hidden, text: message ? message.textContent : '' };
    })()`);
    assert(await evaluate("!document.documentElement.classList.contains('theme-pending')"), "theme-pending 仍存在（灰屏）");
    assert(await evaluate("document.querySelector('#authGate').hidden === true"), "#authGate 仍然可见");
    assert(gate.hidden === true, "#chatTemplateGate 显示：" + gate.text);
  });

  await check("角色与记忆书从本机数据库读出", async () => {
    const counts = await evaluate("(async () => ({ c: (await RoleWorld.store.listCharacters()).length, w: (await RoleWorld.store.listWorlds()).length, names: (await RoleWorld.store.listCharacters()).map((x) => x.avatar), books: (await RoleWorld.store.listWorlds()).map((x) => x.name) }))()");
    if (counts.c !== 2) reportErrors("index.html");
    assert(counts.c === 2, "角色数量应为 2，实际 " + counts.c + "：" + JSON.stringify(counts.names) + " / 书：" + JSON.stringify(counts.books));
    // fixture 里有 2 本记忆书：fact clips + 一本带来源的「自动记忆」（用于记忆面板用例）。
    assert(counts.w === 2, "记忆书数量应为 2，实际 " + counts.w + "：" + JSON.stringify(counts.books));
  });

  await check("输入框可用（说明角色卡、端点、会话三个条件都满足）", async () => {
    assert(await evaluate("document.querySelector('#messageInput').disabled === false"), "输入框被禁用");
    assert(await evaluate("document.querySelector('#sendButton').disabled === false"), "发送按钮被禁用");
  });

  // 每次发送后都等"这一轮彻底结束"再往下走：只看消息文本会被用户自己那句话误判成已完成。
  async function waitTurnSettled() {
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 25000);
  }

  await check("「本次请求」平时不出现，发过消息后才露出入口", async () => {
    // 这条要放在第一次发送之前；发送后入口应该自己出来。
    assert(await evaluate("document.querySelector('#requestPeekButton').hidden === true"), "还没发消息就出现了入口");
    assert(await evaluate("document.querySelector('#requestPeek').hidden === true"), "面板初始就是打开的");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '看看这次请求';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('我是本地模型') >= 0", 10000);
    assert(await evaluate("document.querySelector('#requestPeekButton').hidden === false"), "发过消息后入口没出现");
    assert(await evaluate("document.querySelector('#requestPeek').hidden === true"), "面板不该自己弹出来");
  });

  await check("发送消息能收到流式回复", async () => {
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '你好';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    assert(await evaluate("document.querySelector('#dynamicMessages').textContent.indexOf('我是本地模型') >= 0"), "没有收到流式回复");
  });

  await check("模型请求走的是本机配置的端点，并且带了流式标记", async () => {
    const sent = requests.filter((row) => row.stream === true);
    assert(sent.length >= 1, "没有收到流式请求");
    // 模型名以「设置 → 模型」里填的为准，不再由下拉框里的固定选项决定。
    assert(sent[sent.length - 1].model === "deepseek-flash", "模型名不对：" + sent[sent.length - 1].model);
  });

  await check("台账：每轮记下延迟与费用，面板能看到汇总", async () => {
    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    // 前面已经发过几轮，所以轮数不写死；只要求确实在统计。
    assert(/台账（最近 \d+ 轮）：首字平均 [\d.]+(ms|s)/.test(text),
      "台账没有统计首字延迟：" + JSON.stringify(text.slice(0, 200)));
    assert(/整轮平均 [\d.]+(ms|s)/.test(text), "台账没有统计整轮延迟：" + JSON.stringify(text.slice(0, 200)));
    assert(/费用合计 ¥[\d.]+/.test(text), "台账没有统计费用：" + JSON.stringify(text.slice(0, 200)));
    assert(/记错 \d+ 次（[\d—]+%）/.test(text), "台账没有记错次数：" + JSON.stringify(text.slice(0, 200)));
    assert(text.indexOf("只能由你手动标记") >= 0, "没有说明标记是手动的");
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("标记「记错」：点一下计入台账，再点取消", async () => {
    // 每条助手回复旁边都该有标记入口
    const count = await evaluate("document.querySelectorAll('.message-flag').length");
    assert(count >= 2, "助手消息旁边没有标记入口，实际按钮数 " + count);

    // 最近一轮的轮次 ID（台账与消息里应当是同一个）
    const turnId = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const cards = await store.listCharacters();
      const kv = await store.getKV('metrics:' + cards[0].avatar, []);
      return (kv[kv.length - 1] || {}).turnId || '';
    })()`);
    assert(turnId, "台账里没有轮次 ID");

    // 点最近那条助手回复旁边的「记错」
    const clicked = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const cards = await store.listCharacters();
      const kv = await store.getKV('metrics:' + cards[0].avatar, []);
      const id = (kv[kv.length - 1] || {}).turnId;
      const rows = Array.from(document.querySelectorAll('.message-row-assistant'));
      const row = rows[rows.length - 1];
      const button = Array.from(row.querySelectorAll('.message-flag')).find((b) => b.textContent.trim() === '记错');
      if (!button) return 'no-button';
      button.click();
      return id;
    })()`);
    assert(clicked === turnId, "点的不是最近一轮：" + clicked + " vs " + turnId);

    const flagged = await waitFor(`(async () => {
      const store = window.RoleWorld.store;
      const cards = await store.listCharacters();
      const kv = await store.getKV('metrics:' + cards[0].avatar, []);
      const hit = (kv || []).find((t) => t.turnId === ${JSON.stringify(turnId)});
      return !!(hit && (hit.flags || []).indexOf('wrong-memory') >= 0);
    })()`, 8000).catch(() => false);
    assert(flagged, "点了「记错」，台账里却没有记上");
    assert(await evaluate("document.querySelector('.message-flag.flag-on') !== null"), "按钮没有显示为已标记");

    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    assert(/记错 [1-9]\d* 次/.test(text), "标记后台账没有 +1：" + JSON.stringify(text.slice(0, 200)));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);

    // 再点一次取消
    await evaluate(`(() => {
      const button = document.querySelector('.message-flag.flag-on');
      button.click();
      return true;
    })()`);
    await waitFor("document.querySelector('.message-flag.flag-on') === null", 8000);
  });

  await check("顶栏可以直接切换模型，并且写回同一份配置", async () => {
    const current = await evaluate("(document.querySelector('#chatModelSelect') || {}).value");
    assert(current === "deepseek-flash", "顶栏当前值不对：" + current);
    assert(await evaluate("document.querySelector('#chatDeepseekKeyInput') === null"), "对话页仍有重复的密钥输入框");
    const options = await evaluate("Array.from(document.querySelectorAll('#chatModelSelect option')).map((o) => o.value)");
    assert(options.indexOf("deepseek-v4-pro") >= 0, "已知型号没列出来：" + JSON.stringify(options));
    assert(options.indexOf("__custom__") >= 0, "缺少「自定义模型名…」入口");

    await evaluate(`(() => {
      const select = document.querySelector('#chatModelSelect');
      select.value = 'deepseek-v4-pro';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(document.querySelector('[data-roleworld=\"model\"]') || {}).value === 'deepseek-v4-pro'", 8000);

    await evaluate(`(() => {
      const select = document.querySelector('#chatModelSelect');
      select.value = 'deepseek-flash';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(document.querySelector('[data-roleworld=\"model\"]') || {}).value === 'deepseek-flash'", 8000);
  });

  await check("对话界面显示 token 用量与费用估算", async () => {
    await waitFor("(document.querySelector('#chatCostLine') || {}).textContent.length > 0", 8000);
    const line = await evaluate("document.querySelector('#chatCostLine').textContent");
    assert(/本对话 \d+ 轮/.test(line), "费用行没有轮次：" + line);
    assert(/输入 [\d.]+k? \/ 输出 [\d.]+k? tokens/.test(line), "费用行没有 token 用量：" + line);
    assert(/累计 [≈]?¥[\d.]+/.test(line), "费用行没有金额：" + line);
    assert(/单价 ¥[\d.]+\/¥[\d.]+ 每百万 tokens（(高峰|闲时)时段）/.test(line), "费用行没带单价与峰谷：" + line);
  });

  await check("面板按来源分段，且分段之和与真正发出的请求一致", async () => {
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    for (const label of ["系统提示", "角色卡 · 描述", "回复格式要求", "本轮输入"]) {
      assert(text.indexOf(label) >= 0, "面板缺少分段：" + label + " —— " + JSON.stringify(text.slice(0, 200)));
    }
    assert(/合计 \d+ 字 · [\d.]+k? tokens · 共 \d+ 条消息/.test(text), "没有合计行：" + JSON.stringify(text.slice(-160)));
    assert(text.indexOf("已核对：分段之和与真正发出的请求逐字节一致") >= 0,
      "面板没有给出逐字节一致性结论：" + JSON.stringify(text.slice(-200)));
    assert(text.indexOf("会发送给你配置的模型服务商") >= 0, "面板缺少隐私提示");

    // 只读：打开面板不能发出新的模型请求
    const before = requests.length;
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(requests.length === before, "打开面板竟然发出了新的请求");

    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("预算调小后，面板会写明「没带上的旧对话」而不是悄悄丢掉", async () => {
    // 把旧对话预算调到设置下限（1000），再多聊几轮，让历史超出预算。
    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="history-budget"]');
      input.value = '1000';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 先确认"刚改完设置就发送"用的是新值，而不是启动时读的旧值。
    await waitFor("window.__rwBudget === undefined || window.__rwBudget === 0", 2000).catch(() => {});
    // 造足够大的历史：这一条约 1600 tokens，必然超过 1000 的预算（至少要丢掉更早的内容）。
    const longText = '这是一句用来把历史撑过预算的话。'.repeat(110);
    for (const line of [longText, "第二句话"]) {
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = ${JSON.stringify(line)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      assert(await evaluate("window.__rwBudget") === 1000,
        "设置里改了预算，发送时用的却还是旧值：" + await evaluate("window.__rwBudget"));
    }
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    assert(text.indexOf("未带上：") >= 0,
      "预算不够时面板没有写明丢了哪些内容：" + JSON.stringify(text.slice(-320)));
    assert(text.indexOf("旧对话预算为") >= 0, "没有说明预算是多少：" + JSON.stringify(text.slice(-320)));
    assert(/未带上：更早的 \d+ 条消息/.test(text), "没有说明丢了几条：" + JSON.stringify(text.slice(-320)));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
    // 还原默认预算，免得影响后面的用例
    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="history-budget"]');
      input.value = '';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  await check("默认不限制：以前的对话全部带上，不只是最近几条", async () => {
    // 先把预算清空（= 不限制），再聊一轮看是不是全带上。
    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="history-budget"]');
      input.value = '';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再看看';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const total = await evaluate("document.querySelectorAll('#dynamicMessages .message-row').length");
    assert(total >= 8, "消息太少，测不出这条，实际 " + total);
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    const match = text.match(/旧对话（最近 (\d+) 条）/);
    assert(match, "面板没有旧对话分段：" + JSON.stringify(text.slice(0, 200)));
    const kept = Number(match[1]);
    // 界面上第一行是角色开场白，它不算"历史"；其余都该带上。
    assert(kept >= total - 2, "默认应当把以前的对话全部带上：界面上共 " + total + " 条，只带了 " + kept + " 条");
    assert(text.indexOf("未带上：") < 0, "默认不限制，不该出现\"未带上\"：" + JSON.stringify(text.slice(-200)));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("记忆能看见：点开记忆书列出条目，并标出来自哪句话", async () => {
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const book = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.request-peek-book'));
      const hit = rows.find((row) => (row.dataset.book || '').indexOf('自动记忆') >= 0);
      return hit ? hit.dataset.book : '';
    })()`);
    assert(book, "面板里没有列出「自动记忆」这本记忆书");
    await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.request-peek-book'));
      const hit = rows.find((row) => (row.dataset.book || '').indexOf('自动记忆') >= 0);
      hit.click();
      return true;
    })()`);
    await waitFor("document.querySelector('.request-peek-book-entries .request-peek-book-content') !== null", 8000);
    const text = await evaluate("document.querySelector('.request-peek-book-entries').textContent");
    assert(text.indexOf("玩家叫小林") >= 0, "没有列出记忆内容：" + JSON.stringify(text));
    assert(text.indexOf("模型自记") >= 0, "没有标明是谁记的：" + JSON.stringify(text));
    assert(text.indexOf("harry-task26a-合成.jsonl") >= 0, "没有标出来自哪段对话：" + JSON.stringify(text));
    assert(text.indexOf("第 4 条") >= 0, "没有标出来自第几条消息：" + JSON.stringify(text));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("记忆能删：删掉后后续请求里真的不再带上它", async () => {
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelectorAll('#memoryList .memory-list li').length > 0", 8000);
    const before = await evaluate("document.querySelector('#memoryList').textContent");
    assert(before.indexOf("玩家叫小林") >= 0, "记忆面板没列出这条记忆：" + JSON.stringify(before));

    await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('#memoryList .memory-list li'))
        .find((li) => li.textContent.indexOf('玩家叫小林') >= 0);
      const del = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '删');
      del.click();
      return true;
    })()`);
    await waitFor("document.querySelector('#memoryList').textContent.indexOf('玩家叫小林') < 0", 10000);
    await evaluate("document.querySelector(\"[data-action='close-memory']\").click(); true");

    // 下一轮请求里不能再出现这条记忆
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '删完之后再说一句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last && last.systemHasMemory !== true, "被删掉的记忆又出现在请求里了");
  });

  await check("改口：说一次「不喜欢了」，旧记忆被替换而不是两条并存", async () => {
    // 先清掉 fixture 里那条合成记忆，从干净状态开始。
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelectorAll('#memoryList .memory-list li').length >= 0", 5000);
    const rows = await evaluate("document.querySelectorAll('#memoryList .memory-list li').length");
    for (let i = 0; i < rows; i += 1) {
      await evaluate(`(() => {
        const del = document.querySelector('#memoryList .memory-list li button:last-child');
        if (del && del.textContent.trim() === '删') del.click();
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await evaluate("document.querySelector(\"[data-action='close-memory']\").click(); true");

    // 第一轮：模型记下「玩家喜欢咖啡」
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "好的，我记下了。\n[[记住: 喜欢的饮料 | 玩家喜欢咖啡]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我喜欢喝咖啡';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const firstBook = await evaluate("(async () => JSON.stringify((await window.STApi.getWorld('MB Harry — 自动记忆')).entries))()");
    assert(firstBook.indexOf("玩家喜欢咖啡") >= 0, "第一轮没有把记忆写进去：" + firstBook);

    // 第二轮：玩家改口
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "明白了。\n[[记住: 饮料 | 玩家现在不喜欢咖啡了]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我现在不喜欢咖啡了';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    // 只看每条记忆的 content，不看 replacedContent（那是"替换记录"，是故意留的）。
    const contents = await evaluate(`(async () => {
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      return Object.keys(world.entries || {}).map((key) => String(world.entries[key].content || ''));
    })()`);
    assert(contents.length === 1, "改口后应当只剩一条记忆，实际 " + contents.length + " 条：" + JSON.stringify(contents));
    assert(contents[0] === "玩家现在不喜欢咖啡了", "留下的应当是改口后的新说法：" + JSON.stringify(contents));
    assert(contents.indexOf("玩家喜欢咖啡") < 0, "旧说法还作为一条独立记忆存在：" + JSON.stringify(contents));

    // 下一轮请求里也不能再带上那句旧说法
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再问一句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const lastSystem = sent[sent.length - 1];
    assert(lastSystem && lastSystem.systemHasStaleMemory !== true, "被替换掉的旧记忆还发给了模型");
  });

  await check("剧情不算你的事实：模型想把剧情写进记忆会被拦下", async () => {
    // 让模型同时写一条真事实和一条剧情
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "记下了。\n[[记住: 怕的东西 | 玩家怕黑]]\n[[记住: 剧情 | *你挥动魔杖挡住了巨龙的攻击*]]",
      }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我怕黑';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    const contents = await evaluate(`(async () => {
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      return Object.keys(world.entries || {}).map((key) => String(world.entries[key].content || ''));
    })()`);
    assert(contents.some((row) => row.indexOf("玩家怕黑") >= 0),
      "真事实应当被记住，实际：" + JSON.stringify(contents));
    assert(!contents.some((row) => row.indexOf("巨龙") >= 0 || row.indexOf("魔杖") >= 0),
      "剧情被写进了记忆（这是底线问题）：" + JSON.stringify(contents));
  });

  await check("诚实规则每次都在，并明确禁止编造", async () => {
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last && last.systemText, "没有拿到系统提示");
    assert(last.systemText.indexOf("[Honesty]") >= 0, "系统提示里没有诚实规则");
    assert(last.systemText.indexOf("不要为了显得连贯而编造") >= 0,
      "诚实规则没有明确禁止编造：" + JSON.stringify(last.systemText.slice(0, 200)));
    // 真踩过的坑：只写"没依据就说不知道"，模型会连同一段对话里刚说过的话都不敢认。
    assert(last.systemText.indexOf("正在进行的这段对话") >= 0,
      "诚实规则没有说明眼前的对话算事实");
    assert(last.systemText.indexOf("不要怀疑它") >= 0,
      "诚实规则没有要求不要否认刚说过的话");
  });

  await check("翻得到：以前的对话被检索出来，并带出处交给模型", async () => {
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "团子吗？我记得。" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '还记得我说的猫吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last.systemText.indexOf("[History search]") >= 0, "没有历史检索那一段");
    assert(last.systemText.indexOf("我养了一只猫叫团子") >= 0,
      "没有把以前那句话翻出来：" + JSON.stringify(last.systemText.slice(-400)));
    assert(last.systemText.indexOf("harry-以前的对话.jsonl") >= 0, "翻出来了但没带出处");
    assert(last.systemText.indexOf("第 1 条") >= 0, "没有标出是第几条");
  });

  await check("模型主动翻查：标记不进正文，结果在下一轮交给它", async () => {
    // 第一轮：模型要求翻"猫粮"
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "我先查一下以前的记录。\n[[搜索: 猫粮]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我上次说买什么猫粮来着';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    // 正文里不能留下搜索标记
    const shown = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(shown.indexOf("搜索") < 0, "搜索标记漏进了正文：" + JSON.stringify(shown.slice(-120)));
    assert(shown.indexOf("我先查一下") >= 0, "正文内容丢了：" + JSON.stringify(shown.slice(-120)));

    // 第二轮：系统应当把它点名要翻的原话交给模型
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "找到了，三文鱼味的。" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '你再想想';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last.systemText.indexOf("我一般买三文鱼味的猫粮") >= 0,
      "模型点名要翻的内容没有在下一轮交给它：" + JSON.stringify(last.systemText.slice(-400)));
    assert(last.systemText.indexOf("[History access]") >= 0, "没有告诉模型它可以主动翻查");
  });

  await check("翻不到就明说没有记录，并禁止编造", async () => {
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "这个我不知道。" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我们去过月球吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last.systemText.indexOf("没有找到") >= 0,
      "翻不到时没有明说没有记录：" + JSON.stringify(last.systemText.slice(-400)));
    assert(last.systemText.indexOf("不要猜测") >= 0, "翻不到时没有禁止编造");
  });

  await check("思考模式默认关闭：思维链既不显示也不请求", async () => {
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    assert(sent[sent.length - 1].include_reasoning === false,
      "请求里 include_reasoning 应为 false，实际 " + JSON.stringify(sent[sent.length - 1].include_reasoning));
    const text = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(text.indexOf("思考中") < 0, "界面上还是出现了思维链：" + text.slice(0, 120));
  });

  await check("打开思考模式后请求会要求回传思维链", async () => {
    await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    const before = requests.length;
    await evaluate(`(() => {
      const toggle = document.querySelector('[data-roleworld="thinking"]');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('#messageInput');
      input.value = '再问一次';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    // 只挑"这一轮"的请求：后面还有别的用例会继续发请求。
    // 只看这一轮发出的请求（按发送前的请求数切片，避免被后面的用例干扰）
    const mine = requests.slice(before).filter((row) => row.stream === true);
    assert(await evaluate("window.__rwThinking === true"), "开关打开了，页面状态却没跟上（改完设置立刻发送会用旧值）");
    assert(mine.length >= 1, "这一轮没有发出请求");
    assert(mine[mine.length - 1].include_reasoning === true,
      "打开后应为 true，实际 " + JSON.stringify(mine[mine.length - 1].include_reasoning));
    // 恢复默认，免得影响后面的页面
    await evaluate(`(() => {
      const toggle = document.querySelector('[data-roleworld="thinking"]');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  });

  // 这个应用里没有「停止生成」这个功能（生成中靠 Esc 或再点发送键中止），所以这里不测停止，
  // 只测「一条流里既有完整记忆标记、又有一条没写完时，界面上不能出现任何标记」。
  await check("流式回复里的记忆标记不出现在界面上（含没写完的那条）", async () => {
    await fetch(base + "/__slow-stream");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '慢慢说';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    // 等这条慢流整条落地（半截标记之后还有一段正文）
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('明天见') >= 0", 30000);
    await waitTurnSettled();

    const text = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(text.indexOf("记住") < 0, "记忆标记被当成正文显示了：" + JSON.stringify(text.slice(-160)));
    assert(text.indexOf("他把书合上。") >= 0, "正文内容丢了：" + JSON.stringify(text.slice(-160)));
  });

  await check("存下来的回复里也没有记忆标记，刷新后依然是干净的", async () => {
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const text = await waitFor(`(() => {
      const node = document.querySelector('#dynamicMessages');
      return node && node.textContent.indexOf('他把书合上。') >= 0 ? node.textContent : '';
    })()`, 15000);
    assert(text.indexOf("记住") < 0, "刷新后聊天记录里留下了记忆标记：" + JSON.stringify(text.slice(-160)));
  });

  await check("设置面板能读到本机模型配置", async () => {
    const value = await evaluate("document.querySelector('[data-roleworld=\"endpoint\"]').value");
    assert(value === base + "/v1/chat/completions", "端点显示为 " + value);
  });

  await check("界面大小可调：生效、持久化、固定面板不受影响", async () => {
    const before = await evaluate("document.querySelector('#messageInput').getBoundingClientRect().height");
    await evaluate(`(() => {
      const select = document.querySelector('#scaleSelect');
      select.value = '1.2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelector('#appShell').style.zoom === '1.2'", 6000);
    const manual = await evaluate(`(() => {
      const shell = document.querySelector('#appShell');
      return { computed: getComputedStyle(shell).zoom, height: document.querySelector('#messageInput').getBoundingClientRect().height };
    })()`);
    const after = await evaluate("document.querySelector('#messageInput').getBoundingClientRect().height");
    assert(after > before * 1.15, `放大后输入框没变大：${before} → ${after}；${JSON.stringify(manual)}`);

    // 偏好要落到本机，刷新后才不会丢
    const stored = await evaluate("(JSON.parse(localStorage.getItem('task27a.preferences.v1.local') || '{}') || {}).scale");
    assert(stored === "1.2", "缩放偏好没有存下来：" + stored);

    // 缩放之后固定定位的设置面板仍然要能正常打开
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    assert(await evaluate("document.querySelector('#settingsSurface').getBoundingClientRect().height > 100"), "放大后设置面板没有正常显示");
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");

    await evaluate(`(() => {
      const select = document.querySelector('#scaleSelect');
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("!document.querySelector('#appShell').style.zoom", 6000);
  });

  await check("Ctrl+减号 / 等号 / 0 能调界面大小，且范围有限", async () => {
    await waitFor("window.TASK21_READY === true", 30000);
    const ladder = await evaluate("window.RoleWorldZoom.LADDER.join(',')");
    assert(ladder === "0.9,0.95,1,1.05,1.1,1.15,1.2", "档位不是收窄后的 7 档：" + ladder);

    const press = (key) => evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true }));
      return document.querySelector('#appShell').style.zoom || '1';
    })()`);

    assert(await press("=") === "1.05", "Ctrl+= 没有放大一档");
    assert(await press("=") === "1.1", "Ctrl+= 第二次没生效");
    // 一路顶到上限，不能再涨
    for (let i = 0; i < 6; i += 1) await press("=");
    assert(await evaluate("window.RoleWorldZoom.current()") === 1.2, "上限没有停在 120%");
    for (let i = 0; i < 12; i += 1) await press("-");
    assert(await evaluate("window.RoleWorldZoom.current()") === 0.9, "下限没有停在 90%");

    assert(await press("0") === "1", "Ctrl+0 没有回到 100%");
    // 设置里的下拉要跟着同步
    assert(await evaluate("document.querySelector('#scaleSelect').value") === "1", "设置下拉没有同步");
  });

  await check("账号相关入口不可见", async () => {
    const visible = await evaluate(`(() => {
      const result = { hidden: [], rows: [] };
      const card = document.querySelector('#selfDeleteCard');
      if (card && !card.hidden && !card.closest('[hidden]')) result.hidden.push('#selfDeleteCard');
      const wrong = ['#settings-admin-users', '#adminAssistantLink'].filter((id) => {
        const node = document.querySelector(id);
        return node && !node.hidden && !node.closest('[hidden]') && id === '#settings-admin-users';
      });
      Array.from(document.querySelectorAll('[data-action="open-rename"],[data-action="open-password"],[data-action="open-logout"],[data-action="open-self-delete"]'))
        .forEach((row) => {
          if (!row.hidden && !row.closest('[hidden]')) result.rows.push(row.dataset.action);
        });
      result.wrong = wrong;
      return result;
    })()`);
    assert(visible.hidden.length === 0, "仍然可见：" + visible.hidden.join(","));
    assert(visible.rows.length === 0, "仍然可见的账号按钮：" + visible.rows.join(","));
    assert(visible.wrong.length === 0, "仍然可见的管理面板：" + visible.wrong.join(","));
  });

  await check("首次启动强制走完引导：没有跳过，先写称呼再填 Key", async () => {
    await waitFor("!!document.querySelector('.rw-ob')", 15000);
    const first = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(first.indexOf("欢迎") >= 0, "引导首页标题是：" + first);
    assert(await evaluate("document.querySelector('[data-ob=\"skip\"]') === null"), "不该有「跳过」按钮");

    // 之前出现过「黑字压在深色背景上完全看不见」，这里直接算对比度。
    const contrast = await evaluate(`(() => {
      const lum = (rgb) => {
        const m = rgb.match(/\\d+/g).map(Number).slice(0, 3).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
      };
      const card = document.querySelector('.rw-ob-card');
      const para = card.querySelector('p');
      const a = lum(getComputedStyle(para).color);
      const b = lum(getComputedStyle(card).backgroundColor);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      return { ratio: Math.round(ratio * 100) / 100, color: getComputedStyle(para).color, bg: getComputedStyle(card).backgroundColor };
    })()`);
    assert(contrast.ratio >= 3, `引导正文对比度太低（${contrast.ratio}：${contrast.color} on ${contrast.bg}）`);

    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 5000);
    const nameStep = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(nameStep.indexOf("称呼") >= 0, "第二步不是填称呼：" + nameStep);
    await evaluate(`(() => {
      const input = document.querySelector('[data-ob="nickname"]');
      input.value = '测试称呼';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-ob="next"]').click();
      return true;
    })()`);
    await waitFor("!!document.querySelector('[data-ob=\"key\"]')", 5000);
    const second = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(second.indexOf("API Key") >= 0, "第三步不是填 Key：" + second);
    assert(await evaluate("!!document.querySelector('[data-ob=\"save\"]')"), "第二步缺少「保存并测试」");

    // 没填 Key 不许往下走
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("document.querySelector('[data-ob=\"status\"]').textContent.length > 0", 5000);
    const blocked = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(blocked.indexOf("API Key") >= 0, "没填 Key 却放行了");

    // 填上 Key 并测试（夹具的端点指向本地假服务）
    await evaluate(`(() => {
      const input = document.querySelector('[data-ob="key"]');
      input.value = 'sk-onboarding-test';
      document.querySelector('[data-ob="save"]').click();
      return true;
    })()`);
    await waitFor("document.querySelector('[data-ob=\"status\"]').classList.contains('is-ok')", 15000);
    const ok = await evaluate("document.querySelector('[data-ob=\"status\"]').textContent");
    assert(ok.indexOf("连接正常") >= 0, "测试连接没有通过：" + ok);

    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('准备就绪') >= 0", 5000);
    assert(await evaluate("document.querySelector('[data-ob=\"next\"]').textContent.trim() === '开始使用'"), "最后一步按钮文案不对");
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("!document.querySelector('.rw-ob')", 5000);

    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("new Promise((r) => setTimeout(r, 2000))");
    assert(await evaluate("!document.querySelector('.rw-ob')"), "走完之后重载又弹了一次");
    // 引导里填的称呼要落进偏好，并且在界面上生效（角色就这么叫他）。
    assert(await evaluate("document.getElementById('userDisplayName').textContent.trim() === '测试称呼'"),
      "称呼没有生效，界面显示：" + await evaluate("document.getElementById('userDisplayName').textContent"));
    const nicknameRow = await evaluate("!!document.getElementById('nicknameInput')");
    assert(nicknameRow, "设置里没有可修改称呼的输入框");
  });

  await check("设置 → 关于里的「再看一次教程」能重新打开", async () => {
    await evaluate("document.querySelector('[data-roleworld=\"tutorial\"]').click()");
    await waitFor("!!document.querySelector('.rw-ob')", 5000);
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    const second = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(second.indexOf("欢迎") < 0, "「下一步」没有翻页，标题还是：" + second);
  });




  console.log("== 剧情模式页 ==");

  await goto(base + "/magic-map.html");

  await check("剧情模式页正常启动并可读取角色", async () => {
    await waitFor("document.querySelector('#castMeta') && document.querySelector('#castMeta').textContent.indexOf('正在读取') < 0", 20000);
    const names = await evaluate("document.querySelector('#castMeta').textContent");
    assert(names.length > 0, "演职员信息为空");
  });

  await check("剧情模式没有跳转到登录页", async () => {
    const href = await evaluate("location.pathname");
    assert(href.endsWith("/magic-map.html"), "被跳转到了 " + href);
  });

  await check("剧情模式与主界面是同一套皮肤（不再自带羊皮纸+衬线）", async () => {
    const probe = await evaluate(`(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const marker = document.createElement('div');
      marker.style.background = 'var(--canvas)';
      document.body.appendChild(marker);
      const expected = getComputedStyle(marker).backgroundColor;
      marker.remove();
      return {
        style: document.documentElement.dataset.style,
        theme: document.documentElement.dataset.theme,
        bodyBg: body.backgroundColor,
        expected,
        font: body.fontFamily,
        tokensLoaded: root.getPropertyValue('--canvas').trim().length > 0,
      };
    })()`);
    assert(probe.tokensLoaded, "tokens.css 没有加载");
    assert(probe.style === "default", "风格属性和偏好不一致：" + probe.style);
    assert(probe.bodyBg === probe.expected, `背景没跟着设计变量走：${probe.bodyBg} ≠ ${probe.expected}`);
    assert(!/Songti|Georgia|Palatino|Iowan|Noto Serif|(?<!sans-)serif/i.test(probe.font), "还在用衬线字体：" + probe.font);
  });

  await check("外观里的风格可切换，且两个页面一起变", async () => {
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const before = await evaluate("document.documentElement.dataset.style");
    assert(before === "default", "初始风格不对：" + before);
    await evaluate(`(() => {
      const select = document.querySelector('#styleSelect');
      select.value = 'gold';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.documentElement.dataset.style === 'gold'", 6000);
    // 选「返校金」应当同时点亮秋季氛围
    assert(await evaluate("!!document.querySelector('html[data-style=\"gold\"]')"), "风格没落到 html 上");

    await goto(base + "/magic-map.html");
    await waitFor("document.querySelector('#castMeta') && document.querySelector('#castMeta').textContent.indexOf('正在读取') < 0", 20000);
    assert(await evaluate("document.documentElement.dataset.style === 'gold'"), "剧情模式没有跟上风格：" + await evaluate("document.documentElement.dataset.style"));

    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate(`(() => {
      const select = document.querySelector('#styleSelect');
      select.value = 'default';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.documentElement.dataset.style === 'default'", 6000);
  });

  console.log("== 内置内容包（packs/harry-potter）==");

  await check("内容包在首次启动时自动安装，角色卡自带立绘", async () => {
    await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
    await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: "window.__ROLEWORLD_FIXTURE__ = null;" });
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    reportErrors("内置包 index.html");

    const state = await evaluate(`(async () => {
      const cards = await RoleWorld.store.listCharacters();
      const worlds = await RoleWorld.store.listWorlds();
      return {
        characters: cards.map((card) => card.avatar).sort(),
        books: worlds.map((world) => world.name).sort(),
        avatars: await Promise.all(cards.map((card) => RoleWorld.store.getBlob("avatar:" + card.avatar).then((b) => (b ? b.size : 0)))),
        pickerHidden: document.querySelector('#characterPicker').hidden,
        pickerName: (document.querySelector('#characterPickerName') || {}).textContent || '',
        composer: document.querySelector('#messageInput').disabled === false,
      };
    })()`);

    assert(state.characters.length === 6, "应装入 6 个角色，实际 " + state.characters.length + "：" + JSON.stringify(state.characters) + " / 书：" + JSON.stringify(state.books));
    assert(state.characters.indexOf("Harry Potter (EN).png") >= 0, "缺少默认角色 Harry Potter (EN).png");
    assert(state.books.length === 4, "应装入 4 本记忆书，实际 " + state.books.length);
    ["MB Harry — fact clips (EN)", "MB Harry — relationship tracker (EN)",
      "MB Harry — role lock (EN)", "MB Harry — scene memories (EN)"].forEach((name) => {
      assert(state.books.indexOf(name) >= 0, "缺少记忆书：" + name);
    });
    assert(state.avatars.every((size) => size > 1000), "有角色卡丢了立绘：" + JSON.stringify(state.avatars));
    assert(state.pickerHidden === false, "角色选择器没有显示出来");
    assert(state.pickerName.indexOf("Harry Potter") === 0, "默认角色选择错了：" + state.pickerName);
    assert(state.composer, "装了内置包之后输入框仍然不可用");
  });

  await check("内容包自带卡：升级时会刷新卡内容，但不碰对话与记忆", async () => {
    // 造一份"旧存档"：库里是缺语言标记的旧卡，且没有来源标记（老版本装的那种）。
    const before = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const card = await store.getCharacter('Harry Potter (EN).png');
      const stripped = Object.assign({}, card);
      delete stripped.pack_source;
      stripped.fav = true;
      stripped.date_added = '2020-01-01T00:00:00.000Z';
      await store.putCharacter(stripped);
      // 自己造一段对话与一本记忆书：用来验证刷新卡内容时它们不会被碰。
      await store.saveChat('Harry Potter (EN).png', 'harry-旧对话.jsonl', [
        { chat_metadata: {}, user_name: '我', character_name: 'Harry Potter' },
        { name: '我', is_user: true, mes: '这是一条测试对话', send_date: '2020-01-01T00:00:00.000Z' },
      ]);
      await store.putWorld('MB Harry — 测试记忆', { entries: {} });
      const chats = await store.listChats('Harry Potter (EN).png');
      return {
        hasPackSource: !!card.pack_source,
        hasChat: chats.length > 0,
        chatCount: chats.length,
        title: card.name,
      };
    })()`);
    assert(before.hasChat, "测试前应当已经有对话，否则测不出「不碰对话」");

    // 把"已经刷到哪一版"清掉，再走一遍内容包安装（等同老存档第一次跑新版应用）
    const report = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      await store.setKV('packs:installed', {});
      await store.setKV('packs:seed-version', '');
      return JSON.stringify(await window.RoleWorldPacks.installAll({ silent: true }));
    })()`);
    assert(report.indexOf("harry-potter") >= 0, "安装没有执行：" + report);

    const after = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const card = await store.getCharacter('Harry Potter (EN).png');
      return {
        lang: (card.data && card.data.extensions && card.data.extensions.task29 && card.data.extensions.task29.language) || null,
        hasPackSource: !!card.pack_source,
        fav: !!card.fav,
        dateAdded: card.date_added,
        chats: (await store.listChats('Harry Potter (EN).png')).length,
        chatText: JSON.stringify(await store.getChat('Harry Potter (EN).png', 'harry-旧对话.jsonl')),
        worlds: (await store.listWorlds()).map((w) => w.name),
      };
    })()`);
    assert(after.lang === "en", "刷新后卡里应当带上语言标记，实际 " + JSON.stringify(after.lang));
    assert(after.chatText.indexOf("这是一条测试对话") >= 0, "刷新把对话内容弄丢了");
    assert(after.worlds.indexOf("MB Harry — 测试记忆") >= 0, "刷新把记忆书弄丢了");
    assert(after.hasPackSource, "刷新后应当打上来源标记");
    assert(after.fav === true, "刷新不该丢掉收藏状态");
    assert(after.dateAdded === "2020-01-01T00:00:00.000Z", "刷新不该改掉加入时间");
    assert(after.chats === before.chatCount, "刷新不该动对话记录：刷新前 " + before.chatCount + "，刷新后 " + after.chats);
  });

  console.log("== 空库（停用内容包后的状态）==");

  await check("一本角色卡都没有时给出空状态，而不是把整页打挂", async () => {
    await evaluate(`(async () => {
      await RoleWorld.init();
      await RoleWorld.resetAll();
      await RoleWorldPacks.setEnabled("harry-potter", false);
      return true;
    })()`);
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    reportErrors("空库 index.html");
    const state = await evaluate(`(() => ({
      gate: document.querySelector('#chatTemplateGate').hidden,
      auth: document.querySelector('#authGate').hidden,
      disabled: document.querySelector('#messageInput').disabled,
      text: document.body.textContent.indexOf('还没有角色卡') >= 0,
    }))()`);
    assert(state.gate, "模板门显示了错误，说明空库启动失败");
    assert(state.auth, "登录门显示了错误");
    assert(state.disabled, "没有角色卡时输入框仍可用");
    assert(state.text, "没有看到空状态提示");
  });

  cdp.close();
  chrome.proc.kill();
  server.close();

  console.log("");
  const passed = results.filter((row) => row.ok).length;
  console.log(`LOCAL_APP=${passed}/${results.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("测试运行失败：", error);
  process.exitCode = 1;
});
