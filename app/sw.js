"use strict";

/*
 * sw.js —— 离线壳（PWA）
 *
 * 策略是**网络优先**，不是缓存优先。原因很具体：
 * 这个应用是"部署一次、用户直接用"的静态站点，缓存优先最容易出的问题是
 * **改了却看不到**（线上已经是新的，用户那里还是旧的，而且刷新也没用）——
 * 那比"离线打不开"更难查、更伤。网络优先的取舍是：
 *   - 有网：永远先拿最新的，缓存只用来更新副本（所以部署立刻生效，不需要"版本号对不上"的等待）；
 *   - 断网：退回缓存里的那份，界面照常打开，数据本来就在本机（IndexedDB / 本地文件）。
 * 换来的代价：离线时看到的是最后一次成功打开时的界面；新版提示由页面自己负责（见 pwa.js）。
 *
 * 只缓存同源 GET：模型接口是 POST（而且常常是别的域名），一律不碰。
 */

const CACHE_NAME = "roleworld-shell-v1";
// 首次安装时先存下外壳；其余文件在第一次访问时顺手存。
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest"];

/**
 * 这确实是我们的应用页面吗？
 * 为什么要判：托管平台会在首次访问时插一个"免费版/额度"提示页（用户实际遇到过），
 * 它同样是 200 + HTML。如果不加判断就缓存，缓存里存的就是那个提示页，
 * 以后断网打开看到的是提示页而不是应用 —— 而且这种错很难查。
 */
function looksLikeApp(text) {
  const body = String(text || "");
  return body.indexOf("角色世界") >= 0 || body.indexOf("task22-core.js") >= 0;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of PRECACHE) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response || !response.ok) continue;
        if (url.indexOf("index.html") >= 0 || url === "./") {
          const text = await response.clone().text();
          if (!looksLikeApp(text)) continue;   // 平台提示页：不当作外壳
        }
        await cache.put(url, response);
      } catch (_) { /* 单个文件失败不影响安装 */ }
    }
  })());
  // 新版立刻待命，等页面发消息就接管（不在这里 skipWaiting：先让页面有机会提示"有新版本"）。
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "skip-waiting") self.skipWaiting();
  if (data.type === "version" && event.source) {
    event.source.postMessage({ type: "version", version: CACHE_NAME });
  }
});

/** 只处理该管的请求：同源、GET、http(s)。 */
function shouldHandle(request) {
  if (request.method !== "GET") return false;
  let url;
  try { url = new URL(request.url); } catch (_) { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== self.location.origin) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!shouldHandle(request)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      // 要缓存就得**同步**克隆：等异步回调再 clone，响应体已经被页面读掉了，
      // clone() 会抛"body already used" —— 结果是导航页根本没被缓存（这个坑刚踩过）。
      const usable = response && response.ok && response.status === 200 && response.type === "basic";
      const forCheck = usable && request.mode === "navigate" ? response.clone() : null;
      const forCache = usable ? response.clone() : null;
      if (forCache) {
        if (forCheck) {
          // 导航响应先确认是我们的应用，否则会把平台提示页当成外壳缓存起来。
          forCheck.text().then((text) => {
            if (!looksLikeApp(text)) return null;
            return caches.open(CACHE_NAME).then((cache) => cache.put(request, forCache));
          }).catch(() => { /* 判不出来就不缓存，宁可少一份离线副本 */ });
        } else {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, forCache)).catch(() => {});
        }
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return cached;
      // 导航请求离线又没缓存：给一个能看懂的离线说明，而不是浏览器的恐龙页。
      if (request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
        return new Response(
          "<!DOCTYPE html><meta charset=\"utf-8\"><title>离线</title>"
          + "<body style=\"font:15px/1.7 system-ui;padding:40px;background:#0d0f13;color:#e6e9ef\">"
          + "<h1>现在打不开</h1><p>这个页面还没有被缓存过，而当前设备离线。</p>"
          + "<p>你的角色卡与对话都还在本机，联网后再打开即可。</p></body>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      throw error;
    }
  })());
});
