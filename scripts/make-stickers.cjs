"use strict";

/*
 * make-stickers.cjs —— 生成内置表情包（SVG）
 *
 * 为什么用 SVG 而不是 PNG：
 *   · 这个仓库没有图像库依赖，也不该为了画几个表情引一个；
 *   · 手写一堆 PNG 的字节不可能（要字体渲染），而 SVG 是**可以直接写出来的矢量**；
 *   · WebView 原生支持 SVG，几 KB 一个，任意分辨率都不糊；
 *   · 界面的 CSP 是 `img-src 'self' blob: data:`，本地 SVG 走 'self'，不需要放宽。
 * 代价：不支持 SVG 的老古董浏览器会看不到（Android 5 以下），这个项目的下限是 Android 7。
 *
 * 产物：app/stickers/<包>/index.json + 每个表情一个 .svg
 *   index.json: { id, label, description, stamps: [{ id, name, file, tags: [...] }] }
 *
 * 用法：node scripts/make-stickers.cjs          （幂等，覆盖生成）
 */

const fs = require("node:fs");
const path = require("node:path");

const OUT_ROOT = path.join(__dirname, "..", "app", "stickers");

/* ------------------------------------------------------------------ *
 * 画表情的小工具：统一"贴纸"语言 —— 圆角方底 + 深色粗描边 + 简笔五官
 * ------------------------------------------------------------------ */

const SIZE = 240;
const STROKE = 11;
const INK = "#3b3350";

/** 圆角方形底（贴纸的外形）。 */
function tile(fill, rotate) {
  return `<rect x="18" y="18" width="204" height="204" rx="54" fill="${fill}" stroke="${INK}" stroke-width="${STROKE}"${rotate ? ` transform="rotate(${rotate} 120 120)"` : ""}/>`;
}

/** 两只眼睛：cx 左右、cy 高度、r 半径；variant 决定眯眼/圆眼/流泪。 */
function eyes(variant, cx, cy, r) {
  const lx = cx - 40;
  const rx = cx + 40;
  const ink = `fill="${INK}"`;
  switch (variant) {
    case "closed": // 开心的弯眼
      return `<path d="M${lx - 16} ${cy + 6} q16 -22 32 0" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>
              <path d="M${rx - 16} ${cy + 6} q16 -22 32 0" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>`;
    case "smile": // 半眯（笑眼）
      return `<path d="M${lx - 16} ${cy} q16 -14 32 0" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>
              <path d="M${rx - 16} ${cy} q16 -14 32 0" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>`;
    case "wide": // 瞪大
      return `<circle cx="${lx}" cy="${cy}" r="${r + 5}" ${ink}/><circle cx="${rx}" cy="${cy}" r="${r + 5}" ${ink}/>
              <circle cx="${lx + 3}" cy="${cy - 4}" r="3.5" fill="#fff"/><circle cx="${rx + 3}" cy="${cy - 4}" r="3.5" fill="#fff"/>`;
    case "sad": // 垂眼 + 一点泪
      return `<circle cx="${lx}" cy="${cy}" r="${r}" ${ink}/><circle cx="${rx}" cy="${cy}" r="${r}" ${ink}/>
              <path d="M${lx - 4} ${cy + r + 6} q6 16 12 4" fill="none" stroke="#7cc7f2" stroke-width="8" stroke-linecap="round"/>`;
    case "angry": // 压眉
      return `<circle cx="${lx}" cy="${cy}" r="${r}" ${ink}/><circle cx="${rx}" cy="${cy}" r="${r}" ${ink}/>
              <path d="M${lx - 20} ${cy - 30} l34 12" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
              <path d="M${rx + 20} ${cy - 30} l-34 12" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>`;
    case "dot": // 点点眼（无语 / 思考）
      return `<circle cx="${lx}" cy="${cy}" r="7" ${ink}/><circle cx="${rx}" cy="${cy}" r="7" ${ink}/>`;
    case "sparkle": // 星星眼
      return `<path d="M${lx} ${cy - 20} l7 15 16 3 -12 12 3 16 -14 -8 -14 8 3 -16 -12 -12 16 -3z" ${ink}/>
              <path d="M${rx} ${cy - 20} l7 15 16 3 -12 12 3 16 -14 -8 -14 8 3 -16 -12 -12 16 -3z" ${ink}/>`;
    default: // 普通圆眼
      return `<circle cx="${lx}" cy="${cy}" r="${r}" ${ink}/><circle cx="${rx}" cy="${cy}" r="${r}" ${ink}/>`;
  }
}

