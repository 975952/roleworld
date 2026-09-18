"use strict";
/*
 * _probe-retry.cjs —— 一次性探针：只为了定位「合成失败 → 重试」那条用例里
 * `Cannot read properties of null (reading 'disabled')` 到底从哪儿来。
 * 不是交付物，查清就删。
 */
const path = require("node:path");
const CDP_ = require(path.join(__dirname, "..", "tests", "cdp.js"));
const fs = require("node:fs");
const http = require("node:http");

const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate)) || "";
const APP = path.join(__dirname, "..", "app");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const { sleep } = CDP_;

function startServer() {
  const voiceRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);
    if (p === "/relay/voice/info") {
      const ok = String(req.headers.authorization || "") === "Bearer RW-AAAAA-BBBBB-CCCCC";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(ok ? { ok: true, enabled: true, speakers: [{ id: "zh_female_vv_uranus_bigtts", label: "vivi", lang: "zh" }], defaultSpeaker: "zh_female_vv_uranus_bigtts", maxChars: 400, format: "mp3", model: "t", resourceId: "seed-tts-2.0", voiceLeft: 20, voiceCharsLeft: 2000 } : { error: { code: "CARD_UNKNOWN", message: "不认识" } }));
      return;
    }
    if (p === "/relay/v1/audio/speech") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      voiceRequests.push({ text: body.text });
      res.writeHead(504, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: { code: "VOICE_TIMEOUT", message: "上游合成超时了。" } }));
      return;
    }
    if (p === "/relay/v1/chat/completions" || p === "/v1/chat/completions") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "\u201c\u8fd9\u53e5\u8bdd\u6ca1\u5408\u6210\u51fa\u6765\u3002\u201d\n[[\u8bed\u97f3]]" } }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      return;
    }
    if (p === "/") p = "/index.html";
    const file = path.join(APP, p.replace(/^\/+/, ""));
    if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, voiceRequests })));
}

