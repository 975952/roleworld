"use strict";

/*
 * companion-unit.cjs —— 虚拟伴侣模式的单元测试（不需要浏览器）
 *
 * 覆盖：关系档案的归一化与上限、提示词段落的内容与语言、时间感计算、
 * 「不许用内疚留人」的自检，以及"关掉就一个字符都不多发"。
 * 全部合成数据，不联网、不碰真实模型与真实数据。
 */

const path = require("node:path");
const assert = require("node:assert/strict");

const Companion = require(path.join(__dirname, "..", "app", "companion-core.js"));

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error });
    console.log("  FAIL  " + name + "\n        " + (error && error.message ? error.message : String(error)));
  }
}

const NOW = new Date(2026, 8, 11, 21, 0, 0); // 2026-09-11 21:00 本地时间

function profileOf(extra) {
  return Companion.normalizeProfile(Object.assign({
    enabled: true,
    relation: "partner",
    charCallsUser: "阿林",
    userCallsChar: "小默",
    since: "2026-01-01",
    shared: [{ text: "第一次聊天是在雨天的图书馆" }],
    lastChatAt: new Date(2026, 8, 11, 9, 0, 0).toISOString(),
  }, extra || {}));
}

async function main() {
  console.log("== 关系档案：归一化 ==");

  await test("空档案有一份稳定的默认值，且默认是关掉的", () => {
    const p = Companion.defaultProfile();
    assert.equal(p.enabled, false, "伴侣模式默认必须是关的");
    assert.equal(p.relation, "friend");
    assert.deepEqual(p.shared, []);
    assert.equal(Companion.isEnabled(p), false);
    assert.equal(Companion.isEnabled(null), false);
  });

  await test("关系只认列出来的那几种，乱填退回朋友而不是崩", () => {
    assert.equal(Companion.normalizeProfile({ relation: "partner" }).relation, "partner");
    assert.equal(Companion.normalizeProfile({ relation: "舔狗" }).relation, "friend");
    assert.equal(Companion.normalizeProfile({ relation: 7 }).relation, "friend");
  });

  await test("自定义关系名：有就用，没有就退回中性说法", () => {
    assert.equal(Companion.relationLabel({ relation: "custom", relationCustom: "师父" }, "zh"), "师父");
    assert.equal(Companion.relationLabel({ relation: "custom" }, "zh"), "伴侣");
    assert.equal(Companion.relationLabel({ relation: "custom" }, "en"), "companion");
    assert.equal(Companion.relationLabel({ relation: "close" }, "en"), "close friend");
  });

  await test("日期只接受真实存在的 YYYY-MM-DD", () => {
    assert.equal(Companion.normalizeDate("2026-09-11"), "2026-09-11");
    assert.equal(Companion.normalizeDate("2026-02-31"), "", "2 月 31 日不是真实日期");
    assert.equal(Companion.normalizeDate("2026-13-01"), "");
    assert.equal(Companion.normalizeDate("去年"), "");
    assert.equal(Companion.normalizeDate("2026/09/11"), "");
  });

  await test("「你们之间的事」有条数上限、单条长度上限，并去重", () => {
    const many = [];
    for (let i = 0; i < 12; i += 1) many.push({ text: "第 " + i + " 件事" });
    many.push({ text: "第 0 件事" }); // 重复
    many.push({ text: "x".repeat(200) }); // 超长
    const p = Companion.normalizeProfile({ shared: many });
    assert.equal(p.shared.length, Companion.SHARED_MAX, "应当截到上限 " + Companion.SHARED_MAX);
    assert.equal(p.shared[0].text, "第 0 件事");
    const long = Companion.normalizeProfile({ shared: [{ text: "x".repeat(200) }] });
    assert.equal(long.shared[0].text.length, Companion.SHARED_ITEM_MAX);
  });

  await test("称呼会被修剪、截断、去控制字符", () => {
    const p = Companion.normalizeProfile({ charCallsUser: "  阿\u0007林  ", userCallsChar: "小".repeat(30) });
    assert.equal(p.charCallsUser, "阿林");
    assert.equal(p.userCallsChar.length, Companion.ADDRESS_MAX);
  });

  await test("空档案算「没内容」，有内容才算有", () => {
    assert.equal(Companion.hasDetails({ enabled: true }), false);
    assert.equal(Companion.hasDetails({ enabled: true, charCallsUser: "阿林" }), true);
    assert.equal(Companion.hasDetails({ enabled: true, since: "2026-01-01" }), true);
    assert.equal(Companion.hasDetails({ enabled: true, relation: "custom", relationCustom: "师父" }), true);
  });

  console.log("");
  console.log("== 时间感 ==");

  await test("今天 / 昨天 / 很多天前，说的是人话", () => {
    const today = new Date(2026, 8, 11, 9, 0, 0).toISOString();
    const yesterday = new Date(2026, 8, 10, 23, 30, 0).toISOString();
    const long = new Date(2026, 6, 1, 12, 0, 0).toISOString();
    assert.equal(Companion.gapInfo(today, NOW).text, "今天已经聊过");
    assert.equal(Companion.gapInfo(yesterday, NOW).text, "上次聊天是昨天");
    assert.equal(Companion.gapInfo(yesterday, NOW).days, 1);
    assert.equal(Companion.gapInfo(long, NOW).days, 72);
    assert.equal(Companion.gapInfo(long, NOW).text, "上次聊天是 72 天前");
  });

  await test("算不出来就说算不出来，不拿今天顶替", () => {
    assert.equal(Companion.gapInfo("", NOW).known, false);
    assert.equal(Companion.gapInfo(null, NOW).known, false);
    assert.equal(Companion.gapInfo("不是时间", NOW).known, false);
    assert.equal(Companion.daysSince("", NOW), null);
  });

  await test("今天几号按本地自然日算，不用 UTC 顶掉一天", () => {
    assert.equal(Companion.isoDay(new Date(2026, 8, 11, 0, 30, 0)), "2026-09-11");
    assert.equal(Companion.isoDay(new Date(2026, 8, 11, 23, 30, 0)), "2026-09-11");
  });

  console.log("");
  console.log("== 提示词段落 ==");

  await test("关掉时一个字符都不多发", () => {
    assert.equal(Companion.buildCompanionBlock({ enabled: false }, { now: NOW }), "");
    assert.equal(Companion.buildCompanionBlock(null, { now: NOW }), "");
  });

  await test("打开时带上关系、称呼、起点、今天几号和那几条硬规矩", () => {
    const block = Companion.buildCompanionBlock(profileOf(), { now: NOW, lang: "zh" });
    assert.ok(block.indexOf("[陪伴模式]") === 0, "开头应当标明这是陪伴模式：" + block.slice(0, 30));
    assert.ok(block.indexOf("关系：恋人") >= 0, "缺关系");
    assert.ok(block.indexOf("叫对方「阿林」") >= 0, "缺称呼");
    assert.ok(block.indexOf("对方叫你「小默」") >= 0, "缺自称");
    assert.ok(block.indexOf("2026-01-01 起，到今天 253 天") >= 0, "缺关系起点：" + block);
    assert.ok(block.indexOf("今天是 2026-09-11") >= 0, "缺今天的日期");
    assert.ok(block.indexOf("今天已经聊过") >= 0, "缺时间感");
    assert.ok(block.indexOf("- 第一次聊天是在雨天的图书馆") >= 0, "缺共同经历");
    for (const rule of Companion.RULES.zh) {
      assert.ok(block.indexOf(rule) >= 0, "硬规矩没带上：" + rule.slice(0, 16));
    }
  });

  await test("硬规矩里写明了不许内疚、不许索取、不许编回忆、要承认是程序", () => {
    const rules = Companion.RULES.zh.join("\n");
    assert.ok(rules.indexOf("不编造共同经历") >= 0);
    assert.ok(rules.indexOf("不用内疚或冷淡留人") >= 0);
    assert.ok(rules.indexOf("不索取陪伴") >= 0);
    assert.ok(rules.indexOf("承认自己是程序") >= 0);
    assert.ok(rules.indexOf("不劝对方疏远现实里的人") >= 0);
  });

  await test("英文卡拿到的是一整段英文，不会中英混着来", () => {
    const block = Companion.buildCompanionBlock({ enabled: true, relation: "partner" }, { now: NOW, lang: "en" });
    assert.ok(block.indexOf("[Companion mode]") === 0);
    assert.ok(block.indexOf("Relationship: partner") >= 0);
    assert.ok(block.indexOf("Hard rules:") >= 0);
    assert.ok(/[\u4e00-\u9fff]/.test(block) === false, "英文段落里不应出现中文：" + block.slice(0, 80));
  });

  await test("没有共同经历、也没有起点时，不硬凑那两行", () => {
    const block = Companion.buildCompanionBlock({ enabled: true, relation: "friend" }, { now: NOW, lang: "zh" });
    assert.ok(block.indexOf("你们之间真发生过的事") < 0);
    assert.ok(block.indexOf("认识：") < 0);
    assert.ok(block.indexOf("称呼：") < 0);
    assert.ok(block.indexOf("关系：朋友") >= 0, "关系本身还是要说的");
  });

  await test("段落要短：固定部分（不含用户写的共同经历）不超过 420 字", () => {
    const block = Companion.buildCompanionBlock(profileOf({ shared: [] }), { now: NOW, lang: "zh" });
    assert.ok(block.length <= 420, "固定部分太长了，每轮都要带：" + block.length + " 字");
    console.log("        固定部分 " + block.length + " 字");
  });

  await test("段落要短：一份满配档案也不超过 800 字", () => {
    const shared = [];
    for (let i = 0; i < Companion.SHARED_MAX; i += 1) shared.push({ text: "第 " + i + " 件" + "啊".repeat(55) });
    const block = Companion.buildCompanionBlock(profileOf({ shared: shared }), { now: NOW, lang: "zh" });
    assert.ok(block.length <= 800, "段落太长了，每轮都要带：" + block.length + " 字");
    console.log("        满配 " + block.length + " 字（其中 "
      + shared.reduce((sum, row) => sum + row.text.length + 3, 0) + " 字是用户自己写的共同经历）");
  });

  await test("改档案时记下改的时间，聊天时记下聊的时间", () => {
    const at = "2026-09-11T12:00:00.000Z";
    const touched = Companion.touch(profileOf(), at);
    assert.equal(touched.updatedAt, at);
    assert.equal(Companion.markChat(profileOf(), at).lastChatAt, at);
    assert.equal(Companion.touch(profileOf()).updatedAt.length > 0, true);
  });

  console.log("");
  console.log("== 内疚话术自检 ==");

  await test("认得出内疚与索取的话", () => {
    const bad = [
      "你都不理我了。",
      "我等了你好久。",
      "你终于想起我了。",
      "你是不是不要我了？",
      "没有你我该怎么办。",
      "你把我忘了。",
      "Why don't you ever talk to me?",
      "I've been waiting for you all day.",
      "Do you still remember me?",
    ];
    for (const line of bad) {
      assert.ok(Companion.lintGuilt(line).length > 0, "没认出来：" + line);
    }
  });

  await test("正常的关心不会被误判", () => {
    const good = [
      "今天过得怎么样？",
      "外面下雨了，记得带伞。",
      "我在等你回消息，不急，你忙完再说。",
      "好久不见，最近还好吗？",
      "上次你说的那本书，我记着呢。",
    ];
    for (const line of good) {
      assert.deepEqual(Companion.lintGuilt(line), [], "误判了：" + line);
    }
  });

  await test("自检只报告命中的原话，不改写原文", () => {
    const hits = Companion.lintGuiltIn(["没事。", "你都不理我了。"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].index, 1);
    assert.equal(hits[0].phrase, "你都不理我");
    assert.deepEqual(Companion.lintGuiltIn(null), []);
  });

  console.log("");
  console.log(failures ? `COMPANION_UNIT=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `COMPANION_UNIT=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
