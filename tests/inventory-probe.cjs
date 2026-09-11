"use strict";

/*
 * inventory-probe.cjs —— 阶段①「基础聊天」验收探针
 *
 * 用户给出的阶段①完成标准是四条：
 *   1. 刷新不丢记录
 *   2. 重试不重复写入
 *   3. 不同角色数据隔离
 *   4. 聊天保存与导出
 *
 * 现有 adapter-unit / local-app-check 都没有直接断言这四条。
 * 本脚本用真实产品代码 + 内存后端（不联网、不碰真实数据）把它们跑一遍。
 * 每个用例用全新的空后端，互不污染。
 */

const path = require("node:path");
const assert = require("node:assert/strict");

const APP = path.join(__dirname, "..", "app");
const Store = require(path.join(APP, "adapter", "store.js"));
const Core = require(path.join(APP, "task22-core.js"));
const CharacterCore = require(path.join(APP, "task29-character-core.js"));

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

// ---- 合成 fixture ----
const HARRY = "Harry Potter (EN).png";
const RON = "Ron Weasley (Triwizard Year).png";

function card(avatar, name) {
  return {
    avatar,
    name,
    description: name + " 的描述",
    first_mes: "你好，我是" + name + "。",
    data: { system_prompt: "", character_book: null, tags: [] },
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// 每个用例一个干净后端
async function freshStore() {
  Store.setBackendForTests(Store.createMemoryBackend());
  await Store.ready();
  await Store.putCharacter(card(HARRY, "Harry Potter"));
  await Store.putCharacter(card(RON, "Ron Weasley"));
  await Store.putWorld("MB Harry — auto", { entries: {} });
  await Store.putWorld("MB Ron — auto", { entries: {} });
}

const api = {
  listChats: (avatar) => Store.listChats(avatar),
  getChat: (avatar, fileName) => Store.getChat(avatar, fileName),
  saveChat: (avatar, fileName, messages) => Store.saveChat(avatar, fileName, messages),
};

// 与 integration.js 完全一致的回执通道（同一个本地 store，不新增存储层）
const receipts = {
  get: (avatar, fileName) => Store.getKV("turn:" + avatar + ":" + fileName, null),
  set: (avatar, fileName, value) => Store.setKV("turn:" + avatar + ":" + fileName, value),
};

function makeModel(storage) {
  return Core.createHarryChatModel({
    api,
    receipts,
    avatar: HARRY,
    charName: "Harry Potter",
    userName: "我",
    userHandle: "local",
    storage,
    characters: [
      { avatar: HARRY, name: "Harry Potter" },
      { avatar: RON, name: "Ron Weasley" },
    ],
  });
}

async function countTurns(avatar, fileName) {
  const lines = await Store.getChat(avatar, fileName);
  const msgs = Core.messagesFromChat(lines);
  return {
    lines: lines.length,
    messages: msgs.length,
    users: msgs.filter((m) => m.is_user).length,
    assistants: msgs.filter((m) => !m.is_user).length,
    headers: lines.filter((l) => l && l.chat_metadata).length,
  };
}

async function main() {
  console.log("== ① 聊天保存：刷新不丢记录 ==");

  await test("一轮对话保存后，重新建模型（等同刷新）仍能读出同样内容", async () => {
    await freshStore();
    const storage = makeStorage();
    const first = makeModel(storage);
    await first.refresh();
    first.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    await first.saveTurn("我叫小林", "记住了，小林。", { userName: "我", charName: "Harry Potter", turnId: "t1" });
    const fileName = first.getActive().fileName;

    const second = makeModel(storage);           // 内存全丢，只剩磁盘 + 偏好
    await second.refresh();
    const restored = second.getActive();
    assert.ok(restored, "刷新后没有恢复出任何会话");
    assert.equal(restored.fileName, fileName, "刷新后没有回到同一段对话");
    assert.deepEqual(restored.messages.map((m) => m.mes), ["我叫小林", "记住了，小林。"],
      "刷新后消息内容不一致：" + JSON.stringify(restored.messages.map((m) => m.mes)));
  });

  console.log("== ② 重试不重复写入 ==");

  await test("同一轮重发（同一个 turnId）不会写第二遍、不再计一次费", async () => {
    await freshStore();
    const storage = makeStorage();
    const model = makeModel(storage);
    await model.refresh();
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    const first = await model.saveTurn("第一句", "第一答", { userName: "我", charName: "Harry Potter", turnId: "turn-A" });
    assert.equal(first.duplicate, false, "第一次保存不该被当成重复");
    const fileName = model.getActive().fileName;
    const once = await countTurns(HARRY, fileName);
    assert.equal(once.messages, 2, "第一轮后应有 2 条消息，实际 " + once.messages);

    // 重发同一轮：保存其实成功、界面却当失败的那种情况
    const again = await model.saveTurn("第一句", "第一答", { userName: "我", charName: "Harry Potter", turnId: "turn-A" });
    assert.equal(again.duplicate, true, "重发同一轮没有被识别成重复");
    const twice = await countTurns(HARRY, fileName);
    assert.equal(twice.messages, once.messages, "重发后消息数变了：" + once.messages + " → " + twice.messages);
    assert.equal(twice.headers, 1, "元数据头被写了多次，实际 " + twice.headers);
  });

  await test("重试的幂等性跨刷新有效（回执不只在内存里）", async () => {
    await freshStore();
    const storage = makeStorage();
    const first = makeModel(storage);
    await first.refresh();
    first.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    await first.saveTurn("我改主意了", "好，听你的。", { userName: "我", charName: "Harry Potter", turnId: "turn-B" });
    const fileName = first.getActive().fileName;
    const before = await countTurns(HARRY, fileName);

    // 刷新：新模型实例，内存里的回执没了，只靠本地存储
    const second = makeModel(storage);
    await second.refresh();
    assert.equal(second.getActive().fileName, fileName, "刷新后没有回到同一段对话");
    const retry = await second.saveTurn("我改主意了", "好，听你的。", { userName: "我", charName: "Harry Potter", turnId: "turn-B" });
    assert.equal(retry.duplicate, true, "刷新后重发没有被识别成重复");
    const after = await countTurns(HARRY, fileName);
    assert.equal(after.messages, before.messages, "刷新后重发还是写了一遍：" + before.messages + " → " + after.messages);
  });

  await test("正常的新一轮（新的 turnId）照旧写入", async () => {
    await freshStore();
    const storage = makeStorage();
    const model = makeModel(storage);
    await model.refresh();
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    await model.saveTurn("第一句", "第一答", { userName: "我", charName: "Harry Potter", turnId: "turn-1" });
    const fileName = model.getActive().fileName;
    await model.saveTurn("第二句", "第二答", { userName: "我", charName: "Harry Potter", turnId: "turn-2" });
    const detail = await countTurns(HARRY, fileName);
    assert.equal(detail.messages, 4, "两轮后应有 4 条消息，实际 " + detail.messages);
  });

  await test("保存失败 → 重发同一句：不丢内容、不写重复头", async () => {
    await freshStore();
    const storage = makeStorage();
    const model = makeModel(storage);
    await model.refresh();
    const realSave = api.saveChat;
    let failOnce = true;
    api.saveChat = async function () {
      if (failOnce) { failOnce = false; throw new Error("network down"); }
      return realSave.apply(null, arguments);
    };

    // UI 路径：绑定发生在保存之前（integration.js 步骤 3）
    model.bindActive({ avatar: RON, charName: "Ron Weasley" });
    let threw = false;
    try {
      await model.saveTurn("你好荣恩", "你好呀", { userName: "我", charName: "Ron Weasley", turnId: "turn-C" });
    } catch (_) { threw = true; }
    assert.ok(threw, "第一次保存应当失败");
    const afterFail = await Store.listChats(RON);
    assert.equal(afterFail.length, 0, "失败的那次不应留下对话，实际 " + afterFail.length);

    // UI 的失败路径会调 unbindActive 撤销绑定，再重发时重新绑定
    model.unbindActive();
    model.bindActive({ avatar: RON, charName: "Ron Weasley" });
    await model.saveTurn("你好荣恩", "你好呀", { userName: "我", charName: "Ron Weasley", turnId: "turn-C" });
    api.saveChat = realSave;

    const chats = await Store.listChats(RON);
    assert.equal(chats.length, 1, "荣恩名下应只有 1 段对话，实际 " + chats.length);
    const detail = await countTurns(RON, chats[0].file_name);
    assert.equal(detail.messages, 2, "重试后应只有 2 条消息，实际 " + detail.messages);
    assert.equal(detail.headers, 1, "应只有 1 个元数据头，实际 " + detail.headers);
  });

  await test("失败那轮没有留下回执：重发确实会被写入，而不是被误判成重复", async () => {
    await freshStore();
    const model = makeModel(makeStorage());
    await model.refresh();
    const realSave = api.saveChat;
    api.saveChat = async () => { throw new Error("network down"); };
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    try { await model.saveTurn("会失败的", "不会成功", { userName: "我", charName: "Harry Potter", turnId: "turn-D" }); } catch (_) { /* expected */ }
    api.saveChat = realSave;
    const retry = await model.saveTurn("会失败的", "这次成功", { userName: "我", charName: "Harry Potter", turnId: "turn-D" });
    assert.equal(retry.duplicate, false, "失败的那轮不该留下回执");
    const chats = await Store.listChats(HARRY);
    const detail = await countTurns(HARRY, chats[0].file_name);
    assert.equal(detail.messages, 2, "重发后应有 2 条消息，实际 " + detail.messages);
  });

  console.log("== ③ 不同角色数据隔离 ==");

  await test("两个角色各有自己的对话，互不串", async () => {
    await freshStore();
    const storage = makeStorage();
    const model = makeModel(storage);
    await model.refresh();
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    await model.saveTurn("哈里你好", "你好", { userName: "我", charName: "Harry Potter", turnId: "h1" });

    const harryChats = await Store.listChats(HARRY);
    const ronChats = await Store.listChats(RON);
    assert.ok(harryChats.length === 1, "Harry 应有 1 段对话，实际 " + harryChats.length);
    assert.equal(ronChats.length, 0, "Ron 不应有对话，实际 " + ronChats.length);
    assert.ok(harryChats.every((c) => c.avatar === HARRY), "Harry 列表混进别的角色");
  });

  await test("记忆书按角色归属：拿到的永远是自己的那几本", async () => {
    await freshStore();
    const books = await Store.listWorlds();
    const forHarry = CharacterCore.memoryBooksFor({ avatar: HARRY, name: "Harry Potter" }, books);
    const forRon = CharacterCore.memoryBooksFor({ avatar: RON, name: "Ron Weasley" }, books);
    assert.deepEqual(forHarry.map((b) => b.name), ["MB Harry — auto"], "Harry 拿到的书不对：" + JSON.stringify(forHarry.map((b) => b.name)));
    assert.deepEqual(forRon.map((b) => b.name), ["MB Ron — auto"], "Ron 拿到的书不对：" + JSON.stringify(forRon.map((b) => b.name)));
  });

  await test("已绑定会话不允许中途换角色（换角色必须新建对话）", async () => {
    await freshStore();
    const model = makeModel(makeStorage());
    await model.refresh();
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    let code = "";
    try { model.bindActive({ avatar: RON, charName: "Ron Weasley" }); } catch (error) { code = error.code; }
    assert.equal(code, "CHAT_ALREADY_BOUND", "换角色没有被拒绝，返回：" + code);
  });

  console.log("== ④ 导出（换机器不丢） ==");

  await test("导出存档包含两个角色的对话与记忆书，导入回来内容一致", async () => {
    await freshStore();
    const model = makeModel(makeStorage());
    await model.refresh();
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    await model.saveTurn("哈里你好", "你好", { userName: "我", charName: "Harry Potter", turnId: "e1" });

    const ronModel = Core.createHarryChatModel({
      api, receipts, avatar: RON, charName: "Ron Weasley", userName: "我", userHandle: "ron-user", storage: makeStorage(),
      characters: [{ avatar: RON, name: "Ron Weasley" }],
    });
    await ronModel.refresh();
    ronModel.bindActive({ avatar: RON, charName: "Ron Weasley" });
    await ronModel.saveTurn("荣恩你好", "嘿", { userName: "我", charName: "Ron Weasley", turnId: "e2" });

    const dump = await Store.exportAll();
    assert.equal(dump.format, "roleworld-archive", "存档格式标记不对：" + dump.format);
    const avatars = new Set(dump.data.chats.map((row) => row.avatar));
    assert.ok(avatars.has(HARRY) && avatars.has(RON), "导出的对话没有覆盖两个角色：" + JSON.stringify([...avatars]));
    assert.ok(dump.data.worlds.length >= 2, "导出的记忆书少于 2 本：" + dump.data.worlds.length);
    assert.ok(dump.data.characters.length === 2, "导出的角色卡应为 2 张，实际 " + dump.data.characters.length);

    Store.setBackendForTests(Store.createMemoryBackend());
    await Store.ready();
    await Store.importAll(dump, { mode: "replace" });
    const harryAgain = await Store.listChats(HARRY);
    const ronAgain = await Store.listChats(RON);
    const worlds = await Store.listWorlds();
    assert.ok(harryAgain.length >= 1, "导入后 Harry 的对话没了");
    assert.ok(ronAgain.length >= 1, "导入后 Ron 的对话没了");
    assert.ok(worlds.some((w) => w.name === "MB Harry — auto"), "导入后记忆书没了：" + JSON.stringify(worlds.map((w) => w.name)));
  });

  console.log("== ⑤ 停止生成时的半截记忆标记 ==");

  await test("停在 [[记住: 半截处：标记不显示、也不进聊天记录", async () => {
    const partials = [
      "他把书合上。\n[[记住",
      "他把书合上。\n[[记住:",
      "他把书合上。\n[[记住: 你叫小林",
      "他把书合上。\n【记住：你叫小林",
    ];
    for (const raw of partials) {
      const visible = Core.stripPartialMemoryMarkers(raw);
      assert.ok(visible.indexOf("记住") < 0, "半截标记还留在显示文本里：" + JSON.stringify(raw) + " → " + JSON.stringify(visible));
      assert.equal(visible, "他把书合上。", "正文之外的残留没清干净：" + JSON.stringify(visible));

      const parsed = Core.extractMemory(raw);
      assert.ok(parsed.text.indexOf("记住") < 0, "半截标记进了保存的正文：" + JSON.stringify(parsed.text));
      assert.deepEqual(parsed.memories, [], "半截标记被当成了记忆要点：" + JSON.stringify(parsed.memories));
    }
  });

  await test("完整标记之后又停在一个半截标记：完整的照收，半截的丢掉", async () => {
    const raw = "他把书合上。\n[[记住: 你叫小林]]\n[[记住: 你怕黑";
    const visible = Core.stripPartialMemoryMarkers(raw);
    assert.ok(visible.indexOf("你怕黑") < 0, "半截那条还在：" + JSON.stringify(visible));
    const parsed = Core.extractMemory(raw);
    assert.equal(parsed.text, "他把书合上。", "正文没清干净：" + JSON.stringify(parsed.text));
    assert.deepEqual(parsed.memories, ["你叫小林"], "完整那一条应当照收：" + JSON.stringify(parsed.memories));
  });

  await test("完整的记忆标记照旧：剥出要点、正文不留痕", async () => {
    const parsed = Core.extractMemory("他把书合上。\n[[记住: 你叫小林]]\n[[记住: 你怕黑]]");
    assert.equal(parsed.text, "他把书合上。", "正文没清干净：" + JSON.stringify(parsed.text));
    assert.deepEqual(parsed.memories, ["你叫小林", "你怕黑"], "要点没剥出来：" + JSON.stringify(parsed.memories));
  });

  await test("停止后的半截回复能原样存下来（不因为清标记而变成空）", async () => {
    await freshStore();
    const model = makeModel(makeStorage());
    await model.refresh();
    model.bindActive({ avatar: HARRY, charName: "Harry Potter" });
    const stopped = Core.extractMemory("话说到一半就停了\n[[记住: 还没写完").text;
    assert.equal(stopped, "话说到一半就停了", "停止后的正文不对：" + JSON.stringify(stopped));
    await model.saveTurn("你先说", stopped, { userName: "我", charName: "Harry Potter", turnId: "stop-1" });
    const chats = await Store.listChats(HARRY);
    const detail = await countTurns(HARRY, chats[0].file_name);
    assert.equal(detail.messages, 2, "停止后仍应保存这一轮，实际 " + detail.messages);
  });

  console.log("");
  console.log(failures ? `INVENTORY_PROBE=${results.length - failures}/${results.length}（有 ${failures} 项不达标）` : `INVENTORY_PROBE=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("探针自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
