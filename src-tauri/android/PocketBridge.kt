package io.github.mapika.corral

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.provider.OpenableColumns
import androidx.annotation.Keep
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

// Rust <-> Android bridge for the pocket runtime. Tauri exposes no Android context to app Rust
// code, so MainActivity hands us the application context once (CI patches the call in, pocket
// flavor only); nativeInit() gives pocket.rs the JavaVM + this class, and everything else is
// plain static methods it calls back through JNI.
//
// @Keep on every JNI entry point: start/stop/nativeInit have no Java-visible caller, so R8
// strips them (NoSuchMethodError on-device) unless told otherwise. @Keep rides the default
// proguard config, which is reliably wired — unlike a standalone rules file the tauri template
// may or may not glob in.
@Keep
object PocketBridge {
  @Volatile private var appContext: Context? = null
  @Volatile private var pendingShare: String? = null

  @JvmStatic @Keep
  fun init(context: Context) {
    appContext = context.applicationContext
    // Idempotent if Tauri already loaded it; guarantees nativeInit can resolve either way.
    try { System.loadLibrary("app_lib") } catch (e: Throwable) {}
    try { nativeInit() } catch (e: Throwable) {
      android.util.Log.w("PocketBridge", "nativeInit failed: " + e)
    }
  }

  @JvmStatic @Keep
  fun startService() {
    val ctx = appContext ?: return
    val intent = Intent(ctx, PocketService::class.java)
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
  }

  @JvmStatic @Keep
  fun stopService() {
    val ctx = appContext ?: return
    ctx.stopService(Intent(ctx, PocketService::class.java))
  }

  // Wakelock policy: the Rust watchdog flips this with the herd's busy state so the CPU is
  // pinned only while agents actually work (delivered as a re-start so the notification and
  // the lock update together in onStartCommand).
  @JvmStatic @Keep
  fun setActive(active: Boolean) {
    val ctx = appContext ?: return
    val intent = Intent(ctx, PocketService::class.java).putExtra("active", active)
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
  }

  // --- Share -> Corral ------------------------------------------------------------------
  // MainActivity forwards SEND/SEND_MULTIPLE intents here (CI patches the calls in). Text
  // rides as-is; content: streams are copied into the agent HOME (~/shared) so a session can
  // read them by path. The webview polls takeShared() on mount/resume and turns the payload
  // into a prefilled launch.
  @JvmStatic @Keep
  @Suppress("DEPRECATION")
  fun offerShared(ctx: Context, intent: Intent?) {
    intent ?: return
    val action = intent.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    try {
      val obj = JSONObject()
      intent.getStringExtra(Intent.EXTRA_SUBJECT)?.let { obj.put("subject", it) }
      intent.getStringExtra(Intent.EXTRA_TEXT)?.let { obj.put("text", it) }
      val uris = ArrayList<Uri>()
      if (action == Intent.ACTION_SEND) {
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
      } else {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
      }
      if (uris.isNotEmpty()) {
        val dir = File(ctx.filesDir, "pocket/home/shared").apply { mkdirs() }
        val files = JSONArray()
        for (u in uris) {
          try {
            val name = displayName(ctx, u) ?: ("shared-" + System.currentTimeMillis())
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "shared" }
            var f = File(dir, safe)
            var i = 1
            while (f.exists()) f = File(dir, "${i++}-$safe")
            ctx.contentResolver.openInputStream(u)?.use { ins -> f.outputStream().use { ins.copyTo(it) } }
            files.put(f.absolutePath)
          } catch (e: Throwable) {
            android.util.Log.w("PocketBridge", "share copy failed: " + e)
          }
        }
        if (files.length() > 0) obj.put("files", files)
      }
      if (obj.length() > 0) pendingShare = obj.toString()
    } catch (e: Throwable) {
      android.util.Log.w("PocketBridge", "offerShared failed: " + e)
    }
  }

  private fun displayName(ctx: Context, u: Uri): String? = try {
    ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    }
  } catch (e: Throwable) { null }

  @JvmStatic @Keep
  fun takeShared(): String? {
    val p = pendingShare
    pendingShare = null
    return p
  }

  // --- `phone` CLI verbs ----------------------------------------------------------------
  // One JNI entry point, verbs dispatched here; always returns a JSON string. Everything is
  // best-effort with honest errors — background-start rules (open/share) and clipboard
  // restrictions vary by Android version and OEM.
  @JvmStatic @Keep
  fun phone(verb: String, a: String, b: String): String {
    val ctx = appContext ?: return err("bridge has no context")
    return try {
      when (verb) {
        "notify" -> {
          val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
          if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel("agent") == null) {
            nm.createNotificationChannel(NotificationChannel("agent", "Agent messages", NotificationManager.IMPORTANCE_DEFAULT))
          }
          val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
            PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE)
          }
          val n: Notification = Notification.Builder(ctx, "agent")
            .setContentTitle(a.ifEmpty { "Corral agent" })
            .setContentText(b)
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
          nm.notify((System.currentTimeMillis() % 100000).toInt(), n)
          ok()
        }
        "battery" -> {
          val bi = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
          val level = bi?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
          val scale = bi?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
          val status = bi?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
          val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
          val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
          """{"ok":true,"percent":$pct,"charging":$charging}"""
        }
        "open" -> {
          ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          ok()
        }
        "share" -> {
          val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, a)
          ctx.startActivity(Intent.createChooser(send, "Share from Corral").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          ok()
        }
        "clip-set" -> {
          val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          cm.setPrimaryClip(ClipData.newPlainText("corral", a))
          ok()
        }
        "clip-get" -> {
          val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          val t = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString()
            ?: return err("clipboard empty or not readable from the background")
          JSONObject().put("ok", true).put("text", t).toString()
        }
        else -> err("unknown verb '$verb'")
      }
    } catch (e: Throwable) {
      err(e.toString())
    }
  }

  private fun ok() = """{"ok":true}"""
  private fun err(m: String) = JSONObject().put("ok", false).put("error", m).toString()

  @JvmStatic @Keep private external fun nativeInit()
}
