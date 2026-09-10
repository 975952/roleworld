"use strict";

/*
 * adapter/cards.js —— 角色卡解包 / 打包
 *
 * 原来这一步是 SillyTavern 服务端做的：上传文件 → 服务端解出 PNG 里的角色数据 →
 * 落盘成 .png 头像 + 卡片 JSON。本地版必须自己在浏览器里做完这件事。
 *
 * 支持的容器：
 *   .json          —— CCv3 / CCv2 / 旧版 V1 扁平卡
 *   .png           —— 读 tEXt/iTXt 块里的 chara(V2) 与 ccv3(V3) 数据
 *   .charx         —— ZIP 容器，取其中的 card.json
 *   .yaml / .yml   —— 本应用不内置 YAML 解析器；仅当文件其实是 JSON 时可用，
 *                     否则给出明确提示，让用户改用 JSON/PNG。绝不静默失败。
 */

(function (global) {
  const Zip = global.RoleWorldZip || (typeof require === "function" ? require("./zip.js") : null);

  const EXT_TO_TYPE = { ".json": "json", ".png": "png", ".charx": "charx", ".yaml": "yaml", ".yml": "yml" };
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

  function typeForFileName(fileName) {
    const name = String(fileName || "").toLowerCase();
    const dot = name.lastIndexOf(".");
    if (dot < 0) return "";
    return EXT_TO_TYPE[name.slice(dot)] || "";
  }

  /* ------------------------------------------------------------------ *
   * PNG 文本块
   * ------------------------------------------------------------------ */

  function readPngTextChunks(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < signature.length; i += 1) {
      if (bytes[i] !== signature[i]) return null; // 不是 PNG
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = {};
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const start = offset + 8;
      const end = start + length;
      if (end > bytes.length) break;
      if (type === "tEXt") {
        const data = bytes.subarray(start, end);
        const zero = data.indexOf(0);
        if (zero > 0) {
          const keyword = latin1(data.subarray(0, zero));
          chunks[keyword] = latin1(data.subarray(zero + 1));
        }
      } else if (type === "iTXt") {
        const data = bytes.subarray(start, end);
        const zero = data.indexOf(0);
        if (zero > 0) {
          const keyword = latin1(data.subarray(0, zero));
          const compressed = data[zero + 1] === 1;
          let cursor = zero + 3;
          const langEnd = data.indexOf(0, cursor);
          cursor = langEnd < 0 ? cursor : langEnd + 1;
          const translatedEnd = data.indexOf(0, cursor);
          cursor = translatedEnd < 0 ? cursor : translatedEnd + 1;
          if (!compressed) chunks[keyword] = utf8(data.subarray(cursor));
        }
      }
      if (type === "IEND") break;
      offset = end + 4;
    }
    return chunks;
  }

  function latin1(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function utf8(bytes) {
    return new global.TextDecoder("utf-8").decode(bytes);
  }

  function decodeBase64Json(text) {
    const binary = global.atob(String(text || "").trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(utf8(bytes));
  }

  /* ------------------------------------------------------------------ *
   * 卡片规范化
   * ------------------------------------------------------------------ */

  const CARD_FIELDS = [
    "name", "description", "personality", "scenario", "first_mes", "mes_example",
    "creator_notes", "creator", "creatorcomment", "character_version", "system_prompt",
    "post_history_instructions", "alternate_greetings", "tags", "character_book", "extensions",
  ];

  // 把 V1/V2/V3 各种形态统一成 ST 风格的卡片对象：顶层字段 + data 子对象同时存在。
  function normalizeCard(raw) {
    if (!raw || typeof raw !== "object") throw new Error("角色卡内容为空或不是对象");
    const isV3 = raw.spec === "chara_card_v3";
    const isV2 = raw.spec === "chara_card_v2";
    const data = raw.data && typeof raw.data === "object" ? raw.data : (isV2 || isV3 ? {} : raw);
    const card = {
      spec: isV3 ? "chara_card_v3" : (isV2 ? "chara_card_v2" : "chara_card_v1"),
      spec_version: raw.spec_version || (isV3 ? "3.0" : isV2 ? "2.0" : "1.0"),
      data: {},
    };
    CARD_FIELDS.forEach((field) => {
      const value = data[field] !== undefined ? data[field] : raw[field];
      if (value === undefined) return;
      card[field] = value;
      card.data[field] = value;
    });
    if (!card.name) card.name = String(raw.name || data.name || "未命名角色");
    card.data.name = card.name;
    card.data.description = card.data.description || "";
    card.data.first_mes = card.data.first_mes || "";
    card.data.tags = Array.isArray(card.data.tags) ? card.data.tags : [];
    if (!card.data.extensions || typeof card.data.extensions !== "object") card.data.extensions = {};
    card.tags = card.data.tags;
    return card;
  }

  function sanitizeFileName(name) {
    const cleaned = String(name || "character").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
    return cleaned.slice(0, 80) || "character";
  }

  // ST 用 "<角色名>.png" 作为头像文件名；本地沿用同一约定，保证迁移后引用不变。
  function avatarForName(name, existing) {
    const base = sanitizeFileName(name);
    const candidate = base + ".png";
    if (!existing || !existing.has(candidate)) return candidate;
    let index = 2;
    while (existing.has(base + " " + index + ".png")) index += 1;
    return base + " " + index + ".png";
  }

  /* ------------------------------------------------------------------ *
   * 解包
   * ------------------------------------------------------------------ */

  async function bytesOf(file) {
    if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
    if (typeof global.FileReader === "function") {
      return new Promise((resolve, reject) => {
        const reader = new global.FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
        reader.readAsArrayBuffer(file);
      });
    }
    throw new Error("当前环境无法读取文件内容");
  }

  /**
   * 解出一个角色卡。
   * @returns {{card: object, image: Blob|null}} image 是卡片自带的头像，没有则为 null
   */
  async function parse(file, fileType) {
    const type = fileType || typeForFileName(file && file.name);
    if (file && typeof file.size === "number" && file.size > MAX_IMPORT_BYTES) {
      throw new Error("文件超过 20 MB，无法导入");
    }
    if (type === "json") {
      const text = await readText(file);
      return { card: normalizeCard(safeJson(text, "这个 JSON 文件不是有效的角色卡")), image: null };
    }
    if (type === "png") {
      const bytes = await bytesOf(file);
      const chunks = readPngTextChunks(bytes);
      if (!chunks) throw new Error("这个文件不是有效的 PNG 图片");
      const payload = chunks.ccv3 || chunks.chara;
      if (!payload) throw new Error("这张 PNG 里没有角色数据（缺少 chara/ccv3 数据块）");
      const card = normalizeCard(decodeBase64Json(payload));
      return { card, image: new global.Blob([bytes], { type: "image/png" }) };
    }
    if (type === "charx") {
      const bytes = await bytesOf(file);
      const files = await Zip.read(bytes);
      const cardEntry = files.get("card.json") || files.get("character.json");
      if (!cardEntry) throw new Error("这个 .charx 压缩包里没有 card.json");
      const card = normalizeCard(safeJson(utf8(cardEntry), ".charx 里的 card.json 不是有效 JSON"));
      const imageEntry = findImageEntry(files);
      return { card, image: imageEntry ? new global.Blob([imageEntry], { type: "image/png" }) : null };
    }
    if (type === "yaml" || type === "yml") {
      const text = await readText(file);
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return { card: normalizeCard(safeJson(trimmed, "这个 YAML 文件不是 JSON 格式")), image: null };
      }
      throw new Error("暂不支持 YAML 格式的角色卡，请在 SillyTavern 里导出成 PNG 或 JSON 后再导入");
    }
    throw new Error("不支持的文件类型，请使用 .json / .png / .charx");
  }

  function findImageEntry(files) {
    for (const [name, bytes] of files) {
      if (/^assets\/.*\.(png|jpe?g|webp)$/i.test(name)) return bytes;
    }
    for (const [name, bytes] of files) {
      if (/\.(png|jpe?g|webp)$/i.test(name)) return bytes;
    }
    return null;
  }

  async function readText(file) {
    if (typeof file.text === "function") return file.text();
    return utf8(await bytesOf(file));
  }

  function safeJson(text, message) {
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(message);
    }
  }

  // 没有自带图片时，用角色名首字生成一个占位头像，避免界面出现空白方块。
  function placeholderAvatar(name) {
    const initial = String(name || "?").trim().charAt(0) || "?";
    let hash = 0;
    const text = String(name || "");
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      `<stop offset="0" stop-color="hsl(${hash} 62% 52%)"/>` +
      `<stop offset="1" stop-color="hsl(${(hash + 48) % 360} 58% 38%)"/>` +
      "</linearGradient></defs>" +
      '<rect width="192" height="192" rx="28" fill="url(#g)"/>' +
      '<text x="96" y="96" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="88" ' +
      'font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="central">' +
      escapeXml(initial) +
      "</text></svg>";
    return new global.Blob([svg], { type: "image/svg+xml" });
  }

  function escapeXml(text) {
    return String(text).replace(/[<>&"']/g, (character) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
    }[character]));
  }

  // 导出成 CCv3 JSON（用户可以把本地卡再导回 SillyTavern）。
  function toCCv3(card) {
    const data = Object.assign({}, card.data || {});
    data.name = card.name || data.name || "未命名角色";
    data.creator = data.creator || "RoleWorld";
    data.character_version = data.character_version || "1.0";
    return { spec: "chara_card_v3", spec_version: "3.0", data };
  }

  const Cards = {
    EXT_TO_TYPE,
    MAX_IMPORT_BYTES,
    typeForFileName,
    readPngTextChunks,
    normalizeCard,
    sanitizeFileName,
    avatarForName,
    parse,
    placeholderAvatar,
    toCCv3,
  };

  global.RoleWorldCards = Cards;
  if (typeof module !== "undefined" && module.exports) module.exports = Cards;
})(typeof globalThis !== "undefined" ? globalThis : this);