/** 嘴：happy / flat / open / sad / tiny / wavy。 */
function mouth(variant, cx, y) {
  switch (variant) {
    case "happy":
      return `<path d="M${cx - 30} ${y} q30 30 60 0" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>`;
    case "open":
      return `<ellipse cx="${cx}" cy="${y + 8}" rx="24" ry="20" fill="${INK}"/>`;
    case "sad":
      return `<path d="M${cx - 26} ${y + 16} q26 -26 52 0" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>`;
    case "flat":
      return `<path d="M${cx - 26} ${y + 8} h52" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round"/>`;
    case "tiny":
      return `<path d="M${cx - 12} ${y + 4} q12 14 24 0" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>`;
    case "wavy":
      return `<path d="M${cx - 28} ${y + 6} q10 -14 20 0 q10 14 20 0" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>`;
    default:
      return "";
  }
}

/** 腮红。 */
function blush(y) {
  return `<ellipse cx="62" cy="${y}" rx="18" ry="11" fill="#ff9db3" opacity=".75"/>
          <ellipse cx="178" cy="${y}" rx="18" ry="11" fill="#ff9db3" opacity=".75"/>`;
}

function svg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img">${inner}</svg>\n`;
}

/* ------------------------------------------------------------------ *
 * 一套"通用情绪"表情：不绑任何角色，任何角色卡都能用
 * ------------------------------------------------------------------ */

