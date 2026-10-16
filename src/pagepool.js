// A few open Chromium pages that fetch playlists for stream hosts which answer only a real browser
// (the request API gets 403). Each page is a stub document served at the embed's own origin, so the
// fetch carries the right Origin/Referer and Chromium's own TLS, but no player, ads or video are loaded.
//
// Pages are keyed by stream context id (one per channel being watched, not per link), closed after
// `idleMs` without a request, and capped at `max`: the least recently used one is closed to make room.
// The extractor's reaper only knows pages opened by the extractor, so it never touches these.

const CHUNK_BYTES = 512 * 1024; // bytes copied to Node per round trip: a body never exists in full as a string
// Headers a page's fetch() may not set (the browser fills them in).
const FORBIDDEN = /^(host|connection|content-length|accept-encoding|cookie|user-agent|referer|origin|sec-|proxy-|upgrade-insecure-requests|te$|trailer|transfer-encoding|upgrade|via|keep-alive|date|expect|dnt)/i;

// Runs in the page. `start` begins a fetch and returns the first chunk; `more` returns the next ones.
// The body is read in pieces so only one chunk at a time is base64'd and sent over the protocol.
const PAGE_SIDE = `(() => {
  if (window.__htv) return;
  const reads = new Map();
  let n = 0;
  const b64 = u8 => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const pull = async (slot, chunk) => {
    const r = reads.get(slot);
    const parts = [];
    let size = 0, done = false;
    try {
      while (size < chunk && r.reader) {
        const { done: d, value } = await r.reader.read();
        if (d) { done = true; break; }
        parts.push(value);
        size += value.length;
      }
    } catch (err) {
      reads.delete(slot);
      clearTimeout(r.timer);
      throw err;
    }
    if (done || !r.reader) { done = true; reads.delete(slot); clearTimeout(r.timer); }
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    return { slot, done, b64: b64(all) };
  };
  window.__htv = {
    async start({ url, headers, referrer, timeoutMs, chunk }) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, { headers, referrer, signal: ac.signal, redirect: "follow" });
      } catch (err) { clearTimeout(timer); throw err; }
      const slot = ++n;
      reads.set(slot, { reader: res.body?.getReader(), timer });
      const first = await pull(slot, chunk);
      return { ...first, status: res.status, url: res.url, headers: Object.fromEntries(res.headers) };
    },
    more: (slot, chunk) => pull(slot, chunk),
    drop(slot) { const r = reads.get(slot); if (r) { clearTimeout(r.timer); r.reader?.cancel().catch(() => {}); reads.delete(slot); } },
  };
})()`;

// A response shaped like Playwright's APIResponse, as far as proxy.respond uses it.
function asResponse(meta, body) {
  return {
    ok: () => meta.status >= 200 && meta.status < 300,
    status: () => meta.status,
    url: () => meta.url,
    headers: () => meta.headers,
    body: async () => body,
    text: async () => body.toString("utf8"),
  };
}

// `openPage(origin)` -> a page whose document is at `origin`; the pool installs PAGE_SIDE in it.
function create({ openPage, max = 3, idleMs = 60000, log = () => {} }) {
  const entries = new Map(); // key -> { page, ready, lastUsed, inflight }

  function drop(key, why) {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    log(`page pool: closed ${key.slice(0, 8)} (${why}), ${entries.size}/${max} open`);
    e.ready.then(page => page.close().catch(() => {}), () => {});
  }

  function makeRoom() {
    while (entries.size >= max) {
      // Prefer a page nobody is using; otherwise the least recently used one.
      const all = [...entries];
      const idle = all.filter(([, e]) => !e.inflight);
      const [key] = (idle.length ? idle : all).reduce((a, b) => (b[1].lastUsed < a[1].lastUsed ? b : a));
      drop(key, "limit");
    }
  }

  function entryFor(key, origin) {
    let e = entries.get(key);
    if (e) return e;
    makeRoom();
    e = { lastUsed: Date.now(), inflight: 0 };
    e.ready = openPage(origin).then(async page => {
      await page.evaluate(PAGE_SIDE);
      page.once("close", () => { if (entries.get(key) === e) { entries.delete(key); log(`page pool: page of ${key.slice(0, 8)} went away`); } });
      return page;
    });
    e.ready.catch(() => { if (entries.get(key) === e) entries.delete(key); });
    entries.set(key, e);
    log(`page pool: opened for ${key.slice(0, 8)} (${origin}), ${entries.size}/${max} open`);
    return e;
  }

  // Fetch `url` as the page at `origin` would. Throws on a network error or when `timeoutMs` passes.
  async function fetchIn(key, origin, url, { headers = {}, timeoutMs = 15000 } = {}) {
    const e = entryFor(key, origin);
    e.inflight++;
    e.lastUsed = Date.now();
    const sent = {};
    for (const [k, v] of Object.entries(headers)) if (!FORBIDDEN.test(k)) sent[k] = v;
    const referrer = headers.referer && headers.referer.startsWith(origin + "/") ? headers.referer : undefined;
    let page, slot = null, guard;
    try {
      page = await e.ready;
      const run = async () => {
        const first = await page.evaluate(a => window.__htv.start(a), { url, headers: sent, referrer, timeoutMs, chunk: CHUNK_BYTES });
        slot = first.slot;
        const parts = [Buffer.from(first.b64, "base64")];
        let done = first.done;
        while (!done) {
          const next = await page.evaluate(([s, c]) => window.__htv.more(s, c), [slot, CHUNK_BYTES]);
          parts.push(Buffer.from(next.b64, "base64"));
          done = next.done;
        }
        slot = null;
        return asResponse(first, parts.length === 1 ? parts[0] : Buffer.concat(parts));
      };
      // The page enforces the timeout itself; this catches a page that no longer answers at all.
      const stuck = new Promise((_, rej) => (guard = setTimeout(() => rej(new Error("page did not answer")), timeoutMs + 3000)));
      return await Promise.race([run(), stuck]);
    } catch (err) {
      if (slot != null && page && !page.isClosed()) page.evaluate(s => window.__htv.drop(s), slot).catch(() => {});
      // A page that is gone or wedged is replaced on the next request.
      if (!page || page.isClosed() || err.message === "page did not answer") drop(key, "failed");
      throw err;
    } finally {
      clearTimeout(guard);
      e.inflight--;
      e.lastUsed = Date.now();
    }
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, e] of entries) if (!e.inflight && now - e.lastUsed > idleMs) drop(key, "idle");
  }, Math.min(10000, Math.max(1000, idleMs / 2)));
  sweep.unref();

  return {
    fetch: fetchIn,
    size: () => entries.size,
    keys: () => [...entries.keys()],
    closeAll: () => { for (const key of [...entries.keys()]) drop(key, "shutdown"); clearInterval(sweep); },
  };
}

module.exports = { create, FORBIDDEN, PAGE_SIDE };
