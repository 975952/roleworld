"use strict";

/*
 * local-app-check.cjs —�?本地模式端到端回归（�?SillyTavern、无外网�? *
 * 起一个静态服务器托管 app/ �?packs/，再起一个假�?OpenAI 兼容模型端点�? * 用无�?Chrome 真正打开三个页面，验证：
 *   1. 对话页能启动（没有登录跳转、没有遮罩、输入框可用�? *   2. 发送消息能拿到流式回复并落到界面上；思考模式默认关闭且不显示思维�? *   3. 剧情模式页能读角色与记忆�? *   4. 内容包自动安�?/ 停用后空库仍可启�? *   5. 设置面板能读写本机模型配置与密钥
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
const REPLY = "合成回复：你好，我是本地模型�?;
// AI 写角色分两步：先扩写成提示词，再照提示词写卡。这里是两步各自的合成返回�?const SYNTHETIC_BRIEF = [
  "名称：沈�?,
  "身份与处境：市立图书馆的夜班管理员，闭馆前十分钟当值�?,
  "性格：冷淡、怕麻烦，但对书很上心；不擅长寒暄�?,
  "说话方式：短句，少用形容词，习惯用「嗯」「行」回应�?,
  "关系：对读者保持距离，只有当对方认真谈书时才放松一点�?,
  "边界：不谈自己的私事，不参与闲话�?,
  "开场情境：闭馆前十分钟，他正在把还书车推回书架�?,
].join("\n");
const SYNTHETIC_DRAFT = {
  name: "沈默",
  description: "市立图书馆的夜班管理员�?,
  personality: "冷淡、怕麻烦�?,
  scenario: "闭馆前十分钟的图书馆�?,
  first_mes: "（他把还书车停住）……要借什么？",
  mes_example: "{{user}}: 你好\n{{char}}: 嗯�?,
  tags: ["图书管理�?, "冷淡"],
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

/** 假中转下发的音色表（形状�?relay/voices.js 一致，只要够断言"每角色一个音�?就行）�?*/
const VOICE_SPEAKERS = [
  { id: "zh_female_vv_uranus_bigtts", label: "vivi 2.0（女声·通用�?, lang: "zh", gender: "female", scene: "通用" },
  { id: "zh_male_m191_uranus_bigtts", label: "云舟 2.0（男声·通用�?, lang: "zh", gender: "male", scene: "通用" },
  { id: "zh_female_xiaohe_uranus_bigtts", label: "小何 2.0（女声·通用�?, lang: "zh", gender: "female", scene: "通用" },
  { id: "en_male_tim_uranus_bigtts", label: "Tim（英语男声）", lang: "en", gender: "male", scene: "通用" },
];

function startServer() {
  const requests = [];
  // 语音这一路单独记：断言"重复播放不再请求/换了音色会重新请�?切角色会取消"�?  const voiceRequests = [];
  // 语音失败�?*持续**的（不是一次性的）：客户端对超时会自动重试一次，
  // 一次性的失败开关会�?重试成功"看起来像"没有失败"（这一条踩过）�?  let voiceFailMode = false;
  // 假语音服务的人为延迟（毫秒）：用来验"合成要好几秒"时界面上的中间帧�?  let voiceDelayMs = 0;
  // 停止生成需要一�?慢慢吐字"的流：只在这条用例里打开，避免影响其它断言�?  let slowStream = false;
let truncateNext = false;
  // 「失�?�?重试」用例用：下一次模型请求直�?500�?  let failNext = false;
  // 下一次回复的内容可以由测试指定：用来验证 [[记住: …]] 这条真实链路�?  const replyQueue = [];
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

    // 清空待用回复队列：用例想"下一轮一定是这句"时先清一下，
    // 否则前面用例排队的回复会先被取走（队列是先进先出）�?    if (p === "/__reply-clear") {
      replyQueue.length = 0;
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

    // 让下一轮以 finish_reason=length 结束（模拟撞上输出上限被截断）�?    if (p === "/__truncate") {
      truncateNext = !truncateNext;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(truncateNext ? "on" : "off");
      return;
    }

    // 让下一次模型请求直接失败（用来验证"失败 �?重试"这条链路）�?    if (p === "/__fail-next") {
      failNext = true;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("on");
      return;
    }

    // 假中转：只实现「查额度」这一个接口，用来验证应用侧的体验卡流程�?    if (p === "/relay/card/quota") {
      const auth = String(req.headers.authorization || "");
      const ok = auth === "Bearer RW-AAAAA-BBBBB-CCCCC";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(ok
        ? { ok: true, id: "test-card", label: "测试", quota: { calls: 5, tokens: 5000 }, used: { calls: 1, tokens: 120 },
            callsLeft: 4, tokensLeft: 4880, expiresAt: "2026-10-12T00:00:00.000Z" }
        : { error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识" } }));
      return;
    }

    // 假中转的聊天口：用来验证"用体验卡真的能聊"，并且逐轮回剩余次数�?    if (p === "/relay/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 保持空对�?*/ }
      const auth = String(req.headers.authorization || "");
      if (auth !== "Bearer RW-AAAAA-BBBBB-CCCCC") {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了，或者已经被收回�? } }));
        return;
      }
      requests.push({
        path: p,
        relay: true,
        relayCard: auth.slice(-5),
        // 中转这一路也要记�?*流式标记与系统提示正�?*：伴�?语音那几条用例在体验卡模�?        //（假中转）下跑，不给这两个字段的话，`requests.filter((row) => row.stream === true)`
        // 会把它们整个漏掉 —�?断言就变�?看了一条更早的直连请求"，怎么写都不会红（真踩过）�?        stream: body.stream === true,
        systemText: (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n"),
      });
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
      // 排过队就按排队的回（跟直连那个口同一个队列）：语音消息那条用例在**体验卡模�?*下跑�?      // 而它必须能指�?这一轮角色说了什�?（要�?[[语音]] 标记）。没排队时保持原来那句台�?—�?      // 体验卡那几条用例断言的就是它�?      const queued = replyQueue.shift();
      if (queued) requests[requests.length - 1].queued = true;
      const pieces = queued ? [queued] : ["好呀�?, "我们出发吧�?];
      for (const piece of pieces) {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + "\n\n");
        await sleep(30);
      }
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (p === "/relay/voice/info") {
      // 假中转的语音能力口：客户端靠它决�?菜单里要不要出现朗读"�?      const auth = String(req.headers.authorization || "");
      const ok = auth === "Bearer RW-AAAAA-BBBBB-CCCCC";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(ok
        ? {
          ok: true, enabled: true, speakers: VOICE_SPEAKERS, defaultSpeaker: VOICE_SPEAKERS[0].id,
          maxChars: 400, format: "mp3", model: "seed-tts-2.0-standard", resourceId: "seed-tts-2.0",
          voiceLeft: 20, voiceCharsLeft: 2000, canSpeakNow: true,
        }
        : { error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识" } }));
      return;
    }

    if (p === "/relay/v1/audio/speech") {
      // 假中转的语音合成口：**把请求记下来**（音色、语速、文本）�?      // 这样"重复播放不再请求""换了音色会重新请�?这些都能断言�?      let raw = "";
      for await (const chunk of req) raw += chunk;
      const auth = String(req.headers.authorization || "");
      const body = raw ? JSON.parse(raw) : {};
      if (auth !== "Bearer RW-AAAAA-BBBBB-CCCCC") {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了�? } }));
        return;
      }
      voiceRequests.push({ text: body.text, speaker: body.speaker, speechRate: body.speech_rate });
      // 2026-09-14「语音前闪一下文字」那组用例要的开关：
      //   · `voiceDelayMs` —�?**延迟的假语音服务**：合成要好几秒时，界面必须在整段等待�?      //     都不出现正文（这是用户实测反馈的那个 bug，只截图看最后一眼是抓不到的）；
      //   · `voiceFailMode` —�?合成失败，用来验"失败�?+ 重试 + 改为文字"�?      if (voiceDelayMs > 0) await new Promise((r) => setTimeout(r, voiceDelayMs));
      if (voiceFailMode) {
        res.writeHead(504, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "VOICE_TIMEOUT", message: "上游合成超时了�? } }));
        return;
      }
      const audio = Buffer.from("MP3:" + String(body.text || ""), "utf8");
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "x-rw-voice-left,x-rw-voice-chars-left,x-rw-voice-speaker,x-rw-voice-chars,x-rw-card-calls-left",
        "x-rw-voice-speaker": String(body.speaker || ""),
        "x-rw-voice-chars": String(String(body.text || "").length),
        "x-rw-voice-left": "19",
        "x-rw-voice-chars-left": "1990",
        "x-rw-card-calls-left": "4",
      });
      res.end(audio);
      return;
    }

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 保持空对�?*/ }      // 「失�?�?重试」用例用：这一次直�?500，而且不记�?requests（就当没发生过）�?      if (failNext) {
        failNext = false;
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "测试用的失败：上游暂时不可用" } }));
        return;
      }
      // AI 写角色分两步：先扩写提示词，再照提示词写卡。两者靠系统提示词区分�?      const systemText = (Array.isArray(body.messages) ? body.messages : [])
        .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n");
      const isBriefCall = systemText.indexOf("character designer") >= 0;
      const isCardCall = systemText.indexOf("character card author") >= 0;
      requests.push({
        path: p, stream: body.stream === true, model: body.model,
        auth: req.headers.authorization || "", include_reasoning: body.include_reasoning,
        // 生成参数：用来断言"预设/自己�?真的落到了请求上�?        temperature: body.temperature, top_p: body.top_p, max_tokens: body.max_tokens,
        isBriefCall: isBriefCall,
        isCardCall: isCardCall,
        // 写卡那一步拿到的"角色描述"（如果走了扩写，这里应当是扩写稿�?        cardInput: isCardCall && body.messages[1] ? String(body.messages[1].content || "") : "",
        // 系统提示里是否带上了那条合成记忆：用来断言"删掉的记忆不再出�?�?        systemHasMemory: Array.isArray(body.messages)
          && body.messages.some((m) => m && m.role === "system" && String(m.content || "").indexOf("玩家叫小�?) >= 0),
        // 事件记忆：注入时必须�?[此前发生]，否则模型会把剧情经过当成玩家的现实信息�?        systemHasEvent: Array.isArray(body.messages)
          && body.messages.some((m) => m && m.role === "system" && String(m.content || "").indexOf("[此前发生]") >= 0),
        // 被替换掉的旧说法不该再出现（"玩家喜欢咖啡" 会误匹配新说法，所以用更精确的判断�?        systemHasStaleMemory: Array.isArray(body.messages)
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
        send({ content: "他把书合上�? });
        await sleep(400);
        send({ content: "\n[[记住: 玩家叫小林]]" });
        await sleep(900);
        // 这里停在半截的记忆标记上：用户如果现在按停止，界面上不能出现 `记住`�?        send({ content: "\n[[记住: 玩家怕黑" });
        await sleep(2000);
        send({ content: "]]\n“明天见。�? });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        // 先给两段思维链：思考模式关闭时它们必须一个都不显示�?        for (const thought of ["思考中�?, "思考中�?]) {
          res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta: { reasoning_content: thought } }] }) + "\n\n");
        }
        const queued = replyQueue.shift();
        if (queued) requests[requests.length - 1].queued = true;
        const pieces = queued ? [queued] : ["合成回复�?, "你好�?, "我是本地模型�?];
        for (const piece of pieces) {
          res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        if (truncateNext) {
          // 最后一段带�?finish_reason=length：这就是"撞上输出上限、话被截�?的信号�?          res.write("data: " + JSON.stringify({
            model: body.model || "synthetic",
            choices: [{ delta: {}, finish_reason: "length" }],
          }) + "\n\n");
        }
        // 真实接口最后会单独回一段用量（含缓存命中数）。以前这里没回，
        // 于是"发送前预估"永远拿不到真实基�?—�?那也是没测出来的原因之一�?        const promptTokens = (Array.isArray(body.messages) ? body.messages : [])
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
    server.listen(0, "127.0.0.1", () => resolve({
      server, port: server.address().port, requests, voiceRequests,
      failVoice(on) { voiceFailMode = on !== false; },
      /** 让假语音服务**慢下�?*（毫秒）。用来验"等待期间界面上不许出现正�?�?*/
      setVoiceDelay(ms) { voiceDelayMs = Math.max(0, Number(ms) || 0); },
    }));
  });
}

const results = [];
let failures = 0;

/*
 * 迭代时只跑一条（省时间）�? *   node tests/local-app-check.cjs --only=连发     只跑名字里含「连发」的那几�? *   node tests/local-app-check.cjs --from=语音设置  从第一条匹配的开始一直跑到底（保状态）
 *
 * �?这个套件�?*有状态的**（后面的用例依赖前面留下的对�?设置），所以：
 *   · `--from` 是日常主�?—�?前面几条被跳过但状态少一截，个别用例仍可能假红；
 *   · `--only` 只适合**自包�?*的用例；
 *   · 交付前照规矩�?*完整一�?*（或 `npm test`）�? */
const ARG_ONLY = (process.argv.find((one) => one.startsWith("--only=")) || "").slice(7).trim();
const ARG_FROM = (process.argv.find((one) => one.startsWith("--from=")) || "").slice(7).trim();
let ARG_FROM_HIT = !ARG_FROM;

