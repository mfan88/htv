// htvstream:// protocol: fetches a captured stream on the player's behalf and rewrites
// playlists so every segment, key and sub-playlist also goes through the proxy.
//
// Upstream requests go through the embed's own Chromium session (its cookies, TLS
// handling and network stack). A marker header tells that session's onBeforeSendHeaders
// hook (see decorate()) to add the Referer/Origin/User-Agent the embed used.
//
// URL shape: htvstream://s/<contextId>?u=<encoded upstream url>
// Server mode serves the same thing over HTTP (see server.js) through respond().

const { protocol } = require("electron");
const crypto = require("crypto");

const SCHEME = "htvstream";
const MARKER = "x-htv-ctx";
const contexts = new Map(); // contextId -> headers, least recently used first
// Every link check adds a context, so keep enough that a stream being watched is never
// evicted by a round of checks (it's also moved to the end on every request).
const MAX_CONTEXTS = 100;

function registerScheme() {
  // Must run before the app is ready.
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

function addContext(headers) {
  const id = crypto.randomBytes(8).toString("hex");
  contexts.set(id, headers);
  if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
  return id;
}

function proxify(id, url) {
  return `${SCHEME}://s/${id}?u=${encodeURIComponent(url)}`;
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

// Chromium's fetch leaves Response.url empty, so fall back to the requested URL.
const finalUrl = (res, target) => res.url || target;

// Upstream fetch through the embed's session, tagged so decorate() adds its headers.
function upstream(fetchSession, id, target, extra = {}) {
  return fetchSession.fetch(target, {
    headers: { [MARKER]: id, ...extra },
    cache: "no-store",
    bypassCustomProtocolHandlers: true,
    signal: AbortSignal.timeout(15000),
  });
}

// True if the captured playlist actually loads (a request being made doesn't mean it works).
async function probe(fetchSession, id, url) {
  try {
    const res = await upstream(fetchSession, id, url);
    return res.ok && (await res.text()).trimStart().startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

// For onBeforeSendHeaders on the fetching session: swap the marker for the real headers.
function decorate(requestHeaders) {
  const key = Object.keys(requestHeaders).find(k => k.toLowerCase() === MARKER);
  if (!key) return;
  const headers = contexts.get(requestHeaders[key]);
  delete requestHeaders[key];
  if (!headers) return;
  for (const [k, v] of Object.entries(headers)) {
    for (const existing of Object.keys(requestHeaders)) {
      if (existing.toLowerCase() === k.toLowerCase()) delete requestHeaders[existing];
    }
    requestHeaders[k] = v;
  }
}

// Offset of the first MPEG-TS packet in the first KB of `buf` (sync bytes 188 apart), or -1.
function tsStart(buf) {
  for (let i = 0; i < Math.min(1024, buf.length - 376); i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }
  return -1;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

// The response for one proxied request of stream context `id`. Playlists are rewritten
// so that every URL in them goes through `wrap`.
async function respond(fetchSession, id, target, range, wrap) {
  const headers = contexts.get(id);
  if (!headers || !target || !/^https?:\/\//i.test(target)) {
    return new Response("unknown stream", { status: 404, headers: CORS });
  }
  contexts.delete(id);
  contexts.set(id, headers);

  let res;
  try {
    res = await upstream(fetchSession, id, target, range ? { Range: range } : {});
  } catch (err) {
    return new Response(String(err), { status: 502, headers: CORS });
  }

  const contentType = res.headers.get("content-type") || "";
  if (res.ok && isPlaylist(target, contentType)) {
    const text = await res.text();
    if (text.trimStart().startsWith("#EXTM3U")) {
      return new Response(rewritePlaylist(text, finalUrl(res, target), wrap), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response(text, { status: res.status, headers: { ...CORS, "Content-Type": contentType } });
  }

  // Some mirrors wrap MPEG-TS segments in a fake image header (a WebP/PNG prefix) to dodge
  // blockers. Browsers' players cope; ffmpeg doesn't, so cut the prefix off.
  if (res.ok && !range && /^image\//i.test(contentType)) {
    const body = Buffer.from(await res.arrayBuffer());
    const at = tsStart(body);
    if (at >= 0) {
      return new Response(body.subarray(at), { status: 200, headers: { ...CORS, "Content-Type": "video/mp2t", "Content-Length": String(body.length - at) } });
    }
    return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": contentType } });
  }

  const outHeaders = { ...CORS };
  // fetch() transparently decompresses, so the upstream length only holds for identity bodies.
  const passthrough = ["content-type", "content-range", "accept-ranges"];
  if (!res.headers.get("content-encoding")) passthrough.push("content-length");
  for (const h of passthrough) {
    const v = res.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

function handle(request, fetchSession) {
  const reqUrl = new URL(request.url);
  const id = reqUrl.pathname.slice(1);
  return respond(fetchSession, id, reqUrl.searchParams.get("u"), request.headers.get("range"), u => proxify(id, u));
}

// Serve htvstream:// in `ses` (the player's session), fetching upstream via `fetchSession`.
function install(ses, fetchSession) {
  ses.protocol.handle(SCHEME, request => handle(request, fetchSession));
}

module.exports = { registerScheme, install, addContext, hasContext: id => contexts.has(id), proxify, respond, rewritePlaylist, decorate, probe };
