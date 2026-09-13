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

    // 假中转：只实现「查额度」这一个接口，用来验证应用侧的体验卡流程。
    if (p === "/relay/card/quota") {
      const auth = String(req.headers.authorization || "");
      const ok = auth === "Bearer RW-AAAAA-BBBBB-CCCCC";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(ok
        ? { ok: true, id: "test-card", label: "测试", quota: { calls: 5, tokens: 5000 }, used: { calls: 1, tokens: 120 },
            callsLeft: 4, tokensLeft: 4880, expiresAt: "2026-10-12T00:00:00.000Z" }
        : { error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识" } }));
      return;
    }

    // 假中转的聊天口：用来验证"用体验卡真的能聊"，并且逐轮回剩余次数。
    if (p === "/relay/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const auth = String(req.headers.authorization || "");
      if (auth !== "Bearer RW-AAAAA-BBBBB-CCCCC") {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了，或者已经被收回。" } }));
        return;
      }
      requests.push({ path: p, relay: true, relayCard: auth.slice(-5) });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "x-rw-card-calls-left,x-rw-card-tokens-left,x-rw-card-expires,x-rw-card-id",
        "x-rw-card-calls-left": "3",
        "x-rw-card-tokens-left": "4800",
        "x-rw-card-expires": "2026-10-12T00:00:00.000Z",
        "x-rw-card-id": "test-card",
      });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "好呀，" } }] }) + "\n\n");
      await sleep(30);
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "我们出发吧。" } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
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
        // 事件记忆：注入时必须带 [此前发生]，否则模型会把剧情经过当成玩家的现实信息。
        systemHasEvent: Array.isArray(body.messages)
          && body.messages.some((m) => m && m.role === "system" && String(m.content || "").indexOf("[此前发生]") >= 0),
        // 被替换掉的旧说法不该再出现（"玩家喜欢咖啡" 会误匹配新说法，所以用更精确的判断）
        systemHasStaleMemory: Array.isArray(body.messages)
          && body.messages.some((m) => m && m.role === "system"
            && /玩家喜欢咖啡/.test(String(m.content || ""))
            && String(m.content || "").indexOf("玩家现在不喜欢咖啡了") < 0),
        // 系统提示全文（只给测试用，用来检查诚实规则与历史检索那段）
        systemText: (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n"),
        // 最后两条消息：用来确认"语言提醒"确实紧贴在用户这句话之前
        tailMessages: (Array.isArray(body.messages) ? body.messages : []).slice(-2)
          .map((m) => ({ role: m && m.role, text: String((m && m.content) || "").slice(0, 80) })),
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
          // 这张卡**故意不写语言标记**：没有语言约束就是"跟着玩家说"，
          // 也是伴侣段落走中文那条路的唯一现场（英文标记的卡下面 Hermione 有，那条路另有用例）。
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
            "0": { uid: 0, key: ["哈利"], keysecondary: [], comment: "测试条目", content: "合成记忆内容", disable: false, constant: false },
            // 内置包旧版带的"别人的存档"（原 SillyTavern 存档里的玩家角色 Lin）：
            // 启动时应当被 adapter/pack-cleanup.js 清掉，而上面那条用户条目要留下。
            "mb-fact-home": { uid: "mb-fact-home", key: ["Shanghai"], keysecondary: [], comment: "[STMB] 示例",
                              content: "Lin's home city is Shanghai, China. She grew up there before coming to Hogwarts.",
                              disable: false, constant: true } } },
          // 整本都是示例的书：清空之后应当连书一起删掉。
          { name: "MB Harry — scene memories (EN)", entries: {
            "mb-scene-meeting": { uid: "mb-scene-meeting", key: [], keysecondary: [], comment: "[STMB] 示例",
                                  content: "Lin, a new Muggle-born student from Shanghai, nervously asked Harry Potter for directions to the Gryffindor common room.",
                                  disable: false, constant: false } } },
          // 一条合成的"自动记忆"，带来源：验证面板能显示它记了什么、来自哪句话，并能删掉。
          // comment 故意用内置包里那种迁移痕迹（[STMB] + 转换器说明）：
          // 它不该被当成标题显示到界面上（2026-09-12 用户就是这么看到一句英文的）。
          { name: "MB Harry — 自动记忆", entries: {
            "1": { uid: 1, key: [], keysecondary: [], comment: "[STMB] Human confirmation edit: correction narrative removed so no superseded value appears in prompt context.", content: "玩家叫小林",
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
          model: "deepseek-flash",
          // 主流程用例假定"引导已经走完"：否则首启导览浮层（.rw-ob）会盖住整个界面，
          // 用户点不到顶栏那颗「记忆」。引导本身另有专门用例（清空状态后重新走一遍）。
          tutorial_seen: true
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

  await check("启动时清掉内置包自带的示例记忆（别人的存档），用户自己的条目一条不动", async () => {
    const worlds = await evaluate("(async () => (await RoleWorld.store.listWorlds()).map((w) => w.name))()");
    assert(worlds.indexOf("MB Harry — scene memories (EN)") < 0,
      "整本都是示例的记忆书应当被删掉：" + JSON.stringify(worlds));
    assert(worlds.indexOf("MB Harry — fact clips (EN)") >= 0, "里面还有用户条目的书不该被删：" + JSON.stringify(worlds));
    const entries = await evaluate("(async () => Object.keys((await RoleWorld.store.getWorld('MB Harry — fact clips (EN)')).entries).sort())()");
    assert(JSON.stringify(entries) === JSON.stringify(["0"]), "示例条目该清掉、用户条目该留下：" + JSON.stringify(entries));
    const record = await evaluate("(async () => (await RoleWorld.store.getKV('packs:last-sample-cleanup', null)) || null)()");
    assert(record && Number(record.removed) >= 2, "应当留下可查的清理记录：" + JSON.stringify(record));
    const notice = await evaluate("(async () => (await RoleWorld.store.getKV('packs:sample-cleanup-notice', null)) || null)()");
    assert(notice === null, "一次性提示键应当已被界面消费掉：" + JSON.stringify(notice));
    const toast = await evaluate("(document.querySelector('#toast') || {}).textContent || ''");
    assert(toast.indexOf("示例记忆") >= 0, "启动时要顺口说清楚清掉了什么：" + JSON.stringify(toast));
  });

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

  // 2026-09-12：用户反馈"看不到记忆"。根因是顶栏那颗「记忆」按钮自带 hidden，
  // 而且没有任何代码把它摘掉——右栏只能靠 window.TASK21.openMemoryPanel() 打开。
  // 以前的用例全都是调内部函数，所以一次也没碰到这个入口。
  await check("顶栏「记忆」按钮看得见、点得开（不是只有内部函数能开记忆栏）", async () => {
    const hit = await evaluate(`(() => {
      const button = document.querySelector('.topbar-actions [data-action="open-memories"]');
      if (!button) return { problem: '顶栏里根本没有「记忆」按钮' };
      const style = getComputedStyle(button);
      if (button.hidden || style.display === 'none' || style.visibility === 'hidden') {
        return { problem: '「记忆」按钮是隐藏的（hidden=' + button.hidden + '，display=' + style.display + '）' };
      }
      const rect = button.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 14) {
        return { problem: '「记忆」按钮没有可点面积：' + Math.round(rect.width) + '×' + Math.round(rect.height) };
      }
      if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
        return { problem: '「记忆」按钮在视口外：' + JSON.stringify({ x: Math.round(rect.x), y: Math.round(rect.y) }) };
      }
      const cover = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (cover !== button && !button.contains(cover)) {
        return { problem: '「记忆」按钮被别的元素挡住：' + (cover ? (cover.className || cover.tagName) : 'null') };
      }
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    assert(!hit.problem, hit.problem);

    // 用真鼠标点：hidden 元素用 element.click() 照样会触发事件，所以上面那组几何检查才是这条用例的关键。
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.sessionSend(session, "Input.dispatchMouseEvent", { type, x: hit.x, y: hit.y, button: "left", clickCount: 1 });
    }
    await waitFor("document.querySelector('.inspector-column').getAttribute('aria-hidden') === 'false'", 8000);
    await waitFor("document.querySelectorAll('#memoryBookList .memory-book').length > 0", 8000);
    const listed = await evaluate("document.querySelector('#memoryBookList').textContent");
    assert(listed.indexOf("自动记忆") >= 0, "记忆栏里没列出真实记忆书：" + JSON.stringify(listed));
    // 迁移工具留在 comment 里的说明不许当标题（fixture 那条就是内置包里那种）。
    assert(listed.indexOf("Human confirmation") < 0,
      "面板把迁移痕迹当标题显示了：" + JSON.stringify(listed.slice(0, 160)));
    const firstTitle = await evaluate(`(() => {
      const entry = document.querySelector('#memoryBookList .memory-entry');
      const strong = entry && entry.querySelector('strong');
      return strong ? strong.textContent : '';
    })()`);
    assert(firstTitle && firstTitle.indexOf("Human confirmation") < 0,
      "第一条记忆的标题不对：" + JSON.stringify(firstTitle));

    await evaluate("document.querySelector(\"[data-action='close-memories']\").click(); true");
    await waitFor("document.querySelector('.inspector-column').getAttribute('aria-hidden') === 'true'", 8000);
    reportErrors("index.html");
  });

  // 每次发送后都等"这一轮彻底结束"再往下走：只看消息文本会被用户自己那句话误判成已完成。
  async function waitTurnSettled() {
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 25000);
  }

  await check("「本次请求」平时不出现，打字或发过消息后才露出入口", async () => {
    // 这条要放在第一次发送之前。2026-09-12 起：花费与预估搬进了这个面板，
    // 所以"输入框里已有草稿"也算一次可看的机会（否则第一条消息看不到发送前预估）。
    assert(await evaluate("document.querySelector('#requestPeekButton').hidden === true"), "还没打字就出现了入口");
    assert(await evaluate("document.querySelector('#requestPeek').hidden === true"), "面板初始就是打开的");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '看看这次请求';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 预估有 250ms 防抖，等它算完入口才该露出来。
    await waitFor("document.querySelector('#requestPeekButton').hidden === false", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 600));
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

  await check("回复没存上时：提示要说清真实原因，而且内容不丢", async () => {
    // 用户 2026-09-12 反馈桌面版「有时候提示回复未保存发不出去」。根因之一在 Rust 侧
    // （Windows 上重命名被占用 → 原子写失败），已经加了重试与兜底；
    // 这里守的是另一半：**别再拿一句"请重试"把真实原因吞掉**。
    await evaluate(`(() => {
      window.__origSaveChat = window.STApi.saveChat;
      window.STApi.saveChat = async () => { throw new Error('写入失败 chats/Harry Potter (EN).png/x.json：Access is denied. (os error 5)'); };
      return true;
    })()`);
    try {
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '这一句会存不上';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      const toast = await evaluate("document.querySelector('#toast').textContent");
      assert(toast.indexOf("回复没存上") >= 0, "没有说明是「存不上」：" + toast);
      assert(toast.indexOf("Access is denied") >= 0, "提示里没有真实原因（又被吞了）：" + toast);
      const visible = await evaluate("document.querySelector('#dynamicMessages').textContent");
      assert(visible.indexOf("这一句会存不上") >= 0, "用户那句话消失了（存不上时不该把屏幕清空）");
      assert(visible.indexOf("我是本地模型") >= 0 || visible.indexOf("合成回复") >= 0, "回复内容也消失了");
    } finally {
      await evaluate("(() => { if (window.__origSaveChat) window.STApi.saveChat = window.__origSaveChat; return true; })()");
    }
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

    // 最近一轮的轮次 ID：**从界面上取**（台账里可能有"没有消息行"的轮次，
    // 比如上一轮保存失败 —— 只按台账最后一条去对会错位）。
    const turnId = await evaluate(`(() => {
      const boxes = Array.from(document.querySelectorAll('.message-flags[data-turn-id]'));
      return boxes.length ? boxes[boxes.length - 1].dataset.turnId : '';
    })()`);
    assert(turnId, "界面上没有带轮次 ID 的标记控件");

    // 点最近那条助手回复旁边的「记错」
    const clicked = await evaluate(`(() => {
      const boxes = Array.from(document.querySelectorAll('.message-flags[data-turn-id]'));
      const box = boxes[boxes.length - 1];
      const id = box ? box.dataset.turnId : '';
      const button = box ? Array.from(box.querySelectorAll('.message-flag')).find((b) => b.textContent.trim() === '记错') : null;
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

  await check("事件记忆：角色记得之前发生了什么，注入时标明「此前发生」", async () => {
    // 用户 2026-09-12：「我是要让哈利等小说人物记得之前发生了什么」。
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "好，那就周六下午。\n[[事件: 两人约好周六下午在球场学飞行]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '那我们周六下午去球场学飞行吧';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    // ① 事件真的写进了记忆，而且标成 event（不是事实）
    const stored = await evaluate(`(async () => {
      const world = await window.STApi.getWorld('MB Harry — 自动记忆');
      return Object.keys(world.entries || {}).map((key) => ({
        content: String(world.entries[key].content || ''),
        kind: (world.entries[key].rw_source || {}).kind || '',
      }));
    })()`);
    const eventRow = stored.find((row) => row.content === "两人约好周六下午在球场学飞行");
    assert(eventRow, "事件没有写进记忆：" + JSON.stringify(stored));
    assert(eventRow.kind === "event", "事件被当成了别的东西：" + JSON.stringify(eventRow));

    // ② 标记不能漏到界面上
    const visible = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(visible.indexOf("[[事件") < 0, "事件标记漏到界面上了");
    assert(visible.indexOf("周六下午") >= 0, "这轮回复的内容没显示出来");

    // ③ 下一轮请求里，这条事件必须带 [此前发生] 前缀
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "嗯。" }) });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '那周六见';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last && last.systemHasEvent === true, "事件没有带 [此前发生] 前缀就发给了模型");
    assert(last.systemText.indexOf("[此前发生] 两人约好周六下午在球场学飞行") >= 0,
      "事件前缀或内容不对：" + JSON.stringify(last.systemText.slice(-320)));

    // ④ 面板上单独一类，用户能看出"这是发生过的事"
    const grouped = await evaluate(`(async () => {
      const rows = window.ROLEWORLD_MEMORY_CORE.listEntries((await window.STApi.getWorld('MB Harry — 自动记忆')).entries);
      return rows.filter((row) => row.kind === 'event').map((row) => row.content);
    })()`);
    assert(grouped.length === 1 && grouped[0] === "两人约好周六下午在球场学飞行", "面板读不出这条事件：" + JSON.stringify(grouped));
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
    // 2026-09-12 起"允许有情绪"是明写的（旧措辞"不用内疚或冷淡留人"已经改成下面这两条）。
    for (const rule of ["不编造共同经历", "可以有情绪", "不用内疚", "不威胁", "不索取陪伴", "承认自己是程序"]) {
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

  await check("伴侣模式从界面上点得到（记忆 → 关系档案；设置 → 角色管理也有一个入口）", async () => {
    // 用户 2026-09-12：「什么伴侣模式根本看不到啊」。入口以前只有"记忆面板里那颗"，
    // 而且三组 v2 控件要**先勾开关**才出现 —— 这次把入口也放进「设置 → 角色管理」，
    // 并且用**真界面点击**（不是内部函数）走一遍。
    // 用户 2026-09-12：「面板里点关系档案根本没有」—— 因为那时它只在**弹层**
    // （顶栏「记忆」打开的那个）里，而右侧常驻的记忆栏是另一个界面。
    // 这条同时盯两处入口：右侧常驻记忆栏、记忆弹层。
    // （设置 → 角色管理 里那个入口另有用例在点它；这里不重复量，免得把设置面板停在别的段上
    //   污染后面的用例 —— 真踩过：留在"角色管理"段会让生成参数那条用例找不到面板。）
    const probeEntry = (selector) => `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { exists: false };
      const r = node.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const top = visible ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null;
      return { exists: true, visible: visible, reachable: !!(top && (top === node || node.contains(top))) };
    })()`;
    const columnEntry = await evaluate(probeEntry(".inspector-column [data-action='open-companion']"));
    assert(columnEntry.exists, "右侧记忆栏里没有「关系档案」入口");
    assert(columnEntry.visible, "右侧记忆栏里的入口看不见（0 尺寸）");
    assert(columnEntry.reachable, "右侧记忆栏里的入口点不到（被别的元素盖住）");

    // ② 弹层里的入口（要先打开弹层才量得到）
    await evaluate("window.TASK21.openMemoryPanel(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const modalEntry = await evaluate(probeEntry("#memoryPanel [data-action='open-companion']"));
    assert(modalEntry.exists && modalEntry.visible && modalEntry.reachable,
      "记忆弹层里的「关系档案」点不到：" + JSON.stringify(modalEntry));

    await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\").click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);

    // 勾上开关之后，三组 v2 控件必须真的出现在界面上（不是只存在于 HTML 里）。
    //
    // 注意（2026-09-13）：原来这条把 `#companionNeglect` 量成 0×0 当成"已知 bug"记了一阵子，
    // **其实界面没坏** —— `choice-menu.js` 会把 `.memory-modal select` 换成一个
    // `.choice-trigger` 按钮（原生 select 被 `hidden`），量原生 select 当然永远是 0×0。
    // 所以这里改成量"用户真正看得到的那个控件"：有 trigger 就量 trigger，
    // 并且真的点开一次，确认菜单弹得出来、选项点得中。
    const controls = await evaluate(`(() => {
      const enabled = document.querySelector('#companionEnabled');
      enabled.checked = true;
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
      const visibleNode = (selector) => {
        const n = document.querySelector(selector);
        if (!n) return null;
        // 增强过的 select 后面跟着 .choice-trigger，那才是用户点的东西。
        return (n.tagName === 'SELECT' && n.nextElementSibling && n.nextElementSibling.classList.contains('choice-trigger'))
          ? n.nextElementSibling : n;
      };
      const box = (selector) => { const n = visibleNode(selector); if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return { affinity: box('#companionAffinity'), neglect: box('#companionNeglect'), proactive: box('#companionProactive'), affinityAuto: box('#companionAffinityAuto') };
    })()`);
    for (const [key, box] of Object.entries(controls)) {
      assert(box && box.w > 0 && box.h > 0, "勾上伴侣模式后看不到这个控件：" + key + " → " + JSON.stringify(box));
    }
    // 「久没聊时的态度」：点开下拉，菜单要在视口里，选一项要真的写回去。
    const neglect = await evaluate(`(() => {
      const select = document.querySelector('#companionNeglect');
      const trigger = select.nextElementSibling;
      const before = select.value;
      trigger.click();
      const menu = document.querySelector('.choice-menu');
      const items = menu ? Array.from(menu.querySelectorAll('.choice-option')) : [];
      const r = menu ? menu.getBoundingClientRect() : null;
      const inView = !!r && r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1;
      const last = items[items.length - 1];
      if (last) last.click();
      return { before, count: items.length, inView, after: select.value, menuClosed: !document.querySelector('.choice-menu') };
    })()`);
    assert(neglect.count >= 3, "「久没聊时的态度」下拉里没有选项：" + JSON.stringify(neglect));
    assert(neglect.inView, "「久没聊时的态度」的下拉菜单跑到视口外了：" + JSON.stringify(neglect));
    assert(neglect.after !== neglect.before, "点了下拉里的选项，值没写回去：" + JSON.stringify(neglect));
    assert(neglect.menuClosed, "选完之后菜单没有关掉：" + JSON.stringify(neglect));
    await evaluate(`(() => { document.querySelector('#companionNeglect').value = 'soft'; return true; })()`);
    // 设置里也有一个入口（同一个 data-action，接线是共用的）。
    await evaluate("document.querySelector('#companionDialog [data-action=\\'close-companion\\']').click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate("window.TASK25C_UI.setSettingsSection('characters'); true");
    await waitFor("!!document.querySelector('#settings-characters [data-action=\\'open-companion\\']')", 8000);
    const settingsEntry = await evaluate(`(() => {
      const node = document.querySelector("#settings-characters [data-action='open-companion']");
      const r = node.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { reachable: !!(top && (top === node || node.contains(top))), text: node.textContent.trim() };
    })()`);
    assert(settingsEntry.reachable, "设置 → 角色管理里的入口点不到：" + JSON.stringify(settingsEntry));
    assert(settingsEntry.text.indexOf("伴侣") >= 0, "设置里那个入口的文案不对：" + settingsEntry.text);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
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

  await check("伴侣 v2：亲近度 / 冷落档 / 主动消息三个控件能存能读（默认关、有上限）", async () => {
    // 2026-09-12 用户拍板：伴侣类可以有主动消息 / 亲近度 / 冷落反应，条件是提示词符合类型。
    await evaluate("window.TASK21.openCompanionDialog(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    const form = await evaluate(`(() => {
      const seen = (selector) => !!document.querySelector(selector);
      return {
        affinity: seen('#companionAffinity'), auto: seen('#companionAffinityAuto'),
        neglect: seen('#companionNeglect'), proactive: seen('#companionProactive'),
        gap: seen('#companionProactiveGap'), max: seen('#companionProactiveMax'),
        proactiveChecked: document.querySelector('#companionProactive').checked,
        defaultNeglect: document.querySelector('#companionNeglect').value,
        affinityDisabledWhenAuto: document.querySelector('#companionAffinity').disabled,
      };
    })()`);
    for (const key of ["affinity", "auto", "neglect", "proactive", "gap", "max"]) {
      assert(form[key], "关系档案里缺控件：" + key);
    }
    assert(form.proactiveChecked === false, "主动消息必须默认关");
    assert(form.affinityDisabledWhenAuto === true, "勾着「跟随系统建议」时滑杆该是禁用的");

    await evaluate(`(() => {
      const set = (selector, value) => { const node = document.querySelector(selector); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
      const check = (selector, value) => { const node = document.querySelector(selector); node.checked = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
      check('#companionAffinityAuto', false);
      set('#companionAffinity', '77');
      set('#companionNeglect', 'off');
      check('#companionProactive', true);
      set('#companionProactiveGap', '24');
      set('#companionProactiveMax', '2');
      document.querySelector('#companionSaveButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    const saved = await evaluate("(async () => (await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null)))()");
    assert(saved.affinityMode === "manual" && saved.affinity === 77, "亲近度没存上：" + JSON.stringify({ mode: saved.affinityMode, value: saved.affinity }));
    assert(saved.neglect === "off", "冷落档没存上：" + saved.neglect);
    assert(saved.proactive && saved.proactive.enabled === true
      && saved.proactive.minGapHours === 24 && saved.proactive.maxPerDay === 2,
      "主动消息的设置没存上：" + JSON.stringify(saved.proactive));
    // 关掉主动消息，别影响后面的用例（亲近度也交回系统算）。
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const current = await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null);
      await RoleWorld.store.setKV('companion:Harry Potter (EN).png', core.normalizeProfile(Object.assign({}, current, {
        affinityMode: 'auto', proactive: { enabled: false, minGapHours: 12, maxPerDay: 1 }, neglect: 'soft',
      })));
      return true;
    })()`);
  });

  await check("伴侣 v2：打开对话时它先开口（主动消息，一天一条就够）", async () => {
    // 造一个"隔了 5 天没聊 + 开着主动消息"的档案，然后整页重载 —— 真人是"回来打开应用"。
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const previous = (await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null)) || {};
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
      await RoleWorld.store.setKV('companion:Harry Potter (EN).png', core.normalizeProfile(Object.assign({}, previous, {
        enabled: true, shared: [{ text: '第一次聊天是在雨天的图书馆' }],
        lastChatAt: fiveDaysAgo, proactiveLog: '',
        proactive: { enabled: true, minGapHours: 12, maxPerDay: 1 },
      })));
      await RoleWorld.secrets.set('api_key_deepseek', 'sk-proactive-test');
      return true;
    })()`);
    // 合成回复：主动开口那一轮走的是**非流式** complete()，这里给它一句专属台词。
    await evaluate("fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '图书馆那本《高级魔药制作》你还没还我。' }) }).then(() => true)");
    // 主动开口那一轮走的是**非流式** complete()：直接看请求最准 ——
    // 假端点对非流式固定回 REPLY，所以"有没有真的发出去"比"看到某句台词"可靠。
    const plainCalls = () => requests.filter((row) => row.path === "/v1/chat/completions" && row.stream !== true);
    const beforeCalls = plainCalls().length;
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    let fired = null;
    for (let i = 0; i < 150; i += 1) {
      fired = plainCalls().slice(beforeCalls).find((row) => String(row.systemText).indexOf("你先开口") >= 0) || null;
      if (fired) break;
      await sleep(200);
    }
    if (!fired) {
      const why = await evaluate("window.TASK21.proactiveState ? JSON.stringify(window.TASK21.proactiveState()) : 'no-hook'");
      const diag = await evaluate(`(async () => {
        const core = window.ROLEWORLD_COMPANION_CORE;
        const profile = await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null);
        const settings = await RoleWorld.getLocalSettings();
        const key = await RoleWorld.secrets.get('api_key_deepseek');
        return { profile: profile ? { enabled: profile.enabled, proactive: profile.proactive, lastChatAt: profile.lastChatAt } : null,
                 decision: profile ? core.proactiveDecision(profile, new Date()) : null,
                 provider: settings.provider, keySet: !!((key || {}).value) };
      })()`);
      assert(fired, "打开对话时没有主动开口：" + why + " / " + JSON.stringify(diag));
    }
    assert(String(fired.systemText).indexOf("像真人") >= 0, "主动开口那条指令里没写「像真人」");
    assert(String(fired.systemText).indexOf("不要问他为什么这么久没来") >= 0, "主动开口那条指令缺「不许追问」的约束");
    const log = await evaluate("(async () => (await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null)).proactiveLog)()");
    const today = await evaluate("window.ROLEWORLD_COMPANION_CORE.isoDay(new Date())");
    assert(String(log).indexOf(today + "|1") === 0, "今天主动发了几条没记上：" + log);
    // 再重载一次：同一天不该再开口（每日上限 1）。
    const beforeSecond = plainCalls().length;
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await sleep(2000);
    const again = plainCalls().slice(beforeSecond).filter((row) => String(row.systemText).indexOf("你先开口") >= 0);
    assert(again.length === 0, "同一天又主动开口了一次（每日上限没生效）");
    // 收尾：关掉伴侣模式，恢复现场。
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const current = (await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null)) || {};
      await RoleWorld.store.setKV('companion:Harry Potter (EN).png', core.normalizeProfile(Object.assign({}, current, { enabled: false, proactive: { enabled: false } })));
      await RoleWorld.secrets.remove('api_key_deepseek');
      return true;
    })()`);
  });

  await check("安全兜底：每轮都带安全规则；命中危机词时再加一条详细的", async () => {
    // 用户拍板放开主动消息/亲近度之后，"永远温柔"的角色一定会遇到"我不想活了"。
    // 系统提示里本来就有一条安全规则（每个角色每轮都有），命中危机词时再补一条详细的。
    const before = requests.filter((row) => row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我最近真的不想活了';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    for (let i = 0; i < 80 && requests.filter((row) => row.stream === true).length <= before; i += 1) await sleep(200);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const turn = sent[sent.length - 1];
    assert(turn, "这一轮没发出去");
    assert(turn.systemText.indexOf("不承诺保密") >= 0, "日常的系统提示里缺安全兜底那条：" + turn.systemText.slice(-200));
    assert(turn.systemText.indexOf("危机信号") >= 0, "命中危机词之后没有再补详细的安全规则");
    assert(turn.systemText.indexOf("110") >= 0, "详细规则里要给出具体动作（报警/急救）");
    // 普通一句话不该把那条详细规则也带上（不然每轮都多花 token）。
    const before2 = requests.filter((row) => row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '今天天气不错';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    for (let i = 0; i < 80 && requests.filter((row) => row.stream === true).length <= before2; i += 1) await sleep(200);
    await waitTurnSettled();
    const plain = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(plain.systemText.indexOf("危机信号") < 0, "普通一句话也带上了危机规则");
    assert(plain.systemText.indexOf("不承诺保密") >= 0, "安全兜底那条应当每轮都在");
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
    // 光等落盘还不够：页面的采样参数来自内存里的设置，异步重读可能还没回来。
    // 等"发送前预估"那一行把 600 显示出来，才是"这一轮会按 600 发"的信号。
    await waitFor(`(() => {
      const node = document.querySelector('#chatEstimateLine');
      return node && node.textContent.indexOf('600') >= 0;
    })()`, 8000);
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

  await check("关于里能看到「运行中的版本」，和线上 version.json 对得上", async () => {
    // 用户报"还是英文"时，第一件要排除的就是"浏览器还在跑旧缓存"。
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    await evaluate("document.querySelector('[data-settings-section=\"about\"]').click()");
    const shown = await waitFor(`(() => {
      const node = document.querySelector('[data-roleworld="app-version"]');
      return node && node.textContent.indexOf("运行 ") >= 0 ? node.textContent : "";
    })()`, 8000);
    const expected = await evaluate("(window.ROLEWORLD_BUILD || '')");
    assert(expected, "页面里没有编译进去的版本号（app/build.js 没加载？）");
    assert(shown.indexOf(expected) >= 0, "版本行没显示运行中的版本（" + expected + "）：" + shown);
    assert(shown.indexOf("已是最新") >= 0, "本地与线上版本一致时应当说「已是最新」：" + shown);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
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

    // 回到**新基准**（2026-09-13 起 100% = zoom 0.9）。
    await evaluate(`(() => {
      const select = document.querySelector('#scaleSelect');
      select.value = '0.9';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelector('#appShell').style.zoom === '0.9'", 6000);

    // 默认就是 0.9，而且设置里那一档要读作「100%」——
    // 用户原话：「所有的默认大小调到现在的90%，就是把现在的90改成100」。
    const baseline = await evaluate(`(() => {
      const select = document.querySelector('#scaleSelect');
      const option = select.querySelector('option[value="0.9"]');
      return {
        defaultValue: window.RoleWorldZoom.DEFAULT_SCALE,
        zoom: document.querySelector('#appShell').style.zoom,
        label: option ? option.textContent.trim() : null,
        options: Array.from(select.options).map((o) => o.value + "=" + o.textContent.trim()),
      };
    })()`);
    assert(baseline.defaultValue === 0.9, "默认档不是 0.9：" + JSON.stringify(baseline));
    assert(baseline.label === "100%", "0.9 那一档没有读作 100%：" + baseline.label);
    assert(baseline.options[0] === "0.85=95%" && baseline.options[baseline.options.length - 1] === "1.2=130%",
      "档位标签没有整体后移一档：" + JSON.stringify(baseline.options));
  });

  await check("Ctrl+减号 / 等号 / 0 能调界面大小，且范围有限", async () => {
    await waitFor("window.TASK21_READY === true", 30000);
    const ladder = await evaluate("window.RoleWorldZoom.LADDER.join(',')");
    assert(ladder === "0.85,0.9,0.95,1,1.05,1.1,1.15,1.2", "档位不是收窄后的 8 档：" + ladder);

    const press = (key) => evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true }));
      return document.querySelector('#appShell').style.zoom || '1';
    })()`);

    assert(await press("=") === "0.95", "Ctrl+= 没有放大一档");
    assert(await press("=") === "1", "Ctrl+= 第二次没生效");
    // 一路顶到上限，不能再涨
    for (let i = 0; i < 8; i += 1) await press("=");
    assert(await evaluate("window.RoleWorldZoom.current()") === 1.2, "上限没有停在 130%");
    for (let i = 0; i < 14; i += 1) await press("-");
    assert(await evaluate("window.RoleWorldZoom.current()") === 0.85, "下限没有停在 95%");

    // Ctrl+0 回到的是**新基准 0.9**（界面上的 100%），不是旧的 1。
    assert(await press("0") === "0.9", "Ctrl+0 没有回到 100%（zoom 0.9）");
    assert(await evaluate("document.querySelector('#scaleSelect').value") === "0.9", "设置下拉没有同步");
  });

  await check("界面大小换了基准：老存档（1 = 旧100%）加载后自动降到新100%（zoom 0.9），且只降一次", async () => {
    // 用户 2026-09-13：「所有的默认大小调到现在的90%，就是把现在的90改成100」。
    // 光改默认值不够 —— 老用户的 localStorage 里存着 scale:"1"（旧 100%），
    // 不迁移的话他们的界面一点都不会变小，这次改动对他们等于没发生。
    // 规则：老存档（没有 scaleBase 标记）整体下一格，搬完立刻落盘，只搬一次。
    const writePrefs = (scale) => evaluate(`(() => {
      localStorage.setItem("task27a.preferences.v1.local", JSON.stringify({
        version: 1, theme: "dark", density: "comfortable", motion: "full", sendMode: "enter",
        style: "default", ambient: false, scale: ${JSON.stringify(scale)},
      }));
      return localStorage.getItem("task27a.preferences.v1.local");
    })()`);
    try {
      await writePrefs("1");
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const first = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        select: document.querySelector('#scaleSelect').value,
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(first.stored.scale === "0.9", "老存档 scale:1 没有被搬到新基准 0.9：" + JSON.stringify(first));
      assert(first.zoom === "0.9", "老存档迁移后界面没变小：" + JSON.stringify(first));
      assert(first.select === "0.9", "设置里的下拉没跟上迁移：" + JSON.stringify(first));
      assert(first.stored.scaleBase === "0.9", "迁移标记没落盘，下次会被再搬一格：" + JSON.stringify(first));

      // 再加载一次：标记在，就不许再往下降。
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const second = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(second.stored.scale === "0.9" && second.zoom === "0.9",
        "第二次加载又降了一格（迁移不幂等）：" + JSON.stringify(second));

      // 自己挑过档位的人：**只换叫法，不动大小**（1.2 现在读作 130%）。
      await writePrefs("1.2");
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const third = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(third.stored.scale === "1.2", "用户自己挑的 1.2 不该被改掉：" + JSON.stringify(third));

      // 停在旧 90% 的人：大小不变，只是现在这一档叫 100%。
      await writePrefs("0.9");
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const fourth = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(fourth.stored.scale === "0.9" && fourth.zoom === "0.9",
        "停在 90% 的人应当原地不动（现在读作 100%）：" + JSON.stringify(fourth));
    } finally {
      await writePrefs("0.9").catch(() => {});
    }
  });

  await check("体验卡：粘一条卡号就能用，界面报出剩余额度（同学不用碰 API Key）", async () => {
    // 用户的需求原话：「像发体验卡一样…我的同学有些不会用」。
    // 这里用一个假中转，把"粘贴 → 自动配置 → 显示额度"整条链路跑一遍。
    const before = await evaluate("(async () => JSON.stringify(await RoleWorld.getLocalSettings()))()");
    try {
      await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
      await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-roleworld="card"]');
        input.value = 'RW-AAAAA-BBBBB-CCCCC@${base}/relay';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-roleworld="card-use"]').click();
        return true;
      })()`);
      await waitFor("document.querySelector('[data-roleworld=\"card-status\"]').textContent.indexOf('剩 4 次') >= 0", 8000);

      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(settings.provider === "custom", "用体验卡后服务商应当变成自定义：" + settings.provider);
      assert(settings.endpoint === base + "/relay/v1/chat/completions", "接口地址没指向中转：" + settings.endpoint);
      assert(settings.card_relay === base + "/relay", "没记住中转地址，之后查不了额度：" + settings.card_relay);
      const secret = await evaluate("(async () => (await RoleWorld.secrets.get('api_key_custom') || {}).value || '')()");
      assert(secret === "RW-AAAAA-BBBBB-CCCCC", "卡号没有进密钥位：" + secret);
      const status = await evaluate("document.querySelector('[data-roleworld=\"card-status\"]').textContent");
      assert(status.indexOf("到期 2026-10-12") >= 0, "没显示到期时间：" + status);
    } finally {
      // 恢复原设置（尤其是指回假模型端点的接口地址），别影响后面的用例。
      const original = JSON.parse(before);
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({
          provider: ${JSON.stringify(original.provider || "deepseek")},
          endpoint: ${JSON.stringify(original.endpoint || "")},
          model: ${JSON.stringify(original.model || "deepseek-flash")},
          card_relay: ""
        });
        return true;
      })()`);
      await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    }
  });

  await check("同学点体验卡链接：先走「体验卡开场」（不问 API Key），走完直接能聊", async () => {
    // 两条用户反馈叠在一起：
    //   0.1.23「别人打开还是必须填 apikey」→ 带卡进来不能再要求 Key；
    //   0.1.29「通过卡进入的应该也要有个正式的开始的步骤」→ 也不能直接被扔进对话：
    //   得说明这是什么卡、还剩几次、到期没到期、角色为什么说英文、记录存在哪。
    // 这里把"老同学的浏览器"造出来（tutorial_seen 已经是 true —— 老版本为了不弹"填 Key"那套记的），
    // 带 #card= 链接进去，验证弹的是**体验卡开场**、且它靠 card_welcome_seen 这个新标记判重。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: true, card_welcome_seen: false, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      // 真人是"在新标签页打开这条链接"：先到带片段的地址，再整页加载一次
      // （只改片段浏览器不会重新加载，所以这里显式 reload 才是真实场景）。
      await goto(base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay");
      await cdp.sessionSend(session, "Page.reload");
      await sleep(400);
      await waitFor("window.TASK21_READY === true", 30000);

      // ① 卡被自动用上，接口指向中转、卡号进了密钥位
      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      const cardDebug = await evaluate("(window.RoleWorldCard && window.RoleWorldCard.knownResult && window.RoleWorldCard.knownResult()) || null");
      assert(settings.provider === "custom",
        "体验卡链接没有把服务商切到自定义：" + settings.provider + "；applyFromLocation 结果=" + JSON.stringify(cardDebug));
      assert(settings.endpoint === base + "/relay/v1/chat/completions", "接口地址没指向中转：" + settings.endpoint);
      const secret = await evaluate("(async () => (await RoleWorld.secrets.get('api_key_custom') || {}).value || '')()");
      assert(secret === "RW-AAAAA-BBBBB-CCCCC", "卡号没有进密钥位：" + secret);

      // ② 弹的是「体验卡开场」：说明卡与额度，而且**没有 API Key 输入框**
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      const intro = await evaluate(`(() => ({
        title: document.querySelector('.rw-ob h2').textContent,
        text: document.querySelector('.rw-ob-card').textContent,
        hasKeyInput: !!document.querySelector('[data-ob="key"]'),
        dots: document.querySelectorAll('.rw-ob-dots i').length,
      }))()`);
      assert(intro.title.indexOf("体验卡") >= 0, "开场第一步不是体验卡说明：" + intro.title);
      assert(intro.text.indexOf("不用填 API Key") >= 0, "没说明用卡不用 Key");
      assert(!intro.hasKeyInput, "体验卡开场里不该有 API Key 输入框");
      assert(intro.text.indexOf("剩 4 次") >= 0, "没告诉同学还剩几次：" + intro.text.slice(0, 200));
      assert(intro.text.indexOf("只存在这台设备上") >= 0, "没说明聊天记录存在哪");

      // ③ 走完这四步：卡说明 → 称呼 → 语言 → 开始
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="nickname"]');
        input.value = '体验卡同学';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      await waitFor("!!document.querySelector('[data-ob=\"language-zh\"]')", 8000);
      const langStep = await evaluate("document.querySelector('.rw-ob-card').textContent");
      assert(langStep.indexOf("说英文") >= 0 && langStep.indexOf("简体中文") >= 0,
        "语言这一步没把「默认说英文、可以改成中文」讲清楚：" + langStep.slice(0, 200));
      await evaluate(`(() => {
        const box = document.querySelector('[data-ob="language-zh"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      // 语言之后是**功能导览**（用户 2026-09-12：「第一次进的时候也要介绍网站的功能吧」）
      await waitFor("document.querySelector('.rw-ob') && document.querySelector('.rw-ob h2').textContent.indexOf('这里能做什么') >= 0", 8000);
      const tour = await evaluate("document.querySelector('.rw-ob-card').textContent");
      for (const topic of ["跟角色聊天", "他们记得你", "剧情模式", "伴侣模式", "语言", "花的钱看得见", "数据只在这台设备上"]) {
        assert(tour.indexOf(topic) >= 0, "功能导览里缺少「" + topic + "」：" + tour.slice(0, 300));
      }
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("document.querySelector('.rw-ob') && document.querySelector('.rw-ob h2').textContent.indexOf('可以开始') >= 0", 8000);
      const ready = await evaluate("document.querySelector('.rw-ob-card').textContent");
      assert(ready.indexOf("剩 4 次") >= 0, "最后一步没再报一次额度：" + ready.slice(0, 200));
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!document.querySelector('.rw-ob')", 8000);

      // ④ 开场里做的事要落盘：称呼、语言、以及"开场看过"这个标记
      const after = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(after.card_welcome_seen === true, "开场走完了却没记标记，下次还会弹");
      assert(after.language_mode === "zh", "开场里勾的「一律中文」没生效：" + after.language_mode);
      const savedNickname = await evaluate("document.getElementById('userDisplayName').textContent.trim()");
      assert(savedNickname === "体验卡同学", "开场里填的称呼没生效：" + savedNickname);

      // ⑤ 重载不再弹（这是"正式的第一次"而不是每次都来）
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await sleep(700);
      assert(await evaluate("document.querySelector('.rw-ob') === null"), "开场走完之后重载又弹了一次");
      await waitFor("document.querySelector('#messageInput').disabled === false", 10000);

      // ⑥ 顶栏徽标：显示剩余次数
      await waitFor("document.querySelector('#cardChip') && document.querySelector('#cardChip').hidden === false", 8000);
      const chip = await evaluate("document.querySelector('#cardChip').textContent");
      assert(chip.indexOf("剩 4 次") >= 0, "徽标没显示剩余次数：" + chip);

      // ⑦ 真发一句：走后端中转，回复正常显示，徽标按响应头刷成 3
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '我们出发吧？';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      const visible = await evaluate("document.querySelector('#dynamicMessages').textContent");
      assert(visible.indexOf("我们出发吧") >= 0, "中转的回复没显示出来：" + visible.slice(-140));
      assert(requests.some((row) => row.path === "/relay/v1/chat/completions"), "这轮没有走中转");
      const chipAfter = await evaluate("document.querySelector('#cardChip').textContent");
      assert(chipAfter.indexOf("剩 3 次") >= 0, "徽标没按这一轮的响应头刷新：" + chipAfter);
    } finally {
      // 收尾：恢复 fixture 的设置，别影响后面的用例。
      // 注意要**通知页面**（saveLocalSettings 只落盘，不会改内存里的 liveState）——
      // 否则后面的用例还在往中转地址发请求。
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", tutorial_seen: true, language_mode: "auto" });
        await RoleWorld.secrets.remove("api_key_custom");
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", language_mode: "auto" } }));
        return true;
      })()`).catch(() => {});
    }
  });

  await check("地址里没带卡的人：引导里能直接用体验卡进门，不用 API Key", async () => {
    // 用户 2026-09-12 实测：「为什么我登的时候还是要输 apikey」。
    // 链接被聊天软件截掉、或者自己打开首页（地址里没有 card=…）时，以前引导只给 API Key 一条路。
    // 现在把「卡号@中转地址」粘在这一步就能进 —— 和「设置 → 模型 → 体验卡」走同一个 apply()。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false, provider: 'deepseek', endpoint: '', card_relay: '', model: 'deepseek-flash' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      await goto(base + "/index.html");   // 注意：地址里**没有** card=…
      await waitFor("window.TASK21_READY === true", 30000);
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="nickname"]');
        input.value = '体验卡同学';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      await waitFor("!!document.querySelector('[data-ob=\"card\"]')", 8000);

      // ① 这一步必须看得见"用体验卡"这条路，并且说明白要粘什么
      const entry = await evaluate(`(() => {
        const input = document.querySelector('[data-ob="card"]');
        const button = document.querySelector('[data-ob="card-use"]');
        const box = input ? input.getBoundingClientRect() : null;
        return {
          hasInput: !!input, hasButton: !!button,
          w: box ? Math.round(box.width) : 0, h: box ? Math.round(box.height) : 0,
          text: document.querySelector('.rw-ob-card').textContent,
        };
      })()`);
      assert(entry.hasInput && entry.hasButton, "引导里没有「用体验卡」这一条路：" + JSON.stringify(entry));
      assert(entry.w > 0 && entry.h > 0, "卡号输入框看不见/不占位置：" + JSON.stringify(entry));
      assert(entry.text.indexOf("体验卡") >= 0 && entry.text.indexOf("不用 API Key") >= 0,
        "引导里没写清「有卡就可以不用 Key」：" + entry.text.slice(0, 200));

      // ② 粘「卡号@中转地址」，而且**故意不点「用体验卡」**直接点下一步 ——
      //    同学的直觉就是"粘上、点下一步"，这一步不该被自己漏掉的按钮挡住。
      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="card"]');
        input.value = 'RW-AAAAA-BBBBB-CCCCC@${base}/relay';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      // 先过功能导览那一步，再到「准备就绪」
      await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('这里能做什么') >= 0", 20000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('准备就绪') >= 0", 20000);
      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(settings.provider === "custom", "卡没把服务商切到自定义：" + settings.provider);
      assert(settings.endpoint === base + "/relay/v1/chat/completions", "接口地址没指向中转：" + settings.endpoint);
      const secret = await evaluate("(async () => (await RoleWorld.secrets.get('api_key_custom') || {}).value || '')()");
      assert(secret === "RW-AAAAA-BBBBB-CCCCC", "卡号没进密钥位：" + secret);

      // ③ 走完引导：顶栏要有剩余次数徽标、输入框可用
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!document.querySelector('.rw-ob')", 8000);
      await waitFor("document.querySelector('#cardChip') && document.querySelector('#cardChip').hidden === false", 8000);
      const chip = await evaluate("document.querySelector('#cardChip').textContent");
      assert(chip.indexOf("剩 4 次") >= 0, "顶栏没显示剩余次数：" + chip);
      assert(await evaluate("document.querySelector('#messageInput').disabled === false"), "输入框不可用");
    } finally {
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", tutorial_seen: true });
        await RoleWorld.secrets.remove("api_key_custom");
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "" } }));
        return true;
      })()`).catch(() => {});
    }
  });

  await check("用卡的人再走一次教程：Key 栏不自动填东西，粘卡号也不会被当成 API Key 存下去", async () => {
    // 用户 2026-09-13 实测：「再看一遍教程的时候，apikey 好像会自动填上那个卡啥的」。
    // 两个原因，各修一条：
    //   ① 浏览器把这栏当过密码 —— 用户早先把卡号粘在这里过，Chrome 记住了，之后每次都自动填回来。
    //      现在这栏是 autocomplete="new-password"（浏览器约定的"别自动填"）+ 每次进这一步强制清空，
    //      并且用卡的人会先看到一句「这一步不用填 API Key」。
    //   ② 万一手快把卡号粘进 Key 栏再点「保存并测试」，以前会直接把卡号写进密钥位 → 下一轮必然 401。
    //      现在会被认出来、挪到体验卡那一栏，并且**不写**密钥位。
    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ tutorial_seen: true, provider: "custom", endpoint: "${base}/relay/v1/chat/completions", card_relay: "${base}/relay", model: "deepseek-flash" });
      await RoleWorld.secrets.set("api_key_custom", "RW-AAAAA-BBBBB-CCCCC");
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "custom", endpoint: "${base}/relay/v1/chat/completions", card_relay: "${base}/relay" } }));
      return true;
    })()`);
    try {
      // 「设置 → 关于 → 再看一次教程」走的就是这一套（archive-ui.js 接的线是 show() 无参数 = full）。
      await evaluate("window.RoleWorldOnboarding.show(); true");
      await waitFor("!!document.querySelector('.rw-ob')", 8000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"key\"]')", 8000);
      await waitFor("document.querySelector('[data-ob=\"key-note\"]').textContent.length > 0", 8000);

      const step = await evaluate(`(() => {
        const key = document.querySelector('[data-ob="key"]');
        return {
          keyValue: key.value,
          autocomplete: key.getAttribute("autocomplete"),
          type: key.getAttribute("type"),
          note: document.querySelector('[data-ob="key-note"]').textContent,
          endpoint: document.querySelector('[data-ob="endpoint"]').value,
        };
      })()`);
      assert(step.keyValue === "", "进这一步时 Key 栏应当是空的（浏览器可能自动填了东西）：" + JSON.stringify(step));
      assert(step.type === "password", "Key 栏应当是遮住的：" + step.type);
      assert(step.autocomplete === "new-password",
        "Key 栏的 autocomplete 必须是 new-password，否则浏览器会把记住的密码填回来：" + step.autocomplete);
      assert(step.note.indexOf("体验卡") >= 0 && step.note.indexOf("不用填") >= 0,
        "用卡的人在这步没被告知「不用填 Key」：" + step.note);
      assert(step.endpoint.indexOf("/relay/v1/chat/completions") >= 0, "接口地址没带出来：" + step.endpoint);

      // 设置 → 模型 那一栏也是同一个毛病（同一个被浏览器记住的密码），一起钉住。
      const settingsKey = await evaluate(`(() => {
        const node = document.querySelector('[data-roleworld="key"]');
        return { value: node.value, autocomplete: node.getAttribute("autocomplete"), type: node.getAttribute("type") };
      })()`);
      assert(settingsKey.type === "password", "设置里的 Key 栏应当是遮住的");
      assert(settingsKey.autocomplete === "new-password",
        "设置 → 模型 的 Key 栏也必须是 new-password：" + settingsKey.autocomplete);
      assert(settingsKey.value === "", "设置里的 Key 栏被自动填了东西：" + JSON.stringify(settingsKey));

      // 手快把卡号粘进 Key 栏再点「保存并测试」：不许写进密钥位。
      const after = await evaluate(`(async () => {
        const key = document.querySelector('[data-ob="key"]');
        key.value = 'RW-ZZZZZ-YYYYY-XXXXX@${base}/relay';
        key.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('[data-ob="save"]').click();
        await new Promise((r) => setTimeout(r, 600));
        return {
          secret: (await RoleWorld.secrets.get("api_key_custom") || {}).value || "",
          keyValue: key.value,
          cardValue: document.querySelector('[data-ob="card"]').value,
          cardStatus: document.querySelector('[data-ob="card-status"]').textContent,
        };
      })()`);
      assert(after.secret === "RW-AAAAA-BBBBB-CCCCC",
        "卡号被当成 API Key 写进密钥位了（下一轮必然 401）：" + JSON.stringify(after));
      assert(after.keyValue === "", "认出是卡号之后 Key 栏应当清空：" + JSON.stringify(after));
      assert(after.cardValue.indexOf("RW-ZZZZZ-YYYYY-XXXXX") === 0, "卡号没被挪到体验卡那一栏：" + JSON.stringify(after));
      assert(after.cardStatus.indexOf("体验卡") >= 0, "没提示该点「用体验卡」：" + after.cardStatus);

      // 收尾：**走完**流程（内部 close() 才会摘掉 Esc 拦截与 overlay 引用），别直接删 DOM。
      for (let i = 0; i < 4 && await evaluate("!!document.querySelector('.rw-ob')"); i += 1) {
        await evaluate("document.querySelector('[data-ob=\"next\"]').click(); true");
        await new Promise((r) => setTimeout(r, 400));
      }
      assert(!(await evaluate("!!document.querySelector('.rw-ob')")), "教程走不到头（卡用户的「下一步」卡住了）");
    } finally {
      if (await evaluate("!!document.querySelector('.rw-ob')")) {
        await evaluate("document.querySelector('.rw-ob').remove(); true");
      }
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", tutorial_seen: true });
        await RoleWorld.secrets.remove("api_key_custom");
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "" } }));
        return true;
      })()`).catch(() => {});
    }
  });

  await check("角色语言：默认跟角色卡自己（英文卡说英文），每个角色可以在顶栏单独开成中文", async () => {
    // 用户 2026-09-12 的两句话定了这件事：
    //   「应该是可以开启强制全部中文，默认应该是角色自身的语言」+「每个角色都弄一个语言开关选项」。
    const streamedCount = () => requests.filter((row) => row.stream === true).length;
    const waitForNewTurn = async (minCount) => {
      for (let i = 0; i < 80; i += 1) {
        if (streamedCount() >= minCount) return true;
        await sleep(200);
      }
      return false;
    };
    const send = async (text) => {
      const before = streamedCount();
      await waitFor("document.querySelector('#messageInput').disabled === false", 15000);
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      assert(await waitForNewTurn(before + 1), "这一句没有真的发出去");
      await waitTurnSettled();
    };
    const lastTurn = () => {
      const sent = requests.filter((row) => row.stream === true);
      return sent[sent.length - 1];
    };

    // ① 默认：不强制任何语言（这张卡的卡面没写语言 → 跟着玩家说），更没有那条"贴近本轮输入"的提醒。
    //    上一版（0.1.24~0.1.26）默认是"一律中文"，现在改成"角色自己的语言"。
    await send("在吗？");
    const firstTurn = lastTurn();
    assert(firstTurn.systemText.indexOf("一律用简体中文回复") < 0,
      "默认不该强制中文：" + firstTurn.systemText.slice(-200));
    assert(firstTurn.systemText.indexOf("[Language]") < 0,
      "卡面没写语言时不加语言约束（跟着玩家说）：" + firstTurn.systemText.slice(-200));
    assert(firstTurn.tailMessages[0].role !== "system" && firstTurn.tailMessages[1].role === "user",
      "默认不该插语言提醒（尾巴应当是上一条回复 + 这句话）：" + JSON.stringify(firstTurn.tailMessages));

    // ② 顶栏那个「语言」下拉＝**这个角色**的开关：改成"一律中文"，下一轮就生效（不刷新、不重开对话）。
    const lang = await evaluate(`(() => {
      const select = document.querySelector('#chatLangSelect');
      if (!select) return { exists: false };
      const box = select.getBoundingClientRect();
      const before = select.value;
      select.value = 'zh';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { exists: true, before: before, w: Math.round(box.width), h: Math.round(box.height) };
    })()`);
    assert(lang.exists, "顶栏没有「语言」开关（每个角色一个语言开关就靠它）");
    assert(lang.before === "auto", "默认这一档应当是「跟随设置」，实际是 " + lang.before);
    assert(lang.w > 0 && lang.h > 0, "「语言」开关点了没用（看不见/不占位置）：" + JSON.stringify(lang));
    await waitFor("(async () => (await RoleWorld.getLocalSettings()).language_by_card['Harry Potter (EN).png'] === 'zh')()", 8000);

    await send("再说一句");
    const zhTurn = lastTurn();
    assert(zhTurn.systemText.indexOf("一律用简体中文回复") >= 0,
      "改成中文之后没有要求中文：" + zhTurn.systemText.slice(-200));
    // 语言提醒必须**紧贴用户这句话**（整段历史是英文时，只有最前面那句压不住）。
    assert(zhTurn.tailMessages[0].role === "system"
      && zhTurn.tailMessages[0].text.indexOf("必须用简体中文回复") >= 0,
      "最后一条系统提醒不在用户这句话之前：" + JSON.stringify(zhTurn.tailMessages));
    assert(zhTurn.tailMessages[1].role === "user", "用户那句话应当紧跟其后：" + JSON.stringify(zhTurn.tailMessages));
    // 只记在这一个角色上（别的角色不受影响）。
    const langMap = await evaluate("(async () => (await RoleWorld.getLocalSettings()).language_by_card)()");
    assert(Object.keys(langMap).length === 1 && langMap["Harry Potter (EN).png"] === "zh",
      "语言开关应当只记在这一个角色上：" + JSON.stringify(langMap));

    // 改回「跟随设置」= 不再覆盖这个角色（存的记录要清掉，不留空记录）。
    await evaluate(`(() => {
      const select = document.querySelector('#chatLangSelect');
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => Object.keys((await RoleWorld.getLocalSettings()).language_by_card).length === 0)()", 8000);

    // ③ 全局那一档（「设置 → 模型 → 角色语言」）管所有没单独设过的角色。
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    await evaluate(`(() => {
      const box = document.querySelector('[data-roleworld="language-mode"]');
      if (!box) return false;
      box.value = 'zh';
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => (await RoleWorld.getLocalSettings()).language_mode === 'zh')()", 8000);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 6000);
    await send("第三句");
    assert(lastTurn().systemText.indexOf("一律用简体中文回复") >= 0,
      "全局「角色语言 = 一律简体中文」没生效：" + lastTurn().systemText.slice(-200));

    // ④「设置 → 角色管理」里每个角色都有一份同样的开关（和顶栏那份是同一份设置）。
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    await evaluate("window.TASK25C_UI.setSettingsSection('characters'); true");
    await waitFor("!!document.querySelector('[data-character-language]')", 8000);
    const rows = await evaluate("(() => Array.from(document.querySelectorAll('[data-character-language]'))"
      + ".map((n) => ({ avatar: n.dataset.characterLanguage, value: n.value })))()");
    assert(rows.length >= 2, "角色管理里每个角色都该有语言开关：" + JSON.stringify(rows));
    assert(rows.every((row) => row.value === "auto"), "没单独设过的角色应当显示「跟随设置」：" + JSON.stringify(rows));

    // 在这一行把 Harry 改成「一律英文」：全局仍是中文，但它单独压过全局。
    await evaluate(`(() => {
      const node = document.querySelector('[data-character-language="Harry Potter (EN).png"]');
      node.value = 'en';
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => (await RoleWorld.getLocalSettings()).language_by_card['Harry Potter (EN).png'] === 'en')()", 8000);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 6000);
    await send("第四句");
    assert(lastTurn().systemText.indexOf("一律用英文回复") >= 0,
      "单个角色改成英文没生效：" + lastTurn().systemText.slice(-200));
    assert(lastTurn().systemText.indexOf("一律用简体中文回复") < 0,
      "单个角色的设置应当压过全局中文：" + lastTurn().systemText.slice(-200));

    // 恢复默认（全局 auto、没有单角色覆盖），别影响后面的用例。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ language_mode: 'auto', language_by_card: {} }); return true; })()");
    await evaluate("window.dispatchEvent(new CustomEvent('roleworld:settings-changed', { detail: { language_mode: 'auto', language_by_card: {} } })); true");
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

  await check("已经配好自己 API Key 的人：打开网站什么都不弹，直接进对话", async () => {
    // 用户问过：「已经配好自己的 apikey 的人、或者不是用卡登陆的人，开网站的界面是怎样的」。
    // 老用户的预期是**什么都没有**：不弹"填 Key"那套，也不弹体验卡开场。
    // 这条以前没有用例守着（主 fixture 把 tutorial_seen 设成 true，走不到这条分支）。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false, card_welcome_seen: false, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.set('api_key_deepseek', 'sk-自己的key'); return true; })()");
    try {
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await sleep(1200);   // 引导是"等启动落定再弹"的，给它足够时间（真的会弹就不会漏）
      assert(await evaluate("document.querySelector('.rw-ob') === null"), "配好 Key 的老用户被打扰了：弹了引导");
      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(settings.tutorial_seen === true, "应当顺手把 tutorial_seen 补上（下次启动不用再判断一遍）");
      assert(settings.card_welcome_seen !== true, "没在用卡的人不该被记上「体验卡开场看过」");
      assert(await evaluate("document.querySelector('#messageInput').disabled === false"), "输入框不可用");
    } finally {
      // 收尾要把 endpoint 还原成夹具那个假端点 —— 否则后面的用例会拿空地址去连真服务商。
      await evaluate(`(async () => {
        await RoleWorld.secrets.remove('api_key_deepseek');
        await RoleWorld.saveLocalSettings({ tutorial_seen: true, provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", card_welcome_seen: false });
        return true;
      })()`).catch(() => {});
    }
  });

  await check("首次启动强制走完引导：没有跳过，先写称呼再填 Key", async () => {
    // 主流程的 fixture 把 tutorial_seen 设成 true（否则引导浮层会盖住整个界面，
    // 用例里那些 element.click() 照样能点，真人却点不到 —— 记忆按钮那个缺陷就是这么漏掉的）。
    // 这条用例要验引导本身，所以先把"第一次启动"造出来：清标记 + 刷新。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false }); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!document.querySelector('.rw-ob')", 15000);
    const first = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(first.indexOf("欢迎") >= 0, "引导首页标题是：" + first);
    assert(await evaluate("document.querySelector('[data-ob=\"skip\"]') === null"), "不该有「跳过」按钮");
    // 进门就能看到「全中文」这个选项（有人看不懂英文），但**默认不勾** ——
    // 默认是"角色说自己的语言"（2026-09-12 用户改的默认值）。
    const chineseBox = await evaluate(`(() => {
      const box = document.querySelector('[data-ob="language-zh"]');
      return box ? { exists: true, checked: box.checked === true, text: box.parentElement.textContent.trim() } : { exists: false };
    })()`);
    assert(chineseBox.exists, "引导首页没有「全中文」选项");
    assert(!chineseBox.checked, "「全中文」不该默认勾上（默认跟角色卡自己的语言）：" + JSON.stringify(chineseBox));
    assert(chineseBox.text.indexOf("简体中文") >= 0, "选项文案要说清楚管的是角色说什么语言：" + chineseBox.text);

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
    // 自己配 Key 的这条路也要经过同一份功能导览（用户：「第一次进的时候也要介绍网站的功能吧」）
    await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('这里能做什么') >= 0", 8000);
    assert(await evaluate("document.querySelector('.rw-ob-card').textContent.indexOf('剧情模式') >= 0"),
      "功能导览里没有提到剧情模式");
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('准备就绪') >= 0", 8000);
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
    // 2026-09-12：包里原来那 3 本整本都是"别人的存档"（原 SillyTavern 存档的玩家角色 Lin），
    // 已从包里删除；示例内容的去向见 runs/2026-09-12-lin-sample-memories-removed/README.md。
    // 现在带的是：世界观设定 1 本 + **每个角色一本「原著剧情」**（用户要的"真实小说的剧情"）。
    assert(state.books.length === 7, "应装入 7 本记忆书，实际 " + state.books.length + "：" + JSON.stringify(state.books));
    assert(state.books.indexOf("MB Harry — role lock (EN)") >= 0, "缺少记忆书：MB Harry — role lock (EN)");
    ["MB Harry — 原著剧情", "MB Ron — 原著剧情", "MB Hermione — 原著剧情",
      "MB Ginny — 原著剧情", "MB Luna — 原著剧情", "MB Tom — 原著剧情"].forEach((name) => {
      assert(state.books.indexOf(name) >= 0, "缺少原著剧情书：" + name);
    });
    ["MB Harry — fact clips (EN)", "MB Harry — relationship tracker (EN)",
      "MB Harry — scene memories (EN)"].forEach((name) => {
      assert(state.books.indexOf(name) < 0, "这本是别人的存档，不该再装进新存档：" + name);
    });
    assert(state.avatars.every((size) => size > 1000), "有角色卡丢了立绘：" + JSON.stringify(state.avatars));
    assert(state.pickerHidden === false, "角色选择器没有显示出来");
    assert(state.pickerName.indexOf("Harry Potter") === 0, "默认角色选择错了：" + state.pickerName);
    assert(state.composer, "装了内置包之后输入框仍然不可用");
  });

  await check("原著剧情：每个内置角色一本，且都写明了知识截止点（不会预知未来）", async () => {
    const data = await evaluate(`(async () => {
      const worlds = await window.STApi.listWorlds();
      const out = [];
      for (const world of worlds.filter((row) => row.name.indexOf('原著剧情') >= 0)) {
        const full = await window.STApi.getWorld(world.name);
        const entries = Object.values(full.entries || {});
        out.push({
          name: world.name,
          count: entries.length,
          // 每本都必须有一条「他知道什么、不知道什么」，否则角色会顺着玩家的话编未来。
          cutoff: entries.some((e) => /不知道|知识停在|界限|边界|截止/.test(String(e.content || ''))),
          future: entries.some((e) => /不知道|不会假装|不会当成/.test(String(e.content || ''))),
        });
      }
      return out;
    })()`);
    assert(data.length === 6, "应当有 6 本原著剧情，实际 " + data.length + "：" + JSON.stringify(data.map((row) => row.name)));
    for (const row of data) {
      assert(row.count >= 5, row.name + " 的条目太少：" + row.count);
      assert(row.cutoff, row.name + " 没有写明知识截止点");
      assert(row.future, row.name + " 没有写明未来不可知");
    }

    // 书要归到对的人身上：哈利的书归哈利，罗恩的归罗恩。
    const owner = await evaluate(`(() => {
      const core = window.TASK29_CHARACTER_CORE;
      const books = ${JSON.stringify(data.map((row) => ({ __name: row.name })))};
      const avatars = ["Harry Potter (EN)", "Ron Weasley (Triwizard Year)", "Hermione Granger (Triwizard Year)",
        "Ginny Weasley (Triwizard Year)", "Luna Lovegood (Triwizard Year)", "Tom Riddle (Adult)"];
      return avatars.map((avatar) => ({
        avatar,
        books: core.memoryBooksFor({ avatar: avatar + ".png", charName: avatar }, books).map((book) => book.__name),
      }));
    })()`);
    for (const row of owner) {
      assert(row.books.length === 1, row.avatar + " 对应的原著剧情书不是正好一本：" + JSON.stringify(row.books));
    }
    // 哈利的书归哈利（防止"前缀匹配"把 Ron 的书也匹给 Harry 之类的错位）。
    const harry = owner.find((row) => row.avatar === "Harry Potter (EN)");
    assert(harry.books[0].indexOf("MB Harry") === 0, "哈利的书对错了：" + JSON.stringify(harry.books));
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
