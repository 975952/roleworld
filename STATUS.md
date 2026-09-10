# 项目状态 · 角色世界（RoleWorld）

> 最后更新：2026-09-10 · 当前版本 **v0.1.10**
> 仓库：https://github.com/975952/roleworld （MIT）

---

## 一、这是什么

一个**完全本地**的 AI 角色对话应用：没有服务器、没有账号、没有遥测。
角色卡、对话记录、记忆书、API Key 全部只存在用户自己的设备上，请求从用户设备
**直接**发给用户自己配置的模型接口。

支持三件事：**角色对话**（`index.html`）、**剧情模式**（`magic-map.html`，多角色同场 + 导演模式）。
网页版与桌面版是**同一份前端代码**。

---

## 二、怎么下载桌面版

**下载页**：https://github.com/975952/roleworld/releases

每个 Release 下面有 **Assets** 区，点这个文件：

```
RoleWorld_0.1.10_x64-setup.exe      ← 就是安装包（NSIS 安装向导），1.31 MB
```

> ⚠️ Release 页面上还有两个 **Source code (zip / tar.gz)** —— 那是源码压缩包，
> **不是**安装包，别点错。要找的是 `..._x64-setup.exe`。

**安装步骤**

1. 双击 `RoleWorld_0.1.10_x64-setup.exe`；
2. Windows 会弹 **SmartScreen「Windows 已保护你的电脑」** —— 因为安装包**没有买代码签名证书**。
   点 **「更多信息」→「仍要运行」** 即可（这是正常的，不是病毒提示）；
3. 跟着向导点下去，装完开始菜单里会有「RoleWorld / 角色世界」；
4. 第一次打开会强制走三步引导，**第二步直接粘贴 API Key** → 点「保存并测试」→ 看到
   「连接正常」→ 开始用。

**为什么这么小（1.3 MB）**：Tauri 用系统自带的 WebView2 渲染，不打包 Chromium。

**不装也能用**：仓库里 `node scripts/serve.cjs` 起个本地服务，浏览器打开
`http://127.0.0.1:8080/app/index.html` 就是网页版，功能完全一样（数据存在浏览器里，
与桌面版的数据目录相互独立）。

---

## 三、现在能做什么

### 对话页
- **模型**：顶栏直接切模型；服务商支持 DeepSeek 官方 / OpenAI / OpenRouter / 硅基流动 /
  自定义（llama.cpp、Ollama、LM Studio 等任何 OpenAI 兼容端点）。Key 存本机。
- **思考模式**：默认关闭（不再先闪一段思维链再被正文顶掉），可开。
- **费用**：输入框上方实时显示本对话的 token 用量与估算费用。单价按官方价内置
  （Flash 系列闲时 ¥1/¥4、V4 Pro 闲时 ¥4.5/¥13.5），**按北京时间判断峰谷**（高峰 ×2），
  也可以在设置里自己填单价。
- **记忆**：**每个角色一套记忆**（不再是只有 Harry 有），跨对话保留；命名规则
  `MB <角色短名> — <书名>`。
- **自动记忆（agent 式）**：模型会自己把值得记住的要点写成 `[[记住: …]]`，前端剥掉标记、
  写进该角色的「自动记忆」书，常驻上下文、上限 50 条。可在设置里关。
- **角色卡**：导入 `.json` / `.png` / `.charx`；也能让 AI 帮你写卡。
- **多会话**：同一角色可以有多个对话（不同世界线），记忆共享。

### 剧情模式
- 多角色同场演出，带**点名规则**（谁在跟谁说话）与**导演模式**（玩家不在场也能推进）。
- 场景自由书写，或选通用预设，或取角色卡自带场景 —— 不绑定任何世界观。

### 外观
- 主题：暗 / 亮。
- **风格（配色）6 种**：默认（石墨）/ 羊皮纸 / 水墨 / 深林 / 樱 / **返校金**。
  对话页与剧情模式一起变。
- **界面大小**：90%–120% 七档，5% 一档；`Ctrl/⌘` + `-` / `=` 调、`Ctrl/⌘` + `0` 复位。
- 显示密度、动效、秋季金色氛围开关。

