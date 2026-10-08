# htv

A headless server that scrapes the NHL schedule on onhockey.tv and serves every game to **Jellyfin Live TV** as an M3U tuner plus an XMLTV guide.

- **Scraper:** fetches onhockey.tv's schedule every 5 minutes. Only NHL / NHL Preseason links are used.
- **Link checker:** loads each embed in headless Chromium (Playwright, ads and popups blocked), captures the HLS playlist behind it and confirms it loads. Games on or near the air are rechecked every 3 minutes, the rest every 10.
- **Channels:** one Jellyfin channel per feed/channel of each game (`CHI @ BUF · SN+`, `CHI @ BUF · ESPN+ (away feed)`). A channel is a set of mirrors; the server plays a working one and swaps to another between two playlist polls if it dies, so the player doesn't notice.
- **Guide:** XMLTV with a "starting soon" block before each game, titles that include the channel, and optional matchup thumbnails.
- **Scores:** `CHI @ BUF` names and start times come from the NHL's public API (`api-web.nhle.com`).

## Run it

On an always-on machine at home with Docker (stream hosts often block data-centre IPs):

```sh
git clone https://github.com/mfan88/htv.git && cd htv
echo "HTV_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
docker compose logs -f          # `ok` / `fail` per link, `live ok …` per tune-in
```

### From the published image (no clone, no build)

`ghcr.io/mfan88/htv:latest` is built by GitHub Actions on every push to `main` (amd64 and arm64). Save this as `docker-compose.yml` in an empty folder, put `HTV_TOKEN=<a long random string>` in a `.env` next to it, and run `docker compose up -d`. It needs Docker Compose 2.23.1 or newer (compose generates the MediaMTX config from `.env`). Only `HTV_TOKEN` is required; the rest are optional. `cpus:` caps how much CPU htv may use.

```yaml
services:
  htv:
    image: ghcr.io/mfan88/htv:latest
    container_name: htv-server
    restart: unless-stopped
    ports:
      - "${HTV_PORT:-8787}:8787"
    environment:
      HTV_TOKEN: ${HTV_TOKEN:?set HTV_TOKEN in .env}
      HTV_CONCURRENCY: ${HTV_CONCURRENCY:-3}
      HTV_REFRESH_MIN: ${HTV_REFRESH_MIN:-5}
      HTV_LOGOS: /logos
      HTV_PRIORITY_TEAMS: ${HTV_PRIORITY_TEAMS:-}      # e.g. "edmonton,oilers"; empty = keep every game warm
      HTV_PRIORITY_LEAD_MIN: ${HTV_PRIORITY_LEAD_MIN:-60}
      HTV_DEMAND_MIN: ${HTV_DEMAND_MIN:-20}
      HTV_IDLE_RECHECK_MIN: ${HTV_IDLE_RECHECK_MIN:-180}
      HTV_IDLE_LINKS: ${HTV_IDLE_LINKS:-1}
      HTV_EDGE_PUBLIC: ${HTV_EDGE_PUBLIC:-}
      HTV_CHROMIUM_NICE: 15
      HTV_DISABLE_GPU: "1"
      HTV_BLOCK_HEAVY: "1"
    volumes:
      - ${HTV_LOGOS:-./logos}:/logos:ro   # optional AWAY_vs_HOME.png thumbnails
      - ./htv-data:/data
    cpus: 4                  # CPU cap; raise or lower to taste
    cpu_shares: 256
    shm_size: 512m

  # MediaMTX is the single place IPTV apps (TiviMate, VLC) pull from: one pull per channel from htv,
  # shared by every viewer. Playlist for it: http://<host>:8787/api/m3u-edge?token=<HTV_TOKEN>
  mediamtx:
    image: bluenviron/mediamtx:1.15.0   # pinned: newer releases require a session cookie that IPTV apps may not send
    container_name: htv-mediamtx
    restart: unless-stopped
    depends_on:
      - htv
    ports:
      - "${MTX_HLS_PORT:-8888}:8888"    # HLS: http://<host>:8888/ch_<id>/index.m3u8
      - "${MTX_WEBRTC_PORT:-8889}:8889" # WebRTC page / signalling
      - "8189:8189/udp"                 # WebRTC media
    configs:
      - source: mediamtx
        target: /mediamtx.yml

configs:
  mediamtx:
    content: |
      logLevel: info
      readTimeout: 30s    # htv can take a while to find a mirror on a cold channel
      rtsp: no
      rtmp: no
      srt: no
      api: no
      metrics: no
      pprof: no
      playback: no
      hls: yes
      hlsAddress: :8888
      hlsAlwaysRemux: no
      hlsAllowOrigin: '*'
      webrtc: yes
      webrtcAddress: :8889
      webrtcAllowOrigin: '*'
      webrtcLocalUDPAddress: :8189
      webrtcAdditionalHosts: [${HTV_RTC_HOST:-}]
      paths:
        "~^ch_([0-9a-f]+)$$":
          source: http://htv:8787/live/$$G1.m3u8?token=${HTV_TOKEN}
          sourceOnDemand: yes
          sourceOnDemandStartTimeout: 30s
          sourceOnDemandCloseAfter: 60s
```

