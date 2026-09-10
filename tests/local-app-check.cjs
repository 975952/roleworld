"use strict";

/*
 * local-app-check.cjs —— 本地模式端到端回归（无 SillyTavern、无外网）
 *
 * 起一个静态服务器托管 app/ 与 packs/，再起一个假的 OpenAI 兼容模型端点，
 * 用无头 Chrome 真正打开三个页面，验证：
 *   1. 对话页能启动（没有登录跳转、没有遮罩、输入框可用）
 *   2. 发送消息能拿到流式回复并落到界面上；思考模式默认关闭且不显示思维链
 *   3. 剧情模式页能读角色与记忆书
 *   4. 内容包自动安装 / 停用后空库仍可启动
 *   5. 设置面板能读写本机模型配置与密钥
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { CDP, launchChrome, sleep } = require("./cdp.js");

const APP = path.join(__dirname, "..", "app");
const PACKS = path.join(__dirname, "..", "packs");
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => candidate && fs.existsSync(candidate)) || "";
const REPLY = "合成回复：你好，我是本地模型。";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function startServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 保持空对象 */ }
      requests.push({
        path: p, stream: body.stream === true, model: body.model,
        auth: req.headers.authorization || "", include_reasoning: body.include_reasoning,
      });
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        // 先给两段思维链：思考模式关闭时它们必须一个都不显示。
        for (const thought of ["思考中甲", "思考中乙"]) {
          res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta: { reasoning_content: thought } }] }) + "\n\n");
        }
        const pieces = ["合成回复：", "你好，", "我是本地模型。"];
        for (const piece of pieces) {
          res.write("data: " + JSON.stringify({ model: body.model || "synthetic", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: body.model || "synthetic", choices: [{ message: { role: "assistant", content: REPLY }, finish_reason: "stop" }] }));
      return;
    }

    if (p === "/__requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(requests));
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

const results = [];
let failures = 0;

async function check(name, fn) {
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log("找不到 Chrome：" + CHROME + "（可用 CHROME_PATH 指定）");
    process.exitCode = 1;
    return;
  }

  const { server, port, requests } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9411 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);

  const fixture = `
    (function () {
      try {
        localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-v4-flash" }));
        sessionStorage.setItem("task27a.current-account-handle.v1", "local");
      } catch (_) {}
      window.__ROLEWORLD_FIXTURE__ = {
        characters: [
          { avatar: "Harry Potter (EN).png", name: "Harry Potter", description: "被选中的男孩。",
            personality: "勇敢", scenario: "霍格沃茨", first_mes: "你好。", mes_example: "",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "Harry Potter", description: "被选中的男孩。", personality: "勇敢",
                    scenario: "霍格沃茨", first_mes: "你好。", mes_example: "", tags: [] } },
          { avatar: "Hermione Granger (EN).png", name: "Hermione Granger", description: "最聪明的女巫。",
            first_mes: "你好。", spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "Hermione Granger", description: "最聪明的女巫。", first_mes: "你好。", tags: [] } }
        ],
        worlds: [
          { name: "MB Harry — fact clips (EN)", entries: {
            "0": { uid: 0, key: ["哈利"], keysecondary: [], comment: "测试条目", content: "合成记忆内容", disable: false, constant: false } } }
        ],
        settings: {
          provider: "deepseek",
          endpoint: "${base}/v1/chat/completions",
          model: "deepseek-v4-flash"
        }
      };
    })();
  `;

  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");
  const fixtureScript = await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixture });

  async function evaluate(expression) {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error("页面脚本异常：" + (out.exceptionDetails.exception && out.exceptionDetails.exception.description
        || out.exceptionDetails.text));
    }
    return out.result.value;
  }

  async function goto(url) {
    await cdp.sessionSend(session, "Page.navigate", { url });
    for (let i = 0; i < 100; i += 1) {
      await sleep(150);
      try {
        const ready = await evaluate("document.readyState === 'complete'");
        if (ready) return;
      } catch (_) { /* 导航中 */ }
    }
    throw new Error("页面加载超时：" + url);
  }

  // 页面脚本一旦抛错，这里能直接把原始错误打出来，省得靠猜。
  function pageErrors() {
    const out = [];
    cdp.events.forEach((event) => {
      if (event.method === "Runtime.exceptionThrown") {
        const details = event.params && event.params.exceptionDetails;
        out.push("EXCEPTION: " + (details && details.exception && details.exception.description || (details && details.text) || "unknown"));
      } else if (event.method === "Runtime.consoleAPICalled" && event.params && event.params.type === "error") {
        out.push("CONSOLE: " + (event.params.args || []).map((arg) => arg.value || arg.description || "").join(" "));
      }
    });
    cdp.events.length = 0;
    return out;
  }

  function reportErrors(label) {
    const errors = pageErrors();
    if (errors.length) {
      console.log("  ---- " + label + " 页面报错 ----");
      errors.slice(0, 8).forEach((line) => console.log("  " + line.slice(0, 300)));
    }
  }

  async function waitFor(expression, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) throw new Error("等待超时：" + expression);
      await sleep(200);
    }
  }

  console.log("== 角色对话页 ==");

  await goto(base + "/index.html");
  // 必须等这次启动彻底落定再清库：安装内容包是启动过程的一部分，
  // 半途 reset 会和它抢写，留下一个装了一半的库。
  await waitFor("window.TASK21_READY === true", 30000);

  // 清库并停用内置包，让 fixture 阶段的角色数量是确定的。
  await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); await RoleWorldPacks.setEnabled('harry-potter', false); return true; })()");
  await goto(base + "/index.html");

  // 摘掉 theme-pending 是 bootLive 的最后一步，用它当"启动完成"信号最可靠。
  await waitFor("window.TASK21_READY === true", 30000);
  reportErrors("index.html");

  await check("页面留在 index.html，没有跳转到登录页", async () => {
    const href = await evaluate("location.pathname");
    assert(href.endsWith("/index.html"), "被跳转到了 " + href);
  });

  await check("启动遮罩已摘除，登录门与模板门都隐藏", async () => {
    const gate = await evaluate(`(() => {
      const node = document.querySelector('#chatTemplateGate');
      const message = document.querySelector('#chatTemplateGateMessage');
      return { hidden: node.hidden, text: message ? message.textContent : '' };
    })()`);
    assert(await evaluate("!document.documentElement.classList.contains('theme-pending')"), "theme-pending 仍存在（灰屏）");
    assert(await evaluate("document.querySelector('#authGate').hidden === true"), "#authGate 仍然可见");
    assert(gate.hidden === true, "#chatTemplateGate 显示：" + gate.text);
  });

  await check("角色与记忆书从本机数据库读出", async () => {
    const counts = await evaluate("(async () => ({ c: (await RoleWorld.store.listCharacters()).length, w: (await RoleWorld.store.listWorlds()).length, names: (await RoleWorld.store.listCharacters()).map((x) => x.avatar), books: (await RoleWorld.store.listWorlds()).map((x) => x.name) }))()");
    if (counts.c !== 2) reportErrors("index.html");
    assert(counts.c === 2, "角色数量应为 2，实际 " + counts.c + "：" + JSON.stringify(counts.names) + " / 书：" + JSON.stringify(counts.books));
    assert(counts.w === 1, "记忆书数量应为 1，实际 " + counts.w + "：" + JSON.stringify(counts.books));
  });

  await check("输入框可用（说明角色卡、端点、会话三个条件都满足）", async () => {
    assert(await evaluate("document.querySelector('#messageInput').disabled === false"), "输入框被禁用");
    assert(await evaluate("document.querySelector('#sendButton').disabled === false"), "发送按钮被禁用");
  });

  await check("发送消息能收到流式回复", async () => {
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '你好';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor(`document.querySelector('#dynamicMessages').textContent.indexOf('我是本地模型') >= 0`, 20000);
  });

  await check("模型请求走的是本机配置的端点，并且带了流式标记", async () => {
    const sent = requests.filter((row) => row.stream === true);
    assert(sent.length >= 1, "没有收到流式请求");
    // 模型名以「设置 → 模型」里填的为准，不再由下拉框里的固定选项决定。
    assert(sent[sent.length - 1].model === "deepseek-v4-flash", "模型名不对：" + sent[sent.length - 1].model);
  });

  await check("顶栏可以直接切换模型，并且写回同一份配置", async () => {
    const current = await evaluate("(document.querySelector('#chatModelSelect') || {}).value");
    assert(current === "deepseek-v4-flash", "顶栏当前值不对：" + current);
    assert(await evaluate("document.querySelector('#chatDeepseekKeyInput') === null"), "对话页仍有重复的密钥输入框");
    const options = await evaluate("Array.from(document.querySelectorAll('#chatModelSelect option')).map((o) => o.value)");
    assert(options.indexOf("deepseek-v4-pro") >= 0, "已知型号没列出来：" + JSON.stringify(options));
    assert(options.indexOf("__custom__") >= 0, "缺少「自定义模型名…」入口");

    await evaluate(`(() => {
      const select = document.querySelector('#chatModelSelect');
      select.value = 'deepseek-v4-pro';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(document.querySelector('[data-roleworld=\"model\"]') || {}).value === 'deepseek-v4-pro'", 8000);

    await evaluate(`(() => {
      const select = document.querySelector('#chatModelSelect');
      select.value = 'deepseek-v4-flash';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor("(document.querySelector('[data-roleworld=\"model\"]') || {}).value === 'deepseek-v4-flash'", 8000);
  });

  await check("对话界面显示 token 用量与费用估算", async () => {
    await waitFor("(document.querySelector('#chatCostLine') || {}).textContent.length > 0", 8000);
    const line = await evaluate("document.querySelector('#chatCostLine').textContent");
    assert(/本对话 \d+ 轮/.test(line), "费用行没有轮次：" + line);
    assert(/输入 [\d.]+k? \/ 输出 [\d.]+k? tokens/.test(line), "费用行没有 token 用量：" + line);
    assert(/累计 [≈]?¥[\d.]+/.test(line), "费用行没有金额：" + line);
    assert(/输出 ¥[\d.]+\/M（(高峰|闲时)）/.test(line), "费用行没带单价与峰谷：" + line);
  });

  await check("思考模式默认关闭：思维链既不显示也不请求", async () => {
    const sent = requests.filter((row) => row.stream === true);
    assert(sent[sent.length - 1].include_reasoning === false,
      "请求里 include_reasoning 应为 false，实际 " + JSON.stringify(sent[sent.length - 1].include_reasoning));
    const text = await evaluate("document.querySelector('#dynamicMessages').textContent");
    assert(text.indexOf("思考中") < 0, "界面上还是出现了思维链：" + text.slice(0, 120));
  });

  await check("打开思考模式后请求会要求回传思维链", async () => {
    await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    await evaluate(`(() => {
      const toggle = document.querySelector('[data-roleworld="thinking"]');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('#messageInput');
      input.value = '再问一次';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor("document.querySelector('#dynamicMessages').textContent.split('我是本地模型').length > 2", 20000);
    const sent = requests.filter((row) => row.stream === true);
    assert(sent[sent.length - 1].include_reasoning === true,
      "打开后应为 true，实际 " + JSON.stringify(sent[sent.length - 1].include_reasoning));
    // 恢复默认，免得影响后面的页面
    await waitFor("document.querySelector('#sendButton').disabled === false", 15000);
    await evaluate(`(() => {
      const toggle = document.querySelector('[data-roleworld="thinking"]');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  });

  await check("设置面板能读到本机模型配置", async () => {
    const value = await evaluate("document.querySelector('[data-roleworld=\"endpoint\"]').value");
    assert(value === base + "/v1/chat/completions", "端点显示为 " + value);
  });

  await check("账号相关入口不可见", async () => {
    const visible = await evaluate(`(() => {
      const result = { hidden: [], rows: [] };
      const card = document.querySelector('#selfDeleteCard');
      if (card && !card.hidden && !card.closest('[hidden]')) result.hidden.push('#selfDeleteCard');
      const wrong = ['#settings-admin-users', '#adminAssistantLink'].filter((id) => {
        const node = document.querySelector(id);
        return node && !node.hidden && !node.closest('[hidden]') && id === '#settings-admin-users';
      });
      Array.from(document.querySelectorAll('[data-action="open-rename"],[data-action="open-password"],[data-action="open-logout"],[data-action="open-self-delete"]'))
        .forEach((row) => {
          if (!row.hidden && !row.closest('[hidden]')) result.rows.push(row.dataset.action);
        });
      result.wrong = wrong;
      return result;
    })()`);
    assert(visible.hidden.length === 0, "仍然可见：" + visible.hidden.join(","));
    assert(visible.rows.length === 0, "仍然可见的账号按钮：" + visible.rows.join(","));
    assert(visible.wrong.length === 0, "仍然可见的管理面板：" + visible.wrong.join(","));
  });

  await check("首次启动会弹出教程，跳过之后不再出现", async () => {
    await waitFor("!!document.querySelector('.rw-onboard-backdrop')", 15000);
    const first = await evaluate("document.querySelector('.rw-onboard h2').textContent");
    assert(first.indexOf("欢迎") >= 0, "教程首页标题是：" + first);
    const steps = await evaluate("document.querySelectorAll('.rw-onboard-dots i').length");
    assert(steps >= 4, "教程步骤太少：" + steps);

    await evaluate("document.querySelector('[data-rw=\"skip\"]').click()");
    await waitFor("!document.querySelector('.rw-onboard-backdrop')", 5000);

    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("new Promise((r) => setTimeout(r, 2000))");
    assert(await evaluate("!document.querySelector('.rw-onboard-backdrop')"), "跳过之后重载又弹了一次");
  });

  await check("设置 → 关于里的「再看一次教程」能重新打开", async () => {
    await evaluate("document.querySelector('[data-roleworld=\"tutorial\"]').click()");
    await waitFor("!!document.querySelector('.rw-onboard-backdrop')", 5000);
    await evaluate("document.querySelector('[data-rw=\"next\"]').click()");
    const second = await evaluate("document.querySelector('.rw-onboard h2').textContent");
    assert(second.indexOf("欢迎") < 0, "「下一步」没有翻页，标题还是：" + second);
    await evaluate("document.querySelector('[data-rw=\"skip\"]').click()");
    await waitFor("!document.querySelector('.rw-onboard-backdrop')", 5000);
  });

  console.log("== 剧情模式页 ==");

  await goto(base + "/magic-map.html");

  await check("剧情模式页正常启动并可读取角色", async () => {
    await waitFor("document.querySelector('#castMeta') && document.querySelector('#castMeta').textContent.indexOf('正在读取') < 0", 20000);
    const names = await evaluate("document.querySelector('#castMeta').textContent");
    assert(names.length > 0, "演职员信息为空");
  });

  await check("剧情模式没有跳转到登录页", async () => {
    const href = await evaluate("location.pathname");
    assert(href.endsWith("/magic-map.html"), "被跳转到了 " + href);
  });

  console.log("== 内置内容包（packs/harry-potter）==");

  await check("内容包在首次启动时自动安装，角色卡自带立绘", async () => {
    await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
    await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: "window.__ROLEWORLD_FIXTURE__ = null;" });
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    await evaluate("(async () => { await RoleWorld.init(); await RoleWorld.resetAll(); return true; })()");
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    reportErrors("内置包 index.html");

    const state = await evaluate(`(async () => {
      const cards = await RoleWorld.store.listCharacters();
      const worlds = await RoleWorld.store.listWorlds();
      return {
        characters: cards.map((card) => card.avatar).sort(),
        books: worlds.map((world) => world.name).sort(),
        avatars: await Promise.all(cards.map((card) => RoleWorld.store.getBlob("avatar:" + card.avatar).then((b) => (b ? b.size : 0)))),
        pickerHidden: document.querySelector('#characterPicker').hidden,
        pickerName: (document.querySelector('#characterPickerName') || {}).textContent || '',
        composer: document.querySelector('#messageInput').disabled === false,
      };
    })()`);

    assert(state.characters.length === 6, "应装入 6 个角色，实际 " + state.characters.length + "：" + JSON.stringify(state.characters) + " / 书：" + JSON.stringify(state.books));
    assert(state.characters.indexOf("Harry Potter (EN).png") >= 0, "缺少默认角色 Harry Potter (EN).png");
    assert(state.books.length === 4, "应装入 4 本记忆书，实际 " + state.books.length);
    ["MB Harry — fact clips (EN)", "MB Harry — relationship tracker (EN)",
      "MB Harry — role lock (EN)", "MB Harry — scene memories (EN)"].forEach((name) => {
      assert(state.books.indexOf(name) >= 0, "缺少记忆书：" + name);
    });
    assert(state.avatars.every((size) => size > 1000), "有角色卡丢了立绘：" + JSON.stringify(state.avatars));
    assert(state.pickerHidden === false, "角色选择器没有显示出来");
    assert(state.pickerName.indexOf("Harry Potter") === 0, "默认角色选择错了：" + state.pickerName);
    assert(state.composer, "装了内置包之后输入框仍然不可用");
  });

  console.log("== 空库（停用内容包后的状态）==");

  await check("一本角色卡都没有时给出空状态，而不是把整页打挂", async () => {
    await evaluate(`(async () => {
      await RoleWorld.init();
      await RoleWorld.resetAll();
      await RoleWorldPacks.setEnabled("harry-potter", false);
      return true;
    })()`);
    await goto(base + "/index.html");
    await waitFor("window.TASK21_READY === true", 30000);
    reportErrors("空库 index.html");
    const state = await evaluate(`(() => ({
      gate: document.querySelector('#chatTemplateGate').hidden,
      auth: document.querySelector('#authGate').hidden,
      disabled: document.querySelector('#messageInput').disabled,
      text: document.body.textContent.indexOf('还没有角色卡') >= 0,
    }))()`);
    assert(state.gate, "模板门显示了错误，说明空库启动失败");
    assert(state.auth, "登录门显示了错误");
    assert(state.disabled, "没有角色卡时输入框仍可用");
    assert(state.text, "没有看到空状态提示");
  });

  cdp.close();
  chrome.proc.kill();
  server.close();

  console.log("");
  const passed = results.filter((row) => row.ok).length;
  console.log(`LOCAL_APP=${passed}/${results.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("测试运行失败：", error);
  process.exitCode = 1;
});
