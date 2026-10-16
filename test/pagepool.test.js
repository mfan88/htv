const test = require("node:test");
const assert = require("node:assert/strict");

const pagepool = require("../src/pagepool");
const proxy = require("../src/proxy");

// A fake Chromium page. Code sent to page.evaluate runs here in Node, against `fetchImpl`
// (the page's fetch), so the real page-side code in pagepool.js is what is tested.
function fakePage(fetchImpl) {
  const page = {
    closed: false,
    evaluated: [],
    isClosed: () => page.closed,
    close: async () => { page.closed = true; page.onClose?.(); },
    once: (ev, fn) => { if (ev === "close") page.onClose = fn; },
    async evaluate(fn, arg) {
      const saved = { window: globalThis.window, fetch: globalThis.fetch };
      globalThis.window = page.window ||= {};
      globalThis.fetch = fetchImpl;
      try {
        if (typeof fn === "string") return (0, eval)(fn);
        page.evaluated.push(arg);
        return await fn(arg);
      } finally { Object.assign(globalThis, saved); if (saved.window === undefined) delete globalThis.window; }
    },
  };
  return page;
}

function makePool(fetchImpl, opts = {}) {
  const pages = [];
  const pool = pagepool.create({
    max: 3, idleMs: 60000, ...opts,
    openPage: async origin => { const p = fakePage(fetchImpl); p.origin = origin; pages.push(p); return p; },
  });
  return { pool, pages };
}

const ok = body => async () => new Response(body, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });

test("a playlist is fetched in the page and comes back as a response", async () => {
  const { pool, pages } = makePool(ok("#EXTM3U\n#EXT-X-VERSION:3\n"));
  const r = await pool.fetch("c1", "https://embed.st", "https://lb1.strmd.st/p.m3u8", { headers: {} });
  assert.equal(r.status(), 200);
  assert.equal(r.ok(), true);
  assert.equal((await r.text()).startsWith("#EXTM3U"), true);
  assert.equal(r.headers()["content-type"], "application/vnd.apple.mpegurl");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].origin, "https://embed.st");
  pool.closeAll();
});

test("a large body is copied in chunks and reassembled byte for byte", async () => {
  const big = Buffer.alloc(3_000_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  // Delivered in 64 KB pieces, as a network response is.
  const stream = () => new ReadableStream({
    start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(new Uint8Array(big.subarray(i, i + 65536))); c.close(); },
  });
  const { pool, pages } = makePool(async () => new Response(stream(), { status: 200 }));
  const r = await pool.fetch("c1", "https://embed.st", "https://x/seg.ts", { headers: {} });
  assert.equal(Buffer.compare(await r.body(), big), 0);
  assert.ok(pages[0].evaluated.length > 3, "more than one round trip");
  pool.closeAll();
});

test("headers the browser owns are not sent; referer becomes the referrer option", async () => {
  let init;
  const { pool } = makePool(async (u, i) => { init = i; return new Response("#EXTM3U"); });
  await pool.fetch("c1", "https://embed.st", "https://x/p.m3u8", {
    headers: { origin: "https://embed.st", referer: "https://embed.st/", "user-agent": "x", "sec-fetch-mode": "cors", "x-auth": "t", accept: "*/*" },
  });
  assert.deepEqual(init.headers, { "x-auth": "t", accept: "*/*" });
  assert.equal(init.referrer, "https://embed.st/");
  pool.closeAll();
});

test("a slow upstream fails at the timeout", async () => {
  const slow = (u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const { pool } = makePool(slow);
  const t0 = Date.now();
  await assert.rejects(pool.fetch("c1", "https://embed.st", "https://x/p.m3u8", { timeoutMs: 80 }), /aborted/);
  assert.ok(Date.now() - t0 < 1000);
  pool.closeAll();
});

test("one page per context id, shared by concurrent requests", async () => {
  const { pool, pages } = makePool(ok("#EXTM3U"));
  await Promise.all([1, 2, 3].map(() => pool.fetch("c1", "https://embed.st", "https://x/p.m3u8")));
  await pool.fetch("c1", "https://embed.st", "https://x/p.m3u8");
  assert.equal(pages.length, 1);
  assert.equal(pool.size(), 1);
  pool.closeAll();
});

test("never more than max pages: the least recently used is closed first", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const { pool, pages } = makePool(ok("#EXTM3U"));
  for (const k of ["a", "b", "c"]) { await pool.fetch(k, "https://embed.st", "https://x/p.m3u8"); t.mock.timers.tick(1000); }
  await pool.fetch("a", "https://embed.st", "https://x/p.m3u8"); // a is now the most recent; b the oldest
  t.mock.timers.tick(1000);
  await pool.fetch("d", "https://embed.st", "https://x/p.m3u8");
  assert.equal(pool.size(), 3);
  assert.deepEqual(pool.keys().sort(), ["a", "c", "d"]);
  assert.equal(pages.filter(p => !p.closed).length, 3);
  assert.equal(pages[1].closed, true, "b was closed");
  pool.closeAll();
});

