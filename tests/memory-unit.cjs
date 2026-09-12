"use strict";

/*
 * memory-unit.cjs —— 角色记忆的单元测试（不需要浏览器）
 *
 * 覆盖：来源记录、去重、上限挤出并报告、改、删、忠实读取。
 * 全部合成数据，不联网、不碰真实模型与真实数据。
 */

const path = require("node:path");
const assert = require("node:assert/strict");

const Memory = require(path.join(__dirname, "..", "app", "memory-core.js"));

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

async function main() {
  console.log("== 写入与来源 ==");

  await test("写入时记下来源：哪段对话的第几条消息、什么时候、谁写的", () => {
    const at = "2026-09-11T10:00:00.000Z";
    const result = Memory.applyMemories({}, ["玩家叫小林"], {
      source: { file: "harry-20260911.jsonl", messageIndex: 7, at },
    });
    assert.equal(result.added, 1);
    const rows = Memory.listEntries(result.entries);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "玩家叫小林");
    assert.equal(rows[0].source.file, "harry-20260911.jsonl");
    assert.equal(rows[0].source.messageIndex, 7);
    assert.equal(rows[0].source.at, at);
    assert.equal(rows[0].source.origin, "model");
  });

  await test("手动加的记忆标明是用户自己写的，不编造来源对话", () => {
    const result = Memory.applyMemories({}, ["玩家不喜欢咖啡"], {
      origin: Memory.ORIGIN.USER,
      source: { origin: Memory.ORIGIN.USER, file: "", messageIndex: null },
    });
    const row = Memory.listEntries(result.entries)[0];
    assert.equal(row.source.origin, "user");
    assert.equal(row.source.file, "");
    assert.equal(row.source.messageIndex, null);
  });

  await test("同样内容不重复记", () => {
    const first = Memory.applyMemories({}, ["玩家怕黑"], { source: { file: "a.jsonl", messageIndex: 1 } });
    const second = Memory.applyMemories(first.entries, ["玩家怕黑"], { source: { file: "a.jsonl", messageIndex: 5 } });
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    assert.equal(Object.keys(second.entries).length, 1);
  });

  await test("一次记多条时，空内容被跳过而不是存成空记忆", () => {
    const result = Memory.applyMemories({}, ["有效的一条", "", "   ", null], {});
    assert.equal(result.added, 1);
    assert.equal(Memory.listEntries(result.entries).length, 1);
  });

  console.log("== 上限与挤出 ==");

  await test("超过上限时挤掉最旧的，并明确报告挤掉了哪几条", () => {
    let entries = {};
    for (let i = 0; i < 6; i += 1) {
      entries = Memory.applyMemories(entries, ["记忆" + i], { max: 100, source: { file: "c.jsonl", messageIndex: i } }).entries;
    }
    const result = Memory.applyMemories(entries, ["记忆6", "记忆7"], { max: 5, source: { file: "c.jsonl", messageIndex: 9 } });
    assert.equal(Object.keys(result.entries).length, 5, "应被压到上限 5");
    assert.equal(result.removed.length, 3, "应报告挤掉 3 条，实际 " + result.removed.length);
    assert.equal(result.removed[0].content, "记忆0", "挤掉的应该是最旧的");
    const kept = Memory.listEntries(result.entries).map((row) => row.content);
    assert.ok(kept.indexOf("记忆7") >= 0, "新记的必须还在");
    assert.ok(kept.indexOf("记忆0") < 0, "最旧的应该不在了");
  });

  await test("没到上限就不动任何条目", () => {
    const entries = Memory.applyMemories({}, ["a", "b"], { max: 50 }).entries;
    const result = Memory.applyMemories(entries, ["c"], { max: 50 });
    assert.equal(result.removed.length, 0);
    assert.equal(Object.keys(result.entries).length, 3);
  });

  console.log("== 改与删 ==");

  await test("改一条：内容变了，来源保留，并标注是你改的", () => {
    const created = Memory.applyMemories({}, ["玩家喜欢咖啡"], {
      source: { file: "a.jsonl", messageIndex: 3, at: "2026-09-10T00:00:00.000Z" },
    });
    const key = Object.keys(created.entries)[0];
    const result = Memory.updateEntry(created.entries, key, "玩家现在不喜欢咖啡了", { at: "2026-09-11T00:00:00.000Z" });
    assert.equal(result.ok, true);
    const row = Memory.listEntries(result.entries)[0];
    assert.equal(row.content, "玩家现在不喜欢咖啡了");
    assert.equal(row.source.file, "a.jsonl", "来源对话不该被抹掉");
    assert.equal(row.source.edited, true, "应标注被改过");
    assert.equal(row.source.origin, "user");
    assert.equal(row.source.at, "2026-09-11T00:00:00.000Z");
  });

  await test("改成空内容会被拒绝，原记忆不受影响", () => {
    const created = Memory.applyMemories({}, ["有效记忆"], {});
    const key = Object.keys(created.entries)[0];
    const result = Memory.updateEntry(created.entries, key, "   ");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty");
    assert.equal(result.entries[key].content, "有效记忆");
  });

  await test("改一条不存在的记忆会明确失败，不会凭空造一条", () => {
    const created = Memory.applyMemories({}, ["有效记忆"], {});
    const result = Memory.updateEntry(created.entries, "999", "新的");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
    assert.equal(Object.keys(result.entries).length, 1);
  });

  await test("删一条：真的从条目里消失", () => {
    const created = Memory.applyMemories({}, ["要删的", "要留的"], {});
    const keys = Object.keys(created.entries);
    const result = Memory.removeEntry(created.entries, keys[0]);
    assert.equal(result.ok, true);
    const kept = Memory.listEntries(result.entries).map((row) => row.content);
    assert.deepEqual(kept, ["要留的"]);
  });

  await test("删不存在的条目明确失败", () => {
    const result = Memory.removeEntry({}, "nope");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
  });

  console.log("== 改口：同一主题要替换，不能两条并存 ==");

  await test("模型写了主题时：改口替换旧记忆，条数不变", () => {
    const first = Memory.applyMemories({}, [{ topic: "喜欢的饮料", content: "玩家喜欢咖啡" }], {
      source: { file: "a.jsonl", messageIndex: 2, at: "2026-09-10T00:00:00.000Z" },
    });
    assert.equal(Object.keys(first.entries).length, 1);
    const second = Memory.applyMemories(first.entries, [{ topic: "饮料", content: "玩家现在不喜欢咖啡了" }], {
      source: { file: "a.jsonl", messageIndex: 8, at: "2026-09-11T00:00:00.000Z" },
    });
    assert.equal(Object.keys(second.entries).length, 1, "改口后不该变成两条");
    const row = Memory.listEntries(second.entries)[0];
    assert.equal(row.content, "玩家现在不喜欢咖啡了", "留下的应该是新说法");
    assert.equal(second.replaced.length, 1, "应报告替换掉了哪一条");
    assert.equal(second.replaced[0].content, "玩家喜欢咖啡");
    assert.equal(row.replacedContent, "玩家喜欢咖啡", "条目里应记下它替换了什么");
  });

  await test("两件不同的事不会被互相覆盖", () => {
    const first = Memory.applyMemories({}, [{ topic: "饮料", content: "玩家喜欢咖啡" }], {});
    const second = Memory.applyMemories(first.entries, [{ topic: "怕的东西", content: "玩家怕黑" }], {});
    assert.equal(Object.keys(second.entries).length, 2, "不同主题应当各留一条");
    assert.equal(second.replaced.length, 0);
  });

  await test("模型没写主题时，按正文推主题，改口仍然能覆盖", () => {
    const first = Memory.applyMemories({}, ["玩家喜欢咖啡"], { source: { file: "a.jsonl", messageIndex: 1 } });
    const row = Memory.listEntries(first.entries)[0];
    assert.ok(row.topic, "应当能推出来一个主题，实际为空");
    // 同一个主题再写一次
    const second = Memory.applyMemories(first.entries, [{ topic: row.topic, content: "玩家不喜欢咖啡了" }], {});
    assert.equal(Object.keys(second.entries).length, 1, "同一主题应当覆盖");
    assert.equal(Memory.listEntries(second.entries)[0].content, "玩家不喜欢咖啡了");
  });

  await test("旧条目没有主题时，用正文推出来的主题也能被新记忆覆盖", () => {
    // 旧条目（早期版本记下的，没有主题元数据）："玩家叫小林"
    const first = Memory.applyMemories({}, ["玩家叫小林"], {});
    const row = Memory.listEntries(first.entries)[0];
    assert.ok(row.topic, "应当能从正文推出来一个主题，实际为空：" + JSON.stringify(row.topic));
    // 模型这次用同义词主题改口（读者/写者用词不同，也要认出来）
    const second = Memory.applyMemories(first.entries, [{ topic: "名字", content: "玩家改名叫小琳" }], {});
    assert.equal(Object.keys(second.entries).length, 1,
      "推出来的主题与同义词主题命中时应当替换，实际 " + Object.keys(second.entries).length + " 条");
    assert.equal(Memory.listEntries(second.entries)[0].content, "玩家改名叫小琳");
  });

  await test("同义词主题视为同一件事（称呼 / 名字）", () => {
    const first = Memory.applyMemories({}, [{ topic: "名字", content: "玩家叫小林" }], {});
    const second = Memory.applyMemories(first.entries, [{ topic: "称呼", content: "大家都叫他小林" }], {});
    assert.equal(Object.keys(second.entries).length, 1, "「称呼」与「名字」应当算同一件事");
  });

  await test("内容一模一样时不重复记，也不误报替换", () => {
    const first = Memory.applyMemories({}, [{ topic: "饮料", content: "玩家喜欢咖啡" }], {});
    const second = Memory.applyMemories(first.entries, [{ topic: "饮料", content: "玩家喜欢咖啡" }], {});
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.replaced.length, 0);
  });

  await test("推不出主题时宁可新增，不乱覆盖（不同的事必须各留一条）", () => {
    const first = Memory.applyMemories({}, [{ topic: "饮料", content: "玩家喜欢咖啡" }], {});
    // 主题为空的条目无法与已有主题对上，应当新增而不是覆盖
    const second = Memory.applyMemories(first.entries, [{ topic: " ", content: "明天下午三点见" }], {});
    assert.equal(Object.keys(second.entries).length, 2);
    assert.equal(second.replaced.length, 0);
  });

  console.log("== 真实信息 vs 虚构剧情 ==");

  const FACTS = [
    "玩家叫小林",
    "玩家喜欢咖啡",
    "玩家现在不喜欢咖啡了",
    "玩家怕黑",
    "玩家约好周六见面",
    "玩家养了一只猫叫团子",
    "玩家对花生过敏",
    "玩家是个程序员",
    "玩家有个妹妹",
    "玩家不喜欢吵闹的地方",
  ];
  const STORIES = [
    "*你拔出魔杖，指向天空*",
    "（他挥剑砍向巨龙）",
    "玩家和哈利一起打败了巨龙",
    "【旁白】城堡在夜色中沉默",
    "哈利把玩家推进了密室",
    "玩家学会了火球术",
    "第三章：密室之门",
    "巨龙被击败了",
    "你挥动魔杖念出咒语",
  ];

  await test("玩家本人的事实与偏好：收", () => {
    for (const text of FACTS) {
      const verdict = Memory.classifyMemory(text);
      assert.equal(verdict.keep, true, "应被收下却被拒：" + text + "（" + verdict.reason + "）");
    }
  });

  await test("剧情片段：不收（动作、旁白、战斗、章节、魔法技能）", () => {
    for (const text of STORIES) {
      const verdict = Memory.classifyMemory(text);
      assert.equal(verdict.keep, false, "剧情不该进记忆，却被收下：" + text);
      assert.ok(verdict.reason === "story" || verdict.reason === "no-fact", "拒收理由不清楚：" + verdict.reason);
    }
  });

  await test("写入时真的被拦下，并且报告出来（不是静默丢弃）", () => {
    const result = Memory.applyMemories({}, ["玩家喜欢咖啡", "*你拔出魔杖*", "巨龙被击败了"], {});
    assert.equal(result.added, 1, "只有那条真事实该被收下");
    assert.equal(result.rejected.length, 2, "两条剧情应当被拒收");
    assert.deepEqual(Memory.listEntries(result.entries).map((row) => row.content), ["玩家喜欢咖啡"]);
    const reasons = result.rejected.map((row) => row.reason);
    assert.ok(reasons.indexOf("story") >= 0, "应说明是剧情：" + JSON.stringify(reasons));
  });

  await test("剧情不会覆盖已有的真事实", () => {
    const first = Memory.applyMemories({}, [{ topic: "称呼", content: "玩家叫小林" }], {});
    const second = Memory.applyMemories(first.entries, ["哈利把玩家推进了密室", "玩家叫小林"], {});
    assert.deepEqual(Memory.listEntries(second.entries).map((row) => row.content), ["玩家叫小林"]);
    assert.equal(second.rejected.length, 1);
  });

  console.log("== 主题归类与分组（面板按组折叠的数据来源） ==");

  await test("吃喝、称呼、住处、宠物、怕的东西各自归一类", () => {
    const cases = [
      ["玩家喜欢咖啡", "饮料"],
      ["玩家喝乌龙茶", "饮料"],
      ["玩家爱喝奶茶", "饮料"],
      ["玩家爱吃辣", "食物"],
      ["玩家对花生过敏", "食物"],
      ["玩家叫小林", "称呼"],
      ["玩家改名叫小琳", "称呼"],
      ["玩家住在杭州", "住处"],
      ["玩家养了一只猫叫团子", "宠物"],
      ["玩家有只狗", "宠物"],
      ["玩家怕黑", "怕的东西"],
      ["玩家怕打雷", "怕的东西"],
    ];
    for (const [text, expected] of cases) {
      assert.equal(Memory.inferTopic(text), expected, "归类不对：" + text + " → " + Memory.inferTopic(text));
    }
  });

  await test("“养了一只猫叫团子”里的“叫”不算称呼", () => {
    // 这条踩过：`叫` 当称呼锚点时，宠物会被误判成称呼。
    assert.equal(Memory.inferTopic("玩家养了一只猫叫团子"), "宠物");
    assert.equal(Memory.inferTopic("玩家叫小林"), "称呼");
  });

  await test("按主题分组：条数多的在前，未分类排最后", () => {
    let entries = {};
    // 饮料组两条：用两个**不同**主题词但同属饮品的内容，
    // 刻意不用"同主题替换"（那条路径另有测试），这里只要能凑出两组。
    entries = Memory.applyMemories(entries, [{ topic: "饮料", content: "玩家喜欢咖啡" }], {}).entries;
    entries = Memory.applyMemories(entries, [{ topic: "饮料", content: "玩家平时爱喝乌龙茶" }], {}).entries;
    entries = Memory.applyMemories(entries, [{ topic: "称呼", content: "玩家叫小林" }], {}).entries;
    // 再放一条推不出词组的，凑出「未分类」这一组。
    entries = Memory.applyMemories(entries, [{ topic: " ", content: "明天下午三点见" }], {}).entries;
    const groups = Memory.groupByTopic(entries);
    const labels = groups.map((g) => g.label);
    const counts = groups.map((g) => g.rows.length);
    // 条数最多的组排第一；条数相同时按标签排，所以断言"最大组在前 + 未分类在最后"。
    assert.equal(Math.max.apply(null, counts), counts[0],
      "条数最多的组应排第一：" + JSON.stringify(labels) + " " + JSON.stringify(counts));
    assert.equal(labels[labels.length - 1], "未分类", "未分类应排最后：" + JSON.stringify(labels));
  });

  await test("『明天下午三点见』这类句子不当主题，归入未分类", () => {
    // 主题是词组不是句子：硬把整句当主题会让分组碎成一片。
    assert.equal(Memory.inferTopicOrEmpty("明天下午三点见"), "");
    const entries = Memory.applyMemories({}, [{ topic: " ", content: "明天下午三点见" }], {}).entries;
    const groups = Memory.groupByTopic(entries);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, "未分类", "应当归入未分类：" + groups[0].label);
    assert.equal(groups[0].topic, "", "未分类组的 topic 应为空");
  });

  await test("分组不会丢条目、不会重复", () => {
    let entries = {};
    for (const [topic, text] of [["饮料", "玩家喜欢咖啡"], ["称呼", "玩家叫小林"],
      ["怕的东西", "玩家怕黑"], ["宠物", "玩家养了一只猫叫团子"]]) {
      entries = Memory.applyMemories(entries, [{ topic: topic, content: text }], {}).entries;
    }
    const groups = Memory.groupByTopic(entries);
    const total = groups.reduce((sum, g) => sum + g.rows.length, 0);
    assert.equal(total, Object.keys(entries).length, "分组后条目数对不上：" + total);
    const keys = groups.flatMap((g) => g.rows.map((r) => r.key));
    assert.equal(new Set(keys).size, keys.length, "有条目被分到了多个组");
  });

  await test("空记忆与脏数据分组不炸", () => {
    assert.deepEqual(Memory.groupByTopic({}), []);
    assert.deepEqual(Memory.groupByTopic(null), []);
    const groups = Memory.groupByTopic({ 0: { content: "" }, 1: null, 2: { content: "玩家怕黑" } });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].rows.length, 1);
  });

  console.log("== 忠实读取 ==");

  await test("读取时按 uid 排序，顺序稳定", () => {
    let entries = {};
    for (const text of ["第三条", "第一条", "第二条"]) {
      entries = Memory.applyMemories(entries, [text], {}).entries;
    }
    const rows = Memory.listEntries(entries).map((row) => row.content);
    assert.deepEqual(rows, ["第三条", "第一条", "第二条"]);
  });

  await test("脏数据不炸：非对象、缺 content、uid 不是数字", () => {
    assert.deepEqual(Memory.listEntries(null), []);
    assert.deepEqual(Memory.listEntries("nope"), []);
    const rows = Memory.listEntries({
      0: { content: "有内容", uid: "七" },
      1: { content: "", uid: 2 },
      2: null,
      3: { content: "另一条" },
    });
    assert.equal(rows.length, 2, "只应读出行内 content 的条目，实际 " + rows.length);
    assert.equal(rows[0].uid, null, "uid 不是数字时应为 null，而不是编造");
  });

  await test("世界书里原有的额外字段不会被这个模块抹掉", () => {
    const existing = { 0: { uid: 0, content: "旧记忆", key: ["小林"], probability: 100 } };
    const result = Memory.applyMemories(existing, ["新记忆"], {});
    assert.deepEqual(result.entries["0"].key, ["小林"], "原有字段应原样保留");
    assert.equal(result.entries["0"].probability, 100);
  });

  await test("条目标题：正常的 comment 直接当标题，[STMB] 前缀剥掉", () => {
    assert.equal(Memory.entryTitle({ comment: "[STMB] Lin's fear of heights and flying" }), "Lin's fear of heights and flying");
    assert.equal(Memory.entryTitle({ comment: "玩家喜欢的饮料" }), "玩家喜欢的饮料");
  });

  await test("条目标题：迁移工具留下的说明不当标题（内置包里真有一条这样的）", () => {
    // 2026-09-12：用户在记忆面板里看到一句英文
    // "Human confirmation edit: correction narrative removed so no superseded value
    //  appears in prompt context." —— 那是 STMB 转换器写进 comment 的说明，不是标题。
    const note = "[STMB] Human confirmation edit: correction narrative removed so no superseded value appears in prompt context.";
    const title = Memory.entryTitle({
      comment: note,
      content: "Lin's home city is Shanghai, China. She grew up there before coming to Hogwarts.",
      key: ["Shanghai", "Lin"],
    });
    assert.ok(title.indexOf("Human confirmation") < 0, "转换器说明不该当标题：" + title);
    assert.ok(title.indexOf("Lin's home city") === 0, "应当退回正文开头：" + title);
  });

  await test("条目标题：没有 comment 就用正文开头（和自动记忆自己写 comment 的口径一致）", () => {
    const title = Memory.entryTitle({ content: "玩家养了一只猫叫团子，是三花，怕生" });
    assert.equal(title, "玩家养了一只猫叫团子，是三花，怕生".slice(0, 24));
  });

  await test("条目标题：什么都没有时退回关键词，再退回条目号，不编造", () => {
    assert.equal(Memory.entryTitle({ content: "", key: ["团子", "猫"] }), "团子、猫");
    assert.equal(Memory.entryTitle({ uid: 7 }), "条目 #7");
    assert.equal(Memory.entryTitle(null), "记忆条目");
  });

  console.log("");
  console.log("== 记忆取向与「说得对」（P5-3）==");

  const STORY_LINE = "他拔出魔杖，把玩家推进了密室";

  await test("默认（平衡）：剧情一律不收 —— 这条底线不变", () => {
    const result = Memory.applyMemories({}, [STORY_LINE], {});
    assert.equal(result.added, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, "story");
    assert.equal(Memory.normalizeOrientation("不认识的值"), Memory.ORIENTATIONS.BALANCED);
  });

  await test("剧情取向：剧情可以记，但标成 story（不冒充用户事实）", () => {
    const result = Memory.applyMemories({}, [STORY_LINE], { orientation: "story" });
    assert.equal(result.added, 1, "剧情取向下应当收下：" + JSON.stringify(result.rejected));
    const row = Memory.listEntries(result.entries)[0];
    assert.equal(row.kind, "story", "必须标明是剧情");
    assert.equal(row.content, STORY_LINE);
    // 事实类在剧情取向下也仍然是事实
    const both = Memory.applyMemories(result.entries, ["玩家喜欢乌龙茶"], { orientation: "story" });
    const kinds = Memory.listEntries(both.entries).map((r) => r.kind).sort();
    assert.deepEqual(kinds, ["fact", "story"]);
  });

  await test("「说得对」：标记后不会被上限挤掉", () => {
    let entries = {};
    // 先塞三条事实，把中间那条标成"确认过"
    entries = Memory.applyMemories(entries, ["玩家叫小林"], {}).entries;
    entries = Memory.applyMemories(entries, ["玩家住在杭州"], {}).entries;
    entries = Memory.applyMemories(entries, ["玩家养了只猫"], {}).entries;
    const rows = Memory.listEntries(entries);
    const target = rows[1];
    const marked = Memory.confirmEntry(entries, target.key, true);
    assert.equal(marked.ok, true);
    assert.equal(Memory.listEntries(marked.entries)[1].confirmed, true);

    // 上限压到 2 条：最旧的（未确认）先走，确认过的那条留下
    const trimmed = Memory.trim(marked.entries, 2);
    assert.equal(Object.keys(trimmed.entries).length, 2);
    const left = Memory.listEntries(trimmed.entries).map((r) => r.content);
    assert.ok(left.indexOf("玩家住在杭州") >= 0, "确认过的条目不该被挤掉：" + JSON.stringify(left));
    assert.equal(trimmed.removed.length, 1);
    assert.equal(trimmed.removed[0].content, "玩家叫小林", "先走的应当是最旧的未确认条目");

    const unmarked = Memory.confirmEntry(marked.entries, target.key, false);
    assert.equal(Memory.listEntries(unmarked.entries)[1].confirmed, false, "应当能取消标记");
  });

  await test("挤占顺序（陪伴取向）：先剧情、再碎事件、最后才是「关于你这个人」", () => {
    let entries = {};
    entries = Memory.applyMemories(entries, ["玩家住在杭州"], {}).entries;                    // 住处：关于你
    entries = Memory.applyMemories(entries, ["考拉"], {}).entries;                            // 具体东西：碎事件
    entries = Memory.applyMemories(entries, [STORY_LINE], { orientation: "story" }).entries;  // 剧情
    assert.equal(Object.keys(entries).length, 3);
    const trimmed = Memory.trim(entries, 1, { orientation: "companion" });
    const left = Memory.listEntries(trimmed.entries);
    assert.equal(left.length, 1);
    assert.equal(left[0].content, "玩家住在杭州", "陪伴取向下该保住关于你的事实：" + JSON.stringify(left));
    const removedOrder = trimmed.removed.map((row) => row.content);
    assert.equal(removedOrder[0], STORY_LINE, "剧情应当第一个被挤：" + JSON.stringify(removedOrder));
    assert.equal(removedOrder[1], "考拉", "碎事件第二个：" + JSON.stringify(removedOrder));
  });

  await test("挤占顺序（平衡取向）：只把剧情提前，其余按新旧", () => {
    let entries = {};
    entries = Memory.applyMemories(entries, ["玩家住在杭州"], {}).entries;
    entries = Memory.applyMemories(entries, ["考拉"], {}).entries;
    entries = Memory.applyMemories(entries, [STORY_LINE], { orientation: "story" }).entries;
    const trimmed = Memory.trim(entries, 1, { orientation: "balanced" });
    const left = Memory.listEntries(trimmed.entries).map((row) => row.content);
    // 平衡取向不区分主题质量：剧情先走，剩下两条按新旧 —— 最早的杭州先走。
    assert.deepEqual(left, ["考拉"], "平衡取向应当按新旧：" + JSON.stringify(left));
  });

  await test("改口替换之后，「说得对」的标记跟着新内容走", () => {
    let entries = Memory.applyMemories({}, ["玩家喜欢咖啡"], {}).entries;
    const key = Object.keys(entries)[0];
    entries = Memory.confirmEntry(entries, key, true).entries;
    const next = Memory.applyMemories(entries, [{ topic: "饮料", content: "玩家现在不喜欢咖啡了" }], {});
    assert.equal(next.replaced.length, 1, "同主题应当替换");
    const row = Memory.listEntries(next.entries)[0];
    assert.equal(row.content, "玩家现在不喜欢咖啡了");
    assert.equal(row.confirmed, true, "确认过的态度不该因为改口就丢掉");
  });

  await test("取向只影响新写入，不动已有条目", () => {
    const story = Memory.applyMemories({}, [STORY_LINE], { orientation: "story" }).entries;
    // 切回平衡再写一条：老的剧情条目还在（不悄悄删用户的东西）
    const next = Memory.applyMemories(story, ["玩家喜欢甜食"], { orientation: "balanced" });
    const contents = Memory.listEntries(next.entries).map((r) => r.content);
    assert.ok(contents.indexOf(STORY_LINE) >= 0, "已有条目不该被取向改动");
    assert.ok(contents.indexOf("玩家喜欢甜食") >= 0);
  });

  console.log("");
  console.log(failures ? `MEMORY_UNIT=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `MEMORY_UNIT=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
