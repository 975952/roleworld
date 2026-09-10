"use strict";

/*
 * set-version.cjs —— 同步版本号（无 BOM）
 *
 *   node scripts/set-version.cjs 0.1.2
 *
 * 同时改 src-tauri/tauri.conf.json 与 package.json。
 * 刻意不用 PowerShell 改：PS 5.1 的 Set-Content -Encoding UTF8 会写 UTF-8 BOM，
 * 而 Rust 的 serde_json 不接受 BOM —— 曾经因此让一次发布 37 秒就打包失败。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const version = String(process.argv[2] || "").trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：node scripts/set-version.cjs 1.2.3");
  process.exit(1);
}

const targets = ["src-tauri/tauri.conf.json", "package.json"];
let changed = 0;

for (const relative of targets) {
  const file = path.join(ROOT, relative);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (after === before) {
    console.log(`${relative} 已是 ${version}`);
    continue;
  }
  fs.writeFileSync(file, after); // 默认 utf8，无 BOM
  JSON.parse(after);             // 立刻自检，别把坏文件写进仓库
  console.log(`${relative} → ${version}`);
  changed += 1;
}

// tauri.conf.json 的 JSON 解析能通过不代表没有 BOM（BOM 在 Node 里会被容忍），单独查一次。
for (const relative of targets) {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    console.error(`${relative} 被写入了 BOM，已中止`);
    process.exit(1);
  }
}

console.log(`完成，改动 ${changed} 个文件。`);
