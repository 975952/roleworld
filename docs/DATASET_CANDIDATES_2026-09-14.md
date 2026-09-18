# roleworld 公开对话数据集候选调研（2026-09-14）

> 目的：为「总结日常即时聊天行为规律」与「做小型角色扮演评测集」筛选公开对话数据。
> 方法：仅网页调研（GitHub raw README / LICENSE / 官方数据集页 / arXiv / HF 数据卡与 datasets-server API / Zenodo API / Crossref），**未下载任何数据集文件**。
> 凡本次未见到证据的，一律写「未找到明确语料许可声明」或 `NOT VERIFIED`，不做推测填充。

## 0. 结论先行

1. **没有发现合适的公开情侣微信数据。** 本次实际核查的 25 个来源里，**没有任何一个**提供可再分发的真实情侣微信/QQ 聊天记录。这不是"没找到"，而是这类数据在公开语料中基本不存在：
   - 在 HuggingFace 数据集检索 `情侣` / `男朋友` / `女朋友` / `恋爱` / `微信` / `聊天记录` —— **全部返回 0 条结果**。仅存零星"个人微信导出"（如 `Humbleguava/Personal_Wechat_Msg` 自标 `apache-2.0`、`Sanbei101/wechat-zl` 自标 `mit`、`NicoLoo/Wechat3/4/5` 为空壳），**均由上传者自打许可标签、无来源与同意说明**；另有一个门控 `ironarmor/real_dating_chatlog`（README 返回 401，来源与同意**无法核实**）。
   - **中文带关系标签的对话数据确实有，但源头都是影视剧本或众包扮演**（CPED = 40 部国产电视剧；MPDD = 电视剧剧本；DDRel / Cornell / Friends = 影视剧本；DuLeMon / NaturalConv = 众包扮演），不是真实私人聊天。
   - **真实 IM 数据只有两类**：(a) 无上下文的单条短信（SMS Spam Collection、NUS SMS）；(b) 真实 IM 会话但**受 EULA 门控、需学术身份**（WICM）。
   - 唯一直接研究「日常 IM 回复延迟规律」的公开成果是**论文**，不是可再分发语料（arXiv:2605.03687）。
2. **最贴近「日常即时聊天行为规律」的可用资源**（按推荐度）：**① WICM**（真实 WhatsApp/Instagram，6,529,297 条逐条消息，含 `datetime`/`sender_id`；门控 EULA、非中文）；**② arXiv:2605.03687**（可直接引用的量化基线：WhatsApp 约 70%、Instagram 约 44% 的消息在 5 分钟内被回复；双方回复速度对称性斜率 0.786/0.796 —— **先读论文就能拿到规律，不必先拿数据**）；**③ WildChat**（`allenai/WildChat-4.8M`，**ODC-BY 可再分发**，且**带真实时间戳**：会话级 + assistant 每条；但属**人机对话**）；**④ RESCUE-Bench**（唯一来自**真实情侣**访谈的关系动态标注）。
3. **三个指定来源定位不同**：CPED = 中文影视多模态多标签（情感/人格/对话行为）；MPDD = 中文影视多方对话 + **唯一含 couple/spouse 关系维度**；CDial-GPT/LCCC = 中文微博真实闲聊，但**完全无时间戳、无逐条发送者、无关系标签**，且语料许可在官方 README 与 HF 数据卡之间**自相矛盾**。
4. **许可最干净的角色扮演素材是 RoleBench**（语料 **Apache-2.0**，英语+中文，可再分发）；中文评测蓝本选 CharacterEval（代码 MIT，但**语料无许可声明**）；中文陪伴式对话可看 DuLeMon（Apache-2.0 代码 + persona 标注，但**语料无许可声明**、未确认是否商用）。其余多数"看起来能用"的语料（影视剧本、字幕、微博、豆瓣）**许可不明或明确禁止再分发**。
5. **明确不要做的事**：不要声称从这些数据学到了真实的回复延迟；不要把网络截图当语料；不要把提示词示例和评测对话混在一起（详见第 4 节）。

## 1. 三个指定一手来源逐个核实

### 1.1 CPED —— 只作候选（不进主流程）

| 字段 | 核实结果 |
|---|---|
| 原始来源 | 论文 arXiv:2205.14727（Chen et al. 2022）；仓库 https://github.com/scutcyr/CPED （默认分支 main） |
| 语言 / 性质 | 中文 / **影视剧本**。README 原文：`We construct a dataset named CPED from 40 Chinese TV shows` |
| 多轮 | 是。12K 对话 / 133K 句；train 8,086 + dev 934 + test 2,815 对话；平均 11.6 句/对话，最长 75 句 |
| 关系标签 | **无**。标注为人物属性（姓名/性别/年龄）、Big Five、13 类情绪、3 类情感极性、19 类对话行为、11 类场景 |
| 时间戳/分条 | **无逐条时间戳**。统计表有 `Avg. duration of an utterance 2.1s`，说明上游视频含 (v,a,t) 模态，但发布物为文本+标注，README 未给出逐条时间字段 → **不能用于回复延迟** |
| 代码许可 | **Apache-2.0**。证据：仓库根 `LICENSE` 首行 `Apache License Version 2.0`（raw 实测）；GitHub API `license.spdx_id = "Apache-2.0"` |
| 语料许可 | **未在仓库中找到明确语料许可声明**。根目录仅 `README.md / README-zh.md / LICENSE / data/ / envs/ / images/ / *_baseline/`，**无独立数据许可文件**；对 `README-zh.md` 全文检索「许可/协议/licen/License/商业/科研/授权」**零命中**。README 称数据亦可在 luge.ai 获取（`https://www.luge.ai/#/luge/dataDetail?id=41`），但该页为前端渲染，条款文本本次未能读到 |
| 隐私 | 源头为公开播出电视剧 → **第三方版权风险**，非 PII 风险 |
| 取舍理由 | **只作候选**。情感/人格/对话行为标签体系值得借鉴，可作中文角色扮演评测的选题参考；但剧本腔、无关系标签、无时间戳，不能作日常 IM 行为规律或情侣数据 |

### 1.2 Dialogue-MPDD —— 采纳为「关系标签 schema」参考

| 字段 | 核实结果 |
|---|---|
| 原始来源 | Yi-Ting Chen, Hen-Hsen Huang, Hsin-Hsi Chen, LREC 2020，`https://aclanthology.org/2020.lrec-1.76/`；仓库 https://github.com/ntunlplab/Dialogue-MPDD |
| 语言 / 性质 | 中文（README 明确其动机是「no publicly available **Chinese** dialogue dataset with emotion and relation labels」；语料未下载，语言以论文为准）/ **影视剧本**，README 原文 `we collect the conversions from TV series scripts` |
| 多轮 | 是，且为**多方**（每句带 listener 列表）。4,142 段对话 / 25,548 句 |
| 关系标签 | **有，且是三源中唯一含「情侣」维度的**。每句的每个 listener 带 relation；`metadata.json` 分 relation / field / position 三维，其中 `field.others` 含 `"couple"`，`position.peer` 含 `"spouse"` |
| 时间戳/分条 | **无**。`dialogue.json` 每条仅 `speaker / utterance / listener[{name,relation}] / emotion`，无任何时间字段 |
| 代码许可 | **无**。仓库根目录仅 `README.md` 与 `mpdd.zip`；GitHub API `license = null`（无 LICENSE 文件） |
| 语料许可 | **未找到明确语料许可声明**。README 只有 `# How to Cite this resource` 一段，无许可条款 |
| 隐私 | 电视剧剧本 → 第三方版权风险；非 PII |
| 取舍理由 | **采纳为关系标签 schema 参考**（couple/spouse 维度直接可用），并作中文关系条件评测候选；不用于行为规律 |

