"use strict";

const memoryBooks = [
  {
    id: "role-lock", symbol: "◇", name: "角色锁定书", subtitle: "共享 · 常量记忆", open: true,
    entries: [
      { id: "role-01", title: "当前身份", content: "Harry 仍是霍格沃茨五年级学生，属于 Gryffindor。", source: "角色档案" },
      { id: "role-02", title: "关系边界", content: "关系需要通过当前会话自然发展。", source: "角色档案" },
    ],
  },
  {
    id: "scene", symbol: "○", name: "场景记忆", subtitle: "关键词激活", open: true,
    entries: [
      { id: "scene-01", title: "旧教室会面", content: "两人在旧教室谈起借扫帚的事。", source: "记忆书 · 场景" },
    ],
  },
  {
    id: "facts", symbol: "□", name: "精确事实", subtitle: "关键词激活", open: false,
    entries: [
      { id: "fact-01", title: "借用扫帚", content: "扫帚会在使用后归还。", source: "记忆书 · 事实" },
    ],
  },
  {
    id: "relations", symbol: "△", name: "关系记录", subtitle: "持续记录", open: false,
    entries: [
      { id: "relation-01", title: "昵称与状态", content: "关系状态随新会话修订。", source: "记忆书 · 关系" },
    ],
  },
];

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
  logoutOpen: false,
  logoutPending: false,
  memoryBusy: false,
  renameOpen: false,
  renamePending: false,
  passwordOpen: false,
  passwordPending: false,
  passwordMode: "self",
  passwordTarget: "",
  adminDeleteOpen: false,
  adminDeletePending: false,
  adminDeleteTarget: "",
  selfDeleteOpen: false,
  selfDeletePending: false,
  selfDeleteHandle: "",
  adminCreateOpen: false,
  adminCreatePending: false,
  adminUsers: [],
  adminUsersLoaded: false,
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
  const overlayIds = ["memoryModal", "aiCreateDialog", "logoutDialog", "renameDialog", "passwordDialog", "adminDeleteDialog", "selfDeleteDialog", "adminCreateDialog"];
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

function renderMemoryBooks() {
  const list = $("#memoryList");
  if (!list) return;
  list.innerHTML = memoryBooks.map((book) => `
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
  if (view === "memories") setMemoryPanelOpen(true);
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

function setUserIdentity(userOrModel) {
  const model = userOrModel && userOrModel.handle !== undefined
    ? userOrModel
    : (accountCore ? accountCore.identityModel(userOrModel) : { handle: "", displayName: "用户", roleLabel: "用户", isAdmin: false, avatar: "" });
  const safeName = String(model.displayName || "用户").trim() || "用户";
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

function setAdminMenuVisible(isAdmin) {
  document.querySelectorAll("[data-admin-only]").forEach((node) => { node.hidden = !isAdmin; });
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
  let allowed = accountCore && accountCore.ENUMS.lastSettingsSection.includes(section) ? section : "appearance";
  if (allowed === "admin-users" && !(state.user && state.user.isAdmin)) allowed = "appearance";
  document.querySelectorAll("[data-settings-section]").forEach((item) => item.classList.toggle("is-active", item.dataset.settingsSection === allowed));
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.settingsPanel === allowed));
  if (isMobileViewport()) {
    document.querySelector(`[data-settings-section="${allowed}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (state.user && state.preferences.lastSettingsSection !== allowed) {
    state.preferences.lastSettingsSection = allowed;
    persistAccountPreferences();
  }
  if (allowed === "admin-users" && state.user && state.user.isAdmin) refreshAdminUsers();
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
  setAdminMenuVisible(model.isAdmin);
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
  const scale = Number(preferences.scale) || 1;
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
  // 401/403 先验证会话是否真的失效；真的失效则跳转登录，否则按文案提示。
  if (error && error.authRequired === true) {
    try {
      await window.STApi.getCurrentUser();
    } catch (meError) {
      if (window.STApi.isAuthRequired && window.STApi.isAuthRequired(meError)) {
        clearThemeAccountHint();
        window.location.replace(routes.productLoginUrl() + "?noauto=true");
        return "redirect";
      }
    }
  }
  return accountErrorMessage(error);
}

function closeRenameDialog() {
  if (state.renamePending) return;
  state.renameOpen = false;
  $("#renameDialog").hidden = true;
  syncOverlayScrollLock();
  restoreDialogFocus("renameDialog");
}

function openRenameDialog() {
  if (!state.user || !state.user.handle) return;
  setUserMenuOpen(false, { restoreFocus: false });
  $("#renameError").hidden = true;
  $("#renameInput").value = state.user.displayName || "";
  rememberDialogFocus("renameDialog");
  state.renameOpen = true;
  $("#renameDialog").hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => $("#renameInput")?.focus(), 30);
}

