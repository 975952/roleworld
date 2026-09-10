"use strict";

/*
 * desktop-smoke.cjs —— 桌面端冒烟测试
 *
 * 不做 UI 自动化（那需要 tauri-driver），只验证真正要紧的一件事：
 * 装上/启动之后，数据是不是真的以**普通文件**的形式落在了磁盘上。
 *
 * 前置：先 `pnpm desktop:build` 产出 exe。
 * 运行：node tests/desktop-smoke.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "roleworld.exe");

const IDENTIFIER = "app.roleworld.desktop";
const DATA_DIR = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), IDENTIFIER, "data")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", IDENTIFIER, "data")
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), IDENTIFIER, "data");

const EXPECTED_CHARACTERS = 6;
const EXPECTED_WORLDS = 4;
const WAIT_MS = 25000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log("没有找到 " + EXE + "，先运行 pnpm desktop:build。");
    process.exitCode = 1;
    return;
  }

  console.log(`可执行文件：${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`数据目录：${DATA_DIR}`);

  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const child = spawn(EXE, [], { detached: false, stdio: "ignore" });
  console.log(`已启动（pid ${child.pid}），等待写入内容包…`);

  let files = [];
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (!fs.existsSync(DATA_DIR)) continue;
    files = walk(DATA_DIR);
    if (files.filter((file) => file.includes(`${path.sep}characters${path.sep}`)).length >= EXPECTED_CHARACTERS) break;
    if (child.exitCode !== null) break;
  }

  try { child.kill(); } catch (_) { /* 已退出 */ }
  await sleep(1500);
  try { child.kill("SIGKILL"); } catch (_) { /* 已退出 */ }

  const relative = files.map((file) => path.relative(DATA_DIR, file));
  const characters = relative.filter((name) => name.startsWith("characters" + path.sep));
  const worlds = relative.filter((name) => name.startsWith("worlds" + path.sep));
  const blobs = relative.filter((name) => name.startsWith("blobs" + path.sep));
  const kv = relative.filter((name) => name.startsWith("kv" + path.sep));

  console.log("");
  console.log("characters =", characters.length);
  characters.forEach((name) => console.log("   " + name));
  console.log("worlds     =", worlds.length);
  worlds.forEach((name) => console.log("   " + name));
  console.log("blobs      =", blobs.length);
  console.log("kv         =", kv.length);

  const problems = [];
  if (characters.length !== EXPECTED_CHARACTERS) problems.push(`角色卡应为 ${EXPECTED_CHARACTERS} 个，实际 ${characters.length}`);
  if (worlds.length !== EXPECTED_WORLDS) problems.push(`记忆书应为 ${EXPECTED_WORLDS} 本，实际 ${worlds.length}`);
  if (blobs.length !== EXPECTED_CHARACTERS) problems.push(`头像应为 ${EXPECTED_CHARACTERS} 个，实际 ${blobs.length}`);
  if (!relative.some((name) => name.includes("Harry Potter (EN).png.json"))) problems.push("缺少默认角色 Harry Potter (EN).png.json");
  if (blobs.some((name) => fs.statSync(path.join(DATA_DIR, name)).size < 1000)) problems.push("有头像文件是空的");

  console.log("");
  if (problems.length) {
    problems.forEach((line) => console.log("  FAIL  " + line));
    console.log("DESKTOP_SMOKE=fail");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS  数据以普通文件落盘，角色卡 / 记忆书 / 头像齐全");
  console.log("DESKTOP_SMOKE=pass");
}

main().catch((error) => {
  console.error("冒烟测试失败：", error);
  process.exitCode = 1;
});
