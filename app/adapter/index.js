"use strict";

/*
 * adapter/index.js —— 本地适配层门面
 *
 * 这里提供 **与 SillyTavern 版 window.STApi 同名同签名** 的接口，但背后完全没有服务器：
 *   角色卡 / 聊天记录 / 世界书 / 设置  → adapter/store.js（IndexedDB）
 *   生成                              → adapter/model.js（直连模型接口）
 *   角色文件解包                      → adapter/cards.js
 *
 * 上层页面（integration.js / magic-map.js / assistant.js / app.js）一行都不用改就能跑，
 * 因为原来它们就是对着 STApi 这组方法写的。
 *
 * 已按 integration.js 的真实消费方式逐条核对（见 docs/PORTING.md）：
 *   - init() 必须 resolve，且 _token 必须为真值（旧代码用它当 CSRF 头）
 *   - isAuthRequired() 恒为 false —— 本地版没有登录，任何错误都不该跳登录页
 *   - getChatTemplateStatus() 必须四个字段齐全，否则对话页会卡在模板门
 *   - editWorld() 之后 getWorld() 必须原样返回，否则记忆回滚校验会失败
 *   - importCharacter() 必须返回 {file_name}，且等于 listCharacters() 里的 avatar
 */

(function (global) {
  const Store = global.RoleWorldStore;
  const Model = global.RoleWorldModel;
  const Cards = global.RoleWorldCards;

  const PROFILE_KEY = "profile";
  const SETTINGS_KEY = "settings";
  const FIXTURE_FLAG = "fixture-imported";

  const DEFAULT_PROFILE = Object.freeze({
    handle: "local",
    name: "我",
    admin: false,
    avatar: "",
    created_at: null,
  });

  const DEFAULT_LOCAL_SETTINGS = Object.freeze({
    provider: "deepseek",
    model: "deepseek-flash",
    // 留空表示用所选云端服务商的默认地址；自定义云端服务必须填写地址。
    endpoint: "",
    stream: true,
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 32768,
    // 思考模式（DeepSeek 系）：关掉时既不请求也不显示思维链。
    thinking: false,
    // 首次启动教程是否看过；跟着存档走，导出到新机器不会再弹。
    tutorial_seen: false,
    // 自动记忆：让模型自己用 [[记住: …]] 记要点（agent 式），默认开。
    auto_memory: true,
    // 费用估算单价（元 / 百万 token）。留 0 表示用内置的官方价；填了就按你填的算。
    price_input: 0,
    price_output: 0,
    request_extras: {},
  });

  let booted = null;
  const avatarUrls = new Map();

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function init() {
    if (booted) return booted;
    booted = (async () => {
      await Store.ready();
      await importFixtureOnce();
      await ensureProfile();
      return true;
    })();
    return booted;
  }

  // 测试/演示用的合成数据注入点：window.__ROLEWORLD_FIXTURE__ = {characters, worlds, chats, settings}
  async function importFixtureOnce() {
    const fixture = global.__ROLEWORLD_FIXTURE__;
    if (!fixture || typeof fixture !== "object") return;
    if (await Store.getKV(FIXTURE_FLAG, false)) return;
    for (const card of fixture.characters || []) await Store.putCharacter(card);
    for (const world of fixture.worlds || []) await Store.putWorld(world.name, { entries: world.entries || {} });
    for (const chat of fixture.chats || []) await Store.saveChat(chat.avatar, chat.file_name, chat.messages || []);
    if (fixture.settings) await Store.setKV(SETTINGS_KEY, Object.assign({}, DEFAULT_LOCAL_SETTINGS, fixture.settings));
    await Store.setKV(FIXTURE_FLAG, true);
  }

  async function ensureProfile() {
    const profile = await Store.getKV(PROFILE_KEY, null);
    if (profile && profile.handle) return profile;
    const created = Object.assign({}, DEFAULT_PROFILE, { created_at: new Date().toISOString() });
    await Store.setKV(PROFILE_KEY, created);
    return created;
  }

  async function getProfile() {
    return (await Store.getKV(PROFILE_KEY, null)) || Object.assign({}, DEFAULT_PROFILE);
  }

  async function saveProfile(patch) {
    const merged = Object.assign({}, await getProfile(), patch || {});
    if (!merged.handle) merged.handle = DEFAULT_PROFILE.handle;
    await Store.setKV(PROFILE_KEY, merged);
    return merged;
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  async function getLocalSettings() {
    const stored = await Store.getKV(SETTINGS_KEY, null);
    const settings = Object.assign({}, DEFAULT_LOCAL_SETTINGS, stored || {});
    // Upgrade retired official aliases only; third-party model IDs remain untouched.
    if (settings.provider === "deepseek" && (!settings.endpoint || Model.providerForEndpoint(settings.endpoint) === "deepseek") &&
        ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash-expires-on-0910", "deepseek-chat", "deepseek-reasoner"].includes(settings.model)) {
      settings.model = "deepseek-flash";
    }
    return settings;
  }

  async function saveLocalSettings(patch) {
    const merged = Object.assign({}, await getLocalSettings(), patch || {});
    await Store.setKV(SETTINGS_KEY, merged);
    return merged;
  }

  // 上层页面读的是 SillyTavern 的设置形状；这里合成一个等价对象。
  async function getSettings() {
    const settings = await getLocalSettings();
    const worlds = await Store.listWorlds();
    const oai = {
      custom_url: settings.endpoint || Model.endpointFor(settings),
      custom_include_body: "",
      temperature: settings.temperature,
      top_p: settings.top_p,
      openai_max_tokens: settings.max_tokens,
    };
    return {
      settings: JSON.stringify({ oai_settings: oai, roleworld: settings }),
      world_names: worlds.map((world) => world.name),
    };
  }

  /* ------------------------------------------------------------------ *
   * 密钥
   * ------------------------------------------------------------------ */

  const SECRETS_KEY = "secrets";

  // SillyTavern 的密钥接口形状是 { [key]: [{ id, label, value }] }；本地沿用同一形状，
  // 这样页面里原有的"密钥是否已保存/删除密钥"逻辑不用改。
  async function secretMap() {
    const map = await Store.getKV(SECRETS_KEY, {});
    return map && typeof map === "object" ? map : {};
  }

  async function legacyRead() {
    const map = await secretMap();
    const out = {};
    Object.keys(map).forEach((key) => {
      out[key] = (map[key] || []).map((entry) => ({ id: entry.id, label: entry.label, value: entry.value }));
    });
    return out;
  }

  async function legacyWrite(key, value, label) {
    if (!key) throw new Error("缺少密钥名称");
    const map = await secretMap();
    const entry = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: label || key,
      value: String(value === undefined || value === null ? "" : value),
    };
    map[key] = (map[key] || []).concat([entry]);
    await Store.setKV(SECRETS_KEY, map);
    return { ok: true, id: entry.id };
  }

  async function legacyDelete(key, id) {
    const map = await secretMap();
    const list = (map[key] || []).filter((entry) => !id || entry.id !== id);
    if (list.length) map[key] = list;
    else delete map[key];
    await Store.setKV(SECRETS_KEY, map);
    return { ok: true };
  }

  async function secretValue(key) {
    const map = await secretMap();
    const list = map[key] || [];
    const last = list[list.length - 1];
    return last && last.value ? last.value : "";
  }

  async function readSecret(key) {
    const value = await secretValue(key);
    return value ? { key, value } : null;
  }

  async function writeSecret(key, value) {
    const map = await secretMap();
    map[key] = [{
      id: "s" + Date.now().toString(36),
      label: key,
      value: String(value === undefined || value === null ? "" : value),
    }];
    await Store.setKV(SECRETS_KEY, map);
    return true;
  }

  async function deleteSecret(key) {
    const map = await secretMap();
    delete map[key];
    await Store.setKV(SECRETS_KEY, map);
    return true;
  }

  async function apiKeyFor(provider) {
    return secretValue(Model.secretKeyFor({ provider }));
  }

  /* ------------------------------------------------------------------ *
   * 角色
   * ------------------------------------------------------------------ */

  async function listCharacters() {
    const cards = await Store.listCharacters();
    // 顺手把头像 blob URL 预加载好，页面上那些同步拼 URL 的地方就能直接取到本地地址。
    await Promise.all(cards.map((card) => assetUrl(card.avatar).catch(() => "")));
    return cards.map((card) => ({
      avatar: card.avatar,
      name: String(card.name || card.avatar),
      fav: !!card.fav,
      tags: Array.isArray(card.tags) ? card.tags : [],
      creator: card.creator || card.creatorcomment || "",
      chat: card.avatar,
      date_added: card.date_added || null,
    }));
  }

  async function getCharacter(avatar) {
    const card = await Store.getCharacter(avatar);
    if (!card) throw new Error("角色卡不存在：" + avatar);
    return card;
  }

  async function importCharacter(file, fileType, options) {
    const parsed = await Cards.parse(file, fileType);
    const existing = new Set((await Store.listCharacters()).map((card) => card.avatar));
    const requested = options && options.preserved_name ? options.preserved_name : null;
    const avatar = requested && !existing.has(requested)
      ? requested
      : Cards.avatarForName(parsed.card.name || fileNameStem(file), existing);
    const card = Object.assign({}, parsed.card, {
      avatar,
      name: parsed.card.name || fileNameStem(file),
      date_added: new Date().toISOString(),
      date_last_chat: null,
      user_name: (options && options.user_name) || (await getProfile()).handle,
    });
    card.chat = avatar;
    await Store.putCharacter(card, { file: parsed.image || Cards.placeholderAvatar(card.name) });
    const blob = parsed.image || Cards.placeholderAvatar(card.name);
    if (blob) avatarUrls.set(avatar, global.URL.createObjectURL(blob));
    return { file_name: avatar, avatar, name: card.name };
  }

  function fileNameStem(file) {
    const name = String((file && file.name) || "character");
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  async function deleteCharacter(avatar, deleteChats) {
    await Store.deleteCharacter(avatar, deleteChats !== false);
    const url = avatarUrls.get(avatar);
    if (url) {
      global.URL.revokeObjectURL(url);
      avatarUrls.delete(avatar);
    }
    return { ok: true };
  }

  // 本地头像地址：从 IndexedDB 取原始图片，转成 blob URL 给 <img>/background-image 用。
  async function assetUrl(avatar) {
    if (!avatar) return "";
    if (avatarUrls.has(avatar)) return avatarUrls.get(avatar);
    const blob = await Store.getBlob(Store.avatarBlobId(avatar));
    if (!blob) return "";
    const url = global.URL.createObjectURL(blob);
    avatarUrls.set(avatar, url);
    return url;
  }

  // 同步版本：给还来不及 await 的调用点用（前提是 listCharacters 已经预加载过）。
  function assetUrlSync(avatar) {
    return avatarUrls.get(avatar) || "";
  }

  /* ------------------------------------------------------------------ *
   * 聊天
   * ------------------------------------------------------------------ */

  async function listChats(avatar) {
    return Store.listChats(avatar);
  }

  async function getChat(avatar, fileName) {
    return Store.getChat(avatar, fileName);
  }

  async function saveChat(avatar, fileName, chat) {
    await Store.saveChat(avatar, fileName, chat);
    return { ok: true };
  }

  async function deleteChat(avatar, fileName) {
    await Store.deleteChat(avatar, fileName);
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 世界书 / 记忆书
   * ------------------------------------------------------------------ */

  async function listWorlds() {
    return Store.listWorlds();
  }

  async function getWorld(name) {
    const world = await Store.getWorld(name);
    if (!world) throw new Error("记忆书不存在：" + name);
    return world;
  }

  async function editWorld(name, data) {
    // 必须原样存原样取：上层会用 JSON.stringify 比较回滚前后是否一致。
    await Store.putWorld(name, data || { entries: {} });
    return { ok: true };
  }

  async function deleteWorld(name) {
    await Store.deleteWorld(name);
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 首次模板初始化 / 内置角色包
   * ------------------------------------------------------------------ */

  async function initializeChatTemplate() {
    const pack = global.RoleWorldPacks;
    if (pack && typeof pack.installAll === "function") await pack.installAll({ silent: true });
    return getChatTemplateStatus();
  }

  async function getChatTemplateStatus() {
    const [characters, worlds] = await Promise.all([Store.listCharacters(), Store.listWorlds()]);
    const books = worlds.filter((world) => String(world.name).startsWith("MB "));
    return {
      ready: true,
      memoryBookCount: books.length,
      modelConnectionReady: true,
      initialChatReady: characters.length > 0,
      characters: characters.length,
      books: books.map((world) => world.name),
    };
  }

  /* ------------------------------------------------------------------ *
   * 生成
   * ------------------------------------------------------------------ */

  function settingsForPayload(payload) {
    const source = (payload && payload.chat_completion_source) || "";
    if (source === "deepseek") return { provider: "deepseek" };
    if (source === "custom") return { provider: "custom" };
    return {};
  }

  // 页面在自定义模式下可能把模型名写成字面量 "local"（沿用了旧接口的约定），
  // 这里换成用户实际配置的模型名；端点同理，优先用页面传来的 custom_url。
  function requestOptions(payload, local) {
    const endpoint = (payload && payload.custom_url) || local.endpoint || "";
    // 端点是已知服务商时以端点为准：页面把自定义路径标成 custom，
    // 但用户配的可能是 DeepSeek 官方地址，密钥要按 deepseek 去取。
    const provider = Model.providerForEndpoint(endpoint)
      || settingsForPayload(payload).provider
      || local.provider;
    const payloadModel = payload && payload.model;
    return {
      provider,
      endpoint,
      model: payloadModel && payloadModel !== "local" ? payloadModel : local.model,
      temperature: payload && payload.temperature,
      top_p: payload && payload.top_p,
      max_tokens: payload && payload.max_tokens,
    };
  }

  // 非流式：返回 OpenAI 形状的 JSON，与 SillyTavern 代理的返回一致。
  async function generate(payload, signal) {
    await init();
    const local = await getLocalSettings();
    const options = requestOptions(payload, local);
    const result = await Model.complete(
      Object.assign({}, payload, { stream: false, model: options.model }),
      { settings: options, apiKey: await apiKeyFor(options.provider), signal }
    );
    return {
      model: result.model || options.model || "",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: result.content,
          ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
        },
        finish_reason: result.finish_reason || "stop",
      }],
      usage: result.usage || null,
    };
  }

  // 流式：返回原始 Response，上层的 SSE 解析代码可以原样复用。
  async function generateStream(payload, signal) {
    await init();
    const local = await getLocalSettings();
    const options = requestOptions(payload, local);
    return Model.request(
      Object.assign({}, payload, { stream: true, model: options.model }),
      { settings: options, apiKey: await apiKeyFor(options.provider), signal }
    );
  }

  /* ------------------------------------------------------------------ *
   * 存档
   * ------------------------------------------------------------------ */

  async function exportArchive() {
    const dump = await Store.exportAll();
    return dump;
  }

  async function importArchive(dump, options) {
    return Store.importAll(dump, options);
  }

  async function resetAll() {
    await Store.clearAll();
    await Store.setKV(PROFILE_KEY, Object.assign({}, DEFAULT_PROFILE, { created_at: new Date().toISOString() }));
  }

  /* ------------------------------------------------------------------ *
   * SillyTavern 形状的 STApi 门面
   * ------------------------------------------------------------------ */

  function notAvailable(method) {
    return function () {
      const error = new Error("本地版没有「" + method + "」这个功能");
      error.code = "NOT_AVAILABLE";
      error.authRequired = false;
      return Promise.reject(error);
    };
  }

  const STApi = {
    _token: "local",
    isLocal: true,
    init,
    getCurrentUser: async () => {
      await init();
      const profile = await getProfile();
      return {
        handle: profile.handle,
        name: profile.name,
        admin: false,
        avatar: profile.avatar || "",
      };
    },
    isAuthRequired: () => false,
    listCharacters,
    getCharacter,
    importCharacter,
    deleteCharacter,
    listChats,
    getChat,
    saveChat,
    deleteChat,
    listWorlds,
    getWorld,
    editWorld,
    deleteWorld,
    getSettings,
    getChatTemplateStatus,
    initializeChatTemplate,
    generate,
    generateStream,
    assetUrl,
    assetUrlSync,
    // 账号相关：本地版一律明确失败，绝不假装成功（避免出现"假成功"提示和跳转到不存在的登录页）。
    logout: notAvailable("退出登录"),
    register: notAvailable("注册"),
    changeName: notAvailable("修改昵称"),
    changePassword: notAvailable("修改密码"),
    deleteSelf: notAvailable("注销账户"),
    listUsers: notAvailable("账号列表"),
    createUser: notAvailable("新建账号"),
    promoteUser: notAvailable("提升权限"),
    demoteUser: notAvailable("降级权限"),
    enableUser: notAvailable("启用账号"),
    disableUser: notAvailable("停用账号"),
    deleteUser: notAvailable("删除账号"),
  };

  const Adapter = {
    init,
    STApi,
    store: Store,
    model: Model,
    cards: Cards,
    secrets: {
      get: readSecret,
      set: writeSecret,
      remove: deleteSecret,
      // 页面里原有的 SillyTavern 风格调用
      read: legacyRead,
      write: legacyWrite,
      delete: legacyDelete,
    },
    getProfile,
    saveProfile,
    getLocalSettings,
    saveLocalSettings,
    assetUrl,
    exportArchive,
    importArchive,
    resetAll,
  };

  global.RoleWorld = Adapter;
  global.RoleWorldAdapter = Adapter;
  global.STApi = STApi;
  if (typeof module !== "undefined" && module.exports) module.exports = Adapter;
})(typeof globalThis !== "undefined" ? globalThis : this);