async function confirmRename() {
  if (state.renamePending || !state.user) return;
  const input = $("#renameInput");
  const name = String(input?.value || "").trim();
  const errorNode = $("#renameError");
  if (!name) { errorNode.textContent = "显示名不能为空。"; errorNode.hidden = false; input?.focus(); return; }
  if (name === state.user.displayName) { closeRenameDialog(); return; }
  state.renamePending = true;
  const button = $("#confirmRenameButton");
  errorNode.hidden = true;
  if (button) { button.disabled = true; button.textContent = "保存中…"; }
  try {
    await window.STApi.changeName(state.user.handle, name);
    state.user = Object.assign({}, state.user, { name, displayName: name });
    setUserIdentity(state.user);
    closeRenameDialog();
    showToast("显示名已修改");
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") { errorNode.textContent = label; errorNode.hidden = false; }
  } finally {
    state.renamePending = false;
    if (button) { button.disabled = false; button.textContent = "保存"; }
  }
}

function closePasswordDialog() {
  if (state.passwordPending) return;
  state.passwordOpen = false;
  $("#passwordDialog").hidden = true;
  syncOverlayScrollLock();
  restoreDialogFocus("passwordDialog");
}

function openPasswordDialog(mode, targetHandle) {
  const dialog = $("#passwordDialog");
  if (!dialog) return;
  setUserMenuOpen(false, { restoreFocus: false });
  const isReset = mode === "reset";
  state.passwordMode = isReset ? "reset" : "self";
  state.passwordTarget = isReset ? String(targetHandle || "") : (state.user?.handle || "");
  $("#oldPasswordField").hidden = isReset;
  $("#passwordDialogTitle").textContent = isReset ? "重置密码" : "修改密钥";
  $("#passwordDialogDescription").textContent = isReset
    ? `为账户 @${state.passwordTarget} 设置新密钥。`
    : "输入当前密钥后设置新密钥。";
  ["#oldPasswordInput", "#newPasswordInput", "#confirmPasswordInput"].forEach((selector) => { const node = $(selector); if (node) node.value = ""; });
  $("#passwordError").hidden = true;
  rememberDialogFocus("passwordDialog");
  state.passwordOpen = true;
  dialog.hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => (isReset ? $("#newPasswordInput") : $("#oldPasswordInput"))?.focus(), 30);
}

async function confirmPassword() {
  if (state.passwordPending) return;
  const isReset = state.passwordMode === "reset";
  const target = state.passwordTarget;
  const oldPassword = $("#oldPasswordInput")?.value || "";
  const newPassword = $("#newPasswordInput")?.value || "";
  const confirm = $("#confirmPasswordInput")?.value || "";
  const errorNode = $("#passwordError");
  if (!isReset && !oldPassword) { errorNode.textContent = "请输入当前密钥。"; errorNode.hidden = false; return; }
  if (!newPassword) { errorNode.textContent = "请输入新密钥。"; errorNode.hidden = false; return; }
  if (newPassword !== confirm) { errorNode.textContent = "两次输入的新密钥不一致。"; errorNode.hidden = false; return; }
  state.passwordPending = true;
  const button = $("#confirmPasswordButton");
  errorNode.hidden = true;
  if (button) { button.disabled = true; button.textContent = "保存中…"; }
  try {
    await window.STApi.changePassword(target, isReset ? "" : oldPassword, newPassword);
    closePasswordDialog();
    showToast(isReset ? `已重置 @${target} 的密码` : "密钥已修改");
    if (isReset) refreshAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") { errorNode.textContent = label; errorNode.hidden = false; }
  } finally {
    state.passwordPending = false;
    if (button) { button.disabled = false; button.textContent = "保存"; }
  }
}

