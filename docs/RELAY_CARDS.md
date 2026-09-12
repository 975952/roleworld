# 体验卡：把应用发给不会配 Key 的同学

## 一句话原理

真 API Key **只存在你自己搭的中转服务里**；同学拿到的是一张**可限额、可到期、可随时吊销**的卡号。
卡号在中转那边就是通行证，所以对应用来说"用体验卡"= 把接口地址指向中转、把卡号填进密钥位 ——
**应用本身不需要任何特殊通道**，也不需要知道真 Key。

```
同学浏览器 ──(卡号当 Bearer)──▶ 你的中转（relay/）──(真 Key)──▶ DeepSeek
     ▲                                │
     └── 聊天记录只留在本机 IndexedDB    └── 只记用量：次数 / token / 时间；**不记正文**
```

## 目录

| 路径 | 作用 |
|---|---|
| `relay/server.js` | 中转服务（OpenAI 兼容、SSE 原样透传、卡校验、用量记账、管理接口） |
| `relay/store.js` | 账本：memory / file / cloudbase 三种后端；存的是**卡号哈希** |
| `relay/index.js` | 服务入口（`npm run relay`） |
| `relay/scf.js` | 云函数降级适配（**没有流式**，只在没法用容器时考虑） |
| `relay/Dockerfile` | 容器镜像（云托管用） |
| `scripts/card-cli.cjs` | 本机发卡 / 列卡 / 停卡 / 吊销 / 生成给同学的话（`npm run cards`） |
| `tests/relay-check.cjs` | 20 项端到端回归（含两条硬规矩） |
| `app/adapter/card.js` | 应用侧：解析卡号、查额度、自动配置 |

## 一、把中转跑起来

### 本机先试（不花钱、不联网也能验）

```powershell
$env:UPSTREAM_KEY="sk-你自己的真Key"
$env:ADMIN_SECRET="自己定一串长口令"
$env:CARD_STORE="file"          # 本机试就用 file；memory 重启即丢
$env:CARD_FILE="C:\novel-llm\roleworld\relay-data\cards.json"
npm run relay                    # 默认 :8787
```

### 云托管（推荐，有流式）

云托管是容器，SSE 能原样透传（云函数不行）。先在 CloudBase 控制台开通**云托管**，然后：

```powershell
tcb cloudrun deploy roleworld-relay --dir relay -e cyan1-d2gpky2z903b86182
```

需要在服务里配置的环境变量（**不要在仓库里写**）：

| 变量 | 说明 |
|---|---|
| `UPSTREAM_KEY` | 真 API Key，只有服务端知道 |
| `ADMIN_SECRET` | 发卡口令，**不设就等于关闭管理接口** |
| `CARD_STORE` | `cloudbase`（重启不丢）或 `file`（要挂持久盘） |
| `ALLOW_MODELS` | 例如 `deepseek-flash`，防止同学用贵模型 |
| `PORT` | 默认 8787 |

> ⚠ 账本用 `memory` 时重启会把所有卡弄丢，服务启动时会打一行大字提醒；
> `file` 后端在容器里必须挂持久盘（否则重启一样丢）。云托管上最稳的是 `cloudbase`。

## 二、发卡

```powershell
$env:RELAY_URL="https://你的中转地址"      # 不要带 /v1/chat/completions
$env:ADMIN_SECRET="你设的那串口令"

npm run cards -- issue --label 小明 --calls 200 --days 30
```

会打印一段**可以直接转发的话**（含卡号、怎么用、隐私说明）。想再要一次那段话：
`npm run cards -- text RW-XXXXX-XXXXX-XXXXX`。

其他命令：

```powershell
npm run cards -- list                     # 谁用了多少、什么时候到期
npm run cards -- disable <卡id>           # 临时停（比如同学说不用了）
npm run cards -- enable  <卡id>
npm run cards -- revoke  <卡id>           # 彻底吊销，之后这张卡就是"不认识"
npm run cards -- quota   RW-XXXXX-XXXXX-XXXXX
```

## 三、同学怎么用（越短越好）

最省事的是给他**一条链接**：

```
https://<应用地址>/#card=RW-XXXXX-XXXXX-XXXXX@https://<中转地址>
```

点开就自动配好了（应用会写接口地址、把卡号存进本机密钥位，并显示"剩几次"）。
手动的话是三步：设置 → 模型 → 把「体验卡」那一栏粘上卡号（或整条链接）→ 点「使用体验卡」。

## 四、两条硬规矩（写进代码，也有测试守着）

1. **不记正文**：中转的日志只有 `时间 / 卡 id / 模型 / 是否流式 / 状态 / 耗时 / 用量`。
   `tests/relay-check.cjs` 里专门有一条：把一句独特的话发过去，然后断言日志里**找不到这句话**。
2. **账本只有哈希**：入库的是 `sha256(卡号)`，不是卡号本身；列卡接口也不返回卡号。
   同一条用例：翻遍账本断言找不到卡号明文。

## 五、你必须自己知道的三件事

- **技术和法律上你都是"中转方"**：你能看到用量（看不到正文，前提是你按上面这样跑，别自己加日志）；
  服务商条款一般不允许公开转售或分发 Key —— **给同学小范围试用没问题，别做成公开发卡平台**。
- **卡号泄漏的后果可控**：别人拿到也能用，但只能用到额度上限、且你随时能吊销；
  这跟"把真 Key 发出去"是两回事。
- **隐私说明要跟着卡一起发**：那段自动生成的话里已经写了"服务端不记录对话内容、聊天记录只在你自己的浏览器里"。
  你要是改代码记了正文，就**必须**把这句话改掉。

## 六、验收

```powershell
node tests/relay-check.cjs      # 20 项，不需要外网、不需要云环境
npm test                        # 十个套件
```

真实链路上再点一遍：用一张测试卡在网页版里聊一轮，然后 `npm run cards -- quota <卡号>` 看次数有没有减 1。
