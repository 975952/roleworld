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

/** 假中转下发的音色表（形状与 relay/voices.js 一致，只要够断言"每角色一个音色"就行）。 */
const VOICE_SPEAKERS = [
  { id: "zh_female_vv_uranus_bigtts", label: "vivi 2.0（女声·通用）", lang: "zh", gender: "female", scene: "通用" },
  { id: "zh_male_m191_uranus_bigtts", label: "云舟 2.0（男声·通用）", lang: "zh", gender: "male", scene: "通用" },
  { id: "zh_female_xiaohe_uranus_bigtts", label: "小何 2.0（女声·通用）", lang: "zh", gender: "female", scene: "通用" },
  { id: "en_male_tim_uranus_bigtts", label: "Tim（英语男声）", lang: "en", gender: "male", scene: "通用" },
];

function startServer() {
  const requests = [];
  // 停止生成需要一条"慢慢吐字"的流：只在这条用例里打开，避免影响其它断言。
  let slowStream = false;
let truncateNext = false;
  // 「失败 → 重试」用例用：下一次模型请求直接 500。
  let failNext = false;
  // 下一次回复的内容可以由测试指定：用来验证 [[记住: …]] 这条真实链路。
  const replyQueue = [];
  let replyConsumed = 0;
  let replyRejected = 0;
  const recentReplies = [];
  // 语音这一路单独记：断言"重复播放不再请求/换了音色会重新请求/切角色会取消"。
  const voiceRequests = [];
  // 语音失败是**持续**的（不是一次性的）：客户端对超时会自动重试一次，
  // 一次性的失败开关会让"重试成功"看起来像"没有失败"（这一条踩过）。
  let voiceFailMode = false;
  // 假语音服务的人为延迟（毫秒）：用来验"合成要好几秒"时界面上的中间帧。
  let voiceDelayMs = 0;
  // 「不闪文字」用例要的**可控闸门**：请求进来先挂住，等测试放行再返回。
  // 这样"等待期间"是一个确定的状态，不需要靠 sleep 去赌。
  let voiceHold = false;
  const voicePending = [];
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
    // 否则前面用例排队的回复会先被取走（队列是先进先出）。
    if (p === "/__reply-clear") {
      replyQueue.length = 0;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (p === "/__slow-stream") {
      // 默认打开；带 ?off=1 时关掉 —— 用例收尾要能还原，
      // 否则慢流会一直拖慢**后面所有**用例（连发那条就是靠它制造"生成途中"的）。
      slowStream = !(url.searchParams.get("off") === "1");
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

    // 让下一次模型请求直接失败（用来验证"失败 → 重试"这条链路）。
    if (p === "/__fail-next") {
      failNext = true;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("on");
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
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 保持空对象 */ }
      const auth = String(req.headers.authorization || "");
      if (auth !== "Bearer RW-AAAAA-BBBBB-CCCCC") {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了，或者已经被收回。" } }));
        return;
      }
      // ⚠ 这一路**也要**记系统提示与流式标记，并按同一个队列回话 ——
      //   语音/伴侣那几条用例跑在**体验卡模式**下（接口指向中转），
      //   以前这一路写死"好呀，我们出发吧。"，于是排队的 [[语音]] 回复永远用不上，
      //   表现为"合成请求没到服务端"（诊断里 parts 只有 text）。
      const relaySystemText = (Array.isArray(body.messages) ? body.messages : [])
        .filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n");
      requests.push({
        path: p, relay: true, relayCard: auth.slice(-5), stream: body.stream === true, systemText: relaySystemText,
        // 中转这一路也要标出"这是扩写还是写卡"：AI 写角色在体验卡模式下走的就是这里，
        // 不标的话用例分不清这两步（2026-09-16 加用例时补的）。
        isBriefCall: relaySystemText.indexOf("character designer") >= 0,
        isCardCall: relaySystemText.indexOf("character card author") >= 0,
      });
      // ⚠ 非流式请求（AI 写角色的扩写/写卡就是非流式）必须回**一整段 JSON**。
      //   以前这一路无条件回 SSE —— 于是"在体验卡模式下写角色"会报
      //   `Unexpected token 'd', "data: {"ch"... is not valid JSON`（2026-09-16 加用例时抓到的，
      //   真实中转是按 stream 分流的，假中转也得照做，否则测出来的行为是假的）。
      if (body.stream !== true) {
        const relayPlain = replyQueue.shift();
        if (relayPlain) { replyConsumed += 1; requests[requests.length - 1].queued = true; } else { replyRejected += 1; }
        recentReplies.push({ relay: true, queued: !!relayPlain, text: String(relayPlain || "好呀，我们出发吧。").slice(0, 60) });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "x-rw-card-calls-left,x-rw-card-tokens-left,x-rw-card-expires,x-rw-card-id",
          "x-rw-card-calls-left": "3",
          "x-rw-card-tokens-left": "4800",
          "x-rw-card-expires": "2026-10-12T00:00:00.000Z",
          "x-rw-card-id": "test-card",
        });
        res.end(JSON.stringify({
          model: body.model || "synthetic",
          choices: [{ index: 0, message: { role: "assistant", content: relayPlain || "好呀，我们出发吧。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }));
        return;
      }
      // 流式这一路：系统提示与"排队回复"照旧（systemText 已经在上面那次 push 里带上了）。
      const relayQueued = replyQueue.shift();
      if (relayQueued) { replyConsumed += 1; requests[requests.length - 1].queued = true; } else { replyRejected += 1; }
      recentReplies.push({ relay: true, queued: !!relayQueued, text: String(relayQueued || "好呀，我们出发吧。").slice(0, 60) });
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
      const relayPieces = relayQueued ? [relayQueued] : ["好呀，", "我们出发吧。"];
      for (const piece of relayPieces) {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + "\n\n");
      }
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
      // 「失败 → 重试」用例用：这一次直接 500，而且不记进 requests（就当没发生过）。
      if (failNext) {
        failNext = false;
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "测试用的失败：上游暂时不可用" } }));
        return;
      }
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
        // 历史消息（去掉系统与最后一条本轮输入）：用来验证"消息时间真的进了请求体"
        // （2026-09-18 用户要求）。以前只记最后两条，时间前缀落在中间就看不到了。
        historyMessages: (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .slice(0, -1)
          .map((m) => ({ role: m && m.role, text: String((m && m.content) || "") })),
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
        if (queued) { replyConsumed += 1; requests[requests.length - 1].queued = true; } else { replyRejected += 1; }
        recentReplies.push({ relay: false, queued: !!queued, text: String((queued || '合成回复：你好，我是本地模型。')).slice(0, 60) });
        const pieces = queued ? [queued] : ["合成回复：", "你好，", "我是本地模型。"];        for (const piece of pieces) {
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

    if (p === "/relay/voice/info") {
      // 假中转的语音能力口：客户端靠它决定"菜单里要不要出现朗读"。
      const auth = String(req.headers.authorization || "");
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
      // 假中转的语音合成口：**把请求记下来**（音色、语速、文本），
      // 这样"重复播放不再请求""换了音色会重新请求"这些都能断言。
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const auth = String(req.headers.authorization || "");
      const body = raw ? JSON.parse(raw) : {};
      if (auth !== "Bearer RW-AAAAA-BBBBB-CCCCC") {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了，或者已经被收回。" } }));
        return;
      }
      voiceRequests.push({ text: body.text, speaker: body.speaker, speechRate: body.speech_rate });
      // 「语音前闪一下文字」那组用例要的两个开关：
      //   · voiceDelayMs —— **延迟的假语音服务**：合成要好几秒时，界面必须在整段等待里
      //     都不出现正文（这是用户实测反馈的那个 bug，只截图看最后一眼是抓不到的）；
      //   · voiceFailMode —— 合成失败，用来验"失败态 + 重试 + 改为文字"。
      if (voiceDelayMs > 0) await new Promise((r) => setTimeout(r, voiceDelayMs));
      if (voiceFailMode) {
        res.writeHead(504, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: { code: "VOICE_TIMEOUT", message: "上游合成超时了。" } }));
        return;
      }
      if (voiceHold) {
        // 挂住这一条合成请求：测试会用 releaseVoice() 放行。
        await new Promise((resolve) => voicePending.push(resolve));
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
      /** 让假语音服务**慢下来**（毫秒）。用来验"等待期间界面上不许出现正文"。 */
      setVoiceDelay(ms) { voiceDelayMs = Math.max(0, Number(ms) || 0); },
      /** 挂住后续的合成请求（不返回），直到 releaseVoice()。 */
      holdVoice() { voiceHold = true; },
      /** 放行挂住的合成请求；返回放行了几条。 */
      releaseVoice() { voiceHold = false; const n = voicePending.length; voicePending.splice(0).forEach((r) => r()); return n; },
      /** 当前挂住几条（测试用来确认"请求真的到了"）。 */
      heldVoiceCount() { return voicePending.length; },
      queueStats() { return { pending: replyQueue.length, consumed: replyConsumed, defaulted: replyRejected, last: recentReplies.slice(-4) }; },
    }));
  });
}

const results = [];
let failures = 0;

/*
 * 迭代开关（**真的跳过**，不是只过滤输出）：
 *   node tests/local-app-check.cjs --only=语音前不闪文字    只跑名字里含这段的用例
 *   node tests/local-app-check.cjs --from=重新回答          从第一条匹配的一直跑到底
 *
 * ⚠ 为什么要有它：这个文件以前**根本没有** --only/--from 实现，传了会被静默忽略，
 *   每次都是完整一遍。反例检查要逐组跑（每组 3 次），不改这里就是"每组十几分钟 × 15 遍"。
 * 跳过的用例登记成 skipped，**不计入通过数**，所以 "N/M" 里的 M 仍是总条数。
 */
const ARG_ONLY = (process.argv.find((one) => one.startsWith("--only=")) || "").slice(7).trim();
const ARG_FROM = (process.argv.find((one) => one.startsWith("--from=")) || "").slice(7).trim();
let ARG_FROM_HIT = !ARG_FROM;

/**
 * **单项硬时限**（用户 2026-09-15 要求：每项都设很短的时限，超时先去查问题，别无限等）。
 * 默认 90 秒；单条用例可以用 `--timeout=毫秒` 调。超时 → 这条 FAIL 并写明"超时"，
 * 后面的用例照常跑（不会把整份套件卡死）。
 */
const CASE_TIMEOUT_MS = Math.max(5000, Number((process.argv.find((one) => one.startsWith("--timeout=")) || "").slice(10)) || 90000);
/**
 * 慢用例阈值：实测单条用例正常在 0.0–5 秒，超过这个数就**当场点名**。
 *
 * 为什么要有它：用户的口径是"单项全部设置很短时间的时限，超出时限先找是否有问题"。
 * 一条 9 秒能跑完的用例曾经因为前置不成立空转满 30 秒超时，表现是"慢"、实际是坏；
 * 只报 PASS/FAIL 看不出这种"慢出来的红"，所以慢本身要被单独报出来。
 */
const SLOW_CASE_MS = Math.max(1000, Number((process.argv.find((one) => one.startsWith("--slow=")) || "").slice(7)) || 5000);
let slowCases = 0;