function closeAdminDeleteDialog() {
  if (state.adminDeletePending) return;
  state.adminDeleteOpen = false;
  state.adminDeleteTarget = "";
  $("#adminDeleteDialog").hidden = true;
  syncOverlayScrollLock();
  restoreDialogFocus("adminDeleteDialog");
}

function openAdminDeleteDialog(handle) {
  state.adminDeleteTarget = String(handle || "");
  $("#adminDeleteDialogTitle").textContent = "删除账户";
  $("#adminDeleteDialogDescription").textContent = `删除后账户 @${state.adminDeleteTarget} 及其数据不可恢复。请输入账户名 ${state.adminDeleteTarget} 以确认。`;
  $("#adminDeleteInput").value = "";
  $("#adminDeleteError").hidden = true;
  $("#confirmAdminDeleteButton").disabled = true;
  rememberDialogFocus("adminDeleteDialog");
  state.adminDeleteOpen = true;
  $("#adminDeleteDialog").hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => $("#adminDeleteInput")?.focus(), 30);
}

function adminDeleteInputChanged() {
  const input = $("#adminDeleteInput");
  const button = $("#confirmAdminDeleteButton");
  if (input && button) button.disabled = String(input.value || "").trim() !== state.adminDeleteTarget;
}

async function confirmAdminDelete() {
  if (state.adminDeletePending || !state.adminDeleteTarget) return;
  const input = $("#adminDeleteInput");
  const errorNode = $("#adminDeleteError");
  if (!input || String(input.value || "").trim() !== state.adminDeleteTarget) {
    errorNode.textContent = "账户名不匹配，删除已取消。";
    errorNode.hidden = false;
    return;
  }
  state.adminDeletePending = true;
  const button = $("#confirmAdminDeleteButton");
  errorNode.hidden = true;
  if (button) { button.disabled = true; button.textContent = "删除中…"; }
  try {
    await window.STApi.deleteUser(state.adminDeleteTarget, true);
    const deleted = state.adminDeleteTarget;
    closeAdminDeleteDialog();
    showToast(`已删除 @${deleted}`);
    await refreshAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") { errorNode.textContent = label; errorNode.hidden = false; }
  } finally {
    state.adminDeletePending = false;
    if (button) { button.disabled = false; button.textContent = "删除"; }
    adminDeleteInputChanged();
  }
}

function closeSelfDeleteDialog() {
  if (state.selfDeletePending) return;
  state.selfDeleteOpen = false;
  state.selfDeleteHandle = "";
  $("#selfDeleteDialog").hidden = true;
  syncOverlayScrollLock();
  restoreDialogFocus("selfDeleteDialog");
}

function openSelfDeleteDialog() {
  const handle = state.user?.handle || "";
  if (!handle || !window.STApi || typeof window.STApi.deleteSelf !== "function") return;
  state.selfDeleteHandle = handle;
  $("#selfDeleteDialogDescription").textContent = `将永久删除账户 @${handle} 及其角色卡、会话与 Memory Books，不可恢复。请输入账户名 ${handle} 以确认。`;
  $("#selfDeletePasswordInput").value = "";
  $("#selfDeleteInput").value = "";
  $("#selfDeleteError").hidden = true;
  $("#confirmSelfDeleteButton").disabled = true;
  rememberDialogFocus("selfDeleteDialog");
  state.selfDeleteOpen = true;
  $("#selfDeleteDialog").hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => $("#selfDeletePasswordInput")?.focus(), 30);
}

function selfDeleteInputChanged() {
  const input = $("#selfDeleteInput");
  const button = $("#confirmSelfDeleteButton");
  if (input && button) button.disabled = String(input.value || "").trim() !== state.selfDeleteHandle;
}

