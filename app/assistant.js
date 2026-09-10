"use strict";

(function () {
  const core = window.TASK24_ASSISTANT_CORE;
  const accountCore = window.TASK27A_ACCOUNT_CORE;
  const routes = window.TASK31_ROUTING;
  const THEME_ACCOUNT_HINT_KEY = "task27a.current-account-handle.v1";
  const defaultPreferences = () => accountCore
    ? accountCore.defaultPreferences({ prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches })
    : { version: 1, theme: "dark", density: "comfortable", motion: "full", sendMode: "enter", lastSettingsSection: "appearance", harry: { sidebarCollapsed: false, sidebarWidth: 248, memoryOpen: false, memoryWidth: 420 }, general: { sidebarCollapsed: false, sidebarWidth: 248 } };
  const state = {
    csrfToken: "",
    customUrl: "",
    modelMode: "local",
    deepseekThinking: false,
    deepseekKeySaved: false,
    modeStorageKey: "",
    userHandle: "",
    storageKey: "",
    sessions: [],
    activeId: "",
    pending: false,
    controller: null,
    cancelRequested: false,
    archiveSearch: "",
    sidebarCollapsed: false,
    sidebarWidth: 248,
    userMenuOpen: false,
    settingsOpen: false,
    settingsReturnFocus: null,
    logoutOpen: false,
    logoutPending: false,
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
    toastTimer: null,
    user: null,
    preferences: defaultPreferences(),
    storageWarned: false,
  };

  const $ = (id) => document.getElementById(id);
  const gate = $("assistantGate");
  const app = $("assistantApp");
  const gateTitle = $("gateTitle");
  const gateMessage = $("gateMessage");
  const sessionList = $("sessionList");
  const messageList = $("messageList");
  const emptyState = $("emptyState");
  const messageArea = $("messageArea");
  const input = $("messageInput");
  const form = $("composerForm");
  const sendButton = $("sendButton");
  const stopButton = $("stopButton");
  const status = $("assistantStatus");
  const thinking = $("assistantThinking");

  function writeThemeAccountHint(handle) {
    const safe = String(handle || "").trim();
    if (!safe) return;
    try { window.sessionStorage.setItem(THEME_ACCOUNT_HINT_KEY, encodeURIComponent(safe)); } catch (_) { /* optional bootstrap hint */ }
  }

  function clearThemeAccountHint() {
    try { window.sessionStorage.removeItem(THEME_ACCOUNT_HINT_KEY); } catch (_) { /* optional bootstrap hint */ }
  }

  function setGate(title, message) {
    document.documentElement.classList.remove("theme-pending");
    gateTitle.textContent = title;
    gateMessage.textContent = message;
    gate.hidden = false;
    app.hidden = true;
  }

  function redirectAfterGate(path, title, message) {
    if (String(path || "").includes("/login.html")) clearThemeAccountHint();
    setGate(title, message);
    window.setTimeout(() => window.location.replace(path), 280);
  }

  function setStatus(message, isError) {
    status.textContent = message || "";
    status.style.color = isError ? "#c58e88" : "";
  }

  function showToast(message) {
    const toast = $("toast");
    if (!toast) return;
    window.clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
  }

  function isAuthStatus(value) { return value === 401 || value === 403; }

  async function getCurrentUser() {
    // 本地版：身份来自本机档案，没有登录服务。
    if (window.STApi && typeof window.STApi.getCurrentUser === "function") {
      try { return { ok: true, user: await window.STApi.getCurrentUser() }; }
      catch (error) { return { ok: false, status: (error && error.status) || 500 }; }
    }
    const response = await fetch("/api/users/me", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return { ok: false, status: response.status };
    try { return { ok: true, user: await response.json() }; } catch (_) { return { ok: false, status: 500 }; }
  }

  async function initializeCsrf() {
    if (window.STApi && typeof window.STApi.init === "function") {
      await window.STApi.init();
      state.csrfToken = window.STApi._token;
      return;
    }
    const response = await fetch("/csrf-token", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error("csrf unavailable"), { status: response.status });
    const data = await response.json();
    if (!data || typeof data.token !== "string" || !data.token) throw new Error("csrf unavailable");
    state.csrfToken = data.token;
  }

  // 本地版：原先指向 SillyTavern 的这几条接口由适配层直接实现，不再发网络请求。
  function localPost(path, body) {
    if (!window.RoleWorld || !window.RoleWorld.secrets || typeof window.RoleWorld.secrets.read !== "function") return null;
    const secrets = window.RoleWorld.secrets;
    if (path === "/api/settings/get") return window.STApi.getSettings();
    if (path === "/api/secrets/read") return secrets.read();
    if (path === "/api/secrets/write") return secrets.write(body && body.key, body && body.value, body && body.label);
    if (path === "/api/secrets/delete") return secrets.delete(body && body.key, body && body.id);
    return null;
  }

  async function postJson(path, body) {
    const local = localPost(path, body);
    if (local) return local;
    const attempt = async () => {
      const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": state.csrfToken }, body: JSON.stringify(body || {}) });
      if (!response.ok) throw Object.assign(new Error("request failed"), { status: response.status });
      return response.json();
    };
    try {
      return await attempt();
    } catch (error) {
      // Task-27H：会话 CSRF 失效（401/403）时刷新一次令牌并重试一次；
      // 仍然失败时保持带 status 的错误，由调用方决定是否跳转登录。
      if (!(error && isAuthStatus(error.status))) throw error;
      await initializeCsrf();
      return attempt();
    }
  }

  async function loadCustomUrl() {
    // 本地版：端点直接来自本机设置，允许任意 http(s) 地址（本地 llama.cpp 或第三方服务）。
    if (window.RoleWorld && typeof window.RoleWorld.getLocalSettings === "function") {
      const local = await window.RoleWorld.getLocalSettings();
      const url = local.endpoint || window.RoleWorldModel.endpointFor(local);
      return String(url || "").trim().replace(/\/$/, "");
    }
    const data = await postJson("/api/settings/get", {});
    let settings = {};
    try { settings = typeof data.settings === "string" ? JSON.parse(data.settings) : (data.settings || {}); } catch (_) { settings = {}; }
    const url = settings && settings.oai_settings && settings.oai_settings.custom_url;
    if (typeof url !== "string" || !url.trim()) throw new Error("unavailable");
    let parsed;
    try { parsed = new URL(url.trim(), window.location.href); } catch (_) { throw new Error("unavailable"); }
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) throw new Error("unavailable");
    return parsed.toString().replace(/\/$/, "");
  }

  /* ---------- 模型来源与 DeepSeek 密钥（2026-09-09） ----------
   * 模式只存本机（按账号）；密钥只写服务器端加密 secrets，页面不回显、不落浏览器。 */
  const MODE_STORAGE_PREFIX = "task24.general-ai.mode.v1.";

  function modeStorageKeyFor(handle) {
    return MODE_STORAGE_PREFIX + encodeURIComponent(String(handle || "unknown"));
  }

  function loadModelMode() {
    state.modelMode = core.MODES.LOCAL;
    state.deepseekThinking = false;
    let stored = null;
    try { stored = JSON.parse(window.localStorage.getItem(state.modeStorageKey) || "null"); } catch (_) { stored = null; }
    if (stored && typeof stored === "object") {
      if (stored.mode === core.MODES.LOCAL || core.isDeepSeekMode(stored.mode)) state.modelMode = stored.mode;
      state.deepseekThinking = stored.thinking === true;
    }
    syncModelControls();
  }

  function persistModelMode() {
    if (!state.modeStorageKey) return;
    try {
      window.localStorage.setItem(state.modeStorageKey, JSON.stringify({ mode: state.modelMode, thinking: state.deepseekThinking }));
    } catch (_) { /* 存储不可用时不影响当前会话 */ }
  }

  function syncModelControls() {
    const topbar = $("assistantModelSelect");
    const settings = $("assistantModelSelectSettings");
    if (topbar) topbar.value = state.modelMode;
    if (settings) settings.value = state.modelMode;
    const thinking = $("deepseekThinkingToggle");
    const isDeepSeek = core.isDeepSeekMode(state.modelMode);
    if (thinking) {
      thinking.checked = state.deepseekThinking;
      thinking.disabled = !isDeepSeek;
    }
    renderKeyStatus();
  }

  function setModelMode(mode) {
    state.modelMode = (mode === core.MODES.LOCAL || core.isDeepSeekMode(mode)) ? mode : core.MODES.LOCAL;
    persistModelMode();
    syncModelControls();
    if (core.isDeepSeekMode(state.modelMode)) refreshDeepSeekKeyStatus();
  }

  function renderKeyStatus(text, isError) {
    const node = $("deepseekKeyStatus");
    if (!node) return;
    if (typeof text === "string") {
      node.textContent = text;
      node.classList.toggle("is-error", !!isError);
      return;
    }
    node.textContent = state.deepseekKeySaved
      ? "已保存 · 密钥保存在本机数据库，不会上传到任何服务器"
      : "未保存 · 密钥只保存在本机，页面不回显";
    node.classList.remove("is-error");
  }

  async function refreshDeepSeekKeyStatus() {
    try {
      const secretState = await postJson("/api/secrets/read", {});
      state.deepseekKeySaved = !!(secretState && secretState[core.DEEPSEEK_SECRET_KEY]);
      renderKeyStatus();
    } catch (_) {
      renderKeyStatus("无法读取密钥状态", true);
    }
  }

  async function saveDeepSeekKey() {
    const input = $("deepseekKeyInput");
    const value = input ? input.value.trim() : "";
    if (!value) { renderKeyStatus("请先粘贴 DeepSeek API Key", true); return; }
    const button = $("deepseekKeySave");
    if (button) { button.disabled = true; button.textContent = "保存中…"; }
    try {
      await postJson("/api/secrets/write", { key: core.DEEPSEEK_SECRET_KEY, value: value, label: "DeepSeek" });
      if (input) input.value = "";
      state.deepseekKeySaved = true;
      renderKeyStatus();
    } catch (_) {
      renderKeyStatus("保存失败，请重试", true);
    } finally {
      if (button) { button.disabled = false; button.textContent = "保存"; }
    }
  }

  async function deleteDeepSeekKey() {
    const button = $("deepseekKeyDelete");
    if (button) button.disabled = true;
    try {
      const secretState = await postJson("/api/secrets/read", {});
      const list = secretState && Array.isArray(secretState[core.DEEPSEEK_SECRET_KEY]) ? secretState[core.DEEPSEEK_SECRET_KEY] : [];
      for (const item of list) {
        if (item && item.id) await postJson("/api/secrets/delete", { key: core.DEEPSEEK_SECRET_KEY, id: item.id });
      }
      state.deepseekKeySaved = false;
      renderKeyStatus();
    } catch (_) {
      renderKeyStatus("删除失败，请重试", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function newId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }

  function cleanStoredMessages(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .map((item) => ({ role: item.role, content: core.cleanText(item.content, 16000) }))
      .filter((item) => item.content.length > 0).slice(-80);
  }

  function makeSession() {
    const now = new Date().toISOString();
    return { id: newId(), kind: "task24-general", title: "新对话", createdAt: now, updatedAt: now, archivedAt: "", messages: [] };
  }

  function loadSessions() {
    let stored = null;
    try { stored = JSON.parse(window.localStorage.getItem(state.storageKey) || "null"); } catch (_) { stored = null; }
    const source = stored && Array.isArray(stored.sessions) ? stored.sessions : [];
    const now = new Date().toISOString();
    state.sessions = core.sortGeneralSessions(source.map((item) => core.normalizeGeneralSession(item, now)).filter(Boolean).map((item) => ({
      ...item,
      id: item.id || newId(),
      messages: cleanStoredMessages(item.messages),
    })));
    if (!state.sessions.some((item) => !item.archivedAt)) state.sessions.unshift(makeSession());
    state.activeId = core.chooseActiveGeneralId(state.sessions, state.activeId);
  }

  function persistSessions() {
    window.localStorage.setItem(state.storageKey, JSON.stringify({ version: 1, kind: "task24-general", sessions: state.sessions.map((item) => ({ id: item.id, kind: "task24-general", title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, archivedAt: item.archivedAt || "", messages: cleanStoredMessages(item.messages) })) }));
  }

  function activeSession() { return state.sessions.find((item) => item.id === state.activeId) || state.sessions[0]; }

  function sessionGroupLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "更早";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const difference = today.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    if (difference <= 0) return "今天";
    if (difference <= 6 * 86400000) return "最近 7 天";
    return "更早";
  }

  function formatSessionTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function archiveSortTime(item) {
    const date = new Date(item.archivedAt || item.updatedAt || "");
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
  }

  function renderSessions() {
    sessionList.textContent = "";
    const groups = new Map([["今天", []], ["最近 7 天", []], ["更早", []]]);
    for (const item of state.sessions) {
      if (!item.archivedAt) groups.get(sessionGroupLabel(item.updatedAt)).push(item);
    }
    const renderGroup = (label, items) => {
      if (!items.length) return;
      const group = document.createElement("section");
      group.className = "session-group";
      const heading = document.createElement("h2");
      heading.className = "session-group-title";
      heading.textContent = label;
      group.appendChild(heading);
      const list = document.createElement("ul");
      list.className = "session-group-list";
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "session-row";
        const button = document.createElement("button");
        button.type = "button";
        button.className = `session-button${item.id === state.activeId ? " is-active" : ""}`;
        button.title = item.title || "新对话";
        const title = document.createElement("span");
        title.className = "session-button-title";
        title.textContent = item.title || "新对话";
        const time = document.createElement("span");
        time.className = "session-button-time";
        time.textContent = formatSessionTime(item.updatedAt);
        button.append(title, time);
        button.addEventListener("click", () => {
          if (state.pending) return;
          state.activeId = item.id;
          renderSessions();
          renderMessages();
        });
        const action = document.createElement("button");
        action.type = "button";
        action.className = "session-action";
        action.textContent = "归档";
        action.title = "归档这段对话";
        action.setAttribute("aria-label", `${action.textContent}：${item.title || "新对话"}`);
        action.dataset.empty = String(core.isEmptyGeneralSession(item));
        action.disabled = state.pending || action.dataset.empty === "true";
        action.addEventListener("click", () => archiveSession(item.id));
        li.append(button, action);
        list.appendChild(li);
      }
      group.appendChild(list);
      sessionList.appendChild(group);
    };
    for (const [label, items] of groups) renderGroup(label, items);
    renderArchivedSettings();
  }

  function renderArchivedSettings() {
    const container = $("assistantArchivedList");
    const empty = $("assistantArchivedEmpty");
    const count = $("assistantArchivedCount");
    if (!container) return;
    container.textContent = "";
    const allArchived = state.sessions
      .filter((item) => item.archivedAt)
      .sort((a, b) => archiveSortTime(b) - archiveSortTime(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    if (count) count.textContent = `${allArchived.length} 个`;
    const query = state.archiveSearch.trim().toLocaleLowerCase();
    const archived = query
      ? allArchived.filter((item) => `${item.title || ""} ${item.id || ""}`.toLocaleLowerCase().includes(query))
      : allArchived;
    if (empty) {
      empty.hidden = archived.length > 0;
      empty.textContent = allArchived.length && !archived.length ? "没有匹配的归档对话" : "暂无归档对话";
    }
    for (const item of archived) {
      const row = document.createElement("div");
      row.className = "settings-row settings-action-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.title || "新对话";
      const time = document.createElement("span");
      time.textContent = `${formatSessionTime(item.archivedAt || item.updatedAt)} · 已归档`;
      copy.append(title, time);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "plain-button";
      restore.textContent = "恢复";
      restore.disabled = state.pending;
      restore.addEventListener("click", () => restoreSession(item.id));
      // Task-30E：归档对话「永久删除」——仅本地会话，不可恢复。
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "plain-button danger-button";
      remove.textContent = "永久删除";
      remove.disabled = state.pending;
      remove.addEventListener("click", () => deleteSession(item.id));
      row.append(copy, restore, remove);
      container.appendChild(row);
    }
  }

  function setArchivedSearch(value) {
    state.archiveSearch = String(value || "");
    renderArchivedSettings();
  }

  function appendPlain(fragment, text) {
    if (!text) return;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    fragment.appendChild(paragraph);
  }

  function renderContent(container, text) {
    const source = String(text || "");
    const fragment = document.createDocumentFragment();
    const fence = /```([^\n]*)\n([\s\S]*?)```/g;
    let cursor = 0;
    let match;
    while ((match = fence.exec(source)) !== null) {
      appendPlain(fragment, source.slice(cursor, match.index));
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (match[1].trim()) code.dataset.language = match[1].trim().slice(0, 24);
      code.textContent = match[2];
      pre.appendChild(code);
      fragment.appendChild(pre);
      cursor = match.index + match[0].length;
    }
    appendPlain(fragment, source.slice(cursor));
    if (!fragment.firstChild) appendPlain(fragment, source);
    container.appendChild(fragment);
  }

  function renderMessages() {
    const session = activeSession();
    messageList.textContent = "";
    emptyState.hidden = !!(session && session.messages.length);
    if (!session) return;
    for (const item of session.messages) {
      const row = document.createElement("article");
      const isUser = item.role === "user";
      row.className = `message-row${isUser ? " is-user" : ""}`;
      const avatar = document.createElement("div");
      avatar.className = "message-avatar";
      avatar.setAttribute("aria-label", isUser ? "你" : "通用 AI");
      avatar.setAttribute("role", "img");
      const content = document.createElement("div");
      content.className = "message-content";
      const label = document.createElement("p");
      label.className = "message-label";
      label.textContent = isUser ? "你" : "通用 AI";
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      renderContent(bubble, item.content);
      content.appendChild(label);
      content.appendChild(bubble);
      row.appendChild(avatar);
      row.appendChild(content);
      messageList.appendChild(row);
    }
    messageArea.scrollTop = messageArea.scrollHeight;
  }

  function setBusy(value) {
    state.pending = !!value;
    sendButton.disabled = false;
    sendButton.dataset.mode = state.pending ? "stop" : "send";
    sendButton.setAttribute("aria-label", state.pending ? "停止生成" : "发送");
    sendButton.innerHTML = state.pending ? '<span class="stop-glyph" aria-hidden="true"></span>' : '<span aria-hidden="true">↑</span>';
    stopButton.hidden = true;
    stopButton.disabled = true;
    input.disabled = state.pending;
    thinking.hidden = !state.pending;
    const newButton = $("newChatButton");
    if (newButton) newButton.disabled = state.pending;
    document.querySelectorAll(".session-button, .session-action").forEach((button) => { button.disabled = state.pending || button.dataset.empty === "true"; });
    document.querySelectorAll("#assistantArchivedList button").forEach((button) => { button.disabled = state.pending; });
    if (state.pending) messageArea.scrollTop = messageArea.scrollHeight;
  }

  function autoResize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 190)}px`;
  }

  function createNewSession() {
    if (state.pending) return;
    const current = activeSession();
    if (current && !current.archivedAt && core.isEmptyGeneralSession(current)) {
      setStatus("当前已经是空白对话");
      input.focus();
      return;
    }
    const session = makeSession();
    state.sessions.unshift(session);
    state.activeId = session.id;
    persistSessions();
    renderSessions();
    renderMessages();
    setStatus("");
    input.focus();
  }

  function archiveSession(sessionId) {
    if (state.pending) return;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session || session.archivedAt) return;
    if (core.isEmptyGeneralSession(session)) {
      setStatus("空白对话无需归档");
      return;
    }
    session.archivedAt = new Date().toISOString();
    if (state.activeId === session.id) {
      state.activeId = core.chooseActiveGeneralId(state.sessions, "");
      if (!state.activeId) {
        const replacement = makeSession();
        state.sessions.unshift(replacement);
        state.activeId = replacement.id;
      }
    }
    state.sessions = core.sortGeneralSessions(state.sessions);
    persistSessions();
    renderSessions();
    renderMessages();
    setStatus("对话已归档，可随时恢复");
    input.focus();
  }

  function restoreSession(sessionId) {
    if (state.pending) return;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session || !session.archivedAt) return;
    session.archivedAt = "";
    state.sessions = state.sessions.filter((item) => item === session || item.archivedAt || !core.isEmptyGeneralSession(item));
    state.activeId = session.id;
    state.sessions = core.sortGeneralSessions(state.sessions);
    persistSessions();
    renderSessions();
    renderMessages();
    setStatus("对话已恢复");
    input.focus();
  }

  // Task-30E：永久删除本地通用 AI 会话（仅作用于当前设备的该会话，不可恢复）。
  function deleteSession(sessionId) {
    if (state.pending) return;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const confirmationWord = "删除";
    const typed = window.prompt(
      `永久删除这段归档对话？此操作不可恢复。\n\n标题：${session.title || "新对话"}\n\n请输入「${confirmationWord}」以确认：`,
      "",
    );
    if (typed === null) return;
    if (typed.trim() !== confirmationWord) {
      setStatus("已取消：确认词不匹配");
      return;
    }
    if (state.activeId === session.id) {
      state.activeId = core.chooseActiveGeneralId(state.sessions, "");
    }
    state.sessions = state.sessions.filter((item) => item.id !== sessionId);
    if (!state.activeId) {
      const replacement = makeSession();
      state.sessions.unshift(replacement);
      state.activeId = replacement.id;
    }
    state.sessions = core.sortGeneralSessions(state.sessions);
    persistSessions();
    renderSessions();
    renderMessages();
    renderArchivedSettings();
    setStatus("对话已永久删除");
  }

  /* ---------- 流式生成（2026-09-09） ----------
   * SillyTavern 在 stream:true 时把上游 SSE 原样转发；这里按 OpenAI 增量格式
   * 逐块解析并回显。非 SSE 响应自动回退到一次性 JSON，保证兼容。 */
  function appendStreamingRow() {
    const row = document.createElement("article");
    row.className = "message-row";
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-label", "通用 AI");
    avatar.setAttribute("role", "img");
    const content = document.createElement("div");
    content.className = "message-content";
    const label = document.createElement("p");
    label.className = "message-label";
    label.textContent = "通用 AI";
    const bubble = document.createElement("div");
    bubble.className = "message-bubble is-streaming";
    const text = document.createElement("p");
    text.className = "stream-text";
    bubble.appendChild(text);
    content.appendChild(label);
    content.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(content);
    messageList.appendChild(row);
    messageArea.scrollTop = messageArea.scrollHeight;
    return { row: row, bubble: bubble, text: text };
  }

  function updateStreamingRow(handle, partial) {
    if (!handle || !handle.row.parentNode) return;
    handle.text.textContent = partial;
    messageArea.scrollTop = messageArea.scrollHeight;
  }

  function finishStreamingRow(handle) {
    if (handle && handle.row.parentNode) handle.bubble.classList.remove("is-streaming");
  }

  function removeStreamingRow(handle) {
    if (handle && handle.row.parentNode) handle.row.parentNode.removeChild(handle.row);
  }

  /* 解析一段 SSE 文本（也用于“浏览器不支持流式 body”时的整段回退）。 */
  function consumeSseText(chunk, sink) {
    for (const line of String(chunk || "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;
      const dataText = trimmed.slice(5).trim();
      if (!dataText || dataText === "[DONE]") continue;
      let json = null;
      try { json = JSON.parse(dataText); } catch (_) { continue; }
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      const delta = choice && (choice.delta || choice.message);
      if (!delta) continue;
      const piece = typeof delta.content === "string" ? delta.content : "";
      // DeepSeek 思考模式：思维链单独一列，正文为空时作为兜底显示。
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content
        : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (piece) sink.content += piece;
      if (reasoning) sink.reasoning += reasoning;
      if (piece || reasoning) { sink.chunks += 1; sink.emit(); }
    }
  }

  /* 整段文本解析：SSE 文本或一次性 JSON 都能吃。 */
  function parseWholeText(raw, sink) {
    const text = String(raw || "");
    if (/^\s*data:/m.test(text)) { consumeSseText(text, sink); return; }
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    if (json) {
      const parsed = core.parseGenerateResponse(json);
      if (parsed.content) sink.content = parsed.content;
    }
  }

  async function generateOnceNonStreaming(payload, signal, onDelta) {
    const body = Object.assign({}, payload, { stream: false });
    if (window.STApi && typeof window.STApi.generate === "function") {
      const data = await window.STApi.generate(body, signal);
      const parsed = core.parseGenerateResponse(data);
      if (parsed.content) { onDelta(parsed.content); return parsed.content; }
      return "";
    }
    const fallback = await fetch("/api/backends/chat-completions/generate", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": state.csrfToken }, body: JSON.stringify(body), signal });
    if (!fallback.ok) throw Object.assign(new Error("generation failed"), { status: fallback.status });
    const data = await fallback.json();
    const parsed = core.parseGenerateResponse(data);
    if (parsed.content) { onDelta(parsed.content); return parsed.content; }
    return "";
  }

  // 本地版：生成请求直接打到用户配置的模型端点，返回原始 Response 供 SSE 解析。
  function generateRequest(payload, signal) {
    if (window.STApi && typeof window.STApi.generateStream === "function") {
      return window.STApi.generateStream(payload, signal);
    }
    return fetch("/api/backends/chat-completions/generate", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": state.csrfToken }, body: JSON.stringify(payload), signal });
  }

  /* 说明：SillyTavern 的 forwardFetchResponse 只转发状态码与 body，不复制响应头，
   * 因此生产环境的流式响应可能没有 text/event-stream 头。这里只在“确实没有可读
   * body”时才走整段解析，其余情况一律按流读取，用内容本身判断是否为 SSE。 */
  async function generateStream(payload, signal, onDelta) {
    const response = await generateRequest(payload, signal);
    if (!response.ok) throw Object.assign(new Error("generation failed"), { status: response.status });
    const sink = {
      content: "",
      reasoning: "",
      chunks: 0,
      emit: () => onDelta(sink.content || sink.reasoning),
    };
    state.lastStreamChunks = 0;
    const finish = () => (sink.content || sink.reasoning).trim();

    if (!response.body) {
      parseWholeText(await response.text(), sink);
      const buffered = finish();
      state.lastStreamChunks = sink.chunks;
      if (buffered) return buffered;
      return generateOnceNonStreaming(payload, signal, onDelta);
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
        consumeSseText(buffer.slice(0, match.index), sink);
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (sseMode && buffer.trim()) consumeSseText(buffer, sink);
    const streamed = finish();
    state.lastStreamChunks = sink.chunks;
    if (streamed) return streamed;
    if (rawAll.trim()) parseWholeText(rawAll, sink);
    const whole = finish();
    state.lastStreamChunks = sink.chunks;
    if (whole) return whole;
    return generateOnceNonStreaming(payload, signal, onDelta);
  }

  function prefersReducedMotion() {
    return document.documentElement.dataset.motion === "reduced"
      || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* 隧道/代理可能把整段 SSE 缓冲后一次性送达。此时逐字“打字机”展开，
   * 保证用户仍看到增量输出；正常流式（多块）不会走这里。 */
  async function revealTypewriter(handle, text, signal) {
    if (!handle || prefersReducedMotion()) return;
    const step = Math.max(2, Math.ceil(text.length / 70));
    for (let index = step; index < text.length; index += step) {
      if (signal && signal.aborted) break;
      updateStreamingRow(handle, text.slice(0, index));
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
    updateStreamingRow(handle, text);
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.pending) { stopGeneration(); return; }
    const originalInput = input.value;
    const text = originalInput.trim();
    if (!text) return;
    const session = activeSession();
    if (!session) return;
    const previousMessages = session.messages.map((message) => Object.assign({}, message));
    const previousTitle = session.title;
    const previousUpdatedAt = session.updatedAt;
    session.messages.push({ role: "user", content: text });
    if (previousMessages.length === 0) session.title = core.deriveTitle(text);
    session.updatedAt = new Date().toISOString();
    input.value = "";
    autoResize();
    persistSessions();
    renderSessions();
    renderMessages();
    setBusy(true);
    setStatus("");
    state.cancelRequested = false;
    const controller = new AbortController();
    state.controller = controller;
    const streamRow = appendStreamingRow();
    let streamed = "";
    try {
      const payload = core.buildGeneratePayload({ mode: state.modelMode, thinking: state.deepseekThinking, customUrl: state.customUrl, history: previousMessages, userText: text });
      const content = await generateStream(payload, controller.signal, (partial) => {
        streamed = partial;
        updateStreamingRow(streamRow, partial);
      });
      const finalText = String(content || streamed || "");
      if (!finalText.trim()) throw new Error("empty response");
      // 整段一次性到达时用打字机展开，避免“没有流式”的观感。
      if (state.lastStreamChunks <= 1 && finalText.trim().length > 40) {
        await revealTypewriter(streamRow, finalText, controller.signal);
      }
      removeStreamingRow(streamRow);
      session.messages.push({ role: "assistant", content: finalText });
      session.updatedAt = new Date().toISOString();
      persistSessions();
      renderSessions();
      renderMessages();
      setStatus("");
    } catch (error) {
      const partial = streamed.trim();
      removeStreamingRow(streamRow);
      // 手动停止时保留已经生成的部分，其余错误回滚到发送前状态。
      if (error && error.name === "AbortError" && partial) {
        session.messages.push({ role: "assistant", content: partial });
        session.updatedAt = new Date().toISOString();
        persistSessions();
        renderSessions();
        renderMessages();
        setStatus("已停止（保留已生成的部分）");
        return;
      }
      session.messages = previousMessages.map((message) => Object.assign({}, message));
      session.title = previousTitle;
      session.updatedAt = previousUpdatedAt;
      persistSessions();
      renderSessions();
      renderMessages();
      input.value = originalInput;
      autoResize();
      input.focus();
      if (error && error.name === "AbortError") setStatus("已停止");
      else if (error && isAuthStatus(error.status)) redirectAfterGate(routes.productLoginUrl(), "登录状态已失效", "请重新登录后继续使用。");
      else if (core.isDeepSeekMode(state.modelMode) && error && error.status === 400) setStatus("尚未保存 DeepSeek API Key：请到「设置 → 对话」粘贴并保存", true);
      else if (error && error.status) setStatus(`暂时无法回复（HTTP ${error.status}），请重试`, true);
      else setStatus("暂时无法回复，请重试", true);
    } finally {
      finishStreamingRow(streamRow);
      state.controller = null;
      state.cancelRequested = false;
      setBusy(false);
      if (!state.settingsOpen) input.focus();
    }
  }

  function stopGeneration() {
    if (!state.pending) return;
    state.cancelRequested = true;
    if (state.controller) state.controller.abort();
  }

  function setSidebarCollapsed(collapsed, options = {}) {
    state.sidebarCollapsed = !!collapsed;
    app.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
    document.querySelectorAll('[data-action="toggle-sidebar"]').forEach((button) => {
      button.setAttribute("aria-label", state.sidebarCollapsed ? "打开左侧导航" : "收起左侧导航");
      button.setAttribute("title", state.sidebarCollapsed ? "打开左侧导航" : "收起左侧导航");
      button.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
    });
    if (!options.skipPersist) persistLayoutPreferences();
    if (state.sidebarCollapsed) setUserMenuOpen(false, { restoreFocus: false });
  }

  function applySidebarWidth() {
    state.sidebarWidth = Math.max(196, Math.min(420, Number.isFinite(state.sidebarWidth) ? state.sidebarWidth : 248));
    document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
  }

  function bindSidebarResize() {
    const handle = $("assistantResizeHandle");
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = state.sidebarWidth;
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* synthetic pointer */ }
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      const move = (moveEvent) => {
        const rawWidth = startWidth + moveEvent.clientX - startX;
        if (rawWidth <= 196 - 54) { setSidebarCollapsed(true, { skipPersist: true }); return; }
        if (state.sidebarCollapsed) setSidebarCollapsed(false, { skipPersist: true });
        state.sidebarWidth = Math.max(196, Math.min(420, rawWidth));
        applySidebarWidth();
      };
      const end = () => {
        handle.classList.remove("is-dragging");
        document.body.classList.remove("is-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        persistLayoutPreferences();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      state.sidebarWidth = Math.max(196, Math.min(420, state.sidebarWidth + (event.key === "ArrowRight" ? 16 : -16)));
      applySidebarWidth();
      setSidebarCollapsed(false);
      persistLayoutPreferences();
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
    [$("userDisplayName"), $("menuUserName"), $("settingsUserName")].forEach((node) => { if (node) node.textContent = safeName; });
    [$("userHandle"), $("menuUserHandle"), $("settingsUserHandle")].forEach((node) => { if (node) node.textContent = handleLabel; });
    [$("menuUserRole"), $("settingsUserRole")].forEach((node) => { if (node) node.textContent = model.roleLabel || (model.isAdmin ? "管理员" : "用户"); });
    setIdentityAvatar(model);
  }

  function setUserMenuOpen(open, options = {}) {
    const menu = $("assistantUserMenu");
    const button = $("assistantIdentityButton");
    if (!menu || !button) return;
    state.userMenuOpen = !!open;
    menu.hidden = !state.userMenuOpen;
    button.setAttribute("aria-expanded", String(state.userMenuOpen));
    if (state.userMenuOpen) {
      state.settingsReturnFocus = button;
      window.setTimeout(() => menu.querySelector("[role=menuitem]")?.focus(), 30);
    } else if (options.restoreFocus !== false && document.activeElement !== button) button.focus({ preventScroll: true });
  }

  function persistAccountPreferences() {
    if (!state.user || !accountCore) return;
    const result = accountCore.writePreferences(window.localStorage, state.user.handle, state.preferences);
    state.preferences = result.preferences;
    if (!result.ok && !state.storageWarned) {
      state.storageWarned = true;
      setStatus("偏好未能保存，但当前会话仍可使用", true);
    }
    updateLocalDataControls();
  }

  function persistLayoutPreferences() {
    if (!state.user || !accountCore) return;
    state.preferences.general.sidebarCollapsed = !!state.sidebarCollapsed;
    state.preferences.general.sidebarWidth = Math.round(state.sidebarWidth);
    persistAccountPreferences();
  }

  function updateLocalDataControls() {
    const row = $("generalAiDataRow");
    if (!row || !state.user || !accountCore) return;
    const target = accountCore.localDataTargets(window.localStorage, state.user.handle);
    row.hidden = !target.hasGeneralAi;
  }

  function setSettingsSection(section) {
    let allowed = accountCore && accountCore.ENUMS.lastSettingsSection.includes(section) ? section : "appearance";
    if (allowed === "admin-users" && !(state.user && state.user.isAdmin)) allowed = "appearance";
    document.querySelectorAll("[data-settings-section]").forEach((item) => item.classList.toggle("is-active", item.dataset.settingsSection === allowed));
    document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.settingsPanel === allowed));
    if (state.user && state.preferences.lastSettingsSection !== allowed) {
      state.preferences.lastSettingsSection = allowed;
      persistAccountPreferences();
    }
    if (allowed === "admin-users" && state.user && state.user.isAdmin) refreshAdminUsers();
  }

  function setUserContext(user) {
    if (!accountCore) return false;
    const model = accountCore.identityModel(user);
    if (!model.handle) return false;
    state.user = model;
    state.userHandle = model.handle;
    state.storageKey = core.storageKeyForUser(model.handle);
    state.modeStorageKey = modeStorageKeyFor(model.handle);
    const loaded = accountCore.readPreferences(window.localStorage, model.handle, {
      prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    state.preferences = loaded.preferences;
    writeThemeAccountHint(model.handle);
    state.sidebarCollapsed = state.preferences.general.sidebarCollapsed;
    // 手机上默认收起侧栏，避免对话区被压到无法使用（不写回偏好）。
    if (window.matchMedia("(max-width: 760px)").matches) state.sidebarCollapsed = true;
    state.sidebarWidth = state.preferences.general.sidebarWidth;
    setUserIdentity(model);
    applyPreferences();
    applySidebarWidth();
    setSidebarCollapsed(state.sidebarCollapsed, { skipPersist: true });
    updateLocalDataControls();
    if (!loaded.storageAvailable && !state.storageWarned) {
      state.storageWarned = true;
      setStatus("界面偏好未能保存，但当前会话仍可使用", true);
    }
    return true;
  }

  function applyPreferences() {
    state.preferences = accountCore ? accountCore.normalizePreferences(state.preferences, {
      prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    }) : state.preferences;
    app.dataset.density = state.preferences.density;
    document.documentElement.dataset.motion = state.preferences.motion;
    document.documentElement.dataset.theme = state.preferences.theme;
    if (state.user) document.documentElement.classList.remove("theme-pending");
    if ($("themeSelect")) $("themeSelect").value = state.preferences.theme;
    if ($("densitySelect")) $("densitySelect").value = state.preferences.density;
    if ($("motionSelect")) $("motionSelect").value = state.preferences.motion;
    if ($("sendModeSelect")) $("sendModeSelect").value = state.preferences.sendMode;
  }

  function savePreference(key, value) {
    if (!accountCore) return;
    state.preferences = accountCore.normalizePreferences(Object.assign({}, state.preferences, { [key]: value }), {
      prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    applyPreferences();
    persistAccountPreferences();
  }

  function resetLayout() {
    if (!window.confirm("恢复默认布局？只会重置当前账户的左栏状态和宽度。")) return;
    const defaults = defaultPreferences();
    state.sidebarCollapsed = false;
    state.sidebarWidth = defaults.general.sidebarWidth;
    applySidebarWidth();
    setSidebarCollapsed(false, { skipPersist: true });
    persistLayoutPreferences();
    setStatus("已恢复默认布局");
  }

  function resetPreferences() {
    if (!state.user || !accountCore) return;
    if (!window.confirm("重置当前账户的界面偏好？通用 AI 对话不会被删除。")) return;
    accountCore.removePreferences(window.localStorage, state.user.handle);
    state.preferences = defaultPreferences();
    state.sidebarCollapsed = false;
    state.sidebarWidth = state.preferences.general.sidebarWidth;
    applyPreferences();
    applySidebarWidth();
    setSidebarCollapsed(false, { skipPersist: true });
    updateLocalDataControls();
    setStatus("已重置当前账户的界面偏好");
  }

  function clearGeneralAiData() {
    if (!state.user || !accountCore) return;
    if (!window.confirm("清除当前账户的通用 AI 对话？")) return;
    const result = accountCore.clearGeneralAi(window.localStorage, state.user.handle);
    if (result.ok) {
      state.sessions = [makeSession()];
      state.activeId = state.sessions[0].id;
      renderSessions();
      renderMessages();
      updateLocalDataControls();
      setStatus("已清除当前账户的通用 AI 对话");
    }
  }

  // ---- Task-28A 账户管理（改名 / 改密 / 管理员账号列表） ----

  function accountErrorMessage(error) {
    return accountCore ? accountCore.accountErrorLabel(error && error.status, error && error.code) : "操作失败，请重试。";
  }

  async function resolveAccountFailure(error) {
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
    $("renameDialog").hidden = true;
  }

  function openRenameDialog() {
    if (!state.user || !state.user.handle) return;
    setUserMenuOpen(false, { restoreFocus: false });
    $("renameError").hidden = true;
    $("renameInput").value = state.user.displayName || "";
    state.renameOpen = true;
    $("renameDialog").hidden = false;
    window.setTimeout(() => $("renameInput")?.focus(), 30);
  }

  async function confirmRename() {
    if (state.renamePending || !state.user) return;
    const input = $("renameInput");
    const name = String(input?.value || "").trim();
    const errorNode = $("renameError");
    if (!name) { errorNode.textContent = "显示名不能为空。"; errorNode.hidden = false; input?.focus(); return; }
    if (name === state.user.displayName) { closeRenameDialog(); return; }
    state.renamePending = true;
    const button = $("confirmRenameButton");
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
    $("passwordDialog").hidden = true;
  }

  function openPasswordDialog(mode, targetHandle) {
    const dialog = $("passwordDialog");
    if (!dialog) return;
    setUserMenuOpen(false, { restoreFocus: false });
    const isReset = mode === "reset";
    state.passwordMode = isReset ? "reset" : "self";
    state.passwordTarget = isReset ? String(targetHandle || "") : (state.user?.handle || "");
    $("oldPasswordField").hidden = isReset;
    $("passwordDialogTitle").textContent = isReset ? "重置密码" : "修改密钥";
    $("passwordDialogDescription").textContent = isReset
      ? `为账户 @${state.passwordTarget} 设置新密钥。`
      : "输入当前密钥后设置新密钥。";
    [$("oldPasswordInput"), $("newPasswordInput"), $("confirmPasswordInput")].forEach((node) => { if (node) node.value = ""; });
    $("passwordError").hidden = true;
    state.passwordOpen = true;
    dialog.hidden = false;
    window.setTimeout(() => (isReset ? $("newPasswordInput") : $("oldPasswordInput"))?.focus(), 30);
  }

  async function confirmPassword() {
    if (state.passwordPending) return;
    const isReset = state.passwordMode === "reset";
    const target = state.passwordTarget;
    const oldPassword = $("oldPasswordInput")?.value || "";
    const newPassword = $("newPasswordInput")?.value || "";
    const confirm = $("confirmPasswordInput")?.value || "";
    const errorNode = $("passwordError");
    if (!isReset && !oldPassword) { errorNode.textContent = "请输入当前密钥。"; errorNode.hidden = false; return; }
    if (!newPassword) { errorNode.textContent = "请输入新密钥。"; errorNode.hidden = false; return; }
    if (newPassword !== confirm) { errorNode.textContent = "两次输入的新密钥不一致。"; errorNode.hidden = false; return; }
    state.passwordPending = true;
    const button = $("confirmPasswordButton");
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
    $("adminDeleteDialog").hidden = true;
  }

  function openAdminDeleteDialog(handle) {
    state.adminDeleteTarget = String(handle || "");
    $("adminDeleteDialogTitle").textContent = "删除账户";
    $("adminDeleteDialogDescription").textContent = `删除后账户 @${state.adminDeleteTarget} 及其数据不可恢复。请输入账户名 ${state.adminDeleteTarget} 以确认。`;
    $("adminDeleteInput").value = "";
    $("adminDeleteError").hidden = true;
    $("confirmAdminDeleteButton").disabled = true;
    state.adminDeleteOpen = true;
    $("adminDeleteDialog").hidden = false;
    window.setTimeout(() => $("adminDeleteInput")?.focus(), 30);
  }

  function adminDeleteInputChanged() {
    const input = $("adminDeleteInput");
    const button = $("confirmAdminDeleteButton");
    if (input && button) button.disabled = String(input.value || "").trim() !== state.adminDeleteTarget;
  }

  async function confirmAdminDelete() {
    if (state.adminDeletePending || !state.adminDeleteTarget) return;
    const input = $("adminDeleteInput");
    const errorNode = $("adminDeleteError");
    if (!input || String(input.value || "").trim() !== state.adminDeleteTarget) {
      errorNode.textContent = "账户名不匹配，删除已取消。";
      errorNode.hidden = false;
      return;
    }
    state.adminDeletePending = true;
    const button = $("confirmAdminDeleteButton");
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
    $("selfDeleteDialog").hidden = true;
  }

  function openSelfDeleteDialog() {
    const handle = state.user?.handle || "";
    if (!handle || !window.STApi || typeof window.STApi.deleteSelf !== "function") return;
    state.selfDeleteHandle = handle;
    $("selfDeleteDialogDescription").textContent = `将永久删除账户 @${handle} 及其角色卡、会话与 Memory Books，不可恢复。请输入账户名 ${handle} 以确认。`;
    $("selfDeletePasswordInput").value = "";
    $("selfDeleteInput").value = "";
    $("selfDeleteError").hidden = true;
    $("confirmSelfDeleteButton").disabled = true;
    state.selfDeleteOpen = true;
    $("selfDeleteDialog").hidden = false;
    window.setTimeout(() => $("selfDeletePasswordInput")?.focus(), 30);
  }

  function selfDeleteInputChanged() {
    const input = $("selfDeleteInput");
    const button = $("confirmSelfDeleteButton");
    if (input && button) button.disabled = String(input.value || "").trim() !== state.selfDeleteHandle;
  }

  async function confirmSelfDelete() {
    if (state.selfDeletePending || !state.selfDeleteHandle) return;
    const input = $("selfDeleteInput");
    const passwordInput = $("selfDeletePasswordInput");
    const errorNode = $("selfDeleteError");
    if (!input || String(input.value || "").trim() !== state.selfDeleteHandle) {
      errorNode.textContent = "账户名不匹配，注销已取消。";
      errorNode.hidden = false;
      return;
    }
    state.selfDeletePending = true;
    const button = $("confirmSelfDeleteButton");
    errorNode.hidden = true;
    if (button) { button.disabled = true; button.textContent = "注销中…"; }
    try {
      const password = passwordInput ? passwordInput.value : "";
      await window.STApi.deleteSelf(password, true);
      if (state.user && accountCore) {
        accountCore.removePreferences(window.localStorage, state.user.handle);
        accountCore.clearGeneralAi(window.localStorage, state.user.handle);
      }
      clearThemeAccountHint();
      state.user = null;
      state.csrfToken = "";
      window.STApi._token = null;
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
    $("adminCreateDialog").hidden = true;
  }

  function openAdminCreateDialog() {
    if (!state.user || !state.user.isAdmin || !window.STApi || typeof window.STApi.createUser !== "function") return;
    $("adminCreateHandleInput").value = "";
    $("adminCreateNameInput").value = "";
    $("adminCreatePasswordInput").value = "";
    $("adminCreateAdminCheck").checked = false;
    $("adminCreateError").hidden = true;
    state.adminCreateOpen = true;
    $("adminCreateDialog").hidden = false;
    window.setTimeout(() => $("adminCreateHandleInput")?.focus(), 30);
  }

  async function confirmAdminCreate() {
    if (state.adminCreatePending) return;
    const handleInput = $("adminCreateHandleInput");
    const nameInput = $("adminCreateNameInput");
    const passwordInput = $("adminCreatePasswordInput");
    const adminCheck = $("adminCreateAdminCheck");
    const errorNode = $("adminCreateError");
    const handle = handleInput ? String(handleInput.value || "").trim() : "";
    const name = nameInput ? String(nameInput.value || "").trim() : "";
    const password = passwordInput ? String(passwordInput.value || "") : "";
    if (!handle) {
      errorNode.textContent = "请填写档案名。";
      errorNode.hidden = false;
      return;
    }
    state.adminCreatePending = true;
    const button = $("confirmAdminCreateButton");
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
    const list = $("adminUsersList");
    const empty = $("adminUsersEmpty");
    try {
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
    const list = $("adminUsersList");
    const empty = $("adminUsersEmpty");
    const count = $("adminUsersCount");
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
      const createdText = user.created ? accountCore.formatTimestamp(user.created) : "未知";
      const detail = document.createElement("span");
      detail.className = "admin-user-detail";
      detail.textContent = `创建：${createdText} · ${user.password ? "已设密钥" : "未设密钥"}`;
      copy.appendChild(detail);
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
      setStatus(`已将 @${handle} 提升为管理员`);
      await refreshAdminUsers();
    } catch (error) {
      const label = await resolveAccountFailure(error);
      if (label !== "redirect") setStatus(label);
    }
  }

  async function demoteUser(handle) {
    try {
      await window.STApi.demoteUser(handle);
      setStatus(`已将 @${handle} 降级为普通用户`);
      await refreshAdminUsers();
    } catch (error) {
      const label = await resolveAccountFailure(error);
      if (label !== "redirect") setStatus(label);
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

  function openSettings() {
    state.settingsReturnFocus = $("assistantIdentityButton") || document.activeElement;
    setUserMenuOpen(false, { restoreFocus: false });
    state.settingsOpen = true;
    app.classList.add("settings-open");
    $("assistantSettingsSurface").hidden = false;
    $("assistantMain").setAttribute("aria-hidden", "true");
    $("assistantMain").inert = true;
    setSettingsSection(state.preferences.lastSettingsSection);
    $("assistantSettingsSurface").querySelector(".settings-nav-item.is-active")?.focus();
  }

  function closeSettings() {
    state.settingsOpen = false;
    app.classList.remove("settings-open");
    $("assistantSettingsSurface").hidden = true;
    $("assistantMain").removeAttribute("aria-hidden");
    $("assistantMain").inert = false;
    const focusTarget = state.settingsReturnFocus;
    state.settingsReturnFocus = null;
    if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus({ preventScroll: true });
  }

  function bindSettings() {
    $("themeSelect")?.addEventListener("change", (event) => savePreference("theme", event.target.value));
    $("densitySelect")?.addEventListener("change", (event) => savePreference("density", event.target.value));
    $("motionSelect")?.addEventListener("change", (event) => savePreference("motion", event.target.value));
    $("sendModeSelect")?.addEventListener("change", (event) => savePreference("sendMode", event.target.value));
    $("assistantModelSelect")?.addEventListener("change", (event) => setModelMode(event.target.value));
    $("assistantModelSelectSettings")?.addEventListener("change", (event) => setModelMode(event.target.value));
    $("deepseekThinkingToggle")?.addEventListener("change", (event) => {
      state.deepseekThinking = !!event.target.checked;
      persistModelMode();
      syncModelControls();
    });
    $("deepseekKeySave")?.addEventListener("click", saveDeepSeekKey);
    $("deepseekKeyDelete")?.addEventListener("click", deleteDeepSeekKey);
    $("deepseekKeyInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); saveDeepSeekKey(); }
    });
    $("resetLayoutButton")?.addEventListener("click", resetLayout);
    $("resetPreferencesButton")?.addEventListener("click", resetPreferences);
    $("clearGeneralAiButton")?.addEventListener("click", clearGeneralAiData);
    $("assistantArchivedSearch")?.addEventListener("input", (event) => setArchivedSearch(event.target.value));
    document.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => setSettingsSection(button.dataset.settingsSection)));
  }

  function logoutFocusableNodes() {
    return [$("cancelLogoutButton"), $("confirmLogoutButton")].filter((node) => node && !node.disabled && !node.hidden);
  }

  function closeLogoutDialog(options = {}) {
    if (state.logoutPending) return;
    const dialog = $("logoutDialog");
    if (!dialog) return;
    state.logoutOpen = false;
    dialog.hidden = true;
    const returnFocus = state.logoutReturnFocus;
    state.logoutReturnFocus = null;
    if (options.restoreFocus !== false && returnFocus && typeof returnFocus.focus === "function") {
      returnFocus.focus({ preventScroll: true });
    }
  }

  function openLogoutDialog() {
    const dialog = $("logoutDialog");
    if (!dialog || state.logoutPending) return;
    state.logoutReturnFocus = document.activeElement;
    setUserMenuOpen(false, { restoreFocus: false });
    $("logoutError").hidden = true;
    state.logoutOpen = true;
    dialog.hidden = false;
    $("cancelLogoutButton")?.focus();
  }

  async function confirmLogout() {
    if (state.logoutPending || !window.STApi || typeof window.STApi.logout !== "function") return;
    const confirmButton = $("confirmLogoutButton");
    const cancelButton = $("cancelLogoutButton");
    const error = $("logoutError");
    state.logoutPending = true;
    if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = "正在退出…"; }
    if (cancelButton) cancelButton.disabled = true;
    if (error) error.hidden = true;
    try {
      await window.STApi.logout();
      clearThemeAccountHint();
      state.user = null;
      state.csrfToken = "";
      window.STApi._token = null;
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
            state.csrfToken = "";
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

  function handleAction(action) {
    if (action === "toggle-sidebar") setSidebarCollapsed(!state.sidebarCollapsed);
    if (action === "toggle-user-menu") setUserMenuOpen(!state.userMenuOpen);
    if (action === "open-settings") openSettings();
    if (action === "close-settings") closeSettings();
    if (action === "open-logout") openLogoutDialog();
    if (action === "open-self-delete") openSelfDeleteDialog();
    if (action === "open-rename") openRenameDialog();
    if (action === "open-password") openPasswordDialog("self", state.user?.handle || "");
  }

  async function start() {
    if (!core) { setGate("页面暂时不可用", "请返回角色聊天后重试。"); return; }
    const current = await getCurrentUser();
    // 本地版没有登录页：拿不到身份时直接给错误提示，绝不跳转。
    if (!current.ok || !current.user) { setGate("暂时无法打开", "请稍后重试。"); return; }
    if (!setUserContext(current.user)) { setGate("暂时无法打开", "请稍后重试。"); return; }
    try {
      await initializeCsrf();
      state.customUrl = await loadCustomUrl();
    } catch (error) {
      setGate("暂时无法打开", "请在设置里配置模型端点后重试。");
      return;
    }
    loadSessions();
    loadModelMode();
    refreshDeepSeekKeyStatus();
    renderSessions();
    renderMessages();
    app.hidden = false;
    gate.hidden = true;
    input.focus();
  }

  $("newChatButton").addEventListener("click", createNewSession);
  $("stopButton").addEventListener("click", stopGeneration);
  form.addEventListener("submit", sendMessage);
  input.addEventListener("input", autoResize);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (state.preferences.sendMode === "ctrl-enter") {
      if (event.ctrlKey && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
      return;
    }
    if (!event.shiftKey && !event.ctrlKey) { event.preventDefault(); form.requestSubmit(); }
  });
  $("cancelLogoutButton")?.addEventListener("click", () => closeLogoutDialog());
  $("confirmLogoutButton")?.addEventListener("click", confirmLogout);
  $("logoutDialog")?.addEventListener("click", (event) => { if (event.target.id === "logoutDialog") closeLogoutDialog(); });
  $("cancelRenameButton")?.addEventListener("click", () => closeRenameDialog());
  $("confirmRenameButton")?.addEventListener("click", confirmRename);
  $("renameDialog")?.addEventListener("click", (event) => { if (event.target.id === "renameDialog") closeRenameDialog(); });
  $("renameInput")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); confirmRename(); } });
  $("cancelPasswordButton")?.addEventListener("click", () => closePasswordDialog());
  $("confirmPasswordButton")?.addEventListener("click", confirmPassword);
  $("passwordDialog")?.addEventListener("click", (event) => { if (event.target.id === "passwordDialog") closePasswordDialog(); });
  $("cancelAdminDeleteButton")?.addEventListener("click", () => closeAdminDeleteDialog());
  $("confirmAdminDeleteButton")?.addEventListener("click", confirmAdminDelete);
  $("adminDeleteDialog")?.addEventListener("click", (event) => { if (event.target.id === "adminDeleteDialog") closeAdminDeleteDialog(); });
  $("adminDeleteInput")?.addEventListener("input", adminDeleteInputChanged);
  $("adminUsersRefresh")?.addEventListener("click", () => refreshAdminUsers());
  $("adminUsersCreateButton")?.addEventListener("click", openAdminCreateDialog);
  $("cancelAdminCreateButton")?.addEventListener("click", () => closeAdminCreateDialog());
  $("confirmAdminCreateButton")?.addEventListener("click", confirmAdminCreate);
  $("adminCreateDialog")?.addEventListener("click", (event) => { if (event.target.id === "adminCreateDialog") closeAdminCreateDialog(); });
  $("cancelSelfDeleteButton")?.addEventListener("click", () => closeSelfDeleteDialog());
  $("confirmSelfDeleteButton")?.addEventListener("click", confirmSelfDelete);
  $("selfDeleteDialog")?.addEventListener("click", (event) => { if (event.target.id === "selfDeleteDialog") closeSelfDeleteDialog(); });
  $("selfDeleteInput")?.addEventListener("input", selfDeleteInputChanged);
  document.addEventListener("click", (event) => {
    const actionNode = event.target.closest("[data-action]");
    if (actionNode) handleAction(actionNode.dataset.action);
    if (state.userMenuOpen && !event.target.closest("#assistantUserMenu, #assistantIdentityButton")) setUserMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
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
    if (state.pending) {
      event.preventDefault();
      stopGeneration();
      return;
    }
    if (state.userMenuOpen) setUserMenuOpen(false);
    else if (state.settingsOpen) closeSettings();
  });

  applySidebarWidth();
  applyPreferences();
  setSidebarCollapsed(state.sidebarCollapsed, { skipPersist: true });
  bindSidebarResize();
  bindInertialScroll(messageArea);
  bindInertialScroll(sessionList);
  bindSettings();
  window.addEventListener("DOMContentLoaded", () => { start().catch(() => setGate("页面暂时不可用", "请返回角色聊天后重试。")); });
})();
