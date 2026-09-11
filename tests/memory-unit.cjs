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

  console.log("");
  console.log(failures ? `MEMORY_UNIT=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `MEMORY_UNIT=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
