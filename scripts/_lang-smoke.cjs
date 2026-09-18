"use strict";
const L = require("../app/language-core.js");
// [文本, 期望：ok | soft | reject]
const cases = [
  ["你好，今天过得怎么样？", "ok"],
  ["He said " + String.fromCharCode(8220) + "OK" + String.fromCharCode(8221) + " and left. 我想你了。", "ok"],
  ["Hermione 说 iPhone 很好用。", "ok"],
  ["I think you are wrong about that.", "reject"],   // 英文卡设成中文时的越界回复
  ["好的", "ok"],
  ["...", "soft"],
  ["OK", "soft"],
  ["API 文档我看过了。", "ok"],                        // 缩写不算内容
  ["你好 Hermione！", "ok"],                          // 人名不误杀
  ["That is fine. 但是我不同意。", "soft"],            // 各一句：说不清，不拦
  ["你觉得呢？I really do not agree with you here.", "soft"],
  ["当然可以，明天我等你。", "ok"],
];
let bad = 0;
for (const [text, want] of cases) {
  const c = L.checkResponseLanguage(text, "zh");
  const got = c.ok ? (c.soft ? "soft" : "ok") : "reject";
  const good = got === want;
  if (!good) bad += 1;
  console.log((good ? "  ok  " : "  BAD ") + JSON.stringify(text) + " -> " + got + (c.code ? " (" + c.code + ")" : "")
    + " | " + (c.reason || ""));
}
// 英文角色的镜像检查
const mirror = [
  ["I will be there in ten minutes.", "ok"],
  ["I will be there. 但是我不同意。", "soft"],
  ["明天见。", "reject"],
];
for (const [text, want] of mirror) {
  const c = L.checkResponseLanguage(text, "en");
  const got = c.ok ? (c.soft ? "soft" : "ok") : "reject";
  const good = got === want;
  if (!good) bad += 1;
  console.log((good ? "  ok  " : "  BAD ") + "[en] " + JSON.stringify(text) + " -> " + got);
}
// 旧卡（语言未知）一律不判违规
const unknown = L.checkResponseLanguage("I am not sure about that.", null);
console.log((unknown.ok && unknown.unchecked ? "  ok  " : "  BAD ") + "旧卡未确认语言 -> " + JSON.stringify(unknown));
if (!unknown.ok) bad += 1;
console.log("bad=" + bad);
if (bad) process.exitCode = 1;
