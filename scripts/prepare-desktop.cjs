"use strict";

/*
 * prepare-desktop.cjs —— 桌面端打包前的准备
 *
 * 桌面版把 `app/` 整个当静态资源目录，内容包在它的上一层，浏览器取不到。
 * 所以打包前把 `packs/` 复制进 `app/packs/`（已在 .gitignore 里忽略，不会污染仓库）。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "packs");
const TARGET = path.join(ROOT, "app", "packs");

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

if (!fs.existsSync(SOURCE)) {
  console.log("没有 packs/ 目录，跳过。");
  process.exit(0);
}

fs.rmSync(TARGET, { recursive: true, force: true });
copyTree(SOURCE, TARGET);
const count = fs.readdirSync(TARGET, { recursive: true }).length;
console.log(`内容包已就位：${TARGET}（${count} 个条目）`);
