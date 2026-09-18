"use strict";

/*
 * relay/server.js —— 「体验卡」中转服务（OpenAI 兼容，SSE 透传）
 *
 * 为什么要有它：真 key 一旦发给同学，就等于给出去了、收不回来。所以真 key 只存在服务端，
 * 同学拿到的是一张**可限额、可到期、可随时吊销**的卡号。
 *
 * 路由：
 *   POST /v1/chat/completions   聊天（流式 / 非流式都透传）
 *   POST /v1/audio/speech       角色语音（火山「豆包语音合成模型 2.0」，服务端持凭据）
 *   GET  /v1/models             模型清单（透传上游）
 *   GET  /card/quota            查这张卡还能用多少（聊天 + 语音）
 *   GET  /voice/info            这个中转提供哪些音色、一次能合成多长
 *   GET  /healthz               存活检查
 *   POST /admin/cards           发卡（需要 ADMIN_SECRET）
 *   GET  /admin/cards           列卡（不含卡号）
 *   POST /admin/cards/:id/disable | /enable
 *   PATCH /admin/cards/:id/update
 *   DELETE /admin/cards/:id     吊销
 *   GET  /admin/voice/config    语音上游配没配（**不联网、不产生费用**）
 *
 * 三条硬规矩（写进代码，不靠自觉）：
 *   ① 不记正文：日志只有 时间/卡 id/模型/是否流式/耗时/用量，永远没有 messages 的内容，
 *      语音这一路也一样 —— 只有字符数，没有合成的是哪句话。
 *   ② 卡的哈希入库：账本里存 sha256(token)，不存 token 本身。
 *   ③ 火山凭据只从服务端环境变量读，绝不出现在任何响应里，也绝不发给客户端。
 */

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const storeLib = require("./store.js");
const ttsLib = require("./tts.js");
const voiceLib = require("./voices.js");

const DEFAULT_UPSTREAM = "https://api.deepseek.com";
const DEFAULT_ALLOW_MODELS = [];      // 空 = 不限制
const CARD_HEADERS = [
  "x-rw-card-calls-left", "x-rw-card-tokens-left", "x-rw-card-expires", "x-rw-card-id",
  // 语音是**独立**的一份额度（按字符计），所以单独两个头：客户端据此提前提醒"语音快用完了"。
  "x-rw-voice-left", "x-rw-voice-chars-left",
];
/** 一次语音请求最多合成多少字。太长会：①上游更慢 ②用户想停就得等。客户端按句切分后再发。 */
const DEFAULT_VOICE_MAX_CHARS = 400;
/** 整个中转同时最多几路语音合成（火山按 QPS 限流，堆太多只会一起超时）。 */
const DEFAULT_VOICE_CONCURRENCY = 4;
/** 同一张卡同时最多几路（默认 1：客户端本来就是一句一句播的，多路多半是误点/转借）。 */
const DEFAULT_VOICE_PER_CARD = 1;

function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const headers = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-requested-with",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": CARD_HEADERS.join(","),
  };
}

