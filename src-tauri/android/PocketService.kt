package io.github.mapika.corral

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Foreground service for pocket mode: keeps the app process out of the cached state while the
// on-device backend runs, so Android's phantom-process killer leaves the node child alone
// (Termux's model). The service owns no process — pocket.rs does; this is purely a lifecycle
// anchor plus the mandatory notification. specialUse (not dataSync) because Android 15 caps
// dataSync at 6h/day, and an agent run has no such budget.
//
// Committed under src-tauri/android/ and copied into the generated project by CI (pocket flavor
// only) — `tauri android init` regenerates gen/android from templates on every build.
class PocketService : Service() {
  // The FGS keeps the process un-cached but not the CPU awake: under Doze a long screen-off agent
  // run stalls mid-inference. Held only while agents actually work — PocketBridge.setActive
  // re-delivers onStartCommand with the busy state, so an idle herd costs no battery. An idle
  // node may freeze under Doze; it thaws on next use.
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val ch = NotificationChannel(CHANNEL, "On-device backend", NotificationManager.IMPORTANCE_LOW)
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Default false: the first start (and a START_STICKY resurrection, null intent) begins
    // idle — the Rust watchdog raises it within seconds if agents are actually working.
    val active = intent?.getBooleanExtra("active", false) ?: false
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val n: Notification = Notification.Builder(this, CHANNEL)
      .setContentTitle("Corral is running on this phone")
      .setContentText(if (active) "Agents are working — they keep going with the screen off."
                      else "Idle — ranch an agent and it runs right here.")
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(1, n)
    }
    if (active) {
      if (wakeLock == null) {
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "corral:pocket")
          .apply { setReferenceCounted(false); acquire() }
      }
    } else {
      wakeLock?.release()
      wakeLock = null
    }
    return START_STICKY
  }

  override fun onDestroy() {
    wakeLock?.release()
    wakeLock = null
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "pocket"
  }
}