function withTimeout(promise, ms, name) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("用例超时（>" + Math.round(ms / 1000) + " 秒）：" + name)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

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
  const startedAt = Date.now();
  try {
    await withTimeout(fn(), CASE_TIMEOUT_MS, name);
    const ms = Date.now() - startedAt;
    results.push({ name, ok: true, ms });
    console.log("  PASS  " + name + "（" + (ms / 1000).toFixed(1) + "s）");
    if (ms >= SLOW_CASE_MS) {
      slowCases += 1;
      console.log("        ⏱ 慢用例：" + (ms / 1000).toFixed(1) + "s ≥ " + (SLOW_CASE_MS / 1000) + "s —— 先查前置是不是空转，别直接调大 cap");
    }
  } catch (error) {
    failures += 1;
    const ms = Date.now() - startedAt;
    results.push({ name, ok: false, error, ms });
    console.log("  FAIL  " + name + "（" + (ms / 1000).toFixed(1) + "s）\n        " + (error && error.message ? error.message : String(error)));
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

  const { server, port, requests, voiceRequests, failVoice, setVoiceDelay, holdVoice, releaseVoice, heldVoiceCount, queueStats } = await startServer();
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
            data: { name: "Hermione Granger", description: "最聪明的女巫。", first_mes: "你好。", tags: [] } },
          // 第三张是**定制角色**（不在内置名单里）：2026-09-14 用户拍板之后，
          // 伴侣与语音只给「定制人物 + 伴侣身份」；而且它故意不写语言标记，
          // 是"中文角色走哪条路"的唯一现场（英文那条由上面的 Hermione 覆盖）。
          { avatar: "林默.png", name: "林默", description: "自己写的角色：安静、话少。",
            personality: "话少", scenario: "手机上的一对一聊天", first_mes: "在。",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "林默", description: "自己写的角色：安静、话少。", personality: "话少",
                    scenario: "手机上的一对一聊天", first_mes: "在。", tags: [] } }
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

  // 页面里的小工具：**读一条角色消息的文字**。分条渲染之后一条消息可能有三种形状
  // （普通正文 / 分条气泡 / 语音条），断言必须走它 —— 直接查 .assistant-body
  // 会在分条与语音那几条上拿到 null（「重新回答」那条就是这么红的）。
  await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", {
    source: [
      "window.__rwReadAssistantText = function (row) {",
      "  if (!row) return '';",
      "  // 只读**屏幕上真正看得见**的文字：隐藏的语音 transcript 不算。",
      "  const visible = (node) => {",
      "    if (!node) return false;",
      "    if (node.hidden === true) return false;",
      "    const style = getComputedStyle(node);",
      "    if (style.display === 'none' || style.visibility === 'hidden') return false;",
      "    const rect = node.getBoundingClientRect();",
      "    return rect.width > 0 && rect.height > 0;",
      "  };",
      "  const parts = [];",
      "  const bubble = row.querySelector('.message-bubble.assistant-bubble');",
      "  if (bubble && visible(bubble)) parts.push(bubble.textContent || '');",
      "  const body = row.querySelector('.assistant-body');",
      "  if (body && visible(body) && !body.querySelector('.message-bubble')) parts.push(body.textContent || '');",
      "  const voice = row.querySelector('.voice-bubble');",
      "  if (voice && visible(voice) && !parts.length) {",
      "    // 语音条在界面上**没有正文**（真实微信也是），所以这里返回空串，",
      "    // 用例要显式说明：这条是语音、屏幕上本来就没有文字。",
      "    return '';",
      "  }",
      "  return parts.join('\\n').trim();",
      "};",
    ].join("\n"),
  });

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

  /**
   * 等页面里的条件成立。
   *
   * ⚠ 只能等**页面里存在的东西**（DOM / window 上的接口）。等 Node 侧的变量请用 `waitForNode()` ——
   *   把 Node 变量写进这里会在页面里变成 ReferenceError，被吞掉之后一路超时（「角色语音」踩了 5 次）。
   *
   * `label` 是给失败信息用的可选说明（不传就用表达式本身）。
   */
  async function waitFor(expression, timeoutMs = 15000, label = "") {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时：" + (label || expression));
      await sleep(200);
    }
  }

  /**
   * 等 **Node 侧**的条件成立（服务端记到的请求数、队列状态、开关……）。
   *
   * ⚠ 为什么必须有它（2026-09-15 查出来的真原因，别再踩）：
   *   `waitFor(expr)` 把 expr 丢进**页面**里执行。所以
   *   `await waitFor("voiceRequests.length > 0")` 在页面里是 ReferenceError
   *   （`voiceRequests` 是 Node 侧的数组，页面根本没有这个名字），被 catch 吞掉，
   *   于是一直轮询到超时 —— **请求其实已经到了假服务端，断言却永远等不到**。
   *   「角色语音」那条连续 5 次超时就是这么来的（服务端探针实测：SRV-HIT / SRV-PUSH 都打出来了，
   *   而等待仍然超时）。这类"拿 Node 变量去页面里等"的写法只有这一种正确写法：在 Node 里轮询。
   */
  async function waitForNode(predicate, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = predicate(); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时（Node 侧）：" + label);
      await sleep(100);
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

  // 共享前置：把定制角色建好（用**字面量**角色名，不用 CUSTOM_AVATAR 常量 ——
  // 那个常量声明在文件后面，这里用它会撞上 TDZ：`Cannot access 'CUSTOM_AVATAR' before initialization`）。
  // 为什么放共享 setup：用 `--only` 单跑一条时前面"顺手建好"的用例都被跳过，
  // 缺前置会红得像功能坏了。放在这里，任何一条用例单跑都有自己的场景。
  // TASK21_READY 只是"启动流程走完了"，不代表 TASK21 这面接口挂上去了
  // （integration.js:6873 置 READY，7150 才挂 TASK21，中间还隔着别的初始化）。
  // 单跑时这点窗口是实打实的：openChatFor 会 `Cannot read properties of undefined (reading 'refreshSessions')`。
  await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 30000);
  await ensureCustomCharacter("林默.png", "林默", "linmo-量身对话");
  // ⚠ 上面这句会**把活动对话切到定制角色那段**，而它只是个"建好并存在"的前置：
  //   后面绝大多数用例是按别的角色（Harry）写的，活动角色被换掉会让记忆书、记忆面板、
  //   顶栏入口那一整段塌 —— 实测这么写会让整套从 89/89 掉到 74/89（15 条红）。
  //   所以这里把活动对话**切回原来那段**：前置仍然成立（定制角色与那段对话都在），
  //   而后续用例的上下文跟"没有这个前置"时一致。
  await restoreDefaultContext();

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

  await check("返回手势：面板先关、到底才退（网页版与 APK 同一份代码）", async () => {
    // 用户 2026-09-18：「APK 把返回手势做好（网页版也要接住应用内返回）」。
    // 行为口径：按返回先关掉**最上层还开着**的那一个；一层都没有了才是"到底"（那时才允许退出应用）。
    // 判据用 `RoleWorldBack.back()` 的返回值（它返回被关掉的那一层的名字）——
    // 只断言"有反应"是不够的，必须能说出"关掉的是哪一层"。
    const api = await evaluate(`(() => ({
      has: typeof window.RoleWorldBack === 'object' && typeof window.RoleWorldBack.back === 'function',
      layers: typeof window.RoleWorldBack === 'object' ? window.RoleWorldBack.openLayerCount() : -1,
      names: typeof window.RoleWorldBack === 'object' && typeof window.RoleWorldBack.openLayerNames === 'function'
        ? window.RoleWorldBack.openLayerNames() : [],
    }))()`);
    assert(api.has, "返回手势没有挂上（window.RoleWorldBack 不存在）");
    assert(api.layers === 0, "前置不成立：一开始不该有浮层开着：" + JSON.stringify(api));

    // 单跑（`--only`）时启动期间还有别的异步动作在跑（读盘、渲染分页），
    // 它们中途可能改浮层的 hidden —— 先按**结果**等一次"没有浮层开着"再开始量，
    // 否则测到的是"启动还没完"，而不是返回手势本身（这个项目反复踩过这类假失败）。
    await waitFor("window.RoleWorldBack.openLayerCount() === 0", 15000);

    // ① 设置 → 按返回应该关设置（并且**只**关它）
    await evaluate("window.TASK25C_UI.openSettings(); true");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    // ⚠ 每一步都要确认"关掉了"再往下走：`back()` 会去关**当前最先找到的**那一层，
    //   上一步没关干净时，下一步测到的就是上一步的残余（诊断里亲眼见过）。
    //   同时**等一会儿再断言**：面板的关闭本身是异步的（读盘回来还会写一次 hidden）。
    const closedSettings = await evaluate("window.RoleWorldBack.back()");
    assert(closedSettings === "settings", "按返回没有先关设置（返回的是 " + JSON.stringify(closedSettings) + "）");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert(await evaluate("window.RoleWorldBack.openLayerCount() === 0"), "关掉设置之后还有浮层开着："
      + JSON.stringify(await evaluate("window.RoleWorldBack.openLayerNames()")));

    // ② 角色面板 → 关它
    await evaluate("window.TASK21.openCharacterPanel('setup'); true");
    await waitFor("document.querySelector('#characterPanel').hidden === false", 8000);
    const closedPanel = await evaluate("window.RoleWorldBack.back()");
    assert(closedPanel === "characterPanel", "按返回没有关角色面板（返回的是 " + JSON.stringify(closedPanel) + "）");
    await waitFor("document.querySelector('#characterPanel').hidden === true", 8000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert(await evaluate("window.RoleWorldBack.openLayerCount() === 0"), "关掉角色面板之后还有浮层开着："
      + JSON.stringify(await evaluate("window.RoleWorldBack.openLayerNames()")));

    // ③ 「本次请求」→ 关它
    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const closedPeek = await evaluate("window.RoleWorldBack.back()");
    assert(closedPeek === "requestPeek",
      "按返回没有关「本次请求」（返回的是 " + JSON.stringify(closedPeek) + "，还开着的是 "
      + JSON.stringify(await evaluate("window.RoleWorldBack.openLayerNames()")) + "，轨迹 "
      + JSON.stringify(await evaluate("window.RoleWorldBack.lastTrace()")) + "）");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ④ 输入条那两块（「+」面板 / 表情面板）也要关得掉 —— 它们挂在输入框那一块上，最容易被漏掉。
    await evaluate("document.querySelector('#composerPlusButton').click(); true");
    await waitFor("document.querySelector('#composerMenu').hidden === false", 8000);
    const closedMenu = await evaluate("window.RoleWorldBack.back()");
    assert(closedMenu === "composerMenu", "按返回没有关「+」面板（返回的是 " + JSON.stringify(closedMenu) + "）");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const menuAfter = await evaluate(`(() => ({
      names: window.RoleWorldBack.openLayerNames(),
      menuHidden: document.querySelector('#composerMenu').hidden,
      menuClass: document.querySelector('#composerMenu').className,
      plusExpanded: document.querySelector('#composerPlusButton').getAttribute('aria-expanded'),
      sendHidden: document.querySelector('#sendButton').hidden,
      draft: document.querySelector('#messageInput').value,
    }))()`);
    assert(closedMenu === "composerMenu" && menuAfter.names.length === 0, "关掉「+」面板之后它又开了："
      + JSON.stringify(menuAfter) + "，轨迹 " + JSON.stringify(await evaluate("window.RoleWorldBack.lastTrace()")));

    // 到底：一层都没有了 → `back()` 返回空串（这时才允许浏览器/WebView 退出应用）。
    // ⚠ 先真的确认"一层都不剩"：`back()` 在还有浮层时会去关它、返回那一层的名字，
    //   所以"返回空串"这个断言只有在前面每一步都关干净了才成立。
    const remaining = await evaluate("window.RoleWorldBack.openLayerNames()");
    assert(remaining.length === 0, "还有浮层没关掉，没法验证「到底」：" + JSON.stringify(remaining)
      + "，轨迹 " + JSON.stringify(await evaluate("window.RoleWorldBack.lastTrace()")));
    const beforeBottom = await evaluate(`(() => ({
      names: window.RoleWorldBack.openLayerNames(),
      menuHidden: document.querySelector('#composerMenu').hidden,
      menuClass: document.querySelector('#composerMenu').className,
      plusExpanded: document.querySelector('#composerPlusButton').getAttribute('aria-expanded'),
    }))()`);
    const atBottom = await evaluate("window.RoleWorldBack.back()");
    assert(atBottom === "", "已经到底时 back() 应当返回空串（允许退出），实际是 " + JSON.stringify(atBottom)
      + "，调用前 " + JSON.stringify(beforeBottom)
      + "，调用后 " + JSON.stringify(await evaluate("window.RoleWorldBack.openLayerNames()")));
    // 到底之后**页面必须还在**（不能因为按返回就把应用带走）：这正是"arm"那条历史记录的作用。
    assert(await evaluate("location.pathname.indexOf('index.html') >= 0"), "按返回把页面带走了（应用内返回没接住）");
    reportErrors("返回手势");
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
    // 3 张卡：Harry（内置）、Hermione（内置包里的英文卡）、林默（**定制角色**）。
    // 伴侣与语音那一组用例要用它 —— 2026-09-14 用户拍板后内置小说人物不做伴侣。
    assert(counts.c === 3, "角色数量应为 3，实际 " + counts.c + "：" + JSON.stringify(counts.names) + " / 书：" + JSON.stringify(counts.books));
    assert(counts.names.indexOf("林默.png") >= 0, "fixture 里缺少那张定制角色卡：" + JSON.stringify(counts.names));
    // fixture 里有 2 本记忆书：fact clips + 一本带来源的「自动记忆」（用于记忆面板用例）。
    assert(counts.w === 2, "记忆书数量应当 2，实际 " + counts.w + "：" + JSON.stringify(counts.books));
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
    // 用户 2026-09-13 定的分工：「手机版就直接弹出弹窗，电脑版就直接打开侧边栏」。
  // 用例跑在宽屏上，所以这里量的是**右侧记忆栏**打开了（窄屏那条由 viewport 套件覆盖）。
  await waitFor("document.querySelector('.inspector-column').getAttribute('aria-hidden') === 'false'", 8000);
  await evaluate("window.TASK25C_UI.setMemoryPanelOpen ? window.TASK25C_UI.setMemoryPanelOpen(false) : null; true");
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
  /** 统一读一条助手消息的文字（普通正文 / 分条气泡 / 语音条三种形状都认）。 */
  const readAssistantText = (row) => window.__rwReadAssistantText(row);

  async function waitTurnSettled() {
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 25000);
  }

  /**
   * 发一句话并等这一轮彻底结束（自带前置：不依赖"前面的用例发过消息"）。
   *
   * 为什么要它：`--only` 单跑时前面用例都被跳过，靠"上一轮留下的请求"写断言的用例
   * 会红成 `Cannot read properties of undefined` —— 那是缺前置，不是功能坏了。
   */
  async function sendOneTurn(text) {
    await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
  }

  /* ------------------------------------------------------------------ *
   * 伴侣 / 语音用例要用的角色与接口
   *
   * 2026-09-14 用户拍板：「小说人物不设置伴侣……只有定制人物加上伴侣身份再打开语音。」
   * 也就是说**内置的那 6 张小说角色卡在运行时不再注入关系段落**。
   * 所以这一组用例必须跑在**定制角色**上 —— fixture 里那张「林默」卡的 avatar
   * 不在内置名单里，而且它故意不写语言标记（中文那条路要有现场）。
   * （「伴侣段落跟着卡片语言走」那条仍然用英文卡 Hermione。）
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

  /** 这个角色能不能开伴侣、能不能发语音，都读不了「内置小说人物不给开」那道闸。 */
  const isBuiltin = (avatar) => BUILTIN_AVATARS.indexOf(String(avatar)) >= 0;
  void isBuiltin;

  /** 当前对话角色的名字（顶栏那颗按钮显示的就是它）——
   *  不写死某个名字：这一组用例现在跑在定制角色的对话里（内置小说人物不做伴侣）。
   *  ⚠ 读的是按钮里的 `#topbarTitle`，不是整颗按钮的 textContent：
   *    2026-09-16 起按钮里多了一个「当前方式」小字（剧情对话 / 日常聊天），
   *    整颗读会把那个小字也当成角色名。 */
  async function activeCharacterName() {
    const title = await evaluate("(document.querySelector('#topbarTitle') || {}).textContent || ''");
    if (String(title).trim()) return String(title).trim();
    const text = await evaluate("(document.querySelector('#topbarCharacterButton') || {}).textContent || ''");
    return String(text).replace(/[\u2304\s]+$/, "").trim();
  }

  /**
   * 确保当前页面是对话页（index.html）。
   *
   * 为什么要它：`TASK21` 只挂在对话页上，而套件里「剧情模式页」那一段会把页面留在
   * `/magic-map.html`。用 `--only` 单跑后面的用例时页面就停在 magic-map 上 ——
   * 任何依赖对话页的用例都会红，而红的理由跟被测功能毫无关系。
   * 之前想靠 `openChatFor` 顺手切页面，但那是**隐式**前置：它自己不检查页面，
   * 结果是空转满 30 秒才报一句"等待超时"，看起来像功能坏了。
   *
   * 这里显式切，并校验切之后确实到了对话页：没到就直接报错，
   * 而不是让每个调用方各自超时。
   */
  async function ensureChatPage() {
    const onChatPage = await evaluate("location.pathname.indexOf('magic-map') < 0").catch(() => false);
    if (onChatPage) return false;
    const before = await evaluate("location.pathname").catch(() => "?");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    const after = await evaluate("location.pathname").catch(() => "?");
    assert(after.indexOf("magic-map") < 0,
      "确保对话页失败：从 " + before + " 跳转之后仍在 " + after + "（TASK21 不会挂在这个页面上）");
    return true;
  }

  /**
   * 造一段对话并切过去（会话表 + 真实切换入口）。
   * fileName 用角色名 + 用途，保证同一段对话在多次运行里是同一个文件。
   */
  async function openChatFor(avatar, name, fileName) {
    // 先确保**在对话页**：否则下面等的 TASK21 永远不会出现（magic-map 上没有它）。
    await ensureChatPage();
    // 前置：TASK21 挂出来之前调它只会拿到 TypeError，而那不是被测行为坏了。
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    const ok = await evaluate(`(async () => {
      const avatar = ${JSON.stringify(avatar)};
      const fileName = ${JSON.stringify(fileName)};
      const existing = await window.STApi.listChats(avatar);
      const has = (existing || []).some((row) => String(row.fileName || row.file_name || row.id) === fileName);
      if (!has) {
        await window.STApi.saveChat(avatar, fileName, [
          { chat_metadata: { ui_title: fileName }, user_name: "我", character_name: ${JSON.stringify(name)} },
          { name: "我", is_user: true, mes: "今天好热", send_date: new Date(Date.now() - 70 * 60000).toISOString() },
          { name: ${JSON.stringify(name)}, is_user: false, mes: "那就别出门了。", send_date: new Date(Date.now() - 69 * 60000).toISOString() },
        ]);
      }
      await window.TASK21.refreshSessions();
      const row = window.TASK21.sessionList().find((one) => String(one.fileName).indexOf(fileName) >= 0);
      if (!row) return false;
      // ⚠ 必须走**界面入口**（点会话行），不能直接调 window.TASK21.selectChat。
      //
      // 为什么：selectChat 开头有一条早退守卫（integration.js:5164）——
      //   if (!switching && activeSession && (sessionId === activeSession.id || …)) return;
      // 界面已经在这段对话上时它会直接 return，于是 chatModel.select() 从不执行，
      // 模型的"活动会话"仍停在它自己默认打开的那一段。结果：
      //   liveState.activeSession（界面显示的那段） 与 chatModel.getActive()（被编辑+落盘的那段）
      // **分家** —— 编辑落盘成功、界面 8 秒不刷新，看起来像应用缺陷，实际是测试绕过了真实入口。
      // 点界面行则会先走 selectChat 的"切到别的会话"，再回到目标那段，模型侧跟着同步。
      // 会话行的两种身份写法都要认：sessionList() 给的是 id/fileName，行上是 data-chat-id。
      // 只按 id 相等匹配会在"id 带 .jsonl、行上不带"的老数据上找不到（实测踩过）。
      const keys = [row.id, row.fileName, row.file_name, row.storageFileName]
        .filter(Boolean).map((one) => String(one));
      const sameKey = (a, b) => a === b || a.replace(/\.jsonl$/, "") === b.replace(/\.jsonl$/, "");
      const rows = () => Array.from(document.querySelectorAll('#historyGroups [data-action="select-chat"]'));
      const findRow = (k) => rows().find((one) => sameKey(String(one.dataset.chatId || ""), k));
      const node = keys.map(findRow).find(Boolean) || null;
      let via = "click";
      if (node) {
        node.click();
      } else {
        // 兜底：列表里没有这一行时退回直调，但下面的校验会暴露"模型侧没同步"这件事。
        via = "api";
        await window.TASK21.selectChat(row.id);
      }
      // 等模型侧活动会话真的落到目标这一段。
      //
      // 为什么必须校验、而且可能要走"先切走再切回"：
      //   refresh()（task22-core.js:1419）会整表换新对象，此后 active 与
      //   liveState.activeSession 可能指向**两个不同对象**（同一段对话）；
      //   而 selectChat 的早退守卫（integration.js:5164）在"界面已在该会话上"时直接 return，
      //   chatModel.select() 不执行 —— 两边就再也不会对齐：
      //   编辑改在旧对象上、重画读新对象 → **落盘成功、界面不刷新**（真实复现过）。
      //   真实用户点一下**别的**会话再点回来，就能把模型侧对齐；这里照做。
      const synced = async () => {
        for (let i = 0; i < 40; i += 1) {
          const active = window.TASK21.activeChatFileName();
          if (keys.some((k) => sameKey(String(active || ""), k))) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      };
      let ok2 = await synced();
      let bounced = "";
      if (ok2) {
        // 文件名对得上还不够：模型侧对象可能仍是"另一份"。先切到别的会话再切回，
        // 逼 selectChat 走完整路径（这一步等同真人点两下）。
        const other = rows().find((one) => !keys.some((k) => sameKey(String(one.dataset.chatId || ""), k)));
        if (other) {
          bounced = String(other.dataset.chatId || "");
          other.click();
          await new Promise((r) => setTimeout(r, 250));
          const back = keys.map(findRow).find(Boolean) || null;
          if (back) back.click(); else await window.TASK21.selectChat(row.id);
          ok2 = await synced();
        }
      }
      return { ok: true, via, synced: ok2, bounced, active: window.TASK21.activeChatFileName() };
    })()`);
    if (!ok || !ok.ok) {
      // 失败时一次把"为什么找不到这段对话"报全：假报一句 `false` 查不动（实测浪费过一轮）。
      const why = await evaluate(`(async () => {
        const filesInRegistry = window.TASK21.sessionList().map((one) => one.fileName);
        const rowsOnScreen = Array.from(document.querySelectorAll('#historyGroups [data-action="select-chat"]'))
          .map((one) => String(one.dataset.chatId || ""));
        const stored = await window.STApi.listChats(${JSON.stringify(avatar)})
          .then((list) => (list || []).map((one) => String(one.fileName || one.file_name || one.id)))
          .catch((e) => ["<listChats 失败：" + String(e && e.message) + ">"]);
        const cards = await RoleWorld.store.listCharacters().then((list) => list.map((one) => one.avatar)).catch(() => []);
        const raw = await window.STApi.listChats(${JSON.stringify(avatar)}).catch(() => null);
        return {
          wanted: ${JSON.stringify(fileName)},
          active: window.TASK21.activeChatFileName(),
          会话表里有没有: filesInRegistry.indexOf(${JSON.stringify(fileName)}) >= 0,
          会话表: filesInRegistry,
          界面上的行: rowsOnScreen,
          这个角色的存档里: stored,
          存档原始形状: Array.isArray(raw) ? raw.slice(0, 3) : raw,
          角色卡: cards,
        };
      })()`).catch((e) => ({ 探针也失败了: String(e && e.message) }));
      assert(false, "没能切到 " + fileName + " 那段对话：" + JSON.stringify(ok) + " 现场：" + JSON.stringify(why));
    }
    assert(ok.synced, "切过去之后活动会话不是目标那段（via=" + ok.via + "，实际=" + JSON.stringify(ok.active)
      + "）—— 模型侧活动会话没同步，后面的编辑/重答会改到另一段对话上");
    await waitFor(`window.TASK21.activeChatFileName().indexOf(${JSON.stringify(fileName)}) >= 0`, 10000,
      "活动对话没能落在 " + fileName + "（sessionList=" + JSON.stringify(await evaluate("window.TASK21.sessionList().map((r) => r.fileName)"))
      + "）");
  }

  /**
   * 把上下文切回套件默认的那段对话（fixture 注入的 harry-最近聊过）。
   *
   * 用途：共享前置建完定制角色之后，把活动对话**还回去** —— 否则后面按 Harry 写的
   * 记忆/面板用例会在错误的角色上跑（实测 15 条连带失败）。
   * 这不是"某个用例的私有前置"，而是共享 setup 的收尾，所以写成一个具名动作。
   */
  async function restoreDefaultContext() {
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
  }

  /** 内置角色的头像文件名（与内置包自带的一致）。判定"哪些是内置角色"只看文件名，
   *  所以合成卡验不到那条闸，必须用真名建一张。 */
  const BUILTIN_CARD_AVATAR = "Ginny Weasley (Triwizard Year).png";
  const BUILTIN_CARD_NAME = "Ginny Weasley";

  /**
   * 在**当前用例内部**临时建一张真内置卡（走应用自己的导入接口，preserved_name 精确指定
   * 头像文件名），并等 TASK21 重新挂出来。
   *
   * 为什么不放全局 fixture：实测在 fixture 里加一张卡会让整套从 89/89 掉到 73/89 ——
   * 角色数量、排序、记忆书归属、"当前角色"全跟着变，记忆与面板那一段整片塌。
   * 这条闸只需要在**这一条用例**里成立，用完就删。
   */
  async function ensureBuiltinCard() {
    const created = await evaluate(`(async () => {
      const existing = (await RoleWorld.store.listCharacters()).some((c) => c.avatar === ${JSON.stringify(BUILTIN_CARD_AVATAR)});
      if (existing) return ${JSON.stringify(BUILTIN_CARD_AVATAR)};
      const card = {
        spec: "chara_card_v3", spec_version: "3.0",
        data: {
          name: ${JSON.stringify(BUILTIN_CARD_NAME)},
          description: "韦斯莱家的小女儿。",
          personality: "直率", scenario: "霍格沃茨", first_mes: "你好。", mes_example: "", tags: [],
        },
      };
      const file = new File([JSON.stringify(card)], "ginny.json", { type: "application/json" });
      const out = await window.STApi.importCharacter(file, "json", { preserved_name: ${JSON.stringify(BUILTIN_CARD_AVATAR)} });
      return out && out.avatar;
    })()`);
    assert(created === BUILTIN_CARD_AVATAR, "没能按内置文件名建出角色卡：" + created);
    // 导入会重建角色注册表，TASK21 是重新挂上去的 —— 这一步不能省。
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    return BUILTIN_CARD_AVATAR;
  }

  /** 删掉临时建的内置卡（连对话一起删），别把状态留给后面的用例。 */
  async function removeBuiltinCard() {
    await evaluate(`(async () => {
      const has = (await RoleWorld.store.listCharacters()).some((c) => c.avatar === ${JSON.stringify(BUILTIN_CARD_AVATAR)});
      if (has) await window.STApi.deleteCharacter(${JSON.stringify(BUILTIN_CARD_AVATAR)}, true);
      return true;
    })()`);
  }

  /** 给定制角色**确保**一份可用的伴侣档案（走应用自己的保存入口，不绕过同步缓存）。
   *  这一组用例原来依赖"前一条用例留下的状态"，链条一断就会误报成功能坏了；
   *  所以每条自带前置。 */
  async function ensureCompanionProfile(avatar) {
    return evaluate(`(async () => {
      const entry = { avatar: ${JSON.stringify(avatar)}, charName: ${JSON.stringify(CUSTOM_NAME)} };
      const prev = await window.TASK21.loadCompanion(entry);
      const next = Object.assign({}, prev, {
        enabled: true, relation: 'partner', charCallsUser: '阿林',
        shared: [{ text: '第一次聊天是在雨天的图书馆' }],
        chatStyle: 'plain',
      });
      await window.TASK21.saveCompanion(entry, next);
      const check = await window.TASK21.loadCompanion(entry);
      return !!(check && check.enabled === true && check.chatStyle === 'plain');
    })()`);
  }

  /** 确保定制角色存在，并切到它的一段对话。
   *  走应用自己的导入接口建卡（跟用户在界面上点「导入角色文件」是同一条路）。 */
  async function ensureCustomCharacter(avatarArg, nameArg, chatArg) {
    // 允许传字面量：共享 setup 调用它时 CUSTOM_* 常量还在 TDZ（声明在后面），直接用会报错。
    const AV = avatarArg || "林默.png";
    const NM = nameArg || "林默";
    const CH = chatArg || "linmo-量身对话";
    const exists = await evaluate(`(async () => (await RoleWorld.store.listCharacters()).some((c) => c.avatar === ${JSON.stringify(AV)}))()`);
    if (!exists) {
      const created = await evaluate(`(async () => {
        const card = {
          spec: "chara_card_v3", spec_version: "3.0",
          data: {
            name: ${JSON.stringify(NM)},
            description: "自己写的角色：安静、话少，习惯用聊天软件回话。",
            personality: "话少，句子短。",
            scenario: "手机上的一对一聊天。",
            first_mes: "在。",
            mes_example: "",
            tags: [],
          },
        };
        const file = new File([JSON.stringify(card)], ${JSON.stringify(NM + ".json")}, { type: "application/json" });
        const result = await window.STApi.importCharacter(file, "json");
        return result && result.avatar;
      })()`);
      assert(created === AV, "导入定制角色之后拿到的 avatar 不对：" + created);
      // 导入之后整页重载：会话表是按**角色注册表**列出来的，而注册表是启动时建的。
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
    }
    await openChatFor(AV, NM, CH);
    return AV;
  }

  /* ------------------------------------------------------------------ *
   * 语音那几条用例要用的角色与开关
   *
   * 2026-09-14 用户拍板：只有**定制角色 + 伴侣 + 软件聊天**能发语音。
   * 所以这一组跑在林默身上；MY_* 是"这一组专用的那一段对话与名字"。
   * ------------------------------------------------------------------ */

  const MY_AVATAR = CUSTOM_AVATAR;
  const MY_NAME = CUSTOM_NAME;
  const MY_CHAT = "linmo-聊天软件";

  /** 给这个定制角色打开伴侣模式，并把聊天方式设成「软件聊天（不带动作）」—— 语音的两道门槛。 */
  async function enableCompanionPlain(avatar) {
    // ⚠ 走应用自己的保存入口（TASK21.saveCompanion，界面上那个保存按钮调的就是它），
    //   不是往 kv 里直接写：直接写会绕过同步缓存，而"这个角色能不能发语音"是**同步**读缓存的 ——
    //   结果就是"档案明明开着，菜单里却没有朗读"（排查起来极费劲，探针里真踩到过）。
    return evaluate(`(async () => {
      const entry = { avatar: ${JSON.stringify(avatar)}, charName: ${JSON.stringify(CUSTOM_NAME)} };
      const previous = await window.TASK21.loadCompanion(entry);
      const next = Object.assign({}, previous, { enabled: true, relation: 'partner', chatStyle: 'plain' });
      await window.TASK21.saveCompanion(entry, next);
      const check = await window.TASK21.loadCompanion(entry);
      return !!(check && check.enabled === true && check.chatStyle === 'plain');
    })()`);
  }

  /**
   * 把"能朗读"的条件一次凑齐：带卡整页打开 → 打开角色语音并同意。
   *
   * ⚠ **不许在这里手动调 VoiceCloud.refresh()**：那会把"从没探测过 → 开关不出现"
   * 这条真实路径整个绕过去（第一版就是那么写的，于是测试全绿而用户看不到开关）。
   * 这里只用**应用自己的启动流程**（带 #card= 打开）。
   *
   * ⚠ 用完必须调 closeAppWithVoice()：带卡进页面会把接口整体指向中转，
   * 后面那些"直连模型"的用例就再也打不到假模型端点了。
   */
  async function openAppWithVoice(options) {
    const opts = options || {};
    const wantEnabled = opts.enable !== false;
    // ⚠ 卡号格式是 RW-5-5-5（`RW-AAAAA-BBBBB-CCCCC`）。以前写成过 6 个 B，
    //   parseCardInput 的正则不匹配 → 卡整个没被用上 → 语音那一行当然不出现。
    // ⚠ 先记下"体验卡开场看过了"：那层引导**铺满屏幕、中心点命中它自己**，
    //   开着的时候底下什么都点不到。真人点完开场才开始用 —— 测试也照做。
    await evaluate("(function(){ try { localStorage.setItem('card_welcome_seen','1'); } catch(_) {} return true; })()");
    await goto(base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay");
    // ⚠ 必须再整页加载一次：`#card=…` 是**片段地址**，浏览器只做同文档导航、不会重新加载，
    //   于是 RoleWorld.init() 里那段"自动应用卡"根本不会跑（卡没配上，语音自然全灭）。
    await cdp.sessionSend(session, "Page.reload");
    await sleep(400);
    await waitFor("window.TASK21_READY === true", 30000);
    const stuck = await dismissOnboarding();
    if (stuck) console.log("        （提示：体验卡开场没走完，界面可能被引导层盖住）");
    // 等应用自己把语音能力探测**做完**（不是"中转地址回来了"就完事 ——
    // 那只是 refresh() 的第一步，enabled 还没写、事件也还没发）。
    try {
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
          settings: { provider: settings.provider, endpoint: settings.endpoint, card_relay: settings.card_relay, voice_enabled: settings.voice_enabled },
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
        if (!box) return { canSpeak: false, reason: '设置里找不到「角色语音」开关', speakers: 0, rowVisible };
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
        diag: {
          snapshot: window.RoleWorldVoiceCloud.snapshot(),
          cardActive: cardState.active, cardRelay: cardState.relay,
          settingsRelay: now.card_relay, provider: now.provider, endpoint: now.endpoint,
        },
      };
    })()`);
    return state;
  }

  /**
   * 走完还在屏幕上的引导层（带卡进来时会弹「体验卡开场」）。
   *
   * ⚠ 那一层是**铺满屏幕、中心点命中它自己**的（`.rw-ob`），开着的时候底下什么都点不到。
   * 真人会先点完开场 —— 测试也照做，别让可达性断言活在一个用户看不到的布局里。
   */
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

  /**
   * 装一个可控的播放器替身。
   *
   * 为什么要有：无头浏览器里"真的出声"既听不到、也断言不了；而播放链路本身
   * （有没有播、有没有被停、用的是不是 blob 地址）正是要盯的东西。
   * ⚠ 它**只对当前这一页有效**：整页重载之后要重新装。
   */
  async function installFakeAudio() {
    await evaluate(`(() => {
      window.__rwAudioMode = 'instant';
      window.__rwAudioLog = [];
      window.Audio = function (src) {
        const node = { src: src, playCalls: 0 };
        node.play = () => {
          node.playCalls += 1;
          window.__rwAudioLog.push({ src: src, played: true });
          if (window.__rwAudioMode === 'fail') return Promise.reject(new Error('测试用的播放失败'));
          return Promise.resolve();
        };
        node.pause = () => {};
        node.addEventListener = () => {};
        node.removeEventListener = () => {};
        return node;
      };
      return true;
    })()`);
  }

  /** 把接口恢复成直连假模型端点（带卡的那几条用例收尾时必须调）。
   *  ⚠ 顺手把「角色语音」**关掉、同意记录清掉**：这两样是**本机设置**（不是卡的一部分），
   *    不收干净就会漏给后面的用例 —— 实测症状是"下一条用例一打开面板就已经是开着的、
   *    同意也勾好了"，于是"没勾同意时点不动"那类断言全都不成立（2026-09-16 整轮跑到才暴露）。 */
  async function closeAppWithVoice() {
    await evaluate(`(async () => {
      window.RoleWorldVoiceCloud.stop();
      await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", tutorial_seen: true, language_mode: "auto", voice_enabled: false, voice_consent_at: "" });
      await RoleWorld.secrets.remove("api_key_custom");
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "", language_mode: "auto", voice_enabled: false } }));
      await window.RoleWorldVoiceCloud.refresh({ force: true });
      return true;
    })()`).catch(() => {});
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
    assert(await evaluate("document.querySelector('#requestPeekButton').hidden === false"), "发过消息后入口没出现");    assert(await evaluate("document.querySelector('#requestPeek').hidden === true"), "面板不该自己弹出来");
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

  await check("每条消息的时间真的进了请求体（2026-09-18 用户要求）", async () => {
    // 用户原话：「每条消息的时间也要加进给模型的提示里」。
    // 判据只看**假服务端收到的请求体**：历史里那条带 send_date 的消息，
    // 在请求体里必须带 [MM-DD HH:MM] 前缀；存档里的 mes 一个字都不许动。
    //
    // ⚠ 自己先发两轮（不借前面用例的请求）：`--only` 单跑这条时前面全被跳过，
    //   借"上一次请求"的写法在单跑下必然假失败（这个项目反复踩过的坑）。
    const sendOne = async (text) => {
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
    };
    await sendOne("时间用例第一句");
    await sendOne("时间用例第二句");
    const stored = await evaluate(`(() => {
      const messages = (window.TASK21.activeSessionMessages && window.TASK21.activeSessionMessages()) || [];
      const row = messages.filter((m) => m && m.mes && m.send_date).slice(-1)[0] || null;
      return row ? { mes: String(row.mes), send_date: String(row.send_date) } : null;
    })()`);
    assert(stored, "前置不成立：当前这段对话里没有带 send_date 的消息");
    const expected = await evaluate(`window.TASK22_CORE.messageTimePrefix(${JSON.stringify(stored.send_date)})`);
    assert(/^\[\d\d-\d\d \d\d:\d\d\]$/.test(expected), "取到的时间前缀格式不对：" + JSON.stringify(expected));
    const sent = requests.filter((row) => row.stream === true && Array.isArray(row.historyMessages));
    assert(sent.length >= 2, "前置不成立：至少要有两轮流式请求（第二条才可能把第一条当历史带上）");
    const history = sent[sent.length - 1].historyMessages;
    const hit = history.filter((m) => m.text.indexOf(expected) === 0);
    assert(hit.length >= 1,
      "历史消息在请求体里没有带上时间前缀 " + expected + "：" + JSON.stringify(history.map((m) => m.text.slice(0, 40))));
    // 只加前缀，**绝不改写**正文：去掉前缀后必须与存档里那条一模一样。
    const withPrefix = history.filter((m) => m.text.indexOf(expected) === 0)
      .some((m) => m.text.slice(expected.length + 1) === stored.mes);
    assert(withPrefix, "带时间的那条正文被改写了（应当只是前缀）：" + JSON.stringify({
      expectedPrefix: expected, storedMes: stored.mes.slice(0, 40),
    }));
    // 系统提示里要说明那些前缀是什么（不然模型只会看到一个方括号）。
    assert(await evaluate("window.__rwLastSystemText ? window.__rwLastSystemText.indexOf('[Message times]') >= 0 : false")
      || sent[sent.length - 1].systemText.indexOf("[Message times]") >= 0,
      "系统提示里没有说明时间前缀的含义");
  });

  await check("正常配置必须照常发出去（守卫的反面用例，先写它）", async () => {
    // 2026-09-18 第三次做「注定 401 先拦下来」。前两次回滚的根因都是**判据读错了设置来源**，
    // 于是"正常发送"被判成"注定 401"、整套回归塌掉。所以这条**反面用例先写**：
    // 正常配置下必须真的发出一次请求（看假服务端收到的条数），一条都不许被拦。
    const before = await evaluate("(async () => (await RoleWorld.getLocalSettings()).endpoint || '')()").catch(() => "");
    void before;
    const sentBefore = requests.filter((row) => row.stream === true).length;
    const blocked = await evaluate("window.TASK21.chatPreflight()");
    assert(blocked === null, "正常配置被守卫拦住了（这就是前两次回滚的那个 bug）：" + JSON.stringify(blocked)
      + "，连接 " + JSON.stringify(await evaluate("window.TASK21.chatConnection()")));
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '守卫的反面用例：这句必须发出去';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sentAfter = requests.filter((row) => row.stream === true).length;
    assert(sentAfter > sentBefore, "正常配置的这句没有发出去（被拦了）："
      + JSON.stringify({ sentBefore, sentAfter, connection: await evaluate("window.TASK21.chatConnection()") }));
    const card = await evaluate("document.querySelectorAll('#dynamicMessages .chat-preflight').length");
    assert(card === 0, "正常配置却画出了「没发出去」的卡片：" + card);
  });

  await check("注定 401 的组合：聊天在发之前就拦住，并给一个能点的下一步", async () => {
    // 现场（用户 2026-09-16）：服务商停在 DeepSeek 官方、那一格没有凭据，地址回落到
    // `api.deepseek.com` —— 请求注定被拒。守卫要在**发之前**拦住，并给一个可点的去处。
    //
    // ⚠ 判据用 `chatPreflight(override)`：这条用例固定装置（fixture）与本机存档是**两份不同的设置**
    //   （fixture 把假服务地址塞进 local settings，`liveState.settings` 那一份是空的），
    //   直接走 sendLive 会变成"测试自己造出来的局面"，量与断言的东西对不上（前一版就死在这里）。
    //   所以这里显式喂进"注定 401 的那份设置"，量守卫的判定 —— 同一个函数、同一份判据。
    const setup = await evaluate(`(async () => {
      await RoleWorld.secrets.remove('api_key_deepseek');
      await RoleWorld.secrets.remove('api_key_custom');
      return true;
    })()`);
    void setup;
    const connection = await evaluate(`window.TASK21.chatConnection({
      settings: { provider: 'deepseek', endpoint: '', card_relay: '', oai_settings: { custom_url: '' } },
      modelMode: 'local', customUrl: '', cardRelay: '',
    })`);
    const preflight = await evaluate(`window.TASK21.chatPreflight({
      settings: { provider: 'deepseek', endpoint: '', card_relay: '', oai_settings: { custom_url: '' } },
      modelMode: 'local', customUrl: '', cardRelay: '',
    })`);
    assert(preflight && preflight.kind === "no-credential",
      "守卫没有认出「注定 401」的组合：" + JSON.stringify(preflight) + "，连接 " + JSON.stringify(connection));
    assert(preflight.host === "api.deepseek.com",
      "守卫没有把「会打到哪」算对：" + JSON.stringify(preflight));

    // 界面上那张卡：说明 + 一个**真的能点开设置**的下一步。
    const card = await evaluate(`(() => {
      window.TASK21.__showPreflightForTest(${JSON.stringify(preflight)}, '这句注定 401');
      const node = document.querySelector('#dynamicMessages .chat-preflight');
      return node ? { kind: node.dataset.preflight, text: node.textContent,
        buttons: Array.from(node.querySelectorAll('button')).map((b) => b.textContent) } : null;
    })()`);
    assert(card && card.kind === "no-credential", "卡片不对：" + JSON.stringify(card));
    assert(card.buttons.indexOf("去设置连接方式") >= 0, "没有给「去设置连接方式」这个入口：" + JSON.stringify(card.buttons));
    assert(card.text.indexOf("api.deepseek.com") >= 0, "没有说清会打到哪：" + JSON.stringify(card.text));
    // 那个入口必须真的能打开设置页的连接方式（不能只画一个按钮）。
    await evaluate(`(() => {
      const node = document.querySelector('#dynamicMessages .chat-preflight [data-action="open-connection-settings"]');
      if (node) node.click();
      return true;
    })()`);
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    const section = await evaluate("document.querySelector('[data-settings-panel=\\'connection\\']').classList.contains('is-active')");
    assert(section, "「去设置连接方式」没有真的把设置打开到「连接方式」那一页");
    await evaluate("window.TASK25C_UI.closeSettings(); true");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
    await evaluate("document.querySelectorAll('#dynamicMessages .chat-preflight').forEach((n) => n.remove()); true");
    // 这一条也把 liveState 那份快照改成过"没凭据"，收尾必须还原（否则后面全都发不出去）。
    await evaluate("window.TASK21.reloadSettings()").catch(() => {});
    await restoreDefaultContext().catch(() => {});
  });

  await check("卡配在另一格：说清「配在别处」并给一键切过去的入口", async () => {
    // 最初那次 401 的真实机制：卡配好了，但服务商停在 DeepSeek 官方；
    // `RoleWorldCard.currentState()` 只看当前那一格 → 判"没在用卡" → 聊天不考虑走卡。
    // 这种情况必须**单独认出来**（"配在别处" ≠ "没配"），并给一个真能切过去的按钮。
    const setup = await evaluate(`(async () => {
      await RoleWorld.secrets.remove('api_key_deepseek');
      await RoleWorld.secrets.set('api_key_custom', 'RW-AAAAA-BBBBB-CCCCC');
      return { relay: (await RoleWorld.getLocalSettings()).card_relay || '' };
    })()`);
    void setup;
    const preflight = await evaluate(`window.TASK21.chatPreflight({
      settings: { provider: 'deepseek', endpoint: '', card_relay: '${base}/relay', oai_settings: { custom_url: '' } },
      modelMode: 'local', customUrl: '${base}/relay/v1/chat/completions', cardRelay: '${base}/relay',
    })`);
    assert(preflight && preflight.kind === "card-elsewhere",
      "没有认出「卡配在另一格」：" + JSON.stringify(preflight));
    await evaluate(`(() => {
      window.TASK21.__showPreflightForTest({ kind: "card-elsewhere", host: "api.deepseek.com", elsewhere: { provider: "custom", relay: "${base}/relay" } }, '卡在另一格');
      return true;
    })()`);
    const card = await evaluate(`(() => {
      const node = document.querySelector('#dynamicMessages .chat-preflight');
      return node ? { kind: node.dataset.preflight, buttons: Array.from(node.querySelectorAll('button')).map((b) => b.textContent) } : null;
    })()`);
    assert(card && card.buttons.indexOf("改用这张体验卡") >= 0, "没有给「改用这张体验卡」这个入口：" + JSON.stringify(card));
    // 点下去必须**真的**把 provider / 地址 / 卡切过去（不是只弹一句 toast）。
    await evaluate(`(() => {
      const node = document.querySelector('#dynamicMessages .chat-preflight [data-action="use-card-now"]');
      if (node) node.click();
      return true;
    })()`);
    await waitFor("(async () => (await RoleWorld.getLocalSettings()).provider === 'custom')()", 8000);
    const connection = await evaluate("window.TASK21.chatConnection()");
    assert(connection.effective === base + "/relay/v1/chat/completions",
      "「改用这张体验卡」没有把地址切到卡的中转：" + JSON.stringify(connection));
    const after = await evaluate("window.TASK21.chatPreflight()");
    assert(after === null, "切过去之后守卫仍然判「注定 401」：" + JSON.stringify(after));
    // 收尾：把**两份设置都还原**（本机存档 + liveState 快照）。
    // ⚠ 只还存档是不够的：`liveState.settings` 是内存里那一份，测试把它改成"注定 401"之后
    //   后面的用例全都会跟着发不出去（实测：后面连着 6 条红）。两份都要还。
    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ provider: 'deepseek', endpoint: '${base}/v1/chat/completions', card_relay: '' });
      await RoleWorld.secrets.remove('api_key_custom');
      document.querySelectorAll('#dynamicMessages .chat-preflight').forEach((n) => n.remove());
      return true;
    })()`).catch(() => {});
    await evaluate("window.TASK21.reloadSettings()").catch(() => {});
    await restoreDefaultContext().catch(() => {});
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
    // 2026-09-18 用户口径：记错 / 编造**全局取消** —— 台账那一行里不该再有这两个数字。
    // ⚠ 判据只能落在**台账那一行**上：整个 peek 里还有"系统提示的构成明细"，
    //   而系统提示本来就写着"不要编造"这类诚实规则（那是必须保留的），
    //   拿整个 body 去搜"编造"必然误判（2026-09-18 我自己踩到过）。
    const ledger = await evaluate(`(() => {
      const box = document.querySelector('#requestPeekBody .request-peek-dropped');
      return box ? String(box.textContent || '') : '';
    })()`);
    assert(/台账（最近 \d+ 轮）/.test(ledger), "没找到台账那一行：" + JSON.stringify(ledger));
    assert(ledger.indexOf("记错") < 0 && ledger.indexOf("编造") < 0,
      "台账里还在报「记错 / 编造」（已经取消了）：" + JSON.stringify(ledger));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("取消记错 / 编造：消息旁不再有入口，台账也不再报这两个数字", async () => {
    // 用户 2026-09-18：「全局取消记错和编造」。
    // ⚠ 数据层**没有删**：`metrics-core` 的 flags、台账里的 `flags` 字段、存档格式都原样保留
    //   （动它要牵到存档与既有台账）。现在的状态是"界面里没有任何地方能触发它" ——
    //   这条用例钉的正是这一点，而不是"字段消失了"。
    const flags = await evaluate("document.querySelectorAll('.message-flag, .message-flags').length");
    const rows = await evaluate("document.querySelectorAll('#dynamicMessages .message-row-assistant').length");
    assert(rows > 0, "前置不成立：这一段对话里一条助手消息都没有");
    assert(flags === 0, "消息旁还有「记错 / 编造」的入口（已经取消了）：" + flags);
    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate(`(() => {
      const box = document.querySelector('#requestPeekBody .request-peek-dropped');
      return box ? String(box.textContent || '') : '';
    })()`);
    assert(text.indexOf("记错") < 0 && text.indexOf("编造") < 0,
      "台账那一行还在报「记错 / 编造」（已经取消了）：" + JSON.stringify(text));
    await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
  });

  await check("顶栏可以直接切换模型，并且写回同一份配置", async () => {
    const current = await evaluate("(document.querySelector('#chatModelSelect') || {}).value");
    assert(current === "deepseek-flash", "顶栏当前值不对：" + current);
    assert(await evaluate("document.querySelector('#chatDeepseekKeyInput') === null"), "对话页仍有重复的密钥输入框");
    const options = await evaluate("Array.from(document.querySelectorAll('#chatModelSelect option')).map((o) => o.value)");
    assert(options.indexOf("deepseek-flash") >= 0, "已知型号没列出来：" + JSON.stringify(options));
    assert(options.indexOf("deepseek-v4-pro") < 0,
      "DeepSeek 只留 deepseek-flash（用户要求不再用 v4-pro）：" + JSON.stringify(options));
    assert(options.indexOf("__custom__") >= 0, "缺少「自定义模型名…」入口");

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

  await check("对话界面显示 token 用量与费用估算", async () => {
    await waitFor("(document.querySelector('#chatCostLine') || {}).textContent.length > 0", 8000);
    const line = await evaluate("document.querySelector('#chatCostLine').textContent");
    assert(/本对话 \d+ 轮/.test(line), "费用行没有轮次：" + line);
    assert(/输入 [\d.]+k? \/ 输出 [\d.]+k? tokens/.test(line), "费用行没有 token 用量：" + line);
    assert(/累计 [≈]?¥[\d.]+/.test(line), "费用行没有金额：" + line);
    assert(/单价 ¥[\d.]+\/¥[\d.]+ 每百万 tokens（(高峰|闲时)时段）/.test(line), "费用行没带单价与峰谷：" + line);
  });

  await check("面板按来源分段，且分段之和与真正发出的请求一致", async () => {
    // 2026-09-18：输入条改成微信式之后，「本次请求」收进「+」面板，真正的按钮
    // （`#requestPeekButton`）成了**状态锚点**（永远 hidden），用户点的是面板里那一行。
    // 所以这里不再点那颗隐藏按钮（`.click()` 对隐藏节点照样有效，测出来的不是用户的路），
    // 改成走公开出口 `window.TASK21.openRequestPeek()` —— 与面板里那一行调的是同一个函数。
    await evaluate("window.TASK21.openRequestPeek(); true");
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
    const text = await evaluate("document.querySelector('#requestPeekBody').textContent");
    for (const label of ["系统提示", "角色卡 · 描述", "回复格式要求", "本轮输入"]) {
      assert(text.indexOf(label) >= 0, "面板缺少分段：" + label + " —— " + JSON.stringify(text.slice(0, 200)));
    }
    assert(/合计 \d+ 字 · [\d.]+k? tokens · 共 \d+ 条消息/.test(text), "没有合计行：" + JSON.stringify(text.slice(-160)));
    assert(text.indexOf("已核对：分段之和与真正发出的请求逐字节一致") >= 0,
      "面板没有给出逐字节一致性结论：" + JSON.stringify(text.slice(-200)));
    assert(text.indexOf("会发送给你配置的模型服务商") >= 0, "面板缺少隐私提示");

    // 只读：**用用户的路径**再开一次（「+」→「本次请求」），期间不许发出新的模型请求。
    // 2026-09-18：这里原来是点 `#requestPeekButton`，而那颗按钮现在是隐藏的状态锚点 ——
    // 点隐藏节点不算"用户的路"，所以改成点「+」面板里那一行（它调的是同一个 openRequestPeek）。
    const before = requests.length;
    await evaluate(`(() => {
      const plus = document.querySelector('#composerPlusButton');
      plus.click();
      const row = document.querySelector('#composerMenuPeek');
      if (!row) return { missing: true };
      row.click();
      return { missing: false };
    })()`);
    await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
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
    await evaluate("window.TASK21.openMemoryPanel()");
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
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");

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
    await evaluate("window.TASK21.openMemoryPanel()");
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
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");

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
    await evaluate("window.TASK21.openMemoryPanel()");
    await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
    const panelText = await evaluate("document.querySelector('#memoryPanel #memoryList').textContent");
    for (const fake of ["霍格沃茨五年级学生", "旧教室谈起借扫帚", "扫帚会在使用后归还"]) {
      assert(panelText.indexOf(fake) < 0, "角色记忆面板里出现了示例数据：" + fake);
    }
    assert(await evaluate("!!document.querySelector('#memoryPanel #memoryList #memoryOrientation')"),
      "记忆面板里应当有记忆取向选择器");
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
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
    assert(/已用 \d+ \/ 上限 \d+ 条/.test(probe.usage), "没有显示条数用量：" + JSON.stringify(probe.usage));
    assert(probe.hasClearAll, "没有一键清空按钮");
    assert(/清空这个角色的全部记忆/.test(probe.clearAllText), "一键清空按钮文案不对：" + probe.clearAllText);

    // 折叠：点一下收起，再点一下展开
    await evaluate("document.querySelector('.memory-group-toggle').click(); true");
    await waitFor("document.querySelector('#memoryList .memory-group .memory-list').hidden === true", 5000);
    await evaluate("document.querySelector('.memory-group-toggle').click(); true");
    await waitFor("document.querySelector('#memoryList .memory-group .memory-list').hidden === false", 5000);
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
  });

  await check("一键清空该角色全部记忆：清完后面板为空、下一轮请求不再带上", async () => {
    await evaluate("window.TASK21.openMemoryPanel()");
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

    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
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
    await evaluate("window.TASK21.openMemoryPanel()");
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

  await check("伴侣模式：关系、称呼、起点、时间感与硬规矩都进了请求", async () => {
  // 前置自带（按 MIGRATION_PROMPT 第四节第 1 条；受损原文把这一段的页面/角色/档案前置
  // 放在**上一条用例**里，单跑这条会直接红，所以补在这里）：
  //   ① 页面可能停在 magic-map.html（顶栏「记忆」是对话页的按钮）；
  //   ② 会话要落在定制角色那一段上 —— 内置小说人物从 2026-09-14 起不给开伴侣模式，
  //      对着内置角色跑这一条等于什么都没测；
  //   ③ 关系档案要清成"没写过"的默认态 —— 候选里「伴侣模式只属于这个角色」那条用例的
  //      前置会往同一格 kv 写进 1 件共同经历，带着它进来会让下面的「2 件共同经历」变成 3 件。
  //      这里走应用自己的 saveCompanion（不是直接写 kv），免得绕过同步缓存。
  await ensureChatPage();
  await openChatFor(CUSTOM_AVATAR, CUSTOM_NAME, CUSTOM_CHAT);
  await evaluate(`(async () => {
    const entry = { avatar: ${JSON.stringify(CUSTOM_AVATAR)}, charName: ${JSON.stringify(CUSTOM_NAME)} };
    await window.TASK21.saveCompanion(entry, { enabled: false });
    const check = await window.TASK21.loadCompanion(entry);
    return !!(check && check.enabled === false && check.shared.length === 0);
  })()`);

  // 走用户真正会走的那条路：角色记忆面板 → 关系档案。
  // 受损处原文只剩「角色记忆面板 �?关系档案�?，按上下文（两处入口 + 候选同一主题用例的用词）重建为这一句。
  await evaluate("window.TASK21.openMemoryPanel(); true");
  await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
  assert(await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\") !== null"),
    "记忆面板里没有「关系档案」入口");
  await evaluate("document.querySelector(\"#memoryPanel [data-action='open-companion']\").click(); true");
  await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
  // 关系页的内容是异步读出来的（角色档案 + 当前表单状态）：等面板报"这一页填好了"再断言，
  // 否则读到的是空壳 —— 这条以前就踩过（合并分页当天）。
  // ⚠ 上限给到 20 秒：单跑（--only）时这一页要从头读档案，8 秒实测会假超时（等的是就绪信号，
  //   不是被测行为；抬上限不影响任何断言的严格程度）。
  // ⚠ 整轮跑到这里曾经卡住过（单跑没事）：超时那一下把现场打出来，别再靠猜。
  try {
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'relationship'", 20000);
  } catch (error) {
    const why = await evaluate(`(() => {
      const panel = document.querySelector('#characterPanel');
      const pane = document.querySelector('[data-character-pane="relationship"]');
      const active = document.querySelector('[data-character-tab].is-active');
      const memory = document.querySelector('#memoryPanel');
      const companion = document.querySelector('#companionDialog');
      return {
        面板在: !!panel,
        面板hidden: panel ? panel.hidden : null,
        ready: panel ? panel.dataset.ready : null,
        活动页: active ? active.dataset.characterTab : null,
        关系页hidden: pane ? pane.hidden : null,
        关系页文本: pane ? (pane.textContent || '').replace(/\\s+/g, ' ').slice(0, 120) : null,
        记忆面板hidden: memory ? memory.hidden : null,
        伴侣对话框hidden: companion ? companion.hidden : null,
        对话: window.TASK21 ? window.TASK21.activeChatFileName() : null,
        设置开着: (document.querySelector('#settingsSurface') || {}).hidden === false,
        挡住的层: Array.from(document.querySelectorAll('.rw-ob, .rw-consent, #voiceSheet, .settings-surface, .modal-backdrop'))
          .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && n.hidden !== true; })
          .map((n) => n.id || n.className),
      };
    })()`).catch((e) => ({ 探针失败: String(e && e.message) }));
    assert(false, "关系档案那一页没能就绪。现场：" + JSON.stringify(why));
  }
  assert(await evaluate("document.querySelector('#memoryPanel').hidden === true"), "打开关系档案后记忆面板应当让开");
  assert(await evaluate("document.querySelector('#companionPreview').textContent.indexOf('一个字符都不会多带') >= 0"),
    "没打开时应当说清楚不会多带内容");

  // 界面上列出的硬规矩，必须是模型真正被告知的那一份（同一个来源）。
  // 受损处原文只剩「必须是模型真正被告知的那一份（同一个来源）�?，按候选同一主题用例的这句注释重建。
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
  // 「关系：恋人」= relation 选了 partner，companion-core 的 relationLabel 把它翻成「恋人」。
  // 受损处原文只剩「关系：恋�?，按同一个文件里的同伴断言与 companion-core.js:600 的拼法重建。
  assert(text.indexOf("关系：恋人") >= 0, "关系没进请求");
  // 「叫对方「阿林」」= charCallsUser 填的是「阿林」，companion-core.js:602 的拼法是「叫对方「…」」。
  // 受损处原文只剩「叫对方「阿林�?，按同一段的分页代码重建。
  assert(text.indexOf("叫对方「阿林」") >= 0, "称呼没进请求");
  assert(text.indexOf("答应过要一起看一次海") >= 0, "共同经历没进请求");
  // 「今天是 」= companion-core.js:609 的 今天是 + 空格 + 日期 那段拼法。
  // 受损处原文只剩「今天�?"，按那一行的拼法与候选里「伴侣段落跟着卡片语言走」用例的英文对照（Today is）重建。
  assert(text.indexOf("今天是 ") >= 0, "没告诉模型今天几号");
  // 「认识：2026-01-01 起」= companion-core.js:607 的 认识：+ since + 空格起 那段拼法。
  // 受损处原文只剩「认识�?026-01-01 �?，按那一行的拼法重建。
  assert(text.indexOf("认识：2026-01-01 起") >= 0, "关系起点没进请求");
  // 2026-09-12 起"允许有情绪"是明写的（旧措辞"不用内疚或冷淡留人"已经改成下面这两条）。
  // 受损处原文只剩「2026-09-12 �?允许有情�?是明写的（旧措辞"不用内疚或冷淡留�?已经改成下面这两条）�?，
  // 按候选里同名注释 + companion-core.js 的 RULES.zh 实际文案重建。
  for (const rule of ["不编造共同经历", "可以有情绪", "不用内疚", "不威胁", "不索取陪伴", "承认自己是程序"]) {
    assert(text.indexOf(rule) >= 0, "硬规矩没进请求：" + rule);
  }
  // 中文角色的段落不带英文模板，英文卡的段落也不该混中文（下面单独验证语言选择）。
  // 受损处原文只剩「英文卡的段落也不该混中文（下面单独验证语言选择）�?，按候选同一主题用例的这句注释重建。
  assert(await evaluate("document.querySelector('#companionEnabled').checked === true"), "保存后复选框状态不对");

  // 收尾：把这条用例写进 kv 的那份档案**删掉**，回到"从来没写过"的干净态。
  //
  // 为什么不是"写回 enabled:false"：档案本身还留在 kv 里，后面按"没打开伴侣模式"写断言的
  // 用例（伴侣模式默认关闭）会据此判成"带上了陪伴段落"—— 实测就是这么红了一次。
  // 走应用自己的保存入口先关掉（同步缓存一起更新），再把 kv 那条抹掉，最后读一次确认。
  const restored = await evaluate(`(async () => {
    const entry = { avatar: ${JSON.stringify(CUSTOM_AVATAR)}, charName: ${JSON.stringify(CUSTOM_NAME)} };
    await window.TASK21.saveCompanion(entry, { enabled: false });
    await RoleWorld.store.setKV("companion:" + ${JSON.stringify(CUSTOM_AVATAR)}, null);
    const left = await RoleWorld.store.getKV("companion:" + ${JSON.stringify(CUSTOM_AVATAR)}, null);
    return left === null || left === undefined;
  })()`);
  assert(restored, "收尾没把伴侣档案清干净，会串到后面的用例");
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

      // 自带前置：先自己发一轮，保证"最近一次请求"确实存在。
      // 原来这条读「上一轮请求」，单跑（--only 跳过前面用例）时 `sent` 是空的，
      // 报出来是 Cannot read properties of undefined (reading 'systemText') —— 缺前置，不是功能坏了。
      await sendOneTurn("伴侣没开时这一句不该带陪伴段落");
      const sent = requests.filter((row) => row.stream === true);
      const last = sent[sent.length - 1];
      assert(last && typeof last.systemText === "string", "发完一轮之后应当拿到请求里的系统提示");
      assert(last.systemText.indexOf("[陪伴模式]") < 0, "没打开伴侣模式却带上了陪伴段落");
      // 这一段就是"今天"聊的，所以「上次说到」不该出现。
      assert(await evaluate("document.querySelector('#chatRecapBar').hidden === true"),
        "今天刚聊过还提示「上次说到」");
      const stored = await evaluate("(async () => JSON.stringify(await RoleWorld.store.getKV('companion:Harry Potter (EN).png', null)))()");
      assert(stored === "null", "还没写过关系档案，kv 里不该有东西：" + stored);
    });

  await check("内置小说人物不做伴侣：老存档里开过也不生效，但**档案一个字都不删**", async () => {
    // 2026-09-14 用户拍板：「小说人物不设置伴侣……其他都是聊天」。
    // 这条盯两件事，缺一不可：
    //   ① 老存档里已经给内置角色开过伴侣的（用户的数据），**不能删**、也不能改写；
    //   ② 但它**不生效** —— 请求里既没有关系段落，也没有主动开口。
    // 为什么两件都要：只做 ① 会出现"内置角色仍然是伴侣"（跟拍板的规则相反）；
    // 只做 ② 会悄悄扔掉用户自己写过的档案（那是数据丢失）。
    const harryKey = "companion:Harry Potter (EN).png";
    const written = await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const profile = core.normalizeProfile({
        enabled: true, relation: 'partner', charCallsUser: '阿林',
        shared: [{ text: '第一次聊天是在雨天的图书馆' }],
        chatStyle: 'plain',
        proactive: { enabled: true, minGapHours: 12, maxPerDay: 1 },
        lastChatAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      });
      await RoleWorld.store.setKV(${JSON.stringify(harryKey)}, profile);
      return profile.enabled === true;
    })()`);
    assert(written, "前置条件不成立：没能把老存档那样的档案写进去");

    // 切到哈利那段对话（内置角色），发一句 —— 关系段落与"软件聊天"那两段都不该出现。
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    // 主动开口那一轮走的是**非流式** complete()：这里数一下，确认它没有偷偷发。
    const proactiveBefore = requests.filter((row) => row.path === "/v1/chat/completions" && row.stream !== true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '内置角色不该是伴侣';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const turn = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(turn, "这一轮没发出去");
    assert(turn.systemText.indexOf("[陪伴模式]") < 0, "内置角色的关系段落还是进了请求");
    assert(turn.systemText.indexOf("叫对方「阿林」") < 0, "内置角色的称呼还是进了请求");
    assert(turn.systemText.indexOf("聊天软件") < 0 && turn.systemText.indexOf("messaging app") < 0,
      "内置角色还是拿到了「软件聊天」那一段（那是伴侣 + 语音档才有的）");
    assert(requests.filter((row) => row.path === "/v1/chat/completions" && row.stream !== true).length === proactiveBefore,
      "内置角色还会主动开口（主动消息属于伴侣模式）");
    // ② 档案还在，而且一个字段都没被改写。
    const kept = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify(harryKey)}, null)) || null)()`);
    assert(kept && kept.enabled === true, "用户写的档案被删了或改坏了：" + JSON.stringify(kept));
    assert(kept.charCallsUser === "阿林" && Array.isArray(kept.shared) && kept.shared.length === 1,
      "档案内容被改写了：" + JSON.stringify(kept));
    // 收尾：把这段测试档案删掉（它本来就不该存在），并把对话切回定制角色那一段。
    await evaluate(`(async () => { await RoleWorld.store.setKV(${JSON.stringify(harryKey)}, null); return true; })()`);
    await openChatFor(CUSTOM_AVATAR, CUSTOM_NAME, CUSTOM_CHAT);
  });

  await check("统一角色面板：点角色名一步进去，设定 / 记忆 / 关系三页各就各位", async () => {
    // 本轮（2026-09-13）用户要求：把「角色记忆」弹窗、右侧「记忆书」栏、「关系档案」弹窗
    // 合成一个入口 —— 点对话顶栏的角色名打开，分「设定 / 记忆 / 关系」三页；
    // 顶栏「记忆」一步到记忆页；伴侣模式开关就在关系页，并写清对哪个角色生效。
    //
    // ⚠ 2026-09-14 起这一组用例跑在**定制角色**上（内置小说人物不做伴侣），
    //   所以这里**不能写死 "Harry"** —— 面板标题要跟着当前角色走，改用它自己的名字。
    if (!/index\.html/.test(await evaluate("location.pathname"))) {
      await goto(base + "/index.html?onboarding=off&surprise=off");
      await waitFor("window.TASK21_READY === true", 30000);
    }
    await evaluate("window.TASK21.closeCharacterPanel(); true");
    const who = (await activeCharacterName()) || "";
    assert(who, "读不到当前角色名（顶栏那颗按钮）");

    // ① 顶栏那颗按钮就是入口：真点击它（不是调内部函数）。
    const entry = await evaluate(`(() => {
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
    assert(!diagnostics.error, "打开角色面板报错了：" + diagnostics.error);
    assert(diagnostics.after && diagnostics.after.hidden === false, "角色面板没打开：" + JSON.stringify(diagnostics));

    // ② 顶栏那颗按钮的标题必须写上**当前这个角色**（不是写死某个人）。
    const title = await evaluate("document.querySelector('#characterPanelTitle').textContent || ''");
    assert(title.indexOf(who) >= 0, "面板标题没写是哪个角色（当前是 " + who + "）：" + title);

    // ③ 三页各就各位：设定页读到了角色卡正文，并写明角色卡文件与来源。
    await evaluate("document.querySelector(\"[data-character-tab='setup']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'setup'", 8000);
    // 真实结构：每个 .character-setup-row 里是 <strong>标签</strong><div>值</div>
    // （见 integration.js 的 renderCharacterSetup）。
    const setup = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#characterPaneSetup .character-setup-row'))
        .map((row) => ({
          label: (row.querySelector('strong') || {}).textContent || '',
          value: (row.querySelector('div') || {}).textContent || '',
        }));
      return { rows, count: rows.length };
    })()`);
    assert(setup.rows.some((row) => row.label === "角色卡文件") && setup.rows.some((row) => row.label === "来源"),
      "设定页应当写明角色卡文件与来源：" + JSON.stringify(setup.rows.map((r) => r.label)));

    // ④ 设定页里的「看它的记忆」= 切到记忆页，并且内容已经读好（data-ready）。
    await evaluate("document.querySelector(\"[data-action='character-tab-memories']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'memories'", 8000);
    const memoryTab = await evaluate(`(() => ({
      memoryVisible: document.querySelector('#memoryPanel').hidden === false,
      setupHidden: document.querySelector('#characterPaneSetup').hidden === true,
      hasList: !!document.querySelector('#memoryPanel #memoryList'),
      hasOrientation: !!document.querySelector('#memoryPanel #memoryList #memoryOrientation'),
    }))()`);
    assert(memoryTab.memoryVisible && memoryTab.setupHidden, "切到记忆页没生效：" + JSON.stringify(memoryTab));
    assert(memoryTab.hasList && memoryTab.hasOrientation, "记忆页没有内容：" + JSON.stringify(memoryTab));

    // ⑤ 关系页：伴侣模式开关在这里，并且说清对哪个角色生效。
    await evaluate("document.querySelector(\"[data-character-tab='relationship']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').dataset.ready === 'relationship'", 8000);
    const relation = await evaluate(`(() => {
      const subtitle = (document.querySelector('#companionSubtitle') || {}).textContent || '';
      const hint = (document.querySelector('#characterPanelHint') || {}).textContent || '';
      const check = document.querySelector('#companionEnabled');
      const label = check ? check.closest('label') : null;
      const r = label ? label.getBoundingClientRect() : null;
      return {
        subtitle, hint,
        switchVisible: !!(check && check.getBoundingClientRect().width > 0),
        rowH: r ? Math.round(r.height) : 0,
        switchText: label ? label.textContent.trim() : '',
      };
    })()`);
    assert(relation.switchVisible, "关系页里看不到伴侣模式开关");
    assert(relation.subtitle.indexOf(who) >= 0 || relation.hint.indexOf(who) >= 0,
      "关系页没写这份档案属于哪个角色（当前 " + who + "）：" + JSON.stringify({ subtitle: relation.subtitle, hint: relation.hint }));
    assert(relation.hint.indexOf("只对这个角色生效") >= 0 || relation.subtitle.indexOf("只对这个角色生效") >= 0,
      "关系页没说明伴侣模式的作用范围：" + relation.hint);
    assert(relation.switchText.indexOf("给这个角色") >= 0, "开关文案没说清是对哪个角色：" + relation.switchText);

    // ⑥ 顶栏「记忆」= 一步到当前角色的记忆页（真点击顶栏那颗按钮）。
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
    await waitFor("document.querySelector('#characterPanel').hidden === true", 8000);
    await evaluate("document.querySelector(\"[data-action='open-memories']\").click(); true");
    // 分工（用户 2026-09-13）：「手机版就直接弹出弹窗，电脑版就直接打开侧边栏」。
    if (await evaluate("window.innerWidth >= 900")) {
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

  await check("伴侣模式只属于这个角色：换个角色既没有档案，也没有它的段落", async () => {
    // 关系档案是按**角色**存的（kv 的 companion:<avatar>）。换一个角色不该继承别人的档案 ——
    // 这条同时挡住"档案串味"和"清记忆顺手删档案"。
    // 前置自带：先确保定制角色真的有一份开着的档案，否则"档案不见了"会假红。
    assert(await ensureCompanionProfile(CUSTOM_AVATAR), "前置条件不成立：没能给定制角色建好伴侣档案");
    const other = await evaluate(`(async () => {
      const profile = await window.TASK21.loadCompanion({ avatar: ${JSON.stringify("Harry Potter (EN).png")}, charName: 'Harry Potter' });
      return profile.enabled === true;
    })()`);
    assert(other === false, "另一个角色继承了别人的关系档案");
    const keys = await evaluate(`(async () => {
      const rows = await RoleWorld.store.getKV(${JSON.stringify("companion:Harry Potter (EN).png")}, null);
      return JSON.stringify(rows);
    })()`);
    assert(keys === "null", "另一个角色的档案不该存在：" + keys);
    // 而且这份档案不能被"清空记忆"顺手删掉：它是用户自己写的，不是模型记的。
    const still = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify("companion:" + CUSTOM_AVATAR)}, null) || {}).enabled === true)()`);
    assert(still === true, "关系档案不见了");
  });

  await check("关系档案：改口后以新的为准，而且是每轮都重新读一次", async () => {
    // 用户 2026-09-11 的两句话定的：档案改了立刻生效，而且**每一轮都重读**，
    // 不是"开对话时读一次就缓存住"。
    // 前置自带：这一组用例不该依赖前一条用例留下的状态。
    assert(await ensureCompanionProfile(CUSTOM_AVATAR), "前置条件不成立：没能给定制角色建好伴侣档案");
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
      input.value = '那你叫我一声试试';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    const text = sent[sent.length - 1].systemText;
    assert(text.indexOf("[陪伴模式]") >= 0, "伴侣段落没进请求（前置或注入坏了）：" + JSON.stringify(text.slice(0, 120)));
    assert(text.indexOf("叫对方「小林」") >= 0,
      "改过之后的称呼没生效：" + text.slice(text.indexOf("[陪伴模式]"), text.indexOf("[陪伴模式]") + 160));
    assert(text.indexOf("叫对方「阿林」") < 0, "旧的称呼还在请求里");
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
    await evaluate("window.TASK21.openCompanionDialog()");
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
    await evaluate("window.TASK25C_UI.setMemoryPanelOpen ? window.TASK25C_UI.setMemoryPanelOpen(true) : null; true");
    await new Promise((r) => setTimeout(r, 400));
    const columnEntry = await evaluate(probeEntry(".inspector-column [data-action='open-companion']"));
    assert(columnEntry.exists, "右侧记忆栏里没有「关系档案」入口");
    assert(columnEntry.visible, "右侧记忆栏里的入口看不见（0 尺寸）");
    assert(columnEntry.reachable, "右侧记忆栏里的入口点不到（被别的元素盖住）");

    // ② 弹层里的入口（要先打开弹层才量得到）
    await evaluate("window.TASK21.openMemoryPanel()");
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
    // 先把它滚进视野 —— 真人也是滚动之后才点得到的；点一个屏幕外的控件再怪菜单位置不对，
    // 那不是界面的问题（2026-09-13 合并角色面板时就误判过一次）。
    const neglect = await evaluate(`(() => {
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
    assert(neglect.count >= 3, "「久没聊时的态度」下拉里没有选项：" + JSON.stringify(neglect));
    assert(neglect.inView, "「久没聊时的态度」的下拉菜单跑到视口外了：" + JSON.stringify(neglect));
    assert(neglect.after !== neglect.before, "点了下拉里的选项，值没写回去：" + JSON.stringify(neglect));
    assert(neglect.menuClosed, "选完之后菜单没有关掉：" + JSON.stringify(neglect));
    await evaluate(`(() => { document.querySelector('#companionNeglect').value = 'soft'; return true; })()`);
    // 设置里也有一个入口（同一个 data-action，接线是共用的）。
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
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

    await evaluate("window.TASK21.openCompanionDialog()");
    await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
    const check = await evaluate("document.querySelector('#companionCheck').textContent");
    assert(check.indexOf("内疚话术") >= 0, "自检没有指出内疚话术：" + check);
    assert(check.indexOf("你都不理我") >= 0, "自检没有给出命中的原话：" + check);
    // 只报告，不改写：原话应该还在对话里。
    assert((await evaluate("document.querySelector('#dynamicMessages').textContent")).indexOf("你都不理我了") >= 0,
      "自检把模型的话改掉了");
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
    await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
  });

  await check("伴侣 v2：亲近度 / 冷落档 / 主动消息三个控件能存能读（默认关、有上限）", async () => {
    // 2026-09-12 用户拍板：伴侣类可以有主动消息 / 亲近度 / 冷落反应，条件是提示词符合类型。
    //
    // ⚠ 2026-09-14 起伴侣只给**定制角色**开，所以这条必须跑在定制角色上、并且读**它自己的**档案。
    //   原来写死 `companion:Harry Potter (EN).png`：对话框里填的其实是当前角色（林默），
    //   于是读回来是 null，报成 `Cannot read properties of null (reading 'affinityMode')`
    //   —— 是测试写错了目标，不是功能坏了。
    const avatar = await ensureCustomCharacter();
    assert(await enableCompanionPlain(avatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
    const key = "companion:" + avatar;

    await evaluate("window.TASK21.openCompanionDialog()");
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
    for (const field of ["affinity", "auto", "neglect", "proactive", "gap", "max"]) {
      assert(form[field], "关系档案里缺控件：" + field);
    }
    assert(form.proactiveChecked === false, "主动消息必须默认关");

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

    const saved = await evaluate(`(async () => (await RoleWorld.store.getKV(${JSON.stringify(key)}, null)))()`);
    assert(saved, "关系档案没存下来（读回来是空的）：" + JSON.stringify(key));
    assert(saved.affinityMode === "manual" && saved.affinity === 77,
      "亲近度没存上：" + JSON.stringify({ mode: saved.affinityMode, value: saved.affinity }));
    assert(saved.neglect === "off", "冷落档没存上：" + saved.neglect);
    assert(saved.proactive && saved.proactive.enabled === true
      && saved.proactive.minGapHours === 24 && saved.proactive.maxPerDay === 2,
      "主动消息的设置没存上：" + JSON.stringify(saved.proactive));
  });

  await check("伴侣 v2：打开对话时它先开口（主动消息，一天一条就够）", async () => {
    // 造一个"隔了 5 天没聊 + 开着主动消息"的档案，然后整页重载 —— 真人是"回来打开应用"。
    //
    // ⚠ 2026-09-14 起伴侣只给**定制角色**开，而"主动开口"是在**当前角色的会话**上判的。
    //   原来写死 `companion:Harry Potter (EN).png`：档案落在 Harry 名下，
    //   门槛却在林默的会话上按"刚聊过"判 → `decision:too-soon`（测试写错了目标）。
    //   （应用侧判定自洽：间隔 < minGapHours 时 too-soon 是设计行为，见 diag-proactive2.cjs。）
    const avatar = await ensureCustomCharacter();
    assert(await enableCompanionPlain(avatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
    const key = "companion:" + avatar;
    await openChatFor(avatar, CUSTOM_NAME, CUSTOM_CHAT);

    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const entry = { avatar: ${JSON.stringify("林默.png")}, charName: ${JSON.stringify("林默")} };
      const previous = (await window.TASK21.loadCompanion(entry)) || {};
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
      // 走应用自己的保存入口：直接写 kv 会绕过同步缓存，判定读到的还是旧的。
      await window.TASK21.saveCompanion(entry, core.normalizeProfile(Object.assign({}, previous, {
        enabled: true, chatStyle: 'plain', shared: [{ text: '第一次聊天是在雨天的图书馆' }],
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
        const profile = await RoleWorld.store.getKV(${JSON.stringify(key)}, null);
        const settings = await RoleWorld.getLocalSettings();
        const apiKey = await RoleWorld.secrets.get('api_key_deepseek');
        return { profile: profile ? { enabled: profile.enabled, proactive: profile.proactive, lastChatAt: profile.lastChatAt } : null,
                 decision: profile ? core.proactiveDecision(profile, new Date()) : null,
                 provider: settings.provider, keySet: !!((apiKey || {}).value) };
      })()`);
      assert(fired, "打开对话时没有主动开口：" + why + " / " + JSON.stringify(diag));
    }
    assert(String(fired.systemText).indexOf("像真人") >= 0, "主动开口那条指令里没写「像真人」");
    assert(String(fired.systemText).indexOf("不要问他为什么这么久没来") >= 0, "主动开口那条指令缺「不许追问」的约束");
    const log = await evaluate(`(async () => ((await RoleWorld.store.getKV(${JSON.stringify(key)}, null)) || {}).proactiveLog || '')()`);
    const today = await evaluate("window.ROLEWORLD_COMPANION_CORE.isoDay(new Date())");
    assert(String(log).indexOf(today + "|1") === 0, "今天主动发了几条没记上：" + log);
    // 再重载一次：同一天不该再开口（每日上限 1）。
    const beforeSecond = plainCalls().length;
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await sleep(2000);
    const again = plainCalls().slice(beforeSecond).filter((row) => String(row.systemText).indexOf("你先开口") >= 0);
    assert(again.length === 0, "同一天又主动开口了一次（每日上限没生效）");
    // 收尾：关掉伴侣模式、清掉测试用的 key，恢复现场。
    await evaluate(`(async () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const current = (await RoleWorld.store.getKV(${JSON.stringify(key)}, null)) || {};
      await RoleWorld.store.setKV(${JSON.stringify(key)}, core.normalizeProfile(Object.assign({}, current, { enabled: false })));
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
  await check("设置 → 语音：只列能发语音的角色，可选兼容音色、落盘后刷新仍一致、不串别的角色", async () => {
    // 自带前置：页面 / 定制角色 / 伴侣 + 软件聊天档 —— 这三样缺一个，语音页就是空的。
    await ensureChatPage();
    const eligibleAvatar = await ensureCustomCharacter();
    await enableCompanionPlain(eligibleAvatar);
    const ready = await openAppWithVoice();
    assert(ready.canSpeak, "前置不成立：这台设备现在不能朗读 —— " + ready.reason);

    // 记下原始设置：收尾要还原，别把音色选择留给后面的用例。
    const before = JSON.parse(await evaluate("(async () => JSON.stringify((await RoleWorld.getLocalSettings()).voice_by_card || {}))()"));

    const openVoicePanel = async () => {
      await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
      await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
      await evaluate("window.TASK25C_UI.setSettingsSection('voice'); true");
      // 切到这一页之后角色列表是异步渲染的：等**行**出现，而不是等一个固定时长。
      await waitFor("document.querySelectorAll('#voiceVoiceList [data-voice-card]').length >= 1", 15000);
    };

    // ① 只列能发语音的角色。
    //    2026-09-16 规则变了（文档 §1/§3「朋友也可以发语音」）：**只挡内置小说人物**。
    //    所以这一页会列出所有自定义/导入的角色，内置的一个都不出现。
    await openVoicePanel();
    const listed = await evaluate("JSON.stringify(Array.from(document.querySelectorAll('#voiceVoiceList [data-voice-card]')).map((n) => n.dataset.voiceCard))");
    const avatars = JSON.parse(listed);
    assert(avatars.length >= 1, "语音页一行都没有（自定义角色应该都在里面）：" + listed);
    assert(avatars.indexOf(eligibleAvatar) >= 0, "语音页里没有那个自定义角色：" + listed);
    assert(avatars.every((one) => BUILTIN_AVATARS.indexOf(one) < 0),
      "语音页里出现了内置小说人物（那一档不发语音）：" + listed);

    // ② 音色下拉：选项来自中转、按语言分组、没有漏网的散选项。
    const selectors = JSON.stringify(eligibleAvatar);
    const roster = await evaluate(`(() => {
      const row = document.querySelector('#voiceVoiceList [data-voice-card="' + ${selectors} + '"]');
      const select = row.querySelector('select[data-voice-speaker]');
      const rate = row.querySelector('input[data-voice-field="speechRate"]');
      return {
        hasSelect: !!select,
        hasRate: !!rate,
        options: select ? Array.from(select.querySelectorAll('option')).map((o) => o.value) : [],
        groups: select ? Array.from(select.querySelectorAll('optgroup')).map((g) => g.label) : [],
        ungrouped: select ? Array.from(select.querySelectorAll('option')).filter((o) => !o.closest('optgroup')).length : -1,
        selected: select ? select.value : '',
        hasTest: !!row.querySelector('[data-voice-test]'),
        hasReset: !!row.querySelector('[data-voice-reset]'),
      };
    })()`);
    assert(roster.hasSelect, "这一行没有音色下拉");
    assert(roster.hasRate, "这一行没有语速滑杆");
    assert(roster.options.length >= VOICE_SPEAKERS.length,
      "音色下拉的选项比中转给的还少：" + JSON.stringify(roster.options));
    // 选项必须是**中转真的支持**的那些（拿假服务端的音色表对照）。
    const supported = VOICE_SPEAKERS.map((one) => one.id);
    assert(roster.options.every((id) => supported.indexOf(id) >= 0),
      "下拉里出现了中转没开放的音色：" + JSON.stringify(roster.options.filter((id) => supported.indexOf(id) < 0)));
    assert(roster.groups.length >= 1, "音色下拉没有分组（二百多个音色不分组没法挑）");
    assert(roster.ungrouped === 0, "有选项没被分到组里：" + JSON.stringify(roster));
    assert(roster.options.indexOf(roster.selected) >= 0, "选中的音色不在选项里：" + roster.selected);
    assert(roster.hasTest && roster.hasReset, "缺少「试听 / 恢复默认」按钮：" + JSON.stringify(roster));

    // ③ 挑一个**与当前不同**的兼容音色 → 必须落盘到 voice_by_card（按角色存）。
    const wanted = roster.options.find((id) => id !== roster.selected) || roster.options[0];
    await evaluate(`(() => {
      const select = document.querySelector('[data-voice-card="' + ${selectors} + '"] select[data-voice-speaker]');
      select.value = ${JSON.stringify(wanted)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(`(async () => ((await RoleWorld.getLocalSettings()).voice_by_card || {})[${JSON.stringify(eligibleAvatar)}]?.speaker === ${JSON.stringify(wanted)})()`, 8000);
    const stored = JSON.parse(await evaluate(`(async () => JSON.stringify((await RoleWorld.getLocalSettings()).voice_by_card || {}))()`));
    assert(stored[eligibleAvatar] && stored[eligibleAvatar].speaker === wanted,
      "挑的音色没有落盘到这个角色名下：" + JSON.stringify(stored));

    // ④ 刷新之后仍然一致（"保存了但重开就变回去"是这个项目反复踩过的坑）。
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await openVoicePanel();
    const afterReload = await evaluate(`(() => {
      const select = document.querySelector('[data-voice-card="' + ${selectors} + '"] select[data-voice-speaker]');
      return select ? select.value : null;
    })()`);
    assert(afterReload === wanted, "刷新之后选中的音色变回去了：" + JSON.stringify({ wanted, afterReload }));

    // ⑤ 不影响其他角色：这次改动只写进了这一个角色名下，别处没有多出来的键。
    const keysAfter = Object.keys(stored);
    const extra = keysAfter.filter((key) => key !== eligibleAvatar && !before[key]);
    assert(extra.length === 0, "挑音色串到了别的角色身上：" + JSON.stringify(extra));

    // 收尾：还原这个角色的音色覆盖，并且把设置面板关掉（面板是浮层，留着会挡住后面的用例）。
    await evaluate(`(async () => {
      const next = Object.assign({}, (await RoleWorld.getLocalSettings()).voice_by_card || {});
      if (${JSON.stringify(before)}[${JSON.stringify(eligibleAvatar)}] === undefined) delete next[${JSON.stringify(eligibleAvatar)}];
      else next[${JSON.stringify(eligibleAvatar)}] = ${JSON.stringify(before)}[${JSON.stringify(eligibleAvatar)}];
      await RoleWorld.saveLocalSettings({ voice_by_card: next });
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { voice_by_card: next } }));
      return true;
    })()`);
    await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
    // ⚠ **必须把接口还原成直连**（整页重载并不会：`card_relay` 还在设置里，卡就还是活的）。
    //
    // 为什么（2026-09-15 完整套件实测）：这一条用 `openAppWithVoice()` 进来 = 整页带卡打开，
    // 接口指向**体验卡中转**。不还原的话，后面十几条用例会连锁红，而且是各种不像样的症状：
    //   · 「AI 写角色」三条：请求 path=/relay/…（假端点那两条分支永远不命中）→ 20 秒超时；
    //   · 「生成参数面板」：拿到的"上一轮请求"是中转那一条，temperature 是 undefined；
    //   · 「思考模式」：include_reasoning=undefined（中转那条路由不记这个字段）；
    //   · 「设置面板能读到本机模型配置」：端点显示成 …/relay/…；
    //   · 「撞上输出上限」：靠 failext/truncate 开关的假端点根本收不到请求。
    // 和两条语音用例的 finally 里做的是同一件事（那里已经写过这个教训）。
    await closeAppWithVoice();
  });
  await check("回复语言校验：角色该说中文而回了英文时，界面给可恢复提示、原文不删、也不交给中文音色", async () => {
        // 用户 2026-09-14 定的规则：语言是**角色的交流规则**，不该因为用户某一句输入就切换；
        // 用户 2026-09-15 又要求：不合语言的回复要能看见、能恢复，**不能拿它去合成语音**、
        // 不能删字凑合规，也不能无限重试。
        //
        // ⚠ 这条与「角色语言：默认跟角色卡自己…」是**两条不同的目标**：
        //   那一条测的是"提示词里注入了哪条语言要求"（设置与提示词），
        //   这一条测的是"模型真回了错语言之后，应用怎么处理"（校验、提示、落盘、TTS 闸门）。
        await goto(base + "/index.html");
        await waitFor("window.TASK21_READY === true", 30000);
        const avatar = await ensureCustomCharacter();                 // 定制角色（fixture 里没写语言标记）
        assert(await enableCompanionPlain(avatar), "前置条件不成立：伴侣 + 软件聊天没打开");
        // 把它的交流语言显式设成中文（用户在设置里选的，写 language_by_card）。
        // ⚠ 只改**这一个角色**那一项：整张 map 一起读出来再写回，别覆盖别人的设置；
        //   previousLang 留着收尾还原 —— 用例之间共用同一份存档，留脏会污染后面的用例
        //   （真踩过：Harry 也被写上了 zh，让「角色语言」那条红成"开关记到了别的角色上"）。
        const previousLang = await evaluate("(async () => ((await RoleWorld.getLocalSettings()).language_by_card || {}))()");
        await evaluate(`(async () => {
          const map = Object.assign({}, (await RoleWorld.getLocalSettings()).language_by_card || {});
          map[${JSON.stringify("林默.png")}] = "zh";
          await RoleWorld.saveLocalSettings({ language_by_card: map });
          window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { language_by_card: map } }));
          return true;
        })()`);
        await openChatFor(avatar, CUSTOM_NAME, CUSTOM_CHAT);
        reportErrors("回复语言校验");

        // 让这一轮模型**故意回一整句英文**（角色设定是中文）。
        const wrong = "I will not switch to Chinese for you.";
        await evaluate(`(async () => {
          await fetch('/__reply-clear', { method: 'POST' });
          await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '${wrong}' }) });
          return true;
        })()`);
        await evaluate(`(() => {
          const input = document.querySelector('#messageInput');
          input.value = '说句话';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#sendButton').click();
          return true;
        })()`);
        await waitTurnSettled();
        await sleep(600);

        // ① **原文一个字都不少**（不删字凑合规），而且界面上看得到它。
        const shown = await evaluate(`(() => {
          const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
          const last = rows[rows.length - 1];
          return last ? window.__rwReadAssistantText(last) : '';
        })()`);
        assert(shown.indexOf(wrong) >= 0, "错语言的原文没显示出来（不该删字）：" + JSON.stringify(shown.slice(0, 120)));

        // ② 界面上有**可恢复的提示**（说明哪里不对 + 让用户去改），并且落盘可查。
        const notice = await evaluate(`(() => {
          const node = document.querySelector('#dynamicMessages .message-language');
          return node ? { text: node.textContent || '', hasFix: !!node.querySelector('.message-language-fix') } : null;
        })()`);
        assert(notice, "没有出现「语言对不上」的说明（用户不知道发生了什么）");
        assert(notice.text.indexOf("中文") >= 0 && notice.text.indexOf("English") >= 0,
          "说明里要写清角色该说哪种语言、实际回了哪种：" + JSON.stringify(notice.text));
        assert(notice.hasFix, "提示里没有「改这个角色的语言」这个去处（只能看不能改）");

        const stored = await evaluate(`(async () => {
          const fileName = window.TASK21.activeChatFileName();
          const lines = await window.STApi.getChat(${JSON.stringify("林默.png")}, fileName).catch(() => null);
          const last = Array.isArray(lines) ? lines.filter((l) => l && typeof l.mes === 'string').pop() : null;
          return last ? { mes: last.mes, extra: last.extra || null } : null;
        })()`);
        assert(stored && stored.extra && stored.extra.roleworld_language,
          "语言不符这件事没有跟着消息落盘（刷新就看不到了）：" + JSON.stringify(stored && stored.extra));
        assert(stored.mes.indexOf(wrong) >= 0, "落盘的正文被改动了（不许删字）：" + JSON.stringify((stored.mes || '').slice(0, 100)));
        reportErrors("回复语言校验（界面与落盘）");

        // 收尾：把语言设置还原成跑之前的样子（不留脏给后面的用例）。
        await evaluate(`(async () => {
          await RoleWorld.saveLocalSettings({ language_by_card: ${JSON.stringify(previousLang)} });
          window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { language_by_card: ${JSON.stringify(previousLang)} } }));
          return true;
        })()`).catch(() => {});
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

    await evaluate("window.TASK21.openCompanionDialog()");
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
    await evaluate("window.TASK21.openMemoryPanel()");
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
    await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
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
    // 自带前置：先自己发一轮，拿到"当前参数"的真实请求。
    // 原来这里直接读「上一轮请求」——单跑（--only 跳过前面用例）时那是空的，
    // 报出来是 Cannot read properties of undefined：那是缺前置，不是功能坏了。
    await sendOneTurn("生成参数面板的基线这一句");
    const before = requests.filter((row) => row.stream === true);
    const baseRequest = before[before.length - 1];
    assert(baseRequest && typeof baseRequest.temperature === "number",
      "发完一轮之后请求里应当带着温度：" + JSON.stringify(baseRequest || null));
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
    // 自带前置：先自己发一轮再检查"请求里没有要思维链"。
    // 原来直接读「上一轮请求」——单跑时没有请求，会报 undefined，那是缺前置。
    await sendOneTurn("思考模式默认关着这一句");
    await waitTurnSettled();
    const sent = requests.filter((row) => row.stream === true);
    assert(sent.length > 0, "自带前置：这一条至少需要一轮真实请求");
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

  await check("设置 → 连接方式：选「使用体验卡」必须**看得见填卡号的地方**", async () => {
  // 用户 2026-09-14 实测：「而且选择方式的时候，没有填卡号的地方」。
  // 真因：点「使用体验卡」时只写了一句"粘到下面的输入框"，却**从来没把那一块显示出来**
  // （#connectionCardBlock 一直是 hidden），而且 focus 了一个看不见的框。
  // 线上 0.1.54 也有这个问题 —— 所以这条用例钉的是用户真实会走的路径。
  // [repair 补前置] 单跑（--only=）时页面可能停在 /magic-map.html，TASK21 不会挂上去：
  //   照 ensureChatPage() 自己的说明先显式切回对话页。原位插入时这一行是幂等的。
  await ensureChatPage();
  // [repair 补前置] 原文没记原始设置就改；先记一份，供收尾还原。
  const settingsBefore = JSON.parse(await evaluate("(async () => JSON.stringify(await RoleWorld.getLocalSettings()))()"));
  // 造一个「没在用卡」的干净状态
  await evaluate(`(async () => {
    await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "" });
    await RoleWorld.secrets.remove("api_key_custom");
    return true;
  })()`);
  // [repair 补收尾] 原文改完设置就走了：这条用例会把连接方式切成体验卡、把 provider 写死成
  //   deepseek、并往 api_key_custom 里塞卡号 —— 后面的用例（直连假模型端点那些）就再也打不到
  //   假服务端了。照候选里同主题用例（体验卡：粘一条卡号就能用…）的收尾写：还原设置、清掉卡号，
  //   并且**通知页面**（saveLocalSettings 只落盘，不会改内存里的 liveState）。
  const restoreSettings = () => evaluate(`(async () => {
    await RoleWorld.saveLocalSettings({
      provider: ${JSON.stringify(settingsBefore.provider || "deepseek")},
      endpoint: ${JSON.stringify(settingsBefore.endpoint || "")},
      card_relay: ""
    });
    await RoleWorld.secrets.remove("api_key_custom");
    window.dispatchEvent(new CustomEvent("roleworld:settings-changed", {
      detail: { provider: ${JSON.stringify(settingsBefore.provider || "deepseek")}, endpoint: ${JSON.stringify(settingsBefore.endpoint || "")}, card_relay: "" }
    }));
    return true;
  })()`).catch(() => {});
  try {
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
      // 光"看得见"不够：看得见点不到也是白搭（这个项目踩过好几次）。
      reachable: !!(top && input && (top === input || input.contains(top))),
      blockedBy: (top && input && top !== input && !input.contains(top))
        ? (top.tagName + "." + String(top.className || "").split(" ")[0]) : "",
      placeholder: input ? input.placeholder : "",
      checked: cardRadio.checked,
      status: (document.querySelector('[data-roleworld="connection-status"]') || {}).textContent || "",
    };
  })()`);
  assert(result.before.blockHidden === true, "前置条件不成立：还没选体验卡，那一块就已经露出来了");
  assert(result.blockHidden === false, "选了「使用体验卡」，填卡号的那一块还是隐藏的（用户：没有填卡号的地方）");
  assert(result.inputVisible, "卡号输入框没有尺寸（看不见）" + JSON.stringify(result));
  assert(result.reachable, "卡号输入框看得见但点不到" + JSON.stringify(result));
  assert(/RW-/.test(result.placeholder), "输入框提示要告诉用户粘什么：" + result.placeholder);
  assert(result.checked, "点完之后单选没切到「使用体验卡」：" + JSON.stringify(result));
  await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
  await sleep(300);
  } finally {
    await restoreSettings();
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

  await check("贴卡成功要有明确的成功确认（设置页不能只剩「体验卡：额度」）", async () => {
    // 用户实测（2026-09-17）：「能否给体验卡成功做个东西，反正现在是一点就全部消失，也没什么显示」。
    // Union Alpha 只读复核定位（settings-ui.js:489-514）：设置页 `useCard()` 成功后清空输入 →
    //   `refresh()` 里 `refreshCardStatus()` 把这一行改写成「正在查额度…」再「体验卡：额度」——
    //   "刚刚贴上就成功了"这一刻根本不存在，用户只看到粘贴的内容消失。
    // ⚠ 诚实说明：这一条的红色基线没有单独跑过（修复先落地、用例后写）；依据是上面那次只读复核
    //   给出的行号证据 + 同机制的引导侧复现。此处断言的是"必须有明确成功确认"这个可验证事实。
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
      // 先等额度那次刷新落定，再确认成功确认**没有被冲掉**（这正是原来的毛病）。
      await waitFor("document.querySelector('[data-roleworld=\"card-status\"]').textContent.indexOf('剩 4 次') >= 0", 10000);
      await sleep(1200);
      const state = await evaluate(`(() => {
        const node = document.querySelector('[data-roleworld="card-status"]');
        return {
          text: node.textContent,
          isOk: node.classList.contains("is-ok"),
          inputCleared: (document.querySelector('[data-roleworld="card"]') || {}).value === "",
        };
      })()`);
      assert(state.text.indexOf("已启用") >= 0,
        "成功之后必须有一句说得清的确认（而不是只剩「体验卡：额度」）：" + JSON.stringify(state));
      assert(state.text.indexOf("剩 4 次") >= 0, "成功确认里要带上额度（用刚查过的那次，不再发第二次请求）：" + JSON.stringify(state));
      assert(state.isOk === true, "成功确认要有成功样式，不能和普通状态长一个样：" + JSON.stringify(state));
      assert(state.inputCleared === true, "卡号本身不该留在输入框里（凭据不回显）：" + JSON.stringify(state));
    } finally {
      await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true").catch(() => {});
      // 自己还原成 fixture 状态（`restoreSettings` 定义在更窄的作用域里，这里取不到）：
      // 不然这条用例会把连接方式留在"体验卡/自定义"，后面的直连用例就打不到假模型端点了。
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", card_relay: "" });
        await RoleWorld.secrets.remove("api_key_custom");
        return true;
      })()`).catch(() => {});
      await evaluate("window.TASK21 && typeof window.TASK21.reloadSettings === 'function' && window.TASK21.reloadSettings(); true").catch(() => {});
      await closeAppWithVoice().catch(() => {});
    }
  });

  await check("贴卡刷新故障：页面保留且必须有最终提示，不得静默吞错", async () => {
    await ensureChatPage();
    try {
      await evaluate("document.querySelector('[data-action=\"open-settings\"]').click(); window.TASK25C_UI.setSettingsSection('connection'); true");
      await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
      await evaluate("document.querySelector('[data-roleworld=\"connection-card\"]').click(); true");
      await sleep(1000);
      await evaluate(`(() => {
        window.__cardFault = { errors: [], hits: 0, init: RoleWorld.init, onerror: window.onerror };
        window.onerror = (message) => { __cardFault.errors.push(String(message)); };
        __cardFault.rejection = (event) => { __cardFault.errors.push(String(event.reason)); };
        window.addEventListener('unhandledrejection', __cardFault.rejection);
        RoleWorld.init = async () => { __cardFault.hits++; throw new Error('TEST_CARD_REFRESH_INIT'); };
        document.querySelector('[data-roleworld="card"]').value = 'RW-AAAAA-BBBBB-CCCCC@${base}/relay';
        document.querySelector('[data-roleworld="card-use"]').click();
        return true;
      })()`);
      await waitFor("window.__cardFault.hits > 0", 10000);
      await sleep(1200);
      const state = await evaluate(`(() => {
        const surface = document.querySelector('#settingsSurface');
        const status = document.querySelector('[data-roleworld="card-status"]');
        const button = document.querySelector('[data-roleworld="card-use"]');
        const r = button.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { hidden: surface.hidden, visibleText: surface.innerText.trim().length,
          status: status.innerText, inputCleared: document.querySelector('[data-roleworld="card"]').value === '',
          reachable: !!top && (top === button || button.contains(top)),
          mainInert: document.querySelector('#mainStage').inert, errors: __cardFault.errors, hits: __cardFault.hits };
      })()`);
      console.log('        CARD_REFRESH_FAULT ' + JSON.stringify(state));
      assert(!state.hidden && state.visibleText > 0 && state.reachable, '贴卡后设置页变空或点不到：' + JSON.stringify(state));
      assert(state.status.trim().length > 0, '贴卡后没有提示');
      assert(state.errors.length === 0, '浏览器 JS 错误：' + JSON.stringify(state.errors));
      assert(/已启用|失败|没用上/.test(state.status) && !/^正在/.test(state.status),
        '刷新失败后缺少最终成功/失败提示：' + JSON.stringify(state));
    } finally {
      await evaluate(`(async () => {
        if (window.__cardFault) {
          RoleWorld.init = __cardFault.init;
          window.onerror = __cardFault.onerror;
          window.removeEventListener('unhandledrejection', __cardFault.rejection);
          delete window.__cardFault;
        }
        document.querySelector('[data-action="close-settings"]')?.click();
        await RoleWorld.saveLocalSettings({ provider: 'deepseek', endpoint: '${base}/v1/chat/completions', card_relay: '' });
        await RoleWorld.secrets.remove('api_key_custom');
        if (typeof window.TASK21?.reloadSettings === 'function') await window.TASK21.reloadSettings();
        return true;
      })()`);
      assert(await evaluate("!document.querySelector('#mainStage').inert && document.querySelector('#settingsSurface').hidden"),
        '关闭设置后 hidden/inert 状态未恢复');
    }
  });

  await check("发表情：点一张必须真的发出去（面板在输入框里，点击不能被漏掉）", async () => {
    // 用户实测（2026-09-18）：「表情包能够打开但是选中之后发送不了」。
    // 真因：面板挂在 `.composer-box`（index.html:198-205），而处理点击的那段委托绑在
    //   `#dynamicMessages`（integration.js:8603-8636）—— 两者是**兄弟节点**，事件到不了处理器，
    //   `sendSticker()` 从来没被调用过（面板能开、点了没反应）。
    //   这是同一个坑的重演：integration.js:8637-8641 的注释记着「设置 → 语音」的试听按钮
    //   就是因为挂在 #dynamicMessages 委托上而点不动，当时的修法是搬到 document 委托。
    // ⚠ 这条路径在浏览器级用例里**从来没有覆盖过**（local-app-check 里搜"表情"是 0 命中，
    //   只有单元级 sticker-unit），所以它能一直活到线上。
    // ⚠ 判据用**发送前后的条数差**，不能用"有没有用户消息" —— 切进来的对话本来就有一条
    //   （openChatFor 造的），那样写会假通过（这个项目反复踩的坑）。
    await ensureChatPage();
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    await fetch(base + "/__reply-clear", { method: "POST" });
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "（看到你发的表情了）" }) });
    // ⚠ 判据必须落在**表情标记本身**上，不能只比"用户消息条数"：
    //   整套跑时，切对话的重绘会和我取基准数的时机重叠 —— 基准数取到的是**上一段对话**
    //   的行数，两边都数到同一个数字，计数没变就被误判成"没发出去"（2026-09-18 实测踩到，
    //   单独跑/半程跑都是过的）。`[玩家发了一个表情：…]` 只可能由 sendSticker 产生，
    //   而且它进的是**消息记录**（不是输入框），所以它的出现就是"真的发出去了"。
    //   等对话渲染落定再取基准数，同时保留条数做一次"没变少"的兜底。
    await sleep(700);
    const before = await evaluate(`(() => {
      const button = document.querySelector('#stickerButton');
      const rect = button ? button.getBoundingClientRect() : null;
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      return { found: !!button, hidden: button ? button.hidden === true : null,
        w: rect ? Math.round(rect.width) : 0,
        users: rows.filter((row) => row.className.indexOf('message-row-user') >= 0).length,
        // 用户侧表情图的张数（发送成功的判据 —— 见下面 after 里的说明）
        userStickerImgs: document.querySelectorAll('#dynamicMessages .message-row-user .message-sticker img').length };
    })()`);
    assert(before.found && before.hidden === false && before.w > 0,
      "前置不成立：发表情按钮没露出来（有内置表情包就该露）：" + JSON.stringify(before));
    await evaluate("document.querySelector('#stickerButton').click(); true");
    await waitFor("!!document.querySelector('.sticker-picker')", 8000);
    const shape = await evaluate(`(() => {
      const panel = document.querySelector('.sticker-picker');
      return { items: document.querySelectorAll('.sticker-picker-item').length,
        // 这条 bug 的成因就在这个 false 上：面板不在 #dynamicMessages 里面
        inMessageArea: !!(panel && panel.closest && panel.closest('#dynamicMessages')) };
    })()`);
    assert(shape.items > 0, "面板里一张表情都没有：" + JSON.stringify(shape));
    await evaluate("document.querySelector('.sticker-picker-item').click(); true");
    await waitTurnSettled();
    await sleep(600);
    const after = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      const users = rows.filter((row) => row.className.indexOf('message-row-user') >= 0);
      const last = users[users.length - 1] || null;
      const bubble = last ? last.querySelector('.message-bubble') : null;
      return { pickerGone: !document.querySelector('.sticker-picker'), users: users.length,
        userStickerImgs: document.querySelectorAll('#dynamicMessages .message-row-user .message-sticker img').length,
        // ① 自己那条必须是**图**（用户 2026-09-18：「发送的是文字：[玩家发送了一个表情：惊讶]」）
        userStickerImg: last ? !!last.querySelector('.message-sticker img') : false,
        userStickerSrc: last && last.querySelector('.message-sticker img')
          ? String(last.querySelector('.message-sticker img').getAttribute('src') || '') : '',
        // ② 那行**给模型看的标记**不该出现在气泡里
        bubbleText: bubble ? String(bubble.textContent || '').trim() : '',
        lastUserText: last ? String(last.textContent || '').trim().slice(0, 60) : '' };
    })()`);
    console.log('        STICKER_SEND ' + JSON.stringify({ shape, before: { users: before.users }, after }));
    assert(after.pickerGone === true, "点完一张之后面板要收起来：" + JSON.stringify(after));
    // ⚠ 判据是**用户侧表情图的张数变多**，不是"消息里有那行标记文字"：
    //   标记渲染成图之后文字就不在 DOM 里了（这正是修复的目标），拿文字当判据会自相矛盾。
    //   也不比"消息条数"：整套跑时切对话的重绘和取基准数的时机重叠，两边会数到同一个数字
    //   （2026-09-18 实测踩到过，误判成"没发出去"）。
    assert(after.userStickerImgs > before.userStickerImgs,
      "点一张表情必须真的把它当成一条消息发出去（现在点了完全没反应）：" + JSON.stringify(after));
    assert(after.users >= before.users,
      "发完之后「我」的消息不该变少（重绘把内容弄丢了）：" + JSON.stringify(after));
    assert(after.userStickerImg === true && after.userStickerSrc.length > 0,
      "自己发的表情必须渲染成图（不能把那行标记当文字显示出来）：" + JSON.stringify(after));
    assert(after.bubbleText.indexOf("玩家发了一个表情") < 0,
      "气泡里不该出现给模型看的原始标记：" + JSON.stringify(after));
  });

  await check("角色发表的也会渲染成图（存下来的表情跟着消息走）", async () => {
    // 用户 2026-09-18：「角色应该也要能够发表情包」。
    // 这条路本来就有（模型写 [[表情: 开心]] → 剥标记 → 换成图），但**浏览器级从没测过**
    // （local-app-check 里搜"表情"以前是 0 命中），所以到底还通不通没人知道 —— 先钉住。
    await ensureChatPage();
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    // ⚠ 这条**不依赖模型回复**：直接存一条带 `extra.roleworld_stickers` 的消息再打开对话。
    //   原来靠 `__reply` 排队 —— 整套跑时队列里还留着前面用例塞的台词，先塞的先被消费，
    //   于是这条拿到的是**别人的台词**（那句里根本没有表情），表现成"整套红、单独绿"
    //   （2026-09-18 整套跑实测踩到）。存盘→渲染是一条确定性路径，也更贴近用例名。
    const saved = await evaluate(`(async () => {
      const stamps = await window.RoleWorldStickersPack.availableStamps();
      const stamp = (stamps || []).find((s) => s.name === '开心') || (stamps || [])[0];
      if (!stamp) return { ok: false, reason: '没有内置表情包' };
      await window.STApi.saveChat('Harry Potter (EN).png', 'harry-表情图', [
        { chat_metadata: { ui_title: 'harry-表情图' }, user_name: '我', character_name: 'Harry Potter' },
        { name: '我', is_user: true, mes: '发个表情看看', send_date: new Date().toISOString() },
        { name: 'Harry Potter', is_user: false, mes: '好呀，我很开心。', send_date: new Date().toISOString(),
          extra: { roleworld_turn_id: 'turn-sticker-a',
            roleworld_stickers: [{ id: stamp.id, name: stamp.name, url: stamp.url }] } },
      ]);
      await window.TASK21.refreshSessions();
      return { ok: true, url: stamp.url };
    })()`);
    assert(saved.ok === true, "前置不成立：拿不到内置表情或存不进对话：" + JSON.stringify(saved));
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-表情图");
    await sleep(700);
    const state = await evaluate(`(() => {
      const img = document.querySelector('#dynamicMessages .message-row-assistant .message-sticker img');
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const last = rows[rows.length - 1] || null;
      return { rows: rows.length, hasSticker: !!img,
        src: img ? String(img.getAttribute('src') || '') : '',
        text: last ? String(last.textContent || '').trim().slice(0, 80) : '' };
    })()`);
    console.log('        ASSISTANT_STICKER ' + JSON.stringify(state));
    assert(state.hasSticker === true && state.src.length > 0,
      "存下来的表情必须渲染成图（不能显示成标记或不显示）：" + JSON.stringify(state));
    assert(state.text.indexOf("[[表情") < 0, "标记不该留在正文里：" + JSON.stringify(state));
  });

  await check("日常聊天模式下角色的表情也要渲染成图（不能被纯对白渲染整块覆盖）", async () => {
    // 用户 2026-09-18：「角色的表情包现在也不能够渲染」。
    // 机制：integration.js 里先 `body.innerHTML = renderAssistantBody(mes, stickers)`（这一步把
    //   [[表情: …]] 画成图），紧接着日常聊天那一支做 `body.textContent = plainChatText(mes)`
    //   —— **整块 textContent 会清掉所有子节点**，刚画出来的 .message-sticker 就没了。
    //   而角色语音要求「伴侣 + 软件聊天（日常聊天）」，所以开着语音的人**必然**在这一档，
    //   他看到的角色表情永远是"不渲染"。
    await ensureChatPage();
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const avatar = await ensureCustomCharacter();
    assert(await enableCompanionPlain(avatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
    // 同样不依赖模型回复：存一条**日常聊天档**（`roleworld_chat_style: "plain"`）的消息再打开。
    const saved = await evaluate(`(async () => {
      const stamps = await window.RoleWorldStickersPack.availableStamps();
      const stamp = (stamps || []).find((s) => s.name === '开心') || (stamps || [])[0];
      if (!stamp) return { ok: false, reason: '没有内置表情包' };
      await window.STApi.saveChat(${JSON.stringify(avatar)}, 'plain-表情图', [
        { chat_metadata: { ui_title: 'plain-表情图' }, user_name: '我', character_name: ${JSON.stringify(CUSTOM_NAME)} },
        { name: '我', is_user: true, mes: '今天怎么样', send_date: new Date().toISOString() },
        { name: ${JSON.stringify(CUSTOM_NAME)}, is_user: false, mes: '“明天见。”', send_date: new Date().toISOString(),
          extra: { roleworld_turn_id: 'turn-sticker-b', roleworld_chat_style: 'plain',
            roleworld_stickers: [{ id: stamp.id, name: stamp.name, url: stamp.url }] } },
      ]);
      await window.TASK21.refreshSessions();
      return { ok: true, url: stamp.url };
    })()`);
    assert(saved.ok === true, "前置不成立：拿不到内置表情或存不进对话：" + JSON.stringify(saved));
    await openChatFor(avatar, CUSTOM_NAME, 'plain-表情图');
    await sleep(700);
    const state = await evaluate(`(() => {
      const img = document.querySelector('#dynamicMessages .message-row-assistant .message-sticker img');
      const body = document.querySelector('#dynamicMessages .message-row-assistant .assistant-body');
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const last = rows[rows.length - 1] || null;
      return { rows: rows.length, plain: body ? body.classList.contains('assistant-body-plain') : false,
        hasSticker: !!img, src: img ? String(img.getAttribute('src') || '') : '',
        text: last ? String(last.textContent || '').trim().slice(0, 60) : '' };
    })()`);
    console.log('        PLAIN_STICKER ' + JSON.stringify(state));
    assert(state.plain === true, "前置不成立：这条没走日常聊天渲染那一支：" + JSON.stringify(state));
    assert(state.hasSticker === true,
      "日常聊天模式下角色的表情也必须渲染成图（不能被纯对白那一步整块覆盖掉）：" + JSON.stringify(state));
    assert(state.text.indexOf("[[表情") < 0, "标记不该留在正文里：" + JSON.stringify(state));
  });

  await check("输出渲染矩阵：模式 × 形状（先把现状量出来，重写才不会凭感觉）", async () => {
    // 用户 2026-09-18：「先修输出渲染，重写整个输出的渲染，现在有很多毛病，
    //   不同模式的输出，会显现出很奇怪的样式」。
    // 这条用例**不做"对/错"判定**，只把两张表（剧情对话 / 日常聊天 各 4 种形状）的真实
    // DOM 结构量出来并打印 —— 重写之前先有基线，重写之后拿它逐格对比。
    // 全部走**存盘再打开**（不依赖模型回复），所以结果完全确定。
    await ensureChatPage();
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    const NARRATION = "（他把书合上。）明天见。";
    const seeded = await evaluate(`(async () => {
      const stamps = await window.RoleWorldStickersPack.availableStamps();
      const stamp = (stamps || []).find((s) => s.name === '开心') || (stamps || [])[0];
      const stampExtra = stamp ? [{ id: stamp.id, name: stamp.name, url: stamp.url }] : [];
      const rowsFor = (style) => ([
        { chat_metadata: { ui_title: 'matrix' }, user_name: '我', character_name: 'Harry Potter' },
        { name: '我', is_user: true, mes: '第一句', send_date: new Date().toISOString() },
        // ① 单条含旁白（括号里的动作）
        { name: 'Harry Potter', is_user: false, mes: ${JSON.stringify(NARRATION)},
          send_date: new Date().toISOString(),
          extra: { roleworld_turn_id: 'm1', roleworld_chat_style: style } },
        // ② 一轮多条（parts）
        { name: 'Harry Potter', is_user: false, mes: '第一句\\n第二句',
          send_date: new Date().toISOString(),
          extra: { roleworld_turn_id: 'm2', roleworld_chat_style: style,
            roleworld_parts: [{ kind: 'text', text: '第一句' }, { kind: 'text', text: '第二句' }] } },
        // ③ 语音条
        { name: 'Harry Potter', is_user: false, mes: '这句是念出来的',
          send_date: new Date().toISOString(),
          extra: { roleworld_turn_id: 'm3', roleworld_chat_style: style,
            roleworld_parts: [{ kind: 'voice', text: '这句是念出来的', status: 'failed', reason: '矩阵用' }] } },
        // ④ 表情
        { name: 'Harry Potter', is_user: false, mes: '好呀',
          send_date: new Date().toISOString(),
          extra: { roleworld_turn_id: 'm4', roleworld_chat_style: style, roleworld_stickers: stampExtra } },
      ]);
      await window.STApi.saveChat('Harry Potter (EN).png', 'matrix-action', rowsFor('action'));
      await window.STApi.saveChat('Harry Potter (EN).png', 'matrix-plain', rowsFor('plain'));
      await window.TASK21.refreshSessions();
      return { hasStamp: stampExtra.length > 0 };
    })()`);
    assert(seeded.hasStamp === true, "前置不成立：拿不到内置表情包");

    const probe = `(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      return rows.map((row, i) => {
        const body = row.querySelector('.assistant-body');
        const voiceText = row.querySelector('.voice-bubble-text');
        return {
          i,
          bubbles: row.querySelectorAll('.assistant-bubble, .message-bubble').length,
          narration: row.querySelectorAll('.narration-line').length,
          parts: row.querySelectorAll('.message-part').length,
          partKinds: Array.from(row.querySelectorAll('.message-part')).map((n) => n.dataset.partKind || '?'),
          voice: row.querySelectorAll('.voice-bubble').length,
          // 语音条里那份"给读屏的正文"必须是 hidden（屏幕上只该有语音）
          voiceTextVisible: voiceText ? !voiceText.hidden : null,
          stickers: row.querySelectorAll('.message-sticker img').length,
          plainClass: body ? body.classList.contains('assistant-body-plain') : null,
          hasMeta: !!(row.querySelector('.message-meta strong') || {}).textContent,
          rawMarker: String(row.textContent || '').indexOf('[[') >= 0,
          text: String(row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 46),
        };
      });
    })()`;

    const matrix = {};
    for (const [mode, file] of [["action", "matrix-action"], ["plain", "matrix-plain"]]) {
      await openChatFor("Harry Potter (EN).png", "Harry Potter", file);
      await sleep(700);
      matrix[mode] = await evaluate(probe);
      console.log("        RENDER_MATRIX[" + mode + "] " + JSON.stringify(matrix[mode]));
    }
    // 只钉"所有模式所有形状都必须成立"的不变量；样式差异本身先只记录，留给重写时对比。
    for (const mode of ["action", "plain"]) {
      const rows = matrix[mode];
      assert(rows.length === 4, mode + " 应当渲染 4 条助手消息，实际 " + rows.length);
      for (const row of rows) {
        assert(row.hasMeta === true, mode + " 第" + row.i + "条没有名字行：" + JSON.stringify(row));
        assert(row.rawMarker === false, mode + " 第" + row.i + "条把原始标记显示出来了：" + JSON.stringify(row));
      }
      assert(rows[3].stickers >= 1, mode + " 的表情没有渲染成图：" + JSON.stringify(rows[3]));
      assert(rows[2].voice >= 1, mode + " 的语音条没有渲染成气泡：" + JSON.stringify(rows[2]));
      assert(rows[2].voiceTextVisible === false, mode + " 的语音条把正文文字露在屏幕上了：" + JSON.stringify(rows[2]));
    }
    // ⚠ 规格（这才是对的，我第一版写错过）：**每一档内部要一致**，而不是"两档长得一样"。
    //   剧情对话 = 旁白 + 对白（两种样式并存是有意的）；日常聊天（微信式）= **只有对白、
    //   全部进气泡，一条旁白行都不该有**。用户 2026-09-18：「不同模式的输出会显现出很奇怪的
    //   样式」+「微信模式界面样式完全模仿微信聊天」。
    const plainRows = matrix.plain;
    for (const row of plainRows) {
      assert(row.narration === 0,
        "日常聊天档出现了旁白行（那一档只剩对白，应该全在气泡里）：" + JSON.stringify(row));
    }
    // 有文字的形状（①②）在剧情档也要有内容画出来，不能两边都空。
    assert(matrix.action[0].narration + matrix.action[0].bubbles >= 1,
      "剧情对话档的单条消息什么都没画出来：" + JSON.stringify(matrix.action[0]));
    assert(matrix.action[1].bubbles >= 2, "剧情对话档的一轮多条应有 ≥2 个气泡：" + JSON.stringify(matrix.action[1]));
    // 日常聊天档的正文（去掉括号动作之后）必须真的显示出来。
    assert(String(matrix.plain[0].text).indexOf("明天见。") >= 0,
      "日常聊天档的对白没显示出来：" + JSON.stringify(matrix.plain[0]));
  });

  await check("贴卡结果必须真的看得见（桌面宽度下不能被折叠规则藏起来）", async () => {
    // 用户实测（2026-09-17，0.1.65 仍复现）：「点测试连接可以显示正常，但是其他的都没有反应，
    //   然后点击使用体验卡链接清空」「没有任何反应，直接消失」。
    // 真因：settings-ui.js 的折叠样式在 ≥721px 时把 `.settings-row > div > span` 一律 display:none，
    //   而「体验卡」与「API Key」两行的状态行正是这种 span（index.html:499 / :507）——
    //   于是"✓ 体验卡已启用…"其实**写进去了，但用户看不见**，唯一看得见的变化是输入框被清空。
    //   （test-result 是 <p>，不受影响 —— 所以"测试连接显示正常、其他都没反应"。）
    // ⚠ 这条用例断言的是**可见性**，不是 textContent：上一版用例只比文字，
    //   隐藏节点同样有 textContent，所以它是瞎的（这个项目反复踩的同一个坑）。
    await ensureChatPage();
    try {
      const width = await evaluate("window.innerWidth");
      assert(width >= 721, "前置条件：本用例要跑在 ≥721px 的桌面宽度下（折叠规则只在那里生效），当前 " + width);
      await evaluate("document.querySelector('[data-action=\"open-settings\"]').click(); window.TASK25C_UI.setSettingsSection('connection'); true");
      await waitFor("document.querySelector('#settingsSurface').hidden === false", 6000);
      await evaluate("document.querySelector('[data-roleworld=\"connection-card\"]').click(); true");
      await sleep(1000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-roleworld="card"]');
        input.value = 'RW-AAAAA-BBBBB-CCCCC@${base}/relay';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-roleworld="card-use"]').click();
        return true;
      })()`);
      await waitFor("document.querySelector('[data-roleworld=\"card-status\"]').textContent.indexOf('剩 4 次') >= 0", 10000);
      await sleep(800);
      const state = await evaluate(`(() => {
        const seen = (node) => {
          if (!node) return { found: false };
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return { found: true, display: style.display, visibility: style.visibility,
            w: Math.round(rect.width), h: Math.round(rect.height),
            visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 };
        };
        return {
          width: window.innerWidth,
          card: seen(document.querySelector('[data-roleworld="card-status"]')),
          cardText: (document.querySelector('[data-roleworld="card-status"]') || {}).textContent || '',
          inputCleared: (document.querySelector('[data-roleworld="card"]') || {}).value === '',
        };
      })()`);
      console.log('        CARD_STATUS_VISIBLE ' + JSON.stringify(state));
      assert(state.cardText.indexOf("已启用") >= 0, "贴卡之后状态行里要有成功确认：" + JSON.stringify(state));
      assert(state.card.visible === true,
        "贴卡结果必须看得见（不能只写进 display:none 的节点）：" + JSON.stringify(state.card));
      assert(state.inputCleared === true, "卡号不该留在输入框里：" + JSON.stringify(state));
      // 「API Key」那一行在「自己配 API」那一块里（体验卡模式下那一块本来就隐藏，量它必然 0 高度）。
      // 切过去再量：验证同一条折叠规则没有把它也藏掉（同样是"点了保存没反应"）。
      await evaluate("document.querySelector('[data-roleworld=\"connection-key\"]').click(); true");
      await sleep(900);
      const keyState = await evaluate(`(() => {
        const node = document.querySelector('[data-roleworld="key-status"]');
        const block = document.querySelector('#connectionKeyBlock');
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return { display: style.display, w: Math.round(rect.width), h: Math.round(rect.height),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          blockHidden: block ? block.hidden : null, text: node.textContent };
      })()`);
      console.log('        KEY_STATUS_VISIBLE ' + JSON.stringify(keyState));
      assert(keyState.blockHidden === false,
        "前置不成立：切到「自己配置 API」之后那一块还是隐藏的：" + JSON.stringify(keyState));
      assert(keyState.visible === true,
        "「API Key」那一行的状态必须看得见（同一条折叠规则会一起藏掉）：" + JSON.stringify(keyState));
      // 「运行版本」那一行在「关于」分区里：先切过去再量（否则量到的是"分区正常隐藏"的 0 高度）。
      await evaluate("(window.__rwExpandSettingsMore && window.__rwExpandSettingsMore(true)); window.TASK25C_UI.setSettingsSection('about'); true");
      await sleep(700);
      const version = await evaluate(`(() => {
        const node = document.querySelector('[data-roleworld="app-version"]');
        if (!node) return { found: false };
        const rect = node.getBoundingClientRect();
        const panel = node.closest('[data-settings-panel]');
        return { found: true, display: getComputedStyle(node).display, h: Math.round(rect.height),
          panelHidden: panel ? panel.hidden : null, text: node.textContent };
      })()`);
      assert(version.found && version.display !== "none" && version.h > 0,
        "「运行版本」那一行也必须看得见（不然排障时没法确认浏览器到底在跑哪一版）：" + JSON.stringify(version));
    } finally {
      await evaluate(`(async () => {
        document.querySelector('[data-action="close-settings"]')?.click();
        await RoleWorld.saveLocalSettings({ provider: 'deepseek', endpoint: '${base}/v1/chat/completions', card_relay: '' });
        await RoleWorld.secrets.remove('api_key_custom');
        if (typeof window.TASK21?.reloadSettings === 'function') await window.TASK21.reloadSettings();
        return true;
      })()`).catch(() => {});
      await closeAppWithVoice().catch(() => {});
    }
  });

  await check("引导层必须永远能退出：卡不好用时也要进得去设置", async () => {
    // 用户实测（2026-09-17）：「你的设置做的根本点不动」。
    // 根因：这层引导**铺满屏幕、底下什么都点不到**，而它的按钮只有「上一步 / 本步的下一步」，
    // Escape 又被故意拦掉（onboarding.js 的 onKeydown：必须走完）。
    // 于是**卡不可用、或没有 Key 的人走不完也退不出** —— 连「设置」都进不去，想自己修卡都修不了。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: true, card_welcome_seen: false, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      await goto(base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay");
      await cdp.sessionSend(session, "Page.reload");
      await sleep(400);
      await waitFor("window.TASK21_READY === true", 30000);
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      // 用"屏幕中心命中的是谁 + 输入框点不点得到"来量"整页点不动"，不依赖具体按钮叫什么。
      const probe = `(() => {
        const shell = document.querySelector('#appShell') || document.body;
        const r = shell.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        const input = document.querySelector('#messageInput');
        let inputReachable = null;
        if (input) {
          const q = input.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.round(q.left + q.width / 2), Math.round(q.top + q.height / 2));
          inputReachable = !!(hit && (hit === input || input.contains(hit)));
        }
        return {
          topClass: top ? String(top.className || top.tagName) : null,
          inOverlay: !!(top && top.closest && top.closest('.rw-ob')),
          inputReachable,
        };
      })()`;
      const blocked = await evaluate(probe);
      assert(blocked.inOverlay === true, "前置不成立：引导层开着时中心点没落在它上面：" + JSON.stringify(blocked));
      assert(blocked.inputReachable === false, "前置不成立：引导层开着时输入框居然点得到：" + JSON.stringify(blocked));
      // 修复点：任何一步都必须有一个**随时能退出**的出口。
      const hasSkip = await evaluate("!!document.querySelector('.rw-ob [data-ob=\"skip\"]')");
      assert(hasSkip === true,
        "引导层必须永远给一个「先跳过，稍后设置」的出口 —— 否则卡不好用的用户被关在里面，进不去设置");
      await evaluate("document.querySelector('.rw-ob [data-ob=\"skip\"]').click(); true");
      await waitFor("!document.querySelector('.rw-ob')", 8000);
      const after = await evaluate(probe);
      assert(after.inOverlay === false, "点了跳过之后引导层还在：" + JSON.stringify(after));
      assert(after.inputReachable === true, "跳过引导之后底下必须真的能点：" + JSON.stringify(after));
      const marks = await evaluate("(async () => { const s = await RoleWorld.getLocalSettings(); return { seen: s.tutorial_seen === true, cardSeen: s.card_welcome_seen === true }; })()");
      assert(marks.seen && marks.cardSeen, "跳过之后要记上“看过了”，否则下次打开又弹一遍：" + JSON.stringify(marks));
    } finally {
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("引导里贴卡：中转连不上时不能说“已经在用”，也不能清掉卡号、更不能覆盖掉原配置", async () => {
    // 用户实测（2026-09-17）：「把体验卡粘贴进去点使用，卡号会清空，但是其他按钮点了都没有反应，
    // 也不知道成功了没有」。
    // 代码事实：`card.apply()` **先把本机设置改成卡的中转、再探测**，而**无论探测成没成都返回 ok:true**
    //   （探测结果只进了 message）。于是填卡页会清空卡号、显示自相矛盾的
    //   「好了，这张卡已经在用：连不上中转：…」，同时把用户原本能用的配置覆盖成那段连不上的地址。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false, card_welcome_seen: false, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await evaluate("window.RoleWorldOnboarding && window.RoleWorldOnboarding.close(); true");
      await evaluate("window.RoleWorldOnboarding.show(); true");
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      // 走到填卡页：欢迎 → 二选一 → 选「有人给了我一张体验卡」
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"way\"][data-way=\"card\"]')", 8000);
      await evaluate("document.querySelector('[data-ob=\"way\"][data-way=\"card\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"card-token\"]')", 8000);
      // 填一张格式合法、但中转**连不上**的卡（端口 9 直接拒连，不用等 8 秒超时）。
      await evaluate(`(() => {
        const token = document.querySelector('[data-ob="card-token"]');
        const relay = document.querySelector('[data-ob="card-relay"]');
        token.value = 'RW-AAAAA-BBBBB-CCCCC';
        relay.value = 'http://127.0.0.1:9/relay';
        return true;
      })()`);
      await evaluate("document.querySelector('[data-ob=\"card-use\"]').click(); true");
      await sleep(2500);
      const state = await evaluate(`(async () => {
        const settings = await RoleWorld.getLocalSettings();
        const secret = (await RoleWorld.secrets.get('api_key_custom') || {}).value || '';
        return {
          status: (document.querySelector('[data-ob="card-status"]') || {}).textContent || '',
          tokenStillThere: (document.querySelector('[data-ob="card-token"]') || {}).value || '',
          provider: settings.provider || '',
          endpoint: settings.endpoint || '',
          cardRelay: settings.card_relay || '',
          cardInSlot: secret,
        };
      })()`);
      assert(state.status.indexOf("已启用") < 0,
        "中转根本没连上，却说「体验卡已启用」：" + JSON.stringify(state));
      assert(state.status.length > 0, "点了「用这张卡」必须给出结果（成功或失败都要说）：" + JSON.stringify(state));
      assert(state.tokenStillThere.length > 0,
        "失败时不该把卡号清掉 —— 用户还得重新打一遍：" + JSON.stringify(state));
      assert(state.provider === "deepseek" && state.endpoint === "",
        "失败时不该把本机原本的配置覆盖成那段连不上的地址：" + JSON.stringify(state));
    } finally {
      await evaluate("window.RoleWorldOnboarding && window.RoleWorldOnboarding.close(); true").catch(() => {});
      await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: true, provider: 'deepseek', endpoint: '', card_relay: '' }); await RoleWorld.secrets.remove('api_key_custom'); return true; })()").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
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

      // ③ 走完这一步链：卡说明 → **二选一** → **填卡** → 称呼 → 语言 → 导览 → 开始
      //
      // 2026-09-16 重排（用户："新浏览器开网站的那个步骤不够简单明了"）：
      //   现在第一步是**二选一**（有体验卡 / 自己的 Key），选完才进对应那一页；
      //   体验卡那一页把"卡号"和"中转地址"拆成两栏填 —— 普通人手里只有卡号，
      //   以前要求"把卡号@地址那一整行粘进来"是纯门槛。
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"way\"]')", 8000);
      const choose = await evaluate(`(() => ({
        title: document.querySelector('.rw-ob h2').textContent,
        text: document.querySelector('.rw-ob-card').textContent,
        ways: Array.from(document.querySelectorAll('[data-ob="way"]')).map((n) => n.dataset.way),
        hasNext: !!document.querySelector('[data-ob="next"]'),
      }))()`);
      assert(choose.title.indexOf("你手上有什么") >= 0, "二选一那一页的标题不对：" + choose.title);
      assert(choose.ways.join(",") === "card,key", "二选一没有给出两个选项：" + JSON.stringify(choose.ways));
      assert(choose.text.indexOf("体验卡") >= 0 && choose.text.indexOf("API Key") >= 0,
        "二选一没把两条路说清楚：" + choose.text.slice(0, 240));
      assert(choose.hasNext === false, "二选一那一页不该再放一个「下一步」（该点选项本身）");
      await evaluate("document.querySelector('[data-ob=\"way\"][data-way=\"card\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"card-token\"]')", 8000);
      const cardStep = await evaluate(`(() => ({
        title: document.querySelector('.rw-ob h2').textContent,
        hasToken: !!document.querySelector('[data-ob="card-token"]'),
        hasRelay: !!document.querySelector('[data-ob="card-relay"]'),
        hasKey: !!document.querySelector('[data-ob="key"]'),
        placeholder: (document.querySelector('[data-ob="card-token"]') || {}).placeholder || "",
      }))()`);
      assert(cardStep.hasToken && cardStep.hasRelay, "填卡页没有把卡号与中转地址拆成两栏：" + JSON.stringify(cardStep));
      assert(cardStep.hasKey === false, "填卡页里不该出现 API Key 输入框（会让人以为两样都要填）");
      assert(cardStep.placeholder.indexOf("RW-") >= 0, "卡号那一栏的提示没告诉人长什么样：" + cardStep.placeholder);
      // 把两栏都填上并真的点「用这张卡」：这一步必须通（它以前是"粘一整行"）
      await evaluate(`(() => {
        const token = document.querySelector('[data-ob="card-token"]');
        const relay = document.querySelector('[data-ob="card-relay"]');
        token.value = 'RW-AAAAA-BBBBB-CCCCC';
        relay.value = ${JSON.stringify(base + "/relay")};
        document.querySelector('[data-ob="card-use"]').click();
        return true;
      })()`);
      await waitFor("(document.querySelector('[data-ob=\"card-status\"]') || {}).textContent.indexOf('已启用') >= 0", 15000);
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
      // 浮层消失 = 这一步真的完成了：标记必须**已经**落盘。
      // 这里断言的是"顺序"本身（不是"再等一会儿"）—— 以前 finish() 先 close() 再写设置，
      // 中间隔着两次 await，于是存在"浮层没了、标记还没写"的窗口：
      // 用户正好这时刷新会重看一次开场，自动化读到旧值（2026-09-13 那条偶发就卡在这里）。
      const markerAtClose = await evaluate("(async () => (await RoleWorld.getLocalSettings()).card_welcome_seen)()");
      assert(markerAtClose === true,
        "浮层消失时「开场看过」的标记还没落盘：关浮层与落盘的顺序又反了");

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
    // 现在第一步就是**二选一**：选「有人给了我一张体验卡」→ 填卡号 + 中转地址两栏 → 直接进门
    // （和「设置 → 连接方式 → 体验卡」走同一个 apply()）。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false, provider: 'deepseek', endpoint: '', card_relay: '', model: 'deepseek-flash' }); await RoleWorld.secrets.remove('api_key_custom'); await RoleWorld.secrets.remove('api_key_deepseek'); return true; })()");
    try {
      await goto(base + "/index.html");   // 注意：地址里**没有** card=…
      await waitFor("window.TASK21_READY === true", 30000);
      await waitFor("!!document.querySelector('.rw-ob')", 15000);
      // 第一步：二选一
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      await waitFor("!!document.querySelector('[data-ob=\"way\"][data-way=\"card\"]')", 10000);
      const choose = await evaluate(`(() => {
        const cardWay = document.querySelector('[data-ob="way"][data-way="card"]');
        const keyWay = document.querySelector('[data-ob="way"][data-way="key"]');
        const box = cardWay ? cardWay.getBoundingClientRect() : null;
        return {
          hasCard: !!cardWay, hasKey: !!keyWay,
          w: box ? Math.round(box.width) : 0, h: box ? Math.round(box.height) : 0,
          text: document.querySelector('.rw-ob-card').textContent,
        };
      })()`);
      assert(choose.hasCard && choose.hasKey, "第一步没有给出「体验卡 / 自己的 Key」两条路：" + JSON.stringify(choose));
      assert(choose.w > 0 && choose.h > 0, "「有人给了我一张体验卡」那个选项看不见/不占位置：" + JSON.stringify(choose));
      assert(choose.text.indexOf("体验卡") >= 0 && choose.text.indexOf("API Key") >= 0,
        "二选一没写清两条路是什么：" + choose.text.slice(0, 200));
      await evaluate("window.RoleWorldOnboarding.route('card'); true");
      // 选完「体验卡」之后直接就是**填卡页**（2026-09-16 的新顺序：卡说明 → 二选一 → 填卡 → 称呼）
      await waitFor("!!document.querySelector('[data-ob=\"card-token\"]')", 10000);

      // ① 填卡页必须看得见两栏（卡号 / 中转地址）与那颗按钮，并说明白各填什么
      const entry = await evaluate(`(() => {
        const token = document.querySelector('[data-ob="card-token"]');
        const relay = document.querySelector('[data-ob="card-relay"]');
        const button = document.querySelector('[data-ob="card-use"]');
        const box = token ? token.getBoundingClientRect() : null;
        return {
          hasToken: !!token, hasRelay: !!relay, hasButton: !!button,
          w: box ? Math.round(box.width) : 0, h: box ? Math.round(box.height) : 0,
          tokenPlaceholder: token ? token.placeholder : "",
          text: document.querySelector('.rw-ob-card').textContent,
        };
      })()`);
      assert(entry.hasToken && entry.hasRelay, "填卡页没有把卡号与中转地址拆成两栏：" + JSON.stringify(entry));
      assert(entry.hasButton, "填卡页没有「用这张卡」按钮：" + JSON.stringify(entry));
      assert(entry.w > 0 && entry.h > 0, "卡号输入框看不见/不占位置：" + JSON.stringify(entry));
      assert(entry.tokenPlaceholder.indexOf("RW-") >= 0, "卡号那一栏没说清长什么样：" + entry.tokenPlaceholder);
      assert(entry.text.indexOf("体验卡") >= 0 && entry.text.indexOf("中转地址") >= 0,
        "填卡页没写清两栏各填什么：" + entry.text.slice(0, 200));

      // ② 粘两栏，而且**故意不点「用这张卡」**直接点下一步 ——
      //    同学的直觉就是"填上、点下一步"，这一步不该被自己漏掉的按钮挡住。
      await evaluate(`(() => {
        const token = document.querySelector('[data-ob="card-token"]');
        const relay = document.querySelector('[data-ob="card-relay"]');
        token.value = 'RW-AAAAA-BBBBB-CCCCC';
        relay.value = ${JSON.stringify(base + "/relay")};
        token.dispatchEvent(new Event('input', { bubbles: true }));
        relay.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      // 卡用上之后依次是「称呼」→「语言」→「这里能做什么」→ 收尾页
      // ⚠ 收尾页的标题：**从卡链接进来的**（mode="card"）是「可以开始」，
      //   自己打开网站再选"体验卡"那条路走的是**通用步骤链**，收尾页是「准备就绪」。
      //   这条用例是后者（地址里没带卡），所以判据要认「准备就绪」。
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 12000);
      await evaluate(`(() => {
        const input = document.querySelector('[data-ob="nickname"]');
        input.value = '体验卡同学';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ob="next"]').click();
        return true;
      })()`);
      // 卡那条路：称呼之后是「语言」→ 功能导览 → 可以开始（没有"填 Key"那一页）
      await waitFor("!!document.querySelector('[data-ob=\"language-zh\"]')", 12000);
      const langStep = await evaluate("document.querySelector('.rw-ob h2').textContent");
      assert(langStep.indexOf("语言") >= 0, "卡这条路没有问语言（用户看不懂英文时需要它）：" + langStep);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
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
    //      现在会被认出来、并明确指路回上一步选「体验卡」，**不写**密钥位。
    //
    // ⚠ 2026-09-16：引导重排之后，这条用例的前置多了一步 ——
    //   浮层可能被**上一条用例**留在 ready 页上，而 `show()` 见浮层已存在会直接 return。
    //   所以先 close() 再 show()，并确认停在 welcome；路线用 `route('key')` 确定性地选，
    //   不再靠"盲点下一步猜自己走到哪"（那样顺序一变就假红，本轮踩过）。
    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ tutorial_seen: true, provider: "custom", endpoint: "${base}/relay/v1/chat/completions", card_relay: "${base}/relay", model: "deepseek-flash" });
      await RoleWorld.secrets.set("api_key_custom", "RW-AAAAA-BBBBB-CCCCC");
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "custom", endpoint: "${base}/relay/v1/chat/completions", card_relay: "${base}/relay" } }));
      return true;
    })()`);
    try {
      // 「设置 → 关于 → 再看一次教程」走的就是这一套（archive-ui.js 接的线是 show() 无参数 = full）。
      await evaluate("window.RoleWorldOnboarding.close(); true");
      await evaluate("window.RoleWorldOnboarding.show(); true");
      await waitFor("!!document.querySelector('.rw-ob')", 8000);
      await waitFor("window.RoleWorldOnboarding.currentStep() === 'welcome'", 8000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      // 二选一：这条用例要验的是"填 Key 那一页"，所以走第二条路。
      // ⚠ 用 `route()` 而不是点按钮猜：顺序一变，盲点就会假红（本轮踩过）。
      await waitFor("window.RoleWorldOnboarding.currentStep() === 'choose'", 8000);
      await evaluate("window.RoleWorldOnboarding.route('key'); true");
      await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
      await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
      // 称呼之后先问语言（2026-09-16 起两条路都问）
      await waitFor("!!document.querySelector('[data-ob=\"language-zh\"]')", 8000);
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
      // ⚠ 2026-09-16：引导里已经没有"卡号那一栏"了（卡走的是另一条独立的路），
      //   所以这里不再断言"挪到卡那一栏"，改成断言"不写密钥位 + 明确指路回上一步"。
      const after = await evaluate(`(async () => {
        const key = document.querySelector('[data-ob="key"]');
        key.value = 'RW-ZZZZZ-YYYYY-XXXXX@${base}/relay';
        key.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('[data-ob="save"]').click();
        await new Promise((r) => setTimeout(r, 600));
        return {
          secret: (await RoleWorld.secrets.get("api_key_custom") || {}).value || "",
          keyValue: key.value,
          status: (document.querySelector('[data-ob="status"]') || {}).textContent || "",
        };
      })()`);
      assert(after.secret === "RW-AAAAA-BBBBB-CCCCC",
        "卡号被当成 API Key 写进密钥位了（下一轮必然 401）：" + JSON.stringify(after));
      assert(after.status.indexOf("体验卡") >= 0 && after.status.indexOf("上一步") >= 0,
        "把卡号粘进 Key 栏之后没说清该怎么做（要指回上一步选体验卡）：" + JSON.stringify(after));

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
      assert(await waitForNewTurn(before + 1), "这一句没有真的发出去：" + JSON.stringify(await evaluate(`(async () => ({
        text: ${JSON.stringify(text)},
        stored: { endpoint: (await RoleWorld.getLocalSettings()).endpoint, provider: (await RoleWorld.getLocalSettings()).provider },
        block: await window.TASK21.chatPreflight(),
        sendHidden: document.querySelector('#sendButton').hidden,
        inputDisabled: document.querySelector('#messageInput').disabled,
        draft: document.querySelector('#messageInput').value,
        cards: document.querySelectorAll('#dynamicMessages .chat-preflight').length,
      }))()`)));
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

  await check("首次启动的引导：每一步都有出口，主流程仍是先写称呼再填 Key", async () => {
    // 主流程的 fixture 把 tutorial_seen 设成 true（否则引导浮层会盖住整个界面，
    // 用例里那些 element.click() 照样能点，真人却点不到 —— 记忆按钮那个缺陷就是这么漏掉的）。
    // 这条用例要验引导本身，所以先把"第一次启动"造出来：清标记 + 刷新。
    //
    // ⚠ 2026-09-17 **反转**：这条用例以前钉的是「没有跳过」。用户实测「你的设置做的根本点不动」
    //   之后确认那是个陷阱：这层引导铺满屏幕、底下什么都点不到，Escape 又被 onKeydown 拦掉，
    //   而 **Key 那一步在凭据无效时会拒绝前进**（onboarding.js：`onNext` 判不到卡/Key 就 return false）
    //   —— 卡不可用、Key 填错或欠费的人**走不完也退不出**，连「设置」都进不去。
    //   所以现在每一步都必须有一个出口；这一条只钉"出口在、真的点得到"，
    //   点下去之后的行为由「引导层必须永远能退出」那条用例负责（那条会真点）。
    await evaluate("(async () => { await RoleWorld.saveLocalSettings({ tutorial_seen: false }); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    // 前置：**把上一条用例可能留下的引导浮层关掉**，再从干净状态打开这一条。
    // （2026-09-16：上一条走完停在 ready，`show()` 见浮层已存在会直接 return，
    //   于是这一条一开就停在 ready —— 报成"引导首页标题不对"那样的假红。）
    await evaluate("window.RoleWorldOnboarding && window.RoleWorldOnboarding.close(); true");
    await evaluate("window.RoleWorldOnboarding.show(); true");
    await waitFor("!!document.querySelector('.rw-ob')", 15000);
    await waitFor("window.RoleWorldOnboarding.currentStep() === 'welcome'", 10000);
    const first = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(first.indexOf("欢迎") >= 0, "引导首页标题是：" + first);
    const skipBtn = await evaluate(`(() => {
      const b = document.querySelector('[data-ob="skip"]');
      if (!b) return { exists: false };
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return {
        exists: true,
        visible: r.width > 0 && r.height > 0,
        reachable: !!(top && (top === b || b.contains(top))),
        label: b.textContent.trim(),
      };
    })()`);
    assert(skipBtn.exists && skipBtn.visible, "每一步都要有出口（先跳过，稍后设置）：" + JSON.stringify(skipBtn));
    assert(skipBtn.reachable, "出口必须真的点得到（不能被别的元素盖住）：" + JSON.stringify(skipBtn));
    assert(skipBtn.label.indexOf("跳过") >= 0, "出口文案要说清楚是跳过：" + skipBtn.label);
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
    // 2026-09-16 起：欢迎之后**先二选一**（体验卡 / 自己的 Key），选完才进对应的那一页。
    await waitFor("!!document.querySelector('[data-ob=\"way\"][data-way=\"key\"]')", 8000);
    assert(await evaluate("!!document.querySelector('[data-ob=\"way\"][data-way=\"card\"]')"),
      "二选一里缺少「有人给了我一张体验卡」这条路");
    await evaluate("document.querySelector('[data-ob=\"way\"][data-way=\"key\"]').click()");
    await waitFor("!!document.querySelector('[data-ob=\"nickname\"]')", 8000);
    const nameStep = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(nameStep.indexOf("称呼") >= 0, "第三步不是填称呼：" + nameStep);
    await evaluate(`(() => {
      const input = document.querySelector('[data-ob="nickname"]');
      input.value = '测试称呼';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-ob="next"]').click();
      return true;
    })()`);
    // 称呼之后先问语言（2026-09-16 起两条路都问），再填 Key
    await waitFor("!!document.querySelector('[data-ob=\"language-zh\"]')", 8000);
    assert((await evaluate("document.querySelector('.rw-ob h2').textContent")).indexOf("语言") >= 0,
      "称呼之后没有问语言");
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    await waitFor("!!document.querySelector('[data-ob=\"key\"]')", 8000);
    const second = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(second.indexOf("API Key") >= 0, "填 Key 那一页标题不对：" + second);
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
    // 这一页在「更多设置 → 关于」里（2026-09-16 起设置分成了"常用 5 页 + 更多"）：
    // 先把设置面板打开、切到「关于」，再点那颗按钮 —— 不这样走就等于在没打开的页面上点。
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate("window.TASK25C_UI.setSettingsSection('about'); true");
    await waitFor("!!document.querySelector('[data-roleworld=\"tutorial\"]')", 8000);
    await evaluate("document.querySelector('[data-roleworld=\"tutorial\"]').click()");
    await waitFor("!!document.querySelector('.rw-ob')", 5000);
    await evaluate("document.querySelector('[data-ob=\"next\"]').click()");
    const second = await evaluate("document.querySelector('.rw-ob h2').textContent");
    assert(second.indexOf("欢迎") < 0, "「下一步」没有翻页，标题还是：" + second);
    // 收尾：把引导关掉、设置面板关掉，别把浮层留给后面的用例
    await evaluate("document.querySelector('.rw-ob')?.remove(); document.querySelector('[data-action=\"close-settings\"]')?.click(); true");
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
    assert(probe.style === "gold" || probe.style === "default",
      "风格属性不对（新默认是 gold）：" + probe.style);
    assert(probe.bodyBg === probe.expected, `背景没跟着设计变量走：${probe.bodyBg} ≠ ${probe.expected}`);
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

  console.log("== 消息旁的操作（本轮第 ③ 项）==");

  await check("数据与备份：一个入口看数量与上次导出，清空和日常备份分开", async () => {
    // 自带页面前置：这条用例点的是**顶栏**设置按钮，单跑时页面可能停在 magic-map 上。
    await ensureChatPage();
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    // 从「关于」页那颗按钮跳过去（关于页不再重复放导出/导入/清空）。
    await evaluate("window.TASK25C_UI.setSettingsSection('about'); true");
    await waitFor("!!document.querySelector('[data-action=\"goto-data-backup\"]')", 8000);
    await evaluate("document.querySelector('[data-action=\"goto-data-backup\"]').click(); true");
    await waitFor("document.querySelector('#settings-local-data').classList.contains('is-active')", 8000);
    // 概况是切换分页之后**异步**读出来的：初始文案是"正在读取…"，
    // 所以不能只等"有文字"，要等读到真实数量（这一条自己踩过一次）。
    await waitFor("(function(){ var t = (document.querySelector('[data-roleworld=\"data-summary\"]') || {}).textContent || ''; return /角色 [1-9]/.test(t); })()", 15000);

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
    assert(page.heading.indexOf('数据与备份') >= 0, "这一页没改名：" + page.heading);
    assert(/角色 \d+ 个 · 对话 \d+ 段 · 记忆书 \d+ 本/.test(page.summary), "概况数字没出来：" + page.summary);
    assert(page.summary.indexOf('角色 0 个') < 0, "概况应当读到真实数量：" + page.summary);
    assert(/上次导出：|还没有导出过/.test(page.last), "最近一次导出的说明不对：" + page.last);
    assert(page.hasExport, "数据与备份页里没有导出按钮");
    assert(page.hasImportRowText, "导入那一行没写清是「整份替换」：" + page.hasImportRowText);
    assert(page.wipeInDanger, "「清空本机数据」没有放进危险区");
    assert(page.exportOutsideDanger, "导出按钮不该放在危险区里");
    assert(page.aboutHasNoWipe && page.aboutHasNoExport, "关于页里还留着导出/清空，等于两个入口");
    await evaluate("document.querySelector('[data-action=\"close-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
  });

  await check("伴侣模式开关就在角色自己那一行：定制角色能给谁开点谁，内置小说人物这一行**不给开**", async () => {
    // 真内置卡只在这一条用例里存在：这条闸（内置角色不给开伴侣）只有在真内置
    // avatar 文件名上才验得到，而把它放进全局 fixture 会连累其它 16 条用例（实测）。
    await ensureBuiltinCard();
    // 用户 2026-09-13：「现在的是什么当前角色啥的我要做到每个角色本身的上面」。
    // 用户 2026-09-14 又拍板：「小说人物不设置伴侣」—— 所以这条用例现在盯两件事：
    //   ① 定制角色：每一行都有开关，给**非当前**角色打开不会影响当前角色，能开也能关；
    //   ② 内置小说人物：那一行**是禁用的**，写明原因；就算有人绕过界面把状态塞进去，
    //      也不该写进档案（下面"绕过界面"那一步就是在验这道闸）。
    const friend = await ensureCustomCharacter();
    await ensureChatPage();
    await evaluate("document.querySelector('[data-action=\"open-settings\"]').click()");
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate("window.TASK25C_UI.setSettingsSection('characters'); true");
    await waitFor("document.querySelectorAll('#characterManageList .character-manage-row').length >= 2", 10000);
    // 等每一行都读完自己的档案。**判据只挑定制角色那一行**：
    // 内置角色那一行按规则永远是禁用的，把它算进来会永远等不到（我第一次就这么假红了）。
    await waitFor(`(function () {
      const box = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'))
        .find((node) => node.dataset.companionAvatar === ${JSON.stringify(CUSTOM_AVATAR)});
      return !!box && box.disabled === false;
    })()`, 15000);

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

    // ① 内置小说人物：禁用 + 写清为什么 + 不许是开着的。
    // ⚠ 判定"哪些是内置小说人物"必须看**内置包实际自带的头像文件名**，不能按
    //   "不是定制角色就算内置"：合成卡（比如 Hermione Granger (EN).png）不是内置角色，
    //   应用把它的开关画成可点是正确行为 —— 这一条原来就是这么误报的（诊断实证）。
    const builtinAvatars = await evaluate(`(async () => {
      // 内置包清单里 contents.characters 就是这 6 个头像文件名 —— 以它为准，
      // 不抄应用里的常量，也不手抄名单（包换了名单这条断言自动跟着换）。
      const res = await fetch('/packs/harry-potter/pack.json', { cache: 'no-store' });
      const manifest = await res.json();
      const files = (manifest.contents && manifest.contents.characters) || [];
      return files.map((one) => String(one).split('/').pop());
    })()`);
    assert(builtinAvatars.length >= 1, "没能从内置包里读出角色头像清单：" + JSON.stringify(builtinAvatars));
    const builtinRows = rows.filter((row) => builtinAvatars.indexOf(row.avatar) >= 0);
    assert(builtinRows.length >= 1, "内置包那几张卡没有列出来：" + JSON.stringify(rows.map((r) => r.avatar)));
    for (const row of builtinRows) {
      assert(row.disabled === true, row.name + " 是内置小说人物，这一行不该能点：" + JSON.stringify(row));
      assert(row.checked === false, row.name + " 是内置小说人物，开关却是开着的");
      assert(row.text.indexOf("内置角色不可") >= 0, row.name + " 这一行没写清为什么不能开：" + row.text);
      assert(row.title.indexOf("内置") >= 0, row.name + " 没给出原因（title 是空的或没说清）：" + row.title);
    }
    // ①b 反向：非内置的合成卡**不该**被打上"内置角色不可用"，否则就是判定过宽。
    const syntheticRows = rows.filter((row) => builtinAvatars.indexOf(row.avatar) < 0);
    assert(syntheticRows.length >= 1, "fixture 里应当还有合成卡：" + JSON.stringify(rows.map((r) => r.avatar)));
    for (const row of syntheticRows) {
      assert(row.text.indexOf("内置角色不可") < 0,
        row.name + " 不是内置小说人物，却被当成内置角色禁掉了：" + JSON.stringify(row));
    }
    // ② 定制角色：能点。
    const customRow = rows.find((row) => row.avatar === friend);
    assert(customRow, "刚导入的定制角色没有出现在角色管理里：" + JSON.stringify(rows.map((r) => r.avatar)));
    assert(customRow.disabled === false, "定制角色的伴侣开关应当是能点的：" + JSON.stringify(customRow));

    // ③ 绕过界面（有人用脚本直接把 checked 设上 + 派发 change）也不该写进内置角色的档案 ——
    //    这验的是"闸在写入口，不只画在界面上"。
    const bypass = await evaluate(`(async () => {
      const box = Array.from(document.querySelectorAll('#characterManageList [data-companion-avatar]'))
        .find((node) => node.dataset.companionAvatar === ${JSON.stringify("Harry Potter (EN).png")});
      if (!box) return { ok: false, error: '找不到内置角色那一行' };
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

    // ④ 定制角色：给**非当前**对话的那个开，不会牵动当前角色；能开也能关。
    const current = (await activeCharacterName()) || "";
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
    assert(other.stored === true, "在角色那一行打开伴侣模式没有落盘：" + JSON.stringify(other));
    assert(other.toast.indexOf("伴侣模式") >= 0 || other.toast.indexOf(CUSTOM_NAME) >= 0,
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
    if (current && current !== CUSTOM_NAME) {
      assert(untouched === false, "给别的角色开伴侣模式，把当前角色也带开了：" + untouched);
    }

    // 收尾：关回去（后面的用例假定它没开），别影响别的用例。
    await evaluate(`(async () => {
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
    await removeBuiltinCard();
  });

  await check("内置小说人物不发声：老存档里开着伴侣也不给朗读、请求里不带微信段落", async () => {
    // 用户 2026-09-14：「小说人物不设置伴侣，不设置语音」「其他都不做语音」。
    //
    // ⚠ 为什么补这一条（2026-09-15 反例检查抓出来的覆盖缺口）：
    //   把 `companion-core.voiceAccess()` 改成**永远 allowed**（变异⑤）之后，**整套 96 条照样全绿** ——
    //   也就是说"内置角色拿不到语音"这条闸当时**一条断言都没有**：
    //     · 上面那条只钉了 `companionAccess`（伴侣开关那一行禁用），那是**另一道闸**；
    //     · `voiceAccess` 管三处：消息菜单里显不显示「朗读」、`plainChatBlock` 要不要给这一轮
    //       注入「模仿微信聊天」那一段、以及合成前再判一次。
    //   漏掉它的后果不是"少一个按钮"：内置角色会被注入"只写对白、不许写旁白"的整段微信规则
    //   （等于悄悄改掉小说人物的说话方式），而且菜单里会多出一个点得动的朗读。
    //   所以这条用例**故意**给内置角色写一份「伴侣开着 + 软件聊天」的档案（模拟老存档），
    //   再验语音那一侧一个都不生效 —— 与上面那条合起来，两道闸各钉一次。
    await ensureBuiltinCard();
    const builtinProfile = await evaluate(`(async () => {
      const entry = { avatar: ${JSON.stringify(BUILTIN_CARD_AVATAR)}, charName: ${JSON.stringify(BUILTIN_CARD_NAME)} };
      const prev = await window.TASK21.loadCompanion(entry);
      await window.TASK21.saveCompanion(entry, Object.assign({}, prev, { enabled: true, relation: 'partner', chatStyle: 'plain' }));
      const back = await window.TASK21.loadCompanion(entry);
      return { enabled: back.enabled === true, style: back.chatStyle };
    })()`);
    assert(builtinProfile.enabled && builtinProfile.style === "plain",
      "没能给内置角色写出一份「伴侣 + 软件聊天」的老存档（这一条的前置）：" + JSON.stringify(builtinProfile));
    const ready = await openAppWithVoice({ enable: true });
    assert(ready.canSpeak, "前置不成立：这台设备现在不能朗读 —— " + ready.reason);
    await openChatFor(BUILTIN_CARD_AVATAR, BUILTIN_CARD_NAME, "ginny-老存档");
    await evaluate("(async () => { await fetch('/__reply-clear', { method: 'POST' }); return true; })()");

    const before = voiceRequests.length;
    await sendOneTurn("说句话");
    // 断言①：这一轮的请求里**没有**微信那一段（voiceAccess 的第二处调用点）。
    const last = requests.filter((row) => row.stream === true).slice(-1)[0];
    assert(last && last.systemText, "这一轮没有拿到请求现场");
    assert(last.systemText.indexOf("WeChat-style") < 0 && last.systemText.indexOf("模仿真实微信") < 0,
      "内置小说人物的请求里被注入了「模仿微信聊天」那一段（只该给有语音资格的定制角色）："
      + JSON.stringify(last.systemText.slice(0, 200)));
    // 断言②：消息菜单里**没有**「朗读」（voiceAccess 的第一处调用点）。
    const menu = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      if (!row) return { row: false };
      return {
        row: true,
        actions: Array.from(row.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction),
        labels: Array.from(row.querySelectorAll('.message-menu-item')).map((n) => (n.textContent || '').trim()),
      };
    })()`);
    assert(menu.row, "没有找到助手消息行，菜单判据不成立");
    assert(menu.actions.length >= 1, "消息菜单里一个操作都没有（判据不成立）：" + JSON.stringify(menu));
    assert(menu.actions.indexOf("speak") < 0,
      "内置小说人物的消息菜单里出现了「朗读」（它不发语音）：" + JSON.stringify(menu));
    // 断言③：这一轮**没有**合成请求。
    await sleep(1500);
    assert(voiceRequests.length === before,
      "内置小说人物居然发起了语音合成：" + JSON.stringify(voiceRequests.slice(before)));
    try {
      await closeAppWithVoice();
    } finally {
      await removeBuiltinCard();
    }
  });

  await check("消息菜单：每条消息都有入口，手机上不用悬停也点得到，复制真的复制到了", async () => {
    await goto(base + "/index.html?onboarding=off&surprise=off");
    await waitFor("window.TASK21_READY === true", 30000);
    // 这一条自带端点设置：前面的用例可能把服务商/地址留在别的状态（比如体验卡那条），
    // 用这里明确指定的假端点，别让本轮测试依赖"上一条留下的状态"。
    await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash", card_relay: "" });
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "${base}/v1/chat/completions" } }));
      return true;
    })()`);
    // 先造出两轮对话（用户消息 + 角色回复）。清空待用队列，保证这一轮拿到的是我们指定的那句。
    await fetch(base + "/__reply-clear", { method: "POST" });
    await evaluate(`fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '第一版回答。' }) }).then(() => true)`);
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '第一条消息';
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
    assert(diag.rows >= 2, "没造出两轮对话：" + JSON.stringify(diag));

    // ① 每条消息旁边都要有操作入口（这是"把操作放在消息旁边"的最低要求）。
    const rows = await evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      return all.map((row) => ({
        hasMenu: !!row.querySelector('.message-menu-button'),
        index: row.dataset.messageIndex || '',
        isUser: row.classList.contains('message-row-user'),
      }));
    })()`);
    assert(rows.length >= 2, "没造出两轮对话：" + JSON.stringify(rows));
    assert(rows.every((row) => row.hasMenu), "有消息没有操作入口：" + JSON.stringify(rows));
    assert(rows.every((row) => row.index !== ""), "消息没有记下自己的位置（编辑/重答/分支都要用它）：" + JSON.stringify(rows));

    // ② 手机（窄屏）不依赖悬停：按钮要看得见、点得着。
    await cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
    assert(mobile.reachable, "手机上操作入口点不到：" + JSON.stringify(mobile));

    // ③ 真点开菜单 → 菜单项要对（用户消息：复制/编辑/从这里开分支）。
    const menu = await evaluate(`(() => {
      const userRow = document.querySelector('#dynamicMessages .message-row-user');
      userRow.querySelector('.message-menu-button').click();
      const box = userRow.querySelector('.message-menu');
      const items = Array.from(box.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction);
      const r = box.getBoundingClientRect();
      const inView = r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1;
      return { open: !box.hidden, items, inView, label: box.textContent };
    })()`);
    assert(menu.open, "点了 ⋯ 菜单没打开");
    assert(menu.items.join(",") === "copy,edit,branch", "用户消息的菜单项不对：" + menu.items.join(","));
    assert(menu.inView, "菜单跑到屏幕外了");

    // ④ 复制：走真点击，然后看剪贴板（拿不到剪贴板权限时退回"提示已复制/请手动复制"）。
    const copied = await evaluate(`(async () => {
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
    assert(copied.menuClosed, "点完菜单项菜单没关");
    assert(copied.clip === "第一条消息" || copied.toast.indexOf("复制") >= 0,
      "复制既没进剪贴板也没给提示：" + JSON.stringify(copied));

    // ⑤ 助手的消息菜单项不一样：重新回答 + 从这里开分支。
    const assistantMenu = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row')).find((n) => !n.classList.contains('message-row-user'));
      row.querySelector('.message-menu-button').click();
      const items = Array.from(row.querySelectorAll('.message-menu-item')).map((n) => n.dataset.messageAction);
      row.querySelector('.message-menu-button').click();
      return items;
    })()`);
    assert(assistantMenu.join(",") === "copy,regenerate,branch", "助手消息的菜单项不对：" + assistantMenu.join(","));
    await cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
  });

  await check("重新回答：旧答案留在版本里能切回去，上下文跟着当前版本走", async () => {
    // 自带前置：这一组（伴侣 / 语音）会切到定制角色的对话，而这条用例按 Harry 那段写。
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    // 用**最后一条**角色回复：伴侣模式开着时，打开对话可能先来一条"主动开口"的消息，
    // 取第一条会拿到它（这一条自身踩过一次）。
    const lastAssistant = `Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop()`;
    const firstReply = await evaluate(`(() => {
      const row = ${lastAssistant};
      return row ? window.__rwReadAssistantText(row) : '';
    })()`);
    assert(firstReply.length > 0, "没有找到角色回复");
    const userRowsBefore = await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length");
    void userRowsBefore;
    // 渲染会把换行与引号整理过，比内容时统一去掉空白。
    const flat = (value) => String(value || "").replace(/\s+/g, "");
    const storedCountBefore = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      return (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string').length;
    })()`);
    assert(storedCountBefore >= 2, "对话里还没有落盘的消息：" + storedCountBefore);

    // 让下一次回复是一句明显不同的文本，再点「重新回答」。
    await fetch(base + "/__reply-clear", { method: "POST" });
    await evaluate(`fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '第二版回答，完全不一样。' }) }).then(() => true)`);
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
      const body = row;
      return {
        text: window.__rwReadAssistantText(row),
        labels: Array.from(document.querySelectorAll('#dynamicMessages .message-version-label')).map((n) => n.textContent),
        userRows: document.querySelectorAll('#dynamicMessages .message-row-user').length,
        userTexts: Array.from(document.querySelectorAll('#dynamicMessages .message-row-user .user-bubble')).map((n) => n.textContent.slice(0, 24)),
        assistantRows: rows.length,
      };
    })()`);
    assert(after.labels.join(",") === "2 / 2", "重新回答之后没有出现「2 / 2」的版本切换：" + JSON.stringify(after.labels));
    // 关键断言：重新回答**替换一条**，不是追加一轮 —— 所以落盘的消息条数必须不变
    // （假端点有可能两次给同一句话，所以不能拿文本比对来判断）。
    const storedAfter = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      return (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string').length;
    })()`);
    assert(storedAfter === storedCountBefore,
      "重新回答追加了消息（应当只替换一条）：落盘条数 " + storedCountBefore + " → " + storedAfter + " " + JSON.stringify(after));

    // 把当前这一版改成一个明显不同的文本 —— 这样两个版本一定不一样，
    // 切回旧版本时就能证明"旧答案还在"（假端点有可能两次给同一句）。
    await evaluate(`window.TASK21.editMessageText(${regen}, '改过的第二版')`);
    await waitFor("(document.querySelectorAll('#dynamicMessages .message-version-label')[0] || {}).textContent === '2 / 2'", 8000);
    const edited = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      return window.__rwReadAssistantText(row);
    })()`);
    assert(edited.indexOf("改过的第二版") >= 0, "编辑当前版本没生效：" + edited.slice(0, 60));

    // 切回第一版：旧答案必须原样还在，而且 mes 跟着变（下一轮上下文就用它）。
    await evaluate(`(() => {
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
    assert(back.stored, "读不到落盘的那条消息：" + JSON.stringify({ fileName: back.fileName, count: back.count }));
    assert(flat(back.text) === flat(firstReply), "切回旧版本之后界面没变回来：" + JSON.stringify({ now: back.text.slice(0, 40), was: firstReply.slice(0, 40) }));
    // 落盘的那一条：swipe_id 指回第 1 版，而且 mes（= 下一轮上下文用的那一版）就是第 1 版的内容。
    assert(back.stored.swipe_id === 0, "切版本之后 swipe_id 没跟回去：" + JSON.stringify(back.stored.swipe_id));
    assert(flat(back.stored.mes) === flat(back.stored.swipes[0]),
      "mes 没有跟着当前版本走（下一轮会拿到错的那一版）：" + JSON.stringify({ mes: back.stored.mes, v1: back.stored.swipes[0] }).slice(0, 200));
    assert(Array.isArray(back.stored.swipes) && back.stored.swipes.length === 2, "两个版本应当都在 swipes 里：" + JSON.stringify(back.stored.swipes));
    assert(back.stored.swipes[1].indexOf("改过的第二版") >= 0, "第二版没留在 swipes 里：" + JSON.stringify(back.stored.swipes));
  });

  await check("编辑与分支：改最后一条就地生效；改更早的会开新分支且原对话不动", async () => {
    // 页面前置：这条用例读的是"当前这段对话"的界面 DOM，单跑时页面可能停在 magic-map 上
    // （magic-map 上既没有 #dynamicMessages 也没有 TASK21，会直接抛 TypeError）。
    await ensureChatPage();
    // 上下文前置：本用例按 **Harry 那段** 写断言（落盘要能在 Harry 的对话里查到）。
    // 共享前置会把活动对话切到定制角色那段（诊断实证：改动落进了 linmo-量身对话），
    // 所以这里必须把上下文显式钉死成 harry-最近聊过，不能靠"上一条用例留下的状态"。
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    // ⚠ 这句只能放在**开头**：上下文一旦建立就不要再切 —— 中途切会把活动对话换掉，
    //   编辑的是"当前这段"、断言看的却是另一段（这条注释警告的就是那个坑，不是"不许有前置"）。
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

    // ① 编辑最后一条用户消息：就地改，不新增消息。
    const edit = await evaluate(`(async () => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
      const row = rows[rows.length - 1];
      const index = Number(row.dataset.messageIndex);
      const ok = await window.TASK21.editMessageText(index, '改过之后的这一句');
      return { index, ok };
    })()`);
    assert(edit.ok === true, "编辑最后一条用户消息没有生效：" + JSON.stringify(edit));
    const afterEdit = await readChats();
    const totalAfterEdit = afterEdit.reduce((sum, row) => sum + row.count, 0);
    assert(totalAfterEdit === totalBefore, "编辑不该改变消息条数：" + totalBefore + " → " + totalAfterEdit);
    // ⚠ 编辑是"先写盘、再重画"（editMessageText 末尾才 refreshChatMessages），
    //   写完立刻读界面会读到重画之前的 DOM —— 这里改成**等界面真的出现**那句话。
    const shownEdited = await waitFor(
      "document.querySelector('#dynamicMessages').textContent.indexOf('改过之后的这一句') >= 0", 8000
    ).then(() => true).catch(async () => {
      const diag = await evaluate(`(() => ({
        container: (document.querySelector('#dynamicMessages') || {}).textContent ? document.querySelector('#dynamicMessages').textContent.slice(0, 120) : null,
        rows: document.querySelectorAll('#dynamicMessages .message-row').length,
      }))()`).catch(() => null);
      throw new Error("改完的内容没有反映到界面上（等了 8 秒）。诊断：" + JSON.stringify(diag));
    });
    // 编辑的那条在对话中间，不是首尾 —— 所以要扫全部对话的全部消息来找它。
    const storedEdited = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      let hits = 0;
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const fileName = row.fileName || row.file_name || row.id || '';
        if (!fileName) continue;
        let lines = [];
        try { lines = await window.STApi.getChat('Harry Potter (EN).png', fileName) || []; } catch (_) { lines = []; }
        hits += (Array.isArray(lines) ? lines : []).filter((line) => line && line.mes === '改过之后的这一句').length;
      }
      return hits;
    })()`);
    assert(storedEdited === 1, "改完的内容没有落盘（应当正好一条）：" + storedEdited);
    assert(shownEdited, "改完的内容没有反映到界面上");

    // ② 从一条较早的消息开分支：多出一个对话文件，原对话一条都没少。
    const branch = await evaluate(`(async () => {
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
    assert(branch.ok === true, "开分支失败：" + JSON.stringify(branch));
    assert(branch.afterCount === branch.beforeCount + 1, "分支应当是**多出一个对话文件**：" + JSON.stringify(branch));
    assert(branch.toast.indexOf("分支") >= 0 && branch.toast.indexOf("原对话没有改动") >= 0,
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

  await check("失败重试：原话留在屏幕上，重试不产生重复的用户消息", async () => {
    // 自带前置：这一组（伴侣 / 语音）会切到定制角色的对话，而这条用例按 Harry 那段写。
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
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
        userText: retry.dataset.userText || '',
      };
    })()`);
    assert(card.text.indexOf('这一句会失败') >= 0, "失败卡片上没有保留用户原话：" + card.text);
    assert(card.why.indexOf('原因') >= 0, "失败卡片没说原因：" + card.why);
    assert(card.retryVisible && card.retryReachable, "重试按钮点不到：" + JSON.stringify(card));
    assert(card.userText === '这一句会失败', "重试按钮没记住要重发的那句话：" + card.userText);
    assert(await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length") === userRowsBefore,
      "失败的那一轮不该在对话里留下一条用户消息");

    // 点重试 → 这次成功。同一句话只能出现一次（不是"再发一遍"）。
    await fetch(base + "/__reply-clear", { method: "POST" });
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "这次成功了。" }) });
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
    assert(after.sameText === 1, "重试之后这句话被写了两遍：" + JSON.stringify(after));
    assert(after.userRows === userRowsBefore + 1, "重试之后界面上应当多一条用户消息：" + JSON.stringify(after));
    assert(after.failures === 0, "重试成功后失败卡片应当消失：" + JSON.stringify(after));
  });

  await check("保存失败重试：只重试保存，不再调用模型", async () => {
    // 目标行为（2026-09-17 排定的唯一下一项）：回复已生成、只差写盘时，
    // 「重试」应该把**已生成的回复**补写进对话，而不是把整轮重新问一遍模型。
    // 修复前保存失败的卡片被重绘清除；普通 retry-turn 会走整条 sendLive。
    // 前序半截标记测试会留下慢流脚本（它优先于回复队列），本例明确关闭。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    const saved = await evaluate(`(async () => {
      // 拦截保存接口：第一次调用失败（模拟写盘失败，例如 Windows 文件被占用），
      // 之后恢复正常 —— 这是与请求失败不同的一条故障路径。
      const real = window.STApi.saveChat.bind(window.STApi);
      window.__saveCalls = 0;
      window.STApi.saveChat = async (...args) => {
        window.__saveCalls += 1;
        if (window.__saveCalls === 1) throw new Error('模拟写盘失败：文件被占用');
        return real(...args);
      };
      return true;
    })()`);
    assert(saved === true, "无法注入保存失败");
    await fetch(base + "/__reply-clear", { method: "POST" });
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "回复已生成但没存上。" }) });
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '这一句保存会失败';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitTurnSettled();
    const diagnostic = await evaluate(`(() => ({
      saveCalls: window.__saveCalls,
      toast: (document.querySelector('#toast') || {}).textContent || '',
      replyVisible: String((document.querySelector('#dynamicMessages') || {}).textContent || '').includes('回复已生成但没存上。'),
      retryPresent: !!document.querySelector("[data-action='retry-turn'], [data-action='retry-save']"),
    }))()`);
    assert(diagnostic.saveCalls === 1, '保存故障未命中：' + JSON.stringify(diagnostic));
    assert(diagnostic.replyVisible, '失败后没有保留原回复：' + JSON.stringify(diagnostic));
    assert(diagnostic.retryPresent, '保存失败后没有重试入口：' + JSON.stringify(diagnostic));
    const modelCallsBefore = requests.filter((row) => row.path === '/v1/chat/completions').length;
    await fetch(base + "/__reply-clear", { method: "POST" });
    await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "这次不该出现的新回复。" }) });
    // 第二次写盘也失败：入口与原回复必须继续保留。
    await evaluate(`(() => {
      window.__saveCalls = 0;
      document.querySelector("[data-action='retry-save']").click();
      return true;
    })()`);
    await waitTurnSettled();
    await waitFor("document.querySelector('.turn-failure-why').textContent.includes('仍未保存')", 8000);
    assert(requests.filter((row) => row.path === '/v1/chat/completions').length === modelCallsBefore,
      '再次保存失败不该请求模型');
    assert(await evaluate("document.querySelector('#dynamicMessages').textContent.includes('回复已生成但没存上。')"),
      '第二次保存失败丢失了原回复');
    // 同一按钮连续点击也只允许一路写入；保存不能抹掉用户新起草的输入。
    await evaluate(`(() => {
      document.querySelector('#messageInput').value = '下一句草稿不要清掉';
      const retry = document.querySelector("[data-action='retry-save']");
      retry.click(); retry.click();
      return true;
    })()`);
    await waitTurnSettled();
    await waitFor("document.querySelector('.turn-failure') === null", 8000);
    assert(await evaluate("window.__saveCalls") === 2, '重复点击产生了重复写入');
    assert(await evaluate("document.querySelector('#messageInput').value") === '下一句草稿不要清掉', '补存清掉了新草稿');
    await goto(base + '/index.html');
    await waitFor('window.TASK21_READY === true', 30000);
    await ensureChatPage();
    await openChatFor('Harry Potter (EN).png', 'Harry Potter', 'harry-最近聊过');
    await waitFor("document.querySelector('#dynamicMessages').textContent.includes('回复已生成但没存上。')", 8000);
    const modelCallsAfter = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const list = Array.isArray(rows) ? rows : [];
      const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      const messages = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string');
      return {
        calls: ${requests.filter((row) => row.path === '/v1/chat/completions').length},
        userSaved: messages.filter((line) => line.mes === '这一句保存会失败').length,
        replySaved: messages.filter((line) => line.mes === '回复已生成但没存上。').length,
        wrongReply: messages.filter((line) => line.mes === '这次不该出现的新回复。').length,
      };
    })()`);
    assert(modelCallsAfter.calls === modelCallsBefore,
      "重试不该再次调用模型：修复前=" + modelCallsBefore + " 重试后=" + modelCallsAfter.calls);
    assert(modelCallsAfter.userSaved === 1, "原话应当只保存一次：" + modelCallsAfter.userSaved);
    assert(modelCallsAfter.replySaved === 1, "已生成的回复应当被补存：" + modelCallsAfter.replySaved);
    assert(modelCallsAfter.wrongReply === 0, "重试不该产生新的模型回复：" + modelCallsAfter.wrongReply);
  });

  await check("保存提交与界面同步分离：已经写盘成功就不能谎报没存上，也不能留下会重复发送的输入", async () => {
    // 目标行为（2026-09-17 排定的唯一下一项）：写盘与回执都成功、只是**之后的界面同步**抛错时，
    // 这一轮不是保存失败。谎报失败会把原话塞回输入框 —— 用户再点一次发送就会多写一轮。
    // 注入方式：真存成功之后再武装，syncActiveSession 紧接着会调用 TASK25C_UI.nickname()。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    const armed = await evaluate(`(() => {
      const ui = window.TASK25C_UI;
      if (!ui || typeof ui.nickname !== 'function') return false;
      const origSave = window.STApi.saveChat;
      const origNickname = ui.nickname;
      window.__uiSyncArmed = false;
      window.__uiSyncThrown = 0;
      window.STApi.saveChat = async (...args) => {
        const result = await origSave.apply(window.STApi, args);
        window.__uiSyncArmed = true;
        return result;
      };
      ui.nickname = (...args) => {
        if (window.__uiSyncArmed) {
          window.__uiSyncArmed = false;
          window.__uiSyncThrown += 1;
          throw new Error('模拟写盘之后的界面同步失败');
        }
        return origNickname.apply(ui, args);
      };
      window.__restoreUiSync = () => { window.STApi.saveChat = origSave; ui.nickname = origNickname; };
      return true;
    })()`);
    assert(armed === true, '无法注入“写盘成功之后的界面同步失败”');
    try {
      await fetch(base + "/__reply-clear", { method: "POST" });
      await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "写盘成功但界面同步失败的一轮。" }) });
      const modelCallsBefore = requests.filter((row) => row.path === '/v1/chat/completions').length;
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '这一句其实存上了';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      await sleep(600);
      const state = await evaluate(`(async () => {
        const rows = await window.STApi.listChats('Harry Potter (EN).png');
        const all = [];
        for (const row of (Array.isArray(rows) ? rows : [])) {
          const lines = await window.STApi.getChat('Harry Potter (EN).png', row.fileName || row.file_name || row.id);
          all.push(...(Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string'));
        }
        return {
          thrown: window.__uiSyncThrown,
          userSaved: all.filter((line) => line.mes === '这一句其实存上了').length,
          replySaved: all.filter((line) => line.mes === '写盘成功但界面同步失败的一轮。').length,
          failures: document.querySelectorAll('.turn-failure').length,
          failureText: Array.from(document.querySelectorAll('.turn-failure')).map((n) => n.textContent).join(' | '),
          status: (document.querySelector('#chatListStatus') || {}).textContent || '',
          inputValue: (document.querySelector('#messageInput') || {}).value || '',
          toast: (document.querySelector('#toast') || {}).textContent || '',
          replyVisible: String((document.querySelector('#dynamicMessages') || {}).textContent || '').includes('写盘成功但界面同步失败的一轮。'),
        };
      })()`);
      assert(state.thrown === 1, '前置不成立：界面同步没有抛错，这条用例没测到目标：' + JSON.stringify(state));
      assert(state.userSaved === 1 && state.replySaved === 1, '这一轮应当已经写进本机文件：' + JSON.stringify(state));
      assert(state.failures === 0, '已经存上的这一轮不该显示失败卡片：' + state.failureText);
      assert(state.status.indexOf('没能写进本机文件') < 0, '已经存上的这一轮不该说“没能写进本机文件”：' + state.status);
      assert(state.inputValue === '', '已经存上的这一轮不该把原话塞回输入框（再点发送会重复写一轮）：' + state.inputValue);
      assert(state.replyVisible, '这一轮应当显示在界面上（界面同步要自己重试一次）：' + JSON.stringify(state));
      assert(requests.filter((row) => row.path === '/v1/chat/completions').length === modelCallsBefore + 1,
        '这一轮只该发一次模型请求（界面同步失败不该触发重新生成）');
    } finally {
      await evaluate("(() => { if (window.__restoreUiSync) window.__restoreUiSync(); return true; })()").catch(() => {});
    }
  });

  await check("保存失败带原始错误码：正文不能丢，也不能说成回复失败", async () => {
    // 外层只认 `err.code === "SAVE_FAILED"` 这个字符串时，像 EBUSY 这种**自带错误码**的
    // 写盘失败会跳过“把正文留在屏幕上 + 状态行说明”那条分支，提示还会说成“回复失败”。
    // 目标是按“是不是保存失败”分类，而不是按错误码字符串分类。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    const armed = await evaluate(`(() => {
      const origSave = window.STApi.saveChat;
      window.__rawCodeSaveCalls = 0;
      window.STApi.saveChat = async (...args) => {
        window.__rawCodeSaveCalls += 1;
        if (window.__rawCodeSaveCalls === 1) {
          throw Object.assign(new Error('模拟文件被占用（EBUSY）'), { code: 'EBUSY' });
        }
        return origSave.apply(window.STApi, args);
      };
      window.__restoreRawCode = () => { window.STApi.saveChat = origSave; };
      return true;
    })()`);
    assert(armed === true, '无法注入带原始错误码的保存失败');
    try {
      await fetch(base + "/__reply-clear", { method: "POST" });
      await fetch(base + "/__reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "带原始错误码的这轮回复内容。" }) });
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '这一句会撞上 EBUSY';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#sendButton').click();
        return true;
      })()`);
      await waitTurnSettled();
      await sleep(400);
      const state = await evaluate(`(() => ({
        saveCalls: window.__rawCodeSaveCalls,
        replyVisible: String((document.querySelector('#dynamicMessages') || {}).textContent || '').includes('带原始错误码的这轮回复内容。'),
        retrySave: !!document.querySelector("[data-action='retry-save']"),
        failureCards: document.querySelectorAll('.turn-failure').length,
        retryButtons: document.querySelectorAll("[data-action='retry-save']").length,
        status: (document.querySelector('#chatListStatus') || {}).textContent || '',
        toast: (document.querySelector('#toast') || {}).textContent || '',
      }))()`);
      assert(state.saveCalls === 1, '前置不成立：保存失败没命中：' + JSON.stringify(state));
      assert(state.retrySave, '应当给出“重试保存”入口：' + JSON.stringify(state));
      assert(state.failureCards === 1 && state.retryButtons === 1,
        '保存失败只该给一张卡片、一个重试入口：' + JSON.stringify(state));
      assert(state.replyVisible, '保存失败时正文不能从屏幕上消失：' + JSON.stringify(state));
      assert(state.status.indexOf('没能写进本机文件') >= 0, '状态行应当说清是保存问题：' + JSON.stringify(state));
      assert(state.toast.indexOf('回复失败') < 0, '保存失败不该说成“回复失败”：' + state.toast);
    } finally {
      await evaluate("(() => { if (window.__restoreRawCode) window.__restoreRawCode(); return true; })()").catch(() => {});
    }
  });

  /** 注入“写盘成功、随后的界面同步抛一次错”：
   *  真 saveChat 成功返回后再武装，syncActiveSession 紧接着会调用 TASK25C_UI.nickname()。 */
  async function armUiSyncFailure() {
    return evaluate(`(() => {
      const ui = window.TASK25C_UI;
      if (!ui || typeof ui.nickname !== 'function') return false;
      const origSave = window.STApi.saveChat;
      const origNickname = ui.nickname;
      window.__uiSyncArmed = false;
      window.__uiSyncThrown = 0;
      window.STApi.saveChat = async (...args) => {
        const result = await origSave.apply(window.STApi, args);
        window.__uiSyncArmed = true;
        return result;
      };
      ui.nickname = (...args) => {
        if (window.__uiSyncArmed) {
          window.__uiSyncArmed = false;
          window.__uiSyncThrown += 1;
          throw new Error('模拟写盘之后的界面同步失败');
        }
        return origNickname.apply(ui, args);
      };
      window.__restoreUiSync = () => { window.STApi.saveChat = origSave; ui.nickname = origNickname; };
      return true;
    })()`);
  }

  await check("重新回答写盘成功也不算没保存：按本机文件回读纠正", async () => {
    // 只读复核（Union Alpha）确认的既存误判：重新回答走 persistMessages 写盘，
    // 但**不写这轮回执** —— 所以“写盘成功、随后界面同步抛错”没有回执可判，
    // 会谎报“没能写进本机文件”，并把用户那条话再画一遍（保留逻辑把原话又拼了一次）。
    // 权威判据应当是：回执之外，再翻一次本机文件里有没有这一轮的 turnId。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    await fetch(base + '/__reply-clear', { method: 'POST' });
    await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '第一版回答。' }) });
    await sendOneTurn('回读验证：先聊一句');
    const armed = await armUiSyncFailure();
    assert(armed === true, '无法注入“写盘成功之后的界面同步失败”');
    try {
      const userRowsBefore = await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length");
      await fetch(base + '/__reply-clear', { method: 'POST' });
      await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '第二版：这版一定要存住。' }) });
      const modelCallsBefore = requests.filter((row) => row.path === '/v1/chat/completions').length;
      await evaluate(`(() => {
        // 上一条用例可能留下 toast；这里清掉，免得把别人的提示当成这一轮的（实测踩过）。
        const toast = document.querySelector('#toast');
        if (toast) toast.textContent = '';
        const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
        const row = rows[rows.length - 1];
        window.TASK21.regenerateReply(Number(row.dataset.messageIndex));
        return true;
      })()`);
      await waitTurnSettled();
      await sleep(600);
      const state = await evaluate(`(async () => {
        const rows = await window.STApi.listChats('Harry Potter (EN).png');
        const list = Array.isArray(rows) ? rows : [];
        const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
        const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
        const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
        const messages = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string');
        const last = messages[messages.length - 1] || {};
        return {
          thrown: window.__uiSyncThrown,
          count: messages.length,
          lastText: String(last.mes || '').slice(0, 30),
          swipeVersions: Array.isArray(last.swipes) ? last.swipes.length : 0,
          userRows: document.querySelectorAll('#dynamicMessages .message-row-user').length,
          status: (document.querySelector('#chatListStatus') || {}).textContent || '',
          toast: (document.querySelector('#toast') || {}).textContent || '',
        };
      })()`);
      assert(state.thrown === 1, '前置不成立：界面同步没有抛错，这条用例没测到目标：' + JSON.stringify(state));
      assert(state.swipeVersions >= 2, '重新回答应当把新版本写进 swipes：' + JSON.stringify(state));
      assert(state.status.indexOf('没能写进本机文件') < 0,
        '已经存上的重新回答不该说“没能写进本机文件”：' + state.status);
      assert(state.toast.indexOf('没存上') < 0, '已经存上的重新回答不该说“没存上”：' + state.toast);
      assert(state.userRows === userRowsBefore,
        '重新回答不该在界面上多画一条用户消息：' + userRowsBefore + ' → ' + state.userRows);
      assert(requests.filter((row) => row.path === '/v1/chat/completions').length === modelCallsBefore + 1,
        '重新回答只该发一次模型请求（不该因为误判重发）');
    } finally {
      await evaluate("(() => { if (window.__restoreUiSync) window.__restoreUiSync(); return true; })()").catch(() => {});
    }
  });

  await check("重新回答真的存不上：不重复画用户消息，并且能只补保存这一版", async () => {
    // 复核项 B 的另一半：重新回答**真**失败（写盘前就抛）时，现在既没有补存入口，
    // 界面保留逻辑还会把已经在上面的用户那条话再画一遍。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    await fetch(base + '/__reply-clear', { method: 'POST' });
    await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '第一版回答。' }) });
    await sendOneTurn('真失败验证：先聊一句');
    // 装一个“第一次保存一定失败”的注入器（写盘前抛，属于真失败）。
    const armed = await evaluate(`(() => {
      const origSave = window.STApi.saveChat;
      window.__regenFailCalls = 0;
      window.STApi.saveChat = async (...args) => {
        window.__regenFailCalls += 1;
        if (window.__regenFailCalls === 1) {
          throw Object.assign(new Error('模拟写盘被占用'), { code: 'EBUSY' });
        }
        return origSave.apply(window.STApi, args);
      };
      window.__restoreRegenFail = () => { window.STApi.saveChat = origSave; };
      return true;
    })()`);
    assert(armed === true, '无法注入重新回答的保存失败');
    try {
      const userRowsBefore = await evaluate("document.querySelectorAll('#dynamicMessages .message-row-user').length");
      await fetch(base + '/__reply-clear', { method: 'POST' });
      await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '第二版：这次真的存不上。' }) });
      const modelCallsBefore = requests.filter((row) => row.path === '/v1/chat/completions').length;
      await evaluate(`(() => {
        const toast = document.querySelector('#toast');
        if (toast) toast.textContent = '';
        const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
        const row = rows[rows.length - 1];
        window.TASK21.regenerateReply(Number(row.dataset.messageIndex));
        return true;
      })()`);
      await waitTurnSettled();
      await sleep(500);
      const failed = await evaluate(`(() => ({
        saveCalls: window.__regenFailCalls,
        userRows: document.querySelectorAll('#dynamicMessages .message-row-user').length,
        replyVisible: String((document.querySelector('#dynamicMessages') || {}).textContent || '').includes('第二版：这次真的存不上。'),
        retrySave: !!document.querySelector("[data-action='retry-save']"),
        status: (document.querySelector('#chatListStatus') || {}).textContent || '',
      }))()`);
      assert(failed.saveCalls === 1, '前置不成立：保存失败没命中：' + JSON.stringify(failed));
      assert(failed.userRows === userRowsBefore,
        '重新回答失败时不该多画一条用户消息：' + userRowsBefore + ' → ' + failed.userRows);
      assert(failed.replyVisible, '重新回答失败时正文不能丢：' + JSON.stringify(failed));
      assert(failed.retrySave, '重新回答失败时也该有“重试保存”入口：' + JSON.stringify(failed));
      // 点“重试保存”：只补写这一版，不重新请求模型，也不能多出一个版本。
      await evaluate("document.querySelector(\"[data-action='retry-save']\").click(); true");
      await waitTurnSettled();
      await waitFor("document.querySelector('.turn-failure') === null", 8000);
      await sleep(300);
      const after = await evaluate(`(async () => {
        const rows = await window.STApi.listChats('Harry Potter (EN).png');
        const list = Array.isArray(rows) ? rows : [];
        const newest = list.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
        const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
        const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
        const messages = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === 'string');
        const last = messages[messages.length - 1] || {};
        return {
          saveCalls: window.__regenFailCalls,
          swipeVersions: Array.isArray(last.swipes) ? last.swipes.length : 0,
          lastText: String(last.mes || '').slice(0, 20),
          labels: (() => {
            // 只看**最后一条回复**的版本标签：整段对话里别的消息也可能有标签
            // （整轮跑时实测拿到 ["1 / 2","2 / 2","2 / 2"]）。
            const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
            const last = rows[rows.length - 1];
            const label = last && last.querySelector('.message-version-label');
            return label ? label.textContent : '';
          })(),
          failures: document.querySelectorAll('.turn-failure').length,
        };
      })()`);
      assert(after.swipeVersions === 2, '补保存不该多出一个版本（应当正好 2 版）：' + JSON.stringify(after));
      assert(after.lastText.indexOf('第二版') >= 0, '补保存后盘上应当是这一版：' + after.lastText);
      assert(after.labels === '2 / 2', '补保存后最后一条回复的版本切换应当是 2 / 2：' + JSON.stringify(after.labels));
      assert(requests.filter((row) => row.path === '/v1/chat/completions').length === modelCallsBefore + 1,
        '补保存不该再请求模型（重新回答本身 1 次）：' + after.saveCalls);
    } finally {
      await evaluate("(() => { if (window.__restoreRegenFail) window.__restoreRegenFail(); return true; })()").catch(() => {});
    }
  });

  await check("编辑消息保存失败：不能静默，屏幕上和盘上不能各说各话", async () => {
    // 同族路径：`editMessageText` 先把内存里的文字改掉，再 `persistMessages`。
    // 写盘失败时它直接抛出去，调用方是 `.catch(() => {})` —— 用户看不到任何提示，
    // 而内存里已经改了：以后任何一次重画都会显示"改后的文字"，刷新一下又变回原文。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    await fetch(base + '/__reply-clear', { method: 'POST' });
    await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '编辑验证的回复。' }) });
    await sendOneTurn('编辑失败验证：原始原话');
    const target = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
      const row = rows[rows.length - 1];
      return { index: Number(row.dataset.messageIndex) };
    })()`);
    const armed = await evaluate(`(() => {
      const origSave = window.STApi.saveChat;
      window.__editFailCalls = 0;
      window.STApi.saveChat = async (...args) => {
        window.__editFailCalls += 1;
        if (window.__editFailCalls === 1) throw Object.assign(new Error('模拟写盘被占用'), { code: 'EBUSY' });
        return origSave.apply(window.STApi, args);
      };
      window.__restoreEditFail = () => { window.STApi.saveChat = origSave; };
      const toast = document.querySelector('#toast');
      if (toast) toast.textContent = '';
      return true;
    })()`);
    assert(armed === true, '无法注入编辑时的保存失败');
    try {
      const result = await evaluate(`window.TASK21.editMessageText(${target.index}, '改过的文字')
        .then((ok) => ({ ok })).catch((error) => ({ error: String((error && error.message) || error) }))`);
      await sleep(300);
      const state = await evaluate(`(() => ({
        saveCalls: window.__editFailCalls,
        toast: (document.querySelector('#toast') || {}).textContent || '',
        shownText: (() => {
          const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
          const row = rows[rows.length - 1];
          return row ? row.textContent.slice(0, 40) : '';
        })(),
      }))()`);
      assert(result.ok === false,
        '保存失败时应当明确返回失败，而不是抛出去被调用方吞掉：' + JSON.stringify(result));
      assert(state.saveCalls === 1, '前置不成立：保存失败没命中：' + JSON.stringify(state));
      assert(state.toast.indexOf('没保存') >= 0 || state.toast.indexOf('没能') >= 0,
        '编辑没保存上时不能一声不响：' + JSON.stringify(state.toast));
      assert(state.shownText.indexOf('原始原话') >= 0,
        '屏幕上不该显示没保存上的改动：' + state.shownText);
      // 再“改回原样”：内存若已还原，这一次应当直接判成没变化、根本不再写盘。
      const again = await evaluate(`window.TASK21.editMessageText(${target.index}, '编辑失败验证：原始原话')
        .then((ok) => ({ ok })).catch((error) => ({ error: String((error && error.message) || error) }))`);
      await sleep(200);
      assert(await evaluate("window.__editFailCalls") === 1,
        '编辑失败后内存没有还原：又发起了一次写盘（' + JSON.stringify(again) + '）');
    } finally {
      await evaluate("(() => { if (window.__restoreEditFail) window.__restoreEditFail(); return true; })()").catch(() => {});
    }
  });

  await check("切换回复版本保存失败：同样不能静默，界面不能显示没保存上的那一版", async () => {
    // 与刚修的编辑同一形状：`switchMessageVersion` 先改内存 `swipe_id`/`mes`，再 `persistMessages`；
    // 失败时抛出去、调用方 `.catch(() => {})` —— 用户零提示，而界面上"‹ ›"可能已经显示新版本。
    await fetch(base + '/__slow-stream?off=1', { method: 'POST' });
    await ensureChatPage();
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    await fetch(base + '/__reply-clear', { method: 'POST' });
    await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '第一版回答。' }) });
    await sendOneTurn('切版本失败验证：先说一句');
    // 造出第二个版本（用例内部自足，不依赖别的用例留下的版本）。
    await fetch(base + '/__reply-clear', { method: 'POST' });
    await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '第二版回答。' }) });
    await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      window.TASK21.regenerateReply(Number(row.dataset.messageIndex));
      return true;
    })()`);
    await waitTurnSettled();
    const labelOf = `(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      const label = row && row.querySelector('.message-version-label');
      return label ? label.textContent : '';
    })()`;
    await waitFor(`${labelOf} === '2 / 2'`, 10000);
    const idx = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      return Number(rows[rows.length - 1].dataset.messageIndex);
    })()`);
    const armed = await evaluate(`(() => {
      const origSave = window.STApi.saveChat;
      window.__verFailCalls = 0;
      window.STApi.saveChat = async (...args) => {
        window.__verFailCalls += 1;
        if (window.__verFailCalls === 1) throw Object.assign(new Error('模拟写盘被占用'), { code: 'EBUSY' });
        return origSave.apply(window.STApi, args);
      };
      window.__restoreVerFail = () => { window.STApi.saveChat = origSave; };
      const toast = document.querySelector('#toast');
      if (toast) toast.textContent = '';
      return true;
    })()`);
    assert(armed === true, '无法注入切版本时的保存失败');
    try {
      const result = await evaluate(`window.TASK21.switchMessageVersion(${idx}, -1)
        .then((ok) => ({ ok })).catch((error) => ({ error: String((error && error.message) || error) }))`);
      await sleep(300);
      const state = await evaluate(`(() => ({
        saveCalls: window.__verFailCalls,
        toast: (document.querySelector('#toast') || {}).textContent || '',
        label: ${labelOf},
      }))()`);
      assert(result.ok === false,
        '保存失败时应当明确返回失败，而不是抛出去被调用方吞掉：' + JSON.stringify(result));
      assert(state.saveCalls === 1, '前置不成立：保存失败没命中：' + JSON.stringify(state));
      assert(state.toast.indexOf('没保存') >= 0 || state.toast.indexOf('没能') >= 0,
        '切版本没保存上时不能一声不响：' + JSON.stringify(state.toast));
      assert(state.label === '2 / 2', '界面上不该显示没保存上的那一版：' + state.label);
      // 反向探针：内存若已还原（仍停在原来那一版），往相反方向切应当直接夹到同一版、
      // 判成"没变化"而**不再写盘**；没还原的话它会真的再写一次。
      const again = await evaluate(`window.TASK21.switchMessageVersion(${idx}, 1)
        .then((ok) => ({ ok })).catch((error) => ({ error: String((error && error.message) || error) }))`);
      await sleep(200);
      assert(await evaluate("window.__verFailCalls") === 1,
        '切版本失败后内存没有还原：又发起了一次写盘（' + JSON.stringify(again) + '）');
    } finally {
      await evaluate("(() => { if (window.__restoreVerFail) window.__restoreVerFail(); return true; })()").catch(() => {});
    }
  });

  await check("连发：正在回的时候又补一句，会并成一条一起问（像真人那样）", async () => {
    // 用户 2026-09-14：「如果用户连发的话应该也是可以统一回答的，就是尽可能地模仿真人」。
    // 真人聊天里对方还没回你、你补一句，他回的是**你两句话**，而不是各回一次。
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    // 直连假端点此时是"慢流剧本"（每轮约 3 秒）—— 正好用来在生成途中补一句。
    await fetch(base + "/__slow-stream", { method: "POST" });
    const before = requests.filter((row) => row.path === "/v1/chat/completions" && row.stream === true).length;
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '第一句：你在吗';
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
    assert(lastUser.indexOf("第一句") >= 0 && lastUser.indexOf("第二句") >= 0,
      "两句没有并成一条一起问：" + JSON.stringify({ lastUser, count: sent.length }));
    // 界面上这两句也应当是**同一条**用户消息（两行），不是两条。
    const userBubbles = await evaluate(`(() => Array.from(document.querySelectorAll('#dynamicMessages .message-row-user .user-bubble'))
      .map((node) => node.textContent))()`);
    const merged = userBubbles.filter((text) => text.indexOf("第一句") >= 0);
    assert(merged.length === 1, "两句在界面上变成了两条用户消息：" + JSON.stringify(userBubbles));
    assert(merged[0].indexOf("第二句") >= 0, "同一条用户消息里没有第二句：" + JSON.stringify(merged));
    // 被掐掉的那一轮**不该落盘**（否则记录里会留下半个回复，还白花一次钱）。
    const stored = await evaluate(`(async () => {
      const rows = await window.STApi.listChats('Harry Potter (EN).png');
      const newest = (Array.isArray(rows) ? rows : []).slice()
        .sort((a, b) => String(b.lastMessageAt || b.updatedAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || '')))[0];
      const fileName = (newest && (newest.fileName || newest.file_name || newest.id)) || '';
      const lines = fileName ? await window.STApi.getChat('Harry Potter (EN).png', fileName) : [];
      const users = (Array.isArray(lines) ? lines : []).filter((line) => line && line.is_user === true).map((line) => String(line.mes || ''));
      return { users: users.slice(-3) };
    })()`);
    // 并成的那一条**必然同时含两句**；要证的是：没有被掐掉那一轮的半条。
    const onlyFirst = stored.users.filter((text) => text.indexOf("第一句") >= 0 && text.indexOf("第二句") < 0);
    assert(onlyFirst.length === 0,
      "被掐掉的那一轮也落盘了（记录里多了一条只有半句的用户消息）：" + JSON.stringify(stored));
    // 收尾：关掉慢流剧本 + 整页重载，别把这一轮的临时状态留给后面的用例。
    await fetch(base + "/__slow-stream?off=1", { method: "POST" });
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
  });

  await check("刷新之后版本与分支都还在（存的就是看到的）", async () => {
    // 多版本消息可能在**任意一段对话**里（分支用例还会新建对话），所以扫全部对话找，
    // 不要只看"最近更新的那一段"（这一条自己踩过一次）。
    const scan = `(async () => {
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
    assert(after.chats === before.chats, "刷新后对话文件数变了（分支丢了？）：" + before.chats + " → " + after.chats);
    assert(after.swipes === before.swipes && JSON.stringify(after.versions) === JSON.stringify(before.versions),
      "刷新后版本丢了：" + JSON.stringify({ before, after }));
    assert(after.branchFiles === before.branchFiles, "刷新后分支对话不见了：" + JSON.stringify({ before, after }));
  });

  await check("导出再导入之后：版本与分支关系仍然正确", async () => {
    // 用户本轮的验收里明确要求这一条。做法就是应用自己那条路：
    // RoleWorld.exportArchive() → 清库 → RoleWorld.importArchive(dump, {mode:'replace'})。
    const snapshot = () => evaluate(`(async () => {
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
    assert(before.swipes >= 1 && before.branches >= 1, "导出前就没有多版本 / 分支可验，这条用例没意义：" + JSON.stringify(before));

    const dump = await evaluate(`(async () => {
      const data = await window.RoleWorld.exportArchive();
      window.__rwArchiveDump = data;
      return { format: data && data.format, stores: Object.keys((data && data.data) || {}).length };
    })()`);
    assert(dump.format === "roleworld-archive", "导出的存档格式不对：" + JSON.stringify(dump));
    assert(dump.stores > 0, "导出的存档是空的：" + JSON.stringify(dump));

    await evaluate(`(async () => {
      await window.RoleWorld.resetAll();
      await window.RoleWorld.importArchive(window.__rwArchiveDump, { mode: 'replace' });
      return true;
    })()`);

    const after = await snapshot();
    assert(after.chats === before.chats, "导入后对话文件数不对：" + JSON.stringify({ before, after }));
    assert(after.swipes === before.swipes && JSON.stringify(after.versions) === JSON.stringify(before.versions),
      "导入之后版本丢了：" + JSON.stringify({ before, after }));
    assert(after.branches === before.branches, "导入之后分支丢了：" + JSON.stringify({ before, after }));

    // 刷新一次再核对一遍（版本条只画在"当前打开的那段对话"上，
    // 而刷新后打开的不一定是带版本的那一段，所以这里查存储、不查 DOM）。
    await goto(base + "/index.html?onboarding=off&surprise=off");
    await waitFor("window.TASK21_READY === true", 30000);
    const reloaded = await snapshot();
    assert(reloaded.swipes === before.swipes && reloaded.branches === before.branches && reloaded.chats === before.chats,
      "导入并刷新之后版本 / 分支不对：" + JSON.stringify({ before, reloaded }));
  });

  await check("一本角色卡都没有时给出空状态，而不是把整页打挂", async () => {
    // 这一条要的是「真正一本角色卡都没有」的启动现场，而默认状态**永远不是空的**：
    //   · 内置内容包每次启动都会把 6 张卡装回来；
    //   · fixture（测试合成数据）也会在标志位不在时把 3 张卡与对话灌回来。
    // 所以要自己把库清干净，并且**清完立刻整页加载**（顺序见下，每一步都有实测理由）。
    //
    // 为什么（2026-09-15 实测，这一条踩了两轮）：
    //   ① 清库是在当前这个**已经加载好的页面**里做的，而那个页面里的应用内存里仍然有角色
    //      （liveState.characters、会话表、顶栏都是启动时读进去的）——清完不重新加载就断言，
    //      看到的还是清库之前的界面，红成「没有角色卡时输入框仍可用」；
    //   ② `resetAll()` 会把 kv 一起清掉，所以"停用内容包"与"fixture 已导入"这两个标记
    //      必须写在它**之后**，否则下一次启动会把内置包整包重装、fixture 再灌一遍
    //      （实测 reload 之后角色变回 8 张）。
    //   它以前在完整套件里"看起来通过"，只是因为前一条「导出再导入」把 fixture 标志位一起
    //   导回来了 —— 靠别的用例留下的状态才成立的用例，等于没测。
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    // 先把整库拍一份快照：断言跑完要照原样还回去（理由见这一条最后）。
    const snapshot = await evaluate("(async () => JSON.stringify(await RoleWorld.exportArchive()))()");
    const cleared = await evaluate(`(async () => {
      await RoleWorld.init();
      await RoleWorld.resetAll();
      // ⚠ **清库之后**再把两个"会自动灌回来"的开关都关掉，顺序不能反。
      //
      // 诊断实测（这一条自己踩了两轮，各有一次「看起来通过了」）：
      //   · resetAll() 会把 kv 一起清掉，所以写在它**之前**的标记活不到下一次启动；
      //   · 下一次启动于是看到「内容包启用 + 一张卡都没有」→ 内置包整包重装（8 张卡）；
      //   · 同时 fixture 的已导入标记也没了 → fixture 的角色卡再灌一遍。
      //   两个都关掉之后，下一次启动看到的是「包停用 + fixture 已导入」，库才是真的空。
      // 这不是应用缺陷：删光角色卡而包还开着，下次启动补回包自带卡是它的默认行为。
      await RoleWorldPacks.setEnabled("harry-potter", false);
      await RoleWorld.store.setKV("fixture-imported", true);
      const left = await RoleWorld.store.listCharacters();
      return {
        left: left.map((one) => one.avatar),
        disabled: await RoleWorld.store.getKV("packs:disabled", null),
        fixtureFlag: await RoleWorld.store.getKV("fixture-imported", null),
      };
    })()`);
    assert(cleared.left.length === 0, "清库之后角色卡没清干净（这一条测的是空库，不是「几乎空库」）：" + JSON.stringify(cleared));
    assert(Array.isArray(cleared.disabled) && cleared.disabled.indexOf("harry-potter") >= 0,
      "停用内容包没落盘（顺序错了就会被清库抹掉）：" + JSON.stringify(cleared));
    assert(cleared.fixtureFlag === true,
      "fixture 的已导入标记没写回去（顺序错了就会被清库抹掉，下一次启动又会灌满）：" + JSON.stringify(cleared));
    // 清完之后**立刻**整页加载：下面必须在一个"从来没碰过角色"的页面实例上断言。
    //
    // ⚠ 这一句是这一条用例的关键，不能省（2026-09-15 实测踩了两轮）：
    //   清库是在**当前这个已经加载好的页面**里做的，而那个页面里的应用**内存里仍然有角色**
    //   （`liveState.characters`、会话表、顶栏都是启动时读进去的）。清完不重新加载就直接断言，
    //   看到的还是"清库之前的界面"，于是一直红成「没有角色卡时输入框仍可用」。
    //   而应用自己也**不会**清库之后自动重画空库界面 —— 清库是"用户删光角色"或测试工具的入口，
    //   不是应用的内建动作，所以这里必须显式重载（原来那一版写的就是重载，我一度改掉了）。
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    reportErrors("空库 index.html");
    const state = await evaluate(`(() => ({
      gate: document.querySelector('#chatTemplateGate').hidden,
      auth: document.querySelector('#authGate').hidden,
      disabled: document.querySelector('#messageInput').disabled,
      text: document.body.textContent.indexOf('还没有角色卡') >= 0,
      characters: null,
    }))()`);
    assert(state.gate, "模板门显示了错误，说明空库启动失败");
    assert(state.auth, "登录门显示了错误");
    assert(state.disabled, "没有角色卡时输入框仍可用");
    assert(state.text, "没有看到空状态提示");
    // 收尾：把库恢复成跑这条之前的样子。
    //
    // 为什么这条必须自己收尾（2026-09-15 实测）：这一条把库清空并且**在空库状态下重载**，
    // 于是这个页面实例的角色注册表就是空的。影响不是"少几张卡"这么轻 ——
    // 会话表是按**角色注册表**列出来的，Harry 的对话文件还在存档里，
    // 后面「角色语音」要 `openChatFor("harry-最近聊过")` 就会红成
    // `会话表里有没有: false，这个角色的存档里: ["harry-最近聊过"]`（诊断实测）。
    // 恢复走应用自己的存档接口（导出/导入），不直接写库，避免绕过应用的缓存。
    await evaluate(`(async () => {
      await RoleWorldPacks.setEnabled("harry-potter", true);
      await RoleWorld.importArchive(JSON.parse(${JSON.stringify(snapshot)}), { mode: "replace" });
      return true;
    })()`);
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    const back = await evaluate("(async () => (await RoleWorld.store.listCharacters()).map((one) => one.avatar))()");
    assert(back.length >= 2, "空库用例收尾没能把角色卡还回来（后面的用例会找不到对话）：" + JSON.stringify(back));
  });

  await check("没有有效角色时切“关系”：就绪标记要跟着实际显示的那一页", async () => {
    // 复核项 C：`loadCompanionPane` 在没有有效角色时会**改切回设定页**，
    // 但打开面板那条路仍然标记 `relationship` → 活动页与 `data-ready` 不一致
    //（界面上那句“正在读取…”与自动化都看这个标记，标记不可信就等于没有信号）。
    // 现场要“真的一张角色卡都没有”，清库与还原照上面那条用例已验证的写法。
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    const snapshot = await evaluate("(async () => JSON.stringify(await RoleWorld.exportArchive()))()");
    const left = await evaluate(`(async () => {
      await RoleWorld.init();
      await RoleWorld.resetAll();
      await RoleWorldPacks.setEnabled("harry-potter", false);
      await RoleWorld.store.setKV("fixture-imported", true);
      return (await RoleWorld.store.listCharacters()).length;
    })()`);
    assert(left === 0, "清库没清干净（这一条要的是真没有角色）：" + left);
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    try {
      const opened = await evaluate("window.TASK21.openCharacterPanel('relationship').then(() => true)");
      assert(opened === true, "打开“关系”页失败");
      await waitFor("!!document.querySelector('#characterPanel').dataset.ready", 10000);
      await sleep(200);
      const state = await evaluate(`(() => {
        const panel = document.querySelector('#characterPanel');
        const visible = Array.from(document.querySelectorAll('[data-character-pane]'))
          .filter((pane) => !pane.hidden).map((pane) => pane.dataset.characterPane);
        return {
          ready: panel.dataset.ready,
          visible,
          toast: (document.querySelector('#toast') || {}).textContent || '',
        };
      })()`);
      assert(state.visible.length === 1, "应当只有一页可见：" + JSON.stringify(state));
      assert(state.visible[0] === "setup", "没有角色时应当落回设定页：" + JSON.stringify(state));
      assert(state.ready === "setup",
        "就绪标记必须跟着实际显示的那一页（没有角色时是 setup）：" + JSON.stringify(state));
      assert(state.toast.indexOf("先选一个角色") >= 0, "应当说清为什么去不了关系页：" + state.toast);
    } finally {
      await evaluate(`(async () => {
        await RoleWorldPacks.setEnabled("harry-potter", true);
        await RoleWorld.importArchive(JSON.parse(${JSON.stringify(snapshot)}), { mode: "replace" });
        return true;
      })()`);
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
      const back = await evaluate("(async () => (await RoleWorld.store.listCharacters()).length)()");
      assert(back >= 2, "这条用例收尾没能把角色卡还回来：" + back);
    }
  });
  await check("用户的语音输入先不做：麦克风与设置里那一行都不露出来（不摆点了没反应的控件）", async () => {
    // 用户 2026-09-14：「我认为可以先不做用户的语音输入，而且现在的也不能用」。
    // 为什么钉它：露出来的入口就会有人点，点了没反应比没有更糟（这个项目反复踩过）。
    // 只钉"入口不露"，不钉"代码删了" —— voice-core 里的 listen/transcribeBlob 留着：
    //   以后要走"录音经中转发出去转写"那条路时直接接上。
    // 页面前置：这两个元素与能力探测只存在于对话页（单跑时页面可能停在 magic-map，
    // 那里既没有它们、也没有 window.RoleWorldVoice → 报出来会是 undefined 而不是"功能坏了"）。
    await ensureChatPage();
    const ui = await evaluate(`(() => {
      const mic = document.querySelector('#micButton');
      const row = document.querySelector('#speechInputRow');
      const lib = window.RoleWorldVoice || null;
      return {
        micExists: !!mic,
        micHidden: mic ? mic.hidden === true : null,
        micVisible: mic ? (mic.getBoundingClientRect().width > 0) : false,
        rowHidden: row ? row.hidden === true : null,
        // 能力探测本身还在（代码没被误删）
        canDetect: !!lib && typeof lib.hasSpeechRecognition === 'function',
        canRecord: !!lib && typeof lib.hasMediaRecorder === 'function',
        where: location.pathname,
        voiceLib: typeof window.RoleWorldVoice,
      };
    })()`);
    assert(ui.micHidden === true && ui.micVisible === false,
      "输入框旁边那颗麦克风露出来了（说了先不做）：" + JSON.stringify(ui));
    assert(ui.rowHidden !== false, "「设置 → 语音 → 语音输入」那一行露出来了：" + JSON.stringify(ui));
    assert(ui.canDetect && ui.canRecord,
      "语音输入的能力探测被误删了（代码要留着）：" + JSON.stringify(ui));
  });
  // 与上一条之间留一个空行只是为了可读性；两条用例各自独立（都自带页面前置）。

  await check("角色语音：带语音标记的回复会真合成、点气泡真播放、重复播放不再请求、切角色要取消", async () => {
  // 自带前置：顺序与「语音前不闪文字」一致（它已实测可用）。
  await goto(base + "/index.html");
  await waitFor("window.TASK21_READY === true", 30000);
  const avatar = await ensureCustomCharacter();
  assert(await enableCompanionPlain(avatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
  await openAppWithVoice({ enable: true });
  // ⚠ **必须在这里再确认一次"体验卡还在生效"**，不能只看"盘上 voice_enabled 是不是 true"。
  //
  // 为什么（2026-09-15 用页面侧仪器查出来的，别再凭猜）：
  //   · 上一条「用户的语音输入先不做」的收尾会调 `closeAppWithVoice()` —— 它把接口改回**直连**
  //     （provider=deepseek、card_relay=""），顺便 `refresh({force:true})`；
  //   · 而语音**只走体验卡**：卡一中止，`capability().canSpeak` 立刻变成 false
  //     （理由「云端语音要用体验卡（卡号就是凭据）」），合成请求自然不会发出去；
  //   · `openAppWithVoice` 里那段"补开关"的分支只在 `settings.voice_enabled !== true` 时才进 ——
  //     而 voice_enabled 上一条已经写成 true 了，于是分支被跳过、**卡没被重新接上**，
  //     整条用例空转到超时。实测：`--only` 单跑（前一条被跳过、收尾没跑）时它是**通的**，
  //     只有在前一条真的跑过（完整套件）时才红 —— 这就是"单跑能过、全跑就红"的原因。
  //   · 所以这里显式补一次"卡必须是活的"：卡没活就重开一遍（重开只能在这里做，
  //     因为下面排队的回复会被 reload 吃掉 —— 「语音前不闪文字」那条注释里写过同一个坑）。
  {
    const card = await evaluate(`(async () => {
      const state = await window.RoleWorldCard.currentState();
      return { active: state.active === true, relay: state.relay || "", token: !!state.token };
    })()`);
    if (!card.active || !card.relay) {
      await openAppWithVoice({ enable: true });
      const again = await evaluate(`(async () => {
        const state = await window.RoleWorldCard.currentState();
        return { active: state.active === true, relay: state.relay || "", token: !!state.token };
      })()`);
      assert(again.active && again.relay,
        "前置条件不成立：没能把体验卡重新接上（语音只走体验卡，卡不活就一条语音都发不出去）："
        + JSON.stringify({ before: card, after: again }));
    }
  }
  await openChatFor(avatar, CUSTOM_NAME, CUSTOM_CHAT);
  await installFakeAudio();
  // ⚠ 排队回复的 content 必须把 Node 侧那行**内插进页内模板**（照「语音前不闪文字」的写法）。
  //   上一版写成 '“${line}”\n[[语音]]' —— 页内模板里的 `${line}` 是页面作用域，
  //   页面根本没有这个变量，于是排进去的是字面量字符串，合成请求永远等不到（实测超时 25 秒）。
  const line = "这条会被真的合成成语音。";
  await evaluate(`(async () => {
    await fetch('/__reply-clear', { method: 'POST' });
    await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '“${line}”\\n[[语音]]' }) });
    return true;
  })()`);
  const ready = await evaluate(`(async () => {
    const now = await RoleWorld.getLocalSettings();
    if (now.voice_enabled !== true) {
      await RoleWorld.saveLocalSettings({ voice_enabled: true, voice_consent_at: now.voice_consent_at || new Date().toISOString() });
      await window.RoleWorldVoiceCloud.refresh({ force: true });
    }
    const after = await RoleWorld.getLocalSettings();
    const cap = window.RoleWorldVoiceCloud.capability();
    return { enabled: after.voice_enabled === true, canSpeak: cap.canSpeak, reason: cap.reason, relay: cap.relay };
  })()`);
  // 这一条断言的措辞要能一眼分清"卡没接上"和"开关没开"：
  //   两者都会让 canSpeak=false 而空转到超时，但原因完全不同（前者是前置，后者是应用缺陷）。
  assert(ready.enabled && ready.canSpeak,
    "前置条件不成立：这一轮必须是开着语音、而且体验卡活着的 —— " + JSON.stringify(ready));

  try {
    const before = voiceRequests.length;
    await sendOneTurn("念一句给我听");

    // ① 真合成：合成请求到了假服务端；放行后变成**可播放**气泡。
    // ⚠ 同一条用例里的两次跑：这次进场也把闸门与失败开关复位（上一次失败会把它们留下）。
    releaseVoice();
    failVoice(false);
    // ⚠ 这里必须用 waitForNode：`voiceRequests` 是 **Node 侧**的数组，
    //   塞进 waitFor 会在页面里变成 ReferenceError 并一路超时（见 waitForNode 的注释）。
    await waitForNode(() => voiceRequests.length > before, "合成请求到了假服务端（before=" + before + "）", 20000);
    await waitFor("document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state=\"ready\"]').length >= 1", 20000);
    const bubble = await evaluate(`(() => {
      const node = document.querySelector('#dynamicMessages .voice-bubble[data-voice-state="ready"]');
      return { hasPlay: !!node.querySelector('.voice-bubble-play') };
    })()`);
    assert(bubble.hasPlay, "可播放的语音气泡里没有播放控件：" + JSON.stringify(bubble));

    // ② 真播放：点播放控件 → 假音频记录到播放调用。
    const playedBefore = await evaluate("window.__rwAudioLog.length");
    await evaluate("document.querySelector('#dynamicMessages .voice-bubble[data-voice-state=\"ready\"] .voice-bubble-play').click(); true");
    await waitFor(`window.__rwAudioLog.length > ${playedBefore}`, 15000);
    assert(await evaluate("window.__rwAudioLog.length") > playedBefore, "点了语音气泡却没有真的播放");

    // ③ 重复播放不再请求（走缓存）：合成请求数不增加。
    await evaluate("try { window.RoleWorldVoiceCloud.stop(); } catch (_) {} true");
    await sleep(300);
    const requestsBeforeReplay = voiceRequests.length;
    const playedBeforeAgain = await evaluate("window.__rwAudioLog.length");
    await evaluate("document.querySelector('#dynamicMessages .voice-bubble[data-voice-state=\"ready\"] .voice-bubble-play').click(); true");
    await waitFor(`window.__rwAudioLog.length > ${playedBeforeAgain}`, 15000);
    assert(voiceRequests.length === requestsBeforeReplay,
      "同一条语音重复播放又发了一次合成请求（应当走缓存）：" + requestsBeforeReplay + " → " + voiceRequests.length);

    // ④ 切角色要取消：切走之后不该还在播。
    await evaluate("try { window.RoleWorldVoiceCloud.stop(); } catch (_) {} true");
    await sleep(200);
    await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
    await sleep(400);
    const speaking = await evaluate("!!(window.RoleWorldVoiceCloud.isSpeaking && window.RoleWorldVoiceCloud.isSpeaking())");
    assert(speaking === false, "切了角色还在念（旧角色的语音没被取消）");
  } finally {
    // 收尾必须在 finally：失败也要还原，否则应用留在体验卡（中转）模式，后面十几条连锁红。
    await evaluate("try { window.RoleWorldVoiceCloud.stop(); } catch (_) {} true");
    await closeAppWithVoice();
  }
});
  await check("语音合成失败：显示失败态与重试（次数有上限），用户可主动改为文字且正文一个字都不丢", async () => {
          // 自带前置：同上；另外把假服务的合成口设成**失败**。
          await ensureChatPage();
          const avatar = await ensureCustomCharacter();
          await enableCompanionPlain(avatar);
          await installFakeAudio();
          const ready = await openAppWithVoice();
          assert(ready.canSpeak, "前置不成立：这台设备现在不能朗读 —— " + ready.reason);
          // 进场先复位服务端的两个语音开关（幂等）：上一条用例失败时会把
          // `voiceFailMode` / `voiceHold` 留下，表现成"这一条的合成请求永远等不到"。
          releaseVoice();
          failVoice(false);
          setVoiceDelay(0);
          failVoice(true);

          const spokenLine = "这句话只该在语音里出现";
          await openChatFor(avatar, CUSTOM_NAME, CUSTOM_CHAT);
          await fetch(base + "/__reply", { method: "POST", body: JSON.stringify({ content: `[[语音]]${spokenLine}` }) });
          await sendOneTurn("念一句，这次会失败");

          // ① 失败态：气泡报失败，而且**不是**"准备中"（骗人的等待态）。
          await waitFor("document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state=\"failed\"]').length >= 1", 20000);
          const failed = await evaluate(`(() => {
            const bubble = document.querySelector('#dynamicMessages .voice-bubble[data-voice-state="failed"]');
            return {
              text: (bubble.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
              hasRetry: !!bubble.querySelector('[data-voice-action="retry"]'),
              hasToText: !!bubble.querySelector('[data-voice-action="to-text"]'),
              retryLabel: (bubble.querySelector('[data-voice-action="retry"]') || {}).textContent || '',
              waiting: document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state="queued"], #dynamicMessages .voice-bubble[data-voice-state="synthesizing"]').length,
            };
          })()`);
          assert(failed.hasRetry, "失败态里没有「重试」按钮：" + JSON.stringify(failed));
          assert(failed.hasToText, "失败态里没有「改为文字」入口：" + JSON.stringify(failed));
          assert(failed.waiting === 0, "已经失败了却还显示「准备中」：" + JSON.stringify(failed));

          // ② 重试有次数上限：点到用完为止，按钮必须变成不可用（而不是"点了没反应"）。
          let retries = 0;
          for (let i = 0; i < 8; i += 1) {
            const state = await evaluate(`(() => {
              const button = document.querySelector('#dynamicMessages .voice-bubble[data-voice-state="failed"] [data-voice-action="retry"]');
              if (!button) return { present: false };
              return { present: true, disabled: button.disabled === true, label: (button.textContent || '').trim() };
            })()`);
            if (!state.present || state.disabled) break;
            await evaluate("document.querySelector('#dynamicMessages .voice-bubble[data-voice-state=\"failed\"] [data-voice-action=\"retry\"]').click(); true");
            retries += 1;
            await sleep(700);
          }
          assert(retries >= 1, "一次重试都没点成（按钮一开始就不可用？）");
          const exhausted = await evaluate(`(() => {
            const button = document.querySelector('#dynamicMessages .voice-bubble[data-voice-state="failed"] [data-voice-action="retry"]');
            return button ? { present: true, disabled: button.disabled === true, label: (button.textContent || '').trim() } : { present: false };
          })()`);
          if (exhausted.present) {
            assert(exhausted.disabled, "重试次数用完之后按钮还是能点（会让人一直点下去）");
          }

          // ③ 用户主动「改为文字」：正文出现，而且**一个字都不丢**。
          //
          // ⚠ 判据必须**只看界面上看得见的东西**（2026-09-15 完整套件抓到的假红）：
          //   `.voice-bubble-text` 是**故意留在 DOM 里的隐藏副本**（读屏与用例用，`hidden` + 0×0），
          //   所以拿 `#dynamicMessages.textContent` 去 indexOf，永远能"找到"那句正文 ——
          //   它压根没显示。这条用例真正要守的是"**屏幕上**一个字都不露"。
          const beforeText = await evaluate(`(() => {
            const need = '这句话只该在语音里出现';
            const visible = (node) => {
              if (!node) return false;
              if (node.hidden === true) return false;
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            const hits = [];
            const walk = (node) => {
              if (!node) return;
              if (node.nodeType === 3) {
                if (String(node.nodeValue || '').indexOf(need) >= 0 && visible(node.parentElement)) {
                  hits.push(node.parentElement.className || node.parentElement.tagName);
                }
                return;
              }
              if (node.nodeType !== 1) return;
              Array.from(node.childNodes).forEach(walk);
            };
            walk(document.querySelector('#dynamicMessages'));
            return hits;
          })()`);
          assert(beforeText.length === 0,
            "还没点「改为文字」，屏幕上就已经有这句正文了（失败态不该显示正文）：" + JSON.stringify(beforeText));
          await evaluate("document.querySelector('#dynamicMessages .voice-bubble[data-voice-state=\"failed\"] [data-voice-action=\"to-text\"]').click(); true");
          await waitFor("document.querySelector('#dynamicMessages').textContent.indexOf('这句话只该在语音里出现') >= 0", 10000);
          const shown = await evaluate(`(() => {
            const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
            const row = rows[rows.length - 1];
            return {
              visible: row ? window.__rwReadAssistantText(row) : '',
              whole: (document.querySelector('#dynamicMessages') || {}).textContent.indexOf('这句话只该在语音里出现') >= 0,
            };
          })()`);
          assert(shown.whole, "点了「改为文字」之后正文没有出现");
          // ⚠ 等到"**屏幕上看得见**"再断言，不要点完立刻读一次。
          //   2026-09-15 实测：这一条会偶发红成 `{"visible":"","whole":true}` ——
          //   正文那时已经在 DOM 里（`whole` 为真），但读取发生在重画/滚动落定之前，
          //   `getBoundingClientRect()` 还是 0×0，于是被当成"读了隐藏内容"。
          //   等一下再断言，既不放松严格程度（仍然要求**可见**），也不靠运气。
          await waitFor("(() => { const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));"
            + " const row = rows[rows.length - 1];"
            + " return row && window.__rwReadAssistantText(row).indexOf('这句话只该在语音里出现') >= 0; })()",
            10000, "「改为文字」之后那句话在屏幕上出现（可见）");
          const shown2 = await evaluate(`(() => {
            const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
            const row = rows[rows.length - 1];
            return {
              visible: row ? window.__rwReadAssistantText(row) : '',
              whole: (document.querySelector('#dynamicMessages') || {}).textContent.indexOf('这句话只该在语音里出现') >= 0,
            };
          })()`);
          assert(shown2.whole, "点了「改为文字」之后正文没有出现");
          assert(shown2.visible.indexOf("这句话只该在语音里出现") >= 0,
            "正文出现了但不是**屏幕上可见**的那一条（读了隐藏内容）：" + JSON.stringify(shown2));

          // 收尾：关掉失败模式并还原体验卡设置。同样必须在 finally 里（理由同上一条）：
          //   失败模式下不还原，后面的合成请求会全部失败，而且应用会留在中转模式。
          try {
            failVoice(false);
            await evaluate("window.RoleWorldVoiceCloud.stop(); true");
            await closeAppWithVoice();
          } catch (_) { /* 收尾失败不掩盖真正的断言失败 */ }
        });

  await check("语音前不闪文字：合成请求被服务端挂住时，界面只显示等待状态，正文一个字都不可见", async () => {
      // 用户 2026-09-14 实测反馈：「先看到文字 → 文字消失 → 出现语音」。
      // 根因不是哪一步写错了，而是**同一条消息在两种交付类型之间来回换**：
      // 流式先按文字画、解析完知道是语音了再抹掉换成气泡。
      //
      // ⚠ 判定方式（用户 2026-09-15 指定）：**不要靠随机延时和碰运气采样**。
      //   用服务端闸门把"等待期间"变成一个确定的状态：
      //     ① 客户端发出合成请求 → 服务端挂住不返回（holdVoice）；
      //     ② 在"请求已到、响应未回"这个状态下断言：有等待态、且正文不可见；
      //     ③ 放行（releaseVoice）→ 断言变成可播放气泡。
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      const avatar = await ensureCustomCharacter();
      assert(await enableCompanionPlain(avatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
      await openAppWithVoice({ enable: true });
      await openChatFor(avatar, CUSTOM_NAME, CUSTOM_CHAT);
      await installFakeAudio();
      reportErrors("语音前不闪文字（进入对话后）");
      // ⚠ 排队回复必须在**整页重载之后**（openAppWithVoice 里会 reload）：
      //   排在前面会被重载吃掉，这一轮就变成假端点的默认台词，也就永远等不到合成请求
      //   （诊断里 parts 只有 text、正是这个原因）。
      const line = "这句话只该在语音里出现。";
      await evaluate(`(async () => {
        await fetch('/__reply-clear', { method: 'POST' });
        await fetch('/__reply', { method: 'POST', body: JSON.stringify({ content: '“${line}”\\n[[语音]]' }) });
        return true;
      })()`);
      // ⚠ 先把服务端那两个"语音开关"复位，再排自己的场景。
      //
      // 为什么（2026-09-15 完整套件抓到的连锁红）：这两条用例都在中途调
      // `holdVoice()` / `failVoice(true)`，而复位写在**自己的 try/finally 里** ——
      // 用例**事先**就失败时（比如前置不成立、断言在收尾之前红），上一轮的
      // `voiceFailMode` / `voiceHold` 会**一直留着**，表现成下一轮：
      //   · 合成请求一律 504（`上游合成超时了`）→「语音前不闪文字」永远等不到闸门挂住；
      //   · 或者闸门还挂着 → 请求被扣在服务端。
      // 上面「角色语音」那条的注释里已经写过这个教训（收尾必须在 finally），
      // 这里是它的一半：**进场也要复位**（幂等），否则顺序一变就互相污染。
      //
      // ⚠ 顺序要紧：复位必须在 `holdVoice()` **之前** —— 复位里带着 `releaseVoice()`，
      //   写在后面会把刚设好的闸门立刻放掉（这个坑当场踩了一次：
      //   请求进来了、服务端立刻回 200，用例却还在等 `heldVoiceCount() > 0`，空转 30 秒）。
      releaseVoice();
      failVoice(false);
      setVoiceDelay(0);
      // ⚠ 先把这段对话清空，让这一轮**只有自己的气泡**。
      //
      // 为什么（2026-09-15 完整套件抓到的假红）：这三条语音用例共用同一段对话
      // （`linmo-量身对话`），而且**都不删自己发过的消息** —— 前一条留下的语音气泡
      // （`ready` 那个，`.voice-bubble-text` 虽然 hidden、但 `readable` 判定会连它一起看）
      // 会和这一轮的气泡同时挂在 `#dynamicMessages` 里，于是"在等待期间屏幕上有没有正文"
      // 把上一条的旧气泡也算进来了。用例之间共用一段对话是可以的（下面还靠它比对版本），
      // 但**判"屏幕上此刻有什么"的用例必须先清场**。
      await evaluate(`(async () => {
        const file = window.TASK21.activeChatFileName();
        const lines = await window.STApi.getChat(${JSON.stringify(CUSTOM_AVATAR)}, file);
        const head = (Array.isArray(lines) ? lines : []).find((row) => row && row.chat_metadata) || { chat_metadata: {}, user_name: '我', character_name: ${JSON.stringify(CUSTOM_NAME)} };
        await window.STApi.saveChat(${JSON.stringify(CUSTOM_AVATAR)}, file, [head]);
        await window.TASK21.refreshSessions();
        await window.TASK21.selectChat(file);
        await new Promise((r) => setTimeout(r, 400));
        return true;
      })()`);
      // 「角色语音」那条用例结束时会故意把语音关掉，这里重新确认开关是开的。
      const voiceOn = await evaluate(`(async () => {
        const now = await RoleWorld.getLocalSettings();
        if (now.voice_enabled !== true) {
          await RoleWorld.saveLocalSettings({ voice_enabled: true, voice_consent_at: now.voice_consent_at || new Date().toISOString() });
          await window.RoleWorldVoiceCloud.refresh({ force: true });
        }
        const after = await RoleWorld.getLocalSettings();
        return { enabled: after.voice_enabled === true, canSpeak: window.RoleWorldVoiceCloud.capability().canSpeak };
      })()`);
      assert(voiceOn.enabled && voiceOn.canSpeak, "前置条件不成立：这一轮必须是开着语音的 —— " + JSON.stringify(voiceOn));

      // 闸门放在**复位之后**（顺序见上）。
      holdVoice();


      const before = voiceRequests.length;
      try {
        await evaluate(`(() => {
          const input = document.querySelector('#messageInput');
          input.value = '在吗';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#sendButton').click();
          return true;
        })()`);
        // ① 确定性同步点：等闸门**挂住**（合成在存盘之后才发，所以"点完发送就查闸门"必然取早了）。
        //    不在这里等"语音气泡出现"：闸门挂住时气泡可能还没画出来，等它会误报成"前置不成立"。
        let waited = 0;
        for (let i = 0; i < 300 && heldVoiceCount() === 0; i += 1) { await sleep(100); waited += 100; }
        if (heldVoiceCount() === 0) {
          // 失败时把"为什么没走到合成"一起报出来（只报"没到服务端"查不动）。
          const diag = await evaluate(`(async () => {
            const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
            const last = rows[rows.length - 1];
            const lines = await window.STApi.getChat(${JSON.stringify(CUSTOM_AVATAR)}, window.TASK21.activeChatFileName()).catch(() => null);
            const one = Array.isArray(lines) ? lines.filter((l) => l && typeof l.mes === 'string').pop() : null;
            const extra = one && one.extra ? one.extra : null;
            const cap = window.RoleWorldVoiceCloud.capability();
            const entry = window.TASK21.activeCharacterEntry ? window.TASK21.activeCharacterEntry() : null;
            return {
              cap: { canSpeak: cap.canSpeak, reason: cap.reason, speakers: (cap.speakers || []).length },
              parts: (extra && extra.roleworld_parts) || null,
              mes: (one && one.mes) || null,
              lastText: last ? window.__rwReadAssistantText(last) : '',
              bubbles: document.querySelectorAll('#dynamicMessages .voice-bubble').length,
              voiceEnabled: (await RoleWorld.getLocalSettings()).voice_enabled === true,
              entryAvatar: entry ? entry.avatar : null,
            };
          })()`).catch((e) => ({ evaluateError: String(e && e.message) }));
          assert(false, "合成请求没到服务端（等待 " + waited + "ms）。诊断：" + JSON.stringify(Object.assign({ queue: queueStats() }, diag)));
        }
        assert(voiceRequests.length > before, "服务端没有记到这次合成请求");

        // ② 请求已到、响应未回：这是"等待期间"的确定状态。
        const waiting = await evaluate(`(() => {
          const visible = (node) => {
            if (!node) return false;
            if (node.hidden === true) return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const textVisible = (node) => {
            if (!node) return false;
            if (node.hidden === true) return false;
            const style = getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && (node.textContent || '').trim().length > 0;
          };
          const bubbles = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble'));
          const bodies = Array.from(document.querySelectorAll('#dynamicMessages .assistant-bubble, #dynamicMessages .assistant-body, #dynamicMessages .message-bubble'));
          return {
            bubbleStates: bubbles.map((n) => n.dataset.voiceState || 'ready'),
            // 等待态**必须由语音气泡本身给出**（原位替换的那一态）。
            // 这里原来写成「气泡有等待态 或 流式行在打字」，于是"合成请求已到、气泡却没画出来"
            // 这种真缺陷能从 或 的另一条路混过去 —— 反例检查（第 ① 组）就是因此在变异后仍然 PASS。
            // 现在单独报一个数，断言只认它：等待期间**屏幕上必须看得见那条语音的等待态**。
            bubbleWaiting: bubbles.filter((n) => ['queued', 'synthesizing'].indexOf(n.dataset.voiceState || 'ready') >= 0).length,
            // ⚠ 2026-09-15 反例检查补强：**光有 data-voice-state 不算等待态**。
            //   变异①（把 buildVoiceBubble 里 queued/synthesizing 那一支整段去掉）之后，
            //   这一条曾经照样 PASS —— 因为 data-voice-state 是从 part.status 抄下来的，
            //   标记还在，可**用户什么都看不到**（没有「语音准备中…」、没有状态框）：
            //   合成立刻显示成可播放气泡，正是用户反馈过的"那一闪"的同类。
            // 所以等待态必须落在一个**画得出来**的节点上：.voice-bubble-state.is-pending（带 is-pending 的那个状态框），
            //   带「语音准备中…」，而且有真实尺寸（rect > 0）。
            bubbleWaitingVisible: bubbles.filter((n) => {
              if (['queued', 'synthesizing'].indexOf(n.dataset.voiceState || 'ready') < 0) return false;
              const box = n.querySelector('.voice-bubble-state.is-pending');
              if (!box || !visible(box)) return false;
              return (box.textContent || '').indexOf('语音准备中') >= 0;
            }).length,
            // 正文可见性：屏幕上任何一处出现那句台词都算失败
            textVisible: bodies.some((n) => textVisible(n) && (n.textContent || '').indexOf('这句话只该在语音里出现') >= 0)
              || bubbles.some((n) => textVisible(n.querySelector('.voice-bubble-text'))),
            bubbleCount: bubbles.length,
          };
        })()`);
        assert(waiting.bubbleWaiting > 0,
          "等待期间屏幕上没有「语音准备中」的气泡（原位替换的那一态必须看得见）：" + JSON.stringify(waiting));
        assert(waiting.bubbleWaitingVisible > 0,
          "等待态只有数据标记、没有画出来的东西（用户看不到「语音准备中…」）：" + JSON.stringify(waiting));
        assert(waiting.textVisible === false,
          "等待语音的期间屏幕上出现了正文（就是用户看到的那一闪）：" + JSON.stringify(waiting));

        // ③ 放行 → 应当变成可播放气泡。
        const released = releaseVoice();
        assert(released >= 1, "没有挂住的请求可放行：" + released);
        await waitFor("document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state=\"ready\"]').length >= 1", 15000);
        const final = await evaluate(`(() => {
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
        assert(final && final.state === 'ready' && final.playable,
          "放行之后没有变成可播放的语音气泡：" + JSON.stringify(final));
        assert(final.transcript === line, "气泡里的文本不是那句台词：" + JSON.stringify(final));
        assert(final.transcriptOnScreen === false, "语音气泡把正文显示在屏幕上了：" + JSON.stringify(final));
        const stored = await evaluate(`(async () => {
          const fileName = window.TASK21.activeChatFileName();
          const lines = await window.STApi.getChat(${JSON.stringify(CUSTOM_AVATAR)}, fileName).catch(() => null);
          const last = Array.isArray(lines) ? lines.filter((l) => l && typeof l.mes === 'string').pop() : null;
          return last ? { mes: last.mes, parts: (last.extra || {}).roleworld_parts || [] } : null;
        })()`);
        assert(stored && stored.parts.length === 1 && stored.parts[0].kind === 'voice' && stored.parts[0].status === 'ready',
          "存下来的分条不再是「语音 + ready」：" + JSON.stringify(stored));
        reportErrors("语音前不闪文字");
      } finally {
        releaseVoice();
        await evaluate("document.querySelector('[data-action=\"close-settings\"]')?.click(); true").catch(() => {});
        await closeAppWithVoice();
        await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过").catch(() => {});
      }
    });

  /* ==================================================================== *
   * 角色语音入口与开启面板（2026-09-16 产品设计 §7）
   *
   * 用户实测的问题：「手机版语音一直是灰的，根本不会开」。这三条盯的就是那件事：
   *   98) 入口一直可见可点、底部面板三栏都在、**没卡就能就地贴卡**；
   *   99) 没勾同意时主按钮点不动（不许"没同意就开了"），同意之后真开、默认自动、按钮变字；
   *  100) 内置小说人物照样有入口，但点一下只解释"小说人物不发语音、怎么办"。
   * ==================================================================== */

  const SHEET_AVATAR = "阿澈.png";
  const SHEET_NAME = "阿澈";
  const SHEET_CHAT = "ache-语音面板";

  /** 这个角色在不在；不在就用应用自己的导入接口建一张（不写 kv，走真入口）。 */
  async function ensureSheetCharacter() {
    await ensureChatPage();
    await waitFor("!!(window.TASK21 && window.TASK21.refreshSessions)", 15000);
    const created = await evaluate(`(async () => {
      const exists = (await RoleWorld.store.listCharacters()).some((c) => c.avatar === ${JSON.stringify(SHEET_AVATAR)});
      if (exists) return ${JSON.stringify(SHEET_AVATAR)};
      const card = {
        spec: "chara_card_v3", spec_version: "3.0",
        data: {
          name: ${JSON.stringify(SHEET_NAME)},
          description: "自己写的角色：安静、话少，习惯用聊天软件回话。",
          personality: "话少，句子短。",
          scenario: "手机上的一对一聊天。",
          first_mes: "在。",
          mes_example: "",
          tags: [],
        },
      };
      const file = new File([JSON.stringify(card)], ${JSON.stringify(SHEET_AVATAR.replace(/\.png$/, ".json"))}, { type: "application/json" });
      const result = await window.STApi.importCharacter(file, "json");
      return result && result.avatar;
    })()`);
    assert(created === SHEET_AVATAR, "导入语音面板用例的角色失败：" + created);
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await openChatFor(SHEET_AVATAR, SHEET_NAME, SHEET_CHAT);
  }

  /** 面板开了没有 + 三栏各在不在（节点是否存在，不看内容）。 */
  async function voiceSheetShape() {
    return evaluate(`(() => {
      const sheet = document.querySelector('#voiceSheet');
      if (!sheet) return { open: false };
      const box = (sel) => {
        const node = sheet.querySelector(sel);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      return {
        open: true,
        sections: Array.from(sheet.querySelectorAll('[data-voice-section]')).map((n) => n.dataset.voiceSection),
        tokenInput: box('[data-voice-card-token]'),
        relayInput: box('[data-voice-card-relay]'),
        cardUse: box('[data-voice-card-use]'),
        candidates: sheet.querySelectorAll('[data-voice-pick]').length,
        primary: box('[data-voice-sheet-primary]'),
        primaryDisabled: (sheet.querySelector('[data-voice-sheet-primary]') || {}).disabled === true,
        consentChecked: (sheet.querySelector('[data-voice-consent="check"]') || {}).checked === true,
        text: (sheet.textContent || '').replace(/\\s+/g, ' ').slice(0, 200),
      };
    })()`);
  }

  await check("角色语音入口一直在：手机上带文字、可点；点开是「语音服务 / 角色声音 / 首次说明」一次说完的底部面板", async () => {
    try {
      await ensureSheetCharacter();
      // 现场：窄屏 + 没有体验卡 + 语音关着 + **没同意过**（这就是新用户在手机上遇到的组合）。
      // ⚠ 同意记录也要清掉：整轮跑到这里时前面那条用例可能已经点过同意，
      //   带着它进来就没法验"没勾同意时主按钮点不动"（2026-09-16 整轮实测踩到）。
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ voice_enabled: false, voice_consent_at: "", card_relay: "", provider: "deepseek", endpoint: "${base}/v1/chat/completions", tutorial_seen: true });
        await RoleWorld.secrets.remove("api_key_custom");
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", card_relay: "" } }));
        await window.RoleWorldVoiceCloud.refresh({ force: true });
        return true;
      })()`);
      await evaluate(`(() => {
        document.documentElement.dataset.layout = 'mobile';
        window.dispatchEvent(new Event('resize'));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));

      const entry = await evaluate(`(() => {
        const btn = document.querySelector('#replyVoiceToggle');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        const label = (btn.querySelector('.rw-voice-label') || {}).textContent || '';
        return {
          hidden: btn.hidden, disabled: btn.disabled,
          w: Math.round(rect.width), h: Math.round(rect.height),
          label: label.trim(), title: btn.title || '',
          canSpeak: window.RoleWorldVoiceCloud.capability().canSpeak,
        };
      })()`);
      assert(entry, "窄屏下输入框旁边没有「角色语音」入口");
      assert(entry.hidden === false, "入口被藏起来了（用户实测就是「看不到」，藏起来等于没有）：" + JSON.stringify(entry));
      assert(entry.disabled === false, "入口是禁用的（用户看到的就是「灰的」，点了也没反应）：" + JSON.stringify(entry));
      assert(entry.w > 0 && entry.h > 0, "入口在屏幕上没有尺寸：" + JSON.stringify(entry));
      assert(entry.label.length > 0, "入口上**没有文字**（只有一个图标，用户不知道它能做什么）：" + JSON.stringify(entry));
      assert(entry.canSpeak === false, "前置不对：这条用例要在「还没有卡」的现场跑");

      // 点它：应当打开底部面板（不是跳设置、不是弹一个提示就完）。
      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceSheet')", 8000, "点了「角色语音」入口，底部面板没有出现");
      const shape = await voiceSheetShape();
      assert(shape.sections.indexOf("service") >= 0, "面板里没有「语音服务」那一栏：" + JSON.stringify(shape));
      assert(shape.sections.indexOf("voice") >= 0, "面板里没有「角色声音」那一栏：" + JSON.stringify(shape));
      assert(shape.tokenInput && shape.tokenInput.w > 0, "没有卡的时候，面板里必须能**就地**贴卡号（不该跳三层设置）：" + JSON.stringify(shape));
      assert(shape.relayInput && shape.relayInput.w > 0, "没有卡的时候，面板里要有中转地址那一栏：" + JSON.stringify(shape));
      assert(shape.cardUse && shape.cardUse.w > 0, "面板里没有「用这张卡」按钮：" + JSON.stringify(shape));
      assert(shape.primary && shape.primary.w > 0, "面板里没有主要操作按钮（同意并开启角色语音）：" + JSON.stringify(shape));
      assert(shape.primaryDisabled === true, "还没勾同意，主按钮就是能点的（文档 §7 要求先明确告知）：" + JSON.stringify(shape));
      assert(shape.text.indexOf("体验卡") >= 0, "面板里没说清「要用体验卡」这件事：" + JSON.stringify(shape));
      reportErrors("角色语音入口与开启面板");
    } finally {
      await evaluate("document.querySelector('#voiceSheet')?.remove(); true").catch(() => {});
      await evaluate("document.documentElement.dataset.layout = ''; true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("没同意就不给开；贴卡+同意之后真的开起来（默认自动），按钮文字跟着变", async () => {
    try {
      await ensureSheetCharacter();
      // 同意记录清掉：这条用例验的就是"第一次同意"那条路（整轮跑时前面可能已经同意过）。
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ voice_enabled: false, voice_consent_at: "" });
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { voice_enabled: false } }));
        return true;
      })()`);
      await evaluate(`(() => { try { localStorage.setItem('card_welcome_seen','1'); } catch (_) {} return true; })()`);
      await goto(base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay");
      // ⚠ 片段地址只做同文档导航，必须整页重载一次，RoleWorld.init() 里那段"自动应用卡"才会跑。
      await cdp.sessionSend(session, "Page.reload");
      await sleep(400);
      await waitFor("window.TASK21_READY === true", 30000);
      await dismissOnboarding();
      await waitFor("(function(){ var c = window.RoleWorldVoiceCloud.capability(); return c.checked === true; })()", 15000);
      await openChatFor(SHEET_AVATAR, SHEET_NAME, SHEET_CHAT);

      const before = await evaluate(`(async () => {
        const s = await RoleWorld.getLocalSettings();
        return { voice: s.voice_enabled === true, relay: s.card_relay || "", speakers: (window.RoleWorldVoiceCloud.capability().speakers || []).length };
      })()`);
      assert(before.voice === false, "前置不对：语音已经开着了");
      assert(before.relay.length > 0, "前置不对：体验卡没配上");

      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceSheet')", 8000, "面板没打开");
      // 2026-09-18 用户口径：「挑好的语音也不要做，就让用户选择，不要加一堆文字说明」——
      //   面板里**不再有"推荐候选"那一块**，选择走「全部音色」那个选择器。
      await waitFor("!!document.querySelector('#voiceSheet [data-voice-all-select]')", 10000,
        "面板里没有音色选择器（卡已经在用了，应该能问到音色表）");
      const picks = await evaluate(`(() => ({
        candidates: document.querySelectorAll('#voiceSheet [data-voice-pick]').length,
        options: Array.from(document.querySelectorAll('#voiceSheet [data-voice-all-select] option')).map((o) => o.value),
      }))()`);
      assert(picks.candidates === 0,
        "面板里还在替用户挑音色（候选块应当已经去掉）：" + JSON.stringify(picks));
      assert(picks.options.length > 0, "音色选择器里一个选项都没有：" + JSON.stringify(picks));
      assert(picks.options.every((id) => String(id).indexOf("zh_") === 0),
        "选择器里混进了不是这个角色语言的音色（中文角色只该看到中文音色）：" + JSON.stringify(picks));

      // ① 没勾同意：点主按钮不许有任何"开好了"的结果。
      await evaluate(`(() => {
        const primary = document.querySelector('#voiceSheet [data-voice-sheet-primary]');
        primary.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const blocked = await evaluate(`(async () => {
        const s = await RoleWorld.getLocalSettings();
        return {
          voice: s.voice_enabled === true,
          consent: !!s.voice_consent_at,
          sheetOpen: !!document.querySelector('#voiceSheet'),
        };
      })()`);
      assert(blocked.voice === false, "没勾同意就把语音开起来了：" + JSON.stringify(blocked));
      assert(blocked.consent === false, "没同意就写了同意记录：" + JSON.stringify(blocked));
      assert(blocked.sheetOpen === true, "没开成却把面板关了（用户没有重试的机会）：" + JSON.stringify(blocked));

      // ② 勾同意 + 点主按钮 → 该弹一次明确告知，同意后真的开起来。
      await evaluate(`(() => {
        const box = document.querySelector('#voiceSheet [data-voice-consent="check"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      await evaluate("document.querySelector('#voiceSheet [data-voice-sheet-primary]').click(); true");
      await waitFor("!!document.querySelector('.rw-consent')", 8000, "点开启之后没有出现那次「首次云端告知」");
      await evaluate("document.querySelector('.rw-consent [data-voice-consent=\"accept\"]').click(); true");
      await waitFor("!!(function(){ return null; })() || document.querySelector('#voiceSheet') === null", 10000,
        "开启之后面板没有关掉（文档 §7：开启成功回到聊天）");
      const after = await evaluate(`(async () => {
        const s = await RoleWorld.getLocalSettings();
        const cap = window.RoleWorldVoiceCloud.capability();
        const btn = document.querySelector('#replyVoiceToggle');
        return {
          voice: s.voice_enabled === true,
          consent: !!s.voice_consent_at,
          relay: s.card_relay || "",
          canSpeak: cap.canSpeak,
          reason: cap.reason || "",
          label: ((btn.querySelector('.rw-voice-label') || {}).textContent || "").trim(),
          off: btn.classList.contains('is-off'),
        };
      })()`);
      assert(after.voice === true, "同意之后语音没有真的开起来：" + JSON.stringify(after));
      assert(after.consent === true, "同意记录没落盘：" + JSON.stringify(after));
      assert(after.relay.length > 0, "开语音把体验卡的中转地址写丢了（saveAll 把它整份覆盖回去了）：" + JSON.stringify(after));
      assert(after.canSpeak === true, "开完了还是不能合成：" + JSON.stringify(after));
      assert(after.label.indexOf("角色回复") === 0,
        "开完之后入口文字没变成「角色回复：自动」：" + JSON.stringify(after));
      assert(after.off === false, "开完之后入口还是「没开」的样式：" + JSON.stringify(after));
      reportErrors("没同意就不给开");
    } finally {
      await evaluate("document.querySelector('#voiceSheet')?.remove(); document.querySelector('.rw-consent')?.remove(); true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("开启语音卡住时也必须给一句说得清的话（不能永远停在「正在开启」）", async () => {
    // 用户 2026-09-18 实测：「点同意并开启角色语音的时候会一直显示正在开启，然后卡住，
    //   退出了之后发现是开启成功了」。
    // 机制：`setVoiceEnabled`（settings-ui.js）**第一步就把 voice_enabled 落盘**，而面板只在
    //   整条 Promise 结束后才收；它后面还有 `saveAll()` / `Cloud.credentials()` 等 await ——
    //   其中任何一步挂住，用户看到的就是"永远正在开启"，而设置其实已经写下去了。
    // 这里**注入**"写完 voice_enabled 之后读取永远不返回"来复现，断言两件事：
    //   ① 面板不许永远停在「正在开启」；② 到点必须说清（并且要如实说明"其实已经开了"）。
    try {
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ voice_enabled: false, voice_consent_at: "", tutorial_seen: true });
        return true;
      })()`).catch(() => {});
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({
          provider: "custom", endpoint: "${base}/relay/v1/chat/completions",
          card_relay: "${base}/relay", voice_enabled: false, voice_consent_at: "", tutorial_seen: true,
        });
        await RoleWorld.secrets.set("api_key_custom", "RW-AAAAA-BBBBB-CCCCC");
        return true;
      })()`);
      await evaluate("window.dispatchEvent(new CustomEvent('roleworld:settings-changed', { detail: {} })); true");
      // ⚠ 不依赖 SHEET_* 那套 fixture（那些角色卡是别的用例建的，单跑时不存在）：
      //   自己建一个定制角色并开好「伴侣 + 软件聊天」，这样点入口走的才是"开启面板"。
      const stuckAvatar = await ensureCustomCharacter();
      assert(await enableCompanionPlain(stuckAvatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
      await openChatFor(stuckAvatar, CUSTOM_NAME, CUSTOM_CHAT);
      await sleep(500);
      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceSheet')", 8000, "面板没打开");
      await evaluate(`(() => {
        window.__voiceStuck = { wrote: false };
        const origSave = RoleWorld.saveLocalSettings.bind(RoleWorld);
        const origGet = RoleWorld.getLocalSettings.bind(RoleWorld);
        RoleWorld.saveLocalSettings = async (patch) => {
          const out = await origSave(patch);
          if (patch && patch.voice_enabled === true) window.__voiceStuck.wrote = true;
          return out;
        };
        RoleWorld.getLocalSettings = () => {
          if (window.__voiceStuck.wrote) return new Promise(() => {});
          return origGet();
        };
        return true;
      })()`);
      await evaluate(`(() => {
        const box = document.querySelector('#voiceSheet [data-voice-consent="check"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(200);
      await evaluate("document.querySelector('#voiceSheet [data-voice-sheet-primary]').click(); true");
      await waitFor("!!document.querySelector('.rw-consent')", 8000);
      await evaluate("document.querySelector('.rw-consent [data-voice-consent=\"accept\"]').click(); true");
      await sleep(1500);
      const during = await evaluate(`(() => ({
        status: String((document.querySelector('#voiceSheet [data-voice-sheet-status]') || {}).textContent || ''),
        wrote: !!(window.__voiceStuck && window.__voiceStuck.wrote),
      }))()`);
      console.log('        VOICE_STUCK_DURING ' + JSON.stringify(during));
      assert(during.wrote === true,
        "前置不成立：没有复现出「voice_enabled 已写下去、流程却卡住」这个现场：" + JSON.stringify(during));
      // 兜底上限到了之后必须换一句说得清的话（修前这里会永远停在「正在开启…」）。
      await waitFor("String((document.querySelector('#voiceSheet [data-voice-sheet-status]') || {}).textContent || '').indexOf('正在开启') < 0",
        20000, "卡住之后一直没给最终提示（用户看到的就是『永远正在开启』）");
      const after = await evaluate(`(() => ({
        status: String((document.querySelector('#voiceSheet [data-voice-sheet-status]') || {}).textContent || ''),
      }))()`);
      console.log('        VOICE_STUCK_AFTER ' + JSON.stringify(after));
      // 到点必须给一句**能自查、且不撒谎**的话：卡住时同步快照可能也没更新，
      //   所以既不许说"没开成"也不许硬说"开好了"——要告诉用户怎么一眼确认。
      assert(after.status.indexOf("关掉") >= 0 && after.status.indexOf("入口") >= 0,
        "卡住之后的提示不可操作（要告诉用户怎么确认到底开没开）：" + JSON.stringify(after));
      reportErrors("开启语音卡住");
    } finally {
      await evaluate(`(() => {
        delete window.__voiceStuck;
        document.querySelector('#voiceSheet')?.remove();
        document.querySelector('.rw-consent')?.remove();
        return true;
      })()`).catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("角色回复方式要持久：选了「一直文字」刷新之后还是它（不是一次性、不被重置）", async () => {
    // 用户 2026-09-18：「选择下一条是语音还是文字还是自动应该要持续，不要每次重置」。
    // 真因：以前是两个**一次性内存开关**（用完即清、开启语音时还会被重置），而且
    //   「下条文字」那个 `liveState.replyAsTextNext` **只被赋值、从来没有被读过** ——
    //   点它完全没用（只弹一句 toast）。现在换成一个**存进设置**的 `voice_reply_mode`：
    //   auto / voice（一直语音）/ text（一直文字），界面文案与所有判定都读它。
    try {
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await openAppWithVoice({ enable: true });
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      // ⚠ 当前角色必须是**能发语音的定制角色**（伴侣 + 软件聊天）。内置小说人物那一路
      //   点入口打开的是"小说人物不发语音"的说明面板，不是三选一菜单。
      const avatar = await ensureCustomCharacter();
      assert(await enableCompanionPlain(avatar), "前置条件不成立：没能给定制角色打开伴侣 + 软件聊天");
      await openChatFor(avatar, CUSTOM_NAME, CUSTOM_CHAT);
      // 前置：语音真的**就绪**（开关开着 + 能合成）。没就绪时点入口打开的是"开启面板"，
      //   不是那个三选一菜单 —— 那样报出来的失败是前置没搭好，不是功能坏了。
      await sleep(700);
      const ready = await evaluate(`(async () => ({
        voiceEnabled: (await RoleWorld.getLocalSettings()).voice_enabled === true,
        canSpeak: !!(window.RoleWorldVoiceCloud && window.RoleWorldVoiceCloud.capability().canSpeak),
        label: ((document.querySelector('#replyVoiceToggle .rw-voice-label') || {}).textContent || '').trim(),
      }))()`);
      assert(ready.voiceEnabled === true && ready.canSpeak === true,
        "前置不成立：语音没就绪（点入口会打开开启面板而不是三选一菜单）：" + JSON.stringify(ready));
      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceReplyMenu')", 8000);
      const items = await evaluate(`(() => Array.from(document.querySelectorAll('#voiceReplyMenu .rw-voice-menu-item strong')).map((n) => String(n.textContent || '')))()`);
      assert(items.indexOf("一直语音") >= 0 && items.indexOf("一直文字") >= 0,
        "菜单里应当是持久的「一直语音 / 一直文字」两档（不能还写着一次性的「下条…」）：" + JSON.stringify(items));
      await evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('#voiceReplyMenu .rw-voice-menu-item'));
        const target = rows.find((n) => String(n.textContent || '').indexOf('一直文字') >= 0);
        target.click();
        return true;
      })()`);
      await sleep(400);
      const stored = await evaluate("(async () => String((await RoleWorld.getLocalSettings()).voice_reply_mode || ''))()");
      assert(stored === "text", "选了「一直文字」之后没有落盘：" + JSON.stringify(stored));
      // 关键：**刷新之后还是它**（用户要的就是这个"持续"）。
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      await waitFor("((document.querySelector('#replyVoiceToggle .rw-voice-label') || {}).textContent || '').indexOf('一直文字') >= 0",
        15000, "刷新之后角色回复方式被重置了（用户明确要它持续）");
      const after = await evaluate(`(async () => ({
        stored: String((await RoleWorld.getLocalSettings()).voice_reply_mode || ''),
        label: ((document.querySelector('#replyVoiceToggle .rw-voice-label') || {}).textContent || '').trim(),
      }))()`);
      console.log('        VOICE_MODE_PERSIST ' + JSON.stringify(after));
      assert(after.stored === "text" && after.label.indexOf("一直文字") >= 0,
        "刷新后选择没有保持：" + JSON.stringify(after));
      // 换回「一直语音」也要落盘（三档都走同一条路）。
      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceReplyMenu')", 8000);
      await evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('#voiceReplyMenu .rw-voice-menu-item'));
        rows.find((n) => String(n.textContent || '').indexOf('一直语音') >= 0).click();
        return true;
      })()`);
      await sleep(400);
      const voiceStored = await evaluate("(async () => String((await RoleWorld.getLocalSettings()).voice_reply_mode || ''))()");
      assert(voiceStored === "voice", "「一直语音」没有落盘：" + JSON.stringify(voiceStored));
      reportErrors("角色回复方式持久");
    } finally {
      await evaluate("(async () => { await RoleWorld.saveLocalSettings({ voice_reply_mode: 'auto' }); return true; })()").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("内置小说人物：入口照样在，但点一下只解释「小说人物不发语音」，并指出该怎么做", async () => {
    try {
      await closeAppWithVoice();
      await openChatFor("Harry Potter (EN).png", "Harry Potter", "harry-最近聊过");
      const entry = await evaluate(`(() => {
        const btn = document.querySelector('#replyVoiceToggle');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { hidden: btn.hidden, disabled: btn.disabled, w: Math.round(rect.width), h: Math.round(rect.height),
          label: ((btn.querySelector('.rw-voice-label') || {}).textContent || "").trim(), title: btn.title || "" };
      })()`);
      assert(entry && entry.hidden === false, "内置角色那里入口被藏起来了（文档 §7：剧情也保留可发现的声音入口）：" + JSON.stringify(entry));
      assert(entry.disabled === false, "内置角色那里入口是禁用的（「灰的」就是用户最初的抱怨）：" + JSON.stringify(entry));
      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceSheet')", 8000, "内置角色点入口没有说明（不该什么都不发生）");
      const shape = await voiceSheetShape();
      assert(shape.text.indexOf("小说人物") >= 0 || shape.text.indexOf("内置") >= 0,
        "面板里没有说清「内置小说人物不发语音」：" + JSON.stringify(shape));
      assert(shape.tokenInput === null && shape.cardUse === null,
        "内置角色那里弹出了「贴体验卡」的表单 —— 不可用的操作不该执行（文档 §7）：" + JSON.stringify(shape));
      reportErrors("内置小说人物入口");
    } finally {
      await evaluate("document.querySelector('#voiceSheet')?.remove(); true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("命名改清楚了：面板里是「日常聊天 / 剧情对话」，顶栏写着你现在的「当前方式」", async () => {
    try {
      await ensureSheetCharacter();

      /** 打开角色面板 → 关系那一页 → 选一种方式 → 保存（每一步都走界面入口，跟用户一样）。 */
      const setStyleViaPanel = async (value) => {
        await evaluate("document.querySelector('[data-action=\"open-character-panel\"]')?.click(); true");
        await waitFor("!!document.querySelector('#characterPanel') && document.querySelector('#characterPanel').hidden === false", 8000,
          "角色面板没打开");
        await evaluate(`(() => {
          const tab = document.querySelector('[data-action="character-tab-relationship"]')
            || document.querySelector('[data-character-tab="relationship"]');
          if (tab) tab.click();
          return true;
        })()`);
        await waitFor("!!document.querySelector('#companionChatStyle') && !!document.querySelector('#companionSaveButton')", 8000,
          "关系那一页里没有方式下拉或保存按钮");
        await evaluate(`(() => {
          const box = document.querySelector('#companionEnabled');
          if (box && box.checked !== true && box.disabled !== true) {
            box.checked = true;
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const select = document.querySelector('#companionChatStyle');
          select.value = ${JSON.stringify(value)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 400));
        await evaluate("document.querySelector('#companionSaveButton').click(); true");
        await waitFor("!document.querySelector('#characterPanel') || document.querySelector('#characterPanel').hidden === true", 8000,
          "保存之后伴侣面板没有关掉");
        await new Promise((r) => setTimeout(r, 600));
      };

      // ① 名字（文档 §5：禁止再出现「软件聊天（无动作）」「普通（带动作）」）。
      await evaluate("document.querySelector('[data-action=\"open-character-panel\"]')?.click(); true");
      await waitFor("!!document.querySelector('#characterPanel') && document.querySelector('#characterPanel').hidden === false", 8000,
        "角色面板没打开");
      await evaluate(`(() => {
        const tab = document.querySelector('[data-action="character-tab-relationship"]')
          || document.querySelector('[data-character-tab="relationship"]');
        if (tab) tab.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      const naming = await evaluate(`(() => {
        const select = document.querySelector('#companionChatStyle');
        return {
          options: select ? Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent.trim() })) : null,
          note: (document.querySelector('#companionChatStyleNote') || {}).textContent || '',
          drawerText: (document.querySelector('#characterPanel') || {}).textContent || '',
        };
      })()`);
      assert(naming.options && naming.options.length >= 2, "面板里没有「它在对话里怎么写」这个下拉：" + JSON.stringify(naming));
      const optionText = naming.options.map((o) => o.text).join(" | ");
      assert(optionText.indexOf("日常聊天") >= 0, "下拉里没有新名字「日常聊天」：" + optionText);
      assert(optionText.indexOf("剧情对话") >= 0, "下拉里没有新名字「剧情对话」：" + optionText);
      assert(naming.drawerText.indexOf("软件聊天") < 0, "角色面板里还留着旧名字「软件聊天」：" + naming.drawerText.slice(0, 200));
      assert(naming.drawerText.indexOf("普通（回复里") < 0, "角色面板里还留着旧名字「普通（回复里…）」：" + naming.drawerText.slice(0, 200));
      await evaluate("document.querySelector('[data-action=\"close-character-panel\"]')?.click(); true");
      await new Promise((r) => setTimeout(r, 400));

      // ② 顶栏的「当前方式」要跟着这张档案走。
      const topbar = await evaluate(`(() => {
        const node = document.querySelector('#topbarMode');
        return node ? { hidden: node.hidden, text: (node.textContent || '').replace(/\\s+/g, '') } : null;
      })()`);
      assert(topbar, "顶栏没有「当前方式」那一处（文档 §6 要求顶部写出当前方式）");
      assert(topbar.hidden === false && topbar.text.length > 0,
        "顶栏的「当前方式」没显示出来：" + JSON.stringify(topbar));

      const readMode = () => evaluate("((document.querySelector('#topbarMode') || {}).textContent || '').replace(/\\s+/g, '')");

      await setStyleViaPanel("action");
      const actionMode = await readMode();
      assert(actionMode.indexOf("剧情对话") >= 0,
        "方式设成「剧情对话」之后顶栏还写着别的：" + actionMode);

      await setStyleViaPanel("plain");
      const plainMode = await readMode();
      assert(plainMode.indexOf("日常聊天") >= 0,
        "方式设成「日常聊天」之后顶栏还写着别的：" + plainMode);
      assert(plainMode.indexOf("剧情对话") < 0,
        "两种方式的顶栏文字没有区分开：" + plainMode);
      reportErrors("命名与当前方式");
    } finally {
      await evaluate("document.querySelector('[data-action=\"close-character-panel\"]')?.click(); true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("AI 写角色走的是**当前**那条连接：在用卡就走卡；没凭据时先说清缺什么，不打那一枪", async () => {
    // 用户 2026-09-16 实测报的 bug（原话）：
    //   「扩写失败：模型接口返回 HTTP 401：Authentication Fails (governor)」
    // 查出来的根因：这一路用的是**启动时那份 settings 快照**里的 custom_url。
    // 连接方式后来变过（粘了体验卡 / 换过服务商）时它是旧的；旧值为空就回落到
    // **服务商默认地址**（api.deepseek.com）而且不带任何凭据 —— 必 401，
    // 而报错里既没有"打到哪"也没有"缺什么"。
    // 这条用例把三件事钉住：① 有卡时走卡的中转；② 存档里的旧端点不该影响它；
    // ③ 完全没有凭据时**先拦下来**，给一句能照着做的话，一个请求都不发。
    try {
      const ready = await openAppWithVoice();
      assert(ready.canSpeak, "前置不成立：体验卡没配上 —— " + ready.reason);

      const runExpand = async (description) => {
        const before = requests.length;
        await evaluate(`(() => {
          const open = document.querySelector('[data-action="character-ai-create"]');
          if (open) open.click();
          return true;
        })()`);
        await waitFor("document.querySelector('#aiCreateDialog').hidden === false", 8000);
        await evaluate(`(() => {
          const input = document.querySelector('#aiDescriptionInput');
          input.value = ${JSON.stringify(description)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#aiBriefButton').click();
          return true;
        })()`);
        await waitFor(`(() => {
          const err = document.querySelector('#aiCreateError');
          const brief = document.querySelector('#aiCreateBriefPhase');
          return (brief && brief.hidden === false) || (err && err.hidden === false && (err.textContent || '').trim().length > 0);
        })()`, 20000, "点了扩写之后既没进下一步、也没报错");
        const shot = await evaluate(`(() => {
          const err = document.querySelector('#aiCreateError');
          return {
            briefShown: document.querySelector('#aiCreateBriefPhase').hidden === false,
            error: err ? (err.textContent || '').trim() : '',
            settingsButton: !!(err && err.querySelector('[data-ai-error-settings]')),
          };
        })()`);
        // 只看"扩写这一枪"：假服务器记的是 path（中转那一路 relay=true）。
        const sent = requests.slice(before).filter((row) => row.isBriefCall === true);
        const relayHits = requests.slice(before).filter((row) => row.relay === true).map((row) => row.path);
        await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']').click(); true").catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        return { shot, sent, relayHits };
      };

      // ① 卡是活的 → 走卡的中转，正常出稿。
      const withCard = await runExpand("一个冷淡的图书管理员，说话很短，不太愿意搭理人");
      assert(withCard.shot.briefShown, "有卡时扩写没成功，报错是：" + withCard.shot.error);
      assert(withCard.sent.length >= 1, "有卡时扩写没有发出请求");
      assert(withCard.sent.every((row) => row.relay === true),
        "有卡时扩写没有走卡的中转，打到了别处：" + JSON.stringify(withCard.sent.map((r) => r.path)));

      // ② 存档里留着一个**旧的官方端点**（用户换过连接方式）→ 仍然走卡，不许回落。
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ endpoint: "https://api.deepseek.com/chat/completions" });
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { endpoint: "https://api.deepseek.com/chat/completions" } }));
        return true;
      })()`);
      const staleEndpoint = await runExpand("一个爱睡懒觉的邮差，住在海边小镇，记性很差");
      assert(staleEndpoint.shot.briefShown,
        "存档里有旧端点时扩写失败了（应当照样走卡）：" + staleEndpoint.shot.error);
      assert(staleEndpoint.sent.every((row) => row.relay === true),
        "扩写被旧端点带跑了 —— 这就是那个 401 的成因：" + JSON.stringify(staleEndpoint.sent.map((r) => r.path)));

      // ③ 完全没有连接（卡撤掉、端点也空）→ 先拦下来，说清缺什么，并且**一个请求都不发**。
      //    这一种就是用户报的那个现场：地址会回落到 api.deepseek.com、凭据位却是空的。
      await closeAppWithVoice();
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "" });
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { provider: "deepseek", endpoint: "" } }));
        return true;
      })()`);
      const noCredential = await runExpand("一个在没有凭据时也要给出一句人话的角色描述，至少二十个字");
      assert(noCredential.sent.length === 0 && noCredential.relayHits.length === 0,
        "没有凭据时还是打了接口（用户看到的就是那句英文 401）："
        + JSON.stringify(noCredential.sent.map((r) => r.path).concat(noCredential.relayHits)));
      assert(noCredential.shot.error.indexOf("凭据") >= 0 || noCredential.shot.error.indexOf("设置") >= 0,
        "没有凭据时那句话没说清缺什么、怎么办：" + noCredential.shot.error);
      assert(noCredential.shot.settingsButton, "没有凭据时没给「去设置连接方式」的入口：" + JSON.stringify(noCredential.shot));

      // ④ 自己填了一个端点但没存 Key → **照样发**（有的端点不需要 Key：本机模型、内网网关）。
      //    不拦是有意的：光凭"查不到 Key"就把能用的配置拦掉，比让它去试一次更糟。
      //    ⚠ 这一子条**不联网**也能判定：只要真发出去了，回什么都行（假环境里回的是真接口那句 401）；
      //      唯一不许出现的是我们**自己**那句拦下来的话。
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: "deepseek", endpoint: "https://api.deepseek.com/v1/chat/completions" });
        window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { endpoint: "https://api.deepseek.com/v1/chat/completions" } }));
        return true;
      })()`);
      const ownEndpoint = await runExpand("自己填了端点但没有存 Key 的角色描述，至少二十个字才行");
      await new Promise((r) => setTimeout(r, 1200));
      const ownAttempted = await evaluate(`(() => !!(window.__rwLastAiError && window.__rwLastAiError.url))()`);
      assert(ownAttempted || ownEndpoint.shot.error.indexOf("凭据") < 0,
        "自己填了端点却被当成「没有凭据」拦下来了：" + JSON.stringify(ownEndpoint.shot));
      assert(ownEndpoint.shot.error.indexOf("还没有凭据") < 0,
        "自己填了端点却走了「没凭据」那条拦截：" + ownEndpoint.shot.error);
      reportErrors("AI 写角色的连接");
    } finally {
      await evaluate("document.querySelector('#aiCreateDialog [data-action=\\'close-ai-create\\']')?.click(); true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("日常聊天一致性：朋友关闭语音时，顶栏、实际请求与消息渲染仍使用日常方式", async () => {
    try {
      await ensureSheetCharacter();
      await closeAppWithVoice();
      await evaluate(`(async () => {
        await RoleWorld.saveLocalSettings({ provider: 'deepseek', endpoint: ${JSON.stringify(base + '/v1/chat/completions')}, model: 'deepseek-flash', card_relay: '', voice_enabled: false });
        await window.TASK21.saveCompanion({ avatar: ${JSON.stringify(SHEET_AVATAR)} }, { enabled: false, relation: 'friend', chatStyle: 'plain' });
        return true;
      })()`);
      await goto(base + '/index.html');
      await waitFor('window.TASK21_READY === true', 30000);
      await openChatFor(SHEET_AVATAR, SHEET_NAME, SHEET_CHAT);
      const mode = await evaluate("document.querySelector('#topbarMode').textContent");
      assert(mode === '日常聊天', '前置：顶栏应该显示日常聊天：' + mode);
      await fetch(base + '/__reply-clear', { method: 'POST' });
      await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '（微笑）“一致性测试回复。”' }) });
      const before = requests.length;
      const voicesBefore = voiceRequests.length;
      await sendOneTurn('日常方式回归测试');
      const sent = requests.slice(before).filter((row) => row.stream === true).slice(-1)[0];
      assert(sent && /聊天方式：微信式聊天|Chat style: a real one-on-one/.test(sent.systemText),
        '顶栏显示日常聊天，但实际请求缺少日常聊天规则');
      assert(!/Voice notes: if you would rather|短句（大约 60 字以内）优先发语音/.test(sent.systemText),
        '关闭语音时不应注入鼓励发语音的媒介指令');
      const rendered = await evaluate(`(() => {
        const rows = document.querySelectorAll('#dynamicMessages .message-row-assistant');
        return window.__rwReadAssistantText(rows[rows.length - 1]);
      })()`);
      assert(rendered.includes('一致性测试回复') && !rendered.includes('微笑'),
        '日常聊天没有按纯对白渲染：' + rendered);
      assert(voiceRequests.length === voicesBefore, '关闭语音时不应该发起合成');
      reportErrors('日常聊天一致性');
    } finally {
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("日常切换边界：朋友不刷新切到剧情，只影响新回复而不重写历史显示", async () => {
    try {
      await ensureSheetCharacter();
      await closeAppWithVoice();
      await evaluate(`(async () => {
        await window.TASK21.saveCompanion({ avatar: ${JSON.stringify(SHEET_AVATAR)} }, { enabled: false, chatStyle: 'plain' });
        return true;
      })()`);
      await goto(base + '/index.html');
      await waitFor('window.TASK21_READY === true', 30000);
      await openChatFor(SHEET_AVATAR, SHEET_NAME, SHEET_CHAT);
      await fetch(base + '/__reply-clear', { method: 'POST' });
      await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '（旧轮旁白）“旧轮对白标识。”' }) });
      await sendOneTurn('切换前第一轮');
      const firstVisible = await evaluate(`(() => {
        const rows = document.querySelectorAll('#dynamicMessages .message-row-assistant');
        return window.__rwReadAssistantText(rows[rows.length - 1]);
      })()`);
      assert(firstVisible.includes('旧轮对白标识') && !firstVisible.includes('旧轮旁白'), '前置：第一轮应按日常显示');
      await evaluate("document.querySelector('[data-action=\"open-character-panel\"]').click(); true");
      await waitFor("document.querySelector('#characterPanel').hidden === false", 8000);
      await evaluate(`(() => {
        const tab = document.querySelector('[data-action="character-tab-relationship"]') || document.querySelector('[data-character-tab="relationship"]');
        tab.click(); return true;
      })()`);
      await waitFor("document.querySelector('#characterPanel').dataset.ready === 'relationship'", 10000);
      await evaluate(`(() => {
        const box = document.querySelector('#companionEnabled');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        const select = document.querySelector('#companionChatStyle');
        select.value = 'action';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#companionSaveButton').click();
        return true;
      })()`);
      await waitFor("document.querySelector('#characterPanel').hidden === true && document.querySelector('#topbarMode').textContent === '剧情对话'", 10000);
      await fetch(base + '/__reply', { method: 'POST', body: JSON.stringify({ content: '（新轮旁白）“新轮对白标识。”' }) });
      const before = requests.length;
      await sendOneTurn('切换后第二轮');
      const sent = requests.slice(before).filter((row) => row.stream === true).slice(-1)[0];
      assert(sent && !/聊天方式：微信式聊天|Chat style: a real one-on-one/.test(sent.systemText), '不刷新切换后仍注入日常规则');
      // 公共读取助手只读第一个对白气泡，会漏掉相邻旁白；此处直接检查正文与可见旁白节点。
      const visible = await evaluate(`Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).map((row) => {
        const body = row.querySelector('.assistant-body');
        return { text: body ? body.innerText.trim() : '', narrationVisible: Array.from(row.querySelectorAll('.narration-line')).some((node) => {
          const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
          return !node.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }) };
      })`);
      const oldRow = visible.find((row) => row.text.includes('旧轮对白标识'));
      const newRow = visible.find((row) => row.text.includes('新轮对白标识'));
      assert(newRow && newRow.narrationVisible && newRow.text.includes('新轮旁白'), '新剧情回复应保留可见旁白');
      assert(oldRow && oldRow.text === firstVisible && !oldRow.narrationVisible,
        '切换方式改变了旧回复显示：' + JSON.stringify(oldRow));
    } finally {
      await evaluate("document.querySelector('[data-action=\"close-character-panel\"]')?.click(); true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  await check("角色声音：面板里能选全部音色，选了立刻存住、刷新后还是它、角色真的用它", async () => {
    // 用户 2026-09-16 反馈：「角色声音应该要全部能够在角色语音那个界面显示」+
    //   「跳转到设置界面选声音，也无法保存让角色使用」。
    // 这条把两件事钉住：① 面板里有**全量**选择（不只是三个推荐候选）；
    //   ② 在那里选的音色要落盘、刷新后还在、**合成请求真的用它**。
    //
    // ⚠ 这里**不点**"选一个"那条 UI 路（点一下会顺手试听一次，试听要等播放结束；
    //   无头环境里那一步不保证回得来）。走的是同一个保存入口 `saveVoiceOverride`，
    //   与 UI 那条路完全一致；UI 那条路由 `diag-voice-pick.cjs` 对着真中转逐步走查过。
    try {
      await ensureSheetCharacter();
      await evaluate(`(() => { try { localStorage.setItem('card_welcome_seen','1'); } catch (_) {} return true; })()`);
      // 先做掉上一轮的收尾，再用带卡的方式整页打开并开启语音（整轮跑时"内存里以为开着、
      //   库里其实关着"这个套装踩过）。
      await closeAppWithVoice();
      const ready = await openAppWithVoice();
      assert(ready.canSpeak, "前置不成立：这台设备现在不能合成 —— " + ready.reason);
      await openChatFor(SHEET_AVATAR, SHEET_NAME, SHEET_CHAT);

      // 打开面板：开着的时候入口先给小菜单，走「声音设置…」进面板（跟用户一样）。
      await evaluate("document.querySelector('#replyVoiceToggle').click(); true");
      await waitFor("!!document.querySelector('#voiceReplyMenu') || !!document.querySelector('#voiceSheet')", 8000,
        "点了「角色语音」入口，既没有小菜单也没有面板");
      await evaluate(`(() => {
        const item = document.querySelector('#voiceReplyMenu .rw-voice-menu-item.is-plain');
        if (item) item.click();
        return true;
      })()`);
      await waitFor("!!document.querySelector('#voiceSheet')", 8000, "「声音设置…」没有打开面板");
      await waitFor("!!document.querySelector('#voiceSheet [data-voice-all-select]')", 8000,
        "面板里没有「全部音色」那个下拉（用户要的是全部都能在这里选）");

      const shape = await evaluate(`(() => {
        const sheet = document.querySelector('#voiceSheet');
        const select = sheet.querySelector('[data-voice-all-select]');
        const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
        const cap = window.RoleWorldVoiceCloud.capability();
        const fits = (cap.speakers || []).filter((one) => String(one.id).indexOf('zh_') === 0).map((one) => one.id);
        return {
          candidates: sheet.querySelectorAll('[data-voice-pick]').length,
          optionCount: options.length,
          fitsCount: fits.length,
          coversAll: fits.every((id) => options.indexOf(id) >= 0),
          groups: Array.from(select.querySelectorAll('optgroup')).map((g) => g.label),
          hasTest: !!sheet.querySelector('[data-voice-all-test]'),
        };
      })()`);
      assert(shape.candidates === 0,
        "面板里还在替用户挑音色（2026-09-18 用户要求去掉「挑好的」，让用户自己选）：" + JSON.stringify(shape));
      assert(shape.optionCount >= shape.fitsCount,
        "面板里的音色比中转开放的还少（用户要的是全部）：" + JSON.stringify(shape));
      assert(shape.coversAll, "中转开放的音色没有全在里面：" + JSON.stringify(shape));
      assert(shape.groups.length >= 1, "全量下拉没有分组（几十个平铺找不到）：" + JSON.stringify(shape));
      assert(shape.hasTest, "全量下拉旁边没有「试听这个」：" + JSON.stringify(shape));

      // 存一个别的音色 → 落盘；刷新之后还在，而且角色取到的就是它。
      const picked = await evaluate(`(async () => {
        const select = document.querySelector('#voiceSheet [data-voice-all-select]');
        const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
        const before = select.value;
        const wanted = options.find((id) => id !== before) || before;
        await window.TASK21.saveVoiceOverride(${JSON.stringify(SHEET_AVATAR)}, { speaker: wanted });
        const s = await RoleWorld.getLocalSettings();
        return { wanted, stored: ((s.voice_by_card || {})[${JSON.stringify(SHEET_AVATAR)}] || {}).speaker || null };
      })()`);
      assert(picked.stored === picked.wanted,
        "在面板里选的音色没有落盘（用户报的就是「存不住」）：" + JSON.stringify(picked));

      // 刷新 → 还在 → 角色接下来**就用它**（读的是角色取音色的那个函数本身）。
      // ⚠ 这里不真发一次合成：真合成要等播放链路走完，而无头环境里那条路只做了一半
      //   （`installFakeAudio` 装的是最小替身），用例不该在这上面卡住。
      //   "合成请求真的带的是这个音色"由 `diag-voice-pick.cjs` 对着真中转验过（见交付报告）。
      await goto(base + "/index.html");
      await waitFor("window.TASK21_READY === true", 30000);
      const used = await evaluate(`(async () => {
        const s = await RoleWorld.getLocalSettings();
        const setting = window.RoleWorldVoiceCloud.settingFor(${JSON.stringify(SHEET_AVATAR)}, s);
        return { stored: ((s.voice_by_card || {})[${JSON.stringify(SHEET_AVATAR)}] || {}).speaker || null, setting: setting.speaker };
      })()`);
      assert(used.stored === picked.wanted,
        "刷新之后存的那个音色没了（用户报的「存不住」就是这个）：" + JSON.stringify({ used, picked }));
      assert(used.setting === picked.wanted,
        "刷新之后这个角色取到的音色不是选的那个：" + JSON.stringify({ used, picked }));
      reportErrors("角色声音：全量音色与保存");
    } finally {
      await evaluate("document.querySelector('#voiceSheet')?.remove(); document.querySelector('#voiceReplyMenu')?.remove(); true").catch(() => {});
      await closeAppWithVoice();
      await restoreDefaultContext().catch(() => {});
    }
  });

  // 收尾动作登记成全局：`main()` 抛错时外层 finally 也走同一套，避免"失败即挂死"。
  let cleaned = false;
  globalThis.__rwCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { cdp.close(); } catch (_) { /* ignore */ }
    try { chrome.proc.kill(); } catch (_) { /* ignore */ }
    try { server.close(); } catch (_) { /* ignore */ }
  };
  globalThis.__rwCleanup();

  console.log("");
  // 口径：跳过的（--only / --from 之外）**不算通过**；分母仍是总条数。
  const skipped = results.filter((row) => row.skipped === true).length;
  const executed = results.filter((row) => row.skipped !== true);
  const passed = executed.filter((row) => row.ok).length;
  console.log(`LOCAL_APP=${passed}/${results.length}`
    + `  executed=${executed.length} passed=${passed} failed=${failures} skipped=${skipped}`
    + ` slow=${slowCases}（阈值 ${SLOW_CASE_MS / 1000}s）`);
  // 筛选**零命中**必须报错：否则"什么都没跑"会被当成"全绿"（这个项目踩过同类的坑）。
  if ((ARG_ONLY || ARG_FROM) && executed.length === 0) {
    console.error("筛选没有命中任何用例：--only=" + ARG_ONLY + " / --from=" + ARG_FROM + " —— 这不是成功。");
    process.exitCode = 2;
    return;
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("测试运行失败：", error);
  process.exitCode = 1;
}).finally(() => {
  // ⚠ 出师未捷也要收摊：`main()` 中途抛错时如果直接进 catch，
  //   无头 Chrome 与静态服务器都还活着，Node 事件循环就永远不空 ——
  //   实测这种"测试失败"会挂满外层硬帽（240 秒）才被杀，看起来像"慢"，实际是没退。
  //   这里统一收尾，保证任何失败路径都在秒级退出。
  try {
    if (globalThis.__rwCleanup) globalThis.__rwCleanup();
  } catch (_) { /* 收尾失败不掩盖真正的错误 */ }
});
