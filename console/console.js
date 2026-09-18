"use strict";

/*
 * console/console.js —— 体验卡控制台的界面逻辑（原生 DOM，无依赖）
 *
 * 它只跟**本机的控制台服务**说话（scripts/console.cjs）；发卡口令在本机服务里，页面拿不到。
 * 钥匙是地址栏上的 ?k=…：每次请求都放进 `x-rw-console` 头。
 *
 * 这一版（2026-09-14）把控制台从"能用"做成"顺手"，五条工作流各自成块：
 *   ① 总览：连接状态 + 卡的状态分布 + 今日用量 + **数据是什么时候取的**
 *   ② 发卡：聊天次数 / token / 语音次数 / 语音字数 / 有效期，每一项都能勾「不限制」
 *      （**不再让用户猜 0 是什么意思**）
 *   ③ 卡列表：搜索 / 筛选 / 排序 + **聊天与语音各自是否可用**（聊天用完了，
 *      独立的语音额度不该跟着被判死）
 *   ④ 卡详情：最近用量、就地改额度/续期、停用恢复、复制交付文案
 *   ⑤ 批量操作：先"查看影响"再执行，部分失败保留已成功的结果
 *
 * 两条硬规矩（有用例盯着）：
 *   · **不把 token 或字符数冒充金额** —— 没有可靠价格与计费时只显示用量；
 *   · 停用（可恢复）与吊销（不可恢复）在界面上是**两个不同的动作**，措辞也不同。
 */

