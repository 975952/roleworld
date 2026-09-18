# roleworld：角色发语音 / 表情包 / 语音转文字（2026-09-13 夜 ~ 09-14）

> 这份文档是这一轮工作的**交接说明**：做了什么、怎么验证的、哪些没做完、下一步怎么走。
> 结论先行：**表情包做完并测过；手机上"角色发语音"也做出来了** ——
> 走的是 Android 系统的 TTS 引擎（因为浏览器那条路在 WebView 里根本不存在，见第 3 节）。
> **还差的只有"在真机上按一次"这一步**：这一轮结束时手机被拔了，没验成。

责任边界：这一轮只改 `app/`、`scripts/`、`tests/` 与 `src-tauri/gen/android` 的生成目录旁路脚本，
**没有 commit、没有推 GitHub、没有动别人的文件**（工作区里其他人的在途改动原样保留）。

---

## 1. 一句话现状

| 交付 | 状态 | 在哪 |
|---|---|---|
| 表情包系统 | ✅ 做完 + 19 项用例 + 20 张表情渲染自检 + 浏览器冒烟 | `app/sticker-core.js`、`app/adapter/stickers.js`、`app/stickers/` |
| 表情包内容 | ✅ 2 套 20 张（情绪 12 + 应答 8），SVG、共约 13 KB | `scripts/make-stickers.cjs` 生成 |
| 用户发表情 | ✅ 输入框旁的表情按钮 + 选择面板 | `app/integration.js` |
| 角色语音（朗读） | ✅ **三端都有路**：Android 走原生系统 TTS，网页/桌面走浏览器语音；每角色一个音色；**真机待验** | `app/voice-core.js` + 外壳 `VoiceBridge` |
| 语音输入（说话→文字） | ⚠️ 三级链路都写了（内置识别 / 录音+云端转写 / 隐藏按钮），**真机未验** | `app/voice-core.js` |
| 测试 | ✅ 新增 `sticker-unit`(19) 与 `voice-unit`(21)；**全套 14 个套件 476 项全绿** | `tests/` |
| Android 包 | ✅ 含新功能（原生语音桥 + 麦克风权限 + 摄像头避让） | `dist/RoleWorld_0.1.54_android_universal.apk` |

那一份 APK：**9.92 MB**，
`SHA256 21cbbe2187c5d92410c636eb70ed83555cd6a04a901c4c479832e896471b00f5`，
已签名（v2+v3）、权限含 `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS`。
**注意**：它是在工作区当前代码上出的（里面也有别人未提交的改动），没有 commit。

---

## 2. 表情包：怎么用的、怎么改

### 角色怎么发表情

模型在回复最后单独起一行写标记，前端剥掉标记、把图排在气泡下面：

```
那我们说好了。
[[表情: 开心]]
```

* 支持全角括号、`[[sticker: happy]]`、`[[表情: 开心 | 想补充的说明]]`；
* **一轮最多一个**（多了只取第一个，标记照样全部剥掉）；
* 名字解析顺序：精确名字 → 别名 → 标签 → 词首/词尾包含；
  解析不出来**整条丢掉** —— 宁可没有表情，也不要一张破图；
* 提示词里把可用表情名列给模型（不列它就会自己编，例如"欣慰"），并明确"不要每句话都配表情"。

### 用户也能发表情

输入框右边的笑脸按钮 → 选一张 → 以 `[玩家发了一个表情：开心]` 的形式发出去
（角色"看得见"对方发了什么），图片靠消息上的 `roleworld_stickers` 显示，刷新后还在。

### 换成你自己画的那套

表情是**纯静态文件**，换掉目录即可，不用改一行代码：

```
app/stickers/index.json          { "packs": [ { "id": "mood", "path": "stickers/mood" } ] }
app/stickers/<包>/index.json     { id, label, stamps: [ { id, name, file, tags, aliases } ] }
app/stickers/<包>/<文件>           SVG / PNG / GIF / WebP 都行
```

* `tags` / `aliases` 是给模型"写得不标准"时兜底用的（写"微笑""happy"都命中"开心"）；
* 内置那套是 SVG（矢量、几 KB、任意分辨率不糊）。想放自己画的二次元表情，
  直接换成 PNG 就行 —— 尺寸建议 240×240 左右，透明背景。
