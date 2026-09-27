const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require("electron");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");

const scraper = require("./scraper");
const extractor = require("./extractor");
const checker = require("./checker");
const proxy = require("./proxy");
const stats = require("./stats");

const MAIN_PARTITION = "persist:main";
const BLOCKED_KEYS = ["t", "n", "w"]; // Ctrl(+Shift)+T/N/W
const ONHOCKEY_REFERER = "https://onhockey.tv/";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const NHL_LEAGUES = ["nhl", "nhl preseason"];

// A closed stdout/stderr (e.g. piped into a pager) must not crash the app.
for (const s of [process.stdout, process.stderr]) s?.on?.("error", () => {});

proxy.registerScheme();
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Some stream hosts refuse browsers that advertise Electron.
app.userAgentFallback = app.userAgentFallback.replace(/\s(htv|Electron)\/\S+/g, "");

let mainWindow = null;
let extractSes = null;
const state = { data: null, error: null };
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
  }
  const nhl = (state.data?.streams || []).filter(r => NHL_LEAGUES.includes(r.league.toLowerCase()));
  checker.check([...new Set(nhl.map(r => r.link))]);
  return payload();
}

function payload() {
  return { ...(state.data || { updated: null, streams: [] }), error: state.error, statuses: checker.statuses() };
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

async function setupAdblock(sessions) {
  const cache = path.join(app.getPath("userData"), "adblock-engine.bin");
  try {
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    // Each enableBlockingInSession() registers the same global ipcMain handlers, which
    // throws from the second session on. One blocker serves every session through those
    // handlers, so skip the duplicate registrations.
    const handle = ipcMain.handle;
    const registered = new Set();
    ipcMain.handle = (channel, fn) => {
      if (registered.has(channel)) return;
      registered.add(channel);
      handle.call(ipcMain, channel, fn);
    };
    try {
      for (const ses of sessions) blocker.enableBlockingInSession(ses);
    } finally {
      ipcMain.handle = handle;
    }
  } catch (err) {
    console.error("adblock unavailable:", err);
  }
}

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

// No popups from anything, anywhere (ads, pop-unders, "click to play" traps).
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

ipcMain.handle("htv:get-streams", () => payload());
ipcMain.handle("htv:refresh", () => refresh());
// Extract a link's stream and confirm its playlist really loads through the proxy.
async function extractVerified(link, opts) {
  const capture = await extractor.extract(link, opts);
  if (!capture) return null;
  const id = proxy.addContext(capture.headers);
  return (await proxy.probe(extractSes, id, capture.url)) ? { ...capture, id } : null;
}

let userExtraction = null; // AbortController for the link the user clicked last
ipcMain.handle("htv:extract", async (_e, link, { fresh = false } = {}) => {
  if (typeof link !== "string" || !link) return { ok: false, error: "bad link" };
  userExtraction?.abort();
  const controller = userExtraction = new AbortController();
  let capture = fresh ? null : checker.freshCapture(link);
  if (!capture) {
    capture = await extractVerified(link, { signal: controller.signal });
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const mainSes = session.fromPartition(MAIN_PARTITION);
  extractSes = session.fromPartition(extractor.PARTITION);
  extractSes.webRequest.onBeforeSendHeaders((details, callback) => {
    extractor.observe(details);
    proxy.decorate(details.requestHeaders);
    callback({ requestHeaders: details.requestHeaders });
  });
  proxy.install(mainSes, extractSes);
  hardenSessions(mainSes);
  checker.init(extractVerified);
  checker.onStatusChange((link, status) => send("htv:link-status", { link, status }));
  await setupAdblock([mainSes, extractSes]); // before any checks, so hidden loads are ad-free too
  await refresh();
  createWindow();
  setInterval(async () => send("htv:streams", await refresh()), AUTO_REFRESH_MS);
});

app.on("window-all-closed", () => app.quit());