async function confirmSelfDelete() {
  if (state.selfDeletePending || !state.selfDeleteHandle) return;
  const input = $("#selfDeleteInput");
  const passwordInput = $("#selfDeletePasswordInput");
  const errorNode = $("#selfDeleteError");
  if (!input || String(input.value || "").trim() !== state.selfDeleteHandle) {
    errorNode.textContent = "账户名不匹配，注销已取消。";
    errorNode.hidden = false;
    return;
  }
  state.selfDeletePending = true;
  const button = $("#confirmSelfDeleteButton");
  errorNode.hidden = true;
  if (button) { button.disabled = true; button.textContent = "注销中…"; }
  try {
    const password = passwordInput ? passwordInput.value : "";
    await window.STApi.deleteSelf(password, true);
    // 成功后清除本地偏好与通用 AI 会话，再跳到登录页。
    if (state.user && accountCore) {
      accountCore.removePreferences(window.localStorage, state.user.handle);
      accountCore.clearGeneralAi(window.localStorage, state.user.handle);
    }
    clearThemeAccountHint();
    state.user = null;
    if (window.STApi) window.STApi._token = null;
    window.location.replace(routes.productLoginUrl() + "?noauto=true");
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") { errorNode.textContent = label; errorNode.hidden = false; }
  } finally {
    state.selfDeletePending = false;
    if (button) { button.disabled = false; button.textContent = "永久注销"; }
    selfDeleteInputChanged();
  }
}

function closeAdminCreateDialog() {
  if (state.adminCreatePending) return;
  state.adminCreateOpen = false;
  $("#adminCreateDialog").hidden = true;
  syncOverlayScrollLock();
  restoreDialogFocus("adminCreateDialog");
}

function openAdminCreateDialog() {
  if (!state.user || !state.user.isAdmin || !window.STApi || typeof window.STApi.createUser !== "function") return;
  $("#adminCreateHandleInput").value = "";
  $("#adminCreateNameInput").value = "";
  $("#adminCreatePasswordInput").value = "";
  $("#adminCreateAdminCheck").checked = false;
  $("#adminCreateError").hidden = true;
  rememberDialogFocus("adminCreateDialog");
  state.adminCreateOpen = true;
  $("#adminCreateDialog").hidden = false;
  syncOverlayScrollLock();
  window.setTimeout(() => $("#adminCreateHandleInput")?.focus(), 30);
}

async function confirmAdminCreate() {
  if (state.adminCreatePending) return;
  const handleInput = $("#adminCreateHandleInput");
  const nameInput = $("#adminCreateNameInput");
  const passwordInput = $("#adminCreatePasswordInput");
  const adminCheck = $("#adminCreateAdminCheck");
  const errorNode = $("#adminCreateError");
  const handle = handleInput ? String(handleInput.value || "").trim() : "";
  const name = nameInput ? String(nameInput.value || "").trim() : "";
  const password = passwordInput ? String(passwordInput.value || "") : "";
  if (!handle) {
    errorNode.textContent = "请填写档案名。";
    errorNode.hidden = false;
    return;
  }
  state.adminCreatePending = true;
  const button = $("#confirmAdminCreateButton");
  errorNode.hidden = true;
  if (button) { button.disabled = true; button.textContent = "创建中…"; }
  try {
    await window.STApi.createUser(handle, name, password, adminCheck ? adminCheck.checked : false);
    closeAdminCreateDialog();
    showToast(`已创建 @${handle}`);
    await refreshAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") { errorNode.textContent = label; errorNode.hidden = false; }
  } finally {
    state.adminCreatePending = false;
    if (button) { button.disabled = false; button.textContent = "创建"; }
  }
}

async function refreshAdminUsers() {
  if (!state.user || !state.user.isAdmin || !window.STApi || typeof window.STApi.listUsers !== "function") return;
  const list = $("#adminUsersList");
  const empty = $("#adminUsersEmpty");  try {
    const users = await window.STApi.listUsers();
    state.adminUsers = Array.isArray(users) ? users : [];
    state.adminUsersLoaded = true;
    renderAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") {
      if (list) list.textContent = "";
      if (empty) { empty.textContent = label; empty.hidden = false; }
    }
  }
}