### 1.3 CDial-GPT / LCCC —— 候选，许可存疑

| 字段 | 核实结果 |
|---|---|
| 原始来源 | 论文 arXiv:2008.03946（Wang et al., NLPCC 2020）；仓库 https://github.com/thu-coai/CDial-GPT （默认分支 master，1,964 stars） |
| 语言 / 性质 | 中文 / **网页抓取**。LCCC-base 原始对话来自爬取的微博对话；LCCC-large 在此基础上**混合**了 PTT Gossiping、Subtitle Corpus、Xiaohuangji、Tieba、Qingyun、豆瓣多轮、电商对话、Chinese Chat Corpus |
| 多轮 | 是。LCCC-base：单轮 3,354,382 + 多轮 3,466,607 会话（3.86 句/会话） |
| 关系标签 | **无**。发布格式是每行一个纯句子列表（`Each line is a list of utterances that consist a dialogue`）；模型内部用说话人 embedding，但**语料本身无说话人字段** |
| 时间戳/分条 | **无**。对 HF 数据实例、`data/toy_data.json`、README schema 三处核查，**均无时间/时延字段**（`max_history=15` 是训练侧拼接窗口，不是数据字段） |
| 代码许可 | **MIT**。仓库根 `LICENSE` 首行 `MIT License / Copyright (c) 2020 lemon234071`；GitHub API `spdx_id = "mit"` |
| 语料许可 | ⚠ **证据冲突，必须写明**。官方 README「免责声明」原文：`本项目所提供的 LCCC 数据集和预训练对话模型仅限科研用途`。而 HuggingFace 数据卡 `thu-coai/lccc` 的 license 标签为 **`mit`**，**同一张卡片的「Licensing Information」一节却写 `[Needs More Information]`**。**代码 MIT ≠ 语料 MIT**，此处正是典型陷阱。此外微博上游语料（79M 会话）**自身无任何许可**；LCCC-large 又混合多个第三方语料，存在**许可堆叠**问题 |
| 隐私 | **高** —— 批量逐字转载爬取的微博用户文本，无同意/匿名化说明；README 自认「并不保证所有不当内容均已被过滤」 |
| 取舍理由 | **候选**。可作中文口语短句风格参考与困惑度基线；因许可不明、无时间戳、无关系标签，**不进主流程**，也**不要**作为可再分发语料 |

## 2. 更贴近「日常即时聊天」的其他公开数据

### 2.1 WICM（WhatsApp / Instagram 消息元数据）★ 行为规律首选

- 来源：Zenodo `10.5281/zenodo.19369010`（2026-05-04，Martin / Hakobyan / Drimalla）；配套论文 arXiv:2605.03687
- 语言 / 性质：语言记录中**未声明** → `NOT VERIFIED`（德国团队）；**真实人类日常**，参与者经 Dona 平台**主动捐赠**
- 多轮 / 关系标签：是（762 个 WhatsApp + 6,285 个 Instagram 会话，共 **6,529,297 条消息**，2012-11 至 2025-06）/ 无
- 时间戳/分条：**有 —— 本轮唯一真正满足需求的数据**。逐条消息一行：`conversation_id / sender_id / datetime / word_count / data_source_id / donor_id / id`；`datetime` 在 Instagram 与 iOS 版 WhatsApp 为**亚秒级**，Android 版 WhatsApp 为分钟级
- 许可 / 隐私：无代码发布；语料 **Zenodo 记录无 license 字段**（API 实测返回空），实际为**门控 EULA + 需学术机构身份**，向记录页所列联系人申请 → **不是开放许可**。隐私：参与者知情捐赠 + UUID 假名化，另附人口学问卷；但「完整聊天时序 + 人口学」组合仍有再识别风险，故采用门控 EULA —— **这是正确的伦理做法，值得 roleworld 照抄**
- 取舍：**采纳**为行为规律的方法论与基线来源；如需原始数据走 EULA 申请（非本项目即时动作）

### 2.2 回复时延互惠性研究（论文，非语料）★ 零成本可用的行为规律

- 来源：arXiv:2605.03687《Sorry for the late reply: Response times and reciprocity in WhatsApp and Instagram chats》(2026-05-05)
- 语言 / 性质：英文论文 / **基于真实 IM 的量化分析**（分析对象为 WICM 的 3.4M 条消息、889 会话、97 次捐赠）
- 多轮 / 关系标签：— / 无
- 时间戳/分条：**有回复时延统计**（这正是它的研究对象）
- 许可 / 隐私：arXiv 预印本，按其页面许可引用即可；仅聚合统计，无个体内容
- 取舍：**采纳**。roleworld 想要的「日常聊天行为规律」，这篇论文本身就是可引用、可复现的规律清单，**优先于任何语料**

### 2.3 RESCUE-Bench（真实情侣/家庭访谈 + 关系动态标签）★ 关系动态首选

- 来源：arXiv:2609.09657（2026-09-09，AACL 2026）；仓库 `https://github.com/Tomsawyerhu/RESCUE-bench`（代码 Apache-2.0；`data/` 含 `benchmark_191.jsonl` 及 er/itp/rpp/ssp/stp/vp 各任务 jsonl）
- 语言 / 性质：`NOT VERIFIED`（论文为英文；数据源自纪录片式访谈视频）/ **真实人类日常**，论文原文 `constructed from real couple and family interview conversations`，素材为公开纪录片式访谈 `Couple Therapy` / `Family Therapy`
- 多轮 / 关系标签：是（**191 样本 / 7,079 条标注轮次 / 1,064.8 分钟视频**，其中 **174 个为 couple 场景**）/ **有**：`--group-mode couple|family`；关系模式状态含 `pursue_withdraw`、`attack_attack`、`mixed_transition`，关系模式含 escalation / withdrawal / repair / alignment
- 时间戳/分条：上游视频含时间轴；**发布 jsonl 内的时间字段 `NOT VERIFIED`**
- 许可 / 隐私：代码 **Apache-2.0**；语料 **未找到明确语料许可声明** —— 论文自述因版权与隐私**不再分发原始视频/音频/视觉内容**，仅发布标注（论文本身 CC BY 4.0）。隐私：**处理得当的范例**（素材为公开播出访谈视频，且明确限制再分发原始媒体）
- 取舍：**采纳为「关系动态 / 冲突-撤退-修复」标签体系与评测任务设计参考**，最能补足 roleworld 的"关系状态"维度

### 2.4 CharacterEval（中文角色扮演评测基准）