const MOOD_PACK = {
  id: "mood",
  label: "情绪",
  description: "通用情绪表情：任何角色都能用。想换成自己画的那套，把 app/stickers/mood 换掉即可。",
  stamps: [
    { id: "happy", name: "开心", tags: ["高兴", "快乐", "笑", "happy", "微笑"], aliases: ["happy","smile","joyful","glad"], draw: () => tile("#ffd97a") + eyes("closed", 120, 108, 16) + mouth("happy", 120, 140) + blush(146) },
    { id: "laugh", name: "大笑", tags: ["哈哈哈", "爆笑", "laugh"], aliases: ["laugh","lol","grin"], draw: () => tile("#ffcf5c") + eyes("smile", 120, 104, 16) + mouth("open", 120, 142) + blush(150) },
    { id: "love", name: "爱心", tags: ["喜欢", "比心", "爱你", "love", "heart"], aliases: ["love","heart","adore"], draw: () => tile("#ffb3c7") + eyes("sparkle", 120, 106, 0) + mouth("tiny", 120, 146) + `<path d="M120 62 c-10 -18 -38 -14 -38 8 c0 16 22 30 38 42 c16 -12 38 -26 38 -42 c0 -22 -28 -26 -38 -8z" fill="#ff5c86" stroke="${INK}" stroke-width="7"/>` },
    { id: "shy", name: "害羞", tags: ["脸红", "不好意思", "shy", "blush"], aliases: ["shy","blush","embarrassed"], draw: () => tile("#ffc9d8") + eyes("closed", 120, 112, 16) + mouth("tiny", 120, 150) + blush(140) + `<path d="M40 62 l16 16 M200 62 l-16 16" stroke="#ff8aa8" stroke-width="8" stroke-linecap="round"/>` },
    { id: "sad", name: "难过", tags: ["伤心", "哭", "委屈", "sad", "cry"], aliases: ["sad","cry","upset"], draw: () => tile("#a9c9f0") + eyes("sad", 120, 106, 15) + mouth("sad", 120, 150) },
    { id: "angry", name: "生气", tags: ["愤怒", "恼火", "angry", "mad"], aliases: ["angry","mad","annoyed"], draw: () => tile("#ff9a8b") + eyes("angry", 120, 112, 15) + mouth("flat", 120, 156) + `<path d="M168 56 l22 -14 M172 74 l26 -4" stroke="#e34b3c" stroke-width="8" stroke-linecap="round"/>` },
    { id: "surprised", name: "惊讶", tags: ["吃惊", "震惊", "surprised", "shock"], aliases: ["surprised","shocked","wow"], draw: () => tile("#c7b6f7") + eyes("wide", 120, 104, 15) + mouth("open", 120, 146) + `<path d="M52 54 l-14 -14 M188 54 l14 -14" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>` },
    { id: "confused", name: "疑惑", tags: ["问号", "不解", "confused", "hmm"], aliases: ["confused","puzzled","huh"], draw: () => tile("#b8e0d2") + eyes("dot", 120, 112, 15) + mouth("wavy", 120, 152) + `<text x="176" y="76" font-family="sans-serif" font-size="56" font-weight="700" fill="${INK}">?</text>` },
    { id: "speechless", name: "无语", tags: ["沉默", "汗", "speechless", "awkward"], aliases: ["speechless","awkward","sweatdrop"], draw: () => tile("#cfd6e4") + eyes("dot", 120, 106, 15) + mouth("flat", 120, 150) + `<path d="M186 74 q10 22 0 34 q-10 -12 0 -34z" fill="#7cc7f2" stroke="${INK}" stroke-width="5"/>` },
    { id: "sleepy", name: "困", tags: ["想睡", "打哈欠", "sleepy", "tired"], aliases: ["sleepy","tired","yawn"], draw: () => tile("#b9c4ef") + eyes("closed", 120, 114, 16) + mouth("tiny", 120, 156) + `<text x="168" y="70" font-family="sans-serif" font-size="42" font-weight="700" fill="${INK}">z</text><text x="196" y="46" font-family="sans-serif" font-size="30" font-weight="700" fill="${INK}">z</text>` },
    { id: "thinking", name: "思考", tags: ["沉思", "想想", "thinking"], aliases: ["thinking","hmm","pondering"], draw: () => tile("#d9d2c5") + eyes("dot", 120, 108, 15) + mouth("wavy", 120, 152) + `<circle cx="176" cy="74" r="9" fill="#fff" stroke="${INK}" stroke-width="6"/><circle cx="196" cy="52" r="12" fill="#fff" stroke="${INK}" stroke-width="6"/>` },
    { id: "thumbsup", name: "赞", tags: ["点赞", "厉害", "棒", "like", "ok"], aliases: ["thumbs up","nice","well done","approve"], draw: () => tile("#9fe0a8") + eyes("smile", 120, 104, 16) + mouth("happy", 120, 140) + `<path d="M74 176 h92" stroke="${INK}" stroke-width="0"/>` + `<path d="M150 168 l30 -34 l-16 -6 l12 -26 l-30 22 l-8 -20 l-16 40z" fill="#ffe08a" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>` },
  ],
};

/* ------------------------------------------------------------------ *
 * 第二套：对话里最常用的"应答/动作"，语气更淡，适合旁白型角色
 * ------------------------------------------------------------------ */

