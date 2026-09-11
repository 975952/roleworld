# 网站部署分支

本分支只负责将 `app/` 发布为静态网站。桌面应用继续使用 `main` 分支，不从本分支构建安装包。

## CloudBase 静态托管

部署目录是 `app/`。发布前运行 `node scripts/prepare-desktop.cjs`，它会把仓库内的 `packs/` 同步到 `app/packs/`；该目录是构建产物，不提交到 Git。

使用腾讯云 CloudBase CLI 时：

```text
tcb hosting deploy app -e <CloudBase 环境 ID>
```

网站根目录必须能直接访问 `index.html`，并保留 `magic-map.html`、`about.html`、`adapter/` 和 `packs/` 的相对路径。

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