- 来源：ACL 2024, DOI `10.18653/v1/2024.acl-long.638` / arXiv:2401.01275；仓库 `https://github.com/morecry/CharacterEval`
- 语言 / 性质：**中文** / **源作品抽取 + 合成 + 人工校验**。论文原文：GPT-4 从知名小说/剧本抽取对话场景与角色言行，再请标注员评估质量；1,785 段多轮对话、77 个角色，角色画像爬自**百度百科**。⚠ 样本数版本不一致：arXiv v1 与仓库 README 写 **23,020**，ACL 2024 版写 **11,376** → 引用须注明版本
- 多轮 / 关系标签：是 / 无说话人关系标签，但有**角色级 persona 画像**（与 roleworld 自定义角色同构）
- 时间戳/分条：**未见时间戳字段**；4 维度 13 项指标；另发布 CharacterRM 奖励模型（12 名标注员，分歧经讨论统一）
- 许可 / 隐私：代码 **MIT**（raw `LICENSE` 首行 `MIT License Copyright (c) 2024 morecry`）；语料 **未找到明确语料许可声明**（README 对 licen/copyright/许可/版权 **零命中**；HF 上仅有非官方转存）。⚠ 论文页显示的 `CC BY-NC-SA 4.0` 是**论文**许可，**不是**语料许可。隐私：无真人 PII，但源小说/剧本与百度百科文本为第三方版权内容
- 取舍：**采纳为中文角色扮演评测蓝本**（中文、多轮、多指标、有人工标注与奖励模型）；许可不明 → 仅本地参考

### 2.5 RoleBench（RoleLLM）—— 许可最干净的角色扮演数据

- 来源：arXiv:2310.00746；仓库 `https://github.com/InteractiveNLP-Team/RoleLLM-public`；数据 `https://huggingface.co/datasets/ZenMoore/RoleBench`
- 语言 / 性质：英语 + 中文 / **合成（LLM 生成）** —— 由 GPT 经 Context-Instruct / RoleGPT 生成，168,093 个样本、100 个角色
- 多轮 / 关系标签：**否**（instruction→response 对；论文中 `multi-turn conversation mode` 只用于基线模型）/ 有**角色 persona 画像**
- 时间戳/分条：`NOT VERIFIED`（卡片无 features / 字段说明）
- 许可 / 隐私：代码 `NOT VERIFIED`（仓库仅 `README.md` + `assets/`，raw `LICENSE` 返回 404 → **无代码许可**）；语料 **Apache 2.0**（卡片 front-matter `license: "apache-2.0"` 及正文 `# License Apache 2.0 License.`）—— **本轮唯一许可明确且允许再分发的角色扮演数据**。隐私：角色含虚构人物与真实公众人物（林肯、霍金等），文本为合成，无用户 PII
- 取舍：**采纳**：适合取少量作提示词/评测的**许可干净**素材；但单轮、无关系标签

### 2.6 DuLeMon（中文长程 persona 陪伴对话）

- 来源：*Long Time No See! Open-Domain Conversation with Long-Term Persona Memory*, Findings of ACL 2022, arXiv:2203.05797, `https://aclanthology.org/2022.findings-acl.207/`；仓库 `https://github.com/PaddlePaddle/Research/tree/master/NLP/ACL2022-DuLeMon`
- 语言 / 性质：**中文** / **众包人工编写（合成）** —— ⚠ **不是影视剧本**。论文 App. A 原文 `The crowdworkers enter the chat interface in pairs, and role 1 initiates a conversation`；persona「mainly from the translation and rewriting of persona in PersonaChat」
- 多轮 / 关系标签：是（DuLeMon-SELF 24,500 段 / 400,472 句 / 平均 16.3 轮；DuLeMon-BOTH 3,001 / 48,522 / 16.2）/ 无说话人关系标签，但有**逐句 persona grounding 标注**（`both the user and chatbot grounding persona are annotated in each utterance`，persona id 带 `U1`/`B5` 后缀）
- 时间戳/分条：**无时间戳**（论文检索 `timestamp` 未命中；README schema 仅 `bot_persona / user_said_persona / user_no_said_persona / conversation`）。有逐条发送者（`Usr:` / `Bot:` 前缀）；发布 zip 是否另含时间列 `NOT VERIFIED`（未下载）
- 许可 / 隐私：代码 **Apache-2.0**（仓库根 `LICENSE` = `Apache License Version 2.0`；GitHub API 一致）；语料 **未找到明确语料许可声明**（README 与子目录均无数据条款，根 Apache-2.0 未涉及语料）。隐私：中低，但 README 示例含真实感人名（如「我叫曾鹏」/「我叫魏建功」），**无匿名化或同意声明** → PII 边缘风险
- 取舍：**采纳为「中文 + 长程 persona 陪伴」最贴近的结构参考**（与 roleworld 的长期角色记忆同构）；但需注意语料许可缺失、无时间戳

### 2.7 DDRel（成对对话 + 13 类人际关系）

- 来源：Jia, Huang, Zhu, AAAI 2021, arXiv:2012.02553；仓库 `https://github.com/JiaQiSJTU/DialogueRelationClassification`
- 语言 / 性质：英语（论文原文 `We crawled movie scripts from IMSDb`）/ **影视剧本**
- 多轮 / 关系标签：是，**成对（dyadic）** —— 6,300 段会话 / 694 组说话人对 / 53,126 句 / **有**，13 类预定义人际关系（会话级与说话人对级两档任务）
- 时间戳/分条：**无**（仅会话级标注）
- 许可 / 隐私：代码 **无 LICENSE**（GitHub API `license = null`）→ **无代码许可**；语料 **未找到明确语料许可声明**（README 仅给 Google Drive 链接）。隐私：电影剧本 → 第三方版权风险
- 取舍：**采纳为「关系条件化」评测设计参考**（与 MPDD 互补：DDRel 英语成对、MPDD 中文多方）

### 2.8 NaturalConv（中文多轮话题驱动对话）

- 来源：AAAI-21, DOI `10.1609/aaai.v35i16.17649` / arXiv:2103.02548；权威仓库 `https://github.com/naturalconv/NaturalConvDataSet`；官方托管 `https://ai.tencent.com/ailab/nlp/dialogue/#datasets`
- 语言 / 性质：**中文** / **众包人工编写（合成）** —— 论文原文 `collected by annotators who communicate based on one given topic in the form of a news article`（6,500 篇 2019 年 9–12 月新闻作 grounding 文档）。**不是真实日常 IM**
- 多轮 / 关系标签：是（**19,919 段 / 约 400K 句 / 六个领域 / 平均 20.1 轮**）/ 无（schema 仅 `dialog_id` / `document_id` / `content` 扁平列表；论文检索 `speaker` 未命中）
- 时间戳/分条：**无**（同上 schema；论文检索 `timestamp` 未命中）
- 许可 / 隐私：代码 **无 LICENSE**（raw `LICENSE` 404；GitHub API license 为空）；语料为 **《Tencent AI Lab NaturalConv Dataset Terms and Conditions》** —— ⚠ **§3 仅限非商业；§4(a) 不得复制、分发、公开展示数据集任何部分或其衍生作品；§4(b) 不得向腾讯以外再分发**。README 亦写 `released for non-commerical usage only`。隐私：低（合成对话，grounding 仅新闻超链接）
- 取舍：**只作候选（仅本地研究）**。平均 20.1 轮适合研究**话题漂移与长程连贯性**；但非日常闲聊、且**明确禁止再分发与衍生分发**