* 重新生成内置那套：`pnpm stickers`；自检：`pnpm stickers:check`（会真渲染 + 量像素）。

---

## 3. 语音：为什么手机上还出不了声（**先看这条再动手**）

### 硬事实

**Android 的系统 WebView 里没有 `speechSynthesis`，而且是 Chromium 代码级关掉的**：

```cpp
// android_webview/lib/main/aw_main_delegate.cc
// Speech Synthesis backend resides in the chrome layer, not used by WebView.
cl->AppendSwitch(switches::kDisableSpeechSynthesis);
```

出处：<https://codereview.chromium.org/355183002/patch/1/10001>、
长期 issue <https://issues.chromium.org/issues/40468168>（Chromium 138 复现：`typeof speechSynthesis === "undefined"`）。

**不是版本问题、不是缺语音包、不是华为的问题** —— 等 WebView 升级也不会好。
所以"三端统一用浏览器自带语音"这条路**从根上不成立**，我原本的设计在手机上必然降级。

### 三端实际能力（我这一轮实测/调研的结论）

| 环境 | 朗读 | 语音输入 |
|---|---|---|
| 网页版（Chrome / Edge / Safari） | ✅ 可用，音色随系统 | ✅ 可用 |
| Windows 桌面版（WebView2） | ✅ 可用，但**只有 3 个中文音色**（Huihui / Kangkang / Yaoyao；微软把 Online Natural 那批在 WebView2 里关了） | ✅ 可用 |
| **Android 版（系统 WebView）** | ❌ **没有 API** | ❌ 没有内置识别；但**能录音**，可发给云端转写 |

### 我做了什么（现在是"探测 + 分级降级"）

* `app/voice-core.js`：能力探测、音色、朗读、念什么、语音输入、云端转写/合成，全是可测的纯逻辑；
* **每个角色一个音色**：由角色名确定性散列出语速 / 音高（同一个角色每次同一个声音，
  不同角色尽量不同），用户在设置里手调的优先；
* 界面上**没有能力就不显示**：没有合成器就不出现"朗读"菜单项、不显示"角色语音"那一行 ——
  摆一个点了没反应的按钮比没有更糟；
* 语音输入三级：内置识别 → 录音 + 你配置的 OpenAI 兼容转写接口（用你自己的 Key）→ 不显示按钮；
* 提示词/标记不会被念出来（`[[表情: …]]`、markdown 符号、括号里的动作都不念）。

### 手机上要真出声：**原生 Android TTS 已经做了**

系统 TTS 引擎（华为等机型通常预装）**离线可用**，我通过
`addJavascriptInterface` 把它暴露给了页面：

* **Kotlin 侧**（`src-tauri/gen/android/.../MainActivity.kt`，由
  `scripts/ensure-android-shell.cjs` 幂等生成）：一个 `VoiceBridge` 类，
  内部是 `android.speech.tts.TextToSpeech` + `UtteranceProgressListener`；
  桥名 `window.__rwNativeTts`，回调走 `window.__rwVoiceCallback(json)`。
* **JS 侧**（`app/voice-core.js`）：`speak()` 的分流变成
  **原生 TTS → 浏览器 speechSynthesis → 明确报错**，按**能力**而不是按平台判断。
  原来的每角色音色（`{rate, pitch}`）直接传给原生 `setSpeechRate` / `setPitch`。
* 开机预热：`integration.js` 启动时调一次 `init()`，否则用户第一次点「朗读」时
  引擎还没就绪，会白等一两秒甚至误报"没有中文语音包"。
* 设置里的说明会**按引擎的真实状态**变化：没装中文语音包时直接告诉他去哪儿装
  （系统设置 → 辅助功能 → 文字转语音）。

实现时踩到的要点（都在代码注释里）：

1. **`JavascriptInterface` 的方法跑在 WebView 的 JS 线程**，不是主线程 ——
   创建/操作 `TextToSpeech` 一律 `runOnUiThread`，否则直接崩。
