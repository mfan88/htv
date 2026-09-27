// Shared by the desktop app (main.js) and headless server mode (server.js): Electron
// setup, the hidden-window link checker, ad blocking and the proxy's fetch session.

const path = require("path");
const fs = require("fs");
const { app, ipcMain, session } = require("electron");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");

const extractor = require("./extractor");
const checker = require("./checker");
const proxy = require("./proxy");

const NHL_LEAGUES = ["nhl", "nhl preseason"];

let extractSes = null;

// Must run before the app is ready.
function configure() {
  // A closed stdout/stderr (e.g. piped into a pager) must not crash the app.
  for (const s of [process.stdout, process.stderr]) s?.on?.("error", () => {});
  proxy.registerScheme();
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  // Some stream hosts refuse browsers that advertise Electron.
  app.userAgentFallback = app.userAgentFallback.replace(/\s(htv|Electron)\/\S+/g, "");
  // No popups from anything, anywhere (ads, pop-unders, "click to play" traps).
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

// The session hidden extraction windows run in; the proxy also fetches through it.
function setupExtractSession() {
  extractSes = session.fromPartition(extractor.PARTITION);
  extractSes.webRequest.onBeforeSendHeaders((details, callback) => {
    extractor.observe(details);
    proxy.decorate(details.requestHeaders);
    callback({ requestHeaders: details.requestHeaders });
  });
  checker.init(extractVerified);
  return extractSes;
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

// Extract a link's stream and confirm its playlist really loads through the proxy.
async function extractVerified(link, opts) {
  const capture = await extractor.extract(link, opts);
  if (!capture) return null;
  const id = proxy.addContext(capture.headers);
  return (await proxy.probe(extractSes, id, capture.url)) ? { ...capture, id } : null;
}

// Unique NHL / NHL Preseason links in a scrape result.
function nhlLinks(data) {
  const nhl = (data?.streams || []).filter(r => NHL_LEAGUES.includes(r.league.toLowerCase()));
  return [...new Set(nhl.map(r => r.link))];
}

module.exports = { configure, setupExtractSession, setupAdblock, extractVerified, nhlLinks, NHL_LEAGUES };