### 2.9 豆瓣多轮（Douban Conversation Corpus）

- 来源：Wu et al., ACL 2017 (P17-1046), DOI `10.18653/v1/P17-1046`，`https://aclanthology.org/P17-1046/`；仓库 `https://github.com/MarkWuNLP/MultiTurnResponseSelection`
- 语言 / 性质：**中文** / **网页抓取** —— 论文原文 `we crawled 1.1 million dyadic dialogues ... from Douban group`；测试集负例来自 1,500 万条新浪微博 post-reply 对。**不是私信**
- 多轮 / 关系标签：是（train 1M / val 50K / test 10K 组会话-回复对；最少 3 轮，平均 5.95–6.75，最长 98）/ **无**（仅"是否合适回复"的二分类标签 + 3 人多数投票，Fleiss Kappa 0.41）
- 时间戳/分条：**无**。README 模板仅 `label \t conversation utterances \t response`；论文检索 `timestamp` 未命中 → **完全扁平化**
- 许可 / 隐私：代码 **无 LICENSE**（raw 与 API 均 404）；语料 **未找到明确语料许可声明**（README 只说 `Please cite our paper`，无条款、无 DUA，语料放在 Dropbox 链接）。隐私：**偏高** —— 逐字转载豆瓣/微博第三方用户文本，无同意与匿名化说明
- 取舍：**只作候选**。可作中文日常闲聊的**回复选择**评测基线；无时间戳、许可缺失

### 2.10 DailyDialog

- 来源：Li et al., IJCNLP 2017, arXiv:**1710.03957**（`https://aclanthology.org/I17-1099/`）；官方页 `http://yanran.li/dailydialog` 已失效，存档 `https://web.archive.org/web/20180708205117/http://yanran.li/dailydialog.html`
- 语言 / 性质：英语 / **网页抓取的人工撰写文本**（论文 §2.1 原文：从「serve for English learner to practice English dialog」的网站爬取）—— **不是真实聊天，也不是众包**
- 多轮 / 关系标签：是（13,118 段，平均 7.9 轮）/ **无**（只有 4 类 dialogue act、7 类情绪、10 类话题；其 `Relationship` 是**话题**分类，**不是**说话人关系标签）
- 时间戳/分条：**无**。HF loader 字段仅 `dialog: Sequence(string) / act / emotion`，句间以 `__eou__` 分隔
- 许可 / 隐私：代码无官方仓库 → `NOT VERIFIED`；语料 **作者原声明为仅科研、禁商用**（存档页 Copyright 节原文 `The dataset is only for research purposes. Without permission, it may not be used for any commercial purposes.`），HF 卡另打 `cc-by-nc-sa-4.0`。隐私：无实名个体，直接 PII 低，第三方版权风险
- 取舍：**候选**（英文日常话题与情绪标签可借），不可用于延迟研究

### 2.11 EmpatheticDialogues

- 来源：Rashkin et al. arXiv:1811.00207；`https://github.com/facebookresearch/EmpatheticDialogues`
- 语言 / 性质：英语 / **众包人工编写（合成）** —— MTurk 陌生人两两配对，各自描述一段诱发某情绪的真实经历后再对话。24,850 段，平均 4.31 句
- 多轮 / 关系标签：是 / **无**（有情绪 prompt/context 与 speaker/listener 角色；参与者互为陌生人）
- 时间戳/分条：**无时间戳**，但**有逐条消息行**（`conv_id / utterance_idx / context / prompt / speaker_idx / utterance / selfeval / tags`）
- 许可 / 隐私：代码仓库 LICENSE 首行 `Attribution-NonCommercial 4.0 International` = **CC BY-NC 4.0**；语料**同为 CC BY-NC 4.0**（README License 节指向同一 LICENSE）。隐私：众包者自述真实情绪经历，去标识化程度 `NOT VERIFIED`
- 取舍：**采纳为「情绪回应策略」schema 与共情评测参考**（NC 限制，不可商用）

### 2.12 PersonaChat

- 来源：Zhang et al. arXiv:1801.07243；ParlAI 任务 `personachat`（`http://parl.ai/downloads/personachat/personachat.tgz`）
- 语言 / 性质：英语（原数据小写）/ **众包人工编写（合成）** —— 随机配对众包者，按给定虚构 persona「扮演角色」聊天。162,064 句 / 10,907 段对话
- 多轮 / 关系标签：是 / **无**（每方 5 句 persona，共 1,155 个 persona；双方为陌生人）
- 时间戳/分条：**无时间戳**；仅 utterance 级（`conv_id / utterance_idx / personality / history / candidates`）
- 许可 / 隐私：代码 ParlAI = **MIT**；语料 `personachat` 任务 README **无许可行** → **未找到明确语料许可声明**（相邻 `convai2` 任务 README 写 `License: CC 4.0 BY`，但那是 ConvAI2 发布版）。隐私：**低**（论文原文：persona 并非众包者真实资料，且明确要求不得使用真实信息）
- 取舍：**采纳为「人格设定 + 角色扮演」评测范式参考**，其 persona 机制与 roleworld 自定义角色最接近；DuLeMon 的中文 persona 即由其改写而来

### 2.13 NUS SMS Corpus（真实短信，含人口学）

- 来源：Chen & Kan (2013) *Language Resources and Evaluation* 47(2):299-355, DOI `10.1007/s10579-012-9197-9`；仓库 https://github.com/kite1988/nus-sms-corpus （2015-03-09 版）
- 语言 / 性质：新加坡英语 55,835 条 + 中文 31,465 条 / **真实人类日常**，贡献者本人短信；**只收已发送消息**（论文原文：拒收接收消息，因无法保证发信人同意）
- 多轮 / 关系标签：**否**（单条，无会话线程）/ 无关系标签（有贡献者人口学）
- 时间戳/分条：`PARTIAL`。论文称导出档含收发号码与发送时间戳，README 未说明；**公开文件实际字段与时间戳是否保留 → `NOT VERIFIED`**（未下载）
- 许可 / 隐私：代码 **无**（仓库无 LICENSE，raw 404）；语料 **未找到明确语料许可声明**，仅见引用请求与论文所述设计目标「copyright-free for unlimited use」。隐私：**高但有缓解** —— 号码自动匿名化，但论文明确「Personal names are **not** replaced by any code」
- 取舍：**候选**（仅静态风格/句式参考）；不成线程 → 不能算回复时延

### 2.14 SMS Spam Collection（UCI）

