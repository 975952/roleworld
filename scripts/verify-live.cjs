"use strict";

/*
 * verify-live.cjs —— 上线后核对：本地 app/ 与线上逐文件对字节
 *
 *   node scripts/verify-live.cjs
 *   node scripts/verify-live.cjs --host https://别的域名
 *
 * 为什么要单独一个脚本：CloudBase 的边缘防护会对无头浏览器返回"风险提醒"页，
 * 所以自动化验收在这条链路上只能靠"取字节 + 比字节"，不能靠打开页面。
 * 每次部署完跑一遍，把"我以为传上去了"变成"确实一致"。
 *
 * 默认站点见 docs/WEB_DEPLOY.md。读取会用 Cache-Control: no-cache 绕开 CDN 缓存。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "app");
const hostArg = process.argv.indexOf("--host");
const HOST = hostArg >= 0 ? String(process.argv[hostArg + 1] || "") : "https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com";
const CONCURRENCY = 6;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

async function fetchRemote(relative) {
  const url = HOST.replace(/\/$/, "") + "/" + relative;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" }, redirect: "follow" });
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buffer };
    } catch (error) {
      if (attempt === 2) return { status: 0, error: error.message, buffer: Buffer.alloc(0) };
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

(async () => {
  if (!fs.existsSync(APP)) {
    console.error("找不到 " + APP);
    process.exit(1);
  }
  const files = walk(APP).sort();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  console.log(`站点：${HOST}`);
  console.log(`本地 app/ 共 ${files.length} 个文件，逐个核对（版本 ${pkg.version}）…`);

  const problems = [];
  let checked = 0;
  let queue = files.slice();
  // ⚠ 换行符不算差异：仓库里 `.gitattributes` 是 `* text=auto eol=lf`，
  //   而**线上那份是部署时的工作副本**（Windows 上写出去的是 CRLF）。
  //   2026-09-18 实测：全新 clone（LF）之后核对，`adapter/pricing.js` 与 `magic-map.html`
  //   报"字节数不一致"，差值正好等于行数 —— 内容一模一样，只是 CRLF/LF。
  //   所以比较前把两边的 CRLF 归一成 LF（其余字节仍然逐字节比）。
  const normalizeEol = (buffer) => (buffer.includes(0x0d)
    ? Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
    : buffer);

  async function worker() {
    while (queue.length) {
      const relative = queue.shift();
      const local = fs.readFileSync(path.join(APP, relative));
      const remote = await fetchRemote(relative);
      checked += 1;
      if (remote.status !== 200) {
        problems.push(`${relative}：HTTP ${remote.status}${remote.error ? " " + remote.error : ""}`);
        continue;
      }
      const left = normalizeEol(local);
      const right = normalizeEol(remote.buffer);
      if (right.length !== left.length) {
        problems.push(`${relative}：字节数不一致 本地 ${left.length} / 线上 ${right.length}`);
        continue;
      }
      const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
      if (hash(right) !== hash(left)) {
        problems.push(`${relative}：字节数相同但内容不同（sha256 不一致）`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 除了"逐文件一致"，再钉住几件上线后才看得出来的事。
  const liveVersion = await fetchRemote("version.json");
  let liveVersionValue = null;
  try { liveVersionValue = JSON.parse(liveVersion.buffer.toString("utf8")).version; } catch (_) {}
  if (liveVersionValue !== pkg.version) {
    problems.push(`version.json：线上是 ${liveVersionValue}，仓库是 ${pkg.version}`);
  }

  const liveIndex = await fetchRemote("index.html");
  const indexText = liveIndex.buffer.toString("utf8");
  const button = indexText.match(/<button[^>]*data-action="open-memories"[^>]*>/);
  if (!button) problems.push("index.html：线上找不到顶栏「记忆」按钮");
  else if (/\shidden(\s|>)/.test(button[0])) problems.push("index.html：线上那颗「记忆」按钮又带上 hidden 了：" + button[0]);
  if (indexText.indexOf("manifest.webmanifest") < 0) problems.push("index.html：线上没有引用 PWA 清单");

  // 内置包里"别人的存档"（原 SillyTavern 存档的玩家角色 Lin）已经删掉，
  // 线上也不许再留着这几个文件 —— 部署只上传、不清理远端旧文件，旧的那几份得单独删。
  const mustBeGone = [
    "packs/harry-potter/worlds/MB Harry — fact clips (EN).json",
    "packs/harry-potter/worlds/MB Harry — relationship tracker (EN).json",
    "packs/harry-potter/worlds/MB Harry — scene memories (EN).json",
  ];
  for (const relative of mustBeGone) {
    const res = await fetchRemote(relative);
    if (res.status === 200) problems.push("线上还留着已经删除的示例内容：" + relative);
  }

  if (problems.length) {
    console.error(`\n✗ ${problems.length} 处问题（核对了 ${checked} 个文件）：`);
    for (const row of problems) console.error("  - " + row);
    process.exit(1);
  }
  console.log(`\n✓ ${checked}/${files.length} 个文件与线上逐字节一致；version.json = ${liveVersionValue}；顶栏「记忆」按钮在线且没带 hidden。`);
})().catch((error) => {
  console.error("核对失败：" + error.message);
  process.exit(1);
});
