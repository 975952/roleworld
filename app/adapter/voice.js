"use strict";

/*
 * adapter/voice.js —— 云端语音的**接线层**（凭据 / 能力探测 / 合成 / 播放链路）
 *
 * 为什么单独一层：
 *   · `voice-core.js` 是纯逻辑（怎么切分、怎么调度），它不该知道"卡在哪、中转地址是什么"；
 *   · `integration.js` 是界面，它不该知道 HTTP 状态码怎么翻译。
 * 这一层把两件事接起来，并且**只做一件事**：把"这一台设备现在能不能让角色出声"
 * 变成一个可以在菜单打开那一瞬间同步读到的快照。
 *
 * 能力是怎么判定的（用户明确要求：不再依赖 speechSynthesis 或安卓原生桥）：
 *   ① 设置里打开了「角色语音」；
 *   ② 本机在用一张**体验卡**（云端的凭据就是卡号，用户不需要各自配火山密钥）；
 *   ③ 中转回 /voice/info 说 enabled=true（服务端配了火山凭据）。
 *   三条都满足才 canSpeak —— 少一条就老实说明是哪一条，而不是摆一个点了没反应的按钮。
 *
 * 凭据边界（写死在这里，不靠自觉）：
 *   · 客户端**只**发：卡号（Authorization 头）、要念的那句话、音色、语速；
 *   · 火山凭据在中转服务端，客户端从头到尾不知道它长什么样；
 *   · 卡号沿用体验卡那一份（secrets），不进导出存档。
 */

