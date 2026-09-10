"use strict";

/*
 * adapter/desktop.js —— 桌面端（Tauri）数据后端
 *
 * 与 store.js 里的 IndexedDB 后端接口完全一致（open/close/put/get/getAll/delete/clear/keys），
 * 但数据落成磁盘上看得见的普通文件：
 *
 *   <应用数据目录>/data/characters/<头像>.json
 *   <应用数据目录>/data/chats/<头像>/<对话>.json
 *   <应用数据目录>/data/worlds/<记忆书>.json
 *   <应用数据目录>/data/kv/<键>.json
 *   <应用数据目录>/data/blobs/<id>            图片等二进制，base64 存取
 *
 * 好处是用户可以直接用资源管理器备份、用编辑器查看、用 Git 管理自己的角色数据 ——
 * 这是桌面端相对网页版唯一真正重要的差别。
 */

(function (global) {
  function invoke(command, args) {
    const api = global.__TAURI__;
    if (!api || !api.core || typeof api.core.invoke !== "function") {
      return Promise.reject(new Error("桌面运行环境不可用"));
    }
    return api.core.invoke(command, args);
  }

  function hasTauri() {
    const api = global.__TAURI__;
    return !!(api && api.core && typeof api.core.invoke === "function");
  }

  // 文件名里不能出现的字符换成下划线；中文、空格、括号、破折号都保留。
  function safeName(value) {
    return String(value)
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 150) || "_";
  }

  function parse(stdout) {
    if (stdout === null || stdout === undefined) return null;
    try {
      return JSON.parse(stdout);
    } catch (_) {
      return null;
    }
  }

  function createDesktopBackend() {
    const keyOf = {
      characters: (key) => "characters/" + safeName(key) + ".json",
      chats: (key) => "chats/" + safeName(key[0]) + "/" + safeName(key[1]) + ".json",
      worlds: (key) => "worlds/" + safeName(key) + ".json",
      kv: (key) => "kv/" + safeName(key) + ".json",
      blobs: (key) => "blobs/" + safeName(key),
    };
    const prefixOf = {
      characters: "characters",
      chats: "chats",
      worlds: "worlds",
      kv: "kv",
      blobs: "blobs",
    };

    function pathFor(storeName, key) {
      return keyOf[storeName](key);
    }

    return {
      kind: "tauri-fs",
      async open() {
        if (!hasTauri()) throw new Error("桌面运行环境不可用");
        return true;
      },
      async close() { /* 无长连接 */ },
      async put(storeName, value) {
        if (storeName === "blobs") {
          const base64 = await blobToBase64(value.blob);
          await invoke("rw_write_binary", { name: pathFor(storeName, value.id), base64 });
          return value;
        }
        const key = storeName === "chats" ? [value.avatar, value.file_name] : keyField(storeName, value);
        await invoke("rw_write_text", { name: pathFor(storeName, key), contents: JSON.stringify(value) });
        return value;
      },
      async get(storeName, key) {
        if (storeName === "blobs") {
          const base64 = await invoke("rw_read_binary", { name: pathFor(storeName, key) });
          if (!base64) return undefined;
          return { id: key, blob: base64ToBlob(base64), type: "" };
        }
        const text = await invoke("rw_read_text", { name: pathFor(storeName, key) });
        return parse(text) === null ? undefined : parse(text);
      },
      async getAll(storeName) {
        const files = await invoke("rw_list", { prefix: prefixOf[storeName] });
        const rows = [];
        for (const file of files) {
          if (storeName === "blobs") {
            const base64 = await invoke("rw_read_binary", { name: file });
            if (base64) rows.push({ id: idFromPath(file), blob: base64ToBlob(base64), type: "" });
            continue;
          }
          const text = await invoke("rw_read_text", { name: file });
          const value = parse(text);
          if (value) rows.push(value);
        }
        return rows;
      },
      async delete(storeName, key) {
        await invoke("rw_delete", { name: pathFor(storeName, key) });
      },
      async clear(storeName) {
        await invoke("rw_clear", { prefix: prefixOf[storeName] });
      },
      async keys(storeName) {
        const files = await invoke("rw_list", { prefix: prefixOf[storeName] });
        if (storeName !== "blobs") return files.map(idFromPath);
        return files.map(idFromPath);
      },
      async dataDir() {
        return invoke("rw_data_dir", {});
      },
    };
  }

  function keyField(storeName, value) {
    if (storeName === "characters") return value.avatar;
    if (storeName === "worlds") return value.name;
    if (storeName === "kv") return value.k;
    return value.id;
  }

  // "chats/Harry Potter (EN)/chat_1.json" → ["Harry Potter (EN)", "chat_1"]
  function idFromPath(filePath) {
    const parts = String(filePath).split("/");
    const last = parts[parts.length - 1].replace(/\.json$/, "");
    if (parts[0] === "chats" && parts.length >= 3) return [parts[1], last];
    return last;
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(binary);
  }

  function base64ToBlob(base64) {
    const binary = global.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new global.Blob([bytes]);
  }

  const Desktop = { createDesktopBackend, hasTauri, safeName };

  global.RoleWorldDesktop = Desktop;
  if (typeof module !== "undefined" && module.exports) module.exports = Desktop;
})(typeof globalThis !== "undefined" ? globalThis : this);
