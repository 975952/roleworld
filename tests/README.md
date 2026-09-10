# 测试

全部为合成测试：不联网、不调用真实模型、不需要任何账号。

| 文件 | 内容 | 运行 |
|---|---|---|
| `adapter-unit.cjs` | 数据层增删改查、存档导出导入、OpenAI 请求体翻译、SSE 解析、ZIP 读写（含外部工具压缩的 deflate） | `node tests/adapter-unit.cjs` |
| `local-app-check.cjs` | 端到端：起静态服务器 + 假模型端点，用无头 Chrome 打开三个页面，验证启动、流式回复、记忆书、模型配置面板、账号入口不可见；最后清库再启动一次，确认「一本角色卡都没有」时给的是空状态而不是错误页 | `node tests/local-app-check.cjs` |
| `cdp.js` | 极简 CDP 客户端（Node 内置 WebSocket，无依赖），被上面的浏览器用例复用 | — |
| `legacy/fake-st-server.cjs` | 早期「SillyTavern 托管模式」的合成后端。当前应用已不再调用它，保留仅作历史参考 | — |

浏览器用例需要本机装有 Chrome 或 Edge，会自动在常见路径里查找；
也可以用环境变量指定：

```powershell
$env:CHROME_PATH = "D:\Chrome\chrome.exe"; node tests/local-app-check.cjs
```

## 关于 fixture

`local-app-check.cjs` 用 `Page.addScriptToEvaluateOnNewDocument` 注入：

```js
window.__ROLEWORLD_FIXTURE__ = { characters: [...], worlds: [...], chats: [...], settings: {...} };
```

适配层在 `init()` 时把它一次性导入本地数据库（导入过就不再重复）。
这既是测试缝，也是将来做「演示数据 / 首次运行预置内容」的挂载点。
