"use strict";
/* 验证：APK 的原生库里到底嵌的是哪一版 app 代码（临时工具）。
   方法：在 app/ 里选几个"只有新版才有"的特征串，去 .so 里找。 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const apk = process.argv[2] || "dist/RoleWorld_0.1.54_android_universal.apk";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-assets-"));
execFileSync("tar", ["-xf", apk, "-C", tmp], { stdio: "ignore" });
const so = [];
for (const root of [tmp]) {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".so")) so.push(full);
    }
  };
  walk(root);
}
if (!so.length) { console.log("APK 里没有 .so"); process.exit(1); }
const blob = so.map((f) => fs.readFileSync(f).toString("latin1")).join("");

// 特征串：新版 app/ 里才有的
const checks = [
  ["voice-core：原生桥探测（__rwNativeTts）", "__rwNativeTts"],
  ["voice-core：桥就绪事件名", "rw-native-tts-ready"],
  ["voice-core：voiceSelfTest 键", "roleworld.voiceSelfTest"],
  ["sticker-core：表情标记", "表情"],
  ["integration：设置页语音说明（原生桥）", "原生语音桥"],
  ["integration：菜单现算（canSpeakNow）", "canSpeakNow"],
];
let bad = 0;
for (const [label, needle] of checks) {
  const hit = blob.indexOf(needle) >= 0;
  if (!hit) bad += 1;
  console.log((hit ? "  ✅ " : "  ❌ ") + label);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n有 ${bad} 项没进包` : "\n包里是最新的 app 代码");