function renderAdminUsers() {
  const list = $("#adminUsersList");
  const empty = $("#adminUsersEmpty");
  const count = $("#adminUsersCount");
  if (!list) return;
  list.textContent = "";
  if (count) count.textContent = `${state.adminUsers.length} 个账户`;
  if (!state.adminUsers.length) { if (empty) { empty.textContent = "暂无账户"; empty.hidden = false; } return; }
  if (empty) empty.hidden = true;
  const selfHandle = state.user?.handle;
  for (const user of state.adminUsers) {
    const row = document.createElement("div");
    row.className = "admin-user-row";
    const isSelf = user.handle === selfHandle;
    // 头像缩略图（若有，仅用于展示；无则跳过）
    const copy = document.createElement("div");
    copy.className = "admin-user-copy";
    const head = document.createElement("div");
    head.className = "admin-user-head";
    if (user.avatar && typeof user.avatar === "string") {
      const avatarImg = document.createElement("img");
      avatarImg.className = "admin-user-avatar";
      avatarImg.src = user.avatar;
      avatarImg.alt = "";
      head.appendChild(avatarImg);
    }
    const name = document.createElement("strong");
    name.textContent = `${user.name || "匿名"} (@${user.handle})`;
    head.appendChild(name);
    copy.appendChild(head);
    const meta = document.createElement("span");
    meta.textContent = `${user.admin ? "管理员" : "用户"} · ${user.enabled ? "已启用" : "已停用"}${isSelf ? " · 当前账户" : ""}`;
    copy.appendChild(meta);
    // 创建时间 + 是否已设密
    const createdText = user.created ? accountCore.formatTimestamp(user.created) : "未知";
    const detail = document.createElement("span");
    detail.className = "admin-user-detail";
    detail.textContent = `创建：${createdText} · ${user.password ? "已设密钥" : "未设密钥"}`;
    copy.appendChild(detail);
    // 使用量统计（只计数/大小/时间，不含正文）
    const statsText = `会话 ${numberOrZero(user.chats)} · 角色卡 ${numberOrZero(user.characters)} · Memory Books ${numberOrZero(user.worlds)} · 数据 ${formatBytes(user.dataSizeBytes)} · 最近活动 ${formatLastActivity(user.lastActivity)}`;
    const stats = document.createElement("span");
    stats.className = "admin-user-stats";
    stats.textContent = statsText;
    copy.appendChild(stats);
    row.appendChild(copy);
    const actions = document.createElement("div");
    actions.className = "admin-user-actions";
    if (isSelf) {
      const note = document.createElement("span");
      note.className = "settings-value";
      note.textContent = "当前账户";
      actions.appendChild(note);
    } else {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = user.enabled ? "plain-button" : "primary-button";
      toggle.textContent = user.enabled ? "停用" : "启用";
      toggle.addEventListener("click", () => toggleUserEnabled(user.handle, !user.enabled));
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "plain-button";
      reset.textContent = "重置密码";
      reset.addEventListener("click", () => openPasswordDialog("reset", user.handle));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger-button";
      del.textContent = "删除";
      del.addEventListener("click", () => openAdminDeleteDialog(user.handle));
      actions.append(toggle, reset, del);
      // Task-30E：提升/降级（视当前 admin 状态）；后端保护最后一个管理员与 self-demote。
      const roleButton = document.createElement("button");
      roleButton.type = "button";
      roleButton.className = user.admin ? "plain-button" : "primary-button";
      roleButton.textContent = user.admin ? "降级为普通用户" : "提升为管理员";
      roleButton.addEventListener("click", () => (user.admin ? demoteUser(user.handle) : promoteUser(user.handle)));
      actions.appendChild(roleButton);
    }
    row.append(copy, actions);
    list.appendChild(row);
  }
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "0 MB";
  const mb = b / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;
}

function formatLastActivity(value) {
  if (!value) return "暂无";
  return accountCore.formatTimestamp(value);
}

async function promoteUser(handle) {
  try {
    await window.STApi.promoteUser(handle);
    showToast(`已将 @${handle} 提升为管理员`);
    await refreshAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") showToast(label);
  }
}

