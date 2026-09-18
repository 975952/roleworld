"use strict";

/*
 * relay/tts.js —— 火山引擎「豆包语音合成模型 2.0」的上游客户端（只在中转服务端跑）
 *
 * 为什么单独一个文件：这一段是**唯一**接触火山凭据的地方，凭据只从环境变量读，
 * 不落盘、不回显、不进日志。客户端永远拿到的是音频，不是 Key。
 *
 * 用的是官方 **HTTP 单向流式**（不是 OpenAI 的 /audio/speech，也不兼容它）：
 *
 *   POST {base}/api/v3/tts/unidirectional
 *   Header（两套控制台鉴权，二选一，见 voiceConfig()）：
 *     新版控制台：X-Api-Key: <API Key>                       + X-Api-Resource-Id
 *     旧版控制台：X-Api-App-Id: <App ID> + X-Api-Access-Key: <Access Token>
 *     两者都要：X-Api-Resource-Id: seed-tts-2.0   ← 「豆包语音合成模型 2.0」的资源标识
 *     可选：    X-Api-Request-Id（每次一个 uuid，排障用）
 *               X-Control-Require-Usage-Tokens-Return: *（回报计费字数）
 *     ⚠ X-Api-Connect-Id 是 **WebSocket** 那个接口的头，HTTP 这条不要发。
 *   Body:
 *     { "user": { "uid": "…" },
 *       "req_params": { "text": "…", "speaker": "zh_female_…_uranus_bigtts",
 *                       "audio_params": { "format": "mp3", "sample_rate": 24000, "speech_rate": 0 } } }
 *   响应：**一行一个 JSON**（HTTP Chunked），音频是 base64，不是二进制帧协议：
 *     {"code":0,"message":"","data":"<base64 音频>"}
 *     …
 *     {"code":20000000,"message":"ok","data":null,"usage":{"text_words":10}}
 *     出错：{"code":<非 0 且非 20000000>,"message":"…"}
 *   响应头只有一个值得留的：X-Tt-Logid（排障用）。
 *
 * 事实来源（2026-09-14 核对）：
 *   - 官方文档：https://www.volcengine.com/docs/6561/2532486 （TTS 2.0）
 *   - 官方 HTTP Chunked/SSE 单向流式页：https://docs.volcengine.com/docs/6561/1598757
 *     （用 `?lang=zh&__ssrDirect=true` 能看到服务端渲染的正文）
 *   - 逐字段对照的实现：https://github.com/GizClaw/doubao-speech-go（tts_v2.go / internal/auth/v2.go）
 *   资源标识与音色的对应关系：seed-tts-2.0 对应 `*_uranus_bigtts` 音色；
 *   对不上时上游会回 `55000000 resource ID is mismatched with speaker related resource`。
 *
 * **没有真凭据时这里的一切都不会被调用**：本文件不做任何自检联网请求，
 * 配置是否存在只由 voiceConfig() 汇报（见 server.js 的 /admin/voice/config）。
 */

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const DEFAULT_BASE = "https://openspeech.bytedance.com";
const DEFAULT_PATH = "/api/v3/tts/unidirectional";
/** 「豆包语音合成模型 2.0」的资源标识。1.0 是 seed-tts-1.0，别混用。 */
const RESOURCE_TTS_2_0 = "seed-tts-2.0";
const DEFAULT_MODEL = "seed-tts-2.0-standard";
/** 上游表示"这一路合成结束"的 code，不是错误。 */
const CODE_STREAM_DONE = 20000000;

const FORMAT_MIME = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
  ogg_opus: "audio/ogg",
};

function mimeFor(format) {
  return FORMAT_MIME[String(format || "mp3").toLowerCase()] || "application/octet-stream";
}

