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
  const app = sdk.init(Object.assign(
    { env: opts.env || process.env.TCB_ENV || process.env.CLOUDBASE_ENV },
    // 云托管/HTTP 函数里**不能**依赖平台默认临时凭据（会过期、间歇性 401）：
    // 官方要求显式用"云开发服务端 API Key"授权，控制台里把 API Key 注入成 CLOUDBASE_APIKEY 即可。
    // 这里显式传 accessKey，同时也允许 SDK 自己从环境变量读——两条路都通。
    process.env.CLOUDBASE_APIKEY ? { accessKey: process.env.CLOUDBASE_APIKEY } : {}
  ));
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

/**
 * 诊断用：容器里到底拿没拿到云开发授权（只报"有没有、多长"，绝不回显值）。
 * 云托管里最常见的一种失败是"以为注入了 API Key，其实没生效"，光看报错很难分辨。
 */
function describeAuth() {
  const key = process.env.CLOUDBASE_APIKEY || "";
  const pair = !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY);
  let sdkVersion = "未安装";
  try { sdkVersion = require("@cloudbase/node-sdk/package.json").version; } catch (_) { sdkVersion = "未安装"; }
  // 只报 JWT 头里的 key id：这是"容器里到底是哪把 Key"的唯一可靠指纹（长度可能一样）。
  // 不报 token 本体、不报任何 claim。
  let apiKeyKid = "";
  try {
    const header = JSON.parse(Buffer.from(key.split(".")[0], "base64url").toString("utf8"));
    apiKeyKid = String(header.kid || header.alg || "");
  } catch (_) { apiKeyKid = key ? "(不是 JWT)" : ""; }
  return {
    cloudbaseApiKey: key ? "set(" + key.length + ")" : "unset",
    apiKeyKid,
    tencentPair: pair ? "set" : "unset",
    env: process.env.TCB_ENV || process.env.CLOUDBASE_ENV || "",
    sdkVersion,
  };
}

/* ---------------- 云开发文档型数据库（HTTP API，推荐） ----------------
 *
 * 为什么不用 @cloudbase/node-sdk：官方已标注它停止维护，而且在云托管容器里用注入的
 * 服务端 ApiKey 会报 `INVALID_ACCESS_TOKEN`（实测：同一把 Key，网关能过、旧 SDK 不过）。
 * 官方 HTTP API 是明确的：域名 {envId}.api.tcloudbasegateway.com，
 * 头 `Authorization: Bearer <ApiKey>`，路径 /v1/database/instances/(default)/databases/(default)。
 * 这里就按那份文档直接走 HTTP，少一层依赖，也少一层"版本不兼容"。
 * 文档：https://docs.cloudbase.net/http-api/nosql/nosql-restful-api
 */

