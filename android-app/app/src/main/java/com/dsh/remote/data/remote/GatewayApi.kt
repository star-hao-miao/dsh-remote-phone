package com.dsh.remote.data.remote

import com.dsh.remote.data.Device
import com.dsh.remote.data.GatewayCredentials
import com.dsh.remote.data.Message
import com.dsh.remote.data.Session
import com.dsh.remote.data.SessionDetail
import com.dsh.remote.data.Workspace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** A gateway-side failure (`{"ok":false,"error":{"code","message"}}`). */
class GatewayException(val code: String, message: String) : Exception(message)

/** Result of a successful pairing exchange. */
data class PairResult(val credentials: GatewayCredentials, val deviceId: String)

data class WorkspaceSnapshot(val items: List<Workspace>, val ready: Boolean)

/**
 * Thin REST client for the Remote Gateway (desktop-plugin/docs/API.md).
 *
 * All calls run on the IO dispatcher and translate the gateway's error
 * envelope into [GatewayException] so the UI can branch on `code`
 * (`invalid`, `expired`, `unused`, `harness-offline`, `unauthorized`, …).
 */
class GatewayApi(private val client: OkHttpClient = defaultClient()) {

    private val json = "application/json; charset=utf-8".toMediaType()

    // ── pairing ────────────────────────────────────────────────────────────

