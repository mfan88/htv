// Fetches a captured stream on the player's behalf and rewrites playlists so every
// segment, key and sub-playlist also goes through the proxy (server.js's /s/ route).
//
// Upstream requests go through the extraction browser context's request API, which shares
// the embed's cookies, and replay the headers the embed's player sent (Referer, Origin...).

const crypto = require("crypto");

const contexts = new Map(); // contextId -> headers, least recently used first
// Every link check adds a context, so keep enough that a stream being watched is never
// evicted by a round of checks (it's also moved to the end on every request).
const MAX_CONTEXTS = 100;

function addContext(headers) {
  const id = crypto.randomBytes(8).toString("hex");
  contexts.set(id, headers);
  if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
  return id;
}

// `wrap(url, kind)` turns an absolute upstream URL into the URL the player should
// request. kind is what the URL is: "playlist", "segment" (MPEG-TS style), "fragment"
// (fMP4), "init" (an fMP4 init segment) or "key".
function rewritePlaylist(text, baseUrl, wrap) {
  const master = text.includes("#EXT-X-STREAM-INF");
  const segment = text.includes("#EXT-X-MAP") ? "fragment" : "segment";
  const abs = (u, kind) => {
    try { return wrap(new URL(u, baseUrl).href, kind); } catch { return u; }
  };
  const tagKind = t => (t.startsWith("#EXT-X-MAP") ? "init" : /^#EXT-X-(SESSION-)?KEY/.test(t) ? "key" : "playlist");
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u, tagKind(t))}"`);
    return abs(t, master ? "playlist" : segment);
  }).join("\n");
}

function isPlaylist(url, contentType) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType);
}

// Upstream fetch with the captured headers; `extra` (e.g. Range) wins over them.
function upstream(fetcher, id, target, extra = {}) {
  return fetcher.fetch(target, {
    headers: { ...contexts.get(id), ...extra },
    timeout: 15000,
    maxRedirects: 5,
    failOnStatusCode: false,
  });
}

// True if the captured playlist actually loads (a request being made doesn't mean it works).
async function probe(fetcher, id, url) {
  try {
    const res = await upstream(fetcher, id, url);
    return res.ok() && (await res.text()).trimStart().startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

// Offset of the first MPEG-TS packet in the first KB of `buf` (sync bytes 188 apart), or -1.
function tsStart(buf) {
  for (let i = 0; i < Math.min(1024, buf.length - 376); i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }
  return -1;
}

// The response for one proxied request of stream context `id`. Playlists are rewritten
// so that every URL in them goes through `wrap`.
async function respond(fetcher, id, target, range, wrap) {
  const headers = contexts.get(id);
  if (!headers || !target || !/^https?:\/\//i.test(target)) {
    return new Response("unknown stream", { status: 404, headers: CORS });
  }
  contexts.delete(id);
  contexts.set(id, headers);

  let res;
  try {
    res = await upstream(fetcher, id, target, range ? { Range: range } : {});
  } catch (err) {
    return new Response(String(err), { status: 502, headers: CORS });
  }

  const contentType = res.headers()["content-type"] || "";
  const body = await res.body().catch(() => Buffer.alloc(0));
  if (res.ok() && isPlaylist(target, contentType)) {
    const text = body.toString("utf8");
    if (text.trimStart().startsWith("#EXTM3U")) {
      return new Response(rewritePlaylist(text, res.url() || target, wrap), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response(text, { status: res.status(), headers: { ...CORS, "Content-Type": contentType } });
  }

  // Some mirrors wrap MPEG-TS segments in a fake image header (a WebP/PNG prefix) to dodge
  // blockers. Browsers' players cope; ffmpeg doesn't, so cut the prefix off.
  if (res.ok() && (!range || /^bytes=0-$/.test(range)) && /^image\//i.test(contentType)) {
    const at = tsStart(body);
    if (at >= 0) {
      const ts = body.subarray(at);
      return new Response(ts, { status: 200, headers: { ...CORS, "Content-Type": "video/mp2t", "Content-Length": String(ts.length) } });
    }
  }

  const outHeaders = { ...CORS, "Content-Length": String(body.length) };
  for (const h of ["content-type", "content-range", "accept-ranges"]) {
    const v = res.headers()[h];
    if (v) outHeaders[h] = v;
  }
  const empty = [204, 205, 304].includes(res.status());
  return new Response(empty ? null : body, { status: res.status(), headers: outHeaders });
}

module.exports = { addContext, hasContext: id => contexts.has(id), respond, rewritePlaylist, probe };
