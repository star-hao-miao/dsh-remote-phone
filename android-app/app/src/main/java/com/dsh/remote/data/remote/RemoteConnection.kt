package com.dsh.remote.data.remote

import android.app.Application
import com.dsh.remote.data.ConnectionState
import com.dsh.remote.data.GatewayCredentials
import com.dsh.remote.data.GatewayEvent
import com.dsh.remote.data.local.CredentialStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Application-scoped gateway connection (`/ws`).
 *
 * This app is a remote control: the event stream has to outlive the screen, so
 * it is owned here rather than by a ViewModel. Exactly one socket exists per
 * process — the UI and the foreground service both *observe* this object, which
 * is why a backgrounded phone still receives approvals and live output.
 *
 * Reconnection uses exponential backoff (1s → 30s, matching the framework
 * design) and resets as soon as a socket opens.
 */
class RemoteConnection private constructor(private val app: Application) {

    private val store = CredentialStore(app)
    private val socket = GatewaySocket(GatewayApi.defaultClient())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Unpaired)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /** Every frame from `/ws`, replayed to whoever is listening right now. */
    private val _events = MutableSharedFlow<GatewayEvent>(extraBufferCapacity = 128)
    val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

    /**
     * Unanswered approvals / questions.
     *
     * A StateFlow (not a bare event) on purpose: the socket is opened by
     * whichever of the foreground service and the ViewModel gets there first,
     * so the `hello` frame — the only carrier of the pending list — can land
     * before a later subscriber exists. Keeping the list as state means a late
     * observer still sees what needs an answer.
     */
    private val _pending = MutableStateFlow<List<GatewayEvent.Interaction>>(emptyList())
    val pending: StateFlow<List<GatewayEvent.Interaction>> = _pending.asStateFlow()

    private var loopJob: Job? = null

    fun credentials(): GatewayCredentials? = store.load()

    fun hasCredentials(): Boolean = store.load() != null

    /**
     * Open the stream if it is not already open, using the stored credentials.
     * Safe to call repeatedly (activity start, service start, after pairing).
     */
    fun ensureRunning() {
        val credentials = store.load()
        if (credentials == null) {
            stop()
            return
        }
        if (loopJob?.isActive == true) return
        _state.value = ConnectionState.Connecting
        loopJob = scope.launch {
            var backoffMs = 1_000L
            while (isActive) {
                var sawConnected = false
                // A transport failure must never escape: this loop owns
                // reconnection, the UI only ever sees Online/Offline.
                runCatching {
                    socket.events(credentials).collect { event ->
                        // The gateway's opening frame is `hello` (it carries the
                        // pending approvals); `Connected` also exists as the
                        // transport-level signal, so accept either.
                        if (event is GatewayEvent.Connected || event is GatewayEvent.Hello) {
                            sawConnected = true
                            backoffMs = 1_000L
                            _state.value = ConnectionState.Online
                        }
                        if (event is GatewayEvent.Disconnected) {
                            _state.value = ConnectionState.Offline
                        }
                        when (event) {
                            // The gateway's opening frame is authoritative for
                            // whatever is still unanswered.
                            is GatewayEvent.Hello -> _pending.value = event.pending
                            is GatewayEvent.Interaction ->
                                if (_pending.value.none { it.id == event.id }) {
                                    _pending.value = _pending.value + event
                                }
                            else -> Unit
                        }
                        _events.tryEmit(event)
                    }
                }
                if (_state.value != ConnectionState.Unpaired) _state.value = ConnectionState.Offline
                // Reset the backoff as soon as we reach the gateway, so a later
                // drop retries fast instead of inheriting an old penalty.
                if (sawConnected) backoffMs = 1_000L
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
            }
            _events.tryEmit(GatewayEvent.Disconnected)
        }
    }

    /** Forget one answered interaction (the UI answered it). */
    fun forgetInteraction(id: String) {
        _pending.value = _pending.value.filterNot { it.id == id }
    }

    /** Re-open the stream (after pairing, or after credentials changed). */
    fun restart() {
        loopJob?.cancel()
        loopJob = null
        ensureRunning()
    }

    /** Drop the credentials and close the stream (unpair). */
    fun clear() {
        store.clear()
        _pending.value = emptyList()
        stop()
    }

    fun stop() {
        loopJob?.cancel()
        loopJob = null
        _state.value = ConnectionState.Unpaired
    }

    companion object {
        @Volatile
        private var instance: RemoteConnection? = null

        /** The process-wide connection, created on first use. */
        fun get(app: Application): RemoteConnection =
            instance ?: synchronized(this) {
                instance ?: RemoteConnection(app).also { instance = it }
            }
    }
}
