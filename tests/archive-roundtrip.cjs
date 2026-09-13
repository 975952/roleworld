"use strict";

/*
 * archive-roundtrip.cjs —— 「真实界面导出 → 干净环境导入」端到端数据验收
 *
 * 为什么要单独一套：这是本轮（2026-09-13 界面体验优化）第 ③ 项的**数据验收**，
 * 要同时盯住消息版本（swipes / swipe_id）、分支（另一个对话文件）与"编辑后继续聊"，
 * 而且要真的走界面按钮（导出存档 / 导入存档），不是调内部函数。
 *
 * 隔离性：自己起静态服务、自己开一份全新的 Chrome profile（launchChrome 每次都是新
 * user-data-dir），角色与对话全部是**合成数据**；导入前用应用自己的"清空本机数据"
 * 路径把库清空，所以既不会污染真实用户数据，也不依赖任何外部服务或真实模型。
 *
 * 用法：node tests/archive-roundtrip.cjs
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CDP, launchChrome, sleep } = require("./cdp.js");

const APP = path.join(__dirname, "..", "app");
const PACKS = path.join(__dirname, "..", "packs");
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => { try { return fs.existsSync(candidate); } catch (_) { return false; } });

const AVATAR = "合成角色A.png";
const NAME = "合成角色A";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml",
};

let results = 0;
let failures = 0;
function ok(name, condition, detail) {
  results += 1;
  if (condition) { console.log("  PASS  " + name); return true; }
  failures += 1;
  console.log("  FAIL  " + name + (detail ? "\n        " + detail : ""));
  return false;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 空请求体 */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // 把这一轮的上下文记下来：后面要断言"用的是选中的版本、没混进分支"。
      state.requests.push({
        stream: body.stream === true,
        all: messages.map((m) => String((m && m.content) || "")).join("\n<<>>\n"),
      });
      const reply = state.replyQueue.shift() || "（默认回复）";
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write("data: " + JSON.stringify({ model: "synthetic", choices: [{ delta: { content: reply } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "synthetic", choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] }));
      return;
    }

    if (p === "/packs/index.json") {
      // 这个套件要的是**只有合成角色**的环境：内置内容包（六个哈利波特角色）不参与，
      // 否则"当前角色"会是内置角色，合成数据就写到别人身上了。
      // 只影响本套件自己的静态服务，不碰磁盘上的 packs/。
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ comment: "archive-roundtrip：本套件不装任何内容包", packs: [] }));
      return;
    }

    if (p === "/") p = "/index.html";
    const root = p.startsWith("/packs/") ? PACKS : APP;
    const rel = p.startsWith("/packs/") ? p.slice("/packs/".length) : p.replace(/^\/+/, "");
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function main() {
  if (!CHROME) { console.log("找不到 Chrome/Edge，可用 CHROME_PATH 指定"); process.exitCode = 1; return; }
  const state = { replyQueue: [], requests: [] };
  const { server, port } = await startServer(state);
  const base = "http://127.0.0.1:" + port;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-archive-"));
  const chrome = await launchChrome(CHROME, { debugPort: 9451 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");
  await cdp.sessionSend(session, "DOM.enable");
  await cdp.sessionSend(session, "Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await cdp.sessionSend(session, "Page.setInterceptFileChooserDialog", { enabled: true });

  const fixture = `(function () {
    try { localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-flash" })); } catch (_) {}
    window.__ROLEWORLD_FIXTURE__ = {
      characters: [{
        avatar: ${JSON.stringify(AVATAR)}, name: ${JSON.stringify(NAME)},
        description: "用于存档往返验收的合成角色。", personality: "平静", scenario: "一间空房间",
        first_mes: "你好。", mes_example: "", spec: "chara_card_v3", spec_version: "3.0",
        data: { name: ${JSON.stringify(NAME)}, description: "用于存档往返验收的合成角色。", personality: "平静",
                scenario: "一间空房间", first_mes: "你好。", mes_example: "", tags: ["合成"] }
      }],
      worlds: [],
      settings: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash", tutorial_seen: true }
    };
  })();`;
  await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixture });

  const evaluate = async (expression) => {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) {
      throw new Error("页面脚本异常：" + (out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text));
    }
    return out.result.value;
  };
  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时：" + expression);
      await sleep(200);
    }
  };
  const goto = async (url) => {
    await cdp.sessionSend(session, "Page.navigate", { url });
    for (let i = 0; i < 120; i += 1) {
      await sleep(150);
      try { if (await evaluate("document.readyState === 'complete'")) return; } catch (_) { /* 导航中 */ }
    }
    throw new Error("页面加载超时");
  };
  const open = async () => {
    await goto(base + "/index.html?onboarding=off&surprise=off");
    await waitFor("window.TASK21_READY === true", 40000);
  };
  const send = async (text) => {
    // 先记下当前行数：点完发送要等**新的两条**（用户 + 回复）都出现，
    // 再等发送键回到空闲 —— 只等"空闲"会在点击与 busy 之间抢跑，
    // 下一句就被 liveState.pending 挡掉了（本用例第一版就踩了这个）。
    const before = await evaluate("document.querySelectorAll('#dynamicMessages .message-row').length");
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor(`document.querySelectorAll('#dynamicMessages .message-row').length >= ${before + 2}`, 30000);
    await waitFor("document.querySelector('#sendButton').disabled === false && document.querySelector('#sendButton').dataset.mode === 'send'", 30000);
  };
  const queueReply = (text) => { state.replyQueue.push(text); };

  /** 把当前库里的对话完整读出来（消息内容 + 版本 + 选中项），用于"导入前后一比一"。 */
  const snapshot = () => evaluate(`(async () => {
    const rows = await window.STApi.listChats(${JSON.stringify(AVATAR)});
    const list = Array.isArray(rows) ? rows : [];
    const chats = [];
    for (const row of list) {
      const fileName = row.fileName || row.file_name || row.id || '';
      if (!fileName) continue;
      let lines = [];
      try { lines = await window.STApi.getChat(${JSON.stringify(AVATAR)}, fileName) || []; } catch (_) { lines = []; }
      const messages = (Array.isArray(lines) ? lines : [])
        .filter((line) => line && typeof line.mes === 'string')
        .map((line) => ({
          isUser: line.is_user === true,
          mes: line.mes,
          swipes: Array.isArray(line.swipes) ? line.swipes.slice() : null,
          swipeId: Number.isInteger(line.swipe_id) ? line.swipe_id : 0,
        }));
      chats.push({ fileName, messages });
    }
    chats.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return { chatCount: chats.length, chats };
  })()`);

  const zipPath = () => {
    const files = fs.readdirSync(downloadDir).filter((name) => name.endsWith(".zip"));
    return files.length ? path.join(downloadDir, files[0]) : "";
  };

  try {
    console.log("== 存档往返（真实界面导出 → 干净环境导入）==");
    await open();
    const activeName = await evaluate("(document.querySelector('#topbarTitle') || {}).textContent || ''");
    assert(activeName.indexOf("合成角色A") >= 0, "当前角色应当是合成角色（本套件不装内容包），实际是：" + activeName);

    // ---------- 一、用界面造出要验收的三样数据 ----------
    // ① 一条有两个版本的回复，并**选中非默认的那一版**（第 1 版）。
    queueReply("回复甲");
    await send("第一句：版本测试");
    await waitFor("document.querySelectorAll('#dynamicMessages .message-row-assistant').length >= 1", 15000);
    queueReply("回复乙");
    await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant'));
      const row = rows[rows.length - 1];
      window.TASK21.regenerateReply(Number(row.dataset.messageIndex));
      return true;
    })()`);
    await waitFor("document.querySelectorAll('#dynamicMessages .message-version-label').length >= 1", 30000);
    // 重新回答之后默认停在最新一版（2/2）；这里切回第 1 版 —— 也就是"非默认版本"。
    await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('#dynamicMessages .message-row-assistant')).pop();
      row.querySelector(".message-version-step[data-version-step='-1']").click();
      return true;
    })()`);
    await waitFor("(document.querySelector('#dynamicMessages .message-version-label') || {}).textContent === '1 / 2'", 10000);

    // ② 继续聊两句，供"编辑之后继续聊"和"从这里开分支"用。
    queueReply("回复丙");
    await send("第二句：分支起点");
    queueReply("回复丁");
    await send("第三句：编辑之后");
    await waitFor("document.querySelectorAll('#dynamicMessages .message-row').length >= 6", 15000);

    const beforeBranch = await snapshot();
    const originalFile = beforeBranch.chats[0] && beforeBranch.chats[0].fileName;

    // ③ 从"第二句：分支起点"那条消息开分支，并在分支里说一句独有的内容。
    const branch = await evaluate(`(async () => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row'));
      const target = rows.find((row) => (row.textContent || '').indexOf('第二句：分支起点') >= 0);
      const index = Number(target.dataset.messageIndex);
      const okBranch = await window.TASK21.branchFromMessage(index);
      await new Promise((r) => setTimeout(r, 900));
      return { ok: okBranch, index };
    })()`);
    assert(branch.ok === true, "开分支失败");
    queueReply("回复戊");
    await send("分支里的独有内容");

    // 回原对话，编辑最后一条用户消息，再继续聊一句。
    await evaluate(`window.TASK21.selectChat(${JSON.stringify(originalFile)})`);
    try {
      await waitFor("document.querySelectorAll('#dynamicMessages .message-row').length >= 6", 15000);
    } catch (_) {
      const diag = await evaluate(`({
        rows: document.querySelectorAll('#dynamicMessages .message-row').length,
        tail: (document.querySelector('#dynamicMessages').textContent || '').slice(-120),
        title: (document.querySelector('#topbarTitle') || {}).textContent || '',
        chats: (window.__rwChatFiles || []).length,
      })`);
      throw new Error("切回原对话之后行数不对：" + JSON.stringify(diag));
    }
    const edited = await evaluate(`(async () => {
      const rows = Array.from(document.querySelectorAll('#dynamicMessages .message-row-user'));
      const row = rows[rows.length - 1];
      return window.TASK21.editMessageText(Number(row.dataset.messageIndex), '第三句：改过之后');
    })()`);
    assert(edited === true, "编辑最后一条用户消息失败");
    queueReply("回复己");
    await send("第四句：编辑之后继续聊");

    const before = await snapshot();
    assert(before.chatCount === 2, "合成数据应当正好两段对话（原对话 + 分支），实际 " + before.chatCount);
    const original = before.chats.find((chat) => chat.fileName === originalFile);
    const branchChat = before.chats.find((chat) => chat.fileName !== originalFile);
    assert(original && branchChat, "找不到原对话或分支");
    const versioned = original.messages.filter((message) => message.swipes && message.swipes.length > 1);
    assert(versioned.length === 1, "原对话里应当正好一条多版本消息，实际 " + versioned.length);
    assert(versioned[0].swipeId === 0, "合成数据里选中的应当是第 1 版（非默认），实际 swipe_id=" + versioned[0].swipeId);
    assert(original.messages.some((message) => message.mes === "第三句：改过之后"), "编辑后的内容没落盘");
    assert(branchChat.messages.some((message) => message.mes === "分支里的独有内容"), "分支里没有那句独有内容");
    assert(!original.messages.some((message) => message.mes === "分支里的独有内容"), "分支的内容混进了原对话");

    // ---------- 二、真实界面：导出存档 ----------
    await evaluate(`document.querySelector('[data-action="open-settings"]').click()`);
    await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
    await evaluate(`(() => {
      const button = document.querySelector('[data-roleworld="export"]');
      button.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    })()`);
    let zip = "";
    for (let i = 0; i < 40 && !zip; i += 1) { await sleep(250); zip = zipPath(); }
    ok("① 点界面上的「导出存档」真的落下一个 .zip", !!zip, zip ? "" : "下载目录里没有 zip：" + downloadDir);
    if (zip) {
      const size = fs.statSync(zip).size;
      ok("   存档不是空文件", size > 200, "大小 " + size + " 字节");
    }
    const status = await evaluate("document.querySelector('[data-roleworld=\"archive-status\"]').textContent");
    ok("   界面上给出了导出结果", /已导出/.test(status), status);

    // ---------- 三、干净环境导入 ----------
    // 用应用自己的"清空本机数据"路径把库清干净（合成环境里做，不碰任何真实数据）。
    await evaluate(`(async () => { await window.RoleWorld.resetAll(); return true; })()`);
    await open();
    const cleared = await snapshot();
    ok("② 清空之后库里没有对话（干净环境）", cleared.chatCount === 0, JSON.stringify(cleared));

    // 真点界面上的「导入存档」。界面上那颗按钮会临时造一个 <input type=file> 并 .click() 打开
    // 系统对话框 —— 无头环境里没有对话框，所以这里只把"打开对话框"这一步换掉：
    // 让那个 input 留在 DOM 里，由 CDP 直接把导出的 zip 设进去，之后 change 事件走的
    // 仍然是应用自己的导入代码（和真人点完选文件完全同一条路）。
    await evaluate(`(() => {
      const raw = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') {
          this.hidden = true;
          this.id = 'rw-import-probe';
          document.body.appendChild(this);
          return;
        }
        return raw.apply(this, arguments);
      };
      return true;
    })()`);
    await evaluate(`(() => {
      const button = document.querySelector('[data-roleworld="import"]');
      button.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    })()`);
    await waitFor("!!document.querySelector('#rw-import-probe')", 10000);
    ok("③ 点「导入存档」后应用自己造出了文件选择框（界面路径）", true);
    const doc = await cdp.sessionSend(session, "DOM.getDocument", {});
    const found = await cdp.sessionSend(session, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#rw-import-probe" });
    assert(found && found.nodeId, "找不到导入用的文件输入框");
    await cdp.sessionSend(session, "DOM.setFileInputFiles", { files: [zip], nodeId: found.nodeId });
    // 导入是异步的，完成后应用会自己 reload。TASK21_READY 在旧页面上**本来就是 true**，
    // 只等它会在导入写完之前就往下走（本用例第一版就踩了这个，快照拿到 0 段对话）。
    // 所以在页面上留一个标记：它消失 = 真的换过一次文档，再等数据到位。
    await evaluate("window.__rwImportPending = true; true");
    await waitFor("!window.__rwImportPending", 40000);
    await waitFor("window.TASK21_READY === true", 40000);
    await waitFor(`(async () => {
      const rows = await window.STApi.listChats(${JSON.stringify(AVATAR)});
      return Array.isArray(rows) && rows.length > 0;
    })()`, 20000);
    const after = await snapshot();

    // ---------- 四、逐条核对 ----------
    ok("④ 对话段数与导入前一致（原对话 + 分支都在）",
      after.chatCount === before.chatCount,
      "导入前 " + before.chatCount + "，导入后 " + after.chatCount);

    const sameMessages = JSON.stringify(after.chats.map((chat) => chat.messages.map((m) => [m.isUser, m.mes])))
      === JSON.stringify(before.chats.map((chat) => chat.messages.map((m) => [m.isUser, m.mes])));
    ok("⑤ 消息内容、顺序、数量完全一致（不重复、不丢失）", sameMessages,
      JSON.stringify({
        before: before.chats.map((chat) => chat.messages.length),
        after: after.chats.map((chat) => chat.messages.length),
      }));

    const versionsEqual = JSON.stringify(after.chats.map((chat) => chat.messages.map((m) => [m.swipes, m.swipeId])))
      === JSON.stringify(before.chats.map((chat) => chat.messages.map((m) => [m.swipes, m.swipeId])));
    ok("⑥ 回复版本全部保留，且当前选中的版本正确", versionsEqual,
      JSON.stringify({
        before: before.chats.map((chat) => chat.messages.filter((m) => m.swipes).map((m) => m.swipes.length + "@" + m.swipeId)),
        after: after.chats.map((chat) => chat.messages.filter((m) => m.swipes).map((m) => m.swipes.length + "@" + m.swipeId)),
      }));

    const afterOriginal = after.chats.find((chat) => chat.fileName === originalFile);
    const afterBranch = after.chats.find((chat) => chat.fileName !== originalFile);
    ok("⑦ 分支还在，且内容与来源关系正确",
      !!afterBranch
      && afterBranch.messages.some((message) => message.mes === "分支里的独有内容")
      && afterOriginal
      && !afterOriginal.messages.some((message) => message.mes === "分支里的独有内容")
      && afterBranch.messages.length < afterOriginal.messages.length,
      JSON.stringify({
        branch: afterBranch ? afterBranch.messages.length : null,
        original: afterOriginal ? afterOriginal.messages.length : null,
      }));

    // 继续聊一句：请求里必须用"选中的那一版"，而且不能混入分支的内容。
    state.requests.length = 0;
    queueReply("回复庚");
    await send("第五句：导入之后继续聊");
    const sent = state.requests.filter((row) => row.stream === true);
    const context = sent.length ? sent[sent.length - 1].all : "";
    ok("⑧ 导入后还能继续聊（请求用的是选中的第 1 版）",
      context.indexOf("回复甲") >= 0 && context.indexOf("回复乙") < 0,
      "含甲=" + (context.indexOf("回复甲") >= 0) + " 含乙=" + (context.indexOf("回复乙") >= 0));
    ok("⑨ 请求里没有混入分支的内容",
      context.indexOf("分支里的独有内容") < 0 && context.indexOf("回复戊") < 0,
      "含分支独有内容=" + (context.indexOf("分支里的独有内容") >= 0));

    const afterChat = await snapshot();
    const afterChatOriginal = afterChat.chats.find((chat) => chat.fileName === originalFile);
    ok("⑩ 新聊的这一轮落在原对话里（没写进分支）",
      !!afterChatOriginal
      && afterChatOriginal.messages.some((message) => message.mes === "第五句：导入之后继续聊")
      && !afterChat.chats.find((chat) => chat.fileName !== originalFile).messages.some((message) => message.mes === "第五句：导入之后继续聊"),
      JSON.stringify(afterChat.chats.map((chat) => chat.messages.length)));

    // ---------- 五、再刷新一次 ----------
    await open();
    const reloaded = await snapshot();
    const stable = JSON.stringify(reloaded.chats.map((chat) => chat.messages.map((m) => [m.isUser, m.mes, m.swipeId, m.swipes ? m.swipes.length : 0])))
      === JSON.stringify(afterChat.chats.map((chat) => chat.messages.map((m) => [m.isUser, m.mes, m.swipeId, m.swipes ? m.swipes.length : 0])));
    ok("⑪ 再刷新一次之后，以上状态仍然正确", stable,
      JSON.stringify({ chats: reloaded.chatCount, versions: reloaded.chats.map((chat) => chat.messages.filter((m) => m.swipes).map((m) => m.swipes.length + "@" + m.swipeId)) }));

    // 存档格式确认（给交付报告用）：导出与导入用的是同一份结构。
    const format = await evaluate(`(async () => {
      const dump = await window.RoleWorld.exportArchive();
      return { format: dump.format, version: dump.version, hasData: !!dump.data, keys: Object.keys(dump.data || {}).length };
    })()`);
    ok("⑫ 存档格式未改动（roleworld-archive v" + format.version + "）",
      format.format === "roleworld-archive" && format.version === 1 && format.hasData,
      JSON.stringify(format));
  } catch (error) {
    failures += 1;
    console.log("  FAIL  用例自身出错：" + (error && error.message ? error.message : String(error)));
  } finally {
    server.close();
    try { chrome.proc.kill(); } catch (_) {}
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}
    console.log("");
    console.log(failures
      ? `ARCHIVE_ROUNDTRIP=${results - failures}/${results}（有 ${failures} 项不达标）`
      : `ARCHIVE_ROUNDTRIP=${results}/${results}`);
    process.exit(failures ? 1 : 0);
  }
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
