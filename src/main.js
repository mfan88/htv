const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require("electron");

const engine = require("./engine");
const scraper = require("./scraper");
const checker = require("./checker");
const proxy = require("./proxy");
const stats = require("./stats");

const MAIN_PARTITION = "persist:main";
const BLOCKED_KEYS = ["t", "n", "w"]; // Ctrl(+Shift)+T/N/W
const ONHOCKEY_REFERER = "https://onhockey.tv/";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const SERVER_TIMEOUT_MS = 5000;

engine.configure();

let mainWindow = null;
let extractSes = null;
// mode "server" uses the saved server, else the built-in one; "local" scrapes and checks here.
let settings = { mode: "server", serverUrl: "", token: "" };
// The built-in server, written into src/defaults.json by the release workflow (git-ignored).
const defaults = (() => { try { return require("./defaults.json"); } catch { return {}; } })();
// source: where the list came from ("server" | "local"); refreshing: a refresh is in flight.
const state = { data: null, error: null, serverError: null, source: "local", refreshing: false };

const dataFile = name => path.join(app.getPath("userData"), name);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const writeJson = (file, obj) => { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); } catch {} };

// Link statuses are cached on disk so the next launch starts with them.
let saveChecksTimer = null;
function saveChecksSoon() {
  clearTimeout(saveChecksTimer);
  saveChecksTimer = setTimeout(() => writeJson(dataFile("checks.json"), checker.snapshot()), 2000);
}

/* ---------------- Refreshing the list ---------------- */

function normalizeServerUrl(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "http://" + s;
}

// The server to use, or null to work locally. A saved server replaces the built-in one.
function activeServer() {
  if (settings.mode === "local") return null;
  if (settings.serverUrl) return { url: settings.serverUrl, token: settings.token };
  const url = normalizeServerUrl(defaults.serverUrl);
  return url ? { url, token: defaults.token || "" } : null;
}

