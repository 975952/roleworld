"use strict";

/*
 * sticker-unit.cjs —— 表情包的纯逻辑测试（不需要浏览器、不联网）
 *
 * 覆盖四件事：
 *   ① 名字解析：模型写的"微笑 / happy / 开心地笑"都要能命中同一张表情；
 *      命中不了就**丢掉**（宁可没有表情，也不要破图）。
 *   ② 标记剥除：写完整的、半截的（流式停在中间）都不能留在正文里。
 *   ③ 提示词：只在真的有表情时才教模型写标记；关掉系统时一个字都不提。
 *   ④ 磁盘上的表情包：manifest 与文件对得上、每张图都非空（真正的"画没画出来"
 *      由 scripts/check-stickers.cjs 渲染后量像素，这里管的是"有没有、对不对得上"）。
 */

const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const Core = require(path.join(ROOT, "app", "sticker-core.js"));

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

/* 测试用的假表情包：不读磁盘，保证逻辑测试与内容解耦。 */
const PACKS = [
  {
    id: "mood",
    label: "情绪",
    stamps: [
      { id: "mood:happy", name: "开心", file: "happy.svg", url: "stickers/mood/happy.svg", tags: ["高兴", "快乐", "笑", "happy"] },
      { id: "mood:sad", name: "难过", file: "sad.svg", url: "stickers/mood/sad.svg", tags: ["伤心", "哭", "sad"] },
      { id: "mood:shy", name: "害羞", file: "shy.svg", url: "stickers/mood/shy.svg", tags: ["脸红", "blush"] },
    ],
  },
  {
    id: "reply",
    label: "应答",
    stamps: [
      { id: "reply:nod", name: "点头", file: "nod.svg", url: "stickers/reply/nod.svg", tags: ["同意", "好的"], aliases: ["nod", "agree", "yes"] },
    ],
  },
];

