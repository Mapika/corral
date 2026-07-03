package io.github.mapika.corral

import android.content.Context
import android.content.Intent
import android.os.Build

// Rust <-> Android bridge for the pocket foreground service. Tauri exposes no Android context to
// app Rust code, so MainActivity hands us the application context once (CI patches the call in,
// pocket flavor only); nativeInit() gives pocket.rs the JavaVM + this class, and start/stop are
// plain static methods it calls back through JNI.
object PocketBridge {
  @Volatile private var appContext: Context? = null

  @JvmStatic
  fun init(context: Context) {
    appContext = context.applicationContext
    // Idempotent if Tauri already loaded it; guarantees nativeInit can resolve either way.
    try { System.loadLibrary("app_lib") } catch (e: Throwable) {}
    try { nativeInit() } catch (e: Throwable) {
      android.util.Log.w("PocketBridge", "nativeInit failed: " + e)
    }
  }

  @JvmStatic
  fun startService() {
    val ctx = appContext ?: return
    val intent = Intent(ctx, PocketService::class.java)
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
  }

  @JvmStatic
  fun stopService() {
    val ctx = appContext ?: return
    ctx.stopService(Intent(ctx, PocketService::class.java))
  }

  @JvmStatic private external fun nativeInit()
}
