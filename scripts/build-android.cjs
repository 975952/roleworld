"use strict";

/*
 * build-android.cjs —— 出一只 Android APK（Windows 本机）
 *
 * 用法：
 *   node scripts/build-android.cjs                      # debug（adb 装手机就能用）
 *   node scripts/build-android.cjs --release            # release（要先配签名，见下）
 *   node scripts/build-android.cjs --abi universal      # **任何手机都能装**（arm64 + 32 位 arm）
 *   node scripts/build-android.cjs --abi x86_64         # 别的 ABI（默认 arm64-v8a）
 *
 * 为什么不用 `pnpm tauri android build` 一条命令跑完 —— 在 Windows 上有三个坑，
 * 这个脚本就是绕开它们（每一条都标了原因，换机器/换版本时先看这三段）：
 *
 *  ① **符号链接**：`tauri android build` 会把编好的 `libroleworld.so`
 *     **软链**到 `gen/android/app/src/main/jniLibs/<abi>/`。Windows 上创建符号链接
 *     需要「开发者模式」或管理员权限，普通用户直接报
 *     `Creation symbolic link is not allowed for this system`。
 *     绕法：我们**自己把 .so 复制**到 jniLibs（Gradle 只要求那里有文件，
 *     是我们先放的它就不再链接），再直接调 Gradle 打包。
 *  ② **Gradle 分发包**：wrapper 走 `services.gradle.org` 下载 131 MB 经常读超时。
 *     若本机 `C:\Android\gradle\gradle-8.14.3`（或 GRADLE_HOME）已有解压好的发行版，
 *     就直接用它，不碰 wrapper。
 *  ③ **NDK 版本**：tauri-cli 2.11.4 钉的是 `29.0.13846066`；SDK 目录里若还装有别的
 *     NDK，CLI 会挑**字典序最大**的那个，所以要显式把 `NDK_HOME` 指到 29。
 *
 * 数据落在哪：手机上数据在应用私有目录（Android WebView 的 IndexedDB），
 * 与桌面版（磁盘文件）**不是同一份**；同一个角色卡的 API Key 要各填一次。
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC_TAURI = path.join(ROOT, "src-tauri");
const ANDROID_DIR = path.join(SRC_TAURI, "gen", "android");

const NDK_VERSION = "29.0.13846066";
const GRADLE_VERSION = "8.14.3";
const MIN_SDK = 24; // 与模板里的 minSdk 一致：clang 包装器名字里要用（armv7a-linux-androideabi24-clang）
const ABI_TARGETS = {
  "arm64-v8a": "aarch64-linux-android",
  "armeabi-v7a": "armv7-linux-androideabi",
  x86: "i686-linux-android",
  x86_64: "x86_64-linux-android",
};
// Gradle 的 product flavor 名 = ABI 去掉横线（见模板 buildSrc/src/main/kotlin/RustPlugin.kt）
const FLAVORS = { "arm64-v8a": "arm64", "armeabi-v7a": "armeabi", x86: "x86", x86_64: "x86_64" };
// "通用包"：64 位 + 32 位 arm 各来一份，新手机老手机都装得上（代价是包大一些）。
// 注意 ABI 名是 **armeabi-v7a**（不是 armeabi）—— 写错的话 Gradle 会直接把它筛掉，
// .so 明明编好了却进不了包，而且不报错（踩过）。
const UNIVERSAL_ABIS = ["arm64-v8a", "armeabi-v7a"];
// NDK 里 armv7 的 clang 前缀**不是** target 三元组（是 armv7a-…），这里单独列一份。
const NDK_CLANG_PREFIX = {
  "arm64-v8a": "aarch64-linux-android",
  "armeabi-v7a": "armv7a-linux-androideabi",
  x86: "i686-linux-android",
  x86_64: "x86_64-linux-android",
};
// Rust 真正支持的那些 target（决定要不要 rustup target add）
const RUST_TARGETS = { "armeabi-v7a": "armv7-linux-androideabi" };

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const release = process.argv.includes("--release");
const abiArg = arg("--abi", "arm64-v8a");
const universal = abiArg === "universal";
const abis = universal ? UNIVERSAL_ABIS : [abiArg];
for (const one of abis) {
  if (!ABI_TARGETS[one]) {
    console.error(`不认识的 ABI：${one}（可选 universal / ${Object.keys(ABI_TARGETS).join(" / ")}）`);
    process.exit(1);
  }
}
const flavor = universal ? "universal" : FLAVORS[abis[0]];
const abiLabel = universal ? "universal" : abis[0];

/* ------------------------------- 找工具链 ------------------------------- */

