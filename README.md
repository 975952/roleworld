# 角色世界 · RoleWorld

> 本地优先、完全开源的 AI 角色对话应用。没有服务器，没有账号，没有遥测。
> 角色卡、对话记录、记忆书、API Key 全部只存在你自己的设备上。

**English** — A local-first, fully open-source AI roleplay chat app. No backend, no accounts,
no telemetry. Character cards, chat history, memory books and API keys live only on your own
device. MIT licensed. [Jump to English](#english)

---

## 它是什么

一个可以直接和角色卡聊天的网页应用，外加一个通用的 AI 助手页和一个多人剧情模式：

| 页面 | 作用 |
|---|---|
| `app/index.html` | 角色对话。导入 CCv2 / CCv3 / PNG / CHARX 角色卡，支持流式回复、多会话管理、记忆书（世界书） |
| `app/magic-map.html` | 剧情模式。多角色同场演出，带点名规则与「导演模式」（你不在场也能推进剧情） |
| `app/assistant.html` | 通用 AI 助手。和角色卡无关的日常问答，可开思考模式 |

## 为什么是「本地优先」

原来的版本跑在一台服务器上，用 SillyTavern 做后端。这一版把后端整个去掉了：

- **数据在本机** —— 角色卡、对话、记忆书存在浏览器的 IndexedDB 里；
- **没有账号系统** —— 只有一个本地档案，不需要注册、不设密码、不会同步；
- **模型直连** —— 请求从你的设备直接发给你配置的模型接口，中间没有任何中转；
- **可以自己验证** —— 全部代码在这个仓库里，没有混淆、没有打包、没有构建步骤，读得懂就能改。

代价也说清楚：没有人替你备份。换电脑前记得用「设置 → 关于 → 导出存档」存一份。

## 快速开始

不需要安装任何依赖，也不需要构建：

```bash
git clone <这个仓库>
cd roleworld
python -m http.server 8080     # 或者任意静态服务器
```

浏览器打开 <http://127.0.0.1:8080/app/index.html>。

> 直接双击 `index.html`（`file://`）在部分浏览器里无法使用本地数据库，请用上面的本地服务器方式。

然后：

1. 打开「设置 → 模型」，选择服务商（DeepSeek 官方 / OpenAI / OpenRouter / 硅基流动 / 自定义），
   填入接口地址与 API Key；
2. 点「测试连接」确认能通；
3. 回到对话页，导入一个角色卡（`.json` / `.png` / `.charx`），开始聊天。

### 用本地模型

「设置 → 模型」里把服务商选成 **自定义 / 本地模型**，接口地址填你的推理服务：

- llama.cpp：`http://127.0.0.1:8080/v1/chat/completions`
- Ollama：`http://127.0.0.1:11434/v1/chat/completions`
- LM Studio：`http://127.0.0.1:1234/v1/chat/completions`

模型名按服务里实际的模型 ID 填。API Key 留空即可。

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
node tests/adapter-unit.cjs      # 数据层 / 请求翻译 / SSE / ZIP（不需要浏览器）
node tests/local-app-check.cjs   # 无头 Chrome 端到端：三个页面真的能跑起来
```

`local-app-check.cjs` 会自己起一个静态服务器和一个假的 OpenAI 兼容端点，
不联网、不用真实模型；需要本机装有 Chrome 或 Edge（可用 `CHROME_PATH` 指定）。

## 项目状态

已完成：本地适配层、去掉账号系统、三个页面接入适配层、内容包机制（含哈利·波特内置包）、
存档导出导入、回归测试（13 项端到端 + 19 项单元）。

计划中（见 issue / roadmap）：

- [ ] 桌面端打包（Tauri v2 → Windows `.exe` / macOS / Linux）
- [ ] PWA（manifest + service worker，可装到手机桌面）
- [ ] Android / iOS 打包
- [ ] 把 `app.js` / `assistant.js` 里残留的账号相关死代码彻底删掉（目前只是隐藏入口）
- [ ] 更细的生成参数面板（温度 / 上下文长度 / 预设）

## 目录结构

```
app/                 前端（原生 HTML/CSS/JS，无构建）
  adapter/           本地适配层：数据、模型、角色卡、内容包
  integration.js     角色对话页逻辑
  magic-map.js       剧情模式逻辑
  assistant.js       通用 AI 页逻辑
  task22-core.js     提示词编排（角色卡 + 记忆书 + 样例对话）
packs/               内容包（默认是空的）
tests/               回归测试
docs/PORTING.md      从 SillyTavern 迁移的对照表与设计说明
```

## 许可

[MIT](LICENSE)。可以自由使用、修改、分发，包括商业用途。

---

## English

**RoleWorld** is a local-first AI roleplay chat app with **no backend and no accounts**.

- Character cards, chat history, memory books and API keys are stored on your own device
  (IndexedDB + localStorage) — nothing is uploaded anywhere except your own model requests.
- You bring your own model: DeepSeek, OpenAI, OpenRouter, SiliconFlow, or a local
  llama.cpp / Ollama / LM Studio server. Requests go straight from your device to that endpoint.
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
paste your API key (or point at your local inference server), and import a character card.

### Import format

CCv2 / CCv3 JSON, PNG cards (embedded `chara` / `ccv3` chunks) and `.charx` containers.
Data formats follow the SillyTavern conventions, so cards and chats move between the two.

### Fan work notice

Any character packs under `packs/` are fan-made derivative works, provided for personal,
non-commercial use only. All rights belong to the original creators; this project is not
affiliated with or endorsed by them. Rights holders can request removal via an issue.

### License

[MIT](LICENSE).
