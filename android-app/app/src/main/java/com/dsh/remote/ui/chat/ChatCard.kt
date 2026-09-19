package com.dsh.remote.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dsh.remote.data.Message
import com.dsh.remote.ui.PendingInteraction
import com.dsh.remote.ui.UiState
import com.dsh.remote.ui.theme.LocalGlassPalette
import com.dsh.remote.ui.theme.Radii
import com.dsh.remote.ui.theme.Busy
import com.dsh.remote.ui.theme.Success
import com.dsh.remote.ui.theme.accentGradient
import com.dsh.remote.ui.theme.glassCard

/**
 * The glass chat card: header + message list + composer, i.e. the reference's
 * `.chat-card`. On a phone it occupies everything below the character layer.
 */
@Composable
fun ChatCard(
    state: UiState,
    sessionId: String?,
    onRefresh: () -> Unit,
    onLoadEarlier: (String) -> Unit,
    onSend: (String, String) -> Unit,
    onDecision: (String, String) -> Unit,
    onAnswerQuestion: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalGlassPalette.current
    val session = state.sessions.firstOrNull { it.id == sessionId }
    val detail = state.detail?.takeIf { it.id == sessionId }
    var draft by remember(sessionId) { mutableStateOf("") }
    val listState = rememberLazyListState()

    // Follow the tail only when the NEWEST message changes, so paging older
    // messages does not yank the view back down.
    LaunchedEffect(detail?.messages?.lastOrNull()?.seq) {
        val size = detail?.messages?.size ?: 0
        if (size > 0) listState.animateScrollToItem(size - 1)
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .glassCard(Radii.Card),
    ) {
        ChatHeader(session = session, running = session?.running == true, onRefresh = onRefresh)
        Box(Modifier.fillMaxWidth().height(1.dp).background(palette.border))

        Box(Modifier.weight(1f)) {
            when {
                sessionId == null -> EmptyChat("从左上角选一个会话，或点 ＋ 开始新的对话")
                detail == null && state.busy -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(24.dp), color = palette.accent)
                }
                detail == null -> EmptyChat("暂时读不到这个会话")
                detail.messages.isEmpty() -> EmptyChat("还没有消息，直接在下面输入开始吧。")
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    if (detail.hasMore) {
                        item(key = "load-earlier") {
                            EarlierLoader(loading = state.loadingEarlier, onClick = { onLoadEarlier(sessionId) })
                        }
                    }
                    items(detail.messages, key = { it.seq.toString() + it.kind }) { message ->
                        MessageBubble(message)
                    }
                    if (session?.running == true && detail.messages.lastOrNull()?.role != Message.Role.Assistant) {
                        item(key = "typing") { TypingBubble() }
                    }
                }
            }
        }

        state.interactions.forEach { interaction ->
            InteractionCard(
                interaction = interaction,
                onAllow = { onDecision(interaction.id, "allowed-once") },
                onReject = { onDecision(interaction.id, "rejected") },
                onAnswer = { answer -> onAnswerQuestion(interaction.id, answer) },
            )
        }

        state.lastError?.let { message ->
            ErrorBanner(message, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
        }

        Composer(
            draft = draft,
            enabled = sessionId != null,
            onDraftChange = { draft = it },
            onSend = {
                val text = draft.trim()
                if (text.isNotEmpty() && sessionId != null) {
                    onSend(sessionId, text)
                    draft = ""
                }
            },
        )
    }
}

@Composable
private fun ChatHeader(
    session: com.dsh.remote.data.Session?,
    running: Boolean,
    onRefresh: () -> Unit,
) {
    val palette = LocalGlassPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = session?.title?.takeIf { it.isNotBlank() } ?: session?.let { dirNameOf(it.cwd) } ?: "DSH Remote",
                style = MaterialTheme.typography.titleSmall,
                color = palette.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = when {
                    session == null -> "未选择会话"
                    running -> "正在工作…"
                    session.blank -> "空会话"
                    else -> session.cwd ?: session.id
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (running) Busy else palette.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (running) {
            Box(
                Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(Busy),
            )
            Spacer(Modifier.width(10.dp))
        }
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .border(1.dp, palette.border, RoundedCornerShape(10.dp))
                .clickable(onClick = onRefresh),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Refresh, contentDescription = "刷新", tint = palette.muted, modifier = Modifier.size(16.dp))
        }
    }
}