- 来源：Almeida, Gómez Hidalgo, Yamakami, ACM DOCENG 2011, DOI `10.1145/2034691.2034742`；数据 DOI `10.24432/C5CC84`；`https://archive.ics.uci.edu/dataset/228/sms+spam+collection`
- 语言 / 性质：英语 5,574 条 / **真实人类日常**，但由多个公开来源拼装（Grumbletext 论坛 425 spam、NUS SMS 3,375 ham、Tagg 博士论文 450 ham、SMS Spam Corpus v0.1）
- 多轮 / 关系标签：**否** / 无
- 时间戳/分条：**无**。UCI 原文 `each line has the correct class followed by the raw message`，且 `messages are not chronologically sorted`（无发送者、无日期）
- 许可 / 隐私：无代码；语料 **CC BY 4.0**（UCI 页面 License 节明确）。⚠ 冲突：HF 镜像卡写 `unknown`，以分发方 UCI 为准。隐私：**高** —— 真实私人短信且未脱敏，UCI 自带示例即含真实号码
- 取舍：**仅作滥用/垃圾内容词表**，不作行为规律、不作角色扮演语气参考

### 2.15 Enron Email Dataset（真实、逐条时间戳、但高危）

- 来源：Klimt & Yang, CEAS 2004；`https://www.cs.cmu.edu/~enron/`（2015-05-07 版，约 0.5M 封，~150 用户）
- 语言 / 性质：英语 / **真实人类日常**（企业邮件，来自 FERC 调查公开材料）
- 多轮 / 关系标签：邮件线索形式但**未预切分** / 无（仅地址）
- 时间戳/分条：**有** —— 一封邮件一文件，保留邮件头（真实 Date + From/To/Cc/Bcc/Subject）；线程关联头（References/In-Reply-To）`NOT VERIFIED`
- 许可 / 隐私：无代码；语料 **未找到明确语料许可声明**（CMU 页仅称 `as a resource for researchers` 并请求注意隐私）。隐私：**极高** —— 可识别真人的私邮，来自刑事调查，**从未取得当事人同意**，删改仅部分
- 取舍：**排除**：可算回复时延，但属职场邮件而非聊天，隐私/许可风险不可接受

### 2.16 EmotionPush（真实 Facebook Messenger + 已读日志）

- 来源：Huang & Ku, IEEE GLOBECOM 2018, DOI `10.1109/GLOCOM.2018.8647331`（论文 closed access）
- 语言 / 性质：`NOT VERIFIED`（作者为台湾团队，语言未在摘要声明）/ **真实人类日常**：162,031 条消息日志 + **对应的 read（已读）事件日志**，来自真实私人 Facebook Messenger 会话
- 多轮 / 关系标签：是 / 无
- 时间戳/分条：**有回复时延维度**（论文提出 response-time prediction 任务，基线 89% 准确率）。**「已读日志」是本轮所有来源中唯一的**，直接对应「已读不回」行为
- 许可 / 隐私：代码 **未找到明确语料许可声明**；语料**未见公开下载入口**。隐私：真实私人对话，仅以「具名实体替换为类型+唯一 ID」脱敏；消息部分以原始词、部分以词向量发布
- 取舍：**只作方法论参考**（已读/时延任务设计与脱敏手法），数据可用性未证实

### 2.17 WildChat（真实用户 × LLM，且带真实时间戳）

- 来源：Zhao et al., ICLR 2024, arXiv:2405.01470；`https://huggingface.co/datasets/allenai/WildChat-4.8M`
- 语言 / 性质：多语（卡片称检测到 68 种语言）/ **真实用户与 AI 对话**，用户以「免费使用 ChatGPT 换取**明示 opt-in 同意**匿名收集」参与（论文原文 `affirmative, consensual opt-in`）
- 多轮 / 关系标签：是（4.8M 版 3,199,860 段，已过滤有害内容；含毒版 `*-Full` 为 manual 门控）/ **无**（仅 user/assistant 角色）。⚠ 论文与卡片**均无** "roleplay" 类别（检索零命中）→ 不要声称它带角色扮演标签
- 时间戳/分条：**有**。会话级 `timestamp`（UTC，末轮时间）+ assistant 每轮 `timestamp`（后端收到完整回复的时间）；每条 user 轮另带 `hashed_ip / state / country / header`。**理论上可推算「用户沉默时长」与「模型响应时长」**
- 许可 / 隐私：无代码；语料 **ODC-BY 1.0**（卡片 `license: odc-by`；2024-06-26 由 AI2 ImpACT 改为 ODC-BY 并追溯既往下载）→ **可再分发**。隐私：**高** —— 真实用户；PII 用 Microsoft Presidio + 手写规则脱敏，2024-10-17 移除被标记含 PII/敏感内容的会话；但保留 hashed IP、州/国、请求头。⚠ 本次检索卡片与论文**均无 canary string**
- 取舍：**采纳为行为规律补充源**；但属**人机对话而非人际聊天**，用于推断人际行为规律时须明确标注偏差

### 2.18 LMSYS-Chat-1M（真实用户 × LLM，无时间戳）

- 来源：Zheng et al., arXiv:2309.11998；`https://huggingface.co/datasets/lmsys/lmsys-chat-1m`（gated=auto）
- 语言 / 性质：多语（卡片称 154 种）/ **真实用户与 AI 对话**（2023-04 至 2023-08 的 Vicuna demo 与 Chatbot Arena 流量，210K 独立 IP）；1,000,000 段 / 25 个模型 / 210,479 用户 / 平均 2.0 轮
- 多轮 / 关系标签：是 / 无；**无 roleplay 类别**（论文检索零命中；话题仅为 GPT-4 归纳的 20 个 k-means 簇，只出现在图 3）
- 时间戳/分条：**无时间戳**。字段仅 `conversation_id / model / conversation[{content,role}] / turn / language / openai_moderation / flagged / redacted`（HF API 实测）。4—8 月这一时间窗只存在于正文描述，**不是字段**
- 许可 / 隐私：无代码；语料 **自定义《LMSYS-Chat-1M Dataset License Agreement》**（门控需填姓名/邮箱/机构/国家），明确 `Prohibited Transfers: You should not distribute, copy, disclose, assign, sublicense, embed, host, or otherwise transfer the dataset to any third party`，并含禁止再识别与删除请求条款。隐私：**高** —— 真实用户；姓名以 OpaquePrompts 脱敏（`redacted` 标记）；**故意保留不安全对话**
- 取舍：**候选**：可看真实用户语气分布；但无时间戳 + 禁止转让 → 派生条目也只能本地留存

### 2.19 影视字幕/剧本类（OpenSubtitles、Cornell、Friends）

