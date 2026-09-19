package com.dsh.remote.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dsh.remote.data.ConnectionState
import com.dsh.remote.data.local.Appearance
import com.dsh.remote.data.local.ThemeMode
import com.dsh.remote.ui.UiState
import com.dsh.remote.ui.chat.dirNameOf
import com.dsh.remote.ui.theme.Danger
import com.dsh.remote.ui.theme.LocalGlassPalette
import com.dsh.remote.ui.theme.Radii
import com.dsh.remote.ui.theme.Success

/**
 * Right drawer = the reference's settings drawer: stacked sections separated by
 * hairlines, form rows, primary/danger buttons.
 */
@Composable
fun SettingsDrawer(
    state: UiState,
    onClose: () -> Unit,
    onUnpair: () -> Unit,
    onSelectWorkspace: (String) -> Unit,
    onAppearanceChange: ((Appearance) -> Appearance) -> Unit,
    onOpenCompatMode: () -> Unit,
    onRefresh: () -> Unit,
) {
    val palette = LocalGlassPalette.current
    val appearance = state.appearance

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.drawerBg),
    ) {
        DrawerHeader(title = "设置", onClose = onClose)
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {

            // ── connection ──────────────────────────────────────────────
            Section("连接") {
                InfoRow("状态", connectionLabel(state.connection), accent = state.connection == ConnectionState.Online)
                InfoRow("网关", state.credentials?.baseUrl ?: "—")
                InfoRow("本机名称", state.credentials?.deviceName ?: "—")
                if (state.credentials != null) {
                    val left = state.credentials.expiresAt - System.currentTimeMillis()
                    if (left > 0) InfoRow("凭据有效期", "${left / 3_600_000} 小时")
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedPill("刷新", onClick = onRefresh)
                    OutlinedPill("解除配对", danger = true, onClick = onUnpair)
                }
            }

            // ── workspaces ──────────────────────────────────────────────
            if (state.workspaces.isNotEmpty()) {
                Section("工作区") {
                    state.workspaces.forEach { workspace ->
                        val active = workspace.id == state.currentWorkspaceId
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (active) palette.cardStrong else palette.card.copy(alpha = 0.3f))
                                .clickable { onSelectWorkspace(workspace.id) }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = workspace.title,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.text,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = "${workspace.sessionCount} 个会话 · ${dirNameOf(workspace.path) ?: workspace.path}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.muted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            if (active) {
                                Text("当前", style = MaterialTheme.typography.labelSmall, color = palette.accent)
                            }
                        }
                    }
                }
            }

            // ── appearance (the reference's theme / font / character knobs) ──
            Section("外观") {
                Text("主题", style = MaterialTheme.typography.labelMedium, color = palette.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterPill(appearance.themeMode == ThemeMode.System, "跟随系统") {
                        onAppearanceChange { it.copy(themeMode = ThemeMode.System) }
                    }
                    FilterPill(appearance.themeMode == ThemeMode.Light, "亮色") {
                        onAppearanceChange { it.copy(themeMode = ThemeMode.Light) }
                    }
                    FilterPill(appearance.themeMode == ThemeMode.Dark, "暗色") {
                        onAppearanceChange { it.copy(themeMode = ThemeMode.Dark) }
                    }
                }

                Spacer(Modifier.height(6.dp))
                Text("字号 ${(appearance.fontScale * 100).toInt()}%", style = MaterialTheme.typography.labelMedium, color = palette.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterPill(appearance.fontScale < 0.95f, "小") {
                        onAppearanceChange { it.copy(fontScale = 0.9f) }
                    }
                    FilterPill(appearance.fontScale in 0.95f..1.05f, "标准") {
                        onAppearanceChange { it.copy(fontScale = 1f) }
                    }
                    FilterPill(appearance.fontScale > 1.05f, "大") {
                        onAppearanceChange { it.copy(fontScale = 1.12f) }
                    }
                }

                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("显示立绘", style = MaterialTheme.typography.bodyMedium, color = palette.text)
                        Text("关掉可以给聊天区更多空间", style = MaterialTheme.typography.labelSmall, color = palette.muted)
                    }
                    Switch(
                        checked = appearance.characterVisible,
                        onCheckedChange = { visible -> onAppearanceChange { it.copy(characterVisible = visible) } },
                        colors = SwitchDefaults.colors(checkedTrackColor = palette.accent),
                    )
                }
                Text("立绘不透明度 ${(appearance.characterOpacity * 100).toInt()}%", style = MaterialTheme.typography.labelMedium, color = palette.muted)
                Slider(
                    value = appearance.characterOpacity,
                    onValueChange = { value -> onAppearanceChange { it.copy(characterOpacity = value) } },
                    valueRange = 0.2f..1f,
                )
            }

            // ── devices ─────────────────────────────────────────────────
            Section("已配对设备") {
                if (state.devices.isEmpty()) {
                    Text("（暂无）", style = MaterialTheme.typography.bodySmall, color = palette.muted)
                }
                state.devices.forEach { device ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(if (device.online) Success else palette.muted.copy(alpha = 0.5f)),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = device.name,
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = device.os ?: "",
                            style = MaterialTheme.typography.labelSmall,
                            color = palette.muted,
                            maxLines = 1,
                        )
                    }
                }
            }

            // ── compatibility mode ──────────────────────────────────────
            Section("兼容模式") {
                Text(
                    "需要看桌面原版界面时，可以用内置浏览器打开网关页面（共用同一份配对凭据）。",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.muted,
                )
                OutlinedPill("打开 WebView 兼容模式", onClick = onOpenCompatMode)
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val palette = LocalGlassPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = palette.text)
        content()
        Box(Modifier.fillMaxWidth().height(1.dp).background(palette.border))
    }
}

@Composable
private fun InfoRow(label: String, value: String, accent: Boolean = false) {
    val palette = LocalGlassPalette.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = palette.muted, modifier = Modifier.width(84.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = if (accent) Success else palette.text,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun OutlinedPill(text: String, danger: Boolean = false, onClick: () -> Unit) {
    val palette = LocalGlassPalette.current
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(Radii.Button))
            .background(palette.card)
            .border(1.dp, if (danger) Danger.copy(alpha = 0.4f) else palette.border, RoundedCornerShape(Radii.Button))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            color = if (danger) Danger else palette.text,
        )
    }
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.Online -> "已连接"
    ConnectionState.Connecting -> "连接中…"
    ConnectionState.Offline -> "已断开，正在重连"
    ConnectionState.Unpaired -> "未配对"
}
