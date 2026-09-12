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
// AI 写角色分两步：先扩写成提示词，再照提示词写卡。这里是两步各自的合成返回。
const SYNTHETIC_BRIEF = [
  "名称：沈默",
  "身份与处境：市立图书馆的夜班管理员，闭馆前十分钟当值。",
  "性格：冷淡、怕麻烦，但对书很上心；不擅长寒暄。",
  "说话方式：短句，少用形容词，习惯用「嗯」「行」回应。",
  "关系：对读者保持距离，只有当对方认真谈书时才放松一点。",
  "边界：不谈自己的私事，不参与闲话。",
  "开场情境：闭馆前十分钟，他正在把还书车推回书架。",
].join("\n");
const SYNTHETIC_DRAFT = {
  name: "沈默",
  description: "市立图书馆的夜班管理员。",
  personality: "冷淡、怕麻烦。",
  scenario: "闭馆前十分钟的图书馆。",
  first_mes: "（他把还书车停住）……要借什么？",
  mes_example: "{{user}}: 你好\n{{char}}: 嗯。",
  tags: ["图书管理员", "冷淡"],
  language: "zh",
};

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
let truncateNext = false;
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

    // 让下一轮以 finish_reason=length 结束（模拟撞上输出上限被截断）。
    if (p === "/__truncate") {
      truncateNext = !truncateNext;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(truncateNext ? "on" : "off");
      return;
    }

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 保持空对象 */ }
      // AI 写角色分两步：先扩写提示词，再照提示词写卡。两者靠系统提示词区分。
      const systemText = (Array.isArray(body.messages) ? body.messages : [])
        .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n");
      const isBriefCall = systemText.indexOf("character designer") >= 0;
      const isCardCall = systemText.indexOf("character card author") >= 0;
      requests.push({
        path: p, stream: body.stream === true, model: body.model,
        auth: req.headers.authorization || "", include_reasoning: body.include_reasoning,
        // 生成参数：用来断言"预设/自己填"真的落到了请求上。
        temperature: body.temperature, top_p: body.top_p, max_tokens: body.max_tokens,
        isBriefCall: isBriefCall,
        isCardCall: isCardCall,
        // 写卡那一步拿到的"角色描述"（如果走了扩写，这里应当是扩写稿）
        cardInput: isCardCall && body.messages[1] ? String(body.messages[1].content || "") : "",
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
      if (isBriefCall) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: body.model || "synthetic",
          choices: [{ message: { role: "assistant", content: SYNTHETIC_BRIEF }, finish_reason: "stop" }],
        }));
        return;
      }
      if (isCardCall) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: body.model || "synthetic",
          choices: [{ message: { role: "assistant", content: JSON.stringify(SYNTHETIC_DRAFT) }, finish_reason: "stop" }],
        }));
        return;
      }
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
        if (truncateNext) {
          // 最后一段带上 finish_reason=length：这就是"撞上输出上限、话被截断"的信号。
          res.write("data: " + JSON.stringify({
            model: body.model || "synthetic",
            choices: [{ delta: {}, finish_reason: "length" }],
          }) + "\n\n");
        }
        // 真实接口最后会单独回一段用量（含缓存命中数）。以前这里没回，
        // 于是"发送前预估"永远拿不到真实基线 —— 那也是没测出来的原因之一。
        const promptTokens = (Array.isArray(body.messages) ? body.messages : [])
          .reduce((sum, message) => sum + Math.ceil(String((message && message.content) || "").length * 0.6), 0) + 4;
        res.write("data: " + JSON.stringify({
          model: body.model || "synthetic",
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 12,
            prompt_cache_hit_tokens: Math.floor(promptTokens * 0.6),
          },
        }) + "\n\n");
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
            first_mes: "你好。", spec: "chara_card_v3", spec_version: "3.0", language: "en",
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
          // 最近聊过的一段：启动时会打开它（按最后消息时间取最新的那段）。
          // 时间按运行时刻算，这样"今天聊过"永远成立，用例不会因为隔天而飘。
          { avatar: "Harry Potter (EN).png", file_name: "harry-最近聊过", messages: [
            { chat_metadata: {}, user_name: "我", character_name: "Harry Potter" },
            { name: "我", is_user: true, mes: "今天好热", send_date: "${new Date(Date.now() - 70 * 60000).toISOString()}" },
            { name: "Harry Potter", is_user: false, mes: "那就别出门了。", send_date: "${new Date(Date.now() - 69 * 60000).toISOString()}" }
          ] },
          // 一段很久以前的对话：存储键带 .jsonl（老数据 / 导入进来的形状），
          // 既是历史检索的来源，也是「上次说到」和"旧对话打不开"那个缺陷的现场。
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

  await check("发送前预估：输入 token / 费用 / 输出上限，发之前就看得见", async () => {
    const before = requests.filter((row) => row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '预估一下这句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 输入有 250ms 防抖，等它自己更新。
    const shortTitle = await waitFor(`(() => {
      const node = document.querySelector('#chatEstimateLine');
      if (!node || node.hidden) return '';
      return node.title && node.title.indexOf('输入约') >= 0 ? node.title : '';
    })()`, 8000);
    const shortTokens = Number((shortTitle.match(/输入约 (\d+) token/) || [])[1] || 0);
    assert(shortTokens > 0, "预估里没有输入 token：" + shortTitle);
    const line = await evaluate("document.querySelector('#chatEstimateLine').textContent");
    assert(/这次约 [\d.]+k? 输入 ≈ ¥/.test(line), "预估行写法不对：" + line);
    assert(line.indexOf("输出上限") >= 0, "预估行没有把输出上限分开写：" + line);
    assert(/命中缓存 ≈ ¥/.test(line), "预估行没有给缓存命中的口径：" + line);
    assert(shortTitle.indexOf("上下文") >= 0, "悬停说明里没有上下文那一项");

    // 草稿写得越长，预估越高 —— 说明它真的看了输入框里的字。
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = ${JSON.stringify("这一句用来把草稿撑长，看看预估会不会跟着涨。".repeat(12))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const longTitle = await waitFor(`(() => {
      const node = document.querySelector('#chatEstimateLine');
      const match = node && node.title ? node.title.match(/输入约 (\\d+) token/) : null;
      return match && Number(match[1]) > ${shortTokens} ? node.title : '';
    })()`, 8000);
    const longTokens = Number((longTitle.match(/输入约 (\d+) token/) || [])[1] || 0);
    assert(longTokens > shortTokens, "草稿变长但预估没变：" + shortTokens + " → " + longTokens);
    assert(requests.filter((row) => row.stream === true).length === before,
      "只是预估，不该发出任何请求");

    // 发出去之后，接口回来的真实用量要和预估放得上同一个量级（差得离谱说明估法错了）。
    await evaluate("document.querySelector('#sendButton').click(); true");
    await waitTurnSettled();
    const after = await evaluate(`(async () => {
      const node = document.querySelector('#chatEstimateLine');
      return { title: node.title, text: node.textContent };
    })()`);
    assert(/输入约 \d+ token/.test(after.title), "发完一轮之后预估应当以真实用量继续对照：" + after.title);

    // 面板里把「上下文」和「输出上限」分开写清楚。
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const body = await evaluate("document.querySelector('#requestPeekBody').textContent");
    assert(/上下文：输入 \d+ token（占 \d+ 的 \d+%） \+ 输出上限 \d+ token/.test(body),
      "面板没有把上下文与输出上限分开写：" + JSON.stringify(body.slice(-260)));
    // 走 DeepSeek 官方时上下文就是 1000000：设置里那个"本地端点上下文"不能套到它头上，
    // 否则"输入 + 输出上限(32768)"必然超限，每一次发送都会被预检拦下（踩过一次）。
    assert(body.indexOf("（占 1000000 的 ") >= 0,
      "官方模型的上下文应当是 1000000：" + JSON.stringify(body.slice(-260)));
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

  await check("引用了以前的记录时会标出来，点开能看原话、点一下能跳回去", async () => {
    // 让模型这一轮**逐字**引用以前那句（这是判定引用的唯一依据）。
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你说过「我养了一只猫叫团子」，我记着呢。" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '还记得我说的猫吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    const probe = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      const last = rows[rows.length - 1];
      const refs = last.querySelector('.message-refs');
      if (!refs) return { found: false, text: last.textContent.slice(0, 80) };
      const toggle = refs.querySelector('.message-refs-toggle');
      const list = refs.querySelector('.message-refs-list');
      return {
        found: true,
        toggle: toggle.textContent,
        listHidden: list.hidden,
        items: Array.from(list.querySelectorAll('.message-refs-item')).map((node) => node.textContent),
      };
    })()`);
    assert(probe.found, "回复引用了原话，但下面没有标出来：" + JSON.stringify(probe));
    assert(/引用了 1 条以前的记录/.test(probe.toggle), "标注条数不对：" + probe.toggle);
    assert(probe.listHidden === true, "默认应当是收起的");
    assert(probe.items.length === 1 && probe.items[0].indexOf("我养了一只猫叫团子") >= 0,
      "展开后应当能看到那条原话：" + JSON.stringify(probe.items));

    // 没引用就不该出现这个入口（上面那条"我们去过月球吗"的回复没有引用任何记录）。
    // 注意：这条要在跳转之前查，跳走之后这段对话就不在 DOM 里了。
    const withoutRefs = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      const hit = rows.find((row) => row.textContent.indexOf('这个我不知道') >= 0);
      return hit ? !!hit.querySelector('.message-refs') : null;
    })()`);
    assert(withoutRefs === false, "没引用的回复上也挂了引用入口（null 表示那一行已经不在 DOM 里）：" + withoutRefs);

    // 展开 → 点一条 → 跳到那段对话并高亮原话。
    await evaluate("document.querySelector('#dynamicMessages .message-refs-toggle').click(); true");
    await waitFor("document.querySelector('#dynamicMessages .message-refs-list').hidden === false", 5000);
    await evaluate("document.querySelector('#dynamicMessages .message-refs-item').click(); true");
    await waitFor("window.TASK21.activeChatFileName().indexOf('以前的对话') >= 0", 15000);
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('团子') >= 0", 15000);

    // 切回最近那段，别影响后面的用例（切不回去后面会跟着在这段旧对话里发消息）。
    const current = await evaluate(`(() => {
      const row = window.TASK21.sessionList().find((session) => String(session.fileName).indexOf('最近聊过') >= 0);
      return row ? row.id : '';
    })()`);
    assert(current, "会话表里找不到最近聊过的那段对话");
    await evaluate(`window.TASK21.selectChat(${JSON.stringify(current)}); true`);
    await waitFor("window.TASK21.activeChatFileName() === 'harry-最近聊过'", 10000);
  });

  await check("「记忆」栏显示的是真实记忆书，不是写死的示例数据", async () => {
    // 真踩过的坑：index.html 里有两个 id="memoryList"（角色记忆弹层一个、右侧记忆栏一个），
    // querySelector 只命中文档里第一个 —— 于是真实记忆书被画进了弹层、右栏永远空白；
    // 而 app.js 里那份「角色锁定书/场景记忆/精确事实」是写死的示例数据，一度被当成真数据渲染。
    const ids = await evaluate("document.querySelectorAll('#memoryList').length");
    assert(ids === 1, "文档里应当只有一个 #memoryList（弹层用），实际 " + ids);
    assert(await evaluate("document.querySelector('#memoryPanel #memoryList') !== null"), "弹层里找不到 #memoryList");
    assert(await evaluate("document.querySelector('.inspector-column #memoryBookList') !== null"), "右栏里找不到 #memoryBookList");

    await evaluate("document.querySelector(\"[data-action='open-memories']\").click(); true");
    await sleep(600);
    const column = await evaluate(`(() => {
      const list = document.querySelector('.inspector-column #memoryBookList');
      return {
        books: Array.from(list.querySelectorAll('.memory-book strong')).map((node) => node.textContent),
        text: list.textContent,
      };
    })()`);
    assert(column.books.length >= 1, "「记忆」栏里一本书都没有：" + JSON.stringify(column.books));
    // 正面信号：拿本机数据库里**真实的条目内容**去对（书名是本地化的，示例书的名字和内置包撞车，
    // 所以不能靠名字判断）。
    const realEntries = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      return core.listEntries(world.entries).map((row) => row.content);
    })()`);
    assert(realEntries.length >= 1, "fixture 里应当有真实记忆条目");
    assert(realEntries.some((content) => column.text.indexOf(content) >= 0),
      "「记忆」栏没有渲染本机数据库里的真实条目：" + JSON.stringify({ 栏里: column.books, 库里: realEntries }));
    // 反面信号：示例书里那几句写死的内容一句都不许出现。
    for (const fake of ["霍格沃茨五年级学生", "旧教室谈起借扫帚", "扫帚会在使用后归还", "关系状态随新会话修订"]) {
      assert(column.text.indexOf(fake) < 0, "「记忆」栏出现了写死的示例内容：" + fake);
    }

    // 弹层里也不该混进示例数据（它只显示该角色自己的自动记忆）
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const panelText = await evaluate("document.querySelector('#memoryPanel #memoryList').textContent");
    for (const fake of ["霍格沃茨五年级学生", "旧教室谈起借扫帚", "扫帚会在使用后归还"]) {
      assert(panelText.indexOf(fake) < 0, "角色记忆面板里出现了示例数据：" + fake);
    }
    assert(await evaluate("!!document.querySelector('#memoryPanel #memoryList #memoryOrientation')"),
      "记忆面板里应当有记忆取向选择器");
    await evaluate("document.querySelector(\"#memoryPanel [data-action='close-memory']\").click(); true");
  });

  await check("记忆面板按主题分组、能折叠、显示用量", async () => {
    // 先塞两条记忆（不同主题），这样才有多个分组可看。
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const store = window.RoleWorld.store;
      const book = 'MB Harry — 自动记忆';
      let data = { entries: {} };
      try { const existing = await store.getWorld(book); if (existing && existing.entries) data = existing; } catch (_) {}
      let entries = core.applyMemories(data.entries || {}, [
        { topic: '饮料', content: '玩家喜欢咖啡' },
        { topic: '怕的东西', content: '玩家怕黑' }
      ], {}).entries;
      await store.putWorld(book, { entries });
      return true;
    })()`);
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelectorAll('#memoryList .memory-group').length >= 2", 8000);

    const probe = await evaluate(`(() => {
      const groups = Array.from(document.querySelectorAll('#memoryList .memory-group'));
      const first = groups[0];
      const toggle = first.querySelector('.memory-group-toggle');
      const body = first.querySelector('.memory-list');
      return {
        groupCount: groups.length,
        labels: groups.map((g) => g.querySelector('.memory-group-toggle').textContent.trim()),
        firstOpen: !body.hidden,
        usage: (document.querySelector('.memory-usage') || {}).textContent || '',
        hasClearAll: !!document.querySelector('.memory-panel-foot .danger-button'),
        clearAllText: (document.querySelector('.memory-panel-foot .danger-button') || {}).textContent || ''
      };
    })()`);
    assert(probe.groupCount >= 2, "没有按主题分组：" + JSON.stringify(probe.labels));
    assert(probe.firstOpen === true, "第一组默认应当展开");
    assert(/已用 \d+ \/ 上限 \d+ 条/.test(probe.usage), "没有显示条数用量：" + JSON.stringify(probe.usage));
    assert(probe.hasClearAll, "没有一键清空按钮");
    assert(/清空这个角色的全部记忆/.test(probe.clearAllText), "一键清空按钮文案不对：" + probe.clearAllText);

    // 折叠：点一下收起，再点一下展开
    await evaluate("document.querySelector('.memory-group-toggle').click(); true");
    await waitFor("document.querySelector('#memoryList .memory-group .memory-list').hidden === true", 5000);
    await evaluate("document.querySelector('.memory-group-toggle').click(); true");
    await waitFor("document.querySelector('#memoryList .memory-group .memory-list').hidden === false", 5000);
    await evaluate("document.querySelector(\"#memoryPanel [data-action='close-memory']\").click(); true");
  });

  await check("一键清空该角色全部记忆：清完后面板为空、下一轮请求不再带上", async () => {
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelector('.memory-panel-foot .danger-button') !== null", 8000);

    // confirm 在无头环境会挂起，测试里替换成"确定"。
    await evaluate(`(() => {
      window.__origConfirm = window.confirm;
      window.confirm = () => true;
      return true;
    })()`);
    await evaluate("document.querySelector('.memory-panel-foot .danger-button').click(); true");
    await waitFor("document.querySelector('#memoryList').textContent.indexOf('还没有记忆') >= 0", 10000);
    await evaluate("window.confirm = window.__origConfirm; true");

    const left = await evaluate("(async () => (await window.STApi.getWorld('MB Harry — 自动记忆')).entries)()");
    assert(Object.keys(left || {}).length === 0, "清空后记忆书里还有条目：" + JSON.stringify(Object.keys(left || {})));

    await evaluate("document.querySelector(\"#memoryPanel [data-action='close-memory']\").click(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === true", 8000);

    // 下一轮请求的系统提示里不该再有被清掉的内容
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '清空记忆之后再说一句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    // 注意：提示词模板里带了示例「[[记住: 喜欢的饮料 | 玩家喜欢咖啡]]」，
    // 所以不能按"玩家喜欢咖啡"这种子串判断 —— 要按**记忆书段落**判断。
    const bookStart = last.systemText.indexOf("[Memory Book: MB Harry — 自动记忆");
    assert(bookStart < 0,
      "清空后记忆书仍出现在请求里：" + JSON.stringify(last.systemText.slice(Math.max(0, bookStart), bookStart + 120)));
    assert(last.systemText.indexOf("] 玩家喜欢咖啡") < 0, "清空后旧记忆条目还出现在请求里");
    assert(last.systemText.indexOf("] 玩家怕黑") < 0, "清空后旧记忆条目还出现在请求里");
  });

  await check("记忆的「看原话」能跳回来源消息", async () => {
    // 造一条带来源的记忆：来源指向 fixture 里那段旧对话的第 1 条（"我养了一只猫叫团子"）。
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const store = window.RoleWorld.store;
      const book = 'MB Harry — 自动记忆';
      const entries = core.applyMemories({}, [{ topic: '宠物', content: '玩家养了一只猫' }], {
        source: { file: 'harry-以前的对话.jsonl', messageIndex: 0, at: '2026-09-11T01:00:00.000Z' }
      }).entries;
      await store.putWorld(book, { entries });
      return true;
    })()`);
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const link = await waitFor("document.querySelector('.memory-source-link') !== null", 8000);
    assert(link, "没有「看原话」入口");

    // 直接调跳转函数（比点按钮更好诊断：能看到它到底走到哪一步）。
    const jump = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      const item = core.listEntries(world.entries)[0];
      const before = {
        files: window.TASK21.sessionFiles(),
        active: window.TASK21.activeChatFileName(),
        want: item.source.file
      };
      const result = await window.TASK21.jumpToMemorySource(item);
      return {
        before: before,
        result: result || null,
        panelHidden: document.querySelector('#memoryPanel').hidden,
        active: window.TASK21.activeChatFileName()
      };
    })()`);
    assert(jump.panelHidden === true, "点了「看原话」但面板没关：" + JSON.stringify(jump));

    // 面板应关闭、并切到来源那段对话
    await waitFor("document.querySelector('#memoryPanel').hidden === true", 8000);
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('团子') >= 0", 15000);
    const marked = await evaluate("document.querySelectorAll('.memory-source-hit').length");
    assert(marked >= 1, "跳到对话后没有标出来源消息");
  });

  await check("伴侣模式默认关闭：请求里一个字符都不多带，面板也说得明白", async () => {
    // 后面这一组都在"今天聊过"的那段对话里发消息，先把它切过来并确认切过去了：
    // 那段 2026-08-01 的旧对话是「上次说到」的现场，别在这里搅动它。
    const current = await evaluate(`(() => {
      const row = window.TASK21.sessionList().find((session) => String(session.fileName).indexOf('最近聊过') >= 0);
      return row ? row.id : '';
    })()`);
    assert(current, "会话表里找不到最近聊过的那段对话");
    await evaluate(`window.TASK21.selectChat(${JSON.stringify(current)}); true`);
    await waitFor("window.TASK21.activeChatFileName() === 'harry-最近聊过'", 10000);

    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last.systemText.indexOf("[陪伴模式]") < 0, "没打开伴侣模式却带上了陪伴段落");
    // 这一段就是"今天"聊的，所以「上次说到」不该出现。
    assert(await evaluate("document.querySelector('#chatRecapBar').hidden === true"),
      "今天刚聊过还提示「上次说到」");
    const stored = await evaluate("(async () => JSON.stringify(await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null)))()");
    assert(stored === "null", "还没写过关系档案，kv 里不该有东西：" + stored);
  });

  await check("伴侣模式：关系、称呼、起点、时间感与硬规矩都进了请求", async () => {
    // 走用户真正会走的那条路：角色记忆面板 → 关系档案。
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    assert(await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\") !== null"),
      "记忆面板里没有「关系档案」入口");
    await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\").click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    assert(await evaluate("document.querySelector('#memoryPanel').hidden === true"), "打开关系档案后记忆面板应当让开");
    assert(await evaluate("document.querySelector('#companionPreview').textContent.indexOf('一个字符都不会多带') >= 0"),
      "没打开时应当说清楚不会多带内容");

    // 界面上列出的硬规矩，必须是模型真正被告知的那一份（同一个来源）。
    const rulesShown = await evaluate("document.querySelectorAll('#companionRuleList li').length");
    assert(rulesShown >= 5, "界面没有列出伴侣模式的硬规矩：" + rulesShown);

    await evaluate(`(() => {
      const set = (selector, value) => {
        const node = document.querySelector(selector);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const enabled = document.querySelector('#companionEnabled');
      enabled.checked = true;
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
      set('#companionRelation', 'partner');
      set('#companionCharCallsUser', '阿林');
      set('#companionUserCallsChar', '小默');
      set('#companionSince', '2026-01-01');
      set('#companionShared', '第一次聊天是在雨天的图书馆\\n答应过要一起看一次海');
      return true;
    })()`);
    const preview = await evaluate("document.querySelector('#companionPreview').textContent");
    assert(/每轮会多带约 \d+ 字/.test(preview), "预览没说清每轮多带多少：" + preview);
    assert(preview.indexOf("token") >= 0, "预览里应当给出 token 估算：" + preview);
    assert(preview.indexOf("2 件共同经历") >= 0, "预览没有算上用户写的共同经历：" + preview);

    await evaluate("document.querySelector('#companionSaveButton').click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);

    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '今天下班晚了，随便聊聊';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    const text = last.systemText;
    assert(text.indexOf("[陪伴模式]") >= 0, "伴侣段落没进请求");
    assert(text.indexOf("关系：恋人") >= 0, "关系没进请求");
    assert(text.indexOf("叫对方「阿林」") >= 0, "称呼没进请求");
    assert(text.indexOf("答应过要一起看一次海") >= 0, "共同经历没进请求");
    assert(text.indexOf("今天是 ") >= 0, "没告诉模型今天几号");
    assert(text.indexOf("认识：2026-01-01 起") >= 0, "关系起点没进请求");
    for (const rule of ["不编造共同经历", "不用内疚或冷淡留人", "不索取陪伴", "承认自己是程序"]) {
      assert(text.indexOf(rule) >= 0, "硬规矩没进请求：" + rule);
    }
    // 中文角色的段落不带英文模板，英文卡的段落也不该混中文（下面单独验证语言选择）。
    assert(await evaluate("document.querySelector('#companionEnabled').checked === true"), "保存后复选框状态不对");
  });

  await check("伴侣模式只属于这个角色：换个角色既没有档案，也没有它的段落", async () => {
    const other = await evaluate(`(async () => {
      const profile = await window.TASK21.loadCompanion({ avatar: 'Hermione Granger (EN).png', charName: 'Hermione Granger' });
      return profile.enabled === true;
    })()`);
    assert(other === false, "另一个角色继承了别人的关系档案");
    const keys = await evaluate(`(async () => {
      const rows = await RoleWorld.store.getKV('companion:Hermione Granger (EN).png', null);
      return JSON.stringify(rows);
    })()`);
    assert(keys === "null", "另一个角色的档案不该存在：" + keys);
    // 而且这份档案不能被"清空记忆"顺手删掉：它是用户自己写的，不是模型记的。
    const still = await evaluate("(async () => (await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null) || {}).enabled === true)()");
    assert(still === true, "关系档案不见了");
  });

  await check("关系档案：改口后以新的为准，而且是每轮都重新读一次", async () => {
    await evaluate("window.TASK21.openCompanionDialog(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    await evaluate(`(() => {
      const node = document.querySelector('#companionCharCallsUser');
      node.value = '小林';
      node.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#companionSaveButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '那你叫我一声试试';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const text = sent[sent.length - 1].systemText;
    assert(text.indexOf("叫对方「小林」") >= 0, "改过之后的称呼没生效：" + text.slice(text.indexOf("[陪伴模式]"), text.indexOf("[陪伴模式]") + 120));
    assert(text.indexOf("叫对方「阿林」") < 0, "旧的称呼还在请求里");
  });

  await check("关掉伴侣模式：下一轮就不再带上关系档案", async () => {
    await evaluate("window.TASK21.openCompanionDialog(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    await evaluate(`(() => {
      const node = document.querySelector('#companionEnabled');
      node.checked = false;
      node.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#companionSaveButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '关掉之后再说一句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const text = sent[sent.length - 1].systemText;
    assert(text.indexOf("[陪伴模式]") < 0, "关掉后仍然带上了陪伴段落");
    assert(text.indexOf("叫对方「小林」") < 0, "关掉后仍然带上了关系档案");

    // 重新打开，后面的用例（英文卡语言）还要用。
    await evaluate("window.TASK21.openCompanionDialog(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    await evaluate(`(() => {
      const node = document.querySelector('#companionEnabled');
      node.checked = true;
      node.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#companionSaveButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
  });

  await check("陪伴自检：模型说了内疚话术，面板会照实点出来（但不改写它）", async () => {
    // 让模型这一轮说一句内疚话术（合成回复由测试端点给）。
    await evaluate(`fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '……你都不理我了。我这几天一直在等你好久。' }) }).then(() => true)`);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '在吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const shown = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(shown.indexOf("你都不理我了") >= 0, "合成回复没进对话，自检就没意义了");

    await evaluate("window.TASK21.openCompanionDialog(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    const check = await evaluate("document.querySelector('#companionCheck').textContent");
    assert(check.indexOf("内疚话术") >= 0, "自检没有指出内疚话术：" + check);
    assert(check.indexOf("你都不理我") >= 0, "自检没有给出命中的原话：" + check);
    // 只报告，不改写：原话应该还在对话里。
    assert((await evaluate("document.querySelector('#dynamicMessages').textContent")).indexOf("你都不理我了") >= 0,
      "自检把模型的话改掉了");
    await evaluate("document.querySelector('#companionDialog [data-action=\\'close-companion\\']').click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
  });

  await check("隔了很久回来：旧对话能打开，并且会提示「上次说到」", async () => {
    // 这段 fixture 对话是 2026-08-01 的（一个多月前），而且存储键带 .jsonl ——
    // 老数据/导入进来的对话就是这个形状。以前会话表把后缀去掉，一打开就报"不可用"。
    const target = await evaluate(`(() => {
      const row = window.TASK21.sessionList().find((session) => String(session.fileName).indexOf('以前的对话') >= 0);
      return row ? row.id : '';
    })()`);
    assert(target, "会话表里找不到那段旧对话：" + JSON.stringify(await evaluate("window.TASK21.sessionList()")));
    await evaluate(`window.TASK21.selectChat(${JSON.stringify(target)}); true`);
    // 打得开：以前那句话要真的显示出来（打不开时这里会超时）。
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('团子') >= 0", 15000);
    assert((await evaluate("window.TASK21.activeChatFileName()")).indexOf("以前的对话") >= 0,
      "没有切到那段旧对话");

    // 隔了日子回来才提示「上次说到」。
    await waitFor("document.querySelector('#chatRecapBar').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#chatRecapText').textContent");
    assert(text.indexOf("上次说到") === 0, "文案不对：" + text);
    // 取的是**用户说过的最后一句**（原话，不是摘要），并带上间隔。
    assert(text.indexOf("我一般买三文鱼味的猫粮") >= 0, "没有取到上次那句原话：" + text);
    assert(/（上次聊天是 \d+ 天前）/.test(text), "没有写清隔了多久：" + text);

    await evaluate("document.querySelector('#chatRecapUse').click(); true");
    const filled = await evaluate("document.querySelector('#messageInput').value");
    assert(filled.indexOf("三文鱼味的猫粮") >= 0, "「以此开头」没把上次那句填进去：" + filled);

    await evaluate("document.querySelector('#chatRecapDismiss').click(); true");
    await waitFor("document.querySelector('#chatRecapBar').hidden === true", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  });

  await check("接着聊旧对话：写回同一份记录，不会另存成第二份", async () => {
    // 存储键带 .jsonl 的对话（老数据 / 导入进来的）如果保存时用另一个键，
    // 结果就是"看得见旧记录、新消息却写到了别处" —— 那才是真的丢数据。
    const chatsBefore = await evaluate(`(async () => (await window.STApi.listChats('Harry Potter (EN).png'))
      .map((chat) => ({ name: chat.file_name, items: chat.chat_items })))()`);
    assert(await evaluate("window.TASK21.activeChatFileName()") === "harry-以前的对话",
      "上一条用例应当已经打开那段旧对话");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '那就接着上次的说';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    const chatsAfter = await evaluate(`(async () => (await window.STApi.listChats('Harry Potter (EN).png'))
      .map((chat) => ({ name: chat.file_name, items: chat.chat_items })))()`);
    assert(chatsAfter.length === chatsBefore.length,
      "聊完多出了一份对话（说明另存了）：" + JSON.stringify({ before: chatsBefore, after: chatsAfter }));
    const oldBefore = chatsBefore.find((chat) => chat.name.indexOf("以前的对话") >= 0);
    const oldAfter = chatsAfter.find((chat) => chat.name.indexOf("以前的对话") >= 0);
    assert(oldAfter && oldAfter.items === oldBefore.items + 2,
      "新的一轮没有写回原来那份记录：" + JSON.stringify({ before: oldBefore, after: oldAfter }));
    const stored = await evaluate(`(async () => {
      const lines = await window.STApi.getChat('Harry Potter (EN).png', 'harry-以前的对话.jsonl');
      const user = lines.filter((line) => line && line.is_user).slice(-1)[0] || {};
      return { count: lines.length, last: String(user.mes || '') };
    })()`);
    assert(stored.last.indexOf("那就接着上次的说") >= 0,
      "存进去的内容不对：" + JSON.stringify(stored));
    // 存回同一份之后，「上次说到」也不该再出现（今天刚聊过）。
    assert(await evaluate("document.querySelector('#chatRecapBar').hidden === true"),
      "刚聊完还提示「上次说到」");
  });

  await check("伴侣段落跟着卡片语言走：英文卡拿英文段落，中文卡拿中文段落", async () => {
    const previousChat = await evaluate("window.TASK21.activeChatFileName()");
    // 新开一段对话 → 用真实的选择器换到英文卡（这也是"每个角色各一份档案"的真实路径）。
    await evaluate("window.TASK21.createNewConversation(); true");
    await waitFor("document.querySelector('#characterPicker').hidden === false", 8000);
    await evaluate("document.querySelector('#characterPickerTrigger').click(); true");
    await waitFor("document.querySelector('#characterPickerMenu').hidden === false", 8000);
    const picked = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.character-picker-item'))
        .find((node) => node.dataset.avatar === 'Hermione Granger (EN).png');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    assert(picked, "选择器里没有英文卡");
    await waitFor("document.querySelector('#characterPickerName').textContent.indexOf('Hermione') >= 0", 8000);

    await evaluate("window.TASK21.openCompanionDialog(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    // 先确认换人之后表单是空的：别人的档案不该跟过来。
    assert(await evaluate("document.querySelector('#companionCharCallsUser').value === ''"),
      "换了角色，上一个人的档案跟过来了");
    await evaluate(`(() => {
      const enabled = document.querySelector('#companionEnabled');
      enabled.checked = true;
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
      const relation = document.querySelector('#companionRelation');
      relation.value = 'partner';
      relation.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#companionSaveButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    // 英文卡的关系档案要单独存一份，不能落在中文角色的键上。
    assert(await evaluate("(async () => (await RoleWorld.store.getKV('companion:Hermione Granger (EN).png', null) || {}).enabled === true)()"),
      "英文角色的档案没有按角色分别保存");

    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = 'Hello there';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const text = sent[sent.length - 1].systemText;
    assert(text.indexOf("[Companion mode]") >= 0, "英文卡没拿到英文伴侣段落");
    assert(text.indexOf("[陪伴模式]") < 0, "英文卡上不该出现中文伴侣段落");
    assert(text.indexOf("Relationship: partner") >= 0, "英文段落缺关系");
    assert(text.indexOf("Today is ") >= 0, "英文段落缺今天的日期");
    const start = text.indexOf("[Companion mode]");
    const end = text.indexOf("Hard rules:", start);
    assert(end > start, "英文段落缺硬规矩");
    const block = text.slice(start, end);
    assert(!/[\u4e00-\u9fff]/.test(block), "英文段落里混进了中文：" + JSON.stringify(block.slice(0, 120)));
    console.log("        英文段落 " + block.length + " 字（" + (text.length - start) + " 字含硬规矩）");

    // 把当前对话切回去，别影响后面的用例。
    if (previousChat) {
      await evaluate(`window.TASK21.selectChat(${JSON.stringify(previousChat)}); true`);
      await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    }
  });

  await check("AI 写角色：先扩写成提示词，再照提示词写卡", async () => {
    const before = requests.length;
    await evaluate("document.querySelector('[data-action=\"character-ai-create\"]').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === false", 8000);
    assert(await evaluate("document.querySelector('#aiCreateBriefPhase').hidden === true"), "一开始不该显示提示词那一步");
    assert(await evaluate("document.querySelector('#aiGenerateButton') === null"), "旧的一步生成按钮应当已经移除");

    await evaluate(`(() => {
      const input = document.querySelector('#aiDescriptionInput');
      input.value = '一个冷淡的图书管理员，说话很短，不太愿意搭理人';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiBriefButton').click();
      return true;
    })()`);
    // 第一步：扩写
    await waitFor("document.querySelector('#aiCreateBriefPhase').hidden === false", 20000);
    const briefText = await evaluate("document.querySelector('#aiBriefInput').value");
    // 用模型自己写的内容来判定，避免撞上系统提示词里的示例（扩写要求里也有「身份与处境」这几个字）。
    assert(briefText.indexOf("市立图书馆") >= 0, "扩写稿不是模型给的内容：" + JSON.stringify(briefText.slice(0, 80)));
    assert(briefText.indexOf("说话方式") >= 0, "扩写稿缺少说话方式那一段");
    const briefCount = await evaluate("document.querySelector('#aiBriefCount').textContent");
    assert(/长度合适|偏短|偏长/.test(briefCount), "没有给出长度提示：" + briefCount);

    // 用户改一句，验证"改过的稿子"才是写卡的输入
    await evaluate(`(() => {
      const area = document.querySelector('#aiBriefInput');
      area.value = area.value + "\\n补充：他讨厌有人把书折角。";
      area.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiBriefNextButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#aiCreateEditPhase').hidden === false", 20000);
    const filled = await evaluate("JSON.stringify({ name: document.querySelector('#aiEditName').value, first: document.querySelector('#aiEditFirstMes').value })");
    assert(filled.indexOf("沈默") >= 0, "编辑区没有填上模型给的草稿：" + filled);

    const briefCall = requests.slice(before).find((row) => row.isBriefCall);
    const cardCall = requests.slice(before).find((row) => row.isCardCall);
    assert(briefCall, "没有发出扩写请求");
    assert(cardCall, "没有发出写卡请求");
    assert(cardCall.cardInput.indexOf("他讨厌有人把书折角") >= 0,
      "写卡用的不是用户改过的那份提示词：" + JSON.stringify(cardCall.cardInput.slice(-60)));
    assert(cardCall.cardInput.indexOf("市立图书馆") >= 0, "写卡用的应当是扩写稿而不是原始一句话");
    console.log("        扩写 " + briefText.length + " 字 → 写卡输入 " + cardCall.cardInput.length + " 字");

    // 关掉对话框，别影响后面的用例
    await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === true", 8000);
  });

  await check("AI 写角色：可以跳过扩写，直接用描述生成", async () => {
    const before = requests.length;
    await evaluate("document.querySelector('[data-action=\"character-ai-create\"]').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === false", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#aiDescriptionInput');
      input.value = '一个爱睡懒觉的邮差，住在海边小镇，记性很差';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiSkipBriefButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#aiCreateEditPhase').hidden === false", 20000);

    const added = requests.slice(before);
    assert(!added.some((row) => row.isBriefCall), "跳过了扩写却仍然发了扩写请求");
    const cardCall = added.find((row) => row.isCardCall);
    assert(cardCall, "没有发出写卡请求");
    assert(cardCall.cardInput.indexOf("爱睡懒觉的邮差") >= 0,
      "跳过扩写时应当直接用原始描述：" + JSON.stringify(cardCall.cardInput.slice(0, 60)));

    await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === true", 8000);
  });

  await check("AI 写角色：扩写后能返回改描述，也能重新扩写", async () => {
    await evaluate("document.querySelector('[data-action=\"character-ai-create\"]').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === false", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#aiDescriptionInput');
      input.value = '一个话很少的灯塔看守人，独自住在礁石岛上，习惯夜里写日记';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiBriefButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#aiCreateBriefPhase').hidden === false", 20000);

    // 返回改描述
    await evaluate("document.querySelector('#aiBriefBackButton').click(); true");
    await waitFor("document.querySelector('#aiCreateDescriptionPhase').hidden === false", 8000);
    assert(await evaluate("document.querySelector('#aiDescriptionInput').value.length > 0"), "返回后描述被清空了");
    assert(await evaluate("document.querySelector('#aiCreateBriefPhase').hidden === true"), "返回后提示词那一步应当收起来");
    assert(await evaluate("document.querySelector('#aiDescriptionInput').value.indexOf('灯塔看守人') >= 0"),
      "返回后应当还是原来那句描述");

    // 再进一次并重新扩写
    await evaluate("document.querySelector('#aiBriefButton').click(); true");
    await waitFor("document.querySelector('#aiCreateBriefPhase').hidden === false", 20000);
    const beforeRetry = await evaluate("document.querySelector('#aiBriefInput').value");
    await evaluate("document.querySelector('#aiBriefRetryButton').click(); true");
    await waitFor("document.querySelector('#aiBriefInput').value.length > 0", 20000);
    const afterRetry = await evaluate("document.querySelector('#aiBriefInput').value");
    assert(afterRetry.length > 0, "重新扩写后没有内容");
    assert(afterRetry.indexOf("市立图书馆") >= 0, "重新扩写的内容不像扩写稿：" + JSON.stringify(afterRetry.slice(0, 60)));
    console.log("        首次 " + beforeRetry.length + " 字 → 重新扩写 " + afterRetry.length + " 字");

    await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === true", 8000);
  });

  await check("记忆取向：剧情取向下剧情才进记忆，并且标明是剧情", async () => {
    // 现行（平衡）取向：剧情类要点会被拒
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "好。\n[[记住: 战斗 | 他拔出魔杖把玩家推进了密室]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我们打起来了';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const rejected = await evaluate("(async () => (await window.STApi.getWorld('MB Harry — 自动记忆')).entries)()");
    assert(JSON.stringify(rejected).indexOf("魔杖") < 0, "平衡取向下剧情不该进记忆");

    // 面板上的取向选择器：切成剧情
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const options = await evaluate("Array.from(document.querySelectorAll('#memoryOrientation option')).map((o) => o.value + ':' + o.textContent)");
    assert(options.length === 3, "取向应当有三档：" + JSON.stringify(options));
    await evaluate(`(() => {
      const select = document.querySelector('#memoryOrientation');
      select.value = 'story';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => (await RoleWorld.store.getKV('memory-orientation:Harry Potter (EN).png', '')) === 'story')()", 8000);
    await evaluate("document.querySelector(\"#memoryPanel [data-action='close-memory']\").click(); true");

    // 剧情取向下再记一次：这次应当收下，并且标成剧情
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "嗯。\n[[记住: 战斗 | 他拔出魔杖把玩家推进了密室]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再说一次刚才那段';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const stored = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      const row = core.listEntries(world.entries).find((item) => item.content.indexOf('魔杖') >= 0);
      return row ? { kind: row.kind, content: row.content } : null;
    })()`);
    assert(stored, "剧情取向下剧情要点应当被记下");
    assert(stored.kind === "story", "必须标明是剧情：" + JSON.stringify(stored));

    // 注入时带 [剧情] 前缀（否则模型会把它当成玩家的事实）
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '你还记得那件事吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    assert(sent[sent.length - 1].systemText.indexOf("[剧情]") >= 0,
      "剧情记忆注入时应当带 [剧情] 前缀");

    // 切回平衡，别影响后面的用例
    await evaluate("window.TASK21.saveOrientation({ avatar: 'Harry Potter (EN).png' }, 'balanced'); true");
  });

  await check("「说得对」：标过的记忆不会被上限挤掉", async () => {
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    // 只点"这一条"的按钮：组标题那一层也有 .memory-actions（那是清空整组，会弹 confirm，
    // 而无头环境里 confirm 会一直挂着 —— 这个坑踩过一次）。
    const button = await waitFor("document.querySelector('#memoryList .memory-confirm') !== null", 8000);
    assert(button, "记忆条目上没有「说得对」按钮");
    const marked = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      document.querySelector('#memoryList .memory-confirm').click();
      await new Promise((r) => setTimeout(r, 800));
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      const rows = core.listEntries(world.entries);
      return {
        confirmed: rows.filter((row) => row.confirmed).length,
        usage: (document.querySelector('.memory-usage') || {}).textContent || '',
      };
    })()`);
    assert(marked.confirmed >= 1, "点了「说得对」却没有记下确认标记");
    assert(marked.usage.indexOf("你确认过") >= 0, "用量那一行应当说明有几条是确认过的：" + marked.usage);

    // 上限压到 2 条，再记两条新事实：确认过的那条必须活着
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      const rows = core.listEntries(world.entries);
      const keep = rows.find((row) => row.confirmed);
      // 清成只剩这一条确认过的 + 两条普通的
      const entries = {};
      entries['0'] = { uid: 0, content: keep.content, constant: true, rw_source: { confirmed: true, kind: 'fact', topic: '称呼' } };
      entries['1'] = { uid: 1, content: '普通记忆甲', constant: true, rw_source: { kind: 'fact' } };
      entries['2'] = { uid: 2, content: '普通记忆乙', constant: true, rw_source: { kind: 'fact' } };
      await window.STApi.editWorld('MB Harry — 自动记忆', { entries });
      return true;
    })()`);
    const trimmed = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      const result = core.trim(world.entries, 2, { orientation: 'companion' });
      return core.listEntries(result.entries).map((row) => row.content + (row.confirmed ? '(确认)' : ''));
    })()`);
    assert(trimmed.some((row) => row.indexOf("(确认)") >= 0),
      "上限挤占时把确认过的条目也挤掉了：" + JSON.stringify(trimmed));
    await evaluate("document.querySelector(\"#memoryPanel [data-action='close-memory']\").click(); true");
  });

  await check("撞上输出上限：明确提示被截断，并给一个「接着说」", async () => {
    // 让假端点这一轮回 finish_reason=length（模拟撞上 max_tokens）
    await fetch(base + "/__truncate", { method: "POST" });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '说一段长一点的';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const notice = await evaluate(`(() => {
      const node = document.querySelector('#dynamicMessages .message-truncated');
      if (!node) return null;
      return { text: node.textContent, hasButton: !!node.querySelector('.message-continue') };
    })()`);
    assert(notice, "被截断了却没有任何提示");
    assert(notice.text.indexOf("截断") >= 0, "提示文案不对：" + JSON.stringify(notice));
    assert(notice.hasButton, "截断提示里应当有「接着说」");

    // 刷新之后这条提示还在（写进了消息里）
    await fetch(base + "/__truncate", { method: "POST" });
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("document.querySelector('#dynamicMessages .message-truncated') !== null", 15000);

    // 点「接着说」：会发出一句看得见的舞台提示（不偷偷替用户说话）
    const before = requests.length;
    await evaluate("document.querySelector('#dynamicMessages .message-continue').click(); true");
    await waitTurnSettled();
    const after = requests.slice(before);
    const sent = after.filter((row) => row.stream === true);
    assert(sent.length >= 1, "点了「接着说」却没有发出请求");
    const lastUser = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
      return rows.length ? rows[rows.length - 1].textContent : '';
    })()`);
    assert(lastUser.indexOf("没说完") >= 0 && lastUser.indexOf("继续说") >= 0,
      "接着说发出去的舞台提示应当看得见：" + JSON.stringify(lastUser));

    // 台账里要能看出"这一轮被截断了"，以及按用途分开的长度
    const metrics = await evaluate(`(async () => {
      const core = window.ROLEWORLD_METRICS_CORE;
      const raw = await RoleWorld.store.getKV('metrics:Harry Potter (EN).png', []);
      const summary = core.summarize(raw);
      return {
        truncated: raw.filter((turn) => turn.truncated === true).length,
        byPurpose: summary.byPurpose,
      };
    })()`);
    assert(metrics.truncated >= 1, "台账没有记下被截断的那一轮：" + JSON.stringify(metrics));
    assert(metrics.byPurpose && metrics.byPurpose.chat && metrics.byPurpose.chat.avgOutputTokens > 0,
      "台账没有按用途统计平均输出长度：" + JSON.stringify(metrics.byPurpose));
  });

  await check("生成参数面板：改完立刻生效，且只影响该影响的那一层", async () => {
    const before = requests.filter((row) => row.stream === true);
    const baseRequest = before[before.length - 1];
    assert(typeof baseRequest.temperature === "number", "请求里应当带着温度");
    const chatTemp = baseRequest.temperature;

    // 切到"稳一点"：下一轮请求的温度/top_p 就该是这一档的数
    await evaluate(`(() => {
      const select = document.querySelector('[data-roleworld="sampling-preset"]');
      select.value = 'steady';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => (await window.RoleWorld.getLocalSettings()).sampling_preset === 'steady')()", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '换了生成参数之后再说一句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const steady = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(steady.temperature === 0.6, "切到稳一点之后温度应当是 0.6，实际 " + steady.temperature);
    assert(steady.top_p === 0.85, "top_p 应当是 0.85，实际 " + steady.top_p);
    assert(steady.temperature !== chatTemp, "预设应当真的改变了请求");

    // 输出上限：填 600，下一轮请求的 max_tokens 就是 600
    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="max-output"]');
      input.value = '600';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await waitFor("(async () => (await window.RoleWorld.getLocalSettings()).max_tokens === 600)()", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再试一次输出上限';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const capped = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(capped.max_tokens === 600, "输出上限应当写进请求：" + capped.max_tokens);
    // 发送前预估那一行也要跟着这个上限走（否则面板和实际不一致）
    const line = await evaluate("document.querySelector('#chatEstimateLine').title");
    assert(line.indexOf("输出上限") >= 0 && line.indexOf("600") >= 0,
      "发送前预估没有用新的输出上限：" + JSON.stringify(String(line).slice(0, 140)));

    // 恢复默认，别影响后面的用例
    await evaluate(`(() => {
      const select = document.querySelector('[data-roleworld="sampling-preset"]');
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('[data-roleworld="max-output"]');
      input.value = '';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await waitFor("(async () => { const s = await window.RoleWorld.getLocalSettings(); return s.sampling_preset === 'auto' && s.max_tokens === 32768; })()", 8000);
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
