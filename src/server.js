// htv server: scrapes onhockey.tv, checks every NHL link with headless Chromium around the
// clock, and serves the results as a Jellyfin Live TV tuner (M3U + XMLTV, one channel per
// feed of each game) plus the stream proxy those channels play through. No web pages.
//
//   node src/server.js        (in Docker: see Dockerfile / docker-compose.yml)
//
// Environment:
//   HTV_PORT         port to listen on (default 8787)
//   HTV_HOST         address to bind (default 0.0.0.0)
//   HTV_TOKEN        if set, requests need "Authorization: Bearer <token>" or ?token=<token>
//   HTV_DATA         data directory for caches (default ./htv-data)
//   HTV_CONCURRENCY  links checked at once (default 2)
//   HTV_TEAM         the one team to serve, NHL abbreviation (default EDM)
//   HTV_REFRESH_MIN  minutes between schedule scrapes near a game (default 5)
//   HTV_IDLE_REFRESH_MIN  minutes between scrapes when no game is within 3 h (default 30)
//   HTV_LEAD_MIN     minutes before a game starts that its links are warmed (default 30; old name HTV_PRIORITY_LEAD_MIN)
//   HTV_POST_GAME_MIN minutes after a game ends that it stays warm and listed (default 30)
//   HTV_GAME_MIN     assumed game length when the NHL scoreboard doesn't say it's over (default 210)
//   HTV_DEMAND_MIN   a game someone tuned stays warm and listed this long after the last poll (default 20)
//   HTV_WARM_LINKS   mirrors per channel kept checked while a game is near (default 3, 0 = all)
//   HTV_FAIL_BACKOFF_AFTER    consecutive failures before a link is backed off (default 3)
//   HTV_FAIL_BACKOFF_MAX_MIN  longest backoff in minutes; the delays grow 10, 30, 60 (default 60)
//   HTV_FAIL_DEMAND_RETRY_SEC a backed-off link someone tuned is still tried this often (default 120)
//   HTV_BROWSER_PAGES         open pages that fetch for browser-only stream hosts, most (default 3)
//   HTV_BROWSER_PAGE_IDLE_SEC close such a page after this long unused (default 60)

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { Readable } = require("stream");

const engine = require("./engine");
const scraper = require("./scraper");
const checker = require("./checker");
const proxy = require("./proxy");
const stats = require("./stats");
const livetv = require("./livetv");

const PORT = +(process.env.HTV_PORT || 8787);
const HOST = process.env.HTV_HOST || "0.0.0.0";
const TOKEN = process.env.HTV_TOKEN || "";
const REFRESH_MS = +(process.env.HTV_REFRESH_MIN || 5) * 60 * 1000;
const VERSION = require("../package.json").version;

// Check scheduling. Links are only kept warm (rechecked every few minutes) from HTV_LEAD_MIN before a game
// starts until HTV_POST_GAME_MIN after it ends, and for a game someone tuned within HTV_DEMAND_MIN. A game
// ends when the NHL scoreboard says final, else HTV_GAME_MIN after the start. Past that window the game also
// leaves the playlists and the guide (unless someone is still watching it). Outside the window nothing is checked at all (no Chromium pages): a tune extracts on demand. While warm, each
// channel keeps only its best HTV_WARM_LINKS mirrors checked (0 = all); more are tried if those fail.
const cfg = livetv.settings();
const DEMAND_MS = +(process.env.HTV_DEMAND_MIN || 20) * 60 * 1000;
const WARM_LINKS = +(process.env.HTV_WARM_LINKS ?? 3);
// Tuning a channel keeps that channel's mirrors warm (they are what failover switches between), not every
// feed of the game. HTV_DEMAND_SCOPE=game restores the old behaviour (every feed of a tuned game stays warm).
const DEMAND_BY_GAME = process.env.HTV_DEMAND_SCOPE === "game";
const demandKey = g => (DEMAND_BY_GAME ? g.gameId : g.id);
const demand = new Map(); // channel id (or game id) -> last tune time
const isDemanded = (g, now = Date.now()) => now - (demand.get(demandKey(g)) || 0) < DEMAND_MS;
const ended = new Map(); // game id -> when the NHL scoreboard was first seen saying it is over
const winOpts = () => ({ cfg, ended, demanded: g => isDemanded(g) });

