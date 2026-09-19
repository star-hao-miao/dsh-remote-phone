package com.dsh.remote.ui.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dsh.remote.data.Message
import com.dsh.remote.ui.theme.Danger
import com.dsh.remote.ui.theme.DangerSoft
import com.dsh.remote.ui.theme.LocalGlassPalette

/**
 * Message bubble, following the reference's `.bubble` rules: max 82% width,
 * 16dp radius with one squared corner on the speaker's side, 14sp text at 1.65
 * line height, plus a right-aligned 11sp meta line.
 */
@Composable
fun MessageBubble(message: Message, modifier: Modifier = Modifier) {
    val palette = LocalGlassPalette.current
    val isUser = message.role == Message.Role.User
    val isTool = message.role == Message.Role.Tool
    val isReasoning = message.kind == "assistant/reasoning"
    val isError = message.kind.contains("error", ignoreCase = true) || message.kind.contains("fail", ignoreCase = true)

    val shape = if (isUser) {
        RoundedCornerShape(16.dp, 16.dp, 6.dp, 16.dp)
    } else {
        RoundedCornerShape(16.dp, 16.dp, 16.dp, 6.dp)
    }
    val background = when {
        isError -> DangerSoft
        isUser -> palette.bubbleUser
        isTool || isReasoning -> palette.bubbleAssistant.copy(alpha = 0.55f)
        else -> palette.bubbleAssistant
    }

    // `msgIn`: fade + 6px rise, exactly like the reference animation.
    var shown by remember(message.seq) { mutableStateOf(false) }
    LaunchedEffect(message.seq) { shown = true }
    val progress by animateFloatAsState(if (shown) 1f else 0f, tween(250), label = "msgIn")

    Column(
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer {
                alpha = progress
                translationY = (1f - progress) * 18f
            },
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        if (isTool || isReasoning) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.padding(start = 6.dp, bottom = 3.dp),
            ) {
                Icon(
                    imageVector = if (isReasoning) Icons.Filled.Psychology else Icons.Filled.Build,
                    contentDescription = null,
                    tint = palette.muted,
                    modifier = Modifier.size(12.dp),
                )
                Text(
                    text = if (isReasoning) "思考" else (message.toolName ?: "工具"),
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.muted,
                )
            }
        }
        Box(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(shape)
                .background(background)
                .border(1.dp, if (isError) Danger.copy(alpha = 0.4f) else palette.border, shape)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            val body = message.text.ifBlank { "[${message.kind}]" }
            Text(
                text = body,
                style = if (isTool) {
                    MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
                } else {
                    MaterialTheme.typography.bodyMedium
                },
                color = if (isError) Danger else palette.text,
            )
        }
        message.metaLabel()?.let { meta ->
            Text(
                text = meta,
                style = MaterialTheme.typography.labelSmall,
                color = palette.muted,
                modifier = Modifier
                    .padding(top = 4.dp, end = 6.dp, start = 6.dp)
                    .alpha(0.85f),
            )
        }
    }
}

private fun Message.metaLabel(): String? {
    if (pending) return "发送中…"
    if (time <= 0) return null
    val delta = System.currentTimeMillis() - time
    val minutes = delta / 60_000
    return when {
        minutes < 1 -> null
        minutes < 60 -> "$minutes 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> "${minutes / (24 * 60)} 天前"
    }
}

/**
 * Streamed placeholder: the reference has no equivalent, but a phone needs to
 * show that the agent is producing output before the first chunk lands.
 */
@Composable
fun TypingBubble(label: String = "正在生成…") {
    val palette = LocalGlassPalette.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Start,
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(16.dp, 16.dp, 16.dp, 6.dp))
                .background(palette.bubbleAssistant)
                .border(1.dp, palette.border, RoundedCornerShape(16.dp, 16.dp, 16.dp, 6.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(
                strokeWidth = 2.dp,
                modifier = Modifier.size(14.dp),
                color = palette.accent,
            )
            Text(label, style = MaterialTheme.typography.bodySmall, color = palette.muted)
        }
    }
}

/** "Load earlier" affordance, styled as the reference's small outline button. */
@Composable
fun EarlierLoader(loading: Boolean, onClick: () -> Unit) {
    val palette = LocalGlassPalette.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(14.dp), color = palette.accent)
                Spacer(Modifier.width(8.dp))
                Text("加载更早的消息…", style = MaterialTheme.typography.labelSmall, color = palette.muted)
            }
        } else {
            Text(
                text = "加载更早的消息",
                style = MaterialTheme.typography.labelMedium,
                color = palette.accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .border(1.dp, palette.border, RoundedCornerShape(12.dp))
                    .background(palette.card)
                    .clickable(onClick = onClick)
                    .padding(horizontal = 14.dp, vertical = 7.dp),
            )
        }
    }
}

/** Small centred timestamp/divider used between day boundaries. */
@Composable
fun TimelineLabel(text: String) {
    val palette = LocalGlassPalette.current
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = palette.muted)
    }
    Spacer(Modifier.height(0.dp))
}
