"use strict";

/*
 * ensure-android-shell.cjs —— 给 Android 外壳补上"别压在摄像头/状态栏上"的避让
 *
 * 为什么需要这个脚本：`src-tauri/gen/android/` 是**生成目录**（`tauri android init`
 * 的产物、也在 .gitignore 里）。手改过的界面代码一旦重新 init 就会被盖掉，
 * 而且换台机器 clone 下来也不会有。所以这个补丁做成"幂等的小脚本"，
 * 由 scripts/build-android.cjs 在打包前调用 —— 这样它永远是包的一部分。
 *
 * 守的规矩和 tests/adapter-unit.cjs 里那条守卫一致：**没这个文件不算失败**
 * （有人只用网页版/桌面版），但只要文件在，就必须带上 insets 避让。
 *
 * 前情：用户 2026-09-13 反馈「应用上方留一个五毫米的空隙留给手机的前置摄像头之类的东西」。
 * 外壳本来是 `enableEdgeToEdge()` 画满全屏，而 WebView 的父容器没有任何 inset 处理，
 * 于是顶栏正好落在挖孔那一条上。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(
  ROOT, "src-tauri", "gen", "android", "app", "src", "main", "java",
  "app", "roleworld", "desktop", "MainActivity.kt",
);

const MARKER = "五毫米"; // 补丁标志：文件里出现它就不重复打

const PATCHED = `package app.roleworld.desktop

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

/**
 * 手机端主界面。
 *
 * 外壳是 \`enableEdgeToEdge()\` 画到屏幕边缘的（状态栏透明、观感更整），
 * 但**画到边缘**不等于内容可以压在前置摄像头/挖孔上：不处理 inset 的话，
 * 顶栏正好落在摄像头那一条（用户 2026-09-13 反馈「上方留一个五毫米的空隙给前置摄像头」）。
 *
 * 顶部留白取**两者较大值**：
 *   · 系统安全区（状态栏 + 挖孔，随机型 / 横竖屏 / 分屏变化）；
 *   · 至少 5 毫米 —— 用本机真实 dpi 换算，所以各机型"看起来"都是 5 毫米。
 *
 * \`updatePadding\` 是覆盖不是叠加，且每次 inset 变化都重算，
 * 所以旋转屏幕、进出分屏都不会越加越大。
 *
 * 这个文件由 scripts/ensure-android-shell.cjs 生成（gen/ 是生成目录会被 init 覆盖），
 * 改内容请改那个脚本。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 至少 5 毫米，按本机真实 dpi 换算成像素
    val minTop: Int = (5f / 25.4f * resources.displayMetrics.densityDpi).toInt()

    // super.onCreate() 之后内容视图已经建好（WebView 在里面）。
    // 内边距加在根容器上：给 WebView 自己加没用，系统栏画在它上面。
    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.updatePadding(
        left = bars.left,
        top = maxOf(bars.top, minTop),
        right = bars.right,
        bottom = bars.bottom,
      )
      insets
    }

    // 监听器挂上时那次 inset 可能已经派发过了，主动要一次，避免首帧没有内边距。
    ViewCompat.requestApplyInsets(content)
  }
}
`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.log("没有 Android 工程（src-tauri/gen/android 不存在），跳过外壳避让补丁。");
    return;
  }
  const current = fs.readFileSync(TARGET, "utf8");
  if (current.indexOf(MARKER) >= 0) {
    console.log("Android 外壳已带避让补丁（前置摄像头那 5 毫米）。");
    return;
  }
  fs.writeFileSync(TARGET, PATCHED);
  console.log("已给 Android 外壳补上避让：顶部至少 5 毫米（并跟随状态栏/挖孔）。");
}

main();