/** 上游的 code 翻成人话（能查到的写死，查不到的原样带出来）。 */
function describeUpstreamCode(code, message) {
  const detail = String(message || "").trim();
  if (detail) return detail;
  const table = {
    20000000: "上游表示合成结束（这不是错误）。",
    45000000: "上游拒绝了这次请求：多半是这个音色没在账号里开通（speaker permission denied），或者并发超了。",
    45000001: "上游说请求参数不合法（检查音色与语速的取值范围）。",
    40402003: "文本超长：上游一次能合成的字数有上限。",
    55000000: "资源标识与音色不匹配（seed-tts-2.0 必须配 *_uranus_bigtts 音色），或上游通用错误。",
    55000001: "上游会话错误。",
    40100000: "火山上游鉴权失败（检查服务端的 App ID / Access Token / API Key 是否配错、停用或与资源标识不是同一个控制台）。",
  };
  return table[Number(code)] || ("上游返回 code " + code);
}

function readEnv(env, key) {
  return String((env || process.env)[key] || "").trim();
}

/** 中转服务端到底配没配语音能力（只看环境变量，不联网、不打日志里的值）。 */
function voiceConfig(env) {
  const source = env || process.env;
  const appId = readEnv(source, "VOLC_TTS_APP_ID");
  const accessKey = readEnv(source, "VOLC_TTS_ACCESS_KEY");
  const apiKey = readEnv(source, "VOLC_TTS_API_KEY");
  const base = (readEnv(source, "VOLC_TTS_BASE") || DEFAULT_BASE).replace(/\/+$/, "");
  const path = readEnv(source, "VOLC_TTS_PATH") || DEFAULT_PATH;

  /*
   * 鉴权有三套写法，选哪套取决于控制台是新版还是旧版，我们**不猜**：
   *   key       新版控制台：X-Api-Key
   *   appid     旧版控制台：X-Api-App-Id + X-Api-Access-Key
   *   hybrid    App ID + X-Api-Key（部分 SDK 这么发；只能显式打开，不要默认混发）
   * 两套都配了就优先新版（X-Api-Key），并把这件事报出来（admin/voice/config 里能看到）。
   */
  const forced = readEnv(source, "VOLC_TTS_AUTH").toLowerCase();
  let authMode = "";
  if (forced === "key" || forced === "appid" || forced === "hybrid") authMode = forced;
  else if (apiKey) authMode = "key";
  else if (appId && accessKey) authMode = "appid";
  else if (appId && apiKey) authMode = "hybrid";

  const missing = [];
  if (authMode === "key" && !apiKey) missing.push("VOLC_TTS_API_KEY");
  if (authMode === "appid") {
    if (!appId) missing.push("VOLC_TTS_APP_ID");
    if (!accessKey) missing.push("VOLC_TTS_ACCESS_KEY");
  }
  if (authMode === "hybrid") {
    if (!appId) missing.push("VOLC_TTS_APP_ID");
    if (!apiKey) missing.push("VOLC_TTS_API_KEY");
  }
  if (!authMode) missing.push("VOLC_TTS_API_KEY（新版控制台）或 VOLC_TTS_APP_ID + VOLC_TTS_ACCESS_KEY（旧版控制台）");

  return {
    appId, accessKey, apiKey, authMode,
    base,
    path,
    resourceId: readEnv(source, "VOLC_TTS_RESOURCE_ID") || RESOURCE_TTS_2_0,
    model: readEnv(source, "VOLC_TTS_MODEL") || DEFAULT_MODEL,
    // configured 只表示"凭据在不在"，不表示"账号能不能用"（那要真调一次才知道，属付费操作）。
    configured: missing.length === 0,
    missing,
  };
}

/** 按选定的鉴权方式拼请求头。凭据只进请求头，既不进 URL 也不进日志。 */
function authHeaders(config) {
  const headers = { "X-Api-Resource-Id": config.resourceId };
  if (config.authMode === "key") {
    headers["X-Api-Key"] = config.apiKey;
  } else if (config.authMode === "appid") {
    headers["X-Api-App-Id"] = config.appId;
    headers["X-Api-Access-Key"] = config.accessKey;
  } else {
    // hybrid
    headers["X-Api-App-Id"] = config.appId;
    headers["X-Api-Key"] = config.apiKey;
  }
  return headers;
}

/** 按行切 NDJSON。上游是流式的，一行可能被 TCP 拆开，所以必须缓冲。 */
function createLineReader(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line.trim());
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      if (rest) onLine(rest);
    },
  };
}

