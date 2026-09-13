"use strict";

/* 记忆书列表的数据由集成层（integration.js）从本机数据库读出来传进来 ——
 * 这里以前放了一份**写死的示例书**（角色锁定书 / 场景记忆 / 精确事实 / 关系记录），
 * 结果是"记忆"那一栏要么空白、要么显示假数据。真实数据只有一个来源：本机数据库。 */
const memoryBooks = [];

const layoutConfig = Object.freeze({
  leftMin: 196,
  leftMax: 420,
  leftCollapseDistance: 54,
  centerMin: 560,
  rightMin: 320,
  rightMax: 620,
  utilityCloseWidth: 1120,
});

const accountCore = window.TASK27A_ACCOUNT_CORE;
const routes = window.TASK31_ROUTING;
const THEME_ACCOUNT_HINT_KEY = "task27a.current-account-handle.v1";
const defaultAccountPreferences = () => accountCore
  ? accountCore.defaultPreferences({ prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches })
  : { version: 1, theme: "dark", density: "comfortable", motion: "full", sendMode: "enter", lastSettingsSection: "appearance", harry: { sidebarCollapsed: false, sidebarWidth: 248, memoryOpen: false, memoryWidth: 420 }, general: { sidebarCollapsed: false, sidebarWidth: 248 } };

const state = {
  engine: "A",
  inspector: "memories",
  activeMemory: null,
  toastTimer: null,
  sidebarCollapsed: false,
  sidebarWidth: 248,
  memoryPanelOpen: false,
  rightWidth: 420,
  mobileDrawerOpen: false,
  mobileReturnFocus: null,
  dialogReturnFocus: new Map(),
  userMenuOpen: false,
  settingsOpen: false,
  settingsReturnFocus: null,
  memoryBusy: false,
  user: null,
  preferences: defaultAccountPreferences(),
  storageWarned: false,
};

const $ = (selector) => document.querySelector(selector);

const MOBILE_BREAKPOINT = 760;

function isMobileViewport() {
  return Number(window.innerWidth || 0) <= MOBILE_BREAKPOINT;
}

function updateVisualViewportMetrics() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const width = Number(viewport?.width || window.innerWidth || 0);
  const height = Number(viewport?.height || window.innerHeight || 0);
  const offsetTop = Number(viewport?.offsetTop || 0);
  // --viewport-w/h 是给 #appShell 算宽度用的：必须是"绝对 px"，
  // 因为 zoom 会把 vw 一起缩放（见 glass.css 里的注释）。
  // 宽度取 clientWidth：有没有滚动条都以实际可用宽度为准。
  const layoutWidth = Number(document.documentElement.clientWidth || width || 0);
  if (layoutWidth > 0) root.style.setProperty("--viewport-w", `${Math.round(layoutWidth)}px`);
  if (height > 0) root.style.setProperty("--viewport-h", `${Math.round(height)}px`);
  if (width > 0) root.style.setProperty("--visual-viewport-width", `${Math.round(width)}px`);
  if (height > 0) root.style.setProperty("--visual-viewport-height", `${Math.round(height)}px`);
  root.style.setProperty("--visual-viewport-offset-top", `${Math.round(offsetTop)}px`);
}

function isRestorableFocusNode(node) {
  return !!(node && node.isConnected && !node.hidden && !node.closest("[hidden]"));
}

function rememberDialogFocus(dialogId) {
  const active = document.activeElement;
  if (active && active !== document.body && isRestorableFocusNode(active)) state.dialogReturnFocus.set(dialogId, active);
}

function restoreDialogFocus(dialogId) {
  const target = state.dialogReturnFocus.get(dialogId);
  state.dialogReturnFocus.delete(dialogId);
  if (isRestorableFocusNode(target)) target.focus({ preventScroll: true });
}

function dialogFocusableNodes(dialog) {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll("button, input, textarea, select, a[href], [tabindex]"))
    .filter((node) => !node.disabled && !node.hidden && !node.closest("[hidden]") && node.getAttribute("tabindex") !== "-1");
}