- **OpenSubtitles（OPUS）—— ⚠ 重要更正：它根本不是对话语料。** 来源：Lison & Tiedemann, LREC 2016 / Lison, Tiedemann & Kouylekov, LREC 2018（http://www.lrec-conf.org/proceedings/lrec2018/summaries/294.html ）；官方 https://opus.nlpl.eu/datasets/OpenSubtitles ；HF 官方移植 `Helsinki-NLP/open_subtitles`。语言多语（60+，3.7M 字幕）；**网页抓取**的用户上传字幕，做**句级平行对齐**。**多轮：否**（发布物是句级对齐对，1-1/1-n，**不是对话轮次**）；**关系标签：无**；**时间戳：无**；元数据仅 `meta{year, imdbId, subtitleId, sentenceIds}` + `id` + `translation`，**整个 schema 没有 speaker 字段**。许可：卡片标签 **`unknown`** → **未找到明确语料许可声明**（OPUS 语料页前端渲染，HTML 检索 `licen` 仅命中导航文本；opensubtitles.com 的 ToS 本次返回 **HTTP 403** → 条款 `NOT VERIFIED`）。**取舍：不采纳** —— 无说话人、无轮次结构，对日常聊天与角色扮演几乎无用。此条纠正了「字幕=对白语料」的常见误解
- **Cornell Movie-Dialogs Corpus。** 来源：Danescu-Niculescu-Mizil & Lee, CMCL @ ACL 2011；官方页 `http://www.cs.cornell.edu/~cristian/Cornell_Movie-Dialogs_Corpus.html`。语言英语；**影视剧本**（论文原文 `fictional conversations extracted from raw movie scripts`）：220,579 段对话交换 / 10,292 组角色对 / 9,035 角色 / 617 部电影 / 304,713 句。多轮：**是**；关系标签：**无关系标签**，但每句带 `speaker` / `reply_to`（被回复句 id）/ `conversation_id`，角色级元数据含 `character_name / gender / credit_pos`。时间戳：**官方页未列出任何时间戳**；ConvoKit 虽列 `timestamp` 字段，但原版不含墙钟时间 → 真实时间值 `NOT VERIFIED`。许可：ConvoKit `LICENSE.md` 为 MIT 式宽松文本；**语料未找到明确语料许可声明**（官方页只有描述 + BibTeX + 资助说明）。**取舍：候选（仅本地参考）**
- **Friends / Emory Character Mining（本组唯一有"数据许可"的影视语料，但仍不可再分发）。** 来源：Emory NLP `https://github.com/emorynlp/character-mining`（Chen & Choi, SIGDIAL 2016）；ConvoKit 版 `https://convokit.cornell.edu/documentation/friends.html`（236 集 / 3,107 场景 / 约 67,373 句 / 700 角色）；Kaggle 上的副本是转存，**非权威来源**。语言英语；多轮是。关系标签：**本组最好** —— 每句带说话人、`reply_to`、`conversation_id`，另有 `character_entities`（被称呼/被提及者）与 `transcript_with_note`（如 `(to Ross) Let me get you some coffee.`）。时间戳：**无** —— ConvoKit 文档逐字原文 `timestamp: None. Our dataset does not contain timestamp information for utterances.`（仅第 6–9 季的 `caption` 含起止时间）→ **该引文可直接作为第 4 节「不能声称学到真实回复延迟」的证据**。许可：ConvoKit `LICENSE.md` MIT 式；语料为 Emory **Apache-2.0**（`LICENSE.txt` + `NOTICE.txt`），**但该授权不覆盖转写文本本身** —— `NOTICE.txt` 原文 `Transcripts in this package are from the TV show "Friends" ... We do not claim neither the copyright nor the authorship of the transcripts in this package.` → **不可再分发**。**取舍：候选（仅本地参考）**

### 2.20 其余角色扮演语料、反面案例与未证实项

- **ChatHaruhi。** 来源：arXiv:2308.09597；仓库 `https://github.com/LC1332/Chat-Haruhi-Suzumiya`；数据 `silk-road/ChatHaruhi-54K-Role-Playing-Dialogue`。语言中文 + 英语；**影视剧本**（凉宫春日、武林外传、生活大爆炸、原神剧情）。多轮是；**有角色 persona + 逐条说话人**（142 个角色，各带 system prompt）；时间戳/时延 `NOT VERIFIED`。许可：代码 **Apache-2.0**；语料 ⚠ **自相矛盾** —— README 徽章写 `Data License CC By NC 4.0`，HF 卡写 `license: cc-by-4.0`（**无 NC**）。隐私：有一个角色源自「群友收集的语料」→ **可能含真实用户文本**。**只作候选**：许可冲突 + 剧本版权 → 不可安全再分发
- **反面案例：Russian Romantic Dialogue Dataset（建议直接排除）。** `DenSeduct/Russian_Romantic_Dialogue_Dataset`，HF 标签 `cc-by-nc-4.0`，俄语，卡片自称「真实 AI 与真人女性对话」，来自某**专有 AI 约会助手**生产环境；免费样本 22 段，完整 150+ 段在 **Gumroad 付费**出售。排除理由：① 由上传者**自行声明**许可，但其极可能不持有这些对话的权利；② 真实女性对话被商业化再分发，**未见同意证据**；③ 性质是「话术漏斗转化」而非日常关系；④ 名称为「情侣/浪漫」极具误导性 —— **这正是「看起来最像需求、实则最不能碰」的典型陷阱**
- **未能证实的候补（请勿在未核实前使用）：LEOSS** —— 对 arXiv / GitHub / HF 多路检索**均无法证实存在同名中文对话数据集**（`LEOSS+dialogue` = 0 条结果）；同名实体是德国新冠登记研究 *Lean European Open Survey on SARS-CoV-2 Infected Patients*，属**名称碰撞**。**Ti-News** —— **无法证实存在该对话数据集**；最可能是与 **TNEWS**（CLUE/FewCLUE 的中文短文本**新闻分类**子集，非对话语料；CLUE 卡自身标 `license: unknown`）混淆。

## 3. 候选表