function firstExistingDir(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

const sdkRoot = firstExistingDir([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  "C:\\Android\\Sdk",
]);
if (!sdkRoot) {
  console.error("找不到 Android SDK。装好后设置 ANDROID_HOME，或放到 C:\\Android\\Sdk。");
  process.exit(1);
}

// NDK：优先显式指定，其次 SDK 下的 29.x，最后才是任意一个。
const ndkRoot = (() => {
  const explicit = firstExistingDir([process.env.NDK_HOME, process.env.ANDROID_NDK_ROOT]);
  if (explicit) return explicit;
  const ndkDir = path.join(sdkRoot, "ndk");
  if (!fs.existsSync(ndkDir)) return null;
  const versions = fs.readdirSync(ndkDir).sort();
  const pinned = versions.find((v) => v === NDK_VERSION);
  return pinned ? path.join(ndkDir, pinned) : versions.length ? path.join(ndkDir, versions[versions.length - 1]) : null;
})();
if (!ndkRoot) {
  console.error(`找不到 Android NDK。用 sdkmanager 装 ndk;${NDK_VERSION}，或设置 NDK_HOME。`);
  process.exit(1);
}

const javaHome = firstExistingDir([process.env.JAVA_HOME, "C:\\Program Files\\Microsoft\\jdk-17.0.18.8-hotspot"]);
if (!javaHome) {
  console.error("找不到 JDK（需要 17+）。设置 JAVA_HOME 后重试。");
  process.exit(1);
}

// Gradle：优先本机解压好的发行版，其次项目 wrapper。
const localGradle = firstExistingDir([
  process.env.GRADLE_HOME,
  path.join("C:\\Android\\gradle", `gradle-${GRADLE_VERSION}`),
]);
const gradle = localGradle
  ? path.join(localGradle, "bin", "gradle.bat")
  : path.join(ANDROID_DIR, "gradlew.bat");

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
  NDK_HOME: ndkRoot,
};

console.log("=== 角色世界 · Android 打包 ===");
console.log(`  构建类型 : ${release ? "release" : "debug"}`);
console.log(`  ABI      : ${abis.join(" + ")}${universal ? "（通用包）" : ""}`);
console.log(`  SDK      : ${sdkRoot}`);
console.log(`  NDK      : ${ndkRoot}`);
console.log(`  JDK      : ${javaHome}`);
console.log(`  Gradle   : ${gradle}${localGradle ? "" : "（wrapper：会联网下 131 MB）"}`);
console.log("");

/* --------------------------- ① Rust 先编出来 --------------------------- */

