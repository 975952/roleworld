"use strict";

/*
 * make-voices.cjs —— 从官方「音色列表」生成 relay/voices.js
 *
 * 为什么要有这个脚本：音色表原来是**手抄**的（从一份公开实现对照着列），
 * 结果官方 230 个 2.0 音色（`*_uranus_bigtts`）我只收了 53 个 —— 中文少一半、英文少到只剩 1/6。
 * 手抄必然漏，所以改成**从官方文档生成**，跟表情包那套（`make-stickers.cjs`）一个路子。
 *
 * 三步：
 *   1. 抓官方文档 → 存成快照（**这一步要联网、而且官网有反爬，单独做**）：
 *        node scripts/make-voices.cjs --parse <把官方音色列表正文存成的 .md>
 *   2. 从快照生成音色表（**离线、确定**）：
 *        node scripts/make-voices.cjs
 *   3. 检查磁盘上那份是不是最新的（测试用，不写盘）：
 *        node scripts/make-voices.cjs --check
 *
 * 官方来源：https://www.volcengine.com/docs/6561/1257544 （音色列表）
 *   ⚠ 官网是前端渲染的，正文藏在 SSR JSON 的 `curDoc.Content` 里（JSON 转义的 markdown）。
 *     抓取姿势见 docs/VOICE_CLOUD_TTS.md；抓的时候会被 4606 字节的反爬页挡，隔十几秒重试即可。
 *
 * 这一轮**排除了什么**（每条都在下面代码里写明理由）：
 *   · 名人/影视角色音色（12 个）—— 授权风险，不该发给用户；
 *   · 残缺行（只有语言前缀、没有音色名）—— 官方表格里的烂行，不能当音色用；
 *   · 非 2.0 那一族（`*_mars_bigtts` / `*_moon_bigtts` 是 1.0，`saturn_*` 是声音复刻）——
 *     放进去必报 `55000000 资源标识与音色不匹配`。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SNAPSHOT = path.join(ROOT, "relay", "voices.official.json");
const TARGET = path.join(ROOT, "relay", "voices.js");
const DOC_URL = "https://www.volcengine.com/docs/6561/1257544";

/** 2.0 这一族的 id 形状。seed-tts-2.0 只认 `*_uranus_bigtts`。 */
const ID_RE = /^[a-z]{2}(?:_[a-z]{2})?_[a-z0-9_]+_uranus_bigtts$/;

/**
 * 名人 / 影视角色音色：**一律不下发给用户**。
 * 这些是官方给"授权复刻"准备的（就是 `_p1_` 那种），
 * 名字里带真人或影视角色（Brad Pitt / Zendaya / Gollum / Joker / 教父 / 辛巴 / 老友记的角色…）。
 * 放进产品里给同学用，法律风险我们自己扛不起 —— 宁可少几个音色。
 * 注意有几条**显示名看不出来**（Leo / Lynn / Ivy / Rachel / Scarlet / Tom），只有 id 暴露来历，
 * 所以这里按 **id** 匹配，不按名字。
 */
const LIKENESS_RE = /_p1_|gollum|joker|godfather|simba|zendaya|brad_pitt|hiddleston|lana_del_rey|chandler|_rachel_|scarlet/i;

function langOf(id) {
  if (id.startsWith("zh_")) return "zh";
  if (id.startsWith("en_")) return "en";
  return "other";
}

function genderOf(id) {
  if (/_male_|^[a-z]{2}_male_/.test(id)) return "male";
  if (/_female_|^[a-z]{2}_female_/.test(id)) return "female";
  return "";
}

/** 把官方「音色列表」的 markdown 表格解析成结构化数据。 */
function parseOfficialMarkdown(markdown) {
  const rows = [];
  const seen = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    // 去掉首尾空单元格（markdown 表格行首尾都有 |）
    const cells = line.split("|").map((c) => c.trim());
    while (cells.length && cells[0] === "") cells.shift();
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length < 4) continue;
    const id = cells.find((c) => ID_RE.test(c));
    if (!id || seen.has(id)) continue;
    const index = cells.indexOf(id);
    seen.add(id);
    rows.push({
      id,
      name: (cells[1] || "").replace(/\\$/, "").trim(),
      scene: (cells[0] || "").replace(/\\$/, "").trim(),
      langText: (cells[index + 1] || "").replace(/^语种：/, "").trim(),
      tags: (cells[cells.length - 1] || "").trim(),
    });
  }
  return rows;
}

/** 快照 → 生成用的音色对象（过滤都在这里，两条路径共用，保证 --check 与生成一致）。 */
function buildTable(snapshot) {
  const kept = [];
  const dropped = { noName: [], likeness: [], badId: [] };
  for (const row of snapshot.voices || []) {
    if (!ID_RE.test(row.id)) { dropped.badId.push(row.id); continue; }
    if (!row.name) { dropped.noName.push(row.id); continue; }
    if (LIKENESS_RE.test(row.id)) { dropped.likeness.push(row.id); continue; }
    kept.push({
      id: row.id,
      // 官方名字就是控制台里显示的名字，照抄 —— 用户对得上号。
      label: row.scene ? row.name + " · " + shortScene(row.scene) : row.name,
      lang: langOf(row.id),
      langLabel: row.id.startsWith("zh_") ? "中文" : (row.id.startsWith("en_") ? "英语" : "其他语言"),
      gender: genderOf(row.id),
      scene: shortScene(row.scene),
    });
  }
  const byLang = (code) => kept.filter((one) => one.lang === code).sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  return { zh: byLang("zh"), en: byLang("en"), other: byLang("other"), dropped };
}

