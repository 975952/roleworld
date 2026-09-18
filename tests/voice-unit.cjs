"use strict";

/*
 * voice-unit.cjs —— 语音的纯逻辑测试（不需要浏览器、不联网、不花钱）
 *
 * 这一轮（2026-09-14）语音改成**只走云端**（火山「豆包语音合成模型 2.0」，经体验卡中转），
 * 砍掉了系统朗读与安卓原生桥。所以这里要钉住的东西也换了：
 *
 *   ① **能力探测的三个条件**：打开开关 + 在用体验卡 + 中转配了语音。
 *      探错了界面就会出现一个点了没反应的喇叭 —— 而且**绝不能再退回系统朗读**
 *      （那会让同一个角色有时候是情感音色、有时候是导航播报腔）。
 *   ② **念什么、以及不静默截断**：标记不念、符号不念，但长文本要分段念完，一个字不丢。
 *   ③ **每角色一个音色，用稳定标识存**：改名不该换声音。
 *   ④ **旧设置的迁移**：旧的语速按同一语义换算，旧的音高**不冒充**云端参数。
 *   ⑤ **缓存键算全**：文本 + 音色 + 所有影响声音的参数 + 模型/资源 + 中转。
 *   ⑥ **调度**：顺序、缓存命中不重复请求、取消真的停、可重试的才重试。
 */

const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error });
    console.log("  FAIL  " + name + "\n        " + (error && error.message ? error.message : String(error)));
  }
}

const MODULE_PATHS = {
  core: path.join(ROOT, "app", "voice-core.js"),
  cache: path.join(ROOT, "app", "voice-cache.js"),
  cloud: path.join(ROOT, "app", "adapter", "voice.js"),
};

const CLEAN_KEYS = [
  "speechSynthesis", "SpeechSynthesisUtterance", "SpeechRecognition", "webkitSpeechRecognition",
  "MediaRecorder", "navigator", "RoleWorld", "RoleWorldCard", "RoleWorldModel", "RoleWorldStore",
  "__rwNativeTts", "__rwVoiceCallback", "__rwVoiceSettingsSnapshot", "fetch",
  "RoleWorldVoice", "RoleWorldVoiceCache", "RoleWorldVoiceCloud",
];
// ⚠ Blob 刻意**不**在这里：它是 Node 自带的标准件，语音模块真的要用它，
// 清掉只会让用例报 "global.Blob is not a constructor"（不是一个有用的模拟）。

/**
 * 造一个"假运行环境"再把三个模块加载进去（模块都是挂 global 的，所以要先摆好环境）。
 * 每个用例结束时 restore() 会把这些全局**全部还原**，避免上一个用例的替身漏到下一个
 * （这个坑上一版踩过：桌面的替身漏进了手机用例）。
 */
function loadVoice(env) {
  const g = globalThis;
  const saved = {};
  for (const key of CLEAN_KEYS) {
    saved[key] = g[key];
    delete g[key];
  }
  Object.assign(g, env || {});
  for (const key of Object.values(MODULE_PATHS)) delete require.cache[require.resolve(key)];
  // 顺序与 index.html 一致：core → cache → adapter。
  const core = require(MODULE_PATHS.core);
  const cache = require(MODULE_PATHS.cache);
  const cloud = require(MODULE_PATHS.cloud);
  return {
    core, cache, cloud,
    restore() {
      for (const key of CLEAN_KEYS) {
        if (saved[key] === undefined) delete g[key];
        else g[key] = saved[key];
      }
      for (const key of Object.values(MODULE_PATHS)) delete require.cache[require.resolve(key)];
    },
  };
}

/** 一个能记账的假播放器：把"播了什么"留下来给断言看。 */
function fakePlayer(options) {
  const opts = options || {};
  const played = [];
  let stopping = false;
  return {
    played,
    play(blob, run) {
      played.push(blob);
      if (opts.failOn && opts.failOn === played.length) {
        return Promise.resolve({ ok: false, reason: "这段音频播不出来（文件可能不完整）。" });
      }
      if (opts.hold) {
        return new Promise((resolve) => {
          const signal = run && run.signal;
          if (signal && signal.aborted) return resolve({ ok: true, canceled: true });
          if (signal) signal.addEventListener("abort", () => { stopping = true; resolve({ ok: true, canceled: true }); }, { once: true });
          opts.hold(() => resolve({ ok: true }));
        });
      }
      return Promise.resolve({ ok: true });
    },
    stop() { stopping = true; },
    isPlaying: () => false,
    stopped: () => stopping,
  };
}

const SPEAKERS = [
  { id: "zh_female_vv_uranus_bigtts", label: "vivi 2.0" },
  { id: "zh_male_m191_uranus_bigtts", label: "云舟" },
  { id: "zh_female_xiaohe_uranus_bigtts", label: "小何" },
  { id: "en_male_tim_uranus_bigtts", label: "Tim" },
];

/** 造一个"在用体验卡"的假适配层。 */
function fakeAdapter(settings) {
  const store = new Map();
  return {
    saved: [],
    settings: Object.assign({ card_relay: "https://relay.example.com", provider: "custom" }, settings || {}),
    store,
    async getLocalSettings() { return JSON.parse(JSON.stringify(this.settings)); },
    async saveLocalSettings(patch) {
      this.saved.push(patch);
      Object.assign(this.settings, patch);
      return this.settings;
    },
  };
}

function fakeCard(active) {
  return {
    async currentState() {
      return active === false
        ? { active: false }
        : { active: true, token: "RW-AAAAA-BBBBB-CCCCC", relay: "https://relay.example.com" };
    },
    describeCardError(status, body) {
      const code = body && body.error ? body.error.code : "";
      if (code === "CARD_NO_VOICE") return "这张体验卡的语音次数用完了。";
      if (String(code).indexOf("CARD_") === 0) return (body.error.message || "体验卡不可用") + "（换一张卡或填自己的 Key）";
      return null;
    },
  };
}

