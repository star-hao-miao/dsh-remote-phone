package com.dsh.remote.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dsh.remote.data.Session
import com.dsh.remote.ui.UiState
import com.dsh.remote.ui.chat.dirNameOf
import com.dsh.remote.ui.theme.Busy
import com.dsh.remote.ui.theme.Danger
import com.dsh.remote.ui.theme.LocalGlassPalette
import com.dsh.remote.ui.theme.Radii
import com.dsh.remote.ui.theme.Success

/** One folder of the conversation drawer (a workspace, or a plain directory). */
data class SessionGroup(
    val key: String,
    val title: String,
    /** The workspace path, when the group came from the workspace registry. */
    val path: String?,
    val sessions: List<Session>,
)

/**
 * Groups conversations the way the desktop UI does: one folder per workspace.
 *
 * The authoritative source is the workspace registry (`items[].sessionIds`),
 * which also gives the nice title. When that stream has not delivered its
 * baseline yet (`ready=false`, typically right after a harness restart) the
 * grouping falls back to each session's `cwd`, so the list is still nested by
 * project instead of one flat pile.
 */
fun groupSessions(state: UiState, filter: String?): List<SessionGroup> {
    val sessions = state.sessions
    val byId = sessions.associateBy { it.id }

    val grouped = state.workspaces
        .filter { filter == null || it.id == filter }
        .mapNotNull { workspace ->
            val members = workspace.sessionIds.mapNotNull { byId[it] }.sortedByDescending { it.updatedAt }
            if (members.isEmpty() && filter != workspace.id) return@mapNotNull null
            SessionGroup(
                key = workspace.id,
                title = workspace.title,
                path = workspace.path,
                sessions = members,
            )
        }

    val claimed = grouped.flatMap { it.sessions }.map { it.id }.toSet()
    val rest = sessions.filter { it.id !in claimed && (filter == null || filter.isEmpty()) }
    if (rest.isEmpty()) return grouped

    // Fallback: fold whatever the registry did not claim by its directory.
    val byDir = rest.groupBy { dirNameOf(it.cwd) ?: "未归类" }
    val extra = byDir.entries
        .sortedBy { it.key }
        .map { (dir, members) ->
            SessionGroup(
                key = "dir:$dir",
                title = dir,
                path = members.firstOrNull()?.cwd,
                sessions = members.sortedByDescending { it.updatedAt },
            )
        }
    return grouped + extra
}

/**
 * Left drawer = the reference's conversation list, grouped per workspace.
 * Rows can be deleted (with a confirmation), since the phone is often the only
 * place you notice a pile of stale conversations.
 */
@Composable
fun SessionsDrawer(
    state: UiState,
    activeSessionId: String?,
    deleting: Boolean,
    onClose: () -> Unit,
    onFilterChange: (String?) -> Unit,
    onOpenSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onDeleteSession: (String) -> Unit,
) {
    val palette = LocalGlassPalette.current
    var pendingDelete by remember { mutableStateOf<Session?>(null) }
    val groups = remember(state.sessions, state.workspaces, state.sessionFilter) {
        groupSessions(state, state.sessionFilter)
    }
    val total = groups.sumOf { it.sessions.size }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.drawerBg),
    ) {
        DrawerHeader(title = "会话", onClose = onClose)

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterPill(selected = state.sessionFilter == null, label = "全部", onClick = { onFilterChange(null) })
            state.workspaces.forEach { workspace ->
                FilterPill(
                    selected = state.sessionFilter == workspace.id,
                    label = if (workspace.id == state.currentWorkspaceId) "${workspace.title} ·当前" else workspace.title,
                    onClick = { onFilterChange(workspace.id) },
                )
            }
        }

        if (groups.isEmpty() || total == 0) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    text = if (state.sessionFilter != null) "这个工作区下还没有会话" else "还没有会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.muted,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                groups.forEach { group ->
                    item(key = "group:${group.key}") { GroupHeader(group) }
                    items(group.sessions, key = { it.id }) { session ->
                        ConversationRow(
                            session = session,
                            active = session.id == activeSessionId,
                            onClick = { onOpenSession(session.id) },
                            onDeleteClick = { pendingDelete = session },
                        )
                    }
                }
            }
        }

        Row(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Radii.Button))
                    .background(palette.card)
                    .border(1.dp, palette.border, RoundedCornerShape(Radii.Button))
                    .clickable(onClick = onNewSession)
                    .padding(vertical = 11.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Add, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("新会话", style = MaterialTheme.typography.labelLarge, color = palette.accent)
            }
        }
    }

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除这个对话？", style = MaterialTheme.typography.titleMedium) },
            text = {
                Text(
                    text = "“${session.title.ifBlank { dirNameOf(session.cwd) ?: session.id }}” 的记录会被永久删除" +
                        "（工作区里的文件不动）。正在运行的对话不能删除。",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.muted,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDeleteSession(session.id)
                        pendingDelete = null
                    },
                ) { Text(if (deleting) "删除中…" else "删除", color = Danger) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消", color = palette.text) }
            },
            containerColor = palette.cardStrong,
        )
    }
}

