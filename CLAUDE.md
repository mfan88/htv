# htv: notes for Claude Code

A headless Node server (no UI, no client apps) that scrapes NHL streams from onhockey.tv and serves them to **Jellyfin Live TV**. It runs on the owner's home Linux server (zimaboard) in Docker. The user-facing overview is README.md; this file covers what a new session needs.

It used to be an Electron desktop app plus an Android TV app. Both were deleted (see git history before the "headless" commit if you need them); the engine moved from Electron to Playwright's headless Chromium.

## Layout

| File | Role |
|---|---|
| `src/server.js` | Entry point. Scrape every `HTV_REFRESH_MIN`, check links continuously, serve `GET /health`, `/api/streams`, `/api/summary` (Bearer `HTV_TOKEN`), the Jellyfin feeds `/api/m3u`, `/api/xmltv`, `/live/<id>.m3u8`, thumbnails `/logo/AWAY_vs_HOME.png`, and the signed stream proxy `/s/<ctx>/<sig>/<file>?u=`. The `<file>` part is an unsigned name with a media extension (`s.ts`, `s.m3u8`), because ffmpeg (so Jellyfin) refuses HLS segments without one |
| `src/engine.js` | Launches Chromium (Playwright) with one shared browser context, ad blocking (`@ghostery/adblocker-playwright`), `extractVerified()`, `nhlLinks()`; relaunches after a browser crash |
| `src/extractor.js` | Loads an embed in two hidden pages at once (onhockey's wrapper and the bare embed) and captures the first `.m3u8` GET plus the player's request headers |
| `src/proxy.js` | Fetches upstream through the context's request API (shared cookies, captured headers replayed), rewrites playlists, unwraps segments disguised as images (fake WebP/PNG header before the TS packets; ffmpeg can't read those), `probe()` |
| `src/checker.js` | Queue of link checks (`setConcurrency`); hot links (games on/near the air) are rechecked sooner and queued first |
| `src/livetv.js` | M3U and XMLTV: one channel per game + feed/channel pair (id = hash of league/time/game/feed/channel); `hotLinks()` |
| `src/scraper.js` | Fetches `https://onhockey.tv/schedule_table.php` (cp1251), parses with htmlparser2. Records `{league, game, time, feed, name, channel, link}` |
| `src/stats.js` | NHL API (`api-web.nhle.com/v1/score/now`): `CGY @ EDM` labels and start times. onhockey lists games "away - home" |
| `Dockerfile`, `docker-compose.yml` | Node + Chromium headless shell under `tini`; data in `/data`, thumbnails mounted at `/logos` (`HTV_LOGOS` in `.env`) |

## How a tune works (the part that matters most)

`/live/<id>.m3u8` does not redirect. It serves the playlist itself, so Jellyfin's ffmpeg keeps polling it and the server can swap a dead mirror between polls: `current` (channel -> mirror) is tried first, then recent captures from the checker (probed), then a fresh extraction of up to 3 links. A master playlist is flattened to its best variant, and `#EXT-X-MEDIA-SEQUENCE` is renumbered so it never goes backwards across a swap. A failed playlist or segment (after one retry on 5xx) marks the mirror down (`down <link>` in the log).

## Conventions

- CommonJS, no build step. Match the existing style: short comments that explain *why*.
- Only NHL and NHL Preseason links are used (`engine.NHL_LEAGUES`).
- Commit messages end with a `Co-Authored-By:` line.

## Running and testing

```sh
npm install && npx playwright-core install chromium
HTV_TOKEN=t HTV_PORT=8788 HTV_DATA=/tmp/htvdata node src/server.js
curl "localhost:8788/api/m3u?token=t"
ffmpeg -i "http://localhost:8788/live/<id>.m3u8?token=t" -t 10 -c copy -f null -   # what Jellyfin does
```

- No unit tests. Verify with ffmpeg against `/live/…`, the server log (`ok`/`fail` per link, `live ok …` per tune), and for Jellyfin itself `docker exec jellyfin /usr/lib/jellyfin-ffmpeg/ffmpeg …` on the server.
- Deploy: `git push`, then on the zimaboard `cd /mnt/nvme/htv && git pull && docker compose up -d --build` (`ssh mfan@zimaboard` works non-interactively; see memory).

## Server

Public at `https://htv.fenna.tech` through Caddy on the host (`/etc/caddy/Caddyfile`, which also serves Jellyfin and Seerr; no passwordless sudo, so ask the owner to restart it; `reload` once panicked, `restart` is safer). DNS on Cloudflare, DNS-only so video doesn't go through Cloudflare's proxy. Thumbnails live in `/mnt/nvme/htv-data/logos` (992 files, `AWAY_vs_HOME.png`).
