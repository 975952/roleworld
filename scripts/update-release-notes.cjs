"use strict";

/*
 * update-release-notes.cjs —— 写 GitHub Release 的说明（带各平台下载表）
 *
 * 用法：
 *   node scripts/update-release-notes.cjs --tag v0.1.54
 *
 * 为什么单独一个脚本：说明里那张"下载"表要**按 Release 上真实存在的附件**生成 ——
 * Windows 的 exe 由 Release 工作流产出，Android 的 APK 是我们手动挂的，
 * 谁缺席都不该在表里出现（否则用户点了 404）。所以这里先读附件列表，再拼说明。
 *
 * 凭据同 upload-release-asset.cjs：`git credential fill`，只用一次、不打印、不落盘。
 */

const { spawnSync } = require("node:child_process");
const https = require("node:https");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const tag = arg("--tag");
if (!tag) {
  console.error("用法: node scripts/update-release-notes.cjs --tag vX.Y.Z [--repo owner/name]");
  process.exit(1);
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: __dirname + "/.." });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

const repo = arg("--repo") || (() => {
  const m = git(["remote", "get-url", "origin"]).match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : "";
})();
if (!repo) {
  console.error("认不出仓库，用 --repo owner/name 指定。");
  process.exit(1);
}

const credit = spawnSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
});
const token = ((credit.stdout || "").match(/^password=(.+)$/m) || [])[1];
if (!token) {
  console.error("git 没有交出凭据，先 git push 一次。");
  process.exit(1);
}

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: "api.github.com",
      path: urlPath,
      method,
      headers: {
        "User-Agent": "roleworld-release-script",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const rel = await api("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (rel.status !== 200) {
    console.error(`找不到 Release ${tag}（HTTP ${rel.status}）`);
    process.exit(1);
  }
  const release = JSON.parse(rel.text);
  const names = release.assets.map((a) => a.name);
  const hasExe = names.some((n) => n.endsWith(".exe"));
  const hasApk = names.some((n) => n.endsWith(".apk"));
  const apkName = names.find((n) => n.endsWith(".apk"));
  const exeName = names.find((n) => n.endsWith(".exe"));

  const rows = [];
  if (hasExe) rows.push(`| Windows 10/11 (x64) | \`${exeName}\` | 双击安装 |`);
  if (hasApk) rows.push(`| Android 7.0+（arm64 / 32 位 arm 通用） | \`${apkName}\` | 传进手机点开安装 |`);

  const androidSection = hasApk ? `
### 安卓怎么装

APK 是 **debug 签名**的（用 Android 自带的调试密钥签的，口令是公开的）：
能自己装、能发给同学，但**不能上应用商店**；而且换一台电脑重新出包时签名会变，
那种情况下要先卸载旧版再装。

1. 把这个 apk 传到手机（微信/QQ/数据线都行），点开；
2. 系统会问「允许安装未知应用」——允许，继续安装；
3. 第一次打开按引导填一次服务商与 API Key（**手机和电脑各存各的**，互不相通）。

手机上的数据存在应用私有目录里，**不像桌面版那样是能用资源管理器打开的普通文件**，
所以备份要走应用里的「导出存档」。

> 顶部那条留白是给前置摄像头/状态栏的（至少 5 毫米，且跟随各机型的挖孔位置）。
` : "";

  const body = `本地优先的开源角色对话应用：没有服务器，没有账号，没有遥测。
角色卡、对话记录、记忆书、API Key 全部只存在你自己的设备上。

### 下载

| 平台 | 文件 | 怎么装 |
|---|---|---|
${rows.join("\n")}

Windows 安装包未做代码签名，SmartScreen 可能提示"未知发布者"，选「更多信息 → 仍要运行」即可。
macOS / Linux 暂未提供构建（Tauri 配置里已留好，见 \`.github/workflows/release.yml\`）。
${androidSection}
### 第一次打开

1. 「设置 → 模型」选服务商（DeepSeek 官方 / OpenAI / OpenRouter / 硅基流动 / 自定义），
   填接口地址与 API Key，点「测试连接」；
2. 回到对话页，内置内容包会自动装好 6 个角色和 4 本记忆书；
3. 也可以换成自己的模型：地址填本地推理服务（llama.cpp / Ollama / LM Studio 的
   \`/v1/chat/completions\`），Key 留空。

### 数据在哪

桌面版全部是磁盘上的普通文件，可直接备份、编辑、用 Git 管理：

\`%APPDATA%\\app.roleworld.desktop\\data\\\`

### 内置内容包说明

\`packs/harry-potter\` 是同人二次创作，仅供个人非商业使用，版权归原作者及权利方所有，
与本项目无关联。不想要它：删掉该目录即可，应用会以空书架启动。

MIT License。`;

  const up = await api("PATCH", `/repos/${repo}/releases/${release.id}`, { body });
  if (up.status !== 200) {
    console.error(`更新说明失败：HTTP ${up.status}`);
    process.exit(1);
  }
  console.log(`✅ 已更新 ${tag} 的说明（下载表里：exe=${hasExe} apk=${hasApk}）`);
  console.log(`   ${release.html_url}`);
})().catch((error) => {
  console.error("出错了：" + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