async function check(name, fn) {
  if (ARG_ONLY && name.indexOf(ARG_ONLY) < 0) {
    results.push({ name, ok: true, skipped: true });
    return;
  }
  if (!ARG_FROM_HIT) {
    if (name.indexOf(ARG_FROM) < 0) {
      results.push({ name, ok: true, skipped: true });
      return;
    }
    ARG_FROM_HIT = true;
  }
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
    console.log("找不�?Chrome�? + CHROME + "（可�?CHROME_PATH 指定�?);
    process.exitCode = 1;
    return;
  }

  const { server, port, requests, voiceRequests, failVoice, setVoiceDelay } = await startServer();
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
          // 这张�?*故意不写语言标记**：没有语言约束就是"跟着玩家�?�?          // 也是伴侣段落走中文那条路的唯一现场（英文标记的卡下�?Hermione 有，那条路另有用例）�?          { avatar: "Harry Potter (EN).png", name: "Harry Potter", description: "被选中的男孩�?,
            personality: "勇敢", scenario: "霍格沃茨", first_mes: "你好�?, mes_example: "",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "Harry Potter", description: "被选中的男孩�?, personality: "勇敢",
                    scenario: "霍格沃茨", first_mes: "你好�?, mes_example: "", tags: [] } },
          { avatar: "Hermione Granger (EN).png", name: "Hermione Granger", description: "最聪明的女巫�?,
            first_mes: "你好�?, spec: "chara_card_v3", spec_version: "3.0", language: "en",
            data: { name: "Hermione Granger", description: "最聪明的女巫�?, first_mes: "你好�?, tags: [] } },
          // 第三张是**定制角色**（不在内置名单里）：2026-09-14 用户拍板之后�?          // 伴侣模式与语音只给定制角色，所以伴侣那一组用例要用它�?          // 故意不写语言标记（跟玩家说中文）—�?伴侣段落的中文那一条路要有现场�?          { avatar: "林默.png", name: "林默", description: "自己写的角色：安静、话少�?,
            personality: "话少", scenario: "手机上的一对一聊天", first_mes: "在�?,
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "林默", description: "自己写的角色：安静、话少�?, personality: "话少",
                    scenario: "手机上的一对一聊天", first_mes: "在�?, tags: [] } }
        ],
        worlds: [
          { name: "MB Harry �?fact clips (EN)", entries: {
            "0": { uid: 0, key: ["哈利"], keysecondary: [], comment: "测试条目", content: "合成记忆内容", disable: false, constant: false },
            // 内置包旧版带�?别人的存�?（原 SillyTavern 存档里的玩家角色 Lin）：
            // 启动时应当被 adapter/pack-cleanup.js 清掉，而上面那条用户条目要留下�?            "mb-fact-home": { uid: "mb-fact-home", key: ["Shanghai"], keysecondary: [], comment: "[STMB] 示例",
                              content: "Lin's home city is Shanghai, China. She grew up there before coming to Hogwarts.",
                              disable: false, constant: true } } },
          // 整本都是示例的书：清空之后应当连书一起删掉�?          { name: "MB Harry �?scene memories (EN)", entries: {
            "mb-scene-meeting": { uid: "mb-scene-meeting", key: [], keysecondary: [], comment: "[STMB] 示例",
                                  content: "Lin, a new Muggle-born student from Shanghai, nervously asked Harry Potter for directions to the Gryffindor common room.",
                                  disable: false, constant: false } } },
          // 一条合成的"自动记忆"，带来源：验证面板能显示它记了什么、来自哪句话，并能删掉�?          // comment 故意用内置包里那种迁移痕迹（[STMB] + 转换器说明）�?          // 它不该被当成标题显示到界面上�?026-09-12 用户就是这么看到一句英文的）�?          { name: "MB Harry �?自动记忆", entries: {
            "1": { uid: 1, key: [], keysecondary: [], comment: "[STMB] Human confirmation edit: correction narrative removed so no superseded value appears in prompt context.", content: "玩家叫小�?,
                   constant: true, disable: false, displayIndex: 1,
                   rw_source: { file: "harry-task26a-合成.jsonl", messageIndex: 4, at: "2026-09-11T02:00:00.000Z", origin: "model" } } } }
        ],
        chats: [
          // 最近聊过的一段：启动时会打开它（按最后消息时间取最新的那段）�?          // 时间按运行时刻算，这�?今天聊过"永远成立，用例不会因为隔天而飘�?          { avatar: "Harry Potter (EN).png", file_name: "harry-最近聊�?, messages: [
            { chat_metadata: {}, user_name: "�?, character_name: "Harry Potter" },
            { name: "�?, is_user: true, mes: "今天好热", send_date: "${new Date(Date.now() - 70 * 60000).toISOString()}" },
            { name: "Harry Potter", is_user: false, mes: "那就别出门了�?, send_date: "${new Date(Date.now() - 69 * 60000).toISOString()}" }
          ] },
          // 一段很久以前的对话：存储键�?.jsonl（老数�?/ 导入进来的形状）�?          // 既是历史检索的来源，也是「上次说到」和"旧对话打不开"那个缺陷的现场�?          { avatar: "Harry Potter (EN).png", file_name: "harry-以前的对�?jsonl", messages: [
            { chat_metadata: {}, user_name: "�?, character_name: "Harry Potter" },
            { name: "�?, is_user: true, mes: "我养了一只猫叫团�?, send_date: "2026-08-01T10:00:00.000Z" },
            { name: "Harry Potter", is_user: false, mes: "团子听起来很可爱�?, send_date: "2026-08-01T10:00:05.000Z" },
            { name: "�?, is_user: true, mes: "我一般买三文鱼味的猫�?, send_date: "2026-08-01T10:01:00.000Z" }
          ] }
        ],
        settings: {
          provider: "deepseek",
          endpoint: "${base}/v1/chat/completions",
          model: "deepseek-flash",
          // 主流程用例假�?引导已经走完"：否则首启导览浮层（.rw-ob）会盖住整个界面�?          // 用户点不到顶栏那颗「记忆」。引导本身另有专门用例（清空状态后重新走一遍）�?          tutorial_seen: true
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

  // 页面里的小工具：�?这一条角色消息的文字"。分条渲染之后一条消息可能没�?`.assistant-body`
  // （只有若�?`.message-part`），断言必须走它 —�?直接查会拿到 null�?  // �?**单独注册一�?*：内置包那条用例�?removeScript 掉上面那�?fixture 脚本�?  //   工具挂在 fixture 里就会跟着消失（第一版就是这样，报的�?"__rwReadAssistantText is not a function"）�?  await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", {
    source: [
      "window.__rwReadAssistantText = function (row) {",
      "  if (!row) return '';",
      "  const body = row.querySelector('.assistant-body');",
      "  if (body) return body.textContent;",
      "  const parts = Array.from(row.querySelectorAll('.message-part'));",
      "  if (parts.length) return parts.map((node) => node.textContent).join('\\n');",
      "  const stream = row.querySelector('.stream-text');",
      "  return stream ? stream.textContent : '';",
      "};",
    ].join("\n"),
  });

  async function evaluate(expression) {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error("页面脚本异常�? + (out.exceptionDetails.exception && out.exceptionDetails.exception.description
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
      } catch (_) { /* 导航�?*/ }
    }
    throw new Error("页面加载超时�? + url);
  }

  // 页面脚本一旦抛错，这里能直接把原始错误打出来，省得靠猜�?  function pageErrors() {
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
      if (Date.now() > deadline) throw new Error("等待超时�? + expression);
      await sleep(200);
    }
  }

  console.log("== 角色对话�?==");

  await goto(base + "/index.html");
  // 必须等这次启动彻底落定再清库：安装内容包是启动过程的一部分�?  // 半�?reset 会和它抢写，留下一个装了一半的库�?  await waitFor("window.TASK21_READY === true", 30000);

  // 清库并停用内置包，让 fixture 阶段的角色数量是确定的�?  await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); await RoleWorldPacks.setEnabled('harry-potter', false); return true; })()");
  await goto(base + "/index.html");

  // 摘掉 theme-pending �?bootLive 的最后一步，用它�?启动完成"信号最可靠�?  await waitFor("window.TASK21_READY === true", 30000);
  reportErrors("index.html");

  await check("启动时清掉内置包自带的示例记忆（别人的存档），用户自己的条目一条不�?, async () => {
    const worlds = await evaluate("(async () => (await RoleWorld.store.listWorlds()).map((w) => w.name))()");
    assert(worlds.indexOf("MB Harry �?scene memories (EN)") < 0,
      "整本都是示例的记忆书应当被删掉：" + JSON.stringify(worlds));
    assert(worlds.indexOf("MB Harry �?fact clips (EN)") >= 0, "里面还有用户条目的书不该被删�? + JSON.stringify(worlds));
    const entries = await evaluate("(async () => Object.keys((await RoleWorld.store.getWorld('MB Harry �?fact clips (EN)')).entries).sort())()");
    assert(JSON.stringify(entries) === JSON.stringify(["0"]), "示例条目该清掉、用户条目该留下�? + JSON.stringify(entries));
    const record = await evaluate("(async () => (await RoleWorld.store.getKV('packs:last-sample-cleanup', null)) || null)()");
    assert(record && Number(record.removed) >= 2, "应当留下可查的清理记录：" + JSON.stringify(record));
    const notice = await evaluate("(async () => (await RoleWorld.store.getKV('packs:sample-cleanup-notice', null)) || null)()");
    assert(notice === null, "一次性提示键应当已被界面消费掉：" + JSON.stringify(notice));
    const toast = await evaluate("(document.querySelector('#toast') || {}).textContent || ''");
    assert(toast.indexOf("示例记忆") >= 0, "启动时要顺口说清楚清掉了什么：" + JSON.stringify(toast));
  });

  await check("页面留在 index.html，没有跳转到登录�?, async () => {
    const href = await evaluate("location.pathname");
    assert(href.endsWith("/index.html"), "被跳转到�?" + href);
  });

  await check("启动遮罩已摘除，登录门与模板门都隐藏", async () => {
    const gate = await evaluate(`(() => {
      const node = document.querySelector('#chatTemplateGate');
      const message = document.querySelector('#chatTemplateGateMessage');
      return { hidden: node.hidden, text: message ? message.textContent : '' };
    })()`);
    assert(await evaluate("!document.documentElement.classList.contains('theme-pending')"), "theme-pending 仍存在（灰屏�?);
    assert(await evaluate("document.querySelector('#authGate').hidden === true"), "#authGate 仍然可见");
    assert(gate.hidden === true, "#chatTemplateGate 显示�? + gate.text);
  });

  await check("角色与记忆书从本机数据库读出", async () => {
    const counts = await evaluate("(async () => ({ c: (await RoleWorld.store.listCharacters()).length, w: (await RoleWorld.store.listWorlds()).length, names: (await RoleWorld.store.listCharacters()).map((x) => x.avatar), books: (await RoleWorld.store.listWorlds()).map((x) => x.name) }))()");
    // 3 张卡：Harry（内置）、Hermione（内置包里的英文卡）、林默（**定制角色**�?    // 伴侣与语音那一组用例要用它 —�?2026-09-14 用户拍板后内置小说人物不做伴侣）�?    assert(counts.c === 3, "角色数量应为 3，实�?" + counts.c + "�? + JSON.stringify(counts.names) + " / 书：" + JSON.stringify(counts.books));
    assert(counts.names.indexOf("林默.png") >= 0, "fixture 里缺少那张定制角色卡�? + JSON.stringify(counts.names));
    // fixture 里有 2 本记忆书：fact clips + 一本带来源的「自动记忆」（用于记忆面板用例）�?    assert(counts.w === 2, "记忆书数量应�?2，实�?" + counts.w + "�? + JSON.stringify(counts.books));
  });

  await check("输入框可用（说明角色卡、端点、会话三个条件都满足�?, async () => {
    assert(await evaluate("document.querySelector('#messageInput').disabled === false"), "输入框被禁用");
    assert(await evaluate("document.querySelector('#sendButton').disabled === false"), "发送按钮被禁用");
  });

  // 2026-09-12：用户反�?看不到记�?。根因是顶栏那颗「记忆」按钮自�?hidden�?  // 而且没有任何代码把它摘掉——右栏只能靠 window.TASK21.openMemoryPanel() 打开�?  // 以前的用例全都是调内部函数，所以一次也没碰到这个入口�?  await check("顶栏「记忆」按钮看得见、点得开（不是只有内部函数能开记忆栏）", async () => {
    const hit = await evaluate(`(() => {
      const button = document.querySelector('.topbar-actions [data-action="open-memories"]');
      if (!button) return { problem: '顶栏里根本没有「记忆」按�? };
      const style = getComputedStyle(button);
      if (button.hidden || style.display === 'none' || style.visibility === 'hidden') {
        return { problem: '「记忆」按钮是隐藏的（hidden=' + button.hidden + '，display=' + style.display + '�? };
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
        return { problem: '「记忆」按钮被别的元素挡住�? + (cover ? (cover.className || cover.tagName) : 'null') };
      }
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    assert(!hit.problem, hit.problem);

    // 用真鼠标点：hidden 元素�?element.click() 照样会触发事件，所以上面那组几何检查才是这条用例的关键�?    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.sessionSend(session, "Input.dispatchMouseEvent", { type, x: hit.x, y: hit.y, button: "left", clickCount: 1 });
    }
    // 用户 2026-09-13 定的分工：「手机版就直接弹出弹窗，电脑版就直接打开侧边栏」�?  // 用例跑在宽屏上，所以这里量的是**右侧记忆�?*打开了（窄屏那条�?viewport 套件覆盖）�?  await waitFor("document.querySelector('.inspector-column').getAttribute('aria-hidden') === 'false'", 8000);
  await evaluate("window.TASK25C_UI.setMemoryPanelOpen ? window.TASK25C_UI.setMemoryPanelOpen(false) : null; true");
    await waitFor("document.querySelectorAll('#memoryBookList .memory-book').length > 0", 8000);
    const listed = await evaluate("document.querySelector('#memoryBookList').textContent");
    assert(listed.indexOf("自动记忆") >= 0, "记忆栏里没列出真实记忆书�? + JSON.stringify(listed));
    // 迁移工具留在 comment 里的说明不许当标题（fixture 那条就是内置包里那种）�?    assert(listed.indexOf("Human confirmation") < 0,
      "面板把迁移痕迹当标题显示了：" + JSON.stringify(listed.slice(0, 160)));
    const firstTitle = await evaluate(`(() => {
      const entry = document.querySelector('#memoryBookList .memory-entry');
      const strong = entry && entry.querySelector('strong');
      return strong ? strong.textContent : '';
    })()`);
    assert(firstTitle && firstTitle.indexOf("Human confirmation") < 0,
      "第一条记忆的标题不对�? + JSON.stringify(firstTitle));

    await evaluate("document.querySelector(\"[data-action='close-memories']\").click(); true");
    await waitFor("document.querySelector('.inspector-column').getAttribute('aria-hidden') === 'true'", 8000);
    reportErrors("index.html");
  });

  // 每次发送后都等"这一轮彻底结�?再往下走：只看消息文本会被用户自己那句话误判成已完成�?  async function waitTurnSettled() {
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 25000);
  }

  await check("「本次请求」平时不出现，打字或发过消息后才露出入口", async () => {
    // 这条要放在第一次发送之前�?026-09-12 起：花费与预估搬进了这个面板�?    // 所�?输入框里已有草稿"也算一次可看的机会（否则第一条消息看不到发送前预估）�?    assert(await evaluate("document.querySelector('#requestPeekButton').hidden === true"), "还没打字就出现了入口");
    assert(await evaluate("document.querySelector('#requestPeek').hidden === true"), "面板初始就是打开�?);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '看看这次请求';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 预估�?250ms 防抖，等它算完入口才该露出来�?    await waitFor("document.querySelector('#requestPeekButton').hidden === false", 8000);
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
    assert(await evaluate("document.querySelector('#requestPeek').hidden === true"), "面板不该自己弹出�?);
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
    // 用户 2026-09-12 反馈桌面版「有时候提示回复未保存发不出去」。根因之一�?Rust �?    // （Windows 上重命名被占�?�?原子写失败），已经加了重试与兜底�?    // 这里守的是另一半：**别再拿一�?请重�?把真实原因吞�?*�?    await evaluate(`(() => {
      window.__origSaveChat = window.STApi.saveChat;
      window.STApi.saveChat = async () => { throw new Error('写入失败 chats/Harry Potter (EN).png/x.json：Access is denied. (os error 5)'); };
      return true;
    })()`);
    try {
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '这一句会存不�?;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      const toast = await evaluate("document.querySelector('#toast').textContent");
      assert(toast.indexOf("回复没存�?) >= 0, "没有说明是「存不上」：" + toast);
      assert(toast.indexOf("Access is denied") >= 0, "提示里没有真实原因（又被吞了）：" + toast);
      const visible = await evaluate("document.querySelector('#dynamicMessages').textContent");
      assert(visible.indexOf("这一句会存不�?) >= 0, "用户那句话消失了（存不上时不该把屏幕清空�?);
      assert(visible.indexOf("我是本地模型") >= 0 || visible.indexOf("合成回复") >= 0, "回复内容也消失了");
    } finally {
      await evaluate("(() => { if (window.__origSaveChat) window.STApi.saveChat = window.__origSaveChat; return true; })()");
    }
  });

  await check("模型请求走的是本机配置的端点，并且带了流式标�?, async () => {
    const sent = requests.filter((row) => row.stream === true);
    assert(sent.length >= 1, "没有收到流式请求");
    // 模型名以「设�?�?模型」里填的为准，不再由下拉框里的固定选项决定�?    assert(sent[sent.length - 1].model === "deepseek-flash", "模型名不对：" + sent[sent.length - 1].model);
  });

  await check("台账：每轮记下延迟与费用，面板能看到汇�?, async () => {
    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    // 前面已经发过几轮，所以轮数不写死；只要求确实在统计�?    assert(/台账（最�?\d+ 轮）：首字平�?[\d.]+(ms|s)/.test(text),
      "台账没有统计首字延迟�? + JSON.stringify(text.slice(0, 200)));
    assert(/整轮平均 [\d.]+(ms|s)/.test(text), "台账没有统计整轮延迟�? + JSON.stringify(text.slice(0, 200)));
    assert(/费用合计 ¥[\d.]+/.test(text), "台账没有统计费用�? + JSON.stringify(text.slice(0, 200)));
    assert(/记错 \d+ 次（[\d—]+%�?.test(text), "台账没有记错次数�? + JSON.stringify(text.slice(0, 200)));
    assert(text.indexOf("只能由你手动标记") >= 0, "没有说明标记是手动的");
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("标记「记错」：点一下计入台账，再点取消", async () => {
    // 每条助手回复旁边都该有标记入�?    const count = await evaluate("document.querySelectorAll('.message-flag').length");
    assert(count >= 2, "助手消息旁边没有标记入口，实际按钮数 " + count);

    // 最近一轮的轮次 ID�?*从界面上�?*（台账里可能�?没有消息�?的轮次，
    // 比如上一轮保存失�?—�?只按台账最后一条去对会错位）�?    const turnId = await evaluate(`(() => {
      const boxes = Array.from(document.querySelectorAll('.message-flags[data-turn-id]'));
      return boxes.length ? boxes[boxes.length - 1].dataset.turnId : '';
    })()`);
    assert(turnId, "界面上没有带轮次 ID 的标记控�?);

    // 点最近那条助手回复旁边的「记错�?    const clicked = await evaluate(`(() => {
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
      // 台账是按**这一轮那个角�?*存的，不�?列表第一张卡" —�?fixture 里现在有三张�?      // （Harry / Hermione / 林默），写死 cards[0] 迟早会读到别人的台账（真踩过一次）�?      const cards = await store.listCharacters();
      const rows = await Promise.all(cards.map((card) => store.getKV('metrics:' + card.avatar, [])));
      const hit = rows.flat().find((t) => t && t.turnId === ${JSON.stringify(turnId)});
      return !!(hit && (hit.flags || []).indexOf('wrong-memory') >= 0);
    })()`, 8000).catch(() => false);
    assert(flagged, "点了「记错」，台账里却没有记上");
    assert(await evaluate("document.querySelector('.message-flag.flag-on') !== null"), "按钮没有显示为已标记");

    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    assert(/记错 [1-9]\d* �?.test(text), "标记后台账没�?+1�? + JSON.stringify(text.slice(0, 200)));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);

    // 再点一次取�?    await evaluate(`(() => {
      const button = document.querySelector('.message-flag.flag-on');
      button.click();
      return true;
    })()`);
    await waitFor("document.querySelector('.message-flag.flag-on') === null", 8000);
  });

  await check("顶栏可以直接切换模型，并且写回同一份配�?, async () => {
    const current = await evaluate("(document.querySelector('#chatModelSelect') || {}).value");
    assert(current === "deepseek-flash", "顶栏当前值不对：" + current);
    assert(await evaluate("document.querySelector('#chatDeepseekKeyInput') === null"), "对话页仍有重复的密钥输入�?);
    const options = await evaluate("Array.from(document.querySelectorAll('#chatModelSelect option')).map((o) => o.value)");
    assert(options.indexOf("deepseek-flash") >= 0, "已知型号没列出来�? + JSON.stringify(options));
    assert(options.indexOf("deepseek-v4-pro") < 0,
      "DeepSeek 只留 deepseek-flash（用户要求不再用 v4-pro）：" + JSON.stringify(options));
    assert(options.indexOf("__custom__") >= 0, "缺少「自定义模型名…」入�?);

    await evaluate(`(() => {
      const select = document.querySelector('#chatModelSelect');
      select.value = 'deepseek-v4-pro';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(document.querySelector('[data-roleworld=\"model\"]') || {}).value === 'deepseek-flash'", 8000);

    await evaluate(`(() => {
      const select = document.querySelector('#chatModelSelect');
      select.value = 'deepseek-flash';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(document.querySelector('[data-roleworld=\"model\"]') || {}).value === 'deepseek-flash'", 8000);
  });

  await check("对话界面显示 token 用量与费用估�?, async () => {
    await waitFor("(document.querySelector('#chatCostLine') || {}).textContent.length > 0", 8000);
    const line = await evaluate("document.querySelector('#chatCostLine').textContent");
    assert(/本对�?\d+ �?.test(line), "费用行没有轮次：" + line);
    assert(/输入 [\d.]+k? \/ 输出 [\d.]+k? tokens/.test(line), "费用行没�?token 用量�? + line);
    assert(/累计 [≈]?¥[\d.]+/.test(line), "费用行没有金额：" + line);
    assert(/单价 ¥[\d.]+\/¥[\d.]+ 每百�?tokens�?高峰|闲时)时段�?.test(line), "费用行没带单价与峰谷�? + line);
  });

  await check("面板按来源分段，且分段之和与真正发出的请求一�?, async () => {
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    for (const label of ["系统提示", "角色�?· 描述", "回复格式要求", "本轮输入"]) {
      assert(text.indexOf(label) >= 0, "面板缺少分段�? + label + " —�?" + JSON.stringify(text.slice(0, 200)));
    }
    assert(/合计 \d+ �?· [\d.]+k? tokens · �?\d+ 条消�?.test(text), "没有合计行：" + JSON.stringify(text.slice(-160)));
    assert(text.indexOf("已核对：分段之和与真正发出的请求逐字节一�?) >= 0,
      "面板没有给出逐字节一致性结论：" + JSON.stringify(text.slice(-200)));
    assert(text.indexOf("会发送给你配置的模型服务�?) >= 0, "面板缺少隐私提示");

    // 只读：打开面板不能发出新的模型请求
    const before = requests.length;
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(requests.length === before, "打开面板竟然发出了新的请�?);

    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("发送前预估：输�?token / 费用 / 输出上限，发之前就看得见", async () => {
    const before = requests.filter((row) => row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '预估一下这�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 输入�?250ms 防抖，等它自己更新�?    const shortTitle = await waitFor(`(() => {
      const node = document.querySelector('#chatEstimateLine');
      if (!node || node.hidden) return '';
      return node.title && node.title.indexOf('输入�?) >= 0 ? node.title : '';
    })()`, 8000);
    const shortTokens = Number((shortTitle.match(/输入�?(\d+) token/) || [])[1] || 0);
    assert(shortTokens > 0, "预估里没有输�?token�? + shortTitle);
    const line = await evaluate("document.querySelector('#chatEstimateLine').textContent");
    assert(/这次�?[\d.]+k? 输入 �?¥/.test(line), "预估行写法不对：" + line);
    assert(line.indexOf("输出上限") >= 0, "预估行没有把输出上限分开写：" + line);
    assert(/命中缓存 �?¥/.test(line), "预估行没有给缓存命中的口径：" + line);
    assert(shortTitle.indexOf("上下�?) >= 0, "悬停说明里没有上下文那一�?);

    // 草稿写得越长，预估越�?—�?说明它真的看了输入框里的字�?    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = ${JSON.stringify("这一句用来把草稿撑长，看看预估会不会跟着涨�?.repeat(12))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const longTitle = await waitFor(`(() => {
      const node = document.querySelector('#chatEstimateLine');
      const match = node && node.title ? node.title.match(/输入�?(\\d+) token/) : null;
      return match && Number(match[1]) > ${shortTokens} ? node.title : '';
    })()`, 8000);
    const longTokens = Number((longTitle.match(/输入�?(\d+) token/) || [])[1] || 0);
    assert(longTokens > shortTokens, "草稿变长但预估没变：" + shortTokens + " �?" + longTokens);
    assert(requests.filter((row) => row.stream === true).length === before,
      "只是预估，不该发出任何请�?);

    // 发出去之后，接口回来的真实用量要和预估放得上同一个量级（差得离谱说明估法错了）�?    await evaluate("document.querySelector('#sendButton').click(); true");
    await waitTurnSettled();
    const after = await evaluate(`(async () => {
      const node = document.querySelector('#chatEstimateLine');
      return { title: node.title, text: node.textContent };
    })()`);
    assert(/输入�?\d+ token/.test(after.title), "发完一轮之后预估应当以真实用量继续对照�? + after.title);

    // 面板里把「上下文」和「输出上限」分开写清楚�?    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const body = await evaluate("document.querySelector('#requestPeekBody').textContent");
    assert(/上下文：输入 \d+ token（占 \d+ �?\d+%�?\+ 输出上限 \d+ token/.test(body),
      "面板没有把上下文与输出上限分开写：" + JSON.stringify(body.slice(-260)));
    // �?DeepSeek 官方时上下文就是 1000000：设置里那个"本地端点上下�?不能套到它头上，
    // 否则"输入 + 输出上限(32768)"必然超限，每一次发送都会被预检拦下（踩过一次）�?    assert(body.indexOf("（占 1000000 �?") >= 0,
      "官方模型的上下文应当�?1000000�? + JSON.stringify(body.slice(-260)));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("预算调小后，面板会写明「没带上的旧对话」而不是悄悄丢�?, async () => {
    // 把旧对话预算调到设置下限�?000），再多聊几轮，让历史超出预算�?    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="history-budget"]');
      input.value = '1000';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 先确�?刚改完设置就发�?用的是新值，而不是启动时读的旧值�?    await waitFor("window.__rwBudget === undefined || window.__rwBudget === 0", 2000).catch(() => {});
    // 造足够大的历史：这一条约 1600 tokens，必然超�?1000 的预算（至少要丢掉更早的内容）�?    const longText = '这是一句用来把历史撑过预算的话�?.repeat(110);
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
    assert(/未带上：更早�?\d+ 条消�?.test(text), "没有说明丢了几条�? + JSON.stringify(text.slice(-320)));
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

  await check("默认不限制：以前的对话全部带上，不只是最近几�?, async () => {
    // 先把预算清空�? 不限制），再聊一轮看是不是全带上�?    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="history-budget"]');
      input.value = '';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再看�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const total = await evaluate("document.querySelectorAll('#dynamicMessages .message-row').length");
    assert(total >= 8, "消息太少，测不出这条，实�?" + total);
    await evaluate("document.querySelector('#requestPeekButton').click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    const match = text.match(/旧对话（最�?(\d+) 条）/);
    assert(match, "面板没有旧对话分段：" + JSON.stringify(text.slice(0, 200)));
    const kept = Number(match[1]);
    // 界面上第一行是角色开场白，它不算"历史"；其余都该带上�?    assert(kept >= total - 2, "默认应当把以前的对话全部带上：界面上�?" + total + " 条，只带�?" + kept + " �?);
    assert(text.indexOf("未带上：") < 0, "默认不限制，不该出现\"未带上\"�? + JSON.stringify(text.slice(-200)));
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
    assert(text.indexOf("玩家叫小�?) >= 0, "没有列出记忆内容�? + JSON.stringify(text));
    assert(text.indexOf("模型自记") >= 0, "没有标明是谁记的�? + JSON.stringify(text));
    assert(text.indexOf("harry-task26a-合成.jsonl") >= 0, "没有标出来自哪段对话�? + JSON.stringify(text));
    assert(text.indexOf("�?4 �?) >= 0, "没有标出来自第几条消息：" + JSON.stringify(text));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("记忆能删：删掉后后续请求里真的不再带上它", async () => {
    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelectorAll('#memoryList .memory-list li').length > 0", 8000);
    const before = await evaluate("document.querySelector('#memoryList').textContent");
    assert(before.indexOf("玩家叫小�?) >= 0, "记忆面板没列出这条记忆：" + JSON.stringify(before));

    await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('#memoryList .memory-list li'))
        .find((li) => li.textContent.indexOf('玩家叫小�?) >= 0);
      const del = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '�?);
      del.click();
      return true;
    })()`);
    await waitFor("document.querySelector('#memoryList').textContent.indexOf('玩家叫小�?) < 0", 10000);
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");

    // 下一轮请求里不能再出现这条记�?    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '删完之后再说一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last && last.systemHasMemory !== true, "被删掉的记忆又出现在请求里了");
  });

  await check("改口：说一次「不喜欢了」，旧记忆被替换而不是两条并�?, async () => {
    // 先清�?fixture 里那条合成记忆，从干净状态开始�?    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelectorAll('#memoryList .memory-list li').length >= 0", 5000);
    const rows = await evaluate("document.querySelectorAll('#memoryList .memory-list li').length");
    for (let i = 0; i < rows; i += 1) {
      await evaluate(`(() => {
        const del = document.querySelector('#memoryList .memory-list li button:last-child');
        if (del && del.textContent.trim() === '�?) del.click();
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");

    // 第一轮：模型记下「玩家喜欢咖啡�?    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "好的，我记下了。\n[[记住: 喜欢的饮�?| 玩家喜欢咖啡]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我喜欢喝咖啡';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const firstBook = await evaluate("(async () => JSON.stringify((await window.STApi.getWorld('MB Harry �?自动记忆')).entries))()");
    assert(firstBook.indexOf("玩家喜欢咖啡") >= 0, "第一轮没有把记忆写进去：" + firstBook);

    // 第二轮：玩家改口
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "明白了。\n[[记住: 饮料 | 玩家现在不喜欢咖啡了]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我现在不喜欢咖啡�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    // 只看每条记忆�?content，不�?replacedContent（那�?替换记录"，是故意留的）�?    const contents = await evaluate(`(async () => {
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
      return Object.keys(world.entries || {}).map((key) => String(world.entries[key].content || ''));
    })()`);
    assert(contents.length === 1, "改口后应当只剩一条记忆，实际 " + contents.length + " 条：" + JSON.stringify(contents));
    assert(contents[0] === "玩家现在不喜欢咖啡了", "留下的应当是改口后的新说法：" + JSON.stringify(contents));
    assert(contents.indexOf("玩家喜欢咖啡") < 0, "旧说法还作为一条独立记忆存在：" + JSON.stringify(contents));

    // 下一轮请求里也不能再带上那句旧说�?    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再问一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const lastSystem = sent[sent.length - 1];
    assert(lastSystem && lastSystem.systemHasStaleMemory !== true, "被替换掉的旧记忆还发给了模型");
  });

  await check("事件记忆：角色记得之前发生了什么，注入时标明「此前发生�?, async () => {
    // 用户 2026-09-12：「我是要让哈利等小说人物记得之前发生了什么」�?    await fetch(base + "/__reply", {
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

    // �?事件真的写进了记忆，而且标成 event（不是事实）
    const stored = await evaluate(`(async () => {
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
      return Object.keys(world.entries || {}).map((key) => ({
        content: String(world.entries[key].content || ''),
        kind: (world.entries[key].rw_source || {}).kind || '',
      }));
    })()`);
    const eventRow = stored.find((row) => row.content === "两人约好周六下午在球场学飞行");
    assert(eventRow, "事件没有写进记忆�? + JSON.stringify(stored));
    assert(eventRow.kind === "event", "事件被当成了别的东西�? + JSON.stringify(eventRow));

    // �?标记不能漏到界面�?    const visible = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(visible.indexOf("[[事件") < 0, "事件标记漏到界面上了");
    assert(visible.indexOf("周六下午") >= 0, "这轮回复的内容没显示出来");

    // �?下一轮请求里，这条事件必须带 [此前发生] 前缀
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "嗯�? }) });
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
    assert(last && last.systemHasEvent === true, "事件没有�?[此前发生] 前缀就发给了模型");
    assert(last.systemText.indexOf("[此前发生] 两人约好周六下午在球场学飞行") >= 0,
      "事件前缀或内容不对：" + JSON.stringify(last.systemText.slice(-320)));

    // �?面板上单独一类，用户能看�?这是发生过的�?
    const grouped = await evaluate(`(async () => {
      const rows = window.ROLEWORLD_MEMORY_CORE.listEntries((await window.STApi.getWorld('MB Harry �?自动记忆')).entries);
      return rows.filter((row) => row.kind === 'event').map((row) => row.content);
    })()`);
    assert(grouped.length === 1 && grouped[0] === "两人约好周六下午在球场学飞行", "面板读不出这条事件：" + JSON.stringify(grouped));
  });

  await check("剧情不算你的事实：模型想把剧情写进记忆会被拦�?, async () => {
    // 让模型同时写一条真事实和一条剧�?    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "记下了。\n[[记住: 怕的东西 | 玩家怕黑]]\n[[记住: 剧情 | *你挥动魔杖挡住了巨龙的攻�?]]",
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
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
      return Object.keys(world.entries || {}).map((key) => String(world.entries[key].content || ''));
    })()`);
    assert(contents.some((row) => row.indexOf("玩家怕黑") >= 0),
      "真事实应当被记住，实际：" + JSON.stringify(contents));
    assert(!contents.some((row) => row.indexOf("巨龙") >= 0 || row.indexOf("魔杖") >= 0),
      "剧情被写进了记忆（这是底线问题）�? + JSON.stringify(contents));
  });

  await check("诚实规则每次都在，并明确禁止编�?, async () => {
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last && last.systemText, "没有拿到系统提示");
    assert(last.systemText.indexOf("[Honesty]") >= 0, "系统提示里没有诚实规�?);
    assert(last.systemText.indexOf("不要为了显得连贯而编�?) >= 0,
      "诚实规则没有明确禁止编造：" + JSON.stringify(last.systemText.slice(0, 200)));
    // 真踩过的坑：只写"没依据就说不知道"，模型会连同一段对话里刚说过的话都不敢认�?    assert(last.systemText.indexOf("正在进行的这段对�?) >= 0,
      "诚实规则没有说明眼前的对话算事实");
    assert(last.systemText.indexOf("不要怀疑它") >= 0,
      "诚实规则没有要求不要否认刚说过的�?);
  });

  await check("翻得到：以前的对话被检索出来，并带出处交给模型", async () => {
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "团子吗？我记得�? }),
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
    assert(last.systemText.indexOf("[History search]") >= 0, "没有历史检索那一�?);
    assert(last.systemText.indexOf("我养了一只猫叫团�?) >= 0,
      "没有把以前那句话翻出来：" + JSON.stringify(last.systemText.slice(-400)));
    assert(last.systemText.indexOf("harry-以前的对�?jsonl") >= 0, "翻出来了但没带出�?);
    assert(last.systemText.indexOf("�?1 �?) >= 0, "没有标出是第几条");
  });

  await check("模型主动翻查：标记不进正文，结果在下一轮交给它", async () => {
    // 第一轮：模型要求�?猫粮"
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

    // 正文里不能留下搜索标�?    const shown = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(shown.indexOf("搜索") < 0, "搜索标记漏进了正文：" + JSON.stringify(shown.slice(-120)));
    assert(shown.indexOf("我先查一�?) >= 0, "正文内容丢了�? + JSON.stringify(shown.slice(-120)));

    // 第二轮：系统应当把它点名要翻的原话交给模�?    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "找到了，三文鱼味的�? }),
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
    assert(last.systemText.indexOf("我一般买三文鱼味的猫�?) >= 0,
      "模型点名要翻的内容没有在下一轮交给它�? + JSON.stringify(last.systemText.slice(-400)));
    assert(last.systemText.indexOf("[History access]") >= 0, "没有告诉模型它可以主动翻�?);
  });

  await check("翻不到就明说没有记录，并禁止编�?, async () => {
    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "这个我不知道�? }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我们去过月球�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last.systemText.indexOf("没有找到") >= 0,
      "翻不到时没有明说没有记录�? + JSON.stringify(last.systemText.slice(-400)));
    assert(last.systemText.indexOf("不要猜测") >= 0, "翻不到时没有禁止编�?);
  });

  await check("引用了以前的记录时会标出来，点开能看原话、点一下能跳回�?, async () => {
    // 让模型这一�?*逐字**引用以前那句（这是判定引用的唯一依据）�?    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你说过「我养了一只猫叫团子」，我记着呢�? }),
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
    assert(probe.found, "回复引用了原话，但下面没有标出来�? + JSON.stringify(probe));
    assert(/引用�?1 条以前的记录/.test(probe.toggle), "标注条数不对�? + probe.toggle);
    assert(probe.listHidden === true, "默认应当是收起的");
    assert(probe.items.length === 1 && probe.items[0].indexOf("我养了一只猫叫团�?) >= 0,
      "展开后应当能看到那条原话�? + JSON.stringify(probe.items));

    // 没引用就不该出现这个入口（上面那�?我们去过月球�?的回复没有引用任何记录）�?    // 注意：这条要在跳转之前查，跳走之后这段对话就不在 DOM 里了�?    const withoutRefs = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      const hit = rows.find((row) => row.textContent.indexOf('这个我不知道') >= 0);
      return hit ? !!hit.querySelector('.message-refs') : null;
    })()`);
    assert(withoutRefs === false, "没引用的回复上也挂了引用入口（null 表示那一行已经不�?DOM 里）�? + withoutRefs);

    // 展开 �?点一�?�?跳到那段对话并高亮原话�?    await evaluate("document.querySelector('#dynamicMessages .message-refs-toggle').click(); true");
    await waitFor("document.querySelector('#dynamicMessages .message-refs-list').hidden === false", 5000);
    await evaluate("document.querySelector('#dynamicMessages .message-refs-item').click(); true");
    await waitFor("window.TASK21.activeChatFileName().indexOf('以前的对�?) >= 0", 15000);
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('团子') >= 0", 15000);

    // 切回最近那段，别影响后面的用例（切不回去后面会跟着在这段旧对话里发消息）�?    const current = await evaluate(`(() => {
      const row = window.TASK21.sessionList().find((session) => String(session.fileName).indexOf('最近聊�?) >= 0);
      return row ? row.id : '';
    })()`);
    assert(current, "会话表里找不到最近聊过的那段对话");
    await evaluate(`window.TASK21.selectChat(${JSON.stringify(current)}); true`);
    await waitFor("window.TASK21.activeChatFileName() === 'harry-最近聊�?", 10000);
  });

  await check("「记忆」栏显示的是真实记忆书，不是写死的示例数�?, async () => {
    // 真踩过的坑：index.html 里有两个 id="memoryList"（角色记忆弹层一个、右侧记忆栏一个）�?    // querySelector 只命中文档里第一�?—�?于是真实记忆书被画进了弹层、右栏永远空白；
    // �?app.js 里那份「角色锁定书/场景记忆/精确事实」是写死的示例数据，一度被当成真数据渲染�?    const ids = await evaluate("document.querySelectorAll('#memoryList').length");
    assert(ids === 1, "文档里应当只有一�?#memoryList（弹层用），实际 " + ids);
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
    // 正面信号：拿本机数据库里**真实的条目内�?*去对（书名是本地化的，示例书的名字和内置包撞车，
    // 所以不能靠名字判断）�?    const realEntries = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
      return core.listEntries(world.entries).map((row) => row.content);
    })()`);
    assert(realEntries.length >= 1, "fixture 里应当有真实记忆条目");
    assert(realEntries.some((content) => column.text.indexOf(content) >= 0),
      "「记忆」栏没有渲染本机数据库里的真实条目：" + JSON.stringify({ 栏里: column.books, 库里: realEntries }));
    // 反面信号：示例书里那几句写死的内容一句都不许出现�?    for (const fake of ["霍格沃茨五年级学�?, "旧教室谈起借扫�?, "扫帚会在使用后归�?, "关系状态随新会话修�?]) {
      assert(column.text.indexOf(fake) < 0, "「记忆」栏出现了写死的示例内容�? + fake);
    }

    // 弹层里也不该混进示例数据（它只显示该角色自己的自动记忆）
    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const panelText = await evaluate("document.querySelector('#memoryPanel #memoryList').textContent");
    for (const fake of ["霍格沃茨五年级学�?, "旧教室谈起借扫�?, "扫帚会在使用后归�?]) {
      assert(panelText.indexOf(fake) < 0, "角色记忆面板里出现了示例数据�? + fake);
    }
    assert(await evaluate("!!document.querySelector('#memoryPanel #memoryList #memoryOrientation')"),
      "记忆面板里应当有记忆取向选择�?);
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
  });

  await check("记忆面板按主题分组、能折叠、显示用�?, async () => {
    // 先塞两条记忆（不同主题），这样才有多个分组可看�?    await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const store = window.RoleWorld.store;
      const book = 'MB Harry �?自动记忆';
      let data = { entries: {} };
      try { const existing = await store.getWorld(book); if (existing && existing.entries) data = existing; } catch (_) {}
      let entries = core.applyMemories(data.entries || {}, [
        { topic: '饮料', content: '玩家喜欢咖啡' },
        { topic: '怕的东西', content: '玩家怕黑' }
      ], {}).entries;
      await store.putWorld(book, { entries });
      return true;
    })()`);
    await evaluate("window.TASK21.openMemoryPanel()");
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
    assert(/已用 \d+ \/ 上限 \d+ �?.test(probe.usage), "没有显示条数用量�? + JSON.stringify(probe.usage));
    assert(probe.hasClearAll, "没有一键清空按�?);
    assert(/清空这个角色的全部记�?.test(probe.clearAllText), "一键清空按钮文案不对：" + probe.clearAllText);

    // 折叠：点一下收起，再点一下展开
    await evaluate("document.querySelector('.memory-group-toggle').click(); true");
    await waitFor("document.querySelector('#memoryList .memory-group .memory-list').hidden === true", 5000);
    await evaluate("document.querySelector('.memory-group-toggle').click(); true");
    await waitFor("document.querySelector('#memoryList .memory-group .memory-list').hidden === false", 5000);
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
  });

  await check("一键清空该角色全部记忆：清完后面板为空、下一轮请求不再带�?, async () => {
    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    await waitFor("document.querySelector('.memory-panel-foot .danger-button') !== null", 8000);

    // confirm 在无头环境会挂起，测试里替换�?确定"�?    await evaluate(`(() => {
      window.__origConfirm = window.confirm;
      window.confirm = () => true;
      return true;
    })()`);
    await evaluate("document.querySelector('.memory-panel-foot .danger-button').click(); true");
    await waitFor("document.querySelector('#memoryList').textContent.indexOf('还没有记�?) >= 0", 10000);
    await evaluate("window.confirm = window.__origConfirm; true");

    const left = await evaluate("(async () => (await window.STApi.getWorld('MB Harry �?自动记忆')).entries)()");
    assert(Object.keys(left || {}).length === 0, "清空后记忆书里还有条目：" + JSON.stringify(Object.keys(left || {})));

    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
    await waitFor("document.querySelector('#memoryPanel').hidden === true", 8000);

    // 下一轮请求的系统提示里不该再有被清掉的内�?    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '清空记忆之后再说一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    // 注意：提示词模板里带了示例「[[记住: 喜欢的饮�?| 玩家喜欢咖啡]]」，
    // 所以不能按"玩家喜欢咖啡"这种子串判断 —�?要按**记忆书段�?*判断�?    const bookStart = last.systemText.indexOf("[Memory Book: MB Harry �?自动记忆");
    assert(bookStart < 0,
      "清空后记忆书仍出现在请求里：" + JSON.stringify(last.systemText.slice(Math.max(0, bookStart), bookStart + 120)));
    assert(last.systemText.indexOf("] 玩家喜欢咖啡") < 0, "清空后旧记忆条目还出现在请求�?);
    assert(last.systemText.indexOf("] 玩家怕黑") < 0, "清空后旧记忆条目还出现在请求�?);
  });

  await check("记忆的「看原话」能跳回来源消息", async () => {
    // 造一条带来源的记忆：来源指向 fixture 里那段旧对话的第 1 条（"我养了一只猫叫团�?）�?    await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const store = window.RoleWorld.store;
      const book = 'MB Harry �?自动记忆';
      const entries = core.applyMemories({}, [{ topic: '宠物', content: '玩家养了一只猫' }], {
        source: { file: 'harry-以前的对�?jsonl', messageIndex: 0, at: '2026-09-11T01:00:00.000Z' }
      }).entries;
      await store.putWorld(book, { entries });
      return true;
    })()`);
    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const link = await waitFor("document.querySelector('.memory-source-link') !== null", 8000);
    assert(link, "没有「看原话」入�?);

    // 直接调跳转函数（比点按钮更好诊断：能看到它到底走到哪一步）�?    const jump = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
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
    assert(jump.panelHidden === true, "点了「看原话」但面板没关�? + JSON.stringify(jump));

    // 面板应关闭、并切到来源那段对话
    await waitFor("document.querySelector('#memoryPanel').hidden === true", 8000);
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('团子') >= 0", 15000);
    const marked = await evaluate("document.querySelectorAll('.memory-source-hit').length");
    assert(marked >= 1, "跳到对话后没有标出来源消�?);
  });

  /* ------------------------------------------------------------------ *
   * 伴侣 / 语音用例要用的角�?   *
   * 2026-09-14 用户拍板：「小说人物不设置伴侣……只有定制人物加上伴侣身份再打开语音。�?   * 也就是说**内置的那 6 张小说角色卡在运行时不再注入关系段落**。所以这一组用�?   * 必须�?*定制角色** —�?fixture 里那张「林默」卡�?avatar 不在内置名单里，
   * 而且它故意不写语言标记（中文那一条路要有现场）�?   * （后面「伴侣段落跟着卡片语言走」那条仍然用英文�?Hermione。）
   * ------------------------------------------------------------------ */

  const BUILTIN_AVATARS = [
    "Harry Potter (EN).png",
    "Tom Riddle (Adult).png",
    "Ron Weasley (Triwizard Year).png",
    "Hermione Granger (Triwizard Year).png",
    "Ginny Weasley (Triwizard Year).png",
    "Luna Lovegood (Triwizard Year).png",
  ];
  const CUSTOM_AVATAR = "林默.png";
  const CUSTOM_NAME = "林默";
  const CUSTOM_CHAT = "linmo-量身对话";
  const COMPANION_KEY = "companion:" + CUSTOM_AVATAR;

  /** 当前对话角色的名字（顶栏那颗按钮显示的就是它）—�?断言"面板写的是当前这个角�?用它�?   *  不写死某个名字：这一组用例现在跑在定制角色的对话里（内置小说人物不做伴侣）�?*/
  async function activeCharacterName() {
    const text = await evaluate("(document.querySelector('#topbarCharacterButton') || {}).textContent || ''");
    return String(text).replace(/[⌄\s]+$/, "").trim();
  }

  /** 给某个角色造一段对话并切过去（走会话表与真实的切换入口，不是内部赋值）�?*/
  async function openChatFor(avatar, name, fileName) {
    const ok = await evaluate(`(async () => {
      const avatar = ${JSON.stringify(avatar)};
      const fileName = ${JSON.stringify(fileName)};
      const existing = await window.STApi.listChats(avatar);
      const has = (existing || []).some((row) => String(row.fileName || row.file_name || row.id) === fileName);
      if (!has) {
        await window.STApi.saveChat(avatar, fileName, [
          { chat_metadata: { ui_title: fileName }, user_name: "�?, character_name: ${JSON.stringify(name)} },
          { name: "�?, is_user: true, mes: "今天好热", send_date: new Date(Date.now() - 70 * 60000).toISOString() },
          { name: ${JSON.stringify(name)}, is_user: false, mes: "那就别出门了�?, send_date: new Date(Date.now() - 69 * 60000).toISOString() },
        ]);
      }
      await window.TASK21.refreshSessions();
      const row = window.TASK21.sessionList().find((one) => String(one.fileName).indexOf(fileName) >= 0);
      if (!row) return false;
      await window.TASK21.selectChat(row.id);
      return true;
    })()`);
    assert(ok, "没能切到 " + fileName + " 那段对话");
    await waitFor(`window.TASK21.activeChatFileName().indexOf(${JSON.stringify(fileName)}) >= 0`, 10000);
  }

  await check("伴侣模式默认关闭：请求里一个字符都不多带，面板也说得明�?, async () => {
    // 后面这一组都在这�?*定制角色**的对话里发消息（内置小说人物在这一版里不做伴侣�?    // 拿它测等于什么都没测）。切过去之前先确认会话表里找得到它�?    await openChatFor(CUSTOM_AVATAR, CUSTOM_NAME, CUSTOM_CHAT);

    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    assert(last.systemText.indexOf("[陪伴模式]") < 0, "没打开伴侣模式却带上了陪伴段落");
    // 这一段就�?今天"聊的，所以「上次说到」不该出现�?    assert(await evaluate("document.querySelector('#chatRecapBar').hidden === true"),
      "今天刚聊过还提示「上次说到�?);
    const stored = await evaluate(`(async () => JSON.stringify(await RoleWorld.store.getKV(${JSON.stringify("companion:" + CUSTOM_AVATAR)}, null)))()`);
    assert(stored === "null", "还没写过关系档案，kv 里不该有东西�? + stored);
  });

  await check("伴侣模式：关系、称呼、起点、时间感与硬规矩都进了请�?, async () => {
    // 走用户真正会走的那条路：角色记忆面板 �?关系档案�?    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    assert(await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\") !== null"),
      "记忆面板里没有「关系档案」入�?);
    await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\").click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    // 关系页的内容是异步读出来的（角色档案 + 当前表单状态）：等面板�?这一页填好了"再断言�?    // 否则读到的是空壳 —�?这条以前就踩过（合并分页当天）�?    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'relationship'", 8000);
    assert(await evaluate("document.querySelector('#memoryPanel').hidden === true"), "打开关系档案后记忆面板应当让开");
    assert(await evaluate("document.querySelector('#companionPreview').textContent.indexOf('一个字符都不会多带') >= 0"),
      "没打开时应当说清楚不会多带内容");

    // 界面上列出的硬规矩，必须是模型真正被告知的那一份（同一个来源）�?    const rulesShown = await evaluate("document.querySelectorAll('#companionRuleList li').length");
    assert(rulesShown >= 5, "界面没有列出伴侣模式的硬规矩�? + rulesShown);

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
    assert(/每轮会多带约 \d+ �?.test(preview), "预览没说清每轮多带多少：" + preview);
    assert(preview.indexOf("token") >= 0, "预览里应当给�?token 估算�? + preview);
    assert(preview.indexOf("2 件共同经�?) >= 0, "预览没有算上用户写的共同经历�? + preview);

    await evaluate("document.querySelector('#companionSaveButton').click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);

    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '今天下班晚了，随便聊�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();

    const sent = requests.filter((row) => row.stream === true);
    const last = sent[sent.length - 1];
    const text = last.systemText;
    assert(text.indexOf("[陪伴模式]") >= 0, "伴侣段落没进请求");
    assert(text.indexOf("关系：恋�?) >= 0, "关系没进请求");
    assert(text.indexOf("叫对方「阿林�?) >= 0, "称呼没进请求");
    assert(text.indexOf("答应过要一起看一次海") >= 0, "共同经历没进请求");
    assert(text.indexOf("今天�?") >= 0, "没告诉模型今天几�?);
    assert(text.indexOf("认识�?026-01-01 �?) >= 0, "关系起点没进请求");
    // 2026-09-12 �?允许有情�?是明写的（旧措辞"不用内疚或冷淡留�?已经改成下面这两条）�?    for (const rule of ["不编造共同经�?, "可以有情�?, "不用内疚", "不威�?, "不索取陪�?, "承认自己是程�?]) {
      assert(text.indexOf(rule) >= 0, "硬规矩没进请求：" + rule);
    }
    // 中文角色的段落不带英文模板，英文卡的段落也不该混中文（下面单独验证语言选择）�?    assert(await evaluate("document.querySelector('#companionEnabled').checked === true"), "保存后复选框状态不�?);
  });

  await check("统一角色面板：点角色名一步进去，设定 / 记忆 / 关系三页各就各位", async () => {
    // 本轮�?026-09-13）用户要求：把「角色记忆」弹窗、右侧「记忆书」栏、「关系档案」弹�?    // 合成一个入�?—�?点对话顶栏的角色名打开，分「设�?/ 记忆 / 关系」三页；
    // 顶栏「记忆」一步到记忆页；伴侣模式开关就在关系页，并写清对哪个角色生效�?    if (!/index\.html/.test(await evaluate("location.pathname"))) {
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
    }
    await evaluate("window.TASK21.closeCharacterPanel(); true");

    // �?顶栏那颗按钮就是入口：真点击它（不是调内部函数）�?    const entry = await evaluate(`(() => {
      const node = document.querySelector('#topbarCharacterButton');
      if (!node) return { exists: false };
      const r = node.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { exists: true, w: Math.round(r.width), h: Math.round(r.height), reachable: !!(top && (top === node || node.contains(top))), label: node.getAttribute('aria-label') || '' };
    })()`);
    assert(entry.exists, "顶栏没有角色入口按钮");
    assert(entry.w > 0 && entry.h > 0 && entry.reachable, "顶栏角色入口点不到：" + JSON.stringify(entry));
    const diagnostics = await evaluate(`(async () => {
      const before = {
        url: location.pathname,
        hasApi: !!(window.TASK21 && typeof window.TASK21.openCharacterPanel === 'function'),
        panel: !!document.querySelector('#characterPanel'),
        hidden: document.querySelector('#characterPanel') ? document.querySelector('#characterPanel').hidden : null,
      };
      let error = '';
      try { await window.TASK21.openCharacterPanel('setup'); } catch (e) { error = String(e && e.message || e); }
      await new Promise((r) => setTimeout(r, 400));
      const p = document.querySelector('#characterPanel');
      return Object.assign(before, {
        error,
        after: p ? { hidden: p.hidden, display: getComputedStyle(p).display, ready: p.dataset.ready } : null,
      });
    })()`);
    assert(diagnostics.after && diagnostics.after.hidden === false,
      "打开角色面板失败，现场：" + JSON.stringify(diagnostics));
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'setup'", 8000);
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'setup'", 8000);

    // �?默认落在「设定」页，而且真的读到了角色卡的正文（不是空壳）�?    const setup = await evaluate(`(() => {
      const pane = document.querySelector('#characterPaneSetup');
      const rows = Array.from(pane.querySelectorAll('.character-setup-row')).map((row) => ({
        label: row.querySelector('strong').textContent,
        text: row.querySelector('div').textContent,
        empty: row.querySelector('div').classList.contains('is-empty'),
      }));
      const title = document.querySelector('#characterPanelTitle').textContent;
      const tabs = Array.from(document.querySelectorAll('[data-character-tab]')).map((b) => b.dataset.characterTab + (b.classList.contains('is-active') ? '*' : ''));
      const active = Array.from(document.querySelectorAll('[data-character-pane]')).filter((p) => !p.hidden).map((p) => p.dataset.characterPane);
      return { title, tabs, active, rows };
    })()`);
    assert(setup.tabs.join(",") === "setup*,memories,relationship", "分页不对�? + setup.tabs.join(","));
    assert(setup.active.join(",") === "setup", "默认页应当是设定�? + setup.active.join(","));
    // 面板必须写明"这是哪个角色"。用顶栏那颗按钮上的名字来对，而不是写死某个角色名 —�?    // 这一组用例现在跑�?*定制角色**的对话里�?026-09-14 拍板后内置小说人物不做伴侣，用例随之迁移）�?    const activeWho = await activeCharacterName();
    assert(activeWho, "读不到当前角色名（顶栏那颗按钮上没有名字�?);
    assert(setup.title.indexOf(activeWho) >= 0, "面板标题没写是哪个角色：" + setup.title + "（当前角�?" + activeWho + "�?);
    const nameRow = setup.rows.find((row) => row.label === "名字");
    const whoRow = setup.rows.find((row) => row.label === "它是�?);
    assert(nameRow && !nameRow.empty && nameRow.text.indexOf(activeWho) >= 0, "设定页没读到角色名字�? + JSON.stringify(nameRow));
    assert(whoRow && !whoRow.empty, "设定页没读到角色卡正文（它是谁）�? + JSON.stringify(whoRow));
    assert(setup.rows.some((row) => row.label === "角色卡文�?) && setup.rows.some((row) => row.label === "来源"),
      "设定页应当写明角色卡文件与来源：" + JSON.stringify(setup.rows.map((r) => r.label)));

    // �?设定页里的「看它的记忆�? 切到记忆页，并且内容已经读好（data-ready）�?    await evaluate("document.querySelector(\"[data-action='character-tab-memories']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'memories'", 8000);
    const memoryTab = await evaluate(`(() => ({
      memoryVisible: document.querySelector('#memoryPanel').hidden === false,
      setupHidden: document.querySelector('#characterPaneSetup').hidden === true,
      hasList: !!document.querySelector('#memoryPanel #memoryList'),
      hasOrientation: !!document.querySelector('#memoryPanel #memoryList #memoryOrientation'),
    }))()`);
    assert(memoryTab.memoryVisible && memoryTab.setupHidden, "切到记忆页没生效�? + JSON.stringify(memoryTab));
    assert(memoryTab.hasList && memoryTab.hasOrientation, "记忆页没有内容：" + JSON.stringify(memoryTab));

    // �?关系页：伴侣模式开关在这里，并且说清对哪个角色生效�?    await evaluate("document.querySelector(\"[data-character-tab='relationship']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'relationship'", 8000);
    const relation = await evaluate(`(() => {
      const subtitle = document.querySelector('#companionSubtitle').textContent;
      const hint = document.querySelector('#characterPanelHint').textContent;
      const check = document.querySelector('#companionEnabled');
      const r = check.closest('label').getBoundingClientRect();
      return { subtitle, hint, switchVisible: check.getBoundingClientRect().width > 0, rowH: Math.round(r.height), switchText: check.closest('label').textContent.trim() };
    })()`);
    assert(relation.switchVisible, "关系页里看不到伴侣模式开�?);
    assert(relation.subtitle.indexOf(activeWho) >= 0, "关系页没写这份档案属于哪个角色：" + relation.subtitle);
    assert(relation.hint.indexOf("只对这个角色生效") >= 0 || relation.subtitle.indexOf("只对这个角色生效") >= 0,
      "关系页没说明伴侣模式的作用范围：" + relation.hint);
    assert(relation.switchText.indexOf("给这个角�?) >= 0, "开关文案没说清是对哪个角色�? + relation.switchText);

    // �?顶栏「记忆�? 一步到当前角色的记忆页（真点击顶栏那颗按钮）�?    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').hidden === true", 8000);
    await evaluate("document.querySelector(\"[data-action='open-memories']\").click(); true");
    // 分工（用�?2026-09-13）：「手机版就直接弹出弹窗，电脑版就直接打开侧边栏」�?    if (await evaluate("window.innerWidth >= 900")) {
      await waitFor("document.querySelector('.inspector-column').getAttribute('aria-hidden') === 'false'", 8000);
    } else {
      await waitFor("document.querySelector('#characterPanel').hidden === false", 8000);
      await waitFor("document.querySelector('#characterPanel').dataset.ready === 'memories'", 8000);
      assert(await evaluate("document.querySelector('#memoryPanel').hidden === false"),
        "手机版点「记忆」没有落到记忆页");
    }
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').hidden === true", 8000);
  });

  await check("伴侣模式只属于这个角色：换个角色既没有档案，也没有它的段�?, async () => {
    const other = await evaluate(`(async () => {
      const profile = await window.TASK21.loadCompanion({ avatar: ${JSON.stringify("Harry Potter (EN).png")}, charName: 'Harry Potter' });
      return profile.enabled === true;
    })()`);
    assert(other === false, "另一个角色继承了别人的关系档�?);
    const keys = await evaluate(`(async () => {
      const rows = await RoleWorld.store.getKV(${JSON.stringify("companion:Harry Potter (EN).png")}, null);
      return JSON.stringify(rows);
    })()`);
    assert(keys === "null", "另一个角色的档案不该存在�? + keys);
    // 而且这份档案不能�?清空记忆"顺手删掉：它是用户自己写的，不是模型记的�?    const still = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify("companion:" + CUSTOM_AVATAR)}, null) || {}).enabled === true)()`);
    assert(still === true, "关系档案不见�?);
  });

  await check("内置小说人物不做伴侣：老存档里开过也不生效，�?*档案一个字都不�?*", async () => {
    // 2026-09-14 用户拍板：「小说人物不设置伴侣……其他都是聊天」�?    // 这条盯两件事，缺一不可�?    //   �?老存档里已经给内置角色开过伴侣的（用户的数据），**不能�?*、也不能改写�?    //   �?但它**不生�?* —�?请求里既没有关系段落，也没有主动开口�?    // 为什么两件都要：只做 �?会出�?内置角色仍然是伴�?（跟拍板的规则相反）�?    // 只做 �?会悄悄扔掉用户自己写过的档案（那是数据丢失）�?    const harryKey = "companion:Harry Potter (EN).png";
    const written = await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const profile = core.normalizeProfile({
        enabled: true, relation: 'partner', charCallsUser: '阿林',
        shared: [{ text: '第一次聊天是在雨天的图书�? }],
        chatStyle: 'plain',
        proactive: { enabled: true, minGapHours: 12, maxPerDay: 1 },
        lastChatAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      });
      // �?必须走应用自己的保存入口�? 界面上那个保存按钮调的函数）�?*不能**只往 kv 里写�?      //   这个角色的档案可能已经被前面某条用例读进过同步缓存，�?有没有关系段�?读的正是那份缓存 —�?      //   只写 kv 的话，缓存里还是旧的空档案，于是**拆掉规则闸用例也照样�?*（变异测试当场抓到过�?      //   这就是一�?看着在守、其实什么都没守"的假用例）�?      await window.TASK21.saveCompanion({ avatar: 'Harry Potter (EN).png', charName: 'Harry Potter' }, profile);
      return profile.enabled === true;
    })()`);
    assert(written, "前置条件不成立：没能把老存档那样的档案写进�?);

    // 切到哈利那段对话（内置角色），发一�?—�?关系段落�?软件聊天"那两段都不该出现�?    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊�?);
    // 主动开口那一轮走的是**非流�?* complete()：这里数一下，确认它没有偷偷发�?    const proactiveBefore = requests.filter((row) => row.path === "/v1/chat/completions" && row.stream !== true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '内置角色不该是伴�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    try {
      const turn = requests.filter((row) => row.stream === true).slice(-1)[0];
      assert(turn, "这一轮没发出�?);
      assert(turn.systemText.indexOf("[陪伴模式]") < 0, "内置角色的关系段落还是进了请�?);
      assert(turn.systemText.indexOf("叫对方「阿林�?) < 0, "内置角色的称呼还是进了请�?);
      assert(turn.systemText.indexOf("微信式聊�?) < 0 && turn.systemText.indexOf("WeChat-like") < 0,
        "内置角色还是拿到了「微信式聊天」那一段（那是伴侣 + 语音档才有的�?);
      assert(requests.filter((row) => row.path === "/v1/chat/completions" && row.stream !== true).length === proactiveBefore,
        "内置角色还会主动开口（主动消息属于伴侣模式�?);
      // �?档案还在，而且一个字段都没被改写�?      const kept = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify(harryKey)}, null)) || null)()`);
      assert(kept && kept.enabled === true, "用户写的档案被删了或改坏了：" + JSON.stringify(kept));
      assert(kept.charCallsUser === "阿林" && Array.isArray(kept.shared) && kept.shared.length === 1,
        "档案内容被改写了�? + JSON.stringify(kept));
    } finally {
      // 收尾**放在 finally �?*：这条用例往内置角色头上写了一份伴侣档案、还把活动对话切到哈利那段，
      // 中途断言失败如果不还原，后面 4 条用例会跟着一起红（第一版就是这样：一条真问题变成一片红�?      // 排查的人根本看不出真正坏的是哪一条）�?      await evaluate(`(async () => { await RoleWorld.store.setKV(${JSON.stringify(harryKey)}, null); return true; })()`).catch(() => {});
      await openChatFor(CUSTOM_AVATAR, CUSTOM_NAME, CUSTOM_CHAT).catch(() => {});
    }
  });

  await check("关系档案：改口后以新的为准，而且是每轮都重新读一�?, async () => {
    await evaluate("window.TASK21.openCompanionDialog()");
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
      input.value = '那你叫我一声试�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const text = sent[sent.length - 1].systemText;
    assert(text.indexOf("叫对方「小林�?) >= 0, "改过之后的称呼没生效�? + text.slice(text.indexOf("[陪伴模式]"), text.indexOf("[陪伴模式]") + 120));
    assert(text.indexOf("叫对方「阿林�?) < 0, "旧的称呼还在请求�?);
  });

  await check("关掉伴侣模式：下一轮就不再带上关系档案", async () => {
    await evaluate("window.TASK21.openCompanionDialog()");
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
      input.value = '关掉之后再说一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const text = sent[sent.length - 1].systemText;
    assert(text.indexOf("[陪伴模式]") < 0, "关掉后仍然带上了陪伴段落");
    assert(text.indexOf("叫对方「小林�?) < 0, "关掉后仍然带上了关系档案");

    // 重新打开，后面的用例（英文卡语言）还要用�?    await evaluate("window.TASK21.openCompanionDialog()");
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

  await check("伴侣模式从界面上点得到（记忆 �?关系档案；设�?�?角色管理也有一个入口）", async () => {
    // 用户 2026-09-12：「什么伴侣模式根本看不到啊」。入口以前只�?记忆面板里那�?�?    // 而且三组 v2 控件�?*先勾开�?*才出�?—�?这次把入口也放进「设�?�?角色管理」，
    // 并且�?*真界面点�?*（不是内部函数）走一遍�?    // 用户 2026-09-12：「面板里点关系档案根本没有」—�?因为那时它只�?*弹层**
    // （顶栏「记忆」打开的那个）里，而右侧常驻的记忆栏是另一个界面�?    // 这条同时盯两处入口：右侧常驻记忆栏、记忆弹层�?    // （设�?�?角色管理 里那个入口另有用例在点它；这里不重复量，免得把设置面板停在别的段�?    //   污染后面的用�?—�?真踩过：留在"角色管理"段会让生成参数那条用例找不到面板。）
    const probeEntry = (selector) => `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { exists: false };
      const r = node.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const top = visible ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null;
      return { exists: true, visible: visible, reachable: !!(top && (top === node || node.contains(top))) };
    })()`;
    await evaluate("window.TASK25C_UI.setMemoryPanelOpen ? window.TASK25C_UI.setMemoryPanelOpen(true) : null; true");
    await new Promise((r) => setTimeout(r, 400));
    const columnEntry = await evaluate(probeEntry(".inspector-column [data-action='open-companion']"));
    assert(columnEntry.exists, "右侧记忆栏里没有「关系档案」入�?);
    assert(columnEntry.visible, "右侧记忆栏里的入口看不见�? 尺寸�?);
    assert(columnEntry.reachable, "右侧记忆栏里的入口点不到（被别的元素盖住�?);

    // �?弹层里的入口（要先打开弹层才量得到�?    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const modalEntry = await evaluate(probeEntry("#memoryPanel [data-action='open-companion']"));
    assert(modalEntry.exists && modalEntry.visible && modalEntry.reachable,
      "记忆弹层里的「关系档案」点不到�? + JSON.stringify(modalEntry));

    await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\").click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);

    // 勾上开关之后，三组 v2 控件必须真的出现在界面上（不是只存在�?HTML 里）�?    //
    // 注意�?026-09-13）：原来这条�?`#companionNeglect` 量成 0×0 当成"已知 bug"记了一阵子�?    // **其实界面没坏** —�?`choice-menu.js` 会把 `.memory-modal select` 换成一�?    // `.choice-trigger` 按钮（原�?select �?`hidden`），量原�?select 当然永远�?0×0�?    // 所以这里改成量"用户真正看得到的那个控件"：有 trigger 就量 trigger�?    // 并且真的点开一次，确认菜单弹得出来、选项点得中�?    const controls = await evaluate(`(() => {
      const enabled = document.querySelector('#companionEnabled');
      enabled.checked = true;
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
      const visibleNode = (selector) => {
        const n = document.querySelector(selector);
        if (!n) return null;
        // 增强过的 select 后面跟着 .choice-trigger，那才是用户点的东西�?        return (n.tagName === 'SELECT' && n.nextElementSibling && n.nextElementSibling.classList.contains('choice-trigger'))
          ? n.nextElementSibling : n;
      };
      const box = (selector) => { const n = visibleNode(selector); if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return { affinity: box('#companionAffinity'), neglect: box('#companionNeglect'), proactive: box('#companionProactive'), affinityAuto: box('#companionAffinityAuto') };
    })()`);
    for (const [key, box] of Object.entries(controls)) {
      assert(box && box.w > 0 && box.h > 0, "勾上伴侣模式后看不到这个控件�? + key + " �?" + JSON.stringify(box));
    }
    // 「久没聊时的态度」：点开下拉，菜单要在视口里，选一项要真的写回去�?    // 先把它滚进视�?—�?真人也是滚动之后才点得到的；点一个屏幕外的控件再怪菜单位置不对，
    // 那不是界面的问题�?026-09-13 合并角色面板时就误判过一次）�?    const neglect = await evaluate(`(() => {
      const select = document.querySelector('#companionNeglect');
      select.scrollIntoView({ block: 'center' });
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
    assert(neglect.count >= 3, "「久没聊时的态度」下拉里没有选项�? + JSON.stringify(neglect));
    assert(neglect.inView, "「久没聊时的态度」的下拉菜单跑到视口外了�? + JSON.stringify(neglect));
    assert(neglect.after !== neglect.before, "点了下拉里的选项，值没写回去：" + JSON.stringify(neglect));
    assert(neglect.menuClosed, "选完之后菜单没有关掉�? + JSON.stringify(neglect));
    await evaluate(`(() => { document.querySelector('#companionNeglect').value = 'soft'; return true; })()`);
    // 设置里也有一个入口（同一�?data-action，接线是共用的）�?    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
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
    assert(settingsEntry.reachable, "设置 �?角色管理里的入口点不到：" + JSON.stringify(settingsEntry));
    assert(settingsEntry.text.indexOf("伴侣") >= 0, "设置里那个入口的文案不对�? + settingsEntry.text);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
  });

  await check("陪伴自检：模型说了内疚话术，面板会照实点出来（但不改写它�?, async () => {
    // 让模型这一轮说一句内疚话术（合成回复由测试端点给）�?    await evaluate(`fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '……你都不理我了。我这几天一直在等你好久�? }) }).then(() => true)`);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '在吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const shown = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(shown.indexOf("你都不理我了") >= 0, "合成回复没进对话，自检就没意义�?);

    await evaluate("window.TASK21.openCompanionDialog()");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    const check = await evaluate("document.querySelector('#companionCheck').textContent");
    assert(check.indexOf("内疚话术") >= 0, "自检没有指出内疚话术�? + check);
    assert(check.indexOf("你都不理�?) >= 0, "自检没有给出命中的原话：" + check);
    // 只报告，不改写：原话应该还在对话里�?    assert((await evaluate("document.querySelector('#dynamicMessages').textContent")).indexOf("你都不理我了") >= 0,
      "自检把模型的话改掉了");
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
  });

  await check("伴侣 v2：亲近度 / 冷落�?/ 主动消息三个控件能存能读（默认关、有上限�?, async () => {
    // 2026-09-12 用户拍板：伴侣类可以有主动消�?/ 亲近�?/ 冷落反应，条件是提示词符合类型�?    await evaluate("window.TASK21.openCompanionDialog()");
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
      assert(form[key], "关系档案里缺控件�? + key);
    }
    assert(form.proactiveChecked === false, "主动消息必须默认�?);
    assert(form.affinityDisabledWhenAuto === true, "勾着「跟随系统建议」时滑杆该是禁用�?);

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
    const saved = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify(COMPANION_KEY)}, null)))()`);
    assert(saved.affinityMode === "manual" && saved.affinity === 77, "亲近度没存上�? + JSON.stringify({ mode: saved.affinityMode, value: saved.affinity }));
    assert(saved.neglect === "off", "冷落档没存上�? + saved.neglect);
    assert(saved.proactive && saved.proactive.enabled === true
      && saved.proactive.minGapHours === 24 && saved.proactive.maxPerDay === 2,
      "主动消息的设置没存上�? + JSON.stringify(saved.proactive));
    // 关掉主动消息，别影响后面的用例（亲近度也交回系统算）�?    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const current = await RoleWorld.store.getKV(${JSON.stringify(COMPANION_KEY)}, null);
      await RoleWorld.store.setKV(${JSON.stringify(COMPANION_KEY)}, core.normalizeProfile(Object.assign({}, current, {
        affinityMode: 'auto', proactive: { enabled: false, minGapHours: 12, maxPerDay: 1 }, neglect: 'soft',
      })));
      return true;
    })()`);
  });

  await check("伴侣 v2：打开对话时它先开口（主动消息，一天一条就够）", async () => {
    // 造一�?隔了 5 天没�?+ 开着主动消息"的档案，然后整页重载 —�?真人�?回来打开应用"�?    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const previous = (await RoleWorld.store.getKV(${JSON.stringify(COMPANION_KEY)}, null)) || {};
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
      await RoleWorld.store.setKV(${JSON.stringify(COMPANION_KEY)}, core.normalizeProfile(Object.assign({}, previous, {
        enabled: true, shared: [{ text: '第一次聊天是在雨天的图书�? }],
        lastChatAt: fiveDaysAgo, proactiveLog: '',
        proactive: { enabled: true, minGapHours: 12, maxPerDay: 1 },
      })));
      await RoleWorld.secrets.set('api_key_deepseek', 'sk-proactive-test');
      return true;
    })()`);
    // 合成回复：主动开口那一轮走的是**非流�?* complete()，这里给它一句专属台词�?    await evaluate("fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '图书馆那本《高级魔药制作》你还没还我�? }) }).then(() => true)");
    // 主动开口那一轮走的是**非流�?* complete()：直接看请求最�?—�?    // 假端点对非流式固定回 REPLY，所�?有没有真的发出去"�?看到某句台词"可靠�?    const plainCalls = () => requests.filter((row) => row.path === "/v1/chat/completions" && row.stream !== true);
    const beforeCalls = plainCalls().length;
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    let fired = null;
    for (let i = 0; i < 150; i += 1) {
      fired = plainCalls().slice(beforeCalls).find((row) => String(row.systemText).indexOf("你先开�?) >= 0) || null;
      if (fired) break;
      await sleep(200);
    }
    if (!fired) {
      const why = await evaluate("window.TASK21.proactiveState ? JSON.stringify(window.TASK21.proactiveState()) : 'no-hook'");
      const diag = await evaluate(`(async () => {
        const core = window.ROLEWORLD_COMPANION_CORE;
        const profile = await RoleWorld.store.getKV(${JSON.stringify(COMPANION_KEY)}, null);
        const settings = await RoleWorld.getLocalSettings();
        const key = await RoleWorld.secrets.get('api_key_deepseek');
        return { profile: profile ? { enabled: profile.enabled, proactive: profile.proactive, lastChatAt: profile.lastChatAt } : null,
                 decision: profile ? core.proactiveDecision(profile, new Date()) : null,
                 provider: settings.provider, keySet: !!((key || {}).value) };
      })()`);
      assert(fired, "打开对话时没有主动开口：" + why + " / " + JSON.stringify(diag));
    }
    assert(String(fired.systemText).indexOf("像真�?) >= 0, "主动开口那条指令里没写「像真人�?);
    assert(String(fired.systemText).indexOf("不要问他为什么这么久没来") >= 0, "主动开口那条指令缺「不许追问」的约束");
    const log = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify(COMPANION_KEY)}, null)).proactiveLog)()`);
    const today = await evaluate("window.ROLEWORLD_COMPANION_CORE.isoDay(new Date())");
    assert(String(log).indexOf(today + "|1") === 0, "今天主动发了几条没记上：" + log);
    // 再重载一次：同一天不该再开口（每日上限 1）�?    const beforeSecond = plainCalls().length;
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await sleep(2000);
    const again = plainCalls().slice(beforeSecond).filter((row) => String(row.systemText).indexOf("你先开�?) >= 0);
    assert(again.length === 0, "同一天又主动开口了一次（每日上限没生效）");
    // 收尾：关掉伴侣模式，恢复现场�?    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const current = (await RoleWorld.store.getKV(${JSON.stringify(COMPANION_KEY)}, null)) || {};
      await RoleWorld.store.setKV(${JSON.stringify(COMPANION_KEY)}, core.normalizeProfile(Object.assign({}, current, { enabled: false, proactive: { enabled: false } })));
      await RoleWorld.secrets.remove('api_key_deepseek');
      return true;
    })()`);
  });

  await check("安全兜底：每轮都带安全规则；命中危机词时再加一条详细的", async () => {
    // 用户拍板放开主动消息/亲近度之后，"永远温柔"的角色一定会遇到"我不想活�?�?    // 系统提示里本来就有一条安全规则（每个角色每轮都有），命中危机词时再补一条详细的�?    const before = requests.filter((row) => row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '我最近真的不想活�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    for (let i = 0; i < 80 && requests.filter((row) => row.stream === true).length <= before; i += 1) await sleep(200);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const turn = sent[sent.length - 1];
    assert(turn, "这一轮没发出�?);
    assert(turn.systemText.indexOf("不承诺保�?) >= 0, "日常的系统提示里缺安全兜底那条：" + turn.systemText.slice(-200));
    assert(turn.systemText.indexOf("危机信号") >= 0, "命中危机词之后没有再补详细的安全规则");
    assert(turn.systemText.indexOf("110") >= 0, "详细规则里要给出具体动作（报�?急救�?);
    // 普通一句话不该把那条详细规则也带上（不然每轮都多花 token）�?    const before2 = requests.filter((row) => row.stream === true).length;
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
    assert(plain.systemText.indexOf("不承诺保�?) >= 0, "安全兜底那条应当每轮都在");
  });

  await check("隔了很久回来：旧对话能打开，并且会提示「上次说到�?, async () => {
    // 这段 fixture 对话�?2026-08-01 的（一个多月前），而且存储键带 .jsonl —�?    // 老数�?导入进来的对话就是这个形状。以前会话表把后缀去掉，一打开就报"不可�?�?    const target = await evaluate(`(() => {
      const row = window.TASK21.sessionList().find((session) => String(session.fileName).indexOf('以前的对�?) >= 0);
      return row ? row.id : '';
    })()`);
    assert(target, "会话表里找不到那段旧对话�? + JSON.stringify(await evaluate("window.TASK21.sessionList()")));
    await evaluate(`window.TASK21.selectChat(${JSON.stringify(target)}); true`);
    // 打得开：以前那句话要真的显示出来（打不开时这里会超时）�?    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('团子') >= 0", 15000);
    assert((await evaluate("window.TASK21.activeChatFileName()")).indexOf("以前的对�?) >= 0,
      "没有切到那段旧对�?);

    // 隔了日子回来才提示「上次说到」�?    await waitFor("document.querySelector('#chatRecapBar').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#chatRecapText').textContent");
    assert(text.indexOf("上次说到") === 0, "文案不对�? + text);
    // 取的�?*用户说过的最后一�?*（原话，不是摘要），并带上间隔�?    assert(text.indexOf("我一般买三文鱼味的猫�?) >= 0, "没有取到上次那句原话�? + text);
    assert(/（上次聊天是 \d+ 天前�?.test(text), "没有写清隔了多久�? + text);

    await evaluate("document.querySelector('#chatRecapUse').click(); true");
    const filled = await evaluate("document.querySelector('#messageInput').value");
    assert(filled.indexOf("三文鱼味的猫�?) >= 0, "「以此开头」没把上次那句填进去�? + filled);

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
    // 存储键带 .jsonl 的对话（老数�?/ 导入进来的）如果保存时用另一个键�?    // 结果就是"看得见旧记录、新消息却写到了别处" —�?那才是真的丢数据�?    const chatsBefore = await evaluate(`(async () => (await window.STApi.listChats('Harry Potter (EN).png'))
      .map((chat) => ({ name: chat.file_name, items: chat.chat_items })))()`);
    assert(await evaluate("window.TASK21.activeChatFileName()") === "harry-以前的对�?,
      "上一条用例应当已经打开那段旧对�?);
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
      "聊完多出了一份对话（说明另存了）�? + JSON.stringify({ before: chatsBefore, after: chatsAfter }));
    const oldBefore = chatsBefore.find((chat) => chat.name.indexOf("以前的对�?) >= 0);
    const oldAfter = chatsAfter.find((chat) => chat.name.indexOf("以前的对�?) >= 0);
    assert(oldAfter && oldAfter.items === oldBefore.items + 2,
      "新的一轮没有写回原来那份记录：" + JSON.stringify({ before: oldBefore, after: oldAfter }));
    const stored = await evaluate(`(async () => {
      const lines = await window.STApi.getChat('Harry Potter (EN).png', 'harry-以前的对�?jsonl');
      const user = lines.filter((line) => line && line.is_user).slice(-1)[0] || {};
      return { count: lines.length, last: String(user.mes || '') };
    })()`);
    assert(stored.last.indexOf("那就接着上次的说") >= 0,
      "存进去的内容不对�? + JSON.stringify(stored));
    // 存回同一份之后，「上次说到」也不该再出现（今天刚聊过）�?    assert(await evaluate("document.querySelector('#chatRecapBar').hidden === true"),
      "刚聊完还提示「上次说到�?);
  });

  await check("伴侣段落跟着卡片语言走：英文卡拿英文段落，中文卡拿中文段�?, async () => {
    const previousChat = await evaluate("window.TASK21.activeChatFileName()");
    // 新开一段对�?�?用真实的选择器换到英文卡（这也是"每个角色各一份档�?的真实路径）�?    await evaluate("window.TASK21.createNewConversation(); true");
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
    assert(picked, "选择器里没有英文�?);
    await waitFor("document.querySelector('#characterPickerName').textContent.indexOf('Hermione') >= 0", 8000);

    await evaluate("window.TASK21.openCompanionDialog()");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    // 先确认换人之后表单是空的：别人的档案不该跟过来�?    assert(await evaluate("document.querySelector('#companionCharCallsUser').value === ''"),
      "换了角色，上一个人的档案跟过来�?);
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
    // 英文卡的关系档案要单独存一份，不能落在中文角色的键上�?    assert(await evaluate("(async () => (await RoleWorld.store.getKV('companion:Hermione Granger (EN).png', null) || {}).enabled === true)()"),
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
    assert(text.indexOf("Relationship: partner") >= 0, "英文段落缺关�?);
    assert(text.indexOf("Today is ") >= 0, "英文段落缺今天的日期");
    const start = text.indexOf("[Companion mode]");
    const end = text.indexOf("Hard rules:", start);
    assert(end > start, "英文段落缺硬规矩");
    const block = text.slice(start, end);
    assert(!/[\u4e00-\u9fff]/.test(block), "英文段落里混进了中文�? + JSON.stringify(block.slice(0, 120)));
    console.log("        英文段落 " + block.length + " 字（" + (text.length - start) + " 字含硬规矩）");

    // 把当前对话切回去，别影响后面的用例�?    if (previousChat) {
      await evaluate(`window.TASK21.selectChat(${JSON.stringify(previousChat)}); true`);
      await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    }
  });

  await check("AI 写角色：先扩写成提示词，再照提示词写�?, async () => {
    const before = requests.length;
    await evaluate("document.querySelector('[data-action=\"character-ai-create\"]').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === false", 8000);
    assert(await evaluate("document.querySelector('#aiCreateBriefPhase').hidden === true"), "一开始不该显示提示词那一�?);
    assert(await evaluate("document.querySelector('#aiGenerateButton') === null"), "旧的一步生成按钮应当已经移�?);

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
    // 用模型自己写的内容来判定，避免撞上系统提示词里的示例（扩写要求里也有「身份与处境」这几个字）�?    assert(briefText.indexOf("市立图书�?) >= 0, "扩写稿不是模型给的内容：" + JSON.stringify(briefText.slice(0, 80)));
    assert(briefText.indexOf("说话方式") >= 0, "扩写稿缺少说话方式那一�?);
    const briefCount = await evaluate("document.querySelector('#aiBriefCount').textContent");
    assert(/长度合适|偏短|偏长/.test(briefCount), "没有给出长度提示�? + briefCount);

    // 用户改一句，验证"改过的稿�?才是写卡的输�?    await evaluate(`(() => {
      const area = document.querySelector('#aiBriefInput');
      area.value = area.value + "\\n补充：他讨厌有人把书折角�?;
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
    assert(cardCall.cardInput.indexOf("他讨厌有人把书折�?) >= 0,
      "写卡用的不是用户改过的那份提示词�? + JSON.stringify(cardCall.cardInput.slice(-60)));
    assert(cardCall.cardInput.indexOf("市立图书�?) >= 0, "写卡用的应当是扩写稿而不是原始一句话");
    console.log("        扩写 " + briefText.length + " �?�?写卡输入 " + cardCall.cardInput.length + " �?);

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
      input.value = '一个爱睡懒觉的邮差，住在海边小镇，记性很�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiSkipBriefButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#aiCreateEditPhase').hidden === false", 20000);

    const added = requests.slice(before);
    assert(!added.some((row) => row.isBriefCall), "跳过了扩写却仍然发了扩写请求");
    const cardCall = added.find((row) => row.isCardCall);
    assert(cardCall, "没有发出写卡请求");
    assert(cardCall.cardInput.indexOf("爱睡懒觉的邮�?) >= 0,
      "跳过扩写时应当直接用原始描述�? + JSON.stringify(cardCall.cardInput.slice(0, 60)));

    await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === true", 8000);
  });

  await check("AI 写角色：扩写后能返回改描述，也能重新扩写", async () => {
    await evaluate("document.querySelector('[data-action=\"character-ai-create\"]').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === false", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#aiDescriptionInput');
      input.value = '一个话很少的灯塔看守人，独自住在礁石岛上，习惯夜里写日�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiBriefButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#aiCreateBriefPhase').hidden === false", 20000);

    // 返回改描�?    await evaluate("document.querySelector('#aiBriefBackButton').click(); true");
    await waitFor("document.querySelector('#aiCreateDescriptionPhase').hidden === false", 8000);
    assert(await evaluate("document.querySelector('#aiDescriptionInput').value.length > 0"), "返回后描述被清空�?);
    assert(await evaluate("document.querySelector('#aiCreateBriefPhase').hidden === true"), "返回后提示词那一步应当收起来");
    assert(await evaluate("document.querySelector('#aiDescriptionInput').value.indexOf('灯塔看守�?) >= 0"),
      "返回后应当还是原来那句描�?);

    // 再进一次并重新扩写
    await evaluate("document.querySelector('#aiBriefButton').click(); true");
    await waitFor("document.querySelector('#aiCreateBriefPhase').hidden === false", 20000);
    const beforeRetry = await evaluate("document.querySelector('#aiBriefInput').value");
    await evaluate("document.querySelector('#aiBriefRetryButton').click(); true");
    await waitFor("document.querySelector('#aiBriefInput').value.length > 0", 20000);
    const afterRetry = await evaluate("document.querySelector('#aiBriefInput').value");
    assert(afterRetry.length > 0, "重新扩写后没有内�?);
    assert(afterRetry.indexOf("市立图书�?) >= 0, "重新扩写的内容不像扩写稿�? + JSON.stringify(afterRetry.slice(0, 60)));
    console.log("        首次 " + beforeRetry.length + " �?�?重新扩写 " + afterRetry.length + " �?);

    await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']').click(); true");
    await waitFor("document.querySelector('#aiCreateDialog').hidden === true", 8000);
  });

  await check("记忆取向：剧情取向下剧情才进记忆，并且标明是剧情", async () => {
    // 现行（平衡）取向：剧情类要点会被�?    await fetch(base + "/__reply", {
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
    const rejected = await evaluate("(async () => (await window.STApi.getWorld('MB Harry �?自动记忆')).entries)()");
    assert(JSON.stringify(rejected).indexOf("魔杖") < 0, "平衡取向下剧情不该进记忆");

    // 面板上的取向选择器：切成剧情
    await evaluate("window.TASK21.openMemoryPanel()");
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
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");

    // 剧情取向下再记一次：这次应当收下，并且标成剧�?    await fetch(base + "/__reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "嗯。\n[[记住: 战斗 | 他拔出魔杖把玩家推进了密室]]" }),
    });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再说一次刚才那�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const stored = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
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

    // 切回平衡，别影响后面的用�?    await evaluate("window.TASK21.saveOrientation({ avatar: 'Harry Potter (EN).png' }, 'balanced'); true");
  });

  await check("「说得对」：标过的记忆不会被上限挤掉", async () => {
    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    // 只点"这一�?的按钮：组标题那一层也�?.memory-actions（那是清空整组，会弹 confirm�?    // 而无头环境里 confirm 会一直挂着 —�?这个坑踩过一次）�?    const button = await waitFor("document.querySelector('#memoryList .memory-confirm') !== null", 8000);
    assert(button, "记忆条目上没有「说得对」按�?);
    const marked = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      document.querySelector('#memoryList .memory-confirm').click();
      await new Promise((r) => setTimeout(r, 800));
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
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
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
      const rows = core.listEntries(world.entries);
      const keep = rows.find((row) => row.confirmed);
      // 清成只剩这一条确认过�?+ 两条普通的
      const entries = {};
      entries['0'] = { uid: 0, content: keep.content, constant: true, rw_source: { confirmed: true, kind: 'fact', topic: '称呼' } };
      entries['1'] = { uid: 1, content: '普通记忆甲', constant: true, rw_source: { kind: 'fact' } };
      entries['2'] = { uid: 2, content: '普通记忆乙', constant: true, rw_source: { kind: 'fact' } };
      await window.STApi.editWorld('MB Harry �?自动记忆', { entries });
      return true;
    })()`);
    const trimmed = await evaluate(`(async () => {
      const core = window.ROLEWORLD_MEMORY_CORE;
      const world = await window.STApi.getWorld('MB Harry �?自动记忆');
      const result = core.trim(world.entries, 2, { orientation: 'companion' });
      return core.listEntries(result.entries).map((row) => row.content + (row.confirmed ? '(确认)' : ''));
    })()`);
    assert(trimmed.some((row) => row.indexOf("(确认)") >= 0),
      "上限挤占时把确认过的条目也挤掉了�? + JSON.stringify(trimmed));
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
  });

  await check("撞上输出上限：明确提示被截断，并给一个「接着说�?, async () => {
    // 让假端点这一轮回 finish_reason=length（模拟撞�?max_tokens�?    await fetch(base + "/__truncate", { method: "POST" });
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
    assert(notice, "被截断了却没有任何提�?);
    assert(notice.text.indexOf("截断") >= 0, "提示文案不对�? + JSON.stringify(notice));
    assert(notice.hasButton, "截断提示里应当有「接着说�?);

    // 刷新之后这条提示还在（写进了消息里）
    await fetch(base + "/__truncate", { method: "POST" });
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("document.querySelector('#dynamicMessages .message-truncated') !== null", 15000);

    // 点「接着说」：会发出一句看得见的舞台提示（不偷偷替用户说话�?    const before = requests.length;
    await evaluate("document.querySelector('#dynamicMessages .message-continue').click(); true");
    await waitTurnSettled();
    const after = requests.slice(before);
    const sent = after.filter((row) => row.stream === true);
    assert(sent.length >= 1, "点了「接着说」却没有发出请求");
    const lastUser = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
      return rows.length ? rows[rows.length - 1].textContent : '';
    })()`);
    assert(lastUser.indexOf("没说�?) >= 0 && lastUser.indexOf("继续�?) >= 0,
      "接着说发出去的舞台提示应当看得见�? + JSON.stringify(lastUser));

    // 台账里要能看�?这一轮被截断�?，以及按用途分开的长�?    const metrics = await evaluate(`(async () => {
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

  await check("生成参数面板：改完立刻生效，且只影响该影响的那一�?, async () => {
    const before = requests.filter((row) => row.stream === true);
    const baseRequest = before[before.length - 1];
    assert(typeof baseRequest.temperature === "number", "请求里应当带着温度");
    const chatTemp = baseRequest.temperature;

    // 切到"稳一�?：下一轮请求的温度/top_p 就该是这一档的�?    await evaluate(`(() => {
      const select = document.querySelector('[data-roleworld="sampling-preset"]');
      select.value = 'steady';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => (await window.RoleWorld.getLocalSettings()).sampling_preset === 'steady')()", 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '换了生成参数之后再说一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const steady = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(steady.temperature === 0.6, "切到稳一点之后温度应当是 0.6，实�?" + steady.temperature);
    assert(steady.top_p === 0.85, "top_p 应当�?0.85，实�?" + steady.top_p);
    assert(steady.temperature !== chatTemp, "预设应当真的改变了请�?);

    // 输出上限：填 600，下一轮请求的 max_tokens 就是 600
    await evaluate(`(() => {
      const input = document.querySelector('[data-roleworld="max-output"]');
      input.value = '600';
      document.querySelector('[data-roleworld="save"]').click();
      return true;
    })()`);
    await waitFor("(async () => (await window.RoleWorld.getLocalSettings()).max_tokens === 600)()", 8000);
    // 光等落盘还不够：页面的采样参数来自内存里的设置，异步重读可能还没回来�?    // �?发送前预估"那一行把 600 显示出来，才�?这一轮会�?600 �?的信号�?    await waitFor(`(() => {
      const node = document.querySelector('#chatEstimateLine');
      return node && node.textContent.indexOf('600') >= 0;
    })()`, 8000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '再试一次输出上�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const capped = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(capped.max_tokens === 600, "输出上限应当写进请求�? + capped.max_tokens);
    // 发送前预估那一行也要跟着这个上限走（否则面板和实际不一致）
    const line = await evaluate("document.querySelector('#chatEstimateLine').title");
    assert(line.indexOf("输出上限") >= 0 && line.indexOf("600") >= 0,
      "发送前预估没有用新的输出上限：" + JSON.stringify(String(line).slice(0, 140)));

    // 恢复默认，别影响后面的用�?    await evaluate(`(() => {
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

  await check("思考模式默认关闭：思维链既不显示也不请�?, async () => {
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    assert(sent[sent.length - 1].include_reasoning === false,
      "请求�?include_reasoning 应为 false，实�?" + JSON.stringify(sent[sent.length - 1].include_reasoning));
    const text = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(text.indexOf("思考中") < 0, "界面上还是出现了思维链：" + text.slice(0, 120));
  });

  await check("打开思考模式后请求会要求回传思维�?, async () => {
    await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    const before = requests.length;
    await evaluate(`(() => {
      const toggle = document.querySelector('[data-roleworld="thinking"]');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('#messageInput');
      input.value = '再问一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    // 只挑"这一�?的请求：后面还有别的用例会继续发请求�?    // 只看这一轮发出的请求（按发送前的请求数切片，避免被后面的用例干扰）
    const mine = requests.slice(before).filter((row) => row.stream === true);
    assert(await evaluate("window.__rwThinking === true"), "开关打开了，页面状态却没跟上（改完设置立刻发送会用旧值）");
    assert(mine.length >= 1, "这一轮没有发出请�?);
    assert(mine[mine.length - 1].include_reasoning === true,
      "打开后应�?true，实�?" + JSON.stringify(mine[mine.length - 1].include_reasoning));
    // 恢复默认，免得影响后面的页面
    await evaluate(`(() => {
      const toggle = document.querySelector('[data-roleworld="thinking"]');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  });

  // 这个应用里没有「停止生成」这个功能（生成中靠 Esc 或再点发送键中止），所以这里不测停止，
  // 只测「一条流里既有完整记忆标记、又有一条没写完时，界面上不能出现任何标记」�?  await check("流式回复里的记忆标记不出现在界面上（含没写完的那条）", async () => {
    await fetch(base + "/__slow-stream");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '慢慢�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    // 等这条慢流整条落地（半截标记之后还有一段正文）
    await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('明天�?) >= 0", 30000);
    await waitTurnSettled();

    const text = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(text.indexOf("记住") < 0, "记忆标记被当成正文显示了�? + JSON.stringify(text.slice(-160)));
    assert(text.indexOf("他把书合上�?) >= 0, "正文内容丢了�? + JSON.stringify(text.slice(-160)));
  });

  await check("存下来的回复里也没有记忆标记，刷新后依然是干净�?, async () => {
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const text = await waitFor(`(() => {
      const node = document.querySelector('#dynamicMessages');
      return node && node.textContent.indexOf('他把书合上�?) >= 0 ? node.textContent : '';
    })()`, 15000);
    assert(text.indexOf("记住") < 0, "刷新后聊天记录里留下了记忆标记：" + JSON.stringify(text.slice(-160)));
  });

  await check("设置面板能读到本机模型配�?, async () => {
    const value = await evaluate("document.querySelector('[data-roleworld=\"endpoint\"]').value");
    assert(value === base + "/v1/chat/completions", "端点显示�?" + value);
  });

  await check("关于里能看到「运行中的版本」，和线�?version.json 对得�?, async () => {
    // 用户�?还是英文"时，第一件要排除的就�?浏览器还在跑旧缓�?�?    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    await evaluate("document.querySelector('[data-settings-section=\"about\"]').click()");
    const shown = await waitFor(`(() => {
      const node = document.querySelector('[data-roleworld="app-version"]');
      return node && node.textContent.indexOf("运行 ") >= 0 ? node.textContent : "";
    })()`, 8000);
    const expected = await evaluate("(window.ROLEWORLD_BUILD || '')");
    assert(expected, "页面里没有编译进去的版本号（app/build.js 没加载？�?);
    assert(shown.indexOf(expected) >= 0, "版本行没显示运行中的版本�? + expected + "）：" + shown);
    assert(shown.indexOf("已是最�?) >= 0, "本地与线上版本一致时应当说「已是最新」：" + shown);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
  });

  await check("界面大小可调：生效、持久化、固定面板不受影�?, async () => {
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
    assert(after > before * 1.15, `放大后输入框没变大：${before} �?${after}�?{JSON.stringify(manual)}`);

    // 偏好要落到本机，刷新后才不会�?    const stored = await evaluate("(JSON.parse(localStorage.getItem('task27a.preferences.v1.local') || '{}') || {}).scale");
    assert(stored === "1.2", "缩放偏好没有存下来：" + stored);

    // 缩放之后固定定位的设置面板仍然要能正常打开
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    assert(await evaluate("document.querySelector('#settingsSurface').getBoundingClientRect().height > 100"), "放大后设置面板没有正常显�?);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");

    // 回到**新基�?*�?026-09-13 �?100% = zoom 0.9）�?    await evaluate(`(() => {
      const select = document.querySelector('#scaleSelect');
      select.value = '0.9';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelector('#appShell').style.zoom === '0.9'", 6000);

    // 默认就是 0.9，而且设置里那一档要读作�?00%」—�?    // 用户原话：「所有的默认大小调到现在�?0%，就是把现在�?0改成100」�?    const baseline = await evaluate(`(() => {
      const select = document.querySelector('#scaleSelect');
      const option = select.querySelector('option[value="0.9"]');
      return {
        defaultValue: window.RoleWorldZoom.DEFAULT_SCALE,
        zoom: document.querySelector('#appShell').style.zoom,
        label: option ? option.textContent.trim() : null,
        options: Array.from(select.options).map((o) => o.value + "=" + o.textContent.trim()),
      };
    })()`);
    assert(baseline.defaultValue === 0.9, "默认档不�?0.9�? + JSON.stringify(baseline));
    assert(baseline.label === "100%", "0.9 那一档没有读�?100%�? + baseline.label);
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

    assert(await press("=") === "0.95", "Ctrl+= 没有放大一�?);
    assert(await press("=") === "1", "Ctrl+= 第二次没生效");
    // 一路顶到上限，不能再涨
    for (let i = 0; i < 8; i += 1) await press("=");
    assert(await evaluate("window.RoleWorldZoom.current()") === 1.2, "上限没有停在 130%");
    for (let i = 0; i < 14; i += 1) await press("-");
    assert(await evaluate("window.RoleWorldZoom.current()") === 0.85, "下限没有停在 95%");

    // Ctrl+0 回到的是**新基�?0.9**（界面上�?100%），不是旧的 1�?    assert(await press("0") === "0.9", "Ctrl+0 没有回到 100%（zoom 0.9�?);
    assert(await evaluate("document.querySelector('#scaleSelect').value") === "0.9", "设置下拉没有同步");
  });

  await check("界面大小换了基准：老存档（1 = �?00%）加载后自动降到�?00%（zoom 0.9），且只降一�?, async () => {
    // 用户 2026-09-13：「所有的默认大小调到现在�?0%，就是把现在�?0改成100」�?    // 光改默认值不�?—�?老用户的 localStorage 里存着 scale:"1"（旧 100%），
    // 不迁移的话他们的界面一点都不会变小，这次改动对他们等于没发生�?    // 规则：老存档（没有 scaleBase 标记）整体下一格，搬完立刻落盘，只搬一次�?    const writePrefs = (scale) => evaluate(`(() => {
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
      assert(first.stored.scale === "0.9", "老存�?scale:1 没有被搬到新基准 0.9�? + JSON.stringify(first));
      assert(first.zoom === "0.9", "老存档迁移后界面没变小：" + JSON.stringify(first));
      assert(first.select === "0.9", "设置里的下拉没跟上迁移：" + JSON.stringify(first));
      assert(first.stored.scaleBase === "0.9", "迁移标记没落盘，下次会被再搬一格：" + JSON.stringify(first));

      // 再加载一次：标记在，就不许再往下降�?      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const second = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(second.stored.scale === "0.9" && second.zoom === "0.9",
        "第二次加载又降了一格（迁移不幂等）�? + JSON.stringify(second));

      // 自己挑过档位的人�?*只换叫法，不动大�?*�?.2 现在读作 130%）�?      await writePrefs("1.2");
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const third = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(third.stored.scale === "1.2", "用户自己挑的 1.2 不该被改掉：" + JSON.stringify(third));

      // 停在�?90% 的人：大小不变，只是现在这一档叫 100%�?      await writePrefs("0.9");
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
      const fourth = await evaluate(`(() => ({
        zoom: document.querySelector('#appShell').style.zoom || '1',
        stored: JSON.parse(localStorage.getItem("task27a.preferences.v1.local") || "{}"),
      }))()`);
      assert(fourth.stored.scale === "0.9" && fourth.zoom === "0.9",
        "停在 90% 的人应当原地不动（现在读�?100%）：" + JSON.stringify(fourth));
    } finally {
      await writePrefs("0.9").catch(() => {});
    }
  });

  await check("体验卡：粘一条卡号就能用，界面报出剩余额度（同学不用�?API Key�?, async () => {
    // 用户的需求原话：「像发体验卡一样…我的同学有些不会用」�?    // 这里用一个假中转，把"粘贴 �?自动配置 �?显示额度"整条链路跑一遍�?    const before = await evaluate("(async () => JSON.stringify(await RoleWorld.getLocalSettings()))()");
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
      await waitFor("document.querySelector('[data-roleworld=\"card-status\"]').textContent.indexOf('�?4 �?) >= 0", 8000);

      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(settings.provider === "custom", "用体验卡后服务商应当变成自定义：" + settings.provider);
      assert(settings.endpoint === base + "/relay/v1/chat/completions", "接口地址没指向中转：" + settings.endpoint);
      assert(settings.card_relay === base + "/relay", "没记住中转地址，之后查不了额度�? + settings.card_relay);
      const secret = await evaluate("(async () => (await RoleWorld.secrets.get('api_key_custom') || {}).value || '')()");
      assert(secret === "RW-AAAAA-BBBBB-CCCCC", "卡号没有进密钥位�? + secret);
      const status = await evaluate("document.querySelector('[data-roleworld=\"card-status\"]').textContent");
      assert(status.indexOf("到期 2026-10-12") >= 0, "没显示到期时间：" + status);
    } finally {
      // 恢复原设置（尤其是指回假模型端点的接口地址），别影响后面的用例�?      const original = JSON.parse(before);
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
    //   0.1.23「别人打开还是必须�?apikey」→ 带卡进来不能再要�?Key�?    //   0.1.29「通过卡进入的应该也要有个正式的开始的步骤」→ 也不能直接被扔进对话�?    //   得说明这是什么卡、还剩几次、到期没到期、角色为什么说英文、记录存在哪�?    // 这里�?老同学的浏览�?造出来（tutorial_seen 已经�?true —�?老版本为了不�?�?Key"那套记的），
    // �?#card= 链接进去，验证弹的是**体验卡开�?*、且它靠 card_welcome_seen 这个新标记判重�?    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: true, card_welcome_seen: false, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      // 真人�?在新标签页打开这条链接"：先到带片段的地址，再整页加载一�?      // （只改片段浏览器不会重新加载，所以这里显�?reload 才是真实场景）�?      await goto(base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay");
      await cdp.sessionSend(session, "Page.reload");
      await sleep(400);
      await waitFor("window.TASK21_READY === true", 30000);

      // �?卡被自动用上，接口指向中转、卡号进了密钥位
      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      const cardDebug = await evaluate("(window.RoleWorldCard && window.RoleWorldCard.knownResult && window.RoleWorldCard.knownResult()) || null");
      assert(settings.provider === "custom",
        "体验卡链接没有把服务商切到自定义�? + settings.provider + "；applyFromLocation 结果=" + JSON.stringify(cardDebug));
      assert(settings.endpoint === base + "/relay/v1/chat/completions", "接口地址没指向中转：" + settings.endpoint);
      const secret = await evaluate("(async () => (await RoleWorld.secrets.get('api_key_custom') || {}).value || '')()");
      assert(secret === "RW-AAAAA-BBBBB-CCCCC", "卡号没有进密钥位�? + secret);

      // �?弹的是「体验卡开场」：说明卡与额度，而且**没有 API Key 输入�?*
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      const intro = await evaluate(`(() => ({
        title: document.querySelector('.rw-ob h2').textContent,
        text: document.querySelector('.rw-ob-card').textContent,
        hasKeyInput: !!document.querySelector('[data-ob="key"]'),
        dots: document.querySelectorAll('.rw-ob-dots i').length,
      }))()`);
      assert(intro.title.indexOf("体验�?) >= 0, "开场第一步不是体验卡说明�? + intro.title);
      assert(intro.text.indexOf("不用�?API Key") >= 0, "没说明用卡不�?Key");
      assert(!intro.hasKeyInput, "体验卡开场里不该�?API Key 输入�?);
      assert(intro.text.indexOf("�?4 �?) >= 0, "没告诉同学还剩几次：" + intro.text.slice(0, 200));
      assert(intro.text.indexOf("只存在这台设备上") >= 0, "没说明聊天记录存在哪");

      // �?走完这四步：卡说�?�?称呼 �?语言 �?开�?      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="nickname"]');
        input.value = '体验卡同�?;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      await waitFor("!!document.querySelector('[data-ob=\"language-zh\"]')", 8000);
      const langStep = await evaluate("document.querySelector('.rw-ob-card').textContent");
      assert(langStep.indexOf("说英�?) >= 0 && langStep.indexOf("简体中�?) >= 0,
        "语言这一步没把「默认说英文、可以改成中文」讲清楚�? + langStep.slice(0, 200));
      await evaluate(`(() => {
        const box = document.querySelector('[data-ob="language-zh"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      // 语言之后�?*功能导览**（用�?2026-09-12：「第一次进的时候也要介绍网站的功能吧」）
      await waitFor("document.querySelector('.rw-ob') && document.querySelector('.rw-ob h2').textContent.indexOf('这里能做什�?) >= 0", 8000);
      const tour = await evaluate("document.querySelector('.rw-ob-card').textContent");
      for (const topic of ["跟角色聊�?, "他们记得�?, "剧情模式", "伴侣模式", "语言", "花的钱看得见", "数据只在这台设备�?]) {
        assert(tour.indexOf(topic) >= 0, "功能导览里缺少�? + topic + "」：" + tour.slice(0, 300));
      }
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("document.querySelector('.rw-ob') && document.querySelector('.rw-ob h2').textContent.indexOf('可以开�?) >= 0", 8000);
      const ready = await evaluate("document.querySelector('.rw-ob-card').textContent");
      assert(ready.indexOf("�?4 �?) >= 0, "最后一步没再报一次额度：" + ready.slice(0, 200));
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!document.querySelector('.rw-ob')", 8000);
      // 浮层消失 = 这一步真的完成了：标记必�?*已经**落盘�?      // 这里断言的是"顺序"本身（不�?再等一会儿"）—�?以前 finish() �?close() 再写设置�?      // 中间隔着两次 await，于是存�?浮层没了、标记还没写"的窗口：
      // 用户正好这时刷新会重看一次开场，自动化读到旧值（2026-09-13 那条偶发就卡在这里）�?      const markerAtClose = await evaluate("(async () => (await RoleWorld.getLocalSettings()).card_welcome_seen)()");
      assert(markerAtClose === true,
        "浮层消失时「开场看过」的标记还没落盘：关浮层与落盘的顺序又反�?);

      // �?开场里做的事要落盘：称呼、语言、以�?开场看�?这个标记
      const after = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(after.card_welcome_seen === true, "开场走完了却没记标记，下次还会�?);
      assert(after.language_mode === "zh", "开场里勾的「一律中文」没生效�? + after.language_mode);
      const savedNickname = await evaluate("document.getElementById('userDisplayName').textContent.trim()");
      assert(savedNickname === "体验卡同�?, "开场里填的称呼没生效：" + savedNickname);

      // �?重载不再弹（这是"正式的第一�?而不是每次都来）
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await sleep(700);
      assert(await evaluate("document.querySelector('.rw-ob') === null"), "开场走完之后重载又弹了一�?);
      await waitFor("document.querySelector('#messageInput').disabled === false", 10000);

      // �?顶栏徽标：显示剩余次�?      await waitFor("document.querySelector('#cardChip') && document.querySelector('#cardChip').hidden === false", 8000);
      const chip = await evaluate("document.querySelector('#cardChip').textContent");
      assert(chip.indexOf("�?4 �?) >= 0, "徽标没显示剩余次数：" + chip);

      // �?真发一句：走后端中转，回复正常显示，徽标按响应头刷�?3
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '我们出发吧？';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      const visible = await evaluate("document.querySelector('#dynamicMessages').textContent");
      assert(visible.indexOf("我们出发�?) >= 0, "中转的回复没显示出来�? + visible.slice(-140));
      assert(requests.some((row) => row.path === "/relay/v1/chat/completions"), "这轮没有走中�?);
      const chipAfter = await evaluate("document.querySelector('#cardChip').textContent");
      assert(chipAfter.indexOf("�?3 �?) >= 0, "徽标没按这一轮的响应头刷新：" + chipAfter);
    } finally {
      // 收尾：恢�?fixture 的设置，别影响后面的用例�?      // 注意�?*通知页面**（saveLocalSettings 只落盘，不会改内存里�?liveState）—�?      // 否则后面的用例还在往中转地址发请求�?      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", tutorial_seen: true, language_mode: "auto" });
        await RoleWorld.secrets.remove("api_key_custom");
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", language_mode: "auto" } }));
        return true;
      })()`).catch(() => {});
    }
  });

  await check("地址里没带卡的人：引导里能直接用体验卡进门，不用 API Key", async () => {
    // 用户 2026-09-12 实测：「为什么我登的时候还是要�?apikey」�?    // 链接被聊天软件截掉、或者自己打开首页（地址里没�?card=…）时，以前引导只给 API Key 一条路�?    // 现在把「卡号@中转地址」粘在这一步就能进 —�?和「设�?�?模型 �?体验卡」走同一�?apply()�?    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false, provider: 'deepseek', endpoint: '', card_relay: '', model: 'deepseek-flash' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      await goto(base + "/index.html");   // 注意：地址�?*没有** card=�?      await waitFor("window.TASK21_READY === true", 30000);
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="nickname"]');
        input.value = '体验卡同�?;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      await waitFor("!!document.querySelector('[data-ob=\"card\"]')", 8000);

      // �?这一步必须看得见"用体验卡"这条路，并且说明白要粘什�?      const entry = await evaluate(`(() => {
        const input = document.querySelector('[data-ob="card"]');
        const button = document.querySelector('[data-ob="card-use"]');
        const box = input ? input.getBoundingClientRect() : null;
        return {
          hasInput: !!input, hasButton: !!button,
          w: box ? Math.round(box.width) : 0, h: box ? Math.round(box.height) : 0,
          text: document.querySelector('.rw-ob-card').textContent,
        };
      })()`);
      assert(entry.hasInput && entry.hasButton, "引导里没有「用体验卡」这一条路�? + JSON.stringify(entry));
      assert(entry.w > 0 && entry.h > 0, "卡号输入框看不见/不占位置�? + JSON.stringify(entry));
      assert(entry.text.indexOf("体验�?) >= 0 && entry.text.indexOf("不用 API Key") >= 0,
        "引导里没写清「有卡就可以不用 Key」：" + entry.text.slice(0, 200));

      // �?粘「卡号@中转地址」，而且**故意不点「用体验卡�?*直接点下一�?—�?      //    同学的直觉就�?粘上、点下一�?，这一步不该被自己漏掉的按钮挡住�?      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="card"]');
        input.value = 'RW-AAAAA-BBBBB-CCCCC@${base}/relay';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      // 先过功能导览那一步，再到「准备就绪�?      await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('这里能做什�?) >= 0", 20000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('准备就绪') >= 0", 20000);
      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(settings.provider === "custom", "卡没把服务商切到自定义：" + settings.provider);
      assert(settings.endpoint === base + "/relay/v1/chat/completions", "接口地址没指向中转：" + settings.endpoint);
      const secret = await evaluate("(async () => (await RoleWorld.secrets.get('api_key_custom') || {}).value || '')()");
      assert(secret === "RW-AAAAA-BBBBB-CCCCC", "卡号没进密钥位：" + secret);

      // �?走完引导：顶栏要有剩余次数徽标、输入框可用
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!document.querySelector('.rw-ob')", 8000);
      await waitFor("document.querySelector('#cardChip') && document.querySelector('#cardChip').hidden === false", 8000);
      const chip = await evaluate("document.querySelector('#cardChip').textContent");
      assert(chip.indexOf("�?4 �?) >= 0, "顶栏没显示剩余次数：" + chip);
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

  await check("用卡的人再走一次教程：Key 栏不自动填东西，粘卡号也不会被当�?API Key 存下�?, async () => {
    // 用户 2026-09-13 实测：「再看一遍教程的时候，apikey 好像会自动填上那个卡啥的」�?    // 两个原因，各修一条：
    //   �?浏览器把这栏当过密码 —�?用户早先把卡号粘在这里过，Chrome 记住了，之后每次都自动填回来�?    //      现在这栏�?autocomplete="new-password"（浏览器约定�?别自动填"�? 每次进这一步强制清空，
    //      并且用卡的人会先看到一句「这一步不用填 API Key」�?    //   �?万一手快把卡号粘�?Key 栏再点「保存并测试」，以前会直接把卡号写进密钥�?�?下一轮必�?401�?    //      现在会被认出来、挪到体验卡那一栏，并且**不写**密钥位�?    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ tutorial_seen: true, provider: "custom", endpoint: "${base}/relay/v1/chat/completions", card_relay: "${base}/relay", model: "deepseek-flash" });
      await RoleWorld.secrets.set("api_key_custom", "RW-AAAAA-BBBBB-CCCCC");
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "custom", endpoint: "${base}/relay/v1/chat/completions", card_relay: "${base}/relay" } }));
      return true;
    })()`);
    try {
      // 「设�?�?关于 �?再看一次教程」走的就是这一套（archive-ui.js 接的线是 show() 无参�?= full）�?      await evaluate("window.RoleWorldOnboarding.show(); true");
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
        "Key 栏的 autocomplete 必须�?new-password，否则浏览器会把记住的密码填回来�? + step.autocomplete);
      assert(step.note.indexOf("体验�?) >= 0 && step.note.indexOf("不用�?) >= 0,
        "用卡的人在这步没被告知「不用填 Key」：" + step.note);
      assert(step.endpoint.indexOf("/relay/v1/chat/completions") >= 0, "接口地址没带出来�? + step.endpoint);

      // 设置 �?模型 那一栏也是同一个毛病（同一个被浏览器记住的密码），一起钉住�?      const settingsKey = await evaluate(`(() => {
        const node = document.querySelector('[data-roleworld="key"]');
        return { value: node.value, autocomplete: node.getAttribute("autocomplete"), type: node.getAttribute("type") };
      })()`);
      assert(settingsKey.type === "password", "设置里的 Key 栏应当是遮住�?);
      assert(settingsKey.autocomplete === "new-password",
        "设置 �?模型 �?Key 栏也必须�?new-password�? + settingsKey.autocomplete);
      assert(settingsKey.value === "", "设置里的 Key 栏被自动填了东西�? + JSON.stringify(settingsKey));

      // 手快把卡号粘�?Key 栏再点「保存并测试」：不许写进密钥位�?      const after = await evaluate(`(async () => {
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
        "卡号被当�?API Key 写进密钥位了（下一轮必�?401）：" + JSON.stringify(after));
      assert(after.keyValue === "", "认出是卡号之�?Key 栏应当清空：" + JSON.stringify(after));
      assert(after.cardValue.indexOf("RW-ZZZZZ-YYYYY-XXXXX") === 0, "卡号没被挪到体验卡那一栏：" + JSON.stringify(after));
      assert(after.cardStatus.indexOf("体验�?) >= 0, "没提示该点「用体验卡」：" + after.cardStatus);

      // 收尾�?*走完**流程（内�?close() 才会摘掉 Esc 拦截�?overlay 引用），别直接删 DOM�?      for (let i = 0; i < 4 && await evaluate("!!document.querySelector('.rw-ob')"); i += 1) {
        await evaluate("document.querySelector('[data-ob=\"next\"]').click(); true");
        await new Promise((r) => setTimeout(r, 400));
      }
      assert(!(await evaluate("!!document.querySelector('.rw-ob')")), "教程走不到头（卡用户的「下一步」卡住了�?);
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

  await check("角色语言：默认跟角色卡自己（英文卡说英文），每个角色可以在顶栏单独开成中�?, async () => {
    // 用户 2026-09-12 的两句话定了这件事：
    //   「应该是可以开启强制全部中文，默认应该是角色自身的语言�?「每个角色都弄一个语言开关选项」�?    const streamedCount = () => requests.filter((row) => row.stream === true).length;
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

    // �?默认：不强制任何语言（这张卡的卡面没写语言 �?跟着玩家说），更没有那条"贴近本轮输入"的提醒�?    //    上一版（0.1.24~0.1.26）默认是"一律中�?，现在改�?角色自己的语言"�?    await send("在吗�?);
    const firstTurn = lastTurn();
    assert(firstTurn.systemText.indexOf("一律用简体中文回�?) < 0,
      "默认不该强制中文�? + firstTurn.systemText.slice(-200));
    assert(firstTurn.systemText.indexOf("[Language]") < 0,
      "卡面没写语言时不加语言约束（跟着玩家说）�? + firstTurn.systemText.slice(-200));
    assert(firstTurn.tailMessages[0].role !== "system" && firstTurn.tailMessages[1].role === "user",
      "默认不该插语言提醒（尾巴应当是上一条回�?+ 这句话）�? + JSON.stringify(firstTurn.tailMessages));

    // �?顶栏那个「语言」下拉＝**这个角色**的开关：改成"一律中�?，下一轮就生效（不刷新、不重开对话）�?    const lang = await evaluate(`(() => {
      const select = document.querySelector('#chatLangSelect');
      if (!select) return { exists: false };
      const box = select.getBoundingClientRect();
      const before = select.value;
      select.value = 'zh';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { exists: true, before: before, w: Math.round(box.width), h: Math.round(box.height) };
    })()`);
    assert(lang.exists, "顶栏没有「语言」开关（每个角色一个语言开关就靠它�?);
    assert(lang.before === "auto", "默认这一档应当是「跟随设置」，实际�?" + lang.before);
    assert(lang.w > 0 && lang.h > 0, "「语言」开关点了没用（看不�?不占位置）：" + JSON.stringify(lang));
    await waitFor("(async () => (await RoleWorld.getLocalSettings()).language_by_card['Harry Potter (EN).png'] === 'zh')()", 8000);

    await send("再说一�?);
    const zhTurn = lastTurn();
    assert(zhTurn.systemText.indexOf("一律用简体中文回�?) >= 0,
      "改成中文之后没有要求中文�? + zhTurn.systemText.slice(-200));
    // 语言提醒必须**紧贴用户这句�?*（整段历史是英文时，只有最前面那句压不住）�?    assert(zhTurn.tailMessages[0].role === "system"
      && zhTurn.tailMessages[0].text.indexOf("必须用简体中文回�?) >= 0,
      "最后一条系统提醒不在用户这句话之前�? + JSON.stringify(zhTurn.tailMessages));
    assert(zhTurn.tailMessages[1].role === "user", "用户那句话应当紧跟其后：" + JSON.stringify(zhTurn.tailMessages));
    // 只记在这一个角色上（别的角色不受影响）�?    const langMap = await evaluate("(async () => (await RoleWorld.getLocalSettings()).language_by_card)()");
    assert(Object.keys(langMap).length === 1 && langMap["Harry Potter (EN).png"] === "zh",
      "语言开关应当只记在这一个角色上�? + JSON.stringify(langMap));

    // 改回「跟随设置�? 不再覆盖这个角色（存的记录要清掉，不留空记录）�?    await evaluate(`(() => {
      const select = document.querySelector('#chatLangSelect');
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => Object.keys((await RoleWorld.getLocalSettings()).language_by_card).length === 0)()", 8000);

    // �?全局那一档（「设�?�?模型 �?角色语言」）管所有没单独设过的角色�?    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
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
    await send("第三�?);
    assert(lastTurn().systemText.indexOf("一律用简体中文回�?) >= 0,
      "全局「角色语言 = 一律简体中文」没生效�? + lastTurn().systemText.slice(-200));

    // ④「设�?�?角色管理」里每个角色都有一份同样的开关（和顶栏那份是同一份设置）�?    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
    await evaluate("window.TASK25C_UI.setSettingsSection('characters'); true");
    await waitFor("!!document.querySelector('[data-character-language]')", 8000);
    const rows = await evaluate("(() => Array.from(document.querySelectorAll('[data-character-language]'))"
      + ".map((n) => ({ avatar: n.dataset.characterLanguage, value: n.value })))()");
    assert(rows.length >= 2, "角色管理里每个角色都该有语言开关：" + JSON.stringify(rows));
    assert(rows.every((row) => row.value === "auto"), "没单独设过的角色应当显示「跟随设置」：" + JSON.stringify(rows));

    // 在这一行把 Harry 改成「一律英文」：全局仍是中文，但它单独压过全局�?    await evaluate(`(() => {
      const node = document.querySelector('[data-character-language="Harry Potter (EN).png"]');
      node.value = 'en';
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(async () => (await RoleWorld.getLocalSettings()).language_by_card['Harry Potter (EN).png'] === 'en')()", 8000);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 6000);
    await send("第四�?);
    assert(lastTurn().systemText.indexOf("一律用英文回复") >= 0,
      "单个角色改成英文没生效：" + lastTurn().systemText.slice(-200));
    assert(lastTurn().systemText.indexOf("一律用简体中文回�?) < 0,
      "单个角色的设置应当压过全局中文�? + lastTurn().systemText.slice(-200));

    // 恢复默认（全局 auto、没有单角色覆盖），别影响后面的用例�?    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ language_mode: 'auto', language_by_card: {} }); return true; })()");
    await evaluate("window.dispatchEvent(new CustomEvent('roleworld:settings-changed', { detail: { language_mode: 'auto', language_by_card: {} } })); true");
  });

  await check("账号相关入口不可�?, async () => {
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
    assert(visible.hidden.length === 0, "仍然可见�? + visible.hidden.join(","));
    assert(visible.rows.length === 0, "仍然可见的账号按钮：" + visible.rows.join(","));
    assert(visible.wrong.length === 0, "仍然可见的管理面板：" + visible.wrong.join(","));
  });

  await check("已经配好自己 API Key 的人：打开网站什么都不弹，直接进对话", async () => {
    // 用户问过：「已经配好自己的 apikey 的人、或者不是用卡登陆的人，开网站的界面是怎样的」�?    // 老用户的预期�?*什么都没有**：不�?�?Key"那套，也不弹体验卡开场�?    // 这条以前没有用例守着（主 fixture �?tutorial_seen 设成 true，走不到这条分支）�?    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false, card_welcome_seen: false, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.set('api_key_deepseek', 'sk-自己的key'); return true; })()");
    try {
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await sleep(1200);   // 引导�?等启动落定再�?的，给它足够时间（真的会弹就不会漏）
      assert(await evaluate("document.querySelector('.rw-ob') === null"), "配好 Key 的老用户被打扰了：弹了引导");
      const settings = await evaluate("(async () => await RoleWorld.getLocalSettings())()");
      assert(settings.tutorial_seen === true, "应当顺手�?tutorial_seen 补上（下次启动不用再判断一遍）");
      assert(settings.card_welcome_seen !== true, "没在用卡的人不该被记上「体验卡开场看过�?);
      assert(await evaluate("document.querySelector('#messageInput').disabled === false"), "输入框不可用");
    } finally {
      // 收尾要把 endpoint 还原成夹具那个假端点 —�?否则后面的用例会拿空地址去连真服务商�?      await evaluate(`(async () => {
        await RoleWorld.secrets.remove('api_key_deepseek');
        await RoleWorld.saveLocalSettings({ tutorial_seen: true, provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", card_welcome_seen: false });
        return true;
      })()`).catch(() => {});
    }
  });

  await check("首次启动强制走完引导：没有跳过，先写称呼再填 Key", async () => {
    // 主流程的 fixture �?tutorial_seen 设成 true（否则引导浮层会盖住整个界面�?    // 用例里那�?element.click() 照样能点，真人却点不�?—�?记忆按钮那个缺陷就是这么漏掉的）�?    // 这条用例要验引导本身，所以先�?第一次启�?造出来：清标�?+ 刷新�?    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false }); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!document.querySelector('.rw-ob')", 15000);
    const first = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(first.indexOf("欢迎") >= 0, "引导首页标题是：" + first);
    assert(await evaluate("document.querySelector('[data-ob=\"skip\"]') === null"), "不该有「跳过」按�?);
    // 进门就能看到「全中文」这个选项（有人看不懂英文），�?*默认不勾** —�?    // 默认�?角色说自己的语言"�?026-09-12 用户改的默认值）�?    const chineseBox = await evaluate(`(() => {
      const box = document.querySelector('[data-ob="language-zh"]');
      return box ? { exists: true, checked: box.checked === true, text: box.parentElement.textContent.trim() } : { exists: false };
    })()`);
    assert(chineseBox.exists, "引导首页没有「全中文」选项");
    assert(!chineseBox.checked, "「全中文」不该默认勾上（默认跟角色卡自己的语言）：" + JSON.stringify(chineseBox));
    assert(chineseBox.text.indexOf("简体中�?) >= 0, "选项文案要说清楚管的是角色说什么语言�? + chineseBox.text);

    // 之前出现过「黑字压在深色背景上完全看不见」，这里直接算对比度�?    const contrast = await evaluate(`(() => {
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
    assert(contrast.ratio >= 3, `引导正文对比度太低（${contrast.ratio}�?{contrast.color} on ${contrast.bg}）`);

    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 5000);
    const nameStep = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(nameStep.indexOf("称呼") >= 0, "第二步不是填称呼�? + nameStep);
    await evaluate(`(() => {
      const input = document.querySelector('[data-ob="nickname"]');
      input.value = '测试称呼';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-ob="next"]').click();
      return true;
    })()`);
    await waitFor("!!document.querySelector('[data-ob=\"key\"]')", 5000);
    const second = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(second.indexOf("API Key") >= 0, "第三步不是填 Key�? + second);
    assert(await evaluate("!!document.querySelector('[data-ob=\"save\"]')"), "第二步缺少「保存并测试�?);

    // 没填 Key 不许往下走
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("document.querySelector('[data-ob=\"status\"]').textContent.length > 0", 5000);
    const blocked = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(blocked.indexOf("API Key") >= 0, "没填 Key 却放行了");

    // 填上 Key 并测试（夹具的端点指向本地假服务�?    await evaluate(`(() => {
      const input = document.querySelector('[data-ob="key"]');
      input.value = 'sk-onboarding-test';
      document.querySelector('[data-ob="save"]').click();
      return true;
    })()`);
    await waitFor("document.querySelector('[data-ob=\"status\"]').classList.contains('is-ok')", 15000);
    const ok = await evaluate("document.querySelector('[data-ob=\"status\"]').textContent");
    assert(ok.indexOf("连接正常") >= 0, "测试连接没有通过�? + ok);

    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    // 自己�?Key 的这条路也要经过同一份功能导览（用户：「第一次进的时候也要介绍网站的功能吧」）
    await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('这里能做什�?) >= 0", 8000);
    assert(await evaluate("document.querySelector('.rw-ob-card').textContent.indexOf('剧情模式') >= 0"),
      "功能导览里没有提到剧情模�?);
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("document.querySelector('.rw-ob h2').textContent.indexOf('准备就绪') >= 0", 8000);
    assert(await evaluate("document.querySelector('[data-ob=\"next\"]').textContent.trim() === '开始使�?"), "最后一步按钮文案不�?);
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("!document.querySelector('.rw-ob')", 5000);

    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("new Promise((r) => setTimeout(r, 2000))");
    assert(await evaluate("!document.querySelector('.rw-ob')"), "走完之后重载又弹了一�?);
    // 引导里填的称呼要落进偏好，并且在界面上生效（角色就这么叫他）�?    assert(await evaluate("document.getElementById('userDisplayName').textContent.trim() === '测试称呼'"),
      "称呼没有生效，界面显示：" + await evaluate("document.getElementById('userDisplayName').textContent"));
    const nicknameRow = await evaluate("!!document.getElementById('nicknameInput')");
    assert(nicknameRow, "设置里没有可修改称呼的输入框");
  });

  await check("设置 �?关于里的「再看一次教程」能重新打开", async () => {
    await evaluate("document.querySelector('[data-roleworld=\"tutorial\"]').click()");
    await waitFor("!!document.querySelector('.rw-ob')", 5000);
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    const second = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(second.indexOf("欢迎") < 0, "「下一步」没有翻页，标题还是�? + second);
  });




  console.log("== 剧情模式�?==");

  await goto(base + "/magic-map.html");

  await check("剧情模式页正常启动并可读取角�?, async () => {
    await waitFor("document.querySelector('#castMeta') && document.querySelector('#castMeta').textContent.indexOf('正在读取') < 0", 20000);
    const names = await evaluate("document.querySelector('#castMeta').textContent");
    assert(names.length > 0, "演职员信息为�?);
  });

  await check("剧情模式没有跳转到登录页", async () => {
    const href = await evaluate("location.pathname");
    assert(href.endsWith("/magic-map.html"), "被跳转到�?" + href);
  });

  await check("剧情模式与主界面是同一套皮肤（不再自带羊皮�?衬线�?, async () => {
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
    assert(probe.style === "gold" || probe.style === "default",
      "风格属性不对（新默认是 gold）：" + probe.style);
    assert(probe.bodyBg === probe.expected, `背景没跟着设计变量走：${probe.bodyBg} �?${probe.expected}`);
    assert(!/Songti|Georgia|Palatino|Iowan|Noto Serif|(?<!sans-)serif/i.test(probe.font), "还在用衬线字体：" + probe.font);
  });

  await check("外观里的风格可切换，且两个页面一起变", async () => {
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const before = await evaluate("document.documentElement.dataset.style");
    assert(before === "gold", "初始风格不对（新默认是返校金）：" + before);
    await evaluate(`(() => {
      const select = document.querySelector('#styleSelect');
      select.value = 'gold';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.documentElement.dataset.style === 'gold'", 6000);
    // 选「返校金」应当同时点亮秋季氛�?    assert(await evaluate("!!document.querySelector('html[data-style=\"gold\"]')"), "风格没落�?html �?);

    await goto(base + "/magic-map.html");
    await waitFor("document.querySelector('#castMeta') && document.querySelector('#castMeta').textContent.indexOf('正在读取') < 0", 20000);
    assert(await evaluate("document.documentElement.dataset.style === 'gold'"), "剧情模式没有跟上风格�? + await evaluate("document.documentElement.dataset.style"));

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

  console.log("== 内置内容包（packs/harry-potter�?=");

  await check("内容包在首次启动时自动安装，角色卡自带立�?, async () => {
    await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
    await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: "window.__ROLEWORLD_FIXTURE__ = null;" });
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    reportErrors("内置�?index.html");

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

    assert(state.characters.length === 6, "应装�?6 个角色，实际 " + state.characters.length + "�? + JSON.stringify(state.characters) + " / 书：" + JSON.stringify(state.books));
    assert(state.characters.indexOf("Harry Potter (EN).png") >= 0, "缺少默认角色 Harry Potter (EN).png");
    // 2026-09-12：包里原来那 3 本整本都�?别人的存�?（原 SillyTavern 存档的玩家角�?Lin），
    // 已从包里删除；示例内容的去向�?runs/2026-09-12-lin-sample-memories-removed/README.md�?    // 现在带的是：世界观设�?1 �?+ **每个角色一本「原著剧情�?*（用户要�?真实小说的剧�?）�?    assert(state.books.length === 7, "应装�?7 本记忆书，实�?" + state.books.length + "�? + JSON.stringify(state.books));
    assert(state.books.indexOf("MB Harry �?role lock (EN)") >= 0, "缺少记忆书：MB Harry �?role lock (EN)");
    ["MB Harry �?原著剧情", "MB Ron �?原著剧情", "MB Hermione �?原著剧情",
      "MB Ginny �?原著剧情", "MB Luna �?原著剧情", "MB Tom �?原著剧情"].forEach((name) => {
      assert(state.books.indexOf(name) >= 0, "缺少原著剧情书：" + name);
    });
    ["MB Harry �?fact clips (EN)", "MB Harry �?relationship tracker (EN)",
      "MB Harry �?scene memories (EN)"].forEach((name) => {
      assert(state.books.indexOf(name) < 0, "这本是别人的存档，不该再装进新存档：" + name);
    });
    assert(state.avatars.every((size) => size > 1000), "有角色卡丢了立绘�? + JSON.stringify(state.avatars));
    assert(state.pickerHidden === false, "角色选择器没有显示出�?);
    assert(state.pickerName.indexOf("Harry Potter") === 0, "默认角色选择错了�? + state.pickerName);
    assert(state.composer, "装了内置包之后输入框仍然不可�?);
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
          // 每本都必须有一条「他知道什么、不知道什么」，否则角色会顺着玩家的话编未来�?          cutoff: entries.some((e) => /不知道|知识停在|界限|边界|截止/.test(String(e.content || ''))),
          future: entries.some((e) => /不知道|不会假装|不会当成/.test(String(e.content || ''))),
        });
      }
      return out;
    })()`);
    assert(data.length === 6, "应当�?6 本原著剧情，实际 " + data.length + "�? + JSON.stringify(data.map((row) => row.name)));
    for (const row of data) {
      assert(row.count >= 5, row.name + " 的条目太少：" + row.count);
      assert(row.cutoff, row.name + " 没有写明知识截止�?);
      assert(row.future, row.name + " 没有写明未来不可�?);
    }

    // 书要归到对的人身上：哈利的书归哈利，罗恩的归罗恩�?    const owner = await evaluate(`(() => {
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
    // 哈利的书归哈利（防止"前缀匹配"�?Ron 的书也匹�?Harry 之类的错位）�?    const harry = owner.find((row) => row.avatar === "Harry Potter (EN)");
    assert(harry.books[0].indexOf("MB Harry") === 0, "哈利的书对错了：" + JSON.stringify(harry.books));
  });

  await check("内容包自带卡：升级时会刷新卡内容，但不碰对话与记�?, async () => {
    // 造一�?旧存�?：库里是缺语言标记的旧卡，且没有来源标记（老版本装的那种）�?    const before = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const card = await store.getCharacter('Harry Potter (EN).png');
      const stripped = Object.assign({}, card);
      delete stripped.pack_source;
      stripped.fav = true;
      stripped.date_added = '2020-01-01T00:00:00.000Z';
      await store.putCharacter(stripped);
      // 自己造一段对话与一本记忆书：用来验证刷新卡内容时它们不会被碰�?      await store.saveChat('Harry Potter (EN).png', 'harry-旧对�?jsonl', [
        { chat_metadata: {}, user_name: '�?, character_name: 'Harry Potter' },
        { name: '�?, is_user: true, mes: '这是一条测试对�?, send_date: '2020-01-01T00:00:00.000Z' },
      ]);
      await store.putWorld('MB Harry �?测试记忆', { entries: {} });
      const chats = await store.listChats('Harry Potter (EN).png');
      return {
        hasPackSource: !!card.pack_source,
        hasChat: chats.length > 0,
        chatCount: chats.length,
        title: card.name,
      };
    })()`);
    assert(before.hasChat, "测试前应当已经有对话，否则测不出「不碰对话�?);

    // �?已经刷到哪一�?清掉，再走一遍内容包安装（等同老存档第一次跑新版应用�?    const report = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      await store.setKV('packs:installed', {});
      await store.setKV('packs:seed-version', '');
      return JSON.stringify(await window.RoleWorldPacks.installAll({ silent: true }));
    })()`);
    assert(report.indexOf("harry-potter") >= 0, "安装没有执行�? + report);

    const after = await evaluate(`(async () => {
      const store = window.RoleWorld.store;
      const card = await store.getCharacter('Harry Potter (EN).png');
      return {
        lang: (card.data && card.data.extensions && card.data.extensions.task29 && card.data.extensions.task29.language) || null,
        hasPackSource: !!card.pack_source,
        fav: !!card.fav,
        dateAdded: card.date_added,
        chats: (await store.listChats('Harry Potter (EN).png')).length,
        chatText: JSON.stringify(await store.getChat('Harry Potter (EN).png', 'harry-旧对�?jsonl')),
        worlds: (await store.listWorlds()).map((w) => w.name),
      };
    })()`);
    assert(after.lang === "en", "刷新后卡里应当带上语言标记，实�?" + JSON.stringify(after.lang));
    assert(after.chatText.indexOf("这是一条测试对�?) >= 0, "刷新把对话内容弄丢了");
    assert(after.worlds.indexOf("MB Harry �?测试记忆") >= 0, "刷新把记忆书弄丢�?);
    assert(after.hasPackSource, "刷新后应当打上来源标�?);
    assert(after.fav === true, "刷新不该丢掉收藏状�?);
    assert(after.dateAdded === "2020-01-01T00:00:00.000Z", "刷新不该改掉加入时间");
    assert(after.chats === before.chatCount, "刷新不该动对话记录：刷新�?" + before.chatCount + "，刷新后 " + after.chats);
  });

  console.log("== 消息旁的操作（本轮第 �?项）==");

  await check("数据与备份：一个入口看数量与上次导出，清空和日常备份分开", async () => {
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    // 从「关于」页那颗按钮跳过去（关于页不再重复放导出/导入/清空）�?    await evaluate("window.TASK25C_UI.setSettingsSection('about'); true");
    await waitFor("!!document.querySelector('[data-action=\"goto-data-backup\"]')", 8000);
    await evaluate("document.querySelector('[data-action=\"goto-data-backup\"]').click(); true");
    await waitFor("document.querySelector('#settings-local-data').classList.contains('is-active')", 8000);
    // 概况是切换分页之�?*异步**读出来的：初始文案是"正在读取�?�?    // 所以不能只�?有文�?，要等读到真实数量（这一条自己踩过一次）�?    await waitFor("(function(){ var t = (document.querySelector('[data-roleworld=\"data-summary\"]') || {}).textContent || ''; return /角色 [1-9]/.test(t); })()", 15000);

    const page = await evaluate(`(() => {
      const section = document.querySelector('#settings-local-data');
      const summary = section.querySelector('[data-roleworld="data-summary"]').textContent;
      const last = section.querySelector('[data-roleworld="last-backup"]').textContent;
      const danger = section.querySelector('.settings-danger-zone');
      const wipe = section.querySelector('[data-roleworld="wipe"]');
      const exportBtn = section.querySelector('[data-roleworld="export"]');
      const importRow = section.querySelector('[data-roleworld="import"]').closest('.settings-row').textContent;
      const aboutSection = document.querySelector('#settings-account');
      return {
        heading: section.querySelector('h2').textContent,
        summary, last,
        hasExport: !!exportBtn,
        hasImportRowText: importRow.indexOf('整份替换') >= 0,
        wipeInDanger: !!(danger && wipe && danger.contains(wipe)),
        exportOutsideDanger: !!(danger && exportBtn && !danger.contains(exportBtn)),
        aboutHasNoWipe: !aboutSection.querySelector('[data-roleworld="wipe"]'),
        aboutHasNoExport: !aboutSection.querySelector('[data-roleworld="export"]'),
      };
    })()`);
    assert(page.heading.indexOf('数据与备�?) >= 0, "这一页没改名�? + page.heading);
    assert(/角色 \d+ �?· 对话 \d+ �?· 记忆�?\d+ �?.test(page.summary), "概况数字没出来：" + page.summary);
    assert(page.summary.indexOf('角色 0 �?) < 0, "概况应当读到真实数量�? + page.summary);
    assert(/上次导出：|还没有导出过/.test(page.last), "最近一次导出的说明不对�? + page.last);
    assert(page.hasExport, "数据与备份页里没有导出按�?);
    assert(page.hasImportRowText, "导入那一行没写清是「整份替换」：" + page.hasImportRowText);
    assert(page.wipeInDanger, "「清空本机数据」没有放进危险区");
    assert(page.exportOutsideDanger, "导出按钮不该放在危险区里");
    assert(page.aboutHasNoWipe && page.aboutHasNoExport, "关于页里还留着导出/清空，等于两个入�?);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
  });

  /* ------------------------------------------------------------------ *
   * 定制角色（自己建的那种）
   *
   * 2026-09-14 用户拍板之后，语音只给「定制角�?+ 伴侣模式 + 软件聊天」，
   * 而内置包里的 6 张小说卡**一张都不能**。所以下面这些用例必须先有一个真的定制角�?—�?   * 走应用自己的导入接口建（跟用户在界面上点「导入角色文件」是同一条路），
   * 不是往数据库里塞一条假记录�?   * ------------------------------------------------------------------ */

  const MY_AVATAR = "林默.png";
  const MY_NAME = "林默";
  const MY_CHAT = "林默-聊天软件";

  async function ensureCustomCharacter() {
    const exists = await evaluate(`(async () => (await RoleWorld.store.listCharacters()).some((c) => c.avatar === ${JSON.stringify(MY_AVATAR)}))()`);
    if (!exists) {
      const created = await evaluate(`(async () => {
        const card = {
          spec: "chara_card_v2", spec_version: "2.0",
          data: {
            name: ${JSON.stringify(MY_NAME)},
            description: "自己建的角色：安静、话少，习惯用聊天软件回话�?,
            personality: "话少，句子短�?,
            scenario: "手机上的一对一聊天�?,
            first_mes: "在�?,
            mes_example: "",
            tags: [],
          },
        };
        const file = new File([JSON.stringify(card)], ${JSON.stringify(MY_NAME + ".json")}, { type: "application/json" });
        // �?导入接口挂在 STApi 上（界面上「导入角色文件」走的就是它），不在 RoleWorld 上�?        const result = await window.STApi.importCharacter(file, "json");
        return result && result.avatar;
      })()`);
      assert(created === MY_AVATAR, "导入定制角色之后拿到�?avatar 不对�? + created);
      // 导入之后整页重载：会话表是按**角色注册�?*列出来的，而注册表是启动时建的
      //（真人导入后界面会自己刷新列表，测试里用整页加载保证注册表是新的）�?      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
    }
    // 造一段对话并切过去（会话�?+ 真实切换入口）�?    await openChatFor(MY_AVATAR, MY_NAME, MY_CHAT);
    return MY_AVATAR;
  }

  /** 给这个定制角色打开伴侣模式，并把聊天方式设成「软件聊天（不带动作）」——语音的两道门槛�?*/
  async function enableCompanionPlain(avatar) {
    // �?走应用自己的保存入口（TASK21.saveCompanion，界面上那个保存按钮调的就是它）�?    //   不是往 kv 里直接写：直接写会绕过同步缓存，�?这个角色能不能发语音"�?*同步**读缓存的 —�?    //   结果就是"档案明明开着，菜单里却没有朗�?（排查起来极费劲，探针里真踩到过）�?    const done = await evaluate(`(async () => {
      const entry = { avatar: ${JSON.stringify(avatar)}, charName: ${JSON.stringify(MY_NAME)} };
      const previous = await window.TASK21.loadCompanion(entry);
      const next = Object.assign({}, previous, { enabled: true, relation: 'partner', chatStyle: 'plain' });
      await window.TASK21.saveCompanion(entry, next);
      const check = await window.TASK21.loadCompanion(entry);
      return !!(check && check.enabled === true && check.chatStyle === 'plain');
    })()`);
    assert(done, "没能给定制角色打开伴侣 + 软件聊天");
    return done;
  }

  await check("伴侣模式开关就在角色自己那一行：定制角色能给谁开点谁，内置小说人物这一�?*不给开**", async () => {
    // 用户 2026-09-13：「现在的是什么当前角色啥的我要做到每个角色本身的上面」�?    // 用户 2026-09-14 又拍板：「小说人物不设置伴侣」——所以这条用例现在盯两件事：
    //   �?定制角色：每一行都有开关，�?*非当�?*角色打开不会影响当前角色，能开也能关；
    //   �?内置小说人物：那一�?*是禁用的**，写明原因；就算有人绕过界面把状态塞进去�?    //      也不该写进档案（下面�?绕过界面"那一步就是在验这道闸）�?    const friend = await ensureCustomCharacter();
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate("window.TASK25C_UI.setSettingsSection('characters'); true");
    await waitFor("document.querySelectorAll('#characterManageList .character-manage-row').length >= 2", 10000);
    // 等每一行都读完自己的档案（能点的行会从 disabled 变成 false）—�?    // 直接断言会读�?还没读完"的中间态，那是假红�?    await waitFor(`(function () {
      const boxes = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'));
      const builtin = ${JSON.stringify(BUILTIN_AVATARS)};
      return boxes.length >= 2 && boxes.filter((b) => builtin.indexOf(b.dataset.companionAvatar) < 0).every((b) => b.disabled === false);
    })()`, 10000);

    const rows = await evaluate(`(() => Array.from(document.querySelectorAll('#characterManageList .character-manage-row')).map((row) => {
      const box = row.querySelector("[data-companion-avatar]");
      const strong = row.querySelector('.character-manage-head strong');
      const label = row.querySelector('.character-manage-companion');
      return {
        name: strong ? strong.textContent : '',
        avatar: box ? box.dataset.companionAvatar : '',
        hasSwitch: !!box,
        disabled: box ? box.disabled === true : true,
        checked: box ? box.checked === true : null,
        text: label ? label.textContent.trim() : '',
        title: label ? label.title : '',
      };
    }))()`);
    assert(rows.length >= 2, "角色管理里应当至少两个角色：" + JSON.stringify(rows));
    assert(rows.every((row) => row.hasSwitch), "有角色这一行没有「伴侣模式」开关：" + JSON.stringify(rows));
    assert(rows.every((row) => row.text.indexOf("伴侣模式") >= 0), "开关文案不对：" + JSON.stringify(rows.map((r) => r.text)));

    // �?内置小说人物：禁�?+ 写清为什�?+ 不许是开着�?    const builtinRows = rows.filter((row) => BUILTIN_AVATARS.indexOf(row.avatar) >= 0);
    assert(builtinRows.length >= 6, "内置包那 6 张卡没有都列出来�? + JSON.stringify(rows.map((r) => r.avatar)));
    for (const row of builtinRows) {
      assert(row.disabled === true, row.name + " 是内置小说人物，这一行不该能点：" + JSON.stringify(row));
      assert(row.checked === false, row.name + " 是内置小说人物，开关却是开着�?);
      assert(row.text.indexOf("内置角色不可�?) >= 0, row.name + " 这一行没写清为什么不能开�? + row.text);
      assert(row.title.indexOf("内置") >= 0, row.name + " 没给出原因（title 是空的或没说清）�? + row.title);
    }
    // �?定制角色：能�?    const customRow = rows.find((row) => row.avatar === friend);
    assert(customRow, "刚导入的定制角色没有出现在角色管理里�? + JSON.stringify(rows.map((r) => r.avatar)));
    assert(customRow.disabled === false, "定制角色的伴侣开关应当是能点的：" + JSON.stringify(customRow));

    // �?绕过界面（有人用脚本直接�?checked + 派发 change）也不该写进内置角色的档�?—�?    //    这验的是"闸在写入口，不只画在界面�?�?    const bypass = await evaluate(`(async () => {
      const box = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'))
        .find((node) => node.dataset.companionAvatar === ${JSON.stringify("Harry Potter (EN).png")});
      if (!box) return { ok: false, error: '找不到内置角色那一�? };
      box.disabled = false;          // 绕开 disabled
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const stored = await RoleWorld.store.getKV("companion:" + ${JSON.stringify("Harry Potter (EN).png")}, null);
      return { ok: true, stored, checkedBack: box.checked, toast: (document.querySelector('#toast') || {}).textContent || '' };
    })()`);
    assert(bypass.ok, JSON.stringify(bypass));
    assert(bypass.stored === null, "绕过界面之后，内置角色的档案还是被写进去了：" + JSON.stringify(bypass.stored));
    assert(bypass.checkedBack === false, "被拒绝之后开关没有退回来（界面在骗人）：" + JSON.stringify(bypass));
    assert(bypass.toast.indexOf("内置") >= 0, "拒绝的时候没有说清原因：" + bypass.toast);

    // �?定制角色：给**非当�?*对话的那个开，不会牵动当前角色；能开也能关�?    const current = (await activeCharacterName()) || "";
    const other = await evaluate(`(async () => {
      const box = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'))
        .find((node) => node.dataset.companionAvatar === ${JSON.stringify(friend)});
      const before = box.checked;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const profile = await window.TASK21.loadCompanion({ avatar: ${JSON.stringify(friend)} });
      return { before, stored: profile && profile.enabled === true, toast: (document.querySelector('#toast') || {}).textContent || '' };
    })()`);
    assert(other.stored === true, "在角色那一行打开伴侣模式没有落盘�? + JSON.stringify(other));
    assert(other.toast.indexOf(MY_NAME) >= 0 || other.toast.indexOf("伴侣模式") >= 0,
      "打开之后没给出反馈：" + other.toast);
    const untouched = await evaluate(`(async () => {
      const who = ${JSON.stringify(current)};
      const box = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'))
        .find((node) => {
          const strong = node.closest('.character-manage-row').querySelector('.character-manage-head strong');
          return strong && who && strong.textContent.indexOf(who) >= 0;
        });
      return box ? box.checked : null;
    })()`);
    if (current && current !== MY_NAME) {
      assert(untouched === false, "给别的角色开伴侣模式，把当前角色也带开了：" + untouched);
    }

    // 收尾：关回去（后面的用例假定它没开），别影响别的用例�?    await evaluate(`(async () => {
      const box = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'))
        .find((node) => node.dataset.companionAvatar === ${JSON.stringify(friend)});
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`);
    const closed = await evaluate(`(async () => (await window.TASK21.loadCompanion({ avatar: ${JSON.stringify(friend)} })).enabled === true)()`);
    assert(closed === false, "关回去没生效");
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
  });

  await check("消息菜单：每条消息都有入口，手机上不用悬停也点得到，复制真的复制到了", async () => {
    await goto(base + "/index.html?onboarding=off&surprise=off");
    await waitFor("window.TASK21_READY === true", 30000);
    // 这一条自带端点设置：前面的用例可能把服务�?地址留在别的状态（比如体验卡那条）�?    // 用这里明确指定的假端点，别让本轮测试依赖"上一条留下的状�?�?    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash", card_relay: "" });
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions" } }));
      return true;
    })()`);
    // 先造出两轮对话（用户消�?+ 角色回复）。清空待用队列，保证这一轮拿到的是我们指定的那句�?    await fetch(base + "/__reply-clear", { method: "POST" });
    await evaluate(`fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '第一版回答�? }) }).then(() => true)`);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '第一条消�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const diag = await evaluate(`(() => ({
      url: location.pathname,
      rows: document.querySelectorAll('#dynamicMessages .message-row').length,
      failures: document.querySelectorAll('.turn-failure').length,
      toast: (document.querySelector('#toast') || {}).textContent || '',
      status: (document.querySelector('#chatListStatusText') || {}).textContent || '',
      inputDisabled: !!document.querySelector('#messageInput').disabled,
      errors: (document.querySelector('#dynamicMessages').textContent || '').slice(0, 120),
    }))()`);
    assert(diag.rows >= 2, "没造出两轮对话�? + JSON.stringify(diag));

    // �?每条消息旁边都要有操作入口（这是"把操作放在消息旁�?的最低要求）�?    const rows = await evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      return all.map((row) => ({
        hasMenu: !!row.querySelector('.message-menu-button'),
        index: row.dataset.messageIndex || '',
        isUser: row.classList.contains('message-row-user'),
      }));
    })()`);
    assert(rows.length >= 2, "没造出两轮对话�? + JSON.stringify(rows));
    assert(rows.every((row) => row.hasMenu), "有消息没有操作入口：" + JSON.stringify(rows));
    assert(rows.every((row) => row.index !== ""), "消息没有记下自己的位置（编辑/重答/分支都要用它）：" + JSON.stringify(rows));

    // �?手机（窄屏）不依赖悬停：按钮要看得见、点得着�?    await cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const mobile = await evaluate(`(() => {
      const button = document.querySelector('#dynamicMessages .message-menu-button');
      const r = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const top = document.elementFromPoint(cx, cy);
      return {
        w: Math.round(r.width), h: Math.round(r.height), opacity: Number(style.opacity),
        reachable: !!(top && (top === button || button.contains(top))),
      };
    })()`);
    assert(mobile.opacity >= 0.5, "手机上操作入口是透明的（等于只能悬停）：" + JSON.stringify(mobile));
    assert(mobile.w >= 16 && mobile.h >= 16, "手机上操作入口太小： " + JSON.stringify(mobile));
    assert(mobile.reachable, "手机上操作入口点不到�? + JSON.stringify(mobile));

    // �?真点开菜单 �?菜单项要对（用户消息：复�?编辑/从这里开分支）�?    const menu = await evaluate(`(() => {
      const userRow = document.querySelector('#dynamicMessages .message-row-user');
      userRow.querySelector('.message-menu-button').click();
      const box = userRow.querySelector('.message-menu');
      const items = Array.from(box.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction);
      const r = box.getBoundingClientRect();
      const inView = r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1;
      return { open: !box.hidden, items, inView, label: box.textContent };
    })()`);
    assert(menu.open, "点了 �?菜单没打开");
    assert(menu.items.join(",") === "copy,edit,branch", "用户消息的菜单项不对�? + menu.items.join(","));
    assert(menu.inView, "菜单跑到屏幕外了");

    // �?复制：走真点击，然后看剪贴板（拿不到剪贴板权限时退�?提示已复�?请手动复�?）�?    const copied = await evaluate(`(async () => {
      const userRow = document.querySelector('#dynamicMessages .message-row-user');
      userRow.querySelector('.message-menu-button').click();
      const item = userRow.querySelector("[data-message-action='copy']");
      item.click();
      await new Promise((r) => setTimeout(r, 300));
      let clip = '';
      try { clip = await navigator.clipboard.readText(); } catch (_) { clip = ''; }
      const toast = document.querySelector('#toast').textContent || '';
      return { clip, toast, menuClosed: userRow.querySelector('.message-menu').hidden };
    })()`);
    assert(copied.menuClosed, "点完菜单项菜单没�?);
    assert(copied.clip === "第一条消�? || copied.toast.indexOf("复制") >= 0,
      "复制既没进剪贴板也没给提示：" + JSON.stringify(copied));

    // �?助手的消息菜单项不一样：重新回答 + 从这里开分支�?    const assistantMenu = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row')).find((n) => !n.classList.contains('message-row-user'));
      row.querySelector('.message-menu-button').click();
      const items = Array.from(row.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction);
      row.querySelector('.message-menu-button').click();
      return items;
    })()`);
    // 助手的菜单比用户多两项：重新回答（用户没有）、以�?*朗读**�?    // 朗读现在�?*两条**同时满足：全局就绪（打开角色语音 + 在用体验�?+ 中转配了语音�?    // **并且这个角色有资�?*（定制角�?+ 伴侣 + 软件聊天）�?    // 这一条用例里的角色是刚导入的定制角色、并且没开伴侣 —�?所以朗读不该出现，
    // 期望值是固定的。按页面自报的能力决定期望值会掩盖这条新规则（以前就是这么写的）�?    const menuState = await evaluate("window.__rwVoiceMenuState ? window.__rwVoiceMenuState() : null");
    assert(menuState, "没有自检出口 __rwVoiceMenuState —�?菜单那两条判定应当能读到");
    assert(menuState.character && menuState.character.allowed === false,
      "这个角色（定制角色、没开伴侣）不该被判成能发语音�? + JSON.stringify(menuState));
    assert(
      assistantMenu.join(",") === "copy,regenerate,branch",
      "助手消息的菜单项不对：实�?" + assistantMenu.join(",")
        + "（这个角色没有语音资格，不该出现「朗读」）",
    );

    // 真机反馈的回归（2026-09-14，用户："只有复制、重新回答、从这里开分支，没有朗�?）：
    // 手机上的原生语音桥是**外壳�?Activity 起来之后才挂上页面的**（要重试几秒），
    // 而历史消息在页面加载时就渲染完了 —�?那时能力还是 false�?    // 那一轮的原生桥已经不做（语音改成只走云端），�?*同一个教训还�?*�?    // "能力"是异步探测出来的（要问一次中转），历史消息早就渲染完了�?    // 所以菜单必�?*每次打开时现�?*，而不是渲染时定死�?    // �?正面那条（能力晚到之后菜单里真的出现朗读）在「角色语音」那条用例里�?—�?    //   那边有真的能发语音的角色；这里只能验"谎报能力也变不出朗读"�?    const lateCapability = await evaluate(`(async () => {
      // 只替�?*能力的输�?*（capability 的返回值），菜单逻辑本身一行没�?—�?      // 这样测的才是"菜单是打开时现算的"，而不�?探测链路的某一�?�?      const Cloud = window.RoleWorldVoiceCloud;
      const real = Cloud.capability;
      const row = Array.from(document.querySelectorAll("#dynamicMessages .message-row"))
        .find((n) => !n.classList.contains("message-row-user"));
      const btn = row.querySelector(".message-menu-button");
      const read = () => Array.from(row.querySelectorAll(".message-menu-item")).map((n) => n.dataset.messageAction);
      Cloud.capability = () => ({ canSpeak: false, reason: "还没探测回来", speakers: [] });
      btn.click();
      const withoutCapability = read();
      btn.click();
      // 能力"到了" —�?但这个角色没资格，所以仍然不该有朗读
      Cloud.capability = () => ({ canSpeak: true, reason: "", speakers: [{ id: "x", label: "x" }] });
      btn.click();
      const withCapability = read();
      btn.click();
      Cloud.capability = real;
      return { withoutCapability, withCapability, hasCloud: typeof Cloud.capability };
    })()`);
    assert(
      lateCapability.withoutCapability.indexOf("speak") < 0,
      "还没打开角色语音时不该出现「朗读」：" + JSON.stringify(lateCapability.withoutCapability),
    );
    assert(
      lateCapability.withCapability.indexOf("speak") < 0,
      "这个角色没有语音资格，却因为「能力可用」就冒出了「朗读」—�?说明菜单只看了全局能力�?
        + JSON.stringify(lateCapability),
    );

    // �?内置小说人物**永远**没有朗读（用�?2026-09-14：「小说人物不设置语音」）�?    //    这一步故意把"能力"谎报成可用：菜单里仍然不该出现朗�?—�?资格是按**这个角色**判的�?    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊�?);
    await waitFor("document.querySelectorAll('#dynamicMessages .message-row-assistant').length >= 1", 10000);
    const builtinBlocked = await evaluate(`(async () => {
      const Cloud = window.RoleWorldVoiceCloud;
      const real = Cloud.capability;
      Cloud.capability = () => ({ canSpeak: true, reason: "", speakers: [{ id: "x", label: "x" }] });
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      row.querySelector('.message-menu-button').click();
      const items = Array.from(row.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction);
      row.querySelector('.message-menu-button').click();
      Cloud.capability = real;
      return { items, state: window.__rwVoiceMenuState ? window.__rwVoiceMenuState() : null };
    })()`);
    assert(builtinBlocked.items.indexOf("speak") < 0,
      "内置小说人物的菜单里出现了朗读：" + JSON.stringify(builtinBlocked.items));
    assert(builtinBlocked.state && builtinBlocked.state.canSpeak === false,
      "内置角色不该被判成能发语音：" + JSON.stringify(builtinBlocked.state));
    assert(builtinBlocked.state.character && builtinBlocked.state.character.reason.indexOf("内置") >= 0,
      "没说清内置小说人物为什么没有语音：" + JSON.stringify(builtinBlocked.state.character));
    // 「这一轮发语音」那个开关：内置角色这里必须�?*看得见的禁用**（不是藏起来），
    // 而且点一下要把原因说出来 —�?藏起来等于没有，这是用户教过好几次的�?    const builtinToggle = await evaluate(`(() => {
      const button = document.querySelector('#replyVoiceToggle');
      if (!button) return { ok: false, error: '没有那个开�? };
      const before = (document.querySelector('#toast') || {}).textContent || '';
      button.click();
      return { ok: true, hidden: button.hidden, disabled: button.disabled, title: button.title,
               pressed: button.getAttribute('aria-pressed'), toastBefore: before };
    })()`);
    assert(builtinToggle.ok, JSON.stringify(builtinToggle));
    assert(builtinToggle.hidden === false && builtinToggle.disabled === true,
      "内置角色这里，开关应当是看得见但禁用的：" + JSON.stringify(builtinToggle));
    assert(/语音/.test(builtinToggle.title) && builtinToggle.title.length > 10, "禁用时没写清原因�? + builtinToggle.title);
    assert(builtinToggle.pressed === "false", "内置角色不该被切到发语音�? + JSON.stringify(builtinToggle));
    await cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
  });

  await check("设置 �?连接方式：选「使用体验卡」必�?*看得见填卡号的地�?*", async () => {
    // 用户 2026-09-14 实测：「而且选择方式的时候，没有填卡号的地方」�?    // 真因：点「使用体验卡」时只写了一�?粘到下面的输入框"，却**从来没把那一块显示出�?*
    // �?connectionCardBlock 一�?hidden），�?focus 了一个看不见的框�?    // 线上 0.1.54 也有这个问题 —�?所以这条用例钉的是用户真实会走的路径�?    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    // 造一�?没在用卡"的干净状�?    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "" });
      await RoleWorld.secrets.remove("api_key_custom");
      return true;
    })()`);
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click(); true");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate("window.TASK25C_UI.setSettingsSection('connection'); true");
    await sleep(600);

    const result = await evaluate(`(async () => {
      const cardRadio = document.querySelector("[data-roleworld='connection-card']");
      const block = document.querySelector('#connectionCardBlock');
      const before = { blockHidden: block ? block.hidden : null };
      cardRadio.click();
      await new Promise((r) => setTimeout(r, 700));
      const input = document.querySelector("[data-roleworld='card']");
      const rect = input ? input.getBoundingClientRect() : null;
      const cx = rect ? Math.round(rect.left + rect.width / 2) : 0;
      const cy = rect ? Math.round(rect.top + rect.height / 2) : 0;
      const top = rect ? document.elementFromPoint(cx, cy) : null;
      return {
        before,
        blockHidden: block ? block.hidden : null,
        inputVisible: !!(rect && rect.width > 0 && rect.height > 0),
        // �?看得�?不够：看得见点不到也是白搭（这个项目踩过好几次）�?        reachable: !!(top && input && (top === input || input.contains(top))),
        blockedBy: (top && input && top !== input && !input.contains(top))
          ? (top.tagName + "." + String(top.className || "").split(" ")[0]) : "",
        placeholder: input ? input.placeholder : "",
        checked: cardRadio.checked,
        status: (document.querySelector('[data-roleworld="connection-status"]') || {}).textContent || "",
      };
    })()`);
    assert(result.before.blockHidden === true, "前置条件不成立：还没选体验卡，那一块就已经露出来了");
    assert(result.blockHidden === false, "选了「使用体验卡」，填卡号的那一块还是隐藏的（用户：没有填卡号的地方�?);
    assert(result.inputVisible, "卡号输入框没有尺寸（看不见）�? + JSON.stringify(result));
    assert(result.reachable, "卡号输入框看得见但点不到�? + JSON.stringify(result));
    assert(/RW-/.test(result.placeholder), "输入框提示要告诉用户粘什么：" + result.placeholder);
    assert(result.checked, "点完之后单选没切到「使用体验卡」：" + JSON.stringify(result));
    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
    await sleep(300);
  });

  /**
   * �?能朗�?的三个条件一次凑齐（带卡整页打开 �?打开角色语音并同意）�?   * 两条语音用例都用它，免得互相依赖执行顺序 —�?那种依赖最难查�?   *
   * �?**不许在这里手动调 VoiceCloud.refresh()**。第一版就是那么写的，
   * 结果�?从没探测�?�?开关不出现"这条真实路径整个绕过去了�?   * 用户打开应用看到的是一行都没有的「回复偏好」，而测试全绿�?   * 这里必须只用**应用自己的启动流�?*（带 #card= 打开）�?   *
   * �?用完必须�?closeAppWithVoice()：带卡进页面会把接口整体指向中转�?   * 而后面那�?直连模型"的用例（失败重试等）就再也打不到假模型端点了�?   */
  /**
   * 把还在屏幕上的引导层走完（带卡进来时会弹「体验卡开场」）�?   *
   * �?为什么必须显式做这一步：那一层是**铺满屏幕、中心点命中它自�?*的（`.rw-ob`），
   *   它开着的时候底下的任何东西�?看得见但点不�?�?026-09-14 加语音气泡的可达性检查时
   *   才发现：这条链路以前一直是**顶着引导�?*在跑的，只是恰好没点在被盖住的位置�?   *   真人会先点完开�?—�?测试也照做，别再让可达性断言活在一个用户看不到的布局里�?   */
  async function dismissOnboarding() {
    const still = await evaluate(`(async () => {
      for (let i = 0; i < 12; i += 1) {
        const overlay = document.querySelector('.rw-ob');
        if (!overlay) return false;
        const next = overlay.querySelector('[data-ob="next"]');
        if (!next) return true;
        next.click();
        await new Promise((r) => setTimeout(r, 240));
      }
      return !!document.querySelector('.rw-ob');
    })()`);
    return still;
  }

  async function openAppWithVoice(options) {
    const opts = options || {};
    const wantEnabled = opts.enable !== false;
    // �?卡号格式�?RW-5-5-5（`RW-AAAAA-BBBBB-CCCCC`）。以前这里写成过 6 �?B�?    //   parseCardInput 的正则不匹配 �?卡整个没被用�?�?语音那一行当然不出现�?    //   教训：这条用例本来就是为了抓"用户看到的真实路�?，结果自己先把输入弄错了�?    // �?先记�?体验卡开场看过了"：那层引�?*铺满屏幕、中心点命中它自�?*�?    //   开着的时候底下什么都点不到（2026-09-14 加语音气泡可达性检查时才发现：
    //   这条链路以前一直顶着引导层在跑）。真人点完开场才开始用 —�?测试也照做�?    await evaluate("(function(){ try { localStorage.setItem('card_welcome_seen','1'); } catch(_) {} return true; })()");
    await goto(base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay");
    // �?必须再整页加载一次：`#card=…` �?*片段地址**，浏览器只做同文档导航、不会重新加载，
    //   于是 RoleWorld.init() 里那�?自动应用�?根本不会跑（卡没配上，语音自然全灭）�?    //   真人的动作是"在新标签页打开这条链接"，那本来就是一次完整加�?—�?所以这里是还原真实场景�?    //   不是给测试打补丁。（这个坑项目里踩过：见上面那条体验卡开场的用例。）
    await cdp.sessionSend(session, "Page.reload");
    await sleep(400);
    await waitFor("window.TASK21_READY === true", 30000);
    const stuck = await dismissOnboarding();
    if (stuck) console.log("        （提示：体验卡开场没走完，界面可能被引导层盖住）");
    // 等应用自己把语音能力探测**做完**（不�?中转地址回来�?就完�?—�?    // 那只�?refresh() 的第一步，enabled 还没写、事件也还没发，
    // 此时读「角色语音」那一行必然是隐藏的，会假红一次）�?    // 超时要能看出"到底卡在哪一�?：只报一�?等待超时"等于要重跑一遍才能查�?    try {
      await waitFor("(function(){ var c = window.RoleWorldVoiceCloud.capability(); return c.checked === true && c.relay !== ''; })()", 15000);
    } catch (error) {
      const diag = await evaluate(`(async () => {
        const card = await window.RoleWorldCard.currentState().catch((e) => ({ error: String(e && e.message) }));
        const settings = await window.RoleWorld.getLocalSettings().catch(() => ({}));
        const cloud = window.RoleWorldVoiceCloud;
        return {
          location: location.href,
          hasCloud: !!cloud,
          snapshot: cloud ? cloud.snapshot() : null,
          card: card,
          cardKnown: window.RoleWorldCard && window.RoleWorldCard.knownResult ? window.RoleWorldCard.knownResult() : null,
          cardParsed: window.RoleWorldCard && window.RoleWorldCard.parseCardInput ? window.RoleWorldCard.parseCardInput(location.href) : null,
          parseDirect: window.RoleWorldCard && window.RoleWorldCard.parseCardInput
            ? window.RoleWorldCard.parseCardInput('RW-AAAAA-BBBBBB-CCCCC@http://127.0.0.1:2893/relay') : null,
          tokenRe: /RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/i.test('RW-AAAAA-BBBBBB-CCCCC'),
          hashSlice: location.href.slice(location.href.indexOf('#')),
          settings: { provider: settings.provider, endpoint: settings.endpoint, card_relay: settings.card_relay, voice_enabled: settings.voice_enabled },
          onboarding: !!document.querySelector('.rw-ob'),
          overlayText: (function () { const o = document.querySelector('.rw-ob'); return o ? o.textContent.slice(0, 60) : ''; })(),
        };
      })()`).catch((e) => ({ evaluateError: String(e && e.message) }));
      throw new Error("语音能力探测没做完。现场：" + JSON.stringify(diag));
    }
    const state = await evaluate(`(async () => {
      const rowVisible = (function () { const row = document.querySelector('#voiceEnabledRow'); return !!row && row.hidden === false; })();
      const settings = await window.RoleWorld.getLocalSettings();
      if (${wantEnabled} && settings.voice_enabled !== true) {
        document.querySelector('[data-action="open-settings"]').click();
        await new Promise((r) => setTimeout(r, 400));
        window.TASK25C_UI.setSettingsSection('voice');
        await new Promise((r) => setTimeout(r, 300));
        const box = document.querySelector('[data-roleworld="voice-enabled"]');
        if (!box) return { canSpeak: false, reason: '设置里找不到「角色语音」开�?, speakers: 0, rowVisible };
        box.click();
        await new Promise((r) => setTimeout(r, 350));
        const dialog = document.querySelector('.rw-consent');
        if (dialog) dialog.querySelector('[data-voice-consent="accept"]').click();
        await new Promise((r) => setTimeout(r, 1200));
      }
      document.querySelector('[data-action="close-settings"]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      const cap = window.RoleWorldVoiceCloud.capability();
      const cardState = await window.RoleWorldCard.currentState();
      const now = await window.RoleWorld.getLocalSettings();
      return {
        canSpeak: cap.canSpeak, reason: cap.reason, speakers: cap.speakers.length, relay: cap.relay, rowVisible,
        // 诊断用：万一那一行没出现，要能一眼看出卡到底有没有被用上、探测跑没跑�?        diag: {
          snapshot: window.RoleWorldVoiceCloud.snapshot(),
          cardActive: cardState.active, cardRelay: cardState.relay,
          settingsRelay: now.card_relay, provider: now.provider, endpoint: now.endpoint,
        },
      };
    })()`);
    return state;
  }

  /**
   * 装一个可控的播放器替身�?   *
   * 为什么要有：无头浏览器里"真的出声"既听不到、也断言不了；而播放链路本�?   * （有没有播、有没有被停、用的是不是 blob 地址）正是要盯的东西�?   * 所以把 window.Audio 换成一个只记录状态的替身 —�?测的�?*我们的调�?*，不是浏览器的解码�?   *
   * �?�?*只对当前这一页有�?*：整页重载之后要重新装（�?⑨c）�?   */
  async function installFakeAudio() {
    await evaluate(`(() => {
      window.__rwAudioMode = 'instant';
      window.__rwAudioLog = [];
      window.Audio = function (src) {
        const record = { src, played: false, paused: false };
        window.__rwAudioLog.push(record);
        this.src = src;
        this.onended = null;
        this.onerror = null;
        this.play = () => {
          record.played = true;
          if (window.__rwAudioMode === 'hold') return new Promise(() => {});   // 永远不结束（"还在�?�?          setTimeout(() => { if (typeof this.onended === 'function') this.onended(); }, 0);
          return Promise.resolve();
        };
        this.pause = () => { record.paused = true; };
      };
      return true;
    })()`);
  }

  /** 把设置恢复成"直连假模型端�?（后面那些用例都按这个前提写的）�?*/
  async function closeAppWithVoice() {
    await evaluate(`(async () => {
      window.RoleWorldVoiceCloud.stop();
      await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", tutorial_seen: true, language_mode: "auto" });
      await RoleWorld.secrets.remove("api_key_custom");
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", language_mode: "auto" } }));
      await window.RoleWorldVoiceCloud.refresh({ force: true });
      return true;
    })()`).catch(() => {});
  }

  await check("设置 �?语音：只�?*能发语音的角�?*（定�?+ 伴侣 + 软件聊天），能单独挑音色并落�?, async () => {
    // 2026-09-14 用户拍板：「小说人物不设置语音�? 伴侣里只有「软件聊天」那一档能发语音�?    // 所以这一页现�?*只列合格的角�?* —�?摆一串永远发不出声的角色，用户会以为挑完就能听到�?    // 前置：先有一个真的定制角色，并给它打开伴侣 + 软件聊天�?    const eligibleAvatar = await ensureCustomCharacter();
    await enableCompanionPlain(eligibleAvatar);
    const ready = await openAppWithVoice();
    assert(ready.rowVisible, "带卡进去之后，「角色语音」那一行没出现�? + JSON.stringify(ready));
    assert(ready.canSpeak, "前置条件不成立：这台设备不能朗读 —�?" + ready.reason);
    reportErrors("语音设置�?);
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate("window.TASK25C_UI.setSettingsSection('voice'); true");
    // 正常情况�?setSettingsSection 会回调集成层去渲染角色列表；
    // �?切到这一�?�?渲染完成"之间是异步的，测试里不能假定已经好了�?    // 所以：先给它一点时间，还没出来就直接调一次渲染函数（同一个函数，不是替身）�?    await sleep(400);
    const rowsReady = await evaluate("document.querySelectorAll('#voiceVoiceList [data-voice-card]').length >= 1");
    if (!rowsReady) {
      await evaluate("(async () => { if (typeof window.__rwInvokeVoicePanel === 'function') await window.__rwInvokeVoicePanel(); return true; })()");
    }
    await waitFor("document.querySelectorAll('#voiceVoiceList [data-voice-card]').length >= 1", 10000);

    // �?只列合格的角色（这一档就是刚建的那个定制角色），每行都有云端音色下拉 + 语速滑杆�?    //    这一轮把"语�?音高两个滑杆"换成�?云端音色下拉 + 语�?�?    //    音高是本机系�?TTS 的参数，云端接口没有对应项，留着只会让人以为调了有用�?    const rows = await evaluate(`(() => Array.from(document.querySelectorAll('#voiceVoiceList [data-voice-card]')).map((row) => ({
      avatar: row.dataset.voiceCard,
      name: (row.querySelector('strong') || {}).textContent || '',
      sliders: Array.from(row.querySelectorAll('[data-voice-field]')).map((i) => i.dataset.voiceField),
      speakerOptions: Array.from(row.querySelectorAll('[data-voice-speaker] option')).map((o) => o.value),
      selected: (row.querySelector('[data-voice-speaker]') || {}).value || '',
      hasTest: !!row.querySelector('[data-voice-test]'),
      hasReset: !!row.querySelector('[data-voice-reset]'),
    })))()`);
    assert(rows.length === 1, "语音页应当只列那一个合格角色，实际 " + rows.length + " 行：" + JSON.stringify(rows.map((r) => r.avatar)));
    assert(rows[0].avatar === eligibleAvatar, "列出来的不是那个合格的定制角色：" + JSON.stringify(rows[0]));
    // **内置小说人物一个都不能出现**（用户拍板：小说人物不设置语音）�?    assert(rows.every((row) => BUILTIN_AVATARS.indexOf(row.avatar) < 0),
      "语音页里出现了内置小说人物：" + JSON.stringify(rows.map((r) => r.avatar)));
    for (const row of rows) {
      assert(row.sliders.indexOf("speechRate") >= 0, row.name + " 少了语速滑杆：" + JSON.stringify(row.sliders));
      assert(row.sliders.indexOf("pitch") < 0, row.name + " 还留着「音高」——云端没有这个参数，不该冒充�? + JSON.stringify(row.sliders));
      assert(row.speakerOptions.length >= VOICE_SPEAKERS.length, row.name + " 的音色下拉是空的�? + JSON.stringify(row.speakerOptions));
      assert(row.speakerOptions.indexOf(row.selected) >= 0, row.name + " 选中的音色不在选项里：" + row.selected);
      assert(row.hasTest, row.name + " 没有「试听」按�?);
      assert(row.hasReset, row.name + " 没有「恢复默认」按�?);
    }
    // 音色是按**角色**分的：这一行必须有一个默认音色（按角色算出来的稳定值）�?    assert(rows[0].selected, "这一行没有默认音色：" + JSON.stringify(rows[0]));

    // ①b 音色下拉**必须分组**�?026-09-14：音色表�?53 扩到 218 个，
    //     一个平铺的下拉里根本找不着东西）。这里用假中转的 4 个音色验分组结构本身 —�?    //     假中转没�?langLabel，正好顺带验�?只有 lang 时的回退"（线上旧版就是这个形状）�?    const grouping = await evaluate(`(() => {
      const select = document.querySelector('#voiceVoiceList [data-voice-speaker]');
      if (!select) return { groups: [], options: 0 };
      return {
        groups: Array.from(select.querySelectorAll('optgroup')).map((g) => g.label),
        options: select.querySelectorAll('option').length,
        // 每个 option 必须在某�?optgroup 里（不然分组等于没做�?        ungrouped: Array.from(select.querySelectorAll('option')).filter((o) => !o.closest('optgroup')).length,
      };
    })()`);
    assert(grouping.groups.length >= 1,
      "音色下拉没有分组（二百多个音色不分组没法挑）�? + JSON.stringify(grouping));
    assert(grouping.ungrouped === 0, "有选项没被分到组里�? + JSON.stringify(grouping));
    assert(grouping.groups.some((label) => /中文|英语|其他语言|自定�?.test(label)),
      "分组标签不对�? + JSON.stringify(grouping.groups));

    // �?给某个角色换一个音�?�?必须落盘�?settings.voice_by_card（而且是新形状：speaker/speechRate�?    const avatar = rows[0].avatar;
    const wanted = rows[0].speakerOptions.find((id) => id !== rows[0].selected) || rows[0].speakerOptions[0];
    const saved = await evaluate(`(async () => {
      const row = document.querySelector('[data-voice-card="' + ${JSON.stringify(avatar)} + '"]');
      const select = row.querySelector('[data-voice-speaker]');
      select.value = ${JSON.stringify(wanted)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const settings = await window.RoleWorld.getLocalSettings();
      const stored = (settings.voice_by_card || {})[${JSON.stringify(avatar)}] || null;
      return { stored, picked: select.value };
    })()`);
    assert(saved.stored, "换了音色但没有落盘到 voice_by_card");
    assert(saved.stored.speaker === wanted, "落盘的音色不对：" + JSON.stringify(saved.stored));
    assert(saved.stored.rate === undefined, "不该再写旧的 rate 字段�? + JSON.stringify(saved.stored));
    assert(saved.stored.pitch === undefined, "不该再写旧的 pitch 字段�? + JSON.stringify(saved.stored));
    // 页面重渲染后这个角色的选中项还应当是刚挑的那个（音色隔离：不能串到别人身上�?    await evaluate("(async () => { if (typeof window.__rwInvokeVoicePanel === 'function') await window.__rwInvokeVoicePanel(); return true; })()");
    const afterRerender = await evaluate(`(() => Array.from(document.querySelectorAll('#voiceVoiceList [data-voice-card]')).map((row) => ({
      avatar: row.dataset.voiceCard,
      selected: (row.querySelector('[data-voice-speaker]') || {}).value || '',
    })))()`);
    const mine = afterRerender.find((row) => row.avatar === avatar);
    assert(mine && mine.selected === wanted, "重渲染之后音色被串掉了：" + JSON.stringify(afterRerender));
    // 音色隔离�?*没资格的角色一个都不该出现在这一�?*（更不该冒出它们的音色）�?    assert(afterRerender.length === 1 && afterRerender[0].avatar === eligibleAvatar,
      "重渲染之后多出了别的角色（内置小说人物不该出现在语音页）�? + JSON.stringify(afterRerender));

    // �?「恢复默认」要把这个角色的覆盖清掉�?    // 顺序很关键："点按�?�?读回设置"必须�?*同一次页面执�?*�?—�?    // 分成两次 evaluate 时中间会插进重渲染和其它异步写，读到的可能是中间态�?    const cleared = await evaluate(`(async () => {
      const row = document.querySelector('[data-voice-card="' + ${JSON.stringify(avatar)} + '"]');
      const before = (await window.RoleWorld.getLocalSettings()).voice_by_card || {};
      row.querySelector('[data-voice-reset]').click();
      await new Promise((r) => setTimeout(r, 1000));
      const after = ((await window.RoleWorld.getLocalSettings()).voice_by_card || {})[${JSON.stringify(avatar)}] || null;
      return { hadBefore: !!before[${JSON.stringify(avatar)}], after };
    })()`);
    assert(cleared.hadBefore, "前置条件不成立：点恢复默认之前并没有存过这个角色的覆�?);
    assert(cleared.after === null,
      "点了「恢复默认」之后还留着覆盖（说明这个按钮的点击根本没送到处理器）�? + JSON.stringify(cleared));

    // ③b 「试听」也�?*真的点得�?*：点下去必须真的发一次合成请求�?    //     用户 2026-09-14 实测「试听的按钮根本点不动」——真因是那几个按钮的处理�?    //     挂在 #dynamicMessages（聊天区）的事件委托里，而设置面板在聊天�?*外面**�?    //     光断言"按钮�?是不够的（以前就是这么漏的）�?    const beforePreview = voiceRequests.length;
    const preview = await evaluate(`(async () => {
      document.querySelector('[data-voice-test]').click();
      for (let i = 0; i < 160 && !(document.querySelector('#voiceStatus') && document.querySelector('#voiceStatus').hidden === false); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 600));
      const status = document.querySelector('#voiceStatus');
      return { statusText: status ? status.textContent : '', statusShown: status ? !status.hidden : null };
    })()`);
    assert(voiceRequests.length > beforePreview,
      "点了「试听」却没有发合成请�?—�?这个按钮点不动：" + JSON.stringify(preview));
    const previewCall = voiceRequests[voiceRequests.length - 1];
    assert(VOICE_SPEAKERS.some((one) => one.id === previewCall.speaker),
      "试听用的音色不对�? + JSON.stringify(previewCall));

    // ③c 一个合格角色都没有时，这一页要说清**为什么没有、去哪儿开** —�?    //     不能只留一片空白（用户会以为功能坏了）。这里把伴侣模式临时关掉来造这个现场�?    const emptyState = await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const key = "companion:" + ${JSON.stringify(eligibleAvatar)};
      const current = (await RoleWorld.store.getKV(key, null)) || {};
      await RoleWorld.store.setKV(key, core.normalizeProfile(Object.assign({}, current, { enabled: false })));
      if (typeof window.__rwInvokeVoicePanel === 'function') await window.__rwInvokeVoicePanel();
      await new Promise((r) => setTimeout(r, 600));
      const list = document.querySelector('#voiceVoiceList');
      const empty = document.querySelector('#voiceListEmpty');
      const text = empty ? empty.textContent : '';
      const result = {
        rows: list ? list.querySelectorAll('[data-voice-card]').length : -1,
        emptyShown: empty ? empty.hidden === false : null,
        text,
      };
      // 还原现场：把伴侣模式开回去（后面那条用例还要用它）�?      await RoleWorld.store.setKV(key, core.normalizeProfile(Object.assign({}, current, { enabled: true, chatStyle: 'plain' })));
      if (typeof window.__rwInvokeVoicePanel === 'function') await window.__rwInvokeVoicePanel();
      await new Promise((r) => setTimeout(r, 500));
      return result;
    })()`);
    assert(emptyState.rows === 0, "伴侣关掉之后语音页还在列角色�? + JSON.stringify(emptyState));
    assert(emptyState.emptyShown === true, "一个合格角色都没有时没有给出说明：" + JSON.stringify(emptyState));
    assert(emptyState.text.indexOf("伴侣") >= 0 && emptyState.text.indexOf("软件聊天") >= 0,
      "说明里要写清去哪儿开（伴�?+ 软件聊天）：" + emptyState.text);
    const restored = await evaluate("document.querySelectorAll('#voiceVoiceList [data-voice-card]').length");
    assert(restored === 1, "把伴侣模式开回去之后，语音页应当又列出这个角色：" + restored);

    // 收尾：把设置面板关掉�?    // 为什么必须有这一步：设置面板是覆盖在整个界面上的浮层，留着不关�?    // 后面那些"点聊天区某个按钮"的用例点到的就是设置面板里的元素 —�?    // 症状�?重试按钮看得见但点不�?，而原因跟重试按钮毫无关系（踩过）�?    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
    await sleep(300);
    await closeAppWithVoice();
  });

  await check("角色语音：只有定制人�?+ 伴侣 + 软件聊天才有朗读；同�?�?真合成真播放 �?不重复请�?�?切角色取�?, async () => {
    // �?默认必须�?*�?*的：会出声的功能不该默认打开�?    //    先造一�?从没打开过语音的�?（前一条用例可能已经把它打开了），再整页重载�?    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ voice_enabled: false, voice_consent_at: null }); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    reportErrors("角色语音");
    try {
    // �?前置：真的有一�?*合格**的角色（定制角色 + 伴侣 + 软件聊天）�?    //    2026-09-14 用户拍板之后，内置小说人物、以及伴侣里�?带动�?那一档都没有语音 —�?    //    这条用例必须跑在合格的角色上，否则测得是"根本没有朗读"�?    await ensureCustomCharacter();
    await enableCompanionPlain(MY_AVATAR);
    const eligibility = await evaluate("window.__rwVoiceMenuState ? window.__rwVoiceMenuState() : null");
    assert(eligibility && eligibility.character && eligibility.character.allowed === true,
      "前置条件不成立：这个定制角色应当有语音资�?—�?" + JSON.stringify(eligibility));
    const initial = await evaluate(`(() => ({
      enabled: (window.__rwVoiceSettingsSnapshot || {}).voice_enabled === true,
      canSpeak: window.RoleWorldVoiceCloud.capability().canSpeak,
      hint: window.RoleWorldVoiceCloud.capability().reason,
    }))()`);
    assert(initial.enabled === false, "角色语音不该默认打开");
    assert(initial.canSpeak === false, "没打开时不该说能朗�?);

    // ①b **在「设�?�?语音」那一页就要看得见这个开�?*�?    //     用户 2026-09-14 反馈「角色语音根本没有」——真因是：侧栏明明有一页叫「语音」，
    //     开关却被放在「记忆」里，那一页只有音色列表、一个开关都没有�?    //     �?这条用例以前是假绿的：它�?`querySelector('#voiceEnabledRow')` �?`hidden`�?    //     �?`querySelector` **对隐藏面板里的元素照样命�?*�?    //     更糟的是它调�?`setSettingsSection('model')` 这个分区**根本不存�?*（会回退�?外观"）�?    //     现在改成：真的切到「语音」页，并且要求那一行在**活动面板�?*、中心点也点得到�?    const noCard = await evaluate(`(async () => {
      document.querySelector('[data-action="open-settings"]').click();
      await new Promise((r) => setTimeout(r, 400));
      window.TASK25C_UI.setSettingsSection('voice');
      await new Promise((r) => setTimeout(r, 500));
      const panel = document.querySelector('[data-settings-panel="voice"]');
      const row = panel ? panel.querySelector('#voiceEnabledRow') : null;
      const box = row ? row.querySelector('input[type="checkbox"]') : null;
      const note = (row ? row.querySelector('#voiceEnabledNote') : null) ? row.querySelector('#voiceEnabledNote').textContent : '';
      const rect = row ? row.getBoundingClientRect() : null;
      // "看得�?要按用户的标准：在活动面板里 + 有尺�?+ 中心点命中它自己
      const inActivePanel = !!(panel && panel.classList.contains('is-active'));
      const hasSize = !!(rect && rect.width > 0 && rect.height > 0);
      const top = hasSize ? document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + 20)) : null;
      const hit = !!(top && row && (top === row || row.contains(top)));
      document.querySelector('[data-action="close-settings"]')?.click();
      await new Promise((r) => setTimeout(r, 300));
      return {
        inActivePanel, hasSize, hit,
        rowHidden: row ? row.hidden : null,
        disabled: box ? box.disabled : null,
        note,
      };
    })()`);
    assert(noCard.inActivePanel, "没能切到「语音」设置页（面板不是活动状态）");
    assert(noCard.rowHidden === false && noCard.hasSize && noCard.hit,
      "「设�?�?语音」那一页里看不到「角色语音」开�?—�?用户会以为这个功能根本不存在�? + JSON.stringify(noCard));
    assert(noCard.disabled === true, "用不了的时候开关应当是禁用的（灰掉），而不是能点却没反�?);
    assert(/体验�?.test(noCard.note) && /连接方式/.test(noCard.note),
      "禁用时要写清「为什么」和「去哪儿解决」：" + noCard.note);

    // �?带卡进去之后，开关才**能点**（没卡时它是禁用�?—�?那是因为真的用不了，不是坏了）�?    //    点它 �?必须**先弹一次明确告�?*（承诺边界变了：话会离开设备）�?    //    这里同时验证"不同意就打不开"�?    await openAppWithVoice({ enable: false });
    const consentShown = await evaluate(`(async () => {
      document.querySelector('[data-action="open-settings"]').click();
      await new Promise((r) => setTimeout(r, 400));
      window.TASK25C_UI.setSettingsSection('voice');
      await new Promise((r) => setTimeout(r, 400));
      const box = document.querySelector('[data-roleworld="voice-enabled"]');
      if (!box) return { ok: false, error: '设置里没有「角色语音」开�? };
      // 有卡了，这个开关就该是能点的（禁用状态是给没卡的人看的）
      if (box.disabled) return { ok: false, error: '有卡、中转也有语音，开关却是禁用的' };
      box.click();
      await new Promise((r) => setTimeout(r, 350));
      const dialog = document.querySelector('.rw-consent');
      const text = dialog ? dialog.textContent : '';
      // 先点「先不开」：开关必须回到关，而且不能落盘
      const cancel = dialog ? dialog.querySelector('[data-voice-consent="cancel"]') : null;
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 400));
      const settingsAfterCancel = await window.RoleWorld.getLocalSettings();
      return {
        ok: true, dialogShown: !!dialog, text,
        afterCancel: {
          checked: box.checked,
          enabled: settingsAfterCancel.voice_enabled === true,
          consent: !!settingsAfterCancel.voice_consent_at,
        },
      };
    })()`);
    assert(consentShown.ok, JSON.stringify(consentShown));
    assert(consentShown.dialogShown, "打开角色语音没有先弹明确告知");
    assert(/火山/.test(consentShown.text) && /中转/.test(consentShown.text),
      "告知里要写清会经中转发给火山引擎�? + String(consentShown.text).slice(0, 140));
    assert(consentShown.afterCancel.checked === false, "点了「先不开」，开关却没回到关");
    assert(consentShown.afterCancel.enabled === false, "点了「先不开」，设置却写成了打开");
    assert(consentShown.afterCancel.consent === false, "点了「先不开」，却把同意记下来了");
    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
    await sleep(300);

    // �?真的同意（同一个页面里再点一次）�?开关打开、同意时间落盘、能力变成可以朗�?    const ready = await evaluate(`(async () => {
      document.querySelector('[data-action="open-settings"]').click();
      await new Promise((r) => setTimeout(r, 400));
      window.TASK25C_UI.setSettingsSection('voice');
      await new Promise((r) => setTimeout(r, 400));
      document.querySelector('[data-roleworld="voice-enabled"]').click();
      await new Promise((r) => setTimeout(r, 350));
      const dialog = document.querySelector('.rw-consent');
      if (!dialog) return { canSpeak: false, reason: '第二次点开关没有弹告知' };
      dialog.querySelector('[data-voice-consent="accept"]').click();
      await new Promise((r) => setTimeout(r, 1200));
      const rowVisible = (function () { const row = document.querySelector('#voiceEnabledRow'); return !!row && row.hidden === false; })();
      document.querySelector('[data-action="close-settings"]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      const cap = window.RoleWorldVoiceCloud.capability();
      const now = await window.RoleWorld.getLocalSettings();
      return { canSpeak: cap.canSpeak, reason: cap.reason, speakers: cap.speakers.length, rowVisible, enabled: now.voice_enabled === true, consentAt: now.voice_consent_at || '' };
    })()`);
    assert(ready.enabled, "同意之后开关没打开�? + JSON.stringify(ready));
    assert(ready.rowVisible, "带卡并同意之后，「角色语音」那一行不该消失：" + JSON.stringify(ready));
    assert(ready.canSpeak, "开着开关、有卡、中转也有语音，却说不能朗读�? + ready.reason);
    assert(ready.speakers >= VOICE_SPEAKERS.length, "没拿到中转的音色表：" + ready.speakers);
    assert(ready.consentAt, "同意时间没有落盘（下次还会再问一遍）");

    // 关掉设置面板（它是整屏浮层，不关后面的点击都会点到它�?    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
    await sleep(300);

    // �?消息菜单里现在应当有「朗读」；点它 �?真发一次合成请�?�?真播（用假播放器记录�?    //
    // �?这个假播放器**只装一次、之后不再替�?*：播放器对象�?adapter 在第一次朗读时
    //   造好的（它当时就�?window.Audio 抄下来了），后面每步再换 window.Audio 根本不生�?—�?    //   症状�?某一步卡住不�?，而原因和那一步毫无关系（这一条踩过）�?    //   所以：装一�?*路由**，每步只�?window.__rwAudioMode �?__rwAudioLog�?    const before = voiceRequests.length;
    await installFakeAudio();
    const spoken = await evaluate(`(async () => {
      window.__rwAudioLog = [];
      window.__rwAudioMode = 'instant';
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      const btn = row.querySelector('.message-menu-button');
      btn.click();
      const items = Array.from(row.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction);
      const item = row.querySelector("[data-message-action='speak']");
      if (!item) return { ok: false, error: '菜单里没有朗读：' + items.join(',') };
      item.click();
      // 等它合成 + 播完
      for (let i = 0; i < 120 && window.__rwAudioLog.filter((one) => one.played).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300));
      return {
        ok: true, items,
        played: window.__rwAudioLog.filter((one) => one.played).length,
        created: window.__rwAudioLog.length,
        srcIsBlob: (window.__rwAudioLog[0] || {}).src ? String(window.__rwAudioLog[0].src).startsWith('blob:') : false,
        status: document.querySelector('#voiceStatus').textContent || '',
        statusHidden: document.querySelector('#voiceStatus').hidden,
      };
    })()`);
    assert(spoken.ok, JSON.stringify(spoken));
    assert(spoken.items.indexOf("speak") >= 0, "开着语音时菜单里应当有朗读：" + spoken.items.join(","));
    assert(spoken.played >= 1, "点了朗读但没有真的播�? + JSON.stringify(spoken));
    assert(spoken.srcIsBlob, "播放用的不是 blob: 地址�? + JSON.stringify(spoken));
    const afterFirst = voiceRequests.length;
    assert(afterFirst > before, "点了朗读却没有发合成请求");
    const firstCall = voiceRequests[afterFirst - 1];
    assert(firstCall.text && firstCall.text.length > 0, "合成请求里没有文本：" + JSON.stringify(firstCall));
    assert(VOICE_SPEAKERS.some((one) => one.id === firstCall.speaker), "合成请求里的音色不是中转给的那个�? + firstCall.speaker);

    // �?**重复播放不再请求**（缓存命中）—�?这条直接关系到花不花�?    const again = await evaluate(`(async () => {
      window.__rwAudioLog = [];
      window.__rwAudioMode = 'instant';
      const snapshot = window.__rwVoiceSettingsSnapshot;
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      const btn = row.querySelector('.message-menu-button');
      btn.click();
      row.querySelector("[data-message-action='speak']").click();
      for (let i = 0; i < 120 && window.__rwAudioLog.filter((one) => one.played).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300));
      return { played: window.__rwAudioLog.filter((one) => one.played).length, muted: !!(snapshot && snapshot.voice_enabled) };
    })()`);
    assert(again.played >= 1, "第二次点朗读没有播：" + JSON.stringify(again));
    assert(voiceRequests.length === afterFirst, "重复播放又去合成了（白花钱）�? + (voiceRequests.length - afterFirst) + " �?);

    // �?换了音色之后�?*重新**请求（缓存键里必须有音色 —�?否则会出�?换了音色还是旧声�?�?    const changed = await evaluate(`(async () => {
      document.querySelector('[data-action="open-settings"]').click();
      await new Promise((r) => setTimeout(r, 300));
      window.TASK25C_UI.setSettingsSection('voice');
      await new Promise((r) => setTimeout(r, 700));
      if (typeof window.__rwInvokeVoicePanel === 'function') await window.__rwInvokeVoicePanel();
      await new Promise((r) => setTimeout(r, 500));
      // �?要改**当前对话那个角色**的音色。改别人的音色不会影响这句话的缓存键
      //   （那正是"音色隔离"该有的行为），于是会命中缓存、不产生新请�?—�?      //   第一版就是这么假红的�?      const row = document.querySelector('[data-voice-card="Harry Potter (EN).png"]')
        || document.querySelector('#voiceVoiceList [data-voice-card]');
      const select = row.querySelector('[data-voice-speaker]');
      const other = Array.from(select.options).map((o) => o.value).find((id) => id && id !== select.value);
      select.value = other;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      document.querySelector('[data-action="close-settings"]')?.click();
      await new Promise((r) => setTimeout(r, 300));
      return { other, avatar: row.dataset.voiceCard };
    })()`);
    const beforeChanged = voiceRequests.length;
    const replay = await evaluate(`(async () => {
      window.__rwAudioLog = [];
      window.__rwAudioMode = 'instant';
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      row.querySelector('.message-menu-button').click();
      row.querySelector("[data-message-action='speak']").click();
      for (let i = 0; i < 160 && window.__rwAudioLog.filter((one) => one.played).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 400));
      return { played: window.__rwAudioLog.filter((one) => one.played).length };
    })()`);
    assert(replay.played >= 1, "换音色之后再点朗读没有播�? + JSON.stringify(replay));
    assert(voiceRequests.length > beforeChanged, "换了音色却仍然命中旧缓存（会出现「换了音色还是旧声音」）");
    const lastCall = voiceRequests[voiceRequests.length - 1];
    assert(lastCall.speaker === changed.other, "重新合成时用的音色不是新挑的那个�? + JSON.stringify(lastCall));

    // �?切角色要**取消**正在进行的朗读：旧音频不该在新角色那里突然响起来
    const canceled = await evaluate(`(async () => {
      // 让播放器"卡住不结�?，模�?还在�?
      window.__rwAudioMode = 'hold';
      window.__rwAudioLog = [];
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      row.querySelector('.message-menu-button').click();
      row.querySelector("[data-message-action='speak']").click();
      for (let i = 0; i < 160 && window.__rwAudioLog.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
      const speakingBefore = window.RoleWorldVoiceCloud.isSpeaking();
      // 切到另一个角色（应用里切会话/切角色都会走同一�?stop�?      if (typeof window.__rwInvokeStopVoice !== 'function') return { ok: false, error: '没有自检出口 __rwInvokeStopVoice' };
      window.__rwInvokeStopVoice();
      await new Promise((r) => setTimeout(r, 200));
      const speakingAfter = window.RoleWorldVoiceCloud.isSpeaking();
      window.__rwAudioMode = 'instant';
      return { ok: true, speakingBefore, speakingAfter, paused: (window.__rwAudioLog[0] || {}).paused };
    })()`);
    assert(canceled.ok, JSON.stringify(canceled));
    assert(canceled.speakingBefore === true, "前置条件不成立：朗读没在进行�?);
    assert(canceled.speakingAfter === false, "切角色之后还在念（旧音频会突然响起来�?);
    assert(canceled.paused, "切角色时没有把正在播的音频停�?);

    // �?合成失败要给人话，而且**不影响文字聊�?*
    //
    // �?两个前提缺一不可：① 这一句必须是**缓存未命�?*（否则根本不会发请求）；
    //   �?假中转要**持续**失败（客户端对超时会自动重试一次，一次性开关会变成"重试成功"）�?    failVoice(true);
    const failed = await evaluate(`(async () => {
      // 清掉缓存，保证这�?*真的会去合成**�?      // （第一版靠"换一个音�?来保证未命中，结果换到的正好是第 �?步用过的默认音色�?      //   于是命中缓存、直接播�?—�?用例假红，而且原因看不出来。）
      await window.RoleWorldVoiceCloud.clearCache();

      window.__rwAudioLog = [];
      window.__rwAudioMode = 'instant';
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      row.querySelector('.message-menu-button').click();
      row.querySelector("[data-message-action='speak']").click();
      // 超时是可重试的：客户端会自动再试一次，所以这里要等够�?      for (let i = 0; i < 240 && !(document.querySelector('#toast').textContent || '').match(/超时|失败|�?); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const toast = document.querySelector('#toast').textContent || '';
      // 诊断用：万一没弹出提示，要能看出"到底发请求了没有、返回了什�?�?      // 否则只剩一�?没有给出人话提示"，没法查（这一条踩过）�?      const direct = await window.RoleWorldVoiceCloud.speak('这一句会失败�?, { speechRate: 0 });
      return {
        toast, played: window.__rwAudioLog.filter((one) => one.played).length,
        direct, state: window.RoleWorldVoiceCloud.state(),
      };
    })()`);
    assert(failed.direct && failed.direct.ok === false, "中转持续报错时合成应当失败：" + JSON.stringify(failed));
    assert(/超时/.test(String((failed.direct || {}).reason || "")), "失败原因要是人话�? + JSON.stringify(failed.direct));
    assert(/超时|失败|�?.test(failed.toast), "合成失败没有给出人话提示�? + JSON.stringify(failed));
    assert(failed.played === 0, "失败了却还播了东�?);
    failVoice(false);
    reportErrors("角色语音失败提示");

    // �?**角色发语音消�?*�?026-09-14 用户拍板：「和微信语音一样」）�?    //    链路：模型在回复里写 `[[语音]]` �?前端**存之�?*把标记剥�?�?存完盘再后台合成
    //    �?合成好的那条**钉在缓存�?* �?消息上出现一个气泡（时长 + 点一下播）�?    //    这一条要盯的是四件容易出错的事：
    //      �?标记不能留在聊天记录里；
    //      �?念的必须�?*纯对�?*（跟屏幕�?软件聊天"排版显示的是同一份文本）�?    //      �?点气�?*不再花钱**（缓存命中，不重复请求）�?    //      �?太长的回�?*不发语音**（不是偷偷截断）�?    const voiceTurn = await evaluate(`(async () => {
      // 先清队列：这一轮必须是**我们指定的这一�?*（体验卡模式下前面那些用例排过队�?      // 台词没人消费�?—�?不清就会拿到别人的回复，症状�?气泡没出�?但原因在别处）�?      await fetch('/__reply-clear', { method: 'POST' });
      // 这一轮：一句对�?+ 一句旁�?+ 语音标记。旁白不该被念出来�?      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '（她把书合上。）“在的，你说。”\\n[[语音]]' }) });
      return true;
    })()`);
    assert(voiceTurn, "没能排上这一轮的合成回复");
    const beforeVoiceTurn = voiceRequests.length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '在吗';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    // 合成是在存盘之后后台做的：等气泡出现（这�?要好几秒"的那一段）�?    // �?这里不用 waitFor 直接超时：超时只会说"没出�?，查起来要重新跑一遍�?    //   所以自己轮询，超时就把现场（那条消息的 extra、资格判定、语音状态、提示）一起报出来�?    let bubbleSeen = false;
    for (let i = 0; i < 100 && !bubbleSeen; i += 1) {
      bubbleSeen = await evaluate("document.querySelectorAll('#dynamicMessages .voice-bubble').length >= 1");
      if (!bubbleSeen) await sleep(200);
    }
    if (!bubbleSeen) {
      const diag = await evaluate(`(async () => {
        const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
        const row = rows[rows.length - 1];
        const fileName = window.TASK21.activeChatFileName();
        const names = [fileName, fileName + '.jsonl'];
        let lines = null;
        for (const name of names) {
          try { lines = await window.STApi.getChat(${JSON.stringify(MY_AVATAR)}, name); } catch (_) { lines = null; }
          if (Array.isArray(lines) && lines.length) break;
        }
        const last = Array.isArray(lines) ? lines.filter((line) => line && typeof line.mes === 'string').pop() : null;
        return {
          activeChat: fileName,
          body: row ? window.__rwReadAssistantText(row) : '',
          storedExtra: last ? (last.extra || null) : null,
          menuState: window.__rwVoiceMenuState ? window.__rwVoiceMenuState() : null,
          voiceState: window.RoleWorldVoiceCloud.state(),
          capability: window.RoleWorldVoiceCloud.capability().canSpeak,
          toast: (document.querySelector('#toast') || {}).textContent || '',
        };
      })()`);
      assert(false, "角色发了语音，气泡却没出现。现场：" + JSON.stringify(diag));
    }
    const bubble = await evaluate(`(() => {
      const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      const play = node.querySelector('.voice-bubble-play');
      const rect = play.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2);
      const top = document.elementFromPoint(cx, cy);
      return {
        seconds: (node.querySelector('.voice-bubble-seconds') || {}).textContent || '',
        transcript: (node.querySelector('.voice-bubble-text') || {}).textContent || '',
        transcriptVisible: (function () { const t = node.querySelector('.voice-bubble-text'); return !!(t && t.hidden !== true && getComputedStyle(t).display !== 'none'); })(),
        body: window.__rwReadAssistantText(row),
        // 气泡只该有一处：一轮最多一条语�?        count: document.querySelectorAll('#dynamicMessages .voice-bubble').length,
        // "看得�?要按用户的标准：有尺�?+ 中心点命中它自己（这个项目踩过好几次�?        hasSize: rect.width > 0 && rect.height > 0,
        reachable: !!(top && (top === play || play.contains(top))),
        // 点不到的时候要能一眼看�?那是被谁盖住�?（只�?false 查起来要重跑一遍）�?        hitTag: top ? (top.tagName + '.' + String(top.className || '').split(' ').slice(0, 2).join('.')) : 'NONE',
        hitText: top ? String(top.textContent || '').slice(0, 24) : '',
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        scrollTop: (function () { const s = document.querySelector('#chatScroll'); return s ? Math.round(s.scrollTop) : -1; })(),
        scrollHeight: (function () { const s = document.querySelector('#chatScroll'); return s ? Math.round(s.scrollHeight) : -1; })(),
      };
    })()`);
    assert(bubble.transcript === "在的，你说�?,
      "语音消息念的不是纯对白（旁白被念了，或者标记没剥掉）：" + JSON.stringify(bubble));
    assert(bubble.count === 1, "一轮里出现了多条语音气泡：" + bubble.count);
    assert(/^\d+�?/.test(bubble.seconds), "气泡上没有时长：" + bubble.seconds);
    assert(bubble.hasSize && bubble.reachable, "语音气泡看得见但点不到：" + JSON.stringify(bubble));
    assert(bubble.body.indexOf("[[") < 0 && bubble.body.indexOf("语音") < 0,
      "消息正文里留下了语音标记�? + JSON.stringify(bubble.body));
    const voiceTurnCalls = voiceRequests.slice(beforeVoiceTurn);
    assert(voiceTurnCalls.length >= 1, "角色发了语音，却没有发合成请�?);
    assert(voiceTurnCalls.some((call) => call.text === "在的，你说�?),
      "送去合成的不是那句对白：" + JSON.stringify(voiceTurnCalls));
    assert(voiceTurnCalls.every((call) => call.text.indexOf("她把书合�?) < 0),
      "旁白被送去合成/朗读了：" + JSON.stringify(voiceTurnCalls));
    // 这一轮发给模型的**要求**也要盯着（用�?2026-09-14：「微信消息模式也会用（）描述动作�?    // 把要求写清楚，完全模仿真实微信聊天�?「发语音的频率可以高一点」）�?    // 要求没进请求 = 模型根本不知道，那界面再怎么写都没用�?    const styleTurn = requests.filter((row) => row.stream === true).slice(-1)[0] || {};
    const styleText = String(styleTurn.systemText || "");
    assert(styleText.indexOf("微信式聊�?) >= 0, "「完全模仿微信聊天」这一段没进请�?);
    assert(/绝对不要用括�?.test(styleText), "没把「不许用括号写动作」写死：" + styleText.slice(0, 80));
    assert(styleText.indexOf("优先发语�?) >= 0, "没把「短句优先发语音」写进去（频率高不了�?);
    // 提示词要**给出样子**（用�?2026-09-14：「你写清楚是模仿微信聊天回复，deepseek 模型没这么蠢吧」）�?    // 光说"不要写动�?没用，得有正反例子；引号那条也是用户实测反馈（文字里冒出�?“”）�?    assert(styleText.indexOf("不要给自己的话加引号") >= 0, "没写清「不要给自己的话加引号」（文字里会冒出引号�?);
    assert(styleText.indexOf("�?) >= 0 && styleText.indexOf("�?) >= 0,
      "提示词里没有正反例子（模型只能靠猜）�? + styleText.slice(0, 120));
    assert(styleText.indexOf("他摊了下�?) >= 0, "反例里没有「没加括号的旁白」这种情�?);
    // 消息里存着"这条语音"的元数据（刷新之后气泡还得在）�?    const stored = await evaluate(`(async () => {
      const fileName = window.TASK21.activeChatFileName();
      const names = [fileName, fileName + '.jsonl'];
      let lines = null;
      for (const name of names) {
        try { lines = await window.STApi.getChat(${JSON.stringify(MY_AVATAR)}, name); } catch (_) { lines = null; }
        if (Array.isArray(lines) && lines.length) break;
      }
      const last = Array.isArray(lines) ? lines.filter((line) => line && typeof line.mes === 'string').pop() : null;
      return last ? { mes: last.mes, parts: (last.extra || {}).roleworld_parts || null, voice: (last.extra || {}).roleworld_voice || null } : null;
    })()`);
    assert(stored && stored.mes.indexOf("[[") < 0, "存下来的正文里还有标记：" + JSON.stringify(stored));
    // 现在一轮可以分几条消息：语音条�?extra.roleworld_parts 里（kind: "voice" + 缓存键）�?    const voicePart = (stored.parts || []).find((part) => part && part.kind === "voice" && part.key) || null;
    assert(voicePart, "消息里没有记下这条语音（刷新之后气泡会消失）�? + JSON.stringify(stored));
    stored.voice = voicePart;
    // 而且这条语音必须**被钉�?*：不钉住的话，缓存一满它就会�?LRU 淘汰 —�?    // 用户过几天再点那条语音就听不了（或者要重新花钱合成一遍）�?    const pinnedRecord = await evaluate(`(async () => {
      const rows = await RoleWorld.store.listVoiceRecords();
      const hit = (rows || []).find((row) => row.id === ${JSON.stringify(stored.voice.key)});
      return hit ? { pinned: hit.pinned === true, chars: hit.chars, bytes: hit.bytes } : null;
    })()`);
    assert(pinnedRecord && pinnedRecord.pinned === true,
      "这条语音没有被钉住（缓存满了就会被淘汰，过几天点就听不了）：" + JSON.stringify(pinnedRecord));

    // ⑨b 点一下播�?*不再花钱**（缓存命中），而且真的出声了�?    const beforePlay = voiceRequests.length;
    const played = await evaluate(`(async () => {
      window.__rwAudioLog = [];
      window.__rwAudioMode = 'instant';
      const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
      node.querySelector('.voice-bubble-play').click();
      for (let i = 0; i < 120 && window.__rwAudioLog.filter((one) => one.played).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300));
      return {
        played: window.__rwAudioLog.filter((one) => one.played).length,
        srcIsBlob: String((window.__rwAudioLog[0] || {}).src || '').startsWith('blob:'),
      };
    })()`);
    assert(played.played >= 1, "点了语音气泡却没有播�? + JSON.stringify(played));
    assert(played.srcIsBlob, "播放用的不是 blob: 地址�? + JSON.stringify(played));
    assert(voiceRequests.length === beforePlay,
      "回放这条语音又去合成了（白花钱）：多�?" + (voiceRequests.length - beforePlay) + " �?);

    // ⑨c 刷新之后气泡还在，而且仍然不用重新合成（缓存里那条被钉住了）�?    //
    // �?**不在这里切回直连端点**：后�?⑨d 还要发一轮真实回复，而直连那个假端点
    //   从「流式回复里的记忆标记」那条用例起就一直是"慢流剧本"模式（`slowStream` 只开不关�?    //   那条剧本自带 [[记住: …]]，回复固定是"明天见�?）—�?切回直连就会拿到剧本�?    //   而不是我们排队的那句。所以这一段留�?*体验卡模�?*下跑（假中转认排队回复）�?    //   收尾�?finally 里的 closeAppWithVoice() 负责�?    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true").catch(() => {});
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("document.querySelectorAll('#dynamicMessages .voice-bubble').length >= 1", 20000);
    // 整页重载把播放器替身清掉了：重新装，否则"点了没播"只是替身不在了�?    await installFakeAudio();
    const afterReload = await evaluate(`(() => {
      const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
      return {
        transcript: (node.querySelector('.voice-bubble-text') || {}).textContent || '',
        transcriptVisible: (function () { const t = node.querySelector('.voice-bubble-text'); return !!(t && t.hidden !== true && getComputedStyle(t).display !== 'none'); })(),
        seconds: (node.querySelector('.voice-bubble-seconds') || {}).textContent || '',
      };
    })()`);
    assert(afterReload.transcript === "在的，你说�?, "刷新之后语音气泡的内容变了：" + JSON.stringify(afterReload));
    assert(afterReload.seconds === bubble.seconds, "刷新之后时长变了�? + JSON.stringify(afterReload));
    const beforeReplay = voiceRequests.length;
    const replayed = await evaluate(`(async () => {
      window.__rwAudioLog = [];
      window.__rwAudioMode = 'instant';
      const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
      node.querySelector('.voice-bubble-play').click();
      for (let i = 0; i < 120 && window.__rwAudioLog.filter((one) => one.played).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300));
      return { played: window.__rwAudioLog.filter((one) => one.played).length };
    })()`);
    assert(replayed.played >= 1, "刷新之后点这条语音没有播�? + JSON.stringify(replayed));
    assert(voiceRequests.length === beforeReplay,
      "刷新之后回放又去合成了（钉住的缓存没起作用）：多�?" + (voiceRequests.length - beforeReplay) + " �?);

    // ⑨d2 **用户自己�?这一轮发语音还是打字"**�?026-09-14 用户要求：调试阶段要能自己定）�?    //      走真点击那颗开关：点一�?�?变高�?�?这一轮就算模型没�?[[语音]] 也要发语音；
    //      再点一�?�?回文字。要求本身也要进请求（否则模型不知道要发语音）�?    const toggleBefore = await evaluate(`(() => {
      const button = document.querySelector('#replyVoiceToggle');
      if (!button) return { ok: false, error: '输入框旁边没有那个开�? };
      const rect = button.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2);
      const top = document.elementFromPoint(cx, cy);
      return {
        ok: true,
        hidden: button.hidden,
        disabled: button.disabled,
        pressed: button.getAttribute('aria-pressed'),
        hasSize: rect.width > 0 && rect.height > 0,
        reachable: !!(top && (top === button || button.contains(top))),
      };
    })()`);
    assert(toggleBefore.ok, JSON.stringify(toggleBefore));
    assert(toggleBefore.hidden === false && toggleBefore.hasSize && toggleBefore.reachable,
      "「这一轮发语音」开关看不见或点不到（不能用时也应当看得�?+ 写明原因）：" + JSON.stringify(toggleBefore));
    assert(toggleBefore.disabled === false, "能发语音的角色，这个开关不该是禁用的：" + JSON.stringify(toggleBefore));

    // 这一�?*故意让模型不写标�?*（回复里没有 [[语音]]），全靠开关强制�?    await evaluate(`(async () => {
      await fetch('/__reply-clear', { method: 'POST' });
      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '嗯，我听着呢�? }) });
      return true;
    })()`);
    await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
    await sleep(300);
    const beforeToggleTurn = voiceRequests.length;
    const toggleOn = await evaluate(`(() => {
      const button = document.querySelector('#replyVoiceToggle');
      return { pressed: button.getAttribute('aria-pressed'), on: button.classList.contains('is-on'), toast: (document.querySelector('#toast') || {}).textContent || '' };
    })()`);
    assert(toggleOn.pressed === "true" && toggleOn.on, "点了开关没有亮起来�? + JSON.stringify(toggleOn));
    assert(/语音/.test(toggleOn.toast), "点了开关没有给出反馈：" + toggleOn.toast);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '你说�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    let forcedSeen = false;
    for (let i = 0; i < 100 && !forcedSeen; i += 1) {
      forcedSeen = await evaluate("document.querySelectorAll('#dynamicMessages .voice-bubble').length >= 2");
      if (!forcedSeen) await sleep(200);
    }
    const forced = await evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble'));
      const node = nodes[nodes.length - 1];
      return {
        bubbles: nodes.length,
        transcript: node ? (node.querySelector('.voice-bubble-text') || {}).textContent : '',
        toast: (document.querySelector('#toast') || {}).textContent || '',
      };
    })()`);
    assert(forcedSeen && forced.bubbles >= 2,
      "用户点名要语音，回复却没有变成语音消息（模型也没写标记）�? + JSON.stringify(forced));
    assert(forced.transcript === "嗯，我听着呢�?, "强制发语音时念的不是那句话：" + JSON.stringify(forced));
    assert(voiceRequests.length > beforeToggleTurn, "强制发语音却没有发合成请�?);
    // 这一轮的要求也要真的进请求（不给模型写要求，它当然还是打字）�?    const forcedTurn = requests.filter((row) => row.stream === true).slice(-1)[0] || {};
    assert(String(forcedTurn.systemText || "").indexOf("这一轮：发语�?) >= 0,
      "「这一轮发语音」的要求没进请求�? + String(forcedTurn.systemText || "").slice(0, 80));

    // **一次�?*�?026-09-14 收尾）：这一轮用完自动回到打�?—�?不用再点一下�?    // 为什么必须一次性：它会一直黏着，下一轮、甚至「重新回答」都会跟着发语音（还改坏正文）�?    const autoOff = await waitFor("document.querySelector('#replyVoiceToggle').getAttribute('aria-pressed') === 'false'", 8000)
      .then(() => true).catch(() => false);
    assert(autoOff, "发完这一轮之后开关没有自动回到打字（会一直黏着下一轮）");
    await evaluate(`(async () => {
      await fetch('/__reply-clear', { method: 'POST' });
      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '那我打字说�? }) });
      return true;
    })()`);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '打字�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    await sleep(2000);   // �?本来会去合成"留时�?    const backToText = await evaluate(`(() => ({
      bubbles: document.querySelectorAll('#dynamicMessages .voice-bubble').length,
      pressed: document.querySelector('#replyVoiceToggle').getAttribute('aria-pressed'),
    }))()`);
    assert(backToText.pressed === "false", "开关没有回到打字：" + JSON.stringify(backToText));
    assert(backToText.bubbles === forced.bubbles, "开关已经回到打字，却还是发了语音：" + JSON.stringify(backToText));

    // ⑨d0 **一轮可以发几条消息**（用�?2026-09-14：「我发一条他不一定就发一条，也可以发几条�?    //      「语音应该显示成单独的消息，不应该跟在文字后面」）�?    //      这一轮模型连发三条：两句文字 + 一句语�?—�?界面上必须是**三个独立气泡**、顺序不变�?    //      语音那一条自己就是一条消息（不是挂在某段文字后面）�?    await evaluate(`(async () => {
      await fetch('/__reply-clear', { method: 'POST' });
      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '第一句。\\n\\n第二句。\\n\\n就这一句。\\n[[语音]]' }) });
      return true;
    })()`);
    const beforeMulti = voiceRequests.length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '连发给我�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    // 逐条送达�?*有延�?*的（模仿真人一句一句发）：等三条都出现，并顺便�?不是一次蹦出来"�?    let multiSeen = null;
    for (let i = 0; i < 120; i += 1) {
      multiSeen = await evaluate(`(() => {
        const stacks = document.querySelectorAll('#dynamicMessages .message-parts');
        const stack = stacks[stacks.length - 1];
        if (!stack) return null;
        const all = Array.from(stack.querySelectorAll('.message-part'));
        return {
          total: all.length,
          visible: all.filter((n) => getComputedStyle(n).display !== 'none').length,
          kinds: all.map((n) => (n.querySelector('.voice-bubble') ? 'voice' : 'text')),
          texts: all.map((n) => ((n.querySelector('.assistant-bubble p') || n.querySelector('.voice-bubble-text') || {}).textContent || '')),
        };
      })()`);
      if (multiSeen && multiSeen.visible >= 3) break;
      await sleep(200);
    }
    assert(multiSeen, "这一轮没有按「分条」渲染（找不�?.message-parts�?);
    assert(multiSeen.total === 3 && multiSeen.visible === 3,
      "三条消息没有都送到�? + JSON.stringify(multiSeen));
    assert(multiSeen.kinds.join(",") === "text,text,voice",
      "三条消息的顺�?类型不对（两条文�?+ 一条语音）�? + JSON.stringify(multiSeen));
    assert(multiSeen.texts[0].indexOf("第一�?) >= 0 && multiSeen.texts[1].indexOf("第二�?) >= 0,
      "两条文字消息的内容不对：" + JSON.stringify(multiSeen.texts));
    assert(multiSeen.texts[2].indexOf("就这一�?) >= 0, "语音那条的文字不对：" + JSON.stringify(multiSeen.texts));
    // 语音�?*自己一条消�?*：它必须在自己的 .message-part 里，而不是塞在文字气泡下面�?    const voiceIsOwn = await evaluate(`(() => {
      const stacks = document.querySelectorAll('#dynamicMessages .message-parts');
      const stack = stacks[stacks.length - 1];
      const bubbles = Array.from(stack.querySelectorAll('.voice-bubble'));
      if (bubbles.length !== 1) return { ok: false, count: bubbles.length };
      const part = bubbles[0].closest('.message-part');
      return { ok: !!part && !part.querySelector('.assistant-bubble'), parent: part ? part.className : '' };
    })()`);
    assert(voiceIsOwn.ok, "语音没有单独成一条消息（跟在文字后面了）�? + JSON.stringify(voiceIsOwn));
    // 只有语音那一条送去合成；两句文字不该产生合成请求�?    const multiCalls = voiceRequests.slice(beforeMulti);
    assert(multiCalls.some((call) => call.text === "就这一句�?), "语音那条没有去合成：" + JSON.stringify(multiCalls));
    assert(multiCalls.every((call) => call.text.indexOf("第一�?) < 0), "文字那两条也被送去合成了：" + JSON.stringify(multiCalls));
    // 存下来的形状也要对（刷新之后照样三条）�?    const multiStored = await evaluate(`(async () => {
      const fileName = window.TASK21.activeChatFileName();
      const lines = await window.STApi.getChat(${JSON.stringify(MY_AVATAR)}, fileName).catch(() => null);
      const last = Array.isArray(lines) ? lines.filter((line) => line && typeof line.mes === 'string').pop() : null;
      return last ? { parts: (last.extra || {}).roleworld_parts || null, mes: last.mes } : null;
    })()`);
    assert(multiStored && Array.isArray(multiStored.parts) && multiStored.parts.length === 3,
      "存下来的分条不对（刷新就散了）：" + JSON.stringify(multiStored));
    assert(multiStored.parts.map((p) => p.kind).join(",") === "text,text,voice",
      "存下来的类型/顺序不对�? + JSON.stringify(multiStored.parts.map((p) => p.kind)));
    assert(multiStored.mes.indexOf("[[") < 0, "正文里留下了标记�? + JSON.stringify(multiStored.mes));

    // ⑨d **太长的回复不发语�?*（用户拍板：微信里没人用语音发一大段）�?    //     不是截断 —�?那条回复照常是文字，只是没有语音气泡�?    await evaluate(`(async () => {
      const long = "�?.repeat(200);
      await fetch('/__reply-clear', { method: 'POST' });
      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '�? + long + '”\\n[[语音]]' }) });
      return true;
    })()`);
    const beforeLongTurn = voiceRequests.length;
    const beforeLongBubbles = await evaluate("document.querySelectorAll('#dynamicMessages .voice-bubble').length");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '说长一�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    await sleep(2500);   // 给后台合成留�?本来会去合成"的时�?    const longTurn = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const body = (row) => window.__rwReadAssistantText(row);
      return {
        bubbles: document.querySelectorAll('#dynamicMessages .voice-bubble').length,
        text: rows.length ? body(rows[rows.length - 1]) : '',
        // 诊断用：最后几条各自多长、说了什么（不然只剩一�?被截断了"，没法查�?        tails: rows.slice(-3).map((row) => body(row).slice(0, 24) + '�?' + body(row).length + ')'),
        toast: (document.querySelector('#toast') || {}).textContent || '',
      };
    })()`);
    assert(longTurn.bubbles === beforeLongBubbles, "太长的回复也发了语音（气泡数不该变）�? + JSON.stringify(longTurn));
    assert(longTurn.text.length >= 200, "太长的回复被截断了（应当原样显示文字）：" + JSON.stringify(longTurn));
    assert(voiceRequests.length === beforeLongTurn,
      "太长的回复还是去合成了（白花钱）：多�?" + (voiceRequests.length - beforeLongTurn) + " �?);
    reportErrors("角色发语音消�?);

    // 收尾：设置面板是整屏浮层，留着不关会把**后面所有的点击用例**挡住
    // （症状是"重试按钮看得见但点不�?，而原因跟重试按钮毫无关系 —�?这一条踩过）�?    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
    await sleep(400);
    const surfaceHidden = await evaluate("(document.querySelector('#settingsSurface') || {}).hidden === true");
    assert(surfaceHidden, "语音用例结束时设置面板没关，会挡住后面的用例");
    } finally {
      // 无论用例成功还是中途红了，都要�?      //   �?关掉设置面板 —�?它是整屏浮层，留着会把**后面所有点击用�?*挡住
      //      （症状是"重试按钮看得见但点不�?，原因却跟重试按钮毫无关系）�?      //   �?把接口恢复成直连假模型端�?—�?后面那些用例（失败重试等）都按这个前提写的；
      //   �?**把对话切�?Harry 那段** —�?后面那些用例（重新回�?编辑与分�?失败重试/版本�?      //      都按"当前对话�?harry-最近聊�?写的，语音用例把活动对话换成了定制角色那段，
      //      不切回去它们会在别人的对话里数消息（这一条踩过一次：重试被数成写了两遍）�?      await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true").catch(() => {});
      await sleep(300);
      await closeAppWithVoice();
      await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊�?).catch(() => {});
    }
  });

  await check("语音前不闪文字：合成故意很慢时，中间帧只有「正在输�?/ 语音准备中」，正文一次都不出�?, async () => {
    // 用户 2026-09-14 实测反馈：「先看到文字 �?文字消失 �?出现语音」�?    // 根因不是哪一步写错了，而是**同一条消息在两种交付类型之间来回�?*�?    // 流式先按文字画、解析完知道是语音了再抹掉换成气泡�?    //
    // �?这条用例的核心是**采样中间�?*，不是看最后一眼：
    //   假语音服务故意慢 2.5 秒，在这段时间里�?40ms 抓一次屏幕上的全部文本，
    //   只要出现过正文（台词本身）就算红。只断言最后的状态是抓不到这�?bug 的�?    // �?先整页加载一次再进对话：上一条用例（大扇区那条）把接口换成了体验卡模式，
    //   而会话表是在**启动�?*按角色注册表建的 —�?直接�?refreshSessions 会打在一�?    //   还没起来的集成层上（真踩过：`Cannot read properties of undefined`）�?    //   和上面那条语音用例一样，�?用户重新打开应用"这一步开始�?    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const avatar = await ensureCustomCharacter();
    await enableCompanionPlain(avatar);
    await openAppWithVoice({ enable: true });
    await openChatFor(avatar, MY_NAME, MY_CHAT);
    await installFakeAudio();
    reportErrors("语音前不闪文字（进入对话后）");
    // �?上面那条「角色语音」用例结束时�?*故意把语音关�?*（它先验"默认必须是关�?），
    //   所以这里要重新确认开关真的是开�?—�?否则这一轮根本不会走语音那条路，
    //   而失败信息会指向"中间帧出现了正文"，看起来像界�?bug（我第一次就是这么被绕进去的）�?    const voiceOn = await evaluate(`(async () => {
      const now = await RoleWorld.getLocalSettings();
      if (now.voice_enabled !== true) {
        await RoleWorld.saveLocalSettings({ voice_enabled: true, voice_consent_at: now.voice_consent_at || new Date().toISOString() });
        await window.RoleWorldVoiceCloud.refresh({ force: true });
      }
      const after = await RoleWorld.getLocalSettings();
      return { enabled: after.voice_enabled === true, canSpeak: window.RoleWorldVoiceCloud.capability().canSpeak };
    })()`);
    assert(voiceOn.enabled && voiceOn.canSpeak, "前置条件不成立：这一轮必须是开着语音�?—�?" + JSON.stringify(voiceOn));

    const line = "这句话只该在语音里出现�?;
    await evaluate(`(async () => {
      await fetch('/__reply-clear', { method: 'POST' });
      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '�?{line}”\\n[[语音]]' }) });
      return true;
    })()`);
    setVoiceDelay(2500);
    const before = voiceRequests.length;
    try {
      // 一边发一边采样：整个等待期间**屏幕上看得见**的东西，全部记下来�?      const trace = await evaluate(`(async () => {
        const frames = [];
        // �?只采"用户看得见的文本"：语音气泡里那份 .voice-bubble-text �?*故意隐藏**�?        //   （给读屏与用例用），把它算进来会立刻假红 —�?采样的口径必须与用户一致�?        const visibleText = (node) => {
          if (!node) return '';
          if (node.hidden === true) return '';
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return '';
          return node.textContent || '';
        };
        const snapshot = () => ({
          // 流式行（还没存盘的中间态）
          stream: Array.from(document.querySelectorAll('#dynamicMessages [data-stream-state]'))
            .map((row) => visibleText(row.querySelector('.assistant-body'))),
          // 已经画出来的气泡（准备中 / 可播�?/ 失败�?          bubbles: Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble'))
            .map((node) => ({ state: node.dataset.voiceState || 'ready', text: visibleText(node.querySelector('.voice-bubble-text')) })),
          // 已经渲染成正文的助手消息
          bodies: Array.from(document.querySelectorAll('#dynamicMessages .assistant-bubble, #dynamicMessages .assistant-body, #dynamicMessages .message-bubble'))
            .map((node) => visibleText(node)),
          waiting: Array.from(document.querySelectorAll('#dynamicMessages .message-part.is-tbd')).length,
        });
        const input = document.querySelector('#messageInput');
        input.value = '在吗';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        for (let i = 0; i < 180; i += 1) {
          frames.push(snapshot());
          await new Promise((r) => setTimeout(r, 40));
          const done = document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state="ready"]').length >= 1;
          if (done && i > 8) break;
        }
        frames.push(snapshot());
        return frames;
      })()`);
      const leaked = trace.filter((frame) => frame.stream.concat(frame.bodies).some((text) => text.indexOf("这句话只该在语音里出�?) >= 0));
      assert(leaked.length === 0,
        "等待语音的期间屏幕上出现了正文（就是用户看到的那一闪）�? + JSON.stringify(leaked.slice(0, 2)));
      // 等待期间必须真的**�?*东西在屏幕上：只有一�?正在输入"或者一�?语音准备�?气泡�?      const sawWaiting = trace.some((frame) => frame.stream.length || frame.bubbles.length);
      assert(sawWaiting, "等待期间屏幕上什么都没有（用户会以为应用卡了）：" + JSON.stringify(trace.slice(0, 3)));
      const pendingSeen = trace.some((frame) => frame.bubbles.some((b) => b.state === 'queued' || b.state === 'synthesizing'));
      assert(pendingSeen, "没有出现过「语音准备中」的中间态（说明是最后才一次性冒出来）："
        + JSON.stringify(trace.map((f) => f.bubbles).filter((b) => b.length).slice(0, 4)));
      // 最后必须落到可播放的气泡上，而且正文只在气泡的隐藏文本里�?      const final = await evaluate(`(() => {
        const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
        if (!node) return null;
        const text = node.querySelector('.voice-bubble-text');
        return {
          state: node.dataset.voiceState || 'ready',
          playable: !!node.querySelector('.voice-bubble-play'),
          transcript: text ? text.textContent : '',
          transcriptOnScreen: !!(text && text.hidden !== true && getComputedStyle(text).display !== 'none'),
        };
      })()`);
      assert(final && final.state === "ready" && final.playable,
        "等待结束后没有变成可播放的语音气泡：" + JSON.stringify(final));
      assert(final.transcript === line, "气泡里的文本不是那句台词�? + JSON.stringify(final));
      assert(final.transcriptOnScreen === false, "语音气泡把正文显示在屏幕上了�? + JSON.stringify(final));
      assert(voiceRequests.length > before, "这条语音没有真的送去合成");
      // 存下来的形状：`kind: voice` 且已�?ready（刷新之后照样是可播放的语音条）�?      const stored = await evaluate(`(async () => {
        const fileName = window.TASK21.activeChatFileName();
        const lines = await window.STApi.getChat(${JSON.stringify(avatar)}, fileName).catch(() => null);
        const last = Array.isArray(lines) ? lines.filter((l) => l && typeof l.mes === 'string').pop() : null;
        return last ? { mes: last.mes, parts: (last.extra || {}).roleworld_parts || [] } : null;
      })()`);
      assert(stored && stored.parts.length === 1 && stored.parts[0].kind === "voice" && stored.parts[0].status === "ready",
        "存下来的分条不再是「语�?+ ready」：" + JSON.stringify(stored));
      reportErrors("语音前不闪文�?);
    } finally {
      setVoiceDelay(0);
      await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true").catch(() => {});
      await closeAppWithVoice();
      await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊�?).catch(() => {});
    }
  });

  await check("语音合成失败：显示失败�?+ 重试（有次数上限�? 用户主动「改为文字」，正文一个字都不�?, async () => {
    // 用户 2026-09-14：合成失败要有明确失败状态和重试；用户主动要求语音时�?    // **不自动露出正�?*；可提供用户主动选择的「改为文字」�?    // 同上：先整页加载，别接在上一条用例改过的页面上跑�?    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    console.error("        [F1] 页面就绪");
    const avatar = await ensureCustomCharacter();
    console.error("        [F2] 角色就绪 " + avatar);
    await enableCompanionPlain(avatar);
    console.error("        [F3] 伴侣已开");
    await openAppWithVoice({ enable: true });
    console.error("        [F4] 带卡 + 语音已开");
    await openChatFor(avatar, MY_NAME, MY_CHAT);
    console.error("        [F5] 进入对话");
    await installFakeAudio();
    reportErrors("语音合成失败与重试（进入对话后）");
    // 前置条件：这一轮必须是**开着语音**的（上一条用例收尾时可能把它关回去过）�?    const failVoiceOn = await evaluate(`(async () => {
      const now = await RoleWorld.getLocalSettings();
      if (now.voice_enabled !== true) {
        await RoleWorld.saveLocalSettings({ voice_enabled: true, voice_consent_at: now.voice_consent_at || new Date().toISOString() });
        await window.RoleWorldVoiceCloud.refresh({ force: true });
      }
      const after = await RoleWorld.getLocalSettings();
      return { enabled: after.voice_enabled === true, canSpeak: window.RoleWorldVoiceCloud.capability().canSpeak };
    })()`);
    assert(failVoiceOn.enabled && failVoiceOn.canSpeak, "前置条件不成立：这一轮必须是开着语音�?—�?" + JSON.stringify(failVoiceOn));
    const line = "这句话没合成出来�?;
    await evaluate(`(async () => {
      await fetch('/__reply-clear', { method: 'POST' });
      await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '�?{line}”\\n[[语音]]' }) });
      return true;
    })()`);
    failVoice(true);
    try {
      console.error("        [G1] 发消�?);
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '说一�?;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      console.error("        [G2] 等失败气�?);
      await waitFor("document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state=\"failed\"]').length >= 1", 25000);
      console.error("        [G3] 读失败�?);
      const failed = await evaluate(`(() => {
        const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
        if (!node) return { state: 'none' };
        const text = node.querySelector('.voice-bubble-text');
        const retry = node.querySelector('[data-voice-action="retry"]');
        return {
          state: node.dataset.voiceState,
          note: (node.querySelector('.voice-bubble-note') || {}).textContent || '',
          actions: Array.from(node.querySelectorAll('[data-voice-action]')).map((b) => b.dataset.voiceAction),
          retryDisabled: retry ? retry.disabled === true : null,
          transcriptOnScreen: !!(text && text.hidden !== true && getComputedStyle(text).display !== 'none'),
          bodyLeak: Array.from(document.querySelectorAll('#dynamicMessages .assistant-bubble'))
            .some((n) => (n.textContent || '').indexOf('${line}') >= 0),
        };
      })()`);
      console.error("        [G4] 失败�?" + JSON.stringify(failed));
      assert(failed.state === "failed", "合成失败之后不是失败态：" + JSON.stringify(failed));
      assert(failed.note.length > 4, "失败时没有说明发生了什么：" + JSON.stringify(failed));
      assert(failed.actions.join(",") === "retry,to-text", "失败气泡上没有「重试」和「改为文字」：" + JSON.stringify(failed));
      assert(failed.transcriptOnScreen === false && failed.bodyLeak === false,
        "用户点名要语音、合成失败时自动露出了正文：" + JSON.stringify(failed));

      // 点「重试」：会真的再发一次合成请求；仍然失败 �?仍然停在失败态（不是无限重试�?      // 次数上限到了按钮会灰掉）�?      // �?必须**等服务端真的又收到一次请�?*再断言，不能只�?DOM —�?      //   点之前那�?失败 + 按钮禁用"的组合可能已经成立（客户端自己也会重试一次）�?      //   �?DOM 会立刻通过，然后断言"没有重新合成"必然假红（这条我踩过）�?      const beforeRetry = voiceRequests.length;
      try {
        await evaluate(`(() => {
          const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
          if (!node) return 'no-bubble';
          const button = node.querySelector('[data-voice-action="retry"]');
          if (!button) return 'no-retry-button:' + node.dataset.voiceState;
          button.click();
          return 'clicked';
        })()`);
      } catch (error) {
        throw new Error("点「重试」时报错�? + String(error && error.message));
      }
      try {
        await waitFor(`(function(){ const n = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
               if (!n || n.dataset.voiceState !== 'failed') return false;
               const b = n.querySelector('[data-voice-action="retry"]'); return !!b && b.disabled === true; })()`, 25000);
      } catch (error) {
        const seen = await evaluate(`(() => {
          const n = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
          return n ? { state: n.dataset.voiceState, actions: Array.from(n.querySelectorAll('[data-voice-action]')).map((b) => ({ a: b.dataset.voiceAction, d: b.disabled })) } : null;
        })()`).catch(() => null);
        throw new Error("等「重试到顶」超时：" + String(error && error.message) + " ｜现�?" + JSON.stringify(seen));
      }
      const capped = await evaluate(`(() => {
        const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
        const retry = node.querySelector('[data-voice-action="retry"]');
        return { disabled: retry.disabled === true, label: retry.textContent };
      })()`);
      assert(capped.disabled, "重试次数到顶了按钮还能点（会一直花钱）�? + JSON.stringify(capped));
      assert(/已试\s*2\s*�?.test(capped.label), "到顶时没说清试过几次�? + JSON.stringify(capped));

      // 点「改为文字」：正文出现、并�?*落盘**（刷新之后还是文字）�?      await evaluate(`(() => {
        const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
        node.querySelector('[data-voice-action="to-text"]').click();
        return true;
      })()`);
      await waitFor("document.querySelectorAll('#dynamicMessages .voice-bubble').length === 0", 15000);
      const asText = await evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
        const texts = rows.map((row) => window.__rwReadAssistantText(row));
        return { texts: texts.slice(-2), hasLine: texts.some((t) => t.indexOf('${line}') >= 0) };
      })()`);
      assert(asText.hasLine, "「改为文字」之后没有显示正文（内容丢了）：" + JSON.stringify(asText));
      const storedText = await evaluate(`(async () => {
        const fileName = window.TASK21.activeChatFileName();
        const lines = await window.STApi.getChat(${JSON.stringify(avatar)}, fileName).catch(() => null);
        const last = Array.isArray(lines) ? lines.filter((l) => l && typeof l.mes === 'string').pop() : null;
        return last ? { parts: (last.extra || {}).roleworld_parts || [] } : null;
      })()`);
      assert(storedText && storedText.parts.length === 1 && storedText.parts[0].kind === "text",
        "「改为文字」没有落盘（刷新之后又变回语音气泡）�? + JSON.stringify(storedText));
      reportErrors("语音合成失败与重�?);
    } finally {
      failVoice(false);
      await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true").catch(() => {});
      await closeAppWithVoice();
      await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊�?).catch(() => {});
    }
  });

  await check("用户的语音输入先不做：麦克风与设置里那一行都不露出来（不摆点了没反应的控件）", async () => {
    // 用户 2026-09-14：「我认为可以先不做用户的语音输入，而且现在的也不能用」�?    // 为什么钉它：露出来的入口就会有人点，点了没反应比没有更糟（这个项目反复踩过）�?    // �?只钉"入口不露"，不�?代码删了" —�?voice-core �?listen/transcribeBlob 留着�?    //   以后要走"录音经中转发出去转写"那条路时直接接上�?    const ui = await evaluate(`(() => {
      const mic = document.querySelector('#micButton');
      const row = document.querySelector('#speechInputRow');
      return {
        micExists: !!mic,
        micHidden: mic ? mic.hidden === true : null,
        micVisible: mic ? (mic.getBoundingClientRect().width > 0) : false,
        rowHidden: row ? row.hidden === true : null,
        // 能力探测本身还在（代码没被误删）
        canDetect: typeof window.RoleWorldVoice.hasSpeechRecognition === 'function',
        canRecord: typeof window.RoleWorldVoice.hasMediaRecorder === 'function',
      };
    })()`);
    assert(ui.micHidden === true && ui.micVisible === false,
      "输入框旁边那颗麦克风露出来了（说了先不做）：" + JSON.stringify(ui));
    assert(ui.rowHidden === true, "「设�?�?语音 �?语音输入」那一行露出来了：" + JSON.stringify(ui));
    assert(ui.canDetect && ui.canRecord, "语音输入的能力探测被误删了（代码要留着）：" + JSON.stringify(ui));
  });
  await check("连发：正在回的时候又补一句，会并成一条一起问（像真人�?, async () => {
    // 用户 2026-09-14：「如果用户连发的话应该也是可以统一回答的，就是尽可能地模仿真人」�?    // 真人聊天里对方还没回你，你补一句，他回的是**你两句话**，而不是各回一次�?    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    // 直连假端点此时是"慢流剧本"（每轮约 3 秒）——正好用来在生成途中补一句�?    const before = requests.filter((row) => row.path === "/v1/chat/completions" && row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '第一句：你在�?;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#sendButton').dataset.mode === 'stop'", 15000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '第二句：顺便问下明天几点';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.path === "/v1/chat/completions" && row.stream === true).slice(before);
    const last = sent[sent.length - 1] || {};
    const tail = Array.isArray(last.tailMessages) ? last.tailMessages : [];
    const lastUser = String((tail.filter((one) => one.role === 'user').pop() || {}).text || '');
    assert(lastUser.indexOf("第一�?) >= 0 && lastUser.indexOf("第二�?) >= 0,
      "两句没有并成一条一起问�? + JSON.stringify({ lastUser, count: sent.length }));
    // 界面上这两句也应当是**同一�?*用户消息（两行），不是两条�?    const userBubbles = await evaluate(`(() => Array.from(document.querySelectorAll('#dynamicMessages .message-row-user .user-bubble'))
      .map((node) => node.textContent))()`);
    const merged = userBubbles.filter((text) => text.indexOf("第一�?) >= 0);
    assert(merged.length === 1, "两句在界面上变成了两条用户消息：" + JSON.stringify(userBubbles));
    assert(merged[0].indexOf("第二�?) >= 0, "同一条用户消息里没有第二句：" + JSON.stringify(merged));
    // 被掐掉的那一�?*不该落盘**（否则记录里会留下半个回复，还白花一次钱）�?    const stored = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const newest = (Array.isArray(rows) ? rows : []).slice()
        .sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      const users = (Array.isArray(lines) ? lines : []).filter((line) => line && line.is_user === true).map((line) => String(line.mes || ''));
      return { users: users.slice(-3), halfReplies: (Array.isArray(lines) ? lines : []).filter((line) => line && line.is_user === false && String(line.mes || '').indexOf('他把书合�?) >= 0).length };
    })()`);
    // 并成的那一�?*必然同时含两�?*；要证的�?没有被掐掉那一轮的半条"�?    const onlyFirst = stored.users.filter((text) => text.indexOf("第一�?) >= 0 && text.indexOf("第二�?) < 0);
    assert(onlyFirst.length === 0,
      "被掐掉的那一轮也落盘了（记录里多了一条只有半句的用户消息）：" + JSON.stringify(stored));
    // 收尾：整页重载，别把这一轮的临时状态留给后面的用例�?    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
  });
  await check("重新回答：旧答案留在版本里能切回去，上下文跟着当前版本�?, async () => {
    // �?*最后一�?*角色回复：伴侣模式开着时，打开对话可能先来一�?主动开�?的消息，
    // 取第一条会拿到它（这一条自身踩过一次）�?    const lastAssistant = `Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop()`;
    const firstReply = await evaluate(`(() => {
      const row = ${lastAssistant};
      return row ? window.__rwReadAssistantText(row) : '';
    })()`);
    assert(firstReply.length > 0, "没有找到角色回复");
    const userRowsBefore = await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length");
    void userRowsBefore;
    // 渲染会把换行与引号整理过，比内容时统一去掉空白�?    const flat = (value) => String(value || "").replace(/\s+/g, "");
    const storedCountBefore = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      return (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string').length;
    })()`);
    assert(storedCountBefore >= 2, "对话里还没有落盘的消息：" + storedCountBefore);

    // 让下一次回复是一句明显不同的文本，再点「重新回答」�?    await fetch(base + "/__reply-clear", { method: "POST" });
    await evaluate(`fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '第二版回答，完全不一样�? }) }).then(() => true)`);
    const regen = await evaluate(`(async () => {
      const row = ${lastAssistant};
      const index = Number(row.dataset.messageIndex);
      window.TASK21.regenerateReply(index);
      return index;
    })()`);
    await waitTurnSettled();
    await waitFor("document.querySelectorAll('#dynamicMessages .message-version-label').length > 0", 10000);

    const after = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      const body = row ? window.__rwReadAssistantText(row) : '';
      return {
        text: body ? body.textContent : '',
        labels: Array.from(document.querySelectorAll('#dynamicMessages .message-version-label')).map((n) => n.textContent),
        userRows: document.querySelectorAll('#dynamicMessages .message-row-user').length,
        userTexts: Array.from(document.querySelectorAll('#dynamicMessages .message-row-user .user-bubble')).map((n) => n.textContent.slice(0, 24)),
        assistantRows: rows.length,
      };
    })()`);
    assert(after.labels.join(",") === "2 / 2", "重新回答之后没有出现�? / 2」的版本切换�? + JSON.stringify(after.labels));
    // 关键断言：重新回�?*替换一�?*，不是追加一�?—�?所以落盘的消息条数必须不变
    // （假端点有可能两次给同一句话，所以不能拿文本比对来判断）�?    const storedAfter = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      return (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string').length;
    })()`);
    assert(storedAfter === storedCountBefore,
      "重新回答追加了消息（应当只替换一条）：落盘条�?" + storedCountBefore + " �?" + storedAfter + " " + JSON.stringify(after));

    // 把当前这一版改成一个明显不同的文本 —�?这样两个版本一定不一样，
    // 切回旧版本时就能证明"旧答案还�?（假端点有可能两次给同一句）�?    await evaluate(`window.TASK21.editMessageText(${regen}, '改过的第二版')`);
    await waitFor("(document.querySelectorAll('#dynamicMessages .message-version-label')[0] || {}).textContent === '2 / 2'", 8000);
    const edited = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      return window.__rwReadAssistantText(row);
    })()`);
    assert(edited.indexOf("改过的第二版") >= 0, "编辑当前版本没生效：" + edited.slice(0, 60));

    // 切回第一版：旧答案必须原样还在，而且 mes 跟着变（下一轮上下文就用它）�?    await evaluate(`(() => {
      const row = ${lastAssistant};
      row.querySelector(".message-version-step[data-version-step='-1']").click();
      return true;
    })()`);
    await waitFor("(document.querySelector('#dynamicMessages .message-version-label') || {}).textContent === '1 / 2'", 8000);
    const back = await evaluate(`(async () => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      const index = Number(row.dataset.messageIndex);
      const chatRows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(chatRows) ? chatRows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      const messages = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string');
      return { text: window.__rwReadAssistantText(row), stored: messages[index] || null, fileName, count: messages.length };
    })()`);
    assert(back.stored, "读不到落盘的那条消息�? + JSON.stringify({ fileName: back.fileName, count: back.count }));
    // 切回旧版本之后，界面上显示的就该�?*存下来的�?1 �?*�?    // 注意：气泡在渲染时会做归一化（引号“”与换行不进 DOM），所以比较时要一起去掉这些符�?—�?    // 要比的是"显示的是哪一�?，不是逐字节的排版（第一版拿"切换前的 DOM 快照"来比�?    // 而那个快照取自还在屏幕上的流式节点，等于拿两种节点比，永远对不上）�?    const strip = (value) => String(value || "").replace(/[\s“�?「」『』]/g, "");
    const v1 = String((back.stored.swipes && back.stored.swipes[0]) || "");
    const v2 = String((back.stored.swipes && back.stored.swipes[1]) || "");
    assert(v1 && v2 && v1 !== v2, "这一条没有两个不同的版本，用例前提不成立�? + JSON.stringify(back.stored.swipes));
    assert(strip(back.text) === strip(v1),
      "切回�?1 版之后，界面显示的不是第 1 版的内容�? + JSON.stringify({ now: back.text, v1 }));
    assert(strip(back.text) !== strip(v2),
      "切回�?1 版之后，界面显示的还是第 2 版：" + JSON.stringify({ now: back.text, v2 }));
    // 落盘的那一条：swipe_id 指回�?1 版，而且 mes�? 下一轮上下文用的那一版）就是�?1 版的内容�?    assert(back.stored.swipe_id === 0, "切版本之�?swipe_id 没跟回去�? + JSON.stringify(back.stored.swipe_id));
    assert(flat(back.stored.mes) === flat(back.stored.swipes[0]),
      "mes 没有跟着当前版本走（下一轮会拿到错的那一版）�? + JSON.stringify({ mes: back.stored.mes, v1: back.stored.swipes[0] }).slice(0, 200));
    assert(Array.isArray(back.stored.swipes) && back.stored.swipes.length === 2, "两个版本应当都在 swipes 里：" + JSON.stringify(back.stored.swipes));
    assert(back.stored.swipes[1].indexOf("改过的第二版") >= 0, "第二版没留在 swipes 里：" + JSON.stringify(back.stored.swipes));
  });

  await check("编辑与分支：改最后一条就地生效；改更早的会开新分支且原对话不�?, async () => {
    const readChats = async () => evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const out = [];
      for (const row of list) {
        const fileName = row.fileName || row.file_name || row.id || '';
        if (!fileName) continue;
        let lines = [];
        try { lines = await window.STApi.getChat('Harry Potter (EN).png', fileName) || []; } catch (_) { lines = []; }
        const messages = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string');
        out.push({ fileName, count: messages.length, first: (messages[0] || {}).mes || '', last: (messages[messages.length - 1] || {}).mes || '' });
      }
      return out;
    })()`);
    const before = await readChats();
    const totalBefore = before.reduce((sum, row) => sum + row.count, 0);
    assert(before.length >= 1 && totalBefore >= 2, "这一条需要已有对话内容：" + JSON.stringify(before));

    // �?编辑最后一条用户消息：就地改，不新增消息�?    const edit = await evaluate(`(async () => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
      const row = rows[rows.length - 1];
      const index = Number(row.dataset.messageIndex);
      const ok = await window.TASK21.editMessageText(index, '改过之后的这一�?);
      return { index, ok };
    })()`);
    assert(edit.ok === true, "编辑最后一条用户消息没有生效：" + JSON.stringify(edit));
    const afterEdit = await readChats();
    const totalAfterEdit = afterEdit.reduce((sum, row) => sum + row.count, 0);
    assert(totalAfterEdit === totalBefore, "编辑不该改变消息条数�? + totalBefore + " �?" + totalAfterEdit);
    const shownEdited = await evaluate("document.querySelector('#dynamicMessages').textContent.indexOf('改过之后的这一�?) >= 0");
    // 编辑的那条在对话中间，不是首�?—�?所以要扫全部对话的全部消息来找它�?    const storedEdited = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      let hits = 0;
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const fileName = row.fileName || row.file_name || row.id || '';
        if (!fileName) continue;
        let lines = [];
        try { lines = await window.STApi.getChat('Harry Potter (EN).png', fileName) || []; } catch (_) { lines = []; }
        hits += (Array.isArray(lines) ? lines : []).filter((line) => line && line.mes === '改过之后的这一�?).length;
      }
      return hits;
    })()`);
    assert(storedEdited === 1, "改完的内容没有落盘（应当正好一条）�? + storedEdited);
    assert(shownEdited, "改完的内容没有反映到界面�?);

    // �?从一条较早的消息开分支：多出一个对话文件，原对话一条都没少�?    const branch = await evaluate(`(async () => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      const row = rows[Math.max(0, rows.length - 3)] || rows[0];
      const index = Number(row.dataset.messageIndex);
      const beforeList = await window.STApi.listChats('Harry Potter (EN).png');
      const beforeCount = (Array.isArray(beforeList) ? beforeList : []).length;
      const ok = await window.TASK21.branchFromMessage(index);
      await new Promise((r) => setTimeout(r, 800));
      const afterList = await window.STApi.listChats('Harry Potter (EN).png');
      return { index, ok, beforeCount, afterCount: (Array.isArray(afterList) ? afterList : []).length, toast: (document.querySelector('#toast') || {}).textContent || '' };
    })()`);
    assert(branch.ok === true, "开分支失败�? + JSON.stringify(branch));
    assert(branch.afterCount === branch.beforeCount + 1, "分支应当�?*多出一个对话文�?*�? + JSON.stringify(branch));
    assert(branch.toast.indexOf("分支") >= 0 && branch.toast.indexOf("原对话没有改�?) >= 0,
      "开分支之后没说清楚发生了什么：" + branch.toast);

    const after = await readChats();
    const originalBefore = before.slice().sort((a, b) => b.count - a.count)[0];
    const originalAfter = after.find((row) => row.fileName === originalBefore.fileName);
    assert(originalAfter && originalAfter.count === originalBefore.count,
      "原对话被改动了：" + JSON.stringify({ was: originalBefore, now: originalAfter }));
    const branchRow = after.find((row) => !before.some((old) => old.fileName === row.fileName));
    assert(branchRow, "没有找到新建的分支对话：" + JSON.stringify(after));
    assert(branchRow.count >= 1 && branchRow.count <= originalBefore.count,
      "分支内容不对（应当是从那条消息截断的前缀）：" + JSON.stringify({ branch: branchRow, original: originalBefore }));
  });

  await check("失败重试：原话留在屏幕上，重试不产生重复的用户消�?, async () => {
    const userRowsBefore = await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length");
    await fetch(base + "/__fail-next", { method: "POST" });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '这一句会失败';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    await waitFor("document.querySelector('.turn-failure') !== null", 10000);

    const card = await evaluate(`(() => {
      const node = document.querySelector('.turn-failure');
      const retry = node.querySelector("[data-action='retry-turn']");
      const r = retry.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const top = document.elementFromPoint(cx, cy);
      return {
        text: node.querySelector('.turn-failure-text').textContent,
        why: node.querySelector('.turn-failure-why').textContent,
        retryVisible: r.width > 0 && r.height > 0,
        retryReachable: !!(top && (top === retry || retry.contains(top))),
        // 点不到时要把"挡住它的到底是谁"带出�?—�?否则只有一�?点不�?，没法查�?        // 连外框与一小段 HTML 一起带上：只看 tagName 时，一个空�?<strong> 完全看不出是谁�?        blockedBy: (top && top !== retry && !retry.contains(top))
          ? (top.tagName + "." + String(top.className || "").split(" ").slice(0, 3).join(".")
            + " rect=" + JSON.stringify((() => { const b = top.getBoundingClientRect(); return { t: Math.round(b.top), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; })())
            + " parent=" + (top.parentElement ? top.parentElement.tagName + "." + String(top.parentElement.className || "").split(" ")[0] : "-")
            + " html=" + String(top.outerHTML || "").slice(0, 120))
          : "",
        center: { x: cx, y: cy },
        rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) },
        userText: retry.dataset.userText || '',
      };
    })()`);
    assert(card.text.indexOf('这一句会失败') >= 0, "失败卡片上没有保留用户原话：" + card.text);
    assert(card.why.indexOf('原因') >= 0, "失败卡片没说原因�? + card.why);
    assert(card.retryVisible && card.retryReachable, "重试按钮点不到：" + JSON.stringify(card));
    assert(card.userText === '这一句会失败', "重试按钮没记住要重发的那句话�? + card.userText);
    assert(await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length") === userRowsBefore,
      "失败的那一轮不该在对话里留下一条用户消�?);

    // 点重�?�?这次成功。同一句话只能出现一次（不是"再发一�?）�?    await fetch(base + "/__reply-clear", { method: "POST" });
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "这次成功了�? }) });
    await evaluate("document.querySelector(\"[data-action='retry-turn']\").click(); true");
    await waitTurnSettled();
    await waitFor("document.querySelector('.turn-failure') === null", 8000);
    const after = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      const messages = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string');
      return {
        sameText: messages.filter((line) => line.mes === '这一句会失败').length,
        userRows: document.querySelectorAll('#dynamicMessages .message-row-user').length,
        failures: document.querySelectorAll('.turn-failure').length,
      };
    })()`);
    assert(after.sameText === 1, "重试之后这句话被写了两遍�? + JSON.stringify(after));
    assert(after.userRows === userRowsBefore + 1, "重试之后界面上应当多一条用户消息：" + JSON.stringify(after));
    assert(after.failures === 0, "重试成功后失败卡片应当消失：" + JSON.stringify(after));
  });



  await check("刷新之后版本与分支都还在（存的就是看到的�?, async () => {
    // 多版本消息可能在**任意一段对�?*里（分支用例还会新建对话），所以扫全部对话找，
    // 不要只看"最近更新的那一�?（这一条自己踩过一次）�?    const scan = `(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      let swipes = 0;
      const versions = [];
      for (const row of list) {
        const fileName = row.fileName || row.file_name || row.id || '';
        if (!fileName) continue;
        let lines = [];
        try { lines = await window.STApi.getChat('Harry Potter (EN).png', fileName) || []; } catch (_) { lines = []; }
        for (const line of (Array.isArray(lines) ? lines : [])) {
          if (line && Array.isArray(line.swipes) && line.swipes.length > 1) { swipes += 1; versions.push(line.swipes.length); }
        }
      }
      return {
        chats: list.length,
        swipes: swipes,
        versions: versions,
        labels: Array.from(document.querySelectorAll('#dynamicMessages .message-version-label')).map((n) => n.textContent),
        branchFiles: Math.max(0, list.length - 1),
      };
    })()`;
    const before = await evaluate(scan);
    assert(before.swipes >= 1, "刷新前就没有多版本消息，这条用例没意义：" + JSON.stringify(before));

    await goto(base + "/index.html?onboarding=off&surprise=off");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("document.querySelectorAll('#dynamicMessages .message-row').length > 0", 15000);

    const after = await evaluate(scan);
    assert(after.chats === before.chats, "刷新后对话文件数变了（分支丢了？）：" + before.chats + " �?" + after.chats);
    assert(after.swipes === before.swipes && JSON.stringify(after.versions) === JSON.stringify(before.versions),
      "刷新后版本丢了：" + JSON.stringify({ before, after }));
    assert(after.branchFiles === before.branchFiles, "刷新后分支对话不见了�? + JSON.stringify({ before, after }));
  });

  await check("导出再导入之后：版本与分支关系仍然正�?, async () => {
    // 用户本轮的验收里明确要求这一条。做法就是应用自己那条路�?    // RoleWorld.exportArchive() �?清库 �?RoleWorld.importArchive(dump, {mode:'replace'})�?    const snapshot = () => evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      let swipes = 0;
      const versions = [];
      for (const row of list) {
        const fileName = row.fileName || row.file_name || row.id || '';
        if (!fileName) continue;
        let lines = [];
        try { lines = await window.STApi.getChat('Harry Potter (EN).png', fileName) || []; } catch (_) { lines = []; }
        for (const line of (Array.isArray(lines) ? lines : [])) {
          if (line && Array.isArray(line.swipes) && line.swipes.length > 1) { swipes += 1; versions.push(line.swipes.length); }
        }
      }
      return {
        chats: list.length,
        swipes: swipes,
        versions: versions,
        branches: Math.max(0, list.length - 1),
      };
    })()`);
    const before = await snapshot();
    assert(before.swipes >= 1 && before.branches >= 1, "导出前就没有多版�?/ 分支可验，这条用例没意义�? + JSON.stringify(before));

    const dump = await evaluate(`(async () => {
      const data = await window.RoleWorld.exportArchive();
      window.__rwArchiveDump = data;
      return { format: data && data.format, stores: Object.keys((data && data.data) || {}).length };
    })()`);
    assert(dump.format === "roleworld-archive", "导出的存档格式不对：" + JSON.stringify(dump));
    assert(dump.stores > 0, "导出的存档是空的�? + JSON.stringify(dump));

    await evaluate(`(async () => {
      await window.RoleWorld.resetAll();
      await window.RoleWorld.importArchive(window.__rwArchiveDump, { mode: 'replace' });
      return true;
    })()`);

    const after = await snapshot();
    assert(after.chats === before.chats, "导入后对话文件数不对�? + JSON.stringify({ before, after }));
    assert(after.swipes === before.swipes && JSON.stringify(after.versions) === JSON.stringify(before.versions),
      "导入之后版本丢了�? + JSON.stringify({ before, after }));
    assert(after.branches === before.branches, "导入之后分支丢了�? + JSON.stringify({ before, after }));

    // 刷新一次再核对一遍（版本条只画在"当前打开的那段对�?上，
    // 而刷新后打开的不一定是带版本的那一段，所以这里查存储、不�?DOM）�?    await goto(base + "/index.html?onboarding=off&surprise=off");
    await waitFor("window.TASK21_READY === true", 30000);
    const reloaded = await snapshot();
    assert(reloaded.swipes === before.swipes && reloaded.branches === before.branches && reloaded.chats === before.chats,
      "导入并刷新之后版�?/ 分支不对�? + JSON.stringify({ before, reloaded }));
  });

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
    assert(state.gate, "模板门显示了错误，说明空库启动失�?);
    assert(state.auth, "登录门显示了错误");
    assert(state.disabled, "没有角色卡时输入框仍可用");
    assert(state.text, "没有看到空状态提�?);
  });


  cdp.close();
  chrome.proc.kill();
  server.close();

  console.log("");
  const passed = results.filter((row) => row.ok).length;
  const skipped = results.filter((row) => row.skipped).length;
  // 只跑了一部分时要说清楚，别让人把"跳过"当成"跑过�?（更别把 3/3 当成全绿）�?  console.log(`LOCAL_APP=${passed}/${results.length}${skipped ? `（跳�?${skipped} 条：${ARG_ONLY ? "--only=" + ARG_ONLY : "--from=" + ARG_FROM}）` : ""}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("测试运行失败�?, error);
  process.exitCode = 1;
});
