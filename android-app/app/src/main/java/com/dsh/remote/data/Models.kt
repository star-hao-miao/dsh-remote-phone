package com.dsh.remote.data

/**
 * Domain models mirrored from the Remote Gateway REST contract
 * (see desktop-plugin/docs/API.md). Kept dependency-free so the UI layer and
 * the transport layer can evolve independently.
 */

data class Session(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val running: Boolean,
    val blank: Boolean,
    val cwd: String? = null,
    val parentSessionId: String? = null,
)

data class Workspace(
    val id: String,
    val title: String,
    val path: String,
    /** Sessions the harness associates with this workspace (official baseline). */
    val sessionIds: List<String> = emptyList(),
    val sessionCount: Int = 0,
)

data class Device(
    val id: String,
    val name: String,
    val os: String? = null,
    val online: Boolean,
)

/** One transcript entry: the gateway's normalized `TranscriptMessage`. */
data class Message(
    val seq: Long,
    val time: Long,
    val role: Role,
    val kind: String,
    val text: String,
    val toolName: String? = null,
    /**
     * Locally echoed (not yet confirmed by the harness). Pending entries are
     * dropped as soon as an authoritative transcript arrives.
     */
    val pending: Boolean = false,
) {
    enum class Role { User, Assistant, Tool, System, Other }

    companion object {
        fun roleOf(raw: String?): Role = when {
            raw == null -> Role.Other
            raw.startsWith("user") -> Role.User
            raw.startsWith("assistant") -> Role.Assistant
            raw.startsWith("tool") -> Role.Tool
            raw.startsWith("system") -> Role.System
            else -> Role.Other
        }
    }
}

data class SessionDetail(
    val id: String,
    val messages: List<Message>,
    /** The harness has older records than this page. */
    val hasMore: Boolean,
    /** Pass back as the `beforeSeq` cursor to load the previous page. */
    val nextBeforeSeq: Long? = null,
)

enum class ConnectionState { Unpaired, Connecting, Online, Offline }

/** Gateway endpoint + JWT, produced by the pairing flow. */
data class GatewayCredentials(
    val baseUrl: String,
    val token: String,
    val deviceName: String,
    val expiresAt: Long,
)

/** Live events pushed over `/ws`; unknown types are ignored by the UI. */
sealed interface GatewayEvent {
    data class SessionStatus(val sessionId: String, val running: Boolean) : GatewayEvent
    data class SessionActivity(val sessionId: String, val updatedAt: Long) : GatewayEvent
    data class SessionAdded(val sessionId: String?) : GatewayEvent
    data class SessionRemoved(val sessionId: String) : GatewayEvent
    data class SessionError(val sessionId: String, val message: String?) : GatewayEvent
    data class Workspaces(val sessionsDirty: Boolean) : GatewayEvent
    data class Interaction(
        val id: String,
        val kind: String,
        val sessionId: String,
        val toolName: String?,
        val reason: String?,
    ) : GatewayEvent
    /**
     * The gateway's opening frame: it carries whatever approvals/questions are
     * still unanswered, so a reconnect (or a cold start) can render them.
     */
    data class Hello(val pending: List<Interaction>) : GatewayEvent
    data object Connected : GatewayEvent
    data object Disconnected : GatewayEvent
}