/** 假中转：只实现 /voice/info 与 /v1/audio/speech。 */
function fakeFetch(options) {
  const opts = options || {};
  const calls = [];
  const api = async (url, init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body, headers: (init && init.headers) || {} });
    if (String(url).endsWith("/voice/info")) {
      if (opts.infoStatus && opts.infoStatus !== 200) {
        return jsonResponse(opts.infoStatus, opts.infoBody || { error: { code: "CARD_UNKNOWN", message: "这张体验卡不认识" } });
      }
      return jsonResponse(200, Object.assign({
        ok: true, enabled: true, speakers: SPEAKERS, defaultSpeaker: SPEAKERS[0].id,
        maxChars: 400, format: "mp3", model: "seed-tts-2.0-standard", resourceId: "seed-tts-2.0",
        voiceLeft: 9, voiceCharsLeft: 900,
      }, opts.info || {}));
    }
    if (opts.speechFail) return jsonResponse(opts.speechFail.status, opts.speechFail.body);
    if (opts.speechThrow) throw new TypeError("Failed to fetch");
    const audio = Buffer.from("MP3:" + String(body.text || ""));
    return {
      ok: true, status: 200,
      headers: fakeHeaders({ "content-type": "audio/mpeg", "x-rw-voice-chars": String(String(body.text || "").length), "x-rw-voice-speaker": body.speaker || "" }),
      async arrayBuffer() { return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength); },
      async json() { return {}; },
      async text() { return ""; },
    };
  };
  api.calls = calls;
  return api;
}