async function fetchFromServer(server) {
  const res = await fetch(server.url + "/api/streams", {
    headers: server.token ? { Authorization: "Bearer " + server.token } : {},
    signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error("the server rejected the token");
  if (!res.ok) throw new Error(`the server returned HTTP ${res.status}`);
  const d = await res.json();
  if (!Array.isArray(d.streams)) throw new Error("unexpected response from the server");
  return d;
}

async function refresh() {
  state.refreshing = true;
  let fromServer = false;
  const server = activeServer();
  state.serverError = null;
  if (server) {
    try {
      const d = await fetchFromServer(server);
      state.data = { updated: d.updated, source_utc_offset: d.source_utc_offset, streams: d.streams };
      state.error = d.error || null;
      writeJson(dataFile("streams.json"), state.data);
      checker.seed(d.checks);
      fromServer = true;
    } catch (err) {
      // Network errors: Node's fetch sets cause.code; Electron's only says "fetch failed".
      const unreachable = err.cause?.code || err.name === "TimeoutError" || err.message === "fetch failed";
      state.serverError = unreachable ? "can't reach the server" : err.message;
    }
  }
  if (!fromServer) {
    try {
      state.data = await scraper.scrape(dataFile("streams.json"));
      state.error = null;
    } catch (err) {
      state.error = err.message || String(err);
      state.data ??= readJson(dataFile("streams.json"));
    }
  }
  state.source = fromServer ? "server" : "local";
  // With a server, only check links it hasn't checked yet; it keeps the rest current.
  checker.check(engine.nhlLinks(state.data), { recheck: !fromServer });
  saveChecksSoon();
  state.refreshing = false;
  return payload();
}

function payload() {
  return {
    ...(state.data || { updated: null, streams: [] }),
    error: state.error,
    statuses: checker.statuses(),
    source: state.source,
    serverError: state.serverError,
    serverConfigured: !!activeServer(),
    refreshing: state.refreshing,
  };
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

/* ---------------- Window ---------------- */

function hardenSessions(mainSes) {
  // Embeds in the fallback player expect to be framed by onhockey.tv.
  mainSes.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (details.resourceType === "subFrame" && !headers.Referer) headers.Referer = ONHOCKEY_REFERER;
    callback({ requestHeaders: headers });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0b0d12",
    title: "htv",
    icon: path.join(__dirname, "assets", "icon.png"),
    // No title bar: the app's background runs to the top edge. macOS keeps its
    // traffic lights inset; Windows/Linux draw min/max/close over the app's colours.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 18, y: 20 } }
      : { titleBarOverlay: { color: "#0b0d12", symbolColor: "#8a93a6", height: 40 } }),
    webPreferences: {
      partition: MAIN_PARTITION,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  const wc = mainWindow.webContents;
  // Stop embeds from navigating the whole app away (redirect ads).
  wc.on("will-navigate", e => e.preventDefault());
  // Fires for keys typed anywhere in the window, including inside embed frames.
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if ((input.control || input.meta) && !input.alt && BLOCKED_KEYS.includes(key)) {
      e.preventDefault();
    } else if (input.key === "F12") {
      wc.toggleDevTools();
      e.preventDefault();
    } else if (input.key === "F5" || ((input.control || input.meta) && key === "r")) {
      wc.send("htv:refresh-shortcut");
      e.preventDefault();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ---------------- IPC ---------------- */

ipcMain.handle("htv:get-streams", () => payload());
ipcMain.handle("htv:refresh", () => refresh());

let userExtraction = null; // AbortController for the link the user clicked last
ipcMain.handle("htv:extract", async (_e, link, { fresh = false } = {}) => {
  if (typeof link !== "string" || !link) return { ok: false, error: "bad link" };
  userExtraction?.abort();
  const controller = userExtraction = new AbortController();
  let capture = fresh ? null : checker.freshCapture(link);
  if (!capture) {
    capture = await engine.extractVerified(link, { signal: controller.signal });
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    checker.record(link, capture ? "ok" : "fail", capture);
  }
  if (!capture) return { ok: false, error: "No playable stream found in this link." };
  return { ok: true, src: proxy.proxify(capture.id, capture.url), upstream: capture.url };
});
ipcMain.handle("htv:game-stats", async (_e, gameName) => {
  if (typeof gameName !== "string") return null;
  try { return await stats.forGame(gameName); } catch { return null; }
});
ipcMain.handle("htv:game-labels", async (_e, names) => {
  if (!Array.isArray(names)) return {};
  try { return await stats.labels(names.filter(n => typeof n === "string")); } catch { return {}; }
});
ipcMain.handle("htv:mark-failed", (_e, link) => { if (typeof link === "string") checker.record(link, "fail"); });
ipcMain.handle("htv:open-external", (_e, link) => {
  if (typeof link === "string" && link) shell.openExternal("https://" + link.replace(/^https?:\/\//, ""));
});
ipcMain.handle("htv:get-settings", () => ({
  mode: settings.mode,
  serverUrl: settings.serverUrl,
  hasToken: !!settings.token,
  hasBuiltIn: !!defaults.serverUrl,
}));
// `token` undefined keeps the saved token; an empty string clears it.
ipcMain.handle("htv:set-settings", async (_e, next = {}) => {
  settings = {
    mode: next.mode === "local" ? "local" : "server",
    serverUrl: normalizeServerUrl(next.serverUrl),
    token: typeof next.token === "string" ? next.token.trim() : settings.token,
  };
  writeJson(dataFile("settings.json"), settings);
  return refresh();
});

/* ---------------- Startup ---------------- */

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  settings = { ...settings, ...readJson(dataFile("settings.json")) };
  const mainSes = session.fromPartition(MAIN_PARTITION);
  extractSes = engine.setupExtractSession();
  proxy.install(mainSes, extractSes);
  hardenSessions(mainSes);
  checker.onStatusChange((link, status) => {
    send("htv:link-status", { link, status });
    if (status !== "checking") saveChecksSoon();
  });

  // Open straight away with the last session's list and statuses; refresh behind it.
  state.data = readJson(dataFile("streams.json"));
  checker.seed(readJson(dataFile("checks.json")));
  state.refreshing = true;
  createWindow();

  await engine.setupAdblock([mainSes, extractSes]); // before any checks, so hidden loads are ad-free too
  send("htv:streams", await refresh());
  setInterval(async () => send("htv:streams", await refresh()), AUTO_REFRESH_MS);
});

app.on("window-all-closed", () => app.quit());
