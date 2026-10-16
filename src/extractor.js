// Finds the HLS playlist behind an embed by loading it in hidden pages and watching their
// network requests for an .m3u8.
//
// Two loads race each other: onhockey's own wrapper page (some hosts only play when
// framed by onhockey.tv) and the bare embed (some players only work top-level).

const fs = require("fs");
const path = require("path");

const PLAYLIST_RE = /\.m3u8(\?|$)|mpegurl/i;
const TIMEOUT_MS = 25000;
const CLICK_AT_MS = [5000, 10000, 15000]; // nudge players that wait for a click on "play"
// Headers the browser manages itself; everything else the player sent (Referer, Origin,
// custom auth/token headers...) is replayed on proxied requests. Cookies come from the context.
const SKIP_HEADERS = /^(host|connection|content-length|accept-encoding|cookie|range|sec-|upgrade-insecure-requests)/i;
const ONHOCKEY = "https://onhockey.tv/";
// Checks only need the playlist request, so skip decoding images, fonts and video. A playlist
// loaded as "media" is left alone: its request headers are only known once it reaches the network.
const BLOCK_HEAVY = process.env.HTV_BLOCK_HEAVY === "1";
const HEAVY_TYPES = new Set(["image", "font", "media"]);

function wrapperUrl(link) {
  return ONHOCKEY + "np_stream400.php?channel=//" + link;
}

// Every page opened here, with its open time. A page whose job finished while newPage() was still
// pending used to be left running forever (playing video, pinning a core); the reaper below is the
// backstop for anything that still slips through.
const open = new Map();
const MAX_PAGE_MS = TIMEOUT_MS + 15000;
setInterval(() => {
  const now = Date.now();
  for (const [page, at] of open) if (now - at > MAX_PAGE_MS) { open.delete(page); page.close().catch(() => {}); }
}, 30000).unref();

// Which of the two loads wins, per host. Most hosts only ever play in one of them, so once a host has
// shown it (WIN_MIN wins for one side, none for the other) only that load is opened, which halves the
// pages per check. Every RELEARN_EVERY-th extraction of a host races both again in case that changed.
const WIN_MIN = 4;
const RELEARN_EVERY = 8;
const wins = new Map(); // host -> { wrapper, bare, n }
const hostOf = link => link.split("/")[0];

function loadsFor(link) {
  const w = wins.get(hostOf(link));
  if (w) w.n++;
  if (w && w.n % RELEARN_EVERY && w.wrapper >= WIN_MIN && !w.bare) return ["wrapper"];
  if (w && w.n % RELEARN_EVERY && w.bare >= WIN_MIN && !w.wrapper) return ["bare"];
  return ["wrapper", "bare"];
}

function recordWin(link, via) {
  const host = hostOf(link);
  const w = wins.get(host) || { wrapper: 0, bare: 0, n: 0 };
  wins.set(host, w);
  w[via]++;
  if (w[via] === WIN_MIN && !w[via === "wrapper" ? "bare" : "wrapper"]) console.log(`${host}: only the ${via} load wins, opening just that`);
}

// Stream hosts (the host of the playlist URL, not the embed's) that answer the page but refuse the
// request API with 401/403 (they seem to fingerprint the client). Their links count as working when
// the page itself got a playlist, and the failing probe is skipped. Every RELEARN_EVERY-th extraction
// of such a host probes again in case that changed. Persisted under HTV_DATA so a restart doesn't relearn.
const browserOnly = new Map(); // stream host -> { n, since }
let browserOnlyFile = null;
// Load-balancer names rotate per load (lb13.strmd.st, lb27.strmd.st...), and each behaves alike, so they share one entry.
const streamHost = url => { try { return new URL(url).host.replace(/^lb\d+\./i, "lb*."); } catch { return ""; } };

function loadBrowserOnly(dataDir) {
  browserOnlyFile = path.join(dataDir, "browser-hosts.json");
  try {
    for (const [host, v] of Object.entries(JSON.parse(fs.readFileSync(browserOnlyFile, "utf8")))) browserOnly.set(streamHost("https://" + host), { n: 0, since: v?.since });
  } catch {}
}

function saveBrowserOnly() {
  if (!browserOnlyFile) return;
  const out = Object.fromEntries([...browserOnly].map(([h, v]) => [h, { since: v.since }]));
  try { fs.writeFileSync(browserOnlyFile, JSON.stringify(out, null, 1)); } catch (err) { console.error("could not save browser-only hosts:", err.message); }
}