function trapDialogTab(event, dialog) {
  const nodes = dialogFocusableNodes(dialog);
  if (!nodes.length) return;
  event.preventDefault();
  const current = nodes.indexOf(document.activeElement);
  const next = (current + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
  nodes[next].focus();
}

function updateMobileBottomNav(view) {
  document.querySelectorAll("[data-mobile-view]").forEach((item) => {
    const selected = item.dataset.mobileView === view;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-current", selected ? "page" : "false");
  });
}

function updateMobileDrawerControls(open) {
  const label = open ? "关闭主导航" : "打开主导航";
  document.querySelectorAll('[data-action="toggle-sidebar"]').forEach((toggle) => {
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
    toggle.setAttribute("aria-expanded", String(!!open));
  });
}

function setMobileDrawerOpen(open, options = {}) {
  const shouldOpen = isMobileViewport() && !!open;
  const wasOpen = state.mobileDrawerOpen;
  if (shouldOpen && !wasOpen) {
    const active = document.activeElement;
    state.mobileReturnFocus = active && active !== document.body ? active : null;
  }
  state.mobileDrawerOpen = shouldOpen;
  const shell = $("#appShell");
  shell?.classList.toggle("mobile-drawer-open", shouldOpen);
  const backdrop = $("#mobileDrawerBackdrop");
  if (backdrop) {
    backdrop.hidden = !shouldOpen;
    backdrop.setAttribute("aria-hidden", String(!shouldOpen));
  }
  const sidebar = $(".archive-sidebar");
  if (sidebar && isMobileViewport()) sidebar.setAttribute("aria-hidden", String(!shouldOpen));
  document.body.classList.toggle("mobile-drawer-visible", shouldOpen);
  updateMobileDrawerControls(shouldOpen);
  if (shouldOpen) {
    setUserMenuOpen(false, { restoreFocus: false });
    if (options.focus !== false) {
      window.setTimeout(() => $("#newConversationButton, .archive-sidebar .nav-item, .archive-sidebar button")?.focus(), 30);
    }
    return;
  }
  const returnFocus = state.mobileReturnFocus;
  state.mobileReturnFocus = null;
  if (options.restoreFocus !== false && wasOpen && isRestorableFocusNode(returnFocus)) {
    returnFocus.focus({ preventScroll: true });
  }
}

function syncMobileViewport() {
  updateVisualViewportMetrics();
  const mobile = isMobileViewport();
  $("#appShell")?.classList.toggle("mobile-mode", mobile);
  setMobileDrawerOpen(false, { restoreFocus: false, focus: false });
  if (!mobile) setSidebarCollapsed(state.sidebarCollapsed, { skipPersist: true });
}

function syncOverlayScrollLock() {
  const overlayIds = ["memoryModal", "aiCreateDialog"];
  const hasOverlay = state.mobileDrawerOpen || overlayIds.some((id) => {
    const node = document.getElementById(id);
    return !!(node && !node.hidden);
  });
  document.body.classList.toggle("overlay-open", hasOverlay);
}

function writeThemeAccountHint(handle) {
  const safe = String(handle || "").trim();
  if (!safe) return;
  try { window.sessionStorage.setItem(THEME_ACCOUNT_HINT_KEY, encodeURIComponent(safe)); } catch (_) { /* optional bootstrap hint */ }
}

function clearThemeAccountHint() {
  try { window.sessionStorage.removeItem(THEME_ACCOUNT_HINT_KEY); } catch (_) { /* optional bootstrap hint */ }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function setMemoryBusy(busy, label = "处理中…") {
  state.memoryBusy = !!busy;
  const memoryView = $("#memoryView");
  if (memoryView) memoryView.setAttribute("aria-busy", String(state.memoryBusy));
  const controls = document.querySelectorAll("#memoryView button, #newMemoryBookButton, #memoryModal button, #modalTitle, #modalCurrent");
  controls.forEach((control) => {
    control.disabled = state.memoryBusy;
  });
  const save = $("#saveCorrection");
  const deleteEntry = $("#deleteMemoryButton");
  const newBook = $("#newMemoryBookButton");
  if (save) {
    if (!save.dataset.idleLabel) save.dataset.idleLabel = save.textContent || "保存";
    save.textContent = state.memoryBusy ? label : save.dataset.idleLabel;
  }
  if (deleteEntry) {
    if (!deleteEntry.dataset.idleLabel) deleteEntry.dataset.idleLabel = deleteEntry.textContent || "删除条目";
    deleteEntry.textContent = state.memoryBusy ? "处理中…" : deleteEntry.dataset.idleLabel;
  }
  if (newBook) {
    if (!newBook.dataset.idleLabel) newBook.dataset.idleLabel = newBook.textContent || "新增记忆书";
    newBook.textContent = state.memoryBusy ? "处理中…" : newBook.dataset.idleLabel;
  }
}

function beginMemoryMutation(label) {
  if (state.memoryBusy) {
    showToast("已有记忆操作正在进行，请稍候。");
    return false;
  }
  setMemoryBusy(true, label);
  return true;
}

function endMemoryMutation() {
  setMemoryBusy(false);
}

function setEngine(engineId) {
  state.engine = engineId === "B" ? "B" : "A";
  if (window.TASK21 && window.TASK21.onEngineChange) window.TASK21.onEngineChange(state.engine);
}

function renderMemoryBooks(books) {
  // 目标元素是右侧「记忆」栏里的列表（#memoryBookList）。
  // 以前这里查的是 #memoryList —— 那个 id 在角色记忆弹层里也有一个，
  // querySelector 只命中文档里第一个，于是真实记忆书被画进了弹层、右栏永远空白。
  const list = $("#memoryBookList");
  if (!list) return;
  // 集成层把真实记忆书传进来；没传（或集成层没加载）时就渲染当前这一份，不编造内容。
  const source = Array.isArray(books) ? books : memoryBooks;
  if (Array.isArray(books)) { memoryBooks.length = 0; memoryBooks.push(...books); }
  list.innerHTML = source.map((book) => `
    <section class="memory-book ${book.open ? "is-open" : ""}" data-book="${escapeHtml(book.id)}">
      <button class="memory-book-header" type="button" aria-expanded="${book.open}">
        <span class="book-emblem" aria-hidden="true">${escapeHtml(book.symbol)}</span>
        <span class="book-copy"><strong>${escapeHtml(book.name)}</strong><span>${escapeHtml(book.subtitle)}</span></span>
        <span class="book-toggle" aria-hidden="true">⌄</span>
      </button>
      <div class="book-entries">
        ${book.entries.filter((entry) => !entry.superseded).map((entry) => `
          <button class="memory-entry" type="button" data-memory="${escapeHtml(entry.id)}">
            <span class="memory-entry-copy"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.content)}</span></span>
            <span class="entry-status current">当前</span>
          </button>
        `).join("")}
        <div class="memory-book-actions">
          <button class="plain-button" type="button" data-memory-action="add-entry" data-book-id="${escapeHtml(book.id)}">新增条目</button>
          <button class="danger-button" type="button" data-memory-action="delete-book" data-book-id="${escapeHtml(book.id)}">删除记忆书</button>
        </div>
      </div>
    </section>
  `).join("");

  list.querySelectorAll(".memory-book-header").forEach((header) => header.addEventListener("click", () => {
    const book = memoryBooks.find((item) => item.id === header.parentElement.dataset.book);
    if (!book) return;
    book.open = !book.open;
    renderMemoryBooks();
  }));
  list.querySelectorAll(".memory-entry").forEach((entry) => entry.addEventListener("click", () => openMemory(entry.dataset.memory)));
  list.querySelectorAll('[data-memory-action="add-entry"]').forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openNewMemory(button.dataset.bookId);
  }));
  list.querySelectorAll('[data-memory-action="delete-book"]').forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteMemoryBook(button.dataset.bookId);
  }));
  setMemoryBusy(state.memoryBusy);
}

function findMemory(memoryId) {
  for (const book of memoryBooks) {
    const entry = book.entries.find((item) => item.id === memoryId);
    if (entry) return { book, entry };
  }
  return null;
}

function openMemory(memoryId) {
  if (state.memoryBusy) return;
  const result = findMemory(memoryId);
  if (!result) return;
  state.activeMemory = result;
  $("#modalBookLabel").textContent = result.book.name;
  $("#modalTitle").value = result.entry.title;
  $("#modalStatus").textContent = "当前";
  $("#modalSource").textContent = `来源：${result.entry.source}`;
  $("#modalCurrent").value = result.entry.content;
  $("#deleteMemoryButton").hidden = false;
  rememberDialogFocus("memoryModal");
  $("#memoryModal").hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => $("#modalCurrent")?.focus(), 30);
}

function openNewMemory(bookId) {
  if (state.memoryBusy) return;
  const book = memoryBooks.find((item) => item.id === bookId);
  if (!book) return;
  state.activeMemory = { book, entry: null };
  $("#modalBookLabel").textContent = book.name;
  $("#modalTitle").value = "";
  $("#modalStatus").textContent = "新建";
  $("#modalSource").textContent = `来源：${book.name}`;
  $("#modalCurrent").value = "";
  $("#deleteMemoryButton").hidden = true;
  rememberDialogFocus("memoryModal");
  $("#memoryModal").hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => $("#modalTitle")?.focus(), 30);
}

function closeModal(options = {}) {
  if (state.memoryBusy && options.force !== true) {
    showToast("记忆操作进行中，请稍候。");
    return;
  }
  $("#memoryModal").hidden = true;
  state.activeMemory = null;
  syncOverlayScrollLock();
  restoreDialogFocus("memoryModal");
}

function saveCorrection() {
  if (window.TASK21_LIVE && window.TASK21 && window.TASK21.saveCorrectionLive) {
    if (state.memoryBusy) { showToast("已有记忆操作正在进行，请稍候。"); return; }
    window.TASK21.saveCorrectionLive();
    return;
  }
  if (!state.activeMemory) return;
  const title = $("#modalTitle").value.trim();
  const content = $("#modalCurrent").value.trim();
  if (!title) { showToast("标题不能为空。"); $("#modalTitle")?.focus(); return; }
  if (!content) { showToast("请输入记忆内容。"); return; }
  if (!beginMemoryMutation("保存中…")) return;
  const { book, entry } = state.activeMemory;
  try {
    if (entry) {
      entry.title = title;
      entry.content = content;
      entry.superseded = false;
    } else {
      book.entries.push({ id: `${book.id}-${Date.now()}`, title, content, source: book.name });
    }
    renderMemoryBooks();
    closeModal({ force: true });
    showToast(entry ? "记忆已保存。" : "记忆条目已新增。");
  } finally {
    endMemoryMutation();
  }
}

function deleteMemory() {
  if (!state.activeMemory?.entry) return;
  const { book, entry } = state.activeMemory;
  if (!window.confirm(`删除记忆“${entry.title || "未命名记忆"}”？`)) return;
  if (window.TASK21_LIVE && window.TASK21?.deleteMemoryLive) {
    if (state.memoryBusy) { showToast("已有记忆操作正在进行，请稍候。"); return; }
    window.TASK21.deleteMemoryLive();
    return;
  }
  if (!beginMemoryMutation("删除中…")) return;
  try {
    book.entries = book.entries.filter((item) => item.id !== entry.id);
    renderMemoryBooks();
    closeModal({ force: true });
    showToast("记忆条目已删除。");
  } finally {
    endMemoryMutation();
  }
}

