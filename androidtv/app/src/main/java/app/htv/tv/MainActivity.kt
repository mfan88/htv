package app.htv.tv

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val LIST_POLL_MS = 60_000L
private const val LABELS_POLL_MS = 30_000L
private const val UPDATE_POLL_MS = 30 * 60_000L

// Same palette as the desktop app and the web player.
val Bg = Color(0xFF0B0D12)
val Panel = Color(0xFF12151C)
val Card = Color(0xFF181C25)
val BorderColor = Color(0xFF232835)
val TextColor = Color(0xFFE8EBF2)
val Muted = Color(0xFF8A93A6)
val Accent = Color(0xFF4F8CFF)
val AccentSoft = Color(0xFF1B2A4A)
val Live = Color(0xFFFF4D5E)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = Settings(this)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Accent, onPrimary = Color.White,
                    background = Bg, onBackground = TextColor,
                    surface = Card, onSurface = TextColor,
                    surfaceVariant = Panel, onSurfaceVariant = Muted,
                    border = BorderColor,
                ),
            ) { HtvApp(settings) }
        }
    }
}

private sealed interface Screen {
    data object Home : Screen
    data object Settings : Screen
    data class Player(val game: Game, val start: Stream) : Screen
}

@Composable
private fun HtvApp(settings: Settings) {
    var server by remember { mutableStateOf(settings.server()) }
    var screen by remember { mutableStateOf<Screen>(if (server == null) Screen.Settings else Screen.Home) }
    val api = remember(server) { server?.let { Api(it) } }
    var listing by remember { mutableStateOf<Listing?>(null) }
    var labels by remember { mutableStateOf(emptyMap<String, Label>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshes by remember { mutableIntStateOf(0) }
    var lastLink by remember { mutableStateOf<String?>(null) } // focused again on return from the player
    val listState = rememberLazyListState()
    var update by remember { mutableStateOf<Update?>(null) }
    var updating by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(api, refreshes) {
        if (api == null) return@LaunchedEffect
        while (true) {
            try {
                listing = api.streams()
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Unauthorized) {
                error = e.message
            } catch (e: Exception) {
                error = "can't reach the server"
            }
            delay(LIST_POLL_MS)
        }
    }
    LaunchedEffect(api) {
        if (api == null) return@LaunchedEffect
        while (true) {
            try { labels = api.labels() } catch (e: CancellationException) { throw e } catch (_: Exception) {}
            delay(LABELS_POLL_MS)
        }
    }

    LaunchedEffect(api) {
        if (api == null) return@LaunchedEffect
        while (true) {
            try { update = Updater.check(api) } catch (e: CancellationException) { throw e } catch (_: Exception) {}
            delay(UPDATE_POLL_MS)
        }
    }

    when (val s = screen) {
        Screen.Home -> HomeScreen(
            listing = listing,
            labels = labels,
            error = error,
            listState = listState,
            focusLink = lastLink,
            onPlay = { game, stream ->
                lastLink = stream.link
                screen = Screen.Player(game, stream)
            },
            onRefresh = { refreshes++ },
            onSettings = { screen = Screen.Settings },
            update = update,
            updating = updating,
            onUpdate = {
                val u = update
                if (u != null && api != null && !updating) {
                    updating = true
                    scope.launch {
                        try {
                            Updater.install(context, api, u)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            Toast.makeText(context, "Update failed: ${e.message}", Toast.LENGTH_LONG).show()
                        } finally {
                            updating = false
                        }
                    }
                }
            },
        )
        is Screen.Player -> {
            BackHandler { screen = Screen.Home }
            PlayerScreen(
                api = api!!,
                game = s.game,
                start = s.start,
                label = labels[s.game.name],
                onLinkChange = { lastLink = it.link },
                onFailed = { refreshes++ },
            )
        }
        Screen.Settings -> SettingsScreen(
            settings = settings,
            onSaved = {
                server = settings.server()
                listing = null
                error = null
                screen = Screen.Home
            },
            onBack = if (server != null) ({ screen = Screen.Home }) else null,
        )
    }
}
