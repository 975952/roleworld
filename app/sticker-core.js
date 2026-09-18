"use strict";

/*
 * sticker-core.js —— 表情包（角色在回复里发表情）
 *
 * 做法和记忆标记同一套路：**不用 function calling、不破坏流式**，
 * 模型在回复最后单独起一行写 `[[表情: 开心]]`，前端剥掉标记、把表情画出来。
 * 这样任何 OpenAI 兼容端点都能用（它们未必支持 tool_calls，支持了也会打断流式增量）。
 *
 * 三条硬规矩（都有用例盯着）：
 *   ① **标记绝不能漏进正文**。流式渲染时模型可能正停在 `[[表情:` 中间，
 *      所以有 stripPartial 那一层（和记忆标记一样）。
 *   ② **只认真的存在的表情**。模型经常编一个名字（"微笑"），
 *      这时按别名/标签就近匹配；再匹配不上就**整条丢掉**，不显示破图、不写进记录。
 *   ③ 每轮最多一个。一条回复里塞五个表情不是表达，是刷屏。
 *
 * 数据形状（与内容包同一风格，放在 app/stickers/ 下，启动时由 sticker-pack.js 读进来）：
 *   { id, label, stamps: [ { id, name, file, tags: [...] } ] }
 */

(function (global) {
  /* 模型的写法很杂：全角/半角括号、冒号、`表情包`/`表情`/`sticker` 都可能出现。 */
  const STICKER_MARKER_RE = /[\[【]{1,2}\s*(?:表情包?|贴纸|sticker)\s*[:：]\s*([^\]】\n]+?)\s*[\]】]{1,2}/gi;
  /* 流式停在半截（`[[表情: 开`）时，这一截既不是正文也不该进记录。
   * 只认"确实开了个头"的形状：`[[` 或 `【` 后面跟着 表/贴 开头的词（或关键字本身已经写全），
   * 免得把正文里普通的方括号也当成半截标记吃掉。 */
  const PARTIAL_STICKER_MARKER_RE = /(?:\[\[|【)\s*(?:表[情包]?|贴[纸]?|s(?:t(?:i(?:c(?:k(?:e(?:r)?)?)?)?)?)?)?\s*[:：]?[^\]】\n]*$/i;
  const STICKER_LIMIT = 1;

  /* 模型爱写的同义名字 → 归一后的键。归一规则：去掉空白与标点、转小写。
   * ⚠ 这里**别把某张表情自己的名字**列成别人的别名：曾经把 `大笑 → 开心` 写进来，
   * 结果真实的"大笑"那张永远解析不出来（测试抓到过）。别名只放真正的同义词。 */
  const ALIASES = {
    開心: "开心", 高兴: "开心", 快乐: "开心", 笑: "开心", 微笑: "开心",
    happy: "开心", smile: "开心", grinning: "开心",
    難過: "难过", 伤心: "难过", 哭: "难过", 委屈: "难过",
    sad: "难过", cry: "难过", crying: "难过",
    生气: "生气", 愤怒: "生气", 恼火: "生气", 不爽: "生气",
    angry: "生气", mad: "生气",
    惊讶: "惊讶", 吃惊: "惊讶", 震惊: "惊讶",
    surprised: "惊讶", shock: "惊讶",
    害羞: "害羞", 脸红: "害羞", 不好意思: "害羞",
    shy: "害羞", blush: "害羞",
    困: "困", 想睡: "困", 打哈欠: "困",
    sleepy: "困", tired: "困",
    无语: "无语", 沉默: "无语", 汗: "无语",
    speechless: "无语", awkward: "无语",
    疑惑: "疑惑", 问号: "疑惑", 不解: "疑惑",
    confused: "疑惑", puzzled: "疑惑",
    爱: "爱心", 喜欢: "爱心", 心: "爱心", 比心: "爱心",
    love: "爱心", heart: "爱心",
    点赞: "赞", 棒: "赞", 厉害: "赞", 好耶: "赞",
    thumbsup: "赞", like: "赞", ok: "赞",
    思考: "思考", 想: "思考", 沉思: "思考",
    thinking: "思考", hmm: "思考",
  };

  /** 归一：去掉空白/标点、统一小写、去掉"表情"这类后缀词。 */
  function normalizeName(raw) {
    const text = String(raw === undefined || raw === null ? "" : raw)
      .replace(/[\s\u3000]+/g, "")
      .replace(/[!！?？。，,、~～…\.]+/g, "")
      .replace(/(表情|贴纸|sticker)/gi, "")
      .trim();
    return text.toLowerCase();
  }

  /** 反查表：同一张表情的所有别名（模型写"微笑"要能命中"开心"）。 */
  const REVERSE_ALIASES = (() => {
    const map = new Map();
    for (const [alias, canonical] of Object.entries(ALIASES)) {
      const key = normalizeName(canonical);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(alias);
    }
    return map;
  })();

  /**
   * 目录里的表情先建索引：归一后的名字 → stamp，标签 → stamp（便于按意思找）。
   *
   * ⚠ 入参允许**两种形状**（这是踩过的坑）：
   *   · 包数组：[{ id: "mood", stamps: [...] }]  —— 直接读清单时是这个形状；
   *   · 扁平数组：[{ id: "mood:happy", name: "开心", ... }]  —— adapter 为了给提示词用，
   *     产出的就是这个形状。
   * 一开始只认第一种，结果生产路径（传扁平数组）**一个表情都解析不出来**，
   * 而单元测试传的是包数组所以全绿 —— 测试和真实调用形状不一致，等于没测。
   * 名字来源有三处：表情自己的 name、包里写的 aliases（第三方包可以自己补英文）、
   * 以及内置的同义词表 —— 模型经常不照抄清单，写"微笑""happy"却指"开心"。
   */
  function indexStamps(input) {
    const byName = new Map();
    const byTag = new Map();
    const all = [];
    // 统一成"包"的形状：扁平数组包一层假包（它的 id 已经带前缀了）。
    const packs = (input || []).map((row) => {
      if (row && Array.isArray(row.stamps)) return row;
      return { id: row && row.packId ? row.packId : "", stamps: row ? [row] : [] };
    });
    // 第一遍：把"真实名字"全部登记下来（别名不能抢走它们）。
    const realNames = new Set();
    for (const pack of packs) {
      for (const stamp of (pack && pack.stamps) || []) {
        if (stamp && stamp.id && stamp.name) realNames.add(normalizeName(stamp.name));
      }
    }
    const claimedElsewhere = (key, row) => realNames.has(key) && normalizeName(row.name) !== key;
    for (const pack of packs) {
      for (const stamp of (pack && pack.stamps) || []) {
        if (!stamp || !stamp.id) continue;
        // id 统一带上包前缀：清单里写的是包内短 id（happy），
        // 而 adapter 产出的扁平表已经带前缀（mood:happy），两边必须一致，
        // 否则"解析出来的 id"和"存进消息的 id"对不上（测试抓到过）。
        let fullId = String(stamp.id);
        if (fullId.indexOf(":") < 0 && pack.id) fullId = `${pack.id}:${fullId}`;
        const row = {
          id: fullId,
          name: stamp.name || stamp.id,
          file: stamp.file || "",
          url: stamp.url || "",
          packId: pack.id || stamp.packId || "",
          packLabel: pack.label || "",
          tags: Array.isArray(stamp.tags) ? stamp.tags.slice() : [],
        };
        all.push(row);
        const names = [row.name].concat(Array.isArray(stamp.aliases) ? stamp.aliases : []);
        for (const candidate of names) {
          const key = normalizeName(candidate);
          if (key && !byName.has(key)) byName.set(key, row);
        }
        // 内置同义词表：写"微笑"也命中"开心"。
        // ⚠ 别名**只在不会抢走别人的名字时**才生效：先用一张表算出每个键被哪些表情
        // 认领，撞车的键一律不建 —— 否则"笑"这种短别名会把"大笑"那张抢走，
        // 或者英文别名 tired/困 把真实名字叫"困"的那张抢走（两种都被测试抓到过）。
        const synonyms = REVERSE_ALIASES.get(normalizeName(row.name)) || [];
        for (const alias of synonyms) {
          const key = normalizeName(alias);
          if (key && !byName.has(key) && !claimedElsewhere(key, row)) byName.set(key, row);
        }
        for (const tag of row.tags) {
          const key = normalizeName(tag);
          if (key && !byTag.has(key)) byTag.set(key, row);
        }
      }
    }
    return { byName, byTag, all };
  }

  /**
   * 把模型写的名字解析成一个真实存在的表情。
   * 顺序：精确名字 → 别名 → 标签 → 名字包含关系（"开心的笑" 命中 "开心"）。
   * 都不中返回 null —— 宁可没有表情，也不要破图。
   */
  function resolve(name, index) {
    if (!index) return null;
    const key = normalizeName(name);
    if (!key) return null;
    if (index.byName.has(key)) return index.byName.get(key);
    if (ALIASES[key] && index.byName.has(normalizeName(ALIASES[key]))) {
      return index.byName.get(normalizeName(ALIASES[key]));
    }
    if (index.byTag.has(key)) return index.byTag.get(key);
    // 包含关系：模型爱写"开心地笑""高兴地点头"这种。
    // 规矩（都是被测试逼出来的）：
    //   · 只认**词首 / 词尾**，不能"谁包含谁"（否则"大笑"会被"开心"的"笑"抢走）；
    //   · **结尾优先** —— 中文里"高兴地点头"的重心在最后那个动作上，
    //     先匹配开头会把"点头"判成"开心"；
    //   · 多出来的尾巴不超过 3 个字（"开心地笑" = "开心" + 3 个字）。
    const containment = (map, preferSuffix) => {
      const candidates = Array.from(map.entries()).sort((a, b) => b[0].length - a[0].length);
      for (const [candidate, row] of candidates) {
        if (candidate.length < 2 || key.length < 2) continue;
        const tail = key.endsWith(candidate);
        const head = key.startsWith(candidate);
        if (preferSuffix ? tail : head) {
          if (key.length - candidate.length <= 3) return row;
        }
      }
      return null;
    };
    return containment(index.byName, true)
      || containment(index.byName, false)
      || containment(index.byTag, true)
      || containment(index.byTag, false)
      || null;
  }

  /** 去掉末尾没写完的表情标记（流式渲染与最终保存都要用）。 */
  function stripPartialStickerMarkers(text) {
    let out = String(text === undefined || text === null ? "" : text);
    for (let i = 0; i < 3; i += 1) {
      const next = out.replace(PARTIAL_STICKER_MARKER_RE, "");
      if (next === out) break;
      out = next;
    }
    return out;
  }

  /**
   * 从回复里剥出表情标记。返回 { text, stickers }：
   *   text      —— 去掉标记后的正文（末尾多余空行也收掉）
   *   stickers  —— 解析成功的表情数组（最多 STICKER_LIMIT 个），解析不出来的直接丢
   */
  function extractStickers(text, packs) {
    const index = indexStamps(packs);
    const source = stripPartialStickerMarkers(text);
    const stickers = [];
    const seen = new Set();
    STICKER_MARKER_RE.lastIndex = 0;
    let match;
    while ((match = STICKER_MARKER_RE.exec(source)) !== null) {
      // 允许 `[[表情: 开心 | 有点不好意思]]` —— 竖线后面是给模型自己看的补充，丢掉。
      const raw = String(match[1] || "").split(/[|｜]/)[0];
      const hit = resolve(raw, index);
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      stickers.push(hit);
      if (stickers.length >= STICKER_LIMIT) break;
    }
    const cleaned = source
      .replace(STICKER_MARKER_RE, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text: cleaned, stickers };
  }

  /**
   * 告诉模型怎么发表情。**把可用的表情名列出来** —— 不列的话它会自己编一个
   * （"开心"这种通用的还好，编个"欣慰"就整条丢掉了）。
   * packs 为空（用户没装任何表情包）时返回空串：不教它做做不到的事。
   */
  function stickerInstruction(packs, options) {
    const index = indexStamps(packs);
    if (!index.all.length) return "";
    const names = index.all.map((row) => row.name);
    const list = names.slice(0, 24).join("、");
    const lines = [
      "[Stickers]",
      "你可以在**真心想表达情绪**的时候发一个表情，写法是在回复的最后单独起一行写 [[表情: 名字]]。",
      `只能从这几个里选：${list}。`,
      "一轮最多一个，没有合适的就不发 —— 不要每句话都配表情，那看起来像机器人。",
      "发了表情就不要再用文字把同一个情绪重复一遍。",
      "这个标记会被系统读取并从文本里移除，也不要在正文里解释它。",
    ];
    if (options && options.lang === "en") {
      lines.push("Write the sticker name exactly as listed above (Chinese names are fine).");
    }
    return lines.join("\n");
  }

  /** 用户自己发表情时，写进聊天记录里的那行字 —— 让角色"看得见"对方发了什么。 */
  function stickerAsMessageText(sticker) {
    const name = (sticker && sticker.name) || "";
    return `[玩家发了一个表情：${name}]`;
  }

  /** 上面那行标记的**反向解析**：这条消息是"用户发了一个表情"吗？是就返回表情名。
   *  与 `stickerAsMessageText` 成对 —— 格式只写在这里一处，两边不会各自漂。
   *  为什么要它：渲染时要把"给模型看的那行字"换成**图**（用户 2026-09-18 实测
   *  「发送的是文字：[玩家发送了一个表情：惊讶]」）。 */
  const USER_STICKER_RE = /\[玩家发了一个表情[：:]\s*([^\]]*)\]/;
  function userStickerName(text) {
    const match = String(text || "").match(USER_STICKER_RE);
    return match ? String(match[1] || "").trim() : "";
  }

  const Core = {
    normalizeName,
    indexStamps,
    resolve,
    extractStickers,
    stripPartialStickerMarkers,
    stickerInstruction,
    stickerAsMessageText,
    userStickerName,
    STICKER_LIMIT,
  };

  global.RoleWorldStickers = Core;
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
})(typeof globalThis !== "undefined" ? globalThis : this);
