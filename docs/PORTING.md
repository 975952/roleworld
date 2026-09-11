# 移植说明（SillyTavern → 本地适配层）

这份文档记录「角色世界」从 **服务器 + SillyTavern 后端** 变成 **纯本地应用** 的改造结果。
改造已经完成（P0），下面是最终形态，而不是计划。

## 一、总体做法

页面文件（`integration.js` / `magic-map.js` / `app.js`）原本就是对着
`window.STApi` 这组方法写的。所以改造没有逐个去改那十几处 `fetch`，而是：

**保留方法签名不变，把 `window.STApi` 从「HTTP 客户端」换成「本地适配层门面」。**

```
页面代码 ── window.STApi ──┬─ adapter/store.js   数据（IndexedDB）
                          ├─ adapter/model.js   生成（直连模型接口）
                          ├─ adapter/cards.js   角色卡解包
                          ├─ adapter/zip.js     缓存档打包 / CHARX
                          └─ adapter/packs.js   内置内容包
```

好处是零构建、零打包，页面逻辑一行不改就能跑；同时 `window.RoleWorld` 暴露一套干净的
`adapter.*` 接口，将来换成桌面端（Tauri）或手机端（Capacitor）的实现时，上层同样不用改。

## 二、原来的接口 → 现在谁来实现

| 原来调用（SillyTavern） | 现在 |
|---|---|
| `GET /csrf-token` | 删除。`init()` 直接 resolve，`_token` 固定为 `"local"` |
| `POST /api/users/me` | 本地档案 `{handle:"local", name:"我", admin:false}` |
| 登录 / 注册 / 登出 / 改密 / 注销 / 管理员全部接口 | **删除**。门面上仍保留同名方法，但一律 reject，绝不假装成功 |
| `/api/users/chat-template/status|initialize` | `packs.installAll()` + 统计本地角色与记忆书 |
| `/api/characters/all|get` | `store.listCharacters()` / `getCharacter()` |
| `/api/characters/import` | `cards.parse()` 解包 PNG/CHARX/JSON → 写库 |
| `/api/characters/delete` | `store.deleteCharacter()`（可选连带删对话） |
| `/api/characters/chats`、`/api/chats/get|save|delete` | `store.listChats/getChat/saveChat/deleteChat` |
| `/api/worldinfo/list|get|edit|delete` | `store.listWorlds/getWorld/putWorld/deleteWorld` |
| `/api/settings/get` | 合成一个 ST 形状的 `{settings: "{oai_settings:{custom_url}}", world_names}` |
| `/api/secrets/read|write|delete` | 本机数据库，键形状保持 `{ [key]: [{id,label,value}] }` |
| 模型生成 | `model.js` 直连用户配置的 OpenAI 兼容云端端点 |

## 三、适配层接口

```js
RoleWorld.store    // 数据层：characters / chats / worlds / kv / blobs，可整体导出导入
RoleWorld.model    // 生成：request() 返回原始 Response；complete() 返回聚合结果
RoleWorld.cards    // 角色卡：parse() / normalizeCard() / placeholderAvatar() / toCCv3()
RoleWorld.secrets  // 密钥：get / set / remove（简单）与 read / write / delete（ST 形状）
RoleWorld.assetUrl(avatar)      // 头像 blob URL
RoleWorld.exportArchive() / importArchive(dump, {mode})
RoleWorld.getLocalSettings() / saveLocalSettings(patch)
```

`store.js` 与 `model.js` 和 `zip.js`、`cards.js` 都是 UMD 风格：浏览器里挂到 `global`，
Node 里 `require()` 即可 —— 因此数据层、请求翻译、SSE 解析、ZIP 读写都能在**没有浏览器**的
情况下跑单元测试（见 `tests/adapter-unit.cjs`）。

## 四、必须保持的几个隐性契约

这些是原来页面代码里真实依赖的行为，改适配层时不能破坏（都有测试覆盖）：

1. `init()` 必须 resolve，且 `_token` 必须为真值 —— 旧代码把它当 CSRF 头用。
2. `isAuthRequired()` 恒为 `false` —— 本地版没有登录页，任何错误都不该触发跳转。
3. `getChatTemplateStatus()` 必须四个字段齐全（`ready` / `memoryBookCount` / `modelConnectionReady` / `initialChatReady`），
   否则对话页会卡在模板门。
4. `editWorld()` 之后再 `getWorld()` 必须**原样**返回（JSON.stringify 相等），
   否则记忆回滚校验会报 `MEMORY_ROLLBACK_FAILED`。
5. `importCharacter()` 必须返回 `{file_name}`，并且等于之后 `listCharacters()` 里的 `avatar`。
6. `listChats()` 里每条要有 `file_name` 与可解析的 `last_mes`；`getChat()` 返回的数组**第一行是元数据行**
   （`chat_metadata`），这与 SillyTavern 一致。
