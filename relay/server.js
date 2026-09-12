"use strict";

/*
 * relay/server.js —— 「体验卡」中转服务（OpenAI 兼容，SSE 透传）
 *
 * 为什么要有它：真 key 一旦发给同学，就等于给出去了、收不回来。所以真 key 只存在服务端，
 * 同学拿到的是一张**可限额、可到期、可随时吊销**的卡号。
 *
 * 路由：
 *   POST /v1/chat/completions   聊天（流式 / 非流式都透传）
 *   GET  /v1/models             模型清单（透传上游）
 *   GET  /card/quota            查这张卡还能用多少
 *   GET  /healthz               存活检查
 *   POST /admin/cards           发卡（需要 ADMIN_SECRET）
 *   GET  /admin/cards           列卡（不含卡号）
 *   POST /admin/cards/:id/disable | /enable
 *   DELETE /admin/cards/:id     吊销
 *
 * 两条硬规矩（写进代码，不靠自觉）：
 *   ① 不记正文：日志只有 时间/卡 id/模型/是否流式/耗时/用量，永远没有 messages 的内容。
 *   ② 卡的哈希入库：账本里存 sha256(token)，不存 token 本身。
 */

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const storeLib = require("./store.js");

const DEFAULT_UPSTREAM = "https://api.deepseek.com";
const DEFAULT_ALLOW_MODELS = [];      // 空 = 不限制
const CARD_HEADERS = ["x-rw-card-calls-left", "x-rw-card-tokens-left", "x-rw-card-expires", "x-rw-card-id"];

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
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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
  if (!card) return { ok: false, code: "CARD_UNKNOWN", message: "这张体验卡不认识：卡号可能抄错了，或者已经被收回。", callsLeft, tokensLeft };
  if (card.disabled) return { ok: false, code: "CARD_DISABLED", message: "这张体验卡已被停用。找发卡的人问问，或者换成自己的 API Key。", callsLeft, tokensLeft };
  if (card.expiresAt && Date.parse(card.expiresAt) < Date.now()) {
    return { ok: false, code: "CARD_EXPIRED", message: "这张体验卡已到期（" + card.expiresAt.slice(0, 10) + "）。", callsLeft, tokensLeft };
  }
  if (callsLeft <= 0) return { ok: false, code: "CARD_NO_CALLS", message: "这张体验卡的次数用完了（上限 " + card.quota.calls + " 次）。", callsLeft, tokensLeft };
  if (tokensLeft <= 0) return { ok: false, code: "CARD_NO_TOKENS", message: "这张体验卡的额度用完了（上限 " + card.quota.tokens + " token）。", callsLeft, tokensLeft };
  return { ok: true, callsLeft, tokensLeft };
}

