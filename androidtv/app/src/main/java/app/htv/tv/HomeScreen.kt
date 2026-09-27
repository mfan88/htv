package app.htv.tv

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun HomeScreen(
    listing: Listing?,
    labels: Map<String, Label>,
    error: String?,
    listState: LazyListState,
    focusLink: String?,
    onPlay: (Game, Stream) -> Unit,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
    update: Update?,
    updating: Boolean,
    onUpdate: () -> Unit,
) {
    val games = remember(listing) { listing?.games().orEmpty() }
    // The link played last gets focus back, else the first link on the list.
    val target = remember(games, focusLink) {
        games.firstNotNullOfOrNull { g -> g.links.firstOrNull { it.link == focusLink }?.let { g.id to it.link } }
            ?: games.firstNotNullOfOrNull { g -> g.links.firstOrNull()?.let { g.id to it.link } }
    }
    val focusRequester = remember { FocusRequester() }

    // 48/27 dp keeps everything inside the TV's overscan-safe area.
    Column(Modifier.fillMaxSize().background(Bg).padding(horizontal = 48.dp, vertical = 27.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "htv",
                style = TextStyle(
                    brush = Brush.horizontalGradient(listOf(Color(0xFF7FB0FF), Accent)),
                    fontSize = 32.sp, fontWeight = FontWeight.ExtraBold,
                ),
            )
            Spacer(Modifier.width(20.dp))
            Text(statusText(listing, error), color = if (error != null) Live else Muted, fontSize = 15.sp, modifier = Modifier.weight(1f))
            if (update != null) {
                Button(
                    onClick = onUpdate,
                    enabled = !updating,
                    colors = ButtonDefaults.colors(
                        containerColor = Accent, contentColor = Color.White,
                        focusedContainerColor = Color(0xFF7FB0FF), focusedContentColor = Bg,
                    ),
                ) { Text(if (updating) "Downloading…" else "Install update") }
                Spacer(Modifier.width(12.dp))
            }
            Button(onClick = onRefresh) { Text("Refresh") }
            Spacer(Modifier.width(12.dp))
            Button(onClick = onSettings) { Text("Settings") }
        }
        Spacer(Modifier.height(20.dp))
        when {
            listing == null && error != null -> Message("Can't load streams", error)
            listing == null -> Message("Loading games…")
            games.isEmpty() -> Message("No NHL games listed right now.")
            else -> LazyColumn(
                state = listState,
                verticalArrangement = Arrangement.spacedBy(20.dp),
                contentPadding = PaddingValues(bottom = 40.dp),
            ) {
                var league: String? = null
                for (game in games) {
                    if (game.league != league) {
                        league = game.league
                        item(key = "league|${game.league}") {
                            Text(game.league.uppercase(), color = Muted, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
                        }
                    }
                    item(key = game.id) {
                        GameRow(
                            game, listing, labels[game.name],
                            focusLink = target?.takeIf { it.first == game.id }?.second,
                            focusRequester = focusRequester,
                            onPlay = onPlay,
                        )
                    }
                }
            }
        }
    }

    LaunchedEffect(target != null) {
        if (target == null) return@LaunchedEffect
        withFrameNanos { } // wait for the list to be laid out
        runCatching { focusRequester.requestFocus() }
    }
}

private fun statusText(listing: Listing?, error: String?): String {
    if (error != null) return "Server: $error"
    if (listing?.updated == null) return "Loading…"
    val working = listing.nhl.map { it.link }.distinct().count { listing.status(it) == "ok" }
    val time = runCatching {
        OffsetDateTime.parse(listing.updated).atZoneSameInstant(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("h:mm a"))
    }.getOrDefault("")
    return "Updated $time · $working working" + if (listing.error != null) " · refresh failed" else ""
}

@Composable
private fun Message(title: String, text: String? = null) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, color = TextColor, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            if (text != null) Text(text, color = Muted, fontSize = 16.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun GameRow(
    game: Game,
    listing: Listing,
    label: Label?,
    focusLink: String?,
    focusRequester: FocusRequester,
    onPlay: (Game, Stream) -> Unit,
) {
    val ok = game.links.count { listing.status(it.link) == "ok" }
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(listing.localTime(game.time), color = Muted, fontSize = 16.sp, modifier = Modifier.width(72.dp))
            Text(
                label?.text ?: game.name, color = TextColor, fontSize = 22.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (label?.live == true) {
                Text(
                    "LIVE", color = Live, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold,
                    modifier = Modifier.padding(start = 10.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            val extra = game.links.size - ok
            Text("$ok working" + if (extra > 0) " · $extra checking" else "", color = Muted, fontSize = 14.sp)
        }
        Spacer(Modifier.height(10.dp))
        if (game.links.isEmpty()) {
            Text("No working links right now. The server keeps checking.", color = Muted, fontSize = 15.sp, modifier = Modifier.padding(start = 72.dp))
        } else {
            // Padding leaves room for the focused card to grow.
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                contentPadding = PaddingValues(start = 72.dp, end = 24.dp, top = 6.dp, bottom = 6.dp),
            ) {
                items(game.links) { s ->
                    LinkCard(
                        s, verified = listing.status(s.link) == "ok",
                        modifier = if (s.link == focusLink) Modifier.focusRequester(focusRequester) else Modifier,
                        onClick = { onPlay(game, s) },
                    )
                }
            }
        }
    }
}

@Composable
private fun LinkCard(stream: Stream, verified: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Surface(
        onClick = onClick,
        modifier = modifier.width(230.dp).height(76.dp),
        shape = ClickableSurfaceDefaults.shape(shape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Card, contentColor = TextColor,
            focusedContainerColor = AccentSoft, focusedContentColor = Color.White,
        ),
        border = ClickableSurfaceDefaults.border(
            border = Border(BorderStroke(1.dp, BorderColor), shape = shape),
            focusedBorder = Border(BorderStroke(2.dp, Accent), shape = shape),
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 16.dp).alpha(if (verified) 1f else .6f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(stream.title, fontSize = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                stream.name + if (verified) "" else " · checking",
                color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
