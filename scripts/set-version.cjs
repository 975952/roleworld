"use strict";

/*
 * set-version.cjs —— 同步版本号（无 BOM）
 *
 *   node scripts/set-version.cjs 0.1.2
 *
 * 四处一起改：
 *   - src-tauri/tauri.conf.json（安装包文件名与发布版本）
 *   - src-tauri/Cargo.toml（**Windows「应用和功能」里显示的版本、exe 元数据**）
 *   - package.json（仓库版本，CI 与文档读它）
 *   - app/version.json（网页版判断"线上是不是发了新版"，见 app/pwa.js）
 * Cargo.toml 以前漏了：装出来的 0.1.15 在系统里显示成 0.1.0（真发生过）。
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

const targets = ["src-tauri/tauri.conf.json", "package.json", "app/version.json"];
const cargoTarget = "src-tauri/Cargo.toml";
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

{
  const file = path.join(ROOT, cargoTarget);
  const before = fs.readFileSync(file, "utf8");
  // [package] 里那一行：行首的 version，第一个匹配就是包版本（依赖那些都带缩进或在行内）。
  const after = before.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
  if (after === before) {
    console.log(`${cargoTarget} 已是 ${version}`);
  } else {
    fs.writeFileSync(file, after);
    const check = fs.readFileSync(file, "utf8");
    if (!new RegExp(`^version\\s*=\\s*"${version.replace(/\./g, "\\.")}"`, "m").test(check)) {
      console.error(`${cargoTarget} 写入后校验失败，已中止`);
      process.exit(1);
    }
    console.log(`${cargoTarget} → ${version}`);
    changed += 1;
  }
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
