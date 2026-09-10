"use strict";

/*
 * adapter/pricing.js —— token 用量与费用估算
 *
 * 价格随官方调整会变，所以这里的表只是**默认值**，用户可以在「设置 → 模型」里改。
 *
 * 2026-09-10 12:00 起生效的 DeepSeek 官方价（元 / 百万 token），峰谷分时：
 *   Flash 系列      闲时 命中 0.02 | 未命中 1 | 输出 4      高峰 ×2
 *   V4 Pro          闲时 命中 0.15 | 未命中 4.5 | 输出 13.5  高峰 ×2
 * 高峰 = 北京时间周一至周五 9:00-12:00 与 14:00-18:00，其余（含周末与节假日）为闲时。
 *
 * 注意：脚本运行在用户本机，时区不一定是北京，所以峰谷判断一律按 UTC+8 换算，
 * 不能用本地时间。
 */

(function (global) {
  const CNY = "CNY";

  const DEFAULT_TABLE = [
    {
      match: /(^|[-_/])v?4\.1[-_.]?flash|v4\.1.*flash/i,
      label: "DeepSeek V4.1 Flash",
      off: { cacheHit: 0.02, input: 1, output: 4 },
    },
    {
      match: /flash/i,
      label: "DeepSeek Flash 系列",
      off: { cacheHit: 0.02, input: 1, output: 4 },
    },
    {
      match: /v?4[-_.]?pro|reasoner/i,
      label: "DeepSeek V4 Pro / Reasoner",
      off: { cacheHit: 0.15, input: 4.5, output: 13.5 },
    },
    {
      match: /deepseek[-_]?chat/i,
      label: "DeepSeek Chat",
      off: { cacheHit: 0.02, input: 1, output: 4 },
    },
  ];

  // 用不到的模型（OpenAI / OpenRouter / 本地）没有公开统一价，交给用户自己填。

  /* ------------------------------------------------------------------ *
   * 峰谷时段
   * ------------------------------------------------------------------ */

  const PEAK_RANGES = [[9, 12], [14, 18]]; // 北京时间

  function beijingParts(when) {
    const date = when instanceof Date ? when : new Date(when || Date.now());
    const beijing = new Date(date.getTime() + (480 + date.getTimezoneOffset()) * 60000);
    return { weekday: beijing.getDay(), hour: beijing.getHours() + beijing.getMinutes() / 60 };
  }

  function isPeak(when) {
    const { weekday, hour } = beijingParts(when);
    if (weekday === 0 || weekday === 6) return false;
    return PEAK_RANGES.some(([from, to]) => hour >= from && hour < to);
  }

  function periodLabel(when) {
    return isPeak(when) ? "高峰" : "闲时";
  }

  /* ------------------------------------------------------------------ *
   * 价格
   * ------------------------------------------------------------------ */

  function defaultPrices(model) {
    const name = String(model || "");
    for (const row of DEFAULT_TABLE) {
      if (row.match.test(name)) return { label: row.label, off: row.off, matched: true };
    }
    return { label: "自定义（未内置价格）", off: { cacheHit: 0, input: 0, output: 0 }, matched: false };
  }

  /**
   * 取某个模型在某一时刻的单价（元 / 百万 token）。
   * @param {string} model 模型名
   * @param {object} override 用户在设置里填的覆盖值 {input, output}
   * @param {Date} when 计费时刻
   */
  function pricesFor(model, override, when) {
    const preset = defaultPrices(model);
    const custom = override || {};
    const hasCustom = Number(custom.input) > 0 || Number(custom.output) > 0;
    const base = {
      cacheHit: hasCustom ? Number(custom.input || 0) : preset.off.cacheHit,
      input: hasCustom ? Number(custom.input || 0) : preset.off.input,
      output: hasCustom ? Number(custom.output || 0) : preset.off.output,
    };
    const multiplier = hasCustom ? 1 : (isPeak(when) ? 2 : 1);
    return {
      label: hasCustom ? "自定义单价" : preset.label,
      period: periodLabel(when),
      multiplier,
      cacheHit: base.cacheHit * multiplier,
      input: base.input * multiplier,
      output: base.output * multiplier,
      currency: CNY,
    };
  }

  /* ------------------------------------------------------------------ *
   * token 估算（接口没回 usage 时的兜底）
   * ------------------------------------------------------------------ */

  // 粗估：中日韩字符约 0.6 token/字，其余（英文、数字、符号）约 4 字符/token。
  // 这只是量级估计，接口回了 usage 就一律用真实值。
  function estimateTokens(text) {
    const value = String(text || "");
    let cjk = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
        cjk += 1;
      }
    }
    const others = value.length - cjk;
    return Math.max(1, Math.round(cjk * 0.6 + others / 4));
  }

  function tokensFromMessages(messages) {
    return (Array.isArray(messages) ? messages : []).reduce(
      (sum, message) => sum + estimateTokens(message && message.content) + 4,
      0
    );
  }

  /** 由 usage（优先）或文本长度（兜底）算出一次调用的用量。 */
  function usageOf(options) {
    const opts = options || {};
    const usage = opts.usage || null;
    const exact = !!(usage && (usage.prompt_tokens || usage.completion_tokens));
    const input = exact ? Number(usage.prompt_tokens || 0) : tokensFromMessages(opts.messages);
    const output = exact ? Number(usage.completion_tokens || 0) : estimateTokens(opts.reply);
    const cacheHit = exact ? Number((usage.prompt_cache_hit_tokens || usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0) : 0;
    return {
      input,
      output,
      cacheHit: Math.min(cacheHit, input),
      exact,
    };
  }

  /** 估算一次调用的费用（元）。 */
  function costOf(usage, prices) {
    const priced = prices || pricesFor("", null, new Date());
    const million = 1000000;
    const missedInput = Math.max(0, (usage.input || 0) - (usage.cacheHit || 0));
    const value =
      (missedInput / million) * priced.input +
      ((usage.cacheHit || 0) / million) * priced.cacheHit +
      ((usage.output || 0) / million) * priced.output;
    return value;
  }

  /* ------------------------------------------------------------------ *
   * 展示
   * ------------------------------------------------------------------ */

  function formatTokens(count) {
    const value = Number(count) || 0;
    if (value >= 1000000) return (value / 1000000).toFixed(2) + "M";
    if (value >= 1000) return (value / 1000).toFixed(1) + "k";
    return String(Math.round(value));
  }

  function formatCost(value) {
    const amount = Number(value) || 0;
    if (amount <= 0) return "¥0";
    if (amount < 0.0001) return "<¥0.0001";
    // 单次对话常常只有几厘钱，小数位给足，否则四舍五入之后看不出差别。
    if (amount < 0.1) return "¥" + amount.toFixed(4);
    if (amount < 1) return "¥" + amount.toFixed(3);
    return "¥" + amount.toFixed(2);
  }

  function formatUsage(usage) {
    return "输入 " + formatTokens(usage.input) + " / 输出 " + formatTokens(usage.output);
  }

  const Pricing = {
    DEFAULT_TABLE,
    PEAK_RANGES,
    isPeak,
    periodLabel,
    defaultPrices,
    pricesFor,
    estimateTokens,
    tokensFromMessages,
    usageOf,
    costOf,
    formatTokens,
    formatCost,
    formatUsage,
  };

  global.RoleWorldPricing = Pricing;
  if (typeof module !== "undefined" && module.exports) module.exports = Pricing;
})(typeof globalThis !== "undefined" ? globalThis : this);
