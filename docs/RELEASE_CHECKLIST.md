# Release 校对清单

推 `v0.1.0` 之后照着这份清单逐条核对。每条都写清楚**看哪里**、**期望看到什么**。

## 一、推送是否干净

```powershell
cd C:\novel-llm\roleworld
git status --short          # 期望：没有任何输出
git log --oneline -n 3      # 期望：最新一条是 v0.1.0 前的最后一个 commit
git ls-files | Measure-Object -Line   # 期望：68 行左右
```

仓库里**不应该**出现这些东西（`.gitignore` 已覆盖，但推之前确认一遍）：

```powershell
git ls-files | Select-String -Pattern "node_modules|target/|app/packs/|\.zip$|\.jsonl$|^data/|credentials"
git grep -nE "sk-[A-Za-z0-9]{16,}|authtoken=|Y5yWeb" -- .    # 期望：无输出
```

## 二、GitHub 侧

| 检查 | 期望 |
|---|---|
| 仓库首页 | 能看到中英双语 README、MIT 徽章区、目录树 |
| 分支 | 默认分支为 `main`，且与本地一致 |
| 提交作者 | 全部是 `roleworld <roleworld@users.noreply.github.com>`，不泄露你的邮箱 |
| 内容包 | `packs/harry-potter/` 里 6 张 PNG + 4 个 JSON 都在；README 的同人声明可见 |
| 无构建产物 | 没有 `node_modules/`、`src-tauri/target/`、`app/packs/` |

## 三、Actions 是否跑起来

推 tag 后到 **Actions** 页面，应该看到两个工作流：

**CI**（每次 push 都跑）

- 两个作业：`测试（ubuntu-latest）` 与 `测试（windows-latest）`
- 每个作业里两条绿色步骤：`单元测试（适配层）` 19/19、`端到端测试` 13/13
- 期望全部 ✅

**Release**（推 `v0.1.0` 触发）

- 四个作业：`windows-latest`、`ubuntu-22.04`、`macos-latest --target aarch64-apple-darwin`、`macos-latest --target x86_64-apple-darwin`
- 首次构建约 10–20 分钟（macOS 两个作业最慢）
- 期望全部 ✅

> 如果 Release 只在部分平台失败：Linux 多半是缺系统依赖（`release.yml` 里的 `apt-get` 那段），
> macOS 多半是 target 没装（`dtolnay/rust-toolchain` 的 `targets` 参数）。

## 四、Release 内容

到 **Releases → v0.1.0**：

| 检查 | 期望 |
|---|---|
| 标题 | `角色世界 v0.1.0` |
| 正文 | 有下载对照表、首次打开三步、数据目录（三平台路径）、内容包同人声明、SmartScreen 提示 |
| 附件数量 | 至少 4 个：Windows 安装包、两个 macOS `.dmg`、Linux `.AppImage` 或 `.deb` |
| Windows 附件名 | `角色世界_0.1.0_x64-setup.exe` |
| 体积 | Windows 安装包 1–2 MB（Tauri 走的系统 WebView，所以很小） |

## 五、装完要手动验一遍（这条最重要）

CI 只能证明"编译通过、测试通过"，**装出来的程序能不能用必须自己开一次**：

1. 下载 `角色世界_0.1.0_x64-setup.exe` 并安装（SmartScreen 会提示"未知发布者"，
   选「更多信息 → 仍要运行」——因为我们没买代码签名证书）；
2. 打开程序，确认窗口出现、不是白屏；
3. 进「设置 → 模型」：选 DeepSeek 官方，粘贴 API Key，点「测试连接」，
   期望显示「连接正常：可用」；
4. 回对话页，确认角色选择器显示 `Harry Potter (EN)`，输入框可用；
5. 发一条消息，确认回复是**逐字冒出来**的（流式），不是等半天一次性出现；
6. 关掉程序，检查数据目录里有文件：

   ```
   %APPDATA%\app.roleworld.desktop\data\characters\   6 个文件
   %APPDATA%\app.roleworld.desktop\data\worlds\       4 个文件
   %APPDATA%\app.roleworld.desktop\data\blobs\        6 个文件
   ```

   再打开程序，刚才的对话还在 → 持久化正常。

7. 「设置 → 关于 → 导出存档」下载 zip；「清空本机数据」后再「导入存档」，
   确认角色和对话都回来了。

## 六、Gitee 镜像

Gitee 没有等价的免费构建矩阵，所以策略是 **GitHub 出包、Gitee 镜像代码与安装包**。

一次性配置（前提：本机 SSH 公钥已加到 Gitee 账号）：

```powershell
cd C:\novel-llm\roleworld

# 还没有公钥就先生成，然后把 .pub 内容贴到 Gitee → 设置 → SSH 公钥
ssh-keygen -t ed25519 -C "roleworld"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"

git remote add gitee git@gitee.com:<你的用户名>/roleworld.git
git push gitee main --tags
```

之后每次同步：

```powershell
git push gitee main --tags
```

Release 附件手动上传：从 GitHub Release 下载 Windows 安装包，
在 Gitee「发行版 → 新建」里创建 `v0.1.0`，把安装包传上去，正文可以直接复制 GitHub 那份。

> **不想在 Gitee 放同人内容包**：删掉 `packs/harry-potter/` 与 `packs/index.json` 里的条目，
> 提交到一个分支再推过去即可。应用在没有内容包时会以空书架启动（已测试）。

## 七、出问题时的回滚

- 只是文档/配置错了：改完重新提交，然后 `git push origin main`，Release 不动；
- 安装包有问题：删掉 tag 与 Release 重打 —— GitHub 上删 Release → 删 tag，
  本地 `git tag -d v0.1.0`，修好后重新 `git tag v0.1.0 && git push origin v0.1.0`；
- 千万别用 `git push --force` 覆盖已经发布的 tag。
