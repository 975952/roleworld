"use strict";

/*
 * Task-24 general assistant contract.
 *
 * This module is deliberately independent from task22-core.js: it never
 * accepts a character card, World Info, Memory Book, Harry chat, or role
 * system prompt. It only turns the device-local general session into the
 * minimal messages accepted by SillyTavern's custom backend proxy.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TASK24_ASSISTANT_CORE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const STORAGE_PREFIX = "task24.general-ai.v1";
  function storageKeyForUser(handle) {
    const safe = encodeURIComponent(String(handle || "unknown"));
    return `${STORAGE_PREFIX}.${safe}`;
  }
  const STORAGE_KEY = storageKeyForUser("admin");
  const GENERAL_SYSTEM_MESSAGE =
    "You are a neutral general-purpose AI assistant. Answer clearly, accurately, and helpfully. " +
    "Do not roleplay as a named character and do not assume hidden context.";
  const ISOLATION_SOURCES = Object.freeze({
    character: false,
    lore: false,
    memory: false,
    world: false,
    world_info: false,
    chat_history_from_harry: false,
    translation: false,
  });
  const SAMPLING = Object.freeze({
    temperature: 0.7,
    top_p: 0.9,
    top_k: 20,
    /* 本地模型：上限从 512 提到 4096，让模型自行以停止符收尾（本地 27B 生成较慢）。 */
    max_tokens: 4096,
  });
  /* 2026-09-09：通用 AI 支持两个后端 —— 本地模型（SillyTavern custom 代理）
   * 与 DeepSeek 官方 API（SillyTavern 内置 deepseek 源）。DeepSeek 模式下
   * 请求体只带模型名，密钥由服务端从加密 secrets 读取，绝不下发到浏览器。 */
  const MODES = Object.freeze({
    LOCAL: "local",
    DEEPSEEK_FLASH: "deepseek-v4-flash",
    DEEPSEEK_PRO: "deepseek-v4-pro",
    /* 2026-09-09 用户指定新增：灰测模型（ID 自带到期日 0910）。 */
    DEEPSEEK_V41_FLASH_PREVIEW: "deepseek-v4.1-flash-expires-on-0910",
  });
  const DEEPSEEK_MODES = Object.freeze([
    MODES.DEEPSEEK_FLASH,
    MODES.DEEPSEEK_PRO,
    MODES.DEEPSEEK_V41_FLASH_PREVIEW,
  ]);
  const DEEPSEEK_SECRET_KEY = "api_key_deepseek";
  const DEEPSEEK_SAMPLING = Object.freeze({
    temperature: 0.7,
    top_p: 0.9,
    /* DeepSeek V4 官方 MAX OUTPUT 为 384K；这里给 32768，正常回答由模型自行结束。 */
    max_tokens: 32768,
  });

  function cleanText(value, limit) {
    const text = String(value ?? "");
    return typeof limit === "number" && text.length > limit ? text.slice(0, limit) : text;
  }

  function sanitizeHistory(history, maxTurns) {
    const max = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : 24;
    if (!Array.isArray(history)) return [];
    return history
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .map((item) => ({ role: item.role, content: cleanText(item.content, 16000) }))
      .filter((item) => item.content.length > 0)
      .slice(-max);
  }

  function buildMessages(history, userText) {
    const content = cleanText(userText, 16000).trim();
    if (!content) throw new Error("empty message");
    return [
      { role: "system", content: GENERAL_SYSTEM_MESSAGE },
      ...sanitizeHistory(history),
      { role: "user", content },
    ];
  }

  function isDeepSeekMode(mode) {
    return DEEPSEEK_MODES.indexOf(mode) >= 0;
  }

  function buildGeneratePayload(options) {
    const opts = options || {};
    const mode = String(opts.mode || MODES.LOCAL);
    const stream = opts.stream !== false;
    if (isDeepSeekMode(mode)) {
      const payload = {
        messages: buildMessages(opts.history, opts.userText),
        model: mode,
        chat_completion_source: "deepseek",
        stream: stream,
        ...DEEPSEEK_SAMPLING,
        task24_mode: "general-assistant",
        task24_context_sources: Object.assign({}, ISOLATION_SOURCES),
      };
      // 思考模式：SillyTavern 会翻译成 DeepSeek 的 thinking/reasoning_effort。
      if (opts.thinking) {
        payload.include_reasoning = true;
        payload.reasoning_effort = "high";
      }
      return payload;
    }
    const customUrl = String(opts.customUrl || "").trim();
    if (!customUrl) throw new Error("custom backend unavailable");
    return {
      messages: buildMessages(opts.history, opts.userText),
      model: "local",
      chat_completion_source: "custom",
      custom_url: customUrl,
      custom_include_body: "chat_template_kwargs:\n  enable_thinking: false",
      stream: stream,
      ...SAMPLING,
      task24_mode: "general-assistant",
      task24_context_sources: Object.assign({}, ISOLATION_SOURCES),
    };
  }

  function parseGenerateResponse(value) {
    const choice = value && Array.isArray(value.choices) ? value.choices[0] : null;
    const message = choice && choice.message;
    return {
      content: message && typeof message.content === "string" ? message.content : "",
      finish_reason: choice && choice.finish_reason ? choice.finish_reason : null,
    };
  }

  function deriveTitle(value) {
    const compact = cleanText(value, 80).replace(/\s+/g, " ").trim();
    return compact ? compact.slice(0, 32) : "新对话";
  }

  function isGeneralSession(value) {
    return !!(value && value.kind === "task24-general" && Array.isArray(value.messages));
  }

  function normalizeArchivedAt(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function normalizeGeneralSession(value, fallbackNow) {
    if (!isGeneralSession(value)) return null;
    const now = String(fallbackNow || new Date().toISOString());
    return {
      id: cleanText(value.id || "", 96),
      kind: "task24-general",
      title: deriveTitle(value.title || "新对话"),
      createdAt: String(value.createdAt || now),
      updatedAt: String(value.updatedAt || value.createdAt || now),
      archivedAt: normalizeArchivedAt(value.archivedAt),
      messages: sanitizeHistory(value.messages, 80),
    };
  }

  function isEmptyGeneralSession(value) {
    return !!value && sanitizeHistory(value.messages, 80).length === 0;
  }

  function sortGeneralSessions(values) {
    return (Array.isArray(values) ? values.slice() : []).sort((a, b) => {
      if (!!a.archivedAt !== !!b.archivedAt) return a.archivedAt ? 1 : -1;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  }

  function chooseActiveGeneralId(values, preferredId) {
    const active = (Array.isArray(values) ? values : []).filter((item) => item && !item.archivedAt);
    const preferred = active.find((item) => item.id === preferredId);
    return (preferred || active[0] || {}).id || "";
  }

  return {
    STORAGE_KEY,
    STORAGE_PREFIX,
    storageKeyForUser,
    GENERAL_SYSTEM_MESSAGE,
    ISOLATION_SOURCES,
    SAMPLING,
    MODES,
    DEEPSEEK_MODES,
    DEEPSEEK_SECRET_KEY,
    DEEPSEEK_SAMPLING,
    isDeepSeekMode,
    cleanText,
    sanitizeHistory,
    buildMessages,
    buildGeneratePayload,
    parseGenerateResponse,
    deriveTitle,
    isGeneralSession,
    normalizeArchivedAt,
    normalizeGeneralSession,
    isEmptyGeneralSession,
    sortGeneralSessions,
    chooseActiveGeneralId,
  };
});