### 数据
- 桌面版全部是**磁盘上的普通文件**，可直接备份 / 编辑 / 用 Git 管：
  `%APPDATA%\app.roleworld.desktop\data\`
  （`characters/` `chats/` `worlds/` `kv/` `blobs/`）
- 「设置 → 关于 → 导出存档 / 导入存档」用于换机器迁移。

---

## 四、技术形态

```
roleworld/
  app/                     前端（原生 HTML/CSS/JS，零构建、零依赖）
    adapter/               本地适配层
      index.js             门面：STApi 兼容形状 + RoleWorld.* 干净接口
      store.js             数据层（IndexedDB；桌面端换文件系统实现）
      desktop.js           Tauri 文件系统后端
      model.js             直连 OpenAI 兼容端点（流式返回原始 Response）
      cards.js             PNG tEXt / CHARX / CCv2 / CCv3 解包
      pricing.js           价格表 / 峰谷 / token 估算
      packs.js             内容包安装
      settings-ui.js       模型设置面板
      archive-ui.js        存档导出导入
      onboarding.js        首次引导（强制走完）
    tokens.css             全站设计变量（配色 / 风格 / 氛围）★改设计看这里
    styles.css             对话页样式
    magic-map.css          剧情模式样式（已改成与主界面同一套变量）
    zoom.js                界面大小快捷键
    task22-core.js         提示词编排（角色卡 + 记忆书 + 样例对话）
    task29-character-core.js  AI 写卡 + 角色记忆归属
  packs/harry-potter/      内置内容包（6 张 CCv3 卡 + 4 本记忆书，同人非商业）
  src-tauri/               桌面外壳（Tauri v2，8 个受限文件命令）
  scripts/                 本地服务器 / 图标 / 打包前准备 / 版本号
  tests/                   回归测试
  docs/                    PORTING.md（迁移与设计说明）/ PUBLISH.md / RELEASE_CHECKLIST.md
```

**桌面外壳刻意不用 Tauri 的 fs 插件**：那要在 capabilities 里配一长串路径通配符，
范围不好收。改成自己开 8 个命令 + 文件名白名单校验，可访问范围钉死在应用数据目录内。

---

## 五、测试与流水线

| | |
|---|---|
| `node tests/adapter-unit.cjs` | **42/42** —— 数据层、请求翻译、SSE、ZIP、价格、记忆归属、草稿解析、BOM 检查 |
| `node tests/local-app-check.cjs` | **22/22** —— 无头 Chrome 跑真实页面（合成 fixture + 假模型端点，不联网） |
| `node tests/desktop-smoke.cjs` | 1/1 —— 启动真 exe，验证数据真的落盘 |
| CI（`.github/workflows/ci.yml`） | 每次 push 在 Windows 上跑前两项 |
| Release（`.github/workflows/release.yml`） | 推 `v*` 标签 → 自动构建 NSIS 安装包并挂到 Release |

发版：`node scripts/set-version.cjs 0.1.11` → commit → `git push` → `git tag -a v0.1.11` → push 标签。

---

## 六、已知问题 / 待办

- [ ] **主界面信息架构**：目前左栏以「对话」为主体、角色是隐含的二级概念。计划改成
      **按角色组织**（一级是角色，对话挂在角色下面，新对话变成角色行上的 `＋`）。**待开工**。
- [ ] **设计**：按钮目前是统一的细边框风格，视觉上偏"通用 AI 味"，计划重做视觉
      （玻璃质感 / 更柔和的层级）。**已交给外部设计**，落地文件见上面 `tokens.css` 等。
- [ ] macOS / Linux 构建：Tauri 配置已留好，`release.yml` 里 matrix 项注释着，取消注释即可
      （macOS 正式发布需要代码签名证书）。
- [ ] PWA（可装到手机桌面）、Android（Capacitor）：未开工。
- [ ] `app.js` 里还残留少量账号时代的死代码（入口已隐藏，未物理删除）。
- [ ] 免费体验额度（送 100 条）：**未做**。纯本地应用里无法真正限制 —— Key 会随程序发出去、
      计数存在用户机器上，两条都能绕过；要真限制必须加中转服务（会破坏"无中转"的承诺）。
      目前策略是「不发 Key，只把填 Key 的过程做到最顺」。

---

## 七、服务器

旧的 SillyTavern 公网站点已停用，**服务器可以关机**：
唯一不可再生的用户数据（27 个账号 / 374 段对话 / 734 张角色卡，310 MB）已备份回
`C:\novel-llm\runs\2026-09-09-back-to-school-surprise\server-user-data-backup\`。
roleworld 完全不依赖服务器。
