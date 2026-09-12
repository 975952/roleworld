"use strict";

/*
 * adapter/pack-cleanup.js —— 清掉内置包里"别人的存档"
 *
 * 背景（2026-09-12，用户原话「我又不是 Lin」）：
 * 内置「哈利·波特」包早先带着 4 本记忆书，内容全部来自当年那份 SillyTavern 存档 ——
 * 里面「Lin（林）」是**那份存档里的玩家角色**（上海来的麻瓜出身学生）。其中 3 条还是
 * `constant: true`（每条消息都注入），于是任何人以自己（或别的角色）的身份跟哈利说话，
 * 模型都会被反复告知"玩家叫 Lin、上海来的"。
 *
 * 包里那 3 本整本都是 Lin 的记忆书已经删掉、角色锁定书里那条 Lin 也删了（原件归档在
 * `runs/2026-09-12-lin-sample-memories-removed/`）。但**已经装过旧包的存档不会自动变干净**：
 * 内容包只在"这本世界书还不存在"时才安装（见 adapter/packs.js），升级不会覆盖用户的世界书。
 * 所以这里补一次一次性清理。
 *
 * 安全规则（重要）：
 *   - 只删「uid 对得上 **且** 正文里还带着原来的特征串」的条目：用户改过内容的条目一律不碰；
 *   - 只删本文件里冻结的那几条，绝不按"看起来像 Lin"这种模糊规则批量删；
 *   - 整本清空时删掉那本记忆书（只在它本来就是包自带、且清空后一条不剩时）；
 *   - 幂等：清理过的存档再跑一次不会删任何东西。
 */

(function (global) {
  /* 冻结的示例条目表：uid + 原始正文里的特征串。
   * marker 用正文里一句独特的话，而不是整段正文 —— 用户哪怕只改了一个标点，
   * 只要 marker 还在就说明这条没被改写过（这些条目本来就是包自带的）。
   * 反过来，用户把内容改成自己的事，marker 就不在了，条目会被留下。 */
  const SAMPLE_MEMORIES = [
    {
      world: "MB Harry — fact clips (EN)",
      dropBookWhenEmpty: true,
      entries: [
        { uid: "mb-fact-home", marker: "Lin's home city is Shanghai, China" },
        { uid: "mb-fact-heights", marker: "Lin is terrified of heights" },
        { uid: "mb-fact-parents", marker: "Lin is a Muggle-born student who grew up in Shanghai" },
        { uid: "mb-fact-broom", marker: "Harry will teach Lin to fly on Saturday after lunch" },
      ],
    },
    {
      world: "MB Harry — relationship tracker (EN)",
      dropBookWhenEmpty: true,
      entries: [
        { uid: "mb-tracker-relations", marker: "Harry and Lin have developed a close friendship" },
      ],
    },
    {
      world: "MB Harry — role lock (EN)",
      // 这本只删 Lin 那一条，乌姆里奇/时间线那条设定要留着（整本不会空）。
      dropBookWhenEmpty: false,
      entries: [
        { uid: "mb-role-shared-lin", marker: "Lin is a new student at Hogwarts who grew up in Shanghai" },
      ],
    },
    {
      world: "MB Harry — scene memories (EN)",
      dropBookWhenEmpty: true,
      entries: [
        { uid: "mb-scene-meeting", marker: "Lin, a new Muggle-born student from Shanghai" },
        { uid: "mb-scene-promise", marker: "Harry agreed to teach Lin to fly a broomstick" },
        { uid: "mb-scene-book", marker: "Hermione is lending Lin a copy of 'Quidditch Through the Ages'" },
      ],
    },
  ];

  function keyOf(entry) {
    if (entry && entry.uid !== undefined && entry.uid !== null) return String(entry.uid);
    return "";
  }

  /** 纯函数：从一本世界书里挑出该删的条目。返回 { keep, removed }，不改原对象。 */
  function stripSampleEntries(entries, spec) {
    const source = entries && typeof entries === "object" ? entries : {};
    const wanted = new Map((spec && spec.entries ? spec.entries : []).map((row) => [String(row.uid), row.marker]));
    const keep = {};
    const removed = [];
    for (const key of Object.keys(source)) {
      const entry = source[key] || {};
      const marker = wanted.get(keyOf(entry));
      const content = String(entry.content === undefined || entry.content === null ? "" : entry.content);
      if (marker && content.indexOf(marker) >= 0) {
        removed.push({ key, uid: entry.uid === undefined ? key : entry.uid });
        continue;
      }
      keep[key] = entry;
    }
    return { keep, removed };
  }

  /**
   * 一次性清理。store 需要 listWorlds / getWorld / putWorld / deleteWorld。
   * 返回 { removed, books, deletedBooks, emptiedBooks }，供界面提示用户。
   */
  async function cleanupSampleMemories(store) {
    const report = { removed: 0, books: [], deletedBooks: [], removedEntries: [] };
    if (!store || typeof store.getWorld !== "function") return report;
    for (const spec of SAMPLE_MEMORIES) {
      let world = null;
      try {
        world = await store.getWorld(spec.world);
      } catch (_) {
        world = null;
      }
      if (!world || !world.entries) continue;
      const { keep, removed } = stripSampleEntries(world.entries, spec);
      if (!removed.length) continue;
      report.removed += removed.length;
      report.books.push(spec.world);
      for (const row of removed) report.removedEntries.push({ book: spec.world, key: row.key });
      if (spec.dropBookWhenEmpty && Object.keys(keep).length === 0) {
        await store.deleteWorld(spec.world);
        report.deletedBooks.push(spec.world);
      } else {
        await store.putWorld(spec.world, Object.assign({}, world, { entries: keep }));
      }
    }
    return report;
  }

  const api = { SAMPLE_MEMORIES, stripSampleEntries, cleanupSampleMemories };
  global.RoleWorldPackCleanup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
