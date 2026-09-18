"use strict";

(function () {
  const BOOK_SYMBOLS = ["✦", "◒", "◇", "❖"];
  const BOOK_ZH = {
    "role lock": "角色锁定书",
    "scene memories": "场景记忆",
    "fact clips": "精确事实",
    "relationship tracker": "关系记录",
  };
  const REQUIRED_BOOKS = [
    "MB Harry — fact clips (EN)",
    "MB Harry — relationship tracker (EN)",
    "MB Harry — role lock (EN)",
    "MB Harry — scene memories (EN)",
  ];
  // Task-34B：内置角色固定 avatar 文件名 + 选择器/注册表排序。
  // 判定只依据固定 avatar 文件名，绝不依赖列表顺序或名称模糊匹配。
  const HARRY_AVATAR = "Harry Potter (EN).png";
  const TOM_RIDDLE_AVATAR = "Tom Riddle (Adult).png";
  const RON_WEASLEY_AVATAR = "Ron Weasley (Triwizard Year).png";
  const HERMIONE_GRANGER_AVATAR = "Hermione Granger (Triwizard Year).png";
  const GINNY_WEASLEY_AVATAR = "Ginny Weasley (Triwizard Year).png";
  const LUNA_LOVEGOOD_AVATAR = "Luna Lovegood (Triwizard Year).png";
  const BUILTIN_AVATAR_ORDER = [
    HARRY_AVATAR,
    TOM_RIDDLE_AVATAR,
    RON_WEASLEY_AVATAR,
    HERMIONE_GRANGER_AVATAR,
    GINNY_WEASLEY_AVATAR,
    LUNA_LOVEGOOD_AVATAR,
  ];

  function builtinAvatarRank(avatar) {
    const idx = BUILTIN_AVATAR_ORDER.indexOf(String(avatar || ""));
    return idx >= 0 ? idx : BUILTIN_AVATAR_ORDER.length;
  }

  function isBuiltinAvatar(avatar) {
    return BUILTIN_AVATAR_ORDER.includes(String(avatar || ""));
  }

  function sortCharacterEntries(cardList) {
    return cardList.slice().sort((a, b) => {
      const ra = builtinAvatarRank(a && a.avatar);
      const rb = builtinAvatarRank(b && b.avatar);
      if (ra !== rb) return ra - rb;
      return String((a && a.avatar) || "").localeCompare(String((b && b.avatar) || ""));
    });
  }

  function findHarry(cardList) {
    return cardList.find((card) => card && card.avatar === HARRY_AVATAR) || null;
  }
  let live = false;
  let authRedirecting = false;
  const rawBooks = [];
  // Task-29F：账户全部记忆书（已映射）；记忆面板按当前角色过滤后展示。
  let allBooks = [];

  /**
   * 当前角色的伴侣档案（同步缓存）。
   *
   * ⚠ **必须声明在这里**（文件顶部），不能放到下面"伴侣"那一段里：
   *   `voiceEligibilityFor` / `isPlainChatActive` 启动时就会被调到，而它们是**同步**读这份缓存的。
   *   声明在后面 = 撞上 let/const 的暂时性死区，启动当场抛
   *   `Cannot access 'companionCache' before initialization`，整个 integration.js 停摆、
   *   界面什么都不出来（2026-09-16 实测踩到）。档案本身是异步读的，见 primeCompanionCache()。
   */
  let companionCache = { avatar: "", profile: null };

  const liveState = {
    card: null,
    charName: "Harry Potter",
    avatar: null,
    characters: [],
    harryAvatar: null,
    defaultCharacter: null,
    cardCache: null,
    pickerOpen: false,
    chatFile: null,
    chatLines: [],
    chatMessages: [],
    activeSession: null,
    chatModel: null,
    userHandle: "unknown",
    userName: "用户",
    memoryBooks: [],
    settings: {},
    templateReady: false,
    templateBusy: false,
    templateError: false,
    isAdmin: false,
    pending: false,
    switching: false,
    controller: null,
    generationPhase: "idle",
    switchController: null,
    switchSequence: 0,
    cancelRequested: false,
    memoryMutation: null,
    archiveSearch: "",
    pendingText: "",
    // 「这一轮让角色发语音」：输入框那个开关的状态（2026-09-14 用户要求调试阶段能自己选）。
    // 持久三档（auto/voice/text）；空串=还没读过设置，交给 voiceReplyMode() 从快照里取。
    voiceReplyMode: "",
    // 一次性的"这一轮发语音"（只由"开启并让下一条发语音"设置，用完即清）。
    replyVoiceOnce: false,
    // 刚到的这一轮（要一条一条送出）：只有它做逐条延时出现，翻历史/刷新时全部直接显示。
    animateTurnId: "",
    // 「连发」掐掉的那一轮：不落盘（那两句马上并成一条重新问）。
    coalesceAbort: false,
    // 本轮标识与「上一次保存结果不确定」的标记（重发同一句要靠它们认出重复）。
    pendingTurnId: "",
    uncertainSave: null,
    // 「本次请求」：上一次真实发出的 payload + 它的分段说明（只读展示用）。
    lastPayload: null,
    lastRequest: null,
    // 记忆面板：当前角色的自动记忆书（书名 / 条目 / 原始 entries）。
    memoryBook: "",
    memoryRows: [],
    memoryEntries: {},
    memoryPanelOpen: false,
    // 角色面板停在哪个分页（设定 / 记忆 / 关系）。记住它，关掉再点角色名回到原来那页。
    characterTab: "setup",
    // 重新回答（regenerate）时的目标位置：非整数 = 不是重新回答。
    regenerateIndex: null,
    regenerateSaved: null,
    // 伴侣模式：正在编辑关系档案的那个角色（保存时用它，避免中途切角色写错人）。
    companionEntry: null,
    // 设置页刚改、还没落盘完成的值：整量重读时不能被旧值盖回去。
    pendingSettingsPatch: null,
    // Task-29A：AI 创建角色状态
    aiDialogOpen: false,
    aiPhase: "description",
    aiDescription: "",
    aiDraft: null,
    aiBusy: false,
    draftFlow: null,
    // AI 创建角色：扩写出来的角色提示词，以及这次会话已经用掉的模型调用次数。
    // 写卡本身由 draftFlow 限制（最多 2 次），这里是**包括扩写在内**的总预算，
    // 免得"扩写失败→重试→写卡→修复"一路点下去把额度烧光。
    aiBrief: "",
    aiCalls: 0,
    // 2026-09-10：模型配置统一由「设置 → 模型」决定（provider / endpoint / model / thinking）
    modelMode: "local",
    modelName: "",
    localSettings: null,
    // 本对话的 token 用量与费用估算（按会话存本机）
    cost: null,
    lastUsage: null,
    autoMemory: true,
    // 思考模式默认关闭：开着的时候接口会先回一段思维链，正文到了再把它顶掉，
    // 看起来像"闪一下"。关掉之后思维链直接不请求也不显示。
    thinking: false,
    streamChunks: 0,
    // 2026-09-14（修"语音前闪一下文字"）：这一轮**到底按什么交付**在流式开始前就定下来。
    //   suppressStream —— 这一轮不在流式里显示正文（软件聊天模式；类型未定之前只显示输入状态）；
    //   voiceIntent    —— 这一轮是奔着语音去的（全语音档 / 用户点名要语音）。
    // 这两个值只在 sendLive 的同一轮里读写，切会话/取消都会连同 generationSeq 一起作废。
    suppressStream: false,
    voiceIntent: false,
    // 异步任务的**有效期计数器**：切会话、取消、重新回答、重新渲染都会 +1。
    // 语音合成是"存完盘再后台跑"的（要好几秒），期间用户完全可能切走 ——
    // 那些晚回来的任务一律拿开始时的号码比对，号码变了就不许再碰界面
    // （数据仍按 turnId 写回**那条**消息，绝不会写错人或把删掉的消息插回来）。
    generationSeq: 0,
    // 逐条送达的定时器：切会话/取消时必须清掉，否则旧的一轮会继续往外蹦消息。
    revealTimers: [],
  };

  function isAuthRequired(err) {
    return !!(window.STApi && window.STApi.isAuthRequired && window.STApi.isAuthRequired(err));
  }

  async function updateAdminEntry() {
    // 本地版没有管理员入口了，但身份必须照常取 —— 这个函数同时还负责把
    // userHandle 交给上层（存储键、界面偏好都靠它）。所以不能因为入口不存在就提前返回。
    if (!window.STApi.getCurrentUser) return null;
    let user = null;
    try { user = await window.STApi.getCurrentUser(); } catch (err) {
      if (isAuthRequired(err)) throw err;
    }
    liveState.userHandle = String((user && (user.handle || user.user_handle || user.name)) || "unknown");
    const isAdmin = !!(user && user.admin === true);
    liveState.isAdmin = isAdmin;
    const link = document.querySelector("#adminAssistantLink");
    if (link) link.hidden = !isAdmin;
    if (window.TASK25C_UI) {
      // 本地版没有管理员入口；身份（称呼、档案标识）照常交给上层。
      if (window.TASK25C_UI.setUserContext) window.TASK25C_UI.setUserContext(user);
      else if (window.TASK25C_UI.setUserIdentity) window.TASK25C_UI.setUserIdentity(user);
    }
    return user;
  }

  function showAuthGate() {
    live = true;
    window.TASK21_LIVE = true;
    liveState.templateReady = false;
    liveState.templateBusy = false;
    liveState.templateError = false;
    window.TASK25C_UI?.clearThemeAccountHint?.();
    document.documentElement.classList.remove("theme-pending");
    setChatTemplateGate("ready");
    const gate = document.querySelector("#authGate");
    if (gate) gate.hidden = false;
    disableComposer("登录后即可开始对话。");
    disableComposer("出现了一个需要重新加载的问题，请刷新页面。");
  }

  function showPageError(title, message) {
    document.documentElement.classList.remove("theme-pending");
    const gate = document.querySelector("#authGate");
    if (!gate) return;
    const heading = gate.querySelector("h2");
    const copy = gate.querySelector("p");
    if (heading) heading.textContent = title || "页面暂时无法加载";
    if (copy) copy.textContent = message || "请稍后重试。";
    gate.hidden = false;
  }

  function setChatTemplateGate(mode, message) {
    const gate = document.querySelector("#chatTemplateGate");
    const title = document.querySelector("#chatTemplateGateTitle");
    const copy = document.querySelector("#chatTemplateGateMessage");
    const retry = document.querySelector("#chatTemplateGateRetry");
    if (!gate) return;

    const loading = mode === "loading";
    const failed = mode === "error";
    gate.hidden = mode === "ready";
    document.documentElement.classList.remove("theme-pending");
    if (title) title.textContent = failed ? "对话准备失败" : "正在准备对话";
    if (copy) copy.textContent = message || (failed
      ? "暂时无法准备当前账户的对话。请重试，现有账户数据不会被覆盖。"
      : "正在为当前账户准备 Harry 对话…");
    if (retry) {
      retry.hidden = !failed;
      retry.disabled = loading || liveState.templateBusy;
    }
  }

  function showTemplateInitError(error) {
    liveState.templateReady = false;
    liveState.templateError = true;
    if (isAuthRequired(error)) {
      showAuthGate();
      return;
    }
    const message = error && error.code === "CHAT_TEMPLATE_CONFLICT"
      ? "当前账户已有同名文件，系统未覆盖任何数据。请处理后重试。"
      : "暂时无法准备当前账户的对话。请重试，现有账户数据不会被覆盖。";
    setChatTemplateGate("error", message);
    updateComposerLive();
  }

  async function ensureChatTemplate() {
    liveState.templateBusy = true;
    liveState.templateError = false;
    setChatTemplateGate("loading");
    updateComposerLive();
    try {
      if (liveState.isAdmin) {
        liveState.templateReady = true;
        return true;
      }
      // Task-33C fix: always initialize (idempotent). The backend only seeds
      // MISSING template files and never overwrites existing user files, so
      // this seeds newly-added builtin assets (the Tom Riddle (Adult) card)
      // into accounts that were already "ready" before the Tom asset shipped,
      // without touching Harry or any existing user data. Previously initialize
      // was skipped whenever status.ready was already true, which left all
      // pre-existing accounts without the Tom builtin card.
      await window.STApi.initializeChatTemplate();
      const verified = await window.STApi.getChatTemplateStatus();
      // 本地版没有"账户模板"概念：只要数据库就绪即可。记忆书数量取决于用户装了哪些内容包，
      // 不能拿固定的 4 本当门槛，否则空库用户会被永远挡在门外。
      const localMode = !!(window.STApi && window.STApi.isLocal === true);
      const ok = !!verified && verified.ready === true && verified.modelConnectionReady === true
        && (localMode || (verified.memoryBookCount >= 4 && verified.initialChatReady === true));
      if (!ok) {
        const error = new Error("chat template verification failed");
        error.code = "CHAT_TEMPLATE_VERIFY_FAILED";
        throw error;
      }
      liveState.templateReady = true;
      return true;
    } catch (error) {
      liveState.templateReady = false;
      liveState.templateError = true;
      throw error;
    } finally {
      liveState.templateBusy = false;
      updateComposerLive();
    }
  }

  async function retryChatTemplate() {
    if (liveState.templateBusy || liveState.isAdmin) return;
    try {
      await ensureChatTemplate();
      liveState.settings = parseSettings(await window.STApi.getSettings());
      await loadCharacterAndChat();
      await loadBooks();
      liveState.templateError = false;
      setChatTemplateGate("ready");
      document.documentElement.classList.remove("theme-pending");
      updateComposerLive();
      showToast("已准备好。");
    } catch (error) {
      showTemplateInitError(error);
    }
  }

  function setMemoryMutationBusy(busy, label) {
    if (window.TASK25C_UI?.setMemoryBusy) window.TASK25C_UI.setMemoryBusy(!!busy, label || "处理中…");
  }

  async function withMemoryMutation(label, task) {
    if (liveState.memoryMutation) {
      showToast("已有记忆操作正在进行，请稍候。");
      return null;
    }
    const token = { label };
    liveState.memoryMutation = token;
    setMemoryMutationBusy(true, label);
    try {
      return await task();
    } finally {
      if (liveState.memoryMutation === token) liveState.memoryMutation = null;
      setMemoryMutationBusy(false);
    }
  }

  function parseSettings(value) {
    if (!value) return {};
    try {
      const raw = typeof value === "string" ? value : (value.settings ?? value);
      if (raw && typeof raw === "object") return raw;
      return typeof raw === "string" ? (JSON.parse(raw) || {}) : {};
    } catch (_) {
      return {};
    }
  }

  function mapEntry(bookIdx, entry) {
    return {
      id: `live-${bookIdx}-${entry.uid}`,
      // 标题口径见 memory-core.entryTitle：comment 里若是迁移工具留下的说明（[STMB] …），
      // 不能当标题显示 —— 内置包里那条 "Human confirmation edit: …" 就这么冒到过界面上。
      title: (window.ROLEWORLD_MEMORY_CORE && window.ROLEWORLD_MEMORY_CORE.entryTitle)
        ? window.ROLEWORLD_MEMORY_CORE.entryTitle(entry)
        : String(entry.comment || (entry.key || []).join("、") || `条目 #${entry.uid}`).replace(/^\[STMB\]\s*/, ""),
      content: String(entry.content || ""),
      source: "角色记忆",
      superseded: !!entry.disable,
      __uid: entry.uid,
    };
  }

  function mapBook(name, entriesObject, index) {
    const entries = Object.keys(entriesObject || {})
      .map((key) => Object.assign({}, entriesObject[key], { uid: entriesObject[key].uid ?? key }))
      .sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
    rawBooks[index] = { name, entries };
    const keyPart = name.replace(/^MB\s+.+?\s+—\s+/, "").replace(/\s*\(EN\)\s*$/, "").trim();
    const visibleEntries = entries.filter((entry) => !entry.disable);
    return {
      id: name,
      symbol: BOOK_SYMBOLS[index % BOOK_SYMBOLS.length],
      name: BOOK_ZH[keyPart] || keyPart,
      subtitle: `${visibleEntries.length} 条目`,
      open: index < 2,
      __name: name,
      __rawEntries: entries,
      entries: visibleEntries.map((entry) => mapEntry(index, entry)),
    };
  }

  async function loadBooks() {
    const worlds = await window.STApi.listWorlds();
    const names = worlds.filter((world) => typeof world.name === "string" && world.name.startsWith("MB ")).map((world) => world.name);
    // 本地版允许一本记忆书都没有（用户没装内置包）。只有连着一台真正的 SillyTavern
    // 后端时才要求那套固定模板书，避免把空库用户挡在门外。
    if (!(window.STApi && window.STApi.isLocal === true) && !REQUIRED_BOOKS.every((name) => names.includes(name))) {
      const error = new Error("required memory books unavailable");
      error.code = "CHAT_TEMPLATE_BOOKS_MISSING";
      throw error;
    }
    const previousOpen = new Map(memoryBooks.map((book) => [book.__name || book.id, book.open]));
    const mapped = [];
    rawBooks.length = 0;
    for (let index = 0; index < names.length; index += 1) {
      const data = await window.STApi.getWorld(names[index]);
      mapped.push(mapBook(names[index], data && data.entries, index));
    }
    liveState.memoryBooks = rawBooks.filter(Boolean);
    allBooks = mapped;
    mapped.forEach((book) => { if (typeof previousOpen.get(book.__name) === "boolean") book.open = previousOpen.get(book.__name); });
    applyMemoryPanelFilter();
  }

  // 记忆面板跟随当前角色：每个角色显示自己的记忆书（按书名的角色短名归属）。
  function applyMemoryPanelFilter() {
    const entry = activeCharacterEntry();
    const visible = window.TASK29_CHARACTER_CORE && typeof window.TASK29_CHARACTER_CORE.memoryBooksFor === "function"
      ? window.TASK29_CHARACTER_CORE.memoryBooksFor(entry, allBooks)
      : allBooks;
    const previousOpen = new Map(memoryBooks.map((book) => [book.__name || book.id, book.open]));
    visible.forEach((book) => { if (typeof previousOpen.get(book.__name) === "boolean") book.open = previousOpen.get(book.__name); });
    memoryBooks.length = 0;
    memoryBooks.push(...visible);
    // 把**真实**记忆书交给右侧「记忆」栏的渲染器（它以前读的是 app.js 里那份写死的示例数据）。
    if (typeof renderMemoryBooks === "function") renderMemoryBooks(visible);

    const total = visible.reduce((count, book) => count + book.entries.length, 0);
    const entryCount = document.querySelector("#memoryEntryCount");
    const bookCount = document.querySelector("#memoryBookCount");
    if (entryCount) entryCount.textContent = String(total);
    if (bookCount) bookCount.textContent = String(visible.length).padStart(2, "0");
    const countBadge = document.querySelector(".book-count");
    if (countBadge) countBadge.textContent = `${String(visible.length).padStart(2, "0")} 本`;
    const navCount = document.querySelector('[data-view="memories"] .nav-count');
    if (navCount) navCount.textContent = String(visible.length).padStart(2, "0");
  }

  // Task-29F：顶部标题与侧栏品牌名跟随当前角色，不再固定显示 Harry Potter。
  function renderActiveCharacterIdentity() {
    const entry = activeCharacterEntry();
    const full = entry && (entry.charName || entry.avatar) ? (entry.charName || entry.avatar) : "Harry Potter";
    const title = document.querySelector("#topbarTitle");
    if (title) title.textContent = full;
    // 顶栏那个"角色名按钮"上的小头像（点它开角色面板）。取不到图就留空白圆圈，不编图。
    const avatar = document.querySelector("#topbarCharacterAvatar");
    if (avatar) {
      const file = (entry && entry.avatar) || "";
      let url = "";
      if (file && window.STApi && typeof window.STApi.assetUrlSync === "function") {
        try { url = window.STApi.assetUrlSync(file) || ""; } catch (_) { url = ""; }
      }
      if (url) { avatar.style.backgroundImage = `url("${String(url).replace(/"/g, "%22")}")`; }
      else { avatar.style.backgroundImage = ""; }
      avatar.hidden = !url;
    }
    const button = document.querySelector("#topbarCharacterButton");
    if (button) button.setAttribute("aria-label", `${full}：设定、记忆与关系`);
    renderTopbarMode();
    const brand = document.querySelector("#sidebarBrandName");
    if (brand) brand.textContent = "角色世界";
    // 语言是"每个角色一个"的：换了角色，顶栏那个下拉也要跟着换（同一个函数，别处不用再管）。
    syncChatLanguageControl();
  }

  function setChatListStatus(message, canRetry = false) {
    const box = $("#chatListStatus");
    const text = $("#chatListStatusText");
    const retry = $("#chatListRetry");
    if (!box || !text || !retry) return;
    text.textContent = message || "";
    box.hidden = !message;
    retry.hidden = !canRetry;
    retry.disabled = liveState.pending || liveState.switching;
  }

  function sessionTime(session) {
    return session.serverSaved ? liveState.chatModel.formatTime(session.updatedAt) : "未保存";
  }

  function sessionDay(session) {
    return session.serverSaved ? liveState.chatModel.dayLabel(session.updatedAt) : "当前";
  }

  function archiveSortTime(session) {
    const value = session.archivedAt || session.updatedAt;
    const time = Date.parse(String(value || ""));
    return Number.isFinite(time) ? time : 0;
  }

  const expandedCharacters = new Set();
  let sidebarActiveSession = "";
  function newCharacterConversation(entry) {
    if (liveState.pending || liveState.switching || !liveState.chatModel) return;
    const current = liveState.chatModel.getActive();
    const sameBlank = current && isUnboundBlank(current) &&
      (current.pendingAvatar || liveState.defaultCharacter?.avatar) === entry.avatar;
    if (!sameBlank) liveState.chatModel.newSession({ force: true });
    syncActiveSession();
    setChatListStatus("");
    selectCharacterForActive(entry.avatar);
    expandedCharacters.add(entry.avatar);
    renderChatList();
    document.querySelector('.nav-item[data-view="chat"]')?.click();
  }

  function renderChatList() {
    const container = $("#historyGroups");
    if (!container) return;
    container.textContent = "";
    const sessions = liveState.chatModel ? liveState.chatModel.getSessions().filter((session) => !session.archived) : [];
    const currentAvatar = activeCharacterEntry().avatar || "";
    const currentId = `${liveState.activeSession?.id || ""}:${currentAvatar}`;
    if (sidebarActiveSession !== currentId) {
      expandedCharacters.add(currentAvatar);
      sidebarActiveSession = currentId;
    }
    const characters = new Map(liveState.characters.map(entry => [entry.avatar, entry]));
    const groups = new Map([...characters.keys()].map(avatar => [avatar, []]));
    const orphans = new Set();
    for (const session of sessions) {
      const avatar = session.avatar || session.pendingAvatar || liveState.defaultCharacter?.avatar || "";
      if (!groups.has(avatar)) {
        groups.set(avatar, []);
        characters.set(avatar, { avatar, charName: session.charName || session.pendingCharName || "未关联角色" });
        orphans.add(avatar);
      }
      groups.get(avatar).push(session);
    }

    // 侧栏显示哪些角色，完全由用户决定（设置 → 角色管理里的「显示在侧栏」）：
    //   chosen === null → 从未设置，一个都不擅自显示，引导用户去挑；
    //   chosen 是数组   → 就按这个顺序显示（空数组 = 用户主动全部隐藏）。
    // 顺序始终跟随 chosen，绝不因为最近使用 / 刷新 / 切换对话而重排。
    // 当前正在聊的角色临时出现在侧栏，但**不写进偏好** —— 从角色库点进一个没加入侧栏的
    // 角色也能正常聊天，而且不会偷偷把它加进侧栏。
    const chosen = state && state.preferences ? state.preferences.sidebarCharacters : null;
    const ordered = [];
    const seen = new Set();
    const pushAvatar = (avatar) => {
      if (!avatar || seen.has(avatar) || !groups.has(avatar)) return;
      seen.add(avatar);
      ordered.push(avatar);
    };
    if (Array.isArray(chosen)) chosen.forEach(pushAvatar);
    pushAvatar(currentAvatar);
    orphans.forEach(pushAvatar);

    for (const avatar of ordered) {
      const items = groups.get(avatar);
      const entry = characters.get(avatar);
      const group = document.createElement("section");
      group.className = "character-history-group";
      const heading = document.createElement("div");
      heading.className = "character-history-heading";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `character-history-toggle${avatar === currentAvatar ? " is-current" : ""}`;
      const expanded = expandedCharacters.has(avatar);
      toggle.setAttribute("aria-expanded", String(expanded));
      const caret = document.createElement("span");
      caret.className = "character-history-caret";
      caret.textContent = expanded ? "⌄" : "›";
      caret.setAttribute("aria-hidden", "true");
      const badge = document.createElement("span");
      badge.className = "character-history-avatar";
      badge.textContent = [...(entry.charName || "?")][0];
      badge.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "character-history-name";
      name.textContent = entry.charName || avatar;
      const count = document.createElement("span");
      count.className = "character-history-count";
      count.textContent = String(items.length);
      toggle.append(caret, badge, name, count);
      const children = document.createElement("div");
      children.className = "character-history-chats";
      children.id = `character-chats-${container.childElementCount}`;
      children.hidden = !expanded;
      toggle.setAttribute("aria-controls", children.id);
      toggle.addEventListener("click", () => {
        const opened = !expandedCharacters.has(avatar);
        if (opened) expandedCharacters.add(avatar); else expandedCharacters.delete(avatar);
        children.hidden = !opened;
        toggle.setAttribute("aria-expanded", String(opened));
        caret.textContent = opened ? "⌄" : "›";
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "character-history-add";
      add.textContent = "＋";
      add.title = `与 ${entry.charName || avatar} 开始新对话`;
      add.setAttribute("aria-label", add.title);
      add.disabled = liveState.pending || liveState.switching || !liveState.characters.some(candidate => candidate.avatar === avatar);
      add.dataset.unavailable = String(!liveState.characters.some(candidate => candidate.avatar === avatar));
      add.addEventListener("click", () => newCharacterConversation(entry));
      heading.append(toggle, add);
      group.append(heading, children);
      for (const session of items) {
        const shell = document.createElement("div");
        shell.className = "history-row-shell";
        const button = document.createElement("button");
        button.type = "button";
        button.className = `history-row${session.id === (liveState.activeSession && liveState.activeSession.id) ? " is-selected" : ""}`;
        button.dataset.action = "select-chat";
        button.dataset.chatId = session.id;
        button.disabled = liveState.pending;
        button.setAttribute("aria-current", session.id === (liveState.activeSession && liveState.activeSession.id) ? "page" : "false");
        button.title = session.title || "新对话";

        const icon = document.createElement("span");
        icon.className = "history-row-icon";
        icon.setAttribute("aria-hidden", "true");
        const copy = document.createElement("span");
        copy.className = "history-row-copy";
        const title = document.createElement("span");
        title.className = "history-row-title";
        title.textContent = session.title || "新对话";
        const time = document.createElement("span");
        time.className = `history-row-time${session.serverSaved ? "" : " is-unsaved"}`;
        time.textContent = sessionTime(session);
        copy.append(title, time);
        button.append(icon, copy);
        const action = document.createElement("button");
        action.type = "button";
        action.className = "history-row-action";
        action.dataset.action = "archive-chat";
        action.dataset.chatId = session.id;
        action.textContent = "归档";
        action.title = "归档这段对话";
        action.setAttribute("aria-label", `${action.textContent}：${session.title || "新对话"}`);
        action.dataset.empty = String(!session.serverSaved && (!session.messages || session.messages.length === 0));
        action.disabled = liveState.pending || liveState.switching || action.dataset.empty === "true";
        shell.append(button, action);
        children.appendChild(shell);
      }
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "character-history-empty";
        empty.textContent = "点击 ＋ 开始第一段对话";
        children.append(empty);
      }
      container.appendChild(group);
    }
    if (!ordered.length) {
      const block = document.createElement("div");
      block.className = "history-empty-block";
      const empty = document.createElement("p");
      empty.className = "history-empty";
      // 两种"空"要分开说：从没设置过 / 用户自己全部隐藏了。
      empty.textContent = Array.isArray(chosen)
        ? "侧栏里还没有角色。你的角色、对话和记忆都还在，挑几个放进来就行。"
        : "还没有选择要显示在侧栏的角色。";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "history-empty-action";
      pick.textContent = "选择角色";
      pick.addEventListener("click", () => {
        if (!window.TASK25C_UI) return;
        if (typeof window.TASK25C_UI.setSettingsSection === "function") window.TASK25C_UI.setSettingsSection("characters");
        if (typeof window.TASK25C_UI.openSettings === "function") window.TASK25C_UI.openSettings();
      });
      block.append(empty, pick);
      container.appendChild(block);
    }
  }

  function renderArchivedChatSettings() {
    const container = $("#archivedChatList");
    const empty = $("#archivedChatEmpty");
    const count = $("#archivedChatCount");
    if (!container) return;
    container.textContent = "";
    const allArchived = liveState.chatModel ? liveState.chatModel.getSessions().filter((session) => session.archived) : [];
    allArchived.sort((a, b) => archiveSortTime(b) - archiveSortTime(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    if (count) count.textContent = `${allArchived.length} 个`;
    const query = liveState.archiveSearch.trim().toLocaleLowerCase();
    const sessions = query
      ? allArchived.filter((session) => `${session.title || ""} ${session.fileName || ""}`.toLocaleLowerCase().includes(query))
      : allArchived;
    if (empty) {
      empty.hidden = sessions.length > 0;
      empty.textContent = allArchived.length && !sessions.length ? "没有匹配的归档对话" : "暂无归档对话";
    }
    for (const session of sessions) {
      const row = document.createElement("div");
      row.className = "settings-row settings-action-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = session.title || "新对话";
      const time = document.createElement("span");
      time.textContent = `${liveState.chatModel.formatTime(session.archivedAt || session.updatedAt)} · 已归档`;
      copy.append(title, time);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "plain-button";
      restore.dataset.action = "restore-chat";
      restore.dataset.chatId = session.id;
      restore.textContent = "恢复";
      restore.disabled = liveState.pending || liveState.switching;
      // Task-30E：归档对话「永久删除」——不可恢复；二次确认后删除服务端 .jsonl 与本地会话。
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "plain-button danger-button";
      remove.dataset.action = "delete-chat";
      remove.dataset.chatId = session.id;
      remove.textContent = "永久删除";
      remove.disabled = liveState.pending || liveState.switching;
      row.append(copy, restore, remove);
      container.appendChild(row);
    }
  }

  function setArchivedChatSearch(value) {
    liveState.archiveSearch = String(value || "");
    renderArchivedChatSettings();
  }

  /* P2-3：这一轮如果引用了以前的记录，在回复下面标出来，并可点回去看原话。
   * 判定很保守（见 search-core.findReferencedHits）：必须有一段逐字相同的原话才算，
   * 找不到就不显示 —— 宁可少标，也不让"它大概是在说这条"这种猜测出现在界面上。 */
  function buildRefList(refs) {
    const box = document.createElement("div");
    box.className = "message-refs";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "message-refs-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = `▸ 引用了 ${refs.length} 条以前的记录`;
    const list = document.createElement("div");
    list.className = "message-refs-list";
    list.hidden = true;
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = `${open ? "▾" : "▸"} 引用了 ${refs.length} 条以前的记录`;
    });
    for (const ref of refs) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "message-refs-item";
      const when = ref.at ? String(ref.at).slice(0, 16).replace("T", " ") : "时间未记录";
      item.textContent = `[${ref.isUser ? "你" : (ref.name || "角色")} · ${when}] ${ref.text}`;
      item.title = "点开那段对话并跳到这句原话";
      item.addEventListener("click", (event) => {
        event.preventDefault();
        jumpToMemorySource({
          content: ref.text,
          source: { file: ref.fileName, messageIndex: ref.index },
        }).catch(() => {});
      });
      list.appendChild(item);
    }
    box.append(toggle, list);
    return box;
  }

  /* 撞上输出上限（finish_reason=length）时，在那一轮下面标一行，并给一个「接着说」。
   * 以前完全不看 finish_reason：用户只看到一句半截的话，不知道是模型写崩了还是被砍了。
   * 「接着说」发出去的是一句**看得见**的舞台提示（不是偷偷替用户说话）。 */
  const CONTINUE_CUE = "（接着你刚才没说完的那句继续说，不要重复已经说过的内容。）";

  function buildTruncationNotice() {
    const box = document.createElement("div");
    box.className = "message-truncated";
    const label = document.createElement("span");
    label.textContent = "说到一半被截断了（撞上了输出上限）";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-continue";
    button.textContent = "接着说";
    button.title = "发出：" + CONTINUE_CUE;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const input = $("#messageInput");
      if (!input) return;
      input.value = CONTINUE_CUE;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const send = $("#sendButton");
      if (send && !send.disabled) send.click();
    });
    box.append(label, button);
    return box;
  }

  /**
   * 「这条回复的语言和角色设定对不上」那一行。
   *
   * 为什么要有它：用户 2026-09-14 定的规矩是"语言是角色的交流规则"——
   * 角色设了中文却整段说英文时，**不能假装没看见**（尤其不能拿中文音色去念英文）。
   * 但也**不能删字凑合规**、更不能拿这个去重试烧钱：原文照常显示，
   * 这里只给一句人话 + 两个去处（改角色语言 / 改这一轮的语言设置）。
   */
  const LANGUAGE_LABELS = { zh: "中文", en: "English" };

  function buildLanguageNotice(info) {
    const box = document.createElement("div");
    box.className = "message-language";
    box.dataset.languageMismatch = "1";
    const label = document.createElement("span");
    const saw = info && info.detected && info.detected.lang ? LANGUAGE_LABELS[info.detected.lang] : "另一种语言";
    label.textContent = "这条回复用的是" + saw + "，和这个角色的交流语言（"
      + (LANGUAGE_LABELS[info && info.language] || "未设置") + "）对不上。原文照常保留，也没有拿它去合成语音。";
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "message-language-fix";
    fix.textContent = "改这个角色的语言";
    fix.title = "打开这个角色的关系档案（伴侣设置里有「交流语言」）";
    fix.addEventListener("click", () => {
      openCharacterPanel("relationship").catch(() => {});
    });
    box.append(label, fix);
    return box;
  }

  /* 消息旁的标记控件（记错 / 编造）：**2026-09-18 用户口径「全局取消」**，入口已删除。
   * 台账数据结构、`metrics-core.flagsOf` 与下面的 `flagTurnFromMessage` 都留着不删 ——
   * 那是数据层，动它要牵到存档与既有台账；现在的状态是"界面里没有任何地方能触发它"。
   * 留这段注释是为了让下一个人知道：这里原来有东西，是被产品决定的，不是漏了。 */

  /* ---------- 消息旁的操作（2026-09-13 本轮第 ③ 项） ----------
   * 用户要求：桌面悬停或键盘聚焦、手机点击就能打开消息操作；按消息类型给适用操作
   * （复制 / 编辑 / 重新回答 / 从这里开分支），失败消息旁给重试并保留用户输入；
   * 重新回答要保留旧版本可切换；从旧消息开分支要保留原对话并说清新分支从哪开始。
   * 存储上不新造结构：
   *   - "旧版本"用 SillyTavern 本来就有的 `swipes` + `swipe_id`（`mes` 始终等于当前选中的那一版，
   *     所以下一轮上下文自动用当前版本，导出/导入也原样带着）；
   *   - "分支"就是**另一个对话文件**：原对话一个字都不改。
   */
  const MESSAGE_COPY_DONE = "已复制这条消息";

  async function copyText(text) {
    const value = String(text || "");
    if (!value) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) { /* 下面用兜底 */ }
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "readonly");
      area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (_) { return false; }
  }

  /** 每条消息右下角的操作入口。菜单是行内绝对定位的，不用浮层库。 */
  /**
   * 现在这台设备能不能让角色出声？
   *
   * 判据**不再是** speechSynthesis / 安卓原生桥（那两个这一轮已经砍掉），而是：
   *   打开「角色语音」+ 在用体验卡 + 中转配了火山凭据。
   * 读的是 adapter/voice.js 维护的同步快照（探测是异步的、读是同步的）——
   * 菜单必须在你点开的那一瞬间就能定下来有没有「朗读」。
   */
  function voiceCapability() {
    const Cloud = window.RoleWorldVoiceCloud;
    if (!Cloud || typeof Cloud.capability !== "function") {
      return { canSpeak: false, reason: "语音模块没加载。", speakers: [] };
    }
    try { return Cloud.capability(); } catch (_) {
      return { canSpeak: false, reason: "语音模块出错了。", speakers: [] };
    }
  }

  /**
   * 现在能不能朗读 —— **两条都要满足**：
   *   ① 全局就绪（「角色语音」开着 + 在用体验卡 + 中转配了火山）；
   *   ② **这个角色**有语音资格（不是内置小说人物 + 伴侣开着 + 聊天方式是「软件聊天/无动作」）。
   *
   * 2026-09-14 用户拍板：「其他都不做语音」—— 所以第 ② 条是硬门槛，
   * 判定统一走 companion-core.voiceAccess（界面这里不写第二套规则）。
   */
  function canSpeakNow() {
    if (!voiceCapability().canSpeak) return false;
    return voiceEligibilityFor(activeCharacterEntry()).allowed === true;
  }

  /** 为什么这个角色没有语音（给界面用的一句话；全局没问题、角色不合格时才有内容）。 */
  function voiceBlockedReason() {
    const cap = voiceCapability();
    if (!cap.canSpeak) return cap.reason || "";
    return voiceEligibilityFor(activeCharacterEntry()).reason || "";
  }

  /** 停掉朗读（切角色、切会话、改设置时都要调 —— 否则旧音频会突然响起来）。 */
  function stopVoicePlayback() {
    const Cloud = window.RoleWorldVoiceCloud;
    if (!Cloud) return;
    try { Cloud.stop(); } catch (_) { /* 没在念就算了 */ }
    renderVoiceStatus();
  }

  /** 「正在生成语音…／正在播放…」那一行。状态来自 adapter 的事件，不猜。 */
  function renderVoiceStatus(state) {
    const node = document.querySelector("#voiceStatus");
    if (!node) return;
    const current = state || (window.RoleWorldVoiceCloud ? window.RoleWorldVoiceCloud.state() : null);
    if (!current || current.phase === "idle") {
      node.hidden = true;
      node.textContent = "";
      return;
    }
    node.hidden = false;
    node.textContent = current.phase === "loading"
      ? "正在生成语音" + (current.total > 1 ? `（第 ${current.index + 1}/${current.total} 段）` : "") + "…"
      : "正在播放" + (current.total > 1 ? `（第 ${current.index + 1}/${current.total} 段）` : "") + "…";
  }

  let voiceSpeakRun = 0;

  /**
   * 每条消息的「⋯」菜单。
   *
   * 菜单项是**打开时现算**的，不是渲染时算一次就定死 —— 这一点是用户反馈逼出来的：
   * 真机上原生语音桥是外壳在 Activity 起来之后才挂到页面上的（要重试几秒），
   * 而历史消息在页面加载时就已经渲染完了 —— 那时 canSpeak 还是 false，
   * 于是"点了 ⋯ 只有复制/重新回答/分支、没有朗读"（用户 2026-09-14 实测反馈）。
   * 现算之后，桥一挂上、下次点开菜单就有朗读了。
   */
  function buildMessageActions(message, index, total) {
    const wrap = document.createElement("div");
    wrap.className = "message-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-menu-button";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "这条消息的操作");
    button.title = "这条消息的操作";
    button.textContent = "⋯";
    const menu = document.createElement("div");
    menu.className = "message-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const isUser = !!message.is_user;
    const fill = () => {
      menu.textContent = "";
      const items = [{ action: "copy", label: "复制" }];
      if (isUser) items.push({ action: "edit", label: "编辑" });
      else items.push({ action: "regenerate", label: "重新回答" });
      // 朗读：只在**真的能出声**时才出现。判据是"打开角色语音 + 在用体验卡 + 中转配了火山"，
      // 不再是 speechSynthesis / 安卓原生桥（那两个这一轮砍掉了）。
      // 摆一个点了没反应的菜单项比没有更糟。
      if (!isUser && canSpeakNow()) {
        const Cloud = window.RoleWorldVoiceCloud;
        let speaking = false;
        try { speaking = Cloud.isSpeaking() === true; } catch (_) { speaking = false; }
        items.push({ action: "speak", label: speaking ? "停止朗读" : "朗读" });
      }
      items.push({ action: "branch", label: "从这里开分支" });
      for (const item of items) {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "message-menu-item";
        node.setAttribute("role", "menuitem");
        node.dataset.messageAction = item.action;
        node.dataset.messageIndex = String(index);
        node.textContent = item.label;
        menu.appendChild(node);
      }
    };
    fill();
    // 每次点开都重算一遍（菜单是被 .message-menu-button 的处理器显示的，
    // 这里搭个顺风车：任何一次点击/聚焦都刷新内容）。
    button.addEventListener("click", fill);
    button.addEventListener("focus", fill);
    wrap.append(button, menu);
    return wrap;
  }

  /* 角色音色：每个角色一个**云端音色 id**（由角色卡的 avatar 这个稳定标识决定，
   * 不用名字 —— 改名不该换声音），用户在设置里给某个角色选过就用他选的那份。 */
  async function voiceSettingForAvatar(avatar) {
    const Cloud = window.RoleWorldVoiceCloud;
    const settings = await window.RoleWorld.getLocalSettings().catch(() => ({}));
    return Cloud.settingFor(avatar, settings);
  }

  /** 点「朗读」：正在念就先停（同一个菜单项在两个状态间切换）。 */
  async function speakMessage(index) {
    const Cloud = window.RoleWorldVoiceCloud;
    const Voice = window.RoleWorldVoice;
    if (!Cloud || !Voice) return;
    if (Cloud.isSpeaking()) {
      stopVoicePlayback();
      return;
    }
    const message = messageAt(index);
    if (!message || !message.mes) return;
    const cap = voiceCapability();
    if (!cap.canSpeak) {
      showToast(cap.reason || "这台设备现在用不了角色语音。");
      return;
    }
    // 只念对白时会剥掉旁白；标记（[[表情: …]] 之类）一律不念。
    const text = Voice.speakableText(String(message.mes), {
      skipNarration: liveState.voiceSkipNarration === true,
    });
    if (!text) {
      showToast("这条消息没有可朗读的内容");
      return;
    }
    const avatar = (activeCharacterEntry() || {}).avatar || "";
    const setting = await voiceSettingForAvatar(avatar);
    const run = ++voiceSpeakRun;
    renderVoiceStatus({ phase: "loading", index: 0, total: 0 });
    const result = await Cloud.speak(text, {
      speaker: setting.speaker,
      speechRate: setting.speechRate,
      // 单段别太长：太长则"想停要等"，太短则请求次数多。取中转上限与 220 字的较小值。
      maxChars: Math.min(Number(cap.maxChars) || 220, 220),
    });
    if (run !== voiceSpeakRun) return;      // 期间又点了别的：这一轮的结果不用管
    renderVoiceStatus();
    if (!result.ok && result.reason) showToast(result.reason);
  }

  /* ==================================================================== *
   * 「设置 → 语音」：每个角色一个云端音色
   *
   * 这一轮换成了云端的音色 id（火山「豆包语音合成模型 2.0」），所以这里不再是
   * 语速/音高两个滑杆：
   *   · 「音色」是一个**下拉**，选项来自中转（它才知道自己开放了哪些）；
   *   · 「语速」还是有的 —— 它是官方真实参数 speech_rate（[-50,100]，0 = 正常），
   *     不是旧版本机引擎那个 0.6~1.6 的倍率（旧值会按同一语义换算过来，见迁移说明）；
   *   · **没有音高**：官方那套里能改音高的只有 additions 的 post_process.pitch（半音，[-12,12]），
   *     而且我们没在真接口上验过 —— 拿旧的 0.6~1.5 倍率去冒充它才是不老实，所以不做。
   * ==================================================================== */

  const SPEECH_RATE_MIN = -50;
  const SPEECH_RATE_MAX = 100;

  function formatSpeechRate(value) {
    const number = Number(value) || 0;
    if (number === 0) return "正常";
    return (number > 0 ? "快 " : "慢 ") + Math.abs(number) + "%";
  }

  async function renderVoicePanel() {
    const list = document.querySelector("#voiceVoiceList");
    const empty = document.querySelector("#voiceListEmpty");
    const note = document.querySelector("#voiceEngineNote");
    if (!list) return;
    const Cloud = window.RoleWorldVoiceCloud;
    const cap = voiceCapability();

    // 第一行永远回答"现在到底能不能出声、为什么不能"——真机上没法开控制台，
    // 这一行就是现场答案。
    if (note) {
      if (!cap.canSpeak) {
        note.textContent = cap.reason || "现在用不了角色语音。";
      } else {
        const quota = cap.voiceLeft === null || cap.voiceLeft === undefined
          ? "语音额度不限"
          : ("语音还剩 " + cap.voiceLeft + " 次"
            + (cap.voiceCharsLeft === null || cap.voiceCharsLeft === undefined ? "" : " · " + cap.voiceCharsLeft + " 字"));
        note.textContent = "音色来自云端（火山引擎「豆包语音合成模型 2.0」），经体验卡中转合成。"
          + quota + "。下面列出的都是**能发语音的角色**（你自己创建的角色都可以），每个可以单独挑一个音色。";
      }
    }

    let cards = [];
    try {
      // ⚠ 用 window.RoleWorld 而不是某个局部名：这个文件里**没有** `Adapter` 这个绑定，
      // 写错会抛 "Adapter is not defined"，而外面那层 try/catch 会把它吞成"列表是空的" ——
      // 表现就是"面板渲染成功但一行都没有"（冒烟测试抓到的）。
      const rows = await window.RoleWorld.store.listCharacters();
      cards = (rows || []).map((row) => ({ avatar: String(row.avatar || ""), name: String(row.name || row.avatar || "") }));
    } catch (error) {
      cards = [];
      if (empty) empty.textContent = "读取角色列表失败：" + (error && error.message ? error.message : String(error));
    }
    if (!cards.length) {
      if (empty) empty.hidden = false;
      list.textContent = "";
      return;
    }

    // 只列**能发语音的角色**（2026-09-16 规则：内置小说人物不发语音；自定义角色都可以）。
    // 为什么不是"全列出来但灰掉"：这一页是"给谁挑声音"，摆一串永远发不出声的角色，
    // 用户会以为挑完就能听到 —— 所以直接不列，并在下面写清**为什么一个都没有、去哪儿开**。
    const eligible = [];
    const blocked = [];
    for (const card of cards) {
      const decision = await voiceEligibilityOfCard(card);
      if (decision.allowed) eligible.push(card);
      else blocked.push({ card, reason: decision.reason, code: decision.code });
    }
    if (!eligible.length) {
      if (empty) {
        empty.hidden = false;
        const why = blocked.length && blocked[0].reason ? blocked[0].reason : "";
        empty.textContent = "现在没有可以发语音的角色 —— " + why
          + "（内置的小说人物不做语音；用「AI 创建角色」建一个自己的角色就能发。）";
      }
      list.textContent = "";
      return;
    }
    if (empty) empty.hidden = true;
    cards = eligible;

    const settings = await window.RoleWorld.getLocalSettings();
    const overrides = (settings && settings.voice_by_card) || {};
    const speakers = Array.isArray(cap.speakers) ? cap.speakers : [];

    list.textContent = "";
    for (const card of cards) {
      const row = document.createElement("div");
      row.className = "character-manage-row";
      row.dataset.voiceCard = card.avatar;

      const setting = Cloud ? Cloud.settingFor(card.avatar, settings) : { speaker: "", speechRate: 0 };
      const who = document.createElement("div");
      who.className = "character-manage-name";
      const strong = document.createElement("strong");
      strong.textContent = card.name;
      const hint = document.createElement("span");
      const own = overrides[card.avatar];
      hint.textContent = own ? "已单独挑过音色" : "默认音色（按这个角色算出来的）";
      who.append(strong, hint);

      // ① 音色下拉：选项由中转给（它才知道自己开放了哪些）
      const speakerLabel = document.createElement("label");
      speakerLabel.className = "character-manage-toggle";
      const speakerText = document.createElement("span");
      speakerText.textContent = "音色";
      const select = document.createElement("select");
      select.dataset.voiceSpeaker = card.avatar;
      if (!speakers.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = cap.canSpeak ? "（这个中转没有开放音色）" : "（现在还拿不到音色列表）";
        select.appendChild(option);
        select.disabled = true;
      } else {
        // 二百多个音色**必须分组**，不然一个平铺的下拉里根本找不着东西。
        // 分组按语言（中文 / 英语 / 其他语言），选项文字里带场景（通用 / 角色扮演 / 有声阅读…）。
        const groups = new Map();
        for (const one of speakers) {
          const key = one.langLabel || (one.lang === "en" ? "英语" : (one.lang === "zh" ? "中文" : "其他语言"));
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(one);
        }
        // 中文排最前，其余按字母；自定义（中转用环境变量加的）排最后。
        const order = ["中文", "英语", "其他语言", "自定义"];
        const sorted = Array.from(groups.keys()).sort((a, b) => {
          const ia = order.indexOf(a), ib = order.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "zh-Hans-CN");
        });
        for (const label of sorted) {
          const list = groups.get(label);
          const group = document.createElement("optgroup");
          group.label = label + "（" + list.length + "）";
          for (const one of list) {
            const option = document.createElement("option");
            option.value = one.id;
            option.textContent = one.label || one.id;
            option.selected = one.id === setting.speaker;
            group.appendChild(option);
          }
          select.appendChild(group);
        }
      }
      select.addEventListener("change", () => {
        saveVoiceOverride(card.avatar, { speaker: select.value }).catch(() => {});
      });
      speakerLabel.append(speakerText, select);

      // ② 语速：官方 speech_rate
      const rateWrap = document.createElement("label");
      rateWrap.className = "character-manage-toggle";
      const rateText = document.createElement("span");
      rateText.textContent = "语速";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(SPEECH_RATE_MIN);
      input.max = String(SPEECH_RATE_MAX);
      input.step = "5";
      input.value = String(setting.speechRate);
      input.dataset.voiceField = "speechRate";
      const value = document.createElement("b");
      value.textContent = formatSpeechRate(setting.speechRate);
      input.addEventListener("input", () => { value.textContent = formatSpeechRate(input.value); });
      input.addEventListener("change", () => {
        saveVoiceOverride(card.avatar, { speechRate: Number(input.value) }).catch(() => {});
      });
      rateWrap.append(rateText, input, value);

      const actions = document.createElement("div");
      actions.className = "character-manage-actions";
      const test = document.createElement("button");
      test.type = "button";
      test.className = "plain-button";
      test.dataset.voiceTest = card.avatar;
      test.textContent = "试听";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "plain-button";
      reset.dataset.voiceReset = card.avatar;
      reset.textContent = "恢复默认";
      actions.append(test, reset);

      row.append(who, speakerLabel, rateWrap, actions);
      list.appendChild(row);
    }

    // ③ 缓存：说清"已经存了多少、可以清"，并且说明清了会怎样（下次重新合成 = 重新花钱）。
    const cacheNode = document.querySelector("#voiceCacheNote");
    if (cacheNode && Cloud && typeof Cloud.cacheStats === "function") {
      try {
        const stats = await Cloud.cacheStats();
        const mb = (Number(stats.bytes) || 0) / (1024 * 1024);
        cacheNode.textContent = "已缓存 " + (stats.entries || 0) + " 段语音（约 " + mb.toFixed(1) + " MB）。"
          + "同一句重复播放不会再花钱；清掉之后下次要重新合成。";
      } catch (_) {
        cacheNode.textContent = "";
      }
    }
  }

  /** 存一个角色的音色设置（只改传进来的那几项，其余沿用）。 */
  // 同一时刻只处理一次改动。
  // 为什么需要：写完之后会**重渲染整个面板**，而重渲染是异步的；用户连点两下、
  // 或者"改完马上点恢复默认"时，两次调用会各自读到同一份旧设置，后写的那次
  // 把前一次的结果盖回去 —— 现象就是"点了恢复默认，覆盖又回来了"（端到端用例抓到的）。
  let voiceSaving = false;

  async function saveVoiceOverride(avatar, patch) {
    if (!avatar || voiceSaving) return;
    voiceSaving = true;
    try {
      const Voice = window.RoleWorldVoice;
      const settings = await window.RoleWorld.getLocalSettings();
      const map = Object.assign({}, (settings && settings.voice_by_card) || {});
      const current = map[avatar] || {};
      const next = Object.assign({}, current, patch || {});
      // 两项都等于"这个角色的默认"时就不留覆盖（免得存档里堆一堆没用的键）
      const auto = Voice.normalizeVoiceEntry(null, avatar, voiceCapability().speakers);
      const sameSpeaker = (next.speaker || auto.speaker) === auto.speaker;
      const sameRate = Number(next.speechRate || 0) === Number(auto.speechRate || 0);
      if (sameSpeaker && sameRate) delete map[avatar];
      else map[avatar] = Voice.normalizeVoiceEntry(next, avatar, voiceCapability().speakers);
      liveState.localSettings = Object.assign({}, liveState.localSettings || {}, { voice_by_card: map });
      await window.RoleWorld.saveLocalSettings({ voice_by_card: map });
      window.RoleWorldVoiceCloud.noteSettings(Object.assign({}, settings, { voice_by_card: map }));
    } finally {
      voiceSaving = false;
    }
    stopVoicePlayback();
    await renderVoicePanel();
  }

  async function resetVoiceOverride(avatar) {
    if (!avatar || voiceSaving) return;
    voiceSaving = true;
    try {
      const settings = await window.RoleWorld.getLocalSettings();
      const map = Object.assign({}, (settings && settings.voice_by_card) || {});
      delete map[avatar];
      liveState.localSettings = Object.assign({}, liveState.localSettings || {}, { voice_by_card: map });
      await window.RoleWorld.saveLocalSettings({ voice_by_card: map });
    } finally {
      voiceSaving = false;
    }
    await renderVoicePanel();
    showToast("已恢复默认音色");
  }

  /** 试听：用这个角色**当前**的音色念一句（念完就停）。 */
  async function previewVoice(avatar, name) {
    const Cloud = window.RoleWorldVoiceCloud;
    if (!Cloud) return;
    if (Cloud.isSpeaking()) {
      stopVoicePlayback();
      return;
    }
    const cap = voiceCapability();
    // 试听要在**开关还没打开**时也能用（点一个候选先听听，再决定开不开）。
    // 所以这里的判据是"中转问清楚了 + 中转有语音能力"，不是"开关开着"——
    // 面板里也写清了"试听消耗语音额度"，用户是知情点的。
    const canAudition = cap.checked === true && cap.enabled === true && !!cap.relay;
    if (!canAudition) {
      showToast(cap.reason || "现在用不了角色语音。");
      return;
    }
    const setting = await voiceSettingForAvatar(avatar);
    const lang = companionLangFor({ avatar: avatar });
    const line = lang === "en"
      ? ("Hi, I'm " + (name || "this character") + ".")
      : ("你好，我是" + (name || "这个角色") + "。");
    // 试听这一句**走同一份缓存**：同一个角色反复点试听只有第一次花钱。
    const run = ++voiceSpeakRun;
    renderVoiceStatus({ phase: "loading", index: 0, total: 1 });
    const result = await Cloud.speak(line, {
      speaker: setting.speaker,
      speechRate: setting.speechRate,
      maxChars: Math.min(Number(cap.maxChars) || 220, 220),
    });
    if (run !== voiceSpeakRun) return;
    renderVoiceStatus();
    if (!result.ok && result.reason) showToast(result.reason);
  }

  /* app.js 切换设置分区时会回调这里（它不直接依赖本文件的内部函数）。 */
  window.__rwOnSettingsSection = (section) => {
    if (section === "voice") renderVoicePanel().catch(() => {});
    // 每次打开设置都让「角色语音」那一行的显示跟着真实能力走一次。
    // 为什么需要：那一行的显示由一次**异步探测**决定（问中转有没有语音），
    // 而探测可能在 settings-ui 挂上监听之前就跑完了 —— 事件错过，行就永远不出现，
    // 用户看到的是"这个功能根本没有"。切页面时同步一次是最省事的兜底。
    try {
      if (window.RoleWorldSettingsUI && typeof window.RoleWorldSettingsUI.applyVoiceCapability === "function") {
        window.RoleWorldSettingsUI.applyVoiceCapability();
      }
    } catch (_) { /* 同步失败不影响切页 */ }
  };
  // 调试/自检出口：探针要能直接调一次渲染，看它到底抛不抛（只读用途，不改状态）。
  window.__rwInvokeVoicePanel = () => renderVoicePanel();
  // 同上：让自检能绕过事件直接调一次"恢复默认"，用来区分"点击没送到"与"删除逻辑错了"。
  window.__rwInvokeVoiceReset = (avatar) => resetVoiceOverride(avatar);
  // 语音状态（生成中/播放中）由 adapter 发事件、界面只负责显示 —— 不让界面去轮询。
  window.addEventListener("roleworld:voice-state", (event) => renderVoiceStatus(event.detail));
  // 能力变了（探测回来、换了卡、改了开关）就重画一次：菜单项是现算的，但设置页要跟着更新。
  window.addEventListener("roleworld:voice-changed", () => {
    renderVoiceStatus();
    renderVoicePanel().catch(() => {});
    updateReplyVoiceToggle();
  });
  // 「这一轮发语音」那个开关：挂在自己的按钮上（它是输入框旁边的一颗按钮，不在聊天区里）。
  {
    const toggle = document.querySelector("#replyVoiceToggle");
    if (toggle) toggle.addEventListener("click", () => { toggleReplyVoice(); });
    updateReplyVoiceToggle();
  }
  // 粘卡 / 换卡之后重新探测（否则「角色语音」开关永远不出现 —— 见过一次了）。
  bindVoiceCardRefresh();
  // 「设置 → 语音」面板上的三个按钮：试听 / 恢复默认 / 清空缓存。
  bindVoicePanelControls();
  window.__rwInvokeVoicePreview = (avatar, name) => previewVoice(avatar, name);
  window.__rwInvokeVoiceSpeak = (index) => speakMessage(index);
  // 自检出口：切角色/切会话时内部就是这么停的（同一个函数，不是替身）。
  window.__rwInvokeStopVoice = () => { stopVoicePlayback(); return true; };
  // 自检出口：「这一条菜单里有没有朗读」用的就是这两个判定（同一个函数，不是替身）。
  // character 是**这个角色**的资格（内置小说人物 / 没开伴侣 / 不是软件聊天都会在这里被挡）。
  window.__rwVoiceMenuState = () => ({
    canSpeak: canSpeakNow(),
    reason: voiceBlockedReason(),
    character: voiceEligibilityFor(activeCharacterEntry()),
  });
  // 自检出口：开关「开启角色语音」底部面板（用的就是按钮点下去调的那个函数）。
  window.__rwInvokeVoiceSetup = (options) => openVoiceSetup(options || {});
  // 自检出口：关掉语音（与面板里「关闭角色语音」同一条路）。
  window.__rwInvokeVoiceOff = () => turnVoiceOff();

  /**
   * 「设置 → 语音」面板上的三个按钮：试听 / 恢复默认 / 清空缓存。
   *
   * ⚠ **必须挂在 document 上**，不能挂在 `#dynamicMessages` 那个委托里：
   *   设置面板是聊天区**外面**的一层，挂在聊天区上的话这些点击永远到不了处理器 ——
   *   用户看到的就是"试听按钮根本点不动"（2026-09-14 实测反馈）。
   *   当时的用例没抓到，是因为它写了个"事件没生效就直接调函数"的兜底把失败盖住了。
   */
  function bindVoicePanelControls() {
    document.addEventListener("click", (event) => {
      const test = event.target.closest("[data-voice-test]");
      if (test) {
        const avatar = test.dataset.voiceTest;
        const row = test.closest("[data-voice-card]");
        const name = row ? (row.querySelector("strong") || {}).textContent : "";
        previewVoice(avatar, name).catch(() => {});
        return;
      }
      const reset = event.target.closest("[data-voice-reset]");
      if (reset) {
        resetVoiceOverride(reset.dataset.voiceReset).catch(() => {});
        return;
      }
      // 「清空语音缓存」：清之前先说清后果（下次要重新合成 = 重新花钱）。
      if (event.target.closest("[data-voice-clear-cache]")) {
        const Cloud = window.RoleWorldVoiceCloud;
        if (!Cloud) return;
        Cloud.clearCache().then(() => {
          showToast("已清空语音缓存（下次朗读会重新合成）");
          renderVoicePanel().catch(() => {});
        }).catch(() => {});
      }
    });
    // 语音气泡：**点一下才播**（微信式，也正好绕开浏览器的"没交互不许出声"）。
    // 挂在 document 上：气泡是随消息重画的，挂到具体元素上会在下一次重画时失效。
    document.addEventListener("click", (event) => {
      // 「重试」/「改为文字」：失败态气泡上那两个按钮（2026-09-14 加）。
      const action = event.target.closest("[data-voice-action]");
      if (action) {
        const wrap = action.closest(".voice-bubble");
        const message = wrap ? messageAt(Number(wrap.dataset.voiceIndex)) : null;
        const turnId = message && message.extra ? String(message.extra.roleworld_turn_id || "") : "";
        const partIndex = wrap ? Number(wrap.dataset.voicePart) : NaN;
        if (!turnId || !Number.isInteger(partIndex)) { showToast("这条消息上没有可以重试的语音。"); return; }
        action.disabled = true;
        const run = action.dataset.voiceAction === "to-text"
          ? voicePartToText(turnId, partIndex)
          : retryVoicePart(turnId, partIndex);
        run.catch(() => {}).then(() => { action.disabled = false; });
        return;
      }
      const play = event.target.closest(".voice-bubble-play");
      if (!play) return;
      const wrap = play.closest(".voice-bubble");
      if (!wrap) return;
      const message = messageAt(Number(wrap.dataset.voiceIndex));
      const voice = voiceOfMessage(message, wrap.dataset.voicePart);
      if (!voice || voice.status !== "ready") return;
      // 再点一下 = 停（微信里长按停止；这里点击切换更好按）。
      if (wrap.classList.contains("is-playing")) { stopVoicePlayback(); return; }
      playVoiceMessage(wrap, voice).catch(() => {});
    });
  }

  /**
   * 这条消息上的某一条语音（点气泡播之前要拿到它的缓存键）。
   * 分条之后语音是 `extra.roleworld_parts` 里的一条；老消息是 `extra.roleworld_voice`。
   * 两种形状都在这里认，界面别处不许再各写一遍。
   *
   * 返回的形状始终带 `status`（ready / queued / synthesizing / failed）——
   * 界面据此决定画"可播放气泡"还是"准备中/失败态"，**调用方不用自己猜**。
   */
  function voiceOfMessage(message, partIndex) {
    const extra = (message && message.extra) || {};
    const parts = Array.isArray(extra.roleworld_parts) ? extra.roleworld_parts : [];
    if (partIndex !== undefined && partIndex !== null && partIndex !== "") {
      const part = parts[Number(partIndex)];
      if (part && part.kind === "voice") {
        return Object.assign({ status: part.key ? "ready" : "failed" }, part);
      }
      return null;
    }
    const single = parts.find((part) => part && part.kind === "voice");
    if (single) return Object.assign({ status: single.key ? "ready" : "failed" }, single);
    return extra.roleworld_voice || null;
  }

  /**
   * 播一条语音消息：**先取缓存**（正常不花钱），取不到才按当时的音色重合成一次。
   * 播放中给气泡加上 `is-playing`，放完/失败都摘掉 —— 界面状态只跟着真实播放走。
   */
  async function playVoiceMessage(wrap, voice) {
    const Cloud = window.RoleWorldVoiceCloud;
    if (!Cloud || typeof Cloud.playMessage !== "function") {
      showToast("这个版本的语音模块不支持播放语音消息");
      return { ok: false };
    }
    stopVoicePlayback();                       // 一次只放一条（连点两条不该叠着响）
    wrap.classList.add("is-playing");
    let result;
    try {
      result = await Cloud.playMessage(voice);
    } finally {
      wrap.classList.remove("is-playing");
    }
    if (result && result.ok === false && !result.canceled) showToast(result.reason || "这条语音没放出来");
    return result || { ok: false };
  }

  function closeMessageMenus(except) {
    document.querySelectorAll(".message-menu").forEach((menu) => {
      if (except && menu === except) return;
      menu.hidden = true;
      const button = menu.parentElement && menu.parentElement.querySelector(".message-menu-button");
      if (button) button.setAttribute("aria-expanded", "false");
    });
  }

  function renderMessageVersions(stack, message, index) {
    const swipes = Array.isArray(message.swipes) ? message.swipes.filter((one) => typeof one === "string" && one) : [];
    if (swipes.length < 2) return;
    const current = Math.min(Math.max(Number(message.swipe_id) || 0, 0), swipes.length - 1);
    const bar = document.createElement("div");
    bar.className = "message-versions";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "message-version-step";
    prev.dataset.versionStep = "-1";
    prev.dataset.messageIndex = String(index);
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "上一个版本");
    prev.disabled = current <= 0;
    const label = document.createElement("span");
    label.className = "message-version-label";
    label.textContent = `${current + 1} / ${swipes.length}`;
    label.title = "这条回复有多个版本（重新回答会新增一版，旧的不会被删掉）";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "message-version-step";
    next.dataset.versionStep = "1";
    next.dataset.messageIndex = String(index);
    next.textContent = "›";
    next.setAttribute("aria-label", "下一个版本");
    next.disabled = current >= swipes.length - 1;
    bar.append(prev, label, next);
    stack.appendChild(bar);
  }

  /**
   * 一轮回复分成几条时，**一条一条送到**（不是整轮一起出现）。
   *
   * 用户 2026-09-14：「也可以发几条，或者根据输入内容加上合适的延时……尽可能地模仿真人」。
   * 只在**刚到的这一轮**上做（`liveState.animateTurnId`）：翻历史、刷新页面时全部直接显示 ——
   * 老消息一条一条蹦出来只会让人以为应用卡了。
   *
   * ⚠ 两条 2026-09-14 补的规矩：
   *   ① **只等"真的还没到"的那些**（`is-tbd`）。已经在准备语音、或者合成失败的条目
   *      必须立刻在位显示 —— 否则用户盯着一个空位等一条永远不会"到"的消息；
   *   ② 定时器**登记在 `liveState.revealTimers` 里**，切会话/取消时要清掉。
   *      不清的话，切走之后旧的一轮还会继续往外蹦消息（蹦到另一个会话的界面上）。
   *
   * 延时的口径：按这一条的字数算（打字速度），夹在 260–1400ms 之间；语音条读完后停久一点
   * （真人发完语音要喘口气）。同时把"正在输入…"那行亮着，让等待有解释。
   */
  function schedulePartReveal(stack, message, index) {
    const turnId = message && message.extra ? String(message.extra.roleworld_turn_id || "") : "";
    if (!turnId || liveState.animateTurnId !== turnId) return;
    liveState.animateTurnId = "";   // 只播一次
    const pieces = Array.from(stack.querySelectorAll(".message-part.is-tbd"));
    if (!pieces.length) return;
    const typing = document.querySelector("#typingNote");
    let wait = 0;
    pieces.forEach((piece) => {
      const length = (piece.textContent || "").length;
      const isVoice = !!piece.querySelector(".voice-bubble");
      wait += Math.max(260, Math.min(1400, 200 + length * 28)) + (isVoice ? 320 : 0);
      piece.classList.add("is-waiting");
      if (typing) typing.hidden = false;
      const timer = window.setTimeout(() => {
        liveState.revealTimers = liveState.revealTimers.filter((one) => one !== timer);
        piece.classList.remove("is-waiting", "is-tbd");
        if (typing && !liveState.revealTimers.length) typing.hidden = true;
        const scroll = document.querySelector("#chatScroll");
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
        void index;
      }, wait);
      liveState.revealTimers.push(timer);
    });
  }

  /** 把还没到点的"逐条送达"定时器全部掐掉（切会话、取消、删会话时都要调）。 */
  function cancelScheduledReveals() {
    const timers = Array.isArray(liveState.revealTimers) ? liveState.revealTimers.slice() : [];
    liveState.revealTimers = [];
    for (const timer of timers) { try { window.clearTimeout(timer); } catch (_) { /* 已经烧掉了 */ } }
    const typing = document.querySelector("#typingNote");
    if (typing) typing.hidden = true;
  }

  function messageRow(message, index = -1, total = 0) {    const row = document.createElement("article");
    const isUser = !!message.is_user;
    row.className = `message-row message-row-${isUser ? "user" : "assistant"}`;
    const stack = document.createElement("div");
    stack.className = "message-stack";
    const meta = document.createElement("div");
    meta.className = `message-meta ${isUser ? "message-meta-user" : ""}`;
    const who = document.createElement("strong");
    who.textContent = message.name || (isUser ? liveState.userName : liveState.charName);
    meta.appendChild(who);
    // 2026-09-18 用户口径：**全局取消「记错 / 编造」** —— 消息旁不再摆这两个入口。
    // 每条消息一个操作菜单（复制 / 编辑 / 重新回答 / 从这里开分支）。
    if (index >= 0) meta.appendChild(buildMessageActions(message, index, total));
    stack.appendChild(meta);
    if (isUser) {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble user-bubble";
      // 自己发的表情：**渲染成图**，不把那行"给模型看的标记"摆在气泡里。
      // 用户 2026-09-18 实测：「发送出去不能正确渲染，发送的是文字：[玩家发送了一个表情：惊讶]」。
      // 助手那条路一直会换成图（renderAssistantBody），用户这条以前只做 textContent ——
      // 于是同一张表情，角色发出来是图、自己发出来是字。取不到图就退回文字（不显示破图）。
      const stamp = userStickerStamp(String(message.mes));
      const stickerHtml = stamp && typeof window.renderStickerHtml === "function"
        ? window.renderStickerHtml([stamp])
        : "";
      if (stickerHtml) {
        bubble.classList.add("user-bubble-sticker");
        bubble.innerHTML = stickerHtml;
      } else {
        const paragraph = document.createElement("p");
        paragraph.textContent = String(message.mes);
        bubble.appendChild(paragraph);
      }
      stack.appendChild(bubble);
    } else {
      // 一轮回复可以分成**几条消息**（空行分段，其中可能有语音条）—— 2026-09-14 用户要求
      // 「我发一条他不一定就发一条，也可以发几条」「语音要显示成单独的消息」。
      // 所以这里在"这一轮分了几条"时，给每条单独画一个气泡（第一条带名字/菜单/版本）。
      const parts = Array.isArray(message.extra && message.extra.roleworld_parts)
        ? message.extra.roleworld_parts.filter((part) => part && (isVoiceLikePart(part) || part.text))
        : [];
      // 什么时候按"分条"画：**多条**的时候，或者**唯一一条就是语音**的时候。
      // 后者是用户 2026-09-14 点名的："语音应该显示成单独的消息，不应该跟在文字后面" ——
      // 所以一条语音消息就是一条语音消息，屏幕上不再先出现一行文字再挂个气泡。
      // 有多个版本的回复**一律按正文渲染**：分条/语音是"这一版"的形状，
      // 版本一换就该跟着换，而 parts 只存了最新那版 —— 混着用会出现"切了版本界面没变"。
      const versioned = Array.isArray(message.swipes) && message.swipes.length > 1;
      // ⚠ 这里也认 `queued` / `synthesizing` / `failed`：一条**还没合成好**的语音
      // 必须按"语音"渲染（准备中的气泡），绝不能因为"还没有缓存键"就掉回文字渲染
      // —— 那正是用户看到的那一闪。
      const useParts = !versioned && (parts.length > 1 || (parts.length === 1 && isVoiceLikePart(parts[0])));
      if (useParts) {
        stack.classList.add("message-parts");
        const plainNow = isPlainChatMessage(message);
        parts.forEach((part, partIndex) => {
          const delivery = voiceDeliveryOf(part);
          // 逐条送达只该等**真的还没到**的那些（纯文字且不是最后一条）：
          // 已经在准备语音、或者失败的，必须立刻在位显示 ——
          // 否则用户会盯着一个空位等一条永远不会"到"的消息。
          const waitForReveal = partIndex > 0 && partIndex < parts.length - 1 && delivery.deliver === "text";
          const piece = document.createElement("div");
          piece.className = `message-part${waitForReveal ? " is-tbd" : ""}`;
          piece.dataset.partKind = delivery.deliver;
          if (part.kind === "voice") {
            piece.appendChild(buildVoiceBubble(message, index, {
              status: delivery.deliver === "voice" ? "ready" : (delivery.deliver === "voice-pending" ? (part.status || "queued") : "failed"),
              text: part.text,
              key: part.key || "",
              seconds: part.seconds || 0,
              speaker: part.speaker || "",
              speechRate: part.speechRate || 0,
              reason: part.reason || "",
              note: part.note || "",
              retry: part.retry || 0,
            }, partIndex));
          } else {
            const body = document.createElement("div");
            body.className = "message-bubble assistant-bubble";
            const paragraph = document.createElement("p");
            // 微信这一档：文字气泡也走**同一份清理**（去引号、去括号描写、去没加括号的旁白句）——
            // 跟语音念的、跟"纯对白"排版是同一份文本（用户实测反馈：文字里还带着 “”）。
            paragraph.textContent = plainNow
              ? plainChatText(part.text)
              : part.text;
            body.appendChild(paragraph);
            piece.appendChild(body);
            // 「本来要发语音，但这条没做成」：原因写在消息上 —— 悄悄变回文字是这个项目最忌讳的。
            if (part.note) {
              const why = document.createElement("p");
              why.className = "message-voice-note";
              why.textContent = "这条没有做成语音：" + String(part.note);
              piece.appendChild(why);
            }
          }
          stack.appendChild(piece);
        });
        // 逐条送达：整轮一起出现太"机器"了（用户要求尽可能像真人）。
        schedulePartReveal(stack, message, index);
      } else {
      const body = document.createElement("div");
      body.className = "assistant-body";
      // 存下来的表情跟着消息走（刷新、换设备后照样显示）。
      const savedStickers = message.extra && Array.isArray(message.extra.roleworld_stickers)
        ? message.extra.roleworld_stickers
        : [];
      // ⚠ **先按模式把文本定好，再交给同一个渲染器** —— 让"模式"只改**文本内容**，
      //   不改**结构**。以前是"先渲染、再按模式把刚画好的节点删掉、塞一段裸文字"，
      //   于是同一档内部结构都不一致：矩阵用例实测 —— 日常聊天「单条」= 裸文字（无气泡、
      //   无旁白样式），剧情对话「单条」= 旁白行；多条形两档都有气泡。
      //   用户 2026-09-18 的原话就是「不同模式的输出，会显现出很奇怪的样式」。
      //   文本规则与朗读/发语音共用一份（看到的＝听到的）。
      const plainNow = isPlainChatMessage(message);
      const Core = window.TASK22_CORE;
      let bodyText = String(message.mes);
      if (plainNow) {
        bodyText = plainChatText(bodyText);
        if (Core && typeof Core.stripStickerMarkers === "function") bodyText = Core.stripStickerMarkers(bodyText);
      }
      body.innerHTML = renderAssistantBody(bodyText, savedStickers, { dialogueOnly: plainNow });
      if (plainNow) body.classList.add("assistant-body-plain");
      stack.appendChild(body);
      }
      // 角色发来的语音消息（微信式气泡：时长 + 点一下播 + 可看文字）。
      // ⚠ 老存档 / 分条之前的形状走这条路（`roleworld_voice`），照旧渲染；
      //   新消息走上面的 parts（语音自己就是一条消息）。
      //   `status: "ready"` 之外的状态（准备中/失败）走 buildVoiceBubble 里那两态 ——
      //   老气泡也要看得见"还没好"和"没做出来"，而不是干脆消失。
      const savedVoice = message.extra && message.extra.roleworld_voice ? message.extra.roleworld_voice : null;
      if (savedVoice && !useParts && savedVoice.status !== "gone") {
        stack.appendChild(buildVoiceBubble(message, index, savedVoice));
      }
      const refs = message.extra && Array.isArray(message.extra.roleworld_refs) ? message.extra.roleworld_refs : [];
      if (refs.length) stack.appendChild(buildRefList(refs));
      // 语言对不上：原文一个字不动，只在下面挂一句说明（用户 2026-09-14 的要求）。
      const languageInfo = message.extra && message.extra.roleworld_language ? message.extra.roleworld_language : null;
      if (languageInfo) stack.appendChild(buildLanguageNotice(languageInfo));
      if (message.extra && message.extra.roleworld_truncated === true) stack.appendChild(buildTruncationNotice());
      // 「重新回答」留下的旧版本：带页码切换，上下文用当前选中的那一版（mes 就是它）。
      if (index >= 0) renderMessageVersions(stack, message, index);
      const avatar = document.createElement("div");
      avatar.className = "message-avatar assistant-avatar";
      avatar.setAttribute("aria-label", liveState.charName);
      avatar.setAttribute("role", "img");
      row.appendChild(avatar);
    }
    row.appendChild(stack);
    if (index >= 0) row.dataset.messageIndex = String(index);
    return row;
  }

  function renderLiveMessages(messages, options = {}) {
    const scroll = $("#chatScroll");
    const container = $("#dynamicMessages");
    if (!scroll || !container) return;
    scroll.querySelectorAll("article").forEach((element) => { element.hidden = true; });
    const divider = scroll.querySelector(".date-divider span");
    if (divider) divider.textContent = liveState.activeSession ? liveState.activeSession.title : "新对话";
    container.textContent = "";
    if (options.loading) {
      const loading = document.createElement("div");
      loading.className = "chat-loading";
      loading.setAttribute("role", "status");
      loading.textContent = "正在加载对话…";
      container.appendChild(loading);
      return;
    }
    // 只画最近 30 条，但索引要按**整段对话**算（编辑 / 重新回答 / 分支都按绝对位置操作）。
    const all = Array.isArray(messages) ? messages : [];
    const visible = all.slice(-30);
    const offset = all.length - visible.length;
    visible.forEach((message, i) => container.appendChild(messageRow(message, offset + i, all.length)));
    // 安全带：这一轮不播逐条送达时，任何 `is-tbd`（"还没到点"）都必须在这次渲染里清掉 ——
    // 留着它等于把一条消息永久藏起来（用户会觉得"少了一条"）。
    // 正常路径下 schedulePartReveal 会自己摘掉；这里防的是"消息不是刚到的"、以及取消之后的重渲染。
    if (!liveState.animateTurnId) {
      container.querySelectorAll(".message-part.is-tbd").forEach((piece) => {
        piece.classList.remove("is-tbd", "is-waiting");
      });
    }
    scroll.scrollTop = scroll.scrollHeight;
  }

  function messageAt(index) {
    const messages = (liveState.activeSession && liveState.activeSession.messages) || liveState.chatMessages || [];
    return messages[Number(index)] || null;
  }

  /** 重新渲染当前对话（改完文字、切完版本之后都要走一遍）。 */
  function refreshChatMessages() {
    syncActiveSession();
    renderLiveMessages(liveState.chatMessages);
  }

  /** 把"对话头 + 这批消息"拼成存储要的 JSONL 结构。
   *  **注意**：不能直接拿 `buildSavePayload(session.lines, …)` 的结果再拼消息 ——
   *  那个函数返回的是"整段旧对话 + 追加的两条"，于是会把每条消息写两遍
   *  （2026-09-13 新加的落盘用例当场抓到：条数 3 → 6）。这里只借它的"补头"逻辑。 */
  function buildChatPayload(session, messages, title) {
    const lines = (session && session.lines) || [];
    const first = lines[0];
    const hasHeader = first && typeof first === "object" && Object.prototype.hasOwnProperty.call(first, "chat_metadata");
    let head;
    if (hasHeader) {
      head = Object.assign({}, first);
      head.chat_metadata = Object.assign({}, first.chat_metadata || {});
      delete head.chat_metadata.integrity;
      if (title) head.chat_metadata.ui_title = title;
    } else {
      head = {
        chat_metadata: title ? { ui_title: title } : {},
        user_name: liveState.userName || "",
        character_name: (session && session.charName) || liveState.charName || "",
      };
    }
    return [head].concat(Array.isArray(messages) ? messages : []);
  }

  /** 把整段对话写回存储。编辑 / 切版本 / 加版本都从这里走，保证"存的就是看到的"。 */
  async function persistMessages(messages, note) {
    const session = liveState.activeSession;
    if (!session || !session.avatar) throw new Error("chat unavailable");
    const fileName = session.storageFileName || session.fileName;
    const payload = buildChatPayload(session, messages);
    await window.STApi.saveChat(session.avatar, fileName, payload);
    // 同一个会话对象（模型里的"活动会话"就是它），一起更新，避免内存与磁盘两套。
    session.lines = payload;
    session.messages = messages;
    session.updatedAt = new Date().toISOString();
    // 检索用的历史缓存要作废，否则刚改的内容最多 30 秒后才可见。
    // 这个函数在文件的另一段作用域里（同一份文件有两段），所以按存在性调用，别硬引用。
    try { if (typeof invalidateHistoryCache === "function") invalidateHistoryCache(); } catch (_) { /* 缓存 30 秒自己过期 */ }
    syncActiveSession();
    return note;
  }

  /** 编辑一条消息的文字（不动其它消息）。 */
  async function editMessageText(index, text) {
    const messages = ((liveState.activeSession && liveState.activeSession.messages) || []).slice();
    const message = messages[index];
    if (!message) return false;
    const next = String(text || "").trim();
    if (!next) { showToast("内容不能为空"); return false; }
    if (next === String(message.mes || "")) return false;
    // 改之前先留一份原样：写盘失败时要**一个字都不差地还回去**（见下面的 catch）。
    const previousMes = String(message.mes || "");
    const previousExtra = message.extra ? Object.assign({}, message.extra) : message.extra;
    const previousSwipes = Array.isArray(message.swipes) ? message.swipes.slice() : null;
    message.mes = next;
    // 改过文字之后，**这一轮的分条/语音就作废了**：`roleworld_parts` 里存的还是改之前的几条，
    // 渲染时优先按 parts 画 —— 不丢掉它，用户会看到"改完没生效"（真踩过）。
    // 改完就当成一条普通文字消息（折叠成一条），比留一堆对不上的旧气泡诚实。
    if (message.extra && message.extra.roleworld_parts) {
      message.extra = Object.assign({}, message.extra, { roleworld_parts: [{ kind: "text", text: next }] });
    }
    // 改过的那一版就是当前版本：如果这条有旧版本，把新版覆盖进当前 swipe，保持一致。
    if (Array.isArray(message.swipes) && message.swipes.length) {
      const current = Math.min(Math.max(Number(message.swipe_id) || 0, 0), message.swipes.length - 1);
      message.swipes[current] = next;
    }
    try {
      await persistMessages(messages, "已改这一条");
    } catch (error) {
      // 写盘失败**不能静默**，也不能让内存与盘各说各话：原来这里直接抛出去，
      // 调用方是 `.catch(() => {})` —— 用户看不到任何提示，而内存里已经改了，
      // 于是以后任何一次重画都显示"改后的文字"、刷新一下又变回原文
      //（2026-09-17 真实浏览器实测：调用方只拿到一个被吞掉的 reject）。
      // 所以：把这一条原样还回去，再把真实原因说出来，返回 false 让调用方知道没成。
      message.mes = previousMes;
      message.extra = previousExtra;
      if (previousSwipes) message.swipes = previousSwipes;
      try { refreshChatMessages(); } catch (_) { /* 重画失败也不能盖掉提示 */ }
      showToast("这一条没保存上：" + String((error && error.message) || error).slice(0, 80)
        + "（改动已还原，可以再试一次）");
      return false;
    }
    refreshChatMessages();
    return true;
  }

  /** 切换某个回复的版本（上下文自动用选中的那一版，因为 mes 就是它）。 */
  async function switchMessageVersion(index, step) {
    const messages = ((liveState.activeSession && liveState.activeSession.messages) || []).slice();
    const message = messages[index];
    const swipes = message && Array.isArray(message.swipes) ? message.swipes : null;
    if (!swipes || swipes.length < 2) return false;
    const current = Math.min(Math.max(Number(message.swipe_id) || 0, 0), swipes.length - 1);
    const next = Math.min(Math.max(current + Number(step || 0), 0), swipes.length - 1);
    if (next === current) return false;
    // 与编辑那条同一个道理：写盘失败时要**原样还回去**，否则界面上"‹ ›"显示的是新版、
    // 盘上还是旧版（一次重画/刷新就"自己变回去"，而用户全程看不到任何提示）。
    const previousId = message.swipe_id;
    const previousMes = message.mes;
    const previousExtra = message.extra ? Object.assign({}, message.extra) : message.extra;
    message.swipe_id = next;
    message.mes = swipes[next];
    // 换版本同理：分条/语音是**上一版**的形状（而且我们只存了最新那版），
    // 不丢掉它，切版本之后屏幕上还是旧的那几条（用户会以为"切了没变"）。
    if (message.extra && message.extra.roleworld_parts) {
      message.extra = Object.assign({}, message.extra, { roleworld_parts: [{ kind: "text", text: String(swipes[next] || "") }] });
    }
    try {
      await persistMessages(messages, `已切到第 ${next + 1} 版`);
    } catch (error) {
      message.swipe_id = previousId;
      message.mes = previousMes;
      message.extra = previousExtra;
      try { refreshChatMessages(); } catch (_) { /* 重画失败也不能盖掉提示 */ }
      showToast("换版本没保存上：" + String((error && error.message) || error).slice(0, 80)
        + "（已停在原来的那一版，可以再试一次）");
      return false;
    }
    refreshChatMessages();
    return true;
  }

  /** 从这里开分支：**新建一个对话文件**，原对话一个字都不改。
   *  为什么用"新文件"而不是在同一份里做树：导出的存档就是对话文件本身，
   *  新文件天然跟着导出/导入走，也不会把原对话置于半改状态。 */
  async function branchFromMessage(index) {
    const session = liveState.activeSession;
    if (!session || !session.avatar) { showToast("先选一个角色"); return false; }
    const messages = (session.messages || []).slice();
    const at = Number(index);
    if (!(at >= 0) || at >= messages.length) { showToast("这条消息已经不在了"); return false; }
    const kept = messages.slice(0, at + 1).map((message) => Object.assign({}, message));
    const baseTitle = session.title || "新对话";
    const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
    const title = `${baseTitle} · 分支 ${stamp}`;
    try {
      // 保留原对话的头部元数据（角色绑定就在里面），只换标题与正文。
      const payload = buildChatPayload(session, kept, title);
      const fileName = window.TASK22_CORE.newChatFileName();
      await window.STApi.saveChat(session.avatar, fileName, payload, true);
      await liveState.chatModel.refresh({ preserveUnsaved: false });
      await liveState.chatModel.select(fileName);
      syncActiveSession();
      showToast(`已从这条消息开了一个新对话《${title}》（共 ${kept.length} 条）——原对话没有改动`);
      return true;
    } catch (error) {
      showToast("开分支失败：" + String((error && error.message) || error));
      return false;
    }
  }

  /** 就地编辑一条用户消息。
   *  策略（用户要求"涉及后续内容时给出清楚的处理方式，不能静默删除"）：
   *   - 改的是**最后一条**用户消息：直接改，并提示可以「重新回答」让它按新问题重答；
   *   - 改的是**更早**的消息：不动原对话，改成"从这里开分支"（分支里带上你改过的这一句），
   *     并在提示里说清楚这件事 —— 悄悄重写历史会让后面的对话对不上。 */
  async function startEditMessage(index) {
    const message = messageAt(index);
    if (!message || !message.is_user) return false;
    const row = document.querySelector(`#dynamicMessages article[data-message-index="${index}"]`);
    if (!row) return false;
    const messages = (liveState.activeSession && liveState.activeSession.messages) || [];
    const isLastUser = messages.slice(index + 1).every((one) => one && one.is_user !== true);
    const bubble = row.querySelector(".user-bubble") || row.querySelector(".message-stack");
    if (!bubble || row.querySelector(".message-edit")) return false;
    const box = document.createElement("div");
    box.className = "message-edit";
    const area = document.createElement("textarea");
    area.className = "message-edit-input";
    area.value = String(message.mes || "");
    area.rows = Math.min(10, Math.max(2, String(message.mes || "").split("\n").length + 1));
    const actions = document.createElement("div");
    actions.className = "message-edit-actions";
    const note = document.createElement("span");
    note.className = "message-edit-note";
    note.textContent = isLastUser
      ? "改完点保存：这一句会被改写。想让角色按新问题重答，保存后点「重新回答」。"
      : "这是更早的消息：直接改写会让后面的对话对不上，所以保存会**从这一句开一个新分支**，原对话不动。";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-button";
    save.textContent = isLastUser ? "保存" : "改并开分支";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "plain-button";
    cancel.textContent = "取消";
    actions.append(note, cancel, save);
    box.append(area, actions);
    bubble.replaceWith(box);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    const close = () => { box.replaceWith(bubble); };
    cancel.addEventListener("click", close);
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    });
    save.addEventListener("click", () => {
      const text = area.value.trim();
      if (!text) { showToast("内容不能为空"); return; }
      if (isLastUser) {
        editMessageText(index, text).then((ok) => { if (ok) showToast("已改这一条；想让它重答就点「重新回答」"); }).catch(() => {});
      } else {
        const keptOriginal = text;
        openMessageBranch(index, keptOriginal).catch(() => {});
      }
      close();
    });
    return true;
  }

  /** 更早的消息被编辑：开分支，并在分支里把那一句换成改后的文字。 */
  async function openMessageBranch(index, editedText) {
    const ok = await branchFromMessage(index);
    if (!ok) return;
    if (typeof editedText === "string" && editedText.trim()) {
      await editMessageText(index, editedText.trim());
    }
    showToast("新分支已打开：这一句就是改过之后的版本，接着往下聊即可");
  }

  /** 重新回答某条回复：**旧版本不删**，新的一版追加成 swipe 并选中它。
   *  走的是同一条发送链路（同一个 sendLive），只是把"这一轮的用户话"换成已有的那一句、
   *  把"上一轮上下文"截到这条回复之前，落盘时写版本而不是追加一轮。 */
  async function regenerateReply(index) {
    if (liveState.pending || liveState.switching) { showToast("正在生成，等这一轮结束再试"); return false; }
    const messages = (liveState.activeSession && liveState.activeSession.messages) || [];
    const at = Number(index);
    const target = messages[at];
    if (!target || target.is_user) { showToast("这条不是角色的回复，不能重新回答"); return false; }
    const ask = messages[at - 1];
    if (!ask || ask.is_user !== true) { showToast("这条回复前面没有对应的问题，不能重新回答"); return false; }
    liveState.regenerateIndex = at;
    const started = sendLive().catch(() => false);
    return started;
  }

  /** 重新回答的落盘：新版本进 swipes，mes 指向它（下一轮上下文自动用这一版）。 */
  async function saveRegeneratedReply(index, replyText, turnId, chatStyle) {
    const messages = ((liveState.activeSession && liveState.activeSession.messages) || []).slice();
    const message = messages[index];
    if (!message) throw new Error("message gone");
    const previous = Array.isArray(message.swipes) && message.swipes.length
      ? message.swipes.slice()
      : [String(message.mes || "")];
    const extra = message.extra || {};
    const styles = previous.map((_, i) => Array.isArray(extra.roleworld_swipe_styles)
      ? (extra.roleworld_swipe_styles[i] || null) : (extra.roleworld_chat_style || null));
    styles.push(chatStyle === "plain" ? "plain" : "action");
    previous.push(String(replyText || ""));
    message.swipes = previous;
    message.swipe_id = previous.length - 1;
    message.mes = String(replyText || "");
    message.extra = Object.assign({}, extra, { roleworld_swipe_styles: styles }, turnId ? { roleworld_turn_id: turnId } : {});
    await persistMessages(messages, "regenerated");
    return { versions: previous.length };
  }

  /** 失败那一轮下面那张卡片：保留原话 + 一个「重试」。 */
  function renderTurnFailure(userText, error) {
    const container = document.querySelector("#dynamicMessages");
    if (!container) return;
    const why = String((error && (error.message || error.statusText)) || "未知原因").slice(0, 160);
    const card = document.createElement("div");
    card.className = "turn-failure";
    const text = document.createElement("p");
    text.className = "turn-failure-text";
    const saveOnly = error && typeof error.retrySave === "function";
    text.textContent = saveOnly ? `回复已生成，但还没保存：${userText}` : `这一句没发出去：${userText}`;
    const note = document.createElement("p");
    note.className = "turn-failure-why";
    note.textContent = saveOnly ? `原因：${why}（重试只保存原回复，不再请求模型；刷新前请先保存或复制留底）`
      : `原因：${why}（这一轮没有写进对话，重试不会重复发送）`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "plain-button";
    retry.dataset.action = saveOnly ? "retry-save" : "retry-turn";
    retry.dataset.userText = userText;
    retry.textContent = saveOnly ? "重试保存" : "重试";
    if (saveOnly) retry.addEventListener("click", async () => {
      if (retry.disabled || liveState.pending || liveState.switching) return;
      retry.disabled = true;
      try {
        await error.retrySave();
        card.remove();
      } catch (err) {
        note.textContent = `仍未保存：${String(err && err.message || '写入失败').slice(0, 160)}（原回复仍在，可再次重试保存或复制留底）`;
      } finally { retry.disabled = false; }
    });
    card.append(text, note, retry);
    container.appendChild(card);
    const scroll = document.querySelector("#chatScroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function syncActiveSession() {    const session = liveState.chatModel && liveState.chatModel.getActive();
    liveState.activeSession = session || null;
    liveState.chatFile = session && session.serverSaved ? session.fileName : null;
    liveState.chatLines = session ? session.lines : [];
    liveState.chatMessages = session ? session.messages : [];
    const firstUser = liveState.chatMessages.find((message) => message.is_user && message.name);
    // 称呼优先：用户在引导/设置里填的昵称 > 会话里历史记录的用户名 > 默认。
    const nickname = window.TASK25C_UI && typeof window.TASK25C_UI.nickname === "function" ? window.TASK25C_UI.nickname() : "";
    liveState.userName = nickname || (firstUser && firstUser.name) || "用户";
    // Task-29A：展示名跟随当前会话的绑定角色；未绑定会话跟随待选/默认角色。
    liveState.charName = activeCharacterEntry().charName || liveState.charName;
    // Task-29F：顶部标题/侧栏品牌名与记忆面板跟随当前角色。
    renderActiveCharacterIdentity();
    applyMemoryPanelFilter();
    renderChatList();
    renderArchivedChatSettings();
    renderLiveMessages(liveState.chatMessages);
    renderChatRecap();
    renderCharacterPicker();
    loadCostFor(session);
    // 换了角色/会话，「这一轮发语音」那个开关的可用性跟着变（能不能发是**按角色**判的）。
    updateReplyVoiceToggle();
  }

  /* ---------- 「上次说到」 ----------
   * 隔了一天以上再回来，很多人要往下翻半天才知道上次聊到哪。
   * 这一条完全在本机算：取**真实说过的那句话**，不调模型、不做摘要、不编内容；
   * 没有记录就不显示，而不是硬凑一句"我们上次聊得很开心"。
   * 收起只在本次会话内有效（刷新后会再出现一次）—— 为此单独存一份偏好不值得。
   */
  const RECAP_DISMISSED_NOTE = "收起只在这次打开期间有效（刷新后会再出现一次）。";
  // 收起过的对话（会记住多个：收起 A 之后再去 B，回到 A 时仍然安静）。
  const recapDismissed = new Set();

  /** 算出"上次说到什么"。返回 null 表示不该显示（刚聊过 / 没内容 / 已收起）。 */
  function chatRecapInfo() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !liveState.activeSession) return null;
    const file = liveState.activeSession.fileName || liveState.activeSession.id || "";
    if (!file || recapDismissed.has(file)) return null;
    const info = core.chatRecap(liveState.chatMessages, { now: new Date() });
    return info ? Object.assign({ file: file }, info) : null;
  }

  function renderChatRecap() {
    const bar = document.querySelector("#chatRecapBar");
    const text = document.querySelector("#chatRecapText");
    if (!bar || !text) return;
    const info = chatRecapInfo();
    if (!info) { bar.hidden = true; return; }
    text.textContent = `上次说到：${info.snippet}（${info.gap.text}）`;
    bar.hidden = false;
  }

  /* ---------- 「本次请求」只读查看 ----------
   * 让用户能看清上一次到底发了什么：按来源分段（角色卡 / 世界设定 / 记忆书 / 旧对话 / 本轮输入），
   * 各段给字符数与 token。**只读**：不发新请求、不落盘、不含 API Key、不主动弹出。
   * 内容按文本插入（textContent），不做 HTML 拼接，避免角色卡里的尖括号变成标签。
   */
  function setRequestPeekVisible(visible) {
    const button = document.querySelector("#requestPeekButton");
    if (!button) return;
    const has = !!(liveState.lastPayload && liveState.lastRequest);
    // 2026-09-12：花费与预估搬进这个面板之后，面板成了看它们**唯一**的入口。
    // 老规矩是"发过消息才露出入口"，那样第一条消息就没有"发送前预估"可看了。
    // 所以再加一条：输入框里有草稿就算（那时候预估已经算出来了）。
    const draft = document.querySelector("#messageInput");
    const hasDraft = !!(draft && !draft.disabled && draft.value.trim());
    button.hidden = !((has || hasDraft) && visible !== false);
    // 「+」面板里那一行是**代理**，可见性跟着这里走：真正按"有没有草稿 / 发没发过消息"
    // 判定的只有这一处，代理不再自己判一次（这个项目反复踩"判据写两套"的坑）。
    syncComposerMenuPeek();
  }

  /** 让「+」面板里那一行与真正的入口保持同一个可见性。 */
  function syncComposerMenuPeek() {
    if (!composerMenuPeekRow) return;
    const button = document.querySelector("#requestPeekButton");
    composerMenuPeekRow.hidden = !button || button.hidden === true;
  }

  /** 「本次请求」面板里的一行：输入占了多少上下文、输出上限是多少（两件事分开写）。 */
  function setPeekBudget(list, core, info) {
    const budget = core.checkContextBudget(Object.assign({ inputTokens: info.totalTokens }, contextBudgetOptions()));
    const share = budget.context > 0 ? Math.round((budget.input / budget.context) * 100) : 0;
    const line = document.createElement("div");
    line.className = "request-peek-dropped";
    line.textContent = `上下文：输入 ${budget.input} token（占 ${budget.context} 的 ${share}%）`
      + ` + 输出上限 ${budget.output} token = ${budget.total}`
      + (budget.ok ? "，在模型上限之内。" : "，已超过模型上限。");
    list.appendChild(line);
    if (!budget.ok) {
      const advice = document.createElement("div");
      advice.className = "request-peek-dropped";
      advice.textContent = budget.message;
      list.appendChild(advice);
    }
    return true;
  }

  function renderRequestPeek() {    const body = document.querySelector("#requestPeekBody");
    if (!body) return;
    body.textContent = "";
    const payload = liveState.lastPayload;
    const info = liveState.lastRequest;
    if (!payload || !info) {
      const empty = document.createElement("p");
      empty.className = "request-peek-empty";
      empty.textContent = "还没有发送过请求。发出第一条消息后，这里会显示那次请求的内容构成。";
      body.appendChild(empty);
      return;
    }

    // 台账汇总：最近 N 轮的延迟、费用、记忆错误与编造次数。
    const metricsCore = window.ROLEWORLD_METRICS_CORE;
    if (metricsCore) {
      const stats = metricsCore.summarize(liveState.metrics || []);
      const box = document.createElement("div");
      box.className = "request-peek-dropped";
      if (!stats.turns) {
        box.textContent = "台账：还没有记录。发出第一条消息后开始统计。";
      } else {
        box.textContent = `台账（最近 ${stats.turns} 轮）：首字平均 ${metricsCore.formatDuration(stats.avgFirstTokenMs)}`
          + ` · 整轮平均 ${metricsCore.formatDuration(stats.avgTotalMs)}`
          + ` · 费用合计 ¥${stats.cost.toFixed(4)}`
          + ` · 记忆写入 ${stats.memoriesAdded} 条 · 检索命中 ${stats.searchHits} 条`;
      }
      body.appendChild(box);
      // 2026-09-18：记错 / 编造全局取消，这里也不再报那两个数字、不再提那两个按钮。
    }

    // 语言约束自检：卡里到底有没有语言要求、这次发出去几处。一眼可见，不用猜。
    const sysText = (payload.messages || []).filter((m) => m && m.role === "system")
      .map((m) => String(m.content || "")).join("\n");
    const langMatches = sysText.match(/\[Language\][^\n]*/g) || [];
    const langBox = document.createElement("div");
    langBox.className = "request-peek-dropped";
    langBox.textContent = langMatches.length
      ? `语言约束（${langMatches.length} 处）：${langMatches[0]}`
      : "语言约束：这张角色卡没有设语言（没说只说中文或只说英文），所以模型会跟着你的语言走。";
    body.appendChild(langBox);

    const pricing = window.RoleWorldPricing;
    const fmtTokens = (n) => (pricing && pricing.formatTokens ? pricing.formatTokens(n) : String(n));
    const list = document.createElement("div");
    list.className = "request-peek-list";

    const addRow = (label, chars, tokens, note, cls) => {
      const row = document.createElement("div");
      row.className = "request-peek-row" + (cls ? " " + cls : "");
      const name = document.createElement("span");
      name.className = "request-peek-label";
      name.textContent = label;
      const meta = document.createElement("span");
      meta.className = "request-peek-meta";
      meta.textContent = `${chars} 字 · ${fmtTokens(tokens)} tokens`;
      row.appendChild(name);
      row.appendChild(meta);
      if (note) {
        const sub = document.createElement("span");
        sub.className = "request-peek-note-inline";
        sub.textContent = note;
        row.appendChild(sub);
      }
      list.appendChild(row);
      return row;
    };

    for (const segment of info.segments) {
      if (segment.kind === "system" && Array.isArray(segment.details) && segment.details.length) {
        addRow("系统提示", segment.chars, segment.tokens, `共 ${segment.details.length} 项，构成如下`, "request-peek-system");
        for (const part of segment.details) {
          const isBook = String(part.label || "").indexOf("记忆书 · ") === 0;
          const row = addRow("　" + part.label, part.chars, part.tokens, "", "request-peek-part");
          // 记忆书点开能看到具体记了哪几条（以及各自来自哪句话）。
          if (isBook) {
            row.classList.add("request-peek-book");
            row.setAttribute("role", "button");
            row.setAttribute("tabindex", "0");
            row.dataset.book = String(part.label).slice("记忆书 · ".length);
            const caret = document.createElement("span");
            caret.className = "request-peek-caret";
            caret.textContent = "▸ 点开看记了什么";
            row.appendChild(caret);
          }
        }
      } else {
        addRow(segment.label, segment.chars, segment.tokens, `${segment.items} 条`, "");
      }
    }

    const total = document.createElement("div");
    total.className = "request-peek-total";
    total.textContent = `合计 ${info.totalChars} 字 · ${fmtTokens(info.totalTokens)} tokens · 共 ${info.messageCount} 条消息`;
    list.appendChild(total);

    // P2-2：上下文上限与输出上限是两件事，分开写清楚 ——
    // "这次发出去多少"和"它最多能回多少"混在一起看，用户没法判断还能聊多久。
    try {
      const core = window.TASK22_CORE;
      if (core && typeof core.contextLimitFor === "function" && !setPeekBudget(list, core, info)) {
        /* 拿不到就少一行，不影响面板其余内容 */
      }
    } catch (_) { /* 同上 */ }

    // 模型主动要求的检索：这一轮带上的是它上一轮点名要翻的内容。
    if (Array.isArray(info.requested) && info.requested.length) {
      const asked = document.createElement("div");
      asked.className = "request-peek-dropped";
      asked.textContent = "模型主动翻查：" + info.requested
        .map((row) => `「${row.query}」找到 ${row.matched} 条`).join("；");
      list.appendChild(asked);
    }

    // 历史检索：找到几条、扫了多少条。让"它怎么突然想起这句话"有据可查。
    if (info.search) {
      const found = document.createElement("div");
      found.className = "request-peek-dropped";
      found.textContent = info.search.matched
        ? `历史检索：从以前的对话里翻到 ${info.search.matched} 条相关记录（已连同出处一起发给模型）`
        : "历史检索：没有翻到相关记录 —— 已告诉模型「没有记录，不要编造」。";
      list.appendChild(found);
    }

    // 被预算丢掉的旧对话必须说出来，绝不静默丢弃。
    if (info.dropped && !info.dropped.keptAll) {
      const dropped = document.createElement("div");
      dropped.className = "request-peek-dropped";
      const what = info.dropped.count > 0 ? `更早的 ${info.dropped.count} 条消息` : "更早的对话内容";
      dropped.textContent = `未带上：${what}（约 ${fmtTokens(info.dropped.tokens)} tokens）`
        + `——旧对话预算为 ${fmtTokens(info.dropped.budget)} tokens，超出的部分没有发送。`
        + `可以在「设置 → 模型」里调大这个预算。`;
      list.appendChild(dropped);
    }

    // 一致性自检：分段拼起来必须与真正发出的请求体逐字节一致。
    // 万一不一致，这里会直接说出来，而不是悄悄显示一份不可信的统计。
    const check = document.createElement("p");
    check.className = "request-peek-check";
    check.textContent = (info.systemMatches && info.messagesMatches)
      ? "已核对：分段之和与真正发出的请求逐字节一致。"
      : "注意：分段统计与真实请求没有完全对上，这份数字不可信。";
    if (!(info.systemMatches && info.messagesMatches)) check.classList.add("request-peek-check-bad");

    body.appendChild(list);
    body.appendChild(check);

    const source = document.createElement("p");
    source.className = "request-peek-source";
    source.textContent = `模型：${payload.model || "未配置"}　发送方式：${payload.chat_completion_source === "deepseek" ? "DeepSeek 官方" : "自定义端点"}`;
    body.appendChild(source);

    const notice = document.createElement("p");
    notice.className = "request-peek-notice";
    notice.textContent = "⚠ 以上内容会发送给你配置的模型服务商。";
    body.appendChild(notice);
  }

  function openRequestPeek() {
    const surface = document.querySelector("#requestPeek");
    if (!surface) return;
    renderRequestPeek();
    surface.hidden = false;
  }

  // 点开一本记忆书：列出它到底带了哪几条，以及每条来自哪句话。
  async function toggleBookEntries(row) {
    const bookName = row.dataset.book || "";
    if (!bookName || !window.STApi) return;
    const box = row.nextElementSibling && row.nextElementSibling.classList.contains("request-peek-book-entries")
      ? row.nextElementSibling
      : null;
    if (box) { box.hidden = !box.hidden; return; }
    const holder = document.createElement("div");
    holder.className = "request-peek-book-entries";
    holder.textContent = "正在读取…";
    row.parentNode.insertBefore(holder, row.nextSibling);
    let world = null;
    try { world = await window.STApi.getWorld(bookName); } catch (_) { world = null; }
    const memory = window.ROLEWORLD_MEMORY_CORE;
    const rows = memory ? memory.listEntries(world && world.entries) : [];
    holder.textContent = "";
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "request-peek-book-empty";
      empty.textContent = "这本记忆书目前是空的。";
      holder.appendChild(empty);
      return;
    }
    const list = document.createElement("ol");
    list.className = "request-peek-book-list";
    rows.forEach((item) => {
      const li = document.createElement("li");
      const content = document.createElement("span");
      content.className = "request-peek-book-content";
      content.textContent = item.content;
      li.appendChild(content);
      const meta = document.createElement("span");
      meta.className = "request-peek-book-source";
      meta.textContent = describeMemorySource(item.source, item.topic, item.replacedContent);
      li.appendChild(meta);
      list.appendChild(li);
    });
    holder.appendChild(list);
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "plain-button request-peek-manage";
    manage.textContent = "管理这本记忆（改 / 删）";
    manage.addEventListener("click", () => { closeRequestPeek(); openMemoryPanel(); });
    holder.appendChild(manage);
  }

  /* ---------- 记忆取向（P5-3）：按角色存一份 ----------
   * 平衡 = 只记你的事实（默认）；陪伴 = 满的时候先挤碎事件、保住有主题的；
   * 剧情 = 剧情也能记，但标明是剧情、且最先被挤掉。
   * 存在 kv 的 memory-orientation:<角色>，跟记忆书分开 —— 它是设置，不是记忆内容。
   */
  const ORIENTATION_KEY_PREFIX = "memory-orientation:";
  const ORIENTATION_LABELS = Object.freeze({
    balanced: "平衡（只记我的事实）",
    companion: "陪伴（保住偏好与关系）",
    story: "剧情（剧情也记，标明是剧情）",
  });
  let orientationCache = { avatar: "", value: "" };

  function orientationKey(entry) {
    return ORIENTATION_KEY_PREFIX + ((entry && entry.avatar) || "");
  }

  async function loadOrientation(entry) {
    const core = window.ROLEWORLD_MEMORY_CORE;
    const fallback = core ? core.ORIENTATIONS.BALANCED : "balanced";
    if (!entry || !entry.avatar) return fallback;
    if (orientationCache.avatar === entry.avatar && orientationCache.value) return orientationCache.value;
    let stored = "";
    try { stored = await window.RoleWorld.store.getKV(orientationKey(entry), ""); } catch (_) { stored = ""; }
    const value = core ? core.normalizeOrientation(stored) : fallback;
    orientationCache = { avatar: entry.avatar, value };
    return value;
  }

  async function saveOrientation(entry, value) {
    const core = window.ROLEWORLD_MEMORY_CORE;
    const next = core ? core.normalizeOrientation(value) : "balanced";
    if (entry && entry.avatar) {
      try { await window.RoleWorld.store.setKV(orientationKey(entry), next); } catch (_) { /* 存不下就先用着 */ }
    }
    orientationCache = { avatar: (entry && entry.avatar) || "", value: next };
    return next;
  }

  /** 记忆面板上的取向选择器：三种取向各自说明差别，改完立刻生效。 */
  function buildOrientationRow() {
    const core = window.ROLEWORLD_MEMORY_CORE;
    const row = document.createElement("div");
    row.className = "memory-orientation";
    const label = document.createElement("span");
    label.className = "memory-orientation-label";
    label.textContent = "记忆取向";
    const select = document.createElement("select");
    select.id = "memoryOrientation";
    select.setAttribute("aria-label", "记忆取向");
    const current = (core && orientationCache.value) || "balanced";
    (core ? core.ORIENTATION_IDS : ["balanced"]).forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = ORIENTATION_LABELS[id] || id;
      if (id === current) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      const entry = activeCharacterEntry();
      saveOrientation(entry, select.value).then((saved) => {
        showToast(saved === "story"
          ? "剧情取向：剧情会被记下，但标明是剧情、也最先被挤掉"
          : saved === "companion" ? "陪伴取向：满的时候先挤碎事件，保住偏好与关系" : "平衡取向：只记你的事实");
        openMemoryPanel().catch(() => {});
      }).catch(() => {});
    });
    const hint = document.createElement("span");
    hint.className = "memory-orientation-hint";
    hint.textContent = "只影响新记下来的内容";
    row.append(label, select, hint);
    return row;
  }

  // 来源说明：来自哪段对话的第几条消息、什么时候、谁写的。缺字段就不编。
  function describeMemorySource(source, topic, replacedContent) {
    const parts = [];
    if (topic) parts.push(`主题「${topic}」`);
    if (source && source.origin === "user") parts.push("你自己写的");
    else parts.push("模型自记");
    if (source && source.confirmed) parts.push("你确认过");
    if (source && source.file) {
      const index = source.messageIndex === null || source.messageIndex === undefined ? "" : ` 第 ${source.messageIndex} 条`;
      parts.push(`来自对话 ${source.file}${index}`);
    } else {
      parts.push("来源未记录（早期记下的）");
    }
    if (source && source.at) {
      const date = new Date(source.at);
      if (!Number.isNaN(date.getTime())) {
        const pad = (n) => String(n).padStart(2, "0");
        parts.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`);
      }
    }
    if (source && source.edited) parts.push("你改过");
    if (replacedContent) parts.push(`替换了原来的「${replacedContent}」`);
    return parts.join(" · ");
  }

  function closeRequestPeek() {
    const surface = document.querySelector("#requestPeek");
    if (surface) surface.hidden = true;
  }

  /* ---------- 角色记忆：看 / 改 / 删 ----------
   * 模型自己记的要点以前是"只进不出"的黑盒。这里让它可见、可改、可删。
   * 删除是真的从记忆书里删掉 —— 后续请求不会再带上它。
   */
  /** 读当前角色的记忆并画进「记忆」分页（原来叫 openMemoryPanel，只负责数据 + 渲染）。 */
  async function loadMemoryPane() {
    const entry = activeCharacterEntry();
    const subtitle = document.querySelector("#memoryPanelSubtitle");
    const list = document.querySelector("#memoryList");
    if (list) { list.textContent = "正在读取…"; }
    if (!entry || !entry.avatar) {
      if (subtitle) subtitle.textContent = "还没有选中的角色。";
      if (list) list.textContent = "";
      return;
    }
    const data = await readAutoMemory(entry);
    liveState.memoryBook = data.bookName;
    liveState.memoryRows = data.rows;
    liveState.memoryEntries = data.entries;
    // 取向是"以后记什么"的设置，跟着面板一起读出来。
    try { await loadOrientation(entry); } catch (_) { /* 读不到就按平衡 */ }
    if (subtitle) {
      subtitle.textContent = `${entry.charName || entry.name} · 《${data.bookName}》 共 ${data.rows.length} 条`
        + `（上限 ${autoMemoryMax()} 条，超出会挤掉最旧的）`;
    }
    renderMemoryList();
  }

  /** 顶栏「记忆」= 一步到当前角色的记忆页（面板的第二个分页）。 */
  async function openMemoryPanel() {
    await openCharacterPanel("memories");
  }

  function renderMemoryList() {
    const list = document.querySelector("#memoryList");
    if (!list) return;
    list.textContent = "";
    const rows = liveState.memoryRows || [];
    // 取向选择器放在最上面：它决定"以后记什么"，跟底下有哪些条目是两件事。
    list.appendChild(buildOrientationRow());
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "request-peek-empty";
      empty.textContent = "还没有记忆。模型在对话里觉得值得记的，会自动写到这里；你也可以手动加。";
      list.appendChild(empty);
      return;
    }

    const core = window.ROLEWORLD_MEMORY_CORE;
    const groups = core && typeof core.groupByTopic === "function"
      ? core.groupByTopic(liveState.memoryEntries || {})
      : [{ topic: "", label: "全部", rows: rows }];

    // 条数用量：还剩多少额度一眼可见。
    const max = autoMemoryMax();
    const usage = document.createElement("p");
    usage.className = "memory-usage";
    const confirmedCount = rows.filter((row) => row.confirmed).length;
    usage.textContent = `已用 ${rows.length} / 上限 ${max} 条`
      + (confirmedCount ? `（其中 ${confirmedCount} 条你确认过，不会被挤掉）` : "")
      + (rows.length >= max ? "（已满，再记会先挤掉剧情与碎事件）" : "");
    list.appendChild(usage);

    groups.forEach((group, groupIndex) => {
      const section = document.createElement("section");
      section.className = "memory-group";

      const head = document.createElement("div");
      head.className = "memory-group-head";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "memory-group-toggle";
      // 第一组默认展开：多数时候用户只想看"最近记了什么"。
      const startOpen = groupIndex === 0;
      toggle.setAttribute("aria-expanded", startOpen ? "true" : "false");
      toggle.textContent = `${startOpen ? "▾" : "▸"} ${group.label}（${group.rows.length}）`;
      head.appendChild(toggle);

      const groupActions = document.createElement("span");
      groupActions.className = "memory-actions";
      const clearGroup = document.createElement("button");
      clearGroup.type = "button";
      clearGroup.className = "plain-button";
      clearGroup.textContent = "清空这组";
      clearGroup.addEventListener("click", () => { clearMemoryGroup(group).catch(() => {}); });
      groupActions.appendChild(clearGroup);
      head.appendChild(groupActions);
      section.appendChild(head);

      const body = document.createElement("ol");
      body.className = "request-peek-book-list memory-list";
      body.hidden = !startOpen;
      group.rows.forEach((item) => body.appendChild(memoryRowNode(item)));
      section.appendChild(body);

      toggle.addEventListener("click", () => {
        const open = !body.hidden;
        body.hidden = open;
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
        toggle.textContent = `${open ? "▸" : "▾"} ${group.label}（${group.rows.length}）`;
      });

      list.appendChild(section);
    });

    // 一键清空该角色全部记忆：二次确认，并明说"删了就真的不再带上"。
    const footer = document.createElement("div");
    footer.className = "memory-panel-foot";
    const clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "danger-button";
    clearAll.textContent = `清空这个角色的全部记忆（${rows.length} 条）`;
    clearAll.addEventListener("click", () => { clearAllMemories().catch(() => {}); });
    footer.appendChild(clearAll);
    list.appendChild(footer);
  }

  /** 一条记忆的 DOM：改 / 删 / 看原话 / 这条说得对，都在这里。 */
  function memoryRowNode(item) {
    const li = document.createElement("li");
    li.dataset.key = item.key;
    const content = document.createElement("span");
    content.className = "request-peek-book-content";
    content.textContent = item.content;
    li.appendChild(content);

    const meta = document.createElement("span");
    meta.className = "request-peek-book-source";
    const bits = [];
    if (item.kind === "story") bits.push("剧情（不是你的事实）");
    // 事件是"此前发生"，跟事实分开标：注入时它会带 [此前发生] 前缀。
    if (item.kind === "event") bits.push("事件（此前发生）");
    if (item.confirmed) bits.push("你确认过");
    meta.textContent = (bits.length ? bits.join(" · ") + " · " : "")
      + describeMemorySource(item.source, item.topic, item.replacedContent);
    // P1-3 来源可追溯：点一下跳回那句原话（那段对话还在的话）。
    if (item.source && item.source.file) {
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "memory-source-link";
      jump.textContent = "看原话";
      jump.title = "跳到这句记忆的来源消息";
      jump.addEventListener("click", () => { jumpToMemorySource(item).catch(() => {}); });
      meta.appendChild(document.createTextNode(" "));
      meta.appendChild(jump);
    }
    li.appendChild(meta);

    const actions = document.createElement("span");
    actions.className = "memory-actions";
    // P5-3：你确认过的记忆不会被上限挤掉（点一下切换）。
    const confirm = document.createElement("button");
    confirm.type = "button";
    // 独立类名：面板里"组"这一层也有 .memory-actions（清空整组会弹 confirm），
    // 自动化测试要点的是"这一条"的按钮，别点错到组上（踩过：无头环境 confirm 会挂住）。
    confirm.className = "plain-button memory-confirm" + (item.confirmed ? " is-on" : "");
    confirm.textContent = item.confirmed ? "说得对 ✓" : "说得对";
    confirm.title = item.confirmed
      ? "已标记：这条不会被上限挤掉；再点一下取消"
      : "标记这条是对的：不会因为记忆条数满了被挤掉";
    confirm.addEventListener("click", () => { confirmMemoryEntry(item.key, !item.confirmed); });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "plain-button";
    edit.textContent = "改";
    edit.addEventListener("click", () => editMemoryEntry(item.key, content));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "plain-button";
    remove.textContent = "删";
    remove.addEventListener("click", () => deleteMemoryEntry(item.key));
    actions.appendChild(confirm);
    actions.appendChild(edit);
    actions.appendChild(remove);
    li.appendChild(actions);
    return li;
  }

  /** 「这条说得对」：标记 / 取消，标记过的条目在上限挤占时最后才动。 */
  async function confirmMemoryEntry(key, confirmed) {
    const core = window.ROLEWORLD_MEMORY_CORE;
    if (!core || !liveState.memoryEntries) return;
    const result = core.confirmEntry(liveState.memoryEntries, key, confirmed);
    if (!result.ok) { showToast("这条记忆已经不在了"); return; }
    if (await saveMemoryEntries(result.entries)) {
      showToast(confirmed ? "记住了：这条不会被上限挤掉" : "已取消标记");
    }
    await openMemoryPanel();
  }

  /** 清空某一组（同主题）记忆。 */
  async function clearMemoryGroup(group) {
    const keys = (group.rows || []).map((row) => row.key);
    if (!keys.length) return;
    if (!window.confirm(`清空「${group.label}」的 ${keys.length} 条记忆？删掉后不会再出现在后续对话里。`)) return;
    const next = Object.assign({}, liveState.memoryEntries || {});
    keys.forEach((key) => { delete next[String(key)]; });
    if (await saveMemoryEntries(next)) showToast(`已清空「${group.label}」的 ${keys.length} 条`);
    await openMemoryPanel();
  }

  /** 清空该角色的全部自动记忆。 */
  async function clearAllMemories() {
    const rows = liveState.memoryRows || [];
    if (!rows.length) return;
    if (!window.confirm(`清空这个角色的全部 ${rows.length} 条记忆？删掉后不会再出现在后续对话里。`)) return;
    if (await saveMemoryEntries({})) showToast(`已清空 ${rows.length} 条记忆`);
    await openMemoryPanel();
  }

  /**
   * 跳到某条记忆的来源消息。找不到就明说（对话可能已被删除），不装作跳成功。
   * 返回值只用于测试与诊断：{ found, session, marked, reason }。
   */
  async function jumpToMemorySource(item) {
    const source = item && item.source ? item.source : {};
    const file = String(source.file || "");
    if (!file) { showToast("这条记忆没有记录来源"); return { found: false, reason: "no-source" }; }
    const model = liveState.chatModel;
    if (!model) { showToast("对话还没准备好"); return { found: false, reason: "no-model" }; }

    // 文件名比对要容忍后缀差异：会话表里的名字是去掉 .jsonl 的，
    // 而记忆里存的是原始文件名（带 .jsonl）。真踩过这个坑 —— 不修就永远找不到来源对话。
    const baseName = (value) => String(value || "").replace(/\.jsonl$/i, "");
    const same = (candidate) => candidate === file || baseName(candidate) === baseName(file);
    const findTarget = () => model.getSessions().find((session) => same(session.fileName) || same(session.id)) || null;

    let target = findTarget();
    if (!target) {
      // 内存里没有就重拉一次：来源那段可能已经归档，不在主列表里。
      try { await model.refresh(); } catch (_) { /* 拉取失败就按找不到处理 */ }
      target = findTarget();
    }
    if (!target) {
      showToast("那段来源对话已经不在了（可能被删除）");
      return { found: false, reason: "missing", wanted: file };
    }

    closeMemoryPanel();
    const alreadyOpen = liveState.activeSession && same(liveState.activeSession.fileName);
    if (!alreadyOpen) {
      try {
        await selectChat(target.id || target.fileName);
      } catch (_) {
        showToast("打开那段对话失败");
        return { found: true, marked: false, reason: "select-failed" };
      }
    }
    const marked = markSourceMessage(item, source);
    if (!marked) showToast(alreadyOpen ? "没能定位到那条消息（可能已被编辑或删除）" : "对话已打开，但没能定位到那条消息（可能已被编辑或删除）");
    return { found: true, marked: marked, session: target.fileName, reopened: !alreadyOpen };
  }

  /** 在已渲染的消息里标出源消息：先按内容找，找不到再用序号兜底。 */
  function markSourceMessage(item, source) {
    const container = document.querySelector("#dynamicMessages") || document.querySelector("#chatScroll");
    if (!container) return false;
    const rows = Array.from(container.querySelectorAll(".message-row"));
    const wanted = String(item.content || "").trim();
    const index = Number(source.messageIndex);
    let hit = wanted ? rows.find((row) => row.textContent.indexOf(wanted) >= 0) : null;
    if (!hit && Number.isFinite(index) && index >= 0 && rows[index]) hit = rows[index];
    if (!hit) return false;
    hit.classList.add("memory-source-hit");
    hit.scrollIntoView({ block: "center" });
    window.setTimeout(() => hit.classList.remove("memory-source-hit"), 2600);
    return true;
  }

  async function saveMemoryEntries(entries) {
    const bookName = liveState.memoryBook;
    if (!bookName) return false;
    let data = { entries: {} };
    try {
      const existing = await window.STApi.getWorld(bookName);
      if (existing && existing.entries) data = existing;
    } catch (_) { /* 新书 */ }
    try {
      await window.STApi.editWorld(bookName, Object.assign({}, data, { entries }));
    } catch (_) {
      showToast("记忆保存失败，原内容已保留");
      return false;
    }
    await loadBooks().catch(() => {});
    return true;
  }

  async function editMemoryEntry(key, node) {
    const current = (liveState.memoryRows || []).filter((row) => row.key === key)[0];
    if (!current || !node) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rw-field memory-edit";
    input.value = current.content;
    input.maxLength = 500;
    node.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const text = String(input.value || "").trim();
      if (!text || text === current.content) { renderMemoryList(); return; }
      const result = window.ROLEWORLD_MEMORY_CORE.updateEntry(liveState.memoryEntries || {}, key, text);
      if (!result.ok) { renderMemoryList(); return; }
      if (await saveMemoryEntries(result.entries)) showToast("记忆已更新");
      await openMemoryPanel();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { event.preventDefault(); done = true; renderMemoryList(); }
    });
  }

  async function deleteMemoryEntry(key) {
    const result = window.ROLEWORLD_MEMORY_CORE.removeEntry(liveState.memoryEntries || {}, key);
    if (!result.ok) { renderMemoryList(); return; }
    if (await saveMemoryEntries(result.entries)) showToast("已删除，后续对话不会再带上它");
    await openMemoryPanel();
  }

  // 手动加一条：用面板内联输入，不用 window.prompt（原生弹窗在桌面端很难看，也不可测）。
  function addMemoryEntry() {
    const list = document.querySelector("#memoryList");
    if (!list) return;
    if (list.querySelector(".memory-add-row")) return;
    const row = document.createElement("div");
    row.className = "memory-add-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rw-field memory-edit";
    input.maxLength = 500;
    input.placeholder = "要记住什么？例如：玩家不喜欢咖啡";
    input.setAttribute("aria-label", "新增记忆内容");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "plain-button";
    confirm.textContent = "记下";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "plain-button";
    cancel.textContent = "取消";
    row.appendChild(input);
    row.appendChild(confirm);
    row.appendChild(cancel);
    list.insertBefore(row, list.firstChild);
    input.focus();

    const close = () => { row.remove(); };
    cancel.addEventListener("click", close);
    input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } });
    const commit = async () => {
      const trimmed = String(input.value || "").trim();
      if (!trimmed) { close(); return; }
      confirm.disabled = true;
      const result = window.ROLEWORLD_MEMORY_CORE.applyMemories(liveState.memoryEntries || {}, [trimmed], {
        max: autoMemoryMax(),
        origin: window.ROLEWORLD_MEMORY_CORE.ORIGIN.USER,
        // 手动加的记忆：来源写"你自己写的"，不编造来自哪段对话。
        source: { origin: window.ROLEWORLD_MEMORY_CORE.ORIGIN.USER, file: "", messageIndex: null },
      });
      if (!result.added) { showToast("这条已经记过了"); close(); return; }
      if (await saveMemoryEntries(result.entries)) {
        showToast(result.removed.length ? `已记下（挤掉最旧的 ${result.removed.length} 条）` : "已记下");
      }
      await openMemoryPanel();
    };
    confirm.addEventListener("click", () => { commit().catch(() => {}); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commit().catch(() => {}); }
    });
  }

  function closeMemoryPanel() {
    closeCharacterPanel();
  }

  /* ---------- 角色面板：设定 / 记忆 / 关系（2026-09-13 合并三个入口） ----------
   * 为什么要合并：以前要改"这个角色的东西"，得先分清三个地方 ——
   *   「角色记忆」弹窗（模型自己记的）、右侧「记忆书」栏（你手写的）、「关系档案」弹窗（伴侣模式）。
   * 用户的原话是"用户需要理解几个相近概念，才能修改同一个角色的相关信息"。
   * 现在它们是一个面板的三个分页，入口只有两个：点角色名（默认设定页）、顶栏「记忆」（记忆页）。
   * **数据与能力一个都没动**：三个分页用的还是原来那些渲染函数与存储。
   */
  const CHARACTER_TABS = ["setup", "memories", "relationship"];

  function characterPanel() {
    return document.querySelector("#characterPanel");
  }

  /** 切分页（不动数据，只动显示与标题）。 */
  function setCharacterPanelTab(tab) {
    const next = CHARACTER_TABS.indexOf(tab) >= 0 ? tab : "setup";
    liveState.characterTab = next;
    // 分页内容要异步读：`data-ready` 记"哪一页已经填好了"，
    // 界面上的"正在读取…"和自动化检查都看它，不用猜时间。
    const surface = characterPanel();
    if (surface) surface.dataset.ready = "";
    document.querySelectorAll("[data-character-tab]").forEach((button) => {
      const on = button.dataset.characterTab === next;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll("[data-character-pane]").forEach((pane) => {
      pane.hidden = pane.dataset.characterPane !== next;
    });
    const hint = document.querySelector("#characterPanelHint");
    if (hint) hint.textContent = CHARACTER_TAB_HINTS[next] || "";
    return next;
  }

  /** 分页内容填完之后打标记（见 setCharacterPanelTab 的说明）。 */
  function markCharacterPaneReady(tab) {
    const surface = characterPanel();
    if (surface) surface.dataset.ready = tab;
  }

  /** 就绪标记必须跟着**实际生效的那一页**，不能跟着"本来想切的那一页"。
   *  为什么：读盘过程中这一页可能被改切 —— 没有有效角色时 `loadCompanionPane`
   *  会改回设定页（并弹一句"先选一个角色"）。此时若仍标记原来的页，
   *  活动页与 `data-ready` 就不一致，"这一页读好了没"这个唯一信号从此不可信
   *  （2026-09-17 真实浏览器实测：`ready=relationship` 而实际显示 `setup`）。 */
  function markActivePaneReady(fallbackTab) {
    const active = CHARACTER_TABS.indexOf(liveState.characterTab) >= 0 ? liveState.characterTab : fallbackTab;
    markCharacterPaneReady(active);
  }

  /**
   * 切到某一页并把内容读出来（标签按钮与"去记忆/去关系"按钮共用这一条路）。
   *
   * ⚠ **`data-ready` 必须无论如何都打上**：这个标记是"这一页填好了"的唯一信号，
   *   界面上的"正在读取…"和自动化检查都看它。读盘那一步只要有一次不返回（IndexedDB 抖动、
   *   内容包清单被别的请求堵住），await 就会一直挂着 —— 面板永远停在"正在读取"，
   *   用户看到的是死界面，自动化看到的是 20 秒超时（2026-09-16 整轮跑时抓到过：
   *   同一段代码单跑是好的，整轮跑到这里就卡住，现场里 `data-ready` 还停在上一页）。
   *   所以两件事都做：① 包 try/catch；② 给读盘**一个有上限的等待**（超时就当没读到，
   *   面板照样能用、能关）。这两条不是"掩盖问题"：读失败时页面上会写明"这一页的内容没读出来"。
   */
  const CHARACTER_PANE_TIMEOUT_MS = 8000;

  /** 角色面板"第几次打开"的序号：只有最后一次能打 `data-ready`（见 openCharacterPanel 的说明）。 */
  let characterPanelSequence = 0;

  /** 给一次读盘加一个有上限的等待：超时就当没读到（页面上会写明"没读出来"），面板照样能用。 */
  async function withPaneTimeout(promise, label) {    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || "这一页") + "读取超时（"
        + Math.round(CHARACTER_PANE_TIMEOUT_MS / 1000) + " 秒没读回来）")), CHARACTER_PANE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function showCharacterTab(tab) {
    const next = setCharacterPanelTab(tab);
    // ⚠ 切页也要领同一个序号。打开面板那一次读盘可能很慢（内容包清单被别的请求堵住），
    //   它后回来时序号**仍然是最新的**，就会把刚切过去那一页的 `data-ready` 盖成旧页 ——
    //   标记一错，界面上的"正在读取…"永远不消失，自动化卡到超时
    //   （2026-09-17 整轮跑实测：活动页=relationship 而 ready=setup）。
    const sequence = ++characterPanelSequence;
    try {
      const load = next === "memories" ? loadMemoryPane() : (next === "relationship" ? loadCompanionPane() : null);
      if (load) await withPaneTimeout(load, CHARACTER_TAB_HINTS[next] ? next : next);
    } catch (error) {
      const pane = document.querySelector(`[data-character-pane="${next}"]`);
      if (pane && !pane.querySelector(".request-peek-empty")) {
        const note = document.createElement("p");
        note.className = "request-peek-empty";
        note.textContent = "这一页的内容没读出来：" + String((error && error.message) || error).slice(0, 120);
        pane.appendChild(note);
      }
    }
    if (sequence === characterPanelSequence) markActivePaneReady(next);
    return next;
  }

  const CHARACTER_TAB_HINTS = {
    setup: "这是角色卡里写的设定（只读）。要换成别的角色卡，用「设置 → 角色管理」里的导入或 AI 创建。",
    memories: "上面是模型自己记的（自动记忆），下面是你手写的记忆书。每条都能看来源、确认、改写、删除。",
    relationship: "关系档案是你亲手写的真实信息，和模型自己记的分开存；伴侣模式只对这个角色生效。",
  };

  /** 设定页：把角色卡的原文摊开给用户看（只读），旁边给出能改的那几项在哪。 */
  async function renderCharacterSetup() {
    const pane = document.querySelector("#characterPaneSetup");
    if (!pane) return;
    pane.textContent = "";
    const entry = activeCharacterEntry();
    if (!entry || !entry.avatar) {
      const empty = document.createElement("p");
      empty.className = "request-peek-empty";
      empty.textContent = "还没有选中的角色。";
      pane.appendChild(empty);
      return;
    }
    // 角色卡的正文要从数据层读（liveState.characters 里只有 avatar 与名字）。
    // 读不到就说读不到，不编内容。
    let card = (liveState.cardCache && liveState.cardCache.get(entry.avatar)) || null;
    if (!card && window.STApi && typeof window.STApi.getCharacter === "function") {
      try {
        card = await window.STApi.getCharacter(entry.avatar);
        if (card && liveState.cardCache) liveState.cardCache.set(entry.avatar, card);
      } catch (_) { card = null; }
    }
    if (pane.dataset.avatar !== entry.avatar) { pane.dataset.avatar = entry.avatar; }
    const data = (card && (card.data || card)) || {};
    const rows = [
      ["名字", (card && (card.name || data.name)) || entry.charName || entry.avatar],
      ["它是谁", data.description || ""],
      ["性格", data.personality || ""],
      ["场景", data.scenario || ""],
      ["开场白", data.first_mes || ""],
      ["示例对话", data.mes_example || ""],
    ];
    const tags = Array.isArray(data.tags) ? data.tags.filter(Boolean) : [];
    if (tags.length) rows.push(["标签", tags.join("、")]);
    rows.push(["角色卡文件", entry.avatar]);
    // 内置包里来的，还是自己导入的。内置角色会在内容包更新时自动刷新，说清楚免得用户以为能改。
    let pack = null;
    try {
      const packs = window.RoleWorldPacks && typeof window.RoleWorldPacks.listPacks === "function"
        ? await window.RoleWorldPacks.listPacks() : [];
      pack = (Array.isArray(packs) ? packs : []).find((item) => {
        const files = (item && item.files) || {};
        return Array.isArray(files.characters) && files.characters.includes(entry.avatar);
      }) || null;
    } catch (_) { pack = null; }
    rows.push(["来源", pack
      ? `内置内容包「${pack.name || pack.id || "内置"}」（内容包更新时会自动刷新，你的对话与记忆不受影响）`
      : "导入的角色卡"]);
    if (!card) rows.push(["提示", "读不到这张角色卡的正文（可能还没从内容包同步）。这里不显示猜测内容。"]);

    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "character-setup-row";
      const key = document.createElement("strong");
      key.textContent = label;
      const body = document.createElement("div");
      const text = String(value === undefined || value === null ? "" : value).trim();
      if (text) body.textContent = text;
      else { body.textContent = "（角色卡里没写）"; body.classList.add("is-empty"); }
      row.append(key, body);
      pane.appendChild(row);
    });

    // 能改的那几项：都指到已有的入口，不在这里另做一套。
    const actions = document.createElement("div");
    actions.className = "character-setup-actions";
    const memoryButton = document.createElement("button");
    memoryButton.type = "button";
    memoryButton.className = "plain-button";
    memoryButton.textContent = "看它的记忆";
    memoryButton.setAttribute("data-action", "character-tab-memories");
    const relationButton = document.createElement("button");
    relationButton.type = "button";
    relationButton.className = "plain-button";
    relationButton.textContent = "关系 / 伴侣模式";
    relationButton.setAttribute("data-action", "character-tab-relationship");
    actions.append(memoryButton, relationButton);
    pane.appendChild(actions);

    const note = document.createElement("p");
    note.className = "character-setup-note";
    note.textContent = "角色的语言、是否显示在左侧栏，在「设置 → 角色管理」里按角色改；"
      + "记忆的开关与条数上限在「设置 → 记忆」（对所有角色生效）。";
    pane.appendChild(note);
  }

  /** 打开角色面板。tab 省略时沿用上次那个分页（默认设定）。 */
  async function openCharacterPanel(tab) {
    const surface = characterPanel();
    if (!surface) return;
    // ⚠ 每一次打开领一个序号，**只有最后一次**能打 `data-ready` 标记。
    //   为什么：读盘是异步的，用户可以"点记忆 → 立刻点关系档案"；先发的那个后回来时，
    //   它照样会打上自己的标记 —— 于是界面停在关系页、标记却写着 memories，
    //   "这一页读好了没"这个唯一信号从此不可信（2026-09-16 实测：自动化卡在 20 秒超时，
    //   现场就是 `活动页=relationship` 而 `ready=memories`）。
    const sequence = ++characterPanelSequence;
    // 「点角色名没反应」是这个项目反复出现过的一类 bug（0.1.18 的 hidden 没人摘、
    // 0.1.44 的窄屏条件永远为假）。所以这里**无论如何都要让面板露出来**：
    // 内容读取失败只是少点东西，不能连面板都不出现。填入失败的事实也照实写出来。
    try {
      const entry = activeCharacterEntry();
      const title = document.querySelector("#characterPanelTitle");
      if (title) title.textContent = entry && entry.avatar ? (entry.charName || entry.name || "角色") : "角色";
      // 两个入口各自落在固定的页：点角色名 = 设定（角色的"家"），顶栏「记忆」= 记忆。
      const next = setCharacterPanelTab(tab || "setup");
      // **先露面，再读内容**：读角色卡 / 记忆书 / 内容包清单都要走网络或数据库，
      // 万一哪一次不返回（实测：内容包清单的请求被前面的流式请求堵住时就会挂住），
      // "先读完再显示"就会变成"点了没反应"。各分页填好之后会打 data-ready 标记。
      surface.hidden = false;
      window.TASK25C_UI?.rememberDialogFocus?.("characterPanel");
      window.TASK25C_UI?.syncOverlayScrollLock?.();
      try {
        // ⚠ 每一样读盘都**有上限**：只要有一次不返回（IndexedDB 抖动、内容包清单被别的请求堵住），
        //   这里就会永远挂着 —— 面板停在"正在读取"、`data-ready` 也不会打上（2026-09-16 整轮实测）。
        await withPaneTimeout(renderCharacterSetup(), "角色设定");
        if (next === "memories") await withPaneTimeout(loadMemoryPane(), "记忆");
        if (next === "relationship") await withPaneTimeout(loadCompanionPane(), "关系档案");
      } catch (error) {
        const pane = document.querySelector(`[data-character-pane="${next}"]`);
        if (pane) {
          const note = document.createElement("p");
          note.className = "request-peek-empty";
          note.textContent = "这一页的内容没读出来：" + String((error && error.message) || error).slice(0, 120);
          pane.textContent = "";
          pane.appendChild(note);
        }
      }
      if (sequence === characterPanelSequence) markActivePaneReady(next);
    } finally {
      surface.hidden = false;
    }
  }

  function closeCharacterPanel() {
    const surface = characterPanel();
    if (surface) surface.hidden = true;
    const memory = document.querySelector("#memoryPanel");
    if (memory) memory.hidden = true;
    const companion = document.querySelector("#companionDialog");
    if (companion) companion.hidden = true;
    liveState.companionEntry = null;
    window.TASK25C_UI?.syncOverlayScrollLock?.();
    window.TASK25C_UI?.restoreDialogFocus?.("characterPanel");
  }

  async function loadCompanionPane() {
    const entry = activeCharacterEntry();
    const subtitle = document.querySelector("#companionSubtitle");
    if (!entry || !entry.avatar) {
      showToast("先选一个角色，再写关系档案");
      setCharacterPanelTab("setup");
      return;
    }
    liveState.companionEntry = entry;
    // ⚠ 读档失败也要把面板**标成就绪**：读一次盘抛异常就把这一页永远停在"正在读取…"，
    //   用户看到的是死界面，而原因只是一次 IndexedDB 抖动（2026-09-16 端到端用例抓到过：
    //   同一段代码单跑是好的，整轮跑到这里就卡住）。失败时说清"读不到"，让人还能改。
    let profile = null;
    try {
      profile = await loadCompanion(entry);
    } catch (error) {
      const box = document.querySelector("#companionError");
      if (box) {
        box.textContent = "读不到这个角色的关系档案：" + String((error && error.message) || error).slice(0, 100)
          + "。下面的内容是从空白开始的，改完保存会覆盖掉原来那份。";
        box.hidden = false;
      }
      profile = null;
    }
    if (subtitle) {
      subtitle.textContent = `${entry.charName || entry.name}：这部分是你自己写的，模型不能改口；`
        + "它和「记忆」页的东西分开存，清空记忆也不会动它。开关只对这个角色生效。";
    }
    fillCompanionForm(profile, entry);
  }

  /** 这个角色**能不能开伴侣模式**（内置小说人物不给开）—— 规则在 companion-core 里判一次。 */
  function companionAccessFor(entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !entry) return { allowed: false, reason: "先选一个角色。" };
    return core.companionAccess({ isBuiltin: isBuiltinAvatar(entry.avatar) });
  }

  /** 这个角色**能不能用语音**（规则只在 companion-core.voiceAccess 一处：内置小说人物不发语音）。
   *  读的是同步缓存 companionCache（声明在文件顶部，启动时就能安全读）；档案本身是异步的，
   *  读不到就当"还没有档案" —— 默认档案不影响资格判定。 */
  function voiceEligibilityFor(entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !entry) return { allowed: false, code: "NO_CHARACTER", reason: "先选一个角色。" };
    const cached = companionCache && companionCache.avatar === entry.avatar ? companionCache.profile : null;
    return core.voiceAccess({ isBuiltin: isBuiltinAvatar(entry.avatar), avatar: entry.avatar, profile: cached || {} });
  }

  /**
   * 某个角色（**不一定是当前这个**）能不能发语音 —— 读它自己的伴侣档案再判。
   *
   * 跟 `voiceEligibilityFor` 的分工：那个读同步缓存（只装当前角色），给"菜单点开一瞬间"用；
   * 这个异步读盘，给设置面板一行一行列的时候用。
   * 判定规则本身仍然只有 `companion-core.voiceAccess` 一处 —— 这里不写第二套。
   */
  async function voiceEligibilityOfCard(card) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const avatar = String((card && card.avatar) || "");
    if (!core || !avatar) return { allowed: false, code: "NO_CHARACTER", reason: "先选一个角色。" };
    let stored = null;
    try { stored = await window.RoleWorld.store.getKV(companionKey({ avatar }), null); } catch (_) { stored = null; }
    // ⚠ avatar 一定要带上：voiceAccess 拿它判"有没有角色"（NO_CHARACTER）。
    //   漏掉它时每个角色都会被判成"先选一个角色"，现象是设置里的语音页**一行都不列**
    //   而空状态写着"先选一个角色"（2026-09-16 实测踩到）。
    return core.voiceAccess({ isBuiltin: isBuiltinAvatar(avatar), avatar: avatar, profile: stored || {} });
  }

  /**
   * 把当前角色的伴侣档案读进同步缓存。
   * 为什么需要它：消息菜单、顶栏「当前方式」、语音入口都要**同步**知道"这个角色是什么方式"
   * （它们是点开那一瞬间现算的），而档案是异步读的。所以切角色/打开对话时先热一份。
   *
   * ⚠ 这里必须**强制重读**（先清缓存）：`loadCompanion` 命中缓存就直接返回，
   *   "切走再切回来"时不会重新读盘 —— 而档案可能已经被别处改过（导入存档、另一个标签页、
   *   面板里保存）。踩过一次：测试里刚把方式改成「日常聊天」，顶栏还写着「剧情对话」
   *   （2026-09-16，端到端用例抓到的）。
   */
  async function primeCompanionCache(entry) {
    if (!entry || !entry.avatar) return null;
    companionCache = { avatar: "", profile: null };
    try { return await loadCompanion(entry); } catch (_) { return null; }
  }

  /* ---------- 伴侣模式：关系档案（用户亲手写的那一份） ----------
   * 和「角色记忆」是两件事，所以分开存：
   *   - 角色记忆：模型从对话里自己记的，存在该角色的记忆书里，可以一键清空；
   *   - 关系档案：你亲手写的关系 / 称呼 / 共同经历 / 起点，存在 kv 的 companion:<avatar>，
   *     清空记忆不会动它，删记忆也不会误伤它。
   * 打开后每轮多带一小段系统提示（companion-core.js 的 buildCompanionBlock），
   * 里面除了关系本身，还有那几条硬规矩：不编共同回忆、不内疚留人、不索取陪伴。
   */
  const COMPANION_KEY_PREFIX = "companion:";
  const COMPANION_CHECK_WINDOW = 20;
  // companionCache 声明在文件顶部（启动时就要同步读它，放这里会撞暂时性死区）。

  function companionKey(entry) {
    return COMPANION_KEY_PREFIX + ((entry && entry.avatar) || "");
  }

  /** 读这个角色的关系档案。读不到就是一份空档案（默认关闭），不编内容。 */
  async function loadCompanion(entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core) return null;
    if (!entry || !entry.avatar) return core.defaultProfile();
    if (companionCache.avatar === entry.avatar && companionCache.profile) return companionCache.profile;
    let stored = null;
    try { stored = await window.RoleWorld.store.getKV(companionKey(entry), null); } catch (_) { stored = null; }
    const profile = core.normalizeProfile(stored);
    companionCache = { avatar: entry.avatar, profile: profile };
    return profile;
  }

  async function saveCompanion(entry, profile) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !entry || !entry.avatar) return null;
    const next = core.normalizeProfile(profile);
    await window.RoleWorld.store.setKV(companionKey(entry), next);
    companionCache = { avatar: entry.avatar, profile: next };
    return next;
  }

  /** 伴侣段落的语言：**跟这个角色这一轮实际说的语言一致**。
   *  玩家强制了中文/英文就用那个（否则整段中文规则会被英文段落带跑，反过来也一样）；
   *  没强制就看卡片语言 —— 英文卡要拿英文的伴侣段落。 */
  function companionLangFor(entry) {
    const forced = languageForAvatar(entry && entry.avatar);
    if (forced === "zh" || forced === "en") return forced;
    const card = (liveState.cardCache && entry && liveState.cardCache.get(entry.avatar)) || null;
    try {
      return window.TASK22_CORE.cardLanguageOf(card) === "en" ? "en" : "zh";
    } catch (_) { return "zh"; }
  }

  /** 这一轮要额外带上的陪伴段落；关掉就是空串。发送路径与面板预览共用它。 */
  function companionBlockFor(entry, profile) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !profile || profile.enabled !== true) return "";
    // 内置小说人物不给开伴侣（2026-09-14 用户拍板）。老存档里可能开着 —— 这里不注入，也不删档案。
    if (entry && isBuiltinAvatar(entry.avatar)) return "";
    try {
      return core.buildCompanionBlock(profile, { lang: companionLangFor(entry) });
    } catch (_) { return ""; }
  }

  /**
   * 「微信式聊天（软件聊天 / 无动作）」这一档额外要带的两段提示词（2026-09-14 用户拍板）。
   *
   * 自定义角色选择 plain 即生效，不要求开启伴侣或语音。
   * 内置小说人物与 action/缺省档位不加；语音指令另受当前语音能力控制。
   *
   * 两件事，都要**写得足够死**（用户 2026-09-14 反馈：模型还是会用（ ）描述动作，
   * 而且语音发得太少 —— 要求不写清楚，模型就会按"写小说"的习惯来）：
   *   ① **完全模仿真实微信聊天**：只有你会真的打出去的字，不许括号、不许旁白、不许动作；
   *   ② 想"发一条语音"时，在回复里单独一行写 `[[语音]]`（跟 `[[表情: …]]` 同一套路：
   *      前端剥掉标记、把它渲染成一条语音消息，**不破坏流式**，也不引入 function calling）；
   *      短句**优先发语音**（用户要求频率高一点），长内容打字。
   */
  function plainChatBlock(entry, profile) {
    if (!isPlainChatFor(entry, profile)) return "";
    const lang = companionLangFor(entry);
    const lines = lang === "en"
      ? [
        "[Chat style: a real one-on-one WeChat-style chat]",
        "You are chatting with the user in a messaging app. EVERY message you send IS a WeChat message —",
        "exactly the characters you would type into the box and hit send. Not a novel, not a script.",
        "",
        "Good replies (you may send several in a row, one per paragraph, blank line between):",
        "hey",
        "was busy, just saw this",
        "go ahead",
        "",
        "Never like this (these are not chat messages):",
        "(turns off the last lamp) Closed.",
        "He shrugged. This phone is hopeless for typing.",
        "*smiles* I'm here.",
        "\"Closed.\"",
        "",
        "Hard rules:",
        "· NEVER use brackets — no ( ), no （ ） — no asterisks, no narration, actions, gestures, inner monologue.",
        "· NEVER put quotation marks around your own words — nobody types like that in a chat.",
        "· Never write your own name or \"he/she\" doing something. Only the words YOU are saying.",
        "· One short spoken line per paragraph, casual and typo-tolerant, the way a thumb types.",
        "· No headings, no bullet lists, no written-language phrasing.",
        "· One message = one paragraph (blank line between). HOW MANY is your call — a single line is",
        "  completely normal, and so are several in a row. Judge it from what is actually being said:",
        "  news that deserves a beat, an afterthought, a separate answer, an interruption — split it;",
        "  one calm sentence — just send one. NEVER pad a short thought into several lines to look busy.",
      ]
      : [
        "【聊天方式：微信式聊天】",
        "你现在是在**微信里**跟对方一对一聊天。你回的**每一条都是微信消息** ——",
        "就是你会打进输入框、然后按发送的那几个字。不是小说，不是剧本，不是旁白。",
        "",
        "✓ 像这样回（可以连着几条，一条一段，中间空一行）：",
        "在的",
        "刚在忙，没看手机",
        "你说吧",
        "",
        "✗ 不要这样回（这不是微信消息）：",
        "（把最后一盏灯关了，只留门口那点光）关门了。",
        "他摊了下手，这手机连打字都费劲。",
        "*微笑* 在的。",
        "“关门了。”",
        "",
        "硬规矩：",
        "· **绝对不要用括号**（（）和 () 都不行），不要星号，不要旁白、动作、神态、表情、心理描写；",
        "· **不要给自己的话加引号** —— 微信里没人这么打字；",
        "· 不要写自己的名字，也不要写「他/她做了什么」—— 只写**你**说出口的那句话；",
        "· 一句一行，短句、口语，像用拇指敲出来的：可以有语气词、可以省略、可以不完整；",
        "· 不要小标题、不要分条罗列、不要书面语。",
        "写之前先问自己一句：**这句话我会真的打进微信、按发送吗？** 不会，就不要写它。",
        "**发几条由你按当场的情况决定**：一条消息 = 一段（两段之间空一行）。"
          + "只回一条**完全正常**，连着回两三条也正常 —— 看内容："
          + "值得喘一口气的消息、临时想起的补充、分开答的两件事，就分开发；"
          + "一句话说完的，就发一条。**绝不要为了显得热闹把一句话拆成好几条。**",
      ];
    // 聊天风格不依赖声音；只有此刻能出声时才附加语音媒介指令。
    if (!isVoiceEnabledNow() || !voiceCapability().canSpeak || !voiceEligibilityFor(entry).allowed) {
      return lines.join("\n");
    }
    lines.push(lang === "en"
      ? "Voice notes: if you would rather SAY it than type it, put a line containing only [[voice]] in your reply."
        + " The app turns that reply into a voice message (the other side taps to play it)."
        + " Prefer a voice note whenever the reply is short (about 60 characters or less) —"
        + " people send voice notes all the time in a real chat. Type it instead when it is long,"
        + " or when they may need to read it again (addresses, steps, lists). At most one voice note per reply."
      : "发语音：想**直接说给对方听**、而不是打字，就在回复里单独一行写 [[语音]]，"
        + "应用会把这条回复变成一条语音消息（对方点一下才播）。"
        + "**短句（大约 60 字以内）优先发语音** —— 真人在微信里就是顺手按住说话，不用省着；"
        + "长内容、或者对方可能需要回头看的东西（地址、步骤、清单）就打字。**一轮最多一条语音。**");
    // 几个开关的**优先级**写死在这里（用户 2026-09-14：明确优先级，避免多个开关互相覆盖）：
    //   ① 用户这一轮点名要语音（「下一条发语音」）→ 一定发，且只说一句短的（见 voiceRequestBlock）；
    //   ② 内容太长（超过上限）→ 一定不发（**不是**截断）；
    //   ③ 语言对不上角色设定 → 一定不发（不交给错误语言的音色）；
    //   ④ 「短句优先发语音」是**倾向**，不是命令：长内容、需要回看的内容照样打字。
    // 这一轮最多一条语音，所以不存在"连着好几条语音"的可能（频率偏好不会和它冲突）。
    lines.push(lang === "en"
      ? "Priority: if the user explicitly asked for a voice note this turn, send exactly that (one short line)."
        + " Never send a voice note when the text is too long, or when it is not in this character's language."
      : "优先级：对方这一轮明确要了语音，就照做（只发一句短的）；"
        + "内容太长、或者语言跟角色设定对不上时，**一定不要**发语音（宁可打字，也绝不截断、绝不用错音色）。");
    return lines.join("\n");
  }

  /**
   * **这一轮要不要角色发语音**（2026-09-14 用户要求：调试阶段要能自己选）。
   *
   * 为什么要有这个开关：语音本来由模型自己决定（写 `[[语音]]`），但调试/试听时
   * "它这次到底发不发"完全看运气 —— 用户要的是"我说了算"。
   *
   * 打开之后做两件事（缺一不可）：
   *   ① 往这一轮的提示词里加一句"这一轮请发一条语音、只发一句短的"；
   *   ② 就算模型没写 `[[语音]]`，也**照样**把它那句话做成语音消息（否则开关形同虚设）。
   * 唯一不妥协的是**长度**：超过 120 字仍然不发语音（不截断）—— 那种情况会明确告诉用户为什么，
   * 而不是悄悄变回文字。
   */
  function voiceRequestBlock(entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !entry || !entry.avatar) return "";
    const lang = companionLangFor(entry);
    return lang === "en"
      ? "[This reply: a voice note] Say it out loud instead of typing — ONE short spoken line"
        + " (about 60 characters or less), the way people send voice messages. Write nothing else:"
        + " no narration, no brackets, no second paragraph."
      : "【这一轮：发语音】对方在等你**说**一句，而不是打字：只说**一句短话**（大约 60 字以内），"
        + "像微信里顺手按住说话那样。除了这一句什么都不要写 —— 不要旁白、不要括号、不要第二段。";
  }

  /* ==================================================================== *
   * 输入框旁的「角色语音」入口 + 开启面板（2026-09-16 按产品设计 §7 重写）
   *
   * 用户实测的问题：「手机版语音一直是灰的，根本不会开」。根因不是开关坏了，而是
   *   · 那个入口以前只有一个麦克风图标，看不到字就不知道它能做什么；
   *   · 不能用时它被**禁用**，用户只看到"灰的"；
   *   · 真正差的是一张体验卡，而手机端补卡的路藏在 我的 → 设置 → 连接方式 三层里。
   * 所以现在：入口**一直可见、一直可点、带文字**；点下去一次把三件事做完（见 openVoiceSetup）。
   * ==================================================================== */
  window.__rwVoiceSheetBuild = "2026-09-16-voice-sheet-2";

  /**
   * 输入框旁那个**带文字的角色语音入口**。
   *
   * 设计要点（都来自文档，别改回去）：
   *   · **一直可见**（只要当前角色不是内置小说人物）—— 藏起来等于没有；
   *   · **带文字**，不用麦克风图标（那会被理解成"给我自己录音"）；
   *   · 未开启时显示「**开启角色语音**」，点了走"一次开启"面板（见 openVoiceSetup）；
   *   · 已开启时显示「**角色回复：自动 ▾**」（自动 / 下条语音 / 下条文字），点开是小面板；
   *   · 当前角色是内置小说人物时**照样显示**，但点一下直说"小说人物不发语音、怎么办"。
   */
  /** 角色回复方式（**持久**三档）：auto = 模型自己决定 / voice = 一直发语音 / text = 一直打字。
   *
   *  为什么改成持久：用户 2026-09-18 原话「选择下一条是语音还是文字还是自动应该要持续，
   *  不要每次重置」。以前是两个**一次性**的内存开关（`replyAsVoice` / `replyAsTextNext`），
   *  用完即清、开启语音时还会被重置；而且 `replyAsTextNext` **只被赋值、从来没有被读过**
   *  —— 「下条文字」那一项点了完全没用（只弹一句 toast）。
   *  现在只留一个**存进本地设置**的模式值（`voice_reply_mode`），界面文案与所有判定都读它。 */
  const VOICE_REPLY_MODES = ["auto", "voice", "text"];
  function voiceReplyMode() {
    const local = String(liveState.voiceReplyMode || "");
    if (VOICE_REPLY_MODES.indexOf(local) >= 0) return local;
    const snapshot = window.__rwVoiceSettingsSnapshot || {};
    const stored = String(snapshot.voice_reply_mode || "auto");
    return VOICE_REPLY_MODES.indexOf(stored) >= 0 ? stored : "auto";
  }

  function setVoiceReplyMode(mode) {
    const next = VOICE_REPLY_MODES.indexOf(String(mode)) >= 0 ? String(mode) : "auto";
    liveState.voiceReplyMode = next;
    try {
      const snapshot = window.__rwVoiceSettingsSnapshot;
      if (snapshot) snapshot.voice_reply_mode = next;
      if (window.RoleWorld && typeof window.RoleWorld.saveLocalSettings === "function") {
        // 落盘失败**不静默**：这一轮仍按用户选的走，但要说明"没记住"。
        window.RoleWorld.saveLocalSettings({ voice_reply_mode: next }).catch(() => {
          showToast("这个选择这次有效，但没能保存到本机（下次打开可能要重选）。");
        });
      }
    } catch (_) { /* 存不下不影响这一轮 */ }
    updateReplyVoiceToggle();
  }

  /** 「这一轮一定要发语音」的一次性要求（来自"开启并让下一条发语音"那一步）。
   *  与持久模式分开：它只该影响这一条，不改变用户的长期选择。 */
  function voiceReplyRequestedNow() {
    return liveState.replyVoiceOnce === true || voiceReplyMode() === "voice";
  }

  function updateReplyVoiceToggle() {
    const button = document.querySelector("#replyVoiceToggle");
    if (!button) return;
    const entry = activeCharacterEntry();
    const eligibility = voiceEligibilityFor(entry);
    const cap = voiceCapability();
    const enabled = isVoiceEnabledNow();
    const ready = enabled && cap.canSpeak && eligibility.allowed === true;
    liveState.voiceReady = ready;

    const label = button.querySelector(".rw-voice-label");
    const setLabel = (text) => { if (label) label.textContent = text; else button.textContent = text; };

    button.hidden = false;
    button.disabled = false;               // 永远可点：点了要么开、要么说明为什么不能
    button.classList.toggle("is-on", ready && voiceReplyMode() === "voice");
    button.classList.toggle("is-off", !ready);
    button.setAttribute("aria-expanded", liveState.voiceMenuOpen === true ? "true" : "false");

    if (!eligibility.allowed) {
      setLabel("角色语音");
      button.title = eligibility.reason || "这个角色不能发语音。";
    } else if (!enabled || !cap.canSpeak) {
      setLabel("开启角色语音");
      button.title = cap.canSpeak
        ? "打开后，角色可以用语音消息回你（点这里开启，一步就好）"
        : ("还差一步：" + (cap.reason || "需要体验卡才能合成语音") + "（点这里处理）");
    } else {
      const mode = voiceReplyMode();
      setLabel(mode === "voice" ? "角色回复：一直语音" : (mode === "text" ? "角色回复：一直文字" : "角色回复：自动"));
      button.title = "角色回复方式：自动 / 一直语音 / 一直文字（点这里换）";
    }
  }

  /** 「角色语音」这个开关现在是开的吗（读同步快照，跟菜单判定同一份）。 */
  function isVoiceEnabledNow() {
    const snapshot = window.__rwVoiceSettingsSnapshot;
    return !!(snapshot && snapshot.voice_enabled === true);
  }

  /**
   * 点「角色语音」入口：
   *   · 角色不合格（内置小说人物）→ **照样打开面板**，里面说清"为什么不能、怎么办"
   *     （只弹一句 toast 的话，用户下次还得再点一次才看得到解释）；
   *   · 没开启 → 走"一次开启"面板；
   *   · 已开启 → 打开三选一（自动 / 下条语音 / 下条文字）。
   */
  function toggleReplyVoice() {
    const entry = activeCharacterEntry();
    const eligibility = voiceEligibilityFor(entry);
    if (!eligibility.allowed) {
      // 内置小说人物：说清"小说人物不发语音"，并给一个明确的下一步。
      // 这里**不执行不可用的操作**（面板里那条路上不会出现贴卡表单）。
      openVoiceSetup().catch(() => {});
      return false;
    }
    if (!isVoiceEnabledNow() || !voiceCapability().canSpeak) {
      openVoiceSetup().catch(() => {});
      return false;
    }
    openVoiceMenu();
    return true;
  }

  /** 已开启之后那个小面板：只有三个常用选择 + 一个"声音设置"。 */
  function openVoiceMenu() {
    const existing = document.getElementById("voiceReplyMenu");
    if (existing) { existing.remove(); liveState.voiceMenuOpen = false; updateReplyVoiceToggle(); return; }
    const button = document.getElementById("replyVoiceToggle");
    if (!button) return;
    const menu = document.createElement("div");
    menu.id = "voiceReplyMenu";
    menu.className = "rw-voice-menu";
    menu.setAttribute("role", "menu");
    const pick = (label, hint, active, onClick) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "rw-voice-menu-item" + (active ? " is-active" : "");
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", active ? "true" : "false");
      const strong = document.createElement("strong");
      strong.textContent = label;
      item.appendChild(strong);
      if (hint) {
        const span = document.createElement("span");
        span.textContent = hint;
        item.appendChild(span);
      }
      item.addEventListener("click", () => { closeVoiceMenu(); onClick(); });
      return item;
    };
    // 三档**持久**模式：选了就一直是它，不重置、不是一次性（用户 2026-09-18）。
    const modeNow = voiceReplyMode();
    menu.appendChild(pick("自动", "它自己决定", modeNow === "auto", () => {
      setVoiceReplyMode("auto");
      showToast("角色回复方式：自动（它自己决定）");
    }));
    menu.appendChild(pick("一直语音", "每条都发语音", modeNow === "voice", () => {
      setVoiceReplyMode("voice");
      showToast("角色回复方式：一直语音");
    }));
    menu.appendChild(pick("一直文字", "每条都打字", modeNow === "text", () => {
      setVoiceReplyMode("text");
      showToast("角色回复方式：一直文字");
    }));
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "rw-voice-menu-item is-plain";
    settings.innerHTML = "<strong>声音设置…</strong><span>换音色、关掉语音</span>";
    settings.addEventListener("click", () => {
      closeVoiceMenu();
      openVoiceSetup({ settingsOnly: true }).catch(() => {});
    });
    menu.appendChild(settings);
    button.parentElement.appendChild(menu);
    liveState.voiceMenuOpen = true;
    updateReplyVoiceToggle();
    const onOutside = (event) => {
      if (!menu.contains(event.target) && event.target !== button) closeVoiceMenu();
    };
    setTimeout(() => document.addEventListener("click", onOutside, { once: true }), 0);
  }

  function closeVoiceMenu() {
    const menu = document.getElementById("voiceReplyMenu");
    if (menu) menu.remove();
    liveState.voiceMenuOpen = false;
    updateReplyVoiceToggle();
  }

  /* -------------------------------------------------------------------- *
   * 「开启角色语音」底部面板
   *
   * 一次把三件事说清楚、做完（文档 §7：一次面板、一项主要操作、不逐层确认）：
   *   ① 语音服务：有卡就显示可用与额度；没卡就**就地**贴卡号与中转地址（不跳三层设置）；
   *   ② 角色声音：这个角色说哪种语言 + 最多三个候选音色，点一下选中并试听
   *      （明确写「试听消耗语音额度」，同一句走缓存：反复听只有第一次花钱）；
   *   ③ 首次云端说明：合成文本经体验卡中转发给火山引擎，要点一下头；
   *      同意过（voice_consent_at）就不再来烦；按钮「同意并开启角色语音」。
   * 关掉面板不改任何设置；存盘失败**不显示开启成功**，面板留着可重试。
   * -------------------------------------------------------------------- */

  /** 候选音色里优先推的几个：先服务实际能出声、听着自然、不夸张的日常音色。 */
  const VOICE_PREFERRED = {
    zh: [
      "zh_female_vv_uranus_bigtts",
      "zh_male_m191_uranus_bigtts",
      "zh_female_xiaohe_uranus_bigtts",
      "zh_male_liufei_uranus_bigtts",
      "zh_female_qingxinnvsheng_uranus_bigtts",
      "zh_male_ruyaqingnian_uranus_bigtts",
      "zh_female_linjianvhai_uranus_bigtts",
      "zh_male_linjiananhai_uranus_bigtts",
      "zh_female_kailangjiejie_uranus_bigtts",
      "zh_male_yangguangqingnian_uranus_bigtts",
    ],
    en: [
      "en_male_alex_uranus_bigtts",
      "en_female_jenny_uranus_bigtts",
      "en_male_david_uranus_bigtts",
      "en_female_natasha_uranus_bigtts",
      "en_male_jamie_uranus_bigtts",
      "en_female_skye_uranus_bigtts",
    ],
  };

  /** 一眼看出男女：候选里**男女各给一个**，用户不必翻完整本音色目录。 */
  function voiceGenderOf(speakerId, label) {
    const text = String(speakerId || "") + " " + String(label || "");
    if (/female|女|姐|妹|妈|婆|桃|苏菲|丫头/.test(text)) return "f";
    if (/male|男|哥|叔|爷|爸/.test(text)) return "m";
    return "";
  }

  /** 候选音色的一句话说明（写"听感"，不编"已验证"）。 */
  function voiceHintFor(speakerId, label) {
    const L = String(label || "");
    if (/邻家/.test(L)) return "日常、自然";
    if (/vv|Vivi/i.test(L)) return "通用、清楚";
    if (String(speakerId || "").indexOf("zh_") === 0) return "通用场景，念对白不夸张";
    return "General purpose, clear";
  }

  /** 一个音色 id 能不能念这个语言（规则只在 language-core 里，界面不写第二套）。 */
  function speakerFitsLanguage(speakerId, lang) {
    const L = window.RoleWorldLanguage;
    if (!L || typeof L.speakerFitsLanguage !== "function") return true;
    try { return L.speakerFitsLanguage(speakerId, lang); } catch (_) { return false; }
  }

  /** 语言 -> 人话（角色说哪种语言是硬配置，跟界面语言无关）。 */
  function languageLabelOf(lang) {
    return lang === "en" ? "英语" : "简体中文";
  }

  /** 这个角色当前选中的音色 id（没选过就是空串 = 用它自己的默认）。 */
  function voicePickOf(entry) {
    try {
      const cover = (liveState.localSettings && liveState.localSettings.voice_by_card) || {};
      return String((cover[entry && entry.avatar] || {}).speaker || "");
    } catch (_) { return ""; }
  }

  /**
   * 这个角色能挑哪几个音色：**先按语言硬筛**（`language-core.speakerFitsLanguage`，
   * 跟朗读时的闸门是同一个函数，绝不给中文角色配英文音色），
   * 再按"用户挑过的 > 偏好表 > 男女各一"取前三个。
   * 空数组也是有效结果 —— 界面会明说"这个中转没有合适这个语言的声音"（文档 §8）。
   */
  function voiceCandidatesFor(entry) {
    const cap = voiceCapability();
    const all = Array.isArray(cap.speakers) ? cap.speakers : [];
    const lang = companionLangFor(entry);
    const fits = all.filter((one) => one && one.id && speakerFitsLanguage(one.id, lang));
    const out = [];
    const push = (one) => { if (one && out.length < 3 && !out.some((x) => x.id === one.id)) out.push(one); };
    const current = voicePickOf(entry);
    if (current) push(fits.find((one) => one.id === current));
    (VOICE_PREFERRED[lang] || []).forEach((id) => { if (out.length < 3) push(fits.find((one) => one.id === id)); });
    ["f", "m"].forEach((gender) => {
      if (out.length < 3) push(fits.find((one) => voiceGenderOf(one.id, one.label) === gender));
    });
    if (out.length < 3) fits.forEach(push);
    return { lang, list: out, total: fits.length };
  }

  /** 打开设置里的某一页（只有"还想改别的"时才用得到；日常路径不跳设置）。 */
  function openSettingsAt(section) {
    closeVoiceSetup();
    const UI = window.TASK25C_UI;
    if (!UI) return false;
    try {
      if (typeof UI.openSettings === "function") UI.openSettings();
      if (section && typeof UI.setSettingsSection === "function") UI.setSettingsSection(section);
      return true;
    } catch (_) { return false; }
  }

  function voiceSheetEl() { return document.getElementById("voiceSheet"); }

  /** 面板关掉时要摘掉的监听（每个面板一份；不开面板时是 null）。 */
  let voiceSheetCleanup = null;

  function closeVoiceSetup() {
    const node = voiceSheetEl();
    if (node) node.remove();
    document.removeEventListener("keydown", onVoiceSetupKey);
    if (typeof voiceSheetCleanup === "function") {
      try { voiceSheetCleanup(); } catch (_) { /* 摘不掉也不影响关面板 */ }
    }
    voiceSheetCleanup = null;
  }

  function onVoiceSetupKey(event) {
    if (event.key === "Escape") closeVoiceSetup();
  }

  /** 面板外壳：点背景 / 按 Esc 关掉（**不改任何设置**，文档 §7）。返回 box。 */
  function buildVoiceSheetShell(resolve, settle) {
    const overlay = document.createElement("div");
    overlay.className = "rw-voice-sheet-wrap";
    overlay.id = "voiceSheet";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "角色语音");
    const box = document.createElement("div");
    box.className = "rw-voice-sheet";
    overlay.appendChild(box);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) { closeVoiceSetup(); settle({ ok: false, canceled: true }); }
    });
    document.addEventListener("keydown", onVoiceSetupKey);
    document.body.appendChild(overlay);
    void resolve;
    return box;
  }

  /**
   * 打开面板。返回 Promise：
   *   {ok:true}                 开启/保存成功
   *   {ok:false, canceled:true}  用户自己关掉的（不改任何设置）
   *   {ok:false, reason}         没做成（存盘失败之类），面板留着让用户重试
   */
  function openVoiceSetup(options) {
    const opts = options || {};
    const entry = activeCharacterEntry();
    const eligibility = voiceEligibilityFor(entry);
    const existing = voiceSheetEl();
    if (existing) existing.remove();
    voiceSheetCleanup = null;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (result && result.ok) closeVoiceSetup();
        resolve(result);
      };
      const box = buildVoiceSheetShell(resolve, settle);

      const head = document.createElement("div");
      head.className = "rw-voice-sheet-head";
      const title = document.createElement("strong");
      title.textContent = opts.settingsOnly || isVoiceEnabledNow() ? "声音设置" : "开启角色语音";
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "rw-voice-sheet-close";
      closeButton.setAttribute("aria-label", "关闭");
      closeButton.textContent = "×";
      closeButton.addEventListener("click", () => { closeVoiceSetup(); finish({ ok: false, canceled: true }); });
      head.append(title, closeButton);
      box.appendChild(head);

      // 内置小说人物：说清"为什么不能"和"怎么办"，不执行不可用的操作（文档 §7）。
      if (!eligibility.allowed) {
        const why = document.createElement("p");
        why.className = "rw-voice-sheet-note";
        why.textContent = (eligibility.reason || "这个角色不能发语音。")
          + "（要语音就用你自己创建的角色；内置小说人物保持文字剧情。）";
        const actions = document.createElement("div");
        actions.className = "rw-voice-sheet-actions";
        const gotoSettings = document.createElement("button");
        gotoSettings.type = "button";
        gotoSettings.className = "primary-button";
        gotoSettings.textContent = "去我的角色";
        gotoSettings.addEventListener("click", () => { openSettingsAt("characters"); finish({ ok: false, canceled: true }); });
        const done = document.createElement("button");
        done.type = "button";
        done.className = "plain-button";
        done.textContent = "知道了";
        done.addEventListener("click", () => { closeVoiceSetup(); finish({ ok: false, canceled: true }); });
        actions.append(gotoSettings, done);
        box.append(why, actions);
        return;
      }

      const alreadyOn = isVoiceEnabledNow();

      const consentRow = document.createElement("label");
      consentRow.className = "rw-voice-sheet-consent";
      const consentBox = document.createElement("input");
      consentBox.type = "checkbox";
      consentBox.dataset.voiceConsent = "check";
      const consentText = document.createElement("span");
      consentText.innerHTML = "用于合成的回复文字将经体验卡中转发送给<b>火山引擎</b>，按语音额度计用量。";
      consentRow.append(consentBox, consentText);

      const status = document.createElement("p");
      status.className = "rw-voice-sheet-note";
      status.dataset.voiceSheetStatus = "1";

      const actions = document.createElement("div");
      actions.className = "rw-voice-sheet-actions";
      const primary = document.createElement("button");
      primary.type = "button";
      primary.className = "primary-button";
      primary.dataset.voiceSheetPrimary = "1";
      primary.textContent = alreadyOn ? "保存" : "同意并开启角色语音";
      const later = document.createElement("button");
      later.type = "button";
      later.className = "plain-button";
      later.textContent = alreadyOn ? "关闭角色语音" : "以后再说";
      later.addEventListener("click", () => {
        if (!alreadyOn) { closeVoiceSetup(); finish({ ok: false, canceled: true }); return; }
        turnVoiceOff().catch(() => {});
      });
      actions.append(primary, later);

      let busy = false;
      const setStatus = (text, bad) => {
        status.textContent = text || "";
        status.classList.toggle("is-bad", bad === true);
      };
      const syncPrimary = () => {
        if (alreadyOn) { primary.disabled = busy; return; }
        primary.disabled = busy || consentBox.checked !== true;
      };

      /**
       * 把面板内容**整体**重画一遍（幂等）。
       *
       * 为什么不各画各的：卡一贴上，"角色声音"那一栏要从 0 个候选变成 3 个，
       * 分开更新就要求每一处都记得刷新别人 —— 漏一处就是"贴完卡还是没声音可选"
       * （2026-09-16 实测踩到）。整体重画只有一条路径，不会漏；代价只是几毫秒。
       */
      function renderSheet() {
        // 面板已经被关掉（或换了一份面板）就别再画：那会把节点挂到屏幕外面去。
        if (!document.contains(box)) return;
        const oldService = box.querySelector('[data-voice-section="service"]');
        const oldVoice = box.querySelector('[data-voice-section="voice"]');
        if (oldService) oldService.remove();
        if (oldVoice) oldVoice.remove();
        const freshService = buildVoiceServiceSection(renderSheet);
        const freshVoice = buildVoiceChoiceSection(entry);
        // 顺序固定：语音服务 → 角色声音 → 首次说明（文档 §7 的三栏顺序）。
        box.insertBefore(freshService, consentRow);
        box.insertBefore(freshVoice, consentRow);
      }
      // 中转探测是**异步**的：贴完卡那一刻音色表还没回来（候选音色会是空的）。
      // adapter 探测结束会发 roleworld:voice-changed —— 收到就重画一次，
      // 于是"贴完卡 → 音色自己冒出来"是自然发生的，不需要谁去轮询。
      voiceSheetCleanup = () => window.removeEventListener("roleworld:voice-changed", renderSheet);
      window.addEventListener("roleworld:voice-changed", renderSheet);

      // 先把"底部那一组"挂上，再画上面两栏：万一某一段画不出来（中转数据形状变了之类），
      // 面板至少还是个能用、能关的东西 —— 而不是一块空白（2026-09-16 实测踩到过）。
      box.append(consentRow, status, actions);
      try {
        renderSheet();
      } catch (error) {
        setStatus("面板没画出来：" + String((error && error.message) || error).slice(0, 120), true);
      }

      consentBox.checked = alreadyOn;
      consentBox.addEventListener("change", syncPrimary);
      syncPrimary();

      primary.addEventListener("click", () => {
        if (busy) return;
        busy = true;
        syncPrimary();
        setStatus("正在开启…", false);
        // ⚠ **不允许"永远停在正在开启"**（用户 2026-09-18 实测：「点同意并开启角色语音的时候
        //   会一直显示正在开启，然后卡住，退出了之后发现是开启成功了」）。
        //   机制：`setVoiceEnabled` 在 settings-ui.js 里**第一步就把 voice_enabled 落盘**，
        //   而面板只在整条 Promise 结束后才收；它后面还有 `await saveAll()`、
        //   `await Cloud.credentials()` 等等 —— 其中任何一步挂住，用户看到的就是
        //   「卡在正在开启」，而设置其实已经写下去了。
        //   这里兜一个上限：到点必须给一句**说得清**的话，并且如实区分"其实已经开了"。
        const settle = (result) => {
          busy = false;
          if (!result.ok) {
            // 没同意/没存上：**不显示开启成功**，面板留着让用户重试（文档 §7）。
            syncPrimary();
            setStatus(result.reason || "没能开启，请再试一次。", true);
            return;
          }
          finish({ ok: true });
        };
        const timedOut = new Promise((resolve) => {
          // ⚠ 这里必须用 `window.setTimeout`：integration.js 的作用域里**没有 `global`**
          //   （settings-ui.js 有，因为它是 IIFE 的参数）。写成 `global.setTimeout` 会当场抛
          //   ReferenceError，兜底不仅不生效，还会把"其实已经开启了"显示成"没能开启"——
          //   2026-09-18 自测时正是这样被抓到的。
          window.setTimeout(() => resolve({
            ok: false,
            // 到这一步我们**无法同步确定**盘上到底写没写（卡住的那一步可能就在读取上），
            // 所以**不许猜**：不说"没开成"、也不说"开好了"，只给一句能立刻自查的话。
            // （用户 2026-09-18 的现场正是"卡住 → 退出来发现其实开好了"，他要的就是别卡、
            //   并且知道怎么确认。）
            reason: "这一步等太久了。关掉这个面板看入口文字：写着「角色回复：…」就是已经开好了；"
              + "还写着「开启角色语音」就再点一次。",
          }), 12000);
        });
        Promise.race([turnVoiceOn(entry, opts), timedOut]).then(settle).catch((error) => {
          busy = false;
          syncPrimary();
          setStatus("没能开启：" + String((error && error.message) || error).slice(0, 120), true);
        });
      });
      try { primary.focus(); } catch (_) { /* 聚焦失败不影响 */ }
    });
  }

  /**
   * 第 1 栏「语音服务」：有卡就写清"能用 + 还剩多少"，没卡就**就地**贴卡号。
   *
   * 为什么不复用「设置 → 连接方式」那条路：手机上要点三层（我的 → 设置 → 连接方式），
   * 用户实测就是在这儿放弃的（"根本不会用"）。这里贴完立刻调 `RoleWorldCard.apply()` ——
   * 与引导页、设置页**同一个函数**，不写第二套。
   */
  function buildVoiceServiceSection(onChanged) {
    const section = document.createElement("section");
    section.className = "rw-voice-sheet-section";
    section.dataset.voiceSection = "service";
    const h = document.createElement("h4");
    h.textContent = "语音服务";
    const note = document.createElement("p");
    note.className = "rw-voice-sheet-note";
    note.dataset.voiceServiceNote = "1";
    section.append(h, note);

    const cap = voiceCapability();
    if (cap.relay) {
      const left = cap.voiceLeft === null || cap.voiceLeft === undefined
        ? (cap.voiceCharsLeft === null || cap.voiceCharsLeft === undefined
          ? "语音额度不限额"
          : "语音额度还剩 " + cap.voiceCharsLeft + " 字")
        : "语音额度还剩 " + cap.voiceLeft + " 次";
      note.textContent = (cap.enabled ? "体验卡可用 · " + left : (cap.reason || "这个中转还没开语音。"))
        + "（卡号只存在这台设备上；文字聊天不受影响。）";
      note.classList.toggle("is-bad", cap.enabled !== true);
      const row = document.createElement("div");
      row.className = "rw-voice-sheet-actions";
      const change = document.createElement("button");
      change.type = "button";
      change.className = "plain-button";
      change.dataset.voiceAction = "change-card";
      change.textContent = "换一张卡";
      change.addEventListener("click", () => {
        note.hidden = true;
        row.remove();
        section.appendChild(buildCardEntry(onChanged));
      });
      row.appendChild(change);
      section.appendChild(row);
      return section;
    }

    note.textContent = "云端语音要用体验卡（卡号就是凭据，你不用自己配火山密钥）。"
      + "把发卡的人给你的卡号与中转地址贴在这里就行。";
    note.classList.add("is-bad");
    section.appendChild(buildCardEntry(onChanged));
    return section;
  }

  /** 就地贴卡：卡号 + 中转地址两栏（与引导页同样拆两栏，不要求拼成一行）。 */
  function buildCardEntry(onChanged) {
    const wrap = document.createElement("div");
    wrap.className = "rw-voice-sheet-card";
    wrap.dataset.voiceCardEntry = "1";
    const tokenInput = document.createElement("input");
    tokenInput.type = "text";
    tokenInput.dataset.voiceCardToken = "1";
    tokenInput.placeholder = "卡号：RW-XXXXX-XXXXX-XXXXX";
    tokenInput.autocomplete = "off";
    tokenInput.spellcheck = false;
    tokenInput.maxLength = 120;
    tokenInput.setAttribute("aria-label", "体验卡号");
    const relayInput = document.createElement("input");
    relayInput.type = "text";
    relayInput.dataset.voiceCardRelay = "1";
    relayInput.placeholder = "中转地址：https://…";
    relayInput.autocomplete = "off";
    relayInput.spellcheck = false;
    relayInput.maxLength = 300;
    relayInput.setAttribute("aria-label", "中转地址");
    const use = document.createElement("button");
    use.type = "button";
    use.className = "primary-button";
    use.dataset.voiceCardUse = "1";
    use.textContent = "用这张卡";
    const status = document.createElement("p");
    status.className = "rw-voice-sheet-note";
    status.dataset.voiceCardStatus = "1";
    wrap.append(tokenInput, relayInput, use, status);

    /**
     * ⚠ 状态要写进**当前**那一份表单的节点，不能只认建的时候那个。
     *
     * 为什么：贴卡成功之后面板会整体重画（见 renderSheet），旧的那一份会从文档里摘掉。
     * 处理器是绑在旧按钮上的闭包，直接写旧节点，用户看到的就是"点了按钮什么都没发生" ——
     * 明明卡已经在用了，屏幕上却还是那句"贴在这里就行"（2026-09-16 实测，查了很久）。
     * 所以每次写之前先找**文档里活着的那一个**，找不到才退回自己这份。
     */
    const liveNode = (selector, fallback) => document.querySelector(selector) || fallback;
    const setStatus = (text, bad) => {
      const node = liveNode('[data-voice-card-status]', status);
      node.textContent = text || "";
      node.classList.toggle("is-bad", bad === true);
    };
    const setBusy = (busy) => {
      const node = liveNode('[data-voice-card-use]', use);
      node.disabled = busy === true;
    };

    // 预填已经记住的中转地址（换卡时不必再抄一遍）。
    (async () => {
      try {
        const settings = await window.RoleWorld.getLocalSettings();
        if (settings && settings.card_relay && !relayInput.value) relayInput.value = settings.card_relay;
      } catch (_) { /* 读不到就让用户自己填 */ }
    })();

    use.addEventListener("click", async () => {
      const card = window.RoleWorldCard;
      const token = String(liveNode('[data-voice-card-token]', tokenInput).value || "").trim();
      const relay = String(liveNode('[data-voice-card-relay]', relayInput).value || "").trim().replace(/\/+$/, "");
      if (wrap.dataset.voiceCardBusy === "1") return;
      if (!card || typeof card.apply !== "function") { setStatus("这个版本不支持体验卡。", true); return; }
      if (!token) { setStatus("先填卡号（发卡的人给你的那串 RW-…）。", true); return; }
      if (!relay) { setStatus("还要填中转地址：发卡的人给你的那段 https:// 开头的网址。", true); return; }
      wrap.dataset.voiceCardBusy = "1";
      setBusy(true);
      setStatus("正在用这张卡…", false);
      try {
        const result = await card.apply(token + "@" + relay);
        if (!result.ok) {
          setStatus(result.message || "这张卡没用上。", true);
          wrap.dataset.voiceCardBusy = "0";
          setBusy(false);
          return;
        }
        tokenInput.value = "";
        setStatus("好了，这张卡已经在用：" + (result.message || ""), false);
        // 换了卡：让 adapter 重新问一次音色表（不问的话候选音色还是空的）。
        const Cloud = window.RoleWorldVoiceCloud;
        if (Cloud) Cloud.refresh({ force: true }).catch(() => {});
        window.dispatchEvent(new window.CustomEvent("roleworld:card-changed", { detail: { source: "voice-sheet" } }));
        if (typeof onChanged === "function") onChanged();
      } catch (error) {
        setStatus("这张卡没用上：" + String((error && error.message) || error).slice(0, 120), true);
        wrap.dataset.voiceCardBusy = "0";
        setBusy(false);
      }
    });
    return wrap;
  }

  /**
   * 第 2 栏「角色声音」：交流语言 + 最多三个候选，点一个选中（并试听一次）。
   *
   * 2026-09-16 用户反馈补的：**这个中转开放的全部音色都要能在这里选**，
   * 不能只有三个推荐候选（用户原话："角色声音应该要全部能够在角色语音那个界面显示"）。
   * 所以现在分成两块：
   *   · 上面三个**推荐候选**（好音色，点一下就能听，不用挑）；
   *   · 下面一个**全量下拉**（按语言分组、写清场景），跟「设置 → 语音」用的是同一份音色表、同一个保存入口。
   * 两块都走 `pickVoiceCandidate`，所以"选了到底存没存"只有一条路。
   */
  function buildVoiceChoiceSection(entry) {
    const section = document.createElement("section");
    section.className = "rw-voice-sheet-section";
    section.dataset.voiceSection = "voice";
    const h = document.createElement("h4");
    h.textContent = "角色声音";
    // ⚠ 2026-09-18 用户口径：「挑好的语音也不要做，就让用户选择，不要加一堆文字说明」。
    //   所以这里**不再**摆"挑好的三个候选"（连那些听感小字一起去掉），也不写说明段落 ——
    //   只留一个「全部音色」选择器，让用户自己挑。
    //   （音色表仍然按**角色语言**筛：给中文角色摆一堆英文音色不是"让用户选"，是添乱。）
    const picked = voiceCandidatesFor(entry);
    const lang = picked.lang;
    const all = buildAllVoicesRow(entry, lang);
    if (!all) {
      const empty = document.createElement("p");
      empty.className = "rw-voice-sheet-note is-bad";
      empty.dataset.voiceNoCandidate = "1";
      empty.textContent = voiceCapability().checked
        ? "这个中转没有" + languageLabelOf(lang) + "音色，暂时用不了角色语音；文字聊天照常。"
        : "正在确认这个中转有哪些音色…（贴完体验卡会自动问一次）";
      section.append(h, empty);
      return section;
    }
    section.append(h, all);

    const more = document.createElement("button");
    more.type = "button";
    more.className = "rw-voice-sheet-link";
    more.dataset.voiceAction = "more-voices";
    more.textContent = "更多设置（语速…）";
    more.addEventListener("click", () => { openSettingsAt("voice"); });
    section.appendChild(more);
    return section;
  }

  /** 这个语言下中转一共开放了多少个音色（给说明与"要不要给全量选择"用）。 */
  function voiceCountForLanguage(lang) {
    const cap = voiceCapability();
    const all = Array.isArray(cap.speakers) ? cap.speakers : [];
    return all.filter((one) => one && one.id && speakerFitsLanguage(one.id, lang)).length;
  }

  /**
   * 「全部音色」那一行：一个按语言分组的原生下拉 + 一颗试听。
   *
   * 为什么用下拉而不是把几十个音色全平铺成按钮：平铺会长到没法看（用户要的是"能选到"，
   * 不是"一次看完"）。分组 + 场景写在标签里，找起来快，也跟设置页保持一致。
   */
  function buildAllVoicesRow(entry, lang) {
    const cap = voiceCapability();
    const all = Array.isArray(cap.speakers) ? cap.speakers : [];
    const fits = all.filter((one) => one && one.id && speakerFitsLanguage(one.id, lang));
    if (!fits.length) return null;
    const wrap = document.createElement("div");
    wrap.className = "rw-voice-sheet-all";
    wrap.dataset.voiceAll = "1";
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = "全部音色（" + fits.length + " 个）";
    const select = document.createElement("select");
    select.dataset.voiceAllSelect = "1";
    select.setAttribute("aria-label", "这个中转开放的全部音色");
    const current = voicePickOf(entry);
    const groups = new Map();
    for (const one of fits) {
      const key = one.scene ? String(one.scene) : "其他";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(one);
    }
    const order = ["通用", "角色扮演", "有声阅读", "视频配音", "客服", "教学", "其他"];
    const sorted = Array.from(groups.keys()).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "zh-Hans-CN");
    });
    for (const groupName of sorted) {
      const group = document.createElement("optgroup");
      group.label = groupName + "（" + groups.get(groupName).length + "）";
      for (const one of groups.get(groupName)) {
        const option = document.createElement("option");
        option.value = one.id;
        option.textContent = one.label || one.id;
        option.selected = one.id === current;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    if (!current) select.value = fits[0].id;
    select.addEventListener("change", () => {
      const one = fits.find((item) => item.id === select.value) || { id: select.value, label: select.value };
      pickVoiceCandidate(entry, one).catch(() => {});
    });
    label.append(text, select);
    const test = document.createElement("button");
    test.type = "button";
    test.className = "plain-button";
    test.dataset.voiceAllTest = "1";
    test.textContent = "试听这个";
    test.addEventListener("click", () => {
      const one = fits.find((item) => item.id === select.value);
      if (one) pickVoiceCandidate(entry, one).catch(() => {});
    });
    wrap.append(label, test);
    return wrap;
  }

  /** 选中一个候选音色：先落盘（覆盖），再试听一次（试听走缓存，不重复计费）。 */
  async function pickVoiceCandidate(entry, one) {
    const avatar = (entry && entry.avatar) || "";
    if (!avatar) return false;
    await saveVoiceOverride(avatar, { speaker: one.id });
    // 存完**说一声**：用户反馈过"选了没反应、不知道存没存"——那就把结果直接说出来。
    // ⚠ 只有真存进去了才说"换好了"（saveVoiceOverride 写的就是这个角色的那一格）。
    const saved = voicePickOf(entry);
    if (saved !== one.id) {
      showToast("没能把音色存下来（" + (one.label || one.id) + "），请再试一次。");
      return false;
    }
    const cap = voiceCapability();
    const canAudition = cap.checked === true && cap.enabled === true && !!cap.relay;
    if (!canAudition) {
      showToast("换好了：" + (one.label || one.id) + "。开启角色语音后就能听到。");
      return true;
    }
    await previewVoice(avatar, entry.charName || "");
    return true;
  }

  /** 真正把语音打开：同意 → 落盘（开关 + 音色）→ 同步快照与按钮。 */
  async function turnVoiceOn(entry, opts) {
    const UI = window.RoleWorldSettingsUI;
    const adapter = window.RoleWorld;
    if (!UI || typeof UI.setVoiceEnabled !== "function") return { ok: false, reason: "设置模块没加载，先刷新页面。" };
    const sheet = voiceSheetEl();
    const consentBox = sheet ? sheet.querySelector('[data-voice-consent="check"]') : null;
    const settings = await adapter.getLocalSettings().catch(() => ({}));
    if (!(settings && settings.voice_consent_at)) {
      // 首次：**必须**显式同意一次（承诺边界变了：角色说的话会离开这台设备）。
      if (consentBox && consentBox.checked !== true) {
        return { ok: false, reason: "先勾上中间那一句，再点「同意并开启角色语音」。" };
      }
      const agreed = await UI.confirmVoiceConsent();
      if (!agreed) return { ok: false, reason: "没有同意，就没有打开。" };
    }
    // ⚠ 这里**不再重读一遍本地设置**去写快照：setVoiceEnabled 已经把库里的值
    //   （含对齐过中转地址的那一份）写进 __rwVoiceSettingsSnapshot 了。
    //   再读一次反而可能拿到旧的 card_relay，把快照写空 —— 那正是"开了却还显示开启角色语音"的成因。
    const saved = await UI.setVoiceEnabled(true, { forceRefresh: true });
    if (saved && saved.error) return { ok: false, reason: saved.error };
    // ⚠ 这里**不动**用户的持久选择（`voiceReplyMode`）—— 开启语音不该把"一直文字/一直语音"
    //   重置掉（用户 2026-09-18：「选择…应该要持续，不要每次重置」）。
    //   只有"开启并让下一条发语音"那一步给一个**一次性**要求。
    liveState.replyVoiceOnce = !!(opts && opts.replyNow);
    updateReplyVoiceToggle();
    return { ok: true };
  }

  /** 关掉语音（持续关闭只在这里，跟"下条文字"那种一次性选择分开）。 */
  async function turnVoiceOff() {
    const UI = window.RoleWorldSettingsUI;
    if (!UI || typeof UI.setVoiceEnabled !== "function") return false;
    await UI.setVoiceEnabled(false);
    stopVoicePlayback();
    updateReplyVoiceToggle();
    closeVoiceSetup();
    showToast("角色语音已关闭（文字聊天照常）");
    return true;
  }

  /**
   * ⚠ 2026-09-16：旧的「这一轮发语音」开关（禁用 + title 说原因 + 点一下切换）已被上面那份替换。
   * 保留成注释是为了留痕：旧行为（不能用就禁用、状态写在 aria-pressed 上）与旧文案，
   * 方便对照老测试与老截图。真正生效的是文件上方那份同名函数。
   *
   *   function updateReplyVoiceToggle() { ... }   ← 旧实现已删（禁用按钮 = 用户只看到"灰的"）
   *   function toggleReplyVoice() { ... }         ← 旧实现已删（只能切本轮，开不了语音）
   */

  /**
   * 一条语音消息**要合成哪段文本**：只念对白，而且**太长就不发语音**。
   *
   * 规则只有一处（`voice-core.voiceMessageText`）：这儿只是把它接到当前角色上，
   * 免得"渲染一套、语音一套"两边飘开。返回空串 = 这条不发语音（**不是**截断）。
   */
  function voiceTextFor(text, entry) {
    const Voice = window.RoleWorldVoice;
    if (!Voice || typeof Voice.voiceMessageText !== "function") return "";
    try { return Voice.voiceMessageText(text); } catch (_) { return ""; }
  }


  /**
   * 把这一轮的回复切成**一条一条的消息**，并按需标出哪几条是语音。
   *
   * 用户 2026-09-14：「我发一条他不一定就发一条，也可以发几条」——
   * 所以一轮回复可以带 1～4 条消息（空行分段），每条各自是文字或语音。
   * 解析规则在 `voice-core.splitReplyParts`（纯函数，单测钉着），这里只负责接上"资格/开关"：
   *   · 没资格的角色：全部当文字（一条也不发语音）；
   *   · 用户用输入框那个开关点名要语音：**所有**能念的条目都发语音（**只这一轮**，见下）。
   *
   * ⚠ **「重新回答」不吃这个开关**：那不是用户新说的一句话，是让角色把**同一句**重讲一遍；
   *   拿它强制发语音会顺带把那一版的正文换成"朗读用的那一份"（引号/换行被清掉）——
   *   用户会看到"重新回答之后，旧版本切回来对不上了"（真踩过一次）。
   */
  function replyPartsFor(finalText, entry) {
    const Voice = window.RoleWorldVoice;
    let parts = [];
    try {
      parts = Voice && typeof Voice.splitReplyParts === "function" ? Voice.splitReplyParts(finalText) : [];
    } catch (_) { parts = []; }
    if (!parts.length) parts = [{ kind: "text", text: String(finalText || "") }];
    const eligible = voiceEligibilityFor(entry).allowed === true;
    const regenerating = Number.isInteger(liveState.regenerateIndex) && liveState.regenerateIndex >= 0;
    // 模式是**持久**的（voice=一直语音 / text=一直文字 / auto=模型自己决定），所以这里
    // **不再"用完就清"** —— 清了就等于每次重置（用户 2026-09-18 明确不要这样）。
    // 「重新回答」不吃"一直语音"：重跑一轮不该改坏正文，也不该重复花钱。
    const mode = voiceReplyMode();
    const forced = eligible && mode === "voice" && !regenerating;
    const suppressVoice = mode === "text";
    // 一次性的"这一轮发语音"（开启引导那一步）用完即清，与持久模式互不影响。
    const onceForced = eligible && liveState.replyVoiceOnce === true && !regenerating;
    if (liveState.replyVoiceOnce === true && !regenerating) {
      liveState.replyVoiceOnce = false;
      try { updateReplyVoiceToggle(); } catch (_) { /* 界面还没挂上也无所谓 */ }
    }
    return parts
      .map((part) => {
        const wantVoice = eligible && !suppressVoice && (part.kind === "voice" || forced || onceForced);
        return {
          kind: wantVoice ? "voice" : "text",
          text: String(part.text || ""),
          // 一确定是语音就**立刻**写死状态：`queued`。
          // 这一步是"交付类型一旦确定就稳定"的落点 —— 界面之后只会把它推到
          // synthesizing → ready / failed，**绝不会再退回 text 重新画一遍**。
          ...(wantVoice ? { status: "queued" } : {}),
        };
      })
      .filter((part) => part.text);
  }

  /** 这一轮里有没有"说好要发语音、但还没合成好"的条目 —— 决定要不要显示准备中的气泡。 */
  function hasPendingVoice(parts) {
    const Voice = window.RoleWorldVoice;
    const list = Array.isArray(parts) ? parts : [];
    if (Voice && typeof Voice.isPendingVoice === "function") return list.some((one) => Voice.isPendingVoice(one));
    return list.some((one) => one && one.kind === "voice" && !one.key);
  }

  /** 把 parts 拼回一条纯文本（存进 `mes`）：上下文、记忆、检索、重放都基于它。 */
  function partsToText(parts) {
    return (Array.isArray(parts) ? parts : []).map((part) => String((part && part.text) || "")).filter(Boolean).join("\n");
  }

  /**
   * 把这一轮里所有语音条目合成成语音消息（后台跑，顺序合成保证顺序）。
   *
   * ⚠ 2026-09-14 重写（用户实测反馈：「先看到文字 → 文字消失 → 出现语音」）：
   * **失败不再悄悄退回文字**。原来的写法是 `kind: "text"` —— 用户明明说了要语音，
   * 结果屏幕上蹦出一段文字，而他不知道发生了什么事。现在一律标成 `failed`：
   * 界面显示**失败态 + 重试**，正文要不要露出来由用户点「改为文字」决定。
   *
   * 这一层同时负责四件事（都在这里判一次，别处不再各写一套）：
   *   ① 那条语音**念什么**（`voiceTextFor`→`voice-core.voiceMessageText`）；
   *   ② **太长不发**（不是截断）；
   *   ③ **语言校验**：角色设的是中文却写成英文时，**绝不把这段文本交给中文音色**
   *      （`language-core.checkResponseLanguage`），并且标成失败让用户看得见；
   *   ④ 逐条推进状态并落盘 —— 每推进一步都调 `applyTurnParts`
   *      （它按 `roleworld_turn_id` 找**现在**的那条消息，不拿旧快照覆盖）。
   */
  async function synthesizeReplyVoices(entry, session, turnId, parts) {
    const Cloud = window.RoleWorldVoiceCloud;
    if (!Cloud || !entry || !session || !turnId) return { ready: 0, failed: 0 };
    if (voiceEligibilityFor(entry).allowed !== true) return { ready: 0, failed: 0 };
    // 异步有效期：这一轮开始时的号码。期间用户切了会话/取消/重新回答就作废。
    const seq = liveState.generationSeq;
    const list = Array.isArray(parts) ? parts.map((one) => Object.assign({}, one)) : [];
    const done = [];
    let failed = 0;
    let tooLong = 0;
    for (const part of list) {
      if (part.kind !== "voice" || part.key) { done.push(part); continue; }
      const outcome = await synthesizeOneVoicePart(entry, part);
      // 重试也没用的那几种（太长 / 没对白 / 这台设备不能合成）：**退回文字并写明原因**。
      // 这不是"悄悄变回文字"—— note 会跟着消息显示给用户看，而且一个字都没丢。
      done.push(outcome.recoverable ? downgradeVoicePart(part, outcome.part.note) : outcome.part);
      if (outcome.part.kind === "voice" && outcome.part.status === "failed") failed += 1;
      if (outcome.reason === "too-long") tooLong += 1;
      // 每合成一条就把状态推给界面/磁盘：三条消息的场景下，第一条不该等第三条。
      try { await applyTurnParts(turnId, done, { seq: seq }); } catch (_) { /* 推不动只是这一条界面没更新 */ }
    }
    return { ready: done.filter((one) => one.kind === "voice" && one.status === "ready").length, failed, tooLong };
  }

  /**
   * 合成**一条**语音 part，返回 `{ part, reason, recoverable }`。
   *
   * 返回的 part 绝大多数情况下是**交付类型没变**的语音 part，只是状态不同：
   *   ready（有缓存键）/ failed（带一个机器可读的 reason 与一句人话 note）。
   *
   * ⚠ 唯一的例外是 `too-long` / `no-text` / `no-capability`（`recoverable: true`）：
   * 这三种情况**再重试也不会好**（内容太长就是太长、这台设备没法合成就是没法合成），
   * 所以那一条**退回文字**并把原因写在消息上。这不是"悄悄变回文字"——
   * 用户会看到「这条没做成语音：<原因>」，而且**一个字都没丢**。
   * 只有"再试一次可能就好了"的失败（合成失败 / 语言不符）才保留语音气泡 + 重试。
   *
   * `reason`：`too-long` / `synth-failed` / `no-capability` / `language-mismatch` / `no-text` / `no-voice-chars`。
   */
  const VOICE_RECOVERABLE_REASONS = ["too-long", "no-text", "no-capability"];

  async function synthesizeOneVoicePart(entry, part) {
    const Cloud = window.RoleWorldVoiceCloud;
    const Language = window.RoleWorldLanguage;
    // ⚠ 把**重试次数**显式带过去：它是"同一条最多试 2 次"那道闸的载体，
    //   丢掉它会让按钮永远看起来像没试过（用户会一直点，一直花钱）。
    //   第一次合成时这个字段不存在，也就是 0 次 —— 正合语义。
    const base = Object.assign({}, part, { kind: "voice" });
    if (part && part.retry !== undefined) base.retry = part.retry;
    else delete base.retry;
    delete base.reason;
    delete base.note;
    const fail = (reason, note) => {
      const recoverable = VOICE_RECOVERABLE_REASONS.indexOf(reason) >= 0;
      return {
        part: Object.assign({}, base, { status: "failed", reason: reason, note: note || "" }),
        reason: reason,
        recoverable: recoverable,
      };
    };
    const settingText = await (async () => {
      const settings = await window.RoleWorld.getLocalSettings().catch(() => ({}));
      return Cloud.settingFor(entry.avatar, settings);
    })();
    const cap = voiceCapability();
    const speakText = voiceTextFor(part.text, entry);
    if (!speakText) {
      // 太长（或整条只有动作、没有可念的对白）：**不发语音，也不截断**。
      const max = (window.RoleWorldVoice && window.RoleWorldVoice.VOICE_MESSAGE_MAX_CHARS) || 120;
      return fail("too-long", "这条超过 " + max + " 字（或者只有动作描写、没有对白），所以没有做成语音 —— 我们不会截断它。");
    }
    // ③ 语言校验：角色设的语言与这段文本对不上时，**不交给这个音色**。
    //    为什么放在合成之前：送错了就是"中文音色念英文"或者"英文音色念中文"，
    //    花了钱还难听；而且这不是我们能自己修的问题（不会去删字凑合规）。
    if (Language && typeof Language.checkResponseLanguage === "function") {
      const expected = characterLanguageFor(entry);
      const verdict = Language.checkResponseLanguage(speakText, expected);
      if (!verdict.ok) {
        return fail("language-mismatch", "这条的语言和角色设定的交流语言对不上，所以没有用当前音色合成（"
          + (verdict.reason || "") + "）。");
      }
    }
    if (!cap.canSpeak) return fail("no-capability", cap.reason || "现在这台设备不能合成语音。");
    const budget = voiceCharsLeft();
    if (Number.isFinite(budget) && budget < speakText.length) {
      return fail("no-voice-chars", "这张卡的语音字数不够了（还差 " + (speakText.length - budget) + " 字），文字聊天不受影响。");
    }
    const result = await Cloud.synthesizeToCache(speakText, {
      speaker: settingText.speaker,
      speechRate: settingText.speechRate,
      maxChars: Math.min(Number(cap.maxChars) || 220, 220),
      pinned: true,
    });
    const clip = result && result.ok && result.clips && result.clips[0] ? result.clips[0] : null;
    if (!clip || !clip.key) {
      return fail("synth-failed", (result && result.reason) || "语音没合成出来（可能是网络或额度问题），可以重试一次。");
    }
    return {
      part: Object.assign(base, {
        status: "ready",
        // 念的是**清理过的那一份**（屏幕上不显示它；气泡里显示的是 aria-label 的前 40 字）。
        text: speakText,
        key: clip.key,
        // 时长是**估算**（按字数）—— 气泡上的"3″"够用，但不假装精确。
        seconds: Math.max(1, Math.round((Number(result.chars) || speakText.length) / 4.2)),
        chars: result.chars || speakText.length,
        speaker: settingText.speaker || "",
        speechRate: settingText.speechRate || 0,
      }),
      reason: "ok",
      recoverable: false,
    };
  }

  /**
   * 一条"没做成语音"的 part 退回文字：**正文原样留着**，只在同一轮里记一句为什么。
   *
   * 两种去处（用户 2026-09-14："可提供用户主动选择的改为文字"，也允许系统在
   * 重试无意义时说明后退回）：
   *   · 重试也没用的原因（太长 / 这台设备不能合成）→ 直接是文字，附一句说明；
   *   · 可能是暂时故障（合成失败 / 语言不符）→ 保留语音气泡 + 重试按钮，
   *     用户点「改为文字」才换成文字（由 `voicePartToText` 处理）。
   */
  function downgradeVoicePart(part, note) {
    const next = { kind: "text", text: String(part.text || "") };
    if (note) next.note = note;
    return next;
  }

  /** 这张卡还剩多少语音字数；不限制 / 问不到时返回 Infinity（不因此拦住用户）。 */
  function voiceCharsLeft() {
    const cap = voiceCapability();
    if (!cap || !cap.canSpeak) return Infinity;
    // ⚠ 中转对"这条不限制"回的是 null，不是数字 —— 早先写成 Number(null)=0，
    // 结果每次都被判成"字数不够"，一条语音都发不出来（用例当场抓到）。
    const raw = cap.voiceCharsLeft;
    if (raw === null || raw === undefined || raw === "") return Infinity;
    const left = Number(raw);
    return Number.isFinite(left) ? left : Infinity;
  }

  /** 这个角色该说哪种语言（用户在设置里显式改过就听用户的，否则听卡里写的）。 */
  function characterLanguageFor(entry) {
    const Language = window.RoleWorldLanguage;
    if (!Language) return null;
    try {
      const card = liveState.cardCache && liveState.cardCache.avatar === (entry && entry.avatar)
        ? liveState.cardCache.card
        : null;
      return Language.resolveCharacterLanguage(card, { override: languageForAvatar(entry && entry.avatar) }).language;
    } catch (_) { return null; }
  }

  /**
   * 把某一轮的 parts 写回**那条**消息，并在正看着这个会话时刷新界面。
   *
   * 三道保护（都是踩过的坑，别省）：
   *   ① 按 `roleworld_turn_id` 找，**不按下标** —— 期间又来过消息时下标会指错；
   *   ② 找的是模型里**现在**的会话列表：会话/消息已被删掉就直接放弃
   *      （绝不能因为一条晚回来的语音把删掉的消息插回去）；
   *   ③ `seq` 是发起时的有效期号码：号码变了 = 用户已经切走/取消，
   *      数据照写（它本来就该存），但**不许再碰界面**。
   */
  async function applyTurnParts(turnId, parts, options) {
    const opts = options || {};
    const model = liveState.chatModel;
    if (!model || typeof model.getSessions !== "function" || !turnId) return false;
    const target = model.getSessions().find((one) => Array.isArray(one.messages)
      && one.messages.some((message) => message && message.extra && message.extra.roleworld_turn_id === turnId));
    if (!target || !target.avatar) return false;
    const messages = target.messages.slice();
    const index = messages.findIndex((message) => message && message.extra && message.extra.roleworld_turn_id === turnId);
    if (index < 0) return false;
    const message = Object.assign({}, messages[index]);
    message.extra = Object.assign({}, message.extra, { roleworld_parts: parts });
    messages[index] = message;
    const payload = buildChatPayload(target, messages);
    await window.STApi.saveChat(target.avatar, target.storageFileName || target.fileName, payload);
    target.lines = payload;
    target.messages = messages;
    target.updatedAt = new Date().toISOString();
    if (opts.seq !== undefined && opts.seq !== null && opts.seq !== liveState.generationSeq) return true;
    const active = model.getActive();
    if (active && active.fileName === target.fileName) {
      // 刚补上的这条要**逐条出现**（模拟真人一条一条发）——记住是哪一轮，渲染时用它。
      if (opts.animate !== false) liveState.animateTurnId = turnId;
      syncActiveSession();
    }
    return true;
  }

  /** 老名字：别处（以及用例）还在用它。语义就是"把 parts 挂回那条消息"。 */
  async function attachMessageParts(turnId, parts) {
    return applyTurnParts(turnId, parts);
  }

  /**
   * 重试一条没合成出来的语音（用户点气泡上的「重试」）。
   *
   * 约束（用户 2026-09-14 明确要求）：
   *   · **不无限重试**：同一条最多 2 次（`part.retry` 记着次数），到顶就把「重试」按钮收起来；
   *   · 重试期间状态回到 `queued`（气泡原位显示"准备中"，**不露正文**、不重新入场）；
   *   · 同一时刻只跑一次（`voiceRetryRunning`），连点两下不会发两次合成请求。
   */
  const voiceRetryRunning = new Set();
  const VOICE_RETRY_MAX = 2;

  async function retryVoicePart(turnId, partIndex) {
    const model = liveState.chatModel;
    if (!model || !turnId) return false;
    const key = turnId + "#" + partIndex;
    if (voiceRetryRunning.has(key)) return false;
    const target = model.getSessions().find((one) => Array.isArray(one.messages)
      && one.messages.some((message) => message && message.extra && message.extra.roleworld_turn_id === turnId));
    if (!target) { showToast("这条消息已经不在了，没法重试。"); return false; }
    const message = target.messages.find((one) => one && one.extra && one.extra.roleworld_turn_id === turnId);
    const parts = Array.isArray(message && message.extra && message.extra.roleworld_parts)
      ? message.extra.roleworld_parts.map((one) => Object.assign({}, one))
      : [];
    const part = parts[Number(partIndex)];
    if (!part || part.kind !== "voice") return false;
    const tries = Number(part.retry) || 0;
    if (tries >= VOICE_RETRY_MAX) {
      showToast("这条语音已经试过 " + VOICE_RETRY_MAX + " 次了 —— 再试多半还是不行。可以点「改为文字」。");
      return false;
    }
    const entry = activeCharacterEntry();
    if (!entry) return false;
    voiceRetryRunning.add(key);
    parts[Number(partIndex)] = Object.assign({}, part, { status: "queued", retry: tries + 1 });
    delete parts[Number(partIndex)].reason;
    delete parts[Number(partIndex)].note;
    try {
      await applyTurnParts(turnId, parts, { animate: false });
      const seq = liveState.generationSeq;
      const outcome = await synthesizeOneVoicePart(entry, parts[Number(partIndex)]);
      // 重试之后仍然"再试也没用"（太长 / 这台设备不能合成）→ 和首次一样退回文字 + 写明原因。
      parts[Number(partIndex)] = outcome.recoverable
        ? downgradeVoicePart(parts[Number(partIndex)], outcome.part.note)
        : outcome.part;
      await applyTurnParts(turnId, parts, { seq: seq, animate: false });
      if (outcome.part.status === "ready") showToast("语音好了，点一下就能听。");
      else showToast(outcome.part.note || "这条还是没合成出来。");
      return outcome.part.status === "ready";
    } catch (error) {
      showToast("重试失败：" + String((error && error.message) || error));
      return false;
    } finally {
      voiceRetryRunning.delete(key);
    }
  }

  /**
   * 用户点「改为文字」：把这条**真正**改成文字 part（落盘）。
   *
   * 为什么是改数据而不是只改显示：用户的选择要能活过刷新 ——
   * 否则下次打开又是一条点不动的失败气泡（"我明明点过改为文字"）。
   */
  async function voicePartToText(turnId, partIndex) {
    const model = liveState.chatModel;
    if (!model || !turnId) return false;
    const target = model.getSessions().find((one) => Array.isArray(one.messages)
      && one.messages.some((message) => message && message.extra && message.extra.roleworld_turn_id === turnId));
    if (!target) { showToast("这条消息已经不在了。"); return false; }
    const message = target.messages.find((one) => one && one.extra && one.extra.roleworld_turn_id === turnId);
    const parts = Array.isArray(message && message.extra && message.extra.roleworld_parts)
      ? message.extra.roleworld_parts.map((one) => Object.assign({}, one))
      : [];
    const part = parts[Number(partIndex)];
    if (!part || part.kind !== "voice") return false;
    // 转成文字时显示的应当是**原本那一份正文**（带引号/旁白），而不是朗读用的那份 ——
    // 用户改回文字，就该看到模型真正写的东西。
    parts[Number(partIndex)] = { kind: "text", text: String(part.text || "") };
    await applyTurnParts(turnId, parts, { animate: false });
    showToast("好，这条改成文字了（刷新之后也是文字）。");
    return true;
  }

  /** 风格与关系、语音独立；内置小说人物始终保留剧情方式，老档案不改写。 */
  function isPlainChatFor(entry, profile) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    return !!(core && entry && entry.avatar && !isBuiltinAvatar(entry.avatar) && core.isPlainChat(profile));
  }

  /** 新消息记住生成时的方式；无标记的旧存档仍按原来的当前方式渲染，不迁移。 */
  function isPlainChatMessage(message) {
    const extra = (message && message.extra) || {};
    const styles = extra.roleworld_swipe_styles;
    const index = Math.max(0, Number(message && message.swipe_id) || 0);
    const saved = Array.isArray(styles) && Array.isArray(message.swipes)
      ? styles[index] : extra.roleworld_chat_style;
    if (saved === "plain") return true;
    if (saved === "action") return false;
    return isPlainChatActive();
  }

  /** 渲染、顶栏与请求共用同一条有效风格规则。 */
  function isPlainChatActive() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core) return false;
    const entry = activeCharacterEntry();
    if (!entry) return false;
    const cached = companionCache && companionCache.avatar === entry.avatar ? companionCache.profile : null;
    return isPlainChatFor(entry, cached);
  }

  /**
   * 顶栏那个**当前方式**小字（文档 §6：「顶部：角色头像、名字、当前方式」）。
   *
   * 只说你正在用什么，不编状态：
   *   · 内置小说人物 → 剧情对话（它们本来就是小说的写法）；
   *   · 伴侣开着的自定义角色 → 伴侣 · 日常聊天 / 伴侣 · 剧情对话；
   *   · 别的自定义角色 → 档案选定的日常聊天 / 剧情对话（缺省保留剧情）。
   * 有效方式与提示词、消息渲染共用 `isPlainChatFor`。
   */
  function renderTopbarMode() {
    const node = document.querySelector("#topbarMode");
    if (!node) return;
    const core = window.ROLEWORLD_COMPANION_CORE;
    const entry = activeCharacterEntry();
    if (!core || !entry || !entry.avatar) { node.hidden = true; node.textContent = ""; return; }
    const cached = companionCache && companionCache.avatar === entry.avatar ? companionCache.profile : null;
    const style = isPlainChatFor(entry, cached) ? "日常聊天" : "剧情对话";
    const text = !isBuiltinAvatar(entry.avatar) && cached && cached.enabled === true
      ? "伴侣 · " + style : style;
    node.textContent = text;
    node.hidden = text.length === 0;
    node.title = "当前方式：" + text + "（点角色名可以改）";
  }

  /** 纯对白（只留引号里的内容；没引号就整段）。跟朗读共用一份规则。 */
  function dialogueSegmentsOf(text) {
    const Voice = window.RoleWorldVoice;
    if (!Voice || typeof Voice.dialogueSegments !== "function") return [];
    try { return Voice.dialogueSegments(text); } catch (_) { return []; }
  }

  /**
   * 这一条 part **算语音还是算文字** —— 判断只写在这里一处。
   *
   * ⚠ 为什么不能只看 `kind === "voice"`：状态推进过程中，"说好要发语音"的那一条
   * 会被标成 `queued` / `synthesizing` / `failed`。它们**仍然是语音消息**
   * （准备中的气泡、失败的气泡），必须按语音渲染 —— 掉回文字渲染就是用户看到的那一闪。
   * 只有用户**主动点「改为文字」**之后，它才真的变成 `kind: "text"`。
   */
  function isVoiceLikePart(part) {
    if (!part) return false;
    if (part.kind === "voice") return true;
    const status = String(part.status || "");
    return status === "queued" || status === "synthesizing" || status === "failed";
  }

  /** 这条 part 现在该交付成什么（交给 voice-core 判一次，界面不自己猜）。 */
  function voiceDeliveryOf(part) {
    const Voice = window.RoleWorldVoice;
    if (!isVoiceLikePart(part)) return { deliver: "text", showText: true };
    if (Voice && typeof Voice.deliveryOf === "function") {
      try { return Voice.deliveryOf(part); } catch (_) { /* 落到下面的兜底 */ }
    }
    return part.key ? { deliver: "voice", showText: false } : { deliver: "voice-pending", showText: false };
  }

  /**
   * 「软件聊天」这一档**文字气泡上显示什么** —— 与语音念的保持一致，但**不改变已有排版**。
   *
   * 分两种情况（刻意保守：老消息看到什么，这一轮之后还是什么）：
   *   · 有引号（模型按"旁白/台词"格式写的）→ 只取引号里的对白（跟以前一模一样）；
   *   · **一个引号都没有**（微信式短句、"纯对白"档）→ 去掉括号描写与没加括号的旁白句。
   *     这一支是 2026-09-14 补的：用户实测「还是有描述性的语句，现在是用语音拨出来的」，
   *     而语音那一侧早就在剥旁白了（`voiceMessageText`）—— 两边规则必须一样。
   */
  function plainChatText(text) {
    const raw = String(text === undefined || text === null ? "" : text);
    const Voice = window.RoleWorldVoice;
    if (Voice && typeof Voice.stripNarration === "function" && !/[“”"「」『』]/.test(raw)) {
      try {
        const cleaned = Voice.stripNarration(String(Voice.stripStageDirections(raw)));
        if (cleaned) return cleaned;
      } catch (_) { /* 落到下面 */ }
    }
    const segments = dialogueSegmentsOf(raw);
    return segments.length ? segments.join("\n") : raw;
  }

  /**
   * 这条回复**有没有按角色设定的语言说话**（用户 2026-09-14：语言是角色的交流规则，
   * 输入其他语言时角色仍按已设语言回复；不合语言的回复**不能**交给错误语言的音色）。
   *
   * 这里只做两件事，都**不额外花一次模型请求**：
   *   ① 判定 → 不合时在界面上给一句可恢复的说明（原文照常显示，一个字都不删）；
   *   ② 把结论交给语音那一侧：合成之前会拦住它（`synthesizeOneVoicePart`）。
   * 返回 null = 没问题（或者这个角色还没确认语言，见 language-core 的迁移口径）。
   */
  function languageVerdictFor(entry, text) {
    const Language = window.RoleWorldLanguage;
    if (!Language || typeof Language.checkResponseLanguage !== "function") return null;
    const want = characterLanguageFor(entry);
    if (!want) return null;
    let verdict = null;
    try { verdict = Language.checkResponseLanguage(text, want); } catch (_) { return null; }
    if (!verdict || verdict.ok) return null;
    return { language: want, detected: verdict.detected || null, reason: verdict.reason || "" };
  }

  /**
   * 角色发来的**语音消息**（微信式）：一个气泡，**点一下才播**。
   *
   * 为什么点一下才播、不自动播：浏览器**不允许"没交互就出声"**（autoplay 策略），
   * 而微信式语音的交互本来就是"点一下"——正好绕开它。
   *
   * 2026-09-14 起这个函数要管**三种状态**（用户实测反馈：「先看到文字 → 文字消失 → 出现语音」）：
   *   queued / synthesizing —— 「语音准备中」气泡：转圈 + 提示，**不显示正文**；
   *   ready                —— 可播放气泡（▶ + 时长）；
   *   failed               —— 失败气泡 + 「重试」+「改为文字」，**也不显示正文**。
   * 三种状态用**同一个 `.voice-bubble` 位置**渲染，所以状态推进时是**原位替换**，
   * 不会让这一条重新入场或者把下面的消息顶上顶下。
   */
  function buildVoiceBubble(message, index, voice, partIndex) {
    const status = String((voice && voice.status) || "ready");
    const wrap = document.createElement("div");
    wrap.className = "voice-bubble";
    // 状态写在 DOM 上：用例据此断言"中间帧没有正文"，样式也据此显示对应的那一态。
    wrap.dataset.voiceState = status;
    wrap.dataset.voiceIndex = String(index);
    // 这条语音是这一轮里的第几条（分条之后语音就是独立的一条消息）。
    // 点击时按它回到 `extra.roleworld_parts[n]` 取缓存键 —— 老消息没有它，回落到 roleworld_voice。
    if (partIndex !== undefined && partIndex !== null) wrap.dataset.voicePart = String(partIndex);
    const spoken = String(voice.text || "");

    if (status === "queued" || status === "synthesizing" || status === "failed") {
      const pending = status !== "failed";
      const box = document.createElement("div");
      box.className = "voice-bubble-state" + (pending ? " is-pending" : " is-failed");
      const icon = document.createElement("span");
      icon.className = "voice-bubble-icon";
      icon.textContent = pending ? "◌" : "!";
      const label = document.createElement("span");
      label.className = "voice-bubble-label";
      label.textContent = pending ? "语音准备中…" : "这条语音没做出来";
      box.append(icon, label);
      wrap.appendChild(box);
      if (!pending) {
        // 失败时给出**怎么办**：重试（有次数上限）或改成文字。正文一个字都没丢，
        // 点「改为文字」才显示出来 —— 这正是"用户主动选择的改为文字"。
        //
        // ⚠ 屏幕上一个字都不能有（用户 2026-09-14：「我说了就语音，不要文字也不要描述」）。
        //   这里那个 `.voice-bubble-text` 只是给读屏/用例用的**隐藏**副本，必须 `hidden`，
        //   与 ready 那一条一致 —— 漏掉 `hidden` 的话文字会直接显示在气泡下面
        //   （完整套件实测：`语音合成失败` 那条红成"还没点改为文字，正文就露出来了"）。
        const note = document.createElement("p");
        note.className = "voice-bubble-note";
        note.textContent = String(voice.note || "合成没成功。");
        wrap.appendChild(note);
        const actions = document.createElement("div");
        actions.className = "voice-bubble-actions";
        const attempts = Number(voice.retry) || 0;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "voice-bubble-action";
        retry.dataset.voiceAction = "retry";
        // 到顶之后**必须**把"已试几次"写在按钮上：只写「重试」而按钮是灰的，
        // 用户不知道是自己点不动还是应用坏了（这个项目最忌讳的"点了没反应"）。
        retry.textContent = attempts >= VOICE_RETRY_MAX ? ("重试（已试 " + attempts + " 次）") : "重试";
        retry.disabled = attempts >= VOICE_RETRY_MAX || !message;
        retry.title = retry.disabled
          ? ("同一条最多重试 " + VOICE_RETRY_MAX + " 次，免得一直花钱。可以点「改为文字」。")
          : "再合成一次（会用一点语音额度）";
        const toText = document.createElement("button");
        toText.type = "button";
        toText.className = "voice-bubble-action";
        toText.dataset.voiceAction = "to-text";
        toText.textContent = "改为文字";
        toText.title = "把这条永久改成文字（刷新之后还是文字）";
        actions.append(retry, toText);
        wrap.appendChild(actions);
      }
      // 正文只放在 DOM 里给读屏与用例看，**屏幕上不显示**（`hidden`）。
      // 三种状态（准备中 / 可播放 / 失败）都走这一份，任何一个漏掉 `hidden` 都会让
      // "语音气泡不显示文字"这条用户要求破功。
      const pendingText = document.createElement("p");
      pendingText.className = "voice-bubble-text";
      pendingText.hidden = true;
      pendingText.textContent = spoken;
      wrap.appendChild(pendingText);
      return wrap;
    }

    const play = document.createElement("button");
    play.type = "button";
    play.className = "voice-bubble-play";
    // 无障碍：气泡里**不显示文字**（用户 2026-09-14：「我说了就语音，不要文字也不要描述」——
    // 真实微信里语音就是语音，不会把话打在下面），但读屏要能知道这条说了什么。
    play.setAttribute("aria-label", spoken ? ("播放这条语音：" + spoken.slice(0, 40)) : "播放这条语音");
    const icon = document.createElement("span");
    icon.className = "voice-bubble-icon";
    icon.textContent = "▶";
    const seconds = document.createElement("span");
    seconds.className = "voice-bubble-seconds";
    seconds.textContent = formatVoiceSeconds(voice.seconds);
    play.append(icon, seconds);
    // 气泡的宽度跟着时长走 —— 微信就是这样，一眼能看出哪条长。
    wrap.style.setProperty("--voice-scale", String(Math.max(0.35, Math.min(1, (Number(voice.seconds) || 1) / 12))));
    const text = document.createElement("p");
    text.className = "voice-bubble-text";
    text.hidden = true;                 // 只留 DOM（测试与无障碍用），屏幕上不显示
    text.textContent = spoken;
    wrap.append(play, text);
    return wrap;
  }

  /** 时长显示成微信那样（`3″` / `1′05″`）。**是估算**：按 mp3 的字节数与码率算，不假装精确。 */
  function formatVoiceSeconds(value) {
    const total = Math.max(1, Math.round(Number(value) || 0));
    if (total < 60) return total + "″";
    return Math.floor(total / 60) + "′" + String(total % 60).padStart(2, "0") + "″";
  }

  function renderCompanionRelationOptions() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const select = document.querySelector("#companionRelation");
    if (!core || !select || select.options.length) return;
    for (const row of core.RELATIONS) {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = row.zh;
      select.appendChild(option);
    }
  }

  function renderCompanionRules() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const list = document.querySelector("#companionRuleList");
    if (!core || !list || list.childNodes.length) return;
    for (const rule of core.RULES.zh) {
      const item = document.createElement("li");
      item.textContent = rule;
      list.appendChild(item);
    }
  }

  /** 把表单读成一份档案。不校验的部分交给 core 归一化（截断、去重、日期合法性）。 */
  function readCompanionForm() {
    const read = (selector) => (document.querySelector(selector)?.value || "").trim();
    const num = (selector, fallback) => {
      const value = Number(read(selector));
      return Number.isFinite(value) ? value : fallback;
    };
    const shared = read("#companionShared").split("\n").map((line) => line.trim()).filter(Boolean);
    // 内置小说人物**不给开伴侣**（2026-09-14 用户拍板）：即使页面上的复选框被脚本勾上，
    // 这里也强制读成 false —— 界面挡一道，读表单再挡一道（跟语音那边同一个思路）。
    const access = companionAccessFor(liveState.companionEntry || activeCharacterEntry());
    return {
      enabled: access.allowed && document.querySelector("#companionEnabled")?.checked === true,
      relation: read("#companionRelation") || "friend",
      relationCustom: read("#companionRelationCustom"),
      charCallsUser: read("#companionCharCallsUser"),
      userCallsChar: read("#companionUserCallsChar"),
      since: read("#companionSince"),
      shared: shared,
      // 伴侣模式 v2（2026-09-12）：亲近度 / 冷落反应 / 主动消息。
      affinityMode: document.querySelector("#companionAffinityAuto")?.checked === true ? "auto" : "manual",
      affinity: num("#companionAffinity", 50),
      neglect: read("#companionNeglect") || "soft",
      proactive: {
        enabled: document.querySelector("#companionProactive")?.checked === true,
        minGapHours: num("#companionProactiveGap", 12),
        maxPerDay: num("#companionProactiveMax", 1),
      },
      // 2026-09-14：聊天方式（普通=带动作 / plain=软件聊天、不带动作）。**只有 plain 能发语音。**
      chatStyle: read("#companionChatStyle") === "plain" ? "plain" : "action",
    };
  }

  function renderCompanionCustomRow() {
    const row = document.querySelector("#companionCustomRow");
    const select = document.querySelector("#companionRelation");
    if (row) row.hidden = !(select && select.value === "custom");
  }

  /**
   * 表单 + 上一次的聊天时间 → 一份档案。
   * 表单里没有"上次聊天时间"这个字段（用户不该手填），但保存时不能把它丢掉，
   * 否则每次改完档案，时间感就归零了。
   */
  async function profileFromForm(entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const previous = await loadCompanion(entry);
    return core.normalizeProfile(Object.assign({}, readCompanionForm(), {
      lastChatAt: previous ? previous.lastChatAt : "",
    }));
  }

  /** 面板上的"这份档案会让每轮多发多少" —— 发之前就看得见，和台账一个口径。 */
  async function renderCompanionPreview() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const node = document.querySelector("#companionPreview");
    if (!core || !node) return;
    const entry = activeCharacterEntry();
    const profile = await profileFromForm(entry);
    const off = "伴侣模式没打开：这一轮一个字符都不会多带。";
    if (!profile.enabled) {
      node.textContent = off;
      return;
    }
    const block = companionBlockFor(entry, profile);
    if (!block) {
      node.textContent = off;
      return;
    }
    let tokens = 0;
    try { tokens = window.RoleWorldPricing.estimateTokens(block); } catch (_) { tokens = 0; }
    node.textContent = `每轮会多带约 ${block.length} 字`
      + (tokens ? `（约 ${tokens} token）` : "")
      + `：关系 / 称呼 / 起点 / 今天几号 / 上次聊天时间 + ${core.RULES.zh.length} 条硬规矩`
      + (profile.shared.length ? ` + 你写的 ${profile.shared.length} 件共同经历。` : "。");
  }

  /**
   * 陪伴自检：拿最近若干条回复查一遍"内疚话术"。
   * 只报告，不改写模型的话 —— 过滤会误伤正常表达，而且拦住了不等于没发生。
   */
  function renderCompanionSelfCheck() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const node = document.querySelector("#companionCheck");
    if (!core || !node) return;
    const replies = (liveState.chatMessages || [])
      .filter((message) => message && message.is_user !== true && typeof message.mes === "string" && message.mes)
      .slice(-COMPANION_CHECK_WINDOW);
    if (!replies.length) {
      node.textContent = "自检：这个角色还没有回复可查。";
      return;
    }
    const hits = core.lintManipulationIn
      ? core.lintManipulationIn(replies.map((message) => message.mes))
      : core.lintGuiltIn(replies.map((message) => message.mes)).map((hit) => Object.assign({ kindLabel: "内疚话术" }, hit));
    if (!hits.length) {
      node.textContent = `自检：最近 ${replies.length} 条回复里没有发现内疚 / 威胁 / 排他的话术。`;
      return;
    }
    const sample = hits.slice(0, 3).map((hit) => `「${hit.phrase}」（${hit.kindLabel || "内疚话术"}）`).join("、");
    node.textContent = `自检：最近 ${replies.length} 条回复里有 ${hits.length} 处要留意（${sample}）。`
      + "这几句只是提醒，不会被自动改掉。";
  }

  function fillCompanionForm(profile, entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core) return;
    const p = core.normalizeProfile(profile);
    renderCompanionRelationOptions();
    const set = (selector, value) => { const node = document.querySelector(selector); if (node) node.value = value; };
    const check = (selector, value) => { const node = document.querySelector(selector); if (node) node.checked = value === true; };
    const enabled = document.querySelector("#companionEnabled");
    if (enabled) enabled.checked = p.enabled === true;
    set("#companionRelation", p.relation);
    set("#companionRelationCustom", p.relationCustom);
    set("#companionCharCallsUser", p.charCallsUser);
    set("#companionUserCallsChar", p.userCallsChar);
    set("#companionSince", p.since);
    set("#companionShared", p.shared.map((row) => row.text).join("\n"));
    // 伴侣模式 v2 三个控件
    const affinity = core.affinityOf(p, new Date());
    set("#companionAffinity", String(p.affinity));
    check("#companionAffinityAuto", p.affinityMode === "auto");
    set("#companionNeglect", p.neglect);
    check("#companionProactive", p.proactive.enabled);
    set("#companionProactiveGap", String(p.proactive.minGapHours));
    set("#companionProactiveMax", String(p.proactive.maxPerDay));
    renderCompanionAffinityHint(affinity);
    renderCompanionCustomRow();
    renderCompanionStyleRow(p, entry || liveState.companionEntry || null);
    renderCompanionPreview();
    renderCompanionSelfCheck();
  }

  /**
   * 「它在对话里怎么写」那一行 + 内置角色挡住伴侣开关的说明。
   * 2026-09-14 用户拍板：**内置小说人物不给开伴侣**。
   * 2026-09-16 改名（文档 §5）：普通 → **剧情对话**；软件聊天 → **日常聊天**。
   *   ⚠ 这里不再写"只有这一档能发语音" —— 能不能出声由「角色语音」那个开关决定，
   *     跟这一档无关（用户拍板：朋友也可以发语音）。
   * 判定统一走 companion-core，界面这里只负责把结果画出来 —— 不自己写第二套规则。
   */
  function renderCompanionStyleRow(profile, entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const select = document.querySelector("#companionChatStyle");
    const note = document.querySelector("#companionChatStyleNote");
    const blockedNote = document.querySelector("#companionBlockedNote");
    if (core && select) select.value = core.isPlainChat(profile) ? "plain" : "action";
    if (core && note) {
      note.textContent = core.isPlainChat(profile)
        ? "日常聊天：回复里不会有动作、旁白，只有对白 —— 像真实聊天软件里那样。"
        : "剧情对话：回复里带动作和旁白 —— 像小说里那样。";
    }
    const access = companionAccessFor(entry);
    const row = document.querySelector("#companionEnabledRow");
    const box = document.querySelector("#companionEnabled");
    if (box) box.disabled = !access.allowed;
    if (blockedNote) {
      blockedNote.hidden = access.allowed;
      blockedNote.textContent = access.allowed ? "" : access.reason + "（这条档案仍然留在你的存档里，只是不生效。）";
    }
    if (row) row.classList.toggle("is-blocked", !access.allowed);
  }

  /** 亲近度那一行的实时提示：现在是几分、什么档、手动还是系统算的。 */
  function renderCompanionAffinityHint(affinity) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const valueNode = document.querySelector("#companionAffinityValue");
    const tierNode = document.querySelector("#companionAffinityTier");
    const hintNode = document.querySelector("#companionAffinityHint");
    const slider = document.querySelector("#companionAffinity");
    const auto = document.querySelector("#companionAffinityAuto")?.checked === true;
    if (!core || !hintNode) return;
    const shown = auto ? affinity.suggested : affinity.value;
    if (valueNode) valueNode.textContent = String(shown);
    if (tierNode) tierNode.textContent = core.affinityTier(shown, "zh").label;
    if (slider) {
      slider.disabled = auto;
      if (auto) slider.value = String(shown);
    }
    hintNode.textContent = auto
      ? `系统按「共同经历 + 认识多久 − 多久没聊」算的（现在是 ${shown}）。想自己定就取消勾选，直接拖。`
      : "你自己定的。系统不会偷偷改它；想交回系统就勾上「跟随系统建议」。";
  }

  /** 「关系档案」入口 → 角色面板的「关系」分页（不再单开一个弹窗）。 */
  async function openCompanionDialog() {
    await openCharacterPanel("relationship");
  }

  function closeCompanionDialog() {
    closeCharacterPanel();
  }

  async function submitCompanionDialog() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    const entry = liveState.companionEntry || activeCharacterEntry();
    const error = document.querySelector("#companionError");
    if (!core || !entry || !entry.avatar) return;
    const next = core.touch(await profileFromForm(entry), new Date().toISOString());
    // 第一次打开、又还没聊过：把"上次聊天"对齐到当前这段对话的最后一句，
    // 否则时间感要等到下一轮才出现（用户会觉得"开了没用"）。
    if (next.enabled && !next.lastChatAt) {
      const messages = liveState.chatMessages || [];
      const last = messages[messages.length - 1];
      if (last && last.send_date) next.lastChatAt = String(last.send_date);
    }
    // 打开伴侣模式却什么都没写：照样能存，但要说清楚存的是什么。
    if (error) { error.textContent = ""; error.hidden = true; }
    try {
      await saveCompanion(entry, next);
    } catch (err) {
      if (error) {
        error.textContent = err && err.message ? `保存失败：${err.message}` : "保存失败，请重试。";
        error.hidden = false;
      }
      return;
    }
    closeCompanionDialog();
    // 刚保存的这一份就是当前角色的方式：顶栏那个「当前方式」小字与语音入口立刻跟上，
    // 不让用户等到下次切角色才看到变化（2026-09-16：改了方式顶栏还写着旧的）。
    renderTopbarMode();
    updateReplyVoiceToggle();
    showToast(next.enabled
      ? (core.hasDetails(next) ? "伴侣模式已打开，下一轮开始生效" : "伴侣模式已打开（还没写内容，只有那几条硬规矩）")
      : "伴侣模式已关闭，下一轮不再带上关系档案");
  }

  /** 聊过一轮之后记下时间，下一轮的时间感才有依据（"上次聊天是 3 天前"）。 */
  async function markCompanionChat(entry) {
    const core = window.ROLEWORLD_COMPANION_CORE;
    if (!core || !entry || !entry.avatar) return;
    try {
      const profile = await loadCompanion(entry);
      if (!profile || profile.enabled !== true) return;
      await saveCompanion(entry, core.markChat(profile, new Date().toISOString()));
    } catch (_) { /* 记不上时间不影响对话 */ }
  }

  /* ---------- 用量与费用估算 ---------- */
  const COST_KEY_PREFIX = "usage:";
  // 一次性回执：这一轮是否已经落盘。用于挡掉「保存其实成功、界面却当失败 → 重发 →
  // 同一条写两遍 + 模型被计费两次」。
  const TURN_RECEIPT_PREFIX = "turn:";

  function costKey(avatar, fileName) {
    return COST_KEY_PREFIX + avatar + ":" + fileName;
  }

  function turnReceiptKey(avatar, fileName) {
    return TURN_RECEIPT_PREFIX + avatar + ":" + fileName;
  }

  // 回执通道：走与费用累计同一个本地 store，不新增存储层。
  const turnReceipts = {
    get: (avatar, fileName) => window.RoleWorld.store.getKV(turnReceiptKey(avatar, fileName), null),
    set: (avatar, fileName, value) => window.RoleWorld.store.setKV(turnReceiptKey(avatar, fileName), value),
  };

  // 本轮标识：新的一次发送生成新 id，重发同一句沿用同一个 id，重试才能被认成同一轮。
  function newTurnId() {
    const nonce = (window.crypto && typeof window.crypto.randomUUID === "function")
      ? window.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return Date.now().toString(36) + "-" + nonce;
  }

  // 「上一次保存结果不确定」只记在内存里：它描述的是"紧接着的那一次重发"。
  // 正常发送完全不碰这条路径，不给普通对话增加任何多余的读写。
  function markSaveAttempted(session, turnId) {
    if (!session || !session.avatar || !session.fileName) return;
    liveState.uncertainSave = { avatar: session.avatar, fileName: session.fileName, turnId };
  }

  function clearSaveAttempted() {
    liveState.uncertainSave = null;
  }

  // 这一轮是否其实已经存过了。只在「上次保存结果不确定」时才去本地库确认一次。
  async function turnAlreadySaved(session, turnId) {
    if (!session || !session.avatar || !session.fileName || !turnId) return false;
    try {
      const stored = await turnReceipts.get(session.avatar, session.fileName);
      return !!(stored && stored.turnId === turnId);
    } catch (_) {
      return false;
    }
  }

  /** 这一轮**到底有没有写进本机文件** —— 保存失败分类的权威判据。
   *  先看回执（快），回执不在时直接翻一次本机文件里有没有这一轮的 `roleworld_turn_id`。
   *  为什么要多这一步（2026-09-17 只读复核指出，实测复现）：
   *    · 回执本身是 try/catch 写进去的，写失败会被吞掉；
   *    · 「重新回答」走 persistMessages 写盘，**根本不写回执**。
   *  只看回执时，这两种情况会把**已经存好**的一轮误报成"没能写进本机文件"。
   *  只在这条失败路径上多一次本地读，正常发送不受影响。 */
  async function turnCommittedToDisk(session, turnId) {
    if (!session || !turnId) return false;
    if (await turnAlreadySaved(session, turnId).catch(() => false)) return true;
    try {
      const fileName = session.storageFileName || session.fileName;
      if (!fileName) return false;
      const lines = await window.STApi.getChat(session.avatar, fileName);
      return (Array.isArray(lines) ? lines : []).some((line) => !!(line && line.extra
        && line.extra.roleworld_turn_id === turnId));
    } catch (_) {
      return false;
    }
  }

  function emptyCost() {
    return { input: 0, output: 0, cost: 0, turns: 0, last: null };
  }

  function currentPrices() {
    const settings = liveState.localSettings || {};
    return window.RoleWorldPricing.pricesFor(
      liveState.modelName,
      { input: settings.price_input, output: settings.price_output },
      new Date()
    );
  }

  /* ---------- 角色记忆：按角色归属 + 模型自动记 ---------- */
  const AUTO_MEMORY_BOOK = "自动记忆";
  // 上限默认值。用户可以在「设置 → 模型」里改（auto_memory_max），
  // 因为"记多少条"跟模型上下文与个人习惯有关，写死一个数字不合适。
  const AUTO_MEMORY_MAX_DEFAULT = 50;

  function autoMemoryMax() {
    const value = Number(liveState.localSettings && liveState.localSettings.auto_memory_max);
    if (!Number.isFinite(value) || value <= 0) return AUTO_MEMORY_MAX_DEFAULT;
    // 下限 5 条（再少就没意义了），上限 500 条（再多会吃掉大量上下文）。
    return Math.min(500, Math.max(5, Math.floor(value)));
  }

  // 把模型给的要点写进「MB <角色短名> — 自动记忆」。
  // 每条记下来源（哪段对话的第几条消息、什么时候、谁写的）与主题；
  // 同一主题的新记忆会**替换**旧的（"改口"才会生效），被替换与被挤掉的都会返回给调用方。
  async function rememberForCharacter(entry, memories, source) {
    const core = window.TASK29_CHARACTER_CORE;
    const memory = window.ROLEWORLD_MEMORY_CORE;
    if (!entry || !entry.avatar || !core || !memory || !memories.length) {
      return { added: 0, skipped: 0, replaced: [], rejected: [], removed: [] };
    }
    const bookName = core.newMemoryBookName(entry, AUTO_MEMORY_BOOK);
    let data = { entries: {} };
    try {
      const existing = await window.STApi.getWorld(bookName);
      if (existing && existing.entries) data = existing;
    } catch (_) { /* 还没有这本书，下面新建 */ }
    const result = memory.applyMemories(data.entries || {}, memories, {
      max: autoMemoryMax(),
      // 记忆取向：平衡只收事实；剧情取向才收剧情（并标明是剧情）。
      orientation: await loadOrientation(entry),
      source: Object.assign({ origin: memory.ORIGIN.MODEL }, source || {}),
    });
    if (!result.added) return result;
    // getWorld 返回的是 {entries}，editWorld 也按同一形状写回，其余字段原样保留。
    await window.STApi.editWorld(bookName, Object.assign({}, data, { entries: result.entries }));
    return result;
  }

  /** 读某个角色的「自动记忆」书（供界面展示与增删改）。 */
  async function readAutoMemory(entry) {
    const core = window.TASK29_CHARACTER_CORE;
    const memory = window.ROLEWORLD_MEMORY_CORE;
    if (!entry || !entry.avatar || !core || !memory) return { bookName: "", entries: {}, rows: [] };
    const bookName = core.newMemoryBookName(entry, AUTO_MEMORY_BOOK);
    let data = { entries: {} };
    try {
      const existing = await window.STApi.getWorld(bookName);
      if (existing && existing.entries) data = existing;
    } catch (_) { /* 还没有这本书 */ }
    return { bookName, entries: data.entries || {}, rows: memory.listEntries(data.entries || {}) };
  }


  async function loadCostFor(session) {
    liveState.cost = emptyCost();
    if (session && session.avatar && session.fileName) {
      try {
        const stored = await window.RoleWorld.store.getKV(costKey(session.avatar, session.fileName), null);
        if (stored && typeof stored === "object") liveState.cost = Object.assign(emptyCost(), stored);
      } catch (_) { /* 读不到就当没有 */ }
    }
    renderCostLine();
  }

  async function recordCost(session, usage) {
    if (!session || !usage) return;
    const pricing = window.RoleWorldPricing;
    const cost = pricing.costOf(usage, currentPrices());
    const totals = Object.assign(emptyCost(), liveState.cost || {});
    totals.input += usage.input || 0;
    totals.output += usage.output || 0;
    totals.cost += cost;
    totals.turns += 1;
    totals.last = {
      input: usage.input, output: usage.output, cost, exact: usage.exact === true,
      cacheHit: Math.max(0, Number(usage.cacheHit) || 0),
    };
    liveState.cost = totals;
    renderCostLine();
    if (session.avatar && session.fileName) {
      try { await window.RoleWorld.store.setKV(costKey(session.avatar, session.fileName), totals); } catch (_) { /* 存不下不影响对话 */ }
    }
  }

  function renderCostLine() {
    const node = document.querySelector("#chatCostLine");
    if (!node) return;
    const pricing = window.RoleWorldPricing;
    const settings = liveState.localSettings || {};
    // 悬停给出完整口径：币种、当前时段、高峰翻倍、来源。免得对着官方英文页（美元报价）以为价格不对。
    const info = pricing.describe(liveState.modelName, {
      input: settings.price_input,
      output: settings.price_output,
    }, new Date());
    node.title = info.title;
    const totals = liveState.cost || emptyCost();
    if (!totals.turns) { node.textContent = ""; return; }
    const prices = currentPrices();
    const approx = totals.last && totals.last.exact === false ? "≈" : "";
    const unit = prices.output > 0
      ? ` · 单价 ¥${prices.input}/¥${prices.output} 每百万 tokens（${prices.period}时段）`
      : "";
    // 用户 2026-09-12：「输入框里面的这些字太多了，而且还显示不全」。
    // 这一轮先把**显示不全**解决掉（见 styles.css `.composer-meta-line` 允许换行）；
    // 文案精简要连测试口径一起改（有几条用例断言这里必须有 token 数字），留到下一轮。
    node.textContent = `本对话 ${totals.turns} 轮 · 输入 ${pricing.formatTokens(totals.input)} / 输出 ${pricing.formatTokens(totals.output)} tokens · 累计 ${approx}${pricing.formatCost(totals.cost)}${unit}`;
    node.title = "这一行的细账：轮数 / 输入输出 token / 累计费用 / 单价与时段。实际账单以服务商为准。";
  }

  /* ---------- P2-1 发送前预估 / P2-2 输出上限与上下文分开 ----------
   * 以前只能在发完之后从「本次请求」回看花了多少。这里在**发送前**就说清：
   *   这次大概要发多少输入、按当前单价大概多少钱、输出上限是多少、上下文还剩多少。
   * 估法的口径是"上一轮真实值 + 这一轮草稿"：
   *   - 上一轮接口回了 usage 就用真值（输入 token 与缓存命中都是真的）；
   *   - 加上上一轮它说的那句（下一轮会进历史）+ 你现在输入框里的草稿；
   * 不额外发请求、不落盘、不再拼一遍提示词（拼出来的只会是另一个近似值）。
   * 没打过字/没有上一轮的时候，只报"输出上限 + 上下文"这两件确定的事。
   */
  function lastAssistantText() {
    const messages = liveState.chatMessages || [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message && message.is_user !== true && typeof message.mes === "string" && message.mes) return message.mes;
    }
    return "";
  }

  /**
   * 生成参数（设置 → 模型 → 生成参数）：预设 + 手填的温度/top_p + 输出上限。
   * 只有 preset === "manual" 时温度/top_p 才生效 —— 这样旧版本存下的 0.8/0.9
   * 不会把"跟随用途"这件事悄悄钉死。
   */
  function samplingOptions() {
    const settings = liveState.localSettings || {};
    const preset = String(settings.sampling_preset || "auto");
    const manual = preset === "manual";
    const maxTokens = Number(settings.max_tokens);
    return {
      preset,
      temperature: manual ? settings.temperature : undefined,
      topP: manual ? settings.top_p : undefined,
      // 32768 与渠道默认一致 => 视为"没设"，避免把默认值当成用户设置。
      maxOutput: Number.isFinite(maxTokens) && maxTokens > 0 && maxTokens !== 32768 ? maxTokens : undefined,
    };
  }

  /** 上下文上限：DeepSeek 官方按 1M；本地/自定义端点按设置里填的值（默认 32768）。 */
  function contextBudgetOptions() {
    const settings = liveState.localSettings || {};
    const mode = liveState.modelMode || "local";
    const known = window.TASK22_CORE && window.TASK22_CORE.isDeepSeekChatMode(mode);
    const local = Number(settings.local_context);
    // 这个设置只对本地 / 自定义端点生效。**不能拿它去套 DeepSeek 官方**：
    // 官方是 1M 上下文、输出上限 32768，用 32768 当上下文会让"输入 + 输出"必然超限，
    // 结果是每一次发送都被自己的预检拦下来（这个坑刚踩过一次）。
    return {
      mode: mode,
      contextLimit: !known && Number.isFinite(local) && local >= 2000 ? local : undefined,
    };
  }

  function estimateNextRequest() {
    const pricing = window.RoleWorldPricing;
    const core = window.TASK22_CORE;
    if (!pricing || !core) return null;
    const mode = liveState.modelMode || "local";
    const output = core.outputLimitFor(mode, undefined, samplingOptions().maxOutput);
    const context = core.contextLimitFor(mode, contextBudgetOptions().contextLimit);
    const draft = ($("#messageInput") && $("#messageInput").value ? $("#messageInput").value : "").trim();
    const draftTokens = draft ? pricing.estimateTokens(draft) : 0;
    // 基线用台账里上一轮的值：接口回了 usage 就是真值，没回就是按字数估的（exact=false）。
    const last = (liveState.cost && liveState.cost.last) || null;
    if (!last) {
      return {
        known: false, draftTokens: draftTokens, output: output, context: context,
        input: draftTokens, cacheHit: 0, cost: 0, cachedCost: 0,
      };
    }
    // 下一轮 = 这一轮发出去的 + 它这句回复（会变成历史）+ 你新写的这句。
    const input = Math.max(0, Number(last.input) || 0)
      + pricing.estimateTokens(lastAssistantText())
      + draftTokens;
    const cacheHit = Math.min(Math.max(0, Number(last.cacheHit) || 0), input);
    const prices = currentPrices();
    return {
      known: true, draftTokens: draftTokens, output: output, context: context,
      input: input,
      cacheHit: cacheHit,
      exact: last.exact === true,
      cost: pricing.costOf({ input: input, output: 0, cacheHit: 0 }, prices),
      cachedCost: pricing.costOf({ input: input, output: 0, cacheHit: cacheHit }, prices),
      period: prices.period,
    };
  }

  function renderSendEstimate() {
    const node = document.querySelector("#chatEstimateLine");
    if (!node) return;
    // 花费与预估搬进「本次请求」面板之后，这个入口就是看它们唯一的门：
    // 估值一算完（或者输入框里已有草稿）就把门露出来，别让第一条消息看不到预估。
    const revealEntry = () => { try { setRequestPeekVisible(); } catch (_) { /* 入口不影响对话 */ } };
    const pricing = window.RoleWorldPricing;
    const core = window.TASK22_CORE;
    const estimate = estimateNextRequest();
    if (!pricing || !core || !estimate) { node.hidden = true; node.textContent = ""; revealEntry(); return; }
    const outputNote = `输出上限 ${pricing.formatTokens(estimate.output)}`;
    const contextNote = `上下文 ${pricing.formatTokens(estimate.context)}`;
    if (!estimate.known) {
      // 还没打过一轮：只能报确定的两件事（输出上限、上下文），不编输入量。
      node.textContent = `输出上限 ${pricing.formatTokens(estimate.output)} · 上下文 ${pricing.formatTokens(estimate.context)}`;
      node.title = "还没有上一轮可对照：发出第一轮之后，这里会显示「这次大约要发多少输入、大概多少钱」。";
      node.hidden = false;
      revealEntry();
      return;
    }
    const share = estimate.context > 0 ? Math.round((estimate.input / estimate.context) * 100) : 0;
    node.textContent = `这次约 ${pricing.formatTokens(estimate.input)} 输入 ≈ ${pricing.formatCost(estimate.cost)}`
      + (estimate.cacheHit > 0 ? `（命中缓存 ≈ ${pricing.formatCost(estimate.cachedCost)}）` : "")
      + ` · ${outputNote}`;
    node.title = [
      "发送前预估（本地算，不额外发请求）：",
      `· 输入约 ${estimate.input} token（其中 ${estimate.cacheHit} 是上一轮命中缓存的部分）`,
      `· 按当前单价（${estimate.period || ""}）估算费用：全未命中 ${pricing.formatCost(estimate.cost)}`
        + (estimate.cacheHit > 0 ? `，命中缓存 ${pricing.formatCost(estimate.cachedCost)}` : ""),
      `· ${outputNote}、${contextNote}：输入已占上下文约 ${share}%`,
      `· 输出费用另算（这一轮它会说多少现在还不知道）`,
      estimate.draftTokens ? `· 其中你刚输入的草稿约 ${estimate.draftTokens} token` : "· 输入框是空的，发出去之前还会加上你写的内容",
      estimate.exact === false ? "· 上一轮接口没回用量，基线是按字数估的，只能看量级" : "· 基线是上一轮接口回的真实用量",
      "上一轮的真实用量见下方「本对话 N 轮」与「本次请求」面板。",
    ].join("\n");
    node.hidden = false;
    revealEntry();
  }

  /* ---------- Task-29A：角色注册表与单角色绑定 ---------- */

  function isUnboundBlank(session) {
    return !!session && !session.avatar && !session.serverSaved
      && (!session.messages || session.messages.length === 0);
  }

  // 当前会话的有效角色：已绑定 → 绑定角色；空白未绑定 → 待选角色，缺省 Harry（1.2 判定）。
  function activeCharacterEntry() {
    const session = liveState.activeSession;
    if (session && session.avatar) return { avatar: session.avatar, charName: session.charName || "" };
    const pending = session && session.pendingAvatar
      ? liveState.characters.find((entry) => entry.avatar === session.pendingAvatar)
      : null;
    return pending || liveState.defaultCharacter || { avatar: "", charName: "" };
  }

  // Harry 保持基线文案「Harry」；其他角色用卡面展示名。
  function activeCharacterShortName() {
    const entry = activeCharacterEntry();
    if (entry.avatar && liveState.harryAvatar && entry.avatar === liveState.harryAvatar) return "Harry";
    return entry.charName || "Harry";
  }

  function renderCharacterPicker() {
    const picker = document.querySelector("#characterPicker");
    if (!picker) return;
    const session = liveState.activeSession;
    const show = !!live && liveState.templateReady && isUnboundBlank(session) && liveState.characters.length > 0;
    picker.hidden = !show;
    if (!show) { setPickerMenuOpen(false); return; }
    const entry = activeCharacterEntry();
    const name = document.querySelector("#characterPickerName");
    if (name) name.textContent = entry.charName || entry.avatar;
    const trigger = document.querySelector("#characterPickerTrigger");
    if (trigger) {
      trigger.disabled = liveState.pending || liveState.switching;
      trigger.title = `当前角色：${entry.charName || entry.avatar}，发送前可更换；发送后本对话固定为该角色`;
    }
    if (liveState.pickerOpen) renderCharacterPickerMenu();
  }

  function renderCharacterPickerMenu() {
    const menu = document.querySelector("#characterPickerMenu");
    if (!menu) return;
    menu.textContent = "";
    const selected = activeCharacterEntry();
    for (const entry of liveState.characters) {
      const item = document.createElement("button");
      item.type = "button";
      const current = entry.avatar === selected.avatar;
      item.className = `character-picker-item${current ? " is-selected" : ""}`;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", current ? "true" : "false");
      item.dataset.avatar = entry.avatar;
      const label = document.createElement("span");
      label.className = "character-picker-item-name";
      label.textContent = entry.charName || entry.avatar;
      // Task-33A：内置角色显示轻量「内置」标记（无粗黑边框）。
      if (isBuiltinAvatar(entry.avatar)) {
        const badge = document.createElement("span");
        badge.className = "builtin-badge";
        badge.textContent = "内置";
        label.appendChild(badge);
      }
      const check = document.createElement("span");
      check.className = "character-picker-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = current ? "✓" : "";
      item.append(label, check);
      menu.appendChild(item);
    }
    // Task-29A：菜单底部操作 —— AI 创建角色 / 导入角色文件（非角色条目）。
    const sep = document.createElement("div");
    sep.className = "character-picker-sep";
    sep.setAttribute("aria-hidden", "true");
    menu.appendChild(sep);
    for (const [action, text] of [["ai-create", "AI 创建角色"], ["import-file", "导入角色文件"]]) {
      const act = document.createElement("button");
      act.type = "button";
      act.className = "character-picker-action";
      act.dataset.action = action;
      act.textContent = text;
      menu.appendChild(act);
    }
  }

  function setPickerMenuOpen(open) {
    liveState.pickerOpen = !!open;
    const menu = document.querySelector("#characterPickerMenu");
    const trigger = document.querySelector("#characterPickerTrigger");
    if (menu) {
      menu.hidden = !liveState.pickerOpen;
      if (liveState.pickerOpen) renderCharacterPickerMenu();
    }
    if (trigger) trigger.setAttribute("aria-expanded", liveState.pickerOpen ? "true" : "false");
  }

  function toggleCharacterPicker() {
    if (liveState.pending || liveState.switching) return;
    const picker = document.querySelector("#characterPicker");
    if (!picker || picker.hidden) return;
    setPickerMenuOpen(!liveState.pickerOpen);
  }

  // T3：只更新未绑定会话的待选角色；不写任何存储、不产生服务器文件。
  function selectCharacterForActive(avatarValue) {
    setPickerMenuOpen(false);
    const session = liveState.activeSession;
    if (!session || !isUnboundBlank(session)) return;
    const entry = liveState.characters.find((candidate) => candidate.avatar === avatarValue);
    if (!entry) return;
    session.pendingAvatar = entry.avatar;
    session.pendingCharName = entry.charName;
    // Task-29F：选中角色后立即刷新顶部标题/侧栏与记忆面板，不再停留显示 Harry。
    liveState.charName = entry.charName || liveState.charName;
    renderActiveCharacterIdentity();
    applyMemoryPanelFilter();
    renderCharacterPicker();
    renderChatList();
    updateComposerLive();
    document.querySelector("#messageInput")?.focus();
  }

  /* ---------- Task-29A：AI 创建角色（两阶段）+ 原生角色文件导入 ---------- */

  const AI_FIELDS = [
    ["aiEditName", "name"],
    ["aiEditDescription", "description"],
    ["aiEditPersonality", "personality"],
    ["aiEditScenario", "scenario"],
    ["aiEditFirstMes", "first_mes"],
    ["aiEditMesExample", "mes_example"],
  ];

  function setAiPhase(phase) {
    liveState.aiPhase = phase;
    const desc = document.querySelector("#aiCreateDescriptionPhase");
    const brief = document.querySelector("#aiCreateBriefPhase");
    const edit = document.querySelector("#aiCreateEditPhase");
    if (desc) desc.hidden = phase !== "description";
    if (brief) brief.hidden = phase !== "brief";
    if (edit) edit.hidden = phase !== "edit";
    const title = document.querySelector("#aiCreateTitle");
    if (title) {
      title.textContent = phase === "edit" ? "编辑角色草稿" : (phase === "brief" ? "角色提示词" : "创建角色");
    }
  }

  function setAiBusy(busy, buttonId) {
    liveState.aiBusy = !!busy;
    const labels = {
      "#aiSkipBriefButton": "跳过，直接生成",
      "#aiBriefButton": "生成提示词",
      "#aiBriefRetryButton": "重新扩写",
      "#aiBriefNextButton": "用这份提示词生成角色卡",
    };
    const btn = buttonId && document.querySelector(buttonId);
    if (btn) {
      btn.disabled = !!busy;
      btn.textContent = busy ? "生成中…" : (labels[buttonId] || "重新生成");
    }
    setAiError("");
  }

  /**
   * 这一页的错误行：`message` 为空就是"没有错误"。
   *
   * `options.settingsLink === true` 时**顺带在错误行里挂一颗「去设置连接方式」**——
   * 有些错误用户是能自己修的（没配连接、Key 没存），只在文字里写"去设置里改"等于让他自己找
   *（这个项目最忌讳的就是"说了等于没说"）。
   */
  function setAiError(message, options) {
    const opts = options || {};
    const phase = opts.phase || liveState.aiPhase;
    const id = phase === "edit" ? "aiEditError" : (phase === "brief" ? "aiBriefError" : "aiCreateError");
    const error = document.querySelector("#" + id);
    if (!error) return;
    error.textContent = message || "";
    error.hidden = !message;
    renderAiErrorSettingsLink(error, message && opts.settingsLink === true);
  }

  /** 错误行里那颗「去设置连接方式」（只在需要时出现；重复调用不会叠加）。 */
  function renderAiErrorSettingsLink(node, want) {
    if (!node) return;
    const existing = node.querySelector("[data-ai-error-settings]");
    if (!want) { if (existing) existing.remove(); return; }
    if (existing) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plain-button";
    button.dataset.aiErrorSettings = "1";
    button.textContent = "去设置连接方式";
    button.addEventListener("click", () => {
      closeAiCreateDialog();
      const UI = window.TASK25C_UI;
      try {
        if (UI && typeof UI.openSettings === "function") UI.openSettings();
        if (UI && typeof UI.setSettingsSection === "function") UI.setSettingsSection("connection");
      } catch (_) { /* 打不开设置也不影响关掉对话框 */ }
    });
    node.appendChild(button);
  }

  function openAiCreateDialog() {
    if (liveState.pending || liveState.switching) return;
    setPickerMenuOpen(false);
    liveState.aiDialogOpen = true;
    liveState.aiDescription = "";
    liveState.aiDraft = null;
    liveState.aiBrief = "";
    liveState.aiCalls = 0;
    liveState.draftFlow = window.TASK29_CHARACTER_CORE.createDraftFlow();
    setAiPhase("description");
    setAiBusy(false, "#aiBriefButton");
    setAiError("");
    const input = document.querySelector("#aiDescriptionInput");
    if (input) { input.value = ""; }
    const briefInput = document.querySelector("#aiBriefInput");
    if (briefInput) { briefInput.value = ""; }
    // Task-29G：打开对话框时语言下拉复位为“自动判断”。
    const lang = document.querySelector("#aiLanguageSelect");
    if (lang) lang.value = "auto";
    const dialog = document.querySelector("#aiCreateDialog");
    if (dialog) {
      window.TASK25C_UI?.rememberDialogFocus?.("aiCreateDialog");
      dialog.hidden = false;
      window.TASK25C_UI?.syncOverlayScrollLock?.();
    }
    if (input) input.focus();
    renderAiDescriptionCount();
  }

  function closeAiCreateDialog() {
    liveState.aiDialogOpen = false;
    liveState.aiDraft = null;
    if (liveState.draftFlow) liveState.draftFlow.cancel();
    liveState.draftFlow = null;
    const dialog = document.querySelector("#aiCreateDialog");
    if (dialog) dialog.hidden = true;
    window.TASK25C_UI?.syncOverlayScrollLock?.();
    window.TASK25C_UI?.restoreDialogFocus?.("aiCreateDialog");
    setAiError("");
    updateComposerLive();
  }

  function renderAiDescriptionCount() {
    const input = document.querySelector("#aiDescriptionInput");
    const count = document.querySelector("#aiDescriptionCount");
    if (!input || !count) return;
    const len = input.value.trim().length;
    count.textContent = `${len} / 4000 字符${len < 20 ? "（至少 20 字）" : ""}`;
  }

  function renderAiBriefCount() {
    const input = document.querySelector("#aiBriefInput");
    const count = document.querySelector("#aiBriefCount");
    if (!input || !count) return;
    const limits = window.TASK29_CHARACTER_CORE.BRIEF_LIMITS;
    const len = input.value.trim().length;
    const note = len === 0 ? "（空的：请写点内容，或返回改成直接生成）"
      : len < limits.min ? `（偏短，建议 ${limits.min} 字以上；太短的话卡会变薄）`
        : len > limits.max ? `（偏长，超过 ${limits.max} 字会被截断）`
          : "（长度合适）";
    count.textContent = `${len} / ${limits.max} 字符${note}`;
  }

  function validateAiDescription() {
    const text = (document.querySelector("#aiDescriptionInput")?.value || "").trim();
    if (text.length < 20) { setAiError("角色描述至少需要 20 个字符。"); return null; }
    if (text.length > 4000) { setAiError("角色描述不能超过 4000 字符。"); return null; }
    liveState.aiDescription = text;
    return text;
  }

  /* ---------- 第一步：扩写成角色提示词 ---------- */
  const AI_CALL_BUDGET = 5;

  /**
   * 连接**能不能真的发出去**。
   *
   * 只拦那种"**注定 401**"的组合，别的一律放行 —— 不能因为查不到 Key 就把能用的配置也拦掉：
   *   · 服务商是**预设**（deepseek / openai / …）而且没有那一份凭据 → 拦住。
   *     这正是用户报的那种：存档里 endpoint 是空的、密钥位只有一个用过的卡号，
   *     地址会回落到 `api.deepseek.com` 而凭据位是空的，请求一定 401。
   *   · `custom` 端点（自己填的地址，也可能是本机/内网端点）→ **照常发**：
   *     有的端点根本不需要 Key（本地模型、测试用的假服务端），拦下来反而是错的。
   *   · 用卡 → 卡号就是凭据，本来就在。
   */
  async function aiConnectionHasCredential(connection) {
    if (!connection || !connection.endpoint) return { ok: false, reason: "no-endpoint" };
    // 自己填的地址（或在用卡）不在这儿判：那条路既可能自带凭据、也可能压根不需要。
    if (connection.via !== "preset") return { ok: true, provider: connection.provider || "custom" };
    const Model = window.RoleWorldModel;
    const adapter = window.RoleWorld;
    const provider = connection.provider || "";
    let key = "";
    try {
      if (adapter && adapter.secrets && Model && typeof Model.secretKeyFor === "function") {
        const record = await adapter.secrets.get(Model.secretKeyFor({ provider }));
        key = String((record && record.value) || "").trim();
      }
    } catch (_) { key = ""; }
    if (key) return { ok: true, provider, keyKind: /^RW-/i.test(key) ? "card" : "key" };
    return { ok: false, reason: "no-credential", provider };
  }

  /**
   * AI 写角色这一路**该走哪条连接**：现在在用体验卡就走卡的中转，否则走你自己配的那条。
   *
   * 为什么要有这个函数（2026-09-16 用户实测报的 bug，报错原话：
   * 「扩写失败：模型接口返回 HTTP 401：Authentication Fails (governor)」）：
   *   扩写用的是一个**很老的 SillyTavern 形状**的载荷（`custom_url` 从
   *   `liveState.settings.oai_settings` 里取），而那份 settings 是**启动时读的一次快照**。
   *   于是只要"连接方式"后来变过（粘了体验卡 / 换过服务商），这份快照就是旧的；
   *   而**在用体验卡、自己的 endpoint 是空**的时候，它会一路回落到"服务商默认地址" ——
   *   也就是 `https://api.deepseek.com/chat/completions`，并且**不带任何凭据**
   *   （密钥位里存的是卡号，不是 DeepSeek 的 Key）。DeepSeek 当然回 401。
   *   聊天本身没有这个问题（它每次现读设置），只有写角色这条路在用旧快照。
   *
   * 判据与聊天一致：**卡是活的就用卡**（卡的中转就是 OpenAI 兼容端点），否则用自己配的。
   */
  async function aiCreateConnection() {
    try {
      const card = window.RoleWorldCard;
      if (card && typeof card.currentState === "function") {
        const state = await card.currentState();
        if (state && state.active && state.token && state.relay) {
          const relay = String(state.relay).replace(/\/+$/, "");
          return { provider: "custom", endpoint: relay + "/v1/chat/completions", via: "card" };
        }
      }
    } catch (_) { /* 读卡状态失败就退回自己的配置 */ }
    const settings = await window.RoleWorld.getLocalSettings().catch(() => ({}));
    const endpoint = String((settings && settings.endpoint) || "").trim();
    const provider = String((settings && settings.provider) || "").trim();
    if (endpoint) return { provider: provider || "custom", endpoint, via: "own" };
    if (provider && provider !== "custom") {
      // 没有 endpoint 但有服务商：用它的预设地址（这时凭据位里应当是这家服务商的 Key）。
      const preset = window.RoleWorldModel && window.RoleWorldModel.endpointFor
        ? window.RoleWorldModel.endpointFor({ provider }) : "";
      return { provider, endpoint: preset, via: "preset" };
    }
    return { provider: provider || "", endpoint: "", via: "none" };
  }

  /**
   * 聊天这条路**发之前**的自检（2026-09-18 第三版；前两版都回滚了，教训见
   * `runs/2026-09-17-local-ux/CHAT_401_GUARD_ATTEMPT_REVERTED.md`）。
   *
   * 要解决的问题（用户 2026-09-16 的现场）：请求打到 `api.deepseek.com`、应用判定
   * 「空凭据（这个服务商下没存任何东西）」、DeepSeek 回 `Authentication Fails (governor)`。
   * 写角色那条路早有守卫（`aiConnectionHasCredential`），聊天这条路一直没有 —— 它会把
   * 注定 401 的请求真的打出去，然后才事后解释。
   *
   * ⚠ 前两版回滚的**唯一**原因：判据读错了设置来源。守卫当时读 `getLocalSettings().endpoint`，
   *   而聊天真正解析端点用的是 `liveState.settings.oai_settings.custom_url`（见下面的
   *   「判据与发送完全同源」注释）。两份设置不同步时，"endpoint 空 + 服务商是预设"恒成立，
   *   于是**正常发送也被拦**、整套回归塌成 98/125。所以这里的规矩是：
   *     · 端点怎么解析，就怎么写判据（`effectiveChatEndpoint()` 抄的是适配层 requestOptions 的口径）；
   *     · 只有"端点回落到**预设地址**"且"那一格没凭据"才拦；
   *     · 自己填的地址（含本机 / 内网 / 假服务端）一律放行。
   *
   * 返回 null = 放行；否则返回 `{ kind, endpoint, host }`。
   */
  async function chatPreflight(override) {
    const settings = (override && override.settings) || (liveState.settings || {});
    const oai = settings.oai_settings || {};
    const overrideCardRelay = override && override.cardRelay !== undefined ? String(override.cardRelay || "").trim() : null;
    // ⚠ 先按**发送通道**分流，判据与 `sendLive` 里那道 `!deepseekMode && !oai.custom_url` 完全一致。
    //   DeepSeek 通道（服务商=deepseek）根本**不进这里**：那一档模型名、地址、参数都由
    //   `buildGeneratePayload` 自己拼（官方预设），"密钥位里有没有东西"不是它发不发的判据 ——
    //   前一版就是在这里多管了一段，把一整批走 DeepSeek 通道的用例判成"注定 401"（整套塌掉）。
    const deepseekMode = !!(window.TASK22_CORE && window.TASK22_CORE.isDeepSeekChatMode(
      (override && override.modelMode) || liveState.modelMode));
    // ⚠ 判据**只用本机存档那一份**（`getLocalSettings()`；用例可以用 `settings` 显式喂进来）。
    //   为什么不用 `liveState.settings`：那是启动时的一次快照，之后设置页改过它就跟不上了，
    //   而它里面 `oai_settings.custom_url` 还可能是"服务商默认地址"——把默认地址当"配过地址"，
    //   守卫就永远不生效；反过来拿两份混着判，前一版又误伤了正常发送（整套塌掉）。
    //   存档是唯一的真相来源。
    const stored = (override && override.settings) || liveState.localSettings || {};
    const storedEndpoint = String(stored.endpoint || "").trim();
    const oaiEndpoint = String((stored.oai_settings && stored.oai_settings.custom_url) || "").trim();
    // 卡的中转地址也是一种"配过地址"：卡模式下请求打的就是它。
    const storedRelay = overrideCardRelay !== null
      ? overrideCardRelay
      : String(stored.card_relay || "").trim();
    const endpoint = storedEndpoint || oaiEndpoint || (storedRelay ? storedRelay.replace(/\/+$/, "") + "/v1/chat/completions" : "");
    // ⚠ 顺序有讲究：**先按发送通道分流**，再看存档里有没有地址。
    //   判据与 `sendLive` 里那道 `!deepseekMode && !oai.custom_url` 完全一致 ——
    //   DeepSeek 官方通道（服务商=deepseek、没填自定义地址）那一档模型名 / 地址 / 参数都由
    //   `buildGeneratePayload` 自己拼，凭据由适配层按服务商取；"存档里有没有东西"不是它发不发的判据。
    //   前一版就是在这里多管了一段，把一整批走 DeepSeek 通道的用例判成"注定 401"（整套塌掉）。
    const explicitCustomUrl = String((override && override.customUrl) || oai.custom_url || "").trim();
    if (deepseekMode && !explicitCustomUrl) return null;
    const providerDefault = (() => {
      const Model = window.RoleWorldModel;
      if (Model && typeof Model.endpointFor === "function" && typeof Model.providerForEndpoint === "function") {
        try {
          const guess = String(Model.endpointFor({ provider: stored.provider || "deepseek" }) || "").trim();
          if (guess && Model.providerForEndpoint(guess)) return guess;
        } catch (_) { /* 猜不出来就不带这句提示 */ }
      }
      return "";
    })();
    if (!endpoint) {
      if (!providerDefault) return null;   // 连预设地址都算不出来 = 这条路本来就不发
      // 存档里根本没有地址，但服务商是预设 → 请求会回落到它的默认地址，而那一格**什么都没存**。
      // 这就是用户遇到的那次 401（空凭据打到 api.deepseek.com）：拦住。
      const credential = await credentialInSlot(stored.provider || "deepseek");
      if (credential) return null;
      const elsewhere = await cardInAnotherSlot(stored.provider || "deepseek");
      const host = providerDefault.replace(/^https?:\/\//, "").split("/")[0];
      return {
        kind: elsewhere ? "card-elsewhere" : "no-credential",
        endpoint: providerDefault, host, preset: stored.provider || "deepseek", elsewhere,
        debug: { storedEndpoint, oaiEndpoint, storedRelay, deepseekMode, reason: "empty-endpoint" },
      };
    }
    // 自己填的地址（或卡的中转）：可能自带凭据、也可能压根不需要 Key（本机 127.0.0.1 的假服务端）。
    // 一律放行 —— 拦下来反而是错的（这条是前一版回滚之后写下来的硬规矩）。
    const preset = window.RoleWorldModel && typeof window.RoleWorldModel.providerForEndpoint === "function"
      ? window.RoleWorldModel.providerForEndpoint(endpoint)
      : "";
    if (!preset) {
      // 端点是**卡的中转**（自己填的地址照常发）：这里只在"当前这一格没有卡"时才说话 ——
      // 那次 401 的真机制就是这个（卡在别的格子、服务商停在官方，聊天根本不会走卡）。
      if (!storedRelay) return null;
      const currentCard = await credentialInSlot(stored.provider || "custom");
      const looksLikeCard = !!(window.RoleWorldCard && typeof window.RoleWorldCard.looksLikeCard === "function"
        && window.RoleWorldCard.looksLikeCard(currentCard));
      if (currentCard && looksLikeCard) return null;
      const elsewhere = await cardInAnotherSlot(stored.provider || "custom");
      if (!elsewhere) return null;
      const host = String(endpoint).replace(/^https?:\/\//, "").split("/")[0];
      return {
        kind: "card-elsewhere", endpoint, host, preset: "", elsewhere,
        debug: { storedEndpoint, oaiEndpoint, storedRelay, deepseekMode, reason: "relay-without-card" },
      };
    }
    // 到这里：地址是**服务商预设地址**，凭据必须来自这家服务商那一格。
    const credential = await credentialInSlot(preset);
    const host = String(endpoint).replace(/^https?:\/\//, "").split("/")[0];
    if (credential) return null;
    // 卡在别的格子：`RoleWorldCard.currentState()` 只看**当前服务商那一格** ——
    // 卡不在那一格就判"没在用卡"，顶栏也不出额度徽标，聊天根本不会走卡的中转。
    // 这正是最初那次 401 的真实机制（用户配好了卡，但服务商停在 DeepSeek 官方、那一格是空的）。
    const elsewhere = await cardInAnotherSlot(preset);
    return {
      kind: elsewhere ? "card-elsewhere" : "no-credential",
      endpoint, host, preset, elsewhere,
      // 诊断字段（只读，不含任何密钥）：出问题时能一眼看出判据吃进去的是什么。
      debug: { storedEndpoint, oaiEndpoint, storedRelay, deepseekMode },
    };
  }

  /** 某个服务商那一格里存着什么（空串 = 没存）。**只读形态，不判断它是不是卡。** */
  async function credentialInSlot(provider) {
    try {
      const Model = window.RoleWorldModel;
      const key = Model && typeof Model.secretKeyFor === "function" ? Model.secretKeyFor({ provider }) : "";
      const record = key && window.RoleWorld && window.RoleWorld.secrets ? await window.RoleWorld.secrets.get(key) : null;
      return String((record && record.value) || "").trim();
    } catch (_) { return ""; }
  }

  /**
   * 有没有一张体验卡存在**别的服务商格子里**（返回 `{ provider, token, relay }` 或 null）。
   *
   * `currentState()` 只查当前那一格，所以"卡在别处"这件事只能自己找一遍：
   * 五个格子里除了当前这个，哪一个存着像卡号的东西。找到了就说明用户是配过卡的，
   * 只是没切过去 —— 那种情况必须**说清并给一键切过去**，而不是说"你没配"。
   */
  async function cardInAnotherSlot(currentProvider) {
    const Model = window.RoleWorldModel;
    const adapter = window.RoleWorld;
    const card = window.RoleWorldCard;
    if (!Model || !adapter || !adapter.secrets || !card || typeof card.looksLikeCard !== "function") return null;
    const names = (Model.PRESETS && typeof Model.PRESETS === "object") ? Object.keys(Model.PRESETS) : ["custom", "deepseek"];
    let relay = "";
    try {
      const settings = await adapter.getLocalSettings();
      relay = String((settings && settings.card_relay) || "").trim();
    } catch (_) { relay = ""; }
    for (const provider of names) {
      if (provider === currentProvider) continue;
      let value = "";
      try {
        const record = await adapter.secrets.get(Model.secretKeyFor({ provider }));
        value = String((record && record.value) || "").trim();
      } catch (_) { value = ""; }
      if (value && card.looksLikeCard(value)) return { provider, token: value, relay };
    }
    return null;
  }

  /**
   * 注定发不出去时**发之前**就拦住：在对话里画一张卡，说明原因 + 一个能点的下一步。
   *
   * 两种原因、两个去处（用户 2026-09-16 现场的两条）：
   *   · `no-credential`：这一格什么都没有 → 「去设置连接方式」；
   *   · `card-elsewhere`：卡在另一格 → 「改用这张体验卡」（真的把服务商/地址/卡切过去）。
   */
  function renderChatPreflight(blocked, userText) {
    const container = document.querySelector("#dynamicMessages");
    if (!container) return;
    const card = document.createElement("div");
    card.className = "turn-failure chat-preflight";
    card.dataset.preflight = blocked.kind;
    const text = document.createElement("p");
    text.className = "turn-failure-text";
    text.textContent = "这一句没有发出去：" + userText;
    const note = document.createElement("p");
    note.className = "turn-failure-why";
    note.textContent = blocked.kind === "card-elsewhere"
      ? `原因：现在会打到 ${blocked.host}，而那一格里没有凭据 —— 你配的体验卡在「${blocked.elsewhere.provider}」那一格。`
        + "点下面的按钮把它切过去就好（不会重复发这句话）。"
      : `原因：现在会打到 ${blocked.host}，而那一格里没有凭据（这个服务商下没存任何东西）——`
        + "这次请求注定被拒，所以没有发出去。去「设置 → 连接方式」粘上体验卡，或填上你自己的 API Key。";
    const actions = document.createElement("div");
    actions.className = "chat-preflight-actions";
    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "plain-button";
    focus.dataset.action = "retry-turn";
    focus.dataset.userText = userText;
    focus.textContent = "重试";
    if (blocked.kind === "card-elsewhere") {
      const useCard = document.createElement("button");
      useCard.type = "button";
      useCard.className = "plain-button";
      useCard.dataset.action = "use-card-now";
      useCard.textContent = "改用这张体验卡";
      useCard.addEventListener("click", () => { switchToStoredCard(blocked, userText, useCard).catch(() => {}); });
      actions.appendChild(useCard);
    } else {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "plain-button";
      go.dataset.action = "open-connection-settings";
      go.textContent = "去设置连接方式";
      go.addEventListener("click", () => { openSettingsAt("connection"); });
      actions.appendChild(go);
    }
    actions.appendChild(focus);
    card.append(text, note, actions);
    container.appendChild(card);
    const scroll = document.querySelector("#chatScroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  /**
   * 「改用这张体验卡」：真的把 provider / endpoint / card_relay 切到卡上（不是只弹一句话）。
   *
   * 与「设置 → 连接方式」里那个成功路径**同一套写盘**（`saveLocalSettings`），
   * 所以切完之后 `RoleWorldCard.currentState()` 立刻就是 active，顶栏也会出额度徽标。
   */
  async function switchToStoredCard(blocked, userText, button) {
    const relayRaw = blocked && blocked.elsewhere ? String(blocked.elsewhere.relay || "") : "";
    const relay = relayRaw.replace(/\/+$/, "");
    if (!relay) {
      showToast("这张卡没带中转地址，请到「设置 → 连接方式」重新粘一次发卡人给你的整行。");
      openSettingsAt("connection");
      return false;
    }
    if (button) button.disabled = true;
    try {
      await window.RoleWorld.saveLocalSettings({
        provider: "custom",
        endpoint: relay + "/v1/chat/completions",
        card_relay: relay,
      });
      window.dispatchEvent(new CustomEvent("roleworld:settings-changed", {
        detail: { provider: "custom", endpoint: relay + "/v1/chat/completions", card_relay: relay },
      }));
      // 设置改了要**重新读一遍**：liveState.settings 是启动时的那份快照，不重读就还是旧的
      // （这正是"改了没用"那一类 bug 的来源）。
      try {
        if (window.RoleWorld && typeof window.RoleWorld.getLocalSettings === "function") {
          liveState.localSettings = await window.RoleWorld.getLocalSettings();
        }
        liveState.settings = Object.assign({}, liveState.settings || {}, {
          provider: "custom",
          endpoint: relay + "/v1/chat/completions",
          oai_settings: Object.assign({}, (liveState.settings || {}).oai_settings || {}, {
            custom_url: relay + "/v1/chat/completions",
          }),
        });
        liveState.modelMode = window.TASK22_CORE.CHAT_MODES.LOCAL;
        liveState.modelName = (liveState.settings && liveState.settings.model) || "deepseek-flash";
      } catch (_) { /* 内存里更新不过去也不影响写盘结果 */ }
      showToast("已经改用这张体验卡，再点一次「重试」就把刚才那句话发出去。");
      updateComposerLive();
      return true;
    } catch (error) {
      showToast("切换失败：" + String((error && error.message) || error).slice(0, 120));
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * 聊天这一轮**真正**会打到的地址。
   *
   * ⚠ 「判据必须与发送同源」—— 这是前一版回滚的直接教训：
   *   `sendLive` 用的是 `liveState.settings.oai_settings.custom_url`（再交给适配层），
   *   而适配层 `requestOptions` 的写法是 `payload.custom_url || local.endpoint`。
   *   所以这里按同样顺序取，绝不另读一份（测试环境里那两份是**不同步**的）。
   */
  function effectiveChatEndpoint(override) {
    const settings = (override && override.settings) || (liveState.settings || {});
    const oai = settings.oai_settings || {};
    const explicit = String(oai.custom_url || "").trim();
    if (explicit) return explicit;
    const local = String(settings.endpoint || "").trim();
    if (local) return local;
    // 两份都没有时，适配层会回落到服务商预设地址（`endpointFor`）。但**本机存档里**可能还写着
    // 一个地址（启动快照没跟上）—— 那种情况实际会打到存档那个地址，不能按预设判。
    // ⚠ 正是这一条把前一版从"误伤"里救回来：测试固定装置与本机存档是两份不同的设置。
    if (!(override && override.settings)) {
      const stored = String((liveState.localSettings && liveState.localSettings.endpoint) || "").trim();
      if (stored) return stored;
    }
    const Model = window.RoleWorldModel;
    if (Model && typeof Model.endpointFor === "function") {
      try { return String(Model.endpointFor(settings) || "").trim(); } catch (_) { return ""; }
    }
    return "";
  }

  /** 把这一路的连接写进载荷（`custom_url` 为空时适配层会回落到服务商预设 —— 那正是 401 的来源）。 */
  function withAiConnection(payload, connection) {
    if (!payload) return payload;
    const next = Object.assign({}, payload);
    if (connection && connection.endpoint) next.custom_url = connection.endpoint;
    return next;
  }

  /**
   * 连接没配好时**先别打接口**：直接给一句能照着做的话，并给一个去设置页的入口。
   * 为什么要拦：不拦的话用户看到的是 DeepSeek 的英文报错，那一句话既没说"打到哪"，
   * 也没说"缺什么"（用户已经为此来问过一次了）。
   */
  async function ensureAiConnection() {
    const connection = await aiCreateConnection();
    if (!connection.endpoint) {
      setAiError("还没有可用的模型连接：要么去「设置 → 连接方式」粘上发卡人给你的体验卡，"
        + "要么填自己的 API Key。填好之后再回来点这一步。", { settingsLink: true });
      return null;
    }
    const credential = await aiConnectionHasCredential(connection);
    if (!credential.ok) {
      const host = connection.endpoint.replace(/^https?:\/\//, "").split("/")[0];
      setAiError("这条连接还没有凭据：" + host + " 这一路需要的 Key（或体验卡）没存进这台设备。"
        + "去「设置 → 连接方式」补上，或者换成体验卡。", { settingsLink: true });
      return null;
    }
    return connection;
  }

  async function generateAiBrief() {
    const description = validateAiDescription();
    if (description === null || liveState.aiBusy || !liveState.aiDialogOpen) return;
    if (liveState.aiCalls >= AI_CALL_BUDGET) {
      setAiError(`这次创建已经用了 ${AI_CALL_BUDGET} 次模型调用，先停下。可以返回改成直接生成，或关掉重开。`);
      return;
    }
    const connection = await ensureAiConnection();
    if (!connection) return;
    setAiBusy(true, "#aiBriefButton");
    liveState.aiCalls += 1;
    try {
      const payload = withAiConnection(window.TASK29_CHARACTER_CORE.buildBriefGeneratePayload({
        description,
        settings: liveState.settings,
        language: (document.querySelector("#aiLanguageSelect")?.value) || "auto",
      }), connection);
      const response = await window.STApi.generate(payload, undefined);
      const parsed = window.TASK22_CORE.parseGenerateResponse(response);
      const brief = window.TASK29_CHARACTER_CORE.normalizeBrief(parsed.content);
      if (brief.empty) {
        setAiBusy(false, "#aiBriefButton");
        setAiError("模型没有给出提示词，请重试一次，或跳过这一步直接生成。");
        return;
      }
      liveState.aiBrief = brief.text;
      const area = document.querySelector("#aiBriefInput");
      if (area) { area.value = brief.text; }
      setAiPhase("brief");
      setAiBusy(false, "#aiBriefButton");
      renderAiBriefCount();
      if (brief.tooShort) setAiError("扩写结果偏短，建议补几句再生成；也可以直接继续。");
      else if (brief.truncated) setAiError("扩写结果偏长，已截断；可以直接改短一点再生成。");
    } catch (err) {
      setAiBusy(false, "#aiBriefButton");
      if (isAuthRequired(err)) { showAuthGate(); return; }
      setAiError(err && err.message ? `扩写失败：${err.message}` : "扩写失败，请重试。");
    }
  }

  /** 把界面上（可能是用户改过的）提示词读出来，作为写卡的输入。 */
  function currentBriefForCard() {
    const typed = (document.querySelector("#aiBriefInput")?.value || "").trim();
    const brief = typed || liveState.aiBrief;
    liveState.aiBrief = brief;
    return brief;
  }

  // 调用模型生成草稿。只送当前角色描述；复用现有 custom_url / custom_include_body。
  /* ---------- 第二步：用（可能是扩写出来的）提示词生成角色卡 ----------
   * source 说明这次写卡的输入来自哪里：
   *   "brief"       —— 用户在提示词那一步确认过的稿子（推荐路径）
   *   "description" —— 用户选择跳过扩写，直接用原始描述
   */
  async function generateAiDraft(source, options) {
    const fromBrief = source === "brief";
    const description = fromBrief ? currentBriefForCard() : validateAiDescription();
    if (description === null) return;
    if (!description) {
      setAiError(fromBrief ? "提示词是空的：请写点内容，或返回改成直接生成。" : "角色描述至少需要 20 个字符。");
      return;
    }
    if (liveState.aiBusy || !liveState.aiDialogOpen) return;
    if (liveState.draftFlow.getPhase() !== window.TASK29_CHARACTER_CORE.DRAFT_PHASES.IDLE
      && !liveState.draftFlow.retryAllowed()) {
      setAiError("已达到最大生成次数（2 次），请直接编辑或保存草稿。");
      return;
    }
    if (liveState.aiCalls >= AI_CALL_BUDGET) {
      setAiError(`这次创建已经用了 ${AI_CALL_BUDGET} 次模型调用，先停下。可以关掉对话框重开，或手动填写。`);
      return;
    }
    const buttonId = (options && options.buttonId) || "#aiBriefNextButton";
    // 第二步（写卡）与第一步同一条规矩：连接现读一次，别信启动时的旧快照（见 aiCreateConnection）。
    const connection = await ensureAiConnection();
    if (!connection) return;
    setAiBusy(true, buttonId);
    const callModel = async () => {
      liveState.draftFlow.beginGeneration();
      liveState.aiCalls += 1;
      const payload = withAiConnection(window.TASK29_CHARACTER_CORE.buildDraftGeneratePayload({
        description: window.TASK29_CHARACTER_CORE.briefAsDescription(description),
        settings: liveState.settings,
        language: (document.querySelector("#aiLanguageSelect")?.value) || "auto",
      }), connection);
      const response = await window.STApi.generate(payload, undefined);
      const parsed = window.TASK22_CORE.parseGenerateResponse(response);
      if (!parsed.content || !parsed.content.trim()) throw Object.assign(new Error("empty response"), { code: "DRAFT_EMPTY" });
      // 不保存模型原始回复；直接解析/归一化为草稿。
      return liveState.draftFlow.receiveGenerated(parsed.content);
    };
    const applyDraft = (draft) => {
      liveState.aiDraft = draft;
      setAiPhase("edit");
      fillAiEditFields(draft);
      setAiBusy(false, buttonId);
    };
    try {
      applyDraft(await callModel());
    } catch (err) {
      if (isAuthRequired(err)) { showAuthGate(); return; }
      const retriable = err && (err.code === "DRAFT_PARSE_ERROR" || err.code === "DRAFT_DANGEROUS_KEY"
        || err.code === "DRAFT_INVALID");
      if (retriable && liveState.draftFlow.retryAllowed() && liveState.aiCalls < AI_CALL_BUDGET) {
        // 一次修复：再调用一次模型（GENERATING → GENERATING）。
        try {
          applyDraft(await callModel());
          return;
        } catch (retryErr) {
          if (isAuthRequired(retryErr)) { showAuthGate(); return; }
        }
        setAiBusy(false, buttonId);
        setAiError("模型两次都没有给出可用的角色卡。可以把提示词写得更具体些再试，或直接手动填写。");
        return;
      }
      setAiBusy(false, buttonId);
      setAiError((err && err.code === "DRAFT_EMPTY") ? "模型没有返回内容，请重试。"
        : (err && err.code === "DRAFT_PARSE_ERROR") ? `模型返回的内容不是合法角色卡（${err.message}），请重试或手动填写。`
        : (err && err.code === "DRAFT_INVALID") ? `草稿不完整：${(err.validationErrors || []).join("；")}`
        : (err && err.message) ? `生成失败：${err.message}`
        : "生成失败，请重试。");
    }
  }

  function regenerateAiDraft() {
    if (!liveState.aiDialogOpen || liveState.aiBusy) return;
    // 回到生成阶段重新调用（受 max 2 次限制）。
    if (!liveState.draftFlow.retryAllowed()) { setAiError("已达到最大生成次数（2 次），请直接编辑或保存草稿。"); return; }
    setAiPhase(liveState.aiBrief ? "brief" : "description");
    setAiBusy(false, liveState.aiBrief ? "#aiBriefNextButton" : "#aiBriefButton");
    setAiError("");
  }

  function backToDescription() {
    if (!liveState.aiDialogOpen || liveState.aiBusy) return;
    setAiPhase("description");
    setAiError("");
  }

  function fillAiEditFields(draft) {
    for (const [selector, field] of AI_FIELDS) {
      const el = document.querySelector(`#${selector}`);
      if (el) el.value = (draft && draft[field]) || "";
    }
    const tags = document.querySelector("#aiEditTags");
    if (tags) tags.value = (draft && draft.tags && Array.isArray(draft.tags)) ? draft.tags.join("、") : "";
    // Task-29G：编辑阶段语言下拉跟随草稿（zh/en）。
    const editLang = document.querySelector("#aiEditLanguage");
    if (editLang) editLang.value = (draft && draft.language === "en") ? "en" : "zh";
  }

  function collectAiEditDraft() {
    const read = (selector) => (document.querySelector(selector)?.value || "").trim();
    const tagsText = read("#aiEditTags");
    const tags = tagsText
      ? tagsText.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 12)
      : [];
    return window.TASK29_CHARACTER_CORE.normalizeDraft({
      name: read("#aiEditName"),
      description: read("#aiEditDescription"),
      personality: read("#aiEditPersonality"),
      scenario: read("#aiEditScenario"),
      first_mes: read("#aiEditFirstMes"),
      mes_example: read("#aiEditMesExample"),
      tags,
      language: (document.querySelector("#aiEditLanguage")?.value === "en") ? "en" : "zh",
    });
  }

  async function saveAiDraft() {
    if (!liveState.aiDialogOpen || liveState.aiBusy) return;
    const draft = collectAiEditDraft();
    const check = window.TASK29_CHARACTER_CORE.validateDraft(draft);
    if (!check.valid) { setAiError(check.errors.join("；")); return; }
    liveState.aiBusy = true;
    const save = document.querySelector("#aiSaveButton");
    if (save) save.disabled = true;
    setAiError("");
    try {
      // 只在“保存角色”时确定性构造 CCv3 并导入；导入成功前不把流程推进到 IMPORTED，
      // 这样导入失败时用户仍可修正后重试。
      const ccv3 = window.TASK29_CHARACTER_CORE.buildCCv3(draft);
      await importCCv3AsCharacter(ccv3);
      if (liveState.draftFlow && liveState.draftFlow.getPhase() === window.TASK29_CHARACTER_CORE.DRAFT_PHASES.EDIT) {
        liveState.draftFlow.confirmImport();
      }
      closeAiCreateDialog();
      showToast("角色已创建并选中，发送第一条消息后即可绑定");
    } catch (err) {
      liveState.aiBusy = false;
      if (save) save.disabled = false;
      if (isAuthRequired(err)) { showAuthGate(); return; }
      setAiError("角色保存失败，请重试。");
      showToast("角色保存失败");
    }
  }

  // 把 CCv3 JSON 构造成 File，走 /api/characters/import（json）。
  async function importCCv3AsCharacter(ccv3) {
    const blob = new Blob([JSON.stringify(ccv3, null, 2)], { type: "application/json" });
    const file = new File([blob], `${(ccv3.data && ccv3.data.name) || "character"}.json`, { type: "application/json" });
    await performImport(file, "json", { user_name: liveState.userHandle });
  }

  function openFileImport() {
    if (liveState.pending || liveState.switching) return;
    setPickerMenuOpen(false);
    const input = document.querySelector("#characterImportInput");
    if (!input) return;
    input.value = "";
    input.click();
  }

  function onImportFileSelected() {
    const input = document.querySelector("#characterImportInput");
    const file = input && input.files && input.files[0];
    if (!file) return;
    const fileType = window.TASK29_CHARACTER_CORE.importTypeForFileName(file.name);
    if (!fileType) {
      showToast("不支持的文件类型：请使用 .json / .png / .charx / .yaml / .yml");
      return;
    }
    if (file.size > window.TASK29_CHARACTER_CORE.MAX_IMPORT_BYTES) {
      showToast("文件超过 20 MiB 上限");
      return;
    }
    performImport(file, fileType, { user_name: liveState.userHandle }).catch((err) => {
      if (isAuthRequired(err)) { showAuthGate(); return; }
      showToast("角色导入失败，请重试");
    });
  }

  async function performImport(file, fileType, options = {}) {
    // 保持当前聊天 UNBOUND；导入成功才刷新列表并自动选中。
    const result = await window.STApi.importCharacter(file, fileType, options);
    if (!result || typeof result.file_name !== "string" || !result.file_name) {
      const error = new Error("import returned no file name");
      error.code = "IMPORT_NO_NAME";
      throw error;
    }
    await refreshCharacterRegistry();
    autoSelectImported(result.file_name);
    return result;
  }

  async function refreshCharacterRegistry() {
    const cards = await window.STApi.listCharacters();
    const cardList = (Array.isArray(cards) ? cards : []).filter((card) => card && card.avatar);
    if (!cardList.length) {
      if (window.STApi && window.STApi.isLocal === true) {
        liveState.characters = [];
        liveState.harryAvatar = "";
        liveState.defaultCharacter = null;
        renderCharacterPicker();
        updateComposerLive();
        return liveState.characters;
      }
      throw new Error("Harry character unavailable");
    }
    // Task-33A：Harry 判定只用固定 avatar 文件名，不再用「列表第一项」兜底。
    const harry = findHarry(cardList) || cardList[0];
    liveState.characters = sortCharacterEntries(cardList).map((card) => ({ avatar: String(card.avatar), charName: String(card.name || card.avatar) }));
    liveState.harryAvatar = harry ? harry.avatar : null;
    liveState.defaultCharacter = liveState.characters.find((entry) => entry.avatar === (harry ? harry.avatar : "")) || liveState.characters[0] || null;
    if (harry && liveState.cardCache && !liveState.cardCache.has(harry.avatar)) {
      try { liveState.cardCache.set(harry.avatar, await window.STApi.getCharacter(harry.avatar)); } catch (_) { /* optional */ }
    }
    renderCharacterPicker();
    renderChatList();
    updateComposerLive();
    return liveState.characters;
  }

  // Task-31D：删除角色后刷新注册表。不同于 refreshCharacterRegistry（它要求至少一个
  // Harry），删除后若当前绑定会话已不可用则静默降级，不抛错、不影响其余角色。
  async function refreshCharacterRegistryAfterDelete() {
    try {
      const cards = await window.STApi.listCharacters();
      const cardList = (Array.isArray(cards) ? cards : []).filter((card) => card && card.avatar);
      if (cardList.length) {
        // Task-33A：Harry 判定只用固定 avatar 文件名；不把第一个自定义角色当 Harry。
        const harry = findHarry(cardList) || null;
        liveState.characters = sortCharacterEntries(cardList).map((card) => ({ avatar: String(card.avatar), charName: String(card.name || card.avatar) }));
        liveState.harryAvatar = harry ? harry.avatar : "";
        liveState.defaultCharacter = harry
          ? liveState.characters.find((entry) => entry.avatar === harry.avatar) || null
          : null;
      } else {
        liveState.characters = [];
        liveState.harryAvatar = "";
        liveState.defaultCharacter = null;
      }
      renderCharacterPicker();
      renderChatList();
      updateComposerLive();
    } catch (_) { /* deletion best-effort; settings list reloads independently */ }
  }

  function autoSelectImported(avatar) {
    const session = liveState.activeSession;
    const entry = liveState.characters.find((candidate) => candidate.avatar === avatar);
    const target = entry || liveState.characters[liveState.characters.length - 1];
    if (!target) return;
    // 只作用于未绑定空白会话；已绑定会话绝不改角色。
    if (session && isUnboundBlank(session)) {
      session.pendingAvatar = target.avatar;
      session.pendingCharName = target.charName;
    }
    // Task-29F：导入并自动选中后立即刷新顶部标题/侧栏与记忆面板。
    liveState.charName = target.charName || liveState.charName;
    renderActiveCharacterIdentity();
    applyMemoryPanelFilter();
    renderCharacterPicker();
    renderChatList();
    updateComposerLive();
  }

  async function loadCharacterAndChat() {
    // 切角色/重载对话时，先把正在念的语音停掉 —— 否则新角色已经打开，
    // 上一段的音频还会突然响起来（用户完全不知道是谁在说话）。
    stopVoicePlayback();
    const cards = await window.STApi.listCharacters();
    const cardList = (Array.isArray(cards) ? cards : []).filter((card) => card && card.avatar);
    if (!cardList.length) {
      // 本地版允许还没有任何角色卡：给出空状态，等用户导入，而不是把整页打挂。
      if (window.STApi && window.STApi.isLocal === true) {
        liveState.characters = [];
        liveState.harryAvatar = "";
        liveState.defaultCharacter = null;
        liveState.avatar = null;
        liveState.charName = "";
        liveState.card = null;
        liveState.cardCache = new Map();
        liveState.chatModel = null;
        setChatListStatus("还没有角色卡，先导入一个再开始对话。", false);
        renderCharacterPicker();
        syncActiveSession();
        return;
      }
      throw new Error("Harry character unavailable");
    }
    // Task-33A：Harry 判定只用固定 avatar 文件名；不把第一个自定义角色当 Harry。
    const harry = findHarry(cardList) || cardList[0];

    liveState.characters = sortCharacterEntries(cardList).map((card) => ({ avatar: String(card.avatar), charName: String(card.name || card.avatar) }));
    liveState.harryAvatar = harry ? harry.avatar : null;
    liveState.defaultCharacter = liveState.characters.find((entry) => entry.avatar === (harry ? harry.avatar : "")) || liveState.characters[0] || null;
    liveState.avatar = harry ? harry.avatar : null;
    liveState.charName = harry ? (harry.name || "Harry Potter") : "Harry Potter";
    liveState.cardCache = new Map();
    liveState.card = await window.STApi.getCharacter(harry.avatar);
    liveState.cardCache.set(harry.avatar, liveState.card);
    liveState.chatModel = window.TASK22_CORE.createHarryChatModel({
      api: window.STApi,
      characters: liveState.characters,
      avatar: liveState.avatar,
      userHandle: liveState.userHandle,
      charName: liveState.charName,
      userName: liveState.userName,
      storage: window.localStorage,
      receipts: turnReceipts,
    });
    try {
      await liveState.chatModel.refresh({ preserveUnsaved: false });
      setChatListStatus(liveState.chatModel.isDegraded && liveState.chatModel.isDegraded() ? "部分角色的对话列表暂时无法加载。" : "", liveState.chatModel.isDegraded && liveState.chatModel.isDegraded());
    } catch (error) {
      if (isAuthRequired(error)) throw error;
      liveState.chatModel.newSession();
      setChatListStatus("对话列表暂时无法加载。", true);
    }
    syncActiveSession();
    // 2026-09-12 用户拍板：「伴侣类版本可以有主动消息」。这个应用没有后端、没有推送，
    // 所以"主动"只能是**你回来的时候它先开口** —— 就是这里：对话加载完之后试一次。
    maybeProactiveOpening().catch(() => { /* 主动开口失败不该影响打开对话 */ });
  }

  /**
   * 伴侣模式的"主动开口"：打开这个角色的对话时，如果隔得够久、今天还没发够，
   * 就让角色自己先说一句（像真人突然发来一条消息）。
   * 三个约束：只在伴侣模式 + 主动消息都开着时；同一段对话每次打开只试一次；每天有条数上限。
   */
  async function maybeProactiveOpening() {
    const core = window.ROLEWORLD_COMPANION_CORE;
    // 为什么没开口：留给「设置 → 关于」与测试看（比"没反应"强）。
    const bail = (reason) => { liveState.proactiveReason = reason; return false; };
    if (!core || typeof core.proactiveDecision !== "function") return bail("no-core");
    if (liveState.pending || liveState.switching) return bail("busy");
    const session = liveState.activeSession;
    const entry = activeCharacterEntry();
    if (!session || !entry || !entry.avatar) return bail("no-session");
    // 只在"已经聊过、不是空白新对话"的会话里主动（新对话该由用户先开口）。
    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (messages.length < 2) return bail("empty-chat");
    const key = String(session.storageFileName || session.fileName || session.id || "");
    liveState.proactiveTried = liveState.proactiveTried || new Set();
    if (liveState.proactiveTried.has(key)) return bail("already-tried");
    liveState.proactiveTried.add(key);

    let profile = null;
    try { profile = await loadCompanion(entry); } catch (_) { return bail("no-profile"); }
    // 内置小说人物不做伴侣（2026-09-14 用户拍板）—— 主动开口也属于伴侣模式，一并挡掉。
    // 只挡行为、不动档案：老存档里那份档案原样留着（跟 companionBlockFor 一个口径）。
    if (isBuiltinAvatar(entry.avatar)) return bail("builtin-character");
    const now = new Date();
    const decision = core.proactiveDecision(profile, now);
    if (!decision.ok) return bail("decision:" + decision.reason);

    const card = liveState.card || (liveState.cardCache && liveState.cardCache.get(entry.avatar)) || null;
    if (!card) return bail("no-card");
    const lang = companionLangFor(entry);
    // 注意：这里是 boot 早期（loadCharacterAndChat 结束时），liveState.localSettings 可能还没加载，
    // 用它会导致端点回退成服务商默认地址 —— 真发生过：请求打到了真的 DeepSeek 并拿到 401。
    let settings = liveState.localSettings && liveState.localSettings.provider ? liveState.localSettings : null;
    if (!settings) {
      try { settings = await window.RoleWorld.getLocalSettings(); } catch (_) { settings = {}; }
    }
    const provider = settings.provider || "deepseek";
    const apiKey = ((await window.RoleWorld.secrets.get(window.RoleWorldModel.secretKeyFor({ provider }))) || {}).value || "";
    if (!apiKey) return bail("no-key");

    // 记忆书用和正常发送同一条路（memoryBooksFor），别自己拼一份。
    let booksForChar = [];
    try {
      booksForChar = window.TASK29_CHARACTER_CORE.memoryBooksFor(entry, liveState.memoryBooks);
    } catch (_) { booksForChar = []; }
    const messagesForModel = [
      { role: "system", content: window.TASK22_CORE.buildSystemPromptWithFormat(card, booksForChar, "", null, {
        purpose: window.TASK22_CORE.PURPOSES.COMPANION,
        language: languageForAvatar(entry.avatar),
      }) },
      { role: "system", content: core.proactiveInstruction(profile, { now, lang }) },
    ];
    for (const message of messages.slice(-6)) {
      if (!message || typeof message.mes !== "string" || !message.mes) continue;
      messagesForModel.push({ role: message.is_user ? "user" : "assistant", content: message.mes });
    }

    liveState.proactiveRunning = true;
    try {
      const result = await window.RoleWorldModel.complete(
        { messages: messagesForModel, max_tokens: 220 },
        {
          settings: { provider, endpoint: window.RoleWorldModel.endpointFor(settings), model: liveState.modelName },
          apiKey: apiKey,
        },
      );
      const text = String((result && result.content) || "").trim();
      if (!text) return false;
      // 像正常一轮那样落盘：写成助手消息，并把"今天主动发过几条"记上。
      messages.push({
        name: entry.charName || entry.avatar,
        is_user: false,
        mes: text,
        send_date: new Date().toISOString(),
        rw_proactive: true,
      });
      try { await window.STApi.saveChat(entry.avatar, session.storageFileName || session.fileName, messages); } catch (_) { /* 存不下也先显示 */ }
      const today = core.isoDay(now);
      const sentToday = core.proactiveCountToday(profile, now) + 1;
      await saveCompanion(entry, core.normalizeProfile(Object.assign({}, profile, {
        proactiveLog: today + "|" + sentToday,
        lastChatAt: now.toISOString(),
      })));
      syncActiveSession();
      liveState.proactiveReason = "sent";
      showToast((entry.charName || "他") + "先开口了");
      return true;
    } catch (error) {
      liveState.proactiveReason = "error:" + String((error && error.message) || error).slice(0, 120);
      return false;
    } finally {
      liveState.proactiveRunning = false;
    }
  }

  async function retryChatList() {
    if (liveState.pending || liveState.switching || !liveState.chatModel) return;
    liveState.switching = true;
    setChatListStatus("正在重新加载…", false);
    setChatControlsDisabled(true);
    try {
      await liveState.chatModel.refresh({ preserveUnsaved: false });
      syncActiveSession();
      setChatListStatus("");
    } catch (error) {
      if (isAuthRequired(error)) { showAuthGate(); return; }
      setChatListStatus("对话列表暂时无法加载。", true);
    } finally {
      liveState.switching = false;
      setChatControlsDisabled(false);
      updateComposerLive();
    }
  }

  function createNewConversation() {
    if (liveState.pending || liveState.switching || !liveState.chatModel) return;
    const before = liveState.chatModel.getActive();
    const next = liveState.chatModel.newSession();
    syncActiveSession();
    setChatListStatus("");
    updateComposerLive();
    if (before === next && (!next.messages || next.messages.length === 0)) showToast("当前已经是空白对话");
    $("#messageInput")?.focus();
  }

  async function setChatArchived(sessionId, archived) {
    if (liveState.pending || liveState.switching || !liveState.chatModel) return;
    liveState.switching = true;
    setChatControlsDisabled(true);
    disableComposer(archived ? "正在归档对话…" : "正在恢复对话…");
    try {
      if (archived) await liveState.chatModel.archive(sessionId);
      else await liveState.chatModel.restore(sessionId);
      syncActiveSession();
      setChatListStatus("");
      showToast(archived ? "对话已归档，可随时恢复" : "对话已恢复");
    } catch (error) {
      if (isAuthRequired(error)) { showAuthGate(); return; }
      if (error && error.code === "CHAT_EMPTY") showToast("空白对话无需归档");
      else if (error && error.code === "CHAT_MISSING") {
        setChatListStatus("原对话已不可用，请刷新列表。", true);
        showToast("原对话已不可用");
      } else showToast(archived ? "暂时无法归档，请重试" : "暂时无法恢复，请重试");
    } finally {
      liveState.switching = false;
      setChatControlsDisabled(false);
      updateComposerLive();
    }
  }

  function archiveChat(sessionId) { return setChatArchived(sessionId, true); }
  function restoreChat(sessionId) { return setChatArchived(sessionId, false); }

  // Task-30E：归档对话永久删除（Harry 服务端会话）。
  // 1) 二次确认：显示标题/文件名，要求输入确认词「删除」；
  // 2) 调 STApi.deleteChat 删除服务端 .jsonl；
  // 3) 成功后 chatModel.remove() 移除本地会话并刷新；失败仅提示，不删本地。
  async function deleteChat(sessionId) {
    if (liveState.pending || liveState.switching || !liveState.chatModel) return;
    const session = liveState.chatModel.getSessions().find((item) => item.id === sessionId || item.fileName === sessionId);
    if (!session) return;
    const confirmationWord = "删除";
    const inputValue = window.prompt(
      `永久删除这段归档对话？此操作不可恢复。\n\n标题：${session.title || "新对话"}\n文件：${session.fileName}.jsonl\n\n请输入「${confirmationWord}」以确认：`,
      "",
    );
    if (inputValue === null) return;
    if (inputValue.trim() !== confirmationWord) {
      showToast("已取消：确认词不匹配");
      return;
    }
    liveState.switching = true;
    setChatControlsDisabled(true);
    disableComposer("正在永久删除对话…");
    try {
      if (!session.avatar) throw new Error("chat not bound");
      // 删除要用真正的存储键：老数据/导入的对话是带 .jsonl 存的（见 hydrateSession）。
      await window.STApi.deleteChat(session.avatar, session.storageFileName || session.fileName);
      liveState.chatModel.remove(session.id);
      syncActiveSession();
      renderArchivedChatSettings();
      setChatListStatus("");
      showToast("对话已永久删除");
    } catch (error) {
      if (isAuthRequired(error)) { showAuthGate(); return; }
      showToast("永久删除失败，本地对话已保留，请重试");
    } finally {
      liveState.switching = false;
      setChatControlsDisabled(false);
      updateComposerLive();
    }
  }

  async function selectChat(sessionId) {
    if (liveState.pending || !liveState.chatModel) return;
    // 切会话也要停：旧音频不该在新会话里突然响起来。
    stopVoicePlayback();
    // 切会话 = 上一轮所有**晚回来的异步任务**作废（语音合成、逐条送达）。
    // 不作废的话，切走之后旧的一轮还会继续往外蹦消息 —— 蹦到另一个会话的界面上。
    liveState.generationSeq += 1;
    liveState.suppressStream = false;
    liveState.voiceIntent = false;
    cancelScheduledReveals();
    const preview = liveState.chatModel.getSessions().find((session) => session.id === sessionId || session.fileName === sessionId);
    if (!preview) return;
    if (!liveState.switching && liveState.activeSession && (sessionId === liveState.activeSession.id || sessionId === liveState.activeSession.fileName)) return;
    if (liveState.switchController) liveState.switchController.abort();
    const sequence = ++liveState.switchSequence;
    const controller = new AbortController();
    liveState.switchController = controller;
    liveState.switching = true;
    if (preview) {
      liveState.activeSession = preview;
      liveState.chatLines = [];
      liveState.chatMessages = [];
      renderChatList();
      renderArchivedChatSettings();
      renderLiveMessages([], { loading: true });
    }
    setChatControlsDisabled(true, { allowSelection: true });
    disableComposer("正在打开对话…");
    try {
      await liveState.chatModel.select(sessionId, { signal: controller.signal });
      if (sequence !== liveState.switchSequence) return;
      syncActiveSession();
      // 换到这个角色了：把**它自己**的伴侣档案热进同步缓存。
      // 为什么必须有这一步：菜单是同步判定的（点开那一瞬间读缓存），
      // 缓存里还留着上一个角色的档案时，新角色会被判成"没开伴侣"——
      // 表现就是"切过去之后没有朗读"，而原因跟语音一点关系都没有（这个项目踩过同类的坑）。
      await primeCompanionCache(activeCharacterEntry()).catch(() => {});
      // 缓存热好之后，顶栏「当前方式」与语音入口都要按**新角色**重画一次：
      // 上面 renderActiveCharacterIdentity() 是在缓存还没读回来时跑的，那时画的是旧角色的方式
      //（2026-09-16 实测：方式改成「日常聊天」后切走再切回来，顶栏还写着「剧情对话」）。
      renderTopbarMode();
      updateReplyVoiceToggle();
      setChatListStatus("");
    } catch (error) {
      if (sequence !== liveState.switchSequence || (error && (error.name === "AbortError" || error.code === "CHAT_STALE"))) return;
      if (isAuthRequired(error)) { showAuthGate(); return; }
      syncActiveSession();
      showToast(error && error.code === "CHAT_MISSING" ? "这段对话已不可用，请重试或刷新列表" : "暂时无法打开这段对话，请重试");
    } finally {
      if (sequence === liveState.switchSequence) {
        liveState.switching = false;
        liveState.switchController = null;
        setChatControlsDisabled(false);
        updateComposerLive();
      }
    }
  }

  function disableComposer(message) {
    const input = $("#messageInput");
    const send = $("#sendButton");
    const stop = $("#stopButton");
    if (input) { input.disabled = true; input.placeholder = message || "暂时无法发送"; }
    if (send) send.disabled = true;
    if (stop) stop.hidden = true;
  }

  function setChatControlsDisabled(disabled, options = {}) {
    const allowSelection = options.allowSelection === true;
    const newButton = $("#newConversationButton");
    if (newButton) newButton.disabled = !!disabled;
    document.querySelectorAll(".history-row").forEach((button) => { button.disabled = !allowSelection && !!disabled; });
    document.querySelectorAll(".history-row-action").forEach((button) => { button.disabled = !!disabled || button.dataset.empty === "true"; });
    document.querySelectorAll(".character-history-add").forEach(button => {
      button.disabled = !!disabled || liveState.pending || button.dataset.unavailable === "true";
    });
    const retry = $("#chatListRetry");
    if (retry) retry.disabled = !!disabled;
    renderArchivedChatSettings();
  }

  function updateComposerLive() {
    const oai = (liveState.settings && liveState.settings.oai_settings) || {};
    const deepseekMode = !!(window.TASK22_CORE && window.TASK22_CORE.isDeepSeekChatMode(liveState.modelMode));
    const input = $("#messageInput");
    const send = $("#sendButton");
    const stop = $("#stopButton");
    const ready = !!(liveState.templateReady && liveState.card && (oai.custom_url || deepseekMode) && liveState.activeSession);
    const blocked = liveState.switching;
    // 2026-09-18：发送键**按需出现**（有字 / 生成中才出现，空着时那一格是「+」）。
    // 在这里先摘掉 hidden，真正的显隐由下面 updateComposerAffordances 一处决定 ——
    // 这一行是"当前对话还不能发"时别留一颗藏起来的按钮（hide 掉它，别只是禁用）。
    if (send) send.hidden = !(composerDraft() || liveState.generationPhase === "generating");
    if (ready) {
      if (input) { input.disabled = liveState.pending || blocked; input.placeholder = liveState.pending || blocked ? "请稍候…" : `写下你想对 ${activeCharacterShortName()} 说的话…`; }
      if (send) {
        const generating = liveState.generationPhase === "generating";
        const saving = liveState.generationPhase === "saving";
        send.disabled = blocked || saving;
        send.dataset.mode = liveState.pending ? "stop" : "send";
        if (saving) send.dataset.mode = "saving";
        send.setAttribute("aria-label", generating ? "停止生成" : saving ? "正在保存" : "发送");
        send.innerHTML = generating
          ? '<span class="stop-glyph" aria-hidden="true"></span>'
          : saving ? '<span aria-hidden="true">…</span>'
            : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      }
    } else if (!liveState.pending && !liveState.switching) {
      disableComposer(liveState.templateBusy ? "正在准备对话…" : liveState.templateError ? "准备失败，请重试" : "正在准备对话…");
    }
    if (stop) { stop.hidden = true; stop.disabled = true; }
    setChatControlsDisabled(blocked, { allowSelection: true });
    renderCharacterPicker();
    renderSendEstimate();
    updateComposerAffordances();
  }

  function setLivePhase(phase) {
    liveState.generationPhase = phase === "generating" || phase === "saving" ? phase : "idle";
    liveState.pending = liveState.generationPhase !== "idle";
    const note = $("#typingNote");
    const stop = $("#stopButton");
    if (note) {
      note.hidden = !liveState.pending;
      // Task-27H：生成中与通用 AI 页面一致，只显示呼吸圆点；
      // 绝不能用 textContent 赋值，否则会抹掉圆点子节点。
      const label = note.querySelector(".typing-note-label");
      if (label) {
        const saving = liveState.generationPhase === "saving";
        label.hidden = !saving;
        label.textContent = saving ? "正在保存…" : "";
      }
    }
    if (stop) { stop.hidden = true; stop.disabled = true; }
    if (window.TASK25C_UI) window.TASK25C_UI.setWaiting(liveState.pending);
    setChatControlsDisabled(liveState.pending || liveState.switching);
    updateComposerLive();
  }

  function setLiveBusy(busy) {
    setLivePhase(busy ? "generating" : "idle");
  }

  function onEngineChange(engineId) {
    try { window.localStorage.setItem("r22.engine", engineId); } catch (_) { /* optional preference */ }
    updateComposerLive();
  }

  async function saveLiveChat(userText, assistantText, signal, overrides = {}) {
    if (!liveState.chatModel || !liveState.activeSession) throw new Error("chat unavailable");
    if (state.engine !== "A") throw new Error("unavailable");
    const result = await liveState.chatModel.saveTurn(userText, assistantText, {
      userName: liveState.userName,
      charName: overrides.charName || liveState.charName,
      signal,
      turnId: overrides.turnId || "",
      extra: Object.assign({ task22_engine: "A" }, overrides.extra || {}),
    });
    syncActiveSession();
    return result;
  }

  function restoreInput(text) {
    const input = $("#messageInput");
    if (!input) return;
    input.value = text;
    autoGrowComposer(input);
  }

  /* ==================================================================== *
   * 微信式输入条（2026-09-18 用户指定的形态）
   *
   *   [语音] [输入框] [表情] [+]  →（有字时 [+] 那一格变成发送 / 停止）
   *
   * 用户原话：「输入框要模仿微信（语音、输入框、表情、+号），发送键按需出现，
   * 输入框高度随文字长度变化，输入框要贴屏幕下侧」。
   * 三件事都在这里，别处不再各写一套：
   *   ① `autoGrowComposer` —— 高度跟着内容长，夹在 1 行到 CSS 的 max-height 之间；
   *   ② `updateComposerAffordances` —— 发送键"按需出现"：有字、或正在生成（这时它是停止）；
   *      空着的时候那一格是「+」；
   *   ③ `openComposerMenu` —— 「+」面板（角色语音那一档 + 本次请求）。
   * ==================================================================== */

  /**
   * 输入框高度跟着内容走。
   *
   * 为什么先设 `auto` 再量：`scrollHeight` 是"内容需要多高"，但它不会自己变小 ——
   * 不先把高度清掉，删字之后框会一直停在最长的那一档（用户看到的"删了也不缩回去"）。
   * 上限由 CSS 的 `max-height` 决定（桌面 160px / 手机 132px），这里只负责不越界。
   */
  function autoGrowComposer(input) {
    const node = input || $("#messageInput");
    if (!node) return;
    const style = window.getComputedStyle(node);
    const max = parseFloat(style.maxHeight) || 160;
    const min = parseFloat(style.minHeight) || 30;
    // 先清成 auto 再量：`scrollHeight` 是"内容需要多高"，但盒子被固定住时它不会自己变小 ——
    // 不先清掉，删字之后框会停在最长的那一档（用户看到的"删了也不缩回去"）。
    node.style.height = "auto";
    const natural = node.scrollHeight;
    const wanted = Math.max(min, Math.min(natural, max));
    node.style.height = `${Math.round(wanted)}px`;
    // ⚠ 不能拿**刚设完高度**的 `node.scrollHeight` 判"封没封顶"：那时盒子已经夹到上限，
    //   量出来永远像"没超"，于是 overflow 停在 hidden、多出来的行用户看不见
    //   （我自己的用例当场抓到的）。所以用**设高度之前**量到的自然高度判。
    node.style.overflowY = natural > max + 1 ? "auto" : "hidden";
  }

  /** 输入框里有没有"要发的东西"（空白不算 —— 空格的发送键点了也不会发出去）。 */
  function composerDraft() {
    const input = $("#messageInput");
    return String((input && input.value) || "").trim().length > 0;
  }

  /**
   * 「发送键按需出现」：**只在这一处**决定它出现还是让位给「+」。
   *
   * 口径（用户 2026-09-18）：
   *   · 输入框里有字 → 发送（生成中也照样给"停止"，连发合并那条路要用它）；
   *   · 空着、也没在生成 → 藏起来，那一格是「+」；
   *   · 空着、正在生成 → 出现并显示"停止"（否则用户没法中断）。
   * ⚠ `dataset.mode` 与 `disabled` 仍然由 `updateComposerLive` 写：那几个值有用例盯着
   *   （"发送键可用"= `disabled === false && dataset.mode === 'send'`），不能因为藏起来就乱掉。
   */
  function updateComposerAffordances() {
    const send = $("#sendButton");
    const plus = $("#composerPlusButton");
    const typing = liveState.generationPhase === "generating";
    const hasDraft = composerDraft();
    const showSend = hasDraft || typing;
    // 诊断出口（只读）：用例与真机排查都能看到"上一次判定的输入是什么"，
    // 免得"发送键没出现"只能靠猜（这个项目里"看不见的判定"最容易骗人）。
    window.__rwComposerProbe = { hasDraft, typing, showSend, phase: liveState.generationPhase || "idle" };
    if (send) send.hidden = !showSend;
    if (plus) {
      // 微信里也是这个分工：有内容时加号让位给发送，空着时加号在。
      plus.hidden = showSend;
      if (showSend) setComposerMenuOpen(false);
    }
    if (!showSend && plus) plus.setAttribute("aria-expanded", "false");
  }

  /** 「+」面板开着还是关着。 */
  let composerMenuOpen = false;

  function setComposerMenuOpen(open) {
    const menu = $("#composerMenu");
    const button = $("#composerPlusButton");
    composerMenuOpen = !!open;
    if (menu) {
      menu.hidden = !composerMenuOpen;
      menu.classList.toggle("is-open", composerMenuOpen);
    }
    if (button) button.setAttribute("aria-expanded", composerMenuOpen ? "true" : "false");
    if (composerMenuOpen) renderComposerMenu();
  }

  /** 「+」面板里「本次请求」那一行（代理按钮）。 */
  let composerMenuPeekRow = null;

  function buildComposerMenuPeekRow() {
    if (composerMenuPeekRow) return composerMenuPeekRow;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "composer-menu-item";
    row.id = "composerMenuPeek";
    row.textContent = "本次请求";
    // ⚠ 这里是**代理**：真正的开关是输入条那边的 `#requestPeekButton`
    //   （`setRequestPeekVisible` 按"有没有草稿/发过消息"控制它）。
    //   不把那个节点搬进面板 —— 搬走之后它虽然在 DOM 里、却在一个 hidden 面板下，
    //   而 `.click()` 对隐藏节点照样有效，于是"入口看不见却能被点开"，
    //   用例与真实用户看到的东西就对不上了（这个项目反复踩的同一类坑）。
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      setComposerMenuOpen(false);
      openRequestPeek();
    });
    composerMenuPeekRow = row;
    syncComposerMenuPeek();
    return row;
  }

  /**
   * 画「+」面板：**只有入口，没有解释文字**（用户 2026-09-18：「所有不必要的文字解释全删」）。
   *
   * 放两样东西：
   *   · 「角色语音」那一档（节点就是 index.html 里的 `#replyVoiceToggle`，**移动**进来，
   *     不是复制 —— 复制会让两个入口抢同一份状态，实测那种"两个开关各说各话"最难查）；
   *   · 「本次请求」（原来挂在输入条左边，手机上那一行已经够挤了，收进这里更干净）。
   * 面板每次打开都重画内容（朗读/语音那一档的文字由 `updateReplyVoiceToggle` 决定）。
   */
  function renderComposerMenu() {
    const menu = $("#composerMenu");
    if (!menu) return;
    menu.textContent = "";
    const voice = document.querySelector("#replyVoiceToggle");
    if (voice) menu.appendChild(voice);
    menu.appendChild(buildComposerMenuPeekRow());
    syncComposerMenuPeek();
  }

  function bindComposerMenu() {
    const button = $("#composerPlusButton");
    if (button && !button.dataset.bound) {
      button.dataset.bound = "1";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setComposerMenuOpen(!composerMenuOpen);
      });
    }
    const input = $("#messageInput");
    if (input && !input.dataset.growBound) {
      input.dataset.growBound = "1";
      // 输入 / 粘贴 / 语音转文字（那一条自己派发 input）都要重算高度与按钮，
      // 所以**只绑 input 一个事件**，别在别处再量一次。
      input.addEventListener("input", () => {
        autoGrowComposer(input);
        updateComposerAffordances();
      });
    }
  }

  /** 输入条那两块小面板的"开着没"与"关掉"（返回手势要用，见 app/back-nav.js）。 */
  function isComposerMenuOpen() { return composerMenuOpen === true; }
  function closeComposerMenus() {
    let closed = false;
    if (composerMenuOpen) { setComposerMenuOpen(false); closed = true; }
    const picker = document.querySelector(".sticker-picker");
    if (picker) { picker.remove(); closed = true; }
    if (liveState.pickerOpen) { setPickerMenuOpen(false); closed = true; }
    return closed;
  }
  function isCharacterPickerOpen() { return liveState.pickerOpen === true; }

  /* ==================================================================== *
   * 按住说话（语音 → 文字）与发表情
   *
   * 语音这条路要分三级，因为三端能力完全不同（2026-09-13 调研）：
   *   ① 浏览器自带 SpeechRecognition —— 网页版 / 桌面版多半有；
   *      **Android 系统 WebView 里没有**（Chromium 把它和语音合成一起关掉了）；
   *   ② 录下来发给用户自己配的 OpenAI 兼容转写接口（要他填了 Key 才行）；
   *   ③ 都不行：按钮直接不出现 —— 不摆一个点了没反应的麦克风。
   * ==================================================================== */

  let recorder = null;       // 正在录音时的句柄
  let listeningStop = null;  // 正在识别时的中止函数

  function micAvailable() {
    const Voice = window.RoleWorldVoice;
    if (!Voice) return false;
    const cap = Voice.capability();
    return cap.asr || cap.record;
  }

  /** 把识别/转写回来的文字放进输入框，并把光标放到末尾（用户接着改）。 */
  function applySpeechText(text) {
    const input = $("#messageInput");
    if (!input || !text) return;
    const existing = input.value.trim();
    // 已经有字就接在后面，不要覆盖用户刚打的（他可能是边说边改）
    input.value = existing ? existing + " " + text : text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* 无所谓 */ }
  }

  function setMicState(state) {
    const button = $("#micButton");
    if (!button) return;
    button.classList.toggle("is-listening", state === "listening");
    button.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
    button.title = state === "listening"
      ? (window.RoleWorldVoice && window.RoleWorldVoice.hasSpeechRecognition() ? "松开结束" : "再点一下结束录音")
      : "按住说话（松开结束）";
  }

  async function startSpeech() {
    const Voice = window.RoleWorldVoice;
    if (!Voice) return;
    const cap = Voice.capability();
    const lang = languageForAvatar((activeCharacterEntry() || {}).avatar || "") === "en" ? "en-US" : "zh-CN";
    setMicState("listening");
    if (cap.asr) {
      const result = await Voice.listen({
        lang,
        onPartial: (finalText, interim) => {
          const input = $("#messageInput");
          if (input) input.placeholder = (finalText + interim) || "在听…";
        },
        onStart: (abort) => { listeningStop = abort; },
      });
      listeningStop = null;
      const input = $("#messageInput");
      if (input) input.placeholder = "给 " + (liveState.charName || "角色") + " 发消息";
      setMicState("idle");
      if (result.ok) applySpeechText(result.text);
      else if (!result.canceled && result.reason) showToast(result.reason);
      return;
    }
    if (cap.record) {
      // 没有内置识别：录一段，交给用户自己配的转写接口。
      try {
        recorder = await Voice.startRecording();
      } catch (error) {
        setMicState("idle");
        showToast("打不开麦克风：" + (error && error.message ? error.message : String(error)));
        return;
      }
      showToast("在录音 —— 再点一下结束");
      return;
    }
    setMicState("idle");
    showToast(cap.asrReason || "这个环境用不了语音输入。");
  }

  async function finishSpeech() {
    const Voice = window.RoleWorldVoice;
    setMicState("idle");
    if (listeningStop) {
      listeningStop();
      return;
    }
    if (!recorder) return;
    const handle = recorder;
    recorder = null;
    handle.stop();
    const blob = await handle.done;
    if (!blob || !blob.size) {
      showToast("没有录到声音。");
      return;
    }
    // 转写要用用户自己的 Key（和聊天同一份），所以从设置里现取。
    // 密钥按服务商分开存（api_key_deepseek / api_key_openai / …），用 Model.secretKeyFor 现算，
    // 不能写死一个键名 —— 那样换个服务商就取不到。
    let settings = null;
    let key = "";
    try {
      settings = await window.RoleWorld.getLocalSettings();
      const secretKey = window.RoleWorld.model && window.RoleWorld.model.secretKeyFor ? window.RoleWorld.model.secretKeyFor(settings) : "";
      const secret = secretKey ? await window.RoleWorld.secrets.get(secretKey) : null;
      key = (secret && secret.value) || "";
    } catch (_) { /* 取不到就当作没配 */ }
    if (!settings || !key) {
      showToast("录好了，但没有可用的转写服务：请在「设置 → 模型」配好服务商与 API Key（会用你自己的额度）。");
      return;
    }
    showToast("正在转成文字…");
    const result = await Voice.transcribeBlob(blob, {
      endpoint: settings.endpoint || "",
      apiKey: key,
      lang: languageForAvatar((activeCharacterEntry() || {}).avatar || ""),
    });
    if (result.ok) applySpeechText(result.text);
    else showToast(result.reason || "转写失败。");
  }

  /** 关掉表情面板（返回手势与"点别处关掉"共用一个出口）。返回是否真的关掉了。 */
  function closeStickerPicker() {
    const picker = document.querySelector(".sticker-picker");
    if (!picker) return false;
    picker.remove();
    return true;
  }

  /** 给输入区挂上按钮。没有能力就不显示 —— 不摆点了没反应的控件。 */
  async function bindComposerExtras() {
    // ---- 用户的语音输入（按住说话 → 文字）：**2026-09-14 用户拍板"先不做"** ----
    // 原话：「我认为可以先不做用户的语音输入，而且现在的也不能用」。
    // 实测为什么用不了：它靠**浏览器自带**的识别（Chrome/Edge 的 webkitSpeechRecognition），
    // 而那一步要连它们自己的云服务 —— 国内网络下基本必然失败；退路"录下来发给用户自己配的
    // 转写接口"又要求用户先配好 Key。真要做，路子和语音合成一样：**录音经体验卡中转发出去转写**，
    // 那是另一件事（要新的中转接口 + 额度 + 隐私告知），所以先按用户的意思收起来。
    // ⚠ 代码**留着**（`voice-core` 的 listen/transcribeBlob 与下面这些处理函数一行没删）：
    //   重开只需要把这里改回 `micAvailable()`，等真要做时直接接上。
    // 不显示入口 = 不摆一个点了没反应的按钮（这个项目的硬规矩）。
    const micEnabled = false;
    let speechEnabled = false;
    try {
      const settings = await window.RoleWorld.getLocalSettings();
      speechEnabled = settings.speech_input_enabled !== false;
    } catch (_) { /* 读不到设置就按默认 */ }
    const mic = $("#micButton");
    if (mic) mic.hidden = true;
    if (mic && micEnabled && speechEnabled && micAvailable()) {
      mic.hidden = false;
      const hasAsr = window.RoleWorldVoice.hasSpeechRecognition();
      if (hasAsr) {
        // 有内置识别：按住说、松开停（手机上是标准手势）
        mic.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          startSpeech().catch(() => setMicState("idle"));
        });
        mic.addEventListener("pointerup", () => { finishSpeech().catch(() => {}); });
        mic.addEventListener("pointercancel", () => { finishSpeech().catch(() => {}); });
        mic.addEventListener("pointerleave", () => { if (recorder || listeningStop) finishSpeech().catch(() => {}); });
      } else {
        // 只能录音：点一下开始、再点一下结束（录音没有"松开即停"的语义）
        mic.addEventListener("click", () => {
          if (recorder) finishSpeech().catch(() => {});
          else startSpeech().catch(() => setMicState("idle"));
        });
      }
    }
    const sticker = $("#stickerButton");
    if (sticker && window.RoleWorldStickersPack) {
      sticker.hidden = false;
      sticker.addEventListener("click", (event) => {
        event.stopPropagation();
        openStickerPicker(sticker);
      });
    }
  }

  /** 表情选择面板：点一张就把它当一条消息发出去。 */
  async function openStickerPicker(anchor) {    const existing = document.querySelector(".sticker-picker");
    if (existing) { existing.remove(); return; }
    let stamps = [];
    try { stamps = await window.RoleWorldStickersPack.availableStamps(); } catch (_) { stamps = []; }
    if (!stamps.length) {
      showToast("还没有可用的表情包。");
      return;
    }
    const panel = document.createElement("div");
    panel.className = "sticker-picker";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "选一个表情");
    const title = document.createElement("p");
    title.className = "sticker-picker-title";
    title.textContent = "点一张发给" + (liveState.charName || "角色");
    const grid = document.createElement("div");
    grid.className = "sticker-picker-grid";
    for (const stamp of stamps) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sticker-picker-item";
      button.dataset.stickerId = stamp.id;
      const img = document.createElement("img");
      img.src = stamp.url;
      img.alt = stamp.name;
      img.loading = "lazy";
      const label = document.createElement("span");
      label.textContent = stamp.name;
      button.append(img, label);
      // ⚠ 点击必须**直接绑在这个按钮上**（不能靠消息区那个委托）：
      //   这个面板挂在 `.composer-box`（输入框那一块），而消息区的委托绑在
      //   `#dynamicMessages` 上 —— 两者是**兄弟节点**，点在表情上的事件根本到不了那里。
      //   现象就是"面板能开、点一张完全没反应"（用户 2026-09-18 实测）。
      //   同一个坑以前在「设置 → 语音」的试听按钮上踩过一次（见下面 #dynamicMessages
      //   委托里那段注释）：凡是挂在消息区之外的控件，都不能指望那个委托。
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sendSticker(stamp.id).catch(() => {});
      });
      grid.appendChild(button);
    }
    panel.append(title, grid);
    const composer = anchor.closest(".composer-box") || anchor.parentElement;
    (composer || document.body).appendChild(panel);
    // 点外面就关掉
    const close = (event) => {
      if (event && panel.contains(event.target)) return;
      panel.remove();
      document.removeEventListener("click", close);
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  /** 用户那条消息如果是"发了一个表情"，取回对应的表情对象（取不到 → null，按文字渲染）。
   *  标记格式的解析在 `sticker-core.userStickerName`（与写进去的那个函数成对），
   *  这里只负责"名字 → 图"。 */
  function userStickerStamp(text) {
    const Lib = window.RoleWorldStickers;
    const Pack = window.RoleWorldStickersPack;
    if (!Lib || !Pack || typeof Lib.userStickerName !== "function") return null;
    const name = Lib.userStickerName(text);
    if (!name) return null;
    const stamps = (Pack.cachedStamps && Pack.cachedStamps()) || [];
    if (!stamps.length) return null;
    try {
      return Lib.resolve(name, Lib.indexStamps(stamps)) || null;
    } catch (_) {
      return null;
    }
  }

  /** 用户发了表情：把那张图发出去。 */
  async function sendSticker(id) {
    const stamp = window.RoleWorldStickersPack && window.RoleWorldStickersPack.stampById
      ? window.RoleWorldStickersPack.stampById(id)
      : null;
    if (!stamp) { showToast("这个表情已经不在本地了。"); return; }
    const picker = document.querySelector(".sticker-picker");
    if (picker) picker.remove();
    const text = window.RoleWorldStickers
      ? window.RoleWorldStickers.stickerAsMessageText(stamp)
      : "[玩家发了一个表情]";
    // 记进对话的是**文字形式**（角色看得见"对方发了个什么表情"），
    // 图片靠消息上的 roleworld_stickers 显示 —— 和角色发过来的走同一套。
    restoreInput(text);
    const sent = typeof sendLive === "function" ? sendLive : null;
    if (sent) await sent();
  }

  function stopLive() {
    if (liveState.generationPhase !== "generating") return;
    liveState.cancelRequested = true;
    // 用户主动取消：这一轮所有**晚回来的异步任务**（语音合成、逐条送达）就此作废 ——
    // 号码一加，它们比对失败就不会再碰界面（数据仍按 turnId 写回那条消息）。
    liveState.generationSeq += 1;
    cancelScheduledReveals();
    if (liveState.controller) liveState.controller.abort();
  }

  /** 「上次说到」的两个按钮：以此开头 / 收起。都不发消息，也不改对话内容。 */
  function bindChatRecap() {
    const use = document.querySelector("#chatRecapUse");
    if (use) use.addEventListener("click", () => {
      const info = chatRecapInfo();
      if (!info) return;
      const input = $("#messageInput");
      if (!input) return;
      // 只填进输入框，让用户自己改；不替他说话、不直接发出去。
      input.value = `上次说到「${info.snippet}」，接着聊。`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    const dismiss = document.querySelector("#chatRecapDismiss");
    if (dismiss) {
      dismiss.title = RECAP_DISMISSED_NOTE;
      dismiss.addEventListener("click", () => {
        const info = chatRecapInfo();
        if (info) recapDismissed.add(info.file);
        const bar = document.querySelector("#chatRecapBar");
        if (bar) bar.hidden = true;
      });
    }
  }

  /** 输入时刷新「发送前预估」（防抖：打字过程中不必每个字符都算一遍）。 */
  function bindSendEstimate() {
    const input = $("#messageInput");
    if (!input) return;
    let timer = 0;
    input.addEventListener("input", () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = 0; renderSendEstimate(); }, 250);
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && liveState.generationPhase === "generating") {
      event.preventDefault();
      stopLive();
    }
  });
  /* ---------- 角色对话流式生成（2026-09-09） ----------
   * 与通用 AI 同一套策略：不依赖 content-type（ST 代理不复制响应头），
   * 按内容判断 SSE；整段一次性到达时打字机兜底；无正文时非流式重试一次。 */
  function consumeChatSseText(chunk, sink) {
    for (const line of String(chunk || "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
      const dataText = trimmed.slice(5).trim();
      if (!dataText || dataText === "[DONE]") continue;
      let json = null;
      try { json = JSON.parse(dataText); } catch (_) { continue; }
      // include_usage 的用量会在最后一段单独回来（那一chunk 没有 choices）。
      if (json && json.usage) sink.usage = json.usage;
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      // 结束原因：`length` = 撞上了输出上限、话被截断了。
      // 以前完全不看这个字段，用户只能看到一句半截的话，不知道是模型写崩了还是被砍了。
      if (choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
        sink.finishReason = choice.finish_reason;
      }
      const delta = choice && (choice.delta || choice.message);
      if (!delta) continue;
      const piece = typeof delta.content === "string" ? delta.content : "";
      // 思考过程默认丢弃：否则会先出现一段思维链、正文一到就被顶掉，看着像闪一下。
      // 只有用户在「设置 → 对话」里打开思考模式时才累积它。
      const reasoning = liveState.thinking && typeof delta.reasoning_content === "string"
        ? delta.reasoning_content : "";
      if (piece) sink.content += piece;
      if (reasoning) sink.reasoning += reasoning;
      if (piece || reasoning) { sink.chunks += 1; sink.emit(); }
    }
  }

  function parseChatWholeText(raw, sink) {
    const text = String(raw || "");
    if (/^\s*data:/m.test(text)) { consumeChatSseText(text, sink); return; }
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    const parsed = window.TASK22_CORE.parseGenerateResponse(json);
    if (parsed.content) sink.content = parsed.content;
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    if (choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
      sink.finishReason = choice.finish_reason;
    }
  }

  /**
   * 「正在输入…」那一行（三个小点，CSS 做动画）。
   *
   * ⚠ 这一行**不是装饰**：软件聊天模式下"消息类型还没定"的那几秒，屏幕上**只许有它**。
   * 用户 2026-09-14 实测反馈「先看到文字 → 文字消失 → 出现语音」就是在这里修的 ——
   * 与其中途显示一段会被替换掉的正文，不如老老实实显示"对方正在输入"。
   */
  function typingIndicatorNode() {
    const note = document.createElement("span");
    note.className = "typing-dots";
    note.setAttribute("role", "status");
    note.setAttribute("aria-label", "对方正在输入");
    note.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    return note;
  }

  function appendLiveStreamRow(name, options) {
    const opts = options || {};
    const container = $("#dynamicMessages");
    if (!container) return null;
    const row = document.createElement("article");
    row.className = "message-row message-row-assistant";
    // 状态写在 DOM 上：用例据此断言"中间帧没有正文"（只截图看最后一眼是抓不到的）。
    row.dataset.streamState = opts.typingOnly ? "typing" : "streaming";
    const avatar = document.createElement("div");
    avatar.className = "message-avatar assistant-avatar";
    avatar.setAttribute("aria-label", name || liveState.charName);
    avatar.setAttribute("role", "img");
    const stack = document.createElement("div");
    stack.className = "message-stack";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const who = document.createElement("strong");
    who.textContent = name || liveState.charName;
    meta.appendChild(who);
    stack.appendChild(meta);
    const body = document.createElement("div");
    body.className = "assistant-body";
    if (opts.typingOnly) {
      // 只显示输入状态：**这里一个字正文都不放**（连 DOM 里都不放，免得被读屏念出来）。
      body.classList.add("assistant-body-typing");
      body.appendChild(typingIndicatorNode());
    } else {
      body.innerHTML = renderAssistantBody("");
    }
    stack.appendChild(body);
    row.appendChild(avatar);
    row.appendChild(stack);
    container.appendChild(row);
    const scroll = $("#chatScroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    return { row: row, body: body, scroll: scroll, typingOnly: !!opts.typingOnly };
  }

  function updateLiveStreamRow(handle, text) {
    if (!handle || !handle.row.parentNode) return;
    // 软件聊天模式：正文一律不进界面（类型还没定，显示了就要被替换）。
    if (handle.typingOnly) return;
    // 边流边按最终格式渲染（旁白/对白分行），否则会先看到一堆原始符号、
    // 等保存后再"重新排版"一次，看起来很跳。
    // 表情也在这一层解析：标记一写完就换成一排图（保存还没发生，所以拿的是内存里的缓存）。
    const stamps = (window.RoleWorldStickersPack && window.RoleWorldStickersPack.cachedStamps
      && window.RoleWorldStickersPack.cachedStamps()) || [];
    const parsed = (window.RoleWorldStickers && stamps.length)
      ? window.RoleWorldStickers.extractStickers(text, stamps)
      : { text: text, stickers: [] };
    // 软件聊天那一档：屏幕上只留对白（旁白、括号描写都不显示）——
    // 跟存下来之后渲染用的**同一份规则**，不能流式时一套、存好了又换一套。
    const shown = isPlainChatActive() ? plainChatText(parsed.text) : parsed.text;
    handle.body.innerHTML = renderAssistantBody(shown, parsed.stickers);
    const paragraphs = handle.body.querySelectorAll("p");
    const last = paragraphs[paragraphs.length - 1];
    if (last) last.classList.add("stream-text"); // 保留光标
    if (handle.scroll) handle.scroll.scrollTop = handle.scroll.scrollHeight;
  }

  function removeLiveStreamRow(handle) {
    if (handle && handle.row.parentNode) handle.row.parentNode.removeChild(handle.row);
  }

  async function typewriterLive(handle, text, signal) {
    if (!handle) return;
    const reduced = document.documentElement.dataset.motion === "reduced"
      || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced) return;
    const step = Math.max(2, Math.ceil(text.length / 70));
    for (let index = step; index < text.length; index += step) {
      if (signal && signal.aborted) break;
      updateLiveStreamRow(handle, text.slice(0, index));
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
    updateLiveStreamRow(handle, text);
  }

  async function generateChatStream(payload, signal, onDelta) {
    // 本地版：适配层直接把请求发到用户配置的模型端点，并原样返回 Response。
    const request = (body) => {
      if (window.STApi && typeof window.STApi.generateStream === "function") {
        return window.STApi.generateStream(body, signal);
      }
      throw new Error("模型适配层未加载，请刷新页面后重试");
    };
    const response = await request(payload);
    if (!response.ok) throw Object.assign(new Error("generation failed"), { status: response.status });

    const sink = { content: "", reasoning: "", chunks: 0, usage: null, finishReason: "", emit: () => onDelta(sink.content || sink.reasoning) };
    liveState.streamChunks = 0;
    liveState.lastUsage = null;
    liveState.lastFinishReason = "";
    const finish = () => (sink.content || sink.reasoning).trim();
    const retryNonStream = async () => {
      const data = (window.STApi && typeof window.STApi.generate === "function")
        ? await window.STApi.generate(Object.assign({}, payload, { stream: false }), signal)
        : await (async () => {
          const res = await request(Object.assign({}, payload, { stream: false }));
          if (!res.ok) throw Object.assign(new Error("generation failed"), { status: res.status });
          return res.json();
        })();
      const parsed = window.TASK22_CORE.parseGenerateResponse(data);
      liveState.streamChunks = sink.chunks;
      if (parsed.content) { onDelta(parsed.content); return parsed.content; }
      return "";
    };

    if (!response.body) {
      parseChatWholeText(await response.text(), sink);
      liveState.streamChunks = sink.chunks;
      liveState.lastUsage = sink.usage || null;
      liveState.lastFinishReason = sink.finishReason || "";
      const buffered = finish();
      if (buffered) return buffered;
      return retryNonStream();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const separator = /\r?\n\r?\n/;
    let buffer = "";
    let rawAll = "";
    let sseMode = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const decoded = decoder.decode(chunk.value, { stream: true });
      if (!sseMode) {
        rawAll += decoded;
        if (/^\s*data:/m.test(rawAll)) { sseMode = true; buffer += rawAll; rawAll = ""; }
        else continue;
      } else {
        buffer += decoded;
      }
      let match;
      while ((match = separator.exec(buffer))) {
        consumeChatSseText(buffer.slice(0, match.index), sink);
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (sseMode && buffer.trim()) consumeChatSseText(buffer, sink);
    liveState.streamChunks = sink.chunks;
    liveState.lastUsage = sink.usage || null;
    liveState.lastFinishReason = sink.finishReason || "";
    const streamed = finish();
    if (streamed) return streamed;
    if (rawAll.trim()) parseChatWholeText(rawAll, sink);
    liveState.streamChunks = sink.chunks;
    const whole = finish();
    if (whole) return whole;
    return retryNonStream();
  }

  /**
   * **连发**：正在生成回复时又敲了一句并按下发送 —— 把这一轮掐掉，两句并成一句重新问。
   *
   * 用户 2026-09-14：「如果用户连发的话应该也是可以统一回答的，就是尽可能地模仿真人」。
   * 真人聊天里对方还没回你，你补一句，他回的是**你两句话**，而不是各回一次。
   *
   * 为什么不是"等一个窗口再发"：那样每次发消息都要先卡 1 秒（点了像没反应），
   * 而真实的手感是"第一条立刻发出去，补的那条并进去"——掐掉重问正好是这个手感。
   *
   * 输入框里**没打字**时 = 用户只是想停（保持以前的行为：停止生成）。
   */
  async function sendWhileBusy() {
    const input = $("#messageInput");
    const extra = String((input && input.value) || "").trim();
    const previous = String(liveState.pendingText || "").trim();
    if (!extra || !previous) { stopLive(); return false; }
    // 这一轮要作废（不落盘）——见 save 前那段 coalesceAbort 的判断。
    liveState.coalesceAbort = true;
    stopLive();
    // 等这一轮真的收尾（abort、清理、界面都结束）再发，否则两条会打架。
    for (let i = 0; i < 60 && liveState.pending; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 新一轮：别沿用上一轮那个"保存结果不确定"的幂等标记（那一轮根本没落盘）。
    liveState.pendingTurnId = "";
    liveState.uncertainSave = null;
    if (input) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    showToast("把你刚补的那句并成一条一起问了");
    return sendLive(previous + "\n" + extra);
  }

  async function sendLive(textOverride) {
    const input = $("#messageInput");
    const originalInput = input && input.value || "";
    // 「重新回答」：不读输入框，用这条回复前面那句用户话当这一轮的输入；
    // 上下文截到这条回复之前（也就是把要重答的那一版先摘掉）。
    const regenIndex = Number.isInteger(liveState.regenerateIndex) ? liveState.regenerateIndex : -1;
    const regenSession = liveState.activeSession;
    const regenMessages = (regenSession && regenSession.messages) || [];
    const regenAsk = regenIndex >= 0 ? regenMessages[regenIndex - 1] : null;
    // 传了文本就用它（"连发合并"那条路会把两句并成一轮一起问，见 sendWhileBusy）。
    const override = String(textOverride === undefined || textOverride === null ? "" : textOverride).trim();
    const text = regenAsk ? String(regenAsk.mes || "").trim() : (override || originalInput.trim());
    if (!text || liveState.pending || liveState.switching || !liveState.activeSession) return;
    if (regenIndex >= 0 && (!regenAsk || regenAsk.is_user !== true)) { liveState.regenerateIndex = null; return; }
    if (!liveState.templateReady) {
      setChatTemplateGate(liveState.templateError ? "error" : "loading");
      return;
    }
    const oai = (liveState.settings && liveState.settings.oai_settings) || {};
    const deepseekMode = window.TASK22_CORE.isDeepSeekChatMode(liveState.modelMode);
    if (!deepseekMode && !oai.custom_url) {
      showToast("暂时无法回复，请重试");
      updateComposerLive();
      return;
    }
    const targetSession = liveState.activeSession;
    // 步骤 0.5（2026-09-18 第三版）：注定 401 的组合**在发之前**就拦住。
    // 「重新回答」不吃这道闸：那一轮不改正文、也不新增用户消息，拦下来只会让人更糊涂；
    // 而且它的出问题方式与"新发一句"不同（见 CHAT_401_GUARD_ATTEMPT_REVERTED.md 的处置）。
    if (regenIndex < 0) {
      const blocked = await chatPreflight();
      if (blocked) {
        renderChatPreflight(blocked, text);
        updateComposerLive();
        return;
      }
    }
    // 目标角色：已绑定会话用会话头像；未绑定空白会话用待选（缺省默认角色）。
    const entry = activeCharacterEntry();
    if (!entry || !entry.avatar) {
      showToast("暂时无法回复，请重试");
      updateComposerLive();
      return;
    }
    // 重新回答：上下文截到"要重答的那条回复"之前（那句用户话已经在里面了），
    // 所以这里既不新增用户消息，界面上也不重复显示那句话。
    const previousMessages = regenIndex >= 0 ? targetSession.messages.slice(0, regenIndex) : targetSession.messages.slice();
    // 本轮标识（重发同一句会沿用同一个）：只有在「上一轮保存结果不确定」时才用它去查回执。
    const turnId = liveState.pendingTurnId || newTurnId();
    liveState.pendingTurnId = turnId;
    liveState.cancelRequested = false;
    if (regenIndex < 0) restoreInput("");
    renderLiveMessages(regenIndex >= 0
      ? previousMessages
      : previousMessages.concat([{ name: liveState.userName, is_user: true, mes: text }]));
    setLiveBusy(true);
    liveState.pendingText = text;
    const controller = new AbortController();
    liveState.controller = controller;
    // 每一轮都记时：首字延迟（体感速度）与总延迟（等到答案的时间）。
    const turnStartedAt = Date.now();
    let firstTokenMs = 0;
    let saveCompleted = false;
    let bound = false;
    let streamRow = null;
    let duplicateTurn = false;
    try {
      // 步骤 0：幂等闸门 —— 上一轮其实已经落盘（请求发出去了、界面却当失败）就别再发第二次，
      // 否则同一条会被写两遍、模型也被计费两次。
      // 检查完立刻清掉标记：它只对"紧接着的那一次重发"有效，不会影响后面的正常发送。
      const uncertain = liveState.uncertainSave;
      liveState.uncertainSave = null;
      if (uncertain && await turnAlreadySaved(targetSession, turnId)) {
        const error = new Error("turn already saved");
        error.code = "TURN_ALREADY_SAVED";
        throw error;
      }
      // 步骤 1：角色初始化 —— 取目标角色完整卡（含 data.*），失败走失败路径。
      let card = liveState.cardCache && liveState.cardCache.get(entry.avatar);
      if (!card) {
        card = await window.STApi.getCharacter(entry.avatar);
        if (!card || !card.data) throw new Error("character card unavailable");
        if (liveState.cardCache) liveState.cardCache.set(entry.avatar, card);
      }
      // 只注入当前角色自己的记忆书（按书名的角色短名归属，多个角色各一套）。
      const memoryBooks = window.TASK29_CHARACTER_CORE.memoryBooksFor(entry, liveState.memoryBooks);
      // 旧对话：按 token 预算从最近往前回填（不再是写死的"最近 16 条"）。
      // 带不下的部分会被明确报告出来，面板上看得见丢了多少。
      window.__rwBudget = (liveState.localSettings && liveState.localSettings.history_token_budget) || 0;
      const historyPlan = window.TASK22_CORE.planHistory(previousMessages, {
        budget: liveState.localSettings && liveState.localSettings.history_token_budget,
        minMessages: liveState.localSettings && liveState.localSettings.history_min_messages,
      });
  /* 模型主动要求的检索：这一轮它写了 [[搜索: …]]，结果放进**下一轮**的上下文。
   * 存在本机 kv 里，所以刷新页面也不会丢；一次最多记 SEARCH_REQUEST_LIMIT 条。 */
  const PENDING_SEARCH_KEY = "pendingsearch:";

  function pendingSearchKey(entry) {
    return PENDING_SEARCH_KEY + ((entry && entry.avatar) || "unknown");
  }

  async function readPendingSearches(entry) {
    try {
      const stored = await window.RoleWorld.store.getKV(pendingSearchKey(entry), []);
      return Array.isArray(stored) ? stored.filter((row) => row && typeof row.query === "string" && row.query) : [];
    } catch (_) {
      return [];
    }
  }

  async function savePendingSearches(entry, rows) {
    try { await window.RoleWorld.store.setKV(pendingSearchKey(entry), rows.slice(0, CORE_SEARCH_LIMIT)); }
    catch (_) { /* 存不下只是少一层保护 */ }
  }

  /** 执行一批检索请求，返回给下一轮用的提示词片段。 */
  async function runPendingSearches(entry, requests, skipFileName) {
    const search = window.ROLEWORLD_SEARCH_CORE;
    if (!search || !requests.length) return { note: "", results: [] };
    const sessions = await loadSearchHistory(entry);
    const seen = new Set();
    const merged = [];
    const results = [];
    for (const request of requests) {
      const one = search.searchHistory(sessions, request.query, { skipFileName, limit: 3 });
      results.push({ query: request.query, matched: one.matched });
      for (const hit of one.hits) {
        const key = hit.fileName + "#" + hit.index;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(hit);
      }
    }
    merged.sort((a, b) => b.score - a.score);
    const note = merged.length
      ? search.buildHistoryNote({ hits: merged.slice(0, 6) })
      : search.buildHistoryNote({ hits: [] });
    return { note, results };
  }

  /* 检索用的历史：把该角色的**所有对话**都读出来（只读尾部若干条，避免一次吃下全部记录）。
   * 以前这里只看内存里已加载的当前会话，等于"只翻眼前这一页" —— 用户问以前的事永远找不到。
   * 结果按角色缓存，避免每轮都重读；新对话保存后缓存作废。 */
  const HISTORY_TAIL = 60;
  // 与 task22-core 的 SEARCH_REQUEST_LIMIT 保持一致（那边负责解析，这里负责执行与上限）。
  const CORE_SEARCH_LIMIT = window.TASK22_CORE.SEARCH_REQUEST_LIMIT;
  let historyCache = { avatar: "", rows: [], at: 0 };

  function invalidateHistoryCache() {
    historyCache = { avatar: "", rows: [], at: 0 };
  }

  async function loadSearchHistory(entry) {
    if (!entry || !entry.avatar || !window.STApi || typeof window.STApi.listChats !== "function") return [];
    const fresh = historyCache.avatar === entry.avatar && (Date.now() - historyCache.at) < 30000;
    if (fresh) return historyCache.rows;
    const rows = [];
    try {
      const chats = await window.STApi.listChats(entry.avatar);
      for (const chat of (Array.isArray(chats) ? chats : [])) {
        const fileName = chat && (chat.file_name || chat.file_id);
        if (!fileName) continue;
        let lines = [];
        try { lines = await window.STApi.getChat(entry.avatar, fileName); } catch (_) { continue; }
        // 只留真正的消息：聊天记录第一行是元数据头，它不该占"第几条"的位置。
        // 条数偏移量保留下来，这样报给用户/模型的"第几条"是相对整段对话的，而不是只相对尾部。
        const all = Array.isArray(lines) ? lines : [];
        const kept = [];
        let offset = 0;
        all.forEach((line, index) => {
          if (!line || typeof line.mes !== "string" || !line.mes) return;
          if (kept.length === 0) offset = index;
          kept.push(line);
        });
        const tail = kept.slice(-HISTORY_TAIL);
        offset += Math.max(0, kept.length - HISTORY_TAIL);
        rows.push({ fileName, messages: tail, offset });
      }
    } catch (_) { /* 读不到就退回内存里的会话 */ }
    if (!rows.length && liveState.chatModel) {
      liveState.chatModel.getSessions().forEach((session) => {
        rows.push({ fileName: session.fileName, messages: (session.messages || []).slice(-HISTORY_TAIL) });
      });
    }
    historyCache = { avatar: entry.avatar, rows, at: Date.now() };
    return rows;
  }

      // 步骤 1.5：诚实规则 + 历史检索。
      // 检索是**只读的本地关键词匹配**（不引入向量库、不调外部服务）：
      // 从这个人物的其他对话里翻出与这句话相关的原话，连同出处一起交给模型。
      // 翻不到就明确写"没有找到"，并要求它直说不知道 —— 不编造回忆。
      const search = window.ROLEWORLD_SEARCH_CORE;
      const extraParts = [];
      let searchResult = null;
      let requestedResults = [];
      // 伴侣模式：关系档案 + 时间感 + 那几条硬规矩。放在最前面 ——
      // 它定的是"你是谁、你们什么关系"，后面的诚实规则和检索结果都建立在这上面。
      let companionProfile = null;
      try {
        companionProfile = await loadCompanion(entry);
        const companionBlock = companionBlockFor(entry, companionProfile);
        if (companionBlock) extraParts.push(companionBlock);
        // 日常风格独立于伴侣开关；函数内部按当前语音能力另行附加媒介指令。
        // 非 plain / 内置角色不加，不改写旧档案的缺省风格。
        const styleBlock = plainChatBlock(entry, companionProfile);
        if (styleBlock) extraParts.push(styleBlock);
        // 用户用输入框那个开关要求"这一轮发语音"：这一轮多带一句明确要求
        //（开关同时会**强制**把回复里的条目做成语音消息，见 replyPartsFor）。
        if (voiceReplyRequestedNow()) {
          const request = voiceRequestBlock(entry);
          if (request) extraParts.push(request);
        }
      } catch (_) { companionProfile = null; }
      // 危机兜底（2026-09-12）：系统提示里本来就有一条"安全兜底"（每个角色每轮都有），
      // 命中危机词时**再加一条更详细的**，把"不承诺保密 / 不冒充真人 / 给一个具体动作"讲透。
      try {
        const safetyCore = window.ROLEWORLD_COMPANION_CORE;
        if (safetyCore && safetyCore.isCrisisText(text)) {
          extraParts.push(safetyCore.crisisInstruction(languageForAvatar(entry.avatar) === "en" ? "en" : "zh"));
        }
      } catch (_) { /* 安全规则加不上也不能挡住这一轮 */ }
      // 用途档案：伴侣模式用 companion，其余用 chat。
      // 它决定采样口味、回复格式指令、要不要自动检索 —— 数字只在 task22-core 那张表里。
      const purpose = companionProfile && companionProfile.enabled === true
        ? window.TASK22_CORE.PURPOSES.COMPANION
        : window.TASK22_CORE.PURPOSES.CHAT;
      const profile = window.TASK22_CORE.resolveProfile(purpose);
      if (search) {
        extraParts.push(search.honestyRule());
        // 检索里"跳过当前这段对话"要用真正的存储键：检索结果带的是原始文件名（可能带 .jsonl）。
        const currentFile = targetSession.storageFileName || targetSession.fileName;
        try {
          // ① 上一轮模型主动要求翻的内容（[[搜索: …]]）：结果在这一轮交给它。
          const pending = await readPendingSearches(entry);
          if (pending.length) {
            const run = await runPendingSearches(entry, pending, currentFile);
            if (run.note) extraParts.push(run.note);
            requestedResults = run.results;
            await savePendingSearches(entry, []);
          }
          // ② 本轮自动翻一次：玩家这句话里有没有提到以前聊过的事。
          //    用途档案说不用翻（剧情模式页）就不翻 —— 它有自己的场景历史，
          //    翻旧对话既费 token 又容易把剧情带偏。
          if (profile.autoSearch) {
            searchResult = search.searchHistory(await loadSearchHistory(entry), text, {
              skipFileName: currentFile,
              limit: 6,
            });
            extraParts.push(search.buildHistoryNote(searchResult));
            // ③ 告诉它"需要的话可以再翻一次"，并给出上限。
            extraParts.push(window.TASK22_CORE.searchInstruction());
          }
        } catch (_) { searchResult = null; }
      }
      const extraSystem = extraParts.join("\n\n");
      window.__rwThinking = liveState.thinking === true;

      // 步骤 1.6：表情包。装了表情、且用户没关掉时，把可用表情交给提示词 ——
      // 模型据此在回复末尾写 [[表情: 开心]]，前端再把它换成图。
      // 拿不到就当没有（表情坏了不能影响说话）。
      let stickerStamps = [];
      try {
        if (window.RoleWorldStickersPack) stickerStamps = await window.RoleWorldStickersPack.availableStamps();
      } catch (_) { stickerStamps = []; }

      // 步骤 2：流式发送。
      const payload = window.TASK22_CORE.buildGeneratePayload({
        card,
        memoryBooks,
        history: historyPlan.kept,
        userText: text,
        settings: liveState.settings,
        engine: state.engine,
        mode: liveState.modelMode,
        modelName: liveState.modelName,
        thinking: liveState.thinking === true,
        autoMemory: liveState.autoMemory !== false,
        autoEventMemory: liveState.eventMemory !== false,
        // 语言：没强制就传 null，模型就按角色卡自己写的语言说话（默认）。
        language: languageForAvatar(entry.avatar),
        stream: true,
        extraSystem,
        purpose,
        sampling: samplingOptions(),
        stickers: stickerStamps,
      });
      // P2-2：发送前把「输入 + 输出上限」与上下文对一次。超了就直接说该改什么，
      // 而不是等接口回一个 400、再让用户猜是哪里超了。
      const budget = window.TASK22_CORE.checkContextBudget(Object.assign({
        inputTokens: window.RoleWorldPricing.tokensFromMessages(payload.messages),
      }, contextBudgetOptions()));
      if (!budget.ok) {
        const overflow = new Error(budget.message);
        overflow.code = "CONTEXT_OVERFLOW";
        overflow.budget = budget;
        throw overflow;
      }
      // 记下这次到底发了什么，供「本次请求」查看（只读，不参与发送流程；
      // 统计失败也只是少一个入口，绝不影响这轮对话）。
      liveState.lastPayload = payload;
      liveState.lastRequest = null;
      try {
        liveState.lastRequest = window.TASK22_CORE.describeRequest({
          card,
          memoryBooks,
          history: historyPlan.kept,
          userText: text,
          autoMemory: liveState.autoMemory !== false,
          autoEventMemory: liveState.eventMemory !== false,
          language: languageForAvatar(entry.avatar),
          messages: payload.messages,
          extraSystem,
          purpose,
          // 表情指令也是系统提示里的一块：漏传的话面板重建出来的提示词会短一段，
          // 「逐字节一致」的自检会当场变红（local-app-check 就是这么抓到的）。
          stickers: stickerStamps,
        });
        // 被预算丢掉的那部分单独记下来，面板里明确显示（绝不静默丢弃）。
        liveState.lastRequest.requested = requestedResults;
        liveState.lastRequest.search = searchResult
          ? { matched: searchResult.matched, scanned: searchResult.scanned, keywords: searchResult.keywords }
          : null;
        liveState.lastRequest.dropped = {
          count: historyPlan.dropped,
          tokens: historyPlan.droppedTokens,
          keptAll: historyPlan.dropped === 0,
          unlimited: historyPlan.unlimited === true,
          budget: historyPlan.budget,
        };
      } catch (_) { /* 统计失败不影响对话 */ }
      setRequestPeekVisible();
      // 2026-09-14（修"语音前闪一下文字"）：**流式开始之前**就把"这一轮到底怎么交付"定下来。
      //
      // 为什么不能等解析完再说：语音标记在回复**末尾**（`[[语音]]`），
      // 流式中间根本不可能知道这一条最后是文字还是语音 —— 于是原来的写法先按文字画，
      // 解析完发现是语音，再把那段文字抹掉换成气泡。用户看到的就是
      // 「文字出现 → 消失 → 语音出现」。
      //
      // 现在的口径（低改动版，不新增任何模型请求）：
      //   软件聊天模式（伴侣 + 无动作档）下，本轮回复**先缓冲**，解析完按条交付；
      //   普通文字聊天**保留流式**（那条路上不存在"类型会变"的问题）。
      // 缓冲期间屏幕上只有一个稳定的"正在输入"状态。
      const buffering = isPlainChatActive();
      liveState.suppressStream = buffering;
      liveState.voiceIntent = buffering && voiceEligibilityFor(entry).allowed === true;
      streamRow = appendLiveStreamRow(entry.charName || liveState.charName, { typingOnly: buffering });
      let streamed = "";
      let aborted = false;
      let content = "";
      try {
        content = await generateChatStream(payload, controller.signal, (partial) => {
          if (!firstTokenMs && partial) firstTokenMs = Date.now() - turnStartedAt;
          streamed = partial;
          updateLiveStreamRow(streamRow, partial);
        });
      } catch (streamError) {
        if (streamError && streamError.name === "AbortError") aborted = true;
        else throw streamError;
      }
      const rawText = String(content || streamed || "").trim();
      // 自动记忆：模型用 [[记住: …]] 写的要点要剥出来，正文里不能留标记。
      let finalText = window.TASK22_CORE.stripPartialMemoryMarkers(rawText).trim();
      let memories = [];
      // topics 是 [{topic, content}]，memories 是纯文本（兼容旧调用方）。
      let memoryTopics = [];
      if (liveState.autoMemory !== false) {
        const parsed = window.TASK22_CORE.extractMemory(rawText);
        finalText = parsed.text || finalText;
        // 「记住发生过的事」关掉时，事件条目不写进记忆（提示词里也不会让模型写）。
        const items = (Array.isArray(parsed.topics) ? parsed.topics : []).filter((row) => liveState.eventMemory !== false || row.kind !== "event");
        memories = items.map((row) => row.content);
        memoryTopics = items;
      }
      // 语音消息标记（`[[语音]]`）：跟表情同一套路 —— **存之前就剥**，标记绝不留在气泡里。
      // 一轮回复可以有多条消息（空行分段）、其中可以有几条是语音；`replyPartsFor` 负责切，
      // 合成是存盘之后后台做的（不然回复要等好几秒才出现）。
      //
      // ⚠ 2026-09-14 起这里多了一件事：语音条的 `kind` 与 `status` **存盘那一刻就定死**
      // （`kind: "voice"` + `status: "queued"`）。它是"交付类型一旦确定就稳定"的落点 ——
      // 界面从这一刻起只会把它从"准备中"推到"可播放/失败"，**不会先画一遍文字再换掉**。
      const replyParts = replyPartsFor(finalText, entry);
      const wantVoice = replyParts.some((part) => part.kind === "voice");
      // `mes` 存的是纯文本（上下文、记忆、检索、重放都基于它）；气泡怎么分条看 extra.roleworld_parts。
      finalText = partsToText(replyParts) || finalText;
      // 表情：**不管记忆开关怎样都要剥**（标记是给系统读的，绝不能留在气泡里）。
      // 解析不出来的名字直接丢 —— 宁可没有表情，也不要一个破图。
      // 分条之后逐条剥：每条的正文各自干净，气泡与语音念的都从干净的文本上来。
      let finalStickers = [];
      if (window.RoleWorldStickers && window.RoleWorldStickers.extractStickers) {
        for (const part of replyParts) {
          const parsed = window.RoleWorldStickers.extractStickers(String(part.text || ""), stickerStamps);
          part.text = String(parsed.text || part.text || "").trim();
          for (const stamp of (parsed.stickers || [])) finalStickers.push(stamp);
        }
        const stickerParsed = window.RoleWorldStickers.extractStickers(finalText, stickerStamps);
        finalText = stickerParsed.text || finalText;
      }
      const stopped = aborted || liveState.cancelRequested || controller.signal.aborted;
      if (!finalText) {
        removeLiveStreamRow(streamRow);
        streamRow = null;
        if (stopped) throw Object.assign(new Error("generation stopped"), { name: "AbortError" });
        throw new Error("empty response");
      }
      // 整段一次性到达（代理缓冲）时用打字机展开，避免“没有流式”的观感。
      if (!stopped && liveState.streamChunks <= 1 && finalText.length > 40) {
        await typewriterLive(streamRow, finalText, controller.signal);
      }
      if (liveState.activeSession !== targetSession) {
        removeLiveStreamRow(streamRow);
        streamRow = null;
        throw Object.assign(new Error("generation stopped"), { name: "AbortError" });
      }
      removeLiveStreamRow(streamRow);
      streamRow = null;
      liveState.generationPhase = "saving";
      setLivePhase(liveState.generationPhase);
      liveState.controller = null;
      liveState.cancelRequested = false;
      // 步骤 3：绑定 + 保存。未绑定会话先固定内存绑定，保存成功才生效；失败撤销。
      if (isUnboundBlank(targetSession)) {
        liveState.chatModel.bindActive({ avatar: entry.avatar, charName: entry.charName });
        bound = true;
      }
      // P2-3：这一轮它有没有引用以前的记录（保守判定：要有一段逐字相同的原话）。
      // 跟轮次一起写进消息里，刷新之后仍然看得到出处。
      let refs = [];
      try {
        if (search) {
          const candidates = []
            .concat(searchResult && Array.isArray(searchResult.hits) ? searchResult.hits : [])
            .concat(requestedResults.reduce((all, row) => all.concat(Array.isArray(row.hits) ? row.hits : []), []));
          refs = search.findReferencedHits(finalText, candidates);
        }
      } catch (_) { refs = []; }
      // 撞上输出上限？把这件事记进消息里（刷新后仍在），并在那一轮下面给一个「接着说」。
      const truncatedByLength = liveState.lastFinishReason === "length";
      // 语言检查（不额外花请求）：角色设的是中文却写成英文时，界面上给一句可恢复的说明，
      // 并且**拦住语音**（不合语言的回复不交给错误语言的音色，见 synthesizeOneVoicePart）。
      const languageVerdict = languageVerdictFor(entry, finalText);
      const extraForMessage = Object.assign(
        {},
        refs.length ? { roleworld_refs: refs } : {},
        truncatedByLength ? { roleworld_truncated: true } : {},
        languageVerdict ? { roleworld_language: languageVerdict } : {},
        // 这一轮带的表情：跟着消息存下来，刷新/换设备后照样显示。
        finalStickers.length ? { roleworld_stickers: finalStickers.map((s) => ({ id: s.id, name: s.name, url: s.url })) } : {},
        // 这一轮它想发语音：先记个 pending，合成完再补上时长与缓存键。
        // 这一轮分了几条消息、哪几条是语音：跟消息一起存下来，刷新后照样按条显示。
        { roleworld_parts: replyParts, roleworld_chat_style: isPlainChatFor(entry, companionProfile) ? "plain" : "action" },
      );
      // 先把「这一轮发出去了」记下来：万一下面结果不确定，重发时才知道要去确认。
      markSaveAttempted(targetSession, turnId);
      try {
        if (regenIndex >= 0) {
          // 重新回答：写成这条回复的新版本（旧版本留在 swipes 里，可切回去）。
          const regen = await saveRegeneratedReply(regenIndex, finalText, turnId, extraForMessage.roleworld_chat_style);
          liveState.regenerateSaved = regen;
        } else {
          const saved = await saveLiveChat(text, finalText, undefined, {
            charName: entry.charName,
            turnId,
            extra: extraForMessage,
          });
          if (saved && saved.duplicate) duplicateTurn = true;
        }
      } catch (saveError) {
        // 写盘与回执都已经成功、只是**之后的界面同步**抛错时，这一轮并不是保存失败。
        // 用回执（这一轮的 turnId）确认一次：谎报失败会把原话塞回输入框 —— 用户再点一次
        // 发送就会多写一轮；那张"重试保存"卡片也会把人引到错误的动作上。
        const receipted = await turnCommittedToDisk(targetSession, turnId);
        if (!receipted) {
          if (bound) liveState.chatModel.unbindActive();
          // 打上标记：这条回复是**存不上**（不是"请求失败"）。桌面版偶尔会遇到
          // Windows 上重命名被占用 —— 提示要说清真实原因，而且**内容不能丢**，
          // 所以把这一轮的原话与回复一起挂到错误上，让失败提示把它们留在屏幕上。
          if (saveError && typeof saveError === "object") {
            // 这一段 catch 就是"保存失败"的处理点，所以**直接打一个标记**，
            // 让外层按"是不是保存失败"分类。只认 `code === "SAVE_FAILED"` 字符串时，
            // 像 EBUSY 这种自带错误码的写盘失败会漏到通用分支：正文从屏幕上消失、
            // 提示还说成"回复失败"（2026-09-17 注入实测）。
            saveError.roleworldSaveFailure = true;
            saveError.code = saveError.code || "SAVE_FAILED";
            saveError.turnUserText = text;
            saveError.turnReplyText = finalText;
            if (regenIndex < 0) {
              // 仅保留在这张失败卡片的闭包里；不把回复放入设置或日志。
              // 会话或内容已变时拒绝补写，避免旧快照覆盖后续对话。
              const failedMessages = targetSession.messages;
              let recovered = false;
              saveError.retrySave = async () => {
                if (recovered) return;
                if (liveState.activeSession !== targetSession || targetSession.messages !== failedMessages) {
                  throw new Error("对话已切换或更新，请先复制这条回复留底");
                }
                setLivePhase("saving");
                try {
                  if (bound) liveState.chatModel.bindActive({ avatar: entry.avatar, charName: entry.charName });
                  await saveLiveChat(text, finalText, undefined, {
                    charName: entry.charName, turnId, extra: extraForMessage,
                  });
                  recovered = true;
                  clearSaveAttempted();
                  invalidateHistoryCache();
                  refreshChatMessages();
                  if (input && input.value === originalInput) restoreInput("");
                  setChatListStatus("");
                  showToast("原回复已保存，没有重新请求模型");
                  if (wantVoice) synthesizeReplyVoices(entry, targetSession, turnId, replyParts).catch(() => {});
                } catch (retryError) {
                  if (bound && !recovered) liveState.chatModel.unbindActive();
                  throw retryError;
                } finally { setLiveBusy(false); }
              };
            } else {
              // 重新回答：补存要用**内存里那一条当前状态**。`saveRegeneratedReply` 在写盘
              // 之前就已经把新版本推进了 `swipes`，所以**不能再跑一次它** —— 那会再加一版
              // （实测会变成 3 版）。这里直接把这批消息重新写回盘上。
              let recoveredRegen = false;
              saveError.retrySave = async () => {
                if (recoveredRegen) return;
                if (liveState.activeSession !== targetSession) {
                  throw new Error("对话已切换，请先复制这条回复留底");
                }
                setLivePhase("saving");
                try {
                  try {
                    await persistMessages(targetSession.messages, "retry");
                  } catch (retryError) {
                    // 与主路径同一套判据：写盘可能已经成功、只是界面同步抛错。
                    if (!(await turnCommittedToDisk(targetSession, turnId).catch(() => false))) throw retryError;
                  }
                  recoveredRegen = true;
                  clearSaveAttempted();
                  refreshChatMessages();
                  setChatListStatus("");
                  showToast("这一版已保存，没有重新请求模型");
                } finally { setLiveBusy(false); }
              };
            }
          }
          throw saveError;
        }
        // 已经写进本机文件：按成功继续走（自动记忆 / 台账 / 语音都照常），
        // 只是把界面再同步一次；真的同步不过来就如实说"已保存、界面没刷新"。
        clearSaveAttempted();
        invalidateHistoryCache();
        try { syncActiveSession(); } catch (_) {
          setChatListStatus("这一条已经存进本机文件，但界面没刷新过来：刷新页面就能看到。", true);
          showToast("已保存；界面没刷新过来，刷新一下就能看到");
        }
      }
      saveCompleted = true;
      clearSaveAttempted();
      invalidateHistoryCache();
      const pendingVoice = hasPendingVoice(replyParts);
      // 这一轮分了**多条**时，让界面一条一条送到（真人不一次发一大段）。
      // 带语音的那几轮由合成过程推进状态时再触发（那时缓存键才齐），这里只管纯文字的多条。
      //
      // ⚠ 带语音的那几轮**必须在存盘之后立刻渲染一次**：那一条的 `status: "queued"`
      // 已经在盘上了，界面要马上显示"语音准备中"气泡 —— 用户看到的顺序应当是
      // 「正在输入… → 语音准备中… → ▶ 4″」，**中间不出现正文**。
      if (!duplicateTurn && (pendingVoice || (replyParts.length > 1 && !wantVoice))) {
        liveState.animateTurnId = turnId;
        // 落盘已经完成：这里的重画再出错也不能被当成"这一轮失败"
        // （那会给出一个会重复发送的重试卡）。
        try { refreshChatMessages(); } catch (_) { /* 界面同步失败不影响已保存的这一轮 */ }
      }
      // 语音消息：**存完盘再合成**（合成要好几秒，不能让它挡住回复出现）。
      // 合成过程会逐条把状态推成 ready / failed（`applyTurnParts` 按轮次 ID 找那条消息，
      // 不拿旧快照覆盖），气泡就从"准备中"**原位**变成"可播放"或"失败 + 重试"。
      if (wantVoice && !duplicateTurn) {
        synthesizeReplyVoices(entry, targetSession, turnId, replyParts).then((result) => {
          // 用户用开关**点名要**语音、但有条目太长（超过上限）时要把原因说出来 ——
          // 悄悄变回文字就是这个项目最忌讳的"点了没反应"。
          // （现在那条会显示成失败气泡 + 「改为文字」；这句 toast 是同一件事的第二遍提醒。）
          if (!result) return;
          if (result.failed && voiceReplyRequestedNow()) {
            showToast(result.tooLong
              ? ("有一条超过 " + ((window.RoleWorldVoice && window.RoleWorldVoice.VOICE_MESSAGE_MAX_CHARS) || 120)
                + " 字，没有做成语音 —— 我们**不会截断**它。想听语音就让角色说短一点。")
              : "有一条语音没合成出来，气泡上可以重试或者改成文字。");
          }
        }).catch(() => {
          /* 语音失败不该影响这一轮已经存好的文字 */
        });
      }
      // 模型这一轮写的 [[搜索: …]]：记下来，下一轮真正去翻。
      const searchRequests = window.TASK22_CORE.extractSearchRequests(rawText);
      if (searchRequests.length) {
        try {
          const rows = searchRequests.map((query) => ({ query, at: new Date().toISOString() }));
          await savePendingSearches(entry, rows);
        } catch (_) { /* 记不下只是少一次主动检索 */ }
      }
      // 这一轮其实早就存过了：说明上一轮保存成功、只是被当成了失败。
      // 正文照常显示，但不再记一次用量与费用。
      if (duplicateTurn) {
        showToast("这一条上次其实已经保存过了，没有重复写入，也没有再次计费");
        setChatListStatus("");
        return;
      }
      // 模型自己记下的要点写进该角色的「自动记忆」书；下一条消息就会带上。
      // 记下来源与主题；同一主题会替换旧的（用户改口时旧记忆不该继续生效）。
      let memoryResult = null;
      if (memories.length) {
        try {
          memoryResult = await rememberForCharacter(entry, memoryTopics, {
            file: targetSession.fileName,
            messageIndex: targetSession.messages.length,
            at: new Date().toISOString(),
          });
          if (memoryResult.added) {
            const bits = [];
            if (memoryResult.replaced.length) bits.push(`更新了 ${memoryResult.replaced.length} 条`);
            else bits.push(`已记住 ${memoryResult.added} 条`);
            if (memoryResult.removed.length) bits.push(`超出上限挤掉 ${memoryResult.removed.length} 条`);
            showToast(bits.join("，"));
            loadBooks().catch(() => {});
          } else if (memoryResult.rejected && memoryResult.rejected.length) {
            // 模型想把剧情写进记忆：明确告诉用户被拦下了，而不是悄悄丢掉。
            showToast(`有 ${memoryResult.rejected.length} 条内容像剧情而不是你的事实，没有写入记忆`);
          }
        } catch (_) { /* 记忆写失败不影响这轮对话 */ }
      }
      // 记一笔用量与费用（接口回了 usage 就用真值，否则按字数估算）。
      let turnUsage = null;
      try {
        turnUsage = window.RoleWorldPricing.usageOf({
          usage: liveState.lastUsage,
          messages: payload.messages,
          reply: finalText,
        });
        await recordCost(targetSession, turnUsage);
      } catch (_) { /* 估算失败不影响对话 */ }
      // 台账：延迟 / 用量 / 费用 / 这一轮的记忆与检索行为。
      // 记忆错误与编造不在这里判定 —— 那两个只能由用户手动标记。
      try {
        await recordTurnMetrics(entry, {
          turnId,
          file: targetSession.fileName,
          firstTokenMs,
          totalMs: Date.now() - turnStartedAt,
          inputTokens: turnUsage ? turnUsage.input : 0,
          outputTokens: turnUsage ? turnUsage.output : 0,
          cost: turnUsage ? window.RoleWorldPricing.costOf(turnUsage, currentPrices()) : 0,
          costExact: !!(turnUsage && turnUsage.exact),
          memoriesAdded: memoryResult ? memoryResult.added : 0,
          memoriesReplaced: memoryResult ? memoryResult.replaced.length : 0,
          memoriesRejected: memoryResult ? memoryResult.rejected.length : 0,
          searchHits: searchResult ? searchResult.matched : 0,
          activeSearches: requestedResults.length,
          // 用途与"有没有被截断"：这样"该不该限制输出长度"以后有实测数据可看。
          purpose,
          truncated: truncatedByLength,
        });
      } catch (_) { /* 台账写失败不影响对话 */ }
      // 伴侣模式：记下"这次聊过了"，下一轮的时间感才有依据。
      if (companionProfile && companionProfile.enabled === true) {
        markCompanionChat(entry).catch(() => {});
      }
      // 「连发」掐掉的这一轮**不落盘**：那两句马上会并成一条重新问，
      // 半个回复留在记录里既浪费 token、又难看（用户看到"它回了一半又开始回"）。
      if (liveState.coalesceAbort === true) {
        liveState.coalesceAbort = false;
        removeLiveStreamRow(streamRow);
        streamRow = null;
        renderLiveMessages(targetSession.messages);
        setChatListStatus("");
        throw Object.assign(new Error("coalesced into next turn"), { name: "AbortError" });
      }
      if (stopped) showToast("已停止（保留已生成的部分）");
      setChatListStatus("");
    } catch (err) {
      removeLiveStreamRow(streamRow);
      streamRow = null;
      renderLiveMessages(targetSession.messages);
      if (!saveCompleted) restoreInput(originalInput);
      if (isAuthRequired(err)) { showAuthGate(); return; }
      if (err && err.code === "CONTEXT_OVERFLOW") {
        // 明确说该改什么，并把完整说明留在对话页的状态行上（toast 放不下这么多字）。
        setChatListStatus(err.message, true);
        showToast("这一轮超过了上下文上限，先看看上面的说明");
        return;
      }
      if (err && err.code === "TURN_ALREADY_SAVED") {
        showToast("这一条上次其实已经保存过了，没有重复写入");
        return;
      }
      // 失败的那一轮**整轮都没落盘**（用户话与回复是一起写的），所以"重试"原样再发一次
      // 不会产生重复的用户消息。给一张可点的卡片，把原话留在上面（用户要求：
      // 「失败消息旁提供重试，并保留用户输入」）。
      if (!(err && err.name === "AbortError") && regenIndex < 0) renderTurnFailure(text, err);
      if (err && err.name === "AbortError") showToast("已停止");      else if (err && err.cardMessage) {
        // 体验卡的问题（次数用完 / 被停用 / 已到期）：把中转的原话显示出来，并刷新徽标。
        showToast(err.cardMessage);
        renderCardChip().catch(() => {});
      }
      else if (err && (err.roleworldSaveFailure === true || err.code === "SAVE_FAILED")) {
        // 存不上 ≠ 请求失败：内容已经生成。**别让它从屏幕上消失** ——
        // 以前这里只弹一句"回复未保存，请重试"，用户看到的是"我这句话和回复都没了"。
        const why = String((err && err.message) || "").slice(0, 120);
        try {
          // 重新回答时，用户那条话与这一版回复**本来就在内存与屏幕上**（saveRegeneratedReply
          // 在写盘前就改了内存里那条消息），再 push 一遍就会多画一条用户消息（实测 2 → 3）。
          if (regenIndex < 0 && (err.turnUserText || err.turnReplyText)) {
            const kept = (liveState.chatMessages || []).slice();
            if (err.turnUserText) kept.push({ name: liveState.userName, is_user: true, mes: err.turnUserText });
            if (err.turnReplyText) kept.push({ name: liveState.charName, is_user: false, mes: err.turnReplyText });
            renderLiveMessages(kept);
          }
        } catch (_) { /* 渲染失败也不能盖掉提示 */ }
        // 重绘保留内容之后再放恢复入口，避免卡片被 renderLiveMessages 清掉。
        if (typeof err.retrySave === "function") renderTurnFailure(text, err);
        showToast("回复没存上：" + (why || "写入失败") + (err.retrySave
          ? "（点重试保存，不会重新生成；也可先复制留底）"
          : "（内容留在屏幕上，请先复制留底）"));
        setChatListStatus("这一条没能写进本机文件：" + (why || "写入失败"), true);
      }
      else if (err && (err.status === 401 || err.status === 403)) {
        // 401/403 = "端点不认这份凭据"。光说一句 401 谁也不知道该改哪里，
        // 所以把**打到哪个主机 + 用的是哪种凭据**说出来（凭据只显示形态与末 4 位），
        // 并且去两个密钥格里看一眼：**最常见的原因就是"换了服务商，凭据还在另一个格子里"**。
        let host = "";
        try { host = new URL(String(err.endpoint || "")).host; } catch (_) { host = String(err.endpoint || "").slice(0, 40); }
        const kindText = err.authKind === "card" ? "一个体验卡号"
          : err.authKind === "empty" ? "**空凭据**（这个服务商下没存任何东西）"
            : err.authKind === "key" ? "一把 API Key" : "一份凭据";
        const tail = err.authTail ? "（末 4 位 " + err.authTail + "）" : "";
        const why = String((err && err.message) || "").slice(0, 140);
        let slots = "";
        try {
          const settings = await window.RoleWorld.getLocalSettings();
          const current = String(settings.provider || "deepseek");
          const mine = ((await window.RoleWorld.secrets.get(window.RoleWorldModel.secretKeyFor({ provider: current }))) || {}).value || "";
          const relay = String(settings.card_relay || "");
          const isCardInSlot = mine && window.RoleWorldCard && window.RoleWorldCard.looksLikeCard(mine);
          const relayHost = relay ? (() => { try { return new URL(relay).host; } catch (_) { return ""; } })() : "";
          if (isCardInSlot && current !== "custom") {
            // 最常见的一种："我以为把卡填进 API Key 就是登录了" —— 其实那一格是**服务商的 Key**，
            // 卡号被当成 DeepSeek 的 Key 发出去，必然 401。
            slots = "这看起来是**体验卡号填错了格子**：卡号被当成 " + (host || "服务商") + " 的 API Key 发出去了。"
              + "体验卡必须走中转 —— 到「设置 → 模型 → **体验卡**」那一行，粘发卡人给你的**那一整行**"
              + "（`卡号@中转地址`）再点「使用体验卡」"
              + (relay ? "；你上次用的中转是 " + relayHost + "，可以直接用它。" : "；那一行里的中转地址就是发卡人搭的那个地址。")
              + "\n";
          } else if (!mine) {
            // 当前这一格是空的：看看别的格子有没有东西（这才是"配了却 401"的真相）。
            const others = [];
            for (const provider of ["deepseek", "custom"]) {
              if (provider === current) continue;
              const value = ((await window.RoleWorld.secrets.get(window.RoleWorldModel.secretKeyFor({ provider }))) || {}).value || "";
              if (value) {
                const isCard = window.RoleWorldCard && window.RoleWorldCard.looksLikeCard(value);
                others.push((provider === "custom" ? "自定义云端服务（体验卡走这里）" : "DeepSeek 官方") + "那一格里存着" + (isCard ? "一张体验卡" : "一把 API Key"));
              }
            }
            slots = others.length
              ? "注意：当前服务商是「" + (current === "custom" ? "自定义云端服务" : "DeepSeek 官方") + "」，但这一格是空的；"
                + others.join("；") + " —— 把服务商切回去，或把凭据填到当前这一格（「设置 → 模型」）。\n"
              : "两个密钥格都是空的：先去「设置 → 模型」粘一把 API Key，或用发卡人给你的那一整行体验卡。\n";
          }
        } catch (_) { /* 查不到就不说这一段 */ }
        showToast("端点不认这份凭据（401）：" + (host || "模型接口"));
        setChatListStatus(
          `这一轮被 ${host || "模型端点"} 拒绝了（HTTP ${err.status}）：它收到的是${kindText}${tail}。`
          + (slots ? slots : "")
          + "常见原因：① 用的是体验卡 —— 到「设置 → 模型 → 体验卡」重新粘一次发卡人给你的**那一整行**（卡号@中转地址）；"
          + "② 用自己的 API Key —— 检查「设置 → 模型」里的**服务商**和 Key 是否配套；"
          + "③ Key 被停用 / 欠费 / 复制时少了字符。\n\n端点原话：" + why, true);
      }
      else if (window.TASK22_CORE.isDeepSeekChatMode(liveState.modelMode) && err && err.status === 400) showToast("尚未保存 DeepSeek API Key：请到「设置 → 对话」粘贴并保存");
      else {
        // 其它失败也别再吞原因了：说出来才查得动。
        const why = String((err && (err.message || err.statusText)) || "").slice(0, 120);
        showToast(why ? "回复失败：" + why : "回复未保存，请重试");
      }
    } finally {
      removeLiveStreamRow(streamRow);
      liveState.controller = null;
      liveState.cancelRequested = false;
      liveState.pendingText = "";
      // 这一次发送彻底结束：本轮标识作废。
      // 只有"失败后原样重发"（不会走到这里的 finally）才该沿用同一个标识。
      liveState.pendingTurnId = "";
      // 重新回答这一轮结束了：标记清空，并把"现在是第几版"告诉用户。
      if (regenIndex >= 0) {
        const regen = liveState.regenerateSaved;
        liveState.regenerateSaved = null;
        liveState.regenerateIndex = null;
        if (regen && regen.versions > 1 && !liveState.cancelRequested) {
          showToast(`已重新回答（第 ${regen.versions} 版，旧版本还在，可以用消息下面的 ‹ › 切回去）`);
        }
      }
      setLiveBusy(false);
      updateComposerLive();
    }
  }

  /* ---------- 对话模型（统一由「设置 → 模型」决定，2026-09-10） ----------
   * 以前这里另有一套"对话模型"下拉（固定型号列表），
   * 和「设置 → 模型」里的服务商 + 模型名互相覆盖：在下拉里选一个就会把你在模型页
   * 填的模型名顶掉，Key 也在两个地方各有一个输入框。
   * 现在只认一份配置：provider 决定走哪条通道，model 决定模型名，thinking 决定是否要思维链。
   */
  function modelLabel() {
    const core = window.TASK22_CORE;
    const name = String(liveState.modelName || "").trim();
    const channel = core.isDeepSeekChatMode(liveState.modelMode) ? "DeepSeek" : "自定义";
    return name ? `${name} · ${channel}` : "未配置（设置 → 模型）";
  }

  // 顶栏下拉里能选的模型：当前服务商的已知型号 + 正在用的那个（可能是用户手填的）。
  function modelChoices() {
    const list = [];
    const push = (value) => { if (value && list.indexOf(value) < 0) list.push(value); };
    push(liveState.modelName);
    let settings = null;
    try {
      settings = liveState.localSettings || null;
    } catch (_) { settings = null; }
    const preset = settings && window.RoleWorldModel.PRESETS[settings.provider];
    (preset && preset.models ? preset.models : []).forEach(push);
    return list;
  }

  function renderChatModelOptions() {
    const select = document.querySelector("#chatModelSelect");
    if (!select) return;
    const choices = modelChoices();
    const pricing = window.RoleWorldPricing;
    const settings = liveState.localSettings || {};
    const current = String(liveState.modelName || "");
    select.textContent = "";
    if (!choices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未配置（设置 → 模型）";
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    choices.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      const price = pricing
        ? pricing.pricesFor(name, { input: settings.price_input, output: settings.price_output }, new Date())
        : null;
      const official = settings.provider === "deepseek";
      option.textContent = official && name === "deepseek-flash" ? "DeepSeek V4.1 Flash"
        : official && name === "deepseek-v4-pro" ? (Date.now() >= Date.parse("2026-09-14T12:00:00+08:00") ? "DeepSeek V4 Pro（已转向 V4.1）" : "DeepSeek V4 Pro") : name;
      option.title = name;

      select.appendChild(option);
    });
    // 末尾留一个入口，直接跳到设置里去填任意模型名。
    const more = document.createElement("option");
    more.value = "__custom__";
    more.textContent = "自定义模型名…";
    select.appendChild(more);
    select.value = choices.indexOf(current) >= 0 ? current : choices[0];
    const label = select.selectedOptions[0]?.textContent || current;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) {
      const style = getComputedStyle(select);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      select.style.width = `${Math.ceil(context.measureText(label).width) + 52}px`;
    }
    select.title = `${label} · ${current}`;
    let detail = document.getElementById("chatModelPrice");
    if (!detail) {
      detail = document.createElement("span");
      detail.id = "chatModelPrice";
      select.parentElement.appendChild(detail);
    }
    const price = pricing && settings.provider === "deepseek"
      ? pricing.pricesFor(current, { input: settings.price_input, output: settings.price_output }, new Date()) : null;
    detail.textContent = price && price.output > 0 ? `输入 ¥${price.input} · 输出 ¥${price.output} / 百万 token` : "";
    detail.title = price ? `${price.period}估算单价；实际账单以服务商为准` : "";
  }

  async function chooseChatModel(value) {
    if (value === "__custom__") {
      if (window.TASK25C_UI) {
        if (typeof window.TASK25C_UI.setSettingsSection === "function") window.TASK25C_UI.setSettingsSection("connection");
        if (typeof window.TASK25C_UI.openSettings === "function") window.TASK25C_UI.openSettings();
      }
      renderChatModelOptions();
      return;
    }
    if (!value) return;
    liveState.modelName = value;
    syncChatModelControls();
    updateComposerLive();
    try {
      await window.RoleWorld.saveLocalSettings({ model: value });
      liveState.localSettings = await window.RoleWorld.getLocalSettings();
      syncChatModelControls();
      updateComposerLive();
      // 让「设置 → 模型」面板也跟着同步，避免两处显示不一致。
      window.dispatchEvent(new window.CustomEvent("roleworld:settings-changed", { detail: { model: value } }));
    } catch (_) { /* 存不下也不影响本次会话 */ }
  }

  async function loadChatModelSettings() {
    const core = window.TASK22_CORE;
    let settings = { provider: "deepseek", model: "", thinking: false };
    try {
      if (window.RoleWorld && typeof window.RoleWorld.getLocalSettings === "function") {
        settings = await window.RoleWorld.getLocalSettings();
      }
    } catch (_) { /* 读不到就用默认值，页面照常起来 */ }
    liveState.modelName = String(settings.model || "");
    liveState.thinking = settings.thinking === true;
    liveState.autoMemory = settings.auto_memory !== false;
    // 「记住发生过的事」：默认开 —— 用户要的是角色记得"之前发生了什么"。
    // 关掉时既不提示模型写 [[事件: …]]，也不会把事件条目写进记忆。
    liveState.eventMemory = settings.auto_event_memory !== false;
    // 角色语言：默认"跟着角色卡自己的语言"（2026-09-12 用户定），
    // 全局与单角色的开关都在 settings.language_mode / settings.language_by_card 里，见 languageForAvatar()。
    liveState.localSettings = settings;
    // provider 决定请求通道：DeepSeek 才带 include_reasoning 之类的参数。
    liveState.modelMode = settings.provider === "deepseek"
      ? core.CHAT_MODES.DEEPSEEK_FLASH
      : core.CHAT_MODES.LOCAL;
    syncChatModelControls();
  }

  function renderChatKeyStatus(text, isError) {
    // 密钥输入已经统一到「设置 → 模型」，这里保留空实现只为兼容旧调用点。
    const node = document.querySelector("#chatDeepseekKeyStatus");
    if (!node) return;
    node.textContent = typeof text === "string" ? text : "";
    node.classList.toggle("is-error", !!isError);
  }

  function syncChatModelControls() {
    renderChatModelOptions();
    const badge = document.querySelector("#chatModelBadge");
    if (badge) badge.classList.toggle("is-warning", !String(liveState.modelName || "").trim());
    const thinking = document.querySelector("#chatThinkingToggle");
    if (thinking) thinking.checked = liveState.thinking === true;
    syncChatLanguageControl();
    renderCostLine();
  }

  /* ---------- 角色语言：每个角色一个开关 ----------
   * 2026-09-12 用户定的产品行为：**默认跟着角色卡自己的语言**（英文卡说英文、中文卡说中文），
   * 「一律中文 / 一律英文」是想开才开的选项 —— 看不懂英文的人把它开成中文。
   * 两级：全局在「设置 → 模型 → 角色语言」，单个角色的覆盖在顶栏这个下拉里
   * （和「设置 → 角色管理」里那一行是同一份设置）。 */
  function languageForAvatar(avatar) {
    const core = window.TASK22_CORE;
    const settings = liveState.localSettings || {};
    if (core && typeof core.languageFromSettings === "function") return core.languageFromSettings(settings, avatar);
    return null;
  }

  /** 下拉里显示的是**这个角色自己的设置**（没设过 = 跟随全局），
   *  提示语里说清楚最终会用哪种语言，免得"跟随设置"看不出效果。 */
  function syncChatLanguageControl() {
    const select = document.querySelector("#chatLangSelect");
    if (!select) return;
    const entry = activeCharacterEntry();
    const avatar = String((entry && entry.avatar) || "");
    if (!avatar) return;
    const settings = liveState.localSettings || {};
    const own = (settings.language_by_card || {})[avatar];
    const value = own === "zh" || own === "en" ? own : "auto";
    if (select.value !== value) select.value = value;
    const effective = languageForAvatar(avatar);
    const core = window.TASK22_CORE;
    // 卡面语言优先从缓存里按 avatar 取：切角色的那一刻 liveState.card 可能还是上一个人的。
    const card = (liveState.cardCache && liveState.cardCache.get(avatar)) || liveState.card || null;
    const ownOnCard = core && typeof core.cardLanguageOf === "function" ? core.cardLanguageOf(card) : null;
    const what = effective === "zh" ? "一律用简体中文回复"
      : effective === "en" ? "一律用英文回复"
        : (ownOnCard === "zh" ? "按角色卡自己的语言：中文" : ownOnCard === "en" ? "按角色卡自己的语言：英文" : "角色卡没写语言，跟着你说");
    const name = (entry && (entry.charName || entry.avatar)) || "";
    select.title = `当前角色「${name}」：${what}。这里改只影响这个角色；全局默认在「设置 → 模型 → 角色语言」。`;
  }

  async function chooseChatLanguage(value) {
    const entry = activeCharacterEntry();
    const avatar = String((entry && entry.avatar) || "");
    if (!avatar) return;
    const current = (liveState.localSettings && liveState.localSettings.language_by_card) || {};
    const next = Object.assign({}, current);
    // 选「跟随设置」就把这一项删掉（存成 "auto" 也算对，但留着空记录只会让数据变脏）。
    if (value === "zh" || value === "en") next[avatar] = value;
    else delete next[avatar];
    // 先让本轮就按新值走（不等落盘），再写设置。
    liveState.localSettings = Object.assign({}, liveState.localSettings || {}, { language_by_card: next });
    syncChatLanguageControl();
    try {
      await window.RoleWorld.saveLocalSettings({ language_by_card: next });
      window.dispatchEvent(new window.CustomEvent("roleworld:settings-changed", { detail: { language_by_card: next } }));
    } catch (_) { /* 存不下也不影响本次会话 */ }
  }

  function bindChatLanguageControl() {
    const select = document.querySelector("#chatLangSelect");
    if (!select) return;
    select.addEventListener("change", (event) => { chooseChatLanguage(event.target.value).catch(() => {}); });
    syncChatLanguageControl();
  }

  // 密钥与思考模式都在「设置 → 模型」里配置了，这里只保留跳转；模型可以直接在顶栏切换。
  function bindChatModelControls() {
    document.querySelector("#chatModelSelect")?.addEventListener("change", (event) => chooseChatModel(event.target.value));
    document.querySelectorAll('[data-action="open-model-settings"]').forEach((node) => {
      node.addEventListener("click", (event) => {
        event.preventDefault();
        if (!window.TASK25C_UI) return;
        if (typeof window.TASK25C_UI.setSettingsSection === "function") window.TASK25C_UI.setSettingsSection("connection");
        if (typeof window.TASK25C_UI.openSettings === "function") window.TASK25C_UI.openSettings();
      });
    });
  }

  /* ---------- 体验卡徽标：剩几次要在界面上一眼看见 ----------
   * 数据来源有两处：① 启动时查一次 /card/quota；② 每一轮回复的响应头
   * x-rw-card-calls-left（中转每轮都回，见 relay/server.js）。 */

  async function renderCardChip() {
    const chip = document.querySelector("#cardChip");
    const card = window.RoleWorldCard;
    if (!chip || !card) return null;
    let state = null;
    try { state = await card.currentState(); } catch (_) { state = null; }
    if (!state || !state.active) {
      chip.hidden = true;
      chip.textContent = "体验卡";
      return null;
    }
    let info = state.quota;
    if (!info && state.relay) {
      try { info = await card.quota(state.relay, state.token); } catch (_) { info = null; }
    }
    chip.hidden = false;
    chip.textContent = card.chipText(state, info);
    chip.dataset.level = card.chipLevel(state, info);
    chip.title = "你正在用体验卡。" + (info && info.ok ? card.formatQuota(info) : "点一下去设置里查额度 / 换一张卡")
      + "　（点这里打开设置里的「体验卡」那一栏）";
    return info;
  }

  function bindCardChip() {
    const chip = document.querySelector("#cardChip");
    if (chip) {
      chip.addEventListener("click", () => {
        const settingsButton = document.querySelector('[data-action="open-settings"]');
        if (settingsButton) settingsButton.click();
        window.setTimeout(() => {
          const row = document.querySelector('[data-roleworld="card"]');
          if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
          if (window.RoleWorldSettingsUI && typeof window.RoleWorldSettingsUI.checkCardQuota === "function") {
            window.RoleWorldSettingsUI.checkCardQuota().catch(() => {});
          }
        }, 120);
      });
    }
    window.addEventListener("roleworld:card-changed", () => { renderCardChip().catch(() => {}); });
    window.addEventListener("roleworld:settings-changed", () => { renderCardChip().catch(() => {}); });
  }

  async function bootLive() {
    await window.STApi.init();
    await updateAdminEntry();
    live = true;
    window.TASK21_LIVE = true;
    await ensureChatTemplate();
    liveState.settings = parseSettings(await window.STApi.getSettings());
    await loadCharacterAndChat();
    updateComposerLive();
    await loadBooks();
    bindChatModelControls();
    bindChatLanguageControl();
    await loadChatModelSettings();
    liveState.templateError = false;
    setChatTemplateGate("ready");
    updateComposerLive();
    // Task-27H：启动落定即摘除 theme-pending。此前遮罩只在 setUserContext 成功时摘除，
    // 身份链路瞬时失败会出现"已准备好"弹出但页面灰屏；主题数据已由首帧内联脚本应用，
    // 此处摘除不会引入主题闪烁。
    document.documentElement.classList.remove("theme-pending");
    bindCardChip();
    renderCardChip().catch(() => {});
    // 语音：先把"这个角色能不能出声"这件事问清楚，再让界面去画。
    // ⚠ 顺序要紧：菜单是**同步**判定的，而伴侣档案是异步读的 ——
    //   所以切角色时先把档案读进同步缓存，否则会误判成"没开伴侣、所以没语音"。
    //   读完（见下面那段）再补画顶栏「当前方式」与语音入口：缓存没热之前那两处都画不准。
    // 为什么放在这里：菜单项是"点开那一瞬间现算"的，它读的是同步快照；
    // 快照没准备好时菜单里就没有「朗读」——所以启动时就要跑一次。
    initVoice().catch(() => { /* 语音探测失败不该影响聊天 */ });
    // 切角色/进对话时把伴侣档案热进同步缓存（语音门槛、顶栏「当前方式」都要同步读它）。
    // 读完之后补画一次：这份缓存没热之前，那两处都画不准。
    primeCompanionCache(activeCharacterEntry()).then(() => {
      renderTopbarMode();
      updateReplyVoiceToggle();
    }).catch(() => {});
    showToast("已准备好。");
    // 一次性提示：内置包以前带着"别人的存档"（原 SillyTavern 存档里的玩家角色 Lin），
    // 启动时已被 adapter/pack-cleanup.js 清掉。这里读一次、报一次、把这个键清空。
    // 放在"已准备好"**之后**：toast 是同一个元素，先说的会被后说的盖掉。
    try {
      const store = window.RoleWorld && window.RoleWorld.store;
      const notice = store ? await store.getKV("packs:sample-cleanup-notice", null) : null;
      if (notice && Number(notice.removed) > 0) {
        await store.setKV("packs:sample-cleanup-notice", null);
        showToast(`已清掉内置包自带的示例记忆 ${notice.removed} 条（那是原存档里的玩家角色，不是你）`);
      }
    } catch (_) { /* 提示失败不影响启动 */ }
    // 启动完成的唯一可靠信号：theme-pending 在第 2 步（身份落定）就会摘掉，
    // 不能拿它当"准备好了"，自动化测试与扩展都靠这个标志。
    window.TASK21_READY = true;
    // 返回手势（2026-09-18）：TASK21 挂上之后再接线 —— 面板的开关动作全在它上面。
    // 挂在 READY 之前的话，第一次返回会因为"找不到 TASK21"而被当成"已经到底"。
    try {
      if (window.RoleWorldBack && typeof window.RoleWorldBack.init === "function") window.RoleWorldBack.init();
    } catch (_) { /* 返回手势接不上不影响应用本身 */ }
  }

  function normalizedName(value) {
    return String(value || "").trim().toLocaleLowerCase();
  }

  /**
   * 语音启动流程。三步，顺序有讲究：
   *   ① 把设置同步给能力快照（菜单要在点击瞬间同步读到"能不能朗读"）；
   *   ② 迁移旧设置（旧版的语速/音高是本机系统 TTS 的参数，不是云端音色参数）；
   *   ③ **有卡就问一次中转**有哪些音色。
   *
   * ⚠ 第 ③ 步原来写成"只在已经打开角色语音时才问" —— 那是个**死锁**：
   *   「角色语音」那个开关本身要等这次询问的结果才显示（要知道中转有没有语音），
   *   于是开关永远不出现，功能等于不存在（用户 2026-09-14 实测反馈"角色语音根本没有"）。
   *   教训：**"为了省一个请求"而把一个功能变成不可达，是最亏的优化**。
   *   现在只要有卡就问一次 —— 这只是个 GET /voice/info，不花钱、几百毫秒。
   *   没卡就不用问：语音只走体验卡。
   */
  async function initVoice() {
    const Cloud = window.RoleWorldVoiceCloud;
    if (!Cloud) return { ok: false, reason: "语音模块没加载。" };
    let settings = {};
    try { settings = await window.RoleWorld.getLocalSettings(); } catch (_) { settings = {}; }
    Cloud.noteSettings(settings);
    try {
      const migrated = await Cloud.ensureMigrated();
      if (migrated.changed) {
        showToast("旧版的语速已按同样语义换算成云端语速；音高是旧引擎的参数，云端没有对应项，已保留在存档里不再使用。");
        settings = await window.RoleWorld.getLocalSettings();
        Cloud.noteSettings(settings);
      }
    } catch (_) { /* 迁移失败不该挡住语音 */ }
    // 有卡就问（不管开关开没开）：开关要能出现，就得先知道中转配没配语音。
    await Cloud.ensureFresh();
    renderVoiceStatus();
    return Cloud.capability();
  }

  window.__rwInvokeVoiceInit = () => initVoice();

  /**
   * 用户可能在应用开着的时候才粘上体验卡（或者换了一张）。
   * 那时要重新问一次中转 —— 否则「角色语音」那个开关会一直不出现，
   * 用户看到的就是"这个功能根本没有"（2026-09-14 实测踩过）。
   * 用 ensureFresh 而不是 refresh：card-changed 每一轮聊天都会发，不能每轮都白跑一个请求。
   */
  function bindVoiceCardRefresh() {
    const again = () => {
      const Cloud = window.RoleWorldVoiceCloud;
      if (!Cloud || typeof Cloud.ensureFresh !== "function") return;
      Cloud.ensureFresh().catch(() => { /* 探测失败不该影响聊天 */ });
    };
    window.addEventListener("roleworld:card-changed", again);
    window.addEventListener("roleworld:settings-changed", again);
  }

  function cloneWorldData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid memory snapshot");
    const cloned = JSON.parse(JSON.stringify(value));
    if (!cloned.entries || typeof cloned.entries !== "object" || Array.isArray(cloned.entries)) throw new Error("invalid memory snapshot");
    return cloned;
  }

  async function captureWorldSnapshot(name, options = {}) {
    if (options.knownAbsent === true) return { name, exists: false, data: null };
    const data = await window.STApi.getWorld(name);
    return { name, exists: true, data: cloneWorldData(data) };
  }

  function activeWorldEntries(snapshot) {
    const source = snapshot && snapshot.data && snapshot.data.entries;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid memory snapshot");
    return Object.keys(source).map((worldKey) => {
      const entry = source[worldKey];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid memory entry");
      return Object.assign({}, entry, { uid: entry.uid ?? worldKey, __worldKey: worldKey });
    }).filter((raw) => !raw.disable);
  }

  function worldEntriesObject(entries) {
    const result = {};
    for (const raw of entries) {
      const copy = Object.assign({}, raw);
      const key = String(copy.__worldKey ?? copy.uid);
      delete copy.__worldKey;
      result[key] = copy;
    }
    return result;
  }

  function nextWorldUid(entries) {
    const numeric = entries.every((raw) => /^\d+$/.test(String(raw.uid)));
    if (numeric) return entries.reduce((max, raw) => Math.max(max, Number(raw.uid)), -1) + 1;
    return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function compensateWorldMutation(name, snapshot, created) {
    if (snapshot && snapshot.exists) {
      await window.STApi.editWorld(name, cloneWorldData(snapshot.data));
      const verified = cloneWorldData(await window.STApi.getWorld(name));
      if (JSON.stringify(verified) !== JSON.stringify(snapshot.data)) throw new Error("memory rollback verification failed");
    } else if (created) {
      await window.STApi.deleteWorld(name);
      const worlds = await window.STApi.listWorlds();
      if ((Array.isArray(worlds) ? worlds : []).some((world) => normalizedName(world.name) === normalizedName(name))) {
        throw new Error("memory creation rollback verification failed");
      }
    }
    try { await loadBooks(); } catch (_) {
      // The original UI remains intact when the compensating refresh also fails.
    }
    return true;
  }

  async function commitWorldMutation({ name, snapshot, data, remove = false, created = false }) {
    let writeAttempted = false;
    try {
      writeAttempted = true;
      if (remove) await window.STApi.deleteWorld(name);
      else await window.STApi.editWorld(name, data);
      await loadBooks();
      return true;
    } catch (error) {
      if (writeAttempted) {
        try {
          await compensateWorldMutation(name, snapshot, created);
        } catch (rollbackError) {
          const failure = new Error("memory rollback could not be verified");
          failure.code = "MEMORY_ROLLBACK_FAILED";
          failure.status = (rollbackError && rollbackError.status) || (error && error.status);
          throw failure;
        }
      }
      throw error;
    }
  }

  function showMemoryMutationFailure(error, regularMessage) {
    if (error && error.code === "MEMORY_ROLLBACK_FAILED") {
      showToast("操作失败且未能确认回滚，请刷新记忆后再操作");
      return true;
    }
    showToast(regularMessage);
    return false;
  }

  async function saveCorrectionLive() {
    if (!live) { showToast("暂时无法保存，请重试"); return; }
    const active = state.activeMemory;
    if (!active) { showToast("请先选择一条记忆"); return; }
    const book = active.book;
    const entry = active.entry;
    const title = $("#modalTitle").value.trim();
    const newText = $("#modalCurrent").value.trim();
    if (!title) { showToast("标题不能为空。"); $("#modalTitle")?.focus(); return; }
    if (!newText) { showToast("请先写下记忆内容"); return; }
    try {
      const completed = await withMemoryMutation("保存中…", async () => {
        const snapshot = await captureWorldSnapshot(book.__name);
        const raws = activeWorldEntries(snapshot);
        const oldRaw = entry && raws.find((raw) => String(raw.uid) === String(entry.__uid));
        if (entry && !oldRaw) {
          const error = new Error("memory changed");
          error.code = "MEMORY_CHANGED";
          throw error;
        }
        const currentTitle = oldRaw && String(oldRaw.comment || (oldRaw.key || []).join("、") || entry.title || "").trim();
        if (oldRaw && newText === String(oldRaw.content || "").trim() && title === currentTitle) {
          const error = new Error("memory unchanged");
          error.code = "MEMORY_UNCHANGED";
          throw error;
        }
        if (oldRaw) {
          oldRaw.key = [title];
          oldRaw.comment = title;
          oldRaw.content = newText;
          oldRaw.disable = false;
        } else {
          const uid = nextWorldUid(raws);
          const maxIndex = raws.reduce((max, raw) => Math.max(max, Number(raw.displayIndex ?? -1)), -1);
          raws.push({ uid, displayIndex: maxIndex + 1, key: [title], comment: title, content: newText, disable: false });
        }
        const data = Object.assign({}, snapshot.data, { entries: worldEntriesObject(raws) });
        return commitWorldMutation({ name: book.__name, snapshot, data });
      });
      if (completed) {
        closeModal({ force: true });
        showToast("记忆已保存");
      }
    } catch (err) {
      if (err && err.code === "MEMORY_CHANGED") { showToast("这条记忆已变化，请刷新后重试"); return; }
      if (err && err.code === "MEMORY_UNCHANGED") { showToast("内容没有变化"); return; }
      if (isAuthRequired(err)) { showAuthGate(); return; }
      showMemoryMutationFailure(err, "记忆保存失败，原内容已保留，请重试");
    }
  }

  async function createMemoryBookLive(label) {
    if (!live) { showToast("暂时无法新增，请重试"); return; }
    const trimmed = String(label || "").trim();
    if (!trimmed) { showToast("记忆书名称不能为空"); return; }
    // 新建的记忆书归当前角色：MB <角色短名> — <书名>
    const name = window.TASK29_CHARACTER_CORE.newMemoryBookName(activeCharacterEntry(), trimmed);
    if (memoryBooks.some((book) => normalizedName(book.__name || book.name) === normalizedName(name))) {
      showToast("记忆书名称已存在");
      return;
    }
    try {
      const completed = await withMemoryMutation("新增中…", async () => {
        const worlds = await window.STApi.listWorlds();
        const duplicate = (Array.isArray(worlds) ? worlds : []).some((world) => normalizedName(world.name) === normalizedName(name));
        if (duplicate) {
          const error = new Error("duplicate memory book");
          error.code = "MEMORY_DUPLICATE";
          throw error;
        }
        const snapshot = await captureWorldSnapshot(name, { knownAbsent: true });
        return commitWorldMutation({ name, snapshot, data: { entries: {} }, created: true });
      });
      if (completed) showToast("记忆书已新增");
    } catch (err) {
      if (err && err.code === "MEMORY_DUPLICATE") { showToast("记忆书名称已存在"); return; }
      if (isAuthRequired(err)) { showAuthGate(); return; }
      showMemoryMutationFailure(err, "记忆书新增失败，原列表已保留，请重试");
    }
  }

  async function deleteMemoryBookLive(bookId) {
    if (!live) { showToast("暂时无法删除，请重试"); return; }
    const book = memoryBooks.find((item) => item.id === bookId);
    if (!book || !book.__name) return;
    try {
      const completed = await withMemoryMutation("删除中…", async () => {
        const snapshot = await captureWorldSnapshot(book.__name);
        return commitWorldMutation({ name: book.__name, snapshot, remove: true });
      });
      if (completed) {
        if (state.activeMemory?.book === book) closeModal({ force: true });
        showToast("记忆书已删除");
      }
    } catch (err) {
      if (isAuthRequired(err)) { showAuthGate(); return; }
      showMemoryMutationFailure(err, "记忆书删除失败，原列表已保留，请重试");
    }
  }

  async function deleteMemoryLive() {
    const active = state.activeMemory;
    if (!live || !active?.entry) return;
    const book = active.book;
    const targetUid = active.entry.__uid;
    try {
      const completed = await withMemoryMutation("删除中…", async () => {
        const snapshot = await captureWorldSnapshot(book.__name);
        const sourceRaws = activeWorldEntries(snapshot);
        if (!sourceRaws.some((raw) => String(raw.uid) === String(targetUid))) {
          const error = new Error("memory changed");
          error.code = "MEMORY_CHANGED";
          throw error;
        }
        const raws = sourceRaws.filter((raw) => String(raw.uid) !== String(targetUid));
        const data = Object.assign({}, snapshot.data, { entries: worldEntriesObject(raws) });
        return commitWorldMutation({ name: book.__name, snapshot, data });
      });
      if (completed) {
        closeModal({ force: true });
        showToast("记忆条目已删除");
      }
    } catch (err) {
      if (err && err.code === "MEMORY_CHANGED") { showToast("这条记忆已变化，请刷新后重试"); return; }
      if (isAuthRequired(err)) { showAuthGate(); return; }
      showMemoryMutationFailure(err, "记忆删除失败，原内容已保留，请重试");
    }
  }

  window.TASK21 = {
    renderChatList,
    saveCorrectionLive,
    createMemoryBookLive,
    deleteMemoryBookLive,
    deleteMemoryLive,
    openRequestPeek,
    closeRequestPeek,
    openMemoryPanel,
    closeMemoryPanel,
    // 统一角色面板（设定 / 记忆 / 关系）：三个分页一个入口。
    openCharacterPanel,
    closeCharacterPanel,
    showCharacterTab,
    // 消息旁的操作（本轮第 ③ 项）：复制在界面上直接做，这几个是编辑 / 重答 / 分支 / 版本。
    regenerateReply,
    branchFromMessage,
    editMessageText,
    switchMessageVersion,
    // 伴侣模式：关系档案（用户亲手写的那一份）。
    openCompanionDialog,
    // 主动开口为什么没发生（诊断用；测试与"设置 → 关于"都能看）。
    proactiveState: () => ({ reason: liveState.proactiveReason || null, tried: Array.from(liveState.proactiveTried || []) }),
    closeCompanionDialog,
    // 返回手势要用：语音开启面板是**动态插进 body** 的浮层（不在 index.html 里），
    // 所以 back-nav 找不到它的关闭按钮，只能走这个出口。
    closeVoiceSetup,
    loadCompanion,
    saveCompanion,
    // 自检出口：给某个角色存音色（面板里点一下走的就是这个函数，不是替身）。
    saveVoiceOverride,
    companionBlockFor,
    clearAllMemories,
    clearMemoryGroup,
    jumpToMemorySource,
    // 诊断用：当前打开的对话文件名、会话表（含归档）、手动刷新会话表。
    activeChatFileName: () => (liveState.activeSession && liveState.activeSession.fileName) || "",
    // 诊断用：当前这段对话存下来的消息（**只读快照**）。
    // 用例要拿它跟"真正发出去的请求体"对照 —— 例如 2026-09-18 的
    // 「消息时间进提示词」：时间只许加在发出去的那一份上，存档里的 mes 一个字都不许动。
    activeSessionMessages: () => ((liveState.activeSession && liveState.activeSession.messages) || [])
      .map((m) => ({ is_user: m && m.is_user === true, mes: String((m && m.mes) || ""), send_date: String((m && m.send_date) || "") })),
    // 诊断用：聊天这一轮**真正**会用的连接（不含任何密钥，只有形态与来源）。
    // 可以传一份 settings 覆盖（用例要模拟"这台设备的连接变了"），不传就用当前生效的那份。
    chatConnection: (override) => {
      const settings = (override && override.settings) || liveState.settings || {};
      const oai = settings.oai_settings || {};
      return {
        provider: String(settings.provider || ""),
        endpoint: String(settings.endpoint || ""),
        customUrl: String(oai.custom_url || ""),
        effective: effectiveChatEndpoint(override),
        mode: String((override && override.modelMode) || liveState.modelMode || ""),
      };
    },
    sessionFiles: () => (liveState.chatModel ? liveState.chatModel.getSessions().map((s) => s.fileName) : []),
    // 会话表的 id / 文件名 / 标题：切换对话要用 id（文件名不带 .jsonl、也不是 id）。
    sessionList: () => (liveState.chatModel
      ? liveState.chatModel.getSessions().map((s) => ({
        id: s.id, fileName: s.fileName, title: s.title || "", archived: s.archived === true,
        saved: s.serverSaved === true,
      }))
      : []),
    refreshSessions: () => (liveState.chatModel ? liveState.chatModel.refresh() : Promise.resolve()),
    flagTurnFromMessage,
    addMemoryEntry,
    // P5-3：记忆取向（按角色）与「这条说得对」。
    loadOrientation,
    saveOrientation,
    confirmMemoryEntry,
    isLiveBusy: () => liveState.pending,
    sendLive,
    sendWhileBusy,
    stopLive,
    onEngineChange,
    updateComposerLive,
    // 输入条那一块（2026-09-18 微信式改版）：返回手势要用"开着没 / 关掉"这两个出口，
    // 高度与发送键的显隐也在这里留一个自查口（用例直接调同一个函数，不另写一套判据）。
    autoGrowComposer,
    updateComposerAffordances,
    isComposerMenuOpen,
    closeComposerMenus,
    isCharacterPickerOpen,
    closeStickerPicker,
    // 诊所用：把"设置变了"这件事跑完整（重读本机设置 + 同步到 liveState），并返回可等待的 Promise。
    // 为什么需要它：设置写盘之后 `liveState.settings` 还是**启动时的那份快照**，而守卫与
    // `chatConnection()` 都按 `liveState.settings` 判——不刷新的话，"改了设置马上发"这条真实
    // 路径在测试里永远看不到新值（前一版 401 守卫就是死在这里、被回滚的）。
    reloadSettings: () => {
      if (liveState.settingsReload) return liveState.settingsReload;
      liveState.settingsReload = loadChatModelSettings()
        .then(async () => {
          try {
            // ⚠ 只把 `getSettings()` 的结果盖上去是不够的：那个对象里的 `oai_settings` 是
            //   `STApi.getSettings()` 从本机设置现算的，而 `liveState.settings` 里还可能有
            //   **启动时由页面固定装置/引导塞进来的** 东西。整份替换会让"这台设备其实配着地址"
            //   看起来像"什么都没配" —— 守卫据此就会把正常发送判成注定 401。
            //   所以这里**合并**：本机设置是底，新读到的快照盖上去。
            const fresh = parseSettings(await window.STApi.getSettings());
            const local = liveState.localSettings || {};
            liveState.settings = Object.assign({}, local, fresh, {
              oai_settings: Object.assign({}, fresh.oai_settings || {}, local.oai_settings || {}),
              endpoint: String(fresh.endpoint || local.endpoint || ""),
            });
          } catch (_) { /* 读不到就保持原样，界面照常 */ }
          syncChatModelControls();
          updateComposerLive();
        })
        .finally(() => { liveState.settingsReload = null; });
      return liveState.settingsReload;
    },
    // 诊所用：直接画出那张「注定 401，所以没发出去」的卡（用例要量卡片本身与它的按钮）。
    // 判据仍然只有 `chatPreflight()` 一处 —— 这里只是把它的结论渲染出来，不另判一次。
    __showPreflightForTest: (blocked, userText) => {
      if (!blocked || !blocked.kind) return null;
      renderChatPreflight(blocked, String(userText || "（测试用的一句话）"));
      return true;
    },

    // 诊所用：直接改 `liveState.settings` 这一份快照（用例要模拟"这台设备的连接变了"）。
    // 只在没有真设置页可点的自动化环境里用；正常路径一律走 `reloadSettings()`。
    __setSettingsForTest: (patch) => {
      if (!patch || typeof patch !== "object") return liveState.settings || {};
      const current = liveState.settings || {};
      const next = Object.assign({}, current, patch);
      if (patch.oai_settings) next.oai_settings = Object.assign({}, current.oai_settings || {}, patch.oai_settings);
      liveState.settings = next;
      if (patch.provider) {
        liveState.modelMode = patch.provider === "deepseek"
          ? window.TASK22_CORE.CHAT_MODES.DEEPSEEK_FLASH
          : window.TASK22_CORE.CHAT_MODES.LOCAL;
      }
      return next;
    },
    // 聊天路径的"注定 401 先拦下来"（2026-09-18）：自查出口，用例直接调同一个函数。
    chatPreflight,
    effectiveChatEndpoint,
    switchToStoredCard,
    createNewConversation,
    selectChat,
    archiveChat,
    restoreChat,
    deleteChat,
    retryChatList,
    retryChatTemplate,
    setArchivedChatSearch,
    // Task-31D：角色管理（设置区 + 侧边栏「角色」入口）复用。
    openAiCreateDialog,
    closeAiCreateDialog,
    openFileImport,
    refreshCharacterRegistryAfterDelete,
  };

  /* 把一份设置补丁压到当前生效状态上。 */
  function applySettingsPatch(patch) {
    const core = window.TASK22_CORE;
    if (!patch) return;
    if (typeof patch.thinking === "boolean") liveState.thinking = patch.thinking;
    if (typeof patch.auto_memory === "boolean") liveState.autoMemory = patch.auto_memory;
    if (typeof patch.auto_event_memory === "boolean") liveState.eventMemory = patch.auto_event_memory;
    // 语言设置改了（顶栏下拉 / 设置里改的）：立刻按新值走，不用等重读落盘。
    if (patch.language_mode === "auto" || patch.language_mode === "zh" || patch.language_mode === "en") {
      liveState.localSettings = Object.assign({}, liveState.localSettings || {}, { language_mode: patch.language_mode });
    }
    if (patch.language_by_card && typeof patch.language_by_card === "object") {
      liveState.localSettings = Object.assign({}, liveState.localSettings || {}, {
        language_by_card: Object.assign({}, (liveState.localSettings && liveState.localSettings.language_by_card) || {}, patch.language_by_card),
      });
    }
    if (typeof patch.model === "string" && patch.model) liveState.modelName = patch.model;
    if (patch.provider) {
      liveState.modelMode = patch.provider === "deepseek" ? core.CHAT_MODES.DEEPSEEK_FLASH : core.CHAT_MODES.LOCAL;
    }
  }

  window.addEventListener("roleworld:settings-changed", (event) => {
    // 模型页改了配置（服务商 / 模型名 / 思考模式 / 开关）就地生效，不用刷新。
    const patch = (event && event.detail) || {};
    // 记下这次改动：整量重读是异步的，重读到的是**改动前**的旧值，
    // 读回来会把刚改的值盖回去 —— 这正是"刚改完就发送用的是旧值"的根因。
    liveState.pendingSettingsPatch = Object.assign({}, liveState.pendingSettingsPatch || {}, patch);
    applySettingsPatch(patch);
    syncChatModelControls();
    updateComposerLive();
    loadChatModelSettings()
      .then(() => {
        // 重读完成后，把"用户刚改、可能还没落盘"的值重新压回去，最后再清掉。
        applySettingsPatch(liveState.pendingSettingsPatch);
        liveState.pendingSettingsPatch = null;
        syncChatModelControls();
        updateComposerLive();
      })
      .catch(() => {});
  });

  window.addEventListener("DOMContentLoaded", () => {
    const templateRetry = document.querySelector("#chatTemplateGateRetry");
    if (templateRetry) templateRetry.addEventListener("click", retryChatTemplate);
    // Task-29A：角色选择器 —— 触发按钮开关、菜单项点选、外部点击关闭。
    const pickerTrigger = document.querySelector("#characterPickerTrigger");
    if (pickerTrigger) pickerTrigger.addEventListener("click", toggleCharacterPicker);
    const pickerMenu = document.querySelector("#characterPickerMenu");
    if (pickerMenu) pickerMenu.addEventListener("click", (event) => {
      const item = event.target.closest(".character-picker-item");
      if (item && item.dataset.avatar) { selectCharacterForActive(item.dataset.avatar); return; }
      const action = event.target.closest(".character-picker-action");
      if (action && action.dataset.action === "ai-create") openAiCreateDialog();
      else if (action && action.dataset.action === "import-file") openFileImport();
    });
    // Task-29A：AI 创建角色对话框与文件导入。
    const aiBriefButton = document.querySelector("#aiBriefButton");
    if (aiBriefButton) aiBriefButton.addEventListener("click", () => { generateAiBrief().catch(() => {}); });
    // 「跳过，直接生成」：沿用原来的路径，用原始描述直接写卡。
    const aiSkipBriefButton = document.querySelector("#aiSkipBriefButton");
    if (aiSkipBriefButton) aiSkipBriefButton.addEventListener("click", () => {
      generateAiDraft("description", { buttonId: "#aiSkipBriefButton" }).catch(() => {});
    });
    const aiBriefNextButton = document.querySelector("#aiBriefNextButton");
    if (aiBriefNextButton) aiBriefNextButton.addEventListener("click", () => {
      generateAiDraft("brief", { buttonId: "#aiBriefNextButton" }).catch(() => {});
    });
    const aiBriefRetryButton = document.querySelector("#aiBriefRetryButton");
    if (aiBriefRetryButton) aiBriefRetryButton.addEventListener("click", () => { generateAiBrief().catch(() => {}); });
    const aiBriefBackButton = document.querySelector("#aiBriefBackButton");
    if (aiBriefBackButton) aiBriefBackButton.addEventListener("click", backToDescription);
    const aiBriefInput = document.querySelector("#aiBriefInput");
    if (aiBriefInput) aiBriefInput.addEventListener("input", renderAiBriefCount);
    const aiRegenerateButton = document.querySelector("#aiRegenerateButton");
    if (aiRegenerateButton) aiRegenerateButton.addEventListener("click", regenerateAiDraft);
    const aiBackButton = document.querySelector("#aiBackButton");
    if (aiBackButton) aiBackButton.addEventListener("click", backToDescription);
    const aiSaveButton = document.querySelector("#aiSaveButton");
    if (aiSaveButton) aiSaveButton.addEventListener("click", saveAiDraft);
    const aiDescriptionInput = document.querySelector("#aiDescriptionInput");
    if (aiDescriptionInput) aiDescriptionInput.addEventListener("input", renderAiDescriptionCount);
    document.querySelectorAll("[data-action='close-ai-create']").forEach((el) => {
      el.addEventListener("click", closeAiCreateDialog);
    });
    const characterImportInput = document.querySelector("#characterImportInput");
    if (characterImportInput) characterImportInput.addEventListener("change", onImportFileSelected);
    // 「本次请求」：平时只是一个很淡的入口，点开才看，关掉即消失。
    const peekButton = document.querySelector("#requestPeekButton");
    if (peekButton) peekButton.addEventListener("click", openRequestPeek);
    document.querySelectorAll("[data-action='close-request-peek']").forEach((node) => {
      node.addEventListener("click", closeRequestPeek);
    });
    const peekSurface = document.querySelector("#requestPeek");
    if (peekSurface) {
      peekSurface.addEventListener("click", (event) => {
        if (event.target === peekSurface) { closeRequestPeek(); return; }
        const book = event.target.closest(".request-peek-book");
        if (book) toggleBookEntries(book).catch(() => {});
      });
      peekSurface.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const book = event.target.closest(".request-peek-book");
        if (book) { event.preventDefault(); toggleBookEntries(book).catch(() => {}); }
      });
    }
    // 角色面板：关闭、分页、点背景关、以及设定页里那两个"去记忆/去关系"的按钮。
    document.querySelectorAll("[data-action='close-character-panel'], [data-action='close-memory'], [data-action='close-companion']").forEach((node) => {
      node.addEventListener("click", closeCharacterPanel);
    });
    document.querySelectorAll("[data-action='open-character-panel']").forEach((node) => {
      node.addEventListener("click", () => { openCharacterPanel().catch(() => {}); });
    });
    document.querySelectorAll("[data-action='open-character-memories']").forEach((node) => {
      node.addEventListener("click", () => { openCharacterPanel("memories").catch(() => {}); });
    });
    document.querySelectorAll("[data-character-tab]").forEach((node) => {
      node.addEventListener("click", () => { showCharacterTab(node.dataset.characterTab).catch(() => {}); });
    });
    const setupPane = document.querySelector("#characterPaneSetup");
    if (setupPane) {
      // 设定页的按钮是每次渲染时新建的，所以用委托而不是逐个绑定。
      setupPane.addEventListener("click", (event) => {
        const button = event.target.closest("[data-action]");
        if (!button) return;
        if (button.dataset.action === "character-tab-memories") showCharacterTab("memories").catch(() => {});
        if (button.dataset.action === "character-tab-relationship") showCharacterTab("relationship").catch(() => {});
      });
    }
    const characterSurface = characterPanel();
    if (characterSurface) {
      characterSurface.addEventListener("click", (event) => {
        if (event.target === characterSurface) closeCharacterPanel();
      });
    }
    /* 消息操作菜单：一个委托监听管住所有消息（消息是动态渲染的，逐个绑定会漏）。
       点 ⋯ 开/关；点菜单项执行；点别处或按 Esc 关。 */
    const messageArea = document.querySelector("#dynamicMessages");
    if (messageArea) {
      messageArea.addEventListener("click", (event) => {
        const toggle = event.target.closest(".message-menu-button");
        if (toggle) {
          const menu = toggle.parentElement.querySelector(".message-menu");
          const willOpen = menu && menu.hidden;
          closeMessageMenus(willOpen ? menu : null);
          if (menu) {
            menu.hidden = !willOpen;
            toggle.setAttribute("aria-expanded", String(willOpen));
          }
          return;
        }
        const item = event.target.closest(".message-menu-item");
        if (item) {          const index = Number(item.dataset.messageIndex);
          const action = item.dataset.messageAction;
          closeMessageMenus();
          if (action === "copy") {
            const message = messageAt(index);
            copyText(message && message.mes).then((ok) => showToast(ok ? MESSAGE_COPY_DONE : "复制失败，可以手动选中复制"));
          }
          if (action === "edit") startEditMessage(index).catch(() => {});
          if (action === "regenerate") regenerateReply(index).catch(() => {});
          if (action === "branch") branchFromMessage(index).catch(() => {});
          if (action === "speak") speakMessage(index).catch(() => {});
          return;
        }
        // 表情选择面板里点了一张：把那张发出去。
        // ⚠ 真正的绑定在 `openStickerPicker()` 里（直接绑在每个按钮上）—— 面板挂在
        //   `.composer-box`，**不在**这个委托的作用范围（#dynamicMessages）内，
        //   所以这里的分支收不到表情点击（2026-09-18 用户实测「选中之后发送不了」）。
        //   留着它只是兜底：万一以后面板被移进消息区，这里仍然能处理。
        const stickerItem = event.target.closest(".sticker-picker-item");
        if (stickerItem) {
          sendSticker(stickerItem.dataset.stickerId).catch(() => {});
          return;
        }
        // ⚠ 「设置 → 语音」的三个按钮（试听 / 恢复默认 / 清空缓存）**不在这里**处理。
        //   它们原来挂在这个 #dynamicMessages 的委托里，而设置面板**不在聊天区里面** ——
        //   于是那些点击根本到不了处理器，用户看到的就是"试听按钮根本点不动"
        //   （2026-09-14 实测反馈）。它们现在挂在 document 上的一个小委托里，
        //   见下面 bindVoicePanelControls()。
        const step = event.target.closest(".message-version-step");
        if (step) {
          switchMessageVersion(Number(step.dataset.messageIndex), Number(step.dataset.versionStep)).catch(() => {});
          return;
        }
        // 失败那一轮的「重试」：把原话放回输入框再发一次。
        // 失败的一轮没有落盘（整轮一起写），所以重发不会产生重复的用户消息。
        const retry = event.target.closest("[data-action='retry-turn']");
        if (retry) {
          const text = retry.dataset.userText || "";
          if (!text) return;
          restoreInput(text);
          const card = retry.closest(".turn-failure");
          if (card) card.remove();
          sendLive().catch(() => {});
        }
      });
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".message-actions")) closeMessageMenus();
        // 「+」面板：点别处就收起（和表情面板、角色选择器同一套口径）。
        if (composerMenuOpen && !event.target.closest("#composerMenu, #composerPlusButton")) setComposerMenuOpen(false);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { closeMessageMenus(); if (composerMenuOpen) setComposerMenuOpen(false); }
      });
    }
    // 失败那一轮的「重试」按钮是**动态**渲染的（renderTurnFailure），
    // 所以接线在上面 #dynamicMessages 的委托监听里，不在这里逐个绑定。
    // 记忆分页：手动加一条。
    document.querySelectorAll("[data-action='add-memory']").forEach((node) => {
      node.addEventListener("click", () => { addMemoryEntry(); });
    });
    // 伴侣模式：关系档案的开关、保存、以及"边写边看这一轮会多带多少"。
    renderCompanionRules();
    bindChatRecap();
    bindSendEstimate();
    // 语音输入与发表情：没有能力就不显示那两个按钮（见 bindComposerExtras）。
    bindComposerExtras().catch(() => {});
    // 微信式输入条：高度随内容、发送键按需出现、「+」面板（2026-09-18）。
    bindComposerMenu();
    // 输入框里可能已经有草稿（草稿恢复、切回来）——先把高度与按钮对一次。
    autoGrowComposer();
    updateComposerAffordances();
    // 原生语音（Android 系统 TTS）：**开机就预热**。
    // 引擎初始化是异步的（要等系统回调），不预热的话用户第一次点「朗读」时
    // 引擎还没就绪，会白白等一两秒甚至报"没有中文语音包"。
    // 桥是外壳在 onCreate 里挂的，但**挂载会重试**（WebView 出现得比 onCreate 晚），
    // 所以这里也要重试几次：一开始拿不到桥是正常的，不是"没有原生语音"。
    const preheatNativeVoice = () => {
      try {
        const bridge = window.__rwNativeTts;
        if (bridge && typeof bridge.init === "function") {
          bridge.init();
          return true;
        }
      } catch (_) { /* 桥有问题也不该影响启动 */ }
      return false;
    };
    let preheatDone = preheatNativeVoice();
    if (!preheatDone) {
      // 外壳每次挂上桥都会发这个事件；另外自己也轮询几次兜底。
      window.addEventListener("rw-native-tts-ready", () => { preheatDone = preheatNativeVoice(); });
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (preheatNativeVoice() || tries >= 12) clearInterval(timer);
      }, 500);
    }
    // 真机自检：**默认关掉了**。
    // 早期为了让"手机上到底能不能出声"可观测（华为 WebView 不转发 console、
    // APK 又不是 debuggable），这里会在首次启动念一句英文；现在已经验通
    // （原生日志：init state=0 / engine.speak code=0 / start→done），
    // 留着只会每次装完都念一句、打扰用户，所以停用。
    // 要重新验时：把下面的 `false &&` 去掉，并清掉 localStorage 里的 roleworld.voiceSelfTest。
    try {
      if (false && localStorage.getItem("roleworld.voiceSelfTest") !== "done") {
        setTimeout(async () => {
          const bridge = window.__rwNativeTts;
          if (!bridge || typeof bridge.speak !== "function") {
            localStorage.setItem("roleworld.voiceSelfTest", "skipped-no-bridge");
            return;
          }
          try {
            const result = await window.RoleWorldVoice.speak(
              "Voice check. If you can hear this, the native voice works.",
              { lang: "en-US", profile: { rate: 1, pitch: 1 } },
            );
            localStorage.setItem("roleworld.voiceSelfTest",
              result && result.ok ? "done" : ("failed:" + (result && result.reason)));
          } catch (error) {
            localStorage.setItem("roleworld.voiceSelfTest",
              "error:" + (error && error.message ? error.message : error));
          }
        }, 2500);
      }
    } catch (_) { /* 隐私模式等拿不到 localStorage 就跳过自检 */ }
    document.querySelectorAll("[data-action='open-companion']").forEach((node) => {
      node.addEventListener("click", () => { openCompanionDialog().catch(() => {}); });
    });
    const companionSave = document.querySelector("#companionSaveButton");
    if (companionSave) companionSave.addEventListener("click", () => { submitCompanionDialog().catch(() => {}); });
    const companionRelation = document.querySelector("#companionRelation");
    if (companionRelation) companionRelation.addEventListener("change", () => {
      renderCompanionCustomRow();
      renderCompanionPreview();
    });
    // 「聊天方式」一改就重画说明（它决定"这个角色有没有语音"，必须当场说清楚）。
    const companionChatStyle = document.querySelector("#companionChatStyle");
    if (companionChatStyle) companionChatStyle.addEventListener("change", () => {
      renderCompanionStyleRow(readCompanionForm(), liveState.companionEntry || activeCharacterEntry());
      renderCompanionPreview();
    });
    // 内置角色的伴侣复选框是禁用的，但脚本/快捷键仍可能改到它的状态 —— 点一下就纠正回来并说明原因。
    const companionEnabledBox = document.querySelector("#companionEnabled");
    if (companionEnabledBox) companionEnabledBox.addEventListener("click", (event) => {
      const access = companionAccessFor(liveState.companionEntry || activeCharacterEntry());
      if (!access.allowed) {
        event.preventDefault();
        companionEnabledBox.checked = false;
        showToast(access.reason);
      }
    });
    // 亲近度那两个控件是"联动"的：勾上自动就禁用滑杆并显示系统算的值。
    const affinityAuto = document.querySelector("#companionAffinityAuto");
    if (affinityAuto) affinityAuto.addEventListener("change", () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      const entry = liveState.companionEntry || activeCharacterEntry();
      renderCompanionAffinityHint(core.affinityOf(readCompanionForm(), new Date()));
      renderCompanionPreview();
      void entry;
    });
    const affinitySlider = document.querySelector("#companionAffinity");
    if (affinitySlider) affinitySlider.addEventListener("input", () => {
      const core = window.ROLEWORLD_COMPANION_CORE;
      renderCompanionAffinityHint(core.affinityOf(readCompanionForm(), new Date()));
    });
    ["#companionEnabled", "#companionCharCallsUser", "#companionUserCallsChar", "#companionSince",
      "#companionRelationCustom", "#companionShared", "#companionAffinity", "#companionNeglect",
      "#companionProactive", "#companionProactiveGap", "#companionProactiveMax"].forEach((selector) => {
      const node = document.querySelector(selector);
      if (!node) return;
      node.addEventListener("input", renderCompanionPreview);
      node.addEventListener("change", renderCompanionPreview);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const panel = characterPanel();
      if (panel && !panel.hidden) { event.preventDefault(); closeCharacterPanel(); }
    });
    document.addEventListener("keydown", (event) => {
      const surface = document.querySelector("#requestPeek");
      if (event.key === "Escape" && surface && !surface.hidden) { event.preventDefault(); closeRequestPeek(); }
    });
    document.addEventListener("click", (event) => {
      if (liveState.pickerOpen && !event.target.closest("#characterPicker")) setPickerMenuOpen(false);
    });
    bootLive().catch((err) => {
      if (isAuthRequired(err)) { showAuthGate(); return; }
      if (window.location.protocol === "http:" || window.location.protocol === "https:") {
        live = true;
        window.TASK21_LIVE = true;
        showTemplateInitError(err);
        updateComposerLive();
      }
    });
  });

  /* ---------- 每轮指标台账 ----------
   * 记：首字延迟 / 总延迟 / token 与费用 / 这一轮写了几条记忆、检索命中几条 / 用户手动标记。
   * 只存本机（kv 按角色一本台账），上限 200 轮。
   * **记忆错误与编造只由用户手动标记**，绝不自动判定 —— 机器猜不准这种事。
   */
  const METRICS_KEY = "metrics:";

  function metricsKey(entry) {
    return METRICS_KEY + ((entry && entry.avatar) || "unknown");
  }

  async function readMetrics(entry) {
    try {
      const stored = await window.RoleWorld.store.getKV(metricsKey(entry), []);
      return Array.isArray(stored) ? stored : [];
    } catch (_) {
      return [];
    }
  }

  async function writeMetrics(entry, turns) {
    liveState.metrics = turns;
    try { await window.RoleWorld.store.setKV(metricsKey(entry), turns); }
    catch (_) { /* 存不下不影响对话 */ }
  }

  async function recordTurnMetrics(entry, turn) {
    const core = window.ROLEWORLD_METRICS_CORE;
    if (!core || !entry) return;
    const turns = core.appendTurn(await readMetrics(entry), turn);
    await writeMetrics(entry, turns);
  }

  // 给某条消息打标记（记错 / 编造 / 很准）。再点一次取消。
  async function flagTurnFromMessage(turnId, flag, button) {
    const core = window.ROLEWORLD_METRICS_CORE;
    const entry = activeCharacterEntry();
    if (!core || !entry) return;
    const result = core.flagTurn(await readMetrics(entry), turnId, flag);
    if (!result.ok) {
      showToast(result.reason === "missing" ? "这一轮的记录还没落盘，稍后再试" : "标记失败");
      return;
    }
    await writeMetrics(entry, result.turns);
    const on = core.flagsOf(result.turns, turnId).indexOf(flag) >= 0;
    if (button) button.classList.toggle("flag-on", on);
    showToast(on
      ? (flag === core.FLAGS.WRONG_MEMORY ? "已记为记错" : flag === core.FLAGS.FABRICATION ? "已记为编造" : "已记为很准")
      : "已取消标记");
  }

})();
