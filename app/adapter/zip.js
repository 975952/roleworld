"use strict";

/*
 * adapter/zip.js —— 极简 ZIP 读写（无依赖）
 *
 * 用途：把整个本地存档（角色卡、聊天、世界书、设置、头像二进制）打包成一个 .zip
 * 文件，用户可以拷到另一台电脑/手机上再导入。
 *
 * 支持范围：
 *   写入 —— store（不压缩），兼容性最好，任何解压工具都能打开；
 *   读取 —— store（method 0）+ deflate（method 8，用浏览器内置 DecompressionStream）。
 * 不支持的：zip64、加密、分卷。这些在个人存档场景里不会出现。
 */

(function (global) {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8Encode(text) {
    return new global.TextEncoder().encode(text);
  }

  function utf8Decode(bytes) {
    return new global.TextDecoder("utf-8").decode(bytes);
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof input === "string") return utf8Encode(input);
    throw new Error("ZIP 条目内容必须是字符串或 Uint8Array");
  }

  // MS-DOS 时间戳，ZIP 格式要求。
  function dosDateTime(date) {
    const when = date instanceof Date ? date : new Date();
    const year = Math.max(1980, when.getFullYear());
    return {
      time: (when.getHours() << 11) | (when.getMinutes() << 5) | (Math.floor(when.getSeconds() / 2) & 0x1f),
      date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    };
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  /**
   * 打包 ZIP。
   * @param {Array<{name: string, data: string|Uint8Array}>} entries
   * @returns {Blob|Uint8Array} 浏览器里返回 Blob，其它环境返回 Uint8Array
   */
  function write(entries) {
    const stamp = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = utf8Encode(entry.name);
      const dataBytes = toBytes(entry.data);
      const crc = crc32(dataBytes);
      const local = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(local.buffer);
      writeUint32(localView, 0, 0x04034b50);
      writeUint16(localView, 4, 20);      // version needed
      writeUint16(localView, 6, 0x0800);  // UTF-8 文件名标志
      writeUint16(localView, 8, 0);       // method 0 = store
      writeUint16(localView, 10, stamp.time);
      writeUint16(localView, 12, stamp.date);
      writeUint32(localView, 14, crc);
      writeUint32(localView, 18, dataBytes.length);
      writeUint32(localView, 22, dataBytes.length);
      writeUint16(localView, 26, nameBytes.length);
      writeUint16(localView, 28, 0);
      local.set(nameBytes, 30);
      chunks.push(local, dataBytes);

      const header = new Uint8Array(46 + nameBytes.length);
      const headerView = new DataView(header.buffer);
      writeUint32(headerView, 0, 0x02014b50);
      writeUint16(headerView, 4, 20);     // version made by
      writeUint16(headerView, 6, 20);     // version needed
      writeUint16(headerView, 8, 0x0800);
      writeUint16(headerView, 10, 0);
      writeUint16(headerView, 12, stamp.time);
      writeUint16(headerView, 14, stamp.date);
      writeUint32(headerView, 16, crc);
      writeUint32(headerView, 20, dataBytes.length);
      writeUint32(headerView, 24, dataBytes.length);
      writeUint16(headerView, 28, nameBytes.length);
      writeUint16(headerView, 30, 0);
      writeUint16(headerView, 32, 0);
      writeUint16(headerView, 34, 0);
      writeUint16(headerView, 36, 0);
      writeUint32(headerView, 38, 0);
      writeUint32(headerView, 42, offset);
      header.set(nameBytes, 46);
      central.push(header);

      offset += local.length + dataBytes.length;
    });

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    writeUint32(endView, 0, 0x06054b50);
    writeUint16(endView, 8, entries.length);
    writeUint16(endView, 10, entries.length);
    writeUint32(endView, 12, centralSize);
    writeUint32(endView, 16, offset);

    const all = chunks.concat(central, [end]);
    const total = all.reduce((sum, part) => sum + part.length, 0);
    const flat = new Uint8Array(total);
    let cursor = 0;
    all.forEach((part) => { flat.set(part, cursor); cursor += part.length; });

    if (typeof global.Blob === "function") return new global.Blob([flat], { type: "application/zip" });
    return flat;
  }

  /**
   * 读取 ZIP，返回 Map<name, Uint8Array>。
   * @param {ArrayBuffer|Uint8Array} input
   */
  async function read(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 从尾部找中央目录结束记录（最多回退 64KB 以容纳注释）。
    let endOffset = -1;
    const floor = Math.max(0, bytes.length - 0x10000 - 22);
    for (let i = bytes.length - 22; i >= floor; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { endOffset = i; break; }
    }
    if (endOffset < 0) throw new Error("不是有效的 ZIP 文件");
    const count = view.getUint16(endOffset + 10, true);
    let cursor = view.getUint32(endOffset + 16, true);

    const files = new Map();
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = utf8Decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);
      files.set(name, { method, raw });

      cursor += 46 + nameLength + extraLength + commentLength;
    }

    const result = new Map();
    for (const [name, entry] of files) {
      if (name.endsWith("/")) continue;
      result.set(name, await inflateEntry(entry));
    }
    return result;
  }

  async function inflateEntry(entry) {
    if (entry.method === 0) return entry.raw;
    if (entry.method !== 8) throw new Error("ZIP 使用了不支持的压缩方式：" + entry.method);
    if (typeof global.DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持解压该 ZIP，请改用未压缩的存档文件");
    }
    const stream = new global.Blob([entry.raw]).stream().pipeThrough(new global.DecompressionStream("deflate-raw"));
    const buffer = await new global.Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  const Zip = { write, read, crc32, utf8Encode, utf8Decode };

  global.RoleWorldZip = Zip;
  if (typeof module !== "undefined" && module.exports) module.exports = Zip;
})(typeof globalThis !== "undefined" ? globalThis : this);