fun dirNameOf(cwd: String?): String? {
    val trimmed = cwd?.trimEnd('\\', '/') ?: return null
    val name = trimmed.substringAfterLast('\\').substringAfterLast('/')
    return name.ifBlank { null }
}

@Composable
private fun EmptyChat(text: String) {
    val palette = LocalGlassPalette.current
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = palette.muted)
    }
}

@Composable
private fun ErrorBanner(text: String, modifier: Modifier = Modifier) {
    val palette = LocalGlassPalette.current
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(com.dsh.remote.ui.theme.DangerSoft)
            .border(1.dp, com.dsh.remote.ui.theme.Danger.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = com.dsh.remote.ui.theme.Danger)
    }
}

/**
 * Composer: reference `.input-area` (rounded textarea + gradient send button).
 * Sending uses `queue` mode so an in-flight turn is never interrupted.
 */
@Composable
private fun Composer(
    draft: String,
    enabled: Boolean,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    val palette = LocalGlassPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .imePadding()
            .background(palette.inputBg)
            .padding(12.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        TextField(
            value = draft,
            onValueChange = onDraftChange,
            enabled = enabled,
            modifier = Modifier
                .weight(1f)
                .clip(Radii.Field.let { RoundedCornerShape(it) }),
            placeholder = {
                Text(
                    text = if (enabled) "发送消息（queue 模式，不会打断当前回合）" else "先选择一个会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.muted,
                )
            },
            maxLines = 5,
            shape = RoundedCornerShape(Radii.Field),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = palette.inputBg,
                unfocusedContainerColor = palette.inputBg,
                disabledContainerColor = palette.inputBg,
                focusedTextColor = palette.text,
                unfocusedTextColor = palette.text,
                focusedIndicatorColor = palette.accent,
                unfocusedIndicatorColor = palette.border,
                disabledIndicatorColor = palette.border,
                cursorColor = palette.accent,
            ),
        )
        Box(
            modifier = Modifier
                .size(46.dp)
                .clip(RoundedCornerShape(Radii.Button))
                .background(accentGradient(palette.accent, palette.accent2))
                .clickable(enabled = enabled && draft.isNotBlank(), onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.ArrowUpward,
                contentDescription = "发送",
                tint = androidx.compose.ui.graphics.Color.White,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * Approval / question card. The reference styles such interruptions as a
 * `.bubble.error`; here they are a proper card with the decision buttons, since
 * on a phone this is the one thing that must not be missed.
 */
@Composable
private fun InteractionCard(
    interaction: PendingInteraction,
    onAllow: () -> Unit,
    onReject: () -> Unit,
    onAnswer: (String) -> Unit,
) {
    val palette = LocalGlassPalette.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(Radii.Panel))
            .background(palette.cardStrong)
            .border(1.dp, palette.border, RoundedCornerShape(Radii.Panel))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = if (interaction.kind == "approval") {
                "工具请求批准：${interaction.toolName ?: "未知工具"}"
            } else {
                "需要你的回答"
            },
            style = MaterialTheme.typography.bodyLarge,
            color = palette.text,
        )
        interaction.reason?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = palette.muted)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (interaction.kind == "approval") {
                PillButton("允许一次", primary = true, onClick = onAllow)
                PillButton("拒绝", primary = false, onClick = onReject)
            } else {
                PillButton("知道了", primary = true, onClick = { onAnswer("ok") })
                PillButton("忽略", primary = false, onClick = onReject)
            }
        }
    }
}

@Composable
fun PillButton(text: String, primary: Boolean, onClick: () -> Unit) {
    val palette = LocalGlassPalette.current
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .then(
                if (primary) {
                    Modifier.background(accentGradient(palette.accent, palette.accent2))
                } else {
                    Modifier
                        .background(palette.card)
                        .border(1.dp, palette.border, RoundedCornerShape(12.dp))
                },
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            color = if (primary) androidx.compose.ui.graphics.Color.White else palette.text,
        )
    }
}
