"use strict";

/*
 * ensure-android-shell.cjs —— 给 Android 生成目录做三件"打包时必须存在"的事
 *
 * 为什么要有这个脚本：`src-tauri/gen/android/` 是**生成目录**（`tauri android init` 的产物，
 * 也在 .gitignore 里）。手改的界面/原生代码一旦重新 init 就会被盖掉，
 * 换台机器 clone 下来也没有。所以这些补丁做成"幂等脚本"，由 build-android.cjs 在打包前调用。
 *
 * 它负责的三件事（都踩过）：
 *   ① **主线避让**：顶部至少留 5 毫米给前置摄像头/状态栏（用户 2026-09-13 反馈）；
 *   ② **麦克风权限**：不声明就完全拿不到麦克风，语音输入直接不可用，而且连系统弹窗都没有；
 *   ③ **原生 TTS 桥**：Android 的系统 WebView 里 Chromium 把 speechSynthesis 关掉了
 *      （android_webview 里 `AppendSwitch(kDisableSpeechSynthesis)`），
 *      所以手机上要出声**只能**用系统 TTS 引擎 —— 通过 addJavascriptInterface 暴露给页面。
 *
 * 守的规矩和 tests/adapter-unit.cjs 里的守卫一致：**没有这个文件不算失败**
 * （有人只用网页版/桌面版），但只要文件在，就必须带上这些内容。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ANDROID_APP = path.join(ROOT, "src-tauri", "gen", "android", "app", "src", "main");
const TARGET = path.join(ANDROID_APP, "java", "app", "roleworld", "desktop", "MainActivity.kt");
const MANIFEST = path.join(ANDROID_APP, "AndroidManifest.xml");

const MARKER = "五毫米"; // 补丁标志：文件里出现它就不重复打

/* 麦克风权限：**Android 上不声明就完全拿不到麦克风**，语音输入直接不可用
 * （前端 `getUserMedia` 报 NotAllowedError，用户连系统弹窗都看不到）。
 * Tauri/wry 已经处理了 onPermissionRequest（不需要我们自己写 Kotlin），
 * 但清单里的 uses-permission 必须自己加 —— 见 tauri-apps/tauri#10898。
 * MODIFY_AUDIO_SETTINGS 是 wry 申请麦克风时会一并要的。 */
const MIC_PERMISSIONS = [
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
];

