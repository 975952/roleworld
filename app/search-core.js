"use strict";

/*
 * search-core.js —— 历史检索的纯逻辑层（无 DOM，浏览器与 Node 双端可用）
 *
 * 目标：让模型能"按需翻出以前说过的话"，并且**查不到就直说查不到**，不编造。
 *
 * 刻意不做的事：不引入向量数据库、不引入 embedding、不调用任何外部服务。
 * 就是关键词匹配 + 打分 + 时间兜底 —— 对几十到几千条消息的规模足够，
 * 而且用户能看懂"为什么翻出的是这几条"。
 *
 * 检索结果是**只读证据**：带出处（哪段对话、第几条、什么时候），
 * 注入提示词时也把出处写清楚，模型引用时才有据可依。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.ROLEWORLD_SEARCH_CORE = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /* 提问里的常见词：它们出现在任何一句话里都不代表"相关"，参与匹配只会让结果变噪。 */
  const STOPWORDS = new Set([
    "的", "了", "是", "在", "有", "和", "与", "我", "你", "他", "她", "它", "我们", "你们", "他们",
    "这", "那", "这个", "那个", "什么", "怎么", "为什么", "哪", "哪个", "哪里", "吗", "呢", "吧", "啊",
    "还", "就", "都", "也", "很", "太", "会", "能", "要", "想", "说", "一个", "一下", "现在", "之前",
    "记得", "记不记得", "还记得", "上次", "上回", "以前", "当时", "曾经", "告诉", "说过", "提过",
    "hello", "hi", "the", "a", "an", "is", "are", "was", "were", "do", "did", "does", "what", "when",
    "where", "who", "why", "how", "i", "you", "me", "my", "your", "we", "it", "that", "this", "and",
  ]);

  // 中文单字词（猫 / 茶 / 妈）很关键，所以最短长度放到 1；
  // 噪声由"常用字表 + 噪声排序 + 截断"三处一起压住。
  const MIN_KEYWORD_LENGTH = 1;
  const DEFAULT_LIMIT = 6;
  const DEFAULT_SCAN = 4000;

  function cleanText(value, limit) {
    let text = String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (limit && text.length > limit) text = text.slice(0, limit);
    return text;
  }

  /**
   * 从提问里取关键词。
   * 中文没有空格，切成 4 字窗口会得到"还记得我"这种整串，几乎匹配不上任何原话；
   * 所以切成**双字词**（"猫吗"→"猫"，"喜欢咖啡"→"喜欢"+"咖啡"），
   * 再丢掉常用词。双字是最稳的折中：既能命中，又不会什么都命中。
   */
  function keywords(query) {
    const text = cleanText(query, 300);
    if (!text) return [];
    const out = [];
    const push = (word) => {
      const value = String(word || "").trim().toLowerCase();
      if (!value || value.length < MIN_KEYWORD_LENGTH) return;
      if (STOPWORDS.has(value)) return;
      // 纯数字也丢：年份、编号这类匹配上说明不了相关性。
      if (/^\d+$/.test(value)) return;
      if (out.indexOf(value) < 0) out.push(value);
    };

    for (const chunk of (text.match(/[\u4e00-\u9fa5]+/g) || [])) {
      if (chunk.length <= 3) { push(chunk); continue; }
      // 滑窗取相邻两字。**不能因为有常用字就整对丢掉**：
      // "猫吗"里带了"吗"，但它正是能命中"猫"的那一对。只丢"两个都是常用字"的组合。
      for (let i = 0; i + 2 <= chunk.length; i += 1) {
        const pair = chunk.slice(i, i + 2);
        if (STOPWORDS.has(pair[0]) && STOPWORDS.has(pair[1])) continue;
        push(pair);
      }
      // 三字词也留一份：专有名词常常是三个字。
      for (let i = 0; i + 3 <= chunk.length; i += 1) push(chunk.slice(i, i + 3));
    }
    (text.match(/[a-zA-Z][a-zA-Z0-9_-]{1,}/g) || []).forEach(push);

    // 补一轮"单字内容词"：中文里"猫""茶"这种一字词很关键
    // （"我说的猫"切成双字是"的猫"，但原话是"养了一只猫"，只有单字能命中）。
    // 常用字一律排除，避免噪声。
    for (const chunk of (text.match(/[\u4e00-\u9fa5]/g) || [])) {
      if (STOPWORDS.has(chunk)) continue;
      push(chunk);
    }

    // 含常用字越少越可靠（"杭州" 优于 "去杭"），据此排序后截断，防止提示词膨胀。
    const noise = (word) => word.split("").filter((ch) => STOPWORDS.has(ch)).length;
    return out.sort((a, b) => (noise(a) - noise(b)) || (a.length - b.length)).slice(0, 16);
  }

  /* 虚词：单独命中说明不了相关性，给最低权重。 */
  const COMMON_CHARS = new Set(("的一了是在有和与我你他她它这那什么怎么为哪吗呢吧啊还就都也很太会能要想说个下上" +
    "天年月日时分先后前后来去去到过回大小多少好新旧东西南北中内外时候事地方里外头尾").split(""));

  // 阈值 1.6：一个双字词（3+）稳过；两个稀有单字（2.0）也算，
  // 但单个稀有字（"州"→"月球"命中"杭州"）不够。刻意卡在中间，
  // 因为中文里"我养了一只猫"和"我说的猫"的唯一交集就是"猫"这一个字。
  const MIN_SCORE = 1.6;

  function scoreMessage(text, words, query, weights) {
    const haystack = cleanText(text, 2000).toLowerCase();
    if (!haystack || !words.length) return 0;
    // 语料里随处可见的词（"喜欢"）不该和罕见词（"团子"）一样值钱。
    const weightOf = (word) => {
      const share = weights && weights[word];
      if (typeof share !== "number" || !Number.isFinite(share)) return 1;
      return Math.max(0.25, 1 - share);
    };
    let score = 0;
    let bigramHits = 0;
    const bigrams = words.filter((word) => word.length >= 2);
    for (const word of bigrams) {
      if (haystack.indexOf(word) >= 0) { bigramHits += 1; score += (3 + Math.min(word.length, 4) * 0.2) * weightOf(word); }
    }
    const countedSingles = new Set();
    for (const word of words) {
      if (word.length !== 1) continue;
      if (countedSingles.has(word)) continue;
      if (haystack.indexOf(word) < 0) continue;
      countedSingles.add(word);
      if (COMMON_CHARS.has(word)) { score += 0.15; continue; }
      // 稀有字命中给满分。刻意**不按出现次数加码**：同一句话里反复出现的字
      // 说明不了什么（"杭州…喜欢杭州"里的"州"和"喜"重复出现，不该因此更像相关）。
      score += 1.0 * weightOf(word);
    }
    if (!score) return 0;
    if (bigrams.length && bigramHits === bigrams.length && words.length > 1) score += 2;
    const phrase = cleanText(query, 100).toLowerCase();
    if (phrase.length >= 3 && haystack.indexOf(phrase) >= 0) score += 3;
    score += Math.max(0, 1 - haystack.length / 1000);
    return score >= MIN_SCORE ? score : 0;
  }

  /**
   * 在所有对话里检索。
   * @param sessions  [{ fileName, avatar, updatedAt, messages: [{ name, is_user, mes, send_date }] }]
   * @param query     用户这次的提问
   * @returns { hits, scanned, matched, keywords }
   *   hits 里每条都带出处：哪段对话、第几条、谁说的、什么时候。
   */
  function searchHistory(sessions, query, options) {
    const opts = options || {};
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_LIMIT;
    const skipFile = cleanText(opts.skipFileName, 200);
    const scanLimit = Number(opts.scan) > 0 ? Number(opts.scan) : DEFAULT_SCAN;
    const words = keywords(query);
    const list = Array.isArray(sessions) ? sessions : [];
    let scanned = 0;
    const hits = [];

    // 先扫一遍算词频：出现得越普遍，越说明不了相关性。
    const weights = {};
    if (words.length) {
      const total = { count: 0 };
      const holder = { count: 0 };
      for (const session of list) {
        for (const message of (Array.isArray(session && session.messages) ? session.messages : [])) {
          const text = cleanText(message && message.mes, 2000).toLowerCase();
          if (!text) continue;
          holder.count += 1;
          for (const word of words) {
            if (text.indexOf(word) >= 0) weights[word] = (weights[word] || 0) + 1;
          }
        }
      }
      total.count = holder.count || 1;
      for (const word of Object.keys(weights)) weights[word] = weights[word] / total.count;
    }

    for (const session of list) {
      const messages = Array.isArray(session && session.messages) ? session.messages : [];
      const fileName = cleanText(session && session.fileName, 200);
      // 只扫描了尾部时，条数要加上偏移，否则"第几条"是错的。
      const offset = Number(session && session.offset) > 0 ? Math.floor(Number(session.offset)) : 0;
      // 已经在上下文里的最近对话不必再翻一遍（避免同一句出现两次）。
      // 已经在上下文里的那段对话不必再翻一遍：同一句话出现两次会挤占空间，
      // 也会让模型误以为"这是两条独立证据"。直接跳过整段。
      if (skipFile && fileName === skipFile) continue;
      for (let index = 0; index < messages.length && scanned < scanLimit; index += 1) {
        const message = messages[index] || {};
        const text = cleanText(message.mes, 2000);
        if (!text) continue;
        scanned += 1;
        if (!words.length) continue;
        const score = scoreMessage(text, words, query, weights);
        if (score <= 0) continue;
        hits.push({
          fileName,
          index: index + offset,
          isUser: message.is_user === true,
          name: cleanText(message.name, 60),
          text: text.length > 400 ? text.slice(0, 400) + "…" : text,
          at: cleanText(message.send_date, 40),
          score,
        });
      }
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // 同分时新的优先
      return String(b.at || "").localeCompare(String(a.at || ""));
    });
    return { hits: hits.slice(0, limit), scanned, matched: hits.length, keywords: words, weights };
  }

  /**
   * 把检索结果写成给模型看的一段话。
   * 关键约定：**没有结果就明说没有**，并明确要求"说不知道，不要编"。
   * 这正是"找不到就说明不知道，不虚构回忆"的落地处。
   */
  function buildHistoryNote(result) {
    const found = result && Array.isArray(result.hits) ? result.hits : [];
    if (!found.length) {
      return [
        "[History search]",
        "在**更早以前**的对话里没有找到相关内容（注意：这只说明更早的记录里没有，",
        "你们这段对话里刚说过的话仍然算数，不要否认它）。",
        "如果玩家问的是更早以前发生过什么，请直说这边没有更早的记录，",
        "不要猜测、不要编造细节、不要用剧情想象补足。可以请玩家多说一点。",
      ].join("\n");
    }
    const lines = [
      "[History search]",
      "下面是这次从**更早以前的对话**里检索到的相关记录（只读证据；你们当前这段对话不在这里面，因为它本来就在你眼前）：",
    ];
    found.forEach((hit, index) => {
      const who = hit.isUser ? "玩家" : (hit.name || "角色");
      const when = hit.at ? hit.at.slice(0, 16).replace("T", " ") : "时间未记录";
      lines.push(`(${index + 1}) [${who} · ${hit.fileName} 第 ${hit.index} 条 · ${when}] ${hit.text}`);
    });
    lines.push("引用这些内容时请贴着原话，不要补充记录里没有的细节。");
    lines.push("如果这些记录回答不了玩家的问题，就直说没有找到，不要编。");
    return lines.join("\n");
  }

  /**
   * 给模型的总则：分清"眼前这轮对话"和"以前的记录"。
   *
   * 这条以前写错了：只说"没有依据就说不知道"，结果模型连**同一段对话里刚说过的话**
   * 都不敢认，张口"我这边什么都没有" —— 明明那句话就在它眼前的上下文里。
   * 现在把两者分开讲：眼前的对话是事实；以前的记录要靠检索，查不到才算不知道。
   */
  function honestyRule() {
    return [
      "[Honesty]",
      "先把两件事分开：",
      "① 你们**正在进行的这段对话**（前面的几条消息）是你亲眼看到的事实，可以直接引用、",
      "   可以直接说「你刚才说过…」，不要怀疑它、也不要说自己不知道。",
      "② **更早以前的对话**不在你眼前，只能靠下面 [History search] 的记录说话。",
      "   记录里有的才引用；记录里没有的，就照实说「这边没有更早的记录」——",
      "   绝对不要为了显得连贯而编造过去的细节、地点、时间或承诺。",
      "换句话说：**不是要你装失忆，是要你别编**。",
    ].join("\n");
  }

  return {
    STOPWORDS,
    keywords,
    scoreMessage,
    searchHistory,
    buildHistoryNote,
    honestyRule,
    cleanText,
  };
});
