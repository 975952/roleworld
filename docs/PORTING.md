# 移植对照表（SillyTavern → 本地适配层）

当前 `app/` 里的前端是从线上版本抽出的，仍通过 `window.STApi` 调用 SillyTavern 的接口。
P0 的目标是把这些调用全部换成 `app/adapter/` 里的本地实现，让应用**不需要任何后端**。

## 一、要替换的接口

| 现在调用（SillyTavern） | 用途 | 本地实现 |
|---|---|---|
| `GET /csrf-token` | CSRF 令牌 | 删除（无会话概念） |
| `POST /api/users/me` | 当前身份 | 本地档案 `profile.json`（名字、头像、设置） |
| `POST /api/users/login` `/register` `/logout` `/change-*` `/delete-self` | 账号体系 | **删除**（本地档案切换代替） |
| `POST /api/users/get` `/enable` `/disable` `/promote` `/demote` `/delete` | 管理员 | **删除** |
| `POST /api/users/chat-template/status` `/initialize` | 首登铺设角色模板 | 首次运行时用 `packs/` 初始化 `data/characters/` |
| `POST /api/characters/all` `/get` | 角色卡列表 / 完整卡 | 读 `data/characters/*.png|*.json`（CCv3，复用现有解析代码） |
| `POST /api/characters/import` `/delete` | 导入 / 删除卡 | 复制文件进 `data/characters/`、从目录删除 |
| `POST /api/characters/chats` `/api/chats/get` `/save` `/delete` | 聊天记录 | `data/chats/<角色>.jsonl`（沿用 ST 的 JSONL 结构） |
| `POST /api/worldinfo/list` `/get` `/edit` `/delete` | 世界书 / 记忆书 | `data/worlds/*.json`（沿用 ST 的 `{entries:{uid:{...}}}` 结构） |
| `POST /api/settings/get` | 生成参数（`custom_url` 等） | 本地设置（模型、端点、采样参数） |
| `POST /api/secrets/write` `/read` `/delete` | API Key | 钥匙串（桌面）/ Keychain（手机）/ localStorage（Web，带风险提示） |
| `POST /api/backends/chat-completions/generate` | 生成 | 直连 `https://api.deepseek.com/chat/completions`（或用户填的 OpenAI 兼容端点），SSE 流式 |

## 二、适配层接口（四个）

```js
// app/adapter/index.js —— 三个平台实现同一组接口
export const storage = {
  listCharacters(), getCharacter(id), importCharacter(file), deleteCharacter(id),
  listChats(charId), getChat(charId, chatId), saveChat(charId, chatId, messages), deleteChat(charId, chatId),
  listWorlds(), getWorld(name), saveWorld(name, data), deleteWorld(name),
};
export const model = { generate({ messages, model, stream, onDelta, signal }) };
export const secrets = { get(key), set(key, value), remove(key) };
export const archive = { exportAll(), importAll(zipFile) };   // 存档导出/导入
```

实现：`adapter/web.js`（IndexedDB + fetch + localStorage + File API）、
`adapter/tauri.js`（P1）、`adapter/capacitor.js`（P4）。

## 三、改造顺序（每一步都能单独跑测试）

1. 加 `adapter/` 与 `app/config.js`（模型设置、数据目录、档案）
2. 角色对话页 `index.html` + `integration.js`：`STApi.*` → `adapter.storage.*` / `adapter.model`
3. 通用 AI 页 `assistant.html`：同上（生成走 `adapter.model`）
4. 剧情模式 `magic-map.html`：同上（它已经复用 `TASK22_CORE` 的提示词编排）
5. 账号相关 UI 删除；`terms.html` → `about.html`（关于 + MIT + 同人声明）
6. 存档导出/导入 zip；SillyTavern 数据导入向导
7. 测试迁移：`tests/` 下用 `fake-st-server.cjs` 的用例改为驱动适配层（内存实现），
   浏览器用例保留（合成后端 → 内存适配层）

## 四、不能丢的既有资产

- **提示词编排**：`task22-core.js` 的 `buildSystemPrompt` / `composeMessages`（角色卡 + 记忆书 + 样例对话）
- **CCv3 读写**：PNG 卡解析/写回、CHARX 容器
- **剧情模式的点名规则与导演模式**（见 `magic-map.js` 的 `sceneDirective`）
- **合成测试套件**：不用真实模型即可回归
