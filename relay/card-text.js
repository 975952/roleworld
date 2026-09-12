"use strict";

/*
 * relay/card-text.js —— 「发给同学的那段话」（CLI 与控制台共用同一份）
 *
 * 为什么单独一个文件：这段话是**同学唯一会照着做的东西**，两边各写一份必然写歪。
 * 2026-09-12 就栽在这里：CLI 当时只给"卡号"，而新设备不知道中转地址，
 * 同学照着做必然失败（用户实测「为什么我登的时候还是要输 apikey」）。
 *
 * 三条形式都要给全：
 *   ① 一键链接（点开就配好）          ② 可整行粘贴的 卡号@中转地址          ③ 卡号本身
 */

const DEFAULT_APP_URL = "https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com";

function stripSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/** 一键链接：点开就把卡配好（应用支持 #card=卡号@中转地址）。 */
function shareLink(token, options) {
  const opts = options || {};
  const appUrl = stripSlash(opts.appUrl || DEFAULT_APP_URL);
  const relayUrl = stripSlash(opts.relayUrl || "");
  return `${appUrl}/#card=${token}@${relayUrl}`;
}

/** 能**直接粘贴**进应用的那一行：卡号 + 中转地址。 */
function pasteLine(token, options) {
  const opts = options || {};
  return `${token}@${stripSlash(opts.relayUrl || "")}`;
}

/** 一段可以直接发给同学的话（含一键链接、可直接粘贴的一行、隐私说明）。 */
function shareText(token, quota, options) {
  const opts = options || {};
  const appUrl = stripSlash(opts.appUrl || DEFAULT_APP_URL);
  const relayUrl = stripSlash(opts.relayUrl || "");
  const limit = [];
  if (quota && Number(quota.calls) > 0) limit.push(`${quota.calls} 次`);
  if (quota && Number(quota.tokens) > 0) limit.push(`${quota.tokens} token`);
  return [
    "角色世界 · 体验卡",
    "",
    "点这个链接就能直接开始（什么都不用填）：",
    shareLink(token, { appUrl, relayUrl }),
    "",
    `卡号：${token}`,
    limit.length ? `额度：${limit.join(" / ")}` : "额度：不限（别乱用）",
    "",
    "如果链接点不开、或者你换了一台设备 / 换了个浏览器，就手动两步：",
    `1. 打开 ${appUrl}`,
    "2. 「设置 → 模型 → 体验卡」那一栏粘贴**下面这一整行**（连 @ 和后面的地址一起），点「使用体验卡」：",
    "",
    pasteLine(token, { relayUrl }),
    "",
    "（只粘卡号是不够的：手机和电脑互不相通，新设备必须知道中转地址。卡号别转发给别人。）",
    "说明：额度用完或到期会自动停；聊天记录只存在你自己的浏览器里，服务端只统计用量、不记录内容。",
  ].join("\n");
}

module.exports = { DEFAULT_APP_URL, shareLink, pasteLine, shareText };