test("pages with no request for idleMs are closed", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { pool, pages } = makePool(ok("#EXTM3U"), { idleMs: 60000 });
  await pool.fetch("a", "https://embed.st", "https://x/p.m3u8");
  t.mock.timers.tick(50000);
  assert.equal(pool.size(), 1);
  t.mock.timers.tick(20000);
  assert.equal(pool.size(), 0);
  await new Promise(r => setImmediate(r));
  assert.equal(pages[0].closed, true);
  pool.closeAll();
});

test("a page that closed under us is replaced on the next request", async () => {
  const { pool, pages } = makePool(ok("#EXTM3U"));
  await pool.fetch("a", "https://embed.st", "https://x/p.m3u8");
  await pages[0].close();
  assert.equal(pool.size(), 0);
  await pool.fetch("a", "https://embed.st", "https://x/p.m3u8");
  assert.equal(pages.length, 2);
  pool.closeAll();
});

/* --- routing in proxy.js --- */

const wrap = u => "/s/" + encodeURIComponent(u);
const res = (status, body = "", headers = {}) => ({
  ok: () => status >= 200 && status < 300, status: () => status, url: () => "", headers: () => headers,
  body: async () => Buffer.from(body), text: async () => body,
});

function routing(hostIsBrowserOnly) {
  const calls = { plain: [], browser: [], marked: [] };
  const segs = new Set();
  proxy.useBrowser({
    isHost: () => hostIsBrowserOnly,
    segmentsViaBrowser: () => segs.size > 0,
    markSegments: url => { segs.add(url); calls.marked.push(url); },
    fetch: async (id, url) => { calls.browser.push(url); return res(200, url.endsWith(".m3u8") ? "#EXTM3U\n" : "seg"); },
  });
  return { calls, fetcher: { fetch: async url => { calls.plain.push(url); return res(url.endsWith(".m3u8") ? 403 : 200, "x"); } } };
}

test("browser-only host: playlists go through the page, segments through the request API", async () => {
  const { calls, fetcher } = routing(true);
  const id = proxy.addContext({});
  const p = await proxy.respond(fetcher, id, "https://lb1.strmd.st/a/p.m3u8", null, wrap);
  assert.equal(p.status, 200);
  assert.deepEqual(calls.browser, ["https://lb1.strmd.st/a/p.m3u8"]);
  assert.deepEqual(calls.plain, []);
  const s = await proxy.respond(fetcher, id, "https://lb1.strmd.st/a/1.ts", null, wrap);
  assert.equal(s.status, 200);
  assert.deepEqual(calls.plain, ["https://lb1.strmd.st/a/1.ts"]);
  assert.deepEqual(calls.marked, []);
});

test("a 403 on a segment moves that host's segments to the page", async () => {
  const calls = { plain: 0, browser: [], marked: [] };
  let viaPage = false;
  proxy.useBrowser({
    isHost: () => true, segmentsViaBrowser: () => viaPage,
    markSegments: u => { viaPage = true; calls.marked.push(u); },
    fetch: async (id, url) => { calls.browser.push(url); return res(200, "seg"); },
  });
  const fetcher = { fetch: async () => (calls.plain++, res(403)) };
  const id = proxy.addContext({});
  assert.equal((await proxy.respond(fetcher, id, "https://h/1.ts", null, wrap)).status, 200);
  assert.equal((await proxy.respond(fetcher, id, "https://h/2.ts", null, wrap)).status, 200);
  assert.equal(calls.plain, 1, "only the first segment tried the request API");
  assert.deepEqual(calls.browser, ["https://h/1.ts", "https://h/2.ts"]);
  assert.equal(calls.marked.length, 1);
});

test("hosts that work with the request API never touch the page route", async () => {
  const { calls, fetcher } = routing(false);
  fetcher.fetch = async url => { calls.plain.push(url); return res(200, url.endsWith(".m3u8") ? "#EXTM3U\n" : "seg"); };
  const id = proxy.addContext({});
  await proxy.respond(fetcher, id, "https://dlive.sx/p.m3u8", null, wrap);
  await proxy.respond(fetcher, id, "https://dlive.sx/1.ts", null, wrap);
  assert.deepEqual(calls.browser, []);
  assert.equal(calls.plain.length, 2);
});

test("a page fetch that throws is a 502 tagged as a fetch error (the mirror counts as dead)", async () => {
  proxy.useBrowser({ isHost: () => true, segmentsViaBrowser: () => false, markSegments() {}, fetch: async () => { throw new Error("aborted"); } });
  const id = proxy.addContext({});
  const r = await proxy.respond({}, id, "https://h/p.m3u8", null, wrap);
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("x-htv-fetch-error"), "1");
});

test("probeStatus with direct: true skips the page route", async () => {
  const { calls, fetcher } = routing(true);
  const id = proxy.addContext({});
  const r = await proxy.probeStatus(fetcher, id, "https://h/p.m3u8", { direct: true });
  assert.deepEqual([r.ok, r.status], [false, 403]);
  assert.deepEqual(calls.browser, []);
});
