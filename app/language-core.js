"use strict";

/*
 * language-core.js —— **角色的交流语言**（纯逻辑，浏览器与 Node 双端可用）
 *
 * 这一层回答三个问题，而且**只有这一层回答**（界面、提示词、TTS 三处都调它）：
 *   ① 这个角色说哪种语言？（"zh" / "en" / null = 旧卡没说清，需要用户确认）
 *   ② 这段回复算不算"用了设定的语言"？（可解释、不误杀人名与缩写）
 *   ③ 这个音色能不能念这种语言？（硬筛，语言不合的音色**绝不交付**）
 *
 * ⚠ 三条边界，写在这里免得后面走回头路：
 *   · **语言是角色的交流规则，不是界面语言。** 它不该因为用户某一句输入就切换
 *     —— 所以校验只拿"角色该说的语言"和"它实际写的话"比，跟用户输入无关。
 *   · **"不混用"不等于"不许出现拉丁字母"。** 人名（Hermione）、品牌（iPhone）、
 *     缩写（OK / API）都含拉丁字母，用字符比例一刀切会把完全正常的中文回复判违规。
 *     `checkResponseLanguage` 判的是**承载内容的单元**（句子/分句一级），
 *     并且把"整条就是名字/缩写"的短单元排除在外 —— 判据可解释、可断言。
 *   · **不合语言的回复不交给错误语言的音色。** `speakerFitsLanguage` 是硬闸：
 *     中文文本配英文音色（或反过来）时，合成请求根本不该发出去。
 *
 * 迁移口径（用户 2026-09-14 要求"保守"）：
 *   `resolveCharacterLanguage()` 只认**卡里已经明确写下的**语言字段，
 *   认不出来就返回 `{ language: null, needsConfirm: true }` ——
 *   **绝不按角色姓名猜语言，也绝不覆盖用户原来的设定。**
 */

