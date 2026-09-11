"use strict";

/*
 * search-unit.cjs —— 历史检索的单元测试（不需要浏览器）
 *
 * 覆盖：关键词抽取、打分与排序、翻不到时的诚实说明、结果条数上限、出处完整。
 * 全部合成数据，不联网、不碰真实模型与真实数据。
 */

const path = require("node:path");
const assert = require("node:assert/strict");

const Search = require(path.join(__dirname, "..", "app", "search-core.js"));

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

function sessions() {
  return [
    { fileName: "harry-1.jsonl", messages: [
      { is_user: true, mes: "我养了一只猫叫团子", send_date: "2026-08-01T10:00:00.000Z", name: "我" },
      { is_user: false, mes: "团子听起来很可爱！", send_date: "2026-08-01T10:00:05.000Z", name: "Harry" },
      { is_user: true, mes: "今天天气不错", send_date: "2026-08-02T10:00:00.000Z", name: "我" },
    ] },
    { fileName: "harry-2.jsonl", messages: [
      { is_user: true, mes: "我下周三要去杭州出差", send_date: "2026-08-11T10:00:00.000Z", name: "我" },
      { is_user: true, mes: "我平时喜欢喝咖啡，不加糖", send_date: "2026-08-13T10:00:00.000Z", name: "我" },
    ] },
  ];
}

