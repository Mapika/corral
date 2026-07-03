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

// Foreground service for pocket mode: keeps the app process out of the cached state while the
// on-device backend runs, so Android's phantom-process killer leaves the node child alone
// (Termux's model). The service owns no process — pocket.rs does; this is purely a lifecycle
// anchor plus the mandatory notification. specialUse (not dataSync) because Android 15 caps
// dataSync at 6h/day, and an agent run has no such budget.
//
// Committed under src-tauri/android/ and copied into the generated project by CI (pocket flavor
// only) — `tauri android init` regenerates gen/android from templates on every build.
class PocketService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val ch = NotificationChannel(CHANNEL, "On-device backend", NotificationManager.IMPORTANCE_LOW)
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val n: Notification = Notification.Builder(this, CHANNEL)
      .setContentTitle("Corral is running on this phone")
      .setContentText("Agents keep working while the app is in the background.")
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(1, n)
    }
    return START_STICKY
  }

  companion object {
    private const val CHANNEL = "pocket"
  }
}