const PATCHED = `package app.roleworld.desktop

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import org.json.JSONObject
import java.util.Locale

/**
 * ⚠ **这一段现在是死代码（2026-09-14 起）**：语音方向改成**只走云端**
 * （火山引擎「豆包语音合成模型 2.0」，经体验卡中转），页面侧已经不再找这个桥
 * （\`app/voice-core.js\` 里没有 \`__rwNativeTts\` 了，\`adapter-unit\` 有用例钉着这一点）。
 *
 * 为什么先留着而不是立刻删：
 *   · 它只是一段挂在 WebView 上的 Java 对象，不参与云端那条路，留着不会影响任何行为；
 *   · 删它要重新出 APK 并在真机/模拟器上确认外壳还能起来 —— 这一次没有真机可用，
 *     "删了没验"比"留着一段没用的桥"风险大。
 * **下次出 Android 包时应该顺手删掉**（连同 \`patch_manifest\` 里与 TTS 有关的日志通道）。
 *
 * ——下面保留的是它当年的说明，留作背景——
 *
 * 让角色"说话"的原生桥（**已停用**）。
 *
 * 当时的理由：Android 的系统 WebView 里没有 \`speechSynthesis\` ——
 * Chromium 在 android_webview 里显式 \`AppendSwitch(kDisableSpeechSynthesis)\`
 * （"Speech Synthesis backend resides in the chrome layer, not used by WebView"）。
 * 不是版本问题、不是缺语音包、不是华为的问题，等 WebView 升级也不会好。
 * 系统 TTS 引擎（华为等机型通常预装）离线可用，所以那曾是三端里唯一能在手机上出声的。
 * 但它只是把字念出来，天花板是导航播报级 —— 产品方向已经换成云端情感音色。
 *
 * 对外接口（挂在页面里的 \`window.__rwNativeTts\`）：
 *   init()                       —— 触发引擎初始化（要在用户点过之后调用）
 *   status()                     —— 返回 JSON 字符串：ready / lang / engine
 *   speak(text, rate, pitch, id) —— 念一段；结束或失败时回调页面
 *   stop()                       —— 立刻停止
 *
 * 回调走 \`window.__rwVoiceCallback(jsonString)\`，格式：
 *   {"id": "...", "event": "start" | "done" | "error", "message": "..."}
 *
 * 线程：JavascriptInterface 的方法跑在 WebView 的 JS 线程上，不是主线程，
 * 所以创建/操作 TextToSpeech 一律用 runOnUiThread 转到主线程（否则会崩）。
 */
class VoiceBridge(private val activity: MainActivity) {

  private var tts: TextToSpeech? = null
  private var ready = false
  /** 初始化结果：false 表示这次初始化失败（false != "还没初始化好"）。 */
  private var failed = false
  private val pending = ArrayDeque<Array<Any>>()
  /** utteranceId → 页面给的 id，用来把"念完了"对回到具体一条消息。 */
  private val speaking = HashMap<String, String>()
  private var counter = 0

  @JavascriptInterface
  fun init() {
    activity.runOnUiThread {
      if (tts != null || failed) return@runOnUiThread
      note("init() called; creating TextToSpeech")
      tts = TextToSpeech(activity) { state ->
        note("TextToSpeech init state=" + state + " (0=SUCCESS)")
        if (state == TextToSpeech.SUCCESS) {
          val engine = tts
          if (engine == null) {
            failed = true
            return@TextToSpeech
          }
          // 中文优先；系统没装中文语音包时如实记下来（别假装成功）。
          val zh = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
          engine.setSpeechRate(1.0f)
          engine.setPitch(1.0f)
          engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
              val id = speaking[utteranceId] ?: utteranceId ?: ""
              callback(id, "start", "")
            }

            override fun onDone(utteranceId: String?) {
              val id = speaking.remove(utteranceId) ?: utteranceId ?: ""
              callback(id, "done", "")
            }

            @Deprecated("老 API 也要实现，Android 12 上仍可能走这条")
            override fun onError(utteranceId: String?) {
              val id = speaking.remove(utteranceId) ?: utteranceId ?: ""
              callback(id, "error", "系统语音引擎报错")
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
              val id = speaking.remove(utteranceId) ?: utteranceId ?: ""
              callback(id, "error", "系统语音引擎报错（code " + errorCode + "）")
            }
          })
          ready = zh != TextToSpeech.LANG_MISSING_DATA && zh != TextToSpeech.LANG_NOT_SUPPORTED
          Log.i(TAG, "setLanguage(zh)=" + zh + " ready=" + ready + " engine=" + engine.engines.joinToString(","))
          if (!ready) {
            callback("", "error", "这台设备的语音引擎没有中文语音包（可以去系统设置里装一个中文 TTS 引擎）")
          }
          // 初始化期间排队的朗读，现在补上
          while (pending.isNotEmpty()) {
            val job = pending.removeFirst()
            speak(job[0] as String, job[1] as Float, job[2] as Float, job[3] as String)
          }
        } else {
          failed = true
          callback("", "error", "系统语音引擎初始化失败（这台设备可能没有装 TTS 引擎）")
        }
      }
    }
  }

  @JavascriptInterface
  fun status(): String {
    val info = JSONObject()
    val engine = tts
    info.put("ready", ready && engine != null)
    info.put("failed", failed)
    info.put("engine", engine?.engines?.joinToString(",") ?: "")
    info.put("lang", engine?.voice?.locale?.toLanguageTag() ?: "")
    info.put("speaking", engine?.isSpeaking ?: false)
    // 页面每次问状态都记一笔：这条出现了，说明 JS 侧**看得见桥**；
    // 没出现而 bridge attached 出现了 → 桥挂上了但页面看不见（JS 侧问题）。
    note("status() asked -> " + info.toString())
    return info.toString()
  }

  @JavascriptInterface
  fun speak(text: String, rate: Float, pitch: Float, id: String) {
    val body = text.trim()
    note("speak requested id=" + id + " chars=" + body.length + " ttsNull=" + (tts == null) + " ready=" + ready)
    if (body.isEmpty()) {
      callback(id, "error", "没有可念的内容")
      return
    }
    activity.runOnUiThread {
      val engine = tts
      if (engine == null) {
        // 还没初始化好：先排队（页面一般会先 init，但也不该因为时序丢一句话）
        if (pending.size < 4) pending.addLast(arrayOf(body, rate, pitch, id))
        init()
        return@runOnUiThread
      }
      if (!ready) {
        callback(id, "error", "这台设备的语音引擎没有中文语音包")
        return@runOnUiThread
      }
      engine.setSpeechRate(if (rate > 0.1f) rate else 1.0f)
      engine.setPitch(if (pitch > 0.1f) pitch else 1.0f)
      counter += 1
      val utteranceId = "rw-" + counter
      speaking[utteranceId] = id
      // QUEUE_FLUSH：新的一句顶掉上一句（聊天里连点两次不该叠着念）
      engine.speak(body, TextToSpeech.QUEUE_FLUSH, null, utteranceId).let { code ->
        note("engine.speak code=" + code + " (0=SUCCESS)")
        if (code != TextToSpeech.SUCCESS) {
          speaking.remove(utteranceId)
          callback(id, "error", "朗读没能启动（系统引擎拒绝了这次请求）")
        }
      }
    }
  }

  @JavascriptInterface
  fun stop() {
    activity.runOnUiThread {
      speaking.clear()
      pending.clear()
      tts?.stop()
    }
  }

  /** 外壳在 onResume 挂好桥之后叫一声，用来在外部目录留下"桥挂上了"的记录。 */
  fun recordBridgeAttached() {
    note("bridge attached; ttsNull=" + (tts == null) + " ready=" + ready)
  }

  /**
   * 页面调到了没有？—— 给 JS 侧一个"打开就记一笔"的入口。
   * 真机上排查时最要紧的一步就是区分这两件事：
   *   · 桥没挂上（原生侧的问题）；
   *   · 桥挂上了、页面却看不见它（JS 侧的问题）。
   * 页面一调到它，日志里就会出现 webview 那一行。
   */
  @JavascriptInterface
  fun ping(from: String) {
    note("webview ping: " + from)
  }

  /** 给外壳用的公开记录入口（外壳不方便直接调私有方法）。 */
  fun notePublic(line: String) = note(line)

  /**
   * 原生侧自检：念一句英文，把引擎返回码写进日志。
   * 用英文是刻意的 —— 中文用户听到一句英文就知道这是自检，不是角色在说话。
   */
  fun speakSelfTest() {
    note("selfTest: calling speak (ttsNull=" + (tts == null) + " ready=" + ready + ")")
    speak("Voice check. Native text to speech is working.", 1.0f, 1.0f, "self-test")
  }

  /** 回调页面：包成 JSON 字符串，页面侧自己解析（简单、跨版本稳）。 */
  private fun callback(id: String, event: String, message: String) {
    // 同时写一条系统日志：华为 WebView **不把页面的 console 转发到 logcat**，
    // 所以"到底有没有念、引擎答没答应"只能从原生这侧记（tag 固定，便于过滤）。
    Log.i(TAG, "callback event=" + event + " id=" + id + (if (message.isNotEmpty()) " message=" + message else ""))
    note("event=" + event + (if (message.isNotEmpty()) " message=" + message else ""))
    val json = JSONObject()
    json.put("id", id)
    json.put("event", event)
    json.put("message", message)
    val payload = json.toString()
    activity.runOnUiThread {
      activity.webViewForBridge()?.evaluateJavascript(
        "window.__rwVoiceCallback && window.__rwVoiceCallback(" + JSONObject.quote(payload) + ");",
        null,
      )
    }
  }

  /**
   * 把一行状态写进**应用外部目录**（Android/data/包名/files/voice-log.txt）。
   *
   * 为什么不用日志：华为 WebView 不转发 console，而 logcat 我在实机上也没收到自己 tag 的行；
   * 外部目录不一样 —— adb shell cat 直接能读，不需要 root、不需要 debuggable、
   * 不碰任何隐私数据（只有"引擎状态 + 回调事件"，没有念的内容）。
   * 这是这一轮排查真机语音**唯一可用的观测通道**。
   */
  private fun note(line: String) {
    val stamp = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
    val row = stamp + "  " + line + "\\n"
    // 写两个地方：外部目录（adb 直接可读，但 Android 11+ 的 SELinux 可能挡住 shell）
    // 和内部目录（一定写得进去，走 adb backup 或 root 才读得到）。
    // 两条都试，能在外面读到就用外面的。
    try {
      val dir = activity.getExternalFilesDir(null)
      if (dir != null) {
        if (!dir.exists()) dir.mkdirs()
        java.io.File(dir, "voice-log.txt").appendText(row)
      }
    } catch (_: Throwable) { /* 外部目录不可用就算了 */ }
    try {
      java.io.File(activity.filesDir, "voice-log.txt").appendText(row)
    } catch (_: Throwable) { /* 内部也写不进去就只能靠 logcat 了 */ }
  }

  companion object {
    /** 固定的日志 tag：查问题时 adb logcat -s RoleWorldVoice 就是全部相关日志。 */
    const val TAG = "RoleWorldVoice"
  }
}

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

  private var bridge: VoiceBridge? = null
  private var webView: WebView? = null
  /** 挂桥成功的次数：用来只在第一次挂上时做一次性的事（例如清缓存）。 */
  private var viewCount = 0

  /** 给 VoiceBridge 用：它回调页面时需要 WebView。 */
  fun webViewForBridge(): WebView? = webView
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 最早的一条记录：证明我们的原生代码确实跑到了
    // （后面 onResume 里找 WebView、挂桥是另一回事，分开记才好定位）。
    VoiceBridge(this).notePublic("activity onCreate (shell rev 2026-09-14d)")

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

    // 桥建好就开始**先 init**（不等页面）：引擎初始化要等系统回调，
    // 页面渲染历史消息的「⋯」菜单时如果引擎还没就绪，就会少一个「朗读」项
    // —— 用户实测反馈过"只有复制/重新回答/分支，没有朗读"，根因就是时序。
    bridge = VoiceBridge(this)
    bridge?.init()
    attachBridgeSoon()
    // 预热引擎：**只 init，不出声**。
    // 早期为了在真机上确认"到底能不能出声"，这里会念一句英文；现在已经验通了
    // （日志里 init state=0 / engine.speak code=0 / start→done），
    // 再念就是每次启动都打扰用户，所以去掉了。
    // 需要重新做真机自检时：把下面那行 speakSelfTest 的注释解开即可。
    val ready = bridge
    if (ready != null) {
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ ready.init() }, 1200)
      // android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ ready.speakSelfTest() }, 3000)
    }
  }

  /** 把原生语音桥挂到当前 WebView 上（幂等，可以反复调）。 */
  private fun attachBridge(tryCount: Int) {
    val view = findWebView(window.decorView)
    val current = bridge ?: VoiceBridge(this).also { bridge = it }
    current.notePublic("attachBridge#" + tryCount + (if (view == null) " not found" else " ok"))
    if (view == null) return
    webView = view
    // 清一次 WebView 的 HTTP 缓存。
    // 为什么需要：页面资源是通过 Tauri 的自定义协议从 .so 里现取的，正常不会走缓存；
    // 但真机上出现过"装了新包、页面还是旧行为"的情况（用户反馈"菜单里没有朗读"），
    // 而同一份代码在模拟环境里是对的 —— 最可能就是 WebView 缓存了旧响应。
    // 清一次是幂等的、代价很小（资源来自本地）。
    try {
      if (viewCount == 0) {
        view.clearCache(true)
        current.notePublic("webview cache cleared")
      }
      viewCount += 1
    } catch (_: Throwable) { /* 清不了就算了，不影响挂桥 */ }
    // ⚠ 必须**复用同一个** VoiceBridge 实例。
    // 踩过的坑：这里原来是 bridge ?: VoiceBridge(this).also{} —— 页面在启动早期
    // 调 init() 初始化的是**另一个**实例，而挂给页面的却是新建的这个，
    // 于是引擎永远是 null、点了没声音，日志里表现为 bridge attached; ttsNull=true。
    // 现在：onCreate 建好的那个就是唯一实例，页面 init() 与这里注入的是同一个对象。
    view.removeJavascriptInterface("__rwNativeTts")
    view.addJavascriptInterface(current, "__rwNativeTts")
    current.recordBridgeAttached()
    // 视图树里有几个 WebView？各自加载的是什么？—— 决定"我们挂的是不是渲染页面的那个"。
    current.notePublic("webviews: " + describeWebViews())
    // 页面侧靠这个事件判断"现在有原生语音了"（晚到的情况靠它补上预热）。
    view.evaluateJavascript(
      "window.dispatchEvent(new Event('rw-native-tts-ready'));",
      null,
    )
    // 再直接问 WebView 一句：**不依赖页面里的任何代码**（页面可能没跑到那段），
    // 就能知道 window.__rwNativeTts 到底存不存在、方法能不能调。
    // 这一步是为了区分"桥没挂上"与"挂上了但页面看不见" —— 这两个方向排查起来完全不同。
    view.evaluateJavascript(
      "(function(){try{var b=window.__rwNativeTts;if(!b){return 'MISSING';}"
      + "var s='PRESENT speak='+typeof b.speak;"
      + "try{s+=' status='+String(b.status()).slice(0,70);}catch(e){s+=' statusThrew='+e;}"
      + "return s;}catch(e){return 'PROBE_THREW '+e;}})()",
      android.webkit.ValueCallback<String> { value -> current.notePublic("probe(webview): " + value) },
    )
  }

  /**
   * 反复试着挂桥。
   * 为什么不能只在某个生命周期里挂一次：实机实测（华为 Mate 70 Pro / Android 12）——
   *   · onCreate 里挂太早：那时 Tauri 的 WebView 还没建好（日志是 attachBridge not found）；
   *   · onResume **有时根本不触发**（锁屏期间启动就是这种），只靠它会出现"永远没桥"；
   *   · 但 WebView 是稍后（约 1~14 秒之间）才出现的。
   * 所以：内容视图一挂上就试，并且每隔 400ms 重试，最多 25 次（够覆盖冷启动）。
   */
  private fun attachBridgeSoon() {
    val content = findViewById<ViewGroup>(android.R.id.content)
    content?.addOnAttachStateChangeListener(object : android.view.View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: android.view.View) { attachBridge(-1) }
      override fun onViewDetachedFromWindow(v: android.view.View) {}
    })
    for (attempt in 1..25) {
      content?.postDelayed({ attachBridge(attempt) }, (attempt * 400).toLong())
    }
  }

  /**
   * 每次回到前台都确认一遍原生桥还在。
   *
   * 为什么放在 onResume 而不是 onCreate：WebView 是 Tauri 在 super.onCreate 里建的，
   * 但"什么时候真的挂到视图树上"取决于实现细节；onResume 时一定已经在了。
   * 而且从后台回来时页面可能被重建过，桥需要重新挂（addJavascriptInterface 可重复调用）。
   */
  override fun onResume() {
    super.onResume()
    // 每次回到前台都补挂一遍（从后台回来时页面可能被重建过）。
    // 首次挂载不依赖这里 —— 真机实测过 onResume 有时不触发。
    attachBridge(0)
  }

  override fun onDestroy() {
    bridge?.stop()
    super.onDestroy()
  }

  private fun findWebView(root: android.view.View?): WebView? {
    if (root == null) return null
    if (root is WebView) return root
    if (root is ViewGroup) {
      for (index in 0 until root.childCount) {
        val found = findWebView(root.getChildAt(index))
        if (found != null) return found
      }
    }
    return null
  }

  /** 列出视图树里**所有** WebView 及其地址 —— 用来确认"挂的是不是渲染页面的那个"。 */
  private fun collectWebViews(root: android.view.View?, out: MutableList<WebView>) {
    if (root == null) return
    if (root is WebView) { out.add(root); return }
    if (root is ViewGroup) {
      for (index in 0 until root.childCount) collectWebViews(root.getChildAt(index), out)
    }
  }

  private fun describeWebViews(): String {
    val found = ArrayList<WebView>()
    collectWebViews(window.decorView, found)
    if (found.isEmpty()) return "0 个 WebView"
    return found.mapIndexed { index, view ->
      "#" + index + " url=" + (view.url ?: "null")
    }.joinToString(" | ")
  }
}
`;

