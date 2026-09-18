"use strict";

/*
 * adapter/stickers.js —— 表情包（读盘 + 渲染用的 URL + 开关）
 *
 * 目录约定（和内容包同一个风格，"换成自己的那套"只要换目录）：
 *   app/stickers/index.json               { "packs": [ { "id": "mood", "path": "stickers/mood" } ] }
 *   app/stickers/<包>/index.json          { id, label, stamps: [ { id, name, file, tags } ] }
 *   app/stickers/<包>/<文件>              表情图（内置那套是 SVG；PNG/GIF/WebP 一样能用）
 *
 * 为什么表情图不塞进 Store（IndexedDB）里：
 *   内置那套是**随应用发布的静态文件**，本来就该走静态缓存（离线壳也会缓存它们）；
 *   塞进数据库反而要在启动时把几十个文件读成 Blob，白等。用户以后导入的表情才需要落库。
 *
 * 关掉表情系统时（设置里的开关），`availableStamps()` 返回空数组 ——
 * 提示词里就不会出现 [Stickers] 那一段，模型也就不会去写标记。
 */

(function (global) {
  const SETTINGS_KEY = "roleworld.stickers";
  const MANIFEST_URL = "stickers/index.json";

  let cachedPacks = null;
  let loading = null;
  // 上一次 availableStamps() 的结果，给同步渲染用（见 cachedStamps 的注释）。
  let availableCache = [];
  // 用户显式关掉的包（存 id 数组）；空 = 全开。
  let disabled = new Set();

  function settings() {
    const Adapter = global.RoleWorld;
    if (!Adapter || typeof Adapter.getLocalSettings !== "function") return Promise.resolve({});
    return Adapter.getLocalSettings().then((all) => all || {});
  }

  function urlFor(pack, file) {
    const base = pack.path || ("stickers/" + pack.id);
    return base.replace(/\/$/, "") + "/" + String(file || "").replace(/^\//, "");
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(url + " → HTTP " + response.status);
    return response.json();
  }

  /** 读所有表情包（含每张图的 url）。失败就当"没有表情包"，绝不影响启动。 */
  async function load() {
    if (cachedPacks) return cachedPacks;
    if (loading) return loading;
    loading = (async () => {
      let manifest = [];
      try {
        const data = await fetchJson(MANIFEST_URL);
        manifest = Array.isArray(data && data.packs) ? data.packs : [];
      } catch (_) {
        cachedPacks = [];
        return cachedPacks;
      }
      const packs = [];
      for (const entry of manifest) {
        const path = entry.path || ("stickers/" + entry.id);
        try {
          const pack = await fetchJson(path.replace(/\/$/, "") + "/index.json");
          const stamps = (pack.stamps || [])
            .filter((stamp) => stamp && stamp.id && stamp.file)
            .map((stamp) => ({
              id: pack.id + ":" + stamp.id,
              name: stamp.name || stamp.id,
              file: stamp.file,
              url: urlFor({ id: pack.id, path }, stamp.file),
              tags: Array.isArray(stamp.tags) ? stamp.tags.slice() : [],
              packId: pack.id,
            }));
          if (stamps.length) {
            packs.push({
              id: pack.id || entry.id,
              label: pack.label || entry.label || entry.id,
              description: pack.description || entry.description || "",
              path,
              stamps,
            });
          }
        } catch (_) {
          // 单个包坏了就跳过它，别拖垮别的包。
        }
      }
      cachedPacks = packs;
      return cachedPacks;
    })();
    return loading;
  }

  /** 用户开关：关掉的包不参与（既不进提示词，也不显示选择器）。 */
  function packsForPrompt() {
    return (cachedPacks || []).filter((pack) => !disabled.has(pack.id));
  }

  /**
   * 给提示词/解析器用的表情数组（sticker-core 认的扁平结构）。
   * 返回空数组 = 表情系统关着或没有任何表情包 —— 调用方据此**不要**注入 [Stickers] 指令。
   */
  async function availableStamps() {
    const all = await settings();
    if (all.stickers_enabled === false) {
      availableCache = [];
      return [];
    }
    await load();
    const out = [];
    for (const pack of packsForPrompt()) {
      for (const stamp of pack.stamps) {
        out.push({ id: stamp.id, name: stamp.name, file: stamp.file, url: stamp.url, tags: stamp.tags });
      }
    }
    availableCache = out;
    return out;
  }

  /**
   * 同步读"上次算出来的可用表情"。
   * 渲染气泡是同步的（要立刻画出来），不能在里面 await，所以留一个同步出口。
   * 每一轮生成前 availableStamps() 都会刷新它；没算过就是空 —— 那时也还没有标记。
   */
  function cachedStamps() {
    return availableCache;
  }

  /** 按 id（<包>:<表情>）找一张表情，用于把聊天气泡里的标记换成图。 */
  function stampById(id) {
    for (const pack of (cachedPacks || [])) {
      for (const stamp of pack.stamps) {
        if (stamp.id === id) return stamp;
      }
    }
    return null;
  }

  async function listPacks() {
    const all = await settings();
    await load();
    return (cachedPacks || []).map((pack) => ({
      id: pack.id,
      label: pack.label,
      description: pack.description,
      count: pack.stamps.length,
      enabled: all.stickers_enabled !== false && !disabled.has(pack.id),
      stamps: pack.stamps,
    }));
  }

  async function setEnabled(packId, enabled) {
    if (enabled) disabled.delete(packId);
    else disabled.add(packId);
    return listPacks();
  }

  /** 和设置面板打交道：读当前开关与每个包的状态。 */
  async function status() {
    const all = await settings();
    const packs = await listPacks();
    const total = packs.reduce((sum, pack) => sum + pack.count, 0);
    return {
      enabled: all.stickers_enabled !== false,
      packs,
      total,
    };
  }

  const Stickers = {
    load,
    availableStamps,
    cachedStamps,
    stampById,
    listPacks,
    setEnabled,
    status,
    urlFor,
    _resetForTests() { cachedPacks = null; loading = null; availableCache = []; disabled = new Set(); },
  };

  global.RoleWorldStickersPack = Stickers;
  if (typeof module !== "undefined" && module.exports) module.exports = Stickers;
})(typeof globalThis !== "undefined" ? globalThis : this);
