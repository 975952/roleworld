"use strict";

/*
 * metrics-unit.cjs —— 每轮指标台账的单元测试（不需要浏览器）
 *
 * 覆盖：一轮记录的字段、按轮次 ID 标记（不按下标）、取消标记、汇总口径、
 * 上限裁剪、脏数据、以及"没有样本时不当成 0"。
 */

const path = require("node:path");
const assert = require("node:assert/strict");

const Metrics = require(path.join(__dirname, "..", "app", "metrics-core.js"));

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
  console.log("== 一轮记录 ==");

  await test("缺字段按 0 处理，不编造数字", () => {
    const turn = Metrics.makeTurn({ turnId: "t1" });
    assert.equal(turn.turnId, "t1");
    assert.equal(turn.firstTokenMs, 0);
    assert.equal(turn.totalMs, 0);
    assert.equal(turn.cost, 0);
    assert.deepEqual(turn.flags, []);
    assert.ok(turn.at, "应当有时间戳");
  });

  await test("负数与非法值不会混进台账", () => {
    const turn = Metrics.makeTurn({ firstTokenMs: -5, totalMs: "abc", inputTokens: null, cost: NaN });
    assert.equal(turn.firstTokenMs, 0);
    assert.equal(turn.totalMs, 0);
    assert.equal(turn.inputTokens, 0);
    assert.equal(turn.cost, 0);
  });

  await test("超过上限时只留最近 200 轮", () => {
    let turns = [];
    for (let i = 0; i < 260; i += 1) turns = Metrics.appendTurn(turns, { turnId: "t" + i, firstTokenMs: 100 });
    assert.equal(turns.length, Metrics.MAX_TURNS);
    assert.equal(turns[0].turnId, "t60", "应当丢掉最旧的");
    assert.equal(turns[turns.length - 1].turnId, "t259");
  });

  console.log("== 用户标记（只由人点） ==");

  await test("按轮次 ID 标记：只标中那一轮", () => {
    let turns = [];
    turns = Metrics.appendTurn(turns, { turnId: "a", firstTokenMs: 100 });
    turns = Metrics.appendTurn(turns, { turnId: "b", firstTokenMs: 100 });
    const result = Metrics.flagTurn(turns, "b", Metrics.FLAGS.WRONG_MEMORY);
    assert.equal(result.ok, true);
    assert.deepEqual(Metrics.flagsOf(result.turns, "b"), [Metrics.FLAGS.WRONG_MEMORY]);
    assert.deepEqual(Metrics.flagsOf(result.turns, "a"), [], "不该标到别的轮次上");
  });

  await test("再点一次是取消", () => {
    let turns = Metrics.appendTurn([], { turnId: "a" });
    turns = Metrics.flagTurn(turns, "a", Metrics.FLAGS.FABRICATION).turns;
    assert.deepEqual(Metrics.flagsOf(turns, "a"), [Metrics.FLAGS.FABRICATION]);
    const off = Metrics.flagTurn(turns, "a", Metrics.FLAGS.FABRICATION);
    assert.equal(off.added, false);
    assert.deepEqual(Metrics.flagsOf(off.turns, "a"), []);
  });

  await test("同一轮可以同时被标成记错和编造", () => {
    let turns = Metrics.appendTurn([], { turnId: "a" });
    turns = Metrics.flagTurn(turns, "a", Metrics.FLAGS.WRONG_MEMORY).turns;
    turns = Metrics.flagTurn(turns, "a", Metrics.FLAGS.FABRICATION).turns;
    assert.equal(Metrics.flagsOf(turns, "a").length, 2);
  });

  await test("轮次不存在 / 没有 ID / 未知标记：明确失败，不静默", () => {
    const turns = Metrics.appendTurn([], { turnId: "a" });
    assert.equal(Metrics.flagTurn(turns, "nope", Metrics.FLAGS.GOOD).ok, false);
    assert.equal(Metrics.flagTurn(turns, "nope", Metrics.FLAGS.GOOD).reason, "missing");
    assert.equal(Metrics.flagTurn(turns, "", Metrics.FLAGS.GOOD).reason, "no-turn-id");
    assert.equal(Metrics.flagTurn(turns, "a", "whatever").reason, "unknown-flag");
  });

  console.log("== 汇总 ==");

  await test("只统计有值的项：一次失败的请求不该把平均延迟拉低", () => {
    let turns = [];
    turns = Metrics.appendTurn(turns, { turnId: "a", firstTokenMs: 1000, totalMs: 4000 });
    turns = Metrics.appendTurn(turns, { turnId: "b", firstTokenMs: 0, totalMs: 0 });
    const stats = Metrics.summarize(turns);
    assert.equal(stats.turns, 2);
    assert.equal(stats.avgFirstTokenMs, 1000, "0 值不该参与平均");
  });

  await test("费用与记忆计数按窗口累加", () => {
    let turns = [];
    turns = Metrics.appendTurn(turns, { turnId: "a", cost: 0.003, memoriesAdded: 1, memoriesReplaced: 0, searchHits: 2 });
    turns = Metrics.appendTurn(turns, { turnId: "b", cost: 0.002, memoriesAdded: 0, memoriesReplaced: 1, searchHits: 0 });
    const stats = Metrics.summarize(turns);
    assert.ok(Math.abs(stats.cost - 0.005) < 1e-9, "费用合计不对：" + stats.cost);
    assert.equal(stats.memoriesAdded, 1);
    assert.equal(stats.memoriesReplaced, 1);
    assert.equal(stats.searchHits, 2);
  });

  await test("窗口只算最近 N 轮，但总费用给全量", () => {
    let turns = [];
    for (let i = 0; i < 30; i += 1) turns = Metrics.appendTurn(turns, { turnId: "t" + i, cost: 0.001 });
    const stats = Metrics.summarize(turns, { window: 10 });
    assert.equal(stats.turns, 10);
    assert.equal(stats.totalTurns, 30);
    assert.ok(Math.abs(stats.cost - 0.01) < 1e-9, "窗口费用不对：" + stats.cost);
    assert.ok(Math.abs(stats.allCost - 0.03) < 1e-9, "总费用不对：" + stats.allCost);
  });

  await test("记忆错误率：没有样本时是 null，不假装是 0", () => {
    assert.equal(Metrics.summarize([]).wrongMemoryRate, null);
    let turns = Metrics.appendTurn([], { turnId: "a" });
    turns = Metrics.flagTurn(turns, "a", Metrics.FLAGS.WRONG_MEMORY).turns;
    turns = Metrics.appendTurn(turns, { turnId: "b" });
    const stats = Metrics.summarize(turns);
    assert.equal(stats.wrongMemory, 1);
    assert.equal(stats.wrongMemoryRate, 0.5);
  });

  await test("空台账与脏数据不炸", () => {
    const stats = Metrics.summarize(null);
    assert.equal(stats.turns, 0);
    assert.equal(stats.cost, 0);
    assert.deepEqual(Metrics.flagsOf(null, "x"), []);
    assert.deepEqual(Metrics.appendTurn("nope", { turnId: "a" }).length, 1);
  });

  await test("延迟显示：毫秒与秒", () => {
    assert.equal(Metrics.formatDuration(0), "—");
    assert.equal(Metrics.formatDuration(800), "800ms");
    assert.equal(Metrics.formatDuration(4200), "4.2s");
    assert.equal(Metrics.formatDuration(20000), "20s");
  });

  console.log("");
  console.log(failures ? `METRICS_UNIT=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `METRICS_UNIT=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