const DATA = path.resolve(process.env.HTV_DATA || "htv-data");
fs.mkdirSync(DATA, { recursive: true });
// Settings that were renamed or dropped: say so instead of ignoring them.
if (process.env.HTV_PRIORITY_LEAD_MIN && !process.env.HTV_LEAD_MIN) console.log("HTV_PRIORITY_LEAD_MIN is deprecated, use HTV_LEAD_MIN");
for (const [old, use] of [["HTV_PRIORITY_TEAMS", "HTV_TEAM (an NHL abbreviation, e.g. EDM)"], ["HTV_IDLE_RECHECK_MIN", "HTV_IDLE_REFRESH_MIN (and nothing is rechecked when idle)"], ["HTV_IDLE_LINKS", "HTV_WARM_LINKS"]]) {
  if (process.env[old]) console.log(`${old} is ignored, use ${use}`);
}
// A stray rejection from a page or socket must not take the server down.
process.on("unhandledRejection", err => console.error("unhandled rejection:", err));
process.on("uncaughtException", err => console.error("uncaught exception:", err));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const state = { data: null, error: null, scrapedAt: null, startedAt: new Date().toISOString() };
const streamsFile = () => path.join(DATA, "streams.json");

// The scrape is the only periodic network work when no game is near, so it slows down then: every
// REFRESH_MS from 3 h before a game until it ends, else every HTV_IDLE_REFRESH_MIN.
const IDLE_REFRESH_MS = +(process.env.HTV_IDLE_REFRESH_MIN || 30) * 60 * 1000;
async function refresh() {
  try {
    state.data = await scraper.scrape(streamsFile());
    state.error = null;
    state.scrapedAt = new Date().toISOString();
  } catch (err) {
    state.error = err.message || String(err);
    if (!state.data && fs.existsSync(streamsFile())) {
      state.data = JSON.parse(fs.readFileSync(streamsFile(), "utf8"));
    }
    log("scrape failed:", state.error);
  }
  schedule();
  log(`schedule: ${state.data?.streams?.length ?? 0} links, ${engine.nhlLinks(state.data).length} NHL`);
  const near = livetv.hotLinks(state.data, { cfg: { ...cfg, leadMs: 3 * 60 * 60 * 1000 }, labels: await nhlLabels(), ended, demanded: g => isDemanded(g) }).size > 0;
  setTimeout(refresh, state.error || near ? REFRESH_MS : IDLE_REFRESH_MS).unref?.();
}

let lastHot = -1;
async function schedule() {
  const now = Date.now();
  const labels = await nhlLabels();
  const games = livetv.games(state.data, checker.statuses());
  for (const g of games) if (livetv.isFinal(labels[g.name]) && !ended.has(g.gameId)) ended.set(g.gameId, now);
  for (const id of [...ended.keys()]) if (!games.some(g => g.gameId === id)) ended.delete(id);
  const hot = livetv.hotLinks(state.data, { labels, cfg, ended, demanded: g => isDemanded(g, now) });
  const warm = new Set(), watched = new Set();
  for (const g of games) {
    if (isDemanded(g, now)) g.links.forEach(l => watched.add(l));
    if (!g.links.some(l => hot.has(l))) continue;
    // games() ranks working mirrors first, then unchecked ones, then failed ones.
    (WARM_LINKS > 0 ? g.links.slice(0, WARM_LINKS) : g.links).forEach(l => warm.add(l));
  }
  if (warm.size !== lastHot) log(`mode: ${warm.size ? `warm, keeping ${warm.size} links hot` : "idle"}`);
  lastHot = warm.size;
  checker.check([...warm], { hot: warm, demand: watched });
  dropFinished(games, labels, now);
}

