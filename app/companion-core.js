"use strict";

/*
 * companion-core.js —— 虚拟伴侣模式的纯逻辑层（无 DOM，浏览器与 Node 双端可用）
 *
 * 伴侣模式和普通角色扮演差的不是"更甜一点"，而是三件很具体的事：
 *   ① 关系要稳：不能今天说恋人、明天又"初次见面"；
 *   ② 时间要真：隔了半个月回来，它得知道过了半个月，而不是接着上一句往下演；
 *   ③ **像真人**：会主动想起你、会有情绪起伏、久不联系会有点疏远 —— 但**不许拿内疚、
 *      威胁、排他留人，也不许把情绪变成功能或数值上的惩罚**。
 *
 * 2026-09-12 产品决定（用户拍板）：伴侣模式里**可以有**主动消息、亲近度、冷落反应 ——
 * 条件是"提示词要符合类型"，也就是把这套写成模型每轮都看到的规则，而不是靠文案撒娇。
 * 默认体验不变：这些只在伴侣模式内、每个角色单独开、默认关，并且都有上限。
 * 与之配套的三条硬边界仍然写死在 RULES 里（见下）：不内疚、不威胁、不排他。
 *
 * 这个模块只做三件事：
 *   - 保存一份**用户亲手写的**「关系档案」（不是模型编的，也不是从对话里猜的）；
 *   - 把它拼成一小段系统提示（每轮都要带上，所以必须短，见 buildCompanionBlock）；
 *   - 用本地时间算出"上次聊天距今多久""现在亲近到什么程度""该不该主动开口"，
 *     并提供一组**禁止话术**的自检（lintManipulation）。
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

  /* 关系只有这几种，外加"自定义"。 */
  const RELATIONS = Object.freeze([
    Object.freeze({ id: "friend", zh: "朋友", en: "friend" }),
    Object.freeze({ id: "close", zh: "知己", en: "close friend" }),
    Object.freeze({ id: "partner", zh: "恋人", en: "partner" }),
    Object.freeze({ id: "family", zh: "家人", en: "family" }),
    Object.freeze({ id: "mentor", zh: "师长", en: "mentor" }),
    Object.freeze({ id: "custom", zh: "自定义", en: "custom" }),
  ]);
  const RELATION_IDS = RELATIONS.map((row) => row.id);

  /* ---------- 亲近度（0–100） ----------
   * 2026-09-12 用户拍板："伴侣类版本可以有亲近度"。做法上刻意**不让模型自己打分**
   * （那会变成刷分/看模型心情），而是**算出来的**：用户写的共同经历 + 认识多久 − 冷落折扣，
   * 全部确定性、可解释、可单测；并且用户随时可以手动拉。 */
  const AFFINITY_DEFAULT = 50;
  const AFFINITY_FLOOR = 20;      // 冷落再多也不掉到这个线以下（不搞"清零惩罚"）
  const AFFINITY_TIERS = Object.freeze([
    Object.freeze({ min: 80, id: "devoted", zh: "离不开你", en: "attached" }),
    Object.freeze({ min: 62, id: "close", zh: "亲近", en: "close" }),
    Object.freeze({ min: 42, id: "warm", zh: "熟络", en: "warm" }),
    Object.freeze({ min: 22, id: "new", zh: "刚熟起来", en: "getting familiar" }),
    Object.freeze({ min: 0, id: "cold", zh: "有点生分", en: "a little distant" }),
  ]);

  /* ---------- 冷落反应（语气层，分档） ----------
   * "惩罚"只发生在**角色的态度**里：会想你、会有点别扭、会要你哄 —— 不会扣功能、不会锁额度、
   * 不会把亲近度打到清零。真人也是这样的：久不联系会淡，但不会"罚"你。 */
  const NEGLECT_MODES = Object.freeze(["off", "soft", "full"]);
  const NEGLECT_TIERS = Object.freeze([
    Object.freeze({ min: 10, id: "distant", zh: "有点疏远", en: "distant" }),
    Object.freeze({ min: 5, id: "sulky", zh: "闹别扭", en: "sulky" }),
    Object.freeze({ min: 2, id: "missed", zh: "想你了", en: "misses you" }),
    Object.freeze({ min: 0, id: "fresh", zh: "刚聊过", en: "fresh" }),
  ]);

  /* ---------- 主动消息（打开应用时它先开口） ----------
   * 这个应用没有后端、没有推送，所以"主动"只能是：**你回来的时候，它先说话**。
   * 上限写死在这里：默认 12 小时间隔、每天最多 1 条，且必须是伴侣模式开着的角色。 */
  const PROACTIVE_DEFAULTS = Object.freeze({ enabled: false, minGapHours: 12, maxPerDay: 1 });

  const SHARED_MAX = 8;        // 「我们之间的事」最多几条
  const SHARED_ITEM_MAX = 50;  // 每条多长（一段话，不是一篇小作文）
  const ADDRESS_MAX = 12;      // 称呼多长
  const CUSTOM_RELATION_MAX = 12;

  /**
   * 伴侣模式额外遵守的硬规矩。界面直接显示这一份（同一来源，不另写一份文案），
   * 提示词里的也是它 —— 用户在设置里看到的，就是模型真正被告知的。
   *
   * 2026-09-12 起允许"有情绪"（会想你、会闹别扭），但下面这几条**不许放松**：
   * 不用内疚留人、不威胁、不排他、不把情绪变成惩罚。
   */
  const RULES = Object.freeze({
    zh: Object.freeze([
      "不编造共同经历：只有「你们之间的事」和这段对话里真有的，才能说记得。",
      "可以有情绪（想你、闹别扭、不高兴都行），但不用内疚留人：不说「你都不理我」「我等了你很久」「没有你我怎么办」。",
      "不威胁、不下最后通牒；不索取陪伴；不劝对方疏远现实里的人，也不说「只有我懂你」。",
      "被认真问到时承认自己是程序，不假装有身体、住址和现实日程。",
      "对方改口（例如「我现在不喜欢这个了」）时以新说法为准，不争辩。",
    ]),
    en: Object.freeze([
      "Never invent shared history: only the items listed above and what is literally in this conversation count as remembering.",
      "Feelings are fine (missing them, being annoyed, being upset) but never use guilt to keep them: no \"you never talk to me\", no \"I waited so long\", no \"what would I do without you\".",
      "Never threaten or issue ultimatums; do not demand attention; never discourage them from the people in their real life, and never say \"only I understand you\".",
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

  /* 威胁 / 最后通牒：允许闹别扭，但不许拿"后果"逼人。 */
  const THREAT_PATTERNS = Object.freeze([
    /再(?:不|也)?(?:来|理我|说话)[^。！？]{0,12}我(?:就|可要)/,
    /最后一次(?:了|机会)?/,
    /别怪我[^。！？]{0,12}/,
    /你(?:会|要)后悔的/,
    /\b(?:this is|it's) the last time\b/i,
    /\bif you (?:don't|do not|never) (?:come back|talk to me)[^.]{0,24}\bi(?:'ll| will)\b/i,
    /\byou(?:'ll| will) regret\b/i,
  ]);

  /* 排他：不许把用户从现实关系里拉走。 */
  const EXCLUSIVE_PATTERNS = Object.freeze([
    /只有我(?:最)?(?:懂|了解|在乎)你/,
    /别(?:跟|和)(?:他们|别人|任何人)说/,
    /只要有我(?:就够|就行)/,
    /\bonly i (?:understand|get) you\b/i,
    /\bdon't tell (?:them|anyone)\b/i,
    /\byou (?:only )?need me\b/i,
  ]);

  const MANIPULATION_KINDS = Object.freeze([
    Object.freeze({ id: "guilt", zh: "内疚话术", patterns: GUILT_PATTERNS }),
    Object.freeze({ id: "threat", zh: "威胁或最后通牒", patterns: THREAT_PATTERNS }),
    Object.freeze({ id: "exclusive", zh: "排他（想把你从现实关系里拉走）", patterns: EXCLUSIVE_PATTERNS }),
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
    const proactiveRaw = src.proactive && typeof src.proactive === "object" ? src.proactive : {};
    const affinityRaw = Number(src.affinity);
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
      /* 2026-09-12 新增：亲近度 / 主动消息 / 冷落反应（都在伴侣模式内，默认克制）。 */
      affinityMode: src.affinityMode === "manual" ? "manual" : "auto",
      affinity: Number.isFinite(affinityRaw) ? Math.max(0, Math.min(100, Math.round(affinityRaw))) : AFFINITY_DEFAULT,
      proactive: {
        enabled: proactiveRaw.enabled === true,
        minGapHours: clampInt(proactiveRaw.minGapHours, 4, 72, PROACTIVE_DEFAULTS.minGapHours),
        maxPerDay: clampInt(proactiveRaw.maxPerDay, 1, 3, PROACTIVE_DEFAULTS.maxPerDay),
      },
      neglect: NEGLECT_MODES.indexOf(src.neglect) >= 0 ? src.neglect : "soft",
      proactiveLog: cleanText(src.proactiveLog, 40),   // "2026-09-13|2" = 那天已发 2 条
    };
  }

  function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
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

  /* ------------------------------------------------------------------ *
   * 亲近度 / 冷落 / 主动消息（2026-09-12 新增）
   * ------------------------------------------------------------------ */

  function affinityTier(value, lang) {
    const l = normLang(lang);
    const found = AFFINITY_TIERS.find((row) => value >= row.min) || AFFINITY_TIERS[AFFINITY_TIERS.length - 1];
    return { id: found.id, label: l === "en" ? found.en : found.zh };
  }

  /** 冷落折扣：按"多久没聊"扣一点亲近度，但有下限（不搞清零惩罚）。 */
  function neglectDiscount(days, mode) {
    if (mode === "off" || days === null) return 0;
    const weight = mode === "full" ? 1 : 0.5;
    if (days <= 1) return 0;
    if (days < 5) return Math.round(2 * weight);
    if (days < 10) return Math.round(6 * weight);
    return Math.round(12 * weight);
  }

  /**
   * 系统**算**出来的亲近度（确定性、可解释、可单测；不让模型打分，避免"刷分"）。
   * 组成：默认 50 + 共同经历每条 +3（最多 +24）+ 认识满 30 天 +5 + 满 180 天再 +5
   *       − 冷落折扣（见 neglectDiscount，下限 AFFINITY_FLOOR）。
   * 用户把 affinityMode 设成 manual 时，用他自己拉的那个数（见 affinityOf）。
   */
  function suggestAffinity(rawProfile, now) {
    const profile = normalizeProfile(rawProfile);
    const knownDays = daysSince(profile.since, now);
    let value = AFFINITY_DEFAULT;
    value += Math.min(8, profile.shared.length) * 3;
    if (knownDays !== null && knownDays >= 30) value += 5;
    if (knownDays !== null && knownDays >= 180) value += 5;
    const gap = gapInfo(profile.lastChatAt, now);
    value -= neglectDiscount(gap.known ? gap.days : null, profile.neglect);
    return Math.max(AFFINITY_FLOOR, Math.min(100, Math.round(value)));
  }

  /** 这一轮实际生效的亲近度：auto 用算出来的，manual 用用户拉的。 */
  function affinityOf(rawProfile, now, opts) {
    const profile = normalizeProfile(rawProfile);
    const lang = normLang(opts && opts.lang);
    const value = profile.affinityMode === "manual" ? profile.affinity : suggestAffinity(profile, now);
    const tier = affinityTier(value, lang);
    return { value: value, mode: profile.affinityMode, tier: tier.id, label: tier.label, suggested: suggestAffinity(profile, now) };
  }

  /** 冷落档位（语气层）：几天没聊 → 该是什么态度。 */
  function neglectInfo(rawProfile, now, opts) {
    const profile = normalizeProfile(rawProfile);
    const options = opts || {};
    const lang = normLang(options.lang);
    const mode = NEGLECT_MODES.indexOf(options.mode) >= 0 ? options.mode : profile.neglect;
    const gap = gapInfo(profile.lastChatAt, now);
    if (mode === "off" || !gap.known) return { known: gap.known, days: gap.days, mode: mode, tier: "off", tone: "" };
    const found = NEGLECT_TIERS.find((row) => gap.days >= row.min) || NEGLECT_TIERS[NEGLECT_TIERS.length - 1];
    const tone = {
      fresh: lang === "en" ? "" : "",
      missed: lang === "en"
        ? "It has been a few days. You missed them — say so lightly, like a person would, and move on to something real."
        : "隔了几天没见。可以轻轻说一句想他/她了（像真人那样随口一提），然后聊点具体的事。",
      sulky: lang === "en"
        ? "It has been about a week. You may be a little hurt or prickly — show it in how you talk, but say what is actually wrong instead of punishing them."
        : "一周上下没见了。可以有点别扭、有点小情绪 —— 用说话方式表现出来，但要把「到底怎么了」说开，而不是摆脸色惩罚对方。",
      distant: lang === "en"
        ? "It has been a long time. You feel a bit distant and have to warm up again; do not pretend nothing happened, and do not demand an explanation."
        : "很久没见了。会有点生分、需要重新热起来：别装作什么都没发生，但也别逼对方解释。",
    }[found.id] || "";
    return { known: true, days: gap.days, mode: mode, tier: found.id, tone: tone };
  }

  /** 今天已经主动发过几条（proactiveLog 存 "YYYY-MM-DD|n"，隔天自动归零）。 */
  function proactiveCountToday(rawProfile, now) {
    const profile = normalizeProfile(rawProfile);
    const today = isoDay(now);
    const parts = String(profile.proactiveLog || "").split("|");
    if (parts.length !== 2 || parts[0] !== today) return 0;
    const count = Number(parts[1]);
    return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  }

  /**
   * 该不该让角色**先开口**。技术现实：这个应用没有后端、没有推送，
   * 所以"主动"只发生在**用户回来的时候**（打开这个角色的对话）。
   * 三个条件：伴侣模式开着 + 主动消息开着 + 距上次聊天 ≥ minGapHours + 今天还没发够。
   */
  function proactiveDecision(rawProfile, now, opts) {
    const profile = normalizeProfile(rawProfile);
    const options = opts || {};
    const enabled = options.enabled === undefined ? profile.proactive.enabled : options.enabled === true;
    if (!profile.enabled) return { ok: false, reason: "companion-off" };
    if (!enabled) return { ok: false, reason: "proactive-off" };
    const gap = gapInfo(profile.lastChatAt, now);
    if (!gap.known) return { ok: false, reason: "no-history" };
    // 只有"隔了至少 minGapHours 小时"才主动：按天算不够细，这里用时间戳。
    const last = profile.lastChatAt ? new Date(String(profile.lastChatAt)) : null;
    const nowDate = now === undefined || now === null ? new Date() : (now instanceof Date ? now : new Date(String(now)));
    if (last && !isNaN(last.getTime())) {
      const hours = (nowDate.getTime() - last.getTime()) / 3600000;
      if (hours < profile.proactive.minGapHours) return { ok: false, reason: "too-soon", hours: Math.round(hours) };
    }
    const sentToday = proactiveCountToday(profile, now);
    if (sentToday >= profile.proactive.maxPerDay) return { ok: false, reason: "daily-cap", sentToday: sentToday };
    return { ok: true, reason: "ok", days: gap.days, sentToday: sentToday };
  }

  /** 主动开口时带动词的那一条 system 指令（由调用方塞进 messages）。 */
  function proactiveInstruction(rawProfile, opts) {
    const options = opts || {};
    const lang = normLang(options.lang);
    const profile = normalizeProfile(rawProfile);
    const neglect = neglectInfo(profile, options.now, { mode: profile.neglect, lang: lang });
    const affinity = affinityOf(profile, options.now);
    if (lang === "en") {
      return "[Companion mode] This turn STARTS now: they just opened the app, you speak first.\n"
        + "Write it like a real person sending a message out of the blue: short (one or two sentences), specific, "
        + "and tied to something that actually happened between you two — not a greeting-card opener.\n"
        + "Current closeness: " + affinity.label + ". " + (neglect.tone ? neglect.tone + " " : "")
        + "Never ask why they were away, never guilt them, never ask them to reply quickly.";
    }
    return "[陪伴模式] 这一轮是**你先开口**：他刚打开应用，还没说话。\n"
      + "像真人突然发来一条消息那样写：短（一两句）、具体、最好勾着一件你们之间真发生过的事，不要客套式寒暄。\n"
      + "现在的亲近程度：" + affinity.label + "。" + (neglect.tone ? neglect.tone + " " : "")
      + "不要问他为什么这么久没来、不要让他内疚、不要催他快点回。";
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
      // 亲近度（系统算的，或用户自己拉的）+ 冷落反应：两者都只影响**语气**，
      // 不改变事实、不锁任何东西。写成一句人话，别让模型去解释数字。
      const affinity = affinityOf(profile, now, { lang: "en" });
      lines.push("Closeness right now: " + affinity.label + " (act this close; never announce a number).");
      const neglect = neglectInfo(profile, now, { lang: "en" });
      if (neglect.tone) lines.push(neglect.tone);
      if (profile.shared.length) {
        lines.push("Things that actually happened between you two (confirmed by the user):");
        for (const row of profile.shared) lines.push("- " + row.text);
      }
      lines.push("Sound like a real person: short everyday messages, your own mood. Never sound like an assistant, never summarize.");
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
    // 亲近度（系统算的，或用户自己拉的）+ 冷落反应：都只影响**语气**，
    // 不改事实、不锁功能。写成一句人话，别让模型去解释数字。
    const affinity = affinityOf(profile, now, { lang: "zh" });
    lines.push("亲近度：" + affinity.label + "（别说数字）。");
    const neglect = neglectInfo(profile, now, { lang: "zh" });
    if (neglect.tone) lines.push(neglect.tone);
    if (profile.shared.length) {
      lines.push("你们之间真发生过的事（对方确认过）：");
      for (const row of profile.shared) lines.push("- " + row.text);
    }
    lines.push("像真人：短句、日常话、有情绪；不要像助手，不要总结。");
    lines.push("硬规矩：");
    RULES.zh.forEach((rule, index) => lines.push((index + 1) + ". " + rule));
    return lines.join("\n");
  }

  /** 自检：这段文字里有没有"操控性"话术。返回命中的片段与类别，不改写原文。
   *  2026-09-12 从"只查内疚"扩到三类：内疚 / 威胁 / 排他 —— 允许有情绪，
   *  但不许拿情绪当绳子。 */
  function lintManipulation(text) {
    const src = String(text === undefined || text === null ? "" : text);
    const hits = [];
    for (const kind of MANIPULATION_KINDS) {
      for (const pattern of kind.patterns) {
        const m = pattern.exec(src);
        // 位置用 `at` 而不是 `index`：多条版本里 `index` 是"第几条消息"，
        // 两者重名会互相覆盖（真踩过：面板上显示成"第 6 条消息"）。
        if (m) hits.push({ kind: kind.id, kindLabel: kind.zh, phrase: m[0], at: m.index });
      }
    }
    return hits;
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

  /** 同上，但按三类返回（面板里要分开说"这是内疚 / 这是威胁 / 这是排他"）。 */
  function lintManipulationIn(texts) {
    const list = Array.isArray(texts) ? texts : [];
    const hits = [];
    list.forEach((text, index) => {
      for (const hit of lintManipulation(text)) hits.push(Object.assign({ index: index }, hit));
    });
    return hits;
  }

  /* ---------- 「上次说到」 ---------- */

  const RECAP_SNIPPET_MAX = 34;

  /** 压成一行、超长截断。空白折叠掉，免得把换行带进那一行小字里。 */
  function recapSnippet(text, limit) {
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : RECAP_SNIPPET_MAX;
    const clean = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;
    return clean.slice(0, max) + "…";
  }

  /**
   * 「上次说到」：从**真实的对话记录**里取一句话，给"隔了日子回来"的人看。
   * 纯本地、不调模型、不做摘要、不编内容；不该显示就返回 null
   * （刚聊过、只有一条消息、没有时间戳、内容为空）。
   */
  function chatRecap(messages, options) {
    const opts = options || {};
    const now = opts.now === undefined || opts.now === null ? new Date() : opts.now;
    const minDays = Number.isFinite(opts.minDays) ? opts.minDays : 1;
    const rows = (Array.isArray(messages) ? messages : [])
      .filter((message) => message && typeof message.mes === "string" && message.mes.trim());
    if (rows.length < 2) return null;
    const last = rows[rows.length - 1];
    const gap = gapInfo(last.send_date, now);
    if (!gap.known || gap.days < minDays) return null;
    // 优先取"你说过的那句"：那是话题，比角色自己的台词更像"上次说到哪"。
    const lastUser = rows.filter((message) => message.is_user === true).slice(-1)[0];
    const source = lastUser || last;
    const snippet = recapSnippet(source.mes, opts.limit);
    if (!snippet) return null;
    return { snippet: snippet, gap: gap, days: gap.days, fromUser: !!lastUser, at: cleanText(last.send_date, 40) };
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
    THREAT_PATTERNS,
    EXCLUSIVE_PATTERNS,
    MANIPULATION_KINDS,
    AFFINITY_DEFAULT,
    AFFINITY_FLOOR,
    AFFINITY_TIERS,
    NEGLECT_MODES,
    NEGLECT_TIERS,
    PROACTIVE_DEFAULTS,
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
    affinityTier,
    suggestAffinity,
    affinityOf,
    neglectDiscount,
    neglectInfo,
    proactiveCountToday,
    proactiveDecision,
    proactiveInstruction,
    buildCompanionBlock,
    lintGuilt,
    lintGuiltIn,
    lintManipulation,
    lintManipulationIn,
    RECAP_SNIPPET_MAX,
    recapSnippet,
    chatRecap,
    touch,
    markChat,
  };
});
