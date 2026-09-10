"use strict";

/*
 * adapter/archive-ui.js —— 存档导出 / 导入
 *
 * 本地应用没有云同步，换设备只能靠文件搬。这里提供最小的两个动作：
 *   data-roleworld="export"   导出全部数据为一个 .zip
 *   data-roleworld="import"   从 .zip 恢复（可选是否先清空现有数据）
 *   data-roleworld="archive-status"  结果文案
 *   data-roleworld="wipe"     清空本机全部数据（二次确认）
 */

(function (global) {
  const Zip = global.RoleWorldZip;

  function pick(name) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-roleworld="' + name + '"]'));
  }

  function setStatus(text, isError) {
    pick("archive-status").forEach((node) => {
      node.textContent = text;
      node.classList.toggle("is-error", !!isError);
    });
  }

  function stamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      "-" + pad(now.getHours()) + pad(now.getMinutes());
  }

  function download(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function exportAll() {
    const adapter = global.RoleWorld;
    if (!adapter) return;
    setStatus("正在打包…", false);
    try {
      const dump = await adapter.exportArchive();
      const entries = [{ name: "roleworld.json", data: JSON.stringify(dump) }];
      // 头像等二进制单独放，避免把 JSON 撑得过大。
      for (const entry of dump.blobs || []) {
        entries.push({ name: "blobs/" + safeName(entry.id), data: base64ToBytes(entry.base64) });
      }
      const zip = Zip.write(entries);
      download(zip, "roleworld-" + stamp() + ".zip");
      setStatus("已导出 " + (dump.data.characters || []).length + " 个角色、" +
        (dump.data.chats || []).length + " 段对话。", false);
    } catch (error) {
      setStatus("导出失败：" + (error && error.message ? error.message : error), true);
    }
  }

  async function importFile(file) {
    const adapter = global.RoleWorld;
    if (!adapter || !file) return;
    setStatus("正在导入…", false);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const files = await Zip.read(bytes);
      const main = files.get("roleworld.json");
      if (!main) throw new Error("这个压缩包里没有 roleworld.json");
      const dump = JSON.parse(Zip.utf8Decode(main));
      for (const entry of dump.blobs || []) {
        const raw = files.get("blobs/" + safeName(entry.id));
        if (raw) entry.base64 = bytesToBase64(raw);
      }
      const counts = await adapter.importArchive(dump, { mode: "replace" });
      setStatus("导入完成：角色 " + counts.characters + "、对话 " + counts.chats + "、记忆书 " + counts.worlds + "。", false);
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setStatus("导入失败：" + (error && error.message ? error.message : error), true);
    }
  }

  async function wipe() {
    const adapter = global.RoleWorld;
    if (!adapter) return;
    if (!window.confirm("确定要清空本机的全部角色、对话与记忆书吗？此操作不可撤销。")) return;
    await adapter.resetAll();
    setStatus("已清空。", false);
    setTimeout(() => window.location.reload(), 800);
  }

  function safeName(id) {
    return String(id).replace(/[\\/:*?"<>|]/g, "_");
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bind() {
    pick("export").forEach((node) => node.addEventListener("click", exportAll));
    pick("wipe").forEach((node) => node.addEventListener("click", wipe));
    // 「关于」面板里的「再看一次教程」由 onboarding.js 提供，这里只负责接线。
    pick("tutorial").forEach((node) => node.addEventListener("click", () => {
      if (global.RoleWorldOnboarding && typeof global.RoleWorldOnboarding.show === "function") {
        global.RoleWorldOnboarding.show();
      }
    }));
    pick("import").forEach((node) => {
      if (node.tagName === "INPUT") {
        node.addEventListener("change", () => {
          const file = node.files && node.files[0];
          node.value = "";
          if (file) importFile(file);
        });
      } else {
        node.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".zip,application/zip";
          input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (file) importFile(file);
          });
          input.click();
        });
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }

  global.RoleWorldArchiveUI = { exportAll, importFile, wipe };
})(typeof globalThis !== "undefined" ? globalThis : this);
