import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The built-in server, like the desktop app's src/defaults.json: htv.serverUrl / htv.token
// in androidtv/local.properties (git-ignored), else the HTV_SERVER_URL / HTV_TOKEN env vars.
val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun setting(prop: String, env: String) = localProps.getProperty(prop) ?: System.getenv(env) ?: ""
fun quoted(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// Same version name as the desktop app.
val appVersion = Regex("\"version\"\\s*:\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"")
    .find(rootProject.file("../package.json").readText())!!.groupValues

android {
    namespace = "app.htv.tv"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.htv.tv"
        minSdk = 23
        targetSdk = 36
        versionName = appVersion.drop(1).joinToString(".")
        // Seconds since 2026-01-01, so every new build counts as newer for the in-app updater
        // (and adb install -r) without bumping package.json.
        versionCode = (System.currentTimeMillis() / 1000 - 1_767_225_600).toInt()
        buildConfigField("String", "SERVER_URL", quoted(setting("htv.serverUrl", "HTV_SERVER_URL")))
        buildConfigField("String", "TOKEN", quoted(setting("htv.token", "HTV_TOKEN")))
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // Sideloaded only, so the debug key is enough to install it.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.tv:tv-material:1.1.0")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
}
