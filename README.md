# 角色世界 · RoleWorld

> **本地优先、零服务器、自带 API Key 的多角色 AI 角色扮演客户端。**
> 角色卡、聊天记录与记忆书全部保存在你自己的电脑上；模型调用只走你自己填的 API
> （默认 DeepSeek，任何 OpenAI 兼容端点都行）。开源 MIT。

*Local-first, serverless AI roleplay client. Your characters, chats and memory books stay
on your own machine; model calls go only to the API key you provide (DeepSeek by default,
any OpenAI-compatible endpoint works). MIT licensed.*

---

## 为什么是「本地优先」

| 常见做法 | 本项目 |
|---|---|
| 租一台 GPU 服务器跑模型，网页连过去 | **不跑模型**，调用你自己的 API |
| 账号、登录、云端存聊天 | **无账号**，数据就是本地文件夹 |
| 服务停了就打不开 | 装在自己电脑上，**离线可用**（只有生成需要联网） |

## 功能

- **角色对话**：CCv3 角色卡（PNG / JSON / CHARX 导入导出）、多角色切换、流式输出
- **记忆书（Memory Books）**：四本分层记忆，可编辑、可修正、可归档
- **剧情模式**：把多个角色放进同一个场景，依次发言；支持点名规则、命运骰子（d20）、
  「我在场 / 我只当导演」两种视角，可导出剧本
- **通用 AI**：不带角色设定的中立助手页
- **数据迁移**：直接读取 SillyTavern 的 `characters/` `chats/` `worlds/` 文件格式

## 快速开始

```bash
# 1. 用任意静态服务器打开 app/（不要用 file:// 直开，浏览器会拦跨域）
cd app && python -m http.server 8080
# 2. 浏览器访问 http://127.0.0.1:8080
# 3. 设置 → 模型 → 选择 DeepSeek，粘贴你自己的 API Key，保存
```

> API Key 只保存在本机，不会上传到任何服务器；本项目没有服务器。

## 目录结构

```
app/        前端（零构建，纯 HTML/CSS/JS）
  adapter/  平台适配层（存储 / 网络 / 密钥 / 导入导出）
docs/       文档（含 PORTING.md：从 SillyTavern 迁移的对照表）
examples/   示例角色卡
locales/    界面文案字典（zh-CN / en）
tests/      合成测试（假后端 + 无头浏览器，不需要真实模型）
```

## 路线图

- [x] P0 抽离为可独立运行的本地版（进行中）
- [ ] P1 Tauri 桌面壳 → Windows `.exe`
- [ ] P2 GitHub Actions 三平台构建（`.dmg` / `.AppImage`）+ GitHub & Gitee 双托管
- [ ] P3 PWA（安卓 / iPhone 可从浏览器安装）
- [ ] P4 Capacitor → 安卓 APK
- [ ] P5 iOS（需要 macOS + Apple 开发者账号）

## 关于内置角色

仓库内的角色包是**玩家自制的同人作品**，仅供个人非商业使用，角色与设定的权利归原作者
所有。若权利人提出要求，相关角色包会立即移除。程序本身不包含任何受版权保护的内容，
你也可以只使用自己创建或导入的角色卡。

## 许可

MIT，见 [LICENSE](LICENSE)。
