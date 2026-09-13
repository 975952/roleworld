"use strict";
/* 一次性：打开关系档案，量 v2 三组控件的显示情况与父链。用完即删。 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { CDP, launchChrome, sleep } = require("../tests/cdp.js");

const APP = path.join(__dirname, "..", "app");
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((c) => { try { return fs.existsSync(c); } catch (_) { return false; } });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);
    if (p === "/v1/chat/completions") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "好" } }] })); return; }
    if (p === "/") p = "/index.html";
    const file = path.join(APP, p.replace(/^\/+/, ""));
    if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function main() {
  const { server, port } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await launchChrome(CHROME, { debugPort: 9477 });
  const cdp = await CDP.connect(chrome.ver.webSocketDebuggerUrl);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.sessionSend(session, "Page.enable");
  await cdp.sessionSend(session, "Runtime.enable");
  await cdp.sessionSend(session, "Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__ROLEWORLD_FIXTURE__ = {
      characters: [{ avatar: "测试角色.png", name: "测试角色", description: "x", personality: "", scenario: "", first_mes: "你好。", mes_example: "",
        spec: "chara_card_v3", spec_version: "3.0", data: { name: "测试角色", description: "x", personality: "", scenario: "", first_mes: "你好。", tags: [] } }],
      worlds: [], chats: [], settings: { provider: "deepseek", endpoint: "${base}/v1/chat/completions", model: "deepseek-flash", tutorial_seen: true }
    };` });
  const evaluate = async (expression) => {
    const out = await cdp.sessionSend(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error("页面异常：" + (out.exceptionDetails.exception && out.exceptionDetails.exception.description));
    return out.result.value;
  };
  const waitFor = async (expression, ms = 25000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v = null; try { v = await evaluate(expression); } catch (_) {}
      if (v) return v;
      if (Date.now() > deadline) throw new Error("超时：" + expression);
      await sleep(200);
    }
  };

  await cdp.sessionSend(session, "Page.navigate", { url: base + "/index.html?onboarding=off&surprise=off" });
  await waitFor("window.TASK21_READY === true", 30000);
  await evaluate("window.TASK21.openCompanionDialog(); true");
  await waitFor("document.querySelector('#companionDialog').hidden === false", 8000);
  await evaluate(`(() => { const n = document.querySelector('#companionEnabled'); n.checked = true; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(500);
  const report = await evaluate(`(() => {
    const describeChain = (node) => {
      const out = [];
      let n = node;
      while (n && n !== document.body) {
        const s = getComputedStyle(n);
        out.push((n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className ? "." + String(n.className).split(" ").join(".") : "")) + " display=" + s.display + " hidden=" + (n.hidden === true));
        n = n.parentElement;
      }
      return out;
    };
    const rows = {};
    for (const id of ["companionAffinity", "companionAffinityAuto", "companionNeglect", "companionProactive", "companionProactiveGap", "companionShared"]) {
      const node = document.querySelector("#" + id);
      if (!node) { rows[id] = "**不存在**"; continue; }
      const r = node.getBoundingClientRect();
      rows[id] = Math.round(r.width) + "x" + Math.round(r.height) + " | " + describeChain(node).slice(0, 4).join(" <- ");
    }
    return rows;
  })()`);
  for (const [id, line] of Object.entries(report)) console.log("  " + id.padEnd(22) + line);
  server.close();
  try { chrome.kill(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error("探针挂了：" + ((e && e.stack) || e)); process.exitCode = 1; });