function createTtsClient(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const config = Object.assign(voiceConfig(env), opts.override || {});
  const timeoutMs = Number(opts.timeoutMs || env.VOICE_TIMEOUT_MS) || 30000;
  const agentFor = (url) => (url.protocol === "https:" ? https : http);

  /**
   * 合成一段文字。返回：
   *   { ok: true, audio: Buffer, contentType, format, ms, logId }
   *   { ok: false, code, message, status, logId }
   * 不抛异常（调用方是 HTTP 处理器，抛出去只会变成 500 说不清原因）。
   */
  function synthesize(request, runOptions) {
    const run = runOptions || {};
    const text = String(request && request.text || "");
    const speaker = String(request && request.speaker || "");
    const format = String((request && request.format) || "mp3").toLowerCase();
    const sampleRate = Number(request && request.sample_rate) || 24000;
    const started = Date.now();

    if (!config.configured) {
      return Promise.resolve({
        ok: false, code: "RELAY_NO_VOICE_KEY", status: 0,
        message: "中转服务端没有配置火山语音凭据（缺 " + config.missing.join(" / ") + "）。",
      });
    }

    const requestId = crypto.randomUUID();
    const body = {
      user: { uid: String(run.uid || "roleworld") },
      req_params: {
        text,
        speaker,
        audio_params: { format, sample_rate: sampleRate },
      },
    };
    const audioParams = body.req_params.audio_params;
    // bit_rate 一定要**显式给**：官方文档说 mp3 默认可以在 64000–160000 之间，
    // 但不给的时候实测有效值可能低到 ~8k（听得出明显发闷）。官方示例自己发的是 64000。
    audioParams.bit_rate = Math.max(64000, Math.min(160000,
      Math.round(Number(request && request.bit_rate) || 0) || Number(env.VOLC_TTS_BIT_RATE) || 64000));
    if (request && request.speech_rate !== undefined && request.speech_rate !== null) {
      audioParams.speech_rate = Math.max(-50, Math.min(100, Math.round(Number(request.speech_rate) || 0)));
    }
    if (request && request.loudness_rate !== undefined && request.loudness_rate !== null) {
      audioParams.loudness_rate = Math.max(-50, Math.min(100, Math.round(Number(request.loudness_rate) || 0)));
    }
    if (config.model) body.req_params.model = config.model;
    if (request && request.additions) body.req_params.additions = String(request.additions);

    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const target = new URL(config.base + config.path);
    const headers = Object.assign({
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      "X-Api-Request-Id": requestId,
      // 让上游回报"这次算了多少字"（计费口径），我们用它记账；不给也能用字数兜底。
      "X-Control-Require-Usage-Tokens-Return": "*",
    }, authHeaders(config));

    return new Promise((resolve) => {
      const chunks = [];
      let settled = false;
      let billedChars = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const upstreamReq = agentFor(target).request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers,
      }, (upstreamRes) => {
        const logId = upstreamRes.headers["x-tt-logid"] || upstreamRes.headers["x-tt-logid".toLowerCase()] || "";
        const status = upstreamRes.statusCode || 0;
        if (status < 200 || status >= 300) {
          const body_ = [];
          upstreamRes.on("data", (chunk) => body_.push(chunk));
          upstreamRes.on("end", () => {
            const raw = Buffer.concat(body_).toString("utf8");
            let code = "UPSTREAM_HTTP_" + status;
            let message = "";
            try {
              const parsed = JSON.parse(raw);
              const inner = parsed && (parsed.error || parsed);
              code = Number(inner && inner.code) || code;
              message = String((inner && (inner.message || inner.msg)) || "").slice(0, 300);
            } catch (_) { message = raw.slice(0, 300); }
            finish({
              ok: false, code, status, logId, ms: Date.now() - started,
              message: describeUpstreamCode(code, message) || ("上游返回 HTTP " + status),
            });
          });
          return;
        }

        const reader = createLineReader((line) => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(line); } catch (_) { return; }   // 非 JSON 行直接忽略（保持宽容）
          const code = Number(parsed.code);
          if (code === CODE_STREAM_DONE) {
            reader.flush();
            finish({
              ok: chunks.length > 0, audio: Buffer.concat(chunks), contentType: mimeFor(format), format,
              ms: Date.now() - started, logId, chars: billedChars || text.length, requestId,
              code: chunks.length > 0 ? 0 : "UPSTREAM_EMPTY",
              message: chunks.length > 0 ? "" : "上游说合成结束了，但一个字节的音频都没给。",
            });
            return;
          }
          if (code !== 0 && Number.isFinite(code)) {
            finish({
              ok: false, code, status, logId, ms: Date.now() - started,
              message: describeUpstreamCode(code, parsed.message),
            });
            return;
          }
          if (parsed.usage && Number(parsed.usage.text_words)) billedChars = Number(parsed.usage.text_words);
          if (typeof parsed.data === "string" && parsed.data) {
            const audio = Buffer.from(parsed.data, "base64");
            if (audio.length) chunks.push(audio);
          }
          if (parsed.done === true) {
            // 少数实现把 done 放在没有 code 的行上：同样按结束处理。
            finish({
              ok: chunks.length > 0, audio: Buffer.concat(chunks), contentType: mimeFor(format), format,
              ms: Date.now() - started, logId, chars: billedChars || text.length, requestId,
              code: chunks.length > 0 ? 0 : "UPSTREAM_EMPTY",
              message: chunks.length > 0 ? "" : "上游说合成结束了，但一个字节的音频都没给。",
            });
          }
        });

        upstreamRes.on("data", (chunk) => reader.push(chunk.toString("utf8")));
        upstreamRes.on("end", () => {
          reader.flush();
          // 没有明确结束帧就断了：有音频就先用，没有才算失败。
          finish(chunks.length > 0
            ? { ok: true, audio: Buffer.concat(chunks), contentType: mimeFor(format), format, ms: Date.now() - started, logId, chars: billedChars || text.length, requestId, truncated: true }
            : { ok: false, code: "UPSTREAM_NO_AUDIO", status, logId, ms: Date.now() - started, message: "上游连接结束了，但没有收到音频。" });
        });
        upstreamRes.on("error", (error) => {
          finish({ ok: false, code: "UPSTREAM_STREAM_ERROR", status, logId, ms: Date.now() - started, message: "读取上游音频流失败：" + error.message });
        });
      });

      const timer = setTimeout(() => {
        try { upstreamReq.destroy(new Error("timeout")); } catch (_) { /* 已经结束 */ }
        finish({ ok: false, code: "VOICE_TIMEOUT", status: 0, ms: Date.now() - started, message: "上游合成超时（" + timeoutMs + "ms）。" });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const onAbort = () => {
        try { upstreamReq.destroy(new Error("aborted")); } catch (_) { /* 已经结束 */ }
        finish({ ok: false, code: "VOICE_CANCELED", status: 0, ms: Date.now() - started, message: "这一路合成被取消了。" });
      };
      if (run.signal) {
        if (run.signal.aborted) { clearTimeout(timer); onAbort(); return; }
        run.signal.addEventListener("abort", onAbort, { once: true });
      }

      upstreamReq.on("error", (error) => {
        clearTimeout(timer);
        const timeout = /timeout/i.test(error.message || "");
        finish({
          ok: false,
          code: timeout ? "VOICE_TIMEOUT" : "UPSTREAM_UNREACHABLE",
          status: 0, ms: Date.now() - started,
          message: timeout ? ("上游合成超时（" + timeoutMs + "ms）。") : ("连不上语音上游：" + error.message),
        });
      });
      upstreamReq.on("close", () => clearTimeout(timer));

      upstreamReq.end(payload);
    });
  }

  return { config, synthesize, timeoutMs };
}

module.exports = {
  createTtsClient,
  voiceConfig,
  authHeaders,
  describeUpstreamCode,
  mimeFor,
  RESOURCE_TTS_2_0,
  DEFAULT_MODEL,
  CODE_STREAM_DONE,
  DEFAULT_BASE,
  DEFAULT_PATH,
};