function cardHeaders(card, verdict) {
  return {
    "x-rw-card-id": card.id,
    "x-rw-card-calls-left": Number.isFinite(verdict.callsLeft) ? String(verdict.callsLeft) : "unlimited",
    "x-rw-card-tokens-left": Number.isFinite(verdict.tokensLeft) ? String(verdict.tokensLeft) : "unlimited",
    "x-rw-card-expires": card.expiresAt || "never",
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
    };
  }

  async function recordUsage(card, usage) {
    const next = Object.assign({}, card, {
      used: {
        calls: Number(card.used.calls || 0) + 1,
        tokens: Number(card.used.tokens || 0) + (usage && usage.total ? usage.total : 0),
      },
      lastUsedAt: new Date().toISOString(),
    });
    await store.save(next);
    return next;
  }

  /* ---------------- 管理接口 ---------------- */

  async function handleAdmin(req, res, url) {
    if (!adminSecret) return sendJson(res, 503, { error: "服务端没有设置 ADMIN_SECRET，管理接口已关闭" }, corsHeaders());
    if (bearer(req) !== adminSecret) return sendJson(res, 401, { error: "管理口令不对" }, corsHeaders());
    const parts = url.pathname.split("/").filter(Boolean);   // admin/cards/:id/:action

    if (req.method === "GET" && parts.length === 2) {
      const cards = await store.list();
      return sendJson(res, 200, {
        cards: cards.map((card) => ({
          id: card.id, label: card.label, createdAt: card.createdAt, expiresAt: card.expiresAt,
          quota: card.quota, used: card.used, disabled: card.disabled, note: card.note,
          lastUsedAt: card.lastUsedAt || null,
        })),
      }, corsHeaders());
    }

    if (req.method === "POST" && parts.length === 2) {
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) { return sendJson(res, 400, { error: "请求体不是 JSON" }, corsHeaders()); }
      const calls = Math.max(0, Number(body.calls) || 0);
      const tokens = Math.max(0, Number(body.tokens) || 0);
      const days = Math.max(0, Number(body.days) || 0);
      const token = storeLib.randomToken();
      const card = storeLib.blankCard({
        tokenHash: storeLib.hashToken(token),
        label: String(body.label || "").slice(0, 60),
        note: String(body.note || "").slice(0, 200),
        expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
        quota: { calls, tokens },
      });
      await store.save(card);
      return sendJson(res, 200, {
        id: card.id,
        token,
        label: card.label,
        quota: card.quota,
        expiresAt: card.expiresAt,
        hint: "卡号只显示这一次，请立刻复制给对方（账本里只存哈希，找不回来）。",
      }, corsHeaders());
    }

    /* 上游自检：拿服务端的真 Key 打一次最小请求，把"配错了 Key / 路径不对 / 模型名不对"
     * 和"账本坏了"这两类问题分开。回复只回前 60 个字符，不落任何日志。 */
    if (req.method === "GET" && parts.length === 3 && parts[1] === "upstream" && parts[2] === "selftest") {
      if (!upstreamKey) return sendJson(res, 503, { ok: false, error: "服务端没有配置 UPSTREAM_KEY" }, corsHeaders());
      const model = String(url.searchParams.get("model") || allowModels[0] || "deepseek-flash");
      const target = new URL(upstreamBase + upstreamChatPath);
      const payload = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "只回复两个字：可用" }], max_tokens: 64, stream: false }), "utf8");
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
            try { reply = String(JSON.parse(text).choices[0].message.content || ""); } catch (_) {}
            resolve({ status: upstreamRes.statusCode || 0, reply: reply.slice(0, 60), body: reply ? "" : text.slice(0, 300) });
          });
        });
        request.on("error", (error) => resolve({ status: 0, error: error.message }));
        request.end(payload);
      });
      return sendJson(res, result.status === 200 ? 200 : 502, Object.assign({
        ok: result.status === 200, model, url: upstreamBase + upstreamChatPath, ms: Date.now() - startedAt,
      }, result), corsHeaders());
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay.local");
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); return res.end(); }
      if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, store: store.kind, storeAuth: storeLib.describeAuth(), upstream: upstreamBase.replace(/\/\/[^@]*@/, "//"), upstreamChatPath, upstreamKeySet: !!upstreamKey, adminEnabled: !!adminSecret, at: new Date().toISOString() }, corsHeaders());
      if (url.pathname === "/card/quota") {
        const card = await store.findByToken(bearer(req));
        const verdict = checkCard(card);
        if (!card) return sendJson(res, 401, { error: { code: "CARD_UNKNOWN", message: verdict.message } }, corsHeaders());
        return sendJson(res, 200, Object.assign({ ok: verdict.ok, reason: verdict.ok ? null : verdict.message }, await usageOfCard(card)), corsHeaders());
      }
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(req, res, url);
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await handleChat(req, res);
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

  server.relay = { store, checkCard, createCard: async (fields) => {
    const token = storeLib.randomToken();
    const card = storeLib.blankCard(Object.assign({ tokenHash: storeLib.hashToken(token) }, fields || {}));
    await store.save(card);
    return { card, token };
  } };
  return server;
}

module.exports = { createRelay, checkCard, usageFromText, corsHeaders };
