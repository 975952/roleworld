# 角色世界 · RoleWorld（网站部署分支）

> 面向国内访问的静态网站版 AI 角色对话应用。没有业务后端，没有账号，没有遥测。
> 角色卡、对话记录、记忆书、API Key 全部只存在用户自己的设备上。

**English** — A local-first, fully open-source AI roleplay chat app. No backend, no accounts,
no telemetry. Character cards, chat history, memory books and API keys live only on your own
device. MIT licensed. [Jump to English](#english)

---

## 它是什么

一个可以直接和角色卡聊天的网页应用，外加一个通用的 AI 助手页和一个多人剧情模式：

| 页面 | 作用 |
|---|---|
| `app/index.html` | 角色对话。导入 CCv2 / CCv3 / PNG / CHARX 角色卡，支持流式回复、多会话管理、记忆书（世界书），还可以让模型帮你写角色卡 |
| `app/magic-map.html` | 剧情模式。多角色同场演出，带点名规则与「导演模式」（你不在场也能推进剧情） |

## 网站版怎么工作

原来的版本跑在一台服务器上，用 SillyTavern 做后端。网站版把后端整个去掉了：

- **数据在本机** —— 角色卡、对话、记忆书存在浏览器的 IndexedDB 里；
- **没有账号系统** —— 只有一个本地档案，不需要注册、不设密码、不会同步；
- **模型直连** —— 请求从你的设备直接发给你配置的云端模型接口，中间没有任何中转；
- **可以自己验证** —— 全部代码在这个仓库里，没有混淆、没有打包、没有构建步骤，读得懂就能改。

代价也说清楚：没有人替你备份。换电脑前记得用「设置 → 关于 → 导出存档」存一份。

## 数据与隐私：本地保存 ≠ 不上云

这句话必须说明白，免得被"本地优先"四个字误导：

**只有一份请求会离开这台设备** —— 发给**你自己配置的那个模型端点**。它的内容是：

- 角色卡（设定 / 描述 / 性格 / 场景）、该角色的记忆书条目、关系档案（如果你开了伴侣模式）；
- 最近这段对话、按需检索出来的旧对话片段，以及你这一轮输入的内容。

如果那个端点是云端服务（例如 DeepSeek 官方），上面这些就会到达对方服务器并按对方的条款处理。
想完全不出去，只能用你电脑上的本地模型（llama.cpp 等）。

**不会离开设备的**：其他角色的对话与记忆、界面偏好（主题 / 缩放 / 密度 / 动效）、
引导状态与侧栏选择、本机路径。这几条都有自动化用例（`tests/data-integrity.cjs` 的 P0-4）逐条断言。

**API Key** 只保存在本机，发请求时作为鉴权头发给你配置的那个端点，除此之外不发往任何地方；
**导出的存档里也不含它**（换机器要重新填一次）。

应用没有账号系统、没有统计上报、没有崩溃收集。想看清"这一次到底发了什么"，
点输入框旁边的「本次请求」；想在按发送**之前**就知道大概花多少、会带多少内容，
看输入框左下角那一行（发送前预估）。

## 快速开始

### 网页版

不需要安装任何依赖，也不需要构建：

```bash
git clone <这个仓库>
cd roleworld
node scripts/serve.cjs          # 或者 python -m http.server 8080
```

浏览器打开 <http://127.0.0.1:8080/app/index.html>。

> 直接双击 `index.html`（`file://`）在部分浏览器里无法使用本地数据库，请用上面的本地服务器方式。

第一次打开会有一个五步教程（配模型 / 内置角色 / 数据在哪 / 怎么开始）；
跳过后不再出现，想再看一次去「设置 → 关于 → 再看一次教程」。

### 桌面版（Windows）

桌面版和网页版是**同一份前端代码**，区别只有一个：数据存成磁盘上看得见的普通文件，
而不是浏览器数据库。想备份，直接拷目录；想看内容，直接用编辑器打开。

直接下载 GitHub Releases 里的 `角色世界_x.y.z_x64-setup.exe` 安装即可
（未做代码签名，SmartScreen 会提示"未知发布者"，选「更多信息 → 仍要运行」）。

想自己构建：

```bash
pnpm install                    # 只装打包工具 @tauri-apps/cli
pnpm desktop:build              # 产出 NSIS 安装程序
```

需要 [Rust 工具链](https://rustup.rs/)；Windows 还需要 MSVC 生成工具与 WebView2
（Windows 10/11 一般自带 WebView2）。

数据目录（应用里「设置 → 关于」也会显示实际路径）：

```
%APPDATA%\app.roleworld.desktop\data\
```

```
data/characters/<角色>.json     角色卡
data/chats/<角色>/<对话>.json    对话记录
data/worlds/<记忆书>.json        记忆书
data/kv/<键>.json               设置与偏好
data/blobs/<id>                 头像等图片
```

> macOS / Linux 的构建配置已经在 `src-tauri/` 里留好（Tauri 本身跨平台），
> 但当前没有出包 —— 见 `.github/workflows/release.yml` 里被注释掉的 matrix 项。

然后：

1. 打开「设置 → 模型」，选择服务商（DeepSeek 官方 / OpenAI / OpenRouter / 硅基流动 / 自定义），
   填入接口地址与 API Key；
2. 点「测试连接」确认能通；
3. 回到对话页，导入一个角色卡（`.json` / `.png` / `.charx`），开始聊天。

### 模型服务要求

网站版使用 DeepSeek、OpenAI、OpenRouter、硅基流动或其他支持浏览器跨域访问的云端 OpenAI 兼容接口。
自定义服务必须使用 HTTPS，并填写对应 API Key；网站不会替用户保存或转发 Key。

## 内置内容包

应用代码本身不含任何角色数据。角色、记忆书、示例对话都以「内容包」的形式放在 `packs/` 目录下，
应用启动时自动安装缺失的部分（**绝不覆盖你改过的内容**）。

```
packs/index.json                     # 内容包清单（在这里登记 / 注销一个包）
packs/<包名>/characters/<头像>.png    # CCv3 角色卡（PNG 自带立绘）
packs/<包名>/worlds/<名字>.json       # 世界书 / 记忆书
packs/<包名>/pack.json               # 包的说明与授权信息
```

仓库目前自带一个内容包：

| 包 | 内容 |
|---|---|
| `harry-potter` | 6 张角色卡（Harry、Tom Riddle、Ron、Hermione、Ginny、Luna）+ 4 本记忆书 |

**不想要它**：删掉 `packs/harry-potter/` 目录并把 `packs/index.json` 里的条目去掉即可，
应用会以空书架启动（已验证：没有角色卡时给提示而不是报错）。
想换成别的题材，照上面的结构放一个新包就行。

### 同人作品声明

`packs/` 下可能包含社区制作的同人角色卡。这些内容：

- 仅供个人、非商业用途；
- 版权归原作者及权利方所有，本项目与其无任何关联，也未获其授权或背书；
- 如果你是权利方并希望下架某份内容，请提 issue，我们会立即删除。

## 从 SillyTavern 迁移

沿用 SillyTavern 的数据格式（CCv2 / CCv3 角色卡、JSONL 对话、World Info 世界书），所以：

- 角色卡：SillyTavern 导出的 `.png` / `.json` / `.charx` 可以直接导入；
- 存档：用「导出存档」得到的 `.zip` 里是纯 JSON + 原始图片，可以被脚本处理。

## 测试

```bash
npm test                         # 全部 8 个套件（约 4 分钟，全部离线、不碰真实模型）
node tests/adapter-unit.cjs      # 数据层 / 请求翻译 / ZIP / 记忆 / 上下文预算 / 仓库卫生（不需要浏览器）
node tests/local-app-check.cjs   # 无头 Chrome 端到端：三个页面真的能跑起来
node tests/desktop-smoke.cjs     # 启动真 exe，验证数据以普通文件落盘（需先 desktop:build）
```

`npm test` 依次跑：`adapter-unit`、`memory-unit`、`search-unit`、`metrics-unit`、
`companion-unit`、`local-app-check`、`viewport-check`、`data-integrity`。
需要本机装有 Chrome 或 Chromium（可用 `CHROME_PATH` 指定）。
CI 在 Windows 与 Linux 上跑，见 `.github/workflows/ci.yml`。

测试口径与当前数字也写在应用内的「设置 → 关于 → 查看说明」页上
（那一页带一段机器可读的 `roleworld-status` JSON）。

## 发布

打包与发布步骤（GitHub 建仓库 / 打标签自动出四平台安装包 / Gitee 镜像 / 本机出包）
见 [docs/PUBLISH.md](docs/PUBLISH.md)。需要凭据的动作全部由你自己执行，
仓库与代码里不会出现任何 token。

## 项目状态

已完成：本地适配层、去掉账号系统、页面接入适配层、内容包机制（含哈利·波特内置包）、
存档导出导入、Windows 桌面端打包、GitHub Actions 自动出包、五阶段功能
（基础聊天 / 上下文管理 / 长期记忆 / 轻量检索 / 伴侣模式）与整套回归测试。

验收清单见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)（逐条对应那张阶段表，写清状态与依据），
出问题先查 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

计划中：

- [ ] macOS / Linux 构建（Tauri 配置已留好，取消 `release.yml` 里 matrix 的注释即可；
      macOS 要正式发布需买签名证书，否则用户打开会看到"未知开发者"）
- [ ] PWA（manifest + service worker，可装到手机桌面；会改变缓存与更新行为，等确认后再做）
- [ ] Android（Capacitor）
- [ ] 语音输入与朗读（要先定录音是否离开设备）
- [ ] 跨设备同步（要先定同步范围与冲突规则）
- [ ] 把 `app.js` 里残留的账号相关死代码彻底删掉（目前只是隐藏入口）
- [ ] 更细的生成参数面板（温度 / 上下文长度 / 预设）

## 目录结构

```
app/                 前端（原生 HTML/CSS/JS，无构建）
  adapter/           本地适配层：数据、模型、角色卡、内容包
  integration.js     角色对话页逻辑
  magic-map.js       剧情模式逻辑
  task22-core.js     提示词编排（角色卡 + 记忆书 + 样例对话）
  task29-character-core.js  AI 写角色卡（payload / 草稿解析 / CCv3 构造）
packs/               内容包（默认自带 harry-potter）
tests/               回归测试
scripts/             本地服务器、图标生成、打包前准备
src-tauri/           桌面端外壳（Tauri v2）
docs/PORTING.md      从 SillyTavern 迁移的对照表与设计说明
docs/PUBLISH.md      打包与发布流程
```

## 许可

[MIT](LICENSE)。可以自由使用、修改、分发，包括商业用途。

---

## English

**RoleWorld** is a local-first AI roleplay chat app with **no backend and no accounts**.

- Character cards, chat history, memory books and API keys are stored on your own device
  (IndexedDB + localStorage) — nothing is uploaded anywhere except your own model requests.
- You bring your own cloud model: DeepSeek, OpenAI, OpenRouter, SiliconFlow, or another
  OpenAI-compatible HTTPS endpoint with CORS enabled. Requests go straight from your device to that endpoint.
- Built-in content ships as optional "packs" under `packs/`; **the repository itself contains
  no character data**.

### Run it

```bash
git clone <this repo>
cd roleworld
python -m http.server 8080
# open http://127.0.0.1:8080/app/index.html
```

No build step, no bundler, no dependencies. Then open **Settings → Model**, choose a provider,
paste your API key, and import a character card.

### Import format

CCv2 / CCv3 JSON, PNG cards (embedded `chara` / `ccv3` chunks) and `.charx` containers.
Data formats follow the SillyTavern conventions, so cards and chats move between the two.

### Fan work notice

Any character packs under `packs/` are fan-made derivative works, provided for personal,
non-commercial use only. All rights belong to the original creators; this project is not
affiliated with or endorsed by them. Rights holders can request removal via an issue.

### License

[MIT](LICENSE).