2. **必须等 `OnInitListener` 回调 SUCCESS** 才能 speak，否则第一次调用无声。
   初始化期间来的请求先排队，就绪后补发。
3. **`setLanguage(SIMPLIFIED_CHINESE)` 的返回值要判**：`LANG_MISSING_DATA` /
   `LANG_NOT_SUPPORTED` 都要如实报给页面（别假装成功）。
4. WebView 的引用在 `onResume` 里找（`super.onCreate` 之后 Tauri 才建它，
   时机不稳）；`addJavascriptInterface` 可以重复调用，但从后台回来时先
   `removeJavascriptInterface` 再挂，避免重名。
5. `QUEUE_FLUSH`：新的一句顶掉上一句 —— 聊天里连点两次不该叠着念。

**前端不用改**已经是事实：这一层加好后，页面里原来的「朗读」菜单项自动就用上了原生引擎。

### 语音输入在 Android 上还能再进一步（没做）

Tauri 可以写一个薄插件直接调 Android 的 `SpeechRecognizer` / `RecognizerIntent`
（Android 12 支持离线语言包），这样彻底绕开 WebView 的限制，而且**不花一分钱 API 费用**。
比现在"录音 → 发云端转写"更符合本地优先的定位。
（社区先例：`tauri-plugin-audio-recorder`。）

### 另一条路（更重，但音质好）

浏览器内跑本地神经 TTS（Kokoro-82M-v1.1-zh Apache-2.0 + sherpa-onnx WASM）：
需要**单线程 + WASM SIMD**，模型 int8 约 **127 MB**（fp16 164 MB），
**不需要 SharedArrayBuffer / COOP-COEP**（Android WebView 永远做不到 cross-origin isolation，
所以单线程是唯一路线）。手机 CPU 上单句可能几百 ms~数秒，要做流式。
这条路我在这一轮**没有动** —— 它需要下载模型、放进包、并且只有真机能验，风险不该压在一夜之间。

> **许可地雷（调研结论，写在这里省得再踩）**：Kokoro / sherpa-onnx / MeloTTS 是
> Apache-2.0 / MIT，可以随包分发；**piper 的中文权重 `zh_CN-huayan` 训练数据许可 Unknown，
> 不要随包分发**；**espeak-ng 是 GPL-3.0**（piper 继任者因此转 GPL）；ChatTTS / Mimic3 是 AGPL。

---

## 3.5 语音输入（说话 → 文字）的现状与依据

调研结论（都有出处，详见本轮两份调研报告）：

* **Android WebView 里 `webkitSpeechRecognition` 也不存在**（同 Web Speech 那条：Chromium 的
  识别实现走 Google 的在线服务，只随品牌版 Chrome 分发）。所以"手机上按住说话"不能依赖它。
* **但录音可以用**：`getUserMedia` + `MediaRecorder` 在三端都行。
  **Tauri v2 已经替我们处理了 Android 的 `onPermissionRequest`**（wry 的
  `RustWebChromeClient.kt` 会自己弹系统授权），**不需要写 Kotlin**；
  但**必须在 AndroidManifest 里声明 `RECORD_AUDIO`** —— 这一轮我补上了，
  并且做成了幂等脚本（`scripts/ensure-android-shell.cjs`），因为：
  **那个 Manifest 在生成目录里，`tauri android init` 会覆盖它。**
* **Cloudinary 之外的云转写**：OpenAI 形状的 `/v1/audio/transcriptions`，
  `file` + `model` + `language=zh`；**格式 webm / m4a 都在官方支持列表里**
  （正好覆盖 Chrome 的 webm/opus 与 Safari 的 mp4），但**必须给带扩展名的 filename**
  —— 官方规范原文要求"the request must include enough format metadata"，纯前端发 FormData 时
  最容易漏的就是这个。
  更便宜的替代（如果用户愿意自己配）：AssemblyAI Universal-2 约 $0.0025/分钟、
  Deepgram Nova-3 约 $0.0043/分钟，都低于 OpenAI 的 $0.006。
