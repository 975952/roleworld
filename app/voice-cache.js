"use strict";

/*
 * voice-cache.js —— 合成好的语音缓存（重复播放不再花钱）
 *
 * 为什么必须有：语音是**按字符计费**的。同一句「他点点头。」在同一条回复里
 * 被点两次朗读、或者用户来回切换又切回来，都不该再合成一次。
 *
 * 三条设计约束：
 *   ① **键要算全**：文本 + 音色 + 所有影响声音的参数 + 模型/资源标识 + 中转地址。
 *      漏掉任何一项都会出现"换了音色却还是旧声音"这种极难查的错。
 *   ② **有上限**：缓存不能无限长。按条数 + 字节数双上限，超了按"最久没用过"淘汰（LRU）。
 *   ③ **可以没有落盘**：拿不到 IndexedDB / 桌面文件系统时退化成内存缓存，
 *      功能照常（只是关掉应用就没了），绝不因为缓存坏了让朗读失败。
 *
 * 存的是 base64 而不是 Blob：这样浏览器（IndexedDB）、桌面端（JSON 文件）、
 * Node 测试（内存 Map）三边是**同一种记录形状**，不需要为后端写三份转换代码。
 */

(function (global) {
  /** 默认上限：80 条 / 24 MB。一句 10 秒的 mp3 大约 100–250 KB，够缓存几十句。 */
  const DEFAULT_LIMITS = Object.freeze({ entries: 80, bytes: 24 * 1024 * 1024 });
  const PREFIX = "voice:";

  /** 稳定散列（FNV-1a）：同一个输入永远同一个键，跨会话也一样。 */
  function hash(text) {
    let value = 2166136261;
    const source = String(text || "");
    for (let i = 0; i < source.length; i += 1) {
      value ^= source.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  /**
   * 缓存键。**每一项都影响声音**，少一项就会出现"换了音色还是旧声音"。
   *   text       要念的那句话（清理之后的）
   *   speaker    音色 id
   *   speechRate 语速（[-50,100]，0=正常）
   *   format     音频格式（mp3 / ogg_opus …）
   *   sampleRate 采样率
   *   model      上游模型（seed-tts-2.0-standard / -expressive 声音不一样）
   *   resourceId 资源标识（1.0/2.0 是两套声音）
   *   relay      中转地址（换一张卡/换一个中转，音色同名但可能不是同一个声音）
   */
  function cacheKey(parts) {
    const source = parts || {};
    const fields = [
      "text", "speaker", "speechRate", "format", "sampleRate", "model", "resourceId", "relay",
    ];
    const normalized = fields.map((field) => {
      const value = source[field];
      if (value === undefined || value === null || value === "") return field + "=";
      return field + "=" + String(value);
    }).join("\u0001");
    return PREFIX + hash(normalized);
  }

  function base64ToBlob(base64, type) {
    if (typeof global.atob !== "function" || typeof global.Blob !== "function") return null;
    try {
      const binary = global.atob(String(base64 || ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new global.Blob([bytes], { type: type || "audio/mpeg" });
    } catch (_) { return null; }
  }

  function blobToBase64(blob) {
    if (!blob) return Promise.resolve("");
    if (typeof blob.arrayBuffer === "function" && typeof global.btoa === "function") {
      return blob.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return global.btoa(binary);
      });
    }
    return Promise.resolve("");
  }

  /**
   * 建一个缓存。
   * options.store  —— { get(id), put(record), remove(id), list() }；不给就只用内存。
   *                   默认实现走 RoleWorldStore 的 voice 存储（浏览器 IndexedDB / 桌面普通文件）。
   * options.limits —— { entries, bytes }
   * options.now    —— 便于测试注入时间
   */
  function createVoiceCache(options) {
    const opts = options || {};
    const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
    const store = opts.store || adapterStore();
    const now = opts.now || (() => Date.now());
    // 内存这一层是**热缓存**：同一句话连着播两次不该去碰磁盘。
    const hot = new Map();
    const stats = { hits: 0, misses: 0, evicted: 0, wrote: 0 };

    async function get(key) {
      if (!key) return null;
      if (hot.has(key)) {
        const record = hot.get(key);
        record.usedAt = now();
        stats.hits += 1;
        return record;
      }
      let record = null;
      try { record = store ? await store.get(key) : null; } catch (_) { record = null; }
      if (!record || !record.base64) {
        stats.misses += 1;
        return null;
      }
      record.usedAt = now();
      hot.set(key, record);
      stats.hits += 1;
      // 更新使用时间（失败也没关系：淘汰只影响"淘汰谁"，不影响能不能播）。
      try { if (store) await store.put(record); } catch (_) { /* 忽略 */ }
      return record;
    }

    async function put(key, payload) {
      if (!key || !payload || !payload.base64) return null;
      const record = {
        id: key,
        base64: payload.base64,
        type: payload.type || "audio/mpeg",
        bytes: Number(payload.bytes) || Math.round(String(payload.base64).length * 0.75),
        chars: Number(payload.chars) || 0,
        speaker: payload.speaker || "",
        speechRate: Number(payload.speechRate) || 0,
        // 时长（秒，能算出来就算）：微信那样的语音气泡上要显示"3″"。
        seconds: Number(payload.seconds) || 0,
        // pinned：**被消息引用的语音不参与淘汰**。
        // 为什么现在就留这一档：微信式的语音消息是"留得住"的 —— 过三天再点还得能听，
        // 不能因为缓存被挤掉就重新花钱合成一遍。以后接语音消息时，
        // 只要给那条消息的缓存键 pin 一下即可，不用动存储层。
        pinned: payload.pinned === true,
        at: now(),
        usedAt: now(),
      };
      hot.set(key, record);
      try { if (store) await store.put(record); } catch (_) { /* 落盘失败不影响这次播放 */ }
      stats.wrote += 1;
      await prune();
      return record;
    }

    /** 读一遍全部记录（内存 + 落盘），供淘汰用。 */
    async function list() {
      const merged = new Map();
      if (store) {
        try {
          const rows = await store.list();
          for (const row of rows || []) if (row && row.id) merged.set(row.id, row);
        } catch (_) { /* 读不到就只按内存里的算 */ }
      }
      for (const [key, row] of hot.entries()) merged.set(key, row);
      return Array.from(merged.values());
    }

    /**
     * 超上限就按"最久没用过"淘汰。返回淘汰了几条。
     *
     * **被钉住（pinned）的记录不参与淘汰**：那是被消息引用的语音（微信式语音消息），
     * 过几天再点还得能听，不能因为缓存满了就没了。代价是：全被钉住时缓存会临时超上限 ——
     * 这是刻意选的（宁可多占点地方，也不能让用户点一条旧语音听不了）。
     */
    async function prune() {
      const rows = await list();
      const evictable = rows.filter((row) => row.pinned !== true);
      const totalBytes = rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
      const overCount = rows.length - limits.entries;
      if (overCount <= 0 && totalBytes <= limits.bytes) return 0;
      const ordered = evictable.slice().sort((a, b) => (Number(a.usedAt) || 0) - (Number(b.usedAt) || 0));
      let evicted = 0;
      let bytes = totalBytes;
      let count = rows.length;
      for (const row of ordered) {
        if (count <= limits.entries && bytes <= limits.bytes) break;
        count -= 1;
        bytes -= Number(row.bytes) || 0;
        hot.delete(row.id);
        try { if (store) await store.remove(row.id); } catch (_) { /* 删不掉也先算淘汰 */ }
        evicted += 1;
      }
      stats.evicted += evicted;
      return evicted;
    }

    async function clear() {
      hot.clear();
      if (store) {
        try { await store.clear(); } catch (_) { /* 忽略 */ }
      }
      return true;
    }

    async function stats_() {
      const rows = await list();
      return {
        entries: rows.length,
        bytes: rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0),
        limits,
        hits: stats.hits,
        misses: stats.misses,
        evicted: stats.evicted,
      };
    }

    return {
      get, put, list, prune, clear, stats: stats_,
      /** 直接拿一个能播的 Blob（拿不到就说清是"缓存里没有"还是"这个环境放不出音频"）。 */
      async getBlob(key) {
        const record = await get(key);
        if (!record) return null;
        const blob = base64ToBlob(record.base64, record.type);
        return blob || null;
      },
      limits,
      _hot: hot,
    };
  }

  /** 默认后端：RoleWorldStore 里的 voice 存储（浏览器 IndexedDB / 桌面普通文件 / 测试内存）。 */
  function adapterStore() {
    const store = global.RoleWorldStore;
    if (!store || typeof store.getVoiceRecord !== "function") return null;
    return {
      get: (id) => store.getVoiceRecord(id),
      put: (record) => store.putVoiceRecord(record),
      remove: (id) => store.removeVoiceRecord(id),
      list: () => store.listVoiceRecords(),
      clear: () => store.clearVoiceRecords(),
    };
  }
  const VoiceCache = {
    createVoiceCache,
    cacheKey,
    hash,
    base64ToBlob,
    blobToBase64,
    DEFAULT_LIMITS,
    PREFIX,
  };

  global.RoleWorldVoiceCache = VoiceCache;
  if (typeof module !== "undefined" && module.exports) module.exports = VoiceCache;
})(typeof globalThis !== "undefined" ? globalThis : this);