// A game past its window is gone from the playlists: close the pages of any channel still on it.
function dropFinished(games, labels, now) {
  const over = new Set(games.filter(g => livetv.phase(g, labels[g.name], state.data, { now, cfg, ended, demanded: isDemanded(g, now) }) === "over").map(g => g.id));
  for (const id of current.keys()) if (!games.some(g => g.id === id)) over.add(id); // gone from the schedule altogether
  for (const id of over) {
    const entry = current.get(id);
    if (entry) { engine.pool.release(entry.capture.id); current.delete(id); log(`closed ${id}: game is over`); }
    liveShared.delete(id);
  }
  for (const [key] of demand) if (!games.some(g => demandKey(g) === key)) demand.delete(key);
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return bearer === TOKEN || url.searchParams.get("token") === TOKEN;
}

function sendJson(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

// Flat numbers for dashboards (e.g. a Homepage customapi widget).
async function summary() {
  const links = engine.nhlLinks(state.data);
  const st = checker.statuses();
  const count = s => links.filter(l => st[l] === s).length;
  const working = count("ok"), failed = count("fail");

  let games = null, nhlError = null;
  try {
    games = (await stats.scoreboard()).games || [];
  } catch (err) {
    nhlError = err.message || String(err);
  }
  const inState = (...states) => games ? games.filter(g => states.includes(g.gameState)).length : null;

  // Scrapes run every REFRESH_MS; missing two in a row means something is wrong.
  const stale = state.scrapedAt && Date.now() - Date.parse(state.scrapedAt) > 2 * REFRESH_MS + 60000;
  return {
    status: state.error ? "scrape failing" : !state.scrapedAt ? "starting" : stale ? "stale" : "ok",
    version: VERSION,
    uptimeSec: Math.round(process.uptime()),
    startedAt: state.startedAt,
    lastScrape: state.scrapedAt,
    scrapeError: state.error,
    links: links.length,
    workingLinks: working,
    failedLinks: failed,
    pendingLinks: links.length - working - failed,
    liveGames: inState("LIVE", "CRIT"),
    upcomingGames: inState("FUT", "PRE"),
    finishedGames: inState("OFF", "FINAL"),
    gamesToday: games ? games.length : null,
    nhlError,
  };
}

/* ---------------- Stream proxy ---------------- */

// Stream URLs carry no token: players fetch playlists and segments themselves and
// can't always send one (an Apple TV playing over AirPlay never does). Instead each
// URL is signed, so only URLs the server handed out work,
// and the proxy can't be used to fetch anything else.
const SIGNING_KEY = crypto.randomBytes(32);
const sign = (id, target) => crypto.createHmac("sha256", SIGNING_KEY).update(id + "\n" + target).digest("base64url").slice(0, 22);
// The path ends in a file name with the right extension: ffmpeg (Jellyfin) refuses HLS
// segments whose URL doesn't end in a media extension. Upstream names are kept when they
// are real media types; disguised ones (".png", none) get the usual type for their kind.
const MEDIA_EXT = {
  playlist: ["m3u8"],
  segment: ["ts", "aac", "ac3", "eac3", "mp3", "m4a"],
  fragment: ["m4s", "mp4", "m4a", "m4v"],
  init: ["mp4", "m4s"],
  key: ["key"],
};
function fileName(target, kind) {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(new URL(target).pathname)?.[1]?.toLowerCase();
  return "s." + (MEDIA_EXT[kind]?.includes(ext) ? ext : MEDIA_EXT[kind]?.[0] || "bin");
}
// Root-relative, so it works on whatever address the client reached the server on.
const streamUrl = (id, target, kind = "playlist") =>
  `/s/${id}/${sign(id, target)}/${fileName(target, kind)}?u=${encodeURIComponent(target)}`;

async function serveStream(req, res, url) {
  const [, , id, sig] = url.pathname.split("/");
  const target = url.searchParams.get("u") || "";
  const expected = sign(id || "", target);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return sendJson(res, 403, { error: "bad stream url" });
  }
  const timeout = proxy.isPlaylist(target, "") ? PLAYLIST_TIMEOUT_MS : SEGMENT_TIMEOUT_MS;
  const get = async () => proxy.respond(await engine.fetcher(), id, target, req.headers.range, (u, kind) => streamUrl(id, u, kind), timeout);
  // Upstream hiccups with a lone 5xx now and then; one retry saves the player from erroring out. A request that
  // never reached the mirror (timeout, reset) already cost its full timeout, so it is not retried: the mirror is dead.
  let r = await get();
  if (r.status >= 500 && !r.headers.get("x-htv-fetch-error")) r = await get();
  if (r.status >= 400 && r.status !== 416) { log(`stream ${r.status} ${target.slice(0, 90)}`); markDown(id); }
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body || req.method === "HEAD") return res.end();
  const body = Readable.fromWeb(r.body);
  res.on("close", () => body.destroy());
  body.on("error", () => res.destroy()).pipe(res);
}