const REPLY_PACK = {
  id: "reply",
  label: "应答",
  description: "应答类表情：点头、摇头、递东西这类「动作型」反应，适合不爱夸张的角色。",
  stamps: [
    { id: "nod", name: "点头", tags: ["同意", "好的", "nod", "yes"], aliases: ["nod","agree","yes"], draw: () => tile("#cfe8ff") + eyes("closed", 120, 100, 15) + mouth("happy", 120, 134) + `<path d="M120 176 v-22 m-16 12 l16 12 l16 -12" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` },
    { id: "shake", name: "摇头", tags: ["不行", "拒绝", "no", "shake"], aliases: ["shake head","no","refuse"], draw: () => tile("#ffd6cc") + eyes("dot", 120, 108, 15) + mouth("flat", 120, 150) + `<path d="M40 120 h26 m-10 -12 l-16 12 l16 12" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M200 120 h-26 m10 -12 l16 12 l-16 12" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` },
    { id: "wave", name: "挥手", tags: ["打招呼", "再见", "hi", "bye"], aliases: ["wave","hi","hello","bye"], draw: () => tile("#ffe6a7") + eyes("smile", 120, 104, 15) + mouth("happy", 120, 142) + `<path d="M186 150 q22 -26 6 -50" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round"/><path d="M192 100 l0 -22 M206 104 l8 -20 M178 98 l-8 -20" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>` },
    { id: "hug", name: "抱抱", tags: ["拥抱", "安慰", "hug"], aliases: ["hug","embrace","comfort"], draw: () => tile("#ffc4b3") + eyes("closed", 120, 106, 15) + mouth("tiny", 120, 146) + `<path d="M52 150 q0 -40 34 -40 M188 150 q0 -40 -34 -40" fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>` },
    { id: "cheer", name: "加油", tags: ["鼓励", "fighting", "cheer"], aliases: ["cheer","go for it","rooting"], draw: () => tile("#ffe07a") + eyes("sparkle", 120, 104, 0) + mouth("open", 120, 144) + `<path d="M60 60 l-16 -18 M180 60 l16 -18" stroke="#ff9f43" stroke-width="9" stroke-linecap="round"/>` },
    { id: "question", name: "疑问", tags: ["不解", "问", "what"], aliases: ["question","confused look"], draw: () => tile("#bfe6d8") + eyes("dot", 120, 108, 15) + mouth("flat", 120, 150) + `<text x="60" y="80" font-family="sans-serif" font-size="54" font-weight="700" fill="${INK}">?</text>` },
    { id: "idea", name: "想到了", tags: ["灵感", "灯泡", "idea"], aliases: ["idea","eureka","got it"], draw: () => tile("#ffe9b0") + eyes("wide", 120, 118, 14) + mouth("tiny", 120, 158) + `<circle cx="120" cy="62" r="22" fill="#ffe066" stroke="${INK}" stroke-width="8"/><path d="M120 84 v10" stroke="${INK}" stroke-width="8"/>` },
    { id: "clap", name: "鼓掌", tags: ["好耶", "厉害", "clap"], aliases: ["clap","applause","bravo"], draw: () => tile("#c9f0d2") + eyes("smile", 120, 102, 15) + mouth("open", 120, 138) + `<path d="M56 190 q24 -30 44 -8 M184 190 q-24 -30 -44 -8" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round"/>` },
  ],
};

/* ------------------------------------------------------------------ *
 * 生成
 * ------------------------------------------------------------------ */

function writePack(pack) {
  const dir = path.join(OUT_ROOT, pack.id);
  fs.mkdirSync(dir, { recursive: true });
  const stamps = [];
  for (const stamp of pack.stamps) {
    const file = `${stamp.id}.svg`;
    fs.writeFileSync(path.join(dir, file), svg(stamp.draw()));
    stamps.push({
      id: stamp.id,
      name: stamp.name,
      file,
      tags: stamp.tags || [],
      // 别名：模型（尤其是英文角色）常常不照抄清单，写 "happy" / "微笑" 都该命中同一张。
      // 放在清单里而不是写死在代码里 —— 用户自己加的表情包也能带自己的别名。
      aliases: stamp.aliases || [],
    });
  }
  const manifest = {
    id: pack.id,
    label: pack.label,
    description: pack.description,
    stamps,
  };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { id: pack.id, count: stamps.length, dir };
}

function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const made = [MOOD_PACK, REPLY_PACK].map(writePack);
  const total = made.reduce((sum, row) => sum + row.count, 0);
  for (const row of made) console.log(`  ${row.id}: ${row.count} 个表情 → ${path.relative(path.join(__dirname, ".."), row.dir)}`);
  console.log(`共 ${total} 个表情，输出到 app/stickers/`);
}

main();
