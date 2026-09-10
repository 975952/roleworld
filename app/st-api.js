"use strict";

/*
 * st-api.js — SillyTavern 1.18.0 同源契约层（已逐条对照本机源码核对）
 *
 * 核对来源（C:\novel-llm\sillytavern）：
 *   src/server-main.js:192-205        GET  /csrf-token → {token}；POST 需 x-csrf-token 头
 *   src/endpoints/characters.js:1464  POST /api/characters/all      → 卡片数组
 *   src/endpoints/characters.js:1497  POST /api/characters/chats    {avatar_url, simple:true}
 *   src/endpoints/chats.js:517        POST /api/chats/get           {avatar_url, file_name} → JSONL 数组
 *   src/endpoints/worldinfo.js:39     POST /api/worldinfo/list      → [{file_id,name}]
 *   src/endpoints/worldinfo.js:71     POST /api/worldinfo/get       {name} → {entries:{uid:{...}}}
 *   src/endpoints/worldinfo.js:81     POST /api/worldinfo/delete    {name} → HTTP 200
 *   src/endpoints/worldinfo.js:134    POST /api/worldinfo/edit      {name, data:{entries}} 整文件替换
 *   src/endpoints/settings.js:219     POST /api/settings/get        → {settings:"<JSON 字符串>", world_names:[...]}
 *
 * Task-22 新增（对照本机 ST 1.18.0 源码）：
 *   src/endpoints/characters.js:1478  POST /api/characters/get      {avatar_url} → 完整卡（含 data.*）
 *   src/endpoints/chats.js:470        POST /api/chats/save          {avatar_url, file_name, chat[], force}
 *   src/endpoints/backends/chat-completions.js:2157  POST /api/backends/chat-completions/generate
 *                                    {messages, chat_completion_source:'custom', custom_url, stream:false, ...采样}
 */