async function main() {
  console.log("== 关键词抽取 ==");

  await test("中文按双字切分，常用词被丢掉", () => {
    const words = Search.keywords("我什么时候去杭州");
    assert.ok(words.indexOf("杭州") >= 0, "应当切出「杭州」：" + JSON.stringify(words));
    assert.ok(words.indexOf("什么") < 0, "常用词「什么」不该留下：" + JSON.stringify(words));
    assert.ok(words.indexOf("我") < 0, "常用字「我」不该留下：" + JSON.stringify(words));
  });

  await test("英文词也能抽出来", () => {
    const words = Search.keywords("还记得 Harry 说过的话吗");
    assert.ok(words.indexOf("harry") >= 0, "应当抽出 harry：" + JSON.stringify(words));
  });

  await test("空提问不产生关键词", () => {
    assert.deepEqual(Search.keywords(""), []);
    assert.deepEqual(Search.keywords(null), []);
  });

  console.log("== 检索与排序 ==");

  await test("翻得到：相关的那句能被找出来，并带出处", () => {
    const result = Search.searchHistory(sessions(), "还记得我说的猫吗", {});
    assert.equal(result.matched, 1, "应当只命中那条与猫有关的：" + JSON.stringify(result.hits.map((h) => h.text)));
    const hit = result.hits[0];
    assert.equal(hit.text, "我养了一只猫叫团子");
    assert.equal(hit.fileName, "harry-1.jsonl");
    assert.equal(hit.index, 0, "应标出是第几条");
    assert.equal(hit.isUser, true);
    assert.ok(hit.at, "应带时间");
  });

  await test("越相关排越前（罕见的词比常见词值钱）", () => {
    const result = Search.searchHistory(sessions(), "杭州出差", {});
    assert.ok(result.matched >= 1);
    assert.equal(result.hits[0].text, "我下周三要去杭州出差", "最相关的那条应当排第一：" + JSON.stringify(result.hits.map((h) => h.text)));
  });

  await test("跨对话翻找：两段对话里的内容都在检索范围内", () => {
    const two = [
      { fileName: "a.jsonl", messages: [{ is_user: true, mes: "我养了一只猫叫团子" }] },
      { fileName: "b.jsonl", messages: [{ is_user: true, mes: "团子昨天打翻了花瓶" }] },
    ];
    const result = Search.searchHistory(two, "团子", {});
    const files = Array.from(new Set(result.hits.map((h) => h.fileName))).sort();
    assert.deepEqual(files, ["a.jsonl", "b.jsonl"], "应当跨对话翻找：" + JSON.stringify(files));
  });

  await test("当前这段对话会被跳过，不重复翻出来", () => {
    const two = [
      { fileName: "a.jsonl", messages: [{ is_user: true, mes: "我养了一只猫叫团子" }] },
      { fileName: "b.jsonl", messages: [{ is_user: true, mes: "团子昨天打翻了花瓶" }] },
    ];
    const result = Search.searchHistory(two, "团子", { skipFileName: "a.jsonl" });
    assert.ok(result.matched >= 1, "另一段对话里的团子仍应翻到");
    assert.ok(result.hits.every((hit) => hit.fileName === "b.jsonl"),
      "被跳过的那段不该出现：" + JSON.stringify(result.hits.map((h) => h.fileName)));
  });

  await test("翻不到就是翻不到（不硬凑结果）", () => {
    const result = Search.searchHistory(sessions(), "我们去过月球吗", {});
    assert.equal(result.matched, 0, "不该硬凑出一条相关：" + JSON.stringify(result.hits.map((h) => h.text)));
  });

  await test("结果条数有上限，不会把提示词撑爆", () => {
    const many = [{ fileName: "c.jsonl", messages: Array.from({ length: 40 }, (_, i) => ({
      is_user: true, mes: "团子第" + i + "次出现", send_date: "2026-08-01T10:00:00.000Z",
    })) }];
    const result = Search.searchHistory(many, "团子", { limit: 5 });
    assert.equal(result.hits.length, 5);
    assert.equal(result.matched, 40, "命中总数要如实报告");
  });

  await test("空历史、脏数据不炸", () => {
    assert.equal(Search.searchHistory([], "团子").matched, 0);
    assert.equal(Search.searchHistory(null, "团子").matched, 0);
    const dirty = [{ fileName: "d.jsonl", messages: [null, {}, { mes: 123 }, { mes: "" }, { mes: "团子在这里" }] }];
    assert.equal(Search.searchHistory(dirty, "团子").matched, 1);
  });

  console.log("== 给模型的说明 ==");

  await test("翻不到时：明说没有记录，并要求不要编造", () => {
    const note = Search.buildHistoryNote(Search.searchHistory(sessions(), "我们去过月球吗", {}));
    assert.ok(note.indexOf("没有找到") >= 0, "应说明没找到：" + note);
    assert.ok(note.indexOf("不要猜测") >= 0 || note.indexOf("不要编造") >= 0, "应禁止编造：" + note);
    assert.ok(note.indexOf("没有更早的记录") >= 0 || note.indexOf("不记得") >= 0, "应允许说不知道：" + note);
  });

  await test("翻到时：带出处、并要求贴着原话", () => {
    const note = Search.buildHistoryNote(Search.searchHistory(sessions(), "我说的猫", {}));
    assert.ok(note.indexOf("我养了一只猫叫团子") >= 0, "应包含原话：" + note);
    assert.ok(note.indexOf("harry-1.jsonl") >= 0, "应标出出处：" + note);
    assert.ok(note.indexOf("第 0 条") >= 0, "应标出第几条：" + note);
    assert.ok(note.indexOf("不要补充记录里没有的细节") >= 0, "应要求不要添油加醋：" + note);
  });

  await test("诚实规则始终可用，内容明确禁止编造", () => {
    const rule = Search.honestyRule();
    assert.ok(rule.indexOf("不知道") >= 0, "应允许说不知道：" + rule);
    assert.ok(rule.indexOf("不要") >= 0 && rule.indexOf("编造") >= 0, "应禁止编造：" + rule);
  });

  await test("诚实规则必须区分「眼前的对话」和「以前的记录」", () => {
    // 这条是真踩过的坑：规则只写"没有依据就说不知道"，
    // 模型会连同一段对话里刚说过的话都不敢认，张口"我这边什么都没有"。
    const rule = Search.honestyRule();
    assert.ok(rule.indexOf("正在进行的这段对话") >= 0, "必须说明眼前的对话算事实：" + rule);
    assert.ok(rule.indexOf("不要怀疑它") >= 0 || rule.indexOf("不要否认它") >= 0,
      "必须明确要求不要否认刚说过的话：" + rule);
    assert.ok(rule.indexOf("更早") >= 0, "必须把更早的记录和眼前对话分开：" + rule);
  });

  await test("翻不到时的说明不能说成「整段对话都没记录」", () => {
    const note = Search.buildHistoryNote(Search.searchHistory(sessions(), "我们去过月球吗", {}));
    assert.ok(note.indexOf("更早以前") >= 0, "应限定为更早以前的记录：" + note);
    assert.ok(note.indexOf("仍然算数") >= 0, "应提醒当前这段对话仍然有效：" + note);
  });

  console.log("");
  console.log(failures ? `SEARCH_UNIT=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `SEARCH_UNIT=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
