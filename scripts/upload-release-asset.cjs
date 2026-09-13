"use strict";

/*
 * upload-release-asset.cjs —— 把一个产物挂到 GitHub Release 上
 *
 * 用法：
 *   node scripts/upload-release-asset.cjs --tag v0.1.54 --file dist/RoleWorld_0.1.54_android_universal.apk
 *
 * 为什么需要它：Release 工作流只出 Windows 安装包（tauri-action 的行为），
 * Android 的 APK 是我们自己在别的机器上打的 —— 想让同学直接下载，就得手动挂上去。
 *
 * 凭据怎么来的：**不读环境变量、不读文件**，通过 `git credential fill` 让 git
 * 自己把它已经存好的凭据交出来（和 clone/push 用的是同一份，通常在本机凭据管理器里）。
 * 这个脚本只把它用在内存里发一次 HTTPS 请求：
 *   · 从不打印；
 *   · 从不落盘；
 *   · 也不写进任何日志（HTTP 头设了不打印；出错只报状态码与 GitHub 的原话）。
 *
 * 同 tag 已有同名附件时默认覆盖（先删再传），因为"重发同一个版本"时旧附件多半是错的。
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const tag = arg("--tag");
const fileArg = arg("--file");
const repoArg = arg("--repo"); // 可省：默认从 git remote 里认
if (!tag || !fileArg) {
  console.error("用法: node scripts/upload-release-asset.cjs --tag vX.Y.Z --file <产物路径> [--repo owner/name]");
  process.exit(1);
}
const file = path.resolve(fileArg);
if (!fs.existsSync(file)) {
  console.error(`找不到文件：${file}`);
  process.exit(1);
}

/* ------------------------------ 拿仓库与凭据 ------------------------------ */

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

const repo = repoArg || (() => {
  const url = git(["remote", "get-url", "origin"]);
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : "";
})();
if (!repo) {
  console.error("认不出 GitHub 仓库，请用 --repo owner/name 指定。");
  process.exit(1);
}

// 从 git 的凭据助手拿 token。**只到内存为止。**
const credOut = spawnSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=github.com\n\n",
  encoding: "utf8",
});
const token = ((credOut.stdout || "").match(/^password=(.+)$/m) || [])[1];
if (!token) {
  console.error("git 没有交出 GitHub 凭据。请先用 git push 一次（或配置好凭据管理器）再跑这个脚本。");
  process.exit(1);
}

/* -------------------------------- HTTP 小工具 -------------------------------- */

function api(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path: urlPath,
        method,
        headers: {
          "User-Agent": "roleworld-release-script",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function upload(uploadUrlTemplate, filename, mime, bytes) {
  const url = uploadUrlTemplate.replace("{?name,label}", `?name=${encodeURIComponent(filename)}`);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "User-Agent": "roleworld-release-script",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": mime,
          "Content-Length": bytes.length,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.write(bytes);
    req.end();
  });
}

/* ---------------------------------- 主流程 ---------------------------------- */

(async () => {
  const bytes = fs.readFileSync(file);
  const filename = path.basename(file);
  const mime = filename.endsWith(".apk")
    ? "application/vnd.android.package-archive"
    : "application/octet-stream";

  console.log(`仓库 : ${repo}`);
  console.log(`tag  : ${tag}`);
  console.log(`文件 : ${filename}（${(bytes.length / 1048576).toFixed(2)} MB）`);

  const rel = await api("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (rel.status !== 200) {
    console.error(`找不到 tag ${tag} 对应的 Release（HTTP ${rel.status}）。先让 Release 工作流跑完。`);
    process.exit(1);
  }
  const release = JSON.parse(rel.text);
  console.log(`Release: ${release.name}（当前 ${release.assets.length} 个附件）`);

  for (const asset of release.assets) {
    if (asset.name === filename) {
      console.log(`已有同名附件，先删掉旧的（id ${asset.id}）`);
      const del = await api("DELETE", `/repos/${repo}/releases/assets/${asset.id}`);
      if (del.status !== 204) {
        console.error(`删除旧附件失败：HTTP ${del.status}`);
        process.exit(1);
      }
    }
  }

  const up = await upload(release.upload_url, filename, mime, bytes);
  if (up.status !== 201) {
    console.error(`上传失败：HTTP ${up.status}`);
    const msg = ((JSON.parse(up.text || "{}") || {}).message) || "";
    if (msg) console.error(`GitHub 说：${msg}`);
    process.exit(1);
  }
  const asset = JSON.parse(up.text);
  console.log("");
  console.log(`✅ 已上传：${asset.name}`);
  console.log(`   ${asset.browser_download_url}`);
})().catch((error) => {
  console.error("出错了：" + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
