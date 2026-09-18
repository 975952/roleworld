"use strict";

/*
 * voice-core.js —— 角色"说话"的引擎层（云端合成 + 播放调度 + 语音输入）
 *
 * 这一轮的方向（2026-09-14 用户拍板，写在这里免得再走回头路）：
 *   **语音只走云端**，用火山引擎「豆包语音合成模型 2.0」，经体验卡中转。
 *   不做 Android 系统 TTS、不做浏览器自带朗读、不做本地模型，
 *   也**不保留"云端失败就退回系统朗读"**那条路 —— 那会让同一个角色
 *   有时候是情感音色、有时候是导航播报腔，用户根本不知道自己在听哪个。
 *
 * 这一层只做四件事，都不碰界面：
 *   ① 把模型回复变成"该念的文本"（剥掉 [[表情: …]] 这类给系统看的标记），并**合理分段**；
 *   ② 每个角色一份音色设置（用稳定的角色标识存，不是用名字）；
 *   ③ 顺序播放：切分 → 查缓存 → 合成 → 播 → 下一段；期间可取消、可重试；
 *   ④ 语音输入（说话 → 文字）—— 这一块**保持原样**，不在本轮范围内。
 *
 * 为什么把"分段"和"取消"放在这一层：它们是纯逻辑，能在 Node 里断言；
 * 而"哪一句开始播了"这种只有人耳能感觉的东西，只能靠状态回调暴露给界面。
 */

