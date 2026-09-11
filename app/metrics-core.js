"use strict";

/*
 * metrics-core.js —— 每轮指标的纯逻辑层（无 DOM，浏览器与 Node 双端可用）
 *
 * 记什么：
 *   - 回复延迟：从发送到**第一个字**（首字延迟）与到**完整回复**（总延迟）
 *   - 用量与费用：这一轮的输入 / 输出 token 与估算费用
 *   - 这一轮的系统行为：写了几条记忆、替换了几条、历史检索命中几条
 *   - **用户手动标记**：这一轮记错了 / 编造了 —— 只有人点了才算，绝不自动判定
 *
 * 存哪儿：只在本机。结构是"按角色一本台账"，上限 200 轮，只留均值需要的量。
 * 汇总口径：最近 N 轮的平均首字延迟、平均总延迟、总费用、记忆错误次数、编造次数。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.ROLEWORLD_METRICS_CORE = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  const MAX_TURNS = 200;
  const DEFAULT_WINDOW = 20;

  /** 用户能做的三种标记。没有"自动判定"这一项，这是刻意的。 */
  const FLAGS = Object.freeze({
    WRONG_MEMORY: "wrong-memory",   // 记错了 / 记岔了
    FABRICATION: "fabrication",     // 编造了没发生过的事
    GOOD: "good",                   // 这一轮很准（用来对照）
  });

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function cleanText(value, limit) {
    const text = String(value === undefined || value === null ? "" : value).trim();
    return limit && text.length > limit ? text.slice(0, limit) : text;
  }

  /** 新建一轮记录。缺的字段一律按 0 / 空处理，不编造。 */
  function makeTurn(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      // 轮次 ID 与消息里记的那个一致：标记时靠它定位，不靠位置（翻页/截断都不会错位）。
      turnId: cleanText(source.turnId, 60),
      at: cleanText(source.at, 40) || new Date().toISOString(),
      file: cleanText(source.file, 200),
      // 延迟单位毫秒；首字延迟是"体感速度"，总延迟是"等待时间"。
      firstTokenMs: Math.round(num(source.firstTokenMs)),
      totalMs: Math.round(num(source.totalMs)),
      inputTokens: Math.round(num(source.inputTokens)),
      outputTokens: Math.round(num(source.outputTokens)),
      cost: num(source.cost),
      costExact: source.costExact === true,
      // 这一轮系统做了什么
      memoriesAdded: Math.round(num(source.memoriesAdded)),
      memoriesReplaced: Math.round(num(source.memoriesReplaced)),
      memoriesRejected: Math.round(num(source.memoriesRejected)),
      searchHits: Math.round(num(source.searchHits)),
      activeSearches: Math.round(num(source.activeSearches)),
      // 用户标记（可以后补，所以初始为空）
      flags: Array.isArray(source.flags) ? source.flags.filter((f) => Object.values(FLAGS).indexOf(f) >= 0) : [],
      note: cleanText(source.note, 200),
    };
  }

  /** 追加一轮，并保持台账不无限增长（只留最近 MAX_TURNS 轮）。 */
  function appendTurn(turns, turn) {
    const list = Array.isArray(turns) ? turns.slice() : [];
    list.push(makeTurn(turn));
    return list.slice(-MAX_TURNS);
  }

  /** 给某一轮打标记 / 取消标记（按下标；下标对不上时用 turnId 那个版本）。 */
  function toggleFlag(turns, index, flag) {
    const list = Array.isArray(turns) ? turns.map((t) => makeTurn(t)) : [];
    if (!Object.values(FLAGS).includes(flag)) return { ok: false, reason: "unknown-flag", turns: list };
    const target = list[index];
    if (!target) return { ok: false, reason: "missing", turns: list };
    const has = target.flags.indexOf(flag) >= 0;
    target.flags = has ? target.flags.filter((f) => f !== flag) : target.flags.concat([flag]);
    return { ok: true, added: !has, turns: list };
  }

  /**
   * 按轮次 ID 打标记 / 取消标记 —— 界面用这个版本。
   * 用 ID 而不是下标：消息列表可能被截断、切换对话、翻页，
   * 按下标标记会标到别的轮次上去（那比不标记更糟）。
   */
  function flagTurn(turns, turnId, flag) {
    const list = Array.isArray(turns) ? turns.map((t) => makeTurn(t)) : [];
    const id = cleanText(turnId, 60);
    if (!Object.values(FLAGS).includes(flag)) return { ok: false, reason: "unknown-flag", turns: list };
    if (!id) return { ok: false, reason: "no-turn-id", turns: list };
    const index = list.findIndex((t) => t.turnId === id);
    if (index < 0) return { ok: false, reason: "missing", turns: list };
    const target = list[index];
    const has = target.flags.indexOf(flag) >= 0;
    target.flags = has ? target.flags.filter((f) => f !== flag) : target.flags.concat([flag]);
    return { ok: true, added: !has, index, turns: list };
  }

  /** 某条消息（按 turnId）当前的标记，用于渲染按钮状态。 */
  function flagsOf(turns, turnId) {
    const id = cleanText(turnId, 60);
    if (!id || !Array.isArray(turns)) return [];
    const hit = turns.map((t) => makeTurn(t)).find((t) => t.turnId === id);
    return hit ? hit.flags.slice() : [];
  }

  function average(values) {
    const list = values.filter((v) => Number.isFinite(v) && v > 0);
    if (!list.length) return 0;
    return Math.round(list.reduce((sum, v) => sum + v, 0) / list.length);
  }

  /**
   * 汇总最近 window 轮。
   * 只统计有值的项：一次失败的请求延迟是 0，不该把平均值拉低。
   */
  function summarize(turns, options) {
    const opts = options || {};
    const window = Number(opts.window) > 0 ? Number(opts.window) : DEFAULT_WINDOW;
    const all = Array.isArray(turns) ? turns.map((t) => makeTurn(t)) : [];
    const recent = all.slice(-window);
    const count = (flag) => recent.filter((t) => t.flags.indexOf(flag) >= 0).length;
    return {
      turns: recent.length,
      totalTurns: all.length,
      window,
      avgFirstTokenMs: average(recent.map((t) => t.firstTokenMs)),
      avgTotalMs: average(recent.map((t) => t.totalMs)),
      inputTokens: recent.reduce((sum, t) => sum + t.inputTokens, 0),
      outputTokens: recent.reduce((sum, t) => sum + t.outputTokens, 0),
      cost: recent.reduce((sum, t) => sum + t.cost, 0),
      allCost: all.reduce((sum, t) => sum + t.cost, 0),
      wrongMemory: count(FLAGS.WRONG_MEMORY),
      fabrication: count(FLAGS.FABRICATION),
      good: count(FLAGS.GOOD),
      memoriesAdded: recent.reduce((sum, t) => sum + t.memoriesAdded, 0),
      memoriesReplaced: recent.reduce((sum, t) => sum + t.memoriesReplaced, 0),
      searchHits: recent.reduce((sum, t) => sum + t.searchHits, 0),
      // 记忆错误率：被标成"记错"的轮次占比。没有样本时给 null，不假装是 0。
      wrongMemoryRate: recent.length ? count(FLAGS.WRONG_MEMORY) / recent.length : null,
    };
  }

  function formatDuration(ms) {
    const value = num(ms);
    if (!value) return "—";
    if (value < 1000) return value + "ms";
    return (value / 1000).toFixed(value < 10000 ? 1 : 0) + "s";
  }

  return {
    MAX_TURNS,
    DEFAULT_WINDOW,
    FLAGS,
    makeTurn,
    appendTurn,
    toggleFlag,
    flagTurn,
    flagsOf,
    summarize,
    formatDuration,
  };
});