function createHttpStore(options) {
  const opts = options || {};
  const envId = opts.env || process.env.TCB_ENV || process.env.CLOUDBASE_ENV || "";
  const apiKey = opts.apiKey || process.env.CLOUDBASE_APIKEY || "";
  const collection = opts.collection || process.env.CARD_COLLECTION || "rw_cards";
  const base = String(opts.gatewayBase || process.env.CLOUDBASE_GATEWAY_BASE || (envId ? `https://${envId}.api.tcloudbasegateway.com` : "")).replace(/\/+$/, "");
  if (!base) throw new Error("缺少环境 ID：设置 TCB_ENV（例如 cyan1-xxxx）");
  if (!apiKey) throw new Error("缺少 CLOUDBASE_APIKEY：在云托管「API Key 设置」里注入一把服务端 ApiKey");
  const root = `${base}/v1/database/instances/(default)/databases/(default)`;
  const docs = `${root}/collections/${encodeURIComponent(collection)}/documents`;

  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Authorization: "Bearer " + apiKey }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }

  let ensured = null;
  /** 集合不存在就建一个（409 = 已存在，同样算成功）。 */
  async function ensureCollection() {
    if (!ensured) {
      ensured = call("POST", `${root}/collections`, { collectionName: collection }).then((res) => {
        if (res.status === 201 || res.status === 409) return true;
        throw new Error(`建集合失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
      });
    }
    return ensured;
  }

  const plainId = (value) => {
    if (!value) return "";
    if (typeof value === "object" && value.$oid) return String(value.$oid);
    return String(value);
  };
  const shape = (doc) => {
    if (!doc) return null;
    const card = Object.assign({}, doc);
    card.id = card.id || plainId(card._id);
    delete card._id;
    return card;
  };

  return {
    kind: "cloudbase-http",
    collection,
    async list() {
      await ensureCollection();
      const res = await call("GET", `${docs}?limit=500`);
      if (res.status !== 200) throw new Error(`查列表失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
      return (res.body.list || []).map(shape);
    },
    async get(id) {
      await ensureCollection();
      const res = await call("GET", `${docs}/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`查单条失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
      return shape(res.body);
    },
    async findByToken(token) {
      await ensureCollection();
      const query = JSON.stringify({ tokenHash: hashToken(token) });
      const res = await call("GET", `${docs}?limit=1&query=${encodeURIComponent(query)}`);
      if (res.status !== 200) throw new Error(`按卡号查失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
      return shape((res.body.list || [])[0]);
    },
    async save(card) {
      await ensureCollection();
      const existing = await this.get(card.id);
      if (existing) {
        const data = Object.assign({}, card);
        delete data.id;
        const res = await call("PATCH", `${docs}/${encodeURIComponent(card.id)}`, { data: { $set: data }, returnDoc: false });
        if (res.status !== 200) throw new Error(`更新卡失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
        return card;
      }
      const data = Object.assign({ _id: card.id }, card);
      delete data.id;
      const res = await call("POST", docs, { data: [data] });
      if (res.status !== 201) throw new Error(`写入卡失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
      return card;
    },
    async remove(id) {
      await ensureCollection();
      const res = await call("DELETE", `${docs}/${encodeURIComponent(id)}`);
      if (res.status === 404) return false;
      if (res.status !== 200) throw new Error(`删卡失败（HTTP ${res.status}）：${JSON.stringify(res.body).slice(0, 200)}`);
      return Number(res.body.deleted || 0) > 0;
    },
  };
}

function createStore(spec) {
  const kind = String((spec && spec.kind) || process.env.CARD_STORE || "memory").toLowerCase();
  const wantCloud = kind === "cloudbase" || kind === "cloudbase-http" || kind === "http";
  if (wantCloud && (process.env.CLOUDBASE_APIKEY || (spec && spec.apiKey))) {
    try {
      return createHttpStore(spec || {});
    } catch (error) {
      console.error("⚠ 云开发账本用不了（" + (error && error.message ? error.message : error) + "），改为 file 后端。");
      return createFileStore((spec && spec.file) || process.env.CARD_FILE || "/data/cards.json");
    }
  }
  if (kind === "cloudbase") {
    try {
      return createCloudBaseStore(spec || {});
    } catch (error) {
      // 不静默降级：把原因打出来，而且 /healthz 会显示真正在用的后端是 file。
      // 卡在"以为存数据库、其实存临时盘"上，比启动失败更难查。
      console.error("⚠ 云开发账本用不了（" + (error && error.message ? error.message : error) + "），改为 file 后端。");
      console.error("  检查三件事：镜像里装了 @cloudbase/node-sdk、云数据库里已建集合 rw_cards、服务角色有读写权限。");
      return createFileStore((spec && spec.file) || process.env.CARD_FILE || "/data/cards.json");
    }
  }
  if (kind === "file") return createFileStore((spec && spec.file) || process.env.CARD_FILE || "cards.json");
  return createMemoryStore();
}

module.exports = { createStore, createMemoryStore, createFileStore, createCloudBaseStore, createHttpStore, describeAuth, hashToken, randomToken, blankCard, nowIso };
