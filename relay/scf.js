"use strict";

/*
 * relay/scf.js —— 云函数（HTTP 访问服务）适配层
 *
 * 说明白一件事：云函数**事件式**调用拿不到流式响应，所以这条路适合"能用就行"的降级方案。
 * 要保住逐字出字的观感，请用云托管（容器）跑 index.js —— 那份是完整实现，SSE 原样透传。
 *
 * 部署（HTTP 云函数）：
 *   tcb fn deploy roleworld-relay --dir relay --httpFn --path /relay -e <envId>
 * 然后在应用里把接口地址填成 https://<envId>.service.tcloudbase.com/relay/v1/chat/completions
 */

const { createRelay } = require("./server.js");
const { createStore } = require("./store.js");

let relay = null;

function instance() {
  if (!relay) relay = createRelay({ store: createStore({}) });
  return relay;
}

/** 把云函数的 HTTP 事件翻译成一次普通请求 → 收集响应 → 按云函数格式返回。 */
exports.main = async (event) => {
  const server = instance();
  const method = String((event && (event.httpMethod || event.method)) || "POST").toUpperCase();
  const path = String((event && (event.path || event.rawPath)) || "/").replace(/^\/relay/, "") || "/";
  const headers = Object.assign({}, (event && event.headers) || {});
  const body = event && event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8")) : Buffer.alloc(0);

  return await new Promise((resolve) => {
    const chunks = [];
    const fakeReq = {
      method,
      url: path,
      headers,
      on(eventName, handler) {
        if (eventName === "data" && body.length) handler(body);
        if (eventName === "end") handler();
        return this;
      },
      destroy() {},
    };
    const fakeRes = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      writeHead(status, extra) { this.statusCode = status; this.headers = Object.assign({}, extra || {}); this.headersSent = true; return this; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          isBase64Encoded: false,
        });
      },
      flushHeaders() {},
    };
    server.emit("request", fakeReq, fakeRes);
  });
};