/* ---------------- Jellyfin Live TV ---------------- */

// "http://192.168.2.152:8787": whatever address the client reached us on.
const baseUrl = req => `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;

async function nhlLabels() {
  const names = [...new Set((state.data?.streams || [])
    .filter(r => engine.NHL_LEAGUES.includes(r.league.toLowerCase())).map(r => r.game))];
  try { return await stats.labels(names); } catch { return {}; }
}

// Thumbnails: <logos>/AWAY_vs_HOME.png, one per matchup. Served without a token because
// Jellyfin fetches them itself; the strict name check keeps it to files in that folder.
const logosDir = () => process.env.HTV_LOGOS || path.join(DATA, "logos");
const logoFile = label => (label?.away && label?.home ? `${label.away}_vs_${label.home}.png` : null);
const logoUrl = (req, label) => {
  const f = logoFile(label);
  return f && fs.existsSync(path.join(logosDir(), f)) ? `${baseUrl(req)}/logo/${f}` : null;
};

function serveLogo(res, name) {
  if (!/^[A-Z]{2,4}_vs_[A-Z]{2,4}\.png$/.test(name)) return sendJson(res, 404, { error: "not found" });
  const file = path.join(logosDir(), name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": st.size, "Cache-Control": "public, max-age=86400" });
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
}

// "http://192.168.2.152:8888": MediaMTX (HLS) on the same host the client reached us on.
const EDGE_PORT = process.env.HTV_EDGE_PORT || "8888";
// HTV_EDGE_PUBLIC="htvsource.duckdns.org=https://htvhls.duckdns.org": a client that reached us on a
// public name gets that name's MediaMTX URL; LAN clients keep <same host>:8888.
const EDGE_PUBLIC = Object.fromEntries((process.env.HTV_EDGE_PUBLIC || "").split(",").filter(Boolean).map(e => e.split(/=(.*)/s).slice(0, 2)));
const edgeUrl = req => {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return EDGE_PUBLIC[host] || `${req.headers["x-forwarded-proto"] || "http"}://${host}:${EDGE_PORT}`;
};

