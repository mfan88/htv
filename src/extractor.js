// Finds the HLS playlist behind an embed by loading it in hidden pages and watching their
// network requests for an .m3u8.
//
// Two loads race each other: onhockey's own wrapper page (some hosts only play when
// framed by onhockey.tv) and the bare embed (some players only work top-level).

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

async function openHidden(context, blocker, url, job) {
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
    job.finish({ url: req.url(), headers });
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

// Returns { url, headers } for the stream's playlist, or null if none was found.
// `link` is the trimmed link (no scheme), e.g. "embed.st/embed/golf/1779/1".
// Several extractions can run at once; pass an AbortSignal to stop one early.
function extract(context, blocker, link, { signal } = {}) {
  return new Promise(resolve => {
    const job = {
      done: false,
      timers: [],
      pages: [],
      finish(capture) {
        if (job.done) return;
        job.done = true;
        job.timers.forEach(clearTimeout);
        for (const p of job.pages) p.close().catch(() => {});
        resolve(capture);
      },
    };
    if (signal?.aborted) return job.finish(null);
    signal?.addEventListener("abort", () => job.finish(null), { once: true });
    job.timers.push(setTimeout(() => job.finish(null), TIMEOUT_MS));
    for (const url of [wrapperUrl(link), "https://" + link]) {
      openHidden(context, blocker, url, job).catch(() => job.finish(null));
    }
  });
}

module.exports = { extract, wrapperUrl };
