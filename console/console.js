"use strict";

/*
 * console/console.js —— 体验卡控制台的界面逻辑（原生 DOM，无依赖）
 *
 * 它只跟**本机的控制台服务**说话（scripts/console.cjs）；发卡口令在本机服务里，页面拿不到。
 * 钥匙是地址栏上的 ?k=…：每次请求都放进 `x-rw-console` 头。
 */

(function () {
  const KEY = new URLSearchParams(location.search).get("k") || "";
  const $ = (id) => document.getElementById(id);
  let cards = [];
  let state = null;

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
    toast.timer = setTimeout(() => { node.hidden = true; }, 2600);
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

  /* ---------------- 状态与健康 ---------------- */

  async function loadState() {
    state = await api("/api/state");
    $("healthDot").className = "dot " + (state.health && state.health.ok ? "is-ok" : "is-bad");
    const bits = [];
    if (state.health && state.health.ok) {
      bits.push("中转正常 · 账本 " + (state.health.store || "?"));
      bits.push(state.health.upstreamKeySet ? "上游 key 已配" : "上游 key 没配");
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
  }

  /* ---------------- 卡列表 ---------------- */

  function statusOf(card) {
    const used = Number(card.used && card.used.calls) || 0;
    const cap = Number(card.quota && card.quota.calls) || 0;
    const left = cap > 0 ? cap - used : null;
    if (card.disabled) return { key: "disabled", label: "已停用", tone: "bad", left };
    if (card.expiresAt && Date.parse(card.expiresAt) < Date.now()) return { key: "expired", label: "已到期", tone: "bad", left };
    if (left !== null && left <= 0) return { key: "empty", label: "次数用完", tone: "bad", left };
    if (left !== null && left <= 3) return { key: "low", label: "剩 " + left + " 次", tone: "warn", left };
    return { key: "ok", label: "可用", tone: "ok", left };
  }

  function fmtDay(value) {
    if (!value) return "不过期";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    return date.toISOString().slice(0, 10) + (days >= 0 ? "（" + days + " 天）" : "");
  }

  function fmtTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
  }

  function visibleCards() {
    const keyword = $("searchInput").value.trim().toLowerCase();
    const alive = $("onlyAlive").checked;
    const sort = $("sortSelect").value;
    let rows = cards.slice();
    if (keyword) {
      rows = rows.filter((card) => [card.label, card.id, statusOf(card).label].join(" ").toLowerCase().indexOf(keyword) >= 0);
    }
    if (alive) rows = rows.filter((card) => { const s = statusOf(card).key; return s === "ok" || s === "low"; });
    rows.sort((a, b) => {
      if (sort === "used") return ((Number(b.used && b.used.calls) || 0) - (Number(a.used && a.used.calls) || 0));
      if (sort === "label") return String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
      const at = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
      const bt = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
      return at - bt;
    });
    return rows;
  }

  function renderCards() {
    const tbody = $("cardRows");
    tbody.textContent = "";
    const rows = visibleCards();
    for (const card of rows) {
      const status = statusOf(card);
      const tr = document.createElement("tr");
      if (status.key === "low") tr.className = "is-low";
      if (status.key === "disabled" || status.key === "expired" || status.key === "empty") tr.className = "is-dead";

      const cells = [
        card.label || "—",
        card.id,
        (Number(card.used && card.used.calls) || 0) + " / " + ((card.quota && card.quota.calls) || "∞"),
        String((card.used && card.used.tokens) || 0),
        fmtDay(card.expiresAt),
        fmtTime(card.lastUsedAt),
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }

      const statusCell = document.createElement("td");
      const tag = document.createElement("span");
      tag.className = "tag " + status.tone;
      tag.textContent = status.label;
      statusCell.appendChild(tag);
      tr.appendChild(statusCell);

      const actionCell = document.createElement("td");
      if (card.token) {
        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "btn";
        copyButton.textContent = "复制那段话";
        copyButton.addEventListener("click", () => sendText(card.token));
        actionCell.appendChild(copyButton);
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn";
      toggle.textContent = card.disabled ? "启用" : "停用";
      toggle.addEventListener("click", () => setDisabled(card, !card.disabled));
      actionCell.appendChild(toggle);

      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "btn danger";
      revoke.textContent = "吊销";
      revoke.addEventListener("click", () => revokeCard(card));
      actionCell.appendChild(revoke);

      tr.appendChild(actionCell);
      tbody.appendChild(tr);
    }
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8;
      td.className = "muted";
      td.textContent = cards.length ? "没有符合筛选条件的卡。" : "还没有发过卡。";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    const alive = cards.filter((card) => ["ok", "low"].indexOf(statusOf(card).key) >= 0).length;
    $("cardsSummary").textContent = "共 " + cards.length + " 张，其中还能用 " + alive + " 张。";
  }

  async function loadCards() {
    const data = await api("/api/cards");
    cards = data.cards || [];
    renderCards();
  }

  /* ---------------- 操作 ---------------- */

  async function issue() {
    const button = $("issueButton");
    const payload = {
      label: $("issueLabel").value.trim(),
      calls: Number($("issueCalls").value) || 0,
      tokens: Number($("issueTokens").value) || 0,
      days: Number($("issueDays").value) || 0,
      count: Number($("issueCount").value) || 1,
    };
    // 防手滑：发出去就是钱，按钮先按住 2 秒。
    button.disabled = true;
    button.textContent = "正在发…";
    try {
      const data = await api("/api/issue", { method: "POST", body: payload });
      renderIssued(data.cards || []);
      toast("已发出 " + (data.cards || []).length + " 张卡");
      await loadCards();
      await loadState();
    } catch (error) {
      toast("发卡失败：" + error.message, true);
    } finally {
      setTimeout(() => { button.disabled = false; button.textContent = "发卡"; }, 2000);
    }
  }

  function renderIssued(list) {
    const box = $("issueResult");
    box.textContent = "";
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    const title = document.createElement("p");
    title.className = "muted";
    title.textContent = "下面每段都可以直接转发给一个同学（卡号只在这里出现，别关掉页面再找）：";
    box.appendChild(title);

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

      const copyLink = document.createElement("button");
      copyLink.type = "button";
      copyLink.className = "btn";
      copyLink.textContent = "只复制一键链接";
      copyLink.addEventListener("click", () => {
        const line = String(card.shareText || "").split("\n").find((row) => row.indexOf("http") === 0) || "";
        copy(line, "（链接）");
      });
      head.appendChild(copyLink);

      item.appendChild(head);
      const area = document.createElement("textarea");
      area.value = card.shareText;
      area.readOnly = true;
      area.spellcheck = false;
      item.appendChild(area);
      box.appendChild(item);
    });
  }

  async function setDisabled(card, disabled) {
    try {
      await api("/api/card/" + encodeURIComponent(card.id) + "/" + (disabled ? "disable" : "enable"), { method: "POST" });
      toast("已" + (disabled ? "停用" : "启用") + "：" + (card.label || card.id));
      await loadCards();
    } catch (error) {
      toast("操作失败：" + error.message, true);
    }
  }

  async function revokeCard(card) {
    const name = card.label || card.id;
    if (!window.confirm("吊销「" + name + "」？\n\n这张卡会从账本里删掉，拿着它的人立刻用不了，且**不可恢复**。\n如果只是想暂时不让用，用「停用」就好。")) return;
    try {
      await api("/api/card/" + encodeURIComponent(card.id) + "/revoke", { method: "POST" });
      toast("已吊销：" + name);
      await loadCards();
      await loadState();
    } catch (error) {
      toast("吊销失败：" + error.message, true);
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

  async function selftest(kind) {
    const label = $("selftestResult");
    label.textContent = "正在自检…";
    try {
      const data = await api("/api/selftest/" + kind);
      if (kind === "store") {
        label.textContent = (data.ok ? "账本 OK（" + data.kind + "，现有 " + data.cards + " 张卡）" : "账本有问题：" + (data.error || data.hint || ""));
      } else {
        label.textContent = (data.ok ? "上游 OK（" + data.model + "，" + data.ms + "ms）：" + (data.reply || "") : "上游有问题：" + (data.error || data.body || ""));
      }
    } catch (error) {
      label.textContent = "自检失败：" + error.message;
    }
  }

  function boot() {
    if (!KEY) {
      $("bootError").hidden = false;
      $("bootError").textContent = "地址里没有 ?k=…：请用控制台启动时打印的那个完整地址打开（那是这次运行的钥匙）。";
      return;
    }
    $("issueButton").addEventListener("click", issue);
    $("refreshButton").addEventListener("click", () => { loadState().catch((e) => toast(e.message, true)); loadCards().catch((e) => toast(e.message, true)); });
    $("searchInput").addEventListener("input", renderCards);
    $("sortSelect").addEventListener("change", renderCards);
    $("onlyAlive").addEventListener("change", renderCards);
    $("rememberButton").addEventListener("click", remember);
    $("selftestStore").addEventListener("click", () => selftest("store"));
    $("selftestUpstream").addEventListener("click", () => selftest("upstream"));
    loadState().catch((error) => {
      $("bootError").hidden = false;
      $("bootError").textContent = "连不上本机控制台服务：" + error.message;
    });
    loadCards().catch((error) => toast("读卡列表失败：" + error.message, true));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
