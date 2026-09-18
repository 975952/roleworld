"use strict";

/*
 * relay/card-text.js —— 「发给同学的那段话」（CLI 与控制台共用同一份）
 *
 * 为什么单独一个文件：这段话是**同学唯一会照着做的东西**，两边各写一份必然写歪。
 * 2026-09-12 就栽在这里：CLI 当时只给"卡号"，而新设备不知道中转地址，
 * 同学照着做必然失败（用户实测「为什么我登的时候还是要输 apikey」）。
 *
 * 2026-09-16 起**只给两种形式**：
 *   ① 可整行粘贴的 `卡号@中转地址`      ② 卡号本身（应用的第一步会让人分两栏填）
 *   一键链接（`#card=…`）**已去掉**：它先撞腾讯云「测试域名风险提醒」页，
 *   点过去之后片段容易丢，同学看到的是"又要填 Key"或"进到另一张卡"（用户实测）。
 */

const DEFAULT_APP_URL = "https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com";

function stripSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/** 能**直接粘贴**进应用的那一行：卡号 + 中转地址。 */
function pasteLine(token, options) {
  const opts = options || {};
  return `${token}@${stripSlash(opts.relayUrl || "")}`;
}

/** 一段可以直接发给同学的话（**不再含一键链接** —— 见下面 shareText 的说明）。 */
function shareText(token, quota, options) {
  const opts = options || {};
  const appUrl = stripSlash(opts.appUrl || DEFAULT_APP_URL);
  const relayUrl = stripSlash(opts.relayUrl || "");
  const limit = [];
  if (quota && Number(quota.calls) > 0) limit.push(`${quota.calls} 次聊天`);
  if (quota && Number(quota.tokens) > 0) limit.push(`${quota.tokens} token`);
  // 语音的两份额度是**独立**的（按字符计费），所以分开写清楚 ——
  // 混成一句"共 N 次"会让同学以为语音也吃聊天的次数（2026-09-14）。
  if (quota && Number(quota.voice) > 0) limit.push(`${quota.voice} 次语音`);
  if (quota && Number(quota.voiceChars) > 0) limit.push(`${quota.voiceChars} 字语音`);
  // 2026-09-16：**不再给"一键链接"**。用户实测：那条链接会先撞腾讯云的
  // 「测试域名风险提醒」页（CloudBase 默认域名固定行为），点过去之后片段容易丢，
  // 同学看到的是"又要填 Key"或者"进到另一张卡"，比手填更糊涂。
  // 现在只给两样东西：卡号 + 中转地址（可粘贴的一整行），并且说明在应用里怎么填。
  return [
    "角色世界 · 体验卡",
    "",
    `卡号：${token}`,
    limit.length ? `额度：${limit.join(" / ")}` : "额度：不限（别乱用）",
    "",
    "怎么用（第一次打开时照着做）：",
    `1. 打开 ${appUrl}`,
    "2. 出现的第一个页面上选「有人给了我一张体验卡」",
    "3. 把上面的**卡号**粘进第一栏，把下面这段**中转地址**粘进第二栏，点「用这张卡」",
    "",
    `中转地址：${relayUrl}`,
    "",
    "（不想分两栏也行：把下面这一整行一起粘进卡号那一栏也可以。）",
    pasteLine(token, { relayUrl }),
    "",
    "说明：额度用完或到期会自动停；聊天记录只存在你自己的浏览器里，服务端只统计用量、不记录内容。",
    "卡号别转发给别人。",
  ].join("\n");
}

module.exports = { DEFAULT_APP_URL, pasteLine, shareText };
