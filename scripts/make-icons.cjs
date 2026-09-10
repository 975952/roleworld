"use strict";

/*
 * make-icons.cjs —— 生成应用图标（无依赖）
 *
 * Tauri 打包需要 PNG 与 .ico。这里直接按像素画一个简单图标：
 * 深色圆角底 + 渐变光晕 + 两个对话气泡，然后用 zlib 编码成 PNG，
 * 再把 PNG 塞进 ICO 容器（Vista 以后允许 ICO 直接内嵌 PNG）。
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = path.join(__dirname, "..", "src-tauri", "icons");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
    const offset = (y * size + x) * 4;
    const alpha = Math.min(1, a);
    pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + r * alpha);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - alpha) + g * alpha);
    pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - alpha) + b * alpha);
    pixels[offset + 3] = Math.max(pixels[offset + 3], Math.round(255 * alpha));
  };

  // 圆角矩形覆盖度（4x4 超采样，边缘不毛糙）
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits += 1;
        }
      }
      if (!hits) continue;
      const cover = hits / 16;
      const t = (x / size) * 0.6 + (y / size) * 0.4;
      const glow = Math.max(0, 1 - Math.hypot(x / size - 0.72, y / size - 0.28) * 1.7);
      const r = 18 + 40 * t + 60 * glow;
      const g = 20 + 34 * t + 52 * glow;
      const b = 30 + 60 * t + 150 * glow;
      put(x, y, r, g, b, cover);
    }
  }

  // 对话气泡：两个圆角方块，下面那个错开一点
  const bubble = (bx, by, bw, bh, alpha) => {
    const rad = bh / 2;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const cx = Math.min(Math.max(px, bx + rad), bx + bw - rad);
        const cy = Math.min(Math.max(py, by + rad), by + bh - rad);
        if (Math.hypot(px - cx, py - cy) <= rad) put(x, y, 245, 247, 255, alpha);
      }
    }
  };
  bubble(size * 0.24, size * 0.30, size * 0.40, size * 0.115, 0.95);
  bubble(size * 0.40, size * 0.50, size * 0.36, size * 0.115, 0.62);

  // 气泡外圈做一点柔和过渡，避免边缘生硬
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 0 && pixels[i + 3] < 255) {
      const alpha = pixels[i + 3] / 255;
      pixels[i] = Math.round(pixels[i] / alpha);
      pixels[i + 1] = Math.round(pixels[i + 1] / alpha);
      pixels[i + 2] = Math.round(pixels[i + 2] / alpha);
    }
  }

  return pixels;
}

function encodeIco(pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngBuffers.length, 4);
  const entries = [];
  let offset = 6 + pngBuffers.length * 16;
  pngBuffers.forEach(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  });
  return Buffer.concat([header, ...entries, ...pngBuffers.map((item) => item.data)]);
}

fs.mkdirSync(OUT, { recursive: true });

const sizes = [32, 128, 256, 512];
const rendered = sizes.map((size) => ({ size, data: encodePng(size, draw(size)) }));

const write = (name, buffer) => {
  fs.writeFileSync(path.join(OUT, name), buffer);
  console.log(`${name}  ${buffer.length} 字节`);
};

write("32x32.png", rendered[0].data);
write("128x128.png", rendered[1].data);
write("128x128@2x.png", rendered[2].data);
write("icon.png", rendered[3].data);
write("icon.ico", encodeIco([
  { size: 32, data: rendered[0].data },
  { size: 128, data: rendered[1].data },
  { size: 256, data: rendered[2].data },
]));
console.log("图标已生成到 src-tauri/icons");
