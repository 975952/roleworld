"use strict";

/*
 * overscroll.js —— 上拉 / 下拉回弹（QQ 那种"橡皮筋"）
 *
 * 用户口径（原 ③ 里一直没做的那一半）：「加 QQ 那种上拉下拉回弹」。
 * 2026-09-18 补上：滚到顶还能再往下拽一点、滚到底还能再往上推一点，松手弹回去。
 *
 * 为什么是 JS 而不是纯 CSS：
 *   Chromium 里**内层滚动容器没有** iOS 那种 rubber-band。`overscroll-behavior` 只能表达
 *   "滚到头之后要不要把滚动传给父层"，画不出"再多走一点、松手弹回来"。
 *   所以自己接 touch：到边之后按阻尼位移内容，松手用一次 transition 弹回。
 *
 * 两条硬口径（用例钉住）：
 *   ① 开了「设置 → 外观 → 动效：减少」（`html[data-motion="reduced"]`）或系统
 *      `prefers-reduced-motion: reduce` 时**一点都不回弹** —— 连一个 transform 都不写
 *      （不是"缩到 10ms"，是压根不做，免得还剩一帧抖动）；
 *   ② 只在**真的到边、而且方向是继续往外拽**时才动手，并且只有那种时候才 preventDefault。
 *      正常滚动一个像素都不碰 —— 否则会把整页滚动卡死（这类改动最容易出的就是这种事故）。
 *
 * 出口（自检用，全是真身）：`window.RoleWorldOverscroll` 的 `enabled()` / `maxPull` / `attachAll()`。
 */
(function () {
  /** 最多能拽出多少 px（阻尼之后的上限）。 */
  var MAX_PULL = 56;
  /** 阻尼：手指走 100px，内容只走 42px。 */
  var RESIST = 0.42;
  /** 弹回时长，与 --panel-motion 一个量级。 */
  var SPRING_MS = 320;

  /**
   * 要接的滚动容器。
   * ⚠ 只放**真的会滚**的那些：`.chat-scroll`（聊天区）、设置页、角色面板、
   *   记忆书、本次请求面板、语音底部面板、两个弹窗。
   */
  var SELECTOR = [
    ".chat-scroll",
    ".settings-layout",
    ".inspector-view",
    ".character-pane",
    ".history-groups",
    ".request-peek-body",
    ".rw-voice-sheet",
    ".memory-modal",
    ".confirm-dialog",
  ].join(",");

  var state = new WeakMap();

  /** 「动效：减少」或系统级 reduced-motion —— 两条任一条成立就不回弹。 */
  function reduced() {
    if (document.documentElement.dataset.motion === "reduced") return true;
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  /** 阻尼曲线：拽得越远越沉，到 MAX_PULL 封顶。 */
  function damp(dy) {
    var over = Math.abs(dy) * RESIST;
    var capped = Math.min(MAX_PULL, over);
    return dy < 0 ? -capped : capped;
  }

  function clearTransform(el) {
    el.style.transition = "";
    el.style.transform = "";
  }

  function bind(el) {
    if (!el || state.has(el)) return;
    var st = { startY: 0, pull: 0, active: false };
    state.set(el, st);

    el.addEventListener("touchstart", function (event) {
      if (reduced() || !event.touches || event.touches.length !== 1) return;
      st.active = true;
      st.startY = event.touches[0].clientY;
      st.pull = 0;
    }, { passive: true });

    el.addEventListener("touchmove", function (event) {
      if (!st.active || reduced() || !event.touches || event.touches.length !== 1) return;
      var dy = event.touches[0].clientY - st.startY;
      var atTop = el.scrollTop <= 0;
      var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      var outward = (atTop && dy > 0) || (atBottom && dy < 0);
      if (!outward) {
        // 手指往回走 / 其实没到边：把刚才那点位移放开，交回给正常滚动。
        if (st.pull) { st.pull = 0; clearTransform(el); }
        return;
      }
      st.pull = damp(dy);
      el.style.transition = "none";
      el.style.transform = "translate3d(0, " + st.pull.toFixed(1) + "px, 0)";
      // 只有"确实在往外拽"的时候才拦默认行为 —— 正常滚动时这一句不会执行。
      if (event.cancelable) event.preventDefault();
    }, { passive: false });

    function release() {
      if (!st.active) return;
      st.active = false;
      if (!st.pull) return;
      st.pull = 0;
      el.style.transition = "transform " + SPRING_MS + "ms cubic-bezier(.22, 1, .36, 1)";
      el.style.transform = "";
      window.setTimeout(function () {
        el.style.transition = "";
      }, SPRING_MS + 40);
    }
    el.addEventListener("touchend", release, { passive: true });
    el.addEventListener("touchcancel", release, { passive: true });
  }

  /** 把当前文档里所有该接的容器接上（幂等；面板是静态节点，开机接一次就够）。 */
  function attachAll() {
    var nodes = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i += 1) bind(nodes[i]);
    return nodes.length;
  }

  window.RoleWorldOverscroll = {
    attachAll: attachAll,
    /** 现在到底回不回弹（用例与真机排查都看这一处判据，不许在别处再判一次）。 */
    enabled: function () { return !reduced(); },
    maxPull: MAX_PULL,
    selector: SELECTOR,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { attachAll(); }, { once: true });
  } else {
    attachAll();
  }
})();
