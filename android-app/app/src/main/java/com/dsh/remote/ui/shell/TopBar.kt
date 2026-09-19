package com.dsh.remote.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dsh.remote.data.ConnectionState
import com.dsh.remote.ui.theme.Border
import com.dsh.remote.ui.theme.Busy
import com.dsh.remote.ui.theme.Danger
import com.dsh.remote.ui.theme.LocalGlassPalette
import com.dsh.remote.ui.theme.Success

/**
 * Fixed 56dp top bar from the reference (`--card` background, hairline bottom
 * border, app title + version badge + 36dp icon buttons).
 */
@Composable
fun TopBar(
    title: String,
    subtitle: String?,
    connection: ConnectionState,
    onOpenSessions: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalGlassPalette.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(palette.card)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassIconButton(onClick = onOpenSessions, contentDescription = "会话") {
            Icon(Icons.Filled.Menu, contentDescription = "会话", tint = palette.text)
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 10.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = palette.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(
                        Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(connectionDot(connection)),
                    )
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.muted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        GlassIconButton(onClick = onOpenSettings, contentDescription = "设置") {
            Icon(Icons.Filled.MoreVert, contentDescription = "设置", tint = palette.text)
        }
    }
    // Hairline separator (`border-bottom: 1px solid var(--border)`).
    Box(Modifier.fillMaxWidth().height(1.dp).background(palette.border))
}

private fun connectionDot(state: ConnectionState): Color = when (state) {
    ConnectionState.Online -> Success
    ConnectionState.Connecting -> Busy
    ConnectionState.Offline -> Danger
    ConnectionState.Unpaired -> Danger
}

@Composable
fun GlassIconButton(
    onClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val palette = LocalGlassPalette.current
    Box(
        modifier = modifier
            .size(36.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(palette.card)
            .border(1.dp, palette.border, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        // The icon inside carries the content description (it has the semantics).
        content()
    }
}

/** Small rounded chip, as used for the version badge / mode hints. */
@Composable
fun Badge(text: String, modifier: Modifier = Modifier) {
    val palette = LocalGlassPalette.current
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(palette.inputBg)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall, color = palette.muted)
    }
}

/** Hairline divider shared by the shells. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(Border.copy(alpha = 0.6f)))
}
