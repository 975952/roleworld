"use strict";

/*
 * adapter/card.js —— 「体验卡」的客户端逻辑（纯逻辑 + 落盘，不含界面）
 *
 * 体验卡的原理很简单：发卡人自己搭一个中转（relay/），真 key 只在他那边；
 * 同学拿到的卡号就是**中转服务的凭据**——所以"用卡"= 把接口地址指向中转、把卡号当密钥存下来。
 * 客户端不需要任何特殊通道，也不需要知道真 key。
 *
 * 支持同学粘贴这几种形式（越省事越好）：
 *   RW-XXXXX-XXXXX-XXXXX                                   只有卡号（中转地址要已存过）
 *   RW-XXXXX-XXXXX-XXXXX@https://relay.example.com         卡号 + 中转地址
 *   https://app.example.com/#card=RW-…@https://relay…      整条体验卡链接
 *
 * 两条硬规矩：
 *   ① 卡号存在 secrets 里（与 API Key 同一处），**不进导出存档**；
 *   ② 界面上明说：走中转时发卡人能看见"用量"，但服务端不记录对话内容。
 */

(function (global) {
  const TOKEN_RE = /RW-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/i;
  const DEFAULT_MODEL = "deepseek-flash";

  function cleanRelay(value) {
    let relay = String(value || "").trim().replace(/\/+$/, "");
    relay = relay.replace(/\/v1\/chat\/completions$/i, "");
    return relay;
  }

  /** 解析卡号 / 卡号@中转 / 整条带 card= 的链接。 */
  function parseCardInput(text) {
    const raw = String(text || "").trim();
    if (!raw) return { ok: false, reason: "empty", message: "先粘贴卡号或体验卡链接" };
    let source = raw;
    const hash = raw.match(/[#?&]card=([^&\s]+)/);
    if (hash) {
      try { source = decodeURIComponent(hash[1]); } catch (_) { source = hash[1]; }
    }
    let token = "";
    let relay = "";
    for (const part of source.split("@").map((piece) => piece.trim()).filter(Boolean)) {
      const found = part.match(TOKEN_RE);
      if (found) { token = found[0].toUpperCase(); continue; }
      if (/^https?:\/\//i.test(part)) relay = cleanRelay(part);
    }
    if (!token) {
      const loose = source.match(TOKEN_RE);
      if (loose) token = loose[0].toUpperCase();
    }
    if (!token) return { ok: false, reason: "no-token", message: "没认出卡号（应当形如 RW-XXXXX-XXXXX-XXXXX）" };
    return { ok: true, token, relay: relay || "" };
  }

  function endpointFor(relay) {
    return cleanRelay(relay) + "/v1/chat/completions";
  }

  /** 查这张卡还能用多少（不需要真 key，任何人都能查自己的卡）。 */
  async function quota(relay, token, options) {
    const base = cleanRelay(relay);
    if (!base) return { ok: false, message: "还不知道中转地址" };
    const controller = new AbortController();
    const timer = global.setTimeout(() => controller.abort(), (options && options.timeoutMs) || 8000);
    try {
      const res = await fetch(base + "/card/quota", {
        headers: { Authorization: "Bearer " + String(token || "").trim() },
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, message: (data.error && data.error.message) || ("HTTP " + res.status), code: data.error && data.error.code };
      return Object.assign({ ok: true }, data);
    } catch (error) {
      const aborted = error && error.name === "AbortError";
      return { ok: false, message: aborted ? "查询超时（中转没回应）" : ("连不上中转：" + (error && error.message || error)) };
    } finally {
      global.clearTimeout(timer);
    }
  }

  /** 把额度翻成人话。 */
  function formatQuota(info) {
    if (!info || !info.ok) return info && info.message ? info.message : "查不到额度";
    const bits = [];
    bits.push(info.callsLeft === null || info.callsLeft === undefined ? "次数不限" : `剩 ${info.callsLeft} 次`);
    if (info.tokensLeft !== null && info.tokensLeft !== undefined) bits.push(`剩 ${info.tokensLeft} token`);
    if (info.expiresAt) bits.push("到期 " + String(info.expiresAt).slice(0, 10));
    else bits.push("不过期");
    const line = bits.join(" · ");
    return info.ok ? line : line + "（" + (info.reason || "已不可用") + "）";
  }

  /** 用这张卡：把接口指向中转、把卡号当密钥存好。 */
  async function apply(input, options) {
    const adapter = global.RoleWorld;
    const parsed = typeof input === "string" ? parseCardInput(input) : input;
    if (!parsed.ok) return { ok: false, message: parsed.message || "卡号不对" };
    const settings = adapter ? await adapter.getLocalSettings() : {};
    const relay = cleanRelay(parsed.relay || (options && options.relay) || settings.card_relay || "");
    if (!relay) return { ok: false, message: "这条信息里没有中转地址：请把发卡人给你的**整条链接**粘进来" };

    const patch = {
      provider: "custom",
      endpoint: endpointFor(relay),
      card_relay: relay,
    };
    if (!String(settings.model || "").trim() || (options && options.forceModel)) patch.model = DEFAULT_MODEL;
    await adapter.saveLocalSettings(patch);
    // 卡号存在密钥位：中转就是拿它当 Bearer 的。
    await adapter.secrets.set(global.RoleWorldModel.secretKeyFor({ provider: "custom" }), parsed.token);
    const info = await quota(relay, parsed.token);
    return { ok: true, token: parsed.token, relay, quota: info, message: formatQuota(info) };
  }

  /** 启动时看地址里有没有带卡（#card=… 或 ?card=…），有就自动配好。
   *  这一步必须在"要不要弹首启引导"之前做完 —— 否则同学打开链接还是会被要求填 API Key
   *  （2026-09-12 实测反馈："别人打开还是必须填 apikey"）。 */
  function cardFromLocation(href) {
    const value = String(href || "");
    const match = value.match(/[#?&]card=([^&\s]+)/);
    if (!match) return null;
    const parsed = parseCardInput(value);
    return parsed.ok ? parsed : null;
  }

  /** 已经在用这张卡了吗（避免每次启动都重写一遍设置）。 */
  async function alreadyUsing(parsed) {
    const adapter = global.RoleWorld;
    if (!adapter) return false;
    try {
      const settings = await adapter.getLocalSettings();
      const saved = await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider: settings.provider || "custom" }));
      const value = (saved && saved.value) || "";
      return value === parsed.token && !!settings.endpoint;
    } catch (_) {
      return false;
    }
  }

  /** 把地址里的卡直接应用掉；重复调用无副作用，失败也不抛（启动不该被一张坏卡卡死）。 */
  async function applyFromLocation(href, options) {
    const parsed = cardFromLocation(href);
    if (!parsed) { lastResult = { ok: true, applied: false, reason: "no-card-in-url" }; return lastResult; }
    try {
      if (await alreadyUsing(parsed)) {
        lastQuota = await quota(parsed.relay || "", parsed.token);
        lastResult = { ok: true, applied: false, reason: "already-applied", token: parsed.token, quota: lastQuota };
        return lastResult;
      }
      const result = await apply(parsed, options);
      lastQuota = result.quota || null;
      lastResult = Object.assign({ applied: result.ok }, result);
      return lastResult;
    } catch (error) {
      lastResult = { ok: false, applied: false, message: String((error && error.message) || error) };
      return lastResult;
    }
  }

  /** 是不是"正在用体验卡"（密钥看起来像卡号）。 */
  function looksLikeCard(value) {
    return TOKEN_RE.test(String(value || "").trim());
  }

  /** 本机当前是不是在用体验卡（引导页、设置页、顶栏徽标都用它判断）。 */
  async function currentState() {
    const adapter = global.RoleWorld;
    if (!adapter) return { active: false };
    try {
      const settings = await adapter.getLocalSettings();
      const provider = settings.provider || "deepseek";
      const saved = await adapter.secrets.get(global.RoleWorldModel.secretKeyFor({ provider }));
      const value = (saved && saved.value) || "";
      if (!looksLikeCard(value)) return { active: false };
      return { active: true, token: value, relay: settings.card_relay || "", quota: lastQuota };
    } catch (_) {
      return { active: false };
    }
  }

  /* ---------------- 额度徽标：次数要在界面上一眼看得见 ---------------- */

  let lastQuota = null;
  /** 最近一次 apply/applyFromLocation 的结果：出问题时能在控制台或测试里直接看到原因。 */
  let lastResult = null;

  function knownResult() {
    return lastResult;
  }

  /** 从这一轮响应头里读剩余次数（中转每轮都回 x-rw-card-*）。 */
  function noteQuotaFromHeaders(headers) {
    if (!headers || typeof headers.get !== "function") return null;
    const callsLeft = headers.get("x-rw-card-calls-left");
    const tokensLeft = headers.get("x-rw-card-tokens-left");
    const expires = headers.get("x-rw-card-expires");
    const id = headers.get("x-rw-card-id");
    if (callsLeft === null && tokensLeft === null && expires === null && id === null) return null;
    const toNumber = (raw) => {
      if (raw === null || raw === undefined || raw === "unlimited") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    lastQuota = {
      ok: true,
      callsLeft: toNumber(callsLeft),
      tokensLeft: toNumber(tokensLeft),
      expiresAt: expires && expires !== "never" ? expires : null,
    };
    try {
      global.dispatchEvent(new global.CustomEvent("roleworld:card-changed", { detail: lastQuota }));
    } catch (_) { /* 没有 window 就算了 */ }
    return lastQuota;
  }

  function knownQuota() {
    return lastQuota;
  }

  /** 把中转返回的卡错误翻成人话（402/401 时用）。 */
  function describeCardError(status, body) {
    const code = body && body.error ? body.error.code : "";
    const message = body && body.error ? body.error.message : "";
    if (!code || String(code).indexOf("CARD_") !== 0) return null;
    const suffix = "（这张是体验卡：可以在「设置 → 模型 → 体验卡」里换一张，或填自己的 API Key）";
    if (code === "CARD_UNKNOWN") return message + suffix;
    if (code === "CARD_DISABLED") return message + suffix;
    if (code === "CARD_EXPIRED") return message + suffix;
    if (code === "CARD_NO_CALLS" || code === "CARD_NO_TOKENS") return message + suffix;
    return (message || "体验卡暂时不可用") + suffix;
  }

  /** 徽标文案：剩多少次要一眼看见；快用完/用完要有明显区别。 */
  function chipText(state, quota) {
    if (!state || !state.active) return "";
    const info = quota || state.quota;
    if (!info || !info.ok) return "体验卡";
    const calls = info.callsLeft;
    if (calls === null || calls === undefined) return "体验卡 · 不限次";
    if (calls <= 0) return "体验卡 · 次数已用完";
    if (calls <= 3) return "体验卡 · 只剩 " + calls + " 次";
    return "体验卡 · 剩 " + calls + " 次";
  }

  function chipLevel(state, quota) {
    if (!state || !state.active) return "off";
    const info = quota || state.quota;
    if (!info || !info.ok) return "warn";
    const calls = info.callsLeft;
    if (calls === null || calls === undefined) return "ok";
    if (calls <= 0) return "bad";
    return calls <= 3 ? "warn" : "ok";
  }

  const api = {
    parseCardInput, endpointFor, quota, formatQuota, apply, applyFromLocation, cardFromLocation,
    currentState, looksLikeCard, noteQuotaFromHeaders, knownQuota, knownResult, describeCardError, chipText, chipLevel, DEFAULT_MODEL,
  };
  global.RoleWorldCard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