async function liveList(req, res, format, edge = false) {
  const statuses = checker.statuses();
  let list = livetv.games(state.data, statuses);
  // The edge playlist hides channels whose mirrors all failed their check (unchecked ones stay),
  // so MediaMTX doesn't list or pull dead streams.
  if (edge) list = list.filter(g => !g.links.every(l => statuses[l] === "fail"));
  const labels = await nhlLabels();
  const now = Date.now();
  if (format === "m3u") {
    res.writeHead(200, { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(livetv.m3u(list, labels, baseUrl(req), TOKEN, l => logoUrl(req, l), state.data || {}, now, edge ? edgeUrl(req) : null, winOpts()));
  }
  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" });
  res.end(livetv.xmltv(list, labels, state.data || {}, l => logoUrl(req, l), now, winOpts()));
}

// Extract up to a few links at once and keep the first that works; the rest are
// cancelled. Dropping the request (Jellyfin giving up) cancels them all.
async function firstWorking(links, res) {
  const controllers = links.map(() => new AbortController());
  res.on("close", () => { if (!res.writableFinished) controllers.forEach(c => c.abort()); });
  try {
    return await Promise.any(links.map(async (link, i) => {
      checker.noteTry(link);
      const capture = await engine.extractVerified(link, { signal: controllers[i].signal });
      if (controllers[i].signal.aborted) throw new Error("cancelled");
      checker.record(link, capture ? "ok" : "fail", capture);
      if (!capture) throw new Error("no stream");
      return capture;
    }));
  } catch {
    return null;
  } finally {
    controllers.forEach(c => c.abort());
  }
}

// The mirror each channel is playing right now. Jellyfin's ffmpeg polls /live/<id>.m3u8
// for the whole viewing, so the server can swap a dead mirror for another one between two
// polls and the player never sees it. Playlist sequence numbers keep counting across a swap.
const current = new Map(); // channel id -> { link, capture, offset, end, sig, advancedAt }
// Failing over fast matters more than waiting out a slow mirror: a playlist that takes over 6 s, a segment
// over 12 s (3x a typical segment), or a playlist frozen for 12 s+ counts as dead and the channel moves on.
const PLAYLIST_TIMEOUT_MS = +(process.env.HTV_PLAYLIST_TIMEOUT_SEC || 6) * 1000;
const SEGMENT_TIMEOUT_MS = +(process.env.HTV_SEGMENT_TIMEOUT_SEC || 12) * 1000;
const STALL_MIN_MS = +(process.env.HTV_STALL_SEC || 12) * 1000;
// Jellyfin, MediaMTX and UHF each poll a channel every few seconds, and every poll costs an upstream playlist
// fetch through the browser. Polls close together share one result, so each client sees the same window.
const LIVE_SHARE_MS = +(process.env.HTV_LIVE_SHARE_MS || 1500);
const liveShared = new Map(); // channel id -> { at (0 while resolving), p }
const captureLink = new Map(); // capture id -> link, to blame the right one for a failed segment

// A mirror's playlist as one media playlist (the best variant of a master), or null.
async function livePlaylist(capture) {
  const wrap = (u, kind) => streamUrl(capture.id, u, kind);
  const fetchText = async target => {
    const r = await proxy.respond(await engine.fetcher(), capture.id, target, null, wrap, PLAYLIST_TIMEOUT_MS);
    const text = r.ok ? await r.text() : "";
    return text.startsWith("#EXTM3U") ? text : null;
  };
  let text = await fetchText(capture.url);
  if (text?.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split(/\r?\n/);
    let best = null, bw = -1;
    lines.forEach((l, i) => {
      const b = l.startsWith("#EXT-X-STREAM-INF") ? +/BANDWIDTH=(\d+)/.exec(l)?.[1] || 0 : -1;
      if (b > bw && lines[i + 1]) { bw = b; best = lines[i + 1]; }
    });
    const target = best && new URL(best, "http://x").searchParams.get("u");
    text = target ? await fetchText(target) : null;
  }
  return text;
}

// Renumber a mirror's playlist so sequence numbers never go backwards for the channel. A swap also resets
// the timestamps, so the new mirror's first segment gets #EXT-X-DISCONTINUITY, and keeps it (entry.disc is
// its renumbered sequence) on every later poll until it leaves the window: a player that polls again or
// joins late must still see the break, or it reads the jump as continuous and freezes or repeats.
function renumber(entry, text, switched) {
  const seq = +/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] || 0;
  if (switched) {
    entry.offset = Math.max(0, entry.end - seq);
    entry.disc = seq + entry.offset;
  }
  const first = seq + entry.offset;
  const count = (text.match(/^#EXTINF/gm) || []).length;
  entry.end = Math.max(entry.end, first + count);
  let out = text.replace(/#EXT-X-MEDIA-SEQUENCE:\d+\s*/, "");
  out = out.replace(/(#EXT-X-TARGETDURATION:\d+)/, `$1\n#EXT-X-MEDIA-SEQUENCE:${first}`);
  if (entry.disc == null) return out;
  const at = entry.disc - first;
  if (at < 0) { entry.disc = null; return out; }
  let n = -1;
  return out.replace(/^#EXTINF/gm, m => (++n === at ? "#EXT-X-DISCONTINUITY\n" + m : m));
}

// The playlist URL of a browser-only host carries a token that can expire. A mirror that was working and
// now fails is first re-extracted from fresh pages (at most once per REFRESH_GAP_MS, so a link that is really
// dead can't loop) and only marked down if that fails too.
const REFRESH_GAP_MS = 30 * 1000;
const canRefresh = e => engine.isBrowserOnly(e.capture.url) && Date.now() - e.refreshedAt > REFRESH_GAP_MS;

// A stream that fails (playlist or segment) is dropped from its channel; the next poll picks another mirror.
// `force` skips the refresh: the capture is already a refreshed one, or the refresh failed.
function markDown(id, force = false) {
  const link = captureLink.get(id);
  if (!link) return;
  const playing = [...current].filter(([, e]) => e.capture.id === id);
  if (!force && playing.length && playing.every(([, e]) => canRefresh(e))) {
    playing.forEach(([, e]) => (e.stale = true)); // the next poll re-extracts it
    return;
  }
  checker.record(link, "fail");
  engine.pool.release(id);
  for (const [ch, e] of playing) { current.delete(ch); log(`down ${link}`); }
}

// A fresh capture of the playing link, swapped into the channel; returns its playlist, or null.
async function refreshCapture(entry, res) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableFinished) ac.abort(); };
  res.on("close", onClose);
  entry.refreshedAt = Date.now();
  try {
    const capture = await engine.extractVerified(entry.link, { signal: ac.signal });
    if (!capture || ac.signal.aborted) return null;
    captureLink.set(capture.id, entry.link);
    const text = await livePlaylist(capture).catch(() => null);
    if (!text) return null;
    engine.pool.release(entry.capture.id);
    entry.capture = capture;
    entry.stale = false;
    checker.record(entry.link, "ok", capture);
    log(`refresh ${entry.link} (playlist stopped loading, took a fresh capture)`);
    return text;
  } finally {
    res.off("close", onClose);
  }
}

// Jellyfin tuning in to a channel (a feed of a game) or polling it: serve the playlist of a
// working mirror, preferring the one already playing, then captures the background checks
// took, then a fresh extraction.
async function live(req, res, url) {
  const id = /^\/live\/([0-9a-f]+)\.m3u8$/.exec(url.pathname)?.[1];
  const statuses = checker.statuses();
  const game = livetv.games(state.data, statuses).find(g => g.id === id);
  if (!game) return sendJson(res, 404, { error: "unknown channel" });
  // A finished game has left the playlists; a viewer who is still polling it keeps it alive through `demand`.
  const labels = await nhlLabels();
  if (livetv.phase(game, labels[game.name], state.data, { cfg, ended, demanded: isDemanded(game) }) === "over") return sendJson(res, 404, { error: "unknown channel" });
  // Someone is watching (ffmpeg polls this for the whole viewing): keep this game's mirrors warm.
  const fresh = !isDemanded(game);
  demand.set(demandKey(game), Date.now());
  if (fresh) schedule();

  // Poll within LIVE_SHARE_MS of a finished resolve, or during one, and share its result.
  let shared = liveShared.get(id);
  if (!shared || (shared.at && Date.now() - shared.at >= LIVE_SHARE_MS)) {
    const mine = shared = { at: 0, p: null };
    mine.p = resolveLive(id, game, res).then(r => {
      mine.at = Date.now();
      if (!r && liveShared.get(id) === mine) liveShared.delete(id); // never share a failure
      return r;
    }, err => {
      if (liveShared.get(id) === mine) liveShared.delete(id);
      throw err;
    });
    liveShared.set(id, mine);
  }
  const r = await shared.p;
  if (res.destroyed) return;
  if (!r) return sendJson(res, 503, { error: "no working stream for this channel right now" });
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" });
  res.end(r);
}

// The playlist for channel `id` right now (renumbered), or null: the mirror already playing, else a
// failover. `res` is the poll that triggered it; if that client hangs up, pending extractions are dropped.
async function resolveLive(id, game, res) {
  let text = null, entry = current.get(id), switched = false, refreshed = false;
  if (entry) {
    let stalled = false;
    text = entry.stale ? null : await livePlaylist(entry.capture).catch(() => null);
    if (text && livetv.stalled(entry, text, Date.now(), STALL_MIN_MS)) { log(`stall ${entry.link}`); text = null; stalled = true; }
    // A frozen playlist is not an expired token; only a playlist that stopped loading is worth a refresh.
    if (!text && !stalled && canRefresh(entry)) {
      text = await refreshCapture(entry, res).catch(() => null);
      if (text) switched = refreshed = true;
    }
    if (!text) markDown(entry.capture.id, true);
  }
  if (!text) {
    switched = !!entry;
    const prev = entry?.end ?? 0;
    const tried = new Set(entry ? [entry.link] : []);
    const adopt = async (link, capture) => {
      tried.add(link);
      captureLink.set(capture.id, link);
      if (captureLink.size > 500) captureLink.delete(captureLink.keys().next().value);
      const t = await livePlaylist(capture).catch(() => null);
      if (!t) { checker.record(link, "fail"); return false; }
      entry = { link, capture, offset: 0, end: prev, sig: null, advancedAt: Date.now(), refreshedAt: Date.now() };
      livetv.stalled(entry, t);
      current.set(id, entry);
      text = t;
      return true;
    };
    for (const link of game.links) {
      const capture = tried.has(link) ? null : checker.recentCapture(link);
      if (capture && proxy.hasContext(capture.id) && await adopt(link, capture)) break;
    }
    if (!text) {
      const statuses = checker.statuses();
      const rest = game.links.filter(l => !tried.has(l) && statuses[l] !== "fail");
      // Links backed off after repeated failures are skipped unless their short retry interval has passed.
      const links = (rest.length ? rest : game.links.filter(l => !tried.has(l))).filter(l => checker.mayTry(l, true)).slice(0, 3);
      const capture = await firstWorking(links, res);
      if (!res.destroyed && capture) await adopt(links.find(l => checker.recentCapture(l)?.id === capture.id) || links[0], capture);
    }
  }
  if (res.destroyed) return null;
  log(`live ${text ? "ok  " : "fail"} ${game.name} · ${game.channel}${refreshed && text ? " (refreshed)" : switched && text ? " (switched mirror)" : ""}`);
  return text ? renumber(entry, text, switched) : null;
}

/* ---------------- HTTP ---------------- */

function startHttp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
    if (url.pathname.startsWith("/logo/")) return serveLogo(res, url.pathname.slice(6));
    if (url.pathname.startsWith("/s/")) {
      return serveStream(req, res, url).catch(err => { log("stream error:", err.message); res.destroy(); });
    }
    if (!authorized(req, url)) return sendJson(res, 401, { error: "unauthorized" });
    if (url.pathname === "/api/streams") {
      return sendJson(res, 200, {
        ...(state.data || { updated: null, streams: [] }),
        error: state.error,
        checks: checker.snapshot(),
        server: { version: VERSION, startedAt: state.startedAt },
      });
    }
    if (url.pathname === "/api/summary") {
      return summary().then(body => sendJson(res, 200, body), err => sendJson(res, 500, { error: err.message }));
    }
    if (url.pathname === "/api/m3u") return liveList(req, res, "m3u");
    if (url.pathname === "/api/m3u-edge") return liveList(req, res, "m3u", true);
    if (url.pathname === "/api/xmltv") return liveList(req, res, "xmltv");
    if (url.pathname.startsWith("/live/")) {
      return live(req, res, url).catch(err => { if (!res.headersSent) sendJson(res, 500, { error: err.message }); });
    }
    sendJson(res, 404, { error: "not found" });
  });
  server.listen(PORT, HOST, () => log(`htv server ${VERSION} listening on ${HOST}:${PORT}${TOKEN ? " (token required)" : ""}`));
}

(async () => {
  checker.setConcurrency(+(process.env.HTV_CONCURRENCY || 2));
  checker.onStatusChange((link, status) => { if (status !== "checking") log(`${status.padEnd(4)} ${link}`); });
  checker.onBackoff((link, fails, min) => log(fails
    ? `backoff ${link}: failed ${fails} times in a row, next check in ${min} min`
    : `backoff over ${link}`));
  await engine.start(DATA);
  startHttp();
  await refresh();
  setInterval(schedule, 60 * 1000); // hot links are due every 5 min; the scrape runs on its own timer
})();
