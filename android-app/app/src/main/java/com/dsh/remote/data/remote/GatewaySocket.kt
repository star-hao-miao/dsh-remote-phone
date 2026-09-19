package com.dsh.remote.data.remote

import com.dsh.remote.data.GatewayCredentials
import com.dsh.remote.data.GatewayEvent
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Live event stream from the gateway: `GET /ws?token=<JWT>`.
 *
 * Robustness rules learned the hard way:
 *  * Keepalive is an **application-level** `{"type":"ping"}` frame sent from a
 *    coroutine we own — OkHttp's `pingInterval` writes from its own task-runner
 *    thread, and a reset socket there throws an uncaught exception that kills
 *    the process before `onFailure` is reached.
 *  * Every listener callback and every send is wrapped, so a vanishing desktop
 *    can never crash the app; the stream simply ends and the ViewModel
 *    reconnects with backoff.
 */
class GatewaySocket(private val client: OkHttpClient) {

    private companion object {
        const val PING_INTERVAL_MS = 20_000L
    }

    fun events(credentials: GatewayCredentials): Flow<GatewayEvent> = callbackFlow {
        val wsUrl = credentials.baseUrl
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
            .trimEnd('/') + "/ws?token=" + credentials.token

        val request = Request.Builder().url(wsUrl).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                runCatching { trySend(GatewayEvent.Connected) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { parse(text)?.let { trySend(it) } }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                runCatching { trySend(GatewayEvent.Disconnected) }
                runCatching { close() }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                runCatching { trySend(GatewayEvent.Disconnected) }
                runCatching { close() }
            }
        }

        val socket = runCatching { client.newWebSocket(request, listener) }.getOrNull()
        if (socket == null) {
            trySend(GatewayEvent.Disconnected)
            close()
            return@callbackFlow
        }

        // Application-level keepalive: send a ping frame, ignore any failure
        // (the read side will report the disconnect).
        val pinger = launch {
            while (true) {
                delay(PING_INTERVAL_MS)
                runCatching { socket.send("{\"type\":\"ping\"}") }
            }
        }

        awaitClose {
            pinger.cancel()
            runCatching { socket.cancel() }
        }
    }

    private fun parse(text: String): GatewayEvent? {
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return null
        return when (frame.optString("type")) {
            "hello" -> GatewayEvent.Hello(pendingInteractions(frame.optJSONArray("interactions")))
            "session.status" -> GatewayEvent.SessionStatus(
                sessionId = frame.optString("sessionId"),
                running = frame.optBoolean("running"),
            )
            "session.activity" -> GatewayEvent.SessionActivity(
                sessionId = frame.optString("sessionId"),
                updatedAt = frame.optLong("updatedAt"),
            )
            "session.added" -> GatewayEvent.SessionAdded(frame.optString("sessionId").ifEmpty { null })
            "session.removed" -> GatewayEvent.SessionRemoved(frame.optString("sessionId"))
            "session.error" -> GatewayEvent.SessionError(
                sessionId = frame.optString("sessionId"),
                message = frame.optString("message").ifEmpty { null },
            )
            "workspaces" -> GatewayEvent.Workspaces(sessionsDirty = true)
            "interaction.request" -> GatewayEvent.Interaction(
                id = frame.optString("id"),
                kind = frame.optString("kind"),
                sessionId = frame.optString("sessionId"),
                toolName = frame.optString("toolName").ifEmpty { null },
                reason = frame.optString("reason").ifEmpty { null },
            )
            else -> null
        }
    }

    /** The `interactions` array carried by the gateway's `hello` frame. */
    private fun pendingInteractions(array: org.json.JSONArray?): List<GatewayEvent.Interaction> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id")
            if (id.isEmpty()) return@mapNotNull null
            GatewayEvent.Interaction(
                id = id,
                kind = item.optString("kind"),
                sessionId = item.optString("sessionId"),
                toolName = item.optString("toolName").ifEmpty { null },
                reason = item.optString("reason").ifEmpty { null },
            )
        }
    }
}
