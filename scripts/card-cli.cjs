"use strict";

/*
 * card-cli.cjs —— 在本机发卡 / 查卡 / 停卡（不碰数据库，只跟中转服务的管理接口说话）
 *
 *   node scripts/card-cli.cjs issue --label 小明 --calls 200 --days 30
 *   node scripts/card-cli.cjs list
 *   node scripts/card-cli.cjs disable <卡id>
 *   node scripts/card-cli.cjs enable  <卡id>
 *   node scripts/card-cli.cjs revoke  <卡id>
 *   node scripts/card-cli.cjs quota   RW-XXXXX-XXXXX-XXXXX     （这条不需要口令）
 *   node scripts/card-cli.cjs text    RW-XXXXX-XXXXX-XXXXX     （生成一段能直接发给同学的话）
 *
 * 凭据：口令优先读环境变量 ADMIN_SECRET，没有就读本机 relay/admin-secret.local.txt；
 * 中转地址优先 RELAY_URL，没有就用默认线上中转（见 relay/admin-client.js）。
 * 卡号只在 issue 那一次返回（账本里只有哈希），发完就复制走 —— 想留底就用控制台（npm run console）。
 *
 * 想点界面而不是敲命令：`npm run console`（只监听 127.0.0.1，口令不进浏览器）。
 */

const path = require("node:path");

const args = process.argv.slice(2);
const command = String(args[0] || "").trim();

function flag(name, fallback) {
  const index = args.indexOf("--" + name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined ? true : value;
}

const admin = require(path.join(__dirname, "..", "relay", "admin-client.js"));
const cardText = require(path.join(__dirname, "..", "relay", "card-text.js"));

const RELAY_URL = admin.resolveRelayUrl(flag("relay", ""));
const APP_URL = String(flag("app", process.env.APP_URL || cardText.DEFAULT_APP_URL)).replace(/\/+$/, "");
const client = admin.createAdminClient({ relayUrl: RELAY_URL, adminSecret: flag("admin", "") });

function usage() {
  console.log([
    "用法：",
    "  node scripts/card-cli.cjs issue --label 小明 --calls 200 --days 30 [--count 5]",
    "  node scripts/card-cli.cjs list | disable <id> | enable <id> | revoke <id>",
    "  node scripts/card-cli.cjs quota <卡号> | text <卡号>",
    "",
    "凭据：ADMIN_SECRET 环境变量，或本机 relay/admin-secret.local.txt（已 gitignore）；",
    "RELAY_URL 可选（默认线上中转），APP_URL 可选（默认线上网页版，只用来拼一键链接）。",
    "界面版：npm run console",
  ].join("\n"));
}

(async () => {
  if (!command || command === "help" || command === "-h" || command === "--help") return usage();

  if (command === "quota") {
    const token = args[1];
    if (!token) return usage();
    const body = await client.quota(token);
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "text") {
    const token = args[1];
    if (!token) return usage();
    const body = await client.quota(token);
    console.log(cardText.shareText(token, body && body.quota, { appUrl: APP_URL, relayUrl: RELAY_URL }));
    return;
  }

  if (!client.hasSecret) {
    console.error("没有发卡口令：设置环境变量 ADMIN_SECRET，或把口令写进 relay/admin-secret.local.txt");
    process.exitCode = 1;
    return;
  }

  if (command === "issue") {
    const count = Math.max(1, Math.min(50, Number(flag("count", 1)) || 1));
    const label = String(flag("label", ""));
    const issued = [];
    for (let i = 1; i <= count; i += 1) {
      const body = await client.createCard({
        // 一次发多张时自动编号：同学1 / 同学2 …… 便于之后对账。
        label: count > 1 && label ? `${label}${i}` : (label || (count > 1 ? `体验卡${i}` : "")),
        calls: Number(flag("calls", 0)) || 0,
        tokens: Number(flag("tokens", 0)) || 0,
        days: Number(flag("days", 30)) || 0,
        note: String(flag("note", "")),
      });
      issued.push(body);
    }

    console.log(`发卡成功：${issued.length} 张（卡号只显示这一次，复制走）\n`);
    console.log(["序".padEnd(4), "卡号".padEnd(24), "卡id".padEnd(14), "额度".padEnd(12), "到期"].join(" "));
    issued.forEach((card, index) => {
      console.log([
        String(index + 1).padEnd(4),
        card.token.padEnd(24),
        String(card.id).padEnd(14),
        (`${(card.quota && card.quota.calls) || 0} 次`).padEnd(12),
        String(card.expiresAt || "不过期").slice(0, 10),
      ].join(" "));
    });
    console.log("\n===== 下面每段都可以直接转发给一个同学 =====");
    issued.forEach((card, index) => {
      console.log(`\n----- 第 ${index + 1} 张 -----`);
      console.log(cardText.shareText(card.token, card.quota, { appUrl: APP_URL, relayUrl: RELAY_URL }));
    });
    return;
  }

  if (command === "list") {
    const cards = await client.listCards();
    if (!cards.length) { console.log("还没有发过卡。"); return; }
    console.log(["卡id".padEnd(14), "标签".padEnd(10), "已用/上限（次）".padEnd(18), "token 已用".padEnd(12), "到期".padEnd(12), "状态"].join(" "));
    for (const card of cards) {
      const calls = `${card.used.calls}/${card.quota.calls || "∞"}`;
      console.log([
        String(card.id).padEnd(14),
        String(card.label || "-").padEnd(10),
        calls.padEnd(18),
        String(card.used.tokens).padEnd(12),
        String((card.expiresAt || "不过期").slice(0, 10)).padEnd(12),
        card.disabled ? "已停用" : "可用",
      ].join(" "));
    }
    return;
  }

  if (command === "disable" || command === "enable") {
    const id = args[1];
    if (!id) return usage();
    const body = await client.setDisabled(id, command === "disable");
    console.log((body.disabled ? "已停用" : "已启用") + "：" + body.id);
    return;
  }

  if (command === "revoke") {
    const id = args[1];
    if (!id) return usage();
    const body = await client.revoke(id);
    console.log(body.removed ? "已吊销：" + id : "没找到这张卡：" + id);
    return;
  }

  usage();
})().catch((error) => {
  console.error("失败：" + (error && error.message || error));
  process.exitCode = 1;
});