* **一条被低估的免费退路**：**输入框本来就是普通 `<textarea>`，用户可以用系统输入法的语音输入**
  （讯飞/百度/华为输入法的麦克风键）—— 零代码、零权限、零成本、中文效果最好，
  而且输入法在系统层，WebView 的限制管不到它。所以麦克风按钮失败时，
  提示文案应该直接引导到"点输入框、用键盘上的 🎤"，而不是只说一句"不支持"。

### 我在这一轮实现的语音输入链路

```
按下麦克风
 ├─ 有内置识别（网页版/桌面版）→ 边说边出字 → 松开结束
 ├─ 只能录音（Android）→ 录一段 → 发给用户自己配的 OpenAI 兼容转写接口
 │                        （没配 Key 就明确说"缺什么、在哪配"）
 └─ 都没有 → 按钮根本不显示
```
这样在 Android 上，**配了 Key 就能用**；没配也不会出现一个点了没反应的按钮。

---

## 4. 怎么验证的（可复现）

```bash
cd C:\novel-llm\roleworld
node tests/sticker-unit.cjs     # 19 项：名字解析 / 标记剥除 / 提示词 / 磁盘清单 / 两种入参形状
node tests/voice-unit.cjs       # 19 项：三端能力探测 / 念什么 / 音色 / 云端兜底
node scripts/smoke-app.cjs      # 真浏览器打开 app/：抓控制台报错 + 现场解析一条表情标记
pnpm stickers                   # 重新生成 20 张表情
pnpm stickers:check             # 渲染 + 量像素（覆盖率 / 中央有没有五官 / 颜色数 / 有没有被裁）
npm test                        # 全套 14 个套件
```

**两处自检都做了"变异测试"（证明它会红，不是摆设）**：

* 把一张表情换成"只有底色块" → `check-stickers` 报「中间区域几乎是空的」；
  换成空 SVG → 报「不是完整 SVG + 画面太空」。**第一次做的时候"只有底色块"漏过了，
  是因为我一开始只数颜色数 —— 底色 + 描边就已经两种颜色了**，后来才补上"中央必须有笔墨"。
* 测试直接抓到三个真 bug：`[[sticker: nod]]` 英文写法解析不到、内置表情 id 少了包前缀、
  以及**我自己的别名表把 `大笑` 写成了 `开心` 的别名**（导致真实存在的"大笑"永远解析不出来）。

### 冒烟测试抓到的两个"看代码看不出来"的 bug（都值得记）

1. **`global` 在浏览器里不存在**：我在 `task22-core.js` 里写了 `global.RoleWorldStickers` ——
   Node 有 `global`、浏览器没有；反过来 `window` 在 Node 里也没有。
   这个文件是**双端**的，于是"没装表情时发一条消息"就会抛异常。
   修法：文件开头定义 `GLOBAL = globalThis`（两端都有），全部改用它。
2. **测试和真实调用形状不一致，等于没测**：`indexStamps` 一开始只认包数组
   `[{ id, stamps: [...] }]`，而 adapter 真实产出的是**扁平数组** `[{ id: "mood:happy", ... }]`。
   结果：真实路径下一个表情都解析不出来，而单元测试全绿。
   现在 `indexStamps` 两种形状都吃，并且专门补了两条回归用例（"扁平数组也能解析"）。
   **这条是浏览器冒烟测试抓到的**，光跑单元测试永远发现不了。

---

## 5. 没做完 / 没验的部分（别当成已验收）

### ✅ 已经在真机上验通的（2026-09-14，华为 Mate 70 Pro / Android 12）

**"手机上角色能出声"这件事已经打通并实测到了**。原生侧的日志文件
（`Android/data/app.roleworld.desktop/files/voice-log.txt`，adb 直接可读）里是完整的证据链：

```
init() called; creating TextToSpeech
TextToSpeech init state=0 (0=SUCCESS)       ← 系统引擎初始化成功
selfTest: calling speak (ttsNull=false ready=true)   ← 中文语音包就绪
engine.speak code=0 (0=SUCCESS)             ← 引擎接受了这次朗读
event=start → event=done（约 4 秒）           ← 真的念完了
```

**这一路上踩的四个坑**（都是自己的 bug，写在这里省得再踩）：