(async () => {
  const { server, port, voiceRequests } = await startServer();
  const base = "http://127.0.0.1:" + port;
  const chrome = await CDP_.launchChrome(CHROME, { debugPort: 9511 });
  const cdp = await CDP_.connect(chrome.ver.webSocketDebuggerUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const out = await cdp.sessionSend(sessionId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      throw new Error("EXC: " + ((d.exception && d.exception.description) || d.text));
    }
    return out.result.value;
  };
  try {
    await cdp.sessionSend(sessionId, "Page.enable");
    await cdp.sessionSend(sessionId, "Runtime.enable");
    await evaluate("(function(){ try { localStorage.setItem('card_welcome_seen','1'); localStorage.setItem('task22.chat-model.v1.local', JSON.stringify({mode:'deepseek-flash'})); } catch(_){} return true; })()");
    // 先把库铺好：用一个干净档案打开一次
    await cdp.sessionSend(sessionId, "Page.navigate", { url: base + "/index.html" });
    await sleep(2500);
    const ready = await evaluate("window.TASK21_READY === true");
    console.log("ready=", ready);
    // 造定制角色
    const created = await evaluate(`(async () => {
      const card = { spec:"chara_card_v2", spec_version:"2.0", data:{ name:"\u6797\u9ed8", description:"\u5b89\u9759", personality:"\u8bdd\u5c11", scenario:"\u804a\u5929", first_mes:"\u5728\u3002", mes_example:"", tags:[] } };
      const file = new File([JSON.stringify(card)], "\u6797\u9ed8.json", { type: "application/json" });
      const r = await window.STApi.importCharacter(file, "json");
      return r && r.avatar;
    })()`);
    console.log("avatar=", created);
    await cdp.sessionSend(sessionId, "Page.navigate", { url: base + "/index.html" });
    await sleep(2500);
    const ok2 = await evaluate(`(async () => {
      const entry = { avatar: ${JSON.stringify(created)}, charName: "\u6797\u9ed8" };
      const prev = await window.TASK21.loadCompanion(entry);
      await window.TASK21.saveCompanion(entry, Object.assign({}, prev, { enabled: true, relation: "partner", chatStyle: "plain" }));
      return true;
    })()`);
    console.log("companion=", ok2);
    // 带卡打开 + 打开语音
    await cdp.sessionSend(sessionId, "Page.navigate", { url: base + "/index.html#card=RW-AAAAA-BBBBB-CCCCC@" + base + "/relay" });
    await sleep(2500);
    const on = await evaluate(`(async () => {
      await RoleWorld.saveLocalSettings({ voice_enabled: true, voice_consent_at: new Date().toISOString() });
      await window.RoleWorldVoiceCloud.refresh({ force: true });
      return { enabled: (await RoleWorld.getLocalSettings()).voice_enabled === true, canSpeak: window.RoleWorldVoiceCloud.capability().canSpeak };
    })()`);
    console.log("voice=", JSON.stringify(on));
    // 切到那段对话
    await evaluate(`(async () => {
      await window.TASK21.refreshSessions();
      const row = window.TASK21.sessionList().find((one) => String(one.fileName).indexOf(${JSON.stringify(created)}) >= 0);
      if (row) await window.TASK21.selectChat(row.id);
      return !!row;
    })()`);
    await sleep(1500);
    console.log("chat=", await evaluate("window.TASK21.activeChatFileName()"));
    // 发一句
    await evaluate(`(() => { const i = document.querySelector('#messageInput'); i.value = '说一句'; i.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#sendButton').click(); return true; })()`);
    for (let i = 0; i < 100; i += 1) {
      const n = await evaluate("document.querySelectorAll('#dynamicMessages .voice-bubble[data-voice-state=\\\"failed\\\"]').length");
      if (n >= 1) break;
      await sleep(200);
    }
    console.log("failed bubble seen; voiceRequests=", voiceRequests.length);
    const before = voiceRequests.length;
    console.log("--- 点重试 ---");
    try {
      const r = await evaluate(`(async () => {
        const node = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
        if (!node) return 'no-bubble';
        const b = node.querySelector('[data-voice-action="retry"]');
        if (!b) return 'no-button';
        b.click();
        return 'clicked';
      })()`);
      console.log("click result=", r);
    } catch (error) {
      console.log("CLICK THREW:", String(error && error.message));
    }
    await sleep(3000);
    console.log("after retry voiceRequests=", voiceRequests.length, "delta=", voiceRequests.length - before);
    const state = await evaluate(`(() => {
      const n = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
      if (!n) return { bubbles: 0 };
      return { state: n.dataset.voiceState, actions: Array.from(n.querySelectorAll('[data-voice-action]')).map((b) => ({ a: b.dataset.voiceAction, d: b.disabled })) };
    })()`);
    console.log("state=", JSON.stringify(state));
    console.log("--- 点改为文字 ---");
    try {
      const r2 = await evaluate(`(async () => {
        const n = Array.from(document.querySelectorAll('#dynamicMessages .voice-bubble')).pop();
        if (!n) return 'no-bubble';
        const b = n.querySelector('[data-voice-action="to-text"]');
        if (!b) return 'no-to-text';
        b.click();
        return 'clicked';
      })()`);
      console.log("to-text result=", r2);
    } catch (error) {
      console.log("TO-TEXT THREW:", String(error && error.message));
    }
    await sleep(2500);
    console.log("bubbles now=", await evaluate("document.querySelectorAll('#dynamicMessages .voice-bubble').length"));
    const errors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => {
      const d = e.params.exceptionDetails;
      return ((d.exception && d.exception.description) || d.text || "").split("\n").slice(0, 4).join(" | ");
    });
    console.log("=== 页面异常 " + errors.length + " 条 ===");
    errors.slice(0, 6).forEach((line) => console.log("  " + line));
  } finally {
    cdp.close();
    try { chrome.proc.kill(); } catch (_) { /* 已经退出 */ }
    server.close();
  }
})().catch((error) => { console.error("探针挂了：" + ((error && error.stack) || error)); process.exitCode = 1; });
