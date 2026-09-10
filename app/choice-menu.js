"use strict";

// Keep existing select/change contracts while presenting text-only choices.
(() => {
  let active = null;
  let serial = 0;
  const close = (restore = false) => {
    if (!active) return;
    const { trigger, menu } = active;
    active = null;
    menu.remove();
    trigger.setAttribute("aria-expanded", "false");
    if (restore) trigger.focus();
  };
  function enhance(select) {
    if (select.dataset.choiceMenu) return;
    select.dataset.choiceMenu = "true";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "choice-trigger";
    trigger.id = `choice-trigger-${++serial}`;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const label = select.getAttribute("aria-label") || select.closest("label")?.querySelector("strong")?.textContent || "选择选项";
    const caption = document.createElement("span");
    caption.className = "choice-caption";
    const chevron = document.createElement("span");
    chevron.className = "choice-chevron";
    chevron.setAttribute("aria-hidden", "true");
    trigger.append(caption, chevron);
    select.after(trigger);
    select.hidden = true;
    // Labels should focus the visible control, not the retained hidden select.
    for (const node of select.labels || []) {
      if (node.htmlFor === select.id) node.htmlFor = trigger.id;
    }
    function sync() {
      caption.textContent = select.selectedOptions[0]?.textContent || "请选择";
      trigger.disabled = select.disabled;
      trigger.title = select.title || caption.textContent;
      trigger.setAttribute("aria-label", `${label}：${caption.textContent}`);
    }
    // Existing settings code also writes .value without dispatching change.
    for (const key of ["value", "selectedIndex"]) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
      if (!descriptor?.set) continue;
      Object.defineProperty(select, key, {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, value); sync(); }
      });
    }
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
    select.addEventListener("change", sync);
    sync();

    function open(last = false) {
      if (active?.trigger === trigger) { close(true); return; }
      close();
      sync();
      const menu = document.createElement("div");
      menu.id = `choice-list-${serial++}`;
      menu.className = "choice-menu";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", label);
      trigger.setAttribute("aria-controls", menu.id);
      const items = [];
      [...select.options].forEach(option => {
        if (option.hidden) return;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "choice-option";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(option.selected));
        item.disabled = option.disabled || option.parentElement?.disabled === true;
        item.textContent = option.textContent;
        item.addEventListener("click", () => {
          select.value = option.value;
          close(true);
          select.dispatchEvent(new Event("change", { bubbles: true }));
          sync();
        });
        menu.append(item);
        if (!item.disabled) items.push(item);
      });
      document.body.append(menu);
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width || innerWidth;
      const height = viewport?.height || innerHeight;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      menu.style.maxWidth = `${width - 24}px`;
      menu.style.width = `${Math.min(Math.max(rect.width, 260), width - 24)}px`;
      const below = top + height - rect.bottom - 16;
      const above = rect.top - top - 16;
      const down = below >= Math.min(menu.scrollHeight, 280) || below >= above;
      menu.style.maxHeight = `${Math.max(60, down ? below : above)}px`;
      menu.style.left = `${Math.max(left + 12, Math.min(rect.right - menu.offsetWidth, left + width - menu.offsetWidth - 12))}px`;
      menu.style.top = `${down ? rect.bottom + 8 : Math.max(top + 12, rect.top - menu.offsetHeight - 8)}px`;
      active = { trigger, menu };
      trigger.setAttribute("aria-expanded", "true");
      const selected = items.find(item => item.getAttribute("aria-selected") === "true");
      (last ? items.at(-1) : selected || items[0])?.focus({ preventScroll: true });
      let query = "", queryTimer;
      menu.addEventListener("keydown", event => {
        const index = items.indexOf(document.activeElement);
        let next;
        if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
        if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
        if (event.key === "Home") next = items[0];
        if (event.key === "End") next = items.at(-1);
        if (event.key === "Escape") { event.preventDefault(); close(true); }
        if (event.key === "Tab") close(true);
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== " ") {
          query += event.key.toLocaleLowerCase();
          clearTimeout(queryTimer);
          queryTimer = setTimeout(() => { query = ""; }, 700);
          next = items.find(item => item.textContent.toLocaleLowerCase().startsWith(query));
        }
        if (next) { event.preventDefault(); next.focus(); }
      });
    }
    trigger.addEventListener("click", () => open());
    trigger.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); open(event.key === "ArrowUp");
      }
    });
  }
  document.querySelectorAll(".settings-surface select, #chatModelSelect, .memory-modal select").forEach(enhance);
  document.addEventListener("pointerdown", event => {
    if (active && !active.menu.contains(event.target) && !active.trigger.contains(event.target)) close();
  });
  window.addEventListener("resize", () => close());
  window.visualViewport?.addEventListener("resize", () => close());
  document.addEventListener("scroll", event => {
    if (active && !active.menu.contains(event.target)) close();
  }, true);
  window.addEventListener("roleworld:scale-changed", () => close());
})();
