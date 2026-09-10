"use strict";

/*
 * adapter/store.js —— 本地数据层（零后端）
 *
 * 设计目标
 *   1. 一个接口，多个后端：浏览器用 IndexedDB，桌面端（Tauri）/手机端（Capacitor）
 *      以后换成文件系统实现时，上层代码不用改。
 *   2. 结构沿用 SillyTavern 的数据形状（角色卡、聊天 JSONL、世界书 entries），
 *      这样从 SillyTavern 迁移过来的存档可以直接读，导出也能被 ST 读回。
 *   3. 可在 Node 里跑：没有 indexedDB 时自动退化成内存后端，便于无浏览器测试。
 *
 * 数据模型
 *   characters  keyPath=avatar                 { avatar, name, data:{...}, ...卡片字段 }
 *   chats       keyPath=[avatar, file_name]    { avatar, file_name, messages:[...], meta:{} }
 *   worlds      keyPath=name                   { name, entries:{ uid: {...} } }
 *   kv          keyPath=k                      { k, v }  —— 设置 / 档案 / 界面偏好
 *   blobs       keyPath=id                     { id, blob, type } —— 原始卡片文件、头像
 */

(function (global) {
  const DB_NAME = "roleworld";
  const DB_VERSION = 1;

  const STORE_SPEC = {
    characters: { keyPath: ["avatar"] },
    chats: { keyPath: ["avatar", "file_name"] },
    worlds: { keyPath: ["name"] },
    kv: { keyPath: ["k"] },
    blobs: { keyPath: ["id"] },
  };

  const STORE_NAMES = Object.keys(STORE_SPEC);

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function clone(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function hasIndexedDB() {
    try {
      return typeof global.indexedDB !== "undefined" && global.indexedDB !== null;
    } catch (_) {
      return false;
    }
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 请求失败"));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB 事务被中断"));
      tx.onerror = () => reject(tx.error || new Error("IndexedDB 事务失败"));
    });
  }

  /* ------------------------------------------------------------------ *
   * IndexedDB 后端
   * ------------------------------------------------------------------ */

  function createIdbBackend() {
    let db = null;

    function open() {
      return new Promise((resolve, reject) => {
        const request = global.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const instance = request.result;
          STORE_NAMES.forEach((name) => {
            if (instance.objectStoreNames.contains(name)) return;
            const spec = STORE_SPEC[name];
            instance.createObjectStore(name, { keyPath: spec.keyPath.length === 1 ? spec.keyPath[0] : spec.keyPath });
          });
        };
        request.onsuccess = () => {
          db = request.result;
          db.onversionchange = () => {
            try { db.close(); } catch (_) { /* 另一个标签页要求升级，放弃连接 */ }
            db = null;
          };
          resolve();
        };
        request.onerror = () => reject(request.error || new Error("无法打开本地数据库"));
        request.onblocked = () => reject(new Error("本地数据库被其它标签页占用，请关闭其它页面后重试"));
      });
    }

    function tx(storeName, mode) {
      if (!db) throw new Error("本地数据库尚未打开");
      return db.transaction(storeName, mode).objectStore(storeName);
    }

    return {
      kind: "indexeddb",
      open,
      async close() {
        if (db) { try { db.close(); } catch (_) { /* 已关闭 */ } db = null; }
      },
      async put(storeName, value) {
        const store = tx(storeName, "readwrite");
        store.put(value);
        await transactionDone(store.transaction);
        return value;
      },
      async get(storeName, key) {
        return requestToPromise(tx(storeName, "readonly").get(key));
      },
      async getAll(storeName) {
        return requestToPromise(tx(storeName, "readonly").getAll());
      },
      async delete(storeName, key) {
        const store = tx(storeName, "readwrite");
        store.delete(key);
        await transactionDone(store.transaction);
      },
      async clear(storeName) {
        const store = tx(storeName, "readwrite");
        store.clear();
        await transactionDone(store.transaction);
      },
      async keys(storeName) {
        return requestToPromise(tx(storeName, "readonly").getAllKeys());
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 内存后端（Node 测试 / IndexedDB 不可用时兜底）
   * ------------------------------------------------------------------ */

  function createMemoryBackend() {
    const stores = {};
    STORE_NAMES.forEach((name) => { stores[name] = new Map(); });

    function keyOf(storeName, key) {
      const spec = STORE_SPEC[storeName];
      if (spec.keyPath.length === 1) return String(key);
      return (Array.isArray(key) ? key : [key]).map((part) => String(part)).join("\u0000");
    }

    function keyOfRecord(storeName, value) {
      const spec = STORE_SPEC[storeName];
      if (spec.keyPath.length === 1) return String(value[spec.keyPath[0]]);
      return spec.keyPath.map((field) => String(value[field])).join("\u0000");
    }

    return {
      kind: "memory",
      async open() { /* 无需打开 */ },
      async close() { /* 无需关闭 */ },
      async put(storeName, value) {
        stores[storeName].set(keyOfRecord(storeName, value), clone(value));
        return clone(value);
      },
      async get(storeName, key) {
        const found = stores[storeName].get(keyOf(storeName, key));
        return found === undefined ? undefined : clone(found);
      },
      async getAll(storeName) {
        return Array.from(stores[storeName].values()).map(clone);
      },
      async delete(storeName, key) {
        stores[storeName].delete(keyOf(storeName, key));
      },
      async clear(storeName) {
        stores[storeName].clear();
      },
      async keys(storeName) {
        return Array.from(stores[storeName].keys());
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 公开接口
   * ------------------------------------------------------------------ */

  let backend = null;
  let opening = null;

  function ready() {
    if (backend) return Promise.resolve(backend);
    if (opening) return opening;
    opening = (async () => {
      // 桌面端优先：数据存成磁盘上的普通文件，用户能直接看见和备份。
      const desktop = global.RoleWorldDesktop;
      if (desktop && typeof desktop.hasTauri === "function" && desktop.hasTauri()) {
        try {
          const fs = desktop.createDesktopBackend();
          await fs.open();
          backend = fs;
          return backend;
        } catch (error) {
          backend = createMemoryBackend();
          backend.degradedFrom = "tauri-fs";
          backend.reason = error && error.message ? error.message : String(error);
          return backend;
        }
      }
      if (hasIndexedDB()) {
        const idb = createIdbBackend();
        try {
          await idb.open();
          backend = idb;
          return backend;
        } catch (error) {
          // 隐私模式 / 配额拒绝：退化成内存后端，页面仍可用，只是不落盘。
          backend = createMemoryBackend();
          backend.degradedFrom = "indexeddb";
          backend.reason = error && error.message ? error.message : String(error);
          return backend;
        }
      }
      backend = createMemoryBackend();
      return backend;
    })();
    return opening;
  }

  function setBackendForTests(candidate) {
    backend = candidate;
    opening = candidate ? Promise.resolve(candidate) : null;
  }

  function resetForTests() {
    backend = null;
    opening = null;
  }

  async function put(storeName, value) {
    const db = await ready();
    return db.put(storeName, clone(value));
  }

  async function get(storeName, key) {
    const db = await ready();
    return db.get(storeName, key);
  }

  async function getAll(storeName) {
    const db = await ready();
    return db.getAll(storeName);
  }

  async function remove(storeName, key) {
    const db = await ready();
    return db.delete(storeName, key);
  }

  async function clear(storeName) {
    const db = await ready();
    return db.clear(storeName);
  }

  /* ---------------------------- 角色卡 ---------------------------- */

  async function listCharacters() {
    const rows = await getAll("characters");
    return rows.map((row) => clone(row)).sort(byName);
  }

  async function getCharacter(avatar) {
    return (await get("characters", avatar)) || null;
  }

  async function putCharacter(card, options) {
    if (!card || !card.avatar) throw new Error("角色卡缺少 avatar 字段");
    await put("characters", card);
    const file = options && options.file;
    if (file) await putBlob(avatarBlobId(card.avatar), file);
    return card;
  }

  async function deleteCharacter(avatar, deleteChats) {
    await remove("characters", avatar);
    await removeBlob(avatarBlobId(avatar));
    if (deleteChats !== false) {
      const chats = await listChats(avatar);
      await Promise.all(chats.map((row) => remove("chats", [avatar, row.file_name])));
    }
  }

  function byName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN");
  }

  /* ---------------------------- 聊天记录 ---------------------------- */

  async function listChats(avatar) {
    const rows = await getAll("chats");
    return rows
      .filter((row) => row.avatar === avatar)
      .map((row) => summarizeChat(row))
      .sort((a, b) => String(b.last_mes || "").localeCompare(String(a.last_mes || "")));
  }

  function summarizeChat(row) {
    const messages = Array.isArray(row.messages) ? row.messages : [];
    const last = messages.length ? messages[messages.length - 1] : null;
    const first = messages.find((message) => message && message.mes) || null;
    // SillyTavern 把对话元数据放在第一行；沿用同一约定，导出后 ST 也能读。
    const header = messages[0] && typeof messages[0] === "object" ? messages[0] : {};
    const metadata = header.chat_metadata && typeof header.chat_metadata === "object" ? header.chat_metadata : {};
    return {
      avatar: row.avatar,
      file_name: row.file_name,
      file_id: row.file_name,
      mes: first ? first.mes : "",
      last_mes: last ? last.send_date || "" : "",
      chat_items: messages.filter((message) => !message.is_system).length,
      chat_metadata: clone(metadata),
      create_date: row.meta && row.meta.create_date ? row.meta.create_date : null,
    };
  }

  async function getChat(avatar, fileName) {
    const row = await get("chats", [avatar, fileName]);
    if (!row) return [];
    return clone(Array.isArray(row.messages) ? row.messages : []);
  }

  async function saveChat(avatar, fileName, messages) {
    const existing = await get("chats", [avatar, fileName]);
    const record = {
      avatar,
      file_name: fileName,
      messages: clone(Array.isArray(messages) ? messages : []),
      meta: {
        create_date: existing && existing.meta ? existing.meta.create_date : new Date().toISOString(),
        update_date: new Date().toISOString(),
      },
    };
    await put("chats", record);
    return { ok: true, file_name: fileName };
  }

  async function deleteChat(avatar, fileName) {
    await remove("chats", [avatar, fileName]);
    return { ok: true };
  }

  /* ---------------------------- 世界书 ---------------------------- */

  async function listWorlds() {
    const rows = await getAll("worlds");
    return rows
      .map((row) => ({ file_id: row.name, name: row.name }))
      .sort((a, b) => byName(a, b));
  }

  async function getWorld(name) {
    const row = await get("worlds", name);
    if (!row) return null;
    return { entries: clone(row.entries || {}) };
  }

  async function putWorld(name, data) {
    const entries = data && data.entries ? data.entries : {};
    await put("worlds", { name, entries: clone(entries) });
    return { ok: true };
  }

  async function deleteWorld(name) {
    await remove("worlds", name);
    return { ok: true };
  }

  /* ---------------------------- 键值对 ---------------------------- */

  async function getKV(key, fallback) {
    const row = await get("kv", key);
    if (row === undefined || row === null) return fallback === undefined ? null : fallback;
    return clone(row.v);
  }

  async function setKV(key, value) {
    await put("kv", { k: key, v: clone(value) });
    return value;
  }

  async function deleteKV(key) {
    await remove("kv", key);
  }

  /* ---------------------------- 二进制 ---------------------------- */

  async function putBlob(id, blob) {
    await put("blobs", { id, blob, type: blob && blob.type ? blob.type : "" });
    return id;
  }

  async function getBlob(id) {
    const row = await get("blobs", id);
    return row ? row.blob : null;
  }

  async function removeBlob(id) {
    await remove("blobs", id);
  }

  function avatarBlobId(avatar) {
    return "avatar:" + avatar;
  }

  /* ---------------------------- 存档导出/导入 ---------------------------- */

  const EXPORT_STORES = ["characters", "chats", "worlds", "kv"];

  async function exportAll() {
    const dump = { format: "roleworld-archive", version: 1, exported_at: new Date().toISOString(), data: {} };
    for (const name of EXPORT_STORES) dump.data[name] = await getAll(name);
    // 头像/原始卡片文件单独走二进制，JSON 里只留索引。
    const blobKeys = await (await ready()).keys("blobs");
    dump.blobs = [];
    for (const id of blobKeys) {
      const blob = await getBlob(id);
      if (!blob) continue;
      dump.blobs.push({
        id,
        type: blob.type || "",
        base64: await blobToBase64(blob),
      });
    }
    return dump;
  }

  async function importAll(dump, options) {
    const mode = options && options.mode === "merge" ? "merge" : "replace";
    if (!dump || dump.format !== "roleworld-archive") throw new Error("不是有效的角色世界存档");
    if (mode === "replace") await clearAll();
    for (const name of EXPORT_STORES) {
      const rows = (dump.data && dump.data[name]) || [];
      for (const row of rows) await put(name, row);
    }
    for (const entry of dump.blobs || []) {
      const blob = await base64ToBlob(entry.base64, entry.type);
      await putBlob(entry.id, blob);
    }
    return {
      characters: (dump.data && dump.data.characters ? dump.data.characters.length : 0),
      chats: (dump.data && dump.data.chats ? dump.data.chats.length : 0),
      worlds: (dump.data && dump.data.worlds ? dump.data.worlds.length : 0),
    };
  }

  async function clearAll() {
    for (const name of STORE_NAMES) await clear(name);
  }

  function blobToBase64(blob) {
    if (typeof blob.arrayBuffer === "function" && typeof global.btoa === "function") {
      return blob.arrayBuffer().then((buffer) => bytesToBase64(new Uint8Array(buffer)));
    }
    if (typeof global.btoa === "function") {
      return new Promise((resolve, reject) => {
        const reader = new global.FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
        reader.readAsDataURL(blob);
      });
    }
    throw new Error("当前环境无法读取二进制数据");
  }

  async function base64ToBlob(base64, type) {
    const bytes = base64ToBytes(base64);
    if (typeof global.Blob === "function") return new global.Blob([bytes], { type: type || "application/octet-stream" });
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = global.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const Store = {
    ready,
    resetForTests,
    setBackendForTests,
    createMemoryBackend,
    listCharacters,
    getCharacter,
    putCharacter,
    deleteCharacter,
    listChats,
    getChat,
    saveChat,
    deleteChat,
    summarizeChat,
    listWorlds,
    getWorld,
    putWorld,
    deleteWorld,
    getKV,
    setKV,
    deleteKV,
    putBlob,
    getBlob,
    removeBlob,
    avatarBlobId,
    exportAll,
    importAll,
    clearAll,
    _raw: { put, get, getAll, remove, clear },
  };

  global.RoleWorldStore = Store;
  if (typeof module !== "undefined" && module.exports) module.exports = Store;
})(typeof globalThis !== "undefined" ? globalThis : this);