(function () {
  function authRequiredError(status) {
    const err = new Error("请先登录");
    err.code = "AUTH_REQUIRED";
    err.authRequired = true;
    if (Number.isFinite(status)) err.status = status;
    return err;
  }

  function isLoginRedirect(res) {
    try { return new URL(res.url, window.location.href).pathname === "/login"; } catch (_) { return false; }
  }

  const STApi = {
    _token: null,

    async init() {
      const res = await fetch("/csrf-token", { credentials: "same-origin" });
      if (res.status === 401 || res.status === 403 || isLoginRedirect(res)) throw authRequiredError(res.status);
      if (!res.ok) throw new Error(`/csrf-token → HTTP ${res.status}`);
      let data;
      try { data = await res.json(); } catch (_) { throw new Error("CSRF 初始化失败"); }
      if (!data || typeof data.token !== "string" || !data.token) throw new Error("CSRF 初始化失败");
      this._token = data.token;
      return true;
    },

    _post(path, body, requestOptions = {}) {
      if (!this._token) throw new Error("STApi 未初始化：先调用 init()");
      const signal = requestOptions.signal || null;
      const attempt = () => {
        const options = {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": this._token,
          },
          body: JSON.stringify(body || {}),
        };
        if (signal) options.signal = signal;
        return fetch(path, options).then(async (res) => {
          if (res.status === 401 || res.status === 403 || isLoginRedirect(res)) throw authRequiredError(res.status);
          if (!res.ok) {
            const err = new Error(`${path} → HTTP ${res.status}`);
            err.status = res.status;
            try {
              const data = await res.json();
              if (data && typeof data.error === "string") err.code = data.error;
            } catch (_) { /* no JSON body */ }
            throw err;
          }
          const text = await res.text();
          try { return JSON.parse(text); } catch { return text; }
        });
      };
      // Task-27H：会话 CSRF 失效（401/403）时刷新一次令牌并重试一次，
      // 与 logout() 的恢复契约一致；刷新失败或重试仍失败才向上抛出。
      return attempt().catch(async (error) => {
        if (!this.isAuthRequired(error) || (signal && signal.aborted)) throw error;
        await this.init();
        return attempt();
      });
    },

    // 当前已登录用户视图（ST 1.18.0 users-private.js）；不读取角色或会话数据。
    // Task-27H：与 _post/logout 同款恢复契约 —— 会话 CSRF 失效（401/403）时
    // 刷新一次令牌并重试一次，避免身份链路瞬时失败导致页面遮罩无法摘除。
    getCurrentUser() {
      const attempt = () => fetch("/api/users/me", { credentials: "same-origin", cache: "no-store" }).then(async (res) => {
        if (res.status === 401 || res.status === 403 || isLoginRedirect(res)) throw authRequiredError(res.status);
        if (!res.ok) throw new Error(`/api/users/me → HTTP ${res.status}`);
        return res.json();
      });
      return attempt().catch(async (error) => {
        if (!STApi.isAuthRequired(error)) throw error;
        await STApi.init();
        return attempt();
      });
    },

    async _logoutRequest() {
      let res;
      try {
        res = await fetch("/api/users/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: this._token ? { "x-csrf-token": this._token } : {},
        });
      } catch (cause) {
        const error = new Error("退出请求失败");
        error.code = "LOGOUT_NETWORK";
        error.cause = cause;
        throw error;
      }
      return res;
    },

    // SillyTavern users-private.js contract: POST, same-origin, CSRF header,
    // empty body, and HTTP 204 on success.  A stale CSRF gets one refresh and
    // one retry only; callers decide whether a confirmed 403 means redirect.
    async logout() {
      let retried = false;
      for (;;) {
        const res = await this._logoutRequest();
        if (res.status === 204) {
          this._token = null;
          return { status: 204 };
        }
        if ((res.status === 401 || res.status === 403) && !retried) {
          retried = true;
          try {
            await this.init();
          } catch (error) {
            error.logoutRetried = true;
            throw error;
          }
          continue;
        }
        const error = new Error("退出请求失败");
        error.status = res.status;
        error.logoutRetried = retried;
        throw error;
      }
    },

    listCharacters() {
      return this._post("/api/characters/all", {});
    },

    // 完整角色卡（含 data.system_prompt / character_book 等），供真实生成组合提示词。
    getCharacter(avatar_url) {
      return this._post("/api/characters/get", { avatar_url });
    },

    listChats(avatar_url, options = {}) {
      const body = { avatar_url, simple: options.simple === true, metadata: options.metadata !== false };
      return this._post("/api/characters/chats", body);
    },

    getChat(avatar_url, file_name, requestOptions = {}) {
      return this._post("/api/chats/get", { avatar_url, file_name }, requestOptions);
    },

    listWorlds() {
      return this._post("/api/worldinfo/list", {});
    },

    getWorld(name) {
      return this._post("/api/worldinfo/get", { name });
    },

    editWorld(name, data) {
      return this._post("/api/worldinfo/edit", { name, data });
    },

    deleteWorld(name) {
      return this._post("/api/worldinfo/delete", { name });
    },

    // Task-29A：multipart 上传 helper。绝不手工设置 Content-Type（浏览器自动生成
    // multipart boundary）；带现有 CSRF 头；401/403 最多刷新一次令牌并重试一次。
    _postMultipart(path, formData, requestOptions = {}) {
      if (!this._token) throw new Error("STApi 未初始化：先调用 init()");
      const signal = requestOptions.signal || null;
      const attempt = () => {
        const options = {
          method: "POST",
          credentials: "same-origin",
          headers: { "x-csrf-token": this._token },
          body: formData,
        };
        if (signal) options.signal = signal;
        return fetch(path, options).then(async (res) => {
          if (res.status === 401 || res.status === 403 || isLoginRedirect(res)) throw authRequiredError(res.status);
          let data = null;
          try { data = await res.json(); } catch (_) { /* no JSON body */ }
          if (!res.ok) {
            const code = data && typeof data.error === "string" ? data.error : "";
            const err = new Error(code || `${path} → HTTP ${res.status}`);
            err.status = res.status;
            if (code) err.code = code;
            throw err;
          }
          return data;
        });
      };
      // 与 _post 同款恢复契约：401/403 刷新一次 CSRF 并重试一次；刷新失败或重试仍失败才抛出。
      return attempt().catch(async (error) => {
        if (!this.isAuthRequired(error) || (signal && signal.aborted)) throw error;
        await this.init();
        return attempt();
      });
    },

    // Task-29A：原生角色文件导入（json/png/charx/yaml/yml）。
    // 只调用 /api/characters/import，绝不调用 /api/characters/create。
    // 导入失败抛错，绝不返回假成功。
    importCharacter(file, fileType, options = {}) {
      const formData = new FormData();
      formData.append("avatar", file);
      formData.append("file_type", fileType);
      if (options.preserved_name) formData.append("preserved_name", String(options.preserved_name));
      if (options.user_name) formData.append("user_name", String(options.user_name));
      return this._postMultipart("/api/characters/import", formData, { signal: options.signal });
    },

    // Task-31D：删除角色卡。delete_chats=true 时同时删除该角色的全部聊天（后端已支持）。
    deleteCharacter(avatar_url, delete_chats) {
      return this._post("/api/characters/delete", { avatar_url, delete_chats: delete_chats !== false });
    },

    // 真实聊天生成（非流式）：复用 SillyTavern 的 custom 源代理端点。
    generate(payload, signal) {
      return this._post("/api/backends/chat-completions/generate", payload, { signal });
    },

    // 聊天保存：整文件 JSONL 数组写回（file_name 不带 .jsonl）。
    saveChat(avatar_url, file_name, chat, force, requestOptions = {}) {
      return this._post("/api/chats/save", { avatar_url, file_name, chat, force: !!force }, requestOptions);
    },

    getSettings() {
      return this._post("/api/settings/get", {});
    },

    // Task-28B: the server always resolves these contracts from the current
    // authenticated user. No handle or target path is accepted client-side.
    getChatTemplateStatus() {
      return this._post("/api/users/chat-template/status", {});
    },

    initializeChatTemplate() {
      return this._post("/api/users/chat-template/initialize", {});
    },

    // Task-28A 账户管理统一 POST：解析后端 error 字符串并保留 status。
    // 与 _post 的差异在于不把最终 401/403 一律折叠成 AUTH_REQUIRED，
    // 而是保留 error.code / status，供调用方区分“会话失效”与“无权限/密码错误”。
    _postAccount(path, body) {
      if (!this._token) throw new Error("STApi 未初始化：先调用 init()");
      const attempt = () => {
        const options = {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "x-csrf-token": this._token },
          body: JSON.stringify(body || {}),
        };
        return fetch(path, options).then(async (res) => {
          let data = null;
          try { data = await res.json(); } catch (_) { /* no JSON body */ }
          if (res.ok) return data;
          const code = data && typeof data.error === "string" ? data.error : "";
          const err = new Error(code || `${path} → HTTP ${res.status}`);
          err.status = res.status;
          if (code) err.code = code;
          if (res.status === 401 || res.status === 403) err.authRequired = true;
          throw err;
        });
      };
      return attempt().catch(async (error) => {
        if (!(error && error.authRequired === true)) throw error;
        await this.init();
        return attempt();
      });
    },

    // 注册：403 = 注册关闭或总量上限（并非“请登录”），因此不做鉴权重试。
    async register(payload) {
      if (!this._token) throw new Error("STApi 未初始化：先调用 init()");
      const res = await fetch("/api/users/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-csrf-token": this._token },
        body: JSON.stringify(payload || {}),
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* no body */ }
      if (res.ok) return data;
      const code = data && typeof data.error === "string" ? data.error : "";
      const err = new Error(code || `注册失败 → HTTP ${res.status}`);
      err.status = res.status;
      if (code) err.code = code;
      throw err;
    },

    // 管理员：账号列表（ST 1.18.0 users-admin.js /get）。
    listUsers() {
      return this._postAccount("/api/users/get", {});
    },

    enableUser(handle) {
      return this._postAccount("/api/users/enable", { handle });
    },

    disableUser(handle) {
      return this._postAccount("/api/users/disable", { handle });
    },

    deleteUser(handle, purge) {
      return this._postAccount("/api/users/delete", { handle, purge: !!purge });
    },

    changeName(handle, name) {
      return this._postAccount("/api/users/change-name", { handle, name });
    },

    changePassword(handle, oldPassword, newPassword) {
      return this._postAccount("/api/users/change-password", { handle, oldPassword, newPassword });
    },

    // Task-30E：自助注销本人账户（users-private.js /delete-self）。
    // 走 _postAccount，复用 CSRF 刷新重试；成功后后端已失效会话。
    deleteSelf(password, purge) {
      return this._postAccount("/api/users/delete-self", { password, purge: purge !== false });
    },

    // 归档对话永久删除（chats.js /delete）：请求 { avatar_url, chatfile: file_name }，
    // 成功返回 { ok:true }；走 _post 复用 CSRF 刷新重试。
    deleteChat(avatar_url, file_name, requestOptions = {}) {
      return this._post("/api/chats/delete", { avatar_url, chatfile: file_name }, requestOptions);
    },

    // 管理员：提升/降级/新建（users-admin.js /promote、/demote、/create）。
    promoteUser(handle) {
      return this._postAccount("/api/users/promote", { handle });
    },

    demoteUser(handle) {
      return this._postAccount("/api/users/demote", { handle });
    },

    createUser(handle, name, password, admin) {
      return this._postAccount("/api/users/create", { handle, name, password, admin: !!admin });
    },

    isAuthRequired(err) {
      return !!(err && (err.authRequired === true || err.code === "AUTH_REQUIRED"));
    },
  };

  window.STApi = STApi;
})();
