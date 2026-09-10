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
    // Task-29A：AI 创建角色状态
    aiDialogOpen: false,
    aiPhase: "description",
    aiDescription: "",
    aiDraft: null,
    aiBusy: false,
    draftFlow: null,
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
      if (window.TASK25C_UI.setUserContext) window.TASK25C_UI.setUserContext(user);
      else {
        window.TASK25C_UI.setAdminMenuVisible(isAdmin);
        window.TASK25C_UI.setUserIdentity(user);
      }
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
    const routes = window.TASK31_ROUTING;
    // 本地版没有登录页：只提示，不跳转（否则会跳到一个不存在的地址）。
    if (window.STApi && window.STApi.isLocal === true) {
      disableComposer("出现了一个需要重新加载的问题，请刷新页面。");
      return;
    }
    if (!authRedirecting && window.location.pathname !== routes.productLoginUrl()) {
      authRedirecting = true;
      window.location.replace(routes.productLoginUrl());
    }
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
      title: String(entry.comment || (entry.key || []).join("、") || `条目 #${entry.uid}`).replace(/^\[STMB\]\s*/, ""),
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
    renderMemoryBooks();

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
    if (brand) brand.textContent = activeCharacterShortName();
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

  function renderChatList() {
    const container = $("#historyGroups");
    if (!container) return;
    container.textContent = "";
    const sessions = liveState.chatModel ? liveState.chatModel.getSessions().filter((session) => !session.archived) : [];
    const groups = new Map([["当前", []], ["今天", []], ["最近 7 天", []], ["更早", []]]);
    for (const session of sessions) {
      const label = sessionDay(session);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(session);
    }
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const group = document.createElement("section");
      group.className = "history-group";
      const heading = document.createElement("h3");
      heading.textContent = label;
      group.appendChild(heading);
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
        group.appendChild(shell);
      }
      container.appendChild(group);
    }
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "还没有已保存的对话";
      container.appendChild(empty);
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
    liveState.userName = (firstUser && firstUser.name) || "用户";
    // Task-29A：展示名跟随当前会话的绑定角色；未绑定会话跟随待选/默认角色。
    liveState.charName = activeCharacterEntry().charName || liveState.charName;
    // Task-29F：顶部标题/侧栏品牌名与记忆面板跟随当前角色。
    renderActiveCharacterIdentity();
    applyMemoryPanelFilter();
    renderChatList();
    renderArchivedChatSettings();
    renderLiveMessages(liveState.chatMessages);
    renderCharacterPicker();
    loadCostFor(session);
  }

  /* ---------- 用量与费用估算 ---------- */
  const COST_KEY_PREFIX = "usage:";

  function costKey(avatar, fileName) {
    return COST_KEY_PREFIX + avatar + ":" + fileName;
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
  const AUTO_MEMORY_MAX = 50;

  // 把模型给的要点写进「MB <角色短名> — 自动记忆」，只保留最近 AUTO_MEMORY_MAX 条。
  async function rememberForCharacter(entry, memories) {
    const core = window.TASK29_CHARACTER_CORE;
    if (!entry || !entry.avatar || !core || !memories.length) return 0;
    const bookName = core.newMemoryBookName(entry, AUTO_MEMORY_BOOK);
    let data = { entries: {} };
    try {
      const existing = await window.STApi.getWorld(bookName);
      if (existing && existing.entries) data = existing;
    } catch (_) { /* 还没有这本书，下面新建 */ }
    const entries = Object.assign({}, data.entries || {});
    const contents = Object.keys(entries).map((key) => String(entries[key].content || "").trim());
    let maxUid = 0;
    Object.keys(entries).forEach((key) => { maxUid = Math.max(maxUid, Number(entries[key].uid) || 0); });
    let added = 0;
    memories.forEach((text) => {
      if (contents.indexOf(text) >= 0) return;
      maxUid += 1;
      entries[String(maxUid)] = {
        uid: maxUid,
        key: [],
        keysecondary: [],
        comment: text.slice(0, 24),
        content: text,
        // 自动记忆一律常驻上下文：它是模型自己攒的要点，靠关键词匹配会漏。
        constant: true,
        disable: false,
        displayIndex: maxUid,
      };
      contents.push(text);
      added += 1;
    });
    if (!added) return 0;
    const ordered = Object.keys(entries).map(Number).sort((a, b) => a - b);
    while (ordered.length > AUTO_MEMORY_MAX) delete entries[String(ordered.shift())];
    await window.STApi.editWorld(bookName, Object.assign({}, data, { entries }));
    return added;
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
    totals.last = { input: usage.input, output: usage.output, cost, exact: usage.exact === true };
    liveState.cost = totals;
    renderCostLine();
    if (session.avatar && session.fileName) {
      try { await window.RoleWorld.store.setKV(costKey(session.avatar, session.fileName), totals); } catch (_) { /* 存不下不影响对话 */ }
    }
  }

  function renderCostLine() {
    const node = document.querySelector("#chatCostLine");
    if (!node) return;
    const totals = liveState.cost || emptyCost();
    if (!totals.turns) { node.textContent = ""; return; }
    const pricing = window.RoleWorldPricing;
    const prices = currentPrices();
    const approx = totals.last && totals.last.exact === false ? "≈" : "";
    const unit = prices.output > 0 ? ` · 输出 ¥${prices.output}/M（${prices.period}）` : "";
    node.textContent = `本对话 ${totals.turns} 轮 · 输入 ${pricing.formatTokens(totals.input)} / 输出 ${pricing.formatTokens(totals.output)} tokens · 累计 ${approx}${pricing.formatCost(totals.cost)}${unit}`;
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
    const edit = document.querySelector("#aiCreateEditPhase");
    if (desc) desc.hidden = phase !== "description";
    if (edit) edit.hidden = phase !== "edit";
    const title = document.querySelector("#aiCreateTitle");
    if (title) title.textContent = phase === "edit" ? "编辑角色草稿" : "创建角色";
  }

  function setAiBusy(busy, buttonId) {
    liveState.aiBusy = !!busy;
    const btn = buttonId && document.querySelector(buttonId);
    if (btn) {
      btn.disabled = !!busy;
      btn.textContent = busy ? "生成中…" : (buttonId === "#aiGenerateButton" ? "生成角色草稿" : "重新生成");
    }
    setAiError("");
  }

  function setAiError(message) {
    const error = document.querySelector(`#${liveState.aiPhase === "edit" ? "aiEditError" : "aiCreateError"}`);
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
    liveState.draftFlow = window.TASK29_CHARACTER_CORE.createDraftFlow();
    setAiPhase("description");
    setAiBusy(false, "#aiGenerateButton");
    setAiError("");
    const input = document.querySelector("#aiDescriptionInput");
    if (input) { input.value = ""; }
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

  function validateAiDescription() {
    const text = (document.querySelector("#aiDescriptionInput")?.value || "").trim();
    if (text.length < 20) { setAiError("角色描述至少需要 20 个字符。"); return null; }
    if (text.length > 4000) { setAiError("角色描述不能超过 4000 字符。"); return null; }
    liveState.aiDescription = text;
    return text;
  }

  // 调用模型生成草稿。只送当前角色描述；复用现有 custom_url / custom_include_body。
  // 所有模型调用都经 draftFlow.beginGeneration 计数，全局最多两次（一次修复）。
  async function generateAiDraft() {
    const description = validateAiDescription();
    if (description === null || liveState.aiBusy) return;
    if (!liveState.aiDialogOpen) return;
    if (liveState.draftFlow.getPhase() !== window.TASK29_CHARACTER_CORE.DRAFT_PHASES.IDLE
      && !liveState.draftFlow.retryAllowed()) {
      setAiError("已达到最大生成次数（2 次），请直接编辑或保存草稿。");
      return;
    }
    setAiBusy(true, "#aiGenerateButton");
    const callModel = async () => {
      liveState.draftFlow.beginGeneration();
      const payload = window.TASK29_CHARACTER_CORE.buildDraftGeneratePayload({ description, settings: liveState.settings, language: (document.querySelector("#aiLanguageSelect")?.value) || "auto" });
      const response = await window.STApi.generate(payload, undefined);
      const parsed = window.TASK22_CORE.parseGenerateResponse(response);
      if (!parsed.content || !parsed.content.trim()) throw Object.assign(new Error("empty response"), { code: "DRAFT_EMPTY" });
      // 不保存模型原始回复；直接解析/归一化为草稿。
      return liveState.draftFlow.receiveGenerated(parsed.content);
    };
    try {
      const draft = await callModel();
      liveState.aiDraft = draft;
      setAiPhase("edit");
      fillAiEditFields(draft);
      setAiBusy(false, "#aiGenerateButton");
    } catch (err) {
      if (isAuthRequired(err)) { showAuthGate(); return; }
      const retriable = err && (err.code === "DRAFT_PARSE_ERROR" || err.code === "DRAFT_DANGEROUS_KEY"
        || err.code === "DRAFT_INVALID");
      if (retriable && liveState.draftFlow.retryAllowed()) {
        // 一次修复：再调用一次模型（GENERATING → GENERATING）。
        try {
          const draft = await callModel();
          liveState.aiDraft = draft;
          setAiPhase("edit");
          fillAiEditFields(draft);
          setAiBusy(false, "#aiGenerateButton");
          return;
        } catch (retryErr) {
          if (isAuthRequired(retryErr)) { showAuthGate(); return; }
        }
        setAiBusy(false, "#aiGenerateButton");
        setAiError("模型两次都没有给出可用的角色卡。可以把描述写得更具体些再试，或直接手动填写。");
        return;
      }
      setAiBusy(false, "#aiGenerateButton");
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
    setAiPhase("description");
    setAiBusy(false, "#aiGenerateButton");
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
      await window.STApi.deleteChat(session.avatar, session.fileName);
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
          : saving ? '<span aria-hidden="true">…</span>' : '<span aria-hidden="true">↑</span>';
      }
    } else if (!liveState.pending && !liveState.switching) {
      disableComposer(liveState.templateBusy ? "正在准备对话…" : liveState.templateError ? "准备失败，请重试" : "正在准备对话…");
    }
    if (stop) { stop.hidden = true; stop.disabled = true; }
    setChatControlsDisabled(blocked, { allowSelection: true });
    renderCharacterPicker();
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
      extra: { task22_engine: "A" },
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
    const token = (window.STApi && window.STApi._token) || "";
    // 本地版：适配层直接把请求发到用户配置的模型端点，并原样返回 Response。
    const request = (body) => (window.STApi && typeof window.STApi.generateStream === "function")
      ? window.STApi.generateStream(body, signal)
      : fetch("/api/backends/chat-completions/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-csrf-token": token },
        body: JSON.stringify(body),
        signal: signal,
      });
    const response = await request(payload);
    if (!response.ok) throw Object.assign(new Error("generation failed"), { status: response.status });

    const sink = { content: "", reasoning: "", chunks: 0, usage: null, emit: () => onDelta(sink.content || sink.reasoning) };
    liveState.streamChunks = 0;
    liveState.lastUsage = null;
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
    liveState.cancelRequested = false;
    restoreInput("");
    renderLiveMessages(previousMessages.concat([{ name: liveState.userName, is_user: true, mes: text }]));
    setLiveBusy(true);
    liveState.pendingText = text;
    const controller = new AbortController();
    liveState.controller = controller;
    let saveCompleted = false;
    let bound = false;
    let streamRow = null;
    try {
      // 步骤 1：角色初始化 —— 取目标角色完整卡（含 data.*），失败走失败路径。
      let card = liveState.cardCache && liveState.cardCache.get(entry.avatar);
      if (!card) {
        card = await window.STApi.getCharacter(entry.avatar);
        if (!card || !card.data) throw new Error("character card unavailable");
        if (liveState.cardCache) liveState.cardCache.set(entry.avatar, card);
      }
      // 只注入当前角色自己的记忆书（按书名的角色短名归属，多个角色各一套）。
      const memoryBooks = window.TASK29_CHARACTER_CORE.memoryBooksFor(entry, liveState.memoryBooks);
      // 步骤 2：流式发送。
      const payload = window.TASK22_CORE.buildGeneratePayload({
        card,
        memoryBooks,
        history: previousMessages.slice(-16),
        userText: text,
        settings: liveState.settings,
        engine: state.engine,
        mode: liveState.modelMode,
        modelName: liveState.modelName,
        thinking: liveState.thinking === true,
        autoMemory: liveState.autoMemory !== false,
        stream: true,
      });
      streamRow = appendLiveStreamRow(entry.charName || liveState.charName);
      let streamed = "";
      let aborted = false;
      let content = "";
      try {
        content = await generateChatStream(payload, controller.signal, (partial) => {
          streamed = partial;
          updateLiveStreamRow(streamRow, partial);
        });
      } catch (streamError) {
        if (streamError && streamError.name === "AbortError") aborted = true;
        else throw streamError;
      }
      const rawText = String(content || streamed || "").trim();
      // 自动记忆：模型用 [[记住: …]] 写的要点要剥出来，正文里不能留标记。
      let finalText = rawText;
      let memories = [];
      if (liveState.autoMemory !== false) {
        const parsed = window.TASK22_CORE.extractMemory(rawText);
        if (parsed.memories.length) {
          finalText = parsed.text || rawText;
          memories = parsed.memories;
        }
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
      try {
        await saveLiveChat(text, finalText, undefined, { charName: entry.charName });
      } catch (saveError) {
        if (bound) liveState.chatModel.unbindActive();
        throw saveError;
      }
      saveCompleted = true;
      // 模型自己记下的要点写进该角色的「自动记忆」书；下一条消息就会带上。
      if (memories.length) {
        try {
          const added = await rememberForCharacter(entry, memories);
          if (added) {
            showToast(`已记住 ${added} 条`);
            loadBooks().catch(() => {});
          }
        } catch (_) { /* 记忆写失败不影响这轮对话 */ }
      }
      // 记一笔用量与费用（接口回了 usage 就用真值，否则按字数估算）。
      try {
        const usage = window.RoleWorldPricing.usageOf({
          usage: liveState.lastUsage,
          messages: payload.messages,
          reply: finalText,
        });
        await recordCost(targetSession, usage);
      } catch (_) { /* 估算失败不影响对话 */ }
      if (stopped) showToast("已停止（保留已生成的部分）");
      setChatListStatus("");
    } catch (err) {
      removeLiveStreamRow(streamRow);
      streamRow = null;
      renderLiveMessages(targetSession.messages);
      if (!saveCompleted) restoreInput(originalInput);
      if (isAuthRequired(err)) { showAuthGate(); return; }
      if (err && err.name === "AbortError") showToast("已停止");
      else if (window.TASK22_CORE.isDeepSeekChatMode(liveState.modelMode) && err && err.status === 400) showToast("尚未保存 DeepSeek API Key：请到「设置 → 对话」粘贴并保存");
      else showToast("回复未保存，请重试");
    } finally {
      removeLiveStreamRow(streamRow);
      liveState.controller = null;
      liveState.cancelRequested = false;
      liveState.pendingText = "";
      setLiveBusy(false);
      updateComposerLive();
    }
  }

  /* ---------- 对话模型（统一由「设置 → 模型」决定，2026-09-10） ----------
   * 以前这里另有一套"对话模型"下拉（本地模型 / DeepSeek V4 Flash / V4 Pro / V4.1），
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
      option.textContent = price && price.output > 0
        ? `${name} · ¥${price.input}/¥${price.output}`
        : name;
      select.appendChild(option);
    });
    // 末尾留一个入口，直接跳到设置里去填任意模型名。
    const more = document.createElement("option");
    more.value = "__custom__";
    more.textContent = "自定义模型名…";
    select.appendChild(more);
    select.value = choices.indexOf(current) >= 0 ? current : choices[0];
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
    renderCostLine();
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
    await loadChatModelSettings();
    liveState.templateError = false;
    setChatTemplateGate("ready");
    updateComposerLive();
    // Task-27H：启动落定即摘除 theme-pending。此前遮罩只在 setUserContext 成功时摘除，
    // 身份链路瞬时失败会出现"已准备好"弹出但页面灰屏；主题数据已由首帧内联脚本应用，
    // 此处摘除不会引入主题闪烁。
    document.documentElement.classList.remove("theme-pending");
    showToast("已准备好。");
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
    saveCorrectionLive,
    createMemoryBookLive,
    deleteMemoryBookLive,
    deleteMemoryLive,
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

  window.addEventListener("roleworld:settings-changed", (event) => {
    // 模型页改了配置（服务商 / 模型名 / 思考模式）就地生效，不用刷新。
    // 先按事件里的新值同步一次，保证"刚改完就发送"用的是新值；随后再整体重读。
    const patch = (event && event.detail) || {};
    const core = window.TASK22_CORE;
    if (typeof patch.thinking === "boolean") liveState.thinking = patch.thinking;
    if (typeof patch.auto_memory === "boolean") liveState.autoMemory = patch.auto_memory;
    if (typeof patch.model === "string" && patch.model) liveState.modelName = patch.model;
    if (patch.provider) {
      liveState.modelMode = patch.provider === "deepseek" ? core.CHAT_MODES.DEEPSEEK_FLASH : core.CHAT_MODES.LOCAL;
    }
    syncChatModelControls();
    updateComposerLive();
    loadChatModelSettings().then(updateComposerLive).catch(() => {});
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
    const aiGenerateButton = document.querySelector("#aiGenerateButton");
    if (aiGenerateButton) aiGenerateButton.addEventListener("click", generateAiDraft);
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
})();
