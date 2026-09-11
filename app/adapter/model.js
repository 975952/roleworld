"use strict";

/*
 * adapter/model.js —— 直接调用 OpenAI 兼容的对话补全接口
 *
 * 这个文件取代了 SillyTavern 后端代理：
 * 浏览器/桌面端直接向模型服务商发请求，不再经过任何中转服务器。
 *
 * 已验证：api.deepseek.com 对浏览器跨域请求返回
 *   access-control-allow-origin: <请求方 Origin>
 *   access-control-allow-headers: authorization,content-type
 * 因此纯前端网站可以直接调用，不需要代理。桌面端（Tauri）走原生请求，不受 CORS 限制。
 *
 * 关键约定：流式请求返回**原始 fetch Response**，调用方可以直接
 * `response.body.getReader()` 读 SSE —— 与原来 SillyTavern 代理的行为一致，
 * 上层页面代码不需要改动。
 */

(function (global) {
  const PRESETS = {
    deepseek: {
      label: "DeepSeek 官方",
      endpoint: "https://api.deepseek.com/chat/completions",
      secretKey: "api_key_deepseek",
      // Official catalog checked 2026-09-11: https://api-docs.deepseek.com/updates/
      models: ["deepseek-flash", "deepseek-v4-pro"],
    },
    openai: {
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      secretKey: "api_key_openai",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    },
    openrouter: {
      label: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      secretKey: "api_key_openrouter",
      models: [],
    },
    siliconflow: {
      label: "硅基流动",
      endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      secretKey: "api_key_siliconflow",
      models: [],
    },
    custom: {
      label: "自定义云端服务",
      endpoint: "",
      secretKey: "api_key_custom",
      models: [],
    },
  };

  const DEFAULT_SETTINGS = {
    provider: "deepseek",
    model: "deepseek-flash",
    endpoint: "",
    stream: true,
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 32768,
  };

  function endpointFor(settings) {
    const chosen = settings || {};
    if (chosen.endpoint) return String(chosen.endpoint);
    const preset = PRESETS[chosen.provider] || PRESETS.deepseek;
    return preset.endpoint;
  }

  function secretKeyFor(settings) {
    const chosen = settings || {};
    const preset = PRESETS[chosen.provider] || PRESETS.deepseek;
    return preset.secretKey;
  }

  // 由端点反查服务商。
  // 页面会把自定义端点标成 "custom"，并把当前端点塞进 custom_url —— 如果用户其实配的是 DeepSeek 官方端点，只按 "custom" 去找密钥就会拿到
  // 空 Key，请求带着 401 回来（AI 写角色就是这么失败的）。所以先看端点认不认得。
  function providerForEndpoint(url) {
    const target = String(url || "").trim().replace(/\/+$/, "").toLowerCase();
    if (!target) return "";
    for (const id of Object.keys(PRESETS)) {
      if (PRESETS[id].endpoint.replace(/\/+$/, "").toLowerCase() === target) return id;
    }
    return "";
  }

  /* ------------------------------------------------------------------ *
   * 请求体
   * ------------------------------------------------------------------ */

  const SAMPLING_FIELDS = [
    "temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens",
    "frequency_penalty", "presence_penalty", "stop", "seed", "logprobs", "top_logprobs",
  ];

  // 不是采样参数，但必须原样透传给模型接口的字段。
  // include_reasoning 尤其重要：它决定接口回不回 reasoning_content（思考过程）。
  // 注意别把本机设置里的 thinking 布尔值放进来 —— 那会把 "thinking" 当成接口参数发出去。
  const PASSTHROUGH_FIELDS = [
    "include_reasoning", "reasoning_effort", "response_format", "tool_choice", "tools",
  ];

  // 把 SillyTavern 风格的 generate 载荷翻译成 OpenAI Chat Completions 请求体。
  function buildBody(payload) {
    const source = payload || {};
    const settings = source.settings || {};
    const body = {
      model: source.model || settings.model || DEFAULT_SETTINGS.model,
      messages: Array.isArray(source.messages) ? source.messages : [],
      stream: source.stream === true,
    };
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings, source);
    SAMPLING_FIELDS.forEach((field) => {
      const value = merged[field];
      if (value === undefined || value === null || value === "") return;
      if (field === "max_tokens" || field === "max_completion_tokens") {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) body.max_tokens = Math.floor(number);
        return;
      }
      if (field === "stop" && Array.isArray(value) && value.length === 0) return;
      body[field] = value;
    });
    if (body.stream) {
      // 要 include_usage 才会在最后一段 SSE 里带上 token 用量，
      // 否则只能靠字数估算（这是"估算对话价格"的数据来源）。
      body.stream_options = { include_usage: true };
    }
    PASSTHROUGH_FIELDS.forEach((field) => {
      const value = merged[field];
      if (value === undefined || value === null || value === "") return;
      body[field] = value;
    });
    return body;
  }

  function buildHeaders(settings, apiKey) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    const provider = (settings && settings.provider) || DEFAULT_SETTINGS.provider;
    if (provider === "openrouter") {
      // OpenRouter 建议（非必须）带上来源标识。
      headers["HTTP-Referer"] = global.location ? global.location.origin : "https://roleworld.local";
      headers["X-Title"] = "RoleWorld";
    }
    return headers;
  }

  /* ------------------------------------------------------------------ *
   * 调用
   * ------------------------------------------------------------------ */

  // 返回原始 Response。流式与非流式都走这一条路径，由调用方决定怎么读。
  function request(payload, options) {
    const opts = options || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, opts.settings || payload && payload.settings || {});
    const url = opts.endpoint || endpointFor(settings);
    const apiKey = opts.apiKey !== undefined ? opts.apiKey : null;
    const init = {
      method: "POST",
      headers: buildHeaders(settings, apiKey),
      body: JSON.stringify(buildBody(Object.assign({}, payload, { settings }))),
    };
    if (opts.signal) init.signal = opts.signal;
    return fetch(url, init).then((response) => {
      if (response.ok) return response;
      return response.text().then(
        (text) => {
          let detail = text;
          try {
            const parsed = JSON.parse(text);
            detail = (parsed.error && (parsed.error.message || parsed.error.code)) || parsed.message || text;
          } catch (_) { /* 保留原始文本 */ }
          const error = new Error("模型接口返回 HTTP " + response.status + "：" + String(detail).slice(0, 300));
          error.status = response.status;
          throw error;
        },
        () => {
          const error = new Error("模型接口返回 HTTP " + response.status);
          error.status = response.status;
          throw error;
        }
      );
    });
  }

  // 非流式调用：返回 { content, reasoning, model, usage }。
  async function complete(payload, options) {
    const response = await request(Object.assign({}, payload, { stream: false }), options);
    const data = await response.json();
    const choice = (data.choices && data.choices[0]) || {};
    const message = choice.message || {};
    return {
      content: message.content || "",
      reasoning: message.reasoning_content || message.reasoning || "",
      model: data.model || "",
      finish_reason: choice.finish_reason || "",
      usage: data.usage || null,
      raw: data,
    };
  }

  // 流式调用：逐段回调 onDelta(text, meta)。返回 { content, reasoning, model }。
  // 服务端可能忽略 stream 参数直接返回一整段 JSON —— 这里按响应类型自动分流。
  async function streamComplete(payload, options) {
    const opts = options || {};
    const onDelta = typeof opts.onDelta === "function" ? opts.onDelta : function () {};
    const response = await request(Object.assign({}, payload, { stream: true }), opts);
    const contentType = String(response.headers && response.headers.get
      ? response.headers.get("content-type") || ""
      : "").toLowerCase();
    const canStream = !!(response.body && typeof response.body.getReader === "function");

    if (!canStream || (contentType && !contentType.includes("event-stream"))) {
      return emitWhole(await response.text(), onDelta);
    }

    const reader = response.body.getReader();
    const decoder = new global.TextDecoder("utf-8");
    let buffer = "";
    let raw = "";
    let content = "";
    let reasoning = "";
    let model = "";
    let sawEvent = false;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const text = decoder.decode(step.value, { stream: true });
      raw += text;
      buffer += text;
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      for (const part of parts) {
        for (const event of parseSseBlock(part)) {
          sawEvent = true;
          if (event === "[DONE]") {
            onDelta("", { done: true });
            continue;
          }
          const parsed = parseMaybeJson(event);
          if (!parsed) continue;
          if (parsed.model) model = parsed.model;
          const choice = parsed.choices && parsed.choices[0];
          if (!choice) continue;
          const delta = choice.delta || choice.message || {};
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            onDelta("", { reasoning: delta.reasoning_content, done: false });
          }
          if (delta.content) {
            content += delta.content;
            onDelta(delta.content, { done: false });
          }
        }
      }
    }
    // 没有任何 SSE 事件，却读到了 JSON 正文：说明对端其实没有走流式。
    if (!sawEvent && raw.trim()) {
      const fallback = emitWhole(raw, onDelta);
      return fallback;
    }
    onDelta("", { done: true });
    return { content, reasoning, model };
  }

  // 把“本该流式却整段返回”的响应整理成同样的返回值。
  function emitWhole(text, onDelta) {
    const parsed = parseMaybeJson(text);
    const choice = parsed && parsed.choices && parsed.choices[0];
    const message = (choice && (choice.message || choice.delta)) || {};
    const content = message.content || (parsed ? "" : String(text || ""));
    const reasoning = message.reasoning_content || message.reasoning || "";
    if (content) onDelta(content, { done: false });
    if (reasoning) onDelta("", { reasoning, done: false });
    onDelta("", { done: true });
    return { content, reasoning, model: (parsed && parsed.model) || "" };
  }

  function parseSseBlock(block) {
    const events = [];
    for (const rawLine of String(block).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) events.push(data);
    }
    return events;
  }

  function parseMaybeJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  const Model = {
    PRESETS,
    DEFAULT_SETTINGS,
    endpointFor,
    secretKeyFor,
    providerForEndpoint,
    buildBody,
    buildHeaders,
    request,
    complete,
    streamComplete,
    parseSseBlock,
  };

  global.RoleWorldModel = Model;
  if (typeof module !== "undefined" && module.exports) module.exports = Model;
})(typeof globalThis !== "undefined" ? globalThis : this);
