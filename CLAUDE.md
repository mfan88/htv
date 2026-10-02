# htv: notes for Claude Code

Electron desktop app (Windows / macOS universal / Linux) for watching NHL streams listed on onhockey.tv, plus a headless **server mode** that runs on the owner's home Linux server in Docker. The user-facing overview is in README.md; this file covers what a new session needs to work on the code.

## Layout

| File | Role |
|---|---|
| `src/main.js` | Desktop main process: window (hidden title bar), IPC, settings, refresh loop (server first, local scrape fallback), on-disk caches |
| `src/server.js` | Headless server mode: scrape every `HTV_REFRESH_MIN`, check links continuously, serve `GET /health` and `GET /api/streams` (Bearer `HTV_TOKEN`), plus what the TV app needs: `/api/play` (extract on demand), `/api/labels`, `/api/tv-update`, `/api/summary` and the signed stream proxy `/s/<ctx>/<sig>?u=`. It serves no web pages (the owner wants the public domain API-only; an iOS app is planned) |
| `src/engine.js` | Shared by both: Electron setup (`configure()` must run before `app.whenReady`), extract session, ad blocking, `extractVerified()`, `nhlLinks()` |
| `src/scraper.js` | Fetches `https://onhockey.tv/schedule_table.php` (cp1251) and parses it with htmlparser2. Records: `{league, game, time, feed, name, channel, link}`, where `link` is the text after `np_stream400.php?channel=//` |
| `src/extractor.js` | Loads an embed in two hidden, muted windows at once (onhockey's wrapper page and the bare embed) and captures the first `.m3u8` GET plus the player's request headers |
| `src/proxy.js` | `htvstream://` protocol: fetches upstream through the extract session and rewrites playlists; `decorate()` swaps a marker header for the captured headers; `probe()` checks that a playlist really loads. `respond()` is shared with the server's HTTP proxy |
| `src/checker.js` | Queue of link checks (`setConcurrency`); `snapshot()`/`seed()` exchange `{link: {status, at}}` with disk caches and the server |
| `src/stats.js` | NHL public API (`api-web.nhle.com/v1/score/now`): live stats panel and `CGY-EDM 1-3` labels. onhockey lists games "away - home" |
| `src/renderer/` | UI: sidebar, hls.js player with custom controls, stats panel, server settings (⚙) |
| `androidtv/` | Android TV app (Kotlin, Compose for TV, Media3 ExoPlayer), a client of server mode's API. Built-in server from `androidtv/local.properties` (`htv.serverUrl`, `htv.token`, git-ignored) or `HTV_SERVER_URL`/`HTV_TOKEN` |
| `Dockerfile`, `docker-compose.yml` | Server mode in Docker: Electron under `xvfb-run`, data in `/data` |
| `.github/workflows/release.yml` | On `v*` tags: builds win/mac/linux and uploads a draft GitHub release. The Mac build signs and notarizes when the Developer ID secrets are set, otherwise it's ad-hoc signed |

## Conventions

- CommonJS with no build step or bundler. Match the existing style: short comments that explain *why*.
- Only NHL and NHL Preseason links are shown or checked (`engine.NHL_LEAGUES`).
- Commit messages end with a `Co-Authored-By:` line. Release by running `npm version patch && git push --follow-tags`; a plain `git push` never releases.

## Running and testing

```sh
npm install
npm start                                      # desktop app
npx electron src/server.js                     # server mode (desktop OS)
xvfb-run -a npx electron --no-sandbox src/server.js   # server mode on a headless Linux box
docker compose up -d --build && docker compose logs -f   # server mode in Docker
curl localhost:8787/health
curl -H "Authorization: Bearer <token>" localhost:8787/api/streams
```

- There is no unit test suite. Verify behaviour by running things and checking their output: API responses, server logs (`ok`/`fail` per link), and screenshots via `webContents.capturePage()` in a small Electron harness that `require()`s `src/main.js`. Put scratch scripts outside the repo.
- Electron shows an **error dialog that blocks the main process** on uncaught exceptions. In test harnesses, add `process.on("uncaughtException")` and `process.on("unhandledRejection")` handlers that log instead, and give each step a timeout.
- Windows moved off-screen for tests need `app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")`, or they stop painting and `capturePage()` hangs.

## Status (end of the first build-out)

Done and tested on Windows: the app, the release pipeline (v1.0.0 released; the Mac build is signed and notarized), and server mode (auth, scraping, checks), plus app ↔ server (via server / wrong token / server down).

**Docker image: tested on the Linux server.** `docker compose up -d --build` builds. Logs show `listening`, `schedule: … NHL`, then `ok`/`fail`. `/health` answers on the Tailscale IP, and `/api/streams` returns 401 without the token. Gotcha: `xvfb-run` hangs as PID 1 (Xvfb starts but Electron never does), so the image runs under `tini`.

**Built-in server:** the app defaults to the server in `src/defaults.json` (`{serverUrl, token}`, git-ignored). The release workflow writes that file from the `HTV_SERVER_URL`/`HTV_TOKEN` secrets. Without it (dev runs), the app works locally unless a server is set in ⚙. ⚙ also has "Generate links on this computer" (`settings.mode = "local"`). The server token lives in `.env` (git-ignored). The server is public at `https://htv.fenna.tech` through Caddy on the host (`/etc/caddy/Caddyfile`, which also serves other sites; DNS on Cloudflare, DNS-only so video doesn't go through Cloudflare's proxy). It used to be on Tailscale Funnel; that's switched off. The token in the app is extractable by design.

**Phone web player:** removed (it lived in `src/web/`, see git history before it was deleted). It played the proxied HLS in a browser; the idea (native HLS playback so AirPlay hands the stream itself to an Apple TV) was never tested on a real iPhone, and applies to a native iOS app too.

**Android TV app:** tested on a Google TV emulator (API 36) against local server mode: list, focus, playback, switching links, pause, Back, Settings, and the in-app update (`Updater.kt`, served from `<data>/androidtv/` by `/api/tv-update`) from one build to a newer one. Not yet tested on a real TV. Build with JDK 21 (`JAVA_HOME=.../temurin-21.jdk/...`); the SDK on the owner's Mac is at `/opt/homebrew/share/android-commandlinetools`, with an AVD named `htv_tv`. The emulator reaches the host at `10.0.2.2`, and `adb exec-out screencap -p` takes screenshots. Tested on the owner's Mi TV too (Android 14): list and live playback through `https://htv.fenna.tech`. Publish updates with `androidtv/publish.sh <ssh host>`.

**Not yet tested:** a release build carrying `defaults.json` on Windows/macOS, reaching the server at its public address off the tailnet.

Ideas the owner has discussed but not asked for: reusing the server's stream captures for instant playback when the app is on the same network (tokens appear to be tied to the requesting IP), and publishing the image to GHCR from CI.