7. 生成接口在流式时要返回**原始 Response**，让页面里已有的 SSE 解析（按内容判断 `data:`，
   不看响应头）继续可用。
8. 页面在「自定义模型」模式下会把模型名写成字面量 `"local"`，适配层负责换成用户实际配置的模型名。

## 五、为本地模式额外放宽的地方

原版有几个假设只对「SillyTavern 内置模板」成立，本地版必须放宽：

| 位置 | 原来 | 现在 |
|---|---|---|
| `integration.js` `ensureChatTemplate` | 要求 `memoryBookCount >= 4` 且 `initialChatReady` | 本地模式下只要 `ready` 与 `modelConnectionReady` |
| `integration.js` `loadBooks` | 缺 `MB …` 四本记忆书就抛错 | 本地模式下允许一本都没有 |
| `integration.js` `loadCharacterAndChat` / `refreshCharacterRegistry` | 没有角色卡就抛错 | 本地模式下给空状态，提示去导入 |
| `integration.js` `showAuthGate` | 跳转登录页 | 本地模式下只提示，不跳转 |
| `app.js` / `magic-map.js` 头像地址 | 硬编码 `/characters/<avatar>` | 优先用本机 blob URL |

> 通用 AI 页（`assistant.html` 及其三个文件）已在 2026-09-10 整体移除 —— 用户判断它没有存在
> 必要，聊天能力已经由对话页与剧情模式覆盖。移除时踩到一个坑：`integration.js` 的
> `updateAdminEntry()` 原本以 `#adminAssistantLink` 是否存在作为提前返回条件，而它同时负责
> 把 `userHandle` 交给上层（存储键、界面偏好都靠它），入口一删整个身份链路就静默失效 ——
> 已改成不依赖该入口。

## 六、桌面端（Tauri v2）

`src-tauri/` 是一个很薄的外壳，前端与网页版是**同一份 `app/`**（`frontendDist: "../app"`）。
它只做一件网页做不到的事：把数据存成磁盘上的普通文件。

Rust 侧只有 8 个命令（`rw_read_text` / `rw_write_text` / `rw_read_binary` /
`rw_write_binary` / `rw_list` / `rw_delete` / `rw_clear` / `rw_data_dir`），刻意**没有**用
Tauri 的 fs 插件 —— 那样要在 capabilities 里配一长串路径通配符，范围不好收，前端也能到处读写。
这里把可访问范围钉死在应用数据目录内，文件名走白名单校验（拒绝 `..`、绝对路径、分隔符）。

写文件用「先写临时文件再 rename」，中途崩溃不会留下半截数据。

前端侧对应的是 `app/adapter/desktop.js`：它实现与 `store.js` 里 IndexedDB 后端**完全相同的
接口**（`open/put/get/getAll/delete/clear/keys`），所以 `store.js` 的 `ready()` 只要挑一个实现：

```
桌面端有 __TAURI__  → adapter/desktop.js（文件）
否则有 indexedDB    → IndexedDB
否则                → 内存（测试 / 隐私模式兜底）
```

数据布局：

```
data/characters/<角色>.json
data/chats/<角色>/<对话>.json
data/worlds/<记忆书>.json
data/kv/<键>.json
data/blobs/<id>               图片等二进制
```

内容包在 `app/` 的上一层，浏览器取不到，所以 `scripts/prepare-desktop.cjs` 会在打包前把
`packs/` 复制进 `app/packs/`（该目录在 .gitignore 里）。

## 七、测试

```
tests/adapter-unit.cjs     29 项：数据层增删改查、存档往返、请求体翻译、SSE、ZIP、
                                  端点反查、BOM 检查、角色草稿解析
tests/local-app-check.cjs  14 项：无头 Chrome 打开两个页面，合成 fixture + 假模型端点，
                                  含「内容包自动安装」「停用后空库启动」「思考模式开关」
tests/desktop-smoke.cjs     1 项：启动真正的 exe，验证数据真的以普通文件落盘
tests/legacy/              已废弃的 SillyTavern 假服务器（保留作参考，当前不再被引用）
```

`local-app-check.cjs` 通过 `Page.addScriptToEvaluateOnNewDocument` 注入
`window.__ROLEWORLD_FIXTURE__`，适配层在 `init()` 时一次性导入 —— 这是刻意留的测试缝，
也让「演示数据 / 首次运行预置内容」有地方挂。

页面在启动完全落定时会置 `window.TASK21_READY = true`。
注意**不要**用 `theme-pending` 是否还在来判断启动完成：它在启动第 2 步（身份落定）就被摘掉了，
拿它当信号会在内容包还没装完时就开始操作数据库。

## 八、不能丢的既有资产

- 提示词编排：`task22-core.js` 的 `buildSystemPrompt` / `composeMessages` / `parseGenerateResponse`
- 记忆书（World Info）的条目结构与注入规则
- 剧情模式的点名规则与导演模式（`magic-map.js`）
- 合成测试套件：不用真实模型也能回归