    suspend fun verifyPairing(baseUrl: String, code: String, deviceName: String, os: String): PairResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("code", code)
                .put("device", JSONObject().put("name", deviceName).put("os", os))
            val jsonObject = post("${trimBase(baseUrl)}/api/pair/verify", body, token = null)
            val token = jsonObject.optString("token")
            if (token.isEmpty()) throw GatewayException("invalid", "网关没有返回令牌")
            val expiresIn = jsonObject.optLong("expiresInMs", 30L * 24 * 60 * 60 * 1000)
            val device = jsonObject.optJSONObject("device")
            PairResult(
                credentials = GatewayCredentials(
                    baseUrl = trimBase(baseUrl),
                    token = token,
                    deviceName = device?.optString("name").orEmpty().ifEmpty { deviceName },
                    expiresAt = jsonObject.optLong("expiresAt", System.currentTimeMillis() + expiresIn),
                ),
                deviceId = device?.optString("id").orEmpty(),
            )
        }

    // ── data plane ─────────────────────────────────────────────────────────

    suspend fun listSessions(credentials: GatewayCredentials): List<Session> = withContext(Dispatchers.IO) {
        val root = get("${credentials.baseUrl}/api/sessions", credentials.token)
        val items = root.optJSONArray("items") ?: JSONArray()
        (0 until items.length()).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id")
            if (id.isEmpty()) return@mapNotNull null
            Session(
                id = id,
                title = item.optString("title"),
                updatedAt = item.optLong("updatedAt"),
                running = item.optBoolean("running"),
                blank = item.optBoolean("blank"),
                cwd = item.optString("cwd").ifEmpty { null },
                parentSessionId = item.optString("parentSessionId").ifEmpty { null },
            )
        }.sortedByDescending { it.updatedAt }
    }

    suspend fun sessionDetail(
        credentials: GatewayCredentials,
        sessionId: String,
        /** Cursor from a previous page: fetch the messages just before it. */
        beforeSeq: Long? = null,
    ): SessionDetail =
        withContext(Dispatchers.IO) {
            val suffix = if (beforeSeq != null) "?beforeSeq=$beforeSeq" else ""
            val root = get("${credentials.baseUrl}/api/sessions/$sessionId$suffix", credentials.token)
            val session = root.optJSONObject("session") ?: JSONObject()
            val transcript = session.optJSONArray("transcript") ?: JSONArray()
            val messages = (0 until transcript.length()).mapNotNull { index ->
                val item = transcript.optJSONObject(index) ?: return@mapNotNull null
                val text = item.optString("text")
                Message(
                    seq = item.optLong("seq"),
                    time = item.optLong("time"),
                    role = Message.roleOf(item.optString("role").ifEmpty { null }),
                    kind = item.optString("kind"),
                    text = text,
                    toolName = item.optString("toolName").ifEmpty { null },
                )
            }
            SessionDetail(
                id = session.optString("id", sessionId),
                messages = messages,
                hasMore = session.optBoolean("hasMore"),
                nextBeforeSeq = if (session.has("nextBeforeSeq")) session.optLong("nextBeforeSeq") else null,
            )
        }

    suspend fun sendMessage(
        credentials: GatewayCredentials,
        sessionId: String,
        content: String,
        mode: String = "queue",
    ): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("content", content).put("mode", mode)
        val root = post("${credentials.baseUrl}/api/sessions/$sessionId/message", body, credentials.token)
        root.optString("requestId")
    }

    /**
     * Permanently delete one conversation (`DELETE /api/sessions/:id`).
     *
     * The harness refuses while the session's agent is still live; that comes
     * back as `agent-busy` and is surfaced to the user unchanged.
     */
    suspend fun deleteSession(credentials: GatewayCredentials, sessionId: String): Unit =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url("${credentials.baseUrl}/api/sessions/$sessionId")
                .delete()
                .header("Authorization", "Bearer ${credentials.token}")
                .build()
            execute(request)
            Unit
        }

    suspend fun listWorkspaces(credentials: GatewayCredentials): WorkspaceSnapshot = withContext(Dispatchers.IO) {
        val root = get("${credentials.baseUrl}/api/workspaces", credentials.token)
        val items = root.optJSONArray("items") ?: JSONArray()
        WorkspaceSnapshot(
            items = (0 until items.length()).mapNotNull { index ->
                val item = items.optJSONObject(index) ?: return@mapNotNull null
                val id = item.optString("workspaceId")
                if (id.isEmpty()) return@mapNotNull null
                val sessions = item.optJSONArray("sessionIds") ?: JSONArray()
                val sessionIds = (0 until sessions.length()).mapNotNull { i -> sessions.optString(i).ifEmpty { null } }
                Workspace(
                    id = id,
                    title = item.optString("title").ifEmpty { id },
                    path = item.optString("path"),
                    sessionIds = sessionIds,
                    sessionCount = sessionIds.size,
                )
            },
            ready = root.optBoolean("ready"),
        )
    }

    /**
     * Create a session (`POST /api/sessions`), returning its id.
     *
     * `cwd` pins the new conversation to a project directory, which is also what
     * makes the drawer group it under that workspace instead of the harness's
     * default working directory.
     */
    suspend fun createSession(
        credentials: GatewayCredentials,
        workspaceId: String?,
        cwd: String? = null,
    ): String =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
            if (!workspaceId.isNullOrBlank()) body.put("workspaceId", workspaceId)
            if (!cwd.isNullOrBlank()) body.put("cwd", cwd)
            val root = post("${credentials.baseUrl}/api/sessions", body, credentials.token)
            root.optString("sessionId")
        }

    suspend fun switchWorkspace(credentials: GatewayCredentials, workspaceId: String): String =
        withContext(Dispatchers.IO) {
            val root = post("${credentials.baseUrl}/api/workspaces/$workspaceId/switch", JSONObject(), credentials.token)
            root.optString("sessionId")
        }

    suspend fun listDevices(credentials: GatewayCredentials): List<Device> = withContext(Dispatchers.IO) {
        val root = get("${credentials.baseUrl}/api/devices", credentials.token)
        val items = root.optJSONArray("items") ?: JSONArray()
        (0 until items.length()).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            Device(
                id = item.optString("id"),
                name = item.optString("name"),
                os = item.optString("os").ifEmpty { null },
                online = item.optBoolean("online"),
            )
        }
    }

    /** Answer an approval / question request pushed over `/ws`. */
    suspend fun answerInteraction(
        credentials: GatewayCredentials,
        eventId: String,
        decision: String,
    ): Unit = withContext(Dispatchers.IO) {
        val body = JSONObject().put("decision", decision)
        post("${credentials.baseUrl}/api/approvals/$eventId", body, credentials.token)
        Unit
    }

    // ── plumbing ───────────────────────────────────────────────────────────

    private fun get(url: String, token: String?): JSONObject {
        val builder = Request.Builder().url(url).get()
        if (token != null) builder.header("Authorization", "Bearer $token")
        return execute(builder.build())
    }

    private fun post(url: String, body: JSONObject, token: String?): JSONObject {
        val builder = Request.Builder().url(url).post(body.toString().toRequestBody(json))
        if (token != null) builder.header("Authorization", "Bearer $token")
        return execute(builder.build())
    }

    private fun execute(request: Request): JSONObject {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val parsed = runCatching { JSONObject(text) }.getOrNull()
                ?: throw GatewayException("bad-response", "网关返回了无法解析的内容（HTTP ${response.code}）")
            if (!parsed.optBoolean("ok")) {
                val error = parsed.optJSONObject("error")
                throw GatewayException(
                    code = error?.optString("code").orEmpty().ifEmpty { "http-${response.code}" },
                    message = error?.optString("message").orEmpty().ifEmpty { "请求失败（HTTP ${response.code}）" },
                )
            }
            return parsed
        }
    }

    companion object {
        private fun trimBase(baseUrl: String): String = baseUrl.trim().trimEnd('/')

        /**
         * Shared client for REST.
         *
         * NOTE: no `pingInterval` here. OkHttp's built-in ping task throws out
         * of its own task-runner thread when the peer vanished mid-write
         * (`ConnectionResetException`), which kills the Android process before
         * `onFailure` can run. Keepalive is therefore done at the application
         * layer inside [GatewaySocket], where every failure is contained.
         */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