(function (global) {
  /* ==================================================================== *
   * 一、把模型回复变成"该念的文本"
   * ==================================================================== */

  /** 给系统看的标记（记忆/表情/事件/搜索）：一律不念。 */
  const MARKER_RE = /[\[【]{1,2}\s*(?:表情包?|贴纸|sticker|记住|事件|搜索|memory|event)\s*[:：][^\]】]*[\]】]{1,2}/gi;

  /**
   * 清理成"能念的文本"。
   *
   * ⚠ **这里不再截断**。上一版留了一句 `slice(0, 1200)` —— 那是"念不完就算了"的
   * 占位做法：用户只听到前半句，后半句永远听不到，而且界面上看不出发生过什么。
   * 现在长文本交给 splitForSpeech() 分段，一段一段念完，**一个字都不丢**。
   */
  function speakableText(text, options) {
    const opts = options || {};
    let out = String(text === undefined || text === null ? "" : text);
    out = out.replace(MARKER_RE, " ");
    if (opts.skipNarration) {
      // 「只念对白」必须在**去掉引号之前**做：引号就是判据，先删就再也分不出旁白了。
      const quoted = out.match(/["“][^"”]+["”]/g);
      if (quoted && quoted.length) out = quoted.join(" ");
    }
    // markdown 装饰符号
    out = out.replace(/[*_`#>]+/g, " ");
    // 引号本身不念（"他说"这种引号读出来很怪）
    out = out.replace(/[“”"『』「」]/g, " ");
    // 括号里的动作（（笑）/(sighs)）默认不念
    out = out.replace(/[（(][^）)]{0,24}[）)]/g, " ");
    out = out.replace(/\s+/g, " ").trim();
    return out;
  }

  /** 句子边界：中英文句末标点 + 换行。分隔符**留在前一段里**，join 起来能还原原文。 */
  const SENTENCE_SPLIT_RE = /[^。！？!?；;\n]*[。！？!?；;\n]+|[^。！？!?；;\n]+$/g;
  /** 次级边界（逗号、顿号）：一整句太长时优先在这里断，听起来比硬切自然。 */
  const CLAUSE_SPLIT_RE = /[^，,、：:]*[，,、：:]+|[^，,、：:]+$/g;

  function packPieces(pieces, maxChars, out) {
    let current = "";
    for (const piece of pieces) {
      if (current && current.length + piece.length > maxChars) {
        out.push(current);
        current = piece;
      } else {
        current += piece;
      }
    }
    if (current) out.push(current);
    return out;
  }

  /**
   * 把清理后的文本切成若干段，每段不超过 maxChars。
   *
   * **硬要求：chunks.join("") === text**（顺序完整、一个字不丢、不重复）。
   * 这条是可断言的，也是这一轮"不要静默截断"的落点 —— 见 tests/voice-unit.cjs。
   */
  function splitForSpeech(text, options) {
    const opts = options || {};
    const maxChars = Math.max(20, Number(opts.maxChars) || 220);
    const source = String(text === undefined || text === null ? "" : text).trim();
    if (!source) return [];
    if (source.length <= maxChars) return [source];

    const sentences = source.match(SENTENCE_SPLIT_RE) || [source];
    const out = [];
    let pending = "";
    const flush = () => { if (pending) { out.push(pending); pending = ""; } };

    for (const sentence of sentences) {
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        // 单句就超长（模型偶尔会写出一整段没有句号的独白）：先按逗号断，还超就硬切。
        flush();
        const clauses = sentence.match(CLAUSE_SPLIT_RE) || [sentence];
        const pieces = [];
        for (const clause of clauses) {
          if (clause.length <= maxChars) { pieces.push(clause); continue; }
          for (let i = 0; i < clause.length; i += maxChars) pieces.push(clause.slice(i, i + maxChars));
        }
        packPieces(pieces, maxChars, out);
        continue;
      }
      if (pending && pending.length + sentence.length > maxChars) flush();
      pending += sentence;
    }
    flush();
    // 兜底：万一正则把某个字符吃掉了，也不能让内容消失（宁可多一段，不可少一个字）。
    const joined = out.join("");
    if (joined !== source) {
      const chunks = [];
      for (let i = 0; i < source.length; i += maxChars) chunks.push(source.slice(i, i + maxChars));
      return chunks;
    }
    return out;
  }

  /**
   * 「软件聊天模式」用的**纯对白**提取：把回复里的对白挑出来，去掉引号与旁白。
   *
   * 为什么要有它、而且只写一份：**界面看到的**和**念出来/发出去的**必须是同一份文本。
   * 两处各写一套（渲染一套、朗读一套）迟早会飘 —— 用户会遇到"屏幕上只显示对白、
   * 但语音念的是旁白"这种对不上的事。所以渲染与语音都调这里。
   *
   * 规则（可断言）：
   *   · 有引号（"…" / “…” / 「…」 / 『…』）→ 只取引号**里面**的内容，按出现顺序返回；
   *   · **一个引号都没有** → 整段原样返回（模型没按格式写时，不能把内容吞掉）；
   *   · 返回的是**数组**（一段一段的对白），渲染用换行拼、朗读用空格拼，各自决定。
   */
  /**
   * 去掉**动作/神态/旁白**那种括号段（2026-09-14 用户实测反馈：
   * 「（把最后一盏灯关了，只留门口那点光）关门了。这是何意味，我说了就语音，不要文字也不要描述」）。
   *
   * 模型不听话时提示词救不了，所以在这里再兜一道：
   *   · 去掉 `（…）` / `(…)` 与 `*…*` 这种整段包裹的描写；
   *   · 但如果**去掉之后什么都不剩**（整条就是一段动作），那就保留原文 —— 不能把内容吞空。
   */
  const STAGE_DIRECTION_RE = /[（(][^（()）]{1,80}[）)]|\*[^*\n]{1,80}\*/g;

  function stripStageDirections(text) {
    const raw = String(text === undefined || text === null ? "" : text);
    if (!raw.trim()) return "";
    const cleaned = raw
      .replace(STAGE_DIRECTION_RE, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    return cleaned || raw.trim();
  }

  /**
   * 去掉**没加括号的旁白/动作句**（2026-09-14 用户实测反馈：
   * 「还是有描述性的语句，现在是用语音拨出来的」——模型写"他摊了下手，"这种旁白，
   * 我们照念了，听起来还是有声书）。
   *
   * 只在"微信式聊天"这条路上用（渲染与语音共用），判据是**保守**的三条：
   *   · 整句被括号/星号包着 → 描写；
   *   · 句子里有明确的动作词（点头/笑了笑/叹了口气/转身/摊手…）且句子里没有引号 → 描写；
   *   · 句子以第三人称（他/她/它/他们…）开头 → 描写（真人对你说话不会用"他"说自己）。
   * 全被去掉时**保留原文**：宁可留一句多余的话，也不能把内容清空。
   */
  const NARRATION_VERBS = /(点了?点?头|笑了?笑?|笑了笑|叹了?(口)?气|皱了?皱?眉|耸了?耸肩|摊了?摊?手|摊手|转了?转身|回[过头来]+|低了?低头|抬了?抬头|摇了?摇?头|抬起|放下|拿起|伸手|走向|走进|坐下|站起|看[着向]|盯着|沉默|顿了顿|停了一下|咳嗽|眨了?眨?眼|眯起|咧开|勾了?勾?嘴角|吻了?|抱[住起]|推开|拉过|递[过给]|站起身|点了根烟|喝了?一口|抽了?一口)/;
  const THIRD_PERSON_RE = /^(他|她|它|他们|她们|它们)(?![们的])/;

  function looksLikeNarration(sentence) {
    const line = String(sentence || "").trim();
    if (!line) return false;
    if (/^[（(][\s\S]*[）)]$/.test(line)) return true;
    if (/^[（(][\s\S]*[）)]/.test(line) && line.replace(/^[（(][\s\S]*?[）)]/, "").trim() === "") return true;
    const hasQuote = /[“”"「」『』]/.test(line);
    if (!hasQuote && NARRATION_VERBS.test(line)) return true;
    if (THIRD_PERSON_RE.test(line)) return true;
    return false;
  }

  /** 把一段文字里的旁白句去掉（全去掉时保留原文，不吞空）。 */
  function stripNarration(text) {
    const raw = String(text === undefined || text === null ? "" : text).trim();
    if (!raw) return "";
    // 按句末标点切；保留标点，拼回去时不用再补
    const sentences = raw.split(/(?<=[。！？!?…\n])/).map((one) => one.trim()).filter(Boolean);
    if (sentences.length < 1) return raw;
    const kept = sentences.filter((one) => !looksLikeNarration(one));
    if (!kept.length) return raw;                 // 全是旁白 → 宁可留着，也别清空
    return kept.join("").replace(/[ \t]{2,}/g, " ").trim();
  }

  function dialogueSegments(text) {
    const raw = String(text === undefined || text === null ? "" : text).trim();
    if (!raw) return [];
    const out = [];
    const re = /"([^"]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      const piece = String(match[1] || match[2] || match[3] || match[4] || "").trim();
      if (piece) out.push(piece);
    }
    if (out.length) return out;
    // 没有引号：整段当对白，但**先去掉括号描写与没加括号的旁白句**（用户实测反馈：
    // 语音里带着「（把最后一盏灯关了…）」「他摊了下手，」这种描述，听起来像有声书）。
    // 全被去掉时保留原文 —— 不吞空。
    return [stripNarration(stripStageDirections(raw))];
  }

  /** 语音消息标记：`[[语音]]` / `[[voice]]`（可带说明，会被忽略）。 */
  const VOICE_MARKER_RE = /[\[【]{1,2}\s*(?:语音|voice)\s*(?:[:：][^\]】]*)?[\]】]{1,2}/gi;

  /**
   * 一条"分条消息"的生命周期状态（**交付类型一旦确定就不许再变**）。
   *
   * 用户 2026-09-14 实测反馈：「先看到文字 → 文字消失 → 出现语音」。
   * 根因不是哪一步写错了，而是**同一条消息在三种类型之间来回换**：
   * 流式先按文字画、解析完知道是语音了再换成气泡。所以现在把状态写死在数据里：
   *
   *   queued       —— 已经确定"这条是语音"，还没开始合成 → 显示"语音准备中"气泡（**不露正文**）
   *   synthesizing —— 正在合成                              → 同上（原位不动）
   *   ready        —— 合成好了，有缓存键                     → 可播放气泡（原位替换）
   *   failed       —— 合成失败/超长/语言不符                 → 失败气泡 + 重试 + 「改为文字」
   *
   * ⚠ **正文一个字都不能丢**：任何状态下 `part.text` 都在，只有 `failed` 或
   * 用户点「改为文字」时才把它显示出来。`mes` 里那份正文从头到尾没变过。
   */
  const PART_STATUS = Object.freeze({
    QUEUED: "queued",
    SYNTHESIZING: "synthesizing",
    READY: "ready",
    FAILED: "failed",
  });

  /** 这条 part 现在是不是"还在准备语音"（气泡要显示准备态，不许露正文）。 */
  function isPendingVoice(part) {
    if (!part || part.kind !== "voice") return false;
    return part.status === PART_STATUS.QUEUED || part.status === PART_STATUS.SYNTHESIZING;
  }

  /** 这条 part 是"语音但没成"（要显示失败态 + 重试）。 */
  function isFailedVoice(part) {
    return !!part && part.kind === "voice" && part.status === PART_STATUS.FAILED;
  }

  /**
   * 一条消息**这一轮到底交付成什么**（界面、持久化、测试共用这一份判断）。
   *
   * 返回 { deliver: "voice" | "voice-pending" | "voice-failed" | "text", showText }
   *   · `showText` 是屏幕上该不该出现正文 —— **准备中与失败态都是 false**
   *     （用户明确要求："在消息类型尚未确定时只显示稳定的输入状态，不向用户显示会被替换的正文"；
   *      失败时给一个明确的失败态与重试，而不是偷偷把正文亮出来）。
   *   · 用户主动点「改为文字」之后，part 会被真正改写成 `kind: "text"`（落盘），
   *     那时这里自然返回 text —— 不需要额外的开关状态。
   */
  function deliveryOf(part) {
    // 「本来要发语音、但这件事重试也没用」→ 退回文字，并**在消息上写明为什么**
    // （`note` 由合成那一侧写在 part 上；这里只负责分类）。
    if (part && part.kind !== "voice" && part.note) return { deliver: "voice-fallback", showText: true };
    if (!part || part.kind !== "voice") return { deliver: "text", showText: true };
    if (isPendingVoice(part)) return { deliver: "voice-pending", showText: false };
    if (isFailedVoice(part)) return { deliver: "voice-failed", showText: false };
    if (part.status === PART_STATUS.READY && part.key) return { deliver: "voice", showText: false };
    // 没有 status 也没有 key：老存档 / 分条之前的形状 —— 当作"说好了是语音但没合成"，
    // 不能谎称可播放（点了没反应比没有更糟），也不能露正文（那正是要修的闪文字）。
    return { deliver: "voice-failed", showText: false };
  }

  /**
   * 从一段回复里取出"要不要发语音"，并把标记剥掉。
   * 跟 `[[表情: …]]` 同一套路：**标记绝不留在气泡里**，而且**存之前就剥**。
   * 返回 { text, wantVoice }。
   */
  function extractVoiceMessage(text) {
    const raw = String(text === undefined || text === null ? "" : text);
    const matched = VOICE_MARKER_RE.test(raw);
    VOICE_MARKER_RE.lastIndex = 0;
    const clean = raw.replace(VOICE_MARKER_RE, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text: clean, wantVoice: matched };
  }

  /**
   * 流式过程中半截标记（`[[语`）不能进正文 —— 跟表情那套一样，等它写完再决定。
   *
   * ⚠ 这里必须要求**两个**左括号（`[[` / `【`），不能写成 `[\[【]{1,2}`：
   * 那样连普通的"句尾一个左括号"都会被吃掉（"他写下：[1" 会被截成"他写下："）。
   * 表情那一条用的是同样的写法，照它来。
   */
  function stripPartialVoiceMarker(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(/(?:\n?[ \t]*)(?:\[\[|【)\s*(?:语|语音|v|vo|voi|voic)?\s*[:：]?[^\]】\n]*$/i, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  /**
   * 把模型这一轮的回复切成**一条一条的消息**（2026-09-14 用户要求：
   * "我发一条他不一定就发一条，也可以发几条，尽可能模仿真人"）。
   *
   * 规则（可断言）：
   *   · **空行分段**：一段 = 一条消息（段内的单换行保留，那是同一条消息里的换行）；
   *   · 某一段里单独一行写 `[[语音]]` / `[[voice]]` → **这一条是语音消息**（标记剥掉、不留正文）；
   *   · 最多 `MAX_REPLY_PARTS` 条：超出的并进最后一条（**绝不丢内容**）；
   *   · 空段丢掉；全空返回 []。
   *
   * 为什么放在这里：解析、渲染、语音三处都要用同一份切法，
   * 各写一套迟早会飘成"屏幕上三条、念出来两条"。
   */
  const MAX_REPLY_PARTS = 4;

  function splitReplyParts(text, options) {
    const opts = options || {};
    const max = Number(opts.maxParts) > 0 ? Math.floor(Number(opts.maxParts)) : MAX_REPLY_PARTS;
    const raw = String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n");
    const chunks = raw.split(/\n[ \t]*\n+/).map((one) => one.trim()).filter(Boolean);
    const parts = [];
    for (const chunk of chunks) {
      const parsed = extractVoiceMessage(chunk);
      const body = parsed.text.trim();
      if (!body) {
        // 整段只有一个标记 = 没有要说的话：直接丢掉（免得出现一条空语音）
        continue;
      }
      parts.push({ kind: parsed.wantVoice ? "voice" : "text", text: body });
    }
    if (parts.length <= max) return parts;
    // 超出上限：把多出来的并进**最后一条**（宁可显示成一条长的，也不丢字）
    const head = parts.slice(0, max - 1);
    const tail = parts.slice(max - 1);
    const joined = tail.map((one) => one.text).filter(Boolean).join("\n");
    head.push({ kind: tail.some((one) => one.kind === "voice") && !joined ? "voice" : "text", text: joined });
    return head;
  }

  /**
   * 一条语音消息**到底念哪段字**、以及**多长就不发了**（2026-09-14 用户拍板：角色发语音消息）。
   *
   * 三条规则（都放在这里判一次，界面与合成两处都调它，免得各写一套飘掉）：
   *   ① 只念**对白**（走 dialogueSegments，跟屏幕上"纯对白"排版是同一份文本）；
   *   ② 空的（一句对白都没有）→ 不发语音；
   *   ③ **超过上限就不发**（默认 120 字）—— 不静默截断。
   *      为什么是"不发"而不是"截一半"：微信里没人用语音发一大段；截断会让用户
   *      听到半句话还不知道少了什么。宁可不发（那条回复照样是文字，一个字不丢）。
   *      返回空串 = 这条不发语音，调用方别自己再决定一次。
   */
  const VOICE_MESSAGE_MAX_CHARS = 120;

  function voiceMessageText(text, options) {
    const opts = options || {};
    const max = Number(opts.maxChars) > 0 ? Math.floor(Number(opts.maxChars)) : VOICE_MESSAGE_MAX_CHARS;
    const segments = dialogueSegments(text);
    // 再兜一道：引号里的内容也可能夹着「（笑）」这种描写 —— 只念真正说出口的话。
    const joined = segments.map((one) => stripStageDirections(one)).filter(Boolean).join(" ").trim();
    if (!joined) return "";
    if (joined.length > max) return "";
    return joined;
  }

  /* ==================================================================== *
   * 二、每个角色一个音色（用**稳定的角色标识**存）
   * ==================================================================== */

  /** 旧版（本机系统 TTS）留下的键：rate/pitch 是那套引擎的参数，云端不通用。 */
  const LEGACY_FIELDS = ["rate", "pitch", "volume", "voiceURI"];
  /** 语速：官方 speech_rate 范围 [-50, 100]，0 = 正常。 */
  const SPEECH_RATE_RANGE = Object.freeze({ min: -50, max: 100 });

  function clampSpeechRate(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(SPEECH_RATE_RANGE.min, Math.min(SPEECH_RATE_RANGE.max, Math.round(number)));
  }

  function hash(text) {
    let value = 2166136261;
    const source = String(text || "");
    for (let i = 0; i < source.length; i += 1) {
      value ^= source.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return Math.abs(value);
  }

  /**
   * 这个角色默认用哪个音色。
   * 按**稳定标识**（角色卡的 avatar 文件名）确定性散列 —— 同一个角色每次都一样，
   * 不同角色尽量不一样。用名字当种子是不行的：改名会让声音变掉。
   */
  function defaultSpeakerFor(identity, speakers) {
    const list = Array.isArray(speakers) ? speakers.filter((one) => one && one.id) : [];
    if (!list.length) return "";
    const seed = hash(String(identity || "角色"));
    return list[seed % list.length].id;
  }

  /** 一条角色音色设置长什么样。 */
  function normalizeVoiceEntry(entry, identity, speakers) {
    const source = entry && typeof entry === "object" ? entry : {};
    const known = Array.isArray(speakers) ? speakers.map((one) => one.id) : [];
    const speaker = known.length
      ? (known.indexOf(String(source.speaker || "")) >= 0 ? String(source.speaker) : defaultSpeakerFor(identity, speakers))
      : String(source.speaker || "");
    return { speaker, speechRate: clampSpeechRate(source.speechRate) };
  }

  /**
   * 把旧存档里的 `voice_by_card` 迁到新形状。
   *
   * 旧形状（本机系统 TTS）：`{ rate: 1.2, pitch: 0.9 }` —— 那是**本机引擎**的参数，
   * 云端接口根本没有"音高"这一项。所以：
   *   · 语速是同一个概念，按 rate 换算成官方 speech_rate（rate 1.0 → 0，即"正常"）；
   *   · **音高不冒充**：直接丢掉，不假装它是云端的某个参数；旧值原样留在
   *     `voice_by_card_legacy` 里（用户的数据不删），面板上会说明这件事。
   *
   * 纯函数：返回 { map, legacy, migrated }，由调用方决定要不要写盘。
   */
  function migrateVoiceSettings(raw, speakers) {
    const source = raw && typeof raw === "object" ? raw : {};
    const map = {};
    const legacy = {};
    let migrated = 0;
    for (const [identity, value] of Object.entries(source)) {
      if (!value || typeof value !== "object") continue;
      const isLegacy = value.speaker === undefined
        && LEGACY_FIELDS.some((field) => value[field] !== undefined);
      if (isLegacy) {
        migrated += 1;
        legacy[identity] = value;
        map[identity] = {
          // rate 1.0 = 原速；0.8 → −20（慢 20%），1.5 → 50（快一半）。
          speechRate: clampSpeechRate((Number(value.rate) || 1) * 100 - 100),
        };
        continue;
      }
      map[identity] = { speaker: value.speaker, speechRate: clampSpeechRate(value.speechRate) };
      // speaker 可能是 undefined（旧形状换算过来时本来就没有音色）——
      // 那就**不要留这个键**：留着会让"再迁一次"的结果和第一次不相等（幂等性会被破坏）。
      if (map[identity].speaker === undefined) delete map[identity].speaker;
    }
    return { map, legacy, migrated };
  }

  /** 某个角色当前该用哪个音色/语速（没有就用确定性默认）。 */
  function voiceSettingFor(settings, identity, speakers) {
    const map = (settings && settings.voice_by_card) || {};
    return normalizeVoiceEntry(map[identity], identity, speakers);
  }

  /* ==================================================================== *
   * 三、播放：把一段音频放出来
   * ==================================================================== */

  /**
   * 播放器。用 HTMLAudioElement 播 Blob URL —— 三端（网页 / 桌面 WebView2 / 安卓 WebView）
   * 都有，而且**不依赖系统朗读接口**（安卓 WebView 里那个被 Chromium 关掉了）。
   *
   * env 只是为了让 Node 测试能注入替身，真实运行不传。
   */
  function createPlayer(env) {
    const source = env || {};
    const urlApi = source.urlApi || global.URL;
    const AudioCtor = source.AudioCtor || global.Audio;
    let current = null;
    let objectUrl = "";

    function release() {
      if (objectUrl && urlApi && typeof urlApi.revokeObjectURL === "function") {
        try { urlApi.revokeObjectURL(objectUrl); } catch (_) { /* 已经回收 */ }
      }
      objectUrl = "";
      current = null;
    }

    function stop() {
      const audio = current;
      release();
      if (audio) {
        try { audio.pause(); } catch (_) { /* 已经停了 */ }
        try { audio.src = ""; } catch (_) { /* 忽略 */ }
        if (typeof audio.onended === "function") audio.onended();
      }
    }

    function play(blob, options) {
      const opts = options || {};
      if (!blob || typeof AudioCtor !== "function" || !urlApi || typeof urlApi.createObjectURL !== "function") {
        return Promise.resolve({ ok: false, reason: "这个运行环境放不出音频（拿不到播放器）。" });
      }
      stop();
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (current === audio) release();
          resolve(result);
        };
        let audio;
        try {
          objectUrl = urlApi.createObjectURL(blob);
          audio = new AudioCtor(objectUrl);
        } catch (error) {
          release();
          resolve({ ok: false, reason: "音频播不出来：" + (error && error.message ? error.message : String(error)) });
          return;
        }
        current = audio;
        audio.onended = () => finish({ ok: true });
        audio.onerror = () => finish({ ok: false, reason: "这段音频播不出来（文件可能不完整）。" });
        if (opts.signal) {
          if (opts.signal.aborted) { stop(); finish({ ok: true, canceled: true }); return; }
          opts.signal.addEventListener("abort", () => { stop(); finish({ ok: true, canceled: true }); }, { once: true });
        }
        let started;
        try { started = audio.play(); } catch (error) {
          finish({ ok: false, reason: "播放没能启动：" + (error && error.message ? error.message : String(error)) });
          return;
        }
        if (started && typeof started.catch === "function") {
          started.catch((error) => {
            const name = error && error.name;
            finish({
              ok: false,
              reason: name === "NotAllowedError"
                ? "浏览器要求先有一次点击才允许出声 —— 再点一下「朗读」即可。"
                : "播放失败：" + (error && error.message ? error.message : String(error)),
            });
          });
        }
      });
    }

    return { play, stop, isPlaying: () => !!current };
  }

  /* ==================================================================== *
   * 四、调度：切分 → 查缓存 → 合成 → 播放 → 下一段
   * ==================================================================== */

  /** 只有"可能下次就好了"的错误才值得自动重试；额度/鉴权/参数错误重试一百次也一样。 */
  const RETRYABLE_CODES = ["VOICE_TIMEOUT", "UPSTREAM_UNREACHABLE", "UPSTREAM_STREAM_ERROR", "VOICE_BUSY", "NETWORK"];
  const RETRY_DELAY_MS = 400;
  const MAX_ATTEMPTS = 2;

  function delay(ms) {
    return new Promise((resolve) => global.setTimeout(resolve, ms));
  }

  /**
   * 建一个朗读调度器。
   *
   * deps.synth(text, { speaker, speechRate, signal }) → Promise<{
   *     ok, blob, base64, type, chars, retryable, code, reason }>
   * deps.cache            —— voice-cache 的实例（可省，省了就不缓存）
   * deps.keyFor(chunk, meta) —— 算缓存键（由 adapter 提供，因为要带上模型/资源标识）
   * deps.player           —— 默认 createPlayer()
   * deps.onState          —— 状态回调（给界面显示"正在生成 / 正在播放"）
   */
  function createController(deps) {
    const source = deps || {};
    const synth = source.synth;
    const cache = source.cache || null;
    const keyFor = source.keyFor || (() => "");
    const player = source.player || createPlayer();
    const retries = Number.isFinite(source.retries) ? source.retries : MAX_ATTEMPTS - 1;

    const state = { phase: "idle", index: 0, total: 0, fromCache: 0, requests: 0, reason: "" };
    let runId = 0;
    let runController = null;

    const snapshot = () => Object.assign({}, state);
    function emit(patch) {
      Object.assign(state, patch);
      if (typeof source.onState === "function") {
        try { source.onState(snapshot()); } catch (_) { /* 界面回调出错不该影响播放 */ }
      }
    }

    function isSpeaking() {
      return state.phase === "loading" || state.phase === "playing";
    }

    /** 停掉当前这一轮（同时**作废**所有还没走完的异步步骤）。 */
    function stop() {
      runId += 1;
      if (runController) { try { runController.abort(); } catch (_) { /* 已经结束 */ } }
      runController = null;
      try { player.stop(); } catch (_) { /* 没在放 */ }
      emit({ phase: "idle", index: 0, total: 0, reason: "" });
    }

    /**
     * 念一段话。
     * options: { speaker, speechRate, maxChars, identity, onFirstAudio }
     * 返回 { ok, reason, code, canceled, chunks, fromCache, requests }
     */
    async function speak(text, options) {
      const opts = options || {};
      const chunks = splitForSpeech(text, { maxChars: opts.maxChars });
      if (!chunks.length) return { ok: false, reason: "没有可朗读的内容。" };

      stop();                       // 新的一句顶掉旧的（聊天里连点两次不该叠着念）
      const run = runId;
      const controller = new AbortController();
      runController = controller;
      let fromCache = 0;
      let requests = 0;

      emit({ phase: "loading", index: 0, total: chunks.length, fromCache: 0, requests: 0, reason: "" });

      const canceled = () => runId !== run || controller.signal.aborted;

      for (let index = 0; index < chunks.length; index += 1) {
        if (canceled()) return { ok: true, canceled: true, chunks: chunks.length, fromCache, requests };
        const chunk = chunks[index];
        const meta = { text: chunk, speaker: opts.speaker, speechRate: opts.speechRate };
        const key = keyFor(chunk, meta);

        let blob = null;
        if (cache && key) {
          try { blob = await cache.getBlob(key); } catch (_) { blob = null; }
        }
        if (blob) {
          fromCache += 1;
        } else {
          emit({ phase: "loading", index, total: chunks.length, fromCache, requests });
          let attempt = 0;
          let result = null;
          for (;;) {
            if (canceled()) return { ok: true, canceled: true, chunks: chunks.length, fromCache, requests };
            requests += 1;
            result = await synth(chunk, {
              speaker: opts.speaker,
              speechRate: opts.speechRate,
              signal: controller.signal,
            });
            if (canceled()) return { ok: true, canceled: true, chunks: chunks.length, fromCache, requests };
            if (result && result.ok) break;
            const retryable = !!(result && (result.retryable || RETRYABLE_CODES.indexOf(result.code) >= 0));
            if (!retryable || attempt >= retries) {
              emit({ phase: "idle", index, total: chunks.length, reason: (result && result.reason) || "语音合成失败。" });
              return {
                ok: false, reason: (result && result.reason) || "语音合成失败。",
                code: (result && result.code) || "", index, chunks: chunks.length, fromCache, requests,
              };
            }
            attempt += 1;
            // 退避一下再试：上游偶发 5xx / 网络抖动时，立刻重发往往还是失败。
            await delay(RETRY_DELAY_MS * attempt);
          }
          blob = result.blob;
          if (cache && key && blob) {
            try {
              await cache.put(key, {
                base64: result.base64, type: result.type, bytes: result.bytes,
                chars: result.chars, speaker: opts.speaker, speechRate: opts.speechRate,
              });
            } catch (_) { /* 缓存写不进去不影响这次播放 */ }
          }
        }

        if (canceled()) return { ok: true, canceled: true, chunks: chunks.length, fromCache, requests };
        emit({ phase: "playing", index, total: chunks.length, fromCache, requests });
        if (index === 0 && typeof opts.onFirstAudio === "function") {
          try { opts.onFirstAudio(); } catch (_) { /* 界面回调出错不影响播放 */ }
        }
        const played = await player.play(blob, { signal: controller.signal });
        if (canceled()) return { ok: true, canceled: true, chunks: chunks.length, fromCache, requests };
        if (!played.ok) {
          emit({ phase: "idle", index, total: chunks.length, reason: played.reason });
          return { ok: false, reason: played.reason, index, chunks: chunks.length, fromCache, requests };
        }
      }

      emit({ phase: "idle", index: 0, total: chunks.length, fromCache, requests, reason: "" });
      return { ok: true, chunks: chunks.length, fromCache, requests };
    }

    return { speak, stop, isSpeaking, state: snapshot, _setPlayer: () => player };
  }

  /* ==================================================================== *
   * 五、语音输入（说话 → 文字）—— 本轮不动，只保留原行为
   * ==================================================================== */

  function hasSpeechRecognition() {
    try {
      return typeof global.SpeechRecognition === "function" || typeof global.webkitSpeechRecognition === "function";
    } catch (_) { return false; }
  }

  function hasMediaRecorder() {
    try {
      return typeof global.MediaRecorder === "function"
        && !!(global.navigator && global.navigator.mediaDevices && global.navigator.mediaDevices.getUserMedia);
    } catch (_) { return false; }
  }

  function listen(options) {
    const opts = options || {};
    if (!hasSpeechRecognition()) {
      return Promise.resolve({
        ok: false,
        reason: hasMediaRecorder()
          ? "这个环境没有内置语音识别，但可以录音 —— 配了支持转写的模型服务商时，会把录音发过去转成文字。"
          : "这个环境既不支持内置语音识别，也拿不到麦克风权限。",
      });
    }
    const Ctor = global.SpeechRecognition || global.webkitSpeechRecognition;
    return new Promise((resolve) => {
      let recognition;
      try {
        recognition = new Ctor();
      } catch (error) {
        return resolve({ ok: false, reason: "语音识别启动失败：" + (error && error.message ? error.message : String(error)) });
      }
      recognition.lang = opts.lang || "zh-CN";
      recognition.continuous = false;
      recognition.interimResults = true;
      let finalText = "";
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const row = event.results[i];
          const text = row[0] ? row[0].transcript : "";
          if (row.isFinal) finalText += text;
          else interim += text;
        }
        if (typeof opts.onPartial === "function") opts.onPartial(finalText, interim);
      };
      recognition.onerror = (event) => {
        const code = event && event.error ? event.error : "unknown";
        const reasons = {
          "not-allowed": "没有麦克风权限。请在系统设置里允许这个应用使用麦克风，然后重试。",
          "service-not-allowed": "这个环境的语音识别服务被禁用了（Android 的 WebView 里 Chromium 不提供它）。",
          "no-speech": "没听到声音 —— 靠近一点、再说一次。",
          network: "语音识别需要联网，当前网络不可用。",
          aborted: "",
        };
        done({ ok: false, canceled: code === "aborted", reason: reasons[code] !== undefined ? reasons[code] : ("语音识别出错：" + code) });
      };
      recognition.onend = () => {
        done(finalText ? { ok: true, text: finalText.trim() } : { ok: false, reason: "没有听到内容。" });
      };
      try {
        recognition.start();
      } catch (error) {
        done({ ok: false, reason: "麦克风打不开：" + (error && error.message ? error.message : String(error)) });
      }
      if (typeof opts.onStart === "function") {
        opts.onStart(() => { try { recognition.abort(); } catch (_) { /* 已经结束 */ } });
      }
    });
  }

  /** 把录音（Blob）转成文字。endpoint/Key 由调用方从设置里取 —— 这一块**没变**。 */
  async function transcribeBlob(blob, options) {
    const opts = options || {};
    if (!blob) return { ok: false, reason: "没有录到音频。" };
    if (!opts.endpoint || !opts.apiKey) {
      return { ok: false, reason: "要用云端转写需要先配好服务商与 API Key（设置 → 模型）。" };
    }
    const base = String(opts.endpoint).replace(/\/+$/, "");
    const url = /\/audio\/transcriptions$/.test(base) ? base : base + "/audio/transcriptions";
    const form = new global.FormData();
    const filename = blob.type && blob.type.indexOf("webm") >= 0 ? "speech.webm" : "speech.m4a";
    form.append("file", blob, filename);
    form.append("model", opts.model || "whisper-1");
    if (opts.lang) form.append("language", String(opts.lang).split("-")[0]);
    try {
      const response = await global.fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + opts.apiKey },
        body: form,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { ok: false, reason: "转写失败：HTTP " + response.status + (text ? "（" + text.slice(0, 120) + "）" : "") };
      }
      const data = await response.json();
      const text = String((data && (data.text || data.transcription)) || "").trim();
      if (!text) return { ok: false, reason: "转写回来是空的 —— 可能没录到声音。" };
      return { ok: true, text: text };
    } catch (error) {
      return { ok: false, reason: "转写请求发不出去：" + (error && error.message ? error.message : String(error)) };
    }
  }

  /** 开一段录音。返回 { stop(), cancel(), done } —— done 是 Promise<Blob>。 */
  async function startRecording() {
    if (!hasMediaRecorder()) throw new Error("这个环境拿不到麦克风录音能力。");
    const stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new global.MediaRecorder(stream);
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    const done = new Promise((resolve) => {
      recorder.onstop = () => {
        try { stream.getTracks().forEach((track) => track.stop()); } catch (_) { /* 已经停了 */ }
        resolve(new global.Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
    });
    recorder.start();
    return {
      done,
      stop() { try { recorder.stop(); } catch (_) { /* 已经停了 */ } },
      cancel() {
        try { recorder.stop(); } catch (_) { /* 已经停了 */ }
        try { stream.getTracks().forEach((track) => track.stop()); } catch (_) { /* 已经停了 */ }
      },
    };
  }

  const Voice = {
    /* 文本 */
    speakableText,
    splitForSpeech,
    dialogueSegments,
    stripStageDirections,
    stripNarration,
    extractVoiceMessage,
    stripPartialVoiceMarker,
    voiceMessageText,
    splitReplyParts,
    MAX_REPLY_PARTS,
    VOICE_MESSAGE_MAX_CHARS,
    VOICE_MARKER_RE,
    /* 分条消息的生命周期状态（交付类型一旦确定就不许再变） */
    PART_STATUS,
    isPendingVoice,
    isFailedVoice,
    deliveryOf,
    /* 音色（用稳定角色标识） */
    defaultSpeakerFor,
    normalizeVoiceEntry,
    voiceSettingFor,
    migrateVoiceSettings,
    clampSpeechRate,
    SPEECH_RATE_RANGE,
    /* 播放与调度 */
    createPlayer,
    createController,
    /* 语音输入（未改动） */
    hasSpeechRecognition,
    hasMediaRecorder,
    listen,
    transcribeBlob,
    startRecording,
    _hash: hash,
  };

  global.RoleWorldVoice = Voice;
  if (typeof module !== "undefined" && module.exports) module.exports = Voice;
})(typeof globalThis !== "undefined" ? globalThis : this);
