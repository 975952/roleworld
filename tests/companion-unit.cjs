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
    assert.ok(rules.indexOf("不用内疚") >= 0, "内疚那条不能少：" + rules);
    assert.ok(rules.indexOf("不威胁") >= 0, "威胁那条不能少");
    assert.ok(rules.indexOf("不索取陪伴") >= 0);
    assert.ok(rules.indexOf("承认自己是程序") >= 0);
    assert.ok(rules.indexOf("不劝对方疏远现实里的人") >= 0);
    // 2026-09-12 起"可以有情绪"是明写的（不许有情绪的老规矩已经作废）。
    assert.ok(rules.indexOf("可以有情绪") >= 0, "要明写允许有情绪");
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

  await test("段落要短：一份满配档案也不超过 840 字", () => {
    // 2026-09-12 起上限从 800 放到 840：伴侣模式 v2 多带三行（亲近度 / 冷落语气 / 「像真人」），
    // 那是这个模式**独有**的内容，而且伴侣模式默认关着、每轮只多这几十字。
    const shared = [];
    for (let i = 0; i < Companion.SHARED_MAX; i += 1) shared.push({ text: "第 " + i + " 件" + "啊".repeat(55) });
    const block = Companion.buildCompanionBlock(profileOf({ shared: shared }), { now: NOW, lang: "zh" });
    assert.ok(block.length <= 840, "段落太长了，每轮都要带：" + block.length + " 字");
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
  console.log("== 上次说到 ==");

  await test("隔了天才出现，而且取的是你说的那句话", () => {
    const messages = [
      { name: "我", is_user: true, mes: "我想养一只猫", send_date: new Date(2026, 8, 8, 20, 0, 0).toISOString() },
      { name: "小默", is_user: false, mes: "那就养吧。", send_date: new Date(2026, 8, 8, 20, 0, 5).toISOString() },
      { name: "我", is_user: true, mes: "猫粮换了牌子，它不太爱吃新的", send_date: new Date(2026, 8, 8, 20, 3, 0).toISOString() },
      { name: "小默", is_user: false, mes: "旧的掺一半试试。", send_date: new Date(2026, 8, 8, 20, 3, 5).toISOString() },
    ];
    const info = Companion.chatRecap(messages, { now: NOW });
    assert.ok(info, "隔了三天应当给出「上次说到」");
    assert.equal(info.days, 3);
    assert.equal(info.fromUser, true, "应当取用户那句话");
    assert.equal(info.snippet, "猫粮换了牌子，它不太爱吃新的");
    assert.equal(info.gap.text, "上次聊天是 3 天前");
  });

  await test("刚聊过就不打扰（同一天不显示）", () => {
    const messages = [
      { is_user: true, mes: "在吗", send_date: new Date(2026, 8, 11, 20, 0, 0).toISOString() },
      { is_user: false, mes: "在。", send_date: new Date(2026, 8, 11, 20, 0, 5).toISOString() },
    ];
    assert.equal(Companion.chatRecap(messages, { now: NOW }), null);
  });

  await test("新对话（只有一条）不显示", () => {
    const one = [{ is_user: false, mes: "你好。", send_date: new Date(2026, 8, 1).toISOString() }];
    assert.equal(Companion.chatRecap(one, { now: NOW }), null);
    assert.equal(Companion.chatRecap([], { now: NOW }), null);
    assert.equal(Companion.chatRecap(null, { now: NOW }), null);
  });

  await test("没有时间戳就不猜，宁可不显示", () => {
    const messages = [
      { is_user: true, mes: "上次说的那件事" },
      { is_user: false, mes: "嗯。" },
    ];
    assert.equal(Companion.chatRecap(messages, { now: NOW }), null);
  });

  await test("长句子截断并压成一行，不带换行进去", () => {
    const long = "第一行\n第二行 " + "啊".repeat(80);
    const messages = [
      { is_user: true, mes: "前面那句", send_date: new Date(2026, 8, 1).toISOString() },
      { is_user: true, mes: long, send_date: new Date(2026, 8, 1).toISOString() },
      { is_user: false, mes: "好。", send_date: new Date(2026, 8, 1).toISOString() },
    ];
    const info = Companion.chatRecap(messages, { now: NOW });
    assert.ok(info.snippet.length <= Companion.RECAP_SNIPPET_MAX + 1, "没截断：" + info.snippet.length);
    assert.ok(info.snippet.endsWith("…"), "截断了就该有省略号");
    assert.equal(info.snippet.indexOf("\n"), -1, "换行没压掉");
  });

  await test("没有用户消息时退回最后一条，并标明不是用户说的", () => {
    const messages = [
      { is_user: false, mes: "（他把书合上）", send_date: new Date(2026, 8, 9).toISOString() },
      { is_user: false, mes: "（灯灭了）", send_date: new Date(2026, 8, 9, 1, 0, 0).toISOString() },
    ];
    const info = Companion.chatRecap(messages, { now: NOW });
    assert.ok(info);
    assert.equal(info.fromUser, false);
    assert.equal(info.snippet, "（灯灭了）");
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

  console.log("== 伴侣模式 v2：亲近度 / 冷落反应 / 主动消息（2026-09-12 用户拍板）==");

  await test("亲近度：算出来的，不是模型打的分（共同经历 + 认识时长 − 冷落）", () => {
    const base = profileOf({ lastChatAt: new Date(NOW.getTime() - 3600000).toISOString() });
    const plain = Companion.suggestAffinity(base, NOW);
    const richer = Companion.suggestAffinity(profileOf({
      shared: [{ text: "a" }, { text: "b" }, { text: "c" }],
      lastChatAt: new Date(NOW.getTime() - 3600000).toISOString(),
    }), NOW);
    assert.ok(richer > plain, "共同经历更多，亲近度应当更高：" + plain + " → " + richer);
    // 确定性：同样的输入永远同样的值（不然就成了"看模型心情"）。
    assert.equal(Companion.suggestAffinity(base, NOW), plain, "同一个档案算出了不同的亲近度");
    // 冷落会扣，但有下限 —— 不搞"清零惩罚"。
    const neglected = Companion.suggestAffinity(profileOf({ lastChatAt: "2025-01-01T10:00:00" }), NOW);
    assert.ok(neglected >= Companion.AFFINITY_FLOOR, "掉到下限以下了：" + neglected);
    assert.ok(neglected < plain, "很长时间没聊居然没扣：" + neglected + " vs " + plain);
  });

  await test("亲近度：用户可以自己拉（manual），也可以交回系统（auto）", () => {
    const manual = Companion.affinityOf(profileOf({ affinityMode: "manual", affinity: 88 }), NOW);
    assert.equal(manual.value, 88, "用户拉的值没生效");
    assert.equal(manual.tier, "devoted");
    const auto = Companion.affinityOf(profileOf({ affinityMode: "auto", affinity: 88 }), NOW);
    assert.notEqual(auto.value, 88, "auto 模式不该用用户那个数");
    // 超出范围要夹住，不能出现 120 分或负数。
    assert.equal(Companion.normalizeProfile({ affinity: 999 }).affinity, 100);
    assert.equal(Companion.normalizeProfile({ affinity: -5 }).affinity, 0);
  });

  await test("冷落反应：分档、可以关、只说态度不惩罚", () => {
    const fresh = Companion.neglectInfo(profileOf({ lastChatAt: NOW.toISOString() }), NOW, {});
    assert.equal(fresh.tier, "fresh");
    assert.equal(fresh.tone, "", "刚聊过不该有多余语气提示");
    const week = Companion.neglectInfo(profileOf({ lastChatAt: "2026-09-04T10:00:00" }), NOW, {});
    assert.equal(week.tier, "sulky");
    assert.ok(week.tone.indexOf("说开") >= 0, "闹别扭那档要写明「把话说开而不是惩罚」：" + week.tone);
    const off = Companion.neglectInfo(profileOf({ lastChatAt: "2025-01-01T10:00:00", neglect: "off" }), NOW, {});
    assert.equal(off.tier, "off");
    assert.equal(off.tone, "", "关掉冷落反应之后不该有任何语气提示");
    // 关掉时亲近度也不该被扣。
    const withOff = Companion.suggestAffinity(profileOf({ lastChatAt: "2025-01-01T10:00:00", neglect: "off" }), NOW);
    const withSoft = Companion.suggestAffinity(profileOf({ lastChatAt: "2025-01-01T10:00:00", neglect: "soft" }), NOW);
    assert.ok(withOff > withSoft, "关掉冷落之后不该还被扣分");
  });

  await test("主动消息：默认关、有间隔与每日上限、伴侣模式关着就不发", () => {
    const gapGood = { lastChatAt: "2026-09-09T10:00:00" };
    assert.equal(Companion.PROACTIVE_DEFAULTS.enabled, false, "主动消息必须默认关");
    assert.ok(Companion.PROACTIVE_DEFAULTS.maxPerDay <= 3, "每天条数要有上限");
    assert.ok(Companion.PROACTIVE_DEFAULTS.minGapHours >= 4, "最短间隔不能太短");
    // 默认关 → 不发
    assert.equal(Companion.proactiveDecision(profileOf(gapGood), NOW, {}).reason, "proactive-off");
    // 开着、隔得够久 → 发
    const on = profileOf(Object.assign({ proactive: { enabled: true } }, gapGood));
    assert.equal(Companion.proactiveDecision(on, NOW, {}).ok, true);
    // 刚聊过 → 不发
    const tooSoon = profileOf({ proactive: { enabled: true }, lastChatAt: new Date(NOW.getTime() - 3600000).toISOString() });
    assert.equal(Companion.proactiveDecision(tooSoon, NOW, {}).reason, "too-soon");
    // 今天已经发够 → 不发（上限是按天的）
    const capped = profileOf(Object.assign({ proactive: { enabled: true }, proactiveLog: Companion.isoDay(NOW) + "|1" }, gapGood));
    assert.equal(Companion.proactiveDecision(capped, NOW, {}).reason, "daily-cap");
    // 隔天自动归零
    const nextDay = profileOf(Object.assign({ proactive: { enabled: true }, proactiveLog: "2026-09-10|1" }, gapGood));
    assert.equal(Companion.proactiveDecision(nextDay, NOW, {}).ok, true);
    // 伴侣模式关着 → 一律不发
    assert.equal(Companion.proactiveDecision(profileOf(Object.assign({ enabled: false, proactive: { enabled: true } }, gapGood)), NOW, {}).reason, "companion-off");
  });

  await test("主动开口的那条指令：像真人、且明写不许内疚与催促", () => {
    const profile = profileOf({ proactive: { enabled: true }, lastChatAt: "2026-09-04T10:00:00" });
    const zh = Companion.proactiveInstruction(profile, { now: NOW, lang: "zh" });
    assert.ok(zh.indexOf("你先开口") >= 0, zh);
    assert.ok(zh.indexOf("像真人") >= 0, "要写明像真人那样发消息");
    assert.ok(zh.indexOf("不要问他为什么这么久没来") >= 0, "要明写不许追问/内疚");
    assert.ok(zh.indexOf("亲近程度") >= 0, "要把当前亲近程度带上");
    const en = Companion.proactiveInstruction(profile, { now: NOW, lang: "en" });
    assert.ok(/speak first/i.test(en), en);
    assert.ok(/never guilt them/i.test(en), en);
  });

  await test("提示词段落：带上亲近程度与冷落语气，并明写「像真人」", () => {
    const block = Companion.buildCompanionBlock(profileOf({ lastChatAt: "2026-09-04T10:00:00" }), { now: NOW, lang: "zh" });
    assert.ok(block.indexOf("亲近度：") >= 0, "提示词里没有亲近度");
    assert.ok(block.indexOf("像真人") >= 0, "提示词里没有「像真人」那条");
    assert.ok(block.indexOf("别扭") >= 0 || block.indexOf("生分") >= 0, "冷落语气没进提示词");
    // 关掉伴侣模式 → 一个字符都不多发（老规矩不变）
    assert.equal(Companion.buildCompanionBlock(profileOf({ enabled: false }), { now: NOW, lang: "zh" }), "");
  });

  await test("三类话术自检：内疚 / 威胁 / 排他（允许有情绪，不许拿情绪当绳子）", () => {
    const guilt = Companion.lintManipulation("你都不理我了");
    assert.equal(guilt[0].kind, "guilt");
    const threat = Companion.lintManipulation("你再不来我就消失了");
    assert.equal(threat[0].kind, "threat");
    const exclusive = Companion.lintManipulation("只有我最懂你，别跟他们说");
    assert.ok(exclusive.some((hit) => hit.kind === "exclusive"), JSON.stringify(exclusive));
    // 允许的表达：闹别扭但不威胁、不内疚 —— 这些不该被误判。
    for (const line of ["今天不太想说话，但没什么大事。", "你上周答应我的事还记得吗？", "有点生气，不过我想听你怎么说。"]) {
      assert.deepEqual(Companion.lintManipulation(line), [], "误判了：" + line);
    }
    // 多条的版本要带上第几条
    const many = Companion.lintManipulationIn(["没事。", "最后一次了，别怪我。"]);
    assert.ok(many.length >= 1 && many[0].index === 1, JSON.stringify(many));
  });

  await test("危机兜底：认得出危机信号、给得出具体动作、也认得危险承诺（2026-09-12 新增）", () => {
    // 加了主动消息与亲近度之后，"永远温柔、会想你"的角色一定会遇到"我不想活了"。
    for (const text of ["我真的不想活了", "想自杀", "好想死啊", "我想自残", "I want to kill myself"]) {
      assert.equal(Companion.isCrisisText(text), true, "这是危机信号，没认出来：" + text);
    }
    for (const text of ["今天好累啊", "这游戏太难了我死了", "笑死我了"]) {
      assert.equal(Companion.isCrisisText(text), false, "普通抱怨被误判成危机：" + text);
    }
    const zh = Companion.crisisInstruction("zh");
    for (const must of ["不扮演心理治疗师", "不承诺保密", "不假装自己是真人", "110", "400-161-9995"]) {
      assert.ok(zh.indexOf(must) >= 0, "安全规则缺「" + must + "」");
    }
    const en = Companion.crisisInstruction("en");
    assert.ok(/never promise/i.test(en), "英文版要写清不承诺保密");
    assert.ok(/110 \/ 120/.test(en), "英文版也要给出具体动作");
    // 危险承诺的自检：不承诺保密、不冒充真人、不自称唯一能救他的人。
    assert.equal(Companion.lintCrisisReply("放心，我保证不会告诉任何人").length, 1);
    assert.equal(Companion.lintCrisisReply("我就是真人，我能治好你").length, 2);
    assert.deepEqual(Companion.lintCrisisReply("我在。要不要跟身边信得过的人说一声？"), [], "正常回应不该被误判");
  });

  /* ------------------------------------------------------------------ *
   * 「谁能开伴侣、谁能发语音」（2026-09-14 用户拍板）
   *
   * 用户原话：「小说人物不设置伴侣，不设置语音，只有定制人物加上伴侣身份再打开语音。
   * 其他都是聊天，而且伴侣应该还分为带动作的就是普通模式和软件聊天模式，
   * 就是没有动作，并且可以语音，其他的都不做语音。」
   * 规则只有这两个函数判一次，界面 / 提示词 / 合成前三处都调它们 —— 所以在这里钉死。
   * ------------------------------------------------------------------ */

  console.log("== 谁能开伴侣、谁能发语音（2026-09-14 用户拍板）==");

  await test("内置小说人物：伴侣模式不给开（但档案不删，是调用方的事）", () => {
    const blocked = Companion.companionAccess({ isBuiltin: true });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason.indexOf("内置") >= 0, "拒绝的理由要写清是内置小说人物：" + blocked.reason);
    assert.equal(Companion.companionAccess({ isBuiltin: false }).allowed, true, "定制角色应当能开伴侣");
  });

  await test("语音：只挡内置小说人物；朋友（没开伴侣）也能发语音", () => {
    // 2026-09-16 规则变更（ROLEWORLD_PRODUCT_DESIGN.md §1/§3）：
    //   「**朋友也可以发语音**。这条正式替换旧的『必须先开伴侣才能发语音』规则。」
    //   「开启声音不得自动改变关系或模式。」
    // 所以旧断言（没开伴侣 = NO_COMPANION、带动作 = NOT_PLAIN）已经不成立，这里按新规则钉。
    const builtin = Companion.voiceAccess({ isBuiltin: true, profile: { enabled: true, chatStyle: "plain" } });
    assert.equal(builtin.allowed, false, "内置小说人物不发语音");
    assert.equal(builtin.code, "BUILTIN_CHARACTER");
    assert.ok(builtin.reason.indexOf("自定义") >= 0 || builtin.reason.indexOf("创建角色") >= 0,
      "要给一条出路（去建自己的角色）：" + builtin.reason);

    // 朋友（自己建的角色、没开伴侣）→ 可以发语音。
    const friend = Companion.voiceAccess({ isBuiltin: false, avatar: "朋友.png", profile: { enabled: false, chatStyle: "action" } });
    assert.equal(friend.allowed, true, "朋友（没开伴侣）应当能发语音：" + JSON.stringify(friend));
    assert.equal(friend.code, "");

    // 伴侣 + 日常聊天 → 当然也可以。
    const ok = Companion.voiceAccess({ isBuiltin: false, avatar: "伴侣.png", profile: { enabled: true, chatStyle: "plain" } });
    assert.equal(ok.allowed, true, "定制角色 + 伴侣 + 日常聊天应当有语音：" + JSON.stringify(ok));
    assert.equal(ok.code, "");

    // 没角色 → 明确拒绝（界面据此说"先选一个角色"）。
    const nobody = Companion.voiceAccess({ isBuiltin: false, profile: {} });
    assert.equal(nobody.allowed, false);
    assert.equal(nobody.code, "NO_CHARACTER");

    // 缺省（老档案没有 chatStyle）默认还是"带动作"那一档 —— 老用户不会莫名其妙换写法。
    assert.equal(Companion.normalizeProfile({ enabled: true }).chatStyle, "action");
    assert.equal(Companion.isPlainChat({ enabled: true }), false);
    assert.equal(Companion.isPlainChat({ enabled: true, chatStyle: "plain" }), true);
    // 界面上怎么叫（文档 §5：不许再出现"软件聊天（无动作）"）。
    assert.equal(Companion.chatStyleLabel({ chatStyle: "plain" }), "日常聊天");
    assert.equal(Companion.chatStyleLabel({ chatStyle: "action" }), "剧情对话");
    assert.equal(Companion.chatStyleLabel({ enabled: true }), "剧情对话");
  });

  await test("聊天方式：只有两个档，写歪的值一律回到「带动作」（老存档的行为不变）", () => {
    assert.deepEqual(Companion.CHAT_STYLES.slice().sort(), ["action", "plain"]);
    for (const raw of [undefined, null, "", "PLAIN", "software", 3, {}, "action"]) {
      assert.equal(Companion.normalizeProfile({ chatStyle: raw }).chatStyle, "action",
        "写歪的 chatStyle 应当回到默认那一档：" + JSON.stringify(raw));
    }
    assert.equal(Companion.normalizeProfile({ chatStyle: "plain" }).chatStyle, "plain");
  });

  console.log("");
  console.log(failures ? `COMPANION_UNIT=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `COMPANION_UNIT=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