/** 「通用场景」→「通用」：下拉里每一条都要短，不然一排全是"场景"两个字。 */
function shortScene(scene) {
  return String(scene || "")
    .split(/[,，]/)[0]
    .replace(/场景$/, "")
    .trim();
}

function render(snapshot, table) {
  const rows = (list) => list.map((one) => "  " + JSON.stringify(one) + ",").join("\n");
  const excluded = (snapshot.voices || [])
    .filter((row) => LIKENESS_RE.test(row.id))
    .map((row) => "  " + JSON.stringify(row.id) + ",")
    .join("\n");
  return `"use strict";

/*
 * relay/voices.js —— 豆包语音合成模型 2.0 的可用音色清单（服务端唯一事实来源）
 *
 * ⚠⚠ **这个文件是自动生成的，不要手改** —— 手改会在下次生成时丢掉。
 *   改音色表请改"上游"：
 *     node scripts/make-voices.cjs            # 从 relay/voices.official.json 重新生成
 *     node scripts/make-voices.cjs --check    # 检查磁盘上这份是不是最新的
 *     node scripts/make-voices.cjs --parse <官方音色列表.md>   # 用新抓的官方正文刷新快照
 *
 * 数据来源：${snapshot.title || "官方音色列表"}
 *   ${snapshot.source || DOC_URL}
 *   抓取日期：${snapshot.fetchedAt || "未知"}
 *
 * 生成时做了什么（详见 scripts/make-voices.cjs）：
 *   · 只保留 \`*_uranus_bigtts\` —— 那是与 \`seed-tts-2.0\` 配套的一族。
 *     放别族进来上游会回 \`55000000 资源标识与音色不匹配\`
 *     （\`*_mars_bigtts\` / \`*_moon_bigtts\` 是 1.0，\`saturn_*\` / \`S_*\` 是声音复刻）；
 *   · 剔除官方表格里的残缺行（只有语言前缀、没有音色名）；
 *   · **剔除名人/影视角色音色**（见文件末尾 \`LIKENESS_EXCLUDED\`）—— 授权风险，不给用户用。
 *
 * ⚠ 两件必须记住的事：
 *   ① 官方这张表是**全目录**，不是你账号能用的那些 —— 没开通的音色上游会回
 *      \`45000000 speaker permission denied\`。最终以控制台「音色管理」里实际可用的为准；
 *   ② 这张表可以整体覆盖 / 追加，不用改代码：
 *        VOLC_TTS_SPEAKERS="id1=名字1,id2=名字2"     只认这几项
 *        VOLC_TTS_SPEAKERS_EXTRA="id3=名字3"         追加在默认表后面
 *      （买来的复刻/设计音色 \`S_*\` 就用 EXTRA 加 —— 但它要配 \`seed-icl-2.0\`，
 *        见 docs/VOICE_CLOUD_TTS.md §10.5，不是随便加进来就能用。）
 */

/** 默认音色：官方示例自己用的就是 vivi 2.0。 */
const DEFAULT_SPEAKER = "zh_female_vv_uranus_bigtts";

/** 2.0 这一族的 id 形状（seed-tts-2.0 只认 \\\`*_uranus_bigtts\\\`）—— 测试与校验都用它。 */
const ID_RE = ${String(ID_RE)};

const SPEAKERS_ZH = [
${rows(table.zh)}
];

const SPEAKERS_EN = [
${rows(table.en)}
];

/** 其它语言（日/韩/西/葡/俄/印尼/越南/泰/法/德/阿…）。中文角色用不上，但列表里留着。 */
const SPEAKERS_OTHER = [
${rows(table.other)}
];

/**
 * **被排除**的名人 / 影视角色音色：只把 id 记在这里（便于以后复查），**不进下发列表**。
 * 理由是授权：这些是官方给"授权复刻"准备的，名字里带真人或影视角色。
 */
/** 名人/影视角色的 id 匹配规则（\u5b88\u536b\u7528\u5b83\u6309 id \u5339\u914d\uff0c\u4e0d\u6309\u540d\u5b57\uff1a\u6709\u51e0\u6761\u663e\u793a\u540d\u770b\u4e0d\u51fa\u6765\uff09\u3002 */
const LIKENESS_RE = /_p1_|gollum|joker|godfather|simba|zendaya|brad_pitt|hiddleston|lana_del_rey|chandler|_rachel_|scarlet/i;

const LIKENESS_EXCLUDED = [
${excluded || "  // 本次快照里没有匹配到"}
];

function allBuiltin() {
  return SPEAKERS_ZH.concat(SPEAKERS_EN, SPEAKERS_OTHER);
}

function parseOverride(text) {
  const out = [];
  for (const piece of String(text || "").split(",")) {
    const item = piece.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const id = (eq >= 0 ? item.slice(0, eq) : item).trim();
    const label = (eq >= 0 ? item.slice(eq + 1) : "").trim();
    if (!/^[A-Za-z0-9_.:-]{2,80}$/.test(id)) continue;
    out.push({
      id,
      label: label || id,
      lang: /^en[_-]/i.test(id) ? "en" : (/^zh[_-]/i.test(id) ? "zh" : "other"),
      langLabel: /^en[_-]/i.test(id) ? "英语" : (/^zh[_-]/i.test(id) ? "中文" : "自定义"),
      gender: /_male_|^male_/i.test(id) ? "male" : (/female|_nv|nvsheng/i.test(id) ? "female" : ""),
      scene: "自定义",
    });
  }
  return out;
}

/**
 * 这一份中转实际会下发哪些音色。
 * 返回 { speakers: [...], defaultSpeaker, source }。
 */
function resolveSpeakers(env) {
  const source = env || process.env;
  const override = String(source.VOLC_TTS_SPEAKERS || "").trim();
  if (override) {
    const list = parseOverride(override);
    if (list.length) {
      const hasDefault = list.some((one) => one.id === DEFAULT_SPEAKER);
      return { speakers: list, defaultSpeaker: hasDefault ? DEFAULT_SPEAKER : list[0].id, source: "env" };
    }
  }
  const extra = parseOverride(source.VOLC_TTS_SPEAKERS_EXTRA || "");
  const speakers = allBuiltin().concat(extra);
  const hasDefault = speakers.some((one) => one.id === DEFAULT_SPEAKER);
  return {
    speakers,
    defaultSpeaker: hasDefault ? DEFAULT_SPEAKER : (speakers[0] ? speakers[0].id : ""),
    source: extra.length ? "builtin+env" : "builtin",
  };
}

/** 按 id 找音色；找不到返回 null（调用方据此拒绝这次请求）。 */
function findSpeaker(id, env) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const list = resolveSpeakers(env).speakers;
  return list.find((one) => one.id === wanted) || null;
}

module.exports = {
  SPEAKERS_ZH,
  SPEAKERS_EN,
  SPEAKERS_OTHER,
  LIKENESS_EXCLUDED,
  LIKENESS_RE,
  DEFAULT_SPEAKER,
  ID_RE,
  resolveSpeakers,
  findSpeaker,
  parseOverride,
};
`;
}

