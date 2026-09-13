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
    // 按天的用量（2026-09-12 加）：{"2026-09-13": {calls, tokens}}，只留最近 DAILY_KEEP 天。
    // 累计 used 看不出"今天谁用得多"，而"卡被转借/被刷"只有按天看得出来。
    daily: {},
    disabled: false,
    note: "",
  }, fields || {});
  card.quota = Object.assign({ calls: 0, tokens: 0 }, card.quota || {});
  card.used = Object.assign({ calls: 0, tokens: 0 }, card.used || {});
  card.daily = card.daily && typeof card.daily === "object" ? card.daily : {};
  return card;
}

/** 按天记账：累加今天的用量，并丢掉太旧的日期（账本行不能无限长）。 */
const DAILY_KEEP = 30;

function addDailyUsage(card, day, usage) {
  const key = String(day || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return card.daily;
  const daily = Object.assign({}, card.daily || {});
  const row = Object.assign({ calls: 0, tokens: 0 }, daily[key] || {});
  row.calls += 1;
  row.tokens += Number(usage && usage.total) || 0;
  daily[key] = row;
  const keys = Object.keys(daily).sort();
  while (keys.length > DAILY_KEEP) delete daily[keys.shift()];
  card.daily = daily;
  return daily;
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

/* ---------------- 云开发 PostgreSQL（Data API / PostgREST） ----------------
 *
 * 为什么是这个：2026-09-12 实测，这个环境（个人版）**没有文档型数据库**，
 * 平台给的是 PostgreSQL 实例（错误原文：This environment has no document database instance.
 * It is provisioned with PostgreSQL instance [pgdb-…]）。所以账本走 PG 的 Data API：
 *   - 建表：POST /v1/rdb/exec-pgsql（role=cloudbase_postgres，管理员才允许 DDL）
 *   - 增删改查：/v1/rdb/rest/{table}（PostgREST），主键冲突时用 upsert 合并
 * 鉴权一律 `Authorization: Bearer <CLOUDBASE_APIKEY>`（云托管里注入的那把服务端 ApiKey）。
 * 文档：https://docs.cloudbase.net/http-api/pgdb/postgresql-restful-api
 */

const PG_COLUMNS = [
  "id TEXT PRIMARY KEY",
  "token_hash TEXT UNIQUE NOT NULL",
  "label TEXT",
  "note TEXT",
  "quota_calls INTEGER NOT NULL DEFAULT 0",
  "quota_tokens INTEGER NOT NULL DEFAULT 0",
  "used_calls INTEGER NOT NULL DEFAULT 0",
  "used_tokens INTEGER NOT NULL DEFAULT 0",
  "disabled BOOLEAN NOT NULL DEFAULT FALSE",
  "expires_at TIMESTAMPTZ",
  "created_at TIMESTAMPTZ NOT NULL DEFAULT now()",
  "last_used_at TIMESTAMPTZ",
  // 按天用量（2026-09-12）：老库里没有这一列，ensureTable 会用 ALTER TABLE ... ADD COLUMN IF NOT EXISTS 补上。
  "daily JSONB NOT NULL DEFAULT '{}'::jsonb",
];

/** 建表之后才加的列：只有这些需要在老库上 ALTER 补齐（PG 支持 ADD COLUMN IF NOT EXISTS）。 */
const PG_UPGRADE_COLUMNS = [
  "daily JSONB NOT NULL DEFAULT '{}'::jsonb",
];

function toRow(card) {
  return {
    id: card.id,
    token_hash: card.tokenHash,
    label: card.label || "",
    note: card.note || "",
    quota_calls: Number(card.quota && card.quota.calls) || 0,
    quota_tokens: Number(card.quota && card.quota.tokens) || 0,
    used_calls: Number(card.used && card.used.calls) || 0,
    used_tokens: Number(card.used && card.used.tokens) || 0,
    disabled: card.disabled === true,
    expires_at: card.expiresAt || null,
    created_at: card.createdAt || new Date().toISOString(),
    last_used_at: card.lastUsedAt || null,
    daily: card.daily && typeof card.daily === "object" ? card.daily : {},
  };
}

function toCard(row) {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    label: row.label || "",
    note: row.note || "",
    quota: { calls: Number(row.quota_calls) || 0, tokens: Number(row.quota_tokens) || 0 },
    used: { calls: Number(row.used_calls) || 0, tokens: Number(row.used_tokens) || 0 },
    disabled: row.disabled === true,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at || "",
    lastUsedAt: row.last_used_at || null,
    daily: row.daily && typeof row.daily === "object" ? row.daily : (typeof row.daily === "string" ? safeJson(row.daily) : {}),
  };
}

function safeJson(text) {
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" ? parsed : {}; } catch (_) { return {}; }
}

function createPgStore(options) {
  const opts = options || {};
  const envId = opts.env || process.env.TCB_ENV || process.env.CLOUDBASE_ENV || "";
  const apiKey = opts.apiKey || process.env.CLOUDBASE_APIKEY || "";
  const table = opts.table || process.env.CARD_TABLE || "rw_cards";
  const base = String(opts.gatewayBase || process.env.CLOUDBASE_GATEWAY_BASE || (envId ? `https://${envId}.api.tcloudbasegateway.com` : "")).replace(/\/+$/, "");
  if (!base) throw new Error("缺少环境 ID：设置 TCB_ENV（例如 cyan1-xxxx）");
  if (!apiKey) throw new Error("缺少 CLOUDBASE_APIKEY：在云托管「API Key 设置」里注入一把服务端 ApiKey");
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("表名不合法：" + table);
  const rest = `${base}/v1/rdb/rest/${table}`;

  async function request(method, url, body, headers) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Authorization: "Bearer " + apiKey, Accept: "application/json" }, body ? { "Content-Type": "application/json" } : {}, headers || {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text.slice(0, 300) }; }
    return { status: res.status, body: parsed, range: res.headers.get("content-range") || "" };
  }

  function failure(what, res) {
    const detail = typeof res.body === "string" ? res.body : JSON.stringify(res.body || {}).slice(0, 300);
    return new Error(`${what}失败（HTTP ${res.status}）：${detail}`);
  }

  let ensured = null;
  /** 建表（幂等）。DDL 只有管理员角色能做，exec-pgsql 需要 role=cloudbase_postgres。 */
  async function ensureTable() {
    if (!ensured) {
      ensured = (async () => {
        const ddl = `CREATE TABLE IF NOT EXISTS ${table} (${PG_COLUMNS.join(", ")})`;
        const res = await request("POST", `${base}/v1/rdb/exec-pgsql`, { sql: ddl, role: "cloudbase_postgres" });
        if (res.status !== 200) throw failure("建表", res);
        // 已经建过的老库不会有新列 —— 只补"建表之后才加的"那几列（幂等）。
        // 刻意**不**遍历 PG_COLUMNS：那会把主键那些列也 ALTER 一遍，既没意义又容易被网关拒。
        for (const column of PG_UPGRADE_COLUMNS) {
          const name = column.split(" ")[0];
          const add = await request("POST", `${base}/v1/rdb/exec-pgsql`, {
            sql: `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`,
            role: "cloudbase_postgres",
          });
          if (add.status !== 200) throw failure("补列 " + name, add);
        }
        return true;
      })();
    }
    return ensured;
  }

  return {
    kind: "cloudbase-pg",
    table,
    async list() {
      await ensureTable();
      const res = await request("GET", `${rest}?select=*&limit=500`);
      if (res.status !== 200) throw failure("查列表", res);
      return (Array.isArray(res.body) ? res.body : []).map(toCard);
    },
    async get(id) {
      await ensureTable();
      const res = await request("GET", `${rest}?select=*&limit=1&id=eq.${encodeURIComponent(id)}`);
      if (res.status !== 200) throw failure("查单条", res);
      return (Array.isArray(res.body) && res.body[0]) ? toCard(res.body[0]) : null;
    },
    async findByToken(token) {
      await ensureTable();
      const res = await request("GET", `${rest}?select=*&limit=1&token_hash=eq.${encodeURIComponent(hashToken(token))}`);
      if (res.status !== 200) throw failure("按卡号查", res);
      return (Array.isArray(res.body) && res.body[0]) ? toCard(res.body[0]) : null;
    },
    async save(card) {
      await ensureTable();
      // 主键/唯一键冲突就合并更新：一张卡反复保存（记用量）是常态。
      const res = await request("POST", `${rest}?select=*`, toRow(card), { Prefer: "resolution=merge-duplicates,return=representation" });
      if (res.status !== 201 && res.status !== 200) throw failure("写卡", res);
      return card;
    },
    async remove(id) {
      await ensureTable();
      const res = await request("DELETE", `${rest}?id=eq.${encodeURIComponent(id)}`, null, { Prefer: "return=representation" });
      if (res.status === 200) return (Array.isArray(res.body) ? res.body.length : 0) > 0;
      if (res.status === 204) return true;
      throw failure("删卡", res);
    },
  };
}