async function demoteUser(handle) {
  try {
    await window.STApi.demoteUser(handle);
    showToast(`已将 @${handle} 降级为普通用户`);
    await refreshAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") showToast(label);
  }
}

async function toggleUserEnabled(handle, enable) {
  try {
    if (enable) await window.STApi.enableUser(handle);
    else await window.STApi.disableUser(handle);
    showToast(enable ? `已启用 @${handle}` : `已停用 @${handle}`);
    await refreshAdminUsers();
  } catch (error) {
    const label = await resolveAccountFailure(error);
    if (label !== "redirect") showToast(label);
  }
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
    meta.textContent = card.avatar || "";
    copy.appendChild(meta);
    row.appendChild(copy);
    const actions = document.createElement("div");
    actions.className = "character-manage-actions";
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
  $("#resetLayoutButton")?.addEventListener("click", resetLayout);
  $("#resetPreferencesButton")?.addEventListener("click", resetPreferences);
  $("#clearGeneralAiButton")?.addEventListener("click", clearGeneralAiData);
  $("#archivedChatSearch")?.addEventListener("input", (event) => window.TASK21?.setArchivedChatSearch?.(event.target.value));
  document.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => setSettingsSection(button.dataset.settingsSection)));
}

function logoutFocusableNodes() {
  return ["#cancelLogoutButton", "#confirmLogoutButton"]
    .map((selector) => $(selector))
    .filter((node) => node && !node.disabled && !node.hidden);
}

function closeLogoutDialog(options = {}) {
  if (state.logoutPending) return;
  const dialog = $("#logoutDialog");
  if (!dialog) return;
  state.logoutOpen = false;
  dialog.hidden = true;
  syncOverlayScrollLock();
  const returnFocus = state.logoutReturnFocus;
  state.logoutReturnFocus = null;
  if (options.restoreFocus !== false && returnFocus && typeof returnFocus.focus === "function") {
    returnFocus.focus({ preventScroll: true });
  }
}

function openLogoutDialog() {
  const dialog = $("#logoutDialog");
  const confirmButton = $("#confirmLogoutButton");
  if (!dialog || !confirmButton || state.logoutPending) return;
  state.logoutReturnFocus = document.activeElement;
  setUserMenuOpen(false, { restoreFocus: false });
  $("#logoutError").hidden = true;
  state.logoutOpen = true;
  dialog.hidden = false;
  syncOverlayScrollLock();
  $("#cancelLogoutButton")?.focus();
}

