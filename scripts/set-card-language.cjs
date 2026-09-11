"use strict";

/*
 * set-card-language.cjs —— 给角色卡 PNG 补/改语言标记。
 *
 * 用法：
 *   node scripts/set-card-language.cjs <卡片.png> <zh|en>
 *
 * 只改 PNG 里那个 JSON 数据块（tEXt/iTXt 的 chara / ccv3），**不动图像本身**：
 * 逐块复制原 PNG，只把承载角色数据的那个块换掉，其余字节原样保留。
 * 改完会校验：新数据能解析、语言标记正确、IHDR/IDAT/IEND 与原文件一致。
 */

const fs = require("node:fs");
const path = require("node:path");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("不是 PNG 文件");
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data: Buffer.from(data) });
    offset += 12 + length;
  }
  return chunks;
}

function writeChunks(chunks) {
  const parts = [PNG_SIGNATURE];
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc32 = (buffer) => {
    let c = -1;
    for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  for (const chunk of chunks) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.data.length, 0);
    const type = Buffer.from(chunk.type, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, chunk.data])), 0);
    parts.push(length, type, chunk.data, crc);
  }
  return Buffer.concat(parts);
}

function readTextChunk(data) {
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  const keyword = data.subarray(0, nul).toString("latin1");
  const text = data.subarray(nul + 1).toString("utf8");
  return { keyword, text };
}

function makeTextChunk(keyword, text) {
  return Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "utf8")]);
}

function main() {
  const [, , file, language] = process.argv;
  if (!file || !["zh", "en"].includes(language)) {
    console.log("用法：node scripts/set-card-language.cjs <卡片.png> <zh|en>");
    process.exit(1);
  }
  const target = path.resolve(file);
  const original = fs.readFileSync(target);
  const chunks = readChunks(original);

  // 一张卡可能同时带 chara（V2）和 ccv3（V3）两个数据块，**两个都要改**：
  // 只改一个的话，读取方取到另一个，语言标记等于没写（这个坑当场踩过）。
  const dataChunks = chunks
    .map((chunk) => ({ chunk, parsed: chunk.type === "tEXt" || chunk.type === "iTXt" ? readTextChunk(chunk.data) : null }))
    .filter((row) => row.parsed && (row.parsed.keyword === "chara" || row.parsed.keyword === "ccv3"));
  if (!dataChunks.length) throw new Error("这张 PNG 里没有角色数据块（chara / ccv3）");

  const before = [];
  for (const row of dataChunks) {
    const card = JSON.parse(Buffer.from(row.parsed.text.trim(), "base64").toString("utf8"));
    // CCv3：语言标记在 data.extensions.task29.language。
    if (!card.data || typeof card.data !== "object") card.data = {};
    if (!card.data.extensions || typeof card.data.extensions !== "object") card.data.extensions = {};
    if (!card.data.extensions.task29 || typeof card.data.extensions.task29 !== "object") card.data.extensions.task29 = {};
    before.push(row.parsed.keyword + "=" + (card.data.extensions.task29.language || "无"));
    card.data.extensions.task29.language = language;
    // 顺带在顶层也写一份：老读取方（或手改的 JSON 卡）只认顶层字段。
    card.language = language;
    const payload = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
    row.chunk.data = makeTextChunk(row.parsed.keyword, payload);
  }
  const output = writeChunks(chunks);

  // 校验：结构块必须原样保留，新数据必须能读回来。
  const after = readChunks(output);
  for (const type of ["IHDR", "IDAT", "IEND"]) {
    const a = chunks.filter((chunk) => chunk.type === type).map((chunk) => chunk.data.toString("base64"));
    const b = after.filter((chunk) => chunk.type === type).map((chunk) => chunk.data.toString("base64"));
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("校验失败：" + type + " 被改动了");
  }
  for (const chunk of after) {
    if (chunk.type !== "tEXt" && chunk.type !== "iTXt") continue;
    const parsed = readTextChunk(chunk.data);
    if (!parsed || (parsed.keyword !== "chara" && parsed.keyword !== "ccv3")) continue;
    const card = JSON.parse(Buffer.from(parsed.text.trim(), "base64").toString("utf8"));
    if (card.data.extensions.task29.language !== language) {
      throw new Error("校验失败：" + parsed.keyword + " 块里的语言标记没写进去");
    }
  }

  fs.writeFileSync(target, output);
  console.log("已设置 " + path.basename(target) + " → language=" + language
    + "（原值 " + before.join("、") + "；图像字节未改动）");
}

main();