function createStore(spec) {
  const kind = String((spec && spec.kind) || process.env.CARD_STORE || "memory").toLowerCase();
  const wantCloud = kind === "cloudbase" || kind === "pg" || kind === "cloudbase-pg" || kind === "cloudbase-http" || kind === "nosql";
  if (wantCloud && (process.env.CLOUDBASE_APIKEY || (spec && spec.apiKey))) {
    const preferNoSql = kind === "cloudbase-http" || kind === "nosql";
    const builders = preferNoSql ? [createHttpStore, createPgStore] : [createPgStore, createHttpStore];
    const errors = [];
    for (const build of builders) {
      try {
        const store = build(spec || {});
        if (errors.length) console.error("ℹ 已改用 " + store.kind + " 账本（前一个后端不可用：" + errors.join(" / ") + "）");
        return store;
      } catch (error) {
        errors.push((error && error.message) || String(error));
      }
    }
    console.error("⚠ 云开发账本都建不起来（" + errors.join(" / ") + "），改为 file 后端。");
    return createFileStore((spec && spec.file) || process.env.CARD_FILE || "/data/cards.json");
  }
  if (kind === "cloudbase" || kind === "pg") {
    try {
      return createCloudBaseStore(spec || {});
    } catch (error) {
      // 不静默降级：把原因打出来，而且 /healthz 会显示真正在用的后端是 file。
      console.error("⚠ 云开发账本用不了（" + (error && error.message ? error.message : error) + "），改为 file 后端。");
      return createFileStore((spec && spec.file) || process.env.CARD_FILE || "/data/cards.json");
    }
  }
  if (kind === "file") return createFileStore((spec && spec.file) || process.env.CARD_FILE || "cards.json");
  return createMemoryStore();
}

module.exports = { createStore, createMemoryStore, createFileStore, createCloudBaseStore, createHttpStore, createPgStore, describeAuth, hashToken, randomToken, blankCard, addDailyUsage, DAILY_KEEP, nowIso };