/** 给 AndroidManifest 补麦克风权限（幂等：已经有了就不动）。 */
function ensureMicPermissions() {
  if (!fs.existsSync(MANIFEST)) {
    console.log("没有 AndroidManifest.xml，跳过麦克风权限补丁。");
    return;
  }
  let manifest = fs.readFileSync(MANIFEST, "utf8");
  const missing = MIC_PERMISSIONS.filter((line) => manifest.indexOf(line) < 0);
  if (!missing.length) {
    console.log("Android 清单已带麦克风权限（RECORD_AUDIO / MODIFY_AUDIO_SETTINGS）。");
    return;
  }
  // 插在 INTERNET 那一行后面（保持权限集中，也避免插到 <application> 里面去）。
  const anchor = manifest.match(/^[ \t]*<uses-permission[^>]*android\.permission\.INTERNET[^>]*\/>[ \t]*$/m);
  const block = missing.map((line) => "    " + line).join("\n");
  if (anchor) {
    manifest = manifest.replace(anchor[0], anchor[0] + "\n" + block);
  } else {
    // 没找到锚点就插在 <application 之前（一定在 manifest 根元素内）。
    manifest = manifest.replace(/(<application\b)/, block + "\n\n    $1");
  }
  fs.writeFileSync(MANIFEST, manifest);
  console.log(`已给 Android 清单补上麦克风权限：${missing.length} 条（语音输入要用）。`);
}

function main() {
  ensureMicPermissions();
  if (!fs.existsSync(TARGET)) {
    console.log("没有 Android 工程（src-tauri/gen/android 不存在），跳过外壳补丁。");
    return;
  }
  const current = fs.readFileSync(TARGET, "utf8");
  // 补丁标志从"五毫米"换成更强的判据：同时要求避让与原生语音桥都在，
  // 否则只补了前半段的旧文件会被误判成"已经打过补丁"。
  const hasInset = current.indexOf(MARKER) >= 0;
  const hasTts = current.indexOf("__rwNativeTts") >= 0;
  if (hasInset && hasTts) {
    console.log("Android 外壳已是最新（摄像头避让 5 毫米 + 原生语音桥）。");
    return;
  }
  fs.writeFileSync(TARGET, PATCHED);
  console.log(`已重写 Android 外壳：${hasInset ? "" : "补上摄像头避让；"}${hasTts ? "" : "补上原生语音桥（系统 TTS）。"}`);
}

main();