function fakeHeaders(map) {
  const lower = {};
  for (const [key, value] of Object.entries(map || {})) lower[String(key).toLowerCase()] = value;
  return { get: (name) => (lower[String(name).toLowerCase()] === undefined ? null : lower[String(name).toLowerCase()]) };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: fakeHeaders({ "content-type": "application/json" }),
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

(async () => {
  console.log("== 语音：能力探测（开关 + 体验卡 + 中转，三条都要） ==");

  await test("没打开「角色语音」→ 不能朗读，原因指向那个开关", async () => {
    const adapter = fakeAdapter({ voice_enabled: false });
    const env = loadVoice({ RoleWorld: adapter, RoleWorldCard: fakeCard(true), fetch: fakeFetch() });
    try {
      env.cloud.noteSettings(await adapter.getLocalSettings());
      const cap = env.cloud.capability();
      assert.equal(cap.canSpeak, false);
      assert.ok(/还没打开/.test(cap.reason), "原因要指向那个开关：" + cap.reason);
    } finally { env.restore(); }
  });

  await test("打开了开关、但没在用体验卡 → 不能朗读，并说清「语音要用卡」", async () => {
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(false),
      fetch: fakeFetch(),
    });
    try {
      env.cloud.noteSettings({ voice_enabled: true });
      await env.cloud.refresh({ force: true });
      const cap = env.cloud.capability();
      assert.equal(cap.canSpeak, false);
      assert.ok(/体验卡/.test(cap.reason), "要说清要用体验卡：" + cap.reason);
      assert.ok(/没有在用体验卡/.test(cap.reason), "不能只是碰巧提到体验卡：" + cap.reason);
    } finally { env.restore(); }
  });

  await test("有卡、但中转没配火山凭据 → 不能朗读，原因来自中转（文字聊天不受影响）", async () => {
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(true),
      fetch: fakeFetch({ info: { enabled: false, reason: "这个中转还没配语音（服务端缺火山凭据）。" } }),
    });
    try {
      env.cloud.noteSettings({ voice_enabled: true });
      await env.cloud.refresh({ force: true });
      const cap = env.cloud.capability();
      assert.equal(cap.canSpeak, false);
      assert.ok(/中转/.test(cap.reason), "要说是中转那边没配：" + cap.reason);
    } finally { env.restore(); }
  });

  await test("三条都满足 → 能朗读，音色表来自中转", async () => {
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(true),
      fetch: fakeFetch(),
    });
    try {
      env.cloud.noteSettings({ voice_enabled: true });
      await env.cloud.refresh({ force: true });
      const cap = env.cloud.capability();
      assert.equal(cap.canSpeak, true, cap.reason);
      assert.equal(cap.speakers.length, SPEAKERS.length);
      assert.equal(cap.defaultSpeaker, SPEAKERS[0].id);
      assert.equal(cap.maxChars, 400);
    } finally { env.restore(); }
  });

  await test("**不再退回系统朗读**：有 speechSynthesis 但没有卡，照样不能朗读", async () => {
    // 这一条是这一轮的方向性守卫：以前"云端不行就退回本机朗读"，
    // 那会让同一个角色有时候是情感音色、有时候是导航播报腔。
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(false),
      speechSynthesis: { speak() { throw new Error("不该被调到"); }, getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {} },
      SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
      fetch: fakeFetch(),
    });
    try {
      env.cloud.noteSettings({ voice_enabled: true });
      await env.cloud.refresh({ force: true });
      assert.equal(env.cloud.capability().canSpeak, false, "有系统朗读也不该因此说能朗读");
      // 而且这个模块里**根本没有** speak 这个函数了（系统朗读那条路被删掉了）
      assert.equal(typeof env.core.speak, "undefined", "voice-core 不该再暴露 speak（系统朗读）");
      assert.equal(typeof env.core.hasNativeTts, "undefined", "voice-core 不该再认识原生桥");
    } finally { env.restore(); }
  });

  await test("原生桥在也不影响判断（那一轮已经不做安卓系统 TTS 了）", async () => {
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(false),
      __rwNativeTts: { speak() {}, stop() {}, init() {}, status: () => "{}" },
      fetch: fakeFetch(),
    });
    try {
      env.cloud.noteSettings({ voice_enabled: true });
      await env.cloud.refresh({ force: true });
      assert.equal(env.cloud.capability().canSpeak, false);
    } finally { env.restore(); }
  });

  console.log("== 语音：念什么 ==");

  await test("记忆/表情/搜索/事件标记都不念出来", () => {
    const { core, restore } = loadVoice({});
    try {
      const text = "好啊。[[表情: 开心]]\n[[记住: 喜欢的饮料 | 玩家喜欢咖啡]]\n[[事件: 一起去了图书馆]]\n[[搜索: 魔杖]]";
      const spoken = core.speakableText(text);
      for (const word of ["表情", "记住", "事件", "搜索"]) {
        assert.ok(spoken.indexOf(word) < 0, word + " 标记被念出来了：" + spoken);
      }
      assert.ok(spoken.indexOf("好啊。") >= 0, "正文被误删");
    } finally { restore(); }
  });

  await test("模型模仿出来的时间前缀要被摘掉（不该显示、更不该被念）", () => {
    // 用户 2026-09-18 实测：角色 Alaric Vane 的回复变成了
    //   `[09-18 19:08] 好，那就是懒得打字。我认了。……`
    // —— 历史里每条消息前面都带 `[MM-DD HH:MM]`（"消息时间进提示词"），模型照着写了。
    // 那串是给模型看历史时间的，不是内容。那条的语音合成一路失败
    //（「上游说合成结束了，但一个字节的音频都没给」），而试听在同音色同链路下正常，
    // 差别就落在这段带前缀的文本上。
    const { core, restore } = loadVoice({});
    try {
      const withPrefix = "[09-18 19:08] 好，那就是懒得打字。我认了。";
      assert.equal(core.stripLeadingTimePrefix(withPrefix), "好，那就是懒得打字。我认了。");
      // 朗读那一份必须已经摘掉
      assert.equal(core.voiceMessageText(withPrefix), "好，那就是懒得打字。我认了。");
      assert.ok(core.speakableText(withPrefix).indexOf("09-18") < 0, "朗读文本里还留着时间前缀");
      // 反面对照：正文里**中间**出现的时间戳不许动（那是内容，可能是角色在念时间）
      const inside = "他说：「我们 09-18 19:08 见。」";
      assert.equal(core.stripLeadingTimePrefix(inside), inside, "只该摘开头的那个，中间的不许动");
      // 没有前缀时一个字都不改
      assert.equal(core.stripLeadingTimePrefix("你好。"), "你好。");
    } finally { restore(); }
  });

  await test("只有标点 / 表情的文本不算「能念的内容」（用户 0.1.77 报的零字节音频）", () => {
    // 用户实测原话（角色 Alaric Vane 的一条语音消息）：
    //   「这条语音没做出来 / 上游说合成结束了，但一个字节的音频都没给。」
    // 那一串的来源：清洗之后**仍然非空**的 `……` / `😀` / `——` 被送去上游，
    // 上游没有可念的东西 → 回「合成结束」+ 零字节音频。
    // 所以"能不能念"必须单独判一次，不能只判空串。
    const { core, restore } = loadVoice({});
    try {
      for (const text of ["……", "——", "😀", "😀😀", "。。。", "   ", "!?!", "···"]) {
        assert.equal(core.hasSpeakableContent(text), false, JSON.stringify(text) + " 不该算能念的内容");
      }
      for (const text of ["好", "hi", "……好。", "3", "2024", "Ок", "はい", "안녕"]) {
        assert.equal(core.hasSpeakableContent(text), true, JSON.stringify(text) + " 应当算能念的内容");
      }
      // 真实场景：整段都是括号里的动作 —— 清洗完只剩标点，一样要挡住。
      const cleaned = core.speakableText("（他把书合上。）");
      assert.equal(core.hasSpeakableContent(cleaned), false,
        "清洗之后没有能念的字就该挡住：" + JSON.stringify(cleaned));
      // 反面对照：正常回复清洗完必须还能念（别把正常内容一起挡了）。
      assert.equal(core.hasSpeakableContent(core.speakableText("「明天见。」他挥了挥手。")), true,
        "正常回复被误挡了");
    } finally { restore(); }
  });

  await test("markdown 符号与括号里的动作都不念", () => {
    const { core, restore } = loadVoice({});
    try {
      const spoken = core.speakableText("**很重要**的一句话，见 `代码` 与 #标题（笑）");
      assert.ok(spoken.indexOf("*") < 0 && spoken.indexOf("`") < 0 && spoken.indexOf("#") < 0, "符号没清掉：" + spoken);
      assert.ok(spoken.indexOf("笑") < 0, "括号里的动作被念了：" + spoken);
      assert.ok(spoken.indexOf("很重要") >= 0);
    } finally { restore(); }
  });

  await test("只念对白：开关打开时跳过旁白", () => {
    const { core, restore } = loadVoice({});
    try {
      const text = "他点点头，把书推过来。\"这一页你先看。\"";
      assert.ok(core.speakableText(text).indexOf("他点点头") >= 0, "默认应该连旁白一起念");
      const dialogueOnly = core.speakableText(text, { skipNarration: true });
      assert.ok(dialogueOnly.indexOf("这一页你先看") >= 0, "对白要留下");
      assert.ok(dialogueOnly.indexOf("他点点头") < 0, "旁白要跳过：" + dialogueOnly);
    } finally { restore(); }
  });

  await test("**不再静默截断**：超长文本一个字都不丢（旧版在这里 slice 掉过）", () => {
    const { core, restore } = loadVoice({});
    try {
      const long = "这是一句很长的话。".repeat(300);   // 2700 字，远超旧版的 1200 上限
      const spoken = core.speakableText(long);
      assert.ok(spoken.length > 2000, "被截断了：只剩 " + spoken.length + " 字");
      assert.equal(spoken, long.trim(), "内容被改动了");
    } finally { restore(); }
  });

  /* ---- 角色发语音消息（2026-09-14 用户拍板）：只念对白、太长就不发 ---- */

  await test("语音消息只念对白：屏幕上是纯对白，听到的也是同一份（渲染与语音共用一份规则）", () => {
    const { core, restore } = loadVoice({});
    try {
      const text = "（他把书合上。）\"这一页你先看。\"";
      const spoken = core.voiceMessageText(text);
      assert.equal(spoken, "这一页你先看。", "语音消息只该念对白：" + JSON.stringify(spoken));
      // 同一个来源：渲染用的 dialogueSegments 与它必须一致（免得看到的和听到的不一样）
      assert.deepEqual(core.dialogueSegments(text), [spoken], "渲染与语音用的不是同一份文本");
      // 一句引号都没有时不能把内容吞掉（模型没按格式写）
      assert.equal(core.voiceMessageText("他点点头，没说话。"), "他点点头，没说话。");
    } finally { restore(); }
  });

  await test("语音消息**太长就不发**（不是偷偷截断）：默认上限 120 字", () => {
    const { core, restore } = loadVoice({});
    try {
      const quote = (body) => "\"" + body + "\"";
      assert.equal(core.voiceMessageText(quote("字".repeat(core.VOICE_MESSAGE_MAX_CHARS))).length,
        core.VOICE_MESSAGE_MAX_CHARS, "刚好到上限的应当照发");
      assert.equal(core.voiceMessageText(quote("字".repeat(core.VOICE_MESSAGE_MAX_CHARS + 1))), "",
        "超一个字就该不发语音，而不是截断 —— 截断会让用户听到半句话");
      assert.equal(core.voiceMessageText(""), "", "空内容不发语音");
      assert.equal(core.voiceMessageText("   "), "", "只有空白也不发语音");
    } finally { restore(); }
  });

  await test("语音里不带动作/神态描写：括号与星号包着的一律不念（用户实测反馈）", () => {
    // 用户 2026-09-14 实测：「（把最后一盏灯关了，只留门口那点光）关门了。这是何意味，
    // 我说了就语音，不要文字也不要描述」——提示词压不住时，这里再兜一道。
    const { core, restore } = loadVoice({});
    try {
      assert.equal(core.voiceMessageText("（把最后一盏灯关了，只留门口那点光）关门了。"), "关门了。",
        "括号里的动作被念出来了");
      assert.equal(core.voiceMessageText("“（笑）你好呀。”"), "你好呀。", "引号里的括号描写也没清掉");
      assert.equal(core.voiceMessageText("*微笑* 在的。"), "在的。", "星号包着的描写没清掉");
      // 整条就是一段动作时**不能吞空**（宁可留着，也不要把内容变成空的）
      assert.equal(core.voiceMessageText("（他点点头）"), "（他点点头）");
      // 屏幕上与嘴里必须是同一份：渲染也走同一条清理
      assert.deepEqual(core.dialogueSegments("（把灯关了。）关门了。"), ["关门了。"]);
    } finally { restore(); }
  });

  await test("一轮可以分成几条消息：空行分段、能标出哪几条是语音、超上限不丢字", () => {
    const { core, restore } = loadVoice({});
    try {
      // 两条文字 + 一条语音（用户 2026-09-14：「我发一条他不一定就发一条，也可以发几条」）
      const parts = core.splitReplyParts("第一句。\n\n第二句。\n\n就这一句。\n[[语音]]");
      assert.deepEqual(parts.map((one) => one.kind), ["text", "text", "voice"], JSON.stringify(parts));
      assert.equal(parts[0].text, "第一句。");
      assert.equal(parts[2].text, "就这一句。", "语音那条的正文不对：" + JSON.stringify(parts[2]));
      assert.ok(parts[2].text.indexOf("[[") < 0, "标记留在了语音条里");
      // 没有空行 = 一条消息（不能把人家一段话拆散）
      assert.equal(core.splitReplyParts("就一段话，没有空行。").length, 1);
      // 段内的单换行保留（同一条消息里的换行）
      assert.equal(core.splitReplyParts("第一行\n第二行").length, 1);
      // 空段丢掉；只有标记的段也丢掉（没有要说的话）
      assert.deepEqual(core.splitReplyParts("\n\n   \n"), []);
      assert.deepEqual(core.splitReplyParts("[[语音]]"), []);
      // 超过上限：并进最后一条，**一个字都不能丢**
      const many = core.splitReplyParts("1\n\n2\n\n3\n\n4\n\n5");
      assert.equal(many.length, core.MAX_REPLY_PARTS, "条数应当被夹到上限：" + many.length);
      const joined = many.map((one) => one.text).join("");
      for (const piece of ["1", "2", "3", "4", "5"]) {
        assert.ok(joined.indexOf(piece) >= 0, "超上限时丢了内容：" + piece + " → " + JSON.stringify(many));
      }
    } finally { restore(); }
  });
  await test("`[[语音]]` 标记：存下来之前就剥掉，半截标记也不能进正文", () => {
    const { core, restore } = loadVoice({});
    try {
      const parsed = core.extractVoiceMessage("“在的。”\n[[语音]]");
      assert.equal(parsed.wantVoice, true, "完整标记要认出来");
      assert.ok(parsed.text.indexOf("[[") < 0 && parsed.text.indexOf("语音") < 0, "标记留在了正文里：" + parsed.text);
      assert.equal(core.extractVoiceMessage("“在的。”").wantVoice, false, "没写标记就不该发语音");
      assert.equal(core.extractVoiceMessage("“在的。”\n[[语").wantVoice, false, "半截标记不算数");
      // 流式渲染：半截标记不能显示出来
      assert.equal(core.stripPartialVoiceMarker("他把书合上。\n[[语"), "他把书合上。");
      assert.equal(core.stripPartialVoiceMarker("他把书合上。\n[[v"), "他把书合上。");
      // ⚠ 只要求**两个**左括号：普通的句尾一个左括号是正文，不能被吃掉（写成 [\[【]{1,2} 就会吃）
      assert.equal(core.stripPartialVoiceMarker("他写下：[1"), "他写下：[1", "普通的左括号被当成标记吃了");
    } finally { restore(); }
  });

  console.log("== 语音：分段（顺序完整、不重复、不丢字） ==");

  await test("长文本分段后拼起来与原文**逐字节相同**（顺序完整）", () => {
    const { core, restore } = loadVoice({});
    try {
      const cases = [
        "第一句。第二句！第三句？第四句；第五句\n第六句",
        "没有标点的一整段话".repeat(60),
        "啊".repeat(1000),
        "Mixed 中英文 punctuation! Really? 是的。OK",
        "只有一个逗号，剩下的都很长，".repeat(40),
      ];
      for (const source of cases) {
        const chunks = core.splitForSpeech(source, { maxChars: 80 });
        assert.ok(chunks.length >= 1, "至少要有一段");
        assert.equal(chunks.join(""), source.trim(), "拼起来和原文不一致（顺序或内容被改动了）");
        for (const chunk of chunks) {
          assert.ok(chunk.length <= 80, "有一段超长（" + chunk.length + "）：" + chunk.slice(0, 40));
        }
      }
    } finally { restore(); }
  });

  await test("短文本不切；空文本返回空数组", () => {
    const { core, restore } = loadVoice({});
    try {
      assert.deepEqual(core.splitForSpeech("就一句。", { maxChars: 200 }), ["就一句。"]);
      assert.deepEqual(core.splitForSpeech("   ", { maxChars: 200 }), []);
      assert.deepEqual(core.splitForSpeech("", { maxChars: 200 }), []);
    } finally { restore(); }
  });

  console.log("== 语音：每个角色一个音色（用稳定标识） ==");

  await test("同一个标识每次得到同一个音色（确定性的）", () => {
    const { core, restore } = loadVoice({});
    try {
      const a = core.defaultSpeakerFor("Harry Potter (EN).png", SPEAKERS);
      const b = core.defaultSpeakerFor("Harry Potter (EN).png", SPEAKERS);
      assert.equal(a, b);
    } finally { restore(); }
  });

  await test("不同角色的默认音色尽量不一样（四个角色至少三种）", () => {
    const { core, restore } = loadVoice({});
    try {
      const names = ["harry.png", "tom.png", "ron.png", "hermione.png"];
      const set = new Set(names.map((name) => core.defaultSpeakerFor(name, SPEAKERS)));
      assert.ok(set.size >= 3, "太集中了：" + Array.from(set).join(","));
    } finally { restore(); }
  });

  await test("**用 avatar 而不是名字**：角色改名之后声音不变", () => {
    const { core, restore } = loadVoice({});
    try {
      const avatar = "Harry Potter (EN).png";
      const before = core.defaultSpeakerFor(avatar, SPEAKERS);
      // 名字变了（用户改了角色名），但 avatar（稳定标识）没变
      const after = core.defaultSpeakerFor(avatar, SPEAKERS);
      assert.equal(before, after, "改名把声音也换掉了");
      // 换一个 avatar 才应该可能换声音
      assert.equal(typeof core.defaultSpeakerFor("another.png", SPEAKERS), "string");
    } finally { restore(); }
  });

  await test("用户选过的音色优先；选了一个中转没有的 → 回退默认（不报错）", () => {
    const { core, restore } = loadVoice({});
    try {
      const settings = { voice_by_card: { "harry.png": { speaker: "zh_male_m191_uranus_bigtts", speechRate: 30 } } };
      const picked = core.voiceSettingFor(settings, "harry.png", SPEAKERS);
      assert.equal(picked.speaker, "zh_male_m191_uranus_bigtts");
      assert.equal(picked.speechRate, 30);
      const bad = core.voiceSettingFor({ voice_by_card: { "harry.png": { speaker: "不存在的音色" } } }, "harry.png", SPEAKERS);
      assert.equal(bad.speaker, core.defaultSpeakerFor("harry.png", SPEAKERS), "选了不存在的音色要回退默认");
    } finally { restore(); }
  });

  await test("语速夹在官方范围 [-50, 100] 内", () => {
    const { core, restore } = loadVoice({});
    try {
      assert.equal(core.clampSpeechRate(999), 100);
      assert.equal(core.clampSpeechRate(-999), -50);
      assert.equal(core.clampSpeechRate("x"), 0);
      assert.equal(core.clampSpeechRate(30.6), 31);
    } finally { restore(); }
  });

  console.log("== 语音：旧设置迁移（语速换算，音高不冒充） ==");

  await test("旧的 rate 按同一语义换算成 speech_rate（1.0 → 0，1.2 → 20，0.8 → -20）", () => {
    const { core, restore } = loadVoice({});
    try {
      const result = core.migrateVoiceSettings({
        "a.png": { rate: 1.2, pitch: 0.9 },
        "b.png": { rate: 0.8, pitch: 1.3 },
        "c.png": { rate: 1, pitch: 1 },
      }, SPEAKERS);
      assert.equal(result.migrated, 3);
      assert.equal(result.map["a.png"].speechRate, 20);
      assert.equal(result.map["b.png"].speechRate, -20);
      assert.equal(result.map["c.png"].speechRate, 0);
    } finally { restore(); }
  });

  await test("旧的音高**不冒充**云端参数：不在新设置里出现，但旧值留在 legacy 里不丢", () => {
    const { core, restore } = loadVoice({});
    try {
      const result = core.migrateVoiceSettings({ "a.png": { rate: 1.2, pitch: 0.9 } }, SPEAKERS);
      assert.equal(result.map["a.png"].pitch, undefined, "旧音高不该被塞进云端设置");
      assert.deepEqual(result.legacy["a.png"], { rate: 1.2, pitch: 0.9 }, "旧值要原样保留（用户的数据不删）");
    } finally { restore(); }
  });

  await test("迁移是幂等的：新形状再迁一次不会变样、也不会被当成旧值", () => {
    const { core, restore } = loadVoice({});
    try {
      const once = core.migrateVoiceSettings({ "a.png": { rate: 1.2, pitch: 0.9 } }, SPEAKERS);
      const twice = core.migrateVoiceSettings(once.map, SPEAKERS);
      assert.equal(twice.migrated, 0, "新形状不该再被判成旧值");
      assert.deepEqual(twice.map, once.map);
    } finally { restore(); }
  });

  await test("已经是新形状的设置原样保留（不会被迁移改坏）", () => {
    const { core, restore } = loadVoice({});
    try {
      const result = core.migrateVoiceSettings({ "a.png": { speaker: SPEAKERS[1].id, speechRate: -15 } }, SPEAKERS);
      assert.equal(result.migrated, 0);
      assert.equal(result.map["a.png"].speaker, SPEAKERS[1].id);
      assert.equal(result.map["a.png"].speechRate, -15);
    } finally { restore(); }
  });

  console.log("== 语音：缓存键要算全 ==");

  await test("文本 / 音色 / 语速 / 模型 / 资源 / 中转 —— 任何一项不同，键就不同", () => {
    const { cache, restore } = loadVoice({});
    try {
      const base = { text: "你好", speaker: "s1", speechRate: 0, format: "mp3", sampleRate: 24000, model: "m", resourceId: "r", relay: "https://a" };
      const key = cache.cacheKey(base);
      for (const field of Object.keys(base)) {
        const changed = Object.assign({}, base);
        changed[field] = String(base[field]) + "-x";
        assert.notEqual(cache.cacheKey(changed), key, "改了 " + field + " 之后缓存键没变 —— 会出现『换了音色还是旧声音』");
      }
      assert.equal(cache.cacheKey(base), key, "同样的输入必须得到同样的键");
      assert.equal(cache.cacheKey(Object.assign({}, base, { speechRate: 0 })), key, "0 和缺省要等价");
    } finally { restore(); }
  });

  await test("缓存：存进去能取出来，命中不会去合成", async () => {
    const { cache, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const store = memoryStore();
      const c = cache.createVoiceCache({ store, now: () => 1000 });
      const key = cache.cacheKey({ text: "你好", speaker: "s1" });
      assert.equal(await c.get(key), null, "空缓存不该有东西");
      await c.put(key, { base64: Buffer.from("MP3:你好").toString("base64"), type: "audio/mpeg", bytes: 10, chars: 2, speaker: "s1" });
      const hit = await c.get(key);
      assert.ok(hit && hit.base64, "没取回来：" + JSON.stringify(hit));
      const stats = await c.stats();
      assert.equal(stats.entries, 1);
      assert.ok(stats.hits >= 1);
    } finally { restore(); }
  });

  await test("缓存上限：超过条数就按「最久没用过」淘汰（LRU）", async () => {
    const { cache, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const store = memoryStore();
      let clock = 0;
      const c = cache.createVoiceCache({ store, limits: { entries: 3, bytes: 1e9 }, now: () => (clock += 1000) });
      const keys = [];
      for (let i = 0; i < 3; i += 1) {
        const key = cache.cacheKey({ text: "第" + i + "句" });
        keys.push(key);
        await c.put(key, { base64: "AAAA", bytes: 4 });
      }
      // 摸一下第 1 条，让"最久没用过"变成第 0 条
      await c.get(keys[0]);
      await c.put(cache.cacheKey({ text: "第四句" }), { base64: "BBBB", bytes: 4 });
      const stats = await c.stats();
      assert.equal(stats.entries, 3, "应当维持在 3 条：" + stats.entries);
      assert.equal(await c.get(keys[1]), null, "最久没用过的那条应当被淘汰");
      assert.ok(await c.get(keys[0]), "刚摸过的那条不该被淘汰");
      assert.ok(stats.evicted >= 1);
    } finally { restore(); }
  });

  await test("缓存上限：字节超了也要淘汰（不能只数条数）", async () => {
    const { cache, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const store = memoryStore();
      let clock = 0;
      const c = cache.createVoiceCache({ store, limits: { entries: 100, bytes: 10 }, now: () => (clock += 1000) });
      await c.put(cache.cacheKey({ text: "a" }), { base64: "AAAA", bytes: 6 });
      await c.put(cache.cacheKey({ text: "b" }), { base64: "BBBB", bytes: 6 });
      const stats = await c.stats();
      assert.ok(stats.bytes <= 10, "字节超了没淘汰：" + stats.bytes);
      assert.equal(stats.entries, 1, "应当只剩一条：" + stats.entries);
    } finally { restore(); }
  });

  await test("钉住（pinned）的语音不参与淘汰 —— 以后「角色发语音消息」要靠它留住", async () => {
    const { cache, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const store = memoryStore();
      let clock = 0;
      const c = cache.createVoiceCache({ store, limits: { entries: 2, bytes: 1e9 }, now: () => (clock += 1000) });
      const pinned = cache.cacheKey({ text: "语音消息" });
      await c.put(pinned, { base64: "AAAA", bytes: 4, pinned: true });
      for (let i = 0; i < 4; i += 1) await c.put(cache.cacheKey({ text: "别的" + i }), { base64: "BBBB", bytes: 4 });
      assert.ok(await c.get(pinned), "被钉住的语音被淘汰掉了（以后那条语音消息就听不了了）");
    } finally { restore(); }
  });

  console.log("== 语音：调度（顺序 / 缓存 / 取消 / 重试） ==");

  await test("多段按顺序合成并播放，且顺序与文本一致", async () => {
    const { core, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const synth = async (text) => ({ ok: true, blob: { text }, base64: "AA==", type: "audio/mpeg", bytes: 1, chars: text.length });
      const player = fakePlayer();
      const ctl = core.createController({ synth, player, keyFor: () => "" });
      const text = "第一句。第二句。第三句。第四句。第五句。第六句。第七句。";
      const result = await ctl.speak(text, { maxChars: 20 });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.chunks >= 2, "这么长应该切成多段：" + result.chunks);
      assert.equal(player.played.map((one) => one.text).join(""), text, "播放的顺序或内容与原文不一致");
    } finally { restore(); }
  });

  await test("缓存命中就不再去合成（重复播放不重复花钱）", async () => {
    const { core, cache, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      let requests = 0;
      const synth = async (text) => { requests += 1; return { ok: true, blob: { text }, base64: "AA==", type: "audio/mpeg", bytes: 1, chars: text.length }; };
      const store = memoryStore();
      const c = cache.createVoiceCache({ store });
      const keyFor = (chunk) => cache.cacheKey({ text: chunk, speaker: "s1" });
      const ctl = core.createController({ synth, cache: c, keyFor, player: fakePlayer() });
      const text = "同一句话。";
      await ctl.speak(text, { speaker: "s1" });
      const afterFirst = requests;
      assert.ok(afterFirst >= 1, "第一次应当真的去合成");
      const second = await ctl.speak(text, { speaker: "s1" });
      assert.equal(requests, afterFirst, "第二次重复播放又去合成了（白花钱）");
      assert.ok(second.fromCache >= 1, "第二次应当全部命中缓存：" + JSON.stringify(second));
    } finally { restore(); }
  });

  await test("取消：念到一半 stop() —— 后面的段不再合成、不再播", async () => {
    const { core, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const synthesized = [];
      let release = null;
      const player = fakePlayer({ hold: (done) => { release = done; } });
      const synth = async (text) => { synthesized.push(text); return { ok: true, blob: { text }, base64: "AA==", type: "audio/mpeg", bytes: 1, chars: text.length }; };
      const ctl = core.createController({ synth, player, keyFor: () => "" });
      const pending = ctl.speak("第一句。第二句。第三句。", { maxChars: 20 });
      for (let i = 0; i < 50 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, "前置条件不成立：第一段还没开始播");
      ctl.stop();
      if (release) release();
      const result = await pending;
      assert.equal(result.canceled, true, "取消应当如实回报 canceled：" + JSON.stringify(result));
      assert.equal(synthesized.length, 1, "取消之后不该继续合成：" + JSON.stringify(synthesized));
      assert.equal(ctl.isSpeaking(), false);
    } finally { restore(); }
  });

  await test("重试：可重试的错（超时）会自动再试一次，成功就继续", async () => {
    const { core, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      let attempts = 0;
      const synth = async (text) => {
        attempts += 1;
        if (attempts === 1) return { ok: false, code: "VOICE_TIMEOUT", reason: "合成超时了。", retryable: true };
        return { ok: true, blob: { text }, base64: "AA==", type: "audio/mpeg", bytes: 1, chars: text.length };
      };
      const player = fakePlayer();
      const ctl = core.createController({ synth, player, keyFor: () => "", retries: 1 });
      const result = await ctl.speak("一句话。", {});
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(attempts, 2, "应当自动重试一次：" + attempts);
    } finally { restore(); }
  });

  await test("重试：不可重试的错（额度/鉴权）**不**重试，并把原因原样带出来", async () => {
    const { core, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      let attempts = 0;
      const synth = async () => {
        attempts += 1;
        return { ok: false, code: "CARD_NO_VOICE", reason: "这张体验卡的语音次数用完了（文字聊天不受影响）。", retryable: false };
      };
      const ctl = core.createController({ synth, player: fakePlayer(), keyFor: () => "", retries: 3 });
      const result = await ctl.speak("一句话。", {});
      assert.equal(result.ok, false);
      assert.equal(attempts, 1, "额度用完重试多少次都一样，不该重试：" + attempts);
      assert.ok(/语音次数用完/.test(result.reason), "原因要原样带出来：" + result.reason);
    } finally { restore(); }
  });

  await test("新的朗读顶掉旧的（连点两次不该叠着念）", async () => {
    const { core, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      // 这个播放器要能"卡住不结束"，才能造出"第一句还在播、用户又点了第二句"的时序。
      // ⚠ 每一次 play 都要能单独放掉：只放第一次的话，第二次的 await 永远不会回来，
      // 而 Node 在事件循环空掉时会**静默退出**（这一条一开始就是这么假绿的）。
      const player = {
        played: [],
        pending: [],
        play(blob, run) {
          player.played.push(blob.text);
          return new Promise((resolve) => {
            player.pending.push(() => resolve({ ok: true }));
            if (run && run.signal) {
              run.signal.addEventListener("abort", () => resolve({ ok: true, canceled: true }), { once: true });
            }
          });
        },
        stop() { /* 由 signal 负责收尾 */ },
      };
      const synth = async (text) => ({ ok: true, blob: { text }, base64: "AA==", type: "audio/mpeg", bytes: 1, chars: text.length });
      const ctl = core.createController({ synth, player, keyFor: () => "" });

      const first = ctl.speak("第一句。", {});
      await waitFor(() => player.pending.length === 1);
      const second = ctl.speak("第二句。", {});
      await waitFor(() => player.pending.length === 2);
      player.pending[1]();
      const firstResult = await first;
      const secondResult = await second;
      assert.equal(firstResult.canceled, true, "被顶掉的那一次应当回报 canceled");
      assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
      assert.deepEqual(player.played, ["第一句。", "第二句。"], "播放顺序不对：" + JSON.stringify(player.played));
    } finally { restore(); }
  });

  await test("播放失败要如实报错，不能假装念完了", async () => {
    const { core, restore } = loadVoice({ Blob: globalThis.Blob });
    try {
      const synth = async (text) => ({ ok: true, blob: { text }, base64: "AA==", type: "audio/mpeg", bytes: 1, chars: text.length });
      const ctl = core.createController({ synth, player: fakePlayer({ failOn: 1 }), keyFor: () => "" });
      const result = await ctl.speak("一句话。", {});
      assert.equal(result.ok, false);
      assert.ok(/播不出来/.test(result.reason), "要说清是播不出来：" + result.reason);
      assert.equal(ctl.isSpeaking(), false, "失败了就不该还显示在念");
    } finally { restore(); }
  });

  console.log("== 语音：错误翻译（人话 + 值不值得重试） ==");

  await test("各种失败都能翻成人话，并且标清能不能重试", async () => {
    const env = loadVoice({ RoleWorld: fakeAdapter({ voice_enabled: true }), RoleWorldCard: fakeCard(true), fetch: fakeFetch() });
    try {
      const cases = [
        [402, { error: { code: "CARD_NO_VOICE", message: "这张体验卡的语音次数用完了。" } }, false],
        [503, { error: { code: "RELAY_NO_VOICE_KEY", message: "中转没配语音。" } }, false],
        [429, { error: { code: "VOICE_BUSY", message: "正忙。" } }, true],
        [504, { error: { code: "VOICE_TIMEOUT", message: "超时。" } }, true],
        [413, { error: { code: "VOICE_TEXT_TOO_LONG", message: "太长。" } }, false],
        [400, { error: { code: "VOICE_SPEAKER_UNKNOWN", message: "没有这个音色。" } }, false],
      ];
      for (const [status, body, retryable] of cases) {
        const info = env.cloud.describeError(status, body);
        assert.equal(info.retryable, retryable, status + " 的 retryable 判错了：" + JSON.stringify(info));
        assert.ok(info.reason && info.reason.length > 2, status + " 没有人话原因：" + JSON.stringify(info));
      }
      // 卡类错误走体验卡那套人话
      const cardInfo = env.cloud.describeError(402, { error: { code: "CARD_EXPIRED" } });
      assert.ok(/体验卡/.test(cardInfo.reason), "卡类错误应当走体验卡的话术：" + cardInfo.reason);
    } finally { env.restore(); }
  });

  await test("合成请求只发必要的东西：文本 + 音色 + 语速（不带任何密钥）", async () => {
    const fetchImpl = fakeFetch();
    const env = loadVoice({ RoleWorld: fakeAdapter({ voice_enabled: true }), RoleWorldCard: fakeCard(true), fetch: fetchImpl });
    try {
      const result = await env.cloud.synthesize("你好呀。", { speaker: SPEAKERS[1].id, speechRate: 20 });
      assert.equal(result.ok, true, JSON.stringify(result));
      const call = fetchImpl.calls[fetchImpl.calls.length - 1];
      assert.equal(call.url, "https://relay.example.com/v1/audio/speech");
      assert.deepEqual(Object.keys(call.body).sort(), ["speaker", "speech_rate", "text"], "请求体多了不该有的字段：" + JSON.stringify(call.body));
      assert.equal(call.body.text, "你好呀。");
      assert.equal(call.body.speaker, SPEAKERS[1].id);
      assert.equal(call.body.speech_rate, 20);
      // 鉴权用的是**卡号**（体验卡），不是火山密钥 —— 客户端根本不知道后者
      assert.equal(call.headers.Authorization, "Bearer RW-AAAAA-BBBBB-CCCCC");
      assert.ok(JSON.stringify(call.body).indexOf("VOLC") < 0);
    } finally { env.restore(); }
  });

  await test("合成失败时把中转的原话带出来（不吞成「失败了」）", async () => {
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(true),
      fetch: fakeFetch({ speechFail: { status: 402, body: { error: { code: "CARD_NO_VOICE", message: "这张体验卡的语音次数用完了（文字聊天不受影响）。" } } } }),
    });
    try {
      const result = await env.cloud.synthesize("你好。", { speaker: SPEAKERS[0].id });
      assert.equal(result.ok, false);
      assert.equal(result.code, "CARD_NO_VOICE");
      assert.ok(/语音次数用完/.test(result.reason), "要带原话：" + result.reason);
      assert.equal(result.retryable, false);
    } finally { env.restore(); }
  });

  await test("网络断了算可重试，并说清是发不出去", async () => {
    const env = loadVoice({
      RoleWorld: fakeAdapter({ voice_enabled: true }),
      RoleWorldCard: fakeCard(true),
      fetch: fakeFetch({ speechThrow: true }),
    });
    try {
      const result = await env.cloud.synthesize("你好。", {});
      assert.equal(result.ok, false);
      assert.equal(result.retryable, true);
      assert.ok(/发不出去/.test(result.reason), result.reason);
    } finally { env.restore(); }
  });

  console.log("== 语音：语音输入（本轮没动，别被误伤） ==");

  await test("语音输入能力探测与识别仍然可用（清理系统朗读时不许误伤录音与转写）", async () => {
    const plain = loadVoice({});
    try {
      assert.equal(plain.core.hasSpeechRecognition(), false);
      const denied = await plain.core.listen({});
      assert.equal(denied.ok, false);
      assert.ok(denied.reason && denied.reason.length > 6, "要给出原因");
      assert.equal(typeof plain.core.startRecording, "function", "录音能力不该被删掉");
      assert.equal(typeof plain.core.transcribeBlob, "function", "转写能力不该被删掉");
    } finally { plain.restore(); }

    class FakeRecognition {
      constructor() { this.lang = ""; }
      start() {
        setTimeout(() => {
          this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "今天天气不错" }], { isFinal: true })] });
          this.onend();
        }, 0);
      }
      abort() { this.onend(); }
    }
    const withAsr = loadVoice({ SpeechRecognition: FakeRecognition });
    try {
      assert.equal(withAsr.core.hasSpeechRecognition(), true);
      const result = await withAsr.core.listen({ lang: "zh-CN" });
      assert.equal(result.ok, true);
      assert.equal(result.text, "今天天气不错");
    } finally { withAsr.restore(); }
  });

  await test("转写仍是 OpenAI 兼容形状（地址拼接、状态码带出来）", async () => {
    const env = loadVoice({
      FormData: class { append() {} },
      fetch: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
    });
    try {
      const result = await env.core.transcribeBlob({ type: "audio/webm" }, { endpoint: "https://api.example.com/v1", apiKey: "bad" });
      assert.equal(result.ok, false);
      assert.ok(/401/.test(result.reason), "要带状态码：" + result.reason);
    } finally { env.restore(); }
  });

  console.log("");
  const passed = results.filter((r) => r.ok).length;
  console.log(`VOICE_UNIT=${passed}/${results.length}`);
  if (failures) {
    console.log(`（失败 ${failures} 项）`);
    process.exit(1);
  }
})();

/** 内存版的缓存后端（形状和 RoleWorldStore 的 voice 存储一致）。 */
function memoryStore() {
  const rows = new Map();
  return {
    async get(id) { return rows.get(id) || null; },
    async put(record) { rows.set(record.id, record); return record; },
    async remove(id) { rows.delete(id); },
    async list() { return Array.from(rows.values()); },
    async clear() { rows.clear(); },
  };
}

/** 等一个条件成立（有上限，不会把测试挂死）。 */
async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}
