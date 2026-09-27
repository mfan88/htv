package app.htv.tv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.TimeZone

// Talks to htv server mode (src/server.js). The server scrapes, checks and extracts every
// stream and proxies it, so this app only lists links and plays the URL it gets back.

val NHL_LEAGUES = setOf("nhl", "nhl preseason")

/** One row of onhockey's schedule. `link` is the embed URL without its scheme. */
data class Stream(
    val league: String, val game: String, val time: String,
    val feed: String, val name: String, val channel: String, val link: String,
) {
    // "Home SN" from "(feed) (channel)"; the source name when both are missing.
    val title: String
        get() {
            val f = feed.replace(Regex("\\s*feed$", RegexOption.IGNORE_CASE), "")
                .replaceFirstChar { it.uppercase() }
            return listOf(f, channel).filter { it.isNotBlank() }.joinToString(" ").ifBlank { name }
        }
}

/** A game with its playable links, verified ones first. */
data class Game(val id: String, val league: String, val time: String, val name: String, val links: List<Stream>)

data class Label(val away: String, val home: String, val awayScore: Int?, val homeScore: Int?, val state: String) {
    val live get() = state == "LIVE" || state == "CRIT"
    // "CGY-EDM 0-3": onhockey lists games "away - home".
    val text get() = "$away-$home" + if (awayScore != null && homeScore != null) " $awayScore-$homeScore" else ""
}

data class Listing(
    val updated: String?,
    val sourceUtcOffset: Int,
    val streams: List<Stream>,
    val checks: Map<String, String>, // link -> "ok" | "fail"
    val error: String?,
) {
    val nhl get() = streams.filter { it.league.lowercase() in NHL_LEAGUES }
    fun status(link: String) = checks[link]

    /** NHL games in schedule order. Dead links are dropped; verified ones sort first. */
    fun games(): List<Game> {
        val grouped = LinkedHashMap<String, MutableList<Stream>>()
        for (s in nhl) grouped.getOrPut("${s.league}|${s.time}|${s.game}") { mutableListOf() } += s
        return grouped.map { (id, rows) ->
            val first = rows.first()
            val alive = rows.filter { status(it.link) != "fail" }
                .sortedBy { if (status(it.link) == "ok") 0 else 1 }
            Game(id, first.league, first.time, first.game, alive)
        }
    }

    // onhockey lists times in GMT+1; convert to the TV's local time.
    fun localTime(t: String): String {
        val m = Regex("^(\\d{1,2}):(\\d{2})$").find(t) ?: return t
        val local = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000
        var mins = (m.groupValues[1].toInt() - sourceUtcOffset) * 60 + m.groupValues[2].toInt() + local
        mins = ((mins % 1440) + 1440) % 1440
        return "%02d:%02d".format(mins / 60, mins % 60)
    }
}

class Unauthorized : IOException("the server rejected the token")

class Api(val server: Server) {
    private fun <T> request(path: String, readTimeoutMs: Int, read: (HttpURLConnection) -> T): T {
        val conn = URL(server.url + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = readTimeoutMs
        if (server.token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer ${server.token}")
        try {
            val code = conn.responseCode
            if (code == 401) throw Unauthorized()
            if (code !in 200..299) throw IOException("the server returned HTTP $code")
            return read(conn)
        } finally {
            conn.disconnect()
        }
    }

    private fun get(path: String, readTimeoutMs: Int = 10_000): JSONObject =
        request(path, readTimeoutMs) { JSONObject(it.inputStream.bufferedReader().use { r -> r.readText() }) }

    suspend fun streams(): Listing = withContext(Dispatchers.IO) {
        val d = get("/api/streams")
        val rows = d.optJSONArray("streams")
        val streams = (0 until (rows?.length() ?: 0)).map { i ->
            val r = rows!!.getJSONObject(i)
            Stream(
                r.optString("league"), r.optString("game"), r.optString("time"),
                r.optString("feed"), r.optString("name"), r.optString("channel"), r.optString("link"),
            )
        }
        val checks = mutableMapOf<String, String>()
        d.optJSONObject("checks")?.let { c ->
            for (link in c.keys()) c.optJSONObject(link)?.optString("status")?.let { checks[link] = it }
        }
        Listing(
            updated = if (d.isNull("updated")) null else d.optString("updated"),
            sourceUtcOffset = d.optInt("source_utc_offset", 1),
            streams = streams,
            checks = checks,
            error = d.optString("error").takeIf { !d.isNull("error") && it.isNotEmpty() },
        )
    }

    suspend fun labels(): Map<String, Label> = withContext(Dispatchers.IO) {
        val d = get("/api/labels")
        d.keys().asSequence().associateWith { name ->
            val l = d.getJSONObject(name)
            Label(
                l.optString("away"), l.optString("home"),
                if (l.isNull("awayScore")) null else l.optInt("awayScore"),
                if (l.isNull("homeScore")) null else l.optInt("homeScore"),
                l.optString("state"),
            )
        }
    }

    /** The newest app build the server offers, or null if it has none. */
    suspend fun update(): Update? = withContext(Dispatchers.IO) {
        val d = get("/api/tv-update")
        if (!d.optBoolean("available")) null
        else Update(d.getInt("versionCode"), d.optString("versionName"), d.getString("url"))
    }

    suspend fun download(path: String, to: File) = withContext(Dispatchers.IO) {
        request(path, 30_000) { conn -> conn.inputStream.use { input -> to.outputStream().use { input.copyTo(it) } } }
    }

    /** Extracts `link` on the server and returns the absolute URL of its proxied HLS stream. */
    suspend fun play(link: String): String = withContext(Dispatchers.IO) {
        // Extraction plus the playlist check can take the server up to ~40 s.
        val d = get("/api/play?link=" + URLEncoder.encode(link, "UTF-8"), readTimeoutMs = 60_000)
        if (!d.optBoolean("ok")) throw IOException(d.optString("error", "No playable stream found in this link."))
        URL(URL(server.url), d.getString("src")).toString()
    }
}