Optional `.env` keys: `HTV_PRIORITY_TEAMS` (e.g. `edmonton,oilers`: only those teams' games are kept warm, empty keeps every game warm), `HTV_LOGOS` (thumbnail folder), `HTV_EDGE_PUBLIC` (`<source hostname>=<MediaMTX HLS URL>` for a public setup), `HTV_RTC_HOST` (public hostname of the WebRTC page).

Without Docker: `npm install && npx playwright-core install chromium && node src/server.js`.

Settings are environment variables (see `docker-compose.yml`): `HTV_TOKEN` (required in compose), `HTV_CONCURRENCY` (links checked at once, default 3), `HTV_REFRESH_MIN` (default 5), `HTV_PORT` (default 8787), `HTV_DATA` (caches, default `./htv-data`), `HTV_LOGOS` (thumbnail folder, default `<data>/logos`). Failover tuning (all optional): `HTV_PLAYLIST_TIMEOUT_SEC` (6), `HTV_SEGMENT_TIMEOUT_SEC` (12), `HTV_STALL_SEC` (12): how long a mirror may be slow or frozen before a channel switches to another one. Load tuning: `HTV_CHROMIUM_NICE` (15; link-check browser runs at low CPU priority so it cannot starve the stream proxy, 0 = off) and `HTV_DEMAND_SCOPE` (default: only the tuned channel's mirrors are kept warm; `game` keeps every feed of the tuned game warm, so switching feed is instant but uses far more CPU).

To publish it, put a reverse proxy in front (Caddy: `reverse_proxy 127.0.0.1:8787 { flush_interval -1 }` so streams aren't buffered).

## TiviMate, VLC and browsers (MediaMTX)

A MediaMTX container in the same compose project serves every channel as HLS from one shared pull. Playlist for IPTV apps: `http://<server>:8787/api/m3u-edge?token=<HTV_TOKEN>`. Setup, testing and troubleshooting: [MEDIAMTX.md](MEDIAMTX.md).

## Jellyfin Live TV

In Jellyfin: **Dashboard → Live TV**.

1. **Tuner devices → +**: type **M3U Tuner**, URL `http://<server>:8787/api/m3u?token=<HTV_TOKEN>`.
2. **TV guide data providers → + → XMLTV**: URL `http://<server>:8787/api/xmltv?token=<HTV_TOKEN>`.
3. In **Scheduled tasks → Refresh Guide**, run it every few hours: the channel list changes as games are added each day.

`<server>` must be an address the Jellyfin container can reach. Channel URLs use whatever address Jellyfin fetched the list from.

### Thumbnails

Put `AWAY_vs_HOME.png` files (NHL tricodes, e.g. `CHI_vs_BUF.png`, 16:9) in the logos folder. Channels with a matching file get it as their image in the channel list and guide; the rest show text.

## Endpoints

| Endpoint | |
|---|---|
| `GET /health` | `{ ok, version }`, no token |
| `GET /api/streams` | the scraped schedule plus `checks: { link: { status, at } }` |
| `GET /api/summary` | flat numbers for dashboards (e.g. a Homepage customapi widget) |
| `GET /api/m3u`, `/api/xmltv` | the Jellyfin tuner and guide |
| `GET /live/<channel>.m3u8` | a channel's playlist, always from a working mirror |
| `GET /s/…` | the stream proxy; URLs are signed, so players fetch them without the token |
| `GET /logo/AWAY_vs_HOME.png` | thumbnails, no token (Jellyfin fetches them itself) |

Everything but `/health`, `/s/` and `/logo/` needs `Authorization: Bearer <token>` or `?token=<token>`.
