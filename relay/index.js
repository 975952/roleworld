"use strict";

/*
 * relay/index.js —— 服务入口（本机、容器、云托管都用它）
 *
 * 环境变量：
 *   UPSTREAM_BASE   上游地址（默认 https://api.deepseek.com）
 *   UPSTREAM_KEY    **真正的** API Key，只存在服务端
 *   ADMIN_SECRET    发卡/停卡口令，必须自设，否则管理接口关闭
 *   CARD_STORE      memory | file | cloudbase（默认 memory，仅用于试跑）
 *   CARD_FILE       file 后端的账本路径
 *   ALLOW_MODELS    只允许这些模型（逗号分隔，空 = 不限制）
 *   PORT            监听端口（默认 8787）
 */

const { createRelay } = require("./server.js");
const { createStore } = require("./store.js");

function main() {
  const store = createStore({});
  const port = Number(process.env.PORT) || 8787;
  const server = createRelay({ store });
  server.listen(port, () => {
    const mode = process.env.CARD_STORE || "memory";
    console.log(`roleworld relay 已启动 :${port}  账本=${store.kind}  上游=${process.env.UPSTREAM_BASE || "https://api.deepseek.com"}`);
    if (store.kind === "memory") {
      console.log("⚠ 账本用的是内存：重启后所有体验卡都会消失。生产请设 CARD_STORE=file 或 cloudbase。");
    }
    if (!process.env.ADMIN_SECRET) console.log("⚠ 没有设置 ADMIN_SECRET：管理接口（发卡/停卡）已关闭。");
    if (!process.env.UPSTREAM_KEY) console.log("⚠ 没有设置 UPSTREAM_KEY：聊天接口会返回 503。");
    console.log(`提示：CARD_STORE=${mode}。`);
  });
  return server;
}

if (require.main === module) main();

module.exports = { main };
