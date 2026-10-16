// Headless Chromium (Playwright) for the server: runs the link checker's hidden pages,
// blocks ads, and gives the proxy a fetcher that shares the pages' cookies.

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { PlaywrightBlocker } = require("@ghostery/adblocker-playwright");

const extractor = require("./extractor");
const checker = require("./checker");
const proxy = require("./proxy");
const pagepool = require("./pagepool");

const NHL_LEAGUES = ["nhl", "nhl preseason"];

let dataDir = null;
let starting = null; // Promise<{ browser, context, blocker }>
let state = null;

// The link checks (several Chromium processes) share this container's CPU with the stream proxy.
// Start the browser at a lower priority (its children inherit it) so a round of checks can't starve
// the proxy and make a live stream buffer. HTV_CHROMIUM_NICE=0 turns this off.
function lowPriorityChromium() {
  const n = Math.min(19, Math.round(+(process.env.HTV_CHROMIUM_NICE ?? 15)));
  if (!(n > 0)) return undefined;
  try {
    // The image installs only the headless shell, so chromium.executablePath() (full Chromium) is not it.
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
    const dir = fs.readdirSync(root).find(d => d.startsWith("chromium_headless_shell-"));
    const real = dir && path.join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (!real || !fs.existsSync(real)) throw new Error("headless shell not found under " + root);
    const wrapper = path.join(require("os").tmpdir(), "htv-chromium.sh");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec nice -n ${n} "${real}" "$@"\n`, { mode: 0o755 });
    return wrapper;
  } catch (err) {
    console.error("could not lower the browser priority:", err.message);
    return undefined;
  }
}

async function launch() {
  const browser = await chromium.launch({
    executablePath: lowPriorityChromium(),
    args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage",
      // The software-GL GPU process burns CPU in a container with no GPU.
      ...(process.env.HTV_DISABLE_GPU === "1" ? ["--disable-gpu"] : [])],
  });
  // Some stream hosts refuse browsers that call themselves headless.
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const context = await browser.newContext({ userAgent, viewport: { width: 1280, height: 720 } });
  let blocker = null;
  try {
    const cache = path.join(dataDir, "adblock-pw.bin");
    blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
  } catch (err) {
    console.error("adblock unavailable:", err);
  }
  // A crashed browser is relaunched by the next extraction.
  browser.on("disconnected", () => {
    console.error("browser disconnected; will relaunch");
    starting = state = null;
  });
  return (state = { browser, context, blocker });
}

const ready = () => (starting ||= launch().catch(err => { starting = null; throw err; }));

// Pages that fetch playlists for browser-only stream hosts. Each is a stub document at the embed's origin (no
// player), so one costs little; HTV_BROWSER_PAGES caps them. Total Chromium pages are therefore at most
// 2 x HTV_CONCURRENCY (link checks) + the pages of tunes in progress (up to 6 each, as before) + HTV_BROWSER_PAGES.
const STUB_PATH = "/__htv_pool__";
const pool = pagepool.create({
  max: Math.max(1, +(process.env.HTV_BROWSER_PAGES || 3)),
  idleMs: Math.max(1, +(process.env.HTV_BROWSER_PAGE_IDLE_SEC || 60)) * 1000,
  log: m => console.log(m),
  async openPage(origin) {
    const { context } = await ready();
    const page = await context.newPage();
    try {
      await page.route(origin + STUB_PATH, r => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>htv</title>" }));
      await page.goto(origin + STUB_PATH, { waitUntil: "commit", timeout: 10000 });
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
    return page;
  },
});

// Segment hosts that also answer 401/403 to the request API (so their segments are fetched in the page too).
const segmentHosts = new Set();
const originOf = (headers, url) => {
  for (const v of [headers.origin, headers.referer]) { try { if (v) return new URL(v).origin; } catch {} }
  return new URL(url).origin;
};

async function start(dir) {
  dataDir = dir;
  extractor.loadBrowserOnly(dir);
  proxy.useBrowser({
    isHost: url => extractor.isBrowserOnly(url),
    segmentsViaBrowser: url => segmentHosts.has(extractor.streamHost(url)),
    markSegments(url) {
      const host = extractor.streamHost(url);
      if (!segmentHosts.has(host)) { segmentHosts.add(host); console.log(`${host}: segments need the browser too`); }
    },
    fetch: (id, url, headers, timeoutMs) => pool.fetch(id, originOf(headers, url), url, { headers, timeoutMs }),
  });
  if (process.env.HTV_LOG_PAGES === "1") {
    // Measuring aid: Chromium pages open right now (all of them, pool included).
    setInterval(() => ready().then(({ context }) => console.log(`chromium pages: ${context.pages().length} (pool ${pool.size()})`)).catch(() => {}), 5000).unref();
  }
  await ready();
  checker.init(extractVerified);
}

// Request context that shares cookies with the extraction pages (the proxy fetches with it).
async function fetcher() {
  return (await ready()).context.request;
}

// Extract a link's stream and confirm its playlist really loads through the proxy.
// `prior` (the link's last good capture, from a recheck) is tried first: if its playlist still
// loads, the link is alive and no page needs to be opened.
async function extractVerified(link, { prior, ...opts } = {}) {
  const { context, blocker } = await ready();
  // A browser-only host's playlist can't be probed with the request API; it is re-extracted instead.
  if (prior && proxy.hasContext(prior.id) && !extractor.isBrowserOnly(prior.url) && await proxy.probe(context.request, prior.id, prior.url)) return prior;
  const capture = await extractor.extract(context, blocker, link, opts);
  if (!capture) return null;
  const id = proxy.addContext(capture.headers);
  return (await extractor.verify(capture, url => proxy.probeStatus(context.request, id, url, { direct: true }))) ? { ...capture, id } : null;
}

// Unique NHL / NHL Preseason links in a scrape result.
function nhlLinks(data) {
  const nhl = (data?.streams || []).filter(r => NHL_LEAGUES.includes(r.league.toLowerCase()));
  return [...new Set(nhl.map(r => r.link))];
}

const isBrowserOnly = url => extractor.isBrowserOnly(url);

module.exports = { start, fetcher, extractVerified, nhlLinks, NHL_LEAGUES, pool, isBrowserOnly };