function createMemoryBook() {
  const name = window.prompt("请输入新的记忆书名称");
  const trimmed = name?.trim() || "";
  if (!trimmed) { if (name !== null) showToast("记忆书名称不能为空。"); return; }
  if (window.TASK21_LIVE && window.TASK21?.createMemoryBookLive) {
    if (state.memoryBusy) { showToast("已有记忆操作正在进行，请稍候。"); return; }
    window.TASK21.createMemoryBookLive(trimmed);
    return;
  }
  const duplicate = memoryBooks.some((book) => String(book.name || "").trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (duplicate) { showToast("记忆书名称已存在。"); return; }
  if (!beginMemoryMutation("新增中…")) return;
  const id = `book-${Date.now()}`;
  try {
    memoryBooks.push({ id, symbol: "✦", name: trimmed, subtitle: "0 条目", open: true, entries: [] });
    renderMemoryBooks();
    showToast("记忆书已新增。");
  } finally {
    endMemoryMutation();
  }
}

function deleteMemoryBook(bookId) {
  const book = memoryBooks.find((item) => item.id === bookId);
  if (!book || !window.confirm(`删除记忆书“${book.name}”？`)) return;
  if (window.TASK21_LIVE && window.TASK21?.deleteMemoryBookLive) {
    if (state.memoryBusy) { showToast("已有记忆操作正在进行，请稍候。"); return; }
    window.TASK21.deleteMemoryBookLive(bookId);
    return;
  }
  if (!beginMemoryMutation("删除中…")) return;
  try {
    memoryBooks.splice(memoryBooks.indexOf(book), 1);
    renderMemoryBooks();
    showToast("记忆书已删除。");
  } finally {
    endMemoryMutation();
  }
}

function setSidebarCollapsed(collapsed, options = {}) {
  state.sidebarCollapsed = !!collapsed;
  const shell = $("#appShell");
  if (!shell) return;
  shell.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  shell.classList.toggle("sidebar-open", !state.sidebarCollapsed);
  const sidebar = $(".archive-sidebar");
  if (sidebar) sidebar.setAttribute("aria-hidden", String(state.sidebarCollapsed));
  document.querySelectorAll('[data-action="toggle-sidebar"]').forEach((toggle) => {
    toggle.setAttribute("aria-label", state.sidebarCollapsed ? "打开左侧导航" : "收起左侧导航");
    toggle.setAttribute("title", state.sidebarCollapsed ? "打开左侧导航" : "收起左侧导航");
    toggle.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  });
  if (state.sidebarCollapsed) setUserMenuOpen(false, { restoreFocus: false });
  if (isMobileViewport()) {
    sidebar?.setAttribute("aria-hidden", String(!state.mobileDrawerOpen));
    updateMobileDrawerControls(state.mobileDrawerOpen);
  }
  if (!options.skipPersist) persistLayoutPreferences();
}

function applyLayoutWidths() {
  state.sidebarWidth = Math.max(layoutConfig.leftMin, Math.min(layoutConfig.leftMax, state.sidebarWidth));
  state.rightWidth = Math.max(layoutConfig.rightMin, Math.min(layoutConfig.rightMax, state.rightWidth));
  document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
  document.documentElement.style.setProperty("--right-width", `${state.rightWidth}px`);
}

function persistLayoutWidths() {
  persistLayoutPreferences();
}

function persistLayoutPreferences() {
  if (!state.user || !accountCore) return;
  state.preferences.harry.sidebarCollapsed = !!state.sidebarCollapsed;
  state.preferences.harry.sidebarWidth = Math.round(state.sidebarWidth);
  state.preferences.harry.memoryOpen = !!state.memoryPanelOpen;
  state.preferences.harry.memoryWidth = Math.round(state.rightWidth);
  const result = accountCore.writePreferences(window.localStorage, state.user.handle, state.preferences);
  state.preferences = result.preferences;
  if (!result.ok && !state.storageWarned) {
    state.storageWarned = true;
    showToast("偏好未能保存，但当前会话仍可使用");
  }
}

function setMemoryPanelOpen(open, options = {}) {
  const shouldOpen = !!open && window.innerWidth >= layoutConfig.utilityCloseWidth && !state.settingsOpen;
  state.memoryPanelOpen = shouldOpen;
  const shell = $("#appShell");
  shell?.classList.toggle("memory-panel-open", shouldOpen);
  $(".inspector-column")?.setAttribute("aria-hidden", String(!shouldOpen));
  document.querySelectorAll('[data-action="open-memories"]').forEach((button) => button.setAttribute("aria-expanded", String(shouldOpen)));
  if (!options.skipPersist) persistLayoutPreferences();
}

function closeUtilities() {
  setMemoryPanelOpen(false);
}

function openInspector(view) {
  state.inspector = view;
  if (view !== "memories") return;
  // 窄屏（手机）上没有右侧记忆栏 —— 它是 display:none，而且 setMemoryPanelOpen 里的
  // `innerWidth >= utilityCloseWidth` 在手机上永远为假，于是"点得到、但什么都没发生"
  // （用户 2026-09-12 实测：「记忆能点但是没有任何反应」）。这里改成打开**记忆弹层**。
  if (window.innerWidth < layoutConfig.utilityCloseWidth) {
    if (window.TASK21 && typeof window.TASK21.openMemoryPanel === "function") {
      window.TASK21.openMemoryPanel();
      return;
    }
    // 兜底：万一主流程还没挂上（启动早期/异常路径），至少把弹层直接打开，
    // 别让"点了没反应"再次发生 —— 用户 2026-09-12 连报两次。
    const modal = document.querySelector("#memoryPanel");
    if (modal) { modal.hidden = false; return; }
  }
  setMemoryPanelOpen(true);
}

function setUserMenuOpen(open, options = {}) {
  const menu = $("#userMenu");
  const button = $("#userIdentityButton");
  if (!menu || !button) return;
  state.userMenuOpen = !!open;
  menu.hidden = !state.userMenuOpen;
  button.setAttribute("aria-expanded", String(state.userMenuOpen));
  if (state.userMenuOpen) {
    state.settingsReturnFocus = button;
    window.setTimeout(() => menu.querySelector("[role=menuitem]")?.focus(), 30);
  } else if (options.restoreFocus !== false && document.activeElement !== button) {
    button.focus({ preventScroll: true });
  }
}

function setIdentityAvatar(model) {
  document.querySelectorAll(".identity-avatar").forEach((node) => {
    const avatar = model && model.avatar ? model.avatar.replace(/"/g, "%22") : "";
    node.style.backgroundImage = avatar ? `url("${avatar}")` : "";
    node.classList.toggle("has-avatar", !!avatar);
  });
}

// 称呼（preferences.nickname）：第一次引导里填，之后在设置 → 关于里改。
// 没设过时返回空串，界面退回档案显示名。
function currentNickname() {
  const value = state.preferences && state.preferences.nickname;
  return typeof value === "string" ? value.trim() : "";
}

function setNickname(value) {
  const clean = accountCore ? accountCore.nicknameValue(value) : String(value || "").trim();
  savePreference("nickname", clean);
  return clean;
}

function setUserIdentity(userOrModel) {
  const model = userOrModel && userOrModel.handle !== undefined
    ? userOrModel
    : (accountCore ? accountCore.identityModel(userOrModel) : { handle: "", displayName: "用户", roleLabel: "用户", isAdmin: false, avatar: "" });
  // 用户自己填的称呼优先于档案显示名 —— 角色就是这么叫他的。
  const safeName = currentNickname() || String(model.displayName || "用户").trim() || "用户";
  const handleLabel = model.handle ? `@${model.handle}` : "@未登录";
  ["#userDisplayName", "#menuUserName", "#settingsUserName"].forEach((selector) => {
    const node = $(selector);
    if (node) node.textContent = safeName;
  });
  ["#userStatus", "#menuUserHandle", "#settingsUserHandle"].forEach((selector) => {
    const node = $(selector);
    if (node) node.textContent = handleLabel;
  });
  ["#menuUserRole", "#settingsUserRole"].forEach((selector) => {
    const node = $(selector);
    if (node) node.textContent = model.roleLabel || (model.isAdmin ? "管理员" : "用户");
  });
  setIdentityAvatar(model);
}

function updateLocalDataControls() {
  const row = $("#generalAiDataRow");
  if (!row || !state.user || !accountCore) return;
  const target = accountCore.localDataTargets(window.localStorage, state.user.handle);
  row.hidden = !target.hasGeneralAi;
}

function persistAccountPreferences() {
  if (!state.user || !accountCore) return;
  const result = accountCore.writePreferences(window.localStorage, state.user.handle, state.preferences);
  state.preferences = result.preferences;
  if (!result.ok && !state.storageWarned) {
    state.storageWarned = true;
    showToast("偏好未能保存，但当前会话仍可使用");
  }
  updateLocalDataControls();
}

function setSettingsSection(section) {
  const allowed = accountCore && accountCore.ENUMS.lastSettingsSection.includes(section) ? section : "appearance";
  document.querySelectorAll("[data-settings-section]").forEach((item) => item.classList.toggle("is-active", item.dataset.settingsSection === allowed));
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.settingsPanel === allowed));
  if (isMobileViewport()) {
    document.querySelector(`[data-settings-section="${allowed}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (state.user && state.preferences.lastSettingsSection !== allowed) {
    state.preferences.lastSettingsSection = allowed;
    persistAccountPreferences();
  }
  if (allowed === "characters") refreshCharacterManagement();
}

function setUserContext(user) {
  if (!accountCore) return false;
  const model = accountCore.identityModel(user);
  if (!model.handle) return false;
  state.user = model;
  const loaded = accountCore.readPreferences(window.localStorage, model.handle, {
    prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  state.preferences = loaded.preferences;
  writeThemeAccountHint(model.handle);
  state.sidebarCollapsed = state.preferences.harry.sidebarCollapsed;
  state.sidebarWidth = state.preferences.harry.sidebarWidth;
  state.rightWidth = state.preferences.harry.memoryWidth;
  setUserIdentity(model);
  applyPreferences();
  applyLayoutWidths();
  setSidebarCollapsed(state.sidebarCollapsed, { skipPersist: true });
  setMemoryPanelOpen(state.preferences.harry.memoryOpen, { skipPersist: true });
  updateLocalDataControls();
  if (!loaded.storageAvailable && !state.storageWarned) {
    state.storageWarned = true;
    showToast("界面偏好未能保存，但当前会话仍可使用");
  }
  return true;
}

function openSettings() {
  const mobileReturnFocus = document.activeElement?.closest(".archive-sidebar") ? $("#sidebarToggle") : document.activeElement;
  state.settingsReturnFocus = isMobileViewport() ? mobileReturnFocus : ($("#userIdentityButton") || document.activeElement);
  setMobileDrawerOpen(false, { restoreFocus: false, focus: false });
  setUserMenuOpen(false, { restoreFocus: false });
  closeUtilities();
  state.settingsOpen = true;
  $("#appShell")?.classList.add("settings-open");
  $("#settingsSurface").hidden = false;
  $("#mainStage").setAttribute("aria-hidden", "true");
  $("#mainStage").inert = true;
  setSettingsSection(state.preferences.lastSettingsSection);
  $("#settingsSurface")?.querySelector(".settings-nav-item.is-active")?.focus();
}

function closeSettings() {
  state.settingsOpen = false;
  $("#appShell")?.classList.remove("settings-open");
  $("#settingsSurface").hidden = true;
  $("#mainStage").removeAttribute("aria-hidden");
  $("#mainStage").inert = false;
  const returnFocus = state.settingsReturnFocus;
  state.settingsReturnFocus = null;
  if (isRestorableFocusNode(returnFocus)) returnFocus.focus({ preventScroll: true });
  else if (isMobileViewport()) $("#sidebarToggle")?.focus({ preventScroll: true });
  updateMobileBottomNav("chat");
}

function applyPreferences() {
  const preferences = accountCore ? accountCore.normalizePreferences(state.preferences, {
    prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }) : state.preferences;
  state.preferences = preferences;
  const shell = $("#appShell");
  if (shell) shell.dataset.density = preferences.density;
  document.documentElement.dataset.motion = preferences.motion;
  document.documentElement.dataset.theme = preferences.theme;
  // 风格（配色）与秋季氛围：剧情模式页也在用同一份偏好，靠 tokens.css 一起生效。
  document.documentElement.dataset.style = preferences.style || "default";
  document.documentElement.classList.toggle("season-ambient-on", preferences.ambient === true);
  // 界面缩放：整体（正文+控件）一起缩放。
  // 实测这片页面会给 body 上的 zoom 忽略掉（连手设 2 都算回 1），所以加在 appShell 上。
  // 默认值 = 新基准 0.9（界面上的「100%」，见 zoom.js 的说明）。
  const DEFAULT_UI_SCALE = 0.9;
  const scale = Number(preferences.scale) || DEFAULT_UI_SCALE;
  document.documentElement.dataset.scale = String(scale);
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  const scaleTarget = $("#appShell");
  if (scaleTarget) {
    if (scale === 1) scaleTarget.style.removeProperty("zoom");
    else scaleTarget.style.zoom = String(scale);
  }
  if (state.user) document.documentElement.classList.remove("theme-pending");
  const themeSelect = $("#themeSelect");
  const densitySelect = $("#densitySelect");
  const motionSelect = $("#motionSelect");
  const sendModeSelect = $("#sendModeSelect");
  const scaleSelect = $("#scaleSelect");
  const styleSelect = $("#styleSelect");
  const ambientToggle = $("#ambientToggle");
  if (themeSelect) themeSelect.value = preferences.theme;
  if (densitySelect) densitySelect.value = preferences.density;
  if (motionSelect) motionSelect.value = preferences.motion;
  if (sendModeSelect) sendModeSelect.value = preferences.sendMode;
  if (scaleSelect) scaleSelect.value = String(scale);
  if (styleSelect) styleSelect.value = preferences.style || "default";
  if (ambientToggle) ambientToggle.checked = preferences.ambient === true;
  // 侧栏显示哪些角色来自偏好，而偏好是异步加载的 —— 每次应用完都重刷一次侧栏，
  // 否则用户已选好角色、侧栏却还停在"未设置"的引导状态。
  if (window.TASK21 && typeof window.TASK21.renderChatList === "function") window.TASK21.renderChatList();
  // 称呼也是偏好的一部分：设置里改完（或引导里填完）要立刻反映到界面上。
  if (state.user) setUserIdentity(state.user);
  const nicknameInput = $("#nicknameInput");
  if (nicknameInput && document.activeElement !== nicknameInput) nicknameInput.value = currentNickname();
}

function savePreference(key, value) {
  if (!accountCore) return;
  const next = Object.assign({}, state.preferences, { [key]: value });
  state.preferences = accountCore.normalizePreferences(next, {
    prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  applyPreferences();
  persistAccountPreferences();
}

function resetLayout() {
  if (!window.confirm("恢复默认布局？只会重置当前账户的面板状态和宽度。")) return;
  const defaults = defaultAccountPreferences();
  state.sidebarCollapsed = defaults.harry.sidebarCollapsed;
  state.sidebarWidth = defaults.harry.sidebarWidth;
  state.memoryPanelOpen = defaults.harry.memoryOpen;
  state.rightWidth = defaults.harry.memoryWidth;
  applyLayoutWidths();
  setSidebarCollapsed(false, { skipPersist: true });
  setMemoryPanelOpen(false, { skipPersist: true });
  persistLayoutPreferences();
  showToast("已恢复默认布局");
}

function resetPreferences() {
  if (!state.user || !accountCore) return;
  if (!window.confirm("重置当前账户的界面偏好？聊天不会被删除。")) return;
  accountCore.removePreferences(window.localStorage, state.user.handle);
  state.preferences = defaultAccountPreferences();
  state.sidebarCollapsed = false;
  state.sidebarWidth = state.preferences.harry.sidebarWidth;
  state.memoryPanelOpen = false;
  state.rightWidth = state.preferences.harry.memoryWidth;
  applyPreferences();
  applyLayoutWidths();
  setSidebarCollapsed(false, { skipPersist: true });
  setMemoryPanelOpen(false, { skipPersist: true });
  updateLocalDataControls();
  showToast("已重置当前账户的界面偏好");
}

function clearGeneralAiData() {
  if (!state.user || !accountCore) return;
  if (!window.confirm("清除当前账户的通用 AI 对话？Harry 对话不会受影响。")) return;
  const result = accountCore.clearGeneralAi(window.localStorage, state.user.handle);
  updateLocalDataControls();
  if (result.ok) showToast("已清除当前账户的通用 AI 对话");
}

// ---- Task-28A 账户管理（改名 / 改密 / 管理员账号列表） ----

function accountErrorMessage(error) {
  return accountCore ? accountCore.accountErrorLabel(error && error.status, error && error.code) : "操作失败，请重试。";
}

async function resolveAccountFailure(error) {
  // 本地版没有会话；保留统一错误处理，异常时刷新页面恢复本地状态。
  if (error && error.authRequired === true) {
    try {
      await window.STApi.getCurrentUser();
    } catch (meError) {
      if (window.STApi.isAuthRequired && window.STApi.isAuthRequired(meError)) {
        clearThemeAccountHint();
        window.location.reload();
        return "redirect";
      }
    }
  }
  return accountErrorMessage(error);
}

/* ---------- Task-31D：角色管理（设置区 + 侧边栏「角色」入口） ---------- */

// Task-34B：受保护内置角色（Harry、Tom 与三强争霸赛学年四角色）。优先使用固定 avatar 文件名，
// 不做名称模糊匹配、也不依赖列表顺序，避免把第一个自定义角色误判为内置。
const BUILTIN_PROTECTED_AVATARS = Object.freeze([
  "Harry Potter (EN).png",
  "Tom Riddle (Adult).png",
  "Ron Weasley (Triwizard Year).png",
  "Hermione Granger (Triwizard Year).png",
  "Ginny Weasley (Triwizard Year).png",
  "Luna Lovegood (Triwizard Year).png",
]);

function isProtectedBuiltinCharacter(card) {
  const avatar = String((card && card.avatar) || "");
  return BUILTIN_PROTECTED_AVATARS.includes(avatar);
}

// 兼容接口：保留给旧回归与可能的外部调用；语义等价于「Harry 为受保护内置角色」。
function isHarryMainCard(card) {
  return String((card && card.avatar) || "") === "Harry Potter (EN).png";
}

async function fetchCharacterCards() {
  const cards = await window.STApi.listCharacters();
  return (Array.isArray(cards) ? cards : []).filter((card) => card && card.avatar);
}

async function refreshCharacterManagement() {
  const list = $("#characterManageList");
  const empty = $("#characterManageEmpty");
  const count = $("#characterManageCount");
  if (!list || !window.STApi || typeof window.STApi.listCharacters !== "function") return;
  try {
    const cards = await fetchCharacterCards();
    // 每个角色那一行要显示"当前是什么语言"，所以先把设置读出来（读不到就全按"跟随设置"）。
    await loadLanguageSettings();
    renderCharacterManagement(cards);
    if (count) count.textContent = `${cards.length} 个角色`;
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") { if (list) list.textContent = ""; if (empty) { empty.textContent = label; empty.hidden = false; } }
  }
}

// ---- 侧栏角色选择 ----
// 侧栏显示哪些角色完全由用户决定：不自动挑、不按最近使用排序、不限制数量。
// preferences.sidebarCharacters === null 表示"从未设置"（引导用户去挑），
// 空数组表示"用户主动全部隐藏" —— 两者提示文案不同，绝不互相替代。

function isSidebarCharacter(avatar) {
  const chosen = state.preferences && state.preferences.sidebarCharacters;
  return Array.isArray(chosen) && chosen.indexOf(String(avatar || "")) >= 0;
}

function sidebarCharacterCount() {
  const chosen = state.preferences && state.preferences.sidebarCharacters;
  return Array.isArray(chosen) ? chosen.length : 0;
}

function setSidebarCharacter(avatar, visible) {
  const key = String(avatar || "");
  if (!key) return;
  const current = Array.isArray(state.preferences.sidebarCharacters)
    ? state.preferences.sidebarCharacters.slice()
    : [];
  const index = current.indexOf(key);
  if (visible === true && index < 0) current.push(key);
  if (visible !== true && index >= 0) current.splice(index, 1);
  savePreference("sidebarCharacters", current);
  updateCharacterManageHint();
  // 立刻刷新侧栏，不用退出设置再进来。
  if (window.TASK21 && typeof window.TASK21.renderChatList === "function") window.TASK21.renderChatList();
}

// ---- 角色语言（每个角色一个开关）----
// 默认"跟随设置"：按角色卡自己写的语言说话（内置英文卡说英文、中文卡说中文）。
// 单角色的覆盖存在设置的 language_by_card 里，和对话页顶栏那个下拉是同一份数据。
let languageSettings = { language_mode: "auto", language_by_card: {} };

async function loadLanguageSettings() {
  try {
    if (window.RoleWorld && typeof window.RoleWorld.getLocalSettings === "function") {
      const settings = await window.RoleWorld.getLocalSettings();
      languageSettings = {
        language_mode: settings.language_mode === "zh" || settings.language_mode === "en" ? settings.language_mode : "auto",
        language_by_card: Object.assign({}, settings.language_by_card || {}),
      };
    }
  } catch (_) { /* 读不到就都按"跟随设置"显示 */ }
  return languageSettings;
}

function characterLanguageValue(avatar) {
  const own = (languageSettings.language_by_card || {})[String(avatar || "")];
  return own === "zh" || own === "en" ? own : "auto";
}

async function setCharacterLanguage(avatar, value) {
  const key = String(avatar || "");
  if (!key || !window.RoleWorld) return;
  const next = Object.assign({}, languageSettings.language_by_card || {});
  // 选「跟随设置」就把这一项删掉（存成 "auto" 也算对，但留着空记录只会让数据变脏）。
  if (value === "zh" || value === "en") next[key] = value;
  else delete next[key];
  languageSettings = Object.assign({}, languageSettings, { language_by_card: next });
  await window.RoleWorld.saveLocalSettings({ language_by_card: next });
  // 对话页顶栏那个下拉与下一轮请求读的是同一份设置，广播一下让它立刻跟上。
  window.dispatchEvent(new CustomEvent("roleworld:settings-changed", { detail: { language_by_card: next } }));
}

/** 别处改了语言（顶栏下拉 /「设置 → 模型 → 角色语言」）之后，把这一列下拉同步过来。 */
function syncCharacterLanguageSelects() {
  document.querySelectorAll("[data-character-language]").forEach((node) => {
    node.value = characterLanguageValue(node.dataset.characterLanguage);
  });
}

function updateCharacterManageHint() {
  const node = $("#characterManageHint");
  if (!node) return;
  const chosen = state.preferences ? state.preferences.sidebarCharacters : null;
  node.hidden = false;
  if (chosen === null) {
    node.textContent = "侧栏还没有角色。打开下面任意一个开关，把想常驻侧栏的角色加进去 —— 顺序就是你打开的顺序。";
  } else if (!chosen.length) {
    node.textContent = "侧栏已清空（你隐藏了全部角色）。角色、对话和记忆都还在，打开开关就能加回侧栏。";
  } else {
    node.textContent = `侧栏显示 ${chosen.length} 个角色。关掉开关只是从侧栏移走，不会删除任何数据。`;
  }
}

function renderCharacterManagement(cards) {
  const list = $("#characterManageList");
  const empty = $("#characterManageEmpty");
  if (!list) return;
  list.textContent = "";
  const hint = document.createElement("p");
  hint.className = "character-manage-hint";
  hint.id = "characterManageHint";
  list.appendChild(hint);
  updateCharacterManageHint();
  if (!cards.length) { if (empty) { empty.textContent = "暂无角色"; empty.hidden = false; } return; }
  if (empty) empty.hidden = true;
  for (const card of cards) {
    const row = document.createElement("div");
    row.className = "character-manage-row";
    const copy = document.createElement("div");
    copy.className = "character-manage-copy";
    const head = document.createElement("div");
    head.className = "character-manage-head";
    if (card.avatar && typeof card.avatar === "string") {
      const img = document.createElement("img");
      img.className = "character-manage-avatar";
      // Task-33E: card.avatar is a bare filename (e.g. "Harry Potter (EN).png");
      // serve it from the per-user /characters/ route instead of resolving it
      // relative to /chat/ (which 404s and broke every character avatar).
      // 本地版：头像来自本机数据库的 blob URL；没有适配层时才回退到服务器路由。
      if (window.STApi && typeof window.STApi.assetUrlSync === "function") {
        const localUrl = window.STApi.assetUrlSync(card.avatar);
        if (localUrl) img.src = localUrl;
        else if (typeof window.STApi.assetUrl === "function") {
          window.STApi.assetUrl(card.avatar).then((url) => { if (url) img.src = url; }).catch(() => {});
        }
      } else {
        img.src = "/characters/" + encodeURIComponent(card.avatar);
      }
      img.alt = "";
      head.appendChild(img);
    }
    const name = document.createElement("strong");
    const isBuiltin = isProtectedBuiltinCharacter(card);
    name.textContent = card.name || card.avatar;
    head.appendChild(name);
    if (isBuiltin) {
      const badge = document.createElement("span");
      badge.className = "builtin-badge";
      badge.textContent = "内置角色";
      head.appendChild(badge);
    }
    copy.appendChild(head);
    const meta = document.createElement("span");
    meta.className = "character-manage-detail";
    // 不把文件名（"Harry Potter (EN).png"）当介绍显示 —— 那是内部标识，
    // 用户看到只会疑惑括号里的 (EN) 是什么（2026-09-12 用户就问了这件事）。
    meta.textContent = isBuiltin
      ? "内容包更新时会自动刷新，你的对话与记忆不受影响"
      : (card.avatar || "");
    meta.title = card.avatar || "";
    copy.appendChild(meta);
    row.appendChild(copy);
    const actions = document.createElement("div");
    actions.className = "character-manage-actions";
    // 语言开关：**每个角色一个**（2026-09-12 用户要求）。
    // 默认"跟随设置" = 按角色卡自己写的语言说话；也可以只给这一个角色改成一律中文/英文。
    const langWrap = document.createElement("label");
    langWrap.className = "character-manage-language";
    langWrap.title = "这个角色说什么语言。默认跟着角色卡自己写的语言；全局默认在「设置 → 模型 → 角色语言」。";
    const langLabel = document.createElement("span");
    langLabel.textContent = "语言";
    const langSelect = document.createElement("select");
    langSelect.dataset.characterLanguage = card.avatar;
    langSelect.setAttribute("aria-label", `${card.name || card.avatar} 说什么语言`);
    for (const [value, text] of [["auto", "跟随设置"], ["zh", "一律中文"], ["en", "一律英文"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      langSelect.appendChild(option);
    }
    langSelect.value = characterLanguageValue(card.avatar);
    langSelect.addEventListener("change", () => { setCharacterLanguage(card.avatar, langSelect.value).catch(() => {}); });
    langWrap.append(langLabel, langSelect);
    actions.appendChild(langWrap);
    // 侧栏开关：每个角色一个，状态本机持久化；关掉只影响侧栏展示。
    const sidebarToggle = document.createElement("label");
    sidebarToggle.className = "character-manage-sidebar";
    sidebarToggle.title = "是否把这个角色放进左侧栏";
    const sidebarBox = document.createElement("input");
    sidebarBox.type = "checkbox";
    sidebarBox.checked = isSidebarCharacter(card.avatar);
    sidebarBox.setAttribute("aria-label", `把 ${card.name || card.avatar} 显示在侧栏`);
    sidebarBox.addEventListener("change", () => setSidebarCharacter(card.avatar, sidebarBox.checked));
    const sidebarText = document.createElement("span");
    sidebarText.textContent = "显示在侧栏";
    sidebarToggle.append(sidebarBox, sidebarText);
    actions.appendChild(sidebarToggle);
    if (isBuiltin) {
      const note = document.createElement("span");
      note.className = "settings-value";
      note.textContent = "内置角色不可删除";
      actions.appendChild(note);
    } else {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger-button";
      del.textContent = "删除";
      del.dataset.avatar = card.avatar;
      del.addEventListener("click", () => confirmDeleteCharacter(card));
      actions.appendChild(del);
    }
    row.append(copy, actions);
    list.appendChild(row);
  }
}

async function confirmDeleteCharacter(card) {
  if (!card || !card.avatar) return;
  const avatar = String(card.avatar);
  const name = String(card.name || avatar);
  const confirmationWord = "删除";
  const typed = window.prompt(
    `永久删除角色「${name}」？此操作会同时删除该角色的全部聊天，不可恢复。\n\n文件：${avatar}\n\n请输入「${confirmationWord}」以确认：`,
    "",
  );
  if (typed === null) return;
  if (typed.trim() !== confirmationWord) { showToast("已取消：确认词不匹配"); return; }
  if (!window.STApi || typeof window.STApi.deleteCharacter !== "function") return;
  try {
    await window.STApi.deleteCharacter(avatar, true);
    showToast(`已删除角色「${name}」及其聊天`);
    // 通知集成层刷新角色注册表（若已加载）。
    if (window.TASK21 && typeof window.TASK21.refreshCharacterRegistryAfterDelete === "function") {
      window.TASK21.refreshCharacterRegistryAfterDelete();
    }
    await refreshCharacterManagement();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") showToast(label);
  }
}

function openCharacterAiCreate() {
  if (window.TASK21 && typeof window.TASK21.openAiCreateDialog === "function") window.TASK21.openAiCreateDialog();
  else showToast("角色创建暂不可用，请刷新后重试");
}

function openCharacterImport() {
  if (window.TASK21 && typeof window.TASK21.openFileImport === "function") window.TASK21.openFileImport();
  else showToast("角色导入暂不可用，请刷新后重试");
}

function bindSettings() {
  $("#themeSelect")?.addEventListener("change", (event) => savePreference("theme", event.target.value));
  $("#scaleSelect")?.addEventListener("change", (event) => savePreference("scale", event.target.value));
  $("#styleSelect")?.addEventListener("change", (event) => savePreference("style", event.target.value));
  $("#ambientToggle")?.addEventListener("change", (event) => savePreference("ambient", event.target.checked === true));
  $("#densitySelect")?.addEventListener("change", (event) => savePreference("density", event.target.value));
  $("#motionSelect")?.addEventListener("change", (event) => savePreference("motion", event.target.value));
  $("#sendModeSelect")?.addEventListener("change", (event) => savePreference("sendMode", event.target.value));
  // 称呼：失焦或回车时保存（输入过程中不打断）。
  const nicknameInput = $("#nicknameInput");
  if (nicknameInput) {
    const commit = () => {
      const next = setNickname(nicknameInput.value);
      nicknameInput.value = next;
      showToast(next ? `角色会称呼你「${next}」` : "已清空称呼，界面显示档案名");
    };
    nicknameInput.addEventListener("change", commit);
    nicknameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); nicknameInput.blur(); }
    });
  }
  $("#resetLayoutButton")?.addEventListener("click", resetLayout);
  $("#resetPreferencesButton")?.addEventListener("click", resetPreferences);
  $("#clearGeneralAiButton")?.addEventListener("click", clearGeneralAiData);
  $("#archivedChatSearch")?.addEventListener("input", (event) => window.TASK21?.setArchivedChatSearch?.(event.target.value));
  document.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => setSettingsSection(button.dataset.settingsSection)));
}

function bindPanelResizer(handle, side) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? state.sidebarWidth : state.rightWidth;
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* synthetic pointer */ }
    handle.classList.add("is-dragging");
    document.body.classList.add("is-resizing");

    const move = (moveEvent) => {
      if (side === "left") {
        const rawWidth = startWidth + (moveEvent.clientX - startX) / (Number(document.documentElement.dataset.scale) || 1);
        if (rawWidth <= layoutConfig.leftMin - layoutConfig.leftCollapseDistance) {
          setSidebarCollapsed(true, { skipPersist: true });
          return;
        }
        if (state.sidebarCollapsed) setSidebarCollapsed(false, { skipPersist: true });
        state.sidebarWidth = Math.max(layoutConfig.leftMin, Math.min(layoutConfig.leftMax, rawWidth));
      } else {
        const rawWidth = startWidth - (moveEvent.clientX - startX) / (Number(document.documentElement.dataset.scale) || 1);
        state.rightWidth = Math.max(layoutConfig.rightMin, Math.min(layoutConfig.rightMax, rawWidth));
      }
      applyLayoutWidths();
    };
    const end = () => {
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      persistLayoutWidths();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });

  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 16 : -16;
    if (side === "left") {
      state.sidebarWidth = Math.max(layoutConfig.leftMin, Math.min(layoutConfig.leftMax, state.sidebarWidth + delta));
      setSidebarCollapsed(false);
    } else {
      state.rightWidth = Math.max(layoutConfig.rightMin, Math.min(layoutConfig.rightMax, state.rightWidth - delta));
    }
    applyLayoutWidths();
    persistLayoutWidths();
  });
}

function bindInertialScroll(element) {
  if (!element) return;
  let velocity = 0;
  let frame = 0;
  const animate = () => {
    velocity *= .84;
    element.scrollTop += velocity;
    if (Math.abs(velocity) > .35) frame = window.requestAnimationFrame(animate);
    else frame = 0;
  };
  element.addEventListener("wheel", (event) => {
    if (document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault();
    velocity = Math.max(-72, Math.min(72, velocity + event.deltaY * .24));
    if (!frame) frame = window.requestAnimationFrame(animate);
  }, { passive: false });
}

function renderAssistantBody(text) {
  const live = !!window.TASK21_LIVE;
  // 流式或中途停止时，正文里可能留着没写完的 [[记住: —— 它不是正文，不该显示出来。
  const safeText = window.TASK22_CORE && typeof window.TASK22_CORE.stripPartialMemoryMarkers === "function"
    ? window.TASK22_CORE.stripPartialMemoryMarkers(text)
    : text;
  if (!live) return `<div class="message-bubble assistant-bubble"><p>${escapeHtml(safeText)}</p></div>`;
  const segments = window.TASK22_CORE ? window.TASK22_CORE.splitReply(safeText) : [{ type: "narration", text: safeText }];
  return segments.map((segment) => segment.type === "dialogue"
    ? `<div class="message-bubble assistant-bubble"><p>${escapeHtml(segment.text)}</p></div>`
    : `<div class="narration-line">${escapeHtml(segment.text)}</div>`).join("");
}

function addMessage(text, role) {
  const container = $("#dynamicMessages");
  if (!container) return;
  if (role === "user") {
    container.insertAdjacentHTML("beforeend", `
      <article class="message-row message-row-user">
        <div class="message-stack">
          <div class="message-meta message-meta-user"><strong>你</strong></div>
          <div class="message-bubble user-bubble"><p>${escapeHtml(text)}</p></div>
        </div>
      </article>`);
  } else {
    container.insertAdjacentHTML("beforeend", `
      <article class="message-row message-row-assistant">
        <div class="message-avatar assistant-avatar" aria-label="Harry Potter" role="img"></div>
        <div class="message-stack">
          <div class="message-meta"><strong>Harry Potter</strong></div>
          <div class="assistant-body">${renderAssistantBody(text)}</div>
        </div>
      </article>`);
  }
  const scroll = $("#chatScroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function setWaiting(waiting) {
  const note = $("#typingNote");
  if (note) note.hidden = !waiting;
  const initialMessage = document.querySelector(".initial-assistant-message");
  const dynamicMessages = $("#dynamicMessages");
  if (initialMessage) {
    initialMessage.hidden = !!window.TASK21_LIVE || !!waiting || !!(dynamicMessages && dynamicMessages.children.length);
  }
}

function sendDemoMessage() {
  if (window.TASK21_LIVE && window.TASK21 && window.TASK21.sendLive) {
    if (window.TASK21.isLiveBusy?.()) { window.TASK21.stopLive(); return; }
    window.TASK21.sendLive();
    return;
  }
  showToast("暂时无法回复，请重试");
}

function setPrimaryNavActive(view) {
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));
  if (view === "chat" || view === "characters") updateMobileBottomNav(view);
}

function openMobileView(view) {
  setMobileDrawerOpen(false, { restoreFocus: false, focus: false });
  if (view === "characters") {
    openCharacterManagement();
    return;
  }
  if (view === "account") {
    openSettings();
    // 手机底部导航的「我的」= 关于页（以前写的是 "account"，不在分区表里，
    // setSettingsSection 会悄悄退回"外观"，用户点「我的」看到的是外观设置）。
    setSettingsSection("about");
    updateMobileBottomNav("account");
    return;
  }
  if (state.settingsOpen) closeSettings();
  closeUtilities();
  setPrimaryNavActive("chat");
}

function bindNavigation() {
  document.querySelectorAll(".nav-item[data-view], .character-library-button[data-view], .sidebar-manage-characters[data-view]").forEach((button) => button.addEventListener("click", () => {
    const view = button.dataset.view;
    setPrimaryNavActive(view);
    if (view === "memories") openInspector("memories");
    if (view === "characters") openCharacterManagement();
    if (view === "chat") closeUtilities();
    if (isMobileViewport()) setMobileDrawerOpen(false, { restoreFocus: false, focus: false });
  }));
}

// Task-31D：侧边栏「角色」入口 → 打开设置的角色管理区。
function openCharacterManagement() {
  closeUtilities();
  openSettings();
  setSettingsSection("characters");
  setPrimaryNavActive("characters");
}

function handleAction(action, node) {
  if (action === "close-modal") closeModal();
  if (action === "close-mobile-drawer") setMobileDrawerOpen(false);
  if (action === "toggle-sidebar") {
    if (isMobileViewport()) setMobileDrawerOpen(!state.mobileDrawerOpen);
    else setSidebarCollapsed(!state.sidebarCollapsed);
  }
  if (action === "mobile-view-chat") openMobileView("chat");
  if (action === "mobile-view-characters") openMobileView("characters");
  if (action === "mobile-view-account") openMobileView("account");
  if (action === "open-memories") openInspector("memories");
  if (action === "close-memories") setMemoryPanelOpen(false);
  if (action === "toggle-user-menu") setUserMenuOpen(!state.userMenuOpen);
  if (action === "open-settings") openSettings();
  if (action === "close-settings") closeSettings();
  if (action === "new-conversation" && window.TASK21?.createNewConversation) window.TASK21.createNewConversation();
  if (action === "select-chat" && window.TASK21?.selectChat) window.TASK21.selectChat(node?.dataset.chatId || "");
  if (action === "archive-chat" && window.TASK21?.archiveChat) window.TASK21.archiveChat(node?.dataset.chatId || "");
  if (action === "restore-chat" && window.TASK21?.restoreChat) window.TASK21.restoreChat(node?.dataset.chatId || "");
  if (action === "delete-chat" && window.TASK21?.deleteChat) window.TASK21.deleteChat(node?.dataset.chatId || "");
  if (action === "retry-chat-list" && window.TASK21?.retryChatList) window.TASK21.retryChatList();
  if (action === "stop-generation" && window.TASK21?.stopLive) window.TASK21.stopLive();
  if (action === "character-ai-create") openCharacterAiCreate();
  if (action === "character-import") openCharacterImport();
  if (action === "character-refresh") refreshCharacterManagement();
}

document.addEventListener("click", (event) => {
  const actionNode = event.target.closest("[data-action]");
  if (actionNode) handleAction(actionNode.dataset.action, actionNode);
  if (state.userMenuOpen && !event.target.closest("#userMenu, #userIdentityButton")) setUserMenuOpen(false);
});

$("#saveCorrection")?.addEventListener("click", saveCorrection);
$("#deleteMemoryButton")?.addEventListener("click", deleteMemory);
$("#newMemoryBookButton")?.addEventListener("click", createMemoryBook);
$("#memoryModal")?.addEventListener("click", (event) => { if (event.target.id === "memoryModal") closeModal(); });
$("#sendButton")?.addEventListener("click", sendDemoMessage);
$("#stopButton")?.addEventListener("click", () => window.TASK21?.stopLive?.());
$("#messageInput")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (state.preferences.sendMode === "ctrl-enter") {
    if (event.ctrlKey && !event.shiftKey) { event.preventDefault(); sendDemoMessage(); }
    return;
  }
  if (!event.shiftKey && !event.ctrlKey) { event.preventDefault(); sendDemoMessage(); }
});
$("#messageInput")?.addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
});
$("#messageInput")?.addEventListener("focus", () => {
  updateVisualViewportMetrics();
  if (!isMobileViewport()) return;
  window.setTimeout(() => $("#messageInput")?.scrollIntoView({ block: "nearest", inline: "nearest" }), 50);
});

document.addEventListener("keydown", (event) => {
  const activeDialog = document.querySelector(".modal-backdrop:not([hidden]) [role='dialog'], .confirm-backdrop:not([hidden]) [role='dialog']");
  if (activeDialog && event.key === "Tab") {
    trapDialogTab(event, activeDialog);
    return;
  }
  if (event.key !== "Escape") return;
  if (activeDialog && activeDialog.closest("#aiCreateDialog") && window.TASK21?.closeAiCreateDialog) {
    event.preventDefault();
    window.TASK21.closeAiCreateDialog();
    return;
  }
  if (window.TASK21?.isLiveBusy?.()) {
    event.preventDefault();
    window.TASK21.stopLive?.();
    return;
  }
  if (!$("#memoryModal").hidden) closeModal();
  else if (state.userMenuOpen) setUserMenuOpen(false);
  else if (state.settingsOpen) closeSettings();
  else if (state.memoryPanelOpen) closeUtilities();
});

renderMemoryBooks();
bindNavigation();
bindSettings();
applyLayoutWidths();
applyPreferences();
setSidebarCollapsed(state.sidebarCollapsed, { skipPersist: true });
setMemoryPanelOpen(false, { skipPersist: true });
bindPanelResizer($("#leftResizeHandle"), "left");
bindPanelResizer($("#rightResizeHandle"), "right");
bindInertialScroll($("#chatScroll"));
bindInertialScroll($("#memoryView"));
setEngine("A");

function enforceResponsiveLayout() {
  // Task-31D：记忆面板暂隐藏 —— 只允许在窄屏时关闭，不再按偏好自动展开；数据不受影响。
  if (window.innerWidth < layoutConfig.utilityCloseWidth) setMemoryPanelOpen(false, { skipPersist: true });
}
window.addEventListener("resize", enforceResponsiveLayout);
window.addEventListener("orientationchange", syncMobileViewport, { passive: true });
window.visualViewport?.addEventListener("resize", updateVisualViewportMetrics, { passive: true });
window.visualViewport?.addEventListener("scroll", updateVisualViewportMetrics, { passive: true });
const mobileMediaQuery = typeof window.matchMedia === "function" ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`) : null;
mobileMediaQuery?.addEventListener?.("change", syncMobileViewport);
enforceResponsiveLayout();
syncMobileViewport();
updateMobileBottomNav("chat");

const previewWaiting = new URLSearchParams(window.location.search).get("preview") === "waiting";
if (previewWaiting) setWaiting(true);

// Ctrl/⌘ + - / = / 0 改的是同一份偏好（见 zoom.js），这里把设置里的下拉同步过来。
window.addEventListener("roleworld:scale-changed", (event) => {
  const scale = event && event.detail ? String(event.detail.scale) : "";
  if (!scale) return;
  state.preferences = Object.assign({}, state.preferences, { scale });
  const select = $("#scaleSelect");
  if (select) select.value = scale;
});

// 首次引导里填的称呼：引导自己写偏好，这里只需要把界面刷一遍。
window.addEventListener("roleworld:nickname-changed", (event) => {
  const value = event && event.detail ? event.detail.nickname : "";
  if (value && accountCore) state.preferences = Object.assign({}, state.preferences, { nickname: accountCore.nicknameValue(value) });
  applyPreferences();
});

// 语言设置在别处改了（对话页顶栏 /「设置 → 模型」）：「角色管理」里那一列下拉要同步。
window.addEventListener("roleworld:settings-changed", () => {
  loadLanguageSettings().then(syncCharacterLanguageSelects).catch(() => {});
});

window.TASK25C_UI = {
  layoutConfig,
  // 外观偏好写入口：返校季信件（seasonal-surprise.js）要在用户点「保留」时
  // 真正落盘，否则它只改了 DOM，下一次 applyPreferences 就会把金色抹掉。
  savePreference,
  setSidebarCollapsed,
  setMemoryPanelOpen,
  setWaiting,
  setMemoryBusy,
  clearThemeAccountHint,
  setUserContext,
  setUserIdentity,
  openSettings,
  closeSettings,
  setSettingsSection,
  isSidebarCharacter,
  setSidebarCharacter,
  sidebarCharacterCount,
  nickname: currentNickname,
  setNickname,
  rememberDialogFocus,
  restoreDialogFocus,
  syncOverlayScrollLock,
  updateVisualViewportMetrics,
};
