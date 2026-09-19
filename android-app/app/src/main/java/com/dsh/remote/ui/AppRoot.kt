package com.dsh.remote.ui

import android.app.Activity
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.dsh.remote.MainActivity
import com.dsh.remote.WebViewActivity
import com.dsh.remote.data.ConnectionState
import com.dsh.remote.ui.character.CharacterLayer
import com.dsh.remote.ui.chat.ChatCard
import com.dsh.remote.ui.pair.PairingScreen
import com.dsh.remote.ui.shell.DrawerHost
import com.dsh.remote.ui.shell.DrawerSide
import com.dsh.remote.ui.shell.SessionsDrawer
import com.dsh.remote.ui.shell.SettingsDrawer
import com.dsh.remote.ui.shell.TopBar
import com.dsh.remote.ui.theme.LocalGlassPalette
import com.dsh.remote.ui.theme.backdropBrush

/**
 * App shell, rebuilt to mirror the reference project:
 *
 *   top bar (title + drawers)  →  character layer  →  glass chat card
 *
 * with the conversation list in a left drawer and settings in a right drawer -
 * the reference's own mobile layout. All data still comes from the Remote
 * Gateway the plugin exposes over REST + `/ws`.
 */
@Composable
fun AppRoot(viewModel: RemoteViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val palette = LocalGlassPalette.current

    // A pairing link handed to the activity (scanner app or `adb --es`) pairs
    // immediately instead of waiting for a manual paste.
    LaunchedEffect(Unit) {
        val link = (context as? Activity)?.intent?.getStringExtra(MainActivity.EXTRA_PAIR_LINK)
        if (!link.isNullOrBlank()) viewModel.pairFromLink(link)
    }

    // The background link reports approvals through notifications, so ask once
    // we are paired (Android 13+). A denial still leaves the app usable.
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val notificationsGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED
    LaunchedEffect(state.connection != ConnectionState.Unpaired, notificationsGranted) {
        if (state.connection != ConnectionState.Unpaired && !notificationsGranted) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(backdropBrush(palette.dark))
            // Android 15 (targetSdk 35) forces edge-to-edge, and
            // `setDecorFitsSystemWindows(true)` is a no-op there: without this
            // the top bar slides under the status bar and the composer under the
            // navigation bar, so taps on them hit the system UI instead of us.
            // The background still paints the whole window.
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        if (state.connection == ConnectionState.Unpaired) {
            PairingScreen(
                error = state.lastError,
                busy = state.busy,
                onPairLink = viewModel::pairFromLink,
            )
            return@Box
        }

        // ── shell state ─────────────────────────────────────────────────
        var openSessionId by remember { mutableStateOf<String?>(null) }
        var leftDrawer by remember { mutableStateOf(false) }
        var rightDrawer by remember { mutableStateOf(false) }

        val notifiedSessionId = (context as? Activity)?.intent?.getStringExtra(MainActivity.EXTRA_SESSION_ID)
        LaunchedEffect(notifiedSessionId, state.sessions.size) {
            if (!notifiedSessionId.isNullOrBlank()) {
                // An approval notification carries its session: open it always.
                openSessionId = notifiedSessionId
                viewModel.openSession(notifiedSessionId)
            } else if (openSessionId == null && state.sessions.isNotEmpty()) {
                // First load: open the most recent conversation, the way the
                // reference marks an active conversation.
                val first = state.sessions.first().id
                openSessionId = first
                viewModel.openSession(first)
            }
        }

        Column(Modifier.fillMaxSize()) {
            TopBar(
                title = state.sessions.firstOrNull { it.id == openSessionId }
                    ?.title?.takeIf { it.isNotBlank() }
                    ?: "DSH Remote",
                subtitle = when {
                    state.interactions.isNotEmpty() -> "${state.interactions.size} 个待处理请求"
                    state.connection == ConnectionState.Online -> state.credentials?.baseUrl
                    state.connection == ConnectionState.Connecting -> "连接中…"
                    else -> "与电脑的连接已断开"
                },
                connection = state.connection,
                onOpenSessions = { leftDrawer = true },
                onOpenSettings = { rightDrawer = true },
            )

            if (state.appearance.characterVisible) {
                // Reference mobile layout: the illustration takes a share of the
                // screen above the chat card, and the card takes the rest.
                CharacterLayer(
                    expression = emotionFor(state),
                    opacity = state.appearance.characterOpacity,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(0.32f)
                        .padding(top = 4.dp),
                    showAngryRings = state.sendFailed,
                )
            }

            Box(
                Modifier
                    .weight(if (state.appearance.characterVisible) 0.68f else 1f)
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
            ) {
                ChatCard(
                    state = state,
                    sessionId = openSessionId,
                    onRefresh = { openSessionId?.let(viewModel::openSession) },
                    onLoadEarlier = viewModel::loadEarlier,
                    onSend = { id, text -> viewModel.sendMessage(id, text) },
                    onDecision = viewModel::answerInteraction,
                    onAnswerQuestion = { id, answer -> viewModel.answerInteraction(id, answer) },
                )
            }
        }

        // ── drawers ─────────────────────────────────────────────────────
        DrawerHost(open = leftDrawer, side = DrawerSide.Left, onDismiss = { leftDrawer = false }) {
            SessionsDrawer(
                state = state,
                activeSessionId = openSessionId,
                deleting = state.busy,
                onClose = { leftDrawer = false },
                onFilterChange = viewModel::setSessionFilter,
                onOpenSession = { id ->
                    openSessionId = id
                    viewModel.openSession(id)
                    leftDrawer = false
                },
                onNewSession = {
                    leftDrawer = false
                    viewModel.createSession { id -> openSessionId = id }
                },
                onDeleteSession = { id ->
                    // Keep the drawer open: the user is usually pruning a list.
                    viewModel.deleteSession(id) { deletedId ->
                        if (deletedId == openSessionId) openSessionId = null
                    }
                },
            )
        }

        DrawerHost(open = rightDrawer, side = DrawerSide.Right, onDismiss = { rightDrawer = false }) {
            SettingsDrawer(
                state = state,
                onClose = { rightDrawer = false },
                onUnpair = {
                    rightDrawer = false
                    openSessionId = null
                    viewModel.unpair()
                },
                onSelectWorkspace = viewModel::selectWorkspace,
                onAppearanceChange = viewModel::updateAppearance,
                onOpenCompatMode = {
                    rightDrawer = false
                    context.startActivity(Intent(context, WebViewActivity::class.java))
                },
                onRefresh = viewModel::refreshAll,
            )
        }
    }
}
