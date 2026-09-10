# 移植说明（SillyTavern → 本地适配层）

这份文档记录「角色世界」从 **服务器 + SillyTavern 后端** 变成 **纯本地应用** 的改造结果。
改造已经完成（P0），下面是最终形态，而不是计划。

## 一、总体做法

页面文件（`integration.js` / `magic-map.js` / `assistant.js` / `app.js`）原本就是对着
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
| `/api/backends/chat-completions/generate` | `model.js` 直连用户配置的 OpenAI 兼容端点 |

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
| `assistant.js` `start()` | 要求 `user.admin === true` | 不再要求管理员 |
| `app.js` / `magic-map.js` 头像地址 | 硬编码 `/characters/<avatar>` | 优先用本机 blob URL |

## 六、测试

```
tests/adapter-unit.cjs     19 项：数据层增删改查、存档往返、请求体翻译、SSE、ZIP
tests/local-app-check.cjs  11 项：无头 Chrome 打开三个页面，合成 fixture + 假模型端点
tests/legacy/              已废弃的 SillyTavern 假服务器（保留作参考，当前不再被引用）
```

`local-app-check.cjs` 通过 `Page.addScriptToEvaluateOnNewDocument` 注入
`window.__ROLEWORLD_FIXTURE__`，适配层在 `init()` 时一次性导入 —— 这是刻意留的测试缝，
也让「演示数据 / 首次运行预置内容」有地方挂。

## 七、不能丢的既有资产

- 提示词编排：`task22-core.js` 的 `buildSystemPrompt` / `composeMessages` / `parseGenerateResponse`
- 记忆书（World Info）的条目结构与注入规则
- 剧情模式的点名规则与导演模式（`magic-map.js`）
- 合成测试套件：不用真实模型也能回归
