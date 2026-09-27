package app.htv.tv

import android.content.Context

data class Server(val url: String, val token: String)

// The server to use: one saved in Settings replaces the built-in one (BuildConfig, set at
// build time from local.properties or the HTV_SERVER_URL / HTV_TOKEN env vars).
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("htv", Context.MODE_PRIVATE)

    val savedUrl: String get() = prefs.getString("serverUrl", "") ?: ""
    val savedToken: String get() = prefs.getString("token", "") ?: ""
    val hasBuiltIn get() = BuildConfig.SERVER_URL.isNotBlank()

    fun server(): Server? = when {
        savedUrl.isNotBlank() -> Server(savedUrl, savedToken)
        hasBuiltIn -> Server(normalizeServerUrl(BuildConfig.SERVER_URL), BuildConfig.TOKEN)
        else -> null
    }

    fun save(url: String, token: String) {
        prefs.edit().putString("serverUrl", normalizeServerUrl(url)).putString("token", token.trim()).apply()
    }
}

fun normalizeServerUrl(raw: String): String {
    val s = raw.trim().trimEnd('/')
    if (s.isEmpty()) return ""
    return if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s else "http://$s"
}
