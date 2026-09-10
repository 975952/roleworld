"use strict";

/*
 * 魔法地图 · 剧情模式（2026-09-09）
 *
 * 一个全新的产品形态：把多个角色请到同一个地点，让模型依次以各自角色卡的
 * 人格同场对话，关键时刻用 d20「命运骰子」推动剧情。
 *
 * 边界（只读 + 客户端）：
 *   - 只调用 STApi 的读取端点（/api/users/me、characters/all、characters/get、
 *     worldinfo/list|get、settings/get）与 /api/backends/chat-completions/generate。
 *   - 绝不调用 chats/save、worldinfo/edit、characters/create|delete|import 等写端点。
 *   - 场景记录只保存在本机 localStorage（按账号），可导出为剧本，可清空。
 */
(function () {
  var STATE_PREFIX = "task29.magic-map.v1.";
  var HANDLE_KEY = "task27a.current-account-handle.v1";
  var MAX_HISTORY = 16;
  var DICE_SIDES = 20;
  var DICE_CHANCE = 0.34;

  /* 2026-09-10 重做：不再绑定任何世界观。场景 = 用户自由书写的一句话，
   * 下面是中性的「试演场景」预设，任何角色卡都能用。 */
  var LOCATIONS = [
    { id: "first-meet", name: "初次相遇", glyph: "✦", hint: "两个人第一次碰面，彼此都在打量对方。" },
    { id: "late-night", name: "深夜长谈", glyph: "☾", hint: "夜深了，话说得比白天更坦白。" },
    { id: "journey", name: "旅途途中", glyph: "➤", hint: "在路上，风景、疲惫和沉默都在。" },
    { id: "rain", name: "雨夜屋檐", glyph: "☂", hint: "一场雨把两个人困在同一处屋檐下。" },
    { id: "feast", name: "节庆之夜", glyph: "✧", hint: "灯火与喧闹，以及被挤到角落的两个人。" },
    { id: "tension", name: "紧张对峙", glyph: "⚔", hint: "话说到一半，空气已经绷紧了。" },
    { id: "quiet", name: "安静的午后", glyph: "❋", hint: "没什么大事发生，正好说点小事。" },
    { id: "danger", name: "突发的危险", glyph: "✹", hint: "来不及商量，只能先动手。" },
  ];

  var DICE_TIERS = [
    { max: 1, label: "大失败", tone: "局面急转直下" },
    { max: 6, label: "失败", tone: "事情没能如愿" },
    { max: 11, label: "勉强", tone: "付出一点代价才过关" },
    { max: 17, label: "成功", tone: "顺利推进" },
    { max: 19, label: "大成功", tone: "意外地漂亮" },
    { max: 20, label: "暴击", tone: "连旁观者都愣住" },
  ];

  var els = {};
  var state = {
    scene: "",
    presetId: "",
    cast: [],
    goal: "",
    dice: true,
    userInScene: true,
    lines: [],
    round: 0,
  };
  var runtime = {
    handle: "",
    userName: "我",
    characters: [],
    cardCache: new Map(),
    books: [],
    harryAvatar: "",
    settings: {},
    controller: null,
    running: false,
    forcedDice: null,
    modelMode: "local",
    modelName: "",
  };

  function $(id) { return document.getElementById(id); }
  function storage(kind) { try { return window[kind] || null; } catch (_) { return null; } }
  function nowIso() { return new Date().toISOString(); }

  function setStatus(text, isError) {
    if (!els.status) return;
    els.status.textContent = text || "";
    els.status.classList.toggle("is-error", !!isError);
  }

  function locationById(id) {
    for (var i = 0; i < LOCATIONS.length; i += 1) if (LOCATIONS[i].id === id) return LOCATIONS[i];
    return null;
  }

  function characterByAvatar(avatar) {
    for (var i = 0; i < runtime.characters.length; i += 1) {
      if (runtime.characters[i].avatar === avatar) return runtime.characters[i];
    }
    return null;
  }

  function characterName(avatar) {
    var found = characterByAvatar(avatar);
    return (found && (found.name || found.avatar)) || avatar || "角色";
  }

  function avatarUrl(avatar) {
    // 本地版：角色头像存在本机数据库里，listCharacters() 已经预加载成 blob URL。
    if (window.STApi && typeof window.STApi.assetUrlSync === "function") {
      const local = window.STApi.assetUrlSync(avatar);
      if (local) return local;
    }
    return "/characters/" + encodeURIComponent(avatar || "");
  }

  /* ---------- 持久化（仅本机，按账号） ---------- */
  function saveScene() {
    var store = storage("localStorage");
    if (!store || !runtime.handle) return;
    try {
      store.setItem(STATE_PREFIX + runtime.handle, JSON.stringify({
        scene: state.scene,
        presetId: state.presetId,
        cast: state.cast,
        goal: state.goal,
        dice: state.dice,
        userInScene: state.userInScene !== false,
        lines: state.lines,
        round: state.round,
        at: nowIso(),
      }));
    } catch (_) { /* 存储不可用时不影响使用 */ }
  }

  function loadScene() {
    var store = storage("localStorage");
    if (!store || !runtime.handle) return false;
    try {
      var raw = store.getItem(STATE_PREFIX + runtime.handle);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.lines)) return false;
      state.scene = typeof parsed.scene === "string" ? parsed.scene : "";
      state.presetId = typeof parsed.presetId === "string" ? parsed.presetId : "";
      state.cast = Array.isArray(parsed.cast) ? parsed.cast.filter((a) => typeof a === "string") : [];
      state.goal = typeof parsed.goal === "string" ? parsed.goal : "";
      state.dice = parsed.dice !== false;
      state.userInScene = parsed.userInScene !== false;
      state.lines = parsed.lines.filter((line) => line && typeof line.text === "string").slice(-400);
      state.round = Number(parsed.round) || 0;
      return state.lines.length > 0;
    } catch (_) {
      return false;
    }
  }

  /* ---------- 渲染 ---------- */
  function renderPresets() {
    els.nodes.innerHTML = "";
    LOCATIONS.forEach(function (preset) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "map-node" + (state.presetId === preset.id ? " is-active" : "");
      button.dataset.preset = preset.id;
      button.title = preset.hint;
      button.setAttribute("aria-pressed", String(state.presetId === preset.id));
      button.innerHTML =
        '<span class="map-node-dot"><span class="map-node-glyph" aria-hidden="true"></span></span>' +
        '<span class="map-node-name"></span>';
      button.querySelector(".map-node-glyph").textContent = preset.glyph;
      button.querySelector(".map-node-name").textContent = preset.name;
      button.addEventListener("click", function () {
        if (runtime.running) return;
        state.presetId = preset.id;
        state.scene = preset.name + "。" + preset.hint;
        if (els.sceneInput) els.sceneInput.value = state.scene;
        saveScene();
        renderPresets();
        renderHint();
      });
      els.nodes.appendChild(button);
    });
  }

  function sceneText() {
    var text = String(state.scene || "").trim();
    if (text) return text;
    var preset = locationById(state.presetId);
    return preset ? preset.name + "。" + preset.hint : "";
  }

  function renderHint() {
    var text = sceneText();
    els.hint.textContent = text
      ? "场景：" + text
      : "先写下（或选一个）场景，再挑同场角色——任何世界观都行。";
  }

  function renderCast() {
    els.cast.innerHTML = "";
    runtime.characters.forEach(function (character) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cast-chip" + (state.cast.indexOf(character.avatar) >= 0 ? " is-on" : "");
      chip.dataset.avatar = character.avatar;
      chip.setAttribute("aria-pressed", String(state.cast.indexOf(character.avatar) >= 0));
      chip.innerHTML = '<span class="cast-chip-avatar" aria-hidden="true"></span><span class="cast-chip-name"></span>';
      chip.querySelector(".cast-chip-avatar").style.backgroundImage = 'url("' + avatarUrl(character.avatar).replace(/"/g, "%22") + '")';
      chip.querySelector(".cast-chip-name").textContent = character.name || character.avatar;
      chip.addEventListener("click", function () {
        if (runtime.running) return;
        var index = state.cast.indexOf(character.avatar);
        if (index >= 0) state.cast.splice(index, 1);
        else state.cast.push(character.avatar);
        saveScene();
        renderCast();
      });
      els.cast.appendChild(chip);
    });
    els.castMeta.textContent = runtime.characters.length
      ? "已选 " + state.cast.length + " 人 · 按选择顺序发言"
      : "这个账号还没有角色卡。";
  }

  function lineNode(line, pending) {
    var wrap = document.createElement("div");
    wrap.className = "scene-line";
    if (line.kind === "narration") wrap.classList.add("is-narration");
    if (line.kind === "dice") wrap.classList.add("is-dice");
    if (line.isUser) wrap.classList.add("is-user");
    if (pending) wrap.classList.add("is-pending");

    var speaker = document.createElement("span");
    speaker.className = "scene-speaker";
    speaker.textContent = line.kind === "dice" ? "命运骰子" : (line.kind === "narration" ? "旁白" : (line.speaker || "角色"));
    wrap.appendChild(speaker);

    var text = document.createElement("p");
    text.className = "scene-text";
    text.textContent = line.text;
    if (pending) {
      var ink = document.createElement("span");
      ink.className = "scene-ink";
      ink.setAttribute("aria-hidden", "true");
      text.appendChild(ink);
    }
    wrap.appendChild(text);
    return wrap;
  }

  function renderScene() {
    var wasNearBottom = true;
    if (els.scroll) {
      wasNearBottom = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 96;
    }
    els.scroll.innerHTML = "";
    if (!state.lines.length) {
      var empty = document.createElement("p");
      empty.className = "map-scroll-empty";
      empty.id = "sceneEmpty";
      empty.textContent = "选好地点与角色后按「开演」，我会让每个人依次开口。";
      els.scroll.appendChild(empty);
    } else {
      state.lines.forEach(function (line) { els.scroll.appendChild(lineNode(line)); });
    }
    // 只在用户本来就在底部时跟随，避免抢走正在回看的人的滚动位置。
    if (wasNearBottom) els.scroll.scrollTop = els.scroll.scrollHeight;
    els.sceneMeta.textContent = state.lines.length
      ? "第 " + Math.max(1, state.round) + " 幕 · " + state.lines.length + " 条"
      : "尚未开始";
  }

  function appendLine(line) {
    state.lines.push(line);
    if (state.lines.length > 400) state.lines = state.lines.slice(-400);
    renderScene();
    saveScene();
  }

  function setRunning(running) {
    runtime.running = running;
    els.start.disabled = running;
    els.next.disabled = running || !state.lines.length;
    els.stop.disabled = !running;
    els.interject.disabled = running;
  }

  /* ---------- 数据加载 ---------- */
  function mapBook(name, entriesObject) {
    var entries = Object.keys(entriesObject || {}).map(function (key) {
      var raw = entriesObject[key] || {};
      return Object.assign({}, raw, { uid: raw.uid !== undefined && raw.uid !== null ? raw.uid : key });
    });
    return { name: name, entries: entries };
  }

  async function loadAll() {
    var user = await window.STApi.getCurrentUser();
    var model = window.TASK27A_ACCOUNT_CORE ? window.TASK27A_ACCOUNT_CORE.identityModel(user) : null;
    runtime.userName = (model && model.displayName) || (user && (user.name || user.handle)) || "我";
    els.account.textContent = (model && model.handle ? "@" + model.handle : "") + " · " + runtime.userName;

    var list = await window.STApi.listCharacters();
    runtime.characters = (Array.isArray(list) ? list : []).filter(function (card) {
      return card && typeof card.avatar === "string" && card.avatar;
    });
    runtime.harryAvatar = (runtime.characters.filter(function (card) {
      return /harry/i.test(String(card.name || "")) || /^Harry /i.test(card.avatar);
    })[0] || {}).avatar || "";

    var worlds = await window.STApi.listWorlds();
    var names = (Array.isArray(worlds) ? worlds : [])
      .filter(function (world) { return world && typeof world.name === "string" && world.name.indexOf("MB ") === 0; })
      .map(function (world) { return world.name; });
    var books = [];
    for (var i = 0; i < names.length; i += 1) {
      try {
        var data = await window.STApi.getWorld(names[i]);
        books.push(mapBook(names[i], data && data.entries));
      } catch (_) { /* 单本记忆书读取失败不影响剧情 */ }
    }
    runtime.books = books;

    var rawSettings = await window.STApi.getSettings();
    runtime.settings = parseSettings(rawSettings);
  }

  function parseSettings(value) {
    if (!value) return {};
    try {
      var raw = typeof value === "string" ? value : (value.settings !== undefined ? value.settings : value);
      if (raw && typeof raw === "object") return raw;
      return typeof raw === "string" ? (JSON.parse(raw) || {}) : {};
    } catch (_) { return {}; }
  }

  function booksFor(avatar) {
    var entry = null;
    for (var i = 0; i < runtime.characters.length; i += 1) {
      if (runtime.characters[i].avatar === avatar) { entry = runtime.characters[i]; break; }
    }
    var core = window.TASK29_CHARACTER_CORE;
    if (core && typeof core.memoryBooksFor === "function") {
      return core.memoryBooksFor(entry || { avatar: avatar }, runtime.books);
    }
    return [];
  }

  async function cardFor(avatar) {
    if (runtime.cardCache.has(avatar)) return runtime.cardCache.get(avatar);
    var card = await window.STApi.getCharacter(avatar);
    if (!card || !card.data) throw new Error("角色卡暂时读取不到：" + characterName(avatar));
    runtime.cardCache.set(avatar, card);
    return card;
  }

  /* ---------- 提示词组合 ----------
   * 多角色同场最容易出的问题是「你」指代不明：模型分不清在跟玩家说话还是在跟
   * 另一个角色说话。这里用三条硬规则解决：列出在场名单、要求点名、标明历史标签。
   * 另支持「玩家不在场（导演模式）」：角色之间互动，玩家的输入变成导演指示。 */
  function sceneDirective(avatar, others, lastSpeaker) {
    var name = characterName(avatar);
    var inScene = state.userInScene !== false;
    var player = runtime.userName || "玩家";
    var othersText = others.length ? others.join("、") : "（本轮没有其他角色）";
    var speakTargets = others.slice();
    if (inScene) speakTargets.push(player);
    var targetsText = speakTargets.length ? speakTargets.join("、") : "（本轮没有其他人）";
    var lines = [];
    lines.push("[Scene] 场景：" + (sceneText() || "（未指定，请按角色卡面自行合理展开）"));
    lines.push("在场角色：" + [name].concat(others).join("、") + (inScene
      ? "，以及玩家 " + player + "。"
      : "。玩家不在场，只以导演视角旁观这一幕。"));
    lines.push("你现在扮演：" + name + "。");
    if (state.goal) lines.push("这一幕的目标：" + state.goal + "。");
    if (lastSpeaker) lines.push("上一位开口的是：" + lastSpeaker + "。");
    lines.push("[发言规则]");
    lines.push("1. 只写 " + name + " 的台词、动作与神态（动作与环境用括号）；不要替其他角色发言。");
    lines.push("2. 对谁说话就点名：要跟 " + targetsText + " 说话时，先把对方名字写进台词（例如「Hermione，……」）；"
      + "这样读者与其他角色都能看出你在跟谁说话。");
    if (inScene) {
      lines.push("3. 对玩家说话时同样点名：" + player + "，……。**不要使用没有指代的「你」**——除非这句话里已经点过名。");
      lines.push("4. 历史消息的标记：【名字】开头的是别人的发言；【旁白】是场景叙述；【命运判定】是骰子结果；"
        + "【" + player + "（玩家）】是玩家本人说的（在场）；assistant 里的内容是你自己说过的话。");
    } else {
      lines.push("3. 玩家不在场：不要对玩家说话、不要提到有人在旁观看、也不要等玩家回应；请与其他在场角色互动。");
      lines.push("4. 历史消息的标记：【名字】开头的是别人的发言；【旁白】是场景叙述；【命运判定】是骰子结果；"
        + "【导演指示】是场外导演给出的剧情要求（照它推进，但不要在台词里回应导演）；assistant 里的内容是你自己说过的话。");
    }
    lines.push("5. 1-4 句，保持 " + name + " 的人物口吻；不要复述规则，不要提及自己是模型。");
    return lines.join("\n");
  }

  function historyMessages(avatar) {
    var out = [];
    var recent = state.lines.filter(function (line) { return line.kind !== "pending"; }).slice(-MAX_HISTORY);
    recent.forEach(function (line) {
      if (line.kind === "dice") {
        out.push({ role: "user", content: "【命运判定】" + line.text });
        return;
      }
      if (line.kind === "narration") {
        out.push({ role: "user", content: "【旁白】" + line.text });
        return;
      }
      if (line.avatar === avatar && !line.isUser) {
        out.push({ role: "assistant", content: line.text });
        return;
      }
      if (line.isUser) {
        var label = state.userInScene === false
          ? "【导演指示】"
          : "【" + (runtime.userName || "玩家") + "（玩家）】";
        out.push({ role: "user", content: label + line.text });
        return;
      }
      out.push({ role: "user", content: "【" + (line.speaker || "某人") + "】" + line.text });
    });
    return out;
  }

  function lastSpeakerBefore(avatar) {
    for (var index = state.lines.length - 1; index >= 0; index -= 1) {
      var line = state.lines[index];
      if (!line || line.kind === "pending") continue;
      if (line.kind !== "line") continue;
      if (line.isUser) return state.userInScene === false ? "导演" : (runtime.userName || "玩家");
      if (line.avatar !== avatar) return line.speaker || characterName(line.avatar);
    }
    return "";
  }

  function buildSceneMessages(card, avatar, others, promptText) {
    var base = window.TASK22_CORE.buildSystemPrompt(card, booksFor(avatar), promptText);
    var lastSpeaker = lastSpeakerBefore(avatar);
    var system = base + "\n\n" + sceneDirective(avatar, others, lastSpeaker);
    var name = characterName(avatar);
    var cue = state.userInScene === false
      ? "（继续这一幕：现在轮到你——" + name + "。请与其他在场角色互动，不要对场外的玩家说话。）"
      : "（继续这一幕：现在轮到你——" + name + "。要跟谁说话，请在台词里点出对方的名字。）";
    return [{ role: "system", content: system }].concat(historyMessages(avatar), [{ role: "user", content: cue }]);
  }

  /* ---------- 命运骰子 ---------- */
  function shouldRoll() {
    if (runtime.forcedDice !== null) return true;
    return Math.random() < DICE_CHANCE;
  }

  function rollDice() {
    if (runtime.forcedDice !== null) {
      var forced = runtime.forcedDice;
      runtime.forcedDice = null;
      return forced;
    }
    var buffer = new Uint32Array(1);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buffer);
    else buffer[0] = Math.floor(Math.random() * 4294967295);
    return (buffer[0] % DICE_SIDES) + 1;
  }

  function diceLine(value, goalText) {
    var tier = DICE_TIERS.filter(function (t) { return value <= t.max; })[0] || DICE_TIERS[DICE_TIERS.length - 1];
    var subject = (goalText || state.goal || "眼前的局面").replace(/\s+/g, " ").slice(0, 40);
    return {
      kind: "dice",
      speaker: "命运骰子",
      text: "d20 = " + value + " → " + tier.label + "（" + tier.tone + "）：" + subject,
      at: nowIso(),
    };
  }

  /* ---------- 生成 ---------- */
  async function generateTurn(avatar, signal) {
    var name = characterName(avatar);
    var card = await cardFor(avatar);
    var others = state.cast.filter(function (a) { return a !== avatar; }).map(characterName);
    var promptText = sceneText() + "\n" + (state.goal || "") + "\n" + state.lines.slice(-6).map(function (line) { return line.text; }).join("\n");
    var messages = buildSceneMessages(card, avatar, others, promptText);
    var payload = window.TASK22_CORE.buildGeneratePayload({
      card: card,
      memoryBooks: booksFor(avatar),
      history: [],
      userText: "（继续）",
      settings: runtime.settings,
      engine: "A",
      mode: runtime.modelMode,
      modelName: runtime.modelName,
      thinking: runtime.thinking === true,
      stream: false,
    });
    payload.messages = messages;
    var response = await window.STApi.generate(payload, signal);
    var parsed = window.TASK22_CORE.parseGenerateResponse(response);
    var text = (parsed.content || "").trim();
    if (!text) throw new Error(name + " 没有说话，请再试一次。");
    return text;
  }

  function pendingLine(avatar) {
    return { kind: "pending", avatar: avatar, speaker: characterName(avatar), text: characterName(avatar) + " 正在斟酌…", at: nowIso() };
  }

  async function runRound() {
    if (runtime.running) return;
    if (!state.cast.length) { setStatus("至少选一位在场角色。", true); return; }
    var core = window.TASK22_CORE;
    var deepseekMode = core.isDeepSeekChatMode(runtime.modelMode);
    var oai = (runtime.settings && runtime.settings.oai_settings) || {};
    if (!deepseekMode && !oai.custom_url) {
      setStatus("生成后端未就绪：请到「设置 → 对话」选择 DeepSeek 并保存 API Key，或确认本地模型可用。", true);
      return;
    }

    state.round += 1;
    saveScene();
    setRunning(true);
    setStatus("第 " + state.round + " 幕开始…");
    runtime.controller = new AbortController();
    var signal = runtime.controller.signal;

    try {
      for (var i = 0; i < state.cast.length; i += 1) {
        var avatar = state.cast[i];
        var name = characterName(avatar);
        if (state.dice && shouldRoll()) {
          appendLine(diceLine(rollDice(), state.goal));
        }
        var pending = pendingLine(avatar);
        state.lines.push(pending);
        renderScene();
        setStatus(name + " 正在斟酌…");
        var text;
        try {
          text = await generateTurn(avatar, signal);
        } finally {
          state.lines = state.lines.filter(function (line) { return line !== pending; });
        }
        if (signal.aborted) throw Object.assign(new Error("已停止"), { name: "AbortError" });
        appendLine({ kind: "line", avatar: avatar, speaker: name, text: text, at: nowIso() });
      }
      setStatus("第 " + state.round + " 幕完成。可以继续，或插一句话。");
    } catch (error) {
      if (error && error.name === "AbortError") setStatus("已停止。");
      else if (window.STApi.isAuthRequired(error)) {
        var routes = window.TASK31_ROUTING;
        window.location.replace(routes && routes.productLoginUrl ? routes.productLoginUrl() : "./login.html");
        return;
      } else setStatus((error && error.message) || "生成失败，请重试。", true);
    } finally {
      runtime.controller = null;
      setRunning(false);
      renderScene();
    }
  }

  function startScene() {
    if (!state.cast.length) { setStatus("至少选一位在场角色。", true); return; }
    state.lines = [];
    state.round = 0;
    var cast = state.cast.map(characterName);
    var presence = state.userInScene === false
      ? "在场：" + cast.join("、") + "。（你不在场，以导演视角旁观这一幕。）"
      : "在场：" + cast.join("、") + "，以及你（" + (runtime.userName || "玩家") + "）。";
    var scene = sceneText();
    appendLine({
      kind: "narration",
      speaker: "旁白",
      text: (scene ? "场景：" + scene + "\n" : "（未指定场景，按角色卡自行展开。）\n") + presence +
        (state.goal ? "\n这一刻的目标：" + state.goal + "。" : ""),
      at: nowIso(),
    });
    runRound();
  }

  function interject() {
    var value = (els.interjectInput.value || "").trim();
    if (!value) { setStatus("先写一句话再插话。", true); return; }
    var asDirector = state.userInScene === false;
    appendLine({
      kind: "line",
      speaker: asDirector ? "导演" : (runtime.userName || "玩家"),
      text: value,
      isUser: true,
      director: asDirector,
      at: nowIso(),
    });
    els.interjectInput.value = "";
    setStatus(asDirector ? "已给出一条导演指示。" : "你插了一句话。");
    if (!runtime.running) runRound();
  }

  function stopScene() {
    if (runtime.controller) runtime.controller.abort();
    setRunning(false);
    setStatus("已停止。");
  }

  function exportText() {
    var cast = state.cast.map(characterName);
    var head = [
      "# 剧情模式 · 剧情记录",
      "",
      "- 场景：" + (sceneText() || "（未指定）"),
      "- 在场：" + (cast.length ? cast.join("、") : "未选择") + (state.userInScene === false ? "" : (runtime.userName ? "、我（" + runtime.userName + "）" : "")),
      "- 目标：" + (state.goal || "（未填写）"),
      "- 幕数：" + Math.max(1, state.round) + " · 命运骰子：" + (state.dice ? "开" : "关"),
      "- 视角：" + (state.userInScene === false ? "导演（玩家不在场）" : "玩家在场"),
      "- 时间：" + nowIso(),
      "",
      "---",
      "",
    ].join("\n");
    var body = state.lines.map(function (line) {
      if (line.kind === "dice") return "> 🎲 " + line.text;
      if (line.kind === "narration") return "> " + line.text.replace(/\n/g, "\n> ");
      return "**" + (line.speaker || "角色") + "**：" + line.text;
    }).join("\n\n");
    return head + body + "\n";
  }

  function exportScene() {
    if (!state.lines.length) { setStatus("场景还是空的。", true); return; }
    var text = exportText();
    try {
      var blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "剧情模式-" + Date.now() + ".md";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      setStatus("剧本已导出（.md）。");
    } catch (_) {
      setStatus("导出失败，可手动复制场景记录。", true);
    }
  }

  function clearScene() {
    if (state.lines.length && !window.confirm("清空当前场景记录？场景与角色选择会保留。")) return;
    state.lines = [];
    state.round = 0;
    saveScene();
    renderScene();
    setRunning(false);
    setStatus("场景已清空。");
  }

  /* ---------- 启动 ---------- */
  /* 剧情模式与对话页共用同一份模型配置（「设置 → 模型」），不再各自记一套。 */
  async function loadModelMode() {
    var core = window.TASK22_CORE;
    var settings = {};
    try {
      if (window.RoleWorld && typeof window.RoleWorld.getLocalSettings === "function") {
        settings = await window.RoleWorld.getLocalSettings();
      }
    } catch (_) { /* 读不到就用默认值 */ }
    runtime.modelName = String(settings.model || "");
    runtime.modelMode = settings.provider === "deepseek" ? core.CHAT_MODES.DEEPSEEK_FLASH : core.CHAT_MODES.LOCAL;
  }

  async function useCardScenario() {
    if (runtime.running || !state.cast.length) {
      setStatus("先选一位在场角色，再取他/她的卡面场景。", true);
      return;
    }
    try {
      var card = await cardFor(state.cast[0]);
      var scenario = card && card.data ? String(card.data.scenario || "") : "";
      if (!scenario.trim()) { setStatus("这张角色卡没有写场景（scenario），可以自己写一句。", true); return; }
      state.scene = scenario.trim();
      state.presetId = "";
      els.sceneInput.value = state.scene;
      saveScene();
      renderPresets();
      renderHint();
      setStatus("已填入「" + characterName(state.cast[0]) + "」卡面里的场景。");
    } catch (error) {
      setStatus((error && error.message) || "读取角色卡失败。", true);
    }
  }

  async function boot() {
    els.nodes = $("mapNodes");
    els.hint = $("mapHint");
    els.sceneInput = $("sceneLocationInput");
    els.cast = $("castList");
    els.castMeta = $("castMeta");
    els.goal = $("sceneGoal");
    els.dice = $("diceToggle");
    els.userInScene = $("userInSceneToggle");
    els.start = $("startScene");
    els.next = $("nextRound");
    els.stop = $("stopScene");
    els.status = $("mapStatus");
    els.scroll = $("sceneScroll");
    els.sceneMeta = $("sceneMeta");
    els.interjectInput = $("interjectInput");
    els.interject = $("interjectSend");
    els.account = $("mapAccount");

    els.goal.addEventListener("input", function () { state.goal = els.goal.value; saveScene(); });
    els.sceneInput.addEventListener("input", function () {
      state.scene = els.sceneInput.value;
      state.presetId = "";
      saveScene();
      renderPresets();
      renderHint();
    });
    $("useCardScenario").addEventListener("click", useCardScenario);
    $("clearScenePreset").addEventListener("click", function () {
      if (runtime.running) return;
      state.scene = "";
      state.presetId = "";
      els.sceneInput.value = "";
      saveScene();
      renderPresets();
      renderHint();
      setStatus("已清空场景描述。");
    });
    $("collapseSetup").addEventListener("click", function () {
      $("stageSetup").hidden = true;
      $("expandSetup").hidden = false;
    });
    $("expandSetup").addEventListener("click", function () {
      $("stageSetup").hidden = false;
      $("expandSetup").hidden = true;
    });
    els.dice.addEventListener("change", function () { state.dice = !!els.dice.checked; saveScene(); });
    els.userInScene.addEventListener("change", function () {
      state.userInScene = !!els.userInScene.checked;
      saveScene();
      setStatus(state.userInScene
        ? "你已进入场景：角色可以直接和你说话。"
        : "已切换为导演视角：角色之间互相交谈，你的插话会作为导演指示。");
    });
    els.start.addEventListener("click", startScene);
    els.next.addEventListener("click", runRound);
    els.stop.addEventListener("click", stopScene);
    els.interject.addEventListener("click", interject);
    els.interjectInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); interject(); }
    });
    $("exportScene").addEventListener("click", exportScene);
    $("clearScene").addEventListener("click", clearScene);

    try {
      await window.STApi.init();
      await loadAll();
    } catch (error) {
      if (window.STApi.isAuthRequired(error)) {
        var routes = window.TASK31_ROUTING;
        window.location.replace(routes && routes.productLoginUrl ? routes.productLoginUrl() : "./login.html");
        return;
      }
      setStatus("初始化失败：" + ((error && error.message) || "请刷新重试"), true);
      return;
    }

    var store = storage("sessionStorage");
    runtime.handle = store ? (store.getItem(HANDLE_KEY) || "") : "";
    if (!runtime.handle) runtime.handle = "anon";

    var restored = loadScene();
    state.cast = state.cast.filter(function (avatar) { return !!characterByAvatar(avatar); });
    await loadModelMode();
    els.goal.value = state.goal;
    els.sceneInput.value = state.scene;
    els.dice.checked = state.dice;
    els.userInScene.checked = state.userInScene !== false;
    renderPresets();
    renderHint();
    renderCast();
    renderScene();
    setRunning(false);
    if (restored) setStatus("已恢复上次的场景记录。");

    window.MAGIC_MAP_TEST = {
      exportText: exportText,
      state: function () { return JSON.parse(JSON.stringify(state)); },
      forceDice: function (value) { runtime.forcedDice = Number(value); },
      presets: LOCATIONS.map(function (preset) { return preset.id; }),
      modelMode: function () { return runtime.modelMode; },
      sceneText: sceneText,
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