(function () {
  const KEY = new URLSearchParams(location.search).get("k") || "";
  const $ = (id) => document.getElementById(id);
  let cards = [];
  let state = null;
  let usage = null;
  let lastCheckedAt = "";
  let detailId = "";
  let batchRows = [];

  /* ---------------- 基础工具 ---------------- */

  async function api(path, options) {
    const opts = options || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ "x-rw-console": KEY }, opts.body ? { "Content-Type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error && (body.error.message || body.error)) || ("HTTP " + res.status));
    return body;
  }

  function toast(text, isBad) {
    const node = $("toast");
    node.textContent = text;
    node.style.borderColor = isBad ? "var(--bad)" : "var(--line)";
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  /** 统一的"加载中"占位：每个区块都要有，不能只留一行"正在读取…"然后什么都不发生。 */
  function setBusy(node, text) {
    if (!node) return;
    node.textContent = text || "正在读取…";
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制" + (what || ""));
      return true;
    } catch (_) {
      // 剪贴板要 https 或 localhost；本机控制台是 localhost，正常都行，兜底给选中。
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); toast("已复制" + (what || "")); } catch (_) { toast("复制失败：请手动选中", true); }
      area.remove();
      return false;
    }
  }

  /**
   * 金额口径（刻意保守）：**没有可靠价格就不显示钱**。
   * token 数与字符数是**用量**，不是钱；把它们折算成人民币需要一个会变的单价，
   * 而控制台里悄悄乘一个数会让用户以为那就是账单。所以这里只做格式化，
   * 不出现任何货币符号，也不做任何估算。
   */
  function fmtNumber(value) {
    const num = Number(value) || 0;
    return num.toLocaleString("zh-CN");
  }

  function fmtLimit(value) {
    const num = Number(value) || 0;
    return num > 0 ? fmtNumber(num) : "不限制";
  }

  /* ---------------- 状态与健康 ---------------- */

  async function loadState() {
    state = await api("/api/state");
    lastCheckedAt = state.checkedAt || new Date().toISOString();
    $("healthDot").className = "dot " + (state.health && state.health.ok ? "is-ok" : "is-bad");
    const bits = [];
    if (state.health && state.health.ok) {
      bits.push("中转正常 · 账本 " + (state.health.store || "?"));
      bits.push(state.health.upstreamKeySet ? "上游 key 已配" : "上游 key 没配");
      if (state.health.voiceKeySet) bits.push("语音已配（" + (state.health.voiceSpeakers || 0) + " 个音色）");
      else bits.push("语音没配");
      if (state.health.adminEnabled === false) bits.push("管理接口关了");
    } else {
      bits.push("连不上中转：" + ((state.health && (state.health.error || state.health.raw)) || "没有回应"));
    }
    $("healthText").textContent = bits.join(" · ");
    const warn = $("secretWarning");
    if (!state.hasSecret) {
      warn.hidden = false;
      warn.textContent = "没读到发卡口令：把口令写进 " + state.secretFile + "（或设环境变量 ADMIN_SECRET）后重启控制台。";
    } else {
      warn.hidden = true;
    }
    $("recordCount").textContent = "本机留底：" + state.recordCount + " 张";
    $("recordHint").textContent = "文件：" + state.recordFile + "　（已 gitignore；这份文件等于凭据，别外传。服务端账本只有哈希，卡号丢了就找不回来，所以自己发的卡会记在这里。）";
    renderOverview();
  }

  /* ---------------- 卡的状态（聊天与语音**分开判**） ---------------- */

  function expiryInfo(card) {
    if (!card.expiresAt) return { expired: false, days: null, text: "不过期" };
    const at = Date.parse(card.expiresAt);
    if (Number.isNaN(at)) return { expired: false, days: null, text: String(card.expiresAt).slice(0, 10) };
    const days = Math.ceil((at - Date.now()) / 86400000);
    return { expired: at < Date.now(), days: days, text: card.expiresAt.slice(0, 10) + (days >= 0 ? "（" + days + " 天）" : "（已过期）") };
  }

  /** 剩余额度：0 上限 = 不限制（返回 null 表示"没有上限"）。 */
  function leftOf(quotaValue, usedValue) {
    const cap = Number(quotaValue) || 0;
    if (cap <= 0) return null;
    return Math.max(0, cap - (Number(usedValue) || 0));
  }

  /**
   * 语音这一栏要写清**三种状态**，不许让一个 0 同时表示两件事
   * （文档 §12：「未开放、有限额、不限额为不同状态……不得在界面让 0 同时表达
   * 「不允许」和「不限制」」）。
   *
   * 服务端的记账契约是 **0 = 没有上限**（`relay/store.js`：`quota.voice = 0` ⇒ 不限），
   * 所以一个 `voice: 0` 的卡**并不是"不给语音"**。那怎么分辨"这张卡本来就没打算给语音"？
   * 判据：**两份额度都写 0，而且一个字都没用过** —— 发卡时没勾语音的人就是这种形状。
   * 只要任一额度 > 0、或者用过一次语音，就算语音是开着的。
   * 这是**兼容映射**（文档要求"若旧后端 0 代表无限，需通过明确字段及兼容映射处理"），
   * 老卡不用迁移，界面先把话说准。
   */
  function voiceStateOf(card) {
    const quota = (card && card.quota) || {};
    const used = (card && card.used) || {};
    const voiceCap = Number(quota.voice) || 0;
    const charsCap = Number(quota.voiceChars) || 0;
    const voiceUsed = Number(used.voice) || 0;
    const charsUsed = Number(used.voiceChars) || 0;
    // 没勾"不限制"时字段缺省也是 0，所以再用"用过没有"补一条证据。
    const enabled = voiceCap > 0 || charsCap > 0 || voiceUsed > 0 || charsUsed > 0;
    return {
      enabled: enabled,
      voiceCap: voiceCap, charsCap: charsCap,
      voiceUsed: voiceUsed, charsUsed: charsUsed,
      voiceUnlimited: enabled && voiceCap === 0,
      charsUnlimited: enabled && charsCap === 0,
    };
  }

  /** 额度那一格：`已用 / 上限`；不限额与未开放分开写（见 voiceStateOf）。 */
  function voiceQuotaCell(used, cap, unlimited, kind) {
    const wrap = document.createElement("span");
    wrap.className = "quota-cell";
    const main = document.createElement("span");
    if (cap > 0) main.textContent = fmtNumber(used) + " / " + fmtNumber(cap);
    else if (unlimited) main.textContent = fmtNumber(used) + " / 不限";
    else main.textContent = "未开放";
    wrap.appendChild(main);
    if (cap > 0) {
      const em = document.createElement("em");
      em.textContent = "剩 " + fmtNumber(Math.max(0, cap - used)) + (kind === "chars" ? " 字" : " 次");
      wrap.appendChild(em);
    }
    return wrap;
  }

  /**
   * 一张卡的两条独立结论。**刻意分开算**：
   * 聊天次数用完了，独立的语音次数/字数**不该跟着被判成用完** ——
   * 它们本来就是两份额度（语音按字符计费，聊天按 token 计费）。
   */
  function statusOf(card) {
    const expiry = expiryInfo(card);
    const callsLeft = leftOf(card.quota && card.quota.calls, card.used && card.used.calls);
    const tokensLeft = leftOf(card.quota && card.quota.tokens, card.used && card.used.tokens);
    const voiceLeft = leftOf(card.quota && card.quota.voice, card.used && card.used.voice);
    const voiceCharsLeft = leftOf(card.quota && card.quota.voiceChars, card.used && card.used.voiceChars);
    const verdict = (left, lowAt) => {
      if (card.disabled) return { key: "disabled", label: "已停用", tone: "bad", left: left };
      if (expiry.expired) return { key: "expired", label: "已到期", tone: "bad", left: left };
      if (left !== null && left <= 0) return { key: "empty", label: "额度用完", tone: "bad", left: left };
      if (left !== null && left <= lowAt) return { key: "low", label: "剩 " + fmtNumber(left), tone: "warn", left: left };
      return { key: "ok", label: left === null ? "可用（不限）" : "剩 " + fmtNumber(left), tone: "ok", left: left };
    };
    const vs = voiceStateOf(card);
    const chat = verdict(callsLeft, 3);
    // token 也用完时聊天同样不可用 —— 但语音仍然独立。
    if (chat.key === "ok" && tokensLeft !== null && tokensLeft <= 0) {
      chat.key = "empty"; chat.label = "token 用完"; chat.tone = "bad";
    }
    // 语音那一格也要分清「没给语音」和「不限额」：两份额度都是 0 时
    // verdict 会写成"可用（不限）"，看着像给了不限额的语音，其实这张卡没开语音。
    const voice = vs.enabled
      ? verdict(voiceLeft === null ? voiceCharsLeft : voiceLeft, 2)
      : { key: "none", label: "未开放", tone: "", left: null };
    if (voice.key === "ok" && vs.voiceUnlimited && vs.charsUnlimited) {
      voice.label = "可用（不限额）";
    }
    if (voice.key === "ok" && voiceLeft !== null && voiceLeft > 2) {
      if (voiceCharsLeft !== null && voiceCharsLeft <= 0) { voice.key = "empty"; voice.label = "字数用完"; voice.tone = "bad"; }
      else if (voiceCharsLeft !== null && voiceCharsLeft <= 200) { voice.key = "low"; voice.label = "剩 " + fmtNumber(voiceCharsLeft) + " 字"; voice.tone = "warn"; }
    }
    // 总状态给一行人话（看板用）：聊天不可用就是"不可用"，但**语音状态单独列**。
    const overall = card.disabled ? "disabled" : (expiry.expired ? "expired" : (chat.key === "empty" ? "empty" : (chat.key === "low" ? "low" : "ok")));
    return { chat: chat, voice: voice, expiry: expiry, overall: overall, callsLeft: callsLeft, tokensLeft: tokensLeft, voiceLeft: voiceLeft, voiceCharsLeft: voiceCharsLeft };
  }

  function fmtTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
  }

  /* ---------------- ① 总览 ---------------- */

  function renderOverview() {
    const box = $("overviewTiles");
    if (!box) return;
    box.textContent = "";
    const rows = Array.isArray(cards) ? cards : [];
    const alive = rows.filter((card) => statusOf(card).overall === "ok" || statusOf(card).overall === "low");
    const voiceReady = rows.filter((card) => {
      const s = statusOf(card);
      return s.voice.key === "ok" || s.voice.key === "low";
    });
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = (usage && Array.isArray(usage.days) ? usage.days.find((row) => row.day === today) : null) || null;
    const tiles = [
      { label: "还能用的卡", value: alive.length + " / " + rows.length, hint: "聊天额度未用尽、未停用、未到期" },
      { label: "能发语音的卡", value: voiceReady.length + " 张", hint: "语音额度独立的另一份" },
      { label: "已停用", value: rows.filter((card) => card.disabled).length + " 张", hint: "停了还能恢复" },
      { label: "已到期", value: rows.filter((card) => statusOf(card).expiry.expired).length + " 张", hint: "过期不能再启用" },
      { label: "额度用完", value: rows.filter((card) => statusOf(card).overall === "empty").length + " 张", hint: "可以就地加额度" },
      { label: "今日聊天", value: fmtNumber(todayRow ? todayRow.calls : 0) + " 次", hint: "按天记账，账本留 30 天" },
      { label: "今日语音", value: fmtNumber(todayRow ? todayRow.voice : 0) + " 次", hint: todayRow ? fmtNumber(todayRow.chars) + " 字" : "0 字" },
      { label: "累计 token", value: fmtNumber(rows.reduce((sum, card) => sum + (Number(card.used && card.used.tokens) || 0), 0)), hint: "**用量不是金额**：这里不折算钱" },
    ];
    for (const tile of tiles) {
      const node = document.createElement("div");
      node.className = "tile";
      const value = document.createElement("strong");
      value.textContent = tile.value;
      const label = document.createElement("span");
      label.className = "tile-label";
      label.textContent = tile.label;
      const hint = document.createElement("em");
      hint.className = "tile-hint";
      hint.textContent = tile.hint;
      node.append(value, label, hint);
      box.appendChild(node);
    }
    $("overviewStamp").textContent = lastCheckedAt
      ? ("数据取自 " + fmtTime(lastCheckedAt) + "（点右上角「刷新」重新取）")
      : "";
  }

  /* ---------------- ③ 卡列表 ---------------- */

  function visibleCards() {
    const keyword = $("searchInput").value.trim().toLowerCase();
    const filter = $("filterSelect").value;
    const sort = $("sortSelect").value;
    let rows = cards.slice();
    if (keyword) {
      rows = rows.filter((card) => [card.label, card.id, card.note, statusOf(card).chat.label, statusOf(card).voice.label]
        .join(" ").toLowerCase().indexOf(keyword) >= 0);
    }
    if (filter === "usable") rows = rows.filter((card) => ["ok", "low"].indexOf(statusOf(card).chat.key) >= 0);
    if (filter === "voice") rows = rows.filter((card) => ["ok", "low"].indexOf(statusOf(card).voice.key) >= 0);
    if (filter === "empty") rows = rows.filter((card) => statusOf(card).chat.key === "empty");
    if (filter === "expired") rows = rows.filter((card) => statusOf(card).expiry.expired);
    if (filter === "disabled") rows = rows.filter((card) => card.disabled);
    rows.sort((a, b) => {
      if (sort === "used") return (Number(b.used && b.used.calls) || 0) - (Number(a.used && a.used.calls) || 0);
      if (sort === "voice") return (Number(b.used && b.used.voice) || 0) - (Number(a.used && a.used.voice) || 0);
      if (sort === "label") return String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
      if (sort === "lastUsed") return (Date.parse(b.lastUsedAt || 0) || 0) - (Date.parse(a.lastUsedAt || 0) || 0);
      const at = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
      const bt = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
      return at - bt;
    });
    return rows;
  }

  function tag(text, tone) {
    const node = document.createElement("span");
    node.className = "tag" + (tone ? " " + tone : "");
    node.textContent = text;
    return node;
  }

  /** 额度那一格：`已用 / 上限`，不限制时写"不限制"。 */
  function quotaCell(used, cap, extra) {
    const wrap = document.createElement("span");
    wrap.className = "quota-cell";
    const main = document.createElement("span");
    main.textContent = fmtNumber(used) + " / " + fmtLimit(cap);
    wrap.appendChild(main);
    if (extra) {
      const em = document.createElement("em");
      em.textContent = extra;
      wrap.appendChild(em);
    }
    return wrap;
  }

  function renderCards() {
    const tbody = $("cardRows");
    tbody.textContent = "";
    const source = Array.isArray(cards) ? cards : [];
    const rows = visibleCards();
    for (const card of rows) {
      const s = statusOf(card);
      const tr = document.createElement("tr");
      if (s.overall === "low") tr.className = "is-low";
      if (s.overall === "disabled" || s.overall === "expired" || s.overall === "empty") tr.className = "is-dead";

      const label = document.createElement("td");
      const link = document.createElement("button");
      link.type = "button";
      link.className = "link";
      link.textContent = card.label || "（没标签）";
      link.dataset.detail = card.id;
      link.title = "看这张卡的用量明细";
      label.appendChild(link);
      tr.appendChild(label);

      const id = document.createElement("td");
      id.className = "mono";
      id.textContent = card.id;
      tr.appendChild(id);

      const calls = document.createElement("td");
      calls.appendChild(quotaCell(card.used && card.used.calls, card.quota && card.quota.calls,
        s.callsLeft === null ? "" : ("剩 " + fmtNumber(s.callsLeft))));
      tr.appendChild(calls);

      const tokens = document.createElement("td");
      tokens.appendChild(quotaCell(card.used && card.used.tokens, card.quota && card.quota.tokens,
        s.tokensLeft === null ? "" : ("剩 " + fmtNumber(s.tokensLeft) + " token")));
      tr.appendChild(tokens);

      // 语音那两格：**未开放 / 有限额 / 不限额**三种状态分开写（见 voiceStateOf）。
      const vs = voiceStateOf(card);
      const voice = document.createElement("td");
      voice.appendChild(voiceQuotaCell(vs.voiceUsed, vs.voiceCap, vs.voiceUnlimited, "calls"));
      tr.appendChild(voice);

      const chars = document.createElement("td");
      chars.appendChild(voiceQuotaCell(vs.charsUsed, vs.charsCap, vs.charsUnlimited, "chars"));
      tr.appendChild(chars);

      const expires = document.createElement("td");
      expires.textContent = card.expiresAt ? s.expiry.text : "不过期";
      tr.appendChild(expires);

      const last = document.createElement("td");
      last.textContent = fmtTime(card.lastUsedAt);
      tr.appendChild(last);

      // 聊天与语音**各一格**：一眼看出"聊天用完了但语音还能发"这种情况。
      const chatCell = document.createElement("td");
      chatCell.appendChild(tag(s.chat.label, s.chat.tone));
      tr.appendChild(chatCell);
      const voiceCell = document.createElement("td");
      voiceCell.appendChild(tag(s.voice.label, s.voice.tone));
      tr.appendChild(voiceCell);

      const actions = document.createElement("td");
      actions.className = "row-actions";
      const detail = document.createElement("button");
      detail.type = "button";
      detail.className = "btn";
      detail.textContent = "详情";
      detail.dataset.detail = card.id;
      actions.appendChild(detail);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn";
      toggle.textContent = card.disabled ? "恢复" : "停用";
      toggle.title = card.disabled ? "恢复之后立刻能用" : "停用是**可恢复**的：卡还在账本里，随时能恢复";
      toggle.dataset.toggle = card.id;
      actions.appendChild(toggle);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
    const alive = source.filter((card) => ["ok", "low"].indexOf(statusOf(card).chat.key) >= 0).length;
    const voiceAlive = source.filter((card) => ["ok", "low"].indexOf(statusOf(card).voice.key) >= 0).length;
    $("cardsSummary").textContent = "共 " + source.length + " 张：聊天可用 " + alive + " 张，语音可用 " + voiceAlive
      + " 张；当前显示 " + rows.length + " 张。";
    const empty = $("cardsEmpty");
    if (!rows.length) {
      empty.hidden = false;
      empty.textContent = source.length
        ? "没有符合当前搜索 / 筛选的卡。把筛选改回「全部」或者清空搜索框。"
        : "还没有发过卡。在上面「发卡」里填好额度发第一张。";
    } else {
      empty.hidden = true;
    }
  }

  async function loadCards() {
    const data = await api("/api/cards");
    cards = data.cards || [];
    lastCheckedAt = data.checkedAt || new Date().toISOString();
    renderCards();
    renderOverview();
    if (detailId) {
      const still = cards.find((card) => String(card.id) === String(detailId));
      if (still) renderDetail(detailId);
      else closeDetail();
    }
  }

  /** 按天用量（最近 7 天）：一眼看出"今天谁用得多" —— 卡被转借只有这里看得出来。 */
  async function loadUsage() {
    const box = $("overviewUsage");
    if (!box) return;
    try {
      const data = await api("/api/usage?days=7");
      usage = data;
      const max = Math.max(1, ...(data.days || []).map((row) => row.calls + row.voice));
      box.hidden = false;
      box.textContent = "";
      const title = document.createElement("div");
      title.className = "usage-title";
      title.innerHTML = "最近 7 天用量　<span class=\"muted\">合计 " + fmtNumber(data.totalCalls) + " 次聊天 / "
        + fmtNumber(data.totalVoice) + " 次语音 / " + data.cards + " 张卡</span>";
      box.appendChild(title);
      const bars = document.createElement("div");
      bars.className = "usage-bars";
      for (const row of data.days || []) {
        const total = Number(row.calls) + Number(row.voice);
        const item = document.createElement("div");
        item.className = "usage-bar";
        item.title = row.day + "：聊天 " + row.calls + " 次 / " + row.tokens + " token；语音 " + row.voice
          + " 次 / " + row.chars + " 字；活跃卡 " + row.cards + " 张";
        const fill = document.createElement("div");
        fill.className = "usage-fill";
        fill.style.height = Math.round((total / max) * 100) + "%";
        const label = document.createElement("span");
        label.textContent = total ? String(total) : "";
        const day = document.createElement("em");
        day.textContent = row.day.slice(5);
        item.append(fill, label, day);
        bars.appendChild(item);
      }
      box.appendChild(bars);
      renderOverview();
    } catch (_) { box.hidden = true; }
  }

  /* ---------------- ④ 卡详情 ---------------- */

  function closeDetail() {
    detailId = "";
    $("detailCard").hidden = true;
    $("detailBody").textContent = "";
    $("detailTitle").textContent = "";
  }

  async function renderDetail(id) {
    detailId = String(id);
    const card = $("detailCard");
    const body = $("detailBody");
    card.hidden = false;
    body.textContent = "";
    setBusy($("detailTitle"), "正在读取这张卡的用量…");
    let data = null;
    try {
      data = await api("/api/card/" + encodeURIComponent(id));
    } catch (error) {
      setBusy($("detailTitle"), "");
      const fail = document.createElement("p");
      fail.className = "banner bad";
      fail.textContent = "读这张卡失败了：" + error.message;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn";
      retry.textContent = "重试";
      retry.addEventListener("click", () => renderDetail(id));
      body.append(fail, retry);
      return;
    }
    const row = data.card;
    const s = statusOf(row);
    $("detailTitle").textContent = (row.label || "（没标签）") + " · " + row.id + " · " + s.chat.label + " / 语音 " + s.voice.label;

    // 概要
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    const facts = [
      ["聊天", fmtNumber(row.used && row.used.calls) + " / " + fmtLimit(row.quota && row.quota.calls)
        + (s.callsLeft === null ? "" : "（剩 " + fmtNumber(s.callsLeft) + " 次）")],
      ["token", fmtNumber(row.used && row.used.tokens) + " / " + fmtLimit(row.quota && row.quota.tokens)],
      ["语音", fmtNumber(row.used && row.used.voice) + " / " + fmtLimit(row.quota && row.quota.voice)
        + (s.voiceLeft === null ? "" : "（剩 " + fmtNumber(s.voiceLeft) + " 次）")],
      ["语音字数", fmtNumber(row.used && row.used.voiceChars) + " / " + fmtLimit(row.quota && row.quota.voiceChars)],
      ["到期", row.expiresAt ? s.expiry.text : "不过期"],
      ["创建", fmtTime(row.createdAt)],
      ["最后使用", fmtTime(row.lastUsedAt)],
      ["状态", (row.disabled ? "已停用" : "启用中") + (s.expiry.expired ? " · 已过期" : "")],
    ];
    for (const [label, value] of facts) {
      const node = document.createElement("div");
      const dt = document.createElement("span");
      dt.className = "muted";
      dt.textContent = label;
      const dd = document.createElement("strong");
      dd.textContent = value;
      node.append(dt, dd);
      grid.appendChild(node);
    }
    body.appendChild(grid);

    // 最近用量
    const usageTitle = document.createElement("p");
    usageTitle.className = "muted";
    usageTitle.textContent = "最近用量（按天，最多 14 天；账本里最多留 30 天）";
    body.appendChild(usageTitle);
    if (!data.daily || !data.daily.length) {
      const none = document.createElement("p");
      none.className = "muted";
      none.textContent = "这张卡还没有用过。";
      body.appendChild(none);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      table.className = "mini";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const text of ["日期", "聊天次数", "token", "语音次数", "语音字数"]) {
        const th = document.createElement("th");
        th.textContent = text;
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      table.appendChild(head);
      const tbody = document.createElement("tbody");
      for (const day of data.daily) {
        const tr = document.createElement("tr");
        for (const value of [day.day, fmtNumber(day.calls), fmtNumber(day.tokens), fmtNumber(day.voice), fmtNumber(day.chars)]) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      body.appendChild(wrap);
    }

    // 就地改额度 / 续期
    const editTitle = document.createElement("p");
    editTitle.className = "muted";
    editTitle.textContent = "改额度 / 续期（填的是**新的上限**，不是加多少；留空 = 不动这一项。"
      + "「再给几天」是**从今天起**重新算到期时间）。想设成不限制就填 0。";
    body.appendChild(editTitle);
    const form = document.createElement("div");
    form.className = "form-grid";
    const fields = [
      { key: "calls", label: "聊天次数上限", value: Number(row.quota && row.quota.calls) || 0 },
      { key: "tokens", label: "token 上限", value: Number(row.quota && row.quota.tokens) || 0 },
      { key: "voice", label: "语音次数上限", value: Number(row.quota && row.quota.voice) || 0 },
      { key: "voiceChars", label: "语音字数上限", value: Number(row.quota && row.quota.voiceChars) || 0 },
      { key: "days", label: "再给几天", value: "" },
    ];
    const inputs = {};
    for (const field of fields) {
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.value = field.value === "" ? "" : String(field.value);
      input.dataset.field = field.key;
      label.appendChild(input);
      inputs[field.key] = input;
      form.appendChild(label);
    }
    body.appendChild(form);
    const actions = document.createElement("div");
    actions.className = "actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn primary";
    save.textContent = "保存修改";
    save.addEventListener("click", async () => {
      const payload = {};
      for (const key of ["calls", "tokens", "voice", "voiceChars", "days"]) {
        const raw = String(inputs[key].value || "").trim();
        if (raw === "") continue;
        const num = Number(raw);
        if (!Number.isFinite(num) || num < 0) { toast("「" + key + "」要填一个不小于 0 的数字", true); return; }
        payload[key] = Math.trunc(num);
      }
      if (!Object.keys(payload).length) { toast("没有要改的东西：至少填一项", true); return; }
      save.disabled = true;
      try {
        await api("/api/card/" + encodeURIComponent(row.id) + "/extend", { method: "POST", body: payload });
        toast("已更新：" + (row.label || row.id) + "（改了 " + Object.keys(payload).join(" / ") + "）");
        await loadCards();
      } catch (error) {
        toast("更新失败：" + error.message, true);
      } finally {
        save.disabled = false;
      }
    });
    actions.appendChild(save);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn";
    toggle.textContent = row.disabled ? "恢复启用" : "停用";
    toggle.title = row.disabled ? "恢复之后立刻能用" : "停用是**可恢复**的，不会删掉账本里的记录";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await api("/api/card/" + encodeURIComponent(row.id) + "/" + (row.disabled ? "enable" : "disable"), { method: "POST" });
        toast(row.disabled ? "已恢复启用" : "已停用（随时能恢复）");
        await loadCards();
      } catch (error) {
        toast("操作失败：" + error.message, true);
      } finally {
        toggle.disabled = false;
      }
    });
    actions.appendChild(toggle);

    if (row.token) {
      const text = document.createElement("button");
      text.type = "button";
      text.className = "btn";
      text.textContent = "复制交付文案";
      text.addEventListener("click", async () => {
        text.disabled = true;
        try {
          const data2 = await api("/api/text", { method: "POST", body: { token: row.token } });
          await copy(data2.shareText, "（那段话）");
        } catch (error) {
          toast("生成失败：" + error.message, true);
        } finally {
          text.disabled = false;
        }
      });
      actions.appendChild(text);
    } else {
      const hint = document.createElement("span");
      hint.className = "muted";
      hint.textContent = "这张卡的卡号没有留在本机（服务端只有哈希），所以复制不了交付文案 —— "
        + "把手里那张卡的卡号粘到下面「本机留底」里登记一下就能复制了。";
      actions.appendChild(hint);
    }
    body.appendChild(actions);

    // 吊销单独一块：**不可逆**，措辞与"停用"必须一眼分得开。
    const danger = document.createElement("div");
    danger.className = "danger-zone";
    const dangerText = document.createElement("p");
    dangerText.className = "muted";
    dangerText.textContent = "吊销 = 从账本里删掉，**不可恢复**（停用才是可恢复的那个）。";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "btn danger";
    revoke.textContent = "吊销这张卡";
    revoke.addEventListener("click", () => revokeCard(row));
    danger.append(dangerText, revoke);
    body.appendChild(danger);
  }

  async function setDisabled(card, disabled) {
    try {
      await api("/api/card/" + encodeURIComponent(card.id) + "/" + (disabled ? "disable" : "enable"), { method: "POST" });
      toast("已" + (disabled ? "停用（随时能恢复）" : "恢复启用") + "：" + (card.label || card.id));
      await loadCards();
    } catch (error) {
      toast("操作失败：" + error.message, true);
    }
  }

  async function revokeCard(card) {
    const name = card.label || card.id;
    if (!window.confirm("吊销「" + name + "」？\n\n这张卡会从账本里删掉，拿着它的人立刻用不了，且**不可恢复**。\n如果只是想暂时不让用，请用「停用」。\n\n确定要吊销吗？")) return;
    try {
      await api("/api/card/" + encodeURIComponent(card.id) + "/revoke", { method: "POST" });
      toast("已吊销：" + name);
      if (String(detailId) === String(card.id)) closeDetail();
      await loadCards();
      await loadState();
    } catch (error) {
      toast("吊销失败：" + error.message, true);
    }
  }

  /* ---------------- ② 发卡 ---------------- */

  /** 勾了「不限制」→ 0（服务端 0 就是没有上限）；没勾 → 用户填的数。 */
  function issueField(inputId, unlimitedId, fallback) {
    if ($(unlimitedId).checked) return 0;
    const raw = Number($(inputId).value);
    if (!Number.isFinite(raw) || raw < 0) return fallback;
    return Math.trunc(raw);
  }

  /** 「不限制」勾上时，数字框禁用并写清"这个数现在不算数"（不让用户猜）。 */
  function bindUnlimitedPairs() {
    const pairs = [
      ["issueCalls", "issueCallsUnlimited"],
      ["issueTokens", "issueTokensUnlimited"],
      ["issueVoice", "issueVoiceUnlimited"],
      ["issueVoiceChars", "issueVoiceCharsUnlimited"],
      ["issueDays", "issueDaysNever"],
    ];
    const sync = () => {
      for (const [inputId, boxId] of pairs) {
        const input = $(inputId);
        const box = $(boxId);
        input.disabled = box.checked;
        input.title = box.checked ? "已勾「不限制」：这里的数字不算数" : "";
      }
      renderIssueSummary();
    };
    for (const [, boxId] of pairs) $(boxId).addEventListener("change", sync);
    sync();
  }

  function issueQuota() {
    return {
      calls: issueField("issueCalls", "issueCallsUnlimited", 50),
      tokens: issueField("issueTokens", "issueTokensUnlimited", 0),
      voice: issueField("issueVoice", "issueVoiceUnlimited", 0),
      voiceChars: issueField("issueVoiceChars", "issueVoiceCharsUnlimited", 0),
      days: issueField("issueDays", "issueDaysNever", 14),
    };
  }

  /** 发之前先把"这一批到底给了什么"写成一句人话 —— 发出去就是钱。 */
  function renderIssueSummary() {
    const quota = issueQuota();
    const count = Math.max(1, Number($("issueCount").value) || 1);
    const voiceBox = $("issueVoiceUnlimited");
    const charsBox = $("issueVoiceCharsUnlimited");
    const voiceUnlimited = !!(voiceBox && voiceBox.checked);
    const charsUnlimited = !!(charsBox && charsBox.checked);
    // 「不限额」和「未开放」必须分开写：填 0（或勾"不限制"）在服务端就是**不限**，
    // 写"不给"就正好说反了（文档 §12）。这两种状态各自说清，别用一个 0 混过去。
    const voiceBit = quota.voice > 0
      ? fmtNumber(quota.voice) + " 次"
      : (voiceUnlimited || charsUnlimited ? "不限额" : "未开放");
    const charsBit = quota.voiceChars > 0
      ? fmtNumber(quota.voiceChars) + " 字"
      : (voiceUnlimited || charsUnlimited ? "不限额" : "未开放");
    const parts = [
      "聊天 " + (quota.calls > 0 ? fmtNumber(quota.calls) + " 次" : "不限制"),
      "token " + (quota.tokens > 0 ? fmtNumber(quota.tokens) : "不限制"),
      "语音 " + voiceBit,
      "语音字数 " + charsBit,
      quota.days > 0 ? fmtNumber(quota.days) + " 天有效" : "不过期",
    ];
    $("issueSummary").textContent = "这一批 " + count + " 张：每张 " + parts.join(" · ")
      + "。语音额度是独立的一份，不吃聊天的次数（填 0 / 勾「不限制」= 不限额，不是「不给」）。";
  }

  async function issue() {
    const button = $("issueButton");
    const quota = issueQuota();
    const count = Math.max(1, Number($("issueCount").value) || 1);
    // **防重复提交**：请求带一个 requestId，本机服务对同一个 id 只执行一次 ——
    // 连点两下、或者浏览器超时后重试，都不会真的发出第二批卡。
    const requestId = "issue-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    const payload = Object.assign({ label: $("issueLabel").value.trim(), count: count, requestId: requestId }, quota);
    button.disabled = true;
    button.textContent = "正在发…";
    try {
      const data = await api("/api/issue", { method: "POST", body: payload });
      renderIssued(data);
      if (data.failures && data.failures.length) {
        toast("发出 " + data.cards.length + " 张，失败 " + data.failures.length + " 张（成功的卡在下面，已保留）", true);
      } else {
        toast("已发出 " + data.cards.length + " 张卡" + (data.replayed ? "（这是上一次的结果，没有重复发）" : ""));
      }
      await loadCards();
      await loadState();
      await loadUsage();
    } catch (error) {
      toast("发卡失败：" + error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "发卡";
    }
  }

  function renderIssued(data) {
    const box = $("issueResult");
    box.textContent = "";
    const list = (data && data.cards) || [];
    const failures = (data && data.failures) || [];
    if (!list.length && !failures.length) { box.hidden = true; return; }
    box.hidden = false;
    if (data.replayed) {
      const again = document.createElement("p");
      again.className = "banner warn";
      again.textContent = "这次请求和刚才那次是同一个（requestId 相同），所以直接把上次的结果还给你 —— 没有重复发卡。";
      box.appendChild(again);
    }
    if (list.length) {
      const title = document.createElement("p");
      title.className = "muted";
      title.textContent = "下面每段都可以直接转发给一个同学（卡号只在这里出现，别关掉页面再找）：";
      box.appendChild(title);
    }
    list.forEach((card, index) => {
      const item = document.createElement("div");
      item.className = "issue-item";
      const head = document.createElement("div");
      head.className = "actions";
      const name = document.createElement("strong");
      name.textContent = "第 " + (index + 1) + " 张 · " + (card.label || card.id);
      head.appendChild(name);

      const copyAll = document.createElement("button");
      copyAll.type = "button";
      copyAll.className = "btn primary";
      copyAll.textContent = "复制给同学的那段话";
      copyAll.addEventListener("click", () => copy(card.shareText, "（整段话）"));
      head.appendChild(copyAll);

      const copyLine = document.createElement("button");
      copyLine.type = "button";
      copyLine.className = "btn";
      copyLine.textContent = "只复制 卡号@中转";
      copyLine.addEventListener("click", () => copy(card.pasteLine, "（那一整行）"));
      head.appendChild(copyLine);

      // 2026-09-16 去掉「只复制一键链接」：用户实测那个链接会先撞腾讯云的"测试域名风险提醒"页，
      // 点过去之后卡还容易丢（片段不发给服务器），同学照着做反而更糊涂。
      // 现在只给「卡号」和「卡号@中转」两种可粘贴文本，应用第一步也改成了二选一，不再依赖链接。

      item.appendChild(head);
      const area = document.createElement("textarea");
      area.value = card.shareText;
      area.readOnly = true;
      area.spellcheck = false;
      item.appendChild(area);
      box.appendChild(item);
    });
    if (failures.length) {
      const fail = document.createElement("div");
      fail.className = "banner bad";
      fail.textContent = "有 " + failures.length + " 张没发成：" + failures.map((row) => "#" + row.index + " " + row.error).join("；");
      box.appendChild(fail);
      const keep = document.createElement("p");
      keep.className = "muted";
      keep.textContent = "已经成功的 " + list.length + " 张是真的发出去了（卡号在上面，先用这些）。"
        + "补发时**只补失败的那几张**（把张数改成 " + failures.length + "），不要重发一整批 —— 那会多发出几张卡。";
      box.appendChild(keep);
    }
  }

  /* ---------------- ⑤ 批量操作 ---------------- */

  function batchTargets() {
    const scope = $("batchScope").value;
    const rows = cards.slice();
    if (scope === "filtered") return visibleCards();
    if (scope === "low") return rows.filter((card) => statusOf(card).chat.key === "low" || statusOf(card).chat.key === "empty");
    if (scope === "expiring") {
      return rows.filter((card) => {
        const info = statusOf(card).expiry;
        return info.days !== null && info.days >= 0 && info.days <= 7;
      });
    }
    if (scope === "disabled") return rows.filter((card) => card.disabled);
    return [];
  }

  function batchPayload() {
    const payload = {};
    const pairs = [["batchCalls", "calls"], ["batchVoiceChars", "voiceChars"], ["batchDays", "days"]];
    for (const [inputId, key] of pairs) {
      const raw = String($(inputId).value || "").trim();
      if (raw === "") continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) return { error: "「" + key + "」要填一个不小于 0 的数字" };
      payload[key] = Math.trunc(num);
    }
    return { payload: payload };
  }

  function previewBatch() {
    batchRows = batchTargets();
    const action = $("batchAction").value;
    const result = $("batchResult");
    const parsed = batchPayload();
    if (parsed.error) { result.textContent = parsed.error; return; }
    const payload = parsed.payload;
    if (action === "extend" && !Object.keys(payload).length) {
      result.textContent = "「加额度 / 续期」至少要填一项（聊天次数 / 语音字数 / 再给几天）—— 否则点了等于什么都没做。";
      $("batchRun").disabled = true;
      return;
    }
    const names = batchRows.slice(0, 8).map((card) => card.label || card.id).join("、");
    const actionText = action === "extend"
      ? ("改额度：" + Object.entries(payload).map(([key, value]) => key + "=" + value).join(" / "))
      : (action === "disable" ? "停用（可恢复）" : "恢复启用");
    result.textContent = batchRows.length
      ? ("将影响 " + batchRows.length + " 张卡（" + names + (batchRows.length > 8 ? " 等" : "") + "）；动作：" + actionText + "。")
      : "当前条件下没有匹配的卡 —— 换一个「选哪些卡」，或者先调整搜索 / 筛选。";
    $("batchRun").disabled = !batchRows.length || (action === "extend" && !Object.keys(payload).length);
  }

  async function runBatch() {
    const action = $("batchAction").value;
    const parsed = batchPayload();
    if (parsed.error) { toast(parsed.error, true); return; }
    if (!batchRows.length) { toast("先点「查看影响」确认要改哪些卡", true); return; }
    const run = $("batchRun");
    run.disabled = true;
    const result = $("batchResult");
    const ok = [];
    const failed = [];
    for (const card of batchRows) {
      try {
        if (action === "extend") {
          await api("/api/card/" + encodeURIComponent(card.id) + "/extend", { method: "POST", body: parsed.payload });
        } else {
          await api("/api/card/" + encodeURIComponent(card.id) + "/" + (action === "disable" ? "disable" : "enable"), { method: "POST" });
        }
        ok.push(card.label || card.id);
      } catch (error) {
        failed.push((card.label || card.id) + "：" + error.message);
      }
    }
    // **部分失败照样把成功的留住**：成功的已经真的改了，界面必须如实说。
    result.textContent = "成功 " + ok.length + " 张" + (failed.length ? ("，失败 " + failed.length + " 张：" + failed.join("；") + "。失败的那几张可以再点一次「执行」（成功的不会被动第二次）") : "。");
    toast(failed.length ? ("批量完成：" + ok.length + " 成功 / " + failed.length + " 失败") : ("批量完成：" + ok.length + " 张"), failed.length > 0);
    await loadCards();
    previewBatch();
    run.disabled = false;
  }

  /* ---------------- 本机留底 / 自检 ---------------- */

  async function remember() {
    const token = $("rememberToken").value.trim();
    if (!token) return;
    try {
      const data = await api("/api/remember", { method: "POST", body: { token } });
      const info = data.info || {};
      $("rememberToken").value = "";
      toast(info.ok === false ? "已登记，但这张卡现在不可用：" + (info.reason || "") : "已登记：" + (info.label || token));
      await loadState();
      await loadCards();
    } catch (error) {
      toast("登记失败：" + error.message, true);
    }
  }

  async function sendText(token) {
    try {
      const data = await api("/api/text", { method: "POST", body: { token } });
      await copy(data.shareText, "（那段话）");
    } catch (error) {
      toast("生成失败：" + error.message, true);
    }
  }

  async function selftest(kind) {
    const label = $("selftestResult");
    label.textContent = "正在自检…";
    try {
      const data = await api("/api/selftest/" + kind);
      if (kind === "store") {
        label.textContent = (data.ok ? "账本 OK（" + data.kind + "，现有 " + data.cards + " 张卡）" : "账本有问题：" + (data.error || data.hint || ""));
      } else if (kind === "voice") {
        label.textContent = data.configured
          ? ("语音已配：资源 " + data.resourceId + "，音色 " + ((data.speakers || []).length) + " 个，单次上限 " + data.maxChars
            + " 字，并发 全局 " + (data.concurrency && data.concurrency.global) + " / 每卡 " + (data.concurrency && data.concurrency.perCard)
            + "。（这里只报「配没配」，不会真的去合成 —— 语音按字符计费。）")
          : ("语音没配全：缺 " + ((data.missing || []).join("、") || "凭据") + "。");
      } else {
        label.textContent = (data.ok ? "上游 OK（" + data.model + "，" + data.ms + "ms）：" + (data.reply || "") : "上游有问题：" + (data.error || data.body || ""));
      }
    } catch (error) {
      label.textContent = "自检失败：" + error.message;
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    $("issueButton").addEventListener("click", issue);
    $("refreshButton").addEventListener("click", () => {
      setBusy($("cardsSummary"), "正在读取…");
      loadState().catch((e) => toast(e.message, true));
      loadCards().catch((e) => { setBusy($("cardsSummary"), "读卡列表失败：" + e.message); toast("读卡列表失败：" + e.message, true); });
      loadUsage();
    });
    $("searchInput").addEventListener("input", renderCards);
    $("sortSelect").addEventListener("change", renderCards);
    $("filterSelect").addEventListener("change", renderCards);
    $("issueCount").addEventListener("input", renderIssueSummary);
    $("rememberButton").addEventListener("click", remember);
    $("selftestStore").addEventListener("click", () => selftest("store"));
    $("selftestUpstream").addEventListener("click", () => selftest("upstream"));
    $("selftestVoice").addEventListener("click", () => selftest("voice"));
    $("detailClose").addEventListener("click", closeDetail);
    $("batchPreview").addEventListener("click", previewBatch);
    $("batchRun").addEventListener("click", runBatch);
    $("batchAction").addEventListener("change", previewBatch);
    $("batchScope").addEventListener("change", previewBatch);
    for (const id of ["batchCalls", "batchVoiceChars", "batchDays"]) $(id).addEventListener("input", previewBatch);

    // 表格里的按钮是**每次重画**的，所以统一在 document 上代理（挂到具体元素上会失效）。
    document.addEventListener("click", (event) => {
      const detail = event.target.closest("[data-detail]");
      if (detail) {
        renderDetail(detail.dataset.detail).catch(() => {});
        return;
      }
      const toggle = event.target.closest("[data-toggle]");
      if (toggle) {
        const card = cards.find((one) => String(one.id) === String(toggle.dataset.toggle));
        if (card) setDisabled(card, !card.disabled);
      }
    });
    void sendText;
  }

  function boot() {
    if (!KEY) {
      $("bootError").hidden = false;
      $("bootError").textContent = "地址里没有 ?k=…：请用控制台启动时打印的那个完整地址打开（那是这次运行的钥匙）。";
      return;
    }
    bindEvents();
    bindUnlimitedPairs();
    setBusy($("cardsSummary"), "正在读取卡列表…");
    loadState().catch((error) => {
      $("bootError").hidden = false;
      $("bootError").textContent = "连不上本机控制台服务：" + error.message;
    });
    loadCards().catch((error) => {
      setBusy($("cardsSummary"), "读卡列表失败：" + error.message);
      toast("读卡列表失败：" + error.message, true);
    });
    loadUsage();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
