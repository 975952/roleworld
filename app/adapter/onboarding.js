"use strict";

/*
 * adapter/onboarding.js —— 首次启动教程
 *
 * 只在第一次打开时弹一次；看完或跳过都算看过，之后不再打扰。
 * 想再看：设置 → 关于 →「再看一次教程」（RoleWorldOnboarding.show()）。
 *
 * 用标记存在本机设置里（跟着存档走），所以导出到新机器不会又弹一遍。
 */

(function (global) {
  const STYLE_ID = "roleworld-onboarding-style";
  const SEEN_KEY = "tutorial_seen";

  const STEPS = [
    {
      title: "欢迎使用角色世界",
      body: [
        "这是一个**完全本地**的角色对话应用：没有服务器、没有账号、没有遥测。",
        "角色卡、对话记录、记忆书、API Key 全部只存在这台设备上，谁也不会替你看到它们。",
        "代价只有一条：没人替你备份，换电脑前记得自己导出。",
      ],
    },
    {
      title: "先配一个模型",
      body: [
        "打开**设置 → 模型**，选服务商（DeepSeek 官方 / OpenAI / OpenRouter / 硅基流动），",
        "把 API Key 粘进去，点「测试连接」看到「连接正常」就可以了。",
        "想用自己电脑上的模型：服务商选**自定义 / 本地模型**，地址填 llama.cpp 或 Ollama 的 `/v1/chat/completions`，Key 留空。",
      ],
      action: "去配置模型",
    },
    {
      title: "已经装好 6 个角色",
      body: [
        "首次启动会自动安装内置内容包：6 张角色卡（Harry、Tom Riddle、Ron、Hermione、Ginny、Luna）和 4 本记忆书。",
        "不想要它们：在设置里停用该内容包，或者直接删掉程序目录下的 `packs/harry-potter` 文件夹。",
        "这些角色属于同人二次创作，仅供个人非商业使用。",
      ],
    },
    {
      title: "你的数据在哪",
      body: [
        "桌面版：`%APPDATA%\\app.roleworld.desktop\\data\\` —— 都是普通文件，可以直接拷走、用编辑器打开、甚至用 Git 管理。",
        "网页版：存在浏览器的本地数据库里。",
        "备份与迁移：**设置 → 关于 → 导出存档**，换电脑后「导入存档」即可。",
      ],
    },
    {
      title: "开始吧",
      body: [
        "直接在输入框打字就能聊天，回复会一个字一个字冒出来。",
        "想让 AI 帮你写角色卡：点输入框上方的角色名 → **AI 创建角色**，描述一下你想要的角色就行。",
        "想看多人同场演出：左上角的**剧情模式**。",
      ],
    },
  ];

  let overlay = null;
  let index = 0;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.rw-onboard-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
  justify-content:center;padding:20px;background:rgba(6,8,12,.72);backdrop-filter:blur(3px);}
.rw-onboard{width:min(560px,100%);max-height:min(78vh,640px);overflow:auto;border-radius:16px;
  border:1px solid var(--border,#2a3038);background:var(--surface,#141821);color:inherit;
  box-shadow:0 24px 60px rgba(0,0,0,.45);padding:26px 26px 20px;
  font:15px/1.75 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;}
.rw-onboard h2{margin:0 0 14px;font-size:19px;}
.rw-onboard p{margin:0 0 10px;color:var(--muted-text,#a8b0bd);}
.rw-onboard p strong{color:inherit;font-weight:600;}
.rw-onboard code{background:rgba(127,127,127,.18);border-radius:5px;padding:1px 5px;font-size:13px;}
.rw-onboard-dots{display:flex;gap:6px;margin:18px 0 16px;}
.rw-onboard-dots i{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.22;}
.rw-onboard-dots i.is-on{opacity:.85;}
.rw-onboard-actions{display:flex;gap:10px;align-items:center;}
.rw-onboard-actions .rw-grow{flex:1;}
.rw-onboard button{border-radius:10px;padding:8px 16px;font:inherit;font-size:14px;cursor:pointer;
  border:1px solid var(--border,#2a3038);background:transparent;color:inherit;}
.rw-onboard button.rw-primary{background:var(--accent,#6f8cff);border-color:transparent;color:#0b0e14;font-weight:600;}
.rw-onboard button:disabled{opacity:.4;cursor:default;}
.rw-onboard-link{background:none;border:none;padding:8px 4px;opacity:.7;text-decoration:underline;}
`;
    document.head.appendChild(style);
  }

  function render() {
    const step = STEPS[index];
    const last = index === STEPS.length - 1;
    const dots = STEPS.map((_, i) => `<i class="${i === index ? "is-on" : ""}"></i>`).join("");
    overlay.innerHTML = `
      <div class="rw-onboard" role="dialog" aria-modal="true" aria-label="${escapeHtml(step.title)}">
        <h2>${escapeHtml(step.title)}</h2>
        ${step.body.map((line) => `<p>${format(line)}</p>`).join("")}
        <div class="rw-onboard-dots" aria-hidden="true">${dots}</div>
        <div class="rw-onboard-actions">
          <button type="button" class="rw-onboard-link" data-rw="skip">跳过</button>
          <span class="rw-grow"></span>
          <button type="button" data-rw="prev" ${index === 0 ? "disabled" : ""}>上一步</button>
          ${step.action ? `<button type="button" data-rw="action">${escapeHtml(step.action)}</button>` : ""}
          <button type="button" class="rw-primary" data-rw="next">${last ? "开始使用" : "下一步"}</button>
        </div>
      </div>`;
    overlay.querySelector('[data-rw="skip"]').addEventListener("click", finish);
    overlay.querySelector('[data-rw="prev"]').addEventListener("click", () => {
      if (index > 0) { index -= 1; render(); }
    });
    overlay.querySelector('[data-rw="next"]').addEventListener("click", () => {
      if (last) finish();
      else { index += 1; render(); }
    });
    const actionButton = overlay.querySelector('[data-rw="action"]');
    if (actionButton) {
      actionButton.addEventListener("click", () => {
        finish();
        if (global.TASK25C_UI && typeof global.TASK25C_UI.openSettings === "function") {
          if (typeof global.TASK25C_UI.setSettingsSection === "function") global.TASK25C_UI.setSettingsSection("model");
          global.TASK25C_UI.openSettings();
        }
      });
    }
  }

  // 只支持 **加粗** 与 `代码`，其余按纯文本转义 —— 不引入 markdown 渲染器。
  function format(line) {
    return escapeHtml(line)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  async function finish() {
    close();
    try {
      if (global.RoleWorld && typeof global.RoleWorld.saveLocalSettings === "function") {
        await global.RoleWorld.saveLocalSettings({ [SEEN_KEY]: true });
      }
    } catch (_) { /* 存不下也不能卡住用户 */ }
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeydown, true);
  }

  function onKeydown(event) {
    if (!overlay) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); }
  }

  function show() {
    if (overlay) return;
    injectStyle();
    index = 0;
    overlay = document.createElement("div");
    overlay.className = "rw-onboard-backdrop";
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(); });
    // 挂进 appShell：界面缩放（zoom）加在它上面，弹窗才会跟着一起放大。
    (document.getElementById("appShell") || document.body).appendChild(overlay);
    document.addEventListener("keydown", onKeydown, true);
    render();
  }

  async function maybeShow() {
    try {
      if (!global.RoleWorld || typeof global.RoleWorld.getLocalSettings !== "function") return false;
      const settings = await global.RoleWorld.getLocalSettings();
      if (settings[SEEN_KEY] === true) return false;
    } catch (_) {
      return false;
    }
    show();
    return true;
  }

  // 等页面启动落定再弹，免得盖在启动遮罩上面。
  function schedule() {
    let done = false;
    const attempt = () => {
      if (done) return;
      if (global.TASK21_READY === true) {
        done = true;
        maybeShow();
        return;
      }
      window.setTimeout(attempt, 250);
    };
    attempt();
    // 兜底：启动失败（比如模型没配）时不该永远不弹。
    window.setTimeout(() => { if (!done) { done = true; maybeShow(); } }, 8000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }

  global.RoleWorldOnboarding = { show, maybeShow, steps: STEPS };
})(typeof globalThis !== "undefined" ? globalThis : this);
