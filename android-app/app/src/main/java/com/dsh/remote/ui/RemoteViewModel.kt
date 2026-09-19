package com.dsh.remote.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.dsh.remote.data.ConnectionState
import com.dsh.remote.data.Device
import com.dsh.remote.data.GatewayCredentials
import com.dsh.remote.data.GatewayEvent
import com.dsh.remote.data.Message
import com.dsh.remote.data.Session
import com.dsh.remote.data.SessionDetail
import com.dsh.remote.data.Workspace
import com.dsh.remote.data.local.Appearance
import com.dsh.remote.data.local.AppearanceStore
import com.dsh.remote.data.local.CredentialStore
import com.dsh.remote.data.remote.GatewayApi
import com.dsh.remote.data.remote.GatewayException
import com.dsh.remote.data.remote.RemoteConnection
import com.dsh.remote.service.RemoteConnectionService
import com.dsh.remote.ui.pair.extractBase
import com.dsh.remote.ui.pair.extractCode
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One pending approval / question pushed by the gateway. */
data class PendingInteraction(
    val id: String,
    val kind: String,
    val sessionId: String,
    val toolName: String?,
    val reason: String?,
)

data class UiState(
    val connection: ConnectionState = ConnectionState.Unpaired,
    val credentials: GatewayCredentials? = null,
    val sessions: List<Session> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
    val currentWorkspaceId: String? = null,
    /** Sessions-tab filter: a workspace id, or null for "all sessions". */
    val sessionFilter: String? = null,
    val devices: List<Device> = emptyList(),
    val detail: SessionDetail? = null,
    val loadingEarlier: Boolean = false,
    val interactions: List<PendingInteraction> = emptyList(),
    val busy: Boolean = false,
    val lastError: String? = null,
    /** Set when a send is rejected, so the UI can react (reference: "angry"). */
    val sendFailed: Boolean = false,
    /** Appearance preferences (theme / font scale / character layer). */
    val appearance: Appearance = Appearance(),
)

/**
 * Application state holder: pairs once, then keeps sessions / workspaces /
 * transcript in sync with the gateway over REST + WebSocket.
 */
class RemoteViewModel(application: Application) : AndroidViewModel(application) {

    private val store = CredentialStore(application)
    private val appearanceStore = AppearanceStore(application)
    private val api = GatewayApi()

    /**
     * The socket is owned by an application-scoped holder (see
     * [RemoteConnection]) so the foreground service and the UI share exactly one
     * connection; this ViewModel only observes it.
     */
    private val connection = RemoteConnection.get(application)

    private val _state = MutableStateFlow(UiState(appearance = appearanceStore.load()))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var observerJob: Job? = null
    /** Timestamp of the last transcript fetch, for the refresh throttle. */
    private var lastDetailRefreshAt = 0L
    /** True while a trailing (throttled) refresh is already queued. */
    private var detailRefreshQueued = false
    private var burstJob: Job? = null

    init {
        val saved = store.load()
        if (saved != null) {
            _state.value = _state.value.copy(connection = ConnectionState.Connecting, credentials = saved)
            refreshAll()
            connection.ensureRunning()
            RemoteConnectionService.start(application)
        }
        observeConnection()
    }

    // ── appearance (reference UI's theme / font-scale / character knobs) ────

    fun updateAppearance(transform: (Appearance) -> Appearance) {
        val next = transform(_state.value.appearance)
        appearanceStore.save(next)
        _state.value = _state.value.copy(appearance = next)
    }

    fun clearSendFailed() {
        if (_state.value.sendFailed) _state.value = _state.value.copy(sendFailed = false)
    }

    // ── pairing ────────────────────────────────────────────────────────────

    /** Accepts the scanned paste link: `https://host:3080/pair?code=XXXX`. */
    fun pairFromLink(link: String) {
        val base = extractBase(link)
        val code = extractCode(link)
        if (base.isEmpty() || code.isEmpty()) {
            _state.value = _state.value.copy(lastError = "无法从链接里解析出网关地址与配对码")
            return
        }
        pair(base, code)
    }

