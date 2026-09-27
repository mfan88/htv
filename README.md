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

Release builds use a built-in server by default: the release workflow writes the GitHub secrets `HTV_SERVER_URL` and `HTV_TOKEN` into the app. That token isn't secret (anyone can read it out of the app); it only keeps out random scanners. The server is published with Tailscale Funnel: `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8787`.

In the app, the ⚙ next to Refresh can switch to **Generate links on this computer**, or point at a different server with its own token. The status line shows **via server** when it's working; if the server can't be reached, the app checks links itself.

| Endpoint | |
|---|---|
| `GET /health` | `{ ok, version }`, no token needed |
| `GET /api/streams` | the scraped schedule plus `checks: { link: { status: "ok" \| "fail", at } }` |

Server settings are environment variables in `docker-compose.yml`: `HTV_TOKEN` (from `.env`), `HTV_CONCURRENCY` (default 3), `HTV_REFRESH_MIN` (default 5), `HTV_PORT` (default 8787). To run it without Docker: `npx electron src/server.js`; on Linux without a display, use `xvfb-run -a`.

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