(function (global) {
  const DEFAULT_MAX_CHARS = 220;   // 客户端分段上限（中转还有一道 400 字的上限兜底）
  const INFO_TIMEOUT_MS = 8000;

  /* ------------------------------------------------------------------ *
   * 快照：能力探测的结果。菜单要在"点开的那一瞬间"同步读到它，
   * 所以探测是异步做的、结果是同步读的（和之前"现算菜单"的教训一致）。
   * ------------------------------------------------------------------ */

  const snapshot = {
    checked: false,
    checkedAt: 0,
    relay: "",
    enabled: false,          // 中转配了火山凭据吗
    reason: "",
    speakers: [],
    defaultSpeaker: "",
    maxChars: DEFAULT_MAX_CHARS,
    format: "mp3",
    model: "",
    resourceId: "seed-tts-2.0",
    voiceLeft: null,
    voiceCharsLeft: null,
  };

  let controller = null;
  let cache = null;
  let refreshing = null;
  let lastError = "";

  function settingsOf() {
    const adapter = global.RoleWorld;
    return adapter && typeof adapter.getLocalSettings === "function"
      ? adapter.getLocalSettings()
      : Promise.resolve({});
  }

  /** 本机现在用的是哪张卡、哪个中转（没有卡就返回 null —— 语音只走卡）。 */
  async function credentials() {
    const card = global.RoleWorldCard;
    if (!card || typeof card.currentState !== "function") return null;
    try {
      const state = await card.currentState();
      if (!state || !state.active || !state.token) return null;
      const settings = await settingsOf();
      const relay = String(state.relay || (settings && settings.card_relay) || "").replace(/\/+$/, "");
      if (!relay) return null;
      return { relay, token: state.token };
    } catch (_) {
      return null;
    }
  }

  /** 现在这台设备能不能让角色出声（**同步**，读的是最近一次探测的快照）。 */
  function capability() {
    const base = {
      speakers: snapshot.speakers.slice(),
      defaultSpeaker: snapshot.defaultSpeaker,
      maxChars: snapshot.maxChars || DEFAULT_MAX_CHARS,
      relay: snapshot.relay,
      enabled: snapshot.enabled,
      voiceLeft: snapshot.voiceLeft,
      voiceCharsLeft: snapshot.voiceCharsLeft,
      checked: snapshot.checked,
    };
    if (!voiceEnabled()) {
      return Object.assign(base, {
        canSpeak: false,
        reason: "「角色语音」还没打开（设置 → 语音 → 角色语音）。打开后角色说的话会经体验卡中转发给火山引擎合成。",
      });
    }
    if (!snapshot.checked) {
      return Object.assign(base, { canSpeak: false, reason: "还在确认这个中转有没有语音能力…" });
    }
    if (!snapshot.relay) {
      return Object.assign(base, {
        canSpeak: false,
        reason: "云端语音要用体验卡（卡号就是凭据，你不用自己配火山密钥）。现在这台设备没有在用体验卡。",
      });
    }
    if (!snapshot.enabled) {
      return Object.assign(base, {
        canSpeak: false,
        reason: snapshot.reason || "这个中转还没配语音（服务端的火山凭据没设置）。文字聊天不受影响。",
      });
    }
    return Object.assign(base, { canSpeak: true, reason: "" });
  }

  function voiceEnabled() {
    const settings = (global.__rwVoiceSettingsSnapshot || null);
    // 快照由 integration/settings 侧在启动与改设置时同步过来 —— 读设置是异步的，
    // 而菜单项要在点击那一瞬间定下来，所以留一个同步的小镜子。
    return !!(settings && settings.voice_enabled === true);
  }

  /** 设置界面改完开关后调一次，让同步镜像跟上（避免"改了设置菜单还是旧的"）。 */
  function noteSettings(settings) {
    global.__rwVoiceSettingsSnapshot = settings || null;
    return capability();
  }

  /**
   * 只在"该问的时候"问一次：没探测过、或者中转地址变了（用户刚粘了卡 / 换了一张卡）。
   *
   * 为什么不无脑 refresh：`roleworld:card-changed` 每一轮聊天都会发（中转每轮都回额度响应头），
   * 挂在上面的东西如果每次都真发请求，就是每轮多一个白跑的 GET。而"地址没变"时结果必然一样。
   */
  async function ensureFresh(options) {
    const cred = await credentials();
    if (!cred) {
      if (snapshot.relay) {
        // 卡被拿掉了：把能力清掉，免得界面还留着一个点了没反应的喇叭。
        Object.assign(snapshot, {
          checked: true, relay: "", enabled: false, speakers: [], defaultSpeaker: "",
          reason: "没有在用体验卡，云端语音用不了。",
        });
        broadcast();
      }
      return capability();
    }
    if (snapshot.checked && snapshot.relay === cred.relay) return capability();
    return refresh(Object.assign({ force: true }, options || {}));
  }

  /* ------------------------------------------------------------------ *
   * 探测：去中转问一次有哪些音色、一次能合多长
   * ------------------------------------------------------------------ */

  async function refresh(options) {
    const opts = options || {};
    if (refreshing && !opts.force) return refreshing;
    refreshing = (async () => {
      const cred = await credentials();
      Object.assign(snapshot, {
        checked: true, checkedAt: Date.now(), relay: cred ? cred.relay : "",
        enabled: false, reason: "", speakers: [], defaultSpeaker: "",
        voiceLeft: null, voiceCharsLeft: null,
      });
      if (!cred) {
        snapshot.reason = "没有在用体验卡，云端语音用不了。";
        broadcast();
        return capability();
      }
      const controller_ = new AbortController();
      const timer = global.setTimeout(() => controller_.abort(), opts.timeoutMs || INFO_TIMEOUT_MS);
      try {
        const res = await global.fetch(cred.relay + "/voice/info", {
          headers: { Authorization: "Bearer " + cred.token },
          signal: controller_.signal,
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const info = describeError(res.status, data);
          Object.assign(snapshot, { enabled: false, reason: info.reason });
          lastError = info.code || "";
        } else {
          Object.assign(snapshot, {
            enabled: data.enabled === true,
            reason: data.enabled === true ? "" : (data.reason || "这个中转还没配语音。"),
            speakers: Array.isArray(data.speakers) ? data.speakers : [],
            defaultSpeaker: String(data.defaultSpeaker || ""),
            maxChars: Number(data.maxChars) || DEFAULT_MAX_CHARS,
            format: String(data.format || "mp3"),
            model: String(data.model || ""),
            resourceId: String(data.resourceId || snapshot.resourceId),
            voiceLeft: data.voiceLeft === undefined ? null : data.voiceLeft,
            voiceCharsLeft: data.voiceCharsLeft === undefined ? null : data.voiceCharsLeft,
          });
          lastError = "";
        }
      } catch (error) {
        const aborted = error && error.name === "AbortError";
        Object.assign(snapshot, {
          enabled: false,
          reason: aborted ? "问中转「有没有语音」超时了 —— 网络或中转没回应。" : ("连不上中转：" + (error && error.message || error)),
        });
      } finally {
        global.clearTimeout(timer);
      }
      broadcast();
      return capability();
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  function broadcast() {
    try {
      global.dispatchEvent(new global.CustomEvent("roleworld:voice-changed", { detail: capability() }));
    } catch (_) { /* 没有 window 就算了 */ }
  }

  /* ------------------------------------------------------------------ *
   * 错误翻译：把中转/网络的状态码变成"人话 + 值不值得重试"
   * ------------------------------------------------------------------ */

  function describeError(status, body) {
    const code = (body && body.error && body.error.code) || "";
    const message = (body && body.error && body.error.message) || "";
    const card = global.RoleWorldCard;
    if (code === "CARD_NO_VOICE" || code === "CARD_NO_VOICE_CHARS") {
      return { code, reason: message || "这张体验卡的语音额度用完了（文字聊天不受影响）。", retryable: false };
    }
    if (String(code).indexOf("CARD_") === 0 && card && typeof card.describeCardError === "function") {
      return { code, reason: card.describeCardError(status, body) || message || "体验卡不可用。", retryable: false };
    }
    const table = {
      VOICE_TEXT_TOO_LONG: { reason: message || "这一段太长了，应该由客户端切分后再发。", retryable: false },
      VOICE_SPEAKER_UNKNOWN: { reason: message || "这个中转没有开放这个音色，去「设置 → 语音」换一个。", retryable: false },
      VOICE_EMPTY_TEXT: { reason: message || "这条消息没有可朗读的内容。", retryable: false },
      VOICE_BUSY: { reason: message || "语音合成正忙，稍等一下。", retryable: true },
      VOICE_TIMEOUT: { reason: message || "合成超时了（网络慢或中转忙）。", retryable: true },
      RELAY_NO_VOICE_KEY: { reason: message || "这个中转还没配火山语音凭据，语音暂时用不了。", retryable: false },
      UPSTREAM_UNREACHABLE: { reason: message || "连不上语音上游。", retryable: true },
      UPSTREAM_STREAM_ERROR: { reason: message || "读取音频流中断了。", retryable: true },
      UPSTREAM_EMPTY: { reason: message || "上游没有返回音频。", retryable: true },
    };
    if (table[code]) return Object.assign({ code }, table[code]);
    if (status === 401) return { code: code || "CARD_UNKNOWN", reason: message || "中转不认这张体验卡。", retryable: false };
    if (status === 402) return { code: code || "CARD_LIMIT", reason: message || "这张体验卡的额度不够了。", retryable: false };
    if (status === 413) return { code: "VOICE_TEXT_TOO_LONG", reason: message || "这一段太长了。", retryable: false };
    if (status === 429) return { code: "VOICE_BUSY", reason: message || "语音合成正忙，稍等一下。", retryable: true };
    if (status === 503) return { code: "RELAY_NO_VOICE_KEY", reason: message || "这个中转还没配语音。", retryable: false };
    if (status >= 500) return { code: code || "VOICE_UPSTREAM", reason: message || ("语音服务出错了（HTTP " + status + "）。"), retryable: true };
    return { code: code || ("HTTP_" + status), reason: message || ("语音请求失败（HTTP " + status + "）。"), retryable: false };
  }

  /* ------------------------------------------------------------------ *
   * 合成：一段文字 → 一个 Blob
   * ------------------------------------------------------------------ */

  function base64ToBlob(base64, type) {
    const cacheLib = global.RoleWorldVoiceCache;
    if (cacheLib && typeof cacheLib.base64ToBlob === "function") return cacheLib.base64ToBlob(base64, type);
    return null;
  }

  async function synthesize(text, options) {
    const opts = options || {};
    const cred = opts.credentials || await credentials();
    if (!cred) {
      return { ok: false, code: "NO_CARD", retryable: false, reason: "云端语音要用体验卡（卡号就是凭据）。" };
    }
    const body = { text: String(text || "") };
    if (opts.speaker) body.speaker = opts.speaker;
    if (opts.speechRate !== undefined && opts.speechRate !== null) body.speech_rate = Number(opts.speechRate) || 0;
    if (opts.format) body.format = opts.format;
    let res;
    try {
      res = await global.fetch(cred.relay + "/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cred.token },
        body: JSON.stringify(body),
        signal: opts.signal,
        cache: "no-store",
      });
    } catch (error) {
      const aborted = error && error.name === "AbortError";
      if (aborted) return { ok: false, code: "VOICE_CANCELED", canceled: true, retryable: false, reason: "" };
      return { ok: false, code: "NETWORK", retryable: true, reason: "语音请求发不出去：" + (error && error.message ? error.message : String(error)) };
    }
    noteQuotaFromHeaders(res.headers);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const info = describeError(res.status, data);
      return { ok: false, code: info.code, retryable: info.retryable, reason: info.reason, status: res.status };
    }
    const type = res.headers.get("content-type") || "audio/mpeg";
    let buffer;
    try {
      buffer = await res.arrayBuffer();
    } catch (error) {
      return { ok: false, code: "NETWORK", retryable: true, reason: "音频没读全：" + (error && error.message ? error.message : String(error)) };
    }
    const bytes = new Uint8Array(buffer);
    const blob = new global.Blob([bytes], { type });
    const base64 = await (global.RoleWorldVoiceCache.blobToBase64(blob));
    return {
      ok: true,
      blob, base64, type,
      bytes: bytes.length,
      chars: Number(res.headers.get("x-rw-voice-chars")) || String(text || "").length,
      speaker: res.headers.get("x-rw-voice-speaker") || opts.speaker || "",
    };
  }

  /** 中转每一路都会回语音剩余额度，顺手更新快照（不额外发请求）。 */
  function noteQuotaFromHeaders(headers) {
    if (!headers || typeof headers.get !== "function") return null;
    const left = headers.get("x-rw-voice-left");
    const chars = headers.get("x-rw-voice-chars-left");
    if (left === null && chars === null) return null;
    const num = (raw) => {
      if (raw === null || raw === undefined || raw === "unlimited") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    snapshot.voiceLeft = num(left);
    snapshot.voiceCharsLeft = num(chars);
    broadcast();
    return { voiceLeft: snapshot.voiceLeft, voiceCharsLeft: snapshot.voiceCharsLeft };
  }

  /* ------------------------------------------------------------------ *
   * 缓存键：文本 + 音色 + 影响声音的参数 + 模型/资源 + 中转
   * ------------------------------------------------------------------ */

  function keyFor(chunk, meta) {
    const lib = global.RoleWorldVoiceCache;
    if (!lib || typeof lib.cacheKey !== "function") return "";
    return lib.cacheKey({
      text: chunk,
      speaker: (meta && meta.speaker) || "",
      speechRate: (meta && meta.speechRate) || 0,
      format: snapshot.format || "mp3",
      sampleRate: 24000,
      model: snapshot.model || "",
      resourceId: snapshot.resourceId || "seed-tts-2.0",
      relay: snapshot.relay || "",
    });
  }

  /* ------------------------------------------------------------------ *
   * 播放入口（integration.js 只调这几个）
   * ------------------------------------------------------------------ */

  function ensureController() {
    if (controller) return controller;
    const lib = global.RoleWorldVoice;
    if (!lib || typeof lib.createController !== "function") return null;
    const cacheLib = global.RoleWorldVoiceCache;
    if (!cache && cacheLib) cache = cacheLib.createVoiceCache({});
    controller = lib.createController({
      synth: synthesize,
      cache,
      keyFor,
      player: lib.createPlayer(),
      onState: (state) => {
        try {
          global.dispatchEvent(new global.CustomEvent("roleworld:voice-state", { detail: state }));
        } catch (_) { /* 没有 window 就算了 */ }
      },
    });
    return controller;
  }

  /** 念一段（内部会自动切分、查缓存、顺序播、可重试）。 */
  function speak(text, options) {
    const ctl = ensureController();
    if (!ctl) return Promise.resolve({ ok: false, reason: "语音模块没加载。" });
    // 朗读和"播某条语音消息"共用一副耳朵：开始念新的，就把正在放的语音气泡停掉，
    // 否则两个声音会叠在一起（用户根本听不清哪句是哪个）。
    stopMessagePlayback();
    return ctl.speak(text, options);
  }

  /* ------------------------------------------------------------------ *
   * 播放**某一条语音消息**（微信式气泡点一下播）
   *
   * 跟"朗读一段文字"是两件事：
   *   · 朗读：给定文字，按**现在**的音色设置合成；
   *   · 播语音消息：给定一个**已经合成好**的音频（缓存键 + 当时的音色）。
   * 后者必须播原来那一条的声音 —— 用户后来把音色换了，旧语音也不该变声；
   * 所以这里先按 `key` 从缓存取，取不到才用**当时的**音色重合成一次并回填缓存。
   * 正常情况下点旧语音不会花钱（缓存里那份被 pin 住过）。
   * ------------------------------------------------------------------ */

  let messagePlayer = null;
  let messageAbort = null;
  // 「这一条语音」的代次。连点两条时旧的那条要**整条作废** —— 包括它可能还在
  // 合成途中（缓存里没有、正在重新合成），否则几秒后它会突然响起来盖住新的那条。
  let messageToken = 0;

  function stopMessagePlayback() {
    messageToken += 1;             // 代次一加，所有在途的旧请求都不再作数
    if (messageAbort) {
      try { messageAbort.abort(); } catch (_) { /* 已经停了 */ }
      messageAbort = null;
    }
    if (messagePlayer) {
      try { messagePlayer.stop(); } catch (_) { /* 没在放 */ }
    }
  }

  async function playMessage(voice, options) {
    const opts = options || {};
    const src = voice || {};
    const key = String(src.key || "");
    if (!key) return { ok: false, code: "NO_KEY", reason: "这条语音没有可播放的音频。" };
    const lib = global.RoleWorldVoice;
    if (!cache && global.RoleWorldVoiceCache) cache = global.RoleWorldVoiceCache.createVoiceCache({});
    const token = ++messageToken;
    const abort = new global.AbortController();
    messageAbort = abort;
    try {
      if (controller) controller.stop();      // 正在朗读的那句先停（一副耳朵）
      if (messagePlayer) messagePlayer.stop();
      if (!messagePlayer && lib && typeof lib.createPlayer === "function") messagePlayer = lib.createPlayer();
      if (!messagePlayer) return { ok: false, code: "NO_PLAYER", reason: "这个运行环境放不出音频。" };
      let blob = null;
      try { blob = cache ? await cache.getBlob(key) : null; } catch (_) { blob = null; }
      let fromCache = !!blob;
      if (!blob) {
        // 缓存里没有（清过缓存 / 换过设备）：按**这条语音当时**的音色重合成一次，
        // 并用同一个 key 回填缓存 —— 下次点它就不用再花钱了。
        const result = await synthesize(src.text, {
          speaker: src.speaker || "", speechRate: src.speechRate || 0, signal: abort.signal,
        });
        if (!result.ok) return result;
        if (token !== messageToken) return { ok: true, canceled: true };
        blob = result.blob;
        fromCache = false;
        if (cache) {
          try {
            await cache.put(key, {
              base64: result.base64, type: result.type, bytes: result.bytes,
              chars: result.chars, speaker: src.speaker || "", speechRate: src.speechRate || 0, pinned: true,
            });
          } catch (_) { /* 回填失败不影响这次播放 */ }
        }
      }
      if (token !== messageToken) return { ok: true, canceled: true };
      const played = await messagePlayer.play(blob, { signal: abort.signal });
      return Object.assign({ fromCache }, played);
    } finally {
      if (messageAbort === abort) messageAbort = null;
    }
  }

  /** 某条语音现在是不是正在放（气泡上要显示"播放中"，再点一下就是停）。 */
  function isPlayingMessage() {
    return !!(messagePlayer && typeof messagePlayer.isPlaying === "function" && messagePlayer.isPlaying());
  }

  /**
   * **只合成、不播放** —— 给"角色发语音消息"那条路留的出口（策略以后再设计）。
   *
   * 为什么现在就留：那条路的政策（什么时候发语音、发多长、花谁的钱）还没定，
   * 但它需要的底层能力是现成的 —— 按音色合成、走同一份缓存（所以同一条语音消息
   * 重放不会再花钱）、拿到一个能播也能存下来的音频。以后接的时候不用改这一层。
   *
   * 返回 { ok, blob, base64, type, bytes, chars, cached } 或 { ok:false, reason }。
   */
  async function synthesizeToCache(text, options) {
    const opts = options || {};
    const lib = global.RoleWorldVoice;
    const cacheLib = global.RoleWorldVoiceCache;
    if (!cache && cacheLib) cache = cacheLib.createVoiceCache({});
    const chunks = lib.splitForSpeech(text, { maxChars: opts.maxChars || snapshot.maxChars || DEFAULT_MAX_CHARS });
    if (!chunks.length) return { ok: false, reason: "没有可合成的内容。" };
    // 同一条口径（`app/voice-core.js` 的 hasSpeakableContent）：只有标点/表情的文本
    // 不该被送去合成 —— 上游会回"合成结束"但零字节音频，用户拿到一句查不下去的话
    // （2026-09-18 实测：角色 Alaric Vane 的一条「……」）。
    if (typeof lib.hasSpeakableContent === "function" && !lib.hasSpeakableContent(text)) {
      return { ok: false, code: "VOICE_EMPTY_TEXT", reason: "这段没有能念出来的内容（只有标点或表情）。" };
    }
    const speaker = opts.speaker || snapshot.defaultSpeaker || "";
    const speechRate = lib.clampSpeechRate(opts.speechRate);
    const clips = [];
    let cached = 0;
    for (const chunk of chunks) {
      const key = keyFor(chunk, { speaker, speechRate });
      let record = null;
      if (cache && key) { try { record = await cache.get(key); } catch (_) { record = null; } }
      const blob = record && cacheLib ? cacheLib.base64ToBlob(record.base64, record.type) : null;
      if (blob) {
        cached += 1;
        // 本来就在缓存里、而这次要的是"钉住"（语音消息）：补一次 put 把它标成 pinned，
        // 免得它哪天被 LRU 挤掉 —— 那会让用户点旧语音时又要重新花钱合成一遍。
        if (opts.pinned === true && record.pinned !== true && cache) {
          try {
            await cache.put(key, {
              base64: record.base64, type: record.type, bytes: record.bytes,
              chars: record.chars, speaker, speechRate, pinned: true,
            });
          } catch (_) { /* 钉不上只是有被淘汰的风险，不影响这次 */ }
        }
        clips.push({ blob, key, chars: chunk.length });
        continue;
      }
      const result = await synthesize(chunk, { speaker, speechRate, signal: opts.signal });
      if (!result.ok) return result;
      if (cache && key) {
        try {
          await cache.put(key, {
            base64: result.base64, type: result.type, bytes: result.bytes,
            chars: result.chars, speaker, speechRate,
            // pinned：被消息引用的语音**不参与淘汰** —— 过几天再点还得能听，
            // 不能因为缓存满了就重新花钱合成一遍。只有语音消息那条路会传它。
            pinned: opts.pinned === true,
          });
        } catch (_) { /* 缓存写不进去不影响这次结果 */ }
      }
      clips.push({ blob: result.blob, key, chars: result.chars });
    }
    return {
      ok: true, clips, chunks: chunks.length, cached,
      blob: clips.length === 1 ? clips[0].blob : null,
      chars: clips.reduce((sum, one) => sum + (one.chars || 0), 0),
    };
  }

  function stop() {
    if (controller) controller.stop();
    stopMessagePlayback();
  }

  function isSpeaking() {
    return !!((controller && controller.isSpeaking()) || isPlayingMessage());
  }

  function state() {
    return controller ? controller.state() : { phase: "idle", index: 0, total: 0 };
  }

  /** 缓存统计（设置页显示"已缓存多少"）。 */
  async function cacheStats() {
    const cacheLib = global.RoleWorldVoiceCache;
    if (!cache && cacheLib) cache = cacheLib.createVoiceCache({});
    if (!cache) return { entries: 0, bytes: 0 };
    return cache.stats();
  }

  async function clearCache() {
    const cacheLib = global.RoleWorldVoiceCache;
    if (!cache && cacheLib) cache = cacheLib.createVoiceCache({});
    if (!cache) return false;
    stop();
    return cache.clear();
  }

  /* ------------------------------------------------------------------ *
   * 旧设置迁移：旧版的语速/音高是本机系统 TTS 的参数，不是云端音色参数
   * ------------------------------------------------------------------ */

  /**
   * 把 `voice_by_card` 从旧形状迁到新形状（幂等）。
   *   · 语速：同一个概念 → 换算成官方 speech_rate；
   *   · 音高：云端接口没有这一项，**不冒充**，旧值原样留在 `voice_by_card_legacy`；
   *   · 返回 { changed, migrated }，调用方只在 changed 时写盘。
   */
  async function ensureMigrated() {
    const adapter = global.RoleWorld;
    if (!adapter) return { changed: false, migrated: 0 };
    const lib = global.RoleWorldVoice;
    const settings = await settingsOf();
    if (!settings || !settings.voice_by_card) return { changed: false, migrated: 0 };
    const result = lib.migrateVoiceSettings(settings.voice_by_card, snapshot.speakers);
    if (!result.migrated) return { changed: false, migrated: 0 };
    const patch = { voice_by_card: result.map };
    // 旧值留着（用户的数据不删），但改个名字，免得被当成"云端音色设置"再读一遍。
    const legacy = Object.assign({}, settings.voice_by_card_legacy || {}, result.legacy);
    patch.voice_by_card_legacy = legacy;
    await adapter.saveLocalSettings(patch);
    return { changed: true, migrated: result.migrated };
  }

  /** 某个角色现在用哪个音色（含默认）。 */
  function settingFor(identity, settings) {
    const lib = global.RoleWorldVoice;
    const source = settings || global.__rwVoiceSettingsSnapshot || {};
    return lib.voiceSettingFor(source, identity, snapshot.speakers);
  }

  const api = {
    capability,
    refresh,
    ensureFresh,
    noteSettings,
    credentials,
    synthesize,
    synthesizeToCache,
    keyFor,
    speak,
    playMessage,
    stopMessagePlayback,
    isPlayingMessage,
    stop,
    isSpeaking,
    state,
    settingFor,
    ensureMigrated,
    describeError,
    noteQuotaFromHeaders,
    cacheStats,
    clearCache,
    base64ToBlob,
    snapshot: () => Object.assign({}, snapshot),
    DEFAULT_MAX_CHARS,
    lastError: () => lastError,
  };

  global.RoleWorldVoiceCloud = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