const profile = release ? "release" : "debug";
for (const one of abis) {
  const target = ABI_TARGETS[one];
  const cargoArgs = [
    "build",
    // ⚠ 这两个参数是**必须的**，少一个手机上就白屏：
    //
    //  · `--features tauri/custom-protocol` —— tauri 的 build.rs 拿它决定 `dev`：
    //    `let dev = !custom_protocol;`。没开这个 feature 时 `dev = true`，
    //    而 `src/protocol/tauri.rs` 里 `#[cfg(all(dev, mobile))]` 会把**所有**资源请求
    //    改成走"开发服务器代理"（reqwest 去请求一个根本不存在的服务器），
    //    于是手机上打开就是：
    //      `Failed to request http://tauri.localhost/: error sending request for url`
    //    桌面端看不出问题（那条路径只在 mobile + dev 下生效），所以这个坑只在手机上现形。
    //    `tauri android build` 平时会自动补 `tauri/custom-protocol`（见 tauri-cli
    //    `Rust::build_options`），我们绕开了 CLI 就得自己补。
    //  · `--lib` —— 手机只加载动态库（libroleworld.so），不构建可执行文件。
    "--features", "tauri/custom-protocol",
    "--lib",
    "--target", target,
    "--manifest-path", path.join(SRC_TAURI, "Cargo.toml"),
  ];
  if (release) cargoArgs.push("--release");

  // 每个 target 都要显式给链接器：直接调 cargo 时 Rust 找不到 NDK 的 clang，
  // 会退回本机 MinGW 的 ld，报 `unrecognized option '--eh-frame-hdr'`。
  // （`tauri android build` 平时是 CLI 自己填这些变量。）
  // 注意 armv7 的 clang 前缀**不是** target 三元组（是 armv7a-…）。
  const env2 = { ...env };
  const clang = path.join(
    ndkRoot, "toolchains", "llvm", "prebuilt", "windows-x86_64", "bin",
    `${NDK_CLANG_PREFIX[one]}${MIN_SDK}-clang.cmd`,
  );
  if (!fs.existsSync(clang)) {
    console.error(`找不到 NDK 链接器：${clang}`);
    process.exit(1);
  }
  env2[`CARGO_TARGET_${target.replace(/-/g, "_").toUpperCase()}_LINKER`] = clang;

  console.log(`> cargo ${cargoArgs.join(" ")}`);
  const cargo = spawnSync("cargo", cargoArgs, { stdio: "inherit", env: env2, cwd: ROOT });
  if (cargo.status !== 0) {
    const rust = RUST_TARGETS[one] || target;
    console.error(`Rust 编译 ${one} 失败。若是缺 target：rustup target add ${rust}`);
    process.exit(cargo.status || 1);
  }

  const built = path.join(SRC_TAURI, "target", target, profile, "libroleworld.so");
  if (!fs.existsSync(built)) {
    console.error(`没有找到编译产物：${built}`);
    process.exit(1);
  }

  /* ---------- ② 自己复制进 jniLibs（替代 Windows 上会失败的软链） ---------- */

  const jniDir = path.join(ANDROID_DIR, "app", "src", "main", "jniLibs", one);
  fs.mkdirSync(jniDir, { recursive: true });
  fs.copyFileSync(built, path.join(jniDir, "libroleworld.so"));
  console.log(`> 已就位 jniLibs/${one}/libroleworld.so（${(fs.statSync(built).size / 1048576).toFixed(2)} MB）`);
}

/* ------------------------------ ③ Gradle 打包 ------------------------------ */

// 先补外壳（顶部给前置摄像头/状态栏让出至少 5 毫米）。
// gen/android 是生成目录，`tauri android init` 会把它覆盖掉，所以每次打包都重新确保一遍。
{
  const shellPatch = spawnSync(process.execPath, [path.join(__dirname, "ensure-android-shell.cjs")], {
    stdio: "inherit", cwd: ROOT,
  });
  if (shellPatch.status !== 0) {
    console.error("补 Android 外壳（摄像头避让）失败。");
    process.exit(shellPatch.status || 1);
  }
}

