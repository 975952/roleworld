"use strict";

/*
 * viewport-check.cjs —— 多视口布局回归（自带静态服务与假模型端点，不联网）
 *
 * 为什么单独一套：本项目 UI 迭代很频繁，而"窄屏能不能用"以前只有 1280 / 360 两个点、
 * 且要外部先起服务。这里自己起服务、覆盖手机到桌面五个视口，盯的是**能不能用**而不是好不好看：
 *
 *   - 页面不许横向溢出（最常见的移动端毛病）
 *   - 「本次请求」弹层：在视口内、内容可滚动、关闭按钮可达可点
 *   - 「角色记忆」面板：同上
 *   - 消息旁的「记错 / 编造」按钮：触屏上要够大好点（命中区 ≥ 44px 高）
 *   - 输入框不能被压到看不见、发送键必须在视口内
 *
 * 用法：node tests/viewport-check.cjs
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
].find((candidate) => { try { return fs.existsSync(candidate); } catch (_) { return false; } });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const VIEWPORTS = [
  { label: "桌面 1440×900", width: 1440, height: 900 },
  { label: "笔记本 1280×800", width: 1280, height: 800 },
  { label: "平板 768×1024", width: 768, height: 1024 },
  { label: "手机 390×844", width: 390, height: 844 },
  { label: "小手机 320×568", width: 320, height: 568 },
];

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);

    if (p === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { /* 空请求体 */ }
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        for (const piece of ["收到了。", "这是一条用于布局回归的回复。"]) {
          res.write("data: " + JSON.stringify({ model: "synthetic", choices: [{ delta: { content: piece } }] }) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "synthetic", choices: [{ message: { role: "assistant", content: "收到了。" }, finish_reason: "stop" }] }));
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
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
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
  if (!CHROME) {
    console.log("找不到 Chrome/Edge，可用 CHROME_PATH 指定");
    process.exitCode = 1;
    return;
  }
  const { server, port } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9418 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");

  const fixture = `
    (function () {
      try { localStorage.setItem("task22.chat-model.v1.local", JSON.stringify({ mode: "deepseek-flash" })); } catch (_) {}
      window.__ROLEWORLD_FIXTURE__ = {
        characters: [
          { avatar: "布局测试角色.png", name: "布局测试角色", description: "用于布局回归的合成角色。",
            personality: "平静", scenario: "测试场景", first_mes: "你好。", mes_example: "",
            spec: "chara_card_v3", spec_version: "3.0",
            data: { name: "布局测试角色", description: "用于布局回归的合成角色。", personality: "平静",
                    scenario: "测试场景", first_mes: "你好。", mes_example: "", tags: [] } }
        ],
        worlds: [],
        settings: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash",
                    // 引导浮层（.rw-ob）是固定定位、盖满整屏的：不跳过它，量到的是"被盖住的界面"，
                    // 真人那时候什么都点不到。布局回归要量真正能用的那一层。
                    tutorial_seen: true }
      };
    })();
  `;
  const fixtureScript = await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixture });

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

  const setViewport = (viewport) => cdp.sessionSend(session, "Emulation.setDeviceMetricsOverride", {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 500,
  });

  const open = async (viewport) => {
    await setViewport(viewport);
    await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html?onboarding=off&surprise=off" });
    await waitFor("window.TASK21_READY === true", 30000);
  };

  // 发一轮消息：让消息行、标记按钮、台账都有内容
  const sendOnce = async () => {
    await evaluate(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = '布局回归用的一句话';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      return true;
    })()`);
    await waitFor(`(() => {
      const send = document.querySelector('#sendButton');
      const input = document.querySelector('#messageInput');
      return !!send && send.disabled === false && send.dataset.mode === 'send' && !!input && input.disabled === false;
    })()`, 25000);
  };

  // 通用布局体检：横向溢出 + 关键控件是否可见
  const layoutProbe = () => evaluate(`(() => {
    const doc = document.documentElement;
    const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
    const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      overflow,
      input: box('#messageInput'),
      send: box('#sendButton'),
      sendDiag: (() => {
        const n = document.querySelector('#sendButton');
        if (!n) return { missing: true };
        const style = getComputedStyle(n);
        return { hidden: n.hidden, display: style.display, visibility: style.visibility, mode: n.dataset.mode,
          disabled: n.disabled, value: (document.querySelector('#messageInput') || {}).value,
          probe: window.__rwComposerProbe || null, cls: n.className };
      })(),
      flag: box('.message-flag'),
      flagCount: document.querySelectorAll('.message-flag').length,
    };
  })()`);

  console.log("== 多视口布局回归 ==");

  for (const viewport of VIEWPORTS) {
    await open(viewport);
    await sendOnce();

    await check(`${viewport.label}：【量尺寸】输入条与「+」面板（临时诊断）`, async () => {
      await evaluate("document.querySelector('#composerPlusButton').click(); true");
      await waitFor("document.querySelector('#composerMenu').hidden === false", 8000);
      const m = await evaluate(`(() => {
        const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
        const bar = document.querySelector('.composer-box');
        const input = document.querySelector('#messageInput');
        const plus = document.querySelector('#composerPlusButton');
        const menu = document.querySelector('#composerMenu');
        const cs = (n) => getComputedStyle(n);
        return {
          vw: window.innerWidth,
          bar: r(bar), input: r(input), plus: r(plus), menu: r(menu),
          barCss: { radius: parseFloat(cs(bar).borderTopLeftRadius), border: parseFloat(cs(bar).borderTopWidth), shadow: cs(bar).boxShadow, pad: cs(bar).padding },
          inputCss: { radius: parseFloat(cs(input).borderTopLeftRadius), pad: cs(input).padding, minH: parseFloat(cs(input).minHeight) },
          menuPos: cs(menu).position,
          gapY: Math.round(bar.getBoundingClientRect().top - menu.getBoundingClientRect().bottom),
          gapX: Math.round(menu.getBoundingClientRect().right - plus.getBoundingClientRect().right),
        };
      })()`);
      console.log("        COMPOSER " + JSON.stringify(m));
      await evaluate("document.querySelector('#composerPlusButton').click(); true");
      await waitFor("document.querySelector('#composerMenu').hidden === true", 8000);
    });

    await check(`${viewport.label}：输入框要精致（手机）/ 有电脑版的样子（桌面），且「+」面板贴着按钮`, async () => {
      // 用户 0.1.76 实测：「现在输入框像个大块头。要更精致一点，就学学微信 qq whatsapp 之类的样式和大小。
      //   电脑版的不用这样，电脑版就（要）电脑版的样子，不要和手机一样。
      //   而且现在的电脑版点 + 出来的弹窗离得有点远」。
      const mobile = viewport.width <= 760;
      await evaluate("document.querySelector('#composerPlusButton').click(); true");
      await waitFor("document.querySelector('#composerMenu').hidden === false", 8000);
      const m = await evaluate(`(() => {
        const box = (sel) => { const n = document.querySelector(sel); const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
        const bar = document.querySelector('.composer-box');
        const input = document.querySelector('#messageInput');
        const plus = document.querySelector('#composerPlusButton');
        const menu = document.querySelector('#composerMenu');
        const cs = (n) => getComputedStyle(n);
        return {
          bar: box('.composer-box'), input: box('#messageInput'), plus: box('#composerPlusButton'), menu: box('#composerMenu'),
          barRadius: parseFloat(cs(bar).borderTopLeftRadius),
          barBorder: parseFloat(cs(bar).borderTopWidth),
          barShadow: cs(bar).boxShadow,
          inputRadius: parseFloat(cs(input).borderTopLeftRadius),
          inputMinH: parseFloat(cs(input).minHeight),
          menuPosition: cs(menu).position,
          gapY: Math.round(bar.getBoundingClientRect().top - menu.getBoundingClientRect().bottom),
          gapX: Math.round(menu.getBoundingClientRect().right - plus.getBoundingClientRect().right),
        };
      })()`);
      await evaluate("document.querySelector('#composerPlusButton').click(); true");
      await waitFor("document.querySelector('#composerMenu').hidden === true", 8000);

      // ① 「+」面板必须**贴着**那颗「+」：横向偏差别超过一个按钮的宽度，
      //    桌面版纵向上要挨着输入条（不是飘在整条 shell 上面）。
      assert(Math.abs(m.gapX) <= 26,
        "「+」面板横向离按钮太远（" + m.gapX + "px）：" + JSON.stringify({ plus: m.plus, menu: m.menu }));
      if (!mobile) {
        assert(m.gapY >= 2 && m.gapY <= 16,
          "桌面版「+」面板纵向离输入条太远（" + m.gapY + "px）：" + JSON.stringify({ bar: m.bar, menu: m.menu }));
      }
      // ② 输入框不能是"大块头"
      assert(m.inputMinH <= (mobile ? 38 : 36),
        "输入框还是太高（大块头）：minHeight=" + m.inputMinH + "px");
      assert(m.inputRadius <= 8, "输入框圆角太大（不够精致）：" + m.inputRadius + "px");
      // ③ 手机与电脑**不能长得一样**
      if (mobile) {
        assert(m.bar.h <= 53, "手机输入条还是太厚：" + m.bar.h + "px");
        assert(m.barBorder === 0, "手机上不该有描边：" + m.barBorder);
      } else {
        assert(m.barBorder >= 1, "电脑版要有电脑版的样子（该有一圈极淡描边）：" + m.barBorder);
        assert(m.barRadius >= 12, "电脑版圆角与手机不该是同一档：" + m.barRadius);
        // ⚠ 这里**不**断言投影：`html[data-style="paper"] .composer-box { box-shadow: none }`
        //   是那个皮肤有意为之的（纸面要平），断投影会变成"看运气"的用例。
      }
    });

    await check(`${viewport.label}：输入条是微信式的那一行，控件都点得到`, async () => {
      // 2026-09-18 用户指定的形态：[语音(麦克风)] [输入框] [表情] [+]，右边那颗按需变成发送。
      // 这条量的是**几何**：四个控件都在输入条那一行里、彼此不重叠、中心点命中测试都落在自己身上
      // （"看得见、点不到"是这个项目里最常见的一类 bug）。
      const row = await evaluate(`(() => {
        const hit = (sel) => {
          const node = document.querySelector(sel);
          if (!node) return { sel, missing: true };
          const r = node.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return { sel, hidden: true };
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const top = document.elementFromPoint(cx, cy);
          return { sel, w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right),
            reachable: !!(top && (top === node || node.contains(top))) };
        };
        return {
          plus: hit('#composerPlusButton'),
          sticker: hit('#stickerButton'),
          rowTop: Math.round((document.querySelector('.composer-row') || { getBoundingClientRect: () => ({ top: 0 }) }).getBoundingClientRect().top),
          plusRowTop: Math.round(document.querySelector('#composerPlusButton').getBoundingClientRect().top),
          crossAxis: Math.abs(Math.round(document.querySelector('#messageInput').getBoundingClientRect().top)
            - Math.round(document.querySelector('#composerPlusButton').getBoundingClientRect().top)),
        };
      })()`);
      assert(!row.plus.missing && !row.plus.hidden, "「+」不在输入条里：" + JSON.stringify(row.plus));
      // 「+」在手机上要够大好点（与 mic / sticker 同一档 44px）。
      assert(row.plus.w >= 30 && row.plus.h >= 30, "「+」太小，手指点不准：" + JSON.stringify(row.plus));
      assert(row.plus.reachable, "「+」点不到（被别的元素盖住）：" + JSON.stringify(row.plus));
      assert(row.plusRowTop >= row.rowTop - 2, "「+」跑到输入条上面去了：" + JSON.stringify(row));
    });

    await check(`${viewport.label}：打字后发送键出现、「+」让位（发送键按需出现）`, async () => {
      const probe = await evaluate(`(() => {
        const send = document.querySelector('#sendButton');
        const plus = document.querySelector('#composerPlusButton');
        const input = document.querySelector('#messageInput');
        const box = (n) => { const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const empty = { send: send.hidden, plus: plus.hidden };
        input.value = '在吗';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const typed = { send: send.hidden, plus: plus.hidden, sendBox: box(send) };
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { empty, typed, cleared: { send: send.hidden, plus: plus.hidden } };
      })()`);
      assert(probe.empty.send === true && probe.empty.plus === false, "空着时应当只有「+」：" + JSON.stringify(probe));
      assert(probe.typed.send === false && probe.typed.plus === true, "有字时发送键必须出现、且「+」让位：" + JSON.stringify(probe));
      assert(probe.typed.sendBox.w >= 28, "出现的发送键太小：" + JSON.stringify(probe));
      assert(probe.cleared.send === true && probe.cleared.plus === false, "删空之后应当换回「+」：" + JSON.stringify(probe));
    });

    await check(`${viewport.label}：输入框随字长变高，封顶后自己滚`, async () => {
      const grow = await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        const set = (text) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); return Math.round(input.getBoundingClientRect().height); };
        const one = set('一句');
        const three = set('第二句长一点\\n第二行\\n第三行');
        // ⚠ 这段必须**足够长**（几百字在宽屏上还没到 160px 上限，量不出"封顶"）——
        //   2000 个字在五个视口上都一定超过上限。
        const many = set('长'.repeat(2000));
        const max = Math.round(parseFloat(getComputedStyle(input).maxHeight));
        // ⚠ 要在**还留着那段长文本时**读 overflowY：下面清空输入框之后它当然会变回 hidden。
        const overflowWhenFull = getComputedStyle(input).overflowY;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const overflowWhenEmpty = getComputedStyle(input).overflowY;
        return { one, three, many, max, overflowWhenFull, overflowWhenEmpty };
      })()`);
      assert(grow.three > grow.one, "输入框没有随行数变高：" + JSON.stringify(grow));
      assert(grow.many > grow.three, "输入框没有随字长继续变高：" + JSON.stringify(grow));
      assert(grow.many <= grow.max + 2, "输入框超过了 CSS 上限（会顶掉整个界面）：" + JSON.stringify(grow));
      assert(grow.overflowWhenFull === "auto" || grow.overflowWhenFull === "scroll",
        "封顶之后必须能自己滚，否则多出来的字看不见：" + JSON.stringify(grow));
      assert(grow.overflowWhenEmpty === "hidden", "短文本时不该出现滚动条：" + JSON.stringify(grow));
    });

    await check(`${viewport.label}：没有横向溢出`, async () => {
      const probe = await layoutProbe();
      const slack = viewport.width < 500 ? 2 : 4; // 亚像素容差
      assert(probe.overflow <= slack,
        `横向溢出 ${probe.overflow}px（视口 ${probe.innerWidth}）`);
    });

    await check(`${viewport.label}：输入框与发送键在视口内、可用（发送键按需出现）`, async () => {
      // 2026-09-18 用户要求「发送键按需出现」：空着的时候那一格是「+」，有字才变成发送，
      // 生成中它是「停止」。所以**空着量发送键**量不到东西 —— 先打一句草稿再量，
      // 同时钉住那条规则本身（空着时它必须在，且「+」在）。
      const afford = await evaluate(`(() => {
        const send = document.querySelector('#sendButton');
        const plus = document.querySelector('#composerPlusButton');
        const box = (n) => { const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
        return { sendHidden: send.hidden, plusHidden: plus.hidden, send: box(send), plus: box(plus) };
      })()`);
      assert(afford.sendHidden === true, "空着输入框时发送键不该出现（那一格是「+」）：" + JSON.stringify(afford));
      assert(afford.plusHidden === false && afford.plus.w >= 20 && afford.plus.h >= 20,
        "空着时「+」必须可见可点：" + JSON.stringify(afford));

      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '布局回归用的一句话';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      const probe = await layoutProbe();
      assert(probe.input && probe.input.h >= 28, "输入框高度异常：" + JSON.stringify(probe.input));
      assert(probe.send && probe.send.w >= 28, "有草稿时发送键太小或不存在：" + JSON.stringify(probe.send) + " / " + JSON.stringify(probe.sendDiag));
      assert(probe.send.bottom <= probe.innerHeight + 1, "发送键超出视口底部：" + JSON.stringify(probe.send));
      assert(probe.input.bottom <= probe.innerHeight + 1, "输入框超出视口底部：" + JSON.stringify(probe.input));
      // 输入框要**贴屏幕下侧**（用户 2026-09-18：「输入框要贴屏幕下侧」，底下那一栏已经删掉）。
      assert(probe.input.bottom >= probe.innerHeight - 90,
        "输入框离屏幕下侧太远（底下已经没有那一栏了）：" + JSON.stringify({ inputBottom: probe.input.bottom, innerHeight: probe.innerHeight }));
      // 量完把草稿清掉，别影响后面的用例。
      await evaluate(`(() => { const i = document.querySelector('#messageInput'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    });

    // 用户 2026-09-12：「文字还是会超出输入框」。
    // 中文与空格式子本来就会换行，真正会顶出去的是**一长串没有空格的**内容（长链接、英文长词、
    // 别人复制过来的一整行 base64）。四种极端草稿都量一次：输入框自己不许横向滚动，
    // 输入区盒子也不许被撑宽，页面更不许出现横向滚动条。
    //
    // 注意（2026-09-13 实测）：**光靠上面这些量法抓不到这个 bug** ——
    // Chrome 的 UA 样式表里 textarea 自带 `overflow-wrap: break-word`，长词本来就会断；
    // 而 iOS Safari 没有这条默认值，所以用户手机上才会溢出、我在无头 Chrome 里怎么量都是 0。
    // 因此再钉一条"保险必须在"：显式声明了 overflow-wrap / word-break，
    // 谁把这两行删掉，这条用例立刻红。
    await check(`${viewport.label}：输入框里的长文本不会溢出（长词 / 长句 / 长链接）`, async () => {
      const cases = {
        长英文单词: "Supercalifragilisticexpialidocious".repeat(8),
        长中文句: "这是一句很长的中文，用来看看它会不会超出输入框的宽度。".repeat(6),
        长链接: "https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com/index.html?token=abcdefghijklmnopqrstuvwxyz0123456789",
        纯字母: "a".repeat(160),
      };
      const bad = [];
      for (const [name, text] of Object.entries(cases)) {
        const info = await evaluate(`(() => {
          const input = document.querySelector('#messageInput');
          input.value = ${JSON.stringify(text)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const box = document.querySelector('.composer-box');
          const doc = document.documentElement;
          const style = getComputedStyle(input);
          return {
            name: ${JSON.stringify(name)},
            inputOverflow: input.scrollWidth - input.clientWidth,
            boxOverflow: box.scrollWidth - box.clientWidth,
            docOverflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
          };
        })()`);
        if (info.inputOverflow > 2 || info.boxOverflow > 2 || info.docOverflow > 4) bad.push(info);
        assert(info.overflowWrap === "anywhere" || info.overflowWrap === "break-word",
          "输入框没写 overflow-wrap，iOS Safari 上长链接会顶出框外：" + JSON.stringify(info));
        assert(info.wordBreak === "break-word" || info.wordBreak === "break-all",
          "输入框没写 word-break，长英文词会顶出框外：" + JSON.stringify(info));
        await evaluate(`(() => { const i = document.querySelector('#messageInput'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await new Promise((r) => setTimeout(r, 120));
      }
      assert(bad.length === 0, "这些草稿溢出了输入框：" + JSON.stringify(bad));
    });

    await check(`${viewport.label}：顶栏每个控件都真的点得到（不被盖住、不互相压住）`, async () => {
      // 2026-09-12 用户实测：「手机端上面几个东西都点不动，而且还有重叠」。
      // 根因两条：① 手机上顶栏是**写死高度**，第二行溢出自己的盒子 → 被后画的聊天区盖住；
      // ② 两个下拉的 select 最大宽度按整屏算，并排时互相压住。
      // 这类 bug 的特点是"看得见、点不到"：element.click() 照样能触发，
      // 所以只有**在中心点做命中测试**才抓得到（和 0.1.18 那颗 hidden 的记忆按钮同一类）。
      const probe = await evaluate(`(() => {
        const describe = (node) => node ? (node.tagName.toLowerCase() + (node.id ? "#" + node.id : "")) : "null";
        const controls = Array.from(document.querySelectorAll(
          ".topbar button, .topbar select, .topbar input, .topbar .chat-model, .topbar [role='button']"
        ));
        const visible = [];
        const blocked = [];
        const tooSmall = [];
        for (const node of controls) {
          const r = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (node.hidden === true || style.display === "none" || style.visibility === "hidden") continue;
          if (r.width < 1 || r.height < 1) continue;
          visible.push(describe(node));
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const top = document.elementFromPoint(cx, cy);
          const reachable = !!(top && (top === node || node.contains(top) || top.contains(node)));
          if (!reachable) blocked.push(describe(node) + "@" + cx + "," + cy + "→" + describe(top));
          // 触屏要点得着：不然就是"看得见按不上"
          if (r.height < 28 || r.width < 24) tooSmall.push(describe(node) + "=" + Math.round(r.width) + "×" + Math.round(r.height));
        }
        const overlaps = [];
        for (let i = 0; i < controls.length; i += 1) {
          for (let j = i + 1; j < controls.length; j += 1) {
            // 父子不算重叠（.chat-model 本来就包着它的 select）。
            if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
            const a = controls[i].getBoundingClientRect();
            const b = controls[j].getBoundingClientRect();
            if (a.width < 1 || b.width < 1) continue;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 1 && oy > 1) overlaps.push(describe(controls[i]) + " ∩ " + describe(controls[j]) + " " + Math.round(ox) + "×" + Math.round(oy));
          }
        }
        const topbar = document.querySelector(".topbar");
        return { visible, blocked, tooSmall, overlaps,
          topbarHeight: topbar ? Math.round(topbar.getBoundingClientRect().height) : 0,
          topbarRows: topbar ? topbar.children.length : 0 };
      })()`);
      // 手机上顶栏只留一行（☰ / 角色名 / 体验卡徽标 / 记忆），
      // 而这份 fixture 没有体验卡 → 可见控件就是"☰ + 记忆"两个。
      assert(probe.visible.length >= 2, "顶栏可见控件太少，检查可能失效：" + JSON.stringify(probe.visible));
      assert(probe.blocked.length === 0, "这些顶栏控件点不到（被别的元素盖住）：" + probe.blocked.join("; "));
      assert(probe.overlaps.length === 0, "顶栏控件互相重叠：" + probe.overlaps.join("; "));
      assert(probe.tooSmall.length === 0, "顶栏控件命中区太小： " + probe.tooSmall.join("; "));
      // 顶栏也别长成一坨：手机上它一旦变成三行就是 160px，屏幕直接被吃掉一块。
      assert(probe.topbarHeight <= 120, "顶栏太高了（" + probe.topbarHeight + "px），手机上会挤掉内容");
    });

    await check(`${viewport.label}：点顶栏「记忆」必须真的有反应`, async () => {
      // 用户 2026-09-12：「记忆能点但是没有任何反应」。根因：手机上 innerWidth 小于
      // utilityCloseWidth，setMemoryPanelOpen 里那个条件永远为假 —— 点了什么都不发生。
      // 这条用**真点击**，然后要求"要么弹层开了、要么右侧栏真的可见"。
      await evaluate("document.querySelector('[data-action=\"open-memories\"]').click(); true");
      await sleep(400);
      const opened = await evaluate(`(() => {
        const modal = document.querySelector('#memoryPanel');
        const column = document.querySelector('.inspector-column');
        const modalOpen = !!modal && modal.hidden === false;
        const columnOpen = !!column && getComputedStyle(column).display !== 'none'
          && column.getBoundingClientRect().width > 0;
        return { modalOpen: modalOpen, columnOpen: columnOpen };
      })()`);
      assert(opened.modalOpen || opened.columnOpen,
        "点了「记忆」什么都没打开：" + JSON.stringify(opened));
      // 收尾：把打开的东西关上，别影响后面的用例。
      await evaluate(`(() => {
        const close = document.querySelector("[data-action='close-character-panel']");
        if (close && document.querySelector('#memoryPanel').hidden === false) close.click();
        return true;
      })()`);
      await sleep(300);
    });

    await check(`${viewport.label}：「本次请求」和发送键不挤在一起`, async () => {
      // 用户 2026-09-12：「手机版的本次请求离那个发送按钮太近了」。
      // 2026-09-18（微信式输入条）：两者不再贴在一起了 —— 「本次请求」收进「+」面板里，
      // 发送键在另一头。这里改成量**现在的口径**：有草稿时发送键与输入框并排、不重叠、
      // 在视口内；「本次请求」不再出现在输入条那一行上（那一行只留微信那四个控件）。
      const gapInfo = await evaluate(`(() => {
        const peek = document.querySelector('#requestPeekButton');
        const send = document.querySelector('#sendButton');
        const input = document.querySelector('#messageInput');
        // ⚠ 只设值、**不派发 input**：派发 input 会顺带把「本次请求」露出来（有草稿就算），
        //   而这条要量的正是"输入条那一行里没有它"。发送键那一侧由 updateComposerAffordances
        //   直接读 value 判定，所以不派发也照样会变成发送（这也正是要钉的行为）。
        input.value = '量一量间距';
        window.TASK21.updateComposerAffordances();
        const peekShown = !!peek && peek.hidden !== true && getComputedStyle(peek).display !== 'none';
        const b = send.getBoundingClientRect();
        const c = input.getBoundingClientRect();
        const overlapX = Math.min(c.right, b.right) - Math.max(c.left, b.left);
        const overlapY = Math.min(c.bottom, b.bottom) - Math.max(c.top, b.top);
        return {
          peekShown: peekShown,
          peekInRow: !!(peek && peek.closest('.composer-row')),
          sendVisible: b.width > 0,
          sendInViewport: b.right <= window.innerWidth + 1 && b.left >= -1 && b.bottom <= window.innerHeight + 1,
          overlap: overlapX > 1 && overlapY > 1,
        };
      })()`);
      assert(!gapInfo.peekShown, "「本次请求」不该再出现在输入条那一行上（已收进「+」面板）：" + JSON.stringify(gapInfo));      assert(gapInfo.sendVisible && gapInfo.sendInViewport, "有草稿时发送键必须可见且在视口内：" + JSON.stringify(gapInfo));
      assert(!gapInfo.overlap, "发送键和输入框叠在一起了：" + JSON.stringify(gapInfo));
      await evaluate(`(() => { const i = document.querySelector('#messageInput'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    });

    await check(`${viewport.label}：「本次请求」弹层能开、能关、内容可滚动`, async () => {
      await evaluate("window.TASK21.openRequestPeek(); true");
      await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const surface = document.querySelector('#requestPeek');
        const card = surface.querySelector('.request-peek-card');
        const body = surface.querySelector('.request-peek-body');
        const close = surface.querySelector("[data-action='close-request-peek']");
        const r = card.getBoundingClientRect();
        const c = close.getBoundingClientRect();
        const doc = document.documentElement;
        return {
          inView: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          cardRect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
          contentScrollable: body.scrollHeight <= body.clientHeight || getComputedStyle(body).overflowY !== 'visible',
          closeReachable: c.top >= 0 && c.bottom <= window.innerHeight && c.width >= 28 && c.height >= 20,
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        };
      })()`);
      assert(info.inView, "弹层超出视口：" + JSON.stringify(info.cardRect));
      assert(info.contentScrollable, "弹层内容不可滚动，长内容会被裁掉");
      assert(info.closeReachable, "关闭按钮不可达或过小");
      assert(info.overflow <= 4, "打开弹层后出现横向溢出：" + info.overflow);
      await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
      await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
    });

    await check(`${viewport.label}：角色面板的「记忆」页能开、能关`, async () => {
      await evaluate("window.TASK21.openMemoryPanel()");
      await waitFor("document.querySelector('#memoryPanel').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const surface = document.querySelector('#characterPanel');
        const card = surface.querySelector('.request-peek-card');
        const pane = document.querySelector('#memoryPanel');
        const close = document.querySelector("[data-action='close-character-panel']");
        const r = card.getBoundingClientRect();
        const c = close.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        const doc = document.documentElement;
        return {
          inView: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          closeReachable: c.top >= 0 && c.bottom <= window.innerHeight && c.width >= 28,
          // 记忆页自己必须是滚动容器：条目多了不能把面板撑出屏幕。
          paneScrollable: pane.scrollHeight <= pane.clientHeight + 1 || getComputedStyle(pane).overflowY === 'auto',
          paneInView: p.top >= r.top - 1 && p.bottom <= r.bottom + 1,
          tabs: Array.from(document.querySelectorAll('[data-character-tab]')).map((b) => b.dataset.characterTab),
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        };
      })()`);
      assert(info.inView, "角色面板超出视口");
      assert(info.closeReachable, "角色面板关闭按钮不可达");
      assert(info.paneScrollable, "记忆页不能滚动，条目多时下面的内容看不到");
      assert(info.paneInView, "记忆页跑到面板外面了：" + JSON.stringify(info));
      assert(info.tabs.join(",") === "setup,memories,relationship", "三个分页不对：" + info.tabs.join(","));
      assert(info.overflow <= 4, "打开角色面板后出现横向溢出：" + info.overflow);
      await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
      await waitFor("document.querySelector('#memoryPanel').hidden === true", 8000);
    });

    await check(`${viewport.label}：花费与预估不在输入区，改在「本次请求」里读`, async () => {
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '预估一下这句大概会发多少内容出去';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      // 用户 2026-09-12：「这些信息不要显示在那个界面上，换个地方，看着有点乱」。
      // 先钉死"不许再挂回输入区"，再看它们在新家（本次请求面板）里读得全。
      const inComposer = await evaluate(`(() => {
        const box = document.querySelector('.composer-box');
        return ['#chatEstimateLine', '#chatCostLine']
          .filter((sel) => box.contains(document.querySelector(sel)));
      })()`);
      assert(inComposer.length === 0, "预估/台账又跑回输入区了：" + JSON.stringify(inComposer));
      const composer = await evaluate(`(() => {
        const send = document.querySelector('#sendButton');
        const box = document.querySelector('.composer-box');
        const s = send.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return {
          sendWidth: Math.round(s.width),
          sendInside: s.left >= b.left - 1 && s.right <= b.right + 1,
          boxHeight: Math.round(b.height),
        };
      })()`);
      assert(composer.sendWidth >= 28 && composer.sendInside,
        "输入区被撑坏了：" + JSON.stringify(composer));
      assert(composer.boxHeight <= 220, "输入区太高（信息没搬干净）：" + JSON.stringify(composer));

      await evaluate("window.TASK21.openRequestPeek(); true");
      await waitFor("document.querySelector('#requestPeek').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const surface = document.querySelector('#requestPeek');
        const node = document.querySelector('#chatEstimateLine');
        const cost = document.querySelector('#chatCostLine');
        const card = surface.querySelector('.request-peek-card');
        const r = node.getBoundingClientRect();
        const c = cost.getBoundingClientRect();
        const k = card.getBoundingClientRect();
        return {
          inPanel: surface.contains(node) && surface.contains(cost),
          hidden: node.hidden,
          display: getComputedStyle(node).display,
          text: node.textContent,
          costText: cost.textContent,
          costDisplay: getComputedStyle(cost).display,
          insideCard: node.hidden ? true : (r.left >= k.left - 1 && r.right <= k.right + 1),
          inViewport: node.hidden ? true : (r.left >= -1 && r.right <= window.innerWidth + 1),
          textOverflow: node.hidden ? 0 : Math.max(0, node.scrollWidth - node.clientWidth),
        };
      })()`);
      assert(info.inPanel, "预估/台账没搬进「本次请求」面板");
      assert(info.hidden === false, "面板里应当显示预估行：" + JSON.stringify(info));
      assert(/这次约|输出上限/.test(info.text), "预估行内容不对：" + info.text);
      assert(info.display !== "none", "面板里预估行被 CSS 藏了");
      assert(info.insideCard && info.inViewport, "预估行溢出了面板/视口：" + JSON.stringify(info));
      assert(info.textOverflow <= 2, "预估行文字被截断（横向溢出 " + info.textOverflow + "px）：" + info.text);
      // 台账那一行在面板里也得真的看得见（输入区时代它被窄屏规则藏掉过，别再来一次）。
      assert(info.costDisplay !== "none" && info.costText.length > 0,
        "面板里台账行是空的或者被藏了：" + JSON.stringify(info));
      assert(/token/.test(info.costText), "台账行没有 token 数字：" + info.costText);
      await evaluate("document.querySelector(\"[data-action='close-request-peek']\").click(); true");
      await waitFor("document.querySelector('#requestPeek').hidden === true", 8000);
      await evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    });

    await check(`${viewport.label}：「关系」页表单能开、能滚、按钮点得到`, async () => {
      await evaluate("window.TASK21.openCompanionDialog()");
      await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
      const info = await evaluate(`(() => {
        const surface = document.querySelector('#characterPanel');
        const pane = document.querySelector('#companionDialog');
        const card = surface.querySelector('.request-peek-card');
        const save = document.querySelector('#companionSaveButton');
        const enabled = document.querySelector('#companionEnabled');
        const doc = document.documentElement;
        const r = card.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        const s = save.getBoundingClientRect();
        return {
          // 表单比屏幕高时必须自己滚，否则底部的"保存"永远点不到。
          scrollable: pane.scrollHeight <= pane.clientHeight + 1 || getComputedStyle(pane).overflowY === 'auto',
          cardInView: r.top >= -1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          paneInView: p.top >= r.top - 1 && p.bottom <= r.bottom + 1,
          // 保存按钮在滚动区里：滚到底必须够得着（真人就是这么点的）。
          saveInPane: pane.contains(save),
          saveReachable: s.width >= 28 && s.height >= 24,
          // 开关本身要能被点到（窄屏上很容易被挤成一条缝）。
          enabledHit: (() => { const e = enabled.getBoundingClientRect(); return e.width >= 13 && e.height >= 13; })(),
          overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        };
      })()`);
      assert(info.scrollable, "关系页不可滚动，矮屏上保存按钮会点不到");
      assert(info.cardInView, "面板横向超出视口：" + JSON.stringify(info));
      assert(info.paneInView, "关系页跑到面板外面了：" + JSON.stringify(info));
      assert(info.saveInPane, "保存按钮不在关系页的滚动区里");
      assert(info.saveReachable, "保存按钮不可达");
      assert(info.enabledHit, "伴侣模式开关太小，点不到");
      assert(info.overflow <= 4, "打开关系页后出现横向溢出：" + info.overflow);
      await evaluate("document.querySelector(\"[data-action='close-character-panel']\").click(); true");
      await waitFor("document.querySelector('#companionDialog').hidden === true", 8000);
    });

    await check(`${viewport.label}：取消记错 / 编造之后，消息旁不再有点不动的旧入口`, async () => {
      // 用户 2026-09-18：「全局取消记错和编造」。这条原来量的是那两个按钮够不够大好点；
      // 按钮取消之后改为量**它们不存在**（同一个检查位、不同的正确判据），
      // 顺带确认消息行本身还在（否则"没有按钮"可能只是因为整页没画出来，那是假通过）。
      const probe = await evaluate(`(() => ({
        rows: document.querySelectorAll('#dynamicMessages .message-row-assistant').length,
        boxes: document.querySelectorAll('.message-flags').length,
        buttons: document.querySelectorAll('.message-flag').length,
      }))()`);
      assert(probe.rows > 0, "前置不成立：这一段对话里一条助手消息都没有：" + JSON.stringify(probe));
      assert(probe.boxes === 0 && probe.buttons === 0,
        "消息旁还有「记错 / 编造」的入口（已经取消了）：" + JSON.stringify(probe));
    });

    // 设置面板：滚到底时最后一行不能被挡住。
    // 用户 2026-09-12 报了两次都没修好 —— 前两版把 padding 加在 .settings-scroll / .settings-body 上，
    // 这两个类名在 index.html 里根本不存在，等于没改。所以这里量的是**结果**：
    // 每个分区滚到底，最后可见元素的底边必须在底栏之上，且它中心点的命中测试要落在它自己身上。
    // 2026-09-18：手机底部那一栏**已经删掉**（用户口径），所以"上面"的边界就是屏幕底边；
    // 这一条同时钉住"底栏真的不在了"（它还留在 DOM 里但永远是 hidden）。
    await check(`${viewport.label}：设置每个分区滚到底，最后一行不被挡住（底部那一栏已删）`, async () => {
      const navGone = await evaluate(`(() => {
        const nav = document.querySelector('.mobile-bottom-nav');
        if (!nav) return { exists: false };
        const style = getComputedStyle(nav);
        return { exists: true, hidden: nav.hidden, display: style.display, height: Math.round(nav.getBoundingClientRect().height) };
      })()`);
      assert(navGone.exists === false || navGone.hidden === true || navGone.display === "none",
        "手机底部那一栏还在显示（2026-09-18 用户要求删掉）：" + JSON.stringify(navGone));
      await evaluate(`(() => { const b = document.querySelector('[data-action="open-settings"]'); if (b) b.click(); return true; })()`);
      await waitFor("document.querySelector('#settingsSurface').hidden === false", 8000);
      const sections = await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).map((b) => b.dataset.settingsSection)`);
      assert(sections.length >= 5, "设置分区太少，测试没意义：" + JSON.stringify(sections));
      const bad = [];
      for (const section of sections) {
        await evaluate(`(() => { const b = document.querySelector('[data-settings-section="${section}"]'); if (b) b.click(); return true; })()`);
        await new Promise((r) => setTimeout(r, 300));
        const row = await evaluate(`(() => {
          const layout = document.querySelector('.settings-layout');
          layout.scrollTop = layout.scrollHeight;
          const nav = document.querySelector('.mobile-bottom-nav');
          const navVisible = nav && getComputedStyle(nav).display !== 'none';
          const navTop = navVisible ? Math.round(nav.getBoundingClientRect().top) : window.innerHeight;
          const panel = document.querySelector('[data-settings-panel="${section}"]');
          // ⚠ 面板找不到时要说清"是哪一个、现有哪几个"，别让异常信息只剩一句 querySelectorAll。
          if (!panel) {
            return { section: '${section}', missing: true,
              have: Array.from(document.querySelectorAll('[data-settings-panel]')).map((n) => n.dataset.settingsPanel),
              nav: Array.from(document.querySelectorAll('[data-settings-section]')).map((n) => n.dataset.settingsSection) };
          }
          const nodes = Array.from(panel.querySelectorAll('*')).filter((n) => {
            const r = n.getBoundingClientRect();
            const s = getComputedStyle(n);
            return r.height > 0 && r.width > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          });
          const last = nodes[nodes.length - 1];
          if (!last) return { section: '${section}', empty: true };
          const r = last.getBoundingClientRect();
          const cx = Math.min(window.innerWidth - 2, Math.max(2, r.left + r.width / 2));
          const cy = Math.min(window.innerHeight - 2, Math.max(2, r.top + r.height / 2));
          const hit = document.elementFromPoint(cx, cy);
          return {
            section: '${section}',
            tag: last.tagName.toLowerCase() + (last.id ? '#' + last.id : ''),
            bottom: Math.round(r.bottom),
            navTop,
            hiddenBehindNav: Math.round(r.bottom) > navTop + 1,
            reachable: hit === last || (hit && last.contains(hit)),
            hitTag: hit ? hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/)[0] : '') : 'null',
          };
        })()`);
        if (row.empty) continue;
        if (row.missing) { bad.push(row); continue; }
        if (row.hiddenBehindNav || !row.reachable) bad.push(row);
      }
      assert(bad.length === 0, "这些分区滚到底还是被挡住/点不到：" + JSON.stringify(bad));
      await evaluate(`(() => { const b = document.querySelector('[data-action="close-settings"]'); if (b) b.click(); return true; })()`);
      await waitFor("document.querySelector('#settingsSurface').hidden === true", 8000);
    });

    // 每个视口检查完把弹层状态清掉，避免影响下一个视口。
    // 设置面板也要关：有一条用例中途失败时会把设置留在打开状态，
    // 后面几条就全都点到 `div.confirm-backdrop`/设置层上，报出一串看不懂的错
    // （2026-09-13 缩放改成 0.9 时亲眼见过：1 个真问题带出 5 个假失败）。
    await evaluate("try { window.TASK21.closeRequestPeek(); window.TASK21.closeMemoryPanel(); window.TASK21.closeCompanionDialog(); } catch (_) {} true");
    await evaluate(`(() => {
      const panel = document.querySelector('#characterPanel');
      if (panel && panel.hidden === false) {
        const close = document.querySelector("[data-action='close-character-panel']");
        if (close) close.click();
      }
      return true;
    })()`);
    await evaluate(`(() => {
      const surface = document.querySelector('#settingsSurface');
      if (surface && surface.hidden === false) {
        const back = document.querySelector('[data-action="close-settings"]');
        if (back) back.click();
      }
      return true;
    })()`);
  }

  await cdp.sessionSend(session, "Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureScript.identifier });
  server.close();
  try { chrome.process.kill(); } catch (_) {}

  console.log("");
  console.log(failures
    ? `VIEWPORT_CHECK=${results.length - failures}/${results.length}（有 ${failures} 项不达标）`
    : `VIEWPORT_CHECK=${results.length}/${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试自身崩了：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
