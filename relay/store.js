"use strict";

/*
 * relay/store.js —— 体验卡账本（发卡 / 查卡 / 停卡 / 计次）
 *
 * 存的是**卡的哈希**，不存卡号本身：数据库被人看到也拿不到能用的卡。
 * 三种后端：
 *   - memory    测试用
 *   - file      JSON 文件（本机、自己的服务器、挂了持久盘的容器）
 *   - cloudbase  云开发数据库（用 @cloudbase/node-sdk，装不上就明确报错，绝不静默降级）
 *
 * 账本只记**用量**：次数、token、时间、卡号哈希、标签。
 * 绝不记对话正文 —— 这是"你能当中转，但不该偷看"的那条线。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function randomToken() {
  // 24 字节 → base32-ish 友好串，形如 RW-XXXX-XXXX-XXXX
  const raw = crypto.randomBytes(15).toString("hex").toUpperCase();
  const groups = raw.match(/.{1,5}/g) || [];
  return "RW-" + groups.slice(0, 3).join("-");
}

function nowIso() {
  return new Date().toISOString();
}

function blankCard(fields) {
  const card = Object.assign({
    id: crypto.randomBytes(6).toString("hex"),
    tokenHash: "",
    label: "",
    createdAt: nowIso(),
    expiresAt: null,
    quota: { calls: 0, tokens: 0 },   // 0 = 不限制
    used: { calls: 0, tokens: 0 },
    disabled: false,
    note: "",
  }, fields || {});
  card.quota = Object.assign({ calls: 0, tokens: 0 }, card.quota || {});
  card.used = Object.assign({ calls: 0, tokens: 0 }, card.used || {});
  return card;
}

/* ---------------- 内存（测试） ---------------- */

function createMemoryStore() {
  const cards = new Map();
  return {
    kind: "memory",
    async list() { return Array.from(cards.values()).map((card) => Object.assign({}, card)); },
    async get(id) { return cards.get(id) ? Object.assign({}, cards.get(id)) : null; },
    async findByToken(token) {
      const hash = hashToken(token);
      for (const card of cards.values()) if (card.tokenHash === hash) return Object.assign({}, card);
      return null;
    },
    async save(card) { cards.set(card.id, Object.assign({}, card)); return card; },
    async remove(id) { return cards.delete(id); },
  };
}

/* ---------------- 文件（本机 / 带持久盘的容器） ---------------- */

function createFileStore(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(target, "utf8"));
      return Array.isArray(raw.cards) ? raw.cards : [];
    } catch (_) { return []; }
  };
  // 先写临时文件再改名：断电/重启不会留下半个 JSON，把卡全弄丢。
  const write = (cards) => {
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: nowIso(), cards }, null, 2));
    fs.renameSync(tmp, target);
  };
  return {
    kind: "file",
    async list() { return read(); },
    async get(id) { return read().find((card) => card.id === id) || null; },
    async findByToken(token) {
      const hash = hashToken(token);
      return read().find((card) => card.tokenHash === hash) || null;
    },
    async save(card) {
      const cards = read();
      const index = cards.findIndex((row) => row.id === card.id);
      if (index >= 0) cards[index] = card; else cards.push(card);
      write(cards);
      return card;
    },
    async remove(id) {
      const cards = read();
      const next = cards.filter((card) => card.id !== id);
      write(next);
      return next.length !== cards.length;
    },
  };
}

/* ---------------- 云开发数据库 ---------------- */

function createCloudBaseStore(options) {
  const opts = options || {};
  let sdk = null;
  try {
    sdk = require("@cloudbase/node-sdk");
  } catch (error) {
    throw new Error("云开发账本需要 @cloudbase/node-sdk（npm i @cloudbase/node-sdk）：" + error.message);
  }
  const app = sdk.init({ env: opts.env || process.env.TCB_ENV || process.env.CLOUDBASE_ENV });
  const db = app.database();
  const collection = db.collection(opts.collection || "rw_cards");
  const shape = (doc) => {
    if (!doc) return null;
    const card = Object.assign({}, doc);
    delete card._id;
    return card;
  };
  return {
    kind: "cloudbase",
    async list() {
      const res = await collection.limit(500).get();
      return (res.data || []).map(shape);
    },
    async get(id) {
      const res = await collection.where({ id }).limit(1).get();
      return shape((res.data || [])[0]);
    },
    async findByToken(token) {
      const res = await collection.where({ tokenHash: hashToken(token) }).limit(1).get();
      return shape((res.data || [])[0]);
    },
    async save(card) {
      const existing = await collection.where({ id: card.id }).limit(1).get();
      if ((existing.data || []).length) await collection.where({ id: card.id }).update(card);
      else await collection.add(card);
      return card;
    },
    async remove(id) {
      const res = await collection.where({ id }).remove();
      return Number(res.deleted || 0) > 0;
    },
  };
}

function createStore(spec) {
  const kind = String((spec && spec.kind) || process.env.CARD_STORE || "memory").toLowerCase();
  if (kind === "file") return createFileStore((spec && spec.file) || process.env.CARD_FILE || "cards.json");
  if (kind === "cloudbase") return createCloudBaseStore(spec || {});
  return createMemoryStore();
}

module.exports = { createStore, createMemoryStore, createFileStore, createCloudBaseStore, hashToken, randomToken, blankCard, nowIso };