| 坑 | 现象 |
|---|---|
| 桥挂在 `onResume` 里 | **锁屏期间启动时 `onResume` 根本不触发** → 页面永远拿不到桥 |
| 改成在 `onCreate` 挂 | 那时 Tauri 的 WebView **还没建好**（日志 `attachBridge not found`） |
| 每次挂桥都**新建实例** | 页面 `init()` 初始化的是 A、挂给页面的是 B → 永远"引擎 null、点了没声音" |
| 页面预热只试一次 | 桥晚到就直接放弃 → 引擎永远没初始化 |

最终做法：`onCreate` 建好唯一实例后**每 400ms 重试挂载（最多 25 次）**；页面侧
"拿不到桥就轮询 + 听就绪事件"再试。**观测通道**也是这轮才找到的：华为 WebView 不把
console 转发到 logcat、APK 又不是 debuggable，所以让原生侧把状态写进应用外部目录，
再用 `adb shell cat` 读 —— 这是这个环境下唯一能用的通道。

### 还没做的

1. **"菜单里有朗读"在真机上仍待用户确认**（2026-09-14 反馈"只有复制/重新回答/分支"）：
   * 已查到根因候选并修掉：**菜单项原来是渲染时算一次就定死的**，
     而真机上原生桥是外壳在 Activity 起来之后才挂上页面（要重试几秒），
     历史消息在那之前就渲染完了 → 菜单永久少一项。现在改成**每次打开菜单现算**，
     并且外壳在 `onCreate` 里就 `init()` 引擎（不再等页面）。
   * **已用能复现该时序的探针验证**：`scripts/bridge-probe.cjs` 会在页面加载前
     把 `speechSynthesis` 拿掉（模拟 Android WebView）并让桥**晚 3 秒**出现，
     结果菜单是 `copy, regenerate, speak, branch` ✅。
     （第一版回归用例写错了：无头 Chrome 自带 `speechSynthesis`，"没有桥"也照样能朗读，
     所以那个用例证明不了任何事 —— 探针就是为了修这个而写的。）
   * 另外发现真机上可能出现"装了新包、页面还是旧行为"，所以外壳现在会在首次挂桥时
     `clearCache(true)`，并带一个外壳版本标记（`shell rev …`）便于对版本。
2. **表情包在手机上没看过**：逻辑与渲染都测过（19 项 + 像素自检 + 浏览器端到端），
   但真机上"表情显示得对不对、按钮位置挡不挡输入框"没验。
3. **语音输入在真机上没验**：Android 上没有内置识别（Chromium 不提供），
   走的是"录音 → 你自己配的转写接口"；这条路**没跑通过**。
4. **云端转写只写了接口**：没配过真 Key 跑通过一次。
5. **自检脚本依赖本机 Chrome**（`check-stickers.cjs` / `smoke-app.cjs` / `bridge-probe.cjs`），
   CI 上没有 Chrome 时会跳过（只做清单与结构检查），这是刻意的降级。
6. **两处"自检用的临时行为"已经停用**（留了开关，需要重验时再打开）：
   页面侧念英文（`false && …`）与原生侧 `speakSelfTest()`（注释掉了）。
7. **没有 commit**：所有改动都在工作区，和别人的在途改动混在一起。
8. **一个接口上的小约束**：`stickerInstruction()` 会把所有表情包的名字列进系统提示
   （最多 24 个）。包多了要改成"只列当前角色常用的那几个"。

---

## 6. 建议的下一步

按"价值 ÷ 风险"排：

1. **手机原生 TTS**（半天，手机上唯一能出声的路）—— 我建议先做这个，
   做完手机上"角色发语音"才算真的成立；前端不用改，只加一个 provider。
2. **真机验收这一轮的东西**（半小时）：表情显示、按钮位置、语音输入到底走哪条路。
3. **用户自制表情包**：现在换表情要改目录；可以做成设置里"导入一个 zip/文件夹"。
   （表情是静态文件，导入 = 存进 IndexedDB 的 blobs + 生成一份清单，工作量不大。）
4. **本地神经 TTS**（1~2 天）：音质最好但要下载 130 MB 模型，且需要真机验证耗电与延迟。
