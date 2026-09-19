package com.dsh.remote.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.dsh.remote.MainActivity
import com.dsh.remote.R
import com.dsh.remote.data.ConnectionState
import com.dsh.remote.data.GatewayEvent
import com.dsh.remote.data.remote.RemoteConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the gateway stream alive while the app is in the background and turns
 * approval requests into notifications.
 *
 * The service owns no connection of its own: it nudges the application-scoped
 * [RemoteConnection] and observes it. Swiping the app away therefore no longer
 * drops the link, which is the whole point of a remote control that lives in a
 * pocket.
 */
class RemoteConnectionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var observer: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val connection = RemoteConnection.get(application)
        if (!connection.hasCredentials()) {
            // Unpaired: nothing to keep alive.
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat(connection.state.value)
        connection.ensureRunning()
        observe(connection)
        // START_STICKY: if Android kills us under memory pressure, come back.
        return START_STICKY
    }

    private fun observe(connection: RemoteConnection) {
        observer?.cancel()
        observer = scope.launch {
            launch {
                connection.state.collect { state ->
                    if (state == ConnectionState.Unpaired) {
                        stopSelf()
                        return@collect
                    }
                    notify(connectionNotification(state, pendingApprovals = 0))
                }
            }
            launch {
                connection.events.collect { event ->
                    if (event is GatewayEvent.Interaction) {
                        notifyInteraction(event)
                    }
                }
            }
        }
    }

    /** A blocking approval needs the user now: separate, high-priority channel. */
    private fun notifyInteraction(event: GatewayEvent.Interaction) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val what = event.toolName?.takeIf { it.isNotBlank() } ?: if (event.kind == "approval") "工具调用" else "提问"
        val text = event.reason?.takeIf { it.isNotBlank() } ?: "在电脑上有一个请求等待你的决定"
        val notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(if (event.kind == "approval") "需要批准：$what" else "需要你的回答")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(event.sessionId))
            .build()
        runCatching { manager.notify(event.id.hashCode(), notification) }
    }

    private fun connectionNotification(state: ConnectionState, pendingApprovals: Int): Notification {
        val label = when (state) {
            ConnectionState.Online -> "已连接到电脑"
            ConnectionState.Connecting -> "正在连接电脑…"
            ConnectionState.Offline -> "与电脑的连接已断开，正在重连"
            ConnectionState.Unpaired -> "未配对"
        }
        return NotificationCompat.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("DSH Remote")
            .setContentText(label)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openAppIntent(null))
            .build()
    }

    private fun openAppIntent(sessionId: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (sessionId != null) putExtra(MainActivity.EXTRA_SESSION_ID, sessionId)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(this, sessionId?.hashCode() ?: 0, intent, flags)
    }

    private fun startForegroundCompat(state: ConnectionState) {
        val notification = connectionNotification(state, pendingApprovals = 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notify(notification: Notification) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val status = NotificationChannel(CHANNEL_STATUS, "连接状态", NotificationManager.IMPORTANCE_LOW).apply {
            description = "DSH Remote 与电脑之间的连接状态"
        }
        val alerts = NotificationChannel(CHANNEL_ALERTS, "审批与提问", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "电脑上的工具审批或提问需要你处理"
        }
        runCatching { manager.createNotificationChannels(listOf(status, alerts)) }
    }

    override fun onDestroy() {
        observer?.cancel()
        observer = null
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_STATUS = "dsh-remote-status"
        private const val CHANNEL_ALERTS = "dsh-remote-alerts"
        private const val NOTIFICATION_ID = 4101

        /** Start (or refresh) the keepalive service; no-op when unpaired. */
        fun start(context: Context) {
            val intent = Intent(context, RemoteConnectionService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, RemoteConnectionService::class.java)) }
        }
    }
}
