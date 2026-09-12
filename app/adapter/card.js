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

  /** 启动时看地址里有没有带卡（#card=… 或 ?card=…），有就自动配好。 */
  function cardFromLocation(href) {
    const value = String(href || "");
    const match = value.match(/[#?&]card=([^&\s]+)/);
    if (!match) return null;
    const parsed = parseCardInput(value);
    return parsed.ok ? parsed : null;
  }

  /** 是不是"正在用体验卡"（密钥看起来像卡号）。 */
  function looksLikeCard(value) {
    return TOKEN_RE.test(String(value || "").trim());
  }

  const api = { parseCardInput, endpointFor, quota, formatQuota, apply, cardFromLocation, looksLikeCard, DEFAULT_MODEL };
  global.RoleWorldCard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
