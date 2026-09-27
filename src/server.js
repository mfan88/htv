// htv server mode: runs the scraper and link checker with no window and serves the
// results as JSON, so the desktop app can start from an up-to-date list. It also serves
// a web player for phones (src/web/): the server extracts the stream and proxies it,
// so the phone, or an Apple TV it AirPlays to, only ever loads a plain HLS stream.
//
//   electron src/server.js        (in Docker: see Dockerfile / docker-compose.yml)
//
// Environment:
//   HTV_PORT         port to listen on (default 8787)
//   HTV_HOST         address to bind (default 0.0.0.0)
//   HTV_TOKEN        if set, requests need "Authorization: Bearer <token>" or ?token=<token>
//   HTV_DATA         data directory for caches (default: Electron's userData)
//   HTV_CONCURRENCY  links checked at once (default 3)
//   HTV_REFRESH_MIN  minutes between schedule scrapes (default 5)

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { Readable } = require("stream");
const { app } = require("electron");

const engine = require("./engine");
const scraper = require("./scraper");
const checker = require("./checker");
const proxy = require("./proxy");
const stats = require("./stats");

const PORT = +(process.env.HTV_PORT || 8787);
const HOST = process.env.HTV_HOST || "0.0.0.0";
const TOKEN = process.env.HTV_TOKEN || "";
const REFRESH_MS = +(process.env.HTV_REFRESH_MIN || 5) * 60 * 1000;
const VERSION = require("../package.json").version;

if (process.env.HTV_DATA) app.setPath("userData", path.resolve(process.env.HTV_DATA));
engine.configure();
app.disableHardwareAcceleration();
// Hidden windows open and close constantly; never quit because none are left.
app.on("window-all-closed", () => {});

const log = (...a) => console.log(new Date().toISOString(), ...a);
const state = { data: null, error: null, scrapedAt: null, startedAt: new Date().toISOString() };
let extractSes = null;
const streamsFile = () => path.join(app.getPath("userData"), "streams.json");

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
  checker.check(links);
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

/* ---------------- Web player ---------------- */

const WEB_DIR = path.join(__dirname, "web");
const STATIC = {
  "/": [path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(WEB_DIR, "app.js"), "text/javascript; charset=utf-8"],
  "/style.css": [path.join(WEB_DIR, "style.css"), "text/css; charset=utf-8"],
  "/icon.png": [path.join(__dirname, "assets", "icon.png"), "image/png"],
  // For browsers without native HLS; Safari (and AirPlay) plays the playlist directly.
  "/hls.min.js": [require.resolve("hls.js/dist/hls.min.js"), "text/javascript; charset=utf-8"],
};

function sendStatic(res, [file, type]) {
  fs.readFile(file, (err, body) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(body);
  });
}

// Stream URLs carry no token: an Apple TV playing over AirPlay fetches them itself and
// can't send one. Instead each URL is signed, so only URLs the server handed out work,
// and the proxy can't be used to fetch anything else.
const SIGNING_KEY = crypto.randomBytes(32);
const sign = (id, target) => crypto.createHmac("sha256", SIGNING_KEY).update(id + "\n" + target).digest("base64url").slice(0, 22);
// Root-relative, so it works on whatever address the phone reached the server on.
const streamUrl = (id, target) => `/s/${id}/${sign(id, target)}?u=${encodeURIComponent(target)}`;

async function serveStream(req, res, url) {
  const [, , id, sig] = url.pathname.split("/");
  const target = url.searchParams.get("u") || "";
  const expected = sign(id || "", target);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return sendJson(res, 403, { error: "bad stream url" });
  }
  const r = await proxy.respond(extractSes, id, target, req.headers.range, u => streamUrl(id, u));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body || req.method === "HEAD") return res.end();
  const body = Readable.fromWeb(r.body);
  res.on("close", () => body.destroy());
  body.on("error", () => res.destroy()).pipe(res);
}

// Extract a link on demand (or reuse a capture checked moments ago) for the web player.
async function play(req, res, url) {
  const link = url.searchParams.get("link") || "";
  if (!engine.nhlLinks(state.data).includes(link)) return sendJson(res, 404, { error: "unknown link" });
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  let capture = checker.freshCapture(link);
  if (!capture || !proxy.hasContext(capture.id)) {
    capture = await engine.extractVerified(link, { signal: controller.signal });
    if (controller.signal.aborted) return;
    checker.record(link, capture ? "ok" : "fail", capture);
    log(`play ${capture ? "ok  " : "fail"} ${link}`);
  }
  if (!capture) return sendJson(res, 200, { ok: false, error: "No playable stream found in this link." });
  sendJson(res, 200, { ok: true, src: streamUrl(capture.id, capture.url) });
}

async function labels(res) {
  const names = [...new Set((state.data?.streams || [])
    .filter(r => engine.NHL_LEAGUES.includes(r.league.toLowerCase())).map(r => r.game))];
  try { sendJson(res, 200, await stats.labels(names)); } catch { sendJson(res, 200, {}); }
}

// Android TV app updates. Copy app-release.apk and output-metadata.json from
// androidtv/app/build/outputs/apk/release/ into <data>/androidtv/; the app offers the
// update when its versionCode is higher than the installed one.
const tvDir = () => path.join(app.getPath("userData"), "androidtv");

// The published build: { versionCode, versionName, file }, or null.
function tvBuild() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(tvDir(), "output-metadata.json"), "utf8"));
    const el = meta.elements[0];
    const file = path.join(tvDir(), path.basename(el.outputFile));
    return fs.existsSync(file) ? { versionCode: el.versionCode, versionName: el.versionName, file } : null;
  } catch {
    return null;
  }
}

function tvUpdate(res) {
  const build = tvBuild();
  if (!build) return sendJson(res, 200, { available: false });
  sendJson(res, 200, { available: true, versionCode: build.versionCode, versionName: build.versionName, url: "/api/tv-update/apk" });
}

function tvApk(res) {
  const build = tvBuild();
  if (!build) return sendJson(res, 404, { error: "no build" });
  const size = fs.statSync(build.file).size;
  res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": size, "Cache-Control": "no-store" });
  fs.createReadStream(build.file).on("error", () => res.destroy()).pipe(res);
}

/* ---------------- HTTP ---------------- */

function startHttp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
    if (STATIC[url.pathname]) return sendStatic(res, STATIC[url.pathname]);
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
    if (url.pathname === "/api/play") {
      return play(req, res, url).catch(err => sendJson(res, 500, { ok: false, error: err.message }));
    }
    if (url.pathname === "/api/labels") return labels(res);
    if (url.pathname === "/api/tv-update") return tvUpdate(res);
    if (url.pathname === "/api/tv-update/apk") return tvApk(res);
    sendJson(res, 404, { error: "not found" });
  });
  server.listen(PORT, HOST, () => log(`htv server ${VERSION} listening on ${HOST}:${PORT}${TOKEN ? " (token required)" : ""}`));
}

app.whenReady().then(async () => {
  checker.setConcurrency(+(process.env.HTV_CONCURRENCY || 3));
  checker.onStatusChange((link, status) => { if (status !== "checking") log(`${status.padEnd(4)} ${link}`); });
  extractSes = engine.setupExtractSession();
  await engine.setupAdblock([extractSes]);
  startHttp();
  await refresh();
  setInterval(refresh, REFRESH_MS);
});