function bearer(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function readBody(req, limitBytes) {
  const limit = limitBytes || 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 卡是否还能用；不能用时给出人话原因。剩余额度无论成败都算出来（客户端要拿去显示）。 */
function checkCard(card) {
  const callsLeft = card && Number(card.quota.calls) > 0 ? Number(card.quota.calls) - Number(card.used.calls || 0) : Infinity;
  const tokensLeft = card && Number(card.quota.tokens) > 0 ? Number(card.quota.tokens) - Number(card.used.tokens || 0) : Infinity;
  // 语音额度是独立一份（按字符计），所以这两个数无论聊天能不能用都要算出来。
  const voiceLeft = card && Number(card.quota.voice) > 0 ? Number(card.quota.voice) - Number(card.used.voice || 0) : Infinity;
  const voiceCharsLeft = card && Number(card.quota.voiceChars) > 0
    ? Number(card.quota.voiceChars) - Number(card.used.voiceChars || 0)
    : Infinity;
  const extra = { voiceLeft, voiceCharsLeft };
  if (!card) return Object.assign({ ok: false, code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了，或者已经被收回。", callsLeft, tokensLeft }, extra);
  if (card.disabled) return Object.assign({ ok: false, code: "CARD_DISABLED", message: "这张体验卡已被停用。找发卡的人问问，或者换成自己的 API Key。", callsLeft, tokensLeft }, extra);
  if (card.expiresAt && Date.parse(card.expiresAt) < Date.now()) {
    return Object.assign({ ok: false, code: "CARD_EXPIRED", message: "这张体验卡已到期（" + card.expiresAt.slice(0, 10) + "）。", callsLeft, tokensLeft }, extra);
  }
  if (callsLeft <= 0) return Object.assign({ ok: false, code: "CARD_NO_CALLS", message: "这张体验卡的次数用完了（上限 " + card.quota.calls + " 次）。", callsLeft, tokensLeft }, extra);
  if (tokensLeft <= 0) return Object.assign({ ok: false, code: "CARD_NO_TOKENS", message: "这张体验卡的额度用完了（上限 " + card.quota.tokens + " token）。", callsLeft, tokensLeft }, extra);
  return Object.assign({ ok: true, callsLeft, tokensLeft }, extra);
}

/**
 * 语音这一路单独的判断：先过卡本身（不认识/停用/到期），再看语音的两份额度（次数、字符）。
 * 为什么不让语音吃聊天的次数：语音按字符计费、聊天按 token 计费，混在一起之后
 * "次数还剩 3 次却发不出声"没法解释。chars 是这一次请求要合成的字数（用于"够不够"的判断）。
 */
function checkVoiceCard(card, chars) {
  const base = checkCard(card);
  const need = Math.max(0, Number(chars) || 0);
  if (!base.ok) return base;
  if (base.voiceLeft <= 0) {
    return Object.assign({}, base, {
      ok: false, code: "CARD_NO_VOICE",
      message: "这张体验卡的语音次数用完了（上限 " + card.quota.voice + " 次）。文字聊天不受影响。",
    });
  }
  if (base.voiceCharsLeft < need) {
    return Object.assign({}, base, {
      ok: false, code: "CARD_NO_VOICE_CHARS",
      message: "这张体验卡的语音字数不够了（上限 " + card.quota.voiceChars + " 字，这次要 " + need + " 字）。文字聊天不受影响。",
    });
  }
  return base;
}

function cardHeaders(card, verdict) {
  const finite = (value) => (Number.isFinite(value) ? String(value) : "unlimited");
  return {
    "x-rw-card-id": card.id,
    "x-rw-card-calls-left": finite(verdict.callsLeft),
    "x-rw-card-tokens-left": finite(verdict.tokensLeft),
    "x-rw-card-expires": card.expiresAt || "never",
    "x-rw-voice-left": finite(verdict.voiceLeft),
    "x-rw-voice-chars-left": finite(verdict.voiceCharsLeft),
  };
}

/** 从上游返回里抠出 usage（流式最后一帧里才有）。 */
function usageFromText(text) {
  const matches = String(text || "").match(/"usage"\s*:\s*\{[^}]*\}/g);
  if (!matches || !matches.length) return null;
  const last = matches[matches.length - 1];
  try {
    const usage = JSON.parse("{" + last + "}");
    const prompt = Number(usage.usage && usage.usage.prompt_tokens) || 0;
    const completion = Number(usage.usage && usage.usage.completion_tokens) || 0;
    return { prompt, completion, total: Number(usage.usage && usage.usage.total_tokens) || (prompt + completion) };
  } catch (_) { return null; }
}

function createRelay(options) {
  const opts = options || {};
  const store = opts.store || storeLib.createStore({});
  const upstreamBase = String(opts.upstreamBase || process.env.UPSTREAM_BASE || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  // 上游聊天路径可配：DeepSeek 官方是 /v1/chat/completions；
  // 云开发自己的大模型网关是 <base>/chat/completions（base 形如 …/v1/ai/cloudbase）。
  const upstreamChatPath = String(opts.upstreamChatPath || process.env.UPSTREAM_CHAT_PATH || "/v1/chat/completions");
  const upstreamModelsPath = String(opts.upstreamModelsPath || process.env.UPSTREAM_MODELS_PATH || "/v1/models");
  const upstreamKey = opts.upstreamKey !== undefined ? opts.upstreamKey : (process.env.UPSTREAM_KEY || "");
  const adminSecret = opts.adminSecret !== undefined ? opts.adminSecret : (process.env.ADMIN_SECRET || "");
  const allowModels = opts.allowModels || String(process.env.ALLOW_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const agentFor = (url) => (url.protocol === "https:" ? https : http);
  // 日志只有元数据：时间、卡 id、模型、是否流式、状态、耗时、用量。**没有正文**。
  const logSink = opts.logSink || ((line) => console.log(JSON.stringify(line)));

  /* ---------------- 语音（火山「豆包语音合成模型 2.0」） ---------------- */

  const voiceMaxChars = Number(opts.voiceMaxChars || process.env.VOICE_MAX_CHARS) || DEFAULT_VOICE_MAX_CHARS;
  const voiceConcurrency = Number(opts.voiceConcurrency || process.env.VOICE_CONCURRENCY) || DEFAULT_VOICE_CONCURRENCY;
  const voicePerCard = Number(opts.voicePerCard || process.env.VOICE_PER_CARD) || DEFAULT_VOICE_PER_CARD;
  const tts = opts.tts || ttsLib.createTtsClient({ env: process.env, timeoutMs: Number(process.env.VOICE_TIMEOUT_MS) || 30000 });
  const envSource = opts.voiceEnv || process.env;
  const speakerTable = () => voiceLib.resolveSpeakers(envSource);
  // 正在跑的语音路数（全局 + 每张卡）。进程级计数，重启归零 —— 它只是限流，不是账本。
  let voiceRunning = 0;
  const voiceRunningByCard = new Map();
  const voiceBusy = (cardId) => (voiceRunningByCard.get(cardId) || 0);

  async function usageOfCard(card) {
    const verdict = checkCard(card);
    return {
      id: card.id,
      label: card.label,
      disabled: !!card.disabled,
      expiresAt: card.expiresAt,
      quota: card.quota,
      used: card.used,
      callsLeft: Number.isFinite(verdict.callsLeft) ? verdict.callsLeft : null,
      tokensLeft: Number.isFinite(verdict.tokensLeft) ? verdict.tokensLeft : null,
      voiceLeft: Number.isFinite(verdict.voiceLeft) ? verdict.voiceLeft : null,
      voiceCharsLeft: Number.isFinite(verdict.voiceCharsLeft) ? verdict.voiceCharsLeft : null,
    };
  }

  async function recordUsage(card, usage) {
    const isVoice = !!(usage && usage.kind === "voice");
    const next = Object.assign({}, card, {
      used: Object.assign({ calls: 0, tokens: 0, voice: 0, voiceChars: 0 }, card.used, isVoice
        ? { voice: Number(card.used.voice || 0) + 1, voiceChars: Number(card.used.voiceChars || 0) + (Number(usage.chars) || 0) }
        : { calls: Number(card.used.calls || 0) + 1, tokens: Number(card.used.tokens || 0) + (usage && usage.total ? usage.total : 0) }),
      lastUsedAt: new Date().toISOString(),
    });
    // 按天也记一笔（2026-09-12）：累计值看不出"今天谁用得多"。
    next.daily = storeLib.addDailyUsage(next, next.lastUsedAt.slice(0, 10), usage);
    await store.save(next);
    return next;
  }

  /* ---------------- 管理接口 ---------------- */

  async function handleAdmin(req, res, url) {
    if (!adminSecret) return sendJson(res, 503, { error: "服务端没有设置 ADMIN_SECRET，管理接口已关闭" }, corsHeaders());
    if (bearer(req) !== adminSecret) return sendJson(res, 401, { error: "管理口令不对" }, corsHeaders());
    const parts = url.pathname.split("/").filter(Boolean);   // admin/cards/:id/:action

    if (req.method === "GET" && parts.length === 2 && parts[1] === "cards") {
      const cards = await store.list();
      return sendJson(res, 200, {
        cards: cards.map((card) => ({
          id: card.id, label: card.label, createdAt: card.createdAt, expiresAt: card.expiresAt,
          quota: card.quota, used: card.used, disabled: card.disabled, note: card.note,
          lastUsedAt: card.lastUsedAt || null,
          daily: card.daily || {},
        })),
      }, corsHeaders());
    }

    if (req.method === "POST" && parts.length === 2) {
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) { return sendJson(res, 400, { error: "请求体不是 JSON" }, corsHeaders()); }
      const calls = Math.max(0, Number(body.calls) || 0);
      const tokens = Math.max(0, Number(body.tokens) || 0);
      const voice = Math.max(0, Number(body.voice) || 0);
      const voiceChars = Math.max(0, Number(body.voiceChars) || 0);
      const days = Math.max(0, Number(body.days) || 0);
      const token = storeLib.randomToken();
      const card = storeLib.blankCard({
        tokenHash: storeLib.hashToken(token),
        label: String(body.label || "").slice(0, 60),
        note: String(body.note || "").slice(0, 200),
        expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
        quota: { calls, tokens, voice, voiceChars },
      });
      await store.save(card);
      return sendJson(res, 200, {
        id: card.id,
        token,
        label: card.label,
        quota: card.quota,
        expiresAt: card.expiresAt,
        hint: "卡号只显示这一次，请立刻复制给对方（账本里只存哈希，找不回来）。"
          + (voice || voiceChars ? "" : "（这次没给语音额度 —— 语音是可选的，不加就不占。）"),
      }, corsHeaders());
    }

    /* 改一张已有的卡：加次数 / 加 token / 续期 / 改标签备注（2026-09-12 新增）。
     * 为什么需要它：同学那边次数用完了，以前只能"重新发一张" —— 他就得重新配一次卡。
     * 现在可以就地补：`PATCH /admin/cards/:id {calls, tokens, days, label, note}`。
     * 语义：calls/tokens 是**新的上限**（不是增量），days 是"从今天起再给几天"。 */
    if ((req.method === "PATCH" || req.method === "POST") && parts.length === 4 && parts[3] === "update") {
      const card = await store.get(parts[2]);
      if (!card) return sendJson(res, 404, { error: "没有这张卡" }, corsHeaders());
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) { return sendJson(res, 400, { error: "请求体不是 JSON" }, corsHeaders()); }
      const next = Object.assign({}, card);
      if (body.calls !== undefined) next.quota = Object.assign({}, next.quota, { calls: Math.max(0, Number(body.calls) || 0) });
      if (body.tokens !== undefined) next.quota = Object.assign({}, next.quota, { tokens: Math.max(0, Number(body.tokens) || 0) });
      // 语音额度（2026-09-14）：同样按"新的上限"理解，加语音不用重新发卡。
      if (body.voice !== undefined) next.quota = Object.assign({}, next.quota, { voice: Math.max(0, Number(body.voice) || 0) });
      if (body.voiceChars !== undefined) next.quota = Object.assign({}, next.quota, { voiceChars: Math.max(0, Number(body.voiceChars) || 0) });
      if (body.days !== undefined) {
        const days = Math.max(0, Number(body.days) || 0);
        next.expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
      }
      if (body.label !== undefined) next.label = String(body.label || "").slice(0, 60);
      if (body.note !== undefined) next.note = String(body.note || "").slice(0, 200);
      if (body.disabled !== undefined) next.disabled = body.disabled === true;
      await store.save(next);
      return sendJson(res, 200, {
        id: next.id,
        label: next.label,
        quota: next.quota,
        used: next.used,
        expiresAt: next.expiresAt,
        disabled: next.disabled === true,
      }, corsHeaders());
    }

    /* 按天用量汇总（2026-09-12 新增）：把每张卡的 daily 加起来，给控制台看"今天用了多少"。 */
    if (req.method === "GET" && parts.length === 2 && parts[1] === "usage") {
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 14));
      const cards = await store.list();
      const byDay = new Map();
      for (const card of cards) {
        const daily = (card && card.daily) || {};
        for (const [day, row] of Object.entries(daily)) {
          const current = byDay.get(day) || { calls: 0, tokens: 0, voice: 0, chars: 0, cards: 0 };
          current.calls += Number(row && row.calls) || 0;
          current.tokens += Number(row && row.tokens) || 0;
          current.voice += Number(row && row.voice) || 0;
          current.chars += Number(row && row.chars) || 0;
          if ((Number(row && row.calls) || 0) > 0 || (Number(row && row.voice) || 0) > 0) current.cards += 1;
          byDay.set(day, current);
        }
      }
      const today = new Date();
      const out = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const day = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
        const row = byDay.get(day) || { calls: 0, tokens: 0, voice: 0, chars: 0, cards: 0 };
        out.push({ day: day, calls: row.calls, tokens: row.tokens, voice: row.voice, chars: row.chars, cards: row.cards });
      }
      const totalCalls = cards.reduce((sum, card) => sum + (Number(card.used && card.used.calls) || 0), 0);
      const totalVoice = cards.reduce((sum, card) => sum + (Number(card.used && card.used.voice) || 0), 0);
      return sendJson(res, 200, {
        days: out,
        cards: cards.length,
        totalCalls: totalCalls,
        totalVoice: totalVoice,
        hint: "按天只统计这张卡自己记得的日子；账本里最多留 " + storeLib.DAILY_KEEP + " 天。",
      }, corsHeaders());
    }

    /* 语音上游配没配 —— **只看环境变量，不联网、不产生任何费用**。
     * 为什么刻意不做"真调一次"的自检：语音是按字符计费的，
     * 一个自检按钮不该悄悄花掉用户的钱（真联调要单独授权）。 */
    if (req.method === "GET" && parts.length === 3 && parts[1] === "voice" && parts[2] === "config") {
      const table = speakerTable();
      return sendJson(res, 200, {
        configured: !!tts.config.configured,
        missing: tts.config.missing,
        base: tts.config.base,
        path: tts.config.path,
        resourceId: tts.config.resourceId,
        model: tts.config.model,
        speakers: table.speakers.map((one) => ({ id: one.id, label: one.label, verified: one.verified !== false })),
        speakersSource: table.source,
        defaultSpeaker: table.defaultSpeaker,
        maxChars: voiceMaxChars,
        timeoutMs: tts.timeoutMs,
        concurrency: { global: voiceConcurrency, perCard: voicePerCard },
        running: voiceRunning,
        hint: "这里只报「配没配」，不会真的去合成 —— 语音按字符计费，自检不该花钱。"
          + "要真联调请单独授权，并把 VOLC_TTS_APP_ID / VOLC_TTS_ACCESS_KEY 注入到中转服务。",
      }, corsHeaders());
    }

    /* 上游自检：拿服务端的真 Key 打一次最小请求，把"配错了 Key / 路径不对 / 模型名不对"
     * 和"账本坏了"这两类问题分开。回复只回前 60 个字符，不落任何日志。
     *
     * ⚠ 2026-09-14 修：这里原来写死 `max_tokens: 64`，而 `deepseek-flash` 这类模型
     * **会先吐思考内容**（reasoning_content）—— 64 个 token 全被思考吃掉，正文是空的，
     * 于是自检报 `ok: true`（因为 HTTP 是 200）却什么都没回。
     * "报成功但没内容"比报错更坑：用户会以为链路是好的。现在：
     *   · max_tokens 提到 512（够思考 + 两三个字）；
     *   · `ok` 的含义改成"**真的拿到正文了**"，没拿到就带一句 warning 说清为什么。 */
    if (req.method === "GET" && parts.length === 3 && parts[1] === "upstream" && parts[2] === "selftest") {
      if (!upstreamKey) return sendJson(res, 503, { ok: false, error: "服务端没有配置 UPSTREAM_KEY" }, corsHeaders());
      const model = String(url.searchParams.get("model") || allowModels[0] || "deepseek-flash");
      const target = new URL(upstreamBase + upstreamChatPath);
      const payload = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "只回复两个字：可用" }], max_tokens: 512, stream: false }), "utf8");
      const startedAt = Date.now();
      const result = await new Promise((resolve) => {
        const request = agentFor(target).request({
          protocol: target.protocol, hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search, method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + upstreamKey, "Content-Length": String(payload.length) },
        }, (upstreamRes) => {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let reply = "";
            let reasoning = "";
            try {
              const parsed = JSON.parse(text);
              const message = (parsed.choices && parsed.choices[0] && parsed.choices[0].message) || {};
              reply = String(message.content || "");
              reasoning = String(message.reasoning_content || message.reasoning || "");
            } catch (_) { /* 解析不了就当没有正文 */ }
            resolve({
              status: upstreamRes.statusCode || 0,
              reply: reply.slice(0, 60),
              reasoningLen: reasoning.length,
              body: reply ? "" : text.slice(0, 300),
            });
          });
        });
        request.on("error", (error) => resolve({ status: 0, error: error.message }));
        request.end(payload);
      });
      const gotContent = result.status === 200 && !!String(result.reply || "").trim();
      const response = Object.assign({
        ok: gotContent, model, url: upstreamBase + upstreamChatPath, ms: Date.now() - startedAt,
      }, result);
      if (result.status === 200 && !gotContent) {
        response.warning = result.reasoningLen
          ? "上游 HTTP 200，但正文是空的：这个模型把额度都花在思考内容上了（reasoning " + result.reasoningLen + " 字）。链路是通的，但**不能算可用**。"
          : "上游 HTTP 200，但正文是空的 —— 链路通、模型没给出内容。";
      }
      return sendJson(res, gotContent ? 200 : 502, response, corsHeaders());
    }

    /* 账本自检：配好环境变量后调一次，就能知道"卡到底存哪、存不存得住"。
     * 这正是部署时最容易踩的坑：以为在存数据库，其实退回了容器临时盘。 */
    if (req.method === "GET" && parts.length === 3 && parts[1] === "store" && parts[2] === "selftest") {
      const probe = storeLib.blankCard({ tokenHash: storeLib.hashToken("selftest-" + Date.now()), label: "自检" });
      const result = { kind: store.kind, wrote: false, readBack: false, removed: false, error: null };
      try {
        await store.save(probe);
        result.wrote = true;
        const back = await store.get(probe.id);
        result.readBack = !!back && back.id === probe.id;
        result.removed = await store.remove(probe.id);
        result.cards = (await store.list()).length;
      } catch (error) {
        result.error = String((error && error.message) || error);
      }
      result.ok = result.wrote && result.readBack && result.removed;
      result.hint = result.ok
        ? "账本可用；kind=cloudbase 才是「重启也不丢卡」"
        : "账本用不了：请检查集合 rw_cards 是否存在、服务角色有没有读写权限，或改用存储挂载 + CARD_STORE=file";
      return sendJson(res, result.ok ? 200 : 500, result, corsHeaders());
    }

    if (req.method === "POST" && parts.length === 4 && (parts[3] === "disable" || parts[3] === "enable")) {      const card = await store.get(parts[2]);
      if (!card) return sendJson(res, 404, { error: "没有这张卡" }, corsHeaders());
      card.disabled = parts[3] === "disable";
      await store.save(card);
      return sendJson(res, 200, { id: card.id, disabled: card.disabled }, corsHeaders());
    }

    if (req.method === "DELETE" && parts.length === 3) {
      const removed = await store.remove(parts[2]);
      return sendJson(res, removed ? 200 : 404, { removed }, corsHeaders());
    }

    return sendJson(res, 404, { error: "没有这个管理接口" }, corsHeaders());
  }

  /* ---------------- 聊天透传 ---------------- */

  async function handleChat(req, res) {
    const token = bearer(req);
    const card = token ? await store.findByToken(token) : null;
    const verdict = checkCard(card);
    if (!verdict.ok) {
      logSink({ at: new Date().toISOString(), event: "reject", code: verdict.code, cardId: card ? card.id : null });
      // 被拒的响应也带上剩余额度：客户端要能显示"剩 0 次"，而不是只说一句失败。
      const headers = Object.assign(corsHeaders(), card ? cardHeaders(card, verdict) : {});
      return sendJson(res, verdict.code === "CARD_UNKNOWN" ? 401 : 402, { error: { code: verdict.code, message: verdict.message } }, headers);
    }
    if (!upstreamKey) return sendJson(res, 503, { error: { code: "RELAY_NO_KEY", message: "服务端没有配置上游 API Key" } }, corsHeaders());

    const raw = await readBody(req);
    let body = null;
    try { body = JSON.parse(raw.toString("utf8")); } catch (_) {
      return sendJson(res, 400, { error: { code: "BAD_JSON", message: "请求体不是 JSON" } }, corsHeaders());
    }
    const model = String(body.model || "");
    if (allowModels.length && allowModels.indexOf(model) < 0) {
      return sendJson(res, 403, { error: { code: "MODEL_NOT_ALLOWED", message: "这张卡不能使用模型：" + model } }, corsHeaders());
    }

    const target = new URL(upstreamBase + upstreamChatPath);
    // 流式时上游默认不回 usage（OpenAI 兼容的约定）：不带上它，卡的 token 额度就永远是 0。
    // 只在流式、调用方没自己指定、且上游是 DeepSeek 官方或显式打开开关时才加这一项 ——
    // 免得给不认识这个字段的服务商塞参数导致请求失败。
    if (body.stream === true && !body.stream_options) {
      const deepseekUpstream = /(^|\.)api\.deepseek\.com$/.test(target.hostname);
      if (deepseekUpstream || String(process.env.RELAY_INCLUDE_USAGE || "") === "1") {
        body.stream_options = { include_usage: true };
      }
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + upstreamKey,
      "Content-Length": String(payload.length),
      "Accept": body.stream === true ? "text/event-stream" : "application/json",
    };
    const startedAt = Date.now();
    const outHeaders = Object.assign(corsHeaders(), cardHeaders(card, verdict));

    await new Promise((resolve) => {
      const upstreamReq = agentFor(target).request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers,
      }, (upstreamRes) => {
        const streaming = String(upstreamRes.headers["content-type"] || "").indexOf("text/event-stream") >= 0;
        const status = upstreamRes.statusCode || 502;
        // 上游报错：读全再转发（错误体很小），并把用量记一笔（次数照算）。
        if (status >= 400) {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.on("end", async () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const usage = usageFromText(text);
            await recordUsage(card, usage);
            logSink({ at: new Date().toISOString(), event: "upstream-error", cardId: card.id, model, status, ms: Date.now() - startedAt });
            res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, outHeaders));
            res.end(Buffer.from(text, "utf8"));
            resolve();
          });
          return;
        }
        if (streaming) {
          res.writeHead(status, Object.assign({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" }, outHeaders));
          res.flushHeaders();
        } else {
          res.writeHead(status, Object.assign({ "Content-Type": upstreamRes.headers["content-type"] || "application/json; charset=utf-8" }, outHeaders));
        }
        // 尾巴留 16KB 用来捞 usage（流式时它在最后一帧）。
        let tail = "";
        upstreamRes.on("data", (chunk) => {
          tail = (tail + chunk.toString("utf8")).slice(-16384);
          res.write(chunk);   // 原样透传，不缓冲、不改写
        });
        upstreamRes.on("end", async () => {
          const usage = usageFromText(tail);
          const updated = await recordUsage(card, usage);
          const used = updated.used;
          logSink({
            at: new Date().toISOString(), event: "turn", cardId: card.id, model, stream: streaming,
            status, ms: Date.now() - startedAt,
            calls: used.calls, tokens: used.tokens,   // 只有用量，没有正文
          });
          res.end();
          resolve();
        });
        upstreamRes.on("error", () => { try { res.end(); } catch (_) {} resolve(); });
      });
      upstreamReq.on("error", async (error) => {
        logSink({ at: new Date().toISOString(), event: "upstream-unreachable", cardId: card.id, model, message: error.message });
        if (!res.headersSent) sendJson(res, 502, { error: { code: "UPSTREAM_UNREACHABLE", message: "连不上模型服务：" + error.message } }, corsHeaders());
        else { try { res.end(); } catch (_) {} }
        resolve();
      });
      upstreamReq.end(payload);
    });
  }

  /* ---------------- 角色语音（文字 → 音频） ----------------
   *
   * 客户端只发：卡号（Authorization）+ 要念的那句话 + 音色 + 语速。
   * 火山凭据在服务端，永远不出现在响应里。
   *
   * 这一路**不是** OpenAI 的 /audio/speech 兼容口：请求体是我们自己的窄接口，
   * 参数只有中转允许的那几个（音色必须在服务端白名单里），这样客户端改不动
   * 中转不打算开放的参数，也顺手挡掉了"把任意文本塞进别人的账号合成"的用法。
   */

  function voiceError(res, status, code, message, extraHeaders) {
    return sendJson(res, status, { error: { code, message } }, Object.assign({}, corsHeaders(), extraHeaders || {}));
  }

  async function handleVoice(req, res) {
    const token = bearer(req);
    const card = token ? await store.findByToken(token) : null;
    const raw = await readBody(req, 64 * 1024);
    let body = null;
    try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) {
      return voiceError(res, 400, "BAD_JSON", "请求体不是 JSON");
    }

    const text = String(body.text === undefined || body.text === null ? "" : body.text).trim();
    const chars = text.length;
    // 顺序很重要：先判"这个请求本身合不合法"（400/413），再判"这张卡还有没有额度"（402）。
    // 反过来的话，一张小额度的卡去发超长文本会得到"字数不够"，而真正的原因是"一次发太长了"。
    const speakerDefault = speakerTable().defaultSpeaker;
    const wanted = String(body.speaker || "").trim() || speakerDefault;
    const speaker = voiceLib.findSpeaker(wanted, envSource);
    if (!text) {
      const verdict = checkVoiceCard(card, 0);
      logSink({ at: new Date().toISOString(), event: "voice-reject", code: "VOICE_EMPTY_TEXT", cardId: card ? card.id : null, chars: 0 });
      return voiceError(res, 400, "VOICE_EMPTY_TEXT", "没有要合成的内容。", card ? cardHeaders(card, verdict) : {});
    }
    if (chars > voiceMaxChars) {
      const verdict = checkVoiceCard(card, 0);
      logSink({ at: new Date().toISOString(), event: "voice-reject", code: "VOICE_TEXT_TOO_LONG", cardId: card ? card.id : null, chars });
      return voiceError(res, 413, "VOICE_TEXT_TOO_LONG",
        "一次最多合成 " + voiceMaxChars + " 个字（这次 " + chars + " 个字）；长回复应当在客户端按句切分后分几次发。",
        card ? cardHeaders(card, verdict) : {});
    }
    // 再拿"这次想合成多少字"去判额度 —— 否则会出现"额度剩 10 字却发了 300 字"。
    const verdict = checkVoiceCard(card, chars);
    if (!verdict.ok) {
      logSink({ at: new Date().toISOString(), event: "voice-reject", code: verdict.code, cardId: card ? card.id : null, chars });
      return voiceError(
        res,
        verdict.code === "CARD_UNKNOWN" ? 401 : 402,
        verdict.code, verdict.message,
        card ? cardHeaders(card, verdict) : {},
      );
    }
    if (!speaker) {
      return voiceError(res, 400, "VOICE_SPEAKER_UNKNOWN",
        "这个中转没有开放音色「" + wanted + "」。可用音色见 GET /voice/info。",
        cardHeaders(card, verdict));
    }

    if (!tts.config.configured) {
      return voiceError(res, 503, "RELAY_NO_VOICE_KEY",
        "中转服务端还没配火山语音凭据（缺 " + tts.config.missing.join(" / ") + "），语音暂时用不了；文字聊天不受影响。",
        cardHeaders(card, verdict));
    }

    if (voiceRunning >= voiceConcurrency || voiceBusy(card.id) >= voicePerCard) {
      logSink({ at: new Date().toISOString(), event: "voice-busy", cardId: card.id, running: voiceRunning });
      return voiceError(res, 429, "VOICE_BUSY", "语音合成正忙（同一时间只能合成一句），稍等一下再试。", cardHeaders(card, verdict));
    }

    // 客户端中断（切角色 / 切会话 / 点停止）时，必须把上游也掐掉 ——
    // 否则用户已经听不见了，钱还在烧。
    // ⚠ 判据是 **res 的 close + writableFinished**，不是 req 的 close：
    // 请求体早就读完了，`req.on("close")` 在客户端断开时**不会**触发（实测，
    // 见 tests/relay-check.cjs 的"客户端中断"用例）。用错了的话上游会一直挂着。
    const controller = new AbortController();
    let clientGone = false;
    const onClose = () => {
      if (res.writableFinished) return;
      clientGone = true;
      controller.abort();
    };
    res.on("close", onClose);

    voiceRunning += 1;
    voiceRunningByCard.set(card.id, voiceBusy(card.id) + 1);
    const startedAt = Date.now();
    let result = null;
    try {
      result = await tts.synthesize({
        text,
        speaker: speaker.id,
        format: String(body.format || "mp3").toLowerCase(),
        sample_rate: Number(body.sample_rate) || 24000,
        speech_rate: body.speech_rate,
      }, { signal: controller.signal, uid: card.id });
    } finally {
      voiceRunning -= 1;
      const left = voiceBusy(card.id) - 1;
      if (left > 0) voiceRunningByCard.set(card.id, left); else voiceRunningByCard.delete(card.id);
      res.removeListener("close", onClose);
    }

    if (clientGone || (result && result.code === "VOICE_CANCELED")) {
      logSink({ at: new Date().toISOString(), event: "voice-canceled", cardId: card.id, chars, ms: Date.now() - startedAt });
      try { res.destroy(); } catch (_) { /* 已经断了 */ }
      return undefined;
    }

    if (!result || !result.ok) {
      const code = (result && result.code) || "VOICE_FAILED";
      const status = code === "VOICE_TIMEOUT" ? 504
        : code === "RELAY_NO_VOICE_KEY" ? 503
          : code === "UPSTREAM_UNREACHABLE" ? 502
            : 502;
      logSink({
        at: new Date().toISOString(), event: "voice-error", cardId: card.id, chars,
        code, status, ms: Date.now() - startedAt,   // 只有用量与错误码，没有那句话
      });
      // 失败也记一次用量吗？**不记**：合成没成功就不该扣用户的钱。
      return voiceError(res, status, code, (result && result.message) || "语音合成失败。", cardHeaders(card, verdict));
    }

    const updated = await recordUsage(card, { kind: "voice", chars: result.chars || chars });
    const after = checkCard(updated);
    logSink({
      at: new Date().toISOString(), event: "voice", cardId: card.id, speaker: speaker.id, chars: result.chars || chars,
      bytes: result.audio.length, ms: Date.now() - startedAt,
      voiceCalls: updated.used.voice, voiceChars: updated.used.voiceChars,
    });

    const headers = Object.assign({}, corsHeaders(), cardHeaders(updated, after), {
      "Content-Type": result.contentType || "audio/mpeg",
      "Content-Length": String(result.audio.length),
      "Cache-Control": "no-store",
      // 音频是按 (文本+音色+参数) 缓存的：把最终用的参数回报给客户端，缓存键才算得准。
      "x-rw-voice-speaker": speaker.id,
      "x-rw-voice-chars": String(result.chars || chars),
    });
    res.writeHead(200, headers);
    res.end(result.audio);
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay.local");
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); return res.end(); }
      if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, store: store.kind, storeAuth: storeLib.describeAuth(), upstream: upstreamBase.replace(/\/\/[^@]*@/, "//"), upstreamChatPath, upstreamKeySet: !!upstreamKey, adminEnabled: !!adminSecret, voiceKeySet: !!tts.config.configured, voiceResourceId: tts.config.resourceId, voiceSpeakers: speakerTable().speakers.length, voiceMaxChars, at: new Date().toISOString() }, corsHeaders());
      if (url.pathname === "/card/quota") {
        const card = await store.findByToken(bearer(req));
        const verdict = checkCard(card);
        if (!card) return sendJson(res, 401, { error: { code: "CARD_UNKNOWN", message: verdict.message } }, corsHeaders());
        return sendJson(res, 200, Object.assign({ ok: verdict.ok, reason: verdict.ok ? null : verdict.message }, await usageOfCard(card)), corsHeaders());
      }
      /* 这个中转的语音能力：有哪些音色、一次多长。客户端用它渲染「设置 → 语音」，
       * 并且**只在真有语音时才把朗读相关的东西露出来**（没配就不显示，而不是点了没反应）。 */
      if (url.pathname === "/voice/info") {
        const card = await store.findByToken(bearer(req));
        const verdict = checkCard(card);
        if (!card) return sendJson(res, 401, { error: { code: "CARD_UNKNOWN", message: verdict.message } }, corsHeaders());
        const table = speakerTable();
        const usable = verdict.ok && tts.config.configured;
        return sendJson(res, 200, {
          ok: true,
          enabled: !!tts.config.configured,
          reason: tts.config.configured ? null : "这个中转还没配语音（服务端缺火山凭据）。",
          speakers: table.speakers.map((one) => ({
            id: one.id, label: one.label, lang: one.lang,
            // 界面按下拉分组显示（中文 / 英语 / 其他语言）—— 二百多个音色不分组根本没法挑。
            langLabel: one.langLabel || (one.lang === "en" ? "英语" : (one.lang === "zh" ? "中文" : "其他语言")),
            gender: one.gender, scene: one.scene,
          })),
          defaultSpeaker: table.defaultSpeaker,
          maxChars: voiceMaxChars,
          format: "mp3",
          canSpeakNow: usable,
          voiceLeft: Number.isFinite(verdict.voiceLeft) ? verdict.voiceLeft : null,
          voiceCharsLeft: Number.isFinite(verdict.voiceCharsLeft) ? verdict.voiceCharsLeft : null,
        }, corsHeaders());
      }
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(req, res, url);
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await handleChat(req, res);
      if (url.pathname === "/v1/audio/speech" && req.method === "POST") return await handleVoice(req, res);
      if (url.pathname === "/v1/models" && req.method === "GET") {
        const card = await store.findByToken(bearer(req));
        const verdict = checkCard(card);
        if (!verdict.ok) return sendJson(res, 401, { error: { code: verdict.code || "CARD_UNKNOWN", message: verdict.message } }, corsHeaders());
        const target = new URL(upstreamBase + upstreamModelsPath);
        return await new Promise((resolve) => {
          const upstreamReq = agentFor(target).request({ protocol: target.protocol, hostname: target.hostname, port: target.port || 443, path: target.pathname, method: "GET", headers: { Authorization: "Bearer " + upstreamKey } }, (upstreamRes) => {
            const chunks = [];
            upstreamRes.on("data", (chunk) => chunks.push(chunk));
            upstreamRes.on("end", () => {
              res.writeHead(upstreamRes.statusCode || 502, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders()));
              res.end(Buffer.concat(chunks));
              resolve();
            });
          });
          upstreamReq.on("error", (error) => { sendJson(res, 502, { error: { code: "UPSTREAM_UNREACHABLE", message: error.message } }, corsHeaders()); resolve(); });
          upstreamReq.end();
        });
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "没有这个接口：" + url.pathname } }, corsHeaders());
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: { code: "RELAY_ERROR", message: String(error && error.message || error) } }, corsHeaders());
      else { try { res.end(); } catch (_) {} }
    }
  });

  server.relay = {
    store, checkCard, checkVoiceCard, tts,
    voiceState: () => ({ running: voiceRunning, byCard: voiceRunningByCard.size }),
    speakers: () => speakerTable(),
    createCard: async (fields) => {
      const token = storeLib.randomToken();
      const card = storeLib.blankCard(Object.assign({ tokenHash: storeLib.hashToken(token) }, fields || {}));
      await store.save(card);
      return { card, token };
    },
  };
  return server;
}

module.exports = { createRelay, checkCard, checkVoiceCard, usageFromText, corsHeaders };