| 名称 | 原始来源 URL | 语言 | 真实/影视/合成 | 多轮 | 关系标签 | 时间/分条信息 | 数据许可 | 隐私风险 | 建议用途 | 取舍理由 |
|---|---|---|---|---|---|---|---|---|---|---|
| **WICM** | https://doi.org/10.5281/zenodo.19369010 | NOT VERIFIED | 真实 | 是 | 无 | **有 datetime + 逐条 sender** | 无 license 字段；门控 EULA + 学术身份 | 中（知情捐赠 + UUID 假名） | ①行为规律 | 唯一真正含时间戳的真实 IM |
| **arXiv:2605.03687** | https://arxiv.org/abs/2605.03687 | 英文论文 | 真实（分析结论） | — | 无 | 回复时延统计 | arXiv 预印本 | 无（聚合统计） | ①行为规律 | 零成本、可引用的行为基线 |
| **RESCUE-Bench** | https://github.com/Tomsawyerhu/RESCUE-bench | NOT VERIFIED | 真实（公开访谈视频） | 是 | **有 couple/family** | 视频含时间轴；jsonl 时间字段未证实 | 代码 Apache-2.0；语料：未找到明确语料许可声明 | 低（已限制再分发原始媒体） | ①关系动态 schema ③评测 | 唯一真实的 couple 关系动态标签体系 |
| **CharacterEval** | https://github.com/morecry/CharacterEval | 中文 | 源作品抽取 + 合成 + 人工校验 | 是 | 有角色 persona；无关系标签 | 未见时间戳字段 | 代码 MIT；语料：未找到明确语料许可声明 | 低（小说/剧本/百科版权） | ③评测集蓝本 | 中文角色扮演评测最完整；样本数版本不一致（23,020 / 11,376） |
| **RoleBench** | https://huggingface.co/datasets/ZenMoore/RoleBench | 英语 + 中文 | 合成（LLM 生成） | **否**（单轮） | 有 persona；无关系标签 | 未证实 | **语料 Apache-2.0**；仓库无代码许可 | 低（含真实公众人物名） | ②提示词素材 ③评测 | 许可最干净的角色扮演集；但单轮 |
| **DuLeMon** | https://aclanthology.org/2022.findings-acl.207/ | 中文 | 众包人工编写（合成） | 是（平均 16.3 轮） | 无关系标签；有逐句 persona grounding | **无**（有逐条发送者，无时间） | 代码 Apache-2.0；语料：未找到明确语料许可声明 | 中低（示例含真实感人名，无匿名化声明） | ①长程 persona 陪伴参考 | 最贴近 roleworld 长期角色记忆；许可缺失 |
| **Dialogue-MPDD** | https://github.com/ntunlplab/Dialogue-MPDD | 中文 | 影视剧本 | 是（多方） | **有（含 couple/spouse）** | 无 | 无 LICENSE；语料：未找到明确语料许可声明 | 低（剧本版权） | ①关系标签 schema | 指定三源中唯一含情侣关系维度 |
| **CPED** | https://github.com/scutcyr/CPED | 中文 | 影视剧本 | 是 | 无 | 无（仅上游音视频时长） | 代码 Apache-2.0；语料：未找到明确语料许可声明 | 低（剧本版权） | ②标注 schema | 情感/人格/对话行为标签丰富 |
| **DDRel** | https://github.com/JiaQiSJTU/DialogueRelationClassification | 英语 | 影视剧本 | 是（成对） | **有（13 类）** | 无 | 无 LICENSE；语料：未找到明确语料许可声明 | 低（剧本版权） | ③关系条件评测 | 成对关系分类任务设计成熟 |
| **CDial-GPT / LCCC** | https://github.com/thu-coai/CDial-GPT | 中文 | 网页抓取（微博） | 是 | 无 | **无** | 代码 MIT；语料 README 限科研，HF 卡却标 MIT 且自注 Needs More Information（冲突） | **高**（批量转载微博文本，无同意） | ②口语风格参考 | 规模大但许可矛盾、无时间戳 |
| **NaturalConv** | https://arxiv.org/abs/2103.02548 | 中文 | 众包人工编写（合成，新闻话题驱动） | 是（平均 20.1 轮） | 无 | **无** | 腾讯 AI Lab 条款：**仅非商业 + 禁止复制/分发/衍生分发** | 低（合成对话） | ③长程话题连贯（仅本地） | 长对话有价值；明确禁止再分发 |
| **豆瓣多轮** | https://aclanthology.org/P17-1046/ | 中文 | 网页抓取（豆瓣小组） | 是（平均 5.95–6.75 轮） | 无（仅"合适回复"二分类） | **无**（完全扁平） | 无 LICENSE；语料：未找到明确语料许可声明 | 偏高（逐字转载豆瓣/微博文本） | ③回复选择基线 | 无时间戳、许可缺失 |
| **EmpatheticDialogues** | https://github.com/facebookresearch/EmpatheticDialogues | 英语 | 众包合成（陌生人） | 是 | 无 | 无时间戳，有逐条消息行 | **CC BY-NC 4.0**（代码与语料同） | 中（自述真实情绪经历） | ②共情策略 schema | 情绪回应标注可直接借鉴 |
| **PersonaChat** | https://arxiv.org/abs/1801.07243 | 英语 | 众包合成（陌生人扮演） | 是 | 无（有 persona） | 无时间戳 | ParlAI 代码 MIT；语料：未找到明确语料许可声明 | 低（persona 为虚构） | ②角色设定范式 | 与自定义角色机制最接近 |
| **DailyDialog** | https://aclanthology.org/I17-1099/ | 英语 | 网页抓取（人工撰写） | 是 | 无（Relationship 是话题非关系） | 无（`__eou__` 扁平） | 作者声明仅科研禁商用；HF 卡标 cc-by-nc-sa-4.0 | 低 | ②日常话题参考 | 非真实聊天，无时间戳 |
| **NUS SMS Corpus** | https://github.com/kite1988/nus-sms-corpus | 英语 + 中文 | 真实（志愿者捐赠） | 否 | 无 | PARTIAL（论文称含发送时间戳；公开字段未证实） | 无 LICENSE；语料：未找到明确语料许可声明 | 高（号码脱敏，**人名不脱敏**） | ②短句风格参考 | 不成线程，不能算时延 |
| **SMS Spam Collection** | https://archive.ics.uci.edu/dataset/228/sms+spam+collection | 英语 | 真实（多源拼装） | 否 | 无 | 无（且非时间排序） | **CC BY 4.0**（UCI 明确） | 高（真实号码未脱敏） | 滥用词表 | 无上下文、无时间戳 |
| **Enron Email** | https://www.cs.cmu.edu/~enron/ | 英语 | 真实（企业邮件） | 邮件线索 | 无 | **有真实 Date + 收发人** | 语料：未找到明确语料许可声明 | **极高**（未同意、来自刑事调查） | 排除 | 职场邮件且伦理风险不可接受 |
| **EmotionPush** | https://doi.org/10.1109/GLOCOM.2018.8647331 | NOT VERIFIED | 真实（私人 Messenger） | 是 | 无 | **有回复时延 + 已读日志** | 未见公开下载；语料：未找到明确语料许可声明 | 高（仅实体替换脱敏） | ①时延/已读任务设计 | 数据可用性未证实 |
| **WildChat-4.8M** | https://huggingface.co/datasets/allenai/WildChat-4.8M | 多语（68） | 真实用户 × LLM | 是 | 无（无 roleplay 类别） | **有**：会话级 + assistant 每条时间戳 | **ODC-BY 1.0（可再分发）** | 高（opt-in 同意；Presidio 脱敏；保留 hashed IP/州/国/请求头） | ①行为规律补充 ②语气参考 | 唯一带真实时间戳且许可可再分发；但属人机对话 |
| **LMSYS-Chat-1M** | https://huggingface.co/datasets/lmsys/lmsys-chat-1m | 多语（154） | 真实用户 × LLM | 是 | 无 | **无时间戳** | 自定义门控协议，**禁止转让** | 高（故意保留不安全对话） | ②语气分布参考 | 无时间戳 + 禁止再分发 |
| **ChatHaruhi** | https://github.com/LC1332/Chat-Haruhi-Suzumiya | 中文 + 英语 | 影视剧本 | 是 | 有 persona + 逐条说话人 | 有说话人字段；时间戳未证实 | 代码 Apache-2.0；语料 README 称 CC-BY-NC-4.0 / HF 卡称 CC-BY-4.0（**冲突**） | 中（含疑似群聊真实文本） | ②角色对话参考 | 许可冲突 + 剧本版权 |
| **Cornell Movie-Dialogs** | http://www.cs.cornell.edu/~cristian/Cornell_Movie-Dialogs_Corpus.html | 英语 | 影视剧本 | 是 | 无关系标签；有 speaker/reply_to | **无** | 语料：未找到明确语料许可声明 | 版权风险（617 部电影） | ③本地评测骨架 | 有 reply_to 结构；文本不可再分发 |
| **Friends（Emory）** | https://github.com/emorynlp/character-mining | 英语 | 影视剧本（剧集转写） | 是 | 无关系标签；有 speaker/reply_to/被称呼者 | **无**（ConvoKit 明文 `timestamp: None`） | Emory **Apache-2.0**，但 NOTICE 明确不主张转写文本版权 | 版权风险（Warner Bros.） | ③本地评测骨架 | 标注最丰富；文本不可再分发 |
| **OpenSubtitles** | https://opus.nlpl.eu/datasets/OpenSubtitles | 多语（60+） | 影视字幕 | **否（句级平行对）** | 无（**schema 无 speaker**） | 无 | license 标签 `unknown` | 版权风险 | **不采纳** | 非对话语料：无说话人、无轮次 |
| **Russian Romantic Dialogue** | https://huggingface.co/datasets/DenSeduct/Russian_Romantic_Dialogue_Dataset | 俄语 | 自称真实（AI×真人） | 部分 | 无 | NOT VERIFIED | 上传者自标 CC-BY-NC-4.0 | **极高（疑似无同意 + 商业售卖）** | **排除** | 名称最贴需求但不可碰 |

