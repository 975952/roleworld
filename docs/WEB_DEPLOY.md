# 网站部署分支

本分支只负责将 `app/` 发布为静态网站。桌面应用继续使用 `main` 分支，不从本分支构建安装包。

## CloudBase 静态托管

部署目录是 `app/`。发布前运行 `node scripts/prepare-desktop.cjs`，它会把仓库内的 `packs/` 同步到 `app/packs/`；该目录是构建产物，不提交到 Git。

当前环境：`cyan1-d2gpky2z903b86182`（体验版，2027-03-11 到期），站点
<https://cyan1-d2gpky2z903b86182-1485756522.tcloudbaseapp.com>。

使用腾讯云 CloudBase CLI 时（`--verify` 上传后逐文件校验、`--safe` 发布前备份且失败自动回滚）：

```text
npx --yes --package @cloudbase/cli tcb hosting deploy app ^
  -e cyan1-d2gpky2z903b86182 ^
  --verify --safe
```

这台机器上已全局安装 `@cloudbase/cli`，也可以直接用 `tcb hosting deploy app -e cyan1-d2gpky2z903b86182 --verify --safe`。

网站根目录必须能直接访问 `index.html`，并保留 `magic-map.html`、`about.html`、`adapter/` 和 `packs/` 的相对路径。

### 发布后怎么核对

1. `tcb hosting list -e cyan1-d2gpky2z903b86182`：远端应比本地多出 6 个 CloudBase 自带的
   系统文件（`__auth/*`、`cloud-admin/index.html`），其余必须与 `app/` 一一对应；
2. 逐文件比对线上与本地字节数（带 `Cache-Control: no-cache` 绕开 CDN）；
3. **注意**：CloudBase 边缘防护会对无头浏览器返回「风险提醒」页（HTTP 404），
   而 `curl` / PowerShell 带同样的 User-Agent 能正常拿到 200 —— 所以
   **自动化浏览器验收在这条链路上不可用，最终必须人眼在真实浏览器里点一次**。

## 数据与模型边界

- 角色卡、聊天、记忆书和设置保存在访问者浏览器的 IndexedDB；
- 网站托管只提供 HTML、CSS、JavaScript、JSON 和图片，不保存用户数据；
- 模型请求由浏览器直接发送到用户选择的云端服务商；
- 自定义模型地址必须是 HTTPS 且允许该网站的跨域请求；
- 换设备时使用应用内的「导出存档 / 导入存档」。

## 上线前检查

1. 在本地通过 `npm test`；
2. 重新执行内容包准备脚本；
3. 从 `app/` 部署，不上传 `data/`、`.env`、密钥或桌面端构建目录；
4. 用 CloudBase 默认 HTTPS 域名检查首页、剧情模式、静态资源和 IndexedDB 存取；
5. 再配置已备案域名。 
