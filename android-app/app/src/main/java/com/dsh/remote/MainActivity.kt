package com.dsh.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dsh.remote.data.remote.RemoteConnection
import com.dsh.remote.service.RemoteConnectionService
import com.dsh.remote.ui.AppRoot
import com.dsh.remote.ui.RemoteViewModel
import com.dsh.remote.ui.theme.DshRemoteTheme

/**
 * Native UI entry point.
 *
 * The app is a *native* client of the DSH Remote Gateway: it pairs once over
 * HTTP, then lists sessions / reads history / sends messages and consumes live
 * events from the gateway's WebSocket. The legacy WebView shell lives on as
 * [WebViewActivity] (compatibility mode), reachable from the settings drawer.
 *
 * The ViewModel lives here (rather than inside `AppRoot`) so the appearance
 * settings it owns - theme mode and font scale - can wrap the whole tree, the
 * pairing gate included.
 */
class MainActivity : ComponentActivity() {

    private val viewModel: RemoteViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        // Already paired from a previous run? Resume the background link before
        // the UI even composes, so a notification tap lands on live data.
        if (RemoteConnection.get(application).hasCredentials()) {
            RemoteConnectionService.start(this)
        }
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            DshRemoteTheme(
                themeMode = state.appearance.themeMode,
                fontScale = state.appearance.fontScale,
            ) {
                AppRoot(viewModel)
            }
        }
    }

    companion object {
        /**
         * Launch extra carrying a pairing link, so a scanner app (or `adb`)
         * can hand the URL straight to the app:
         * `adb shell am start -n com.dsh.remote/.MainActivity \
         *    --es dsh_pair_link "https://host:3080/pair?code=XXXX"`.
         */
        const val EXTRA_PAIR_LINK = "dsh_pair_link"

        /** Launch extra carrying a session to open (used by notifications). */
        const val EXTRA_SESSION_ID = "dsh_session_id"
    }
}
