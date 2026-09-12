"use strict";

/*
 * card-cli.cjs —— 在本机发卡 / 查卡 / 停卡（不碰数据库，只跟中转服务的管理接口说话）
 *
 *   set RELAY_URL=https://你的中转地址
 *   set ADMIN_SECRET=你设的那串口令
 *
 *   node scripts/card-cli.cjs issue --label 小明 --calls 200 --days 30
 *   node scripts/card-cli.cjs list
 *   node scripts/card-cli.cjs disable <卡id>
 *   node scripts/card-cli.cjs enable  <卡id>
 *   node scripts/card-cli.cjs revoke  <卡id>
 *   node scripts/card-cli.cjs quota   RW-XXXXX-XXXXX-XXXXX     （这条不需要口令）
 *   node scripts/card-cli.cjs text    RW-XXXXX-XXXXX-XXXXX     （生成一段能直接发给同学的话）
 *
 * 卡号只在 issue 那一次返回（账本里只有哈希），发完就复制走。
 */

const args = process.argv.slice(2);
const command = String(args[0] || "").trim();

function flag(name, fallback) {
  const index = args.indexOf("--" + name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined ? true : value;
}

const RELAY_URL = String(flag("relay", process.env.RELAY_URL || "")).replace(/\/+$/, "");
const ADMIN_SECRET = String(flag("admin", process.env.ADMIN_SECRET || ""));

function usage() {
  console.log([
    "用法：",
    "  node scripts/card-cli.cjs issue --label 小明 --calls 200 --days 30",
    "  node scripts/card-cli.cjs list | disable <id> | enable <id> | revoke <id>",
    "  node scripts/card-cli.cjs quota <卡号> | text <卡号>",
    "",
    "需要先设环境变量 RELAY_URL（中转地址）与 ADMIN_SECRET（发卡口令）。",
  ].join("\n"));
}

async function call(path, options) {
  const opts = options || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.admin === false ? {} : { Authorization: "Bearer " + ADMIN_SECRET }, opts.headers || {});
  const res = await fetch(RELAY_URL + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  if (!res.ok) throw new Error("HTTP " + res.status + "：" + (body.error && (body.error.message || body.error) || text).toString().slice(0, 200));
  return body;
}

/** 一段可以直接发给同学的话（含卡号、怎么用、隐私说明）。 */
function shareText(token, quota) {
  const limit = [];
  if (quota && Number(quota.calls) > 0) limit.push(`${quota.calls} 次`);
  if (quota && Number(quota.tokens) > 0) limit.push(`${quota.tokens} token`);
  return [
    "角色世界 · 体验卡",
    "",
    `卡号：${token}`,
    limit.length ? `额度：${limit.join(" / ")}` : "额度：不限（别乱用）",
    "",
    "怎么用（三步）：",
    "1. 打开 https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com",
    "2. 「设置 → 模型」里把接口地址填成：" + RELAY_URL + "/v1/chat/completions",
    "3. 「体验卡」那一栏粘贴卡号 → 保存。模型名填 deepseek-flash。",
    "",
    "说明：卡号就是你的通行证，别转发给别人；额度用完或到期会自动停。",
    "这张卡走的是发起人自己的模型账号，所以发起人能看到「用量」，但服务端**不记录对话内容**——",
    "聊天记录只存在你自己的浏览器里。",
  ].join("\n");
}

(async () => {
  if (!command || command === "help" || command === "-h" || command === "--help") return usage();
  if (!RELAY_URL) { console.error("先设 RELAY_URL（例如 set RELAY_URL=https://xxx.tcloudbaseapp.com/relay）"); process.exitCode = 1; return; }

  if (command === "quota") {
    const token = args[1];
    if (!token) return usage();
    const body = await call("/card/quota", { admin: false, headers: { Authorization: "Bearer " + token } });
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "text") {
    const token = args[1];
    if (!token) return usage();
    const body = await call("/card/quota", { admin: false, headers: { Authorization: "Bearer " + token } });
    console.log(shareText(token, body.quota));
    return;
  }

  if (!ADMIN_SECRET) { console.error("先设 ADMIN_SECRET（发卡口令）"); process.exitCode = 1; return; }

  if (command === "issue") {
    const body = await call("/admin/cards", {
      method: "POST",
      body: {
        label: String(flag("label", "")),
        calls: Number(flag("calls", 0)) || 0,
        tokens: Number(flag("tokens", 0)) || 0,
        days: Number(flag("days", 30)) || 0,
        note: String(flag("note", "")),
      },
    });
    console.log("发卡成功（卡号只显示这一次，复制走）：\n");
    console.log("  卡号：" + body.token + "    卡id：" + body.id);
    console.log("  额度：" + JSON.stringify(body.quota) + "   到期：" + (body.expiresAt || "不过期"));
    console.log("\n----- 下面这段可以直接发给同学 -----\n");
    console.log(shareText(body.token, body.quota));
    return;
  }

  if (command === "list") {
    const body = await call("/admin/cards");
    if (!body.cards.length) { console.log("还没有发过卡。"); return; }
    console.log(["卡id".padEnd(14), "标签".padEnd(10), "已用/上限（次）".padEnd(18), "token 已用".padEnd(12), "到期".padEnd(12), "状态"].join(" "));
    for (const card of body.cards) {
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
    const body = await call("/admin/cards/" + id + "/" + command, { method: "POST" });
    console.log((body.disabled ? "已停用" : "已启用") + "：" + body.id);
    return;
  }

  if (command === "revoke") {
    const id = args[1];
    if (!id) return usage();
    const body = await call("/admin/cards/" + id, { method: "DELETE" });
    console.log(body.removed ? "已吊销：" + id : "没找到这张卡：" + id);
    return;
  }

  usage();
})().catch((error) => {
  console.error("失败：" + (error && error.message || error));
  process.exitCode = 1;
});
