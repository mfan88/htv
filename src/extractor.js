// Finds the HLS playlist behind an embed by loading it in hidden, muted windows and
// watching their network requests for an .m3u8.
//
// Two loads race each other: onhockey's own wrapper page (some hosts only play when
// framed by onhockey.tv) and the bare embed (some players only work top-level).

const { BrowserWindow } = require("electron");

const PARTITION = "persist:extract";
const PLAYLIST_RE = /\.m3u8(\?|$)|mpegurl/i;
const TIMEOUT_MS = 25000;
const CLICK_AT_MS = [5000, 10000, 15000]; // nudge players that wait for a click on "play"
// Headers the browser manages itself; everything else the player sent (Referer, Origin,
// custom auth/token headers...) is replayed on proxied requests. Cookies come from the session.
const SKIP_HEADERS = /^(host|connection|content-length|accept-encoding|cookie|range|sec-|upgrade-insecure-requests)/i;
const ONHOCKEY = "https://onhockey.tv/";

const watchers = new Map(); // webContentsId -> onCapture(capture)

function wrapperUrl(link) {
  return ONHOCKEY + "np_stream400.php?channel=//" + link;
}

// Called from the session's onBeforeSendHeaders listener for every request.
function observe(details) {
  const onCapture = watchers.get(details.webContentsId);
  // Ignore CORS preflights (OPTIONS): only the real GET carries the player's headers.
  if (!onCapture || details.method !== "GET" || !PLAYLIST_RE.test(details.url)) return;
  const headers = {};
  for (const [k, v] of Object.entries(details.requestHeaders)) {
    if (!SKIP_HEADERS.test(k)) headers[k] = v;
  }
  onCapture({ url: details.url, headers });
}

function openHidden(url, job) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { partition: PARTITION, sandbox: true, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  watchers.set(wc.id, capture => job.finish(capture));
  const id = wc.id;
  win.on("closed", () => watchers.delete(id));

  for (const ms of CLICK_AT_MS) {
    job.timers.push(setTimeout(async () => {
      if (job.done || win.isDestroyed()) return;
      // Click the middle of the first frame (the player in onhockey's wrapper), else the page.
      const rect = await wc.executeJavaScript(
        "(() => { const f = document.querySelector('iframe'); if (!f) return null;" +
        " const r = f.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"
      ).catch(() => null);
      if (job.done || win.isDestroyed()) return;
      const x = Math.round(rect?.x ?? 640), y = Math.round(rect?.y ?? 360);
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    }, ms));
  }

  // Ad scripts try to redirect the page; the player only needs the first load.
  wc.on("will-navigate", e => e.preventDefault());
  wc.loadURL(url, { httpReferrer: ONHOCKEY }).catch(() => {});
  return win;
}

// Returns { url, headers } for the stream's playlist, or null if none was found.
// `link` is the trimmed link (no scheme), e.g. "embed.st/embed/golf/1779/1".
// Several extractions can run at once; pass an AbortSignal to stop one early.
function extract(link, { signal } = {}) {
  return new Promise(resolve => {
    const job = {
      done: false,
      timers: [],
      windows: [],
      finish(capture) {
        if (job.done) return;
        job.done = true;
        job.timers.forEach(clearTimeout);
        for (const w of job.windows) if (!w.isDestroyed()) w.destroy();
        resolve(capture);
      },
    };
    if (signal?.aborted) return job.finish(null);
    signal?.addEventListener("abort", () => job.finish(null), { once: true });
    job.timers.push(setTimeout(() => job.finish(null), TIMEOUT_MS));
    job.windows.push(openHidden(wrapperUrl(link), job), openHidden("https://" + link, job));
  });
}

module.exports = { extract, observe, wrapperUrl, PARTITION };
