<p align="center">
  <img src="build/icon.png" alt="htv icon" width="160">
</p>

<h1 align="center">htv</h1>

A desktop app for watching NHL streams listed on onhockey.tv, with its own player, built-in ad blocking and live game stats.

- **Streams:** scrapes onhockey.tv's schedule. Every NHL / NHL Preseason link is checked in the background, dead links are hidden, and the list re-fetches every 5 minutes.
- **Player:** grabs the HLS feed behind each embed and plays it in htv's own player: play/pause, volume, jump to live, quality, picture-in-picture and fullscreen. If a link dies, the player skips to the next working one. The site's original embed is still available, with ads blocked.
- **Blocking:** ads are blocked in every session and popups everywhere; Ctrl+T/N/W do nothing.
- **Live stats:** a score, clock, shots and goals panel with scorers and assists, plus `CGY-EDM 0-3` style labels. Data comes from the NHL's public web API (`api-web.nhle.com`).

## Development

```sh
npm install
npm start          # run the app
npm run scrape     # scrape onhockey.tv to streams.json without the UI
```

Keyboard: `Space`/`K` play-pause · `M` mute · `F` fullscreen · `↑`/`↓` volume · `S` toggle sidebar · `F5` refresh · `F12` devtools.

## Home server

htv can run headless on an always-on machine and keep the list and link checks current around the clock. The app then starts from the server's results instead of checking every link itself. This works best on a server at home: stream hosts often block data-centre IPs, and checks run from the same connection the app uses.

```sh
# on the server (Linux + Docker)
git clone https://github.com/mfan88/htv.git && cd htv
echo "HTV_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
docker compose logs -f          # watch links being checked
```

Release builds use a built-in server by default: the release workflow writes the GitHub secrets `HTV_SERVER_URL` and `HTV_TOKEN` into the app. That token isn't secret (anyone can read it out of the app); it only keeps out random scanners. The server is published through Caddy on the server (a `reverse_proxy 127.0.0.1:8787` site with `flush_interval -1`, so streams aren't buffered), at `https://htv.fenna.tech`.

In the app, the ⚙ next to Refresh can switch to **Generate links on this computer**, or point at a different server with its own token. The status line shows **via server** when it's working; if the server can't be reached, the app checks links itself.

| Endpoint | |
|---|---|
| `GET /health` | `{ ok, version }`, no token needed |
| `GET /api/streams` | the scraped schedule plus `checks: { link: { status: "ok" \| "fail", at } }` |
| `GET /api/summary` | flat numbers for dashboards: `status`, `uptimeSec`, `lastScrape`, `links`, `workingLinks`, `failedLinks`, `pendingLinks`, `liveGames`, `upcomingGames`, `finishedGames`, `gamesToday` (games from the NHL API) |
| `GET /api/play?link=…` | extracts a listed NHL link and returns `{ ok, src }`, a proxied HLS URL |
| `GET /api/labels` | `CGY-EDM 1-3` style score labels for the listed games |
| `GET /s/…` | the stream proxy; URLs are signed by `/api/play`, so they need no token |
| `GET /api/tv-update` | the Android TV build in `<data>/androidtv/`: `{ available, versionCode, versionName, url }` |
| `GET /api/tv-update/apk` | that build's APK |
| `GET /` | the phone web player (below); it asks for the token itself |

Server settings are environment variables in `docker-compose.yml`: `HTV_TOKEN` (from `.env`), `HTV_CONCURRENCY` (default 3), `HTV_REFRESH_MIN` (default 5), `HTV_PORT` (default 8787). To run it without Docker: `npx electron src/server.js`; on Linux without a display, use `xvfb-run -a`.

## iPhone and AirPlay

The server also serves a web player for phones at `/`. The server extracts each stream and proxies it (with its own ad blocking and popup blocking), so the phone only ever loads a plain HLS stream: there are no embed pages, ads or popups on the phone. Safari plays it natively, which means **AirPlay sends the stream itself to an Apple TV**, not a mirror of the phone's screen. The Apple TV then fetches the video from the server directly, and the phone works as a remote.

Setup, once per phone: open `https://htv.fenna.tech/#token=<HTV_TOKEN>` in Safari. The page saves the token and removes it from the address bar. Then use Share → **Add to Home Screen**.

- **Use an address the Apple TV can reach**, because it fetches the stream from whatever address the phone used. The public address or the server's LAN address work; its Tailscale `100.x` address doesn't, since the Apple TV isn't on the tailnet.
- **Away from home**, the video comes over your home upload.
- Android phones and desktop browsers can use the page too (through hls.js), just without AirPlay.

## Android TV

`androidtv/` is a small Android TV app (Kotlin, Compose for TV, ExoPlayer) that uses the same server: it lists the games, and the server extracts and proxies whichever link you pick. On the remote, OK plays or pauses, ◀ ▶ switch between the game's links, and Back returns to the list. If a link fails, the app moves on to the next one.

Build it (needs JDK 21 and the Android SDK; the version follows `package.json`):

```sh
cd androidtv
printf 'sdk.dir=/path/to/android/sdk\nhtv.serverUrl=https://htv.fenna.tech\nhtv.token=<HTV_TOKEN>\n' > local.properties
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk
```

`htv.serverUrl` and `htv.token` (or the `HTV_SERVER_URL` / `HTV_TOKEN` env vars) become the built-in server; you can also set one in the app's Settings. Use the public address rather than a Tailscale one, so the TV doesn't depend on Tailscale staying logged in. Install on the TV by turning on Developer options → Network debugging (or USB debugging), then:

```sh
adb connect <tv-ip>
adb install -r app/build/outputs/apk/release/app-release.apk
```

The APK is signed with the local debug key, so reinstalling a build from a different machine needs an uninstall first.

**Updates without adb:** after the first install, publish new builds to the server and the app shows **Install update** in its header (it checks at startup and every 30 minutes):

```sh
androidtv/publish.sh <ssh host>          # e.g. mfan@zimaboard
```

It builds the release APK and copies it into the server's `/data/androidtv/` with `docker cp` (Docker owns `htv-data/`, so a plain `scp` into it fails). The first update asks you to allow installs from htv (Settings → allow, then press Install update again); after that each update is one confirmation. Android closes the app while it updates, so reopen it afterwards. Every build gets a higher version code (seconds since 2026), so any new build counts as an update. Updates must come from the same machine as the first install, because the signing key has to match.

## Building locally

```sh
npm run dist:win     # dist/htv Setup x.y.z.exe + portable exe
npm run dist:mac     # universal (Intel + Apple Silicon) .dmg; must run on a Mac
npm run dist:linux   # AppImage
```

## Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) whenever a `v*` tag is pushed:

```sh
npm version patch        # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The workflow builds Windows, macOS and Linux and uploads everything to a **draft** release. Review it on the Releases page, then press *Publish*.

### macOS signing and notarization

Add these as repository secrets (Settings → Secrets and variables → Actions). Without them the Mac build is still produced, but unsigned.

| Secret | What it is |
|---|---|
| `MAC_CERT_P12_BASE64` | Your *Developer ID Application* certificate exported from Keychain as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CERT_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-character Team ID (developer.apple.com → Membership) |

The Windows build is intentionally unsigned.
