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
//   HTV_CONCURRENCY  links checked at once (default 3)
//   HTV_REFRESH_MIN  minutes between schedule scrapes (default 5)

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

const DATA = path.resolve(process.env.HTV_DATA || "htv-data");
fs.mkdirSync(DATA, { recursive: true });
// A stray rejection from a page or socket must not take the server down.
process.on("unhandledRejection", err => console.error("unhandled rejection:", err));
process.on("uncaughtException", err => console.error("uncaught exception:", err));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const state = { data: null, error: null, scrapedAt: null, startedAt: new Date().toISOString() };
const streamsFile = () => path.join(DATA, "streams.json");

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
  const links = engine.nhlLinks(state.data);
  checker.check(links, { hot: livetv.hotLinks(state.data) });
  log(`schedule: ${state.data?.streams?.length ?? 0} links, ${links.length} NHL`);
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
  const get = async () => proxy.respond(await engine.fetcher(), id, target, req.headers.range, (u, kind) => streamUrl(id, u, kind));
  // Upstream hiccups with a lone 5xx now and then; one retry saves the player from erroring out.
  let r = await get();
  if (r.status >= 500) r = await get();
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

async function liveList(req, res, format) {
  const list = livetv.games(state.data, checker.statuses());
  const labels = await nhlLabels();
  if (format === "m3u") {
    res.writeHead(200, { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(livetv.m3u(list, labels, baseUrl(req), TOKEN, l => logoUrl(req, l)));
  }
  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" });
  res.end(livetv.xmltv(list, labels, state.data || {}, l => logoUrl(req, l)));
}

// Extract up to a few links at once and keep the first that works; the rest are
// cancelled. Dropping the request (Jellyfin giving up) cancels them all.
async function firstWorking(links, res) {
  const controllers = links.map(() => new AbortController());
  res.on("close", () => { if (!res.writableFinished) controllers.forEach(c => c.abort()); });
  try {
    return await Promise.any(links.map(async (link, i) => {
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
const current = new Map(); // channel id -> { link, capture, offset, end }
const captureLink = new Map(); // capture id -> link, to blame the right one for a failed segment

// A mirror's playlist as one media playlist (the best variant of a master), or null.
async function livePlaylist(capture) {
  const wrap = (u, kind) => streamUrl(capture.id, u, kind);
  const fetchText = async target => {
    const r = await proxy.respond(await engine.fetcher(), capture.id, target, null, wrap);
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

// Renumber a mirror's playlist so sequence numbers never go backwards for the channel.
function renumber(entry, text, switched) {
  const seq = +/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] || 0;
  if (switched) entry.offset = Math.max(0, entry.end - seq);
  const count = (text.match(/^#EXTINF/gm) || []).length;
  entry.end = Math.max(entry.end, seq + entry.offset + count);
  let out = text.replace(/#EXT-X-MEDIA-SEQUENCE:\d+\s*/, "");
  out = out.replace(/(#EXT-X-TARGETDURATION:\d+)/, `$1\n#EXT-X-MEDIA-SEQUENCE:${seq + entry.offset}`);
  return switched ? out.replace(/^#EXTINF/m, "#EXT-X-DISCONTINUITY\n#EXTINF") : out;
}

// A stream that fails (playlist or segment) is dropped from its channel; the next poll picks another mirror.
function markDown(id) {
  const link = captureLink.get(id);
  if (!link) return;
  checker.record(link, "fail");
  for (const [ch, e] of current) if (e.capture.id === id) { current.delete(ch); log(`down ${link}`); }
}

// Jellyfin tuning in to a channel (a feed of a game) or polling it: serve the playlist of a
// working mirror, preferring the one already playing, then captures the background checks
// took, then a fresh extraction.
async function live(req, res, url) {
  const id = /^\/live\/([0-9a-f]+)\.m3u8$/.exec(url.pathname)?.[1];
  const statuses = checker.statuses();
  const game = livetv.games(state.data, statuses).find(g => g.id === id);
  if (!game) return sendJson(res, 404, { error: "unknown channel" });

  let text = null, entry = current.get(id), switched = false;
  if (entry) {
    text = await livePlaylist(entry.capture).catch(() => null);
    if (!text) markDown(entry.capture.id);
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
      entry = { link, capture, offset: 0, end: prev };
      current.set(id, entry);
      text = t;
      return true;
    };
    for (const link of game.links) {
      const capture = tried.has(link) ? null : checker.recentCapture(link);
      if (capture && proxy.hasContext(capture.id) && await adopt(link, capture)) break;
    }
    if (!text) {
      const rest = game.links.filter(l => !tried.has(l) && statuses[l] !== "fail");
      const links = (rest.length ? rest : game.links.filter(l => !tried.has(l))).slice(0, 3);
      const capture = await firstWorking(links, res);
      if (!res.destroyed && capture) await adopt(links.find(l => checker.recentCapture(l)?.id === capture.id) || links[0], capture);
    }
  }
  if (res.destroyed) return;
  log(`live ${text ? "ok  " : "fail"} ${game.name} · ${game.channel}${switched && text ? " (switched mirror)" : ""}`);
  if (!text) return sendJson(res, 503, { error: "no working stream for this channel right now" });
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" });
  res.end(renumber(entry, text, switched));
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
    if (url.pathname === "/api/xmltv") return liveList(req, res, "xmltv");
    if (url.pathname.startsWith("/live/")) {
      return live(req, res, url).catch(err => { if (!res.headersSent) sendJson(res, 500, { error: err.message }); });
    }
    sendJson(res, 404, { error: "not found" });
  });
  server.listen(PORT, HOST, () => log(`htv server ${VERSION} listening on ${HOST}:${PORT}${TOKEN ? " (token required)" : ""}`));
}

(async () => {
  checker.setConcurrency(+(process.env.HTV_CONCURRENCY || 3));
  checker.onStatusChange((link, status) => { if (status !== "checking") log(`${status.padEnd(4)} ${link}`); });
  await engine.start(DATA);
  startHttp();
  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