// Does the capture's playlist really load? `probe(url)` -> { ok, status } fetches it with the request API.
// The page's own answer (capture.page, seen by the extractor) decides for browser-only hosts.
async function verify(capture, probe) {
  const host = streamHost(capture.url);
  const seen = !!capture.page?.playlist;
  const flagged = browserOnly.get(host);
  if (flagged) {
    if (++flagged.n % RELEARN_EVERY) return seen;
    const r = await probe(capture.url);
    if (r.ok) {
      browserOnly.delete(host);
      saveBrowserOnly();
      console.log(`${host}: the request API works again, no longer browser-only`);
      return true;
    }
    return seen;
  }
  const r = await probe(capture.url);
  if (r.ok) return true;
  if ((r.status === 401 || r.status === 403) && seen) {
    if (!browserOnly.has(host)) { // a concurrent check may have flagged it while this one probed
      browserOnly.set(host, { n: 0, since: new Date().toISOString() });
      saveBrowserOnly();
      console.log(`${host}: the page loads the playlist but the request API gets ${r.status}, only the browser can fetch it`);
    }
    return true;
  }
  return false;
}

const isBrowserOnly = url => browserOnly.has(streamHost(url));

// What the page itself got for its playlist request: { status, playlist }, or null if it never
// answered in time (the check then falls back to the request API alone).
async function ownResponse(req) {
  const read = async () => {
    const res = await req.response();
    if (!res) return null;
    const text = await res.text().catch(() => "");
    return { status: res.status(), playlist: text.trimStart().startsWith("#EXTM3U") };
  };
  let timer;
  const late = new Promise(r => (timer = setTimeout(r, 4000, null)));
  return Promise.race([read().catch(() => null), late]).finally(() => clearTimeout(timer));
}

async function openHidden(context, blocker, url, job, via) {
  const page = await context.newPage();
  open.set(page, Date.now());
  page.once("close", () => open.delete(page));
  if (job.done) return page.close().catch(() => {});
  job.pages.push(page);
  if (blocker) await blocker.enableBlockingInPage(page).catch(() => {});

  // No popups from anything (ads, pop-unders, "click to play" traps).
  page.on("popup", p => p.close().catch(() => {}));
  // Ad scripts try to redirect the page; the player only needs the first load. Registered
  // after the blocker so it runs first, and passes everything else on to it.
  let navigations = 0;
  await page.route("**/*", route => {
    const req = route.request();
    if (BLOCK_HEAVY && HEAVY_TYPES.has(req.resourceType()) && !PLAYLIST_RE.test(req.url())) return route.abort().catch(() => {});
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && ++navigations > 1) return route.abort().catch(() => {});
    return route.fallback().catch(() => {});
  });

  page.on("request", async req => {
    // Only the GET carries the player's headers (not a CORS preflight).
    if (job.done || req.method() !== "GET" || !PLAYLIST_RE.test(req.url())) return;
    const all = await req.allHeaders().catch(() => null);
    if (!all) return;
    const headers = {};
    for (const [k, v] of Object.entries(all)) if (!SKIP_HEADERS.test(k)) headers[k] = v;
    const seen = await ownResponse(req);
    job.finish({ url: req.url(), headers, page: seen }, via);
  });

  for (const ms of CLICK_AT_MS) {
    job.timers.push(setTimeout(async () => {
      if (job.done || page.isClosed()) return;
      // Click the middle of the first frame (the player in onhockey's wrapper), else the page.
      const rect = await page.evaluate(() => {
        const f = document.querySelector("iframe");
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }).catch(() => null);
      if (job.done || page.isClosed()) return;
      await page.mouse.click(Math.round(rect?.x ?? 640), Math.round(rect?.y ?? 360)).catch(() => {});
    }, ms));
  }

  page.goto(url, { referer: ONHOCKEY, waitUntil: "commit", timeout: TIMEOUT_MS }).catch(() => {});
}

// Returns { url, headers, page } (page: what the page itself got, see ownResponse) for the stream's playlist, or null if none was found.
// `link` is the trimmed link (no scheme), e.g. "embed.st/embed/golf/1779/1".
// Several extractions can run at once; pass an AbortSignal to stop one early.
function extract(context, blocker, link, { signal } = {}) {
  return new Promise(resolve => {
    const job = {
      done: false,
      timers: [],
      pages: [],
      finish(capture, via) {
        if (job.done) return;
        if (capture && via) recordWin(link, via);
        job.done = true;
        job.timers.forEach(clearTimeout);
        for (const p of job.pages) p.close().catch(() => {});
        resolve(capture);
      },
    };
    if (signal?.aborted) return job.finish(null);
    signal?.addEventListener("abort", () => job.finish(null), { once: true });
    job.timers.push(setTimeout(() => job.finish(null), TIMEOUT_MS));
    const urls = { wrapper: wrapperUrl(link), bare: "https://" + link };
    for (const via of loadsFor(link)) {
      openHidden(context, blocker, urls[via], job, via).catch(() => job.finish(null));
    }
  });
}

module.exports = { extract, wrapperUrl, verify, isBrowserOnly, streamHost, loadBrowserOnly, browserOnly };