(async () => {
  console.log("== 表情包：名字解析 ==");

  await test("精确名字命中", () => {
    const index = Core.indexStamps(PACKS);
    assert.equal(Core.resolve("开心", index).id, "mood:happy");
    assert.equal(Core.resolve("点头", index).id, "reply:nod");
  });

  await test("别名命中：模型写「微笑 / happy / 笑」都指向同一张", () => {
    const index = Core.indexStamps(PACKS);
    for (const alias of ["微笑", "happy", "笑", "高兴"]) {
      assert.equal(Core.resolve(alias, index).id, "mood:happy", "别名没命中：" + alias);
    }
    for (const alias of ["哭", "伤心", "sad"]) {
      assert.equal(Core.resolve(alias, index).id, "mood:sad", "别名没命中：" + alias);
    }
  });

  await test("标签命中与包含关系命中（「开心地笑」→ 开心）", () => {
    const index = Core.indexStamps(PACKS);
    assert.equal(Core.resolve("脸红", index).id, "mood:shy", "标签没命中");
    assert.equal(Core.resolve("开心地笑", index).id, "mood:happy", "包含关系没命中");
    assert.equal(Core.resolve("高兴地点头", index).id, "reply:nod", "包含关系没命中");
  });

  await test("编不出来的一律返回 null（不显示破图）", () => {
    const index = Core.indexStamps(PACKS);
    for (const bogus of ["欣慰", "量子纠缠", "", "   ", "???"]) {
      assert.equal(Core.resolve(bogus, index), null, "不该命中：" + JSON.stringify(bogus));
    }
  });

  await test("没有任何表情包时，一切都安全（返回 null / 空）", () => {
    const index = Core.indexStamps([]);
    assert.equal(Core.resolve("开心", index), null);
    assert.equal(Core.indexStamps(null).all.length, 0);
    assert.equal(Core.indexStamps(undefined).all.length, 0);
  });

  console.log("== 表情包：标记剥除 ==");

  await test("写完整的标记被剥掉，正文干净", () => {
    const out = Core.extractStickers("那我们说好了。\n[[表情: 开心]]", PACKS);
    assert.equal(out.text, "那我们说好了。");
    assert.equal(out.stickers.length, 1);
    assert.equal(out.stickers[0].id, "mood:happy");
  });

  await test("标记夹在中间也能剥掉", () => {
    const out = Core.extractStickers("先说这个。[[表情: 难过]]然后呢？", PACKS);
    assert.ok(out.text.indexOf("表情") < 0, "正文里还留着标记");
    assert.ok(out.text.indexOf("先说这个。") >= 0 && out.text.indexOf("然后呢？") >= 0, "正文被吃掉了");
    assert.equal(out.stickers.length, 1);
  });

  await test("全角括号 / 英文写法 / 带竖线补充都能认", () => {
    const a = Core.extractStickers("哦。【表情：害羞】", PACKS);
    assert.equal(a.stickers[0].id, "mood:shy");
    const b = Core.extractStickers("ok. [[sticker: nod]]", PACKS);
    assert.equal(b.stickers[0].id, "reply:nod");
    const c = Core.extractStickers("嗯。[[表情: 开心 | 因为约好了]]", PACKS);
    assert.equal(c.stickers[0].id, "mood:happy");
    assert.ok(c.text.indexOf("因为约好了") < 0, "竖线后面的补充说明不该留在正文里");
  });

  await test("一轮最多一个表情（多了只取第一个）", () => {
    const out = Core.extractStickers("[[表情: 开心]]\n[[表情: 难过]]", PACKS);
    assert.equal(out.stickers.length, Core.STICKER_LIMIT);
    assert.equal(out.stickers[0].id, "mood:happy");
    assert.ok(out.text.indexOf("表情") < 0, "第二个标记也要被剥掉，不能留在正文");
  });

  await test("解析不出来的名字：标记照样剥掉，但不产出表情", () => {
    const out = Core.extractStickers("好吧。\n[[表情: 量子纠缠]]", PACKS);
    assert.equal(out.stickers.length, 0);
    assert.equal(out.text, "好吧。");
  });

  await test("半截标记（流式停在中间）不会留在正文里", () => {
    for (const partial of ["我们说好了。\n[[表", "我们说好了。\n[[表情", "我们说好了。\n[[表情:", "我们说好了。\n[[表情: 开", "我们说好了。\n【表情："]) {
      const out = Core.stripPartialStickerMarkers(partial);
      assert.equal(out.indexOf("表"), -1, "半截标记没被剥掉：" + JSON.stringify(partial) + " → " + JSON.stringify(out));
      assert.ok(out.indexOf("我们说好了。") >= 0, "正文被误伤：" + JSON.stringify(out));
    }
  });

  await test("普通方括号不会被当成半截标记吃掉", () => {
    const text = "它在代码里写 arr[0] 和 [备注]，你看";
    assert.equal(Core.stripPartialStickerMarkers(text), text);
  });

  await test("用户发表情：写进记录的那行字带上名字", () => {
    const text = Core.stickerAsMessageText({ id: "mood:happy", name: "开心" });
    assert.ok(text.indexOf("开心") >= 0, "记录里必须能看出是哪个表情");
    assert.ok(text.indexOf("[") >= 0, "要有一眼能认出的包裹标记");
  });

  console.log("== 表情包：提示词 ==");

  await test("有表情时列出可用名字，并要求一轮最多一个", () => {
    const line = Core.stickerInstruction(PACKS, {});
    assert.ok(line.indexOf("[[表情: 名字]]") >= 0, "没教写法");
    for (const name of ["开心", "难过", "害羞", "点头"]) {
      assert.ok(line.indexOf(name) >= 0, "可用表情里少了：" + name);
    }
    assert.ok(/最多一个/.test(line), "没写「一轮最多一个」");
    assert.ok(line.indexOf("不要每句话都配表情") >= 0, "没提醒别刷屏");
  });

  await test("一个表情包都没有时，不产生这段提示词", () => {
    assert.equal(Core.stickerInstruction([], {}), "");
    assert.equal(Core.stickerInstruction(null, {}), "");
  });

  console.log("== 表情包：磁盘上的内容 ==");

  await test("app/stickers 的清单与文件对得上，且都不是空文件", () => {
    const root = path.join(ROOT, "app", "stickers");
    const manifestPath = path.join(root, "index.json");
    assert.ok(fs.existsSync(manifestPath), "缺 app/stickers/index.json（根清单）");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.packs) && manifest.packs.length > 0, "根清单里一个包都没有");
    let total = 0;
    for (const entry of manifest.packs) {
      const packDir = path.join(root, entry.id);
      const packManifest = path.join(packDir, "index.json");
      assert.ok(fs.existsSync(packManifest), entry.id + " 缺 index.json");
      const pack = JSON.parse(fs.readFileSync(packManifest, "utf8"));
      assert.equal(pack.id, entry.id, entry.id + " 的 pack.id 与目录不一致");
      assert.ok(pack.label, entry.id + " 缺 label");
      assert.ok(Array.isArray(pack.stamps) && pack.stamps.length > 0, entry.id + " 没有表情");
      for (const stamp of pack.stamps) {
        assert.ok(stamp.id && stamp.name && stamp.file, entry.id + " 有表情缺字段");
        const file = path.join(packDir, stamp.file);
        assert.ok(fs.existsSync(file), entry.id + "/" + stamp.file + " 不存在");
        assert.ok(fs.statSync(file).size > 120, entry.id + "/" + stamp.file + " 是空文件");
        total += 1;
      }
    }
    assert.ok(total >= 12, "内置表情太少（只有 " + total + " 个）");
  });

  console.log("== 表情包：两种入参形状（这一条是真 bug 的回归） ==");

  await test("扁平数组（adapter 真实产出的形状）也能解析 —— 不能只认「包数组」",
    () => {
      // 背景：indexStamps 一开始只认 [{ id, stamps: [...] }]（包数组），
      // 而 adapter.availableStamps() 产出的是**扁平数组** [{ id: "mood:happy", ... }]。
      // 结果：真实调用路径下一个表情都解析不出来，而单元测试全绿 ——
      // 因为测试喂的是包数组。测试和真实形状不一致，等于没测。
      const flat = PACKS.flatMap((pack) => pack.stamps.map((stamp) => ({
        id: stamp.id,
        name: stamp.name,
        file: stamp.file,
        url: stamp.url,
        tags: stamp.tags,
        aliases: stamp.aliases,
      })));
      const out = Core.extractStickers("好啊。\n[[表情: 开心]]", flat);
      assert.equal(out.stickers.length, 1, "扁平数组形状下没解析出来（生产路径就是这个形状）");
      assert.equal(out.stickers[0].id, "mood:happy");
      assert.equal(out.text, "好啊。");
      // 包数组形状也必须继续可用
      const packsOut = Core.extractStickers("好啊。\n[[表情: 开心]]", PACKS);
      assert.equal(packsOut.stickers.length, 1, "包数组形状反而坏了");
      assert.equal(packsOut.stickers[0].id, "mood:happy");
    });

  await test("扁平入参里没有包信息时，也不该崩（只是可能对不上 id）", () => {
    const lonely = [{ id: "开心", name: "开心", file: "happy.svg", url: "x", tags: [] }];
    const out = Core.extractStickers("哦。\n[[表情: 开心]]", lonely);
    assert.equal(out.stickers.length, 1);
    assert.equal(out.text, "哦。");
  });

  await test("内置表情的名字在解析器里都能命中（清单与逻辑对得上）", () => {    const root = path.join(ROOT, "app", "stickers");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    const packs = manifest.packs.map((entry) => {
      const pack = JSON.parse(fs.readFileSync(path.join(root, entry.id, "index.json"), "utf8"));
      return pack;
    });
    const index = Core.indexStamps(packs);
    for (const pack of packs) {
      for (const stamp of pack.stamps) {
        const hit = Core.resolve(stamp.name, index);
        assert.ok(hit, "内置表情解析不到：" + pack.id + "/" + stamp.name);
        assert.equal(hit.id, pack.id + ":" + stamp.id, "内置表情解析串了：" + stamp.name);
      }
    }
  });

  console.log("");
  const passed = results.filter((r) => r.ok).length;
  console.log(`STICKER_UNIT=${passed}/${results.length}`);
  if (failures) {
    console.log(`（失败 ${failures} 项）`);
    process.exit(1);
  }
})();
