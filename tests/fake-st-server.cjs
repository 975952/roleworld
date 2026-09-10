"use strict";

/* Task-31D fake ST server: serves the frontend + character/delete + chat-template
 * endpoints for loopback browser tests. Synthetic only. */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FRONTEND = path.join(__dirname, "..", "staging", "frontend");

const BASE = "/chat";

function createServer(frontendRoot = FRONTEND) {
  const state = {
    csrf: "task31d-token",
    characters: new Map([
      ["Harry Potter (EN).png", { avatar: "Harry Potter (EN).png", name: "Harry Potter" }],
      ["Hermione Granger (EN).png", { avatar: "Hermione Granger (EN).png", name: "Hermione Granger" }],
    ]),
    users: new Map(),
    sessions: new Map(),
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let p = url.pathname;
    if (p.startsWith(BASE + "/")) p = p.slice(BASE.length);

    // CSRF + API must be handled before static file serving.
    if (p === "/csrf-token") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ token: state.csrf })); return; }
    if (p.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      const sendJson = (c, d) => { res.statusCode = c; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(d)); };
      if (p === "/api/users/login") return sendJson(200, { handle: body.handle || "" });
      if (p === "/api/users/register") return sendJson(201, { handle: body.handle || "" });
      if (p === "/api/users/me") return sendJson(200, { handle: "admin", admin: true });
      if (p === "/api/users/chat-template/status") return sendJson(200, { ready: true, conflicts: [], memoryBookCount: 4, modelConnectionReady: true, initialChatReady: true });
      if (p === "/api/users/chat-template/initialize") return sendJson(200, { ready: true, memoryBookCount: 4, modelConnectionReady: true, initialChatReady: true });
      if (p === "/api/characters/all") return sendJson(200, Array.from(state.characters.values()));
      if (p === "/api/characters/get") {
        const card = state.characters.get(String(body.avatar_url || ""));
        if (!card) return sendJson(404, { error: "missing" });
        return sendJson(200, Object.assign({}, card, { data: { description: card.name, personality: "", scenario: "", system_prompt: "", post_history_instructions: "", mes_example: "", character_book: { entries: [] } } }));
      }
      if (p === "/api/characters/chats") return sendJson(200, []);
      if (p === "/api/characters/delete") {
        const avatar = String(body.avatar_url || "");
        if (!state.characters.has(avatar)) return sendJson(400, { error: "missing" });
        state.characters.delete(avatar);
        return sendJson(200, { ok: true, deletedChats: body.delete_chats === true });
      }
      if (p === "/api/worldinfo/list") return sendJson(200, [
        { name: "MB Harry — fact clips (EN)" },
        { name: "MB Harry — relationship tracker (EN)" },
        { name: "MB Harry — role lock (EN)" },
        { name: "MB Harry — scene memories (EN)" },
      ]);
      if (p === "/api/worldinfo/get") return sendJson(200, { entries: {} });
      if (p === "/api/settings/get") return sendJson(200, { settings: JSON.stringify({ oai_settings: {} }), world_names: [] });
      if (p === "/api/secrets/read") return sendJson(200, { api_key_deepseek: null });
      if (p === "/api/secrets/write") return sendJson(200, { id: "fake-secret" });
      if (p === "/api/secrets/delete") return sendJson(200, {});
      if (p === "/api/backends/chat-completions/generate") return sendJson(200, {
        choices: [{
          message: { content: JSON.stringify({
            name: "合成回归角色",
            description: "用于本地移动端弹窗滚动回归的合成角色。",
            personality: "稳定、耐心，专门用于验证长表单的可访问性。",
            scenario: "在本地合成测试页面中检查角色草稿确认操作。",
            first_mes: "你好，这是一条仅用于本地回归的合成开场白。",
            mes_example: "{{user}}：可以继续吗？\n{{char}}：可以，确认按钮应该始终可见并可操作。",
            tags: ["synthetic", "mobile"],
            language: "zh",
          }) },
          finish_reason: "stop",
        }],
      });
      return sendJson(404, { error: "nf" });
    }

    // Synthetic browser fixtures: avoid irrelevant network console errors for
    // browser-managed favicon/avatar requests. No production asset is served.
    if (p === "/favicon.ico") { res.statusCode = 204; res.end(); return; }
    if (p.startsWith("/characters/")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/png");
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      return;
    }

    // static frontend
    if (p === "" || p === "/") p = "/index.html";
    const file = path.join(frontendRoot, path.basename(p));
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end("nf"); return; }
    const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  return { server, state };
}

module.exports = { createServer, FRONTEND };