function main() {
  const argv = process.argv.slice(2);
  const parseIndex = argv.indexOf("--parse");
  const checkMode = argv.includes("--check");

  if (parseIndex >= 0) {
    const file = argv[parseIndex + 1];
    if (!file || !fs.existsSync(file)) {
      console.error("用法：node scripts/make-voices.cjs --parse <官方音色列表正文.md>");
      process.exit(1);
    }
    const markdown = fs.readFileSync(file, "utf8");
    const voices = parseOfficialMarkdown(markdown);
    const snapshot = {
      source: DOC_URL,
      title: "音色列表（豆包语音合成模型2.0 / S2S-O2.0 / S2S-全双工）",
      fetchedAt: new Date().toISOString().slice(0, 10),
      note: "从官方文档正文里解析出来的原始行（未过滤）。过滤与生成见 scripts/make-voices.cjs。",
      count: voices.length,
      voices,
    };
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`快照已更新：${voices.length} 条 → ${path.relative(ROOT, SNAPSHOT)}`);
    return;
  }

  if (!fs.existsSync(SNAPSHOT)) {
    console.error("找不到快照 " + path.relative(ROOT, SNAPSHOT) + "，先跑 --parse");
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const table = buildTable(snapshot);
  const next = render(snapshot, table);

  if (checkMode) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";
    if (current !== next) {
      console.error("relay/voices.js 与快照不一致（有人手改了，或改了生成器没重新生成）");
      console.error("修法：node scripts/make-voices.cjs");
      process.exit(1);
    }
    console.log("relay/voices.js 是最新的（" + (table.zh.length + table.en.length + table.other.length) + " 个音色）");
    return;
  }

  fs.writeFileSync(TARGET, next);
  console.log("已生成 relay/voices.js");
  console.log(`  中文 ${table.zh.length} · 英语 ${table.en.length} · 其他语言 ${table.other.length}` +
    ` = ${table.zh.length + table.en.length + table.other.length} 个`);
  if (table.dropped.likeness.length) {
    console.log(`  已排除名人/影视角色 ${table.dropped.likeness.length} 个：${table.dropped.likeness.join(", ")}`);
  }
  if (table.dropped.noName.length) console.log(`  已排除没有名字的残缺行 ${table.dropped.noName.length} 个`);
  if (table.dropped.badId.length) console.log(`  已排除 id 形状不对的 ${table.dropped.badId.length} 个`);
}

if (require.main === module) main();

module.exports = { parseOfficialMarkdown, buildTable, render, LIKENESS_RE, ID_RE, shortScene };
