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

### 云托管（2026-09-12 实际走通的那条路）

```powershell
tcb cloudrun deploy --service-name roleworld-relay --source relay --port 8787 `
  -e <envId> -r ap-shanghai --force --wait
```

> 第一次要先开通云托管资源，CLI 没有这个命令，用 API 触发一次即可：
> `tcb api tcb CreateCloudBaseRunResource --body '{"EnvId":"<envId>"}'`
> （之后 `tcb api tcb DescribeCloudBaseRunResource --body '{"EnvId":"<envId>"}'` 看 `ClusterStatus` 到 `succ`）
> 部署时如果问"是否灰度发布"，选否；如果提示"平台有部署任务在跑"，确认继续即可。

服务配置里要有的环境变量：

| 变量 | 说明 |
|---|---|
| `UPSTREAM_KEY` | 真 API Key（服务端独有，绝不下发） |
| `UPSTREAM_BASE` | 上游地址，默认 `https://api.deepseek.com` |
| `UPSTREAM_CHAT_PATH` | 上游聊天路径，默认 `/v1/chat/completions`；云开发网关填 `/chat/completions` |
| `ADMIN_SECRET` | 发卡口令，**不设就等于关闭管理接口** |
| `CARD_STORE` | `cloudbase`（推荐）/ `nosql`（老文档库环境）/ `file` |
| `TCB_ENV` | 环境 ID，例如 `cyan1-xxxx` |
| `ALLOW_MODELS` | 例如 `deepseek-flash`；留空 = 不限制 |
| `PORT` | 默认 8787 |

**账本需要一次授权**：云托管容器里不能用平台默认临时凭据，必须在
「服务配置 → **API Key 设置**」里注入一把**环境级服务端 ApiKey**
（在「**环境配置 → ApiKey 管理**」创建，不是在「AI 工具中使用 Token」那页建的网关令牌），
注入后容器里会有 `CLOUDBASE_APIKEY`。

> ⚠ 两个坑，都踩过：
> ① **网关令牌 ≠ 服务端 ApiKey**：拿 AI 页那把去连数据库会报 `INVALID_ACCESS_TOKEN`
>    （JWT 的 `kid` 对不上）。`/healthz` 里的 `storeAuth.apiKeyKid` 能看出容器里到底是哪把。
> ② **新环境是 PostgreSQL，不是文档型数据库**：建集合会返回
>    `This environment has no document database instance…`。所以账本默认走 **PG 的 Data API**：
>    建表用 `POST /v1/rdb/exec-pgsql`（`role=cloudbase_postgres`），增删改查用
>    `/v1/rdb/rest/{table}`（PostgREST，主键冲突走 upsert）。表名默认 `rw_cards`，**服务会自己建**。

配完打两个自检就一眼看清（都不需要看 Key）：

```powershell
curl.exe -H "Authorization: Bearer <ADMIN_SECRET>" https://<relay>/healthz
curl.exe -H "Authorization: Bearer <ADMIN_SECRET>" https://<relay>/admin/store/selftest
curl.exe -H "Authorization: Bearer <ADMIN_SECRET>" https://<relay>/admin/upstream/selftest
```

`healthz` 会回显 `store`（真正在用的账本后端）、`storeAuth`（Key 有没有注入、`kid` 是哪把）、
`upstream`/`upstreamChatPath`/`upstreamKeySet`/`adminEnabled`。

### 用云开发自己的大模型网关当上游（可省掉外部 Key）

控制台「AI 工具中使用 Token」页可以创建 API Key，Base URL 形如
`https://<envId>.api.tcloudbasegateway.com/v1/ai/cloudbase`。它就是 OpenAI 兼容网关
（官方文档：<https://docs.cloudbase.net/http-api/ai-model/call-llm>）：

```
UPSTREAM_BASE=https://<envId>.api.tcloudbasegateway.com/v1/ai/cloudbase
UPSTREAM_CHAT_PATH=/chat/completions
UPSTREAM_KEY=<那一页创建的 API Key>
ALLOW_MODELS=            # 先留空；确认模型名后再收紧
```

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