async function confirmLogout() {
  if (state.logoutPending || !window.STApi || typeof window.STApi.logout !== "function") return;
  const confirmButton = $("#confirmLogoutButton");
  const cancelButton = $("#cancelLogoutButton");
  const error = $("#logoutError");
  state.logoutPending = true;
  if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = "正在退出…"; }
  if (cancelButton) cancelButton.disabled = true;
  if (error) error.hidden = true;
  try {
    await window.STApi.logout();
    clearThemeAccountHint();
    state.user = null;
    if (window.STApi) window.STApi._token = null;
    window.location.replace(routes.productLoginUrl() + "?noauto=true");
  } catch (logoutError) {
    const kind = accountCore ? accountCore.classifyLogoutError(logoutError) : "unknown";
    if (kind === "auth") {
      try {
        await window.STApi.getCurrentUser();
      } catch (meError) {
        if (window.STApi.isAuthRequired && window.STApi.isAuthRequired(meError)) {
          state.user = null;
          clearThemeAccountHint();
          window.STApi._token = null;
          window.location.replace(routes.productLoginUrl() + "?noauto=true");
          return;
        }
      }
    }
    if (error) { error.textContent = "退出失败，请重试"; error.hidden = false; }
  } finally {
    state.logoutPending = false;
    if (confirmButton) { confirmButton.disabled = false; confirmButton.textContent = "退出登录"; }
    if (cancelButton) cancelButton.disabled = false;
  }
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
  if (!live) return `<div class="message-bubble assistant-bubble"><p>${escapeHtml(text)}</p></div>`;
  const segments = window.TASK22_CORE ? window.TASK22_CORE.splitReply(text) : [{ type: "narration", text }];
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
    setSettingsSection("account");
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
  if (action === "open-logout") openLogoutDialog();
  if (action === "open-self-delete") openSelfDeleteDialog();
  if (action === "open-rename") openRenameDialog();
  if (action === "open-password") openPasswordDialog("self", state.user?.handle || "");
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
$("#cancelLogoutButton")?.addEventListener("click", () => closeLogoutDialog());
$("#confirmLogoutButton")?.addEventListener("click", confirmLogout);
$("#logoutDialog")?.addEventListener("click", (event) => { if (event.target.id === "logoutDialog") closeLogoutDialog(); });
$("#cancelRenameButton")?.addEventListener("click", () => closeRenameDialog());
$("#confirmRenameButton")?.addEventListener("click", confirmRename);
$("#renameDialog")?.addEventListener("click", (event) => { if (event.target.id === "renameDialog") closeRenameDialog(); });
$("#renameInput")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); confirmRename(); } });
$("#cancelPasswordButton")?.addEventListener("click", () => closePasswordDialog());
$("#confirmPasswordButton")?.addEventListener("click", confirmPassword);
$("#passwordDialog")?.addEventListener("click", (event) => { if (event.target.id === "passwordDialog") closePasswordDialog(); });
$("#cancelAdminDeleteButton")?.addEventListener("click", () => closeAdminDeleteDialog());
$("#confirmAdminDeleteButton")?.addEventListener("click", confirmAdminDelete);
$("#adminDeleteDialog")?.addEventListener("click", (event) => { if (event.target.id === "adminDeleteDialog") closeAdminDeleteDialog(); });
$("#adminDeleteInput")?.addEventListener("input", adminDeleteInputChanged);
$("#adminUsersRefresh")?.addEventListener("click", () => refreshAdminUsers());
$("#adminUsersCreateButton")?.addEventListener("click", openAdminCreateDialog);
$("#cancelAdminCreateButton")?.addEventListener("click", () => closeAdminCreateDialog());
$("#confirmAdminCreateButton")?.addEventListener("click", confirmAdminCreate);
$("#adminCreateDialog")?.addEventListener("click", (event) => { if (event.target.id === "adminCreateDialog") closeAdminCreateDialog(); });
$("#cancelSelfDeleteButton")?.addEventListener("click", () => closeSelfDeleteDialog());
$("#confirmSelfDeleteButton")?.addEventListener("click", confirmSelfDelete);
$("#selfDeleteDialog")?.addEventListener("click", (event) => { if (event.target.id === "selfDeleteDialog") closeSelfDeleteDialog(); });
$("#selfDeleteInput")?.addEventListener("input", selfDeleteInputChanged);
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
  if (state.logoutOpen) {
    const nodes = logoutFocusableNodes();
    if (event.key === "Escape") {
      event.preventDefault();
      closeLogoutDialog();
      return;
    }
    if (event.key === "Tab" && nodes.length) {
      event.preventDefault();
      const current = nodes.indexOf(document.activeElement);
      nodes[(current + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
      return;
    }
  }
  if (state.renameOpen || state.passwordOpen || state.adminDeleteOpen || state.selfDeleteOpen || state.adminCreateOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.renameOpen) closeRenameDialog();
      else if (state.passwordOpen) closePasswordDialog();
      else if (state.adminDeleteOpen) closeAdminDeleteDialog();
      else if (state.selfDeleteOpen) closeSelfDeleteDialog();
      else if (state.adminCreateOpen) closeAdminCreateDialog();
    }
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

window.TASK25C_UI = {
  layoutConfig,
  setSidebarCollapsed,
  setMemoryPanelOpen,
  setWaiting,
  setMemoryBusy,
  clearThemeAccountHint,
  setUserContext,
  setUserIdentity,
  setAdminMenuVisible,
  openSettings,
  closeSettings,
  setSettingsSection,
  isSidebarCharacter,
  setSidebarCharacter,
  sidebarCharacterCount,
  rememberDialogFocus,
  restoreDialogFocus,
  syncOverlayScrollLock,
  updateVisualViewportMetrics,
};
