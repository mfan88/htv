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

Without Docker: `npm install && npx playwright-core install chromium && node src/server.js`.

Settings are environment variables (see `docker-compose.yml`): `HTV_TOKEN` (required in compose), `HTV_CONCURRENCY` (links checked at once, default 3), `HTV_REFRESH_MIN` (default 5), `HTV_PORT` (default 8787), `HTV_DATA` (caches, default `./htv-data`), `HTV_LOGOS` (thumbnail folder, default `<data>/logos`).

To publish it, put a reverse proxy in front (Caddy: `reverse_proxy 127.0.0.1:8787 { flush_interval -1 }` so streams aren't buffered).

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
