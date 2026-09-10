"use strict";

/* Minimal CDP client over Node global WebSocket (no external deps).
 * Used by the Task-31A browser test to drive headless Chrome. */

const { spawn } = require("node:child_process");
const http = require("node:http");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("ws error"));
    });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    };
    return c;
  }
  // Send a flat-protocol command; optionally scoped to a sessionId.
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  sessionSend(sessionId, method, params = {}) {
    return this.send(method, params, sessionId);
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function launchChrome(chromePath, { debugPort = 9333, viewport = "1280,900" } = {}) {
  const proc = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--remote-debugging-port=" + debugPort,
    "--window-size=" + viewport,
    "--user-data-dir=" + (process.env.TEMP + "\\task31a-chrome-" + Date.now() + "-" + Math.random().toString(36).slice(2)),
    "about:blank",
  ], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 80; i++) {
    try { ver = await getJson(`http://127.0.0.1:${debugPort}/json/version`); if (ver) break; } catch (_) {}
    await sleep(150);
  }
  return { proc, ver };
}

module.exports = { CDP, launchChrome, sleep, getJson };