(function (global) {
  "use strict";

  /* ==================================================================== *
   * 一、语言字段：只有中文、英文两个独立选项
   * ==================================================================== */

  /**
   * 产品的语言表。**刻意只有两项**：
   * 用户 2026-09-14 拍板"本轮中文、英文两个独立选项；不要默认提供混合模式"。
   * `mixed` 这一项不存在 —— 想两种都说，是**两个角色**的事，不是一张卡的事。
   */
  const LANGUAGES = Object.freeze({
    zh: "中文",
    en: "English",
  });

  const LANGUAGE_IDS = Object.freeze(["zh", "en"]);

  /** 归一化：认 CCv3 / SillyTavern 里常见的各种写法；认不出来返回 null（**不猜**）。 */
  function normalizeLanguage(value) {
    const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
    if (!text) return null;
    if (text === "zh" || text === "zh-cn" || text === "zh-hans" || text === "cn"
      || text === "chinese" || text === "chinese (simplified)" || text === "simplified chinese"
      || text === "中文" || text === "简体中文" || text === "汉语" || text === "漢語") return "zh";
    if (text === "en" || text === "en-us" || text === "en-gb" || text === "english"
      || text === "英文" || text === "英语" || text === "英語") return "en";
    return null;
  }

  /**
   * 从角色卡里读出"它自己声明的语言"。
   *
   * 查的顺序（**只看模型/卡片自己写下的字段，不看角色名字**）：
   *   ① CCv3 `data.extensions.task29.language`（我们 AI 建卡时写的结构化字段）；
   *   ② `data.extensions.roleworld.language`（以后可能的第二个落点）；
   *   ③ `data.language` / 顶层 `language`；
   *   ④ `data.extensions.task29.character_language`（同一个字段的历史名字）。
   * 都认不出来 → null。
   */
  function declaredLanguageOfCard(card) {
    if (!card || typeof card !== "object") return null;
    const data = (card.data && typeof card.data === "object") ? card.data : {};
    const ext = (data.extensions && typeof data.extensions === "object") ? data.extensions : {};
    const rw = (ext.roleworld && typeof ext.roleworld === "object") ? ext.roleworld : {};
    const candidates = [
      ext.task29 && ext.task29.language,
      ext.task29 && ext.task29.character_language,
      rw.language,
      data.language,
      card.language,
    ];
    for (const value of candidates) {
      const lang = normalizeLanguage(value);
      if (lang) return lang;
    }
    return null;
  }

  /**
   * 这个角色到底说哪种语言。返回值：
   *   { language: "zh"|"en", source: "...", needsConfirm: false }
   *   { language: null,      source: "unknown", needsConfirm: true  }   ← 旧卡，**要用户确认**
   *
   * `source` 是"这个结论从哪来"，界面会原样显示给人看 ——
   * 用户得能分辨"这是我自己设的"和"这是卡里带来的"。
   */
  function resolveCharacterLanguage(card, options) {
    const opts = options || {};
    // 用户显式改过（单角色覆盖 / 全局兜底）优先 —— 但调用方必须明确传进来，
    // 这一层不会自己去读设置（免得"某处悄悄替用户改语言"）。
    const override = normalizeLanguage(opts.override);
    if (override) return { language: override, source: "user", needsConfirm: false };
    const declared = declaredLanguageOfCard(card);
    if (declared) return { language: declared, source: "card", needsConfirm: false };
    return { language: null, source: "unknown", needsConfirm: true };
  }

  /** 把语言写进 CCv3 的 extensions（建卡/改卡用）。只接受 zh|en。 */
  function withLanguageExtension(extensions, language) {
    const lang = normalizeLanguage(language);
    const next = Object.assign({}, (extensions && typeof extensions === "object") ? extensions : {});
    if (!lang) return next;
    next.task29 = Object.assign({}, next.task29 || {}, { language: lang });
    return next;
  }

  /* ==================================================================== *
   * 二、这段回复算不算"用了设定的语言"
   * ==================================================================== */

  /** 汉字（含扩展 A 与常用兼容区）。 */
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  /** 拉丁**字母**：只在"词"这一级用，不参与单字比例。 */
  const LATIN_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

  /**
   * 单元边界：中文句末标点 / 换行，或**英文句号 + 空白**。
   * ⚠ 英文句号必须要求后面有空格或结尾：否则 `3.5`、`v1.2`、`Mr. Smith` 都会被切开，
   * 断句错了后面的投票就会跟着错。
   */
  const SENTENCE_END_RE = /[。！？!?…；;\n]+|\.(?=\s|$)/;

  /**
   * 把一个单元切成"承载内容的片段"：
   *   · 去掉 markdown 装饰与括号里的舞台提示；
   *   · 去掉**纯名字/缩写型**的拉丁词（`Hermione`、`iPhone`、`OK`、`API`、`JK`）——
   *     判据是"这个词≤12 个字母、首字母大写或全大写，或者全小写但长度≤3"。
   *     真正的英文句子不会长这样（`I think you are wrong` 里 `I` 会被去掉，
   *     但 `think/you/are/wrong` 都留着）。
   */
  function contentUnits(unit) {
    const text = String(unit === undefined || unit === null ? "" : unit);
    const out = [];
    const pushLatinRun = (run) => {
      // 词与词之间的空隙（空格、标点、数字）拼起来再看：
      // "I really do not agree with you here" 里的 `really`/`agree`/`with`/`here`
      // 都够长，只能算英文内容；而 `I` 这种单字母不算。
      if (run.replace(/[^A-Za-z]/g, "").length < 2) return;
      out.push({ kind: "latin", text: run });
    };
    LATIN_WORD_RE.lastIndex = 0;
    let match;
    let cursor = 0;
    // 一句话的**第一个**拉丁词通常是句首大写，不能因为它首字母大写就当成专有名词。
    let firstWord = true;
    while ((match = LATIN_WORD_RE.exec(text)) !== null) {
      const before = text.slice(cursor, match.index);
      if (CJK_RE.test(before)) { out.push({ kind: "cjk", text: before }); firstWord = true; }
      else pushLatinRun(before);
      cursor = match.index + match[0].length;
      const word = match[0];
      // 名字/缩写：全大写（OK / API / JK）、驼峰（iPhone）、
      // 或**非句首**的首字母大写单词（Hermione / Hogwarts）。
      const isNameLike = word === word.toUpperCase()
        || (/^[a-z]+[A-Z]/.test(word))
        || (!firstWord && /^[A-Z]/.test(word));
      if (!isNameLike) out.push({ kind: "latin", text: word });
      firstWord = false;
    }
    const tail = text.slice(cursor);
    if (CJK_RE.test(tail)) out.push({ kind: "cjk", text: tail });
    else pushLatinRun(tail);
    return out;
  }

  /**
   * 判定一段回复的语言，返回**可解释**的计数（界面上把那几个数字原样写出来）：
   *   { lang, confident, zhUnits, enUnits, units, ratio, reason }
   *
   * 规则（刻意简单、能一条条讲清楚）：
   *   · 先按句末标点切单元，**每个单元只投一票**（谁承载内容看谁的），
   *     这样"十句中文里夹一个英文人名"不会因为字数被拉偏；
   *   · 单元里有汉字 → 投中文；没有汉字但有非名字型拉丁词 → 投英文；都没有 → 不投票；
   *   · 全都不投票（比如只写了"…"或只有表情）→ `confident: false`，**不判违规**；
   *   · 票数多的一方胜出；`ratio` = 胜方 / 总票数，< 0.6 时 `confident: false`（说不清就别判）。
   */
  function detectLanguage(text) {
    const raw = String(text === undefined || text === null ? "" : text);
    const units = raw.split(SENTENCE_END_RE).map((one) => one.trim()).filter(Boolean);
    let zhUnits = 0;
    let enUnits = 0;
    for (const unit of units) {
      const stripped = unit.replace(/[*_`#>]+/g, " ").replace(/[（(][^）)]{0,80}[）)]/g, " ");
      const parts = contentUnits(stripped);
      const hasCjk = parts.some((one) => one.kind === "cjk");
      const hasLatin = parts.some((one) => one.kind === "latin");
      if (hasCjk) zhUnits += 1;
      else if (hasLatin) enUnits += 1;
    }
    const total = zhUnits + enUnits;
    if (!total) {
      return { lang: null, confident: false, zhUnits, enUnits, units: units.length, ratio: 0, reason: "no-content" };
    }
    const zhWins = zhUnits >= enUnits;
    const ratio = (zhWins ? zhUnits : enUnits) / total;
    return {
      lang: zhWins ? "zh" : "en",
      confident: ratio >= 0.6,
      zhUnits: zhUnits,
      enUnits: enUnits,
      units: units.length,
      ratio: Math.round(ratio * 100) / 100,
      reason: ratio >= 0.6 ? "clear" : "mixed",
    };
  }

  /**
   * 这段回复符合角色设定的语言吗？返回**给人看的一句话**（不合时界面照原样显示）。
   *
   *   返回 { ok: true }
   *   返回 { ok: true,  soft: true,  reason }  ← 两种语言都够多（说不清），**不拦**
   *   返回 { ok: false, code, reason, detected, expected }
   */
  function checkResponseLanguage(text, expected) {
    const want = normalizeLanguage(expected);
    if (!want) {
      // 角色自己没说清语言（旧卡，用户还没确认）：**不判违规**。
      // 拿一个猜出来的语言去拦用户的正常对话，比不拦坏得多。
      return { ok: true, unchecked: true, reason: "这个角色还没确定交流语言，没有做语言检查。" };
    }
    const info = detectLanguage(text);
    if (!info.lang) {
      return { ok: true, soft: true, reason: "这条回复里没有可判定的句子（可能只有标点或表情）。", detected: info };
    }
    // ⚠ 必须先判"说不说得清"，再判"是不是这个语言" —— 反过来的话，
    // 中英各一句的那种回复会走 `lang === want` 那条分支被静默当成"合规"，
    // 界面上就少了"这条我说不准，你先看着"那句说明（实测踩过一次）。
    if (!info.confident) {
      return {
        ok: true,
        soft: true,
        reason: "这条回复里两种语言都有（中文 " + info.zhUnits + " 句 / 英文 " + info.enUnits + " 句），说不清算不算跑偏，先照常显示。",
        detected: info,
      };
    }
    if (info.lang === want) return { ok: true, detected: info };
    return {
      ok: false,
      code: "LANGUAGE_MISMATCH",
      expected: want,
      detected: info,
      reason: "这个角色设的是" + LANGUAGES[want] + "，但这条回复写成" + LANGUAGES[info.lang]
        + "（" + info.zhUnits + " 句中文 / " + info.enUnits + " 句英文）。",
    };
  }

  /* ==================================================================== *
   * 三、音色能不能念这种语言（硬闸）
   * ==================================================================== */

  /** 从音色 id 里读出语言：`zh_female_vv_uranus_bigtts` → zh；`en_male_alex_…` → en。 */
  function speakerLanguage(speakerId) {
    const id = String(speakerId || "").trim().toLowerCase();
    if (!id) return null;
    const head = id.split("_")[0];
    if (head === "zh" || head === "cn") return "zh";
    if (head === "en") return "en";
    // 官方表里还有 ja / ko / es / pt / fr / de / ru / it / id / th / vi / ms 等，
    // 这一轮产品只有中英两种语言，别的语言一律**不兼容**（宁可让用户看见"没有可用音色"，
    // 也不要把一个日语音色悄悄配给中文角色）。
    return head || null;
  }

  /**
   * 硬筛：这个音色能不能念这种语言。**这是不可绕过的第一道闸**
   * （`recommendSpeakers` 只是它之后的排序）。
   */
  function speakerFitsLanguage(speakerId, language) {
    const want = normalizeLanguage(language);
    if (!want) return false;
    return speakerLanguage(speakerId) === want;
  }

  const Language = {
    LANGUAGES,
    LANGUAGE_IDS,
    normalizeLanguage,
    declaredLanguageOfCard,
    resolveCharacterLanguage,
    withLanguageExtension,
    detectLanguage,
    checkResponseLanguage,
    speakerLanguage,
    speakerFitsLanguage,
    _contentUnits: contentUnits,
  };

  global.RoleWorldLanguage = Language;
  if (typeof module !== "undefined" && module.exports) module.exports = Language;
})(typeof globalThis !== "undefined" ? globalThis : this);
