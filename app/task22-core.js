"use strict";

/*
 * task22-core.js — Task-22 前端真实接入的纯逻辑层（无 DOM 依赖，浏览器与 Node 双端可用）。
 *
 * 职责：把「角色卡 + Memory Books + 聊天历史 + 用户输入」组合成与 Task-20 验收一致的
 * chat-completions messages，构造 generate 请求、聊天保存 payload、双引擎元数据与激活清单。
 * 组合逻辑逐行对齐 Task-20 的 card_layers.mjs / generate_blind_samples.mjs（已本地验收）。
 *
 * 浏览器：window.TASK22_CORE；Node（CommonJS）：module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.TASK22_CORE = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /* ---------- 双引擎元数据（A/B 均保留，用户切换；真实模型重载见 TUNNEL_AND_CONNECT.md） ---------- */
  const ENGINES = {
    A: { id: "A", name: "Qwen3.8-27B", label: "A · Qwen3.8-27B", detail: "稳健叙事", available: true },
    B: { id: "B", name: "Mistral Small 3.2", label: "B · Mistral Small 3.2 · 当前未启动", detail: "当前未启动 · 发送已禁用", available: false },
  };

  /* ---------- 冻结采样（Task-20 验收一致，两引擎相同；不读 settings 以免漂移） ---------- */
  const SAMPLING = {
    temperature: 0.8,
    top_p: 0.9,
    min_p: 0.05,
    top_k: 0,
    repetition_penalty: 1.05,
    /* 2026-09-09：上限由 400 提到 2048，让角色回答自然收尾（本地 27B 生成较慢）。 */
    max_tokens: 2048,
  };

  /* 网站版对话模型走用户选定的云端 API，密钥只保存在浏览器本机。 */
  const CHAT_MODES = Object.freeze({
    LOCAL: "local",
    // DeepSeek 正式目录（2026-09-10）：V4.1 Flash 使用这个模型名。
    DEEPSEEK_FLASH: "deepseek-flash",
    DEEPSEEK_PRO: "deepseek-v4-pro",
  });
  const DEEPSEEK_CHAT_MODES = Object.freeze([
    CHAT_MODES.DEEPSEEK_FLASH,
    CHAT_MODES.DEEPSEEK_PRO,
  ]);
  // 旧配置仍能正常发送，但不再出现在网站的模型选择里。
  const DEEPSEEK_LEGACY_MODES = Object.freeze([
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4.1-flash-expires-on-0910",
    "deepseek-chat",
    "deepseek-reasoner",
  ]);
  const DEEPSEEK_CHAT_SAMPLING = Object.freeze({
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 32768,
  });

  function isDeepSeekChatMode(mode) {
    return DEEPSEEK_CHAT_MODES.indexOf(mode) >= 0 || DEEPSEEK_LEGACY_MODES.indexOf(mode) >= 0;
  }

  /* 卡内 character_book 中这些 id 恒注入（Task-20 合同）。 */
  const CARD_CONSTANT_IDS = ["timeline-point", "knowledge-cutoff"];

  /* ---------- 旁白/台词 输出约定（Task-22 风格迭代） ---------- */
  const REPLY_FORMAT_INSTRUCTION = `Separate narration from dialogue. NARRATION = actions, expressions, environment, and thoughts — plain text, no quotation marks. DIALOGUE = every word the character speaks out loud, ALWAYS wrapped in double quotes ("..."), including short exclamations like "What?" or "No." Never write any spoken word without double quotes. Put speech tags like "he says" or "he mutters" OUTSIDE and after the closing quote. Example: He steps back, frowning. "No. That's not right," he says, shaking his head. "Please stop." Narration and quoted dialogue may alternate in any order.`;

  /* ---------- 卡字段读取（兼容 V2 / V3 双形态） ---------- */
  function cardField(card, name) {
    if (!card) return "";
    if (card.data && card.data[name] !== undefined && card.data[name] !== null && card.data[name] !== "") return card.data[name];
    if (card[name] !== undefined && card[name] !== null && card[name] !== "") return card[name];
    return "";
  }

  function cardBookEntries(card) {
    if (!card) return [];
    const book = (card.data && card.data.character_book) || card.character_book;
    return (book && Array.isArray(book.entries)) ? book.entries : [];
  }

  /* 卡内 lore 关键词：CCv3 用 keys / secondary_keys。 */
  function cardEntryKeywords(e) {
    const kws = [];
    for (const k of (e.keys || e.key || [])) if (k) kws.push(String(k));
    for (const k of (e.secondary_keys || [])) if (k) kws.push(String(k));
    return kws;
  }

  /* Memory Books 条目关键词：ST World Info 用 key / keysecondary。 */
  function memoryEntryKeywords(e) {
    const kws = [];
    for (const k of (e.key || e.keys || [])) if (k) kws.push(String(k));
    for (const k of (e.keysecondary || [])) if (k) kws.push(String(k));
    return kws;
  }

  function matchAny(kws, text) {
    const lower = String(text || "").toLowerCase();
    return kws.some((kw) => lower.includes(kw.toLowerCase()));
  }

  /* ---------- 卡内 lore 命中（对齐 matchedCardLore） ---------- */
  function matchedCardLore(card, promptText) {
    return cardBookEntries(card).filter((e) => !CARD_CONSTANT_IDS.includes(e.id))
      .filter((e) => matchAny(cardEntryKeywords(e), promptText));
  }

  /* ---------- Memory Books 激活清单（对齐 activatedEntries） ---------- */
  function activatedMemoryEntries(memoryBooks, promptText) {
    const out = [];
    for (const book of (memoryBooks || [])) {
      for (const e of (book.entries || [])) {
        if (e.disable) continue;
        if (e.constant) { out.push({ book: book.name, uid: e.uid, reason: "constant" }); continue; }
        const kws = memoryEntryKeywords(e);
        const matched = kws.filter((kw) => String(promptText || "").toLowerCase().includes(kw.toLowerCase()));
        if (matched.length) out.push({ book: book.name, uid: e.uid, reason: "keyword", matched });
      }
    }
    return out;
  }

  /* ---------- 系统提示词组合（对齐 card_layers.buildSystem，逐字节一致） ---------- */
  /* ---------- 自动记忆（agent 式） ----------
   * 让模型自己决定记什么：在回复末尾用 [[记住: …]] 写要点，前端剥掉标记、写进该角色
   * 的「自动记忆」记忆书，下一轮自然注入。这样可以适配**任何** OpenAI 兼容端点：
   * 不需要 function calling，流式也不会被 tool_calls 增量打断。
   */
  const MEMORY_MARKER_RE = /[\[【]{1,2}\s*记住\s*[:：]\s*([^\]】\n]+?)\s*[\]】]{1,2}/g;

  function memoryInstruction(characterLabel) {
    return [
      "[Memory]",
      `你有一个只属于「${characterLabel || "你"}」的长期记忆本，跨会话保留。`,
      "当玩家透露了值得长期记住的信息（称呼、喜好、约定、重要事件、关系变化），",
      "在回复的最后单独起行写：[[记住: 一句话要点]]，一行一条，最多 3 条。",
      "没有值得记的就不要写。不要在正文里解释这个标记——它会被系统读取并从文本里移除。",
      "上面 [Memory Book: …] 里是你以前记下的内容，自然地用，不要照抄。",
    ].join("\n");
  }

  /** 从回复里剥出记忆标记。返回清理后的正文与要点数组。 */
  function extractMemories(text) {
    const memories = [];
    const source = String(text || "");
    MEMORY_MARKER_RE.lastIndex = 0;
    let match;
    while ((match = MEMORY_MARKER_RE.exec(source)) !== null) {
      const value = String(match[1] || "").trim();
      if (value && memories.indexOf(value) < 0) memories.push(value);
    }
    const cleaned = source
      .replace(MEMORY_MARKER_RE, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text: cleaned, memories: memories.slice(0, 3) };
  }

  function buildSystemPrompt(card, memoryBooks, promptText, options) {
    const parts = [
      cardField(card, "system_prompt"),
      "",
      "[Character] " + cardField(card, "description"),
      "[Personality] " + cardField(card, "personality"),
      "[Scenario] " + cardField(card, "scenario"),
      "",
      "[Always-relevant]",
    ];

    const bookEntries = cardBookEntries(card);
    const constants = bookEntries.filter((e) => CARD_CONSTANT_IDS.includes(e.id));
    for (const e of constants) parts.push(e.content);

    const cardLore = matchedCardLore(card, promptText);
    if (cardLore.length) {
      parts.push("[Relevant lore]");
      for (const e of cardLore) parts.push(e.content);
    }

    for (const book of (memoryBooks || [])) {
      const mbConstants = (book.entries || []).filter((e) => e.constant && !e.disable);
      const mbMatched = (book.entries || []).filter((e) => !e.constant && !e.disable)
        .filter((e) => matchAny(memoryEntryKeywords(e), promptText));
      const used = mbConstants.concat(mbMatched);
      if (used.length) {
        parts.push("", `[Memory Book: ${book.name}]`);
        for (const e of used) parts.push(`[${e.uid}] ${e.content}`);
      }
    }

    parts.push("[Note] " + cardField(card, "post_history_instructions"));
    // Task-29G：AI 创建的角色固定说话语言（CCv3 extensions.task29.language）。
    const cardLanguage = card && card.data && card.data.extensions && card.data.extensions.task29
      && card.data.extensions.task29.language;
    if (cardLanguage === "zh") parts.push("[Language] 角色只说简体中文；你的所有回复一律使用中文。");
    else if (cardLanguage === "en") parts.push("[Language] The character only speaks English; always reply in English.");
    // 自动记忆：让模型自己记要点（可在设置里关掉）。
    if (options && options.autoMemory === true) {
      parts.push("", memoryInstruction(cardField(card, "name")));
    }
    return parts.join("\n");
  }

  /* 带「旁白/台词」输出约定的系统提示：基础组合 + 末尾格式指令（不影响与 Task-20 的逐字节对齐证明）。 */
  function buildSystemPromptWithFormat(card, memoryBooks, promptText, instruction, options) {
    return buildSystemPrompt(card, memoryBooks, promptText, options) +
      "\n\n[Reply format] " + (instruction || REPLY_FORMAT_INSTRUCTION);
  }

  /* ---------- 把混合回复切成有序的「旁白 / 台词」片段（双引号=台词，其余=旁白，保持原始顺序） ---------- */
  /* 旁白段里识别「短台词 + he says/mutters…」这种漏引号的台词（模型偶尔会不写引号）。 */
  const SPEECH_TAG_RE = /^(?:he|she|they|i|it|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:said|says|muttered|mutters|asked|asks|replied|replies|whispered|whispers|continued|continues|snapped|snaps|sighed|sighs|shouted|shouts|added|adds|murmured|murmurs|grumbled|grumbles|warned|warns|called|calls|cried|cries|repeated|repeats|insisted|insists)\b/i;

  function pushNarration(segments, text) {
    const paras = String(text || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      const next = paras[i + 1];
      if (next && SPEECH_TAG_RE.test(next) && p.length <= 160) {
        segments.push({ type: "dialogue", text: p });
        segments.push({ type: "narration", text: next });
        i++;
      } else {
        segments.push({ type: "narration", text: p });
      }
    }
  }

  function splitReply(text) {
    const raw = String(text || "");
    const segments = [];
    const re = /["“]([^"”]*)["”]/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw))) {
      pushNarration(segments, raw.slice(last, m.index));
      const dialogue = m[1].trim();
      if (dialogue) segments.push({ type: "dialogue", text: dialogue });
      last = re.lastIndex;
    }
    pushNarration(segments, raw.slice(last));
    if (!segments.length) segments.push({ type: "narration", text: raw.trim() });
    return segments;
  }

  /* ---------- mes_example 解析（对齐 parseExample） ---------- */
  function parseExample(mesExample) {
    const t = mesExample || "";
    const turns = [];
    const re = /\{\{(user|char)\}\}:\s*([\s\S]*?)(?=\n\{\{(?:user|char)\}\}:|$)/g;
    let m;
    while ((m = re.exec(t))) {
      turns.push({ role: m[1] === "user" ? "user" : "assistant", content: m[2].trim() });
    }
    return turns;
  }

  /* ---------- 组合 messages（系统提示 + 示例 + 历史 + 用户新输入） ---------- */
  function composeMessages(card, memoryBooks, history, userText, options) {
    const msgs = [{ role: "system", content: buildSystemPromptWithFormat(card, memoryBooks, userText, null, options) }];
    for (const turn of parseExample(cardField(card, "mes_example"))) msgs.push(turn);
    for (const h of (history || [])) {
      if (!h || typeof h.mes !== "string" || !h.mes) continue;
      msgs.push({ role: h.is_user ? "user" : "assistant", content: h.mes });
    }
    msgs.push({ role: "user", content: userText });
    return msgs;
  }

  /* ---------- 生成请求 payload（网站版由浏览器直连云端端点） ---------- */
  function buildGeneratePayload(opts) {
    if (!opts) throw new Error("生成参数缺失");
    const mode = String(opts.mode || CHAT_MODES.LOCAL);
    if (isDeepSeekChatMode(mode)) {
      const thinking = opts.thinking === true;
      return {
        messages: composeMessages(opts.card, opts.memoryBooks, opts.history, opts.userText, { autoMemory: opts.autoMemory === true }),
        // 模型名以「设置 → 模型」里填的为准；mode 只决定走哪条通道。
        model: (opts.modelName && String(opts.modelName).trim()) || mode,
        chat_completion_source: "deepseek",
        stream: opts.stream === true,
        // 思考过程默认关闭：开着的话用户会先看到一段思维链、随后被正文顶掉。
        // include_reasoning=false 是明确要求接口不要回传 reasoning_content。
        include_reasoning: thinking,
        ...(thinking ? { reasoning_effort: "high" } : {}),
        ...DEEPSEEK_CHAT_SAMPLING,
        task22_engine: "deepseek",
      };
    }
    if (opts.engine !== "A") throw new Error("引擎 B 当前未启动，发送已禁用。");
    const oai = (opts.settings && opts.settings.oai_settings) || {};
    return {
      messages: composeMessages(opts.card, opts.memoryBooks, opts.history, opts.userText, { autoMemory: opts.autoMemory === true }),
      model: "local",
      chat_completion_source: "custom",
      custom_url: oai.custom_url || "",
      custom_include_body: (oai.custom_include_body !== undefined && oai.custom_include_body !== null)
        ? oai.custom_include_body
        : "chat_template_kwargs:\n  enable_thinking: false",
      stream: opts.stream === true,
      ...SAMPLING,
      task22_engine: opts.engine || "A",
    };
  }

  function parseGenerateResponse(json) {
    const choice = json && json.choices && json.choices[0];
    return {
      content: (choice && choice.message && choice.message.content) || "",
      finish_reason: (choice && choice.finish_reason) || null,
      raw: json,
    };
  }

  /* ---------- 聊天消息（对齐 ST JSONL 消息 schema） ---------- */
  function buildChatMessage(opts) {
    const mes = String(opts.mes || "");
    return {
      name: opts.name || "",
      is_user: !!opts.is_user,
      is_system: !!opts.is_system,
      send_date: opts.send_date || new Date().toISOString(),
      mes,
      extra: opts.extra && typeof opts.extra === "object" ? opts.extra : {},
      swipe_id: 0,
      swipes: (Array.isArray(opts.swipes) && opts.swipes.length) ? opts.swipes : [mes],
      swipe_info: [],
    };
  }

  const HARRY_CHAT_VERSION = "v1";
  const HARRY_ARCHIVED_KEY = "task21_archived";
  const HARRY_ARCHIVED_AT_KEY = "task21_archived_at";
  /* Task-28C 模板占位 chat：前端隐藏，绝不修改/删除/保存到它。 */
  const TEMPLATE_PLACEHOLDER_FILE = "harry-task28b-initial";
  /* Task-29A：新聊天首条消息角色绑定 —— 固定在 JSONL 首行头 chat_metadata 内，
     只在三步（初始化/发送/保存）全部成功的首轮保存写入，服务端不感知。 */
  const TASK29_CHARACTER_ID_KEY = "task29_character_id";
  const TASK29_CHARACTER_NAME_KEY = "task29_character_name";

  function cleanChatTitle(value, fallback = "新对话") {
    const cleaned = String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    return cleaned || fallback;
  }

  function deriveChatTitle(firstUserMessage) {
    return cleanChatTitle(firstUserMessage, "新对话");
  }

  function storagePart(value) {
    return encodeURIComponent(String(value || "unknown"));
  }

  function harrySessionStorageKey(userHandle, avatar) {
    return `task26a.harry.${HARRY_CHAT_VERSION}.${storagePart(userHandle)}.${storagePart(avatar)}.last-chat`;
  }

  /* Task-29A：多角色统一的“最近聊天”键；旧键（按头像）仅作只读回退。 */
  function chatStorageKey(userHandle) {
    return `task29a.chats.${HARRY_CHAT_VERSION}.${storagePart(userHandle)}.last-chat`;
  }

  function randomToken() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID().replaceAll("-", "");
      }
    } catch (_) { /* browser crypto may be unavailable in an offline test */ }
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function chatFileId(value) {
    const raw = value && typeof value === "object" ? (value.file_id || value.file_name) : value;
    return String(raw || "").replace(/\.jsonl$/i, "");
  }

  function asDate(value) {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
    const parsed = new Date(String(value || ""));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatChatTime(value) {
    const date = asDate(value);
    if (!date) return "更早";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function chatDayLabel(value, now = new Date()) {
    const date = asDate(value);
    if (!date) return "更早";
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const difference = today - day;
    if (difference <= 0) return "今天";
    if (difference <= 6 * 86400000) return "最近 7 天";
    return "更早";
  }

  function chatSummaryTitle(summary, fallbackDate) {
    const metadata = summary && summary.chat_metadata && typeof summary.chat_metadata === "object"
      ? summary.chat_metadata : {};
    const explicit = metadata.ui_title || metadata.title || (summary && summary.title);
    if (explicit) return cleanChatTitle(explicit);
    return `Harry 对话 · ${formatChatTime((summary && summary.last_mes) || fallbackDate)}`;
  }

  function normalizeChatSummary(summary) {
    const fileName = chatFileId(summary);
    if (!fileName) return null;
    const metadata = summary && summary.chat_metadata && typeof summary.chat_metadata === "object"
      ? summary.chat_metadata : {};
    const rawTime = summary && (summary.last_mes || summary.updated_at || summary.updatedAt);
    const date = asDate(rawTime);
    const updatedAt = date ? date.toISOString() : "1970-01-01T00:00:00.000Z";
    return {
      id: fileName,
      fileName,
      title: chatSummaryTitle(summary, updatedAt),
      updatedAt,
      serverSaved: true,
      lines: [],
      messages: [],
      loaded: false,
      archived: metadata[HARRY_ARCHIVED_KEY] === true,
      archivedAt: typeof metadata[HARRY_ARCHIVED_AT_KEY] === "string" ? metadata[HARRY_ARCHIVED_AT_KEY] : "",
      summary: summary || {},
    };
  }

  function messagesFromChat(lines) {
    return (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.mes === "string");
  }

  function buildSavePayload(existingChat, userMessage, assistantMessage, opts) {
    let arr = Array.isArray(existingChat) ? existingChat.slice() : [];
    const first = arr[0];
    const hasHeader = first && typeof first === "object" && Object.prototype.hasOwnProperty.call(first, "chat_metadata");
    const title = opts && opts.title ? cleanChatTitle(opts.title) : "";
    if (hasHeader) {
      // 保留头部元数据，但去掉 integrity slug：force 写入后避免陈旧 slug 触发 UI 不一致告警。
      const header = Object.assign({}, first);
      header.chat_metadata = Object.assign({}, first.chat_metadata || {});
      delete header.chat_metadata.integrity;
      if (title) header.chat_metadata.ui_title = title;
      arr[0] = header;
    } else {
      // ST 要求 JSONL 首行为元数据头；新会话补一个空头，避免首条消息被当作头消费。
      const metadata = title ? { ui_title: title } : {};
      // Task-29A：新建聊天的首轮保存固定角色绑定（三步全部成功后才会走到这里）。
      const bind = opts && opts.bind;
      if (bind && bind.avatar) {
        metadata[TASK29_CHARACTER_ID_KEY] = String(bind.avatar);
        metadata[TASK29_CHARACTER_NAME_KEY] = String(bind.charName || "");
      }
      arr.unshift({
        chat_metadata: metadata,
        user_name: (opts && opts.userName) || "",
        character_name: (opts && opts.charName) || "",
      });
    }
    if (userMessage) arr.push(userMessage);
    if (assistantMessage) arr.push(assistantMessage);
    return arr;
  }

  function buildArchivePayload(existingChat, archived, archivedAt) {
    const arr = Array.isArray(existingChat) ? existingChat.slice() : [];
    const first = arr[0];
    const hasHeader = first && typeof first === "object" && Object.prototype.hasOwnProperty.call(first, "chat_metadata");
    const header = hasHeader
      ? Object.assign({}, first, { chat_metadata: Object.assign({}, first.chat_metadata || {}) })
      : { chat_metadata: {}, user_name: "", character_name: "" };
    delete header.chat_metadata.integrity;
    if (archived) {
      header.chat_metadata[HARRY_ARCHIVED_KEY] = true;
      header.chat_metadata[HARRY_ARCHIVED_AT_KEY] = String(archivedAt || new Date().toISOString());
    } else {
      delete header.chat_metadata[HARRY_ARCHIVED_KEY];
      delete header.chat_metadata[HARRY_ARCHIVED_AT_KEY];
    }
    if (hasHeader) arr[0] = header;
    else arr.unshift(header);
    return arr;
  }

  function newChatFileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `harry-task26a-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomToken().slice(0, 20)}`;
  }

  /* ---------- 角色聊天服务器会话模型（无 DOM，浏览器与离线假后端共用）
     Task-29A：会话按角色头像寻址；空白新会话 avatar 为 null（未绑定），
     首轮三步成功后由 bindActive 固定，随后按该头像保存并写入绑定元数据。 ---------- */
  function createHarryChatModel(options) {
    const opts = options || {};
    const api = opts.api;
    if (!api || typeof api.listChats !== "function" || typeof api.getChat !== "function" || typeof api.saveChat !== "function") {
      throw new Error("Harry chat API unavailable");
    }
    const avatar = String(opts.avatar || "");
    const userHandle = String(opts.userHandle || "unknown");
    const charName = String(opts.charName || "Harry Potter");
    const userName = String(opts.userName || "用户");
    const storage = opts.storage || (typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null);
    const storageKey = chatStorageKey(userHandle);
    const legacyStorageKey = harrySessionStorageKey(userHandle, avatar);
    const registry = (Array.isArray(opts.characters) && opts.characters.length
      ? opts.characters
      : [{ avatar, name: charName }])
      .map((entry) => ({
        avatar: String((entry && entry.avatar) || ""),
        name: String((entry && (entry.name || entry.charName)) || ""),
      }))
      .filter((entry) => entry.avatar);
    let sessions = [];
    let active = null;
    let knownServerFiles = new Set();
    let selectSequence = 0;
    let degraded = false;

    function readLast() {
      try {
        const raw = storage ? storage.getItem(storageKey) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.fileName === "string" && parsed.fileName && typeof parsed.avatar === "string" && parsed.avatar) {
            return { avatar: parsed.avatar, fileName: parsed.fileName };
          }
        }
      } catch (_) { /* unreadable preference is ignored */ }
      // Task-29A：旧键只读回退 —— 按注册表顺序逐个尝试，命中即用；旧键永不写、永不删。
      for (const entry of registry) {
        let legacy = null;
        try { legacy = storage ? storage.getItem(harrySessionStorageKey(userHandle, entry.avatar)) : null; } catch (_) { legacy = null; }
        if (typeof legacy === "string" && legacy) return { avatar: entry.avatar, fileName: legacy };
      }
      return null;
    }

    function rememberActive() {
      if (!active || !active.serverSaved || !active.fileName || !active.avatar) return;
      try { storage?.setItem(storageKey, JSON.stringify({ avatar: active.avatar, fileName: active.fileName })); } catch (_) { /* optional preference */ }
    }

    function sortSessions() {
      sessions.sort((a, b) => {
        if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
        if (!a.serverSaved && b.serverSaved) return -1;
        if (a.serverSaved && !b.serverSaved) return 1;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      });
    }

    function createNewSession(options = {}) {
      if (!options.force && active && !active.archived && Array.isArray(active.messages) && active.messages.length === 0) return active;
      const session = {
        id: `local-${randomToken()}`,
        fileName: newChatFileName(),
        title: "新对话",
        updatedAt: new Date().toISOString(),
        serverSaved: false,
        lines: [],
        messages: [],
        loaded: true,
        archived: false,
        archivedAt: "",
        // Task-29A：空白新会话未绑定角色；首轮三步成功后由 bindActive 固定。
        avatar: null,
        charName: "",
        pendingAvatar: null,
        pendingCharName: "",
      };
      // Keep earlier local drafts visible as "未保存" instead of silently dropping them.
      // They remain client-only until their own first successful turn is saved.
      sessions = [session, ...sessions];
      active = session;
      return session;
    }

    function replaceServerSessions(serverSessions) {
      const unsaved = active && !active.serverSaved ? active : null;
      sessions = unsaved ? [unsaved, ...serverSessions] : serverSessions.slice();
      knownServerFiles = new Set(serverSessions.map((item) => item.fileName));
      sortSessions();
    }

    async function hydrateSession(session, requestOptions = {}) {
      let lines;
      try { lines = await api.getChat(session.avatar, session.fileName, requestOptions); } catch (error) { throw error; }
      if (!Array.isArray(lines) || lines.length === 0) {
        const error = new Error("chat missing");
        error.code = "CHAT_MISSING";
        throw error;
      }
      session.lines = lines;
      session.messages = messagesFromChat(lines);
      const header = lines[0] && typeof lines[0] === "object" ? lines[0] : {};
      const metadata = header.chat_metadata && typeof header.chat_metadata === "object" ? header.chat_metadata : {};
      if (metadata.ui_title) session.title = cleanChatTitle(metadata.ui_title);
      session.archived = metadata[HARRY_ARCHIVED_KEY] === true;
      session.archivedAt = typeof metadata[HARRY_ARCHIVED_AT_KEY] === "string" ? metadata[HARRY_ARCHIVED_AT_KEY] : "";
      session.serverSaved = true;
      session.loaded = true;
      session.updatedAt = session.summary && session.summary.last_mes
        ? (asDate(session.summary.last_mes)?.toISOString() || new Date().toISOString())
        : new Date().toISOString();
      return session;
    }

    async function loadSession(session, requestOptions = {}) {
      await hydrateSession(session, requestOptions);
      active = session;
      rememberActive();
      sortSessions();
      return session;
    }

    async function refresh(refreshOptions = {}) {
      const preserveUnsaved = refreshOptions.preserveUnsaved !== false;
      if (!preserveUnsaved && active && !active.serverSaved) active = null;
      // Task-29A：遍历角色注册表合并全部角色的聊天；单个角色列表失败时
      // 保留其余角色结果（降级），全部失败才抛出。
      const serverSessions = [];
      let failures = 0;
      let authError = null;
      for (const entry of registry) {
        try {
          const raw = await api.listChats(entry.avatar, { metadata: true });
          if (!Array.isArray(raw)) throw new Error("chat list unavailable");
          for (const summary of raw.map(normalizeChatSummary).filter(Boolean)) {
            // Task-28C 模板占位 chat 不进入列表（前端隐藏，绝不改动它）。
            if (summary.fileName === TEMPLATE_PLACEHOLDER_FILE) continue;
            summary.avatar = entry.avatar;
            summary.charName = entry.name;
            serverSessions.push(summary);
          }
        } catch (error) {
          if (error && (error.authRequired === true || error.code === "AUTH_REQUIRED")) { authError = error; continue; }
          failures += 1;
        }
      }
      if (authError) throw authError;
      if (!serverSessions.length && failures === registry.length) throw new Error("chat list unavailable");
      degraded = failures > 0;
      serverSessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      replaceServerSessions(serverSessions);

      if (preserveUnsaved && active && !active.serverSaved && !active.archived) return active;
      const remembered = readLast();
      const candidates = [];
      if (remembered) {
        const preferred = serverSessions.find((item) => item.fileName === remembered.fileName
          && item.avatar === remembered.avatar && !item.archived);
        if (preferred) candidates.push(preferred);
      }
      for (const item of serverSessions) if (!item.archived && !candidates.includes(item)) candidates.push(item);
      for (const candidate of candidates) {
        try { return await loadSession(candidate); }
        catch (error) {
          if (!error || error.code !== "CHAT_MISSING") throw error;
        }
      }
      return createNewSession();
    }

    async function select(sessionId, requestOptions = {}) {
      const requestId = ++selectSequence;
      const target = sessions.find((item) => item.id === sessionId || item.fileName === sessionId);
      if (!target) throw new Error("chat not found");
      if (!target.serverSaved) {
        if (requestId === selectSequence) active = target;
        return target;
      }
      await hydrateSession(target, requestOptions);
      if (requestId !== selectSequence) {
        const error = new Error("stale chat selection");
        error.code = "CHAT_STALE";
        throw error;
      }
      active = target;
      rememberActive();
      sortSessions();
      return target;
    }

    function ensureUniqueFileName(session) {
      if (!knownServerFiles.has(session.fileName)) return;
      let next = newChatFileName();
      while (knownServerFiles.has(next)) next = newChatFileName();
      session.fileName = next;
      session.id = `local-${randomToken()}`;
    }

    function bindActive(binding) {
      if (!active) throw new Error("no active chat");
      const nextAvatar = String((binding && binding.avatar) || "");
      if (!nextAvatar) throw new Error("character unavailable");
      // 已绑定会话绝不允许中途换角色；换角色必须新建聊天。
      if (active.avatar && active.avatar !== nextAvatar) {
        const error = new Error("chat already bound");
        error.code = "CHAT_ALREADY_BOUND";
        throw error;
      }
      active.avatar = nextAvatar;
      active.charName = String((binding && binding.charName) || active.charName || "");
      // 保留 pending 选择：保存失败后 unbindActive 回滚时，用户已选角色不丢失。
      return active;
    }

    function unbindActive() {
      // 仅允许把「尚未保存到服务器的绑定」撤销回未绑定态（保存失败路径）。
      if (!active || active.serverSaved || (active.messages && active.messages.length)) return;
      active.avatar = null;
      active.charName = "";
    }

    async function saveTurn(text, assistantText, saveOptions = {}) {
      if (!active) throw new Error("no active chat");
      if (!active.avatar) {
        const error = new Error("chat not bound to a character");
        error.code = "CHAT_UNBOUND";
        throw error;
      }
      const userText = String(text || "").trim();
      const reply = String(assistantText || "").trim();
      if (!userText || !reply) throw new Error("empty chat turn");
      if (!active.serverSaved) ensureUniqueFileName(active);
      const title = active.title === "新对话" ? deriveChatTitle(userText) : active.title;
      const userMessage = buildChatMessage({ name: saveOptions.userName || userName, is_user: true, mes: userText });
      const assistantMessage = buildChatMessage({
        name: saveOptions.charName || active.charName || charName,
        is_user: false,
        mes: reply,
        extra: saveOptions.extra || {},
      });
      const payload = buildSavePayload(active.lines, userMessage, assistantMessage, {
        userName: saveOptions.userName || userName,
        charName: saveOptions.charName || active.charName || charName,
        title,
        // 新建聊天的首轮保存把角色绑定固定进首行头；已有头部文件不重写绑定键。
        bind: { avatar: active.avatar, charName: active.charName || (saveOptions.charName || charName) },
      });
      await api.saveChat(active.avatar, active.fileName, payload, true, { signal: saveOptions.signal });
      active.lines = payload;
      active.messages = messagesFromChat(payload);
      active.title = title;
      active.serverSaved = true;
      active.loaded = true;
      active.archived = false;
      active.archivedAt = "";
      active.updatedAt = new Date().toISOString();
      active.id = active.fileName;
      knownServerFiles.add(active.fileName);
      rememberActive();
      sortSessions();
      return { session: active, payload };
    }

    async function setArchived(sessionId, archived) {
      const target = sessions.find((item) => item.id === sessionId || item.fileName === sessionId);
      if (!target) throw new Error("chat not found");
      if (!target.serverSaved && (!target.messages || target.messages.length === 0)) {
        const error = new Error("empty chat");
        error.code = "CHAT_EMPTY";
        throw error;
      }
      await hydrateSession(target);
      if (!target.messages.length) {
        const error = new Error("empty chat");
        error.code = "CHAT_EMPTY";
        throw error;
      }
      const archivedAt = archived ? new Date().toISOString() : "";
      const payload = buildArchivePayload(target.lines, archived, archivedAt);
      await api.saveChat(target.avatar, target.fileName, payload, true);
      target.lines = payload;
      target.archived = !!archived;
      target.archivedAt = archivedAt;
      target.serverSaved = true;
      target.loaded = true;

      if (!archived) {
        sessions = sessions.filter((item) => item === target || item.serverSaved || (item.messages && item.messages.length > 0));
        active = target;
        rememberActive();
      } else if (active === target || (active && active.fileName === target.fileName)) {
        active = null;
        const candidates = sessions.filter((item) => item !== target && !item.archived);
        for (const candidate of candidates) {
          if (!candidate.serverSaved) { active = candidate; break; }
          try { await loadSession(candidate); break; }
          catch (error) {
            if (!error || error.code !== "CHAT_MISSING") throw error;
          }
        }
        if (!active) createNewSession();
      }
      sortSessions();
      return { session: target, active, payload };
    }

    // Task-30E：从会话列表移除该会话，并清除对应「最后会话」localStorage 指针。
    // 不触发归档/保存；服务端 .jsonl 删除由调用方先调 STApi.deleteChat 完成。
    function remove(sessionId) {
      const target = sessions.find((item) => item.id === sessionId || item.fileName === sessionId);
      if (!target) throw new Error("chat not found");
      sessions = sessions.filter((item) => item !== target);
      if (active === target || (active && active.fileName === target.fileName)) active = null;
      // 清除「最后会话」指针：当前用户键 + 该会话所属角色的旧键。
      try { storage?.removeItem(storageKey); } catch (_) { /* optional preference */ }
      if (target.avatar) {
        try { storage?.removeItem(harrySessionStorageKey(userHandle, target.avatar)); } catch (_) { /* optional */ }
      }
      sortSessions();
      return { removed: target, active };
    }

    return {
      storageKey,
      refresh,
      select,
      newSession: createNewSession,
      saveTurn,
      bindActive,
      unbindActive,
      getCharacters: () => registry.map((entry) => Object.assign({}, entry)),
      isDegraded: () => degraded,
      archive: (sessionId) => setArchived(sessionId, true),
      restore: (sessionId) => setArchived(sessionId, false),
      remove,
      getSessions: () => sessions.slice(),
      getActive: () => active,
      formatTime: formatChatTime,
      dayLabel: chatDayLabel,
    };
  }

  return {
    ENGINES,
    SAMPLING,
    CHAT_MODES,
    DEEPSEEK_CHAT_MODES,
    DEEPSEEK_LEGACY_MODES,
    DEEPSEEK_CHAT_SAMPLING,
    isDeepSeekChatMode,
    CARD_CONSTANT_IDS,
    REPLY_FORMAT_INSTRUCTION,
    cardField,
    cardBookEntries,
    cardEntryKeywords,
    memoryEntryKeywords,
    matchedCardLore,
    activatedMemoryEntries,
    buildSystemPrompt,
    buildSystemPromptWithFormat,
    splitReply,
    parseExample,
    composeMessages,
    buildGeneratePayload,
    parseGenerateResponse,
    extractMemory: extractMemories,
    memoryInstruction,
    buildChatMessage,
    buildSavePayload,
    buildArchivePayload,
    newChatFileName,
    HARRY_CHAT_VERSION,
    HARRY_ARCHIVED_KEY,
    HARRY_ARCHIVED_AT_KEY,
    TEMPLATE_PLACEHOLDER_FILE,
    TASK29_CHARACTER_ID_KEY,
    TASK29_CHARACTER_NAME_KEY,
    cleanChatTitle,
    deriveChatTitle,
    harrySessionStorageKey,
    chatStorageKey,
    chatFileId,
    formatChatTime,
    chatDayLabel,
    normalizeChatSummary,
    messagesFromChat,
    createHarryChatModel,
  };
});
