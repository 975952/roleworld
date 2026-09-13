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

  /* 消息旁的标记控件：两个很轻的文字按钮。只在有轮次 ID 的助手消息上出现。 */
  function buildFlagControls(turnId) {
    const core = window.ROLEWORLD_METRICS_CORE;
    const box = document.createElement("span");
    box.className = "message-flags";
    // 把这颗控件属于哪一轮写在 DOM 上：台账里可能有"没有对应消息行"的轮次
    // （例如保存失败的那一轮），只按"台账最后一条"去对会错位。
    if (turnId) box.dataset.turnId = String(turnId);
    if (!core) return box;
    const current = core.flagsOf(liveState.metrics || [], turnId);
    const make = (flag, label, title) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-flag";
      button.textContent = label;
      button.title = title;
      if (current.indexOf(flag) >= 0) button.classList.add("flag-on");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        flagTurnFromMessage(turnId, flag, button).catch(() => {});
      });
      return button;
    };
    box.appendChild(make(core.FLAGS.WRONG_MEMORY, "记错", "它记错了——计入台账"));
    box.appendChild(make(core.FLAGS.FABRICATION, "编造", "它编造了没发生过的事——计入台账"));
    return box;
  }

  function messageRow(message) {
    const row = document.createElement("article");
    const isUser = !!message.is_user;
    row.className = `message-row message-row-${isUser ? "user" : "assistant"}`;
    const stack = document.createElement("div");
    stack.className = "message-stack";
    const meta = document.createElement("div");
    meta.className = `message-meta ${isUser ? "message-meta-user" : ""}`;
    const who = document.createElement("strong");
    who.textContent = message.name || (isUser ? liveState.userName : liveState.charName);
    meta.appendChild(who);
    // 助手消息旁边给一个很轻的标记入口：记错 / 编造。**只由人点，机器不自动判定。**
    const turnId = !isUser && message.extra && message.extra.roleworld_turn_id ? String(message.extra.roleworld_turn_id) : "";
    if (turnId) meta.appendChild(buildFlagControls(turnId));
    stack.appendChild(meta);
    if (isUser) {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble user-bubble";
      const paragraph = document.createElement("p");
      paragraph.textContent = String(message.mes);
      bubble.appendChild(paragraph);
      stack.appendChild(bubble);
    } else {
      const body = document.createElement("div");
      body.className = "assistant-body";
      body.innerHTML = renderAssistantBody(String(message.mes));
      stack.appendChild(body);
      const refs = message.extra && Array.isArray(message.extra.roleworld_refs) ? message.extra.roleworld_refs : [];
      if (refs.length) stack.appendChild(buildRefList(refs));
      if (message.extra && message.extra.roleworld_truncated === true) stack.appendChild(buildTruncationNotice());
      const avatar = document.createElement("div");
      avatar.className = "message-avatar assistant-avatar";
      avatar.setAttribute("aria-label", liveState.charName);
      avatar.setAttribute("role", "img");
      row.appendChild(avatar);
    }
    row.appendChild(stack);
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
    for (const message of (Array.isArray(messages) ? messages : []).slice(-30)) container.appendChild(messageRow(message));
    scroll.scrollTop = scroll.scrollHeight;
  }

  function syncActiveSession() {
    const session = liveState.chatModel && liveState.chatModel.getActive();
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
    button.hidden = !(has && visible !== false);
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
        const rate = stats.wrongMemoryRate === null ? "—" : Math.round(stats.wrongMemoryRate * 100) + "%";
        box.textContent = `台账（最近 ${stats.turns} 轮）：首字平均 ${metricsCore.formatDuration(stats.avgFirstTokenMs)}`
          + ` · 整轮平均 ${metricsCore.formatDuration(stats.avgTotalMs)}`
          + ` · 费用合计 ¥${stats.cost.toFixed(4)}`
          + ` · 记忆写入 ${stats.memoriesAdded} 条 · 检索命中 ${stats.searchHits} 条`
          + ` · 记错 ${stats.wrongMemory} 次（${rate}）· 编造 ${stats.fabrication} 次`;
      }
      body.appendChild(box);
      if (stats.turns) {
        const hint = document.createElement("div");
        hint.className = "request-peek-dropped";
        hint.textContent = "「记错 / 编造」这两个数字只能由你手动标记 —— 每条回复旁边有按钮，机器不替你判定。";
        body.appendChild(hint);
      }
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
  async function openMemoryPanel() {
    const surface = document.querySelector("#memoryPanel");
    if (!surface) return;
    surface.hidden = false;
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
    const surface = document.querySelector("#memoryPanel");
    if (surface) surface.hidden = true;
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
  let companionCache = { avatar: "", profile: null };

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
    try {
      return core.buildCompanionBlock(profile, { lang: companionLangFor(entry) });
    } catch (_) { return ""; }
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
    return {
      enabled: document.querySelector("#companionEnabled")?.checked === true,
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

  function fillCompanionForm(profile) {
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
    renderCompanionPreview();
    renderCompanionSelfCheck();
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

  async function openCompanionDialog() {
    const surface = document.querySelector("#companionDialog");
    const entry = activeCharacterEntry();
    const subtitle = document.querySelector("#companionSubtitle");
    if (!surface) return;
    if (!entry || !entry.avatar) {
      showToast("先选一个角色，再写关系档案");
      return;
    }
    closeMemoryPanel();
    liveState.companionEntry = entry;
    const profile = await loadCompanion(entry);
    if (subtitle) {
      subtitle.textContent = `${entry.charName || entry.name}：这部分是你自己写的，模型不能改口；`
        + "它和「角色记忆」分开存，清空记忆不会动它。";
    }
    fillCompanionForm(profile);
    const error = document.querySelector("#companionError");
    if (error) { error.textContent = ""; error.hidden = true; }
    window.TASK25C_UI?.rememberDialogFocus?.("companionDialog");
    surface.hidden = false;
    window.TASK25C_UI?.syncOverlayScrollLock?.();
  }

  function closeCompanionDialog() {
    const surface = document.querySelector("#companionDialog");
    if (surface) surface.hidden = true;
    liveState.companionEntry = null;
    window.TASK25C_UI?.syncOverlayScrollLock?.();
    window.TASK25C_UI?.restoreDialogFocus?.("companionDialog");
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
    const pricing = window.RoleWorldPricing;
    const core = window.TASK22_CORE;
    const estimate = estimateNextRequest();
    if (!pricing || !core || !estimate) { node.hidden = true; node.textContent = ""; return; }
    const outputNote = `输出上限 ${pricing.formatTokens(estimate.output)}`;
    const contextNote = `上下文 ${pricing.formatTokens(estimate.context)}`;
    if (!estimate.known) {
      // 还没打过一轮：只能报确定的两件事（输出上限、上下文），不编输入量。
      node.textContent = `输出上限 ${pricing.formatTokens(estimate.output)} · 上下文 ${pricing.formatTokens(estimate.context)}`;
      node.title = "还没有上一轮可对照：发出第一轮之后，这里会显示「这次大约要发多少输入、大概多少钱」。";
      node.hidden = false;
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

  function setAiError(message) {
    const phase = liveState.aiPhase;
    const id = phase === "edit" ? "aiEditError" : (phase === "brief" ? "aiBriefError" : "aiCreateError");
    const error = document.querySelector("#" + id);
    if (error) {
      error.textContent = message || "";
      error.hidden = !message;
    }
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

  async function generateAiBrief() {
    const description = validateAiDescription();
    if (description === null || liveState.aiBusy || !liveState.aiDialogOpen) return;
    if (liveState.aiCalls >= AI_CALL_BUDGET) {
      setAiError(`这次创建已经用了 ${AI_CALL_BUDGET} 次模型调用，先停下。可以返回改成直接生成，或关掉重开。`);
      return;
    }
    setAiBusy(true, "#aiBriefButton");
    liveState.aiCalls += 1;
    try {
      const payload = window.TASK29_CHARACTER_CORE.buildBriefGeneratePayload({
        description,
        settings: liveState.settings,
        language: (document.querySelector("#aiLanguageSelect")?.value) || "auto",
      });
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
    setAiBusy(true, buttonId);
    const callModel = async () => {
      liveState.draftFlow.beginGeneration();
      liveState.aiCalls += 1;
      const payload = window.TASK29_CHARACTER_CORE.buildDraftGeneratePayload({
        description: window.TASK29_CHARACTER_CORE.briefAsDescription(description),
        settings: liveState.settings,
        language: (document.querySelector("#aiLanguageSelect")?.value) || "auto",
      });
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
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function stopLive() {
    if (liveState.generationPhase !== "generating") return;
    liveState.cancelRequested = true;
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

  function appendLiveStreamRow(name) {
    const container = $("#dynamicMessages");
    if (!container) return null;
    const row = document.createElement("article");
    row.className = "message-row message-row-assistant";
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
    body.innerHTML = renderAssistantBody("");
    stack.appendChild(body);
    row.appendChild(avatar);
    row.appendChild(stack);
    container.appendChild(row);
    const scroll = $("#chatScroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    return { row: row, body: body, scroll: scroll };
  }

  function updateLiveStreamRow(handle, text) {
    if (!handle || !handle.row.parentNode) return;
    // 边流边按最终格式渲染（旁白/对白分行），否则会先看到一堆原始符号、
    // 等保存后再"重新排版"一次，看起来很跳。
    handle.body.innerHTML = renderAssistantBody(text);
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

  async function sendLive() {
    const input = $("#messageInput");
    const originalInput = input && input.value || "";
    const text = originalInput.trim();
    if (!text || liveState.pending || liveState.switching || !liveState.activeSession) return;
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
    // 目标角色：已绑定会话用会话头像；未绑定空白会话用待选（缺省默认角色）。
    const entry = activeCharacterEntry();
    if (!entry || !entry.avatar) {
      showToast("暂时无法回复，请重试");
      updateComposerLive();
      return;
    }
    const previousMessages = targetSession.messages.slice();
    // 本轮标识（重发同一句会沿用同一个）：只有在「上一轮保存结果不确定」时才用它去查回执。
    const turnId = liveState.pendingTurnId || newTurnId();
    liveState.pendingTurnId = turnId;
    liveState.cancelRequested = false;
    restoreInput("");
    renderLiveMessages(previousMessages.concat([{ name: liveState.userName, is_user: true, mes: text }]));
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
      streamRow = appendLiveStreamRow(entry.charName || liveState.charName);
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
      const extraForMessage = Object.assign(
        {},
        refs.length ? { roleworld_refs: refs } : {},
        truncatedByLength ? { roleworld_truncated: true } : {},
      );
      // 先把「这一轮发出去了」记下来：万一下面结果不确定，重发时才知道要去确认。
      markSaveAttempted(targetSession, turnId);
      try {
        const saved = await saveLiveChat(text, finalText, undefined, {
          charName: entry.charName,
          turnId,
          extra: extraForMessage,
        });
        if (saved && saved.duplicate) duplicateTurn = true;
      } catch (saveError) {
        if (bound) liveState.chatModel.unbindActive();
        // 打上标记：这条回复是**存不上**（不是"请求失败"）。桌面版偶尔会遇到
        // Windows 上重命名被占用 —— 提示要说清真实原因，而且**内容不能丢**，
        // 所以把这一轮的原话与回复一起挂到错误上，让失败提示把它们留在屏幕上。
        if (saveError && typeof saveError === "object") {
          saveError.code = saveError.code || "SAVE_FAILED";
          saveError.turnUserText = text;
          saveError.turnReplyText = finalText;
        }
        throw saveError;
      }
      saveCompleted = true;
      clearSaveAttempted();
      invalidateHistoryCache();
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
      if (err && err.name === "AbortError") showToast("已停止");
      else if (err && err.cardMessage) {
        // 体验卡的问题（次数用完 / 被停用 / 已到期）：把中转的原话显示出来，并刷新徽标。
        showToast(err.cardMessage);
        renderCardChip().catch(() => {});
      }
      else if (err && err.code === "SAVE_FAILED") {
        // 存不上 ≠ 请求失败：内容已经生成。**别让它从屏幕上消失** ——
        // 以前这里只弹一句"回复未保存，请重试"，用户看到的是"我这句话和回复都没了"。
        const why = String((err && err.message) || "").slice(0, 120);
        try {
          if (err.turnUserText || err.turnReplyText) {
            const kept = (liveState.chatMessages || []).slice();
            if (err.turnUserText) kept.push({ name: liveState.userName, is_user: true, mes: err.turnUserText });
            if (err.turnReplyText) kept.push({ name: liveState.charName, is_user: false, mes: err.turnReplyText });
            renderLiveMessages(kept);
          }
        } catch (_) { /* 渲染失败也不能盖掉提示 */ }
        showToast("回复没存上：" + (why || "写入失败") + "（内容留在屏幕上，可先复制留底；再发一次会重新生成）");
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
        if (typeof window.TASK25C_UI.setSettingsSection === "function") window.TASK25C_UI.setSettingsSection("model");
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
        if (typeof window.TASK25C_UI.setSettingsSection === "function") window.TASK25C_UI.setSettingsSection("model");
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
  }

  function normalizedName(value) {
    return String(value || "").trim().toLocaleLowerCase();
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
    // 伴侣模式：关系档案（用户亲手写的那一份）。
    openCompanionDialog,
    // 主动开口为什么没发生（诊断用；测试与"设置 → 关于"都能看）。
    proactiveState: () => ({ reason: liveState.proactiveReason || null, tried: Array.from(liveState.proactiveTried || []) }),
    closeCompanionDialog,
    loadCompanion,
    saveCompanion,
    companionBlockFor,
    clearAllMemories,
    clearMemoryGroup,
    jumpToMemorySource,
    // 诊断用：当前打开的对话文件名、会话表（含归档）、手动刷新会话表。
    activeChatFileName: () => (liveState.activeSession && liveState.activeSession.fileName) || "",
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
    stopLive,
    onEngineChange,
    updateComposerLive,
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
    // 记忆面板：关闭按钮、点背景关、手动加一条。
    document.querySelectorAll("[data-action='close-memory']").forEach((node) => {
      node.addEventListener("click", closeMemoryPanel);
    });
    document.querySelectorAll("[data-action='add-memory']").forEach((node) => {
      node.addEventListener("click", () => { addMemoryEntry(); });
    });
    const memorySurface = document.querySelector("#memoryPanel");
    if (memorySurface) {
      memorySurface.addEventListener("click", (event) => { if (event.target === memorySurface) closeMemoryPanel(); });
    }
    // 伴侣模式：关系档案的开关、保存、以及"边写边看这一轮会多带多少"。
    renderCompanionRules();
    bindChatRecap();
    bindSendEstimate();    document.querySelectorAll("[data-action='open-companion']").forEach((node) => {
      node.addEventListener("click", () => { openCompanionDialog().catch(() => {}); });
    });
    document.querySelectorAll("[data-action='close-companion']").forEach((node) => {
      node.addEventListener("click", closeCompanionDialog);
    });
    const companionSurface = document.querySelector("#companionDialog");
    if (companionSurface) {
      companionSurface.addEventListener("click", (event) => { if (event.target === companionSurface) closeCompanionDialog(); });
    }
    const companionSave = document.querySelector("#companionSaveButton");
    if (companionSave) companionSave.addEventListener("click", () => { submitCompanionDialog().catch(() => {}); });
    const companionRelation = document.querySelector("#companionRelation");
    if (companionRelation) companionRelation.addEventListener("change", () => {
      renderCompanionCustomRow();
      renderCompanionPreview();
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
      const memory = document.querySelector("#memoryPanel");
      if (memory && !memory.hidden) { event.preventDefault(); closeMemoryPanel(); return; }
      const companion = document.querySelector("#companionDialog");
      if (companion && !companion.hidden) { event.preventDefault(); closeCompanionDialog(); }
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
