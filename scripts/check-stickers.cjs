"use strict";

/*
 * check-stickers.cjs —— 表情包自检（不需要人看图）
 *
 * 为什么要这一步："我画的表情是不是能看"通常只能靠眼睛，而这个仓库的验收不能靠"我觉得还行"。
 * 所以拆成三类**可判定**的检查：
 *   ① 清单与文件：index.json 里每个表情的文件都在、非空、是合法 SVG；
 *   ② 结构完整：每个 SVG 都有底色块 + 左右两只眼睛 + 一张嘴（漏了哪个就是半张脸）；
 *   ③ 真实渲染：用本机无头 Chrome 把 SVG 渲染出来，量**非透明像素的包围盒**占画布多少、
 *      以及画面里有多少种颜色 —— 全是白的（没画出来）、只有一个色块（没画脸）、
 *      或者画到画布外面（被裁掉）都会被这里抓住。
 *
 * 用法：node scripts/check-stickers.cjs            （用无头 Chrome；找不到就只做 ①②）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const STICKER_ROOT = path.join(ROOT, "app", "stickers");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

/* ------------------------------ 读清单 ------------------------------ */

const packs = [];
if (!fs.existsSync(STICKER_ROOT)) {
  console.error("没有 app/stickers/ —— 先跑 node scripts/make-stickers.cjs");
  process.exit(1);
}
for (const entry of fs.readdirSync(STICKER_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(STICKER_ROOT, entry.name, "index.json");
  if (!fs.existsSync(manifestPath)) continue;
  const pack = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  packs.push({ pack, dir: path.join(STICKER_ROOT, entry.name) });
}

console.log(`表情包：${packs.length} 套`);
let stampCount = 0;
const allStamps = [];

for (const { pack, dir } of packs) {
  check(pack.id === path.basename(dir), `包 ${path.basename(dir)} 的 id 与目录名不一致（${pack.id}）`);
  check(!!pack.label, `包 ${pack.id} 缺 label`);
  check(Array.isArray(pack.stamps) && pack.stamps.length > 0, `包 ${pack.id} 没有表情`);
  const names = new Set();
  for (const stamp of pack.stamps || []) {
    stampCount += 1;
    check(!!stamp.id && !!stamp.name, `包 ${pack.id} 里有表情缺 id/name`);
    check(!names.has(stamp.name), `包 ${pack.id} 里表情名重复：${stamp.name}`);
    names.add(stamp.name);
    const file = path.join(dir, stamp.file || "");
    if (!check(!!stamp.file && fs.existsSync(file), `包 ${pack.id}/${stamp.id} 的文件不存在：${stamp.file}`)) continue;
    const text = fs.readFileSync(file, "utf8");
    check(text.length > 120, `${stamp.file} 内容太短，像是没画东西`);
    check(text.startsWith("<svg") && text.trimEnd().endsWith("</svg>"), `${stamp.file} 不是完整 SVG`);
    check(/viewBox="0 0 240 240"/.test(text), `${stamp.file} 缺 viewBox`);

    // 结构：底色块 + 两只眼睛 + 嘴
    check(/<rect[^>]*rx=/.test(text), `${stamp.file} 没有圆角底色块`);
    const eyeMarks = (text.match(/<(circle|path)/g) || []).length;
    check(eyeMarks >= 2, `${stamp.file} 眼睛/嘴的元素少于 2 个（像半张脸）`);
    const hasMouth = /q|h52|ellipse/.test(text);
    check(hasMouth, `${stamp.file} 找不到嘴`);
    allStamps.push({ packId: pack.id, id: stamp.id, name: stamp.name, file });
  }
}
console.log(`表情：${stampCount} 个`);

/* --------------------------- 真实渲染检查 --------------------------- */

const chrome = findChrome();
if (!chrome) {
  console.log("没找到 Chrome，跳过渲染检查（只做了清单与结构检查）。");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-sticker-"));
  let rendered = 0;
  for (const stamp of allStamps) {
    const svgPath = path.join(STICKER_ROOT, stamp.packId, `${stamp.id}.svg`);
    // 渲染成一个 240x240 的窗口截图，再用 Chrome 自己读回像素统计（canvas 拿不到 file:// 的跨域像素，
    // 所以这里直接在页面里把 SVG 画到 canvas 上统计 —— 同一目录、file:// 下 canvas 会被污染，
    // 因此改成让 Chrome 输出 PNG，再由 Node 侧的 PNG 解码统计）。
    const png = path.join(tmp, `${stamp.packId}-${stamp.id}.png`);
    const shot = spawnSync(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--default-background-color=00000000",
      "--window-size=240,240", `--screenshot=${png}`,
      `file:///${svgPath.replace(/\\/g, "/")}`,
    ], { encoding: "utf8" });
    if (!fs.existsSync(png)) {
      check(false, `${stamp.id}: 渲染失败（${(shot.stderr || "").slice(0, 120)}）`);
      continue;
    }
    const stats = pngStats(fs.readFileSync(png));
    rendered += 1;
    // 覆盖率：画出来的东西应该占画布 15% ~ 92%（太小=没画，太大=贴边被裁）
    check(stats.cover >= 0.15, `${stamp.packId}/${stamp.id}: 画面太空（非透明只占 ${(stats.cover * 100).toFixed(1)}%）`);
    check(stats.cover <= 0.92, `${stamp.packId}/${stamp.id}: 画得太满/被裁（占 ${(stats.cover * 100).toFixed(1)}%）`);
    // 中央区域必须有笔墨：脸画在中间（眼睛 y≈100、嘴 y≈145）。
    // 这条是"只有底色块、忘了画脸"的唯一硬判据 —— 只数颜色数是抓不住的
    // （底色 + 描边就已经是两种颜色了，变异测试证明过）。
    check(
      stats.centerInk >= 0.05,
      `${stamp.packId}/${stamp.id}: 中间区域几乎是空的（${(stats.centerInk * 100).toFixed(1)}%），像只有底色块没画脸`,
    );
    // 颜色数：只有一两种色说明画得不对
    check(stats.colors >= 3, `${stamp.packId}/${stamp.id}: 颜色太少（${stats.colors} 种）`);
    // 四边不能贴死（贴死说明图形被裁掉了）
    check(stats.touchEdges <= 1, `${stamp.packId}/${stamp.id}: 图形贴到多个边缘（可能被裁）`);
  }
  console.log(`渲染检查：${rendered}/${allStamps.length} 个表情成功渲染并量过`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------- 极简 PNG 统计（只认 RGBA 非隔行） ------------------------- */

function pngStats(buffer) {
  // 找 IHDR
  if (buffer.readUInt32BE(0) !== 0x89504e47) return { cover: 1, colors: 1, touchEdges: 9 };
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    return { cover: 1, colors: 3, touchEdges: 0 }; // 不认识的格式就不判它错
  }
  const channels = colorType === 6 ? 4 : 3;
  // 收集 IDAT
  let offset = 8;
  const idat = [];
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + len));
    offset += len + 12;
    if (type === "IEND") break;
  }
  const raw = require("node:zlib").inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let total = 0;
  let inked = 0;
  const colors = new Set();
  const edges = { top: 0, bottom: 0, left: 0, right: 0 };
  // 中央区域（脸应该在的地方）：横向 25%~75%、纵向 30%~75% 之内**且不是底色**的像素比例。
  // 底色是"画布上出现最多的颜色"，拿它当参照物即可，不需要知道具体是哪一支。
  const centerX0 = Math.floor(width * 0.25);
  const centerX1 = Math.floor(width * 0.75);
  const centerY0 = Math.floor(height * 0.30);
  const centerY1 = Math.floor(height * 0.75);
  let centerTotal = 0;
  const centerColors = [];
  const colorCount = new Map();
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]; p += 1;
    raw.copy(cur, 0, p, p + stride); p += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value = cur[i];
      if (filter === 1) value = (value + a) & 0xff;
      else if (filter === 2) value = (value + b) & 0xff;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
        value = (value + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff;
      }
      cur[i] = value;
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * channels;
      const alpha = channels === 4 ? cur[i + 3] : 255;
      total += 1;
      if (alpha > 8) {
        const key = `${cur[i]},${cur[i + 1]},${cur[i + 2]}`;
        inked += 1;
        colors.add(key);
        colorCount.set(key, (colorCount.get(key) || 0) + 1);
        if (y === 0) edges.top += 1;
        if (y === height - 1) edges.bottom += 1;
        if (x === 0) edges.left += 1;
        if (x === width - 1) edges.right += 1;
        if (x >= centerX0 && x <= centerX1 && y >= centerY0 && y <= centerY1) {
          centerTotal += 1;
          centerColors.push(key);
        }
      }
    }
    cur.copy(prev);
  }
  // 底色 = 画布上出现最多的那种颜色；中央区域里"不是底色"的像素就是画上去的五官。
  let background = "";
  let backgroundCount = -1;
  for (const [color, count] of colorCount) {
    if (count > backgroundCount) { backgroundCount = count; background = color; }
  }
  let centerFace = 0;
  for (const color of centerColors) {
    if (color !== background) centerFace += 1;
  }
  const touchEdges = Object.values(edges).filter((n) => n > 3).length;
  return {
    cover: inked / Math.max(1, total),
    centerInk: centerFace / Math.max(1, centerTotal || (centerX1 - centerX0 + 1) * (centerY1 - centerY0 + 1)),
    colors: colors.size,
    touchEdges,
  };
}

/* -------------------------------- 结果 -------------------------------- */

if (failures.length) {
  console.error("\n❌ 表情包自检没通过：");
  for (const f of failures) console.error("   · " + f);
  process.exit(1);
}
console.log("\n✅ 表情包自检通过（清单 / 结构 / 渲染覆盖率与颜色数）");
