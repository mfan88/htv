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
