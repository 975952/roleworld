# 角色世界 · RoleWorld

**和 AI 角色聊天 / 演剧情的开源应用。** 数据只存在你自己设备上：没有账号、没有服务器、
不上传聊天记录。MIT 许可。

---

## 先看这里：怎么装、怎么开始用

### 1. 下载

👉 **[点这里打开 Releases（所有版本与安装包）](https://github.com/975952/roleworld/releases/latest)**

> Releases 在哪：仓库首页右边那一栏有 **Releases**（中文界面叫「发行版」）；
> 或者直接用它自己的网址 —— `https://github.com/975952/roleworld/releases`。
> 打开后每一个版本下面就是可下载的文件。

| 你想要 | 下哪个文件 | 说明 |
|---|---|---|
| 电脑（Windows 10/11 64 位） | `RoleWorld_x.y.z_x64-setup.exe` | 双击安装。没做代码签名，SmartScreen 会提示「未知发布者」→ 选「更多信息 → 仍要运行」 |
| 手机（安卓） | `RoleWorld_x.y.z_android_universal.apk` | 传到手机点开安装（可能要在系统里允许「安装未知来源应用」）。用的是安卓调试密钥签名，能自己装、能发给朋友，**不能上架应用商店** |
| 什么都不装，先在浏览器里试 | 打开 <https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com> | 网页版，功能和桌面版一样，数据存在这个浏览器里 |

> 三个版本**互不相通**：网页版、桌面版、手机版各自存自己那份数据，模型配置也要各填一次。
> 想在设备之间搬，用「设置 → 数据与备份 → 导出存档」（存档里**不含** API Key）。

### 2. 第一次打开：它会问你「你手上有什么？」

第一次打开是一个两步的分岔，照它走就行：

**A. 有人给了我一张「体验卡」** —— 选这一项，把发卡人给你的**一整行**粘进去：

```
RW-XXXXX-XXXXX-XXXXX@中转地址
```

- ⚠ **必须带 `@` 后面那段中转地址**。只粘卡号在这一台设备上是没用的（会 401）。
- 粘完点「使用体验卡」。**验证点：顶栏右上角会出现「体验卡」徽标**（显示还剩多少次）。
  没有徽标 = 没配上。
- 体验卡是别人（发卡人）搭的中转，你的对话内容会经过那台中转再送到模型 —— 这一点应用里会写明。

**B. 我自己有 API Key** —— 选这一项，填服务商 + Key：

| 服务商 | 去哪拿 Key | 接口地址 |
|---|---|---|
| **DeepSeek 官方（推荐，便宜）** | <https://platform.deepseek.com/api_keys> 充值后创建 | 留空即可，用默认 |
| OpenAI / OpenRouter / 硅基流动 | 各自官网后台 | 留空即可 |
| 自己电脑上的模型（llama.cpp / Ollama / LM Studio） | 不用 Key | 填本机地址，如 `http://127.0.0.1:8080/v1/chat/completions` |

填完点「测试连接」，通了再继续。

### 3. 开始聊天

- 应用自带 6 张《哈利·波特》角色卡（Harry、Tom Riddle、Ron、Hermione、Ginny、Luna）。
  也可以自己导入：**设置 → 角色管理 → 导入角色文件**，支持 `.json` / `.png` / `.charx`
  （SillyTavern、Chub 之类导出的角色卡直接用）。
- 想让它用你自己的设定？**设置 → 角色管理 → AI 创建角色**：写一段自然语言描述，模型帮你写成角色卡。
- 输入框是微信那样的：左边语音、中间打字、右边表情和「+」。**打上字才会出现发送键**。

### 4. 数据在哪 / 怎么备份

| 版本 | 数据位置 | 怎么备份 |
|---|---|---|
| 桌面版 | `%APPDATA%\app.roleworld.desktop\data\`（普通文件，可直接拷） | 直接拷这个目录，或用应用内「导出存档」 |
| 网页版 | 这个浏览器里 | 用应用内「导出存档」 |
| 手机版 | 应用私有目录（看不到） | 只能用应用内「导出存档」 |

**没有人替你备份**：换电脑、清浏览器数据之前记得导出。

---

## 它有哪些功能

| 功能 | 在哪 |
|---|---|
| 角色对话（流式回复、多会话、编辑/重答/从这里开分支/多版本切换） | 主界面 |
| **记忆书**：角色自己记 + 你手写，可改可删、能看每条是从哪句话来的 | 顶栏「记忆」/ 角色面板「记忆」页 |
| **长期记忆 + 历史检索**：隔几天回来还记得，翻得到以前说过的话 | 自动 |
| **伴侣模式**：角色与你的关系、称呼、时间感（只对自定义角色开） | 角色面板「关系」页 / 设置 → 角色管理 |
| **角色语音**：云端合成（火山「豆包语音合成 2.0」，经体验卡中转），一个气泡点一下才播 | 输入框旁「角色语音」（已挪进「+」面板） |
| **表情包**：角色和你都能发 | 输入框旁表情按钮 |
| **剧情模式**：多角色同场演出、点名叫谁说话、导演模式 | 左侧导航「剧情模式」 |
| 聊天记录动画/主题/密度/缩放 | 设置 → 外观与布局 |
| 「本次请求」：看清上一次到底发了什么内容、占多少 token、多少钱 | 输入框「+」→「本次请求」 |

### 几个你可能马上会问的

- **多少钱？** 用 DeepSeek 官方时，一句话大约几厘钱（应用里「本次请求」会给出实测数字与预估）。
  用体验卡就是发卡人那边的额度。**角色语音按字符另外计费**。
- **会不会把我的小说/聊天发出去？** 只有一份请求会离开设备：发给你自己配的那个模型端点
  （角色卡 + 该角色记忆书 + 最近对话 + 你这轮输入）。用体验卡时会经过发卡人的中转。
  没有账号、没有统计上报、没有崩溃收集。详见 [应用内「关于」页](app/about.html)。
- **支持 macOS / Linux 吗？** Tauri 配置已经留好，但当前只出 Windows 与安卓包。
- **能离线用吗？** 网页版可以装成 PWA，断网也能打开界面（数据本来就在本机）；
  但生成回复必须能连到你配的那个模型端点。

---

## 常见问题

**点「使用体验卡」之后卡号被清空、按钮像没反应？**
先确认粘的是**整行**（`卡号@中转地址`）。仍然不行就看顶栏有没有体验卡徽标：
有徽标就是已经配好了（卡号清空是正常的，它已经存进本机了）。

**它说「接口返回 401」？**
401 = 这次请求带的凭据，端点不认。应用会直接告诉你**打到了哪个地址**、带的是
「一个体验卡号 / 一把 API Key / 空凭据」，并给一个能点的下一步（去设置连接方式 / 改用你的卡）。
最常见的原因：换了服务商但没重新填 Key（Key 是按服务商分格子存的）。

**角色说话不带动作描写了 / 语气变了？**
在角色面板或顶栏可以切换「日常聊天」（只有对白，像微信）和「剧情对话」（带旁白）。
这是每种角色回复方式自己的渲染与提示词，切了只影响新回复，不会重写历史。

**手机上按返回键直接把应用关了？**
不会了：现在按返回先关掉最上层的面板，一层都没有了才退出。

**更多问题**：见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

---

## 自己跑源码 / 自己打包

不需要任何构建步骤就能跑网页版：

```bash
git clone https://github.com/975952/roleworld.git
cd roleworld
node scripts/serve.cjs          # 或者 python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/app/index.html
```

> 直接双击 `index.html`（`file://`）在部分浏览器里用不了本地数据库，请用上面的本地服务器方式。

源码分支：主分支 `main`；当前发布线在 `codex/web-deploy`（Releases 里的包由它打出）。

```bash
npm test                         # 全部 14 个套件（离线、不碰真实模型、不花钱）
node tests/local-app-check.cjs   # 只跑真实浏览器那一套
node tests/adapter-unit.cjs      # 只跑数据层/请求翻译那一套

# 打包（需要 Rust 工具链；安卓还需要 JDK 17 + Android SDK/NDK，见 pnpm-lock 与 docs/PUBLISH.md）
pnpm install
pnpm desktop:build                                              # Windows 安装包
node scripts/build-android.cjs --abi universal --release        # 安卓通用包
```

目录结构：

```
app/                 前端（原生 HTML/CSS/JS，无构建、无依赖）
  integration.js     对话页逻辑
  magic-map.js       剧情模式
  back-nav.js        返回手势（网页版与 APK 同一份）
  adapter/           本地适配层：数据、模型请求、角色卡、内容包、设置页
  packs/             内置内容包（默认哈利·波特 6 张卡 + 4 本记忆书）
packs/               内容包仓库格式（角色卡 / 世界书）
relay/               体验卡中转（自己发卡时才需要，服务端）
src-tauri/           桌面端与安卓外壳（Tauri v2）
tests/               回归测试（14 个套件）
docs/                规范与流程：PUBLISH.md（发布）、TROUBLESHOOTING.md、PORTING.md
```

---

## 内置内容包与同人作品声明

`packs/` 下的角色卡是社区制作的**同人二次创作**：

- 仅供个人、非商业用途；
- 版权归原作者及权利方所有，本项目与其无任何关联，也未获其授权或背书；
- 如果你是权利方并希望下架某份内容，请提 issue，我们会立即删除。

不想要它：删掉 `packs/harry-potter/` 目录并去掉 `packs/index.json` 里的条目，
应用会以空书架启动。想换成别的题材，照同样的结构放一个新包即可。

---

## 许可

[MIT](LICENSE)。可以自由使用、修改、分发，包括商业用途。

> 当前版本 **0.1.75**（[Releases](https://github.com/975952/roleworld/releases)；每个版本的本地证据在
> `runs/2026-09-17-local-ux/` 下，最新一份是 `SESSION_0.1.74.md`）。
> 测试口径（14 个套件、当前条数）写在应用内「设置 → 关于 → 查看说明」那一页，带机器可读的 JSON。

---

## English

**RoleWorld** is a local-first, open-source AI roleplay chat app: no backend, no accounts,
no telemetry. Character cards, chat history, memory books and API keys live only on your device.
MIT licensed.

- **Download**: [latest release](https://github.com/975952/roleworld/releases/latest) —
  `RoleWorld_x.y.z_x64-setup.exe` (Windows) or `RoleWorld_x.y.z_android_universal.apk` (Android).
  Or just open the [web build](https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com).
- **First run**: the app asks whether you have an invite card (`token@relay-host`) or your own
  API key (DeepSeek / OpenAI / OpenRouter / SiliconFlow / any OpenAI-compatible HTTPS endpoint,
  or a local llama.cpp/Ollama endpoint). Then import a character card (`.json` / `.png` / `.charx`)
  and start chatting.
- **Run from source**: `node scripts/serve.cjs` and open
  <http://127.0.0.1:8080/app/index.html> — no build step, no dependencies.
- **Data**: IndexedDB (web/Android) or plain files under
  `%APPDATA%\app.roleworld.desktop\data\` (Windows desktop). Back it up yourself:
  there is no cloud sync.

Fan-made character packs under `packs/` are derivative works for personal, non-commercial use
only; all rights belong to their original creators. Rights holders can request removal via an issue.
