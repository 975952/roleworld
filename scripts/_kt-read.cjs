"use strict";
/* 按 UTF-8 读生成出来的 Kotlin，定位编译错误（临时工具）。 */
const fs = require("node:fs");
const file = "src-tauri/gen/android/app/src/main/java/app/roleworld/desktop/MainActivity.kt";
const lines = fs.readFileSync(file, "utf8").split("\n");
console.log("总行数 " + lines.length);
console.log("--- 188~200 ---");
for (let i = 187; i < 200 && i < lines.length; i += 1) {
  console.log((i + 1) + ": " + lines[i]);
}
console.log("--- 检查是否有行被拼在一起（KDoc 里常见）---");
const joined = lines.filter((l) => (l.match(/^\s*\*/g) || []).length > 1);
console.log("同一行里有多个 * 的行数：" + joined.length);
joined.slice(0, 5).forEach((l) => console.log("   " + l.slice(0, 120)));
