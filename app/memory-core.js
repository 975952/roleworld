"use strict";

/*
 * memory-core.js —— 角色记忆的纯逻辑层（无 DOM，浏览器与 Node 双端可用）
 *
 * 记忆的现状：模型在回复里写 `[[记住: …]]`，前端剥出来后写进该角色自己的
 * 「MB <角色短名> — 自动记忆」记忆书（世界书格式）。
 *
 * 这个模块负责三件现在缺的事：
 *   ① 每条记忆记下**来源**：来自哪段对话的第几条消息、什么时候记的、谁写的；
 *   ② 写入时**合并与去重**，并把超过上限的最旧条目挤掉（返回被挤掉的是哪几条，便于告知用户）；
 *   ③ 忠实读取，方便界面把"它到底记了什么"一条条列出来。
 *
 * 设计底线：
 *   - 只记"玩家透露的事实与偏好"，不把角色扮演的剧情当成用户事实；
 *   - 真正的条目正文在 `content`（保持世界书格式兼容），我们的元数据放在 `rw_source`，
 *     额外字段对 SillyTavern 世界书格式是安全的（它忽略不认识的键）。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.ROLEWORLD_MEMORY_CORE = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  const DEFAULT_MAX = 50;

  /** 记忆归属：谁写的。 */
  const ORIGIN = Object.freeze({
    MODEL: "model",   // 模型按 [[记住: …]] 自己记的
    USER: "user",     // 用户在界面上自己写的
  });

  function cleanText(value, limit) {
    let text = String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim();
    if (limit && text.length > limit) text = text.slice(0, limit);
    return text;
  }

  /** 来源信息：来自哪段对话的第几条消息。缺字段不编造，一律留空。 */
  function normalizeSource(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    // 注意：不能直接 Number(null)——那是 0，会把"没有来源"说成"第 0 条"。
    const rawIndex = source.messageIndex;
    const index = (typeof rawIndex === "number" || (typeof rawIndex === "string" && rawIndex.trim() !== ""))
      ? Number(rawIndex) : NaN;
    return {
      file: cleanText(source.file, 200),
      messageIndex: Number.isFinite(index) && index >= 0 ? Math.floor(index) : null,
      at: cleanText(source.at, 40),
      origin: source.origin === ORIGIN.USER ? ORIGIN.USER : ORIGIN.MODEL,
      // 用户改过的标记也要跟着走，否则改完再读就丢了。
      edited: source.edited === true,
      // 这条替换掉的旧内容（改口时记下，便于解释）。
      replacedContent: cleanText(source.replacedContent, 200),
    };
  }

  /* ---------- 真实信息 vs 虚构剧情 ----------
   * 这是用户定的第一条底线：**不能把角色扮演的剧情当成用户的事实记下来**。
   * 记忆只该记"玩家本人透露的事实与偏好"，不该记"故事里发生了什么"。
   *
   * 这里做的是**确定性的拒绝**（不靠模型自觉）：
   *   - 明显的角色扮演符号：*动作*、（动作）、【旁白】、"台词"
   *   - 故事里的行动与情节：拔出魔杖、挥剑、推开、击败、爆炸、施法…
   *   - 剧情记帐：第几章、上一幕、世界设定语气
   * 宁可漏掉一条真事实（用户还能手动加），也不能把剧情写成用户事实。
   */
  const STORY_PATTERNS = [
    // 角色扮演的排版符号
    /^\s*[*＊]/, /[*＊][^*＊]{2,}[*＊]/, /^[（(][^）)]{2,}[）)]$/,
    /【[^】]{1,12}】/,
    // 故事里的动作：谁 + 动作词（含"把玩家推进密室"这种把字句）
    /(你|他|她|它|他们|她们|我们|众人|对方|对手|敌人)(拔出|抽出|举起|挥动|挥出|挥剑|挥刀|念出|施展|施放|发动|冲向|扑向|躲开|闪身|推开|推进|踢开|拽|拉进|抓住|抱住|打了|击中|刺中|砍中|挡住|接住|掏出|扔出|跳下|爬上|翻过|开火|开枪|射击|施法|召唤|变身)/,
    /把(玩家|你|我)(推进|拉进|拽进|拖进|关进|锁进|扔进|丢进|带进|拖到|推到)/,
    // 故事世界的物件与设定
    /(魔杖|符咒|法术|咒语|咒文|技能|必杀|大招|装备|副本|任务|公会|战力|等级|血条|斗篷|坩埚|扫帚|密室|禁林|城堡|学院杯|火球|雷电术|召唤术|秘籍|内力|灵气|丹田)/,
    /(拔出|挥剑|挥刀|开火|开枪|射击|爆炸|爆裂|崩塌|轰然|刹那间|霎时间|转眼间)/,
    // 不带主语的战斗/情节动词：一句里出现这些，基本可以断定是在讲剧情
    /(打败|击败|战胜|救出|救了|杀死|杀掉|攻击|反击|偷袭|逃跑|撤退|施法|变身|通关|升级|受了伤|受伤|昏迷|昏倒|复活|牺牲)/,
    // 剧情记帐
    /(第[一二三四五六七八九十百\d]+章|上一幕|这一幕|下一幕|剧情|副本里|世界里|设定里)/,
  ];

  /** 判断一条记忆内容更像"用户事实"还是"剧情片段"。 */
  function looksLikeStory(content) {
    const text = cleanText(content, 500);
    if (!text) return false;
    return STORY_PATTERNS.some((pattern) => pattern.test(text));
  }

  /* 真正该记的东西：玩家本人的状态、偏好、关系、约定、处境。
   * 分成两组，命中任意一组即可：
   *   - 明确的事实句式（叫/喜欢/怕/过敏…）
   *   - "玩家 + 是/在/有" 这类本人属性
   * 两组都不中就当成剧情描述拒收（"巨龙被击败了"）。 */
  const FACT_HINT_RE = /(叫|名字|称呼|喜欢|不喜欢|讨厌|爱|怕|担心|习惯|想要|需要|住在|来自|养|工作|职业|上学|学校|生日|年龄|岁|约好|约定|答应|计划|过敏|不吃|不能吃|打算)/;
  const PLAYER_ATTR_RE = /(玩家|我)(是|在|有|没|没有|不|住|养|做|学|姓)/;

  /** 一条记忆该不该收：是剧情就拒，是事实就收。
   * 顺序是刻意的：
   *   ① 空 → 拒；
   *   ② 命中剧情特征 → 拒（这一步最硬，剧情绝不入库）；
   *   ③ 有明显事实句式 / 玩家属性句式 → 收；
   *   ④ 短句（没有剧情特征）→ 收：真实记忆常常就是"考拉""住在杭州"这种短名词短语，
   *      按句式卡会把它们误杀，而剧情至少要有个动作或场景才成立；
   *   ⑤ 其余 → 拒（长句又没有事实句式，多半是叙述）。 */
  function classifyMemory(content) {
    const text = cleanText(content, 500);
    if (!text) return { keep: false, reason: "empty" };
    if (looksLikeStory(text)) return { keep: false, reason: "story" };
    if (FACT_HINT_RE.test(text) || PLAYER_ATTR_RE.test(text)) return { keep: true, reason: "fact" };
    if (text.length <= 16) return { keep: true, reason: "short-fact" };
    return { keep: false, reason: "no-fact" };
  }

  /* ---------- 主题与"改口" ----------
   * 记忆要能改口：昨天记「玩家喜欢咖啡」，今天玩家说「我现在不喜欢咖啡了」，
   * 必须是**替换**旧的那条，而不是两条并存。
   * 做法：每条记忆带一个"主题"键，同一个主题只保留最新一条。
   */
  const DEFAULT_TOPIC_MAX = 12;

  /** 主题归一：去掉修饰词与标点，只留核心词，避免"喜欢的饮料"和"饮料"变成两个主题。 */
  function normalizeTopic(raw) {
    const text = cleanText(raw, 40);
    if (!text) return "";
    const stripped = text
      .replace(/[（(].*?[)）]/g, "")
      .replace(/(喜欢的|讨厌的|最爱|不爱|最怕|害怕|关于|玩家的|用户的|我的|自己|事情|东西|那些|这些|一个|一种)/g, "")
      .replace(/[的了呢吗吧啊哦]+$/g, "")
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");
    return stripped.slice(0, DEFAULT_TOPIC_MAX).toLowerCase();
  }

  /* 身份/偏好这类主题有个特点：**具体值会变**。
   * 「小林」和「小琳」推出来永远对不上，但它们说的是同一件事（称呼）。
   * 所以先认"锚点"：一句话只要在说这件事，就统一归到同一个主题词，
   * 改口才能真正覆盖。锚点不命中时再退回按句式取具体词。 */
  const TOPIC_ANCHORS = [
    // 注意把 `叫` 放到最后：正则的可选分支是"先匹配先赢"，
    // 写在前面的 `叫我` 会把 `叫小林` 里的 `叫` 提前吃掉。
    [/称呼|名字|姓名|外号|昵称|改名叫|名叫|大家都叫|叫/, "称呼"],
    [/住址|地址|城市|搬家|住在|来自|老家/, "住处"],
    [/年龄|生日|多大|几岁/, "年龄"],
    [/工作|职业|公司|上班|上学|学校|专业/, "工作"],
    [/约定|约好|答应|计划|见面|碰头/, "约定"],
  ];

  function anchorTopic(text) {
    const value = cleanText(text, 500);
    if (!value) return "";
    for (const pair of TOPIC_ANCHORS) {
      if (pair[0].test(value)) return pair[1];
    }
    return "";
  }

  /** 从正文里推主题：模型没按格式写主题时的兜底。
   * 先认锚点（称谓/住处/年龄/工作/约定——这些的具体值会变，必须归到一起），
   * 认不出来再按句式取"这件事是什么"：
   *   「玩家喜欢咖啡」→ 咖啡；「玩家怕黑」→ 黑。实在取不出来返回空 —— 宁可不覆盖。 */
  function inferTopic(content) {
    const text = cleanText(content, 500);
    if (!text) return "";
    const anchor = anchorTopic(text);
    if (anchor) return anchor;
    const patterns = [
      /(?:喜欢|不喜欢|爱喝|爱吃|爱|讨厌|最怕|害怕|怕|担心|想要|在学|正在学|会)([^，。；、！？,;!?\s]{1,12})/,
      /(?:住在|来自|在)([^，。；、！？,;!?\s]{1,10})(?:工作|上学|生活|住)/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const topic = normalizeTopic(match[1]);
        if (topic) return topic;
      }
    }
    // 没有可用的句式：取第一个逗号前的主体，并剥掉"玩家/我"这类主语。
    const clause = text.split(/[，。；、！？,;!?\s]/)[0] || "";
    return normalizeTopic(clause.replace(/^(?:玩家|用户|我|你们|你)/, ""));
  }

  /* 同义词：模型今天写「称呼」、昨天写「名字」，指的是同一件事。
   * 不归一的话，"改口"就会变成两条互相矛盾的记忆并存。
   * 只在比较时归一，显示出来的仍是模型原本写的词。 */
  const TOPIC_SYNONYMS = [
    [/称呼|名字|姓名|外号|怎么叫/, "称呼"],
    [/饮料|喝的|饮品|咖啡|茶/, "饮料"],
    [/食物|吃的|口味|忌口|爱吃/, "食物"],
    [/害怕|恐惧|怕/, "怕的东西"],
    [/约定|约好|答应|计划/, "约定"],
    [/住址|地址|城市|来自|住在/, "住处"],
    [/年龄|多大|岁/, "年龄"],
    [/工作|职业/, "工作"],
  ];

  function canonicalTopic(topic) {
    const value = normalizeTopic(topic);
    if (!value) return "";
    for (const pair of TOPIC_SYNONYMS) {
      if (pair[0].test(value)) return pair[1];
    }
    return value;
  }

  /** 读一条记忆的主题。
   * 顺序很重要：**先按当前规则从正文重算**，再退回记下来的元数据。
   * 因为规则会随版本改进，早年存下的主题可能已经过时（"叫小林" → 现在是"称呼"），
   * 只认存下来的值会导致老条目永远覆盖不了。 */
  function entryTopic(entry) {
    const inferred = inferTopic(entry && entry.content);
    if (inferred) return inferred;
    return entry && entry.rw_source ? normalizeTopic(entry.rw_source.topic) : "";
  }

  /**
   * 判断新记忆是否在说同一件事，该覆盖旧的那条。命中任意一条即可：
   *   ① 两个主题归一后一样（含同义词：「称呼」vs「名字」）；
   *   ② 新主题词出现在旧正文里（模型写「称呼」，旧条目正文是「玩家叫小林」）；
   *   ③ 从新**正文**里推出来的主题和旧主题一样（模型写「称呼」、正文「改名叫小琳」，
   *      旧条目正文「叫小林」——两边推出来都是名字，于是对上）；
   *   ④ 旧正文包含新正文，或两个主题有包含关系。
   * 宁可多替换一次（替换记录留在面板里可查），
   * 也不要让"改口"变成两条互相矛盾的记忆并存。
   */
  function isSameTopic(entry, newTopic, newContent) {
    const topic = canonicalTopic(newTopic);
    const inferred = canonicalTopic(inferTopic(newContent));
    const oldTopic = canonicalTopic(entryTopic(entry));
    const oldContent = cleanText(entry && entry.content, 2000);
    if (!topic && !inferred) return false;
    if (topic && oldTopic && oldTopic === topic) return true;
    if (inferred && oldTopic && oldTopic === inferred) return true;
    if (topic && oldContent && oldContent.indexOf(topic) >= 0) return true;
    if (inferred && oldContent && oldContent.indexOf(inferred) >= 0) return true;
    if (oldContent && newContent && oldContent.indexOf(newContent) >= 0) return true;
    if (topic && oldTopic && (oldTopic.indexOf(topic) >= 0 || topic.indexOf(oldTopic) >= 0)) return true;
    return false;
  }

  /** 忠实读取：把世界书里的条目变成界面能直接用的形状，不改动任何内容。 */
  function listEntries(entries) {
    const source = entries && typeof entries === "object" ? entries : {};
    const keys = Object.keys(source);
    const rows = [];
    keys.forEach((key) => {
      const entry = source[key] || {};
      const content = cleanText(entry.content, 2000);
      if (!content) return;
      const uid = Number(entry.uid);
      const sourceInfo = normalizeSource(entry.rw_source);
      rows.push({
        key,
        uid: Number.isFinite(uid) ? uid : null,
        content,
        source: sourceInfo,
        // 主题：优先用记下来的，没有就按正文现推（这样旧条目也能被新记忆正确覆盖）。
        topic: entryTopic(entry),
        // 这条替换掉的旧内容（如果有），用于解释"为什么这条变了"。
        replacedContent: cleanText(sourceInfo.replacedContent, 200),
        constant: entry.constant !== false,
        disabled: entry.disable === true,
      });
    });
    rows.sort((a, b) => {
      const aUid = a.uid === null ? Number.MAX_SAFE_INTEGER : a.uid;
      const bUid = b.uid === null ? Number.MAX_SAFE_INTEGER : b.uid;
      return aUid - bUid;
    });
    return rows;
  }

  function nextUid(entries) {
    let max = 0;
    Object.keys(entries || {}).forEach((key) => {
      max = Math.max(max, Number((entries[key] || {}).uid) || 0);
    });
    return max + 1;
  }

  function trim(entries, max) {
    const limit = Number(max) > 0 ? Number(max) : DEFAULT_MAX;
    const keys = Object.keys(entries || {});
    if (keys.length <= limit) return { entries: entries || {}, removed: [] };
    const ordered = keys
      .map((key) => ({ key, uid: Number((entries[key] || {}).uid) || 0 }))
      .sort((a, b) => a.uid - b.uid);
    const removed = [];
    const kept = Object.assign({}, entries);
    while (ordered.length > limit) {
      const oldest = ordered.shift();
      removed.push({ uid: oldest.uid, content: cleanText((kept[oldest.key] || {}).content, 200) });
      delete kept[oldest.key];
    }
    return { entries: kept, removed };
  }

  /**
   * 写入一批记忆。同一主题的旧记忆会被**替换**（这是"改口"能生效的关键）。
   * @param items  字符串数组，或 {topic, content} 数组
   * @returns { entries, added, skipped, replaced, removed }
   *   added    —— 真正新写入的条数
   *   skipped  —— 内容一模一样、被跳过的条数
   *   replaced —— 因为主题相同而被替换掉的旧记忆（要告诉用户，不能悄悄改）
   *   removed  —— 因为超过上限被挤掉的最旧条目
   */
  function applyMemories(entries, items, options) {
    const opts = options || {};
    const max = Number(opts.max) > 0 ? Number(opts.max) : DEFAULT_MAX;
    const source = normalizeSource(opts.source);
    const origin = opts.origin === ORIGIN.USER ? ORIGIN.USER : ORIGIN.MODEL;
    const at = source.at || new Date().toISOString();
    const next = Object.assign({}, entries || {});
    let uid = nextUid(next);
    let added = 0;
    let skipped = 0;
    const replaced = [];
    const rejected = [];

    (Array.isArray(items) ? items : []).forEach((raw) => {
      const item = raw && typeof raw === "object"
        ? { topic: normalizeTopic(raw.topic), content: cleanText(raw.content, 500) }
        : { topic: "", content: cleanText(raw, 500) };
      let topic = item.topic;
      const text = item.content;
      if (!text) return;
      // 底线一：剧情不是用户事实。判断在纯逻辑层做，不靠模型自觉。
      const verdict = classifyMemory(text);
      if (!verdict.keep) {
        rejected.push({ content: text, reason: verdict.reason });
        return;
      }
      if (!topic) topic = inferTopic(text);

      // 内容完全一样：跳过，不重复记。
      const duplicateKey = Object.keys(next).find((key) => cleanText(next[key] && next[key].content, 2000) === text);
      if (duplicateKey) { skipped += 1; return; }

      // 同一件事：替换旧的，而不是并存。
      let replaceKey = null;
      if (topic) {
        replaceKey = Object.keys(next).find((key) => isSameTopic(next[key], topic, text)) || null;
      }
      if (replaceKey) {
        replaced.push({
          key: replaceKey,
          uid: Number(next[replaceKey].uid) || null,
          content: cleanText(next[replaceKey].content, 200),
          topic,
        });
        const previous = next[replaceKey];
        next[replaceKey] = Object.assign({}, previous, {
          content: text,
          comment: text.slice(0, 24),
          rw_source: Object.assign({}, normalizeSource(previous.rw_source), {
            file: source.file,
            messageIndex: source.messageIndex,
            at,
            origin,
            topic,
            // 记下它替换了哪条旧内容，便于回头解释"为什么这条变了"。
            replacedContent: cleanText(previous.content, 200),
          }),
        });
        added += 1;
        return;
      }

      next[String(uid)] = {
        uid,
        key: [],
        keysecondary: [],
        comment: text.slice(0, 24),
        content: text,
        // 自动记忆一律常驻上下文：它是必须记住的要点，靠关键词匹配会漏。
        constant: true,
        disable: false,
        displayIndex: uid,
        // 我们的元数据：来源、时间、主题。对世界书格式是额外字段，读取方会忽略。
        rw_source: {
          file: source.file,
          messageIndex: source.messageIndex,
          at,
          origin,
          topic,
        },
      };
      uid += 1;
      added += 1;
    });

    const trimmed = trim(next, max);
    return { entries: trimmed.entries, added, skipped, replaced, rejected, removed: trimmed.removed };
  }

  /** 改一条记忆的正文（保留来源与时间，改完标注是用户改的）。 */
  function updateEntry(entries, key, content, options) {
    const text = cleanText(content, 500);
    if (!text) return { ok: false, reason: "empty", entries: entries || {} };
    const next = Object.assign({}, entries || {});
    const target = next[String(key)];
    if (!target) return { ok: false, reason: "missing", entries: next };
    const at = (options && options.at) || new Date().toISOString();
    next[String(key)] = Object.assign({}, target, {
      content: text,
      comment: text.slice(0, 24),
      rw_source: Object.assign({}, normalizeSource(target.rw_source), { at, origin: ORIGIN.USER, edited: true }),
    });
    return { ok: true, entries: next };
  }

  /** 删一条记忆。删掉就必须真的从注入里消失。 */
  function removeEntry(entries, key) {
    const next = Object.assign({}, entries || {});
    if (!next[String(key)]) return { ok: false, reason: "missing", entries: next };
    delete next[String(key)];
    return { ok: true, entries: next };
  }

  return {
    ORIGIN,
    DEFAULT_MAX,
    cleanText,
    normalizeSource,
    looksLikeStory,
    classifyMemory,
    normalizeTopic,
    inferTopic,
    entryTopic,
    isSameTopic,
    listEntries,
    nextUid,
    trim,
    applyMemories,
    updateEntry,
    removeEntry,
  };
});