    fun pair(baseUrl: String, code: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, connection = ConnectionState.Connecting, lastError = null)
            try {
                val result = api.verifyPairing(
                    baseUrl = baseUrl,
                    code = code,
                    deviceName = android.os.Build.MODEL ?: "Android",
                    os = "Android ${android.os.Build.VERSION.RELEASE}",
                )
                store.save(result.credentials)
                _state.value = _state.value.copy(
                    credentials = result.credentials,
                    connection = ConnectionState.Connecting,
                    busy = false,
                    lastError = null,
                )
                refreshAll()
                // Hand the fresh credentials to the shared connection, then let
                // the foreground service keep it alive from here on.
                connection.restart()
                RemoteConnectionService.start(getApplication())
            } catch (error: GatewayException) {
                _state.value = _state.value.copy(
                    connection = ConnectionState.Unpaired,
                    busy = false,
                    lastError = friendly(error),
                )
            } catch (error: Exception) {
                _state.value = _state.value.copy(
                    connection = ConnectionState.Unpaired,
                    busy = false,
                    lastError = "连接失败：${error.message ?: error.javaClass.simpleName}",
                )
            }
        }
    }

    fun unpair() {
        burstJob?.cancel()
        burstJob = null
        // Clears the stored credentials, closes the socket and stops the
        // keepalive service, so a revoked/removed pairing leaves nothing behind.
        connection.clear()
        RemoteConnectionService.stop(getApplication())
        _state.value = UiState()
    }

    // ── data loading ───────────────────────────────────────────────────────

    fun refreshAll() {
        val credentials = _state.value.credentials ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true)
            try {
                val workspaces = api.listWorkspaces(credentials)
                val sessions = api.listSessions(credentials)
                val devices = runCatching { api.listDevices(credentials) }.getOrDefault(emptyList())
                _state.value = _state.value.copy(
                    connection = ConnectionState.Online,
                    workspaces = workspaces.items,
                    currentWorkspaceId = _state.value.currentWorkspaceId ?: workspaces.items.firstOrNull()?.id,
                    sessions = sessions,
                    devices = devices,
                    busy = false,
                    lastError = null,
                )
            } catch (error: GatewayException) {
                val connection = if (error.code == "unauthorized") ConnectionState.Unpaired else ConnectionState.Offline
                if (connection == ConnectionState.Unpaired) store.clear()
                _state.value = _state.value.copy(connection = connection, busy = false, lastError = friendly(error))
            } catch (error: Exception) {
                _state.value = _state.value.copy(
                    connection = ConnectionState.Offline,
                    busy = false,
                    lastError = "加载失败：${error.message ?: error.javaClass.simpleName}",
                )
            }
        }
    }

    fun openSession(sessionId: String) {
        val credentials = _state.value.credentials ?: return
        lastDetailRefreshAt = 0L
        detailRefreshQueued = false
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, detail = null)
            try {
                val detail = api.sessionDetail(credentials, sessionId)
                lastDetailRefreshAt = System.currentTimeMillis()
                _state.value = _state.value.copy(detail = detail, busy = false, lastError = null)
            } catch (error: Exception) {
                _state.value = _state.value.copy(busy = false, lastError = "读取会话失败：${error.message}")
            }
        }
    }

    /**
     * Keep the open transcript live.
     *
     * The gateway pushes one `session.activity` event per appended record, so a
     * naive refetch per event would hammer the harness while the agent streams.
     * This is a leading-edge throttle with a single trailing refresh: bursts
     * collapse into at most one fetch per [REFRESH_MIN_INTERVAL_MS], and the
     * last event of a burst always gets one.
     */
    private fun requestDetailRefresh(sessionId: String) {
        if (_state.value.detail?.id != sessionId) return
        val elapsed = System.currentTimeMillis() - lastDetailRefreshAt
        if (elapsed >= REFRESH_MIN_INTERVAL_MS) {
            viewModelScope.launch { fetchDetail(sessionId) }
            return
        }
        if (detailRefreshQueued) return
        detailRefreshQueued = true
        viewModelScope.launch {
            delay(REFRESH_MIN_INTERVAL_MS - elapsed)
            detailRefreshQueued = false
            fetchDetail(sessionId)
        }
    }

    private suspend fun fetchDetail(sessionId: String) {
        val credentials = _state.value.credentials ?: return
        // The user may have navigated away while this was in flight.
        if (_state.value.detail?.id != sessionId) return
        runCatching { api.sessionDetail(credentials, sessionId) }
            .onSuccess { page ->
                lastDetailRefreshAt = System.currentTimeMillis()
                val current = _state.value.detail?.takeIf { it.id == sessionId } ?: return@onSuccess
                // Keep the older pages the user already scrolled back to: they
                // all sit before the first message of the fresh (newest) page.
                val boundary = page.messages.firstOrNull()?.seq
                val older = if (boundary == null) {
                    emptyList()
                } else {
                    current.messages.filter { it.seq < boundary && !it.pending }
                }
                // Keep a locally echoed message until the harness records it.
                // It is NOT enough to drop pending entries on every refresh: in
                // `queue` mode a message stays invisible in the session log
                // until the running turn ends, so the bubble would vanish for
                // minutes right after sending.
                val confirmedUserTexts = page.messages
                    .filter { it.role == Message.Role.User }
                    .map { it.text.trim() }
                val stillPending = current.messages.filter { message ->
                    message.pending &&
                        message.text.trim() !in confirmedUserTexts &&
                        System.currentTimeMillis() - message.time < PENDING_ECHO_TTL_MS
                }
                val merged = (older + page.messages + stillPending).distinctBy { it.seq }.sortedBy { it.seq }
                _state.value = _state.value.copy(
                    detail = page.copy(
                        messages = merged,
                        hasMore = if (older.isEmpty()) page.hasMore else current.hasMore,
                        nextBeforeSeq = if (older.isEmpty()) page.nextBeforeSeq else current.nextBeforeSeq,
                    ),
                    lastError = null,
                )
            }
    }

    /**
     * After sending, pull the transcript a few times: the echo of the user
     * message, then the assistant turn. This also covers a dead WebSocket,
     * where no activity event would ever arrive.
     */
    private fun schedulePostSendRefresh(sessionId: String, offsetsMs: List<Long>) {
        burstJob?.cancel()
        burstJob = viewModelScope.launch {
            for (offset in offsetsMs) {
                delay(offset)
                fetchDetail(sessionId)
            }
        }
    }

    fun clearDetail() {
        _state.value = _state.value.copy(detail = null, loadingEarlier = false)
    }

    /** Sessions-tab filter chip: a workspace id, or null for "all sessions". */
    fun setSessionFilter(workspaceId: String?) {
        _state.value = _state.value.copy(sessionFilter = workspaceId)
    }

    /**
     * Start a fresh session — in the workspace currently filtered on screen,
     * else the active workspace — then hand its id back so the caller can
     * navigate straight into it.
     *
     * The workspace's directory is passed along as `cwd` as well: without it the
     * harness falls back to its own working directory (the user's home), and the
     * new conversation lands in a "C:\Users\<name>" folder instead of under the
     * project it belongs to.
     */
    fun createSession(onCreated: (String) -> Unit) {
        val credentials = _state.value.credentials ?: return
        val state = _state.value
        val workspace = state.workspaces.firstOrNull {
            it.id == (state.sessionFilter ?: state.currentWorkspaceId)
        }
        val cwd = workspace?.path?.takeIf { it.isNotBlank() }
            ?: state.detail?.id?.let { open ->
                state.sessions.firstOrNull { it.id == open }?.cwd
            }
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, lastError = null)
            try {
                val sessionId = api.createSession(credentials, workspace?.id, cwd)
                if (sessionId.isEmpty()) {
                    _state.value = _state.value.copy(busy = false, lastError = "新建会话失败：网关未返回会话 ID")
                    return@launch
                }
                refreshAll()
                openSession(sessionId)
                onCreated(sessionId)
            } catch (error: Exception) {
                _state.value = _state.value.copy(busy = false, lastError = "新建会话失败：${error.message}")
            }
        }
    }

    /**
     * Prepend the previous page of the open transcript.
     *
     * The cursor is the sequence of the oldest message on screen; the harness
     * returns the records just before it. Results are merged by sequence so an
     * inclusive boundary cannot duplicate a message.
     */
    fun loadEarlier(sessionId: String) {
        val credentials = _state.value.credentials ?: return
        val detail = _state.value.detail?.takeIf { it.id == sessionId } ?: return
        if (_state.value.loadingEarlier) return
        val cursor = detail.nextBeforeSeq ?: detail.messages.firstOrNull()?.seq ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(loadingEarlier = true)
            try {
                val page = api.sessionDetail(credentials, sessionId, beforeSeq = cursor)
                val current = _state.value.detail?.takeIf { it.id == sessionId } ?: return@launch
                val merged = (page.messages + current.messages)
                    .distinctBy { it.seq }
                    .sortedBy { it.seq }
                _state.value = _state.value.copy(
                    detail = current.copy(
                        messages = merged,
                        hasMore = page.hasMore,
                        nextBeforeSeq = page.nextBeforeSeq ?: page.messages.firstOrNull()?.seq,
                    ),
                    loadingEarlier = false,
                    lastError = null,
                )
            } catch (error: Exception) {
                _state.value = _state.value.copy(loadingEarlier = false, lastError = "加载更早的消息失败：${error.message}")
            }
        }
    }

    fun sendMessage(sessionId: String, content: String) {
        val credentials = _state.value.credentials ?: return
        if (content.isBlank()) return
        viewModelScope.launch {
            // Optimistic echo so the composer feels immediate; the authoritative
            // transcript arrives with the next refresh / activity event.
            val optimistic = Message(
                seq = Long.MAX_VALUE,
                time = System.currentTimeMillis(),
                role = Message.Role.User,
                kind = "user/message",
                text = content,
                pending = true,
            )
            _state.value = _state.value.copy(
                detail = _state.value.detail?.let { it.copy(messages = it.messages + optimistic) },
                lastError = null,
            )
            try {
                api.sendMessage(credentials, sessionId, content)
                _state.value = _state.value.copy(sendFailed = false)
                schedulePostSendRefresh(sessionId, listOf(600, 1_800, 4_000, 8_000))
            } catch (error: Exception) {
                _state.value = _state.value.copy(sendFailed = true, lastError = "发送失败：${error.message}")
            }
        }
    }

    /**
     * Delete a conversation for good (`DELETE /api/sessions/:id`).
     *
     * The harness refuses with `agent-busy` while the agent is still running, so
     * the row-level error string is what the UI shows.
     */
    fun deleteSession(sessionId: String, onDeleted: (String) -> Unit = {}) {
        val credentials = _state.value.credentials ?: return
        viewModelScope.launch {
            try {
                api.deleteSession(credentials, sessionId)
                if (_state.value.detail?.id == sessionId) {
                    _state.value = _state.value.copy(detail = null)
                }
                _state.value = _state.value.copy(
                    sessions = _state.value.sessions.filterNot { it.id == sessionId },
                    interactions = _state.value.interactions.filterNot { it.sessionId == sessionId },
                    lastError = null,
                )
                onDeleted(sessionId)
                refreshAll()
            } catch (error: GatewayException) {
                _state.value = _state.value.copy(lastError = deleteErrorText(error))
            } catch (error: Exception) {
                _state.value = _state.value.copy(lastError = "删除失败：${error.message}")
            }
        }
    }

    private fun deleteErrorText(error: GatewayException): String = when (error.code) {
        "agent-busy" -> "这个对话还在运行，等它停下来再删"
        "not-found" -> "这个对话已经不存在了"
        else -> "删除失败：${error.message ?: error.code}"
    }

    fun selectWorkspace(workspaceId: String) {
        val credentials = _state.value.credentials ?: return
        if (_state.value.currentWorkspaceId == workspaceId) return
        viewModelScope.launch {
            try {
                api.switchWorkspace(credentials, workspaceId)
                _state.value = _state.value.copy(currentWorkspaceId = workspaceId)
                refreshAll()
            } catch (error: Exception) {
                _state.value = _state.value.copy(lastError = "切换工作区失败：${error.message}")
            }
        }
    }

    fun answerInteraction(id: String, decision: String) {
        val credentials = _state.value.credentials ?: return
        viewModelScope.launch {
            try {
                api.answerInteraction(credentials, id, decision)
                connection.forgetInteraction(id)
                _state.value = _state.value.copy(interactions = _state.value.interactions.filterNot { it.id == id })
            } catch (error: Exception) {
                _state.value = _state.value.copy(lastError = "审批提交失败：${error.message}")
            }
        }
    }

    // ── live events ────────────────────────────────────────────────────────

    /**
     * Mirror the shared connection into UI state. Reconnection belongs to
     * [RemoteConnection]; this only reflects it and folds events into the
     * screens.
     */
    private fun observeConnection() {
        observerJob?.cancel()
        observerJob = viewModelScope.launch {
            launch {
                connection.state.collect { state ->
                    // Never regress the UI to "Unpaired" from a transient drop:
                    // the pairing gate is owned by the credentials screen.
                    if (state.connectionIsUsable()) {
                        _state.value = _state.value.copy(connection = state)
                    } else if (_state.value.credentials == null) {
                        _state.value = _state.value.copy(connection = ConnectionState.Unpaired)
                    }
                }
            }
            launch {
                // State, not an event: this delivers the current pending list
                // immediately, even if the socket (and its `hello` frame) was
                // already established by the foreground service.
                connection.pending.collect { pending ->
                    _state.value = _state.value.copy(
                        interactions = pending.map { item ->
                            PendingInteraction(
                                id = item.id,
                                kind = item.kind,
                                sessionId = item.sessionId,
                                toolName = item.toolName,
                                reason = item.reason,
                            )
                        },
                    )
                }
            }
            launch {
                connection.events.collect { event ->
                    when (event) {
                        // Pending list is mirrored from `connection.pending`.
                        is GatewayEvent.Hello -> {
                            _state.value = _state.value.copy(connection = ConnectionState.Online)
                        }
                        is GatewayEvent.Connected -> {
                            _state.value = _state.value.copy(connection = ConnectionState.Online)
                        }
                        is GatewayEvent.Disconnected -> {
                            _state.value = _state.value.copy(connection = ConnectionState.Offline)
                        }
                        is GatewayEvent.SessionStatus -> updateSession(event.sessionId) { it.copy(running = event.running) }
                        is GatewayEvent.SessionActivity -> updateSession(event.sessionId) { it.copy(updatedAt = event.updatedAt) }
                        is GatewayEvent.SessionRemoved -> {
                            _state.value = _state.value.copy(sessions = _state.value.sessions.filterNot { it.id == event.sessionId })
                        }
                        is GatewayEvent.SessionAdded -> refreshAll()
                        is GatewayEvent.Workspaces -> refreshAll()
                        // Interactions are mirrored through `connection.pending`.
                        is GatewayEvent.Interaction -> Unit
                        is GatewayEvent.SessionError -> {
                            _state.value = _state.value.copy(lastError = event.message ?: "会话出错")
                        }
                    }
                }
            }
        }
    }

    private fun ConnectionState.connectionIsUsable(): Boolean = this != ConnectionState.Unpaired

    private fun updateSession(sessionId: String, transform: (Session) -> Session) {
        val sessions = _state.value.sessions.map { if (it.id == sessionId) transform(it) else it }
        _state.value = _state.value.copy(sessions = sessions)
        // Live agent output reaches the phone through these events: pull the
        // transcript (throttled) whenever the session on screen changed.
        requestDetailRefresh(sessionId)
    }

    private fun friendly(error: GatewayException): String = when (error.code) {
        "invalid" -> "配对码不正确"
        "used-up" -> "该配对码已被使用，请在电脑上重新生成"
        "expired" -> "配对码已过期，请在电脑上重新生成"
        "throttled" -> "尝试过于频繁，请稍后再试"
        "unauthorized" -> "配对凭据已失效，请重新扫码"
        "harness-offline" -> "电脑上的 harness 数据面未连接"
        "lan-unavailable" -> "请在电脑面板里启用局域网模式"
        "tunnel-offline" -> "电脑上的公网隧道未开启"
        else -> error.message ?: error.code
    }

    override fun onCleared() {
        // Only the observers stop here: the connection itself is application
        // scoped and keeps running behind the foreground service.
        observerJob?.cancel()
        burstJob?.cancel()
        super.onCleared()
    }

    private companion object {
        /** Minimum gap between two transcript fetches of the open session. */
        const val REFRESH_MIN_INTERVAL_MS = 1_000L

        /** How long an unconfirmed local echo may stay in the timeline. */
        const val PENDING_ECHO_TTL_MS = 120_000L
    }
}
