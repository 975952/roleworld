"use strict";

/*
 * adapter/packs.js —— 内置内容包
 *
 * 应用本身不含任何角色数据；角色、记忆书、示例对话都以「包」的形式放在 packs/ 目录下。
 * 这样做的好处：
 *   - 想换题材（奇幻 / 校园 / 原创世界观）只要换一个包，不用改代码；
 *   - 用户可以随时停用或删除某个包，数据完全在自己手里；
 *   - 仓库可以只带一个空的 packs/index.json，由使用者自行放置内容。
 *
 * 目录约定：
 *   packs/index.json                     { "packs": [ { id, name, version, path, description } ] }
 *   packs/<id>/characters/<avatar>.json  CCv3 角色卡
 *   packs/<id>/worlds/<name>.json        SillyTavern 世界书（{ entries: { uid: {...} } }）
 *   packs/<id>/chats/<avatar>/<file>.json 可选的示例对话
 *
 * 安装规则：只补齐缺失的条目，绝不覆盖用户自己改过的角色或记忆书；
 * 每个包记录已安装版本，版本变化时才重新补齐。
 */

(function (global) {
  const Store = global.RoleWorldStore;
  const Cards = global.RoleWorldCards;
  const INSTALLED_KEY = "packs:installed";
  // 一次性种子：老存档里装的是旧版内置卡（没有 pack_source 标记），
  // 靠"已经刷过哪一版"来判断要不要补一次卡内容修正。
  const SEED_KEY = "packs:seed-version";
  const DISABLED_KEY = "packs:disabled";
  const MANIFEST_URL = "packs/index.json";

  let installing = null;

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(url + " → HTTP " + response.status);
    return response.json();
  }

  async function manifest() {
    try {
      const data = await fetchJson(MANIFEST_URL);
      return Array.isArray(data && data.packs) ? data.packs : [];
    } catch (_) {
      // 没有内容包是完全正常的状态：应用照常运行，只是书架上没有预置角色。
      return [];
    }
  }

  async function listPacks() {
    const [available, installed, disabled] = await Promise.all([
      manifest(),
      Store.getKV(INSTALLED_KEY, {}),
      Store.getKV(DISABLED_KEY, []),
    ]);
    return available.map((pack) => ({
      id: pack.id,
      name: pack.name || pack.id,
      version: String(pack.version || "1"),
      description: pack.description || "",
      path: pack.path || ("packs/" + pack.id),
      files: pack.files || {},
      installedVersion: (installed || {})[pack.id] || null,
      enabled: !(disabled || []).includes(pack.id),
    }));
  }

  async function setEnabled(packId, enabled) {
    const disabled = new Set(await Store.getKV(DISABLED_KEY, []));
    if (enabled) disabled.delete(packId);
    else disabled.add(packId);
    await Store.setKV(DISABLED_KEY, Array.from(disabled));
    return !disabled.has(packId);
  }

  async function installAll(options) {
    if (installing) return installing;
    installing = (async () => {
      const report = { installed: [], skipped: [], errors: [] };
      let packs = [];
      try {
        packs = await listPacks();
      } catch (error) {
        report.errors.push(String(error && error.message ? error.message : error));
        return report;
      }
      const installedMap = await Store.getKV(INSTALLED_KEY, {});
      // 没有上面这个键（老存档）时按 "" 处理：只要包有版本号，就会补刷一次卡内容。
      const seeded = await Store.getKV(SEED_KEY, "");
      for (const pack of packs) {
        if (!pack.enabled) continue;
        const alreadyInstalled = pack.installedVersion !== null;
        const needSeed = seeded !== pack.version;
        if (pack.installedVersion === pack.version && !needSeed) continue;
        try {
          // 刷新包自带卡内容的时机：
          //   ① 已经装过这个包（这次是版本升级）；
          //   ② 或者这份存档还没做过"内容修正种子"（老存档第一次跑新版应用）。
          const counts = await installPack(pack, { refreshCards: alreadyInstalled || needSeed });
          installedMap[pack.id] = pack.version;
          await Store.setKV(INSTALLED_KEY, installedMap);
          await Store.setKV(SEED_KEY, pack.version);
          report.installed.push({ id: pack.id, ...counts });
        } catch (error) {
          report.errors.push(pack.id + ": " + (error && error.message ? error.message : error));
        }
      }
      return report;
    })();
    try {
      return await installing;
    } finally {
      installing = null;
    }
  }

  async function installPack(pack, options) {
    const opts = options || {};
    const counts = { characters: 0, worlds: 0, chats: 0 };
    const existingCharacters = new Set((await Store.listCharacters()).map((card) => card.avatar));
    const existingWorlds = new Set((await Store.listWorlds()).map((world) => world.name));

    for (const name of pack.files.characters || []) {
      const avatar = fileNameOf(name);
      const already = existingCharacters.has(avatar);
      // 内容包升级时：包自带的卡要**刷新内容**（比如补上语言约束），
      // 但只换卡本身，绝不碰聊天记录与记忆书；用户自己新建的卡一律不动。
      if (already && !opts.refreshCards) continue;
      const { card, image } = await loadCard(pack, name, avatar);
      const previous = already ? await Store.getCharacter(avatar) : null;
      const record = Object.assign({}, card, {
        avatar,
        name: card.name || (card.data && card.data.name) || avatar.replace(/\.\w+$/, ""),
        // 刷新时保留用户侧的痕迹：加入时间、收藏、最后对话时间。
        date_added: (previous && previous.date_added) || new Date().toISOString(),
        fav: previous ? !!previous.fav : !!card.fav,
        date_last_chat: previous ? previous.date_last_chat || null : null,
        // 标记来源，这样才敢在包升级时刷新它。
        pack_source: { id: pack.id, version: String(pack.version || "1") },
      });
      record.chat = avatar;
      const picture = image || (Cards && Cards.placeholderAvatar(record.name));
      await Store.putCharacter(record, picture ? { file: picture } : undefined);
      existingCharacters.add(avatar);
      counts.characters += 1;
      if (already) counts.refreshed = (counts.refreshed || 0) + 1;
    }

    for (const name of pack.files.worlds || []) {
      // 世界书的名字不带扩展名（SillyTavern 的约定），这里去掉 .json 再入库。
      const worldName = String(name).replace(/\.json$/i, "");
      if (existingWorlds.has(worldName)) continue;
      const entries = await fetchJson(joinPath(pack.path, "worlds", name));
      await Store.putWorld(worldName, entries && entries.entries ? entries : { entries: entries || {} });
      existingWorlds.add(worldName);
      counts.worlds += 1;
    }

    for (const chat of pack.files.chats || []) {
      const lines = await fetchJson(joinPath(pack.path, "chats", chat.avatar, chat.file));
      if ((await Store.getChat(chat.avatar, chat.file)).length > 0) continue;
      await Store.saveChat(chat.avatar, chat.file, lines);
      counts.chats += 1;
    }

    return counts;
  }

  // 内容包里的角色卡可以是 .png（自带立绘，和用户手动导入的格式一致）或 .json。
  async function loadCard(pack, name, avatar) {
    const url = joinPath(pack.path, "characters", name);
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(url + " → HTTP " + response.status);
    const blob = await response.blob();
    if (/\.png$/i.test(name)) {
      if (!Cards || typeof Cards.parse !== "function") throw new Error("角色卡解析器未加载");
      const file = new File([blob], avatar, { type: "image/png" });
      const parsed = await Cards.parse(file, "png");
      return { card: parsed.card, image: parsed.image || blob };
    }
    const text = await blob.text();
    const raw = JSON.parse(text);
    return { card: Cards && Cards.normalizeCard ? Cards.normalizeCard(raw) : raw, image: null };
  }

  function joinPath() {
    return Array.prototype.slice.call(arguments)
      .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/");
  }

  function fileNameOf(path) {
    const parts = String(path).split("/");
    return parts[parts.length - 1];
  }

  const Packs = { listPacks, installAll, setEnabled, manifest };

  global.RoleWorldPacks = Packs;
  if (typeof module !== "undefined" && module.exports) module.exports = Packs;
})(typeof globalThis !== "undefined" ? globalThis : this);
