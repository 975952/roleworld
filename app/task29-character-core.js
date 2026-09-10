"use strict";

/*
 * task29-character-core.js — Task-29A 纯逻辑层（无 DOM 依赖，浏览器与 Node 双端可用）。
 *
 * 职责（只做确定性、可测试的逻辑，不碰 DOM）：
 *   1. 自然语言角色描述 → AI 生成草稿（构造 generate payload，严格草稿 schema）；
 *   2. 草稿解析/归一化/校验（拒绝未知字段与危险键，允许确定性移除一层 ```json 围栏）；
 *   3. 确定性构造标准 CCv3 卡片（spec = chara_card_v3, spec_version = 3.0）；
 *   4. 原生角色文件导入的类型映射与扩展名校验；
 *   5. Harry/自定义角色记忆书门控与 Task-28C 模板占位聊天识别；
 *   6. AI 创建角色两阶段流程的可测状态机。
 *
 * 浏览器：window.TASK29_CHARACTER_CORE；Node（CommonJS）：module.exports。
 * 不保存模型原始回复；不写入 custom_url / 账户 / 聊天正文 / Memory Books。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.TASK29_CHARACTER_CORE = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /* ---------- 草稿严格 schema ---------- */
  const DRAFT_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags", "language"];
  // Task-29G：AI 创建角色的语言（下拉：自动判断/中文/English）。草稿总是携带 zh|en。
  const CHARACTER_LANGUAGES = Object.freeze({ auto: "自动判断", zh: "中文", en: "English" });
  const DANGEROUS_KEYS = ["__proto__", "prototype", "constructor"];
  const FIELD_LIMITS = {
    name: [1, 80],
    description: [1, 4000],
    personality: [0, 2000],
    scenario: [0, 2000],
    first_mes: [1, 2000],
    mes_example: [0, 6000],
  };
  const TAGS_MAX = 12;
  const TAG_MIN = 1;
  const TAG_MAX = 32;

  const MAX_DRAFT_CALLS = 2; // 初次生成 + 一次修复；禁止无限重试。
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // 前端限制最大 20 MiB。

  /* 两阶段流程状态机 */
  const DRAFT_PHASES = {
    IDLE: "idle",
    GENERATING: "generating",
    EDIT: "edit",
    IMPORTED: "imported",
  };

  /* ---------- 通用小工具 ---------- */
  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  /* ---------- 草稿解析：确定性移除一层 ```json 围栏 ---------- */
  function stripFence(text) {
    const t = String(text || "");
    const re = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n\s*```\s*$/;
    const match = t.match(re);
    if (match) return match[1].trim();
    return t.trim();
  }

  /**
   * 解析模型回复为草稿对象。
   * - 先剥离一层 ```json 围栏；
   * - 只接受 JSON 对象；
   * - 拒绝未知字段；拒绝 __proto__ / prototype / constructor；
   * - 抛出错误码：DRAFT_PARSE_ERROR / DRAFT_UNKNOWN_FIELD / DRAFT_DANGEROUS_KEY。
   */
  function parseDraft(rawText) {
    let value;
    try {
      value = JSON.parse(stripFence(rawText));
    } catch (_) {
      const error = new Error("角色草稿不是合法 JSON");
      error.code = "DRAFT_PARSE_ERROR";
      throw error;
    }
    if (!isPlainObject(value)) {
      const error = new Error("角色草稿必须是 JSON 对象");
      error.code = "DRAFT_PARSE_ERROR";
      throw error;
    }
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.includes(key)) {
        const error = new Error(`拒绝危险键：${key}`);
        error.code = "DRAFT_DANGEROUS_KEY";
        throw error;
      }
      if (!DRAFT_FIELDS.includes(key)) {
        const error = new Error(`草稿含未知字段：${key}`);
        error.code = "DRAFT_UNKNOWN_FIELD";
        throw error;
      }
    }
    return normalizeDraft(value);
  }

  /** 归一化：把原始对象规整为严格字段（字符串化并裁剪到上限；tags 清洗）。 */
  function normalizeDraft(value) {
    const source = isPlainObject(value) ? value : {};
    const out = {
      name: "",
      description: "",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      tags: [],
      language: "zh",
    };
    for (const field of DRAFT_FIELDS) {
      if (field === "tags") {
        const tags = Array.isArray(source.tags) ? source.tags : [];
        const cleaned = [];
        for (const tag of tags) {
          const s = String(tag || "").trim().slice(0, TAG_MAX);
          if (s && s.length >= TAG_MIN && cleaned.length < TAGS_MAX) cleaned.push(s);
        }
        out.tags = cleaned;
      } else if (field === "language") {
        out.language = source.language === "en" ? "en" : "zh";
      } else {
        out[field] = String(source[field] === undefined || source[field] === null ? "" : source[field])
          .slice(0, FIELD_LIMITS[field][1]);
      }
    }
    return out;
  }

  /** 校验：返回 { valid, errors:[...] }，不抛出。 */
  function validateDraft(draft) {
    const errors = [];
    const d = draft || {};
    if (typeof d.name !== "string" || d.name.length < 1) errors.push("name 必填（1-80 字符）");
    if (typeof d.name !== "string" || d.name.length > 80) errors.push("name 不能超过 80 字符");
    if (typeof d.description !== "string" || d.description.length < 1) errors.push("description 必填（1-4000 字符）");
    if (typeof d.description !== "string" || d.description.length > 4000) errors.push("description 不能超过 4000 字符");
    if (typeof d.personality === "string" && d.personality.length > 2000) errors.push("personality 不能超过 2000 字符");
    if (typeof d.scenario === "string" && d.scenario.length > 2000) errors.push("scenario 不能超过 2000 字符");
    if (typeof d.first_mes !== "string" || d.first_mes.length < 1) errors.push("first_mes 必填（1-2000 字符）");
    if (typeof d.first_mes === "string" && d.first_mes.length > 2000) errors.push("first_mes 不能超过 2000 字符");
    if (typeof d.mes_example === "string" && d.mes_example.length > 6000) errors.push("mes_example 不能超过 6000 字符");
    if (d.language !== "zh" && d.language !== "en") errors.push("language 必须为 zh 或 en");
    if (!Array.isArray(d.tags)) errors.push("tags 必须是数组");
    else {
      if (d.tags.length > TAGS_MAX) errors.push(`tags 最多 ${TAGS_MAX} 项`);
      for (const tag of d.tags) {
        if (typeof tag !== "string" || tag.length < TAG_MIN || tag.length > TAG_MAX) errors.push(`每个 tag 需为 1-${TAG_MAX} 字符`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /* ---------- AI 生成草稿 payload ----------
     只把「当前角色描述」送给模型。禁止发送 Harry 卡、Memory Books、聊天记录、
     账户信息、其他用户内容或 settings 全文。custom_url / custom_include_body
     原样取自 settings，不修改、不记录。 */
  const DRAFT_SYSTEM_PROMPT =
    "You are a character card author. Given a user's natural-language description of a character, " +
    "produce ONE strict JSON object with exactly these fields and NO other fields, and no markdown, " +
    "no code fence, and no commentary:\n" +
    '- "name": string, 1-80 characters;\n' +
    '- "description": string, 1-4000 characters;\n' +
    '- "personality": string, 0-2000 characters;\n' +
    '- "scenario": string, 0-2000 characters;\n' +
    '- "first_mes": string, 1-2000 characters, an opening line the character speaks to start the conversation;\n' +
    '- "mes_example": string, 0-6000 characters, example dialogue lines using {{user}} and {{char}};\n' +
    '- "tags": array of at most 12 strings, each 1-32 characters;\n' +
    '- "language": "zh" or "en", the spoken language of the character.\n' +
    "Output only the JSON object.";

  // Task-29G：语言指令（追加到系统提示词；zh/en 明确指定，auto 由模型从描述判断）。
  const DRAFT_LANGUAGE_INSTRUCTIONS = Object.freeze({
    zh: "The character speaks Simplified Chinese. Write every field, especially first_mes, in Simplified Chinese, and set \"language\": \"zh\".",
    en: "The character speaks English. Write every field, especially first_mes, in English, and set \"language\": \"en\".",
    auto: "Determine the character's spoken language from the description (Simplified Chinese or English). Write every field in that language and set \"language\": \"zh\" or \"en\" accordingly.",
  });

  function buildDraftGeneratePayload(opts) {
    const description = String((opts && opts.description) || "");
    if (description.length < 20) throw new Error("角色描述至少需要 20 个字符");
    if (description.length > 4000) throw new Error("角色描述不能超过 4000 字符");
    const requested = (opts && opts.language) || "auto";
    const language = requested === "en" || requested === "zh" ? requested : "auto";
    const oai = (opts && opts.settings && opts.settings.oai_settings) || {};
    const customIncludeBody = (oai.custom_include_body !== undefined && oai.custom_include_body !== null)
      ? oai.custom_include_body
      : "chat_template_kwargs:\n  enable_thinking: false";
    return {
      messages: [
        { role: "system", content: DRAFT_SYSTEM_PROMPT + "\n" + (DRAFT_LANGUAGE_INSTRUCTIONS[language] || DRAFT_LANGUAGE_INSTRUCTIONS.auto) },
        { role: "user", content: description },
      ],
      model: "local",
      chat_completion_source: "custom",
      custom_url: oai.custom_url || "",
      custom_include_body: customIncludeBody,
      stream: false,
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 1024,
    };
  }

  /* ---------- 确定性构造标准 CCv3 ---------- */
  function buildCCv3(draft) {
    const d = normalizeDraft(draft);
    return {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: d.name,
        description: d.description,
        personality: d.personality,
        scenario: d.scenario,
        first_mes: d.first_mes,
        mes_example: d.mes_example,
        tags: d.tags,
        creator: "AI-assisted local draft",
        character_version: "1.0",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        group_only_greetings: [],
        extensions: {
          task29: {
            generated: true,
            generator: "qwen27b",
            schema_version: 1,
            language: d.language,
          },
        },
      },
    };
  }

  /* ---------- 原生文件导入：类型映射与扩展名校验 ---------- */
  const EXT_TO_FILE_TYPE = {
    ".json": "json",
    ".png": "png",
    ".charx": "charx",
    ".yaml": "yaml",
    ".yml": "yml",
  };
  const IMPORT_FILE_TYPES = Object.freeze(["json", "png", "charx", "yaml", "yml"]);

  function importTypeForFileName(fileName) {
    const name = String(fileName || "").toLowerCase().trim();
    const dot = name.lastIndexOf(".");
    if (dot < 0) return null;
    return EXT_TO_FILE_TYPE[name.slice(dot)] || null;
  }

  function validateFileName(fileName) {
    return importTypeForFileName(fileName) !== null;
  }

  /* ---------- Harry / 自定义角色记忆门控 ---------- */
  function isHarryAvatar(avatar, harryAvatar) {
    return String(avatar || "") !== "" && String(harryAvatar || "") !== "" && String(avatar) === String(harryAvatar);
  }

  function memoryBooksFor(avatar, harryAvatar, memoryBooks) {
    return isHarryAvatar(avatar, harryAvatar) ? (Array.isArray(memoryBooks) ? memoryBooks : []) : [];
  }

  /* ---------- Task-28C 模板占位聊天识别（前端可隐藏，但绝不修改） ---------- */
  const TEMPLATE_PLACEHOLDER_FILE = "harry-task28b-initial";
  function isTemplatePlaceholderChat(fileName) {
    const raw = String(fileName || "").replace(/\.jsonl$/i, "");
    return raw === TEMPLATE_PLACEHOLDER_FILE;
  }

  /* ---------- 两阶段流程状态机 ---------- */
  function createDraftFlow() {
    let phase = DRAFT_PHASES.IDLE;
    let draft = null;
    let callsUsed = 0;
    let generatedText = "";

    function transition(next) {
      const allowed = {
        // GENERATING → GENERATING = 修复重试；EDIT → GENERATING = 重新生成。
        [DRAFT_PHASES.IDLE]: [DRAFT_PHASES.GENERATING],
        [DRAFT_PHASES.GENERATING]: [DRAFT_PHASES.GENERATING, DRAFT_PHASES.EDIT, DRAFT_PHASES.IDLE],
        [DRAFT_PHASES.EDIT]: [DRAFT_PHASES.GENERATING, DRAFT_PHASES.IMPORTED, DRAFT_PHASES.IDLE],
        [DRAFT_PHASES.IMPORTED]: [],
      };
      if (!allowed[phase].includes(next)) {
        const error = new Error(`非法状态转换：${phase} → ${next}`);
        error.code = "DRAFT_BAD_TRANSITION";
        throw error;
      }
      phase = next;
    }

    return {
      getPhase() { return phase; },
      beginGeneration() {
        if (callsUsed >= MAX_DRAFT_CALLS) {
          const error = new Error("已超过最大生成次数");
          error.code = "DRAFT_MAX_CALLS";
          throw error;
        }
        transition(DRAFT_PHASES.GENERATING);
        callsUsed += 1;
        generatedText = "";
        return phase;
      },
      // 首次解析或验证失败时允许一次修复重试（beginGeneration 再调用一次）。
      retryAllowed() { return callsUsed < MAX_DRAFT_CALLS; },
      receiveGenerated(text) {
        generatedText = String(text || "");
        const draft = parseDraft(generatedText);
        const check = validateDraft(draft);
        if (!check.valid) {
          const error = new Error(`角色草稿不完整：${check.errors.join("；")}`);
          error.code = "DRAFT_INVALID";
          error.validationErrors = check.errors;
          throw error;
        }
        this.setDraft(draft);
        return draft;
      },
      setDraft(value) {
        draft = normalizeDraft(value);
        if (phase === DRAFT_PHASES.GENERATING) transition(DRAFT_PHASES.EDIT);
        return draft;
      },
      getDraft() { return draft; },
      cancel() {
        draft = null;
        generatedText = "";
        phase = DRAFT_PHASES.IDLE;
        return phase;
      },
      confirmImport() {
        if (phase !== DRAFT_PHASES.EDIT) {
          const error = new Error("只有编辑完成的草稿才能导入");
          error.code = "DRAFT_NOT_EDITABLE";
          throw error;
        }
        transition(DRAFT_PHASES.IMPORTED);
        return buildCCv3(draft);
      },
      getCallsUsed() { return callsUsed; },
    };
  }

  return {
    DRAFT_FIELDS,
    DANGEROUS_KEYS,
    FIELD_LIMITS,
    CHARACTER_LANGUAGES,
    DRAFT_LANGUAGE_INSTRUCTIONS,
    TAGS_MAX,
    TAG_MIN,
    TAG_MAX,
    MAX_DRAFT_CALLS,
    MAX_IMPORT_BYTES,
    DRAFT_PHASES,
    IMPORT_FILE_TYPES,
    EXT_TO_FILE_TYPE,
    TEMPLATE_PLACEHOLDER_FILE,
    DRAFT_SYSTEM_PROMPT,
    stripFence,
    parseDraft,
    normalizeDraft,
    validateDraft,
    buildDraftGeneratePayload,
    buildCCv3,
    importTypeForFileName,
    validateFileName,
    isHarryAvatar,
    memoryBooksFor,
    isTemplatePlaceholderChat,
    createDraftFlow,
  };
});