## 4. 关键限制说明（必须遵守）

1. **以上任何一个都不等于真实情侣微信记录。** 中文关系标签来自**影视剧本或众包扮演**（CPED / MPDD / DDRel / Friends / DuLeMon），真实 IM 来自**单条短信或门控 EULA 语料**（NUS SMS / WICM）。任何"我们用了真实情侣聊天数据"的表述都是不实陈述。特别地：HuggingFace 上自称 `mit`/`apache-2.0` 的"个人微信导出"数据集**没有任何来源与同意依据，其许可标签无效**，不得使用。
2. **没有时间戳的数据，不能拿来声称学到了真实回复延迟。** 本轮明确**无时间戳**的包括：CDial-GPT/LCCC、CPED、MPDD、DDRel、DuLeMon、NaturalConv、豆瓣多轮、DailyDialog、EmpatheticDialogues、PersonaChat、SMS Spam Collection、LMSYS-Chat-1M、OpenSubtitles、Cornell、Friends。对它们只能谈论「句式/策略/标签分布」，**不得**输出"平均回复 X 秒"这类结论。
   - Friends 语料的官方文档就是现成的反面证据：ConvoKit 逐字写明 `timestamp: None. Our dataset does not contain timestamp information for utterances.`
   - 可以谈时延的只有三类：**WICM**（逐条 `datetime`）、**WildChat**（会话级 + assistant 每条时间戳，但属人机对话）、**arXiv:2605.03687**（基于真实 IM 的统计结论）。除此之外只能用自己的数据。
3. **影视对白必须筛掉旁白与戏剧腔。** 剧本里存在舞台指示、旁白、为戏剧张力服务的夸张台词；直接当"日常聊天"样本会系统性高估情绪强度与修辞密度。建议按句长、感叹号密度、称呼词、非对话性句子过滤，并**人工抽检**（OpenSubtitles 更进一步：它连说话人都没有）。
4. **网络截图不能直接视为可再分发语料。** 微博/小红书/贴吧上的"情侣聊天记录截图"：① 未经当事人同意；② 图像转文字后仍属个人信息；③ 再分发可能同时侵犯隐私与著作权。**只能作为灵感观察，不得入库、不得再分发、不得上传外部模型。**
5. **私人对话必须先确认「参与者同意 + 匿名化」，且不上传外部模型。** 参照 WICM 与 NUS SMS 的做法：同意方面，WICM 由参与者**主动捐赠**，NUS SMS 因"无法保证收信人同意"而**只收已发送消息**；匿名化方面**必须同时处理手机号与人名** —— NUS SMS 只替换号码、**未替换人名**，是可引以为戒的缺陷；出网方面，私人聊天内容**不得**提交给任何外部/云端模型服务，只能本地处理。中国法域下，私人聊天内容属个人信息，处理需具备《个人信息保护法》第 13 条的合法性基础；涉及第 28 条敏感个人信息类别的须依**第 29 条取得单独同意**（条文见 https://www.gangcha.gov.cn/html/4898/289552.html ）。
6. **提示词示例与评测对话必须分开，避免"自己考自己"。** 用于 few-shot / 提示词的角色范例，与用于打分的评测对话必须来自**不同来源或不同切分**（理想情况不同数据集）。否则评测只是在测"模型有没有背下示例"，指标虚高且不可解释。

## 5. 推荐落地方式

**优先用途排序**

1. **① 总结对话行为规律（最高优先，零许可成本）**：先读 arXiv:2605.03687，把它给出的时延/互惠规律作为外部基线（可引用、可复现）；用 MPDD 的 `field` / `position` / `relation` 三元结构 + RESCUE-Bench 的 `pursue_withdraw` / `attack_attack` / escalation / withdrawal / repair 作为**关系状态标签词汇表**；用 CharacterEval 的 4 维度 13 指标裁剪成 roleworld 自己的 5–7 条最小指标。
2. **② 少量获准示例（次优先，严格合规）**：**许可干净的首选**是 RoleBench（语料 **Apache-2.0**，英语+中文），其次 WildChat（**ODC-BY**，真实用户语气，含时间戳）；只从 **CC BY 4.0** 的 SMS Spam Collection 取**极少量**短句作风格参考。**NC 类要当心**：EmpatheticDialogues（CC BY-NC 4.0）、DailyDialog（作者声明禁商用）—— 若 roleworld 将来涉及任何商业化，**不得**使用。若要用真实私人聊天：必须参与者书面同意 + 手机号与人名**双重**匿名化 + **仅本地**处理，且**不入库、不再分发**。
3. **③ 独立评测集（最后做）**：以 CharacterEval 为蓝本自建中文多轮评测：每个角色 20–50 段，覆盖「人设一致性 / 情感恰当性 / 关系状态推进 / 安全性」；评测对话**不得**与提示词示例同源（见第 4 节第 6 条）。

**下一步最小动作（本周即可完成，不涉及下载训练）**

1. 人工精读 **CharacterEval** 的 20–30 段中文多轮样例（网页/HF 卡即可），写下 roleworld 要复用的 5 条人设一致性判据。
2. 人工精读 **MPDD** 的 `metadata.json` 关系类型表与 20 条例句，产出**中文关系/称谓词表**（含 couple/spouse 对应的中文称呼）。
3. 精读 **arXiv:2605.03687**，摘出 10 条可验证的日常聊天行为规律，标注每条的证据强度（论文直接结论 / 需自行复现）。
4. 参考 **DuLeMon** 的 persona grounding 标注方式（`U1`/`B5` 逐句标注），设计 roleworld 自己的「角色记忆命中」标注格式。
5. 把以上产出落到 `roleworld/docs/` 下的行为规律清单与评测指标草案；**此阶段仍不下载任何数据集、不接入任何私人聊天数据**。

> 若将来确实需要带时间戳的真实 IM，唯一合规路径是申请 **WICM** 的 EULA（学术身份 + 签署协议），而非寻找"野生"聊天记录。