// Gradle 读的是 gen/android/app/tauri.properties 里的版本号，而这个文件平时由
// `tauri android build` 顺手重写；我们绕开了那个命令，就得自己同步 ——
// 否则会出现"文件名是 0.1.54、装到手机上显示 0.1.51"这种对不上的怪事。
// versionCode 的算法照抄 tauri-cli：major*1e6 + minor*1e3 + patch。
{
  const tauriConf = JSON.parse(fs.readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"));
  const appVersion = tauriConf.version;
  const parts = String(appVersion).split(".").map(Number);
  const versionCode = parts[0] * 1000000 + parts[1] * 1000 + parts[2];
  if (!Number.isFinite(versionCode) || versionCode <= 0) {
    console.error(`tauri.conf.json 里的版本号不能用于 Android：${appVersion}`);
    process.exit(1);
  }
  const propsPath = path.join(ANDROID_DIR, "app", "tauri.properties");
  const props = `// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\ntauri.android.versionName=${appVersion}\ntauri.android.versionCode=${versionCode}\n`;
  const current = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf8") : "";
  if (current !== props) {
    fs.writeFileSync(propsPath, props);
    console.log(`> 同步 tauri.properties：${appVersion}（versionCode ${versionCode}）`);
  }
}

const profileCapitalized = release ? "Release" : "Debug";
// 哪些 rust 任务真的存在？**必须查，不能拍脑袋写**：
//   · 名字来自 flavor，而 flavor 名和 ABI 名不是一回事（armeabi-v7a → flavor `armeabi`，
//     但它对应的 rust 任务是 `rustBuildArm…`，不存在 `rustBuildArmeabi…`）；
//   · `-x` 指到不存在的任务上，Gradle 会直接 FAILURE。
// 又因为 `assembleRelease` 会把**所有** flavor 都拉进来（所以才会撞上 rustBuildArm64Release），
// 这里列出所有可能的 flavor，逐个确认存在后再跳过。
const possibleFlavors = ["universal", "arm64", "arm", "armeabi", "x86", "x86_64"];
const wantedRustTasks = possibleFlavors.map(
  (name) => `rustBuild${name[0].toUpperCase()}${name.slice(1)}${profileCapitalized}`,
);

let existingTasks = new Set();
{
  const list = spawnSync(gradle, ["tasks", "--all", "--console=plain"], {
    env, cwd: ANDROID_DIR, shell: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (list.status !== 0 || !list.stdout) {
    console.error("无法列出 Gradle 任务（下面这一步只用来决定跳过哪些 rust 任务）。");
    process.exit(1);
  }
  // 只认 `app:任务名 - 说明` 这种行，避免把说明文字里的同名子串算进去。
  existingTasks = new Set(
    (list.stdout.match(/^app:([A-Za-z0-9_]+)/gm) || []).map((line) => line.slice(4)),
  );
}
const rustTasksToSkip = wantedRustTasks.filter((name) => existingTasks.has(name));
if (!rustTasksToSkip.length) {
  console.error("没找到任何 rustBuild* 任务 —— gen/android 里的模板改过了？先跑 `tauri android init` 重建。");
  process.exit(1);
}
console.log(`> 跳过这些 rust 任务（Rust 已在上面编好）：${rustTasksToSkip.join(", ")}`);

const taskProfile = universal
  ? profileCapitalized
  : `${flavor[0].toUpperCase()}${flavor.slice(1)}${profileCapitalized}`;
const gradleArgs = [
  `assemble${taskProfile}`,
  ...rustTasksToSkip.flatMap((name) => ["-x", name]),
  // 通用包要告诉 Gradle 收哪几个 ABI 的 .so。
  // ⚠ 只传 abiList，**不要**传 archList：archList 用的是 flavor 名（arm64 / arm / x86 / x86_64），
  // 和 ABI 名不是一回事；传错会让 Gradle 去找不存在的任务
  // （`mergeArmeabiDebugJniLibFolders not found`）。
  ...(universal ? [`-PabiList=${abis.join(",")}`] : []),
  "--console=plain",
];
if (release && process.env.TAURI_ANDROID_KEYSTORE_PATH) {
  console.log("> 已检测到 TAURI_ANDROID_KEYSTORE_* 环境变量，release 包将使用它签名");
}
console.log(`> gradle ${gradleArgs.join(" ")}`);
const java = spawnSync(gradle, gradleArgs, { stdio: "inherit", env, cwd: ANDROID_DIR, shell: true });
if (java.status !== 0) {
  console.error("Gradle 打包失败，先修上面的错误。");
  process.exit(java.status || 1);
}

/* --------------------------------- 收尾 --------------------------------- */

const apkDir = path.join(ANDROID_DIR, "app", "build", "outputs", "apk", flavor, profile);
const apks = fs.existsSync(apkDir) ? fs.readdirSync(apkDir).filter((name) => name.endsWith(".apk")) : [];
if (!apks.length) {
  console.error(`Gradle 说成功了，但 ${apkDir} 下没有 .apk —— 请检查上面输出。`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const distDir = path.join(ROOT, "dist");
fs.mkdirSync(distDir, { recursive: true });
const builtApk = path.join(apkDir, apks[0]);

/* 签名：**release 包默认是没有签名的**（AGP 只在 debug 上自动签），
 * 没签名的 APK 装不上（系统会直接说"应用未安装"）。
 *   · 想正式分发：设 TAURI_ANDROID_KEYSTORE_PATH / _PASSWORD / _KEY_ALIAS / _KEY_PASSWORD
 *     （与 `tauri android sign` 用同一组变量）；
 *   · 只是自己装/发给同学：退回 Android 自带的调试密钥（~/.android/debug.keystore，
 *     口令是公开的 android/android）—— 能装，但不能上架，而且换电脑签名就会变。 */
function findBuildTool(name) {
  const dir = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(dir)) return null;
  const versions = fs.readdirSync(dir).sort().reverse();
  for (const v of versions) {
    const candidate = path.join(dir, v, `${name}.bat`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// 找 apksigner.jar：**不走那个 .bat 包装器**。
// 包装器在 cmd.exe 下会把 `pass:android` 这类参数拆错，报
// `Unexpected parameter(s) after input APK`（踩过）。直接用 java -jar，参数不被 shell 碰。
function findApksignerJar() {
  const dir = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(dir)) return null;
  for (const v of fs.readdirSync(dir).sort().reverse()) {
    const candidate = path.join(dir, v, "lib", "apksigner.jar");
    if (fs.existsSync(candidate)) return candidate;
    const flat = path.join(dir, v, "apksigner.jar");
    if (fs.existsSync(flat)) return flat;
  }
  return null;
}

let finalPath = path.join(distDir, `RoleWorld_${version}_android_${abiLabel}${universal ? "" : "-" + profile}${release ? "" : "-debug"}.apk`);

if (release) {
  const apksignerJar = findApksignerJar();
  const javaExe = path.join(javaHome, "bin", "java.exe");
  if (!apksignerJar || !fs.existsSync(javaExe)) {
    console.error("找不到 apksigner（SDK build-tools）或 java。release 包没签名是装不上的。");
    process.exit(1);
  }
  const keystoreFromEnv = process.env.TAURI_ANDROID_KEYSTORE_PATH;
  const keystore = keystoreFromEnv || path.join(process.env.USERPROFILE || process.env.HOME || "", ".android", "debug.keystore");
  if (!fs.existsSync(keystore)) {
    console.error(`找不到签名用的 keystore：${keystore}\n可以先出 debug 包，或按上面说的设置 TAURI_ANDROID_KEYSTORE_PATH。`);
    process.exit(1);
  }
  const storePass = keystoreFromEnv ? (process.env.TAURI_ANDROID_KEYSTORE_PASSWORD || "") : "android";
  const keyAlias = keystoreFromEnv ? (process.env.TAURI_ANDROID_KEY_ALIAS || "") : "androiddebugkey";
  const keyPass = keystoreFromEnv ? (process.env.TAURI_ANDROID_KEY_PASSWORD || storePass) : storePass;
  if (!storePass) {
    console.error("设了 TAURI_ANDROID_KEYSTORE_PATH 但没给 TAURI_ANDROID_KEYSTORE_PASSWORD。");
    process.exit(1);
  }
  console.log("");
  console.log(`> 签名：${keystoreFromEnv ? "你自己的 keystore" : "调试密钥（只能自己装/发给同学，不能上架）"}`);
  const signArgs = [
    "-jar", apksignerJar, "sign",
    "--ks", keystore,
    "--ks-pass", `pass:${storePass}`,
    "--key-pass", `pass:${keyPass}`,
    "--ks-key-alias", keyAlias,
    "--out", finalPath,
    builtApk,
  ];
  // shell:false —— 参数原样交给 java，不给 cmd.exe 拆坏的机会。
  const sign = spawnSync(javaExe, signArgs, { stdio: "inherit" });
  if (sign.status !== 0) {
    console.error("签名失败。");
    process.exit(sign.status || 1);
  }
  const verify = spawnSync(javaExe, ["-jar", apksignerJar, "verify", finalPath], { stdio: "inherit" });
  if (verify.status !== 0) {
    console.error("签名校验没过 —— 这个包不要发出去。");
    process.exit(verify.status || 1);
  }
} else {
  fs.copyFileSync(builtApk, finalPath);
}

console.log("");
console.log(`✅ ${finalPath}`);
console.log(`   ${(fs.statSync(finalPath).size / 1048576).toFixed(2)} MB`);
const sha = spawnSync("certutil", ["-hashfile", finalPath, "SHA256"], { encoding: "utf8", shell: true });
if (sha.stdout) {
  const hash = (sha.stdout.match(/[0-9a-fA-F]{64}/) || [])[0];
  if (hash) console.log(`   SHA256 ${hash}`);
}
console.log("");
console.log("装到手机：数据线连上、开 USB 调试，然后");
console.log(`   adb install -r "${finalPath}"`);
