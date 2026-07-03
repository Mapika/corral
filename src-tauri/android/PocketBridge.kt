package io.github.mapika.corral

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.Keep

// Rust <-> Android bridge for the pocket foreground service. Tauri exposes no Android context to
// app Rust code, so MainActivity hands us the application context once (CI patches the call in,
// pocket flavor only); nativeInit() gives pocket.rs the JavaVM + this class, and start/stop are
// plain static methods it calls back through JNI.
//
// @Keep on every JNI entry point: start/stop/nativeInit have no Java-visible caller, so R8
// strips them (NoSuchMethodError on-device) unless told otherwise. @Keep rides the default
// proguard config, which is reliably wired — unlike a standalone rules file the tauri template
// may or may not glob in.
@Keep
object PocketBridge {
  @Volatile private var appContext: Context? = null

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

  @JvmStatic @Keep private external fun nativeInit()
}
