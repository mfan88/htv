package app.htv.tv

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

private const val START_TIMEOUT_MS = 30_000L
private const val INFO_MS = 5_000L

private sealed interface PlayState {
    data class Loading(val text: String) : PlayState
    data object Playing : PlayState
    data class Failed(val title: String, val text: String) : PlayState
}

/**
 * Fullscreen player. OK pauses, left/right switch to the game's previous/next link, and a
 * link that fails moves on to the next one by itself. Back returns to the list.
 */
@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    api: Api,
    game: Game,
    start: Stream,
    label: Label?,
    onLinkChange: (Stream) -> Unit,
    onFailed: () -> Unit,
) {
    val context = LocalContext.current
    val player = remember { ExoPlayer.Builder(context).build() }
    var current by remember { mutableStateOf(start) }
    var state by remember { mutableStateOf<PlayState>(PlayState.Loading("Finding the stream…")) }
    var infoShownAt by remember { mutableIntStateOf(0) } // bumped to show the info bar again
    var infoVisible by remember { mutableStateOf(true) }
    var paused by remember { mutableStateOf(false) }
    val tried = remember { mutableSetOf<String>() } // links that failed; skipped when advancing
    val focus = remember { FocusRequester() }

    fun switchTo(s: Stream) {
        current = s
        onLinkChange(s)
        infoShownAt++
    }

    // Try the next untried link, or give up with `reason`.
    fun advance(reason: String) {
        tried += current.link
        onFailed() // refresh the list: the server has just marked this link
        val next = game.links.firstOrNull { it.link !in tried }
        if (next == null) {
            player.stop()
            state = PlayState.Failed("No working stream", reason)
        } else {
            switchTo(next)
        }
    }

    fun step(dir: Int) {
        if (game.links.size < 2) return
        val i = game.links.indexOfFirst { it.link == current.link }
        tried.clear()
        switchTo(game.links[((i + dir) % game.links.size + game.links.size) % game.links.size])
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                paused = !playWhenReady
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) state = PlayState.Playing
            }

            override fun onPlayerError(error: PlaybackException) {
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    player.seekToDefaultPosition()
                    player.prepare()
                } else {
                    advance("The stream stopped loading.")
                }
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    LaunchedEffect(current) {
        state = PlayState.Loading("Finding the stream…")
        player.stop()
        player.clearMediaItems()
        val src = try {
            api.play(current.link)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            advance(e.message ?: "No playable stream found in this link.")
            return@LaunchedEffect
        }
        // The proxied URL has no .m3u8 extension, so name the format explicitly.
        player.setMediaItem(MediaItem.Builder().setUri(src).setMimeType(MimeTypes.APPLICATION_M3U8).build())
        player.prepare()
        player.playWhenReady = true
        state = PlayState.Loading("Starting…")
        delay(START_TIMEOUT_MS)
        if (state !is PlayState.Playing && player.playbackState != Player.STATE_READY) advance("The stream didn't start.")
    }

    LaunchedEffect(infoShownAt) {
        infoVisible = true
        delay(INFO_MS)
        infoVisible = false
    }
    LaunchedEffect(Unit) { focus.requestFocus() }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(focus)
            .focusable()
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionCenter, Key.Enter, Key.NumPadEnter, Key.MediaPlayPause, Key.Spacebar -> {
                        if (state is PlayState.Playing || player.isPlaying) player.playWhenReady = !player.playWhenReady
                        infoShownAt++
                        true
                    }
                    Key.DirectionLeft, Key.MediaPrevious -> { step(-1); true }
                    Key.DirectionRight, Key.MediaNext -> { step(1); true }
                    Key.DirectionUp, Key.DirectionDown, Key.Info -> { infoShownAt++; true }
                    else -> false
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    keepScreenOn = true
                    isFocusable = false
                    this.player = player
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        when (val s = state) {
            is PlayState.Loading -> Centered(s.text, "${current.title} · ${current.name}")
            is PlayState.Failed -> Centered(s.title, "${s.text}\n◀ ▶ try another link · Back for the list")
            PlayState.Playing -> {}
        }

        if (infoVisible || paused) {
            InfoBar(game, current, label, paused, Modifier.align(Alignment.BottomStart))
        }
    }
}

@Composable
private fun Centered(title: String, text: String) {
    Box(Modifier.fillMaxSize().background(Bg.copy(alpha = .85f)), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, color = TextColor, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
            Text(text, color = Muted, fontSize = 16.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun InfoBar(game: Game, stream: Stream, label: Label?, paused: Boolean, modifier: Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = .85f))))
            .padding(start = 48.dp, end = 48.dp, top = 48.dp, bottom = 27.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label?.text ?: game.name, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
                if (label?.live == true) {
                    Text("LIVE", color = Live, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(start = 12.dp))
                }
                if (paused) Text("PAUSED", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(start = 12.dp))
            }
            Text("${stream.title} · ${stream.name}", color = Muted, fontSize = 16.sp)
        }
        val n = game.links.size
        if (n > 1) {
            val i = game.links.indexOfFirst { it.link == stream.link } + 1
            Text("◀ ▶ link $i of $n", color = Muted, fontSize = 15.sp)
        }
    }
}
