# Watching htv through MediaMTX (TiviMate, VLC, browsers)

htv finds working mirrors for each game and serves them at `/live/<id>.m3u8`. **MediaMTX** sits next to it
in the same compose project and acts as the single place viewers pull from:

```
 viewers (TiviMate, VLC, browser)
        |  http://<server>:8888/ch_<id>/index.m3u8
        v
   MediaMTX  --(one pull per channel, only while someone watches)-->  htv  -->  mirror
```

- A channel is pulled **on demand**: the first viewer starts it (about 6 s cold start), later viewers share it,
  and it stops 60 s after the last viewer leaves.
- Many viewers of one game cost htv and your upload one stream, not one each.
- Jellyfin still works the old way (`/api/m3u`) and is not affected.

## Quick start

All of this lives in `/mnt/nvme/htv`.

```bash
docker compose up -d            # htv + MediaMTX
docker compose ps               # both should be "Up"
```

### TiviMate (Android TV / Fire TV)

1. Add playlist, type **M3U playlist**, URL:
   `http://192.168.2.152:8787/api/m3u-edge?token=<HTV_TOKEN>`
2. When asked for an EPG, use the XMLTV URL:
   `http://192.168.2.152:8787/api/xmltv?token=<HTV_TOKEN>`
3. Channels appear in groups: **Live now**, **Upcoming**, **Finished**.
4. Refresh the playlist every few hours (TiviMate: Settings, Playlists, update interval). Channels change daily.

`<HTV_TOKEN>` is in `/mnt/nvme/htv/.env`. Always use the server's **LAN IP**, not `localhost` or `htv`:
the channel URLs in the playlist are built from the address you fetched it from.

### VLC / laptop

Open a network stream: `http://192.168.2.152:8888/ch_<id>/index.m3u8`. Find ids in the playlist
(`/api/m3u-edge`) or from the log. Or open the whole playlist file in VLC.

### Browser

