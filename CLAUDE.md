# htv: notes for Claude Code

Electron desktop app (Windows / macOS universal / Linux) for watching NHL streams listed on onhockey.tv, plus a headless **server mode** that runs on the owner's home Linux server in Docker. The user-facing overview is in README.md; this file covers what a new session needs to work on the code.

## Layout

| File | Role |
|---|---|
| `src/main.js` | Desktop main process: window (hidden title bar), IPC, settings, refresh loop (server first, local scrape fallback), on-disk caches |
| `src/server.js` | Headless server mode: scrape every `HTV_REFRESH_MIN`, check links continuously, serve `GET /health` and `GET /api/streams` (Bearer `HTV_TOKEN`) |
| `src/engine.js` | Shared by both: Electron setup (`configure()` must run before `app.whenReady`), extract session, ad blocking, `extractVerified()`, `nhlLinks()` |
| `src/scraper.js` | Fetches `https://onhockey.tv/schedule_table.php` (cp1251) and parses it with htmlparser2. Records: `{league, game, time, feed, name, channel, link}`, where `link` is the text after `np_stream400.php?channel=//` |
| `src/extractor.js` | Loads an embed in two hidden, muted windows at once (onhockey's wrapper page and the bare embed) and captures the first `.m3u8` GET plus the player's request headers |
| `src/proxy.js` | `htvstream://` protocol: fetches upstream through the extract session and rewrites playlists; `decorate()` swaps a marker header for the captured headers; `probe()` checks that a playlist really loads |
| `src/checker.js` | Queue of link checks (`setConcurrency`); `snapshot()`/`seed()` exchange `{link: {status, at}}` with disk caches and the server |
| `src/stats.js` | NHL public API (`api-web.nhle.com/v1/score/now`): live stats panel and `CGY-EDM 1-3` labels. onhockey lists games "away - home" |
| `src/renderer/` | UI: sidebar, hls.js player with custom controls, stats panel, server settings (⚙) |
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

**Not yet tested (next step):** the **Docker image**. It was written on a Windows machine without a Docker engine. On the Linux server:
1. `docker compose up -d --build` and fix whatever the build or runtime needs. Likely suspects: missing Electron runtime libraries in the Dockerfile's apt list, and the sandbox/shared-memory flags.
2. Confirm `docker compose logs -f` shows `listening`, a `schedule: … NHL` line, then `ok`/`fail` lines.
3. From another machine on the tailnet, `curl http://<tailscale-ip>:8787/health`.
4. In the app's ⚙ settings, enter the server URL and token, and check that the status line says "via server".

Ideas the owner has discussed but not asked for: reusing the server's stream captures for instant playback when the app is on the same network (tokens appear to be tied to the requesting IP), and publishing the image to GHCR from CI.
