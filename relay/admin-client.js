"use strict";

/*
 * relay/admin-client.js —— 跟中转的管理接口说话（CLI 与控制台共用）
 *
 * 凭据从哪来（按优先级）：
 *   1. 显式传入（测试用）；
 *   2. 环境变量 ADMIN_SECRET / RELAY_URL；
 *   3. 本机文件 relay/admin-secret.local.txt（gitignored，和中转口令同一份）。
 *
 * 安全约定：**口令只在这条链路上**（脚本 / 本机控制台服务进程）。控制台不把它交给浏览器。
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_RELAY_URL = "https://roleworld-relay-4441019-1485756522.ap-shanghai.run.tcloudbase.com";
const SECRET_FILE = path.join(__dirname, "admin-secret.local.txt");

function stripSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveRelayUrl(explicit) {
  return stripSlash(explicit || process.env.RELAY_URL || DEFAULT_RELAY_URL);
}

/** 读本机口令文件：跳过空行与 # 注释，取第一行有效内容。 */
function readSecretFile(file) {
  try {
    const raw = fs.readFileSync(file || SECRET_FILE, "utf8");
    const line = raw.split(/\r?\n/).map((row) => row.trim()).find((row) => row && row[0] !== "#");
    return line || "";
  } catch (_) {
    return "";
  }
}

function resolveAdminSecret(explicit) {
  if (explicit) return String(explicit).trim();
  if (process.env.ADMIN_SECRET) return String(process.env.ADMIN_SECRET).trim();
  return readSecretFile();
}

function createAdminClient(options) {
  const opts = options || {};
  const relayUrl = resolveRelayUrl(opts.relayUrl);
  const adminSecret = resolveAdminSecret(opts.adminSecret);
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("这个 Node 没有 fetch，请用 Node 18+");

  /** 一次请求。返回 { status, ok, body }；HTTP 错误也返回（由调用方决定怎么说）。 */
  async function call(pathname, request) {
    const req = request || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, req.headers || {});
    // admin: false 的接口（查额度）不需要口令 —— 卡号本身就是凭据。
    if (req.admin !== false && adminSecret) headers.Authorization = "Bearer " + adminSecret;
    const res = await fetchImpl(relayUrl + pathname, {
      method: req.method || "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
    return { status: res.status, ok: res.ok, body };
  }

  /** 管理类请求：失败直接抛成人话（CLI 与控制台都靠它）。 */
  async function must(pathname, request) {
    if (!adminSecret) throw new Error("没有发卡口令：设置环境变量 ADMIN_SECRET，或把口令写进 " + SECRET_FILE);
    const result = await call(pathname, request);
    if (!result.ok) {
      const message = (result.body && result.body.error && (result.body.error.message || result.body.error)) || result.body;
      throw new Error("HTTP " + result.status + "：" + String(message).slice(0, 200));
    }
    return result.body;
  }

  return {
    relayUrl,
    hasSecret: !!adminSecret,
    call,
    must,
    health: async () => (await call("/healthz")).body,
    listCards: async () => (await must("/admin/cards")).cards || [],
    createCard: async (fields) => must("/admin/cards", { method: "POST", body: fields || {} }),
    /** 改一张已有的卡：加次数 / 加 token / 续期 / 改标签（2026-09-12）。
     *  calls/tokens 是**新的上限**，days 是"从今天起再给几天"。 */
    updateCard: async (id, fields) => must(`/admin/cards/${encodeURIComponent(id)}/update`, { method: "PATCH", body: fields || {} }),
    /** 按天用量汇总（最近 N 天，最多 90）。 */
    usage: async (days) => must("/admin/usage" + (days ? "?days=" + encodeURIComponent(days) : "")),
    setDisabled: async (id, disabled) => must(`/admin/cards/${encodeURIComponent(id)}/${disabled ? "disable" : "enable"}`, { method: "POST" }),
    revoke: async (id) => must(`/admin/cards/${encodeURIComponent(id)}`, { method: "DELETE" }),
    quota: async (token) => {
      const result = await call("/card/quota", { admin: false, headers: { Authorization: "Bearer " + token } });
      return result.body;
    },
    storeSelftest: async () => must("/admin/store/selftest"),
    upstreamSelftest: async (model) => must("/admin/upstream/selftest" + (model ? "?model=" + encodeURIComponent(model) : "")),
  };
}

module.exports = { DEFAULT_RELAY_URL, SECRET_FILE, createAdminClient, readSecretFile, resolveAdminSecret, resolveRelayUrl };
