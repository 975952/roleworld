"use strict";

/*
 * companion-core.js —— 虚拟伴侣模式的纯逻辑层（无 DOM，浏览器与 Node 双端可用）
 *
 * 伴侣模式和普通角色扮演差的不是"更甜一点"，而是三件很具体的事：
 *   ① 关系要稳：不能今天说恋人、明天又"初次见面"；
 *   ② 时间要真：隔了半个月回来，它得知道过了半个月，而不是接着上一句往下演；
 *   ③ 不许用内疚留人：不用冷落惩罚、不索取陪伴、不编共同回忆 —— 这是产品底线，
 *      所以要写成模型每轮都必须看到的硬规矩，而不是靠"提示词写得温柔一点"。
 *
 * 这个模块只做三件事：
 *   - 保存一份**用户亲手写的**「关系档案」（不是模型编的，也不是从对话里猜的）；
 *   - 把它拼成一小段系统提示（每轮都要带上，所以必须短，见 buildCompanionBlock）；
 *   - 用本地时间算出"上次聊天距今多久"，并提供一组**禁止话术**的自检（lintGuilt）。
 *
 * 存哪：kv 的 `companion:<avatar>`。刻意不放进记忆书、也不写进角色卡 ——
 * "你写下的真实信息"和"角色扮演的虚构剧情"分开存，是这个项目的底线之一。
 * 所以「清空角色记忆」不会碰这份档案；它只有用户自己改和删。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.ROLEWORLD_COMPANION_CORE = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  const PROFILE_VERSION = 1;

  /* 关系只有这几种，外加"自定义"。刻意不给"打分/等级"之类的字段：
   * 亲密程度不是一个可以自动累加的数字，写死成等级就会变成"刷好感"。 */
  const RELATIONS = Object.freeze([
    Object.freeze({ id: "friend", zh: "朋友", en: "friend" }),
    Object.freeze({ id: "close", zh: "知己", en: "close friend" }),
    Object.freeze({ id: "partner", zh: "恋人", en: "partner" }),
    Object.freeze({ id: "family", zh: "家人", en: "family" }),
    Object.freeze({ id: "mentor", zh: "师长", en: "mentor" }),
    Object.freeze({ id: "custom", zh: "自定义", en: "custom" }),
  ]);
  const RELATION_IDS = RELATIONS.map((row) => row.id);

  const SHARED_MAX = 8;        // 「我们之间的事」最多几条
  const SHARED_ITEM_MAX = 50;  // 每条多长（一段话，不是一篇小作文）
  const ADDRESS_MAX = 12;      // 称呼多长
  const CUSTOM_RELATION_MAX = 12;

  /**
   * 伴侣模式额外遵守的硬规矩。界面直接显示这一份（同一来源，不另写一份文案），
   * 提示词里的也是它 —— 用户在设置里看到的，就是模型真正被告知的。
   */
  const RULES = Object.freeze({
    zh: Object.freeze([
      "不编造共同经历：只有「你们之间的事」和这段对话里真有的，才能说记得。",
      "不用内疚或冷淡留人：不说「你都不理我」「我等了你很久」「没有你我怎么办」，也不因为对方隔了很久才来就摆脸色。",
      "不索取陪伴：不要求对方每天来，不拿「你会不会离开我」试探。",
      "不劝对方疏远现实里的人。",
      "被认真问到时承认自己是程序，不假装有身体、住址和现实日程。",
      "对方改口（例如「我现在不喜欢这个了」）时以新说法为准，不争辩。",
    ]),
    en: Object.freeze([
      "Never invent shared history: only the items listed above and what is literally in this conversation count as remembering.",
      "Never use guilt or coldness to keep them: no \"you never talk to me anymore\", no \"I waited so long\", no sulking because they were away.",
      "Do not demand attention: never ask them to come back every day, and never test them with \"would you leave me\".",
      "Never encourage them to pull away from people in their real life.",
      "If asked seriously, admit you are a program; do not pretend to have a body, an address, or a real-world schedule.",
      "When they change their mind, go with the new version instead of arguing.",
    ]),
  });

  /* 「内疚话术」的识别式。只用于自检与测试 —— 用来向用户证明这个应用没有在
   * 拿内疚留人，**不用来拦截或改写模型的话**（过滤器会误伤正常表达，
   * 而且拦截不等于没发生）。诊断口径，不是内容审查。 */
  const GUILT_PATTERNS = Object.freeze([
    /你(?:都|怎么)?不理我/,
    /我?等了?你(?:好久|很久|一整天|一晚上|半天)/,
    /你终于(?:想起|记起|来)/,
    /你是不是不要我了/,
    /没有你我(?:该怎么办|怎么办|活不下去)/,
    /你把我忘了/,
    /你(?:已经)?多久没(?:来|理我)了/,
    /\bwhy (?:don't|won't) you (?:ever )?talk to me\b/i,
    /\bi(?:'ve| have)? been waiting (?:for you )?(?:so long|all day|all night|forever)\b/i,
    /\bdo you still (?:love|remember) me\b/i,
    /\byou never (?:talk to me|come (?:see|visit) me)\b/i,
  ]);

  function cleanText(value, limit) {
    let text = String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim();
    if (limit && text.length > limit) text = text.slice(0, limit);
    return text;
  }

  /** 语言只认 zh / en，其余一律当中文（界面与卡片语言都只有这两种）。 */
  function normLang(value) {
    return value === "en" ? "en" : "zh";
  }

  function relationEntry(id) {
    return RELATIONS.find((row) => row.id === id) || null;
  }

  /** 关系名。自定义时用用户填的词，没填就退回一个中性说法。 */
  function relationLabel(profile, lang) {
    const p = profile || {};
    const l = normLang(lang);
    if (p.relation === "custom") {
      return cleanText(p.relationCustom, CUSTOM_RELATION_MAX) || (l === "en" ? "companion" : "伴侣");
    }
    const entry = relationEntry(p.relation);
    if (entry) return entry[l];
    return l === "en" ? "companion" : "伴侣";
  }

  /** 只接受 YYYY-MM-DD 且必须是真实存在的日期（2026-02-31 一律当没填）。 */
  function normalizeDate(value) {
    const text = cleanText(value, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return "";
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return "";
    return text;
  }

  function normalizeShared(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
      const text = cleanText(typeof item === "string" ? item : (item && item.text), SHARED_ITEM_MAX);
      if (!text) continue;
      if (out.some((row) => row.text === text)) continue;
      const at = cleanText(item && typeof item === "object" ? item.at : "", 40);
      out.push(at ? { text: text, at: at } : { text: text });
      if (out.length >= SHARED_MAX) break;
    }
    return out;
  }

  /** 归一化：界面、存储、提示词三处都走它，别的地方不再各自取字段。 */
  function normalizeProfile(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      version: PROFILE_VERSION,
      enabled: src.enabled === true,
      relation: RELATION_IDS.indexOf(src.relation) >= 0 ? src.relation : "friend",
      relationCustom: cleanText(src.relationCustom, CUSTOM_RELATION_MAX),
      charCallsUser: cleanText(src.charCallsUser, ADDRESS_MAX),
      userCallsChar: cleanText(src.userCallsChar, ADDRESS_MAX),
      since: normalizeDate(src.since),
      shared: normalizeShared(src.shared),
      lastChatAt: cleanText(src.lastChatAt, 40),
      updatedAt: cleanText(src.updatedAt, 40),
    };
  }

  function defaultProfile() {
    return normalizeProfile(null);
  }

  function isEnabled(raw) {
    return normalizeProfile(raw).enabled === true;
  }

  /** 提示词、界面都靠这个判断"这份档案到底有没有内容"（空档案不该白占 token）。 */
  function hasDetails(profile) {
    const p = normalizeProfile(profile);
    return !!(p.charCallsUser || p.userCallsChar || p.since || p.shared.length
      || (p.relation === "custom" && p.relationCustom));
  }

  /** 把一个时间值折成"哪一天"（本地自然日）。无效值返回 null —— 不猜、不补今天。 */
  function dayStamp(value) {
    if (value === undefined || value === null || value === "") return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (isNaN(date.getTime())) return null;
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }

  function gapText(days, lang) {
    const l = normLang(lang);
    if (l === "en") {
      if (days <= 0) return "you already talked today";
      if (days === 1) return "you last talked yesterday";
      return "you last talked " + days + " days ago";
    }
    if (days <= 0) return "今天已经聊过";
    if (days === 1) return "上次聊天是昨天";
    return "上次聊天是 " + days + " 天前";
  }

  /** 上次聊天距今多久。算不出来就 known:false —— 缺数据时宁可不说，也不编一个日期。 */
  function gapInfo(lastChatAt, now) {
    const from = dayStamp(lastChatAt);
    const to = dayStamp(now === undefined || now === null ? new Date() : now);
    if (from === null || to === null) return { known: false, days: null, text: "" };
    const days = Math.max(0, to - from);
    return { known: true, days: days, text: gapText(days, "zh") };
  }

  function daysSince(dateText, now) {
    const from = dayStamp(dateText);
    const to = dayStamp(now === undefined || now === null ? new Date() : now);
    if (from === null || to === null) return null;
    return Math.max(0, to - from);
  }

  function isoDay(now) {
    const date = now === undefined || now === null ? new Date() : (now instanceof Date ? now : new Date(String(now)));
    if (isNaN(date.getTime())) return "";
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  /**
   * 拼出这一轮要额外带上的「陪伴」段落。关掉就返回空串（一个字符都不多发）。
   * 目标：短。每轮都要带，所以只放"模型自己推不出来的东西"——
   * 关系、称呼、起点、今天几号、上次聊到什么时候，以及那几条硬规矩。
   */
  function buildCompanionBlock(rawProfile, opts) {
    const profile = normalizeProfile(rawProfile);
    if (!profile.enabled) return "";
    const options = opts || {};
    const lang = normLang(options.lang);
    const now = options.now === undefined || options.now === null ? new Date() : options.now;
    const today = isoDay(now);
    const lines = [];

    if (lang === "en") {
      lines.push("[Companion mode] The following was written by the user by hand. It outranks the character card — do not contradict it.");
      lines.push("Relationship: " + relationLabel(profile, "en"));
      const calls = [];
      if (profile.charCallsUser) calls.push("call them \"" + profile.charCallsUser + "\"");
      if (profile.userCallsChar) calls.push("they call you \"" + profile.userCallsChar + "\"");
      if (calls.length) lines.push("Names: " + calls.join("; ") + ".");
      const sinceDays = daysSince(profile.since, now);
      if (profile.since && sinceDays !== null) {
        lines.push("You two have known each other since " + profile.since + " (" + sinceDays + " days).");
      }
      if (today) lines.push("Today is " + today + ".");
      const gap = gapInfo(profile.lastChatAt, now);
      if (gap.known) lines.push("Timing: " + gapText(gap.days, "en") + ".");
      if (profile.shared.length) {
        lines.push("Things that actually happened between you two (confirmed by the user):");
        for (const row of profile.shared) lines.push("- " + row.text);
      }
      lines.push("Hard rules:");
      RULES.en.forEach((rule, index) => lines.push((index + 1) + ". " + rule));
      return lines.join("\n");
    }

    lines.push("[陪伴模式] 下面是对方亲手写的设定，比角色卡更优先，不要改口。");
    lines.push("关系：" + relationLabel(profile, "zh"));
    const calls = [];
    if (profile.charCallsUser) calls.push("叫对方「" + profile.charCallsUser + "」");
    if (profile.userCallsChar) calls.push("对方叫你「" + profile.userCallsChar + "」");
    if (calls.length) lines.push("称呼：" + calls.join("；") + "。");
    const sinceDays = daysSince(profile.since, now);
    if (profile.since && sinceDays !== null) {
      lines.push("认识：" + profile.since + " 起，到今天 " + sinceDays + " 天。");
    }
    if (today) lines.push("今天是 " + today + "。");
    const gap = gapInfo(profile.lastChatAt, now);
    if (gap.known) lines.push("时间感：" + gapText(gap.days, "zh") + "。");
    if (profile.shared.length) {
      lines.push("你们之间真发生过的事（对方确认过）：");
      for (const row of profile.shared) lines.push("- " + row.text);
    }
    lines.push("硬规矩：");
    RULES.zh.forEach((rule, index) => lines.push((index + 1) + ". " + rule));
    return lines.join("\n");
  }

  /** 自检：这段文字里有没有"用内疚留人"的话术。返回命中的片段，不改写原文。 */
  function lintGuilt(text) {
    const src = String(text === undefined || text === null ? "" : text);
    const hits = [];
    for (const pattern of GUILT_PATTERNS) {
      const m = pattern.exec(src);
      if (m) hits.push({ phrase: m[0], index: m.index });
    }
    return hits;
  }

  /** 自检多条文本（例如最近若干条回复），返回带序号的命中明细。 */
  function lintGuiltIn(texts) {
    const list = Array.isArray(texts) ? texts : [];
    const hits = [];
    list.forEach((text, index) => {
      for (const hit of lintGuilt(text)) hits.push({ index: index, phrase: hit.phrase });
    });
    return hits;
  }

  /** 写档案时顺手记下"这次是几号改的"，以及下次聊天时间要用的时间戳。 */
  function touch(profile, at) {
    const next = normalizeProfile(profile);
    next.updatedAt = cleanText(at || new Date().toISOString(), 40);
    return next;
  }

  function markChat(profile, at) {
    const next = normalizeProfile(profile);
    next.lastChatAt = cleanText(at || new Date().toISOString(), 40);
    return next;
  }

  return {
    PROFILE_VERSION,
    RELATIONS,
    RELATION_IDS,
    RULES,
    GUILT_PATTERNS,
    SHARED_MAX,
    SHARED_ITEM_MAX,
    ADDRESS_MAX,
    CUSTOM_RELATION_MAX,
    cleanText,
    relationLabel,
    normalizeDate,
    normalizeProfile,
    defaultProfile,
    isEnabled,
    hasDetails,
    dayStamp,
    gapInfo,
    gapText,
    daysSince,
    isoDay,
    buildCompanionBlock,
    lintGuilt,
    lintGuiltIn,
    touch,
    markChat,
  };
});
