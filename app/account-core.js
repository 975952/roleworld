"use strict";

/*
 * Task-27A shared account and preference contract.
 *
 * This module is intentionally storage-only and DOM-free.  The pages provide
 * the confirmed /api/users/me identity before calling any user-scoped helper.
 * It never owns chat, character, Memory Book, authentication, or server data.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TASK27A_ACCOUNT_CORE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const VERSION = 1;
  const PREFERENCE_PREFIX = "task27a.preferences.v1.";
  const LEGACY_OWNER_KEY = "task27a.preferences.legacy-owner.v1";
  const GENERAL_AI_PREFIX = "task24.general-ai.v1.";
  const LEGACY_KEYS = Object.freeze({
    preferences: "task25c.preferences",
    sidebarCollapsed: "task25c.sidebar-collapsed",
    sidebarWidth: "task25b.sidebar-width",
    memoryWidth: "task25b.memory-width",
    generalSidebarCollapsed: "task25c.general-sidebar-collapsed",
    generalSidebarWidth: "task25c.general-sidebar-width",
  });
  const ENUMS = Object.freeze({
    theme: ["dark", "light"],
    density: ["comfortable", "compact"],
    motion: ["full", "reduced"],
    sendMode: ["enter", "ctrl-enter"],
    // 界面缩放：整体放大/缩小（含正文与控件）。存字符串，方便与 enumValue 比较。
    scale: ["0.9", "1", "1.1", "1.25", "1.5"],
    // 风格：同一套布局下的不同配色（见 tokens.css）。
    style: ["default", "paper", "ink", "forest", "sakura", "gold"],
    lastSettingsSection: ["appearance", "conversation", "model", "characters", "layout", "about", "local-data"],
  });
  const LIMITS = Object.freeze({
    harrySidebarWidth: [196, 420],
    harryMemoryWidth: [320, 620],
    generalSidebarWidth: [196, 420],
  });
  // Task-28A 公开注册客户端镜像限制（与服务端 config.yaml 默认值一致）。
  const REGISTRATION_DEFAULTS = Object.freeze({
    maxHandleLength: 32,
    maxNameLength: 64,
    minPasswordLength: 1,
    maxPasswordLength: 128,
  });
  // Task-28A 注册端点统一错误合同（服务端 /api/users/register）。
  const REGISTRATION_CODES = Object.freeze([
    "REGISTRATION_DISABLED", "MISSING_FIELDS", "HANDLE_TOO_LONG", "NAME_TOO_LONG",
    "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "INVALID_HANDLE", "HANDLE_TAKEN",
    "ACCOUNT_LIMIT_REACHED", "RATE_LIMITED",
  ]);

  function defaultPreferences(options) {
    const opts = options || {};
    return {
      version: VERSION,
      theme: "dark",
      density: "comfortable",
      motion: opts.prefersReducedMotion === true ? "reduced" : "full",
      sendMode: "enter",
      scale: "1",
      style: "default",
      ambient: false,
      lastSettingsSection: "appearance",
      harry: {
        sidebarCollapsed: false,
        sidebarWidth: 248,
        memoryOpen: false,
        memoryWidth: 420,
      },
      general: {
        sidebarCollapsed: false,
        sidebarWidth: 248,
      },
    };
  }

  function finiteInteger(value, fallback, limits) {
    const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(number)) return fallback;
    const integer = Math.round(number);
    return Math.max(limits[0], Math.min(limits[1], integer));
  }

  function enumValue(value, values, fallback) {
    return values.includes(value) ? value : fallback;
  }

  function boolValue(value, fallback) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  }

  function normalizePreferences(value, options) {
    const raw = value && typeof value === "object" ? value : {};
    const defaults = defaultPreferences(options);
    const harry = raw.harry && typeof raw.harry === "object" ? raw.harry : {};
    const general = raw.general && typeof raw.general === "object" ? raw.general : {};
    return {
      version: VERSION,
      theme: enumValue(raw.theme, ENUMS.theme, defaults.theme),
      density: enumValue(raw.density, ENUMS.density, defaults.density),
      motion: enumValue(raw.motion, ENUMS.motion, defaults.motion),
      sendMode: enumValue(raw.sendMode, ENUMS.sendMode, defaults.sendMode),
      scale: enumValue(String(raw.scale ?? ""), ENUMS.scale, defaults.scale),
      style: enumValue(String(raw.style ?? ""), ENUMS.style, defaults.style),
      ambient: boolValue(raw.ambient, defaults.ambient),
      lastSettingsSection: enumValue(raw.lastSettingsSection, ENUMS.lastSettingsSection, defaults.lastSettingsSection),
      harry: {
        sidebarCollapsed: boolValue(harry.sidebarCollapsed, defaults.harry.sidebarCollapsed),
        sidebarWidth: finiteInteger(harry.sidebarWidth, defaults.harry.sidebarWidth, LIMITS.harrySidebarWidth),
        memoryOpen: boolValue(harry.memoryOpen, defaults.harry.memoryOpen),
        memoryWidth: finiteInteger(harry.memoryWidth, defaults.harry.memoryWidth, LIMITS.harryMemoryWidth),
      },
      general: {
        sidebarCollapsed: boolValue(general.sidebarCollapsed, defaults.general.sidebarCollapsed),
        sidebarWidth: finiteInteger(general.sidebarWidth, defaults.general.sidebarWidth, LIMITS.generalSidebarWidth),
      },
    };
  }

  function storageKeyForUser(handle) {
    const safe = String(handle || "").trim();
    return safe ? `${PREFERENCE_PREFIX}${encodeURIComponent(safe)}` : "";
  }

  function generalAiKeyForUser(handle) {
    const safe = String(handle || "").trim();
    return safe ? `${GENERAL_AI_PREFIX}${encodeURIComponent(safe)}` : "";
  }

  function legacyOwnerValueForUser(handle) {
    const safe = String(handle || "").trim();
    return safe ? encodeURIComponent(safe) : "";
  }

  function safeGet(storage, key) {
    if (!storage || !key) return null;
    try { return storage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(storage, key, value) {
    if (!storage || !key) return false;
    try { storage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function safeRemove(storage, key) {
    if (!storage || !key) return false;
    try { storage.removeItem(key); return true; } catch (_) { return false; }
  }

  function parseJson(value, fallback) {
    if (typeof value !== "string" || !value.trim()) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  // Task-30E：把时间戳/日期字符串格式化为本地可读时间；无效输入返回 fallback。
  function formatTimestamp(value, fallback) {
    const fb = fallback || "未知";
    let date = null;
    if (typeof value === "number" && Number.isFinite(value)) date = new Date(value);
    else if (typeof value === "string" && value.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) date = parsed;
    }
    if (!date || Number.isNaN(date.getTime())) return fb;
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function parseLegacyBoolean(value) {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }

  function readLegacyPreferences(storage, options) {
    const defaults = defaultPreferences(options);
    const old = parseJson(safeGet(storage, LEGACY_KEYS.preferences), {});
    const raw = {
      theme: old && old.theme,
      density: old && old.density,
      motion: old && old.motion,
      sendMode: old && old.sendMode,
      harry: {
        sidebarCollapsed: parseLegacyBoolean(safeGet(storage, LEGACY_KEYS.sidebarCollapsed)),
        sidebarWidth: safeGet(storage, LEGACY_KEYS.sidebarWidth),
        memoryWidth: safeGet(storage, LEGACY_KEYS.memoryWidth),
      },
      general: {
        sidebarCollapsed: parseLegacyBoolean(safeGet(storage, LEGACY_KEYS.generalSidebarCollapsed)),
        sidebarWidth: safeGet(storage, LEGACY_KEYS.generalSidebarWidth),
      },
    };
    const hasLegacy = [
      LEGACY_KEYS.preferences,
      LEGACY_KEYS.sidebarCollapsed,
      LEGACY_KEYS.sidebarWidth,
      LEGACY_KEYS.memoryWidth,
      LEGACY_KEYS.generalSidebarCollapsed,
      LEGACY_KEYS.generalSidebarWidth,
    ].some((key) => safeGet(storage, key) !== null);
    return { preferences: normalizePreferences(raw, options), hasLegacy, defaults };
  }

  function readPreferences(storage, handle, options) {
    const key = storageKeyForUser(handle);
    const defaults = defaultPreferences(options);
    if (!key) return { preferences: defaults, key: "", migrated: false, storageAvailable: false };

    const existing = parseJson(safeGet(storage, key), null);
    if (existing && typeof existing === "object") {
      return { preferences: normalizePreferences(existing, options), key, migrated: false, storageAvailable: true };
    }

    const legacy = readLegacyPreferences(storage, options);
    const owner = safeGet(storage, LEGACY_OWNER_KEY);
    let preferences = defaults;
    let migrated = false;

    // Only the first confirmed user may claim legacy keys.  Once an owner is
    // present, a later user never inherits the first user's old layout.
    if (!owner) {
      safeSet(storage, LEGACY_OWNER_KEY, legacyOwnerValueForUser(handle));
      if (legacy.hasLegacy) {
        preferences = legacy.preferences;
        migrated = true;
      }
    }

    const persisted = safeSet(storage, key, JSON.stringify(preferences));
    return { preferences, key, migrated, storageAvailable: persisted || safeGet(storage, key) !== null };
  }

  function writePreferences(storage, handle, value) {
    const key = storageKeyForUser(handle);
    if (!key) return { ok: false, key: "", preferences: defaultPreferences() };
    const preferences = normalizePreferences(value);
    return { ok: safeSet(storage, key, JSON.stringify(preferences)), key, preferences };
  }

  function removePreferences(storage, handle) {
    const key = storageKeyForUser(handle);
    return { ok: safeRemove(storage, key), key };
  }

  function clearGeneralAi(storage, handle) {
    const key = generalAiKeyForUser(handle);
    const existed = safeGet(storage, key) !== null;
    return { ok: !existed || safeRemove(storage, key), key, existed };
  }

  function localDataTargets(storage, handle) {
    const generalKey = generalAiKeyForUser(handle);
    return {
      generalAiKey: generalKey,
      hasGeneralAi: !!generalKey && safeGet(storage, generalKey) !== null,
      preferencesKey: storageKeyForUser(handle),
    };
  }

  function identityModel(user) {
    const source = user && typeof user === "object" ? user : {};
    const handle = typeof source.handle === "string" ? source.handle.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const avatar = typeof source.avatar === "string" && isValidAvatar(source.avatar) ? source.avatar : "";
    return {
      handle,
      name,
      displayName: name || handle || "用户",
      avatar,
      isAdmin: source.admin === true,
      roleLabel: source.admin === true ? "管理员" : "用户",
    };
  }

  function isValidAvatar(value) {
    return typeof value === "string" && value.length <= 2_000_000 && /^data:image\/[a-z0-9.+-]+(?:;[^,]+)?,/i.test(value);
  }

  function classifyLogoutError(error) {
    const status = Number(error && error.status);
    if (error && error.name === "AbortError") return "network";
    if (error && (error.code === "NETWORK_ERROR" || error.code === "LOGOUT_NETWORK")) return "network";
    if (status === 401 || status === 403) return "auth";
    if (status >= 500) return "server";
    if (error && error.message) return "network";
    return "unknown";
  }

  // Task-28A 统一账户错误文案：注册错误码 + SillyTavern 账户端点 error 字符串。
  function accountErrorLabel(status, code) {
    const s = Number(status);
    const map = {
      REGISTRATION_DISABLED: "公开注册当前已关闭，请联系管理员。",
      MISSING_FIELDS: "请填写必填项。",
      HANDLE_TOO_LONG: "档案名过长。",
      NAME_TOO_LONG: "显示名过长。",
      PASSWORD_TOO_SHORT: "密钥不能为空。",
      PASSWORD_TOO_LONG: "密钥过长。",
      INVALID_HANDLE: "档案名包含无效字符，仅支持字母、数字和连字符。",
      HANDLE_TAKEN: "该档案名已被占用。",
      ACCOUNT_LIMIT_REACHED: "账号数量已达上限。",
      RATE_LIMITED: "操作过于频繁，请稍后再试。",
      "User not found": "账户不存在。",
      "User is disabled": "账户已停用。",
      "Incorrect password": "原密钥不正确。",
      "Incorrect credentials": "档案名或密钥不正确。",
      Unauthorized: "没有执行该操作的权限。",
      "User already exists": "该账户已存在。",
      "Missing required fields": "请填写必填项。",
      "Invalid handle": "档案名包含无效字符。",
      "Cannot disable yourself": "不能停用当前登录的账户。",
      "Cannot demote yourself": "不能对自己执行该操作。",
      "Cannot delete yourself": "不能删除当前登录的账户。",
      "CANNOT_DELETE_DEFAULT": "默认账户不能注销。",
      "INCORRECT_PASSWORD": "密钥不正确。",
      "LAST_ADMIN": "最后一个管理员账户不能注销或降级。",
      "SELF_DELETE_DISABLED": "自助注销当前已关闭，请联系管理员。",
    };
    if (code && Object.hasOwn(map, code)) return map[code];
    if (code && String(code).includes("default user")) return "默认账户不能删除。";
    if (code && String(code).startsWith("Cannot")) return "不能对该账户执行此操作。";
    if (s === 401) return "登录状态已失效，请重新登录。";
    if (s === 403) return "没有执行该操作的权限。";
    if (s === 404) return "账户不存在。";
    if (s === 409) return "该账户已存在。";
    if (s === 429) return "操作过于频繁，请稍后再试。";
    return "操作失败，请重试。";
  }

  return {
    VERSION,
    PREFERENCE_PREFIX,
    LEGACY_OWNER_KEY,
    GENERAL_AI_PREFIX,
    LEGACY_KEYS,
    ENUMS,
    LIMITS,
    REGISTRATION_DEFAULTS,
    REGISTRATION_CODES,
    defaultPreferences,
    normalizePreferences,
    storageKeyForUser,
    generalAiKeyForUser,
    legacyOwnerValueForUser,
    readLegacyPreferences,
    readPreferences,
    writePreferences,
    removePreferences,
    clearGeneralAi,
    localDataTargets,
    identityModel,
    isValidAvatar,
    classifyLogoutError,
    accountErrorLabel,
    formatTimestamp,
    parseJson,
  };
});
