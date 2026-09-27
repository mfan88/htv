// htv server mode: runs the scraper and link checker with no window and serves the
// results as JSON, so the desktop app can start from an up-to-date list.
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
const { app } = require("electron");

const engine = require("./engine");
const scraper = require("./scraper");
const checker = require("./checker");

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
const state = { data: null, error: null, startedAt: new Date().toISOString() };
const streamsFile = () => path.join(app.getPath("userData"), "streams.json");

async function refresh() {
  try {
    state.data = await scraper.scrape(streamsFile());
    state.error = null;
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

function startHttp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
    if (!authorized(req, url)) return sendJson(res, 401, { error: "unauthorized" });
    if (url.pathname === "/api/streams") {
      return sendJson(res, 200, {
        ...(state.data || { updated: null, streams: [] }),
        error: state.error,
        checks: checker.snapshot(),
        server: { version: VERSION, startedAt: state.startedAt },
      });
    }
    sendJson(res, 404, { error: "not found" });
  });
  server.listen(PORT, HOST, () => log(`htv server ${VERSION} listening on ${HOST}:${PORT}${TOKEN ? " (token required)" : ""}`));
}

app.whenReady().then(async () => {
  checker.setConcurrency(+(process.env.HTV_CONCURRENCY || 3));
  checker.onStatusChange((link, status) => { if (status !== "checking") log(`${status.padEnd(4)} ${link}`); });
  const extractSes = engine.setupExtractSession();
  await engine.setupAdblock([extractSes]);
  startHttp();
  await refresh();
  setInterval(refresh, REFRESH_MS);
});