HLS plays at `http://192.168.2.152:8888/ch_<id>/` (MediaMTX's built-in player page). Sub-second WebRTC:
`http://192.168.2.152:8889/ch_<id>/`. WebRTC needs Opus audio, so a channel with AAC audio may be silent there.

## Public addresses (DuckDNS + Caddy)

| Name | Goes to | Use |
|---|---|---|
| `https://htvsource.duckdns.org` | htv `:8787` | playlist, guide, thumbnails (needs `?token=`) |
| `https://htvhls.duckdns.org` | MediaMTX `:8888` | HLS channels |
| `https://htvrtc.duckdns.org` | MediaMTX `:8889` | WebRTC page / signalling |

- Caddy (in `/mnt/nvme/apps/dash/theme/Caddyfile`) terminates HTTPS with Let's Encrypt certificates and proxies to the
  local ports. The old file is saved as `Caddyfile.bak-htv-duckdns`. Reload after edits:
  `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.
- Away from home use `https://htvsource.duckdns.org/api/m3u-edge?token=<HTV_TOKEN>` (and `/api/xmltv`). The channels in
  that playlist are `https://htvhls.duckdns.org/ch_<id>/index.m3u8`. At home the same endpoint returns LAN URLs.
  This mapping is the `HTV_EDGE_PUBLIC` setting in `docker-compose.yml`.
- **WebRTC from outside needs UDP 8189 forwarded on your router** to this server. HTTPS alone is not enough, because
  the media itself flows over UDP 8189. MediaMTX advertises `htvrtc.duckdns.org` for it (`webrtcAdditionalHosts`).
- If your public IP changes, update the three DuckDNS names (or use DuckDNS's updater).
- `HTV_TOKEN` is checked by htv only. HLS and WebRTC on MediaMTX are open to anyone who knows a channel URL
  (the ids are 10 random-looking hex characters and only appear in the token-protected playlist). Keep the token long.
  If you change it in `.env`, also put it in `mediamtx/mediamtx.yml`, then `docker compose up -d htv && docker compose restart mediamtx`.

## Endpoints

| URL | What |
|---|---|
| `:8787/api/m3u-edge?token=` | playlist whose channels point at MediaMTX (use this for TiviMate) |
| `:8787/api/m3u?token=` | playlist whose channels point straight at htv (Jellyfin) |
| `:8787/api/xmltv?token=` | guide, for both |
| `:8888/ch_<id>/index.m3u8` | a channel as HLS from MediaMTX |
| `:8889/ch_<id>/` | a channel as WebRTC from MediaMTX |

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | `htv` and `mediamtx` services |
| `mediamtx/mediamtx.yml` | live config, contains `HTV_TOKEN`, git-ignored, mode 600 |
| `mediamtx/mediamtx.yml.example` | the same without the token, for a fresh setup |
| `src/livetv.js`, `src/server.js` | `/api/m3u-edge` and the channel groups |

The key part of `mediamtx.yml` is one regex path that turns any `ch_<id>` into a pull from htv:

```yaml
paths:
  "~^ch_([0-9a-f]+)$":
    source: http://htv:8787/live/$G1.m3u8?token=YOUR_HTV_TOKEN
    sourceOnDemand: yes
    sourceOnDemandCloseAfter: 60s
```

If you change `HTV_TOKEN` in `.env`, change it here too and run `docker compose restart mediamtx`.

## Checking that it works

```bash
# is a channel up? plain curl, no cookie jar (this is also the pin test: both lines must say 200)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/ch_<id>/index.m3u8        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/ch_<id>/video1_stream.m3u8  # 200, not 401

docker logs -f htv-mediamtx     # "[HLS source] started on demand" when someone tunes in
docker logs -f htv-server       # "live ok ..." / "live fail ..." per tune
docker stats htv-server htv-mediamtx
```

Healthy: MediaMTX logs `stream is available and online, 2 tracks (H264, MPEG-4 Audio)`, and CPU for
both containers stays low (MediaMTX repackages, it does not re-encode).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Channel won't start, no picture | htv has no working mirror for it right now (`live fail` in the htv log). Try another feed of the same game, or wait for the 3-minute recheck. |
| Channel loads but never plays (401 `session not found`) | MediaMTX 1.16+ ties HLS to a session cookie that IPTVnator and some TV apps do not send. The image is pinned to **1.15.0**, which has no cookie check. Do not switch back to `latest` (1.21 failed this test). |
| 401 from htv in MediaMTX log | Token in `mediamtx.yml` is stale. Match it to `.env`, restart `mediamtx`. |
| Playlist has `localhost` or `htv` URLs | You fetched the playlist via that name. Use the LAN IP. |
| Wrong group (all "Finished") | Game start times come from the NHL API or onhockey; a clock or timezone problem on the host shows up here. |
| `bad status code: 503` in the MediaMTX log | htv has no working mirror for that channel (not a MediaMTX problem). Pick another feed of the game, e.g. the same game on a different network. |
| `context deadline exceeded` in the MediaMTX log | MediaMTX gave up waiting on htv. `readTimeout` is set to 30 s; a channel that still hits it is usually dead or the host is overloaded (`uptime`, `docker stats`). |
| ~6 s to start a channel | Normal cold start. Later viewers join instantly. |
| Delay behind live | Mostly the source's own ~18 s HLS buffer. TiviMate's buffer setting (smallest that does not stutter) is the main lever. |

## Delay

MediaMTX repackages without re-encoding, so it adds little. The source stream is already about 18 s behind
real time because HLS players sit about three 6 s segments back. LL-HLS or WebRTC from MediaMTX can reduce
that for clients that support them (browsers, VLC to a degree); TiviMate support is unverified.

## Security

- MediaMTX has **no viewer login**, same as htv's stream paths. Fine on a LAN. Before exposing port 8888
  outside it, add auth (MediaMTX `authInternalUsers`) or put it behind Caddy with a token check.
- The playlist and guide are token-protected; the thumbnails are not.
- Ports published: 8787 (htv), 8888 (HLS), 8889 (WebRTC), 8189/udp (WebRTC media).

## Remote viewers and a VPS

At home you do not need a cloud. If people outside the house need to watch, home upload is the limit
(about 6 Mbps per active channel). Two options:

1. Run MediaMTX on a small VPS, reached from home over Tailscale or WireGuard. Point its `source:` at
   `http://<home-tailscale-ip>:8787/live/$G1.m3u8?token=...`. Home then uploads one stream per active channel,
   however many people watch.
2. Run all of htv on the VPS. Streaming sites often block datacenter IPs and the segment URLs can be tied to
   the extracting IP, so test one game before committing.

Avoid ffmpeg repackaging and cloud video services for this: they add delay and cost.

## Undo

```bash
docker compose rm -sf mediamtx   # then delete the mediamtx: block from docker-compose.yml
```

The old Jellyfin tuner (`/api/m3u`) keeps working throughout.

## Version pin (important)

`docker-compose.yml` pins `bluenviron/mediamtx:1.15.0`. Releases around 1.21 redirect the first HLS request and
then require a session cookie on every later request; IPTVnator (Mac app) hit exactly that (`401 session not found`
on the child playlist). Tested without cookies: 1.9.3, 1.12.3 and 1.15.0 work, 1.21.1 fails. Versions 1.16 to 1.20 were
not tested. Config key names differ from newer docs: `hlsAllowOrigin` and `webrtcAllowOrigin` (singular) in 1.15.
If you upgrade, rerun the cookie-less check in "Checking that it works" and read the release notes first.