@Composable
private fun GroupHeader(group: SessionGroup) {
    val palette = LocalGlassPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 6.dp, top = 10.dp, end = 6.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = group.title,
            style = MaterialTheme.typography.labelLarge,
            color = palette.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = "${group.sessions.size}",
            style = MaterialTheme.typography.labelSmall,
            color = palette.muted,
        )
    }
    group.path?.takeIf { it.isNotBlank() }?.let { path ->
        Text(
            text = path,
            style = MaterialTheme.typography.labelSmall,
            color = palette.muted.copy(alpha = 0.75f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 6.dp, bottom = 2.dp),
        )
    }
}

@Composable
private fun ConversationRow(
    session: Session,
    active: Boolean,
    onClick: () -> Unit,
    onDeleteClick: () -> Unit,
) {
    val palette = LocalGlassPalette.current
    val title = session.title.ifBlank {
        dirNameOf(session.cwd) ?: if (session.blank) "空会话" else "未命名会话"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (active) palette.cardStrong else palette.card.copy(alpha = 0.35f))
            .border(1.dp, if (active) palette.border else Color.Transparent, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(if (session.running) Busy else Success.copy(alpha = 0.45f)),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = buildString {
                    append(relativeTime(session.updatedAt))
                    if (session.running) append(" · 运行中")
                    if (session.title.isNotBlank()) dirNameOf(session.cwd)?.let { append(" · $it") }
                },
                style = MaterialTheme.typography.labelSmall,
                color = palette.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(10.dp))
                .clickable(onClick = onDeleteClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.DeleteOutline,
                contentDescription = "删除对话",
                tint = palette.muted,
                modifier = Modifier.size(17.dp),
            )
        }
    }
}

@Composable
fun FilterPill(selected: Boolean, label: String, onClick: () -> Unit) {
    val palette = LocalGlassPalette.current
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(Radii.Chip))
            .background(if (selected) palette.accent.copy(alpha = 0.18f) else palette.card)
            .border(1.dp, if (selected) palette.accent.copy(alpha = 0.5f) else palette.border, RoundedCornerShape(Radii.Chip))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) palette.accent else palette.muted,
            maxLines = 1,
        )
    }
}

/** Shared drawer header (`--drawer-header` in the reference). */
@Composable
fun DrawerHeader(title: String, onClose: () -> Unit) {
    val palette = LocalGlassPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            color = palette.text,
            modifier = Modifier.weight(1f),
        )
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(palette.card)
                .border(1.dp, palette.border, RoundedCornerShape(10.dp))
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Close, contentDescription = "关闭", tint = palette.text, modifier = Modifier.size(16.dp))
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(palette.border))
}

fun relativeTime(at: Long): String {
    if (at <= 0) return "时间未知"
    val minutes = (System.currentTimeMillis() - at) / 60_000
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> "${minutes / (24 * 60)} 天前"
    }
}
