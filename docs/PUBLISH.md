# 发布流程（GitHub / Gitee）

这份文档记录怎么把仓库推上去、怎么出包。**任何步骤都不需要把密码或 token 交给别人**：
所有需要凭据的动作都由你自己在本机执行，凭据由 `gh` / `git` 自己保管。

## 一、GitHub

### 1. 登录（只需一次）

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

浏览器里输入终端给出的 8 位代码即可。之后 `gh` 把凭据存在系统凭据管理器里，仓库和代码里都不会出现它。

检查：

```powershell
gh auth status
```

### 2. 建仓库并推送

```powershell
cd C:\novel-llm\roleworld

gh repo create roleworld --public --source=. --remote=origin `
  --description "本地优先的开源角色对话应用：没有服务器、没有账号、没有遥测。MIT。"

git push -u origin main
```

> 仓库名、可见性可以自己改。想用 `main` 以外的分支名，先 `git branch -M <名字>`。

### 3. 打标签，自动出包

`release.yml` 已经在监听 `v*` 标签。推标签就会自动在四个平台上构建，
并把安装包挂到 Releases 里：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

也可以在 Actions 页面手动触发 `Release` 工作流（`workflow_dispatch`）。

产物：

| 平台 | 文件 |
|---|---|
| Windows 10/11 (x64) | `角色世界_0.1.0_x64-setup.exe` |
| macOS (Apple Silicon) | `角色世界_0.1.0_aarch64.dmg` |
| macOS (Intel) | `角色世界_0.1.0_x64.dmg` |
| Linux (x64) | `角色世界_0.1.0_amd64.AppImage` / `.deb` |

### 4. CI

`ci.yml` 在每次 push 和 PR 上跑：`adapter-unit`（无浏览器）与 `local-app-check`
（无头 Chrome + 假模型端点）。两个作业都不联网、不调用真实模型、不需要任何密钥。

## 二、Gitee

Gitee 没有等价的免费构建矩阵，所以策略是：**GitHub 负责出包，Gitee 负责镜像**。

一次性配置（把 `<你的用户名>` 换成实际的）：

```powershell
git remote add gitee git@gitee.com:<你的用户名>/roleworld.git
```

前提是这台机器的 SSH 公钥已经加到 Gitee 账号里（设置 → SSH 公钥）。
生成/查看公钥：

```powershell
ssh-keygen -t ed25519 -C "roleworld"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

之后每次同步（含标签）：

```powershell
git push gitee main --tags
```

Release 附件在 Gitee 网页上手动上传即可：从 GitHub Release 下载安装包，
在 Gitee 的「发行版」里新建一个，把 Windows 安装包传上去。

> 如果不想在 Gitee 放同人内容包，可以先删掉 `packs/harry-potter/` 再推一个分支过去；
> 应用在没有内容包时会以空书架启动（已测试）。

## 三、本机出包（不依赖 CI）

```powershell
cd C:\novel-llm\roleworld
pnpm install
pnpm desktop:build
```

产物：

- 绿色版：`src-tauri\target\release\roleworld.exe`
- 安装包：`src-tauri\target\release\bundle\nsis\角色世界_0.1.0_x64-setup.exe`

打包前会自动跑 `scripts/prepare-desktop.cjs`，把 `packs/` 复制进 `app/packs/`
（该目录不入库）。

自检：

```powershell
node tests\adapter-unit.cjs       # 19 项
node tests\local-app-check.cjs    # 13 项
node tests\desktop-smoke.cjs      # 1 项，需要先 desktop:build
```

## 四、不要提交的东西

`.gitignore` 已经覆盖，但发布前顺手确认一遍：

```powershell
git status --short
git grep -nE "sk-[A-Za-z0-9]{16,}|authtoken=" -- .   # 应该没有输出
```

- 用户的角色卡、对话、存档（`data/`、`profiles/`、`*.jsonl`、`*.zip`）
- API Key、SSH 私钥、任何 token
- `node_modules/`、`src-tauri/target/`、`app/packs/`
